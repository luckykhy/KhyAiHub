// render-audio.mjs — 用 Edge 打开桌面页 ?mode=frame，调 window.__khyos.renderScoreWav()
// 把配乐落成 out/score.wav（48kHz / 16bit PCM / 立体声）。
//
// 三条约束：
//   1) 合成一律在页面侧。Node 没有 Web Audio，本脚本只负责起浏览器、收 base64、
//      校验 RIFF 头、落盘。页面还没接线 renderScoreWav 时如实回报并跳过——
//      不写空音频冒充成功，那比没有配乐更难排查。
//   2) 同一份 scenes.json 两次渲染必须字节一致。脚本连采两次逐字节比对，
//      不一致就不落盘（离线渲染若有跨调用残留状态，这里会当场抓住）。
//   3) Edge 的启动方式与 scripts/capture.mjs 逐项一致（可执行路径、GPU 参数、
//      KHYOS_BROWSER / KHYOS_GPU_ARGS 覆盖、protocolTimeout）。改这里必须同步
//      改那处，否则两条链路的浏览器行为会分叉。
//
// 退出码：0 = 出片或「页面未接线」的如实跳过；1 = 接线了但渲染/校验失败。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC_DIR = path.join(PKG_ROOT, 'src');
const OUT_DIR = path.join(PKG_ROOT, 'out');
const WAV_PATH = path.join(OUT_DIR, 'score.wav');
const PAGE_PATH = path.join(PKG_ROOT, 'dist', 'khyos-desktop.html');

const WIDTH = 1280;
const HEIGHT = 720;
const EXPECT_RATE = 48000;
const EXPECT_CHANNELS = 2;
const EXPECT_BITS = 16;

// 与 capture.mjs 同源：默认值可被 KHYOS_BROWSER 覆盖，写死某台机器的安装位置
// 别人一装就崩。
const DEFAULT_EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'; // khy-allow-abs-path: 与 scripts/capture.mjs 同一默认值，可被 KHYOS_BROWSER 覆盖
const DEFAULT_GPU_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--allow-file-access-from-files',
];

function executablePath() {
  const fromEnv = process.env.KHYOS_BROWSER;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return DEFAULT_EDGE_PATH;
}

function gpuArgs() {
  const raw = process.env.KHYOS_GPU_ARGS;
  if (!raw || !raw.trim()) return DEFAULT_GPU_ARGS;
  return raw
    .split(/[\s;,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// dist 页面比 src 旧 = 浏览器里跑的还是上一个 bundle。音频模块改了没重新
// build，采集到的会是旧代码，而这种错在字节层面看不出来。
function newestSrcMtime() {
  let newest = 0;
  const stack = [SRC_DIR];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  }
  return newest;
}

function stripDataUrl(s) {
  // main.js 的注释约定 audio 模块返回 data URL；本模块按任务面返回裸 base64。
  // 两种都收，落盘前统一剥掉前缀。
  if (typeof s !== 'string') return '';
  const i = s.indexOf(',');
  return s.startsWith('data:') && i > 0 ? s.slice(i + 1) : s;
}

function readWavInfo(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { error: '不是标准 RIFF/WAVE 头' };
  }
  let pos = 12;
  let fmt = null;
  let dataSize = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(pos + 8),
        channels: buf.readUInt16LE(pos + 10),
        sampleRate: buf.readUInt32LE(pos + 12),
        bits: buf.readUInt16LE(pos + 22),
      };
    } else if (id === 'data') {
      dataSize = size;
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || dataSize == null) return { error: '缺少 fmt/data 块' };
  const byteRate = fmt.sampleRate * fmt.channels * (fmt.bits / 8);
  return { fmt, dataSize, seconds: dataSize / byteRate };
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
  // 与 capture.mjs 同一个等待判据：等到 __khyos 挂上、且首帧已出或已显式报错。
  // 集成模块缺失时页面会挂 window.__khyos.error，必须把它读出来当原因，
  // 而不是让调用方对着一超时干猜。
  await page.waitForFunction(
    () =>
      window.__khyos &&
      ((window.__khyos.perf && window.__khyos.perf.frameCount > 0) || window.__khyos.error),
    { timeout: 120000 },
  );
  return page;
}

async function main() {
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
  const distMtime = fs.statSync(PAGE_PATH).mtimeMs;
  const srcMtime = newestSrcMtime();
  if (distMtime < srcMtime) {
    console.warn(
      '[khyos-desktop] dist/khyos-desktop.html 比 src/ 旧：页面里跑的可能不是最新音频模块，建议先跑 npm run build。',
    );
  }

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: gpuArgs(),
    defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
    protocolTimeout: 0,
  });

  let ok = false;
  let seconds = 0;
  try {
    const page = await openPage(browser);
    try {
      const state = await page.evaluate(() => {
        const k = window.__khyos;
        return {
          error: k && k.error ? String(k.error) : null,
          wired: !!(k && typeof k.renderScoreWav === 'function'),
        };
      });
      if (state.error) {
        console.error(`[khyos-desktop] 页面启动失败：${state.error}`);
        console.error('[khyos-desktop] 跳过落盘：配乐渲染依赖页面先跑起来（pipeline/director/audio/models 四个集成模块缺一不可）。');
        console.log('AUDIO_RENDER ok=false seconds=0.0');
        return;
      }
      if (!state.wired) {
        console.error('[khyos-desktop] window.__khyos.renderScoreWav 未接线：src/audio.js 未导出 renderScoreWav。');
        console.error('[khyos-desktop] 跳过落盘：不写空音频冒充成功。');
        console.log('AUDIO_RENDER ok=false seconds=0.0');
        return;
      }

      const started = Date.now();
      const first = await page.evaluate(() => window.__khyos.renderScoreWav());
      const firstMs = Date.now() - started;
      const second = await page.evaluate(() => window.__khyos.renderScoreWav());
      const secondMs = Date.now() - started - firstMs;
      if (typeof first !== 'string' || !first.length) {
        throw new Error('renderScoreWav() 没有返回 base64 字符串（返回了空值）。');
      }
      if (first !== second) {
        throw new Error(
          `同一份 scenes.json 两次渲染字节不一致（${first.length} vs ${second.length} 字符）——离线渲染有跨调用残留状态，拒绝落盘。`,
        );
      }
      console.log(
        `[khyos-desktop] 两次离线渲染字节一致（base64 ${(first.length / 1024 / 1024).toFixed(2)} MB，${(firstMs / 1000).toFixed(1)}s + ${(secondMs / 1000).toFixed(1)}s）`,
      );

      const buf = Buffer.from(stripDataUrl(first), 'base64');
      const info = readWavInfo(buf);
      if (info.error) throw new Error(`wav 头校验失败：${info.error}`);
      const { format, channels, sampleRate, bits } = info.fmt;
      if (format !== 1) throw new Error(`wav 不是 PCM（format=${format}）。`);
      if (channels !== EXPECT_CHANNELS) throw new Error(`wav 声道数 ${channels}，期望 ${EXPECT_CHANNELS}。`);
      if (sampleRate !== EXPECT_RATE) throw new Error(`wav 采样率 ${sampleRate}，期望 ${EXPECT_RATE}。`);
      if (bits !== EXPECT_BITS) throw new Error(`wav 位深 ${bits}，期望 ${EXPECT_BITS}。`);
      seconds = info.seconds;

      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(WAV_PATH, buf);
      console.log(
        `[khyos-desktop] 已写 ${path.relative(PKG_ROOT, WAV_PATH)}：${(buf.length / 1024 / 1024).toFixed(2)} MB，${seconds.toFixed(2)}s，${sampleRate}Hz/${bits}bit/${channels}ch`,
      );
      ok = true;
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`AUDIO_RENDER ok=${ok} seconds=${seconds.toFixed(1)}`);
  if (!ok) process.exitCode = 1;
}

await main();
