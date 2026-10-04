import request from '@/api/request';

/**
 * CC-Switch provider cards — frontend API client (DESIGN-ARCH-101).
 *
 * The backend surface is served by the web backend at /api/cc-switch
 * (routes/ccSwitch.js, admin-gated). Convention: every method resolves to the
 * backend envelope `{ success, data, metadata }`; callers read `res.data.<field>`.
 *
 * mode semantics (DESIGN-ARCH-101 §6): 'proxy' (default) writes the khy gateway
 * endpoint + gateway token into the agent config; 'direct' writes the provider's
 * real endpoint + real key. The response echoes the applied mode.
 */
export const ccSwitchApi = {
  // Provider card list (keyId presence only — no plaintext keys cross the wire).
  listCards() {
    return request.get('/api/cc-switch/cards').then((r) => r.data);
  },
  // Per-app active card + scan config (12 agents incl. trae/coze/openclaw).
  status() {
    return request.get('/api/cc-switch/status').then((r) => r.data);
  },
  // Switch an app onto a card. `mode` may be 'proxy' (default) or 'direct'.
  useCard(cardId, app, mode) {
    return request.post('/api/cc-switch/use', { cardId, app, mode }).then((r) => r.data);
  },
  // Incremental usage scan (optional app subset).
  scan(apps) {
    return request.post('/api/cc-switch/scan', apps && apps.length ? { apps } : {}).then((r) => r.data);
  },
};
