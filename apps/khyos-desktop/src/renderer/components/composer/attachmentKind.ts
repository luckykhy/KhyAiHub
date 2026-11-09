// 附件格式判定 —— 纯叶（零 React / 零 DOM / 零网络），Composer 与单测共用。
//
// 单独成文件的原因：输入区 chip、@ 上下文列表、文件选择对话框的筛选器三处都要
// 回答「这份文件属于哪一桶」，判定写在组件里就必然抄成三份，加一种格式时漏改
// 其中一份（历史上 mp4 能粘贴却选不中，就是这么来的）。
//
// 分桶口径是**扩展名优先**：用户在 chip 上要一眼认出 pdf 还是 docx、mp4 还是 mp3，
// 按 MIME 大类粗分（image / text / file）给不出这个区分。MIME 只在没有扩展名时
// 兜底 —— 剪贴板内容常常只有 MIME。

export type AttachmentKind =
  | 'image'
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slide'
  | 'video'
  | 'audio'
  | 'archive'
  | 'code'
  | 'md'
  | 'text'
  | 'file'

/** 文件类型字形名（Icon 注册表 file-* 子集，见 components/ui/Icon.tsx）。 */
export type FileIconName =
  | 'image'
  | 'file-pdf'
  | 'file-word'
  | 'file-sheet'
  | 'file-slide'
  | 'file-video'
  | 'file-audio'
  | 'file-archive'
  | 'file-text'
  | 'file-markdown'
  | 'code'
  | 'file'

// 同一桶的打开方式/处理链路相同，图标也就同形。顺序即筛选器的展示顺序。
export const EXT_KINDS: [AttachmentKind, string[]][] = [
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'heic']],
  ['pdf', ['pdf']],
  ['doc', ['doc', 'docx', 'rtf', 'odt', 'wps', 'pages']],
  ['sheet', ['xls', 'xlsx', 'csv', 'tsv', 'ods', 'et', 'numbers']],
  ['slide', ['ppt', 'pptx', 'odp', 'dps', 'key']],
  ['video', ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'm4v', 'wmv', 'mpg', 'mpeg']],
  ['audio', ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma']],
  ['archive', ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz']],
  // md 与 txt 分开：两者都是纯文本，但 md 有结构（标题/代码块/表格），
  // 交给模型的读法不一样，用户在输入区也分得出来才敢挑（2026-11-01 人提）。
  ['md', ['md', 'markdown', 'mdx', 'mdown']],
  ['text', ['txt', 'log', 'rst']],
  ['code', [
    'js', 'jsx', 'ts', 'tsx', 'vue', 'py', 'json', 'yaml', 'yml', 'toml', 'ini',
    'css', 'scss', 'html', 'sh', 'ps1', 'bat', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sql',
  ]],
]

const KIND_BY_EXT: Record<string, AttachmentKind> = {}
for (const [kind, exts] of EXT_KINDS) for (const ext of exts) KIND_BY_EXT[ext] = kind

const KIND_EXTS = new Map<AttachmentKind, string[]>(EXT_KINDS)

/** 这些桶覆盖哪些扩展名 —— 文件选择对话框的筛选器从这里取，不再另抄一份。 */
export function extensionsOf(...kinds: AttachmentKind[]): string[] {
  return kinds.flatMap((kind) => KIND_EXTS.get(kind) ?? [])
}

export function attachmentKind(name: string, mime = ''): AttachmentKind {
  const raw = String(name || '')
  const dot = raw.lastIndexOf('.')
  // 没有点，或点在首个字符（.gitignore 这类隐藏文件没有扩展名）→ 交给 MIME。
  const ext = dot > 0 ? raw.slice(dot + 1).toLowerCase() : ''
  const byExt = ext ? KIND_BY_EXT[ext] : undefined
  if (byExt) return byExt
  const type = String(mime || '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type === 'application/pdf') return 'pdf'
  if (type.startsWith('text/')) return 'text'
  return 'file'
}

export const ATTACHMENT_ICON: Record<AttachmentKind, FileIconName> = {
  image: 'image',
  pdf: 'file-pdf',
  doc: 'file-word',
  sheet: 'file-sheet',
  slide: 'file-slide',
  video: 'file-video',
  audio: 'file-audio',
  archive: 'file-archive',
  code: 'code',
  md: 'file-markdown',
  text: 'file-text',
  file: 'file',
}

// 只给「认格式」有惯用色的几个桶上色（PDF 红 / 表格绿 / 演示橙 / 图片与
// Markdown 品牌色），其余一律 foreground-muted —— 十来种颜色铺在输入区上会
// 盖过正文。取值全走 globals.css 的语义令牌，浅色主题自动跟着翻。
const ATTACHMENT_TINT: Partial<Record<AttachmentKind, string>> = {
  image: 'text-brand',
  pdf: 'text-destructive',
  sheet: 'text-success',
  slide: 'text-warning',
  md: 'text-brand',
}

export function attachmentTint(kind: AttachmentKind): string {
  return ATTACHMENT_TINT[kind] ?? 'text-foreground-muted'
}
