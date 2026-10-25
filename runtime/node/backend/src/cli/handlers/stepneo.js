'use strict';

/**
 * stepneo.js — `khy stepneo` 命令薄壳：跑一轮「云端模型 + 手机工具」的智能体回合。
 *
 * 背后逻辑全在 services/domain/network/stepneoCloud/：签名与失败映射在 signing.js /
 * upstream.js，工具 schema 转换在 toolSchemas.js，循环在 agentLoop.js，env 解析在
 * config.js。本文件只做四件事：门控、解析、委托、交给 formatters 打印。
 * 绝不在这里写 host/密钥/路径字面量——它们全部来自 resolveStepneoConfig。
 *
 * 用法（完整列表见 `khy stepneo help`）：
 *   khy stepneo                      读配置与凭据状态（不联网、不读手机）
 *   khy stepneo ask <提示>           跑一轮工具调用循环
 *   khy stepneo token                现场从手机取一次账号 token（只读）
 *   khy stepneo tools                列出交给模型的工具 schema
 *
 * 与 `khy phone`（直接调桥）是不同层次：那条是「我来决定调哪个工具」，
 * 这条是「让模型自己决定调哪些工具」。两者共用同一个桥客户端和同一套确认门。
 *
 * 门控 STEPNEO_ENABLED（默认开）。关 → 命令仍接管并说明原因，不静默落到
 * 路由器的「未知命令」分支——那样用户只会看到一句未知命令，不知道该去哪开。
 */

const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const { printError, printInfo, printSuccess, printWarn } = require('../formatters');

const ACTIONS = ['status', 'ask', 'token', 'tools', 'help'];

/** 读闸门。单一真源是 stepneoCloud/config 的 resolveStepneoConfig。 */
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

function _facade() {
  return require('../../services/domain/network/stepneoCloud');
}

function _printStatus(gw, config) {
  const secret = gw.readAppSecret(config);
  printInfo(`网关      ${config.baseUrl}`);
  printInfo(`appId     ${config.appId}`);
  printInfo(`轮数上限  ${config.maxRounds}`);
  printInfo(`UI 工具   ${config.includeUi ? '广告（桥可能因无障碍未开而拒绝）' : '不广告'}`);
  printInfo(`设备      ${config.serial || '(自动探测)'}  adb=${config.adbExecutable}`);
  if (secret.ok) {
    printSuccess(`签名密钥  已配置（${secret.source}）`);
  } else {
    printWarn(`签名密钥  未配置 —— ${secret.code}`);
    printInfo('          设 STEPNEO_APP_SECRET，或写进文件后设 STEPNEO_APP_SECRET_FILE 指向它。');
  }
  if (config.token) {
    printSuccess('账号 token  已由 STEPNEO_TOKEN 预置');
  } else {
    printInfo('账号 token  未预置，ask 时会现场从手机账号日志取（只读）');
  }
  return 0;
}

async function handleStepneo(subCommand, args = [], options = {}) {
  if (!_gateEnabled(process.env)) {
    printError('stepneo 已关闭。设 STEPNEO_ENABLED=1 打开。');
    return 1;
  }

  const gw = _facade();
  const config = gw.resolveStepneoConfig(process.env);
  const action = subCommand || 'status';

  if (action === 'help') {
    printInfo('khy stepneo [status|ask <提示>|token|tools|help]');
    printInfo('  status  读配置与凭据状态（不联网、不读手机）');
    printInfo('  ask     跑一轮「云端模型 + 手机工具」的智能体回合');
    printInfo('  token   现场从手机账号服务日志取一次 token（只读，不返回值）');
    printInfo('  tools   列出交给模型的工具 schema');
    return 0;
  }

  if (!ACTIONS.includes(action)) {
    printError(`未知子命令:${action}。可用：${ACTIONS.join(' / ')}`);
    return 1;
  }

  if (action === 'status') {
    return _printStatus(gw, config);
  }

  if (action === 'tools') {
    const schemas = gw.buildToolSchemas({ includeUi: config.includeUi });
    printInfo(`交给模型 ${schemas.length} 个工具：`);
    for (const s of schemas) {
      printInfo(`  ${s.function.name}`);
    }
    return 0;
  }

  if (action === 'token') {
    const res = await gw.readAccountTokenFromDevice({
      serial: config.serial || undefined,
      adbExecutable: config.adbExecutable,
    });
    if (!res.ok) {
      printError(`${res.code}: ${res.error}`);
      return 1;
    }
    printSuccess(`已取到 token（来源 ${res.sourcePackage}，观测于 ${res.observedAt}）`);
    const age = res.ageHours === null ? '未知' : `${Math.round(res.ageHours * 10) / 10} 小时`;
    printInfo(`签发距今 ${age}。token 没有 exp 字段，有效期只能靠真实请求判断。`);
    printInfo('token 仅存于本次进程内存，不打印、不落盘。');
    return 0;
  }

  // action === 'ask'
  const promptText = (args || []).join(' ').trim();
  if (!promptText) {
    printError('ask 需要提示词：khy stepneo ask <提示>');
    return 1;
  }

  const secret = gw.readAppSecret(config);
  if (!secret.ok) {
    printError(`${secret.code}: ${secret.error}`);
    return 1;
  }

  const bridge = require('../../services/domain/network/phone').getPhoneBridgeClient(process.env);

  let token = config.token;
  let deviceId = '';
  if (token) {
    const decoded = gw.decodeToken(token);
    if (!decoded || !decoded.deviceId) {
      printError('TOKEN_UNDECODABLE: STEPNEO_TOKEN 不是可解码的自描述 JSON。');
      return 1;
    }
    deviceId = decoded.deviceId;
  } else {
    printInfo('未预置 token，正在从手机账号日志取（只读）…');
    const acct = await gw.readAccountTokenFromDevice({
      serial: config.serial || undefined,
      adbExecutable: config.adbExecutable,
    });
    if (!acct.ok) {
      printError(`${acct.code}: ${acct.error}`);
      return 1;
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
    onProgress: (line) => printInfo(`  … ${line}`),
    includeUi: config.includeUi,
  });

  // Per-call outcomes, not just a count. A turn that reports "6 calls, 0
  // succeeded" is indistinguishable between a dead bridge, rejected args and a
  // confirm-gate refusal — and those need three different responses.
  for (const c of out.toolCalls || []) {
    if (c.ok) {
      printSuccess(`  ✓ ${c.name}`);
    } else {
      printWarn(`  ✗ ${c.name}${c.code ? ` [${c.code}]` : ''} — ${c.why || '未说明'}`);
      if (c.requiresConfirm) {
        printInfo('      这是确认门拒的：模型没有显式传 confirm:true，桥就不执行。');
      }
    }
  }

  if (!out.ok) {
    printError(`${out.stopped === 'max_rounds' ? 'max_rounds' : 'turn_failed'}: ${out.error}`);
    printInfo(`轮数 ${out.rounds}，工具调用 ${out.toolCalls.length} 次。`);
    return 1;
  }

  printSuccess(out.message.content || '(无正文)');
  const okCalls = out.toolCalls.filter((c) => c.ok).length;
  printInfo(`轮数 ${out.rounds}，工具调用 ${out.toolCalls.length} 次（成功 ${okCalls}）。`);
  return 0;
}

module.exports = {
  handleStepneo,
  [MANIFEST_EXPORT_KEY]: {
    name: 'stepneo',
    aliases: ['云端手机智能体'],
    description: '跑一轮「云端模型 + 手机工具」的智能体回合（状态/提问/取 token/工具表）',
    usage: 'stepneo [status|ask <提示>|token|tools|help]',
    subCommands: ACTIONS,
    category: 'system',
    handler: async (parsed) => handleStepneo(parsed.subCommand, parsed.args, parsed.options),
  },
};
