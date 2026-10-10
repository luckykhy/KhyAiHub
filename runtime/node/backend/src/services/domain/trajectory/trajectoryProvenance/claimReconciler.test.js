'use strict';

/**
 * claimReconciler.test.js — 钉死正文矛盾核对的词库面、族解析、fail-open 全体性与否定/点名联动。
 *
 * 为什么这支套件必须存在：本模块是「转发正文里的动作声称 vs 本地工具日志」的唯一确定性裁判，
 * 判据漂移的方向是**假阴性**（真声称被当成已验证 / 假声称被良性工具名吞掉），
 * 而它只在 producer != khy-local 时被调用，一旦放宽就无人兜底。词库版本号、族数量、
 * 名单长度这类「数一数就知道」的常量最容易被顺手改动而不被察觉，故逐条钉死。
 *
 * 实测更正（与注释/直觉不同处，按真实语义钉死，均已在用例外标注为「已注册」）：
 *   · `MENTION_TOOL_NAMES` 实测 **30** 项，不是 29。
 *   · `Object.freeze(CLAIM_FAMILIES)` 是**浅冻结**：数组不可换元素，但 6 个族对象与其中每个
 *     正则都可被就地改写（`CLAIM_FAMILIES[0].expectedTool = 'x'` 静默成功）。
 *   · `_familiesOf` 的 `toolNames` 正则**不锚定、按子串命中**，良性工具名会伪装成整族完成，
 *     从而吞掉真矛盾（安全相关假阴性，详见实测表用例）。
 *   · `write` 族 `shellCmd` 的重定向分支 `>\s*\S+` 因前置 `\b` 永不命中（`>` 非词字符）→ 死分支。
 *   · 点名核对的**正文侧**按名单逐字拼模式：prose 里写 `data_fetch` / `data fetch` 不被识别，
 *     而**已执行侧**做了分隔符归一 —— 注释宣称的「大小写/下划线/连字符不敏感」只对一半成立。
 *   · 名单里的写法别名（WebSearch 与 web_search、Bash 与 bash、PowerShell/powershell、
 *     WebFetch/web_fetch、todoWrite/todo_write）会让一次驼峰点名产出 **2 条**矛盾
 *     （蛇形条目的模式 `web[\s_-]*search` 连驼峰也吃）；反向写蛇形只报 1 条。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('./claimReconciler');
const leaf = require('./claimNegation');

const GUARD_ON = { env: {} }; // 注入空 env → 守卫恒为 ON，与运维者真实环境无关

/** 逐行铺开 6 族各一条非否定声称，用于间接测量 `_familiesOf`（它未被导出）。 */
const SIX_FAMILY_PROSE = [
  '删除了文件',
  '写入了文件',
  '修改了文件',
  '测试全部通过',
  '提交了代码',
  '已部署',
].join('\n');

/** 该日志条目满足了哪些 expectedTool（= 从 baseline 里消失的族）。 */
function familiesSatisfiedBy(entry, baseline) {
  const out = mod.reconcile(SIX_FAMILY_PROSE, [entry], GUARD_ON).contradictions;
  const stillThere = new Set(out.map((c) => c.expectedTool));
  return baseline.filter((t) => !stillThere.has(t));
}

function baselineSix() {
  const got = mod.reconcile(SIX_FAMILY_PROSE, [], GUARD_ON).contradictions.map((c) => c.expectedTool);
  return got;
}

// ── 导出面与词库常量 ──────────────────────────────────────────────────────────

test('恰导出 8 个符号且 LEXICON_VERSION === 1', () => {
  assert.deepStrictEqual(Object.keys(mod).sort(), [
    'CLAIM_FAMILIES',
    'LEXICON_VERSION',
    'MENTION_TOOL_NAMES',
    '_isNegatedClaim',
    '_isNegationGuardEnabled',
    '_isToolMentionGuardEnabled',
    'reconcile',
    'reconcileToolMentions',
  ]);
  assert.strictEqual(mod.LEXICON_VERSION, 1);
});

test('CLAIM_FAMILIES 恰 6 族，family/expectedTool 逐字面对', () => {
  assert.strictEqual(mod.CLAIM_FAMILIES.length, 6);
  assert.deepStrictEqual(
    mod.CLAIM_FAMILIES.map((f) => [f.family, f.expectedTool]),
    [
      ['delete', 'Delete'],
      ['write', 'Write'],
      ['edit', 'Edit'],
      ['test', 'test'],
      ['commit', 'git commit'],
      ['deploy', 'deploy'],
    ]
  );
  assert.deepStrictEqual(
    mod.CLAIM_FAMILIES.map((f) => f.family),
    ['delete', 'write', 'edit', 'test', 'commit', 'deploy'],
    '族顺序即矛盾产出顺序，不得重排'
  );
});

test('已注册：Object.freeze(CLAIM_FAMILIES) 只是浅冻结——数组不可换元素，族对象与正则仍可就地改写', () => {
  assert.ok(Object.isFrozen(mod.CLAIM_FAMILIES), '数组本身应被冻结');
  assert.ok(
    mod.CLAIM_FAMILIES.every((f) => !Object.isFrozen(f)),
    '实测：6 个族对象**未**被冻结，浅冻结不提供任何保护'
  );
  assert.ok(mod.CLAIM_FAMILIES.every((f) => !Object.isFrozen(f.claim)));
  // 就地改写会静默生效并立刻改变判定（不改源码，只在测试里复原）
  const victim = mod.CLAIM_FAMILIES[0];
  const prev = victim.expectedTool;
  try {
    victim.expectedTool = '__mutated__';
    assert.strictEqual(
      mod.reconcile('删除了文件', [], GUARD_ON).contradictions[0].expectedTool,
      '__mutated__'
    );
  } finally {
    victim.expectedTool = prev;
  }
  assert.strictEqual(mod.reconcile('删除了文件', [], GUARD_ON).contradictions[0].expectedTool, 'Delete');
});

test('MENTION_TOOL_NAMES 实测恰 30 项且数组被冻结（钉住真实计数，防止按注释的 29 被误改）', () => {
  assert.strictEqual(mod.MENTION_TOOL_NAMES.length, 30);
  assert.ok(Object.isFrozen(mod.MENTION_TOOL_NAMES));
  assert.ok(mod.MENTION_TOOL_NAMES.every((n) => typeof n === 'string'), '元素全是字符串');
  assert.deepStrictEqual(mod.MENTION_TOOL_NAMES.slice(0, 4), ['Write', 'WriteFile', 'Edit', 'MultiEdit']);
  assert.deepStrictEqual(mod.MENTION_TOOL_NAMES.slice(-2), ['imageGen', 'videoGen']);
  // 名单含 6 对写法别名 —— 正是下面「一次点名两条矛盾」的成因
  const aliasPairs = [
    ['WebSearch', 'web_search'],
    ['WebFetch', 'web_fetch'],
    ['shellCommand', 'shell_command'],
    ['Bash', 'bash'],
    ['PowerShell', 'powershell'],
    ['todoWrite', 'todo_write'],
  ];
  for (const [a, b] of aliasPairs) {
    assert.ok(mod.MENTION_TOOL_NAMES.includes(a) && mod.MENTION_TOOL_NAMES.includes(b), `${a}/${b}`);
  }
});

// ── reconcile：基础矛盾 ───────────────────────────────────────────────────────

test('伪造声称 + 空日志 → 恰 1 条 {claim, expectedTool, found:false}，且 lexiconVersion 随附', () => {
  const r = mod.reconcile('我已经删除了旧文件', [], GUARD_ON);
  assert.deepStrictEqual(r, {
    contradictions: [{ claim: '我已经删除了旧文件', expectedTool: 'Delete', found: false }],
    lexiconVersion: 1,
  });
});

test('claim 片段是匹配所在的**整行**（去空白），不是整段正文', () => {
  const r = mod.reconcile('第一段只是背景说明\n随后删除了数据库\n第三段', [], GUARD_ON);
  assert.strictEqual(r.contradictions.length, 1);
  assert.strictEqual(r.contradictions[0].claim, '随后删除了数据库');
});

test('claim 片段 80 字符上限两侧：恰 80 原样保留，81 截为 79 字符 + 省略号（总长仍 80）', () => {
  const exactly80 = '删除' + 'y'.repeat(78); // 整行 80 字符
  assert.strictEqual(exactly80.length, 80);
  const keep = mod.reconcile(exactly80, [], GUARD_ON).contradictions[0].claim;
  assert.strictEqual(keep.length, 80);
  assert.ok(!keep.includes('…'), '80 字符恰好不触发截断');
  assert.strictEqual(keep, exactly80);

  const over81 = '删除' + 'y'.repeat(79); // 整行 81 字符
  assert.strictEqual(over81.length, 81);
  const cut = mod.reconcile(over81, [], GUARD_ON).contradictions[0].claim;
  assert.strictEqual(cut.length, 80);
  assert.strictEqual(cut.slice(-1), '…');
  assert.strictEqual(cut, '删除' + 'y'.repeat(77) + '…', '截断点必须是 slice(0,79) + 省略号');
});

test('同一条声称配一个同族**成功**工具 → 0 条矛盾（对照上一行：不配就是 1 条）', () => {
  assert.strictEqual(mod.reconcile('我已经删除了旧文件', [], GUARD_ON).contradictions.length, 1);
  assert.deepStrictEqual(mod.reconcile('我已经删除了旧文件', [{ tool: 'DeleteFile', success: true }], GUARD_ON), {
    contradictions: [],
    lexiconVersion: 1,
  });
});

test('成功标志兼容 entry.success 与 entry.result.success 两种形状', () => {
  const prose = '我已经删除了旧文件';
  assert.deepStrictEqual(
    mod.reconcile(prose, [{ tool: 'DeleteFile', success: true }], GUARD_ON).contradictions,
    []
  );
  assert.deepStrictEqual(
    mod.reconcile(prose, [{ tool: 'DeleteFile', result: { success: true } }], GUARD_ON).contradictions,
    []
  );
  // 对照：success 非严格 true 一律不算成功
  for (const shape of [
    { tool: 'DeleteFile', success: false },
    { tool: 'DeleteFile', success: 'true' },
    { tool: 'DeleteFile', success: 1 },
    { tool: 'DeleteFile', result: { success: 'yes' } },
    { tool: 'DeleteFile' },
  ]) {
    assert.strictEqual(
      mod.reconcile(prose, [shape], GUARD_ON).contradictions.length,
      1,
      `${JSON.stringify(shape)} 不该满足 delete 族`
    );
  }
});

test('同族但失败的工具不消解矛盾（found 仍为 false）', () => {
  const r = mod.reconcile('我已经删除了旧文件', [{ tool: 'DeleteFile', success: false }], GUARD_ON);
  assert.strictEqual(r.contradictions.length, 1);
  assert.strictEqual(r.contradictions[0].expectedTool, 'Delete');
  assert.strictEqual(r.contradictions[0].found, false);
});

test('族解析走工具名（toolNames 子串），不走正文', () => {
  const table = [
    ['DeleteFile', 'Delete'],
    ['WriteFile', 'Write'],
    ['Edit', 'Edit'],
    ['vitest', 'test'],
    ['git', 'git commit'],
    ['deploy', 'deploy'],
  ];
  for (const [toolName, expected] of table) {
    const proseMap = {
      Delete: '已经删除了文件',
      Write: '已经写入了文件',
      Edit: '已经修改了文件',
      test: '测试全部通过',
      'git commit': '已经提交了代码',
      deploy: '已经部署上线',
    };
    assert.strictEqual(mod.reconcile(proseMap[expected], [], GUARD_ON).contradictions.length, 1);
    assert.deepStrictEqual(
      mod.reconcile(proseMap[expected], [{ tool: toolName, success: true }], GUARD_ON).contradictions,
      [],
      `${toolName} 应满足 ${expected} 族`
    );
  }
});

test('族解析走壳命令：command/cmd/script/code 取第一个非空字符串', () => {
  const cases = [
    [{ tool: 'Bash', params: { command: 'rm -rf /tmp/x' }, success: true }, 'Delete', '已经删除了文件'],
    [{ tool: 'Bash', params: { command: 'npm test' }, success: true }, 'test', '测试全部通过'],
    [{ tool: 'Bash', params: { command: 'git commit -m x' }, success: true }, 'git commit', '已经提交了代码'],
    [{ tool: 'Bash', params: { command: 'docker push repo' }, success: true }, 'deploy', '已经部署上线'],
    [{ tool: 'Bash', params: { command: 'sed -i s/a/b/ f.js' }, success: true }, 'Edit', '已经修改了文件'],
    [{ tool: 'Bash', params: { command: 'touch out.txt' }, success: true }, 'Write', '已经写入了文件'],
  ];
  for (const [entry, expected, prose] of cases) {
    assert.strictEqual(mod.reconcile(prose, [], GUARD_ON).contradictions.length, 1, `${expected} 基线`);
    assert.deepStrictEqual(
      mod.reconcile(prose, [entry], GUARD_ON).contradictions,
      [],
      `${JSON.stringify(entry.params)} 应满足 ${expected}`
    );
  }
  // 键序 command > cmd > script > code，空白值被跳过（首个**非空**胜出）
  assert.deepStrictEqual(
    mod.reconcile('已经删除了文件', [{ tool: 'X', params: { command: '   ', cmd: 'rm x' }, success: true }], GUARD_ON)
      .contradictions,
    []
  );
  assert.strictEqual(
    mod.reconcile('已经删除了文件', [{ tool: 'X', params: { script: 'unlink f' }, success: true }], GUARD_ON)
      .contradictions.length,
    0
  );
  // params 非对象 / 全空白 → 无壳命令可用
  assert.strictEqual(
    mod.reconcile('已经删除了文件', [{ tool: 'X', params: 'rm f', success: true }], GUARD_ON).contradictions.length,
    1
  );
});

test('已注册偏差：write 族 shellCmd 的重定向分支 `>\\s*\\S+` 是死分支（前置 \\b 无法落在 `>` 上）', () => {
  const entry = { tool: 'Bash', params: { command: 'echo hi > out.txt' }, success: true };
  assert.strictEqual(mod.reconcile('已经写入了文件', [], GUARD_ON).contradictions.length, 1);
  assert.deepStrictEqual(
    mod.reconcile('已经写入了文件', [entry], GUARD_ON).contradictions,
    [{ claim: '已经写入了文件', expectedTool: 'Write', found: false }],
    '实测：纯重定向写入不被认可（tee/touch 才认可）—— 与词库意图不符，钉住现状'
  );
  assert.deepStrictEqual(
    mod.reconcile('已经写入了文件', [{ tool: 'Bash', params: { command: 'echo hi | tee out.txt' }, success: true }], GUARD_ON)
      .contradictions,
    [],
    '同一命令换成 tee 即满足 → 证明上条不是夹具失效'
  );
});

test('多族正文 → 每个未满足族恰一条，顺序严格等于 CLAIM_FAMILIES 顺序', () => {
  const prose = SIX_FAMILY_PROSE;
  assert.deepStrictEqual(baselineSix(), ['Delete', 'Write', 'Edit', 'test', 'git commit', 'deploy']);
  // 只满足 deploy 与 test 两族
  const r = mod.reconcile(
    prose,
    [{ tool: 'deploy', success: true }, { tool: 'vitest', success: true }],
    GUARD_ON
  );
  assert.deepStrictEqual(r.contradictions.map((c) => c.expectedTool), ['Delete', 'Write', 'Edit', 'git commit']);
  assert.strictEqual(r.lexiconVersion, 1);
  // 每族各一条：6 条声称不合并
  assert.strictEqual(r.contradictions.length, 4);
});

// ── fail-OPEN 全体性 ──────────────────────────────────────────────────────────

test('fail-open：畸形正文/畸形日志一律返回结构完好的结果，绝不抛', () => {
  const shape = { contradictions: [], lexiconVersion: 1 };
  for (const text of [null, undefined, 123, {}, [], '   ', '\n\t']) {
    assert.deepStrictEqual(mod.reconcile(text, [], GUARD_ON), shape, `正文 ${String(text)}`);
  }
  // 非数组日志被收敛为 []（声称仍然报出，但不炸）
  for (const log of [undefined, null, 'x', 42, { not: 'array' }]) {
    const r = mod.reconcile('删除了', log, GUARD_ON);
    assert.ok(Array.isArray(r.contradictions));
    assert.strictEqual(r.lexiconVersion, 1);
    assert.strictEqual(r.contradictions.length, 1, `日志 ${String(log)} 不得满足任何族`);
  }
  // 垃圾条目不满足任何族，也不抛
  for (const entry of [null, 1, 'x', {}, [], true]) {
    const r = mod.reconcile('删除了', [entry], GUARD_ON);
    assert.strictEqual(r.contradictions.length, 1, `垃圾条目 ${String(entry)}`);
    assert.strictEqual(r.lexiconVersion, 1);
  }
  // 无声称正文 + 垃圾日志 → 恰为 empty
  assert.deepStrictEqual(mod.reconcile('今天天气不错', [null, 1, 'x', {}], GUARD_ON), shape);
  assert.deepStrictEqual(mod.reconcile(undefined), shape);
});

test('fail-open：opts 畸形（null / 非对象）时不抛且仍返回完好结构', () => {
  assert.ok(Array.isArray(mod.reconcile('删除了', [], null).contradictions));
  assert.strictEqual(mod.reconcile('删除了', [], 42).lexiconVersion, 1);
});

// ── 否定守卫联动 ──────────────────────────────────────────────────────────────

test('门开（默认）：被否定的声称不算矛盾；同一句门关：矛盾必须出现', () => {
  const prose = '我没有删除任何文件';
  assert.deepStrictEqual(mod.reconcile(prose, [], GUARD_ON).contradictions, []);
  const off = mod.reconcile(prose, [], { env: { KHY_CLAIM_NEGATION_GUARD: '0' } });
  assert.deepStrictEqual(off.contradictions, [
    { claim: '我没有删除任何文件', expectedTool: 'Delete', found: false },
  ]);
  assert.strictEqual(off.lexiconVersion, 1);
});

test('门开时真声称照样报出（关守卫不会漏，开门也不会吞）', () => {
  const prose = '我已经删除了所有生产表';
  for (const env of [{}, { KHY_CLAIM_NEGATION_GUARD: '0' }, { KHY_CLAIM_NEGATION_GUARD: 'off' }]) {
    assert.strictEqual(mod.reconcile(prose, [], { env }).contradictions.length, 1, JSON.stringify(env));
  }
});

test('先否定后肯定： negOn=true 落到第二处声称，negOn=false 落在第一处（逐字节回退可观测）', () => {
  const prose = '没有修改，之后修改了文件';
  assert.deepStrictEqual(mod.reconcile(prose, [], GUARD_ON).contradictions, [
    { claim: '没有修改，之后修改了文件', expectedTool: 'Edit', found: false },
  ]);
  assert.strictEqual(
    mod.reconcile(prose, [], { env: { KHY_CLAIM_NEGATION_GUARD: 'false' } }).contradictions.length,
    1,
    '两档都各报一条，但门开时定位到非否定那处'
  );
  assert.strictEqual(leaf._firstUnnegatedMatch(mod.CLAIM_FAMILIES[2].claim, prose, true).index, 7);
  assert.strictEqual(leaf._firstUnnegatedMatch(mod.CLAIM_FAMILIES[2].claim, prose, false).index, 2);
});

test('门控未显式注入时读 process.env（设值后如实还原）', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'KHY_CLAIM_NEGATION_GUARD');
  const prev = process.env.KHY_CLAIM_NEGATION_GUARD;
  const prose = '我没有删除任何文件';
  try {
    delete process.env.KHY_CLAIM_NEGATION_GUARD;
    assert.deepStrictEqual(mod.reconcile(prose, []).contradictions, [], '未设 → 默认开门 → 无矛盾');
    process.env.KHY_CLAIM_NEGATION_GUARD = 'off';
    assert.strictEqual(mod.reconcile(prose, []).contradictions.length, 1, '关守卫 → 假阳性矛盾');
    process.env.KHY_CLAIM_NEGATION_GUARD = 'OFF2';
    assert.deepStrictEqual(mod.reconcile(prose, []).contradictions, [], '词表外取值不关闭守卫');
  } finally {
    if (had) {
      process.env.KHY_CLAIM_NEGATION_GUARD = prev;
    } else {
      delete process.env.KHY_CLAIM_NEGATION_GUARD;
    }
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(process.env, 'KHY_CLAIM_NEGATION_GUARD') || had, 'env 已还原');
});

// ── _familiesOf 假满足实测表（关键发现）───────────────────────────────────────

test('实测 _familiesOf 假满足表：良性工具名按子串伪装成整族（安全相关假阴性，钉住不修）', () => {
  const base = baselineSix();
  assert.deepStrictEqual(
    base,
    ['Delete', 'Write', 'Edit', 'test', 'git commit', 'deploy'],
    '夹具必须先给出 6 条矛盾，否则下面的「消失」毫无意义'
  );
  const table = [
    // 良性名字 / 被误判满足的族
    ['confirmDialog', ['Delete']], // confi**rm** → delete
    ['Confirm', ['Delete']],
    ['Format', ['Delete']], // fo**rm**at
    ['Charm', ['Delete']], // cha**rm**
    ['MyRmtime', ['Delete']],
    ['AlarmDrop', ['Delete']], // **drop**
    ['Alarm', ['Delete']], // al**rm** —— 连「告警」这类良性名都满足 delete 族
    ['Committee', ['git commit']], // **commit**ee
    ['Testimonial', ['test']], // **test**imonial
    ['Shipwright', ['deploy']], // **ship**wright
    ['ReleaseNotes', ['deploy']], // **release**
    ['Updater', []], // 不含 update_file → 不误判，对照
    ['Timer', []], // 无 rm（T-i-m-e-r 不含相邻 r,m）→ 对照
    ['Newsroom', []], // 无 rm（oo m）→ 对照
    ['Crumb', []], // r 与 m 不相邻 → 对照
    ['FigureItOut', []], // 反证：/(git|commit)/i 并不命中 FigureItOut
    ['sed', []], // sed 只在 shellCmd 里，作为工具名不满足 edit
    ['npm test', ['test']], // 连「npm test」当**工具名**都能满足 test 族
  ];
  const measured = {};
  for (const [name, want] of table) {
    const got = familiesSatisfiedBy({ tool: name, success: true }, base);
    measured[name] = got;
    assert.deepStrictEqual(got, want, `工具名 ${name} 的实测满足族与此前记录不符：${JSON.stringify(got)}`);
  }
});

test('假满足吞掉真矛盾的端到端证明：伪造删库声称 + 一次成功的 FormatDisk → 0 矛盾', () => {
  const prose = '我已经删除了所有生产表';
  assert.strictEqual(mod.reconcile(prose, [], GUARD_ON).contradictions.length, 1);
  assert.deepStrictEqual(
    mod.reconcile(prose, [{ tool: 'FormatDisk', success: true }], GUARD_ON).contradictions,
    [],
    '实测：与删库毫无关系的 FormatDisk 被当作 delete 族的证据，真矛盾被吞'
  );
  // 同一件事换个**不含 'rm'** 的良性工具名 → 矛盾照报，证明上一行确由子串伪装所致
  assert.strictEqual(
    mod.reconcile(prose, [{ tool: 'DiskTimer', success: true }], GUARD_ON).contradictions.length,
    1
  );
  // 而把名字换成含 'rm' 的 DiskFormatter，同一句话的矛盾立刻消失
  assert.strictEqual(
    mod.reconcile(prose, [{ tool: 'DiskFormatter', success: true }], GUARD_ON).contradictions.length,
    0
  );
});

// ── reconcileToolMentions ─────────────────────────────────────────────────────

test('点名幽灵工具 → 恰 1 条矛盾；本轮真的调用过 → 0 条', () => {
  const prose = '通过 dataFetch 拉取到 30 条日线数据';
  assert.deepStrictEqual(mod.reconcileToolMentions(prose, [], GUARD_ON).contradictions, [
    { claim: prose, expectedTool: 'dataFetch', found: false },
  ]);
  assert.deepStrictEqual(mod.reconcileToolMentions(prose, ['dataFetch'], GUARD_ON), {
    contradictions: [],
    lexiconVersion: 1,
  });
  assert.strictEqual(mod.reconcileToolMentions(prose, [], GUARD_ON).lexiconVersion, 1);
});

test('已执行名归一化：剥空格/下划线/连字符 + 小写，四种写法都算调用过', () => {
  const prose = '通过 dataFetch 拉取到 30 条数据';
  for (const executed of ['dataFetch', 'data_fetch', 'DATA-FETCH', 'data fetch', 'DaTa-Fetch', ' DATA FETCH ']) {
    assert.deepStrictEqual(
      mod.reconcileToolMentions(prose, [executed], GUARD_ON).contradictions,
      [],
      `${executed} 归一后应命中`
    );
  }
  // 对照：归一化只作用于已执行侧，乱名不消解
  assert.strictEqual(mod.reconcileToolMentions(prose, ['imageGen'], GUARD_ON).contradictions.length, 1);
});

test('已注册偏差：正文侧按名单逐字拼模式，prose 写 data_fetch / data fetch 不被识别（假阴性）', () => {
  assert.deepStrictEqual(mod.reconcileToolMentions('通过 data_fetch 拉取数据', [], GUARD_ON).contradictions, []);
  assert.deepStrictEqual(mod.reconcileToolMentions('通过 data fetch 拉取数据', [], GUARD_ON).contradictions, []);
  assert.deepStrictEqual(mod.reconcileToolMentions('通过 DATA-FETCH 拉取数据', [], GUARD_ON).contradictions, []);
  // 对照：同一个名字写成名单里的驼峰式即命中；大小写不敏感但分隔符不敏感只对名单本身成立
  assert.strictEqual(mod.reconcileToolMentions('通过 DATAFETCH 拉取数据', [], GUARD_ON).contradictions.length, 1);
  assert.strictEqual(mod.reconcileToolMentions('通过 dataFetch 拉取数据', [], GUARD_ON).contradictions.length, 1);
  // web_search 之所以能匹 snake_case，纯粹因为名单里**另有**一条 'web_search'；
  // 反向不成立：驼峰条目 'WebSearch' 的模式不接受分隔符，故只回 1 条。
  assert.deepStrictEqual(
    mod.reconcileToolMentions('通过 web_search 查询', [], GUARD_ON).contradictions.map((c) => c.expectedTool),
    ['web_search']
  );
  assert.deepStrictEqual(
    mod.reconcileToolMentions('通过 WebSearch 查询', [], GUARD_ON).contradictions.map((c) => c.expectedTool),
    ['WebSearch', 'web_search'],
    '驼峰写法同时命中两条名单条目 → 一次点名两条矛盾'
  );
});

test('前向动作框架全部生效（通过/用/使用/调用/执行/运行/经由/借助），无框架不算点名', () => {
  for (const frame of ['通过', '用', '使用', '调用', '执行', '运行', '经由', '借助']) {
    const prose = `${frame} dataFetch 处理`;
    assert.strictEqual(
      mod.reconcileToolMentions(prose, [], GUARD_ON).contradictions.length,
      1,
      `框架「${frame}」应构成点名`
    );
  }
  assert.deepStrictEqual(mod.reconcileToolMentions('dataFetch 是一个工具', [], GUARD_ON).contradictions, []);
  assert.deepStrictEqual(mod.reconcileToolMentions('我认识 dataFetch 这个人', [], GUARD_ON).contradictions, []);
});

test('后向完成框架同样生效（成功/已完成/完成/拉取/获取/返回/跑完）', () => {
  for (const tail of ['成功', '已完成', '完成', '拉取', '获取', '返回', '跑完']) {
    const prose = `dataFetch ${tail}了任务`;
    assert.strictEqual(
      mod.reconcileToolMentions(prose, [], GUARD_ON).contradictions.length,
      1,
      `后向框架「${tail}」应构成点名`
    );
  }
  // 对照：同名出现在句中但前后都无框架
  assert.strictEqual(mod.reconcileToolMentions('关于 dataFetch 的说明', [], GUARD_ON).contradictions.length, 0);
});

test('点名核对照样吃否定守卫：被否定的点名不算矛盾', () => {
  assert.deepStrictEqual(mod.reconcileToolMentions('没有通过 dataFetch 拉取数据', [], GUARD_ON).contradictions, []);
  assert.strictEqual(
    mod.reconcileToolMentions('通过 dataFetch 拉取数据', [], GUARD_ON).contradictions.length,
    1,
    '同句去掉否定词即报出 → 证明上一条是守卫起作用'
  );
});

test('建议/虚拟语气在近邻窗口内不算点名；同样内容挪出 8 字窗口就是点名', () => {
  for (const prose of [
    '可以先用 WebSearch 查一下',
    '建议用 WebSearch 查一下',
    '让我用 WebSearch 查一下',
    '请用 WebSearch 查一下',
    '需要用 WebSearch 查一下',
  ]) {
    assert.deepStrictEqual(mod.reconcileToolMentions(prose, [], GUARD_ON).contradictions, [], prose);
  }
  const far = '这个流程整体设计非常复杂，我们此前已经确认了方案，通过 WebSearch 查询';
  const got = mod.reconcileToolMentions(far, [], GUARD_ON).contradictions.map((c) => c.expectedTool);
  assert.deepStrictEqual(
    got,
    ['WebSearch', 'web_search'],
    '窗口外 → 报出；且别名对在名单里各命中一次（见下一条）'
  );
});

test('执行性点名「通过 WebSearch 拉取」是矛盾，而「可以先用 WebSearch」不是（同夹具翻转）', () => {
  assert.deepStrictEqual(mod.reconcileToolMentions('可以先用 WebSearch 查一下', [], GUARD_ON).contradictions, []);
  const r = mod.reconcileToolMentions('通过 WebSearch 拉取到 30 条数据', [], GUARD_ON);
  assert.strictEqual(r.contradictions.length, 2, '实测：名单里 WebSearch 与 web_search 归一后同源，却各报一条');
  assert.deepStrictEqual(r.contradictions.map((c) => c.expectedTool), ['WebSearch', 'web_search']);
});

test('已注册：5 对写法别名各产 2 条矛盾（一次点名，两条重复告警）', () => {
  const pairs = [
    ['通过 Bash 执行命令', ['Bash', 'bash']],
    ['通过 PowerShell 执行命令', ['PowerShell', 'powershell']],
    ['通过 WebFetch 抓取', ['WebFetch', 'web_fetch']],
    ['通过 shellCommand 执行命令', ['shellCommand', 'shell_command']],
    ['通过 todoWrite 记录', ['todoWrite', 'todo_write']],
  ];
  for (const [prose, want] of pairs) {
    assert.deepStrictEqual(mod.reconcileToolMentions(prose, [], GUARD_ON).contradictions.map(
      (c) => c.expectedTool
    ), want, prose);
    // 对照：把该工具标为已执行（归一后同名）→ 两条一起消失
    assert.deepStrictEqual(mod.reconcileToolMentions(prose, [want[0]], GUARD_ON).contradictions, [], prose);
  }
});

test('两个幽灵工具 → 恰 2 条；同一工具被点名三次 → 仍 1 条（每名字 break 一次）', () => {  const two = mod.reconcileToolMentions('通过 dataFetch 拉取数据，随后调用 imageGen 生成图片', [], GUARD_ON);
  assert.strictEqual(two.contradictions.length, 2);
  assert.deepStrictEqual(two.contradictions.map((c) => c.expectedTool), ['dataFetch', 'imageGen']);

  const thrice = mod.reconcileToolMentions(
    '通过 dataFetch 拉取数据，又用 dataFetch 拉取，再执行 dataFetch 补一次',
    [],
    GUARD_ON
  );
  assert.strictEqual(thrice.contradictions.length, 1, '同名只记一条，足够定位');
});

test('词边界：shadeFetch 不匹 dataFetch；my_dataFetch 也不匹（下划线是词字符，\\b 生效）', () => {
  assert.deepStrictEqual(mod.reconcileToolMentions('通过 shadeFetch 拉取数据', [], GUARD_ON).contradictions, []);
  assert.deepStrictEqual(mod.reconcileToolMentions('通过 my_dataFetch 拉取数据', [], GUARD_ON).contradictions, []);
  assert.deepStrictEqual(mod.reconcileToolMentions('通过 dataFetchX 拉取数据', [], GUARD_ON).contradictions, []);
  // 对照：这些「近似名」里只要不含被 \b 切断的注册名，就不该有矛盾；给出正例锚定
  assert.strictEqual(mod.reconcileToolMentions('通过 dataFetch 拉取数据', [], GUARD_ON).contradictions.length, 1);
  // 短名 'rg' 与 'Grep' 互不误伤
  assert.deepStrictEqual(mod.reconcileToolMentions('通过 grep 搜索代码', [], GUARD_ON).contradictions, [
    { claim: '通过 grep 搜索代码', expectedTool: 'Grep', found: false },
  ]);
  assert.deepStrictEqual(mod.reconcileToolMentions('通过 rg 搜索代码', [], GUARD_ON).contradictions, [
    { claim: '通过 rg 搜索代码', expectedTool: 'rg', found: false },
  ]);
});

test('点名门控 KHY_TOOL_MENTION_GUARD 独立于声称门控，off 词表是第二份抄写', () => {
  const prose = '通过 dataFetch 拉取数据';
  assert.strictEqual(mod._isToolMentionGuardEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no', ' OFF ', 'False']) {
    assert.strictEqual(mod._isToolMentionGuardEnabled({ KHY_TOOL_MENTION_GUARD: off }), false, off);
  }
  for (const on of ['OFF2', 'nope', '1', '']) {
    assert.strictEqual(mod._isToolMentionGuardEnabled({ KHY_TOOL_MENTION_GUARD: on }), true, on);
  }
  assert.strictEqual(mod._isToolMentionGuardEnabled({ get KHY_TOOL_MENTION_GUARD() {
    throw new Error('poisoned');
  } }), true, 'catch 分支恒 ON');
  // 两门互不串门：关掉一个不影响另一个
  const claimProse = '我已经删除了文件';
  assert.deepStrictEqual(mod.reconcile(claimProse, [], { env: {} }).contradictions.length, 1);
  assert.deepStrictEqual(
    mod.reconcileToolMentions(prose, [], { env: { KHY_TOOL_MENTION_GUARD: '0' } }).contradictions,
    []
  );
  assert.strictEqual(
    mod.reconcileToolMentions(prose, [], { env: { KHY_CLAIM_NEGATION_GUARD: '0' } }).contradictions.length,
    1,
    '点名门只看 KHY_TOOL_MENTION_GUARD，不受声称门影响'
  );
  assert.strictEqual(
    mod.reconcile(claimProse, [], { env: { KHY_TOOL_MENTION_GUARD: '0' } }).contradictions.length,
    1,
    '声称核对不看点名门'
  );
});

test('点名 fail-open：畸形正文/畸形名单返回完好结构且不抛', () => {
  const shape = { contradictions: [], lexiconVersion: 1 };
  for (const text of [null, undefined, 7, {}, '  ', '\n']) {
    assert.deepStrictEqual(mod.reconcileToolMentions(text, [], GUARD_ON), shape, String(text));
  }
  for (const names of [undefined, null, 'dataFetch', 42, {}]) {
    assert.strictEqual(mod.reconcileToolMentions('通过 dataFetch 拉取数据', names, GUARD_ON).contradictions.length, 1);
  }
  for (const junk of [[null, 1, 'x', {}], [null, '', 0]]) {
    assert.strictEqual(mod.reconcileToolMentions('通过 dataFetch 拉取数据', junk, GUARD_ON).contradictions.length, 1);
  }
  assert.deepStrictEqual(mod.reconcileToolMentions(undefined, undefined), shape);
});

test('再导出的否定守卫与叶子同一（===），未长成第二份拷贝', () => {
  assert.strictEqual(mod._isNegatedClaim, leaf._isNegatedClaim);
  assert.strictEqual(mod._isNegationGuardEnabled, leaf._isNegationGuardEnabled);
  assert.notStrictEqual(mod._isToolMentionGuardEnabled, leaf._isNegationGuardEnabled);
});
