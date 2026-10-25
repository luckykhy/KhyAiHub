/**
 * Token Usage Tracking Service
 *
 * Tracks AI token consumption per session, per day, and per month.
 * Persists daily aggregates to ~/.khyquant/token_usage.json.
 * Provides remaining quota based on subscription tier.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// 定价数学的单一真源是纯叶子 ./tokenPricing（「Batch 3 接口恒等」重构的提取物）。
// 本壳历史上**从未 require 它**，而是各自持有一份 12 键的 TOKEN_PRICING 副本——
// 重构提取了叶子却没接线，两份表随即漂移：叶子有 DeepSeek / Together AI，副本没有，
// 于是这两家的用量一直静默落到 default 粗价上（[MGMT-RPT-035] L1 的实证缺口）。
// 现改为薄委托：表与两个纯函数全部走叶子，本壳只留状态与渲染。
const tokenPricing = require('./tokenPricing');
// 纯叶子，按模型归组用（零 IO、不抛）。取不到就退化成「本进程无按模型数据」，
// 绝不因为一个展示层聚合器缺失而让整页用量读不出来。
let _costByModel = null;
try {
  // eslint-disable-next-line global-require
  _costByModel = require('./costByModel');
} catch { _costByModel = null; }

const USAGE_FILE = path.join(os.homedir(), '.khyquant', 'token_usage.json');

// 汇率与价目表改从叶子取（原来是本文件内的重复字面量）。
const USD_TO_CNY = tokenPricing.USD_TO_CNY;

// Per-token pricing by provider (USD per 1M tokens) — 真源在 ./tokenPricing，
// 这里只做再导出以保持既有导入面不变（`require('tokenUsageService').TOKEN_PRICING`）。
const TOKEN_PRICING = tokenPricing.TOKEN_PRICING;

// In-memory session accumulator (resets each REPL start)
let _sessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  requests: 0,
  costUSD: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  records: [], // per-request detail
};

// 刀110:会话级「代码改动」账本(对齐 CC /cost "Total code changes")。跨轮累计,进程内
// 会话作用域(随 resetUsage 归零,不落盘 —— 与 CC 的 per-session cost 同口径)。由
// toolUseLoop 交付汇总点经 codeChangeStats.collectUncountedChurn 幂等喂入。
let _codeChanges = { added: 0, removed: 0 };

/**
 * Load persisted usage data from disk.
 */
function loadUsageData() {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
    }
  } catch { /* ignore corrupt file */ }
  return { daily: {}, monthlyTotals: {} };
}

/**
 * Save usage data to disk.
 */
function saveUsageData(data) {
  try {
    const dir = path.dirname(USAGE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch { /* ignore write failure */ }
}

// ── In-memory mirror of persisted daily/monthly aggregates ──────────────────
// recordUsage updates this synchronously (O(1), no disk); the four read
// functions read it directly so they never see stale data. Disk is only a
// persistence shadow, flushed async (or sync in NODE_ENV=test). Pattern
// borrowed from telemetryService.js: dirty flag + flushing guard + atomic
// tmp→rename + NODE_ENV branch.
let _persistedMirror = { daily: {}, monthlyTotals: {} };
let _dirty = false;
let _flushing = false;
let _flushTimer = null;
const FLUSH_INTERVAL_MS = (() => {
  const n = parseInt(process.env.KHY_TOKEN_USAGE_FLUSH_MS || '', 10);
  return Number.isInteger(n) && n > 0 ? n : 30000;
})();

// Warm up the mirror once at module load so reads are fresh from the start.
try {
  _persistedMirror = loadUsageData();
} catch {
  _persistedMirror = { daily: {}, monthlyTotals: {} };
}

// 盘上文件的 mtime 镜像。长驻进程（host / REPL）加载本模块只发生一次，
// 之后 _persistedMirror 就停在「加载那一刻」的快照——UI 上的「刷新」按钮
// 物理上是 no-op。读函数入口比对 mtime，变了才重载。
let _fileMtimeMs = null;

/**
 * 盘上文件变了就重载镜像。两个守卫都要：
 * `_flushAsync` 先 `_dirty = false`、再 `_flushing = true`，到
 * `finally _flushing = false` 之间隔着两次 await，盘上文件还是旧的。
 * 这段窗口里 `_dirty === false` 但数据未落盘，只看 `_dirty` 会拿旧文件
 * 覆盖镜像，把刚记的账整批抹掉。
 *
 * statSync 抛错（文件不存在 / 无权限）时**保留旧镜像**，不清空——
 * 读不出来和读出来是空是两回事。
 */
function _reloadIfChanged() {
  if (_dirty || _flushing) return;
  let mtime;
  try {
    mtime = fs.statSync(USAGE_FILE).mtimeMs;
  } catch {
    return;
  }
  if (_fileMtimeMs === null) {
    _fileMtimeMs = mtime;
    return;
  }
  if (mtime === _fileMtimeMs) return;
  _fileMtimeMs = mtime;
  let loaded;
  try {
    loaded = loadUsageData();
  } catch {
    return; /* 坏文件：保留旧镜像，不清空 */
  }
  // 老文件 / 半写文件可能只有其中一个键（或都不是）。读函数一律直接索引
  // _persistedMirror.daily[key]，缺键就会在读路径上抛——补齐形状，不补数据。
  _persistedMirror = {
    daily: (loaded && loaded.daily) || {},
    monthlyTotals: (loaded && loaded.monthlyTotals) || {},
  };
}

// 初次播种：模块加载那一刻盘上文件是什么时刻（读函数里第一次比对时不再重复重载）。
try {
  _fileMtimeMs = fs.statSync(USAGE_FILE).mtimeMs;
} catch {
  _fileMtimeMs = null;
}

/**
 * Schedule a flush: sync under NODE_ENV=test (so tests read the disk
 * immediately after recordUsage), async fire-and-forget otherwise.
 */
function _scheduleFlush() {
  if (process.env.NODE_ENV === 'test') {
    _flushSync();
    return;
  }
  _flushAsync().catch(() => {});
}

/**
 * Async flush: dirty+flushing guard, atomic tmp→rename, re-flush if a
 * recordUsage landed during the await. Best-effort (errors swallowed).
 */
async function _flushAsync() {
  if (!_dirty || _flushing) return;
  _dirty = false;
  _flushing = true;
  try {
    const dir = path.dirname(USAGE_FILE);
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch { /* dir fail */ }
    const tmp = USAGE_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(_persistedMirror, null, 2), 'utf-8');
    await fs.promises.rename(tmp, USAGE_FILE);
  } catch { /* best-effort persistence */ }
  finally {
    _flushing = false;
  }
  if (_dirty) {
    _flushAsync().catch(() => {});
  }
}

/**
 * Sync flush (test path + process exit hook). Atomic tmp→rename.
 */
function _flushSync() {
  if (!_dirty) return;
  _dirty = false;
  try {
    const dir = path.dirname(USAGE_FILE);
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch { /* dir fail */ }
    const tmp = USAGE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_persistedMirror, null, 2), 'utf-8');
    fs.renameSync(tmp, USAGE_FILE);
  } catch { /* best-effort persistence */ }
}

/**
 * Shutdown: clear the interval and do a final sync flush so no in-memory
 * aggregate is lost on graceful exit.
 */
function shutdown() {
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
  _flushSync();
}

/** Test hook: force a sync flush. */
function __flushForTest() {
  _flushSync();
}

/**
 * Get today's date key (YYYY-MM-DD).
 */
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Get current month key (YYYY-MM).
 */
function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Record a single AI request's token usage.
 *
 * Cache read/write tokens get their own columns (additive, single-ledger split):
 * the adapters already return cacheReadInputTokens/cacheWriteInputTokens, and a
 * cache-WRITE is billed at a 1.25x premium — lumping or dropping it would make
 * the daily/monthly spend dishonest. The columns are diagnostics: they never
 * inflate inputTokens/totalTokens (a write turn must not masquerade as a miss).
 *
 * @param {string} provider - e.g. 'OpenAI', 'Anthropic', 'Groq'
 * @param {string} model - e.g. 'gpt-4o-mini', 'claude-3-5-sonnet'
 * @param {number} inputTokens - prompt/input token count
 * @param {number} outputTokens - completion/output token count
 * @param {number} [costUSD=0] - estimated cost in USD (if available)
 * @param {number} [cacheReadTokens=0] - prompt-cache read (hit) tokens
 * @param {number} [cacheWriteTokens=0] - prompt-cache write (creation) tokens
 */
function recordUsage(
  provider,
  model,
  inputTokens = 0,
  outputTokens = 0,
  costUSD = 0,
  cacheReadTokens = 0,
  cacheWriteTokens = 0
) {
  const total = inputTokens + outputTokens;

  // Update session
  _sessionUsage.inputTokens += inputTokens;
  _sessionUsage.outputTokens += outputTokens;
  _sessionUsage.totalTokens += total;
  _sessionUsage.requests += 1;
  _sessionUsage.costUSD += costUSD;
  _sessionUsage.cacheReadTokens += cacheReadTokens;
  _sessionUsage.cacheWriteTokens += cacheWriteTokens;
  _sessionUsage.records.push({
    provider,
    model,
    inputTokens,
    outputTokens,
    total,
    costUSD,
    cacheReadTokens,
    cacheWriteTokens,
    timestamp: Date.now(),
  });

  // Update in-memory mirror (O(1), no disk) — reads see fresh data instantly.
  const day = todayKey();
  const month = monthKey();

  if (!_persistedMirror.daily[day]) {
    _persistedMirror.daily[day] = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requests: 0,
      costUSD: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }
  _persistedMirror.daily[day].inputTokens += inputTokens;
  _persistedMirror.daily[day].outputTokens += outputTokens;
  _persistedMirror.daily[day].totalTokens += total;
  _persistedMirror.daily[day].requests += 1;
  _persistedMirror.daily[day].costUSD += costUSD;
  // Pre-existing persisted entries predate the split — || 0 keeps a missing
  // column from turning the accumulator into NaN.
  _persistedMirror.daily[day].cacheReadTokens =
    (_persistedMirror.daily[day].cacheReadTokens || 0) + cacheReadTokens;
  _persistedMirror.daily[day].cacheWriteTokens =
    (_persistedMirror.daily[day].cacheWriteTokens || 0) + cacheWriteTokens;

  if (!_persistedMirror.monthlyTotals[month]) {
    _persistedMirror.monthlyTotals[month] = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requests: 0,
      costUSD: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }
  _persistedMirror.monthlyTotals[month].inputTokens += inputTokens;
  _persistedMirror.monthlyTotals[month].outputTokens += outputTokens;
  _persistedMirror.monthlyTotals[month].totalTokens += total;
  _persistedMirror.monthlyTotals[month].requests += 1;
  _persistedMirror.monthlyTotals[month].costUSD += costUSD;
  _persistedMirror.monthlyTotals[month].cacheReadTokens =
    (_persistedMirror.monthlyTotals[month].cacheReadTokens || 0) + cacheReadTokens;
  _persistedMirror.monthlyTotals[month].cacheWriteTokens =
    (_persistedMirror.monthlyTotals[month].cacheWriteTokens || 0) + cacheWriteTokens;

  // Prune old months (keep 6 months)
  const months = Object.keys(_persistedMirror.monthlyTotals).sort();
  while (months.length > 6) {
    delete _persistedMirror.monthlyTotals[months.shift()];
  }

  // Prune old days (keep 90 days)
  const days = Object.keys(_persistedMirror.daily).sort();
  while (days.length > 90) {
    delete _persistedMirror.daily[days.shift()];
  }

  _dirty = true;
  _scheduleFlush();
}

/**
 * Get current session usage.
 */
function getSessionUsage() {
  return { ..._sessionUsage };
}

/**
 * 刀110:累加本会话代码改动行数(fail-soft;非有限/非正值忽略)。
 * @param {number} added   本次新增行
 * @param {number} removed 本次删除行
 */
function recordCodeChange(added, removed) {
  try {
    const a = Number(added);
    const r = Number(removed);
    if (Number.isFinite(a) && a > 0) _codeChanges.added += Math.floor(a);
    if (Number.isFinite(r) && r > 0) _codeChanges.removed += Math.floor(r);
  } catch { /* fail-soft:账本绝不影响主流程 */ }
}

/** 刀110:读取本会话代码改动累计(副本,防外部改写)。 */
function getCodeChanges() {
  return { ..._codeChanges };
}

/**
 * Get today's usage from persistent storage.
 */
function getTodayUsage() {
  _reloadIfChanged();
  return _persistedMirror.daily[todayKey()] || { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, costUSD: 0 };
}

/**
 * Get this month's usage.
 */
function getMonthUsage() {
  _reloadIfChanged();
  return _persistedMirror.monthlyTotals[monthKey()] || { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, costUSD: 0 };
}

/**
 * Get remaining quota based on subscription tier.
 * @returns {{ allowed: boolean, remaining: number, limit: number, used: number }}
 */
function getRemainingQuota() {
  let tierLimits;
  try {
    const { getCurrentTier, TIERS } = require('./subscriptionService');
    const tier = getCurrentTier();
    tierLimits = TIERS[tier]?.limits?.cloud_ai_tokens;
  } catch {
    tierLimits = undefined;
  }

  // Default to free tier limit if subscription service unavailable
  const limit = tierLimits ?? 100000;
  const used = getMonthUsage().totalTokens;

  if (limit === -1) {
    return { allowed: true, remaining: Infinity, limit: -1, used };
  }

  return {
    allowed: used < limit,
    remaining: Math.max(0, limit - used),
    limit,
    used,
  };
}

/**
 * Get usage history for the past N days.
 *
 * 投影 8 键（含缓存两列）供图表按构成画堆叠柱。
 * **totalTokens 一律沿用日桶原值**（= inputTokens + outputTokens，由 recordUsage
 * :197 的 `const total = inputTokens + outputTokens` 决定），**不是**四桶之和
 * ——缓存两列是独立累加器，加进去就成了第三个总量口径。
 * 只改读函数返回形状，落盘结构与写入路径不动，历史数据零迁移。
 *
 * @param {number} days
 * @returns {Array<{ date: string, inputTokens: number, outputTokens: number,
 *                   totalTokens: number, requests: number, costUSD: number,
 *                   cacheReadTokens: number, cacheWriteTokens: number }>}
 */
function getUsageHistory(days = 30) {
  _reloadIfChanged();
  const result = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const dayData = _persistedMirror.daily[key];
    result.push({
      date: key,
      inputTokens: dayData?.inputTokens || 0,
      outputTokens: dayData?.outputTokens || 0,
      totalTokens: dayData?.totalTokens || 0,
      requests: dayData?.requests || 0,
      costUSD: dayData?.costUSD || 0,
      // 老条目早于缓存拆分，缺列 → 0（与 recordUsage :241 的 || 0 同一纪律）
      cacheReadTokens: dayData?.cacheReadTokens || 0,
      cacheWriteTokens: dayData?.cacheWriteTokens || 0,
    });
  }

  return result;
}

/**
 * 用量文件在盘上的最后修改时刻（ISO 字符串）。
 *
 * 诚实边界：这是**持久化镜像**的截止时刻，不是「本进程记到的最后一笔」。
 * recordUsage 记进内存后 flush 还没落盘时，stamp 会落后于内存里的数——
 * 这正是 mtime 重载存在的理由（读到旧值宁可显示旧账，不丢新账）。
 * 文件不存在返回 null（**不抛**：statSync 对缺失文件抛 ENOENT，让它把错误
 * 抛给调用方等于把本函数要修的那类 bug 原样装回来）。调用方拿 null 时
 * 应当整行不渲染「数据截至」，而不是打印 "undefined"。
 *
 * @returns {string|null}
 */
function getUsageFileStamp() {
  try {
    const mtimeMs = fs.statSync(USAGE_FILE).mtimeMs;
    return Number.isFinite(mtimeMs) ? new Date(mtimeMs).toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * 按模型归组的**本进程**用量（进程内 records 的聚合，不落盘）。
 *
 * 诚实边界三条，逐条都写在这里而不是让消费方自己猜：
 * ① 内存态 —— records 随 REPL / host 进程退出即失，**退出即失**；
 * ② 无 sessionId —— 按对话下钻无从谈起，本函数只到模型粒度；
 * ③ 90 天历史里**没有**模型维度 —— 落盘的日桶结构里根本没有 model 字段，
 *    模型归属在写入那一刻就没有，别把它当历史数据缺失。
 *
 * costUSD 主路径恒为 0（adapters 不产 cost），所以排序实际落到 total 降序，
 * 恰好就是「哪台模型吃得多」要的口径。
 *
 * 空 records 返回 `[]` 而不是 null（调用方按数组真值判定，null 会整页落空态）。
 *
 * @returns {Array<{ model:string, inputTokens:number, outputTokens:number,
 *                   totalTokens:number, requests:number, costUSD:number,
 *                   percentage:number, scope:'process' }>}
 */
function getModelUsage() {
  if (!_costByModel) return [];
  const rows = _costByModel.aggregateSessionUsageByModel(_sessionUsage.records);
  const grandTotal = rows.reduce((sum, r) => sum + (Number(r.total) || 0), 0);
  return rows.map((r) => {
    const totalTokens = Number(r.total) || 0;
    return {
      model: r.label,
      inputTokens: Number(r.input) || 0,
      outputTokens: Number(r.output) || 0,
      totalTokens,
      requests: Number(r.requests) || 0,
      costUSD: Number(r.cost) || 0,
      percentage: grandTotal > 0 ? Math.round((totalTokens / grandTotal) * 1000) / 10 : 0,
      scope: 'process',
    };
  });
}

/**
 * 计价覆盖率体检——「这些用量到底有没有算出钱」。
 *
 * 返回体两个字段名**各自自带时间轴口径**，渲染层不得把它们当同一维度相加：
 * - `byDay`：**日级**，跨近 N 天，只回答「那几天跑过 ccSwitch 扫描」。
 *   分母 = 有请求的天数，分子 = 其中 costUSD > 0 的天数。日桶结构下拿不到
 *   「部分计价的日子」，所以**不返回** pricedRequests / totalRequests——
 *   把部分计价的日子说成全计价比不报更糟。
 * - `flatThisProcess`：**进程级**，只覆盖本次 REPL/host 进程内的 records，
 *   是 auditFlatChannels 的原样透出（含 degraded 标志，不另造口径）。
 *   `degraded:true` 表示审计没跑成（价目表不可用），调用方必须显示第三种
 *   说法「flat 通道审计未跑成」，**不得**显示成「本进程无订阅制通道」。
 *
 * @param {number} days
 * @returns {{ byDay: {daysWithRequests:number, pricedDays:number,
 *                     unpricedDays:number, unpricedDayDates:string[]},
 *             flatThisProcess: {requests:number, providers:string[],
 *                     tokens:number, recalculatedUSD:number, degraded:boolean} }}
 */
function getCostCoverage(days = 30) {
  _reloadIfChanged();
  const now = new Date();
  const unpricedDayDates = [];
  let daysWithRequests = 0;
  let pricedDays = 0;

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const dayData = _persistedMirror.daily[key];
    if (!dayData || !(Number(dayData.requests) > 0)) continue;
    daysWithRequests += 1;
    if (Number(dayData.costUSD) > 0) pricedDays += 1;
    else unpricedDayDates.push(key);
  }

  return {
    byDay: {
      daysWithRequests,
      pricedDays,
      unpricedDays: daysWithRequests - pricedDays,
      unpricedDayDates,
    },
    flatThisProcess: auditFlatChannels(),
  };
}

/**
 * Format a token count for the /cost·/usage report — single source of truth.
 *
 * CC 后端口径对齐:CC 的 `/cost` 报表(`cost-tracker.ts::formatModelUsage`)与
 * `Stats.tsx` "Total tokens" 一律用 `formatNumber`(紧凑记数:`1234567 → "1.2m"`、
 * `12345 → "12.3k"`、`<1000` 原样),与 khy 其余**所有** token 显示面(HUD/Spinner/
 * Footer/Compaction/turnStats 等,均走 `ccFormatTokens`)同口径。此前 `/cost`·`/usage`
 * 报表子系统是唯一漏网:三处局部 `fmtNum = n.toLocaleString('en-US')` 产**全分隔符**
 * (`"1,234,567"`)——既偏离 CC 报表逻辑,又与 khy 自身其余 token 面不一致。
 *
 * 收敛到 `ccFormatTokens` SSOT。门控 KHY_CC_FORMAT 默认开;关 / require 失败 / 非有限
 * (`ccFormatTokens` 返回 '')→ 逐字节回退 call-site 自带 `legacy`(各自历史 toLocaleString
 * 口径,保证门控关时输出逐字节一致)。
 *
 * **诚实边界(精度权衡)**:报表/额度行紧凑化后,`剩余 1.2m / 2m (62%)` 不再逐位可读;
 * 精度由并列的百分比承载,且这正是 CC `/cost` 的既定选择。需要全精度的用户可
 * `KHY_CC_FORMAT=off` 逐字节取回旧 `1,234,567` 报表(门控即逃生舱,绝不丢失旧行为)。
 *
 * @param {number} n
 * @param {string} legacy - 预算好的旧口径回退串(各 call-site 自带,保门控关字节一致)
 * @param {object} [env]
 * @returns {string}
 */
function _fmtTokenCount(n, legacy, env = process.env) {
  try {
    const { ccFormatEnabled, ccFormatTokens } = require('../utils/format/ccFormat');
    if (ccFormatEnabled(env)) {
      const out = ccFormatTokens(Number(n));
      if (out) return out;
    }
  } catch { /* fall through to legacy */ }
  return legacy != null ? legacy : Number(n).toLocaleString('en-US');
}

/**
 * Format a concise inline summary for REPL display (single line).
 * @param {number} currentTokens - tokens used in latest request
 * @returns {string}
 */
function formatInlineSummary(currentTokens) {
  const session = _sessionUsage.totalTokens;
  const quota = getRemainingQuota();
  const fmtNum = (n) => _fmtTokenCount(n, n.toLocaleString('en-US'));

  let line = `  本次: ${fmtNum(currentTokens)} tokens`;
  line += ` \u00B7 会话累计: ${fmtNum(session)}`;

  if (quota.limit !== -1) {
    line += ` \u00B7 剩余: ${fmtNum(quota.remaining)}/${fmtNum(quota.limit)}`;
  } else {
    line += ` \u00B7 额度: 无限制`;
  }

  return line;
}

/**
 * Format full usage report for the `usage` command.
 * @returns {string}
 */
function formatUsageReport() {
  const chalk = require('chalk').default || require('chalk');
  const session = getSessionUsage();
  const today = getTodayUsage();
  const month = getMonthUsage();
  const quota = getRemainingQuota();

  const fmtNum = (n) => _fmtTokenCount(n, n.toLocaleString('en-US'));
  const d = chalk.dim;
  const w = chalk.white;
  const g = chalk.green;
  const y = chalk.yellow;
  const r = chalk.red;

  let out = '';
  out += chalk.bold('  AI Token 用量统计\n\n');

  // Session
  out += w('  本次会话:\n');
  out += d('    请求次数: ') + w(session.requests) + '\n';
  out += d('    输入 tokens: ') + w(fmtNum(session.inputTokens)) + '\n';
  out += d('    输出 tokens: ') + w(fmtNum(session.outputTokens)) + '\n';
  out += d('    合计: ') + chalk.bold(fmtNum(session.totalTokens)) + '\n';
  if (session.costUSD > 0) {
    out += d('    预估费用: ') + y(`$${session.costUSD.toFixed(4)}`) + '\n';
  }
  out += '\n';

  // Today
  out += w('  今日用量:\n');
  out += d('    请求次数: ') + w(today.requests) + '\n';
  out += d('    合计 tokens: ') + w(fmtNum(today.totalTokens)) + '\n';
  out += '\n';

  // Month
  out += w('  本月用量:\n');
  out += d('    请求次数: ') + w(month.requests) + '\n';
  out += d('    合计 tokens: ') + w(fmtNum(month.totalTokens)) + '\n';
  if (month.costUSD > 0) {
    out += d('    预估费用: ') + y(`$${month.costUSD.toFixed(4)}`) + '\n';
  }
  out += '\n';

  // Quota
  out += w('  额度:\n');
  if (quota.limit === -1) {
    out += d('    月限额: ') + g('无限制 (企业版)') + '\n';
  } else {
    const pct = Math.round((quota.used / quota.limit) * 100);
    const color = pct > 90 ? r : pct > 70 ? y : g;
    out += d('    月限额: ') + w(fmtNum(quota.limit)) + '\n';
    out += d('    已使用: ') + color(`${fmtNum(quota.used)} (${pct}%)`) + '\n';
    out += d('    剩余: ') + color(fmtNum(quota.remaining)) + '\n';
  }

  return out;
}

/**
 * Estimate token count from text (fallback when API doesn't return usage).
 * Rough heuristic: ~4 chars per token for English, ~2 chars per token for Chinese.
 */
function estimateTokens(text) {
  if (!text) return 0;
  // Count Chinese characters
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const nonCjkLen = text.length - cjkCount;
  return Math.ceil(cjkCount / 1.5 + nonCjkLen / 4);
}

/**
 * Calculate cost for a request based on provider pricing.
 * @param {string} provider
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {{ costUSD: number, costCNY: number }}
 */
/**
 * 单次调用计价。**薄委托 ./tokenPricing.calculateCost**（接口恒等：叶子多出的
 * pricingTable/usdToCny 两个参数走默认值，与本壳原三参版逐字节同结果）。
 * 委托的净收益：表从 12 键变 14 键，DeepSeek / Together AI 不再落 default 粗价。
 */
function calculateCost(provider, inputTokens, outputTokens) {
  return tokenPricing.calculateCost(provider, inputTokens, outputTokens);
}

/**
 * Convenience: estimate cost from model/provider name + token counts.
 * Tries model name first, then provider name, then default.
 *
 * ⚠ **刻意不委托 ./tokenPricing.estimateCost**：那份叶子按 [DESIGN-ARCH-185] §3.4
 * （判据 A8）改过语义——改为查 modelPricing 显式表，价格不可知时返回 0 而**不是**
 * 编造的 default。本函数的历史语义是「provider 关键字子串匹配 + 静默落 default」，
 * 两者对同一输入会给出不同数字。委托它是一次**行为变更**，须单独评估消费方后再做，
 * 不该搭本次「接口恒等」的车混进去。需要区分价格状态的消费方应改用
 * modelPricing.estimateCostDetailed（flat/unknown 返回 null，不造假数字）。
 *
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} modelOrProvider - model name or provider key
 * @returns {number} costUSD
 */
function estimateCost(inputTokens, outputTokens, modelOrProvider) {
  const key = String(modelOrProvider || '').toLowerCase();
  // Try to match a pricing key by substring
  let pricing = TOKEN_PRICING['default'];
  for (const [name, p] of Object.entries(TOKEN_PRICING)) {
    if (name !== 'default' && key.includes(name.toLowerCase())) {
      pricing = p;
      break;
    }
  }
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1000000;
}

/**
 * Get total cost for session in both currencies.
 * 求和内核**薄委托 ./tokenPricing.sumRecordsCost**（该叶子正是当年从本函数提取的，
 * 注释里写着「getSessionCost 的求和内核」——但提取后本壳从未接线，一直跑自己的副本）。
 * 行为恒等：`resolveProviderPricing` 只比本壳原写法多一层 `|| _ZERO_PRICING`，
 * 而内置表恒有 default，该分支不可达；`/1000000` 与 `/1e6` 数值相同。
 */
function getSessionCost() {
  return tokenPricing.sumRecordsCost(_sessionUsage.records);
}

/**
 * 成本对账（只读，零写入）—— 借鉴 ccusage 的 display/calculate 双档设计
 * （`rust/crates/ccusage-core/src/cost.rs` 的 `CostMode::{Display,Calculate}`）。
 *
 * 为什么需要它：本服务有**两条互不对账的成本路径**——
 *   - `_sessionUsage.costUSD`：累加调用方传入的上游值（`formatUsageReport()` 打的就是它）
 *   - `getSessionCost()`：用 `TOKEN_PRICING` 按 input/output 两桶**重算**
 * 两条路径的数字从未被比较过，差异（价目过期 / provider 归类错 / 上游口径不同）不可见。
 *
 * 同时把 L1 的已知缺口变成**可见计数**而非静默错算：`recordUsage` 早已收集
 * `cacheReadTokens`/`cacheWriteTokens`，但 `TOKEN_PRICING` 没有任何缓存价档，
 * 于是 `getSessionCost()` 的两桶公式**系统性地把缓存 token 算成零**——缓存命中
 * 越多，重估值偏得越狠。`cacheUncosted` 把这个偏差量化出来。
 *
 * 契约（对齐 ccusage 的只读性，已从其代码证实：读只有 `fs::read`，无任何写）：
 *   - **纯函数**：不读文件、不写文件、不改 `_sessionUsage`、不改入参数组；
 *   - 入参缺省时回退到当前会话 records（仍是只读）；
 *   - 任何异常输入（null/非数组/缺字段）按 0 计，不抛错。
 *
 * @param {Array<{provider?:string,model?:string,inputTokens?:number,outputTokens?:number,
 *                costUSD?:number,cacheReadTokens?:number,cacheWriteTokens?:number}>} [records]
 * @returns {{records:number, upstreamUSD:number, recalculatedUSD:number, driftUSD:number,
 *            driftPct:number|null, driftKind:string, upstreamReported:number,
 *            cacheUncostedRequests:number, cacheUncostedTokens:number,
 *            unpricedProviders:string[]}}
 */
function reconcileCost(records) {
  const list = Array.isArray(records) ? records : _sessionUsage.records;
  let upstreamUSD = 0;
  let recalculatedUSD = 0;
  let cacheUncostedRequests = 0;
  let cacheUncostedTokens = 0;
  const unpriced = new Set();

  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue;
    const inTok = Number(rec.inputTokens) || 0;
    const outTok = Number(rec.outputTokens) || 0;
    const cacheRead = Number(rec.cacheReadTokens) || 0;
    const cacheWrite = Number(rec.cacheWriteTokens) || 0;
    const upstream = Number(rec.costUSD) || 0;

    const provider = typeof rec.provider === 'string' ? rec.provider : '';
    const pricing = TOKEN_PRICING[provider] || TOKEN_PRICING['default'];
    if (provider && !TOKEN_PRICING[provider]) unpriced.add(provider);

    upstreamUSD += upstream;
    // 与 getSessionCost() 逐字同公式：只用 input/output 两桶。
    recalculatedUSD += (inTok * pricing.input + outTok * pricing.output) / 1e6;

    // 缓存 token 已收集但无价档 ⇒ 计入「未计价」计数，让缺口可见。
    if (cacheRead + cacheWrite > 0) {
      cacheUncostedRequests += 1;
      cacheUncostedTokens += cacheRead + cacheWrite;
    }
  }

  const driftUSD = upstreamUSD - recalculatedUSD;
  // 以 recalculated 为基线的相对漂移；基线为 0 时无法定义百分比，返回 null
  // （而不是 0 或 Infinity——拿 0 假装算过比不算更糟）。
  const driftPct = recalculatedUSD > 0 ? (driftUSD / recalculatedUSD) * 100 : null;

  // 「上游侧到底有没有值可比」—— 见下方 driftKind 注释。这是 2026-10-10 第七批补的：
  // 没有它时，主路径（recordUsage 的 costUSD 恒为字面量 0，aiChatCore.js:4968）会让
  // driftPct 稳定落在 -100%，读起来像「重算值错得离谱」，而真相是「没有上游值可比」。
  let upstreamReported = 0;
  for (const rec of list) {
    if (rec && typeof rec === 'object' && (Number(rec.costUSD) || 0) > 0) upstreamReported += 1;
  }

  // driftKind 把「不可比」与「不一致」分开，供展示层说不同的实话。**判定有序**，
  // 前者优先（先说更要紧的那个）：
  //   empty       无记录 —— 什么都不该显示
  //   no-upstream 上游侧一条都没给成本 ⇒ **对账不成立**，不是漂移（优先于 no-recalc：
  //               连可比的对象都没有时，「百分比无定义」是次要问题）
  //   no-recalc   重算侧为 0（全免费/零 token）⇒ 百分比无定义
  //   agree       两侧相等
  //   over/under  两侧不等，且说得出谁高谁低
  let driftKind;
  if (list.length === 0) driftKind = 'empty';
  else if (upstreamReported === 0) driftKind = 'no-upstream';
  else if (recalculatedUSD === 0) driftKind = 'no-recalc';
  else if (driftUSD === 0) driftKind = 'agree';
  else driftKind = driftUSD > 0 ? 'over' : 'under';

  return {
    records: list.length,
    upstreamUSD,
    recalculatedUSD,
    driftUSD,
    driftPct,
    driftKind,
    upstreamReported,
    cacheUncostedRequests,
    cacheUncostedTokens,
    unpricedProviders: [...unpriced].sort(),
  };
}

/**
 * 把对账结果格式化成一行人类可读摘要（只读，不触盘）。
 * 漂移超过 `warnPct` 时加 ⚠ 前缀——这是「两条成本路径不一致」的唯一告警面。
 *
 * **`no-upstream` 是独立的一档，不是漂移的一种**（2026-10-10 第七批）：主路径
 * `aiChatCore.js:4968` 传给 `recordUsage` 的 `costUSD` 是字面量 `0`，adapters 也不产
 * cost（`_responseBuilder.js` 无 `costUSD` 字段）⇒ 实时会话里上游侧**一条记录都没有值**。
 * 此时若照常打「漂移 -100.0%」，用户会读成「重算值错得离谱」，而真相是「没有上游值可比」。
 * 拿一个算得出来但没有意义的数字冒充诊断，正是本仓注释反复警告的那类事。
 *
 * @param {ReturnType<typeof reconcileCost>} r
 * @param {number} [warnPct=10]
 * @returns {string}
 */
function formatReconcileSummary(r, warnPct = 10) {
  if (!r || typeof r !== 'object') return '  成本对账: 无数据';

  const tailLines = [];
  if (r.cacheUncostedRequests > 0) {
    tailLines.push(`     ⚠ ${r.cacheUncostedRequests} 条请求含缓存 token（共 ${r.cacheUncostedTokens}）但价目表无缓存档，重算值系统性偏低`);
  }
  if (r.unpricedProviders.length > 0) {
    tailLines.push(`     ⚠ provider 无专属价目、已回落 default：${r.unpricedProviders.join('、')}`);
  }
  const tail = tailLines.length ? `\n${tailLines.join('\n')}` : '';

  if (r.driftKind === 'no-upstream') {
    // 说清楚「不可比」以及唯一可读的口径是哪一侧，而不是给一个 -100%。
    return `  成本对账: 上游未提供成本（0/${r.records} 条带 costUSD）——无法对账`
      + `\n     实时会话的上游成本尚未接线（adapters 不产 cost，主路径传字面量 0）；`
      + `可读口径只有重算侧 $${Number(r.recalculatedUSD || 0).toFixed(4)}。${tail}`;
  }

  const pct = r.driftPct === null ? 'n/a' : `${r.driftPct >= 0 ? '+' : ''}${r.driftPct.toFixed(1)}%`;
  const flag = r.driftPct !== null && Math.abs(r.driftPct) >= warnPct ? '⚠ ' : '  ';
  return `${flag}成本对账: 上游 $${r.upstreamUSD.toFixed(4)} / 重算 $${r.recalculatedUSD.toFixed(4)} / 漂移 ${pct}（${r.records} 条）${tail}`;
}

/**
 * 订阅制通道审计（[MGMT-RPT-035] L1 第二半，只读）。
 *
 * 为什么单列而不并进 `reconcileCost`：`reconcileCost` 的立身契约是**零 IO**
 * （对标 ccusage 的只读性，第二批有测试直接断言 fs 零调用）。本函数要问
 * modelPricing「这个通道该不该按 token 计价」，会触发价目表读取（有缓存）——
 * 并进去就把那条契约破了。两者分工：reconcileCost 答「两条成本路径差多少」，
 * 本函数答「有多少记录压根不该有 token 价」。
 *
 * 判据来自仓内既有裁定，不是本函数发明的：`config/models/pricing.json` 的
 * `flat-subscription-relays` 家族明确写着「这些是订阅制 IDE 通道的反向接入，
 * 账单是包月，按 token 计价本身不成立」。而 `TOKEN_PRICING` 里没有这些 provider，
 * 历史上它们一直静默落 `default` 粗价——**给一条已裁定不该计价的通道发明了价格**。
 *
 * @param {Array<{provider?:string, model?:string}>} [records] 缺省取会话 records
 * @param {{table?:object}} [opts] table 由调用方注入（测试/覆盖价目用；缺省走 modelPricing 自己的加载链）
 * @returns {{requests:number, providers:string[], tokens:number, recalculatedUSD:number,
 *            degraded:boolean}}
 */
function auditFlatChannels(records, opts = {}) {
  const list = Array.isArray(records) ? records : _sessionUsage.records;
  const providers = new Set();
  let requests = 0;
  let tokens = 0;
  let recalculatedUSD = 0;
  let degraded = false;
  try {
    // eslint-disable-next-line global-require
    const mp = require('./modelPricing');
    const tableOpts = opts && opts.table && typeof opts.table === 'object' ? { table: opts.table } : {};
    for (const rec of list) {
      if (!rec || typeof rec !== 'object') continue;
      // 先按 provider（= adapter 键）判：flat 家族正则匹配的就是 kiro/trae 这类键；
      // provider 判不出来再试 model。两者都非 flat 才跳过。
      const byProvider = mp.resolvePrice(String(rec.provider || ''), tableOpts);
      const state = byProvider.state === 'flat'
        ? 'flat'
        : mp.resolvePrice(String(rec.model || ''), tableOpts).state;
      if (state !== 'flat') continue;
      requests += 1;
      if (rec.provider) providers.add(String(rec.provider));
      const inTok = Number(rec.inputTokens) || 0;
      const outTok = Number(rec.outputTokens) || 0;
      tokens += inTok + outTok;
      const pricing = TOKEN_PRICING[rec.provider] || TOKEN_PRICING['default'];
      recalculatedUSD += (inTok * pricing.input + outTok * pricing.output) / 1e6;
    }
  } catch (err) {
    // 价目表不可用 → **必须让调用方知道审计没跑成**。最初一版在这里静默返回全 0，
    // 于是「审计坏了」和「没有 flat 通道」长得一模一样——那等于给一个已经存在的
    // 错误计价发一张无问题的健康证明，比不审计更糟。本模块无日志设施，
    // 故用 degraded 标志把失败交给调用方，而不是吞掉。
    degraded = true;
    void err;
  }
  return { requests, providers: [...providers].sort(), tokens, recalculatedUSD, degraded };
}

/**
 * Format cost report (Claude-like /cost command output, RMB primary).
 */
function formatCostReport(opts = {}) {
  const chalk = require('chalk').default || require('chalk');
  const session = getSessionUsage();
  const today = getTodayUsage();
  const month = getMonthUsage();
  const sessionCost = getSessionCost();
  const quota = getRemainingQuota();

  const fmtNum = (n) => _fmtTokenCount(n, n.toLocaleString('en-US'));
  // Cost precision routed through the CC formatCost magnitude rule (SSOT
  // ccFormat.ccFormatCostOr, same pattern as the hudRenderer status line):
  // amount > 0.5 -> 2 decimals (cents); <= 0.5 -> 4 decimals (sub-cent). Gate
  // KHY_CC_FORMAT off -> byte-identical fallback to each site's own toFixed(4)
  // (this /cost panel's historical format). ccFormat.js's header already lists
  // "router /cost hardcoded toFixed(4)" as a convergence target; this wires the
  // one call-site that was left stranded.
  const { ccFormatCostOr } = require('../utils/format/ccFormat');
  const fmtCNY = (n) => `\u00A5${ccFormatCostOr(n, n.toFixed(4), process.env)}`;
  const fmtUSD = (n) => `$${ccFormatCostOr(n, n.toFixed(4), process.env)}`;
  const d = chalk.dim;
  const w = chalk.white;
  const g = chalk.green;
  const y = chalk.yellow;
  const r = chalk.red;
  const b = chalk.bold;

  let out = '\n';
  out += b('  Token 用量 & 费用\n\n');

  // Session cost (primary)
  out += w('  \u250C\u2500 本次会话\n');
  out += d('  \u2502 ') + d('请求: ') + w(session.requests) + d(' 次') + '\n';
  out += d('  \u2502 ') + d('输入: ') + w(fmtNum(session.inputTokens)) + d(' tokens') + '\n';
  out += d('  \u2502 ') + d('输出: ') + w(fmtNum(session.outputTokens)) + d(' tokens') + '\n';
  out += d('  \u2502 ') + d('合计: ') + b(fmtNum(session.totalTokens)) + d(' tokens') + '\n';
  out += d('  \u2502 ') + d('费用: ') + y(fmtCNY(sessionCost.costCNY)) + d(` (${fmtUSD(sessionCost.costUSD)})`) + '\n';
  // \u5200110:\u4f1a\u8bdd\u4ee3\u7801\u6539\u52a8(\u5bf9\u9f50 CC /cost "Total code changes")\u3002\u95e8\u63a7 KHY_CODE_CHANGES
  // \u5173 / \u65e0\u6539\u52a8 \u2192 \u4e0d\u8ffd\u52a0\u6b64\u884c(\u9010\u5b57\u8282\u56de\u9000\u4eca\u65e5\u62a5\u8868)\u3002fail-soft:\u7edd\u4e0d\u5f71\u54cd\u4e3b\u62a5\u8868\u3002
  try {
    const _ccs = require('./codeChangeStats');
    if (_ccs.codeChangesEnabled(process.env)) {
      const _cc = getCodeChanges();
      const _ccVal = _ccs.buildCodeChangesValue(_cc.added, _cc.removed);
      if (_ccVal) out += d('  \u2502 ') + d('\u6539\u52a8: ') + w(_ccVal) + '\n';
    }
  } catch { /* fail-soft */ }
  out += d('  \u2514\n\n');

  // Today
  out += w('  \u250C\u2500 今日\n');
  out += d('  \u2502 ') + d('请求: ') + w(today.requests) + d(' 次') + '\n';
  out += d('  \u2502 ') + d('tokens: ') + w(fmtNum(today.totalTokens)) + '\n';
  out += d('  \u2514\n\n');

  // Month
  out += w('  \u250C\u2500 本月\n');
  out += d('  \u2502 ') + d('请求: ') + w(month.requests) + d(' 次') + '\n';
  out += d('  \u2502 ') + d('tokens: ') + w(fmtNum(month.totalTokens)) + '\n';
  out += d('  \u2514\n\n');

  // \u520093: \u6309\u6a21\u578b\u7528\u91cf(\u5bf9\u9f50 CC `cost-tracker.ts::formatModelUsage` \u7684 "Usage by model:")\u3002
  // \u6bcf\u6b21\u8bf7\u6c42\u65e9\u5df2\u628a {model,inputTokens,outputTokens,total,costUSD} \u8bb0\u8fdb _sessionUsage.records
  // (recordUsage),\u6b64\u524d /cost \u53ea\u6c47\u6210\u4e00\u7b14\u4f1a\u8bdd\u603b\u989d\u3001\u4ece\u4e0d\u6309\u6a21\u578b\u5f52\u7ec4 \u2192 half-wired\u3002\u7eaf\u5f52\u7ec4\u51b3\u7b56\u5728
  // \u53f6\u5b50 costByModel;\u6a21\u578b\u6807\u7b7e\u590d\u7528 cli/ccModelName.formatModelLabel \u8fd9\u4e00 SSOT(\u7531\u58f3\u6ce8\u5165,\u53f6\u5b50
  // \u4fdd\u96f6\u4f9d\u8d56)\u3002\u8bda\u5b9e\u8fb9\u754c:record \u65e0 cache read/write \u5206\u9879 \u2192 \u53ea\u5217 \u8f93\u5165/\u8f93\u51fa/\u8d39\u7528,\u4e0d\u81c6\u9020 cache \u5217
  // (\u4e0e\u520092 \u7701\u7565\u65e0\u5e95\u5ea7\u5b57\u6bb5\u540c\u7eaa\u5f8b)\u3002\u95e8\u63a7 KHY_COST_BY_MODEL \u5173 \u2192 \u4e0d\u8ffd\u52a0\u672c\u6bb5(\u9010\u5b57\u8282\u56de\u9000)\u3002
  try {
    const cbm = require('./costByModel');
    if (cbm.costByModelEnabled(process.env) && Array.isArray(session.records) && session.records.length) {
      const { formatModelLabel } = require('../utils/format/ccModelName');
      const rows = cbm.aggregateSessionUsageByModel(session.records, (m) => formatModelLabel(m, process.env));
      if (rows.length) {
        out += w('  \u250c\u2500 \u6309\u6a21\u578b\u7528\u91cf\uff08\u672c\u6b21\u4f1a\u8bdd\uff09\n');
        for (const row of rows) {
          const cny = row.cost * USD_TO_CNY;
          out += d('  \u2502 ') + w(row.label) + d(': ')
            + w(fmtNum(row.input)) + d(' \u8f93\u5165 \u00b7 ') + w(fmtNum(row.output)) + d(' \u8f93\u51fa')
            + d(' \u00b7 ') + y(fmtCNY(cny)) + d(` (${fmtUSD(row.cost)})`) + '\n';
        }
        out += d('  \u2514\n\n');
      }
    }
  } catch { /* fail-soft: \u5f52\u7ec4\u5931\u8d25\u7edd\u4e0d\u5f71\u54cd\u4e3b\u62a5\u8868 */ }

  // Quota bar
  if (quota.limit !== -1) {
    const pct = Math.round((quota.used / quota.limit) * 100);
    const color = pct > 90 ? r : pct > 70 ? y : g;
    const barLen = 20;
    const filled = Math.round(barLen * Math.min(pct, 100) / 100);
    const bar = color('\u2588'.repeat(filled)) + d('\u2591'.repeat(barLen - filled));
    out += w('  额度: ') + bar + ` ${color(pct + '%')} ` + d(`(${fmtNum(quota.used)}/${fmtNum(quota.limit)})`) + '\n';
  } else {
    out += w('  额度: ') + g('无限制 (企业版)') + '\n';
  }

  out += '\n';

  // [MGMT-RPT-035] L2/L1 的消费面：把「两条成本路径的漂移」与「订阅制通道被发明了
  // token 价」接进 /cost。此前 reconcileCost / auditFlatChannels 只有测试在用，
  // **没有任何消费方**——那正是本仓注释反复警告的形态（能力被算出来却无人读）。
  //
  // 只在**有发现时**才追加这一段：漂移超阈值、存在未计价缓存 token、存在无专属价目的
  // provider、或存在订阅制通道。四种都没有 ⇒ 输出与今日逐字节一致，不给安静的用户
  // 添噪音。
  try {
    const rec = reconcileCost(_sessionUsage.records);
    const flat = auditFlatChannels(_sessionUsage.records, opts && opts.pricingTable
      ? { table: opts.pricingTable }
      : {});
    const driftPct = rec.driftPct;
    // driftLoud 只在**两侧真的可比**时才算数：上游侧一条都没给成本时，driftPct 会稳定
    // 落在 -100%（见 reconcileCost 的 driftKind 注释），那不是「两条路径不一致」，
    // 是「只有一条路径有数据」。此时该提示的是接线缺口，不是价目问题。
    const driftLoud = driftPct !== null
      && rec.driftKind !== 'no-upstream'
      && Math.abs(driftPct) >= 10;
    const hasFinding = driftLoud
      || rec.driftKind === 'no-upstream'
      || rec.cacheUncostedRequests > 0
      || rec.unpricedProviders.length > 0
      || flat.requests > 0;
    if (hasFinding) {
      out += b('  ⚠ 计价体检\n');
      if (rec.driftKind === 'no-upstream') {
        out += d('    · 上游未提供成本，无法对账 ') + y(`0/${rec.records} 条带 costUSD`) + '\n';
        out += d('      实时会话的上游成本尚未接线（adapters 不产 cost、主路径传字面量 0）；可读口径只有重算值。') + '\n';
      } else if (driftLoud) {
        out += d('    · 成本口径漂移 ') + y(
          `${driftPct >= 0 ? '+' : ''}${driftPct.toFixed(1)}%`
        ) + d(`（上游 $${rec.upstreamUSD.toFixed(4)} / 重算 $${rec.recalculatedUSD.toFixed(4)}）`) + '\n';
        out += d('      两条路径不一致通常是价目过期或 provider 归类错，不是算错。') + '\n';
      }
      if (rec.cacheUncostedRequests > 0) {
        out += d('    · 缓存 token 未计价 ') + y(`${rec.cacheUncostedRequests} 条请求 / ${rec.cacheUncostedTokens} tokens`) + '\n';
        out += d('      价目表无缓存档 ⇒ 重算值系统性偏低，缓存命中越多偏得越多。') + '\n';
      }
      if (rec.unpricedProviders.length > 0) {
        out += d('    · 无专属价目、已回落 default：') + y(rec.unpricedProviders.join('、')) + '\n';
      }
      if (flat.requests > 0) {
        out += d('    · 订阅制通道按 token 计价不成立 ') + y(
          `${flat.providers.join('、')}（${flat.requests} 条 / ${flat.tokens} tokens）`
        ) + '\n';
        out += d(`      这些通道账单是包月；上表 $${flat.recalculatedUSD.toFixed(4)} 是按 default 粗价倒挤的，不是真实花费。`) + '\n';
      }
      out += '\n';
    }
  } catch {
    /* 体检失败不影响主报表 —— /cost 永远出得来 */
  }

  return out;
}

/**
 * Reset all usage data.
 */
function resetUsage() {
  _sessionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requests: 0,
    costUSD: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    records: [],
  };
  _compressionStats = { originalTokens: 0, compressedTokens: 0, savedTokens: 0, requests: 0 };
  _persistedMirror = { daily: {}, monthlyTotals: {} };
  _dirty = true;
  _flushSync();
}

// ── Tokenless compression tracking ──────────────────────────────────

let _compressionStats = { originalTokens: 0, compressedTokens: 0, savedTokens: 0, requests: 0 };

/**
 * Record compression savings for a single request.
 * @param {number} originalTokens - Token count before compression
 * @param {number} compressedTokens - Token count after compression
 */
function recordCompressionSavings(originalTokens, compressedTokens) {
  const saved = Math.max(0, originalTokens - compressedTokens);
  _compressionStats.originalTokens += originalTokens;
  _compressionStats.compressedTokens += compressedTokens;
  _compressionStats.savedTokens += saved;
  _compressionStats.requests++;
}

/**
 * Get compression statistics for the current session.
 */
function getCompressionStats() {
  const { originalTokens, compressedTokens, savedTokens, requests } = _compressionStats;
  return {
    originalTokens,
    compressedTokens,
    savedTokens,
    savedPercent: originalTokens > 0 ? Math.round((savedTokens / originalTokens) * 100) : 0,
    requests,
  };
}

// Periodic background flush (unref'd → never keeps the process alive).
try {
  _flushTimer = setInterval(() => _flushAsync().catch(() => {}), FLUSH_INTERVAL_MS);
  if (_flushTimer.unref) _flushTimer.unref();
} catch { /* interval is best-effort */ }

// Final sync flush on any exit path (covers `process.exit(0)` in one-shot mode,
// which bypasses signal handlers). process.once so re-registration is a no-op.
try {
  process.once('exit', () => _flushSync());
} catch { /* exit hook is best-effort */ }

module.exports = {
  recordUsage,
  getSessionUsage,
  recordCodeChange,
  getCodeChanges,
  getTodayUsage,
  getMonthUsage,
  getRemainingQuota,
  getUsageHistory,
  // ── 使用统计页的新增导出（KhyOS Desktop 消费）──
  // 宿主侧对这三者各有 typeof 兜底：后端版本落后时页面照常出数，只是少那几块。
  getModelUsage,
  getCostCoverage,
  getUsageFileStamp,
  formatInlineSummary,
  formatUsageReport,
  formatCostReport,
  calculateCost,
  estimateCost,
  getSessionCost,
  reconcileCost,
  formatReconcileSummary,
  auditFlatChannels,
  estimateTokens,
  resetUsage,
  recordCompressionSavings,
  getCompressionStats,
  TOKEN_PRICING,
  USD_TO_CNY,
  _fmtTokenCount,
  shutdown,
  __flushForTest,
};
