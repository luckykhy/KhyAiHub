'use strict';

/**
 * opencodeFreeChannels.test.js — opencode 免费渠道对接稳定性契约(2026-10-24 核验批次)。
 *
 * 锁定四层 + 台账:
 *   A. 发现层 freeModelChannels:zen 渠道 = 2026-10-24 实测目录;台账过滤;门控回退;
 *      env 覆盖与过滤复合
 *   B. Key 池 builtinProviderConfig:zen 描述符与发现层一致;同样过滤;共享源不被污染
 *   C. 配置层 opencodeAdapter:configPath 解析矩阵(显式 env 最高,XDG 优先于便携布局)
 *      + add/list/get/usable/remove/repair 全契约(对临时配置,OPENCODE_CONFIG 注入)
 *   D. 调用层 opencodeInvocation:run --model 形状(v2 CLI 顶层 -m 已移除)
 *   E. 台账 zenRetiredModels:isRetired 判定(永久/临时 TTL)+ 上游错误分类 + 静态名单
 *   F. 网关侧 zenGatekeeper.filterFreeZenModels 用同一台账(集成点不变式)
 *
 * 确定性:全部经 env 注入(OPENCODE_CONFIG / KHY_ZEN_RETIRED_FILE / KHY_ZEN_RETIRED_FILTER),
 * 不依赖本机真实配置与账本;每个用例前后 retired._reset() 清模块缓存。
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fc = require('../../src/services/freeModelChannels');
const bpc = require('../../src/services/gateway/builtinProviderConfig');
const adapter = require('../../src/services/domain/network/externalApps/opencodeAdapter');
const invocation = require('../../src/services/gateway/adapters/opencodeInvocation');
const retired = require('../../src/services/zenRetiredModels');
const zenGate = require('../../src/services/zenGatekeeper');
const zenIdentity = require('../../src/services/zenIdentity');

// 2026-10-24 实测上游目录(opencode models 的 opencode/* 免费项),两个静态清单的唯一基准
// 相对 10-21 批次:新增 flint-40b-free、jev-1.13-free(10-21 下线、10-24 上游已恢复);
// 剔除 minimax-m3.1-flash-free、longcat-2.5-preview-free、nemotron-3-ultra-free(上游目录已收)。
const ZEN_CATALOG = [
  'mimo-v2.6-flash-free',
  'big-pickle',
  'glm-5.3-flash-free',
  'deepseek-v4.1-flash-free',
  'flint-40b-free',
  'jev-1.13-free',
  'nemotron-3.5-lightning-free',
  'nemotron-3.5-super-vl-free',
  'beam-free',
];

// 已知废弃(2026-10-09 / 2026-10-24 实测上游 401/410/403 或已不在目录)——发现层不得出现
// 注:jev-1.13-free 曾在 10-21 批次被列为废弃,10-24 上游目录已恢复该 id 且可调用 → 移出本表。
const ZEN_RETIRED_KNOWN = [
  'mimo-v2.5-free',
  'deepseek-v4-flash-free',
  'exo-free',
  'ling-3.0-flash-fin-free',
  'muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free',
  'minimax-m3.1-flash-free',
  'longcat-2.5-preview-free',
  'nemotron-3-ultra-free',
];

const ENV_KEYS = [
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'KHY_ZEN_RETIRED_FILE',
  'KHY_ZEN_RETIRED_FILTER',
  'KHY_OPENCODE_CONFIG_HEAL',
  // Zen 身份（每机机器码）相关键：必须隔离，否则开发者真实 env 会渗进契约判定，
  // 且身份会落到真实数据目录而非沙箱。
  'KHY_ZEN_IDENTITY',
  'KHY_ZEN_SESSION_ID',
  'KHY_ZEN_PROJECT_ID',
  'KHY_MACHINE_ID',
];

let tmpRoot;

beforeEach(() => {
  retired._reset();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-freech-'));
  // 身份落盘进沙箱（不写真实 dataHome）
  process.env.KHY_ZEN_IDENTITY_FILE = path.join(tmpRoot, 'zen_identity.json');
  try {
    zenIdentity._reset(true);
  } catch {
    /* 叶子缺失 → 无需清 */
  }
});

afterEach(() => {
  retired._reset();
  try {
    zenIdentity._reset(true);
  } catch {
    /* 叶子缺失 → 无需清 */
  }
  delete process.env.KHY_ZEN_IDENTITY_FILE;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响判定 */
  }
});

/** 临时沙箱 env:覆盖给定键,其余受控键一律删除;退出恢复。 */
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    if (k in overrides) {
      process.env[k] = overrides[k];
    } else {
      delete process.env[k];
    }
  }
  try {
    retired._reset();
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
    retired._reset();
  }
}

/** 写一份受控废弃账本(KHY_ZEN_RETIRED_FILE 的目标)。 */
function writeLedger(entries) {
  const file = path.join(tmpRoot, 'zen_retired_models.json');
  fs.writeFileSync(file, JSON.stringify(entries, null, 2), 'utf-8');
  return file;
}

/** 让台账过滤空转(指向不存在的账本),保证目录类断言跨机确定。 */
function isolateLedger() {
  process.env.KHY_ZEN_RETIRED_FILE = path.join(tmpRoot, 'no-such-ledger.json');
  retired._reset();
}

// ─────────────────────────── A. 发现层 freeModelChannels ───────────────────────────

test('A1: zen 渠道 freeModels = 2026-10-24 实测目录(9 项),不含任何已知废弃 id', () => {
  withEnv({}, () => {
    isolateLedger();
    const zen = fc.listFreeModelChannels({}).find((c) => c.key === 'opencode-zen');
    assert.deepStrictEqual(zen.freeModels, ZEN_CATALOG);
    for (const dead of ZEN_RETIRED_KNOWN) {
      assert.ok(!zen.freeModels.includes(dead), `发现层不得出现已废弃: ${dead}`);
    }
  });
});

test('A2: 台账标记的模型从发现层消失,其他渠道不受影响', () => {
  const ledger = writeLedger({ 'big-pickle': { reason: 'deprecated', at: Date.now() } });
  withEnv({ KHY_ZEN_RETIRED_FILE: ledger }, () => {
    const list = fc.listFreeModelChannels({});
    const zen = list.find((c) => c.key === 'opencode-zen');
    assert.ok(!zen.freeModels.includes('big-pickle'));
    assert.equal(zen.freeModels.length, ZEN_CATALOG.length - 1);
    const zhipu = list.find((c) => c.key === 'zhipu');
    assert.ok(zhipu.freeModels.includes('glm-4.7-flash'), '非 zen 渠道不过滤');
    assert.equal(list.find((c) => c.key === 'openrouter').freeModels.length > 0, true);
  });
});

test('A3: KHY_ZEN_RETIRED_FILTER=0 → 逐字节回退不过滤', () => {
  const ledger = writeLedger({ 'big-pickle': { reason: 'deprecated', at: Date.now() } });
  withEnv({ KHY_ZEN_RETIRED_FILE: ledger, KHY_ZEN_RETIRED_FILTER: '0' }, () => {
    const zen = fc.listFreeModelChannels({}).find((c) => c.key === 'opencode-zen');
    assert.ok(zen.freeModels.includes('big-pickle'), '门关 → 不过滤');
  });
});

test('A4: env 覆盖 zen 渠道后仍经台账过滤(覆盖与过滤复合)', () => {
  const ledger = writeLedger({ 'my-model': { reason: 'unsupported', at: Date.now() } });
  withEnv({ KHY_ZEN_RETIRED_FILE: ledger }, () => {
    // 注意:过滤读 process.env.KHY_ZEN_RETIRED_FILE(台账路径不在传入 env 的语义里)
    const env = {
      KHY_ZEN_RETIRED_FILE: ledger,
      KHY_FREE_MODEL_CHANNELS: JSON.stringify([
        { key: 'opencode-zen', freeModels: ['my-model', 'keep-me'] },
      ]),
    };
    const zen = fc.listFreeModelChannels(env).find((c) => c.key === 'opencode-zen');
    assert.deepStrictEqual(zen.freeModels, ['keep-me']);
  });
});

// ─────────────────────────── B. Key 池 builtinProviderConfig ───────────────────────────

test('B1: Key 池 zen 描述符 = 发现层清单(两处静态源一致)', () => {
  withEnv({}, () => {
    isolateLedger();
    const desc = bpc.findBuiltinProvider('opencode-zen');
    assert.deepStrictEqual(desc.models, ZEN_CATALOG);
    const zen = fc.listFreeModelChannels({}).find((c) => c.key === 'opencode-zen');
    assert.deepStrictEqual(desc.models, zen.freeModels, '发现层与 Key 池必须同源');
  });
});

test('B2: 台账标记的模型从 Key 池视图消失(listBuiltinProviders 同视图)', () => {
  const ledger = writeLedger({ 'glm-5.3-flash-free': { reason: 'unsupported', at: Date.now() } });
  withEnv({ KHY_ZEN_RETIRED_FILE: ledger }, () => {
    const desc = bpc.findBuiltinProvider('opencode-zen');
    assert.ok(!desc.models.includes('glm-5.3-flash-free'));
    assert.equal(desc.models.length, ZEN_CATALOG.length - 1);
    const listed = bpc.listBuiltinProviders().find((p) => p.poolKey === 'opencode-zen');
    assert.ok(!listed.models.includes('glm-5.3-flash-free'));
  });
});

test('B3: 过滤不改共享描述符(BUILTIN_PROVIDERS 源完整)', () => {
  const ledger = writeLedger({ 'beam-free': { reason: 'deprecated', at: Date.now() } });
  withEnv({ KHY_ZEN_RETIRED_FILE: ledger }, () => {
    bpc.findBuiltinProvider('opencode-zen');
    bpc.listBuiltinProviders();
    const src = bpc.BUILTIN_PROVIDERS.find((p) => p.poolKey === 'opencode-zen');
    assert.ok(src.models.includes('beam-free'), '共享源不被过滤污染');
  });
});

// ─────────────────────────── C. 配置层 opencodeAdapter ───────────────────────────

test('C1: configPath 解析矩阵——显式文件最高,其次显式目录,XDG 优先于便携布局', () => {
  withEnv({ OPENCODE_CONFIG: 'C:\\explicit\\file.json' }, () => {
    assert.equal(adapter.configPath(), 'C:\\explicit\\file.json');
  });
  const dir = path.join(tmpRoot, 'cfgdir');
  fs.mkdirSync(dir, { recursive: true });
  // OPENCODE_CONFIG_DIR 指向配置目录本身:文件为 <dir>/opencode.json
  fs.writeFileSync(path.join(dir, 'opencode.json'), '{}', 'utf-8');
  withEnv({ OPENCODE_CONFIG_DIR: dir }, () => {
    assert.equal(adapter.configPath(), path.join(dir, 'opencode.json'));
  });
  // XDG 存在 → 压过便携候选(便携 Tools/config 在本机也存在;顺序回归锁)
  const xdgDir = path.join(tmpRoot, 'xdg');
  fs.mkdirSync(path.join(xdgDir, 'opencode'), { recursive: true });
  const xdgCfg = path.join(xdgDir, 'opencode', 'opencode.json');
  fs.writeFileSync(xdgCfg, '{}', 'utf-8');
  withEnv({ XDG_CONFIG_HOME: xdgDir }, () => {
    assert.equal(adapter.configPath(), xdgCfg, 'XDG 候选必须先于便携候选命中');
  });
});

test('C2: adapter 全契约(add→list→get→usable→remove→repair)——对临时配置', () => {
  const cfg = path.join(tmpRoot, 'opencode.json');
  fs.writeFileSync(cfg, JSON.stringify({ model: '', provider: {} }, null, 2), 'utf-8');
  const env = { OPENCODE_CONFIG: cfg };

  // add:upsert provider + 置顶层 model;端点自动补 /v1。
  // 契约:适配器只小写化 provider id(slug 化在 appWriters 调用层,不在本叶子)。
  const r = adapter.add(
    { provider: 'My-Free-GW', model: 'some-model', apiKey: 'sk-test-123', endpoint: 'https://gw.example.com' },
    env
  );
  assert.equal(r.success, true);
  assert.equal(r.provider, 'my-free-gw');
  assert.equal(r.model, 'some-model');
  assert.equal(r.endpoint, 'https://gw.example.com/v1');
  assert.equal(r.keySource, 'nl');
  assert.equal(r.keyMasked.length > 0, true);

  // list:含新 provider,顶层 model 为 provider/model
  const list = adapter.list(env);
  assert.equal(list.success, true);
  assert.equal(list.model, 'my-free-gw/some-model');
  assert.ok(list.providers.some((p) => p.id === 'my-free-gw' && p.hasKey === true));

  // get:单 provider 详情
  const get = adapter.get('my-free-gw', env);
  assert.equal(get.success, true);
  assert.ok(get.provider.models.includes('some-model'));
  assert.equal(get.provider.endpoint, 'https://gw.example.com/v1');

  // usable:含真 key 的反向视图(khy 消费侧)
  const usable = adapter.usable(env);
  assert.ok(usable.providers.some((p) => p.id === 'my-free-gw' && p.apiKey === 'sk-test-123'));

  // remove:未确认只回 preview,不动盘
  const preview = adapter.remove({ target: 'my-free-gw' }, env);
  assert.equal(preview.preview, true);
  assert.equal(preview.confirmed, false);
  assert.ok(adapter.list(env).providers.some((p) => p.id === 'my-free-gw'), '未确认不落盘');

  // 确认删除
  const removed = adapter.remove({ target: 'my-free-gw', confirmed: true }, env);
  assert.equal(removed.success, true);
  assert.equal(removed.confirmed, true);
  assert.ok(!adapter.list(env).providers.some((p) => p.id === 'my-free-gw'));
  const doc = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
  assert.equal(doc.provider['my-free-gw'], undefined);
  assert.equal(doc.model, undefined, '顶层 model 指向被删 provider 时一并清除');
});

test('C3: repair 把 {default,list} 损坏形状迁成 {id:{name}} 映射 + 补顶层 model;无损坏 no-op', () => {
  const cfg = path.join(tmpRoot, 'corrupt.json');
  fs.writeFileSync(
    cfg,
    JSON.stringify(
      {
        provider: {
          broken: {
            npm: '@ai-sdk/openai-compatible',
            name: 'B',
            options: { baseURL: 'https://b.example.com/v1' },
            models: { default: 'm1', list: ['m2'] },
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );
  const env = { OPENCODE_CONFIG: cfg };
  const r = adapter.repair(env);
  assert.equal(r.success, true);
  assert.equal(r.changed, true);
  assert.equal(r.model, 'broken/m1');
  const doc = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
  assert.deepStrictEqual(Object.keys(doc.provider.broken.models).sort(), ['m1', 'm2']);
  assert.equal(typeof doc.provider.broken.models.m1, 'object', '迁出的条目是 {name} 对象');
  // 幂等:再修一次 no-op
  const again = adapter.repair(env);
  assert.equal(again.changed, false);
});

test('C4: KHY_OPENCODE_CONFIG_HEAL=off → repair 明确回报 disabled(不静默放行)', () => {
  const cfg = path.join(tmpRoot, 'corrupt2.json');
  fs.writeFileSync(cfg, JSON.stringify({ provider: { b: { models: { default: 'x' } } } }, null, 2), 'utf-8');
  const r = adapter.repair({ OPENCODE_CONFIG: cfg, KHY_OPENCODE_CONFIG_HEAL: 'off' });
  assert.equal(r.success, false);
  assert.match(r.error, /heal disabled/);
});

// ─────────────────────────── D. 调用层 opencodeInvocation ───────────────────────────

test('D1: buildRunArgs 形状——run 首项,prompt 不进 argv,--model 仅合法时注入', () => {
  assert.deepStrictEqual(invocation.buildRunArgs(), ['run']);
  assert.deepStrictEqual(invocation.buildRunArgs({ format: 'json' }), ['run', '--format', 'json']);
  assert.deepStrictEqual(invocation.buildRunArgs({ continueSession: true }), ['run', '--continue']);
  assert.deepStrictEqual(invocation.buildRunArgs({ sessionId: 'ses_1' }), ['run', '--session', 'ses_1']);
  assert.deepStrictEqual(invocation.buildRunArgs({ agent: 'Full-Auto' }), ['run', '--agent', 'Full-Auto']);
  // provider/model 形态,模型名本身可含 /
  assert.deepStrictEqual(invocation.buildRunArgs({ model: 'openrouter/z-ai/glm-5.2:free' }), [
    'run',
    '--model',
    'openrouter/z-ai/glm-5.2:free',
  ]);
  // 非法模型(无 /)→ 不注入,交给 opencode 用自己配置的默认模型
  assert.deepStrictEqual(invocation.buildRunArgs({ model: 'no-slash' }), ['run']);
  // v2 CLI 回归锁:顶层 -m 已移除,模型只在 run 子命令下以 --model 出现
  const args = invocation.buildRunArgs({ model: 'opencode/big-pickle' });
  assert.equal(args[0], 'run');
  assert.ok(!args.includes('-m'), '不得产出已移除的顶层 -m');
});

test('D2: applyModelArg 仅对合法模型追加,不改入参', () => {
  const base = ['run'];
  assert.deepStrictEqual(invocation.applyModelArg(base, 'a/b'), ['run', '--model', 'a/b']);
  assert.deepStrictEqual(invocation.applyModelArg(base, 'bad'), ['run']);
  assert.deepStrictEqual(invocation.applyModelArg(base, undefined), ['run']);
  assert.deepStrictEqual(base, ['run'], '入参不被改动');
});

test('D3: 门控 KHY_OPENCODE 默认开,0/false/off/no 关', () => {
  assert.equal(invocation.isEnabled({}), true);
  assert.equal(invocation.isEnabled({ KHY_OPENCODE: 'on' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(invocation.isEnabled({ KHY_OPENCODE: v }), false, v);
  }
});

// ─────────────────────────── E. 台账 zenRetiredModels ───────────────────────────

test('E1: isRetired——永久项为真,TTL 内临时项为真,过期/未知/空为假', () => {
  const ledger = writeLedger({
    'gone-forever': { reason: 'unsupported', at: Date.parse('2020-01-01T00:00:00Z') },
    'temp-fresh': { reason: 'unavailable', at: Date.now() },
    'temp-expired': { reason: 'unavailable', at: Date.now() - 8 * 24 * 60 * 60 * 1000 },
  });
  withEnv({ KHY_ZEN_RETIRED_FILE: ledger }, () => {
    assert.equal(retired.isRetired('gone-forever'), true);
    assert.equal(retired.isRetired('temp-fresh'), true);
    assert.equal(retired.isRetired('temp-expired'), false);
    assert.equal(retired.isRetired('never-seen'), false);
    assert.equal(retired.isRetired(''), false);
  });
});

test('E2: recordFromUpstreamError 只认上游明文的 deprecated/unsupported(403/429/非 JSON 不记)', () => {
  const depBody = JSON.stringify({ error: { type: 'ModelDeprecated', message: 'has been deprecated' } });
  const unsupBody = JSON.stringify({ error: { message: 'model is not supported' } });
  assert.equal(retired.recordFromUpstreamError(410, depBody, 'x-model').reason, 'deprecated');
  assert.equal(retired.recordFromUpstreamError(401, unsupBody, 'y-model').reason, 'unsupported');
  assert.equal(retired.recordFromUpstreamError(403, depBody, 'z'), null);
  assert.equal(retired.recordFromUpstreamError(429, depBody, 'z'), null);
  assert.equal(retired.recordFromUpstreamError(410, 'not-json', 'z'), null);
});

test('E3: 静态台账含 2026-10-09 实测废弃 id(发现层已剔除的同批)', () => {
  for (const id of [
    'exo-free',
    'mimo-v2.5-free',
    'deepseek-v4-flash-free',
    'ling-3.0-flash-fin-free',
    'muse-spark-1.2-contributor-free',
    'muse-spark-1.3-contributor-free',
  ]) {
    assert.ok(id in retired.BUILTIN_RETIRED, `静态台账缺 ${id}`);
  }
});

// ─────────────────────────── F. 网关侧集成点 ───────────────────────────

test('F1: zenGatekeeper.filterFreeZenModels 与发现层共用同一台账(集成不变式)', () => {
  const ledger = writeLedger({ 'big-pickle': { reason: 'deprecated', at: Date.now() } });
  withEnv({ KHY_ZEN_RETIRED_FILE: ledger }, () => {
    const kept = zenGate.filterFreeZenModels(ZEN_CATALOG);
    assert.ok(!kept.includes('big-pickle'), '网关列表同样按台账剔除');
    assert.ok(kept.includes('mimo-v2.6-flash-free'));
    // 非 -free 后缀一律不进免费列表
    assert.equal(zenGate.filterFreeZenModels(['plain-model', 'x-free']).includes('plain-model'), false);
  });
});
