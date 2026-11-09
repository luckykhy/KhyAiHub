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

// ── 附件格式细分（只服务显示，不参与处理链路）────────────────────────────────
// 后端 aiUploadStore.classifyKind 给的 kind 是**处理链路**口径（image / document /
// audio …，决定走 OCR、音轨转写还是正文提取），值域不能为了图标去改。但在这个
// 口径下 pdf 与 docx 同为 document、md 与 txt 同为 text，chip 上分不出来。
// 所以这里再切一层纯显示的 format：扩展名优先，扩展名认不出才回落到 kind。
//
// 扩展名表与桌面端 apps/khyos-desktop/.../attachmentKind.ts 同一份（2026-11-01）——
// 两端各存一份是构建边界所限（两个独立 app），靠各自的单测钉住同一批代表扩展名。
export const FILE_FORMATS = [
  'image', 'pdf', 'doc', 'sheet', 'slide', 'video',
  'audio', 'archive', 'code', 'md', 'text', 'file',
];

const EXT_FORMATS = [
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'heic']],
  ['pdf', ['pdf']],
  ['doc', ['doc', 'docx', 'rtf', 'odt', 'wps', 'pages']],
  ['sheet', ['xls', 'xlsx', 'csv', 'tsv', 'ods', 'et', 'numbers']],
  ['slide', ['ppt', 'pptx', 'odp', 'dps', 'key']],
  ['video', ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'm4v', 'wmv', 'mpg', 'mpeg']],
  ['audio', ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma']],
  ['archive', ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz']],
  ['md', ['md', 'markdown', 'mdx', 'mdown']],
  ['text', ['txt', 'log', 'rst']],
  ['code', [
    'js', 'jsx', 'ts', 'tsx', 'vue', 'py', 'json', 'yaml', 'yml', 'toml', 'ini',
    'css', 'scss', 'html', 'sh', 'ps1', 'bat', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sql',
  ]],
];

const FORMAT_BY_EXT = {};
for (const [format, exts] of EXT_FORMATS) for (const ext of exts) FORMAT_BY_EXT[ext] = format;

// 扩展名认不出时按后端 kind 兜底。document 落 doc（Word 字形）而不是 file：
// 后端把 pdf/docx/xlsx/pptx 都归进 document，其中 Word 占比最高，比通用文件形有用。
const FORMAT_BY_KIND = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  archive: 'archive',
  code: 'code',
  text: 'text',
  document: 'doc',
  other: 'file',
};

export function attachmentFormat(att) {
  const name = String((att && att.name) || '');
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const byExt = ext ? FORMAT_BY_EXT[ext] : undefined;
  if (byExt) return byExt;
  return FORMAT_BY_KIND[String((att && att.kind) || '')] || 'file';
}
