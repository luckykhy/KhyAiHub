'use strict';

/**
 * semanticProjection — 端无关的会话语义投影（DESIGN-ARCH-176 §6.3）。
 *
 * 目的：把 `runToolUseLoop` 的循环级回调投影成一份**两端都能消费的**语义模型，
 * 让 TUI(Ink) 与桌面端(React DOM) 渲染**同一份数据、各自画各自的视图**。
 *
 * ★ 为什么不做 PTY（DESIGN-ARCH-176 §6.2）：
 *   PTY 要让整个 khy TUI 原样跑起来，而 `App.js` 的 live 区**自带 PromptFrame 输入框**
 *   —— 与桌面端的 Composer 并存就会出现**两个输入框 + raw mode 焦点互抢**。
 *   本层的存在正是为了让「统一的是显示，不是输入」。
 *
 * ★★ 本模型**刻意不含**：输入框、光标、viewport、滚动位置、终端尺寸。
 *   理由：这些是两端 UI 的**差异**，放进数据层等于把差异固化成契约。
 *   不放 ⇒ 输入框问题在**定义上**消失，而不是靠约定避免。
 *
 * ★★ 两端的 onToolResult 参数顺序不一致（本契约存在的核心原因）：
 *   - TUI  `replSession.js:11137` → `onToolResult(name, result, params)`
 *   - host `host/index.ts:430`    → `onToolResult(name, params, toolResult, iteration, elapsed)`
 *   第二个参数在两端**语义相反**。⇒ 消费方必须用 `fromTui` / `fromHost`
 *   显式声明来源，**绝不靠猜**（猜错会把 params 当 result 显示）。
 *
 * ★★ 本文件**不是状态真源**，只是一份「事件形状契约 + 转换函数」。
 *   实施前的误判（2026-10-02 已订正）：本层曾按「桌面端要消费一份新投影」设计，
 *   但核实发现桌面端**早已完整接线** ——
 *     `renderer/App.tsx:400-457` 监听 onAiToolCall/onAiToolResult 并 dispatch；
 *     `renderer/state/toolExecutionSlice.ts` 有 5 态（含 pending/cancelled）+
 *     history（上限 50）+ affectedFiles，比本层原先的聚合更全。
 *   ⇒ 本层**刻意不提供** createProjection / appendMessage / upsertToolCall ——
 *   那些是**第二份状态真源**，会与 slice 打架。
 *
 * ★★ id 配对：**不要用工具名当 id**。
 *   `App.tsx:398-399` 原文：「callId 由 host 侧按同名 FIFO 配对（循环回调不带 id），
 *   据此精确收敛结果，**不按工具名找 —— 并行同名工具会张冠李戴**。」
 *   本层早期版本在 id 缺失时回落到 name，正是这个错法；现改为**不猜**（见 toolCall）。
 *
 * 铁律（纯叶子，同 `chatChords.js` 规格）：
 *   零 IO · 确定性 · 绝不抛 · **绝不读 env** · **不改入参**（返回新对象/新数组）
 *   状态枚举越界一律**保守归类**到 unknown 语义，绝不臆造状态。
 */

/**
 * 工具调用的生命周期状态。四态与 TUI 既有图标语义对齐
 * （`taskPanelLines.js:16` 的 ✓/→/✗/○ 家族），但**本层不持有图标字面量** ——
 * 图标由各自的渲染器决定，数据层只给语义。
 */
const CALL_STATUS = Object.freeze({
  RUNNING: 'running', // onToolCall 已发，结果未回
  OK: 'ok', // 结果回来了且未报错
  ERROR: 'error', // 结果回来了但失败 / 被拒
  UNKNOWN: 'unknown', // 畸形或缺失 ⇒ 保守
});

/**
 * 状态**值**集合（校验入参用）。
 * ⚠ `CALL_STATUS` 的键是大写常量名、值是小写线上格式。
 *   校验时必须查「值是否落在本集合」，**不能**用
 *   `hasOwnProperty(CALL_STATUS, status)` —— 那是拿值去查键，永远查不到，
 *   会让合法状态全被误判成 unknown（E1 实施时由单测抓出）。
 */
const CALL_STATUS_VALUES = Object.freeze([
  CALL_STATUS.RUNNING, CALL_STATUS.OK, CALL_STATUS.ERROR, CALL_STATUS.UNKNOWN,
]);

/** 消息角色。只认这四个，其余归 user（保守，不丢内容）。 */
const ROLE = Object.freeze({ USER: 'user', ASSISTANT: 'assistant', SYSTEM: 'system', TOOL: 'tool' });

/** 角色**值**集合（校验用）。理由同 CALL_STATUS_VALUES。 */
const ROLE_VALUES = Object.freeze([ROLE.USER, ROLE.ASSISTANT, ROLE.SYSTEM, ROLE.TOOL]);

/**
 * 安全取数值：`Number(symbol)` / `Number(bigint)` 会抛 TypeError，
 * 而本层铁律是「绝不抛」——投影层在渲染热路径上，一个 Symbol 就能连带整个会话 UI。
 * 先按类型挡掉，只让真正的数值/数字字符串进入 `Number()`。
 *
 * ★ 不可用时返回 **null 而非 0**：「没测到」与「真的是 0」不是一回事，
 *   混淆会让「耗时 0ms」和「没测到耗时」在 UI 上长得一样。
 *
 * @param {*} v
 * @returns {?number}
 */
function _num(v) {
  if (v == null) return null;
  const t = typeof v;
  if (t !== 'number' && t !== 'string') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 结果对象的成功判定（保守）。
 * ⚠ 不同调用方给的结果形状不完全一致（TUI 侧看 `r.denied` / `r.success === false`，
 *   见 `replSession.js:11141`/`:11149`），所以三个都查，任一命中即非成功。
 * @param {*} r
 * @returns {boolean}
 */
function _isFailure(r) {
  if (!r || typeof r !== 'object') return false;
  if (r.denied === true) return true; // 被权限/审批拒绝
  if (r.success === false) return true;
  if (r.error) return true; // 显式 error 字段
  if (r.ok === false) return true;
  return false;
}

/**
 * 归一化一个工具调用节点。
 *
 * @param {object} [init]
 * @param {string} [init.id] - 调用标识。**必须由配对方提供**（host 侧按同名 FIFO 生成
 *   的 callId，见 `App.tsx:398-399`）。缺失时本层**不猜**。
 * @param {string} [init.name] - 工具名（**仅作标签，不作身份**）
 * @param {string} [init.status] - CALL_STATUS.*
 * @param {*} [init.input] - 入参（原样透传，不深拷贝：数据层不该改内容）
 * @param {*} [init.output] - 结果
 * @param {number} [init.iteration]
 * @param {number} [init.elapsedMs] - host 侧提供；TUI 侧无 ⇒ null（**不填 0 冒充**）
 * @param {string} [init.affectedFiles] - host 侧 `affectedFilesOf()` 的产物
 * @returns {Readonly<object>} `id` 为 null 表示「未配对」——消费方**必须**自己决定
 *   跳过还是等下一条，**不得**拿 name 顶替。
 */
function toolCall(init = {}) {
  const o = init && typeof init === 'object' ? init : {};
  const name = String(o.name == null ? '' : o.name);
  // 状态越界/缺失一律 UNKNOWN。⚠ 不要写 `cond ? A : (cond2 ? B : C)` 这类
  // 两个分支同值的表达式——它读起来像"有判断"，实际是死代码。
  const status = CALL_STATUS_VALUES.indexOf(o.status) >= 0 ? o.status : CALL_STATUS.UNKNOWN;
  // ⚠ id 缺失 → null，**不回落 name**。理由见文件头：
  //   并行同名工具（「Bash」×2）用 name 当身份会让后一个结果配到前一个调用上。
  //   宁可「未配对」也不错配 —— 错配比不显示更糟（同 App.tsx:430 的判断口径）。
  const hasId = o.id != null && String(o.id) !== '';
  return Object.freeze({
    id: hasId ? String(o.id) : null,
    name,
    status,
    input: o.input === undefined ? null : o.input,
    output: o.output === undefined ? null : o.output,
    // ⚠ 数值字段：不可用时给 null 而非 0 ——「没测到」与「真的是 0」不是一回事
    iteration: _num(o.iteration),
    elapsedMs: _num(o.elapsedMs),
    affectedFiles: o.affectedFiles == null ? null : String(o.affectedFiles),
  });
}

/**
 * 从 **host 侧**的 onToolResult 五参形态构造节点。
 * 签名依据 `apps/khyos-desktop/src/host/index.ts:430`：
 *   `(name, params, toolResult, iteration, elapsed)`
 *
 * @param {string} name
 * @param {*} params
 * @param {*} toolResult
 * @param {number} [iteration]
 * @param {number} [elapsed] - 毫秒
 * @param {object} [extra] - { id, affectedFiles }
 * @returns {Readonly<object>}
 */
function toolResultFromHost(name, params, toolResult, iteration, elapsed, extra = {}) {
  const e = extra && typeof extra === 'object' ? extra : {};
  return toolCall({
    id: e.id,
    name,
    status: _isFailure(toolResult) ? CALL_STATUS.ERROR : CALL_STATUS.OK,
    input: params,
    output: toolResult,
    iteration,
    elapsedMs: elapsed,
    affectedFiles: e.affectedFiles,
  });
}

/**
 * 从 **TUI 侧**的 onToolResult 三参形态构造节点。
 * 签名依据 `services/backend/src/cli/replSession.js:11137`：
 *   `(name, result, params)` —— ⚠ 第二个是 **result**，与 host 相反
 *
 * @param {string} name
 * @param {*} result
 * @param {*} params
 * @param {object} [extra] - { id }
 * @returns {Readonly<object>}
 */
function toolResultFromTui(name, result, params, extra = {}) {
  const e = extra && typeof extra === 'object' ? extra : {};
  return toolCall({
    id: e.id,
    name,
    status: _isFailure(result) ? CALL_STATUS.ERROR : CALL_STATUS.OK,
    input: params,
    output: result,
    // TUI 侧不传 iteration/elapsed ⇒ 保持 null（不臆造）
  });
}

/**
 * 构造一条消息节点。
 * @param {object} init - { id, role, text, thinking?, ts?, toolCallIds? }
 * @returns {Readonly<object>}
 */
function message(init = {}) {
  const o = init && typeof init === 'object' ? init : {};
  const rawRole = String(o.role == null ? '' : o.role).trim().toLowerCase();
  const role = ROLE_VALUES.indexOf(rawRole) >= 0 ? rawRole : ROLE.USER; // 保守，不丢内容
  const ids = Array.isArray(o.toolCallIds)
    ? o.toolCallIds.map((x) => String(x)).filter(Boolean) // 新数组：不改入参
    : [];
  return Object.freeze({
    id: String(o.id == null || o.id === '' ? role : o.id),
    role,
    text: String(o.text == null ? '' : o.text),
    thinking: o.thinking == null ? null : String(o.thinking),
    ts: _num(o.ts),
    toolCallIds: Object.freeze(ids),
  });
}

/**
 * 构造一条人在环审批节点。
 * @param {object} init - { id, toolName, reason, options? }
 * @returns {Readonly<object>}
 */
function approval(init = {}) {
  const o = init && typeof init === 'object' ? init : {};
  const opts = Array.isArray(o.options) ? o.options.slice() : []; // slice = 新数组
  return Object.freeze({
    id: String(o.id == null || o.id === '' ? 'approval' : o.id),
    toolName: String(o.toolName == null ? '' : o.toolName),
    reason: String(o.reason == null ? '' : o.reason),
    options: Object.freeze(opts),
  });
}

/**
 * 构造 usage 节点（token / 上下文 / 成本）。
 * @param {object} init - { inputTokens, outputTokens, contextUsed?, contextTotal?, cost? }
 * @returns {Readonly<object>}
 */
function usage(init = {}) {
  const o = init && typeof init === 'object' ? init : {};
  const used = _num(o.contextUsed);
  const total = _num(o.contextTotal);
  return Object.freeze({
    inputTokens: _num(o.inputTokens),
    outputTokens: _num(o.outputTokens),
    contextUsed: used,
    contextTotal: total,
    // ⚠ 不自己算百分比：除零/未知的处理是**渲染决策**（要显示「—」而不是 NaN%），
    //   放数据层会逼消费方反推。给原始数就够。
    cost: _num(o.cost),
  });
}

// ── 刻意不提供聚合层 ────────────────────────────────────────────────
// 早期版本有 createProjection / appendMessage / upsertToolCall / withUsage，
// 用于「消费方持有投影并按事件累积」。**已删除**（2026-10-02）：
//   桌面端 `renderer/state/toolExecutionSlice.ts` 已是完整状态真源
//   （5 态 + history 上限 50 + affectedFiles），且 `renderer/App.tsx:400-457`
//   已把 host 事件 dispatch 进去。在契约层再放一份聚合 = **第二份状态真源**，
//   两者会打架（谁先谁后、冲突时听谁的，都得额外约定）。
// ⇒ 本层只留「形状定义 + 转换 + 校验」，**状态归谁管由消费方自己决定**。

module.exports = {
  CALL_STATUS,
  CALL_STATUS_VALUES,
  ROLE,
  ROLE_VALUES,
  toolCall,
  toolResultFromHost,
  toolResultFromTui,
  message,
  approval,
  usage,
};
