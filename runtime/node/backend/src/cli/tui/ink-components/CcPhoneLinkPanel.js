'use strict';

/**
 * CcPhoneLinkPanel.js — CC 表面「手机联动」状态面板（Cc 前缀 = CC 模式专用）。
 *
 * 展示内容（全部来自 provider 的**同步**快照，render 路径零 IO）：
 *   设备状态 / 桥（在线·端口·mode·工具数）/ 令牌掩码 / 当前界面摘要 /
 *   最近 Amoo 任务与回复预览 / lite 构建边界说明 / 桥死时的 revive 提示。
 *
 * 为什么面板自己不算任何状态：判定与文案的单一真源在
 * `services/domain/network/amoo/amooPanelViewModel.js`（纯叶子，与 CLI 的
 * `renderStatusText` 各服务一棵渲染树）。本文件只做两件纯事：
 *   ① 把行模型排成「一行一条目」的窗口（照 CcCommandPalette 的行建模，BUG-70..76：
 *      把条目条数当高度预算会让 ink 走全屏分支，\x1b[2J 把旧帧滚进回滚缓冲）；
 *   ② 把 tone 映射到 theme/ccTheme.js 的颜色（不写 hex）。
 *
 * 纪律：React.memo + 行级 useMemo；颜色只从 CC_COLORS 取；每状态信号 ≤2（字形 + 颜色）；
 * 边框嵌套 ≤1；截断用 …（CJK 双宽感知）；门控写在父组件（CcApp 只在 CC 模式挂载）。
 */

const React = require('react');
const inkRuntime = require('../inkRuntime');
const { CC_COLORS } = require('../theme/ccTheme');
const ccLayout = require('./ccOverlayLayout');
// 显示宽度簇住在共享 substrate；直接取它而不是整个 formatters（那个模块还挂着
// printBanner 等一堆 CLI 输出函数，面板不需要）。
const { displayWidth, padToWidth, truncateToWidth } = require('../../../utils/text/width');

// ── tone → 字形 / 颜色（照 CcMcpStatus.js:19-41 的形状）─────────────────────

const TONE_ICONS = Object.freeze({
  ok: '✓',
  warn: '⚠',
  error: '✗',
  idle: '○',
  busy: '◐',
});

const TONE_COLORS = Object.freeze({
  ok: CC_COLORS.success,
  warn: CC_COLORS.warning,
  error: CC_COLORS.error,
  idle: CC_COLORS.dimColor,
  busy: CC_COLORS.toolName,
});

const KINDS = Object.freeze({
  TITLE: 'title',
  HEADLINE: 'headline',
  BADGES: 'badges',
  SECTION: 'section',
  ROW: 'row',
  HINT: 'hint',
  NOTE: 'note',
  DETAIL: 'detail',
  REPLY: 'reply',
  STEP: 'step',
  BLANK: 'blank',
  FOOTER: 'footer',
});

const PANEL_TITLE = '手机联动';
const PANEL_FOOTER = 'R 刷新 · Esc 关闭';
const TRUNCATED_NOTE = '（部分字段已截断，完整信息见 khy phone status）';
const REPLY_MARK = '> ';
const REPLY_HANG = '  ';
const HINT_MARK = '↳ ';
const LOADING_TEXT = '正在读取手机状态…';

function _isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function _str(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function _num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function _tone(value) {
  return Object.prototype.hasOwnProperty.call(TONE_ICONS, value) ? value : 'idle';
}

function _icon(tone) {
  return TONE_ICONS[_tone(tone)];
}

/** 按显示宽度裁切；空串原样返回（不补 …）。 */
function _clip(text, width) {
  const str = _str(text);
  const w = Math.max(4, Math.floor(Number(width) || 4));
  if (displayWidth(str) <= w) {
    return str;
  }
  // truncateToWidth 的省略号是 ASCII `...`（3 列）；§0.7 要求截断用 `…`（1 列）。
  // 收窄替换 ⇒ 只会更短，不会把行顶超（不动共享叶子 truncateToWidth 本身）。
  return truncateToWidth(str, w).replace(/\.{3}$/, '…');
}

/**
 * 组一行「前缀 + 记号 + 值」，值按**前缀之后的剩余宽度**裁切。
 * 这是行宽不溢出的唯一入口：所有行都走它，就不再会有「各行各算各的余量」的 off-by-one。
 */
function _rowText(prefix, icon, value, inner) {
  const head = `${prefix}${icon ? `${icon} ` : ''}`;
  return head + _clip(value, inner - displayWidth(head));
}

function _push(rows, kind, text, tone) {
  rows.push({ key: `${kind}:${rows.length}`, kind, text: _str(text), tone: _tone(tone) });
}

function _pushRow(rows, kind, prefix, icon, value, inner, tone) {
  _push(rows, kind, _rowText(prefix, icon, value, inner), tone);
}

function _pushHint(rows, labelW, hint, inner) {
  _push(rows, KINDS.HINT, _rowText(`  ${' '.repeat(labelW)}   ${HINT_MARK}`, null, hint, inner), 'idle');
}

function _pushSection(rows, label) {
  _push(rows, KINDS.SECTION, `── ${label} ──`, 'idle');
}

/** 标签列宽：取全部行的最大显示宽度，封顶 8（再宽就吃掉值列了）。 */
function _labelWidth(model) {
  const widths = Array.isArray(model.rows)
    ? model.rows.map((r) => displayWidth(_str(r && r.label)))
    : [];
  return Math.min(8, Math.max(3, ...(widths.length > 0 ? widths : [3])));
}

/** 「标签 记号 值」若干行；hint 单独一行悬挂（不塞进同一行把 30 列看板撑爆）。 */
function _pushLabelRows(rows, list, labelW, inner) {
  for (const row of Array.isArray(list) ? list : []) {
    const label = _clip(padToWidth(_str(row && row.label), labelW), labelW);
    _pushRow(rows, KINDS.ROW, `  ${label} `, _icon(row && row.tone), _str(row && row.value), inner, row && row.tone);
    // 停止原因 / 截断标注这类「为什么」只存在于 hint，不渲染就等于把
    // `reply_stable_text_stable` 丢在屏幕上看不见的地方。
    const hint = _str(row && row.hint);
    if (hint) {
      _pushHint(rows, labelW, hint, inner);
    }
  }
}

/** 最近任务 / 下发进度段。 */
function _pushDispatchSection(rows, dispatch, progress, labelW, inner) {
  _push(rows, KINDS.BLANK, '', 'idle');
  _pushSection(rows, progress ? '下发进度' : '最近任务');
  const dHead = _str(dispatch.headline);
  if (dHead) {
    _pushRow(rows, KINDS.ROW, '  ', _icon(dispatch.tone), dHead, inner, dispatch.tone);
  }
  _pushLabelRows(rows, dispatch.rows, labelW, inner);

  const preview = _str(dispatch.replyPreview);
  if (preview) {
    preview.split('\n').forEach((ln, i) => {
      _pushRow(rows, KINDS.REPLY, `  ${i === 0 ? REPLY_MARK : REPLY_HANG}`, null, ln, inner, 'ok');
    });
  }

  const steps = Array.isArray(dispatch.steps) ? dispatch.steps : [];
  if (steps.length > 0) {
    _push(rows, KINDS.BLANK, '', 'idle');
    _pushSection(rows, '执行步骤');
    for (const step of steps) {
      const detail = _str(step && step.detail);
      const idText = detail ? `${_str(step && step.id)}  ${detail}` : _str(step && step.id);
      const ok = step && step.ok === true;
      _pushRow(rows, KINDS.STEP, '  ', _icon(ok ? 'ok' : 'error'), idText, inner, ok ? 'ok' : 'error');
    }
  }
}

/** 备注 / 细节段（lite 构建边界、revive 提示、adb 未解析的 message…）。 */
function _pushNotesSection(rows, model, inner) {
  const notes = Array.isArray(model.notes) ? model.notes : [];
  const details = Array.isArray(model.details) ? model.details : [];
  if (notes.length === 0 && details.length === 0) {
    return;
  }
  _push(rows, KINDS.BLANK, '', 'idle');
  _pushSection(rows, '备注');
  for (const note of notes) {
    _pushRow(rows, KINDS.NOTE, '  ', _icon('warn'), _str(note), inner, 'warn');
  }
  for (const detail of details) {
    _pushRow(rows, KINDS.DETAIL, '  ', _icon('idle'), _str(detail), inner, 'idle');
  }
  if (model.truncated === true) {
    _pushRow(rows, KINDS.NOTE, '  ', _icon('idle'), TRUNCATED_NOTE, inner, 'idle');
  }
}

/**
 * 「为什么没有数据」必须上屏。provider 的 lastError（status_deadline /
 * collectStatus_failed / no_status_source）是唯一能说清这次读取出了什么事的字段；
 * 沉默的一屏 `—` 比错误更难排查 —— 实测：桥的 HTTP 线程卡死时 ping 要 10.25s，
 * 超过 provider 的 12s outer deadline，于是快照作废，此时若不说原因，用户只会看到
 * 一整屏 `—` 而不知道该去 revive 桥。
 */
function _pushReadFailure(rows, snap, inner) {
  if (_isPlainObject(snap.status) || !_str(snap.lastError)) {
    return;
  }
  _pushRow(rows, KINDS.DETAIL, '  ', _icon('error'), `读取失败：${_str(snap.lastError)}`, inner, 'error');
  // 下一步拆成两行而不是一长句：40 列下一句 38 字的提示会被 `…` 砍掉半边，
  // 而用户要的正是被砍掉的那半个（命令名）。
  _pushRow(rows, KINDS.DETAIL, '  ', _icon('idle'), '下一步：khy phone revive', inner, 'idle');
  _pushRow(rows, KINDS.DETAIL, '  ', _icon('idle'), '或 khy phone status 看完整原因', inner, 'idle');
}

/** 连行模型都没有时的那一屏：标题 + 一行结论 + 一句下一步。 */
function _pushHeadlineOnly(rows, snap, state, inner) {
  if (state === 'loading') {
    _pushRow(rows, KINDS.HEADLINE, '', _icon('busy'), LOADING_TEXT, inner, 'busy');
  } else if (state === 'error') {
    const why = _str(snap.lastError) || '未知原因';
    _pushRow(rows, KINDS.HEADLINE, '', _icon('error'), `读取失败：${why}`, inner, 'error');
    _pushRow(rows, KINDS.DETAIL, '  ', _icon('idle'), '可试 khy phone status 看完整原因', inner, 'idle');
  } else {
    _pushRow(rows, KINDS.HEADLINE, '', _icon('idle'), '尚未读取手机状态', inner, 'idle');
  }
}

/** 徽章行 + 链路段（adb / 设备 / 转发 / 桥 / 工具 / 令牌 / 界面）。 */
function _pushChainSection(rows, model, inner) {
  if (Array.isArray(model.badges) && model.badges.length > 0) {
    _push(
      rows,
      KINDS.BADGES,
      _clip(model.badges.map((b) => `[${_str(b && b.text) || '?'}]`).join(' '), inner),
      'warn'
    );
  }
  const labelW = _labelWidth(model);
  _push(rows, KINDS.BLANK, '', 'idle');
  _pushSection(rows, '链路');
  _pushLabelRows(rows, model.rows, labelW, inner);
  return labelW;
}

/**
 * 建面板行模型。纯函数：只吃快照与宽度，零 IO、确定性、绝不抛。
 *
 * 尾部的空行 + 页脚由**组件**追加，不进行模型：它们是画框的一部分，要跟行预算
 * 一起算（组件那边统一留位），行模型只负责内容。
 *
 * @param {object} [snapshot] provider.getSnapshot() 的产物
 * @param {object} [opts]
 * @param {number} [opts.width] 面板内容区显示宽度（列）
 * @returns {{rows: Array<{key:string, kind:string, text:string, tone:string}>,
 *            total:number, headlineTone:string}}
 */
function buildPhoneLinkLines(snapshot, opts = {}) {
  const options = _isPlainObject(opts) ? opts : {};
  const inner = Math.max(20, Math.floor(_num(options.width) || 40));
  const snap = _isPlainObject(snapshot) ? snapshot : {};
  const model = _isPlainObject(snap.model) ? snap.model : null;
  const state = _str(snap.state) || 'idle';

  const rows = [];
  // 标题：陈旧时打「数据停更」徽标（断网时「上次 3 秒前还在线」比空白有用）。
  _push(rows, KINDS.TITLE, `${PANEL_TITLE}${snap.stale === true ? '（数据停更）' : ''}`, 'idle');

  // ── 一行结论 ──
  if (!model) {
    _pushHeadlineOnly(rows, snap, state, inner);
    return { rows, total: rows.length, headlineTone: 'idle' };
  }

  _pushRow(rows, KINDS.HEADLINE, '', _icon(model.tone), _str(model.headline), inner, model.tone);
  _pushReadFailure(rows, snap, inner);

  // ── 链路七行 ──
  const labelW = _pushChainSection(rows, model, inner);

  // ── 最近任务 / 实时进度 ──
  const dispatch = _isPlainObject(model.dispatch) ? model.dispatch : null;
  if (dispatch) {
    _pushDispatchSection(rows, dispatch, _isPlainObject(model.progress) ? model.progress : null, labelW, inner);
  }

  _pushNotesSection(rows, model, inner);

  return { rows, total: rows.length, headlineTone: _tone(model.tone) };
}

// ── 组件 ────────────────────────────────────────────────────────────────────

/**
 * @param {object} props
 * @param {object} [props.snapshot] usePhoneLinkStatus 的快照
 * @param {number} [props.cols] 宿主列数
 * @param {number} [props.rows] 宿主行数
 * @param {Function} [props.onClose] Esc / 关闭
 * @param {Function} [props.onRefresh] R 手动刷新
 */
function CcPhoneLinkPanel({ snapshot, cols, rows, onClose, onRefresh }) {
  // 惰性取 ink 组件（loadInk 之后才安全）：原文漏导 Text/useInput，挂载即 ReferenceError。
  const { Box, Text, useInput } = inkRuntime.get();

  useInput((input, key) => {
    if (key.escape) {
      if (typeof onClose === 'function') onClose();
      return;
    }
    if (input === 'r' || input === 'R') {
      if (typeof onRefresh === 'function') onRefresh();
    }
  });

  const width = Math.max(20, ccLayout.termSize('cols', cols) - 6);
  const termRows = ccLayout.termSize('rows', rows);

  const model = React.useMemo(() => buildPhoneLinkLines(snapshot, { width }), [snapshot, width]);
  // 帧高账本（ledger == paint，AGENTS.md §0.9.2）：ink 在 outputHeight **等于** rows 时
  // 就进全屏分支（\x1b[2J 把旧帧滚进回滚缓冲），所以整帧必须 ≤ rows-1。
  //   边框 2 + 尾部空行 1 + 页脚 1 = 4，rowBudget 自己再扣 1 行全屏余量。
  // 提示行（「+N ↓」）**from 预算**：装不下时从内容里再让一格，绝不在预算之外追加
  // （BUG-88 同族：CcHelpMenu 曾把提示行 push 在预算外，实画恒 = 预算 + 1）。
  const budget = ccLayout.rowBudget(termRows, 4);
  let shown = model.rows.slice(0, budget);
  let hidden = model.total - shown.length;
  if (hidden > 0 && shown.length > 1) {
    shown = shown.slice(0, shown.length - 1);
    hidden = model.total - shown.length;
  }
  const hint = ccLayout.moreHint(0, shown.length, model.total);

  const children = shown.map((r) => {
    // 空行必须**真的占一行**：ink 里无子节点的 <Box> 会被 yoga 折叠成 0 高，
    // 于是段与段之间想要的那行间隔凭空消失（实测）。
    if (r.kind === KINDS.BLANK) {
      return React.createElement(Box, { key: r.key, height: 1 });
    }
    const isChrome = r.kind === KINDS.TITLE || r.kind === KINDS.SECTION;
    const isDim = r.kind === KINDS.HINT || r.kind === KINDS.DETAIL;
    const color = isChrome
      ? CC_COLORS.textSecondary
      : isDim
        ? CC_COLORS.dimColor
        : TONE_COLORS[r.tone];
    return React.createElement(
      Text,
      {
        key: r.key,
        color,
        bold: isChrome || r.kind === KINDS.HEADLINE,
        dimColor: isDim,
        wrap: 'truncate',
      },
      r.text
    );
  });

  if (hidden > 0) {
    // 溢出提示**单独占一行**，不把页脚文本并进来：并进来的话下面那个无条件 push 的
    // 页脚会让「R 刷新 · Esc 关闭」在一帧里出现两次（真机快照 + 最近任务段实测）。
    // 页脚由下面固定画，两种分支各占 1 行，帧高账本不变（BUG-88 同族）。
    children.push(
      React.createElement(
        Text,
        { key: 'more', color: CC_COLORS.dimColor, dimColor: true, wrap: 'truncate' },
        _clip(hint || `+${hidden} ↓`, width + 4)
      )
    );
  }
  children.push(React.createElement(Box, { key: 'tail-blank', height: 1 }));
  children.push(
    React.createElement(
      Text,
      { key: 'footer', color: CC_COLORS.dimColor, dimColor: true, wrap: 'truncate' },
      PANEL_FOOTER
    )
  );

  return React.createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'single', borderColor: CC_COLORS.border, paddingX: 1 },
    children
  );
}

module.exports = {
  CcPhoneLinkPanel: React.memo(CcPhoneLinkPanel),
  buildPhoneLinkLines,
  TONE_ICONS,
  TONE_COLORS,
  KINDS,
  PANEL_TITLE,
  PANEL_FOOTER,
};
