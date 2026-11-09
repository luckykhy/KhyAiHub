/**
 * AmooBridgeTool — khy-os 与手机上 Amoo 的协作工具面（AI 可见）。
 *
 * 背景：Amoo 是阶跃手机上的智能体。两个方向都在 services/domain/network/amoo/：
 *   ① Amoo → khy-os：手机侧单文件客户端 amoo-khy-client.js（日常路径，不需要
 *      UI 自动化、不需要无障碍权限）；
 *   ② khy-os → Amoo：本工具的 send，在手机界面上输入、发送、轮询答复。
 * 本工具是方向 ② 的 AI 入口；方向 ① 的命令行面是 `khy amoo client`。
 *
 * 诚实边界（不装作能做到）：
 *   - 装的 StepBridge 是 lite 构建：没有无障碍服务、没有任何 UI 工具、不能截图。
 *     读屏与点击全部走 PC 侧 adb（uiautomator dump / input tap / keyevent）。
 *   - PC 驱动 Amoo 天生不能无人值守：Amoo 必须在前台，平台不允许助手打开侧载应用。
 *   - 没有 root、没有 shell 权限：exec 以桥应用自己的 UID 运行。
 *
 * 安全：send 会改变用户手机的状态并真的发出一条消息，因此默认只回**计划**，
 * 必须 params.confirm===true 才执行。令牌是 R2 级机密：只在 amooBridgeClient 的
 * readToken() 返回值里出现一次，永不进工具结果或日志，对外一律 maskToken()。
 *
 * 门控 KHY_AMOO_BRIDGE_ENABLED（默认开），单一真源是 amooBridgeConfig 的 gates——
 * 不另建一条 flagRegistry 记录，避免同一个开关两个真源。关 → 本模块导出 benign
 * 非工具对象，loadTools 跳过 → 工具不注册。
 */

const { BaseTool } = require('../_baseTool');

const ACTIONS = ['status', 'plan', 'send', 'client'];

function _gateEnabled(env = process.env) {
  try {
    const { resolveAmooConfig } = require('../../services/domain/network/amoo/amooBridgeConfig');
    return resolveAmooConfig(env).gates.enabled === true;
  } catch {
    const raw = env && env.KHY_AMOO_BRIDGE_ENABLED;
    if (raw === undefined || raw === null || raw === '') {
      return true;
    }
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

class AmooBridgeTool extends BaseTool {
  static toolName = 'AmooBridge';
  static category = 'system';
  static risk = 'high'; // 会在用户手机上输入并发送一条消息；approval 层按此把关
  static aliases = ['amoo', 'amoo_collab', '手机智能体'];
  static searchHint = 'collaborate with Amoo, the agent on the user\'s phone (status/plan/send/client)';
  static shouldDefer = true;
  static maxResultSizeChars = 20000;

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return false;
  }
  isDestructive(input) {
    return !!(input && input.action === 'send');
  }

  prompt() {
    return `- Collaborate with Amoo, the agent running on the user's OWN phone (StepX Android device), over adb
- Use for: reading whether the phone bridge and the Amoo chat screen are reachable, showing what a task dispatch WOULD do, sending a task to Amoo and reading its reply back, and handing the on-phone client script to Amoo
- action "status" is read-only; "plan" returns the dispatch plan without touching the phone; "send" actually types the task into Amoo's input box, taps send and polls for the reply
- action "send" needs a non-empty "task" and confirm:true. Without confirm:true you get the exact plan for the user to approve. Never pass confirm:true unless the user clearly asked to send that specific task to Amoo
- HONEST LIMIT: the installed StepBridge build is "lite" — no accessibility service, no UI tools, no screenshots. Screen reading and tapping go through PC-side adb, and driving Amoo can never be unattended (Amoo must be in the foreground)
- PREFER the other direction when the user wants Amoo to use khy-os: action "client" returns the on-phone client (amoo-khy-client.js) usage to hand to Amoo, which needs no UI automation at all
- If the bridge is dead, use the PhoneBridge tool's action "revive" first — the bridge does not restart on its own`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description:
            'What to do. "status" reads the collaboration chain; "plan" shows the dispatch plan without touching the phone; "send" dispatches a task to Amoo and reads the reply; "client" returns the on-phone client usage. Default "status".',
        },
        task: {
          type: 'string',
          description:
            'For action "plan"/"send": the task text to hand to Amoo, in the user\'s own words.',
        },
        confirm: {
          type: 'boolean',
          description:
            'Must be true to actually dispatch. Without it only the plan is returned.',
        },
      },
      required: [],
    };
  }

  getActivityDescription(input) {
    const action = (input && input.action) || 'status';
    return `Amoo 协作:${action}`;
  }

  async execute(params, _context) {
    const action = (params && params.action) || 'status';
    if (!ACTIONS.includes(action)) {
      return { success: false, error: `未知 action:${action}` };
    }
    try {
      const stack = require('../../services/domain/network/amoo');
      if (action === 'status') {
        const status = await stack.runner.collectStatus();
        return status.ok
          ? { success: true, action, status }
          : { success: false, error: status.summary || '协作链未打通', code: 'chain_incomplete', status };
      }
      if (action === 'client') {
        return this._client();
      }
      const taskText = typeof (params && params.task) === 'string' ? params.task.trim() : '';
      if (!taskText) {
        return {
          success: false,
          error: `action "${action}" 需要 task（要交给 Amoo 的任务文本）。`,
        };
      }
      const res = await stack.runner.dispatchTask({
        taskText,
        confirm: action === 'send' && params && params.confirm === true,
      });
      if (res.ok === false) {
        return {
          success: false,
          error: res.message || '下发失败',
          code: res.code,
          requiresConfirm: res.code === 'confirm_required',
          planText: res.planText,
        };
      }
      return {
        success: true,
        action,
        channel: res.channel,
        inputRoute: res.inputRoute,
        reply: res.reply,
        poll: res.poll,
        steps: res.steps,
      };
    } catch (err) {
      return { success: false, error: (err && err.message) || String(err) };
    }
  }

  /**
   * 把手机侧客户端的用法交给模型，让它能原样转告 Amoo。只读：不连手机、不发消息。
   * @returns {{success:boolean, action:string, version:string, usage:string}}
   */
  _client() {
    const mod = require('../../services/domain/network/amoo/client/amooKhyClient');
    return {
      success: true,
      action: 'client',
      version: mod.CLIENT_VERSION,
      usage: mod.USAGE,
      note: '这是跑在手机上的单文件零依赖客户端（Node 22+）。让 Amoo 用它来调 khy-os，'
        + '这条路不需要无障碍权限、不需要 UI 自动化。',
    };
  }
}

if (!_gateEnabled(process.env)) {
  module.exports = { _khyAmooBridgeDisabled: true };
} else {
  module.exports = new AmooBridgeTool();
  module.exports.AmooBridgeTool = AmooBridgeTool;
}
