// 粘贴图片在进主进程之前先缩放 + 重编码。
//
// 剪贴板里的截图常是整屏 4K（3840×2160 PNG 十几 MB）。原样 base64 有三个代价：
//   - IPC 载荷按 4/3 膨胀，主进程写盘和渲染层内存都跟着涨；
//   - 视觉模型的长边输入上限普遍在 1568 左右，超出的部分会被各家静默缩略；
//   - 附件预览读的是同一份文件，大图解码也慢。
// 所以统一把长边压到 1568 再编码成 JPEG；原图已经够小就原样返回，不做无收益的
// 二次有损。GIF 不重编码——canvas 只会留下第一帧，等于把动图毁了。

const PASTE_IMAGE_MAX_EDGE = 1568
const PASTE_IMAGE_MAX_BYTES = 3.5 * 1024 * 1024
const PASTE_IMAGE_QUALITY = 0.9

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/heic': 'heic',
}

export interface PreparedPaste {
  /** 去掉 dataURL 前缀的 base64 —— 主进程按它落盘，后续交给视觉模型也是同一份 */
  base64: string
  /** 带正确扩展名的文件名（主进程据此能按扩展名取 MIME，预览才不会判成“不是图片”） */
  fileName: string
  mime: string
  size: number
  width?: number
  height?: number
  /** 是否真的压过；toast 用它说明“这张图被缩到了多少” */
  scaled: boolean
}

// File → base64（去掉 dataURL 前缀）。IPC 传字符串载荷最省事：二进制直接传会被
// 结构化克隆再拷一份。
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const raw = String(reader.result || '')
      const comma = raw.indexOf(',')
      resolve(comma >= 0 ? raw.slice(comma + 1) : raw)
    }
    reader.onerror = () => reject(reader.error || new Error('读取粘贴内容失败'))
    reader.readAsDataURL(blob)
  })
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('画布编码 JPEG 失败'))),
      'image/jpeg',
      PASTE_IMAGE_QUALITY,
    )
  })
}

// 剪贴板图片的 file.name 往往是 image.png；重编码成 JPEG 后扩展名要跟着改，
// 否则主进程落盘的是 image.png 里装着 JPEG 字节，预览按 PNG 解会失败。
function fileNameWithExt(name: string, mime: string): string {
  const ext = EXT_BY_MIME[mime]
  const base = (name || 'pasted').trim() || 'pasted'
  if (!ext) return base
  const lower = base.toLowerCase()
  if (ext === 'jpg' ? /\.jpe?g$/.test(lower) : lower.endsWith(`.${ext}`)) return base
  return `${base.replace(/\.[a-z0-9]{1,5}$/i, '') || 'pasted'}.${ext}`
}

export async function preparePastedImage(file: File): Promise<PreparedPaste> {
  const sourceMime = file.type || ''
  const passthrough = async (mime: string, width?: number, height?: number): Promise<PreparedPaste> => ({
    base64: await blobToBase64(file),
    fileName: fileNameWithExt(file.name, mime),
    mime: mime || 'application/octet-stream',
    size: file.size,
    width,
    height,
    scaled: false,
  })

  if (!sourceMime.startsWith('image/') || sourceMime === 'image/gif') {
    return passthrough(sourceMime)
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    // 解不开（损坏的图 / 少见格式）就原样落盘：宁可大一点，也不要吞掉用户的图。
    return passthrough(sourceMime)
  }

  try {
    const longest = Math.max(bitmap.width, bitmap.height)
    if (longest <= PASTE_IMAGE_MAX_EDGE && file.size <= PASTE_IMAGE_MAX_BYTES) {
      return await passthrough(sourceMime, bitmap.width, bitmap.height)
    }

    const scale = Math.min(1, PASTE_IMAGE_MAX_EDGE / longest)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return await passthrough(sourceMime, bitmap.width, bitmap.height)

    // JPEG 没有 alpha 通道，不铺白底的话透明区域会变黑。
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, width, height)

    const blob = await canvasToJpeg(canvas)
    return {
      base64: await blobToBase64(blob),
      fileName: fileNameWithExt(file.name, 'image/jpeg'),
      mime: 'image/jpeg',
      size: blob.size,
      width,
      height,
      scaled: true,
    }
  } finally {
    bitmap.close()
  }
}
