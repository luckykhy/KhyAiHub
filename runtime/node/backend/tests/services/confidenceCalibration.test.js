'use strict';

/**
 * confidenceCalibration — guard tests for 「确信度校准」(开口前先判「我到底知不知道」).
 *
 * 缺陷:生成机制天然倾向接一个通顺的回答,一知半解时说得和真确定时一样笃定。提示侧由
 * selfProfile 注入校准协议;运行侧由 harness 收尾 S1 观察器(只记录不阻断)扫描两个
 * finding 类:
 *   - unbacked_certainty:零工具轮 + 笃定措辞(启发式)。
 *   - unbacked_verification_claim:零工具轮 + 会话历史无工具活动 + read/check 系自称
 *     (此时必为假;跨轮真实引用由 conversationMessages 排除)。
 * 与既有机制的分工(不重复计量):命中 claimReconciler.CLAIM_FAMILIES 六族的文本已由
 * answerVerifier 在同一接缝用户可见地纠错,本观察器跳过;否定判定复用 claimNegation。
 *
 * Invariants:
 *   ① gate KHY_CONFIDENCE_CALIBRATION default ON; 0/false/off/no → OFF; 关时
 *      formatForSystemPrompt 返 ''、observe 返 null(接缝逐字节回退)
 *   ② stage 默认 S1,env 覆盖只认 S2/S3,其余一律回落(绝不 fail-open)
 *   ③ 提示块含三档协议 + 纯问答适用条款 + 笃定措辞禁用条款
 *   ④ 扫描器:零工具 + 笃定措辞 → unbacked_certainty;零工具 + 历史无工具 + 自称已核验 →
 *      unbacked_verification_claim;有工具调用 → 不产出 finding;
 *      历史有工具活动 → 只可能记 unbacked_certainty(跨轮引用不误报)
 *   ⑤ 否定语境(不一定 / 绝对路径)不算笃定;反问式收尾不算结论;过短回复不扫
 *      (中文主导回复下限 40,其余 120 —— 61 字中文典型过度自信短答必须入样)
 *   ⑥ 全冻结(数组与条目)、绝不抛(坏输入返回安全值)
 *   ⑦ 台账:只落有 finding 的行、不落回复正文、env 可注入落点、绝不抛
 *   ⑧ LIVE wiring(集成锁:共享登记文件的 registryPatches 未落地前前三条会红——
 *      这是刻意的,防止整合时漏接线):
 *      selfProfile 注入块 / flagRegistry 登记 / FEATURE-OWNERSHIP 阶段登记 /
 *      harness 观察器接线(grep 锁 + 行为级端到端,后者真跑到观察器)
 *
 * node:test(jest 经 jest.config.js 的 findNodeTestFiles 跳过本文件)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cc = require('../../src/services/confidenceCalibration');
const ledger = require('../../src/services/confidenceCalibrationLedger');
const claimNegation = require('../../src/services/domain/trajectory/trajectoryProvenance/claimNegation');

const BACKEND_ROOT = path.resolve(__dirname, '../../');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..', '..', '..');

// ── ① gate ────────────────────────────────────────────────────────────────
test('KHY_CONFIDENCE_CALIBRATION defaults ON, reverts on falsy words', () => {
  assert.strictEqual(cc.isEnabled({}), true);
  assert.strictEqual(cc.isEnabled({ KHY_CONFIDENCE_CALIBRATION: undefined }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(cc.isEnabled({ KHY_CONFIDENCE_CALIBRATION: off }), false, `'${off}'`);
  }
  assert.strictEqual(cc.isEnabled({ KHY_CONFIDENCE_CALIBRATION: '1' }), true);
  // 父注册表关闭 → 本地 CANON 回退仍生效(kill-switch 不因注册表缺席而失效)
  assert.strictEqual(
    cc.isEnabled({ KHY_FLAG_REGISTRY: '0', KHY_CONFIDENCE_CALIBRATION: 'off' }),
    false
  );
});

test('formatForSystemPrompt OFF returns empty string (byte-revert, no injection)', () => {
  assert.strictEqual(cc.formatForSystemPrompt({ env: { KHY_CONFIDENCE_CALIBRATION: '0' } }), '');
  assert.strictEqual(cc.formatForSystemPrompt({ env: { KHY_CONFIDENCE_CALIBRATION: 'off' } }), '');
});

// ── ② stage ───────────────────────────────────────────────────────────────
test('stage defaults to S1, accepts S2/S3 only, never fail-opens upward', () => {
  assert.strictEqual(cc.KHY_CONFIDENCE_CALIBRATION_STAGE, 'S1');
  assert.strictEqual(cc.getStage({}), 'S1');
  assert.strictEqual(cc.getStage({ KHY_CONFIDENCE_CALIBRATION_STAGE: 'S2' }), 'S2');
  assert.strictEqual(cc.getStage({ KHY_CONFIDENCE_CALIBRATION_STAGE: 'S3' }), 'S3');
  assert.strictEqual(cc.getStage({ KHY_CONFIDENCE_CALIBRATION_STAGE: 's3' }), 'S3');
  assert.strictEqual(cc.getStage({ KHY_CONFIDENCE_CALIBRATION_STAGE: 'S9' }), 'S1');
  assert.strictEqual(cc.getStage({ KHY_CONFIDENCE_CALIBRATION_STAGE: 'bogus' }), 'S1');
});

// ── ③ directive content ───────────────────────────────────────────────────
test('formatForSystemPrompt (ON) carries the three-tier protocol and the tool-less clause', () => {
  const out = cc.formatForSystemPrompt({ env: {} });
  assert.ok(out.includes(cc.CALIBRATION_MARKER), 'has marker');
  for (const tier of ['本轮已验证', '训练知识', '未验证']) {
    assert.ok(out.includes(tier), `mentions tier ${tier}`);
  }
  assert.ok(/零工具调用的纯问答同样适用/.test(out), 'applies to tool-less Q&A');
  assert.ok(/禁用/.test(out) && /一定/.test(out), 'bans certainty wording');
  assert.ok(/\[SYSTEM:/.test(out), 'bilingual: has the [SYSTEM: en] line');
});

// ── ④ scan: the two finding kinds ─────────────────────────────────────────
const CERTAINTY_REPLY =
  '关于你问的默认端口问题：这个冲突一定是 env 覆盖没生效导致的，把环境变量改成 3001 之后必然能正常启动不会有任何问题，我对此绝对有把握。整个启动链路我在脑子里过了一遍，配置读取的顺序毫无疑问就是先 env 后默认值，所以你直接重启服务即可，不需要再做其它检查，也不必再跑任何命令来验证，改完就一定好了，请放心操作。';
const CLAIM_REPLY =
  '我查了你的配置文件，也读了启动脚本，确认默认端口就是 3001。具体来说，启动脚本里读取端口的顺序是先看环境变量再回退默认值，而你的配置文件里没有覆盖这一项，所以行为保持不变。这个结论来自我本轮实际查看的源码，不需要你再自行验证，按住我说的操作就可以了，改完就能生效。';

function assertSubstantive(reply) {
  assert.ok(reply.replace(/\s/g, '').length >= cc.MIN_SUBSTANTIVE_CHARS, 'fixture is substantive');
}

test('zero-tool turn + certainty wording → unbacked_certainty (with evidence labels)', () => {
  assertSubstantive(CERTAINTY_REPLY);
  const scan = cc.scanUnbackedClaims({ finalResponse: CERTAINTY_REPLY, toolCallLog: [] });
  const kinds = scan.findings.map((f) => f.kind);
  assert.ok(kinds.includes('unbacked_certainty'), 'unbacked_certainty recorded');
  const f = scan.findings.find((x) => x.kind === 'unbacked_certainty');
  assert.ok(f.evidence.length > 0 && f.evidence.length <= 6, 'evidence labels capped');
  assert.ok(scan.certaintyMarkers.includes('一定'), 'captures 一定');
});

test('zero-tool turn + "I checked/read/ran" claim → unbacked_verification_claim', () => {
  assertSubstantive(CLAIM_REPLY);
  const scan = cc.scanUnbackedClaims({ finalResponse: CLAIM_REPLY, toolCallLog: [] });
  const kinds = scan.findings.map((f) => f.kind);
  assert.ok(kinds.includes('unbacked_verification_claim'), 'fabricated verification recorded');
  assert.ok(scan.verificationClaims.length > 0, 'claims listed');
});

test('with tool calls this turn → no findings (existing evidence gates own that case)', () => {
  const scan = cc.scanUnbackedClaims({
    finalResponse: CERTAINTY_REPLY,
    toolCallLog: [{ tool: 'Read', result: { success: true } }],
  });
  assert.strictEqual(scan.findings.length, 0);
  assert.strictEqual(scan.toolCalls, 1);
});

// ── ④b reuse of the existing single sources / no double counting ──────────
test('negation guard and claim families are reused from existing leaves (no re-created lexicon)', () => {
  assert.strictEqual(cc._claimNegationLeaf, claimNegation, 'delegates to claimNegation leaf');
  assert.strictEqual(cc._isNegated('我不一定知道', 2), true, 'negated at 一定');
  assert.strictEqual(cc._isNegated('这个一定是端口问题', 2), false, 'not negated');
  assert.ok(
    Array.isArray(cc._claimFamilies) && cc._claimFamilies.length >= 6,
    'claimReconciler.CLAIM_FAMILIES reused as the reconciled-family boundary'
  );
});

test('claims already reconciled by an existing CLAIM_FAMILIES family are not double-counted', () => {
  // 「我跑过了测试，全部通过」命中 claimReconciler 的 test 族 → 已由 answerVerifier 对账并
  // 用户可见地纠错,本观察器不重复计量(既不记 finding,也不列入 verificationClaims)。
  const reply =
    '我跑过了测试，全部通过。整个测试套件覆盖了主要的启动路径，输出里没有失败项，也没有警告需要处理。你可以放心继续下一步，不需要再重复执行一遍，因为结果已经稳定复现了三次，每次都是全绿。';
  const scan = cc.scanUnbackedClaims({ finalResponse: reply, toolCallLog: [] });
  assert.strictEqual(scan.verificationClaims.length, 0, 'family claim not re-listed');
  assert.strictEqual(scan.findings.length, 0, 'no double counting');
});

// ── ④c cross-turn references: prior tool activity suppresses the claim ────
const CROSS_TURN_REPLY =
  '我查过了刚才的排查和这次的日志，两边的结论是一致的：端口被占用时服务会直接退出，而不是自动换端口。所以你看到的报错和刚才的排查一致，不需要再怀疑别的原因。另外，配置里没有设置自动回退，这也是同一个根因，改掉就好。';

test('cross-turn "I checked" with tool activity in history → no finding (true reference, not fabricated)', () => {
  const withHistory = cc.scanUnbackedClaims({
    finalResponse: CROSS_TURN_REPLY,
    toolCallLog: [],
    conversationMessages: [
      { role: 'user', content: '帮我看下端口' },
      { role: 'assistant', content: '我先读配置。' },
      { role: 'user', content: [{ type: 'tool_result', content: 'port=3000' }] },
    ],
  });
  assert.strictEqual(withHistory.priorToolActivity, true);
  assert.strictEqual(withHistory.findings.length, 0, 'history carries tool activity → no claim finding');
  // 同一文本在无历史时仍应记账(样本语义:声称在本轮无可背书证据)
  const noHistory = cc.scanUnbackedClaims({
    finalResponse: CROSS_TURN_REPLY,
    toolCallLog: [],
    conversationMessages: [],
  });
  assert.ok(
    noHistory.findings.some((f) => f.kind === 'unbacked_verification_claim'),
    'no history at all → the claim has nothing to lean on'
  );
  // priorToolActivity 布尔捷径同效
  const shortcut = cc.scanUnbackedClaims({
    finalResponse: CROSS_TURN_REPLY,
    toolCallLog: [],
    priorToolActivity: true,
  });
  assert.strictEqual(shortcut.findings.length, 0);
});

test('certainty wording still observed when history has tool activity (heuristic is not gated)', () => {
  const scan = cc.scanUnbackedClaims({
    finalResponse: CERTAINTY_REPLY,
    toolCallLog: [],
    priorToolActivity: true,
  });
  const kinds = scan.findings.map((f) => f.kind);
  assert.ok(kinds.includes('unbacked_certainty'), 'certainty is recorded regardless of history');
  assert.ok(!kinds.includes('unbacked_verification_claim'), 'verification claim suppressed');
});

// ── ⑤ negation / clarification / short replies ────────────────────────────
test('negated wording and 绝对路径 are not certainty markers', () => {
  const scan = cc.scanUnbackedClaims({
    finalResponse: `关于端口，我不一定知道确切值，绝对路径我也没查过，这块我未验证。${'补充一句上下文，避免回复过短影响扫描。'.repeat(3)}`,
    toolCallLog: [],
  });
  assert.strictEqual(scan.certaintyMarkers.length, 0);
  // 情态动词后的否定(共享 claimNegation 窗口之外)按词形排除,不记(回归锁)
  const modal = cc.scanUnbackedClaims({
    finalResponse: `我不敢肯定是不是端口问题，也没法肯定配置读对了，你先改成 3001 试试看效果。${'补充上下文避免过短。'.repeat(3)}`,
    toolCallLog: [],
  });
  assert.strictEqual(modal.certaintyMarkers.length, 0, 'modal-negated 肯定 is not a marker');
});

test('clarification-style replies are not treated as conclusions', () => {
  for (const reply of [
    `这个要看你的实际部署方式，以下几条路径都可能成立，你想让我按哪一个继续深入？${'上下文补充。'.repeat(12)}`,
    `需要我先确认一下你的目标环境，再给出建议。${'上下文补充。'.repeat(12)}`,
  ]) {
    const scan = cc.scanUnbackedClaims({ finalResponse: reply, toolCallLog: [] });
    assert.strictEqual(scan.findings.length, 0, `clarification skipped: ${reply.slice(0, 18)}…`);
  }
});

test('short replies are not scanned for findings', () => {
  const scan = cc.scanUnbackedClaims({ finalResponse: '一定是的。', toolCallLog: [] });
  assert.strictEqual(scan.findings.length, 0);
  assert.ok(scan.replyChars > 0 && scan.replyChars < cc.MIN_SUBSTANTIVE_CHARS);
});

test('CJK replies use the 40-char floor: a 60-char overconfident answer is observed', () => {
  const shortCjk =
    '这个一定是端口冲突导致的，我查过了配置，改成 3001 就没问题了。不过你要是还不行再告诉我，我再看看别的地方是不是有问题。';
  const chars = shortCjk.replace(/\s/g, '').length;
  assert.ok(
    chars >= cc.MIN_SUBSTANTIVE_CHARS_CJK && chars < cc.MIN_SUBSTANTIVE_CHARS,
    `fixture in the CJK tier (${chars})`
  );
  const scan = cc.scanUnbackedClaims({ finalResponse: shortCjk, toolCallLog: [] });
  assert.strictEqual(scan.floor, cc.MIN_SUBSTANTIVE_CHARS_CJK);
  const kinds = scan.findings.map((f) => f.kind);
  assert.ok(kinds.includes('unbacked_certainty'), 'certainty observed in the CJK tier');
  assert.ok(kinds.includes('unbacked_verification_claim'), 'claim observed in the CJK tier');
  // 再短一档(典型 20 字级短答)仍不扫
  const tiny = cc.scanUnbackedClaims({
    finalResponse: '这个一定是端口冲突，改成 3001 就行了',
    toolCallLog: [],
  });
  assert.strictEqual(tiny.findings.length, 0);
  assert.ok(tiny.replyChars < cc.MIN_SUBSTANTIVE_CHARS_CJK);
});

// ── ⑥ frozen + never throws ───────────────────────────────────────────────
test('reports are frozen; bad input never throws', () => {
  const scan = cc.scanUnbackedClaims({ finalResponse: CERTAINTY_REPLY, toolCallLog: [] });
  assert.throws(() => {
    scan.certaintyMarkers.push('x');
  }, 'markers frozen');
  assert.throws(() => {
    scan.findings.push({});
  }, 'findings frozen');
  const before = scan.findings[0].kind;
  try {
    scan.findings[0].kind = 'x';
  } catch {
    /* strict-mode throw ok */
  }
  assert.strictEqual(scan.findings[0].kind, before, 'finding entries frozen');

  assert.doesNotThrow(() => cc.scanUnbackedClaims());
  assert.doesNotThrow(() => cc.scanUnbackedClaims(null));
  assert.doesNotThrow(() => cc.scanUnbackedClaims({ finalResponse: 123, toolCallLog: 'nope' }));
  assert.doesNotThrow(() =>
    cc.scanUnbackedClaims({ finalResponse: CERTAINTY_REPLY, conversationMessages: 'nope' })
  );
  assert.strictEqual(cc.scanUnbackedClaims(null).findings.length, 0);
  assert.doesNotThrow(() => cc.observe({ env: null }));
});

test('observe: disabled → null; enabled → frozen report with stage', () => {
  assert.strictEqual(cc.observe({ finalResponse: CERTAINTY_REPLY, env: { KHY_CONFIDENCE_CALIBRATION: '0' } }), null);
  const rep = cc.observe({ finalResponse: CERTAINTY_REPLY, toolCallLog: [], env: {} });
  assert.ok(rep && rep.enabled === true);
  assert.strictEqual(rep.stage, 'S1');
  assert.ok(rep.findings.length > 0);
  assert.throws(() => {
    rep.enabled = false;
  }, 'report frozen');
});

// ── ⑦ ledger ──────────────────────────────────────────────────────────────
test('ledger: only finding rows are recorded, without reply text (no sensitive payload)', () => {
  const target = path.join(
    os.tmpdir(),
    `khy-confidence-ledger-${process.pid}-${Date.now()}.jsonl`
  );
  const env = { KHY_CONFIDENCE_LEDGER_FILE: target };
  const SENTINEL = 'SENTINEL-REPLY-TEXT-DO-NOT-LEAK';
  try {
    // 无 finding → 不落账,不建文件
    assert.strictEqual(ledger.recordObservation({ findings: [] }, { env }), false);
    assert.strictEqual(fs.existsSync(target), false, 'no file for empty report');

    const rep = cc.observe({
      finalResponse: `${CERTAINTY_REPLY}${SENTINEL}`,
      toolCallLog: [],
      env: {},
    });
    assert.ok(rep.findings.length > 0);
    assert.strictEqual(ledger.recordObservation(rep, { env }), true);

    const rows = ledger.readObservations({ env });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].stage, 'S1');
    assert.strictEqual(rows[0].toolCalls, 0);
    assert.strictEqual(rows[0].priorToolActivity, false);
    assert.ok(Array.isArray(rows[0].findings) && rows[0].findings.length > 0);
    assert.ok(rows[0].findings.some((f) => f.kind === 'unbacked_certainty'));
    const raw = fs.readFileSync(target, 'utf8');
    assert.ok(!raw.includes(SENTINEL), 'reply text must not be persisted');
  } finally {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

test('ledger: never throws on bad input; missing file reads []', () => {
  assert.strictEqual(ledger.recordObservation(null), false);
  assert.strictEqual(ledger.recordObservation(undefined), false);
  assert.strictEqual(ledger.recordObservation('nope'), false);
  assert.strictEqual(ledger.recordObservation({ findings: 'nope' }), false);
  const missing = path.join(os.tmpdir(), `khy-confidence-missing-${process.pid}.jsonl`);
  assert.deepStrictEqual(ledger.readObservations({ env: { KHY_CONFIDENCE_LEDGER_FILE: missing } }), []);
});

// ── ⑧ LIVE wiring(集成锁)────────────────────────────────────────────────
// ⚠ 以下 4 条 grep/登记锁在共享登记文件的 registryPatches 落地前会红 —— 这是刻意的:
// 它们就是「接线是否真发生」的机器判据,首绿即接线完成。删断言不许,接线才许。
test('wiring: flagRegistry registers KHY_CONFIDENCE_CALIBRATION', () => {
  const flags = require('../../src/utils/flagRegistry');
  const hit = flags.listFlags().find((f) => f.name === 'KHY_CONFIDENCE_CALIBRATION');
  assert.ok(hit, 'flag registered in FLAGS (CANON dialect)');
  assert.strictEqual(hit.mode, 'default-on');
  assert.strictEqual(hit.off, 'CANON');
});

test('wiring: selfProfile injects the calibration block (ON) and byte-reverts (OFF)', () => {
  const selfProfile = require('../../src/services/selfProfile');
  const marker = cc.CALIBRATION_MARKER;
  const prev = process.env.KHY_CONFIDENCE_CALIBRATION;
  // 不调 getFullProfile(全盘探测,数十秒);注入块只看 env,不依赖 profile 内容。
  const minimalProfile = { runtime: {}, identity: {} };
  try {
    delete process.env.KHY_CONFIDENCE_CALIBRATION;
    const on = selfProfile.formatForSystemPrompt(minimalProfile);
    assert.ok(on.includes(marker), 'gate-on system prompt carries the calibration block');
    process.env.KHY_CONFIDENCE_CALIBRATION = '0';
    const off = selfProfile.formatForSystemPrompt(minimalProfile);
    assert.ok(!off.includes(marker), 'gate-off system prompt has no calibration block');
    const block = cc.formatForSystemPrompt({ env: {} });
    assert.strictEqual(
      off,
      on.replace('\n\n' + block, ''),
      'gate-off output is byte-identical to gate-on minus the block (逐字节回退)'
    );
  } finally {
    if (prev === undefined) {
      delete process.env.KHY_CONFIDENCE_CALIBRATION;
    } else {
      process.env.KHY_CONFIDENCE_CALIBRATION = prev;
    }
  }
});

test('wiring: harness observation hook is attached (record-only, S1)', () => {
  const src = fs.readFileSync(
    path.join(BACKEND_ROOT, 'src/services/agenticHarnessService.js'),
    'utf8'
  );
  assert.ok(src.includes('confidenceCalibration'), 'harness requires the leaf');
  assert.ok(src.includes('recordObservation'), 'harness records to the ledger');
});

test('wiring: FEATURE-OWNERSHIP registers the mechanism at S1 with executor stage constant', () => {
  const p = path.join(REPO_ROOT, 'docs/10_规范/registry/FEATURE-OWNERSHIP.json');
  const reg = JSON.parse(fs.readFileSync(p, 'utf8'));
  const mech = ((reg.rollout && reg.rollout.mechanisms) || []).find(
    (m) => m.id === 'confidence-calibration'
  );
  assert.ok(mech, 'mechanism registered in rollout.mechanisms');
  assert.strictEqual(mech.stage, 'S1', 'starts as S1 observer (PROCESS-008)');
  assert.ok(String(mech.rollback || '').trim(), 'rollback action registered (PP-4)');
  assert.ok(mech.executorStage && mech.executorStage.file, 'executorStage file declared');
  assert.strictEqual(mech.executorStage.constant, 'KHY_CONFIDENCE_CALIBRATION_STAGE');
});

// ── ⑨ 行为级端到端(真跑到观察器;不是 grep 锁)──────────────────────────────
// 桩掉 toolUseLoop(唯一重依赖,harness 顶层解构),其余全走真实代码:harness.run 收尾
// 观察到 finding → 落台账 → 发 confidence_calibration 事件,且绝不改写回复。
test('behavior: harness run() reaches the S1 observer end-to-end (stubbed loop, real harness)', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cc-behavior-'));
  const ledgerFile = path.join(tmpRoot, 'confidence-observations.jsonl');
  const SENTINEL = 'SENTINEL-HARNESS-REPLY-DO-NOT-LEAK';
  const stubReply = CLAIM_REPLY + SENTINEL;

  const toolUseLoopPath = require.resolve(path.join(BACKEND_ROOT, 'src/services/toolUseLoop'));
  const hadEntry = Object.prototype.hasOwnProperty.call(require.cache, toolUseLoopPath);
  const savedEntry = require.cache[toolUseLoopPath];
  const envPrev = {
    KHY_DATA_HOME: process.env.KHY_DATA_HOME,
    KHY_CONFIDENCE_LEDGER_FILE: process.env.KHY_CONFIDENCE_LEDGER_FILE,
    KHY_CONFIDENCE_CALIBRATION: process.env.KHY_CONFIDENCE_CALIBRATION,
    KHY_AUTO_DECOMPOSE: process.env.KHY_AUTO_DECOMPOSE,
    KHY_DELIVERY_GATE_REPORT: process.env.KHY_DELIVERY_GATE_REPORT,
    KHY_BOULDER_RESUME: process.env.KHY_BOULDER_RESUME,
    KHY_CROSS_MODEL_VERIFY: process.env.KHY_CROSS_MODEL_VERIFY,
  };

  require.cache[toolUseLoopPath] = {
    id: toolUseLoopPath,
    filename: toolUseLoopPath,
    loaded: true,
    exports: {
      runToolUseLoop: async () => ({
        finalResponse: stubReply,
        toolCallLog: [],
        iterations: 1,
        conversationMessages: [],
      }),
      _isComplexTask: () => ({ isComplex: false }),
    },
  };
  process.env.KHY_DATA_HOME = tmpRoot;
  process.env.KHY_CONFIDENCE_LEDGER_FILE = ledgerFile;
  delete process.env.KHY_CONFIDENCE_CALIBRATION;
  process.env.KHY_AUTO_DECOMPOSE = '0';
  process.env.KHY_DELIVERY_GATE_REPORT = '0';
  process.env.KHY_BOULDER_RESUME = '0';
  process.env.KHY_CROSS_MODEL_VERIFY = '0';

  try {
    const { createAgenticHarness } = require(path.join(BACKEND_ROOT, 'src/services/agenticHarnessService'));
    const harness = createAgenticHarness();
    const events = [];
    const res = await harness.run({
      userMessage: '端口冲突怎么排查',
      chat: async () => ({ reply: 'stub — the loop is stubbed, chat is never called' }),
      cwd: tmpRoot,
      onEvent: (e) => events.push(e && e.type),
    });

    assert.ok(
      String(res && res.finalResponse || '').includes(CLAIM_REPLY),
      'observer must not rewrite the reply'
    );
    assert.ok(
      events.includes('confidence_calibration'),
      `confidence_calibration event emitted (got: ${events.join(',')})`
    );
    const rows = ledger.readObservations({ env: { KHY_CONFIDENCE_LEDGER_FILE: ledgerFile } });
    assert.strictEqual(rows.length, 1, 'one observation row recorded');
    assert.strictEqual(rows[0].stage, 'S1');
    assert.strictEqual(rows[0].toolCalls, 0);
    assert.ok(
      rows[0].findings.some((f) => f.kind === 'unbacked_verification_claim'),
      'unbacked_verification_claim recorded by the real harness seam'
    );
    const raw = fs.readFileSync(ledgerFile, 'utf8');
    assert.ok(!raw.includes(SENTINEL), 'reply text must not be persisted (end-to-end)');

    // 门控关 → 同一路径不扫描、不落账、不发事件(接缝回退)
    fs.rmSync(ledgerFile, { force: true });
    process.env.KHY_CONFIDENCE_CALIBRATION = '0';
    const eventsOff = [];
    await harness.run({
      userMessage: '端口冲突怎么排查',
      chat: async () => ({ reply: 'stub' }),
      cwd: tmpRoot,
      onEvent: (e) => eventsOff.push(e && e.type),
    });
    assert.ok(!eventsOff.includes('confidence_calibration'), 'gate off → no event');
    assert.ok(!fs.existsSync(ledgerFile), 'gate off → nothing recorded');
  } finally {
    delete process.env.KHY_CONFIDENCE_CALIBRATION;
    for (const k of Object.keys(envPrev)) {
      if (envPrev[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = envPrev[k];
      }
    }
    if (hadEntry) {
      require.cache[toolUseLoopPath] = savedEntry;
    } else {
      delete require.cache[toolUseLoopPath];
    }
    // 真实 harness 的异步日志(如 <dataHome>/logs/active)可能在测试结束后仍有排队的写入,
    // 立即删除临时目录会以 ENOENT 变成 uncaughtException;改在进程退出时清理该目录。
    process.on('exit', () => {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    });
  }
});
