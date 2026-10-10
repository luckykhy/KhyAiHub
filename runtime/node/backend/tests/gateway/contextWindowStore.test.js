'use strict';

/**
 * contextWindowStore.test.js — 上下文窗口跨重启记忆的契约单测(node:test, 零网络)。
 *
 * 用户诉求（逐条对应下面的 describe）：
 *   - 「一开始给小了，发现可以更大后要更新」   → VERIFIED 来源可上调
 *   - 「一开始给大了，发现更小要改小」          → VERIFIED 来源可下调（**本仓特例**：
 *     toolCapabilityStore 是「只晋升不降级」，因为它的下调信号是「这次没看到」这种弱
 *     证据；这里的下调信号是上游 400 里报出的真实限制，是硬证据）
 *   - 「下一次重启保证用的实际值」              → 落盘格式 + listLearnedContextWindows 播种
 *
 * 全部用注入的假 env（KHY_CONTEXT_WINDOW_LEARNED_FILE 指到临时文件），绝不碰真实数据目录。
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getLearnedContextWindow,
  recordLearnedContextWindow,
  listLearnedContextWindows,
  VERIFIED_SOURCES,
  NOMINAL_SOURCES,
  _resetCache,
} = require('../../src/services/gateway/contextWindowStore');

let tmpDir;
let tmpFile;

function envFor(extra = {}) {
  return { KHY_CONTEXT_WINDOW_LEARNED_FILE: tmpFile, ...extra };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxwin-store-'));
  tmpFile = path.join(tmpDir, 'context_window.json');
  _resetCache();
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('双向修正', () => {
  test('给小了 → 学到更大值后上调', () => {
    const env = envFor();
    assert.strictEqual(getLearnedContextWindow('glm-5.2', env), 0);
    assert.strictEqual(recordLearnedContextWindow('glm-5.2', 1000000, { source: 'probe' }, env), true);
    assert.strictEqual(getLearnedContextWindow('glm-5.2', env), 1000000);
  });

  test('给大了 → 上游 400 报出更小窗口后下调（这是本仓与 toolCapabilityStore 的分歧点）', () => {
    const env = envFor();
    recordLearnedContextWindow('agnes-2.0-flash', 1000000, { source: 'probe' }, env);
    assert.strictEqual(getLearnedContextWindow('agnes-2.0-flash', env), 1000000);
    // 上游在 400 里说「maximum context length is 262144」→ 这是比探测更硬的证据
    assert.strictEqual(recordLearnedContextWindow('agnes-2.0-flash', 262144, { source: 'error-extract' }, env), true);
    assert.strictEqual(getLearnedContextWindow('agnes-2.0-flash', env), 262144);
  });

  test('标称来源（free-catalog）绝不覆盖已学到的实测值', () => {
    const env = envFor();
    recordLearnedContextWindow('glm-5.2', 200000, { source: 'probe' }, env);
    // models.dev 登记 1M，若允许覆盖，每次启动目录一热就把真值冲掉
    assert.strictEqual(recordLearnedContextWindow('glm-5.2', 1000000, { source: 'free-catalog' }, env), false);
    assert.strictEqual(getLearnedContextWindow('glm-5.2', env), 200000);
  });

  test('标称来源在无记录时可以先填', () => {
    const env = envFor();
    assert.strictEqual(recordLearnedContextWindow('kimi-k3', 1048576, { source: 'free-catalog' }, env), true);
    assert.strictEqual(getLearnedContextWindow('kimi-k3', env), 1048576);
  });

  test('实测覆盖标称（反向：目录先填 1M，探测发现只有 200K）', () => {
    const env = envFor();
    recordLearnedContextWindow('glm-5.2', 1000000, { source: 'free-catalog' }, env);
    assert.strictEqual(recordLearnedContextWindow('glm-5.2', 200000, { source: 'probe' }, env), true);
    assert.strictEqual(getLearnedContextWindow('glm-5.2', env), 200000);
  });

  test('同源同值 → 幂等，不写盘（避免每轮请求都落盘）', () => {
    const env = envFor();
    recordLearnedContextWindow('gpt-4o', 128000, { source: 'probe' }, env);
    const mtime1 = fs.statSync(tmpFile).mtimeMs;
    assert.strictEqual(recordLearnedContextWindow('gpt-4o', 128000, { source: 'probe' }, env), false);
    assert.strictEqual(fs.statSync(tmpFile).mtimeMs, mtime1);
  });
});

describe('跨重启：落盘格式与播种', () => {
  test('落盘后可被「另一个进程」读出（模拟重启）', () => {
    const env = envFor();
    recordLearnedContextWindow('agnes-2.0-flash', 512000, { source: 'error-extract' }, env);
    assert.ok(fs.existsSync(tmpFile), '记忆文件应已落盘');
    // 清掉进程内缓存 = 模拟新进程
    _resetCache();
    assert.strictEqual(getLearnedContextWindow('agnes-2.0-flash', env), 512000);
  });

  test('文件格式：version + entries[key] = {value, source, measuredAt}', () => {
    const env = envFor();
    recordLearnedContextWindow('agnes-2.0-flash', 512000, { source: 'probe' }, env);
    const parsed = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    assert.strictEqual(parsed.version, 1);
    assert.strictEqual(parsed.entries['agnes-2.0-flash'].value, 512000);
    assert.strictEqual(parsed.entries['agnes-2.0-flash'].source, 'probe');
    assert.ok(parsed.entries['agnes-2.0-flash'].measuredAt > 0);
  });

  test('listLearnedContextWindows：网关构造期播种用，带剩余 TTL 与 stale 标记', () => {
    const env = envFor({ KHY_CONTEXT_WINDOW_LEARNED_TTL_MS: '60000' });
    recordLearnedContextWindow('fresh-model', 262144, { source: 'probe' }, env);
    recordLearnedContextWindow('stale-model', 65536, { source: 'error-extract' }, env);
    // 把 stale-model 的 measuredAt 改成很久以前 → 应被判为陈旧
    const parsed = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    parsed.entries['stale-model'].measuredAt = Date.now() - 3600000;
    fs.writeFileSync(tmpFile, JSON.stringify(parsed, null, 2), 'utf-8');
    _resetCache();

    const recs = listLearnedContextWindows(env);
    const byModel = Object.fromEntries(recs.map((r) => [r.model, r]));
    assert.strictEqual(byModel['fresh-model'].stale, false);
    assert.ok(byModel['fresh-model'].ttlMs > 0);
    assert.strictEqual(byModel['stale-model'].stale, true);
  });

  test('陈旧记录仍照常返回（比猜 128000 可靠），只是被标 stale 待重探', () => {
    const env = envFor({ KHY_CONTEXT_WINDOW_LEARNED_TTL_MS: '60000' });
    recordLearnedContextWindow('ancient', 262144, { source: 'probe' }, env);
    const parsed = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    parsed.entries.ancient.measuredAt = Date.now() - 99999999;
    fs.writeFileSync(tmpFile, JSON.stringify(parsed, null, 2), 'utf-8');
    _resetCache();
    assert.strictEqual(getLearnedContextWindow('ancient', env), 262144, '过期不等于遗忘');
    assert.strictEqual(listLearnedContextWindows(env)[0].stale, true);
  });
});

describe('键规范化与来源分类', () => {
  test('三段式 api:<pool>:<model> 与裸名折叠到同一条记忆', () => {
    const env = envFor();
    recordLearnedContextWindow('api:agnes:agnes-2.0-flash', 512000, { source: 'probe' }, env);
    assert.strictEqual(getLearnedContextWindow('agnes-2.0-flash', env), 512000);
    assert.strictEqual(getLearnedContextWindow('agnes/agnes-2.0-flash', env), 512000);
  });

  test('VERIFIED / NOMINAL 两类来源互不重叠且都覆盖得到', () => {
    assert.ok(VERIFIED_SOURCES.has('probe'));
    assert.ok(VERIFIED_SOURCES.has('error-extract'));
    assert.ok(VERIFIED_SOURCES.has('listModels'));
    assert.ok(NOMINAL_SOURCES.has('free-catalog'));
    for (const s of NOMINAL_SOURCES) assert.ok(!VERIFIED_SOURCES.has(s), `${s} 不能同时算已验证`);
  });
});

describe('健壮性与逃生门', () => {
  test('开关关闭 → 既不读也不写', () => {
    const on = envFor();
    recordLearnedContextWindow('glm-5.2', 1000000, { source: 'probe' }, on);
    const off = envFor({ KHY_CONTEXT_WINDOW_LEARNED: '0' });
    _resetCache();
    assert.strictEqual(getLearnedContextWindow('glm-5.2', off), 0);
    assert.strictEqual(recordLearnedContextWindow('other', 512000, { source: 'probe' }, off), false);
  });

  test('畸形文件 / 非法条目 → 静默当没记过，绝不抛', () => {
    const env = envFor();
    fs.writeFileSync(tmpFile, '{not json', 'utf-8');
    _resetCache();
    assert.strictEqual(getLearnedContextWindow('glm-5.2', env), 0);

    fs.writeFileSync(tmpFile, JSON.stringify({ version: 1, entries: { a: { value: -5 } } }), 'utf-8');
    _resetCache();
    assert.strictEqual(getLearnedContextWindow('a', env), 0);
  });

  test('值超天花板被钳回，非正值被拒', () => {
    const env = envFor();
    recordLearnedContextWindow('huge', 99999999, { source: 'probe' }, env);
    assert.strictEqual(getLearnedContextWindow('huge', env), 1048576);
    assert.strictEqual(recordLearnedContextWindow('zero', 0, { source: 'probe' }, env), false);
    assert.strictEqual(recordLearnedContextWindow('nan', NaN, { source: 'probe' }, env), false);
  });

  test('容量上限：超了淘汰最旧条目', () => {
    const env = envFor({ KHY_CONTEXT_WINDOW_LEARNED_MAX_ENTRIES: '8' });
    for (let i = 0; i < 14; i++) {
      recordLearnedContextWindow(`m-${i}`, 100000 + i, { source: 'probe' }, env);
    }
    const recs = listLearnedContextWindows(env);
    assert.ok(recs.length <= 8, `应被裁到 8 条，实际 ${recs.length}`);
    assert.ok(!recs.some((r) => r.model === 'm-0'), '最旧的应被淘汰');
    assert.ok(recs.some((r) => r.model === 'm-13'), '最新的应保留');
  });

  test('入参非法（空串 / null / 非串）→ 0 且不抛', () => {
    const env = envFor();
    for (const bad of ['', null, undefined, {}, 123]) {
      assert.strictEqual(getLearnedContextWindow(bad, env), 0);
      assert.strictEqual(recordLearnedContextWindow(bad, 1000, { source: 'probe' }, env), false);
    }
  });
});
