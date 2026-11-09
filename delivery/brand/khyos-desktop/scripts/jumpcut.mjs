// jumpcut.mjs — 逐场景内逐帧分块比对，找出「个别块突然大变」的可疑帧。
//
// 它抓的不是切换点（切换是设计内的），而是穿帮：某个 8x8 块在两帧之间
// 跳了一大截而整帧几乎没动——通常是资产瞬移、相机跳变或渲染漏更新。
// 帧按场景分目录存放，跨场景的相邻对天然不存在，场景边界因此不计入；
// 场景首尾的淡入淡出窗口（纸色 dip，与 assemble.mjs 同宽）同样不计——
// 那是设计内的过渡，每一帧都报就等于没报。
//
// 恒 exit 0：它是观察者，不是门禁。真的拦截由人看过报告之后再说。
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
// 绝对下限：低于它的块差异在 8bit 噪声里就存在，报出来全是假的。
const ABS_DELTA = 24;
// 相对下限：块差异要明显高于整帧均值，才算「个别块跳变」而不是「整帧在动」。
const RATIO = 6;
// 少数块：同一对里超过这个比例就算整帧突变，那是漏声明的切换，不是穿帮。
const HOT_BLOCK_RATIO = 0.25;
// 场景首尾淡入淡出窗口，与 assemble.mjs 的纸色 dip 同宽；scenes.json 可用
// fadeInSec / fadeOutSec 逐场景覆写。
const DEFAULT_FADE_SEC = 0.5;
const MAX_RECORDED = 5000;

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

function luma(png) {
  const n = png.width * png.height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const o = i << 2;
    out[i] = (0.299 * png.data[o] + 0.587 * png.data[o + 1] + 0.114 * png.data[o + 2]) | 0;
  }
  return out;
}

const { scenes, switchPoints } = readScenes();

const findings = [];
let truncated = false;
let maxDelta = 0;
let comparedPairs = 0;
let skippedFadePairs = 0;
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
  // 块网格按首帧尺寸定：帧尺寸不一致时后面的比对本来就没有意义，
  // 与其逐对判等，不如在这里就把规格钉死。
  const blocksX = Math.floor(firstPng.width / BLOCK);
  const blocksY = Math.floor(firstPng.height / BLOCK);
  if (blocksX < 1 || blocksY < 1) {
    console.error(`[khyos-desktop] 场景 ${scene.id} 帧尺寸 ${firstPng.width}x${firstPng.height} 小于一个 ${BLOCK}x${BLOCK} 块，跳过。`);
    continue;
  }

  let prev = luma(firstPng);
  for (let i = 1; i < frames.length; i += 1) {
    // 淡入淡出窗口内的相邻对一律不计：纸色 dip 是设计内的过渡。
    if (i - 1 < fadeInFrames || i > frames.length - 1 - fadeOutFrames) {
      skippedFadePairs += 1;
      sceneReport.skippedFadePairs += 1;
      prev = luma(PNG.sync.read(fs.readFileSync(path.join(sceneDir, frames[i]))));
      continue;
    }
    const png = PNG.sync.read(fs.readFileSync(path.join(sceneDir, frames[i])));
    const cur = luma(png);
    comparedPairs += 1;
    sceneReport.comparedPairs += 1;

    const blockMads = new Float64Array(blocksX * blocksY);
    let sum = 0;
    for (let by = 0; by < blocksY; by += 1) {
      for (let bx = 0; bx < blocksX; bx += 1) {
        let acc = 0;
        for (let y = by * BLOCK; y < by * BLOCK + BLOCK; y += 1) {
          const row = y * png.width;
          for (let x = bx * BLOCK; x < bx * BLOCK + BLOCK; x += 1) {
            acc += Math.abs(prev[row + x] - cur[row + x]);
          }
        }
        const mad = acc / (BLOCK * BLOCK);
        const idx = by * blocksX + bx;
        blockMads[idx] = mad;
        sum += mad;
        if (mad > maxDelta) maxDelta = mad;
        if (mad > sceneReport.maxDelta) sceneReport.maxDelta = mad;
      }
    }

    const globalMean = sum / Math.max(1, blockMads.length);
    const hot = [];
    for (let idx = 0; idx < blockMads.length; idx += 1) {
      const mad = blockMads[idx];
      if (mad > ABS_DELTA && mad > RATIO * globalMean) hot.push(idx);
    }
    if (hot.length && hot.length / blockMads.length <= HOT_BLOCK_RATIO) {
      for (const idx of hot) {
        if (findings.length >= MAX_RECORDED) {
          truncated = true;
          break;
        }
        findings.push({
          scene: scene.id,
          frame: i,
          t: Number((i / FPS).toFixed(4)),
          block: { x: idx % blocksX, y: Math.floor(idx / blocksX) },
          delta: Number(blockMads[idx].toFixed(3)),
          globalMean: Number(globalMean.toFixed(3)),
          ratio: Number((blockMads[idx] / Math.max(globalMean, 1e-6)).toFixed(2)),
        });
        sceneReport.findings += 1;
      }
    }
    prev = cur;
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
if (truncated) console.log(`[khyos-desktop] finding 数超过 ${MAX_RECORDED}，JSON 中已截断。`);

console.log(`JUMPCUT_SUMMARY findings=${findings.length} maxDelta=${maxDelta.toFixed(2)}`);
console.log(
  `[khyos-desktop] 比对 ${comparedPairs} 对场景内相邻帧，跳过 ${skippedFadePairs} 对淡入淡出窗口；切换时间点 ${switchPoints.map((t) => `${t}s`).join(', ') || '（无）'}；明细 ${path.relative(PKG_ROOT, REPORT_PATH)}`,
);
