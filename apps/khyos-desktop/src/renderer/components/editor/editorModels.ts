// Monaco 模型注册表所需的纯函数：路径规范化、模型 URI、行尾还原。
// 三个决定：
//   ① 一个文件 = 一个模型，键是 file:// URI；切标签只切 active path，
//      undo 栈因此跨标签保留（不 dispose、不重建）；
//   ② Windows 盘符统一大写，避免 d:/x 与 D:/x 变成两个模型；
//   ③ 模型内部一律 \n，保存时按读取时探测到的 eol/bom 还原 —— 否则一次
//      保存会把整个 CRLF 文件改写（每一行都进 diff）。

const DRIVE_PREFIX = /^[a-zA-Z]:[\\/]/

export function normalizeFilePath(filePath: string): string {
  const unified = filePath.replace(/\\/g, '/')
  if (DRIVE_PREFIX.test(unified)) {
    return unified.charAt(0).toUpperCase() + unified.slice(1)
  }
  return unified
}

export function toModelUri(filePath: string): string {
  const normalized = normalizeFilePath(filePath)
  const absolute = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(absolute)}`
}

export function baseName(filePath: string): string {
  const parts = normalizeFilePath(filePath).split('/')
  return parts[parts.length - 1] || filePath
}

/** 相对 root 的展示路径（搜索命中分组用）；不在 root 下则原样返回文件名 */
export function relativeToRoot(filePath: string, root: string): string {
  const file = normalizeFilePath(filePath)
  const base = normalizeFilePath(root).replace(/\/+$/, '')
  if (!base) return file
  if (file === base) return baseName(file)
  if (file.startsWith(`${base}/`)) return file.slice(base.length + 1)
  return file
}

export function toDiskText(modelText: string, eol: 'lf' | 'crlf', bom: boolean): string {
  const body = eol === 'crlf' ? modelText.replace(/\r?\n/g, '\r\n') : modelText.replace(/\r\n/g, '\n')
  if (!bom || body.startsWith('\uFEFF')) return body
  return `\uFEFF${body}`
}

/** 与 Monaco 的行号口径一致：换行符分隔，末尾换行后的空行也算一行 */
