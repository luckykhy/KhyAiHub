// audio.js — 纸洲的环境音景与配乐。纯 Web Audio 合成，不引用任何外部音频文件。
//
// 三条约束，改之前先读：
//   1) 确定性。同一份 scenes.json 两次渲染必须字节一致：所有随机都走
//      src/util/rand.js 的 mulberry32（禁 Math.random），噪声与混响脉冲在
//      renderScoreWav 每次调用时按固定种子重建，不留跨次调用的缓存。
//   2) 合成只在页面侧。Node 没有 Web Audio，本文件在 import 时不得触碰
//      window/AudioContext——buildCycle / encodeWavBase64 / make*Samples 全是
//      纯函数，Node 侧可直接 import 做自测。
//   3) 轮播周期 = scenes.json 各场景 durationSec 之和（assemble.mjs 的
//      storyStart 按同样口径累加，配乐错位半秒就能听出来）。整段首尾同调，
//      末事件在周期末之前收完，渲染时再加 loopFadeSec 的线性淡出，循环无咔哒。
//
// 结构：score.json 是编排数据（各场调式/音栓/床/脉冲/提示词映射），本文件是
// 逻辑。buildCycle 把场景表编译成一张确定性事件表；事件表同时喂给
// renderScoreWav（OfflineAudioContext 离线渲染）与 createAudioEngine
// （实时播放），所以页面听到的和落盘的 wav 是同一段生成式长曲。
import score from './score.json' with { type: 'json' };
import scenesData from '../story/scenes.json' with { type: 'json' };
import { mulberry32, hash1 } from '../util/rand.js';

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// 场景表入参兼容三种形态：整份 scenes.json、裸 scenes 数组、以及 main.js 的
// renderScoreWav({ fps }) 那种选项对象（此时回退到 import 进来的场景表）。
function normalizeScenes(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const list = Array.isArray(raw.scenes) ? raw.scenes : Array.isArray(raw) ? raw : null;
  if (!list) return normalizeScenes(scenesData);
  const byId = new Map();
  for (const s of list) {
    if (s && s.id) byId.set(String(s.id), s);
  }
  const order = Array.isArray(raw.cycle) && raw.cycle.length ? raw.cycle : [...byId.keys()];
  const out = [];
  for (const id of order) {
    const s = byId.get(String(id));
    if (!s) continue;
    const durationSec = Number(s.durationSec);
    if (!Number.isFinite(durationSec) || durationSec <= 0) continue;
    out.push({
      id: String(s.id),
      name: String(s.name || s.id),
      durationSec,
      beats: Array.isArray(s.beats) ? s.beats : [],
    });
  }
  if (!out.length) throw new Error('[khyos-desktop] 场景表为空：无从编译配乐。');
  return out;
}

// ---------------------------------------------------------------- 确定性采样源

// 白噪 / 粉噪 / 棕噪。粉噪用 Paul Kellet 的三极点近似，棕噪用泄漏积分——
// 都是纯函数，Node 侧可直接验证两次调用逐样本一致。
export function makeNoiseSamples(seed, seconds, sampleRate, kind) {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const out = new Float32Array(n);
  const rnd = mulberry32(seed);
  if (kind === 'pink') {
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < n; i += 1) {
      const w = rnd() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.28;
    }
    return out;
  }
  if (kind === 'brown') {
    let last = 0;
    for (let i = 0; i < n; i += 1) {
      const w = rnd() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      out[i] = last * 3.2;
    }
    return out;
  }
  for (let i = 0; i < n; i += 1) out[i] = rnd() * 2 - 1;
  return out;
}

// 灯芯噼啪：一串衰减正弦 Ping。整段 11 秒（crackleSeconds）循环播放，
// 周期取不整齐的长度，重复感才不容易被听出来。
export function makeCrackleSamples(seed, seconds, sampleRate, rate) {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const out = new Float32Array(n);
  const rnd = mulberry32(seed);
  const gap = 1 / Math.max(0.2, rate);
  let t = 0.15 + rnd() * gap;
  while (t < seconds - 0.12) {
    const i0 = Math.round(t * sampleRate);
    const len = Math.max(1, Math.round((0.004 + rnd() * 0.01) * sampleRate));
    const amp = 0.35 + rnd() * 0.65;
    const tone = 900 + rnd() * 2200;
    for (let i = 0; i < len && i0 + i < n; i += 1) {
      const k = i / len;
      out[i0 + i] += amp * Math.exp(-k * 6) * (1 - k) * Math.sin(2 * Math.PI * tone * (i / sampleRate));
    }
    t += gap * (0.45 + rnd() * 1.1);
  }
  return out;
}

// 混响脉冲：指数衰减噪声 + 前 90ms 的五个离散早期反射，左右独立取样所以
// 立体声有去相关宽度。
//
// 归一化按 L2 范数（每声道 Σh² = 1）而不是逐样本 RMS：白噪通过滤波器后方差
// 是 σ²·Σh²，按 RMS 归一化会让回声比干声高 √N 倍（2.6 秒 IR 实测 350 倍，
// 整段削顶）。按 L2 归一化后噪声进噪声出等幅，音调响应对应 |H(f)|，量级都由
// 支路增益（hallRet/roomRet）说话。
export function makeImpulseSamples(spec, sampleRate) {
  const n = Math.max(1, Math.round(spec.seconds * sampleRate));
  const pre = Math.round(((spec.preDelayMs || 0) * sampleRate) / 1000);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const rnd = mulberry32(spec.seed);
  for (let i = pre; i < n; i += 1) {
    const k = (i - pre) / (n - pre);
    const env = Math.pow(1 - k, spec.decay);
    l[i] = (rnd() * 2 - 1) * env;
    r[i] = (rnd() * 2 - 1) * env;
  }
  for (let t = 0; t < 5; t += 1) {
    const at = Math.round(pre + (0.008 + rnd() * 0.08) * sampleRate);
    if (at < n) {
      l[at] += 0.5 - rnd();
      r[at] += 0.5 - rnd();
    }
  }
  for (const ch of [l, r]) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += ch[i] * ch[i];
    const norm = Math.sqrt(sum) || 1;
    for (let i = 0; i < n; i += 1) ch[i] /= norm;
  }
  return [l, r];
}

// ---------------------------------------------------------------- 事件表编译

function mkEvent(over) {
  return Object.assign(
    {
      t0: 0,
      dur: 1,
      voice: 'paperChime',
      freq: 440,
      gain: 0.2,
      pan: 0,
      sendHall: 0.4,
      sendRoom: 0.15,
      env: null,
      color: null,
      curve: null,
      scene: '',
      tag: '',
    },
    over,
  );
}

// 五声音阶取音：degree 可越界（自动升八度），octave 再整体移调。
function midiOf(dir, degree, octave) {
  const p = dir.penta;
  const i = ((degree % p.length) + p.length) % p.length;
  const oct = Math.floor(degree / p.length) + (octave || 0);
  return dir.root + 12 * oct + p[i];
}

function pushTheme(out, stmt, dir, S) {
  const th = score.theme;
  const oct = 12 * (stmt.octave || 0);
  const n = stmt.half ? 2 : th.offsets.length;
  for (let i = 0; i < n; i += 1) {
    out.push(
      mkEvent({
        t0: S + stmt.t + th.onsets[i],
        dur: th.durs[i],
        voice: stmt.voice,
        freq: midiToFreq(dir.root + oct + th.offsets[i]),
        gain: stmt.gain * (1 - 0.1 * i),
        pan: (hash1(Math.round((S + stmt.t) * 1000) + i * 7) * 2 - 1) * 0.3,
        tag: 'theme',
        scene: dir.id,
      }),
    );
  }
  // 纸钢琴加气声：主题第一句下垫一层呼吸噪声（场景 1 的 cue 原文即「加气声」）。
  if (stmt.breath) {
    out.push(
      mkEvent({
        t0: S + stmt.t - 0.4,
        dur: 5.4,
        voice: 'breath',
        freq: midiToFreq(dir.root + 24),
        gain: stmt.gain * 0.22,
        pan: 0,
        tag: 'theme',
        scene: dir.id,
      }),
    );
  }
  // 末音上方加一枚纸风铃，让主题句有个亮尾。
  if (stmt.chime) {
    out.push(
      mkEvent({
        t0: S + stmt.t + th.onsets[n - 1] + 0.1,
        dur: 2.6,
        voice: 'paperChime',
        freq: midiToFreq(dir.root + oct + th.offsets[n - 1] + stmt.chime),
        gain: stmt.gain * 0.5,
        pan: 0.2,
        tag: 'theme',
        scene: dir.id,
      }),
    );
  }
}

function pushNotes(out, spec, dir, S, tag) {
  const oct = 12 * (spec.octave || 0);
  for (const nt of spec.notes) {
    out.push(
      mkEvent({
        t0: S + spec.t + nt.dt,
        dur: nt.dur,
        voice: spec.voice,
        freq: midiToFreq(dir.root + oct + nt.offset),
        gain: spec.gain * (nt.gain == null ? 1 : nt.gain),
        pan: clamp((hash1(Math.round((S + spec.t) * 100) + nt.offset) * 2 - 1) * 0.4, -1, 1),
        tag,
        scene: dir.id,
      }),
    );
  }
}

// 提示词 → 音事件。cue 条目按 score.json 里的顺序逐条匹配，同一拍同一音色
// 只发一次（避免「渊的方点列」同时命中 渊 与 方点 两条）。
function pushCues(out, scene, dir, S, rnd) {
  for (const beat of scene.beats) {
    if (!beat || beat.kind === 'music') continue;
    const t = Number(beat.t);
    if (!Number.isFinite(t)) continue;
    const text = `${beat.cue || ''}。${beat.note || ''}`;
    for (const cue of score.cues) {
      if (!cue.match.some((k) => text.includes(k))) continue;
      // 同一拍同一音色只发一次；0.6 秒内的重复也并掉——导演的节拍表不严格
      // 落在步态周期上（渡海 t=9 的「腿落」与 3.2s 栅格上的 9.4 只差 0.4 秒），
      // 两响挨太近会是难听的「双步」。
      const dup = out.some(
        (e) => e.scene === dir.id && e.voice === cue.voice && Math.abs(e.t0 - (S + t)) < 0.6,
      );
      if (dup) continue;
      emitCue(out, cue, S + t, dir, rnd);
    }
  }
}

function emitCue(out, cue, t, dir, rnd) {
  const scene = dir.id;
  if (cue.voice === 'eelShimmer') {
    const n = Math.max(1, cue.spread | 0);
    const burst = cue.mode === 'burst';
    for (let i = 0; i < n; i += 1) {
      out.push(
        mkEvent({
          // 渊的两段语义不同：rise = 从左到右逐个亮起；burst = 九颗同时亮、
          // 再用递增的 dur 从左到右逐个熄灭。
          t0: t + i * cue.step,
          dur: burst ? 0.5 + i * 0.12 : 0.9,
          voice: 'eelShimmer',
          freq: midiToFreq(midiOf(dir, i % 5, cue.octave || 2)),
          gain: cue.gain * (burst ? 1 : 1 - 0.5 * (i / Math.max(1, n - 1))),
          pan: clamp(-0.8 + (1.6 * i) / Math.max(1, n - 1), -1, 1),
          tag: 'cue',
          scene: dir.id,
        }),
      );
    }
    return;
  }
  const count = Math.max(1, cue.count || 1);
  for (let i = 0; i < count; i += 1) {
    const over = {
      t0: t + i * (cue.dt || 0.2),
      dur: cue.dur == null ? 1.2 : cue.dur,
      voice: cue.voice,
      gain: cue.gain * (count > 1 ? Math.pow(0.78, i) : 1),
      pan: clamp((rnd() * 2 - 1) * (cue.pan == null ? 0.5 : cue.pan), -1, 1),
      tag: 'cue',
      scene,
    };
    if (cue.offset != null) over.freq = midiToFreq(dir.root + cue.offset);
    else if (cue.degrees) over.freq = midiToFreq(midiOf(dir, cue.degrees[i % cue.degrees.length], cue.octave || 1));
    else if (cue.degree != null) over.freq = midiToFreq(midiOf(dir, cue.degree, cue.octave || 1));
    else if (cue.freq != null) over.freq = cue.freq;
    else over.freq = midiToFreq(midiOf(dir, 2, 1));
    if (cue.gust) over.color = { sweep: [420, 900, 460] };
    out.push(mkEvent(over));
  }
}

// 把场景表编译成一张覆盖整个轮播周期的事件表。纯函数：同输入两次调用
// 产出逐字段相同的事件表（Node 侧自测就靠这条）。
export function buildCycle(input) {
  const scenes = normalizeScenes(input);
  const events = [];
  const overlap = score.sceneOverlapSec;
  let S = 0;
  for (const scene of scenes) {
    const dirSpec = score.scenes[scene.id];
    if (!dirSpec) {
      throw new Error(`[khyos-desktop] score.json 缺少场景 ${scene.id} 的配乐方向，无从谱曲。`);
    }
    // 拷贝而不改导入对象：同一次进程里 renderScoreWav 可能被调多次，
    // 改导入对象会让第二次的结果依赖第一次的痕迹。
    const dir = Object.assign({}, dirSpec, { id: scene.id });
    const dur = scene.durationSec;
    const rnd = mulberry32(dir.seed);
    const send = dir.send || {};
    const hall = send.hall == null ? 0.45 : send.hall;
    const room = send.room == null ? 0.18 : send.room;
    const level = dir.level == null ? 1 : dir.level;
    const base = (over) =>
      mkEvent(
        Object.assign({ sendHall: hall, sendRoom: room, scene: scene.id }, over, {
          gain: (over.gain == null ? 0.2 : over.gain) * level,
        }),
      );

    if (dir.opening) {
      const o = dir.opening;
      events.push(
        base({
          t0: S + o.t,
          dur: o.dur,
          voice: o.voice,
          freq: o.offset != null ? midiToFreq(dir.root + o.offset) : midiToFreq(midiOf(dir, o.degree || 0, o.octave || 1)),
          gain: o.gain,
          pan: o.pan || 0,
          tag: 'opening',
        }),
      );
    }

    for (const stmt of dir.statements || []) pushTheme(events, stmt, dir, S);
    if (dir.closing) pushNotes(events, dir.closing, dir, S, 'closing');

    // 床（持续音景）：t0 落在场景起点、dur 越过场景末 overlap 秒，释放尾于是
    // 与下一场床的Attack 自然叠化——场景之间不断乐的关键就在这 1.5 秒。
    for (const bed of dir.beds || []) {
      const ev = base({
        t0: S,
        dur: dur + overlap,
        voice: bed.voice,
        freq: bed.freq == null ? midiToFreq(dir.root - 12) : bed.freq,
        gain: bed.gain,
        pan: bed.pan || 0,
        tag: 'bed',
      });
      if (bed.rate != null) ev.color = { rate: bed.rate, seed: dir.seed };
      if (bed.curve) {
        // 曲线值是床增益的倍率，这里换算成绝对增益（含场级 level）；时间相对
        // 事件 t0，实时播放头跳转时整条曲线跟着平移。
        ev.curve = bed.curve.map(([t, g]) => [t, g * bed.gain * level]);
      }
      events.push(ev);
    }

    for (const p of dir.pulses || []) {
      for (let t = p.from; t <= p.to + 1e-6; t += p.every) {
        events.push(
          base({
            t0: S + t,
            dur: p.dur == null ? 0.9 : p.dur,
            voice: p.voice,
            freq: p.freq != null ? p.freq : midiToFreq(midiOf(dir, p.degree || 0, p.octave || 0)),
            gain: p.gain,
            pan: p.pan || 0,
            tag: 'pulse',
          }),
        );
      }
    }

    if (dir.sparkle) {
      const sp = dir.sparkle;
      let t = 1.5 + rnd() * 1.5;
      while (t < dur - 1.2) {
        events.push(
          base({
            t0: S + t,
            dur: 1.6 + rnd(),
            voice: sp.voice,
            freq: midiToFreq(midiOf(dir, Math.floor(rnd() * 7), sp.octave || 1)),
            gain: sp.gain * (0.7 + 0.6 * rnd()),
            pan: (rnd() * 2 - 1) * (sp.pan || 0.5),
            tag: 'sparkle',
          }),
        );
        t += sp.every[0] + rnd() * (sp.every[1] - sp.every[0]);
      }
    }

    if (dir.drizzle) {
      const dz = dir.drizzle;
      let t = dz.from;
      while (t < dz.to) {
        events.push(
          base({
            t0: S + t,
            dur: 0.5,
            voice: dz.voice,
            freq: midiToFreq(midiOf(dir, Math.floor(rnd() * 7), 1)),
            gain: dz.gain * (0.6 + 0.7 * rnd()),
            pan: (rnd() * 2 - 1) * (dz.pan || 0.5),
            tag: 'drizzle',
          }),
        );
        t += dz.every[0] + rnd() * (dz.every[1] - dz.every[0]);
      }
    }

    pushCues(events, scene, dir, S, rnd);
    S += dur;
  }

  const cycleSec = S;
  // 包络在编译期定案：周期末的释放裁剪要知道确切的 r，实时与离线也共用同一张表。
  for (const ev of events) {
    ev.env = Object.assign({}, VOICE_DEFAULTS[ev.voice].env, ev.env || {});
  }
  // 循环点收敛：直接声与释放尾都必须在周期内收完。床的 dur 本来就越过场景
  // 末 1.5 秒（那是场景间的交叉叠化），到周期末要按 r 收回来，否则最后一秒
  // 听到的是床被一刀切。实时循环因此也没有齐平的边界。
  const kept = [];
  for (const ev of events) {
    if (ev.t0 >= cycleSec - 0.05) continue;
    ev.dur = Math.min(ev.dur, cycleSec - 0.05 - ev.t0);
    const withRelease = ev.t0 + ev.dur + ev.env.r;
    if (withRelease > cycleSec - 0.05) {
      ev.dur = Math.max(0.05, cycleSec - 0.05 - ev.t0 - ev.env.r);
    }
    kept.push(ev);
  }
  kept.sort((a, b) => a.t0 - b.t0 || (a.voice < b.voice ? -1 : 1));
  return { cycleSec, events: kept, scenes };
}

// ---------------------------------------------------------------- 音色注册表

const VOICE_DEFAULTS = {
  paperChime: { build: 'fmBell', env: { a: 0.005, d: 2.6, s: 0.0001, r: 0.4 }, fmRatio: 3.01, fmIndex: 1.7, fmSweep: 1.0, cutoff: 7200, q: 0.6 },
  paperPiano: { build: 'piano', env: { a: 0.004, d: 0.6, s: 0.28, r: 1.1 }, cutoff: 2600, q: 0.7, hammer: 0.5 },
  inkStrings: { build: 'strings', env: { a: 1.1, d: 0.9, s: 0.8, r: 2.2 }, cutoff: 950, q: 0.8, lfoRate: 0.13, lfoDepth: 380 },
  woodWind: { build: 'wind', env: { a: 0.14, d: 0.35, s: 0.7, r: 0.7 }, cutoff: 860, q: 1.8, breath: 0.1, vibrato: 4 },
  breath: { build: 'breath', env: { a: 0.6, d: 0.8, s: 0.4, r: 1.2 }, cutoff: 1100, q: 0.9 },
  surfDrone: { build: 'drone', env: { a: 2.2, d: 1.0, s: 0.9, r: 2.6 }, cutoff: 240, q: 0.7, beat: 0.0035, lfoRate: 0.06, lfoDepth: 80 },
  surfWash: { build: 'noiseWash', env: { a: 2.0, d: 1.2, s: 0.85, r: 2.4 }, cutoff: 430, q: 0.7, noise: 'brown', lfoRate: 0.05, lfoDepth: 180 },
  rainBed: { build: 'noiseBand', env: { a: 1.6, d: 1.0, s: 0.9, r: 2.2 }, cutoff: 1700, q: 0.55, noise: 'white', type: 'bandpass' },
  rainHiss: { build: 'noiseBand', env: { a: 1.4, d: 1.0, s: 0.9, r: 2.0 }, cutoff: 4200, q: 0.5, noise: 'white', type: 'highpass' },
  windVoice: { build: 'noiseBand', env: { a: 2.4, d: 1.2, s: 0.9, r: 2.8 }, cutoff: 380, q: 1.1, noise: 'brown', type: 'bandpass', lfoRate: 0.11, lfoDepth: 170, panLfo: 0.05 },
  plink: { build: 'plink', env: { a: 0.002, d: 0.18, s: 0.0001, r: 0.12 }, cutoff: 3200, q: 0.6, drop: 0.42 },
  emberCrackle: { build: 'crackle', env: { a: 0.8, d: 0.6, s: 0.9, r: 1.6 }, cutoff: 1500, q: 0.9 },
  lampHum: { build: 'hum', env: { a: 1.5, d: 0.8, s: 0.95, r: 2.0 }, cutoff: 320, q: 0.7 },
  eelShimmer: { build: 'shimmer', env: { a: 0.01, d: 0.55, s: 0.0001, r: 0.4 }, cutoff: 2600, q: 2.0 },
  shellFlow: { build: 'fmBell', env: { a: 0.002, d: 0.5, s: 0.0001, r: 0.3 }, fmRatio: 1.4142, fmIndex: 2.2, fmSweep: 0.09, cutoff: 900, q: 2.5 },
  stepDrum: { build: 'drum', env: { a: 0.003, d: 0.3, s: 0.0001, r: 0.25 }, cutoff: 340, q: 0.7, drop: 0.45 },
  mothFlutter: { build: 'flutter', env: { a: 0.25, d: 0.4, s: 0.5, r: 0.7 }, cutoff: 2200, q: 1.4, noise: 'white', amFrom: 0.5, amTo: 2.0 },
  letterWhoosh: { build: 'noiseBand', env: { a: 0.35, d: 0.5, s: 0.35, r: 0.9 }, cutoff: 1400, q: 0.8, noise: 'brown', type: 'bandpass', sweep: [900, 2600, 1100] },
  ripple: { build: 'noiseBand', env: { a: 0.3, d: 0.6, s: 0.15, r: 1.0 }, cutoff: 650, q: 0.7, noise: 'white', type: 'bandpass' },
  airHaze: { build: 'noiseWash', env: { a: 2.2, d: 1.0, s: 0.9, r: 2.6 }, cutoff: 5200, q: 0.5, noise: 'white', lfoRate: 0.07, lfoDepth: 900 },
  dronePad: { build: 'pad', env: { a: 2.0, d: 1.0, s: 0.9, r: 2.4 }, cutoff: 520, q: 0.7 },
  screenBlip: { build: 'blip', env: { a: 0.002, d: 0.05, s: 0.0001, r: 0.06 }, cutoff: 2200, q: 0.7 },
  lidClick: { build: 'click', env: { a: 0.002, d: 0.06, s: 0.0001, r: 0.09 }, cutoff: 1100, q: 1.2 },
  emberPing: { build: 'click', env: { a: 0.002, d: 0.09, s: 0.0001, r: 0.12 }, cutoff: 2000, q: 1.4 },
};

function osc(ctx, type, freq, detune) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  if (detune) o.detune.value = detune;
  return o;
}

function gain(ctx, v) {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

function filt(ctx, type, freq, q) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  if (q != null) f.Q.value = q;
  return f;
}

// 噪声源：bed 用 loop（offset 由事件时间散列决定，避免每段床从同一点起），
// 打击性的 transient 不循环。
function noiseSrc(ctx, buffer, at, dur, key, loop) {
  const s = ctx.createBufferSource();
  s.buffer = buffer;
  if (loop) {
    s.loop = true;
    s.start(at, buffer.duration * hash1(key));
    s.stop(at + dur + 0.05);
  } else {
    s.start(at, buffer.duration * hash1(key));
    s.stop(at + dur + 0.02);
  }
  return s;
}

function lfo(ctx, rate, target, depth, at, dur) {
  const o = osc(ctx, 'sine', rate);
  const g = gain(ctx, depth);
  o.connect(g);
  g.connect(target);
  o.start(at);
  o.stop(at + dur + 0.1);
  return o;
}

const VOICE_BUILDERS = {
  // 纸风铃 / 甲缝流光：FM 钟形，调制指数随时间指数衰减出金属尾。
  fmBell(ctx, ev, buf, at, c) {
    const out = gain(ctx, 1);
    const carrier = osc(ctx, 'sine', ev.freq);
    const mod = osc(ctx, 'sine', ev.freq * c.fmRatio);
    const modGain = gain(ctx, 0);
    const idx = Math.max(1, ev.freq * c.fmIndex);
    modGain.gain.setValueAtTime(idx, at);
    modGain.gain.exponentialRampToValueAtTime(Math.max(1, idx * 0.03), at + c.fmSweep);
    mod.connect(modGain);
    modGain.connect(carrier.frequency);
    const f = filt(ctx, 'lowpass', c.cutoff, c.q);
    carrier.connect(f);
    f.connect(out);
    return { tail: out, sources: [carrier, mod] };
  },
  // 纸钢琴：双三角微失谐 + 八度正弦，槌击是一小段高通噪声。
  piano(ctx, ev, buf, at, c) {
    const out = gain(ctx, 1);
    const f = filt(ctx, 'lowpass', c.cutoff, c.q);
    f.connect(out);
    const a = osc(ctx, 'triangle', ev.freq, -6);
    const b = osc(ctx, 'triangle', ev.freq, 6);
    const oct = osc(ctx, 'sine', ev.freq * 2);
    // 八度音直接进滤波器而不是并进 mix：mix 保持 2 输入（≥3 输入的求和顺序
    // 在 Edge 里不稳定，见 createBuses 上方的说明）。0.11 = 0.22 × 0.5，
    // 把原来 mix 的那级缩放折进来。
    const octG = gain(ctx, 0.11);
    const mix = gain(ctx, 0.5);
    a.connect(mix);
    b.connect(mix);
    oct.connect(octG);
    octG.connect(f);
    mix.connect(f);
    const hammer = noiseSrc(ctx, buf.white, at, 0.03, ev.t0 * 1000 + 11, false);
    const hp = filt(ctx, 'highpass', 2400, 0.7);
    const hg = gain(ctx, c.hammer * 0.5);
    hammer.connect(hp);
    hp.connect(hg);
    hg.connect(out);
    a.start(at);
    b.start(at);
    oct.start(at);
    return { tail: out, sources: [a, b, oct, hammer] };
  },
  // 墨弦：三把锯齿（含一个低八度），低通截止被慢 LFO 推着呼吸。
  strings(ctx, ev, buf, at, c) {
    const out = gain(ctx, 1);
    const f = filt(ctx, 'lowpass', c.cutoff, c.q);
    f.connect(out);
    const a = osc(ctx, 'sawtooth', ev.freq, 7);
    const b = osc(ctx, 'sawtooth', ev.freq, -7);
    const low = osc(ctx, 'sawtooth', ev.freq * 0.5);
    const lg = gain(ctx, 0.102); // 0.3 × 0.34：绕过 mix 后折入的缩放
    const mix = gain(ctx, 0.34);
    a.connect(mix);
    b.connect(mix);
    low.connect(lg);
    lg.connect(f);
    mix.connect(f);
    lfo(ctx, c.lfoRate, f.frequency, c.lfoDepth, at, ev.dur + 1);
    a.start(at);
    b.start(at);
    low.start(at);
    return { tail: out, sources: [a, b, low] };
  },
  // 木管：三角波 + 浅颤音，带一层共振峰呼吸噪声。
  wind(ctx, ev, buf, at, c) {
    const out = gain(ctx, 1);
    const f = filt(ctx, 'bandpass', c.cutoff, c.q);
    f.connect(out);
    const o = osc(ctx, 'triangle', ev.freq);
    o.connect(f);
    const vib = lfo(ctx, 5.1, o.detune, c.vibrato, at, ev.dur + 1);
    const breath = noiseSrc(ctx, buf.white, at, ev.dur + 0.4, ev.t0 * 1000 + 23, false);
    const bf = filt(ctx, 'bandpass', 950, 1.2);
    const bg = gain(ctx, c.breath);
    breath.connect(bf);
    bf.connect(bg);
    bg.connect(out);
    o.start(at);
    return { tail: out, sources: [o, vib, breath] };
  },
  // 气声：主题句下的呼吸垫。
  breath(ctx, ev, buf, at, c) {
    const out = gain(ctx, 1);
    const f = filt(ctx, 'bandpass', c.cutoff, c.q);
    f.connect(out);
    const n = noiseSrc(ctx, buf.white, at, ev.dur + 0.6, ev.t0 * 1000 + 31, false);
    n.connect(f);
    return { tail: out, sources: [n] };
  },
  // 涌：两个微失谐正弦互相拍频，墨面下的缓慢起伏。
  drone(ctx, ev, buf, at, c) {
    const out = gain(ctx, 1);
    const f = filt(ctx, 'lowpass', c.cutoff, c.q);
    f.connect(out);
    const a = osc(ctx, 'sine', ev.freq);
    const b = osc(ctx, 'sine', ev.freq * (1 + c.beat));
    const t = osc(ctx, 'triangle', ev.freq * 2);
    const tg = gain(ctx, 0.04); // 0.1 × 0.4：绕过 mix 后折入的缩放
    const mix = gain(ctx, 0.4);
    a.connect(mix);
    b.connect(mix);
    t.connect(tg);
    tg.connect(f);
    mix.connect(f);
    lfo(ctx, c.lfoRate, f.frequency, c.lfoDepth, at, ev.dur + 1);
    a.start(at);
    b.start(at);
    t.start(at);
    return { tail: out, sources: [a, b, t] };
  },
  // 噪声垫（浪涛 / 纸白空气）：循环噪声过lowpass，截止被 LFO 推。
  noiseWash(ctx, ev, buf, at, c) {
    const out = gain(ctx, 1);
    const f = filt(ctx, 'lowpass', c.cutoff, c.q);
    f.connect(out);
    const n = noiseSrc(ctx, buf[c.noise], at, ev.dur, ev.t0 * 1000 + 41, true);
    n.connect(f);
    lfo(ctx, c.lfoRate, f.frequency, c.lfoDepth, at, ev.dur + 1);
    return { tail: out, sources: [n] };
  },
  // 噪声带（雨幕 / 雨嘶 / 风 / 涟漪 / 信笺）：bandpass 或 highpass，
  // 可带截止扫频（letterWhoosh 的纸页穿膛）与风的自带 LFO。
  noiseBand(ctx, ev, buf, at, c) {
    const out = gain(ctx, 1);
    const f = filt(ctx, c.type, c.cutoff, c.q);
    f.connect(out);
    if (c.sweep) {
      const t1 = at + ev.dur * 0.45;
      f.frequency.setValueAtTime(c.sweep[0], at);
      f.frequency.linearRampToValueAtTime(c.sweep[1], t1);
      f.frequency.linearRampToValueAtTime(c.sweep[2], at + ev.dur);
    }
    const n = noiseSrc(ctx, buf[c.noise], at, ev.dur, ev.t0 * 1000 + 43, true);
    const g = gain(ctx, c.sweep ? 0.5 : 1);
    n.connect(g);
    g.connect(f);
    const sources = [n];
    if (c.lfoRate) sources.push(lfo(ctx, c.lfoRate, f.frequency, c.lfoDepth, at, ev.dur + 1));
    return { tail: out, sources };
  },
  // 雨滴 / 墨珠：正弦急坠加一瞬噪声敲击。
  plink(ctx, ev, buf, at, c) {
    const out = gain(ctx, 1);
    const f = filt(ctx, 'lowpass', c.cutoff, c.q);
    f.connect(out);
    const o = osc(ctx, 'sine', ev.freq * (1 / c.drop));
    o.frequency.setValueAtTime(ev.freq / c.drop, at);
    o.frequency.exponentialRampToValueAtTime(ev.freq, at + 0.07);
    o.connect(f);
    const tick = noiseSrc(ctx, buf.white, at, 0.02, ev.t0 * 1000 + 47, false);
    const hp = filt(ctx, 'highpass', 2500, 0.7);
    const tg = gain(ctx, 0.5);
    tick.connect(hp);
    hp.connect(tg);
    tg.connect(out);
    o.start(at);
    return { tail: out, sources: [o, tick] };
  },
  // 灯芯噼啪：预焙的裂纹样本循环。
  crackle(ctx, ev, buf, at, c) {
    const out = gain(ctx, 1);
    const f = filt(ctx, 'bandpass', c.cutoff, c.q);
    f.connect(out);
    const key = `${c.seed}:${c.rate}`;
    let buffer = buf.crackle.get(key);
    if (!buffer) {
      const data = makeCrackleSamples(c.seed + (c.rate * 1000) | 0, buf.crackleSeconds, buf.sampleRate, c.rate);
      buffer = ctx.createBuffer(1, data.length, buf.sampleRate);
      buffer.copyToChannel(data, 0);
      buf.crackle.set(key, buffer);
    }
    const n = noiseSrc(ctx, buffer, at, ev.dur, ev.t0 * 1000 + 53, true);
    n.connect(f);
    return { tail: out, sources: [n] };
  },
  // 灯盏低鸣：跟随全周期的那点交流声般的暖底。
  hum(ctx, ev, buf, at, c) {
    const out = gain(ctx, 1);
    const f = filt(ctx, 'lowpass', c.cutoff, c.q);
    f.connect(out);
    const a = osc(ctx, 'sine', ev.freq);
    const b = osc(ctx, 'sine', ev.freq * 1.5);
    const c2 = osc(ctx, 'triangle', ev.freq * 0.5);
    const bg = gain(ctx, 0.2);
    const cg = gain(ctx, 0.11); // 0.22 × 0.5：绕过 mix 后折入的缩放
    const mix = gain(ctx, 0.5);
    a.connect(mix);
    b.connect(bg);
    bg.connect(mix);
    c2.connect(cg);
    cg.connect(f);
    mix.connect(f);
    a.start(at);
    b.start(at);
    c2.start(at);
    return { tail: out, sources: [a, b, c2] };
  },
  // 渊光方点：成对微失谐高音，快速衰减。
  shimmer(ctx, ev, buf, at, c) {
    const out = gain(ctx, 1);
    const f = filt(ctx, 'bandpass', c.cutoff, c.q);
    f.connect(out);
    const a = osc(ctx, 'sine', ev.freq);
    const b = osc(ctx, 'sine', ev.freq * 1.004);
    const bg = gain(ctx, 0.7);
    a.connect(f);
    b.connect(bg);
    bg.connect(f);
    a.start(at);
    b.start(at);
    return { tail: out, sources: [a, b] };
  },
  // 履步 / 腿落：低频急坠加一团闷响。
  drum(ctx, ev, buf, at, c) {
    const out = gain(ctx, 1);
    const f = filt(ctx, 'lowpass', c.cutoff, c.q);
    f.connect(out);
    const o = osc(ctx, 'sine', ev.freq);
    o.frequency.setValueAtTime(ev.freq, at);
    o.frequency.exponentialRampToValueAtTime(ev.freq * c.drop, at + 0.13);
    o.connect(f);
    const thump = noiseSrc(ctx, buf.brown, at, 0.1, ev.t0 * 1000 + 59, false);
    const tf = filt(ctx, 'lowpass', 180, 0.8);
    const tg = gain(ctx, 0.7);
    thump.connect(tf);
    tf.connect(tg);
    tg.connect(out);
    o.start(at);
    return { tail: out, sources: [o, thump] };
  },
  // 羽振：噪声被 LFO 幅度调制，调制频率在事件内从 amFrom 渐到 amTo。
  flutter(ctx, ev, buf, at, c) {
    const out = gain(ctx, 1);
    const f = filt(ctx, 'bandpass', c.cutoff, c.q);
    f.connect(out);
    const n = noiseSrc(ctx, buf[c.noise], at, ev.dur, ev.t0 * 1000 + 61, true);
    const am = gain(ctx, 0);
    const lf = osc(ctx, 'sine', c.amFrom);
    const lg = gain(ctx, 0.5);
    lf.frequency.linearRampToValueAtTime(Math.max(0.1, c.amTo), at + ev.dur);
    lf.connect(lg);
    lg.connect(am.gain);
    n.connect(am);
    am.connect(f);
    lf.start(at);
    return { tail: out, sources: [n, lf] };
  },
  // 持续和声：根音 + 五度 + 八度，场景之间的调性锚。
  pad(ctx, ev, buf, at, c) {
    const out = gain(ctx, 1);
    const f = filt(ctx, 'lowpass', c.cutoff, c.q);
    f.connect(out);
    const a = osc(ctx, 'sine', ev.freq);
    const b = osc(ctx, 'sine', ev.freq * 1.4983);
    const c2 = osc(ctx, 'triangle', ev.freq * 2);
    const bg = gain(ctx, 0.4);
    const cg = gain(ctx, 0.0408); // 0.12 × 0.34：绕过 mix 后折入的缩放
    const mix = gain(ctx, 0.34);
    a.connect(mix);
    b.connect(bg);
    bg.connect(mix);
    c2.connect(cg);
    cg.connect(f);
    mix.connect(f);
    a.start(at);
    b.start(at);
    c2.start(at);
    return { tail: out, sources: [a, b, c2] };
  },
  // 信匣丁的屏：方波短嘀，带通后就是那点墨字光标的意思。
  blip(ctx, ev, buf, at, c) {
    const out = gain(ctx, 1);
    const f = filt(ctx, 'lowpass', c.cutoff, c.q);
    f.connect(out);
    const o = osc(ctx, 'square', ev.freq);
    const g = gain(ctx, 0.25);
    o.connect(g);
    g.connect(f);
    o.start(at);
    return { tail: out, sources: [o] };
  },
  // 合盖 / 火星：一小段带通噪声。
  click(ctx, ev, buf, at, c) {
    const out = gain(ctx, 1);
    const f = filt(ctx, 'bandpass', c.cutoff, c.q);
    f.connect(out);
    const n = noiseSrc(ctx, buf.white, at, Math.min(0.05, ev.dur), ev.t0 * 1000 + 67, false);
    n.connect(f);
    return { tail: out, sources: [n] };
  },
};

// ---------------------------------------------------------------- 调度

function applyADSR(param, at, dur, env, peak) {
  let a = Math.max(0.002, env.a);
  let d = Math.max(0.01, env.d);
  const p = Math.max(0.0002, peak);
  const s = clamp(env.s * p, 0.0001, p);
  const r = Math.max(0.02, env.r);
  const span = Math.max(0.05, dur);
  if (a + d > span) {
    const k = span / (a + d);
    a *= k;
    d *= k;
  }
  param.setValueAtTime(0.0001, at);
  param.exponentialRampToValueAtTime(p, at + a);
  param.exponentialRampToValueAtTime(s, at + a + d);
  param.setValueAtTime(s, at + span);
  param.exponentialRampToValueAtTime(0.0001, at + span + r);
}

function applyCurve(param, at, curve) {
  param.setValueAtTime(curve[0][1], at);
  for (let i = 1; i < curve.length; i += 1) {
    param.linearRampToValueAtTime(curve[i][1], at + curve[i][0]);
  }
}

// 混合必须走「每结点最多 2 输入」的结构：IEEE754 加法可交换但不可结合，
// Edge 对一个结点上 ≥3 条连接的求和顺序不保证稳定（实测 8 条输入两次渲染
// 就有 ±1e-7 漂移）。这就是「同输入两次渲染字节一致」的地基，改混合结构前
// 先读这段。
//
// tree=false 时退化成直连 trunk 的扇入：实时播放不需要字节一致，而扇入能让
// 播完的声部整条 release 掉、不在总线里留死结点。trunk 是稳定输出，两种
// 模式下收口结点都不变。
class Mixer {
  constructor(ctx, tree) {
    this.ctx = ctx;
    this.tree = tree;
    this.trunk = ctx.createGain();
    this.trunk.gain.value = 1;
    this.root = null;
  }

  add(node) {
    if (!this.tree) {
      node.connect(this.trunk);
      return;
    }
    if (!this.root) {
      this.root = node;
      node.connect(this.trunk);
      return;
    }
    const m = this.ctx.createGain();
    m.gain.value = 1; // ×1 是精确乘，不引入额外误差
    this.root.connect(m);
    node.connect(m);
    // 先接后摘：实时模式下 trunk 不会出现瞬时零输入（那会是一声咔哒）。
    m.connect(this.trunk);
    this.root.disconnect(this.trunk);
    this.root = m;
  }
}

function convolverFrom(ctx, spec, sampleRate) {
  const conv = ctx.createConvolver();
  conv.normalize = false;
  const [l, r] = makeImpulseSamples(spec, sampleRate);
  const b = ctx.createBuffer(2, l.length, sampleRate);
  b.copyToChannel(l, 0);
  b.copyToChannel(r, 1);
  conv.buffer = b;
  return conv;
}

// tree=true 给离线渲染（字节一致），false 给实时播放。master 的三个输入也走
// 同一棵树，建总线时一次性接齐。
function createBuses(ctx, sampleRate, tree) {
  const dry = new Mixer(ctx, tree);
  const hallIn = new Mixer(ctx, tree);
  const roomIn = new Mixer(ctx, tree);

  const hall = convolverFrom(ctx, score.reverb.hall, sampleRate);
  hallIn.trunk.connect(hall);
  const hallRet = gain(ctx, 0.6);
  hall.connect(hallRet);

  const room = convolverFrom(ctx, score.reverb.room, sampleRate);
  roomIn.trunk.connect(room);
  const roomRet = gain(ctx, 0.5);
  room.connect(roomRet);

  const master = new Mixer(ctx, tree);
  master.add(dry.trunk);
  master.add(hallRet);
  master.add(roomRet);

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -15;
  comp.knee.value = 8;
  comp.ratio.value = 3;
  comp.attack.value = 0.004;
  comp.release.value = 0.25;
  const out = gain(ctx, 1);
  master.trunk.connect(comp);
  comp.connect(out);
  out.connect(ctx.destination);

  return { master: master.trunk, dry, hallIn, roomIn };
}

function prepareBuffers(ctx, sampleRate) {
  const spec = score.noise;
  const mk = (kind, salt) => {
    const data = makeNoiseSamples(spec.seed + salt, spec.seconds, sampleRate, kind);
    const b = ctx.createBuffer(1, data.length, sampleRate);
    b.copyToChannel(data, 0);
    return b;
  };
  return {
    white: mk('white', 0),
    pink: mk('pink', 101),
    brown: mk('brown', 202),
    crackle: new Map(),
    crackleSeconds: spec.crackleSeconds,
    sampleRate,
  };
}

// 把一个事件落到上下文里。offline 与实时两条路共用，所以一切自动化都相对
// at（而不是事件表里的 t0）——实时播放头跳转时事件要能整体平移。
function scheduleVoice(ctx, ev, buses, buffers, at) {
  const def = VOICE_DEFAULTS[ev.voice];
  if (!def) throw new Error(`[khyos-desktop] 未知音色 ${ev.voice}（score.json 的 cues 指向了未注册的音栓）`);
  const color = Object.assign({}, def, ev.color || {});
  const env = Object.assign({}, def.env, ev.env || {});
  const built = VOICE_BUILDERS[def.build](ctx, ev, buffers, at, color);

  // 床的电平由曲线驱动时不再套一层增益，省下的结点都是渲染耗时。
  const shaped = built.tail;
  let envIn = shaped;
  if (ev.curve && ev.curve.length) {
    const bedGain = gain(ctx, 1);
    applyCurve(bedGain.gain, at, ev.curve);
    shaped.connect(bedGain);
    envIn = bedGain;
  }

  const envGain = gain(ctx, 0.0001);
  applyADSR(envGain.gain, at, ev.dur, env, ev.curve && ev.curve.length ? 1 : ev.gain);
  envIn.connect(envGain);

  const panner = ctx.createStereoPanner();
  panner.pan.value = clamp(ev.pan, -1, 1);
  envGain.connect(panner);
  buses.dry.add(panner);
  const sends = [];
  if (ev.sendHall > 0) {
    const g = gain(ctx, ev.sendHall);
    panner.connect(g);
    buses.hallIn.add(g);
    sends.push(g);
  }
  if (ev.sendRoom > 0) {
    const g = gain(ctx, ev.sendRoom);
    panner.connect(g);
    buses.roomIn.add(g);
    sends.push(g);
  }

  const stopAt = at + ev.dur + env.r + 0.1;
  for (const s of built.sources) {
    try {
      s.stop(stopAt);
    } catch {
      // 已经 stop 过的源（部分 builder 内部提前 stop）再 stop 会抛，忽略即可。
    }
  }
  return {
    stopAt,
    envGain,
    sources: built.sources,
    // 实时播放的回收：播完的声部整条断开，否则跨轮播会把总线叶子塞满。
    release() {
      for (const n of [envIn, envGain, panner, ...sends]) {
        try {
          n.disconnect();
        } catch {
          // 已断开的结点再断会抛，忽略。
        }
      }
      for (const s of built.sources) {
        try {
          s.disconnect();
        } catch {
          // 同上。
        }
      }
      built.tail.disconnect();
    },
  };
}

// ---------------------------------------------------------------- 离线渲染

function applyLoopFade(buffer, sampleRate, fadeSec) {
  const n = Math.min(buffer.length, Math.round(fadeSec * sampleRate));
  if (n <= 1) return;
  const l = buffer.getChannelData(0);
  const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  for (let i = 0; i < n; i += 1) {
    const k = 1 - i / (n - 1);
    const idx = buffer.length - n + i;
    l[idx] *= k;
    if (r) r[idx] *= k;
  }
  l[buffer.length - 1] = 0;
  if (r) r[buffer.length - 1] = 0;
}

function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// 16bit PCM / 立体声 / 48kHz 的 RIFF。入参只要是 AudioBuffer 形状
// （sampleRate/length/numberOfChannels/getChannelData）就能编码，Node 侧可测。
export function encodeWavBase64(buffer) {
  const channels = Math.max(1, Math.min(2, buffer.numberOfChannels));
  const n = buffer.length;
  const dataBytes = n * channels * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const dv = new DataView(bytes.buffer);
  const ascii = (off, s) => {
    for (let i = 0; i < s.length; i += 1) bytes[off + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, buffer.sampleRate, true);
  dv.setUint32(28, buffer.sampleRate * channels * 2, true);
  dv.setUint16(32, channels * 2, true);
  dv.setUint16(34, 16, true);
  ascii(36, 'data');
  dv.setUint32(40, dataBytes, true);
  const l = buffer.getChannelData(0);
  const r = channels > 1 ? buffer.getChannelData(1) : l;
  let o = 44;
  for (let i = 0; i < n; i += 1) {
    let v = l[i] * 32767;
    dv.setInt16(o, v < 0 ? Math.max(-32768, Math.round(v)) : Math.min(32767, Math.round(v)), true);
    o += 2;
    v = r[i] * 32767;
    dv.setInt16(o, v < 0 ? Math.max(-32768, Math.round(v)) : Math.min(32767, Math.round(v)), true);
    o += 2;
  }
  return bytesToBase64(bytes);
}

// 入参兼容 (scenes, sampleRate) 与 main.js 的单个选项对象
// （renderScoreWav({ fps })——fps 与音频无关，收了不报错即可）。
export async function renderScoreWav(scenesOrOptions, sampleRateArg) {
  const isScenes =
    Array.isArray(scenesOrOptions) ||
    (scenesOrOptions && typeof scenesOrOptions === 'object' && Array.isArray(scenesOrOptions.scenes));
  const options = isScenes
    ? { scenes: scenesOrOptions, sampleRate: sampleRateArg }
    : Object.assign({}, scenesOrOptions || {});
  const cycle = buildCycle(options.scenes || scenesData);
  const sampleRate =
    Number(options.sampleRate) > 0 ? Number(options.sampleRate) : Number(score.sampleRate) || 48000;

  const OfflineCtx = typeof window !== 'undefined' ? window.OfflineAudioContext : null;
  if (!OfflineCtx) {
    throw new Error(
      '[khyos-desktop] 本环境没有 OfflineAudioContext：配乐渲染只能在浏览器里跑（Node 无 Web Audio）。',
    );
  }
  const length = Math.ceil(cycle.cycleSec * sampleRate);
  const ctx = new OfflineCtx(2, length, sampleRate);
  const buses = createBuses(ctx, sampleRate, true);
  const buffers = prepareBuffers(ctx, sampleRate);
  for (const ev of cycle.events) {
    scheduleVoice(ctx, ev, buses, buffers, ev.t0);
  }
  const rendered = await ctx.startRendering();
  applyLoopFade(rendered, sampleRate, score.loopFadeSec);
  return encodeWavBase64(rendered);
}

// ---------------------------------------------------------------- 实时引擎

export function createAudioEngine(scenesOrOptions) {
  const cycle = buildCycle(scenesOrOptions || scenesData);
  const Ctx =
    typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
  const LOOKAHEAD = 0.4;
  const TICK_MS = 60;

  let ctx = null;
  let buses = null;
  let buffers = null;
  let playing = false;
  let originPos = 0;
  let origin = 0;
  let cursor = 0;
  let live = [];
  let timer = 0;
  let lastPos = 0;
  let sceneId = cycle.scenes[0].id;

  const sceneStart = (id) => {
    let t = 0;
    for (const s of cycle.scenes) {
      if (s.id === id) return t;
      t += s.durationSec;
    }
    return 0;
  };

  function ensure() {
    if (ctx) return true;
    if (!Ctx) return false;
    ctx = new Ctx({ latencyHint: 'interactive' });
    // 实时模式扇入：不需要字节一致，换来的是播完即 release、总线不堆积。
    buses = createBuses(ctx, ctx.sampleRate, false);
    buffers = prepareBuffers(ctx, ctx.sampleRate);
    return true;
  }

  const position = () => (ctx && playing ? originPos + (ctx.currentTime - origin) : originPos);

  function firstEventAt(t) {
    let lo = 0;
    let hi = cycle.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cycle.events[mid].t0 < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function cancelLive() {
    if (!ctx) {
      live = [];
      return;
    }
    const now = ctx.currentTime;
    const dying = live;
    live = [];
    for (const h of dying) {
      h.envGain.gain.cancelScheduledValues(now);
      h.envGain.gain.setTargetAtTime(0.0001, now, 0.012);
      for (const s of h.sources) {
        try {
          s.stop(now + 0.12);
        } catch {
          // 已在停止路径上的源再 stop 会抛，忽略。
        }
      }
    }
    // 淡出走完再整条回收：立刻 disconnect 会把 0.12 秒的淡出切成一声咔哒。
    setTimeout(() => {
      for (const h of dying) h.release();
    }, 260);
  }

  function scheduleAhead() {
    if (!playing || !ctx) return;
    const now = position();
    const horizon = now + LOOKAHEAD;
    for (; cursor < cycle.events.length; cursor += 1) {
      const ev = cycle.events[cursor];
      if (ev.t0 >= horizon) break;
      const at = origin + (ev.t0 - originPos);
      if (at < ctx.currentTime - 0.05) continue;
      live.push(scheduleVoice(ctx, ev, buses, buffers, at));
    }
    if (cursor >= cycle.events.length) {
      // 轮遍：播放头归零，已排到周期外的尾音继续自然衰减，与下一轮开头叠上。
      cursor = 0;
      originPos = 0;
      origin = ctx.currentTime;
    }
    // 播完的声部整条回收：不回收的话每轮播都会往总线叶子上堆一批死结点。
    const kept = [];
    for (const h of live) {
      if (h.stopAt > ctx.currentTime + 0.1) kept.push(h);
      else h.release();
    }
    live = kept;
    lastPos = position();
  }

  function retarget(id) {
    sceneId = id;
    originPos = sceneStart(id);
    origin = ctx.currentTime + 0.06;
    cursor = firstEventAt(originPos);
  }

  function fadeMaster(down) {
    if (!buses) return;
    const now = ctx.currentTime;
    buses.master.gain.cancelScheduledValues(now);
    if (down) {
      buses.master.gain.setTargetAtTime(0.0001, now, 0.02);
      buses.master.gain.setTargetAtTime(1, now + 0.05, 0.09);
    } else {
      buses.master.gain.setTargetAtTime(1, now, 0.09);
    }
  }

  return {
    get cycleSec() {
      return cycle.cycleSec;
    },
    start() {
      if (playing) return Promise.resolve();
      if (!ensure()) {
        throw new Error('[khyos-desktop] 本浏览器无 Web Audio，实时引擎起不来。');
      }
      ctx.resume().catch(() => {});
      retarget(sceneId);
      playing = true;
      fadeMaster(true);
      scheduleAhead();
      timer = setInterval(scheduleAhead, TICK_MS);
      return Promise.resolve();
    },
    stop() {
      if (!playing) return;
      playing = false;
      clearInterval(timer);
      timer = 0;
      cancelLive();
      if (ctx) ctx.suspend().catch(() => {});
      // 停在此场起点：再 start() 时该场主题从头（与场景表 onSwitch 的口径一致）。
      originPos = sceneStart(sceneId);
      origin = 0;
      cursor = firstEventAt(originPos);
    },
    // 播放头在轮播周期内的秒数；未播放时停在该场起点。
    time() {
      return Math.max(0, playing ? position() : originPos);
    },
    suspend() {
      if (ctx && ctx.state === 'running') return ctx.suspend();
      return Promise.resolve();
    },
    resume() {
      if (ctx && ctx.state === 'suspended') return ctx.resume();
      return Promise.resolve();
    },
    // 切场：整张节拍表复位到目标场 t=0，配乐主题从头，bed 交叉叠化不断乐。
    setScene(id) {
      const target = String(id);
      if (!cycle.scenes.some((s) => s.id === target)) {
        throw new Error(`[khyos-desktop] 未知场景 ${target}（可用：${cycle.scenes.map((s) => s.id).join(', ')}）`);
      }
      if (!ctx || !playing) {
        sceneId = target;
        originPos = sceneStart(target);
        cursor = firstEventAt(originPos);
        return;
      }
      cancelLive();
      fadeMaster(true);
      retarget(target);
      scheduleAhead();
    },
    get currentScene() {
      return sceneId;
    },
  };
}
