#!/usr/bin/env node
/**
 * check-delegation-boundary.js — 委派边界守卫（PROCESS-004 的执行器）。
 *
 * 语义真源：docs/10_规范/其它规范/[DESIGN-PROCESS-001] 委派边界决策矩阵-第六通道外部智能体.md
 * 代码真源：services/backend/src/services/externalAgentDirective.js（闸门集合 + 准入判定）
 *
 * 守的是什么：不是「能不能委派」——这条链早已成熟；守的是**默认档是「自做」**这件事不被悄悄改回去。
 * 派生背景（2026-09-16）：khy-os 把活甩给 Claude Code / opencode 时没有规则可依，注入给模型的
 * 准入条件原文是「用户点名，**或某任务更适合交给一个完整的外部 agent 独立完成时**」——后半句是
 * 开放式授权，模型凭临场感觉判定「更适合」，于是活被莫名其妙派出去。本守卫把那句话钉成不能复活的
 * 死线，并把「三闸门集合」做成代码与规范之间的双向一致不变量。
 *
 * 检查项：
 *   1 delegation-ssot-missing     规范真源缺失 / 未以 RULES-REGISTRY 标记行声明本规则 / 缺三闸门表
 *   2 delegation-gate-drift       代码里的闸门 id+key 集合与规范 §3 表格不一致（双向可达）
 *   3 delegation-default-missing  注入文案缺少「默认自做」标记或三闸门
 *   4 delegation-open-ended-permission 注入文案复活开放式授权句式（黑名单命中即 error）
 *   5 delegation-nudge-gate       点名 nudge 未要求模型写出闸门标记
 *   6 delegation-boundary-not-called claudeDelegation 未经过准入判定就决定委派
 *   7 delegation-bypass-spawn     在白名单目录之外拉起外部 CLI（旁路 spawn，绕过闸门）
 *
 * Usage:
 *   node scripts/ci/check-delegation-boundary.js [--changed] [--list=<id>[,id...]]
 * Fixture root: KHY_DELEGATION_ROOT=/path/to/repo node scripts/ci/check-delegation-boundary.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = process.env.KHY_DELEGATION_ROOT
  ? path.resolve(process.env.KHY_DELEGATION_ROOT)
  : path.resolve(__dirname, '..', '..');

const RULE_ID = 'PROCESS-004';
const SSOT_REL = 'docs/10_规范/其它规范/[DESIGN-PROCESS-001] 委派边界决策矩阵-第六通道外部智能体.md';
const DIRECTIVE_REL = 'services/backend/src/services/externalAgentDirective.js';
const DELEGATION_REL = 'services/backend/src/tools/AgentTool/claudeDelegation.js';

// 开放式授权句式黑名单。这些都是「把准入权交给模型的临场感觉」的措辞，
// 一旦在任何注入给模型的文案里复活，本规则就形同虚设，故一律判 error。
const OPEN_ENDED_PHRASES = [
  '或某任务更适合交给',
  '更适合交给一个完整的外部 agent',
  '更适合交给外部',
  '更合适交给外部',
  'or when a task suits',
  'suits an external agent',
];

// 允许拉起外部 CLI 的位置（这些是执行链本身：适配器 / 顶层会话注册表 / 工具入口）。
// 除此之外任何地方出现外部 CLI 的进程拉起，都视为绕过闸门的旁路 spawn。
const SPAWN_ALLOWLIST = [
  'services/backend/src/services/gateway/adapters/',
  'services/backend/src/services/domain/agents/agentAssets/adapters/',
  'services/backend/src/services/domain/network/externalApps/',
  'services/backend/src/tools/AgentTool/',
  'services/backend/src/cli/',
];
// 外部 CLI 的字面标识符（与 externalAgentDirective.EXTERNAL_AGENTS 的 id 对齐）
const EXTERNAL_CLI_IDS = ['claude', 'codex', 'opencode'];
const SPAWN_CALL_RE = /\b(spawn|execFile|execFileSync|spawnSync|exec\b|child_process)\s*\(/;

const findings = [];

function add(id, file, message) {
  findings.push({ id, file, message, severity: 'error' });
}

function readText(rel) {
  const abs = path.join(repoRoot, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

function changedFiles() {
  try {
    const { execFileSync } = require('child_process');
    const set = new Set();
    for (const args of [
      ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'],
      ['ls-files', '--others', '--exclude-standard'],
    ]) {
      const out = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
      for (const line of out.split('\n')) {
        const rel = line.trim();
        if (rel) set.add(rel.replace(/\\/g, '/'));
      }
    }
    return set;
  } catch {
    return null; // 非 git 检出：不跳过，全量扫描
  }
}

/** 从代码里抽取 DELEGATION_GATES 的 id 与 key（正则解析，不 require 运行时模块）。 */
function codeGates(text) {
  const gates = [];
  const re = /\{\s*id:\s*'(G\d+)'\s*,\s*key:\s*'([a-z-]+)'/g;
  for (const m of String(text || '').matchAll(re)) {
    gates.push(`${m[1]}:${m[2]}`);
  }
  return gates;
}

/** 从规范正文抽取 §3 表格里的闸门行形如「| **G1 用户点名** | …」。 */
function specGates(text) {
  const gates = [];
  const re = /\*\*(G\d)\s+([^:*]+?)\*\*/g;
  for (const m of String(text || '').matchAll(re)) {
    gates.push(m[1]);
  }
  return [...new Set(gates)].sort();
}

// 生成物目录段名：守卫只审源码。这些目录由构建/打包产生，且大多被 .gitignore 覆盖，
// 对它们做「逐行文本匹配」等于拿编译产物当源码审计（噪音淹没真信号）。
const GENERATED_DIR_SEGMENTS = new Set(['bundled', 'dist', 'dist-ts', 'build', 'coverage', 'out', 'vendor']);

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
    // 生成物目录必须跳过：platform/khy_platform/bundled/ 被 .gitignore:137 覆盖，里面是
    // 打包后的单行压缩 bundle（~17MB / 13000+ 行）。对它逐行匹配 spawn 模式，会把
    // 「任意 JS 代码里出现 claude 字样」都报成委派旁路 —— 26 条 error 全部落在这一个
    // 文件上，人写的那份源码里一条都没有。守卫扫描面是源码，不是产物。
    if (GENERATED_DIR_SEGMENTS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (/\.(js|mjs|cjs|ts)$/.test(entry.name)) out.push(path.relative(repoRoot, abs).replace(/\\/g, '/'));
  }
}

// ── 1 + 2：真源可达与闸门一致性 ──────────────────────────────────────────────
function checkSsotAndGates() {
  const ssot = readText(SSOT_REL);
  if (ssot === null) {
    add('delegation-ssot-missing', SSOT_REL, `${RULE_ID} 的语义真源不存在，规则已失去可查最快的答案。`);
    return;
  }
  const markerRe = new RegExp(`RULES-REGISTRY:[^\\n]*${RULE_ID}\\b`);
  if (!markerRe.test(ssot)) {
    add('delegation-ssot-missing', SSOT_REL, `真源未以 RULES-REGISTRY 标记行声明 ${RULE_ID}，登记表与真源断链。`);
  }
  for (const marker of ['默认自做', '默认档是自做', '三闸门']) {
    if (!ssot.includes(marker)) {
      add('delegation-ssot-missing', SSOT_REL, `真源缺少关键表述「${marker}」，默认档无法被引用。`);
    }
  }

  const directive = readText(DIRECTIVE_REL);
  if (directive === null) {
    add('delegation-ssot-missing', DIRECTIVE_REL, `${RULE_ID} 的代码真源不存在。`);
    return;
  }

  const fromCode = codeGates(directive);
  const fromSpec = specGates(ssot);
  if (fromCode.length === 0) {
    add('delegation-gate-drift', DIRECTIVE_REL, '未能从 DELEGATION_GATES 解析出任何闸门；守卫口径需同步更新。');
  }
  if (fromSpec.length === 0) {
    add('delegation-gate-drift', SSOT_REL, '规范 §3 未列出任何闸门条目，无法与代码对齐。');
  }
  const codeIds = fromCode.map((g) => g.split(':')[0]).sort().join(',');
  const specIds = [...fromSpec].sort().join(',');
  if (codeIds && specIds && codeIds !== specIds) {
    add(
      'delegation-gate-drift',
      DIRECTIVE_REL,
      `三闸门集合发生漂移：代码为 [${codeIds}]，规范为 [${specIds}]。改一边必须同步另一边。`
    );
  }
}

// ── 3 + 4：注入文案必须教默认自做 + 三闸门，且不得复活开放式授权 ─────────────
function checkInjectedText() {
  const directive = readText(DIRECTIVE_REL);
  if (directive === null) return;

  if (!directive.includes("SELF_FIRST_MARKER = '默认自做'")) {
    add('delegation-default-missing', DIRECTIVE_REL, '缺失 SELF_FIRST_MARKER 常量（默认档标记），文案将无法被机器断言。');
  }
  for (const g of ['G1', 'G2', 'G3']) {
    if (!directive.includes(`${g}:`)) {
      add('delegation-default-missing', DIRECTIVE_REL, `DELEGATION_GATES 缺少闸门 ${g} 的 key 声明。`);
    }
  }
  const builder = directive.slice(directive.indexOf('function buildExternalAgentDirective'));
  if (builder && !builder.includes('SELF_FIRST_MARKER')) {
    add('delegation-default-missing', DIRECTIVE_REL, 'buildExternalAgentDirective 未注入默认档标记「默认自做」。');
  }
  if (builder && !builder.includes('DELEGATION_GATES')) {
    add('delegation-default-missing', DIRECTIVE_REL, 'buildExternalAgentDirective 未注入三闸门清单。');
  }
  if (builder && !/禁止/.test(builder.slice(0, 4000))) {
    add('delegation-default-missing', DIRECTIVE_REL, '注入文案未给出禁止项，模型只会学到「可以委派」。');
  }

  // 4：开放式授权黑名单——扫的是注入给模型的那一段（buildExternalAgentNudge 之前为止）
  const directiveSection = directive.slice(
    directive.indexOf('function buildExternalAgentDirective'),
    directive.indexOf('// ─── A2A Integration')
  );
  for (const phrase of OPEN_ENDED_PHRASES) {
    if (directiveSection.includes(phrase)) {
      add(
        'delegation-open-ended-permission',
        DIRECTIVE_REL,
        `注入文案出现开放式授权句式「${phrase}」——把准入权交回模型的临场感觉，正是本规则要根治的形态。`
      );
    }
  }
}

// ── 5：nudge 必须要求模型写出闸门标记 ────────────────────────────────────────
function checkNudgeGate() {
  const directive = readText(DIRECTIVE_REL);
  if (directive === null) return;
  const nudgeBody = directive.slice(
    directive.indexOf('function buildExternalAgentNudge'),
    directive.indexOf('function buildExternalAgentDirective')
  );
  if (!nudgeBody.includes('委派闸门')) {
    add('delegation-nudge-gate', DIRECTIVE_REL, '点名 nudge 未要求模型写出闸门标记；工具侧将无法区分「用户点名」与「模型自作主张」。');
  }
  if (!nudgeBody.includes('G1')) {
    add('delegation-nudge-gate', DIRECTIVE_REL, '点名 nudge 未声明闸门 G1。');
  }
}

// ── 6：委派决策必须经过准入判定 ──────────────────────────────────────────────
function checkBoundaryIsCalled() {
  const delegation = readText(DELEGATION_REL);
  if (delegation === null) {
    add('delegation-boundary-not-called', DELEGATION_REL, '委派决策模块不存在，无法断言其经过准入判定。');
    return;
  }
  if (!delegation.includes('externalAgentDirective')) {
    add('delegation-boundary-not-called', DELEGATION_REL, '委派决策未 require 委派边界的准入判定模块。');
  }
  if (!delegation.includes('evaluateDelegationAdmission')) {
    add('delegation-boundary-not-called', DELEGATION_REL, '委派决策未调用 evaluateDelegationAdmission()；启发式命中就会被放行。');
  }
  if (!/if\s*\(!admission\.allowed\)/.test(delegation)) {
    add('delegation-boundary-not-called', DELEGATION_REL, '未看到准入失败即拒绝委派的分支（fail-closed）。');
  }
}

// ── 7：外部 CLI 的进程拉起必须收敛在白名单目录 ───────────────────────────────
function checkBypassSpawn(changedOnly) {
  const roots = [
    path.join(repoRoot, 'services', 'backend', 'src'),
    path.join(repoRoot, 'platform'),
    path.join(repoRoot, 'extensions'),
  ];
  const files = [];
  for (const root of roots) walk(root, files);

  const changed = changedOnly ? changedFiles() : null;

  for (const rel of files) {
    if (changed && !changed.has(rel)) continue;
    if (rel === DIRECTIVE_REL) continue; // 认知层本身不 spawn
    if (SPAWN_ALLOWLIST.some((prefix) => rel.startsWith(prefix))) continue;
    const text = readText(rel);
    if (text === null) continue;
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      // 注释里的词不算 spawn 点：文档性提及（如「Windows 上 claude 是 .cmd shim」）
      // 常被同一行的 `spawn()` 字样带中，跳过注释行避免把注释误判为旁路 spawn。
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (isSuppressed(lines, index)) return;
      // 正则字面量里的 `.exec(` / `.test(` 不是进程拉起：`/^claude-(opus|sonnet)/i.exec(raw)`
      // 这类 slug 解析会在词位上命中 SPAWN_CALL_RE 的 `exec\b`，且同一行天然含 `claude`
      // 字样，于是被判成「旁路拉起 claude CLI」——纯误报。把正则字面量从判据输入里剥掉，
      // 只保留真实代码，才能让 `spawn('claude', …)` 这类真信号不被同构误报淹没。
      const code = stripRegexLiterals(line);
      if (!SPAWN_CALL_RE.test(code)) return;
      const lowered = code.toLowerCase();
      const hit = EXTERNAL_CLI_IDS.find((id) => new RegExp(`['"\`]${id}['"\`]|(^|[^a-z])${id}([^a-z]|$)`).test(lowered));
      if (!hit) return;
      add(
        'delegation-bypass-spawn',
        `${rel}:${index + 1}`,
        `白名单之外拉起外部 CLI「${hit}」：委派必须经 AgentTool/适配器入口并过三闸门，旁路 spawn 不受任何准入约束。确属豁免请在该行上方写 \`// khy-allow-${RULE_ID}: <理由>\`。`
      );
    });
  }
}

/**
 * 抑制判定（与 [DESIGN-ARCH-111] §5 同款方言）：`// khy-allow-PROCESS-004: <理由>`，
 * 写在该行本行行尾或紧邻上一行。**理由必填**——空理由不生效，任何抑制都必须能在评审里解释得通。
 */
function isSuppressed(lines, index) {
  const current = String(lines[index] || '');
  const prev = String(lines[index - 1] || '');
  for (const candidate of [current, prev]) {
    const m = /\/\/\s*khy-allow-PROCESS-004\s*:\s*(.*)$/.exec(candidate);
    if (m) return (m[1] || '').trim() !== '';
  }
  return false;
}

/**
 * 把 JS 源码行里的正则字面量整体替换为空格，只留下真实代码。
 *
 * 为什么需要：SPAWN_CALL_RE 里的 `exec\b` 会命中 `/…/i.exec(raw)` 这种**正则方法调用**，
 * 而 slug 解析行天然同时含 `claude` 字样（`/^claude-(opus|sonnet|haiku)-…/i.exec(raw)`），
 * 于是被判成「旁路拉起 claude CLI」。剥掉正则字面量即可让判据只认真实代码。
 *
 * 判据是「词位 + 前一个非空白字符」：`(`, `,`, `=`, `:`, `[`, `!`, `&`, `|`, `?`, `{`, `;`,
 * return 关键字等位置上的 `/` 才是正则起点；`a / b` 这类除法（前一字符是标识符/数字/`)`/`]`）
 * 不当作正则，避免把一个真正的 `spawn(...)` 之后的代码整体吞掉。
 * 不追求完整 JS 词法（斜杠歧义的完整解法需要真 parser），只求「本仓库源码行」上的稳定正确。
 */
function stripRegexLiterals(line) {
  let out = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === '/' && i + 1 < n && line[i + 1] === '/') {
      // 行注释：其后内容不参与判据
      out += ' ';
      i = n;
      break;
    }
    if (ch === '/' && i + 1 < n && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (ch === '/' && isRegexStart(out)) {
      // 找未转义的收尾斜杠（跳过字符类内的斜杠）
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const c = line[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        j += 1;
      }
      if (j >= n) {
        // 没有收尾斜杠 ⇒ 不是正则，按普通字符处理
        out += ch;
        i += 1;
        continue;
      }
      // 连同 flags 一起剥掉
      let k = j + 1;
      while (k < n && /[a-z]/i.test(line[k])) k += 1;
      out += ' '.repeat(k - i);
      i = k;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// 判断当前位置的 `/` 是否处于「正则起点」：看前一个有效字符。
// 前一字符是这些之一 ⇒ 前一个 token 已经结束，`/` 只能开启正则。
const REGEX_PREV_CHARS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '+', '-', '*', '%', '<', '>', '^', '~', ';', '{', '}']);
const REGEX_PREV_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await']);

function isRegexStart(prefix) {
  const text = String(prefix);
  let k = text.length - 1;
  while (k >= 0 && /\s/.test(text[k])) k -= 1;
  if (k < 0) return true; // 行首
  const prev = text[k];
  if (REGEX_PREV_CHARS.has(prev)) return true;
  if (/[A-Za-z_$]/.test(prev)) {
    let w = k;
    while (w >= 0 && /[A-Za-z0-9_$]/.test(text[w])) w -= 1;
    return REGEX_PREV_WORDS.has(text.slice(w + 1, k + 1));
  }
  return false;
}

function main() {
  const args = process.argv.slice(2);
  const changedOnly = args.includes('--changed');
  const listArg = args.find((a) => a.startsWith('--list='));

  checkSsotAndGates();
  checkInjectedText();
  checkNudgeGate();
  checkBoundaryIsCalled();
  checkBypassSpawn(changedOnly);

  const selected = listArg
    ? new Set(listArg.replace('--list=', '').split(',').map((s) => s.trim()).filter(Boolean))
    : null;
  const shown = findings.filter((f) => !selected || selected.has(f.id));

  if (shown.length === 0) {
    console.log(
      `委派边界检查通过：默认自做成立、三闸门未漂移、文案无开放式授权、委派必经准入、外部 CLI 无旁路 spawn。（${RULE_ID}）`
    );
    return 0;
  }
  for (const f of shown) {
    console.error(`[ERROR] ${RULE_ID} ${f.id} ${f.file}\n  ${f.message}`);
  }
  console.error(`\nSummary: ${shown.length} delegation-boundary error(s).`);
  return 1;
}

process.exitCode = main();
