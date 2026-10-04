'use strict';

/**
 * QuestionPrompt — interactive single/multi/multi-card selection overlay.
 *
 * Renders an AskUserQuestion control request (subtype `can_use_tool`,
 * tool_name `AskUserQuestion`) as a navigable menu, aligned with Claude Code's
 * AskUserQuestion tool specification, and extended to「体察人的惰性」:
 *
 * - **多张选项卡(可左右切换)**: when there are 2-4 questions, ←/→ moves between
 *   cards freely (no forced sequential commit); each card keeps its own
 *   selection state, so going back and forth never loses what was picked.
 * - **卡内上下多选 + 一个「可讨论」选项**: every card deterministically grows a
 *   「可讨论」row (user's "let's discuss this / you decide" escape) and a free-text
 *   "Other" row — present even if the model forgot to include them.
 * - Single-select and multi-select modes, header labels, side-by-side preview.
 *
 * It owns its own keystrokes via ink's useInput. App.js routes question
 * requests here (returning early from its own useInput) and mounts this only
 * while a question is pending, so there is no competing input handler.
 *
 * The `request` prop is the INNER gateway request: { subtype, tool_name,
 * input: { questions: [{ question, header, options, multiSelect }] } }. On completion
 * it resolves with an SDK payload that normalizeControlResponse accepts:
 *   allow → { behavior:'allow', updatedInput:{ ...input, answers } }
 *   cancel → { behavior:'deny', message:'User declined to answer questions' }
 * `answers` is keyed by question text; multi-select values are joined with
 * ", " — identical to the legacy behavior repl.js handleControlRequest expects.
 *
 * All deterministic row/answer logic lives in the pure `questionCardModel`
 * single source (unit-tested without rendering ink); this file stays thin.
 *
 * Props `cols`/`rows` carry the terminal box the overlay is allowed to occupy
 * (App.js passes its rail content width and its rows). Without them the frame
 * renders exactly as before; with them the row set degrades in three tiers —
 * full → clip (display-column clipped) → labels (descriptions dropped, footer
 * says so) — so the frame never grows past the screen and pushes 「Esc 取消」
 * out of the visible region.
 */
const React = require('react');

const inkRuntime = require('../inkRuntime');
const { Cursor } = require('../utils/Cursor');
const {
  clipCell,
  visWidth,
  visualRows,
  pickerRowBudget,
  PICKER_BOX_CHROME_COLS,
} = require('../wrapCell');

const model = require('./questionCardModel');
// 与权限卡同一套排版语法(贴合内容宽 / 列对齐 / 续行悬挂在值列之下)。
const cardLayout = require('../cardLayout');
// [DESIGN-ARCH-146] 点击门控 + 行命中 + 展开态（纯逻辑单一真源，可离线单测）。
const cardClick = require('./cardClick');

const {
  DISCUSS_LABEL,
  DISCUSS_HINT,
  OTHER_LABEL,
  optLabel,
  optDesc,
  optPreview,
  rowLayout,
  wrapIndex,
  nextCard,
  prevCard,
  moveCursor,
  rowKind,
  multiSelection,
  singleSelection,
  collectAllAnswers,
  effectiveMulti,
  questionTextCursorEnabled,
  questionMultipickEnabled,
} = model;

const MARKER = '❯'; // ❯

/**
 * 可读行宽上限（卡片**内容**列数）。76 = 76 列中文说明 ≈ 38 字/行，落在舒适读数区间；
 * 页脚整串（约 62 列）也就放得下一行。≥80 列的终端上卡片据此收起，80 列及以下不受影响
 * （那时 inner 本就不超过它）。
 */
const MEASURE_COLS = 76;

// Appended to the footer only in the last degradation tier, so an omitted
// option description is visible rather than silent (BUG-57).
const LABELS_HINT = ' · 屏高不足，已省略选项说明';

function QuestionPrompt({ request, onResolve, cols, rows }) {
  const { Box, Text, useInput } = inkRuntime.get();
  const h = React.createElement;

  const input = (request && request.input) || {};
  const questions = Array.isArray(input.questions) ? input.questions.slice(0, 4) : [];
  const cardCount = questions.length;
  // 提问上下文注记(toolUseLoop 经 questionQuality 兜底注入,确定性一行):把当前任务目标
  // 显示在问题卡上方,让用户对照目标准确作答;为空时不渲染(逐字节保持今日版面)。
  const contextNote = String(input.contextNote || '').trim();

  const [qIdx, setQIdx] = React.useState(0);
  // Per-card persistent state — left/right switching never loses a card's picks.
  const [cursors, setCursors] = React.useState(() => questions.map(() => 0));
  const [checkedSets, setCheckedSets] = React.useState(() => questions.map(() => new Set()));
  const [discussChecked, setDiscussChecked] = React.useState(() => questions.map(() => false));
  const [otherVals, setOtherVals] = React.useState(() => questions.map(() => ''));
  const [typing, setTyping] = React.useState(false);
  // Fix 2 — 自由输入用不可变 Cursor(文本 + caret offset),支持左右移动。读者用 .text。
  const [typedCursor, setTypedCursor] = React.useState(() => new Cursor('', 0));
  // Fix 3 — 每张卡是否被用户按 Space 临时提升为多选(与模型声明的 multiSelect 独立叠加)。
  const [promotedMulti, setPromotedMulti] = React.useState(() => questions.map(() => false));
  // [DESIGN-ARCH-146] 点击展开态：每张卡至多一行展开。存行下标（null = 全部收起），
  // 与光标**互相独立** —— 展开是「看全文」，光标是「要选哪个」，混用会让点一下既挪光标又改版面。
  const [expandedRows, setExpandedRows] = React.useState(() => questions.map(() => null));

  const q = questions[qIdx] || null;
  const qText = q ? String(q.question || '').trim() || 'Please choose an option' : '';
  const qHeader = q
    ? String(q.header || '')
        .trim()
        .slice(0, 12) || ''
    : '';
  const options = q && Array.isArray(q.options) ? q.options : [];
  const rawMulti = !!(q && q.multiSelect);
  const multi = effectiveMulti({
    multiSelect: rawMulti,
    promoted: !!promotedMulti[qIdx],
    env: process.env,
  });
  const hasPreview = options.some((opt) => optPreview(opt));
  const { discussRow, otherRow, rowCount } = rowLayout(options.length);

  const cursor = wrapIndex(cursors[qIdx] || 0, rowCount);
  const checked = checkedSets[qIdx] instanceof Set ? checkedSets[qIdx] : new Set();
  const discussOn = !!discussChecked[qIdx];
  const otherValue = otherVals[qIdx] || '';

  // Guard: nothing to ask → decline so the loop/gateway is not left hanging.
  React.useEffect(() => {
    if (!q) {
      onResolve({ behavior: 'deny', message: 'User declined to answer questions' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const setCursorAt = (i, v) =>
    setCursors((prev) => {
      const n = prev.slice();
      n[i] = v;
      return n;
    });
  const setOtherAt = (i, v) =>
    setOtherVals((prev) => {
      const n = prev.slice();
      n[i] = v;
      return n;
    });
  const setDiscussAt = (i, v) =>
    setDiscussChecked((prev) => {
      const n = prev.slice();
      n[i] = v;
      return n;
    });
  const setPromotedAt = (i, v) =>
    setPromotedMulti((prev) => {
      const n = prev.slice();
      n[i] = v;
      return n;
    });
  const toggleCheckedAt = (i, idx) =>
    setCheckedSets((prev) => {
      const n = prev.slice();
      const s = new Set(n[i] instanceof Set ? n[i] : []);
      if (s.has(idx)) {
        s.delete(idx);
      } else {
        s.add(idx);
      }
      n[i] = s;
      return n;
    });

  const cancel = () =>
    onResolve({ behavior: 'deny', message: 'User declined to answer questions' });

  // Resolve with every card's answer. `collectAllAnswers` reads each card's
  // persistent state; we overlay the just-committed active card to dodge the
  // setState-not-yet-applied staleness of the triggering keypress's closure.
  const submitWith = (overrideAnswer) => {
    const base = collectAllAnswers(
      questions,
      { cursors, checkedSets, discussChecked, otherVals, promotedMulti },
      process.env
    );
    if (overrideAnswer != null && qText) {
      base[qText] = overrideAnswer;
    }
    onResolve({ behavior: 'allow', updatedInput: { ...input, answers: base } });
  };

  // ── Review 步(多卡才走)────────────────────────────────────────────────────
  // 结构取自两个上游的同一条设计:openCode 在最后一个 tab 放 `Confirm`、ZCode 有独立
  // `Review answers` 面板,二者都在**提交前**把「每题答了什么」列一遍(未答的标出来)。
  // 本组件改前是最后一卡直接提交,用户没有回看/回头改的机会 —— 多卡问答里这是最容易
  // 答错的一处。单卡单选保持立即提交(上游同样不为 single 生成 confirm 步),不为一个
  // 入口多花一步。
  const needsReview = () => cardCount > 1;
  const [reviewing, setReviewing] = React.useState(false);
  const [pendingAnswer, setPendingAnswer] = React.useState(null);

  // Commit the active card's answer, then advance / review / submit.
  const commitCardAnswer = (answerString) => {
    if (qIdx + 1 < cardCount) {
      setQIdx(qIdx + 1);
      return;
    }
    if (needsReview()) {
      setPendingAnswer(answerString == null ? null : String(answerString));
      setReviewing(true);
      return;
    }
    submitWith(answerString);
  };

  const commitOther = () => {
    const value = typedCursor.text.trim();
    setTyping(false);
    setTypedCursor(new Cursor('', 0));
    if (!value) {
      return;
    }
    setOtherAt(qIdx, value);
    if (multi) {
      commitCardAnswer(
        multiSelection({ options, checked, discussChecked: discussOn, otherValue: value }).join(
          ', '
        )
      );
    } else {
      commitCardAnswer(value);
    }
  };

  useInput((ch, key) => {
    if (!q) {
      return;
    }
    // Mouse-button layer: consume SGR mouse sequences (dispatched by App's top
    // useInput) so they are never inserted into the typed-cursor buffer.
    //
    // [DESIGN-ARCH-146] 本守卫必须**先于**下面所有分支（含 reviewing / typing）：
    // 它原本落在 `reviewing` 之后、`typing` 之前，于是这两态下 `[<0;20;10M` 会被当成
    // 普通字符流 —— typing 态还会把它插进输入框（见 L310 的 setTypedCursor）。
    // 往前提一行覆盖全部态；原来那份已删除（同一文件不得留两份）。
    try {
      const _mouse = require('../mouseButtons');
      if (_mouse && typeof _mouse.isMouseSequence === 'function' && _mouse.isMouseSequence(ch)) {
        return;
      }
    } catch {
      /* mouseButtons unavailable — skip guard */
    }
    // Review 步:Enter 提交 / Tab 与 ←→ 回上一卡改 / Esc 取消(上游同款三键)
    if (reviewing) {
      if (key.escape) {
        cancel();
        return;
      }
      if (key.tab || key.leftArrow || key.upArrow) {
        setReviewing(false);
        setQIdx(cardCount - 1);
        return;
      }
      if (key.return) {
        submitWith(pendingAnswer);
      }
      return;
    }

    // Free-text "Other" capture mode.
    if (typing) {
      if (key.escape) {
        setTyping(false);
        setTypedCursor(new Cursor('', 0));
        return;
      }
      if (key.return) {
        commitOther();
        return;
      }
      // Fix 2 — 门控开:全套光标移动/插入/删除;关:逐字节 legacy(行尾追加/退格,方向键吞掉)。
      if (questionTextCursorEnabled(process.env)) {
        if (key.leftArrow) {
          setTypedCursor((c) => c.left());
          return;
        }
        if (key.rightArrow) {
          setTypedCursor((c) => c.right());
          return;
        }
        if (key.upArrow || (key.ctrl && ch === 'a')) {
          setTypedCursor((c) => c.startOfLine());
          return;
        }
        if (key.downArrow || (key.ctrl && ch === 'e')) {
          setTypedCursor((c) => c.endOfLine());
          return;
        }
        if (key.backspace) {
          setTypedCursor((c) => c.backspace());
          return;
        }
        if (key.delete) {
          setTypedCursor((c) => c.del());
          return;
        }
        if (ch && !key.ctrl && !key.meta) {
          setTypedCursor((c) => c.insert(ch));
          return;
        }
        return;
      }
      // Legacy(门控关):追加到尾 / 尾部退格,方向键无 ch → no-op(与今日逐字节一致)。
      if (key.backspace || key.delete) {
        setTypedCursor((c) => new Cursor(c.text.slice(0, -1), Math.max(0, c.text.length - 1)));
        return;
      }
      if (ch && !key.ctrl && !key.meta) {
        setTypedCursor((c) => new Cursor(c.text + ch, c.text.length + ch.length));
        return;
      }
      return;
    }

    if (key.escape) {
      cancel();
      return;
    }

    // 多张选项卡:←/→ 自由切换,不强制顺序提交;每张卡状态独立持久。
    if (cardCount > 1 && key.leftArrow) {
      setQIdx(prevCard(qIdx, cardCount));
      return;
    }
    if (cardCount > 1 && key.rightArrow) {
      setQIdx(nextCard(qIdx, cardCount));
      return;
    }

    // 卡内上下选择(环绕)。
    if (key.upArrow) {
      setCursorAt(qIdx, moveCursor(cursor, -1, rowCount));
      return;
    }
    if (key.downArrow || key.tab) {
      setCursorAt(qIdx, moveCursor(cursor, +1, rowCount));
      return;
    }

    // Number keys jump to a row; single-select commits, multi toggles.
    // 全角(CJK IME)数字折半角后判定(单一真源 cli/fullWidthInput.js,门控关→原样字节回退)。
    const _fw = require('../../fullWidthInput');
    const navCh = _fw.foldDigits(ch, process.env);
    if (navCh && navCh >= '1' && navCh <= '9') {
      const idx = parseInt(navCh, 10) - 1;
      if (idx >= 0 && idx < rowCount) {
        setCursorAt(qIdx, idx);
        const kind = rowKind(idx, options.length);
        if (kind === 'other') {
          setTyping(true);
          setTypedCursor(new Cursor(otherValue, otherValue.length));
          return;
        }
        if (multi) {
          if (kind === 'discuss') {
            setDiscussAt(qIdx, !discussOn);
          } else {
            toggleCheckedAt(qIdx, idx);
          }
          return;
        }
        commitCardAnswer(kind === 'discuss' ? DISCUSS_LABEL : optLabel(options[idx]));
      }
      return;
    }

    // Space:多选卡切换;单选卡(门控开)→ 临时提升为多选并勾当前行(Fix 3);
    // 门控关且非多选 → no-op(=legacy 单选 Space 无效,逐字节一致)。全角空格折半角后判定。
    if (_fw.foldSpace(ch, process.env) === ' ') {
      const kind = rowKind(cursor, options.length);
      if (kind === 'other') {
        setTyping(true);
        setTypedCursor(new Cursor(otherValue, otherValue.length));
        return;
      }
      if (multi) {
        if (kind === 'discuss') {
          setDiscussAt(qIdx, !discussOn);
        } else {
          toggleCheckedAt(qIdx, cursor);
        }
        return;
      }
      // 单选卡首次 Space:提升为多选(用户显式动作;不静默改变单选语义),并勾当前行。
      if (questionMultipickEnabled(process.env) && !rawMulti && !promotedMulti[qIdx]) {
        setPromotedAt(qIdx, true);
        if (kind === 'discuss') {
          setDiscussAt(qIdx, !discussOn);
        } else {
          toggleCheckedAt(qIdx, cursor);
        }
        return;
      }
      return; // 门控关 → no-op(legacy)
    }

    if (key.return) {
      const kind = rowKind(cursor, options.length);
      if (kind === 'other') {
        setTyping(true);
        setTypedCursor(new Cursor(otherValue, otherValue.length));
        return;
      }
      if (multi) {
        // 惰性回退:一项未选时,multiSelection 自动落「可讨论」,不强求用户必须选。
        commitCardAnswer(
          multiSelection({ options, checked, discussChecked: discussOn, otherValue }).join(', ')
        );
      } else {
        commitCardAnswer(singleSelection({ options, cursor, otherValue }));
      }
    }
  });

  if (!q) {
    return null;
  }

  // ── Review 视图(多卡提交前)─────────────────────────────────────────────
  // 每题一行:`<header>：<答案>`;未回答的用告警色标出来(上游两家都这么做)。
  // 行数 = 1 标题 + 题目数 + 1 页脚,每题裁成一行 ⇒ 视图高度有界(不参与 BUG-57 阶梯,
  // 因为它的行数只与题目数有关,与说明长短无关)。
  if (reviewing) {
    const shown = collectAllAnswers(
      questions,
      { cursors, checkedSets, discussChecked, otherVals, promotedMulti },
      process.env
    );
    if (pendingAnswer != null && qText) {
      shown[qText] = pendingAnswer;
    }
    const width = cardLayout.MIN_CONTENT_COLS + 60; // 复核视图只做单行裁切,给一个宽松预算
    const lineFor = (qq) => {
      const header = String(qq.header || '').trim() || '问题';
      const text = String(qq.question || '').trim() || 'Please choose an option';
      const value = String(shown[text] == null ? '' : shown[text]).trim();
      return {
        head: `${header}：${value || '(未回答)'}`,
        answered: Boolean(value),
      };
    };
    const rows = questions.map(lineFor);
    const footerText = 'Enter 提交 · Tab 返回修改 · Esc 取消';
    const reviewWidth = Math.max(
      cardLayout.MIN_CONTENT_COLS,
      cardLayout.visWidth(footerText),
      cardLayout.visWidth('复核答案'),
      rows.reduce((m, r) => Math.max(m, cardLayout.visWidth(r.head)), 0)
    );
    return h(
      Box,
      {
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: 'yellow',
        paddingX: 1,
        width: cols > 0 ? Math.min(reviewWidth, cols - PICKER_BOX_CHROME_COLS) + PICKER_BOX_CHROME_COLS : undefined,
      },
      h(Text, { bold: true }, cardLayout.clipRow('复核答案', reviewWidth)),
      ...rows.map((r, i) =>
        h(
          Text,
          { key: `rev${i}`, dimColor: !r.answered, color: r.answered ? undefined : 'yellow' },
          cardLayout.clipRow(r.head, reviewWidth)
        )
      ),
      h(Text, { dimColor: true }, cardLayout.clipRow(footerText, reviewWidth))
    );
  }

  // Build rows: real options → 「可讨论」 → 「Other」.
  // Rows are described as {prefix, label, desc} instead of one finished string
  // because the size ladder below (BUG-57) has to be able to drop or clip the
  // `desc` half while keeping the numbered label intact.
  const rowSpecs = [];
  for (let i = 0; i < options.length; i++) {
    const active = i === cursor;
    const box = multi ? (checked.has(i) ? '[x] ' : '[ ] ') : '';
    const desc = optDesc(options[i]);
    rowSpecs.push({
      key: `opt-${i}`,
      prefix: `   ${active ? MARKER : ' '} ${i + 1}. ${box}`,
      label: optLabel(options[i]),
      desc: desc ? `  — ${desc}` : '',
      // [DESIGN-ARCH-146] 展开用全文：desc 已被尺寸阶梯裁剪时，展开态靠它还原完整说明。
      fullDesc: desc ? `  — ${desc}` : '',
      color: active ? 'cyan' : undefined,
      bold: active,
    });
  }
  // 「可讨论」row — always present; a deliberate "let's discuss / you decide" escape.
  const discussActive = cursor === discussRow;
  const discussBox = multi ? (discussOn ? '[x] ' : '[ ] ') : '';
  rowSpecs.push({
    key: 'opt-discuss',
    prefix: `   ${discussActive ? MARKER : ' '} ${discussRow + 1}. ${discussBox}`,
    label: DISCUSS_LABEL,
    desc: `  — ${DISCUSS_HINT}`,
    fullDesc: `  — ${DISCUSS_HINT}`,
    color: discussActive ? 'cyan' : 'magenta',
    bold: discussActive,
  });
  // "Other (free input)" row.
  const otherActive = cursor === otherRow;
  rowSpecs.push({
    key: 'opt-other',
    prefix: `   ${otherActive ? MARKER : ' '} ${otherRow + 1}. `,
    label: `${OTHER_LABEL}${otherValue ? `: ${otherValue}` : ''}`,
    desc: '',
    color: otherActive ? 'cyan' : undefined,
    bold: otherActive,
    dim: !otherActive,
  });

  const navHint = cardCount > 1 ? '←/→ 切换卡片 · ' : '';
  // Fix 3 — 单选卡(未提升、门控开)提示可按 Space 转多选。
  const multipickHint =
    !multi && !rawMulti && questionMultipickEnabled(process.env) ? 'Space 可多选 · ' : '';
  const footer = multi
    ? `Enter 确认本卡 · Space 多选 · ↑/↓ 导航 · ${navHint}数字键选择 · Esc 取消`
    : `Enter 选择 · ${multipickHint}↑/↓ 导航 · ${navHint}数字键选择 · Esc 取消`;

  // Fix 2 — 自由输入行渲染:门控开显示内部反色 caret(before + 反色当前字 + after),
  // 门控关逐字节 legacy `✎ <text>█`(offset 恒在尾,与今日一致)。
  const renderTyping = () => {
    if (!typing) {
      return null;
    }
    const t = typedCursor.text;
    if (!questionTextCursorEnabled(process.env)) {
      return h(Text, { color: 'cyan' }, `  ✎ ${t}█`);
    }
    const off = typedCursor.offset;
    const before = t.slice(0, off);
    const cursorChar = off < t.length ? t[off] : ' ';
    const after = off < t.length ? t.slice(off + 1) : '';
    return h(
      Text,
      { color: 'cyan' },
      '  ✎ ',
      h(Text, null, before),
      h(Text, { inverse: true }, cursorChar),
      h(Text, null, after)
    );
  };

  const contextLine = contextNote
    ? h(Text, { dimColor: true }, `  ${contextNote.replace(/\n/g, ' ')}`)
    : null;

  // 题干 = chip + 问题。**多卡时位置写进 chip**（`2/4 产物落盘`）—— 结构取自 ZCode 把
  // 进度放进面板标题（`Question 2/4: header`）；这样省掉单独一行「选项卡 1/2（←/→…）」，
  // 而左右可切换由页脚继续说（可发现性不降，行数少一行）。
  const chipText = cardCount > 1 ? `${qIdx + 1}/${cardCount} ${qHeader || '问题'}` : qHeader;
  const headerLine = chipText
    ? h(
        Text,
        null,
        h(Text, { color: 'cyan', bold: true, inverse: true }, ` ${chipText} `),
        ' ',
        h(Text, { color: 'yellow', bold: true }, qText)
      )
    : h(Text, { color: 'yellow', bold: true }, `? ${qText}`);
  // ── 尺寸收敛阶梯(BUG-57) ────────────────────────────────────────────
  // 一行一视觉行不是审美问题：40 列终端上每条「— 说明」折成 2-3 行，实测整框
  // 19 行 > 12 行屏幕，从底部掉出去的正是带「Esc 取消」的那一行(探针 AL)。
  // 三档，只在装不下时才降档，降档必须让用户看得出降了：
  //   full   —— 逐字节今日形态（放得下就绝不改样）
  //   clip   —— 每条说明截到一视觉行（省略号）
  //   labels —— 整条说明去掉，只留编号标签 + footer 上说明为什么少了
  // `cols`/`rows` 缺失时恒为 full —— 非浮层挂载点与改前完全一致。
  const inner = cols > 0 ? cols - PICKER_BOX_CHROME_COLS : 0;
  // ── 可读行宽上限(MEASURE_COLS) ──────────────────────────────────────────
  // 终端越宽,卡片越不该跟着变宽:说明句是模型写的一整句中文(约 35 字 = 70 列),铺在
  // 120 列表上就是「一行扫读困难」;页脚(约 62 列)也得整行放得下。所以排版宽度取
  // `min(可用内宽, 76)`:≥80 列终端上卡片收起成一张 ~80 列的卡片,说明折成两行并悬挂,
  // 而 80 列及以下的终端**一个像素都不变**(inner ≤ 76 时上限不生效)。
  const wrapInner = inner > 0 ? Math.min(inner, MEASURE_COLS) : 0;
  const previewSplit = hasPreview && !multi && cursor < options.length;
  // 预览版式下选项列只占框宽的左半（Box width:'50%' + marginRight:2）。
  const listInner =
    wrapInner > 0 && previewSplit ? Math.max(8, Math.floor(wrapInner / 2) - 2) : wrapInner;
  const footerBase = `  ${footer}`;
  // 最后一档（labels）会把「已省略选项说明」拼进 footer，而这一档恰恰出现在最挤
  // 的屏幕上：36 列内宽里 74 列的整串要占 3 行，比它替换掉的普通 footer 还多一行
  // ——降档反而吃掉一行。所以那一档同时把可发现性最低的两段（数字键、Space/多选）
  // 换成最小集「Enter · ↑/↓ · (←/→) · Esc」，提示才装得回 2 行(61 列)。
  const compactFooter = multi
    ? `Enter 确认本卡 · ↑/↓ 导航 · ${navHint}Esc 取消`
    : `Enter 选择 · ↑/↓ 导航 · ${navHint}Esc 取消`;
  function footerFor(mode) {
    return mode === 'labels' ? `  ${compactFooter}${LABELS_HINT}` : footerBase;
  }
  const plainHeader = chipText ? ` ${chipText}  ${qText}` : `?  ${qText}`;
  const plainContext = contextNote ? `  ${contextNote.replace(/\n/g, ' ')}` : '';
  // 进度已并进 chip（见 headerLine），不再单独占一行 —— 高度账本里也就不该有它。
  const plainProgress = '';

  function rowTextOf(spec, mode) {
    const body = `${spec.label}${spec.desc}`;
    if (mode === 'labels') return `${spec.prefix}${spec.label}`;
    if (mode === 'clip' && spec.desc) {
      const budget = pickerRowBudget(cols, spec.prefix, '');
      return `${spec.prefix}${budget > 0 ? clipCell(body, budget) : body}`;
    }
    return `${spec.prefix}${body}`;
  }

  /**
   * 选项行的**多行**形态(full 档)。
   *
   * 改前是「`前缀 + 标签  — 整句说明`」一根长字符串:说明一折行,续行就掉回**卡片左边界**
   * (与标签断链,视觉上读不出那是同一条选项的说明;探针见
   * `.khy/feedback/permission-notice-20260923/AA/two-probe-100.txt`)。
   * 现在续行悬挂在**值列**之下(与权限卡的字段同一套口径,cardLayout 单一真源)。
   *
   * 边界的纪律:不传 `cols` 时逐字节保持改前形态(组件不参与排版)——这是
   * questionPromptSize.test.js 的负对照所要求的,也是「非浮层挂载点行为不变」的承诺。
   */
  function rowLinesOf(spec, mode) {
    if (mode !== 'full' || !(cols > 0)) return [rowTextOf(spec, mode)];
    const flat = `${spec.prefix}${spec.label}${spec.desc}`;
    if (!spec.desc) return [flat];
    const lines = cardLayout.hangingRows(spec.prefix, `${spec.label}${spec.desc}`, listInner);
    return lines && lines.length ? lines : [flat];
  }

  function projectedHeight(mode) {
    if (rows <= 0 || cols <= 0) return 0;
    const chrome = [plainHeader, plainContext, plainProgress, footerFor(mode)].filter(Boolean);
    const chromeH = chrome.reduce((n, t) => n + visualRows(t, wrapInner), 0);
    const listH = rowSpecs.reduce(
      (n, s) => n + visualRows(rowLinesOf(s, mode).join('\n'), listInner),
      0
    );
    return 2 + chromeH + listH + (typing ? 1 : 0);
  }

  let rowMode = 'full';
  if (projectedHeight('full') > rows) rowMode = 'clip';
  if (rowMode === 'clip' && projectedHeight('clip') > rows) rowMode = 'labels';

  // ── [DESIGN-ARCH-146] 点击：行命中 + 展开 ────────────────────────────────
  // 关键事实（见方案 §5）:App.js 顶层 keyHandler 的鼠标段在「让键给浮层」之前约 106 行
  // 并无条件 return ⇒ 卡片自己的 useInput **收不到** SGR 序列,所以点击不靠解析序列,
  // 只靠给每一行挂 onClick。ink 的 collectLayout 命中该行时回调,闭包里的下标天然就是
  // 语义行下标 —— 无需任何屏幕坐标换算（这也是方案能保持「最小改动」的原因）。
  const clickEnabled = cardClick.cardClickEnabled(process.env);
  const expandedRow = expandedRows[qIdx];

  // 点击某一行：① 展开/收起该行完整说明；② 把键盘光标也移到该行，让点击后按 Enter
  // 能直接落在刚点的那一项上（否则「点一下再回车」会选到别处，是最容易踩的坑）。
  const onRowClick = (idx) => {
    if (!clickEnabled) return;
    const rowCount = rowSpecs.length;
    const hit = cardClick.normalizeRowIndex(idx, rowCount);
    if (hit == null) return;
    setExpandedRows((prev) => {
      const next = prev.slice();
      next[qIdx] = cardClick.toggleExpandedRow(prev[qIdx], hit);
      return next;
    });
    // 「Other」行被点击 = 想自由输入，与数字键同一语义（进入 typing 态）。
    const kind = rowKind(hit, options.length);
    if (kind === 'other') {
      setCursorAt(qIdx, hit);
      setTyping(true);
      setTypedCursor(new Cursor(otherValue, otherValue.length));
      return;
    }
    setCursorAt(qIdx, hit);
  };

  const rowNodes = rowSpecs.map((s, i) => {
    // 展开态：用**完整** desc 重排该行（受同一 listInner 预算约束），其余行维持当前档位。
    const isExpanded = expandedRow === i;
    const text = isExpanded
      ? cardClick.expandLine(`${s.prefix}${s.label}`, s.fullDesc || s.desc)
      : rowLinesOf(s, rowMode).join('\n');
    const textProps = { key: s.key, color: s.color, bold: s.bold, dimColor: s.dim };
    // 门控关：**原样**返回改前的 `Text` 节点（节点形态、key 层级、渲染路径三处都不变），
    // 满足 `questionPromptSize.test.js` 的「不传 cols 时逐字节保持改前形态」契约。
    if (!clickEnabled) return h(Text, textProps, text);
    // ⚠ [DESIGN-ARCH-146] 开点击时**必须包一层 `Box`，不能把 `onClick` 挂到 `Text` 上**。
    // ink 6.8.0 里 `Box` 用 `...style` 收集未知 props（→ `node.style.onClick`），
    // 而 `Text` 是固定 props 白名单 —— `onClick` 会被 React 静默丢弃、落不到 style，
    // `collectLayout` 因此永远看不到它 ⇒ 点击毫无反应且守卫/测试全绿（静默接线失效）。
    // 实证：`.khy/feedback/DESIGN-ARCH-146-card-click/probe-box-vs-text.txt`（5/5 PASS）。
    return h(
      Box,
      {
        key: s.key,
        flexDirection: 'column',
        // 不引入额外 margin/padding：行高仍与 `rowLinesOf` 的账本一致。
        onClick: () => onRowClick(i),
      },
      h(Text, { color: s.color, bold: s.bold, dimColor: s.dim }, text)
    );
  });
  const footerText = footerFor(rowMode);

  // ── 卡宽贴合内容 ────────────────────────────────────────────────────────
  // 与权限卡同一条规则(`width = min(最宽行, 可用宽)`):内容短就是一张窄卡片,而不是
  // 撑满终端、右边一大片空白。可用宽已知(cols>0)时才算;不传 cols → 不设宽度(改前形态)。
  const cardWidth = (() => {
    if (!(cols > 0)) return undefined;
    const candidates = [plainHeader, plainContext, plainProgress, footerText].filter(Boolean);
    for (const s of rowSpecs) {
      for (const ln of rowLinesOf(s, rowMode)) candidates.push(ln);
    }
    let w = 0;
    for (const t of candidates) {
      for (const ln of String(t).split('\n')) w = Math.max(w, visWidth(ln));
    }
    // 上限是 wrapInner(可读行宽),下限保一张窄卡也读得下去。
    return Math.min(w, wrapInner) + PICKER_BOX_CHROME_COLS;
  })();

  // Side-by-side layout when any option has preview (single-select only).
  if (previewSplit) {
    const preview = optPreview(options[cursor]);
    const leftPanel = h(
      Box,
      { flexDirection: 'column', width: '50%', marginRight: 2 },
      headerLine,
      contextLine,
      h(Box, { flexDirection: 'column' }, rowNodes),
      renderTyping(),
      h(Text, { dimColor: true }, footerText)
    );
    const rightPanel = preview
      ? h(
          Box,
          {
            flexDirection: 'column',
            width: '50%',
            borderStyle: 'single',
            borderColor: 'gray',
            paddingX: 1,
          },
          h(Text, { dimColor: true }, 'Preview:'),
          h(Text, null, preview)
        )
      : null;
    return h(
      Box,
      {
        flexDirection: 'row',
        borderStyle: 'round',
        borderColor: 'yellow',
        paddingX: 1,
        width: cardWidth,
      },
      leftPanel,
      rightPanel
    );
  }

  // Standard vertical layout (no preview or multi-select).
  return h(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'yellow',
      paddingX: 1,
      // 卡宽贴合内容(见上方 cardWidth);cols 未传 → undefined → yoga 照旧撑满,改前形态。
      width: cardWidth,
    },
    headerLine,
    contextLine,
    h(Box, { flexDirection: 'column' }, rowNodes),
    renderTyping(),
    h(Text, { dimColor: true }, footerText)
  );
}

module.exports = QuestionPrompt;
