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

// 亮度两项维持原口径：yuv420p 之后拿帧级 MAD 判「链路对不对」。
const AVG_MAD_MAX = 2.5;
const MAX_MAD_MAX = 12.0;
// 色度两项补亮度看不见的那一半：一次纯色相破坏（实测 101 像素、单通道差
// 136）帧级亮度 MAD 只有 0.006，任何亮度阈值都放它过去。色度在 yuv420p
// 里被半采样，硬边处天然有振铃，所以两项都先在 2x2 平均后的色度面上算——
// 振铃被平均掉，系统性的色相错误（矩阵错、pix_fmt 错）和局部的色相破坏
// 都还在。帧级均值抓全局错误，块级最大值抓局部破坏。
const CHROMA_BLOCK = 16;
const CHROMA_MAD_MAX = 1.5;
const CHROMA_MAX_MAX = 16.0;

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

// Cb/Cr (BT.601, full range) on a 2x2-averaged image: chroma subsampling
// ringing lives at pixel scale and dies in the average, while a systematic
// hue error survives it everywhere.
function chromaHalf(png) {
  const w = png.width;
  const hw = w >> 1;
  const hh = png.height >> 1;
  const cb = new Float64Array(hw * hh);
  const cr = new Float64Array(hw * hh);
  for (let y = 0; y < hh; y += 1) {
    for (let x = 0; x < hw; x += 1) {
      let sb = 0;
      let sr = 0;
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const o = (((y << 1) + dy) * w + ((x << 1) + dx)) << 2;
          const r = png.data[o];
          const g = png.data[o + 1];
          const b = png.data[o + 2];
          sb += -0.168736 * r - 0.331264 * g + 0.5 * b;
          sr += 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      cb[y * hw + x] = sb / 4;
      cr[y * hw + x] = sr / 4;
    }
  }
  return { cb, cr, w: hw, h: hh };
}

// Frame-level chroma distance and the worst CHROMA_BLOCK-px block's chroma
// distance, both on the averaged planes.
function chromaStats(a, b) {
  const n = a.w * a.h;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += Math.abs(a.cb[i] - b.cb[i]) + Math.abs(a.cr[i] - b.cr[i]);
  }
  const mad = sum / (2 * n);
  const bxN = Math.floor(a.w / (CHROMA_BLOCK >> 1));
  const byN = Math.floor(a.h / (CHROMA_BLOCK >> 1));
  let worst = 0;
  for (let by = 0; by < byN; by += 1) {
    for (let bx = 0; bx < bxN; bx += 1) {
      let s = 0;
      for (let y = by * (CHROMA_BLOCK >> 1); y < (by + 1) * (CHROMA_BLOCK >> 1); y += 1) {
        const row = y * a.w;
        for (let x = bx * (CHROMA_BLOCK >> 1); x < (bx + 1) * (CHROMA_BLOCK >> 1); x += 1) {
          s += Math.abs(a.cb[row + x] - b.cb[row + x]) + Math.abs(a.cr[row + x] - b.cr[row + x]);
        }
      }
      const m = s / (2 * (CHROMA_BLOCK >> 1) * (CHROMA_BLOCK >> 1));
      if (m > worst) worst = m;
    }
  }
  return { mad, worst };
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
let chromaSum = 0;
let chromaWorst = 0;
let chromaWorstIndex = -1;

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
    const srcPng = PNG.sync.read(fs.readFileSync(path.join(FRAMES_DIR, id, frames[sourceSkip + j])));
    const extPng = PNG.sync.read(fs.readFileSync(path.join(EXTRACT_DIR, extracted[extractIndex])));
    const mad = meanAbsDiff(luma(srcPng), luma(extPng));
    const chroma = chromaStats(chromaHalf(srcPng), chromaHalf(extPng));
    sceneSum += mad;
    chromaSum += chroma.mad;
    if (chroma.worst > chromaWorst) {
      chromaWorst = chroma.worst;
      chromaWorstIndex = extractIndex;
    }
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
const chromaMad = comparedFrames ? chromaSum / comparedFrames : Number.POSITIVE_INFINITY;
const ok =
  comparedFrames > 0 &&
  missingFrames === 0 &&
  avgMad <= AVG_MAD_MAX &&
  worst <= MAX_MAD_MAX &&
  chromaMad <= CHROMA_MAD_MAX &&
  chromaWorst <= CHROMA_MAX_MAX;

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
  chromaMad: Number(chromaMad.toFixed(3)),
  chromaMax: Number(chromaWorst.toFixed(3)),
  chromaMaxFrame: chromaWorstIndex,
  thresholds: { avgMadMax: AVG_MAD_MAX, maxMadMax: MAX_MAD_MAX, chromaMadMax: CHROMA_MAD_MAX, chromaMaxMax: CHROMA_MAX_MAX },
  fps: FPS,
  perScene,
};

fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(
  `[khyos-desktop] 抽帧 ${extracted.length} 张，判定时间线为 ${layout}（xfade-dip 期望 ${expectedDip} / concat-hard 期望 ${expectedHard}）`,
);
console.log(
  `[khyos-desktop] 按场景与序号比对 ${comparedFrames} 帧：平均绝对差 ${avgMad.toFixed(3)}（上限 ${AVG_MAD_MAX}），最大 ${worst.toFixed(3)}（上限 ${MAX_MAD_MAX}，第 ${worstIndex} 帧）；色度平均 ${chromaMad.toFixed(3)}（上限 ${CHROMA_MAD_MAX}），块级最大 ${chromaWorst.toFixed(3)}（上限 ${CHROMA_MAX_MAX}，第 ${chromaWorstIndex} 帧）`,
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
