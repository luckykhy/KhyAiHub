'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createEventLog } = require('./eventLog');
const { createEventBus } = require('./eventBus');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'khy-core-events-'));
}

test('append 归一化形状：ts/seq/type/source/traceId/payload', () => {
  const log = createEventLog({ bus: createEventBus() });
  const entry = log.append({ type: 'task.created', source: 'taskBoard', traceId: 't1', payload: { a: 1 } });
  assert.strictEqual(entry.type, 'task.created');
  assert.strictEqual(entry.source, 'taskBoard');
  assert.strictEqual(entry.traceId, 't1');
  assert.deepStrictEqual(entry.payload, { a: 1 });
  assert.strictEqual(typeof entry.seq, 'number');
  assert.strictEqual(typeof entry.ts, 'string');
});

test('表外类型归一为 unknown（fail-soft，不抛）', () => {
  const log = createEventLog({ bus: createEventBus() });
  assert.strictEqual(log.append({ type: 'totally.made.up' }).type, 'unknown');
  assert.strictEqual(log.append({}).type, 'unknown');
  assert.strictEqual(log.append({ type: 'usage.record' }).type, 'usage.record');
  assert.strictEqual(log.append({ type: 'agent.step' }).type, 'agent.step');
});

test('落盘 + 读回 + replay 回调按 (ts,seq) 有序', () => {
  const dir = tempHome();
  const log = createEventLog({ bus: createEventBus(), getEventsDir: () => dir });
  log.append({ type: 'task.created', source: 'a', ts: 1000 });
  log.append({ type: 'task.finished', source: 'a', ts: 500 });
  const events = log.read({});
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].ts <= events[1].ts, true, '应按时间升序');
  const seen = [];
  const replayed = log.replay({ type: 'task.finished' }, (e) => seen.push(e));
  assert.strictEqual(replayed.length, 1);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(log.getEventsDir(), dir);
});

test('snapshot 落一条 type=snapshot、traceId 默认取 taskId', () => {
  const dir = tempHome();
  const log = createEventLog({ bus: createEventBus(), getEventsDir: () => dir });
  const entry = log.snapshot('task-9', { step: 3 });
  assert.strictEqual(entry.type, 'snapshot');
  assert.strictEqual(entry.traceId, 'task-9');
  assert.deepStrictEqual(entry.payload, { taskId: 'task-9', state: { step: 3 } });
});

test('无宿主注入也无 env：只 fan-out 不落盘，且不静默', () => {
  const dir = tempHome();
  const bus = createEventBus();
  const log = createEventLog({ bus });
  const seen = [];
  log.subscribeAll((e) => seen.push(e));
  delete process.env.KHY_EVENTLOG_DIR;
  const entry = log.append({ type: 'usage.record' });
  assert.strictEqual(seen.length, 1, '总线 fan-out 不依赖落盘');
  assert.strictEqual(entry.type, 'usage.record');
  // 目录未下发：getEventsDir 返回 null，读回为空而不是抛
  assert.strictEqual(log.getEventsDir(), null);
  assert.deepStrictEqual(log.read({}), []);
  void dir;
});

test('KHY_EVENTLOG_DIR 优先于宿主注入（与迁入前 backend 版同序）', () => {
  const injected = tempHome();
  const override = tempHome();
  process.env.KHY_EVENTLOG_DIR = override;
  try {
    const log = createEventLog({ bus: createEventBus(), getEventsDir: () => injected });
    log.append({ type: 'usage.record' });
    assert.strictEqual(log.getEventsDir(), override, 'env 显式覆盖应赢过宿主下发');
    assert.strictEqual(fs.readdirSync(override).length, 1);
    assert.strictEqual(fs.readdirSync(injected).length, 0, '宿主目录不应被写入');
  } finally {
    delete process.env.KHY_EVENTLOG_DIR;
  }
});

test('KHY_EVENTLOG_ENABLED=false 时只 fan-out 不落盘', () => {
  const dir = tempHome();
  const bus = createEventBus();
  const log = createEventLog({ bus, getEventsDir: () => dir });
  const seen = [];
  log.subscribeAll((e) => seen.push(e));
  process.env.KHY_EVENTLOG_ENABLED = 'false';
  try {
    log.append({ type: 'usage.record' });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(fs.readdirSync(dir).length, 0, '禁用了磁盘写入就不该有文件');
  } finally {
    delete process.env.KHY_EVENTLOG_ENABLED;
  }
});

test('trace 分片模式：KHY_EVENTLOG_SHARD=trace 写 trace-<id>.jsonl', () => {
  const dir = tempHome();
  const log = createEventLog({ bus: createEventBus(), getEventsDir: () => dir });
  process.env.KHY_EVENTLOG_SHARD = 'trace';
  try {
    log.append({ type: 'agent.step', traceId: 'trace-77' });
    const files = fs.readdirSync(dir);
    assert.ok(files.some((f) => f.startsWith('trace-trace-77')), `应有 trace 分片，实得 ${files.join(',')}`);
  } finally {
    delete process.env.KHY_EVENTLOG_SHARD;
  }
});

test('两个实例的 seq 互不干扰（每实例单调）', () => {
  const dirA = tempHome();
  const dirB = tempHome();
  const a = createEventLog({ bus: createEventBus(), getEventsDir: () => dirA });
  const b = createEventLog({ bus: createEventBus(), getEventsDir: () => dirB });
  assert.strictEqual(a.append({ type: 'usage.record' }).seq, 1);
  assert.strictEqual(b.append({ type: 'usage.record' }).seq, 1);
  assert.strictEqual(a.append({ type: 'usage.record' }).seq, 2);
});
