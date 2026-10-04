'use strict';

/**
 * autoModelSelect — 纯叶子:把「自动挑最适合当前任务且可用的模型」收敛成一处确定性逻辑。
 *
 * 背景(为什么存在):
 *   gateway 早已把 `auto` 当作 *adapter 级* 保留哨兵——`GATEWAY_PREFERRED_ADAPTER=auto`
 *   时 `aiGateway.autoSelectModel(taskType, options)` 每次生成都按「能力匹配 + 健康排序 +
 *   可用性」选一个 adapter(已是任务/可用性感知),但落到的是该 adapter 的**默认模型**。
 *   模型列表(/model 选择器)里却**没有**一个用户可显式选中的「Auto」入口,而目标正是
 *   「在模型列表下设置一个 auto 模型,自动选择最适合当前任务且可用的模型」。
 *
 *   本叶子补两件事:
 *     1. 「Auto」在选择器里长什么样、选中后 value 是什么(buildAutoChoice / isAutoSelection /
 *        AUTO_SENTINEL)——单一真源,选择器与持久化共用,避免各处硬编码 'auto' 字面漂移。
 *     2. 给定「当前真正可用的候选模型列表」+ 任务类型,按任务贴合度(tier)+ 能力匹配 +
 *        发现来源可信度排序,挑出最合适的一个可用模型 id(rankAutoModels / pickAutoModel)。
 *        这是可被选择器预览、子 agent、未来运行时消费的纯排序原语;IO(枚举可用模型 / 探活)
 *        留在调用壳。
 *
 * 契约(与全仓纯叶子一致):
 *   - 零 IO(只读 process.env 做门控、经 modelTier 读 tier 覆盖 env;不碰 fs/网络/子进程/时钟/随机)。
 *   - 确定性:同输入恒同输出(decorate-sort-undecorate 带原下标做稳定排序)。
 *   - 绝不抛:任何异常路径都返回安全值('' / [] / null / false / 原样)。
 *   - env 门控 KHY_AUTO_MODEL_SELECT 默认开;关 = 调用方据 isEnabled() 短路:选择器不 unshift
 *     Auto 入口、持久化不特判 → 逐字节回退到「模型列表里没有 Auto、auto 仅靠 adapter 哨兵」的旧行为。
 *
 * 诚实边界:
 *   - 「最适合任务且可用」在 *运行时* 仍以 adapter 粒度经既有 autoSelectModel 每请求解析(真·任务/
 *     可用性感知);本叶子的 *模型* 粒度排序被选择器用于「Auto 入口的实时预览(当前会选哪个模型)」
 *     并作为原语开放。运行时逐请求把 auto 收敛到具体**模型 id** 受限于热路径无同步的「按 adapter
 *     枚举模型」缓存(catalog edge 的 provider 是 poolKey 而非 adapter key),留作后续。
 */

const modelTier = require('../modelTier');

// ── 门控 ─────────────────────────────────────────────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']); // CANON off-words
function isEnabled(env = process.env) {
  // flagRegistry 优先(集中真源),失败/不可用再退本地 CANON 解析。绝不抛。
  try {
    return require('../flagRegistry').isFlagEnabled('KHY_AUTO_MODEL_SELECT', env || process.env);
  } catch {
    /* fall through to local */
  }
  try {
    const raw = (env || process.env).KHY_AUTO_MODEL_SELECT;
    const v = String(raw === undefined || raw === null ? 'true' : raw)
      .trim()
      .toLowerCase();
    return !_FALSY.has(v);
  } catch {
    return true;
  }
}

// 「Auto」在模型列表 / 偏好 env 里的哨兵字面。单一真源,别处引用而非硬编码。
const AUTO_SENTINEL = 'auto';

/**
 * 判断一次选择(选择器 value / 偏好对)是否为「Auto」模式。
 * 接受形状:{adapter,model} | 裸字符串 'auto'。大小写/空白不敏感。绝不抛。
 * @param {*} sel
 * @returns {boolean}
 */
function isAutoSelection(sel) {
  try {
    if (sel == null) {
      return false;
    }
    if (typeof sel === 'string') {
      return sel.trim().toLowerCase() === AUTO_SENTINEL;
    }
    if (typeof sel === 'object') {
      const a = String(sel.adapter || '')
        .trim()
        .toLowerCase();
      const m = String(sel.model || '')
        .trim()
        .toLowerCase();
      return a === AUTO_SENTINEL || m === AUTO_SENTINEL;
    }
    return false;
  } catch {
    return false;
  }
}

// tier → 有序下标(T0 最强/最重 … T3 最轻),用于算「距期望 tier 的距离」。
const _TIER_ORDER = { T0: 0, T1: 1, T2: 2, T3: 3 };
// 任务类型 → 期望 tier。推理最强档;代码/分析次强;普通对话取均衡偏轻(够用不浪费)。
const _TASK_PREFER_TIER = {
  reasoning: 'T0',
  code: 'T1',
  coding: 'T1',
  analysis: 'T1',
  conversation: 'T2',
  chat: 'T2',
};
const _DEFAULT_PREFER_TIER = 'T2';
// 任务规模 → 期望 tier 下限(只上抬不下调):large 起的大任务不允许偏好落在
// 弱档模型上(DESIGN-ARCH-161 P3-Q1)。不传 taskScale 时行为与历史逐字节一致。
const _SCALE_TIER_FLOOR = { large: 'T1', xlarge: 'T0', huge: 'T0' };
// 任务类型 → 偏好能力(有则加权更贴合)。缺省不加权。
const _TASK_PREFER_CAPABILITY = {
  code: 'text',
  coding: 'text',
  reasoning: 'text',
  analysis: 'text',
  conversation: 'text',
  chat: 'text',
};
// 发现来源可信度:provider 真实通告 > 配置 > 静态提示 > 未知。
const _SOURCE_RANK = { remote: 0, chat: 0, config: 1, hint: 2 };
// 可用性:仅 active(或未知)算可用;disabled/cooldown 视为不可用被滤除。
const _UNAVAILABLE_STATUS = new Set(['disabled', 'cooldown']);

function _preferTierForTask(taskType) {
  const t = String(taskType || '')
    .trim()
    .toLowerCase();
  return _TASK_PREFER_TIER[t] || _DEFAULT_PREFER_TIER;
}

function _sourceRank(src) {
  const r =
    _SOURCE_RANK[
      String(src || '')
        .trim()
        .toLowerCase()
    ];
  return Number.isFinite(r) ? r : 3;
}

/**
 * 把候选模型列表归一成 {model, adapter, tier, status, capability, source}[],
 * 去空、按 model 去重(首个胜)。接受元素形状:
 *   {model|id, adapter, tier?, status?, capability?, source?|discoverySource?} | 裸字符串。
 * tier 缺失时经 modelTier.resolveTier 补(纯读 env 覆盖,绝不抛)。
 * @param {Array} candidates
 * @returns {Array<{model:string,adapter:string,tier:string,status:string,capability:string,source:string}>}
 */
function _normalizeCandidates(candidates) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(candidates)) {
    return out;
  }
  for (const entry of candidates) {
    let model = '';
    let adapter = '';
    let tier = '';
    let status = '';
    let capability = '';
    let source = '';
    if (typeof entry === 'string') {
      model = entry;
    } else if (entry && typeof entry === 'object') {
      model = entry.model || entry.id || entry.name || '';
      adapter = entry.adapter || '';
      tier = entry.tier || '';
      status = entry.status || '';
      capability = entry.capability || '';
      source = entry.source || entry.discoverySource || '';
    }
    model = typeof model === 'string' ? model.trim() : '';
    if (!model) {
      continue;
    }
    const key = model.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (!tier || !_TIER_ORDER.hasOwnProperty(String(tier).toUpperCase())) {
      try {
        tier = modelTier.resolveTier(model) || 'T2';
      } catch {
        tier = 'T2';
      }
    }
    out.push({
      model,
      adapter: typeof adapter === 'string' ? adapter : '',
      tier: String(tier).toUpperCase(),
      status: typeof status === 'string' ? status.trim().toLowerCase() : '',
      capability: typeof capability === 'string' ? capability.trim().toLowerCase() : '',
      source: typeof source === 'string' ? source : '',
    });
  }
  return out;
}

/**
 * 从「当前真正可用的候选模型」里按任务贴合度排序,返回排好序的候选对象数组。
 *
 * 规则:
 *   1. 归一去重;非数组/空 → []。
 *   2. 过滤不可用(status ∈ {disabled, cooldown});全被滤 → []。
 *   3. 稳定排序(decorate-sort-undecorate):
 *        ① 距任务期望 tier 的距离(reasoning→T0 最强 … conversation→T2 均衡);
 *        ② 能力匹配(命中任务偏好 capability 者优先);
 *        ③ 发现来源 remote/chat > config > hint > unknown;
 *        ④ 原始下标(保证确定性)。
 *   4. opts.max 截断(默认全量)。
 *
 * @param {string} taskType     'reasoning'|'code'|'analysis'|'conversation'|…(未知→均衡默认)
 * @param {Array}  candidates   [{model,adapter,tier?,status?,capability?,source?}] | 裸 id[]
 * @param {{max?:number, preferTier?:string, taskScale?:'small'|'medium'|'large'|'xlarge'|'huge'}} [opts]
 * @returns {Array<{model:string,adapter:string,tier:string,status:string}>} 失败/空 → []
 */
function rankAutoModels(taskType, candidates, opts = {}) {
  try {
    const list = _normalizeCandidates(candidates).filter((e) => !_UNAVAILABLE_STATUS.has(e.status));
    if (list.length === 0) {
      return [];
    }

    let preferTier =
      opts && typeof opts.preferTier === 'string' ? opts.preferTier.trim().toUpperCase() : '';
    if (!_TIER_ORDER.hasOwnProperty(preferTier)) {
      preferTier = _preferTierForTask(taskType);
    }
    // Large tasks floor the preference toward capable tiers (raise only, never lower).
    const scaleFloor =
      _SCALE_TIER_FLOOR[
        String((opts && opts.taskScale) || '')
          .trim()
          .toLowerCase()
      ];
    if (
      scaleFloor &&
      _TIER_ORDER.hasOwnProperty(scaleFloor) &&
      _TIER_ORDER[scaleFloor] < _TIER_ORDER[preferTier]
    ) {
      preferTier = scaleFloor;
    }
    const preferIdx = _TIER_ORDER[preferTier];
    const preferCap =
      _TASK_PREFER_CAPABILITY[
        String(taskType || '')
          .trim()
          .toLowerCase()
      ] || '';

    const decorated = list.map((e, i) => {
      const tIdx = _TIER_ORDER.hasOwnProperty(e.tier) ? _TIER_ORDER[e.tier] : _TIER_ORDER.T2;
      const capMiss = preferCap && e.capability && e.capability !== preferCap ? 1 : 0;
      return {
        entry: e,
        idx: i,
        dist: Math.abs(tIdx - preferIdx),
        capMiss,
        src: _sourceRank(e.source),
      };
    });
    decorated.sort(
      (a, b) => a.dist - b.dist || a.capMiss - b.capMiss || a.src - b.src || a.idx - b.idx
    );

    const ranked = decorated.map((d) => ({
      model: d.entry.model,
      adapter: d.entry.adapter,
      tier: d.entry.tier,
      status: d.entry.status || 'active',
    }));
    const max = Number.isFinite(opts && opts.max) && opts.max > 0 ? opts.max | 0 : ranked.length;
    return ranked.slice(0, max);
  } catch {
    return [];
  }
}

/**
 * 挑出最合适的一个可用模型(rankAutoModels 的头名),无则 null。绝不抛。
 * @param {string} taskType
 * @param {Array}  candidates
 * @param {object} [opts]
 * @returns {{model:string, adapter:string, tier:string}|null}
 */
function pickAutoModel(taskType, candidates, opts = {}) {
  try {
    const ranked = rankAutoModels(taskType, candidates, opts);
    return ranked.length > 0 ? ranked[0] : null;
  } catch {
    return null;
  }
}

/**
 * 构造「Auto」在模型选择器里的一条 choice 描述(单一真源)。
 * value 用 {adapter:'auto', model:'auto'} 与既有 adapter 哨兵对齐;持久化会把它特判成
 * GATEWAY_PREFERRED_ADAPTER=auto + 清空 GATEWAY_PREFERRED_MODEL(见 isAutoSelection 消费点)。
 * @param {{previewModel?:string, previewAdapter?:string, chalk?:object}} [opts]
 * @returns {{name:string, primary:string, secondary:string, group:string, groupMeta:string,
 *            value:{adapter:string, model:string}, disabled:boolean}}
 */
function buildAutoChoice(opts = {}) {
  // 选择器分层字段（[DESIGN-ARCH-167]）：主信息 = `★ Auto`，次信息 = **只放预览**。
  // 这是 ModelPicker 的**第 5 个** choice 产出点 —— 另 4 个（apiAdapter 两路 + 兜底 +
  // 外部智能体投影）都在 gatewayModelChoices 里供数，漏了这一个会让 Auto 行成为
  // **唯一不参与分层**的行，并静默依赖渲染侧 `c.primary || c.name` 的回退。
  // group 取 `'Auto'`：它不是某个上游供应商，是自己的类别；1 条 ⇒ 不画标题
  // （MIN_GROUP_FOR_SECTION=2），与旧行为（回退 `value.adapter='auto'`）等价，
  // 但不再静默依赖那条回退。
  //
  // §12-Q11：那 17 字说明（`自动选择最适合当前任务且可用的模型`）**不再进次信息**。
  // 真入口 A/B 实测（.khyos/diag/model-picker-grouping/real-choices-ab.js，80×24 真帧）：
  // 加上它之后全表只剩**这 1 行**被 `…` 截断，而切掉的正是最有信息量的预览。
  // 于是「说明」让位给「预览」：行内只留 `★ Auto  (当前最优: X)`；无预览时退化成裸
  // `★ Auto`（不是静默丢失 —— `name` 仍带完整说明，见下）。
  //
  // `name` **一字未改**（仍是「含标记的人面串」）。它不是渲染用的字段了（分层后由
  // primary/secondary 决定上屏文本），但仍有两个既有消费者，改它会连带改两个别的面：
  //   ① `cli/handlers/advisor.js` 拿 `c.name` 当候选 label 喂给顾问；
  //   ② `ModelPicker.filterChoices` 拿 `c.name` 当搜索匹配文本（搜「自动」仍能命中 Auto）。
  // 另外它还是本改动 A/B 量具的「改前形态」来源（只喂 name ⇒ 逐字回退旧渲染）。
  const GROUP = 'Auto';
  const HINT = '自动选择最适合当前任务且可用的模型';
  try {
    const preview = opts && typeof opts.previewModel === 'string' ? opts.previewModel.trim() : '';
    const c = opts && opts.chalk;
    const dim = c && typeof c.dim === 'function' ? c.dim : (s) => s;
    const cyan = c && typeof c.cyan === 'function' ? c.cyan : (s) => s;
    const previewText = preview ? dim(`(当前最优: ${preview})`) : '';
    return {
      name: `${cyan('★ Auto')} ${dim(HINT)}${previewText ? ` ${previewText}` : ''}`,
      primary: cyan('★ Auto'),
      secondary: previewText,
      group: GROUP,
      groupMeta: '',
      value: { adapter: AUTO_SENTINEL, model: AUTO_SENTINEL },
      disabled: false,
    };
  } catch {
    return {
      name: `★ Auto ${HINT}`,
      primary: '★ Auto',
      secondary: '',
      group: GROUP,
      groupMeta: '',
      value: { adapter: AUTO_SENTINEL, model: AUTO_SENTINEL },
      disabled: false,
    };
  }
}

/** 自描述(给工具 / CLI / 文档 / 提示词用)。 */
function describeAutoModelSelect() {
  return {
    gate: 'KHY_AUTO_MODEL_SELECT',
    defaultOn: true,
    sentinel: AUTO_SENTINEL,
    summary:
      '模型列表里增设一个用户可选的「Auto」入口:选中后以 adapter 哨兵每请求经既有 ' +
      'autoSelectModel 按任务/可用性自动选型;本叶子提供 Auto 入口的构造与「最适合任务且可用的' +
      '模型」纯排序原语(选择器实时预览 + 可复用),门控关则不 unshift Auto 入口(字节回退)。',
  };
}

module.exports = {
  isEnabled,
  AUTO_SENTINEL,
  isAutoSelection,
  rankAutoModels,
  pickAutoModel,
  buildAutoChoice,
  describeAutoModelSelect,
};
