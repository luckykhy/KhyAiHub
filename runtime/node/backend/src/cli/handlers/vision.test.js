'use strict';

/**
 * vision.js / visionConfigEditor.js — `khy vision config` 的契约测试。
 *
 * 沙箱在模块作用域、第一个项目 require 之前钉住：utils/dataHome 的解析结果有
 * 模块级缓存（src/utils/dataHome.js 的 _cached），第一次解析之后就再也不看环境
 * 变量。放在文件后面会让 IO 用例打到真实数据家去——visionEndpointStore.test.js
 * 的注释里记着这个坑的具体形态。
 *
 * 交互式三步不在覆盖范围内（要桩 inquirer 且收益低）；这里钉的是机器可读的那
 * 半边：--json 状态、flag 一次写完、增量合并、校验拒绝、清除。交互路径与它们
 * 共用同一个 _writeVisionConfig，所以校验与合并逻辑实际是被测到的。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-vision-cli-'));
const _savedDataHome = process.env.KHY_DATA_HOME;
process.env.KHY_DATA_HOME = SANDBOX;

const vision = require('./vision');
const store = require('../../services/visionEndpointStore');
const { validateManifest } = require('../commandManifest');

const pool = require('../../services/apiKeyPool');
const CONFIG_FILE = path.join(SANDBOX, 'vision_endpoint.json');

test.after(() => {
  if (_savedDataHome === undefined) {
    delete process.env.KHY_DATA_HOME;
  } else {
    process.env.KHY_DATA_HOME = _savedDataHome;
  }
  // 故意不 rmSync(SANDBOX)：require services/management 会惰性装一个滚动日志器，
  // 其 WriteStream 指向 <dataHome>/logs/active/*.log。测试结束后仍有一次异步落盘，
  // 此时删目录会拿到假红 ENOENT uncaughtException。同 src/services/domain/messaging/
  // mcp/index.test.js:78-83 的处置。SANDBOX 落在 os.tmpdir（仓外），不影响 git
  // status，交由系统回收。
});

function reset() {
  store.clearVisionEndpoint(pool);
  assert.strictEqual(fs.existsSync(CONFIG_FILE), false, 'reset 之后仍有残留配置');
}

/** 抓 console.log 的 JSON 回执。 */
function captureJson() {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  return {
    lines,
    last: () => JSON.parse(lines[lines.length - 1]),
    restore: () => {
      console.log = orig;
    },
  };
}

// ── manifest ────────────────────────────────────────────────────────────────

test('manifest 合法：name/aliases/subCommands/category 都在允许集内', () => {
  const manifest = vision.__khyCommandManifest;
  assert.ok(manifest, 'handler 必须导出 manifest，否则 commandAutoRegistry 看不见它');
  const { valid, errors } = validateManifest(manifest);
  assert.deepEqual(errors, []);
  assert.ok(valid);
  assert.equal(manifest.name, 'vision');
  assert.deepEqual(manifest.subCommands, ['config']);
  assert.ok(manifest.aliases.includes('识图'));
  assert.equal(typeof manifest.handler, 'function');
});

test('示例 URL 是假公网域名，不是 127.0.0.1', () => {
  // check-agent-rules 第一条：示例不能教人把流量打到本机回环。
  const { EXAMPLE_BASE_URL } = require('./visionConfigEditor');
  assert.ok(!/127\.0\.0\.1|localhost|0\.0\.0\.0/i.test(EXAMPLE_BASE_URL));
  assert.match(EXAMPLE_BASE_URL, /^https:\/\/your-vision-api\.example\.com\/v1$/);
});

// ── 状态与写入 ──────────────────────────────────────────────────────────────

test('未配置时 --json 报 config:null', async () => {
  reset();
  const cap = captureJson();
  try {
    const ok = await vision.handleVision('config', [], { json: true });
    assert.strictEqual(ok, true);
    assert.deepEqual(cap.last(), { ok: true, action: 'status', config: null });
  } finally {
    cap.restore();
  }
});

test('flag 一次写完：三个字段 + 掩码回执，且不进 .env', async () => {
  reset();
  const cap = captureJson();
  let ok;
  try {
    ok = await vision.handleVision('config', [], {
      json: true,
      'base-url': 'https://your-vision-api.example.com/v1',
      model: 'step-2-16k',
      'api-key': 'sk-test-1234567890abcdef',
      'no-verify': true,
    });
    const payload = cap.last();
    assert.strictEqual(ok, true);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'set');
    assert.equal(payload.config.pin, 'khy-vision/step-2-16k');
    assert.equal(payload.config.hasApiKey, true);
    // R2：回执里不出现裸 key。
    assert.ok(!JSON.stringify(payload).includes('sk-test-1234567890abcdef'));
  } finally {
    cap.restore();
  }

  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  assert.ok(!raw.includes('sk-test-1234567890abcdef'), 'vision_endpoint.json 里出现裸 key——R2 红线');
  assert.ok(raw.includes('step-2-16k'));
});

test('增量：只给 --model 时 Base URL 从当前配置取，不要求重打', async () => {
  reset();
  const cap = captureJson();
  try {
    await vision.handleVision('config', [], {
      json: true,
      'base-url': 'https://your-vision-api.example.com/v1',
      model: 'step-2-16k',
      'no-verify': true,
    });
    const ok = await vision.handleVision('config', [], { json: true, model: 'qwen-vl-max', 'no-verify': true });
    assert.strictEqual(ok, true);
    assert.equal(cap.last().config.model, 'qwen-vl-max');
    assert.equal(cap.last().config.baseUrl, 'https://your-vision-api.example.com/v1');
  } finally {
    cap.restore();
  }
});

test('坏 Base URL 被拒，且一个字节都不写', async () => {
  reset();
  const cap = captureJson();
  try {
    const ok = await vision.handleVision('config', [], {
      json: true,
      'base-url': 'ftp://nope',
      model: 'm',
      'no-verify': true,
    });
    assert.strictEqual(ok, false);
    assert.match(cap.last().error, /Base URL/);
  } finally {
    cap.restore();
  }
  assert.strictEqual(fs.existsSync(CONFIG_FILE), false);
});

test('模型名带空格被拒（会被 KHY_VISION_MODELS 按空白切两半）', async () => {
  reset();
  const cap = captureJson();
  try {
    await vision.handleVision('config', [], {
      json: true,
      'base-url': 'https://your-vision-api.example.com/v1',
      model: 'a b',
      'no-verify': true,
    });
    assert.match(cap.last().error, /空格/);
  } finally {
    cap.restore();
  }
  assert.strictEqual(fs.existsSync(CONFIG_FILE), false);
});

test('--clear 删配置文件并收回池里的钥匙', async () => {
  reset();
  await vision.handleVision('config', [], {
    json: true,
    'base-url': 'https://your-vision-api.example.com/v1',
    model: 'step-2-16k',
    'api-key': 'sk-test-1234567890abcdef',
    'no-verify': true,
  });
  assert.ok(pool.hasAvailableKeys('khy-vision'));

  const cap = captureJson();
  try {
    const ok = await vision.handleVision('config', [], { json: true, clear: true });
    assert.strictEqual(ok, true);
    assert.deepEqual(cap.last(), { ok: true, action: 'clear' });
  } finally {
    cap.restore();
  }
  assert.strictEqual(fs.existsSync(CONFIG_FILE), false);
  assert.strictEqual(pool.hasAvailableKeys('khy-vision'), false);
});

// ── 路由 ────────────────────────────────────────────────────────────────────

test('未知子命令返回 false，已知子命令走 config', async () => {
  reset();
  assert.strictEqual(await vision.handleVision('nope', [], {}), false);
  const cap = captureJson();
  try {
    assert.strictEqual(await vision.handleVision('config', [], { json: true }), true);
  } finally {
    cap.restore();
  }
  // 空子命令 = 帮助，不该报错。
  const cap2 = captureJson();
  try {
    assert.strictEqual(await vision.handleVision('', [], {}), true);
  } finally {
    cap2.restore();
  }
});

test('--json 状态下不需要 TTY：机器消费者不会被提示卡住', async () => {
  reset();
  // _isInteractive 见到 options.json 就返回 false。这里用 Object.defineProperty
  // 把 isTTY 伪成 true 来证明这一条——否则测试在非 TTY 下本来就会走到同一条路，
  // 断言不了任何东西。
  const orig = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  const cap = captureJson();
  try {
    await vision.handleVision('config', [], { json: true });
    assert.deepEqual(cap.last(), { ok: true, action: 'status', config: null });
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: orig, configurable: true });
    cap.restore();
  }
});
