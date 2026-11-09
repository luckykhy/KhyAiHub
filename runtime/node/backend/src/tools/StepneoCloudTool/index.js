/**
 * StepneoCloudTool — 让模型用上手机：云端推理 + 手机桥的设备工具（AI 可见）。
 *
 * 背景：要把「AI 能在用户手机上做事」接起来。手机侧原本的反代是 AmooLoop——
 * 它通过无障碍服务 scraping Amoo 的聊天气泡，实测单轮约 6 分钟、需要 App 前台、
 * 退后台就被 StepOS 冻结。本工具换一条路：推理走 StepOS 云端网关
 * （biz-gw.stepaos.com，step-5-preview），执行仍走手机桥，工具调用就是工具调用，
 * 不读屏、不要前台、没有分钟级延迟。
 *
 * 能做什么：
 *   - ask <提示>   跑一轮完整的工具调用循环，返回最终答复
 *   - status       读配置与凭据状态（不联网、不读手机）
 *   - token        现场从手机账号服务日志取一次 token（只读）
 *   - tools        列出交给模型的工具 schema
 *
 * 诚实边界（不装作能做到）：
 *   - 没有应用签名密钥就跑不了：密钥只从 STEPNEO_APP_SECRET / _FILE 读，
 *     缺了直接报错并说清去哪配，不用默认值糊一个 401 出来。
 *   - token 没有 exp 字段，客户端看不到服务端有效期，只能观测；
 *     实测一份约 19.7 小时、另一份 47 小时仍可用。401 时会同时点名
 *     「密钥不对」和「token 过期」两个相反方向的原因。
 *   - HTTP 200 但正文为空算失败：模型先思考后产出正文，max_tokens 太小会在
 *     思考阶段用尽。
 *   - UI 工具（ui_dump/ui_tap/shot/…）需要无障碍服务；没开时桥会拒绝，
 *     工具会把这件事说清，而不是报 unknown tool。
 *
 * 安全：所有设备调用都经 phoneBridgeClient.call()，由桥做判定——
 * 会改变手机状态的工具没有 confirm:true 就拒绝执行。本工具**从不代替模型
 * 注入 confirm:true**，`ask` 也不接受 confirm 参数（没有它可传的东西）。
 * 轮数有上限（STEPNEO_MAX_ROUNDS，默认 24），撞上限报 max_rounds 而不是伪装成功。
 *
 * 门控 STEPNEO_ENABLED（默认开）。关 → 本模块导出 benign 非工具对象，
 * 自动发现跳过 → 工具不注册。
 */
const { BaseTool } = require('../_baseTool');

const ACTIONS = ['ask', 'status', 'token', 'tools'];
const READONLY_ACTIONS = new Set(['status', 'tools']);

function _gateEnabled(env = process.env) {
  try {
    return require('../../services/domain/network/stepneoCloud').resolveStepneoConfig(env).enabled === true;
  } catch {
    const raw = env && env.STEPNEO_ENABLED;
    if (raw === undefined || raw === null || raw === '') {
      return true;
    }
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

class StepneoCloudTool extends BaseTool {
  static toolName = 'StepneoCloud';
  static category = 'system';
  static risk = 'high'; // 会驱动用户手机执行命令；approval 层按此把关（叠加桥自身的 confirm 门）
  static aliases = ['stepneo', 'stepneo_cloud', '云端手机智能体'];
  static searchHint = 'run an agent turn whose model is the StepOS cloud gateway and whose tools act on the user\'s phone (ask/status/token/tools)';
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
    if (READONLY_ACTIONS.has(action)) {
      return false;
    }
    // `ask` can reach write/exec/rm through the bridge, so it is destructive by
    // default. The bridge's own confirm gate is what actually stops a specific
    // call; this flag only tells the approval layer to pay attention.
    return true;
  }

  prompt() {
    return `- Run an agent turn: the model is the StepOS cloud gateway (step-5-preview) and the tools act on the user's OWN phone via the phone bridge (ask/status/token/tools)
- Use for: asking the on-phone agent to do something that needs both reasoning and device access — list files, run a shell command as the phone's shell UID, write a file, launch an app, read the screen (if the accessibility service is up)
- Do NOT use for: talking to Amoo the way a human would (use AmooBridge), or anything on THIS machine (use DeviceApps / DesktopControl)
- action "ask" takes "prompt" and runs a full tool-calling loop; the final answer is returned as "reply"
- Every device call goes through the bridge's own confirm gate: a tool that changes phone state is REFUSED unless the model passes confirm:true, and this tool never passes it for the model. If the model wants to actuate the phone it has to ask, and the refusal is what it reads
- Round cap is STEPNEO_MAX_ROUNDS (default 24). Hitting it returns stopped="max_rounds" with the partial work intact — that is not a failure, it is an unfinished turn
- Requires STEPNEO_APP_SECRET (or STEPNEO_APP_SECRET_FILE). Without it the tool refuses and names the variable, rather than returning a 401 that looks like an expired token
- The account token has no expiry field; a 401 names both possible causes (wrong signing key vs expired token) so you can tell which to fix
- HTTP 200 with an empty body IS a failure: the model emits reasoning before content, so max_tokens must be 128+`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description:
            'What to do. "ask" runs an agent turn; "status" reads config and credential state (no network, no phone); "token" fetches a fresh account token from the phone (read-only); "tools" lists the tool schemas handed to the model. Default "status".',
        },
        prompt: {
          type: 'string',
          description: 'For action "ask": the task for the agent. Be specific about paths and the done condition.',
        },
        includeUi: {
          type: 'boolean',
          description:
            'For action "ask": whether to advertise the UI tools (ui_dump/ui_tap/shot/...). They need the accessibility service; if it is off the bridge refuses them. Default true, so the model learns that from a real refusal instead of guessing the capability is absent.',
        },
      },
      required: [],
    };
  }

  getActivityDescription(input) {
    const action = (input && input.action) || 'status';
    return `云端手机智能体:${action}`;
  }

  async execute(params, _context) {
    const action = (params && params.action) || 'status';
    if (!ACTIONS.includes(action)) {
      return { success: false, error: `未知 action:${action}` };
    }

    const gw = require('../../services/domain/network/stepneoCloud');
    const config = gw.resolveStepneoConfig(process.env);

    if (action === 'status') {
      return this._status(gw, config);
    }
    if (action === 'tools') {
      const schemas = gw.buildToolSchemas({ includeUi: config.includeUi });
      return {
        success: true,
        action,
        count: schemas.length,
        tools: schemas.map((s) => ({
          name: s.function.name,
          description: s.function.description,
          inputSchema: s.function.parameters,
        })),
      };
    }

    if (action === 'token') {
      return this._token(gw, config);
    }

    // action === 'ask'
    const promptText = (params && params.prompt || '').trim();
    if (!promptText) {
      return { success: false, error: 'action "ask" 需要 prompt。' };
    }
    return this._ask(gw, config, promptText, params);
  }

  _status(gw, config) {
    const secret = gw.readAppSecret(config);
    return {
      success: true,
      action: 'status',
      enabled: config.enabled,
      gateway: { baseUrl: config.baseUrl, appId: config.appId },
      maxRounds: config.maxRounds,
      includeUi: config.includeUi,
      device: { serial: config.serial || '(自动探测)', adbExecutable: config.adbExecutable },
      credentials: {
        appSecret: secret.ok ? { present: true, source: secret.source } : { present: false, code: secret.code },
        token: config.token ? { present: true, source: 'env:STEPNEO_TOKEN' } : { present: false, note: '未预置；ask 时会现场从手机取' },
      },
      hint: secret.ok
        ? null
        : '配好 STEPNEO_APP_SECRET 才能跑 ask。status/tools 不依赖它。',
    };
  }

  async _token(gw, config) {
    const res = await gw.readAccountTokenFromDevice({
      serial: config.serial || undefined,
      adbExecutable: config.adbExecutable,
    });
    if (!res.ok) {
      return { success: false, error: res.error, code: res.code };
    }
    // The token itself is deliberately NOT returned. It is an R2-class secret;
    // the caller gets enough to know the fetch worked and how old it is.
    return {
      success: true,
      action: 'token',
      sourcePackage: res.sourcePackage,
      observedAt: res.observedAt,
      ageHours: res.ageHours === null ? null : Math.round(res.ageHours * 10) / 10,
      deviceIdPresent: true,
      note: 'token 已取到并仅存于本次进程内存，不随工具结果返回。它没有 exp 字段，'
        + '有效期只能靠真实请求判断；实测约 20–48 小时。',
    };
  }

  async _ask(gw, config, promptText, params) {
    const secret = gw.readAppSecret(config);
    if (!secret.ok) {
      return { success: false, error: secret.error, code: secret.code };
    }

    const bridge = require('../../services/domain/network/phone').getPhoneBridgeClient(process.env);

    // Token: use the one from env if supplied, otherwise fetch it off the phone.
    // Either way it stays in this scope and is never written to a result.
    let token = config.token;
    let deviceId = '';
    if (token) {
      const decoded = gw.decodeToken(token);
      if (!decoded || !decoded.deviceId) {
        return { success: false, code: 'TOKEN_UNDECODABLE', error: 'STEPNEO_TOKEN 不是可解码的自描述 JSON。' };
      }
      deviceId = decoded.deviceId;
    } else {
      const acct = await gw.readAccountTokenFromDevice({
        serial: config.serial || undefined,
        adbExecutable: config.adbExecutable,
      });
      if (!acct.ok) {
        return { success: false, error: acct.error, code: acct.code };
      }
      token = acct.token;
      deviceId = acct.deviceId;
    }

    const session = gw.createStepneoSession({
      token,
      deviceId,
      appSecret: secret.secret,
      bridge,
      maxRounds: config.maxRounds,
    });

    const messages = [{ role: 'user', content: promptText }];
    const out = await session.run(messages, {
      includeUi: params && params.includeUi !== undefined ? params.includeUi === true : config.includeUi,
    });

    if (!out.ok) {
      return {
        success: false,
        error: out.error,
        code: out.stopped === 'max_rounds' ? 'max_rounds' : 'turn_failed',
        stopped: out.stopped,
        rounds: out.rounds,
        toolCalls: out.toolCalls,
      };
    }

    return {
      success: true,
      action: 'ask',
      reply: out.message.content || '',
      finishReason: out.finishReason,
      rounds: out.rounds,
      toolCalls: out.toolCalls,
      // Surfaced so a caller can tell "the model answered" from "the model
      // answered and actually did something".
      actuated: out.toolCalls.filter((c) => c.ok).length,
      // Per-call outcomes. Without them a refused actuation is indistinguishable
      // from a dead bridge, and the caller cannot tell what to fix.
      callLog: out.toolCalls.map((c) => ({
        tool: c.name,
        ok: c.ok,
        code: c.code || null,
        why: c.why || null,
        requiresConfirm: c.requiresConfirm === true,
      })),
    };
  }
}

if (!_gateEnabled(process.env)) {
  module.exports = { _khyStepneoDisabled: true };
} else {
  module.exports = new StepneoCloudTool();
  module.exports.StepneoCloudTool = StepneoCloudTool;
}
