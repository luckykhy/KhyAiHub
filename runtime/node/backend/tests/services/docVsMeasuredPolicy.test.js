'use strict';

/**
 * docVsMeasuredPolicy — 「文档 vs 实测」纪律叶子 + 结论期观察器的守卫测试。
 *
 * 缺口(已认领的行为缺陷):模型倾向引述文档里的说法,而不真的跑一遍/读一遍源码核实。仓内既有证据门
 * (P6, toolUseLoopCore)只在「已发生 ≥2 次实质工具调用」时启动,不覆盖「零调用直接引述文档收尾」。
 * 本叶子提供:① A 层注入的「引述前先自证」三档纪律;② 结论期零 IO 观察器(S1 只记录不阻断)。
 *
 * Invariants:
 *   ① gate KHY_DOC_VS_MEASURED default ON; 0/false/off/no → OFF
 *   ② declared data frozen (tiers / probe menu / anchors, entries + arrays)
 *   ③ format ON: marker + 三档 + 三个既有取证入口;OFF: '' (byte-revert, no injection)
 *   ④ evidence anchors resolve LIVE via the ONE shared checker (selfEvidenceVerifier)
 *   ⑤ observer: 引述未取证 → observed;已碰过 → 不记;门控关 → 不记;绝不抛
 *   ⑥ LIVE wiring: toolUseLoopCore 接缝引用 observeConclusion;flagRegistry 行为契约
 *   ⑦ 叶子契约守卫(scripts/lib/leafContractGuard)对本品零 findings
 *
 * node:test 套件(jest.config 忽略 node:test;由 test:node / node --test 执行)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const policy = require('../../src/services/docVsMeasuredPolicy');
const evidence = require('../../src/services/selfEvidenceVerifier');
const BACKEND_ROOT = path.resolve(__dirname, '../../');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '../../..');

// ── ① gate ────────────────────────────────────────────────────────────────
test('KHY_DOC_VS_MEASURED defaults ON, reverts on falsy words', () => {
  assert.strictEqual(policy.isEnabled({}), true);
  assert.strictEqual(policy.isEnabled({ KHY_DOC_VS_MEASURED: undefined }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(policy.isEnabled({ KHY_DOC_VS_MEASURED: off }), false, `'${off}'`);
  }
  assert.strictEqual(policy.isEnabled({ KHY_DOC_VS_MEASURED: '1' }), true);
});

// ── ② declared data frozen ────────────────────────────────────────────────
test('declared data is frozen (tiers / probe menu / anchors — entries and arrays)', () => {
  assert.ok(Object.isFrozen(policy.EVIDENCE_TIERS), 'tiers array frozen');
  assert.deepStrictEqual(
    policy.EVIDENCE_TIERS.map((t) => t.key),
    ['measured', 'source_read', 'doc_cited']
  );
  for (const t of policy.EVIDENCE_TIERS) {
    assert.ok(Object.isFrozen(t), `${t.key} frozen`);
    for (const k of ['key', 'label', 'rule']) {
      assert.ok(typeof t[k] === 'string' && t[k].length > 0, `${t.key}.${k} present`);
    }
  }
  assert.ok(Object.isFrozen(policy.PROBE_MENU), 'probe menu frozen');
  for (const p of policy.PROBE_MENU) {
    assert.ok(Object.isFrozen(p), `${p.probe} frozen`);
    assert.ok(typeof p.probe === 'string' && typeof p.what === 'string');
  }
  assert.ok(Object.isFrozen(policy.EVIDENCE_ANCHORS), 'anchors frozen');
  assert.ok(Object.isFrozen(policy.EVIDENCE_ANCHORS.modules), 'anchor modules frozen');
  assert.ok(Object.isFrozen(policy.EVIDENCE_ANCHORS.gates), 'anchor gates frozen');
});

// ── ③ system-prompt block ON / OFF ────────────────────────────────────────
test('formatDisciplineForSystemPrompt (ON): marker + tiers + 三个既有取证入口', () => {
  const out = policy.formatDisciplineForSystemPrompt({ env: {} });
  assert.ok(out.startsWith(policy.DOC_VS_MEASURED_MARKER), 'has marker first');
  for (const t of policy.EVIDENCE_TIERS) {
    assert.ok(out.includes(t.label) && out.includes(t.rule), `mentions tier ${t.key}`);
  }
  for (const p of policy.PROBE_MENU) {
    assert.ok(out.includes(p.probe), `mentions probe ${p.probe}`);
  }
  // 只说既有面:三个入口必须都是仓库现存命令/工具(不新增命令面 —— 棘轮已超)。
  assert.ok(out.includes('khy docs check'), 'docs freshness probe');
  assert.ok(out.includes('KhySelf(action:self_audit_verify)'), 'self-audit verify probe');
  assert.ok(out.includes('KhySelf(action:location)'), 'location+Read/Grep probe');
  assert.ok(out.includes('文档陈述·未实测'), 'unverified-citation label defined');
});

test('formatDisciplineForSystemPrompt (OFF): empty string (no injection, byte-revert)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      policy.formatDisciplineForSystemPrompt({ env: { KHY_DOC_VS_MEASURED: off } }),
      '',
      `'${off}'`
    );
  }
  assert.doesNotThrow(() => policy.formatDisciplineForSystemPrompt(null));
});

// ── ④ evidence anchors resolve live ──────────────────────────────────────
test('evidence anchors: live-verified by the shared checker (module files + gate states)', () => {
  const r = evidence.verifyAnchors(policy.EVIDENCE_ANCHORS, { env: {} });
  assert.strictEqual(r.verified, true, `anchor 核验失败:${r.reason}`);
  const expected =
    policy.EVIDENCE_ANCHORS.modules.length + policy.EVIDENCE_ANCHORS.gates.length;
  assert.strictEqual(r.checks.length, expected, '每项锚点都有逐项 check');
});

// ── ⑤ observer ────────────────────────────────────────────────────────────
test('observeConclusion: cited in-repo path, no tool call this turn → observed', () => {
  const r = policy.observeConclusion(
    {
      draft: '按文档 docs/10_规范/registry/DIST-SYNC.json 的说法,同步点已经记录。',
      toolCallLog: [],
    },
    { env: {} }
  );
  assert.strictEqual(r.observed, true);
  assert.deepStrictEqual(r.unopened, ['docs/10_规范/registry/DIST-SYNC.json']);
  assert.strictEqual(r.toolCalls, 0);
});

test('observeConclusion: path touched by a tool call this turn → not observed', () => {
  const r = policy.observeConclusion(
    {
      draft: '按文档 docs/10_规范/registry/DIST-SYNC.json 的说法。',
      toolCallLog: [
        { tool: 'Read', params: { file_path: 'docs/10_规范/registry/DIST-SYNC.json' } },
      ],
    },
    { env: {} }
  );
  assert.strictEqual(r.observed, false);
  assert.strictEqual(r.evidenceCalls, 1);
});

test('observeConclusion: long basename alone also counts as touched (params window)', () => {
  const r = policy.observeConclusion(
    {
      draft: '参见 docs/05_XXX/DIST-SYNC.json。',
      toolCallLog: [{ tool: 'grep', params: { pattern: 'DIST-SYNC.json' } }],
    },
    { env: {} }
  );
  assert.strictEqual(r.observed, false, '长基名(≥10)命中即视为已碰过');
});

test('observeConclusion: backticked path with spaces is extracted whole', () => {
  const citedPath =
    'docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-118] HQ 能力吸收与多机协作规范.md';
  const r = policy.observeConclusion(
    { draft: `详见 \`${citedPath}\`。`, toolCallLog: [{ tool: 'bash', params: { command: 'git status' } }] },
    { env: {} }
  );
  assert.strictEqual(r.observed, true);
  assert.deepStrictEqual(r.unopened, [citedPath]);
});

test('observeConclusion: gate OFF → not observed, honest reason', () => {
  const r = policy.observeConclusion(
    { draft: '见 docs/a.md', toolCallLog: [] },
    { env: { KHY_DOC_VS_MEASURED: '0' } }
  );
  assert.strictEqual(r.observed, false);
  assert.ok(/门控/.test(r.reason), 'reason names the gate');
});

test('observeConclusion: greeting / empty / garbage input never throws, not observed', () => {
  assert.strictEqual(policy.observeConclusion({ draft: '你好,有什么可以帮你?', toolCallLog: [] }, { env: {} }).observed, false);
  assert.strictEqual(policy.observeConclusion({ draft: '', toolCallLog: [] }, { env: {} }).observed, false);
  assert.strictEqual(policy.observeConclusion(null).observed, false);
  assert.strictEqual(policy.observeConclusion(undefined, null).observed, false);
  assert.strictEqual(policy.observeConclusion('junk').observed, false);
  assert.strictEqual(policy.observeConclusion({ draft: 123, toolCallLog: 'x' }).observed, false);
  assert.strictEqual(
    policy.observeConclusion({ draft: '见 docs/a.md', toolCallLog: [null, 1, { tool: null }] }, { env: {} }).observed,
    true,
    '坏条目被跳过,不影响判定'
  );
});

// ── ⑥ LIVE wiring ────────────────────────────────────────────────────────
test('toolUseLoopCore hosts the S1 observer hook (source contract)', () => {
  const src = fs.readFileSync(
    path.join(BACKEND_ROOT, 'src/services/tool/toolUseLoopCore.js'),
    'utf8'
  );
  assert.ok(/require\(['"]\.\.\/docVsMeasuredPolicy['"]\)/.test(src), 'loop requires the leaf');
  assert.ok(/observeConclusion\(/.test(src), 'loop calls observeConclusion');
  assert.ok(/'doc-grounding'/.test(src), 'observation lands on the breadcrumb channel');
  assert.ok(/KHY_DOC_VS_MEASURED/.test(src), 'hook documents its gate');
  // 样本落盘通道(2026-10-13 复核 mustFix):breadcrumb 默认不写盘(KHY_LOOP_DEBUG 未设即 return),
  // 只挂它 S1 零样本。观察记录必须同时进默认开的 toolLoopJournal,且带 runId 供按 run 召回。
  assert.ok(/appendJournal\(/.test(src), 'observation also lands in the default-on loop journal');
  assert.ok(/_loopRunId/.test(src), 'journal record is keyed by the run id (per-run召回)');
});

test('flagRegistry behavior contract: default ON, off words OFF', () => {
  const reg = require('../../src/services/flagRegistry');
  assert.strictEqual(reg.isFlagEnabled('KHY_DOC_VS_MEASURED', {}), true);
  assert.strictEqual(
    reg.isFlagEnabled('KHY_DOC_VS_MEASURED', { KHY_DOC_VS_MEASURED: 'off' }),
    false
  );
});

test('STAGE declares the rollout stage constant (S1 observer, PROCESS-008)', () => {
  assert.strictEqual(policy.STAGE, 'S1');
});

// ── ⑦ leaf-contract guard self-check ─────────────────────────────────────
test('leaf contract guard finds ZERO findings on this leaf (zero-IO self-declaration holds)', () => {
  const guard = require(path.join(REPO_ROOT, 'scripts/lib/leafContractGuard'));
  const src = fs.readFileSync(
    path.join(BACKEND_ROOT, 'src/services/docVsMeasuredPolicy.js'),
    'utf8'
  );
  assert.strictEqual(guard.declaresLeaf(src), true, '自声明纯叶子(守卫覆盖本品)');
  const r = guard.assessFile({
    relPath: 'runtime/node/backend/src/services/docVsMeasuredPolicy.js',
    source: src,
    env: {},
  });
  assert.deepStrictEqual(r.findings, [], `leaf 契约违规:${JSON.stringify(r.findings)}`);
});
