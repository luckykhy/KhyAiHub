'use strict';

/**
 * routeDemand — 纯叶子:四道 pass 的本地实现([DESIGN-ARCH-185] §5)。
 *
 *   pass A admission   硬约束过滤 + trivial/hard 规则短路(§5.1)
 *   pass B demand      关键词表命中 + 线性打分 → 0..1 难度标量 → 能力档(§5.2)
 *   pass C risk        上下文压力 / 工具失败 / 不可逆动作 → **只上抬**(§5.3)
 *   pass D matching    不在此处:交给 autoModelSelect.rankAutoModels(它才有候选)
 *
 * 为什么 demand 用线性打分而不是模型:本仓是便携 Windows + Node,无 Python / 无 ONNX
 * (opensquilla 的交付物是 LightGBM 4 类 + MLP + BGE-INT8,390 维,抄不动)。
 * 而 §2.4 的 E1 核对显示:决策骨架住在配置里
 * (flag_rules / thresholds / thinking_mode_rules / context_rules),
 * 模型只填 route_class 一个 argmax 槽位 —— 本叶子填的是同一个槽位。
 * **这是本方案与论文唯一的实质分歧,如实记在这里。**
 *
 * 三条方向性纪律(都有出处,不是风格偏好):
 *   1. **只上抬,不下调**(§5.3)。降档能力刻意不存在。opensquilla 的 aux_downgrade
 *      实现了但 enabled:false;它的 under_routing_safety 强制升,却没有反向兜底。
 *      整套系统的默认偏置是「宁可贵,不要错」。
 *   2. **历史位只放外部可验证事实**。绝不引用「上一轮路由器自己判的档」——
 *      opensquilla 的 sticky_tier 正是因此被关掉(§2.4 E1 原文注释)。
 *   3. **多模态是硬约束不是权重**。带图的请求绑到具备该能力的模型,不与文本档混排;
 *      所以 hasImage 的 demand 权重是 0,它走 admission。
 *
 * 契约:零 IO(卡由调用方注入)、确定性、绝不抛。坏输入 → 返回 null,调用方走旧路径。
 */

// tier 方向与 modelTier._TIER_ORDER 一致:T0 最强最重 … T3 最轻。
const _TIER_IDX = { T0: 0, T1: 1, T2: 2, T3: 3 };

const _FENCE_RE = /```([\s\S]*?)```/g;
const _LOGISH_RE = /^(\s*\d{4}[-/]\d{2}[-/]\d{2}|\s*(?:\[[0-9:.\-]+\]|[A-Z]+:[0-9]|at\s+\S+\(|Traceback\b))/gm;
// 结尾用 (?![\w(]) 而不是 \b:`\b` 在 `log` 与 `(` 之间成立,于是 `console.log(x)`
// 会被当成一个 .log 文件引用 —— 实测把 fileRefs 从 2 抬到 3,而 fileRefs 是 long_context 的阈值项。
// 文件引用计数**不用全局正则**。原来的 `[\w./\\-]+\.(?:js|…)\b` 在没有点号的长串上
// 会退化成 O(n²)：引擎在每个起点贪婪吞到串尾再回溯找 `.`。
// 实测（route-overhead-probe）6500 字符的纯 `x` 串 → 单次抽取 25ms，
// 而其余 9 个样本全在 0.1ms 以下 —— p50=0.03ms / p95=25ms 的长尾就是它。
// 逐 token 判后缀是 O(n) 且语义等价：一个 token 以 `.已知扩展名` 结尾即算一次引用。
const _FILE_REF_EXTS = new Set([
  'js', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cc', 'cpp', 'h', 'md',
  'json', 'yaml', 'yml', 'csv', 'sh', 'bat', 'ps1', 'sql', 'vue', 'css', 'scss',
  'html', 'toml', 'lock', 'log',
]);
const _TRAILING_EXT_RE = /\.([A-Za-z0-9]+)$/;

function _countFileRefs(text) {
  let n = 0;
  // 用带捕获的 split 拿到 token **后面的分隔符**：`console.log(x)` 会被切成
  // token=`console.log` + 分隔符=`(`，后者以 `(` 开头 ⇒ 这是方法调用不是文件引用。
  // 旧正则用 `(?![\w(])` 做这件事；改成纯后缀判断时差点把它丢了。
  const parts = text.split(/([^A-Za-z0-9_./\\-]+)/);
  for (let i = 0; i < parts.length; i += 2) {
    const tk = parts[i];
    if (!tk) continue;
    const sep = parts[i + 1] || '';
    if (sep.startsWith('(')) continue;
    const m = _TRAILING_EXT_RE.exec(tk);
    if (m && _FILE_REF_EXTS.has(m[1].toLowerCase())) n += 1;
  }
  return n;
}
// CJK 区间一律用 \u 转义拼:直接放字符会被编辑器换成肉眼难辨的近形字,
// 而这类正则坏掉不报错,只是 cjkRatio 恒 0 —— 于是中文主诉全被判成英文短问。
const _CJK_RX = new RegExp(
  '[' + ['\\u3400-\\u4dbf', '\\u4e00-\\u9fff', '\\u3040-\\u30ff', '\\uac00-\\ud7af'].join('') + ']',
  'g'
);

function _num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function _clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * 特征抽取。ctx 里能拿到多少算多少,缺的一律按「不知道」处理(不猜测、不外推)。
 * @param {string} prompt
 * @param {object} [ctx] {taskType,taskScale,turnIndex,ctxRatio,estCtxTokens,toolFails,
 *                        irreversible,hasImage,candidates}
 */
function extractFeatures(prompt, ctx = {}) {
  const text = typeof prompt === 'string' ? prompt : '';
  const f = {
    chars: text.length,
    codeBlockChars: 0,
    logBlockChars: 0,
    fileRefs: 0,
    cjkRatio: 0,
    hasImage: !!(ctx && ctx.hasImage),
    irreversible: !!(ctx && ctx.irreversible),
    toolFails: Math.max(0, _num(ctx && ctx.toolFails, 0)),
    turnIndex: Math.max(0, _num(ctx && ctx.turnIndex, 0)),
    ctxRatio: _clamp01(_num(ctx && ctx.ctxRatio, 0)),
    estCtxTokens: Math.max(0, _num(ctx && ctx.estCtxTokens, 0)),
    taskType: String((ctx && ctx.taskType) || '').trim().toLowerCase(),
    taskScale: String((ctx && ctx.taskScale) || '').trim().toLowerCase(),
    // 哪几项特征没算出来。全空 = 抽取完整。
    // 为什么要有：这些抽取原来共用一个 catch，任何一项抛错都会让**后面所有**特征
    // 静默停在 0 —— 而 0 在阈值判断里等于「这题很简单」，是危险方向。
    incomplete: [],
  };
  try {
    let m;
    _FENCE_RE.lastIndex = 0;
    while ((m = _FENCE_RE.exec(text)) !== null) {
      f.codeBlockChars += (m[1] || '').length;
    }
  } catch {
    f.incomplete.push('codeBlockChars');
  }
  try {
    _LOGISH_RE.lastIndex = 0;
    let logHits = 0;
    while (_LOGISH_RE.exec(text) !== null) logHits += 1;
    // 没有逐行长度可测时按每行 40 字符估；只用于过阈值，不追求精确
    f.logBlockChars = logHits * 40;
  } catch {
    f.incomplete.push('logBlockChars');
  }
  try {
    f.fileRefs = _countFileRefs(text);
  } catch {
    f.incomplete.push('fileRefs');
  }
  try {
    const cjk = (text.match(_CJK_RX) || []).length;
    f.cjkRatio = text.length ? cjk / text.length : 0;
  } catch {
    f.incomplete.push('cjkRatio');
  }
  return f;
}

/**
 * 关键词/模式命中,返回 [{flag, hits}] —— hits 是**不同关键词**的命中个数。
 *
 * 为什么要 hits 而不只「命中与否」:实测 high_risk 在本仓 400 条真实提交主题上
 * 命中 **73.8%**(`迁移`/`删除`/`覆盖` 这类单词在中文软件工程表述里太常见,见
 * works/data/khy/feedback/185-p0-price-truth/flag-false-positive.md)。
 * 若一次单词命中就强制抬档,「经济」档会在四分之三的轮次失效 —— 而且没有任何守卫会变红。
 * 所以**能抬档的 flag 必须有 minHits 个不同关键词作证**,单点命中只加权重。
 */
function matchFlagsDetailed(features, card) {
  const out = [];
  try {
    const rules = card && card.flag_rules ? card.flag_rules : {};
    const text = String(features.text || '').toLowerCase();
    for (const key of Object.keys(rules)) {
      if (key.startsWith('_')) continue;
      const rule = rules[key];
      if (!rule || typeof rule !== 'object') continue;
      if (key === 'long_context') {
        // 这一条不是关键词,是四个长度阈值
        if (features.chars >= _num(rule.char_threshold, Infinity)
            || features.codeBlockChars >= _num(rule.code_block_threshold, Infinity)
            || features.logBlockChars >= _num(rule.log_block_threshold, Infinity)
            || features.fileRefs >= _num(rule.file_ref_threshold, Infinity)) {
          out.push({ flag: key, hits: 1 });
        }
        continue;
      }
      const words = [];
      if (Array.isArray(rule.keywords)) words.push(...rule.keywords);
      if (Array.isArray(rule.keywords_zh)) words.push(...rule.keywords_zh);
      if (Array.isArray(rule.keywords_en)) words.push(...rule.keywords_en);
      const distinct = new Set();
      for (const w of words) {
        const s = String(w || '').toLowerCase();
        if (s.length > 0 && text.includes(s)) distinct.add(s);
      }
      if (distinct.size === 0 && Array.isArray(rule.patterns)) {
        for (const p of rule.patterns) {
          try {
            if (new RegExp(p, 'i').test(String(features.text || ''))) distinct.add('re:' + p);
          } catch {
            /* 坏模式跳过 */
          }
        }
      }
      if (distinct.size > 0) out.push({ flag: key, hits: distinct.size });
    }
  } catch {
    /* 命中失败不影响主流程 */
  }
  return out;
}

/**
 * pass A:硬约束 + 规则短路。
 * @returns {{capabilityRequired:string|null, rejectWithoutVision:boolean,
 *            admitTier:string|null, reasons:string[]}}
 */
function admit(features, mode, card) {
  const out = {
    capabilityRequired: features.hasImage ? 'vision' : null,
    rejectWithoutVision: !!features.hasImage,
    admitTier: null,
    reasons: [],
  };
  try {
    const th = (k, d) => _num(card && card.thresholds && card.thresholds[k]
      ? (card.thresholds[k].value !== undefined ? card.thresholds[k].value : card.thresholds[k])
      : d, d);

    // hard 短路(落 ceiling 侧,即最强)
    if (['xlarge', 'huge'].includes(features.taskScale)) {
      out.admitTier = mode.ceiling;
      out.reasons.push(`taskScale=${features.taskScale}→上界`);
    } else if (features.irreversible) {
      out.admitTier = mode.ceiling;
      out.reasons.push('不可逆动作→上界');
    } else if (features.ctxRatio >= th('ctxRatioPromote', 0.7)) {
      out.admitTier = mode.ceiling;
      out.reasons.push(`上下文占用 ${(features.ctxRatio * 100).toFixed(0)}%→上界`);
    } else if (features.turnIndex >= th('deepConversationTurns', 4)
               || features.estCtxTokens >= th('heavyContextTokens', 2000)) {
      // E1 context_rules:会话变深/变重就不许留在最便宜档。
      // 注意这是「最低次中档」而不是「上界」——用 floor 侧往上一格表达。
      out.admitTier = null;
      out.minTier = 'T2';
      out.reasons.push('会话深度/上下文量→最低 T2');
    }

    // trivial 短路(落 floor 侧):长度族四项全低 且 无任何 flag 命中
    if (!out.admitTier && !out.minTier
        && features.chars < 40 && features.codeBlockChars === 0 && features.fileRefs === 0
        && !features.hasImage && !features.irreversible
        && (!features.flags || features.flags.length === 0)) {
      out.admitTier = mode.floor;
      out.reasons.push(`琐碎轮次(${features.chars} 字,无代码块/附件)→下界`);
    }
  } catch {
    out.admitTier = null;
    out.reasons = [];
  }
  return out;
}

/**
 * pass B:demand = Σ w·f,截断到 0..1。
 *
 * 权重「配了但坏」(非数字)与「配了 0」不是一回事:后者是有意不加权,前者是配置错误。
 * 配置错误若按 0 处理,后果是「该信号永远不抬档」且**没有任何地方报错** ——
 * 与 §5.6 的原则相反。所以这里一旦遇到坏权重,整份 demand 退到 0.5(中间档),
 * 让「算不出来」落在安全侧,而不是落在最便宜侧。
 */
function scoreDemand(features, card) {
  let broken = false;
  try {
    const w = (card && card.demand_weights) || {};
    const fw = w.flags || {};
    const num = (v, dflt) => {
      if (v === undefined || v === null) return dflt;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        broken = true;
        return 0;
      }
      return n;
    };
    let s = 0;
    if (features.codeBlockChars > 0) s += num(w.codeBlock, 0.22);
    if (features.logBlockChars > 0) s += num(w.logBlock, 0.14);
    if (features.chars >= 6000) s += num(w.longContext, 0.2);
    if (features.fileRefs > 0) s += Math.min(0.2, features.fileRefs * num(w.fileRefs, 0.1));
    if (features.turnIndex > 0) s += Math.min(0.1, features.turnIndex * num(w.turnDepth, 0.05));
    if (features.toolFails > 0) s += Math.min(0.3, features.toolFails * num(w.toolFails, 0.12));
    if (features.irreversible) s += num(w.irreversible, 0.25);
    for (const f of features.flags || []) s += num(fw[f], 0);
    if (broken) return 0.5;
    return _clamp01(s);
  } catch {
    return 0.5; // 打分失败 → 中间值,而不是 0(0 = 判成最便宜,那是危险方向)
  }
}

/** demand → 能力档。 */
function tierFromDemand(d, card) {
  try {
    const bands = (card && card.demand_tier_bands) || {};
    for (const tier of ['T0', 'T1', 'T2', 'T3']) {
      const b = bands[tier];
      if (!Array.isArray(b) || b.length !== 2) continue;
      if (d >= _num(b[0], 0) && d <= _num(b[1], 1)) return tier;
    }
    return 'T2';
  } catch {
    return 'T2';
  }
}

function _raise(tier, target) {
  // 只上抬:取两个档里更强的那个(索引更小者)
  const a = _TIER_IDX[tier];
  const b = _TIER_IDX[target];
  if (!Number.isFinite(a)) return target;
  if (!Number.isFinite(b)) return tier;
  return a <= b ? tier : target;
}

/**
 * 主入口:三道 pass 的结果 + 最终请求档。绝不抛。
 * @param {string} prompt
 * @param {object} ctx 见 extractFeatures;另需 card / mode
 * @returns {object|null} 卡或 mode 不合法 → null(调用方走旧路径)
 */
function decide(prompt, ctx = {}) {
  try {
    const mode = ctx.mode;
    const card = ctx.card;
    if (!mode || !card || !Number.isFinite(mode.floorIdx) || !Number.isFinite(mode.ceilingIdx)) {
      return null;
    }
    const features = extractFeatures(prompt, ctx);
    const matched = matchFlagsDetailed(Object.assign({ text: prompt }, features), card);
    features.flags = matched.map((e) => e.flag);
    const hitsOf = (k) => {
      const e = matched.find((x) => x.flag === k);
      return e ? e.hits : 0;
    };
    const rules = (card && card.flag_rules) || {};
    // 能抬档的 flag 必须凑够 minHits 个**不同**关键词;单点命中只贡献 demand 权重。
    const raisesTier = (k, dflt) => {
      const min = _num(rules[k] && rules[k].tierRaise && rules[k].tierRaise.minHits, dflt);
      return hitsOf(k) >= min;
    };

    const a = admit(features, mode, card);
    const d = scoreDemand(features, card);
    let tier = a.admitTier || tierFromDemand(d, card);
    if (a.minTier) tier = _raise(tier, a.minTier);

    // pass C 的 flag 上抬:命中 high_risk / debug 至少要到 T1(不许留在 T2/T3)
    if (raisesTier('high_risk', 2)) tier = _raise(tier, 'T1');
    if (raisesTier('debug', 2)) tier = _raise(tier, 'T1');
    if (raisesTier('repo_arch', 2) || raisesTier('implement', 2)) tier = _raise(tier, 'T2');

    // band 收束:任何抬升都不得越出本档 ceiling(§4.2 的经济档判据)
    if (_TIER_IDX[tier] < mode.ceilingIdx) tier = mode.ceiling;
    if (_TIER_IDX[tier] > mode.floorIdx) tier = mode.floor;

    // §15-2 自查：本方案明确「不做 query 级路由」——只按用户这句话分类的实现不采纳。
    // 但执行状态那几个输入(ctxRatio / estCtxTokens / toolFails)目前**没有任何生产方**
    // (实测全仓零赋值点，见 185 §16.4n)，所以此刻的 demand 事实上接近 query-only。
    // 与其悄悄违背红线，不如把这个事实写进返回值 ⇒ 它会原样进 auto-route 样本，
    // 让 route-replay 和人都看得见「这一轮的判断里有几条来自执行状态」。
    const _execKeys = ['ctxRatio', 'estCtxTokens', 'toolFails', 'turnIndex', 'hasImage'];
    // queryOnly 只数**独立于主诉**、且**非空洞**的信号。两类冒充要挡：
    //   ① `estCtxTokens` 在无历史时是拿主诉文本估的 —— 它不是执行状态，是主诉的另一种写法；
    //   ② 首轮请求的 `toolFails=0` / `ctxRatio=0` / `hasImage=false` 全是「什么都没发生」的
    //      真空值。把它们算成证据，replay 的覆盖度就会被自己的默认值灌高。
    // 判据：数值必须 > 0，布尔必须为真，才算这一轮真带来了执行状态。
    const _execKeysInd = ['ctxRatio', 'toolFails', 'turnIndex', 'hasImage'];
    const _present = [];
    const _absent = [];
    const _independent = [];
    for (const k of _execKeys) {
      const v = ctx[k];
      const got = typeof v === 'boolean' ? true : v !== undefined && v !== null && Number.isFinite(Number(v));
      (got ? _present : _absent).push(k);
      if (got && _execKeysInd.includes(k)) {
        const trivial = typeof v === 'boolean' ? v === false : Number(v) <= 0;
        if (!trivial) _independent.push(k);
      }
    }

    return {
      tier,
      demand: Number(d.toFixed(4)),
      flags: features.flags,
      features,
      admitted: !!a.admitTier,
      capabilityRequired: a.capabilityRequired,
      reasons: a.reasons.slice(0, 6),
      // `present` 仍列全部（看得见取到了什么）；判定只看 independent。
      stateInputs: {
        present: _present,
        absent: _absent,
        independent: _independent,
        queryOnly: _independent.length === 0,
      },
    };
  } catch {
    return null;
  }
}

/** 兼容接口:只要 flag 名的调用方不必理解 hits。 */
function matchFlags(features, card) {
  try {
    return matchFlagsDetailed(features, card).map((e) => e.flag);
  } catch {
    return [];
  }
}

module.exports = {
  admit,
  decide,
  extractFeatures,
  matchFlags,
  matchFlagsDetailed,
  scoreDemand,
  tierFromDemand,
};
