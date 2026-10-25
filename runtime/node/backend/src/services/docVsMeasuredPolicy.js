'use strict';

/**
 * docVsMeasuredPolicy.js — 「文档 vs 实测」纪律的确定性单一真源（纯叶子：零 IO、确定性、绝不抛、可单测）。
 *
 * 已认领的行为缺陷：被问起仓内事实时，模型倾向引述文档/注释里的说法，而不真的跑一遍、读一遍
 * 源码去核实 —— 文档是**二手声明**，代码与命令输出才是事实本身。仓内已有一族防「自称已核验」的
 * 机制（selfAuditRegistry 的证据锚点 + selfEvidenceVerifier 运行时核验），但那是**自审面**专用；
 * 通用「引述前先自证」这条纪律在写本品时确实没有（2026-10-13 复核更正：同期姊妹机制
 * confidenceCalibration 的叶子契约里也有一条通用纪律注入，但它补的是另一格——见下节分工；本行
 * 原写「没有任何一条通用纪律被注入给模型」已不成立，据实改口）。
 *
 * 与姊妹机制 confidenceCalibration 的分工（同期接线、同为 S1 观察器、其 A 层注入按其叶子契约走
 * selfProfile 接缝、其收尾观察器在 agenticHarnessService）：那边判**说话方式**（零工具轮次的笃定
 * 措辞 / 自称已核验），这边判**引述的路径**（草稿引了仓内路径而本回合无任何工具动作碰过）；判据
 * 不同、不重复判。两套档位一一对应、措辞不同但相容——实测＝本轮已验证；读到＝本轮已验证(源码)；
 * 引述＝训练知识/未验证。两块注入若日后合并为一块，改 selfProfile 接缝一处即可，两叶子的判定逻辑
 * 与测试都不动（合并是人的决定；登记侧由 FEATURE-OWNERSHIP 两条目互引）。
 *
 * 本叶子做两件事，都确定性、零 IO、可测：
 *   1) formatDisciplineForSystemPrompt — A 层注入几行（selfProfile 接缝消费）：证据三档
 *      （实测＞读到＞引述）+ 仓内三个最便宜的既有取证入口（不新增任何命令）。
 *   2) observeConclusion — 结论期观察器（S1 观察者，只记录不阻断）：模型收尾且本回合**零工具
 *      调用**时，若草稿引述了仓内路径（docs/… 等）而没有任何工具调用碰过它，产出观察记录；由
 *      toolUseLoopCore 落盘。样本主通道是既有 toolLoopJournal（默认开、best-effort，event
 *      'doc-grounding'）——只用 breadcrumb 的话 KHY_LOOP_DEBUG 未设即零样本、S1 永远攒不满
 *      （2026-10-13 复核判定 mustFix 后补接）；breadcrumb 为叠加诊断通道（KHY_LOOP_DEBUG 开时
 *      落文件）。本函数不改流程、不生成 nudge、绝不抛。
 *
 * 为什么是「引述路径未取证」而不是「引述了文档」：文档链接本身无罪，有罪的是**把未核实的
 * 引述当证据交付**。判据因此落在「本回合有没有对这条路径做过任何工具动作」，可确定性判定，
 * 不依赖对文风的猜测。S1 允许误报，样本够 200 条再谈升阶（PROCESS-008）。
 *
 * 契约：零 IO、确定性、绝不抛。门控 KHY_DOC_VS_MEASURED（默认开，仅显式 0/false/off/no 关；
 * 关闭后 format 返 ''、observe 返 observed:false → 两个接缝逐字节回退到「不注入、不观察」）。
 * 父门控经 flagRegistry 集中判定（CANON 词表），fail-soft 回退本地 CANON。
 *
 * 阶段：S1 观察者（见 STAGE 常量与 FEATURE-OWNERSHIP.json rollout.mechanisms）。本叶子不自证
 * 「已修复」——注入是否真的改变行为，由样本与事后核验说话。
 *
 * @module services/docVsMeasuredPolicy
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 本机制的落地阶段（check-rollout-stage.js 与 FEATURE-OWNERSHIP.executorStage 比对用）。 */
const STAGE = 'S1';

/**
 * 门控判定。优先走 flagRegistry（集中优先级 + dogfood），不可用时回退本地 CANON 词表。
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
      return reg.isFlagEnabled('KHY_DOC_VS_MEASURED', e);
    }
  } catch {
    /* 注册表不可用 → 本地回退 */
  }
  const v = e.KHY_DOC_VS_MEASURED;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

// 系统提示块首行标记（便于接缝去重 / 测试定位）。
const DOC_VS_MEASURED_MARKER = '## 文档 vs 实测';

/**
 * 证据三档（强 → 弱）。key 是机读档位，label 是注入文本用的中文档位名，rule 是档位定义。
 * 冻结每条 + 数组（纯叶子对外只读；注入文本由本表派生，避免第二份措辞漂移）。
 * @type {ReadonlyArray<{key:string,label:string,rule:string}>}
 */
const EVIDENCE_TIERS = Object.freeze([
  Object.freeze({ key: 'measured', label: '实测', rule: '本会话跑过命令/测试并看到输出' }),
  Object.freeze({
    key: 'source_read',
    label: '读到',
    rule: '本会话 Read/Grep 到源码并给出 file:line',
  }),
  Object.freeze({
    key: 'doc_cited',
    label: '引述',
    rule: '仅文档/注释所述 → 如实标注「文档陈述·未实测」',
  }),
]);

/**
 * 仓内最便宜的取证入口（全部为既有面，本机制不新增命令、不新增别名）。
 * 冻结每条 + 数组。
 * @type {ReadonlyArray<{probe:string,what:string}>}
 */
const PROBE_MENU = Object.freeze([
  Object.freeze({ probe: 'khy docs check', what: '文档与源码新鲜度自检' }),
  Object.freeze({
    probe: 'KhySelf(action:self_audit_verify)',
    what: '自审证据逐项运行时核验',
  }),
  Object.freeze({
    probe: 'KhySelf(action:location)+Read/Grep',
    what: '取自身源码绝对路径后现场查验',
  }),
]);

/**
 * 本机制自身的证据锚点（声明式纯数据，语义：注入块里每一句「可取证」都指向真实存在的模块/
 * 门控）。删掉任一被引用的模块、或关掉任一被引用的门控，核验即翻红 —— 由既有的
 * selfEvidenceVerifier（唯一核验实现，本叶子不自己实现第二套，对齐 RUNTIME-010 A2-5）
 * 在测试 / 旁路取证时现场核验。selfAuditRegistry 的 #8 条目直接复用这一份（单一真源）。
 */
const EVIDENCE_ANCHORS = Object.freeze({
  modules: Object.freeze([
    'docVsMeasuredPolicy',
    'selfEvidenceVerifier',
    'selfLocation',
    '../tools/KhySelfTool/index',
    'domain/docs/docsFreshness/docsFreshnessRunner',
    'selfAuditVerifier',
  ]),
  gates: Object.freeze(['KHY_DOC_VS_MEASURED', 'KHY_AUDIT_DYNAMIC_VERIFY']),
});

/**
 * 「文档 vs 实测」纪律块（A 层）。注入几行：证据三档 + 三个最便宜的取证入口。
 * 门控关 / 无法产出 → ''（接缝逐字节回退）。
 * @param {object} [opts] {env}
 * @returns {string}
 */
function formatDisciplineForSystemPrompt(opts = {}) {
  const o = opts || {};
  if (!isEnabled(o.env)) {
    return '';
  }
  const tierLine = EVIDENCE_TIERS.map((t) => `${t.label}＝${t.rule}`).join('；');
  const probeLine = PROBE_MENU.map((p) => `${p.probe}（${p.what}）`).join(' · ');
  return [
    `${DOC_VS_MEASURED_MARKER}（引述前先自证，勿把文档当事实）`,
    '仓内文档/注释/README 是二手声明，不是事实本身：回答依赖的每条可核实断言先跑或读、再下结论；只引述不核实必须标注「文档陈述·未实测」。',
    `证据三档（强→弱）：${tierLine}。`,
    `最便宜的取证入口：${probeLine}。`,
    '被问「你怎么知道的」答出档位 + 输出或 file:line；可取证的现场取证，不许把文档链接当证据。',
  ].join('\n');
}

// ── 结论期观察器（S1 只记录）─────────────────────────────────────────────

// 仓内顶层目录白名单（引述路径的识别范围；保守起步：命中即记，S1 允许误报，靠样本调）。
const _REPO_DIRS = ['docs', 'evidence', 'scripts', 'runtime', 'delivery', 'apps', 'works'];
// 长扩展名排在短前面 + 尾部词界断言：否则 `DIST-SYNC.json` 会被 `js` 择先匹配截成 `.js`。
const _EXT_RE =
  '\\.(?:markdown|json|tsx|ya?ml|toml|cjs|mjs|md|js|ts|vue|py|txt|sh|bat|cmd|ps1)(?![A-Za-z0-9])';
// 正文 token 形态：目录前缀 + 非空白串 + 扩展名（扩展名收尾，避免吞掉整句话）。
const _TOKEN_RE = new RegExp(
  '(?:^|[\\s`"\'（(【「《>=])((?:' +
    _REPO_DIRS.join('|') +
    ')[/\\\\][^\\s`"\'）)】」》<>，。；;、]+?' +
    _EXT_RE +
    ')',
  'gi'
);
// 反引号内的候选（容忍含空格的文档名，例如 `[DESIGN-ARCH-118] HQ 能力吸收….md`）。
const _TICK_RE = /`([^`\n]{1,200})`/g;
const _LOOSE_IN_TICK_RE = new RegExp(
  '((?:' + _REPO_DIRS.join('|') + ')[/\\\\][^\\n]{0,160}?' + _EXT_RE + ')',
  'gi'
);
// 取证类工具名（归一化后比对；与 toolUseLoopCore 的实质调用表同族，另含 read/grep/glob）。
const _EVIDENCE_TOOL_RE =
  /^(bash|shell|shellcommand|runcommand|exec|execcommand|runshell|read|readfile|grep|search|glob|find|websearch|webfetch|web|fetch|fetchurl|universalsearch)$/;

/** 工具名归一化（与 toolUseLoopCore._normTool 同款：小写 + 去空白/下划线/连字符）。 */
function _normTool(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s_-]/g, '');
}

/** 归一化候选路径（转斜杠、去前导 ./、剥首尾引号/括号/标点）；不合形状 → ''。纯字符串。 */
function _normalizePath(raw) {
  let p = String(raw == null ? '' : raw).trim();
  p = p.replace(/^[`"'（(【「《]+/, '').replace(/[`"'）)】」》]+$/, '');
  p = p.replace(/\\/g, '/').replace(/^\.\//, '');
  p = p.replace(/[，。；;、,]+$/, '');
  if (!p || p.length > 200) {
    return '';
  }
  const firstSlash = p.indexOf('/');
  if (firstSlash <= 0) {
    return '';
  }
  const head = p.slice(0, firstSlash).toLowerCase();
  if (!_REPO_DIRS.includes(head)) {
    return '';
  }
  if (!new RegExp(_EXT_RE + '$', 'i').test(p)) {
    return '';
  }
  return p;
}

/**
 * 从草稿中提取「仓内路径」引述（去重、保序、cap 8）。纯函数，绝不抛。
 * 覆盖两种书写：反引号包裹（容忍空格）与正文 token 形态。
 * @param {string} draft
 * @returns {string[]}
 */
function extractCitedPaths(draft) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    try {
      const p = _normalizePath(raw);
      if (!p || seen.has(p) || out.length >= 8) {
        return;
      }
      seen.add(p);
      out.push(p);
    } catch {
      /* 单个候选失败不影响其余（fail-soft） */
    }
  };
  const text = String(draft == null ? '' : draft);
  if (!text) {
    return out;
  }
  _TICK_RE.lastIndex = 0;
  let m;
  while ((m = _TICK_RE.exec(text)) !== null) {
    _LOOSE_IN_TICK_RE.lastIndex = 0;
    let g;
    while ((g = _LOOSE_IN_TICK_RE.exec(m[1])) !== null) {
      push(g[1]);
    }
  }
  const rest = text.replace(_TICK_RE, ' ');
  _TOKEN_RE.lastIndex = 0;
  while ((m = _TOKEN_RE.exec(rest)) !== null) {
    push(m[1]);
  }
  return out;
}

/** 本回合工具调用的「动作面」blob（tool + params，归一化斜杠；不含结果，避免输出提及冒充取证）。 */
function _evidenceBlob(toolCallLog) {
  const parts = [];
  for (const t of Array.isArray(toolCallLog) ? toolCallLog : []) {
    if (!t || typeof t !== 'object') {
      continue;
    }
    let params = '';
    try {
      params = JSON.stringify(t.params || {});
    } catch {
      params = '';
    }
    parts.push(`${String(t.tool || '')} ${params.slice(0, 2000)}`.replace(/\\/g, '/'));
  }
  return parts.join('\n');
}

/** 该路径本回合是否被工具动作碰过：全路径命中，或长基名命中（短基名易误碰，故 ≥10 字符）。 */
function _wasTouched(normPath, blob) {
  if (!normPath || !blob) {
    return false;
  }
  if (blob.includes(normPath)) {
    return true;
  }
  const base = normPath.slice(normPath.lastIndexOf('/') + 1);
  return base.length >= 10 && blob.includes(base);
}

/**
 * 结论期观察（S1 只记录）：草稿引述了仓内路径、而本回合没有任何工具调用碰过它 → observed:true。
 * 纯函数、零 IO、绝不抛；门控关 → observed:false。调用方（toolUseLoopCore）只把 observed:true
 * 记进既有 breadcrumb 通道，绝不 nudge / continue / 改写输出。
 * @param {{draft?:string, toolCallLog?:Array}} input
 * @param {object} [opts] {env}
 * @returns {{observed:boolean, reason:string, cited:string[], unopened:string[], evidenceCalls:number, toolCalls:number}}
 */
function observeConclusion(input, opts = {}) {
  const fail = (reason) => ({
    observed: false,
    reason,
    cited: [],
    unopened: [],
    evidenceCalls: 0,
    toolCalls: 0,
  });
  try {
    const i = input && typeof input === 'object' ? input : {};
    const o = opts && typeof opts === 'object' ? opts : {};
    if (!isEnabled(o.env)) {
      return fail('门控 KHY_DOC_VS_MEASURED 关');
    }
    const draft = typeof i.draft === 'string' ? i.draft : '';
    if (!draft.trim()) {
      return fail('无草稿可观察');
    }
    const cited = extractCitedPaths(draft);
    if (cited.length === 0) {
      return fail('未引述仓内路径');
    }
    const log = Array.isArray(i.toolCallLog) ? i.toolCallLog : [];
    const blob = _evidenceBlob(log);
    const unopened = cited.filter((p) => !_wasTouched(p, blob));
    const evidenceCalls = log.filter((t) => t && _EVIDENCE_TOOL_RE.test(_normTool(t.tool))).length;
    if (unopened.length === 0) {
      return {
        observed: false,
        reason: '引述路径均在本回合工具调用中出现',
        cited,
        unopened,
        evidenceCalls,
        toolCalls: log.length,
      };
    }
    return {
      observed: true,
      reason: `引述仓内路径未在本回合取证:${unopened.join('、')}`,
      cited,
      unopened,
      evidenceCalls,
      toolCalls: log.length,
    };
  } catch {
    // Fail-soft：观察器任何意外 → 诚实 observed:false，绝不抛。
    return fail('观察过程异常(fail-soft)');
  }
}

module.exports = {
  isEnabled,
  STAGE,
  DOC_VS_MEASURED_MARKER,
  EVIDENCE_TIERS,
  PROBE_MENU,
  EVIDENCE_ANCHORS,
  formatDisciplineForSystemPrompt,
  extractCitedPaths,
  observeConclusion,
};
