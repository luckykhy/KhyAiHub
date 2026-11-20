/**
 * HiaoBridgeTool — hiao（phone-dsh）手机桥的 AI 工具面（khy-os → 手机，OUTBOUND）。
 *
 * 背景：phone 单元接的是 StepBridge（8896，无治理的轻桥）；hiao 是第二套
 * APK，给的是**带治理的执行层**：策略 → 租约 → 人工审批 → 审计哈希链，另可
 * 把整任务委托给手机端 agent。本工具是它的 AI 入口，全部逻辑在
 * services/domain/network/phone/hiaoBridge/（纯判定叶子 + 薄 IO 壳）。
 *
 * 诚实边界（不装作能做到）：
 *   - medium 级调用会**阻塞等人在手机审批卡上放行**（上游 socket 600s，超时=
 *     拒绝）。所以 call/task 的结果可能是 approval_timeout——那是治理结果，
 *     不是设备故障，工具不会把它报成后者。
 *   - high 级还需要手机上有有效租约，没有就是 verdict deny（code=hiao_deny 或
 *     lease_missing）。
 *   - 没有配对令牌就什么都做不了：readToken 失败直接回 hiao_not_paired，一个
 *     请求都不发。
 *   - SSE /events、/sdcard 文件信箱、POST /mcp 三面本批未接（见单元 README）。
 *
 * 安全：写操作（info/status/agent_status 之外的任何工具调用、approve）默认只回
 * **计划**，必须 params.confirm===true 才真正发送；本工具**从不代替模型注入
 * confirm:true**。令牌是 R2 级机密：只在 client.readToken 出现一次，绝不进
 * 工具结果或日志。
 *
 * 门控：本 profile 刻意**不设 on/off 开关**（契约口径：配置键全在
 * serviceDefaults.js + env），能力由配对令牌结构性把关——没有令牌就是
 * hiao_not_paired，一个请求都不发。这意味着工具永远注册，但配对前每次调用都
 * 诚实报「未配对」而不是不可见。
 */
const { BaseTool } = require('../_baseTool');

const ACTIONS = ['ping', 'status', 'tools', 'call', 'approvals', 'approve', 'audit', 'task'];
const READONLY_ACTIONS = new Set(['ping', 'status', 'tools', 'approvals', 'audit']);

class HiaoBridgeTool extends BaseTool {
  static toolName = 'HiaoBridge';
  static category = 'system';
  static risk = 'high'; // 会改变用户手机的状态并经审批链；approval 层按此把关（叠加工具自身的 confirm 门）
  static aliases = ['hiao', 'hiao_bridge', 'phone_dsh'];
  static searchHint = 'drive hiao (phone-dsh), the governed agent bridge on the user\'s phone (ping/status/tools/call/task/approvals/approve/audit)';
  static shouldDefer = true;
  static maxResultSizeChars = 20000;

  isReadOnly() {
    return false;
  }

  isConcurrencySafe() {
    return false;
  }

  isDestructive(input) {
    const action = (input && input.action) || 'status';
    return !READONLY_ACTIONS.has(action);
  }

  prompt() {
    return `- Drive hiao (phone-dsh), the governed agent bridge on the user's OWN Android phone
- Use for: delegating a whole task to the on-phone agent, approval cards, the audit hash chain, governed tool calls. Not for PhoneBridge or this machine
- Governance: medium tools block awaiting human approval (600s ceiling, timeout = refusal); high tools need a lease or get deny
- Write calls need confirm:true; without it you get the plan and nothing is sent — never add confirm:true yourself
- approval_timeout/hiao_deny/lease_missing are refusals, not faults; device_fault/unreachable mean the link is broken`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description:
            'What to do. "ping"/"status"/"tools" are reads; "call" invokes one governed tool; "task" delegates a whole task to the phone agent; "approvals"/"approve" handle approval cards; "audit" reads the hash chain. Default "status".',
        },
        tool: {
          type: 'string',
          description:
            'For action "call": the hiao tool name (e.g. "ui_dump", "exec", "battery"). Use action "tools" to see what the phone reports.',
        },
        args: {
          type: 'object',
          description:
            'For action "call"/"task": the arguments object for that tool (e.g. {"path":"/sdcard"}). Default {}.',
        },
        prompt: {
          type: 'string',
          description: 'For action "task": the task text handed to the on-phone agent, in the user\'s own words.',
        },
        id: {
          type: 'string',
          description: 'For action "approve": the approval id from action "approvals".',
        },
        approve: {
          type: 'boolean',
          description: 'For action "approve": true approves, false rejects. Default true.',
        },
        answer: {
          type: 'string',
          description: 'For action "approve": optional answer text when the card is an ask_user question.',
        },
        n: {
          type: 'number',
          description: 'For action "audit": how many trailing hash-chain entries to read. Default 50.',
        },
        confirm: {
          type: 'boolean',
          description:
            'Must be true to actually send a WRITE call/approve. Without it only the plan is returned. Default false.',
        },
      },
      required: [],
    };
  }

  getActivityDescription(input) {
    const action = (input && input.action) || 'status';
    const tool = input && input.tool ? ` ${input.tool}` : '';
    return `hiao 手机桥:${action}${tool}`;
  }

  async execute(params, _context) {
    const action = (params && params.action) || 'status';
    if (!ACTIONS.includes(action)) {
      return { success: false, error: `未知 action：${action}。可用：${ACTIONS.join(' / ')}。` };
    }
    try {
      const bridge = require('../../services/domain/network/phone/hiaoBridge');
      const client = bridge.getHiaoBridgeClient(process.env);
      if (action === 'ping') {
        const res = await client.ping();
        return res.ok
          ? { success: true, action, channel: res.channel, version: res.version, body: res.body }
          : { success: false, error: res.error, code: res.code };
      }
      if (action === 'status') {
        const res = await client.status();
        return res.ok
          ? { success: true, action, channel: res.channel, hiao: res.status, state: client.getState() }
          : { success: false, error: res.error, code: res.code };
      }
      if (action === 'tools') {
        const res = await client.tools();
        return res.ok
          ? { success: true, action, channel: res.channel, count: res.count, names: res.names, note: res.note }
          : { success: false, error: res.error, code: res.code };
      }
      if (action === 'approvals') {
        const res = await client.approvals();
        return res.ok
          ? { success: true, action, channel: res.channel, approvals: res.approvals }
          : { success: false, error: res.error, code: res.code };
      }
      if (action === 'audit') {
        const res = await client.audit(params && params.n);
        return res.ok
          ? { success: true, action, channel: res.channel, audit: res.audit }
          : { success: false, error: res.error, code: res.code };
      }
      if (action === 'approve') {
        return this._approve(client, params);
      }
      if (action === 'task') {
        return this._task(client, params);
      }
      // action === 'call'
      return this._call(client, params);
    } catch (err) {
      return { success: false, error: (err && err.message) || String(err) };
    }
  }

  async _call(client, params) {
    const tool = params && params.tool;
    if (!tool) {
      return { success: false, error: 'action "call" 需要 tool（hiao 工具名）。先用 action "tools" 查看手机端工具表。' };
    }
    const res = await client.call(tool, (params && params.args) || {}, {
      confirm: params && params.confirm === true,
    });
    if (!res.success) {
      return {
        success: false,
        error: res.error,
        code: res.code,
        requiresConfirm: res.requiresConfirm === true,
        plan: res.plan,
        message: res.message,
      };
    }
    return {
      success: true,
      action: 'call',
      tool: res.tool,
      verdict: res.verdict,
      channel: res.channel,
      result: res.result,
    };
  }

  /**
   * Thin alias for the phone-side agent task. Async only (`wait:false`): a
   * synchronous delegate can block for 240s inside the approval chain, and the
   * caller can poll `agent_status` far more cheaply than holding a tool call.
   */
  async _task(client, params) {
    const promptText = String((params && params.prompt) || '').trim();
    if (!promptText) {
      return { success: false, error: 'action "task" 需要 prompt（要委托给手机端 agent 的任务）。' };
    }
    const args = { ...(params && params.args && typeof params.args === 'object' ? params.args : {}), prompt: promptText, wait: false };
    const res = await client.call('agent_task', args, { confirm: params && params.confirm === true });
    if (!res.success) {
      return {
        success: false,
        error: res.error,
        code: res.code,
        requiresConfirm: res.requiresConfirm === true,
        plan: res.plan,
        message: res.message,
      };
    }
    const body = res.result || {};
    return {
      success: true,
      action: 'task',
      accepted: body.accepted === true,
      taskId: body.taskId || null,
      verdict: res.verdict,
      hint: body.accepted === true
        ? '任务已在手机端受理。本工具不轮询；用 action "call" + tool "agent_status" 查进度。'
        : null,
    };
  }

  async _approve(client, params) {
    const res = await client.approve(
      params && params.id,
      !(params && params.approve === false),
      params && params.answer,
      { confirm: params && params.confirm === true }
    );
    if (!res.success) {
      return {
        success: false,
        error: res.error,
        code: res.code,
        requiresConfirm: res.requiresConfirm === true,
        plan: res.plan,
        message: res.message,
      };
    }
    return { success: true, action: 'approve', channel: res.channel, body: res.body };
  }
}

// No enable/disable export branch: this profile has no on/off switch (see the
// header). The structural gate is the pairing token, so the tool is always
// discoverable and answers hiao_not_paired until the phone is paired.
module.exports = new HiaoBridgeTool();
module.exports.HiaoBridgeTool = HiaoBridgeTool;
