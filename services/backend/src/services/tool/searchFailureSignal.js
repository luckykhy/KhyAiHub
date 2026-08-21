'use strict';

// [AI-弱模型·照抄] 本文件是**纯叶子**：零 IO、确定性、绝不抛（坏输入返 null/''）、可单测。
//   判定/文案全在叶子里；把「没有可用网络数据」这件事**升级为强制兜底决策信号**由调用方
//   （工具返回契约 + 工具循环轮级守卫）施加。形状对齐 toolErrorCodes.js / toolFailureRecovery.js。
//
// searchFailureSignal —— 「网络检索无可用数据」的语义分层与决策强制单一真源。env 门控
// KHY_SEARCH_FAILURE_SIGNAL（默认开，仅 0/false/off/no 关闭即字节回退既有行为）。
//
// ── 根因（为什么空结果必须升级为强制决策，而不是如实降级返回）───────────────
// 缺口一（工具返回契约）：webSearch 全引擎失败回的是**字符串** `{success:false,
//   error:<string>}`，而 _buildToolResultMessage 的失败分支只渲染 `err.code` 对象形态 →
//   逐引擎 partialFailures（哪个引擎、为什么）整条丢弃，模型只看到一句概括，既不知道
//   试过什么，也不知道还能走哪条路。成功但覆盖面不全时，partialFailures 只作为 JSON 里
//   的一个字段夹带过去，没有任何「覆盖面不全」的显式标记。
// 缺口二（循环判定）：toolUseLoopCore 的 allFailed 分支要求**本轮每一个工具都失败**
//   且全是网络检索工具才触发。于是「200 OK 但零结果」「抓到了页面但正文提取为空」
//   「检索失败 + 另一个工具成功」这三种最典型的空手而归，全部落进「模型自己看着办」，
//   表现为拿着一句「没搜到」继续往下走，甚至凭记忆编造。
//
// ── 本叶子的分层（确定性、无模型参与）──────────────────────────────────────
//   kind = all-sources-failed : 所有引擎都失败        → 必须兜底决策
//   kind = no-results         : 全部成功但零条结果    → 必须兜底决策
//   kind = empty-extraction   : 抓取成功但正文为空    → 必须兜底决策
//   （覆盖面不全但**有**结果 = coverageNotice，不算失败信号，不改判定，只如实标注）
//
// 信号 = 可机读标记 [KHY_NO_WEB_DATA] + 已试来源及原因 + 2–3 条具体替代路径。
// 判定入口 hasUsableWebData() 供循环侧直接消费——循环不再猜「这个结果算不算拿到了东西」。

/** 可机读标记。刻意避开 [SYSTEM: / [System / [KHY PRIORITY DIRECTIVE] ——
 *  这三者会被 toolUseLoopHelpers._sanitizeToolResultOutput 改写（防提示注入），
 *  标记一旦被改写就再也认不出来。本标记不在其改写集合内，可原样穿透。 */
const MARKER = '[KHY_NO_WEB_DATA]';

/** 无可用数据的成因分类。稳定枚举，供调用方分支（勿新增同义项）。 */
const KINDS = Object.freeze({
  ALL_SOURCES_FAILED: 'all-sources-failed',
  NO_RESULTS: 'no-results',
  EMPTY_EXTRACTION: 'empty-extraction',
});

/** 已知的网络检索工具名。键必须是**归一化后**的形态（去空白/下划线/连字符、转小写），
 *  因为 isWebLookupTool 会先把入参归一化再查表 —— 写 'fetch_url' 永远匹配不上。
 *  ⚠ 刻意**不含**裸 `search` —— 仓里 `search` 是本地行情目录检索（tools/search.js，
 *  「可交易标的解析」），把它算成网络检索会在行情查无此标的时误报「联网失败」。
 *  工具循环里的 _isWebLookupToolName 是历史宽松口径（含 search），供既有 allFailed
 *  分支保持原行为；本叶子的判定一律用这个严格集合。 */
const WEB_TOOL_KEYS = Object.freeze(
  new Set(['websearch', 'webfetch', 'fetchurl', 'websearchmcp'])
);

/** 渲染上限：已试来源条数 / 单条原因字符数 / 检索目标字符数。防模型可见文本无界增长。 */
const MAX_ATTEMPTED = 4;
const MAX_REASON_CHARS = 120;
const MAX_TARGET_CHARS = 120;

function _str(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** 压平空白 + 截断。纯函数、绝不抛。 */
function _clip(v, max) {
  const s = _str(v).replace(/\s+/g, ' ').trim();
  if (s.length <= max) {
    return s;
  }
  return s.slice(0, max - 1).trimEnd() + '…';
}

/** env 门控（默认开，仅 0/false/off/no 关闭）。纯函数、绝不抛。 */
function isEnabled(env) {
  try {
    const v = _str((env || process.env || {}).KHY_SEARCH_FAILURE_SIGNAL)
      .trim()
      .toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(v);
  } catch {
    return true; // fail-soft：读不到 env 时保持默认开，不因异常静默关掉信号
  }
}

/** 工具名是否属于网络检索族。纯函数、绝不抛。 */
function isWebLookupTool(toolName) {
  try {
    const key = _str(toolName).toLowerCase().replace(/[\s_-]/g, '');
    return WEB_TOOL_KEYS.has(key);
  } catch {
    return false;
  }
}

/** 归一化 partialFailures（webSearchService 形态 {engine,message}[]）→ [{source,reason}]。
 *  容忍引擎名缺失、原因非字符串。上限 MAX_ATTEMPTED 条。纯函数、绝不抛。 */
function normalizeAttempted(partialFailures) {
  const out = [];
  try {
    for (const f of Array.isArray(partialFailures) ? partialFailures : []) {
      if (out.length >= MAX_ATTEMPTED) {
        break;
      }
      const source = _clip((f && (f.engine || f.source || f.name)) || '', 40);
      const reason = _clip((f && (f.message || f.reason || f.error)) || '', MAX_REASON_CHARS);
      if (!source && !reason) {
        continue;
      }
      out.push({ source: source || 'unknown-source', reason: reason || 'no reason reported' });
    }
  } catch {
    return [];
  }
  return out;
}

/**
 * 从一次 webSearchService 返回载荷判定「是否有可用数据」。
 * 成功且有条目 → null（无信号）；成功但零条 → no-results；失败 → all-sources-failed。
 * 纯函数、绝不抛。
 *
 * @param {object} payload webSearchService.search() 的返回对象
 * @param {{query?:string}} [opts]
 * @returns {{kind:string, tool:string, target:string, attempted:object[], detail:string}|null}
 */
function classifySearchPayload(payload, opts = {}) {
  try {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    const attempted = normalizeAttempted(payload.partialFailures);
    const target = _clip((opts || {}).query || payload.query || '', MAX_TARGET_CHARS);
    const detail = _clip(payload.error || '', MAX_REASON_CHARS);

    if (payload.success === false) {
      return { kind: KINDS.ALL_SOURCES_FAILED, tool: 'webSearch', target, attempted, detail };
    }
    const results = Array.isArray(payload.results) ? payload.results : null;
    if (results && results.length === 0) {
      return { kind: KINDS.NO_RESULTS, tool: 'webSearch', target, attempted, detail };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 抓取成功但正文为空（JS 渲染页 / 纯框架壳 / 反爬空壳）→ 空提取信号。
 * 判据只认显式计数：contentLength 为有限数且 ≤0。无法判定时返 null（零假阳性，
 * 不把「没这个字段」臆测成「内容为空」）。纯函数、绝不抛。
 *
 * @param {{url?:string, contentLength?:number, title?:string}} args
 * @returns {{kind:string, tool:string, target:string, attempted:object[], detail:string}|null}
 */
function classifyFetchResult(args = {}) {
  try {
    const len = (args || {}).contentLength;
    if (!Number.isFinite(len) || len > 0) {
      return null;
    }
    return {
      kind: KINDS.EMPTY_EXTRACTION,
      tool: 'WebFetch',
      target: _clip((args || {}).url || '', MAX_TARGET_CHARS),
      attempted: [],
      detail: 'HTTP 请求成功，但 HTML→markdown 提取后正文为 0 字符（通常是 JS 渲染页或空壳页）',
    };
  } catch {
    return null;
  }
}

/**
 * 2–3 条具体替代路径。决定论：同输入必同输出；不臆造工具名——可选工具集由调用方传入，
 * 缺省时只给「一定存在」的两条（抓已知站点 / 诚实回报）。
 *
 * @param {object} signal classify* 的产物
 * @param {{availableTools?:string[]}} [opts]
 * @returns {string[]}
 */
function buildFallbackPaths(signal, opts = {}) {
  try {
    const kind = _str((signal || {}).kind);
    const available = Array.isArray((opts || {}).availableTools)
      ? (opts || {}).availableTools.map((t) => _str(t)).filter(Boolean)
      : [];
    const has = (name) => available.some((t) => isWebLookupTool(t) && _str(t).toLowerCase().replace(/[\s_-]/g, '') === name);

    if (kind === KINDS.EMPTY_EXTRACTION) {
      return [
        'Fetch the same fact from a different, static page: call WebFetch again with an alternative URL ' +
          '(official docs / release notes / changelog / raw README) instead of the JS-rendered page.',
        'Find an alternative source first: call WebSearch for the page title plus "mirror" / "raw" / "changelog", ' +
          'then WebFetch the most static-looking hit.',
        'If no page yields content, tell the user this page returned an empty body and answer from what you actually ' +
          'read — state plainly that this URL could not be read. Do NOT claim you read it.',
      ];
    }

    const reQueryPath =
      (has('websearch') || available.length === 0) &&
      'Re-run WebSearch with different keywords (more specific, different synonyms, or add a site: filter). ' +
        'At most once per distinct wording — do not repeat the same query.';

    return [
      'Skip search entirely and read a known authoritative page: call WebFetch directly with the official ' +
        'site / docs / release-note URL for this fact.',
      reQueryPath ||
        'Re-run the failed web tool once with different parameters (different keywords or a site: filter) — ' +
          'never with the identical wording.',
      'Stop and report honestly: tell the user the live lookup failed, answer from local/context knowledge only, ' +
        'mark every time-sensitive claim as unverified, and give no citation you did not actually read. ' +
        'Do NOT fabricate facts or sources.',
    ].filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 渲染信号为模型可见文本（内联在工具结果里）。含：可机读标记 + 已试来源及原因 +
 * 编号替代路径 + 强制决策祈使句。纯函数、绝不抛。门关 / 信号非法 → ''。
 *
 * @param {object} signal
 * @param {{availableTools?:string[]}} [opts]
 * @returns {string}
 */
function renderSignal(signal, opts = {}) {
  try {
    if (!signal || !signal.kind) {
      return '';
    }
    const head =
      signal.kind === KINDS.EMPTY_EXTRACTION
        ? `${MARKER} No usable page content: ${signal.target || 'the requested URL'} was fetched but yielded an empty body.`
        : `${MARKER} No usable web data for ${signal.kind === KINDS.NO_RESULTS ? 'query' : 'lookup'}: "${signal.target || '(empty)'}" — no results available.`;

    const lines = [head];
    if (signal.detail) {
      lines.push(`Detail: ${signal.detail}`);
    }
    if (signal.attempted && signal.attempted.length) {
      lines.push('Attempted sources:');
      for (const a of signal.attempted) {
        lines.push(`  - ${a.source}: ${a.reason}`);
      }
    }
    const paths = buildFallbackPaths(signal, opts);
    if (paths.length) {
      lines.push(
        'You must now take one of these paths instead of continuing as if you had results (pick one and say which):'
      );
      paths.forEach((p, i) => {
        lines.push(`  ${i + 1}. ${p}`);
      });
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * 轮级强制兜底决策指令（工具循环注入 `[SYSTEM: ...]`）。预算未耗尽 → 允许一次换词重试；
 * 耗尽 → 停止检索、诚实收尾。纯函数、绝不抛。
 *
 * @param {object} args
 * @param {number} [args.attemptsUsed]
 * @param {number} [args.maxAttempts]
 * @param {number} [args.signalCount] 本轮信号数（用于如实说明规模）
 * @returns {string}
 */
function buildRoundDirective({ attemptsUsed, maxAttempts, signalCount } = {}) {
  try {
    const used = Number.isFinite(attemptsUsed) ? Math.max(0, attemptsUsed) : 0;
    const max = Number.isFinite(maxAttempts) ? Math.max(0, maxAttempts) : 0;
    const n = Number.isFinite(signalCount) ? Math.max(0, signalCount) : 0;
    const scope = n > 0 ? `${n} web lookup call(s) in this round produced no usable data` : 'Web lookup produced no usable data';
    if (used < max) {
      return (
        `[SYSTEM: ${scope}. Do NOT repeat the same query or URL. Make one deliberate retry with different ` +
        'keywords or a different known-authoritative URL; if that also returns nothing, stop searching.]'
      );
    }
    return (
      `[SYSTEM: ${scope}, and ${used} consecutive web rounds have failed. Stop calling web tools now. ` +
      'Two choices only: (a) fetch a specific known URL you can name, or (b) answer from local/context knowledge ' +
      'and explicitly mark time-sensitive claims as unverified. Do not fabricate facts or cite sources you did not ' +
      'read. Tell the user plainly what could not be looked up.]'
    );
  } catch {
    return '';
  }
}

/**
 * 工具结果是否含有**可用的**网络数据。循环侧判定入口 —— 只认显式证据，零假阳性：
 *   - 成功 + 有条目 / 有正文字符数 → true
 *   - 失败 / 空条目 / 空正文 / 自带失败信号 → false（如实：确实没有数据）
 *   - 非对象（result 缺失/是裸值）→ false（如实：没有数据可读）
 *   - 是对象但没有任何可判定证据（read_file 之类非检索族）→ true（**不判**，
 *     交回既有逻辑，绝不把「不是我这一族」臆测成「空手而归」）
 * 即：判「否」必须有显式证据；判不出就不判。纯函数、绝不抛。
 *
 * @param {object} result 工具结果（可能已被 _toolResultNormalizer 归一化）
 * @returns {boolean}
 */
function hasUsableWebData(result) {
  try {
    if (!result || typeof result !== 'object') {
      return false;
    }
    if (result.success !== true) {
      return false;
    }
    // 工具自己已判定「无可用数据」→ 直接采信（单一真源由首个写入者决定）。
    if (result.failureSignal && result.failureSignal.kind) {
      return false;
    }
    // 检索类：条目数即证据。先看顶层 results（裸形态），再看 data.results（webSearch 工具形态）。
    if (Array.isArray(result.results)) {
      return result.results.length > 0;
    }
    if (result.data && Array.isArray(result.data.results)) {
      return result.data.results.length > 0;
    }
    // 抓取类：提取后的正文字符数是唯一可信证据。
    if (Number.isFinite(result.contentLength)) {
      return result.contentLength > 0;
    }
    // 其余工具（非检索/抓取族）不参与本判定 —— 交回既有逻辑，绝不误判成「空手而归」。
    return true;
  } catch {
    return true; // fail-soft：判定抛出时按「可用」放行，绝不因判定异常误触强制兜底
  }
}

module.exports = {
  MARKER,
  KINDS,
  WEB_TOOL_KEYS,
  MAX_ATTEMPTED,
  MAX_REASON_CHARS,
  MAX_TARGET_CHARS,
  isEnabled,
  isWebLookupTool,
  normalizeAttempted,
  classifySearchPayload,
  classifyFetchResult,
  buildFallbackPaths,
  renderSignal,
  buildRoundDirective,
  hasUsableWebData,
};
