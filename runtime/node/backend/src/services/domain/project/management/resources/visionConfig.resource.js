/**
 * Management resource: the vision ("eyes-only") endpoint.
 *
 * Source of truth: <dataHome>/vision_endpoint.json, read and written exclusively
 * through services/visionEndpointStore.js. CLI (`khy manage vision-config ...`,
 * `khy config set model.vision.*`, `khy vision config`) and the Web management
 * page all invoke these ops through managementRegistry, so the three surfaces
 * cannot disagree.
 *
 * Why this resource exists at all: the routing machinery that consumes a pinned
 * vision model (decideVisionRouting → poolHint → apiAdapter endpoint switch) is
 * already complete end to end. What was missing was any way to *declare* the
 * endpoint from a user-facing surface — today the only knob is hand-editing
 * .env. This resource is that declaration funnel.
 *
 * API keys are never returned: get() reports only a live-derived mask, and the
 * config file itself holds no key material (R2). See visionEndpointStore.js for
 * the two-plane split (declarative file vs. key pool).
 */
const path = require('path');

const { getDataHome } = require('../../../../../utils/dataHome');

// Deps are injected by the D1 assembly entry (services/management/index.js).
// [RESEARCH-018] P2 cut-set E1-E3: D2 must not require into D1 (gate
// d2-no-reach-into-d1), so neither the store nor the pool is required here.
let _store = null;
let _pool = null;

function bind(deps) {
  _store = deps.store;
  _pool = deps.pool;
}

function _bound(name, dep) {
  if (!dep) {
    throw new Error(
      `vision-config 资源未绑定依赖 ${name}：请经装配入口 services/management 调用，勿直接 require D2 资源模块`
    );
  }
  return dep;
}

// Load-time join, same idiom as customProviders.resource.js:40. The filename
// literal is duplicated from visionEndpointStore.js on purpose — requiring the
// store here would be a D2→D1 edge and would enlarge the baselined cycle. The
// colocated test pins this path so the two cannot drift silently.
const CONFIG_FILE = path.join(getDataHome(), 'vision_endpoint.json');

/**
 * Normalise the two surface-specific shapes into the store's vocabulary.
 *
 * `clearApiKey` arrives as a real boolean from Web JSON but as the string
 * 'true' from the CLI (managementRegistry forwards parsed options verbatim).
 * Everything else is forwarded untouched — the store owns the merge, so this
 * layer must not second-guess which fields are "present".
 */
function _normalizeArgs(args) {
  const a = args || {};
  return {
    baseUrl: a.baseUrl,
    model: a.model,
    apiKey: a.apiKey,
    clearApiKey: a.clearApiKey === true || a.clearApiKey === 'true',
  };
}

/** @type {import('../resourceContract').Contract} */
const contract = {
  id: 'vision-config',
  label: '视觉识图端点（识图专用模型，只当眼睛）',
  source: 'file',
  sourceDetail: CONFIG_FILE,
  capabilities: ['get', 'set', 'clear'],
  schema: {
    // Every field is optional at this layer: _mergeArgs fills the gaps from the
    // stored config, and writeVisionEndpoint still rejects an empty result.
    set: {
      baseUrl: { type: 'string', required: false },
      model: { type: 'string', required: false },
      apiKey: { type: 'string', required: false },
      clearApiKey: { type: 'boolean', required: false },
    },
    clear: {},
  },
  ops: {
    async get() {
      // describeVisionEndpoint derives the key mask live from the pool, so the
      // answer can never go stale the way a persisted mask would.
      return _bound('store', _store).describeVisionEndpoint(_bound('pool', _pool));
    },
    async set(args) {
      // No "first setup needs both fields" gate, and no merge here: a
      // half-filled endpoint is inert (readVisionEndpoint() returns null until
      // baseUrl AND model are both present) and the store owns the incremental
      // merge, so `khy config set model.vision.model` on a fresh install just
      // works and a config that is never completed behaves like no config.
      const store = _bound('store', _store);
      return store.writeVisionEndpoint(_normalizeArgs(args), _bound('pool', _pool));
    },
    async clear() {
      // Deleting is its own op rather than `set` with empty strings: an empty
      // baseUrl is indistinguishable from a typo at the atomic writer, and the
      // funnel must stay the only write path (resourceContract.js:11).
      return _bound('store', _store).clearVisionEndpoint(_bound('pool', _pool));
    },
  },
};

contract.bind = bind;

module.exports = contract;
