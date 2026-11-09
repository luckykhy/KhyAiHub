'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// ── 沙箱：必须在**任何**项目模块被 require 之前设好 ─────────────────────────
//
// getDataHome() 有模块级 _cached（src/utils/dataHome.js:374-384），第一次解析
// 之后就再也不看环境变量。而本文件既测纯函数也测 IO，纯函数那段会经由
// require('./apiKeyPool') 间接触发 dataHome 的首次解析——所以沙箱必须放在最
// 上面、第一个项目 require 之前，否则 IO 用例会打到真实数据目录去。
//
// 第一版就是踩了这个：沙箱设在文件中段，结果 getDataHome() 已被纯函数那段缓存
// 到真实 home，四个 IO 测试全在读写真实目录（本机恰好解析到 portable 项目家，
// 没有造成实际污染，但那是运气，不是设计）。
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-vision-store-'));
const _savedDataHome = process.env.KHY_DATA_HOME;
process.env.KHY_DATA_HOME = SANDBOX;

const store = require('./visionEndpointStore');

const {
  visionRoutingEnvPatch,
  visionPin,
  normalizeVisionBaseUrl,
  applyVisionRoutingEnv,
  readVisionEndpoint,
  readVisionEndpointDraft,
  describeVisionEndpoint,
  writeVisionEndpoint,
  clearVisionEndpoint,
  configFilePath,
} = store;

test.after(() => {
  if (_savedDataHome === undefined) {
    delete process.env.KHY_DATA_HOME;
  } else {
    process.env.KHY_DATA_HOME = _savedDataHome;
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// IO 用例共用一个沙箱（缓存所致），所以每个用例从干净状态开始，否则互相污染。
//
// REAL_POOL 是**真的** apiKeyPool，指向沙箱里的 api_keys.json（dataHome 已被钉住）。
// 这里故意不用假 pool：密钥簿记（addKey/removeKey/save 的 label 过滤）正是要验的东西，
// 用桩会把「写了却不落盘」这类真 bug 放过去。
const REAL_POOL = require('./apiKeyPool');

function resetIo() {
  clearVisionEndpoint(REAL_POOL);
  assert.strictEqual(readVisionEndpoint(), null, 'resetIo 之后仍有残留配置');
}

// ── 纯函数：env 补丁矩阵 ────────────────────────────────────────────────────

test('无配置 → 原样返回同一个 env 对象', () => {
  const env = { KHY_VISION_FALLBACK_MODEL: '' };
  assert.strictEqual(visionRoutingEnvPatch(env, null), env);
  assert.strictEqual(visionRoutingEnvPatch(env, { pin: '' }), env);
});

test('用户手设 KHY_VISION_FALLBACK_MODEL → 不注入（显式 env 优先）', () => {
  const env = { KHY_VISION_FALLBACK_MODEL: 'glm/glm-4.6v-flash' };
  const cfg = { pin: 'khy-vision/step-2-16k' };
  assert.strictEqual(visionRoutingEnvPatch(env, cfg, true), env);
});

test("KHY_VISION_FALLBACK_MODEL='auto' 算未设 → 注入照常", () => {
  // 'auto' 本来就是「跳过钉选、交给后续步骤」的约定值，不是用户的钉选。所以
  // 它不该在第二道守卫里被当成显式值把我们的配置挡掉——否则用户设过一次 auto
  // 就再也用不上视觉端点了，而且没有任何提示。
  const env = { KHY_VISION_FALLBACK_MODEL: 'auto' };
  const out = visionRoutingEnvPatch(env, { pin: 'khy-vision/step-2-16k' }, true);
  assert.strictEqual(out.KHY_VISION_FALLBACK_MODEL, 'khy-vision/step-2-16k');
  assert.strictEqual(out.KHY_VISION_MODELS, 'khy-vision/step-2-16k');
  // 而入参没被原地改。
  assert.strictEqual(env.KHY_VISION_FALLBACK_MODEL, 'auto');
});

test('池无可用 key → 整份不注入（无凭据绝不路由）', () => {
  // 这是防「静默落到错误上游」的硬闸：apiAdapter 的 useRequestOverride 需要
  // poolApiKey || poolEndpoint，缺了会退回默认 env-keyed service。
  // hasPoolKey 是显式参数，所以这条不再是猴补丁 apiKeyPool，而是直接把开关打到 false。
  const env = {};
  const cfg = { pin: 'khy-vision/step-2-16k' };
  assert.strictEqual(visionRoutingEnvPatch(env, cfg, false), env);
  assert.strictEqual(visionRoutingEnvPatch(env, cfg, undefined), env);
});

test('两道注入缺一不可：只有 pin 没有 KHY_VISION_MODELS 时钉选分支不触发', () => {
  // 这条是本次改动存在的理由。isVisionCapableModel 拿**完整带前缀的 pin** 做
  // 精确集/子串判定，_normModel 不剥 pool 前缀，所以名字不含 VISION_NAME_HINTS
  // 片段的 id 会被静默判为纯文本 → 钉选分支整个跳过 → 悄悄退回 OCR，不报错。
  //
  // 故意用 `khy-eyes/` 而不是我们真实的 `khy-vision/`：后者**池名本身含 'vision'
  // 片段**，会误打误撞命中启发式，从而掩盖第二道注入的作用。用不含片段的前缀
  // 才能证明注入是真的必要，而不是靠池名运气。
  const { decideVisionRouting } = require('../services/gateway/visionRouting');
  const pin = 'khy-eyes/plain-model';

  const withoutModels = { KHY_VISION_FALLBACK_MODEL: pin };
  assert.strictEqual(
    decideVisionRouting({
      hasImage: true,
      currentModel: 'text-only-model',
      candidateModels: [],
      env: withoutModels,
    }).action,
    'ocr-fallback',
    '只有 pin 时，非启发式 id 会被静默丢弃——这正是要规避的 bug'
  );

  const withModels = {
    KHY_VISION_FALLBACK_MODEL: pin,
    KHY_VISION_MODELS: pin,
  };
  const d = decideVisionRouting({
    hasImage: true,
    currentModel: 'text-only-model',
    candidateModels: [],
    env: withModels,
  });
  assert.strictEqual(d.action, 'switch-model');
  assert.strictEqual(d.model, pin);
  assert.strictEqual(d.reason, 'switched_to_pinned_vision_model');
  assert.strictEqual(d.poolHint, 'khy-eyes', 'poolHint 是端点切换的载体');
});

test('已有的 KHY_VISION_MODELS 是追加不是替换', () => {
  // 用户可能已经为别的用途设了 KHY_VISION_MODELS，替换掉会静默改变别的路由。
  const env = { KHY_VISION_MODELS: 'qwen-vl-4b' };
  const out = visionRoutingEnvPatch(env, { pin: 'khy-vision/step-2-16k' }, true);
  assert.strictEqual(out.KHY_VISION_MODELS, 'qwen-vl-4b,khy-vision/step-2-16k');
});

test('二次调用不重复追加 pin', () => {
  const cfg = { pin: 'khy-vision/step-2-16k' };
    const once = visionRoutingEnvPatch({}, cfg);
    const twice = visionRoutingEnvPatch(once, cfg, true);
    assert.strictEqual(twice.KHY_VISION_MODELS, 'khy-vision/step-2-16k');
    assert.strictEqual(twice.KHY_VISION_FALLBACK_MODEL, 'khy-vision/step-2-16k');
});

test('visionRoutingEnvPatch 不修改入参 env', () => {
  const env = { KHY_VISION_MODELS: 'qwen-vl-4b' };
    const before = JSON.stringify(env);
    visionRoutingEnvPatch(env, { pin: 'khy-vision/step-2-16k' }, true);
    assert.strictEqual(JSON.stringify(env), before, '原地改 env 会污染调用方的副本');
});

// ── 纯函数：pin 与 URL 规范化 ───────────────────────────────────────────────

test('visionPin 分隔符是 / 且空模型返回空', () => {
  assert.strictEqual(visionPin('step-2-16k'), 'khy-vision/step-2-16k');
  assert.strictEqual(visionPin('  '), '');
  assert.strictEqual(visionPin(null), '');
});

test('normalizeVisionBaseUrl 去全部尾部斜杠', () => {
  assert.strictEqual(
    normalizeVisionBaseUrl('https://a.example.com/v1///'),
    'https://a.example.com/v1'
  );
});

test('normalizeVisionBaseUrl 拒非 http(s) scheme', () => {
  // 拼 endpoint 时一个错 scheme 会变成打到错误协议，报错却指向 TLS。
  assert.strictEqual(normalizeVisionBaseUrl('ftp://a.example.com'), '');
  assert.strictEqual(normalizeVisionBaseUrl('a.example.com'), '');
  assert.strictEqual(normalizeVisionBaseUrl(''), '');
  assert.strictEqual(normalizeVisionBaseUrl('   '), '');
});

test('无配置文件 → readVisionEndpoint() 为 null，applyVisionRoutingEnv 返回同一引用', () => {
  resetIo();
  const env = {};
  assert.strictEqual(applyVisionRoutingEnv(env), env);
});

test('describeVisionEndpoint 不返回裸 key', () => {
  resetIo();
  const written = writeVisionEndpoint({
    baseUrl: 'https://your-vision-api.example.com/v1',
    model: 'step-2-16k',
    apiKey: 'sk-test-1234567890abcdef',
  }, REAL_POOL);
  assert.ok(written, '写入应有返回');
  assert.ok(!JSON.stringify(written).includes('sk-test-1234567890abcdef'),
    'describeVisionEndpoint 的回值里出现了裸 key');

  // 配置文件本身也不含密钥材料。
  const raw = fs.readFileSync(configFilePath(), 'utf8');
  assert.ok(!raw.includes('sk-test-1234567890abcdef'),
    'vision_endpoint.json 里出现了裸 key——R2 红线');
  assert.ok(raw.includes('your-vision-api.example.com'));
  assert.ok(raw.includes('step-2-16k'));
  assert.ok(raw.includes('updatedAt'));
});

test('writeVisionEndpoint 往返：读回来是同一份配置', () => {
  resetIo();
  writeVisionEndpoint({
    baseUrl: 'https://your-vision-api.example.com/v1/',
    model: 'step-2-16k',
    apiKey: 'sk-test-1234567890abcdef',
  }, REAL_POOL);
  const back = readVisionEndpoint();
  assert.strictEqual(back.baseUrl, 'https://your-vision-api.example.com/v1',
    '尾部斜杠应被规范化掉');
  assert.strictEqual(back.model, 'step-2-16k');
  assert.strictEqual(back.poolKey, 'khy-vision');
  assert.strictEqual(back.pin, 'khy-vision/step-2-16k');
  assert.ok(back.updatedAt > 0);
});

test('writeVisionEndpoint 拒绝空 baseUrl 与带空格的 model', () => {
  resetIo();
  assert.throws(() => writeVisionEndpoint({ baseUrl: '', model: 'm' }, REAL_POOL), /baseUrl/);
  // 空 model 不再拒绝：半配置是惰性的（见下一个用例），拒绝它只会让
  // `khy config set model.vision.base_url <url>` 在新机器上永远失败。
  assert.throws(
    () => writeVisionEndpoint({ baseUrl: 'https://a.example.com', model: 'a b' }, REAL_POOL),
    /空格/,
    '模型名带空格会被 KHY_VISION_MODELS 的 /[,\s]+/ 切成两半'
  );
  assert.throws(
    () => writeVisionEndpoint({ baseUrl: 'https://a.example.com', model: 'm', apiKey: 'k', clearApiKey: true }, REAL_POOL),
    /冲突/
  );
  // 全部失败后不应留下半配置文件。
  assert.strictEqual(readVisionEndpoint(), null);
});

test('增量写入：只给一个字段时另一个从盘上的半配置取回', () => {
  // 这是「一个一个字段填」的前提。合并源必须是原始声明而不是
  // readVisionEndpoint()——后者对半配置返回 null，URL 就找不回来了。
  resetIo();
  writeVisionEndpoint({ baseUrl: 'https://your-vision-api.example.com/v1' }, REAL_POOL);
  assert.strictEqual(readVisionEndpoint(), null, '缺 model 的半配置必须读成 null');
  writeVisionEndpoint({ model: 'step-2-16k' }, REAL_POOL);
  const done = readVisionEndpoint();
  assert.strictEqual(done.baseUrl, 'https://your-vision-api.example.com/v1', '第二次写入把 URL 丢了');
  assert.strictEqual(done.pin, 'khy-vision/step-2-16k');

  // 反方向（先 model 后 baseUrl）在全新数据家上不可能：baseUrl 是唯一必填字段，
  // 一个连 URL 都没有的配置没有任何意义。所以那儿必须报错，而不是静默写一个
  // 永远读不出来的文件。
  resetIo();
  assert.throws(() => writeVisionEndpoint({ model: 'qwen-vl-max' }, REAL_POOL), /baseUrl/);
});

test('增量写入：空串是「显式清空」，不是「没给」', () => {
  // 把空串当没给会让旧值复活，用户以为清掉了其实没有。
  resetIo();
  writeVisionEndpoint({ baseUrl: 'https://a.example.com/v1', model: 'm' }, REAL_POOL);
  writeVisionEndpoint({ model: '' }, REAL_POOL);
  assert.strictEqual(readVisionEndpoint(), null, 'model 被显式清空后端点应重新变成未配置');
  assert.strictEqual(readVisionEndpointDraft().baseUrl, 'https://a.example.com/v1', 'URL 不该被动到');
});

test('clearVisionEndpoint 删掉配置文件', () => {
  resetIo();
  writeVisionEndpoint({
    baseUrl: 'https://your-vision-api.example.com/v1',
    model: 'step-2-16k',
    apiKey: 'sk-test-1234567890abcdef',
  }, REAL_POOL);
  assert.ok(readVisionEndpoint());
  clearVisionEndpoint(REAL_POOL);
  // 读动作不改盘（本模块用裸 fs 而不是 configGuard.safeReadJsonSync，正是为了
  // 避开那个 helper 的文件缺失自愈），所以这里可以直接断言文件没了。
  assert.strictEqual(fs.existsSync(configFilePath()), false);
  assert.strictEqual(readVisionEndpoint(), null, '清空后不应再读出配置');
});
