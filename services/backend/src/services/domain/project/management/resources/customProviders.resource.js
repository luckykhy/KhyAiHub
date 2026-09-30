/**
 * Management resource: custom OpenAI-compatible providers.
 *
 * Source of truth: the provider-metadata file under getDataHome()
 * (services/customProviderRegistry.js). Registration/removal go through
 * customProviderRegistrar, the single source that also wires key pool + env
 * routing. CLI (`khy manage custom-providers ...`) and the Web management page
 * both invoke these ops through managementRegistry, so the two surfaces stay
 * identical.
 *
 * API keys are never returned: list reports only metadata + a keyCount.
 */
const path = require('path');

const { getDataHome } = require('../../../../../utils/dataHome');

// Deps are injected by the D1 assembly entry (services/management/index.js).
// [RESEARCH-018] P2 cut-set E1-E3: D2 must not require into D1 (gate d2-no-reach-into-d1).
let _pool = null;
let _registrar = null;
let _registry = null;

function bind(deps) {
  _pool = deps.pool;
  _registrar = deps.registrar;
  _registry = deps.registry;
}

function _bound(name, dep) {
  if (!dep) {
    throw new Error(
      `custom-providers 资源未绑定依赖 ${name}：请经装配入口 services/management 调用，勿直接 require D2 资源模块`
    );
  }
  return dep;
}

const REGISTRY_FILE = path.join(getDataHome(), 'custom_providers.json');

function _keyCount(poolKey) {
  try {
    return (_bound('pool', _pool).getPoolStatus(poolKey) || []).length;
  } catch {
    return 0;
  }
}

/** @type {import('../resourceContract').Contract} */
const contract = {
  id: 'custom-providers',
  label: '自定义 AI 提供商',
  source: 'file',
  sourceDetail: REGISTRY_FILE,
  capabilities: ['list', 'add', 'remove'],
  schema: {
    add: {
      displayName: { type: 'string', required: true },
      poolKey: { type: 'string', required: true },
      endpoint: { type: 'string', required: true },
      keyInput: { type: 'string', required: true },
      defaultModel: { type: 'string', required: true },
      extraModels: { type: 'string', required: false },
      tier: { type: 'string', required: false },
    },
    remove: {
      poolKey: { type: 'string', required: true },
      removeKeys: { type: 'boolean', required: false },
    },
  },
  ops: {
    async list() {
      const providers = _bound('registry', _registry).listProviders().map((p) => ({
        name: p.name,
        poolKey: p.poolKey,
        endpoint: p.endpoint,
        defaultModel: p.defaultModel,
        models: Array.isArray(p.models) ? p.models.slice() : [],
        ...(p.tier ? { tier: p.tier } : {}),
        keyCount: _keyCount(p.poolKey),
      }));
      return { providers, presets: _bound('registrar', _registrar).getPresets() };
    },
    async add(args) {
      const result = _bound('registrar', _registrar).registerCustomProvider({
        displayName: args.displayName,
        poolKey: args.poolKey,
        endpoint: args.endpoint,
        keyInput: args.keyInput,
        defaultModel: args.defaultModel,
        extraModels: args.extraModels,
        tier: args.tier,
        ensureInit: true,
      });
      // Never echo the raw key back to either surface.
      const { firstKey, ...safe } = result;
      return safe;
    },
    async remove(args) {
      if (!args || !args.poolKey) {
        throw new Error('poolKey is required');
      }
      return _bound('registrar', _registrar).unregisterCustomProvider(args.poolKey, {
        removeKeys: args.removeKeys === true,
      });
    },
  },
};

contract.bind = bind;

module.exports = contract;
