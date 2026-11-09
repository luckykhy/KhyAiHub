'use strict';

/**
 * unifiedSearch.js — fan out one query across local + web sources in parallel,
 * then merge + dedup into a single provenance-carrying list.
 *
 * Sources: web, local project files (grep), session history (FTS5), and — for
 * paraphrased queries only — the memory domain's hybrid entry (lexical ∪
 * semantic, consumed via its public API, never re-implemented here). Routing
 * by query type keeps exact queries on the inverted index alone: an
 * identifier/path/exact-word query never pays embedding cost.
 *
 * This is the orchestration layer; the pure merge/dedup lives in
 * ./crossSourceMerge. Dependencies (the actual searchers) are INJECTED — same
 * discipline as localWebSolver.solve — so this stays unit-testable with fakes and
 * the live wiring (grep tool / sessionSearchIndex / memoryEngine / webSearchService)
 * is built by the caller.
 *
 * Robustness contract: every source is bounded (result cap) and fail-soft — a
 * source that throws, times out, or returns garbage contributes [] and never
 * drags down the others. With all sources empty the result is an empty list, not
 * an error.
 */

const { tokenizeForSearch } = require('../../../searchTokenizer');

const merge = require('./crossSourceMerge');

function _int(envName, fallback, min, max) {
  const raw = parseInt(String(process.env[envName] || ''), 10);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, raw));
}

// CJK single chars and ultra-short ASCII make for noisy grep alternation; keep
// only discriminating terms. Bigrams (length-2 CJK) and words ≥2 chars survive.
function _isUsefulToken(t) {
  if (!t) {
    return false;
  }
  if (/^[a-z0-9_]+$/.test(t)) {
    return t.length >= 2;
  } // ascii word/number
  return t.length >= 2; // CJK bigram (single chars dropped)
}

/**
 * Build a ripgrep-safe alternation pattern from a natural-language query.
 * Tokens are regex-escaped, deduped, and capped so the pattern stays bounded.
 * Returns '' when nothing useful remains (caller skips the grep source).
 */
function buildGrepPattern(query, opts = {}) {
  const maxTerms =
    Number.isFinite(opts.maxTerms) && opts.maxTerms > 0
      ? opts.maxTerms
      : _int('KHY_UNIFIED_GREP_TERMS', 6, 1, 20);
  const terms = [];
  const seen = new Set();
  for (const t of tokenizeForSearch(query)) {
    if (!_isUsefulToken(t) || seen.has(t)) {
      continue;
    }
    seen.add(t);
    terms.push(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (terms.length >= maxTerms) {
      break;
    }
  }
  return terms.join('|');
}

// Fail-soft source runner: returns the raw value, or null if the source threw.
// Shape handling (array vs { results } vs { matches }) is left to the normalizers,
// so each source can hand back its own native result object.
async function _safe(thunk) {
  try {
    return await thunk();
  } catch {
    return null; // one source down never sinks the others
  }
}

function _str(v) {
  return String(v == null ? '' : v)
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Query-type routing ────────────────────────────────────────────────────────
// Any hit ⇒ 'exact': the user wants literal matches, the inverted index (FTS5)
// plus grep already delivers those, and vector recall would only pay embedding
// cost for nothing. The asymmetry is deliberate — missing a paraphrase (routed
// exact) loses one optional recall, while the reverse violates the hard rule
// "no embedding cost for exact queries". Signals run on the RAW query: the
// tokenizer strips quotes, dots and slashes, so the signal would be gone by then.
const EXACT_SIGNALS = [
  /["'`「」『』]/, // explicit exact string
  /[^\s]+[\\/][^\s]+/, // path separator
  /\b[A-Za-z_][\w-]*\.[A-Za-z][A-Za-z0-9]{0,7}\b/, // filename.ext
  /_/, // snake_case / ENV_VAR
  /[a-z][A-Z]/, // camelCase / PascalCase hump
  /[A-Za-z]\d|\d[A-Za-z]/, // letter-digit mix inside one token
  /[A-Za-z]+-\d+/, // hyphenated id (RUNTIME-001, GPT-4)
];

function classifyQuery(query) {
  const q = String(query || '');
  return EXACT_SIGNALS.some((re) => re.test(q)) ? 'exact' : 'semantic';
}

// Memory-domain hybrid entries (scoring.rankMemories shape: filename,
// frontmatter, body, score) → unified items. Normalized here rather than in
// crossSourceMerge because that module is outside this change's scope; the
// provenance fields mirror normalizeHistory.
function _normalizeMemories(entries) {
  const out = [];
  for (const m of Array.isArray(entries) ? entries : []) {
    if (!m) {
      continue;
    }
    const fm = m.frontmatter || {};
    const title = _str(fm.name || fm.description || m.filename);
    const snippet = _str(m.body);
    if (!title && !snippet) {
      continue;
    }
    out.push({
      source: 'local-memory',
      title,
      url: '',
      path: _str(m.filename),
      line: null,
      snippet,
      domain: '',
      type: 'local-memory',
      score: Number.isFinite(m.score) ? m.score : 0,
    });
  }
  return out;
}

/**
 * @param {string} query
 * @param {object} deps
 * @param {(q:string)=>Promise<object[]>}      [deps.webSearch]     → web results[]
 * @param {(pattern:string)=>Promise<object>}  [deps.grepSearch]    → grep content result
 * @param {(q:string)=>(object[]|Promise<object[]>)} [deps.historySearch] → FTS5 messages[]
 * @param {(q:string,opts?:{limit:number})=>(object[]|Promise<object[]>)} [deps.memorySearch]
 *        → memory-domain hybrid entries; invoked ONLY for semantic-route queries
 * @param {object} [opts]  { localCap, totalCap, jaccard, maxTerms }
 * @returns {Promise<{ items:object[], sources:{web:number,localFile:number,localHistory:number,localMemory:number}, deduped:object }>}
 */
async function unifiedSearch(query, deps = {}, opts = {}) {
  const q = String(query || '').trim();
  const empty = {
    items: [],
    sources: { web: 0, localFile: 0, localHistory: 0, localMemory: 0 },
    deduped: { total: 0, droppedWithinSource: 0, droppedCrossSource: 0 },
  };
  if (q.length < 2) {
    return empty;
  }

  const localCap =
    Number.isFinite(opts.localCap) && opts.localCap > 0
      ? opts.localCap
      : _int('KHY_UNIFIED_LOCAL_CAP', 10, 1, 100);

  const webSearch = typeof deps.webSearch === 'function' ? deps.webSearch : null;
  const grepSearch = typeof deps.grepSearch === 'function' ? deps.grepSearch : null;
  const historySearch = typeof deps.historySearch === 'function' ? deps.historySearch : null;
  // The semantic source is not even resolved for exact-route queries — the
  // embedding cost is zero, not "spent then discarded".
  const memorySearch =
    classifyQuery(q) === 'semantic' && typeof deps.memorySearch === 'function'
      ? deps.memorySearch
      : null;

  const grepPattern = grepSearch ? buildGrepPattern(q, opts) : '';

  // Parallel fan-out — all sources race concurrently; each is fail-soft.
  const [webRaw, grepRaw, histRaw, memRaw] = await Promise.all([
    webSearch ? _safe(() => webSearch(q)) : Promise.resolve(null),
    grepSearch && grepPattern ? _safe(() => grepSearch(grepPattern)) : Promise.resolve(null),
    historySearch ? _safe(() => historySearch(q)) : Promise.resolve(null),
    memorySearch ? _safe(() => memorySearch(q, { limit: localCap })) : Promise.resolve(null),
  ]);

  // Web search may hand back either a bare results[] or { results: [...] }.
  const webResults = Array.isArray(webRaw)
    ? webRaw
    : webRaw && Array.isArray(webRaw.results)
      ? webRaw.results
      : [];

  const web = merge.normalizeWeb(webResults);
  // grep result is { matches: [...] } (or already an array of matches); cap matches.
  const localFiles = merge.normalizeLocalFiles(grepRaw).slice(0, localCap);
  const localHistory = merge.normalizeHistory(histRaw).slice(0, localCap);
  const localMemory = _normalizeMemories(memRaw).slice(0, localCap);

  const deduped = merge.mergeAndDedupe([localFiles, localHistory, localMemory, web], {
    jaccard: opts.jaccard,
    totalCap: opts.totalCap,
  });

  return {
    items: deduped.items,
    sources: {
      web: web.length,
      localFile: localFiles.length,
      localHistory: localHistory.length,
      localMemory: localMemory.length,
    },
    deduped: {
      total: deduped.total,
      droppedWithinSource: deduped.droppedWithinSource,
      droppedCrossSource: deduped.droppedCrossSource,
    },
  };
}

module.exports = { unifiedSearch, buildGrepPattern, classifyQuery };
