// contact.mjs — 把每个场景的帧压成一张接触表，并导出每场景的中值关键帧。
//
// 为什么自带 3x5 点阵字体：这个脚本只被 pngjs 依赖，装一个 canvas 原生包
// 会让整条链路多一个平台二进制；时间码只用到数字和冒号，点阵足够且零依赖。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FRAMES_DIR = path.join(PKG_ROOT, 'out', 'frames');
const OUT_DIR = path.join(PKG_ROOT, 'out');
const KEY_DIR = path.join(OUT_DIR, 'key');
const SCENES_PATH = path.join(PKG_ROOT, 'src', 'story', 'scenes.json');

const FPS = 24;
const GAP = 8;
const LABEL_H = 26;
const FONT_SCALE = 3;
const MAX_SHEET_WIDTH = 8192;

// 单图宽度上限是多数看图工具与 PNG 解码实现能一次吃下的尺度；
// 超出不截断而是加列，只有单格本身就超宽时才降采样。
const GLYPHS = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '001', '111', '001', '111'],
  ':': ['000', '010', '000', '010', '000'],
  '.': ['000', '000', '000', '000', '010'],
  '-': ['000', '000', '111', '000', '000'],
  S: ['111', '100', '111', '001', '111'],
  ' ': ['000', '000', '000', '000', '000'],
};

function fillRect(png, x, y, w, h, [r, g, b]) {
  for (let j = y; j < y + h; j += 1) {
    if (j < 0 || j >= png.height) continue;
    for (let i = x; i < x + w; i += 1) {
      if (i < 0 || i >= png.width) continue;
      const o = (png.width * j + i) << 2;
      png.data[o] = r;
      png.data[o + 1] = g;
      png.data[o + 2] = b;
      png.data[o + 3] = 255;
    }
  }
}

function drawText(png, x, y, text, color) {
  let cursor = x;
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (glyph) {
      for (let row = 0; row < glyph.length; row += 1) {
        for (let col = 0; col < glyph[row].length; col += 1) {
          if (glyph[row][col] !== '1') continue;
          fillRect(png, cursor + col * FONT_SCALE, y + row * FONT_SCALE, FONT_SCALE, FONT_SCALE, color);
        }
      }
    }
    // 未收录的字符按空格走：缺一个字不该让整张表画不出来。
    cursor += 4 * FONT_SCALE;
  }
}

function timecode(t) {
  const total = Math.max(0, Math.round(t * FPS));
  const ff = total % FPS;
  const totalSec = Math.floor(total / FPS);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

function readSceneIds() {
  try {
    const raw = JSON.parse(fs.readFileSync(SCENES_PATH, 'utf8'));
    const list = Array.isArray(raw.sceneDurations)
      ? raw.sceneDurations
      : Array.isArray(raw.scenes)
        ? raw.scenes
        : [];
    const ids = list.map((s) => String(s.id)).filter(Boolean);
    if (ids.length) return ids;
  } catch {
    // scenes.json 还没写是常态，退回按磁盘上的场景目录走。
  }
  return fs.existsSync(FRAMES_DIR)
    ? fs
        .readdirSync(FRAMES_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : [];
}

function scalePng(png, factor) {
  if (factor >= 1) return png;
  const w = Math.max(1, Math.round(png.width * factor));
  const h = Math.max(1, Math.round(png.height * factor));
  const out = new PNG({ width: w, height: h });
  for (let j = 0; j < h; j += 1) {
    const sy = Math.min(png.height - 1, Math.floor(j / factor));
    for (let i = 0; i < w; i += 1) {
      const sx = Math.min(png.width - 1, Math.floor(i / factor));
      const so = (png.width * sy + sx) << 2;
      const to = (w * j + i) << 2;
      out.data[to] = png.data[so];
      out.data[to + 1] = png.data[so + 1];
      out.data[to + 2] = png.data[so + 2];
      out.data[to + 3] = 255;
    }
  }
  return out;
}

const sceneIds = readSceneIds();
if (!sceneIds.length) {
  console.error('[khyos-desktop] out/frames 里没有场景目录，先跑 node scripts/capture.mjs。');
  process.exit(1);
}

for (const sceneId of sceneIds) {
  const frames = fs
    .readdirSync(path.join(FRAMES_DIR, sceneId))
    .filter((f) => /^frame_\d{5}\.png$/.test(f))
    .sort();
  if (!frames.length) {
    console.error(`[khyos-desktop] out/frames/${sceneId} 里没有帧，跳过本场景。`);
    continue;
  }

  // 每个场景取 3~4 帧：头、尾、中间各一，长场景再加一个四分位点。
  const span = frames.length;
  const picks =
    span >= 4
      ? [0, Math.floor(span / 3), Math.floor((2 * span) / 3), span - 1]
      : [0, Math.floor(span / 2), span - 1];
  const unique = [...new Set(picks)].sort((a, b) => a - b);

  const cells = unique.map((p) => ({ frameIndex: p }));
  const firstPng = PNG.sync.read(fs.readFileSync(path.join(FRAMES_DIR, sceneId, frames[0])));
  const frameW = firstPng.width;
  const frameH = firstPng.height;

  const cellW = frameW + GAP * 2;
  const factor = cellW > MAX_SHEET_WIDTH ? MAX_SHEET_WIDTH / cellW : 1;
  const effCellW = Math.round(cellW * factor);
  const cols = Math.max(1, Math.min(cells.length, Math.floor(MAX_SHEET_WIDTH / effCellW)));
  const rows = Math.ceil(cells.length / cols);
  const sheetW = cols * effCellW + GAP;
  const sheetH = rows * (Math.round(frameH * factor) + LABEL_H + GAP) + GAP;

  const sheet = new PNG({ width: sheetW, height: sheetH });
  fillRect(sheet, 0, 0, sheetW, sheetH, [11, 14, 20]);

  for (let c = 0; c < cells.length; c += 1) {
    const cell = cells[c];
    const col = c % cols;
    const row = Math.floor(c / cols);
    const x = GAP + col * effCellW;
    const y = GAP + row * (Math.round(frameH * factor) + LABEL_H + GAP);
    const img = scalePng(
      PNG.sync.read(fs.readFileSync(path.join(FRAMES_DIR, sceneId, frames[cell.frameIndex]))),
      factor,
    );
    fillRect(sheet, x, y, img.width, img.height + LABEL_H, [21, 26, 36]);
    drawText(sheet, x + 4, y + 6, `${sceneId} ${timecode(cell.frameIndex / FPS)}`, [214, 226, 245]);
    PNG.bitblt(img, sheet, 0, 0, img.width, img.height, x, y + LABEL_H);
  }

  const sheetPath = path.join(OUT_DIR, `contact-${sceneId}.png`);
  fs.writeFileSync(sheetPath, PNG.sync.write(sheet));
  console.log(
    `[khyos-desktop] 接触表 ${path.relative(PKG_ROOT, sheetPath)}：${cells.length} 格，${sheetW}x${sheetH}`,
  );

  // 中值关键帧按原分辨率导出，接触表里那一格是缩过的，不能拿它当关键帧用。
  const midIndex = Math.floor(span / 2);
  fs.mkdirSync(KEY_DIR, { recursive: true });
  const keyPath = path.join(KEY_DIR, `${sceneId}.png`);
  fs.copyFileSync(path.join(FRAMES_DIR, sceneId, frames[midIndex]), keyPath);
  console.log(
    `[khyos-desktop] 关键帧 ${path.relative(PKG_ROOT, keyPath)}：中值帧 ${frames[midIndex]}（原分辨率）`,
  );
}
