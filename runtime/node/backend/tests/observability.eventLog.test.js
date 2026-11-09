'use strict';

/**
 * eventLog 事件类型契约测试（A5 前端埋点接入的后半段）。
 *
 * 钉住两件事:① user.behavior.* 与既有族(agent.* / perf.* / usage.record /
 * snapshot / task.*)原样落库;② 表外类型归一为 'unknown' 且绝不抛——
 * eventLog 的契约是 fail-soft,类型拼写错误不该把生产者带下水。
 *
 * 落盘重定向靠 KHY_EVENTLOG_DIR:_eventsDir() 在每次调用时读环境变量,
 * 所以 beforeEach 改它即可把 JSONL 写进临时目录,不碰真实数据。
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const eventLog = require('../src/observability/eventLog');

describe('eventLog 类型契约 — user.behavior.* 入列', () => {
  const originalDir = process.env.KHY_EVENTLOG_DIR;
  const originalEnabled = process.env.KHY_EVENTLOG_ENABLED;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-eventlog-'));
    process.env.KHY_EVENTLOG_DIR = tmpDir;
    delete process.env.KHY_EVENTLOG_ENABLED;
  });

  afterEach(() => {
    if (originalDir === undefined) {
      delete process.env.KHY_EVENTLOG_DIR;
    } else {
      process.env.KHY_EVENTLOG_DIR = originalDir;
    }
    if (originalEnabled === undefined) {
      delete process.env.KHY_EVENTLOG_ENABLED;
    } else {
      process.env.KHY_EVENTLOG_ENABLED = originalEnabled;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function readAll() {
    return eventLog.read();
  }

  it('user.behavior.* 五种显性 kind 与三种隐性 kind 原样落库', () => {
    const kinds = [
      'user.behavior.click',
      'user.behavior.like',
      'user.behavior.dislike',
      'user.behavior.correct',
      'user.behavior.reject',
      'user.behavior.dwell',
      'user.behavior.scroll',
      'user.behavior.input',
    ];
    for (const type of kinds) {
      eventLog.append({ type, source: 'web:ai-chat', traceId: 'conv-1', payload: { k: type } });
    }
    const types = readAll().map((e) => e.type);
    for (const type of kinds) {
      assert.ok(types.includes(type), `expected ${type} in ${JSON.stringify(types)}`);
    }
  });

  it('落库条目保持 {ts,seq,type,source,traceId,payload} 六字段形状', () => {
    const entry = eventLog.append({
      type: 'user.behavior.click',
      source: 'web:prompt-library',
      traceId: 'p-7',
      payload: { action: 'use' },
    });
    assert.deepStrictEqual(Object.keys(entry).sort(), [
      'payload',
      'seq',
      'source',
      'traceId',
      'ts',
      'type',
    ]);
    assert.equal(entry.type, 'user.behavior.click');
    assert.equal(entry.source, 'web:prompt-library');
    assert.equal(entry.traceId, 'p-7');
    assert.deepStrictEqual(entry.payload, { action: 'use' });
    const persisted = readAll().filter((e) => e.traceId === 'p-7');
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].type, 'user.behavior.click');
  });

  it('既有族不受影响:agent.* / perf.* / usage.record / snapshot / task.* 原样通过', () => {
    const legacy = [
      'agent.step',
      'perf.slow_request',
      'usage.record',
      'snapshot',
      'task.created',
    ];
    for (const type of legacy) {
      eventLog.append({ type, source: 'test' });
    }
    const types = readAll().map((e) => e.type);
    for (const type of legacy) {
      assert.ok(types.includes(type), `expected ${type} in ${JSON.stringify(types)}`);
    }
  });

  it('表外类型归一为 unknown,不抛也不落长尾', () => {
    for (const type of ['user.profile.sync', 'behavior.click', 'bogus', '', 'user.behavior.']) {
      const entry = eventLog.append({ type, source: 'test' });
      assert.equal(entry.type, 'unknown', `expected '${type}' to normalize to 'unknown'`);
    }
    const types = readAll().map((e) => e.type);
    assert.equal(types.filter((t) => t === 'unknown').length, 5);
    assert.equal(types.filter((t) => t !== 'unknown').length, 0);
  });

  it('append 对垃圾输入 fail-soft:不抛,仍返回归一化条目', () => {
    assert.doesNotThrow(() => eventLog.append(null));
    assert.doesNotThrow(() => eventLog.append({ type: 42 }));
    assert.doesNotThrow(() => eventLog.append({ type: 'user.behavior.click', payload: undefined }));
    const entry = eventLog.append({ type: 42, source: 'test' });
    assert.equal(entry.type, 'unknown');
    assert.deepStrictEqual(entry.payload, {});
  });

  it('read({type}) 能按 user.behavior.* 过滤', () => {
    eventLog.append({ type: 'user.behavior.dwell', source: 'test', traceId: 'c1' });
    eventLog.append({ type: 'user.behavior.scroll', source: 'test', traceId: 'c2' });
    eventLog.append({ type: 'task.created', source: 'test', traceId: 'c3' });
    const hits = eventLog.read({ type: 'user.behavior.dwell' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].traceId, 'c1');
  });

  it('ts 归一:数字纪元转 ISO 串,字符串原样保留', () => {
    const epoch = 1760000000000;
    const fromNumber = eventLog.append({ type: 'user.behavior.click', ts: epoch });
    assert.equal(fromNumber.ts, new Date(epoch).toISOString());
    const iso = '2026-11-05T00:00:00.000Z';
    const fromString = eventLog.append({ type: 'user.behavior.click', ts: iso });
    assert.equal(fromString.ts, iso);
  });

  it('KHY_EVENTLOG_ENABLED=0 时仍扇出到 eventBus 但不落盘', () => {
    process.env.KHY_EVENTLOG_ENABLED = '0';
    let seen = null;
    const unsubscribe = eventLog.subscribeAll((e) => {
      seen = e;
    });
    try {
      const entry = eventLog.append({ type: 'user.behavior.like', source: 'test' });
      assert.equal(entry.type, 'user.behavior.like');
      assert.ok(seen, 'bus fan-out must happen even with disk writes disabled');
      assert.equal(seen.type, 'user.behavior.like');
      const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.jsonl'));
      assert.equal(files.length, 0, 'no JSONL shard may be written when disabled');
    } finally {
      unsubscribe();
    }
  });

  it('seq 单调递增(同毫秒碰撞时保持稳定序)', () => {
    const a = eventLog.append({ type: 'user.behavior.click' });
    const b = eventLog.append({ type: 'user.behavior.click' });
    assert.ok(b.seq > a.seq);
  });
});
