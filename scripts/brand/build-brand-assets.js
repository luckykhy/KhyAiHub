#!/usr/bin/env node
'use strict';

/**
 * build-brand-assets — Khy OS 品牌资产构建器。
 *
 * 单一真源：`delivery/brand/khy-brand-geometry.js`（几何 + 配色）。
 * 本脚本只做**确定性渲染与落盘**，不新增任何设计决策。
 *
 * 产物：
 *   delivery/brand/svg/**.svg                  矢量母版（主标 / 单色 / 字标 / 应用图标 / favicon）
 *   delivery/brand/png/**.png                  位图母版（应用图标 / 透明主标 / favicon）
 *   delivery/brand/icon/khy-os.ico             多尺寸 ICO（Windows / Electron）
 *   delivery/brand/khy-brand-tokens.json       五端品牌令牌取值（机器可读）
 *   delivery/web/ai-frontend/public/**         Web favicon + 内联用主标
 *   apps/khyos-desktop/{resources/icon,public,launcher}/*.ico   桌面端图标
 *   delivery/mobile/.../android/app/src/main/res/**  Android 启动图标（各密度 + 自适应）
 *   runtime/node/backend/src/cli/tui/brandPixelArt.js            TUI 像素标记（生成物）
 *
 * 栅格化：本机 Edge 无头截图（HTML → PNG），与 `scripts/evidence/render-images.js` 同一套路——
 * 中文字体与渐变由系统真渲染，不依赖任何 npm 包。
 *
 * **一张图集一次渲染**：所有目标尺寸排进一张 HTML 图集，Edge 截一次大图，
 * 再用 pngjs 按格子切片。比「每个尺寸起一次 Edge」快一个数量级，也避免了
 * 反复启动 Edge 的超时与残留进程问题（曾实测 45 次启动里有 2 次 ETIMEDOUT）。
 *
 * 用法：
 *   node scripts/brand/build-brand-assets.js            # 全量构建
 *   node scripts/brand/build-brand-assets.js --svg-only # 只出矢量（不栅格化，用于无图形环境）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const BRAND = path.join(REPO, 'delivery', 'brand');
const geo = require(path.join(BRAND, 'khy-brand-geometry.js'));
const wordmark = require(path.join(BRAND, 'khy-brand-wordmark.js'));
const { PNG } = require(path.join(REPO, 'node_modules', 'pngjs'));

const { CANVAS, CENTER, GEOMETRY, PALETTE } = geo;
const SVG_ONLY = process.argv.includes('--svg-only');
const BROWSER_ENV = 'KHY_EVIDENCE_BROWSER';

/**
 * 紧凑几何：给 ≤32px 的场景（favicon、桌面角标）用。
 * 四段弧叶在小尺寸会糊成一团 —— 收窄缝口、去掉斜切、换实心内核，
 * 让 16px 下仍读得出「四段环 + 中心核」的骨架。
 */
const COMPACT_GEOMETRY = Object.freeze({
  ...GEOMETRY,
  ringGapDeg: 4,
  ringSlantDeg: 8,
  coreHalf: 18,
});

/** ── 浏览器发现（与 scripts/evidence/render-images.js 同规则）──────────────── */
function findBrowser() {
  const fromEnv = process.env[BROWSER_ENV];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA]
    .filter(Boolean);
  const names = [
    'Microsoft/Edge/Application/msedge.exe',
    'Chromium/Application/chrome.exe',
    'Google/Chrome/Application/chrome.exe',
  ];
  for (const r of roots) {
    for (const n of names) {
      const p = path.join(r, n);
      if (fs.existsSync(p)) return p;
    }
  }
  try {
    const out = execFileSync('where', ['msedge'], { encoding: 'utf8' }).trim();
    const found = out.split(String.fromCharCode(10))[0];
    if (found && fs.existsSync(found)) return found;
  } catch {
    /* PATH 里没有就算了 */
  }
  return null;
}

/** ── SVG 拼装 ───────────────────────────────────────────────────────────── */

function gradientDef(id, from, to) {
  return (
    `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
    `</linearGradient>`
  );
}

/** 主标（symbol）。mode: color（琥珀渐变）/ ink（墨黑）/ paper（纸白）。 */
function markSvg({
  mode = 'color',
  size = CANVAS,
  title = 'Khy OS',
  geometry = GEOMETRY,
  withSlot = true,
  viewBox = null,
} = {}) {
  const parts = geo.markParts(geometry);
  const blades = parts.blades.map((d) => `<path d="${d}"/>`).join('');
  const core = `<path d="${withSlot ? parts.core : parts.corePlain}" fill-rule="evenodd"/>`;
  let defs = '';
  let fill = '';
  if (mode === 'color') {
    defs = `<defs>${gradientDef('khyAmber', PALETTE.amber300, PALETTE.amber500)}</defs>`;
    fill = 'url(#khyAmber)';
  } else if (mode === 'ink') {
    fill = PALETTE.ink;
  } else if (mode === 'paper') {
    fill = PALETTE.paper;
  } else {
    fill = 'currentColor';
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox || `0 0 ${CANVAS} ${CANVAS}`}" width="${size}" height="${size}" role="img" aria-label="${title}">` +
    `<title>${title}</title>` +
    defs +
    `<g fill="${fill}">${blades}</g>` +
    `<g fill="${fill}">${core}</g>` +
    `</svg>`
  );
}

/** 主标的外接框（弧叶外缘所围的正方形）。用于点阵渲染时裁掉空白，避免分辨率被浪费。 */
const MARK_BBOX = (() => {
  const r = GEOMETRY.ringOuter;
  return `${geo.f(CENTER - r)} ${geo.f(CENTER - r)} ${geo.f(r * 2)} ${geo.f(r * 2)}`;
})();

/**
 * 应用图标：墨黑圆角方块 + 琥珀主标。
 * `bleed`=true 时底板铺满（Android 自适应图标用）；`transparentBg`=true 时不画底板
 * （Android 自适应图标的前景层）。
 */
function appIconSvg({
  size = 512,
  bleed = false,
  radiusRatio = 0.225,
  markRatio = 0.7,
  transparentBg = false,
} = {}) {
  const parts = geo.markParts();
  const tiles = [];
  if (transparentBg) {
    // 前景层：只画主标，底板交给 Android 的背景层
  } else if (!bleed) {
    tiles.push(
      `<rect x="0" y="0" width="${size}" height="${size}" rx="${geo.f(size * radiusRatio)}" fill="${PALETTE.ink}"/>`
    );
  } else {
    tiles.push(`<rect x="0" y="0" width="${size}" height="${size}" fill="${PALETTE.ink}"/>`);
  }
  const markSize = size * markRatio;
  const off = (size - markSize) / 2;
  const scale = markSize / CANVAS;
  const blades = parts.blades
    .map((d) => `<path d="${d}" transform="translate(${geo.f(off)} ${geo.f(off)}) scale(${geo.f(scale)})"/>`)
    .join('');
  const core = `<path d="${parts.core}" fill-rule="evenodd" transform="translate(${geo.f(off)} ${geo.f(off)}) scale(${geo.f(scale)})"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Khy OS">` +
    `<title>Khy OS</title>` +
    `<defs>${gradientDef('khyAmber', PALETTE.amber300, PALETTE.amber500)}</defs>` +
    tiles.join('') +
    `<g fill="url(#khyAmber)">${blades}</g>` +
    `<g fill="url(#khyAmber)">${core}</g>` +
    `</svg>`
  );
}

/** 16–32px 用的简化主标：紧凑几何 + 实心内核（去掉 K 槽，小尺寸下只会糊）。 */
function faviconMarkSvg({ size = 32, mode = 'color' } = {}) {
  return markSvg({ mode, size, geometry: COMPACT_GEOMETRY, withSlot: false });
}

/**
 * 横向锁定组合：主标 + 字标「khy OS」。
 *
 * 字标是**矢量轮廓**（`delivery/brand/khy-brand-wordmark.js`，由
 * `scripts/brand/convert-wordmark-to-outlines.js` 从系统字体的 glyf 表提取），
 * 不是 `<text>` —— 商标递交图样必须脱离字体环境复现，换机器缺字体就走样。
 */
function lockupSvg({ mode = 'color' } = {}) {
  const parts = geo.markParts();
  const markSize = 96;
  const scale = markSize / CANVAS;
  const blades = parts.blades.map((d) => `<path d="${d}" transform="scale(${geo.f(scale)})"/>`).join('');
  const core = `<path d="${parts.core}" fill-rule="evenodd" transform="scale(${geo.f(scale)})"/>`;
  const defs =
    mode === 'color' ? `<defs>${gradientDef('khyAmber', PALETTE.amber300, PALETTE.amber500)}</defs>` : '';
  const markFill = mode === 'color' ? 'url(#khyAmber)' : mode === 'ink' ? PALETTE.ink : PALETTE.paper;
  const textFill = mode === 'color' ? PALETTE.ink : markFill;

  const wm = wordmark;
  const wmScale = 32 / Math.abs(wm.WORDMARK_ASCENDER); // 大写字高 ≈ 32px
  const capHeight = Math.abs(wm.WORDMARK_ASCENDER) * wmScale;
  const baseline = CANVAS / 2 + capHeight / 2;
  const gap = 22;
  const wmX = markSize + gap;
  const wmWidth = wm.WORDMARK_WIDTH * wmScale;
  const width = wmX + wmWidth;
  const height = markSize;

  const wmPaths = wm.WORDMARK_PATHS.map(
    (d) => `<path d="${d}" transform="translate(${geo.f(wmX)} ${geo.f(baseline)}) scale(${geo.f(wmScale)})"/>`
  ).join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${geo.f(width)} ${height}" width="${geo.f(width)}" height="${height}" role="img" aria-label="Khy OS">` +
    `<title>Khy OS</title>` + defs +
    `<g fill="${markFill}">${blades}</g><g fill="${markFill}">${core}</g>` +
    `<g fill="${textFill}">${wmPaths}</g>` +
    `</svg>`
  );
}

/**
 * 字标单独的图样（**文字商标**申请用）。
 *
 * 与锁定组合分开成文件，是因为商标实务上**图形与文字分开申请**：
 * 图形商标覆盖「字母变体」，文字商标覆盖「拼写保护」，两件各走各的类别与流程。
 * 字标已是轮廓（无 <text>），递交时不需要再做转曲。
 */
function wordmarkSvg({ mode = 'ink', size = 64 } = {}) {
  const wm = wordmark;
  const scale = size / Math.abs(wm.WORDMARK_ASCENDER);
  const width = wm.WORDMARK_WIDTH * scale;
  const top = wm.WORDMARK_ASCENDER * scale; // 负值：向上
  const bottom = wm.WORDMARK_DESCENDER * scale; // 正值：向下
  const height = bottom - top;
  const pad = size * 0.12;
  const fill = mode === 'paper' ? PALETTE.paper : PALETTE.ink;
  const paths = wm.WORDMARK_PATHS.map(
    (d) => `<path d="${d}" transform="translate(0 ${geo.f(pad - top)}) scale(${geo.f(scale)})"/>`
  ).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${geo.f(width + pad * 2)} ${geo.f(height + pad * 2)}" ` +
    `width="${geo.f(width + pad * 2)}" height="${geo.f(height + pad * 2)}" role="img" aria-label="khy OS">` +
    `<title>khy OS</title>` +
    `<g fill="${fill}">${paths}</g>` +
    `</svg>`
  );
}

/** 图形单独的图样（**图形商标**申请用）：墨黑单色 + 四周留白。 */
function filingMarkSvg({ size = 64, pad = 0.12 } = {}) {
  const box = size * (1 + pad * 2);
  const s = size / CANVAS;
  const off = box / 2 - (CANVAS / 2) * s;
  const parts = geo.markParts();
  const blades = parts.blades
    .map((d) => `<path d="${d}" transform="translate(${geo.f(off)} ${geo.f(off)}) scale(${geo.f(s)})"/>`)
    .join('');
  const core = `<path d="${parts.core}" fill-rule="evenodd" transform="translate(${geo.f(off)} ${geo.f(off)}) scale(${geo.f(s)})"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${geo.f(box)} ${geo.f(box)}" width="${geo.f(box)}" height="${geo.f(box)}" role="img" aria-label="Khy OS 图形商标">` +
    `<title>Khy OS 图形商标</title>` +
    `<g fill="${PALETTE.ink}">${blades}</g><g fill="${PALETTE.ink}">${core}</g>` +
    `</svg>`
  );
}

/** ── 图集渲染（Edge 一次截一张大图，再切片）────────────────────────────── */

function fileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20');
}

let browser = null;

function shoot(htmlPath, pngPath, w, h, transparent) {
  if (!browser) browser = findBrowser();
  if (!browser) {
    throw new Error(
      '找不到可用的浏览器可执行文件（Edge/Chrome）。可用 env KHY_EVIDENCE_BROWSER 指定路径；' +
        '或加 --svg-only 只产出矢量母版。'
    );
  }
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    transparent ? '--default-background-color=00000000' : '--default-background-color=FFFFFFFF',
    `--window-size=${w},${h}`,
    `--screenshot=${pngPath}`,
    fileUrl(htmlPath),
  ];
  // Edge 无头**经常以非零码退出**（本机可见 QQBrowser importer / task_manager 等 stderr 噪声），
  // 但截图已正确落盘。故不看退出码，以**产物是否落盘且是合法 PNG** 为唯一判据。
  const res = spawnSync(browser, args, { encoding: 'utf8', timeout: 180000 });
  if (res.error) throw res.error;
  if (!fs.existsSync(pngPath)) {
    throw new Error(
      `截图未落盘：${pngPath}（Edge 退出码 ${res.status}；${String(res.stderr || '').slice(0, 200)}）`
    );
  }
  const buf = fs.readFileSync(pngPath);
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`输出不是合法 PNG：${pngPath}`);
  return buf;
}

const tmpDir = path.join(BRAND, '.tmp-render');

/**
 * 把一批 SVG 渲染成 PNG。
 * items: [{ key, svg, size }] —— 返回 Map<key, PNG buffer>。
 */
function renderSheet(items) {
  if (!items.length) return new Map();
  const GUTTER = 8;
  const MAX_W = 1600;
  // 行内排布：按 size 降序，逐行累加宽度
  const sorted = items.slice().sort((a, b) => b.size - a.size);
  const rows = [];
  let row = [];
  let rowW = 0;
  for (const it of sorted) {
    const need = it.size + (row.length ? GUTTER : 0);
    if (row.length && rowW + need > MAX_W) {
      rows.push({ items: row, w: rowW });
      row = [];
      rowW = 0;
    }
    rowW += need;
    row.push(it);
  }
  if (row.length) rows.push({ items: row, w: rowW });

  const cellH = Math.max(...items.map((i) => i.size));
  const sheetW = Math.max(...rows.map((r) => r.w));
  const sheetH = rows.length * (cellH + GUTTER);

  let y = 0;
  const cells = [];
  for (const r of rows) {
    let x = 0;
    for (const it of r.items) {
      cells.push({ it, x, y });
      x += it.size + GUTTER;
    }
    y += cellH + GUTTER;
  }

  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0;padding:0;width:${sheetW}px;height:${sheetH}px;overflow:hidden;background:transparent}` +
    `.cell{position:absolute;overflow:hidden}` +
    `.cell>svg{display:block;width:100%;height:100%}` +
    `</style></head><body>` +
    cells
      .map(
        (c) =>
          `<div class="cell" style="left:${c.x}px;top:${c.y}px;width:${c.it.size}px;height:${c.it.size}px">${c.it.svg}</div>`
      )
      .join('') +
    `</body></html>`;

  fs.mkdirSync(tmpDir, { recursive: true });
  const htmlPath = path.join(tmpDir, `sheet-${crypto.randomBytes(6).toString('hex')}.html`);
  const pngPath = path.join(tmpDir, `sheet-${crypto.randomBytes(6).toString('hex')}.png`);
  fs.writeFileSync(htmlPath, html, 'utf8');
  const sheetBuf = shoot(htmlPath, pngPath, sheetW, sheetH, true);
  const sheet = PNG.sync.read(sheetBuf);
  fs.unlinkSync(htmlPath);
  fs.unlinkSync(pngPath);

  const out = new Map();
  for (const c of cells) {
    const { it, x, y } = c;
    const png = new PNG({ width: it.size, height: it.size });
    for (let row = 0; row < it.size; row++) {
      for (let col = 0; col < it.size; col++) {
        const src = ((y + row) * sheet.width + (x + col)) << 2;
        const dst = (row * it.size + col) << 2;
        png.data[dst] = sheet.data[src];
        png.data[dst + 1] = sheet.data[src + 1];
        png.data[dst + 2] = sheet.data[src + 2];
        png.data[dst + 3] = sheet.data[src + 3];
      }
    }
    out.set(it.key, PNG.sync.write(png));
  }
  return out;
}

/** ── ICO 容器（内嵌 PNG，Vista+ 支持）─────────────────────────────────── */
function buildIco(pngBuffers, icoPath) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngBuffers.length, 4);
  const dir = Buffer.alloc(16 * pngBuffers.length);
  let offset = 6 + dir.length;
  pngBuffers.forEach((buf, i) => {
    const dim = buf.readUInt32BE(16);
    const e = 16 * i;
    dir.writeUInt8(dim >= 256 ? 0 : dim, e);
    dir.writeUInt8(dim >= 256 ? 0 : dim, e + 1);
    dir.writeUInt8(0, e + 2);
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(buf.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });
  fs.mkdirSync(path.dirname(icoPath), { recursive: true });
  fs.writeFileSync(icoPath, Buffer.concat([header, dir, ...pngBuffers]));
  return icoPath;
}

/** ── 像素标记（TUI 用）──────────────────────────────────────────────────── */

/**
 * 把主标渲染成 N×M 的字符网格（供终端显示）。
 * 做法：放大 8 倍渲染 → 按 8×8 块求覆盖率与平均亮度 → 阈值化。
 * 放大再降采样是为了规避浏览器对小尺寸的舍入抖动，阈值取 0.42 保住叶片轮廓。
 *
 * 三档明暗（D/M/B）来自**渐变本身的亮度**：终端里复刻琥珀渐变的纵深，
 * 而不是画一个平的单色块。亮端 #FFC078 → B，主体 #E2703A → M，暗端 → D。
 */
function renderPixelArt(svg, cols, rows) {
  const S = 8;
  const items = [{ key: 'art', svg, size: cols * S }];
  const sheet = renderSheet(items);
  const png = PNG.sync.read(sheet.get('art'));
  const art = [];
  const shades = [];
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  for (let r = 0; r < rows; r++) {
    let line = '';
    let shadeLine = '';
    for (let c = 0; c < cols; c++) {
      let alphaSum = 0;
      let lumSum = 0;
      let n = 0;
      for (let dy = 0; dy < S; dy++) {
        for (let dx = 0; dx < S; dx++) {
          const x = c * S + dx;
          const y = r * S + dy;
          if (x >= png.width || y >= png.height) continue;
          const idx = (png.width * y + x) << 2;
          const a = png.data[idx + 3] / 255;
          alphaSum += a;
          if (a > 0.5) {
            const L =
              0.2126 * lin(png.data[idx]) +
              0.7152 * lin(png.data[idx + 1]) +
              0.0722 * lin(png.data[idx + 2]);
            lumSum += L;
          }
          n++;
        }
      }
      const cover = n ? alphaSum / n : 0;
      if (cover < 0.42) {
        line += ' ';
        shadeLine += ' ';
        continue;
      }
      line += '█';
      const L = lumSum / Math.max(1, n);
      shadeLine += L >= 0.47 ? 'B' : L >= 0.34 ? 'M' : 'D';
    }
    art.push(line);
    shades.push(shadeLine);
  }
  return { art, shades };
}

/** ── 落盘helpers ───────────────────────────────────────────────────────── */

function write(rel, content) {
  const abs = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function copy(fromRel, toRel) {
  const src = path.join(REPO, fromRel);
  const dst = path.join(REPO, toRel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return dst;
}

function writeBuf(rel, buf) {
  const abs = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return abs;
}

/**
 * 品牌预览页：把标记在**所有真实使用场景**里摊开（墨底 / 纸底 / 应用图标 / favicon /
 * 字标 / TUI 点阵 / 调色板与对比度），供人眼一次裁决。
 * 与资产母版同源生成 —— 改了真源重跑构建即可，不会出现「文档里的图是旧的」。
 */
function previewHtml({ markSvgStr, monoPaperSvg, pixelArt, tokens }) {
  const p = PALETTE;
  const swatch = (name, hex, note) =>
    `<div class="sw"><div class="chip" style="background:${hex}"></div>` +
    `<div class="sw-t"><b>${name}</b><code>${hex}</code><span>${note}</span></div></div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Khy OS 品牌预览</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0d0c0b;color:#e8e4de;font-family:"Microsoft YaHei","Segoe UI",system-ui,sans-serif;padding:32px 36px 60px}
  h1{font-size:24px;margin:0 0 6px}
  .lead{color:#9c958c;font-size:14px;max-width:900px;line-height:1.7;margin:0 0 30px}
  h2{font-size:15px;letter-spacing:.08em;color:#f0a868;margin:38px 0 14px;padding-bottom:8px;border-bottom:1px solid #2a2622}
  .grid{display:flex;flex-wrap:wrap;gap:22px;align-items:flex-end}
  .tile{border-radius:20px;display:flex;align-items:center;justify-content:center}
  .ink{background:#14110e}.paper{background:#f6f2ec}
  .cap{color:#8d877f;font-size:12px;text-align:center;margin-top:8px}
  .sw{display:flex;align-items:center;gap:12px;min-width:210px}
  .chip{width:52px;height:52px;border-radius:12px;border:1px solid #ffffff1a;flex:none}
  .sw-t b{display:block;font-size:13px}.sw-t code{font-size:12px;color:#f0a868}.sw-t span{display:block;font-size:11px;color:#8d877f;margin-top:2px}
  table{border-collapse:collapse;font-size:12.5px;margin-top:8px}
  td,th{border-bottom:1px solid #262220;padding:6px 16px 6px 0;text-align:left}
  th{color:#f0a868;font-weight:600}
  pre{background:#14110e;border:1px solid #262220;border-radius:10px;padding:14px 16px;overflow:auto;font-size:12px;line-height:1.15;color:#f0a868}
  .lockup{display:flex;align-items:center;gap:16px}
  .rules{color:#b8b1a8;font-size:13px;line-height:1.9}
  .rules b{color:#e8e4de}
  .badge{display:inline-block;border:1px solid #3a332d;border-radius:999px;padding:2px 10px;font-size:11px;color:#9c958c;margin-right:6px}
</style></head><body>
<h1>Khy OS 品牌预览 · 内核环</h1>
<p class="lead">
  形态语义：四段弧叶 = 四条主张（订阅套利 / 随身性 / 本土化 / 私有与便携）；中心菱形 = 内核（kernel / runtime）；
  内核上刻一道 K 形负槽 = 品牌字母（可发现，但不主导读感）。
  配色：墨黑 + 琥珀橙 —— 刻意避开 2023 年后 AI 产品的「蓝→紫→品红」通用渐变。
  几何真源：<code>delivery/brand/khy-brand-geometry.js</code>，本图与全部产物由
  <code>node scripts/brand/build-brand-assets.js</code> 生成。
</p>

<h2>01 · 主标（墨底 / 纸底）</h2>
<div class="grid">
  <div><div class="tile ink" style="width:150px;height:150px">${markSvgStr}</div><div class="cap">墨底 · 琥珀渐变</div></div>
  <div><div class="tile paper" style="width:150px;height:150px">${markSvgStr}</div><div class="cap">纸底 · 琥珀渐变</div></div>
  <div><div class="tile" style="width:150px;height:150px;background:#14110e">${monoPaperSvg}</div><div class="cap">墨底 · 纸白单色</div></div>
</div>

<h2>02 · 应用图标（各尺寸，真实像素）</h2>
<div class="grid">
${[512, 128, 64, 48, 32, 16]
  .map(
    (s) =>
      `<div><div class="tile" style="width:${Math.min(s, 128)}px;height:${Math.min(s, 128)}px;background:transparent">` +
      `<img src="png/khy-os-icon-${s}.png" width="${Math.min(s, 128)}" height="${Math.min(s, 128)}" alt=""></div>` +
      `<div class="cap">${s}px</div></div>`
  )
  .join('\n')}
</div>

<h2>03 · favicon（16 / 32，紧凑几何）</h2>
<div class="grid">
${[32, 16]
  .map(
    (s) =>
      `<div><div class="tile" style="width:64px;height:64px;background:#14110e">` +
      `<img src="png/khy-os-favicon-${s}.png" width="${s}" height="${s}" alt=""></div><div class="cap">${s}px</div></div>`
  )
  .join('\n')}
</div>

<h2>04 · 锁定组合（标 + 字标）</h2>
<div class="grid">
  <div><div class="tile paper" style="width:420px;height:150px"><img src="svg/khy-os-lockup.svg" width="360" alt=""></div><div class="cap">彩色版（字标为墨黑，用于浅底）</div></div>
  <div><div class="tile ink" style="width:420px;height:150px"><img src="svg/khy-os-lockup-mono-paper.svg" width="360" alt=""></div><div class="cap">单色纸白版（用于深底与单色印刷）</div></div>
</div>

<h2>05 · TUI 终端内的点阵标记</h2>
<div class="grid"><pre>${pixelArt}</pre></div>

<h2>06 · 调色板与文本安全值</h2>
<div class="grid">
${swatch('amber-300', p.amber300, '图形渐变亮端')}
${swatch('amber-400', p.amber400, '暗底上的文本安全值（对 #14110E 9.41:1）')}
${swatch('amber-500', p.amber500, '图形主色 / 渐变暗端')}
${swatch('amber-600', p.amber600, '浅底上的 UI 强调（对白底 4.55:1）')}
${swatch('amber-700', p.amber700, '浅底上的文本安全值（对白底 6.60:1）')}
${swatch('ink', p.ink, '品牌底板 / 负形')}
${swatch('paper', p.paper, '纸底')}
</div>
<table>
  <tr><th>端</th><th>accent（亮）</th><th>accent（暗）</th><th>说明</th></tr>
  <tr><td>Web</td><td>${tokens.color.accent.value}</td><td>${tokens.color.accent.valueDark}</td><td>--khy-primary</td></tr>
  <tr><td>桌面端</td><td>${tokens.color.accent.value}</td><td>${tokens.color.accent.valueDark}</td><td>--color-brand</td></tr>
  <tr><td>移动端</td><td>—</td><td>${tokens.color.accent.valueDark}</td><td>AppColors.primary（深空底）</td></tr>
  <tr><td>TUI</td><td>—</td><td>${tokens.color.accent.valueDark}</td><td>ccTheme brand</td></tr>
  <tr><td>khyquant</td><td colspan="2">#1890ff（保持金融蓝）</td><td>独立项目，红色/绿色另有 A 股涨跌语义</td></tr>
</table>

<h2>07 · 使用禁区</h2>
<div class="rules">
  <p><span class="badge">禁止</span>不要把主标改成蓝紫品红渐变 —— 那是 AI 行业的通用色，一屏之下全是同一个模子。</p>
  <p><span class="badge">禁止</span>不要给主标加描边、投影或外发光；它在 16px 下必须仍然读得出「四段环 + 中心核」。</p>
  <p><span class="badge">禁止</span>不要把 K 槽单独拿出来当字标用 —— 它是<b>负形的一部分</b>，脱离内核就不再是这枚标记。</p>
  <p><span class="badge">禁止</span>不要在纸底上直接用 amber-300/400（对比度 1.4–2.0，不达文字门槛）。</p>
  <p><span class="badge">必须</span>品牌块底色统一用墨黑 <code>${p.ink}</code>；主标在墨底与纸底都用同一枚琥珀渐变。</p>
  <p><span class="badge">必须</span>≥48px 用完整几何（含 K 槽）；≤32px 用紧凑几何（实心内核、无 K 槽）。</p>
</div>
</body></html>`;
}

/**
 * 申请图样页：把「图形商标」「文字商标」「组合图样」三件按递交惯例排在白底上，
 * 附变形禁止项与检索/类别提示。人可直接把它连同 `svg/` 母版一起归档。
 */
function filingHtml({ markSvgStr, wordmarkSvgStr, lockupSvgStr }) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Khy OS 商标申请图样</title>
<style>
  body{margin:0;background:#fff;color:#111;font-family:"Microsoft YaHei","Segoe UI",system-ui,sans-serif;padding:36px 44px 60px}
  h1{font-size:22px;margin:0 0 4px}
  .lead{color:#555;font-size:13px;max-width:860px;line-height:1.8;margin:0 0 28px}
  h2{font-size:15px;margin:30px 0 12px;padding-bottom:6px;border-bottom:1px solid #ddd}
  .sheet{border:1px solid #ccc;background:#fff;display:inline-flex;align-items:center;justify-content:center;padding:34px 44px;margin:0 0 10px}
  .cap{font-size:12px;color:#666;margin:0 0 22px}
  table{border-collapse:collapse;font-size:12.5px;margin-top:6px}
  td,th{border:1px solid #ddd;padding:7px 14px;text-align:left}
  th{background:#f6f6f4;width:170px;font-weight:600}
  ol,ul{font-size:13px;line-height:1.9;color:#333;padding-left:22px}
</style></head><body>
<h1>Khy OS 商标申请图样</h1>
<p class="lead">
  三件图样<strong>分开递交</strong>：图形商标覆盖「字母变体」，文字商标覆盖「拼写保护」，组合图样作为整体保护。
  三张图样均为<strong>纯矢量、已轮廓化</strong>（字标不含 <code>&lt;text&gt;</code>，不依赖任何字体），
  黑白色、不含渐变与底板，符合中国商标局对图样「清晰、黑白、可重复印制」的要求。
  彩色版见 <code>svg/khy-kernel-mark.svg</code> 与 <code>svg/khy-os-lockup.svg</code>（用于实际使用，不作递交图样）。
</p>

<h2>一、图形商标（内核环）</h2>
<div class="sheet">${markSvgStr}</div>
<p class="cap">建议提交尺寸：长宽 30–60mm（按实际使用比例调整）。四周留白不小于图样最大笔画宽度的 1/4。</p>

<h2>二、文字商标「khy OS」</h2>
<div class="sheet">${wordmarkSvgStr}</div>
<p class="cap">已轮廓化：字形取自系统无衬线粗体的 glyf 轮廓，递交后不会因缺字体走样。</p>

<h2>三、组合图样（图形 + 文字）</h2>
<div class="sheet">${lockupSvgStr}</div>
<p class="cap">组合图样的保护范围最窄（改了字或改了形都可能被驳回），实务上通常与前两件<strong>分别申请</strong>。</p>

<h2>四、递交前须知</h2>
<table>
  <tr><th>近似检索</th><td>图形商标需做<strong>图形近似检索</strong>（按维也纳编码）：中国商标网 <code>sbj.cnipa.gov.cn</code> 的「图形查询」；第三方可查阿里云商标检索 <code>tm.aliyun.com</code>、标库网 <code>tmkoo.com</code>。官方数据有 3–6 个月盲期，检索结论仅供参考。</td></tr>
  <tr><th>建议类别</th><td>第 9 类（可下载软件 / 应用软件）、第 42 类（SaaS / 平台服务）、第 35 类（销售服务）为产品主战场；若扩展到硬件或周边，再议第 14 / 16 类。</td></tr>
  <tr><th>申请拆分</th><td>图形与文字<strong>分别申请</strong>，各自独立走流程、独立占位。</td></tr>
  <tr><th>黑白图样</th><td>递交用图样必须是黑白的；本包彩色版仅供实际使用。</td></tr>
  <tr><th>禁止变形</th><td>不得拉伸变形、不得改变主标与字标的比例关系、不得给主标加描边/投影/外发光、不得把中心内核上的 K 负槽单独取出来当字标用。</td></tr>
</table>

<h2>五、这一版解决了什么（设计变更记录）</h2>
<ul>
  <li>旧标记是「一个字母 K」：Web 排版 K、APK 排版 <code>Text('K')</code>、桌面端一个 ico、TUI 另有一枚像素四叶草 —— 同一产品四种品牌样子。</li>
  <li>新标记「内核环」= 四段弧叶（四条主张）+ 中心菱形（内核）+ 内核上的 K 负槽（品牌字母，可发现但不主导读感）。</li>
  <li>配色由「蓝→紫→品红渐变」换成墨黑 + 琥珀橙 —— 前者是 2023 年后 AI 产品的通用色系。</li>
</ul>
</body></html>`;
}

function main() {
  const written = [];

  // ── 1. 矢量母版 ──
  const svgs = {
    'khy-kernel-mark.svg': markSvg({ mode: 'color' }),
    'khy-kernel-mark-mono-ink.svg': markSvg({ mode: 'ink' }),
    'khy-kernel-mark-mono-paper.svg': markSvg({ mode: 'paper' }),
    'khy-os-lockup.svg': lockupSvg({ mode: 'color' }),
    'khy-os-lockup-mono-ink.svg': lockupSvg({ mode: 'ink' }),
    'khy-os-lockup-mono-paper.svg': lockupSvg({ mode: 'paper' }),
    'khy-os-wordmark-outlined.svg': wordmarkSvg({ mode: 'ink', size: 64 }),
    'khy-os-wordmark-outlined-paper.svg': wordmarkSvg({ mode: 'paper', size: 64 }),
    'khy-os-filing-mark.svg': filingMarkSvg({ size: 64 }),
    'khy-os-app-icon.svg': appIconSvg({ size: 512 }),
    'khy-os-app-icon-maskable.svg': appIconSvg({ size: 512, bleed: true, markRatio: 0.5 }),
    'khy-os-favicon.svg': faviconMarkSvg({ size: 32 }),
  };
  for (const [name, content] of Object.entries(svgs)) {
    written.push(write(path.join('delivery/brand/svg', name), content));
  }

  // ── 2. 五端令牌取值 ──
  const tokens = {
    $meta: {
      name: 'Khy OS 品牌令牌（五端同步取值）',
      source: 'delivery/brand/khy-brand-geometry.js（几何与配色单一真源）',
      updated: '2026-10-25',
      note:
        'accent = 品牌强调主色。亮暗两端各取一个文本安全值；' +
        'ink/paper 为负形与底板色。五端真源文件各自引用本表的语义名。',
    },
    color: {
      accent: { value: PALETTE.amber700, valueDark: PALETTE.amber400 },
      accentStrong: { value: PALETTE.amber700, valueDark: PALETTE.amber300 },
      brand: { value: PALETTE.amber700, valueDark: PALETTE.amber400 },
      brandGraphic: { value: PALETTE.amber500, valueDark: PALETTE.amber500 },
      ink: { value: PALETTE.ink, valueDark: PALETTE.ink },
      paper: { value: PALETTE.paper, valueDark: PALETTE.paper },
    },
    graphic: {
      gradient: [PALETTE.amber300, PALETTE.amber500],
      tileRadiusRatio: 0.225,
      markRatioInTile: 0.7,
      compact: {
        ringGapDeg: COMPACT_GEOMETRY.ringGapDeg,
        ringSlantDeg: COMPACT_GEOMETRY.ringSlantDeg,
        coreHalf: COMPACT_GEOMETRY.coreHalf,
        note: '≤32px 场景（favicon / 角标）用的紧凑几何：实心内核，无 K 槽',
      },
    },
  };
  written.push(
    write('delivery/brand/khy-brand-tokens.json', JSON.stringify(tokens, null, 2) + '\n')
  );

  if (SVG_ONLY) {
    process.stdout.write(`SVG-only 完成：${written.length} 个矢量母版\n`);
    return;
  }

  // ── 3. 一张图集渲染全部位图 ──
  const iconSizes = [512, 256, 128, 64, 48, 32, 24, 16];
  const markSizes = [512, 256, 128, 64, 48, 32, 16];
  const faviconSizes = [32, 16];
  const mipmaps = [
    ['mipmap-mdpi', 48],
    ['mipmap-hdpi', 72],
    ['mipmap-xhdpi', 96],
    ['mipmap-xxhdpi', 144],
    ['mipmap-xxxhdpi', 192],
  ];

  const items = [];
  for (const s of iconSizes) items.push({ key: `icon-${s}`, svg: appIconSvg({ size: s }), size: s });
  for (const s of markSizes) items.push({ key: `mark-${s}`, svg: markSvg({ mode: 'color', size: s }), size: s });
  for (const s of faviconSizes)
    items.push({ key: `favicon-${s}`, svg: faviconMarkSvg({ size: s }), size: s });
  for (const [, s] of mipmaps) {
    items.push({ key: `mip-${s}`, svg: appIconSvg({ size: s }), size: s });
    items.push({
      key: `mipfg-${s}`,
      svg: appIconSvg({ size: s, bleed: true, markRatio: 0.5, transparentBg: true }),
      size: s,
    });
  }

  const pngs = renderSheet(items);

  const pngOut = new Map();
  for (const s of iconSizes) {
    const rel = path.join('delivery/brand/png', `khy-os-icon-${s}.png`);
    pngOut.set(rel, writeBuf(rel, pngs.get(`icon-${s}`)));
  }
  for (const s of markSizes) {
    const rel = path.join('delivery/brand/png', `khy-os-mark-${s}.png`);
    pngOut.set(rel, writeBuf(rel, pngs.get(`mark-${s}`)));
  }
  for (const s of faviconSizes) {
    const rel = path.join('delivery/brand/png', `khy-os-favicon-${s}.png`);
    pngOut.set(rel, writeBuf(rel, pngs.get(`favicon-${s}`)));
  }
  written.push(...pngOut.values());

  // ── 4. ICO（桌面端 / Windows）──
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoRel = path.join('delivery/brand/icon', 'khy-os.ico');
  buildIco(
    icoSizes.map((s) => pngs.get(`icon-${s}`)),
    path.join(REPO, icoRel)
  );
  written.push(path.join(REPO, icoRel));

  // ── 5. 落地各端 ──
  // Web
  written.push(
    copy('delivery/brand/svg/khy-os-favicon.svg', 'delivery/web/ai-frontend/public/favicon.svg')
  );
  written.push(
    copy(
      'delivery/brand/svg/khy-kernel-mark.svg',
      'delivery/web/ai-frontend/public/brand/khy-kernel-mark.svg'
    )
  );
  for (const s of faviconSizes) {
    written.push(
      copy(
        path.join('delivery/brand/png', `khy-os-favicon-${s}.png`),
        `delivery/web/ai-frontend/public/favicon-${s}.png`
      )
    );
  }
  written.push(
    copy('delivery/brand/png/khy-os-icon-128.png', 'delivery/web/ai-frontend/public/apple-touch-icon.png')
  );

  // 桌面端
  written.push(copy(icoRel, 'apps/khyos-desktop/resources/icon/icon.ico'));
  written.push(copy(icoRel, 'apps/khyos-desktop/public/icon.ico'));
  written.push(copy(icoRel, 'apps/khyos-desktop/launcher/khyos.ico'));

  // Android 启动图标
  const resBase = 'delivery/mobile/khy-os-client-app/android/app/src/main/res';
  for (const [dir, size] of mipmaps) {
    written.push(
      writeBuf(path.join(resBase, dir, 'ic_launcher.png'), pngs.get(`mip-${size}`))
    );
    written.push(
      writeBuf(path.join(resBase, dir, 'ic_launcher_foreground.png'), pngs.get(`mipfg-${size}`))
    );
  }

  // Flutter 客户端的资源（应用内品牌块用）
  written.push(
    writeBuf(
      'delivery/mobile/khy-os-client-app/assets/brand/khy-os-mark-256.png',
      pngs.get('mark-256')
    )
  );
  written.push(
    writeBuf(
      'delivery/mobile/khy-os-client-app/assets/brand/khy-os-mark-64.png',
      pngs.get('mark-64')
    )
  );

  // ── 6. TUI 像素标记 ──
  // 裁到主标外接框再落格（否则 128 画布里只有中间 76 见方有内容，分辨率被白白浪费）。
  // 主标是正方形，网格取正方形以免被拉伸。
  const { art, shades } = renderPixelArt(
    markSvg({ mode: 'color', size: 256, viewBox: MARK_BBOX }),
    13,
    13
  );
  const artLines = art.map((l) => '  ' + JSON.stringify(l)).join(',\n');
  const shadeLines = shades.map((l) => '  ' + JSON.stringify(l)).join(',\n');
  const pixelModule =
    `'use strict';\n\n` +
    `// GENERATED FILE —— 由 scripts/brand/build-brand-assets.js 生成，请勿手改。\n` +
    `// 源：delivery/brand/khy-brand-geometry.js（几何单一真源）。\n` +
    `// 用途：TUI 终端里的品牌标记（字符点阵 + 三档明暗）。\n` +
    `// 网格：${art[0].length} 列 × ${art.length} 行。\n\n` +
    `const MARK_ART = [\n${artLines},\n];\n\n` +
    `const MARK_SHADE = [\n${shadeLines},\n];\n\n` +
    `const MARK_COLS = ${art[0].length};\n` +
    `const MARK_ROWS = ${art.length};\n\n` +
    `module.exports = { MARK_ART, MARK_SHADE, MARK_COLS, MARK_ROWS };\n`;
  written.push(write('runtime/node/backend/src/cli/tui/brandPixelArt.js', pixelModule));

  // ── 7. 预览页 ──
  const preview = previewHtml({
    markSvgStr: markSvg({ mode: 'color', size: 140 }),
    monoPaperSvg: markSvg({ mode: 'paper', size: 140 }),
    pixelArt: art.join('\n'),
    tokens,
  });
  written.push(write('delivery/brand/preview.html', preview));

  // ── 8. 申请图样页 ──
  const filing = filingHtml({
    markSvgStr: filingMarkSvg({ size: 96 }),
    wordmarkSvgStr: wordmarkSvg({ mode: 'ink', size: 56 }),
    lockupSvgStr: lockupSvg({ mode: 'ink' }),
  });
  written.push(write('delivery/brand/filing.html', filing));

  // ── 9. 桌宠素材分发 ──
  // 桌宠美术带真商标（由 scripts/brand/build-pet-assets.ps1 把品牌几何真源压进空白金盘），
  // 三端各取一份：网页 public、桌面 renderer 资源、Flutter assets。
  const petSrcDir = 'delivery/brand/pet';
  const petTargets = [
    'delivery/web/ai-frontend/public/brand/pet',
    'apps/khyos-desktop/src/renderer/assets/pet',
    'delivery/mobile/khy-os-client-app/assets/brand/pet',
  ];
  const petFiles = fs
    .readdirSync(path.join(REPO, petSrcDir))
    .filter((f) => f.endsWith('.png') || f.endsWith('.json') || f.endsWith('.glb'))
    .sort();
  for (const f of petFiles) {
    for (const target of petTargets) {
      written.push(copy(path.join(petSrcDir, f), path.join(target, f)));
    }
  }
  // models/ 子目录：3D 模型（GLB）与转盘序列，**递归**分发。
  //
  // 为什么递归：写实真人模型（khy-pet-*-realistic.glb）也落在这个目录里，
  // 只扫顶层的话整个 models/ 永远漏发——之前的 Q 版模型就是手工拷的，
  // 脚本管不到，加新模型时必漏。
  //
  // 为什么只发桌面端：桌面端是**唯一真正渲染 3D 的端**（原生 WebGL 加载 GLB）。
  // 网页端只用 PNG 立绘（KhyPet.vue 走 /brand/pet/*.png），手机端还没有 GLB
  // 查看器（README 待办第 10 条）。真人 GLB 单个可能 5–10MB，发给装不了 3D
  // 的端只是白涨包体（手机端的 assets/brand/ 会整个打进 APK）。
  const petModelsDir = path.join(petSrcDir, 'models');
  if (fs.existsSync(path.join(REPO, petModelsDir))) {
    const modelFiles = [];
    (function walkModels(rel) {
      for (const entry of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
        const childRel = path.join(rel, entry.name);
        if (entry.isDirectory()) walkModels(childRel);
        else if (/\.(png|json|glb)$/.test(entry.name)) modelFiles.push(childRel);
      }
    })(petModelsDir);
    modelFiles.sort();
    for (const f of modelFiles) {
      written.push(
        copy(f, path.join('apps/khyos-desktop/src/renderer/assets/pet', path.relative(petSrcDir, f)))
      );
    }
  }
  // 网页端还要一份可被 Vite import 的 JSON（public/ 下的静态文件不能当模块 import）。
  written.push(
    copy(
      path.join(petSrcDir, 'pet-fortune.json'),
      'delivery/web/ai-frontend/src/data/pet-fortune.json'
    )
  );

  // 临时渲染目录清理
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 无所谓 */
  }

  process.stdout.write(`品牌资产构建完成：${written.length} 个文件\n`);
}

if (require.main === module) main();

module.exports = {
  markSvg,
  appIconSvg,
  faviconMarkSvg,
  lockupSvg,
  renderPixelArt,
  renderSheet,
  MARK_BBOX,
  COMPACT_GEOMETRY,
};
