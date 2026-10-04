'use strict';

/**
 * toolDisplayLine 的行语法契约（[DESIGN-ARCH-155] §1 / §7 验收第 1 项）。
 *
 * 这些断言就是「一行动词句」的冻结口径：动词、目标、结果量、时长四个位的**字面输出**。
 * 任何一端改措辞都应先改本文件，而不是在渲染层另起一句。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  toolVerb,
  toolTarget,
  formatToolDuration,
  resultSegment,
  describeToolLine,
  describeGroupLine,
  SEP,
} = require('../../src/cli/toolDisplayLine.js');
const { summarizeToolResult, summarizeToolResultParts } = require('../../src/cli/toolResultSummary.js');

// 固定 cwd 与 env：路径相对化、截断与门控都吃这两个输入，不注入会让断言随目录漂移。
const CWD = '/repo';
const ENV = {};
const opts = { cwd: CWD, env: ENV };

describeTool('helper'); // 声明性占位，见下方真实用例

function describeTool() {}

// ── 动词表 ────────────────────────────────────────────────────────────────
test('toolVerb 覆盖规范 §1 的动作类，且与 spinner 既有口径一致', () => {
  assert.equal(toolVerb('read'), '读取');
  assert.equal(toolVerb('ReadFile'), '读取');
  assert.equal(toolVerb('notebookread'), '读取');
  assert.equal(toolVerb('write'), '写入');
  assert.equal(toolVerb('create_file'), '创建');
  assert.equal(toolVerb('Edit'), '编辑');
  assert.equal(toolVerb('multiedit'), '编辑');
  assert.equal(toolVerb('grep'), '搜索');
  assert.equal(toolVerb('search'), '搜索');
  assert.equal(toolVerb('glob'), '查找');
  assert.equal(toolVerb('ls'), '列出');
  assert.equal(toolVerb('Bash'), '执行');
  assert.equal(toolVerb('build'), '执行');
  assert.equal(toolVerb('websearch'), '联网搜索');
  assert.equal(toolVerb('webfetch'), '抓取');
  assert.equal(toolVerb('agent'), '派发');
  assert.equal(toolVerb('todowrite'), '更新');
});

test('toolVerb 对未收录工具兜底「运行」，不假装有具体动作', () => {
  assert.equal(toolVerb('mcp__figma__export'), '运行');
  assert.equal(toolVerb(''), '运行');
  assert.equal(toolVerb(undefined), '运行');
});

// ── 目标提取 ──────────────────────────────────────────────────────────────
test('toolTarget 按工具族取键：搜索取模式，不取目录', () => {
  // 今天的 TUI 头行会提出 `src`（规范 §0.3 Z5 的病灶之一）。
  assert.equal(
    toolTarget('grep', { pattern: 'describeToolLine', path: 'src' }, opts),
    '"describeToolLine"'
  );
});

test('toolTarget 路径相对化并统一 POSIX 分隔符', () => {
  const abs = `${CWD}/services/backend/src/cli/router.js`;
  assert.equal(toolTarget('read', { file_path: abs }, opts), 'services/backend/src/cli/router.js');
  assert.equal(toolTarget('read', { file_path: 'C:\\src\\x.js' }, opts).includes('\\'), false);
});

test('toolTarget 命令取 command 键并折叠换行（头行必须是一行）', () => {
  assert.equal(
    toolTarget('bash', { command: 'npm run build\n  --watch' }, opts),
    'npm run build --watch'
  );
});

test('toolTarget 提不出目标时返回空串（调用方据此省略，不出现「动作 + 空白」）', () => {
  assert.equal(toolTarget('todowrite', { todos: [] }, opts), '');
  assert.equal(toolTarget('read', null, opts), '');
  assert.equal(toolTarget('read', { unrelated: 1 }, opts), '');
});

test('toolTarget 接受 JSON 字符串入参（事件/持久化链路里 input 常是串）', () => {
  assert.equal(
    toolTarget('read', JSON.stringify({ file_path: `${CWD}/a.js` }), opts),
    'a.js'
  );
});

// ── 时长 ──────────────────────────────────────────────────────────────────
test('formatToolDuration 三档口径：<1s / <1m / ≥1m', () => {
  assert.equal(formatToolDuration(45), '45ms');
  assert.equal(formatToolDuration(999), '999ms');
  assert.equal(formatToolDuration(1200), '1.2s');
  assert.equal(formatToolDuration(2000), '2s');
  assert.equal(formatToolDuration(75000), '1m 15s');
});

test('formatToolDuration 缺失即空——绝不估算、绝不补零（规范 §1 诚实条款）', () => {
  assert.equal(formatToolDuration(0), '');
  assert.equal(formatToolDuration(undefined), '');
  assert.equal(formatToolDuration(-5), '');
  assert.equal(formatToolDuration(Number.NaN), '');
});

// ── 结果量拆分（full 必须逐字节等于 summarizeToolResult）──────────────────
test('summarizeToolResultParts.full 恒等于 summarizeToolResult', () => {
  const cases = [
    ['read', { success: true, lines: 340, path: `${CWD}/x.js` }, {}],
    ['grep', { total: 12, counts: [{}, {}, {}] }, { output_mode: 'count' }],
    ['edit', { file: `${CWD}/x.js`, replacements: 3 }, { old_string: 'a\nb', new_string: 'a\nc\nd' }],
    ['write', { path: `${CWD}/y.js`, bytes: 1234 }, { content: 'x\ny\nz' }],
    ['bash', { exitCode: 1, output: 'l1\nl2\nl3' }, { command: 'npm test' }],
    ['bash', { _background: true }, { command: 'npm run dev' }],
    ['mystery', { message: '自定义结果' }, {}],
  ];
  for (const [name, result, params] of cases) {
    const full = summarizeToolResult(name, result, params);
    const parts = summarizeToolResultParts(name, result, params);
    assert.equal(parts.full, full, `full 漂移: ${name}`);
  }
});

test('summarizeToolResultParts 拆出量词；模板对不上则 quantity 空、claim 兜整句', () => {
  // 摘要里的路径走 _displayPath（CC getDisplayPath 算法），绝对路径在 cwd 外会原样保留。
  assert.deepEqual(
    summarizeToolResultParts('read', { lines: 340, path: '/repo/x.js' }, {}),
    { full: '已读取 /repo/x.js（340 行）', claim: '已读取 /repo/x.js', quantity: '340 行' }
  );
  assert.equal(
    summarizeToolResultParts('grep', { total: 12, counts: [{}, {}, {}] }, { output_mode: 'count' })
      .quantity,
    '12 个匹配，跨 3 个文件'
  );
  // 命令回显不拆（目标位已有命令）
  assert.equal(
    summarizeToolResultParts('bash', { exitCode: 0, output: '' }, { command: 'npm run build' })
      .quantity,
    ''
  );
  // 拆不出的模板如实降级（规范 §9 V2）
  assert.equal(
    summarizeToolResultParts(
      'build',
      { data: { command: 'npm test', exitCode: 1, errorCount: 2 } },
      {}
    ).quantity,
    ''
  );
});

test('resultSegment 拒绝复读：中性收束、命令回显、已含目标三种情况都留空', () => {
  assert.equal(resultSegment({ full: '网络搜索完成', claim: '网络搜索完成', quantity: '' }, 'q'), '');
  assert.equal(resultSegment({ full: '$ npm test', claim: '$ npm test', quantity: '' }, 'npm test'), '');
  assert.equal(resultSegment({ full: '已读取 x.js', claim: '已读取 x.js', quantity: '' }, 'x.js'), '');
  // 短正文（bash 的 1–2 行输出）是信息，保留
  assert.equal(resultSegment({ full: 'total 3', claim: 'total 3', quantity: '' }, 'ls -l'), 'total 3');
  assert.equal(resultSegment({ full: '已读取 x.js（340 行）', claim: '已读取 x.js', quantity: '340 行' }, 'x.js'), '340 行');
});

// ── 整行组装 ──────────────────────────────────────────────────────────────
test('describeToolLine 产出规范 §1 的一行：符 动作 目标 · 结果量 · 时长', () => {
  const d = describeToolLine({
    name: 'read',
    input: { file_path: `${CWD}/src/cli/router.js` },
    result: { success: true, lines: 340 },
    durationMs: 200,
    ...opts,
  });
  assert.equal(d.line, `✓ 读取 src/cli/router.js${SEP}340 行${SEP}200ms`);
  assert.equal(d.status, 'ok');
  assert.equal(d.glyph, '✓');
  assert.equal(d.verb, '读取');
});

test('describeToolLine 运行中只到目标位，不编造结果与时长', () => {
  const d = describeToolLine({ name: 'bash', input: { command: 'npm test' }, ...opts });
  assert.equal(d.line, '◆ 执行 npm test');
  assert.equal(d.status, 'running');
  assert.equal(d.quantity, '');
  assert.equal(d.durationText, '');
});

test('describeToolLine 失败判定：denied / isError 判红；非零退出码由量词诚实表达（§9 V5）', () => {
  const denied = describeToolLine({
    name: 'bash',
    input: { command: 'rm -rf /tmp/x' },
    result: { success: false, denied: true, error: '权限被拒绝' },
    ...opts,
  });
  assert.equal(denied.status, 'err');
  assert.equal(denied.denied, true);

  // 非零退出码不判红（TUI 渲染层同口径）：状态符与结果不矛盾——失败事实由
  // `[退出码 1]` 量词 + 结果正文表达。判红唯一正道是循环层统一打 isError（V5）。
  const exit1 = describeToolLine({
    name: 'bash',
    input: { command: 'npm test' },
    result: { exitCode: 1, output: 'l1\nl2\nl3' },
    durationMs: 12400,
    ...opts,
  });
  assert.equal(exit1.status, 'ok');
  assert.equal(exit1.quantity, '3 行 [退出码 1]');

  // 后台运行没有退出码，不判红
  const bg = describeToolLine({ name: 'bash', input: { command: 'npm run dev' }, result: { _background: true }, ...opts });
  assert.equal(bg.status, 'ok');
});

test('describeToolLine 的时长真值优先取显式 durationMs，其次 result.durationMs', () => {
  const fromResult = describeToolLine({
    name: 'read',
    input: { file_path: `${CWD}/a.js` },
    result: { lines: 2, durationMs: 37 },
    ...opts,
  });
  assert.equal(fromResult.durationText, '37ms');
});

// ── 宽度预算（规范 §1.3 的牺牲阶梯）──────────────────────────────────────
test('窄列按阶梯牺牲：目标再截 → 结果量 → 时长；动作与状态符永不截', () => {
  const base = {
    name: 'read',
    input: { file_path: `${CWD}/services/backend/src/cli/router.js` },
    result: { success: true, lines: 340 },
    durationMs: 200,
  };
  const wide = describeToolLine({ ...base, cols: 80, ...opts });
  assert.equal(displayWidthOf(wide.line) <= 80, true);

  const tight = describeToolLine({ ...base, cols: 24, ...opts });
  assert.equal(displayWidthOf(tight.line) <= 24, true);
  assert.equal(tight.line.startsWith('✓ 读取'), true); // 动作与状态符保留
  assert.equal(tight.line.includes('340 行'), false); // 结果量已牺牲
});

test('窄列里的命令从尾部截（保住语义前缀），不从中间截', () => {
  const d = describeToolLine({
    name: 'bash',
    input: { command: 'npm run build --workspace=@khy/shared --configuration=production' },
    result: { exitCode: 1, output: 'a\nb\nc' },
    durationMs: 1200,
    cols: 40,
    ...opts,
  });
  assert.equal(displayWidthOf(d.line) <= 40, true);
  assert.equal(d.line.includes('npm run build'), true);
  assert.equal(d.line.includes('…onfiguration'), false);
});

// ── 组行（L0）────────────────────────────────────────────────────────────
test('describeGroupLine 动词用 " + " 连接，目标唯一才代表', () => {
  const tools = [
    { name: 'Read', input: { file_path: `${CWD}/src/a.js` }, result: { lines: 10 } },
    { name: 'Edit', input: { file_path: `${CWD}/src/a.js` }, result: { file: `${CWD}/src/a.js`, replacements: 2 } },
    { name: 'read', input: { file_path: `${CWD}/src/a.js` }, result: { lines: 3 } },
  ];
  const g = describeGroupLine(tools, { ...opts, cols: 80 });
  assert.equal(g.line, `✓ 读取 + 编辑 src/a.js${SEP}3 步`);
  assert.equal(g.steps, 3);
  assert.equal(g.failed, 0);
});

test('describeGroupLine 目标不唯一时不硬凑，只报步数与失败数', () => {
  const g = describeGroupLine(
    [
      { name: 'Read', input: { file_path: `${CWD}/a.js` }, result: { lines: 1 } },
      { name: 'Read', input: { file_path: `${CWD}/b.js` }, result: { lines: 1 } },
      { name: 'Bash', input: { command: 'npm test' }, result: { isError: true, error: 'boom' } },
    ],
    { ...opts, cols: 80 }
  );
  assert.equal(g.target, '');
  assert.equal(g.failed, 1);
  assert.equal(g.line, `✗ 读取 + 执行${SEP}3 步${SEP}1 失败`);
});

test('describeGroupLine 有运行中的工具即整组标运行', () => {
  const g = describeGroupLine(
    [
      { name: 'Read', input: { file_path: `${CWD}/a.js` }, result: { lines: 1 } },
      { name: 'Read', input: { file_path: `${CWD}/b.js` } },
    ],
    { ...opts, cols: 80 }
  );
  assert.equal(g.status, 'running');
  assert.equal(g.glyph, '◆');
});

test('describeGroupLine 空数组不抛，返回空行', () => {
  const g = describeGroupLine([], opts);
  assert.equal(g.line, '');
  assert.equal(g.steps, 0);
});

// ── 跨端一致性的前提：纯文本、无 emoji、无颜色信息 ────────────────────────
test('行是纯文本且不含 emoji（§3 R2：去色后信息不丢，可粘贴成句）', () => {
  const d = describeToolLine({
    name: 'read',
    input: { file_path: `${CWD}/a.js` },
    result: { success: true, lines: 5 },
    durationMs: 10,
    ...opts,
  });
  // 状态符 ◆✓✗ 与分隔符 · 是本规范**钦定**的字形（§3 R2），剔除后再查有没有 emoji。
  const stripped = d.line.replace(/[◆✓✗·…]/g, '');
  assert.equal(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(stripped), false);
  assert.equal(d.line.includes('\x1b'), false);
  assert.equal(d.line.includes('\n'), false);
});

test('垃圾输入不抛：任何输入都要产出一行可渲染文本（显示层不得让工具行消失）', () => {
  for (const input of [undefined, null, 0, 'not json', { file_path: {} }, [], '[]']) {
    const d = describeToolLine({ name: 'read', input, result: { lines: 1 }, ...opts });
    assert.equal(typeof d.line, 'string');
    assert.equal(d.line.length > 0, true);
  }
  const weird = describeToolLine({ name: null, input: null, result: 'string result', ...opts });
  assert.equal(typeof weird.line, 'string');
});

function displayWidthOf(s) {
  // 与生产代码同一显示宽度真源，不用 String.length（CJK 会被低估）。
  return require('../../src/cli/formatters.js').displayWidth(s);
}
