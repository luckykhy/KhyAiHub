/**
 * PhoneBridgeTool — 调用手机上 StepBridge 的桥接工具面（khy-os → 手机，OUTBOUND）。
 *
 * 背景：要把 khy-os 和手机上的 Amoo 接起来。手机侧跑的是 StepBridge
 * （现居 khy-os 手机端 com.khyos.khy_os_client），HTTP 监听 8896，另有一条 /sdcard/bridge-amoobridge
 * 文件信箱兜底。本工具是 AI 唯一可见的手机入口，底下全部逻辑在
 * services/domain/network/phone/（纯判定 + 薄 IO 壳 + 信箱兜底）。
 *
 * 能做什么（诚实边界）：
 *   - ping / status   探活与读桥状态（含 ui 能力真伪）
 *   - probe           读 status.json 心跳，用来区分「服务死了」与「HTTP 端口死了」
 *   - call <tool>     调桥工具（条数即 phoneBridgeCatalog.BRIDGE_TOOLS 的长度，
 *                     当前 32 个）；UI 类工具（ui_dump/ui_tap/shot/…）会
 *                     被明确拒绝并说明原因，而不是报 unknown tool
 *   - revive          桥服务被杀后用启动器事件把它拉回来
 *   - setup           列出装机后需要授权的四项及其 argv（只列不执行）
 *
 * 当前 APK 是 lite 构建：没有无障碍服务、没有任何 UI 工具、不能截图。
 * 所以「操作 Amoo 界面」这条路现在走不通——工具会在 prompt 里说清这件事，
 * 不装作能做。
 *
 * 安全：写操作（exec/write/rm/mv/cp/start_app/open_url/share_text/clipboard set/
 * toast/notify/volume set/brightness set/vibrate/mkdir）默认只回**计划**，
 * 必须 params.confirm===true 才真正执行。token 是 R2 级机密：运行时从手机读、
 * 内存缓存、绝不进返回值或日志。
 *
 * 门控 KHY_PHONE_BRIDGE_TOOL（父 KHY_PHONE_BRIDGE，经 flagRegistry 声明式注册）。
 * 关 → 本模块导出 benign 非工具对象，自动发现跳过 → 工具不注册。
 */
const { BaseTool } = require('../_baseTool');

function _gateEnabled(env = process.env) {
  try {
    return require('../../services/flagRegistry').isFlagEnabled('KHY_PHONE_BRIDGE_TOOL', env);
  } catch {
    const raw = env && env.KHY_PHONE_BRIDGE_TOOL;
    if (raw === undefined || raw === null) {
      return true;
    }
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

const ACTIONS = ['ping', 'status', 'probe', 'call', 'revive', 'setup', 'tools'];
const READONLY_ACTIONS = new Set(['ping', 'status', 'probe', 'tools']);

class PhoneBridgeTool extends BaseTool {
  static toolName = 'PhoneBridge';
  static category = 'system';
  static risk = 'high'; // 会改变用户手机的状态；approval 层按此把关（叠加工具自身的 confirm 门）
  static aliases = ['phone_bridge', 'phone', 'stepbridge', 'amoons_bridge'];
  static searchHint = 'call the StepBridge HTTP API on the user\'s phone (ping/status/call/probe/revive/setup)';
  static shouldDefer = true;
  static maxResultSizeChars = 20000;

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return false;
  }
  isDestructive(input) {
    const action = input && input.action;
    return action === 'revive' || (action === 'call' && !this._isReadonlyBridgeTool(input && input.tool));
  }

  prompt() {
    return `- Drive the StepBridge service on the user's OWN phone (Android, StepX device) over adb: ping, status, probe, call, revive, setup
- Use for: checking whether the phone bridge is alive, reading phone battery/volume/brightness, listing or moving files under /sdcard, launching an app, sending a toast/notification, running a shell command as the app's own UID
- Do NOT use for: anything on THIS machine (use DeviceApps / DesktopControl), or reaching a public URL (use WebFetch)
- action "call" needs a bridge tool name in "tool" (e.g. exec, ls, read, battery, volume, start_app). Use action "tools" to list the available names and their argument schemas first
- WRITE calls (exec, write, rm, mv, cp, mkdir, start_app, open_url, share_text, toast, notify, vibrate, and clipboard/volume/brightness when they SET a value) DO NOT run unless you pass confirm:true. Without it you get the exact plan for the user to approve. Never pass confirm:true unless the user clearly asked for that specific action
- HONEST LIMIT: the installed build is "lite" — it has no accessibility service and no UI tools at all, so ui_dump/ui_tap/ui_swipe/shot and any screen automation are unavailable and will be refused with a reason. Driving the Amoo app's UI is not possible with this build
- No root and no shell privileges: input, screencap, dumpsys, su and pm all fail. exec runs as the app's own UID
- If the bridge is dead, action "revive" is the only way back — it does not restart on its own`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description:
            'What to do. "ping"/"status"/"probe" are liveness checks; "call" invokes a bridge tool; "revive" restarts the bridge service; "setup" lists the post-install grants; "tools" lists the bridge tool catalog. Default "status".',
        },
        tool: {
          type: 'string',
          description:
            'For action "call": the bridge tool name, without the phone_ prefix (e.g. "exec", "ls", "battery", "start_app"). Use action "tools" to discover names.',
        },
        args: {
          type: 'object',
          description:
            'For action "call": the arguments object for that bridge tool (e.g. {"cmd":"getprop ro.product.model"} or {"path":"/sdcard"}).',
        },
        confirm: {
          type: 'boolean',
          description:
            'Must be true to actually run a WRITE bridge call. Without it only the plan is returned.',
        },
      },
      required: [],
    };
  }

  getActivityDescription(input) {
    const action = (input && input.action) || 'status';
    const tool = input && input.tool ? ` ${input.tool}` : '';
    return `手机桥接:${action}${tool}`;
  }

  _isReadonlyBridgeTool(toolName) {
    if (!toolName) {
      return false;
    }
    const { findPhoneBridgeTool, getPhoneBridgeToolAccess, ACCESS_READ } = require('../../services/domain/network/phone');
    const hit = findPhoneBridgeTool(toolName);
    if (!hit) {
      return false;
    }
    return getPhoneBridgeToolAccess(hit.bridgeName) === ACCESS_READ;
  }

  async execute(params, _context) {
    const action = (params && params.action) || 'status';
    if (!ACTIONS.includes(action)) {
      return { success: false, error: `未知 action:${action}` };
    }
    try {
      const bridge = require('../../services/domain/network/phone');
      if (action === 'tools') {
        return this._listTools(bridge);
      }
      if (action === 'setup') {
        return this._setup(bridge);
      }
      const client = bridge.getPhoneBridgeClient(process.env);
      if (action === 'ping') {
        const res = await client.ping();
        return res.ok
          ? { success: true, action, channel: res.channel, body: res.body }
          : { success: false, error: res.error, code: res.code };
      }
      if (action === 'probe') {
        const res = await client.probe();
        return res.ok
          ? {
            success: true,
            action,
            channel: res.channel,
            httpPortBound: res.httpPortBound,
            canWrite: res.canWrite,
            uiAvailable: res.uiAvailable,
            status: res.status,
            hint: res.httpPortBound
              ? null
              : 'HTTP 端口未绑定：桥进程可能活着但端口被占用，用 action "revive" 重启后重试。',
          }
          : { success: false, error: res.error, code: res.code };
      }
      if (action === 'revive') {
        const res = await client.revive();
        return res.ok
          ? { success: true, action, message: res.message }
          : { success: false, error: res.error, code: res.code };
      }
      if (action === 'status') {
        const res = await client.status();
        return res.ok
          ? { success: true, action, channel: res.channel, bridge: res.status, state: client.getState() }
          : { success: false, error: res.error, code: res.code };
      }
      // action === 'call'
      const toolName = params && params.tool;
      if (!toolName) {
        return { success: false, error: 'action "call" 需要 tool（桥工具名）。先用 action "tools" 列出可用工具。' };
      }
      const res = await client.call(toolName, (params && params.args) || {}, {
        confirm: params && params.confirm === true,
      });
      if (!res.success) {
        return {
          success: false,
          error: res.error,
          code: res.code,
          requiresConfirm: res.requiresConfirm === true,
          plan: res.plan,
          warning: res.warning,
          requiresAccessibility: res.requiresAccessibility === true,
          detail: res.detail,
        };
      }
      return {
        success: true,
        action,
        tool: res.tool,
        channel: res.channel,
        truncated: res.truncated === true,
        result: res,
      };
    } catch (err) {
      return { success: false, error: (err && err.message) || String(err) };
    }
  }

  _listTools(bridge) {
    const defs = bridge.listKhyToolDefinitions();
    return {
      success: true,
      action: 'tools',
      count: defs.length,
      tools: defs.map((def) => ({
        name: def.name,
        bridgeName: def.bridgeName,
        aliases: def.aliases,
        risk: def.risk,
        requiresAccessibility: def.requiresAccessibility,
        description: def.description,
        inputSchema: def.inputSchema,
      })),
      unavailableUiTools: bridge.getPhoneBridgeUiTools(),
      unavailableUiReason: bridge.ACCESSIBILITY_GAP_REASON,
    };
  }

  _setup(bridge) {
    const grants = bridge.listGrants();
    return {
      success: true,
      action: 'setup',
      note: '以下授权需在手机上完成。lite 构建的无无障碍服务一项不适用（该 APK 未声明无障碍服务）。',
      grants: grants.map((grant) => ({
        id: grant.id,
        label: grant.label,
        required: grant.required,
        applicableToLiteBuild: grant.applicableToLiteBuild,
        adbArgv: ['shell', ...grant.argv],
        verifyArgv: ['shell', ...grant.verifyArgv],
        expectIncludes: grant.expectIncludes,
        why: grant.why,
      })),
    };
  }
}

if (!_gateEnabled(process.env)) {
  module.exports = { _khyPhoneBridgeDisabled: true };
} else {
  module.exports = new PhoneBridgeTool();
  module.exports.PhoneBridgeTool = PhoneBridgeTool;
}
