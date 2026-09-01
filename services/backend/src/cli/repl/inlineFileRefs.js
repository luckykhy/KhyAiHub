'use strict';

/**
 * inlineFileRefs.js — 多格式附件路径扫描的纯叶（[DESIGN-ARCH-163] D6）。
 *
 * 「一次输入混排 文字 + 图片 + pdf/docx/md/txt/csv…」的**发现层**：一条通用
 * 非重叠扫描引擎（引号形态优先占位、按出现序、去重），配两组扩展名原子：
 * 图片组由 imageIntent 传入（保持其单一真源），文档/文本组在本叶定义。
 * 零 IO、绝不抛；读文件/提文本是调用方（网关说明书服务）的事。
 */

// 与 aiUploadStore.TEXT_EXTENSIONS + document 扩展集对齐的**引用面**（不含归档/媒体，
// 那些格式没有提取通道，登记为引用卡只会噪音）。改这里前先对 aiUploadStore 的口径。
const FILE_EXT_SET =
  'pdf|docx|doc|xlsx|xls|pptx|ppt|odt|ods|odp|txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|xml|html|htm|log|rtf';

// [DESIGN-ARCH-163] D7 媒体/归档引用面：仅在诚实引导门控开时由调用方追加
//（zip/tar 清单、mp3 元数据+歌词、视频元数据+抽帧、bmp/tiff 位图卡）。
// 与 imageIntent 的 png|jpg|jpeg|gif|webp 刻意不相交，去重语义不变。
const D7_MEDIA_EXT_SET =
  'zip|tar|gz|tgz|bz2|xz|7z|rar|mp3|wav|flac|m4a|ogg|aac|mp4|mkv|mov|avi|webm|wmv|mpeg|mpg|bmp|tiff|tif|heic|heif';

function _pathAtomQuoted(exts) {
  const tail = `\\.(?:${exts})`;
  return `(?:file:\\/\\/[^"'\`<>]+?${tail}|(?:[A-Za-z]:[\\\\/])[^"'\`<>]+?${tail}|(?:\\/|\\.\\/|\\.\\.\\/)[^"'\`<>]+?${tail})`;
}

function _pathAtomUnquoted(exts) {
  const tail = `\\.(?:${exts})`;
  return `(?:file:\\/\\/[^\\s"'\`<>]+?${tail}|(?:[A-Za-z]:[\\\\/])[^\\s"'\`<>]+?${tail}|(?:\\/|\\.\\/|\\.\\.\\/)[^\\s"'\`<>]+?${tail})`;
}

/**
 * 通用扫描引擎：quotedAtom / unquotedAtom 为**捕获组已包好**的正则源。
 * 引号命中先占位，未引号只收不重叠者；按出现序去重（同一路径只留首现）。
 * @param {string} text
 * @param {string} quotedAtom   整条作为 group2 的原子（不含外层括号）
 * @param {string} unquotedSrc  含 group1 的完整未引号正则源
 * @returns {Array<{filePath:string, span:string}>}
 */
function scanPathRefs(text, quotedAtom, unquotedSrc) {
  const s = String(text || '');
  const found = [];
  if (!s.trim()) {
    return found;
  }
  const taken = [];
  const overlaps = (a, b) => taken.some(([x, y]) => a < y && x < b);
  const take = (start, end, filePath) => {
    if (!filePath || start < 0 || overlaps(start, end)) {
      return;
    }
    taken.push([start, end]);
    found.push({ idx: start, filePath, span: s.slice(start, end) });
  };
  try {
    const quoted = new RegExp(`(["'\`])(${quotedAtom})\\1`, 'gi');
    let m;
    while ((m = quoted.exec(s)) !== null) {
      take(m.index, m.index + m[0].length, m[2]);
      if (m.index === quoted.lastIndex) quoted.lastIndex++;
    }
    const unquoted = new RegExp(unquotedSrc, 'gi');
    while ((m = unquoted.exec(s)) !== null) {
      take(m.index, m.index + m[0].length, m[1]);
      if (m.index === unquoted.lastIndex) unquoted.lastIndex++;
    }
  } catch {
    return found;
  }
  found.sort((a, b) => a.idx - b.idx);
  const seen = new Set();
  return found
    .map(({ idx, ...rest }) => rest)
    .filter((e) => {
      if (seen.has(e.filePath)) return false;
      seen.add(e.filePath);
      return true;
    });
}

/**
 * 扫描一条消息里全部**文档/文本**文件路径（pdf/docx/md/txt/csv/json/yaml/…）。
 * 图片扩展名**不**在这里出现——图片由 imageIntent 的原子负责，两集合刻意不相交，
 * 调用方按「先图后文」合并即可无歧义。
 * @param {string} text
 * @param {string} [extraExtSet] D7：门控开时追加的媒体/归档扩展集（如 D7_MEDIA_EXT_SET）
 */
function extractAllFileReferences(text, extraExtSet) {
  const exts = extraExtSet ? `${FILE_EXT_SET}|${extraExtSet}` : FILE_EXT_SET;
  const quotedAtom = _pathAtomQuoted(exts);
  const unquotedSrc = `(${_pathAtomUnquoted(exts)})`;
  return scanPathRefs(text, quotedAtom, unquotedSrc);
}

module.exports = {
  FILE_EXT_SET,
  D7_MEDIA_EXT_SET,
  _pathAtomQuoted,
  _pathAtomUnquoted,
  scanPathRefs,
  extractAllFileReferences,
};
