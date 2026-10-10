'use strict';

const FIXTURES = Object.freeze({
  // 外部 ACP 智能体（[DESIGN-ARCH-184] §4.2）。真跑要 KHY_ACPCLIENT_AGENTS 指到一台
  // 在位的智能体，夹具里连会话都由 acpAgentInvocation 的模块替身承担，故 transports 为空。
  'acpAgentAdapter.js': { family: 'acp-agent', transports: [], markers: ['acpAgentInvocation', 'buildSuccess('] },
  'apiAdapter.js': { family: 'relay', transports: [], markers: ['svc.generateResponse('] },
  'claudeAdapter.js': { family: 'http-sse', transports: ['fetch', 'http'], markers: ['buildSuccess('] },
  'cliToolAdapter.js': { family: 'cli', transports: ['subprocess'], markers: ['buildSuccess('] },
  'clipboardRelayAdapter.js': { family: 'clipboard', transports: ['subprocess'], markers: ['buildSuccess('] },
  'codexAdapter.js': { family: 'cli', transports: ['subprocess'], markers: ['buildSuccess('] },
  // Thin shell over cliToolAdapter (targets the `commandcode` CLI via
  // `cliTool: 'commandcode'`), same shape as openclawAdapter/opencodeAdapter —
  // hence the same family/transport/marker recipe.
  'commandCodeAdapter.js': { family: 'cli-wrapper', transports: ['subprocess'], markers: ['cliToolAdapter.generate('] },
  'cursor2apiAdapter.js': { family: 'http-sse', transports: ['http'], markers: ['buildSuccess('] },
  'cursorAdapter.js': { family: 'ide-bridge', transports: ['https'], markers: ['buildSuccess('] },
  'kiroAdapter.js': { family: 'ide-bridge', transports: ['https'], markers: ['buildSuccess('] },
  'localLLMAdapter.js': { family: 'local-model', transports: [], markers: ['buildSuccess('] },
  'ollamaAdapter.js': { family: 'ollama', transports: ['http'], markers: ['buildSuccess('] },
  'openclawAdapter.js': { family: 'cli-wrapper', transports: ['subprocess'], markers: ['cliToolAdapter.generate('] },
  'opencodeAdapter.js': { family: 'cli-wrapper', transports: ['subprocess'], markers: ['cliToolAdapter.generate('] },
  'relayApiAdapter.js': { family: 'relay', transports: ['https'], markers: ['buildSuccess('] },
  'traeAdapter.js': { family: 'ide-bridge', transports: ['https'], markers: ['buildSuccess('] },
  'vscodeAdapter.js': { family: 'ide-bridge', transports: ['https'], markers: ['buildSuccess('] },
  'warpAdapter.js': { family: 'clipboard-wrapper', transports: ['subprocess'], markers: ['buildSuccess('] },
  'webRelayAdapter.js': { family: 'relay', transports: ['https'], markers: ['buildSuccess('] },
});

module.exports = { FIXTURES };
