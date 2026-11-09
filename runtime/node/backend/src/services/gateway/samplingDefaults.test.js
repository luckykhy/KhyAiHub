'use strict';

/**
 * samplingDefaults — 行为锁：采样参数默认表的单一真源地位。
 *
 * 锁四件事：
 *   ① 表里每个通道的数值 —— 它们是各适配器改前的逐项搬迁；谁改默认值谁先红
 *      （改默认值 = 改对外行为，须人批准，不让它静默发生）；
 *   ② 档位查询契约 —— 按 (能力档位, 通道) 取条目，未知 key fail-soft 返回 null；
 *   ③ 表不可变 —— 冻结，消费方不得就地改写共享默认值；
 *   ④ 优先级 —— 显式传入 / 强制锁（samplingPolicy.lockTemperature）永远压过本表：
 *      消费点一律「options.x ?? 表」，上游 4 处锁落点仍显式传锁值。这一条由消费点
 *      形状与 loopback 行为两头钉住。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { test, describe, before, after } = require('node:test');

const { SAMPLING_DEFAULTS, getDefaults } = require('./samplingDefaults');

// 迁移自各适配器改前字面量的逐项数值。这张表是回归主防线。
const MIGRATED = {
  'precise/visionDescribe': { temperature: 0.2, maxTokens: 2048 },
  'precise/generateOllamaDirect': { temperature: 0.1, top_p: 0.85, maxTokens: 2048 },
  'precise/generateNodeLlama': { temperature: 0.1, top_p: 0.85, maxTokens: 2048 },
  'precise/generatePython': { temperature: 0.1, top_p: 0.85, maxTokens: 2048 },
  'toolCall/cursor2api': { temperature: 0.3, maxTokens: 4096 },
  'toolCall/relayApi': { temperature: 0.3 },
  'toolCall/trae': { temperature: 0.4, maxTokens: 2048 },
  'creative/codexDirect': { temperature: 0.7, maxTokens: 4096 },
  'creative/generateRunner': { temperature: 0.6, top_p: 0.85, maxTokens: 1024 },
  'creative/generateOllamaThink': { temperature: 0.6, top_p: 0.85, maxTokens: 2048 },
};

for (const [key, expected] of Object.entries(MIGRATED)) {
  test(`默认值钉住 ${key}`, () => {
    const [tier, channel] = key.split('/');
    assert.deepStrictEqual(getDefaults(tier, channel), expected);
  });
}

test('档位名册：精确/工具调用/创意三档，条目数与迁移清单一一对应', () => {
  assert.deepStrictEqual(Object.keys(SAMPLING_DEFAULTS), ['precise', 'toolCall', 'creative']);
  const channels = Object.values(SAMPLING_DEFAULTS).flatMap((byChannel) => Object.keys(byChannel));
  assert.deepStrictEqual(channels.sort(), Object.keys(MIGRATED).map((k) => k.split('/')[1]).sort());
});

test('档位查询：未知档位/通道/原型键返回 null（fail-soft，不误删也不瞎给）', () => {
  assert.strictEqual(getDefaults('toolCall', 'trae').temperature, 0.4);
  const badKeys = [
    ['nope', 'trae'],
    ['toolCall', 'nope'],
    ['constructor', 'trae'],
    ['toolCall', 'constructor'],
    ['toolCall', '__proto__'],
    [undefined, undefined],
    [null, ''],
  ];
  for (const [tier, channel] of badKeys) {
    assert.strictEqual(getDefaults(tier, channel), null, `${String(tier)}/${String(channel)} 应判未知`);
  }
});

test('表与条目冻结：消费方不得就地改写共享默认值', () => {
  assert.ok(Object.isFrozen(SAMPLING_DEFAULTS));
  for (const [tier, byChannel] of Object.entries(SAMPLING_DEFAULTS)) {
    assert.ok(Object.isFrozen(byChannel), `${tier} 档未冻结`);
    for (const [channel, entry] of Object.entries(byChannel)) {
      assert.ok(Object.isFrozen(entry), `${tier}/${channel} 条目未冻结`);
    }
  }
});

test('叶子零依赖：源码不含 require( 调用语法（纯决策叶，防架构债扫描器幽灵边）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'samplingDefaults.js'), 'utf8');
  assert.strictEqual(
    /\brequire\s*\(/.test(src),
    false,
    'samplingDefaults leaf source (incl. comments) must contain no require-call syntax'
  );
});

// 消费点文件（相对本目录）。aiGatewayGenerateMethod 是嵌套 generate 的字面量搬迁，
// 其余是 options 合并点。
const CONSUMER_FILES = [
  'adapters/codexAdapter.js',
  'adapters/cursor2apiAdapter.js',
  'adapters/traeAdapter.js',
  'adapters/relayApiAdapter.js',
  '../localLLMService.js',
  'aiGatewayGenerateMethod.js',
];
const OPTION_DRIVEN_FILES = CONSUMER_FILES.filter((f) => f !== 'aiGatewayGenerateMethod.js');

test('消费点：叶 require 懒加载在函数体内（顶层会进 aiGateway 冷闭包预算）', () => {
  for (const rel of CONSUMER_FILES) {
    const lines = fs.readFileSync(path.join(__dirname, rel), 'utf8').split(/\r?\n/);
    const reqLine = lines.find((l) => /require\(['"][^'"]*samplingDefaults['"]\)/.test(l));
    assert.ok(reqLine, `${rel} 未 require samplingDefaults 叶`);
    assert.match(reqLine, /^\s+\S/, `${rel} 的叶 require 在顶层 —— 会进 aiGateway 冷闭包（CORE-LAYERS L1 预算顶格）`);
  }
});

test('消费点：temperature/top_p 的兜底值全部来自叶（不再有裸字面量兜底）', () => {
  for (const rel of OPTION_DRIVEN_FILES) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.doesNotMatch(
      src,
      /options\.(temperature|top_p)\s*(\?\?|\|\|)\s*-?\d/,
      `${rel} 还有「options.temperature/top_p ?? 裸数字」—— 兜底必须走 samplingDefaults 叶`
    );
  }
});

test('消费点：表永不出现在合并运算符左侧（显式值/强制锁必须优先于默认表）', () => {
  for (const rel of CONSUMER_FILES) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.doesNotMatch(
      src,
      /_sd\w*\.(temperature|top_p|maxTokens)\s*(\?\?|\|\|)\s*options\./,
      `${rel} 出现「表 ?? options.x」—— 优先级被静默翻转成表压过显式值/强制锁`
    );
  }
});

test('强制锁未被顶替：仓内 4 处锁落点仍显式传锁值', () => {
  const builder = fs.readFileSync(path.join(__dirname, '../../cli/aiMessageBuilder.js'), 'utf8');
  assert.match(builder, /temperature:\s*runtime\.lockTemperature\(userMessage\)/);
  assert.match(builder, /top_p:\s*lockedTopP/);
  const helpers = fs.readFileSync(path.join(__dirname, '../../cli/aiGatewayGenerateHelpers.js'), 'utf8');
  assert.match(helpers, /temperature:\s*runtime\.lockTemperature\(userMessage\)/);
  assert.match(helpers, /top_p:\s*runtime\.lockTopP\(userMessage\)/);
  const localAdapter = fs.readFileSync(path.join(__dirname, 'adapters/localLLMAdapter.js'), 'utf8');
  assert.match(localAdapter, /temperature:\s*forcedTemperature/);
  assert.match(localAdapter, /top_p:\s*forcedTopP/);
  const ollama = fs.readFileSync(path.join(__dirname, 'adapters/ollamaAdapter.js'), 'utf8');
  // 锁值先经 lockTemperature/lockTopP 算成 forced*，再进三条 payload（/api/chat 的
  // buildRequestBody、chatPayload.options、/api/generate 兜底 payload）。
  assert.match(ollama, /forcedTemperature\s*=\s*runtime\.lockTemperature\(/);
  assert.match(ollama, /forcedTopP\s*=\s*runtime\.lockTopP\(/);
  assert.strictEqual((ollama.match(/temperature:\s*forcedTemperature/g) || []).length, 3);
  assert.strictEqual((ollama.match(/top_p:\s*forcedTopP/g) || []).length, 2);
});

test('ollama /api/chat 两模式共享 top_p/maxTokens：只改一头必须同时改另一头', () => {
  // generateOllama 站点上 think 开/关共用同一组 top_p/maxTokens（从 think 条目取、
  // 同时作用于 direct 模式，见 localLLMService.js generateOllama 注释）。两档数值必须
  // 一致，否则将来只改 generateOllamaThink 的 top_p/maxTokens 会静默带偏 direct 模式。
  const think = getDefaults('creative', 'generateOllamaThink');
  const direct = getDefaults('precise', 'generateOllamaDirect');
  assert.strictEqual(think.top_p, direct.top_p);
  assert.strictEqual(think.maxTokens, direct.maxTokens);
});

// ── loopback 行为：默认表真的落到出站请求体上，且显式值（强制锁形态）压过表 ──

function canBindLoopbackSync() {
  const probe = `
    const net = require('net');
    const server = net.createServer();
    server.once('error', () => process.exit(1));
    server.listen(0, '127.0.0.1', () => server.close(() => process.exit(0)));
  `;
  try {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, ['-e', probe], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

const describeWithLoopback = canBindLoopbackSync() ? describe : describe.skip;

describeWithLoopback('cursor2api 采样默认值（loopback）', () => {
  const adapter = require('./adapters/cursor2apiAdapter');
  let server;
  let captured;
  let prevBaseUrl;

  before(() => {
    captured = [];
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        captured.push(JSON.parse(raw || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-sampling-defaults',
            model: 'cursor-test-model',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      });
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    }).then(() => {
      prevBaseUrl = process.env.CURSOR2API_BASE_URL;
      process.env.CURSOR2API_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    });
  });

  after(() => {
    if (prevBaseUrl === undefined) {
      delete process.env.CURSOR2API_BASE_URL;
    } else {
      process.env.CURSOR2API_BASE_URL = prevBaseUrl;
    }
    return new Promise((resolve) => server.close(() => resolve()));
  });

  test('不传 temperature/maxTokens → 出站请求体取默认表的值（0.3 / 4096）', async () => {
    const res = await adapter.generate('hi', {});
    assert.strictEqual(res.success, true);
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].temperature, 0.3);
    assert.strictEqual(captured[0].max_tokens, 4096);
  });

  test('显式 temperature（强制锁形态）→ 出站用锁值，默认表不生效', async () => {
    captured = [];
    const res = await adapter.generate('hi', { temperature: 0.1, top_p: 0.85 });
    assert.strictEqual(res.success, true);
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].temperature, 0.1);
    assert.strictEqual(captured[0].top_p, 0.85);
  });

  test('显式 temperature=0 不被当假值吞掉（?? 语义，非 ||）', async () => {
    captured = [];
    const res = await adapter.generate('hi', { temperature: 0 });
    assert.strictEqual(res.success, true);
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].temperature, 0);
  });
});
