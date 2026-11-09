'use strict';

/**
 * ParamPanel — 斜杠命令「参数面板」（2026-10-10）。
 *
 * 客户原话：「要形成一个面板，有些 / 命令可能会有多个参数需要调整，怎么上下左右
 * 移动选择输入」。补全菜单解决「选哪条命令」，本面板解决「这条命令的参数怎么调」：
 * 一个浮层把命令的全部参数平铺成行，↑/↓ 在参数间移动，←/→ 调值（选项循环 / 文本
 * 光标），直接打字改文本值，回车把组装好的命令行交回既有提交正门
 * （handleSubmit → route()，与手敲逐字节同一条路），Esc 返回菜单。
 *
 * 与 FormFlow 的分工：FormFlow 是**顺序**表单（一次一字段，供 /login 等采集用），
 * 本面板是**平铺**表单（所有参数同屏 + 活跃参数的候选值列表，←→ 调值）—— 命令参数
 * 调正是「看着全局调」，不是「问答式采集」。两者都自己管 useInput，App 顶层对其
 * yield（见 regionLayout.OWNING_OVERLAYS 的 paramPanel 登记）。
 *
 * 规格真源在 ../commandParamSpecs.js（CURATED 逐个核对 + 经典 REPL 二级菜单派生）；
 * 本组件只负责交互与渲染，不认命令语义。
 *
 * Props:
 *   cmd       — 斜杠命令（含或不含前导 /），用于标题与预览
 *   specs     — commandParamSpecs.specsFor 的产物
 *   onResolve — (assembledLine | null) => void。null = Esc 返回，不执行。
 *
 * 键位：
 *   ↑/↓ · Tab/Shift+Tab   在参数行间移动
 *   ←/→                   选项行：上一个/下一个值；文本行：光标左/右移
 *   可打印字符             文本行：在光标处插入
 *   Backspace/Delete      文本行：删光标前一字
 *   Home/End              文本行：光标到行首/行尾
 *   数字 1-9              选项行：快选（同 FormFlow/ModelPicker 惯例）
 *   Enter                 执行（组装命令行交回 onResolve）
 *   Esc                   返回（onResolve(null)）
 * 鼠标（mouseButtons.collectLayout 按 props 收命中区）：
 *   点参数行              选中该行；选项行额外把值切到下一个（点一下换一个值）
 */

const React = require('react');

const inkRuntime = require('../inkRuntime');
const { clipCell, visWidth } = require('../wrapCell');

const MARKER = '❯';
// 候选值可见窗口：/gateway 有 23 个子命令，全画会把浮层撑过高。窗口随当前值滚动，
// 窗口头尾用 ‹ › 与计数如实告诉用户还有多少（不假装看全了）。
const CHOICE_WINDOW = 5;

/** 候选值当前应画的窗口（围绕 active 滚动，绝不越界）。 */
function choiceWindow(choices, active) {
  const total = choices.length;
  if (total <= CHOICE_WINDOW) {
    return { start: 0, list: choices.map((c, i) => ({ c, i })), total };
  }
  const start = Math.max(0, Math.min(active - Math.floor(CHOICE_WINDOW / 2), total - CHOICE_WINDOW));
  const list = [];
  for (let k = 0; k < CHOICE_WINDOW; k++) list.push({ c: choices[start + k], i: start + k });
  return { start, list, total };
}

/** 文本行的显示串（带光标方块）。 */
function textView(v, caret) {
  const s = String(v == null ? '' : v);
  const at = Math.max(0, Math.min(Number(caret) || 0, s.length));
  return `${s.slice(0, at)}█${s.slice(at)}`;
}

function ParamPanel({ cmd, specs = [], onResolve }) {
  const { Box, Text, useInput } = inkRuntime.get();
  const h = React.createElement;

  const list = Array.isArray(specs) ? specs.filter(Boolean) : [];
  const [row, setRow] = React.useState(0);
  // 每个规格一个值：选项 = choice.value；文本 = 原文。初值取 defaultValue。
  const [values, setValues] = React.useState(() =>
    list.map((s) => (s && s.defaultValue != null ? String(s.defaultValue) : ''))
  );
  const [caret, setCaret] = React.useState(0);

  const spec = list[Math.min(Math.max(0, row), Math.max(0, list.length - 1))] || null;
  const isChoice = !!spec && (spec.type || 'choice') === 'choice';
  const choices = spec && Array.isArray(spec.choices) ? spec.choices : [];
  const activeChoiceIdx = choices.findIndex((c) => String(c.value) === String((spec && values[row]) || ''));

  React.useEffect(() => {
    if (list.length === 0) {
      onResolve(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length]);

  const setValueAt = (idx, v) => setValues((cur) => cur.map((old, i) => (i === idx ? v : old)));

  const cycle = (dir) => {
    if (!isChoice || choices.length === 0) return;
    const at = choices.findIndex((c) => String(c.value) === String(values[row] || ''));
    // 当前值不在表里（初值空）→ 从第一项/最后一项起步，让第一次按 ←/→ 就有东西。
    const base = at < 0 ? (dir > 0 ? -1 : 0) : at;
    const next = (base + dir + choices.length) % choices.length;
    setValueAt(row, String(choices[next].value));
  };

  const moveRow = (dir) => setRow((r) => Math.max(0, Math.min(list.length - 1, r + dir)));

  const submit = () => {
    let line = '';
    try {
      line = require('../commandParamSpecs').assemble(cmd, list, values);
    } catch {
      line = `/${String(cmd || '').replace(/^\//, '')}`;
    }
    onResolve(line);
  };

  useInput((ch, key) => {
    // 鼠标序列绝不当文本插进去（App 顶层负责分发）。
    try {
      const _mouse = require('../mouseButtons');
      if (_mouse && typeof _mouse.isMouseSequence === 'function' && _mouse.isMouseSequence(ch)) {
        return;
      }
    } catch {
      /* mouseButtons 不可用 → 跳过守卫 */
    }
    if (key.escape) {
      onResolve(null);
      return;
    }
    if (key.return && !key.shift && !key.ctrl && !key.meta) {
      submit();
      return;
    }
    if (key.upArrow) {
      moveRow(-1);
      return;
    }
    if (key.downArrow || (key.tab && !key.shift)) {
      moveRow(1);
      return;
    }
    if (key.tab && key.shift) {
      moveRow(-1);
      return;
    }
    if (key.leftArrow) {
      if (isChoice) cycle(-1);
      else setCaret((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      if (isChoice) cycle(1);
      else setCaret((c) => Math.min(String(values[row] || '').length, c + 1));
      return;
    }
    if (key.home) {
      if (!isChoice) setCaret(0);
      return;
    }
    if (key.end) {
      if (!isChoice) setCaret(String(values[row] || '').length);
      return;
    }
    if (key.backspace || key.delete) {
      if (!isChoice) {
        const s = String(values[row] || '');
        const at = Math.max(0, Math.min(caret, s.length));
        if (at > 0) {
          setValueAt(row, s.slice(0, at - 1) + s.slice(at));
          setCaret(at - 1);
        }
      }
      return;
    }
    if (isChoice) {
      // 数字快选（1-9），与 FormFlow/ModelPicker 同惯例。
      if (ch >= '1' && ch <= '9') {
        const idx = parseInt(ch, 10) - 1;
        if (idx < choices.length) setValueAt(row, String(choices[idx].value));
      }
      return;
    }
    if (ch && !key.ctrl && !key.meta) {
      const s = String(values[row] || '');
      const at = Math.max(0, Math.min(caret, s.length));
      setValueAt(row, s.slice(0, at) + ch + s.slice(at));
      setCaret(at + ch.length);
    }
  });

  if (!spec) return null;

  const cmdText = `/${String(cmd || '').replace(/^\//, '')}`;

  // 标签列宽：所有参数行共用一把尺（CJK 感知），值列才能对齐成一条直线。
  // 14 列是「条目 id（approve / discard 用）」这类中文标签的实用下限；更长的
  // 标签就地截断而不是把值列推到不可预期的地方。
  const LABEL_W = Math.max(
    8,
    Math.min(18, ...list.map((s) => visWidth(String((s && (s.label || s.name)) || ''))))
  );
  const _clipLabel = (s) => (visWidth(s) > LABEL_W ? clipCell(s, LABEL_W) : s);
  const _padLabel = (s) => {
    const gap = LABEL_W - visWidth(s);
    return gap > 0 ? s + ' '.repeat(gap) : s;
  };

  // ── 参数行：`▌ ❯ 标签            值`。活跃行左侧一道竖杠 + 青色标签，
  // 值是「芯片」：括号 dim、内容 bold。文本行带光标方块。
  const rows = list.map((s, i) => {
    const active = i === row;
    const kind = (s.type || 'choice') === 'choice' ? 'choice' : 'text';
    const v = String(values[i] == null ? '' : values[i]);
    let chipInner;
    let chipTail = '';
    if (kind === 'choice') {
      const cs = Array.isArray(s.choices) ? s.choices : [];
      const at = cs.findIndex((c) => String(c.value) === v);
      const name = at >= 0 ? cs[at].name : v || '未选';
      chipInner = name;
      if (cs.length > 1) chipTail = `  ${at >= 0 ? at + 1 : '-'}/${cs.length}`;
    } else {
      chipInner = textView(v, active ? caret : v.length);
    }
    return h(
      Box,
      {
        key: s.name || i,
        // 鼠标：点行选中；选项行顺手把值切到下一个（点一下换一个值）。
        onClick: () => {
          setRow(i);
          if ((s.type || 'choice') === 'choice') {
            const cs = Array.isArray(s.choices) ? s.choices : [];
            if (cs.length) {
              const at = cs.findIndex((c) => String(c.value) === v);
              const next = (at + 1 + cs.length) % cs.length;
              setValueAt(i, String(cs[next].value));
            }
          } else {
            setCaret(v.length);
          }
        },
      },
      // 左档：活跃行一道青竖杠，非活跃行留等宽空格（列不跳）。
      h(Text, { color: active ? 'cyan' : undefined }, active ? '▌' : ' '),
      h(Text, { color: active ? 'cyan' : undefined, bold: active }, `${active ? MARKER : ' '} ${_padLabel(_clipLabel(String((s && (s.label || s.name)) || '')))}`),
      h(Text, { dimColor: true }, '  '),
      h(Text, { dimColor: true }, '‹ '),
      h(Text, { color: active ? 'cyan' : undefined, bold: true }, chipInner),
      h(Text, { dimColor: true }, ' ›'),
      chipTail ? h(Text, { dimColor: true }, chipTail) : null,
      active && s.hint ? h(Text, { dimColor: true }, `   ${s.hint}`) : null
    );
  });

  // ── 活跃选项行的候选值窗口（文本行没有候选，让位给输入）。
  // 当前值那一行用反显（青底黑字）——「现在选的是它」不需要再加文字说明。
  const win = isChoice && choices.length ? choiceWindow(choices, Math.max(0, activeChoiceIdx)) : null;
  const optionRows = win
    ? win.list.map(({ c, i }) => {
        const on = i === activeChoiceIdx;
        return h(
          Text,
          {
            key: `ch-${i}`,
            color: on ? 'black' : undefined,
            backgroundColor: on ? 'cyan' : undefined,
            bold: on,
            dimColor: !on,
          },
          `    ${on ? MARKER : '·'} ${c.name}`
        );
      })
    : null;

  let preview = cmdText;
  try {
    preview = require('../commandParamSpecs').assemble(cmd, list, values);
  } catch {
    /* 预览 best-effort */
  }

  // 键位提示做成「键帽」：键名亮黄、说明暗灰，一眼分得清哪截是按的、哪截是说的。
  const cap = (k, label) =>
    h(Text, { key: k }, h(Text, { color: 'yellow', bold: true }, k), h(Text, { dimColor: true }, ` ${label}`));

  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
    // 头带：命令名 + 参数个数，右侧计数让「这面板要调几项」可预期。
    // 中间必须放 flexGrow 占位 —— ink 不给 Text 兄弟自动加间距，直接并排会粘成
    // 「调整参数 /gateway1 个参数」（2026-10-10 实测形态）。
    h(
      Box,
      { flexDirection: 'row' },
      h(Text, { color: 'cyan', bold: true }, ` 调整参数 ${cmdText}`),
      h(Box, { flexGrow: 1 }),
      h(Text, { dimColor: true }, `${list.length} 个参数 `)
    ),
    h(Text, { dimColor: true }, ' ' + '─'.repeat(Math.max(10, 40))),
    h(Box, { flexDirection: 'column' }, ...rows),
    win && win.total > CHOICE_WINDOW
      ? h(Text, { dimColor: true }, `     候选值 ${win.start + 1}-${Math.min(win.total, win.start + CHOICE_WINDOW)}/${win.total} · ←→ 或数字快选`)
      : null,
    optionRows ? h(Box, { flexDirection: 'column' }, ...optionRows) : null,
    h(Text, { dimColor: true }, ' ' + '─'.repeat(Math.max(10, 40))),
    // 预览带：组装出的命令行就是按回车会执行的那一条，前面给个提示符。
    h(
      Box,
      { flexDirection: 'row' },
      h(Text, { color: 'yellow', bold: true }, ' ❯ '),
      h(Text, null, preview)
    ),
    h(
      Box,
      { flexDirection: 'row' },
      cap('↑↓', '选参数'),
      h(Text, { dimColor: true }, '  '),
      cap('←→', '调值'),
      h(Text, { dimColor: true }, '  '),
      cap('⏎', '执行'),
      h(Text, { dimColor: true }, '  '),
      cap('esc', '返回'),
      h(Text, { dimColor: true }, '   鼠标点行选中/换值')
    )
  );
}

ParamPanel.choiceWindow = choiceWindow;
ParamPanel.textView = textView;
ParamPanel.CHOICE_WINDOW = CHOICE_WINDOW;

module.exports = ParamPanel;
