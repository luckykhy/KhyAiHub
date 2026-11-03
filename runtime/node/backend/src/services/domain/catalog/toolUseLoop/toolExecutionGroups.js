'use strict';

/**
 * toolExecutionGroups.js — 结构化工具执行输出（D2 纯叶子：零 IO、确定性、绝不抛）。
 *
 * 谁要：`services/tool/toolUseLoopCore.js`（工具循环内核）与 RPA `workflowExecutor` 的 `onLog`
 * 都要把「这一轮跑了哪些工具」变成结构化的组/行，而不是继续往一个字符串里追加。此前四个显示端
 * （Ink TUI / 经典 REPL / 桌面 React / 网页 Vue）各自拼分组，同一次会话出现四种形态。
 *
 * 为什么是纯叶子：分组/计数/状态归一化全是判定，没有一件需要 IO。放 D2 才能被 D1 的渲染层
 * 合法 require（DOMAIN-DEPS：D1 mayDependOn [D1,D2,D3]），反向不行——所以 diff 行构建
 * （`cli/writeDiffRows.js`，D1）不在这里被 require，本叶子只搬运 before/after 原文。
 *
 * 设计来源（三路调研共有结论，非本仓发明）：
 *   - opencode v2：Result 三通道（output/content/metadata）+ ToolState 四态机 +
 *     ToolUsage.unfinished（「没跑完」是一等状态，不是看起来像卡死）+ projection.ts 的
 *     lenient decode（一个坏字段只丢它自己，不丢邻居）；
 *   - ZCode：toolCallRow / toolProgressSchema / display 信封层**不设门**——漏登记的工具有两次
 *     线上事故，都是静默落到 raw fallback 渲染器；
 *   - khy-os 现有真源：`cli/toolDisplayLine.js`（动词句唯一生产者）、`cli/writeDiffRows.js`
 *     （±行模型唯一生产者）、`tui/foldModel.js`（可折叠唯一模型）、`utils/ccClipboard.js`
 *     （复制唯一出口）。本叶子**不重算**这四件事的任何一件，只搬运它们的输入。
 *
 * 契约（`scripts/lib/leafContractGuard.js` 机器强制）：零 IO（不 require fs/child_process/net，
 * 不写标准流，不调 process.exit）；确定性（无缓存、无时钟、无随机、无 env 读取）；绝不抛
 * （任何输入异常都退化为「能渲染的最短合法结构」，显示层永不因一条坏数据让整组消失）。
 */

// ── 封闭集合：穷尽性闸的锚点 ────────────────────────────────────────────────
// 新增任何成员都必须同步 RENDERERS / TOOL_FAMILY_BY_NAME，否则同目录
// toolExecutionGroups.test.js 的红——这是 satisfies Record<Type, true> 的 JS 等价物。

/** @typedef {'read'|'write'|'edit'|'shell'|'search'|'web'|'agent'|'todo'|'ask'|'mcp'|'other'} ToolFamily */
const TOOL_FAMILY = Object.freeze([
  'read', 'write', 'edit', 'shell', 'search', 'web', 'agent', 'todo', 'ask', 'mcp', 'other',
]);

/**
 * 工具名 → family 的封闭查表。键是**归一化后**的工具名（小写 + 去非字母数字）。
 *
 * 照 ZCode TOOL_FAMILY_BY_NAME 的教训：漏登记会让 identity 退回 'other'、最终落到 raw
 * fallback 渲染器，所以本表把调研草图与 `cli/toolDisplayLine.js` 已经认识的全部工具名取并集
 * （那两处词表是本仓真实注册名的代理）。仍然漏掉的只可能是运行期动态注册的名字（MCP 桥、
 * 自定义 handler），它们必须进测试里的 UNCLASSIFIED_ALLOWLIST 并带理由，不许静默吞掉。
 * @type {Readonly<Record<string, ToolFamily>>}
 */
const TOOL_FAMILY_BY_NAME = Object.freeze({
  // read 家族：只读，无副作用
  read: 'read', readfile: 'read', notebookread: 'read', ls: 'read',
  // write 家族：整文件创建/覆写
  write: 'write', writefile: 'write', createfile: 'write',
  // edit 家族：局部改写 / 补丁
  edit: 'edit', editfile: 'edit', multiedit: 'edit', notebookedit: 'edit',
  applypatch: 'edit', patch: 'edit',
  // shell 家族：拉起子进程
  bash: 'shell', shell: 'shell', shellcommand: 'shell', command: 'shell',
  executecode: 'shell', build: 'shell', buildproject: 'shell', projectblueprint: 'shell',
  // search 家族：检索，不改盘
  grep: 'search', search: 'search', searchcontent: 'search',
  glob: 'search', find: 'search', findfiles: 'search',
  // web 家族：出网
  websearch: 'web', webfetch: 'web',
  // agent 家族：派发子代理
  agent: 'agent', task: 'agent', subagent: 'agent',
  // todo 家族：待办清单读写
  todowrite: 'todo', todoread: 'todo', taskcreate: 'todo',
  // ask 家族：向人提问
  askuserquestion: 'ask',
});

/** @typedef {'inputStreaming'|'pendingApproval'|'running'|'success'|'error'|'cancelled'} ToolRunStatus */
const TOOL_RUN_STATUS = Object.freeze([
  'inputStreaming', 'pendingApproval', 'running', 'success', 'error', 'cancelled',
]);

/**
 * 状态别名表（键同样是归一化后的）。khy-os 现有三态与 ZCode 六态在此双向映射：
 *   failed→error、succeeded→success；无 result 的条目与 runGraph 以 status:'paused' 收尾的
 *   条目→running（于是它们进 totals.unfinished，成为**可见**的未完成状态）。
 * @type {Readonly<Record<string, ToolRunStatus>>}
 */
const STATUS_ALIASES = Object.freeze({
  // khy-os 现有三态
  running: 'running', run: 'running', inprogress: 'running',
  succeeded: 'success', success: 'success', ok: 'success', completed: 'success', done: 'success',
  failed: 'error', failure: 'error', error: 'error',
  // ZCode 六态里 khy-os 没有的三个
  inputstreaming: 'inputStreaming', streaming: 'inputStreaming',
  pendingapproval: 'pendingApproval', awaitingapproval: 'pendingApproval',
  approval: 'pendingApproval', pending: 'pendingApproval',
  cancelled: 'cancelled', canceled: 'cancelled', aborted: 'cancelled',
  // runGraph 的 paused / interrupted 收尾：没有结果 ⇒ 仍是 running
  paused: 'running', pause: 'running', interrupted: 'running',
});

/** @typedef {'group'|'step'|'narration'|'divider'} RowKind */
const ROW_KIND = Object.freeze(['group', 'step', 'narration', 'divider']);

/**
 * RENDERERS — RowKind → 渲染器 id 的封闭锚点（`satisfies Record<RowKind, true>` 的 JS 等价物）。
 * 每个 RowKind 必须有一个渲染器；新增成员而不同步本表，测试即红。渲染器**实现**不在本叶子
 * （D2 不许 require D1），这里只登记「必须存在哪个渲染器」，供渲染层对照落地。
 * @type {Readonly<Record<string, string>>}
 */
const RENDERERS = Object.freeze({
  group: 'GroupHeader',
  step: 'StepRow',
  narration: 'NarrationRow',
  divider: 'DividerRow',
});

/** @typedef {'commentary'|'final_answer'} NarrationPhase */
const NARRATION_PHASE = Object.freeze(['commentary', 'final_answer']);

/** @typedef {'retry'|'resume'|'heal'|'contract'|'ask'|'continue'} NextActionKind */
const NEXT_ACTION_KIND = Object.freeze(['retry', 'resume', 'heal', 'contract', 'ask', 'continue']);

/** @typedef {'turn'|'process'|'workflow'} ToolGroupKind */
const GROUP_KIND = Object.freeze(['turn', 'process', 'workflow']);

// 摘要的字符预算。超长摘要在这里被截成显示用短串，全文进 summaryFull，并由
// truncated 记录「这里显示被截过、全文在哪」——数据层绝不因为显示宽度丢字节。
const SUMMARY_CAP = 200;

// ── 内部小工具（全部纯函数） ────────────────────────────────────────────────

function _str(raw) {
  return raw == null ? '' : String(raw);
}

function _obj(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

function _num(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 归一化：小写 + 去非字母数字。`Notebook_Edit` / `notebook-edit` / `NotebookEdit` 同名。 */
function _normKey(raw) {
  return _str(raw).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function _byteLength(text) {
  const s = _str(text);
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    return Buffer.byteLength(s, 'utf8');
  }
  return s.length;
}

function _clip(text, cap) {
  const s = _str(text);
  if (s.length <= cap) return { text: s, clipped: false };
  return { text: s.slice(0, cap), clipped: true };
}

function _median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// 「没跑完」在本模块只有一个定义（opencode ToolUsage.unfinished 的同款口径）：组级状态、
// 组级计数、投影 totals 三处都必须用它，否则同一会话会在三个读数上自相矛盾。
const UNFINISHED_STATUS = new Set(['running', 'pendingApproval', 'inputStreaming']);
const _isUnfinished = (s) => UNFINISHED_STATUS.has(s.status);
const _isSuccess = (s) => s.status === 'success';
const _isError = (s) => s.status === 'error';

function _countBy(list, predicate) {
  let n = 0;
  for (const item of list) if (predicate(item)) n += 1;
  return n;
}

/** 身份字段解析失败的整条降级形状：family 'other' + status 'error' + 原名为摘要。 */
function _fallbackStep(id, rawName) {
  const name = _str(rawName);
  return {
    id,
    name,
    family: 'other',
    status: 'error',
    summary: name || '未能解析的工具调用',
    channels: {},
  };
}

// ── API ────────────────────────────────────────────────────────────────────

/**
 * classifyToolFamily — 工具名 → ToolFamily。
 *
 * 归一化（小写 + 去非字母数字）后查封闭表；未登记返回 'other'。**刻意不做子串启发式**：
 * 猜族比不猜更糟（`grep_results` 会被猜成 search，而它可能只是个普通输出），且猜中的那一半
 * 会让漏登记永远不被发现。调用方与测试都能看见 'other'，不静默吞掉。
 *
 * @param {*} name 工具注册名（`Edit` / `read_file` / `mcp__x__y` …）
 * @returns {ToolFamily}
 */
function classifyToolFamily(name) {
  const key = _normKey(name);
  if (!key) return 'other';
  const hit = TOOL_FAMILY_BY_NAME[key];
  return hit || 'other';
}

/**
 * normalizeStatus — 任意状态原值 → ToolRunStatus。
 *
 * 宽松：未登记的原值折叠成 'running' 而不是抛。选择 'running' 而不是 'error' 是因为未知
 * 状态意味着「不知道」，把它显示成进行中至少不会假报警，且会进 totals.unfinished 变成一个
 * 可见的未完成态（opencode ToolUsage.unfinished 的同款口径）。
 *
 * @param {*} raw
 * @returns {ToolRunStatus}
 */
function normalizeStatus(raw) {
  const hit = STATUS_ALIASES[_normKey(raw)];
  return hit || 'running';
}

/**
 * _parseStatusStrict — 与 normalizeStatus 同一张表，但未登记返回 null。
 * decodeToolStep 用它判「身份字段是否解析失败」：原值在场却谁也不认识，是数据坏了，
 * 该整条降级，不该默默当成 running。
 * @returns {ToolRunStatus|null}
 */
function _parseStatusStrict(raw) {
  return STATUS_ALIASES[_normKey(raw)] || null;
}

function _decodeChannels(raw) {
  const bag = _obj(raw.channels) || {};
  const out = {};
  const output = bag.output !== undefined ? bag.output : raw.output !== undefined ? raw.output : raw.result;
  const content = bag.content !== undefined ? bag.content : raw.content !== undefined ? raw.content : raw.text;
  const metadata = _obj(bag.metadata) || _obj(raw.metadata);
  if (output !== undefined) out.output = output;
  if (content !== undefined) out.content = content;
  if (metadata) out.metadata = metadata;
  return out;
}

function _decodeProgress(raw) {
  const p = _obj(raw.progress);
  if (!p) return null;
  const out = { updatedAt: _num(p.updatedAt) || 0 };
  const bytes = _num(p.bytes);
  const total = _num(p.total);
  if (bytes !== null) out.bytes = bytes;
  if (total !== null) out.total = total;
  // total 缺失时不猜 0..1（ZCode 同款注释）：宁可没有进度条，不要一条假的。
  if (bytes !== null && total !== null && total > 0) {
    out.fraction = Math.min(1, Math.max(0, bytes / total));
  }
  if (p.message != null) out.message = _str(p.message);
  return out;
}

function _decodeArtifact(raw) {
  const a = _obj(raw.artifact) || (raw._khyWriteDiff && _obj(raw._khyWriteDiff) ? raw._khyWriteDiff : null);
  if (!a) return null;
  const kind = _str(a.kind) || 'file-diff';
  if (kind !== 'file-diff') return null;
  const filePath = _str(a.filePath);
  const before = _str(a.beforeContent);
  const after = _str(a.afterContent);
  if (!filePath || !before || !after) return null;
  // 形状与 toolUseLoopHelpers._finalizeWriteDiff 产出的 _khyWriteDiff 逐字节相同，
  // 因此可直接喂 cli/writeDiffRows.js 的 buildWriteDiffRows——本叶子不新造 diff 字段。
  return { kind: 'file-diff', filePath, beforeContent: before, afterContent: after };
}

function _decodeError(raw) {
  const e = raw.error;
  if (e == null) return null;
  if (typeof e === 'string') return { code: '', message: e };
  const obj = _obj(e);
  if (!obj) return null;
  const message = _str(obj.message || obj.msg || obj.detail);
  if (!message) return null;
  return { code: _str(obj.code), message };
}

/**
 * decodeToolStep — 宽松逐字段解码。一个坏字段只丢它自己，不丢邻居
 * （opencode projection.ts 的 lenient decode 同款口径）。
 *
 * id / name / status 三个身份字段解析失败时整条降级为 fallback step（family 'other'、
 * status 'error'、summary=原名），而不是把整组丢掉——ZCode display 信封层不设门的两起线上
 * 事故换来的口径：宁要一条显眼的坏行，不要静默消失的一组。
 *
 * 对已解码的 ToolStep 幂等：可以安全地反复喂同一份数据。
 *
 * @param {*} raw
 * @param {number} [seq] id 缺失时用于合成稳定 id 的序号
 * @returns {ToolStep}
 */
function decodeToolStep(raw, seq = 0) {
  const bag = typeof raw === 'string' ? { name: raw } : _obj(raw);
  if (!bag) return _fallbackStep(`step-${seq}`, '');

  const id = _str(bag.id || bag.stepId || bag.toolUseId || bag.tool_use_id) || `step-${seq}`;
  // 名字去空白后仍为空 ⇒ 没有可分类的身份（`'   '` 与缺失同罪）。
  const name = _str(bag.name || bag.tool || bag.toolName).trim();
  if (!name) return _fallbackStep(id, name);

  // 状态：原值在场却谁也不认识 ⇒ 身份字段解析失败 ⇒ 整条降级。
  const rawStatus = bag.status != null ? bag.status : bag.state;
  let status = null;
  if (rawStatus == null || rawStatus === '') {
    // 无状态时按「有没有结果 / 有没有错误」推断，推断不出才是 running。
    status = _decodeError(bag) ? 'error' : bag.result !== undefined || bag.output !== undefined ? 'success' : 'running';
  } else {
    status = _parseStatusStrict(rawStatus);
    if (!status) return _fallbackStep(id, name);
  }

  const family = TOOL_FAMILY.includes(bag.family) ? bag.family : classifyToolFamily(name);
  const full = _str(bag.summaryFull || bag.summary || bag.title || bag.description);
  const display = _clip(full, SUMMARY_CAP);

  const step = {
    id,
    name,
    family,
    status,
    summary: display.text,
    channels: _decodeChannels(bag),
  };
  if (display.clipped) {
    step.summaryFull = full;
    step.truncated = { totalBytes: _byteLength(full), ref: 'summaryFull' };
  } else if (bag.summaryFull != null && _str(bag.summaryFull) !== display.text) {
    step.summaryFull = _str(bag.summaryFull);
  }

  const progress = _decodeProgress(bag);
  if (progress) step.progress = progress;
  const artifact = _decodeArtifact(bag);
  if (artifact) step.artifact = artifact;
  const error = _decodeError(bag);
  if (error) step.error = error;

  const startedAt = _num(bag.startedAt);
  const endedAt = _num(bag.endedAt);
  const durationMs = _num(bag.durationMs);
  if (startedAt !== null) step.startedAt = startedAt;
  if (endedAt !== null) step.endedAt = endedAt;
  if (durationMs !== null) step.durationMs = durationMs;

  if (Array.isArray(bag.childStepIds)) {
    const ids = bag.childStepIds.map(_str).filter(Boolean);
    if (ids.length) step.childStepIds = ids;
  }
  return step;
}

function _decodeNextAction(raw) {
  const a = _obj(raw);
  if (!a) return null;
  const kind = NEXT_ACTION_KIND.includes(a.kind) ? a.kind : null;
  const text = _str(a.text);
  if (!kind || !text) return null;
  const out = { kind, text };
  if (a.target != null) out.target = _str(a.target);
  if (_obj(a.payload)) out.payload = a.payload;
  return out;
}

/**
 * buildToolGroup — 一组 step → ToolGroup。
 *
 * title 必须由调用方经 `cli/toolDisplayLine.js` 的 describeGroupLine() 算好传入：动词句 /
 * 量词 / 耗时不在此重复实现（那四样各有唯一真源）。起止时间戳缺省时从 step 上取 min/max，
 * 于是「分组比它的步骤还早开始」这种不可能的形状不会出现。
 *
 * status 聚合：任一步未完成（running / pendingApproval / inputStreaming）→ 'running'；
 * 否则有 error → 'error'；否则全 cancelled → 'cancelled'；其余 → 'success'。
 *
 * @param {object} input
 * @returns {ToolGroup}
 */
function buildToolGroup(input) {
  const bag = _obj(input) || {};
  const steps = (Array.isArray(bag.steps) ? bag.steps : []).map((s, i) => decodeToolStep(s, i));
  const kind = GROUP_KIND.includes(bag.kind) ? bag.kind : 'turn';
  const id = _str(bag.id) || 'group-0';

  const unfinished = _countBy(steps, _isUnfinished);
  const failed = _countBy(steps, _isError);
  const succeeded = _countBy(steps, _isSuccess);
  const status = unfinished
    ? 'running'
    : failed
      ? 'error'
      : steps.length && steps.every((s) => s.status === 'cancelled')
        ? 'cancelled'
        : 'success';

  const byFamily = {};
  for (const f of TOOL_FAMILY) byFamily[f] = 0;
  for (const s of steps) byFamily[s.family] += 1;

  const startedAt = _num(bag.startedAt) ?? Math.min(...steps.map((s) => s.startedAt ?? Infinity), Infinity);
  const endedAt = _num(bag.endedAt) ?? Math.max(...steps.map((s) => s.endedAt ?? -Infinity), -Infinity);

  const counts = { byFamily, succeeded, failed, unfinished };
  const thoughtMs = _num(bag.thoughtMs);
  if (thoughtMs !== null && thoughtMs > 0) counts.thoughtMs = thoughtMs;

  const group = {
    id,
    kind,
    title: _str(bag.title),
    status,
    count: steps.length,
    startedAt: Number.isFinite(startedAt) ? startedAt : 0,
    counts,
    stepIds: steps.map((s) => s.id),
    childGroupIds: (Array.isArray(bag.childGroupIds) ? bag.childGroupIds : []).map(_str).filter(Boolean),
    copyText: _str(bag.copyText) || _renderCopyText(_str(bag.title), steps),
  };
  if (Number.isFinite(endedAt)) group.endedAt = endedAt;
  const activeMs = _num(bag.activeMs);
  if (activeMs !== null) group.activeMs = activeMs;
  const nextAction = _decodeNextAction(bag.nextAction);
  if (nextAction) group.nextAction = nextAction;
  const answerStepId = _str(bag.answerStepId);
  if (answerStepId) group.answerStepId = answerStepId;
  return group;
}

/**
 * _renderCopyText — 分组复制载荷（纯文本，给人看）。
 *
 * 复制出口只有 `utils/ccClipboard.js` 一个；这里只负责把载荷**预先渲染好**，不碰剪贴板
 * （本叶子零 IO）。用 summaryFull 而不是 summary：复制就该给全文（需求 7：截断只作用于显示）。
 */
function _renderCopyText(title, steps) {
  const lines = [];
  if (title) lines.push(title);
  for (const s of steps) {
    const body = s.summaryFull || s.summary;
    lines.push(`  [${s.status}] ${s.name}${body ? ` - ${body}` : ''}`);
  }
  return lines.join('\n');
}

function _decodeRow(raw, index) {
  const bag = _obj(raw) || {};
  let kind = ROW_KIND.includes(bag.kind) ? bag.kind : null;
  if (!kind) {
    // kind 缺失/乱值时不丢行：按行上有什么推断，保不住族就当地分割线。
    kind = _str(bag.stepId) ? 'step' : bag.text != null ? 'narration' : 'divider';
  }
  const row = {
    kind,
    id: _str(bag.id) || `row-${index}`,
    groupId: _str(bag.groupId),
    order: _num(bag.order) !== null ? _num(bag.order) : index,
  };
  const phase = NARRATION_PHASE.includes(bag.phase) ? bag.phase : null;
  if (phase) row.phase = phase;
  if (bag.text != null) row.text = _str(bag.text);
  if (bag.summary != null) row.summary = _str(bag.summary);
  const stepId = _str(bag.stepId);
  if (stepId) row.stepId = stepId;
  return row;
}

/**
 * projectToolExecution — 扁平 steps + 已排序的 rows → ToolExecutionProjection。
 *
 * 输出**保持 rows 的 order 不重排**（text ↔ tool 的真实交错就在这个序里，与
 * `cli/tui/hooks/queryBridgeTimeline.js` 的 timeline 同口径），只在相邻同 family 的 step 上
 * 做聚合（opencode Pass 2 的 adjacent grouping）。刻意不做 Pass 1 turn folding 与
 * Pass 4 identity-stable row reuse：短会话里收益接近于零，却要多维护一套 cursor 状态机，
 * 且 Pass 4 源自己注释警告它是维护陷阱。
 *
 * @param {object} input
 * @param {ToolStep[]} [input.steps]    扁平步骤（raw 或已解码，幂等）
 * @param {ToolGroup[]} [input.groups]  调用方自建的组；给了就不再自动相邻聚合
 * @param {Row[]} [input.rows]          已排序的行
 * @param {(steps: ToolStep[]) => string} [input.describeGroup] 注入的组头生产者；
 *        本叶子不重算动词句，缺省则 title 留空由调用方回填
 * @param {string} [input.defaultGroupId] 首个 step 之前的 narration/divider 挂点
 * @returns {ToolExecutionProjection}
 */
function projectToolExecution(input) {
  const bag = _obj(input) || {};
  const rawSteps = Array.isArray(bag.steps) ? bag.steps : [];
  const rawGroups = Array.isArray(bag.groups) ? bag.groups : [];

  // 两步来源都解码并按 id 去重，totals 才不会因为「组里又带了一份 steps」翻倍。
  const stepById = new Map();
  for (let i = 0; i < rawSteps.length; i += 1) {
    const s = decodeToolStep(rawSteps[i], i);
    stepById.set(s.id, s);
  }
  for (const g of rawGroups) {
    const inner = _obj(g) && Array.isArray(g.steps) ? g.steps : [];
    for (let i = 0; i < inner.length; i += 1) {
      const s = decodeToolStep(inner[i], i);
      if (!stepById.has(s.id)) stepById.set(s.id, s);
    }
  }

  let groups;
  if (rawGroups.length) {
    groups = rawGroups.map((g) => buildToolGroup(g));
  } else {
    // Pass 2：只合并在数组里相邻、且 family 相同的 step。
    const describe = typeof bag.describeGroup === 'function' ? bag.describeGroup : null;
    const runs = [];
    for (const s of stepById.values()) {
      const last = runs[runs.length - 1];
      if (last && last.family === s.family) last.members.push(s);
      else runs.push({ family: s.family, members: [s] });
    }
    groups = runs.map((run, i) =>
      buildToolGroup({
        id: `group-${i}`,
        kind: bag.groupKind,
        title: describe ? _str(describe(run.members)) : '',
        steps: run.members,
      })
    );
  }

  const groupOfStep = new Map();
  for (const g of groups) {
    for (const sid of g.stepIds) if (!groupOfStep.has(sid)) groupOfStep.set(sid, g.id);
  }

  const rawRows = Array.isArray(bag.rows) ? bag.rows : [];
  const rows = [];
  let lastGroupId = '';
  for (let i = 0; i < rawRows.length; i += 1) {
    const row = _decodeRow(rawRows[i], i);
    if (!row.groupId) {
      // 行自己没指定组：step 行按自己的 stepId 归属；narration/divider 挂到它**前面最近**那个
      // step 所在的组，于是「先说话再动手」的交错不会因为缺 groupId 而掉出分组。一个 step 都
      // 还没出现时（通常是分组前的开场白）才落到 defaultGroupId。
      const own = _str(row.stepId) ? groupOfStep.get(row.stepId) : '';
      row.groupId = own || lastGroupId || _str(bag.defaultGroupId);
    }
    if (row.groupId) lastGroupId = row.groupId;
    rows.push(row);
  }

  const allSteps = [...stepById.values()];
  const byFamily = {};
  for (const f of TOOL_FAMILY) byFamily[f] = 0;
  for (const s of allSteps) byFamily[s.family] += 1;
  const durations = allSteps.map((s) => s.durationMs).filter((d) => typeof d === 'number' && d > 0);

  const totals = {
    byFamily,
    succeeded: _countBy(allSteps, _isSuccess),
    failed: _countBy(allSteps, _isError),
    unfinished: _countBy(allSteps, _isUnfinished),
  };
  if (durations.length) totals.durationP50 = _median(durations);

  return { groups, rows, totals };
}

module.exports = {
  TOOL_FAMILY,
  TOOL_FAMILY_BY_NAME,
  TOOL_RUN_STATUS,
  STATUS_ALIASES,
  ROW_KIND,
  RENDERERS,
  NARRATION_PHASE,
  NEXT_ACTION_KIND,
  GROUP_KIND,
  SUMMARY_CAP,
  classifyToolFamily,
  normalizeStatus,
  decodeToolStep,
  buildToolGroup,
  projectToolExecution,
};
