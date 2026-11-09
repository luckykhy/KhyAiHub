'use strict';

// RULES-REGISTRY: PROCESS-004

/**
 * claudeDelegation — 「该不该把这个子任务委派给外部编码 CLI」的单一决策真源。
 *
 * 背景：`claudeAdapter`（key `claude`，bridge 模式 spawn `claude -p` headless 跑
 * Claude Code 自己的 agentic loop）早已是一等网关适配器，`AgentTool` 的
 * `subagent_type:'claude'` 也已把子代理路由到它。但旧实现是「强制锁 claude 适配器，
 * 失败后才反应式级联回退」，既不前置探测、也没有「Khy 自动判断是否最优」的能力、
 * 更不在结果里说明委派与否。
 *
 * 本模块把决策抽成纯函数 + 依赖注入，落地用户的两条诉求：
 *   ① 模型显式选外部 agent（explicit）→ 可用就委派，不可用就干净回退、给出原因（不强求）。
 *   ② Khy 自动判断（auto）→ 仅在 feature flag 开 + 保守启发式命中 + 可用时才委派；
 *      默认偏向「不委派」，避免无谓 spawn 重进程与外部 token 成本。
 *   ③（2026-09-16 新增，PROCESS-004 / [DESIGN-PROCESS-001]）**两条路径都必须过委派准入**：
 *      启发式判的是「任务看起来像重活」，而不是「这件事为什么该交给别人」——重活恰恰是
 *      khy 自己的核心能力。缺闸门（G1 用户点名 / G2 能力缺失 / G3 隔离要求）即不委派，
 *      fail-closed 一律落到「自做」这一侧。
 *   ④（2026-10-15 新增）**三条可委派面统一过闸门，且 G1 的凭据不再由模型书写**。
 *      此前的洞：`AgentTool` 对 `subagent_type:'codex'`/`'opencode'` 直接赋适配器、不过准入；
 *      G1 由工具侧读模型自写的 `[委派闸门 G1]` 即放行——被约束方同时握着证据的书写权。
 *      现在 G1 只认 `delegationTicket` 按本轮 turn 签发的票券（turnId 经 traceContext 下发，
 *      不在工具入参 schema 里），prompt 里的标记降级为向用户申报的措辞。
 *
 * 任何异常一律 fail-soft 为「不委派」，绝不让委派逻辑崩掉 AgentTool。
 */

/** 外部编码 CLI 适配器模块（按外部 agent id 索引）。 */
const EXTERNAL_ADAPTER_PATHS = Object.freeze({
  claude: '../../services/gateway/adapters/claudeAdapter',
  codex: '../../services/gateway/adapters/codexAdapter',
  opencode: '../../services/gateway/adapters/opencodeAdapter',
});

/**
 * 默认探测：复用各适配器的 detect()（带缓存，首次未命中才 spawn 一次）。
 * 抽成可注入的 thunk，测试不触真 spawn。
 * @param {string} agentId 外部 agent id（claude/codex/opencode）
 * @returns {boolean}
 */
function _defaultDetectFor(agentId) {
  const rel = EXTERNAL_ADAPTER_PATHS[String(agentId || '').toLowerCase()];
  if (!rel) return false;
  try {
    return !!require(rel).detect();
  } catch {
    return false;
  }
}

/** claude 的探测（保持既有签名，测试与调用点不变）。 */
function _defaultDetect() {
  return _defaultDetectFor('claude');
}

/**
 * 默认 auto 委派开关：feature flag `claudeDelegation`（默认 off，实验性）。
 * explicit 路径不读它——显式请求是既有契约，只加健壮性。
 * @returns {boolean}
 */
function _defaultIsAutoDelegationEnabled() {
  try {
    return !!require('../../services/featureFlags').isEnabled('claudeDelegation');
  } catch {
    return false;
  }
}

/**
 * 保守启发式：这个任务是否「适合」交给 Claude Code 自主完成。
 *
 * 只在强信号（大型/多文件/重构/端到端实现）下命中，宁可漏判（回退 Khy 自身）也不
 * 误判（白白 spawn 一个重进程）。仅用于 auto 路径；explicit 路径不经过它。
 *
 * @param {string} prompt
 * @param {string} role
 * @returns {boolean}
 */
function _looksLikeClaudeCodeTask(prompt, role) {
  const text = String(prompt || '');
  if (text.trim().length < 40) {
    return false;
  } // 太短的任务不值得委派重进程

  // 强信号：跨多文件 / 重构 / 大型实现 / 迁移 / 端到端。中英双语。
  const strong =
    /(重构|多文件|跨文件|整个(项目|模块|代码库)|端到端|大规模|迁移|migrat(e|ion)|refactor|across (multiple )?files|whole (project|codebase|module)|end[- ]to[- ]end|large[- ]scale)/i;
  if (strong.test(text)) {
    return true;
  }

  // 中等信号需叠加：明确「实现 + 长描述」才算（实现类 role 且描述足够具体）。
  const impl = /(实现|开发|搭建|build|implement|develop|scaffold)/i;
  if ((role === 'implement' || role === 'general') && impl.test(text) && text.length >= 200) {
    return true;
  }
  return false;
}

/**
 * 默认委派准入判定：延迟 require 认知层 + 票券。
 *
 * 为什么必须过这一关（PROCESS-004 / [DESIGN-PROCESS-001]）：启发式判的是
 * 「任务看起来像重活」，而不是「任务为什么该别人做」——重活恰恰是 khy 自己的核心能力。
 * 没有闸门就把活发出去，正是「莫名其妙甩活」的形态。
 *
 * 拿不到叶子 ⇒ 返回**永不授权**的替身：fail-closed 必须落在「自做」这一侧。
 * @returns {{evaluateAdmission:Function, detectGate:Function, externalAgents:object[], redeemTicket:Function}}
 */
function _defaultDelegationTools() {
  try {
    const mod = require('../../services/externalAgentDirective');
    const tickets = require('../../services/delegationTicket');
    return {
      evaluateAdmission:
        typeof mod.evaluateDelegationAdmission === 'function'
          ? mod.evaluateDelegationAdmission
          : _DENY_ALL_ADMISSION,
      detectGate: typeof mod.detectDelegationGateInText === 'function' ? mod.detectDelegationGateInText : () => null,
      externalAgents: Array.isArray(mod.EXTERNAL_AGENTS) ? mod.EXTERNAL_AGENTS : [],
      redeemTicket:
        typeof tickets.redeemDelegationTicket === 'function' ? tickets.redeemDelegationTicket : () => false,
    };
  } catch {
    return {
      evaluateAdmission: _DENY_ALL_ADMISSION,
      detectGate: () => null,
      externalAgents: [],
      redeemTicket: () => false,
    };
  }
}

/** 准入不可用时的替身：一律 deny（fail-closed 到自做）。 */
const _DENY_ALL_ADMISSION = () => ({
  allowed: false,
  gate: null,
  gateKey: null,
  code: 'admission-unavailable',
  reason: '委派准入判定不可用，按默认档由 Khy 自做',
});

/** 外部 agent id 是否属于「可经 Agent 工具委派」集合（注册表真源：EXTERNAL_AGENTS）。 */
function isDelegatableExternalAgent(agentId, tools) {
  const id = String(agentId || '').trim().toLowerCase();
  if (!id) return false;
  const list = Array.isArray(tools && tools.externalAgents) ? tools.externalAgents : [];
  return list.some((a) => a && a.id === id && a.delegatable === true);
}

/** 组装一次准入判定（G1 凭据 = 本轮票券；G2/G3 = 结构化证据）。 */
function _admit(task, tools, agentId) {
  const redeem = typeof tools.redeemTicket === 'function' ? tools.redeemTicket : () => false;
  const evaluateAdmission =
    typeof tools.evaluateAdmission === 'function' ? tools.evaluateAdmission : _DENY_ALL_ADMISSION;
  // G1 凭据：运行时按本轮 turn 签发。turnId 来自 traceContext（loop 下发），
  // 不在工具入参 schema 里 ⇒ 模型无法自造「用户点名」这个事实。
  let ticketed = false;
  try {
    ticketed = redeem(task.turnId, agentId) === true;
  } catch {
    ticketed = false;
  }
  try {
    const admission = evaluateAdmission({
      userNamedAgentId: ticketed ? agentId : '',
      capabilityGap: task.capabilityGap,
      isolationRequired: task.isolationRequired === true,
      isolationNote: task.isolationNote,
      reason: task.delegationReason,
      selfCapable: task.selfCapable === true,
    });
    return admission && typeof admission.allowed === 'boolean' ? admission : _DENY_ALL_ADMISSION();
  } catch {
    return _DENY_ALL_ADMISSION();
  }
}

/**
 * 决定是否把子任务委派给某个**外部编码 CLI agent**（claude / codex / opencode）。
 *
 * 三条可委派面共用这一个决策点：任何一条自己赋值适配器的实现都是绕过闸门的形态
 * （2026-10-15 实测：codex/opencode 两条面此前直连适配器、不过准入）。
 *
 * @param {object} task
 * @param {string} task.agentId                目标外部 agent id
 * @param {string} [task.prompt]               子任务描述
 * @param {string} [task.role]                 解析后的内部 role
 * @param {string} [task.turnId]               本轮 turn id（G1 票券的核销键，来自 traceContext）
 * @param {string} [task.userNamedAgentId]     G1：已由调用方核销过的点名（内部用，通常留空）
 * @param {string|string[]} [task.capabilityGap] G2：khy 本地缺失的能力清单
 * @param {boolean} [task.isolationRequired]   G3：是否必须在隔离的外部环境执行
 * @param {string} [task.isolationNote]        G3：隔离原因
 * @param {string} [task.delegationReason]     G2/G3 的一句话可核验理由
 * @param {boolean} [task.selfCapable]         调用方声明本地能覆盖 ⇒ 无条件不委派
 * @param {object} [deps]
 * @param {function(string):boolean} [deps.detectFor]   外部 CLI 可用性探测（按 agent id）
 * @param {object} [deps.tools]                延迟 require 的准入判定工具（测试注入）
 * @returns {{delegate:boolean, adapter:(string|null), reason:string, available:boolean, mode:('explicit'|'none'), gate:(string|null), code:string}}
 */
function decideExternalDelegation(task = {}, deps = {}) {
  const tools = deps.tools || _defaultDelegationTools();
  const detectFor = typeof deps.detectFor === 'function' ? deps.detectFor : _defaultDetectFor;
  const agentId = String(task.agentId || task.role || '').trim().toLowerCase();
  const mode = task.explicitlyRequested === false ? 'none' : 'explicit';

  if (!isDelegatableExternalAgent(agentId, tools)) {
    return {
      delegate: false,
      adapter: null,
      reason: `「${agentId || '未指定'}」不是可经 Agent 工具委派的外部 agent，由 Khy 自身处理`,
      available: false,
      mode,
      gate: null,
      code: 'unknown-agent',
    };
  }

  // ── 委派准入（三闸门 G1/G2/G3，默认自做）──────────────────────────────────
  const admission = _admit(task, tools, agentId);

  try {
    if (!admission.allowed) {
      return _denied(mode, admission, () => detectFor(agentId));
    }
    if (!detectFor(agentId)) {
      return {
        delegate: false,
        adapter: null,
        reason: `${agentId} CLI 未安装，已改用 Khy 最优适配器完成任务`,
        available: false,
        mode,
        gate: admission.gate,
        code: admission.code,
      };
    }
    return {
      delegate: true,
      adapter: agentId,
      reason: `已委派 ${agentId}(闸门 ${admission.gate}：${admission.reason})`,
      available: true,
      mode,
      gate: admission.gate,
      code: admission.code,
    };
  } catch {
    return {
      delegate: false,
      adapter: null,
      reason: '委派决策异常，已回退 Khy 自身处理',
      available: false,
      mode: 'none',
      gate: null,
      code: 'fail-soft',
    };
  }
}

/**
 * 决定是否把子任务委派给 Claude Code（claude 面；保留既有签名与调用点）。
 *
 * explicit 分支直接委托给 decideExternalDelegation（同一套闸门）；
 * auto 分支多两道 khy 自有的保守门：feature flag + 启发式。
 *
 * @param {object} task  见 decideExternalDelegation；另需 role/explicitlyRequested
 * @param {object} [deps]
 * @param {function():boolean} [deps.detect]                  claude CLI 可用性探测
 * @param {function():boolean} [deps.isAutoDelegationEnabled] auto 委派开关
 * @param {object} [deps.tools]             延迟 require 的准入判定工具（测试注入）
 * @returns {{delegate:boolean, adapter:('claude'|null), reason:string, available:boolean, mode:('explicit'|'auto'|'none'), gate:(string|null), code:string}}
 */
function decideClaudeDelegation(task = {}, deps = {}) {
  const tools = deps.tools || _defaultDelegationTools();
  const detect = typeof deps.detect === 'function' ? deps.detect : _defaultDetect;
  const isAutoDelegationEnabled =
    typeof deps.isAutoDelegationEnabled === 'function'
      ? deps.isAutoDelegationEnabled
      : _defaultIsAutoDelegationEnabled;

  // ── explicit：模型显式请求 Claude Code，但**必须过闸门** ────────────────
  if (task.explicitlyRequested === true) {
    const d = decideExternalDelegation({ ...task, agentId: 'claude' }, { ...deps, tools, detectFor: () => detect() });
    return { ...d, mode: 'explicit' };
  }

  const admission = _admit(task, tools, 'claude');
  const role = task.role || '';
  const prompt = task.prompt || '';

  try {
    // ── auto：Khy 自动判断（flag 默认关，opt-in） ──────────────────────────
    if (!isAutoDelegationEnabled()) {
      return {
        delegate: false,
        adapter: null,
        reason: 'auto 委派未启用',
        available: false,
        mode: 'none',
        gate: admission.gate,
        code: admission.code,
      };
    }
    if (!_looksLikeClaudeCodeTask(prompt, role)) {
      return {
        delegate: false,
        adapter: null,
        reason: '任务未达 Claude Code 委派阈值，由 Khy 自身处理',
        available: false,
        mode: 'none',
        gate: admission.gate,
        code: admission.code,
      };
    }
    // 启发式命中 ≠ 闸门成立：必须由 G1/G2/G3 之一背书才允许 spawn 外部进程。
    if (!admission.allowed) {
      return {
        delegate: false,
        adapter: null,
        reason: `任务虽命中委派启发式，但未过准入闸门(${admission.code})，由 Khy 自身处理`,
        available: false,
        mode: 'none',
        gate: admission.gate,
        code: admission.code,
      };
    }
    if (!detect()) {
      return {
        delegate: false,
        adapter: null,
        reason: 'claude CLI 未安装，由 Khy 自身处理',
        available: false,
        mode: 'none',
        gate: admission.gate,
        code: admission.code,
      };
    }
    return {
      delegate: true,
      adapter: 'claude',
      reason: `已委派 Claude Code(闸门 ${admission.gate}：${admission.reason})`,
      available: true,
      mode: 'auto',
      gate: admission.gate,
      code: admission.code,
    };
  } catch {
    // fail-soft：决策本身出任何错都不委派、不抛，让 AgentTool 走自身路径。
    return {
      delegate: false,
      adapter: null,
      reason: '委派决策异常，已回退 Khy 自身处理',
      available: false,
      mode: 'none',
      gate: null,
      code: 'fail-soft',
    };
  }
}

/** 准入被拒时的统一返回（仍要把 CLI 可用性如实报出）。 */
function _denied(mode, admission, detect) {
  let available = false;
  try {
    available = !!detect();
  } catch {
    available = false;
  }
  return {
    delegate: false,
    adapter: null,
    reason: `委派未过准入闸门(${admission.code}：${admission.reason})，由 Khy 自身处理`,
    available,
    mode,
    gate: admission.gate,
    code: admission.code,
  };
}

module.exports = {
  decideClaudeDelegation,
  decideExternalDelegation,
  isDelegatableExternalAgent,
  // 导出内部件供测试 / AgentTool 复用
  _looksLikeClaudeCodeTask,
  _defaultDetect,
  _defaultDetectFor,
  _defaultIsAutoDelegationEnabled,
  _defaultDelegationTools,
};
