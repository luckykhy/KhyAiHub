'use strict';

/**
 * multiFreeService.zenFlappyNotice.test.js — 「选中抖动模型的提前告知」接线守卫。
 *
 * 方案 P3.1 收尾：用户选中 flappy 的 Zen 免费模型时，在真正发请求**之前**经 onChunk
 * notice 告知近期失败率与更稳的替代（tools 剥离提示同一条既有通道），而不是等撞上
 * 429 才知道。本套件锁死：flappy → notice 点名替代；stable/无样本 → 静默；门关 → 静默。
 *
 * 测试手法：KHY_ZEN_BASE_URL（SSOT env 覆盖）指向本地 HTTP 服务器，且必须在**首次
 * require** multiFreeService 之前设置——serviceDefaults 在模块加载时读 env 缓存。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 共享本地服务器：恒回 500 + Zen 同款错误体（notice 在请求前发，结果成败无所谓）。
let _srv = null;
const srvReady = new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(
      '{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}'
    );
  });
  server.listen(0, '127.0.0.1', () => {
    server.unref(); // 不让共享服务器把测试进程钉在事件循环上
    _srv = server;
    resolve(server);
  });
});

function seedLedger(spec) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khy-flap-')), 's.json');
  const now = Date.now();
  const state = {};
  for (const [id, ok, n] of spec) {
    state[id] = { outcomes: Array.from({ length: n }, () => ({ ok, at: now })) };
  }
  fs.writeFileSync(file, JSON.stringify(state), 'utf-8');
  return file;
}

let MultiFreeService = null;
let stab = null;

test('setup: SSOT env 覆盖指向本地服务器后再懒加载被测模块', async () => {
  const server = await srvReady;
  process.env.KHY_ZEN_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  MultiFreeService = require('../../src/services/multiFreeService');
  stab = require('../../src/services/zenModelStability');
  assert.ok(typeof MultiFreeService === 'function');
  assert.ok(stab && typeof stab.classify === 'function');
});

test('选中 flappy 模型：请求前经 onChunk notice 告知失败率与更稳替代', async () => {
  process.env.KHY_ZEN_STABILITY_FILE = seedLedger([
    ['step-5-preview-free', false, 5],
    ['mimo-v2.6-flash-free', true, 5],
  ]);
  stab._reset();
  const svc = new MultiFreeService();
  svc.providers = {
    'opencode-zen': {
      name: 'ZenFake',
      apiKey: 'public',
      enabled: true,
      model: 'step-5-preview-free',
      priority: 0,
      supportsVision: false,
      baseUrl: process.env.KHY_ZEN_BASE_URL,
    },
  };
  const notices = [];
  const out = await svc.generateResponse('hi', {
    temperature: 0,
    maxTokens: 16,
    onChunk: (c) => {
      if (c && c.type === 'notice') {
        notices.push(c.text);
      }
    },
  });
  assert.strictEqual(out.success, false);
  const hit = notices.find((t) => /step-5-preview-free/.test(t) && /抖动/.test(t));
  assert.ok(hit, '应有 flappy notice: ' + JSON.stringify(notices));
  assert.ok(
    /更稳的免费模型：mimo-v2\.6-flash-free/.test(hit),
    '应点名更稳替代: ' + hit
  );
  assert.ok(/仍继续尝试/.test(hit), '告知不打断原请求: ' + hit);
});

test('stable 模型与冷启动模型 → 静默（不打扰）', async () => {
  process.env.KHY_ZEN_STABILITY_FILE = seedLedger([['mimo-v2.6-flash-free', true, 5]]);
  stab._reset();
  const mk = (model) => {
    const svc = new MultiFreeService();
    svc.providers = {
      'opencode-zen': {
        name: 'ZenFake',
        apiKey: 'public',
        enabled: true,
        model,
        priority: 0,
        supportsVision: false,
        baseUrl: process.env.KHY_ZEN_BASE_URL,
      },
    };
    return svc;
  };
  const notices = [];
  await mk('mimo-v2.6-flash-free').generateResponse('hi', {
    temperature: 0,
    maxTokens: 16,
    onChunk: (c) => {
      if (c && c.type === 'notice') {
        notices.push(c.text);
      }
    },
  });
  const notices2 = [];
  await mk('never-seen-free').generateResponse('hi', {
    temperature: 0,
    maxTokens: 16,
    onChunk: (c) => {
      if (c && c.type === 'notice') {
        notices2.push(c.text);
      }
    },
  });
  assert.strictEqual(
    notices.concat(notices2).filter((t) => /抖动/.test(t)).length,
    0,
    'stable/无样本不应打 flappy notice'
  );
});

test('门关（KHY_ZEN_MODEL_STABILITY=0）→ flappy 也静默', async () => {
  process.env.KHY_ZEN_STABILITY_FILE = seedLedger([
    ['step-5-preview-free', false, 5],
    ['mimo-v2.6-flash-free', true, 5],
  ]);
  process.env.KHY_ZEN_MODEL_STABILITY = '0';
  stab._reset();
  try {
    const svc = new MultiFreeService();
    svc.providers = {
      'opencode-zen': {
        name: 'ZenFake',
        apiKey: 'public',
        enabled: true,
        model: 'step-5-preview-free',
        priority: 0,
        supportsVision: false,
        baseUrl: process.env.KHY_ZEN_BASE_URL,
      },
    };
    const notices = [];
    await svc.generateResponse('hi', {
      temperature: 0,
      maxTokens: 16,
      onChunk: (c) => {
        if (c && c.type === 'notice') {
          notices.push(c.text);
        }
      },
    });
    assert.strictEqual(notices.filter((t) => /抖动/.test(t)).length, 0);
  } finally {
    delete process.env.KHY_ZEN_MODEL_STABILITY;
  }
});
