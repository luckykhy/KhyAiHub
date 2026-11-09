// assemble.mjs — 把 out/frames 合成每场景 12 秒循环预览与合并版，并转出 ogg。
//
// 为什么 ffmpeg-static 而不是让用户自己装 ffmpeg：这条链路要在干净的
// Windows 开发机上一次跑通，PATH 里有没有 ffmpeg 不该成为前提。
//
// 合并版用 xfade 做场景间纸色淡入淡出：每段素材的首尾各 fade 到纸色
// （#F6F2EC，品牌色板的 paper），xfade 把两段纸色斜坡接在一起，边界就是
// 一段纸色 dip。xfade 没有「 dipping 到指定色」的原生转场，硬造一个中间
// 片段只会让滤镜图复杂一倍；首尾 fade 加 xfade 是同一视觉的最短路径。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FRAMES_DIR = path.join(PKG_ROOT, 'out', 'frames');
const OUT_DIR = path.join(PKG_ROOT, 'out');
const SCENES_PATH = path.join(PKG_ROOT, 'src', 'story', 'scenes.json');
const WAV_PATH = path.join(OUT_DIR, 'score.wav');
const OGG_PATH = path.join(OUT_DIR, 'score.ogg');
const MERGED_PATH = path.join(OUT_DIR, 'khyos-preview-all.mp4');

const FPS = 24;
// 每场景预览固定 12 秒：场景短于 12 秒时循环补足，长于 12 秒时取前 12 秒
// （预览不是正片，任务面把长度钉在 12 秒）。合并版的 xfade offset 也按
// 「每段都是 12 秒」推算，所以两处共用同一个 staging 长度。
const CLIP_SEC = 12;
const CLIP_FRAMES = CLIP_SEC * FPS;
// 纸色 dip 半宽：与页面侧 TRANSITION_SEC 同值，两处不同步会让「页面看到的
// 切换」和「成片看到的切换」是两种东西。
const DIP_SEC = 0.5;
// 品牌色板 paper（delivery/brand/khy-brand-tokens.json）。
const PAPER = '0xF6F2EC';

function run(args) {
  execFileSync(ffmpegPath, args, { stdio: 'inherit' });
}

function readScenes() {
  const raw = JSON.parse(fs.readFileSync(SCENES_PATH, 'utf8'));
  const list = Array.isArray(raw.sceneDurations)
    ? raw.sceneDurations
    : Array.isArray(raw.scenes)
      ? raw.scenes
      : null;
  if (!list) {
    console.error('[khyos-desktop] src/story/scenes.json 缺少 sceneDurations，无法定场景顺序与音频时间段。');
    process.exit(1);
  }
  return list
    .map((s) => ({ id: String(s.id), durationSec: Number(s.durationSec) }))
    .filter((s) => s.id && Number.isFinite(s.durationSec) && s.durationSec > 0);
}

function listFrames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^frame_\d{5}\.png$/.test(f))
    .sort();
}

// WAV 时长直接读文件头：ffprobe 不在 ffmpeg-static 里，而「这段场景还有没有
// 配乐可切」必须在拼 ffmpeg 参数之前知道，否则 -ss 越过 EOF 会让整条命令
// 以一个看不懂的错误收场。
function wavDurationSec() {
  try {
    const fd = fs.openSync(WAV_PATH, 'r');
    const header = Buffer.alloc(64);
    fs.readSync(fd, header, 0, 64, 0);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      fs.closeSync(fd);
      return null;
    }
    let pos = 12;
    let byteRate = 0;
    let dataSize = 0;
    while (pos + 8 <= 64) {
      const id = header.toString('ascii', pos, pos + 4);
      const size = header.readUInt32LE(pos + 4);
      if (id === 'fmt ') {
        byteRate = header.readUInt32LE(pos + 8 + 8);
      } else if (id === 'data') {
        dataSize = size;
        break;
      }
      pos += 8 + size + (size % 2);
    }
    fs.closeSync(fd);
    if (!byteRate || !dataSize) return null;
    return dataSize / byteRate;
  } catch {
    return null;
  }
}

// 每场景补齐成恰好 288 帧的 staging 目录：image2 序列要求从 0 连续编号，
// 缺号会静默提前结束成片；而合并版的 xfade offset 按「每段 12 秒」推算，
// 输入短一秒后面全部错位。循环用 i%n，超过 12 秒的场景自然只取前 12 秒。
function stageClip(sceneId) {
  const sceneDir = path.join(FRAMES_DIR, sceneId);
  const frames = listFrames(sceneDir);
  if (!frames.length) {
    console.error(
      `[khyos-desktop] out/frames/${sceneId} 里没有帧。先跑 node scripts/capture.mjs（或 --scene ${sceneId} --frames N 小样）。`,
    );
    process.exit(1);
  }
  for (let i = 0; i < frames.length; i += 1) {
    const expected = `frame_${String(i).padStart(5, '0')}.png`;
    if (frames[i] !== expected) {
      console.error(
        `[khyos-desktop] 场景 ${sceneId} 帧序号断档：第 ${i} 号应为 ${expected}，实际是 ${frames[i]}。`,
      );
      process.exit(1);
    }
  }
  const stageDir = path.join(OUT_DIR, `.loop-${sceneId}`);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  const n = frames.length;
  for (let i = 0; i < CLIP_FRAMES; i += 1) {
    const from = path.join(sceneDir, `frame_${String(i % n).padStart(5, '0')}.png`);
    const to = path.join(stageDir, `frame_${String(i).padStart(5, '0')}.png`);
    try {
      // 硬链省掉每次全量拷贝；同卷失败（罕见）时退回拷贝。
      fs.linkSync(from, to);
    } catch {
      fs.copyFileSync(from, to);
    }
  }
  return { stageDir, sourceFrames: n };
}

const scenes = readScenes();
if (!scenes.length) {
  console.error('[khyos-desktop] scenes.json 里没有可用场景定义。');
  process.exit(1);
}

const hasWav = fs.existsSync(WAV_PATH);
const wavSec = hasWav ? wavDurationSec() : null;
if (hasWav && wavSec === null) {
  console.error('[khyos-desktop] out/score.wav 读不出时长（非标准 RIFF 头），本片只出画面、不混音。');
}

const stageDirs = [];
try {
  const staged = [];
  // 场景在故事时间轴上的起点：每场景预览取配乐的对应时间段，错位半秒就能
  // 听出来，所以这里按 scenes.json 的时长累加，不靠猜。
  let storyStart = 0;
  for (const scene of scenes) {
    const { stageDir, sourceFrames } = stageClip(scene.id);
    stageDirs.push(stageDir);
    staged.push(stageDir);

    // -crf 18 而不是默认 23：extract-check 要把抽帧与源帧按绝对差比对，
    // 默认质量下硬边网格的振铃足够让判据变成「编码器噪声」而不是「链路正确」。
    const audioAvailable = wavSec !== null && storyStart < wavSec;
    const args = ['-y', '-framerate', String(FPS), '-i', path.join(stageDir, 'frame_%05d.png')];
    if (audioAvailable) {
      args.push('-ss', storyStart.toFixed(3), '-t', String(CLIP_SEC), '-i', WAV_PATH);
    }
    args.push('-map', '0:v');
    if (audioAvailable) args.push('-map', '1:a');
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(FPS),
      '-movflags',
      '+faststart',
    );
    if (audioAvailable) args.push('-c:a', 'aac', '-b:a', '192k');
    args.push(path.join(OUT_DIR, `preview-${scene.id}.mp4`));
    run(args);
    if (hasWav && !audioAvailable) {
      console.error(
        `[khyos-desktop] 场景 ${scene.id} 的配乐时间段 [${storyStart.toFixed(2)}s, ${(storyStart + CLIP_SEC).toFixed(2)}s) 超出 score.wav 时长，本段只出画面。`,
      );
    }
    console.log(
      `[khyos-desktop] 场景 ${scene.id}：${CLIP_SEC}s 循环预览（源 ${sourceFrames} 帧${sourceFrames < CLIP_FRAMES ? '，循环补齐' : sourceFrames > CLIP_FRAMES ? '，取前 12 秒' : ''}）`,
    );
    storyStart += scene.durationSec;
  }

  // 合并版：场景序列一把 xfade 接起来，中间不再落盘分段——少一次编码代际，
  // extract-check 的绝对差判据才始终对着「一次 crf 18」说话。
  const videoInputs = [];
  for (const dir of staged) {
    videoInputs.push('-framerate', String(FPS), '-i', path.join(dir, 'frame_%05d.png'));
  }
  const filter = [];
  const fadeLabels = staged.map((_, i) => `f${i}`);
  for (let i = 0; i < staged.length; i += 1) {
    filter.push(
      `[${i}:v]fade=t=in:st=0:d=${DIP_SEC}:color=${PAPER},fade=t=out:st=${(CLIP_SEC - DIP_SEC).toFixed(3)}:d=${DIP_SEC}:color=${PAPER},format=yuv420p[${fadeLabels[i]}]`,
    );
  }
  let last = fadeLabels[0];
  for (let i = 1; i < staged.length; i += 1) {
    // 第 i 次 xfade 的 offset：累计长度减一个 dip。累计长度恒为
    // i*12 - (i-1)*0.5，因为每段 staging 都恰好 12 秒。
    const offset = (i * (CLIP_SEC - DIP_SEC)).toFixed(3);
    const out = i === staged.length - 1 ? 'vout' : `x${i}`;
    filter.push(`[${last}][${fadeLabels[i]}]xfade=transition=fade:duration=${DIP_SEC}:offset=${offset}[${out}]`);
    last = out;
  }
  const mergedArgs = ['-y', ...videoInputs];
  const totalSec = staged.length * CLIP_SEC - (staged.length - 1) * DIP_SEC;
  if (wavSec !== null && wavSec > 0) {
    mergedArgs.push('-i', WAV_PATH);
  }
  mergedArgs.push('-filter_complex', filter.join(';'), '-map', `[${last}]`);
  if (wavSec !== null && wavSec > 0) {
    mergedArgs.push('-map', `${staged.length}:a`, '-t', totalSec.toFixed(3));
  }
  mergedArgs.push(
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(FPS),
    '-movflags',
    '+faststart',
  );
  if (wavSec !== null && wavSec > 0) mergedArgs.push('-c:a', 'aac', '-b:a', '192k');
  mergedArgs.push(MERGED_PATH);
  try {
    run(mergedArgs);
    console.log(
      `[khyos-desktop] 合并版 ${path.relative(PKG_ROOT, MERGED_PATH)}：${staged.length} 场景纸色 dip 相接，总长 ${totalSec.toFixed(1)}s`,
    );
  } catch (err) {
    // xfade 不在这个 ffmpeg 构建里（或滤镜图被拒）就退回硬切，并且必须说出来：
    // 静默产出「没有过渡的合并版」会让下游以为过渡已经在成片里。
    console.error(
      `[khyos-desktop] xfade 不可用（${err && err.message ? err.message : err}），合并版退化为 concat 硬切，场景间无纸色过渡。`,
    );
    const listPath = path.join(OUT_DIR, '.concat-list.txt');
    const lines = scenes.map((s) => {
      const p = path.join(OUT_DIR, `preview-${s.id}.mp4`).replace(/'/g, "'\\''");
      return `file '${p}'`;
    });
    fs.writeFileSync(listPath, `${lines.join('\n')}\n`, 'utf8');
    run(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', MERGED_PATH]);
    fs.rmSync(listPath, { force: true });
    console.error(`[khyos-desktop] 合并版 ${path.relative(PKG_ROOT, MERGED_PATH)}：concat 硬切（无过渡）。`);
  }

  if (hasWav) {
    // libvorbis 而不是 aac：单文件页要把配乐内联成 data URI，ogg 的解码支持
    // 在三大桌面引擎里都无需额外编解码器许可。
    run(['-y', '-i', WAV_PATH, '-c:a', 'libvorbis', '-q:a', '5', OGG_PATH]);
    console.log(`[khyos-desktop] 已转出 ${path.relative(PKG_ROOT, OGG_PATH)}`);
  } else {
    console.error('[khyos-desktop] 未找到 out/score.wav，本片只出画面、无配乐；单文件页将不带内联音频。');
  }
} finally {
  for (const dir of stageDirs) fs.rmSync(dir, { recursive: true, force: true });
}
