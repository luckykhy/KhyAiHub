'use strict';

/**
 * 用户消息的「形态区分」契约 —— 用户在转录里回显的那几行必须与 AI 答复一眼分得开。
 *
 * 用户回报:「输入内容应该设计和输出内容不一样的回显,否则不方便阅读」——默认的
 * 应用内 Viewport 路径此前把用户消息画成 `'❯ ' + text` 的**纯文本行**,Viewport 逐行
 * `h(Text, null, line)`,于是与 AI 的答复同色同底。
 *
 * 这里锁三条:
 *   1. `buildTranscriptLineRecords` 的 lines 与既有的 `buildTranscriptLines` **逐字节相等**
 *      (老调用方与测试不受影响),roles 与之**恒同长同序**;
 *   2. `Viewport.linePropsAt` 只给 `role === 'user'` 的行出样式,其余行恒 `null`
 *      (= 不加任何 prop,逐字节回退);
 *   3. 总闸 `KHY_USER_MSG_WHITE_BG` 关 → 连用户行也是 `null`。
 */

const test = require('node:test');
const assert = require('node:assert');

const { buildTranscriptLines, buildTranscriptLineRecords, TOTAL_LINE_CAP } = require(
  '../../../src/cli/tui/transcriptLines'
);
const { linePropsAt } = require('../../../src/cli/tui/ink-components/Viewport');
const {
  userMsgBgColor,
  userMsgFgColor,
  userLineTextProps,
  thinkingLineBgColor,
} = require('../../../src/cli/tui/userMessageStyle');

const COLS = 80;
const build = (msgs, opts) => buildTranscriptLines(msgs, { cols: COLS, ...(opts || {}) });
const records = (msgs, opts) => buildTranscriptLineRecords(msgs, { cols: COLS, ...(opts || {}) });

// ── 1. 行数组逐字节不变 + 角色同长同序 ────────────────────────────────────────

test('buildTranscriptLineRecords: lines 逐字节等于 buildTranscriptLines', () => {
  const msgs = [
    { role: 'user', content: '帮我读配置' },
    { role: 'assistant', content: '好的，正在读取' },
    { role: 'error', content: '读不到' },
    { role: 'turn-stats', content: '✓ 3s · 12 tokens' },
  ];
  assert.deepStrictEqual(records(msgs).lines, build(msgs));
});

test('buildTranscriptLineRecords: roles 与 lines 恒同长', () => {
  const cases = [
    [],
    null,
    'nope',
    [{ role: 'user', content: 'a' }],
    [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
    [{ role: 'user', content: 'a' }, {}, { role: 'assistant', content: 'b' }],
    [{ role: 'user', content: 'x'.repeat(500) }], // 折行成多行
    [{ role: 'user', content: '第一行\n第二行\n第三行' }], // 多逻辑行
  ];
  for (const c of cases) {
    const rec = records(c);
    assert.equal(
      rec.roles.length,
      rec.lines.length,
      'roles/lines 不同长 → Viewport 会按错位下标涂错行'
    );
  }
});

test('buildTranscriptLineRecords: 用户消息的每一行都带 user 角色(含折行与续行)', () => {
  const rec = records([{ role: 'user', content: 'x'.repeat(500) }]);
  assert.ok(rec.lines.length > 1, '前提:该输入必须折成多行，否则这条测试没有覆盖续行');
  assert.deepStrictEqual(
    rec.roles,
    new Array(rec.lines.length).fill('user'),
    '续行必须同样带 user —— 否则米白底会在折行处断开'
  );
});

test('buildTranscriptLineRecords: 消息之间的空行角色为空(不着色)', () => {
  const rec = records([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]);
  assert.deepStrictEqual(rec.lines, ['❯ a', '', '❯ b']);
  assert.deepStrictEqual(rec.roles, ['user', '', 'user']);
});

test('buildTranscriptLineRecords: 助手/其他角色的行不被标成 user', () => {
  const rec = records([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
  const assistantIdx = rec.lines.indexOf('b');
  assert.ok(assistantIdx > 0, '前提:助手文本必须出现在投影里');
  assert.equal(rec.roles[assistantIdx], 'assistant');
  assert.equal(
    rec.roles.filter((r) => r === 'user').length,
    1,
    '只有用户那一行是 user'
  );
});

test('buildTranscriptLineRecords: 上限截断时两个数组仍同长,提示行角色为空', () => {
  const msgs = Array.from({ length: TOTAL_LINE_CAP }, (_, i) => ({
    role: 'user',
    content: 'm' + i,
  }));
  const rec = records(msgs);
  // 截断后是「提示行 + CAP 行正文」,故总长为 CAP + 1(与改动前的行为一致)。
  assert.equal(rec.lines.length, TOTAL_LINE_CAP + 1);
  assert.equal(rec.roles.length, rec.lines.length);
  assert.match(rec.lines[0], /更早的 \d+ 行未载入/);
  assert.equal(rec.roles[0], '', '截断提示行不属于任何消息 → 不着色');
  assert.equal(rec.roles[rec.roles.length - 1], 'user', '最新那行仍带 user');
});

test('buildTranscriptLineRecords: 非法输入 → 三个空数组而不是抛', () => {
  // folds 是第三个同长同序数组（行 → 可折叠条目锚点），非法输入下同样恒空；
  // 这条断言在 folds 落地时漏改，长期红着，2026-11-01 补上。
  assert.deepStrictEqual(buildTranscriptLineRecords(), { lines: [], roles: [], folds: [] });
  assert.deepStrictEqual(buildTranscriptLineRecords(null, null), {
    lines: [],
    roles: [],
    folds: [],
  });
  assert.deepStrictEqual(buildTranscriptLineRecords([null, undefined, 7, 'x']), {
    lines: [],
    roles: [],
    folds: [],
  });
});

// ── 2. Viewport 侧逐行取 props ───────────────────────────────────────────────

test('linePropsAt: 用户行拿到米白底 + 近黑字,助手行拿 null', () => {
  const roles = ['user', '', 'assistant', 'turn-stats'];
  const bg = userMsgBgColor();
  const fg = userMsgFgColor();
  assert.deepStrictEqual(linePropsAt(roles, 0), { backgroundColor: bg, color: fg, bold: true });
  assert.equal(linePropsAt(roles, 1), null);
  assert.equal(linePropsAt(roles, 2), null);
  assert.equal(linePropsAt(roles, 3), null);
});

test('linePropsAt: 不传 / 非数组 lineRoles → 恒 null(逐字节回退的硬承诺)', () => {
  // Viewport 在 lineRoles 缺省时对每行都取 null ⇒ 仍是 h(Text, null, …),不加任何 prop。
  for (const absent of [undefined, null, '', 'user', 0, {}]) {
    assert.equal(linePropsAt(absent, 0), null);
    assert.equal(linePropsAt(absent, 7), null);
  }
});

// 思维链折叠块的底色:fold 锚点是第四条(可缺省)实参。这里钉住三件事 ——
//   ① 思维链行(含展开后的正文行)拿到底色;
//   ② 不传 folds(第四个实参缺省)时逐字节回退,连思维链锚点都不上色;
//   ③ 非思维链锚点(overflow)不拿思维链底色。
test('linePropsAt: 思维链行(含展开正文行)拿到暗紫底色', () => {
  const bg = thinkingLineBgColor();
  const bodyRow = { kind: 'thinking', key: 'k', body: true };
  assert.deepStrictEqual(linePropsAt(['assistant'], 0, process.env, [bodyRow]), {
    backgroundColor: bg,
  });
  // 折叠摘要行 / 展开头行(不带 body)同样带底色 —— 收起来的那一小块也要看得见。
  assert.deepStrictEqual(linePropsAt(['assistant'], 0, process.env, [{ kind: 'thinking', key: 'k' }]), {
    backgroundColor: bg,
  });
  // 只给底色,不覆盖字色/加粗:思维链正文仍走既有的 dimColor / cyan 外观。
  assert.deepStrictEqual(Object.keys(linePropsAt(['assistant'], 0, process.env, [bodyRow])), [
    'backgroundColor',
  ]);
});

test('linePropsAt: 不传 folds → 思维链锚点也不上色(逐字节回退)', () => {
  assert.equal(linePropsAt(['assistant'], 0, process.env, null), null);
  assert.equal(linePropsAt(['assistant'], 0, process.env, undefined), null);
  // 用户行仍拿米白盒(role 路径不受 folds 缺省影响)。
  assert.deepStrictEqual(linePropsAt(['user'], 0, process.env, null), {
    backgroundColor: userMsgBgColor(),
    color: userMsgFgColor(),
    bold: true,
  });
});

test('linePropsAt: 非思维链锚点(overflow / null)不拿思维链底色', () => {
  assert.equal(
    linePropsAt(['assistant'], 0, process.env, [{ kind: 'overflow', key: 'k', full: 'x' }]),
    null
  );
  assert.equal(linePropsAt(['assistant'], 0, process.env, [null]), null);
});

test('linePropsAt: 下标越界 / 非数组 folds → 不抛,回退到 role 路径', () => {
  assert.equal(linePropsAt(['user'], 5, process.env, []), null);
  assert.deepStrictEqual(linePropsAt(['user'], 0, process.env, 'nope'), {
    backgroundColor: userMsgBgColor(),
    color: userMsgFgColor(),
    bold: true,
  });
});

test('linePropsAt: 下标越界 / 角色为空 → null,绝不抛', () => {
  assert.equal(linePropsAt(['user'], 5), null);
  assert.equal(linePropsAt([], 0), null);
  assert.equal(linePropsAt(['user'], -1), null);
});

// ── 3. 总闸 ──────────────────────────────────────────────────────────────────

test('userLineTextProps: 总闸关 → 连用户行也不带样式(逐字节回退)', () => {
  const off = { KHY_USER_MSG_WHITE_BG: '0' };
  assert.equal(userLineTextProps('user', off), null);
  // 总闸开(默认)时才出样式
  assert.notEqual(userLineTextProps('user', {}), null);
});

test('userLineTextProps: KHY_USER_MSG_BG/FG 覆写对两条路径同时生效(单一真源)', () => {
  const env = { KHY_USER_MSG_BG: '#EEE8D5', KHY_USER_MSG_FG: '#111111' };
  assert.deepStrictEqual(userLineTextProps('user', env), {
    backgroundColor: '#EEE8D5',
    color: '#111111',
    bold: true,
  });
});
