'use strict';

/**
 * hiaoBridgePolicy.js — pure leaf (zero IO, deterministic, never throws).
 *
 * Two questions, answered without touching the phone:
 *   1. Does this call need a human confirmation on OUR side before it is sent?
 *   2. When it fails, is that a refusal (approval / lease / policy) or a fault
 *      (device / link)? The two must never be reported as each other — the
 *      whole point of the hiao profile is that a denial is a governance
 *      outcome, not a broken phone.
 *
 * Tiering is fail-closed: only names on HIAO_READONLY_TOOLS are read; a tool
 * name we do not recognize is treated as a write and waits for confirm. The
 * phone's own list changes between hiao versions (/status reports it live), so
 * an allowlist can only ever be a shortcut — never a way to skip confirmation
 * for a name the phone added after we shipped.
 */

// The three tools the hiao docs describe as pure reads. Frozen on purpose:
// this is a confirmation shortcut, so growing it needs a deliberate edit plus
// evidence that the new name cannot change the phone's state.
const HIAO_READONLY_TOOLS = Object.freeze(['info', 'status', 'agent_status']);

// Same spelling as the phone profile (phoneBridgePolicy.planBridgeCall). The
// amoo profile answers 'confirm_required' — the divergence is known and this
// batch does not spread it further.
const CONFIRM_CODE = 'requires_confirm';

function _readString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

/**
 * @param {string} tool - bridge tool name as sent to /call
 * @returns {{ok:boolean, tool?:string, tier?:'read'|'write'|'unknown', requiresConfirm?:boolean, code?:string, error?:string}}
 */
function classifyHiaoCall(tool) {
  const name = _readString(tool);
  if (!name) {
    return {
      ok: false,
      code: 'invalid_tool',
      error: '缺少 tool：hiao 调用需要一个工具名（例如 info、status、agent_task）。先用 action "tools" 查看手机端当前工具表。',
    };
  }
  if (HIAO_READONLY_TOOLS.includes(name)) {
    return { ok: true, tool: name, tier: 'read', requiresConfirm: false };
  }
  // Unknown names land here too, and that is the point: a name the phone added
  // after this list was frozen must still stop for confirmation.
  return {
    ok: true,
    tool: name,
    tier: 'write',
    requiresConfirm: true,
    known: false,
  };
}

/**
 * What to return when the caller did not pass confirm:true. Nothing is sent —
 * the caller gets the exact plan so a human can approve a specific call
 * instead of a vague intent.
 */
function planHiaoCall({ tool, args, baseUrl } = {}) {
  const classified = classifyHiaoCall(tool);
  if (!classified.ok) {
    return { success: false, error: classified.error, code: classified.code };
  }
  if (!classified.requiresConfirm) {
    return { success: true, requiresConfirm: false, classification: classified };
  }
  return {
    success: true,
    requiresConfirm: true,
    code: CONFIRM_CODE,
    plan: {
      tool: classified.tool,
      args: args && typeof args === 'object' ? args : {},
      tier: classified.tier,
      endpoint: baseUrl ? `${baseUrl}/call` : '/call',
    },
    message: `将在手机上调用 ${classified.tool}（写操作）。该调用可能阻塞等你手机上的审批`
      + '（最长 600s，超时=拒绝）。确认后重发并带 confirm:true 才会真正发送。',
  };
}

// ── failure classification ───────────────────────────────────────────────────

const APPROVAL_TIMEOUT_MESSAGE =
  '手机端 600s 内未放行，视为拒绝。请在手机审批卡上放行该次调用后重试；'
  + '放行前可先用 action "ping" 确认桥还活着。';

const HIAO_DENY_MESSAGE =
  '手机端拒绝执行（verdict=deny）。常见原因是策略拒绝、审批被拒或该能力没有租约；'
  + '用 action "approvals" 看有没有待批卡，用 action "audit" 回查拒绝记录后再决定是否重试。';

const LEASE_MISSING_MESSAGE =
  '缺少有效租约：该工具属 high 级，hiao 要求先在手机上给对应能力签发租约。'
  + '请在手机 hiao 的设置里签发租约后重试。';

const UNAUTHORIZED_MESSAGE =
  '认证失败：配对令牌无效或已轮换（401/403）。请在手机 hiao「设置 → 连接 → 配对令牌」'
  + '重新配对，并把新令牌同步到本机后重试。';

const UNREACHABLE_MESSAGE =
  '手机端不可达：adb forward 已建立，但连接被拒或在超时内没有回应。请在手机上打开 hiao '
  + '并确认桥服务已启动，再重试（必要时先跑 action "ping"）。';

const DEVICE_FAULT_MESSAGE =
  '设备侧故障：adb 或手机端引擎返回了错误。请查看手机端 hiao 的状态页与 /audit 后重试。';

/**
 * Map a transport/response outcome onto the closed set of codes the tool
 * surfaces. Order matters: a body that names an approval outcome is a
 * governance refusal even when the HTTP status is also non-2xx. An aborted
 * request is only read as the approval deadline on the blocking /call path
 * (`approvalWait:true`); on a GET a deadline is a plain link timeout.
 *
 * @param {{status?:number, bodyText?:string, error?:string, aborted?:boolean, approvalWait?:boolean, source?:'http'|'adb'}} input
 * @returns {{code:string, error:string}}
 */
function classifyHiaoFailure(input = {}) {
  const status = Number(input.status) || 0;
  const body = String(input.bodyText || '');
  const lower = body.toLowerCase();
  const detail = String(input.error || '');
  const withDetail = (message) => (detail ? `${message}（${detail}）` : message);

  // Refusals first: the phone answered, and its answer says why. Both probes
  // must be spelling-tolerant: hiao's machine-readable fields use the underscore
  // form (approval_timeout / lease_missing), human-readable strings may be
  // Chinese (审批超时 / 租约), and English prose uses spaces. A word-bounded
  // English-only probe would drop the underscore and Chinese shapes into
  // device_fault — a governance refusal reported as a broken phone, the exact
  // misattribution this unit exists to kill.
  const mentionsApproval = /\bapprovals?\b|approval_|审批/.test(lower);
  const mentionsTimeout = /(timeout|timed out|超时)/.test(lower);
  const mentionsLease = /\bleases?\b|lease_|租约/.test(lower);
  if (mentionsApproval && mentionsTimeout) {
    return { code: 'approval_timeout', error: APPROVAL_TIMEOUT_MESSAGE };
  }
  if (mentionsLease) {
    return { code: 'lease_missing', error: LEASE_MISSING_MESSAGE };
  }
  if (status === 401 || status === 403) {
    return { code: 'unauthorized', error: withDetail(UNAUTHORIZED_MESSAGE) };
  }
  if (input.aborted === true) {
    if (input.approvalWait === true) {
      // Our own deadline fired while waiting for a blocked /call. The single
      // most likely cause is "nobody tapped approve"; it is NOT evidence that
      // the device is broken, so it must not borrow device_fault's wording.
      return { code: 'approval_timeout', error: APPROVAL_TIMEOUT_MESSAGE };
    }
    // A GET deadline has nothing to do with approvals: the bridge did not
    // answer within the short I/O timeout, i.e. the link is not usable.
    return { code: 'unreachable', error: withDetail(UNREACHABLE_MESSAGE) };
  }
  if (/"verdict"\s*:\s*"deny"/.test(body) || /"verdict"\s*:\s*'deny'/.test(body)) {
    return { code: 'hiao_deny', error: HIAO_DENY_MESSAGE };
  }
  if (input.source === 'adb' || status >= 500) {
    return { code: 'device_fault', error: withDetail(DEVICE_FAULT_MESSAGE) };
  }
  if (status === 0) {
    return { code: 'unreachable', error: withDetail(UNREACHABLE_MESSAGE) };
  }
  return { code: 'device_fault', error: withDetail(`${DEVICE_FAULT_MESSAGE} HTTP ${status}。`) };
}

const HIAO_FAILURE_MESSAGES = Object.freeze({
  approval_timeout: APPROVAL_TIMEOUT_MESSAGE,
  hiao_deny: HIAO_DENY_MESSAGE,
  lease_missing: LEASE_MISSING_MESSAGE,
  unauthorized: UNAUTHORIZED_MESSAGE,
  unreachable: UNREACHABLE_MESSAGE,
  device_fault: DEVICE_FAULT_MESSAGE,
});

module.exports = {
  HIAO_READONLY_TOOLS,
  CONFIRM_CODE,
  HIAO_FAILURE_MESSAGES,
  classifyHiaoCall,
  planHiaoCall,
  classifyHiaoFailure,
};
