#!/usr/bin/env node
/**
 * 采集「开发过程中的贡献」度量 —— 软著登记底档的证据来源。
 *
 * 只读仓库与本机状态目录，把**可复核的原始计数**落成 JSON，供图片渲染与
 * 人工对账使用。任何数字都必须能用注释里给出的命令复算，不做转述。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO, 'evidence', '04_机器可读');

const FEEDBACK_DIR = path.join(REPO, '.khy', 'feedback');
const WORKBUDDY_DIR = path.join(REPO, '.workbuddy', 'memory');
const HQ_DIR = path.join(REPO, '.ai', 'hq');
const KERNEL_DIR = path.join(REPO, 'kernel');
const DOCS_DIR = path.join(REPO, 'docs');

function log(msg) {
  process.stdout.write(msg + '\n');
}

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

// git() 在 HEAD 未出生（当前分支尚无提交，例如历史重建进行中）时会直接抛，
// 导致整个采集器崩掉。这里给 git 历史类命令一个**如实降级**：HEAD → main → --all，
// 并把实际使用的 ref 写进输出。宁可换口径并声明，不可崩溃或悄悄给出 0。
function refAlive(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', ref], { cwd: REPO, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function resolveScope() {
  if (refAlive('HEAD')) return { ref: 'HEAD', args: [] };
  if (refAlive('main')) return { ref: 'main', args: ['main'] };
  return { ref: null, args: ['--all'] };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

/** 递归列出文件（跳过 node_modules / .git / dist 等噪声目录）。 */
function walk(dir, skip) {
  const out = [];
  const SKIP = skip || new Set(['node_modules', '.git', 'dist', 'dist-electron', 'build', 'out', 'unpacked', '.khy', '.khyos', '.khyquant']);
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP.has(ent.name)) stack.push(full);
      } else if (ent.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function countLines(file) {
  try {
    const buf = fs.readFileSync(file);
    if (!buf.length) return 0;
    let n = 1;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
    if (buf[buf.length - 1] === 0x0a) n--;
    return n;
  } catch (e) {
    return 0;
  }
}

// ── 1. git 历史 ────────────────────────────────────────────────────────────
function collectGit() {
  const scope = resolveScope();
  const sc = scope.args;
  const authorsRaw = git(['log', ...sc, '--format=%an <%ae>']).trim().split('\n').filter(Boolean);
  const authors = {};
  for (const a of authorsRaw) authors[a] = (authors[a] || 0) + 1;

  const dates = git(['log', ...sc, '--format=%ad', '--date=format:%Y-%m']).trim().split('\n').filter(Boolean);
  const byMonth = {};
  for (const m of dates) byMonth[m] = (byMonth[m] || 0) + 1;

  const days = git(['log', ...sc, '--format=%ad', '--date=short']).trim().split('\n').filter(Boolean);
  const firstDay = days[days.length - 1];
  const lastDay = days[0];

  // numstat 总量：可复算命令 `git log --numstat --format=`
  const numstat = git(['log', ...sc, '--numstat', '--format=']).split('\n');
  let added = 0;
  let removed = 0;
  for (const line of numstat) {
    const p = line.split('\t');
    if (p.length < 3) continue;
    if (/^\d+$/.test(p[0])) added += Number(p[0]);
    if (/^\d+$/.test(p[1])) removed += Number(p[1]);
  }

  const trackedFiles = Number(git(['ls-files']).split('\n').filter(Boolean).length) || 0;

  // 全分支口径单独列：本仓 main 是被重建过的短历史（数十条），而全部 36 个分支保留
  // 完整开发历史（近千条）。两个口径混用会让数字对不上，故并列登记并说明。
  const allCount = Number(git(['rev-list', '--count', '--all']).trim()) || 0;
  const allMonthsRaw = git(['log', '--all', '--format=%ad', '--date=format:%Y-%m']).trim().split('\n').filter(Boolean);
  const allByMonth = {};
  for (const m of allMonthsRaw) allByMonth[m] = (allByMonth[m] || 0) + 1;
  const signRe = /co-authored-by:\s*(claude|commandcodebot|cursor|openai|chatgpt)/i;
  const body = (args) => git(args).split('\n').filter((l) => signRe.test(l)).length;
  const aiSignedHead = body(['log', ...sc, '--format=%b']);
  const aiSignedAll = body(['log', '--all', '--format=%b']);

  return {
    测量口径: scope.ref === 'HEAD'
      ? '本分支口径 = HEAD；全分支口径 = --all。两者并列，禁止混用。'
      : `⚠ HEAD 未出生（当前分支尚无提交，常见于历史重建进行中）：本分支口径退化为 ${scope.ref || '--all'}，`
        + '引用「本分支」数字时必须同时注明该 ref。',
    测量ref: scope.ref || '(--all)',
    提交总数: authorsRaw.length,
    作者: authors,
    首位作者署名: Object.keys(authors).sort((a, b) => authors[b] - authors[a])[0] || null,
    提交日期范围: { 起: firstDay, 止: lastDay },
    月度提交: byMonth,
    累计新增行: added,
    累计删除行: removed,
    已跟踪文件数: trackedFiles,
    全分支口径: {
      分支数: Number(git(['branch', '-a']).split('\n').filter(Boolean).length) || 0,
      提交总数: allCount,
      月度提交: allByMonth,
      含AI署名提交_本分支: aiSignedHead,
      含AI署名提交_全分支: aiSignedAll,
      占比_全分支: allCount ? Number((aiSignedAll / allCount * 100).toFixed(1)) : 0,
      说明: '本分支 main 是被重建的短历史；完整开发过程在全部分支上。两个口径必须分开引用。',
    },
    复算命令: ['git log --format=%an', 'git log --format=%ad --date=format:%Y-%m', 'git log --numstat --format=', 'git ls-files', 'git rev-list --count --all', "git log --all --format='%b' | grep -ciE 'co-authored-by: (claude|commandcodebot)'"],
  };
}

// ── 2. .khy/feedback 三模态反馈存证（规则 5/6/7 的落盘）─────────────────────
const FEEDBACK_KINDS = [
  'complaint.md',
  'repro-before.txt',
  'differential.md',
  'repro-after.txt',
  'requirement-5q.md',
  'rollback.txt',
  'mode.json',
];

function collectFeedback() {
  if (!fs.existsSync(FEEDBACK_DIR)) {
    return { 存在: false, 说明: '状态目录不存在（换机或未跑过修复类任务）' };
  }
  const tasks = fs.readdirSync(FEEDBACK_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const kinds = {};
  for (const k of FEEDBACK_KINDS) kinds[k] = 0;

  const cases = [];
  const byDay = {};
  let pairsBeforeAfter = 0;
  for (const t of tasks) {
    const dir = path.join(FEEDBACK_DIR, t);
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch (e) {
      continue;
    }
    for (const k of FEEDBACK_KINDS) if (files.includes(k)) kinds[k]++;
    const hasBefore = files.includes('repro-before.txt');
    const hasAfter = files.includes('repro-after.txt');
    if (hasBefore && hasAfter) pairsBeforeAfter++;
    // 逐任务时间戳：取目录内最新一份存证的 mtime，作为「这一轮发生在哪天」的依据
    let stamp = 0;
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(dir, f));
        if (st.mtimeMs > stamp) stamp = st.mtimeMs;
      } catch (e) {
        continue;
      }
    }
    const day = stamp ? new Date(stamp).toISOString().slice(0, 10) : null;
    if (day) byDay[day] = (byDay[day] || 0) + 1;
    cases.push({
      任务: t,
      存证: files.filter((f) => FEEDBACK_KINDS.includes(f)),
      其余文件数: files.length,
      最新存证日期: day,
    });
  }
  const days = Object.keys(byDay).sort();

  // 复现-修复往返：同一任务既有改前输出又有改后输出
  const dated = tasks.filter((t) => /^\d{4}-\d{2}-\d{2}/.test(t)).length;

  return {
    存在: true,
    任务目录数: tasks.length,
    逐存证类型计数: kinds,
    复现修复往返数: pairsBeforeAfter,
    日期命名任务数: dated,
    存证活跃日数: days.length,
    存证跨度: days.length ? { 起: days[0], 止: days[days.length - 1] } : null,
    按日分布: byDay,
    逐任务清单: cases,
    复算命令: ['ls .khy/feedback | wc -l', 'find .khy/feedback -maxdepth 2 -type f | sed \'s#.*/##\' | sort | uniq -c'],
  };
}

// ── 3. 人类指令原文语料（C-M4「需求来源」痕迹）────────────────────────────
// 两类形态都要抓：RUNTIME-008 的 `source:` 字段行，以及正文里的
// 「用户原话/用户要求/用户拍板」引述句。只抓前者会漏一大半（实测 26 vs 113）。
const SOURCE_LINE_RE = /^[^\n]*\bsource\s*[:：][^\n]*$/gm;
const HUMAN_REF_RE = /(用户|客户|人工|我方|维护者)/;
const QUOTE_RE = /(用户|客户)(原话|要求|指示|指令|拍板|点头|决定|确认)[^\n]{0,160}/g;

function collectHumanInstructions(feedback, ledgers) {
  const dirs = feedback.存在 ? feedback.逐任务清单.map((c) => path.join(FEEDBACK_DIR, c.任务)) : [];
  const extra = [WORKBUDDY_DIR, HQ_DIR, path.join(REPO, 'docs', '15_维护记录'), path.join(REPO, 'docs', '04_IMPL_实现')]
    .filter((d) => fs.existsSync(d));
  const files = [];
  for (const d of dirs) for (const f of walk(d)) if (/\.(md|txt)$/i.test(f)) files.push(f);
  for (const d of extra) for (const f of walk(d)) if (/\.(md|json)$/i.test(f)) files.push(f);

  const sourceLines = [];
  const quotes = [];
  for (const f of files) {
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch (e) {
      continue;
    }
    const rel = () => path.relative(REPO, f).replace(/\\/g, '/');
    let m;
    SOURCE_LINE_RE.lastIndex = 0;
    while ((m = SOURCE_LINE_RE.exec(text)) !== null) {
      const line = m[0].replace(/\s+/g, ' ').trim();
      if (line.length < 8) continue;
      sourceLines.push({
        原文: line.slice(0, 400),
        人类指向: HUMAN_REF_RE.test(line),
        文件: rel(),
        行: text.slice(0, m.index).split('\n').length,
      });
    }
    QUOTE_RE.lastIndex = 0;
    while ((m = QUOTE_RE.exec(text)) !== null) {
      const line = m[0].replace(/\s+/g, ' ').trim();
      quotes.push({ 原文: line.slice(0, 400), 文件: rel(), 行: text.slice(0, m.index).split('\n').length });
    }
  }

  function dedupe(arr) {
    const out = [];
    const seen = new Set();
    for (const h of arr) {
      if (seen.has(h.原文)) continue;
      seen.add(h.原文);
      out.push(h);
    }
    return out;
  }

  const sourceDedup = dedupe(sourceLines);
  const quoteDedup = dedupe(quotes);

  // 台账里「人写的验收标准」：acceptance 非空的任务 = 人定义了成功长什么样
  const humanAcceptanceCriteria = [];
  for (const t of ledgers.任务条目原始) {
    if (t && typeof t.acceptance === 'string' && t.acceptance.trim().length > 10) {
      humanAcceptanceCriteria.push({ id: t.id, 标题: t.title, 验收标准: t.acceptance.trim().slice(0, 600), 状态: t.status });
    }
  }

  return {
    扫描文件数: files.length,
    source字段行: { 命中: sourceLines.length, 去重: sourceDedup.length, 其中人类指向: sourceDedup.filter((h) => h.人类指向).length, 条目: sourceDedup },
    用户引述句: { 命中: quotes.length, 去重: quoteDedup.length, 条目: quoteDedup },
    人写的验收标准: { 条数: humanAcceptanceCriteria.length, 条目: humanAcceptanceCriteria },
    复算命令: [
      'grep -rn "source:" .khy/feedback --include=*.md | wc -l',
      'grep -rn "用户原话\\|用户要求\\|用户拍板" .khy/feedback .workbuddy .ai/hq docs/15_维护记录 | wc -l',
    ],
  };
}

// ── 4. 每日工作笔记与任务/Bug 台账 ─────────────────────────────────────────
function rawItems(node) {
  if (!node) return [];
  if (Array.isArray(node)) return node;
  if (Array.isArray(node.tasks)) return node.tasks;
  if (Array.isArray(node.bugs)) return node.bugs;
  if (Array.isArray(node.items)) return node.items;
  return [];
}

function collectLedgers() {
  const notes = fs.existsSync(WORKBUDDY_DIR)
    ? fs.readdirSync(WORKBUDDY_DIR).filter((f) => f.endsWith('.md'))
    : [];
  const progress = readJsonSafe(path.join(HQ_DIR, 'PROGRESS.json'));
  const bugs = readJsonSafe(path.join(HQ_DIR, 'BUGS.json'));

  function shape(node, label) {
    if (!node) return { [label]: '文件缺失或不可解析' };
    const items = Array.isArray(node) ? node
      : Array.isArray(node.items) ? node.items
        : Array.isArray(node.tasks) ? node.tasks
          : Array.isArray(node.bugs) ? node.bugs
            : null;
    const byStatus = {};
    const claimants = {};
    if (items) {
      for (const it of items) {
        const st = String((it && (it.status || it.state)) || 'unknown');
        byStatus[st] = (byStatus[st] || 0) + 1;
        const cb = it && (it.claimed_by || it.owner);
        if (cb) claimants[String(cb)] = (claimants[String(cb)] || 0) + 1;
      }
    }
    return {
      [label + '条目数']: items ? items.length : Object.keys(node).length,
      按状态: byStatus,
      按认领者: claimants,
      顶层键: Object.keys(node).slice(0, 20),
    };
  }

  return {
    每日工作笔记: { 文件数: notes.length, 清单: notes },
    任务台账: shape(progress, 'PROGRESS'),
    Bug台账: shape(bugs, 'BUGS'),
    任务条目原始: rawItems(progress),
    Bug条目原始: rawItems(bugs),
    复算命令: ['ls .workbuddy/memory | wc -l', 'node -e "const p=require(\'./.ai/hq/PROGRESS.json\');console.log(p.tasks.length)"'],
  };
}

// ── 5. 原创规模与第三方边界（C-X3 / C-MAT1）───────────────────────────────
function collectOriginality() {
  const kernelFiles = fs.existsSync(KERNEL_DIR) ? walk(KERNEL_DIR) : [];
  const SRC_EXT = ['.c', '.h', '.asm', '.s', '.moonbit', '.rs'];
  const byExt = {};
  let kernelLines = 0;
  let vendorLines = 0;
  let vendorFiles = 0;
  const vendorHits = {};
  for (const f of kernelFiles) {
    const ext = path.extname(f).toLowerCase();
    const base = path.basename(f);
    if (!SRC_EXT.includes(ext) && !['.py', '.js', '.md', '.txt', '.ld', '.toml', '.json'].includes(ext)) continue;
    const n = countLines(f);
    const rel = path.relative(REPO, f).replace(/\\/g, '/');
    // 原创口径必须剔除 vendor 与生成物：`runtime.c` 与 `moonbit_gen.c` 是第三方运行时，
    // 若计入手写行数，等于「把第三方代码冒充原创」——正是 C-X3 判死的那种事。
    if (/vendor/.test(rel) || /_gen\./.test(base)) {
      vendorLines += n;
      vendorFiles++;
      vendorHits[rel] = n;
      continue;
    }
    byExt[ext] = byExt[ext] || { 文件数: 0, 行数: 0 };
    byExt[ext].文件数++;
    byExt[ext].行数 += n;
    kernelLines += n;
  }

  const thirdParty = {
    vendor目录: walk(path.join(REPO, 'kernel', 'vendor')).length + walk(path.join(REPO, 'services', 'backend', 'vendor')).length,
    node_modules顶层包数: (() => {
      try {
        return fs.readdirSync(path.join(REPO, 'node_modules')).filter((d) => !d.startsWith('.')).length;
      } catch (e) {
        return 0;
      }
    })(),
    生成物形态命中: (() => {
      const all = walk(path.join(REPO, 'kernel')).concat(walk(path.join(REPO, 'services', 'backend', 'src')));
      return all.filter((f) => /(_gen\.|_blob\.h|\.min\.js$)/.test(path.basename(f))).length;
    })(),
  };

  const docsAxis = {};
  if (fs.existsSync(DOCS_DIR)) {
    for (const ent of fs.readdirSync(DOCS_DIR, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (/^(0[1-9]|1[0-9])_/.test(ent.name)) {
        docsAxis[ent.name] = walk(path.join(DOCS_DIR, ent.name)).filter((f) => f.endsWith('.md')).length;
      }
    }
  }

  return {
    内核手写层: {
      按扩展名: byExt,
      总行数_已剔除第三方: kernelLines,
      被剔除的vendor行数: vendorLines,
      被剔除的vendor文件数: vendorFiles,
      剔除明细: vendorHits,
      口径说明: '本表只计 kernel/ 下非 vendor、非 *_gen.* 的源文件行数，可直接用复算命令核对。',
    },
    第三方与生成物: thirdParty,
    文档分轴md数: docsAxis,
    复算命令: ['find kernel -name "*.c" -not -path "*vendor*" | xargs wc -l | tail -1', 'find kernel -name "*.asm" | xargs wc -l | tail -1', 'node scripts/ci/check-copyright-readiness.js'],
  };
}

// ── 6. 治理体系规模 —— 「人给自己造了一道会挡回自己的门」的实测证据 ─────────
function collectGovernance() {
  const ciDir = path.join(REPO, 'scripts', 'ci');
  let checkers = [];
  try {
    checkers = fs.readdirSync(ciDir).filter((f) => /^check-.*\.(js|py)$/.test(f));
  } catch (e) {
    checkers = [];
  }
  const registry = readJsonSafe(path.join(REPO, 'docs', '10_规范', 'registry', 'RULES-REGISTRY.json'));
  const rules = registry && Array.isArray(registry.rules) ? registry.rules : [];
  const withExecutor = rules.filter((r) => r && r.gate && r.gate !== 'manual').length;
  const prompts = fs.existsSync(path.join(HQ_DIR, 'prompts')) ? walk(path.join(HQ_DIR, 'prompts')).filter((f) => f.endsWith('.md')) : [];
  const promptCats = new Set(prompts.map((f) => path.basename(path.dirname(f))));
  return {
    CI检查器文件数: checkers.length,
    规则总数: rules.length,
    有执行器的规则数: withExecutor,
    纯人工规则数: rules.length - withExecutor,
    提示词文件数: prompts.length,
    提示词分类数: promptCats.size,
    复算命令: ['ls scripts/ci/check-*.js scripts/ci/check-*.py | wc -l', "node -e \"const r=require('./docs/10_规范/registry/RULES-REGISTRY.json').rules;console.log(r.length, r.filter(x=>x.gate&&x.gate!=='manual').length)\"", 'find .ai/hq/prompts -name "*.md" | wc -l'],
  };
}

// ── 6. 模块依赖：从源码真实 require/import  specifier 派生目录级依赖边 ────────
// 只统计「本仓内部」的引用：相对路径 + @khy/* workspace 包 + 前端 @/ 别名。
// 裸包名（npm 依赖）不是模块依赖边，单独计数登记为「外部包引用」。
const DEP_SCOPES = [
  ['services/backend/src', 'backend'],
  ['services/ai-backend/src', 'ai-backend'],
  ['apps/ai-frontend/src', 'ai-frontend'],
  ['software/khyquant/frontend/src', 'khyquant-fe'],
  ['platform/packages', 'pkg'],
  ['kernel', 'kernel'],
  ['extensions', 'extensions'],
  ['tools', 'tools'],
];
const DEP_FILE_RE = /\.(js|jsx|mjs|cjs|vue|ts)$/, DEP_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-electron', 'build', 'out', 'unpacked',
  '__tests__', 'tests', 'test', 'coverage', 'entries', '.khy', '.khyos', '.khyquant',
]);
// 相对 specifier 解析时允许落点：与既有 check-repo-layout 的解析口径一致
const DEP_RESOLVE_EXT = ['', '.js', '.json', '.vue', '.ts', '/index.js', '/index.json'];
const DEP_SPEC_RE = /(?:require\s*\(\s*|(?:import|export)\s[^;'"]{0,120}?\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;

function bucketOf(relPosix) {
  for (const [root, tag] of DEP_SCOPES) {
    if (relPosix !== root && !relPosix.startsWith(root + '/')) continue;
    const rest = relPosix === root ? '' : relPosix.slice(root.length + 1);
    if (tag === 'pkg') {
      const seg = rest.split('/')[0];
      return seg ? `pkg:${seg}` : 'pkg:(根)';
    }
    if (tag === 'kernel') return 'kernel';
    if (tag === 'extensions' || tag === 'tools') {
      const seg = rest.split('/')[0];
      return seg && seg !== path.basename(root) ? `${tag}/${seg}` : tag;
    }
    const seg = rest.includes('/') ? rest.split('/')[0] : (rest ? '(src根)' : '(src根)');
    return `${tag}:${seg}`;
  }
  return null;
}

function resolveSpecifier(spec, fromDirRel, scopeRoot) {
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    return path.posix.normalize(path.posix.join(fromDirRel, spec));
  }
  // 前端构建别名 '@' = 该应用的 src 根，而非文件所在目录
  if (spec.startsWith('@/')) return path.posix.join(scopeRoot, spec.slice(2));
  if (spec.startsWith('@khy/')) {
    const name = spec.slice('@khy/'.length).split('/')[0];
    const direct = `platform/packages/${name}`;
    if (fs.existsSync(path.join(REPO, direct))) return direct;
    return null;
  }
  return null; // 裸包名 = 外部依赖，不是内部边
}

function collectDependencies() {
  let 测量文件数 = 0, 内部引用总数 = 0, 可解析边 = 0, 未解析相对引用 = 0, 外部包引用 = 0, 自环 = 0;
  const edgeMap = new Map();
  const outDegree = new Map();
  const inDegree = new Map();
  for (const [root] of DEP_SCOPES) {
    const abs = path.join(REPO, root);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs, DEP_SKIP_DIRS)) {
      if (!DEP_FILE_RE.test(full)) continue;
      const rel = path.relative(REPO, full).replace(/\\/g, '/');
      const from = bucketOf(rel);
      if (!from) continue;
      测量文件数++;
      let src = '';
      try {
        src = fs.readFileSync(full, 'utf8');
      } catch (e) {
        continue;
      }
      const fromDir = path.posix.dirname(rel);
      for (const mm of src.matchAll(DEP_SPEC_RE)) {
        const spec = mm[1];
        if (!spec) continue;
        const target = resolveSpecifier(spec, fromDir, root);
        if (target === null) {
          if (/^[./]/.test(spec) || spec.startsWith('@khy/') || spec.startsWith('@/')) 未解析相对引用++;
          else 外部包引用++;
          continue;
        }
        内部引用总数++;
        let to = null;
        for (const ext of DEP_RESOLVE_EXT) {
          const candidate = target + ext;
          if (fs.existsSync(path.join(REPO, candidate))) {
            to = bucketOf(candidate.endsWith('.js') || candidate.endsWith('.json') || candidate.endsWith('.vue') || candidate.endsWith('.ts') ? candidate : candidate + '/index.js');
            break;
          }
        }
        if (!to) to = bucketOf(target);
        if (!to) { 未解析相对引用++; continue; }
        if (to === from) { 自环++; continue; }
        可解析边++;
        const key = `${from} → ${to}`;
        edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
        outDegree.set(from, (outDegree.get(from) || 0) + 1);
        inDegree.set(to, (inDegree.get(to) || 0) + 1);
      }
    }
  }
  const edges = [...edgeMap.entries()].map(([k, v]) => {
    const [源, 目标] = k.split(' → ');
    return { 源, 目标, 次数: v };
  }).sort((a, b) => b.次数 - a.次数);
  const 节点 = new Set();
  for (const e of edges) { 节点.add(e.源); 节点.add(e.目标); }
  const 入度排名 = [...inDegree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([k, v]) => ({ 目录: k, 被引用次数: v }));
  const 出度排名 = [...outDegree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([k, v]) => ({ 目录: k, 引用出去次数: v }));
  const 目录权重 = [...节点].map((n) => ({
    目录: n, 入: inDegree.get(n) || 0, 出: outDegree.get(n) || 0,
  })).sort((a, b) => (b.入 + b.出) - (a.入 + a.出));
  // 跨板块汇总：把 'backend:cli → backend:services' 这类同板块内部边排除后再统计
  const 跨板块 = {};
  for (const e of edges) {
    const a = e.源.split(':')[0], b = e.目标.split(':')[0];
    if (a === b) continue;
    跨板块[`${a} → ${b}`] = (跨板块[`${a} → ${b}`] || 0) + e.次数;
  }
  return {
    口径: '目录级依赖边：由源码内 require()/import/export-from/dynamic import 的 specifier 解析得到；'
      + '相对路径按文件所在目录解析并补 .js/.json/.vue/.ts/index.js 落点，@khy/* 解析到 platform/packages/*，'
      + '@/* 解析到各前端 src。裸包名（npm 依赖）不计为内部边。同目录内部引用计为自环并剔除。',
    统计范围: DEP_SCOPES.map(([r]) => r),
    测量文件数, 内部引用总数, 可解析边, 未解析相对引用, 外部包引用, 自环剔除: 自环,
    目录节点数: 节点.size, 目录级边数: edges.length,
    最强边: edges.slice(0, 25),
    跨板块边: Object.entries(跨板块).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ 路径: k, 次数: v })),
    入度排名, 出度排名, 目录权重,
    复算命令: [
      `node -e "const p=require('./evidence/04_机器可读/contribution-metrics.json').模块依赖度量;console.log(p.可解析边,p.目录节点数)"`,
      'node scripts/evidence/collect-contribution.js（重跑即覆盖本段）',
      "grep -rn \"require('\\\\.\\\\./services\" services/backend/src/cli | wc -l",
    ],
  };
}

function main() {
  log('采集 1/6: git 历史（提交/作者/月度/行数）');
  const gitMetrics = collectGit();
  log(`采集 1/6 完成: ${gitMetrics.提交总数} 条提交，${Object.keys(gitMetrics.作者).length} 位作者，第 ${gitMetrics.累计新增行} 行新增`);

  log('采集 2/6: .khy/feedback 三模态存证');
  const feedback = collectFeedback();
  log(`采集 2/6 完成: ${feedback.任务目录数 || 0} 个任务目录，复现-修复往返 ${feedback.复现修复往返数 || 0} 组`);

  log('采集 3/6: 人类指令原文语料 + 台账验收标准');
  const ledgers = collectLedgers();
  const human = collectHumanInstructions(feedback, ledgers);
  log(`采集 3/6 完成: 扫描 ${human.扫描文件数} 个文件，source 行 ${human.source字段行.命中}（去重 ${human.source字段行.去重}，人类指向 ${human.source字段行.其中人类指向}），引述句 ${human.用户引述句.去重} 条，人写的验收标准 ${human.人写的验收标准.条数} 条`);

  log('采集 4/6: 工作笔记与任务/Bug 台账');
  log(`采集 4/6 完成: 笔记 ${ledgers.每日工作笔记.文件数} 篇，任务 ${ledgers.任务条目原始.length} 项，Bug ${ledgers.Bug条目原始.length} 项`);

  log('采集 5/6: 原创规模、第三方边界与治理体系规模');
  const originality = collectOriginality();
  const governance = collectGovernance();
  log(`采集 5/6 完成: 内核手写（已剔 vendor）${originality.内核手写层.总行数_已剔除第三方} 行，剔除 vendor ${originality.内核手写层.被剔除的vendor行数} 行；检查器 ${governance.CI检查器文件数} 个 / 规则 ${governance.规则总数} 条（有执行器 ${governance.有执行器的规则数}）`);

  log('采集 6/6: 模块依赖（源码真实 require/import specifier 解析出的目录级边）');
  const deps = collectDependencies();
  log(`采集 6/6 完成: 扫描 ${deps.测量文件数} 个源文件，npm 外部包引用 ${deps.外部包引用} 处（不计内部边），可解析内部边 ${deps.可解析边} 条 → ${deps.目录节点数} 个目录节点 / ${deps.目录级边数} 条目录级边（未解析 ${deps.未解析相对引用}）`);

  // 非空断言：任何一项为 0 都说明采集器读错了地方，不许静默出绿数
  const guards = {
    'git 提交数 > 0': gitMetrics.提交总数 > 0,
    '全分支提交数 > 本分支': gitMetrics.全分支口径.提交总数 >= gitMetrics.提交总数,
    'feedback 任务数 > 0': (feedback.任务目录数 || 0) > 0,
    'source 行命中 > 0': human.source字段行.命中 > 0,
    '验收标准 > 0': human.人写的验收标准.条数 > 0,
    '内核行数 > 0': originality.内核手写层.总行数_已剔除第三方 > 0,
    '检查器数 > 0': governance.CI检查器文件数 > 0,
    '内部依赖边 > 500': deps.可解析边 > 500,
    '依赖目录节点 > 20': deps.目录节点数 > 20,
  };
  const failed = Object.keys(guards).filter((k) => !guards[k]);
  if (failed.length) {
    log(`采集失败（输入为空，拒绝出数）: ${failed.join(' | ')}`);
    process.exitCode = 1;
  }

  const payload = {
    生成时间: new Date().toISOString(),
    生成器: 'scripts/evidence/collect-contribution.js',
    说明: '本文件的每个数字都能用同条目下的「复算命令」在本机重跑得到；证据图片由这些 JSON 渲染，不手写。',
    人类贡献度量: { git: gitMetrics, 反馈存证: feedback, 人类指令语料: human, 台账: ledgers },
    原创性度量: originality,
    治理体系度量: governance,
    模块依赖度量: deps,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, 'contribution-metrics.json');
  fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  log(`落盘: ${path.relative(REPO, out).replace(/\\/g, '/')}（${fs.statSync(out).size} 字节）`);
}

main();
