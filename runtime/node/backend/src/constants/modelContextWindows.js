'use strict';

/**
 * modelContextWindows.js — 「已知模型上下文窗口」的单一真源（纯常量叶 + 纯函数）。
 *
 * 契约 (CONTRACT): 零依赖、零 IO、确定性、绝不抛；env 经第三参注入（默认 process.env），
 * 单测传 {} 即得与进程环境无关的结果。
 *
 * 为什么需要它：此前同一批模型的窗口值散在 4 处各自硬编码（cli/ai.js 的
 * MODEL_CAPABILITIES、tui/utils/ccContextWindows.js、gateway/adapters/claudeAdapter.js 的
 * KNOWN_MODELS、services/models/index.js 的 initDefaults），彼此已经漂移 —— 例如 gpt-4.1 在
 * 一处是 1047576、在 TUI 的前缀匹配里被 `gpt-4` 抢走变成 8192。而桌面端
 * 「上下文已用 X / 总量 Y」那个分母干脆不查模型，恒为字面量 128000，于是
 * agnes（真实 512K/256K 级）显示成 128K、deepseek-chat（真实 64K）也显示成 128K。
 *
 * 真值优先级（从高到低，见 DESIGN-ARCH-154 §「上下文窗口真值贯通」）：
 *   adapter listModels 上报真值 > 免费目录(models.dev) > 静态探测 > 本表 > 128000 兜底
 * 本表只在「适配器还不知道」时提供**保守**初值，让首屏分母先落到一个不会害人的数；
 * 首条消息发出后由网关缓存翻正为真值，初值被覆盖属预期行为。
 *
 * 取值原则 —— 沿用 contextWindowDefaults.js 的「宁可写小不可写大」：写小最多多压缩一次
 * （可恢复），写大会在运行时 400/413（不可恢复）。故凡「要额外开关/后缀/beta 才真开大窗」
 * 的型号一律记**未开开关时的真值**（glm-5.2 记 200000 而非 1000000；qwen-plus 记 131072
 * 而非滚动别名的 1000000）。每条都在注释里写明出处与分歧。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器误判幽灵依赖。
 */

const {
  UNKNOWN_MODEL_CONTEXT_WINDOW,
  MAX_PLAUSIBLE_CONTEXT_WINDOW,
} = require('./contextWindowDefaults');

/**
 * 精确匹配表：只收「与家族默认值不同」的型号。
 * 完整型号带日期后缀（claude-sonnet-4-5-20250929 / gpt-4o-2024-11-20 / gemini-2.0-flash-001），
 * 故家族覆盖靠下方前缀表，这里只钉死分叉点。
 */
const MODEL_CONTEXT_WINDOWS = Object.freeze({
  // ── OpenAI：gpt-4 与 gpt-4o 差 16 倍，必须先钉住，否则被家族规则吃掉 ──
  'gpt-4': 8192,
  'gpt-4-32k': 32768,
  'gpt-4-turbo': 128000,
  'gpt-3.5-turbo': 16384,
  'o1-preview': 128000,
  'o1-mini': 128000,

  // ── Moonshot：窗口写在模型名里 ──
  'moonshot-v1-8k': 8192,
  'moonshot-v1-32k': 32768,
  'moonshot-v1-128k': 131072,

  // ── 智谱 GLM 视觉线：合并预算上限远低于文本线。
  //    与 gateway/glmVisionTextBudget.js 的 16384 截断阈值同源，两者必须同值，
  //    否则显示的分母会宽于实际能发出去的量。 ──
  'glm-4v-flash': 16384,
  'glm-4.6v-flash': 16384,
  'glm-4.1v-thinking-flash': 16384,
  'glm-4v-plus': 16384,
});

/**
 * 家族前缀表，**顺序即优先级，首个命中即返回**。
 * 必须最具体在前：glm-5 在 glm-4 之前、glm-4.6v 在 glm-4 之前、qwen3-max 在 qwen 之前。
 * 写反会让新代型号继承旧代的窄窗口。
 */
const MODEL_CONTEXT_PREFIXES = Object.freeze([
  // ── OpenAI（出处：developers.openai.com 模型卡 / platform.openai.com/docs）──
  ['gpt-4o', 128000],
  ['gpt-4.1', 1047576],
  ['gpt-3.5', 16384],
  // gpt-5 系（5 / 5.1 / 5-codex / 5.1-codex-max）统一 400K，max output 128K
  ['gpt-5', 400000],
  ['codex', 400000],
  ['o3', 200000],
  ['o4-mini', 200000],
  ['o1', 128000],
  ['gpt-4', 8192],

  // ── Anthropic（出处：support.claude.com「context window on paid plans」）
  //    Opus 5 / Sonnet 5 / Fable 5 = 1M；Opus 4.6-4.8 / Sonnet 4.6 = 1M（API 侧 2026-03
  //    起 GA，标准计价、无长上下文溢价）；其余 Claude = 200K。 ──
  ['claude-opus-5', 1000000],
  ['claude-sonnet-5', 1000000],
  ['claude-fable-5', 1000000],
  ['claude-opus-4-8', 1000000],
  ['claude-opus-4-7', 1000000],
  ['claude-opus-4-6', 1000000],
  ['claude-opus-4-4', 1000000],
  ['claude-opus-4-1', 1000000],
  ['claude-opus-4', 1000000],
  ['claude-sonnet-4-6', 1000000],
  ['claude-sonnet-4-5', 1000000],
  ['claude-sonnet-4', 1000000],
  ['claude-haiku-4-5', 200000],
  ['claude-haiku-4', 200000],
  ['claude-3', 200000],
  ['claude-', 200000],

  // ── Google（出处：ai.google.dev 模型卡 Input token limit）──
  ['gemini-3', 1048576],
  ['gemini-2.5', 1048576],
  ['gemini-2.0', 1048576],
  ['gemini-1.5', 1048576],
  ['gemma-3', 131072],

  // ── DeepSeek（出处：api-docs.deepseek.com 定价表 CONTEXT LENGTH）
  //    ⚠ deepseek-chat / deepseek-reasoner 官方 API 是 64K，不是 128K；128K 只存在于
  //    开源权重自部署（官方 news 页明确「网页端/App/API 提供 64K」）。这一条是本表
  //    存在的理由：旧表把两者都当 128K，压缩触发点算晚一倍 → 发请求时直接 400。
  //    models.dev 上 deepseek-chat 仅一家第三方中转（nano-gpt）标 128000，厂商自报缺席；
  //    按「宁可写小不可写大」与厂商文档优先，取 65536。 ──
  ['deepseek-v4', 1000000],
  ['deepseek-flash', 1000000],
  ['deepseek-chat', 65536],
  ['deepseek-reasoner', 65536],
  ['deepseek-v3', 128000],
  ['deepseek-r1', 128000],
  ['deepseek-v2', 128000],
  ['deepseek', 128000],

  // ── 智谱 GLM（出处：models.dev live 实测，厂商自报优先）
  //    glm-5.2 / 5.3 / 5.3-flash = 1000000 —— 厂商自报行 zhipuai 与 zai、zai-coding-plan
  //    都是 1000000，alibaba / alibaba-cn 同为 1000000；只有个别第三方路由（routing-run）
  //    报 200000。此前按 docs.bigmodel.cn「1M 需 [1m] 后缀」取 200000 保守档，那段文档
  //    说的是 Coding Plan 客户端的 context_window_size 设置，不是裸 API 的上限，故放开。
  //    ⚠ 残余风险：若某个网关确实只给 200K，本值会偏大 → 压缩算晚 → 400。此时
  //    KHY_MODEL_CONTEXT_WINDOW_MAP 或 KHY_CONTEXT_WINDOW 可单点覆盖，无需改代码。
  ['glm-5', 1000000],
  ['glm-4.7', 200000],
  // ── GLM 视觉线：整族都是 16384 的**合并窗口**（上游 400 code 1210 原文
  //    「inputs tokens + max_new_tokens must be <= 16384」），不是文本线那种
  //    「128K 输入 + 若干输出」。此前只有精确表里的 glm-4.6v-flash / glm-4v-flash
  //    记了 16384，家族前缀却记 200000 —— 同族差 12 倍，显示分母会宽于实际能发
  //    出去的量。与 gateway/glmVisionTextBudget.js 的 COMBINED_TOKEN_BUDGET 同值。
  ['glm-4.6v', 16384],
  ['glm-4.5v', 16384],
  ['glm-4.4v', 16384],
  ['glm-4.3v', 16384],
  ['glm-4.6', 200000],
  ['glm-4.5', 200000],
  ['glm-4.4', 16384],
  ['glm-4.3', 16384],
  // 文本线 128K 输入 + 4K 输出 = 131072 合计
  ['glm-4', 131072],

  // ── 阿里 Qwen（出处：models.dev live 实测 + help.aliyun.com 百炼「上下文限制」表）
  //    厂商自报（alibaba / alibaba-cn）qwen-plus = 1000000；qwen3-max = 262144。
  //    但 qwen 是宽前缀尾巴（qwen-turbo 只有 32768），故按档位逐条钉，不留 1M catch-all。 ──
  ['qwen3.8-flash', 1000000],
  ['qwen3.7-plus', 1000000],
  ['qwen3-plus', 1000000],
  ['qwen3-max', 262144],
  ['qwen3-turbo', 131072],
  ['qwen3', 131072],
  ['qwen-max', 262144],
  ['qwen-plus', 1000000],
  ['qwen-turbo', 32768],
  ['qwen', 131072],

  // ── 月之暗面 Moonshot / Kimi（出处：models.dev live 实测众数）
  //    kimi-k3 = 1048576（24 家一致）、kimi-k2.5 = 262144（19 家一致）、kimi-k2 = 128000。
  //    三代跨度 8×，逐代钉死；`kimi` catch-all 留 131072 保守。 ──
  ['kimi-k3', 1048576],
  ['kimi-k2.5', 262144],
  ['kimi-k2', 131072],
  ['kimi', 131072],
  ['moonshot-v1', 131072],

  // ── Meta 系（Groq / Together / Ollama 各自的命名形态）──
  ['llama-4-maverick', 1048576],
  ['llama-4-scout', 1048576],
  ['llama-4', 1048576],
  ['llama-3.3-70b', 128000],
  ['llama-3.3', 128000],
  ['llama-3.2', 131072],
  ['llama-3.1', 131072],
  ['llama-3', 8192],
  // Ollama 的 tag 名不带连字符（llama3.2 / llama3.1），Groq/Together 的带（llama-3.3-70b）
  ['llama3.2', 131072],
  ['llama3.1', 131072],
  ['llama3', 8192],
  ['llama', 8192],

  // ── Agnes AI（出处：models.dev live 实测，厂商 agnes 自报 = 512000，与 wiki.agnes-ai.com
  //    规格表的「上下文窗口 512K」一致。此前取 262144 是因为官方模型仓 README 写过一句
  //    「June 2026 回滚到 256K」—— 单一 README 对上厂商自报 + 规格表两处，按众数取 512000。 ──
  ['agnes-', 512000],
]);

/** 安全钳位：超过理性天花板（1Mi）视为上游谎报，钳回，绝不把离谱值当分母。 */
function _clamp(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return n > MAX_PLAUSIBLE_CONTEXT_WINDOW ? MAX_PLAUSIBLE_CONTEXT_WINDOW : n;
}

/**
 * KHY_MODEL_CONTEXT_WINDOW_MAP —— 全新模型不进代码就能覆盖的出口。
 *
 * 与 services/modelTier.js 的 KHY_MODEL_TIER_MAP、gateway/modelCapability.js 的
 * KHY_MODEL_CAPABILITY_MAP 逐项同构（单个 JSON 对象 env / key 小写化精确匹配 /
 * 畸形 JSON 静默忽略 / 按 raw 串缓存避免重复解析），差别只在值域：这里收正整数
 * 并按 MAX_PLAUSIBLE_CONTEXT_WINDOW 钳位，不收则静默丢弃。
 *
 *   KHY_MODEL_CONTEXT_WINDOW_MAP='{"glm-6":1000000,"my-proxy/新模型":262144}'
 *
 * 优先级：env 全局标量 KHY_CONTEXT_WINDOW > 本表（env per-model map > 静态表 >
 * 家族前缀 > 兜底）。网关已解析的真值在更上层，本表只管「还不知道」那一段。
 */
let _ctxMapCacheRaw = null;
let _ctxMapCache = null;

function _resolveEnvContextWindowMap(lowerKey, env) {
  const raw = env && env.KHY_MODEL_CONTEXT_WINDOW_MAP;
  if (!raw || !String(raw).trim()) {
    _ctxMapCacheRaw = null;
    _ctxMapCache = null;
    return 0;
  }
  if (raw !== _ctxMapCacheRaw) {
    _ctxMapCacheRaw = raw;
    _ctxMapCache = {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          const key = String(k).trim().toLowerCase();
          const n = _clamp(v);
          if (key && n > 0) {
            _ctxMapCache[key] = n;
          }
        }
      }
    } catch {
      /* 畸形 JSON 静默忽略：宁可回静态表，也不让一个坏 env 把分母变成 0 */
      _ctxMapCache = {};
    }
  }
  return _ctxMapCache[lowerKey] || 0;
}

/**
 * 把一个模型 id 拆成「候选键」。真实 model 串在仓里至少有四种形态：
 *   裸名          `glm-4.7-flash`
 *   通道前缀      `glm/glm-4.6v-flash`（poolHint 投影）
 *   三段式路由 id `api:glm:glm-4.7-flash`
 *   聚合网关名    `openrouter/z-ai/glm-5.2:free`、`meta-llama/Llama-3.3-70B-Instruct-Turbo`
 * 逐个归一化后按「整串 → 去路径前缀」两档试，先整串后剥前缀，避免误伤名字里带 `/` 的。
 */
function _candidateKeys(modelId) {
  const id = String(modelId || '')
    .trim()
    .toLowerCase();
  if (!id) {
    return [];
  }
  const keys = [id];
  // api:<pool>:<model> → 取最后一段
  if (id.startsWith('api:')) {
    const segs = id.split(':');
    if (segs.length >= 3) {
      keys.push(segs[segs.length - 1]);
    }
  }
  const tail = keys[0].slice(keys[0].lastIndexOf('/') + 1);
  if (tail && tail !== keys[0]) {
    keys.push(tail);
  }
  // 聚合网关的变体后缀：glm-5.2:free → glm-5.2
  for (const k of keys.slice()) {
    const bare = k.split(':')[0];
    if (bare && bare !== k) {
      keys.push(bare);
    }
  }
  return Array.from(new Set(keys));
}

/**
 * 解析模型上下文窗口。**这是全仓唯一该查模型窗口的静态入口。**
 *
 * @param {string} modelId 模型串（裸名 / 带通道前缀 / 带网关后缀皆可）
 * @param {number} [fallback] 未登记时的回退值；默认 128000
 * @param {Record<string,string>} [env] env 来源。默认读 process.env；**单测传 {}**
 *        即可得到与进程环境无关的确定性结果（与 contextWindowDefaults.resolveFallbackWindow
 *        同一套注入惯例）。
 * @returns {number} token 数；始终为正整数
 */
function resolveModelContextWindow(
  modelId,
  fallback = UNKNOWN_MODEL_CONTEXT_WINDOW,
  env = process.env
) {
  for (const key of _candidateKeys(modelId)) {
    // env per-model map 先于静态表：用户显式写下的值就是本层的真值。
    const fromEnv = _resolveEnvContextWindowMap(key, env);
    if (fromEnv > 0) {
      return fromEnv;
    }
    const exact = MODEL_CONTEXT_WINDOWS[key];
    if (exact) {
      return exact;
    }
    for (const [prefix, window] of MODEL_CONTEXT_PREFIXES) {
      if (key.startsWith(prefix)) {
        return window;
      }
    }
  }
  const fb = _clamp(fallback);
  return fb > 0 ? fb : UNKNOWN_MODEL_CONTEXT_WINDOW;
}

/**
 * 让散落的声明式表**不可能与真源漂移**用的一行钩子。
 * 真源登记了该型号（含 env map 覆盖）→ 返回真源值（声明值仅作未登记时的退路）；
 * 未登记 → 原样返回声明值，好让「表里多了一个没进真源的型号」这件事保持可见，
 * 而不是被静默改成 128000。
 */
function pinModelContextWindow(modelId, declaredWindow, env = process.env) {
  return resolveModelContextWindow(
    modelId,
    _clamp(declaredWindow) || UNKNOWN_MODEL_CONTEXT_WINDOW,
    env
  );
}

module.exports = {
  MODEL_CONTEXT_WINDOWS,
  MODEL_CONTEXT_PREFIXES,
  resolveModelContextWindow,
  pinModelContextWindow,
};
