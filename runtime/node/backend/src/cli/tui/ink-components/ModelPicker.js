'use strict';

/**
 * ModelPicker — native Ink selection overlay for `/model`.
 *
 * Replaces the inquirer-driven prompt that the classic REPL uses for model
 * selection. inquirer cannot coexist with ink's managed raw-mode input (it
 * fights ink for stdin and the alternate frame), which is why `/model` exited
 * immediately inside the TUI. This component owns its own keystrokes via ink's
 * useInput, identical in spirit to QuestionPrompt, so no other input handler
 * competes while it is mounted (App.js yields its top-level useInput while a
 * picker is open).
 *
 * Props:
 *   choices    — [{ name, value:{adapter,model}, disabled }] as produced by
 *                gateway.buildGatewayModelChoices(). `name` is a pre-formatted
 *                (chalk-colored) label; it is rendered as-is.
 *   onResolve  — (value | null) => void. Called with the selected choice.value
 *                on Enter, or null on Esc/cancel.
 *   title      — optional heading (defaults to a generic prompt).
 *   defaultValue — optional { adapter, model } to start the cursor on.
 *   recent     — optional [{ model, adapter }] recent models to show at top.
 *   cols       — overlay width in display columns (App passes `_overlayCols`).
 *                When present, each row is clipped to one visual row (BUG-56).
 *                Absent → rows render as before, i.e. no width cap.
 *   rows       — terminal height in lines (App passes `_resRows`). When present
 *                the page size shrinks so the whole frame, including the
 *                「Esc 取消」 footer, fits on screen (BUG-56). Absent → the
 *                historical 12-rows-per-page cap is used.
 *
 * Navigation: ↑/↓ move (skipping disabled rows), 1-9 jump+select, Enter selects
 * the highlighted row, Esc cancels. A scroll window keeps the cursor visible
 * when the list is longer than the viewport. Type to fuzzy-filter; Backspace
 * clears the last char; the filter resets when it matches nothing.
 */
const React = require('react');

const inkRuntime = require('../inkRuntime');
const {
  clipCell,
  padCell,
  visWidth,
  pickerRowBudget,
  pickerPageRows,
} = require('../wrapCell');

const MARKER = '❯';
const RECENT_MARKER = '★';

// 分组语义与行内分层规则住在共享叶子里（经典 REPL 的 `/model` 也吃同一份数据，
// 两个表面必须共用同一套，否则就是第二真源；放 `cli/` 根下避免 handlers → tui 倒置）。
// 本组件只负责「怎么摆」：标题行的前缀与颜色、primary 左对齐 / secondary 右对齐、
// 每行 1 视觉行的宽度账。见 `[DESIGN-ARCH-167]` §11「另一个表面」。
const {
  MIN_GROUP_FOR_SECTION,
  MIN_DISTINCT_GROUPS,
  groupKeyOf,
  groupFoldOf,
  stableGroupOrder,
  buildEntries,
  layeredTextOf,
} = require('../../modelChoiceGrouping');

/**
 * 窗口内第 1..9 个**模型行**的条目下标。
 * 标题行不占号——它不在返回数组里，所以按 5 永远选中第 5 个模型，而不是第 5 行。
 * 渲染（`digitIndexOf`）与按键（`useInput`）共用这一个映射，这是对旧版
 * 「两处各自推导」的收口。
 */
function digitTargets(entries, start, end) {
  const list = Array.isArray(entries) ? entries : [];
  const from = Math.max(0, Math.floor(Number(start) || 0));
  const toRaw = Number(end);
  const to = Math.min(list.length, Number.isFinite(toRaw) ? Math.floor(toRaw) : list.length);
  const out = [];
  for (let i = from; i < to && out.length < 9; i += 1) {
    if (list[i] && list[i].kind === 'model') {
      out.push(i);
    }
  }
  return out;
}

/** 条目下标 → 屏幕上显示的序号（1..9）；标题行 → 0（不编号）。 */
function digitIndexOf(entries, start, end, i) {
  const at = digitTargets(entries, start, end).indexOf(i);
  return at >= 0 ? at + 1 : 0;
}

/** 模型下标 → 条目下标。光标在模型维度、渲染在条目维度，这是两者之间唯一的桥。 */
function entryIndexOfModel(entries, mi) {
  const list = Array.isArray(entries) ? entries : [];
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].kind === 'model' && list[i].mi === mi) {
      return i;
    }
  }
  return 0;
}

function sameValue(v, target) {
  if (!v || !target) {
    return false;
  }
  return v.adapter === target.adapter && String(v.model || '') === String(target.model || '');
}

function scoreMatch(query, text) {
  if (!text) return 0;
  const lower = String(text).toLowerCase();
  const q = String(query).toLowerCase();
  if (!q) return 1;
  if (lower === q) return 100;
  if (lower.startsWith(q)) return 80;
  if (lower.includes(q)) return 60;
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const c of q) {
    const idx = lower.indexOf(c, ti);
    if (idx === -1) return 0;
    streak = idx === ti ? streak + 1 : 1;
    score += streak * 2;
    ti = idx + 1;
  }
  return Math.max(1, score);
}

function filterChoices(list, query) {
  if (!query) return list;
  const q = query.trim();
  if (!q) return list;
  return list
    .map((c) => {
      const label = (c && c.name) || (c && c.value && c.value.model) || '';
      const modelId = c && c.value && c.value.model ? String(c.value.model) : '';
      const adapterId = c && c.value && c.value.adapter ? String(c.value.adapter) : '';
      const score = Math.max(scoreMatch(q, label), scoreMatch(q, modelId), scoreMatch(q, adapterId));
      return score > 0 ? { item: c, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}

function ModelPicker({ choices = [], onResolve, title, defaultValue, recent = [], cols, rows }) {
  const { Box, Text, useInput } = inkRuntime.get();
  const h = React.createElement;

  const list = Array.isArray(choices) ? choices : [];
  // 浏览态的显示序：同组聚拢、组间保持首现相对顺序（§12-Q9）。
  // `initialCursor` 必须算在**同一份显示序**上 —— 排序改变了模型下标，
  // 光标若仍按原序求，开局就落在另一个模型上（「按下选到别的」的同一类缺陷）。
  const browse = React.useMemo(() => stableGroupOrder(list), [list]);
  const firstEnabled = browse.findIndex((c) => c && !c.disabled);
  const initialCursor = (() => {
    if (defaultValue) {
      const i = browse.findIndex((c) => c && !c.disabled && sameValue(c.value, defaultValue));
      if (i >= 0) {
        return i;
      }
    }
    return firstEnabled >= 0 ? firstEnabled : 0;
  })();

  const [cursor, setCursor] = React.useState(initialCursor);
  const [query, setQuery] = React.useState('');

  // ★ 光标的最新值（回车结算必须读它，不能读 render 期闭包里的 `cursor`）。
  // 为什么：ink 在 **passive effect** 里重订阅 input handler，而帧是在 layout effect 里
  // 写出去的 —— 于是存在一个窗口：「屏上已经画着新光标，handler 还是上一拍的闭包」。
  // 此时按回车会按**旧光标**结算。实测（`.khyos/diag/model-picker-grouping/q10-frame-dump.js`）：
  //   ↓ ↓ Enter  ⇒  回车发出前屏上 `❯ 3.  A-2`，回车后 `resolved = ['A-1']`，
  //                 且 stdin 队列残留 = 0（键被消费了，不是丢键）、屏上 ❯ 仍是 A-2（状态没回退）。
  // `moveCursor` 不受影响：它走 `setCursor(c => …)` 函数式更新，永远拿最新 state。
  // ref 在 **render 期**赋值（而不是 effect 里）—— 必须早于写屏，否则和 handler 一样滞后。
  const cursorRef = React.useRef(cursor);
  cursorRef.current = cursor;

  // Nothing selectable → resolve null so the caller is not left hanging.
  React.useEffect(() => {
    if (list.length === 0) {
      onResolve(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length]);

  // Reset cursor when filter changes
  React.useEffect(() => {
    setCursor(0);
  }, [query]);

  const filtered = React.useMemo(() => filterChoices(list, query), [list, query]);
  // `shown` = **显示序**的模型列表：浏览态按组键稳定归并（同名段并成一个标题，
  // §12-Q9）；搜索态不动 —— 搜索结果已按相关度排好，再按组归并会把相关度打散。
  // ⚠ 从此刻起所有下标都活在 `shown` 维度：`cursor` / `choose` / 数字键 /
  // `initialCursor` / `（n/N）` 必须全部指同一份数组，否则「屏幕上第 5 行」
  // 与「按 5 选中的模型」再次脱节（旧版出过这个缺陷）。
  const shown = React.useMemo(
    () => (query ? filtered : stableGroupOrder(filtered)),
    [filtered, query]
  );
  // entries = 渲染条目（含标题行）。标题行**只进渲染维度**，绝不进 `shown`
  // （[DESIGN-ARCH-167] §2.3 的核心决定）。
  const entries = React.useMemo(() => buildEntries(shown, query), [shown, query]);

  const moveCursor = (dir) => {
    if (shown.length === 0) {
      return;
    }
    setCursor((c) => {
      let next = c;
      for (let i = 0; i < shown.length; i++) {
        next = (next + dir + shown.length) % shown.length;
        if (shown[next] && !shown[next].disabled) {
          return next;
        }
      }
      return c;
    });
  };

  const choose = (idx) => {
    const c = shown[idx];
    if (!c || c.disabled) {
      return;
    }
    onResolve(c.value);
  };

  useInput((ch, key) => {
    if (list.length === 0) {
      return;
    }
    if (key.escape) {
      onResolve(null);
      return;
    }
    if (key.upArrow) {
      moveCursor(-1);
      return;
    }
    if (key.downArrow || key.tab) {
      moveCursor(1);
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      return;
    }
    // 全角(CJK IME)数字折半角后判定(单一真源 cli/fullWidthInput.js,门控关→原样字节回退)。
    // 数字跳转必须落到**屏幕上标注的那一行**：与渲染共用 digitTargets 一个映射。
    // 标题行不占号（它不在 digitTargets 里），所以按 5 永远选中第 5 个模型，而不是第 5 行。
    // 旧版渲染用 windowPos+1、按键用 start+offset 两处各自推导，注释里记着因此出过
    // 「列表滚动后按 3 选中了别的模型」。
    const navCh = require('../../fullWidthInput').foldDigits(ch, process.env);
    if (navCh && navCh >= '1' && navCh <= '9' && !query) {
      const ei = digitTargets(entries, start, end)[parseInt(navCh, 10) - 1];
      if (ei !== undefined) {
        const mi = entries[ei].mi;
        if (mi >= 0 && mi < shown.length && shown[mi] && !shown[mi].disabled) {
          setCursor(mi);
          choose(mi);
        }
      }
      return;
    }
    if (key.return) {
      // 读 ref，不读闭包：见 `cursorRef` 的注释（帧新 / handler 旧的窗口）。
      choose(cursorRef.current);
      return;
    }
    // Printable single char → append to query
    if (ch && !key.ctrl && !key.meta && ch.length === 1 && ch.charCodeAt(0) >= 32) {
      setQuery((q) => q + ch);
    }
  });

  if (list.length === 0) {
    return null;
  }

  // Compute the visible window so the cursor stays in view.
  const headerText = `? ${title || '选择模型（↑/↓ 选择，回车确认）'}`;
  const footerText = `  Enter 选择 · ↑/↓ 导航 · 打字搜索 · Esc 取消${recent.length ? ' · ★最近' : ''}`;
  // The search echo is this picker's own extra chrome row — bill it here, where
  // it is known, on top of the shared frame-chrome accounting.
  // `pageSize` 数的是**条目**（标题行占额度）⇒ 帧高账本与改前完全同一套算式：
  // 2(边框) + header + [搜索回声] + footer + pageSize。没有一行游离在账外
  // （[DESIGN-ARCH-167] 公理 A1；实测六档逐档相等）。
  const pageSize = Math.max(
    1,
    Math.min(
      pickerPageRows(rows, cols, headerText, footerText) - (query ? 1 : 0),
      entries.length
    )
  );
  // 窗口按**光标所在条目**定位，再折回模型下标渲染 —— 光标在模型维度，
  // 窗口在条目维度，entryIndexOfModel 是两者之间唯一的桥。
  let start = Math.max(
    0,
    Math.min(
      entryIndexOfModel(entries, cursor) - Math.floor(pageSize / 2),
      entries.length - pageSize
    )
  );
  if (start < 0) {
    start = 0;
  }
  const end = Math.min(entries.length, start + pageSize);

  const recentKeys = new Set(recent.map((r) => `${r.adapter}/${r.model}`));

  const rowNodes = [];
  for (let i = start; i < end; i++) {
    const e = entries[i];
    if (e.kind === 'section') {
      // 标题行：1 视觉行（与模型行同一宽度账，否则窄终端会折成 2 行顶破帧高）。
      // 前缀与模型行**等宽 9 列**（3 空格 + marker + 空格 + 序号 2 + 空格 + ★），
      // 只是全填空格 —— 否则标题行与模型名不在同一左边界上，分组反而更乱。
      // 信号用最弱档（灰、无粗体、无边框）：[DESIGN-ARCH-084] §1.2 禁止同时用
      // 4+ 个信号表示同一状态。
      const sPrefix = ' '.repeat(9);
      const sBudget = pickerRowBudget(cols, sPrefix, '');
      const sText = `── ${e.name} · ${e.count} 个 ──${e.meta ? ` ${e.meta}` : ''}`;
      rowNodes.push(
        h(Text, { key: `s-${i}`, color: 'gray' }, `${sPrefix}${sBudget > 0 ? clipCell(sText, sBudget) : sText}`)
      );
      continue;
    }
    const c = e.choice;
    const active = e.mi === cursor;
    const marker = active ? MARKER : ' ';
    // 序号只给**模型行**，且与数字键跳转（见 useInput 的 digitTargets）共用同一映射：
    // 屏幕上写「1.」的那一行，按 1 就选中它。标题行不占号。
    const digitNo = digitIndexOf(entries, start, end, i);
    const numberLabel = digitNo > 0 ? `${digitNo}.` : '  ';
    // 信息分层：主信息（模型名）靠左，次信息（来源标签 / 是否当前）右对齐到同一列。
    // 旧版把状态标签放在**名字之前**、把供应商塞进名字中间，于是名字被推到第 20 列开外，
    // 一行六段信息没有一列对齐 —— 这正是截图里「划分不清楚」的本体。
    // 没给 primary/secondary 时逐字回退旧渲染（调用方不供这两个字段即可）。
    // 两段文本由**共享叶子**给出（经典 REPL 用同一处定义）；这里只决定怎么摆：
    // primary 左对齐、secondary 右对齐到同一列。孤儿段的 groupMeta 回落也在叶子里。
    const { primary, secondary } = layeredTextOf(e);
    const disabledTag = c && c.disabled ? ' (不可选)' : '';
    const isRecent =
      c && c.value && recentKeys.has(`${c.value.adapter}/${c.value.model}`);
    const recentTag = isRecent ? RECENT_MARKER : ' ';
    const prefix = `   ${marker} ${numberLabel} ${recentTag}`;
    // One model = one visual row. A gateway model ID is an external string
    // (40+ chars is normal), and an uncapped row wrapped to 2 lines on a
    // narrow terminal, inflating the frame until the 「Esc 取消」 hint fell off
    // the bottom — same defect as BUG-54/BUG-55, measured in AK.
    const budget = pickerRowBudget(cols, prefix, disabledTag);
    // 变量不叫 `shown`：外层那个 `shown` 是显示序模型列表，同名会遮蔽（JS 允许但
    // 读起来像在改列表）。这里只是本行最终上屏的文本。
    let rowText = primary;
    if (budget > 0) {
      if (secondary) {
        const secW = visWidth(secondary);
        const pBudget = budget - secW - 2;
        if (pBudget >= 8) {
          // 主信息左对齐、次信息右对齐到同一列：两段共用同一把尺（padCell），
          // 不手算空格 —— 手算会让截断点与对齐列各自漂移。
          rowText = padCell(primary, pBudget) + '  ' + secondary;
        } else {
          // 次信息放不下：拼成一条再截断，**留下可见的 `…`**。
          // 绝不静默丢掉它（[DESIGN-ARCH-100] §158 要求来源标签可见）。
          rowText = clipCell(`${primary} ${secondary}`, budget);
        }
      } else {
        rowText = clipCell(primary, budget);
      }
    } else if (secondary) {
      rowText = `${primary}  ${secondary}`;
    }
    rowNodes.push(
      h(
        Text,
        {
          key: `m-${i}`,
          color: active ? 'cyan' : undefined,
          bold: active,
          dimColor: c && c.disabled ? true : undefined,
        },
        `${prefix}${rowText}${disabledTag}`
      )
    );
  }

  // 分子/分母都留在**模型**维度：`（n/N）` 数的是「第几个模型 / 共几个模型」，
  // 标题行不是可选项，混进去会让「第 5 个」与实际按 5 命中的行再次脱节。
  // `cursor` 与分母都取自 `shown`：显示序才是屏幕上从上往下数的那一维。
  const scrollHint =
    entries.length > pageSize
      ? `  （${cursor + 1}/${shown.length}${start > 0 ? ' · ↑更多' : ''}${end < entries.length ? ' · ↓更多' : ''}）`
      : '';

  const queryHint = query ? `  搜索: ${query}` : '';

  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
    h(Text, { color: 'cyan', bold: true }, headerText),
    queryHint ? h(Text, { color: 'yellow' }, queryHint) : null,
    h(Box, { flexDirection: 'column' }, rowNodes),
    h(Text, { dimColor: true }, `${footerText}${scrollHint}`)
  );
}

module.exports = ModelPicker;
// 纯函数挂在默认导出上——`require()` 的返回值仍是组件本身，调用方零改动。
// 导出它们是为了让 tests/tui/modelPickerSize.test.js 能直调：像「数字键与序号是否
// 同源」「单模型组是否画标题」这类不变式，从渲染出来的帧里看不出来。
module.exports.buildEntries = buildEntries;
module.exports.digitTargets = digitTargets;
module.exports.digitIndexOf = digitIndexOf;
module.exports.entryIndexOfModel = entryIndexOfModel;
module.exports.groupKeyOf = groupKeyOf;
module.exports.groupFoldOf = groupFoldOf;
module.exports.stableGroupOrder = stableGroupOrder;
module.exports.MIN_GROUP_FOR_SECTION = MIN_GROUP_FOR_SECTION;
module.exports.MIN_DISTINCT_GROUPS = MIN_DISTINCT_GROUPS;
