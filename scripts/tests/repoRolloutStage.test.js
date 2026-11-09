'use strict';

/**
 * repoRolloutStage.test.js — 真实仓库新机制落地阶段守卫（PROCESS-008）
 *
 *   node --test scripts/tests/repoRolloutStage.test.js
 *
 * 与守卫自带反例自测的分工：反例自测验证判定逻辑；本测试把守卫对准真实的
 * docs/10_规范/registry/FEATURE-OWNERSHIP.json，钉死：所有已登记拦截型机制的阶段声明
 * 满足六条红线（尤其 PP-2「毕业看样本量」），check-rollout-stage 0 error。
 *
 * 2026-11-05 增补：PP-1/PP-2 的样本量输入不再只信自填。带 `samples.source` 的机制
 * 由守卫真跑执行器复算，阈值按实测值判；未声明或读不到的报 declared-only /
 * unverified，到毕业档（S2+）升 ERROR。本文件锁三件事：复算状态机、路径校验
 * （不许借道仓外）、以及真实登记表上试点机制确实接了 source。
 *
 * ⚠ 本文件**不 spawn 完整档守卫**：复算要真跑 check-repo-layout（本仓实测 40–150 秒，
 * 随机器负载浮动），放进来会让验收命令的成败取决于机器快慢。`--changed` 档按设计
 * 不跑复算（与 check-delivery-baseline 的 D1 同一取舍），所以这里跑的是快档 +
 * 注入假探针的纯函数用例 —— 断言的是判定逻辑，不是本机耗时。
 *
 * HOW-TO-EXTEND：机制升阶前先在登记表 samples.observed 攒够上一阶毕业阈值
 * （S1→S2 需 ≥200），或按 PP-4 回退登记表 stage。新增可复算来源时给 samples 加
 * `source: {script, args, key}`，script 必须是 scripts/ 下的仓内执行器。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const GUARD = path.join(ROOT, 'scripts', 'ci', 'check-rollout-stage.js');
const OWNERSHIP = path.join(ROOT, 'docs', '10_规范', 'registry', 'FEATURE-OWNERSHIP.json');
const G = require(GUARD);

/** 快档（--changed）：不跑样本复算，秒级返回，用于断言登记表整体零 error。 */
function runGuardChanged() {
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, [GUARD, '--changed'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
    });
  } catch (err) {
    stdout = `${err.stdout || ''}${err.stderr || ''}`;
    status = err.status;
  }
  return { stdout, status };
}

const SRC = {
  script: 'scripts/ci/check-repo-layout.js',
  args: ['--json'],
  key: 'counts.functional-unit',
};

test('registered rollout stages satisfy all six red lines (0 errors)', () => {
  const { stdout, status } = runGuardChanged();
  const errorLines = stdout.split('\n').filter((l) => l.startsWith('[ERROR]'));
  assert.equal(errorLines.length, 0, `rollout-stage errors:\n${errorLines.join('\n')}`);
  assert.equal(status, 0, `guard exited nonzero:\n${stdout}`);
});

test('--changed 档不跑样本复算（全仓读数不进快档），因此不产出样本类 finding', () => {
  const { stdout } = runGuardChanged();
  assert.doesNotMatch(stdout, /rollout-stage-samples-(unverified|declared-only)/, stdout);
});

test('真实登记表：试点机制的 samples.source 可寻址（script 存在、key 指向 counts）', () => {
  const own = JSON.parse(fs.readFileSync(OWNERSHIP, 'utf8'));
  const byId = new Map((own.rollout.mechanisms || []).map((m) => [m.id, m]));
  for (const id of ['domain-direction-guard', 'functional-unit-guard', 'entry-buffer-guard']) {
    const m = byId.get(id) || {};
    const src = m.samples && m.samples.source;
    assert.ok(src, `${id} 应声明 samples.source（否则毕业数只能自证）`);
    assert.ok(fs.existsSync(path.join(ROOT, src.script)), `${id} 的复算执行器应存在：${src.script}`);
    assert.match(src.key, /^counts\./, `${id} 的 key 应指向机器可读 counts`);
    assert.equal(G.normalizeSamplesSource(src).ok, true, `${id} 的 source 需通过规范化校验`);
  }
});

test('复算一致：不报 finding，PP 用的是实测值', () => {
  const state = G.evaluateSamples(
    { id: 'x', stage: 'S1', samples: { observed: 5, source: SRC } },
    () => ({ ok: true, data: { counts: { 'functional-unit': 5 } } })
  );
  assert.equal(state.finding, null);
  assert.equal(state.verified, true);
  assert.equal(state.value, 5);
});

test('复算不一致：PP 用实测值而不是自填值（自填 999 不得越过阈值）', () => {
  const state = G.evaluateSamples(
    { id: 'x', stage: 'S2', samples: { observed: 999, source: SRC } },
    () => ({ ok: true, data: { counts: { 'functional-unit': 7 } } })
  );
  assert.equal(state.finding.id, 'rollout-stage-samples-unverified');
  assert.equal(state.finding.severity, 'warning', '实测值可信，快照陈旧只是提醒');
  assert.equal(state.verified, true);
  assert.equal(state.value, 7, 'PP-2 的输入必须是实测 7，不是自填 999');
  assert.match(state.finding.message, /observed=999/);
  assert.match(state.finding.message, /实测 7/);
});

test('未声明 source：S1 是 WARN（观察期），S2 毕业档升 ERROR', () => {
  const s1 = G.evaluateSamples({ id: 'x', stage: 'S1', samples: { observed: 0, target: 200 } });
  assert.equal(s1.finding.id, 'rollout-stage-samples-declared-only');
  assert.equal(s1.finding.severity, 'warning');

  const s2 = G.evaluateSamples({ id: 'x', stage: 'S2', samples: { observed: 999, target: 200 } });
  assert.equal(s2.finding.id, 'rollout-stage-samples-declared-only');
  assert.equal(s2.finding.severity, 'error', '毕业档不得以自填数字越过阈值');
});

test('取不到数 / key 不存在 / 非数字：unverified，退回 observed 且标注未核实；S2 升 ERROR', () => {
  for (const fake of [
    () => ({ ok: false, reason: '输出不是 JSON（退出码 1）' }),
    () => ({ ok: true, data: { counts: {} } }),
    () => ({ ok: true, data: { counts: { 'functional-unit': 'many' } } }),
  ]) {
    const state = G.evaluateSamples(
      { id: 'x', stage: 'S1', samples: { observed: 5, source: SRC } },
      fake
    );
    assert.equal(state.finding.id, 'rollout-stage-samples-unverified', state.finding.message);
    assert.equal(state.finding.severity, 'warning');
    assert.equal(state.verified, false);
    assert.equal(state.value, 5, '读不到数时只能退回 observed，并已报未核实');
  }
  const atGraduation = G.evaluateSamples(
    { id: 'x', stage: 'S3', samples: { observed: 999, source: SRC } },
    () => ({ ok: false, reason: '探针超时' })
  );
  assert.equal(atGraduation.finding.severity, 'error');
});

test('samples.source 只允许 scripts/ 下的仓内相对路径（拒绝绝对路径与 ..）', () => {
  const bad = [
    { script: 'C:/Windows/System32/cmd.exe', key: 'a' },
    { script: '/etc/passwd', key: 'a' },
    { script: 'scripts/../../secrets.js', key: 'a' },
    { script: 'runtime/node/backend/bin/khy.js', key: 'a' },
  ];
  for (const src of bad) {
    assert.equal(G.normalizeSamplesSource(src).ok, false, `${JSON.stringify(src)} 不应被接受`);
  }
  assert.equal(G.normalizeSamplesSource(SRC).ok, true);
});

test('pickKey 支持带连字符的键名与点路径；对象/缺失都不是标量读数', () => {
  const data = { counts: { 'entry-buffer': 2401, nested: { x: 1 } }, top: 3 };
  assert.deepEqual(G.pickKey(data, 'counts.entry-buffer'), { ok: true, value: 2401 });
  assert.deepEqual(G.pickKey(data, 'top'), { ok: true, value: 3 });
  assert.equal(G.pickKey(data, 'counts.missing').ok, false);
  assert.equal(G.pickKey(data, 'counts.nested').ok, false);
});
