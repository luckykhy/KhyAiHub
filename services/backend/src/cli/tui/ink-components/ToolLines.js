'use strict';

/**
 * ToolLines — renders a list of tool calls as an ink tree, Claude-Code style:
 *   ◆ name(arg-summary)            (pending)
 *   ✓ name(arg-summary)            (done)
 *   ✗ name(arg-summary)            (error)
 * When `expanded` is true, the tool result preview is shown indented beneath.
 */
const React = require('react');

const { diffClipWidth } = require('../../diffContentWidth');
// diffLineNumbers 的消费方(buildShellDiffRows)已下移至 cli/writeDiffRows.js([DESIGN-ARCH-157] B 刀)。
const { stripInternalControlText } = require('../../repl/displayFormatters');
const { resultLineLead } = require('../../resultLineGlyph');
const { formatShellOutputJson } = require('../../shellOutputJson');
const { foldOutput, collapseConsecutiveDuplicates } = require('../../toolDisplayPolicy');
const { argDisplayCap } = require('../../toolHeaderCap');
const { pathMiddleTruncateEnabled, truncatePathMiddle } = require('../../toolParamPath');
const { shouldRenderTransparentBody } = require('../../toolResultTransparency');
// [DESIGN-ARCH-155] 行语法单一生产者:分隔符 / 结果量拆分 / 既有 formatToolDuration 委派目标。
const { SEP, summarizeToolResultParts } = require('../../toolDisplayLine');
// 从结果摘要整句拆 { claim, quantity } 的纯字符串拆分器——与 summarizeToolResultParts
// 的 _splitResultSummary 同源(由 toolResultSummary 导出),此处只是取一个短别名。
const { _splitResultSummary: splitResultSummary } = require('../../toolResultSummary');
// [DESIGN-ARCH-157] B 刀：diff 行模型（buildWriteDiffRows/buildShellDiffRows/
// looksLikeUnifiedDiff/planWordDiffPairs）下移到 cli/writeDiffRows.js，本文件只留
// ink 渲染体；对外导出面经 module.exports 原样转发，消费方（PermissionsPrompt、
// 单测、editDiffPreview 链路）无需改路径。
const {
  buildWriteDiffRows,
  buildShellDiffRows,
  looksLikeUnifiedDiff,
  planWordDiffPairs: _planWordDiffPairsLeaf,
} = require('../../writeDiffRows');
const { effectiveCols } = require('../effectiveCols');
const inkRuntime = require('../inkRuntime');
const _mouse = require('../mouseButtons');
// 有效列宽单一真源:右栏(railLayout)激活时工具输出只能按 cols - 栏宽 折行,否则宽出来的
// 行会软换行成额外视觉行(高度账本没算过)并溢进槽位。门控关 → 真实列宽 → 逐字节 legacy。
// 传 undefined 作 fallback:diffClipWidth 对「宽度未知」有专门语义,不能替成 80。
// Single source of truth for fold rules — shared with the classic REPL renderer
// (toolDisplay.js). Reused here so command output folds identically in both UIs.

// Live parallel sub-agent tree (├│└). Attached to an agent tool row as
// `_agentTree` by the bridge (useQueryBridge.reduceAgentTree); rendered here in
// place of the single agent(...) line once at least one child has spawned.
const AgentTree = require('./AgentTree');
// 已完成工具的 diff 行按输入对象身份 WeakMap 记忆(消每帧重跑 computeStructuredDiffHunks/splitDiffLines)。
// 门控 KHY_TOOL_DIFF_ROWS_MEMO 关 → 直接构造(逐字节回退)。见 toolDiffRowsMemo.js 头注释。
const _toolDiffRowsMemo = require('./toolDiffRowsMemo');
// 已完成工具的 LITERAL(非 diff)输出体按 result 身份记忆:preview(formatShellOutputJson)+
// 折叠行 shownLines(split+collapse+fold),消每帧对整份 stdout 的 JSON 美化尝试与全量折叠。
// 门控 KHY_TOOL_LITERAL_OUTPUT_MEMO 关 → 直接构造(逐字节回退)。见 toolLiteralOutputMemo.js 头注释。
const _toolHeaderSummaryMemo = require('./toolHeaderSummaryMemo');
const _toolLiteralOutputMemo = require('./toolLiteralOutputMemo');
// 视觉行计费单一真源(DESIGN-ARCH-103 H6):折叠行预截断(1 逻辑行 = 1 视觉行),
// 故经 visualRowsUnwrapped 计费;将来若引入宽度感知渲染,同一处切到 visualRows 即可。
const { visualRowsUnwrapped } = require('../wrapCell');

// 已完成/运行中工具的头行(显示名 resolveToolHeaderName + 入参摘要 summarizeArgs)按 (tool, cwd)
// 身份记忆:消每帧对每工具的 2×require+主题查表、JSON.parse 大入参、以及 summarizeArgs 内的
// process.cwd() 系统调用。门控 KHY_TOOL_HEADER_SUMMARY_MEMO 关 → 直接构造(逐字节回退)。
// Single source for stripping internal [SYSTEM:…]/[STOP]/[Loop…] control text from
// the visible ✗ line — shared with the classic REPL renderer (displayFormatters).
// 工具结果透明化(纯叶子 SSOT):非命令类工具若携带真实输出体,也像 CC 一样在 ⎿ 下
// 透明显示其真实结果。门控 KHY_TOOL_RESULT_TRANSPARENT 默认开;关 → 回退「✓ 摘要」。
// 命令输出 JSON 行美化(纯叶子 SSOT):对齐 CC OutputLine,把输出里压扁成一坨的 JSON
// 行逐行缩进展开(带精度守卫)。门控 KHY_SHELL_OUTPUT_JSON 默认开;关 → 原样字节回退。
// ±diff 行号化(纯叶子 SSOT):给命令/`git diff` 的 unified-diff 行补 CC 那样的行号
// gutter(参考 Image#2)。门控 KHY_DIFF_LINE_NUMBERS 默认开;关 → 不赋 num 字节回退。
// 结果/摘要行起首字形(纯叶子 SSOT):把结果行从绿色 `✓ 摘要` 统一成 CC 的暗色 `⎿ 摘要`
// elbow,与命令正文同一视觉语言。门控 KHY_RESULT_ELBOW 默认开;关 → 回退 `✓` 绿色。
// 工具头行路径中间截断(纯叶子 SSOT):read/write/edit 的 file_path 放不下时,像 CC 的
// truncate.ts `truncatePathMiddle` 那样从**中间**塞 `…` 保住文件名(末尾截断会把文件名
// 截没)。门控 KHY_TOOL_PATH_MIDDLE_TRUNCATE 默认开;关 → 末尾截断字节回退。
// 工具头行 arg-summary「长度上限」单一真源(纯叶子):对齐 CC 的**按工具**头展示——
// Bash 命令头按 `MAX_COMMAND_DISPLAY_CHARS=160`(BashTool/UI.tsx)、grep pattern 按
// 50(toolLimits.ts)。Khy 历史对**每个** key 一律 `truncate(...,60)`:多数 key 的 60 ≥ CC
// 的 per-tool 上限(如 grep pattern 60>50,显得更多非更差)故保留;唯独 Bash `command` 的 60
// 远低于 CC 的 160,而 Ink TUI 里命令**只**出现在这条头行(不像经典 REPL 另有整命令 box)→
// 61–160 字命令被截断且无处可寻=明显比 CC 差。门控 KHY_TOOL_HEADER_CAP 默认开;关 → 每个 key
// 恒 60 字节回退。只对齐**字符**上限,不引入 CC 的 2 行多行头(Khy 刻意单行折叠见刀17)。
// diff 内容列「裁切宽度」单一真源(纯叶子):对齐 CC StructuredDiff Fallback.tsx 的
// `availableContentWidth = max(1, width - maxWidth - 1 - diffPrefixWidth)` + wrapText('wrap')。
// 此前 diff 行恒按固定 100 字 `clip(text,100)` 硬截——无视终端宽度、且**展开(Ctrl+O)后仍截**,
// 把列 100 之后的代码静默吞掉,违背本文件自述的「Ctrl+O 真正显示全貌」诚实原则。改:折叠态按
// 终端列宽算单行预算裁切;展开态返回 Infinity(=不裁,交 ink 像 CC 一样自动换行,绝不丢内容)。
// 门控 KHY_DIFF_CONTENT_WIDTH 默认开;关 → 恒 100 字裁切,逐字节回退。

// 工具卡片边框颜色单一真源(零散落字面量):运行中=黄、完成=绿、错误=红、悬停=蓝。
// 与 layout-preview.html 设计对齐:每个工具调用是带颜色边框的可点击卡片。
const TOOL_CARD_COLOR = {
  running: 'yellow',
  done: 'green',
  error: 'red',
  hover: 'blue',
};

// Tools whose result IS literal command / third-party-app stdout. Only these
// get the "few lines + fold + Ctrl+O expand" treatment; the agent's own prose
// and structured results are rendered in full elsewhere and never folded here.
const SHELL_FAMILY = new Set(['bash', 'shell', 'shellcommand', 'command', 'terminal', 'pty']);
function isShellResult(name) {
  return SHELL_FAMILY.has(
    String(name)
      .toLowerCase()
      .replace(/[\s_-]/g, '')
  );
}

// Most-descriptive common arg keys, in preference order. Hoisted to a module
// constant so summarizeArgs() iterates one shared array instead of rebuilding
// the literal each header render. Read-only iterand; never mutated.
const _ARG_SUMMARY_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'query',
  'url',
  'prompt',
  'description',
];

function summarizeArgs(tool) {
  const raw = tool.input ?? tool.args ?? tool.parameters ?? tool.arguments;
  if (raw == null) {
    return '';
  }
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return truncate(raw, 60);
    }
  }
  if (typeof obj !== 'object') {
    return truncate(String(obj), 60);
  }
  // Prefer the most descriptive common keys.
  for (const key of _ARG_SUMMARY_KEYS) {
    if (obj[key]) {
      // Path-like params (file_path / path): first RELATIVIZE to cwd (CC
      // toRelativePath — saves columns / readability; paths outside cwd stay
      // absolute to remain unambiguous), THEN middle-truncate so the basename
      // survives (CC truncatePathMiddle). Others keep the legacy end-truncate.
      // KHY_TOOL_RELATIVE_PATH off → relativizeToolPath returns the value
      // unchanged → byte-identical to the legacy absolute-path behavior.
      if (key === 'file_path' || key === 'path') {
        const relPath = require('../../ccRelativePath').relativizeToolPath(
          String(obj[key]),
          process.cwd(),
          process.env
        );
        // CC FileReadTool/UI.tsx: Read headers append the line-range
        // (offset/limit → `第 X-Y 行` / `从第 X 行起`) AFTER the path. Only
        // for read tools (write/edit/grep don't carry offset/limit); gate
        // KHY_READ_RANGE_SUFFIX off → '' → byte-identical to the bare path.
        const _rr = require('../../readRangeSuffix');
        const suffix = _rr.isReadToolName(tool.name || tool.toolName || tool.tool)
          ? _rr.buildReadRangeSuffix(obj, process.env)
          : '';
        if (pathMiddleTruncateEnabled()) {
          const raw = relPath.replace(/\s+/g, ' ').trim();
          // truncatePathMiddle 按显示宽度判断「放得下就原样返回」,故无需 `raw.length > 60`
          // 的 code-unit 预判(那会对 CJK 路径误判「放得下」而漏截,列宽撑破工具头行)。
          // 宽度门控关时策略退化 code-unit → 与旧 `>60?…:raw` 逐字节一致。
          return truncatePathMiddle(raw, 60) + suffix;
        }
        return truncate(relPath, 60) + suffix;
      }
      // Non-path descriptive keys keep the legacy end-truncate, but route the
      // CAP through the per-key SSOT: the Bash `command` key rises to CC's 160
      // (gate KHY_TOOL_HEADER_CAP on), every other key stays at the legacy 60;
      // gate off → 60 for all, byte-identical.
      return truncate(String(obj[key]), argDisplayCap(key, process.env));
    }
  }
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    return '';
  }
  return truncate(keys.map((k) => `${k}=${shorten(obj[k])}`).join(', '), 60);
}

// [DESIGN-ARCH-155] 头行字段的纯组装（渲染体的可测孪生）。
// 把渲染体里的「行语法 or 回退旧形态」二选一逻辑提出来，单测/估算器锁契约不需要起 ink：
//   行语法可用 → { verb, target, quantity, durTag, mode:'line' }
//   取不到动词 → { mode:'legacy' }（渲染走 `名(摘要)` 老形态）
// quantity 从 bridge 已算好的 result.summary 整句拆出；无 summary 才回源一次。
function headerFields(t, opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd != null ? opts.cwd : process.cwd();
  const name = t && (t.name || t.toolName || t.tool || 'tool');
  const rawInput = t ? (t.input ?? t.args ?? t.parameters ?? t.arguments) : undefined;
  const result = t ? t.result : undefined;
  const done = !!result;
  const isErr = !!(
    done &&
    (result.isError || result.is_error || result.error || result.success === false)
  );
  const durTag = toolHeaderDurationEnabled(env) ? formatToolDuration(toolDurationMs(t)) : '';
  try {
    const line = require('../../toolDisplayLine');
    const verb = line.toolVerb(name);
    if (!verb) {
      return { mode: 'legacy', name, argSummary: summarizeArgs(t), durTag, isErr };
    }
    const target = line.toolTarget(name, rawInput, { env, cwd });
    let quantity = '';
    if (done && !isErr) {
      const rawSummary = result && result.summary;
      const parts =
        typeof rawSummary === 'string' && rawSummary
          ? Object.assign({ full: rawSummary }, splitResultSummary(rawSummary))
          : summarizeToolResultParts(name, result, rawInput || {});
      quantity = line.resultSegment(parts, target);
    }
    return { mode: 'line', name, verb, target, quantity, durTag, isErr };
  } catch {
    return { mode: 'legacy', name, argSummary: summarizeArgs(t), durTag, isErr };
  }
}

function shorten(v) {
  if (v == null) {
    return '';
  }
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  // Budget is 24 characters — slice by CODE POINT so an astral char (emoji /
  // CJK ext-B) is never bisected into a lone surrogate on the header line.
  // For all-BMP text code points == UTF-16 units, so ASCII/CJK output stays
  // byte-identical to the previous `s.slice(0, 23)`.
  const g = Array.from(s);
  return g.length > 24 ? g.slice(0, 23).join('') + '…' : s;
}

// ── 工具头行内联耗时标记 ──
// [DESIGN-ARCH-155] P2:实现移入 toolDisplayLine(跨端 SSOT,§3 R6 禁止第二份时长口径),
// 此处保留同名转发——既有调用点与 ToolLines.formatToolDuration 单测不动。
// 门控 KHY_TOOL_HEADER_DURATION 语义不变(关 → 调用方不渲染耗时位)。
function formatToolDuration(ms) {
  return require('../../toolDisplayLine').formatToolDuration(ms);
}

// Gate KHY_TOOL_HEADER_DURATION (default on): the header shows a duration slot at
// all. Missing durationMs still renders nothing (honesty rule lives in
// toolDisplayLine.formatToolDuration) — this gate only removes the SLOT.
function toolHeaderDurationEnabled(env = process.env) {
  const flag = String((env && env.KHY_TOOL_HEADER_DURATION) || '')
    .trim()
    .toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

// Real per-tool elapsed: the tool object first (chunk/persisted-timeline
// stamp), then its result (loop stamp). 0 → unknown → no tag.
function toolDurationMs(t) {
  if (!t) {
    return 0;
  }
  if (Number(t.durationMs) > 0) {
    return Number(t.durationMs);
  }
  const r = t.result;
  if (r && typeof r === 'object' && Number(r.durationMs) > 0) {
    return Number(r.durationMs);
  }
  return 0;
}

// ── 结果体截断标记 ──
// Gate KHY_TOOL_RESULT_TRUNCATION_TAG (default on): when the DISPLAYED result
// body carries fewer content characters than the full result text, append a dim
// `[已截断 shown/total 字]` marker with the REAL counts (same append-a-dim-line
// style as the fold footers / arg-summary `…` truncation). Fold markers
// (`… +N 行…`) are display chrome, not result content, so they are excluded
// from the shown count. Computed OUTSIDE the toolLiteralOutputMemo caches from
// their (stable, cached) outputs — inputs can never go stale and the per-frame
// cost is a bounded line-length sum over the already-folded window.
function toolResultTruncationTagEnabled(env = process.env) {
  const flag = String((env && env.KHY_TOOL_RESULT_TRUNCATION_TAG) || '')
    .trim()
    .toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

const _FOLD_MARKER_RE = /^… \+\d+ 行/;

function buildResultTruncationTag(fullText, shownLines, opts) {
  try {
    const total = String(fullText == null ? '' : fullText).replace(/\n/g, '').length;
    if (!(total > 0) || !Array.isArray(shownLines)) {
      return '';
    }
    let shown = 0;
    for (const ln of shownLines) {
      const s = String(ln == null ? '' : ln);
      if (_FOLD_MARKER_RE.test(s)) {
        continue;
      } // display chrome, not content
      shown += s.length;
    }
    if (shown >= total) {
      return '';
    }
    // 加法式扩展(向后兼容):不传 opts / opts 为空 → 与历史逐字节相同的
    // `[已截断 shown/total 字]`。传了才追加「原因」与「退出码」——
    // 用户诉求「截断却没有原因和错误码」的落点。
    const o = opts && typeof opts === 'object' ? opts : null;
    const reason = o && typeof o.reason === 'string' ? o.reason.trim() : '';
    const exitCode =
      o && typeof o.exitCode === 'number' && Number.isInteger(o.exitCode) ? o.exitCode : null;
    if (!reason && exitCode === null) {
      return `[已截断 ${shown}/${total} 字]`;
    }
    const parts = [`已截断 ${shown}/${total} 字`];
    if (reason) {
      parts.push(`原因：${reason}`);
    }
    if (exitCode !== null) {
      parts.push(`退出码 ${exitCode}`);
    }
    return `[${parts.join(' · ')}]`;
  } catch {
    return '';
  }
}

/**
 * 判定「为什么这段结果体被截短了」——纯字符串,零 IO、绝不抛。
 *
 * 优先级(高 → 低):① 工具自身声明了截断(`result.truncated === true`,输出超工具上限);
 * ② 行折叠(shownLines 里带 `… +N 行` 标记);③ 行宽裁剪(内容被 clip 到终端列宽)。
 * 判不出来 → ''(调用方据此只输出历史那句 `[已截断 X/Y 字]`,绝不臆造原因)。
 *
 * @param {string[]} shownLines - 已折叠/裁切、即将渲染的行
 * @param {object} [result] - 工具结果对象(可能带 truncated / diskPath)
 * @param {boolean} [expanded] - Ctrl+O 展开态
 * @returns {string} 人类可读原因;无法判定 → ''
 */
function describeTruncationReason(shownLines, result, expanded) {
  try {
    // ① 工具侧自己截断了(与显示策略无关:这是数据源头就少了一截)。
    //    字段由工具自身返回(如 readFile / FileReadTool 的 `truncated: oversize`,
    //    带盘路径时另有 diskPath);TUI 的 adapter-native tool_result 路径保留原形
    //    (useQueryBridge「no field stripping here」),故该分支可达。工具不返回该字段时
    //    自然落到 ②/③ —— 不猜、不伪造。
    if (result && result.truncated === true) {
      return result.diskPath ? '工具输出超上限(完整结果已存盘)' : '工具输出超上限';
    }
    // ② 行折叠:`foldOutput` 插入的 `… +N 行 (ctrl+o 展开)` 是确定性结构标记。
    let hidden = 0;
    let visible = 0;
    if (Array.isArray(shownLines)) {
      for (const ln of shownLines) {
        const s = String(ln == null ? '' : ln);
        const m = /^… \+(\d+) 行/.exec(s);
        if (m) {
          hidden += Number(m[1]) || 0;
          continue;
        }
        visible += 1;
      }
    }
    if (hidden > 0) {
      const cap = expanded ? 0 : SHELL_COLLAPSED_POLICY.maxLines;
      const total = visible + hidden;
      // 紧凑是刻意的:标记行只占 estimateLiteralRows 的 1 行预算,过长会被下游 clip
      // 掉尾部 —— 那样「原因」反而丢了。被隐藏的行数由紧邻的 `… +N 行` 折叠标记负责。
      return cap > 0 ? `${total} 行 > 上限 ${cap} 行` : `${total} 行(隐藏 ${hidden} 行)`;
    }
    // ③ 没折行 → 只能是行宽被裁到终端列宽。
    const cols = effectiveCols(undefined);
    return Number.isFinite(cols) && cols > 0 ? `行宽超终端 ${cols} 列` : '显示宽度受限';
  } catch {
    return '';
  }
}

// A UTF-16 surrogate code unit anywhere in the string → it carries astral
// chars. `displayWidth(s) !== s.length` alone misses these: an astral emoji is
// 2 display columns AND 2 UTF-16 code units, so it compares equal and the
// legacy `.length`-based path below would bisect the pair into a lone surrogate
// (乱码). Route such strings through the code-point-aware truncater instead.
const _SURROGATE_RE = /[\uD800-\uDFFF]/;

function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  // Width-aware truncation only when the string contains wide chars (CJK =
  // 2 columns): the legacy byte-level end-truncate is already width-correct
  // for narrow-only strings and its output is locked byte-for-byte by tests.
  // Lazy require with byte-level fallback so a formatters load failure can
  // never break tool-line rendering.
  try {
    const { displayWidth, truncateToWidth } = require('../../formatters');
    if (displayWidth(s) !== s.length || _SURROGATE_RE.test(s)) {
      return truncateToWidth(s, n);
    }
  } catch {
    /* formatters unavailable — legacy fallback below */
  }
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Length-only clip that PRESERVES whitespace — diff lines must keep their
// indentation (collapsing it would mangle code), unlike the arg-summary path.
// `n` is a DISPLAY-COLUMN budget (e.g. cols - 10), not a char count, so a CJK
// line (2 columns per glyph) must be measured in columns: the legacy `.length`
// compare wrongly deems a 48-char/76-column line "short enough" for a 70-column
// budget and leaves it intact → ink soft-wraps it → the foldOutput row budget
// is breached. Route wide strings through the width-aware truncater (which does
// NOT collapse whitespace); narrow-only strings keep the byte-identical legacy
// path so existing ASCII output/tests are untouched.
function clip(s, n) {
  s = String(s ?? '');
  if (!Number.isFinite(n)) return s; // Infinity → full line, let ink wrap (Ctrl+O 全貌)
  try {
    const { displayWidth, truncateToWidth } = require('../../formatters');
    if (displayWidth(s) !== s.length || _SURROGATE_RE.test(s)) {
      return displayWidth(s) > n ? truncateToWidth(s, n) : s;
    }
  } catch {
    /* formatters unavailable — legacy fallback below */
  }
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// diff 色板唯一真源 cli/diffSpec.js([DESIGN-ARCH-157] A 刀残余):此前此处硬编码
// CC 字面量绕过主题系统;renderDiffRows 每帧经 diffColors() 取当前活动主题色,
// 门控 KHY_DIFF_SPEC_V1 关 / default 主题 → 与旧常量逐字节相同。
// (原 DIFF_ADD_BG/DIFF_DEL_BG/DIFF_ADD_WORD_BG/DIFF_DEL_WORD_BG 已删。)

// Inline-view policy lives in cli/diffSpec.js FOLD(SSOT);行模型见 writeDiffRows.js。

// Shell / third-party-app stdout fold rule (TUI). Deliberately MORE generous than
// the shared `bash` policy (maxLines:6): a command result that is "not too long"
// should show in FULL — folding kicks in only past SHELL_MAX_LINES, keeping a
// head+tail window. The user reads command output as a unit, so a 6-line cap felt
// over-eager; 20 lines is the "not too long" threshold before we fold.
const SHELL_COLLAPSED_POLICY = { maxLines: 20, foldHead: 12, foldTail: 6 };
// Claude Code result connector: a "⎿" elbow on the FIRST output line, with
// continuation lines aligned beneath it. Marks the block as LITERAL command /
// third-party-app output — distinct from the user's prompt (❯), the user's own
// `!` command (!), and the AI's prose (no connector). Mirrors the classic REPL
// (toolDisplay.js) so both renderers speak the same CC visual language.
const SHELL_ELBOW = '⎿ ';
const SHELL_CONT = '  ';

// Word-level (intra-line) diff highlighting in the TUI. 「先红后绿」渲染下不做词级
// 配对/高亮:同一 hunk 内所有 del 行(红 -)先列、再列所有 add 行(绿 +),整行铺底色,
// 不再做 1:1 配对或词级子段高亮(planWordDiffPairs 因此被禁用)。保留门控
// KHY_TUI_WORD_DIFF 以便紧急回滚;默认 off(=0/false/off/no)。设 =1/yes/on 仍可启用
// 旧的 1:1 配对词级高亮(但行顺序不变,仍是「先红后绿」)。
function tuiWordDiffEnabled(env = process.env) {
  const flag = String((env && env.KHY_TUI_WORD_DIFF) || '')
    .trim()
    .toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
}

// Render structured diff rows as an ink column. Keeps indentation intact (clip,
// not truncate) so code lines read correctly. `expanded` (Ctrl+O) widens the
// per-cell content budget to Infinity so ink wraps the full line instead of
// truncating (CC parity); collapsed clips to a terminal-width-aware single row.
//
// 双列 gutter(KHY_DIFF_DUAL_GUTTER 默认开,DSH old|new 口径):del 左=旧号右=空、
// add 左=空右=新号、ctx 两列;gutterWidth 语义 = 两列位宽 + 1 分隔位,同步进
// diffContentWidth 的内容预算,行不因 gutter 变宽而溢出。门控关 → 单列逐字节回退。
function renderDiffRows(rows, h, Box, Text, expanded = false) {
  // 词级高亮开关收敛到 cli/diffSpec.wordHighlightEnabled(D 刀三端统一口径,默认开;
  // 兼容旧名 KHY_TUI_WORD_DIFF)。「先红后绿」行序下 planWordDiffPairs 按 del 块/add 块
  // 下标配对 —— 与 buildWriteDiffRows 的相似度交错配对(同侧同义)一致。
  let wd = null;
  if (require('../../diffSpec').wordHighlightEnabled(process.env)) {
    try {
      wd = require('../../wordDiff');
    } catch {
      wd = null;
    }
  }
  // gutter 真源 cli/diffGutter.js(对齐 CC 动态位宽,门控关→恒 4 位字节回退)。
  const gutter = require('../../diffGutter');
  const dual = gutter.dualGutterEnabled(process.env);
  const gw = gutter.computeDiffGutterWidth(rows, process.env);
  // 双列总占位 = 2×位宽 + 1 分隔空位;单列维持位宽本身(历史口径)。
  const gutterCols = dual ? gw * 2 + 1 : gw;
  // 内容裁切宽度走 diffContentWidth 叶子:折叠→按终端列宽单行预算;展开→Infinity 不裁(ink 换行)。
  // 门控关 → 恒 100,逐字节回退到历史固定裁切。
  const clipW = diffClipWidth({
    columns: effectiveCols(undefined),
    gutterWidth: gutterCols,
    expanded,
    env: process.env,
  });
  // diff 色板唯一真源 cli/diffSpec.js([DESIGN-ARCH-157]):default 主题 / 门控关
  // → 与旧 DIFF_*_BG 硬编码常量逐字节相同;非默认主题下随主题换色(新能力)。
  const dc = require('../../diffSpec').diffColors(process.env);
  const plan = wd ? _planWordDiffPairsLeaf(rows, wd, clipW, clip) : null;
  // 双列 gutter 单元格:del → [old, 空] / add → [空, new] / ctx → [old, new]。
  const cells = (r) => gutter.formatDualGutterNums(r, gw).join(' ');
  return h(
    Box,
    { key: 'diff', flexDirection: 'column', marginLeft: 2 },
    ...rows.map((r, j) => {
      const num = gutter.formatDiffGutterNum(r.num, gw);
      // Paired remove/add lines with word-level segments: paint changed sub-spans
      // on the brighter word background, the rest on the line background.
      const seg = plan && plan.get(j);
      if (seg) {
        const lineBg = seg.side === 'add' ? dc.add : dc.del;
        const wordBg = seg.side === 'add' ? dc.addWord : dc.delWord;
        const sign = seg.side === 'add' ? '+' : '-';
        const prefix = dual ? `${cells(r)} ${sign} ` : `${num} ${sign} `;
        return h(
          Box,
          { key: j },
          h(Text, { color: dc.text, backgroundColor: lineBg }, prefix),
          ...seg.segs.map((s, k) =>
            h(
              Text,
              {
                key: k,
                color: dc.text,
                backgroundColor: s.changed ? wordBg : lineBg,
              },
              s.text
            )
          )
        );
      }
      if (r.kind === 'add') {
        const body = dual ? `${cells(r)} + ${clip(r.text, clipW)}` : `${num} + ${clip(r.text, clipW)}`;
        return h(Text, { key: j, color: dc.text, backgroundColor: dc.add }, body);
      }
      if (r.kind === 'del') {
        const body = dual ? `${cells(r)} - ${clip(r.text, clipW)}` : `${num} - ${clip(r.text, clipW)}`;
        return h(Text, { key: j, color: dc.text, backgroundColor: dc.del }, body);
      }
      if (r.kind === 'ctx') {
        const body = dual ? `${cells(r)}   ${clip(r.text, clipW)}` : `${num}   ${clip(r.text, clipW)}`;
        return h(Text, { key: j, dimColor: true }, body);
      }
      return h(Text, { key: j, dimColor: true }, clip(r.text, clipW));
    })
  );
}

function resultPreview(result) {
  if (!result) {
    return '';
  }
  const text = result.text || result.content || result.output || '';
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  return s;
}

/**
 * Render a tool result's LITERAL output body the Claude-Code way: a "⎿" elbow on
 * the first line, continuation lines aligned beneath, the whole block dim — folded
 * to a head+tail window with a "… +N 行 (ctrl+o 展开)" marker when collapsed, fully
 * revealed when expanded. `git diff`-shaped output keeps the red/green colouring.
 * A non-zero exit code is annotated beneath. Returns the ink children array, or
 * `null` when the result carries no real output body (caller then shows ✓ summary).
 *
 * This is the SINGLE source for literal-output rendering, shared by the shell-family
 * branch AND the (gated) transparency branch for other tools — so both render the
 * real command/result output identically, never a black box behind a "✓ 完成" line.
 */
function renderLiteralOutput(result, expanded, h, Box, Text) {
  // 对齐 CC:命令输出体在切行/折叠**之前**先逐行尝试 JSON 美化(CC OutputLine 的
  // tryJsonFormatContent 也是先美化再截断)。门控关/非 JSON → 逐字节原样。
  // preview 是 (result, env) 的确定性纯函数、与 expanded/列宽无关 → 按 result 身份记忆,
  // 消每帧对整份 stdout 的 JSON parse+pretty-print(diff 分支也先算 preview,故此记忆两分支共享)。
  const preview = _toolLiteralOutputMemo.memoPreview(
    result,
    () => formatShellOutputJson(resultPreview(result), process.env),
    process.env
  );
  if (!preview || !preview.trim()) {
    return null;
  }
  const out = [];
  // 截断标记里是否已经带了退出码(带了就不再补下方那条 `↳ 退出码 N`,同一信息只出现一次)。
  let tagCarriesExit = false;
  // `git diff`-shaped stdout keeps the classic red/green colouring. 行数据按 result 对象身份记忆
  // (已完成工具 result 冻结 → 消每帧 splitDiffLines 全量重切 + 逐行分类);门控关 → 直接构造。
  const shellDiffRows = _toolDiffRowsMemo.memoDiffRows(result, expanded, () =>
    looksLikeUnifiedDiff(preview) ? buildShellDiffRows(preview, expanded) : null
  );
  if (shellDiffRows && shellDiffRows.length) {
    out.push(renderDiffRows(shellDiffRows, h, Box, Text, expanded));
  } else {
    // 折叠行 shownLines 依赖 (result, expanded)、不依赖列宽(列宽只在下游 truncate 阶段每帧
    // 现场施加)→ 按 result 身份 + expanded 档记忆,消每帧全量 split+collapse+fold。命中后
    // 每帧仅剩对**已折叠**(有界 maxLines)行的 truncate,byte-identical。门控关 → 直接构造。
    const shownLines = _toolLiteralOutputMemo.memoFoldedLines(
      result,
      expanded,
      () => {
        const allLines = preview.split('\n');
        // Drop trailing blank lines so the hidden-line count is honest.
        while (allLines.length && allLines[allLines.length - 1].trim() === '') {
          allLines.pop();
        }
        // Collapse consecutive duplicate lines when collapsed (Ctrl+O feeds raw lines so
        // expanded reveals the full output verbatim, repeats and all).
        const sourceLines = expanded ? allLines : collapseConsecutiveDuplicates(allLines).lines;
        // Collapsed → generous fold (short output shows in full); expanded → generous cap.
        const policy = expanded
          ? { maxLines: Infinity, foldHead: Infinity, foldTail: 0 }
          : SHELL_COLLAPSED_POLICY;
        return foldOutput(sourceLines, policy).lines;
      },
      process.env
    );
    // 刀17:命令/三方应用 stdout 每行的裁切宽度走与 diff 行同一个 SSOT(`diffClipWidth`),
    // 而非历史的固定 100 字 `truncate(ln, 100)`。固定 100 与刀15 修掉的 diff 老缺口同病:
    //   ① 无视终端宽度(80 列 TTY 上裁到 100 仍宽于终端 → ink 二次换行 → 撑破 foldOutput
    //      的 maxLines 行预算);② **展开(Ctrl+O)后仍裁到 100** → 违背本文件注释自述的
    //      「Ctrl+O 真正显示全貌」诚实原则(刀15 已为 diff 分支修复,本刀补齐其姊妹的
    //      literal stdout 分支——它当时走 `truncate` 而非 `clip`,被刀15 漏过)。
    // gutterWidth=4 = 外层工具块 marginLeft(1) + 本 res 块 marginLeft(1) + 行首 `⎿ ` 字宽(2),
    // 故折叠态 clipW = cols - 10,逐字复刻 CC `renderTruncatedContent` 的
    // `wrapWidth = max(terminalWidth - PADDING_TO_PREVENT_OVERFLOW(10), 10)`;展开态 → Infinity
    // (`clip(ln, Infinity) === ln`,整行交 ink 自然换行,Ctrl+O 真正全貌);门控关 → 100 字节回退。
    const litClipW = diffClipWidth({
      columns: effectiveCols(undefined),
      gutterWidth: 4,
      expanded,
      env: process.env,
    });
    out.push(
      h(
        Box,
        { key: 'res', flexDirection: 'column', marginLeft: 1 },
        // 命令 stdout 用**保留空格**的 clip(而非折叠 `\s+` 的 truncate):PowerShell / `ls -l` /
        // 任何列对齐输出靠成串空格排版,折叠空格会把表头塌成 `p n s` 这类单字母 + 空行。与上面
        // diff 分支同口径(见 clip 定义处注释:collapsing it would mangle code)。
        ...shownLines.map((ln, j) =>
          h(
            Box,
            { key: j },
            h(Text, { dimColor: true }, j === 0 ? SHELL_ELBOW : SHELL_CONT),
            h(Text, { dimColor: true }, clip(ln, litClipW))
          )
        )
      )
    );
    // 截断标记:显示字数 < 全文字数时补一条真实计数的 dim 行(见 buildResultTruncationTag
    // 头注释;preview/shownLines 均为 memo 缓存的稳定引用,标记随之恒新,绝不吐旧)。
    // 同时带上「为什么截断」(describeTruncationReason)与「进程退出码」——截断时退出码尤其
    // 关键(用户要判断这条被截短的输出到底是成功还是失败),故此处**不区分 0/非 0** 一并给出。
    if (toolResultTruncationTagEnabled()) {
      const exitCode = result && typeof result.exitCode === 'number' ? result.exitCode : null;
      const tag = buildResultTruncationTag(preview, shownLines, {
        reason: describeTruncationReason(shownLines, result, expanded),
        exitCode,
      });
      if (tag) {
        // 标记行也按内容列宽裁剪:它计入 estimateLiteralRows 的 1 行预算,一旦软换行,
        // live 区实际高度就 > 账本(反阶梯纪律被破)。宁可裁掉尾部也不撑破布局。
        out.push(
          h(
            Box,
            { key: 'trunc', marginLeft: 1 },
            h(Text, { dimColor: true }, clip(SHELL_CONT + tag, litClipW))
          )
        );
        tagCarriesExit = exitCode !== null;
      }
    }
  }
  // A non-zero exit code is a result the stdout alone may not reveal — surface it.
  // 已被上面的截断标记带上(截断场景)则不再重复。
  const exitCode = result && typeof result.exitCode === 'number' ? result.exitCode : null;
  if (exitCode !== null && exitCode !== 0 && !tagCarriesExit) {
    out.push(
      h(Box, { key: 'exit', marginLeft: 2 }, h(Text, { color: 'yellow' }, `↳ 退出码 ${exitCode}`))
    );
  }
  return out;
}

/**
 * Estimate the VISUAL row count of a completed tool result's literal body — the
 * pure counting twin of `renderLiteralOutput` above. Feeds the live tail budget
 * (toolEntryRows → liveHeightClamp.toolCostOf) so a 20-row tool result charges
 * ~20 rows to the live window in the SAME frame it appears, instead of the
 * historical flat 1 (systematic underestimate → live frame ≥ rows → ink
 * fullscreen repaint → duplicated transcript, [IMPL-RPT-044]).
 *
 * Branch-mirrors the render contract exactly (per branch, the counted rows are
 * what that branch would push into `out`):
 *   - write-diff (`result._khyWriteDiff`) → buildWriteDiffRows row count
 *     (deduped vs. render via the SAME _toolDiffRowsMemo cache — zero per-frame
 *     recompute once the rows exist);
 *   - shell-family → renderLiteralOutput row count: diff-shaped stdout counts
 *     memoDiffRows; folded stdout counts memoFoldedLines + the truncation-tag
 *     row (gate-on only); a non-zero exitCode adds its annotation row;
 *   - non-shell + collapsed → 1 summary row (⎿ 摘要, the render pushes exactly
 *     one Text);
 *   - non-shell + expanded → transparency gate on → renderLiteralOutput(true)
 *     count; off/empty → the 12-line preview fallback + its truncation row;
 *   - no usable output → 0 (the caller's header row remains the only row).
 *
 * Columns do NOT enter the estimate on purpose: the folded-line counts above
 * are column-independent by construction (folding happens pre-truncate; ink
 * wraps post-count), and diff/literal lines are clipped (not wrapped) in the
 * collapsed render path, so counting 1 source row as 1 visual row is the same
 * contract renderDiffRows/renderLiteralOutput honor. Never throws (→ 0).
 *
 * @param {*} result - completed tool result object
 * @param {{expanded?: boolean, live?: boolean, shell?: boolean, env?: object}} [opts]
 * @returns {number} ≥ 0 body rows (header NOT included)
 */
function estimateLiteralRows(result, opts = {}) {
  try {
    if (!result || typeof result !== 'object') {
      return 0;
    }
    const env = opts.env || process.env;
    const expanded = !!opts.expanded;
    let rows = 0;

    // Write/Edit/MultiEdit ±diff: same memo the render reads → deduped across
    // estimator + renderer within a frame.
    if (result._khyWriteDiff) {
      const diffRows = _toolDiffRowsMemo.memoDiffRows(
        result._khyWriteDiff,
        expanded,
        () => buildWriteDiffRows(result._khyWriteDiff, expanded),
        env
      );
      if (Array.isArray(diffRows) && diffRows.length) {
        return diffRows.length;
      }
      // null/empty diff → the render falls through to the shell/summary
      // branches below; mirror that fallthrough.
    }

    if (opts.shell) {
      // Mirror renderLiteralOutput row-for-row (same memos, same folds).
      const preview = _toolLiteralOutputMemo.memoPreview(
        result,
        () => formatShellOutputJson(resultPreview(result), env),
        env
      );
      if (!preview || !preview.trim()) {
        return 0; // no stdout → render shows the ✓ summary row (counted by caller)
      }
      const shellDiffRows = _toolDiffRowsMemo.memoDiffRows(
        result,
        expanded,
        () => (looksLikeUnifiedDiff(preview) ? buildShellDiffRows(preview, expanded) : null),
        env
      );
      if (shellDiffRows && shellDiffRows.length) {
        rows = shellDiffRows.length;
      } else {
        const shownLines = _toolLiteralOutputMemo.memoFoldedLines(
          result,
          expanded,
          () => {
            const allLines = preview.split('\n');
            while (allLines.length && allLines[allLines.length - 1].trim() === '') {
              allLines.pop();
            }
            const sourceLines = expanded
              ? allLines
              : collapseConsecutiveDuplicates(allLines).lines;
            const policy = expanded
              ? { maxLines: Infinity, foldHead: Infinity, foldTail: 0 }
              : SHELL_COLLAPSED_POLICY;
            return foldOutput(sourceLines, policy).lines;
          },
          env
        );
        rows = Array.isArray(shownLines)
          ? visualRowsUnwrapped(shownLines.join('\n'))
          : 0;
        if (toolResultTruncationTagEnabled(env)) {
          if (buildResultTruncationTag(preview, shownLines)) {
            rows += 1;
          }
        }
      }
      const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null;
      if (exitCode !== null && exitCode !== 0) {
        rows += 1;
      }
      return rows;
    }

    // Non-shell: collapsed always pushes exactly one summary row.
    if (!expanded) {
      return 1;
    }
    // Expanded: transparency gate on + real body → literal render count;
    // otherwise the 12-line preview fallback (+ its truncation row).
    if (shouldRenderTransparentBody(result, env)) {
      return estimateLiteralRows(result, { expanded: true, live: opts.live, shell: true, env });
    }
    const preview = resultPreview(result);
    if (!preview) {
      return 0;
    }
    const lines = preview.split('\n').slice(0, 12);
    rows = visualRowsUnwrapped(lines.join('\n'));
    if (toolResultTruncationTagEnabled(env) && buildResultTruncationTag(preview, lines)) {
      rows += 1;
    }
    return rows;
  } catch {
    return 0;
  }
}

// Extract a human-readable failure reason from a tool result so it can be shown
// proactively on the ✗ line — the user should never have to ask "why did it fail".
function errorText(result, env = process.env) {
  if (!result) {
    return '';
  }
  // A guard that blocked the tool supplies a clean, user-facing line separate
  // from its model-only steer message — always prefer it.
  if (result._displayHint) {
    return String(result._displayHint);
  }
  const cand =
    result.error ||
    result.reason ||
    result.message ||
    result.output ||
    result.content ||
    result.text;
  if (!cand) {
    return '';
  }
  // 刀18:折叠门控开时保留换行,让多行错误(栈回溯/构建输出/多行 stderr)按行铺开
  // 供下游 planErrorFold 折叠;关时 opts=undefined → stripInternalControlText 逐字节
  // 回退旧的「换行折空格→单行」,与历史 errorText 完全一致(单行 reason,slice(0,3)
  // 永不触发,无页脚)。门控复用 KHY_TOOL_ERROR_FOLD,折叠与换行同一开关。
  const opts = require('../../toolErrorFold').toolErrorFoldEnabled(env)
    ? { preserveNewlines: true }
    : undefined;
  if (typeof cand === 'string') {
    return stripInternalControlText(cand, opts);
  }
  // Structured ToolError shapes.
  if (typeof cand === 'object') {
    return stripInternalControlText(cand.message || cand.reason || JSON.stringify(cand), opts);
  }
  return stripInternalControlText(String(cand), opts);
}

function ToolLines({ tools = [], expanded = false, live = false, onErrorClick = null }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  if (!tools || tools.length === 0) {
    return null;
  }

  // Per-tool expand/collapse state (Map: toolIndex → boolean).
  // Tracks which tools are individually expanded by user click.
  const [toolExpanded, setToolExpanded] = React.useState(() => new Map());
  // Hover preview state (300ms delay before showing parameter summary).
  const [hoveredTool, setHoveredTool] = React.useState(null);
  const hoverTimerRef = React.useRef(null);

  // Click handler for tool head row:
  //   - Error tools → onErrorClick callback (jump to sidebar)
  //   - Normal tools → toggle per-tool expanded state
  const handleToolClick = React.useCallback((toolIndex, tool) => {
    const done = !!tool && !!tool.result;
    const isErr =
      done &&
      (tool.result.isError || tool.result.is_error || tool.result.error || tool.result.success === false);
    if (isErr && onErrorClick) {
      onErrorClick(toolIndex, tool);
      return;
    }
    setToolExpanded((prev) => {
      const next = new Map(prev);
      next.set(toolIndex, !next.get(toolIndex));
      return next;
    });
  }, [onErrorClick]);

  // Hover handlers (300ms delay, gated by KHY_MOUSE_HOVER).
  const handleMouseOver = React.useCallback((toolIndex) => {
    if (!_mouse.mouseHoverEnabled(process.env)) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setHoveredTool(toolIndex);
    }, 300);
  }, []);

  const handleMouseOut = React.useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHoveredTool(null);
  }, []);

  // Cleanup hover timer on unmount.
  React.useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  // 每帧只取一次工作目录,传给每行头部记忆做 cwd 守卫键——把「每工具一次 process.cwd()
  // 系统调用」降到「每帧一次」。summarizeArgs 内部仍在 miss 时读 process.cwd()(同步 render 内
  // 与此值恒等),故键一致性成立。
  const _cwd = (() => {
    try {
      return process.cwd();
    } catch {
      return '';
    }
  })();

  const blocks = tools.map((t, i) => {
    // Parallel sub-agent fan-out: once the orchestrator has spawned children the
    // bridge attaches their live state here. Render the ├│└ tree IN PLACE of the
    // generic agent(...) row (header + branches + status). Before any child
    // spawns (_agentTree empty) we fall through to the normal single-line row.
    const agentTree = Array.isArray(t._agentTree) && t._agentTree.length > 0 ? t._agentTree : null;
    if (agentTree) {
      const done = !!t.result;
      const isErr = done && (t.result.isError || t.result.is_error || t.result.error || t.result.success === false);
      const cardColor = isErr ? TOOL_CARD_COLOR.error : done ? TOOL_CARD_COLOR.done : TOOL_CARD_COLOR.running;
      // [DESIGN-FOLD-001] §2 L2: per-tree expand. The card click toggles the SAME
      // toolExpanded Map the normal tool cards use, so a tree can open without
      // the global Ctrl+O; global `expanded` still forces it open. No click = no
      // state = byte-identical to the previous global-only behaviour.
      const treeOpen = expanded || !!toolExpanded.get(i);
      return h(
        Box,
        {
          key: `tool-${i}`,
          flexDirection: 'column',
          marginTop: i > 0 ? 1 : 0,
          borderStyle: 'round',
          borderColor: cardColor,
          paddingX: 1,
          onClick: () => handleToolClick(i, t),
          onMouseOver: () => handleMouseOver(i),
          onMouseOut: handleMouseOut,
        },
        h(AgentTree, { agents: agentTree, expanded: treeOpen, live })
      );
    }

    const done = !!t.result;
    // Treat any explicit failure signal as an error so the reason is surfaced —
    // tools fail with varied shapes: {isError}, {is_error}, {error}, or just
    // {success:false, reason}.
    const isErr =
      done &&
      (t.result.isError || t.result.is_error || t.result.error || t.result.success === false);
    const icon = !done ? '◆' : isErr ? '✗' : '✓';
    const color = !done ? 'yellow' : isErr ? 'red' : 'green';

    // [DESIGN-ARCH-155] P2: 头行换成「一行动词句」(`✓ 读取 src/x.js · 340 行 · 0.2s`),
    // 结果量从 `⎿` 行上提。行四个位(动词/目标/结果量/时长)都来自 toolDisplayLine
    // 单一生产者(§3 R1:禁止渲染层自行拼措辞)。分段计算:
    //   - verb/target 只依赖 (name, input, cwd) → 并入既有 memoHeader 缓存(每帧零重算);
    //   - quantity 依赖 result(结算后才出现)→ 从 result.summary(bridge 已算好)派生,
    //     缺失时才回源 summarizeToolResultParts,消每帧重跑 edit 的 diff 统计。
    const _rawInput = t.input ?? t.args ?? t.parameters ?? t.arguments;
    const _header = _toolHeaderSummaryMemo.memoHeader(
      t,
      _cwd,
      () => {
        let nm = t.name || t.toolName || t.tool || 'tool';
        try {
          nm = require('../../toolHeaderDisplayName').resolveToolHeaderName(
            nm,
            process.env,
            require('../../renderTheme').getToolDisplayName
          );
        } catch {
          /* display-name alignment is additive; never block tool rendering */
        }
        let verb = '';
        let target = '';
        try {
          const line = require('../../toolDisplayLine');
          verb = line.toolVerb(t.name || t.toolName || t.tool || '');
          target = line.toolTarget(t.name || t.toolName || t.tool || '', _rawInput, {
            env: process.env,
            cwd: _cwd,
          });
        } catch {
          /* 行语法是增量增强;取不到 → 回退旧「显示名(入参摘要)」形态 */
        }
        return { name: nm, argSummary: summarizeArgs(t), verb, target };
      },
      process.env
    );
    const name = _header.name;
    const argSummary = _header.argSummary;
    const hasLineGrammar = typeof _header.verb === 'string' && _header.verb.length > 0;

    // 结果量位:与头行动词/目标同源(§1 语法),只在结算后出现。
    // t.result.summary 由 queryBridge 在结算时算好(同源 summarizeToolResult);从整句
    // 拆量词(纯字符串操作)消每帧重跑 edit 的 diff 统计。无 summary 才回源一次。
    let quantity = '';
    if (done) {
      try {
        const line = require('../../toolDisplayLine');
        const rawSummary = t.result && t.result.summary;
        const parts =
          typeof rawSummary === 'string' && rawSummary
            ? Object.assign({ full: rawSummary }, splitResultSummary(rawSummary))
            : summarizeToolResultParts(t.name || t.toolName || t.tool || '', t.result, _rawInput || {});
        quantity = line.resultSegment(parts, _header.target);
      } catch {
        /* 摘要失败不吞掉头行 */
      }
    }

    // DESIGN-ARCH-047 P1: provenance label for relayed/quarantined tool calls.
    // Only shown when a non-local trust is present — local/verified tools stay
    // unadorned (fail-safe-to-ours keeps the common path visually unchanged).
    let provLabel = null;
    let provColor = 'cyan';
    const trace = t.result && t.result._khyTrace;
    if (trace && trace.trust && trace.trust !== 'verified') {
      try {
        const { inlineLabel } = require('../../../services/trajectoryProvenance').projection;
        provLabel = inlineLabel({ _khyTrace: trace });
        provColor = trace.trust === 'quarantined' ? 'red' : 'yellow';
      } catch {
        /* label is additive; never block tool rendering */
      }
    }

    // 内联耗时:仅当工具/结果携带真实 durationMs 时显示 ` (45ms)`,缺失即无
    // (绝不估算/补零)。独立于 memoHeader 缓存(见 toolHeaderDurationEnabled 头注释)。
    const durTag = toolHeaderDurationEnabled() ? formatToolDuration(toolDurationMs(t)) : '';

    // [DESIGN-ARCH-155] 头行形态二选一:
    //   行语法可用(hasLineGrammar)→ `✓ 读取 src/x.js · 340 行 · 0.2s`(目标缺省时以
    //   显示名补位,保证「动作 + 目标」永不出现空档);取不到 → 回退旧「名(摘要)」形态。
    // 耗时统一走 ` · ` 字段分隔符(§1:分隔符是语法的一部分,不再是括号后缀)。
    const displayTarget = hasLineGrammar && _header.target ? _header.target : argSummary ? `(${argSummary})` : '';
    const displayVerb = hasLineGrammar ? _header.verb : name;
    const headChildren = [
      h(Text, { color }, icon + ' '),
      h(Text, { bold: true }, displayVerb),
    ];
    if (hasLineGrammar) {
      if (_header.target) {
        headChildren.push(h(Text, { dimColor: true }, ` ${displayTarget}`));
      } else if (displayTarget) {
        headChildren.push(h(Text, { dimColor: true }, ` ${displayTarget}`));
      }
      if (quantity) {
        headChildren.push(h(Text, { dimColor: true }, `${SEP}${quantity}`));
      }
      if (durTag) {
        headChildren.push(h(Text, { dimColor: true }, `${SEP}${durTag}`));
      }
    } else {
      if (argSummary) {
        headChildren.push(h(Text, { dimColor: true }, `(${argSummary})`));
      }
      if (durTag) {
        headChildren.push(h(Text, { dimColor: true }, ` (${durTag})`));
      }
    }
    headChildren.push(
      provLabel ? h(Text, { color: provColor }, `  ${provLabel}`) : null,
      // Per-tool expand/collapse hint (only for non-error tools).
      !isErr
        ? h(
            Text,
            { dimColor: true, key: 'hint' },
            toolExpanded.get(i) ? '  [点击折叠]' : '  [点击展开]'
          )
        : null
    );

    const children = [h(Box, { key: 'head' }, ...headChildren)];

    // Per-tool expanded details: show parameters + result inline when the user
    // clicked to expand this specific tool (independent of the global Ctrl+O expanded).
    const isToolExpanded = toolExpanded.get(i);
    if (isToolExpanded && !isErr) {
      // Show input parameters summary.
      const inputRaw = t.input ?? t.args ?? t.parameters ?? t.arguments;
      if (inputRaw != null) {
        const inputStr = typeof inputRaw === 'string' ? inputRaw : JSON.stringify(inputRaw, null, 2);
        const inputLines = String(inputStr).split('\n').slice(0, 20);
        children.push(
          h(
            Box,
            { key: 'params', marginLeft: 2, flexDirection: 'column' },
            ...inputLines.map((ln, j) =>
              h(Text, { key: j, dimColor: true }, clip(ln, 120))
            )
          )
        );
      }
    }

    // 执行中阶段性说明（staged transparency）: while a tool is still running
    // (live preview only — committed rows always have results), render its
    // present-continuous narration under the ◆ row so the user sees what is
    // happening RIGHT NOW instead of a silent black box. Gone the moment the
    // result lands and the row flips to ✓/✗ with its summary.
    if (!done && live && t.progress) {
      children.push(
        h(
          Box,
          { key: 'progress', marginLeft: 2 },
          h(Text, { color: 'yellow' }, '↳ '),
          h(Text, { dimColor: true }, String(t.progress))
        )
      );
    }

    // On failure, ALWAYS surface the reason (independent of `expanded`) so the
    // user sees why without having to ask — never a bare ✗. A permission-gate
    // denial is labelled "权限被拒绝" (mirrors the classic REPL) so the user can
    // tell "blocked by approval" apart from a genuine tool error.
    if (isErr) {
      const denied = !!(t.result && t.result.denied);
      const rawReason = errorText(t.result, process.env);
      // 刀26:对齐 CC `FallbackToolUseErrorMessage` 的**受众拆分**——给**人**的折叠态把
      // **本仓自产的入参校验失败串**(面向模型的多行分组)收成单行 `Invalid tool parameters`;
      // **展开(Ctrl+O)** 仍显完整分组细节;模型侧 tool_result 不动(本处只在 display 层)。
      // 非校验类失败原样透传。门控 KHY_USER_FACING_TOOL_ERROR 默认开;关 / expanded → 原样回退。
      const reason = require('../../ccUserFacingToolError').collapseValidationErrorForDisplay(
        rawReason,
        { expanded },
        process.env
      );
      const rawLines = reason ? String(reason).split('\n') : [];
      // 刀18:错误详情按 CC `FallbackToolUseErrorMessage` 折叠——折叠态最多显
      // MAX_RENDERED_LINES(10)行,余下不再静默丢弃而是缀一条**独立 dim 页脚**
      // `… +N 行 (ctrl+o 展开)`(=CC 的 "… +N lines (ctrl+o to see all)"),且
      // **展开(Ctrl+O)时显示全部**。历史 `slice(0,3)` 既无视 expanded(Ctrl+O 永不
      // 显全)又静默丢尾(超 3 行的栈/构建错误用户看不出下面还有)——与刀17 修掉的
      // literal stdout「截断后 Ctrl+O 仍是空头支票」同病。折叠决策收敛到纯叶子
      // toolErrorFold(单一真源);着色(红行/dim 页脚)与 marginLeft 留本 call-site。
      // 门控 KHY_TOOL_ERROR_FOLD 默认开;关 → planErrorFold 逐字节回退旧 silent 3 行截断
      // ({shown: lines.slice(0,3), hidden:0},不受 expanded 影响)。
      const { shown: detailLines, hidden } = require('../../toolErrorFold').planErrorFold(
        rawLines,
        expanded,
        process.env
      );
      // Guarantee at least one explanatory line even when no reason text exists.
      const headline = denied ? '权限被拒绝' : detailLines.length ? null : '失败';
      const errChildren = [];
      if (headline) {
        errChildren.push(h(Text, { key: 'h', color: 'red', bold: denied }, headline));
      }
      // 刀40:错误详情每行的**裁切宽度**走 diffClipWidth SSOT,与姊妹 literal stdout 分支
      // (本文件 ~470 行)同口径——终端感知 + **展开(Ctrl+O)→Infinity 整行**——而非历史固定
      // `truncate(ln,120)`。固定 120 与刀15/刀17 修掉的 diff / literal 老缺口同病:① 无视终端宽
      // (80 列 TTY 上裁到 120 仍宽于终端 → ink 二次换行 → 撑破折叠行预算);② **展开后仍裁 120**
      // → 超长错误行(长路径 ENOENT / 长 JSON 校验行 / 长编译诊断)的尾部 Ctrl+O 永远看不到,
      // 是 toolErrorFold「诚实展开」自述原则的漏网之鱼(literal 姊妹被刀17 修了,error 这支当时漏过)。
      // 行内空白早由 stripInternalControlText(preserveNewlines)逐行折叠 + trim(刀18 刻意:保留行间
      // 结构、归一行内空白),多数情况下 clip/truncate 对空白等价;但为与 literal 姊妹**同口径**、且防
      // 某些错误输出(PowerShell ParserError / 编译诊断表格)靠成串空格列对齐被折成 `p n s` 单字母,
      // 此处改用**保留空格**的 clip(而非折叠 `\s+` 的 truncate)。已折叠内容下逐字节等价,是严格超集。
      // 复用门控 KHY_TOOL_ERROR_FOLD(整个「多行错误忠实渲染」特性同一开关):关 → 逐字节回退旧
      // `truncate(ln,120)`。gutterWidth=3 = 外层工具块 marginLeft(1)+本 err 块 marginLeft(2),错误行无 `⎿ ` 前缀。
      const _errFaithful = require('../../toolErrorFold').toolErrorFoldEnabled(process.env);
      const _errClipW = _errFaithful
        ? diffClipWidth({
            columns: effectiveCols(undefined),
            gutterWidth: 3,
            expanded,
            env: process.env,
          })
        : 120;
      detailLines.forEach((ln, j) =>
        errChildren.push(h(Text, { key: `d${j}`, color: 'red' }, clip(ln, _errClipW)))
      );
      // Honest fold footer (dim, like CC) — never a silent drop. Gate-off /
      // expanded → hidden===0 → no footer, byte-identical to the legacy branch.
      if (hidden > 0) {
        errChildren.push(h(Text, { key: 'more', dimColor: true }, `… +${hidden} 行 (ctrl+o 展开)`));
      }
      children.push(h(Box, { key: 'err', flexDirection: 'column', marginLeft: 2 }, ...errChildren));
    }

    // Red/green ±diff for Write/Edit/Delete (Goal7, _khyWriteDiff). The diff IS
    // the result the user wants to see, so render it inline regardless of
    // `expanded` — it takes the place of the generic "✓ 完成" / text preview.
    const diffRows =
      done && !isErr && t.result && t.result._khyWriteDiff
        ? _toolDiffRowsMemo.memoDiffRows(t.result._khyWriteDiff, expanded, () =>
            buildWriteDiffRows(t.result._khyWriteDiff, expanded)
          )
        : null;

    if (diffRows && diffRows.length) {
      children.push(renderDiffRows(diffRows, h, Box, Text, expanded));
    } else if (done && !isErr && isShellResult(name)) {
      // Literal command / third-party-app stdout (e.g. `ls`, `claude`): show a
      // few head lines, fold the rest with a "… +N 行 (ctrl+o 展开)" marker (CC
      // style), and let Ctrl+O reveal the full body. Unlike other tools, command
      // output is shown (folded) even when collapsed — that IS the result the user ran.
      const body = renderLiteralOutput(t.result, expanded, h, Box, Text);
      if (body) {
        children.push(...body);
      } else {
        // Command produced no stdout — still confirm completion. The summary
        // carries a non-zero exit tag ("… [退出码 N]") when present, so it stays
        // the source of truth for the no-output case. Result-line lead unified to
        // CC's "⎿" elbow via resultLineGlyph (gate KHY_RESULT_ELBOW; off → "✓").
        // [DESIGN-ARCH-155] 结果量已上提头行 → 此行只剩退出码注释类信息;头行没带
        // (quantity 为空,如目标/摘要都缺)才在这里兜底,不双显。
        const summary = t.result && t.result.summary;
        const lead = resultLineLead();
        const text = summary || '完成';
        if (quantity && text === summary) {
          // 头行已表达结论(量词上提),这里没有独立信息 → 整行省略(2 行 → 1 行)。
        } else {
          children.push(
            h(
              Box,
              { key: 'ok', marginLeft: 2 },
              h(Text, { color: lead.color, dimColor: lead.dim }, lead.glyph + text)
            )
          );
        }
      }
    } else if (done && !isErr && !expanded) {
      // 工具结果透明化(collapsed):保持 CC 风格的「摘要一瞥」,但当结果确实携带真实输出
      // 体时,补一个 (ctrl+o 展开) 提示。门控关 或 无真实输出体 → 不加提示。
      // [DESIGN-ARCH-155] 结果量已上提头行(`✓ 读取 x.js · 340 行`):量词已表达的结论
      // 不再在 `⎿` 复读(§2.1 反冗余);只剩「有正文可展开」时这条 hint 仍有独立信息,
      // 故此时降级为一行纯提示(去掉与头行重复的摘要前缀)。
      const summary = t.result && t.result.summary;
      const lead = resultLineLead();
      const hasBody = shouldRenderTransparentBody(t.result);
      if (quantity && summary) {
        if (hasBody) {
          children.push(
            h(
              Box,
              { key: 'ok', marginLeft: 2 },
              h(Text, { color: lead.color, dimColor: lead.dim }, lead.glyph + '  (ctrl+o 展开)')
            )
          );
        }
        // 无正文 → 头行就是全部信息,⎿ 行整体省略(2 行 → 1 行)。
      } else {
        const base = lead.glyph + (summary || '完成');
        const hint = hasBody ? '  (ctrl+o 展开)' : '';
        children.push(
          h(
            Box,
            { key: 'ok', marginLeft: 2 },
            h(Text, { color: lead.color, dimColor: lead.dim }, base + hint)
          )
        );
      }
    } else if (!diffRows && expanded && done && !isErr) {
      // 工具结果透明化(expanded):门控开且有真实输出体 → 同一 ⎿ 透明体(更慷慨的展开
      // 上限,Ctrl+O 真正显示全貌);门控关 → 回退到原 12 行文本预览,逐字节等价。
      const body = shouldRenderTransparentBody(t.result)
        ? renderLiteralOutput(t.result, true, h, Box, Text)
        : null;
      if (body) {
        children.push(...body);
      } else {
        const preview = resultPreview(t.result);
        if (preview) {
          const lines = preview.split('\n').slice(0, 12);
          // 12 行预览截断时同样补真实计数标记(与 literal 分支同口径,展开态诚实)。
          const tag = toolResultTruncationTagEnabled()
            ? buildResultTruncationTag(preview, lines)
            : '';
          children.push(
            h(
              Box,
              { key: 'res', flexDirection: 'column', marginLeft: 2 },
              ...lines.map((ln, j) => h(Text, { key: j, dimColor: true }, clip(ln, 100))),
              tag ? h(Text, { key: 'trunc', dimColor: true }, tag) : null
            )
          );
        }
      }
    }

    // 卡片边框颜色:悬停 > 错误 > 完成 > 运行中(优先级降序)。
    const isHovered = hoveredTool === i;
    const cardColor = isHovered
      ? TOOL_CARD_COLOR.hover
      : isErr
        ? TOOL_CARD_COLOR.error
        : done
          ? TOOL_CARD_COLOR.done
          : TOOL_CARD_COLOR.running;

    return h(
      Box,
      {
        key: `tool-${i}`,
        flexDirection: 'column',
        marginY: 0,
        marginTop: i > 0 ? 1 : 0, // 卡片间距:顶部留一行空白
        borderStyle: 'round',
        borderColor: cardColor,
        paddingX: 1,
        onClick: () => handleToolClick(i, t),
        onMouseOver: () => handleMouseOver(i),
        onMouseOut: handleMouseOut,
      },
      ...children
    );
  });

  return h(Box, { flexDirection: 'column' }, ...blocks);
}

// Re-render narrowing: memoize the component so parent renders (e.g. App
// re-rendering on every keystroke) stop cascading into re-rendering every
// committed tool block. Props stability AUDIT (all callers: Transcript.js,
// StreamingBlock.js, ProcessGroup.js):
//   - `tools` is a NEW array every frame (ProcessGroup.groupTimeline /
//     groupConsecutiveTools rebuild it, ProcessGroup filters it), so a plain
//     shallow compare would never bail out. The tool OBJECTS inside are stable
//     references though — useQueryBridge replaces an element immutably
//     ({ ...t, result: ... }) whenever it changes — so an element-wise identity
//     compare over the array is a faithful change signal.
//   - `expanded` / `live` are primitives (field compare).
// Gate KHY_TUI_COMPONENT_MEMO, DEFAULT ON; explicit off-writing
// ('0'/'false'/'off'/'no') restores the plain (unmemoized) export byte-for-byte.
function _componentMemoOff(env) {
  const v = String((env && env.KHY_TUI_COMPONENT_MEMO) || '')
    .trim()
    .toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

// Custom areEqual shared with ProcessGroup (same { tools, expanded, live }
// prop shape): identity over committed tool objects, field compare on the
// mutable primitives.
function toolsPropsEqual(prev, next) {
  if (prev.expanded !== next.expanded || prev.live !== next.live) {
    return false;
  }
  const a = prev.tools;
  const b = next.tools;
  if (a === b) {
    return true;
  }
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

module.exports = _componentMemoOff(process.env)
  ? ToolLines
  : React.memo(ToolLines, toolsPropsEqual);
// NOTE: all static properties below attach to the EXPORTED object (memo or
// plain), so consumers (ProcessGroup, unit tests) keep reaching them via
// require('./ToolLines').xxx regardless of the memo gate.
module.exports.toolsPropsEqual = toolsPropsEqual;
// Width-aware, whitespace-preserving line clip shared by the diff / literal-stdout
// renderers. Exposed for unit tests (the CJK column-budget regression).
module.exports.clip = clip;
// Literal-body row estimator — the counting twin of renderLiteralOutput, feeding
// the live tail budget (toolEntryRows) so tool-heavy turns stop overflowing the
// viewport into ink's fullscreen repaint. Pure (no ink dependency), shares the
// renderer's memo caches so estimate + render never double-compute.
module.exports.estimateLiteralRows = estimateLiteralRows;
// H5 fold model (DESIGN-ARCH-103 P1): tool cards are collapsible elements.
// `lineHeightSignature` MUST include the expanded state (foldModel.js) so an
// expand-then-resize recomputes layout instead of feeding a stale row height
// back to the layout scan and reproducing the staircase ghost. Exposed for the
// render path + regression tests; click-to-expand routes through the App's
// `expanded` state (the same source Ctrl+O already uses).
const _foldModel = require('../foldModel');
module.exports.lineHeightSignature = _foldModel.lineHeightSignature;
module.exports.makeFoldItem = _foldModel.makeFoldItem;
// Pure helpers exported for unit tests (no ink dependency).
module.exports.buildWriteDiffRows = buildWriteDiffRows;
module.exports.renderDiffRows = renderDiffRows;
module.exports.buildShellDiffRows = buildShellDiffRows;
module.exports.looksLikeUnifiedDiff = looksLikeUnifiedDiff;
// Word-level diff pairing planner + gate reader — exported so unit tests can pin
// the pairing/segment logic without rendering ink.
// 行模型叶子 writeDiffPairs 的 clip 注入版：宽度感知 clip 真源留在本文件，
// 导出面与旧签名逐字节兼容（单测按 ToolLines.planWordDiffPairs(rows, wd[, clipW]) 调用）。
module.exports.planWordDiffPairs = (rows, wd, clipW = 100) =>
  _planWordDiffPairsLeaf(rows, wd, clipW, clip);
module.exports.tuiWordDiffEnabled = tuiWordDiffEnabled;
// Shell-family classifier — exported so ProcessGroup shares the SAME rule when
// deciding which steps stay visible (folded) in a collapsed group.
module.exports.isShellResult = isShellResult;
// Reason extractor (+ re-exported sanitizer) — exported so unit tests can assert
// that internal [SYSTEM:…]/[STOP]/[Loop…] control text never reaches the ✗ line.
module.exports.stripInternalControlText = stripInternalControlText;
module.exports.errorText = errorText;
// Arg-summary builder — exported so the path-middle-truncation routing (CC
// truncatePathMiddle) can be asserted without rendering ink.
module.exports.summarizeArgs = summarizeArgs;
// Header duration tag + result-truncation marker helpers — exported so the
// "real data only" rules (no tag without durationMs; real shown/total counts)
// can be asserted without rendering ink.
module.exports.formatToolDuration = formatToolDuration;
module.exports.toolDurationMs = toolDurationMs;
module.exports.toolHeaderDurationEnabled = toolHeaderDurationEnabled;
module.exports.buildResultTruncationTag = buildResultTruncationTag;
// 截断原因判定 — 导出以便单测在不渲染 ink 的前提下锁定「原因文案来自真实结构」。
module.exports.describeTruncationReason = describeTruncationReason;
module.exports.toolResultTruncationTagEnabled = toolResultTruncationTagEnabled;
// [DESIGN-ARCH-155] 行语法头行的字段面(动词/目标/量词/整行)——供单测与估算器锁定契约,
// 不需要起 ink 渲染。rowBudget 头注释同步更新(头行后不再恒跟 ⎿ 摘要行)。
module.exports.headerFields = headerFields;
