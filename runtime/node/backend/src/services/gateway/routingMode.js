'use strict';

/**
 * routingMode — 纯叶子:四档模式(auto/极致/性能/经济)的解析与派生。
 *
 * 为什么存在(见 [DESIGN-ARCH-185] §4):四档不是四套「各挑一个模型」的代码,
 * 而是同一个路由器的四个参数点。本叶子只做参数点的**解析**,不做选型:
 *   mode → {能力 floor/ceiling, λ, k, escalateOn, β(思考预算), π(prompt 策略)}
 * 选型在 autoModelSelect.rankAutoModels(它消费本叶子的输出),
 * 特征与四道 pass 在 routeDemand.js。
 *
 * 两把闸(这是本模块最重要的设计):
 *   KHY_ROUTING_MODES  模式轴**存在**:选择器出 4 行、env 可读、记录带 mode。默认开。
 *   KHY_ROUTE_APPLY    路由结果**改写** options.model。默认关 —— PROCESS-008 的 S1 观察者档
 *                      要求「只记录不改道」。把它打开是一次人工升档裁决,不是配置偏好。
 *   两把闸分开是因为回滚语义不同:关前者 = 回到「只有一个 Auto 哨兵」的现状;
 *   关后者 = 保留观测但恢复旧路由。合成一把闸会让 S1 的样本在回滚时一起丢。
 *
 * 契约(与全仓纯叶子一致):
 *   - 零 IO:档位卡由调用方注入;缺省时经非叶子伴生层 routingModeCard 读,
 *     磁盘动作全部落在那个文件,本文件不 require fs。
 *   - 确定性:同输入恒同输出。
 *   - 绝不抛:卡坏 / 档名不认识 / 入参畸形 → 返回 null 或安全值,由调用方回退旧路径。
 */

const routingModeCard = require('./routingModeCard');
const path = require('path');

const CARD_REL = path.join('config', 'models', 'routing-modes.json');

// tier 方向与 modelTier._TIER_ORDER 一致:T0 最强最重 … T3 最轻。
// 这里**不** require modelTier:它读 env 且带 harnessProfile 逻辑,叶子间依赖会让
// 单测必须同时构造两套 env。方向常量重复一次的代价,比一条隐式 env 耦合小。
const _TIER_IDX = { T0: 0, T1: 1, T2: 2, T3: 3 };

const _FALSY = new Set(['0', 'false', 'off', 'no']); // CANON off-words

function _flag(name, env, dflt) {
  try {
    return require('../flagRegistry').isFlagEnabled(name, env || process.env);
  } catch {
    /* 未登记或 registry 不可用 → 本地 CANON 解析 */
  }
  const raw = (env || process.env)[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return dflt;
  return !_FALSY.has(String(raw).trim().toLowerCase());
}

/** 模式轴是否存在(选择器与记账的总闸)。 */
function isEnabled(env = process.env) {
  return _flag('KHY_ROUTING_MODES', env, true);
}

/** flag 是否在登记表里。未登记的 flag 在 isFlagEnabled 里**返回 true**,
 *  所以「没登记」和「登记为默认开」在效果上一样 —— 这正是 opt-in 闸最容易被静默打开的路。 */
function _isRegistered(name) {
  try {
    const { FLAGS } = require('../flagRegistry');
    return !!(FLAGS && Object.prototype.hasOwnProperty.call(FLAGS, name));
  } catch {
    return false;
  }
}

// 落地阶段真源(PROCESS-008 / [DESIGN-ARCH-185] §10)。字面常量,守卫 check-rollout-stage
// 拿它与登记表 FEATURE-OWNERSHIP.json 的 executorStage.constant 比对(先例 autoModelRouting)。
// S1=观察者:四档可选可记账,但**不改写路由**;S2=顾问:状态行提示;S3=生效。
// 升档是人的决定,守卫只校验不代劳。
const KHY_ROUTE_APPLY_STAGE = 'S1';

/**
 * 生效阶段。默认 S1;仅认 S2/S3,其余一律回落 S1 —— 未知值绝不 fail-open 到更高阶段
 * (RUNTIME-010 A2-3:授权解析禁止 fail-open)。
 */
function getStage(env = process.env) {
  const raw = String((env || process.env).KHY_ROUTE_APPLY_STAGE || KHY_ROUTE_APPLY_STAGE)
    .trim()
    .toUpperCase();
  if (raw === 'S2' || raw === 'S3') return raw;
  return KHY_ROUTE_APPLY_STAGE;
}

/**
 * 路由结果是否允许改写 options.model。
 * 三层都不放行才算关:未登记 → 关;登记为 opt-in 且 env 未给 → 关;阶段未到 S3 → 关。
 * 「flag 打开但阶段是 S1」是**预期状态**(运维想提前接线看效果),此时仍不改道,
 * 且状态行应能点名是阶段挡住的 —— 所以两个维度都要可观测,不能合成一个布尔。
 */
function isApplyEnabled(env = process.env) {
  try {
    if (!isEnabled(env)) return false;
    if (!_isRegistered('KHY_ROUTE_APPLY')) return false;
    if (!_flag('KHY_ROUTE_APPLY', env, false)) return false;
    return getStage(env) === 'S3';
  } catch {
    return false;
  }
}

/** 被哪一层挡住:供状态行点名(RUNTIME-002 不许含糊的「未生效」)。 */
function applyBlockedBy(env = process.env) {
  try {
    if (!isEnabled(env)) return 'KHY_ROUTING_MODES=off';
    // 钉选是**第四层**，且排在应用侧三层之前：它决定整个 auto 分支不执行，
    // 所以「挡住你的其实是钉选」不能报成 KHY_ROUTE_APPLY=off（§16.4ar 实测到的指错层）。
    if (pinnedBypass(env)) return 'pinned';
    if (!_isRegistered('KHY_ROUTE_APPLY')) return 'KHY_ROUTE_APPLY-unregistered';
    if (!_flag('KHY_ROUTE_APPLY', env, false)) return 'KHY_ROUTE_APPLY=off';
    const st = getStage(env);
    if (st !== 'S3') return `stage=${st}`;
    return '';
  } catch {
    return 'error';
  }
}

function _normTier(t) {
  const s = String(t || '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(_TIER_IDX, s) ? s : '';
}

/**
 * 解析档名 → 归一化的档位卡。绝不抛。
 * 不认识 → 回 defaultMode(即 auto),并在返回对象里如实标 `requested` 与 `used` 不同,
 * 让状态行能点名「你要的档不存在,按 auto 走了」。回退到 economy 是危险的:
 * 那会把一次拼写错误变成一次静默降档。
 * @returns {object|null} 卡坏 → null(调用方走旧路径)
 */
function resolveMode(name, opts = {}) {
  try {
    const card = opts.card || _loadCard(opts.env);
    const modes = card && card.modes && typeof card.modes === 'object' ? card.modes : null;
    if (!modes) return null;

    const requested = String(name || '').trim().toLowerCase();
    let used = requested;
    // 卡里的 `label` 是选择器**画在屏幕上**的那个词（极致/性能/经济）。
    // 人在 .env 里手写时只会写他看见的那个词，所以 label 必须也是合法档名 ——
    // 否则「按 UI 显示的词配置」会静默变成 auto：路由没变、理由也没有。
    // 逐字面匹配（不做模糊），模糊匹配会把「经济型」这种手误接到错的档上。
    if (used && !modes[used]) {
      const byLabel = Object.keys(modes).find(
        (k) => String(modes[k] && modes[k].label).trim().toLowerCase() === used
      );
      if (byLabel) used = byLabel;
    }
    // `unrecognized` 只有在**非空且不认识**时才为真：没配（空串）不是配置错误，
    // 而一次拼错必须被点名（调用方据此发状态行）。
    const unrecognized = Boolean(requested) && !modes[used];
    // 回退条件与上面**不同**：任何不认识的名字（含空串）都回默认档。
    // 只按 unrecognized 回退会让空档名停在 ''，raw 拿不到 → 整个模式轴返回 null
    // （即「没配 env」被当成「卡坏了」处理，模式轴对未配置的安装直接消失）。
    if (!modes[used]) used = String(card.defaultMode || 'auto').trim().toLowerCase();
    const raw = modes[used];
    if (!raw || typeof raw !== 'object') return null;

    const floor = _normTier(raw.capabilityFloor) || 'T3';
    const ceiling = _normTier(raw.capabilityCeiling) || 'T0';
    // floor 必须不比 ceiling 更弱(数值上 floor >= ceiling 即为写反)。
    // 写反会让 band 为空 → 全池被滤光 → 表现为「auto 选不出模型」而不是「配置错了」,
    // 所以这里判卡坏并返回 null,而不是将错就错。
    if (_TIER_IDX[floor] < _TIER_IDX[ceiling]) return null;

    return {
      requested,
      used,
      // 调用方据此发状态行：本文件注释里早就承诺了「你要的档不存在，按 auto 走了」，
      // 但此前没有任何东西读它 —— 承诺写在注释里而没接出来，等于没承诺。
      unrecognized,
      label: typeof raw.label === 'string' ? raw.label : used,
      intent: typeof raw.intent === 'string' ? raw.intent : '',
      floor,
      ceiling,
      floorIdx: _TIER_IDX[floor],
      ceilingIdx: _TIER_IDX[ceiling],
      strongShare: Number.isFinite(raw.strongShare) ? raw.strongShare : null,
      lambda: Number.isFinite(raw.lambda) ? raw.lambda : null,
      k: Number.isFinite(raw.k) && raw.k > 0 ? Math.floor(raw.k) : 1,
      escalateOn: Array.isArray(raw.escalateOn) ? raw.escalateOn.slice() : [],
      thinking: String(raw.thinking || 'auto'),
      promptPolicy: String(raw.promptPolicy || 'auto'),
      fallbackMode: String(card.fallbackMode || 'perf'),
      stickyEnabled: !!(card.stickyTier && card.stickyTier.enabled === true),
      thresholds: card.thresholds && typeof card.thresholds === 'object' ? card.thresholds : {},
      _card: card,
    };
  } catch {
    return null;
  }
}

/** 阈值取值:thresholds.<key>.value 优先,兼容裸数字,坏值回退。 */
function thresholdOf(mode, key, dflt) {
  try {
    const t = mode && mode.thresholds ? mode.thresholds[key] : null;
    const v = t && typeof t === 'object' ? t.value : t;
    return Number.isFinite(v) ? v : dflt;
  } catch {
    return dflt;
  }
}

/** tier → 序号（T0=0 最强 … T3=3 最轻）；不认识返回 NaN，调用方自己判有限性。 */
function tierIdx(tier) {
  const t = _normTier(tier);
  return Object.prototype.hasOwnProperty.call(_TIER_IDX, t) ? _TIER_IDX[t] : NaN;
}

/** 候选 tier 是否落在本档 band 内(含端点)。 */
function allowsTier(mode, tier) {
  try {
    const i = _TIER_IDX[_normTier(tier)];
    if (!Number.isFinite(i) || !mode) return false;
    return i <= mode.floorIdx && i >= mode.ceilingIdx;
  } catch {
    return false;
  }
}

/**
 * λ 判定:成本项到底参不参与排序。**这是 §5.4 那条硬规则的唯一落点。**
 *
 * 返回 null 表示「退出」:调用方必须把成本项从打分里整个拿掉,
 * 而不是「乘个 0」—— 乘 0 会让 costNorm 仍被计算与被打印,看起来像参与过。
 *
 * 退出条件(任一成立):
 *   1. 档位卡未给 λ(未标定)
 *   2. 池内存在价格不可用的候选(assumed/flat/unknown)—— 只要有一个就不许拿成本当降档理由,
 *      否则那个「其实不知道多少钱」的候选会被系统性饿死
 *   3. auto 档且预算已吃紧到无法表达偏好(remainingRatio 缺失)
 */
function lambdaFor(mode, ctx = {}) {
  try {
    if (!mode || !Number.isFinite(mode.lambda)) return null;
    if (ctx.coverage && ctx.coverage.allUsable !== true) return null;
    if (mode.used === 'auto') {
      const r = Number(ctx.budgetRatio);
      if (!Number.isFinite(r)) return null;
      const base = Number.isFinite(ctx.autoLambdaBase) ? ctx.autoLambdaBase : mode.lambda;
      // 预算剩余越少越看重成本,但**永不**到 0.95 以上:留一条「质量优先」的顶。
      return Math.max(0, Math.min(0.95, base * (1.5 - r)));
    }
    return mode.lambda;
  } catch {
    return null;
  }
}

/**
 * 派生 β（思考下限）。**只返回本仓 dial 表达得出的值**：
 * `{level, sets, via}`，其中 sets ∈ {'low','high','max',null}，null = 不干预 tier 默认。
 *
 * 方向性设计：**收紧下限（省）比抬高下限（花）难**。none 需要「判成最轻档」且「margin 足够稳」
 * 双条件；high 只要一个 flag 就够。这与 opensquilla 的 thinking_mode_rules 同构
 * （其最低档要 max_class + min_margin 双门），但词表换成 KHY_HARNESS_THINKING_FLOOR 的真实取值。
 * 造一个 'medium' 之类的档位会被 modelTier 静默降级成 null —— 配了等于没配，故不造。
 */
function deriveThinking(mode, ctx = {}) {
  const out = { level: null, sets: null, via: 'default' };
  try {
    if (!mode) return out;
    const rules = (mode._card && mode._card.thinking_mode_rules) || {};
    const margin = Number.isFinite(ctx.margin) ? ctx.margin : 0;
    const clsIdx = _TIER_IDX[_normTier(ctx.cls)];
    const flags = Array.isArray(ctx.flags) ? ctx.flags : [];
    const tierOf = (t) => _TIER_IDX[_normTier(t)];
    const applied = (name) => ({
      level: name,
      sets: rules[name] && rules[name].sets !== undefined ? rules[name].sets : null,
      via: 'rule',
    });

    // mode 显式钉死的档优先（极致=max、经济=low）
    if (mode.thinking && mode.thinking !== 'auto') {
      const setMap = { none: null, low: 'low', high: 'high', max: 'max' };
      const key = String(mode.thinking).trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(setMap, key)) {
        return { level: key, sets: setMap[key], via: 'mode' };
      }
    }
    if (!Number.isFinite(clsIdx)) return out;

    // 由强到弱评估：先满足「必须多想」的条件
    if (rules.max && tierOf(rules.max.minClass) >= 0 && clsIdx <= tierOf(rules.max.minClass)) {
      return applied('max');
    }
    if (rules.high && tierOf(rules.high.minClass) >= 0 && clsIdx <= tierOf(rules.high.minClass)) {
      return applied('high');
    }
    if (rules.high && Array.isArray(rules.high.anyFlags)
        && rules.high.anyFlags.some((f) => flags.includes(f))) {
      return applied('high');
    }
    // 「省」的两级必须**先判 none 再判 low**：none 的 margin 门(0.5)是 low 的(0.4)的子集，
    // 反过来排会让 none 永远不可达 —— 表现为「配了最省的一级却从来没生效过」，
    // 而且不会有任何报错。这条顺序是测试 #36 抓出来的。
    if (rules.none && tierOf(rules.none.maxClass) >= 0 && clsIdx >= tierOf(rules.none.maxClass)
        && margin >= Number(rules.none.minMargin || 0.5)) {
      return applied('none');
    }
    if (rules.low && tierOf(rules.low.maxClass) >= 0 && clsIdx >= tierOf(rules.low.maxClass)
        && margin >= Number(rules.low.minMargin || 0.4)) {
      return applied('low');
    }
    return out;
  } catch {
    return out;
  }
}

/**
 * 派生 π(prompt 策略)。**P0 受 noFlags 门控** —— 高风险/严格格式/调试场景下
 * 不许缩短回答。这条门控是防「省钱的 prompt 把要命的约束省掉」。
 */
function derivePromptPolicy(mode, ctx = {}) {
  const out = { id: 'P1', hint: '', via: 'default' };
  try {
    if (!mode) return out;
    const policies = (mode._card && mode._card.prompt_policies) || {};
    const flags = Array.isArray(ctx.flags) ? ctx.flags : [];
    let id = mode.promptPolicy && mode.promptPolicy !== 'auto' ? mode.promptPolicy : null;
    if (!id) {
      const margin = Number.isFinite(ctx.margin) ? ctx.margin : 0;
      const difficulty = Number.isFinite(ctx.difficulty) ? ctx.difficulty : 0.5;
      const p2 = policies.P2;
      const p0 = policies.P0;
      if (p2 && Array.isArray(p2.anyFlags) && p2.anyFlags.some((f) => flags.includes(f))) id = 'P2';
      else if (p0 && difficulty <= Number(p0.conditions?.maxDifficulty ?? 0.8)
               && margin >= Number(p0.conditions?.minMargin ?? 0.4)
               && !(Array.isArray(p0.noFlags) && p0.noFlags.some((f) => flags.includes(f)))) id = 'P0';
      else id = 'P1';
    }
    // mode 钉了 P0 也不得越过 noFlags 门控:钉选表达的是「愿意省」,不是「可以丢约束」
    const pol = policies[id];
    if (pol && id === 'P0' && Array.isArray(pol.noFlags)
        && pol.noFlags.some((f) => flags.includes(f))) {
      return { id: 'P1', hint: '', via: 'noFlags-override' };
    }
    return {
      id,
      hint: String((pol && (pol.hint_zh || pol.hint_en)) || ''),
      via: mode.promptPolicy && mode.promptPolicy !== 'auto' ? 'mode' : 'rule',
    };
  } catch {
    return out;
  }
}

/** 本档是否允许因该触发项升档。经济档越 ceiling 一律拒绝(§4.2 判据)。 */
function canEscalate(mode, trigger) {
  try {
    if (!mode || !trigger) return false;
    return mode.escalateOn.includes(String(trigger));
  } catch {
    return false;
  }
}

/** 升一档(T3→T2→T1→T0);已在 ceiling 或越界则返回原值并标 blocked。 */
function escalateTier(mode, tier) {
  try {
    const cur = _normTier(tier);
    const i = _TIER_IDX[cur];
    if (!Number.isFinite(i) || !mode) return { tier: cur, changed: false, blocked: 'bad-tier' };
    if (i - 1 < mode.ceilingIdx) {
      return { tier: cur, changed: false, blocked: 'ceiling' };
    }
    const next = Object.keys(_TIER_IDX).find((k) => _TIER_IDX[k] === i - 1);
    return { tier: next, changed: true, blocked: null };
  } catch {
    return { tier: _normTier(tier), changed: false, blocked: 'error' };
  }
}

/**
 * 选择器成本提示（截图里 `0.5×` / `2×` 那个位置）。
 *
 * ⚠ 这一条的存在理由是 [DESIGN-ARCH-185] §4.4：**倍率必须由价格真源算出来，不许写死字面量**。
 * 写死同时违反 RUNTIME-001 与「不摆拍」，而且价格表补全后画面会自己跟上。
 * 价格不可知时显示 `?` / `包月` / `—`，**绝不显示一个编造的倍率** ——
 * 本仓刚在 §3.4 上栽过一次（13/14 模型拿到同一个假价），不能在 UI 上再栽一次。
 *
 * @param {object} mode resolveMode 的结果
 * @param {Array<{model:string,tier:string}>} candidates 当前可用候选
 * @returns {{label:string, state:string, ratio:number|null}}
 */
function costHintOf(mode, candidates) {
  const none = { label: '—', state: 'unknown', ratio: null };
  try {
    if (!mode || !Array.isArray(candidates) || candidates.length === 0) return none;
    const inBand = candidates.filter((cn) => allowsTier(mode, cn && cn.tier));
    if (inBand.length === 0) return { label: '—', state: 'empty-band', ratio: null };

    const mp = require('../modelPricing');
    const states = new Map();
    for (const cn of inBand) states.set(cn.model, mp.resolvePrice(cn.model).state);
    const uniq = Array.from(new Set(states.values()));

    // 全池都是订阅包月 → token 计价不成立，直说
    if (uniq.length === 1 && uniq[0] === 'flat') {
      return { label: '包月', state: 'flat', ratio: null };
    }
    const usable = inBand.filter((cn) => mp.isCostUsable(states.get(cn.model)));
    // 只要有算不出价的候选，倍率就是猜 → 显示 ?
    if (usable.length === 0) return { label: '?', state: 'unknown', ratio: null };
    if (usable.length !== inBand.length) return { label: '?', state: 'partial', ratio: null };

    const costs = usable.map((cn) => {
      const p = mp.resolvePrice(cn.model).price;
      return p ? p.input + p.output : null;
    }).filter((x) => Number.isFinite(x));
    if (costs.length === 0) return { label: '?', state: 'unknown', ratio: null };
    const min = Math.min(...costs);
    if (min <= 0) return { label: '免费', state: 'free', ratio: 0 };
    const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
    const ratio = Number((mean / min).toFixed(2));
    return { label: `≈${ratio}×`, state: 'priced', ratio };
  } catch {
    return none;
  }
}

/**
 * §5.5 升档 + §5.6 弃权。**方向单一：只抬，不降。**
 *
 * 三条触发都借自 opensquilla 的 thresholds（E1），但有一条本仓做不到等价物，如实说明：
 * 它的 `under_routing_safety` 判的是「判成低档，但 P(高档) 之和 > 0.45」——
 * 那是**概率**。本仓的 demand 是确定性线性打分（§2.2-1：无 Python 所以没有分类器），
 * 没有概率可加。所以这里改成几何等价物：
 *   「demand 落在所选档区间的下沿附近」= 「我其实不太确定这一档够」。
 * 这是**降级实现，不是同一件事**，注释与测试都按这个口径写，不允许它被当成概率判据读。
 *
 * 弃权（§5.6）：margin 与 demand 双低时不猜档，直接落 `fallbackMode` 并点名原因。
 * AutoMix 的不对称奖励是同一个形状（答错 −1、弃权 0，E2）：
 * 「不确定」比「不确定还硬选一个」便宜。
 *
 * @returns {{tier:string, changed:boolean, reason:string|null, abstained:boolean}}
 */
function applyEscalation(mode, ctx = {}) {
  const noop = (tier, reason) => ({ tier, changed: false, reason, abstained: false });
  try {
    if (!mode) return noop('', 'no-mode');
    const start = String(ctx.tier || '').trim().toUpperCase();
    if (!_TIER_IDX.hasOwnProperty(start)) return noop(start, 'bad-tier');

    const th = (k, d) => thresholdOf(mode, k, d);
    const margin = Number.isFinite(ctx.margin) ? ctx.margin : null;
    const demand = Number.isFinite(ctx.demand) ? ctx.demand : null;

    // 弃权：两个不确定性信号同时出现时，不猜，退回中间档。
    if (margin !== null && margin < th('marginUpgrade', 0.1)
        && demand !== null && demand < 0.25 && mode.used !== 'extreme') {
      const fb = _normTier(mode.fallbackMode) || 'T2';
      // 只在上抬方向退回中间档；若中间档比当前还弱，就保持当前（绝不因弃权而降档）
      const tier = _TIER_IDX[fb] < _TIER_IDX[start] ? fb : start;
      return {
        tier,
        changed: tier !== start,
        reason: `abstain: margin=${margin} < ${th('marginUpgrade', 0.1)} 且 demand=${demand} 低`,
        abstained: true,
      };
    }

    let tier = start;
    let reason = null;

    // underRoutingSafety（几何等价物，见函数头说明）
    if (demand !== null && canEscalate(mode, 'underRoutingSafety')) {
      const band = _bandForDemand(demand, mode);
      if (band && band !== tier && _TIER_IDX[band] < _TIER_IDX[tier]) {
        const near = demand - band.lo;
        const width = Math.max(1e-9, band.hi - band.lo);
        if (near / width < th('underRoutingSafety', 0.45)) {
          tier = band.tier;
          reason = `underRoutingSafety: demand 落在 ${band.tier} 区间下沿 ${(near / width).toFixed(2)}`;
        }
      }
    }

    if (ctx.verifyFailed && canEscalate(mode, 'verifyFailed')) {
      const next = escalateTier(mode, tier);
      if (next.changed) { tier = next.tier; reason = 'verifyFailed'; }
    }
    if (ctx.irreversible && canEscalate(mode, 'irreversibleWrite')) {
      const next = escalateTier(mode, tier);
      if (next.changed) { tier = next.tier; reason = 'irreversibleWrite'; }
    }
    if (margin !== null && margin < th('marginUpgrade', 0.1) && canEscalate(mode, 'lowMargin')) {
      const next = escalateTier(mode, tier);
      if (next.changed) { tier = next.tier; reason = `lowMargin: margin=${margin}`; }
    }

    return { tier, changed: tier !== start, reason, abstained: false };
  } catch {
    return noop(String(ctx && ctx.tier ? ctx.tier : ''), 'error');
  }
}

/** demand → 它所属的档与区间边界（供 underRoutingSafety 判断「离上沿多近」）。 */
function _bandForDemand(demand, mode) {
  try {
    const card = mode && mode._card ? mode._card : null;
    const bands = card && card.demand_tier_bands ? card.demand_tier_bands : null;
    if (!bands) return null;
    for (const t of ['T0', 'T1', 'T2', 'T3']) {
      const b = bands[t];
      if (!Array.isArray(b) || b.length !== 2) continue;
      if (demand >= Number(b[0]) && demand <= Number(b[1])) {
        return { tier: t, lo: Number(b[0]), hi: Number(b[1]) };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 把 mode + 上下文折成 modelTier 能直接吃的**纯数据意图**。
 * 传纯数据而不是 mode 对象，是为了让 modelTier 不 require 本模块（会形成 require 环）。
 *
 * @param {object|null} mode resolveMode 结果
 * @param {{cls?:string, margin?:number, flags?:string[], policyFlags?:string[]}} [ctx]
 * @returns {{thinkingFloor:(string|null), promptVerbosity:(string|null), via:string}|null}
 *          null = 无模式可应用（模式轴关 / 卡坏），调用方保持 tier 默认
 */
function modeIntent(mode, ctx = {}) {
  try {
    if (!mode) return null;
    const th = deriveThinking(mode, ctx);
    const pol = derivePromptPolicy(mode, {
      flags: Array.isArray(ctx.policyFlags) ? ctx.policyFlags : ctx.flags,
      margin: ctx.margin,
      difficulty: ctx.demand,
    });
    const verbosityMap = { P0: 'lean', P1: null, P2: 'full' };
    const pv = Object.prototype.hasOwnProperty.call(verbosityMap, pol.id)
      ? verbosityMap[pol.id]
      : null;
    if (th.sets === null && th.via === 'default' && pv === null) return null;
    return { thinkingFloor: th.sets === undefined ? null : th.sets, promptVerbosity: pv, via: `${th.via}/${pol.via}` };
  } catch {
    return null;
  }
}

/**
 * 只有 tier 和 env 可依赖时的模式意图（供 prompt 组装等**拿不到请求上下文**的调用点用）。
 *
 * 适用边界（如实声明）：固定档（极致/性能/经济）的 β/π 由档名唯一决定，这里能完整生效；
 * auto 档的 β 需要 margin/flags 这类请求内信号，这里拿不到 → 返回 null，
 * 即 auto 的推理预算**仍由 tier 决定**，与今日一致。这是当前实现的真实缺口，
 * 不是「auto 不需要 β」。
 */
/**
 * §15-1 红线：**用户钉了渠道或模型时，模式轴一律旁路，连观测都不写。**
 *
 * 为什么必须有这个函数：选路那侧天然满足（钉选时 `preferredAdapter !== 'auto'`，
 * 整段模式块根本不执行），但**β/π 那侧不满足** —— `harnessProfile` 的两个调用点
 * 只读 `GATEWAY_ROUTING_MODE` + tier，不看有没有钉选。后果是：用户钉死了通道，
 * 却仍被一个他没在用的路由档改了思考预算与提示词详略，而画面上一切正常。
 *
 * 钉选定义**不在这里另造一份**：复用 `routeFact.isPinnedAdapter`
 * （`RUNTIME-010` A2-5「同一个概念不得有两份不一致定义」）。模型钉选按 §15 的字面
 * 「渠道**或**模型」补，且沿用同一条 auto 哨兵豁免（`auto` 不是钉真实模型）。
 * routeFact 不 require 本模块，无环；这里仍用惰性 require 保守。
 */
function pinnedBypass(env = process.env) {
  try {
    const e = env || process.env;
    const rf = require('./routeFact');
    const adapterPinned = rf.isPinnedAdapter(String(e.GATEWAY_PREFERRED_ADAPTER || '').trim());
    const model = String(e.GATEWAY_PREFERRED_MODEL || '')
      .trim()
      .toLowerCase();
    const modelPinned = Boolean(model) && model !== 'auto';
    return adapterPinned || modelPinned;
  } catch {
    // 判据取不到时**不旁路**：误旁路 = 用户配了档却静默失效，正是本文件反对的 fail-open 方向。
    return false;
  }
}

function staticIntentForTier(tier, env = process.env) {
  try {
    if (!isEnabled(env)) return null;
    if (pinnedBypass(env)) return null;
    if (String(env.GATEWAY_ROUTING_MODE || currentModeName(env)).trim().toLowerCase() === 'auto') {
      return null;
    }
    const mode = resolveMode(currentModeName(env), { env });
    if (!mode) return null;
    // 固定档：thinking 由档名钉死，promptPolicy 也由档名钉死，不需要请求上下文
    const setMap = { none: null, low: 'low', high: 'high', max: 'max' };
    const key = String(mode.thinking || 'auto').trim().toLowerCase();
    const pvMap = { P0: 'lean', P1: null, P2: 'full' };
    const pv = pvMap[String(mode.promptPolicy || '').trim().toUpperCase()];
    if (!Object.prototype.hasOwnProperty.call(setMap, key) && !pv) return null;
    return {
      thinkingFloor: Object.prototype.hasOwnProperty.call(setMap, key) ? setMap[key] : null,
      promptVerbosity: pv || null,
      via: 'static-mode',
      mode: mode.used,
    };
  } catch {
    return null;
  }
}

/** 给选择器供数:四档的展示顺序与标签。顺序由档位卡的声明序决定（稳定）。
 * 注意：展示序（Auto→极致→性能→经济）由调用方 ORDER 指定，本函数只回卡里有什么。
 */
function listModes(opts = {}) {
  try {
    const card = opts.card || _loadCard(opts.env);
    const modes = card && card.modes ? card.modes : {};
    return Object.keys(modes).map((key) => ({
      key,
      label: String(modes[key] && modes[key].label ? modes[key].label : key),
      intent: String((modes[key] && modes[key].intent) || ''),
      isDefault: String(card.defaultMode || '') === key,
    }));
  } catch {
    return [];
  }
}

// ── 档位卡加载(一次;env 内联 > appHome 覆盖 > 仓内文件)──────────────────
let _cached = null;

// 磁盘读取走非叶子伴生层 routingModeCard(见其文件头:routingMode 保持零 IO)。
const _readJson = routingModeCard.readJson;

function _loadCard(env = process.env) {
  try {
    const e = env || process.env;
    const inline = e.KHY_ROUTING_MODES_JSON;
    if (typeof inline === 'string' && inline.trim()) {
      const parsed = JSON.parse(inline);
      if (parsed && typeof parsed === 'object') return parsed;
    }
    if (_cached) return _cached;
    let overrideFile = '';
    if (e.KHY_ROUTING_MODES_FILE && String(e.KHY_ROUTING_MODES_FILE).trim()) {
      overrideFile = path.resolve(String(e.KHY_ROUTING_MODES_FILE).trim());
    } else {
      try {
        overrideFile = path.join(
          require('../../utils/dataHome').getAppHome(),
          'routing_modes.json'
        );
      } catch {
        overrideFile = path.join(require('os').homedir(), '.khyquant', 'routing_modes.json');
      }
    }
    const overrides = _readJson(overrideFile);
    // 本文件在 src/services/gateway/,到 backend 根要上三层。
    // (踩过一次:从 modelPricing.js 复制时少写一层,路径落空被下面的 catch 吞成
    //  「卡不存在」,表现是模式轴静默不生效而不是报错。)
    const base = _readJson(path.resolve(__dirname, '..', '..', '..', CARD_REL));
    if (!base || typeof base !== 'object') {
      _cached = null;
      return null;
    }
    if (overrides && typeof overrides === 'object') {
      base.modes = { ...(base.modes || {}), ...(overrides.modes || {}) };
    }
    _cached = base;
    return _cached;
  } catch {
    return null;
  }
}

/**
 * §5.6 软失败的落点档名。卡坏 / 没登记 fallbackMode → null（调用方按「模式轴缺席」处理）。
 *
 * 为什么单独暴露这个：软失败时**必须落中间档而不是最便宜档**。
 * 这条方向是反直觉的（多数实现 fail-open 到 cheapest），但它有三个独立佐证
 * （论文原句、opensquilla 配置里只有 under_routing_safety 没有反向兜底、
 * RouteLLM 的 causal_llm 解析失败时返回 1.0 走强模型）。见 §5.6。
 */
function fallbackModeName(env = process.env) {
  try {
    const card = _loadCard(env);
    const fb = card && typeof card.fallbackMode === 'string'
      ? card.fallbackMode.trim().toLowerCase() : '';
    if (!fb || !card || !card.modes || !card.modes[fb]) return null;
    return fb;
  } catch {
    return null;
  }
}

/**
 * 请求上下文可用的 β/π 意图（P2d，补 §16.3 里 auto 的那一格）。
 *
 * 与 staticIntentForTier 的差别：固定档不需要上下文（档名唯一决定 β/π），
 * 而 **auto 的 β 依赖「这一轮在问什么」** —— 具体就是 routeDemand 的 flag 命中集。
 * 组装点（khyUpgradeRuntime.makeSystemPrompt）本来就收着 `userMessage`，
 * 所以这里能算，不需要把网关内部的任何东西搬出来。
 *
 * margin 拿不到（它是网关内 rank 的产物，而 prompt 组装发生在调用网关之前）。
 * **这不是中性的信息缺失，方向是安全的**：deriveThinking 里 margin 非有限时按 0 处理，
 * 于是 `none`(≥0.5) 与 `low`(≥0.4) 两级永不触发，只有 max/high 这类「多要思考」的规则会生效。
 * 也就是说：**没有证据时只会多想，不会少想** —— 与 §5.6「省需要证据，花不需要」同向。
 * 这条不对称是设计，不是遗漏，所以有测试锁住。
 *
 * @returns {{thinkingFloor:(string|null), promptVerbosity:(string|null), via:string, mode:string}|null}
 */
function requestModeIntent(ctx = {}) {
  try {
    const env = ctx.env || process.env;
    if (!isEnabled(env)) return null;
    // §15-1：钉选状态下模式轴整体旁路（含 auto 档的按请求 β）。
    if (pinnedBypass(env)) return null;
    const mode = resolveMode(currentModeName(env), { env });
    if (!mode) return null;

    if (mode.used !== 'auto') {
      // 固定档：沿用档名唯一决定的意图（不需要上下文）
      const st = staticIntentForTier(ctx.tier, env);
      return st;
    }

    const rd = require('./routeDemand');
    const text = typeof ctx.prompt === 'string' ? ctx.prompt : '';
    const feats = Object.assign(rd.extractFeatures(text, {}), { text });
    const flags = rd.matchFlags(feats, mode._card);
    const th = deriveThinking(mode, {
      cls: ctx.tier,
      margin: Number.isFinite(ctx.margin) ? ctx.margin : NaN,
      flags,
    });
    const pol = derivePromptPolicy(mode, {
      flags,
      margin: Number.isFinite(ctx.margin) ? ctx.margin : NaN,
      difficulty: feats.chars / 1000,
    });
    const setMap = { none: null, low: 'low', high: 'high', max: 'max' };
    const pvMap = { P0: 'lean', P1: null, P2: 'full' };
    const pv = Object.prototype.hasOwnProperty.call(pvMap, pol.id) ? pvMap[pol.id] : null;
    if (th.via === 'default' && !pv) return null;
    return {
      thinkingFloor: Object.prototype.hasOwnProperty.call(setMap, th.level) ? setMap[th.level] : null,
      promptVerbosity: pv,
      via: `${th.via}/${pol.via}`,
      mode: mode.used,
      flags,
    };
  } catch {
    return null;
  }
}

/** 当前生效档名:env GATEWAY_ROUTING_MODE > 卡内 defaultMode。 */
function currentModeName(env = process.env) {
  try {
    const raw = String((env || process.env).GATEWAY_ROUTING_MODE || '').trim().toLowerCase();
    if (raw) return raw;
    const card = _loadCard(env);
    return String((card && card.defaultMode) || 'auto');
  } catch {
    return 'auto';
  }
}

function _resetCardCache() {
  _cached = null;
}

/** 仓内档位卡的绝对路径。暴露它是为了让测试能直接断言文件存在 ——
 *  路径写错时 _loadCard 只会返回 null,表现是「模式轴静默不生效」而不是报错。 */
function cardFile() {
  return path.resolve(__dirname, '..', '..', '..', CARD_REL);
}

module.exports = {
  KHY_ROUTE_APPLY_STAGE,
  applyBlockedBy,
  applyEscalation,
  canEscalate,
  cardFile,
  costHintOf,
  currentModeName,
  derivePromptPolicy,
  deriveThinking,
  escalateTier,
  fallbackModeName,
  getStage,
  isApplyEnabled,
  isEnabled,
  lambdaFor,
  listModes,
  modeIntent,
  resolveMode,
  allowsTier,
  requestModeIntent,
  staticIntentForTier,
  pinnedBypass,
  tierIdx,
  thresholdOf,
  _loadCard,
  _resetCardCache,
};
