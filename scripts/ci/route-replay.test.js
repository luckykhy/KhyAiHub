'use strict';

/**
 * route-replay 的自证测试。
 *
 * 重点不是「能跑出数字」，而是**它在没有证据时必须拒绝说「通过」**。
 * 这个工具是 §10 全部毕业判据的唯一载体；它一旦空跑报绿，四档的升档裁决
 * 就会建立在一堆连不上号的样本上 —— 而那正是 [DESIGN-ARCH-162] 卡住的地方。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// 本文件与工具同在 scripts/ci/ —— 用 __dirname 直接锚定，不数 ../ 的层数。
// （数层数这件事在本次落地里已经错过三次，每次都表现为「路径落空被 fail-soft 吞掉」。）
const TOOL = path.join(__dirname, 'route-replay.js');
const REPO = path.resolve(__dirname, '..', '..');

function _run(args) {
  // execFileSync 吞 stderr；本工具全部输出走 stdout，故不额外重定向。
  return execFileSync(process.execPath, [TOOL, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 30000,
  });
}

function _fixture(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-replay-'));
  const file = path.join(dir, 'auto-route.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

test('工具存在且可跑（空账本不许报绿）', () => {
  assert.ok(fs.existsSync(TOOL), 'route-replay.js 不存在');
  const empty = _fixture([]);
  const out = _run(['--file', empty]);
  assert.match(out, /判据（A2\/A5\/A6\/A9\/A10）不可执行|不可执行/);
  assert.doesNotMatch(out, /无 GAP/, '空样本绝不能被判成「无 GAP」');
  assert.match(out, /GAP/);
});

test('按 turnId 正确 join，并把 v0 无 key 样本单列', () => {
  const file = _fixture([
    { ev: 'select', at: 1, legacy: { adapter: 'api', model: 'z' }, rec: { tier: 'T1' } },
    {
      ev: 'select', v: 1, pid: '9', turnId: '9:s:1', mode: 'economy',
      legacy: { adapter: 'api', model: 'a' }, rec: { adapter: 'api', model: 'a', tier: 'T2' },
      demand: { tier: 'T2', demand: 0.3, flags: [] },
    },
    {
      ev: 'outcome', v: 1, pid: '9', turnId: '9:s:1', ok: true, mode: 'economy',
      picked: { adapter: 'api', model: 'a' }, priceState: 'priced', costUSD: 0.0042,
    },
    {
      ev: 'select', v: 1, pid: '9', turnId: '9:s:2', mode: 'extreme',
      legacy: { adapter: 'api', model: 'b' }, rec: { adapter: 'api', model: 'b', tier: 'T0' },
    },
    {
      ev: 'outcome', v: 1, pid: '9', turnId: '9:s:2', ok: false, mode: 'extreme',
      picked: { adapter: 'api', model: 'b' }, priceState: 'unknown', costUSD: null,
    },
  ]);
  const out = _run(['--file', file]);
  assert.match(out, /无 turnId 1/, '旧格式样本必须被单独数出来，不许混进 join');
  assert.match(out, /可 join 2/);
  assert.match(out, /mode=economy: n=1 ok=1 fail=0/);
  assert.match(out, /mode=extreme: n=1 ok=0 fail=1/);
  // 成本只统计 priced：unknown 当 0 会虚增省钱幅度
  assert.match(out, /priced 轮 1, 价格不可知轮 1/);
  assert.match(out, /合计 0\.00420/);
});

test('A9 退化基线缺样本时必须报 GAP，不许静默省略', () => {
  const file = _fixture([
    {
      ev: 'select', v: 1, pid: '9', turnId: '9:s:1', mode: 'auto',
      rec: { tier: 'T1' }, legacy: { adapter: 'api', model: 'a' },
    },
    { ev: 'outcome', v: 1, pid: '9', turnId: '9:s:1', ok: true, priceState: 'priced', costUSD: 0.01 },
  ]);
  const out = _run(['--file', file]);
  assert.match(out, /A9 退化基线不完整/);
});

test('--require-samples 未达标时报出来（毕业判据不可被静默绕过）', () => {
  const file = _fixture([
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:1', rec: { tier: 'T1' }, legacy: {} },
    { ev: 'outcome', v: 1, pid: '9', turnId: '9:s:1', ok: true, priceState: 'priced', costUSD: 0.01 },
  ]);
  const out = _run(['--file', file, '--require-samples', '200']);
  assert.match(out, /--require-samples=200 未达标（实际 1）/);
});

// 上一行只写了空格形态，于是 `--require-samples=200` 这种写法被静默忽略、回落成 0，
// 阈值从未设上而套件全绿。文档 §11/A2 与 §21 给的恰恰是 `=` 形态。
test('--require-samples 的两种拼写都必须真的生效，且达标时那行必须消失', () => {
  const file = _fixture([
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:1', rec: { tier: 'T1' }, legacy: {} },
    { ev: 'outcome', v: 1, pid: '9', turnId: '9:s:1', ok: true, priceState: 'priced', costUSD: 0.01 },
  ]);
  const eq = _run(['--file', file, '--require-samples=200']);
  assert.match(eq, /--require-samples=200 未达标（实际 1）/, '= 形态被忽略 ⇒ 阈值形同未设');
  const satisfied = _run(['--file', file, '--require-samples=1']);
  assert.doesNotMatch(satisfied, /未达标（实际 1）/, '达标却仍报未达标 ⇒ 这条判据恒真，上面那句断言是空话');
});

test('S1 语义：GAP 存在时默认仍不阻断，--strict 才非零退出', () => {
  const empty = _fixture([]);
  // 默认档：exit 0（PROCESS-008 PP-3，S1 不许拦主流程）
  _run(['--file', empty]);
  let rc = 0;
  try {
    _run(['--file', empty, '--strict']);
  } catch (e) {
    rc = e.status;
  }
  assert.strictEqual(rc, 1, '--strict 下 GAP 必须变成非零退出，否则它只是个装饰');
});

test('软失败计数不是恒 0（§5.6 的写入端与统计端必须连得上）', () => {
  const file = _fixture([
    {
      ev: 'select', v: 1, pid: '9', turnId: '9:s:1', mode: 'perf', softFail: '档位卡解析失败',
      rec: { tier: 'T1' }, legacy: {},
    },
    { ev: 'outcome', v: 1, pid: '9', turnId: '9:s:1', ok: true, priceState: 'priced', costUSD: 0.01 },
    {
      ev: 'select', v: 1, pid: '9', turnId: '9:s:2', mode: 'perf', softFail: null,
      rec: { tier: 'T1' }, legacy: {},
    },
    { ev: 'outcome', v: 1, pid: '9', turnId: '9:s:2', ok: true, priceState: 'priced', costUSD: 0.01 },
  ]);
  const out = _run(['--file', file]);
  assert.match(out, /软失败 1｜/, `统计没接到写入端:\n${out}`);
});

test('坏行不炸，且被数出来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-replay-bad-'));
  const file = path.join(dir, 'x.jsonl');
  fs.writeFileSync(file, '{"ev":"select","v":1,"turnId":"a"}\n{not json\n\n', 'utf8');
  const out = _run(['--file', file]);
  assert.match(out, /坏行 1/);
});

// §15-2 的**读数侧**。写手落 `stateInputs` 之后我差点就此收工 ——
// 但「让人看得见」这句话的主语是 replay，不是 jsonl。replay 不读它，覆盖度就永远不出现在任何报表里。
function _siRow(n, stateInputs) {
  const turn = `7:s:${n}`;
  const sel = {
    ev: 'select', v: 1, pid: '7', turnId: turn, mode: 'auto',
    legacy: { adapter: 'api', model: `m${n}` }, rec: { adapter: 'api', model: `m${n}`, tier: 'T2' },
    demand: { tier: 'T2', demand: 0.3, flags: [] },
  };
  if (stateInputs !== undefined) sel.demand.stateInputs = stateInputs;
  return [
    sel,
    { ev: 'outcome', v: 1, pid: '7', turnId: turn, ok: true, picked: { adapter: 'api', model: `m${n}`, tier: 'T2' } },
  ];
}

test('§15-2 覆盖度：有执行状态 / 只有主诉 / 字段缺席 三格分开，且缺席时报 GAP 不报绿', () => {
  const mixed = _run([
    '--file',
    _fixture([
      ..._siRow(1, { present: ['ctxRatio', 'toolFails'], absent: ['hasImage'], queryOnly: false }),
      ..._siRow(2, { present: ['estCtxTokens'], absent: ['ctxRatio', 'toolFails'], queryOnly: true }),
    ]),
  ]);
  assert.match(mixed, /执行状态覆盖（仅可 join 轮，分母 2）: 有执行状态 1｜只有主诉 1｜字段缺席 0/);
  assert.doesNotMatch(mixed, /§15-2 违反中|§15-2 不可判定/, '确实有带执行状态的轮次时不该报这两条 GAP');

  // 全是 query-only ⇒ 必须点名「四道 pass 实际就是 query-only」
  const allBare = _run([
    '--file',
    _fixture([
      ..._siRow(1, { present: [], absent: ['ctxRatio', 'estCtxTokens', 'toolFails'], queryOnly: true }),
      ..._siRow(2, { present: [], absent: ['ctxRatio', 'estCtxTokens', 'toolFails'], queryOnly: true }),
    ]),
  ]);
  assert.match(allBare, /§15-2 违反中：2 行全部只有主诉/);

  // 字段整体缺席（P3 接线前的老样本）⇒ 是「不可判定」，不是「0 覆盖」也不是「无问题」
  const legacy = _run(['--file', _fixture([..._siRow(1, undefined), ..._siRow(2, undefined)])]);
  assert.match(legacy, /字段缺席 2/);
  assert.match(legacy, /§15-2 不可判定：2 行全都缺 stateInputs/);
  assert.doesNotMatch(legacy, /§15-2 违反中/, '没测过不得被写成「违反」—— 那是把仪器缺口当成功能结论');
});

// §8-⑦ 的**读数侧**，与上面同一件事：写手把 `capability` 落进样本白名单只算接了一半。
// 没有这一段，「能力门槛有没有在真实流量上触发过」这个问题在报表上永远是空的，
// 而升档（S1→S2）要的样本量恰恰只能从这张报表里取。
function _capRow(n, capability) {
  const pair = _siRow(n, { present: ['ctxRatio'], absent: ['hasImage'], queryOnly: false });
  if (capability !== '__absent__') pair[0].capability = capability;
  return pair;
}

test('§8-⑦ 能力门槛读数：要求／报挡／淘汰／未知／无要求／缺席 六格分开，全缺席时报 GAP', () => {
  const out = _run([
    '--file',
    _fixture([
      ..._capRow(1, { required: 'vision', blocked: 'vision', dropped: 1, unknown: 0, kept: 0 }),
      ..._capRow(2, { required: 'vision', blocked: null, dropped: 0, unknown: 2, kept: 1 }),
      ..._capRow(3, null),
      ..._capRow(4, '__absent__'),
    ]),
  ]);
  assert.match(
    out,
    /能力门槛（全部 select 行，分母 4）: 有能力要求 2｜其中报挡 1｜淘汰候选 1｜能力未知仍保留 2｜本轮无要求 1｜字段缺席 1/,
    `六格读数没接上:\n${out}`
  );
  assert.doesNotMatch(out, /§8-⑦ 不可判定/, '样本里确实有 capability 时不该报「不可判定」');

  const allAbsent = _run(['--file', _fixture([..._capRow(1, '__absent__'), ..._capRow(2, '__absent__')])]);
  assert.match(
    allAbsent,
    /§8-⑦ 不可判定：2 行 select 全无 capability 字段/,
    `字段整体缺席必须报「不可判定」而不是「0 次触发」:\n${allAbsent}`
  );
});

test('分母解释权和它自己的构成一起印：真账本是 24 行全 failure，「可 join 0」得说实话', () => {
  const out = _run([
    '--file',
    _fixture([
      { ev: 'failure', v: 1, pid: '3', turnId: null, adapter: 'api', reason: 'x' },
      { ev: 'failure', v: 1, pid: '3', turnId: null, adapter: 'api', reason: 'y' },
      ..._capRow(1, null),
    ]),
  ]);
  assert.match(out, /ev 构成 \{"failure":2,"select":1,"outcome":1\}/, `没印 ev 构成:\n${out}`);
});

test('§5.4 strongShare：目标占比与实测占比必须同时印出（目标无实测=愿望）', () => {
  const rows = [];
  // perf：4 轮，tier 各一 ⇒ 实测强档占比 0.50，与目标 0.5 相合
  ['T0', 'T1', 'T2', 'T3'].forEach((tier, i) => {
    const turn = `7:s:${i + 1}`;
    rows.push({
      ev: 'select', v: 1, pid: '7', turnId: turn, mode: 'perf', strongTarget: 0.5,
      legacy: {}, rec: { adapter: 'api', model: `m${i}`, tier },
      demand: { tier, stateInputs: { queryOnly: false } },
    });
    rows.push({ ev: 'outcome', v: 1, pid: '7', turnId: turn, ok: true, picked: { tier } });
  });
  // auto：目标 null ⇒ 必须说「目标未设」，不能被读成「目标 0」
  rows.push({
    ev: 'select', v: 1, pid: '7', turnId: '7:s:9', mode: 'auto', strongTarget: null,
    legacy: {}, rec: { adapter: 'api', model: 'm9', tier: 'T0' }, demand: null,
  });
  rows.push({ ev: 'outcome', v: 1, pid: '7', turnId: '7:s:9', ok: true, picked: { tier: 'T0' } });

  const out = _run(['--file', _fixture(rows)]);
  assert.match(
    out,
    /mode=perf:.*强档占比 实测 0\.50 目标 0\.50｜差 \+?0\.00/,
    `目标与实测没同时印出:\n${out}`
  );
  assert.match(out, /mode=auto:.*强档占比 实测 1\.00 目标未设\(auto 档如此\)/, `null 目标被当成 0:\n${out}`);
});

// 失败观测此前是「join 结构里收了 t.failures，全报表零消费方」——
// 与本方案反复打的那一类（写进样本没人读）是同一个病，这次轮到 replay 自己。
test('失败观测分两格报：可归属轮次的 与 无 turnId 的（只报任一格都会说反话）', () => {
  const pair = _capRow(1, null);
  const attached = { ev: 'failure', v: 1, pid: '7', turnId: '7:s:1', adapter: 'api', errorType: 'auth' };
  const out = _run([
    '--file',
    _fixture([
      ...pair,
      attached,
      { ev: 'failure', v: 1, pid: '3', turnId: null, adapter: 'api', errorType: 'rate_limit' },
    ]),
  ]);
  assert.match(
    out,
    /失败观测 2 行（可归属轮次 1｜无 turnId 1）｜归因 \{"auth":1,"rate_limit":1\}/,
    `两格没分开:\n${out}`
  );
});

// §5.2 的 β 载体读数。`thinkingFloor` 的唯一消费者只在 `reasoning_effort==='auto'` 的请求上跑，
// 而全仓没有生产方把 effort 设成 'auto' —— 于是「极致档多花思考」在真实流量上是纸面承诺。
// 这一栏的存在就是让这句话变成**可数的**，而不是靠下一个人重新审计。
function _betaRow(n, beta) {
  const pair = _capRow(n, null);
  if (beta !== '__absent__') pair[0].beta = beta;
  return pair;
}

test('β 载体四格分开，且「声明了却全无载体」必须自己说出来', () => {
  const mixed = _run([
    '--file',
    _fixture([
      ..._betaRow(1, { declared: 'max', carried: false }),
      ..._betaRow(2, { declared: 'high', carried: true }),
      ..._betaRow(3, { declared: 'auto', carried: false }),
      ..._betaRow(4, '__absent__'),
    ]),
  ]);
  assert.match(
    mixed,
    /β 载体（全部 select 行）: 档位声明具体思考档 2｜请求带 reasoning_effort=auto 1｜无载体 1｜字段缺席 1/,
    `四格没分开:\n${mixed}`
  );
  assert.doesNotMatch(mixed, /β 目前是纸面 dial/, '有载体在场的样本时不该下这个结论');

  const blind = _run([
    '--file',
    _fixture([..._betaRow(1, { declared: 'max', carried: false }), ..._betaRow(2, { declared: 'low', carried: false })]),
  ]);
  assert.match(
    blind,
    /⚠ 档位想要思考预算的 2 行\*\*全部没有载体\*\* ⇒ §5\.2 的 β 目前是纸面 dial/,
    `全无载体时不许沉默:\n${blind}`
  );
});

// A5「跨档切换次数如实上报」此前**没有读数**，而 §11 的 A5 命令写的 `--batch` 这个开关
// 本工具从来没有（grep -c batch = 0）。粘滞是刻意不做的（卡内 stickyTier.enabled=false），
// 所以这一栏只报数不判定 —— 切换多是事实，不是缺陷断言。
test('margin 三格分开，且「低于卡内阈值」由卡给数而不是脚本里抄一个', () => {
  const file = _fixture([
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:1', margin: 0.03, rec: { tier: 'T1' }, legacy: {} },
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:2', margin: 0.5, rec: { tier: 'T1' }, legacy: {} },
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:3', margin: null, rec: { tier: 'T2' }, legacy: {} },
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:4', rec: { tier: 'T2' }, legacy: {} },
  ]);
  const out = _run(['--file', file]);
  assert.match(out, /margin 分布（全部 select 行 4）: 有差值 2/);
  assert.match(out, /值为 null（离散排序，无差值）1/);
  assert.match(out, /字段缺席 1/);
  // 阈值来自档位卡（实测 thresholds.marginUpgrade=0.1）；0.03<0.1 应计入 low
  assert.match(out, /marginUpgrade=0\.1 的 1 轮/);
  assert.doesNotMatch(out, /margin 无一可用/, '有两条可用差值却报「无实测输入」⇒ 这一行是恒真的告警');
});

test('margin 全不可用时必须自己说出来（否则 D3 会被读成「都不低，不用升档」）', () => {
  const file = _fixture([
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:1', margin: null, rec: { tier: 'T1' }, legacy: {} },
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:2', rec: { tier: 'T1' }, legacy: {} },
  ]);
  const out = _run(['--file', file]);
  assert.match(out, /有差值 0/);
  assert.match(out, /⚠ margin 无一可用/);
});

test('升档触发器按卡内名册逐条报命中（总数说不了话）', () => {
  const file = _fixture([
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:1', margin: 0.03, escalateReason: 'lowMargin', rec: { tier: 'T1' }, legacy: {} },
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:2', escalateReason: 'underRoutingSafety', rec: { tier: 'T2' }, legacy: {} },
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:3', escalateReason: null, rec: { tier: 'T2' }, legacy: {} },
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:4', rec: { tier: 'T3' }, legacy: {} },
  ]);
  const out = _run(['--file', file]);
  assert.match(out, /升档触发器命中（名册来自档位卡 escalateOn，共 4 个声明）: lowMargin 1｜underRoutingSafety 1｜verifyFailed 0｜irreversibleWrite 0/);
  assert.match(out, /原因字段缺席 1/);
  assert.doesNotMatch(out, /个触发器在 \d+ 条 select 行上\*\*零命中\*\*/, '有命中却报零命中 ⇒ 那句 ⚠ 是恒真的');
});

test('声明了却零命中时必须自己说出来（否则 0 会被读成「条件没满足」）', () => {
  const file = _fixture([
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:1', escalateReason: null, rec: { tier: 'T1' }, legacy: {} },
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:2', escalateReason: null, rec: { tier: 'T1' }, legacy: {} },
  ]);
  const out = _run(['--file', file]);
  assert.match(out, /lowMargin 0｜underRoutingSafety 0｜verifyFailed 0｜irreversibleWrite 0/);
  assert.match(out, /⚠ 卡里声明的 4 个触发器在 2 条 select 行上\*\*零命中\*\*/);
});

test('flag_rules 命中三格分开 + 命中/未命中的 ok 率与均价对照（卡里承诺的读数）', () => {
  const file = _fixture([
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:1', demand: { tier: 'T1', flags: ['heavy_context'] }, rec: { tier: 'T1' }, legacy: {} },
    { ev: 'outcome', v: 1, pid: '9', turnId: '9:s:1', ok: true, priceState: 'priced', costUSD: 0.02 },
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:2', demand: { tier: 'T1', flags: ['heavy_context'] }, rec: { tier: 'T1' }, legacy: {} },
    { ev: 'outcome', v: 1, pid: '9', turnId: '9:s:2', ok: true, priceState: 'priced', costUSD: 0.04 },
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:3', demand: { tier: 'T2', flags: [] }, rec: { tier: 'T2' }, legacy: {} },
    { ev: 'outcome', v: 1, pid: '9', turnId: '9:s:3', ok: false, priceState: 'priced', costUSD: 0.01 },
  ]);
  const out = _run(['--file', file]);
  assert.match(out, /flag_rules 命中（全部 select 行 3）: 命中 flag 2｜pass 已接入但零命中 1｜demand 块缺席 0｜Top heavy_context：2/);
  // 相关性对照：命中侧 2 轮全 ok、均价 0.03000；未命中侧 1 轮不 ok、均价 0.01000
  assert.match(out, /flag 相关性对照（仅可 join 轮，不是因果）: 命中 n=2 ok=100\.0% usd=0\.03000｜未命中 n=1 ok=0\.0% usd=0\.01000/);
  assert.doesNotMatch(out, /⚠ flag_rules 在/, '有命中却报零命中 ⇒ 那句 ⚠ 是恒真的');
});

test('pass 接入了却一轮都没命中 flag 时必须自己报警（漏判不能被读成「负载简单」）', () => {
  const file = _fixture([
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:1', demand: { tier: 'T2', flags: [] }, rec: { tier: 'T2' }, legacy: {} },
    { ev: 'select', v: 1, pid: '9', turnId: '9:s:2', demand: { tier: 'T2', flags: [] }, rec: { tier: 'T2' }, legacy: {} },
  ]);
  const out = _run(['--file', file]);
  assert.match(out, /命中 flag 0｜pass 已接入但零命中 2/);
  assert.match(out, /⚠ flag_rules 在 2 轮里零命中/);
});

test('A5 跨档切换：按会话分组数相邻轮次的 tier 变化（切换数、单会话最多、每轮切换率）', () => {
  const sel = (pid, sid, seq, tier) => ({
    ev: 'select', v: 1, pid, turnId: `${pid}:${sid}:${seq}`, mode: 'auto',
    legacy: {}, rec: { adapter: 'api', model: `m${seq}`, tier }, demand: null,
  });
  const rowsA = ['T1', 'T1', 'T0', 'T0', 'T1', 'T1'].map((t, i) => sel('7', 'sessA', i + 1, t));
  const rowsB = ['T2'].map((t, i) => sel('7', 'sessB', i + 1, t));
  const out = _run(['--file', _fixture([...rowsA, ...rowsB])]);
  assert.match(
    out,
    /跨档切换（A5，按会话分组，只报数不判定）: 会话 2｜轮次 7｜切换 2｜单会话最多 2｜每轮切换率 0\.286/,
    `切换读数没接上:\n${out}`
  );
});
