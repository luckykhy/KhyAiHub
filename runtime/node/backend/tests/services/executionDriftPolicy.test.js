'use strict';

/**
 * executionDriftPolicy — 执行漂移读数的守卫测试。
 *
 * 缺口：跑偏只有撞上 max-iterations 才暴露。本叶子在轮首/收尾给出确定性读数，
 * S1 只记录（写 toolLoopJournal 的 exec-drift 事件），不改控制流。
 *
 * Invariants:
 *   ① 门控 KHY_EXEC_DRIFT 默认开；0/false/off/no → 关（两个观察函数都 observed:false）
 *   ② 锚点提取只认路径/命令/反引号符号名；提取不到 → 不观察
 *   ③ anchor-unused 需要连续 N 轮没碰锚点；中间任一轮碰到就不记
 *   ④ plan-unfinished / acceptance-skipped / unverified-completion 各按确定性判据
 *   ⑤ goal 模式下 unverified-completion 跳过（goalStopGate 已经管）
 *   ⑥ 任意脏输入绝不抛
 *   ⑦ LIVE 接线：toolUseLoopCore 引用本叶子并写 exec-drift；flagRegistry 登记门控
 *
 * node:test 套件（jest.config 忽略 node:test；由 node --test 执行）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const policy = require('../../src/services/tool/executionDriftPolicy');

const BACKEND_ROOT = path.resolve(__dirname, '../../');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '../../..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

const call = (iteration, tool, params) => ({ iteration, tool, params, result: { success: true } });

test('① 门控：默认开；显式 0/false/off/no 关后两个观察函数都不产出', () => {
  assert.equal(policy.isEnabled({}), true);
  assert.equal(policy.isEnabled({ KHY_EXEC_DRIFT: '0' }), false);
  assert.equal(policy.isEnabled({ KHY_EXEC_DRIFT: 'OFF' }), false);
  assert.equal(policy.isEnabled({ KHY_EXEC_DRIFT: '1' }), true);

  const input = {
    userMessage: '改 `src/host/index.ts`',
    toolCallLog: [call(1, 'read_file', { path: 'a.ts' }), call(2, 'read_file', { path: 'b.ts' }), call(3, 'read_file', { path: 'c.ts' })],
  };
  assert.equal(policy.observeRound(input, { env: { KHY_EXEC_DRIFT: '0' } }).observed, false);
  assert.equal(policy.observeConclusion({ draft: '已完成' }, { env: { KHY_EXEC_DRIFT: 'no' } }).observed, false);
});

test('② 锚点提取：路径/命令/驼峰符号；and/or 不是路径；否定句里的命令不算；无锚点不观察', () => {
  const a = policy.buildAnchors('改 `src/host/index.ts`，跑 `npm run check:layout`，注意 `useToolTurn` 的归属');
  assert.ok(a.paths.includes('src/host/index.ts'));
  assert.ok(a.commands.includes('npm run check:layout'));
  assert.ok(a.identifiers.includes('useToolTurn'));

  const b = policy.buildAnchors('A and/or B，没有具体文件');
  assert.deepEqual(b.paths, []);

  // 否定句里的命令不是验收命令；否则「别跑 npm test」会让 acceptance-skipped 永远误报。
  const negated = policy.buildAnchors('别跑 `npm test`\n不要 `npm run build`');
  assert.deepEqual(negated.commands, []);
  const mixed = policy.buildAnchors('先别管，改完跑 `npm test`');
  assert.deepEqual(mixed.commands, ['npm test']);

  const none = policy.observeRound({ userMessage: '把那个东西弄一下', toolCallLog: [] }, { env: {} });
  assert.equal(none.observed, false);
});

test('③ anchor-unused：连续 3 轮没碰锚点才记；中间碰到过就不记；不足 3 轮不记', () => {
  const userMessage = '改 `src/host/index.ts`';
  const untouched = [
    call(1, 'web_search', { query: 'x' }),
    call(2, 'web_search', { query: 'y' }),
    call(3, 'web_search', { query: 'z' }),
  ];
  const hit = policy.observeRound({ userMessage, toolCallLog: untouched }, { env: {} });
  assert.equal(hit.observed, true);
  assert.equal(hit.findings[0].code, 'anchor-unused');
  assert.deepEqual(hit.findings[0].evidence.rounds, [1, 2, 3]);
  assert.equal(hit.findings[0].evidence.lastHitRound, null);

  const touched = [untouched[0], call(2, 'read_file', { path: 'src/host/index.ts' }), untouched[2]];
  assert.equal(policy.observeRound({ userMessage, toolCallLog: touched }, { env: {} }).observed, false);

  const short = [untouched[0], untouched[1]];
  assert.equal(policy.observeRound({ userMessage, toolCallLog: short }, { env: {} }).observed, false);

  // 边沿触发：第 4 轮不该把同一次漂移再记一遍。
  const fourClean = [...untouched, call(4, 'web_search', { query: 'w' })];
  assert.equal(policy.observeRound({ userMessage, toolCallLog: fourClean }, { env: {} }).observed, false);

  // 轮号守卫：第 6 轮开跑时日志最后一轮还是 4（第 5 轮纯文本被 nudge 顶回）→ 不重记。
  assert.equal(
    policy.observeRound({ userMessage, toolCallLog: fourClean, iteration: 6 }, { env: {} }).observed,
    false
  );
  assert.equal(
    policy.observeRound({ userMessage, toolCallLog: untouched, iteration: 4 }, { env: {} }).observed,
    true
  );

  // 漂移中途出现过锚点、之后又连续 3 轮脱离 → 新的一段漂移，重新记。
  const resumedDrift = [
    ...untouched,
    call(4, 'read_file', { path: 'src/host/index.ts' }),
    call(5, 'web_search', { query: 'm' }),
    call(6, 'web_search', { query: 'n' }),
    call(7, 'web_search', { query: 'o' }),
  ];
  assert.equal(policy.observeRound({ userMessage, toolCallLog: resumedDrift }, { env: {} }).observed, true);
});

test('④a plan-unfinished：计划还有未完成步骤 → 记；全完成/单步计划 → 不记', () => {
  const plan = {
    steps: [
      { id: 1, description: '读文件', status: 'completed' },
      { id: 2, description: '改文件', status: 'pending' },
    ],
  };
  const r = policy.observeConclusion({ userMessage: 'x', toolCallLog: [call(1, 'read_file', {})], plan, draft: '' }, { env: {} });
  assert.equal(r.observed, true);
  assert.equal(r.findings[0].code, 'plan-unfinished');
  assert.equal(r.findings[0].evidence.pending[0].id, 2);

  const done = { steps: plan.steps.map((s) => ({ ...s, status: 'completed' })) };
  assert.equal(policy.observeConclusion({ userMessage: 'x', toolCallLog: [], plan: done, draft: '' }, { env: {} }).observed, false);

  const single = { steps: [{ id: 1, description: '一步', status: 'pending' }] };
  assert.equal(policy.observeConclusion({ userMessage: 'x', toolCallLog: [], plan: single, draft: '' }, { env: {} }).observed, false);
});

test('④b acceptance-skipped：点名命令没跑 → 记；跑过（含前缀命中）→ 不记', () => {
  const userMessage = '先跑 `npm run check:layout` 再改';
  const r = policy.observeConclusion(
    { userMessage, toolCallLog: [call(1, 'read_file', { path: 'a.ts' })], draft: '' },
    { env: {} }
  );
  assert.equal(r.observed, true);
  assert.equal(r.findings[0].code, 'acceptance-skipped');
  assert.deepEqual(r.findings[0].evidence.commands, ['npm run check:layout']);

  const ran = [call(1, 'bash', { command: 'npm run check:layout' })];
  assert.equal(policy.observeConclusion({ userMessage, toolCallLog: ran, draft: '' }, { env: {} }).observed, false);
});

test('④c unverified-completion：零工具 + 完成词 → 记；否定句不记；goal 模式跳过', () => {
  const zeroTools = policy.observeConclusion({ userMessage: 'x', toolCallLog: [], draft: '已修复，问题解决了' }, { env: {} });
  assert.equal(zeroTools.observed, true);
  assert.equal(zeroTools.findings[0].code, 'unverified-completion');
  assert.equal(zeroTools.findings[0].evidence.reason, 'zero-tool-calls');

  const negated = policy.observeConclusion({ userMessage: 'x', toolCallLog: [], draft: '还没完成，测试未通过' }, { env: {} });
  assert.equal(negated.observed, false);

  const goal = policy.observeConclusion({ userMessage: 'x', toolCallLog: [], draft: '已完成', hasGoal: true }, { env: {} });
  assert.equal(goal.observed, false);
});

test('④d unverified-completion：声称测试通过但没跑验证命令 → 记；跑过 node --test → 不记', () => {
  const editOnly = [call(1, 'edit_file', { path: 'a.ts' })];
  const r = policy.observeConclusion(
    { userMessage: 'x', toolCallLog: editOnly, draft: '测试通过，全部完成' },
    { env: {} }
  );
  assert.equal(r.observed, true);
  assert.equal(r.findings[0].evidence.reason, 'claim-without-verification-call');

  const verified = [call(1, 'edit_file', { path: 'a.ts' }), call(2, 'bash', { command: 'node --test tests/x.test.js' })];
  const ok = policy.observeConclusion({ userMessage: 'x', toolCallLog: verified, draft: '测试通过，全部完成' }, { env: {} });
  assert.equal(ok.observed, false);
});

test('⑥ 脏输入绝不抛', () => {
  assert.doesNotThrow(() => policy.buildAnchors(null));
  assert.doesNotThrow(() => policy.observeRound(null, null));
  assert.doesNotThrow(() => policy.observeRound({ toolCallLog: 'not-an-array' }, { env: {} }));
  assert.doesNotThrow(() => policy.observeConclusion({ plan: { steps: [null, undefined] }, toolCallLog: [null], draft: 42 }, { env: {} }));
});

test('⑦ LIVE 接线：循环引用本叶子并写 exec-drift；flagRegistry 登记门控', () => {
  const core = read('runtime/node/backend/src/services/tool/toolUseLoopCore.js');
  assert.ok(core.includes("require('./executionDriftPolicy')"), 'toolUseLoopCore 必须引用 executionDriftPolicy');
  assert.ok(core.includes("event: 'exec-drift'"), 'toolUseLoopCore 必须写 exec-drift 事件');
  assert.ok(core.includes('observeRound('), '轮首必须调用 observeRound');
  assert.ok(core.includes('observeConclusion('), '收尾必须调用 observeConclusion');

  const reg = read('runtime/node/backend/src/utils/flagRegistry/index.js');
  assert.ok(reg.includes('KHY_EXEC_DRIFT'), 'flagRegistry 必须登记 KHY_EXEC_DRIFT');
});
