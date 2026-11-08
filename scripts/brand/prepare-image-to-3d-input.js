#!/usr/bin/env node
/**
 * Prepare the realistic base art as an image-to-3D input.
 *
 * WHY THIS STEP EXISTS
 * --------------------
 * StableFast3D (and every other image-to-3D model) expects **one object,
 * centred, filling most of the frame, on an even background**. The base art
 * is a full-body studio shot on a grey gradient: the character occupies only
 * ~30% of the width and ~90% of the height, so the model would reconstruct a
 * tiny figure floating in a grey box.
 *
 * So: cut the character out of the gradient background, crop to its bounding
 * box, re-centre it on an even background, and resize to the resolution the
 * model expects (512 for SF3D).
 *
 * The background is cut by **difference from the corner colour**, not by a
 * colour threshold: the backdrop is a soft grey gradient and the skin is
 * nearly the same value, so a luminance threshold would eat the face.
 *
 * Usage:
 *   node scripts/brand/prepare-image-to-3d-input.js --input <png> --output <png> [--size 512]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require(path.join(__dirname, '..', '..', 'node_modules', 'pngjs'));

function parseArgs(argv) {
  const out = { input: '', output: '', size: 512, pad: 0.06 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') out.input = argv[++i];
    else if (a === '--output') out.output = argv[++i];
    else if (a === '--size') out.size = Number(argv[++i]);
    else if (a === '--pad') out.pad = Number(argv[++i]);
  }
  if (!out.input || !out.output) {
    console.error('usage: --input <png> --output <png> [--size 512] [--pad 0.06]');
    process.exit(2);
  }
  return out;
}

/**
 * Cut the subject out of the studio backdrop.
 *
 * Same algorithm as scripts/brand/build-pet-relief.py (gradient barrier +
 * flood fill from the border), ported to JS so the image-to-3D input prep
 * does not need Blender. The reason for this rather than a colour-distance
 * test: the backdrop is a **gradient**, and the skin is nearly the same
 * value as the backdrop, so a threshold would eat the face. A flood fill
 * from the border only reaches pixels that are actually connected to the
 * backdrop, and the subject's outline (hair, clothing edges) blocks it.
 */
function cutout(src) {
  const { width: w, height: h, data } = src;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] = data[i * 4] * 0.2126 + data[i * 4 + 1] * 0.7152 + data[i * 4 + 2] * 0.0722;
  }
  const EDGE_THRESHOLD = 14;
  const barrier = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let isBarrier = false;
      if (x + 1 < w && Math.abs(lum[i] - lum[i + 1]) > EDGE_THRESHOLD) isBarrier = true;
      if (y + 1 < h && Math.abs(lum[i] - lum[i + w]) > EDGE_THRESHOLD) isBarrier = true;
      barrier[i] = isBarrier ? 1 : 0;
    }
  }
  // Close small gaps in the outline so the flood cannot leak into the subject.
  const RADIUS = 2;
  const closed = new Uint8Array(barrier);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (barrier[i]) continue;
      let hits = 0;
      for (let dy = -RADIUS; dy <= RADIUS && hits < 2; dy++) {
        for (let dx = -RADIUS; dx <= RADIUS; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (barrier[ny * w + nx]) hits++;
        }
      }
      if (hits >= 2) closed[i] = 1;
    }
  }
  const BORDER = 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x < BORDER || y < BORDER || x >= w - BORDER || y >= h - BORDER) closed[i] = 0;
    }
  }

  // Flood from the border over non-barrier pixels.
  const bg = new Uint8Array(w * h);
  const stack = [];
  const push = (i) => {
    if (!bg[i] && !closed[i]) {
      bg[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  // Pixels fully enclosed by the subject (the omamori plate, for instance)
  // are part of the subject even though the flood cannot reach them.
  const visited = new Uint8Array(w * h);
  const stack2 = [];
  for (let i = 0; i < w * h; i++) {
    if (!bg[i] && !visited[i]) {
      visited[i] = 1;
      stack2.push(i);
    }
  }
  while (stack2.length) {
    const i = stack2.pop();
    const x = i % w;
    const y = (i / w) | 0;
    const nb = [
      x > 0 ? i - 1 : -1,
      x < w - 1 ? i + 1 : -1,
      y > 0 ? i - w : -1,
      y < h - 1 ? i + w : -1,
    ];
    for (const j of nb) {
      if (j >= 0 && bg[j] && !visited[j]) {
        visited[j] = 1;
        stack2.push(j);
      }
    }
  }
  // bg pixels not reachable from the border are enclosed holes -> subject.
  for (let i = 0; i < w * h; i++) {
    if (bg[i] && !visited[i]) bg[i] = 0;
  }
  return bg;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const src = PNG.sync.read(fs.readFileSync(args.input));
  const { width: w, height: h, data } = src;

  const bg = cutout(src);

  // Subject bounding box.
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bg[y * w + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    console.error('[prep] foreground not found');
    process.exit(1);
  }
  console.log(`[prep] ${path.basename(args.input)} ${w}x${h} subject bbox=[${minX},${minY} -> ${maxX},${maxY}]`);

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const padPx = Math.round(Math.max(bw, bh) * args.pad);
  const cx0 = Math.max(0, minX - padPx);
  const cy0 = Math.max(0, minY - padPx);
  const cx1 = Math.min(w - 1, maxX + padPx);
  const cy1 = Math.min(h - 1, maxY + padPx);
  const cw = cx1 - cx0 + 1;
  const ch = cy1 - cy0 + 1;

  const size = args.size;
  const out = new PNG({ width: size, height: size });
  // Even backdrop: the mid-tone grey the art already uses, so the model's
  // background removal sees no hard edge at the frame border.
  const br = Math.round(data[0]);
  const bg2 = Math.round(data[1]);
  const bb = Math.round(data[2]);

  const scale = Math.min(size / cw, size / ch);
  const dw = Math.round(cw * scale);
  const dh = Math.round(ch * scale);
  const ox = Math.round((size - dw) / 2);
  const oy = Math.round((size - dh) / 2);
  console.log(`[prep] crop ${cw}x${ch} -> scaled ${dw}x${dh} at (${ox},${oy}) on ${size}x${size}`);

  for (let i = 0; i < size * size; i++) {
    out.data[i * 4] = br;
    out.data[i * 4 + 1] = bg2;
    out.data[i * 4 + 2] = bb;
    out.data[i * 4 + 3] = 255;
  }

  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx = cx0 + Math.min(cw - 1, Math.floor(x / scale));
      const sy = cy0 + Math.min(ch - 1, Math.floor(y / scale));
      const si = (sy * w + sx) * 4;
      const di = ((oy + y) * size + (ox + x)) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = 255;
    }
  }

  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(args.output, PNG.sync.write(out));
  console.log(`[prep] wrote ${args.output}`);
}

main();
