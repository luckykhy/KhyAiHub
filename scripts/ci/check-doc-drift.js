#!/usr/bin/env node
'use strict';

/**
 * check-doc-drift.js — 文档 ↔ 源码漂移观察者（DOCS-005）。
 *
 * ## 为什么需要它
 *
 * 本仓 990 份文档里只有 128 份带 `<!-- IMPL-STATUS: done|todo -->` 标记，
 * 且**没有任何脚本消费该标记**（grep 全 scripts/ 零命中）。也就是说「这份设计
 * 落码了没有」从来只是一句人工约定，没有任何东西会因它说错而报警。实测已经
 * 说错了：`[DESIGN-ARCH-131]` 首行写 `done`、正文第 4 行写「设计提案（未落地）」；
 * `[DESIGN-ARCH-030]` 写 `done` 而整套实现已从仓库消失。
 *
 * 本脚本只做一件事：**核对标了 `done` 的文档，它声称的实现路径是否真的存在。**
 *
 * ## 为什么不按 git 时间戳判「谁先谁后」
 *
 * 第一版设计的主信号是「同一 commit 改了代码却没改文档」。实测证伪：
 * both=12 / codeOnly=41 / docOnly=99 / neither=148，而 41 笔 codeOnly 里
 * **33 笔（80%）在随后 5 笔内就补上了文档提交**。即该守卫的主要命中对象正是本仓
 * 明文规定的工作流本身（先提交代码、另起一笔落账补文档）——一个把既定约定当
 * 主要输出的守卫，唯一教会人的事就是忽略它。另有三条机械死因：pre-commit 时
 * commit 尚不存在（须 `--cached`）、merge commit 上 diff-tree 静默返回空、
 * 本仓对象库 fsck 有洞。故 v1 不使用任何依赖 git 历史的信号。
 *
 * ## 判据（信号 A：锚定路径存在性）
 *
 * 首轮实测（2026-10-18）：991 份 md、352 条根锚定候选，缺失 61 条
 * （`done` 54 / `todo` 7）。`done` 与 `todo` 的不对称是它有区分力的证据；
 * 逐类处置后 `done` 收口到 **0**，余下为 superseded 26（已声明实现不在仓库的
 * 历史记录）与 todo 12（真规划）。纯 fs 操作，不依赖 git，对对象库损坏 /
 * merge commit / 浅克隆三类故障免疫，全仓扫描 <1s。
 *
 * 误报来源已知且被显式排除：agent 基础设施与本机态目录（`.khy`/`.khyos`/
 * `.zcode`/`.claude`，gitignore 非交付面）、Windows 反斜杠路径、示例占位符、
 * `docs/html/` 孪生件。
 *
 * ## 落地阶段（PROCESS-006 PP-1 / PROCESS-008）
 *
 * `STAGE = 'S1'`：**观察者，只记录不阻断，恒 exit 0**。登记在
 * `FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]`（id=`doc-drift-guard`），
 * `check-rollout-stage.js` 比对本常量与登记值，漂移即报 `rollout-stage-authority-drift`。
 *
 * 升阶是人的决定，须同时改三处：本文件 `STAGE`、登记表 `severity`、
 * `FEATURE-OWNERSHIP.json` 的 `stage`，一次只升一阶（PP-6）。
 */

const fs = require('fs');
const path = require('path');

const STAGE = 'S1';
const OBSERVER_STAGES = new Set(['S1', 'S2']);

const repoRoot = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const listMode = (() => {
  const m = args.find((a) => a.startsWith('--list='));
  return m ? m.slice('--list='.length) : null;
})();

/**
 * 根条目从文件系统读，不写死清单。写死就得把 `src`/`tests`/`bin` 这些
 * 只存在于 runtime/node/backend 之下的段也列进去，而锚到它们会把每个相对片段
 * （`src/cli/router.js`）都变成假 finding。
 */
let rootEntries = new Set();
try {
  rootEntries = new Set(fs.readdirSync(repoRoot));
} catch {
  rootEntries = new Set();
}

/** 2026-10-05 方案 P 搬迁映射，7 组前缀，旧 → 新。 */
const RELOCATIONS = [
  ['services/ai-backend', 'runtime/node/ai-backend'],
  ['services/backend', 'runtime/node/backend'],
  ['apps/ai-frontend', 'delivery/web/ai-frontend'],
  ['software/khyquant', 'delivery/channel/khyquant'],
  ['apps/provider-hub', 'delivery/web/provider-hub'],
  ['packaging', 'works/ship'],
  ['platform', 'runtime/substrate/platform'],
  ['.ai', 'works/record/ai'],
];

const CODE_EXTS = /\.(js|mjs|cjs|ts|tsx|vue|py|sh|json|yaml|md)$/;
// 空格 / 星号 / Windows 反斜杠：不是可核验的仓内路径。
const NOT_A_PATH = /[\s*\\]/;

/**
 * 命名模板而非路径主张：`handlers/<域>.js`、`ink-components/{ToolLines,ProcessGroup}.js`、
 * `hq/{BUGS,PROGRESS,MODELS}.json`。这类 token 是给读者看的占位写法，
 * 判它「存在」永远是假的，报出来是噪声不是漂移。
 */
const PATH_TEMPLATE = /<[^>]*>|\{[^}]*\}|\.\.\./;

/**
 * 非交付面根：agent 基础设施与本机态。文档提到它们不算漂移——
 * `.khy` / `.khyos` 按 [DESIGN-LAY-007] 是 gitignore 的本机态。
 */
const NON_SHIPPED_ROOTS = new Set([
  '.khy', '.khyos', '.zcode', '.claude', '.git', 'node_modules', '.khyquant',
]);

const SKIP_DIR_NAMES = new Set(['html', 'node_modules', '.git']);

/**
 * 同名兜底：文档写的路径在搬迁后失效，但仓内另有唯一同名文件时仍算存在。
 *
 * 覆盖面必须够大：domain 化把 `src/services/X.js` 拆到了 `src/services/domain/<域>/X.js`，
 * 只搜 scripts/entries/works 会漏掉这一整类——实测 10 条（budgetExecutor.js、
 * distiller.js、sidebarRail.js、ccMcpBridge.js 等）正是这样被误判成「实现消失」，
 * 而它们的实现其实都在。
 *
 * 只在**唯一命中**时采纳：多处同名说明判不出来，不算 finding。
 * 索引一次性建好复用，避免每个候选都重扫全仓。
 */
const basenameIndex = (() => {
  const map = new Map();
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIR_NAMES.has(e.name)) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else {
        const key = e.name.toLowerCase();
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(path.join(dir, e.name).split(path.sep).join('/'));
      }
    }
  };
  for (const root of ['runtime', 'delivery', 'apps', 'scripts', 'entries', 'works']) {
    const abs = path.join(repoRoot, root);
    if (fs.existsSync(abs)) walk(abs, 0);
  }
  return map;
})();

function resolveByBasename(relPath) {
  const name = path.posix.basename(relPath).toLowerCase();
  if (!name.includes('.')) return false;
  const hits = (basenameIndex.get(name) || []).filter((p) => !p.includes('/node_modules/'));
  return hits.length === 1 ? hits[0] : false;
}

function resolveToRealPath(relPath) {
  if (fs.existsSync(path.join(repoRoot, relPath))) return relPath;
  for (const [oldPre, newPre] of RELOCATIONS) {
    if (relPath === oldPre || relPath.startsWith(oldPre + '/')) {
      const moved = newPre + relPath.slice(oldPre.length);
      // 必须落到真实存在的**文件**才算命中：只判前缀目录存在会把
      // `packaging/self-heal/build.sh` 判为「已随方案 P 搬到 works/ship/」，
      // 而那份实现其实在搬迁中丢了——这正是本守卫最该抓到的一类假阴性。
      const movedAbs = path.join(repoRoot, moved);
      if (fs.existsSync(movedAbs) && fs.statSync(movedAbs).isFile()) return moved;
    }
  }
  return resolveByBasename(relPath) || null;
}

function collectDocs(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // docs/html 是 md 的孪生构建产物，同一内容会双报。
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      collectDocs(p, acc);
    } else if (e.name.endsWith('.md')) {
      acc.push(p);
    }
  }
  return acc;
}

const findings = [];
const stats = {
  docsScanned: 0,
  docsWithMarker: 0,
  docsWithoutMarker: 0,
  candidatesChecked: 0,
  missingAfterRelocation: 0,
  doneMarkedMissing: 0,
  supersededMarkedMissing: 0,
  todoMarkedMissing: 0,
};
const missingPaths = [];

const docsRoot = path.join(repoRoot, 'docs');
if (fs.existsSync(docsRoot)) {
  for (const abs of collectDocs(docsRoot)) {
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    stats.docsScanned += 1;
    const text = fs.readFileSync(abs, 'utf8');
    const marker = /<!--\s*IMPL-STATUS:\s*([a-zA-Z-]+)\s*-->/.exec(text);
    // 没有标记的文档本脚本判不了（无自述状态），只计数不出 finding——
    // 让「漏标」可见，但不把它误报成漂移。
    if (!marker) {
      stats.docsWithoutMarker += 1;
      continue;
    }
    stats.docsWithMarker += 1;
    const status = marker[1];

    const candidates = [...text.matchAll(/`([^`\n]+)`/g)]
      .map((m) => m[1])
      .filter((p) => {
        if (!CODE_EXTS.test(p)) return false;
        if (NOT_A_PATH.test(p)) return false;
        if (PATH_TEMPLATE.test(p)) return false;
        if (p.split('/').some((seg) => seg === 'node_modules')) return false;
        const head = p.split('/')[0];
        if (NON_SHIPPED_ROOTS.has(head)) return false;
        // 锚定放在**搬迁映射之后**判，不能放在前面：`packaging/` 早已不在仓库根
        // （方案 P 搬到 works/ship），先锚定会把它当相对片段直接丢掉，于是
        // `packaging/self-heal/build.sh` 这类「实现已随搬迁丢失」的路径永远不被检查。
        if (rootEntries.has(head)) return true;
        for (const [oldPre] of RELOCATIONS) {
          if (p === oldPre || p.startsWith(oldPre + '/')) return true;
        }
        return false;
      });

    for (const cand of candidates) {
      stats.candidatesChecked += 1;
      if (resolveToRealPath(cand)) continue;
      stats.missingAfterRelocation += 1;
      if (status === 'done') stats.doneMarkedMissing += 1;
      else if (status === 'superseded') stats.supersededMarkedMissing += 1;
      else stats.todoMarkedMissing += 1;
      missingPaths.push({ doc: rel, claimed: cand, status });
    }
  }
}

if (stats.doneMarkedMissing > 0) {
  findings.push({
    id: 'impl-status-done-but-missing',
    severity: 'warning',
    message:
      `${stats.doneMarkedMissing} 处「IMPL-STATUS: done」的文档声称的实现路径在仓库中不存在` +
      `（已排除搬迁前缀与非交付面目录；全量名单用 --list=impl-status-done-but-missing）。`,
    detail: missingPaths.filter((m) => m.status === 'done'),
  });
}
if (stats.supersededMarkedMissing > 0) {
  // superseded = 已声明实现不在仓库，其正文列的历史路径本就不该存在。
  // 单列而不并入 done/todo：这是设计记录，不是漂移，也不是规划。
  findings.push({
    id: 'impl-status-superseded-historical',
    severity: 'warning',
    message:
      `${stats.supersededMarkedMissing} 处「IMPL-STATUS: superseded」的文档列有已不存在的历史路径` +
      `（已声明实现不在仓库，属预期；仅供审计追溯，全量名单用 --list=impl-status-superseded-historical）。`,
    detail: missingPaths.filter((m) => m.status === 'superseded'),
  });
}
if (stats.todoMarkedMissing > 0) {
  findings.push({
    id: 'impl-status-todo-but-missing',
    severity: 'warning',
    message:
      `${stats.todoMarkedMissing} 处「IMPL-STATUS: todo」的文档指向不存在的路径` +
      `（todo 文档写路径本属正常规划，此项仅供观察，不建议据此改动）。`,
    detail: missingPaths.filter((m) => m.status === 'todo'),
  });
}

if (listMode) {
  const hit = missingPaths.filter((m) => {
    if (listMode === 'impl-status-done-but-missing') return m.status === 'done';
    if (listMode === 'impl-status-superseded-historical') return m.status === 'superseded';
    return m.status === 'todo';
  });
  for (const m of hit) {
    process.stdout.write(`docs/${m.doc.replace(/^docs\//, '')} -> ${m.claimed} (${m.status})\n`);
  }
  process.exit(0);
}

if (jsonMode) {
  process.stdout.write(
    JSON.stringify(
      {
        rule: 'DOCS-005',
        stage: STAGE,
        observer: OBSERVER_STAGES.has(STAGE),
        stats,
        findings,
      },
      null,
      2,
    ) + '\n',
  );
} else {
  process.stdout.write('文档 ↔ 源码漂移观察者（DOCS-005 · S1 观察者 · 恒 exit 0）\n');
  process.stdout.write('='.repeat(60) + '\n');
  process.stdout.write(
    `扫 ${stats.docsScanned} 份 md：带标记 ${stats.docsWithMarker}、未带 ${stats.docsWithoutMarker}\n`,
  );
  process.stdout.write(
    `根锚定候选路径 ${stats.candidatesChecked} 条，搬迁映射后仍缺失 ${stats.missingAfterRelocation}` +
      `（done ${stats.doneMarkedMissing} / superseded ${stats.supersededMarkedMissing}` +
      ` / todo ${stats.todoMarkedMissing}）\n`,
  );
  for (const f of findings) {
    process.stdout.write(` - [${f.severity}] ${f.message} (id: ${f.id})\n`);
  }
  process.stdout.write(
    '\n判据为「锚定路径存在性」；done 类漂移已收口归零。S1 观察者：只报告，不阻断。\n',
  );
}

// S1/S2 观察者恒 exit 0；升阶后按 severity 决定退出码（升阶是人的决定）。
if (OBSERVER_STAGES.has(STAGE)) process.exit(0);
process.exit(findings.some((f) => f.severity === 'error') ? 1 : 0);
