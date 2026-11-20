// capture.mjs — 用 Edge 逐场景逐帧渲染桌面页，把每一帧落成 PNG。
//
// 三条约束：
//   1) 帧必须由页面的 captureDataURL(sceneId, t) 产出，而不是 page.screenshot()。
//      screenshot 走合成器，会带上 HUD、光标、抗锯齿差异，还会在画布被
//      清空后拿到黑帧；captureDataURL 与渲染同任务完成，字节可复现。
//   2) 24fps / 1280x720 / 五位零填充 / out/frames/<sceneId>/ 是 assemble、
//      jumpcut、extract-check 三方共认的帧格式，改这里必须同步改那三处。
//   3) Edge 的可执行路径是本项目唯一允许出现的绝对路径，且必须能被
//      KHYOS_BROWSER 覆盖——写死某台机器的安装位置，别人一装就崩。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FRAMES_DIR = path.join(PKG_ROOT, 'out', 'frames');
const PERF_PATH = path.join(PKG_ROOT, 'out', 'perf.json');
const SCENES_PATH = path.join(PKG_ROOT, 'src', 'story', 'scenes.json');
const PAGE_PATH = path.join(PKG_ROOT, 'dist', 'khyos-desktop.html');

const FPS = 24;
const WIDTH = 1280;
const HEIGHT = 720;

// Edge 的默认安装位置是 OS 常量而非本仓 checkout，且可被 KHYOS_BROWSER 覆盖。
const DEFAULT_EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'; // khy-allow-abs-path: 默认值可被 KHYOS_BROWSER 覆盖，全项目仅此一处

// 无头机大多没有可用 GPU，SwiftShader 是唯一能让 WebGL 稳定出图的路径；
// 换真 GPU 时通过 KHYOS_GPU_ARGS 传参，不必改这里。
// --allow-file-access-from-files 只加在这个一次性的采集浏览器上：file:// 下
// 的 ES module 会被 CORS 拦掉，默认抓的 dist/khyos-desktop.html 虽然已经把
// bundle 内联、不受影响，用它抓开发页 index.html 时没有它就跑不起来。
const DEFAULT_GPU_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--allow-file-access-from-files',
];

// 自检判据：同一 t 两次渲染必须字节一致；单帧像素标准差必须过这个下限，
// 否则「一致」可能只是「两次都渲染出了同一张黑图」。
const STDDEV_MIN = 2.0;
const SELFTEST_TIMES = [0, 1 / FPS, 0.5, 3.7];

function parseArgs(argv) {
  const opts = { workers: 1, selftest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--selftest') opts.selftest = true;
    else if (a === '--scene') opts.scene = argv[++i];
    else if (a === '--frames') opts.frames = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--workers') opts.workers = Math.max(1, Number(argv[++i]) || 1);
    else throw new Error(`[khyos-desktop] 不认识的参数 ${a}`);
  }
  return opts;
}

// 场景表是采集链与导演共认的真源：capture 用它定每场景帧数，jumpcut 用它
// 推切换时间点，导演的 sceneIds() 必须与它同序同名。字段名 sceneDurations
// 由任务面固定；scenes 只是给集成阶段留的同义容错，二者取其一即可。
function readScenes() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(SCENES_PATH, 'utf8'));
  } catch (err) {
    // 场景表缺失/不可解析是集成阶段还没交货，不是运行环境故障——报成一句
    // 人话，别让人对着一屏 ENOENT 栈猜。
    throw new Error(
      `[khyos-desktop] 读不到 src/story/scenes.json（${err && err.code ? err.code : err.message}）：场景表由集成阶段提供，缺它无从定每场景帧数。`,
    );
  }
  const list = Array.isArray(raw.sceneDurations)
    ? raw.sceneDurations
    : Array.isArray(raw.scenes)
      ? raw.scenes
      : null;
  if (!list) {
    throw new Error(
      '[khyos-desktop] src/story/scenes.json 缺少 sceneDurations（[{ id, durationSec }]），无从定帧。',
    );
  }
  return list
    .map((s) => ({ id: String(s.id), durationSec: Number(s.durationSec) }))
    .filter((s) => s.id && Number.isFinite(s.durationSec) && s.durationSec > 0);
}

function framePath(sceneId, index) {
  return path.join(FRAMES_DIR, sceneId, `frame_${String(index).padStart(5, '0')}.png`);
}

function gpuArgs() {
  const raw = process.env.KHYOS_GPU_ARGS;
  if (!raw || !raw.trim()) return DEFAULT_GPU_ARGS;
  return raw
    .split(/[\s;,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function executablePath() {
  const fromEnv = process.env.KHYOS_BROWSER;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return DEFAULT_EDGE_PATH;
}

function lumaStddev(png) {
  const { data, width, height } = png;
  const n = width * height;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i += 1) {
    const o = i << 2;
    const y = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    sum += y;
    sumSq += y * y;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sumSq / n - mean * mean));
}

function decode(dataUrl) {
  return PNG.sync.read(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
}

async function openPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  page.on('pageerror', (err) => {
    console.error(`[khyos-desktop] 页面脚本错误：${err.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error(`[khyos-desktop] 页面 console：${msg.text()}`);
  });
  const url = `${pathToFileURL(PAGE_PATH).href}?mode=frame`;
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  // 等首帧或等显式报错：集成模块缺失时页面会挂上 window.__khyos.error，
  // 这里必须把它读出来当失败原因，而不是让调用方对着一超时干猜。
  await page.waitForFunction(
    () =>
      window.__khyos &&
      ((window.__khyos.perf && window.__khyos.perf.frameCount > 0) || window.__khyos.error),
    { timeout: 120000 },
  );
  // 失败态下的 window.__khyos 没有 sceneIds，先分流再取值，否则 TypeError
  // 会盖掉页面上那句真正的报错。
  const state = await page.evaluate(() => {
    const k = window.__khyos;
    if (k.error) return { error: k.error, size: null, sceneIds: null };
    return { error: null, size: k.size(), sceneIds: k.sceneIds() };
  });
  if (state.error) {
    throw new Error(`[khyos-desktop] 页面启动失败：${state.error}`);
  }
  if (state.size.width !== WIDTH || state.size.height !== HEIGHT) {
    throw new Error(
      `[khyos-desktop] 画布尺寸 ${state.size.width}x${state.size.height}，期望 ${WIDTH}x${HEIGHT}。视口被缩放或 DPR 不为 1。`,
    );
  }
  return { page, sceneIds: state.sceneIds };
}

async function selftest(browser, scenes) {
  const { page, sceneIds } = await openPage(browser);
  const failures = [];
  try {
    const ids = sceneIds;
    const expected = scenes.map((s) => s.id);
    if (ids.length < 2) {
      failures.push(`页面只报到 ${ids.length} 个场景，桌面至少需要 2 个（切换与轮播契约）`);
    }
    if (ids.join(',') !== expected.join(',')) {
      failures.push(
        `页面场景序列 [${ids.join(',')}] 与 scenes.json [${expected.join(',')}] 不一致——采集会按磁盘场景表定帧，两处漂移等于采错片`,
      );
    }

    const first = ids[0];
    for (const t of SELFTEST_TIMES) {
      const a = await page.evaluate((s, tt) => window.__khyos.captureDataURL(s, tt), first, t);
      const b = await page.evaluate((s, tt) => window.__khyos.captureDataURL(s, tt), first, t);
      if (a !== b) {
        failures.push(`场景 ${first} t=${t} 两次渲染字节不一致（长度 ${a.length} vs ${b.length}）`);
        continue;
      }
      const sd = lumaStddev(decode(a));
      console.log(
        `[khyos-desktop] 自检 场景 ${first} t=${t}s：字节一致，像素标准差 ${sd.toFixed(2)}（下限 ${STDDEV_MIN}）`,
      );
      if (!(sd > STDDEV_MIN)) {
        failures.push(`场景 ${first} t=${t} 像素标准差 ${sd.toFixed(2)} 未过下限 ${STDDEV_MIN}（疑似空帧）`);
      }
    }

    for (const scene of scenes) {
      const mid = scene.durationSec / 2;
      const dataUrl = await page.evaluate(
        (s, t) => window.__khyos.captureDataURL(s, t),
        scene.id,
        mid,
      );
      const sd = lumaStddev(decode(dataUrl));
      console.log(
        `[khyos-desktop] 自检 场景 ${scene.id} 中值帧 t=${mid.toFixed(3)}s：像素标准差 ${sd.toFixed(2)}（下限 ${STDDEV_MIN}）`,
      );
      if (!(sd > STDDEV_MIN)) {
        failures.push(`场景 ${scene.id} 中值帧像素标准差 ${sd.toFixed(2)} 未过下限 ${STDDEV_MIN}（疑似空帧）`);
      }
    }

    if (ids.length >= 2) {
      const [a, b] = ids;
      const sceneA = scenes.find((s) => s.id === a);
      const sceneB = scenes.find((s) => s.id === b);
      const tA = sceneA ? sceneA.durationSec / 2 : 0.5;
      const tB = sceneB ? sceneB.durationSec / 2 : 0.5;
      const fa = await page.evaluate((s, t) => window.__khyos.captureDataURL(s, t), a, tA);
      const fb = await page.evaluate((s, t) => window.__khyos.captureDataURL(s, t), b, tB);
      const ft = await page.evaluate(
        (from, to, k) => window.__khyos.captureTransitionDataURL(from, to, k),
        a,
        b,
        0.5,
      );
      if (ft === fa || ft === fb) {
        failures.push(
          `captureTransitionDataURL(${a},${b},0.5) 与某一侧帧字节相同（长度 ${ft.length}）——切换没有可视过渡`,
        );
      } else {
        console.log(
          `[khyos-desktop] 自检 过渡 ${a}→${b}：淡切帧与两侧均不同（${ft.length} vs ${fa.length}/${fb.length} 字节）`,
        );
      }
      await page.evaluate((s) => window.__khyos.setScene(s), b);
      const after = await page.evaluate(() => window.__khyos.currentScene());
      if (after !== b) {
        failures.push(`setScene(${b}) 后 currentScene() 返回 ${after}，切换未生效`);
      }
    }
  } finally {
    await page.close();
  }
  return failures;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(PAGE_PATH)) {
    throw new Error(
      `[khyos-desktop] 找不到页面 ${PAGE_PATH}。先跑 npm run build 生成 dist/khyos-desktop.html。`,
    );
  }
  const exe = executablePath();
  if (!fs.existsSync(exe)) {
    throw new Error(
      `[khyos-desktop] 找不到浏览器可执行文件 ${exe}。用 KHYOS_BROWSER 指向本机 Edge/Chrome。`,
    );
  }

  const allScenes = readScenes();
  const scenes = opts.scene ? allScenes.filter((s) => s.id === opts.scene) : allScenes;
  if (!scenes.length) {
    throw new Error(
      `[khyos-desktop] --scene ${opts.scene} 不在 scenes.json 里（可用：${allScenes.map((s) => s.id).join(', ')}）。`,
    );
  }

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: gpuArgs(),
    defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
    protocolTimeout: 0,
  });

  try {
    if (opts.selftest) {
      // 自检对全量场景表做：--scene 只是采集面的过滤器，页面健康度要看全部场景。
      const failures = await selftest(browser, allScenes);
      if (failures.length) {
        for (const f of failures) console.error(`[khyos-desktop] 自检失败：${f}`);
        process.exitCode = 1;
        return;
      }
      console.log('[khyos-desktop] 自检通过：同 t 渲染字节一致、各场景帧非空、切换有可视过渡。');
      return;
    }

    // 全量渲染前只清本次要采的场景目录：上次留下的帧会让 assemble 把旧镜头
    // 和新镜头缝在一起，而 ffmpeg 按序号读帧，缺号还会静默截断成片。
    for (const scene of scenes) {
      fs.rmSync(path.join(FRAMES_DIR, scene.id), { recursive: true, force: true });
    }

    let plan = [];
    for (const scene of scenes) {
      const n = Math.round(scene.durationSec * FPS);
      for (let i = 0; i < n; i += 1) {
        plan.push({ sceneId: scene.id, index: i, t: i / FPS, outPath: framePath(scene.id, i) });
      }
    }
    if (opts.frames) plan = plan.slice(0, opts.frames);
    if (!plan.length) throw new Error('[khyos-desktop] 帧计划为空：scenes.json 的时长算不出任何帧。');

    const workers = Math.min(opts.workers, plan.length);
    const bounds = [];
    const chunk = Math.ceil(plan.length / workers);
    for (let w = 0; w < workers; w += 1) {
      const s = w * chunk;
      const e = Math.min(plan.length, s + chunk);
      if (s < e) bounds.push(plan.slice(s, e));
    }

    const timings = [];
    const opened = [];
    for (let w = 0; w < bounds.length; w += 1) {
      const { page, sceneIds } = await openPage(browser);
      opened.push(page);
      // 校验必须对全量场景表：--scene 只决定采哪些帧，页面少一个场景本身就是
      // 采集会采错片的事故，过滤器不该把它遮住。
      const expected = allScenes.map((s) => s.id);
      if (sceneIds.join(',') !== expected.join(',')) {
        throw new Error(
          `[khyos-desktop] 页面场景序列 [${sceneIds.join(',')}] 与 scenes.json [${expected.join(',')}] 不一致，采集会采错片。`,
        );
      }
      console.log(
        `[khyos-desktop] 工作页 ${w + 1}/${bounds.length} 接管 ${bounds[w].length} 帧（${bounds[w][0].sceneId}#${bounds[w][0].index} 起）`,
      );
    }

    await Promise.all(
      bounds.map(async (items, w) => {
        for (const item of items) {
          const started = performance.now();
          const dataUrl = await opened[w].evaluate(
            (sceneId, t) => window.__khyos.captureDataURL(sceneId, t),
            item.sceneId,
            item.t,
          );
          const elapsed = performance.now() - started;
          const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
          fs.mkdirSync(path.dirname(item.outPath), { recursive: true });
          fs.writeFileSync(item.outPath, buf);
          timings.push(elapsed);
          console.log(
            `[khyos-desktop] 渲染 ${item.sceneId} 第 ${item.index + 1} 帧 t=${item.t.toFixed(4)}s ${WIDTH}x${HEIGHT} — ${elapsed.toFixed(0)}ms，${(buf.length / 1024).toFixed(0)}KB`,
          );
        }
      }),
    );

    for (const page of opened) await page.close();

    timings.sort((a, b) => a - b);
    const avgFrameMs = timings.reduce((a, b) => a + b, 0) / Math.max(1, timings.length);
    const report = {
      frames: timings.length,
      avgFrameMs: Number(avgFrameMs.toFixed(2)),
      minFrameMs: Number((timings[0] ?? 0).toFixed(2)),
      maxFrameMs: Number((timings[timings.length - 1] ?? 0).toFixed(2)),
      p50FrameMs: Number((timings[Math.floor(timings.length / 2)] ?? 0).toFixed(2)),
      workers: bounds.length,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      scenes: scenes.map((s) => ({ id: s.id, durationSec: s.durationSec })),
      browser: exe,
    };
    fs.mkdirSync(path.dirname(PERF_PATH), { recursive: true });
    fs.writeFileSync(PERF_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(
      `[khyos-desktop] CAPTURE_SUMMARY frames=${report.frames} avgFrameMs=${report.avgFrameMs} workers=${report.workers}`,
    );
    console.log(`[khyos-desktop] 已写 ${PERF_PATH}`);
  } finally {
    await browser.close();
  }
}

await main();
