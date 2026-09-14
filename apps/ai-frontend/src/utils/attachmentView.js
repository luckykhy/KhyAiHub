// D9 纯叶（[DESIGN-ARCH-163]）：附件显示面决策。零网络、零 DOM、可单测。
// 组件与视图只从这里取判定，不再各自抄一份「什么叫图片附件 / 徽标文案」。

// 门控键（localStorage 而非 env：Vite 构建期 env 做不到用户运行时可关，
// 与 D8.1 'khy.webPasteAttachment' 同一口径）。默认开，'0' → 现状纯图标 chip。
export const THUMBS_KEY = 'khy.attachmentThumbs';

export function readThumbsFlag(storage) {
  try {
    return !(storage && storage.getItem(THUMBS_KEY) === '0');
  } catch {
    return true; // 读取失败按默认开（fail-soft，不惩罚正常用户）
  }
}

export function isImageAttachment(att) {
  return !!att && att.kind === 'image';
}

// 上传管线（aiUploadStore.toDescriptor）已回传 extracted/transcript 信号，
// 前端此前从未消费。徽标 = 用户已知事实的补全，不是模型视图。
export function attachmentBadge(att) {
  const parts = [];
  if (att && att.transcript) parts.push('已转写');
  if (att && att.extracted) parts.push('已提取正文');
  return parts.join(' · ');
}

export function downloadFileName(att) {
  const name = String((att && att.name) || '').trim();
  if (name && !/^blob$/i.test(name)) return name;
  return `attachment-${(att && att.id) || 'file'}`;
}
