'use strict';

/**
 * ccSwitch constants — CC-Switch-style provider-card subsystem.
 *
 * Single source of truth for:
 *   - Supported external apps (tools) that can be pointed at a card
 *   - Card protocols (wire formats each tool speaks)
 *   - The data file name + schema version
 *
 * The store lives in services/ccSwitch/store.js; CLI surface in
 * cli/handlers/ccSwitch.js; live-config writers in services/externalApps/*
 * (claudeCodeAdapter / codexAdapter / opencodeAdapter / geminiCliAdapter).
 */

// Wire protocol a card speaks to ITS upstream. The khy proxy converts between
// the tool's inbound protocol and this outbound protocol via protocolConverter.
const PROTOCOLS = Object.freeze({
  OPENAI: 'openai', // /v1/chat/completions
  ANTHROPIC: 'anthropic', // /v1/messages
  RESPONSES: 'openai_responses', // /v1/responses (Codex)
  GEMINI: 'gemini', // /v1beta/models/*:generateContent
});

// External apps that can be switched onto a card. Each maps to a live-config
// writer in services/externalApps/* and (optionally) a session-file scanner in
// services/usageScan/*.
//
// DESIGN-ARCH-101 §7 步骤 4：DEEPSEEK / REASONIX 早已在册；OPENCLAW / COZE / TRAE
// 于本方案纳入统一矩阵（前两者的适配器文件早已存在但 switch 无 case，接线即生效；
// TRAE 走 externalApps/traeAppAdapter.js 桥接 switch-center 的 profile 存储）。
const APPS = Object.freeze({
  CLAUDE_CODE: 'claude-code',
  CODEX: 'codex',
  OPENCODE: 'opencode',
  GEMINI: 'gemini',
  DEEPSEEK: 'deepseek',
  REASONIX: 'reasonix',
  COMMAND_CODE: 'command-code',
  YCODE: 'ycode',
  ZCODE: 'zcode',
  OPENCLAW: 'openclaw',
  COZE: 'coze',
  TRAE: 'trae',
});

// App → human label (CLI/UI display).
const APP_LABELS = Object.freeze({
  [APPS.CLAUDE_CODE]: 'Claude Code',
  [APPS.CODEX]: 'Codex CLI',
  [APPS.OPENCODE]: 'OpenCode CLI',
  [APPS.GEMINI]: 'Gemini CLI',
  [APPS.DEEPSEEK]: 'DeepSeek TUI',
  [APPS.REASONIX]: 'Reasonix',
  [APPS.COMMAND_CODE]: 'Command Code',
  [APPS.YCODE]: 'YCode',
  [APPS.ZCODE]: 'ZCode',
  [APPS.OPENCLAW]: 'OpenClaw',
  [APPS.COZE]: 'Coze',
  [APPS.TRAE]: 'Trae',
});

// Card switch modes (DESIGN-ARCH-101 §6).
//   direct → 写 provider 真实端点 + 真实 key（agent 直连上游）
//   proxy  → 写 khy 网关端点 + 网关令牌，模型名用可路由三段格式（推荐默认）
const AGENT_MODES = Object.freeze({
  DIRECT: 'direct',
  PROXY: 'proxy',
});

// Card-level default model per protocol (used by the switch writers when a card
// carries no per-app model override).
const PROTOCOL_DEFAULT_MODELS = Object.freeze({
  [PROTOCOLS.OPENAI]: 'gpt-4o',
  [PROTOCOLS.ANTHROPIC]: 'claude-sonnet-4-5',
  [PROTOCOLS.RESPONSES]: 'gpt-5-codex',
  [PROTOCOLS.GEMINI]: 'gemini-2.5-pro',
});

const DATA_FILE = 'cc_switch.json';
const SCHEMA_VERSION = 1;

// ── 卡片自有 key 在 apiKeyPool 里的命名空间 ───────────────────────────────
// 这个字符串会被网关当成「pool 名」用：apiAdapter.parseProviderModel /
// aiGateway._resolveApiPoolProviderForRequest 的三段式正则只认
// /^api[:/]([a-z0-9_-]+)[:/](.+)$/ —— 池名段**不允许冒号**。
//
// 历史版本用 `cc-switch:<cardId>`（store.js:_poolProvider），于是：
//   1. `api:cc-switch:c_ab12:gpt-4o-mini` 的池段被截成 `cc-switch`，
//      apiKeyPool.pick('cc-switch') 精确匹配不到任何 key/endpoint；
//   2. 模型 id 被污染成 `<cardId>:<model>`；
//   3. proxyAccess 的池扫描原样返回这个非法名，拼出的三名同样解不出。
// 统一改成 `cc_switch_<cardId>`（下划线在字符类内），并对旧命名空间做只读别名
// 兼容（见 apiKeyPool._poolProviderAliases）——已落盘的 api_keys.json 不做迁移。
const CARD_POOL_NAMESPACE = 'cc_switch';
const LEGACY_CARD_POOL_NAMESPACE = 'cc-switch';

/**
 * 卡片自有 key 的 apiKeyPool 命名空间（唯一真源）。
 * @param {string} cardId
 * @returns {string} 形如 `cc_switch_c_ab12cd34`，必匹配 /^[a-z0-9_-]+$/
 */
function cardPoolProvider(cardId) {
  return `${CARD_POOL_NAMESPACE}_${String(cardId || '').trim()}`;
}

/**
 * 历史命名空间（只读兼容：读得到，不再写入）。
 * @param {string} cardId
 * @returns {string} 形如 `cc-switch:c_ab12cd34`
 */
function legacyCardPoolProvider(cardId) {
  return `${LEGACY_CARD_POOL_NAMESPACE}:${String(cardId || '').trim()}`;
}

/**
 * 把一个池名收敛成网关三段式正则认得的形态（幂等）。
 * 已是合法名 → 原样返回；否则把字符类外字符折叠为 `_`。
 * 绝不抛、绝不返回空串之外的假值（空入参 → 空串）。
 * @param {string} raw
 * @returns {string}
 */
function normalizePoolProviderName(raw) {
  let text = '';
  try {
    text = String(raw || '')
      .trim()
      .toLowerCase();
  } catch {
    return ''; // Symbol / toString 抛错的怪对象 → 空串（调用方按「扫不到」处理）
  }
  return text
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

module.exports = {
  PROTOCOLS,
  APPS,
  APP_LABELS,
  AGENT_MODES,
  PROTOCOL_DEFAULT_MODELS,
  DATA_FILE,
  SCHEMA_VERSION,
  CARD_POOL_NAMESPACE,
  LEGACY_CARD_POOL_NAMESPACE,
  cardPoolProvider,
  legacyCardPoolProvider,
  normalizePoolProviderName,
};
