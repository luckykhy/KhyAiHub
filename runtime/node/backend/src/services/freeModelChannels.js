'use strict';

/**
 * freeModelChannels.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 「问 khyos 时,除了刚配好的智谱,也主动给出**其他免费模型渠道**」的单一真源。
 * 这是给用户的**发现/建议**层:每条渠道 = 一个提供免费额度的模型服务商 + 其免费模型亮点
 * + 获取 key 的控制台 URL + 在 khyos 里如何配置的一句话提示。纯展示参考数据,绝非凭据。
 *
 * 硬规则(照 providerPresets.js):
 *   - 绝不含密钥:渠道条目只放公开 URL(控制台/主页),永不放 key。
 *   - 可覆盖不冻结:env KHY_FREE_MODEL_CHANNELS(JSON 数组)按 `key` 合并覆盖/新增,
 *     用户可增补自己知道的免费渠道或修正模型清单,无需改代码。
 *   - fail-soft:JSON 畸形/非数组一律忽略,绝不抛。
 *
 * 门控 KHY_FREE_MODEL_CHANNELS(默认开):关(0/false/off/no)→ list 返 []、message 返 '' →
 * 逐字节回退今日「不主动列免费渠道」行为。
 *
 * 诚实:各渠道的免费模型 id/额度会随服务商政策变动;下方 freeModels 为**示例**,真正可用
 * 以各控制台为准。智谱一条与 zhipuFreeModels.js 的 7 免费模型对齐(该叶子是权威源);
 * opencode-zen 一条为 2026-10-24 实测上游目录(日期注明于该条 note,废弃项已按
 * zenRetiredModels 台账剔除)。目录里"消失"的 id 不写进台账:jev-1.13-free 10-21
 * 下线、10-24 又回来了 —— 记成永久废弃会把还能用的模型藏起来。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 内置免费渠道种子。console = 获取/管理 API key 的页面;freeModels = 示例免费模型(非穷举)。
// 仅公开 URL,绝无 key。可经 env KHY_FREE_MODEL_CHANNELS 覆盖/新增(按 key)。
const FREE_MODEL_CHANNELS = [
  {
    key: 'zhipu',
    name: '智谱 GLM(BigModel)',
    poolKey: 'glm',
    note: '7 个永久免费 Flash 模型:对话/视觉/推理/文生图/文生视频',
    freeModels: [
      'glm-4.7-flash',
      'glm-4.6v-flash',
      'glm-4.1v-thinking-flash',
      'glm-4-flash-250414',
      'glm-4v-flash',
      'cogview-3-flash',
      'cogvideox-flash',
    ],
    console: 'https://open.bigmodel.cn/usercenter/apikeys',
    configureHint: '把智谱 key 发我,或 configureModelProvider(provider="智谱", apiKey=...)',
  },
  {
    key: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    poolKey: 'siliconflow',
    note: '多款开源模型免费额度(Qwen / GLM / DeepSeek 蒸馏等,OpenAI 兼容)',
    freeModels: [
      'Qwen/Qwen2.5-7B-Instruct',
      'THUDM/glm-4-9b-chat',
      'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
    ],
    console: 'https://cloud.siliconflow.cn/account/ak',
    configureHint:
      'configureModelProvider(kind="custom", provider="硅基流动", endpoint="https://api.siliconflow.cn/v1", apiKey=..., model="Qwen/Qwen2.5-7B-Instruct")',
  },
  {
    key: 'openrouter',
    name: 'OpenRouter(:free 模型)',
    poolKey: 'openrouter',
    note: '聚合多家模型,带 :free 后缀的模型免费调用',
    freeModels: [
      'deepseek/deepseek-r1:free',
      'google/gemini-2.0-flash-exp:free',
      'meta-llama/llama-3.3-70b-instruct:free',
    ],
    console: 'https://openrouter.ai/keys',
    configureHint:
      'configureModelProvider(kind="custom", provider="OpenRouter", endpoint="https://openrouter.ai/api/v1", apiKey=..., model="deepseek/deepseek-r1:free")',
  },
  {
    key: 'opencode-zen',
    name: 'OpenCode Zen(免费免注册)',
    poolKey: 'opencode-zen',
    note: 'OpenCode 官方免费网关,无需账号 key;khy 启动时自动 seed(opencode-zen 池);下列为 2026-10-24 实测上游目录,已剔除 zenRetiredModels 台账中的废弃项(mimo-v2.5-free / deepseek-v4-flash-free 上游 401,ling-3.0-flash-fin-free 不可用)。本次相对 10-21 清单:新增 flint-40b-free / jev-1.13-free,剔除 minimax-m3.1-flash-free / longcat-2.5-preview-free / nemotron-3-ultra-free(上游目录已收)。注意 beam-free 上游仍在目录但实测 403 地区封锁 —— 换出口 IP 可解,走本机直连即是用本机 IP',
    freeModels: [
      'mimo-v2.6-flash-free',
      'big-pickle',
      'glm-5.3-flash-free',
      'deepseek-v4.1-flash-free',
      'flint-40b-free',
      'jev-1.13-free',
      'nemotron-3.5-lightning-free',
      'nemotron-3.5-super-vl-free',
      'beam-free',
    ],
    console: 'https://opencode.ai/auth',
    configureHint: '内置通道:模型写 api:opencode-zen:<模型id>,无需粘贴 key',
  },
];

/**
 * 门控 KHY_FREE_MODEL_CHANNELS:默认开;0/false/off/no → 关。异常回退关门(false)。
 * flagRegistry 优先,失败回退本地 CANON 解析。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function freeModelChannelsEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (
        reg &&
        typeof reg.isRegistryEnabled === 'function' &&
        typeof reg.isFlagEnabled === 'function' &&
        reg.isRegistryEnabled(e)
      ) {
        return reg.isFlagEnabled('KHY_FREE_MODEL_CHANNELS', e);
      }
    } catch {
      /* fall through to local parse */
    }
    const raw = e.KHY_FREE_MODEL_CHANNELS;
    const v = String(raw == null ? '' : raw)
      .trim()
      .toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/** 仅保留公开 http(s) URL,否则丢弃(渲染为可点链接,绝不放不可信 scheme)。 */
function _safeUrl(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || !/^https?:\/\//i.test(s)) {
    return '';
  }
  try {
    new URL(s);
    return s;
  } catch {
    return '';
  }
}

/** 规整一条渠道为规范形状,或返回 null 丢弃。绝不让 key/secret 透出。 */
function _sanitize(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const key = String(raw.key || '')
    .trim()
    .toLowerCase();
  if (!key) {
    return null;
  }
  return {
    key,
    name: String(raw.name || key),
    poolKey: String(raw.poolKey || '').trim(),
    note: String(raw.note || ''),
    freeModels: Array.isArray(raw.freeModels)
      ? raw.freeModels.map((m) => String(m)).filter(Boolean)
      : [],
    console: _safeUrl(raw.console),
    configureHint: String(raw.configureHint || ''),
    // NOTE: 任何 raw.key 之外的 apiKey/secret 一律不拷贝——渠道是无凭据元数据。
  };
}

/** 解析 env KHY_FREE_MODEL_CHANNELS 为覆盖/新增数组。畸形/非数组 → []。 */
function _readEnvOverrides(env = process.env) {
  const raw = env && env.KHY_FREE_MODEL_CHANNELS;
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return [];
  }
  // 若是纯开关词(true/1/off…)而非 JSON,不当覆盖处理。
  const t = raw.trim();
  if (!t.startsWith('[')) {
    return [];
  }
  try {
    const parsed = JSON.parse(t);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 剔除渠道中已废弃的模型 id(zenRetiredModels 台账:静态名单 + 调用反馈自愈账本)。
 * 门 KHY_ZEN_RETIRED_FILTER(默认开;显式 0/false/off/no 关 → 逐字节回退不过滤)。
 * fail-soft:台账 require 失败/查询异常 → 原样返回。
 *
 * 例外声明:本叶子整体零 IO,唯独 opencode-zen 渠道的 freeModels 需要台账过滤 ——
 * 上游目录挂死 id 是实测事实(2026-10-09:401/410/403),发现层把死模型摆给用户会直接
 * 导致「选中即调用失败」。过滤内聚在 try/catch 内,账本缺失即回退未过滤;单测用
 * KHY_ZEN_RETIRED_FILE 指向受控账本,保持确定性。
 */
function _filterRetiredFreeModels(channel) {
  if (!channel || channel.key !== 'opencode-zen' || !Array.isArray(channel.freeModels)) {
    return channel;
  }
  try {
    const v = String((process.env && process.env.KHY_ZEN_RETIRED_FILTER) || '')
      .trim()
      .toLowerCase();
    if (['0', 'false', 'off', 'no'].includes(v)) {
      return channel;
    }
    const retired = require('./zenRetiredModels');
    if (!retired || typeof retired.isRetired !== 'function') {
      return channel;
    }
    const kept = channel.freeModels.filter((m) => {
      try {
        return !retired.isRetired(m);
      } catch {
        return true;
      }
    });
    if (kept.length !== channel.freeModels.length) {
      return { ...channel, freeModels: kept };
    }
  } catch {
    /* fail-soft: 台账不可用 → 不过滤 */
  }
  return channel;
}

/**
 * 合并、规整后的免费渠道清单(内置在前,env 覆盖按 key 合并:覆盖替换、新 key 追加)。
 * 每次返回全新深拷贝。opencode-zen 渠道的 freeModels 经废弃台账过滤(见
 * _filterRetiredFreeModels;门 KHY_ZEN_RETIRED_FILTER)。关门 → []。
 * @param {Record<string,string>} [env]
 * @returns {Array<{key:string,name:string,poolKey:string,note:string,freeModels:string[],console:string,configureHint:string}>}
 */
function listFreeModelChannels(env = process.env) {
  try {
    if (!freeModelChannelsEnabled(env)) {
      return [];
    }
    const byKey = new Map();
    for (const c of FREE_MODEL_CHANNELS) {
      const clean = _sanitize(c);
      if (clean) {
        byKey.set(clean.key, clean);
      }
    }
    for (const o of _readEnvOverrides(env)) {
      const key = String(o && o.key ? o.key : '')
        .trim()
        .toLowerCase();
      if (!key) {
        continue;
      }
      const merged = _sanitize({ ...(byKey.get(key) || { key }), ...o, key });
      if (merged) {
        byKey.set(key, merged);
      }
    }
    return Array.from(byKey.values()).map(_filterRetiredFreeModels);
  } catch {
    return [];
  }
}

/**
 * 免费层无 SLA 的一句话披露（用户 2026-10-09 报「免费模型连接中经常报错」）：
 * 上游端点会间歇不可用、失败会自动重试自愈——但这件事应当在**选之前**就告诉用户，
 * 而不是等撞上 HTTP 429「endpoint unavailable」再去查网络原因。
 * 不含结尾句号，由调用方统一收尾。
 */
const FREE_TIER_NO_SLA_NOTE =
  '免费层无 SLA：上游端点会间歇不可用（HTTP 429「Endpoint is unavailable」），失败会自动重试并自愈，可随时切换模型通道';

/**
 * 面向用户的一行式免费渠道摘要(供 configureModelProvider 成功 note / list 结果附带)。
 * 关门/空 → ''。
 * @param {Record<string,string>} [env]
 * @returns {string}
 */
function buildFreeModelChannelsMessage(env = process.env) {
  try {
    const channels = listFreeModelChannels(env);
    if (!channels.length) {
      return '';
    }
    const list = channels
      .map((c) => {
        const url = c.console ? `(${c.console})` : '';
        return `${c.name}${url}——${c.note}`;
      })
      .join('；');
    return `${list}；${FREE_TIER_NO_SLA_NOTE}`;
  } catch {
    return '';
  }
}

module.exports = {
  FREE_MODEL_CHANNELS,
  freeModelChannelsEnabled,
  listFreeModelChannels,
  buildFreeModelChannelsMessage,
};
