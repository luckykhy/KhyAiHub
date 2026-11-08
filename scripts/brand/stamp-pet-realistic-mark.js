#!/usr/bin/env node
/**
 * Stamp the REAL brand trademark into the blank gold plates of the realistic
 * character base art (image-to-3D input).
 *
 * WHY THIS EXISTS
 * ---------------
 * The base art for the "realistic" pet form is AI generated. The prompt
 * deliberately asks for a BLANK gold plate (no symbol, no mark) because an
 * AI model must never draw an approximation of the Khy OS trademark: the
 * trademark pixels must come from delivery/brand/png/khy-os-mark-256.png,
 * byte for byte, or they are not the trademark at all.
 *
 * This script is the second half of that contract: it composites the real
 * mark into the blank plate. Same treatment as scripts/brand/build-pet-assets.ps1
 * does for the 2D art (ink silhouette + warm emboss shadow), just reimplemented
 * in Node with pngjs so it can run without PowerShell's System.Drawing.
 *
 * The mark is rendered as an INK SILHOUETTE (dark #14110E) rather than the
 * amber brand fill: on a gold plate the amber-on-gold contrast is far too low
 * to read, and the engraved-seal look matches the existing 2D pet art.
 *
 * Usage:
 *   node scripts/brand/stamp-pet-realistic-mark.js
 *   node scripts/brand/stamp-pet-realistic-mark.js --dry-run
 *
 * Plate geometry (blank gold rectangles/circles) is located by colour
 * segmentation, not by hardcoded coordinates, so re-running against a
 * freshly generated base art still lands the mark in the right place.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require(path.join(__dirname, '..', '..', 'node_modules', 'pngjs'));

const REPO = path.resolve(__dirname, '..', '..');
const INBOX = path.join(REPO, 'works', 'design', 'khy-mascot', 'model', 'inbox');
const MARK = path.join(REPO, 'delivery', 'brand', 'png', 'khy-os-mark-256.png');
const DRY_RUN = process.argv.includes('--dry-run');

/** Ink colour of the engraved seal (matches build-pet-assets.ps1). */
const INK = [0x14, 0x11, 0x0e];
/** Warm shadow under the seal, so it reads as embossed rather than pasted. */
const SHADOW = [0x2e, 0x1c, 0x0f];

// ── plate detection ──────────────────────────────────────────────────────

/**
 * The blank plate is a saturated warm-gold region: bright, clearly warmer
 * than the grey studio background, and NOT skin (skin has r-g < 30) and
 * NOT the crimson omamori body (r-g > 70).
 */
function isPlatePixel(r, g, b) {
  if (r < 170 || r > 250) return false;
  if (g < 130 || g > 215) return false;
  if (b < 80 || b > 200) return false;
  const rg = r - g;
  const gb = g - b;
  return rg > 28 && rg < 75 && gb > 20 && gb < 110;
}

/** Region of interest: where the plate is expected, per character. */
const SEARCH = {
  female: { x0: 430, y0: 500, x1: 600, y1: 640 },
  male: { x0: 400, y0: 200, x1: 640, y1: 400 },
};

/** Largest 4-connected component of plate-coloured pixels inside the ROI. */
function findPlate(png, roi) {
  const { width: w, height: h, data } = png;
  const mask = new Uint8Array(w * h);
  for (let y = roi.y0; y <= roi.y1; y++) {
    for (let x = roi.x0; x <= roi.x1; x++) {
      const i = (y * w + x) * 4;
      if (isPlatePixel(data[i], data[i + 1], data[i + 2])) mask[y * w + x] = 1;
    }
  }
  const seen = new Uint8Array(w * h);
  let best = null;
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    let count = 0;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    while (stack.length) {
      const idx = stack.pop();
      const x = idx % w;
      const y = (idx / w) | 0;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const push = (nx, ny) => {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
        const ni = ny * w + nx;
        if (mask[ni] && !seen[ni]) {
          seen[ni] = 1;
          stack.push(ni);
        }
      };
      push(x + 1, y);
      push(x - 1, y);
      push(x, y + 1);
      push(x, y - 1);
    }
    if (!best || count > best.count) {
      best = { count, minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }
  }
  return best;
}

// ── mark rendering ───────────────────────────────────────────────────────

/**
 * Resample the mark's alpha channel into a `size` x `size` tile using
 * bilinear filtering, and crop to the mark's opaque bounding box first so
 * the seal fills the plate instead of floating in the transparent margin.
 */
function markAlphaTile(mark, size) {
  let minX = mark.width;
  let minY = mark.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < mark.height; y++) {
    for (let x = 0; x < mark.width; x++) {
      if (mark.data[(y * mark.width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const tile = new Float32Array(size * size);
  const scaleX = cw / size;
  const scaleY = ch / size;
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      // Supersample 2x2 for a clean downscale of a 150px mark into ~40px.
      let acc = 0;
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const srcX = minX + Math.min(cw - 1, Math.floor((tx + sx / 2) * scaleX));
          const srcY = minY + Math.min(ch - 1, Math.floor((ty + sy / 2) * scaleY));
          acc += mark.data[(srcY * mark.width + srcX) * 4 + 3] / 255;
        }
      }
      tile[ty * size + tx] = acc / 4;
    }
  }
  return tile;
}

/** Composite one colour through a coverage tile onto the base image. */
function stampTile(png, tile, size, cx, cy, color, alphaScale, offset) {
  const { width: w, data } = png;
  const half = size / 2;
  const x0 = Math.round(cx - half + (offset ? offset[0] : 0));
  const y0 = Math.round(cy - half + (offset ? offset[1] : 0));
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const a = tile[ty * size + tx] * alphaScale;
      if (a <= 0.002) continue;
      const x = x0 + tx;
      const y = y0 + ty;
      if (x < 0 || y < 0 || x >= w || y >= png.height) continue;
      const i = (y * w + x) * 4;
      const inv = 1 - a;
      data[i] = Math.round(color[0] * a + data[i] * inv);
      data[i + 1] = Math.round(color[1] * a + data[i + 1] * inv);
      data[i + 2] = Math.round(color[2] * a + data[i + 2] * inv);
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────

function main() {
  const mark = PNG.sync.read(fs.readFileSync(MARK));
  const targets = [
    { file: 'khy-pet-female-realistic-source.png', id: 'female' },
    { file: 'khy-pet-male-realistic-source.png', id: 'male' },
  ];

  for (const target of targets) {
    const srcPath = path.join(INBOX, target.file);
    if (!fs.existsSync(srcPath)) {
      console.error('missing base art:', srcPath);
      process.exitCode = 1;
      continue;
    }
    const png = PNG.sync.read(fs.readFileSync(srcPath));
    const plate = findPlate(png, SEARCH[target.id]);
    if (!plate || plate.count < 200) {
      console.error(`[${target.id}] blank gold plate not found`, plate);
      process.exitCode = 1;
      continue;
    }
    const cx = Math.round((plate.minX + plate.maxX) / 2);
    const cy = Math.round((plate.minY + plate.maxY) / 2);
    // Seal size: 88% of the plate's shorter side, so the plate rim stays visible
    // but the seal still reads as a logo at the sizes these plates appear in
    // (the female omamori plate is only ~27px across in the 1024 master).
    const size = Math.max(12, Math.round(Math.min(plate.w, plate.h) * 0.88));
    console.log(
      `[${target.id}] plate ${plate.w}x${plate.h} at [${plate.minX},${plate.minY} -> ${plate.maxX},${plate.maxY}] ` +
        `center=(${cx},${cy}) seal=${size}px`
    );
    if (DRY_RUN) continue;

    const tile = markAlphaTile(mark, size);
    // Warm emboss shadow, then the ink seal itself (same order as build-pet-assets.ps1).
    stampTile(png, tile, size, cx, cy, SHADOW, 0.55, [Math.max(1, Math.round(size * 0.04)), Math.max(1, Math.round(size * 0.06))]);
    stampTile(png, tile, size, cx, cy, INK, 0.92, null);

    const outPath = srcPath.replace(/\.png$/, '-marked.png');
    fs.writeFileSync(outPath, PNG.sync.write(png));
    console.log(`  wrote ${path.relative(REPO, outPath)}`);
  }
}

main();
