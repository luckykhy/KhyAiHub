'use strict';

/**
 * keybindingCatalog.test.js — 纯叶子键位目录契约(node:test,零 IO)。
 *
 * 锁定:分组目录结构;`?` 浮层精简视图(ESSENTIAL_SHORTCUTS)与 HelpMenu 历史 15 条逐字节一致
 * (防 HelpMenu 收敛后视觉回归);selectCatalog 按上下文/查询过滤;formatCatalog 确定性对齐渲染;
 * 门控 isEnabled;防呆。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  KEYBINDING_CATALOG,
  ESSENTIAL_SHORTCUTS,
  getEssentialShortcuts,
  selectCatalog,
  formatCatalog,
  isEnabled,
} = require('../../../src/services/domain/config/keybindings/keybindingCatalog.js');

describe('完整目录结构', () => {
  test('每组有 context/label/非空 bindings,每条有 keys/desc', () => {
    assert.ok(Array.isArray(KEYBINDING_CATALOG) && KEYBINDING_CATALOG.length >= 5);
    for (const g of KEYBINDING_CATALOG) {
      assert.equal(typeof g.context, 'string');
      assert.equal(typeof g.label, 'string');
      assert.ok(Array.isArray(g.bindings) && g.bindings.length > 0);
      for (const b of g.bindings) {
        assert.equal(typeof b.keys, 'string');
        assert.equal(typeof b.desc, 'string');
        assert.ok(b.keys.length > 0 && b.desc.length > 0);
      }
    }
  });
  test('包含真实处理器的关键上下文', () => {
    const ctxs = KEYBINDING_CATALOG.map((g) => g.context);
    for (const c of ['global', 'editing', 'navigation', 'executing', 'completion', 'entrypoints', 'vim']) {
      assert.ok(ctxs.includes(c), `缺上下文 ${c}`);
    }
  });
  test('回合执行中:方向键的第二套绑定必须与 arrowRouting 一致', () => {
    // ↑/↓ 在执行中变义(arrowRouting 的 executing context:↓ 开实时输出副屏、↑ 取回排队消息)。
    // 目录不说这一套,用户查 /keybindings 得到的是一份「执行中会按错的说明书」。
    const exec = KEYBINDING_CATALOG.find((g) => g.context === 'executing');
    assert.ok(exec, '缺 executing 上下文(回合执行中的方向键绑定无处可查)');
    const keys = exec.bindings.map((b) => b.keys);
    for (const k of ['↓', '↑', '←']) assert.ok(keys.includes(k), `回合执行中缺 ${k} 绑定`);
    const down = exec.bindings.find((b) => b.keys === '↓');
    assert.match(down.desc, /实时输出/, '↓ 的说明必须点明它打开的是实时输出副屏');
    assert.match(down.desc, /不响应/, '↓ 的说明必须交代「本回合还没有工具调用」时的行为');
    const up = exec.bindings.find((b) => b.keys === '↑');
    assert.match(up.desc, /排队/, '↑ 的说明必须点明它取回的是排队消息');
  });
  test('CC 对齐:新增 chat chord 组(Meta+P/O/T)与 global Ctrl+T', () => {
    const chat = KEYBINDING_CATALOG.find((g) => g.context === 'chat');
    assert.ok(chat, '缺 chat 上下文');
    const chatKeys = chat.bindings.map((b) => b.keys);
    assert.ok(chatKeys.includes('Meta + P'), '缺 Meta+P 模型选择器');
    assert.ok(chatKeys.includes('Meta + O'), '缺 Meta+O fast');
    assert.ok(chatKeys.includes('Meta + T'), '缺 Meta+T thinking');
    const global = KEYBINDING_CATALOG.find((g) => g.context === 'global');
    assert.ok(global.bindings.some((b) => b.keys === 'Ctrl + T'), '缺 global Ctrl+T 任务清单');
  });
});

describe('?  浮层精简视图(防 HelpMenu 收敛后回归)', () => {
  // 与 HelpMenu.js 历史内联 SHORTCUTS 逐字节一致:键位收敛后浮层不得有任何视觉漂移。
  // 唯一一处**有意**改动:Ctrl+O 从「就地展开最后一条」改绑为「打开会话记录视图」
  // (对齐 CC 的 app:toggleTranscript,门控 KHY_TRANSCRIPT_VIEW),文案随之更新 ——
  // 这是键位语义真的变了,不是漂移。其余 14 条仍逐字节钉死。
  //
  // 第二处有意改动(BUG-35, 2026-09-21):第 2 条从「Shift/Alt + Enter」改为「Ctrl + J」。
  // 真终端逐键实测(Windows Terminal 1.24)：Shift+Enter 与 Enter 送同一串 `\r`(会直接发送),
  // Ctrl+Enter 零字节(终端自用为全屏),Alt+Enter 只送回一个孤立 ESC(终端自用为全屏)——
  // 三条全是假承诺;唯一稳定送达并插入换行的是 Ctrl+J(裸 LF)。收窄到本机真能按出来的那一集,
  // 不是漂移。
  //
  // 第三处有意改动([DESIGN-ARCH-147] P1, 2026-09-24):15 → 18,在 Shift+Tab 后补
  // chatChords 三键(Meta+P/O/T)。chatChords 接线晚于本精简表定稿,四键中三键
  // (模型选择器/fast/thinking)是无条件可用的对话级高频操作,漏登即「读源码才知道的快捷键」;
  // Ctrl+T 因「仅宽屏 ≥120 列」的条件性(见完整目录 global 组)不入精简表,防误导窄屏用户。
  // 代价如实登记:80×24 下浮层从「15 条全显」变为「14 条 + 另有 4 条指针」(BUG-58 收缩
  // 机制按设计接管,helpMenuSize.test.js 的 80×24 断言已同步更新)。
  // 第四处有意改动(2026-10-09,用户反馈「执行过程中的下键不知道搞什么的」):第 5 条补上
  // ↑/↓ 在执行中的第二套含义。此前浮层只说「逐条浏览历史 / 在菜单中移动」,而回合执行中
  // 且输入框为空时 ↓ 其实是打开实时输出副屏、↑ 是取回排队消息 —— 用户按文档理解按键,
  // 得到的却是另一件事。条数不变(仍 18 条),只把这一句说全;执行中的完整四条见完整目录
  // 新增的「回合执行中(输入框为空)」组。
  const LEGACY = [
    ['Enter', '发送消息'],
    ['Ctrl + J', '换行（多行输入）'],
    ['/', '斜杠命令菜单'],
    ['@', '引用文件路径'],
    // Stage 2 有意变更:门控退役后 ↑/↓ 无条件逐条回溯,文案随之说清「逐条」。
    ['↑ / ↓', '逐条浏览历史 / 菜单中移动（执行中 ↓ 看实时输出）'],
    ['Tab', '接受补全'],
    ['Shift + Tab', '切换权限模式'],
    ['Meta + P', '打开模型选择器'],
    ['Meta + O', '切换快速模式'],
    ['Meta + T', '切换扩展思考'],
    ['Ctrl + C', '取消当前回合 / 退出'],
    ['Ctrl + O', '打开会话记录视图(滚动回看 / 展开)'],
    // 第五处有意改动(2026-11-12 夜检 §4):「清屏」→「清空本会话记录」。
    ['Ctrl + L', '清空本会话记录'],
    ['Ctrl + A / E', '行首 / 行尾'],
    ['Ctrl + W', '删除前一个词'],
    ['Ctrl + K / U', '删除到行尾 / 行首'],
    ['Esc', '关闭菜单'],
    ['?', '显示/隐藏本帮助'],
  ];
  test('getEssentialShortcuts 与基线 18 条逐字节一致', () => {
    const got = getEssentialShortcuts().map((p) => [p[0], p[1]]);
    assert.deepEqual(got, LEGACY);
  });
  test('ESSENTIAL_SHORTCUTS 与 getEssentialShortcuts 同源', () => {
    assert.equal(getEssentialShortcuts(), ESSENTIAL_SHORTCUTS);
  });
});

describe('打开型键位必须说出怎么离开(2026-11-05 真源守卫)', () => {
  // 目录里有**两条** `?` 行(global 组与 输入入口 组),先前只有前者写「显示/隐藏」，
  // 后者只写一个名词「键盘快捷键」。而实测面板有两条出口(Esc 关闭、空输入框再按 ? 收起,
  // 均由 pty 真实重绘证实),其中 Esc 在整个目录里无处可查 —— 直到把它写进 输入入口 那行。
  // 钉住「每一条 ? 行的描述都说出一种退路」,防止再出现只说开门不说关门的那一格。
  const rows = KEYBINDING_CATALOG.flatMap((g) => g.bindings).filter((b) => b.keys === '?');
  test('存在 ? 条目可供校验(且确有两条)', () => {
    assert.equal(rows.length, 2, '目录里的 ? 行数量变了,守卫要看住两侧');
  });
  test('每条 ? 行都必须言明退出路径', () => {
    for (const b of rows) {
      assert.match(
        b.desc,
        /关闭|收起|隐藏/,
        `组内「${b.desc}」只说了按它干什么,没说怎么出去`
      );
    }
  });
});

describe('目录条目不得宣称终端送不出的键位(BUG-35 真源守卫)', () => {
  // 这个目录此前只对着「处理器有没有这条分支」核对,没对「终端送不送得出这个字节」
  // 核对,于是浮层宣称的 Shift+Enter / Ctrl+Enter 换行在 Windows Terminal 上是假承诺
  // (实测:Shift+Enter 与 Enter 同送 `\r` 会直接发送;Ctrl+Enter 零字节,被终端自用为全屏)。
  // 守卫只钉住已被实测否定的那一类:凡键位名里带 Shift/Ctrl + Enter,描述必须言明
  // 它依赖 kitty/CSI-u 键协议,否则就是又一次「代码里能跑、按出来不是那回事」。
  const ENTER_ROWS = KEYBINDING_CATALOG.flatMap((g) => g.bindings).filter((b) =>
    /Enter/i.test(b.keys)
  );

  test('存在被实测否定的 Enter 条目可供校验', () => {
    assert.ok(ENTER_ROWS.some((b) => /Shift|Ctrl/i.test(b.keys)));
  });

  test('Shift/Ctrl + Enter 条目必须标注 CSI-u 依赖', () => {
    for (const b of ENTER_ROWS) {
      if (!/Shift|Ctrl/i.test(b.keys)) continue;
      assert.ok(
        /CSI-u|kitty/i.test(b.desc),
        `条目「${b.keys}」未标注终端协议依赖 —— 多数终端送不出可区分的字节`
      );
    }
  });

  test('Alt + Enter 条目必须言明其在 Windows Terminal 上不可用', () => {
    const alt = ENTER_ROWS.find((b) => /^Alt \+ Enter$/.test(b.keys));
    assert.ok(alt, '缺 Alt+Enter 条目(该组合常被终端自用,须说清前提)');
    assert.match(alt.desc, /不可用|仅当/);
    assert.match(alt.desc, /全屏|ESC/);
  });

  test('Ctrl + J 是本机实测唯一稳定可用的换行组合键', () => {
    const all = KEYBINDING_CATALOG.flatMap((g) => g.bindings);
    const ctrlJ = all.find((b) => /^Ctrl \+ J$/.test(b.keys));
    assert.ok(ctrlJ, '缺 Ctrl+J 条目(裸 LF → 插入换行,实测可用)');
    assert.match(ctrlJ.desc, /换行/);
    // 浮层那一行也必须与目录同源:钉在 ESSENTIAL_SHORTCUTS 第 2 条。
    assert.deepEqual(
      getEssentialShortcuts()[1].map((s) => s),
      ['Ctrl + J', '换行（多行输入）']
    );
    // 不得再出现把 Shift 与 Enter 换行并列为「本机可用」的合并写法。
    for (const b of ENTER_ROWS) {
      assert.doesNotMatch(b.keys, /Shift\s*\/\s*Alt/, `合并写法「${b.keys}」又把 Shift 许诺了出去`);
    }
  });
});

describe('目录条目不得宣称应用层收不到的功能键(2026-11-09 实测否证 F2)', () => {
  // 上一段守的是「终端送不送得出这个字节」。这一段守它**后面那一环**:字节到了 ink
  // 手里还剩什么。ink 6.x 的 useInput 不把手上的键名交给处理器——它把 parseKeypress 的
  // 结果重装成一个固定形状的对象(字段名表里没有 name),再用 nonAlphanumericKeys 把
  // 功能键的 sequence 清成空串。于是 App.js 里那条 `key.name === 'f2'` 分支永不可达。
  // 真机:三种 F2 编码 `\eOQ` / `\e[12~` / `\e[[B` 逐条按过(parity 见
  // works/data/khy/feedback/f2-delivery-20261109/repro-before.txt),屏幕零反应。
  // 10-03 §4 只核到「parse-keypress 把 ESC O Q 解析成 name='f2'」就登记了这条,少核了
  // 这一环 ⇒ 面板教的是一个应用收不到的键。这一段的判据读的是 ink 的 shipped 源码,
  // 不是我的转述:哪天 ink 真的把 name 透出来,第一段会红,提示重测而不是提示相信注释。
  const fs = require('node:fs');
  const path = require('node:path');
  const USE_INPUT = path.resolve(
    __dirname,
    '../../../node_modules/ink/build/hooks/use-input.js'
  );
  const keyShape = () => {
    const src = fs.readFileSync(USE_INPUT, 'utf8');
    const at = src.indexOf('const key = {');
    assert.ok(at >= 0, `在 ${USE_INPUT} 里找不到 useInput 组装 key 的那一段 —— ink 换了形状,本段判据需重估`);
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(open, i + 1);
      }
    }
    throw new Error('use-input.js 的 key 字面量花括号不配对');
  };

  test('ink 交给处理器的 key 对象里没有 name 字段(可达性的外部前提)', () => {
    assert.doesNotMatch(
      keyShape(),
      /(^|[\s{,])name\s*:/,
      'ink 的 useInput 开始透出 key.name 了 —— 重测 F2 后再决定要不要恢复功能键条目'
    );
  });

  test('目录里没有任何功能键条目', () => {
    const rows = KEYBINDING_CATALOG.flatMap((g) => g.bindings).filter((b) => /F\d/.test(b.keys));
    assert.deepEqual(
      rows.map((b) => b.keys),
      [],
      `功能键在本机不可达(见本段说明),却又被许诺了出去:${rows.map((b) => b.keys).join('、')}`
    );
  });

  test('正对照:目录仍在,不是靠空表通过上一条', () => {
    const all = KEYBINDING_CATALOG.flatMap((g) => g.bindings);
    assert.ok(all.length >= 60, `目录只剩 ${all.length} 条,上一条断言就成了空转`);
    assert.ok(all.some((b) => b.keys === 'Shift + Tab'), '全局组应仍有可按键位');
  });
});

describe('Ctrl+L 不得再自称清屏(2026-11-12 强制重绘判据实测)', () => {
  // 判据链(别再回到「字节流里有这行 = 屏幕上有这行」，那个假设错过两次)：
  //   · 状态侧：pty 臂 ctrll3 按完 Ctrl+L 后强制全屏重绘(resize)，「已取消模型选择」那行
  //     **不回来** ⇒ 记录确实被清了(默认内联模式与 KHY_INLINE_TRANSCRIPT=0 两种都如此)。
  //   · 屏幕侧：六份会话日志里 ESC[2J 只出现 1 次、且落在第 22 字节(启动，早于任何按键)，
  //     ESC[3J 零次 ⇒ **没有任何键做过终端清屏**，/clear 也没有(它的 app.clear() 只是
  //     log-update 抹掉 live 区再重排)。所以「清屏」这两个字对本仓是一条做不到的承诺。
  const row = KEYBINDING_CATALOG.flatMap((g) => g.bindings).find((b) => b.keys === 'Ctrl + L');
  const essential = getEssentialShortcuts().find((p) => p[0] === 'Ctrl + L');

  test('完整目录的 Ctrl+L 行不得称清屏，且要给出真正清上下文的那条路', () => {
    assert.ok(row, '缺 Ctrl+L 条目');
    assert.doesNotMatch(row.desc, /清屏/, `「${row.desc}」又把本仓做不到的动作许诺了出去`);
    assert.match(row.desc, /回滚|终端/, `「${row.desc}」没说清它不动终端回滚，用户会以为内容没了`);
    assert.match(row.desc, /\/clear/, `「${row.desc}」没指出真正清 AI 上下文的入口(Ctrl+L 不调 ai.clearHistory)`);
  });

  test('? 浮层的 Ctrl+L 短标签不得称清屏', () => {
    assert.ok(essential, '精简视图缺 Ctrl+L 行');
    assert.doesNotMatch(essential[1], /清屏/, `浮层「${essential[1]}」与完整目录口径相反`);
  });
});

describe('selectCatalog 过滤', () => {
  test('无参 → 全部分组', () => {
    const g = selectCatalog();
    assert.equal(g.length, KEYBINDING_CATALOG.length);
  });
  test('按上下文名(vim)→ 仅该组', () => {
    const g = selectCatalog({ context: 'vim' });
    assert.equal(g.length, 1);
    assert.equal(g[0].context, 'vim');
  });
  test('按上下文 label(编辑)→ 仅该组', () => {
    const g = selectCatalog({ context: '编辑' });
    assert.equal(g.length, 1);
    assert.equal(g[0].context, 'editing');
  });
  test('自由查询(ctrl)→ 每组只保留命中行,空组剔除', () => {
    const g = selectCatalog({ query: 'ctrl' });
    assert.ok(g.length >= 1);
    for (const grp of g) {
      assert.ok(grp.bindings.length > 0);
      assert.ok(grp.bindings.every((b) =>
        b.keys.toLowerCase().includes('ctrl') ||
        b.desc.toLowerCase().includes('ctrl') ||
        grp.label.toLowerCase().includes('ctrl') ||
        grp.context.toLowerCase().includes('ctrl')));
    }
  });
  test('查询无命中 → 空数组', () => {
    assert.deepEqual(selectCatalog({ query: 'zzzz-nope' }), []);
  });
  test('返回的是拷贝,不污染原目录', () => {
    const g = selectCatalog();
    g[0].bindings.push({ keys: 'X', desc: 'Y' });
    assert.ok(KEYBINDING_CATALOG[0].bindings.every((b) => b.keys !== 'X'));
  });
});

describe('formatCatalog 确定性渲染', () => {
  test('含组标题【】,键列右对齐(键后至少 2 空格)', () => {
    const out = formatCatalog(selectCatalog({ context: 'navigation' }));
    assert.match(out, /【导航】/);
    // 每条形如 "  <keys><padding><desc>";键列对齐到最长键宽。
    assert.ok(out.split('\n').some((l) => /^ {2}\S.* {2,}\S/.test(l) || /^ {2}.+  .+/.test(l)));
  });
  test('键列按显示宽度对齐:含宽字符(CJK)的键格不右移一格', () => {
    const { displayWidth } = require('../../../src/utils/text/width.js');
    const out = formatCatalog([{
      context: 'wide',
      label: '宽字符组',
      bindings: [
        // 「或」占 2 列却只算 1 个 UTF-16 单元:长度 13、显示宽 14
        { keys: '↑ / ↓ 或 j / k', desc: '上下滚动一行' },
        { keys: '0123456789abcdefg', desc: 'B' },
      ],
    }]);
    const descColOf = (line) => {
      const rest = line.slice(2);
      const key = rest.match(/^(.+?) {2,}/)[1];
      return 2 + displayWidth(key) + rest.slice(key.length).match(/^ +/)[0].length;
    };
    const rows = out.split('\n').slice(1);
    assert.equal(descColOf(rows[0]), descColOf(rows[1]), 'two rows must share one column');
    // 正对照:纯 ASCII 组与按字符数填充逐字节相同 —— 钉子锁的是「宽字符不再独占错位」,不是把整表推歪
    assert.equal(
      formatCatalog([{ context: 'a', label: '甲', bindings: [{ keys: 'K1', desc: 'd1' }, { keys: 'K23', desc: 'd2' }] }]),
      '【甲】\n  K1   d1\n  K23  d2'
    );
  });
  test('空 groups → 空串', () => {
    assert.equal(formatCatalog([]), '');
    assert.equal(formatCatalog(null), '');
  });
  test('多组之间有空行分隔', () => {
    const out = formatCatalog(selectCatalog());
    assert.match(out, /\n\n【/);
  });
});

describe('门控 isEnabled', () => {
  test('默认(未设)→ 开', () => {
    assert.equal(isEnabled({}), true);
    assert.equal(isEnabled({ KHY_KEYBINDINGS: 'true' }), true);
  });
  test('falsy → 关', () => {
    for (const v of ['0', 'false', 'off', 'no', '']) {
      assert.equal(isEnabled({ KHY_KEYBINDINGS: v }), false);
    }
  });
});
