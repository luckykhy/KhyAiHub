// extract-check.mjs — 从合并版成片里抽帧，与源帧按场景与序号比对。
//
// 它守的是 assemble 那一环：libx264 是有损的，参数写错（pix_fmt 漏了
// yuv420p、framerate 与源不一致、xfade offset 算错）都会让成片和源帧
// 悄悄错位，而肉眼只看一遍是看不出来的。
//
// 合并版有两种时间线，必须分辨清楚再比对：xfade 纸色 dip 版每场景独占
// 11.5s（首尾各半秒在 dip 里），concat 硬切版每场景独占 12s。按抽帧总数
// 推断用了哪一种，比让 assemble 多写一份清单更稳——清单会和成片漂移，
// 帧数不会。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { PNG } from 'pngjs';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FRAMES_DIR = path.join(PKG_ROOT, 'out', 'frames');
const OUT_DIR = path.join(PKG_ROOT, 'out');
const SCENES_PATH = path.join(PKG_ROOT, 'src', 'story', 'scenes.json');
const MP4_PATH = path.join(OUT_DIR, 'khyos-preview-all.mp4');
const EXTRACT_DIR = path.join(OUT_DIR, '.verify');
const REPORT_PATH = path.join(OUT_DIR, 'verify.json');

const FPS = 24;
const CLIP_SEC = 12;
const CLIP_FRAMES = CLIP_SEC * FPS;
const DIP_SEC = 0.5;
const DIP_FRAMES = DIP_SEC * FPS;

// 只比亮度：yuv420p 把色度减半采样，硬边处的色度振铃本来就存在，
// 把它算进去会让判据退化成「编码器噪声」而不是「链路正确」。
const AVG_MAD_MAX = 2.5;
const MAX_MAD_MAX = 12.0;

function readSceneIds() {
  const raw = JSON.parse(fs.readFileSync(SCENES_PATH, 'utf8'));
  const list = Array.isArray(raw.sceneDurations)
    ? raw.sceneDurations
    : Array.isArray(raw.scenes)
      ? raw.scenes
      : null;
  if (!list) {
    console.error('[khyos-desktop] src/story/scenes.json 缺少 sceneDurations，无法按场景比对。');
    process.exit(1);
  }
  return list.map((s) => String(s.id)).filter(Boolean);
}

function listPng(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^frame_\d{5}\.png$/.test(f))
    .sort();
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

function meanAbsDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let acc = 0;
  for (let i = 0; i < n; i += 1) acc += Math.abs(a[i] - b[i]);
  return acc / Math.max(1, n);
}

if (!fs.existsSync(MP4_PATH)) {
  console.error('[khyos-desktop] 找不到 out/khyos-preview-all.mp4，先跑 node scripts/assemble.mjs。');
  process.exit(1);
}
const sceneIds = readSceneIds();
const sourceFramesByScene = new Map();
for (const id of sceneIds) {
  const frames = listPng(path.join(FRAMES_DIR, id));
  if (!frames.length) {
    console.error(`[khyos-desktop] out/frames/${id} 里没有源帧，先跑 node scripts/capture.mjs。`);
    process.exit(1);
  }
  sourceFramesByScene.set(id, frames);
}

// 每次抽帧前清掉上次的残留：verify.json 会连同帧数一起写，旧帧会让
// 「比对通过的帧数」虚高。
fs.rmSync(EXTRACT_DIR, { recursive: true, force: true });
fs.mkdirSync(EXTRACT_DIR, { recursive: true });

// -fps_mode passthrough 让每一帧解一次，不重采样、不补帧；-start_number 0
// 与 capture 的命名对齐。image2 默认就从 0 起，但显式钉住比依赖默认值安全。
execFileSync(
  ffmpegPath,
  [
    '-y',
    '-i',
    MP4_PATH,
    '-fps_mode',
    'passthrough',
    '-start_number',
    '0',
    path.join(EXTRACT_DIR, 'frame_%05d.png'),
  ],
  { stdio: 'inherit' },
);

const extracted = listPng(EXTRACT_DIR);
const sceneCount = sceneIds.length;
const expectedDip = sceneCount * CLIP_FRAMES - (sceneCount - 1) * DIP_FRAMES;
const expectedHard = sceneCount * CLIP_FRAMES;
// 按帧总数推断时间线：离哪种期望近就按哪种布局取独占窗口。
const layout =
  Math.abs(extracted.length - expectedDip) <= Math.abs(extracted.length - expectedHard) ? 'xfade-dip' : 'concat-hard';
// 纸色 dip 版里，每段的首尾各半秒只以「淡化中」的形态存在于合并版（被 dip
// 吃掉或正在淡），没有字节可比的对应帧；只有中段 [DIP, CLIP-DIP) 是逐帧
// 同源的。concat 硬切版没有 dip，整段可比。
const pureFrames = layout === 'xfade-dip' ? CLIP_FRAMES - 2 * DIP_FRAMES : CLIP_FRAMES;

const perScene = [];
let sum = 0;
let worst = 0;
let worstIndex = -1;
let comparedFrames = 0;
let missingFrames = 0;

for (let s = 0; s < sceneCount; s += 1) {
  const id = sceneIds[s];
  const frames = sourceFramesByScene.get(id);
  // 合并版里第 s 段第一个「纯」帧的位置：前 s 段各占 (CLIP-DIP) 秒，加上本段
  // 自己的 dip 入边。
  const pureStart =
    layout === 'xfade-dip' ? s * (CLIP_FRAMES - DIP_FRAMES) + DIP_FRAMES : s * CLIP_FRAMES;
  // 源帧同样跳过本段开头的 dip 帧——它们在合并版里只以淡化形态存在。
  const sourceSkip = layout === 'xfade-dip' ? DIP_FRAMES : 0;
  const compareCount = Math.min(pureFrames, frames.length - sourceSkip);
  const sceneReport = {
    scene: id,
    layout,
    pureStartFrame: pureStart,
    pureFrames,
    sourceFrames: frames.length,
    comparedFrames: 0,
    skippedFrames: frames.length - compareCount,
    missingFrames: 0,
    avgMad: 0,
    maxMad: 0,
  };
  perScene.push(sceneReport);

  let sceneSum = 0;
  let sceneWorst = 0;
  for (let j = 0; j < compareCount; j += 1) {
    const extractIndex = pureStart + j;
    if (extractIndex >= extracted.length) {
      missingFrames += 1;
      sceneReport.missingFrames += 1;
      continue;
    }
    const a = luma(PNG.sync.read(fs.readFileSync(path.join(FRAMES_DIR, id, frames[sourceSkip + j]))));
    const b = luma(PNG.sync.read(fs.readFileSync(path.join(EXTRACT_DIR, extracted[extractIndex]))));
    const mad = meanAbsDiff(a, b);
    sceneSum += mad;
    if (mad > sceneWorst) sceneWorst = mad;
    if (mad > worst) {
      worst = mad;
      worstIndex = extractIndex;
    }
    comparedFrames += 1;
    sceneReport.comparedFrames += 1;
  }
  sum += sceneSum;
  sceneReport.avgMad = Number((sceneSum / Math.max(1, sceneReport.comparedFrames)).toFixed(3));
  sceneReport.maxMad = Number(sceneWorst.toFixed(3));
}

const avgMad = comparedFrames ? sum / comparedFrames : Number.POSITIVE_INFINITY;
const ok =
  comparedFrames > 0 &&
  missingFrames === 0 &&
  avgMad <= AVG_MAD_MAX &&
  worst <= MAX_MAD_MAX;

const report = {
  ok,
  layout,
  mp4: path.relative(PKG_ROOT, MP4_PATH),
  extractedFrames: extracted.length,
  expectedFrames: { 'xfade-dip': expectedDip, 'concat-hard': expectedHard },
  comparedFrames,
  missingFrames,
  avgMad: Number(avgMad.toFixed(3)),
  maxMad: Number(worst.toFixed(3)),
  maxMadFrame: worstIndex,
  thresholds: { avgMadMax: AVG_MAD_MAX, maxMadMax: MAX_MAD_MAX },
  fps: FPS,
  perScene,
};

fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(
  `[khyos-desktop] 抽帧 ${extracted.length} 张，判定时间线为 ${layout}（xfade-dip 期望 ${expectedDip} / concat-hard 期望 ${expectedHard}）`,
);
console.log(
  `[khyos-desktop] 按场景与序号比对 ${comparedFrames} 帧：平均绝对差 ${avgMad.toFixed(3)}（上限 ${AVG_MAD_MAX}），最大 ${worst.toFixed(3)}（上限 ${MAX_MAD_MAX}，第 ${worstIndex} 帧）`,
);
if (missingFrames) {
  console.error(`[khyos-desktop] ${missingFrames} 帧在成片里找不到对应位置——场景时长或合并版帧数对不上。`);
}
for (const s of perScene) {
  console.log(
    `[khyos-desktop] 场景 ${s.scene}：比对 ${s.comparedFrames}/${s.sourceFrames} 帧（合并版第 ${s.pureStartFrame} 帧起为纯帧，共 ${s.pureFrames} 帧；源帧跳过首尾 dip 共 ${s.skippedFrames} 帧，缺失 ${s.missingFrames} 帧），avg ${s.avgMad} / max ${s.maxMad}`,
  );
}
console.log(`EXTRACT_CHECK ok=${ok}`);
console.log(`[khyos-desktop] 明细 ${path.relative(PKG_ROOT, REPORT_PATH)}`);
if (!ok) process.exit(1);
