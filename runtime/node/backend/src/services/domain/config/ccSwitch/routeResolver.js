'use strict';

/**
 * ccSwitch routeResolver — active-card routing for the local proxy.
 *
 * When an external tool (Claude Code / Codex / OpenCode / Gemini CLI) has an
 * ACTIVE card in the ccSwitch store, requests arriving at the proxy from that
 * tool should be routed to the card's upstream. This resolver rewrites the
 * model-router result to point at the card via the generic `api` adapter:
 *   adapterKey = 'api'
 *   apiPoolProvider = 'cc-switch:<cardId>'  (keys/endpoint live in apiKeyPool)
 *
 * Explicit adapter prefixes (`claude/...`, `trae/...`, route-map overrides) and
 * user-pinned channels ALWAYS take precedence over the active card — a card is
 * only a default, never a straitjacket.
 *
 * Pure resolver (zero IO except the store read, which is cached): returns the
 * rewritten route or null when no card applies.
 */

const { APPS, PROTOCOLS, cardPoolProvider } = require('./constants');

// resolveCardRoute 写进 route.metadata.source 的值。proxyServer 的 Anthropic 入站
// 放宽分支（「非 explicit/route-map 就清掉 preferredAdapter 进级联」）必须把它和
// explicit/route-map 同等看待：卡片是用户在 UI 上为这个 app 显式激活的上游，
// 放宽等于让 kiro/trae 等 IDE 适配器把这次请求截走。
const CARD_ROUTE_SOURCE = 'cc-switch-card';

/**
 * Map an inbound source protocol to the external app that produced it.
 * @param {string} sourceProtocol  one of PROTOCOLS.*
 * @returns {string[]} candidate APPS.* apps (may be several for shared wires)
 */
function appsForProtocol(sourceProtocol) {
  switch (sourceProtocol) {
    case PROTOCOLS.ANTHROPIC:
      // Anthropic wire: Claude Code (native) and Command Code BYOK
      // (anthropic-messages wire) both speak it.
      return [APPS.CLAUDE_CODE, APPS.COMMAND_CODE];
    case PROTOCOLS.CODEX:
      return [APPS.CODEX];
    case PROTOCOLS.OPENAI:
      // OpenAI wire: OpenCode, Command Code BYOK (openai-completions),
      // YCode (api connection) and generic OpenAI-compatible tools.
      return [APPS.OPENCODE, APPS.COMMAND_CODE, APPS.YCODE];
    case PROTOCOLS.GEMINI:
      return [APPS.GEMINI];
    default:
      return [];
  }
}

// Backward-compat single-app mapping (used by callers expecting one app id).
function appForProtocol(sourceProtocol) {
  const apps = appsForProtocol(sourceProtocol);
  return apps.length ? apps[0] : null;
}

/**
 * Decide whether the active card should override the resolved route.
 *
 * @param {object} route  result of modelRouter.resolveModelRoute
 * @param {object} ctx    { sourceProtocol, store }
 * @returns {object|null} rewritten route (adapterKey=api + pool hint) or null
 */
function resolveCardRoute(route, ctx = {}) {
  const store = ctx.store;
  if (!store || !route) {
    return null;
  }
  const sourceProtocol = ctx.sourceProtocol;
  const candidates = appsForProtocol(sourceProtocol);
  if (!candidates.length) {
    return null;
  }

  // 1. Explicit user pinning always wins over a card.
  const source = route.metadata && route.metadata.source;
  if (route.userPinned || route.strictPreferred === true || source === 'explicit' || source === 'route-map') {
    return null;
  }

  // 2. Find the FIRST candidate app that has an active, enabled card.
  let card = null;
  let cardApp = null;
  let cardId = null;
  for (const app of candidates) {
    try {
      const activeId = store.getActiveCardId(app);
      if (!activeId) {
        continue;
      }
      const activeCard = store.getCard(activeId);
      if (activeCard && activeCard.enabled) {
        card = activeCard;
        cardApp = app;
        cardId = activeId;
        break;
      }
    } catch {
      /* try next app */
    }
  }
  if (!card || !cardApp) {
    return null;
  }

  // 3. Protocol sanity: reject when the card's protocol is plainly incompatible
  //    with the inbound app (Codex needs an OpenAI-compatible upstream).
  if (cardApp === APPS.CODEX && ![PROTOCOLS.OPENAI, PROTOCOLS.RESPONSES].includes(card.protocol)) {
    return null;
  }

  // 4. Rewrite the route to the generic api adapter pinned to the card's pool.
  //    池名走 constants.cardPoolProvider 单一真源：它产出 `cc_switch_<cardId>`，
  //    落在 apiAdapter / aiGateway 三段式正则在池段认得的 [a-z0-9_-] 字符类内。
  //    旧版这里拼 `cc-switch:<cardId>`（含冒号），池段被正则截成 'cc-switch'，
  //    apiKeyPool.pick 精确匹配不到 key/endpoint，模型 id 还被污染成
  //    '<cardId>:<model>' —— 卡片因此从未真正接到网关路由上。
  const poolProvider = cardPoolProvider(card.id);
  return {
    ...route,
    adapterKey: 'api',
    preferredAdapter: 'api',
    preferredModel: route.modelId || card.defaultModel || null,
    strictPreferred: false, // keep cascade fallback for robustness
    userPinned: false,
    ccSwitchCardId: card.id,
    ccSwitchCardName: card.name,
    apiPoolProvider: poolProvider,
    metadata: {
      ...(route.metadata || {}),
      source: CARD_ROUTE_SOURCE,
      ccSwitchCardId: card.id,
      ccSwitchCardName: card.name,
    },
  };
}

module.exports = {
  resolveCardRoute,
  appForProtocol,
  appsForProtocol,
  CARD_ROUTE_SOURCE,
};
