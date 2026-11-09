'use strict';

/**
 * appModelImporter — khy 消费侧薄壳:把 6 个外部软件里已配置的可用模型**读出来并注册进 khy
 * 自己的 provider 池**,让 khy 能像用 codex / claude-code 的模型一样选它、调它。
 *
 * 这是「把模型配进外部软件」(externalApps/*Adapter 的 add/remove)的**逆向**:
 *   - 读:各 adapter 的 usable(env) 回该 app 已配置 provider 的真 key+endpoint+models。
 *   - 注册:对每个 provider 调 customProviderRegistrar.registerCustomProvider,一次性写
 *     apiKeyPool + custom_providers.json + 路由 env 映射;之后 apiAdapter.listModels() 自动列出
 *     `api:<poolKey>:<model>`,modelRouter → apiAdapter.generate() 用 pool.pick 拿真 key 发请求。
 *   - poolKey = `<app>-<provider>`(如 opencode-deepseek):避与 khy 内置 poolKey 冲突 + 记录来源。
 *
 * 密钥安全:真 key 只在进程内从 adapter 直接喂给 registerCustomProvider.keyInput,**绝不上命令行、
 * 绝不回显**;所有返回经 maskKey(头尾各 4 字符)脱敏。app 无 key 时经 _shared.resolveApiKey 借
 * khy 已存的同厂商 key(keySource='pool')。
 *
 * 契约:门控 KHY_EXTERNAL_APP_IMPORT(flagRegistry 优先 + 本地 CANON 回退)、fail-soft(绝不抛 →
 * {success:false,error} 或 skipped)。registrar 依赖可注入(deps.registrar),便于测试传 spy 免污染
 * 全局 env/.env。门控关 → discover/import/unimport 整体 no-op(逐字节回退)。
 *
 * 可用性状态(design [DESIGN-MEM-009] §3 #9 / 解包结论 F09):discover 的返回体带
 * state=ok/stale/reauth/unsupported + stateReason(是什么问题) + next(用户能做的下一步),
 * 让调用方按态给不同的修复动作,而不是笼统地成功或报错。
 */

const fs = require('fs');

const S = require('./_shared');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

const _ADAPTERS = {
  opencode: './opencodeAdapter',
  openclaw: './openclawAdapter',
  'claude-code': './claudeCodeAdapter',
  reasonix: './reasonixAdapter',
  'deepseek-tui': './deepseekTuiAdapter',
  coze: './cozeAdapter',
};

const APPS = Object.keys(_ADAPTERS);

/** 门控:KHY_EXTERNAL_APP_IMPORT 默认开。flagRegistry 优先,叶子本地 CANON 回退(仅 {0,false,off,no} 关)。 */
function isEnabled(env = process.env) {
  try {
    const reg = require('../../../flagRegistry');
    if (reg && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_EXTERNAL_APP_IMPORT', env);
    }
  } catch {
    /* registry unavailable — local CANON fallback */
  }
  const raw = env && env.KHY_EXTERNAL_APP_IMPORT;
  const v = String(raw === undefined || raw === null ? 'true' : raw)
    .trim()
    .toLowerCase();
  return !_FALSY.has(v);
}

// 收敛到 utils/trimLowerCase 单一真源(逐字节委托,调用点不变)
const _normApp = require('../../../../utils/trimLowerCase');

function _adapterFor(app) {
  const mod = _ADAPTERS[_normApp(app)];
  if (!mod) {
    return null;
  }
  try {
    return require(mod);
  } catch {
    return null;
  }
}

/** poolKey = `<app>-<provider>`,规整为 registrar 认可的 `/^[a-z0-9][-a-z0-9]*$/`。 */
function _poolKey(app, providerId) {
  const raw = `${_normApp(app)}-${String(providerId || '').toLowerCase()}`;
  return raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** 可用性状态取值(design [DESIGN-MEM-009] §3 #9,解包结论 F09)。 */
const STATE_OK = 'ok';
const STATE_STALE = 'stale';
const STATE_REAUTH = 'reauth';
const STATE_UNSUPPORTED = 'unsupported';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 保鲜期(天):配置最后一次更新距今超过它就算「当前可用但不能保证一直可用」。
 * 阈值只从 env 取,源码不写数值——解包结论里没有任何可引用的天数,默认值待人裁决;
 * 未设该 env 时不按时间判 stale。
 */
function _staleDays(env = process.env) {
  const raw = env && env.KHY_EXTERNAL_APP_STALE_DAYS;
  if (raw == null || String(raw).trim() === '') {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** app 自带 key 优先,否则借 khy 池里同厂商 key(importApp 与可用性判定同一口径)。 */
function _resolveKey(id, appKey) {
  if (appKey) {
    return { key: appKey, source: 'app' };
  }
  try {
    const r = S.resolveApiKey(id, '');
    if (r && r.key) {
      return { key: r.key, source: r.source };
    }
  } catch {
    /* pool unavailable */
  }
  return { key: '', source: 'none' };
}

/** endpoint:app 自己的优先,否则 preset baseUrl(importApp 与可用性判定同一口径)。 */
function _resolveEndpoint(id, appEndpoint) {
  if (appEndpoint) {
    return appEndpoint;
  }
  try {
    return S.resolveEndpoint(id, '') || '';
  } catch {
    return '';
  }
}

/** 该外部软件在本机的配置位置(adapter 六件套里的 configPath);拿不到 → null。 */
function _configPathOf(adapter, env) {
  if (!adapter || typeof adapter.configPath !== 'function') {
    return null;
  }
  try {
    const p = adapter.configPath(env);
    return typeof p === 'string' ? p : '';
  } catch {
    return null;
  }
}

/** 配置位置在本机是否存在(不存在 = 该外部软件在当前设备上不可用)。 */
function _configExists(cfg) {
  if (!cfg) {
    return false;
  }
  try {
    return fs.existsSync(cfg);
  } catch {
    return false;
  }
}

/** 配置最后一次更新距今天数;读不到 → null(不按时间判 stale)。 */
function _configAgeDays(cfg) {
  if (!cfg) {
    return null;
  }
  try {
    const st = fs.statSync(cfg);
    const age = (Date.now() - st.mtimeMs) / MS_PER_DAY;
    return Number.isFinite(age) && age > 0 ? age : 0;
  } catch {
    return null;
  }
}

/**
 * 按 F09 三态给出导入可用性结论。判定顺序 unsupported > reauth > stale > ok。
 * @returns {{state:string, reason:string, next:string}}
 */
function _availability(app, adapter, res, env) {
  const cfg = _configPathOf(adapter, env);
  // configPath 拿不到(null)时不臆断「本机不支持」,只按 provider 事实判。
  if (cfg !== null && !_configExists(cfg)) {
    return {
      state: STATE_UNSUPPORTED,
      reason: `本机找不到 ${app} 的配置(${cfg || '未给出配置路径'})`,
      next: `本机没有 ${app} 的配置(找过 ${cfg || '未给出配置路径'}),该外部软件在当前设备不可用;安装并在其中配置模型后再导入`,
    };
  }

  const providers = (res && res.providers) || [];
  if (!providers.length) {
    return {
      state: STATE_STALE,
      reason: `${app} 的配置里没有可用 provider`,
      next: `${app} 的配置已存在但没有可用 provider,请在其中配置模型后重跑导入`,
    };
  }

  const missingKey = [];
  const missingSetup = [];
  for (const p of providers) {
    const id = String(p.id || '').toLowerCase();
    const key = _resolveKey(id, p.apiKey);
    const endpoint = _resolveEndpoint(id, p.endpoint);
    const model = p.defaultModel || (Array.isArray(p.models) && p.models[0]) || '';
    if (!key.key) {
      missingKey.push(id);
    } else if (!endpoint || !model) {
      missingSetup.push(`${id}(缺${!endpoint ? 'endpoint' : 'model'})`);
    }
  }
  if (missingKey.length) {
    return {
      state: STATE_REAUTH,
      reason: `provider ${missingKey.join('/')} 没有可用凭据`,
      next: `provider「${missingKey.join('」「')}」在 ${app} 与 khy 密钥池里都没有凭据,请在 ${app} 里重新登录或重新配置该厂商密钥后重跑导入`,
    };
  }
  if (missingSetup.length) {
    return {
      state: STATE_STALE,
      reason: `provider ${missingSetup.join('/')} 配置不完整`,
      next: `provider「${missingSetup.join('」「')}」配置不完整(缺 endpoint 或 model),请在 ${app} 里补齐后重跑导入`,
    };
  }

  const days = _staleDays(env);
  const age = days ? _configAgeDays(cfg) : null;
  if (age !== null && age > days) {
    const aged = Math.floor(age);
    return {
      state: STATE_STALE,
      reason: `${app} 的配置已 ${aged} 天未更新(保鲜期 ${days} 天)`,
      next: `${app} 的配置已 ${aged} 天未更新(保鲜期 ${days} 天),凭据可能已在 ${app} 侧失效,可用性无法保证;请在 ${app} 里确认或重新登录后再导入`,
    };
  }

  return {
    state: STATE_OK,
    reason: `${providers.length} 个 provider 的凭据/端点/模型齐备`,
    next: `${app} 的 ${providers.length} 个 provider 凭据齐备,可直接导入 khy`,
  };
}

/** 默认 registrar(真)。测试经 deps.registrar 注入 spy。 */
function _defaultRegistrar() {
  try {
    return require('../../../customProviderRegistrar');
  } catch {
    return null;
  }
}

/**
 * 发现单个 app 已配置的可用 provider(脱敏视图,供展示)。
 * @returns { success, app, state, stateReason, next, providers:[{id, endpoint, models, defaultModel, hasKey, keyMasked}] }
 */
function discover(app, env = process.env) {
  const normApp = _normApp(app);
  if (!isEnabled(env)) {
    return {
      success: false,
      app: normApp,
      state: STATE_UNSUPPORTED,
      stateReason: '外部模型导入被门控关闭(KHY_EXTERNAL_APP_IMPORT)',
      next: '外部模型导入已被门控关闭(KHY_EXTERNAL_APP_IMPORT):请先启用该开关再导入外部软件模型',
      error: '外部模型导入已被门控关闭（KHY_EXTERNAL_APP_IMPORT）',
      providers: [],
    };
  }
  const adapter = _adapterFor(app);
  if (!adapter || typeof adapter.usable !== 'function') {
    return {
      success: false,
      app: normApp,
      state: STATE_UNSUPPORTED,
      stateReason: `khy 不认识这个外部软件:${app || '(空)'}`,
      next: `khy 当前只支持 ${APPS.join(' / ')} 这 ${APPS.length} 个外部软件,请改用其中之一`,
      error: `不支持的外部软件: ${app || '(空)'}`,
      providers: [],
    };
  }
  try {
    const res = adapter.usable(env) || {};
    if (!res.success) {
      return {
        success: false,
        app: normApp,
        state: STATE_STALE,
        stateReason: `读取 ${normApp} 的配置失败:${res.error || 'usable failed'}`,
        next: `读取 ${normApp} 的配置失败(${res.error || 'usable failed'}):请检查该配置文件是否损坏,修好后重跑导入`,
        error: res.error || 'usable failed',
        providers: [],
      };
    }
    const providers = (res.providers || []).map((p) => ({
      id: p.id,
      endpoint: p.endpoint || '',
      models: Array.isArray(p.models) ? p.models.slice() : [],
      defaultModel: p.defaultModel || (p.models && p.models[0]) || '',
      hasKey: Boolean(p.apiKey),
      keyMasked: S.maskKey(p.apiKey || ''),
    }));
    const av = _availability(normApp, adapter, res, env);
    return {
      success: true,
      app: normApp,
      state: av.state,
      stateReason: av.reason,
      next: av.next,
      providers,
    };
  } catch (e) {
    const msg = String((e && e.message) || e);
    return {
      success: false,
      app: normApp,
      state: STATE_STALE,
      stateReason: `读取 ${normApp} 的配置抛错:${msg}`,
      next: `读取 ${normApp} 的配置抛错(${msg}):请确认该软件在本机可正常运行,修好后重跑导入`,
      error: msg,
      providers: [],
    };
  }
}

/** 遍历 6 app 聚合发现。 */
function discoverAll(env = process.env) {
  if (!isEnabled(env)) {
    return {
      success: false,
      state: STATE_UNSUPPORTED,
      stateReason: '外部模型导入被门控关闭(KHY_EXTERNAL_APP_IMPORT)',
      next: '外部模型导入已被门控关闭(KHY_EXTERNAL_APP_IMPORT):请先启用该开关再导入外部软件模型',
      error: '外部模型导入已被门控关闭（KHY_EXTERNAL_APP_IMPORT）',
      apps: [],
    };
  }
  const apps = APPS.map((app) => discover(app, env));
  return { success: true, apps };
}

/**
 * 把单个 app 的可用 provider 注册进 khy。
 * @param {object} opts { app, provider?(只导入指定 id), tier?, dryRun? }
 * @param {object} env
 * @param {object} deps { registrar? } 可注入 registrar 供测试
 * @returns { success, app, imported:[...], skipped:[...] }
 */
function importApp(opts = {}, env = process.env, deps = {}) {
  const app = _normApp(opts.app);
  if (!isEnabled(env)) {
    return {
      success: false,
      app,
      error: '外部模型导入已被门控关闭（KHY_EXTERNAL_APP_IMPORT）',
      imported: [],
      skipped: [],
    };
  }
  const adapter = _adapterFor(app);
  if (!adapter || typeof adapter.usable !== 'function') {
    return {
      success: false,
      app,
      error: `不支持的外部软件: ${opts.app || '(空)'}`,
      imported: [],
      skipped: [],
    };
  }
  const registrar = deps.registrar || _defaultRegistrar();
  if (!registrar || typeof registrar.registerCustomProvider !== 'function') {
    return {
      success: false,
      app,
      error: 'customProviderRegistrar 不可用',
      imported: [],
      skipped: [],
    };
  }

  const imported = [];
  const skipped = [];
  let raw;
  try {
    raw = adapter.usable(env) || {};
  } catch (e) {
    return { success: false, app, error: String((e && e.message) || e), imported: [], skipped: [] };
  }
  if (!raw.success) {
    return { success: false, app, error: raw.error || 'usable failed', imported: [], skipped: [] };
  }

  const wantOne = opts.provider ? String(opts.provider).toLowerCase() : '';
  for (const p of raw.providers || []) {
    const id = String(p.id || '').toLowerCase();
    if (wantOne && id !== wantOne) {
      continue;
    }

    // 密钥与 endpoint 的解析口径与可用性判定共用同一组函数(单一真源):
    // app 自己的真 key/endpoint 优先,否则借 khy 已存的同厂商 key / preset baseUrl。
    const { key, source: keySource } = _resolveKey(id, p.apiKey);
    const endpoint = _resolveEndpoint(id, p.endpoint);
    const models = Array.isArray(p.models) ? p.models.filter(Boolean) : [];
    const defaultModel = p.defaultModel || models[0] || '';

    // 缺任一必要字段 → 跳过(记原因,绝不半截注册)。
    if (!defaultModel) {
      skipped.push({ app, provider: id, reason: 'no model configured' });
      continue;
    }
    if (!endpoint) {
      skipped.push({ app, provider: id, reason: 'no endpoint (app 未配 + 无 preset)' });
      continue;
    }
    if (!key) {
      skipped.push({ app, provider: id, reason: 'no api key (app 未配 + khy 池无同厂商 key)' });
      continue;
    }

    const poolKey = _poolKey(app, id);
    if (opts.dryRun) {
      imported.push({
        app,
        provider: id,
        poolKey,
        models: models.length ? models : [defaultModel],
        defaultModel,
        endpoint,
        keySource,
        keyMasked: S.maskKey(key),
        dryRun: true,
      });
      continue;
    }
    try {
      const result = registrar.registerCustomProvider({
        displayName: `${app}:${id}`,
        poolKey,
        endpoint,
        keyInput: key,
        defaultModel,
        extraModels: models.filter((m) => m !== defaultModel),
        tier: opts.tier || '',
        ensureInit: true,
      });
      imported.push({
        app,
        provider: id,
        poolKey: (result && result.poolKey) || poolKey,
        models: (result && result.models) || models,
        defaultModel,
        endpoint: (result && result.endpoint) || endpoint,
        keySource,
        keyMasked: S.maskKey(key),
      });
    } catch (e) {
      skipped.push({ app, provider: id, reason: String((e && e.message) || e) });
    }
  }

  return { success: true, app, imported, skipped };
}

/** 遍历 6 app 全部导入。 */
function importAll(opts = {}, env = process.env, deps = {}) {
  if (!isEnabled(env)) {
    return {
      success: false,
      error: '外部模型导入已被门控关闭（KHY_EXTERNAL_APP_IMPORT）',
      imported: [],
      skipped: [],
    };
  }
  const imported = [];
  const skipped = [];
  for (const app of APPS) {
    const r = importApp({ app, tier: opts.tier, dryRun: opts.dryRun }, env, deps);
    if (r && Array.isArray(r.imported)) {
      imported.push(...r.imported);
    }
    if (r && Array.isArray(r.skipped)) {
      skipped.push(...r.skipped);
    }
  }
  return { success: true, imported, skipped };
}

/**
 * 反注册一个已导入的外部 app 模型(khy 消费侧撤销)。
 * @param {object} opts { app, provider, removeKeys? }
 */
function unimport(opts = {}, env = process.env, deps = {}) {
  const app = _normApp(opts.app);
  if (!isEnabled(env)) {
    return { success: false, app, error: '外部模型导入已被门控关闭（KHY_EXTERNAL_APP_IMPORT）' };
  }
  const id = String(opts.provider || '').toLowerCase();
  if (!id) {
    return { success: false, app, error: 'provider is required' };
  }
  const registrar = deps.registrar || _defaultRegistrar();
  if (!registrar || typeof registrar.unregisterCustomProvider !== 'function') {
    return { success: false, app, error: 'customProviderRegistrar 不可用' };
  }
  const poolKey = _poolKey(app, id);
  try {
    const result = registrar.unregisterCustomProvider(poolKey, {
      removeKeys: opts.removeKeys === true,
    });
    return {
      success: true,
      app,
      provider: id,
      poolKey,
      removeKeys: opts.removeKeys === true,
      result,
    };
  } catch (e) {
    return { success: false, app, provider: id, poolKey, error: String((e && e.message) || e) };
  }
}

module.exports = {
  isEnabled,
  discover,
  discoverAll,
  importApp,
  importAll,
  unimport,
  APPS,
  _poolKey,
};
