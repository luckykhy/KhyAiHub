'use strict';

/**
 * taskSurface 状态→底色策略单测（DESIGN-ARCH-176 §11 ②）。
 *
 * 钉住三件容易回归的事：
 *  1. 状态判据复用 `taskPanelLines.taskLineStatus`（不另立第二份图标表）
 *  2. `mark` 是**追加的冗余标记**，不是替换行首图标 ⇒ completed/pending 恒无 mark
 *  3. 降级链：色深/明度任一不足 ⇒ 无底色 + 冗余标记，而非硬给一个可能不可读的颜色
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const s = require('../../../src/cli/tui/ink-components/taskSurface.js');
const bg = require('../../../src/cli/tui/theme/ccThemeBg.js');

const LINES = {
  completed: '✓ 读取快照',
  in_progress: '→ 渲染分区标签',
  error: '✗ 高度账本对不齐',
  pending: '○ 接入侧边栏',
};

// ── 状态判据：必须复用既有 SSOT ──────────────────────────────────

test('四态识别正确，且判据来自 taskLineStatus（图标逆映射 SSOT）', () => {
  const tk = bg.backgroundTokens({ colorDepth: 24, backgroundMode: 'dark' });
  for (const [want, line] of Object.entries(LINES)) {
    assert.strictEqual(s.surfaceForLine(line, tk).status, want, `「${line}」应识别为 ${want}`);
  }
});

test('行首非已知图标 → status null，绝不猜状态（诚实保留原行）', () => {
  const tk = bg.backgroundTokens({ colorDepth: 24, backgroundMode: 'dark' });
  for (const bad of ['', 'x 随便一行', '  ', '→', '#13 无图标行', '↑ 别的箭头']) {
    const r = s.surfaceForLine(bad, tk);
    if (bad === '→') continue; // 单字符箭头本身是合法行首
    assert.strictEqual(r.status, null, `「${bad}」不该被猜出状态`);
    assert.strictEqual(r.backgroundColor, null);
    assert.strictEqual(r.mark, '');
  }
});

// ── 底色分配：只给「进行中 / 错误」铺色 ───────────────────────────

test('只有 in_progress 与 error 有底色 token 映射', () => {
  assert.strictEqual(s.SURFACE_BY_STATUS.in_progress, 'bgActive');
  assert.strictEqual(s.SURFACE_BY_STATUS.error, 'bgDanger');
  // completed / pending 刻意不铺：completed 已有删除线，pending 保持弱化
  assert.ok(!('completed' in s.SURFACE_BY_STATUS), 'completed 不该铺底色（与删除线重复降噪）');
  assert.ok(!('pending' in s.SURFACE_BY_STATUS), 'pending 不该铺底色（弱化是刻意设计）');
});

test('真彩色暗底：进行中/错误取到 hex，completed/pending 无底色', () => {
  const tk = bg.backgroundTokens({ colorDepth: 24, backgroundMode: 'dark' });
  assert.match(String(s.surfaceForLine(LINES.in_progress, tk).backgroundColor), /^#/);
  assert.match(String(s.surfaceForLine(LINES.error, tk).backgroundColor), /^#/);
  assert.strictEqual(s.surfaceForLine(LINES.completed, tk).backgroundColor, null);
  assert.strictEqual(s.surfaceForLine(LINES.pending, tk).backgroundColor, null);
});

// ── ★ mark 是追加的冗余标记，不是替换图标 ─────────────────────────

test('★ completed/pending 恒无 mark（否则会出现 `✓ ✓ 重复图标`）', () => {
  // 行文本里已经带了 taskPanelLines.js:16 写入的图标，mark 只能「补充」不能「重报」。
  const none = bg.backgroundTokens({ colorDepth: 1, backgroundMode: 'dark' });
  for (const line of [LINES.completed, LINES.pending]) {
    assert.strictEqual(s.surfaceForLine(line, none).mark, '',
      `「${line}」不应带 mark（行首已有图标）`);
  }
  assert.strictEqual(s.REDUNDANT_MARK.completed, '');
  assert.strictEqual(s.REDUNDANT_MARK.pending, '');
  assert.strictEqual(s.REDUNDANT_MARK.in_progress, '');
});

test('★ error 在无底色时补 `!`（✗ 与 ○ 小字号易混，失败必须被看见）', () => {
  for (const opts of [
    { colorDepth: 1, backgroundMode: 'dark' }, // 无色
    { colorDepth: 24, backgroundMode: 'unknown' }, // 判不出明度
    { colorDepth: 4, backgroundMode: 'light' }, // 16 色 + 亮底（刻意不给状态色）
    { colorDepth: 4, backgroundMode: 'unknown' }, // 16 色 + 判不出明度
  ]) {
    const tk = bg.backgroundTokens(opts);
    assert.strictEqual(s.surfaceForLine(LINES.error, tk).backgroundColor, null,
      `档 ${JSON.stringify(opts)} 应无底色`);
    assert.strictEqual(s.surfaceForLine(LINES.error, tk).mark, '!',
      `档 ${JSON.stringify(opts)} 应补 ! 冗余标记`);
  }
});

test('16 色档：暗底给 cyan/red 状态色，亮底退化为无状态色', () => {
  // ANSI 命名色的实际 RGB 由终端主题决定 ⇒ 亮底不可控 ⇒ 刻意不给（对比度诚实边界）
  const dark = bg.backgroundTokens({ colorDepth: 4, backgroundMode: 'dark' });
  assert.strictEqual(s.surfaceForLine(LINES.in_progress, dark).backgroundColor, 'cyan');
  assert.strictEqual(s.surfaceForLine(LINES.error, dark).backgroundColor, 'red');
  const light = bg.backgroundTokens({ colorDepth: 4, backgroundMode: 'light' });
  assert.strictEqual(s.surfaceForLine(LINES.in_progress, light).backgroundColor, null);
  assert.strictEqual(s.surfaceForLine(LINES.error, light).backgroundColor, null);
  // 但组头中性色在亮底仍保留（分组维度不能一起丢）
  assert.notStrictEqual(s.surfaceForGroup(light), null);
});

test('有底色时不补 mark（不冗余）', () => {
  const tk = bg.backgroundTokens({ colorDepth: 24, backgroundMode: 'dark' });
  assert.strictEqual(s.surfaceForLine(LINES.error, tk).mark, '');
});

test('markFallback:false 可关闭冗余标记', () => {
  const tk = bg.backgroundTokens({ colorDepth: 1, backgroundMode: 'dark' });
  assert.strictEqual(s.surfaceForLine(LINES.error, tk, { markFallback: false }).mark, '');
});

// ── ★ 降级链：任何一维不足都退化为「无底色 + 冗余」 ───────────────

test('★ 降级矩阵：色深/明度任一不足 ⇒ 状态色不出现（逐格钉住）', () => {
  // 期望矩阵：(色深, 明度) → in_progress/error 是否应有底色。
  // ⚠ ansi256(8) 与 truecolor(24) 同用 HEX 表（256 能表示 24 位色，对比度可控）
  //   ⇒ 两者的 dark/light 都有状态色；只有 unknown 明度才退。
  // ⚠ 16 色(4) 不同：ANSI 命名色的实际 RGB 由终端主题决定，亮底不可控
  //   ⇒ 亮底档刻意不给状态色（ccThemeBg.js ANSI16.light）。
  const CASES = [
    [24, 'dark', true], [24, 'light', true], [24, 'unknown', false],
    [8, 'dark', true], [8, 'light', true], [8, 'unknown', false],
    [4, 'dark', true], [4, 'light', false], [4, 'unknown', false],
    [1, 'dark', false], [1, 'light', false], [1, 'unknown', false],
  ];
  for (const [depth, mode, expectColor] of CASES) {
    const tk = bg.backgroundTokens({ colorDepth: depth, backgroundMode: mode });
    for (const line of [LINES.in_progress, LINES.error]) {
      const r = s.surfaceForLine(line, tk);
      const has = r.backgroundColor != null;
      assert.strictEqual(has, expectColor,
        `depth=${depth} mode=${mode} 「${line}」底色应为 ${expectColor ? '有' : '无'}，实得 ${r.backgroundColor}`);
      // 无底色 ⇒ 必须有 mark 兜底（error）；有底色 ⇒ 无 mark
      if (!expectColor && line === LINES.error) {
        assert.strictEqual(r.mark, '!', `depth=${depth} mode=${mode} error 应有冗余标记`);
      }
    }
  }
});

// ── 组头底色：与状态底色是两个独立维度 ────────────────────────────

test('组头用中性底色，与状态底色区分开', () => {
  const tk = bg.backgroundTokens({ colorDepth: 24, backgroundMode: 'dark' });
  const subtle = s.surfaceForGroup(tk);
  const head = s.surfaceForGroup(tk, 'head');
  assert.match(String(subtle), /^#/);
  assert.match(String(head), /^#/);
  // 组头色不应等于状态色（否则「属于哪组」与「什么状态」混成一个维度）
  const active = s.surfaceForLine(LINES.in_progress, tk).backgroundColor;
  assert.notStrictEqual(subtle, active, '组头底色不应与进行中底色相同');
});

test('无色档组头返 null（不设 backgroundColor）', () => {
  const tk = bg.backgroundTokens({ colorDepth: 1, backgroundMode: 'dark' });
  assert.strictEqual(s.surfaceForGroup(tk), null);
  assert.strictEqual(s.surfaceForGroup(tk, 'head'), null);
});

// ── 批量接口 ──────────────────────────────────────────────────────

test('surfaceAll 逐行映射，不改入参', () => {
  const tk = bg.backgroundTokens({ colorDepth: 24, backgroundMode: 'dark' });
  const input = Object.values(LINES);
  const snapshot = JSON.stringify(input);
  const out = s.surfaceAll(input, tk);
  assert.strictEqual(out.length, input.length);
  for (let i = 0; i < input.length; i++) {
    assert.strictEqual(out[i].line, input[i], 'line 应原样保留');
  }
  assert.strictEqual(JSON.stringify(input), snapshot, '入参数组被改动了');
  assert.deepStrictEqual(out.map((o) => o.status),
    ['completed', 'in_progress', 'error', 'pending']);
});

// ── 铁律 ──────────────────────────────────────────────────────────

test('铁律：任何畸形入参都不抛', () => {
  const tk = bg.backgroundTokens({ colorDepth: 24, backgroundMode: 'dark' });
  for (const bad of [null, undefined, 0, '', [], NaN, {}, Symbol.iterator]) {
    assert.doesNotThrow(() => s.surfaceForLine(bad, tk), `line=${String(bad)} 不该抛`);
    assert.doesNotThrow(() => s.surfaceForGroup(bad), `tokens=${String(bad)} 不该抛`);
    assert.doesNotThrow(() => s.surfaceAll(bad, tk), `lines=${String(bad)} 不该抛`);
  }
  assert.doesNotThrow(() => s.surfaceForLine(LINES.error, Symbol.iterator));
  assert.doesNotThrow(() => s.surfaceForLine(LINES.error, null, Symbol.iterator));
});

test('铁律：tokens 缺失时全部退化为无底色（不抛、不猜）', () => {
  for (const t of [null, undefined, 0, '', 'x', {}]) {
    for (const line of Object.values(LINES)) {
      const r = s.surfaceForLine(line, t);
      assert.strictEqual(r.backgroundColor, null, `tokens=${String(t)} 应无底色`);
    }
  }
});

test('铁律：源码零 process.env（env 由 App 层解析后传入）', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../../src/cli/tui/ink-components/taskSurface.js'), 'utf8');
  const hits = src.match(/process\.env/g) || [];
  assert.strictEqual(hits.length, 0, `叶子读 env 会让单测失去确定性，实得 ${hits.length} 处`);
});

test('铁律：不另立第二份图标表（GLYPH 常量不得存在）', () => {
  // 图标字面量的唯一真源是 taskPanelLines.js:16 的 STATUS_ICON。
  // 本层若再声明一份 GLYPH 图标表，就会出现「改了 A 没改 B」的漂移。
  const src = fs.readFileSync(
    path.join(__dirname, '../../../src/cli/tui/ink-components/taskSurface.js'), 'utf8');
  assert.ok(!/\bGLYPH\b/.test(src), '不得引入 GLYPH 图标表（与 taskPanelLines 重复真源）');
  // ⚠ 断言导出契约用 require 拿真值，不用 `'X' in src`（in 不能用于原始字符串）
  assert.ok(Object.prototype.hasOwnProperty.call(s, 'REDUNDANT_MARK'),
    '应导出 REDUNDANT_MARK（追加标记，非图标表）');
  assert.ok(!Object.prototype.hasOwnProperty.call(s, 'GLYPH'),
    '不应导出 GLYPH');
});
