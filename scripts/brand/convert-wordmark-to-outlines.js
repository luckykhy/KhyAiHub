#!/usr/bin/env node
'use strict';

/**
 * convert-wordmark-to-outlines — 把字标「khy OS」从 `<text>` 转成**矢量轮廓**。
 *
 * 为什么必须转：商标递交的图样要能独立于任何字体环境复现。
 * 锁定组合 SVG 里若写 `<text font-family="Segoe UI,…">`，一旦递交方机器上没有这字体，
 * 字标就会走样（换字体/缺字/方框）。轮廓化之后，SVG 里只剩路径 —— 任何机器打开都一样。
 *
 * 做法：解析本机 TrueType 字体（glyf 表）取字形轮廓 → 转成 SVG 的二次贝塞尔路径。
 * 不用第三方库：TTF 的 cmap/loca/glyf 三张表足够，解析量也就两百行；
 * 且本仓不允许为一个「出图」动作引入 npm 依赖。
 *
 * 产出：`delivery/brand/khy-brand-wordmark.js`（生成物）——
 *   路径数据（已归一化到 1000 单位字高）+ 各字形的推进宽度。
 *   `scripts/brand/build-brand-assets.js` 读它拼装锁定组合，于是锁定组合里不再有 `<text>`。
 *
 * 用法：node scripts/brand/convert-wordmark-to-outlines.js [--font <ttf 路径>] [--text "khy OS"]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..', '..');
const OUT_REL = path.join('delivery', 'brand', 'khy-brand-wordmark.js');

/** 归一化字高：轮廓按 1000 单位输出，锁定组合按需要缩放。 */
const UNITS = 1000;

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

// ── TrueType 解析 ──────────────────────────────────────────────────────────

class Ttf {
  constructor(buf) {
    this.buf = buf;
    this.tables = {};
    const numTables = buf.readUInt16BE(4);
    for (let i = 0; i < numTables; i++) {
      const o = 12 + i * 16;
      const tag = buf.toString('ascii', o, o + 4);
      this.tables[tag] = { offset: buf.readUInt32BE(o + 8), length: buf.readUInt32BE(o + 12) };
    }
    if (!this.tables.head || !this.tables.glyf || !this.tables.loca || !this.tables.cmap) {
      fail('字体缺少 head/glyf/loca/cmap 表 —— 这不是可解析的 TrueType 字体。');
    }
    const head = this.tables.head.offset;
    this.unitsPerEm = buf.readUInt16BE(head + 18);
    this.indexToLocFormat = buf.readInt16BE(head + 50);
    const maxp = this.tables.maxp.offset;
    this.numGlyphs = buf.readUInt16BE(maxp + 4);
    const hhea = this.tables.hhea.offset;
    this.numberOfHMetrics = buf.readUInt16BE(hhea + 34);
    this.ascender = buf.readInt16BE(hhea + 4);
    this.descender = buf.readInt16BE(hhea + 6);
    this.cmap = this.parseCmap();
    this.loca = this.parseLoca();
  }

  table(tag) {
    const t = this.tables[tag];
    if (!t) fail(`字体缺少 ${tag} 表`);
    return t;
  }

  /** 取 (3,1) 或 (3,10) 或 (0,x) 的 Unicode cmap 子表 → char → glyphId */
  parseCmap() {
    const b = this.buf;
    const base = this.table('cmap').offset;
    const n = b.readUInt16BE(base + 2);
    let best = null;
    for (let i = 0; i < n; i++) {
      const rec = base + 4 + i * 8;
      const platformId = b.readUInt16BE(rec);
      const encodingId = b.readUInt16BE(rec + 2);
      const offset = b.readUInt32BE(rec + 4);
      const score =
        platformId === 3 && encodingId === 1 ? 4 : platformId === 3 && encodingId === 10 ? 3 : platformId === 0 ? 2 : 0;
      if (score && (!best || score > best.score)) best = { offset: base + offset, score };
    }
    if (!best) fail('字体没有可用的 Unicode cmap 子表');
    const off = best.offset;
    const format = b.readUInt16BE(off);
    const map = new Map();
    if (format === 4) {
      const segX2 = b.readUInt16BE(off + 6);
      const seg = segX2 / 2;
      const endO = off + 14;
      const startO = endO + segX2 + 2;
      const deltaO = startO + segX2;
      const rangeO = deltaO + segX2;
      for (let s = 0; s < seg; s++) {
        const end = b.readUInt16BE(endO + s * 2);
        const start = b.readUInt16BE(startO + s * 2);
        const delta = b.readInt16BE(deltaO + s * 2);
        const rangeOffset = b.readUInt16BE(rangeO + s * 2);
        if (start === 0xffff) continue;
        for (let c = start; c <= end && c !== 0x10000; c++) {
          let gid;
          if (rangeOffset === 0) {
            gid = (c + delta) & 0xffff;
          } else {
            const idx = rangeO + s * 2 + rangeOffset + (c - start) * 2;
            if (idx + 1 >= b.length) continue;
            gid = b.readUInt16BE(idx);
            if (gid !== 0) gid = (gid + delta) & 0xffff;
          }
          if (gid) map.set(c, gid);
        }
      }
    } else if (format === 12) {
      const nGroups = b.readUInt32BE(off + 12);
      for (let g = 0; g < nGroups; g++) {
        const o = off + 16 + g * 12;
        const start = b.readUInt32BE(o);
        const end = b.readUInt32BE(o + 4);
        const startGid = b.readUInt32BE(o + 8);
        for (let c = start; c <= end; c++) map.set(c, startGid + (c - start));
      }
    } else {
      fail(`不支持的 cmap 格式 ${format}（只支持 4 与 12）`);
    }
    return map;
  }

  parseLoca() {
    const b = this.buf;
    const base = this.table('loca').offset;
    const out = new Array(this.numGlyphs + 1);
    for (let i = 0; i <= this.numGlyphs; i++) {
      out[i] =
        this.indexToLocFormat === 0 ? b.readUInt16BE(base + i * 2) * 2 : b.readUInt32BE(base + i * 4);
    }
    return out;
  }

  advanceWidth(gid) {
    const b = this.buf;
    const base = this.table('hmtx').offset;
    const i = Math.min(gid, this.numberOfHMetrics - 1);
    return b.readUInt16BE(base + i * 4);
  }

  /** 取字形轮廓点（简单字形；复合字形直接失败而不是画错）。 */
  glyphPoints(gid) {
    const b = this.buf;
    const glyfBase = this.table('glyf').offset;
    const start = glyfBase + this.loca[gid];
    const end = glyfBase + this.loca[gid + 1];
    if (end <= start) return [];
    const numContours = b.readInt16BE(start);
    if (numContours < 0) fail(`字形 ${gid} 是复合字形，本脚本只处理简单字形。`);
    const endPts = [];
    for (let i = 0; i < numContours; i++) endPts.push(b.readUInt16BE(start + 10 + i * 2));
    const numPoints = endPts[numContours - 1] + 1;
    let o = start + 10 + numContours * 2;
    const instructionLength = b.readUInt16BE(o);
    o += 2 + instructionLength;

    const flags = [];
    while (flags.length < numPoints) {
      const fl = b.readUInt8(o++);
      flags.push(fl);
      if (fl & 0x08) {
        let repeat = b.readUInt8(o++);
        while (repeat-- > 0) flags.push(fl);
      }
    }
    const xs = [];
    let x = 0;
    for (let i = 0; i < numPoints; i++) {
      const fl = flags[i];
      if (fl & 0x02) {
        const d = b.readUInt8(o++);
        x += fl & 0x10 ? d : -d;
      } else if (!(fl & 0x10)) {
        x += b.readInt16BE(o);
        o += 2;
      }
      xs.push(x);
    }
    const ys = [];
    let y = 0;
    for (let i = 0; i < numPoints; i++) {
      const fl = flags[i];
      if (fl & 0x04) {
        const d = b.readUInt8(o++);
        y += fl & 0x20 ? d : -d;
      } else if (!(fl & 0x20)) {
        y += b.readInt16BE(o);
        o += 2;
      }
      ys.push(y);
    }
    const contours = [];
    let p = 0;
    for (let c = 0; c < numContours; c++) {
      const pts = [];
      for (let i = p; i <= endPts[c]; i++) {
        pts.push({ x: xs[i], y: ys[i], on: (flags[i] & 0x01) !== 0 });
      }
      contours.push(pts);
      p = endPts[c] + 1;
    }
    return contours;
  }
}

/** 一条轮廓 → SVG 路径片段（TrueType 二次曲线 → SVG Q）。 */
function contourToPath(contour, scale, dx) {
  const P = (p) => `${f(dx + p.x * scale)} ${f(-p.y * scale)}`;
  const n = contour.length;
  if (!n) return '';
  let start;
  let rest;
  if (contour[0].on) {
    start = contour[0];
    rest = contour.slice(1);
  } else if (contour[n - 1].on) {
    start = contour[n - 1];
    rest = contour.slice(0, n - 1);
  } else {
    const a = contour[n - 1];
    const b = contour[0];
    start = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true };
    rest = contour.slice();
  }
  let d = `M ${P(start)}`;
  let ctrl = null;
  for (const p of rest) {
    if (p.on) {
      if (ctrl) {
        d += ` Q ${P(ctrl)} ${P(p)}`;
        ctrl = null;
      } else {
        d += ` L ${P(p)}`;
      }
    } else {
      if (ctrl) {
        const mid = { x: (ctrl.x + p.x) / 2, y: (ctrl.y + p.y) / 2 };
        d += ` Q ${P(ctrl)} ${P(mid)}`;
      }
      ctrl = p;
    }
  }
  if (ctrl) d += ` Q ${P(ctrl)} ${P(start)}`;
  return d + ' Z';
}

function f(n) {
  return Number(n.toFixed(2));
}

// ── 字体定位 ───────────────────────────────────────────────────────────────

function findFont(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) fail(`指定的字体不存在：${explicit}`);
    return explicit;
  }
  const roots = [
    // Windows 字体目录从 WINDIR 推出来，不写死 'C:\Windows\Fonts'。
    // 那条字面量在每台 Windows 上都成立，但它是机器级路径——守卫 Rule 1c
    // 判的就是「把机器路径钉进源码」，而 WINDIR 才是它的正规来源。
    process.env.WINDIR ? path.join(process.env.WINDIR, 'Fonts') : null,
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts'),
  ].filter(Boolean);
  // 优先 Segoe UI Bold（与锁定组合里 font-weight:700 的指定一致）。
  const preferred = ['segoeuib.ttf', 'arialbd.ttf', 'msyhbd.ttc', 'segoeui.ttf'];
  for (const r of roots) {
    for (const name of preferred) {
      const p = path.join(r, name);
      if (fs.existsSync(p)) return p;
    }
  }
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const hits = fs.readdirSync(r).filter((f2) => /^(segoeuib|arialbd|msyhbd)\.ttf$/i.test(f2));
    if (hits.length) return path.join(r, hits[0]);
  }
  fail('找不到可用的粗体 TrueType 字体（segoeuib.ttf / arialbd.ttf）。可用 --font 指定路径。');
}

function main() {
  const argv = process.argv.slice(2);
  const fontArg = argv.includes('--font') ? argv[argv.indexOf('--font') + 1] : null;
  const text = argv.includes('--text') ? argv[argv.indexOf('--text') + 1] : 'khy OS';
  const tracking = argv.includes('--tracking') ? Number(argv[argv.indexOf('--tracking') + 1]) : -6;

  const fontPath = findFont(fontArg);
  const ttf = new Ttf(fs.readFileSync(fontPath));
  const scale = UNITS / ttf.unitsPerEm;

  const paths = [];
  const advances = [];
  let cursor = 0;
  let yMin = 0;
  let yMax = 0;
  for (const ch of text) {
    const gid = ttf.cmap.get(ch.codePointAt(0));
    if (!gid) fail(`字体里没有字符「${ch}」（U+${ch.codePointAt(0).toString(16).toUpperCase()}）`);
    const contours = ttf.glyphPoints(gid);
    const d = contours.map((c) => contourToPath(c, scale, cursor)).join(' ');
    if (d) paths.push(d);
    for (const c of contours) {
      for (const p of c) {
        const y = -p.y * scale;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
    const adv = ttf.advanceWidth(gid) * scale;
    advances.push(f(adv));
    cursor += adv + tracking;
  }
  const totalWidth = f(cursor - tracking);

  const module = `'use strict';\n\n` +
    `// GENERATED FILE —— 由 scripts/brand/convert-wordmark-to-outlines.js 生成，请勿手改。\n` +
    `// 源字体：${path.basename(fontPath)}（本机系统字体，仅取字形轮廓作为图形数据）。\n` +
    `// 用途：字标「${text}」的**矢量轮廓** —— 商标递交图样必须脱离字体环境复现，\n` +
    `//       <text> 做不到这一点（换机器缺字体就走样）。\n` +
    `// 坐标系：字高归一化到 ${UNITS}，**基线在 y=0**，y 向上为负（字形坐标直接翻转到 SVG 惯例）。\n` +
    `//       ⇒ 摆放时用「基线对齐」：<g transform="translate(x, baselineY) scale(s)">。\n\n` +
    `const WORDMARK_TEXT = ${JSON.stringify(text)};\n` +
    `const WORDMARK_PATHS = [\n${paths.map((d) => '  ' + JSON.stringify(d)).join(',\n')},\n];\n` +
    `const WORDMARK_WIDTH = ${totalWidth};\n` +
    `/** 最高点（负数，向上为负）与最低点（正数，向下为正），相对基线。 */\n` +
    `const WORDMARK_ASCENDER = ${f(yMin)};\n` +
    `const WORDMARK_DESCENDER = ${f(yMax)};\n` +
    `const WORDMARK_EM = ${UNITS};\n` +
    `const WORDMARK_TRACKING = ${tracking};\n\n` +
    `module.exports = { WORDMARK_TEXT, WORDMARK_PATHS, WORDMARK_WIDTH, WORDMARK_ASCENDER, WORDMARK_DESCENDER, WORDMARK_EM, WORDMARK_TRACKING };\n`;

  const abs = path.join(REPO, OUT_REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, module, 'utf8');
  process.stdout.write(
    `字标轮廓已生成：${OUT_REL}（${paths.length} 条路径，总宽 ${totalWidth}，字高 ${UNITS}）\n`
  );
}

main();
