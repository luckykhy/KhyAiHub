// main.js — Khy OS 桌面的页面侧装配入口。
//
// 三条约束都是被采集链路逼出来的，改之前先读：
//   1) renderSceneAt(sceneId, t) 只许由 (sceneId, t) 决定。capture 按
//      t=i/24 逐场景取帧，jumpcut 与 extract-check 都比对相邻帧字节；
//      任何读墙钟或跨调用累加状态的写法，都会把「同一 t 两次渲染不一致」
//      变成不可排查的玄学。
//   2) captureDataURL 必须在同一个 JS 任务里 render + 读画布。合成器在
//      任务结束后才清空绘图缓冲，拆成两次 evaluate 只会拿到全黑帧。
//   3) 四个集成模块缺一个就要响亮报错。静默降级会让「画面在动」掩盖
//      「导演还没接线」——那是本页最贵的故障模式。
import * as THREE from 'three';
import storyData from './story/scenes.json' with { type: 'json' };

const FPS = 24;
const WIDTH = 1280;
const HEIGHT = 720;

// 导演不声明时长时的轮播槽位长度。场景表（src/story/scenes.json）才是权威，
// capture 会拿它逐场景定帧数；这里只是让导演沉默时轮播不至于停摆。
const DEFAULT_SLOT_SEC = 12;
// 场景间溶解时长，与 assemble.mjs 合并版里的纸色 dip 保持一致——两处不同步
// 会让「页面看到的切换」和「成片看到的切换」是两种东西。
const TRANSITION_SEC = 0.5;
// 光标隐藏的空闲门限：桌面主要是用来看的。
const IDLE_SEC = 3;

const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'frame' ? 'frame' : 'play';
const frameScene = params.get('scene');
const frameT = Number(params.get('t'));

const canvas = document.getElementById('khyos-stage');
const hud = document.getElementById('khyos-hud');
const hudScene = document.getElementById('khyos-hud-scene');
const hudProgress = document.getElementById('khyos-hud-progress');
const errorBox = document.getElementById('khyos-error');

const perf = {
  compileMs: 0,
  compileAsyncMs: 0,
  firstFrameMs: 0,
  frameCount: 0,
  lastFrameMs: 0,
};

const warnings = [];

function report(message) {
  // 一条消息两处落地：控制台给开发，DOM 给肉眼——录屏时只有 DOM 能被看见。
  warnings.push(message);
  console.error(message);
  if (!errorBox) return;
  errorBox.hidden = false;
  errorBox.textContent += (errorBox.textContent ? '\n' : '') + message;
}

function fail(message) {
  report(message);
  // 失败态也要挂上 window.__khyos：capture.mjs 等的是它，要拿到的是原因，
  // 而不是一个 120 秒超时。
  window.__khyos = {
    mode,
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    perf,
    warnings,
    error: message,
    ready: Promise.resolve(false),
    size() {
      return { width: canvas.width, height: canvas.height };
    },
  };
  throw new Error(message);
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  // 保留缓冲会让每一帧都多一次全屏拷贝，而 captureDataURL 本来就在同一个
  // 任务里读画布，不需要它。
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(1);
renderer.setSize(WIDTH, HEIGHT, false);

// 逐个串行加载：四个模块互相之间可能有依赖，并行加载会让「谁先失败」
// 的顺序不稳定，而报错信息里的模块名要能复现。
// import() 的实参必须是字面量，否则 esbuild 无法内联，单文件页离线打开时会
// 去 dist/ 下找不存在的文件；build.mjs 用一个插件把缺失的模块换成运行期
// throw，所以缺文件时 build 仍然过得去、运行时报错足够响。
const modules = {};
const loaders = {
  pipeline: () => import('./pipeline.js'),
  director: () => import('./director.js'),
  audio: () => import('./audio.js'),
  models: () => import('./models.js'),
};
for (const name of ['pipeline', 'director', 'audio', 'models']) {
  try {
    modules[name] = await loaders[name]();
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    fail(
      `[khyos-desktop] 集成模块缺失 src/${name}.js：${detail}。页面不做降级渲染——缺模块时必须响亮报错，静默降级会掩盖「导演还没接线」。`,
    );
  }
}

const directorModule = modules.director;
if (!directorModule || typeof directorModule.createDirector !== 'function') {
  fail('[khyos-desktop] src/director.js 未导出 createDirector()：导演模块没有接线入口，页面拒绝渲染。');
}
if (!modules.pipeline || typeof modules.pipeline.createPipeline !== 'function') {
  fail('[khyos-desktop] src/pipeline.js 未导出 createPipeline()：渲染管线没有接线入口，页面拒绝渲染。');
}

// 场景表是采集链与页面共认的真源：capture 按它逐场景定帧，轮播槽位与 HUD 也
// 按它——三处不能是三个口径。
const storyById = new Map(storyData.scenes.map((s) => [s.id, s]));

// 场景图与透视相机归调用方：导演的 dispose 契约写明 scene/camera/pipeline 由
// 调用方建、调用方留，createDirector 只拿它们排戏。近平面 0.5m 是按全场最近
// 的相机-主体距离（约 2m）留的余量——再小会让 16 位深度缓冲在湿滩光带那
// 12mm 高差上出锯齿，再大会切掉贴镜的部件。
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, WIDTH / HEIGHT, 0.5, 2000);
const pipeline = modules.pipeline.createPipeline(renderer, scene, camera, {
  width: WIDTH,
  height: HEIGHT,
});

// 导演契约（createDirector 入参）：{ scene, camera, pipeline, models, scenes? }。
// models 是 { [castId]: model }，cast.json 五个 id 一个不能少——缺一件
// createDirector 就地抛错，不静默少一个主体。scenes 显式传页面读的同一份
// 场景表，导演与页面因此不可能是两个口径。
const director = directorModule.createDirector({
  scene,
  camera,
  pipeline,
  models: {
    'lampkeeper-que': modules.models.lampkeeperQue,
    'inbox-ding': modules.models.inboxDing,
    'paper-moth-jian': modules.models.paperMothJian,
    'tortoise-dai': modules.models.tortoiseDai,
    'ink-eel-yuan': modules.models.inkEelYuan,
  },
  scenes: storyData,
});

// 页面侧图形契约：导演的方法适配成页面循环要的面。update(t, sceneId) 走导演的
// renderSceneAt——它内部 applyFrame + pipeline.render，末次 blit 就落在画布上；
// 页面不再自己 renderer.render，否则会把后处理链的成品盖成未调色的原图，
// 那是「画面在动、全链白接」的静默故障。
const graph = {
  scene,
  camera,
  sceneIds: director.sceneIds,
  setScene: director.setScene,
  currentScene: director.currentScene,
  update: (t, sceneId) => director.renderSceneAt(sceneId, t),
  transition: (fromId, toId, k) => director.renderTransition(fromId, toId, k),
  resize: (w, h) => pipeline.setSize(w, h),
};

const sceneIds = director.sceneIds;
if (!sceneIds().length) {
  fail('[khyos-desktop] src/director.js 的 sceneIds() 返回空表：桌面至少需要一个场景，空表等于没有可渲染内容。');
}
const sceneTitle = (id) => storyById.get(id)?.name || id;
const slotSec = (id) => {
  const declared = Number(storyById.get(id)?.durationSec);
  return declared > 0 ? declared : DEFAULT_SLOT_SEC;
};
const midT = (id) => slotSec(id) / 2;

function resize() {
  const w = Math.max(1, canvas.clientWidth || WIDTH);
  const h = Math.max(1, canvas.clientHeight || HEIGHT);
  renderer.setSize(w, h, false);
  if (typeof graph.resize === 'function') graph.resize(w, h);
  if (graph.camera.isPerspectiveCamera) {
    graph.camera.aspect = w / h;
    graph.camera.updateProjectionMatrix();
  }
}
window.addEventListener('resize', resize);
resize();

// 着色器全部预编译完再进首帧：否则第一帧的耗时里混着编译时间，
// perf.avgFrameMs 会被一个孤立的尖峰污染，调优时看不出真实水平。
const compileStart = performance.now();
renderer.compile(graph.scene, graph.camera);
perf.compileMs = performance.now() - compileStart;

if (typeof renderer.compileAsync === 'function') {
  const asyncStart = performance.now();
  await renderer.compileAsync(graph.scene, graph.camera);
  perf.compileAsyncMs = performance.now() - asyncStart;
}

let activeScene = graph.currentScene();

function renderAt(t) {
  const time = Number.isFinite(t) ? t : 0;
  const started = performance.now();
  graph.update(time, activeScene);
  perf.lastFrameMs = performance.now() - started;
  perf.frameCount += 1;
  return time;
}

function renderSceneAt(sceneId, t) {
  const time = Number.isFinite(t) ? t : 0;
  graph.setScene(sceneId);
  activeScene = sceneId;
  const started = performance.now();
  graph.update(time, sceneId);
  perf.lastFrameMs = performance.now() - started;
  perf.frameCount += 1;
  return time;
}

// 与 renderSceneAt 同任务完成：任务一结束合成器就会清空绘图缓冲，
// 跨任务读取只能得到全黑 PNG，而全黑帧会让 jumpcut 把整段判成瞬移。
function captureDataURL(sceneId, t) {
  renderSceneAt(sceneId, t);
  return canvas.toDataURL('image/png');
}

// k∈[0,1] 在两侧场景的中值帧之间溶解。中值点固定，selftest 才能逐字节
// 复建两边（scripts/capture.mjs --selftest 的第三项判据）。
function captureTransitionDataURL(fromId, toId, k) {
  const mix = Math.min(1, Math.max(0, Number.isFinite(k) ? k : 0));
  if (typeof graph.transition === 'function') {
    graph.transition(fromId, toId, mix);
    perf.frameCount += 1;
    return canvas.toDataURL('image/png');
  }
  // 没有导演侧过渡时的兜底：两张画布帧画进 2D 画布做交叉溶解。同样同任务、
  // 同样确定，且不可能悄悄产出黑帧——drawImage 不碰 WebGL 绘图缓冲。
  const sheet = document.createElement('canvas');
  sheet.width = canvas.width;
  sheet.height = canvas.height;
  const ctx = sheet.getContext('2d');
  renderSceneAt(fromId, midT(fromId));
  ctx.drawImage(canvas, 0, 0);
  renderSceneAt(toId, midT(toId));
  ctx.globalAlpha = mix;
  ctx.drawImage(canvas, 0, 0);
  return sheet.toDataURL('image/png');
}

function renderScoreWav(options) {
  if (modules.audio && typeof modules.audio.renderScoreWav === 'function') {
    // 约定：audio 模块返回 data:audio/wav;base64,... 形式的数据 URL，
    // 调用方截取逗号后落盘 out/score.wav。未接线时不得返回空音频冒充成功。
    return modules.audio.renderScoreWav({ fps: FPS, ...(options || {}) });
  }
  throw new Error(
    '[khyos-desktop] renderScoreWav 未接线：src/audio.js 未导出 renderScoreWav。',
  );
}

// Web Audio 时钟：影片时长与配乐必须同源，墙钟会被掉帧与休眠拖偏，
// 而 audioCtx.currentTime 与解码后的配乐走同一条采样时钟。
let audioCtx = null;
let audioStart = 0;
let masterGain = null;
// 没有 Web Audio 时的兜底时钟。它照样是单调的，但和配乐不同源——
// 所以只在确实拿不到 AudioContext 时启用，并且要说出来。
let fallbackStart = 0;
let muted = false;

function ensureAudio() {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    fallbackStart = performance.now();
    report('[khyos-desktop] 本浏览器无 Web Audio，播放模式改用 performance.now() 兜底时钟（与配乐不同源）。');
    return null;
  }
  audioCtx = new Ctx();
  audioStart = audioCtx.currentTime + 0.2;
  return audioCtx;
}

function clockNow() {
  if (audioCtx) return Math.max(0, audioCtx.currentTime - audioStart);
  if (fallbackStart) return Math.max(0, (performance.now() - fallbackStart) / 1000);
  return 0;
}

function toggleMute() {
  muted = !muted;
  if (masterGain) masterGain.gain.value = muted ? 0 : 1;
}

// 单文件页由 build.mjs 把 out/score.ogg 内联成 data URI 注入这个全局；
// 拿不到配乐时播放模式照样跑，只是影音不同步——这一点必须说出来。
async function startScore() {
  const ctx = ensureAudio();
  if (!ctx) return;
  const src = window.__KHYOS_SCORE_SRC;
  if (!src) {
    report('[khyos-desktop] 未内联配乐（out/score.ogg 缺失），播放模式只有画面。');
    return;
  }
  try {
    if (ctx.state === 'suspended') await ctx.resume();
    const bytes = await (await fetch(src)).arrayBuffer();
    const buffer = await ctx.decodeAudioData(bytes);
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 1;
    masterGain.connect(ctx.destination);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(masterGain);
    node.start(audioStart);
  } catch (err) {
    report(`[khyos-desktop] 配乐加载失败：${err && err.message ? err.message : err}。播放模式只有画面。`);
  }
}

// 自动播放策略会挂起 AudioContext；没有这一步，播放模式的时钟永远停在 0，
// 而画面看起来像卡死，很难和「导演没接线」区分开。
for (const evt of ['pointerdown', 'keydown']) {
  window.addEventListener(evt, () => {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  });
}

function updateHud(progressScene, progress) {
  if (!hud) return;
  const ids = sceneIds();
  const idx = Math.max(0, ids.indexOf(progressScene));
  hudScene.textContent = `${sceneTitle(progressScene)}（${idx + 1}/${ids.length}）`;
  hudProgress.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
}

function toggleHud() {
  if (!hud) return;
  hud.hidden = !hud.hidden;
}

function toggleFullscreen() {
  // 拒绝就是浏览器在说「不」（无用户手势、权限策略）；桌面继续窗口化运行，
  // 不该为此死掉。
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}

// 指针视差只是展示态：采集从不触发指针事件，无头环境里偏移恒为 0，
// 帧字节因此可复现。
let parallaxX = 0;
let parallaxY = 0;
let cursorHideTimer = 0;

function markActive() {
  document.body.classList.remove('idle');
  clearTimeout(cursorHideTimer);
  // 光标隐藏的 cooldown：桌面主要是用来看的，3 秒不动光标就退场。
  cursorHideTimer = setTimeout(() => document.body.classList.add('idle'), IDLE_SEC * 1000);
}

function applyParallax() {
  if (typeof graph.parallax === 'function') graph.parallax(parallaxX, parallaxY);
}

let slotStart = 0;
let transition = null;

function beginScene(id, now) {
  graph.setScene(id);
  activeScene = id;
  slotStart = now;
  transition = null;
}

function nextSceneId(step) {
  const ids = sceneIds();
  const i = ids.indexOf(activeScene);
  return ids[(i + step + ids.length) % ids.length];
}

function applyScene(target) {
  const ids = sceneIds();
  if (!ids.includes(target)) {
    throw new Error(`[khyos-desktop] 未知场景 ${target}（可用：${ids.join(', ')}）`);
  }
  const now = clockNow();
  const from = transition ? transition.from : activeScene;
  if (mode === 'play' && typeof graph.transition === 'function' && target !== activeScene) {
    // 溶解期间 currentScene() 立即回答目标场景；槽位计时从 dip 结束起算，
    // 否则新场景会平白少掉半秒。
    transition = { from, to: target, start: now };
    activeScene = target;
    slotStart = now + TRANSITION_SEC;
  } else {
    beginScene(target, now);
    if (mode !== 'play') renderAt(0);
  }
  updateHud(activeScene, 0);
}

function nextScene(step) {
  applyScene(nextSceneId(step));
}

if (mode === 'play') {
  window.addEventListener('pointermove', (e) => {
    parallaxX = (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
    parallaxY = (e.clientY / Math.max(1, window.innerHeight)) * 2 - 1;
    applyParallax();
    markActive();
  });
  window.addEventListener('pointerdown', () => {
    nextScene(1);
    markActive();
  });
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key;
    if (key === 'ArrowRight') nextScene(1);
    else if (key === 'ArrowLeft') nextScene(-1);
    else if (key >= '1' && key <= '9') {
      const id = sceneIds()[Number(key) - 1];
      if (id) applyScene(id);
    } else if (key === 'f' || key === 'F') toggleFullscreen();
    else if (key === 'h' || key === 'H') toggleHud();
    else if (key === 'm' || key === 'M') toggleMute();
    else return;
    markActive();
  });
  markActive();
}

let readyResolve;
const ready = new Promise((resolve) => {
  readyResolve = resolve;
});

window.__khyos = {
  mode,
  fps: FPS,
  width: WIDTH,
  height: HEIGHT,
  perf,
  warnings,
  ready,
  modules,
  sceneIds,
  currentScene: () => activeScene,
  setScene: (id) => applyScene(id),
  renderSceneAt,
  captureDataURL,
  captureTransitionDataURL,
  renderScoreWav,
  size() {
    return { width: canvas.width, height: canvas.height };
  },
};

const firstFrameStart = performance.now();
if (mode === 'frame') {
  // 单帧模式：确定性渲染一帧就停，没有 rAF 循环——采集要的是「这一帧」，
  // 循环只会让同一 evaluate 的返回值随时机漂移。
  renderSceneAt(
    frameScene && sceneIds().includes(frameScene) ? frameScene : sceneIds()[0],
    Number.isFinite(frameT) ? frameT : 0,
  );
} else {
  await startScore();
  beginScene(sceneIds()[0], 0);
  renderAt(0);
  const loop = () => {
    const now = clockNow();
    if (transition) {
      const k = (now - transition.start) / TRANSITION_SEC;
      if (k >= 1) {
        beginScene(transition.to, now);
        renderAt(0);
      } else {
        graph.transition(transition.from, transition.to, k);
        perf.frameCount += 1;
      }
      updateHud(activeScene, 0);
    } else {
      const local = now - slotStart;
      if (local >= slotSec(activeScene)) {
        const to = nextSceneId(1);
        if (typeof graph.transition === 'function') {
          transition = { from: activeScene, to, start: now };
          activeScene = to;
          slotStart = now + TRANSITION_SEC;
          graph.transition(transition.from, transition.to, 0);
          perf.frameCount += 1;
          updateHud(to, 0);
        } else {
          beginScene(to, now);
          renderAt(0);
          updateHud(to, 0);
        }
      } else {
        renderAt(local);
        updateHud(activeScene, local / slotSec(activeScene));
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
perf.firstFrameMs = performance.now() - firstFrameStart;
if (hud && mode === 'play') hud.hidden = false;

readyResolve(true);
