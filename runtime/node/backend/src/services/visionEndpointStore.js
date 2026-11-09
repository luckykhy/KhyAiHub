'use strict';

/**
 * visionEndpointStore.js — 「视觉识图端点」配置的单一读写真源。
 *
 * 用户语义(2026-10-27 裁决)：视觉模型**只当眼睛**。带图请求遇到不支持视觉的推理
 * 模型时，视觉模型描述图片、描述注入 prompt、由用户选定的推理模型作答。这个组合
 * 逻辑已经存在且默认开启（KHY_VISION_DESCRIBE_RETURN，见
 * gateway/visionDescribeReturn.js），本模块**不新增任何组合逻辑**，只负责把
 * 「端点三件套」折算成既有机器已经在消费的形状。
 *
 * 两个持久平面，刻意分工：
 *   ① <dataHome>/vision_endpoint.json —— 声明式 {baseUrl, model, updatedAt}。
 *      **不含任何密钥材料**（R2：真 key 不进任何会被提交/镜像的文件）。
 *   ② <dataHome>/api_keys.json —— 保留池 khy-vision 的 key + endpoint。
 *      密钥的唯一落点（0600，dataHome 已 gitignore），且经 apiKeyPoolWatcher
 *      热加载——这正是选它而不选 custom_providers.json 的原因：后者没有监听，
 *      另一个 CLI 进程写进去，正在跑的网关守护进程要重启才看得见。
 *   ③ .env —— **不写**。pin 只注入每请求的 routing env 副本，先例是
 *      aiGatewayGenerateMethod.js 里 GLM 默认兜底的同一段注入。
 *
 * **为什么 apiKeyPool 是参数而不是 require**（这条是设计约束，不是风格偏好）：
 * 本模块被 aiGatewayGenerateMethod 引用，而那个文件在一个 196 成员的强连通分量里
 * （scripts/arch-debt-baseline.json 的 R3-cycle）。apiKeyPool 和 configGuard 都在
 * 那个环里，所以只要本模块静态依赖其中任何一个，就会被拉进环中、让环的成员集
 * 相对基线发生变化——archDebtScan 的 R2b/R3 棘轮会报「新增架构债」。
 * 把池子改成调用方传入，本模块就只依赖 dataHome / atomicWriteJson（两者都不在环里），
 * 新增文件因此不扩大既有环。附带好处：visionRoutingEnvPatch 成为真正零依赖的纯函数，
 * 测试不必再猴补丁 apiKeyPool.hasAvailableKeys。
 *
 * 为什么不用 configGuard.safeReadJsonSync：它在文件缺失时会按 schema 自愈写一个
 * '{}' 落盘（configGuard.js:398-412，createIfMissing 默认开），于是「读一次」这个
 * 动作会改盘。对声明式配置来说那是意外副作用——clear 之后读一次，文件又以空配置
 * 形态回来，看起来像 clear 没生效。这里用裸 fs 读，读就是读。
 *
 * 失败纪律：除纯函数和入参校验外一律 fail-soft，绝不向上抛。配置读不出来就当没配，
 * 让请求走既有链路，而不是让一次坏配置把整个网关带崩。
 */

const fs = require('fs');
const path = require('path');

const { getDataHome } = require('../utils/dataHome');
const atomicWriteJson = require('../utils/atomicWriteJson');

// ── 常量 ────────────────────────────────────────────────────────────────────

/**
 * 保留池名。同步登记进 customProviderRegistry.BUILTIN_POOL_KEYS，这样用户不能
 * 再注册一个同名自定义 provider 把它覆盖掉（saveProvider:132 会拒绝）。
 */
const VISION_ENDPOINT_POOL_KEY = 'khy-vision';

/**
 * 池内 key 的 label。**不能是 'env'**：apiKeyPool.save() 会静默丢弃 env 标签的
 * 条目，那会让密钥写了却不落盘，下次启动就没了。
 */
const VISION_KEY_LABEL = 'vision-endpoint';

/**
 * 与 registerCustomProvider 的 parseApiKeyEntries(..., {priority:10}) 同档，
 * 盖过 env 兜底的 0（apiKeyPool.pick 按 priority 降序取）。
 */
const VISION_KEY_PRIORITY = 10;

const CONFIG_VERSION = 1;

// ── 纯函数 ──────────────────────────────────────────────────────────────────

/** `<pool>/<model>` —— visionRouting 的 _modelProviderPrefix 认这个形状。 */
function visionPin(model) {
  const m = String(model == null ? '' : model).trim();
  if (!m) {
    return '';
  }
  return `${VISION_ENDPOINT_POOL_KEY}/${m}`;
}

/**
 * 规范化 base URL：去尾部斜杠、要求 http(s) scheme。
 *
 * 尾部斜杠必须去：endpoint 会拼 `/chat/completions`，多一个斜杠变成 `//` 时
 * 一部分上游直接 404，而那个 404 看起来像模型名写错了，极难查。
 */
function normalizeVisionBaseUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) {
    return '';
  }
  let out = s;
  while (out.length > 1 && out.endsWith('/')) {
    out = out.slice(0, -1);
  }
  if (!/^https?:\/\//i.test(out)) {
    return '';
  }
  return out;
}

/**
 * 把配置折算成 decideVisionRouting 消费的 env 补丁。纯函数、零 IO、零依赖：
 * config 与 hasPoolKey 都由参数注入，所以整条判定链可以在 node:test 里穷举。
 *
 * **两道注入缺一不可**：
 *   ① KHY_VISION_FALLBACK_MODEL = pin → visionRouting.js:88-103 的显式钉选分支。
 *   ② KHY_VISION_MODELS 追加 pin     → visionCapability.js:116-119 的精确集命中。
 *
 * 为什么需要 ②：钉选分支用**完整带前缀的 pin** 去问 isVisionCapableModel，而
 * _normModel（utils/trimLowerNullish）只 trim+转小写、**不剥 pool 前缀**，其余
 * 能力来源（内置名单 / custom_providers.json 声明）存的多是裸模型名。实测
 * `khy-eyes/plain-model` 这种不含 VISION_NAME_HINTS 片段的 id 会被静默判为纯文本
 * → 钉选分支整个跳过 → 悄悄退回 OCR，不报错。BUILTIN_VISION_MODELS 自己就登记了
 * 'stepfun/step-3.7-flash' 这种带前缀形式，所以往 KHY_VISION_MODELS 放带前缀 pin
 * 是仓库既有惯例，不是新发明。
 *
 * （注意：我们真实的池名 khy-vision 本身含 'vision' 片段，会误打误撞命中启发式，
 * 从而掩盖 ② 的作用。所以 ② 不是死代码——它是与池名无关的那道保证。）
 *
 * 三道守卫（任一不满足就原样返回 env，调用方逐字节回退）：
 *   - 有配置且 pin 非空；
 *   - 用户没有手设 KHY_VISION_FALLBACK_MODEL（显式 env 优先，'auto' 算未设——
 *     它本来就是「跳过钉选、交给后续步骤」的约定值）；
 *   - hasPoolKey 为真。没有凭据绝不路由过去：apiAdapter.js 的
 *     useRequestOverride = !!('openai' && (poolApiKey || poolEndpoint))，
 *     缺 key 时会退回默认 env-keyed service，请求**静默落到错误上游**——
 *     正是 GLM 那一类故障，故此处硬拦。
 */
function visionRoutingEnvPatch(env, config, hasPoolKey) {
  if (!config || !config.pin) {
    return env;
  }
  const explicit = String((env && env.KHY_VISION_FALLBACK_MODEL) || '').trim();
  if (explicit && explicit.toLowerCase() !== 'auto') {
    return env;
  }
  if (hasPoolKey !== true) {
    return env;
  }

  const existingModels = String((env && env.KHY_VISION_MODELS) || '').trim();
  let models;
  if (!existingModels) {
    models = config.pin;
  } else {
    const parts = existingModels.split(/[,\s]+/).filter(Boolean);
    models = parts.includes(config.pin)
      ? existingModels
      : `${existingModels},${config.pin}`;
  }

  return Object.assign({}, env, {
    KHY_VISION_FALLBACK_MODEL: config.pin,
    KHY_VISION_MODELS: models,
  });
}

// ── 文件层 ──────────────────────────────────────────────────────────────────

function configFilePath() {
  return path.join(getDataHome(), 'vision_endpoint.json');
}

/**
 * 读盘上的原始声明，**不判完整性**（baseUrl 或 model 可能为空）。
 *
 * 存在的理由：`khy config set model.vision.model <id>` 要能补全一个只填了 URL 的
 * 半配置。如果合并时用的是 readVisionEndpoint()，那个函数对半配置返回 null，
 * URL 就找不回来了，于是「一个一个字段填」这条路走不通。读取闸（完整性）与合并
 * 源（原始声明）必须是两个函数，否则二者互相把对方锁死。
 *
 * @returns {{baseUrl:string, model:string, updatedAt:number}|null}
 */
function readVisionEndpointDraft() {
  const raw = _readRaw();
  if (!raw) {
    return null;
  }
  return raw;
}

/** 读声明式配置。任何异常/坏形状 → null（fail-soft）。读动作不改盘。 */
function readVisionEndpoint() {
  const raw = _readRaw();
  if (!raw || !raw.baseUrl || !raw.model) {
    return null; // 未配置，或只填了一半——半配置必须表现得跟没配一样
  }
  return {
    baseUrl: raw.baseUrl,
    model: raw.model,
    poolKey: VISION_ENDPOINT_POOL_KEY,
    pin: visionPin(raw.model),
    updatedAt: raw.updatedAt,
  };
}

/** 裸 fs 读 + 形状归一。不做任何完整性判断。 */
function _readRaw() {
  let raw;
  try {
    raw = fs.readFileSync(configFilePath(), 'utf-8');
  } catch (_) {
    return null; // 不存在 / 不可读
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    return null; // 损坏
  }
  if (!data || typeof data !== 'object') {
    return null;
  }
  return {
    baseUrl: normalizeVisionBaseUrl(data.baseUrl),
    model: String(data.model == null ? '' : data.model).trim(),
    updatedAt: Number(data.updatedAt) || 0,
  };
}

/**
 * 读 + 实时派生密钥状态。掩码从池子现算，所以永远不过期——不存在「配置里存了个
 * 掩码、key 早就被换了」这种半真半假的状态。
 *
 * @param {object} pool apiKeyPool 模块（由调用方传入，见文件头关于依赖的说明）
 */
function describeVisionEndpoint(pool) {
  const base = readVisionEndpoint();
  if (!base) {
    return null;
  }
  let hasApiKey = false;
  let apiKeyMasked = '';
  let keyCount = 0;
  try {
    const status = (pool && pool.getPoolStatus(VISION_ENDPOINT_POOL_KEY)) || [];
    keyCount = status.length;
    hasApiKey = pool.hasAvailableKeys(VISION_ENDPOINT_POOL_KEY) === true;
    apiKeyMasked = status.length > 0 ? (status[0].keyPreview || '') : '';
  } catch (_) {
    // 池不可用：如实报「没有」，不猜「有」。
  }
  return Object.assign({}, base, { hasApiKey, apiKeyMasked, keyCount });
}

/**
 * 写配置。顺序刻意是 校验 → 池 → 文件：
 * 先落池再落文件，这样即使文件写失败，凭据也已经在热加载 Plane 里，下一次读取
 * 会因为 model 为空而当没配（不会出现「有 key 没模型」的半配置状态）。
 *
 * **增量语义：入参只覆盖给出的字段，其余取自盘上的半配置。**
 * 一开始这里要求 baseUrl 与 model 同时到齐，结果 `khy config set
 * model.vision.base_url <url>` 在一台新机器上永远失败——漏斗要求一次填两个字段，
 * 而用户天然是一个一个填的。合并源是 `_readRaw()` 而不是 `readVisionEndpoint()`：
 * 后者对半配置返回 null，URL 就找不回来了，二者互相把对方锁死。
 *
 * 半配置为什么安全：`readVisionEndpoint()` 在 baseUrl 或 model 任一缺失时返回
 * null，于是钉选根本不会发生，行为与「完全没配」逐字节相同。真正拦住「把路由钉到
 * 不存在的模型上」的是那道读取闸，不是这里的写入闸——写入闸管的是文件完整性。
 *
 * @param {object} input {baseUrl, apiKey, model, clearApiKey}
 * @param {object} pool  apiKeyPool 模块；不传则只写文件、不动密钥
 */
function writeVisionEndpoint(input, pool) {
  const args = input || {};
  const current = _readRaw() || { baseUrl: '', model: '', updatedAt: 0 };
  const baseUrl = normalizeVisionBaseUrl(
    args.baseUrl === undefined || args.baseUrl === null ? current.baseUrl : args.baseUrl
  );
  const model = String(
    args.model === undefined || args.model === null ? current.model : args.model
  ).trim();
  if (!baseUrl) {
    throw new Error('baseUrl 不能为空，且必须是 http(s):// 开头');
  }
  if (/\s/.test(model)) {
    // pin 是 `pool/model`，KHY_VISION_MODELS 按 /[,\s]+/ 切分——模型名里带空格
    // 会被切成两半，然后钉选到一个不存在的 id 上。
    throw new Error('model 不能含空格');
  }

  const clearApiKey = args.clearApiKey === true;
  const apiKey = String(args.apiKey == null ? '' : args.apiKey).trim();
  if (clearApiKey && apiKey) {
    throw new Error('clearApiKey 与 apiKey 同时给出，语义冲突');
  }

  if (pool && clearApiKey) {
    _removeAllVisionKeys(pool);
  } else if (pool && apiKey) {
    _setVisionKey(pool, apiKey, baseUrl);
  }

  const payload = {
    version: CONFIG_VERSION,
    baseUrl,
    model,
    updatedAt: Date.now(),
  };
  try {
    fs.mkdirSync(path.dirname(configFilePath()), { recursive: true });
    atomicWriteJson(configFilePath(), payload, { mode: 0o600 });
  } catch (_) {
    // 文件写失败不抛：凭据已落池，且 readVisionEndpoint 会因为读不到文件而当
    // 没配。抛出来只会让调用方看到一个「一半成功」的状态却说成失败。
  }
  return describeVisionEndpoint(pool);
}

/**
 * 幂等地把池里那把 key 设成 (apiKey, baseUrl)。
 *
 * 刻意手写而不复用 customProviderRegistrar.replaceProviderKeys：那个函数快照旧
 * id → 容忍重复添加错误 → 删快照，**重设同一个 key 会把它删掉**（addKey 对已存在
 * 的 key 抛 "already exists"，被它吞掉，然后它把快照里的旧 id 删了）。
 */
function _setVisionKey(pool, apiKey, baseUrl) {
  const existing = pool.listAvailableKeys(VISION_ENDPOINT_POOL_KEY) || [];
  if (existing.length === 1
      && existing[0].key === apiKey
      && normalizeVisionBaseUrl(existing[0].endpoint) === baseUrl) {
    return; // no-op 快路：什么都不做，连 save 都不触发
  }
  _removeAllVisionKeys(pool);
  pool.addKey(VISION_ENDPOINT_POOL_KEY, {
    key: apiKey,
    endpoint: baseUrl,
    priority: VISION_KEY_PRIORITY,
    label: VISION_KEY_LABEL,
  });
}

function _removeAllVisionKeys(pool) {
  let existing = [];
  try {
    existing = pool.listAvailableKeys(VISION_ENDPOINT_POOL_KEY) || [];
  } catch (_) {
    return;
  }
  for (const e of existing) {
    try {
      pool.removeKey(VISION_ENDPOINT_POOL_KEY, e.keyId);
    } catch (_) {
      // 单个删失败不阻断：剩下的由下次写入再清。
    }
  }
}

/** 清空：删池里的 key + 删配置文件。 */
function clearVisionEndpoint(pool) {
  if (pool) {
    _removeAllVisionKeys(pool);
  }
  try {
    fs.unlinkSync(configFilePath());
  } catch (_) {
    // 本来就没有，或删不掉：都当已清空。
  }
  return null;
}

// ── IO 包装 ─────────────────────────────────────────────────────────────────

/**
 * 读盘 + 调纯函数。无配置时返回**同一个 env 对象**（引用相等）——调用方可以据此
 * 判断「什么都没发生」，测试也据此断言零改动。
 *
 * @param {object} env  请求的 routing env 副本
 * @param {object} pool apiKeyPool 模块，用于判断池里有没有可用凭据
 */
function applyVisionRoutingEnv(env, pool) {
  const config = readVisionEndpoint();
  if (!config) {
    return env;
  }
  let hasPoolKey = false;
  try {
    hasPoolKey = pool.hasAvailableKeys(VISION_ENDPOINT_POOL_KEY) === true;
  } catch (_) {
    return env; // 池不可用 → 逐字节回退
  }
  return visionRoutingEnvPatch(env, config, hasPoolKey);
}

module.exports = {
  VISION_ENDPOINT_POOL_KEY,
  VISION_KEY_LABEL,
  VISION_KEY_PRIORITY,
  configFilePath,
  visionPin,
  normalizeVisionBaseUrl,
  visionRoutingEnvPatch,
  readVisionEndpoint,
  readVisionEndpointDraft,
  describeVisionEndpoint,
  writeVisionEndpoint,
  clearVisionEndpoint,
  applyVisionRoutingEnv,
};
