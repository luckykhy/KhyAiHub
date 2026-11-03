'use strict';

/**
 * toolExecutionSink.js — 结构化工具执行输出的**显示端 sink**（CC TUI 宿主侧，D1）。
 *
 * ## 谁要、补的是哪个洞
 *
 * S4（`workflowExecutor` 的 `options.onToolGroups`）与 S5（`useQueryBridge` 的
 * `hostHandlers.onToolGroups`）两个生产者都早已把投影发射出来，但**没有任何宿主登记过
 * sink**——全仓 grep `onToolGroups` 只命中叶子测试与 useQueryBridge 自身。于是结构化输出
 * 停在数据层，用户一个字节都没看到。本文件就是那个缺失的宿主侧登记点：
 *
 *   useQueryBridge.emitToolGroups()  ──▶  hostHandlers.onToolGroups  ──▶  本 sink
 *                                                                          │
 *                                                     App.js 渲染 <ToolExecutionPanel>
 *
 * ## 为什么是模块级单例、而不是 React state
 *
 * 投影由钩子（useQueryBridge）在**回合中途**发射（`flushCompletedStages` 每次排空已完成的
 * 段时调一次 `emitToolGroups`），而面板由 App 每帧渲染。两者的生命周期不同：把投影塞进
 * React state 会让「每帧一次 setState」与「回合内多次发射」互相打扰，且 App.js 已经 8070 行
 * （R4 上帝文件门 2500 的 3.2 倍），**不许**再往里加状态机。故此处用模块级单例持有最新一份
 * 投影，App 只做两件事：登记 `onToolGroups`、渲染面板。投影是纯数据，单例不会与 React 的
 * 并发渲染打架（面板读的是不可变快照）。
 *
 * ## 三级区域（用户点名的第一约束）
 *
 * 输出顺序**不是本文件决定的**：`toolExecutionReport.js` 的 `REPORT_ZONES` 是封闭集合，
 * 组装按它 map（不按代码书写顺序）。本文件只负责把第 1 区要的「用户指令原文」喂进去、把
 * 三区的产物取出来。次序闸与成员闸都在 S3 那侧，本文件**不重新实现一遍**（重实现就会漂移）。
 *
 * ## 门控：与两个生产者同一个 env
 *
 * `KHY_TUI_TOOL_GROUPS`，字面量从 S5 生产者（`toolExecutionTimeline.js` 的 `TOOL_GROUPS_ENV`）
 * **导入**而非本地重抄——抄一份就会出现「S5 读新名字、sink 读旧名字」的静默分叉。判定函数也
 * 用生产者的 `isToolGroupsEnabled`（只认 '1'）。
 *
 * **门关时默认行为逐字节不变**（用户硬约束第一条）：`ingest` 直接 no-op（连投影都不存），
 * `snapshot` 返 null，`panelRows` 返 0。于是 App.js 渲染树上那个节点是 `null`、高度账本加
 * 的是 0 —— 与改动前逐字节相同。这条由 `toolExecutionSink.test.js` 的 A/B 探针钉住。
 *
 * ## 渲染安全（tui/AGENTS.md §0.2）
 *
 * 本文件与它产出的面板**不写任何 ANSI 字节**：没有 DECSTBM 滚动区、没有 `\x1B[2J`、没有
 * 绝对定位字节。行文本经 `utils/ansiSanitizer` 的 `stripAnsiSequences` 过一遍——S3 渲染层
 * 本来就零 ANSI，这一遍是纵深防御：将来若某个行渲染器开始吐转义序列，它到不了终端。颜色
 * 一律交给 Ink 的主题通道，本层只给纯文本。
 *
 * ## 性能（tui/AGENTS.md §0.3：渲染 < 16ms）
 *
 * 报告**按需构建并缓存**：缓存键 = (投影对象身份, 指令串, 行帽)。投影身份在「没有新发射」
 * 的帧里不变，指令串在消息数组身份不变时也不变（`latestInstruction` 自带 memo），故
 * 1s 心跳的重渲染只做一次对象身份比较，不重建显示模型。
 */

const { TOOL_GROUPS_ENV, isToolGroupsEnabled } = require('../toolExecutionTimeline');
const report = require('../toolExecutionReport');
const { stripAnsiSequences } = require('../../utils/ansiSanitizer');
const { truncateToWidth } = require('../../utils/text/width');
const { chromeRows, LIVE_MIN } = require('../../utils/terminal/chromeBudget');

/**
 * 面板总行数的**绝对天花板**（同时也是历史上「第 2 区行帽」的那个数，见 _panelCap 决策 2）。
 * 过程区是「交替的工具调用结构化日志」，一轮可以几百行；全画会把 live 区顶破（触发 ink 的
 * fullscreen `\x1B[2J`，正是 §0.2 禁的那一条）。第 1 区与第 3 区在**报告数据**里不设帽
 * （S3 契约），但上屏时同样受 _panelCap 的总预算约束——物理终端装不下时不装，不是硬画。
 * @type {number}
 */
const PANEL_ROW_CAP = 12;

/**
 * 面板总行数占终端行数的**比例**上限。面板是 live 区的一个 widget，不是 live 区本身：
 * 24 行终端给它 7 行、40 行给它 12 行（随后被 PANEL_ROW_CAP 截住），终端越大越宽松。
 * @type {number}
 */
const PANEL_ROW_FRACTION = 0.3;

/**
 * 高度账本里**与本面板无关**的固定行数下界。
 *
 * 不硬编码 4：直接问 `chromeRows` 的真源（input 1 + status 1 + slack 2，即 chromeRows 自己的
 * 默认兜底）。chromeRows 改默认值时这里跟着改，不会悄悄失效。
 * @type {number}
 */
const MIN_OTHER_CHROME = chromeRows({ inputRows: 1, statusRows: 1, slack: 2 });

/** 指令 memo 的命中键（messages 数组身份 + 长度）。 */
const _msgMemo = { messages: null, length: -1, text: '' };

/** 最新投影（发射态）。null = 本进程还没收到过任何投影。 */
let _projection = null;
/** 报告缓存。键三件套见文件头「性能」一节。 */
let _cache = null;

// ── 内部小工具（全部纯函数） ───────────────────────────────────────────────

function _obj(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

function _str(raw) {
  return raw == null ? '' : String(raw);
}

function _int(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 终端行数规整（非有限 / ≤0 → 24，与 App.js 的账本兜底同值）。 */
function _rows(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 24;
}

/**
 * 列宽规整。非有限 / ≤0 → null（= 不钳宽，保持旧形态）。
 * 与 _rows 不同：行数总得有个兜底，列宽没有「默认列宽」可言——不知道多宽就不该乱钳。
 */
function _cols(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

// ── 门控 ──────────────────────────────────────────────────────────────────

/**
 * isEnabled — 本 sink 的门控判定。与 S4/S5 两个生产者同一个 env 名、同一套判定函数。
 *
 * 收 env 对象（默认 `process.env`）而不收字符串：调用方（App.js）手里就是 env，少一次取值。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const bag = _obj(env) || {};
  return isToolGroupsEnabled(bag[TOOL_GROUPS_ENV]);
}

// ── 第 1 区：用户指令原文 ─────────────────────────────────────────────────

/**
 * latestInstruction — 从消息数组里取**本回合**的用户指令原文。
 *
 * 「本回合」= 从尾部往前最近的一条 `role:'user'` 消息（useQueryBridge 在 submit 时 push
 * `{role:'user', content:text}`）。反向扫而不是正向取第一条：会话是连续的，正向取会在第二回合
 * 之后永远显示第一句。扫的是**数组**，不碰任何 IO，故仍是纯函数。
 *
 * memo：1s 心跳的心跳帧里 messages 身份不变，直接命中，避免每帧反扫。
 *
 * @param {Array<object>} messages query.messages
 * @returns {string} 取不到返 ''（「什么都没说」不是一行空串，见 S3 的 _instructionLines）
 */
function latestInstruction(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (_msgMemo.messages === messages && _msgMemo.length === list.length) {
    return _msgMemo.text;
  }
  let text = '';
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const bag = _obj(list[i]);
    if (bag && bag.role === 'user') {
      text = _str(bag.content);
      break;
    }
  }
  _msgMemo.messages = messages;
  _msgMemo.length = list.length;
  _msgMemo.text = text;
  return text;
}

// ── 三区视图模型 ──────────────────────────────────────────────────────────

/**
 * _sanitize — 行文本过一遍 ANSI 剥离（纵深防御，见文件头「渲染安全」）。
 * 非字符串原样返回（S3 的 DisplayLine.text 恒为字符串，这里只是不假设）。
 */
function _sanitize(raw) {
  return typeof raw === 'string' ? stripAnsiSequences(raw) : raw;
}

/**
 * _clip — 把一行文本钳到 `cols` 个**显示列**（CJK 感知，尾部补 '...'）。
 *
 * ## 为什么必须钳：ink 的二次软换行
 *
 * Ink 的 `<Text>` 默认 `wrap='wrap'`：一行超宽就折成多行。于是「账本记 7 行、终端画 13 行」
 * —— 少算的那 6 行又把 live 区顶过 rows，正是本次要关掉的那类 `\x1B[2J`，只是换了一扇门。
 * 本仓对这条坑有明文记载并已防住（App.js 的转录路径按 `_mainContentCols` 预折行），
 * 面板此前没有等价物。实测：140 列终端上宽屏分支左栏只有 95 列，一条 162 字符的工具摘要
 * 会被折成 2 行。
 *
 * 真源是 `utils/text/width` 的 `truncateToWidth`（CJK 宽度 + ANSI 序列都在那儿算），
 * 本文件**不自己实现第二套宽度换算**——第二套必然漂移。
 *
 * `cols` 非正 / 非有限 → 不钳（保持旧形态：调用方没给列宽时行为不变）。
 *
 * @param {string} text 已消毒的行文本
 * @param {*} cols 可用显示列数
 * @returns {string}
 */
function _clip(text, cols) {
  const c = Number(cols);
  if (!Number.isFinite(c) || c <= 0) return text;
  return truncateToWidth(text, Math.floor(c));
}

/**
 * _zoneRows — 一个区域的**全部**行（纯文本，消毒过，按 cols 钳宽）。不设行帽：裁剪是 _fitZones 的事。
 *
 * 为什么不自己拼装文本：三个区域各自已经有纯文本产物——第 1 区是 `zone.lines`（按 '\n'
 * 原样拆的指令行）、第 2 区是 DisplayLine 的 `text`（S3 行渲染器的产物，含行首字形与截断标记）、
 * 第 3 区是 `zone.text`（`stats.renderStatsText` 的产物）。此处只做「取行 + 消毒 + 钳宽」，
 * **不重新实现一套渲染**。
 *
 * 钳宽**不改变行数**：一行钳完还是一行（这正是它能进高度账本的前提）。故 `cols` 只影响文本，
 * 不影响 `rowCount`——测试对这一点有双向断言（见 toolExecutionSink.test.js）。
 *
 * @param {object} zone S3 的一个区域对象
 * @param {*} cols 可用显示列数（见 _clip）
 * @returns {string[]}
 */
function _zoneRows(zone, cols) {
  const bag = _obj(zone) || {};
  // 第 1 区的行在 zone.lines（按 '\n' 拆的字符串）、第 2 区也在 zone.lines（但是 DisplayLine
  // 对象，要取 .text）、第 3 区在 zone.text（字符串）。未知区名 → 空。
  const raw = bag.zone === 'summary' ? bag.text : bag.lines;
  if (!Array.isArray(raw)) return [];
  const pick = bag.zone === 'process' ? (l) => _str(_obj(l) && l.text) : (l) => _str(l);
  return raw.map((line) => _clip(_sanitize(pick(line)), cols));
}

/**
 * _fitZones — 把三区行装进 `totalCap` 行预算，并如实记下谁被裁了。
 *
 * ## 分配顺序 = 上屏顺序
 *
 * 指令 → 过程 → 汇总，**不是**任意的：用户点名的第一约束就是「用户指令在最上面，下面是实现
 * 过程，最后是结构化总结」，预算优先级照抄这条。反过来（先保汇总）会让 24 行终端上用户
 * 看不到自己刚说了什么——那是最该被看见的一行。
 *
 * ## 三个如实决策
 *
 * 1. **指令区超预算时会被截断**，且 `truncated` 里记下 `'instruction'`。这与 S3 的「第 1 区
 *    不接受截断」不冲突：那条契约管的是**报告数据**（`zone.full` 恒为原文、`truncated` 恒
 *    false），管不到「终端只有 10 行」这个物理事实。这里裁的是**上屏行**，`zone.full` 一个
 *    字没动，裁切记在 `view.truncatedZones` 里。
 *    ⚠ **如实记账：目前没有任何端侧渲染这个标记**（ToolExecutionPanel / PreviewLayout 都不读
 *    `truncatedZones`），所以「被裁了」在屏幕上仍是隐式的——指令区看起来就是短了一截。
 *    这不是疏漏被掩盖，是已知缺口：加一个「… N 行未显示」的提示行要多占一行高度，而那一行
 *    本身也得进账本（否则又打开同一扇门）。要做就一起做，别只加文字不加行。
 * 2. **过程区取末尾**（与 TaskListPanel 的尾切同一哲学）：一轮几百次工具调用时，最新几次
 *    才是用户此刻想看的；完整记录在 S3 的投影里，一个字节没丢。
 * 3. **汇总区最先被牺牲**（只有上两区都排满之后）：它是三者里唯一能完整再生的（从 steps
 *    重算），且丢的是聚合计数、不是事实。但不会出现「有汇总没过程」——汇总只拿剩下的。
 *
 * @param {string[]} instruction 第 1 区全部行
 * @param {string[]} process 第 2 区全部行
 * @param {string[]} summary 第 3 区全部行
 * @param {number} totalCap 总预算（_panelCap 的产物，≥1）
 * @returns {{instruction: string[], process: string[], summary: string[], truncated: string[]}}
 */
function _fitZones(instruction, process, summary, totalCap) {
  const cap = Math.max(0, Math.floor(Number(totalCap) || 0));
  const truncated = [];
  const instr = instruction.slice(0, cap);
  if (instr.length < instruction.length) truncated.push('instruction');
  let left = cap - instr.length;
  const proc = left > 0 && process.length > left
    ? process.slice(process.length - left)
    : process.slice(0, Math.max(0, left));
  if (proc.length < process.length) truncated.push('process');
  left -= proc.length;
  const summ = left > 0 ? summary.slice(0, left) : [];
  if (summ.length < summary.length) truncated.push('summary');
  return { instruction: instr, process: proc, summary: summ, truncated };
}

/**
 * _buildView — 投影 + 指令 → 面板视图模型（三区行 + 自检字段）。
 *
 * 组装委托 `buildToolExecutionReport`（S3），本函数只把它的 zones 摊成三份行数组、再按
 * _panelCap 的预算裁一遍、按 `cols` 钳宽。报告自带的 `orderViolations` / `layoutViolations`
 * 原样带出：端侧可以自己复验次序，不必信这里（S3 的契约如此，本文件不吞掉它）。
 *
 * @param {object} projection
 * @param {string} instruction 第 1 区原文
 * @param {number} totalCap 见 _panelCap
 * @param {*} cols 可用显示列数（见 _clip）
 */
function _buildView(projection, instruction, totalCap, cols) {
  const proj = _obj(projection) || {};
  const steps = Array.isArray(proj.steps) ? proj.steps : [];
  const built = report.buildToolExecutionReport({ projection: proj, steps, instruction });
  const zones = Array.isArray(built.zones) ? built.zones : [];
  const byZone = new Map();
  for (const z of zones) {
    const bag = _obj(z);
    if (bag && bag.zone) byZone.set(bag.zone, bag);
  }
  const fit = _fitZones(
    _zoneRows(byZone.get('instruction'), cols),
    _zoneRows(byZone.get('process'), cols),
    _zoneRows(byZone.get('summary'), cols),
    totalCap
  );
  return {
    report: built,
    zones,
    instructionRows: fit.instruction,
    processRows: fit.process,
    summaryRows: fit.summary,
    rowCount: fit.instruction.length + fit.process.length + fit.summary.length,
    truncatedZones: fit.truncated,
    orderOk: report.reportOrderOk(built),
    orderViolations: Array.isArray(built.orderViolations) ? built.orderViolations : [],
    layoutViolations: Array.isArray(built.layoutViolations) ? built.layoutViolations : [],
    stats: built.stats,
  };
}

// ── 对外 API ──────────────────────────────────────────────────────────────

/**
 * ingest — 生产者（useQueryBridge 的 hostHandlers.onToolGroups）登记进来的回调。
 *
 * 门关 → **直接返 false，一个字节的状态都不写**（这是「门关时行为逐字节不变」的落点：
 * 不存投影、不清缓存、不碰 module 级变量之外的任何东西）。
 *
 * @param {object} projection S5 的 projectTurnTimeline 产物
 * @returns {boolean} 是否收下了这份投影（门关 / 入参不是对象 → false）
 */
function ingest(projection) {
  if (!isEnabled()) return false;
  const proj = _obj(projection);
  if (!proj) return false;
  _projection = proj;
  return true;
}

/**
 * _panelCap — 本面板这一帧允许占用的**总**行数（0 = 画不出来，什么都不画）。
 *
 * 三个上界取最小，缺一不可：
 *
 *   1. `floor(rows * PANEL_ROW_FRACTION)` —— 面板是 live 区的一个 widget，不是 live 区本身。
 *   2. `PANEL_ROW_CAP` —— 绝对天花板，防 200 行终端画出一面墙。
 *   3. `rows - MIN_OTHER_CHROME - LIVE_MIN - 1` —— **正确性上界**：`_toolExecRows` 要进
 *      App.js 的高度账本（`chromeBudget.liveBudget`），而
 *      `liveBudget(rows, shares) = max(LIVE_MIN, rows - chromeRows(shares) - 1)`。一旦
 *      `rows - chrome - 面板行数 - 1 < LIVE_MIN`，账本被 LIVE_MIN 地板顶住，于是
 *      `chrome + liveBudget >= rows` ——**字面溢出**，ink 随即 fullscreen `\x1B[2J`
 *      （§0.2 明禁，且会擦掉 scrollback）。上界 3 用 chromeRows 的真源默认值算账本
 *      **下界**（MIN_OTHER_CHROME），不猜。
 *
 * ## 为什么上界 3 不够、还要调用方的 `maxRows`
 *
 * 上界 3 只知道账本的**下界**（4 行），不知道真值。真实账本里还有任务清单、补全框、
 * 审批提示、topbar/分隔线……这些每一项都会把上界 3 的安全余量吃掉。实测：rows=24、
 * 其余 chrome=10 时，面板画 7 行仍会让 painted = 24 ≥ rows（ floors 被顶住）。
 * 所以 App.js 用**同一个屏给补全框算预算的既有手法**（`_cmBudget`）算出真实预算，
 * 经 `opts.maxRows` 传进来 —— 那里才知道其余 chrome 的真值。
 * `maxRows` 缺省时回落上界 3（测试 / 无宿主调用方），行为仍是安全的，只是保守。
 *
 * 返 0 ⇒ snapshot 返 null ⇒ 面板节点是 null、账本加 0，**两端一致**。不会出现「账本以为有
 * 面板、面板却没画」的反向不一致——那同样会算错高度。
 *
 * @param {*} raw 终端行数
 * @param {number} [maxRows] 调用方（App.js 的账本）给出的硬预算；缺省 = 只用三上界
 * @returns {number} ≥ 0
 */
function _panelCap(raw, maxRows) {
  const rows = _rows(raw);
  const safe = rows - MIN_OTHER_CHROME - LIVE_MIN - 1;
  let cap = Math.max(0, Math.min(
    Math.floor(rows * PANEL_ROW_FRACTION),
    PANEL_ROW_CAP,
    safe
  ));
  const given = Number(maxRows);
  if (Number.isFinite(given)) cap = Math.min(cap, Math.max(0, Math.floor(given)));
  return cap;
}

/**
 * snapshot — 面板每帧调用：取当前要画的三区行。无投影 / 门关 / 终端装不下 → null。
 *
 * @param {object} [opts]
 * @param {Array<object>} [opts.messages] query.messages（第 1 区指令来源）
 * @param {string} [opts.instruction] 直接给指令原文（测试 / 已取好的调用方）
 * @param {*} [opts.rows] 终端行数（用于算总行预算，见 _panelCap）
 * @param {number} [opts.maxRows] App.js 账本给出的硬预算（见 _panelCap「为什么不够」一节）
 * @param {*} [opts.cols] 可用显示列数（见 _clip）。**只影响文本，不影响行数**——故账本
 *        那一侧的 panelRows() 可以不传它，而面板渲染处传；两边 rowCount 仍相等。
 * @returns {object|null}
 */
function snapshot(opts = {}) {
  if (!isEnabled()) return null;
  const proj = _obj(_projection);
  if (!proj) return null;
  const o = _obj(opts) || {};
  const instruction =
    typeof o.instruction === 'string' ? o.instruction : latestInstruction(o.messages);
  const cap = _panelCap(o.rows, o.maxRows);
  const cols = _cols(o.cols);
  if (cap < 1) {
    // 终端装不下面板（_panelCap 上界 3，或 App.js 的 maxRows=0）。清缓存而不是留一份会画超的
    // 视图：缓存的生命周期必须跟 cap 联动，否则下次 rows 变大时会命中一份按小 cap 裁出来的旧视图。
    _cache = null;
    return null;
  }
  if (
    _cache &&
    _cache.projection === proj &&
    _cache.instruction === instruction &&
    _cache.cap === cap &&
    _cache.cols === cols
  ) {
    return _cache.view;
  }
  const view = _buildView(proj, instruction, cap, cols);
  _cache = { projection: proj, instruction, cap, cols, view };
  return view;
}

/**
 * panelRows — 本面板这一帧会占几行。给 App.js 的 live 区高度账本用（`taskLineCount` 加项）。
 *
 * **必须与面板真实画出的行数一致**：账本少算一行，live 区就可能顶过 terminal rows，触发 ink 的
 * fullscreen `\x1B[2J`（tui/AGENTS.md §0.2 明禁，且会擦掉 scrollback）。故这里不复算一遍，
 * 而是直接读 `snapshot().rowCount`——同一份视图模型的同一个数。
 *
 * 反过来（账本多算）同样不行：那会让 live 区被白吃掉几行。所以 cap 也是同一个数：
 * App.js 经 `maxRows` 把**真实**预算递进来（见 _panelCap「为什么不够」一节）；
 * 没有 maxRows 时 _panelCap 的第三项上界兜底，仍安全、只是保守。
 *
 * 门关 / 无投影 / 终端装不下 → 0（账本加 0 ⇒ 与改动前逐字节相同）。
 *
 * @param {object} [opts] 同 snapshot
 * @returns {number}
 */
function panelRows(opts = {}) {
  const view = snapshot(opts);
  return view ? _int(view.rowCount) : 0;
}

/**
 * reset — 清空已收投影与缓存。测试用；生产路径从不调用（一个进程一份最新报告）。
 */
function reset() {
  _projection = null;
  _cache = null;
  _msgMemo.messages = null;
  _msgMemo.length = -1;
  _msgMemo.text = '';
}

module.exports = {
  TOOL_GROUPS_ENV,
  PANEL_ROW_CAP,
  PANEL_ROW_FRACTION,
  MIN_OTHER_CHROME,
  panelCap: _panelCap,
  isEnabled,
  latestInstruction,
  ingest,
  snapshot,
  panelRows,
  reset,
};
