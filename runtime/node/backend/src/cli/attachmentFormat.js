'use strict';

/**
 * attachmentFormat — 附件格式判定的**终端侧**真源（纯叶子：零 IO、确定性、绝不抛）。
 *
 * 为什么要有它：终端两个渲染面都要回答「这份文件属于哪一桶」——
 *   - Ink TUI 输入框的待发 chip 行（ChatColumn）与提交后的回显（Transcript / transcriptLines）
 *   - classic REPL 的逐文件行（replSession）
 * 而在它出现之前，这两个面连「桶」这个概念都没有：TUI 只会说「已附加 N 张图片」，
 * REPL 只按「能不能按 utf-8 读成文本」分支 —— 于是 pdf/docx/xlsx/mp4 拖进 REPL 会
 * 掉到分支链末尾的「什么都不做」，路径原样当文本发给模型，用户看不到任何格式信号。
 *
 * 与另外两份表的关系（**第三份，不是 import**）：桌面端
 * `apps/khyos-desktop/src/renderer/components/composer/attachmentKind.ts` 与 web
 * `delivery/web/ai-frontend/src/utils/attachmentView.js` 各有一份同口径表。三个包分属
 * 不同构建边界（backend 是独立 npm 包，桌面端只 spawn 它、package.json 里没有任何
 * `@khy-os/*` 依赖），所以「共用一张表」得先建共享包，代价高于收益。三份由
 * `delivery/web/ai-frontend/src/utils/attachmentFormat.crossEnd.test.js` 逐扩展名对齐
 * 钉住 —— **改这里必须同时改那张表，否则那条测试会红**。
 *
 * 分桶口径与两端一致：**扩展名优先**，MIME 只在没有扩展名时兜底（剪贴板内容常常只有
 * MIME）。唯一有意的差异：终端拿到的 name 常是完整路径，先按最后一个路径分隔符取
 * basename 再取扩展名 —— `C:\a.b\report` 这种带点的目录名否则会被判成扩展名 `b\report`。
 */

/** 桶名册（顺序即 chip 行的稳定顺序；与桌面端 AttachmentKind 同一批值）。 */
const FORMATS = [
  'image',
  'pdf',
  'doc',
  'sheet',
  'slide',
  'video',
  'audio',
  'archive',
  'code',
  'md',
  'text',
  'file',
];

// 同一桶的打开方式/处理链路相同，标签也就同形。扩展名表与桌面端 / web 逐字一致，
// 由 crossEnd 测试钉住。顺序即筛选/展示顺序。
const EXT_FORMATS = [
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'heic']],
  ['pdf', ['pdf']],
  ['doc', ['doc', 'docx', 'rtf', 'odt', 'wps', 'pages']],
  ['sheet', ['xls', 'xlsx', 'csv', 'tsv', 'ods', 'et', 'numbers']],
  ['slide', ['ppt', 'pptx', 'odp', 'dps', 'key']],
  ['video', ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'm4v', 'wmv', 'mpg', 'mpeg']],
  ['audio', ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma']],
  ['archive', ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz']],
  // md 与 txt 分开：两者都是纯文本，但 md 有结构（标题/代码块/表格），交给模型的
  // 读法不一样，用户在输入区也分得出来才敢挑（2026-11-01 人提）。
  ['md', ['md', 'markdown', 'mdx', 'mdown']],
  ['text', ['txt', 'log', 'rst']],
  [
    'code',
    [
      'js',
      'jsx',
      'ts',
      'tsx',
      'vue',
      'py',
      'json',
      'yaml',
      'yml',
      'toml',
      'ini',
      'css',
      'scss',
      'html',
      'sh',
      'ps1',
      'bat',
      'go',
      'rs',
      'java',
      'c',
      'h',
      'cpp',
      'sql',
    ],
  ],
];

const FORMAT_BY_EXT = {};
for (const [format, exts] of EXT_FORMATS) {
  for (const ext of exts) {
    FORMAT_BY_EXT[ext] = format;
  }
}

// 终端标签用**扩展名同词**（PDF / MD / TXT…），不用中文短词：省列宽，且「用户嘴里说的
// 那个后缀」与「屏幕上那个标签」是同一个词。宽度一律按列宽算（见 tui/wrapCell），
// 中文标签是双宽，窄终端里一行放不下两张 chip。
const FORMAT_TAG = {
  image: 'IMG',
  pdf: 'PDF',
  doc: 'DOC',
  sheet: 'XLS',
  slide: 'PPT',
  video: 'VID',
  audio: 'AUD',
  archive: 'ZIP',
  code: 'CODE',
  md: 'MD',
  text: 'TXT',
  file: 'FILE',
};

// 只给「认格式有惯用色」的桶上色，其余继承终端前景 —— 与桌面端 attachmentTint 是
// 同一批桶（image / pdf / sheet / slide / md）。十来种颜色铺在输入框上方会盖过正文。
// 取值是 ink 的颜色名而非 hex：跟随用户自己的终端主题。
const FORMAT_TINT = {
  image: 'cyan',
  pdf: 'red',
  sheet: 'green',
  slide: 'yellow',
  md: 'cyan',
};

/**
 * 取 basename（同时认 `/` 与 `\`，不引 path —— 终端两侧都要正确）。
 * @param {string} name
 * @returns {string}
 */
function basename(name) {
  const raw = String(name == null ? '' : name);
  const cut = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  return cut >= 0 ? raw.slice(cut + 1) : raw;
}

/**
 * 判定一份附件属于哪一桶。扩展名优先，认不出才按 MIME 兜底，最后落 `file`。
 *
 * @param {string} name 文件名或完整路径
 * @param {string} [mime] MIME（可缺）
 * @returns {string} FORMATS 之一
 */
function attachmentFormat(name, mime) {
  const base = basename(name);
  const dot = base.lastIndexOf('.');
  // 没有点，或点在首字符（`.gitignore` 这类隐藏文件没有扩展名）→ 交给 MIME。
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  const byExt = ext ? FORMAT_BY_EXT[ext] : undefined;
  if (byExt) {
    return byExt;
  }
  const type = String(mime == null ? '' : mime).toLowerCase();
  if (type.startsWith('image/')) {
    return 'image';
  }
  if (type.startsWith('video/')) {
    return 'video';
  }
  if (type.startsWith('audio/')) {
    return 'audio';
  }
  if (type === 'application/pdf') {
    return 'pdf';
  }
  if (type.startsWith('text/')) {
    return 'text';
  }
  return 'file';
}

/**
 * 桶 → 终端标签（3–4 列，`IMG`/`CODE`/`FILE` 等）。未知桶回落 `FILE`，绝不抛。
 * @param {string} format
 * @returns {string}
 */
function formatTag(format) {
  return FORMAT_TAG[format] || FORMAT_TAG.file;
}

/**
 * 桶 → ink 颜色名；无惯用色的桶返回 `undefined`（调用方按继承前景处理）。
 * @param {string} format
 * @returns {string|undefined}
 */
function formatTint(format) {
  return FORMAT_TINT[format];
}

/**
 * chip 的**纯文本**形态 —— transcriptLines 的行投影与 REPL 的逐文件行共用，避免
 * 两个面各自拼一次 `[TAG] name size` 而口径漂移。
 *
 * @param {{name?:string, format?:string, size?:number}} att
 * @param {{withSize?:boolean}} [opts] withSize 默认 true
 * @returns {string} 例：`[PDF] 报告.pdf 12.3 KB`
 */
function formatChipText(att, opts = {}) {
  const item = att && typeof att === 'object' ? att : {};
  const format = item.format || attachmentFormat(item.name, '');
  const name = basename(item.name) || '未命名';
  const head = `[${formatTag(format)}] ${name}`;
  if (opts.withSize === false) {
    return head;
  }
  const size = Number(item.size);
  if (!Number.isFinite(size) || size <= 0) {
    return head;
  }
  return `${head} ${require('../utils/formatBytes')(size, { maxUnit: 'GB' })}`;
}

/**
 * 附件列表 → chip 行的只读描述。chip 组件与提交回显共用，避免两处各算一遍名字/桶。
 *
 * 输入可以是暂存项（`{name?, size?}`）、inline 路径图（`{label?, sizeBytes?}`）或
 * 网关载荷（`{base64, mimeType}`，无名字 → 退回 `图N`）。`label` 优先当名字用：
 * 多图对照模式下它就是原始路径，用户认的就是它。
 *
 * @param {Array<object>} list
 * @returns {Array<{name:string, format:string, size:number}>}
 */
function toDisplay(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((item, index) => {
    const raw = String((item && (item.name || item.label)) || '').trim();
    const name = basename(raw) || `图${index + 1}`;
    const size = Number(item && (item.size != null ? item.size : item.sizeBytes));
    return {
      name,
      format: attachmentFormat(name, item && item.mimeType),
      size: Number.isFinite(size) && size > 0 ? size : 0,
    };
  });
}

module.exports = {
  FORMATS,
  EXT_FORMATS,
  attachmentFormat,
  attachmentBasename: basename,
  formatTag,
  formatTint,
  formatChipText,
  toDisplay,
};
