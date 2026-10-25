'use strict';

/**
 * deferredRecallIndex.js — 纯叶子:把「未揭示延迟工具的召回词表」变成可注入系统提示的索引块
 * (工具发现层 #4「召回不到」的**词表面**)。
 *
 * 背景(khyos 自审 #4「工具发现成本高」的残余面,2026-10-13 实测):registry 里 190 个工具、
 * 其中 **36 个** shouldDefer(默认从定义里过滤掉),主聊天流把它们只以**裸名清单**注入
 * (`# Additional Tools ... <name>, <name>, ...`)。而模型要用的召回通道 toolSearch 打分
 * (`tools/toolRecommend.js` scoreTool:别名 +8 / searchHint +4 / 描述 +2)**按词命中** —
 * 也就是「找得到」的前提是模型先猜到 hint 里的词。hint 本身(每个延迟工具都有,部分双语)
 * 从不进提示 → 模型看到 `RPA`/`Snip`/`registrySearch` 这些裸名,**没法反推该搜什么词**,
 * 于是绕远路或手搓。本叶子把每个未揭示延迟工具的**召回词**(别名 + searchHint,与打分器同源)
 * 随名字一起列进提示,让「想用什么能力 → 搜哪个词 → 命中哪个工具」这条链在同一屏里闭合。
 *
 * 设计取舍:
 *   - **词表从 registry 元数据派生,不是第二份手搓映射**:名字/别名/hint 全取自工具自身
 *     (`tool.name` / `tool.aliases` / `tool.searchHint`),新增延迟工具自动进索引,删改工具
 *     也不会与索引漂移(对比 TOOL_CLUSTERS 的手工簇表——它只覆盖 18/36,且需要守卫锁名字)。
 *   - **与打分器同源是硬不变量**:索引里的每个词都必须是 scoreTool 能命中的词(测试实跑真
 *     scoreTool 逐词断言 >0)。索引里的词命中不了 → 这机制等于骗人,故用真实打分器把关。
 *   - **不改判定、只加词**:本块只出现在系统提示里,揭示/过滤/派发一律不动;门控关 → 返回
 *     与历史**逐字节相同**的裸名清单,接缝无需第二份模板(少一处漂移源)。
 *   - **有界**:每工具最多 6 词、单词 ≤16 字符、总行数 ≤60,超出确定式截断并如实标注剩余量
 *     —— 延迟加载的全部意义是省 token,索引自己不能变成新的膨胀源。
 *
 * 落地阶段(executorStage,`docs/10_规范/registry/FEATURE-OWNERSHIP.json` 校验):
 * S1 观察者——只往提示里加召回词,不拦截、不阻断、不改任何流程(升 S3 的含义是把它接进
 * toolSearch 的零命中回退,那会真正改变工具结果,须先攒够样本)。
 *
 * 契约(纯叶子):零 IO、确定性、绝不抛。工具清单/**env 由调用方传入**(本模块不碰 registry)。
 * 门控 KHY_TOOL_RECALL_INDEX(默认开,仅 0/false/off/no 关)经 flagRegistry 集中判定,
 * 不可用则回退本地 CANON 词表。
 *
 * @module services/tool/deferredRecallIndex
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 落地阶段常量(执行器侧的阶段权威)。**不是装饰**:FEATURE-OWNERSHIP.json 的
 * `rollout.mechanisms[].executorStage` 指向它,`scripts/ci/check-rollout-stage.js` 读源码
 * 比对「登记说 S1」与「代码其实在拦」是否漂移(S1 ⇒ 不阻断)。
 */
const KHY_TOOL_RECALL_INDEX_STAGE = 'S1';

/** 块首行标记:与历史提示同款(接缝去重/测试定位/人肉 grep 都认它)。 */
const MARKER = '# Additional Tools';

/** 历史块头两行(裸名清单时代逐字节原文)。门控关 → 用它回退。 */
const LEGACY_PREAMBLE =
  'The following tools are available but not currently loaded to save context space. ' +
  'Use the toolSearch tool to discover and activate them when needed:';

/** 索引块第三行:把「词表怎么用」讲清,并点掉「手搓」这条退路。 */
const INDEX_USAGE_LINE =
  'Each line is `<ToolName>: <recall keywords>` — search toolSearch with those keywords (or `select:<ToolName>` to load one exactly). Before hand-rolling a one-off script for any capability listed below, check this list first.';

// ── 有界压缩参数(默认值,调用方可覆写)──────────────────────────────────────
const DEFAULT_MAX_TOKENS_PER_TOOL = 6;
const DEFAULT_MAX_TOKEN_CHARS = 16;
const DEFAULT_MAX_TOOLS = 60;

// 英文虚词封闭表:出现频率高、携带能力信息为零,留着只会稀释检索词。
const _NOISE = new Set([
  'the',
  'a',
  'an',
  'for',
  'to',
  'of',
  'and',
  'or',
  'in',
  'on',
  'with',
  'is',
  'it',
  'this',
  'that',
  'from',
  'by',
  'at',
  'as',
  'get',
  'use',
  'used',
  'using',
]);

const _ASCII_TOKEN = /^[a-z0-9_]+$/;

/**
 * 门控判定。优先 flagRegistry(集中优先级),不可用时回退本地 CANON 词表。默认开。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('../../utils/flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_TOOL_RECALL_INDEX', e);
    }
  } catch {
    /* 注册表不可用 → 本地回退 */
  }
  const v = e.KHY_TOOL_RECALL_INDEX;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 历史格式的裸名清单块(门控关时的回退,**逐字节**等于 2026-10-13 前接缝里那段拼接)。
 * @param {string[]} names
 * @returns {string}  空清单 → ''(与历史「无未揭示工具则不注入」一致)
 */
function legacyHint(names) {
  const list = _nameList(names);
  if (list.length === 0) {
    return '';
  }
  return `${MARKER}\n${LEGACY_PREAMBLE}\n${list.join(', ')}`;
}

/**
 * 取单个工具的召回词(别名优先——打分器给别名 +8 高于 hint +4;再取 searchHint 词)。
 * 规则全是确定式的:小写归一、去尾部标点、丢虚词、丢与工具名同形的词、ASCII 词按子串去重。
 * @param {object} tool  defineTool 冻结对象(可能缺字段;绝不抛)
 * @param {object} [opts] {maxTokens, maxTokenChars}
 * @returns {string[]}
 */
function vocabularyForTool(tool, opts = {}) {
  try {
    const o = opts || {};
    const maxTokens =
      Number.isFinite(o.maxTokens) && o.maxTokens > 0
        ? Math.floor(o.maxTokens)
        : DEFAULT_MAX_TOKENS_PER_TOOL;
    const maxChars =
      Number.isFinite(o.maxTokenChars) && o.maxTokenChars > 0
        ? Math.floor(o.maxTokenChars)
        : DEFAULT_MAX_TOKEN_CHARS;

    const nameLower = String((tool && tool.name) || '').toLowerCase();
    const nameParts = new Set(_nameParts(String((tool && tool.name) || '')));

    const raw = [];
    const aliases = Array.isArray(tool && tool.aliases) ? tool.aliases : [];
    for (const a of aliases) {
      raw.push(a);
    }
    for (const t of String((tool && tool.searchHint) || '').split(/\s+/)) {
      raw.push(t);
    }

    const kept = [];
    for (const tok of raw) {
      let t;
      try {
        t = String(tok == null ? '' : tok)
          .trim()
          .toLowerCase()
          .replace(/[,;:.!?]+$/g, '');
      } catch {
        continue;
      }
      if (!t || t.length > maxChars) {
        continue;
      }
      if (_NOISE.has(t)) {
        continue;
      }
      if (t === nameLower || nameParts.has(t)) {
        continue;
      }
      let dup = false;
      for (const k of kept) {
        if (k === t) {
          dup = true;
          break;
        }
        // ASCII 词按子串去重(package/packages、search/search_web 这类形态变体);
        // CJK 复词不去重——「自动」与「自动化」在中文检索里各自成词,丢一个就丢一层召回。
        if (_ASCII_TOKEN.test(t) && _ASCII_TOKEN.test(k) && (k.includes(t) || t.includes(k))) {
          dup = true;
          break;
        }
      }
      if (dup) {
        continue;
      }
      kept.push(t);
      if (kept.length >= maxTokens) {
        break;
      }
    }
    return kept;
  } catch {
    return [];
  }
}

/**
 * 组装索引正文(不含门控判定,纯函数):每行 `- <Name>: <词表>`。
 * @param {string[]} names  未揭示的延迟工具名
 * @param {Map|object|Array} tools  名字 → 工具对象(缺元数据的名字也照列,只是没有词)
 * @param {object} [opts] {maxTokens, maxTokenChars, maxTools}
 * @returns {{lines:string[], listed:number, omitted:number}}
 */
function formatRecallIndex(names, tools, opts = {}) {
  const o = opts || {};
  const maxTools =
    Number.isFinite(o.maxTools) && o.maxTools > 0 ? Math.floor(o.maxTools) : DEFAULT_MAX_TOOLS;
  const all = _nameList(names).slice().sort();
  const listed = all.slice(0, maxTools);
  const byName = _toolLookup(tools);
  const lines = [];
  for (const name of listed) {
    const vocab = vocabularyForTool(byName.get(name), {
      maxTokens: o.maxTokens,
      maxTokenChars: o.maxTokenChars,
    });
    lines.push(vocab.length ? `- ${name}: ${vocab.join(' ')}` : `- ${name}`);
  }
  const omitted = all.length - listed.length;
  if (omitted > 0) {
    lines.push(`… ${omitted} more deferred tool(s) not listed here — discover via toolSearch.`);
  }
  return { lines, listed: listed.length, omitted };
}

/**
 * 接缝用入口:给「未揭示的延迟工具」生成要注入系统提示的整块文本。
 *
 * 门控关 → 返回 `legacyHint(names)`(与历史逐字节相同);无未揭示工具 → ''(与历史一致,
 * 不注入空块);门控开 → 索引块。任何异常 → 绝不抛,退化为 ''(接缝另有 catch)。
 *
 * @param {string[]} names  未揭示的延迟工具名(接缝已按 revealedDeferred 过滤好)
 * @param {Map|object|Array} tools  名字 → 工具对象(通常 registry.getDeferredTools())
 * @param {object} [opts]  {env, maxTokens, maxTokenChars, maxTools}
 * @returns {string}
 */
function buildDeferredToolsHint(names, tools, opts = {}) {
  try {
    const o = opts || {};
    const list = _nameList(names);
    if (list.length === 0) {
      return '';
    }
    if (!isEnabled(o.env)) {
      return legacyHint(list);
    }
    const { lines } = formatRecallIndex(list, tools, o);
    if (lines.length === 0) {
      return legacyHint(list);
    }
    return `${MARKER}\n${LEGACY_PREAMBLE}\n${INDEX_USAGE_LINE}\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

// ── 内部工具(确定性、不抛)────────────────────────────────────────────────

/** 归一成去重、去空的名字数组(任意输入 → [])。 */
function _nameList(names) {
  try {
    const out = [];
    const seen = new Set();
    if (!names || typeof names[Symbol.iterator] !== 'function') {
      return out;
    }
    for (const n of names) {
      const s = String(n == null ? '' : n).trim();
      if (!s || seen.has(s)) {
        continue;
      }
      seen.add(s);
      out.push(s);
    }
    return out;
  } catch {
    return [];
  }
}

/** 名字 → 工具对象的查表(吃 Map / plain object / 工具数组)。 */
function _toolLookup(tools) {
  const map = new Map();
  try {
    if (tools instanceof Map) {
      for (const [k, v] of tools) {
        map.set(String(k), v);
      }
    } else if (Array.isArray(tools)) {
      for (const t of tools) {
        if (t && t.name) {
          map.set(String(t.name), t);
        }
      }
    } else if (tools && typeof tools === 'object') {
      for (const [k, v] of Object.entries(tools)) {
        map.set(String(k), v);
      }
    }
  } catch {
    /* 坏输入 → 空表(索引退化为只有名字) */
  }
  return map;
}

/** 名字拆词块(camelCase / snake_case → 小写词块),与打分器 parseToolName 的直觉一致。 */
function _nameParts(name) {
  try {
    return String(name)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  KHY_TOOL_RECALL_INDEX_STAGE,
  MARKER,
  LEGACY_PREAMBLE,
  INDEX_USAGE_LINE,
  isEnabled,
  legacyHint,
  vocabularyForTool,
  formatRecallIndex,
  buildDeferredToolsHint,
};
