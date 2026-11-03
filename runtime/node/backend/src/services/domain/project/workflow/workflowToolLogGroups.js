'use strict';

/**
 * workflowToolLogGroups.js — RPA `workflowExecutor` 的 log[] → 结构化工具执行投影（D2 叶子）。
 *
 * 谁要：`services/domain/project/workflow/workflowExecutor.js` 的 `runGraph()` 早就在累积一份
 * 逐节点 `log[]` 并把它交给 `options.onLog`，但那份数组是**显示无关**的——worker 持久化、
 * LAN 桥、CLI 进度条各自再从里面推导一次「这一轮跑了什么」。本叶子把**同一份数组**适配成
 * D2 数据模型（`catalog/toolUseLoop/toolExecutionGroups.js`）的输入，让四个显示端收敛到一份
 * 投影，而不是四套手搓分组（[DESIGN-ARCH-157] 的结构化工具执行输出，生产者 S4）。
 *
 * 为什么是叶子而不是执行器里的一个钩子：映射本身是纯的（log 条目就是数据），于是不画图也能
 * 单测；执行器只多出**一个**门控调用点。零 IO、不读时钟、绝不抛——任何畸形 log 都退化成
 * 「能渲染的最短合法投影」，而不是把一次 run 带下去。
 *
 * 三条如实决策（都是判断，不是遗漏）：
 *   1. **节点 id 在 log 里不唯一**：`loop` 节点每迭代推一条同 id 的条目。故 step 的 id 取
 *      `<nodeId>#<第几次>`——按裸 nodeId 去重会把 5 次迭代静默塌成 1 行。
 *   2. **`skipped` / `awaiting_input` 是工作流独有的状态**，六态 ToolRunStatus 里没有对应成员。
 *      在此显式映射（`cancelled` / `pendingApproval`），而不是原样透传：D2 对不认识的 status
 *      会整条降级为 fallback step（family 'other' + status 'error'）——一个被跳过的节点会
 *      渲染成一次失败。
 *   3. **log 不带时间戳**，所以组的起止时间留空而不是在这里现造一个时钟（生产者不伪造时钟；
 *      渲染层把它们当可选字段）。
 *
 * 域边界：本文件在 D2，**不得** require D1 的 `cli/toolDisplayLine.js`（动词句唯一真源）。
 * 因此组标题由调用方注入 `opts.title`；缺省留空，由渲染层的计数句（「执行工具 N 次」）承载——
 * 那句话的产地是渲染层，不在这里重复实现。
 */

const {
  projectToolExecution,
} = require('../../catalog/toolUseLoop/toolExecutionGroups');

/**
 * 工作流 log 状态 → ToolRunStatus 的封闭映射表（键同样归一化：小写 + 去非字母数字）。
 *
 * 未登记的值**原样透传**给 D2，由它的 STATUS_ALIASES 决定（那才是状态词表的真源）；
 * D2 也不认识时才降级——那一格由 D2 的穷尽性测试看着，不在本表里预先猜。
 * @type {Readonly<Record<string, string>>}
 */
const WORKFLOW_STATUS_MAP = Object.freeze({
  running: 'running',
  succeeded: 'success',
  success: 'success',
  ok: 'success',
  failed: 'error',
  error: 'error',
  // 工作流独有两态：没有「跳过」「等待人答」的六态成员，取语义最近的那个。
  skipped: 'cancelled',
  awaitinginput: 'pendingApproval',
  paused: 'running',
  interrupted: 'running',
});

/** 与 D2 `_normKey` 同口径的归一化（小写 + 去非字母数字）。 */
function _key(raw) {
  return String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function _str(raw) {
  return raw == null ? '' : String(raw);
}

/**
 * mapWorkflowStatus — 工作流状态 → 六态。未登记返回 undefined（调用方原样透传）。
 * @param {*} raw
 * @returns {string|undefined}
 */
function mapWorkflowStatus(raw) {
  const k = _key(raw);
  if (!k) return undefined;
  return WORKFLOW_STATUS_MAP[k];
}

/**
 * workflowLogToSteps — log[] → D2 的原始 step 输入（尚未解码，幂等）。
 *
 * id 带出现次数（见文件头决策 1）；name 取节点**类型**（稳定机器名，`toolCall` / `http` /
 * `loop` …），节点显示名走 `title`（只在摘要缺失时被 D2 用作兜底文案）。
 *
 * @param {Array<object>} log runGraph 累积的 log
 * @returns {Array<object>}
 */
function workflowLogToSteps(log) {
  const list = Array.isArray(log) ? log : [];
  const seen = new Map();
  const steps = [];
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const nodeId = _str(entry.nodeId) || `node-${i}`;
    const occurrence = (seen.get(nodeId) || 0) + 1;
    seen.set(nodeId, occurrence);

    const mapped = mapWorkflowStatus(entry.status);
    const step = {
      id: `${nodeId}#${occurrence}`,
      name: _str(entry.type) || _str(entry.name) || 'node',
      summary: _str(entry.summary),
      title: _str(entry.name),
    };
    // 状态：映射不到就原样给（undefined 时 D2 按「有没有 error」自行推断）。
    if (mapped !== undefined) step.status = mapped;
    else if (entry.status != null) step.status = entry.status;
    // error 原样透传：D2 的 _decodeError 同时接受字符串与 {code,message}。
    if (entry.error != null) step.error = entry.error;
    steps.push(step);
  }
  return steps;
}

/**
 * workflowLogToRows — log 顺序即行顺序（一行对一行，不合并、不重排）。
 * @param {Array<object>} log
 * @returns {Array<object>}
 */
function workflowLogToRows(log) {
  return workflowLogToSteps(log).map((s, i) => ({
    kind: 'step',
    id: `row-${i}`,
    stepId: s.id,
    order: i,
  }));
}

/**
 * workflowLogToGroups — 分组策略。
 *
 * `groupBy: 'run'`（默认）：整轮 run 一个组（kind 'workflow'）。工作流的节点类型彼此不同，
 * 按 family 聚合只会得到一个大组，按类型聚合又会在循环体上碎成一地——所以默认就是「这一轮」。
 * `groupBy: 'type'`：相邻同类型节点各自成组（`expand` 扇出的 N 份同类节点连在一起时有意义）。
 *
 * @param {Array<object>} steps workflowLogToSteps 的产物
 * @param {'run'|'type'} [groupBy]
 * @param {string} [title] 调用方注入的组标题（D2 不许反向 require D1 的动词句真源）
 * @returns {Array<object>}
 */
function workflowLogToGroups(steps, groupBy = 'run', title = '') {
  const list = Array.isArray(steps) ? steps : [];
  const head = _str(title);
  if (groupBy === 'type') {
    const runs = [];
    for (const s of list) {
      const last = runs[runs.length - 1];
      if (last && last.name === s.name) last.members.push(s);
      else runs.push({ name: s.name, members: [s] });
    }
    return runs.map((run, i) => ({
      id: `group-${i}`,
      kind: 'workflow',
      title: head,
      steps: run.members,
    }));
  }
  return [
    {
      id: 'workflow-run',
      kind: 'workflow',
      title: head,
      steps: list,
    },
  ];
}

/**
 * projectWorkflowLog — 一次 runGraph 的 log → ToolExecutionProjection。
 *
 * 只读：不改写入参的任何条目（引用原样穿过 D2，投影与 log 因此永远一致）。
 *
 * @param {Array<object>} log
 * @param {object} [opts]
 * @param {'run'|'type'} [opts.groupBy='run']
 * @param {string} [opts.title] 组标题（调用方注入；D2 不得反向依赖 D1）
 * @returns {object} ToolExecutionProjection
 */
function projectWorkflowLog(log, opts = {}) {
  const bag = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const steps = workflowLogToSteps(log);
  return projectToolExecution({
    steps,
    rows: steps.map((s, i) => ({ kind: 'step', id: `row-${i}`, stepId: s.id, order: i })),
    groups: workflowLogToGroups(steps, bag.groupBy, bag.title),
  });
}

module.exports = {
  WORKFLOW_STATUS_MAP,
  mapWorkflowStatus,
  workflowLogToSteps,
  workflowLogToRows,
  workflowLogToGroups,
  projectWorkflowLog,
};
