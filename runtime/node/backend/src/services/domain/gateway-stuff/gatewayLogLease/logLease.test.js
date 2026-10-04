'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

// Stub the two collaborators logLease requires so decide()'s routing table is
// pinned deterministically without AsyncLocalStorage or the real noise rules.
const ctxPath = require.resolve('./context');
const nfPath = require.resolve('./noiseFilter');
const leasePath = require.resolve('./logLease');

let ctxRef = null;
require.cache[ctxPath] = {
  id: ctxPath,
  filename: ctxPath,
  loaded: true,
  exports: {
    MODES: Object.freeze({ TASK: 'task', STATUS_QUERY: 'status-query', SANDBOX: 'sandbox' }),
    normalizeAdapterId: (raw) => {
      const s = String(raw || '').trim().toLowerCase();
      return s || null;
    },
    current: () => ctxRef,
  },
};
require.cache[nfPath] = {
  id: nfPath,
  filename: nfPath,
  loaded: true,
  exports: {
    sanitizeForStatus: (raw) => `[status]${String(raw == null ? '' : raw)}`,
    // 'DEBUG' and empty string mimic the pure-noise rules translate() swallows.
    translate: (raw) => (raw === 'DEBUG' || raw === '' ? null : `[friendly]${raw}`),
  },
};

const { decide, CHANNELS } = require('./logLease');

after(() => {
  delete require.cache[ctxPath];
  delete require.cache[nfPath];
  delete require.cache[leasePath];
});

test('CHANNELS 枚举四路去向', () => {
  assert.deepEqual(CHANNELS, { L0: 'L0', L1: 'L1', BUFFER: 'BUFFER', DROP: 'DROP' });
});

test('无上下文：游离日志下沉 L1 且不可见', () => {
  ctxRef = null;
  const r = decide({ sourceAdapter: 'kiro', level: 'info', text: 'boom' });
  assert.strictEqual(r.visible, false);
  assert.strictEqual(r.channel, 'L1');
  assert.strictEqual(r.output, '[status]boom');
  assert.strictEqual(r.raw, 'boom');
});

test('查网关状态：全量可见走 L0', () => {
  ctxRef = { mode: 'status-query' };
  const r = decide({ sourceAdapter: 'x', text: 'hello' });
  assert.strictEqual(r.visible, true);
  assert.strictEqual(r.channel, 'L0');
  assert.strictEqual(r.output, '[status]hello');
});

test('静默沙箱：重定向 BUFFER 且不可见', () => {
  ctxRef = { mode: 'sandbox' };
  const r = decide({ text: 'init' });
  assert.strictEqual(r.visible, false);
  assert.strictEqual(r.channel, 'BUFFER');
  assert.strictEqual(r.output, '[status]init');
});

test('任务模式且来源==活跃适配器：净味后走 L0', () => {
  ctxRef = { mode: 'task', activeAdapter: 'kiro' };
  const r = decide({ sourceAdapter: 'Kiro', text: 'ok' });
  assert.strictEqual(r.visible, true);
  assert.strictEqual(r.channel, 'L0');
  assert.strictEqual(r.output, '[friendly]ok');
});

test('任务模式活跃适配器但命中纯噪音：DROP 且 output 为 null', () => {
  ctxRef = { mode: 'task', activeAdapter: 'kiro' };
  const r = decide({ sourceAdapter: 'kiro', text: 'DEBUG' });
  assert.strictEqual(r.visible, false);
  assert.strictEqual(r.channel, 'DROP');
  assert.strictEqual(r.output, null);
  assert.strictEqual(r.raw, 'DEBUG');
});

test('任务模式来源!=活跃适配器：不可见下沉 L1', () => {
  ctxRef = { mode: 'task', activeAdapter: 'claude' };
  const r = decide({ sourceAdapter: 'kiro', text: 'hi' });
  assert.strictEqual(r.visible, false);
  assert.strictEqual(r.channel, 'L1');
  assert.strictEqual(r.output, '[status]hi');
});

test('任务模式来源未知(null)：非活跃路径下沉 L1', () => {
  ctxRef = { mode: 'task', activeAdapter: 'kiro' };
  const r = decide({ sourceAdapter: null, text: 'hi' });
  assert.strictEqual(r.channel, 'L1');
  assert.strictEqual(r.visible, false);
});

test('_text 抽取 Error.message 作为 raw', () => {
  ctxRef = null;
  const r = decide({ text: new Error('kaboom') });
  assert.strictEqual(r.raw, 'kaboom');
  assert.strictEqual(r.output, '[status]kaboom');
});

test('无 entry 参数：空文本仍判 L1 且 raw 为空串', () => {
  ctxRef = null;
  const r = decide();
  assert.strictEqual(r.channel, 'L1');
  assert.strictEqual(r.raw, '');
  assert.strictEqual(r.output, '[status]');
});

test('KNOWN-DEFECT: entry.level 被读入却从不外传，结果恒带 level:undefined', () => {
  // Input level:'error' -> measured: result.level === undefined (key present, always undefined).
  ctxRef = { mode: 'task', activeAdapter: 'kiro' };
  const r = decide({ sourceAdapter: 'kiro', text: 'ok', level: 'error' });
  assert.ok(Object.prototype.hasOwnProperty.call(r, 'level'));
  assert.strictEqual(r.level, undefined);
});
