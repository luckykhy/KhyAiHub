// jumpcut.mjs — per-scene, per-frame block comparison that surfaces frames
// where "one block suddenly changed" while the rest of the frame held still.
//
// What it hunts is not a cut (cuts are designed-in) but a glitch: content that
// jumps position inside a scene — an asset teleporting, a layer failing to
// update, a hue destroyed by a bad pass. Frames live in per-scene directories,
// so pairs never straddle a scene boundary; the paper-dip fade windows at each
// scene's head and tail (same width as assemble.mjs) are skipped too — those
// are designed-in transitions, and reporting every frame of one reports
// nothing.
//
// Three tests separate a jump from ordinary motion, because this content moves
// a lot without ever jumping:
//   1. Colour distance, not luma alone. A pure hue change leaves luma almost
//      untouched — measured on this material: 136 max single-channel delta
//      over 101 px, luma MAD 0.006 — so a brightness-only comparison cannot
//      see it at all.
//   2. Displacement search. A hot block whose content already sits within
//      MATCH_RADIUS blocks of its old position moved; it did not teleport.
//      Sub-block camera shake and walking gaits live here.
//   3. Beat tolerance. Effects quantised to on-twos / on-threes step every 2-3
//      frames; a block that goes hot again within RECUR_WINDOW pairs on either
//      side is stepping or flickering in place. A real jump is a one-off.
//
// A fourth filter keeps the report about glitches rather than weather: a jump
// moves a *patch* of content. Spawn effects — rain glyphs, Yuan's dots, falling
// ink beads, the robe's crawling light spot, the sea-surface shimmer, the
// shell-seam light stepping along the shell — change one block, a
// one-block-wide streak, a scattering of singletons, or a blob barely bigger
// than a speck, and every one of them is "new content with no counterpart
// nearby", which is exactly the signature of a teleport. Requiring the changed
// blocks to contain a solid MIN_SPAN x MIN_SPAN square keeps those out.
//
// Full-resolution block statistics, no downsampling: at half resolution a
// small bright target (spark, ink bead, rain glyph) loses three quarters of
// its signal and a sub-threshold teleport stops being a finding. Decoding
// dominates the runtime anyway (~44ms/frame measured here), so shrinking the
// pixel loops buys little and costs sensitivity.
//
// Always exit 0: this is an observer, not a gate. Blocking is a human decision
// made after reading the report.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FRAMES_DIR = path.join(PKG_ROOT, 'out', 'frames');
const OUT_DIR = path.join(PKG_ROOT, 'out');
const SCENES_PATH = path.join(PKG_ROOT, 'src', 'story', 'scenes.json');
const REPORT_PATH = path.join(OUT_DIR, 'jumpcut.json');

const FPS = 24;
const BLOCK = 8;
// Absolute floor: below it a block difference exists in 8-bit noise alone, so
// every hit would be a false one.
const ABS_DELTA = 24;
// Relative floor: a block must stand clearly above the frame's own motion,
// otherwise "one block jumped" is really "the whole frame is moving".
const RATIO = 6;
// Few blocks: past this share the pair is a whole-frame change (an undeclared
// cut), not a glitch.
const HOT_BLOCK_RATIO = 0.25;
// Scene head/tail paper-dip windows, same width as assemble.mjs; scenes.json
// can override per scene with fadeInSec / fadeOutSec.
const DEFAULT_FADE_SEC = 0.5;
const MAX_RECORDED = 5000;
// Displacement search radius (in blocks) and how far two blocks may still
// differ and count as the same content. Sized so a 2px camera shake and the
// 12px/frame moth arc both find their old position, while one-frame movement
// past ~24px has to justify itself.
const MATCH_RADIUS = 3;
const MATCH_TOL = 12;
// Beat tolerance (in pairs) and positional slack (in blocks) for the
// "stepped again nearby" test. The window has to outlast the slowest repeating
// effect this content runs — the 4-second shell-seam breathing and the 3.2s
// gait both re-touch the same blocks — so 48 pairs (2s) plus 3 blocks (24px)
// of slack, which is how far the shell-seam light travels between steps.
// Anything that repeats inside that box is an effect, not a jump.
const RECUR_WINDOW = 48;
const RECUR_DILATE = 3;
// A jump moves a patch of content, not a speck: the changed blocks must contain
// a solid MIN_SPAN x MIN_SPAN square (MIN_CLUSTER blocks). Rain glyphs, dots,
// falling beads, the sea-surface shimmer and the robe's crawling light spot
// never do; measured on this material they all stay at or below 3x5 blocks,
// while a 24x24 teleport — 3x3 blocks — still lands in the report. The floor
// sits at 3x3 rather than 4x4 on purpose: a 32x32 hue destruction that is not
// aligned to the block grid only fills a 3x3 core plus partial edges, and a 4x4
// floor loses it half the time.
const MIN_CLUSTER = 9;
const MIN_SPAN = 3;

function readScenes() {
  const scenes = [];
  let switchPoints = [];
  try {
    const raw = JSON.parse(fs.readFileSync(SCENES_PATH, 'utf8'));
    const list = Array.isArray(raw.sceneDurations)
      ? raw.sceneDurations
      : Array.isArray(raw.scenes)
        ? raw.scenes
        : [];
    let acc = 0;
    for (const s of list) {
      const id = String(s.id);
      const durationSec = Number(s.durationSec);
      if (!id || !Number.isFinite(durationSec) || durationSec <= 0) continue;
      scenes.push({
        id,
        durationSec,
        fadeInSec: Number.isFinite(Number(s.fadeInSec)) ? Number(s.fadeInSec) : DEFAULT_FADE_SEC,
        fadeOutSec: Number.isFinite(Number(s.fadeOutSec)) ? Number(s.fadeOutSec) : DEFAULT_FADE_SEC,
      });
      switchPoints.push(Number(acc.toFixed(4)));
      acc += durationSec;
    }
  } catch {
    console.error('[khyos-desktop] 读不到 src/story/scenes.json，按磁盘上的场景目录逐个分析。');
  }
  if (!scenes.length) {
    for (const name of fs.existsSync(FRAMES_DIR)
      ? fs
          .readdirSync(FRAMES_DIR, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort()
      : []) {
      const n = fs.readdirSync(path.join(FRAMES_DIR, name)).filter((f) => /^frame_\d{5}\.png$/.test(f)).length;
      scenes.push({
        id: name,
        durationSec: n / FPS,
        fadeInSec: DEFAULT_FADE_SEC,
        fadeOutSec: DEFAULT_FADE_SEC,
      });
    }
  }
  return { scenes, switchPoints };
}

// Mean colour distance between two same-grid blocks: mean over the block's
// pixels of the per-pixel mean absolute channel difference. Luma moves and hue
// moves both land on the same 0-255 scale, so one threshold covers both.
function blockDelta(prev, cur, width, bx, by) {
  let acc = 0;
  for (let y = by * BLOCK; y < by * BLOCK + BLOCK; y += 1) {
    const row = y * width;
    for (let x = bx * BLOCK; x < bx * BLOCK + BLOCK; x += 1) {
      const o = (row + x) << 2;
      acc +=
        Math.abs(prev.data[o] - cur.data[o]) +
        Math.abs(prev.data[o + 1] - cur.data[o + 1]) +
        Math.abs(prev.data[o + 2] - cur.data[o + 2]);
    }
  }
  return acc / (3 * BLOCK * BLOCK);
}

// Same distance, but between block (bx,by) of `a` and a different block of `b`
// — the displacement search's comparison unit.
function blockDeltaAt(a, b, width, bx, by, ox, oy) {
  let acc = 0;
  for (let y = 0; y < BLOCK; y += 1) {
    const ra = (by * BLOCK + y) * width + bx * BLOCK;
    const rb = (oy * BLOCK + y) * width + ox * BLOCK;
    for (let x = 0; x < BLOCK; x += 1) {
      const oa = (ra + x) << 2;
      const ob = (rb + x) << 2;
      acc +=
        Math.abs(a.data[oa] - b.data[ob]) +
        Math.abs(a.data[oa + 1] - b.data[ob + 1]) +
        Math.abs(a.data[oa + 2] - b.data[ob + 2]);
    }
  }
  return acc / (3 * BLOCK * BLOCK);
}

// Per-block mean colour, packed as [r,g,b, r,g,b, ...].
function blockMeans(png, width, blocksX, blocksY) {
  const out = new Float64Array(blocksX * blocksY * 3);
  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = by * BLOCK; y < by * BLOCK + BLOCK; y += 1) {
        const row = y * width;
        for (let x = bx * BLOCK; x < bx * BLOCK + BLOCK; x += 1) {
          const o = (row + x) << 2;
          r += png.data[o];
          g += png.data[o + 1];
          b += png.data[o + 2];
        }
      }
      const idx = (by * blocksX + bx) * 3;
      out[idx] = r / (BLOCK * BLOCK);
      out[idx + 1] = g / (BLOCK * BLOCK);
      out[idx + 2] = b / (BLOCK * BLOCK);
    }
  }
  return out;
}

function meanDist(meansA, meansB, idxA, idxB) {
  const a = idxA * 3;
  const b = idxB * 3;
  return (
    (Math.abs(meansA[a] - meansB[b]) +
      Math.abs(meansA[a + 1] - meansB[b + 1]) +
      Math.abs(meansA[a + 2] - meansB[b + 2])) /
    3
  );
}

// Does the content of block idx of the current frame already sit within
// MATCH_RADIUS blocks of the same spot in the previous frame? If yes the
// content moved (or the camera did); if no it appeared from nowhere. The
// mean-colour pre-filter is exact: a block's mean distance is a lower bound of
// its full distance, so an offset rejected here could never pass below.
function hasNearbyMatch(cur, prev, curMeans, prevMeans, width, blocksX, blocksY, bx, by, idx) {
  for (let dy = -MATCH_RADIUS; dy <= MATCH_RADIUS; dy += 1) {
    const y2 = by + dy;
    if (y2 < 0 || y2 >= blocksY) continue;
    for (let dx = -MATCH_RADIUS; dx <= MATCH_RADIUS; dx += 1) {
      const x2 = bx + dx;
      if (x2 < 0 || x2 >= blocksX) continue;
      const nIdx = y2 * blocksX + x2;
      if (meanDist(curMeans, prevMeans, idx, nIdx) > MATCH_TOL) continue;
      if (blockDeltaAt(cur, prev, width, bx, by, x2, y2) <= MATCH_TOL) return true;
    }
  }
  return false;
}

// Was this block (or one next to it) a candidate in another pair close by?
// Stepping and flickering repeat; a jump happens once.
function recursNearby(maskHistory, pair, idx, blocksX, blocksY) {
  const bx = idx % blocksX;
  const by = (idx - bx) / blocksX;
  for (const h of maskHistory) {
    if (h.pair === pair) continue;
    if (Math.abs(h.pair - pair) > RECUR_WINDOW) continue;
    for (let dy = -RECUR_DILATE; dy <= RECUR_DILATE; dy += 1) {
      const y2 = by + dy;
      if (y2 < 0 || y2 >= blocksY) continue;
      for (let dx = -RECUR_DILATE; dx <= RECUR_DILATE; dx += 1) {
        const x2 = bx + dx;
        if (x2 < 0 || x2 >= blocksX) continue;
        if (h.mask[y2 * blocksX + x2]) return true;
      }
    }
  }
  return false;
}

// Keep only candidates that form a solid patch: a connected region containing
// a fully-filled MIN_SPAN x MIN_SPAN square of changed blocks. A one-block-wide
// line — even with a stray neighbour — is the sea-surface shimmer or a falling
// bead string, and a scattering of singletons is rain; neither is a patch of
// content that jumped. Measured on this material, rain-glyph clusters and the
// robe's light-spot steps live in the 2x2..2x3 band, so the floor sits at 3x3
// blocks (24x24 px): small enough for a real asset-scale glitch, above the
// weather.
function patchCandidates(cand, blocksX, blocksY) {
  const inSet = new Uint8Array(blocksX * blocksY);
  for (const idx of cand) inSet[idx] = 1;
  const seen = new Uint8Array(blocksX * blocksY);
  const out = [];
  const stack = [];
  for (const idx of cand) {
    if (seen[idx]) continue;
    stack.length = 0;
    stack.push(idx);
    seen[idx] = 1;
    const members = [];
    while (stack.length) {
      const cur = stack.pop();
      members.push(cur);
      const bx = cur % blocksX;
      const by = (cur - bx) / blocksX;
      for (let dy = -1; dy <= 1; dy += 1) {
        const y2 = by + dy;
        if (y2 < 0 || y2 >= blocksY) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const x2 = bx + dx;
          if (x2 < 0 || x2 >= blocksX) continue;
          const n = y2 * blocksX + x2;
          if (inSet[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    let solid = false;
    for (const m of members) {
      const bx = m % blocksX;
      const by = (m - bx) / blocksX;
      if (bx + MIN_SPAN > blocksX || by + MIN_SPAN > blocksY) continue;
      let full = true;
      for (let dy = 0; dy < MIN_SPAN && full; dy += 1) {
        const row = (by + dy) * blocksX + bx;
        for (let dx = 0; dx < MIN_SPAN; dx += 1) {
          if (!inSet[row + dx]) {
            full = false;
            break;
          }
        }
      }
      if (full) {
        solid = true;
        break;
      }
    }
    if (solid && members.length >= MIN_CLUSTER) {
      for (const m of members) out.push(m);
    }
  }
  return out;
}

const { scenes, switchPoints } = readScenes();

const findings = [];
let truncated = false;
let maxDelta = 0;
let comparedPairs = 0;
let skippedFadePairs = 0;
let totalFindings = 0;
let suppressedByMotion = 0;
let suppressedByBeat = 0;
let suppressedBySpeck = 0;
const perScene = [];

for (const scene of scenes) {
  const sceneDir = path.join(FRAMES_DIR, scene.id);
  const frames = fs.existsSync(sceneDir)
    ? fs
        .readdirSync(sceneDir)
        .filter((f) => /^frame_\d{5}\.png$/.test(f))
        .sort()
    : [];
  const sceneReport = {
    id: scene.id,
    frames: frames.length,
    comparedPairs: 0,
    skippedFadePairs: 0,
    findings: 0,
    maxDelta: 0,
  };
  perScene.push(sceneReport);
  if (frames.length < 2) continue;

  const fadeInFrames = Math.round(scene.fadeInSec * FPS);
  const fadeOutFrames = Math.round(scene.fadeOutSec * FPS);
  const firstPng = PNG.sync.read(fs.readFileSync(path.join(sceneDir, frames[0])));
  // The block grid is pinned by the first frame's size: if frame sizes
  // disagree the comparison is meaningless anyway, so nail the spec here
  // instead of testing every pair for equality.
  const blocksX = Math.floor(firstPng.width / BLOCK);
  const blocksY = Math.floor(firstPng.height / BLOCK);
  if (blocksX < 1 || blocksY < 1) {
    console.error(`[khyos-desktop] 场景 ${scene.id} 帧尺寸 ${firstPng.width}x${firstPng.height} 小于一个 ${BLOCK}x${BLOCK} 块，跳过。`);
    continue;
  }

  let prev = firstPng;
  let prevMeans = blockMeans(prev, firstPng.width, blocksX, blocksY);
  // A candidate waits until its beat window has filled on both sides, so the
  // last step of a stepping run is recognised by the steps before it and the
  // first by the steps after.
  const pending = [];
  const maskHistory = [];

  const record = (p) => {
    totalFindings += 1;
    sceneReport.findings += 1;
    // The count is the finding, not the record: `findings.length` used to
    // double as the counter, so the report said 5000 and meant "we stopped
    // looking". Count every finding; record only the first MAX_RECORDED so
    // the JSON stays bounded.
    if (findings.length >= MAX_RECORDED) {
      truncated = true;
      return;
    }
    findings.push({
      scene: scene.id,
      frame: p.frame,
      t: Number((p.frame / FPS).toFixed(4)),
      block: { x: p.idx % blocksX, y: Math.floor(p.idx / blocksX) },
      delta: Number(p.delta.toFixed(3)),
      globalMean: Number(p.globalMean.toFixed(3)),
      ratio: Number((p.delta / Math.max(p.globalMean, 1e-6)).toFixed(2)),
    });
  };

  const resolvePending = (upToPair) => {
    while (pending.length && pending[0].pair + RECUR_WINDOW <= upToPair) {
      const p = pending.shift();
      if (recursNearby(maskHistory, p.pair, p.idx, blocksX, blocksY)) suppressedByBeat += 1;
      else record(p);
    }
  };

  for (let i = 1; i < frames.length; i += 1) {
    // Pairs inside a fade window never count: the paper dip is a designed-in
    // transition.
    if (i - 1 < fadeInFrames || i > frames.length - 1 - fadeOutFrames) {
      skippedFadePairs += 1;
      sceneReport.skippedFadePairs += 1;
      prev = PNG.sync.read(fs.readFileSync(path.join(sceneDir, frames[i])));
      prevMeans = blockMeans(prev, prev.width, blocksX, blocksY);
      continue;
    }
    const png = PNG.sync.read(fs.readFileSync(path.join(sceneDir, frames[i])));
    comparedPairs += 1;
    sceneReport.comparedPairs += 1;

    // One pass: per-block colour distance plus the current frame's per-block
    // mean colour (it becomes the previous frame's means next pair).
    const width = png.width;
    const blockDeltas = new Float64Array(blocksX * blocksY);
    const curMeans = new Float64Array(blocksX * blocksY * 3);
    let sum = 0;
    for (let by = 0; by < blocksY; by += 1) {
      for (let bx = 0; bx < blocksX; bx += 1) {
        let acc = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let y = by * BLOCK; y < by * BLOCK + BLOCK; y += 1) {
          const row = y * width;
          for (let x = bx * BLOCK; x < bx * BLOCK + BLOCK; x += 1) {
            const o = (row + x) << 2;
            acc +=
              Math.abs(prev.data[o] - png.data[o]) +
              Math.abs(prev.data[o + 1] - png.data[o + 1]) +
              Math.abs(prev.data[o + 2] - png.data[o + 2]);
            r += png.data[o];
            g += png.data[o + 1];
            b += png.data[o + 2];
          }
        }
        const idx = by * blocksX + bx;
        const d = acc / (3 * BLOCK * BLOCK);
        blockDeltas[idx] = d;
        const m = idx * 3;
        curMeans[m] = r / (BLOCK * BLOCK);
        curMeans[m + 1] = g / (BLOCK * BLOCK);
        curMeans[m + 2] = b / (BLOCK * BLOCK);
        sum += d;
        if (d > maxDelta) maxDelta = d;
        if (d > sceneReport.maxDelta) sceneReport.maxDelta = d;
      }
    }

    const globalMean = sum / Math.max(1, blockDeltas.length);
    const hot = [];
    for (let idx = 0; idx < blockDeltas.length; idx += 1) {
      const d = blockDeltas[idx];
      if (d > ABS_DELTA && d > RATIO * globalMean) hot.push(idx);
    }
    // A pair where a quarter of all blocks jumped is a whole-frame change —
    // an undeclared cut, not a glitch — and contributes no beat history.
    if (hot.length && hot.length / blockDeltas.length <= HOT_BLOCK_RATIO) {
      const unmatched = [];
      for (const idx of hot) {
        const bx = idx % blocksX;
        const by = Math.floor(idx / blocksX);
        if (hasNearbyMatch(png, prev, curMeans, prevMeans, width, blocksX, blocksY, bx, by, idx)) {
          suppressedByMotion += 1;
          continue;
        }
        unmatched.push(idx);
      }
      const patch = patchCandidates(unmatched, blocksX, blocksY);
      suppressedBySpeck += unmatched.length - patch.length;
      // Only patches enter the beat history: the question it answers is "did a
      // patch-scale change repeat here recently", and letting single-block
      // specks answer it blinds the report — measured, it swallows every
      // finding including an injected hue destruction.
      const candidateMask = new Uint8Array(blocksX * blocksY);
      for (const idx of patch) {
        candidateMask[idx] = 1;
        pending.push({ pair: i, frame: i, idx, delta: blockDeltas[idx], globalMean });
      }
      maskHistory.push({ pair: i, mask: candidateMask });
      if (maskHistory.length > 2 * RECUR_WINDOW + 1) maskHistory.shift();
    }
    resolvePending(i);
    prev = png;
    prevMeans = curMeans;
  }

  // Scene over: whatever is still waiting has no future pairs left to repeat
  // in, so judge it on its past alone.
  while (pending.length) {
    const p = pending.shift();
    if (recursNearby(maskHistory, p.pair, p.idx, blocksX, blocksY)) suppressedByBeat += 1;
    else record(p);
  }
}

const report = {
  scenes: perScene,
  comparedPairs,
  skippedFadePairs,
  switchPoints,
  blockSize: BLOCK,
  thresholds: { absDelta: ABS_DELTA, ratio: RATIO, hotBlockRatio: HOT_BLOCK_RATIO },
  maxDelta: Number(maxDelta.toFixed(2)),
  totalFindings,
  recordedFindings: findings.length,
  findings,
  truncated,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

for (const f of findings.slice(0, 20)) {
  console.log(
    `[khyos-desktop] 疑似瞬移：场景 ${f.scene} 第 ${f.frame} 帧 t=${f.t}s 块 (${f.block.x},${f.block.y}) 差异 ${f.delta}（整帧均值 ${f.globalMean}，${f.ratio} 倍）`,
  );
}
if (truncated) {
  console.log(
    `[khyos-desktop] finding 总数 ${totalFindings} 超过 ${MAX_RECORDED}，JSON 只记录前 ${findings.length} 条明细（总数与各场景计数未被截断）。`,
  );
}
console.log(
  `[khyos-desktop] 抑制：邻域有对应内容（位移/微晃）${suppressedByMotion} 块，非块状改动（单块/细缝特效）${suppressedBySpeck} 块，节拍窗内复现（原地 stepping/闪烁）${suppressedByBeat} 块；匹配半径 ${MATCH_RADIUS} 块 / 容差 ${MATCH_TOL}，节拍窗 ${RECUR_WINDOW} 对 / 松弛 ${RECUR_DILATE} 块，成团下限 ${MIN_CLUSTER} 块`,
);
console.log(`JUMPCUT_SUMMARY findings=${totalFindings} recorded=${findings.length} maxDelta=${maxDelta.toFixed(2)}`);
console.log(
  `[khyos-desktop] 比对 ${comparedPairs} 对场景内相邻帧，跳过 ${skippedFadePairs} 对淡入淡出窗口；切换时间点 ${switchPoints.map((t) => `${t}s`).join(', ') || '（无）'}；明细 ${path.relative(PKG_ROOT, REPORT_PATH)}`,
);
