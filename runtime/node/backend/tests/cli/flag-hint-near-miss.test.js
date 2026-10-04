'use strict';
// 契约(轮二十):打错的旗标必须得到 stderr 近形提示;合法/远形旗标必须零提示;
// 提示永不改变 stdout/行为;KHY_FLAG_HINT=off 全静默。
// 单元层直调 flagHint(快),端到端一条 spawn 证明 route() 真的接了线。
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const { hintUnknownFlags, _distanceCapped } = require(path.join(BE, 'src/cli/flagHint'));

function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try { fn(); } finally { process.stderr.write = orig; }
  return lines.join('');
}

test('距离函数标定:jsonn→json=1, maxtoken→max-tokens=2, 远形截断', () => {
  assert.equal(_distanceCapped('jsonn', 'json', 2), 1);
  assert.equal(_distanceCapped('maxtoken', 'max-tokens', 2), 2);
  assert.ok(_distanceCapped('zzzzqqqq', 'json', 2) > 2);
});

test('health --jsonn:近形 → 一行 stderr 提示,含原名/命令/候选', () => {
  const err = captureStderr(() => hintUnknownFlags('health', { jsonn: true }));
  assert.match(err, /--jsonn/);
  assert.match(err, /khy health/);
  assert.match(err, /是否想用 --json/);
  assert.equal(err.split('\n').filter(Boolean).length, 1, '只出一条');
});

test('对照:合法旗标与远形旗标零提示', () => {
  assert.equal(captureStderr(() => hintUnknownFlags('health', { json: true })), '');
  assert.equal(captureStderr(() => hintUnknownFlags('health', { zzzzqqqq: true })), '');
  assert.equal(captureStderr(() => hintUnknownFlags('health', { verbose: true })), '');
});

test('大小写变体 --JSON 是真会被丢弃的旗标 → 必须提示', () => {
  const err = captureStderr(() => hintUnknownFlags('health', { JSON: true }));
  assert.match(err, /是否想用 --json/);
});

test('kill switch:KHY_FLAG_HINT=off|0 → 全静默', () => {
  for (const v of ['off', '0']) {
    process.env.KHY_FLAG_HINT = v;
    try {
      assert.equal(captureStderr(() => hintUnknownFlags('health', { jsonn: true })), '');
    } finally {
      delete process.env.KHY_FLAG_HINT;
    }
  }
});

test('坏输入不抛:command/options 缺失或畸形一律静默安全', () => {
  assert.doesNotThrow(() => hintUnknownFlags(null, null));
  assert.doesNotThrow(() => hintUnknownFlags('health', undefined));
  assert.doesNotThrow(() => hintUnknownFlags('nosuchcmd__', { jsonn: true }));
});

test('端到端:真 CLI `health --jsonn` stderr 带提示、stdout 与无提示前一致、rc=0', () => {
  const KHY = path.join(BE, 'bin/khy.js');
  const r = spawnSync(process.execPath, [KHY, 'health', '--jsonn'], {
    cwd: BE, encoding: 'utf8', timeout: 60000,
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /旗标 --jsonn/);
  assert.ok(r.stdout.includes('健康体检'), 'stdout 行为不变(仍走无旗标分支)');
  assert.doesNotMatch(r.stdout, /jsonn/, '提示不得混入 stdout');
});
