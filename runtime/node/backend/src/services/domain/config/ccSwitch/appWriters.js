'use strict';

/**
 * ccSwitch appWriters — per-app live-config writers.
 *
 * Maps each supported external app to the concrete config file it reads at
 * startup and rewrites it (atomically, preserving unrelated content) to point
 * the app at a selected provider card. This is the "正门" for state changes
 * (AGENTS.md 通道选择: 写必走正门) — nothing here mutates the store; the store
 * only records which card is active after a successful write.
 *
 * Apps:
 *   claude-code → ~/.claude/settings.json env block (claudeCodeAdapter.add)
 *   codex       → ~/.codex/config.toml + auth.json (config-only bearer token,
 *                 mirroring cc-switch v3.20.1 — key goes into the provider's
 *                 own [model_providers.*] table, NOT auth.json)
 *   opencode    → ~/.config/opencode/opencode.json provider tree
 *   gemini      → ~/.gemini/settings.json env block
 *   deepseek    → ~/.deepseek/config.toml (deepseekTuiAdapter)
 *   reasonix    → ~/.reasonix/config.toml + .env (reasonixAdapter)
 *   command-code→ ~/.commandcode/providers.json BYOK 表 + config.json 默认模型
 *                 (key 只写 env 引用 $KHY_CC_SWITCH_<ID>_KEY，官方拒绝裸密钥)
 *   ycode       → .ycode/config.json provider 块 (key 只写 api_key_env 引用)
 *   zcode       → ~/.zcode/cli/config.json provider.zai 槽位 + model.main/lite 双角色
 *                 （zcode 登录门要求内联非空 key，中继模式下写入 khy 网关令牌）
 *   openclaw    → ~/.openclaw/config.json provider 树 (openclawAdapter)
 *   coze        → ~/.coze/models/<model>/config.json (cozeAdapter)
 *   trae        → switch-center 的 trae_switch_profiles.json
 *                 （traeAppAdapter 桥接 proxy switch-center，非独立 live 配置文件）
 *
 * 两种模式（DESIGN-ARCH-101 §6）：
 *   direct（默认、历史行为）→ 写 card.baseUrl + provider 真实 key，agent 直连上游。
 *   proxy                  → 写 khy 网关端点 + 网关令牌，模型名改写为可路由三段格式
 *                            `api:<poolKey>:<model>`。真实 provider key 只留在
 *                            api_keys.json 池里给网关用，agent 侧永不持有（§5.2）。
 *                            末步回写 store.agentMode[app] = {mode:'proxy', cardId, ts}。
 *
 * Fail-soft: every app writer returns { success, ... } — never throws.
 */

const { APPS, PROTOCOLS, AGENT_MODES } = require('./constants');
const claudeCodeAdapter = require('../../network/externalApps/claudeCodeAdapter');
const opencodeAdapter = require('../../network/externalApps/opencodeAdapter');
const geminiCliAdapter = require('../../network/externalApps/geminiCliAdapter');
const commandCodeAdapter = require('../../network/externalApps/commandCodeAdapter');
const ycodeAdapter = require('../../network/externalApps/ycodeAdapter');
const zcodeAdapter = require('../../network/externalApps/zcodeAdapter');
const deepseekTuiAdapter = require('../../network/externalApps/deepseekTuiAdapter');
const reasonixAdapter = require('../../network/externalApps/reasonixAdapter');
const openclawAdapter = require('../../network/externalApps/openclawAdapter');
const cozeAdapter = require('../../network/externalApps/cozeAdapter');
const traeAppAdapter = require('../../network/externalApps/traeAppAdapter');
const proxyAccess = require('./proxyAccess');

/**
 * Preflight a card for an app: return a human-readable verdict on whether the
 * switch is safe BEFORE moving the live config (mirrors cc-switch's write
 * pre-check — reject by name instead of "switch succeeded" then the app fails).
 *
 * @param {object} card
 * @param {string} app
 * @param {{ mode?: string }} [opts]  mode='proxy' 时代理解除协议约束（§4：代理做协议桥接，
 *                                   任意入站协议都能接任意上游），故跳过 per-app 协议门。
 * @returns {{ ok: boolean, reason?: string }}
 */
function preflightCardForApp(card, app, opts = {}) {
  if (!card || !card.name) {
    return { ok: false, reason: '卡片无效（缺少名称）' };
  }
  // 代理模式下端点由网关提供，卡片自身的 baseUrl 不再是写入目标；但网关路由仍需能确定
  // 上游，故仍要求卡片有 baseUrl（否则池条目缺 endpoint、路由不可解析）。
  if (!card.baseUrl) {
    return { ok: false, reason: '卡片缺少 baseUrl，无法切换' };
  }
  const proxyMode = opts.mode === AGENT_MODES.PROXY;
  if (proxyMode) {
    // §4：协议桥接已由网关 handleMultiProtocol 实现，代理模式下不按上游协议拒绝。
    return { ok: true };
  }
  if (app === APPS.CLAUDE_CODE) {
    // Claude Code expects an Anthropic-wire endpoint. OpenAI-compatible cards
    // are still usable through the khy proxy (which converts), so only warn.
    if (card.protocol === PROTOCOLS.OPENAI) {
      return {
        ok: true,
        reason: '卡片为 OpenAI 协议，Claude Code 需经 khy 代理转换（ANTHROPIC_BASE_URL 指向本地代理）',
      };
    }
    return { ok: true };
  }
  if (app === APPS.CODEX) {
    if (![PROTOCOLS.OPENAI, PROTOCOLS.RESPONSES].includes(card.protocol)) {
      return { ok: false, reason: 'Codex 仅支持 OpenAI 兼容协议（openai / openai_responses）' };
    }
    return { ok: true };
  }
  if (app === APPS.OPENCODE) {
    if (![PROTOCOLS.OPENAI, PROTOCOLS.ANTHROPIC].includes(card.protocol)) {
      return { ok: false, reason: 'OpenCode 支持 openai / anthropic 协议' };
    }
    return { ok: true };
  }
  if (app === APPS.COMMAND_CODE) {
    // Command Code BYOK supports openai-completions and anthropic-messages wires.
    if (![PROTOCOLS.OPENAI, PROTOCOLS.ANTHROPIC, PROTOCOLS.RESPONSES].includes(card.protocol)) {
      return { ok: false, reason: 'Command Code BYOK 支持 openai / anthropic 协议' };
    }
    return { ok: true };
  }
  if (app === APPS.YCODE) {
    // YCode's hosted-API connection is OpenAI-compatible only.
    if (![PROTOCOLS.OPENAI, PROTOCOLS.RESPONSES].includes(card.protocol)) {
      return { ok: false, reason: 'YCode api 连接仅支持 OpenAI 兼容协议（openai / openai_responses）' };
    }
    return { ok: true };
  }
  if (app === APPS.ZCODE) {
    // ZCode runtime kinds: anthropic / openai-compatible / openai — no gemini/responses wire.
    if (![PROTOCOLS.OPENAI, PROTOCOLS.ANTHROPIC].includes(card.protocol)) {
      return { ok: false, reason: 'ZCode 仅支持 anthropic / OpenAI 兼容端点（openai / anthropic 协议卡片）；其余协议请先经 khy 代理转换为 OpenAI 协议' };
    }
    return { ok: true };
  }
  return { ok: true };
}

/**
 * Apply a card to an app's live config. On success the caller (CLI/UI) records
 * the active card in the store — this function itself never mutates the card
 * registry (it only records `agentMode` when mode='proxy', per §5.2 步骤 5).
 *
 * @param {object} card  normalized card from the store
 * @param {string} app   one of APPS.*
 * @param {{ store?: object, key?: string, mode?: 'direct'|'proxy', proxyBaseUrl?: string, proxyToken?: string }} opts
 * @returns {Promise<{ success: boolean, app: string, error?: string, detail?: object, mode?: string }>}
 */
async function applyCardToApp(card, app, opts = {}) {
  const mode = opts.mode === AGENT_MODES.DIRECT ? AGENT_MODES.DIRECT : AGENT_MODES.PROXY;
  const pre = preflightCardForApp(card, app, { mode });
  if (!pre.ok) {
    return { success: false, app, mode, error: pre.reason };
  }

  // ── 代理模式：先解析网关接入（端点 + 令牌 + poolKey），失败即状态透明返回 ──
  let writeCard = card;
  let key =
    opts.key ||
    (opts.store && opts.store.getCardCredential ? opts.store.getCardCredential(card.id) : null) ||
    '';
  let proxyInfo = null;

  if (mode === AGENT_MODES.PROXY) {
    const access = opts.proxyBaseUrl && opts.proxyToken
      ? { ok: true, proxyEndpoint: opts.proxyBaseUrl, proxyToken: opts.proxyToken, source: { endpoint: 'explicit', token: 'explicit' } }
      : proxyAccess.resolveProxyAccess();
    if (!access.ok) {
      return { success: false, app, mode, error: access.error };
    }
    const { poolKey, source: poolKeySource } = proxyAccess.resolvePoolKeyFromCard(card, { raw: true });
    writeCard = proxyAccess.buildProxyCard(card, {
      proxyEndpoint: access.proxyEndpoint,
      poolKey,
    });
    key = access.proxyToken; // agent 侧只拿到网关令牌，绝不写 provider 真实 key
    proxyInfo = {
      endpoint: access.proxyEndpoint,
      tokenMasked: _maskToken(access.proxyToken),
      poolKey,
      poolKeySource,
      model: writeCard.defaultModel,
      source: access.source,
    };
  }

  const defaultModel = writeCard.defaultModel || '';

  let result;
  try {
    switch (app) {
      case APPS.CLAUDE_CODE: {
        // Write via the canonical adapter; pass explicit endpoint/key/model so
        // preset fallback never injects an unrelated provider.
        // 代理模式额外要求 env 键落在 ANTHROPIC_* 命名空间（§5.3），
        // 这样 Claude Code 读到的就是网关端点 + 网关令牌。
        result = claudeCodeAdapter.add({
          provider: writeCard.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          model: defaultModel,
          apiKey: key || undefined,
          endpoint: writeCard.baseUrl,
          literalAnthropicEnv: mode === AGENT_MODES.PROXY,
        });
        break;
      }
      case APPS.CODEX: {
        const { setCodexUpstreamConfigOnly } = require('./codexWriter');
        const r = setCodexUpstreamConfigOnly({
          providerName: writeCard.name,
          baseUrl: writeCard.baseUrl,
          model: defaultModel,
          apiKey: key || undefined,
          wireApi: card.wireApi || (card.protocol === PROTOCOLS.RESPONSES ? 'responses' : 'chat'),
          requiresOpenaiAuth: card.requiresOpenaiAuth === true,
        });
        result = { success: true, error: r.error, detail: r };
        break;
      }
      case APPS.OPENCODE: {
        result = opencodeAdapter.add({
          provider: writeCard.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          model: defaultModel,
          apiKey: key || undefined,
          endpoint: writeCard.baseUrl,
        });
        break;
      }
      case APPS.GEMINI: {
        result = geminiCliAdapter.add({
          provider: writeCard.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          model: defaultModel,
          apiKey: key || undefined,
          endpoint: writeCard.baseUrl,
        });
        break;
      }
      case APPS.COMMAND_CODE: {
        result = commandCodeAdapter.add({
          provider: writeCard.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          model: defaultModel,
          apiKey: key || undefined,
          endpoint: writeCard.baseUrl,
          protocol: card.protocol,
          wireApi: card.wireApi,
        });
        break;
      }
      case APPS.YCODE: {
        result = ycodeAdapter.add({
          provider: writeCard.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          model: defaultModel,
          apiKey: key || undefined,
          endpoint: writeCard.baseUrl,
          connection: 'api',
        });
        break;
      }
      case APPS.ZCODE: {
        // ZCode 登录门：provider 槽位固定 `zai`（内联 key），双模型角色 main/lite。
        result = zcodeAdapter.add({
          provider: writeCard.name,
          model: defaultModel,
          apiKey: key || undefined,
          endpoint: writeCard.baseUrl,
          protocol: card.protocol,
        });
        break;
      }
      // ── 2026-09-24 接线：适配器文件早已存在，此前 switch 无 case（§1.3）──
      case APPS.DEEPSEEK: {
        result = deepseekTuiAdapter.add({
          provider: writeCard.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          model: defaultModel,
          apiKey: key || undefined,
          endpoint: writeCard.baseUrl,
        });
        break;
      }
      case APPS.REASONIX: {
        result = reasonixAdapter.add({
          provider: writeCard.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          model: defaultModel,
          apiKey: key || undefined,
          endpoint: writeCard.baseUrl,
        });
        break;
      }
      case APPS.OPENCLAW: {
        result = openclawAdapter.add({
          provider: writeCard.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          model: defaultModel,
          apiKey: key || undefined,
          endpoint: writeCard.baseUrl,
        });
        break;
      }
      case APPS.COZE: {
        result = cozeAdapter.add({
          provider: writeCard.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          model: defaultModel,
          apiKey: key || undefined,
          endpoint: writeCard.baseUrl,
        });
        break;
      }
      case APPS.TRAE: {
        // Trae 无独立 live 配置文件：写入走 switch-center 的 profile 存储（桥接适配器）。
        result = traeAppAdapter.add({
          provider: writeCard.name,
          model: defaultModel,
          apiKey: key || undefined,
          endpoint: writeCard.baseUrl,
        });
        break;
      }
      default:
        return { success: false, app, mode, error: `暂不支持把卡片写到应用: ${app}` };
    }
  } catch (e) {
    return { success: false, app, mode, error: String((e && e.message) || e) };
  }

  const success = Boolean(result && result.success);
  // 仅代理模式回写 agentMode（direct 是历史默认，不写以免污染旧语义）。
  if (success && mode === AGENT_MODES.PROXY && opts.store && typeof opts.store.setAgentMode === 'function') {
    try {
      opts.store.setAgentMode(app, AGENT_MODES.PROXY, card.id);
    } catch {
      /* 记账失败不影响写入结果（写入已成功，状态透明） */
    }
  }

  return {
    success,
    app,
    mode,
    error: result ? result.error : undefined,
    detail: proxyInfo ? { ...result, proxy: proxyInfo } : result,
  };
}

/** 令牌脱敏（回显用；绝不回原文）。 */
function _maskToken(token) {
  const s = String(token || '');
  if (!s) {
    return '';
  }
  if (s.length <= 10) {
    return '****';
  }
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/**
 * Read back which provider a card maps to in each app's live config (reverse
 * direction — used by `khy cc-switch status` to reconcile detected state).
 *
 * @param {string} app
 * @returns {{ success: boolean, providers: Array<{id:string,endpoint:string,hasKey:boolean,models:string[]}> }}
 */
function detectCardInApp(app) {
  try {
    switch (app) {
      case APPS.CLAUDE_CODE:
        return claudeCodeAdapter.list();
      case APPS.CODEX: {
        const { getCodexUpstreamSnapshot } = require('../../../gateway/adapters/codexAdapter');
        const snap = getCodexUpstreamSnapshot();
        return {
          success: true,
          providers: snap.provider
            ? [
                {
                  id: snap.provider,
                  endpoint: snap.baseUrl || '',
                  hasKey: snap.hasApiKey,
                  models: snap.model ? [snap.model] : [],
                },
              ]
            : [],
        };
      }
      case APPS.OPENCODE:
        return opencodeAdapter.list();
      case APPS.GEMINI:
        return geminiCliAdapter.list();
      case APPS.COMMAND_CODE:
        return commandCodeAdapter.list();
      case APPS.YCODE:
        return ycodeAdapter.list();
      case APPS.ZCODE:
        return zcodeAdapter.list();
      case APPS.DEEPSEEK:
        return deepseekTuiAdapter.list();
      case APPS.REASONIX:
        return reasonixAdapter.list();
      case APPS.OPENCLAW:
        return openclawAdapter.list();
      case APPS.COZE:
        return cozeAdapter.list();
      case APPS.TRAE:
        return traeAppAdapter.list();
      default:
        return { success: false, providers: [], error: `不支持的应用: ${app}` };
    }
  } catch (e) {
    return { success: false, providers: [], error: String((e && e.message) || e) };
  }
}

module.exports = { applyCardToApp, preflightCardForApp, detectCardInApp, buildProxyCard: proxyAccess.buildProxyCard, resolveProxyAccess: proxyAccess.resolveProxyAccess, resolvePoolKeyFromCard: proxyAccess.resolvePoolKeyFromCard };
