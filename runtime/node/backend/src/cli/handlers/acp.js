'use strict';

/**
 * handlers/acp.js — `khy acp serve`：khy 作为编辑器 ACP 智能体被拉起（面 A，[DESIGN-ARCH-184]）。
 *
 * 门控 KHY_ACPCLIENT_SERVE（独立总闸，默认关）：仿 KHY_MCP_SERVE 先例。stdio 分支进入
 * 常驻循环后 stdout 专供 JSON-RPC（协议 MUST），门控/参数报错都在进入循环**之前**。
 *
 *   khy acp serve
 *
 * Zed 接入（建议式配置，不静默改写——terminalSetupPlan 先例口径）：
 *   { "agent": { "custom_servers": { "khy-os": { "command": "khy", "args": ["acp", "serve"] } } } }
 */

const GATE_ENV = 'KHY_ACPCLIENT_SERVE';
const OFF_TOKENS = new Set(['0', 'false', 'off', 'no']);

/**
 * serve 门控（默认关；显式 0/false/off/no 关闭）。
 * @param {object} [env]
 * @returns {boolean}
 */
function isServeEnabled(env = process.env) {
  const raw = env[GATE_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return false;
  }
  return !OFF_TOKENS.has(String(raw).trim().toLowerCase());
}

/**
 * @param {{subCommand?: string, args?: string[], options?: object}} parsed - parseInput 产物
 * @returns {number} 进程退出码（stdio 常驻 → 0 直到 stdin 关闭）
 */
async function handleAcp(parsed) {
  const subCommand = String((parsed && parsed.subCommand) || '').toLowerCase();
  if (subCommand !== 'serve') {
    // eslint-disable-next-line global-require
    const { printError } = require('../formatters');
    printError(
      `用法: khy acp serve（当前子命令${subCommand ? ` "${subCommand}"` : '（空）'}不支持）。` +
        'serve 把 khy 作为编辑器 ACP 智能体经 stdio 暴露给 Zed/JetBrains。'
    );
    // eslint-disable-next-line global-require
    require('../../utils/markProcessFailure')();
    return 1;
  }

  // eslint-disable-next-line global-require
  const { printError } = require('../formatters');
  if (!isServeEnabled(process.env)) {
    printError(
      `\`khy acp serve\` 未启用（${GATE_ENV} 默认关闭）。` +
        `设置 ${GATE_ENV}=1 后重试；Zed 侧在 settings.json 的 agent.custom_servers 登记 {"command":"khy","args":["acp","serve"]}。`
    );
    // eslint-disable-next-line global-require
    require('../../utils/markProcessFailure')();
    return 1;
  }

  let version = '0.0.0';
  try {
    // eslint-disable-next-line global-require
    version = require('../../../package.json').version || version;
  } catch {
    /* 读不到 → 兜底 */
  }

  // 缺省 stdio：进入常驻循环，stdout 专供 ACP 消息，诊断全走 stderr。
  // eslint-disable-next-line global-require
  const { startAgentServer } = require('../../services/domain/messaging/agentclient/agentServer.js');
  startAgentServer({ version });
  return 0;
}

module.exports = {
  handleAcp,
  isServeEnabled,
  // 自注册 manifest：commandAutoRegistry 在 route() 的硬编码 switch 之前分派，
  // 无需改 router.js；别名随 manifest 进别名表。
  [require('../commandManifest').MANIFEST_EXPORT_KEY]: {
    name: 'acp',
    aliases: ['编辑器acp', 'bianjiqiacp'],
    description: '编辑器 ACP（Agent Client Protocol）：khy 作为智能体接入 Zed/JetBrains（[DESIGN-ARCH-184]）',
    usage: 'acp serve',
    subCommands: ['serve'],
    category: 'ai',
    handler: async (parsed, _ctx) => handleAcp(parsed || {}),
  },
};
