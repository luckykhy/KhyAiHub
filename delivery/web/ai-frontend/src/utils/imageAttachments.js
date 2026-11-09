// 粘贴图片的「缩放 + base64 化」前置：浏览器端在上传前把长边压到视觉模型
// 惯例（1568 px），避免把 4000~6000 px 的截图原样塞进 /api/ai/upload。
// 零第三方依赖：createImageBitmap + canvas。零 DOM 的纯决策函数单独导出，便于单测。
//
// 与桌面端 apps/khyos-desktop/src/renderer/components/composer/imagePaste.ts
// 保持同一口径：1568 长边、3.5MB 透传阈值、GIF 不重编码、JPEG q=0.9。

export const DEFAULT_MAX_EDGE = 1568;
export const DEFAULT_PASSTHROUGH_BYTES = 3.5 * 1024 * 1024;

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// GIF 一旦重编码就只剩一帧，故整类透传；其余浏览器可解码的位图才参与缩放。
export function isResizableImageType(type) {
  const t = String(type || '').toLowerCase();
  if (!t) return false;
  if (t === 'image/gif') return false;
  return /^image\/(png|jpe?g|webp|bmp)$/.test(t);
}

/**
 * 纯决策：这张图要不要缩、缩到多大。null = 原样上传。
 * @param {number} width
 * @param {number} height
 * @param {number} sizeBytes
 * @param {{maxEdge?:number,passthroughBytes?:number}} [opts]
 * @returns {{width:number,height:number,scale:number,reason:'edge'|'bytes'}|null}
 */
export function planImageResize(width, height, sizeBytes, opts = {}) {
  const w = asNumber(width);
  const h = asNumber(height);
  if (w <= 0 || h <= 0) return null;

  const maxEdge = asNumber(opts.maxEdge) > 0 ? asNumber(opts.maxEdge) : DEFAULT_MAX_EDGE;
  const passthroughBytes =
    asNumber(opts.passthroughBytes) > 0
      ? asNumber(opts.passthroughBytes)
      : DEFAULT_PASSTHROUGH_BYTES;
  const size = asNumber(sizeBytes);

  const longEdge = Math.max(w, h);
  const overEdge = longEdge > maxEdge;
  const overBytes = size > passthroughBytes;
  if (!overEdge && !overBytes) return null;

  const scale = overEdge ? maxEdge / longEdge : 1;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale,
    reason: overEdge ? 'edge' : 'bytes',
  };
}

export function imageFileNameForJpeg(name) {
  const base = String(name || '').replace(/\.[a-z0-9]{1,8}$/i, '');
  return `${base || 'pasted-image'}.jpg`;
}

function closeBitmap(bitmap) {
  try {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  } catch {
    /* noop */
  }
}

async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    return await createImageBitmap(file);
  }
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* noop */
      }
      resolve(img);
    };
    img.onerror = (err) => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* noop */
      }
      reject(err);
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

/**
 * 上传前缩放：需要时把图片重编码为 JPEG 并返回新的 File；任何失败（无 DOM、
 * 解码失败、canvas 不可用）都原样返回输入 File —— 缩放是优化，不是门槛。
 * @param {File} file
 * @param {{maxEdge?:number,passthroughBytes?:number,mimeType?:string,quality?:number}} [opts]
 * @returns {Promise<File>}
 */
export async function resizeImageForUpload(file, opts = {}) {
  try {
    if (!file || !isResizableImageType(file.type)) return file;
    if (typeof document === 'undefined') return file;

    const bitmap = await loadBitmap(file);
    if (!bitmap) return file;

    const width = bitmap.width || bitmap.naturalWidth || 0;
    const height = bitmap.height || bitmap.naturalHeight || 0;
    const plan = planImageResize(width, height, file.size, opts);
    if (!plan) {
      closeBitmap(bitmap);
      return file;
    }

    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      closeBitmap(bitmap);
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, plan.width, plan.height);
    closeBitmap(bitmap);

    const mimeType = opts.mimeType || 'image/jpeg';
    const quality = opts.quality == null ? 0.9 : opts.quality;
    const blob = await canvasToBlob(canvas, mimeType, quality);
    if (!blob) return file;

    // 仅因体积超阈值而重编码时，结果反而更大就没意义 —— 保留原图。
    if (plan.scale >= 1 && blob.size >= file.size) return file;

    if (typeof File !== 'function') return file;
    const outType = blob.type || mimeType;
    const outName = outType === 'image/jpeg' ? imageFileNameForJpeg(file.name) : file.name;
    return new File([blob], outName, {
      type: outType,
      lastModified: file.lastModified || Date.now(),
    });
  } catch {
    return file;
  }
}
