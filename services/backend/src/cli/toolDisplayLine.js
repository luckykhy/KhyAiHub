'use strict';

/**
 * toolDisplayLine.js — 工具调用「一行动词句」的唯一生产函数。
 *
 * 语义真源：[DESIGN-ARCH-155] 工具调用短显示规范——TUI 与桌面统一 §1。
 *   语法  `<符> <动作> <目标>[ · <结果量>][ · <耗时>]`
 *   例    `✓ 读取 src/cli/router.js · 340 行 · 0.2s`
 *         `✗ 执行 npm test · 84 行 [退出码 1] · 12.4s`
 *
 * 为什么要有这个文件：四个显示端（Ink TUI / 经典 REPL / 桌面 React / 网页 Vue）此前各自
 * 拼措辞，同一次调用出现四种说法（规范 §0.3 的 Z1–Z5）。动词、目标提取、结果量、耗时
 * 四个位现在**只**在本文件定义一次（§3 R1、R6），各端与事件负载都从这里取字符串：
 *   - TUI / REPL：describeToolLine().line 直接作头行（P2/P3 接线）
 *   - SSE / WS / IPC：把 line/verb/target/quantity 放进 tool_use / tool_result 的
 *     `display` 字段，GUI 端**不推导**任何文本（§5）
 *
 * 纯函数、零 IO、绝不抛：任何输入异常都退化为「能渲染的最短合法行」，
 * 显示层永远不能因为一次取不到目标而让工具行消失。
 */

const { displayWidth, truncateToWidth } = require('./formatters');
const { argDisplayCap } = require('./toolHeaderCap');
const { formatToolHeaderPath, pathMiddleTruncateEnabled, truncatePathMiddle } = require('./toolParamPath');
const { summarizeToolResultParts } = require('./toolResultSummary');
const normalizeToolName = require('../utils/normalizeToolName');
const { isReadToolName, buildReadRangeSuffix } = require('./readRangeSuffix');

// 字段分隔符。规范 §1 冻结为 ` · `（空格 + U+00B7 + 空格）：四端必须同字符，
// 否则「去色后逐字节相等」的一致性验收（§7）无法成立。
const SEP = ' · ';

// 状态符与配套色（§3 R2：字形只用这三个，颜色仅作增强，去色后信息不丢）。
const GLYPHS = { running: '◆', ok: '✓', err: '✗' };
const COLORS = { running: 'yellow', ok: 'green', err: 'red' };

// 目标提取的键序。规范 §1 表里的「command → file_path → pattern → …」是**同族工具内**的
// 优先级；跨族必须按工具族取键，否则 grep 的 `{pattern:'x', path:'src'}` 会提成 `src`
// （今天的 TUI 头行正是这样），而用户对一次搜索真正想看到的是**模式**。
const _FILE_KEYS = ['file_path', 'filePath', 'path', 'file', 'notebook_path', 'target_file'];
const _TARGET_KEYS_BY_NAME = {
  read: _FILE_KEYS,
  readfile: _FILE_KEYS,
  notebookread: _FILE_KEYS,
  write: _FILE_KEYS,
  writefile: _FILE_KEYS,
  createfile: _FILE_KEYS,
  edit: _FILE_KEYS,
  editfile: _FILE_KEYS,
  multiedit: _FILE_KEYS,
  notebookedit: _FILE_KEYS,
  grep: ['pattern', 'query', ..._FILE_KEYS],
  search: ['query', 'pattern', ..._FILE_KEYS],
  searchcontent: ['pattern', 'query', ..._FILE_KEYS],
  glob: ['pattern', ..._FILE_KEYS],
  find: ['pattern', ..._FILE_KEYS],
  findfiles: ['pattern', ..._FILE_KEYS],
  ls: _FILE_KEYS,
  bash: ['command', 'cmd'],
  shell: ['command', 'cmd'],
  shellcommand: ['command', 'cmd'],
  command: ['command', 'cmd'],
  build: ['command', 'script', 'cmd'],
  buildproject: ['command', 'script', 'cmd'],
  projectblueprint: ['command', 'script', 'cmd'],
  websearch: ['query', 'q'],
  webfetch: ['url'],
  agent: ['description', 'prompt', 'role', 'subagent_type'],
  task: ['description', 'prompt', 'role', 'subagent_type'],
  todowrite: [],
};
// 词表外的工具（MCP / 自定义 handler）退到全局键序，如实提取，不猜。
const _TARGET_KEY_ORDER = [
  'command',
  'cmd',
  ..._FILE_KEYS,
  'pattern',
  'query',
  'q',
  'url',
  'description',
  'prompt',
  'role',
  'subagent_type',
];
const _PATH_KEYS = new Set(_FILE_KEYS);
// 搜索/查找类的模式加引号：`"summarizeToolResult"` 一眼可辨是模式而非路径
// （toolPrefaceVoice 的进行中叙述同口径）。
const _QUOTED_VERBS = new Set(['搜索', '查找']);
const _QUOTED_KEY_HINTS = new Set(['pattern', 'query', 'q']);

// 命令行的显示口径 = ` · `，头行必须单行（多行入参会把工具行撑成两行，破坏
// §0.1「一行即答案」判据与 TUI 的行高账本）。
function _collapse(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// 路径显示分隔符统一 POSIX `/`：与 toolResultSummary._toPosix 同口径，否则 Windows 上
// 头行是 `src\cli\x.js` 而结果量来自 `src/cli/x.js`，同一行两种方言。
function _toPosix(s) {
  return String(s).replace(/\\/g, '/');
}

/**
 * toolTarget — 工具入参 → 「对什么动手」。返回 '' 表示确实提不出目标（调用方按
 * 规范 §1.2 用 claim 兜底，宁可有句无标，不出现「动作 + 空白」）。
 * @returns {string} 已格式化、已按宽度上限裁切的目标文本
 */
function toolTarget(name, input, opts = {}) {
  return _targetDetailed(name, input, opts).text;
}

/**
 * _targetDetailed — 同一套提取逻辑，额外报告命中的入参键。
 *
 * 键就是目标的**类型**：路径与命令在窄列里的截断策略相反（路径保文件名 → 中间截；
 * 命令保语义前缀 → 尾部截）。用「文本里有没有斜杠」猜会把
 * `npm run build --workspace=@khy/shared` 这类命令误判成路径。
 * @returns {{text:string, key:string}}
 */
function _targetDetailed(name, input, opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd != null ? opts.cwd : process.cwd();
  const obj = _asObject(input);
  if (!obj) return { text: '', key: '' };
  const norm = normalizeToolName(String(name || ''));
  const keys = _TARGET_KEYS_BY_NAME[norm] || _TARGET_KEY_ORDER;
  const verb = toolVerb(name);
  for (const key of keys) {
    const raw = obj[key];
    if (raw == null || raw === '') continue;
    if (_PATH_KEYS.has(key)) {
      // 相对化 + 中间截断（保住 basename），与 TUI/REPL 既有头行同一口径。
      const formatted = _toPosix(formatToolHeaderPath(String(raw), cwd, env));
      const suffix = isReadToolName(name) ? buildReadRangeSuffix(obj, env) : '';
      return { text: _collapse(formatted) + suffix, key };
    }
    const text = _collapse(raw);
    const capped = truncateToWidth(text, argDisplayCap(key, env));
    if (_QUOTED_VERBS.has(verb) && _QUOTED_KEY_HINTS.has(key) && capped) {
      return { text: `"${capped}"`, key };
    }
    return { text: capped, key };
  }
  return { text: '', key: '' };
}

/**
 * toolVerb — 工具名 → 动作动词（唯一词表）。
 *
 * 逐条移植自 `cli/repl/statusLiveActivity.js` 的 `_verbForTool`（正则与**顺序**都保持一致），
 * 使 spinner 既有文案零变化；在此之上补齐规范 §1 需要的类别（build 家族、search/notebook）。
 * 兜底 `运行` 保留：未收录的工具如实显示「运行 <name>」，不假装有具体动作。
 */
function toolVerb(name) {
  const n = String(name || '')
    .toLowerCase()
    .trim();
  if (!n) return '运行';
  const norm = normalizeToolName(n);
  if (norm === 'read' || norm === 'readfile' || norm === 'notebookread') return '读取';
  if (norm === 'write' || norm === 'writefile') return '写入';
  if (norm === 'createfile') return '创建';
  if (norm === 'edit' || norm === 'editfile' || norm === 'multiedit' || norm === 'notebookedit') return '编辑';
  if (norm === 'grep' || norm === 'search' || norm === 'searchcontent') return '搜索';
  if (norm === 'glob' || norm === 'find' || norm === 'findfiles') return '查找';
  if (norm === 'ls') return '列出';
  if (norm === 'bash' || norm === 'shell' || norm === 'shellcommand' || norm === 'command') return '执行';
  if (norm === 'build' || norm === 'buildproject' || norm === 'projectblueprint') return '执行';
  if (norm === 'websearch') return '联网搜索';
  if (norm === 'webfetch') return '抓取';
  if (norm === 'agent' || norm === 'task') return '派发';
  if (norm === 'todowrite') return '更新';
  // 词表外的工具仍可能带 read/write 之类的子串，沿用 statusLiveActivity 的正则兜底口径。
  if (/read/.test(n)) return '读取';
  if (/write/.test(n)) return '写入';
  if (/edit/.test(n)) return '编辑';
  if (/bash|shell/.test(n)) return '执行';
  if (/grep|search/.test(n)) return '搜索';
  if (/glob|find/.test(n)) return '查找';
  if (/websearch/.test(n)) return '联网搜索';
  if (/webfetch/.test(n)) return '抓取';
  if (/agent|task/.test(n)) return '派发';
  return '运行';
}

function _asObject(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s.startsWith('{') && !s.startsWith('[')) return null;
    try {
      const parsed = JSON.parse(s);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * formatToolDuration — ms → 紧凑人读时长。
 * `<1s → 45ms`、`<1m → 1.2s`（尾随 .0 去掉）、`≥1m` 交 ccFormat SSOT（`1m 30s`）。
 * 非正数/非有限 → ''（调用方**不显示**时长：绝不估算、绝不补零，规范 §1 诚实条款）。
 *
 * 本函数原为 ToolLines.js 的模块私有实现，提升到此处成为跨端 SSOT（规范 §3 R6：
 * 禁止第二份时长口径），TUI 侧改为委派。
 */
function formatToolDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) {
    return '';
  }
  if (n < 1000) {
    return `${Math.round(n)}ms`;
  }
  if (n < 60000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}s`;
  }
  try {
    const out = require('./ccFormat').ccFormatDuration(n);
    if (out) {
      return out;
    }
  } catch {
    /* 落到纯秒数兜底 */
  }
  return `${Math.round(n / 1000)}s`;
}

// 失败判定。前四项与 TUI `ToolLines` 的既有判定一致（isError/is_error/error/success:false）；
// `denied`（权限门拒绝）同样算失败，但由调用方另给「权限被拒绝」措辞。
//
// **刻意不**把壳族非零退出码算进来（§9 V5）：TUI 渲染层对同一结果的 isErr 判定不含
// exitCode（非零退出由黄色 `↳ 退出码 N` 注释行 + `[退出码 N]` 量词诚实表达），若只有
// 本函数判红，同一调用会在 TUI 是 ✓、在 GUI 是 ✗，破坏 §0.1「跨端同形」。判红的唯一
// 正道是循环层对失败结果统一打 isError（待核实项 V5），而不是显示层各判各的。
function _isErrorResult(result) {
  return !!(
    result &&
    (result.isError || result.is_error || result.error || result.denied || result.success === false)
  );
}

// 时长真源优先级：显式 durationMs（loop/事件带的实测值）→ result.durationMs → 无。
function _durationFrom(...candidates) {
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/**
 * resultSegment — L1「结果量」位到底放什么。
 *   1. quantity 非空 → 放量词（`340 行`、`12 个匹配，跨 3 个文件`）；
 *   2. 整句是中性收束（`X完成` / `待办列表已更新` / `完成`）→ 空（状态符已表达成败，
 *      重复一遍是 §2.1 反冗余红线）；
 *   3. 整句就是命令回显（`$ npm run build`）→ 空（头行的目标位已有命令）；
 *   4. 整句里已含目标 → 空（同上，复读）；
 *   5. 其余（bash 的 1–2 行短输出等）→ 放整句，宁多一条信息不丢结论。
 */
function resultSegment(parts, target) {
  const q = String((parts && parts.quantity) || '');
  if (q) return q;
  const full = _collapse(parts && parts.full);
  if (!full || full === '完成') return '';
  if (/完成$/.test(full) || full === '待办列表已更新') return '';
  if (/^\$\s/.test(full)) return '';
  const t = _collapse(target);
  if (t && full.includes(t)) return '';
  return full;
}

// 宽度预算的牺牲阶梯（规范 §1.3：动作与状态符永不截断，先牺牲目标、再结果量、再时长）。
// isPath 决定目标怎么再截：路径从**中间**截（文件名是全部信息量），命令/模式从**尾部**截
// （命令行前缀才是语义所在）。
function _fit(head, quantity, durationText, cols, target, env, isPath) {
  const plain = (t, q, d) => [t ? `${head} ${t}` : head, q, d].filter(Boolean).join(SEP);
  const candidates = [];
  candidates.push(plain(target, quantity, durationText));
  if (target) {
    const shorter =
      isPath && pathMiddleTruncateEnabled(env)
        ? truncatePathMiddle(target, 24)
        : truncateToWidth(target, 24);
    candidates.push(plain(shorter, quantity, durationText));
    candidates.push(plain(shorter, '', durationText));
  }
  candidates.push(plain(target, '', durationText));
  candidates.push(plain(target, '', ''));
  for (const c of candidates) {
    if (displayWidth(c) <= cols) return c;
  }
  return truncateToWidth(candidates[candidates.length - 1], cols);
}

/**
 * describeToolLine — 一次工具调用 → 一行显示契约（规范 §1 / §3.7 的 `display` 对象）。
 *
 * @param {object} opts
 * @param {string} opts.name        工具原始注册名（Edit / read_file / Bash …）
 * @param {object|string} opts.input 工具入参（对象或 JSON 串）
 * @param {object} [opts.result]     工具结果；缺省即「运行中」
 * @param {number} [opts.durationMs] 实测耗时；0/缺省 → 不显示时长
 * @param {number} [opts.cols]       可用列宽；给定则按 §1.3 阶梯裁切
 * @param {string} [opts.cwd]        相对化基准（默认 process.cwd()）
 * @param {object} [opts.env]        门控环境（默认 process.env）
 * @returns {{status:string,glyph:string,color:string,verb:string,target:string,
 *            quantity:string,durationText:string,full:string,line:string,name:string}}
 */
function describeToolLine(opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd != null ? opts.cwd : process.cwd();
  const name = String(opts.name || opts.tool || '').trim();
  const result = opts.result == null ? null : opts.result;
  const done = result != null;
  const isError = done && _isErrorResult(result);
  const status = !done ? 'running' : isError ? 'err' : 'ok';

  const verb = toolVerb(name);
  const td = _targetDetailed(name, opts.input, { env, cwd });
  const target = td.text;
  // 目标是不是路径，决定窄列时**从中间**截（保住文件名）还是**从尾部**截。
  const targetIsPath = _PATH_KEYS.has(td.key);

  let quantity = '';
  let full = '';
  if (done) {
    try {
      const parts = summarizeToolResultParts(name, result, _asObject(opts.input) || {});
      full = parts.full;
      quantity = resultSegment(parts, target);
    } catch {
      /* 摘要失败不吞掉整行：退化为「符 + 动作 + 目标」 */
    }
  }

  const durationText = formatToolDuration(
    _durationFrom(opts.durationMs, result && result.durationMs)
  );

  const head = `${GLYPHS[status]} ${verb}`;
  let line;
  const cols = Number(opts.cols);
  if (Number.isFinite(cols) && cols > 0) {
    line = _fit(head, quantity, durationText, Math.floor(cols), target, env, targetIsPath);
  } else {
    line = [target ? `${head} ${target}` : head, quantity, durationText].filter(Boolean).join(SEP);
  }

  return {
    status,
    glyph: GLYPHS[status],
    color: COLORS[status],
    verb,
    target,
    targetIsPath,
    quantity,
    durationText,
    full,
    line,
    name,
    isError,
    denied: !!(result && result.denied),
  };
}

// 组头的 verb/target 按 tool 对象身份记忆——name/input 在工具创建后不变（result 后续
// 附加但不参与这两个字段），与 tui/toolHeaderSummaryMemo / toolTargetMemo 同一取舍，
// 消 ProcessGroup 每帧对组内每个工具的重复 JSON.parse 与 path 格式化。
// cwd 变化（用户 cd）→ 缓存失效重算，杜绝陈旧相对路径。仅组路径使用；
// describeToolLine 保持无状态（TUI 头行已有 memoHeader 缓存）。
const _GROUP_FIELD_CACHE = new WeakMap();

// 组行窄列截断需要的「目标是不是路径」判定：直接查命中的入参键（不用文本启发式猜）。
function _targetKeyOf(tool, opts = {}) {
  if (!tool || typeof tool !== 'object') {
    return '';
  }
  return _targetDetailed(tool.name || tool.toolName || tool.tool, tool.input ?? tool.args ?? tool.parameters ?? tool.arguments, opts).key;
}

function _groupToolFields(tool, opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd != null ? opts.cwd : process.cwd();
  const key = tool && typeof tool === 'object' ? tool : null;
  if (key) {
    const hit = _GROUP_FIELD_CACHE.get(key);
    if (hit && hit.cwd === cwd) {
      return hit;
    }
  }
  const name = tool ? tool.name || tool.toolName || tool.tool : '';
  const input = tool ? tool.input ?? tool.args ?? tool.parameters ?? tool.arguments : undefined;
  const fields = { cwd, verb: toolVerb(name), target: toolTarget(name, input, { env, cwd }) };
  if (key) {
    _GROUP_FIELD_CACHE.set(key, fields);
  }
  return fields;
}

/**
 * describeGroupLine — 连续多个工具合并成一行（规范 §1.1 的 L0）。
 *
 * 形态 `✓ 读取 + 编辑 server.js · 2 步`；失败时 `✗ … · 4 步 · 1 失败`。
 * 动词序列用 ` + ` 连接——` · ` 已被字段分隔符占用，两者混用会让 L0 与 L1 无法区分。
 * 时长**不显示**：规范 §3 R7 禁止「工具耗时之和」这种不可靠聚合。
 */
function describeGroupLine(tools, opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd != null ? opts.cwd : process.cwd();
  const list = Array.isArray(tools) ? tools : [];
  if (!list.length) {
    return { glyph: GLYPHS.ok, color: COLORS.ok, line: '', steps: 0, failed: 0, verbs: [] };
  }
  const verbs = [];
  const targets = [];
  let running = false;
  let failed = 0;
  for (const t of list) {
    const fields = _groupToolFields(t, { env, cwd });
    const result = t && t.result;
    const isError = !!(
      result &&
      (result.isError || result.is_error || result.error || result.denied || result.success === false)
    );
    if (!result) running = true;
    if (isError) failed += 1;
    if (fields.verb && !verbs.includes(fields.verb)) verbs.push(fields.verb);
    if (fields.target && !targets.includes(fields.target)) targets.push(fields.target);
  }
  const status = running ? 'running' : failed ? 'err' : 'ok';
  const head = verbs.join(' + ');
  const onlyTarget = targets.length === 1 ? targets[0] : '';
  const onlyTargetIsPath =
    targets.length === 1 &&
    list.some((t) => {
      const f = _groupToolFields(t, { env, cwd });
      return f.target && f.target === onlyTarget && _PATH_KEYS.has(_targetKeyOf(t, { env, cwd }));
    });
  const parts = [
    `${GLYPHS[status]} ${head}${onlyTarget ? ` ${onlyTarget}` : ''}`,
    `${list.length} 步`,
    failed ? `${failed} 失败` : '',
  ].filter(Boolean);
  let line = parts.join(SEP);
  const cols = Number(opts.cols);
  if (Number.isFinite(cols) && cols > 0 && displayWidth(line) > cols) {
    // 组行不显示总时长（§3 R7：禁止把逐工具耗时相加当聚合值），窄列时只截目标。
    line = _fit(
      `${GLYPHS[status]} ${head}`,
      '',
      failed ? `${failed} 失败` : '',
      Math.floor(cols),
      onlyTarget,
      env,
      onlyTargetIsPath
    );
  }
  return {
    status,
    glyph: GLYPHS[status],
    color: COLORS[status],
    verbs,
    target: onlyTarget,
    steps: list.length,
    failed,
    line,
  };
}

module.exports = {
  SEP,
  GLYPHS,
  COLORS,
  toolVerb,
  toolTarget,
  formatToolDuration,
  resultSegment,
  describeToolLine,
  describeGroupLine,
};
