'use strict';

/**
 * chatChordsHelpSync.test.js — 「?」帮助浮层与 chatChords 实现的双向一致性守卫
 * （[DESIGN-ARCH-147] P1 落地物，node:test，零 IO，落地即绿）。
 *
 * 背景：chatChords.js（键→动作的单一真源纯叶子）接线晚于 keybindingCatalog 的
 * ESSENTIAL 精简表定稿，四键中三键（Meta+P/O/T）漏登在「?」速查浮层里——用户不读
 * 源码就不知道这几个键存在（判据四「易懂」的残余缺口，G-02）。本文件钉住两层：
 *
 *   ① 实现侧 → 目录侧：chatChords 每个可解析的 chord 都能在完整目录 KEYBINDING_CATALOG
 *      中找到同名条目（防「实现有键、目录没登」再次发生）；
 *   ② 目录侧 → 实现侧：ESSENTIAL 精简表中每个「Meta + X」条目经 resolveChatChord
 *      实测解析出非空动作名（防「目录有字、按了没反应」——假承诺比没承诺更糟）。
 *
 * 另钉一条**决策**而非实现：Ctrl+T（任务清单开关）刻意不进精简表。
 * 原登记理由写的是「仅宽屏 ≥120 列可用，防向窄屏用户做假承诺」——2026-11-08 pty 实测否证了
 * 这个前提（100 列与 130 列都生效，见 ⑤），决策本身未撤，但**真实理由待维护者补写**；
 * 未来若想把它加回精简表，应先改这条测试并写明理由——不要静默加。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const chatChords = require('../../../src/cli/tui/chatChords');
const {
  KEYBINDING_CATALOG,
  getEssentialShortcuts,
} = require('../../../src/services/domain/config/keybindings/keybindingCatalog.js');

const EMPTY_ENV = Object.freeze({});

/** 把目录键位串「Meta + X」翻译成 resolveChatChord 的事件形状；非该族返回 null。 */
function chordEventFor(keysLabel) {
  const m = /^Meta \+ ([A-Za-z])$/.exec(String(keysLabel).trim());
  if (!m) return null;
  return { key: { meta: true, ctrl: false }, input: m[1].toLowerCase() };
}

describe('chatChords ↔ 键位目录 双向一致([DESIGN-ARCH-147] G-02)', () => {
  test('① 实现侧：chatChords 每个 chord 在完整目录有同名条目', () => {
    const catalogKeys = new Set(
      KEYBINDING_CATALOG.flatMap((g) => g.bindings).map((b) => b.keys)
    );
    // chatChords 的四个动作与目录标签的对应（键位真源是 resolveChatChord 的分支）。
    const chords = [
      { ev: { key: { meta: true, ctrl: false }, input: 'p' }, label: 'Meta + P' },
      { ev: { key: { meta: true, ctrl: false }, input: 'o' }, label: 'Meta + O' },
      { ev: { key: { meta: true, ctrl: false }, input: 't' }, label: 'Meta + T' },
      { ev: { key: { ctrl: true, meta: false, shift: false }, input: 't' }, label: 'Ctrl + T' },
    ];
    for (const { ev, label } of chords) {
      const action = chatChords.resolveChatChord(ev, EMPTY_ENV);
      assert.ok(action, `chord ${label} 应解析出动作名`);
      assert.ok(catalogKeys.has(label), `chatChords 动作 ${action}(${label}) 未登记进键位目录`);
    }
  });

  test('② 目录侧：ESSENTIAL 每个「Meta + X」条目实测能解析出动作', () => {
    for (const [keys] of getEssentialShortcuts()) {
      const ev = chordEventFor(keys);
      if (!ev) continue;
      const action = chatChords.resolveChatChord(ev, EMPTY_ENV);
      assert.ok(
        action,
        `速查浮层条目「${keys}」按下去没有对应动作——假承诺(诚实红线)`
      );
    }
  });

  test('③ ESSENTIAL 无孤儿：每条键位在完整目录中精确或合并写法可寻', () => {
    // 精简表有历史的合并速记（'Ctrl + A / E'、'Ctrl + K / U'——完整目录里是分开两条,
    // 精简行把它们写成一行）。判据：ESSENTIAL 键位 compact 后,要么与某目录键位 compact
    // 精确相等,要么包含某目录键位 compact 作为子串（合并写法场景）。
    // 'Ctrl + Z' 这类目录里根本不存在的自造键位,两种命中都拿不到 → 红。
    const dirKeys = KEYBINDING_CATALOG.flatMap((g) => g.bindings).map((b) =>
      b.keys.replace(/\s*\+\s*/g, '+')
    );
    for (const [keys] of getEssentialShortcuts()) {
      const k = keys.replace(/\s*\+\s*/g, '+');
      const hit =
        dirKeys.some((d) => d === k) || dirKeys.some((d) => k.includes(d));
      assert.ok(
        hit,
        `精简表条目「${keys}」在完整目录中无可寻条目——速查层不得自造键位`
      );
    }
  });

  test('④ 决策钉：Ctrl+T 不进精简表(条件性键位防误导窄屏)', () => {
    const essential = getEssentialShortcuts().map(([k]) => k);
    assert.ok(
      !essential.includes('Ctrl + T'),
      'Ctrl+T 刻意不进速查表（原登记的「仅宽屏才有反应」已被 pty 否证，见 ⑤；' +
        '要加回请先修订本测试与 [DESIGN-ARCH-147] 实施记录，并写明真实理由）'
    );
    // 但它在完整目录里必须存在(①的补充面：全局用户用 /keybindings 能查到)。
    const global = KEYBINDING_CATALOG.find((g) => g.context === 'global');
    assert.ok(global.bindings.some((b) => b.keys === 'Ctrl + T'));
  });

  test('⑤ Ctrl+T 的目录描述不得宣称宽度门(2026-11-08 pty 实测否证)', () => {
    // 实测：100 列与 130 列各连按四轮，「已隐藏 / 已显示」交替全部生效
    // （works/data/khy/tmp/drive_input_live.js 的 ctrlt 臂；读数存证
    //   works/data/khy/feedback/ctrlt-width-20261108/repro-before.txt）。
    // App.js:6953 的注释同口径："the inline panel is available at every width"。
    // ≥120 那个数属于 threeColumnMode 的**自动开启宽度**（App.js:7614），
    // 与「按 Ctrl+T 有没有反应」是两件事——把它写成键位的条件是假承诺的另一种形态。
    const row = KEYBINDING_CATALOG.flatMap((g) => g.bindings).find(
      (b) => b.keys === 'Ctrl + T'
    );
    assert.ok(row, '缺 Ctrl+T 条目');
    assert.doesNotMatch(
      row.desc,
      /宽屏|≥\s*\d+\s*列/,
      `「${row.desc}」又写回了没有实测支撑的宽度条件`
    );
  });

  test('⑥ 会话记录视图的现场提示条不得比目录少教退出键(2026-11-12 pty 实测)', () => {
    // 视图把每一个键都吃掉(App.js 的 transcript 分支拥有全部输入)，而它的提示条此前只写
    // 「Esc 关闭视图」——目录第 158 行登记着四条退路(Esc / q / Ctrl+C / Ctrl+O)。
    // 本节实测 q 确实能关(强制全屏重绘后 ⊟ 会话记录 那个框不再被画出)，所以至少这两条
    // 必须出现在用户眼前。钉住「现场提示 ⊆ 目录」这个方向，防的是 11-03 §1 那一类漂移：
    // 浮层只教它恰好画出来的那一两个键，把另外几条藏在源码里。
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'src', 'cli', 'tui', 'ink-components', 'TranscriptView.js'),
      'utf8'
    );
    const closer = KEYBINDING_CATALOG.flatMap((g) => g.bindings).find(
      (b) => b.keys === 'Esc / q / Ctrl + C / Ctrl + O'
    );
    assert.ok(closer, '目录缺「关闭视图返回输入框」那行——本条判据没有对照物');
    // 只在提示条那一段里找，且允许中间再列别的退路键（⑥ 管「不少于真源」，
    // 「不许更长」是 ⑦ 的宽度账——两条各管一头，别在这里互相打架）。
    const at = src.indexOf("{ key: 'hint'");
    assert.ok(at > 0, '找不到视图的提示条 —— 本条判据失去对照物');
    const hintBlock = src.slice(at, src.indexOf('\n    )', at));
    assert.match(
      hintBlock,
      /Esc[^']*q[^']*关闭视图/,
      '视图提示条没把 Esc 与 q 两条退路教出来，而目录第 158 行登记了它们：现场教学必须不少于真源'
    );
    for (const k of ['q', 'Ctrl + C', 'Ctrl + O']) {
      assert.ok(closer.keys.includes(k), `目录那行应仍列出 ${k}（本条对照物变了，先核对源码）`);
    }
  });

  test('⑦ 会话记录视图的提示条宽度不得越过 100 列终端的内宽(2026-11-12 实测)', () => {
    // 本节把目录那行四条退路全按到底验了一遍（Ctrl+O / Ctrl+C 由 pty 臂 tview2，
    // 强制全屏重绘定性：两条都能关视图，且 Ctrl+C 在视图内**不会**装填双击退出）。
    // 验完没有把 Ctrl+O 加进提示条，原因不是没想到，而是宽度账：提示条是视图自己
    // 画的一行图例，100 列终端里它的内宽只有 96 格（100 − 左右边框 2 − paddingX 2）。
    // 实测校验过的换算：现状 86 格 → 100 列 1 行、50 列 2 行（§5 的 hintRowCount 就是 1/2）；
    // 再加 'Ctrl+O' 变 93 格仍能 1 行，但 50 列要 3 行；再加 Ctrl+C 变 100 格 → 100 列也开始折行。
    // 折一行意味着这一视图的实际高度比 bodyHeight 的 CHROME_ROWS=12 多占一行——
    // 那条账本车道让给在飞的布局车道，但**图例不再往上堆键**这条底线先钉住。
    const fs = require('node:fs');
    const path = require('node:path');
    const { displayWidth } = require('../../../src/utils/text/width');
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'src', 'cli', 'tui', 'ink-components', 'TranscriptView.js'),
      'utf8'
    );
    const at = src.indexOf("{ key: 'hint'");
    assert.ok(at > 0, '找不到视图的提示条 —— 本条判据失去对照物，先核对源码再改阈值');
    const block = src.slice(at, src.indexOf('\n    )', at));
    // 按内容锚定，不按位置：这一段里除了图例字面量还有 props 的 'hint'/'dimColor'，
    // 而注释里也带引号 —— 上一次用位置下标取，第一条断言就在算「hint+dimColor+尾串」的宽度。
    const grab = (re, what) => {
      const m = re.exec(block);
      assert.ok(m, `提示条里找不到${what} —— 图例形状变了，本条判据要按新形状重述，不许空转`);
      return m[1];
    };
    const base = grab(/'(([^']*滚动一行[^']*))'/, '滚动那段前缀');
    const branches = [...block.matchAll(/'(Ctrl\+E [^']*工具输出)'/g)].map((m) => m[1]);
    assert.equal(branches.length, 2, `Ctrl+E 那一项应有折叠/展开两个分支，实得 ${branches.length} 个`);
    const tail = grab(/'(([^']*关闭视图)*)'/, '退出键那段后缀');
    const wFold = displayWidth(base + branches[0] + tail);
    const wExpand = displayWidth(base + branches[1] + tail);
    assert.equal(wFold, wExpand, '两个分支宽度不等，窄屏会按分支抖动行数');
    assert.ok(
      wExpand <= 96,
      `提示条实测 ${wExpand} 格，超过 100 列终端的 96 格内宽 —— 图例再长就该拆行或换布局，不是继续堆键`
    );
  });
});
