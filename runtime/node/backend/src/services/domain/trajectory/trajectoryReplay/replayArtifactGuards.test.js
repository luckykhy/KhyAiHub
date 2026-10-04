'use strict';

/**
 * replayArtifactGuards.test.js — 钉死回放前置守卫与后置校验矩阵（防呆⑥/③）：
 * create/modify/delete 三种 op 在「目标存在与否 × 哈希相符与否」下的 proceed/satisfied/halt 决策，
 * 以及校验层对 delete「必须不存在」的断言。
 *
 * 实测更正：本守卫声称 pure leaf over a step object，但 _preconditionCheck(null) 会抛
 * TypeError（无 try/catch 兜底，replayArtifactGuards.js:19-20）——与 artifactHash 的 fail-soft
 * 不同层级，此处如实钉「null 入参即抛」。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mod = require('./replayArtifactGuards');
const artifactHash = require('./artifactHash');

const HELLO_SHA = artifactHash.hashString('hello');

function withFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-guards-'));
  try {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'hello');
    return fn(dir, file, path.join(dir, 'gone.txt')); // gone 恒不存在
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('导出恰为 _preconditionCheck 与 _verifyArtifacts 两个下划线符号', () => {
  assert.deepStrictEqual(Object.keys(mod), ['_preconditionCheck', '_verifyArtifacts']);
});

test('_preconditionCheck 对空 step/非数组 artifacts/无 path 条目一律 proceed', () => {
  assert.deepStrictEqual(mod._preconditionCheck({}), { decision: 'proceed' });
  assert.deepStrictEqual(mod._preconditionCheck({ artifacts: 'x' }), { decision: 'proceed' });
  assert.deepStrictEqual(mod._preconditionCheck({ artifacts: [null, {}, { path: '' }] }), { decision: 'proceed' });
});

test('_preconditionCheck 对 null 入参抛 TypeError（实测非 total，如实钉住）', () => {
  assert.throws(() => mod._preconditionCheck(null), TypeError);
});

test('modify 且当前内容已等于录制终态 sha：判 satisfied 产物已是目标状态', () => {
  withFixture((dir, file) => {
    const r = mod._preconditionCheck({ artifacts: [{ path: file, op: 'modify', sha256: HELLO_SHA }] });
    assert.deepStrictEqual(r, { decision: 'satisfied', reason: '产物已是目标状态' });
  });
});

test('modify 且 beforeHash 与当前实际不符：判 halt 前置状态分歧并带 expected/actual', () => {
  withFixture((dir, file) => {
    const r = mod._preconditionCheck({
      artifacts: [{ path: file, op: 'modify', sha256: 'deadbeef' }],
      writeDiff: { beforeHash: 'aaaa' },
    });
    assert.strictEqual(r.decision, 'halt');
    assert.match(r.reason, /^前置状态分歧/);
    assert.deepStrictEqual(r.detail, { path: file, expected: 'aaaa', actual: HELLO_SHA });
  });
});

test('modify 且 beforeHash 恰等于当前内容：判 proceed（正常覆盖通道）', () => {
  withFixture((dir, file) => {
    const r = mod._preconditionCheck({
      artifacts: [{ path: file, op: 'modify', sha256: 'whatever' }],
      writeDiff: { beforeHash: HELLO_SHA },
    });
    assert.deepStrictEqual(r, { decision: 'proceed' });
  });
});

test('delete 目标不存在：satisfied 目标已不存在', () => {
  withFixture((dir, file, gone) => {
    const r = mod._preconditionCheck({ artifacts: [{ path: gone, op: 'delete' }] });
    assert.deepStrictEqual(r, { decision: 'satisfied', reason: '目标已不存在' });
  });
});

test('delete 目标仍存在且 beforeHash 不符：halt 防误删未录制数据', () => {
  withFixture((dir, file) => {
    const r = mod._preconditionCheck({
      artifacts: [{ path: file, op: 'delete' }],
      writeDiff: { beforeHash: 'aaa' },
    });
    assert.strictEqual(r.decision, 'halt');
    assert.strictEqual(r.detail.expected, 'aaa');
    assert.strictEqual(r.detail.actual, HELLO_SHA);
  });
});

test('delete 目标存在但无 beforeHash（录制时视为新建）：proceed（null 前置不设防不误判）', () => {
  withFixture((dir, file) => {
    const r = mod._preconditionCheck({
      artifacts: [{ path: file, op: 'delete' }],
      writeDiff: { beforeHash: HELLO_SHA },
    });
    assert.deepStrictEqual(r, { decision: 'proceed' });
    const r2 = mod._preconditionCheck({ artifacts: [{ path: file, op: 'delete' }] });
    assert.deepStrictEqual(r2, { decision: 'proceed' });
  });
});

test('create 目标不存在：proceed', () => {
  withFixture((dir, file, gone) => {
    const r = mod._preconditionCheck({ artifacts: [{ path: gone, op: 'create', sha256: HELLO_SHA }] });
    assert.deepStrictEqual(r, { decision: 'proceed' });
  });
});

test('create 目标已存在且内容相同：satisfied；内容不同：halt 将创建目标已存在', () => {
  withFixture((dir, file) => {
    const same = mod._preconditionCheck({ artifacts: [{ path: file, op: 'create', sha256: HELLO_SHA }] });
    assert.deepStrictEqual(same, { decision: 'satisfied', reason: '产物已是目标状态' });
    const diff = mod._preconditionCheck({ artifacts: [{ path: file, op: 'create', sha256: 'other' }] });
    assert.strictEqual(diff.decision, 'halt');
    assert.match(diff.reason, /将创建的目标已存在且内容不同/);
    assert.strictEqual(diff.detail.expected, null);
    assert.strictEqual(diff.detail.actual, HELLO_SHA);
  });
});

test('create 目标已存在但录制带了 beforeHash（非新建语义）：第二道 halt 不触发，proceed（实测边界）', () => {
  withFixture((dir, file) => {
    const r = mod._preconditionCheck({
      artifacts: [{ path: file, op: 'create', sha256: 'other' }],
      writeDiff: { beforeHash: 'aaa' },
    });
    assert.deepStrictEqual(r, { decision: 'proceed' });
  });
});

test('未知 op（既非三档）不做分歧拦截：proceed（保守放行由执行层兜底）', () => {
  withFixture((dir, file) => {
    const r = mod._preconditionCheck({ artifacts: [{ path: file, op: 'weird', sha256: 'other' }] });
    assert.deepStrictEqual(r, { decision: 'proceed' });
  });
});

test('多产物中任一 halt 即整体 halt（首个问题项胜出）', () => {
  withFixture((dir, file, gone) => {
    const r = mod._preconditionCheck({
      artifacts: [
        { path: gone, op: 'create', sha256: HELLO_SHA },
        { path: file, op: 'modify', sha256: 'x' },
      ],
      writeDiff: { beforeHash: 'aa' },
    });
    assert.strictEqual(r.decision, 'halt');
    assert.strictEqual(r.detail.path, file);
  });
});

test('_verifyArtifacts 对空/非数组/无 path/无 sha 条目全部视为通过', () => {
  assert.deepStrictEqual(mod._verifyArtifacts({}), { ok: true });
  assert.deepStrictEqual(mod._verifyArtifacts({ artifacts: 5 }), { ok: true });
  assert.deepStrictEqual(mod._verifyArtifacts({ artifacts: [null, { path: '' }] }), { ok: true });
  withFixture((dir, file) => {
    assert.deepStrictEqual(mod._verifyArtifacts({ artifacts: [{ path: file, op: 'modify' }] }), { ok: true });
  });
});

test('_verifyArtifacts 哈希相符判 ok，不符报 expected/actual 双值', () => {
  withFixture((dir, file) => {
    assert.deepStrictEqual(
      mod._verifyArtifacts({ artifacts: [{ path: file, op: 'modify', sha256: HELLO_SHA }] }),
      { ok: true },
    );
    const r = mod._verifyArtifacts({ artifacts: [{ path: file, op: 'modify', sha256: 'bogus' }] });
    assert.deepStrictEqual(r, { ok: false, detail: { path: file, expected: 'bogus', actual: HELLO_SHA } });
  });
});

test('_verifyArtifacts 对 delete：文件仍在判不 ok 且以 (deleted)/(exists) 呈现', () => {
  withFixture((dir, file) => {
    const r = mod._verifyArtifacts({ artifacts: [{ path: file, op: 'delete' }] });
    assert.deepStrictEqual(r, {
      ok: false,
      detail: { path: file, expected: '(deleted)', actual: '(exists)' },
    });
  });
});

test('_verifyArtifacts 对 delete：文件已消失判 ok', () => {
  withFixture((dir, file, gone) => {
    assert.deepStrictEqual(mod._verifyArtifacts({ artifacts: [{ path: gone, op: 'delete' }] }), { ok: true });
  });
});

test('_verifyArtifacts 目标文件不存在且 op 非 delete：actual 为 null 判不 ok', () => {
  withFixture((dir, file, gone) => {
    const r = mod._verifyArtifacts({ artifacts: [{ path: gone, op: 'modify', sha256: HELLO_SHA }] });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.detail.actual, null);
  });
});
