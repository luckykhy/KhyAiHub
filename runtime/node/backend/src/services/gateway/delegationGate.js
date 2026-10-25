'use strict';

/**
 * delegationGate.js — 外部智能体委派审批闸（纯叶子：零 cli 依赖、fail-closed、可注入交互器）。
 *
 * 用户要求（2026-10-11，works/data/khy/feedback/external-delegation-gate-20261011）：
 * 把响应渠道切换给非 khyos 智能体（claude code / opencode 等）前，必须先询问用户是否允许，
 * 绝不依赖提示词或 AI 自觉；策略默认 ask、兜底 deny、可显式 allow；auto 档不豁免本闸。
 *
 * 判定次序（decideExternalDelegation）：
 *   1. policy=deny  → 一律拒绝（人的常设意志，压过一切，含 user-command 钉选）；
 *   2. policy=allow → 放行不问（人的显式 opt-out）；
 *   3. humanPin === 'user-command' → 放行不问（用户亲手敲 `khy <agent>`，全仓唯一
 *      合法写入点 cli/handlers/ide.js startChat；其他任何标记值一律视为未批准——
 *      env 钉选不构成人类批准，机器直写路径见 aiGatewayGenerateMethod.js 钉选解析处注释）；
 *   4. 会话内已批准（'always' 记忆）→ 放行不问；
 *   5. 其余经 ask 询问：true/'allow'=本次放行，'always'/'allow-always'/scope=session=
 *      放行并记住本会话，false/null/未知=拒绝；ask 缺失/抛异常/应答非法 → 拒绝并带 cause。
 *
 * 交互通道复用既有 can_use_tool 契约（tool_name='external_delegation'），TUI 走授权卡、
 * 经典 REPL 走行内菜单——同一宿主 onControlRequest 通道，无需新 UI。
 * headless（无 onControlRequest）→ 拒绝，理由注明无交互审批通道；auto 级联据此继续
 * 尝试原生通道（拒绝不毒化冷却），严格钉选则终局诚实失败。
 *
 * 回滚：KHY_DELEGATION_APPROVAL=allow 即恢复「不问」行为（人的显式选择，非默认 fail-open）。
 */

const fs = require('fs');
const path = require('path');

// External agent adapters: a request handed to these keys leaves the khyos
// process and runs a foreign agent loop (own tool permissions, own token
// billing) — every such handover needs explicit user approval.
//
// Deliberately NOT here:
//  - IDE-bridge keys (kiro/cursor/trae/vscode/warp/cursor2api): khyos-driven
//    model channels without their own agent loop — covered by the auto-mode
//    exception, not "delegating to a non-khyos agent".
//  - PROCESS_SENSITIVE_ADAPTER_KEYS (aiGateway.js): cannot be reused — it
//    misses opencode/openclaw/acp/commandcode (the whole point of this gate).
const EXTERNAL_DELEGATION_ADAPTER_KEYS = [
  'claude',
  'codex',
  'opencode',
  'openclaw',
  'acp',
  'commandcode',
  'cli',
];

// The ONLY trusted human-pin marker literal. Any other value (true, 'env-pin',
// whatever a future writer invents) is treated as NOT approved — the marker
// must never become a bypass channel for machine-written pinning.
const HUMAN_PIN_APPROVED = 'user-command';

const TOOL_NAME = 'external_delegation';

const POLICY = { ASK: 'ask', ALLOW: 'allow', DENY: 'deny' };

// Structured deny causes (A2-7: 判定失败必须留痕，不得静默放行)。
const DENY_CAUSES = {
  POLICY_DENY: 'policy-deny',
  USER_DECLINED: 'user-declined',
  NO_INTERACTIVE_CHANNEL: 'no-interactive-channel',
  PROMPT_ERROR: 'prompt-error',
  INVALID_ANSWER: 'invalid-answer',
};

/** 外部智能体 key 判定。纯函数，大小写不敏感，绝不抛。 */
function isExternalDelegationAdapter(key) {
  const k = String(key == null ? '' : key)
    .trim()
    .toLowerCase();
  return EXTERNAL_DELEGATION_ADAPTER_KEYS.includes(k);
}

/**
 * 策略解析：KHY_DELEGATION_APPROVAL ∈ ask/allow/deny，未设=ask。
 * 非法值（'yes'/'1'/乱串）→ deny（RUNTIME-010 A2-3：授权解析禁 fail-open）。
 */
function resolveDelegationPolicy(env) {
  const raw = String((env && env.KHY_DELEGATION_APPROVAL) || '')
    .trim()
    .toLowerCase();
  if (raw === POLICY.ALLOW) {
    return POLICY.ALLOW;
  }
  if (raw === POLICY.DENY) {
    return POLICY.DENY;
  }
  if (raw === POLICY.ASK || raw === '') {
    return POLICY.ASK;
  }
  return POLICY.DENY;
}

/**
 * 归一化审批应答。容忍面与 syscallGateway makeControlPrompter.decode /
 * guardApproval 的 fallback decode 对齐：TUI 原语（true/'always'/false）、
 * SDK {behavior} 对象、control_response 信封。
 *
 * @returns {{answer:'allow'|'deny', remember:boolean}}
 */
function normalizeDelegationAnswer(raw) {
  let r = raw;
  if (r && typeof r === 'object' && r.type === 'control_response' && r.response) {
    r = r.response;
  }
  if (r && typeof r === 'object' && r.response && typeof r.response === 'object') {
    r = r.response;
  }
  if (r === true) {
    return { answer: 'allow', remember: false };
  }
  if (r === 'always' || r === 'allow-always') {
    return { answer: 'allow', remember: true };
  }
  if (r === 'allow') {
    return { answer: 'allow', remember: false };
  }
  if (!r || typeof r !== 'object') {
    return { answer: 'deny', remember: false };
  }
  const behavior = String(r.behavior || '')
    .trim()
    .toLowerCase();
  if (behavior === 'allow-always' || r.scope === 'session') {
    return { answer: 'allow', remember: true };
  }
  if (behavior === 'allow') {
    return { answer: 'allow', remember: false };
  }
  return { answer: 'deny', remember: false };
}

/** 会话级批准记忆（网关实例生命周期；跨进程不持久，重启后重新问）。 */
function createSessionApprovalStore() {
  const remembered = new Set();
  return {
    remember(key) {
      remembered.add(String(key == null ? '' : key));
    },
    has(key) {
      return remembered.has(String(key == null ? '' : key));
    },
  };
}

/**
 * 把宿主 onControlRequest 适配成 ask(ctx)。宿主通道缺失 → null（调用方走
 * no-interactive-channel 拒绝）；input 携带中文问句与渠道名，宿主渲染层直接可读。
 */
function buildDelegationAsk(onControlRequest) {
  if (typeof onControlRequest !== 'function') {
    return null;
  }
  return async (ctx) => {
    return onControlRequest({
      requestId: ctx.requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: TOOL_NAME,
        input: ctx.input,
      },
    });
  };
}

/**
 * 一次判定。参数：
 *   adapterKey      — 网关适配器 key（已由调用方确认属外部智能体集合）
 *   adapterName     — 适配器展示名（getStatus().name，问句与拒绝文案用）
 *   policy          — resolveDelegationPolicy 产物
 *   humanPin        — options.delegationApprovedByUser（仅认 'user-command' 字面单值）
 *   sessionApproved — 会话记忆命中（this._delegationApprovals.has(key)）
 *   sessionStore    — createSessionApprovalStore 实例（'always' 回填用，可空）
 *   ask             — buildDelegationAsk 产物（可空 = 无交互通道）
 *
 * 免问通道（策略 deny/allow、'user-command' 钉选、会话记忆）即时返回，
 * 不排在挂起的询问后面；只有真正要问的判定进模块级 promise 链串行化——
 * 级联在多个通道并发到达时防双弹窗（permissionBroker 串行审批同一先例）。
 * 链上任务自身绝不 throw（拒绝已是兜底），故链不会断。
 */
let _askChain = Promise.resolve();

function decideExternalDelegation({
  adapterKey,
  adapterName,
  policy,
  humanPin,
  sessionApproved,
  sessionStore,
  ask,
} = {}) {
  const key = String(adapterKey == null ? '' : adapterKey);
  const name = String(adapterName || key || '外部智能体');
  if (policy === POLICY.DENY) {
    return Promise.resolve({
      allowed: false,
      asked: false,
      cause: DENY_CAUSES.POLICY_DENY,
      reason: `外部智能体 ${name} 委派未获批准：KHY_DELEGATION_APPROVAL=deny 策略一律拒绝，需放行请改为 ask 或 allow`,
    });
  }
  if (policy === POLICY.ALLOW) {
    return Promise.resolve({ allowed: true, asked: false, cause: 'policy-allow' });
  }
  if (humanPin === HUMAN_PIN_APPROVED) {
    // 用户亲手敲 `khy <agent>`：命令本身即批准证据，不重复问。
    return Promise.resolve({ allowed: true, asked: false, cause: 'user-command' });
  }
  if (sessionApproved) {
    return Promise.resolve({ allowed: true, asked: false, cause: 'session-approved' });
  }
  if (typeof ask !== 'function') {
    return Promise.resolve({
      allowed: false,
      asked: false,
      cause: DENY_CAUSES.NO_INTERACTIVE_CHANNEL,
      reason: `外部智能体 ${name} 委派未获批准：当前无交互审批通道（headless 环境），请改用交互会话批准，或设 KHY_DELEGATION_APPROVAL=allow`,
    });
  }
  const run = async () => {
    let raw = null;
    // Host-render fields for the question. The TUI classic card reads ONLY
    // description/command (permissionNotice.cardRows:248-251) and the classic
    // REPL prints ONLY explanation.text (replSession.js:8683-8693) — without
    // these both hosts show a blind "Allow external_delegation?" with no hint
    // of which agent is being approved.
    const questionText = `是否允许把本次响应渠道切换到外部智能体「${name}」？它将在你机器上以自身权限运行，并产生其自身渠道的费用。`;
    try {
      raw = await ask({
        requestId: `delegation_${Date.now()}_${key}`,
        input: {
          question: questionText,
          adapter: key,
          adapterName: name,
          choices: '允许本次 / 本会话总是允许 / 拒绝',
          description: `把本次响应渠道切换到外部智能体「${name}」`,
          command: `响应渠道 → ${name}`,
          explanation: {
            text: questionText,
            headline: `外部智能体委派：${name}`,
          },
        },
      });
    } catch (err) {
      return {
        allowed: false,
        asked: true,
        cause: DENY_CAUSES.PROMPT_ERROR,
        reason: `外部智能体 ${name} 委派未获批准：审批询问通道异常（${(err && err.message) || 'unknown'}），已按拒绝处理`,
      };
    }
    const answer = normalizeDelegationAnswer(raw);
    if (answer.answer !== 'allow') {
      return {
        allowed: false,
        asked: true,
        cause: DENY_CAUSES.USER_DECLINED,
        reason: `外部智能体 ${name} 委派未获批准：你在审批询问中未允许（拒绝或应答无法识别均按拒绝处理）`,
      };
    }
    if (answer.remember && sessionStore && typeof sessionStore.remember === 'function') {
      sessionStore.remember(key);
    }
    return {
      allowed: true,
      asked: true,
      cause: answer.remember ? 'user-allow-always' : 'user-allow-once',
      remembered: !!answer.remember,
    };
  };
  const chained = _askChain.then(run, run);
  _askChain = chained.catch(() => {});
  return chained;
}

/**
 * 自动级联剔除判定：外部委派 key 不进自动候选池（PROCESS-004「默认自做，委派是例外」）。
 *
 * 只有两种情形保留外部 key：用户亲手敲 `khy <agent>` 的会话（humanPin='user-command'），
 * 或用户显式钉选的那一条（userPinnedAdapter + preferredAdapter）——后者是用户点名的通道。
 * env 钉选（预检胜者 / 自检修复 / setActiveChannel 三条机器直写路径）不构成批准，
 * 与 options 解析处同一条判定（aiGatewayGenerateMethod.js 顶部注释）。
 * 策略 allow 是人的显式 opt-out（本闸的既有回滚面），此时不剔除。
 *
 * @returns {{kept: Array, removedKeys: string[]}}
 */
function stripUnapprovedExternalAdapters(
  adapters,
  { delegationApprovedByUser, delegationPolicy, userPinnedAdapter, preferredAdapter } = {}
) {
  const list = Array.isArray(adapters) ? adapters : [];
  if (delegationApprovedByUser === HUMAN_PIN_APPROVED || delegationPolicy === POLICY.ALLOW) {
    return { kept: list, removedKeys: [] };
  }
  const pinnedKey = userPinnedAdapter ? String(preferredAdapter || '') : '';
  const removed = list.filter(
    (a) => isExternalDelegationAdapter(a && a.key) && String((a && a.key) || '') !== pinnedKey
  );
  if (removed.length === 0) {
    return { kept: list, removedKeys: [] };
  }
  const removedKeys = removed.map((a) => String(a.key));
  const removedSet = new Set(removedKeys);
  return { kept: list.filter((a) => !removedSet.has(String((a && a.key) || ''))), removedKeys };
}

/**
 * 一次拒绝 = 本轮其余外部委派 key 静默跳过。用户的拒绝是对「把活交给外部智能体」这件事
 * 本身的拒绝，不是对某一个 key 的拒绝——接着问下一个 key 等于把同一个问题重问一遍。
 */
function shouldSilenceExternalOnRoundDenial(adapterKey, deniedThisRound) {
  return !!deniedThisRound && isExternalDelegationAdapter(adapterKey);
}

/**
 * 拒绝信封：与 _generateWithAdapterIsolation 的 beforeRun-skip 同型
 * （success:false / statusCode:0 / gatewaySkipFastFail:true / attempts:[]）。
 * gatewaySkipFastFail 让级联按既有 virtualSkip 路径留痕、释放尝试预算（不毒化
 * 冷却）并继续下一通道；严格钉选则走 finishResult 终局诚实失败。
 */
function buildDelegationDeniedResult(entry, reason) {
  let provider = String((entry && entry.key) || 'external');
  try {
    const n = entry && entry.adapter && typeof entry.adapter.getStatus === 'function'
      ? entry.adapter.getStatus().name
      : '';
    if (n) {
      provider = n;
    }
  } catch {
    /* keep key fallback */
  }
  return {
    success: false,
    error: String(reason || '外部智能体委派未获批准'),
    errorType: 'delegation_denied',
    statusCode: 0,
    provider,
    adapter: String((entry && entry.key) || 'external'),
    gatewaySkipFastFail: true,
    attempts: [],
  };
}

// 观察样本落点：<dataHome>/ruleguard/delegation-gate.jsonl（与 auto-route.jsonl
// 同档惯例；env KHY_DELEGATION_GATE_OBSERVE_FILE 可覆盖，测试注入用）。
//
// 落点必须经 utils/dataHome 解析器取址（CLAUDE.md §二 B8）：用 process.cwd() 拼
// 会在「从仓库根以外的目录敲 khy」时另造一棵影子数据树，并把 works/ 树种进
// runtime/node/backend/。同批新增的 services/confidenceCalibrationLedger.js
// 已是正确写法（getDataDir('ruleguard') 优先，dataHome 不可用才回退 cwd）。
const _OBSERVE_REL = path.join('works', 'data', 'khy', 'ruleguard', 'delegation-gate.jsonl');
const _OBSERVE_MAX_BYTES = 2 * 1024 * 1024;

function _observePath(env) {
  const override = env && env.KHY_DELEGATION_GATE_OBSERVE_FILE;
  if (override && typeof override === 'string') {
    return override;
  }
  try {
    const { getDataDir } = require('../../utils/dataHome');
    if (typeof getDataDir === 'function') {
      return path.join(getDataDir('ruleguard'), 'delegation-gate.jsonl');
    }
  } catch {
    /* dataHome 不可用 → cwd 回退 */
  }
  return path.resolve(process.cwd(), _OBSERVE_REL);
}

/**
 * 判定留痕（fail-soft 绝不抛——观察落盘绝不影响生成）。超 2MB 裁半，
 * 被裁半段先追加进 .archive.jsonl 再重写热文件（不静默丢样本）。
 */
function observeDelegationSample(sample, env) {
  try {
    const file = _observePath(env || process.env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > _OBSERVE_MAX_BYTES) {
        const keep = fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean);
        const dropped = keep.slice(0, Math.floor(keep.length / 2));
        try {
          fs.appendFileSync(file + '.archive.jsonl', dropped.join('\n') + '\n', 'utf8');
        } catch {
          /* 归档失败则不裁剪：宁可热文件超尺寸，也不静默丢样本 */
          throw new Error('archive-failed');
        }
        fs.writeFileSync(file, keep.slice(Math.floor(keep.length / 2)).join('\n') + '\n', 'utf8');
      }
    } catch {
      /* 裁剪失败照写不拦 */
    }
    fs.appendFileSync(
      file,
      JSON.stringify({ ev: 'delegation', at: new Date().toISOString(), ...(sample || {}) }) + '\n',
      'utf8'
    );
  } catch {
    /* 观察落盘绝不影响生成 */
  }
}

module.exports = {
  EXTERNAL_DELEGATION_ADAPTER_KEYS,
  HUMAN_PIN_APPROVED,
  TOOL_NAME,
  POLICY,
  DENY_CAUSES,
  isExternalDelegationAdapter,
  stripUnapprovedExternalAdapters,
  shouldSilenceExternalOnRoundDenial,
  resolveDelegationPolicy,
  normalizeDelegationAnswer,
  createSessionApprovalStore,
  buildDelegationAsk,
  decideExternalDelegation,
  buildDelegationDeniedResult,
  observeDelegationSample,
};
