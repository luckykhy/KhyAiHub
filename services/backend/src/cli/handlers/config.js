/**
 * config.js — Model and runtime configuration management
 *
 * Provides get/set/list operations for persistent configuration keys
 * (model provider, API URL, language preference, etc.) stored in
 * the project .env file.
 *
 * @module handlers/config
 */
'use strict';

// ── Imports ──

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseApiKeyEntries, extractPrimaryApiKey } = require('../../services/apiKeyFormat');

// ── Constants ──

const SUPPORTED_CONFIG_KEYS = Object.freeze([
  'model.provider',
  'model.base_url',
  'model.api_key',
  'model.name',
  'model.default',
  'model.endpoint_compatibility',
  'language.preference',
]);

const KEY_ALIASES = Object.freeze({
  'model.provider': 'model.provider',
  model_provider: 'model.provider',
  'model.base_url': 'model.base_url',
  model_base_url: 'model.base_url',
  'model.api_key': 'model.api_key',
  model_api_key: 'model.api_key',
  'model.name': 'model.name',
  model_name: 'model.name',
  'model.default': 'model.default',
  model_default: 'model.default',
  'model.auth_provider': 'model.provider',
  model_auth_provider: 'model.provider',
  'model.api_base_url': 'model.base_url',
  model_api_base_url: 'model.base_url',
  'model.model_id': 'model.name',
  model_model_id: 'model.name',
  'model.endpoint_compatibility': 'model.endpoint_compatibility',
  model_endpoint_compatibility: 'model.endpoint_compatibility',
  language: 'language.preference',
  lang: 'language.preference',
  'language.preference': 'language.preference',
  language_preference: 'language.preference',
  languagepreference: 'language.preference',
});

const PROVIDER_TO_ADAPTER = Object.freeze({
  custom: 'relay_api',
  relay: 'relay_api',
  relay_api: 'relay_api',
  relayapi: 'relay_api',
  openai_compatible: 'relay_api',
  'openai-compatible': 'relay_api',

  auto: 'auto',
  ollama: 'ollama',
  localllm: 'localllm',
  local: 'localllm',
  claude: 'claude',
  codex: 'codex',
  kiro: 'kiro',
  cursor: 'cursor',
  trae: 'trae',
  api: 'api',
  webrelay: 'relay',
  browserrelay: 'relay',
});

function _adapterToProvider(adapter) {
  const key = String(adapter || '')
    .trim()
    .toLowerCase();
  if (!key) {
    return '';
  }
  if (key === 'relay_api') {
    return 'custom';
  }
  return key;
}

function _normalizeKey(rawKey = '') {
  const raw = String(rawKey || '')
    .trim()
    .toLowerCase();
  if (!raw) {
    return '';
  }
  const compact = raw.replace(/[\s-]+/g, '_');
  return KEY_ALIASES[raw] || KEY_ALIASES[compact] || '';
}

function _resolveAdapterFromProvider(rawProvider = '') {
  const provider = String(rawProvider || '')
    .trim()
    .toLowerCase();
  if (!provider) {
    return '';
  }
  const compact = provider.replace(/\s+/g, '').replace(/-/g, '_');
  return PROVIDER_TO_ADAPTER[provider] || PROVIDER_TO_ADAPTER[compact] || '';
}

// 收敛到 utils/normalizeCompatibility 单一真源(逐字节委托,调用点不变)
const _normalizeCompatibility = require('../../utils/normalizeCompatibility');

// 语言偏好归一收敛到纯叶子单一真源(SSOT),与 /lang 命令面、prompts.js
// getLanguageSection 共用同一归一逻辑;此处保留薄包装以维持调用点不变。
function _normalizeLanguagePreference(raw = '') {
  return require('../../services/domain/config/config/langPreference.js').normalizeLanguage(raw);
}

function _pickFirstNonEmpty(...candidates) {
  for (const item of candidates) {
    if (item === undefined || item === null) {
      continue;
    }
    const text = String(item).trim();
    if (!text || text === 'true') {
      continue;
    }
    return text;
  }
  return '';
}

function _normalizeOpenAiLikeBaseUrl(raw = '') {
  const input = String(raw || '').trim();
  if (!input) {
    return { ok: false, error: 'empty' };
  }
  let parsed = null;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: 'invalid-url' };
  }
  const protocol = String(parsed.protocol || '').toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, error: 'invalid-protocol' };
  }

  let pathname = String(parsed.pathname || '').replace(/\/+$/g, '');
  let appendedV1 = false;
  if (!pathname) {
    pathname = '/v1';
    appendedV1 = true;
  } else if (!/\/v1$/i.test(pathname)) {
    pathname = `${pathname}/v1`;
    appendedV1 = true;
  }
  parsed.pathname = pathname;
  parsed.search = '';
  parsed.hash = '';

  const normalized = parsed.toString().replace(/\/$/, '');
  return { ok: true, url: normalized, appendedV1 };
}

function _resolveDefaultOpenCodeConfigPath() {
  return path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
}

function _readJsonFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

function _resolveOpenCodeProfileFromConfig(doc, opts = {}) {
  if (!doc || typeof doc !== 'object') {
    return { ok: false, error: 'invalid-doc' };
  }
  const providerMap = doc.provider && typeof doc.provider === 'object' ? doc.provider : {};
  const providerKeys = Object.keys(providerMap);
  if (providerKeys.length === 0) {
    return { ok: false, error: 'provider-empty' };
  }

  const requestedProvider = String(opts.providerId || '').trim();
  const providerId = requestedProvider || providerKeys[0];
  const provider = providerMap[providerId];
  if (!provider || typeof provider !== 'object') {
    return { ok: false, error: `provider-missing:${providerId}` };
  }

  const providerOptions =
    provider.options && typeof provider.options === 'object' ? provider.options : {};
  const modelMap = provider.models && typeof provider.models === 'object' ? provider.models : {};
  const modelKeys = Object.keys(modelMap);
  const requestedModel = String(opts.modelId || '').trim();
  const modelId = requestedModel || modelKeys[0] || '';
  if (!modelId) {
    return { ok: false, error: 'model-empty' };
  }

  const baseUrl = _pickFirstNonEmpty(
    providerOptions.baseURL,
    providerOptions.baseUrl,
    providerOptions.url,
    providerOptions.endpoint
  );
  const apiKeyInput = _pickFirstNonEmpty(providerOptions.apiKey, providerOptions.apikey);
  const npmProvider = String(provider.npm || '')
    .trim()
    .toLowerCase();
  const compatibility = npmProvider.includes('anthropic') ? 'anthropic' : 'openai';

  return {
    ok: true,
    providerId,
    modelId,
    baseUrl,
    apiKeyInput,
    compatibility,
  };
}

const _patchEnvContent = require('../../utils/patchEnvContent');
const _resolveEnvPaths = require('../../utils/resolveGatewayEnvPaths');

function _writeEnvPatch(envMap = {}, unsetKeys = [], options = {}) {
  const { canonicalPath, targets: defaultTargets } = _resolveEnvPaths();
  const targetPath = options.envPath ? path.resolve(options.envPath) : canonicalPath;
  const targets = options.envPath ? [targetPath] : defaultTargets;

  const written = [];
  for (const file of targets) {
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      /* no .env yet */
    }
    const patched = _patchEnvContent(content, envMap, unsetKeys);
    try {
      fs.writeFileSync(file, patched);
      written.push(file);
    } catch (err) {
      // Repro hci-r41: with [canonical, mirror] the first file can land while the
      // second throws — callers must be able to tell「全未写入」from a half-patched
      // pair, or the failure receipt says the opposite of the disk truth.
      err.envWriteWritten = written.slice();
      err.envWriteFailed = file;
      throw err;
    }
  }

  for (const [key, value] of Object.entries(envMap)) {
    process.env[key] = String(value);
  }
  for (const key of unsetKeys) {
    delete process.env[key];
  }
  return targetPath;
}

/**
 * Guarded wrapper for `_writeEnvPatch`: a failing .env write must surface as an
 * honest receipt (plain-text two lines, or a valid `ok:false` JSON contract line)
 * instead of a raw errno escaping to whoever happens to catch it. Repro hci-r40:
 * json mode printed NOTHING and rc stayed 0.
 * Repro hci-r41 adds the third state: with the canonical+mirror dual write, the
 * first file may already be on disk when the second throws — saying「未写入」then
 * is the reverse-direction lie (the change WILL apply after restart).
 * @returns {string|null} envPath on success, null after reporting the failure.
 */
function _tryEnvPatchOrReport(envMap, unsetKeys, { asJson = false, action = 'set' } = {}) {
  try {
    return _writeEnvPatch(envMap, unsetKeys);
  } catch (err) {
    const errno = err && err.message ? err.message : String(err);
    const written = Array.isArray(err && err.envWriteWritten) ? err.envWriteWritten : [];
    const failed = (err && err.envWriteFailed) || (err && err.path) || '另一份 .env';
    if (asJson) {
      _emitConfigJson(
        written.length > 0
          ? { ok: false, action, error: 'env_write_partial', written, failed, message: errno }
          : { ok: false, action, error: 'env_write_failed', message: errno }
      );
    } else {
      const detail = err && err.path ? `:\n  ${err.path}` : '';
      printError(`配置未能持久化：${errno}`);
      if (written.length > 0) {
        printError(
          `半写入：${written.join('、')} 已更新——该项重启后会按新值生效；${failed} 未写入，两份 .env 已不一致。` +
            `请把已写入的内容同步到未写入的一份，或恢复其可写后重跑本命令${detail}`
        );
      } else {
        printError(
          `未写入 .env(重启后不生效)。请确认 .env 目标路径的父目录存在且可写,或取消 KHY_ENV_FILE 覆盖后重试${detail}`
        );
      }
    }
    return null;
  }
}

function _readEnvMap(envPath) {
  const out = {};
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return out;
  }
  for (const line of String(content || '').split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) {
      continue;
    }
    const idx = line.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    if (!key) {
      continue;
    }
    const rawValue = line.slice(idx + 1).trim();
    out[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
  return out;
}

// 收敛到 utils/maskSecret 单一真源(逐字节委托,调用点不变)
const _maskSecret = require('../../utils/maskSecret');
const { printSuccess, printError, printInfo, printWarn, printTable } = require('../formatters');
const _markFailure = require('../../utils/markProcessFailure');

function _parseModelDefault(value = '') {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  const idx = raw.indexOf('/');
  if (idx <= 0 || idx >= raw.length - 1) {
    return null;
  }
  const provider = raw.slice(0, idx).trim();
  const model = raw.slice(idx + 1).trim();
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}

function _readCurrentModelConfig() {
  const { canonicalPath } = _resolveEnvPaths();
  const envMap = _readEnvMap(canonicalPath);
  const read = (key) => {
    const runtime = process.env[key];
    if (runtime !== undefined && String(runtime).trim() !== '') {
      return String(runtime).trim();
    }
    return String(envMap[key] || '').trim();
  };

  const preferredAdapter = read('GATEWAY_PREFERRED_ADAPTER');
  const preferredModel = read('GATEWAY_PREFERRED_MODEL');
  const relayEndpoint = read('RELAY_API_ENDPOINT');
  const relayApiKey = read('RELAY_API_KEY');
  const relayModel = read('RELAY_API_MODEL');
  const relayCompatibility = read('RELAY_API_COMPATIBILITY');
  const languagePreference = read('KHY_LANGUAGE');

  const provider = _adapterToProvider(
    preferredAdapter || (relayEndpoint || relayApiKey || relayModel ? 'relay_api' : '')
  );
  const defaultModel =
    preferredModel || (String(preferredAdapter).toLowerCase() === 'relay_api' ? relayModel : '');
  const modelDefault = provider && defaultModel ? `${provider}/${defaultModel}` : '';
  const compatibility =
    relayCompatibility ||
    (String(preferredAdapter).toLowerCase() === 'relay_api' ? 'openai' : '(not set)');

  return {
    envPath: canonicalPath,
    values: {
      'model.provider': provider || '(not set)',
      'model.base_url': relayEndpoint || '(not set)',
      'model.api_key': relayApiKey ? _maskSecret(relayApiKey) : '(not set)',
      'model.name': relayModel || '(not set)',
      'model.default': modelDefault || '(not set)',
      'model.endpoint_compatibility': compatibility || '(not set)',
      'language.preference': languagePreference || 'auto',
    },
    raw: {
      preferredAdapter,
      preferredModel,
      relayEndpoint,
      relayApiKey,
      relayModel,
      relayCompatibility,
      languagePreference,
    },
  };
}

function _emitConfigJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function _printUsage() {
  printInfo('用法:');
  printInfo('  khy config set model.provider custom');
  printInfo('  khy config set model.base_url https://your-provider.com/v1');
  printInfo('  khy config set model.api_key sk-xxxxx');
  printInfo('  khy config set model.name your-model-id');
  printInfo('  khy config set model.default custom/your-model-id');
  printInfo('  khy config set language zh|en|auto');
  printInfo(
    '  khy config openclaw --custom-base-url https://your-provider.com/v1 --custom-model-id <your-model-id> --custom-api-key sk-xxxxx'
  );
  printInfo(
    '  khy config opencode --base-url https://your-provider.com/v1 --model-id <your-model-id> --api-key sk-xxxxx'
  );
  printInfo(
    '  khy config opencode --config ~/.config/opencode/opencode.json --provider <provider-name>'
  );
  printInfo('  khy config get model.default');
  printInfo('  khy config get language');
  printInfo('  khy config show');
  printInfo('  khy config list');
  printInfo('  khy config layers   （显示分层 settings.json 解析结果与逐键来源）');
  printInfo('交互式向导：khy setup（完整配置）/ khy model（仅模型）');
}

function _printSupportedProviders() {
  printInfo(
    '支持的通道: custom, auto, ollama, localllm, claude, codex, kiro, cursor, trae, api, relay'
  );
}

// ── GLM 视觉池自动镜像 ──────────────────────────────────────────────────────
// 门控 KHY_GLM_VISION_POOL_MIRROR(默认开;0/false/off/no → 关,逐字节回退旧行为)。
//
// 背景/实测根因(「文本对话正常、识图恒 ECONNRESET/404」):`khy config set
// model.base_url/api_key/name` 把 key 写进 relay 池(RELAY_API_KEY),文本经该池的
// bigmodel 端点正常;但识图工具用 `glm/glm-4.6v-flash` 请求,把请求定向到智谱视觉端点
// 的那道 api-pin(aiGateway.js:4313)有一道前置闸门——只在**专用 glm 池**有 key
// (GLM_API_KEY,apiKeyPool.js:67)时才触发。用户的 key 在 relay 池、glm 池为空 →
// pin 不触发 → 视觉请求落进通用级联被 OpenAI/api 抢答 → ECONNRESET/404。
//
// 修复:当 relay 端点确为智谱 bigmodel(open.bigmodel.cn)时,把同一把 key 镜像进
// glm 池,使 hasAvailableKeys('glm') 为真、视觉 pin 得以定向到 bigmodel(文本已证明这条
// 通道通)。安全契约:①仅在端点确为 bigmodel 且有 key 时介入;②create-missing-only ——
// glm 池已有独立 key 时绝不覆盖(用户显式配置优先),唯一例外是「我方先前镜像的值」
// (旧 GLM_API_KEY === 旧 RELAY_API_KEY)可随 key 轮换而更新;③fail-soft,任何异常 → 不镜像。
function _glmVisionPoolMirrorEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_GLM_VISION_POOL_MIRROR;
    if (raw == null || String(raw).trim() === '') {
      return true;
    } // 缺省 → 默认开
    const v = String(raw).trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  } catch {
    return false;
  }
}

// 端点是否为智谱 bigmodel(GLM 视觉模型确实存在处)。
function _isBigmodelEndpoint(endpoint) {
  const e = String(endpoint || '')
    .trim()
    .toLowerCase();
  if (!e) {
    return false;
  }
  return e.includes('bigmodel.cn');
}

// 就地把 relay 池的 bigmodel key 镜像进 glm 池(envMap 追加 GLM_API_KEY/GLM_API_ENDPOINT)。
// 取「本次 envMap 值 → 回退 process.env」作为生效后的端点/ key,故无论用户先设 base_url
// 还是先设 api_key,只要二者齐备且端点为 bigmodel 即镜像。绝不抛。
function _maybeMirrorGlmVisionPool(envMap, env = process.env) {
  try {
    if (!_glmVisionPoolMirrorEnabled(env)) {
      return;
    }
    const endpoint = String(
      envMap.RELAY_API_ENDPOINT != null ? envMap.RELAY_API_ENDPOINT : env.RELAY_API_ENDPOINT || ''
    ).trim();
    if (!_isBigmodelEndpoint(endpoint)) {
      return;
    }
    const key = String(
      envMap.RELAY_API_KEY != null ? envMap.RELAY_API_KEY : env.RELAY_API_KEY || ''
    ).trim();
    if (!key) {
      return;
    }
    const existingGlmKey = String(env.GLM_API_KEY || '').trim();
    const priorRelayKey = String(env.RELAY_API_KEY || '').trim();
    // 空 → 填补;或「我方先前镜像的值」(等于旧 relay key)→ 随轮换更新;
    // 否则(用户显式独立 GLM_API_KEY)→ 保持不动。
    const ownMirror = !!existingGlmKey && existingGlmKey === priorRelayKey;
    if (!existingGlmKey || ownMirror) {
      envMap.GLM_API_KEY = key;
      envMap.GLM_API_ENDPOINT = endpoint;
    }
  } catch {
    /* fail-soft: 不镜像 */
  }
}

function _applyConfigSet(key, value, options = {}) {
  const asJson = !!options.json;
  const canonicalKey = _normalizeKey(key);
  if (!canonicalKey) {
    if (asJson) {
      _emitConfigJson({
        ok: false,
        action: 'set',
        key: String(key || ''),
        error: 'unsupported_key',
        message: `Unsupported key: ${key}`,
        supportedKeys: SUPPORTED_CONFIG_KEYS,
      });
    } else {
      printError(`不支持的配置键：${key}`);
      printInfo(`支持的配置键：${SUPPORTED_CONFIG_KEYS.join(', ')}`);
    }
    return false;
  }
  if (!String(value || '').trim()) {
    if (asJson) {
      _emitConfigJson({
        ok: false,
        action: 'set',
        key: canonicalKey,
        error: 'missing_value',
        message: `Missing value for ${canonicalKey}`,
      });
    } else {
      printError(`缺少 ${canonicalKey} 的值：请运行 khy config set <键> <值>`);
    }
    return false;
  }

  const envMap = {};
  const unsetKeys = [];
  let successMessage = '';
  const warnings = [];

  if (canonicalKey === 'model.provider') {
    const adapter = _resolveAdapterFromProvider(value);
    if (!adapter) {
      if (asJson) {
        _emitConfigJson({
          ok: false,
          action: 'set',
          key: canonicalKey,
          error: 'unsupported_provider',
          message: `Unsupported provider: ${value}`,
        });
      } else {
        printError(`不支持的通道：${value}`);
        _printSupportedProviders();
      }
      return false;
    }
    // RUNTIME-006:钉真实通道必须同时写 STRICT=false（首选但不抑制级联回退）。
    // 与 `cli/handlers/gateway.js` 的 persistGatewayPreference 保持同一语义 —— 两条入口
    // 都是「用户显式钉选」的正规路径，写 'true' 会触发网关的钉选租约把 .env 自动改回 auto，
    // 用户刚钉的通道被静默抹掉（事故史 codex→windsurf→windsurf→api→api→claude 的复发机制）。
    envMap.GATEWAY_PREFERRED_ADAPTER = adapter;
    envMap.GATEWAY_PREFERRED_STRICT = 'false';
    if (adapter === 'auto') {
      unsetKeys.push('GATEWAY_PREFERRED_MODEL');
    }
    successMessage = `已设置 model.provider=${_adapterToProvider(adapter)}`;
  } else if (canonicalKey === 'model.base_url') {
    const endpoint = String(value || '').trim();
    if (!/^https?:\/\//i.test(endpoint)) {
      if (asJson) {
        _emitConfigJson({
          ok: false,
          action: 'set',
          key: canonicalKey,
          error: 'invalid_base_url',
          message: 'model.base_url must start with http:// or https://',
        });
      } else {
        printError('model.base_url 必须以 http:// 或 https:// 开头');
      }
      return false;
    }
    envMap.RELAY_API_ENDPOINT = endpoint;
    envMap.GATEWAY_PREFERRED_ADAPTER = 'relay_api';
    // 不硬钉 strict：relay 端点优先但可回退，避免死端点拖垮整轮（放宽逻辑见 aiGateway 死端点分支）。
    envMap.GATEWAY_PREFERRED_STRICT = 'false';
    successMessage = `已设置 model.base_url=${endpoint}`;
  } else if (canonicalKey === 'model.api_key') {
    const parsedEntries = parseApiKeyEntries(value);
    const primaryKey = extractPrimaryApiKey(value);
    const primary = String(primaryKey || (parsedEntries[0] && parsedEntries[0].key) || '').trim();
    if (!primary) {
      if (asJson) {
        _emitConfigJson({
          ok: false,
          action: 'set',
          key: canonicalKey,
          error: 'empty_api_key',
          message: 'model.api_key is empty after parsing',
        });
      } else {
        printError('model.api_key 解析后为空：请运行 khy config set model.api_key <密钥> 重新输入');
      }
      return false;
    }
    envMap.RELAY_API_KEY = primary;
    envMap.GATEWAY_PREFERRED_ADAPTER = 'relay_api';
    // 不硬钉 strict：relay 优先但可回退（见 aiGateway 死端点放宽）。
    envMap.GATEWAY_PREFERRED_STRICT = 'false';
    if (parsedEntries.length > 1) {
      envMap.RELAY_API_KEYS = parsedEntries.map((entry) => entry.key).join(',');
    } else {
      unsetKeys.push('RELAY_API_KEYS');
    }
    successMessage =
      parsedEntries.length > 1
        ? `已设置 model.api_key（解析出 ${parsedEntries.length} 个密钥，主密钥=${_maskSecret(primary)}）`
        : '已设置 model.api_key';
  } else if (canonicalKey === 'model.name') {
    const modelName = String(value || '').trim();
    envMap.RELAY_API_MODEL = modelName;
    envMap.GATEWAY_PREFERRED_MODEL = modelName;
    envMap.GATEWAY_PREFERRED_ADAPTER = 'relay_api';
    // 不硬钉 strict：relay 优先但可回退（见 aiGateway 死端点放宽）。
    envMap.GATEWAY_PREFERRED_STRICT = 'false';
    successMessage = `已设置 model.name=${modelName}`;
  } else if (canonicalKey === 'model.endpoint_compatibility') {
    const compatibility = _normalizeCompatibility(value);
    if (!compatibility) {
      if (asJson) {
        _emitConfigJson({
          ok: false,
          action: 'set',
          key: canonicalKey,
          error: 'unsupported_endpoint_compatibility',
          message: `Unsupported endpoint compatibility: ${value}`,
        });
      } else {
        printError(`不支持的端点兼容模式：${value}`);
        printInfo('可选值：openai-compatible、anthropic-compatible 或 unknown');
      }
      return false;
    }
    envMap.GATEWAY_PREFERRED_ADAPTER = 'relay_api';
    // 不硬钉 strict：relay 优先但可回退（见 aiGateway 死端点放宽）。
    envMap.GATEWAY_PREFERRED_STRICT = 'false';
    envMap.RELAY_API_COMPATIBILITY = compatibility;
    if (compatibility === 'anthropic') {
      warnings.push(
        'Current relay adapter sends OpenAI-style /chat/completions payloads. Anthropic-only endpoints may fail.'
      );
    }
    successMessage = `已设置 model.endpoint_compatibility=${compatibility}`;
  } else if (canonicalKey === 'model.default') {
    const parsed = _parseModelDefault(value);
    if (!parsed) {
      if (asJson) {
        _emitConfigJson({
          ok: false,
          action: 'set',
          key: canonicalKey,
          error: 'invalid_model_default',
          message: 'model.default must be <provider>/<model>, e.g. custom/your-model-id',
        });
      } else {
        printError('model.default 必须形如 <provider>/<model>，例如 custom/your-model-id');
      }
      return false;
    }
    const adapter = _resolveAdapterFromProvider(parsed.provider);
    if (!adapter) {
      if (asJson) {
        _emitConfigJson({
          ok: false,
          action: 'set',
          key: canonicalKey,
          error: 'unsupported_provider_in_model_default',
          message: `Unsupported provider in model.default: ${parsed.provider}`,
        });
      } else {
        printError(`model.default 中的通道不支持：${parsed.provider}`);
        _printSupportedProviders();
      }
      return false;
    }
    envMap.GATEWAY_PREFERRED_ADAPTER = adapter;
    envMap.GATEWAY_PREFERRED_MODEL = parsed.model;
    // RUNTIME-006:钉真实通道必须同时写 STRICT=false（首选但不抑制级联回退），
    // 与上面的 model.provider 分支及 gateway.js 的 persistGatewayPreference 同一语义。
    envMap.GATEWAY_PREFERRED_STRICT = 'false';
    if (adapter === 'relay_api') {
      envMap.RELAY_API_MODEL = parsed.model;
    }
    successMessage = `已设置 model.default=${_adapterToProvider(adapter)}/${parsed.model}`;
  } else if (canonicalKey === 'language.preference') {
    const language = _normalizeLanguagePreference(value);
    if (!language) {
      if (asJson) {
        _emitConfigJson({
          ok: false,
          action: 'set',
          key: canonicalKey,
          error: 'unsupported_language_value',
          message: `Unsupported language value: ${value}`,
        });
      } else {
        printError(`不支持的语言取值：${value}`);
        printInfo('可选值：zh、en 或 auto');
      }
      return false;
    }
    if (language === 'auto') {
      unsetKeys.push('KHY_LANGUAGE');
      successMessage = '已设置 language.preference=auto';
    } else {
      envMap.KHY_LANGUAGE = language;
      successMessage = `已设置 language.preference=${language}`;
    }
  }

  // relay 端点若为智谱 bigmodel,把 key 镜像进 glm 池,让识图的视觉 api-pin 得以触发
  // (内部自带 bigmodel 端点 + key 存在 + 门控三重守卫,不相关的 set 为 no-op)。
  _maybeMirrorGlmVisionPool(envMap);

  const envPath = _tryEnvPatchOrReport(envMap, unsetKeys, { asJson, action: 'set' });
  if (envPath === null) return false; // 走既有 false → _markFailure 通道
  const snapshot = _readCurrentModelConfig();
  const publicValue = snapshot.values[canonicalKey];
  if (asJson) {
    _emitConfigJson({
      ok: true,
      action: 'set',
      key: canonicalKey,
      value: publicValue === undefined ? '(not set)' : publicValue,
      envPath,
      warnings,
    });
  } else {
    for (const warning of warnings) {
      printWarn(warning);
    }
    printSuccess(successMessage);
    printInfo(`已保存到：${envPath}`);
  }
  return true;
}

function _handleConfigOpenClaw(args = [], options = {}) {
  const asJson = !!options.json;
  const baseUrl = _pickFirstNonEmpty(
    options['custom-base-url'],
    options.customBaseUrl,
    options['base-url'],
    options.base_url,
    args[0]
  );
  const modelId = _pickFirstNonEmpty(
    options['custom-model-id'],
    options.customModelId,
    options['model-id'],
    options.modelId,
    options.model,
    args[1]
  );
  const apiKeyInput = _pickFirstNonEmpty(
    options['custom-api-key'],
    options.customApiKey,
    options['api-key'],
    options.apiKey,
    options.key,
    args[2],
    process.env.CUSTOM_API_KEY
  );
  const compatibilityRaw = _pickFirstNonEmpty(
    options['custom-compatibility'],
    options.customCompatibility,
    options.compatibility,
    options.compat,
    options['endpoint-compatibility'],
    options.endpointCompatibility,
    'openai'
  );
  const compatibility = _normalizeCompatibility(compatibilityRaw);
  const warnings = [];

  if (!baseUrl || !modelId) {
    if (asJson) {
      _emitConfigJson({
        ok: false,
        action: 'openclaw',
        error: 'missing_base_url_or_model_id',
        message: 'OpenClaw-compatible setup requires base URL and model ID.',
      });
    } else {
      printError('OpenClaw 兼容配置需要端点 URL 与模型 ID。');
      printInfo(
        '用法: khy config openclaw --custom-base-url <url> --custom-model-id <model> [--custom-api-key <key>] [--custom-compatibility openai|anthropic]'
      );
    }
    return false;
  }
  if (!compatibility) {
    if (asJson) {
      _emitConfigJson({
        ok: false,
        action: 'openclaw',
        error: 'invalid_compatibility',
        message: `Invalid compatibility: ${compatibilityRaw}`,
      });
    } else {
      printError(`无效的兼容模式：${compatibilityRaw}`);
      printInfo('可选值：openai、anthropic 或 unknown');
    }
    return false;
  }

  const baseUrlNormalized = _normalizeOpenAiLikeBaseUrl(baseUrl);
  if (!baseUrlNormalized.ok) {
    if (asJson) {
      _emitConfigJson({
        ok: false,
        action: 'openclaw',
        error: 'invalid_base_url',
        message: 'Invalid custom base URL.',
      });
    } else {
      printError('自定义端点 URL 无效。');
      printInfo('请使用有效的 http(s) URL，例如 https://your-provider.com/v1');
    }
    return false;
  }
  if (baseUrlNormalized.appendedV1) {
    warnings.push(`Base URL did not end with /v1. Auto-normalized to: ${baseUrlNormalized.url}`);
  }

  const parsedEntries = parseApiKeyEntries(apiKeyInput);
  const primaryKey = extractPrimaryApiKey(apiKeyInput);
  const primary = String(primaryKey || (parsedEntries[0] && parsedEntries[0].key) || '').trim();
  const envMap = {
    GATEWAY_PREFERRED_ADAPTER: 'relay_api',
    // RUNTIME-006:relay 优先但可回退（与 model.base_url 分支同一口径，避免死端点拖垮整轮）。
    GATEWAY_PREFERRED_STRICT: 'false',
    GATEWAY_PREFERRED_MODEL: modelId,
    RELAY_API_ENDPOINT: baseUrlNormalized.url,
    RELAY_API_MODEL: modelId,
    RELAY_API_COMPATIBILITY: compatibility,
  };
  const unsetKeys = [];
  if (primary) {
    envMap.RELAY_API_KEY = primary;
    if (parsedEntries.length > 1) {
      envMap.RELAY_API_KEYS = parsedEntries.map((entry) => entry.key).join(',');
    } else {
      unsetKeys.push('RELAY_API_KEYS');
    }
  } else {
    warnings.push(
      'No API key provided. This mirrors OpenClaw optional custom API key mode; runtime may require credentials.'
    );
    unsetKeys.push('RELAY_API_KEY', 'RELAY_API_KEYS');
  }

  const envPath = _tryEnvPatchOrReport(envMap, unsetKeys, { asJson, action: 'openclaw' });
  if (envPath === null) return false;
  if (compatibility === 'anthropic') {
    warnings.push(
      'Current relay adapter uses OpenAI-style requests; anthropic-only endpoints may fail without a compatible bridge.'
    );
  }
  if (asJson) {
    _emitConfigJson({
      ok: true,
      action: 'openclaw',
      provider: 'custom',
      modelId,
      endpoint: baseUrlNormalized.url,
      compatibility,
      envPath,
      warnings,
    });
  } else {
    for (const warning of warnings) {
      printWarn(warning);
    }
    printSuccess(`已应用 OpenClaw 兼容的自定义通道配置：custom/${modelId}`);
    printInfo(`端点兼容模式：${compatibility}`);
    printInfo(`已保存到：${envPath}`);
  }
  return true;
}

function _handleConfigOpenCode(args = [], options = {}) {
  const asJson = !!options.json;
  const configPathRaw = _pickFirstNonEmpty(
    options.config,
    options.file,
    options['config-file'],
    options.opencodeConfig
  );
  const resolvedConfigPath = configPathRaw
    ? path.resolve(String(configPathRaw))
    : _resolveDefaultOpenCodeConfigPath();
  const providerIdFlag = _pickFirstNonEmpty(
    options.provider,
    options['provider-id'],
    options.providerId
  );
  const modelIdFlag = _pickFirstNonEmpty(
    options['model-id'],
    options.modelId,
    options.model,
    args[0]
  );
  const baseUrlFlag = _pickFirstNonEmpty(
    options['base-url'],
    options.baseUrl,
    options.baseURL,
    options.url,
    args[1]
  );
  const apiKeyFlag = _pickFirstNonEmpty(options['api-key'], options.apiKey, options.key, args[2]);
  const compatibilityRaw = _pickFirstNonEmpty(
    options.compatibility,
    options.compat,
    options['endpoint-compatibility'],
    'openai'
  );
  const compatibilityFlag = _normalizeCompatibility(compatibilityRaw);
  const warnings = [];
  if (!compatibilityFlag) {
    if (asJson) {
      _emitConfigJson({
        ok: false,
        action: 'opencode',
        error: 'invalid_compatibility',
        message: `Invalid compatibility: ${compatibilityRaw}`,
      });
    } else {
      printError(`无效的兼容模式：${compatibilityRaw}`);
      printInfo('可选值：openai、anthropic 或 unknown');
    }
    return false;
  }

  let profile = null;
  const shouldReadProfile = !!configPathRaw || !baseUrlFlag || !modelIdFlag;
  if (shouldReadProfile) {
    if (fs.existsSync(resolvedConfigPath)) {
      const readResult = _readJsonFile(resolvedConfigPath);
      if (!readResult.ok) {
        if (asJson) {
          _emitConfigJson({
            ok: false,
            action: 'opencode',
            error: 'config_parse_failed',
            message: `Failed to parse OpenCode config: ${resolvedConfigPath}`,
          });
        } else {
          printError(`解析 OpenCode 配置失败：${resolvedConfigPath}`);
          printInfo(`解析错误：${readResult.error.message || String(readResult.error)}`);
        }
        return false;
      }
      const extracted = _resolveOpenCodeProfileFromConfig(readResult.value, {
        providerId: providerIdFlag,
        modelId: modelIdFlag,
      });
      if (!extracted.ok) {
        if (asJson) {
          _emitConfigJson({
            ok: false,
            action: 'opencode',
            error: 'profile_extract_failed',
            message: `Unable to extract provider/model from OpenCode config (${extracted.error}).`,
          });
        } else {
          printError(`无法从 OpenCode 配置中提取 provider/model（${extracted.error}）。`);
          printInfo('请使用 --provider 与 --model-id，或直接提供 --base-url/--model-id。');
        }
        return false;
      }
      profile = extracted;
    }
  }

  const providerId = providerIdFlag || (profile && profile.providerId) || 'custom';
  const modelId = modelIdFlag || (profile && profile.modelId) || '';
  const baseUrlRaw = baseUrlFlag || (profile && profile.baseUrl) || '';
  const apiKeyInput =
    apiKeyFlag || (profile && profile.apiKeyInput) || process.env.CUSTOM_API_KEY || '';
  const compatibility =
    compatibilityFlag === 'openai' && profile && profile.compatibility
      ? profile.compatibility
      : compatibilityFlag;

  if (!baseUrlRaw || !modelId) {
    if (asJson) {
      _emitConfigJson({
        ok: false,
        action: 'opencode',
        error: 'missing_base_url_or_model_id',
        message: 'OpenCode-compatible setup requires base URL and model ID.',
      });
    } else {
      printError('OpenCode 兼容配置需要端点 URL 与模型 ID。');
      printInfo(
        '用法: khy config opencode --base-url <url> --model-id <model> [--api-key <key>] [--compatibility openai|anthropic]'
      );
      printInfo('或提供 --config <opencode.json>，可附 --provider/--model-id。');
    }
    return false;
  }

  const baseUrlNormalized = _normalizeOpenAiLikeBaseUrl(baseUrlRaw);
  if (!baseUrlNormalized.ok) {
    if (asJson) {
      _emitConfigJson({
        ok: false,
        action: 'opencode',
        error: 'invalid_base_url',
        message: 'Invalid OpenCode base URL.',
      });
    } else {
      printError('OpenCode 端点 URL 无效。');
      printInfo('请使用有效的 http(s) URL，例如 https://your-provider.com/v1');
    }
    return false;
  }
  if (baseUrlNormalized.appendedV1) {
    warnings.push(
      `OpenCode baseURL did not end with /v1. Auto-normalized to: ${baseUrlNormalized.url}`
    );
  }

  const parsedEntries = parseApiKeyEntries(apiKeyInput);
  const primaryKey = extractPrimaryApiKey(apiKeyInput);
  const primary = String(primaryKey || (parsedEntries[0] && parsedEntries[0].key) || '').trim();
  const envMap = {
    GATEWAY_PREFERRED_ADAPTER: 'relay_api',
    // RUNTIME-006:relay 优先但可回退（与 model.base_url 分支同一口径，避免死端点拖垮整轮）。
    GATEWAY_PREFERRED_STRICT: 'false',
    GATEWAY_PREFERRED_MODEL: modelId,
    RELAY_API_ENDPOINT: baseUrlNormalized.url,
    RELAY_API_MODEL: modelId,
    RELAY_API_COMPATIBILITY: compatibility || 'openai',
  };
  const unsetKeys = [];
  if (primary) {
    envMap.RELAY_API_KEY = primary;
    if (parsedEntries.length > 1) {
      envMap.RELAY_API_KEYS = parsedEntries.map((entry) => entry.key).join(',');
    } else {
      unsetKeys.push('RELAY_API_KEYS');
    }
  } else {
    warnings.push(
      'No API key provided from OpenCode config/flags. Runtime may require credentials.'
    );
    unsetKeys.push('RELAY_API_KEY', 'RELAY_API_KEYS');
  }

  const envPath = _tryEnvPatchOrReport(envMap, unsetKeys, { asJson, action: 'opencode' });
  if (envPath === null) return false;
  if (compatibility === 'anthropic') {
    warnings.push(
      'Current relay adapter uses OpenAI-style requests; anthropic-only endpoints may fail without a compatible bridge.'
    );
  }
  if (asJson) {
    _emitConfigJson({
      ok: true,
      action: 'opencode',
      providerId,
      modelId,
      endpoint: baseUrlNormalized.url,
      compatibility: compatibility || 'openai',
      envPath,
      sourceConfigPath:
        configPathRaw || fs.existsSync(resolvedConfigPath) ? resolvedConfigPath : null,
      warnings,
    });
  } else {
    for (const warning of warnings) {
      printWarn(warning);
    }
    printSuccess(`已应用 OpenCode 兼容配置：${providerId}/${modelId}`);
    printInfo(`端点兼容模式：${compatibility || 'openai'}`);
    if (configPathRaw || fs.existsSync(resolvedConfigPath)) {
      printInfo(`来源配置：${resolvedConfigPath}`);
    }
    printInfo(`已保存到：${envPath}`);
  }
  return true;
}

function _handleConfigGet(args = [], options = {}) {
  const key = _normalizeKey(args[0] || '');
  if (!key) {
    printError('用法: khy config get <键>');
    printInfo(
      '支持的配置键：model.provider, model.base_url, model.api_key, model.name, model.default, model.endpoint_compatibility, language.preference'
    );
    return false;
  }
  const snapshot = _readCurrentModelConfig();
  const value = snapshot.values[key];
  if (options.json) {
    _emitConfigJson({
      action: 'get',
      envPath: snapshot.envPath,
      key,
      value: value === undefined ? '(not set)' : value,
    });
    return true;
  }
  printTable([['键', '值']], [[key, value === undefined ? '（未设置）' : value]]);
  return true;
}

function _handleConfigList(options = {}, action = 'list') {
  const snapshot = _readCurrentModelConfig();
  if (options.json) {
    _emitConfigJson({
      action,
      envPath: snapshot.envPath,
      values: snapshot.values,
    });
    return true;
  }
  const rows = Object.entries(snapshot.values).map(([key, value]) => [key, String(value)]);
  printTable(['键', '值'], rows);
  printInfo(`配置文件：${snapshot.envPath}`);
  return true;
}

/**
 * `khy config layers` — show the layered `.khy/settings.json` resolution
 * (Claude Code aligned: managed > project-local > project-shared > user) and,
 * per key, which layer supplied the winning value. Pure transparency, no writes.
 */
function _handleConfigLayers(options = {}) {
  const { resolveKhySettingsWithProvenance } = require('../repl/khySettings');
  const { value, sources, layers } = resolveKhySettingsWithProvenance();

  if (options.json) {
    _emitConfigJson({ action: 'layers', value, sources, layers });
    return true;
  }

  if (layers.length === 0) {
    printInfo('未发现任何 settings 层（user / project / managed 均不存在）');
    return true;
  }

  console.log('');
  printTable(['层级', '文件'], layers.map((l) => [l.name, l.file]));
  const rows = Object.entries(value).map(([key, val]) => [
    key,
    typeof val === 'object' ? JSON.stringify(val) : String(val),
    sources[key] || '?',
  ]);
  if (rows.length > 0) {
    printTable(['键', '值', '来源'], rows);
  } else {
    printInfo('（层文件存在但无有效键）');
  }
  return true;
}

async function handleConfig(subCommand, args = [], options = {}) {
  const rawArgs = Array.isArray(args) ? args : [];
  // 作用域帮助:`khy config help` / REPL 内 `/config get --help`。非交互模式下
  // bin/khy.js 会把 --help 抢去打全局速查(跨命令设计缺口,见审计台账),此处只兜住能到 handler 的路径。
  if (
    subCommand === 'help' ||
    options.help ||
    rawArgs.includes('--help') ||
    (!subCommand && rawArgs[0] === 'help')
  ) {
    _printUsage();
    return;
  }

  const action = String(subCommand || rawArgs[0] || 'list')
    .trim()
    .toLowerCase();
  const rest = subCommand ? rawArgs : rawArgs.slice(1);

  if (action === 'set') {
    if (!rest[0]) {
      if (options.json) {
        _emitConfigJson({
          ok: false,
          action: 'set',
          error: 'missing_key',
          message: 'Usage: khy config set <key> <value>',
        });
      } else {
        printError('用法: khy config set <键> <值>（缺少键）');
        _printUsage();
      }
      _markFailure();
      return;
    }
    const key = rest[0];
    const value = rest.slice(1).join(' ').trim();
    // _applyConfigSet 各错误路径已 return false,但此前调用点丢掉了返回值 → rc=0 撒谎
    if (_applyConfigSet(key, value, options) === false) _markFailure();
    return;
  }

  if (action === 'get') {
    _handleConfigGet(rest, options);
    return;
  }

  if (action === 'list' || action === 'show') {
    _handleConfigList(options, action);
    return;
  }

  if (action === 'layers') {
    _handleConfigLayers(options);
    return;
  }

  if (action === 'openclaw') {
    const hasExplicitInput = rest.length > 0 || Object.keys(options || {}).length > 0;
    const ok = _handleConfigOpenClaw(rest, options);
    if (!ok && hasExplicitInput) _markFailure();
    if (!ok && !hasExplicitInput) {
      printInfo('此命令支持参数化配置；未提供参数时，进入 khy gateway config 向导...');
      const { handleGatewayConfig } = require('./gateway');
      await handleGatewayConfig();
    }
    return;
  }

  if (action === 'opencode') {
    const hasExplicitInput = rest.length > 0 || Object.keys(options || {}).length > 0;
    const ok = _handleConfigOpenCode(rest, options);
    if (!ok && hasExplicitInput) _markFailure();
    if (!ok && !hasExplicitInput) {
      printInfo('此命令支持参数化配置；未提供参数时，进入 khy gateway config 向导...');
      const { handleGatewayConfig } = require('./gateway');
      await handleGatewayConfig();
    }
    return;
  }

  printError(
    `未知 config 子命令:${subCommand || rawArgs[0]}。可用: set / get / list / show / layers / openclaw / opencode / help。`
  );
  _printUsage();
  _markFailure();
}

module.exports = {
  handleConfig,
  _writeEnvPatch,
};
