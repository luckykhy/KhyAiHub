#!/usr/bin/env node
'use strict';

/**
 * check-no-emoji.js — 「终端与生成物面不得用彩色 emoji / 首字做头像或标记」的执行器。
 *
 * ## 裁决来源（用户 2026-09-28 原话）
 *
 *   「khyos中生成物和各个使用端口存在大量emojo，khyos中除了生成物用户明确说明需要
 *    emojo外不得使用emojo和首字做头像或标记」
 *
 * 四条同日的范围裁决界定了本守卫管什么：
 *   1) 禁用线 = **只禁彩色 emoji**，保留单色符号词表（✓ ✗ ⚠ ★ ❯ → ● ○ ◉ ▸ ◆ ─ …）；
 *   2) 范围 = 含 khyquant 全仓（`software/khyquant/` 一并）；
 *   3) 守卫 = 加，阶段 **S1 观察者档**（只记录不阻断）；
 *   4) 文档站 = **`.md` 源与 `.html` 孪生一并清理**（「文档站的html，md也需要清理」）。
 *      故判据覆盖 `*.md` / `*.html`，且**文档生成器**（`scripts/docs/**`）同样在管内 ——
 *      页面 chrome 的 emoji 是生成器注入的，只清 `.md` 清不掉 `.html`。
 *      `.md` 是**真源**、`.html` 是**构建产物**：清完 `.md` 与生成器后用
 *      `node scripts/docs/build_docs_site.js` 再生，不手改 `.html`。
 *      唯一例外面：`evidence/**`（著作权申报存证，按 `[DESIGN-IP-001]` C-MAT1
 *      「真实数据、不摆拍、不裁剪」不得事后改写），故 evidence 不参与判定。
 *   5) 同日补（用户实拍：文档站顶栏三个按钮仍是彩色）：清理**由守卫的发现驱动**，
 *      所以「扩展名白名单漏一类会画字的文件」＝ 画面上的 emoji 永远清不掉。实测盲区
 *      有三处：`.tsx/.jsx`（`apps/khyos-desktop` 整个 React 渲染层，图标写在
 *      `icon: '📂'` 这类字段里）、`.css`（`content: "✨"` 是渲染内容）、
 *      `docs/19_资产/site/*.{js,css}`（每一页都引用的浏览器侧资产，主题开关的字形
 *      就在这里）。三者已并入 `RUNTIME_SOURCE_RE`；随包压缩的 `*.min.js|css`
 *      （mermaid / hljs）属第三方再生件，与 `vendor/` 同档排除。
 *
 * ## 「彩色」不是形容词，是可查的 Unicode 属性
 *
 * 判据取 UTS #51 的 **Emoji_Presentation=Yes**：这些码位在支持的终端/浏览器里**默认**
 * 以彩色 emoji 字体绘制。加上两个强制彩色的组合符（VS16 U+FE0F、ZWJ U+200D，后者把
 * 若干码位粘成一个 emoji 序列），以及整个 U+1F000–U+1FAFF 附加平面（该区全部默认彩色）。
 * 反过来，`⚠ U+26A0`、`✓ U+2713`、`✗ U+2717`、`★ U+2605`、`❯ U+276F`、`→ U+2192`、
 * `● U+25CF` 等默认按文本绘制（Emoji_Presentation=No），因此**不在禁用之列** ——
 * 这正是裁决 1 留下的那一层。`⏱ U+23F1`、`⏸ U+23F8` 同理保留：它们 Emoji=Yes 但
 * 默认文本绘制，不是彩色 emoji。
 *
 * ## 三条判据
 *
 * | 判据 id | 管辖 | 为什么单列 |
 * |---|---|---|
 * * `colored-emoji` | 源码里直接写出的彩色 emoji 码位 | 主路径 |
 * | `escaped-emoji` | `U+XXXX` / `u{XXXXX}` 转义形与 `\uD8xx\uDCxx` 代理对转义 | **按字符扫不到的那条**：运行时照样画出彩色 emoji，而任何「找 emoji 字符」的脚本都会漏掉它。实测本仓清完字面形后仍余 46 处这种写法 |
 * | `initial-as-avatar` | 取词首字母当头像/标记（`charAt(0)`、`slice(0,1)`、`[0]` 进 avatar/icon/badge 字段） | 裁决原文把「首字做头像或标记」与 emoji 并列，须同守卫同档 |
 *
 * ## 门档语义（规则 8 / PROCESS-008 PP-1..PP-3）
 *
 * `STAGE` 是阶段唯一权威（`FEATURE-OWNERSHIP.json` 的 rollout 段只是镜像，
 * `check-rollout-stage.js` 会比对，漂移即报）。S1/S2 时 `severityFor()` 把三条判据
 * 一律降为 warning 且恒 exit 0；升到 S3 后 `colored-emoji` / `escaped-emoji` 才派生为
 * error 参与阻断。severity 只在 `severityFor()` 一处派生 —— 写死在判定处的话，S1 与 S3
 * 会跑出完全相同的输出，升阶后仍然不拦截而所有守卫全绿。
 *
 * ## 抑制
 *
 * 行内注释 `// khy-allow-no-emoji: <理由>`（**理由必填**，空理由不生效）用于「这里的
 * emoji 是被清除/匹配的对象，不是被展示的标记」这类正当用法：ANSI/输入清洗器、
 * 外部文本判词匹配、宽度与字簇测试夹具。路径级豁免见 `EXEMPT`，每条带 reason + until。
 *
 * ## 用法
 *
 *   node scripts/ci/check-no-emoji.js                # 全量（git ls-files）
 *   node scripts/ci/check-no-emoji.js --changed      # commit 快档（只看暂存集）
 *   node scripts/ci/check-no-emoji.js --worktree     # 工作区（含未暂存/未跟踪）
 *   node scripts/ci/check-no-emoji.js --files=a,b    # 指定文件
 *   node scripts/ci/check-no-emoji.js --json         # 机器可读
 *   node scripts/ci/check-no-emoji.js --list         # 列出豁免登记
 *   node scripts/ci/check-no-emoji.js --scenario=<名>  # 离线场景（不读盘）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

// ── 阶段常量：唯一权威 ──────────────────────────────────────────────────────
const STAGE = 'S1';

// ── 码位策略（本文件源码保持 ASCII，禁判据靠码位表表达）──────────────────────

/**
 * UTS #51 Emoji_Presentation=Yes 的 BMP 码位：默认彩色绘制。
 * 附加平面（0x1F000–0x1FAFF，含 0x1F1E6–0x1F1FF 区域指示符）整段默认彩色，
 * 由 `isBannedCodePoint()` 的区间判断覆盖，不必逐个登记。
 */
const BMP_EMOJI_PRESENTATION = new Set([
  0x231A, 0x231B, 0x23E9, 0x23EA, 0x23EB, 0x23EC, 0x23F0, 0x23F3,
  0x25FD, 0x25FE, 0x2614, 0x2615, 0x2648, 0x2649, 0x264A, 0x264B, 0x264C, 0x264D,
  0x264E, 0x264F, 0x2650, 0x2651, 0x2652, 0x2653, 0x267F, 0x2693, 0x26A1, 0x26AA,
  0x26AB, 0x26BD, 0x26BE, 0x26C4, 0x26C5, 0x26CE, 0x26D4, 0x26EA, 0x26F2, 0x26F3,
  0x26F5, 0x26FA, 0x26FD, 0x2705, 0x270A, 0x270B, 0x2728, 0x274C, 0x274E, 0x2753,
  0x2754, 0x2755, 0x2757, 0x2763, 0x2764, 0x2795, 0x2796, 0x2797, 0x27A1, 0x27B0,
  0x27BF, 0x2B1B, 0x2B1C, 0x2B50, 0x2B55,
]);

/** 强制彩色绘制的两个组合码位：VS16 把文本形转成 emoji 形，ZWJ 粘连成 emoji 序列。 */
const FORCERS = new Set([0xFE0F, 0x200D]);

function isBannedCodePoint(cp) {
  if (cp >= 0x1F000 && cp <= 0x1FAFF) return true;
  if (FORCERS.has(cp)) return true;
  return BMP_EMOJI_PRESENTATION.has(cp);
}

/** 单色词表（裁决 1 保留层）：仅用于报告里把禁用/保留两者说清楚，不参与判定。 */
const MONO_VOCABULARY = [
  0x26A0, 0x2713, 0x2714, 0x2715, 0x2717, 0x2605, 0x2606, 0x276F, 0x2731, 0x273B,
  0x2726, 0x2727, 0x2733, 0x2736, 0x273D, 0x279C, 0x2190, 0x2191, 0x2192, 0x2193,
  0x21D2, 0x25A0, 0x25A1, 0x25AA, 0x25AB, 0x25CB, 0x25CF, 0x25C9, 0x25D1, 0x25D3,
  0x2610, 0x2611, 0x2612, 0x2661, 0x2665, 0x2699, 0x26F6, 0x2315, 0x23BF, 0x22EF,
  0x2022, 0x2026, 0x00B7,
];

// ── 豁免登记（每条必须给 reason + until，到期未处理即 error 级自报）───────────
const EXEMPT = [
  {
    path: 'services/backend/src/buddy',
    prefix: true,
    reason: '桌面伴侣（buddy）的物种 emoji 是该功能的数据模型与画面主体，用户明确要求保留宠物形象；它不是终端状态标记。',
    until: '2027-03-31',
  },
  {
    path: 'extensions/scripts/khy-diagnostics',
    prefix: true,
    reason: '对抗式输入语料生成器（fuzzInputCorpus / fuzzFileCorpus）把 emoji 当作**被喂进解析器的输入数据**（😀 文件名、ZWJ 家庭、肤色修饰、2 万重复），与测试夹具同类：清掉它们等于削掉崩溃/挂死防护。',
    until: '2027-03-31',
  },
];

// ── 管辖范围 ────────────────────────────────────────────────────────────────

const RUNTIME_SOURCE_RE = [
  /^services\/.*\.(js|mjs|cjs|ts|tsx|jsx)$/,
  /^apps\/.*\.(js|mjs|cjs|ts|tsx|jsx|vue)$/,
  /^software\/.*\.(js|mjs|cjs|ts|tsx|jsx|vue|py)$/,
  /^platform\/.*\.(py|js|ts|tsx|vue)$/,
  /^extensions\/.*\.(js|mjs|cjs|ts|py)$/,
  /^kernel\/.*\.(py|js)$/,
  /^scripts\/.*\.(js|py)$/,
  /^tools\/.*\.(py|js)$/,
  // 样式表里的 `content: "✨"` 与 `list-style-type` 一样会**画在屏幕上**，
  // 与 js/ts 同属生成物面；行内 `/* 🔥 说明 */` 由 codePartOf 剥掉，不产生噪声。
  /^apps\/.*\.(css|scss|less)$/,
  /^services\/.*\.(css|scss|less)$/,
  /^software\/.*\.(css|scss|less)$/,
  /^platform\/.*\.(css|scss|less)$/,
  // 文档站的浏览器侧资产：`docs/19_资产/site/*.{js,css}` 被每一页 `.html` 引用，
  // 主题开关 / 朗读按钮 / 悬停星标的字形就是在这里长出来的（裁决 4 的第二个盲区）。
  /^docs\/19_资产\/site\/.*\.(js|css)$/,
];

/**
 * 测试与夹具不参与判定：宽度/字簇/粘贴清洗类用例必须把 emoji 当**输入**，
 * 禁掉它们等于削掉防护。与 check-agent-rules.js 对测试文件的处理一致。
 *
 * 第三方与再生物同样不判：`vendor/`、`dist/`、`out/`、`unpacked/` 是别家的构建产物或
 * 本仓可再生产物（`[DESIGN-IP-001]` C-X3 已把它们排除在登记材料之外），清理它们
 * 会在下次构建时被覆盖，且把外部代码的写法算进本仓记分板会制造无法修的噪声。
 * `*.min.js` / `*.min.css`（文档站的 mermaid、hljs 主题）同属此类：压流后无法逐行复核，
 * 且下次 vendor 更新即覆盖。
 *
 * 原 `/docs/` 排除项在裁决 4 之前用来把文档面整体挡在管外；现在文档面入管，
 * 该排除项必须摘掉 —— 否则 `scripts/docs/**`（把 emoji 注入每一页 `.html` 的生成器）
 * 与 `docs/**` 一起成为盲区。实测盲区里确有 23 个运行时文件 / 87 处彩色 emoji。
 */
const TESTISH_RE = /(\.test\.|\.spec\.|^tests\/|\/tests\/|\/__tests__\/|\/fixtures?\/|\.khy\/|\/vendor\/|\/node_modules\/|\/dist\/|\/out\/|\/unpacked\/|\.generated\.|\.min\.(js|css)$)/;

/**
 * 裁决 4 的唯一例外面：`evidence/` 是著作权申报存证，`entries/` 是构建产物根
 * （`[DESIGN-LAY-004]`），两者都不做事后改写 —— 前者按 C-MAT1「真实数据、不摆拍、
 * 不裁剪」，后者由 `rebuild` 命令再生。
 */
const OUT_OF_SCOPE_RE = /(^|\/)(evidence|entries)\//;

/** 文档面：`*.md` 是真源，`*.html` 是它的构建孪生。 */
const DOC_RE = /\.(md|html|htm)$/i;

/**
 * 登记表面：JSON 登记表不是代码，但它是**会被解码并渲染**的数据 ——
 * `RULES-REGISTRY.json` 经 `gen-rules-cards.js` 变成规则卡与文档站页面，
 * `.ai/hq/*.json` 经 `khy hq status` 打进终端。emoji 藏在这里等于藏在渲染链上游，
 * 因此同样入管（`escaped-emoji` 对 JSON 也成立：`\uXXXX` 在 `JSON.parse` 后就是真字形）。
 */
const DATA_SOURCE_RE = [
  /^docs\/10_规范\/registry\/.*\.json$/,
  /^docs\/14_维护者\/registry\/.*\.json$/,
  /^\.ai\/hq\/.*\.json$/,
  /^scripts\/ci\/.*\.json$/,
];

function normalize(rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function isRuntimeSource(rel) {
  return RUNTIME_SOURCE_RE.some((re) => re.test(rel));
}

function isDocSource(rel) {
  return DOC_RE.test(rel);
}

function isDataSource(rel) {
  return DATA_SOURCE_RE.some((re) => re.test(rel));
}

function isJudged(rel) {
  if (TESTISH_RE.test(rel) || OUT_OF_SCOPE_RE.test(rel)) return false;
  return isRuntimeSource(rel) || isDocSource(rel) || isDataSource(rel);
}

function exemptEntryFor(rel) {
  return EXEMPT.find((e) => (e.prefix ? rel === e.path || rel.startsWith(`${e.path}/`) : rel === e.path));
}

/** 内部 severity 只存小写规范形；渲染经 `labelOf()` 映射成定宽方言。 */
function severityFor(criterion, stage = STAGE) {
  // S1/S2 观察期：一律 warning，且不参与放行（PP-3）
  if (stage === 'S1' || stage === 'S2') return 'warning';
  // 首字母头像那条是启发式（要认字段名语境），S3 也只提示
  if (criterion === 'initial-as-avatar') return 'warning';
  return 'error';
}

function labelOf(severity) {
  return severity === 'error' ? '[ERROR]' : '[WARN ]';
}

// ── 判定（纯函数，零 I/O，便于离线单测）────────────────────────────────────

const COMMENT_PREFIXES = ['//', '#', '*', '/*', '<!--', ';;'];

function isCommentLine(line) {
  const t = String(line == null ? '' : line).trimStart();
  return COMMENT_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * 整行 HTML 注释（不渲染）：`.html` / `.md` 里跳过，其余行照常判定。
 * 注意 markdown **不能**复用 `isCommentLine()` —— 它的 `#` 前缀会把 `## 📖 目录`
 * 这类标题当成注释，而标题正是文档里 emoji 当节标记的主要落点。
 */
function isHtmlCommentLine(line) {
  return /^\s*<!--[\s\S]*-->\s*$/.test(String(line == null ? '' : line));
}

/**
 * 取一行的**代码部分**：行尾注释之后的内容不参与判定。
 *
 * 裁决管辖的是「生成物与使用端口」——用户看得见的画面。源码行尾注释里的 `// 🔥 新增：…`
 * 永远不会被渲染，把它计入记分板只会造出无法行动的噪声（实测仅 SimpleTradingInterface.js
 * 一个文件就贡献 36 条）。行首注释由 `isCommentLine()` 先一步跳过，这里补的是行尾。
 *
 * 引号感知：只在字符串字面量之外寻找注释起点。切错的失败方向是**漏报**（把代码当注释），
 * 不是误报；未闭合引号的行按「整行都是代码」处理，宁多报不漏报。
 */
function codePartOf(line, rel) {
  const text = String(line == null ? '' : line);
  const hashComment = /\.py$/.test(rel || '');
  let i = 0;
  let quote = '';
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = '';
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') return text.slice(0, i);
    if (c === '*' && text[i - 1] === '/') return text.slice(0, i - 1);
    if (hashComment && c === '#') return text.slice(0, i);
    i++;
  }
  return text;
}

/** `// khy-allow-no-emoji: 理由` —— 理由为空则不生效（无理由的抑制等于默认放行）。 */
const ALLOW_RE = /khy-allow-no-emoji:\s*(\S.*)$/;

function allowReason(line) {
  const m = ALLOW_RE.exec(line);
  if (!m) return '';
  // 文档面的抑制写法是 `<!-- khy-allow-no-emoji: 理由 -->`，去掉闭合定界符再判空。
  return String(m[1]).trim().replace(/-->$/, '').trim();
}

function glyphName(cp) {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** 字面形：逐码位扫，命中即记（同一行多个不同码位各报一条，行级才可行动）。 */
function literalHits(line) {
  const seen = new Map();
  for (const ch of line) {
    const cp = ch.codePointAt(0);
    if (isBannedCodePoint(cp)) seen.set(cp, (seen.get(cp) || 0) + 1);
  }
  return [...seen.entries()];
}

/**
 * 转义形：`\uXXXX`、`\u{XXXXX}`、以及 `\uD8xx\uDCxx` 代理对（写成两个转义时按字符
 * 扫不到，运行时却是彩色 emoji）。只认反斜杠小写 u；`\\u` 是转义后的反斜杠，跳过。
 */
const ESCAPE_RE = /\\u\{([0-9a-f]{4,6})\}|\\u([0-9a-f]{4})/gi;

function escapeHits(line) {
  const out = new Map();
  let m;
  ESCAPE_RE.lastIndex = 0;
  while ((m = ESCAPE_RE.exec(line))) {
    const raw = m[1] || m[2];
    const cp = parseInt(raw, 16);
    // 代理对：高代理后紧跟低代理转义 ⇒ 合成一个附加平面码位
    let merged = cp;
    if (cp >= 0xD800 && cp <= 0xDBFF) {
      const low = /\\u([dD][c-fC-F][0-9a-fA-F]{2})/.exec(line.slice(m.index + m[0].length));
      if (!low) continue;
      const lo = parseInt(low[1], 16);
      merged = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
      continue; //  lone low surrogate：属于上一个代理对的后半
    }
    if (isBannedCodePoint(merged)) {
      out.set(merged, { n: (out.get(merged) || {}).n ? out.get(merged).n + 1 : 1, text: m[0] });
    }
  }
  return [...out.entries()].map(([cp, v]) => ({ cp, text: v.text }));
}

/** 首字母做头像/标记的启发式：取词首字符的表达式，落在头像/图标/徽标语境里。 */
// 只认**显式取首字符**的字符串写法。裸 `[0]` 不认：本仓三处命中全为数组下标
// （touches[0]、stateUids[0]、盘符 d[0]），零真阳性，留下只会把记分板泡成噪声。
const INITIAL_EXPR_RE = /(?:\.charAt\(\s*0\s*\)|\.slice\(\s*0\s*,\s*1\s*\)|\.substring\(\s*0\s*,\s*1\s*\))/;
// 语境词只取「展示层身份标记」这一族。`initial` / `letter` 曾参与匹配，实测命中的是
// initialDistance 与 sysLetter（盘符），属数据字段，已剔除。
const INITIAL_CONTEXT_RE = /avatar|monogram|图标|头像|标记|徽标|\bicon\b|\bbadge\b|\.icon\s*[:=]/i;

function initialAvatarHit(line) {
  if (typeof line !== 'string') return false;
  if (!INITIAL_EXPR_RE.test(line)) return false;
  return INITIAL_CONTEXT_RE.test(line);
}

/**
 * 判定一个文件的内容。纯函数：同样输入必得同样输出，不读盘、不看时间。
 * @param {{path:string, content:string}} entry
 * @param {{stage?:string}} [opts]
 */
function evaluateFile(entry, opts = {}) {
  const stage = opts.stage || STAGE;
  const rel = normalize(entry.path);
  if (!isJudged(rel)) return [];
  if (exemptEntryFor(rel)) return [];

  const lines = String(entry.content == null ? '' : entry.content).split(/\r?\n/);
  const doc = isDocSource(rel);
  // 文档面与登记面都没有「行尾注释」概念：整行都是内容，不能按 // 切一刀。
  const plain = doc || isDataSource(rel);
  const out = [];
  const push = (criterion, line, message) => out.push({
    file: rel,
    line,
    criterion,
    severity: severityFor(criterion, stage),
    message,
  });

  let inFence = false;
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    if (!raw) return;
    // 围栏内的行**永远判定**：markdown 的 ``` 代码块会被 build_docs_site.js 转义成
    // `&lt;!-- ✅ 正确 --&gt;` 原样显示给读者，所以那里的「HTML 注释」是正文而不是注释。
    // 围栏外的整行 HTML 注释不渲染，才跳过。
    const insideFence = inFence;
    if (doc && /^\s*(?:```|~~~)/.test(raw)) inFence = !inFence;
    // 文档面 / 登记面：整行都是内容，没有行尾注释可切；
    // 源码面：沿用「注释行不判」的既有口径。
    if (plain ? (!insideFence && isHtmlCommentLine(raw)) : isCommentLine(raw)) return;
    const reason = allowReason(raw);
    if (reason) return;
    const code = plain ? raw : codePartOf(raw, rel);

    for (const [cp, n] of literalHits(code)) {
      push('colored-emoji', lineNo,
        `彩色 emoji ${glyphName(cp)}（${String.fromCodePoint(cp)}）${n > 1 ? `×${n}` : ''} 不得用作标记或头像；改用单色词表（✓ ✗ ⚠ ★ ❯ → ● ○ ◉ ▸ ◆），或加 // khy-allow-no-emoji: <理由>`);
    }
    // 转义写法只对**可执行源码**成立：`.js`/`.py`/`.vue` 里的 `\u200d` 会被解析成 ZWJ，
    // 运行时真的画出彩色 emoji。文档（`.md`/`.html`）不执行，`\u200d` 就是字面的
    // 反斜杠-u-200d，在页面上渲染成这串字符本身，不驱动任何绘制 —— 对它报 escaped-emoji
    // 是假阳性：实测文档面命中处全是引用 sanitizer 字符类 `[\u200b-\u200f…]` 的技术正文。
    if (!doc) {
      for (const h of escapeHits(code)) {
        push('escaped-emoji', lineNo,
          `转义写法 ${h.text} 解析为彩色 emoji ${glyphName(h.cp)}，按字符扫描看不见但运行时照样彩色绘制`);
      }
    }
    // 首字母头像：字面 emoji 已命中的行不再叠报（同一处一条 finding 够行动）
    if (!out.some((f) => f.line === lineNo) && initialAvatarHit(raw)) {
      push('initial-as-avatar', lineNo,
        `取词首字符做头像/标记的写法（裁决把「首字做头像或标记」与 emoji 并列）；若这是数据字段而非展示层，加 // khy-allow-no-emoji: <理由>`);
    }
  });
  return out;
}

function evaluate(entries, opts = {}) {
  const findings = [];
  for (const e of entries) findings.push(...evaluateFile(e, opts));
  return findings;
}

function summarize(findings) {
  const s = { errors: 0, warnings: 0, byCriterion: {} };
  for (const f of findings) {
    if (f.severity === 'error') s.errors += 1;
    else s.warnings += 1;
    s.byCriterion[f.criterion] = (s.byCriterion[f.criterion] || 0) + 1;
  }
  return s;
}

// ── 采集 ────────────────────────────────────────────────────────────────────

function gitLines(args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1e8,
    }).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 解析 `--files=`：必须区分「传了但为空」与「没传」——空值会静默落到真实暂存集，
 * 而本仓暂存集常有数千项，视角会整个错位。
 */
function filesArgOrNull(argv) {
  const hit = argv.find((a) => a.startsWith('--files='));
  return hit ? hit.slice('--files='.length) : null;
}

function collect(argv) {
  const explicit = filesArgOrNull(argv);
  let candidates;
  if (explicit !== null) {
    candidates = explicit.split(',').map((s) => normalize(s.trim())).filter(Boolean);
  } else if (argv.includes('--changed')) {
    candidates = gitLines(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  } else if (argv.includes('--worktree')) {
    candidates = gitLines(['ls-files', '-m', '-o', '--exclude-standard']).concat(gitLines(['ls-files', '-c']));
  } else {
    candidates = gitLines(['ls-files']);
  }
  const wanted = [...new Set(candidates)].filter(isJudged);
  const entries = [];
  for (const rel of wanted) {
    try {
      entries.push({ path: rel, content: fs.readFileSync(path.join(ROOT, rel), 'utf8') });
    } catch {
      /* 已删除或不可读：跳过，不阻断 */
    }
  }
  const mode = explicit !== null ? 'files'
    : argv.includes('--changed') ? 'changed'
      : argv.includes('--worktree') ? 'worktree' : 'full';
  return { entries, scanned: wanted.length, mode };
}

// ── 离线场景（人工复核与单测复现用，不读盘）─────────────────────────────────

const SCENARIOS = {
  clean: [
    { path: 'services/backend/src/cli/ui.js', content: 'const S = { ok: "\u2713", bad: "\u2717", warn: "\u26A0", dot: "\u25CF", arrow: "\u2192" };\n' },
  ],
  'literal-emoji': [
    { path: 'services/backend/src/cli/ui.js', content: 'const head = "\uD83D\uDE80 启动";\n' },
  ],
  'escaped-emoji': [
    { path: 'services/backend/src/bridge/mobilePage.js', content: 'const logo = "\\uD83D\\uDD10";\nconst bar = "\\u{1F4CA} 本次";\n' },
  ],
  'vs16-forced': [
    { path: 'services/backend/src/cli/formatters.js', content: 'print(" \u26A0\uFE0F 需要授权");\n' },
  ],
  'suppressed-and-comment': [
    { path: 'services/backend/src/cli/sanitizer.js', content: '// 历史文案里有 🚨 需要一并剥掉\nconst re = /\uD83D\uDEA8/; // khy-allow-no-emoji: 剥离外部粘贴文本里的告警标记\n' },
  ],
  'initial-avatar': [
    { path: 'apps/ai-frontend/src/components/Avatar.vue', content: 'const avatarChar = props.name.charAt(0).toUpperCase();\n' },
  ],
  // 裁决 4（文档面）：markdown 标题不是注释、HTML 整行注释不渲染、抑制用 <!-- --> 形。
  'docs-surface': [
    { path: 'docs/02_CONCEPTS_概念入门/CONCEPT/x.md', content: '## 📖 目录\n' },
    { path: 'docs/02_CONCEPTS_概念入门/CONCEPT/x.html', content: '<!-- 图例 🚀 表示加速 -->\n<p>🚀 快速开始</p>\n' },
    { path: 'docs/README.md', content: '❌ 旧写法 <!-- khy-allow-no-emoji: 本节演示被剥掉的粘贴 emoji，须原样保留 -->\n' },
  ],
  // 裁决 5（画面面）：图标字段与 CSS content 都是**画出来的**，CSS 注释不是。
  'ui-surface': [
    { path: 'apps/khyos-desktop/src/renderer/components/layout/Sidebar.tsx', content: "const NAV = [{ id: 'git', icon: '🔀', label: 'Git' }];\n" },
    { path: 'docs/19_资产/site/docs-site.css', content: '.card::after { content: "✨"; }\n' },
    { path: 'apps/ai-frontend/src/styles/a.css', content: '.card { color: red; /* ✨ 装饰 */ }\n' },
  ],
};

// ── 渲染与入口 ──────────────────────────────────────────────────────────────

function render(findings, meta) {
  const L = [];
  L.push('=== 终端与生成物面不得用彩色 emoji / 首字做头像或标记 ===');
  L.push(`阶段 ${STAGE}（观察期，只记录不阻断）｜模式 ${meta.mode}｜扫描 ${meta.scanned} 个文件`);
  L.push('');
  if (!findings.length) {
    L.push('OK 未发现彩色 emoji 字面/转义写法；单色词表（✓ ✗ ⚠ ★ ❯ → ●）不受影响。');
    return L.join('\n');
  }
  for (const f of findings) {
    L.push(`${labelOf(f.severity)} ${f.criterion} ${f.file}:${f.line}`);
    L.push(`  ${f.message}`);
  }
  return L.join('\n');
}

function listExemptions() {
  console.log('豁免登记（每条带理由与复核到期日）：');
  if (!EXEMPT.length) {
    console.log('  （无）');
    return 0;
  }
  for (const e of EXEMPT) {
    console.log(`  ${e.path}${e.prefix ? '/**' : ''}`);
    console.log(`    理由: ${e.reason}`);
    console.log(`    复核到期: ${e.until}`);
  }
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--list')) return listExemptions();

  const scenarioArg = argv.find((a) => a.startsWith('--scenario='));
  let entries;
  let meta;
  if (scenarioArg) {
    const name = scenarioArg.slice('--scenario='.length);
    const preset = SCENARIOS[name];
    if (!preset) {
      console.error(`未知场景 ${name}；可用：${Object.keys(SCENARIOS).join(', ')}`);
      return 2;
    }
    entries = preset;
    meta = { mode: `scenario:${name}`, scanned: preset.length };
  } else {
    const c = collect(argv);
    entries = c.entries;
    meta = { mode: c.mode, scanned: c.scanned };
  }

  const findings = evaluate(entries, { stage: STAGE });
  const s = summarize(findings);

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ stage: STAGE, meta, findings, summary: s }, null, 2));
    console.log(`\nSummary: ${s.errors} error(s), ${s.warnings} warning(s).`);
    return s.errors > 0 ? 1 : 0;
  }

  console.log(render(findings, meta));
  console.log('');
  if (EXEMPT.length) console.log(`（豁免登记 ${EXEMPT.length} 条，见 --list）`);
  console.log(`Summary: ${s.errors} error(s), ${s.warnings} warning(s).`);
  console.log(`按判据: ${Object.entries(s.byCriterion).map(([k, v]) => `${k}=${v}`).join(', ') || '无'}`);

  // S1 恒 exit 0；升 S3 后由 severityFor 派生 error 才阻断
  return s.errors > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  STAGE,
  EXEMPT,
  SCENARIOS,
  MONO_VOCABULARY,
  BMP_EMOJI_PRESENTATION,
  isBannedCodePoint,
  isRuntimeSource,
  isDocSource,
  isDataSource,
  isJudged,
  isCommentLine,
  isHtmlCommentLine,
  codePartOf,
  allowReason,
  literalHits,
  escapeHits,
  initialAvatarHit,
  exemptEntryFor,
  severityFor,
  labelOf,
  evaluateFile,
  evaluate,
  summarize,
  normalize,
};
