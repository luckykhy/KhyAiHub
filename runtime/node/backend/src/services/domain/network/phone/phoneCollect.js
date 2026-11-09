'use strict';

/**
 * phoneCollect.js — 按类型从手机上批量采集文件（图片/音频/视频/JSON/文本）。
 *
 * 与 pull 的分工：pull 一次搬一个已知路径；collect 先在设备上枚举，再按类型筛，
 * 逐个搬运，最后落一份清单（manifest.json），让人知道「这次到底采到了什么」。
 *
 * 枚举走 `adb shell find`：桥的 HTTP 面里的 ls 是收窄过的（只列白名单根），
 * 而采集要的是 DCIM/Download/Movies 这类实际有货的目录，shell 侧才够得着。
 * 设备上的 find 在 Android 6+ 的 toybox 里都有；真机上没有就如实报错，不假装采到了。
 *
 * 纯函数为主：扩展名归类、find 的 argv、清单结构都在这里，IO 在 client 里。
 */

const COLLECT_TYPES = Object.freeze({
  image: Object.freeze(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'bmp']),
  audio: Object.freeze(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'amr', 'flac', 'opus']),
  video: Object.freeze(['mp4', 'mov', 'mkv', 'webm', '3gp', 'avi']),
  json: Object.freeze(['json']),
  text: Object.freeze(['txt', 'md', 'log', 'csv', 'xml', 'yaml', 'yml', 'html', 'js', 'py', 'dart']),
});

const TYPE_NAMES = Object.freeze(Object.keys(COLLECT_TYPES));

/** 扩展名（小写、无点）→ 采集类型。同扩展名归多类时以第一个为准。 */
const EXT_TO_TYPE = (() => {
  const map = new Map();
  for (const type of TYPE_NAMES) {
    for (const ext of COLLECT_TYPES[type]) {
      if (!map.has(ext)) {
        map.set(ext, type);
      }
    }
  }
  return map;
})();

function extensionOf(name) {
  const base = String(name || '').split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return '';
  }
  return base.slice(dot + 1).toLowerCase();
}

/** 归类：扩展名命中返回类型，未命中返回 null（不是所有文件都值得采）。 */
function classifyFile(name) {
  return EXT_TO_TYPE.get(extensionOf(name)) || null;
}

/**
 * find 的 argv。深度不在设备侧限（toybox 的 find 不一定支持 -maxdepth），
 * 改在 JS 里按路径分段数过滤——这条规则跟着本文件走，不依赖设备的 find 实现。
 */
function buildFindArgv(config, remoteDir) {
  return ['shell', 'find', String(remoteDir || ''), '-type', 'f'];
}

/** 路径深度：/sdcard/DCIM/x.jpg 是 3 段。 */
function pathDepth(remotePath) {
  return String(remotePath || '').split('/').filter(Boolean).length;
}

/**
 * 时间窗：只收最近 N 天的文件（mtime 判定）。
 *
 * @param {string} spec 形如 `7d` / `48h` / `2w`；空串表示不设时间窗
 * @param {number} [now] 当前时间（毫秒），测试可注入
 * @returns {number|null} 起始时间戳（毫秒）；不设窗返回 null
 */
function parseSince(spec, now = Date.now()) {
  const text = String(spec || '').trim().toLowerCase();
  const matched = /^(\d+)\s*([dhw])$/.exec(text);
  if (!matched) {
    return null;
  }
  const amount = Number(matched[1]);
  const unitMs = matched[2] === 'd' ? 86400000 : matched[2] === 'h' ? 3600000 : 604800000;
  return now - amount * unitMs;
}

/**
 * 按时间窗筛文件。mtime 缺失（设备没有 stat）时不筛——宁可多采，不可谎称筛过。
 */
function filterBySince(files, sinceMs) {
  if (!sinceMs) {
    return { kept: files, dropped: [], unknown: 0 };
  }
  const kept = [];
  const dropped = [];
  let unknown = 0;
  for (const file of files) {
    if (typeof file.mtimeMs !== 'number') {
      unknown += 1;
      kept.push(file);
      continue;
    }
    if (file.mtimeMs >= sinceMs) {
      kept.push(file);
    } else {
      dropped.push(file);
    }
  }
  return { kept, dropped, unknown };
}

function isUnderDir(remotePath, remoteDir) {
  const dir = String(remoteDir || '').replace(/\/+$/, '');
  if (!dir) {
    return false;
  }
  return String(remotePath || '').startsWith(`${dir}/`);
}

/**
 * 枚举结果的候选集：目录内、深度不过头、路径去重。type 为 null 表示扩展名不认识
 * （不采，但要在清单里说明为什么没采）。
 * @param {{paths?: string[], remoteDir?: string, maxDepth?: number}} input
 */
function listCandidates(input = {}) {
  const paths = Array.isArray(input.paths) ? input.paths : [];
  const remoteDir = String(input.remoteDir || '');
  const maxDepth = Number(input.maxDepth) > 0 ? Number(input.maxDepth) : 4;
  const candidates = [];
  const seen = new Set();
  for (const raw of paths) {
    const p = String(raw || '').trim();
    if (!p || seen.has(p)) {
      continue;
    }
    seen.add(p);
    if (!isUnderDir(p, remoteDir)) {
      continue;
    }
    if (pathDepth(p) > maxDepth) {
      continue;
    }
    candidates.push({ remotePath: p, type: classifyFile(p) });
  }
  return candidates;
}

/**
 * 挑出这次要采的文件：类型命中、深度不超过上限、路径在目录内。
 * @param {{paths?: string[], remoteDir?: string, types?: string[], maxDepth?: number}} input
 */
function selectFiles(input = {}) {
  const wanted = new Set(
    (Array.isArray(input.types) && input.types.length ? input.types : TYPE_NAMES)
      .map((t) => String(t).toLowerCase())
      .filter((t) => TYPE_NAMES.includes(t)),
  );
  return listCandidates(input).filter((c) => c.type && wanted.has(c.type));
}

/** 清单：本次采了什么、来自哪里、多大、什么类型。 */
function buildManifest(input = {}) {
  return {
    schema: 'khy-phone-collect/1',
    at: new Date().toISOString(),
    remoteDir: String(input.remoteDir || ''),
    localDir: String(input.localDir || ''),
    types: Array.isArray(input.types) && input.types.length ? input.types : TYPE_NAMES,
    sinceMs: typeof input.sinceMs === 'number' ? input.sinceMs : null,
    sinceUnknown: Number(input.sinceUnknown) || 0,
    counts: input.counts && typeof input.counts === 'object' ? input.counts : {},
    files: Array.isArray(input.files) ? input.files : [],
    skipped: Array.isArray(input.skipped) ? input.skipped : [],
  };
}

module.exports = {
  COLLECT_TYPES,
  TYPE_NAMES,
  extensionOf,
  classifyFile,
  buildFindArgv,
  pathDepth,
  isUnderDir,
  parseSince,
  filterBySince,
  listCandidates,
  selectFiles,
  buildManifest,
};
