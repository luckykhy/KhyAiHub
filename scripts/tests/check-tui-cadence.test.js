'use strict';

/**
 * check-tui-cadence 测试（`RUNTIME-011` / `[DESIGN-PERF-004]` §7 铁律 R1–R3）。
 *
 * 跑法：`npm run test:scripts`（= `node --test "scripts/tests/**\/*.test.js"`）
 * 单跑：`node --test scripts/tests/check-tui-cadence.test.js`
 *
 * ⚠ 本仓另一套 runner 是 jest。这里用 `node:test`，因为守卫本身是 `scripts/` 下的
 * Node 脚本，与同目录既有守卫测试（check-commit-timing / check-no-emoji 等）一致。
 *
 * ## 覆盖重点
 *
 * 1. **阶段真的生效**（最重要）：同一输入在 S1 与 S3 下的 error 数**必须不同**。
 *    没有这条，`STAGE` 常量就是装饰 —— S1 与 S3 跑出一样的结果、一样的退出码，
 *    升到 S3 后机制仍不拦截，而所有守卫全绿（本仓实测踩过）。
 * 2. **方言必须被 ruleguard 解析**：`[WARN ]` 行带尾随文字会被 `FINDING_LINE` 的
 *    `\s*$` 静默丢弃 —— 那时「肉眼看到报了 N 条，门里 counts=0」，两边都绿。
 * 3. **不误伤**：`baseline` / `aligned` 必须 0 warning（证明判据不是恒真）。
 * 4. **抽取自校验**：规范表/兜底值抽不到时必须**报错**而不是静默继续。
 * 5. **`--changed` 语义**：改动集未触及节拍面 ⇒ 恒静默；`--files=` 空值不得
 *    静默 fall through 到真实暂存集。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-tui-cadence.js');
const guard = require(path.join(ROOT, 'scripts', 'lib', 'tuiCadenceGuard.js'));

/**
 * 跑一个场景。`stage` 传非 'S1' 时，临时拷一份改掉 STAGE 常量（模拟升阶）。
 *
 * ⚠ 结果按 (stage, args) 缓存：本文件有 20+ 用例、每个 spawn 一个 Node 子进程。
 * 全量 `npm run test:scripts`（1000 用例）的并发压力下，个别 spawn 会超时 ——
 * 表现为**间歇性** not ok（单独跑必绿）。判定本身是纯函数，重复 spawn 本就是在
 * 测 Node 而不是测判据，故缓存是结构性保证而非优化。
 */
const _cache = new Map();
function run(args = [], opts = {}) {
  const stage = opts.stage || 'S1';
  const key = JSON.stringify({ stage, args });
  if (_cache.has(key)) return _cache.get(key);
  const r = cp.spawnSync(process.execPath, [scriptFor(stage), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
  });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const m = /Summary: (\d+) error\(s\), (\d+) warning\(s\)\./.exec(output);
  const out = {
    status: r.status,
    output,
    errors: m ? Number(m[1]) : -1,
    warnings: m ? Number(m[2]) : -1,
  };
  _cache.set(key, out);
  return out;
}

/**
 * 取某阶段对应的脚本路径。S1 用真身；其余用临时改过常量的副本。
 *
 * ⚠ 副本**不能**落在 `scripts/ci/` 下：那正是 `check-wiring.js` 的检查器扫描范围，
 * 测试跑的那几秒里另一个终端跑 `check:wiring` 会看到它「零接线」而报 error ——
 * 「没改任何东西却突然变红」，间歇且极难归因（本仓 2026-09-19 实测）。
 * ⇒ 落 `scripts/.tui-cadence-tmp/`：仍是 `scripts/` 子目录（`__dirname/../..`
 * 推根层数不变），但不在任何守卫 glob 里。退出时兜底清理。
 */
const TMP_DIR = path.join(ROOT, 'scripts', '.tui-cadence-tmp');
const _tmpCache = new Map();
function scriptFor(stage) {
  if (stage === 'S1') return SCRIPT;
  if (_tmpCache.has(stage)) return _tmpCache.get(stage);
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const patched = src.replace(/^const STAGE = 'S1';/m, `const STAGE = '${stage}';`);
  assert.notEqual(patched, src, `无法把 STAGE 常量改成 ${stage}（源码形状变了？）`);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const p = path.join(TMP_DIR, `_tui-cadence-${stage}.js`);
  fs.writeFileSync(p, patched, 'utf8');
  _tmpCache.set(stage, p);
  return p;
}

process.on('exit', () => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── 1. 阶段真的生效 ─────────────────────────────────────────────────────────

describe('check-tui-cadence — 阶段真的生效（STAGE 不是装饰）', () => {
  test('同一输入在 S1 与 S3 下 error 数必须不同', () => {
    const s1 = run(['--scenario=fallback-drift'], { stage: 'S1' });
    const s3 = run(['--scenario=fallback-drift'], { stage: 'S3' });
    assert.notEqual(
      s1.errors,
      s3.errors,
      `S1 与 S3 的 error 数相同（${s1.errors}）—— STAGE 常量没生效\n${s1.output}`
    );
    assert.equal(s1.errors, 0, `S1 必须 0 error（PP-3 只记录不阻断）\n${s1.output}`);
    assert.ok(s3.errors > 0, `S3 必须派生 error\n${s3.output}`);
  });

  test('退出码语义：S1 恒 0，S3 有 error 才 1', () => {
    assert.equal(run(['--scenario=fallback-drift'], { stage: 'S1' }).status, 0);
    assert.equal(run(['--scenario=fallback-drift'], { stage: 'S3' }).status, 1);
    // baseline 在 S1 恒 0（即使有 info 缺口）
    assert.equal(run([], { stage: 'S1' }).status, 0);
  });

  test('S3 的 error 全部来自 R3 缺口（R1/R2 现状无未裁决漂移）', () => {
    const s3 = run([], { stage: 'S3' });
    const s1 = run(['--list'], { stage: 'S1' });
    const unboundSpec = (s1.output.match(/unbound-spec /g) || []).length;
    assert.ok(unboundSpec > 0, `baseline 应有 unbound-spec 缺口\n${s1.output}`);
    assert.equal(
      s3.errors,
      unboundSpec,
      `S3 baseline 的 error 应恰等于 unbound-spec 缺口数（${unboundSpec}）\n${s3.output}`
    );
  });

  test('severityFor 是单点派生：S1 无 error，S3 有 error', () => {
    const findings = guard.evaluate(
      guard.applyScenario('fallback-drift', require(path.join(ROOT, 'scripts', 'ci', 'check-tui-cadence.js')).collect()),
      { stage: 'S1' }
    );
    const ids = new Set(findings.map((f) => f.criterion));
    assert.ok(ids.has('fallback-drift'), 'S1 下 fallback-drift 仍必须出现（只是降级）');
    assert.equal(guard.severityFor('fallback-drift', 'S1'), 'warning');
    assert.equal(guard.severityFor('fallback-drift', 'S3'), 'error');
    assert.equal(guard.severityFor('cadence-drift-known', 'S3'), 'info', '已裁决漂移不得升 error');
    assert.equal(guard.severityFor('unbound-impl', 'S3'), 'info', 'R3 反向缺口未立判据，不得升 error');
    assert.equal(guard.severityFor('不存在的判据', 'S3'), 'warning', '未知判据必须降级，禁 fail-open');
  });
});

// ── 2. 不误伤 ───────────────────────────────────────────────────────────────

describe('check-tui-cadence — 不误伤（判据不是恒真）', () => {
  test('baseline（真实仓库）0 error / 0 warning', () => {
    const r = run([]);
    assert.equal(r.errors, 0, r.output);
    assert.equal(r.warnings, 0, r.output);
  });

  test('aligned（实现与兜底全部对齐规范值）0 warning —— 证明「会放行」', () => {
    const r = run(['--scenario=aligned']);
    assert.equal(r.errors, 0, r.output);
    assert.equal(r.warnings, 0, r.output);
    assert.ok(!/cadence-drift(?!-known)/.test(r.output), `aligned 不应报未裁决漂移\n${r.output}`);
    // ⚠ 上面三条**不足以**证明 aligned 真的对齐了：因为唯一的存量漂移（Spinner 160）
    // 已在 KNOWN_DRIFTS 白名单里，所以「aligned 等于 baseline」也能过。必须直接断言
    // 漂移**已消失**（变异测试实测：只写上面三条时，「aligned 不对齐」的变异体存活）。
    const shell = require(SCRIPT);
    const aligned = guard.applyScenario('aligned', shell.collect());
    const ids = guard.evaluate(aligned, { stage: 'S1' }).map((f) => f.criterion);
    assert.ok(!ids.includes('cadence-drift-known'), `aligned 必须真的消除已裁决漂移\n${ids.join(',')}`);
    assert.ok(!ids.includes('cadence-drift'), `aligned 必须真的消除未裁决漂移\n${ids.join(',')}`);
    assert.ok(!ids.includes('fallback-drift'), `aligned 的兜底必须真的对齐\n${ids.join(',')}`);
  });

  test('反例矩阵 7/7 通过', () => {
    const r = run(['--scenario=matrix']);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /反例矩阵：7\/7 通过/);
  });
});

// ── 3. 每条判据都能真报警 ───────────────────────────────────────────────────

describe('check-tui-cadence — 反例命中', () => {
  test('spec-missing → binding-orphan', () => {
    const r = run(['--scenario=spec-missing']);
    assert.equal(r.warnings, 1, r.output);
    assert.match(r.output, /binding-orphan/);
  });

  test('fallback-drift → fallback-drift（topicBar 无已知漂移，必须报 warning）', () => {
    const r = run(['--scenario=fallback-drift']);
    assert.equal(r.warnings, 1, r.output);
    assert.match(r.output, /fallback-drift /);
    assert.match(r.output, /topicBar\.js:62/);
  });

  test('fallback-drift-known → 降为 info，**不得**报 warning（兜底容差）', () => {
    const r = run(['--scenario=fallback-drift-known']);
    assert.equal(r.warnings, 0, `已裁决绑定的兜底不得报 warning\n${r.output}`);
    const all = run(['--scenario=fallback-drift-known', '--list']);
    assert.match(all.output, /fallback-drift-known/);
  });

  test('spec-unreadable → 只报根因，不派生 binding-orphan 噪声', () => {
    const r = run(['--scenario=spec-unreadable', '--list']);
    assert.equal(r.warnings, 1, r.output);
    assert.match(r.output, /spec-unreadable/);
    assert.ok(!/binding-orphan/.test(r.output), `表读不到时不应派生 orphan\n${r.output}`);
  });

  test('no-binding → 全部落入 unbound-*，且无漂移误报', () => {
    const r = run(['--scenario=no-binding', '--list']);
    assert.equal(r.warnings, 0, r.output);
    assert.match(r.output, /unbound-spec /);
    assert.match(r.output, /unbound-impl /);
    assert.ok(!/cadence-drift/.test(r.output), r.output);
  });
});

// ── 4. 方言必须被 ruleguard 解析（最贵的一类假绿）────────────────────────────

describe('check-tui-cadence — finding 方言被 ruleguard 解析', () => {
  const ruleguard = (() => {
    try {
      return require(path.join(ROOT, 'scripts', 'ruleguard', 'lib', 'run.js'));
    } catch {
      return null;
    }
  })();

  test('逐项方言（有行号）能被解析出 1 条 warning', () => {
    if (!ruleguard) return; // ruleguard 不在时跳过（不假装通过）
    const r = run(['--scenario=fallback-drift']);
    const parsed = ruleguard.parseFindings(r.output);
    assert.equal(parsed.length, 1, `ruleguard 解析数 ≠ 肉眼可见数\n${r.output}`);
    assert.equal(parsed[0].finding, 'fallback-drift');
    assert.equal(parsed[0].severity, 'warning');
    assert.equal(parsed[0].file, 'services/backend/src/cli/tui/runtime/topicBar.js');
    assert.equal(parsed[0].line, 62);
  });

  test('聚合方言（无行号）能被解析出 1 条 warning', () => {
    if (!ruleguard) return;
    const r = run(['--scenario=spec-missing']);
    const parsed = ruleguard.parseFindings(r.output);
    assert.equal(parsed.length, 1, `聚合方言未被解析\n${r.output}`);
    assert.equal(parsed[0].finding, 'binding-orphan');
    assert.equal(parsed[0].line, 0, '聚合方言的 line 必须是 0（不伪造行号）');
  });

  test('逐项方言行不得带尾随文字（否则 FINDING_LINE 的 \\s*$ 失配）', () => {
    const r = run(['--scenario=fallback-drift']);
    const line = r.output.split(/\r?\n/).find((l) => l.startsWith('[WARN ]'));
    assert.ok(line, r.output);
    assert.match(line, /^\[WARN \] \S+ \S+:\d+$/, `方言行带了尾随文字：${line}`);
  });

  test('info 行不参与方言（不得伪装成 ERROR/WARN）', () => {
    const r = run(['--list']);
    const infoLines = r.output.split(/\r?\n/).filter((l) => l.startsWith('[INFO ]'));
    assert.ok(infoLines.length > 0, r.output);
    for (const l of infoLines) assert.ok(!/^\[(ERROR|WARN )\]/.test(l), l);
  });
});

// ── 5. 纯叶子：绝不抛 + 抽取自校验 ──────────────────────────────────────────

describe('check-tui-cadence — 纯叶子绝不抛', () => {
  test('垃圾输入不抛', () => {
    for (const bad of [null, undefined, 0, '', 'x', [], {}, { spec: null }, { spec: {} }, { impl: null, bindings: null }]) {
      assert.doesNotThrow(() => guard.evaluate(bad, { stage: 'S1' }));
      assert.doesNotThrow(() => guard.summarize(bad));
    }
    assert.doesNotThrow(() => guard.parseSpecTable(null));
    assert.doesNotThrow(() => guard.extractFallback(null, null));
    assert.doesNotThrow(() => guard.loadImpl(null, null));
  });

  test('parseSpecTable：找不到 §3.3 必须报错，不静默返回空表', () => {
    assert.ok(guard.parseSpecTable('# 没有 3.3 的文档').error);
    assert.ok(guard.parseSpecTable('### 3.3 计时器优先级\n\n| 计时器 | 间隔 |\n|---|---|\n').error);
    const ok = guard.parseSpecTable('### 3.3 计时器优先级\n\n| 计时器 | 间隔 |\n|---|---|\n| Spinner | 80ms |\n');
    assert.equal(ok.error, null);
    assert.deepEqual(ok.rows, [{ name: 'Spinner', ms: 80, line: 5 }]);
  });

  test('extractFallback：正则抽不到必须报错，不静默返回 null', () => {
    const miss = guard.extractFallback('const X = 1;', /let\s+FRAME_MS\s*=\s*(\d+)/);
    assert.ok(miss.error, '抽不到必须报错 —— 静默 null 会让 R2 静默失效');
    assert.equal(miss.value, null);
    const hit = guard.extractFallback('// c\nlet FRAME_MS = 80;\n', /let\s+FRAME_MS\s*=\s*(\d+)/);
    assert.equal(hit.value, 80);
    assert.equal(hit.line, 2);
  });

  test('loadImpl 按 arity 动态枚举 —— 新增旋钮不得被静默漏掉', () => {
    // 手写清单会腐化：原型初版漏掉 taskSnapshotTtlMs 就是因为清单是手写的
    const impl = guard.loadImpl(
      {
        a: (env) => 1,
        b: () => 2,
        c: (a, b, c) => 3, // 3 参纯计算（如 heartbeatAlignDelayMs）必须排除
        d: (env) => 'not-a-number', // 非数字排除
        e: () => { throw new Error('boom'); }, // 抛的必须跳过而不是崩
      },
      {}
    );
    assert.deepEqual(Object.keys(impl).sort(), ['a', 'b']);
  });

  test('真实 perfTunables 至少枚举出 6 个旋钮（含 taskSnapshotTtlMs）', () => {
    const impl = guard.loadImpl(require(path.join(ROOT, guard.IMPL_FILE)), {});
    assert.ok(Object.keys(impl).length >= 6, JSON.stringify(impl));
    assert.ok('taskSnapshotTtlMs' in impl, '新增旋钮被漏掉 ⇒ 手写清单式腐化复现');
    assert.ok(!('heartbeatAlignDelayMs' in impl), '3 参纯计算不得被当旋钮');
  });
});

// ── 6. --changed 语义 ───────────────────────────────────────────────────────

describe('check-tui-cadence — --changed 语义', () => {
  test('改动集未触及节拍面 ⇒ 恒静默（不重报存量）', () => {
    const r = run(['--changed', '--files=README.md']);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /未触及节拍面/);
    assert.equal(r.errors, 0);
    assert.equal(r.warnings, 0);
  });

  test('改动集触及节拍面 ⇒ 正常判定（不打印「未触及」）', () => {
    const r = run(['--changed', '--files=services/backend/src/cli/tui/perfTunables.js']);
    assert.equal(r.status, 0, r.output);
    assert.ok(!/未触及节拍面/.test(r.output), r.output);
  });

  test('`--files=` 空值不得静默 fall through 到真实暂存集', () => {
    const r = run(['--changed', '--files=']);
    assert.match(r.output, /未触及节拍面/, '空值被当「未提供」⇒ 会用真实暂存集，行为不可预测');
  });

  test('filesArgOrNull 区分「空值」与「未提供」', () => {
    const { filesArgOrNull } = require(SCRIPT);
    assert.equal(filesArgOrNull([]), null);
    assert.deepEqual(filesArgOrNull(['--files=']), []);
    assert.deepEqual(filesArgOrNull(['--files=a.js,b.js']), ['a.js', 'b.js']);
  });
});

// ── 7. 接线一致性 ───────────────────────────────────────────────────────────

describe('check-tui-cadence — 接线一致性', () => {
  test('执行器里的 STAGE 常量与 FEATURE-OWNERSHIP 登记一致', () => {
    const regPath = path.join(ROOT, 'docs', '10_规范', 'registry', 'FEATURE-OWNERSHIP.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    const mech = (reg.rollout && reg.rollout.mechanisms || []).find(
      (m) => m.executor === 'scripts/ci/check-tui-cadence.js'
    );
    assert.ok(mech, 'FEATURE-OWNERSHIP.json 里没有本机制的登记条目');
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const hit = /const\s+(\w+)\s*=\s*'(S[1-4])'/.exec(src);
    assert.ok(hit, '执行器里找不到字面 STAGE 常量（check-rollout-stage 需要它）');
    assert.equal(hit[1], mech.executorStage.constant, 'executorStage.constant 与源码常量名不一致');
    const blocks = ['S3', 'S4'].includes(mech.stage);
    const codeBlocks = ['S3', 'S4'].includes(hit[2]);
    assert.equal(codeBlocks, blocks, `登记 stage=${mech.stage} 与源码 STAGE=${hit[2]} 的阻断语义不一致`);
    assert.deepEqual(mech.rules, ['RUNTIME-011'], '机制登记的 rules 必须是 RUNTIME-011');
  });

  test('RUNTIME-011 在登记表里，且 gate/severity/exec 正确', () => {
    const regPath = path.join(ROOT, 'docs', '10_规范', 'registry', 'RULES-REGISTRY.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    const rule = reg.rules.find((r) => r.id === 'RUNTIME-011');
    assert.ok(rule, 'RUNTIME-011 未登记');
    assert.equal(rule.gate, 'commit', 'gate=advisory 会让规则永不被 spawn（GATE_ORDER.advisory=4 > max=2）');
    assert.equal(rule.severity, 'advisory');
    assert.equal(rule.exec.script, 'scripts/ci/check-tui-cadence.js');
    assert.ok(Array.isArray(rule.exec.findings) && rule.exec.findings.length > 0);
    // 每个登记 finding 必须真的能被执行器产出（否则是死指针）
    const known = new Set(Object.keys(guard.CRITERIA));
    for (const f of rule.exec.findings) assert.ok(known.has(f), `登记了不存在的 finding：${f}`);
  });

  test('package.json 有 check:tui-cadence 别名（否则 check-wiring 判零接线）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['check:tui-cadence'], 'node scripts/ci/check-tui-cadence.js');
  });

  test('--json 后仍追加 Summary 行（$g 约定）', () => {
    const r = run(['--json']);
    const head = r.output.split(/\n(?=Summary:)/)[0];
    const parsed = JSON.parse(head);
    assert.equal(parsed.stage, 'S1');
    assert.equal(parsed.summary.errors, 0);
    assert.ok(Array.isArray(parsed.findings));
    assert.match(r.output, /Summary: 0 error\(s\), 0 warning\(s\)\./);
  });
});
