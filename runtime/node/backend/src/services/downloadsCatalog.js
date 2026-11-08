'use strict';

/**
 * downloadsCatalog.js — 安装包清单的唯一真源。
 *
 * 四端都要能被下载：网页版把 APK 与桌面安装包交给浏览器，桌面端「下载安卓版 /
 * 下载桌面版」也走同一份清单，APK 端在「关于」里给出网页版与桌面端的地址。
 * 三处各写一遍目录探测就会出现「网页说有、桌面说没有」这种无人可归因的分叉，
 * 所以目录解析与产物匹配只在这里做一次。
 *
 * 产物落在构建产物区（`[DESIGN-LAY-004]` LAYOUT-005）：
 *   - APK   → `<repo>/dist/android/app-release.apk`
 *   - 桌面  → `<repo>/apps/khyos-desktop/dist-electron/*Setup*.exe`
 * 目录可用 env 覆盖（分发机器上产物不在仓库里时由部署侧指定）。
 *
 * 只读、绝不抛：任一目录缺失 → 该项为 null，调用方如实说明「没有这个包」，
 * 不得用「下载失败」冒充「不存在」。
 */

const fs = require('fs');
const path = require('path');

const { UPDATE } = require('../constants/serviceDefaults');

// src/services → src → backend → node → runtime → <repo>
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const ANDROID_DIR = process.env.KHY_DOWNLOAD_ANDROID_DIR || path.join(REPO_ROOT, 'dist', 'android');
const DESKTOP_DIR =
  process.env.KHY_DOWNLOAD_DESKTOP_DIR || path.join(REPO_ROOT, 'apps', 'khyos-desktop', 'dist-electron');

const ARTIFACTS = Object.freeze({
  android: { dirs: [ANDROID_DIR], patterns: [/\.apk$/i] },
  // 只认安装器：win-unpacked 目录与其中的裸 exe 不是给用户下载的东西。
  windows: { dirs: [DESKTOP_DIR], patterns: [/setup/i, /\.exe$/i] },
});

function listIn(dir, patterns) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const fileName of names) {
    if (fileName.startsWith('.') || fileName.endsWith('.blockmap')) continue;
    if (!patterns.every((pattern) => pattern.test(fileName))) continue;
    const fullPath = path.join(dir, fileName);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({ fileName, fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return out;
}

/** 某一端的最新产物；没有就是 null（不造占位项）。 */
function latestArtifact(platform) {
  const spec = ARTIFACTS[platform];
  if (!spec) return null;
  const found = spec.dirs.flatMap((dir) => listIn(dir, spec.patterns));
  if (found.length === 0) return null;
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found[0];
}

/** 发布页兜底：只在配了仓库时给出，没配就是 null（不拼坏地址）。 */
function releasePageUrl(env = process.env) {
  const repository = env.KHY_DOWNLOAD_GITHUB_REPOSITORY || env.KHY_UPDATE_GITHUB_REPOSITORY || UPDATE.GITHUB_REPOSITORY;
  if (!repository) return null;
  return `https://github.com/${repository}/releases/latest`;
}

/**
 * 完整清单（路由与桌面端共用）。`webUrl` 为空时表示「没单独配置网页版地址，
 * 调用方用自己的同源地址」——不是错误。
 */
function describeArtifact(platform) {
  const artifact = latestArtifact(platform);
  if (!artifact) return null;
  return {
    fileName: artifact.fileName,
    size: artifact.size,
    updatedAt: new Date(artifact.mtimeMs).toISOString(),
    filePath: artifact.fullPath,
    url: `/api/downloads/${platform}`,
  };
}

function listDownloads(env = process.env) {
  return {
    web: { url: env.KHY_WEB_URL || null },
    windows: describeArtifact('windows'),
    android: describeArtifact('android'),
    fallback: { releasePage: releasePageUrl(env) },
  };
}

module.exports = {
  REPO_ROOT,
  latestArtifact,
  releasePageUrl,
  listDownloads,
};
