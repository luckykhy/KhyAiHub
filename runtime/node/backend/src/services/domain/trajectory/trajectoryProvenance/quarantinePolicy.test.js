'use strict';

/**
 * quarantinePolicy.test.js — 中转工具调用隔离策略（DESIGN-ARCH-047 PHASE 3，安全核心）的本目录单测。
 *
 * 这份套件把「执行侧 fail-CLOSED」钉成可执行判据：五档判决表逐条同时断言 action **与 trust**
 * （trust 是安全叙事的一半 —— 逃生口放行时必须仍是 CLAIMED，绝不升级成 VERIFIED）、
 * 判决分支的优先级顺序、env 关闭词表的精确边界，以及本模块的设计法：
 *   标签侧（khyTrace.isRelayed）缺信息时偏向「我方」，执行侧（decide）缺信息时偏向「隔离」。
 * 两者对同一个未知 producer 给出**相反**的结论，这是刻意的，必须用一支测试同时调两边。
 *
 * 纯决策函数，零 IO；唯一的环境交互是 isGateEnabled()/decide() 缺省读 process.env，
 * 那一次用 save/restore 包住，不留全局副作用（不写仓库、不建目录）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const policy = require('./quarantinePolicy');
const khyTrace = require('./khyTrace');

const { GATE_ENV, ACTION, isGateEnabled, decide, assertNoAutoDangerous } = policy;
const { TRUST, PRODUCER } = khyTrace;

/** 临时改一个 env 变量并在 finally 逐字节还原（原本没有就删掉）。 */
function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    if (had) {
      process.env[name] = prev;
    } else {
      delete process.env[name];
    }
  }
}

// ───────────────────────────────── 导出面与常量 ─────────────────────────────────

test('导出面恰为 5 个符号；GATE_ENV 字面值与 ACTION 三键冻结', () => {
  assert.deepStrictEqual(Object.keys(policy).sort(), [
    'ACTION',
    'GATE_ENV',
    'assertNoAutoDangerous',
    'decide',
    'isGateEnabled',
  ]);
  assert.strictEqual(GATE_ENV, 'KHY_TRAJECTORY_QUARANTINE');
  assert.deepStrictEqual(Object.keys(ACTION), ['ALLOW', 'GATE', 'QUARANTINE']);
  assert.deepStrictEqual({ ...ACTION }, { ALLOW: 'allow', GATE: 'gate', QUARANTINE: 'quarantine' });
  assert.ok(Object.isFrozen(ACTION), 'ACTION 必须 frozen：判决值是安全语义，不许运行期被改');
  // 对抗面：frozen 不是装饰 —— 严格模式下改写要立刻抛，而不是静默失败。
  assert.throws(() => {
    ACTION.QUARANTINE = 'allow';
  }, TypeError);
  assert.throws(() => {
    ACTION.AUTO_APPROVE = 'allow';
  }, TypeError);
  assert.strictEqual(ACTION.QUARANTINE, 'quarantine');
});

// ─────────────────────────────── isGateEnabled 词表 ───────────────────────────────

test('isGateEnabled 默认 ON：缺键/空串/null/undefined/空 env 对象都算开', () => {
  assert.equal(isGateEnabled({}), true);
  assert.equal(isGateEnabled({ [GATE_ENV]: '' }), true);
  assert.equal(isGateEnabled({ [GATE_ENV]: null }), true);
  assert.equal(isGateEnabled({ [GATE_ENV]: undefined }), true);
  assert.equal(isGateEnabled({ OTHER: '0' }), true, '别的 env 不得顺带关掉隔离闸');
});

test('isGateEnabled 关闭词表恰为 0/false/off/no，trim + 小写后命中', () => {
  for (const v of ['0', 'false', 'off', 'no']) {
    assert.equal(isGateEnabled({ [GATE_ENV]: v }), false, `${v} 应关闸`);
  }
  // 大小写与空白变体同样关闭。
  assert.equal(isGateEnabled({ [GATE_ENV]: ' OFF ' }), false);
  assert.equal(isGateEnabled({ [GATE_ENV]: 'OFF' }), false);
  assert.equal(isGateEnabled({ [GATE_ENV]: 'FALSE ' }), false);
  assert.equal(isGateEnabled({ [GATE_ENV]: 'no ' }), false);
});

test('isGateEnabled 不是「非零即开」也不是模糊匹配：近似词一律保持 ON', () => {
  // 误关的代价是隔离失效，所以词表必须严格相等 —— 这几个值都容易被人误当成「关」。
  for (const v of ['off2', 'nope', 'nope2', '0.0', 'falsey', 'none', '-1', ' 0x', 'OFF-OFF']) {
    assert.equal(isGateEnabled({ [GATE_ENV]: v }), true, `${v} 应保持 ON（不在关闭词表内）`);
  }
  // 对抗面：真正的关闭词仍然关。
  assert.equal(isGateEnabled({ [GATE_ENV]: 'off' }), false);
});

test('isGateEnabled 把非字符串值 String() 拉平后再判：0/false 数字量会关闸，1/true 保持 ON', () => {
  assert.equal(isGateEnabled({ [GATE_ENV]: 0 }), false); // String(0) === '0'
  assert.equal(isGateEnabled({ [GATE_ENV]: false }), false); // String(false) === 'false'
  assert.equal(isGateEnabled({ [GATE_ENV]: 1 }), true);
  assert.equal(isGateEnabled({ [GATE_ENV]: true }), true);
  assert.equal(isGateEnabled({ [GATE_ENV]: [ 'off' ] }), false); // 单元素数组 join 成 'off'
});

test('isGateEnabled() 不传参回落 process.env（一次，逐字节还原现场）', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, GATE_ENV);
  const prev = process.env[GATE_ENV];
  const base = isGateEnabled();
  try {
    process.env[GATE_ENV] = '0';
    assert.equal(isGateEnabled(), false);
    delete process.env[GATE_ENV];
    assert.equal(isGateEnabled(), true);
  } finally {
    if (had) {
      process.env[GATE_ENV] = prev;
    } else {
      delete process.env[GATE_ENV];
    }
  }
  assert.equal(isGateEnabled(), base, 'env 现场必须还原到进入本用例之前的读数');
});

// ─────────────────────────────── decide 判决表 ───────────────────────────────

test('decide：khy-local 无条件 allow/verified —— 交互性、批准、闸状态全都不参与', () => {
  const matrix = [
    {},
    { interactive: false, gateEnabled: true },
    { interactive: true, gateEnabled: true },
    { interactive: true, preApproved: true, gateEnabled: true },
    { gateEnabled: false },
    { preApproved: true, gateEnabled: false },
  ];
  for (const extra of matrix) {
    const d = decide({ producer: PRODUCER.KHY_LOCAL, riskLevel: 'high', ...extra });
    assert.deepStrictEqual(
      { action: d.action, trust: d.trust, reason: d.reason, riskLevel: d.riskLevel },
      { action: ACTION.ALLOW, trust: TRUST.VERIFIED, reason: 'local origin (khy-local)', riskLevel: 'high' },
      `本地 origin 在 ${JSON.stringify(extra)} 下必须走既有执行路径，零回归`
    );
  }
  // 对抗面：同一个信号集换一个中转 producer，判决立刻变隔离。
  const relayed = decide({ producer: PRODUCER.CODEX, interactive: false, gateEnabled: true, riskLevel: 'high' });
  assert.equal(relayed.action, ACTION.QUARANTINE);
});

test('decide：逃生口 gateEnabled:false → allow 但 trust 停在 CLAIMED（绝不升级成 VERIFIED）', () => {
  for (const producer of [PRODUCER.CODEX, PRODUCER.CLAUDE_CODE, PRODUCER.RELAY, 'relay:somebody']) {
    const d = decide({ producer, gateEnabled: false, interactive: false, riskLevel: 'medium' });
    assert.equal(d.action, ACTION.ALLOW, `${producer} 关闸后应放行（迁移用）`);
    assert.equal(d.trust, TRUST.CLAIMED, `${producer} 关闸放行仍必须标 claimed —— 真相标签不许被逃生口洗白`);
    assert.notEqual(d.trust, TRUST.VERIFIED);
    assert.strictEqual(d.reason, `quarantine gate disabled via ${GATE_ENV}`);
    assert.equal(d.riskLevel, 'medium');
  }
});

test('decide：闸开 + 已显式批准 → allow/VERIFIED（过了人工闸才算本地验证）', () => {
  const d = decide({ producer: PRODUCER.CODEX, gateEnabled: true, preApproved: true, riskLevel: 'high' });
  assert.equal(d.action, ACTION.ALLOW);
  assert.equal(d.trust, TRUST.VERIFIED);
  assert.strictEqual(d.reason, 'relayed call explicitly approved');
  assert.equal(d.riskLevel, 'high');
});

test('decide：闸开 + 交互式 → gate/CLAIMED（交人工审批，此处不自动放行）', () => {
  const d = decide({ producer: PRODUCER.CLAUDE_CODE, gateEnabled: true, interactive: true, riskLevel: 'low' });
  assert.equal(d.action, ACTION.GATE);
  assert.equal(d.trust, TRUST.CLAIMED);
  assert.strictEqual(d.reason, 'relayed call routed to approval gate');
  assert.equal(d.riskLevel, 'low');
  // 非布尔但 truthy 的 interactive 也走这条分支（真值判定，不是 === true）。
  assert.equal(decide({ producer: PRODUCER.CODEX, gateEnabled: true, interactive: 'yes' }).action, ACTION.GATE);
  // 对抗面：同一个交互式调用，去掉批准后判决就是隔离。
  assert.equal(decide({ producer: PRODUCER.CLAUDE_CODE, gateEnabled: true, interactive: false }).action, ACTION.QUARANTINE);
});

test('decide：闸开 + 非交互 + 无批准 → quarantine/QUARANTINED，理由点名 env 变量', () => {
  const d = decide({ producer: PRODUCER.CODEX, gateEnabled: true, interactive: false, preApproved: false, riskLevel: 'critical' });
  assert.equal(d.action, ACTION.QUARANTINE);
  assert.equal(d.trust, TRUST.QUARANTINED);
  assert.equal(d.riskLevel, 'critical');
  assert.ok(d.reason.includes(GATE_ENV), `理由必须告知用户如何自助：${d.reason}`);
  assert.strictEqual(d.reason, `quarantined: relayed call requires approval (set ${GATE_ENV}=0 to bypass)`);
  // 对照：判决不是「deny 后谎报已验证」。
  assert.notEqual(d.trust, TRUST.VERIFIED);
});

test('decide 分支优先级：preApproved 先于 interactive；关闸先于批准（关闸时批准也只给 CLAIMED）', () => {
  const both = decide({ producer: PRODUCER.CODEX, gateEnabled: true, interactive: true, preApproved: true });
  assert.equal(both.action, ACTION.ALLOW); // preApproved 命中在前，不再交人工
  assert.equal(both.trust, TRUST.VERIFIED);
  const gateOff = decide({ producer: PRODUCER.CODEX, gateEnabled: false, interactive: true, preApproved: true });
  assert.equal(gateOff.action, ACTION.ALLOW);
  assert.equal(gateOff.trust, TRUST.CLAIMED); // 关闸分支在前 → 不给 VERIFIED
  assert.ok(gateOff.reason.includes('disabled'));
  // 对抗面：三条都 False 且闸开 → 隔离。
  assert.equal(decide({ producer: PRODUCER.CODEX, gateEnabled: true }).action, ACTION.QUARANTINE);
});

test('decide：gateEnabled 显式值压过 env；null 被当成「未提供」而回落 env', () => {
  withEnv(GATE_ENV, '0', () => {
    // env 说关，但调用方显式 gateEnabled:true → 隔离闸照开（调用方覆盖优先）。
    assert.equal(decide({ producer: PRODUCER.CODEX, gateEnabled: true }).action, ACTION.QUARANTINE);
    // env 说关、gateEnabled 未给 → 走 env，放行。
    assert.equal(decide({ producer: PRODUCER.CODEX }).action, ACTION.ALLOW);
  });
  withEnv(GATE_ENV, '1', () => {
    // env 说开，显式 false 仍然能关（迁移通道双向可用）。
    assert.equal(decide({ producer: PRODUCER.CODEX, gateEnabled: false }).action, ACTION.ALLOW);
    // null 走的是 `!= null` 判定 → 等价于未提供 → 回落 env（开）→ 隔离。
    assert.equal(decide({ producer: PRODUCER.CODEX, gateEnabled: null }).action, ACTION.QUARANTINE);
    assert.equal(decide({ producer: PRODUCER.CODEX, gateEnabled: undefined }).action, ACTION.QUARANTINE);
  });
});

test('安全核心：执行侧 fail-CLOSED 与标签侧 fail-safe-to-ours 对同一个未知 producer 结论相反（刻意的两向偏置）', () => {
  // 设计法（quarantinePolicy.js 顶部注释 + _isRelayedForExec）：
  //   · 标签侧漏标只能偏「我方」—— producer 不在枚举里就不算中转（宁可少防，
  //     也不把 Khyos 自己的内容标成外部而误触发隔离与核对）；
  //   · 执行侧缺信息只能偏「隔离」—— 凡不是显式 'khy-local' 一律当中转（无人值守时
  //     绝不为一个来路不明的 producer 自动执行工具调用）。
  // 两个方向合起来才是完整姿态：未知来路的内容「按我方展示，按外部处置」。
  for (const producer of ['totally-unknown', undefined, null, '']) {
    const label = khyTrace.isRelayed(producer); // 标签侧：false（偏我方）
    const exec = decide({ producer, gateEnabled: true }); // 执行侧：隔离（偏隔离）
    assert.equal(label, false, `标签侧对 ${String(producer)} 必须判「非中转」`);
    assert.equal(exec.action, ACTION.QUARANTINE, `执行侧对 ${String(producer)} 必须 fail-CLOSED`);
    assert.equal(exec.trust, TRUST.QUARANTINED);
    // 标签侧也不是「裸放行」：producer 文本会被 normalizeProducer 坍缩成 relay:<raw>。
    const norm = khyTrace.normalizeProducer(producer || 'totally-unknown');
    assert.equal(norm.producer, PRODUCER.RELAY);
  }
  // 对照：已知外部 producer 两侧一致（标签 true、执行 quarantine）。
  assert.equal(khyTrace.isRelayed(PRODUCER.CODEX), true);
  assert.equal(decide({ producer: PRODUCER.CODEX, gateEnabled: true }).action, ACTION.QUARANTINE);
  // 对照：显式 khy-local 两侧都放行 —— 「未知」与「我方」在执行面判据上必须不同。
  assert.equal(decide({ producer: PRODUCER.KHY_LOCAL, gateEnabled: true }).action, ACTION.ALLOW);
});

test('decide：riskLevel 在五档判决里原样透传，缺省时键仍存在但值为 undefined', () => {
  const rows = [
    { s: { producer: PRODUCER.KHY_LOCAL }, a: ACTION.ALLOW },
    { s: { producer: PRODUCER.CODEX, gateEnabled: false }, a: ACTION.ALLOW },
    { s: { producer: PRODUCER.CODEX, gateEnabled: true, preApproved: true }, a: ACTION.ALLOW },
    { s: { producer: PRODUCER.CODEX, gateEnabled: true, interactive: true }, a: ACTION.GATE },
    { s: { producer: PRODUCER.CODEX, gateEnabled: true }, a: ACTION.QUARANTINE },
  ];
  for (const { s, a } of rows) {
    const d = decide({ ...s, riskLevel: 'high' });
    assert.equal(d.action, a);
    assert.equal(d.riskLevel, 'high', `${JSON.stringify(s)} 必须回传评级，供透明展示`);
  }
  const bare = decide({ producer: PRODUCER.KHY_LOCAL });
  assert.ok('riskLevel' in bare, '判决对象始终带 riskLevel 键');
  assert.equal(bare.riskLevel, undefined);
  assert.deepStrictEqual(Object.keys(bare), ['action', 'trust', 'reason', 'riskLevel']);
});

test('decide 只读入参、不写全局：同一 signals 重复判决一致，且不回写对象', () => {
  const signals = { producer: PRODUCER.CODEX, gateEnabled: true, interactive: false, riskLevel: 'high' };
  const snapshot = JSON.stringify(signals);
  const a = decide(signals);
  const b = decide(signals);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(JSON.stringify(signals), snapshot, 'decide 不许 mutate 入参');
  // 对抗面： mutate 成非交互 + 关闸，判决必须跟着变（证明上一步不是缓存了判决）。
  const c = decide({ ...signals, gateEnabled: false });
  assert.notDeepStrictEqual(c, a);
});

test('登记缺陷（不修）：decide(null) 抛 TypeError —— `= {}` 默认值对 null 不生效', () => {
  assert.throws(() => decide(null), (e) => e instanceof TypeError && /destructure/.test(e.message));
  // 对照：undefined 走默认值，正常出判决。热路径若把 producer 来源写成
  // `decide(ctxOrNull)`，null 会把整条工具调用打成崩溃，而不是安全地隔离。
  assert.equal(decide(undefined).action, ACTION.QUARANTINE);
  assert.equal(decide().action, ACTION.QUARANTINE);
});

// ──────────────────────────── assertNoAutoDangerous 不变式 ────────────────────────────

test('assertNoAutoDangerous：enablingDangerous 假值一律 no-op（含 null/0/""/undefined/false）', () => {
  for (const falsy of [false, 0, '', undefined, null]) {
    assert.doesNotThrow(
      () => assertNoAutoDangerous({ producer: PRODUCER.CODEX, enablingDangerous: falsy, gateEnabled: true }),
      `enablingDangerous=${String(falsy)} 不触碰 dangerous mode，不该抛`
    );
  }
  // 对抗面：同一条 ctx 改成 truthy 就必须抛。
  assert.throws(
    () => assertNoAutoDangerous({ producer: PRODUCER.CODEX, enablingDangerous: true, gateEnabled: true }),
    /dangerous mode/
  );
});

test('assertNoAutoDangerous：中转 + 闸开 + 要开 dangerous → 抛错，消息同时点名 producer 与 env 变量', () => {
  for (const producer of [PRODUCER.CODEX, PRODUCER.CLAUDE_CODE, PRODUCER.RELAY, 'brand-new-agent']) {
    assert.throws(
      () => assertNoAutoDangerous({ producer, enablingDangerous: true, gateEnabled: true }),
      (e) => {
        assert.ok(e instanceof Error);
        assert.ok(e.message.includes(String(producer)), `消息要能指认是谁：${e.message}`);
        assert.ok(e.message.includes(GATE_ENV), `消息要给出出口：${e.message}`);
        assert.ok(e.message.includes('dangerous'), `消息要说清被拦的是什么：${e.message}`);
        return true;
      }
    );
  }
  // 对照：未知 producer 也被拦（与 decide 同一条 fail-CLOSED 判据）。
  assert.throws(() => assertNoAutoDangerous({ producer: 'x', enablingDangerous: true, gateEnabled: true }), Error);
});

test('assertNoAutoDangerous：khy-local 与关闸两种情形放行；缺省 ctx 不抛', () => {
  assert.doesNotThrow(() =>
    assertNoAutoDangerous({ producer: PRODUCER.KHY_LOCAL, enablingDangerous: true, gateEnabled: true })
  );
  assert.doesNotThrow(() =>
    assertNoAutoDangerous({ producer: PRODUCER.CODEX, enablingDangerous: true, gateEnabled: false })
  );
  assert.doesNotThrow(() => assertNoAutoDangerous({}));
  // 对抗面：把闸打开，同一条中转调用立刻被拦 —— 「放行」来自条件而不是漏判。
  assert.throws(() => assertNoAutoDangerous({ producer: PRODUCER.CODEX, enablingDangerous: true, gateEnabled: true }));
});

test('assertNoAutoDangerous 的闸状态默认读 env：KHY_TRAJECTORY_QUARANTINE=0 时不变式失守（逃生口的真实代价）', () => {
  withEnv(GATE_ENV, '0', () => {
    assert.doesNotThrow(
      () => assertNoAutoDangerous({ producer: PRODUCER.CODEX, enablingDangerous: true }),
      'env 关闸 → 断言不拦（与 decide 的关闸放行一致）'
    );
  });
  withEnv(GATE_ENV, '1', () => {
    assert.throws(
      () => assertNoAutoDangerous({ producer: PRODUCER.CODEX, enablingDangerous: true }),
      /dangerous mode/
    );
  });
});

test('同族缺陷（登记，不修）：assertNoAutoDangerous(null) 抛 TypeError 而非按「无危险意图」放行', () => {
  assert.throws(() => assertNoAutoDangerous(null), (e) => e instanceof TypeError && /destructure/.test(e.message));
  // 对照：undefined 走 `= {}` 默认值，安全 no-op。
  assert.doesNotThrow(() => assertNoAutoDangerous(undefined));
});

// ──────────────────────────── 与标签枚举的一致性 ────────────────────────────

test('判决里的 trust/action 全部取自 khyTrace 与 ACTION 枚举，不引入第四种状态', () => {
  const trustVals = new Set(Object.values(TRUST));
  const actionVals = new Set(Object.values(ACTION));
  const probes = [
    { producer: PRODUCER.KHY_LOCAL },
    { producer: PRODUCER.CODEX, gateEnabled: false },
    { producer: PRODUCER.CODEX, gateEnabled: true, preApproved: true },
    { producer: PRODUCER.CODEX, gateEnabled: true, interactive: true },
    { producer: PRODUCER.CODEX, gateEnabled: true },
    { producer: 'unknown-agent', gateEnabled: true },
  ];
  const seen = new Set();
  for (const p of probes) {
    const d = decide(p);
    assert.ok(actionVals.has(d.action), `未知 action：${d.action}`);
    assert.ok(trustVals.has(d.trust), `未知 trust：${d.trust}`);
    seen.add(`${d.action}/${d.trust}`);
  }
  assert.deepStrictEqual([...seen].sort(), [
    'allow/claimed',
    'allow/verified',
    'gate/claimed',
    'quarantine/quarantined',
  ].sort(), '五类信号集必须恰好覆盖四种判决组合（allow 有两副面孔：本地/关闸）');
});
