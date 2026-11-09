'use strict';

/**
 * glmVisionImageDownscale.test.js — GLM 视觉过大图片降采样叶子契约锁(node:test)。
 *
 * 根因回归(「识图 HTTP 400 code 1210」第二形态,0.1.181 诊断浮现):
 *   GLM 视觉端有合并预算 `inputs tokens + max_new_tokens <= 16384`;高分辨率截图光图片就
 *   编码成 18287 input token > 16384 → 无论输出多小都 400。本叶子在发送前估算 token,超预算
 *   者等比降采样到预算内;预算内 / 非视觉模型 / 门控关 / 平台工具失败 → 原图透传(fail-soft)。
 *
 * 除最后一条外都不触真实平台缩放 CLI —— 只验纯逻辑与「不命中即原样透传」:
 *   - 门控三态(缺省开 / 0·false·off·no 关);
 *   - token 估算随面积单调、异常输入返 0;
 *   - scale factor:预算内 → 1;超预算 → (0,1) 且面积压回目标以内;
 *   - 三个启发旋钮的 env 覆盖与夹取;
 *   - downscaleGlmVisionImages:非视觉模型 / 门控关 / 预算内小图 → 返回**原数组引用**(0 重编码);
 *   - 绝不抛(null / 空 / 怪异输入)。
 *
 * 末尾一条走**真实平台缩放**(本机有 PowerShell System.Drawing / sips / ImageMagick /
 * ffmpeg / Pillow 之一才跑,否则 skip 不假通过):
 *   - 临时文件 stamp 并发:worker thread 与主线程同 pid,两张等字节图并发不许互覆盖。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { Worker } = require('worker_threads');
const {
  downscaleGlmVisionImages,
  downscaleImageBlocksInMessages,
  _downscaleBufferViaPlatform,
  _extractBase64FromUrl,
  downscaleEnabled,
  normalizeAllEnabled,
  getMaxEdge,
  getTargetImageTokens,
  getSafetyShrink,
  getPixelsPerToken,
  estimateVisionTokens,
  computeScaleFactor,
  TARGET_IMAGE_TOKENS,
  SAFETY_SHRINK,
  PIXELS_PER_TOKEN,
  DEFAULT_MAX_EDGE,
} = require('../../../src/services/gateway/glmVisionImageDownscale');

const MODULE_PATH = require.resolve('../../../src/services/gateway/glmVisionImageDownscale');

// 一张 1x1 PNG(远在预算内)——用于「小图原样透传」。
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function tinyImage() {
  return { base64: TINY_PNG_BASE64, mimeType: 'image/png', dataUrl: `data:image/png;base64,${TINY_PNG_BASE64}` };
}

test('门控:缺省 → 开;0/false/off/no → 关', () => {
  assert.strictEqual(downscaleEnabled({}), true);
  assert.strictEqual(downscaleEnabled({ KHY_GLM_VISION_IMAGE_DOWNSCALE: '1' }), true);
  assert.strictEqual(downscaleEnabled({ KHY_GLM_VISION_IMAGE_DOWNSCALE: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
    assert.strictEqual(downscaleEnabled({ KHY_GLM_VISION_IMAGE_DOWNSCALE: off }), false, `off=${off}`);
  }
});

test('token 估算:随面积单调递增,异常输入 → 0', () => {
  const small = estimateVisionTokens(100, 100);
  const big = estimateVisionTokens(1000, 1000);
  assert.ok(big > small, 'larger area → more tokens');
  assert.ok(estimateVisionTokens(0, 100) === 0);
  assert.ok(estimateVisionTokens(-1, 100) === 0);
  assert.ok(estimateVisionTokens(NaN, 100) === 0);
  assert.ok(estimateVisionTokens('x', 'y') === 0);
});

test('scale factor:预算内 → 1(不缩)', () => {
  // 小图 token 远 < 目标 → 不缩。
  assert.strictEqual(computeScaleFactor(64, 64), 1);
});

test('scale factor:超预算 → (0,1) 且缩放后面积落回目标以内', () => {
  // 构造一张明显超预算的大图。关掉统一归一化,只验预算约束本身。
  const env = { KHY_GLM_VISION_NORMALIZE_ALL: '0' };
  const W = 4000;
  const H = 3000;
  const before = estimateVisionTokens(W, H);
  assert.ok(before > TARGET_IMAGE_TOKENS, 'precondition: over budget');

  const scale = computeScaleFactor(W, H, env);
  assert.ok(scale > 0 && scale < 1, `scale in (0,1): ${scale}`);

  const after = estimateVisionTokens(Math.round(W * scale), Math.round(H * scale));
  assert.ok(after <= TARGET_IMAGE_TOKENS, `after (${after}) <= target (${TARGET_IMAGE_TOKENS})`);
});

test('统一归一化(默认开):超最大边的图按 maxEdge 收敛;长边缩到上限内', () => {
  assert.strictEqual(normalizeAllEnabled({}), true);
  assert.strictEqual(getMaxEdge({}), DEFAULT_MAX_EDGE);

  // 一张 token 仍在预算内但长边超上限的图(如 2000x400)——仅归一化触发。
  const W = 2000;
  const H = 400;
  const scale = computeScaleFactor(W, H, {});
  assert.ok(scale < 1, `normalize-all should shrink long edge: scale=${scale}`);
  const longAfter = Math.round(Math.max(W, H) * scale);
  assert.ok(longAfter <= DEFAULT_MAX_EDGE + 1, `long edge (${longAfter}) <= maxEdge (${DEFAULT_MAX_EDGE})`);
});

test('统一归一化门关 → 仅超预算才缩(长边超上限但预算内的图不动)', () => {
  const env = { KHY_GLM_VISION_NORMALIZE_ALL: '0' };
  // 2000x400 est tokens 远在预算内 → 关归一化后不缩。
  assert.ok(estimateVisionTokens(2000, 400) <= TARGET_IMAGE_TOKENS, 'precondition: in budget');
  assert.strictEqual(computeScaleFactor(2000, 400, env), 1);
});

test('maxEdge 可经 KHY_GLM_VISION_MAX_EDGE 覆盖(夹在 [512,4096])', () => {
  assert.strictEqual(getMaxEdge({ KHY_GLM_VISION_MAX_EDGE: '1024' }), 1024);
  assert.strictEqual(getMaxEdge({ KHY_GLM_VISION_MAX_EDGE: '100' }), 512); // 夹下限
  assert.strictEqual(getMaxEdge({ KHY_GLM_VISION_MAX_EDGE: '99999' }), 4096); // 夹上限
  assert.strictEqual(getMaxEdge({ KHY_GLM_VISION_MAX_EDGE: 'x' }), DEFAULT_MAX_EDGE); // 非法 → 缺省
});

// ── 三个启发旋钮 env 化(KHY_GLM_VISION_IMAGE_TOKEN_TARGET / _TOKEN_SAFETY / _PIXELS_PER_TOKEN)──
test('三个旋钮:默认值不变,env 覆盖走夹取,非法回退默认', () => {
  assert.strictEqual(getTargetImageTokens({}), TARGET_IMAGE_TOKENS);
  assert.strictEqual(getSafetyShrink({}), SAFETY_SHRINK);
  assert.strictEqual(getPixelsPerToken({}), PIXELS_PER_TOKEN);

  // 目标 token 上界 = 16384(合并预算) - 1024(max_new_tokens 上限);越过必然 400 code 1210。
  assert.strictEqual(getTargetImageTokens({ KHY_GLM_VISION_IMAGE_TOKEN_TARGET: '8000' }), 8000);
  assert.strictEqual(getTargetImageTokens({ KHY_GLM_VISION_IMAGE_TOKEN_TARGET: '99999' }), 15360);
  assert.strictEqual(getTargetImageTokens({ KHY_GLM_VISION_IMAGE_TOKEN_TARGET: '0' }), 1);
  assert.strictEqual(getTargetImageTokens({ KHY_GLM_VISION_IMAGE_TOKEN_TARGET: 'x' }), TARGET_IMAGE_TOKENS);

  // 安全系数夹 (0,1]。
  assert.strictEqual(getSafetyShrink({ KHY_GLM_VISION_TOKEN_SAFETY: '0.5' }), 0.5);
  assert.strictEqual(getSafetyShrink({ KHY_GLM_VISION_TOKEN_SAFETY: '1.5' }), 1);
  assert.strictEqual(getSafetyShrink({ KHY_GLM_VISION_TOKEN_SAFETY: '0' }), 0.01);
  assert.strictEqual(getSafetyShrink({ KHY_GLM_VISION_TOKEN_SAFETY: 'abc' }), SAFETY_SHRINK);

  // 面积系数夹正值。
  assert.strictEqual(getPixelsPerToken({ KHY_GLM_VISION_PIXELS_PER_TOKEN: '50' }), 50);
  assert.strictEqual(getPixelsPerToken({ KHY_GLM_VISION_PIXELS_PER_TOKEN: '0' }), 1);
  assert.strictEqual(getPixelsPerToken({ KHY_GLM_VISION_PIXELS_PER_TOKEN: 'x' }), PIXELS_PER_TOKEN);
});

test('registry 条目 min/max 与叶子夹取一致(防两地静默漂移)', () => {
  // flagRegistry 声明 KHY_GLM_VISION_PIXELS_PER_TOKEN 的 min/max,叶子是本地自解析(不走
  // registry.resolveNumeric),两侧夹取区间必须逐字对齐。改前 registry 有 max:100000 而叶子
  // 无上界,env 传超大值原样返回 —— 任何一侧单独改动都该在这里红。
  const { FLAGS } = require('../../../src/utils/flagRegistry');
  const entry = FLAGS.KHY_GLM_VISION_PIXELS_PER_TOKEN;
  assert.ok(entry && entry.mode === 'numeric', 'registry 该条目须存在且为 numeric');
  assert.strictEqual(getPixelsPerToken({}), entry.default);
  assert.strictEqual(getPixelsPerToken({ KHY_GLM_VISION_PIXELS_PER_TOKEN: String(entry.min) }), entry.min);
  assert.strictEqual(getPixelsPerToken({ KHY_GLM_VISION_PIXELS_PER_TOKEN: '0' }), entry.min);
  assert.strictEqual(getPixelsPerToken({ KHY_GLM_VISION_PIXELS_PER_TOKEN: String(entry.max) }), entry.max);
  assert.strictEqual(getPixelsPerToken({ KHY_GLM_VISION_PIXELS_PER_TOKEN: '999999999' }), entry.max);
});

test('env 旋钮只影响读取时的估算/缩放,导出的常量一字不动', () => {
  // 复现脚本快照依赖这三个导出常量,env 不得染指它们。
  assert.strictEqual(TARGET_IMAGE_TOKENS, 12000);
  assert.strictEqual(SAFETY_SHRINK, 0.92);
  assert.strictEqual(PIXELS_PER_TOKEN, 100);

  const env = { KHY_GLM_VISION_NORMALIZE_ALL: '0', KHY_GLM_VISION_PIXELS_PER_TOKEN: '200' };
  assert.strictEqual(estimateVisionTokens(4000, 3000, env), 60000); // 面积 / 200
  assert.strictEqual(estimateVisionTokens(4000, 3000), 120000); // 缺省 面积 / 100

  // 同一张图,目标砍半 → 缩放系数按 sqrt(目标/token) 走得更深。
  const half = computeScaleFactor(4000, 3000, { ...env, KHY_GLM_VISION_IMAGE_TOKEN_TARGET: '6000' });
  assert.ok(half < computeScaleFactor(4000, 3000, env), `smaller target → deeper shrink (${half})`);
  const after = estimateVisionTokens(Math.round(4000 * half), Math.round(3000 * half), env);
  assert.ok(after <= 6000, `after (${after}) <= overridden target (6000)`);
});

test('downscaleGlmVisionImages:非视觉模型 → 原数组引用透传(0 重编码)', () => {
  const imgs = [tinyImage()];
  const out = downscaleGlmVisionImages('gpt-4o', imgs, {});
  assert.strictEqual(out, imgs, '非视觉模型必须原样返回同一引用');
});

test('downscaleGlmVisionImages:门控关 → 原数组引用透传', () => {
  const imgs = [tinyImage()];
  const out = downscaleGlmVisionImages('glm-4v-flash', imgs, { KHY_GLM_VISION_IMAGE_DOWNSCALE: '0' });
  assert.strictEqual(out, imgs);
});

test('downscaleGlmVisionImages:GLM 视觉 + 预算内小图 → 原数组引用透传(不缩)', () => {
  const imgs = [tinyImage()];
  const out = downscaleGlmVisionImages('glm-4v-flash', imgs, {});
  assert.strictEqual(out, imgs, '1x1 图远在预算内,不该重编码');
});

test('绝不抛:null / 空 / 怪异输入', () => {
  assert.strictEqual(downscaleGlmVisionImages('glm-4v-flash', null, {}), null);
  assert.deepStrictEqual(downscaleGlmVisionImages('glm-4v-flash', [], {}), []);
  const junk = [{ base64: null }, { nope: 1 }, { base64: 'not-base64-@@@' }];
  const out = downscaleGlmVisionImages('glm-4v-flash', junk, {});
  // 无有效图片可缩 → 返回原数组引用。
  assert.strictEqual(out, junk);
});

// ── _extractBase64FromUrl:抽 data URL / 裸 base64 ──
test('_extractBase64FromUrl:data URL → {mimeType,base64};非法 → null', () => {
  const p = _extractBase64FromUrl(`data:image/png;base64,${TINY_PNG_BASE64}`);
  assert.ok(p && p.base64 === TINY_PNG_BASE64 && p.mimeType === 'image/png');
  assert.strictEqual(_extractBase64FromUrl('https://example.com/a.png'), null);
  assert.strictEqual(_extractBase64FromUrl(''), null);
  assert.strictEqual(_extractBase64FromUrl(null), null);
  assert.strictEqual(_extractBase64FromUrl('short'), null);
});

// ── downscaleImageBlocksInMessages:真正命中路径(图在 body.messages 里)──
test('downscaleImageBlocksInMessages:非视觉模型 / 门控关 → 0 且不 mutate', () => {
  const mk = () => [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG_BASE64}` } },
    { type: 'text', text: 'hi' },
  ] }];
  const m1 = mk();
  assert.strictEqual(downscaleImageBlocksInMessages('gpt-4o', m1, {}), 0);
  const m2 = mk();
  assert.strictEqual(downscaleImageBlocksInMessages('glm-4v-flash', m2, { KHY_GLM_VISION_IMAGE_DOWNSCALE: '0' }), 0);
});

test('downscaleImageBlocksInMessages:预算内小图 → 0(不改 url)', () => {
  const url = `data:image/png;base64,${TINY_PNG_BASE64}`;
  const msgs = [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }];
  const n = downscaleImageBlocksInMessages('glm-4v-flash', msgs, {});
  assert.strictEqual(n, 0);
  assert.strictEqual(msgs[0].content[0].image_url.url, url, '1x1 图在预算内,url 不该被改');
});

test('downscaleImageBlocksInMessages:绝不抛(怪异 content / 缺块)', () => {
  assert.strictEqual(downscaleImageBlocksInMessages('glm-4v-flash', null, {}), 0);
  assert.strictEqual(downscaleImageBlocksInMessages('glm-4v-flash', [], {}), 0);
  const weird = [
    { role: 'system', content: 'plain string' },
    { role: 'user', content: [null, { type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'not-a-data-url' } }] },
    {},
  ];
  assert.strictEqual(downscaleImageBlocksInMessages('glm-4v-flash', weird, {}), 0);
});

test('downscaleImageBlocksInMessages:识别 image_url(字符串)/input_image/Anthropic image 三种形状', () => {
  // 均为预算内小图 → 计 0,但走通三条识别分支不抛。
  const url = `data:image/png;base64,${TINY_PNG_BASE64}`;
  const msgs = [
    { role: 'user', content: [{ type: 'image_url', image_url: url }] },              // 字符串变体
    { role: 'user', content: [{ type: 'input_image', image_url: url }] },            // Responses API
    { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_BASE64 } }] }, // Anthropic
  ];
  assert.strictEqual(downscaleImageBlocksInMessages('glm-4v-flash', msgs, {}), 0);
});

// ── 临时文件 stamp 并发:同进程两张等字节图不许互覆盖 ──
// 旧 stamp 是 `${process.pid}_${buf.length}`。worker thread 与主线程**共享 pid**,且各自
// 持有独立的模块实例(计数器都从 0 起),于是两张等字节图会写同一对 in_/out_ 文件:
// 后写的 in_ 覆盖前者的输入,先完成的读走/删走别人的 out_。改前实测(本机 Windows):
// 请求 48x48 的那路拿回 24x24 的输出,另一路直接 null —— 即「用户问图 A,收到图 B」。
// 这里用 worker_threads 拿真并发(同 pid),跑平台缩放的真实路径,不 mock。

/** PNG chunk 的 CRC-32(IHDR/IDAT 都要,零依赖手算)。 */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 纯 zlib 手搓一张 solid-color PNG(零依赖;同尺寸 → 字节数确定,与颜色无关)。 */
function solidPng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2 = truecolor RGB
  const stride = 1 + w * 3; // 每行一个 filter 字节 + RGB
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const off = y * stride;
    raw[off] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 读 PNG 的宽高(IHDR 在 8 字节签名 + 4 字节长度 + 4 字节类型之后)。 */
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** 在独立线程里跑真实平台缩放;返回输出 base64(失败 → null)。 */
function downscaleInWorker(base64, w, h) {
  const src = [
    'const { workerData, parentPort } = require("worker_threads");',
    `const { _downscaleBufferViaPlatform } = require(${JSON.stringify(MODULE_PATH)});`,
    'const out = _downscaleBufferViaPlatform(Buffer.from(workerData.base64, "base64"), workerData.w, workerData.h);',
    'parentPort.postMessage(out ? out.toString("base64") : null);',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const worker = new Worker(src, { eval: true, workerData: { base64, w, h } });
    worker.on('message', resolve);
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`worker exit ${code}`));
    });
  });
}

test('并发:两张等字节图同进程并发降采样,各自拿回自己的输出', async (t) => {
  const red = solidPng(96, 96, [255, 0, 0]);
  const blue = solidPng(96, 96, [0, 0, 255]);
  assert.strictEqual(red.length, blue.length, 'precondition: 两张图等字节');

  // 本机没有平台图像工具(PowerShell System.Drawing / sips / ImageMagick / ffmpeg / Pillow
  // 全缺)→ 该叶子本就 fail-soft 返 null,真实路径无从验证,跳过而非假通过。
  if (!_downscaleBufferViaPlatform(red, 48, 48)) {
    t.skip('no platform image resize tool available; real-path case needs one');
    return;
  }

  const [a, b] = await Promise.all([
    downscaleInWorker(red.toString('base64'), 48, 48),
    downscaleInWorker(blue.toString('base64'), 24, 24),
  ]);
  assert.ok(a, '第一张图必须拿到自己的输出(不因并发被覆盖)');
  assert.ok(b, '第二张图必须拿到自己的输出(不因并发被删走)');
  assert.deepStrictEqual(pngSize(Buffer.from(a, 'base64')), { width: 48, height: 48 });
  assert.deepStrictEqual(pngSize(Buffer.from(b, 'base64')), { width: 24, height: 24 });
});
