'use strict';

/**
 * ccThemeBg 降级矩阵单测（DESIGN-ARCH-176 §11 ②）。
 *
 * 为什么必须显式构造全部档位：开发机通常是**暗色真彩色**，
 * 降级路径的 bug 在本机**看不出来**（§3.4.3 第③层的存在意义正是此）。
 *
 * 覆盖：色深 4 档 × 明度 3 档，外加畸形输入与「绝不读 env」两条铁律。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const bg = require('../../../src/cli/tui/theme/ccThemeBg.js');

const TOKEN_NAMES = ['bgHead', 'bgSubtle', 'bgActive', 'bgDanger', 'bgMuted'];

// ── 形状契约：每档固定 5 键，null 表示「不设底色」而非缺键 ──────────

test('每档都返回全部 5 个 token 键，缺失即契约破坏', () => {
  for (const depth of [1, 4, 8, 24]) {
    for (const mode of ['dark', 'light', 'unknown']) {
      const t = bg.backgroundTokens({ colorDepth: depth, backgroundMode: mode });
      assert.deepStrictEqual(
        Object.keys(t).sort(),
        TOKEN_NAMES.slice().sort(),
        `depth=${depth} mode=${mode} 键集不符`
      );
    }
  }
});

test('返回值被冻结：消费方改不动，且每次调用返回新对象（不共享可变状态）', () => {
  const a = bg.backgroundTokens({ colorDepth: 24, backgroundMode: 'dark' });
  assert.ok(Object.isFrozen(a), '返回值应被冻结');
  assert.ok(Object.isFrozen(bg.TOKEN_NAMES), 'TOKEN_NAMES 应被冻结');
  // 刻意断言「不同引用」：本层每次返回新对象（不改入参铁律的延伸），
  // 消费方拿到后无法通过改返回值影响他人。
  const b = bg.backgroundTokens({ colorDepth: 24, backgroundMode: 'dark' });
  assert.notStrictEqual(a, b, '两次调用应返回不同对象引用');
  assert.deepStrictEqual({ ...a }, { ...b }, '但内容必须一致（确定性）');
});

// ── 降级矩阵：色深 × 明度 ─────────────────────────────────────────

test('无色档（NO_COLOR / depth<=1）：全部 null，消费方不设 backgroundColor', () => {
  for (const depth of [1, 0, -1, undefined, null, NaN, 'x']) {
    const t = bg.backgroundTokens({ colorDepth: depth, backgroundMode: 'dark' });
    for (const k of TOKEN_NAMES) {
      assert.strictEqual(t[k], null, `depth=${String(depth)} 的 ${k} 应为 null`);
    }
  }
});

test('16 色档：显式给 ANSI 命名色，不返回 hex（不得把 hex 丢给 chalk 猜）', () => {
  const t = bg.backgroundTokens({ colorDepth: 4, backgroundMode: 'dark' });
  for (const k of TOKEN_NAMES) {
    if (t[k] === null) continue; // unknown 档的状态色本就是 null
    assert.ok(
      !/^#/.test(String(t[k])),
      `16 色档 ${k} 不应是 hex（实得 ${t[k]}）——ccTheme.js:158 的坑正是这里`
    );
  }
});

test('★ 16 色 + 亮底：不给状态色（ANSI 命名色对比度不可控，诚实退化）', () => {
  // ANSI 命名色的实际 RGB 由**终端主题**决定，chalk 无法保证对比度。
  // 亮底 + cyan/red 底可能糊 ⇒ 刻意不给，让状态区分落回 taskSurface 的冗余标记。
  const light = bg.backgroundTokens({ colorDepth: 4, backgroundMode: 'light' });
  assert.strictEqual(light.bgActive, null, '16 色亮底不该给状态底色');
  assert.strictEqual(light.bgDanger, null, '16 色亮底不该给状态底色');
  // 但分组中性色保留（「属于哪组」这个维度不能一起丢）
  assert.notStrictEqual(light.bgSubtle, null);
  assert.notStrictEqual(light.bgHead, null);
  // 暗底仍给（暗底上 cyan/red 与默认浅色字对比度稳定）
  const dark = bg.backgroundTokens({ colorDepth: 4, backgroundMode: 'dark' });
  assert.strictEqual(dark.bgActive, 'cyan');
  assert.strictEqual(dark.bgDanger, 'red');
});

test('真彩色档：返回 hex，且暗/亮两组取值不同', () => {
  const dark = bg.backgroundTokens({ colorDepth: 24, backgroundMode: 'dark' });
  const light = bg.backgroundTokens({ colorDepth: 24, backgroundMode: 'light' });
  for (const k of TOKEN_NAMES) {
    assert.match(String(dark[k]), /^#[0-9a-f]{6}$/i, `暗底 ${k} 应为 6 位 hex`);
    assert.match(String(light[k]), /^#[0-9a-f]{6}$/i, `亮底 ${k} 应为 6 位 hex`);
    assert.notStrictEqual(dark[k], light[k], `${k} 在暗/亮下不应同值`);
  }
});

test('ansi256(8) 与 truecolor(24) 共用 hex 表（256 能表示 24 位色）', () => {
  const a = bg.backgroundTokens({ colorDepth: 8, backgroundMode: 'dark' });
  const b = bg.backgroundTokens({ colorDepth: 24, backgroundMode: 'dark' });
  assert.deepStrictEqual({ ...a }, { ...b });
});

// ── ★ unknown 档的核心断言（DESIGN-ARCH-176 §3.4.3 第③层）──────────

test('★ unknown 档：禁用彩色状态底色，状态区分交给字形', () => {
  for (const depth of [4, 8, 24]) {
    const t = bg.backgroundTokens({ colorDepth: depth, backgroundMode: 'unknown' });
    assert.strictEqual(t.bgActive, null, `depth=${depth}: unknown 档 bgActive 必须 null`);
    assert.strictEqual(t.bgDanger, null, `depth=${depth}: unknown 档 bgDanger 必须 null`);
    // 分组底色保留（它是「双背景都安全」的中性色）
    assert.notStrictEqual(t.bgSubtle, null, `depth=${depth}: unknown 档仍应有分组底色`);
  }
});

test('unknown 档的分组底色是双背景安全的中性色（非蓝非红）', () => {
  for (const depth of [4, 8, 24]) {
    const t = bg.backgroundTokens({ colorDepth: depth, backgroundMode: 'unknown' });
    const v = String(t.bgSubtle).toLowerCase();
    const risky = ['blue', 'red', 'magenta', '#0000', '#ff0000'];
    for (const bad of risky) {
      assert.ok(!v.includes(bad), `unknown 档 bgSubtle 不该是 ${bad}（实得 ${v}）`);
    }
  }
});

test('缺省 / 畸形明度一律落 unknown，绝不猜 dark', () => {
  for (const mode of [undefined, null, '', 'garbage', 0, {}, 'DARKX']) {
    const t = bg.backgroundTokens({ colorDepth: 24, backgroundMode: mode });
    const ref = bg.backgroundTokens({ colorDepth: 24, backgroundMode: 'unknown' });
    assert.deepStrictEqual({ ...t }, { ...ref }, `mode=${String(mode)} 应落 unknown`);
  }
});

// ── resolveBackgroundMode：诚实边界（§3.4.1）─────────────────────

test('resolveBackgroundMode：COLORFGBG 末段 ≥7 判亮，否则判暗', () => {
  assert.strictEqual(bg.resolveBackgroundMode({ colorfgbg: '0;15' }), 'light');
  assert.strictEqual(bg.resolveBackgroundMode({ colorfgbg: '15;0' }), 'dark');
  assert.strictEqual(bg.resolveBackgroundMode({ colorfgbg: '0;7' }), 'light');
  assert.strictEqual(bg.resolveBackgroundMode({ colorfgbg: '0;6' }), 'dark');
});

test('resolveBackgroundMode：★ 畸形/缺失一律 unknown —— 不猜 dark', () => {
  // 这条是本仓实测的教训：terminalCapabilities.js:79 兜底恒判 dark，
  // 而 Windows Terminal 并不设 COLORFGBG ⇒ 亮色用户必然被误判。
  for (const c of [
    { colorfgbg: 'garbage' },
    { colorfgbg: '' },
    {},
    { colorfgbg: 'abc;xyz' },
  ]) {
    assert.strictEqual(
      bg.resolveBackgroundMode(c), 'unknown',
      `${JSON.stringify(c)} 应判 unknown 而非 dark`
    );
  }
});

test('★ resolveBackgroundMode：三段式 `fg;default;bg` 判 unknown（回归）', () => {
  // 真实缺陷（E0 实施时由单测抓出）：xterm 约定不可知时该位写 `default`。
  // 若只取末段数字，`15;default;0` 会被读成 dark —— 正是本层要根治的误判。
  assert.strictEqual(bg.resolveBackgroundMode({ colorfgbg: '15;default;0' }), 'unknown');
  assert.strictEqual(bg.resolveBackgroundMode({ colorfgbg: '0;default;15' }), 'unknown');
  // 中段带 default 时，末段无论几都不采信
  assert.strictEqual(bg.resolveBackgroundMode({ colorfgbg: 'default;default;7' }), 'unknown');
  // 对照：两段式无 default 仍按数字判（不回归正常路径）
  assert.strictEqual(bg.resolveBackgroundMode({ colorfgbg: '15;0' }), 'dark');
  assert.strictEqual(bg.resolveBackgroundMode({ colorfgbg: '0;15' }), 'light');
});

test('resolveBackgroundMode：Apple_Terminal 判亮（唯一的显式 light 来源）', () => {
  assert.strictEqual(bg.resolveBackgroundMode({ termProgram: 'Apple_Terminal' }), 'light');
  assert.strictEqual(bg.resolveBackgroundMode({ termProgram: 'apple_terminal' }), 'light');
});

// ── 铁律：绝不读 env / 绝不抛 / 不改入参 ───────────────────────────

test('★ 铁律：源码零 process.env（env 只能由 App 层解析后传入）', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../../src/cli/tui/theme/ccThemeBg.js'),
    'utf8'
  );
  const hits = src.match(/process\.env/g) || [];
  assert.strictEqual(hits.length, 0, `叶子读 env 会让单测失去确定性，实得 ${hits.length} 处`);
});

test('铁律：任何畸形入参都不抛', () => {
  for (const bad of [null, undefined, 0, '', [], NaN, { colorDepth: {} }, { backgroundMode: [] }]) {
    assert.doesNotThrow(
      () => bg.backgroundTokens(bad),
      `入参 ${JSON.stringify(bad)} 不该抛`
    );
  }
  assert.doesNotThrow(() => bg.resolveBackgroundMode(null));
});

test('★ 铁律：Symbol / BigInt 入参不抛（回归：Number(symbol) 会 TypeError）', () => {
  // 真实缺陷（E0 实施时由单测抓出）：`Number(Symbol.iterator)` 抛 TypeError，
  // 而本层铁律是「绝不抛」——面板渲染在热路径上，一个 Symbol 就能连带 TUI。
  assert.doesNotThrow(() => bg.normalizeDepth(Symbol.iterator));
  assert.doesNotThrow(() => bg.normalizeMode(Symbol.iterator));
  assert.doesNotThrow(() => bg.backgroundTokens({ colorDepth: Symbol.iterator }));
  assert.doesNotThrow(() => bg.backgroundTokens({ backgroundMode: Symbol.iterator }));
  assert.doesNotThrow(() => bg.backgroundTokens(Symbol.iterator));
  assert.doesNotThrow(() => bg.resolveBackgroundMode({ colorfgbg: Symbol.iterator }));
  // 挡下后应落无色档（而非抛）
  assert.strictEqual(bg.normalizeDepth(Symbol.iterator), 1);
  assert.strictEqual(bg.normalizeMode(Symbol.iterator), 'unknown');
  assert.strictEqual(bg.resolveBackgroundMode({ colorfgbg: Symbol.iterator }), 'unknown');
});

test('铁律：不改入参（入参对象保持原样）', () => {
  const input = { colorDepth: 24, backgroundMode: 'dark' };
  const snapshot = JSON.stringify(input);
  bg.backgroundTokens(input);
  assert.strictEqual(JSON.stringify(input), snapshot, '入参被改动了');
});

test('bg() 单键取值：未知键名与 null 键名一律 null，不抛', () => {
  const t = bg.backgroundTokens({ colorDepth: 24, backgroundMode: 'dark' });
  assert.match(String(bg.bg(t, 'bgActive')), /^#/);
  assert.strictEqual(bg.bg(t, 'nope'), null);
  assert.strictEqual(bg.bg(t, null), null);
  assert.strictEqual(bg.bg(t, undefined), null);
  assert.strictEqual(bg.bg(null, 'bgActive'), null);
  assert.strictEqual(bg.bg('not-an-object', 'bgActive'), null);
});

test('normalizeDepth 分档边界：<8 归 16 色，≥8 归 256/真彩', () => {
  assert.strictEqual(bg.normalizeDepth(1), 1);
  assert.strictEqual(bg.normalizeDepth(4), 4);
  assert.strictEqual(bg.normalizeDepth(7), 4);
  assert.strictEqual(bg.normalizeDepth(8), 8);
  assert.strictEqual(bg.normalizeDepth(23), 8);
  assert.strictEqual(bg.normalizeDepth(24), 24);
  assert.strictEqual(bg.normalizeDepth(255), 24);
});

test('确定性：同参数重复调用结果一致（纯叶子，无 IO 无随机）', () => {
  for (const depth of [1, 4, 8, 24]) {
    for (const mode of ['dark', 'light', 'unknown']) {
      const a = bg.backgroundTokens({ colorDepth: depth, backgroundMode: mode });
      const b = bg.backgroundTokens({ colorDepth: depth, backgroundMode: mode });
      assert.deepStrictEqual({ ...a }, { ...b });
    }
  }
});
