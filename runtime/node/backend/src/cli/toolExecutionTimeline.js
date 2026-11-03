'use strict';

/**
 * toolExecutionTimeline.js — CC TUI 回合 timeline / tools[] → 结构化工具执行投影（D1 叶子）。
 *
 * 谁要：`cli/tui/hooks/useQueryBridge.js` 的交互式 agent loop 早把每个工具事件喂进流式状态的
 * `tools[]` 与 `timeline`（`{type:'text'|'thinking'|'tool'|'tools'}` 的有序段），但那两个字段
 * 是**渲染用**的：ink 组件、LAN 桥、持久化各自再从里面推一次「这一轮跑了哪些工具」。本叶子把
 * **同一份 timeline** 适配成 D2 数据模型（`services/domain/catalog/toolUseLoop/
 * toolExecutionGroups.js`）的输入，让结构化工具执行输出（[DESIGN-ARCH-157]）多一个真实生产者
 * （生产者 S5），而不是四个显示端各手搓一套分组。
 *
 * 为什么是叶子：映射是纯的（timeline 段就是数据），于是不挂 React 也能单测；宿主钩子只多出
 * **一个**门控发射点。零 IO、不读时钟、绝不抛——畸形段退化成「能渲染的最短合法投影」。
 *
 * 三种段形态都认（不是挑食，是这三形态在盘上真实存在）：
 *   - `{type:'tool', tool}`  —— 直播形态，tool 带完整 input/result（useQueryBridge 的
 *     reduceToolPush / reduceToolResult 产物）；
 *   - `{type:'tools', tools:[light]}` —— 持久化/恢复形态，light 只有
 *     `{name, paramsSummary, status:'done'|'error'}`（queryBridgeTimeline 的 turn artifacts）；
 *   - `{type:'text'|'thinking'}` —— 叙述段，进 narration 行（需求⑤：叙述是一等行，
 *     绝不被摘要吞掉）。
 *
 * 两条如实决策：
 *   1. **id 会撞**：`toolId` 缺失时 useQueryBridge 用 `loop-<name>` 兜底，同一回合两次 Read
 *      就是同一个 id。D2 按 id 去重，会静默把两行塌成一行——故仅在检测到重复时加 `#n` 后缀
 *      （唯一时保留原 id，显示与调试都干净）。
 *   2. **notice 档没有六态成员**：`result.severity === 'notice'` 是「非成功但可预期」
 *      （`ls <一个文件>`、探针非零退出）。六态里没有它，而 notice 的说明文字已由 summary 带走，
 *      故计入 success 而不是伪装成 error——丢的是状态精度，不是信息。
 */

const {
  projectToolExecution,
} = require('../services/domain/catalog/toolUseLoop/toolExecutionGroups');

/**
 * 门控环境变量名（与 S4 的 `KHY_WORKFLOW_TOOL_GROUPS` 同一族、刻意分开：RPA 工作流投影与
 * 交互式回合投影是两个独立生产者，运维上常只想开一个）。取值必须是 '1'。
 * @type {string}
 */
const TOOL_GROUPS_ENV = 'KHY_TUI_TOOL_GROUPS';

/** 持久化 light 形态的状态词 → 六态（键归一化：小写 + 去非字母数字）。 */
const LIGHT_STATUS_MAP = Object.freeze({
  done: 'success',
  success: 'success',
  succeeded: 'success',
  ok: 'success',
  error: 'error',
  failed: 'error',
  failure: 'error',
  running: 'running',
});

function _str(raw) {
  return raw == null ? '' : String(raw);
}
function _num(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function _key(raw) {
  return _str(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}
function _obj(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

/**
 * isToolGroupsEnabled — 门控判定。只认 '1'（与 KHY_CC_TUI 同口径），其余一律关。
 * 收**原始字符串值**而不是 env 对象：本叶子不碰 process.env，调用方传
 * `process.env.KHY_TUI_TOOL_GROUPS`。
 * @param {*} raw
 * @returns {boolean}
 */
function isToolGroupsEnabled(raw) {
  return typeof raw === 'string' && raw.trim() === '1';
}

/** 结果是否算失败（与 cli/toolDisplayLine.js 的 describeGroupLine 同口径的四路布尔式）。 */
function _isErrorResult(r) {
  if (!r) return false;
  return !!(r.isError || r.is_error || r.error || r.denied || r.success === false);
}

/**
 * _stepsFromLightTools — 持久化 light 段（一整段同类工具被压成一行）→ step 条目。
 *
 * 抽成独立函数的唯一理由是嵌套：它在 _entries 里原本要到第 5 层
 * （函数体 → for → else-if → for → if），而 check-code-standards 的
 * COMP-001-nest 上限是 4。抽出来后在 _entries 里只剩 3 层。
 *
 * @param {Array<unknown>} tools
 * @returns {Array<{kind:'step', tool:object}>}
 */
function _stepsFromLightTools(tools) {
  const out = [];
  for (const t of tools) {
    if (t && typeof t === 'object') out.push({ kind: 'step', tool: t });
  }
  return out;
}

/**
 * _entries — timeline → 规范化的段列表（只保留有事实的段）。
 * @param {Array<object>} timeline
 * @returns {Array<{kind:'narration'|'step', text?:string, durationMs?:number, tool?:object}>}
 */
function _entries(timeline) {
  const list = Array.isArray(timeline) ? timeline : [];
  const out = [];
  for (const seg of list) {
    const bag = _obj(seg);
    if (!bag) continue;
    if (bag.type === 'tool' && bag.tool) {
      out.push({ kind: 'step', tool: bag.tool });
    } else if (bag.type === 'tools' && Array.isArray(bag.tools)) {
      // 持久化形态：一整段同类工具被压成 light 行，逐个还原成 step（顺序即段内顺序）。
      for (const entry of _stepsFromLightTools(bag.tools)) out.push(entry);
    } else if (bag.type === 'text' || bag.type === 'thinking') {
      const durationMs = _num(bag.durationMs);
      const entry = { kind: 'narration', text: _str(bag.text) };
      if (durationMs !== null && durationMs > 0) entry.durationMs = durationMs;
      out.push(entry);
    }
    // 其余段类型（agent 树、status…）不承载工具事实：不猜、不造行。
  }
  return out;
}

/**
 * _stepFromTool — 一个工具对象 → D2 的原始 step 输入（尚未解码）。
 * @param {object} tool
 * @returns {object}
 */
function _stepFromTool(tool) {
  const bag = _obj(tool) || {};
  const result = _obj(bag.result);
  const name = _str(bag.name || bag.toolName || bag.tool) || 'tool';

  const step = { name };
  if (result) {
    const err = _isErrorResult(result);
    step.status = err ? 'error' : 'success';
    const summary = _str(result.summary) || _str(result.text);
    if (summary) step.summary = summary;
    if (err) {
      const why = _str(result.error || result.reason || result.message || result.text);
      if (why) step.error = why;
    }
  } else if (bag.status != null) {
    const mapped = LIGHT_STATUS_MAP[_key(bag.status)];
    if (mapped) step.status = mapped;
    else if (bag.status != null) step.status = bag.status;
    const ps = _str(bag.paramsSummary);
    if (ps) step.summary = ps;
  } else {
    step.status = 'running';
    const prog = _str(bag.progress);
    if (prog) step.summary = prog;
  }

  const durationMs = _num(bag.durationMs != null ? bag.durationMs : result && result.durationMs);
  if (durationMs !== null && durationMs > 0) step.durationMs = durationMs;
  return step;
}

/**
 * timelineToSteps — timeline → D2 原始 step 输入（id 撞车时才加后缀，见文件头决策 1）。
 * @param {Array<object>} timeline
 * @returns {Array<object>}
 */
function timelineToSteps(timeline) {
  const seen = new Map();
  const steps = [];
  for (const entry of _entries(timeline)) {
    if (entry.kind !== 'step') continue;
    const tool = _obj(entry.tool) || {};
    const rawId = _str(tool.id || tool.toolId || tool.toolUseId);
    const step = _stepFromTool(tool);
    if (rawId) {
      const n = (seen.get(rawId) || 0) + 1;
      seen.set(rawId, n);
      step.id = n === 1 ? rawId : `${rawId}#${n}`;
    } else {
      step.id = `tool-${steps.length}`;
    }
    steps.push(step);
  }
  return steps;
}

/**
 * timelineToRows — 一段一行：narration 段进 narration 行，工具段进 step 行，顺序不变。
 *
 * 叙述段的耗时**不放在行上**：D2 的 `_decodeRow` 只认 kind/id/groupId/order/phase/text/summary/
 * stepId，行上的额外字段会被静默丢掉（那是数据模型的封闭行形状，不是缺陷）。思考耗时改挂到
 * **组**的 `thoughtMs`（D2 buildToolGroup 认识它，并汇进 counts.thoughtMs，正是 S3 组级叙述
 * 「思考 11 秒，读取 1 个文件…」的读数来源）——放在数据模型认识它的那一格，而不是塞进行里
 * 赌它别被丢。
 *
 * @param {Array<object>} timeline
 * @returns {Array<object>}
 */
function timelineToRows(timeline) {
  const steps = timelineToSteps(timeline);
  let stepIdx = 0;
  const rows = [];
  const entries = _entries(timeline);
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e.kind === 'narration') {
      rows.push({ kind: 'narration', id: `row-${i}`, phase: 'commentary', text: e.text, order: i });
    } else {
      const step = steps[stepIdx];
      stepIdx += 1;
      rows.push({ kind: 'step', id: `row-${i}`, stepId: step ? step.id : '', order: i });
    }
  }
  return rows;
}

/**
 * timelineToGroups — 相邻的工具段（中间没有叙述）各自成组，kind 'process'
 * （对应 ink-components/ProcessGroup.js 的「一段连续工具」概念）。组标题由调用方经
 * `cli/toolDisplayLine.js` 的 describeGroupLine() 注入——动词句的唯一真源不在这里重复实现。
 *
 * 「动手之前想了多久」挂在组的 `thoughtMs` 上：上一串工具结束到本组开始之间，所有叙述段的
 * 耗时之和。没有叙述段就没有这个字段（0 与缺失是两件事，D2 的 thoughtMs 只认 > 0）。
 *
 * @param {Array<object>} timeline
 * @param {(tools:object[])=>string} [describeGroup]
 * @returns {Array<object>}
 */
function timelineToGroups(timeline, describeGroup) {
  const entries = _entries(timeline);
  const steps = timelineToSteps(timeline);
  const groups = [];
  let run = null;
  let stepIdx = 0;
  let pendingThoughtMs = 0;
  for (const e of entries) {
    if (e.kind !== 'step') {
      if (e.durationMs != null) pendingThoughtMs += e.durationMs;
      run = null; // 一段叙述把前后两串工具切开
      continue;
    }
    if (!run) {
      run = { tools: [], steps: [], thoughtMs: pendingThoughtMs };
      pendingThoughtMs = 0;
      groups.push(run);
    }
    run.tools.push(e.tool);
    run.steps.push(steps[stepIdx]);
    stepIdx += 1;
  }
  const describe = typeof describeGroup === 'function' ? describeGroup : null;
  return groups.map((g, i) => {
    const group = { id: `group-${i}`, kind: 'process', steps: g.steps.filter(Boolean) };
    if (g.thoughtMs > 0) group.thoughtMs = g.thoughtMs;
    if (describe) {
      try {
        group.title = _str(describe(g.tools));
      } catch {
        group.title = ''; // 标题是装饰：算不出来也不该让投影失败
      }
    }
    return group;
  });
}

/**
 * projectTurnTimeline — 一个回合的 timeline → ToolExecutionProjection。
 *
 * 只读：不改写任何入参段（引用原样穿过 D2）。
 *
 * ## 为什么在投影上多挂一个 `steps`
 *
 * D2 的 `projectToolExecution` 只回 `{groups, rows, totals}`，group 上带的是 `stepIds` 而**不是
 * step 本体**（数据层刻意不复制 step）。S3 的渲染层因此要求调用方「把 steps 一并给它」
 * （`renderProjection(projection, steps, opts)`）——不给的后果不是报错，是**静默降级**：
 * 第 2 区每条 step 行都画成「✗ 其它 · 步骤数据缺失」，第 3 区的逐工具 `usage[]` 直接是空数组
 * （实测见 `toolExecutionSink.test.js` 的 A/B 探针）。而宿主侧拿到的**只有**投影这一个对象
 * （`useQueryBridge` 的 `hostHandlers.onToolGroups(projection)`），没有第二个通道递 steps。
 * 故此处把同一份 `steps` 原样挂到投影上：加性字段，不动 D2 的返回形状，也让投影**自给自足**
 * ——宿主不必为了画一份报告再去向生产者要第二份数据。
 *
 * @param {Array<object>} timeline
 * @param {object} [opts]
 * @param {(tools:object[])=>string} [opts.describeGroup] 组标题生产者（注入 cli/toolDisplayLine.js）
 * @returns {object} ToolExecutionProjection（`{groups, rows, totals, steps}`）
 */
function projectTurnTimeline(timeline, opts = {}) {
  const bag = _obj(opts) || {};
  const steps = timelineToSteps(timeline);
  const projection = projectToolExecution({
    steps,
    rows: timelineToRows(timeline),
    groups: timelineToGroups(timeline, bag.describeGroup),
  });
  projection.steps = steps;
  return projection;
}

/**
 * projectToolList — 扁平的 `tools[]` 镜像 → 同一份投影。
 *
 * 直播态里 `streaming.tools` 与 `streaming.timeline` 是同一批工具的两种视图（timeline 还多带
 * 叙述段）。给镜像一条入口，恢复出来的历史消息（只有 tools、没有 timeline）也能投影。
 *
 * @param {Array<object>} tools
 * @param {object} [opts] 同 projectTurnTimeline
 * @returns {object} ToolExecutionProjection（`{groups, rows, totals, steps}`，见 projectTurnTimeline）
 */
function projectToolList(tools, opts = {}) {
  const list = Array.isArray(tools) ? tools : [];
  const timeline = list.map((t) => ({ type: 'tool', tool: t }));
  return projectTurnTimeline(timeline, opts);
}

module.exports = {
  TOOL_GROUPS_ENV,
  isToolGroupsEnabled,
  timelineToSteps,
  timelineToRows,
  timelineToGroups,
  projectTurnTimeline,
  projectToolList,
};
