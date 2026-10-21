#!/usr/bin/env node
'use strict';

/**
 * check-doc-claims.js — 文档「可执行主张」校验（DOCS-006）。
 *
 * ## 为什么需要它
 *
 * DOCS-005 只核对「文档声称的实现路径是否还存在」，那是**路径级**判据。
 * 实测证明**内容级**漂移同样可机检，且不必靠 git 时间戳：
 * 一份文档若写下了 `npm run X`、`node --test a.test.js`、`/api/v1/foo`
 * 这类**可执行的字面量**，它就是在对读者作出一个可验证的承诺。
 * 承诺与仓库现状不符，就是漂移——无论谁先谁后。
 *
 * 三条信号（按精度排序，只上高精度的）：
 *   S1 端点字面量：文档写 `/api/v1/foo` 而全仓源码无此串（实测 7 处，精度 100%）
 *   S2 npm 目标：文档 `npm run X` 而 package.json 无此脚本 —— 已由
 *      check-repo-layout 的 dangling-task 覆盖，本脚本**不重复**，只报超出其豁免的部分
 *   S3 命令内路径：文档 `node --test a.test.js` 而该文件不可达 —— 实测精度仅
 *      21.9%（726 命中里 136 是搬迁后仍可达、其余大量是历史命令示例），
 *      **故不做成 finding**，只在 --verbose 下作为人工复核线索输出。
 *
 * ## 为什么 S3 不做成 finding
 *
 * 仓库引「公理 A4：误报比漏报更贵」。S3 的 78% 命中率是噪声——
 * 文档里的命令行示例天然包含大量已过时但仍有教学意义的历史命令。
 * 把它做成告警，只会让真问题被淹没。故只做线索，不做判定。
 *
 * ## 落地阶段（PROCESS-006 PP-1 / PROCESS-008）
 *
 * `STAGE = 'S1'`：观察者，只记录不阻断，恒 exit 0。
 * 登记在 `FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]`（id=`doc-claims-guard`）。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const STAGE = 'S1';
const OBSERVER_STAGES = new Set(['S1', 'S2']);

const repoRoot = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const verbose = args.includes('--verbose');
const listMode = (() => {
  const m = args.find((a) => a.startsWith('--list='));
  return m ? m.slice('--list='.length) : null;
})();

/** 与 DOCS-005 同一套适用范围：索引页与规则卡（生成物）不参与。 */
const IN_SCOPE = /^docs\/(03_DESIGN_设计|10_规范)\//;
const EXCLUDE = /(?:^|\/)00_INDEX_|^docs\/10_规范\/规则卡\//;

/**
 * 跳过目录。`entries/` 与 `bundled/` 是构建产物（LAYOUT-005）——
 * 其中的 bundle.mjs 单个 17MB，全仓 272MB 源码里绝大部分是它们。
 * 扫进去不仅慢，而且 bundle 是压缩产物、端点串与源码那份不是一回事。
 */
const SKIP_DIRS = new Set([
  'html', 'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  'entries', 'bundled', 'vendor', '__pycache__', '.venv', 'venv',
]);

/** 端点字面量：`/api/...` `/v1/...` 这类契约断言。反引号包裹 = 文档把它当承诺写。 */
const ENDPOINT_CLAIM = /`(\/(?:api|v1)\/[a-zA-Z0-9_\-/{}$.]+)`/g;
/** 带模板段的端点（`/api/v1/{id}`）无法逐字比对，跳过。 */
const ENDPOINT_TEMPLATE = /[<>{}$*]/;

/**
 * 「举这个问题为例」的文档不是在下承诺。
 * 一份规范文档引用某个失效端点来论证漂移存在，与一份设计文档写下该端点
 * 声称它是契约，是两件事。
 *
 * ⚠ 这里**不靠语气词判定**——实测靠措辞会漏（表格行里没有「反例」二字），
 *   也靠措辞会误伤。改用**显式声明式豁免**：文档顶部写一行
 *   `<!-- DOCS-CLAIMS-EXEMPT: 理由 -->`，该文档的全部端点主张免判。理由必填。
 *   与 DOCS-007 的 DOCS-NUMBERS-EXEMPT 同构。
 */
const EXEMPT_MARK = new RegExp('<!--\\s*DOCS-CLAIMS-EXEMPT:\\s*([^\\n>]+?)\\s*-->');

/** 命令内脚本路径——只作线索，不作判定（见文件头 S3）。 */
const CODE_PATH_CLAIM = /(?:node\s+(?:--test\s+)?|--test\s+|bash\s+|python3?\s+)([A-Za-z0-9_./-]+\.(?:js|mjs|cjs|ts|py|sh))/g;
/** 示例占位名——文档举例子用的假路径。 */
const EXAMPLE_NAME = /^(foo|bar|baz|qux|example|your|name|todo|path|file|some|new|old|test|dummy|sample|missing|xxx|placeholder|do-not|stub)/i;

function walk(dir, depth, acc, filter) {
  if (depth > 8) return acc;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1, acc, filter);
    } else if (filter(e.name)) {
      acc.push(path.join(dir, e.name));
    }
  }
  return acc;
}

/**
 * 全仓源码里出现过的端点串集合。
 *
 * ⚠ **必须用 git grep 而不是遍历读文件**：本机 8755 个源文件、272MB，
 *   逐个 readFileSync 要跑 200s 以上（实测超时），而 git grep 一次 7.4s。
 *   且 `entries/` 与 `bundled/` 是构建产物（LAYOUT-005），bundle.mjs 单个 17MB、
 *   压缩后的端点串与源码那份不是一回事。
 *
 * ⚠ **必须用 -h 保留整行而非 -o 只取匹配片段**：路由常以注释形式登记
 *   （实测 `clientApps/index.js:36` 的 `// GET /api/client-apps/catalog`），
 *   只取匹配片段会漏掉「同一行的其余部分」，导致把已实现的端点误报成无实现。
 *   故取整行后自行扫描该行内是否包含目标端点串。
 */
const sourceLines = (() => {
  const lines = [];
  try {
    const out = execFileSync(
      'git',
      ['grep', '-I', '-h', '-E', '/(api|v1)/[a-zA-Z0-9_./{}$-]+', '--',
        'runtime/', 'delivery/', 'apps/', 'scripts/', 'works/ship/'],
      { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    for (const line of out.split('\n')) if (line.trim()) lines.push(line);
  } catch (e) {
    const out = e.stdout ? String(e.stdout) : '';
    for (const line of out.split('\n')) if (line.trim()) lines.push(line);
  }
  return lines;
})();

/** 端点串是否在源码中出现（含注释行——注释里的路由登记同样是代码的一部分）。 */
function endpointInSource(ep) {
  for (const line of sourceLines) {
    if (line.includes(ep)) return true;
  }
  return false;
}

/** 文件是否可达（含 2026-10-05 方案 P 搬迁映射），供 S3 线索用。 */
const RELOCATIONS = [
  ['services/backend', 'runtime/node/backend'],
  ['services/ai-backend', 'runtime/node/ai-backend'],
  ['apps/ai-frontend', 'delivery/web/ai-frontend'],
  ['apps/provider-hub', 'delivery/web/provider-hub'],
  ['software/khyquant', 'delivery/channel/khyquant'],
  ['packaging', 'works/ship'],
  ['platform', 'runtime/substrate/platform'],
  ['.ai', 'works/record/ai'],
];

const basenameIndex = (() => {
  const map = new Map();
  const files = walk(repoRoot, 0, [], () => true);
  for (const f of files) {
    const key = path.basename(f).toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(f.split(path.sep).join('/'));
  }
  return map;
})();

function fileReachable(rel) {
  if (fs.existsSync(rel) && fs.statSync(rel).isFile()) return true;
  for (const [oldPre, newPre] of RELOCATIONS) {
    if (rel === oldPre || rel.startsWith(oldPre + '/')) {
      const moved = newPre + rel.slice(oldPre.length);
      if (fs.existsSync(moved) && fs.statSync(moved).isFile()) return true;
    }
  }
  const hits = (basenameIndex.get(path.posix.basename(rel).toLowerCase()) || [])
    .filter((p) => !p.includes('/node_modules/'));
  return hits.length === 1;
}

const findings = [];
const stats = { docsScanned: 0, exemptDocs: 0, endpointClaims: 0, endpointUnsupported: 0, codePathLeads: 0 };
const endpointMisses = [];
const codePathLeads = [];

const docsRoot = path.join(repoRoot, 'docs');
if (fs.existsSync(docsRoot)) {
  const files = walk(docsRoot, 0, [], (n) => n.endsWith('.md'));
  for (const abs of files) {
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    if (!IN_SCOPE.test(rel) || EXCLUDE.test(rel)) continue;
    stats.docsScanned += 1;
    const text = fs.readFileSync(abs, 'utf8');

    // 显式声明式豁免：该文档整体免判（按文档判一次，不按行）
    if (EXEMPT_MARK.test(text)) {
      stats.exemptDocs += 1;
      continue;
    }

    // S1 端点字面量
    for (const line of text.split('\n')) {
      for (const m of line.matchAll(ENDPOINT_CLAIM)) {
        const ep = m[1];
        if (ENDPOINT_TEMPLATE.test(ep)) continue;
        stats.endpointClaims += 1;
        if (endpointInSource(ep)) continue;
        stats.endpointUnsupported += 1;
        endpointMisses.push({ doc: rel, endpoint: ep });
      }
    }

    // S3 命令内路径（线索，不判定）
    for (const m of text.matchAll(CODE_PATH_CLAIM)) {
      const p = m[1];
      if (/[<>{*]|\.\.\./.test(p) || EXAMPLE_NAME.test(path.posix.basename(p))) continue;
      if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) continue;
      if (fileReachable(p)) continue;
      stats.codePathLeads += 1;
      codePathLeads.push({ doc: rel, path: p });
    }
  }
}

if (stats.endpointUnsupported > 0) {
  findings.push({
    id: 'endpoint-claim-unsupported',
    severity: 'warning',
    message:
      `${stats.endpointUnsupported} 处文档写下的 HTTP 端点在源码中查无此串` +
      `（共核对 ${stats.endpointClaims} 条端点主张；全量名单用 --list=endpoint-claim-unsupported）。` +
      `典型成因是文档写了带版本前缀的端点（如 /api/v1/x）而代码实际挂载无版本前缀（/api/x）。`,
    detail: endpointMisses,
  });
}

if (listMode) {
  if (listMode === 'endpoint-claim-unsupported') {
    for (const e of endpointMisses) process.stdout.write(`${e.doc} -> ${e.endpoint}\n`);
    process.exit(0);
  }
  if (listMode === 'code-path-lead') {
    for (const c of codePathLeads) process.stdout.write(`${c.doc} -> ${c.path}\n`);
    process.exit(0);
  }
}

if (jsonMode) {
  process.stdout.write(
    JSON.stringify({ rule: 'DOCS-006', stage: STAGE, observer: OBSERVER_STAGES.has(STAGE), stats, findings }, null, 2) + '\n',
  );
} else {
  process.stdout.write('文档可执行主张校验（DOCS-006 · S1 观察者 · 恒 exit 0）\n');
  process.stdout.write('='.repeat(60) + '\n');
  process.stdout.write(`扫适用范围内 ${stats.docsScanned} 份文档\n`);
  process.stdout.write(
    `端点主张 ${stats.endpointClaims} 条，其中源码无实现 ${stats.endpointUnsupported} 条\n`,
  );
  for (const f of findings) {
    process.stdout.write(` - [${f.severity}] ${f.message} (id: ${f.id})\n`);
  }
  process.stdout.write(
    `命令内路径线索 ${stats.codePathLeads} 条（精度实测 21.9%，仅供人工复核，不作判定；` +
      `--list=code-path-lead 查看）\n`,
  );
  if (verbose) for (const c of codePathLeads.slice(0, 20)) {
    process.stdout.write(`   ~ ${c.doc} -> ${c.path}\n`);
  }
  process.stdout.write('\nnpm 目标悬空由 check-repo-layout 的 dangling-task 覆盖，本脚本不重复。\n');
}

if (OBSERVER_STAGES.has(STAGE)) process.exit(0);
process.exit(findings.some((f) => f.severity === 'error') ? 1 : 0);
