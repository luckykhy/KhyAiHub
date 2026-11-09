// khy-canary: Khy-20261101-254-M74BNE7V
'use strict';

/**
 * clueVault.js — 线索保全：确定性抽取「丢了会出错」的线索，并在压缩/归档/断点三处接缝回流。
 *
 * WHY THIS EXISTS（问题定位，2026-10-13）：
 *   长任务里上下文压缩让对话能无限延续，代价是**早期的关键决策与约束被稀释**——跑到第
 *   几十步时模型忘了最初定的规矩，然后做跑偏的事。仓内既有兜底（todo / memory / 任务锚点
 *   `<original_task>` / intentAssurance 指令）覆盖的是「用户初始意图」与「机器可枚举的待办」，
 *   但缺一条：**哪些信息是「丢了会出错」的**——判断散落在各机制里，没有一处可执行的判据。
 *   实测两处病灶佐证：
 *     - `boulderState.js:282` 声明的 contextSummary「Compressed context summary from
 *       compactPipeline」**在 src 内没有任何写入者**（agenticHarnessService.js:443/611 只透传
 *       `info.contextSummary || ''`，checkpointThrottle.js 生产载荷不含该字段）——断点续跑
 *       回灌的摘要恒为空。
 *     - `contextCompressor.js:1508 adjustSplitForPins`（工作集/报错 pinning）全仓零调用方；
 *       而 `aiChatCore.js:3967` 调 `triggerCycleBoundary` 不传 `callModelFn` ⇒ L2
 *       「decisions + constraints + hypotheses」briefing 恒走 1345-1357 的兜底（最近 3 条
 *       assistant 首句）——决策与约束正是这样丢的。
 *
 * WHAT IT DOES（本叶子）：
 *   一行判据 = 一类「丢了会出错」的线索。四类（kind）大小写不敏感的确定性识别：
 *     - constraint 约束：必须/不要/禁止… ——违反即交付错误，事后无法从代码反推；
 *     - decision   决策及理由：决定/改用/采用… ——丢失会导致重开已否决方案；
 *     - anchor     锚：KHY_* 门控名/文件路径/引号片段 ——丢失则动作打到错误目标；
 *     - open       未决：待定/待确认/TBD… ——丢失 = 未决被静默当作已关闭。
 *   其余内容默认判「可丢」。`extractClues`（纯识别）→ `renderLedger`（预算内渲染）→
 *   `buildDigest`（门控感知的便捷出口）。渲染出的 [CLUE-LEDGER v1] 块可被本模块**再次识别**
 *   （结构化行 `- [类别·来源] 文本` 回流，来源标注保真），因此跨多轮压缩线索不会丢、不会涨。
 *
 * 注入面（接缝，均由调用方 fail-soft 包裹）：
 *   1) contextCompressor.js compress()：digest 进摘要提示（告诉摘要模型这些必须活下来）
 *      + 并入压缩结果的自动摘要块（`<clue_ledger>` 段；不新增消息条数——条数被既有代理
 *      断言与下游桥接逻辑依赖）；
 *   2) contextCompressor.js _incrementalUpdate()：digest 进增量摘要提示；
 *   3) contextCompressor.js triggerCycleBoundary()：兜底 briefing 追加 digest（无模型可用时
 *      仍保线索）；
 *   4) agenticHarnessService.js：checkpoint 的 contextSummary 由 digest 填充（治上面那个
 *      「恒为空」的写入缺口）。
 *
 * ROLLOUT (PROCESS-008)：
 *   S1 观察者。本机制**不拦截**：三处接缝全是**只增不改**（不调 splitIndex、不消费
 *   adjustSplitForPins、不改任何既有字段），门控关时逐字节回退。S2 才允许把判据接进
 *   压缩决策（split 调整），S3 才允许 pin 强制——均须人工裁决。阶段真源是下方**字面常量**
 *   `KHY_CLUE_VAULT_STAGE='S1'`（check-rollout-stage.js 用正则在本文件里找它并与
 *   FEATURE-OWNERSHIP.json 登记比对；只从 env 读的同族先例都挂着 authority-drift warning）。
 *
 * 契约：零 IO、确定性、绝不抛。门控 KHY_CLUE_VAULT（默认开，仅显式 0/false/off/no 关；
 * 关闭后 buildDigest/formatForSystemPrompt 返 '' → 接缝逐字节回退）。父门控经 flagRegistry
 * 集中判定（CANON 词表），fail-soft 回退本地 CANON。
 *
 * @module services/clueVault
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控判定。优先走 flagRegistry（集中优先级 + 父门控），不可用时回退本地 CANON 词表。
 * 默认开，仅显式 0/false/off/no 关。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_CLUE_VAULT', e);
    }
  } catch {
    /* 注册表不可用 → 本地回退 */
  }
  const v = e.KHY_CLUE_VAULT;
  return !(v !== undefined && v !== null && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 落地阶段**字面真源**（勿改成只从 env 读：check-rollout-stage.js 按字面常量比对登记表）。
 * env 同名变量可覆盖。
 */
const KHY_CLUE_VAULT_STAGE = 'S1';

/**
 * 落地阶段。默认 S1（观察者）；仅认 S2/S3，其余一律回落 S1（绝不 fail-open 到更高阶段）。
 * @param {object} [env]
 * @returns {'S1'|'S2'|'S3'}
 */
function getStage(env = process.env) {
  const raw = String((env && env.KHY_CLUE_VAULT_STAGE) || KHY_CLUE_VAULT_STAGE)
    .trim()
    .toUpperCase();
  if (raw === 'S2' || raw === 'S3') {
    return raw;
  }
  return KHY_CLUE_VAULT_STAGE;
}

// 系统提示块首行标记 / 压缩结果回流块的包裹标签（供接缝定位与测试引用）。
const CLUE_VAULT_MARKER = '## 线索保全（CLUE-LEDGER）';
const CLUE_LEDGER_MARKER = '[CLUE-LEDGER v1]';
const CLUE_LEDGER_TAG = 'clue_ledger';

/** 单行超过此长度不参与扫描（人类线索行是句子；超长行是代码/工具转储）。 */
const MAX_SCAN_LINE_CHARS = 240;
/** 单条线索文本上限（超长截断加省略号）。 */
const MAX_CLUE_TEXT_CHARS = 160;
/** digest 默认字符预算 / 硬上限（boulderState MAX_CONTEXT_SUMMARY_LEN=8000，留足余地）。 */
const DEFAULT_MAX_DIGEST_CHARS = 1600;
const MAX_DIGEST_CHARS = 4000;
/** 尾部「超预算未列」行预留（保证含 footer 时总长仍 ≤ maxChars）。 */
const FOOTER_RESERVE = 64;

/** 每类线索的条数上限（超出按「最早优先」丢弃靠后的）。 */
const PER_KIND_LIMIT = Object.freeze({ constraint: 8, decision: 8, anchor: 6, open: 5 });

/**
 * 线索类别 SSOT：判据的「为什么」在此声明，检测器逐类对应。
 * kind=类别键；label=渲染标签；why=丢失代价（这就是「丢了会出错」的定义）。
 */
const CLUE_KINDS = Object.freeze([
  Object.freeze({
    kind: 'constraint',
    label: '约束',
    why: '违反约束即交付错误，且事后无法从代码反推（用户当初说过的规矩只在这句话里）',
  }),
  Object.freeze({
    kind: 'decision',
    label: '决策',
    why: '决策丢失会导致重开已否决方案、推翻既有实现；理由丢失会让「为什么这么写」不可考',
  }),
  Object.freeze({
    kind: 'anchor',
    label: '锚',
    why: '门控名/路径/引号片段丢失后动作会打到错误目标（改错文件、设错门控）',
  }),
  Object.freeze({
    kind: 'open',
    label: '未决',
    why: '未决问题被静默当作已关闭 = 漏做，且无人发现',
  }),
]);

const _LABEL_OF = Object.freeze(
  Object.fromEntries(CLUE_KINDS.map((k) => [k.kind, k.label]))
);
const _KIND_OF_LABEL = Object.freeze(
  Object.fromEntries(CLUE_KINDS.map((k) => [k.label, k.kind]))
);

/**
 * 检测器（顺序即优先级，一行至多出一类；首个命中即停）。
 * 正则均为非全局字面量：无 lastIndex 状态，确定性。
 * veto = 该类的否定语境（如「没有新决定」「不需要」），命中则本类不成立、让给下一类。
 * 口径刻意偏召回（宁多保一条、勿漏一条），精确性由 veto + per-kind 上限与预算截断兜底。
 */
const _DETECTORS = Object.freeze([
  Object.freeze({
    kind: 'constraint',
    re: /必须|务必|不得|不许|禁止|切勿|绝不|只能|严禁|不要|不准|别再|\bmust\b|\bnever\b|\bdo not\b|\bdon't\b|\bshall not\b|\bshould not\b|\bshouldn't\b|\bnot allowed\b|\bmandatory\b/i,
    // 「不需要/不用」是陈述而非约束；「不要再问/提」是社交辞令而非交付约束。
    veto: /不(?:需|用)|别再(?:问|提)/,
  }),
  Object.freeze({
    kind: 'decision',
    re: /决定|敲定|定为|改为|改用|换成|采用|选定|弃用|停用|确定使用|选择使用|\bdecided\b|\bwe'll use\b|\bwe will use\b|\bgoing with\b|\bswitch(?:ed)? to\b|\bchose\b|\bchoose to\b|\bsettled on\b|\bopted for\b|\brenamed to\b|\bmigrat(?:e|ed) to\b/i,
    // 「没有新决定/还没决定/尚未敲定」是**未决**，不是决策——veto 后让 open 类接住。
    veto: /(?:还没|尚未|没有|没)(?:新|做|下|最终)?的?(?:决定|敲定|确定)/,
  }),
  Object.freeze({
    kind: 'open',
    re: /待定|待确认|待办|待决定|尚未|未决|还没定|还没(?:有)?决定|还没(?:有)?敲定|未决定|下一步要|下一步需|留待|悬而未决|\bTBD\b|\bTODO\b|\bFIXME\b|\bopen question\b|\bpending\b/i,
  }),
  Object.freeze({
    kind: 'anchor',
    re: /\bKHY_[A-Z0-9_]{2,}\b|\b[\w.-]+[\\/][\w.\\/-]+\.(?:js|mjs|cjs|ts|tsx|json|jsonl|md|py|vue|sh|cmd|bat|ps1|yml|yaml|toml|db)\b|\b[\w-]+\.(?:js|json|md|py|vue|ts)\b|「[^」\n]{2,40}」|『[^』\n]{2,40}』|“[^”\n]{2,40}”|`[^`\n]{2,60}`|\bv\d+\.\d+\.\d+\b/,
  }),
]);

/** 派生文本不参与抽取（摘要/锚点/归档块是二手转述；cc 摘要正文与原始需求另有机制保全）。 */
const _DERIVED_MARKERS = Object.freeze([
  '<compressed_context>',
  '<original_task>',
  '<cycle_boundary',
]);

/** 结构化台账行：`- [类别·来源] 文本`（本模块回流块的行格式，识别即保真带回）。 */
const _LEDGER_LINE_RE = /^\s*[-•*]\s*\[([^\]\n]{1,60})\]\s*(.+)$/;

/**
 * 取消息文本（只认字符串或 text 块；tool_use/tool_result 块不扫——那是执行噪声，不是人话）。
 * @param {*} msg
 * @returns {string}
 */
function _contentText(msg) {
  if (!msg || typeof msg !== 'object') {
    return '';
  }
  const c = msg.content;
  if (typeof c === 'string') {
    return c;
  }
  if (Array.isArray(c)) {
    const parts = [];
    for (const b of c) {
      if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

/** 归一化（去空白折叠 + 小写）：仅作去重键，不改渲染原文。 */
function _norm(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 截断到 MAX_CLUE_TEXT_CHARS（超出加省略号）。 */
function _clip(s) {
  const t = String(s || '').trim();
  return t.length > MAX_CLUE_TEXT_CHARS ? t.slice(0, MAX_CLUE_TEXT_CHARS - 1) + '…' : t;
}

/** 行级判类：按 _DETECTORS 顺序首个命中即返回 kind；无命中（或命中否决语境）返回 ''。 */
function _classifyLine(line) {
  const s = String(line || '').trim();
  if (!s) {
    return '';
  }
  for (const d of _DETECTORS) {
    if (d.veto && d.veto.test(s)) {
      continue; // 否定语境：本类不成立，让给下一类/判可丢
    }
    if (d.re.test(s)) {
      return d.kind;
    }
  }
  return '';
}

/** 解析回流行；非结构化行/未知类别 → null（台账块内只认结构化行，其余一律忽略）。 */
function _parseLedgerLine(line) {
  const m = _LEDGER_LINE_RE.exec(String(line || ''));
  if (!m) {
    return null;
  }
  const head = m[1];
  const text = String(m[2] || '').trim();
  if (!text) {
    return null;
  }
  const dot = head.indexOf('·');
  if (dot <= 0) {
    return null;
  }
  const kind = _KIND_OF_LABEL[head.slice(0, dot).trim()] || '';
  if (!kind) {
    return null;
  }
  return { kind, source: head.slice(dot + 1).trim(), text };
}

/**
 * 从消息序列抽取线索（纯识别，不管门控与预算；渲染/预算见 renderLedger）。
 * 确定性：同一输入 → 逐字节相同的冻结结果；去重保留**最早**出现（先定的规矩优先）。
 *
 * @param {Array} messages
 * @param {object} [opts] 预留（当前无选项，保持签名稳定）
 * @returns {ReadonlyArray<{kind:string,label:string,text:string,source:string,msgIndex:number,role:string,carried:boolean,hits:number}>}
 */
function extractClues(messages, opts = {}) {
  try {
    if (!Array.isArray(messages)) {
      return Object.freeze([]);
    }
    const byNorm = new Map(); // norm → 冻结前的可变条目
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const role = msg && typeof msg.role === 'string' ? msg.role : '';
      if (role !== 'user' && role !== 'assistant') {
        continue;
      }
      const text = _contentText(msg);
      if (!text) {
        continue;
      }
      const isLedger =
        text.includes(CLUE_LEDGER_MARKER) || text.includes('<' + CLUE_LEDGER_TAG + '>');
      // 派生文本（摘要正文/原任务锚/归档块）不扫——但**携带台账的**压缩摘要块例外：
      // 台账段是我们自己的结构化回流（isLedger 时只认结构化行），跨轮承接靠它。
      if (!isLedger && _DERIVED_MARKERS.some((mk) => text.includes(mk))) {
        continue;
      }
      const lines = text.split('\n');
      for (const line of lines) {
        if (!line || !line.trim() || line.length > MAX_SCAN_LINE_CHARS) {
          continue;
        }
        let kind = '';
        let clueText = '';
        let source = '';
        let carried = false;
        if (isLedger) {
          const parsed = _parseLedgerLine(line);
          if (!parsed) {
            continue; // 台账块：只认结构化行，标题/说明行一律忽略
          }
          kind = parsed.kind;
          clueText = parsed.text;
          source = parsed.source; // 来源保真回流（原始 用户#N / 助手#N）
          carried = true;
        } else {
          if (line.trim().startsWith(CLUE_LEDGER_MARKER)) {
            continue;
          }
          kind = _classifyLine(line);
          if (!kind) {
            continue;
          }
          clueText = line.trim();
          source = (role === 'user' ? '用户' : '助手') + '#' + (i + 1);
        }
        const norm = _norm(kind + '|' + clueText.replace(/^[-•*]\s*/, ''));
        if (!norm || norm === kind + '|') {
          continue;
        }
        const prev = byNorm.get(norm);
        if (prev) {
          prev.hits += 1;
          continue;
        }
        byNorm.set(norm, {
          kind,
          label: _LABEL_OF[kind] || kind,
          text: _clip(clueText),
          source,
          msgIndex: i,
          role,
          carried,
          hits: 1,
        });
      }
    }
    const out = [];
    for (const e of byNorm.values()) {
      out.push(Object.freeze(e));
    }
    return Object.freeze(out);
  } catch {
    return Object.freeze([]); // 绝不抛：线索保全自身出错时按「无线索」处理
  }
}

/**
 * 渲染台账文本（预算内）。空线索 → ''（不注入空块，不浪费 token）。
 * 截断规则：每类条数上限 + 总字符预算（含 footer 预留），超出按**最早优先**丢弃靠后的。
 *
 * @param {ReadonlyArray} clues extractClues 的输出
 * @param {object} [opts] {maxChars}
 * @returns {string}
 */
function renderLedger(clues, opts = {}) {
  try {
    const list = Array.isArray(clues) ? clues : [];
    if (!list.length) {
      return '';
    }
    const o = opts || {};
    const maxChars = Math.max(
      400,
      Math.min(MAX_DIGEST_CHARS, Number(o.maxChars) || DEFAULT_MAX_DIGEST_CHARS)
    );

    const kept = [];
    const counts = {};
    let skipped = 0;
    for (const c of list) {
      if (!c || !_LABEL_OF[c.kind]) {
        continue;
      }
      const kindCount = counts[c.kind] || 0;
      if (kindCount >= (PER_KIND_LIMIT[c.kind] || 8)) {
        skipped += 1;
        continue;
      }
      counts[c.kind] = kindCount + 1;
      kept.push(c);
    }
    if (!kept.length) {
      return '';
    }

    const headerFor = (n) =>
      CLUE_LEDGER_MARKER +
      ` ${n} 条「丢了会出错」的线索（较早原文的确定性摘录，压缩/续跑后仍有效；块外内容判为可丢）:`;
    const lineOf = (c) => `- [${_LABEL_OF[c.kind]}·${c.source}] ${c.text}`;

    let n = kept.length;
    let header = headerFor(n);
    let total =
      header.length + 1 + kept.reduce((sum, c) => sum + lineOf(c).length + 1, 0) - 1;
    while (total > maxChars - FOOTER_RESERVE && n > 1) {
      kept.pop();
      skipped += 1;
      n -= 1;
      header = headerFor(n);
      total = header.length + 1 + kept.reduce((sum, c) => sum + lineOf(c).length + 1, 0) - 1;
    }
    if (!kept.length) {
      return '';
    }

    const out = [header, ...kept.map(lineOf)];
    if (skipped > 0) {
      out.push(`- …另有 ${skipped} 条超出预算未列出（已按最早优先保留）`);
    }
    return out.join('\n');
  } catch {
    return '';
  }
}

/**
 * 门控感知的便捷出口（接缝主用）；门控关 → ''（接缝逐字节回退到改前形态）。
 * @param {Array} messages
 * @param {object} [opts] {env, maxChars}
 * @returns {string}
 */
function buildDigest(messages, opts = {}) {
  try {
    const o = opts || {};
    if (!isEnabled(o.env)) {
      return '';
    }
    return renderLedger(extractClues(messages, o), o);
  } catch {
    return '';
  }
}

/**
 * 增量摘要路径的台账组合：`priorText`（上一轮摘要，通常已被替换掉）**只贡献结构化台账行**
 * ——来源标注保真回家（用户#N/助手#N 来自行内，而非 prior 文本的位次）；派生正文永不参与
 * 抽取。随后并入 newMessages 的新线索，同 kind+文本去重保留首见（承接项在前）。门控关 → ''。
 *
 * 为什么需要它：增量路径用新摘要**替换**旧摘要文本，若不显式承接，上一轮台账会随旧文本
 * 一起消失——这正是「跨轮丢线索」的那条缝。
 *
 * @param {string} priorText
 * @param {Array} newMessages
 * @param {object} [opts] {env, maxChars}
 * @returns {string}
 */
function buildDigestWithCarry(priorText, newMessages, opts = {}) {
  try {
    const o = opts || {};
    if (!isEnabled(o.env)) {
      return '';
    }
    const carried = [];
    const s = typeof priorText === 'string' ? priorText : '';
    if (s.includes(CLUE_LEDGER_MARKER) || s.includes('<' + CLUE_LEDGER_TAG + '>')) {
      for (const line of s.split('\n')) {
        const parsed = _parseLedgerLine(line);
        if (parsed) {
          carried.push({
            kind: parsed.kind,
            label: _LABEL_OF[parsed.kind],
            text: _clip(parsed.text),
            source: parsed.source,
            msgIndex: -1,
            role: '',
            carried: true,
            hits: 1,
          });
        }
      }
    }
    const fresh = extractClues(newMessages, o);
    const seen = new Set();
    const merged = [];
    for (const c of [...carried, ...fresh]) {
      const key = c.kind + '|' + _norm(c.text);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(c);
    }
    return renderLedger(merged, o);
  } catch {
    return '';
  }
}

/**
 * 系统提示 A 层块：把 [CLUE-LEDGER] 块的语义与「线索书写纪律」告诉模型。门控关 → ''。
 * @param {object} [opts] {env}
 * @returns {string}
 */
function formatForSystemPrompt(opts = {}) {
  const o = opts || {};
  if (!isEnabled(o.env)) {
    return '';
  }
  return [
    CLUE_VAULT_MARKER,
    '- 压缩/归档/断点续跑之后可能出现 [CLUE-LEDGER v1] 块：它是更早对话里「丢了会出错」线索（约束/决策/锚/未决）的确定性摘录，**继续有效**；看不到原文不等于它被取消，禁止重新推导或默默推翻。',
    '- 若要做与块内约束/决策相抵触的改动：先在回复里显式指出冲突与理由，再改；块内「未决」项不得被静默当作已关闭。',
    '- 你做出持久决策或开新的未决问题时，写成一行：`决策: …（理由: …）`、`未决: …`、`约束: …`——后续压缩据此把线索保下来。',
    '- 被问到更早的规矩/决定时：先回看 CLUE-LEDGER 与压缩摘要再回答；那里没有就如实说没记录，不要编。',
  ].join('\n');
}

/**
 * 结构化摘要（KhySelf / 观测面 / 探针用）。绝不抛。
 * @param {object} [opts] {env}
 * @returns {{enabled:boolean, stage:string, marker:string, ledgerMarker:string, kinds:Array, maxDigestChars:number, perKindLimit:object}}
 */
function summarize(opts = {}) {
  const o = opts || {};
  return {
    enabled: isEnabled(o.env),
    stage: getStage(o.env),
    marker: CLUE_VAULT_MARKER,
    ledgerMarker: CLUE_LEDGER_MARKER,
    kinds: CLUE_KINDS.map((k) => ({ kind: k.kind, label: k.label, why: k.why })),
    maxDigestChars: DEFAULT_MAX_DIGEST_CHARS,
    perKindLimit: { ...PER_KIND_LIMIT },
  };
}

/**
 * 证据锚点（纯数据、冻结）：本机制的注入接缝与门控，由测试逐条核验文件存在性与接线标记，
 * 防「锚点漂移被测试锁成正确」的旧坑（见 selfAuditRegistry.js #7 的教训）。
 */
const EVIDENCE_ANCHORS = Object.freeze({
  modules: Object.freeze(['clueVault']),
  gates: Object.freeze(['KHY_CLUE_VAULT', 'KHY_CLUE_VAULT_STAGE']),
  seams: Object.freeze([
    'src/services/contextCompressor.js',
    'src/services/agenticHarnessService.js',
    'src/services/selfProfile.js',
  ]),
  // 接线标记（逐接缝）：该接缝文件里**必须**出现的接线字符串，由测试逐条核验——
  // 防「整合时整条丢失」与「锚点漂移被锁成正确」两类旧坑（selfAuditRegistry.js #7 教训）。
  // ⚠ selfProfile.js 的 A 层注入以 registryPatches 交付（跨工作区边界）；落盘前该接缝
  // 判红是刻意设计——它就是「接线是否真发生」的机器判据，首绿即接线完成。
  seamMarkers: Object.freeze({
    'src/services/contextCompressor.js': Object.freeze(["require('./clueVault')"]),
    'src/services/agenticHarnessService.js': Object.freeze(["require('./clueVault')"]),
    'src/services/selfProfile.js': Object.freeze(["require('./clueVault')", 'formatForSystemPrompt']),
  }),
});

module.exports = {
  isEnabled,
  getStage,
  KHY_CLUE_VAULT_STAGE,
  CLUE_VAULT_MARKER,
  CLUE_LEDGER_MARKER,
  CLUE_LEDGER_TAG,
  CLUE_KINDS,
  PER_KIND_LIMIT,
  DEFAULT_MAX_DIGEST_CHARS,
  MAX_DIGEST_CHARS,
  extractClues,
  renderLedger,
  buildDigest,
  buildDigestWithCarry,
  formatForSystemPrompt,
  summarize,
  EVIDENCE_ANCHORS,
};
