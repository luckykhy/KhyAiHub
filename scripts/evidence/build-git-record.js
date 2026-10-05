#!/usr/bin/env node
/**
 * 生成 works/record/evidence/05_索引与对账/提交记录与证据链.md —— 把 main 的**全部提交记录**摆出来，
 * 并给每条记录配三类可核验证据：① 交付载体（路径与规模，实测）② 原始血统可追溯（备份引用 + 三远端）
 * ③ 当场可复算的命令。
 *
 * 为什么必须由脚本生成：重建链的提交哈希每轮都会变，手写文档必然过期；本文件的每个数字与哈希
 * 都在生成时刻从 git 现算，重跑即刷新。数字口径与 works/record/evidence/04_机器可读/contribution-metrics.json
 * 一致（同仓同 ref），差别只在「快照时刻」——材料冻结时两个一起重跑即可对齐。
 *
 * 依赖：`git` 在 PATH 上（与 collect-contribution.js 同款调用）。
 * 重跑：node scripts/evidence/build-git-record.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'evidence', '05_索引与对账', '提交记录与证据链.md');

function git(args, { quiet = false } = {}) {
  return execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 1 << 29,
    // quiet：旧血统含损伤对象（2026-09-22 事故），带路径的遍历会对坏树打印 fatal 并中断；
    // 逐引用调用 + 捕获 stderr，坏引用计入「跳过」而不是污染控制台。
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
  });
}
function tryGit(args, fallback = '') {
  try { return git(args); } catch { return fallback; }
}
const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

// ── 1. 本分支提交记录（实时）────────────────────────────────────────────────
const chain = git(['log', '--reverse', '--format=%H%x01%aI%x01%s', 'main'])
  .split('\n').filter(Boolean).map((l) => {
    const [hash, date, subject] = l.split('\x01');
    return { hash, date, subject };
  });

const commits = chain.map((c, i) => {
  let files = 0, add = 0, del = 0;
  const stat = tryGit(['show', '--numstat', '--format=', c.hash]).split('\n').filter(Boolean);
  for (const s of stat) {
    const [a, d] = s.split('\t');
    files += 1;
    add += a === '-' ? 0 : parseInt(a, 10);
    del += d === '-' ? 0 : parseInt(d, 10);
  }
  return { seq: i + 1, short: c.hash.slice(0, 8), date: c.date.slice(0, 10), time: c.date.slice(11, 16), subject: c.subject, files, add, del };
});

// 时间线特征（与验证器 A6 判据同源）
const days = commits.map((c) => c.date);
const byDay = {};
for (const d of days) byDay[d] = (byDay[d] || 0) + 1;
const peak = Math.max(...Object.values(byDay));
const weekend = days.filter((d) => [0, 6].includes(new Date(d + 'T12:00:00+08:00').getDay())).length;
const early = commits.filter((c) => +c.time.slice(0, 2) < 7).length;

// ── 2. 规模与全分支触及（实时）──────────────────────────────────────────────
const treeCount = git(['ls-tree', '-r', '--name-only', 'main']).split('\n').filter(Boolean).length;
const totalAdd = commits.reduce((s, c) => s + c.add, 0);
const totalDel = commits.reduce((s, c) => s + c.del, 0);
const authors = [...new Set(tryGit(['log', '--format=%an <%ae>', 'main']).split('\n').filter(Boolean))];
const allRefCommits = tryGit(['log', '--all', '--oneline']).split('\n').filter(Boolean).length;
const branchCount = tryGit(['for-each-ref', '--format=%(refname)', 'refs/heads']).split('\n').filter(Boolean).length;

// 全分支触及的统计口径：逐引用遍历、按提交哈希去重；不可读的引用（旧血统损伤对象）计入「跳过」。
const ALL_REFS = (() => {
  const heads = tryGit(['for-each-ref', '--format=%(refname)', 'refs/heads']).split('\n').filter(Boolean);
  const remoteMains = ['refs/remotes/origin/main', 'refs/remotes/khy-mirror/main', 'refs/remotes/gitee/main']
    .filter((r) => tryGit(['rev-parse', '--verify', '--quiet', r]).trim());
  return [...heads, ...remoteMains];
})();
let skippedRefs = 0;
const failedRefs = new Set();
function touchCount(paths) {
  const seen = new Set();
  for (const ref of ALL_REFS) {
    try {
      const out = git(['log', ref, '--format=%H', '--', ...paths], { quiet: true });
      for (const h of out.split('\n')) if (h) seen.add(h);
    } catch { skippedRefs += 1; failedRefs.add(ref); }
  }
  return seen.size;
}

// ── 3. 十二阶段（与 gen-batches-57.js 的 S1..S12 对应）───────────────────────
const PHASES = [
  ['S1 项目骨架与元数据', 1, 5, ['.gitignore', 'package.json', 'pyproject.toml', '.github']],
  ['S2 内核层', 6, 9, ['kernel']],
  ['S3 平台启动器', 10, 12, ['platform']],
  ['S4 后端基座', 13, 17, ['services/backend/src/constants', 'services/backend/src/config', 'services/backend/src/bootstrap']],
  ['S5 后端核心服务层', 18, 23, ['services/backend/src/services']],
  ['S6 后端 CLI 与 TUI', 24, 30, ['services/backend/src/cli', 'services/backend/src/tools']],
  ['S7 数据/路由/工装 + ai-backend', 31, 34, ['services/backend/src/routes', 'services/ai-backend']],
  ['S8 前端与桌面端', 35, 39, ['apps', 'electron', 'packaging']],
  ['S9 内置应用与扩展', 40, 43, ['software', 'extensions']],
  ['S10 工具链与协作状态', 44, 47, ['scripts', '.ai']],
  ['S11 测试套件', 48, 52, ['services/backend/tests']],
  ['S12 文档体系与证据', 53, 57, ['docs', 'evidence']],
];

// 发布 tag 在链上的重锚位置（实时解引用；纪念性重锚，见证据表）
const TAGS = ['v1.1.8', 'v1.1.9', 'v1.1.12', 'v1.1.14', 'v1.1.15'];
const tagAnchor = new Map(); // seq -> [tag]
for (const t of TAGS) {
  const sha = tryGit(['rev-parse', `refs/tags/${t}^{commit}`]).trim();
  const i = chain.findIndex((c) => c.hash === sha);
  if (i >= 0) {
    const arr = tagAnchor.get(i + 1) || [];
    arr.push(t);
    tagAnchor.set(i + 1, arr);
  }
}

// ── 4. 证据源（实时计数）───────────────────────────────────────────────────
const remotes = [
  ['origin/main', tryGit(['rev-parse', '--short=10', 'refs/remotes/origin/main']).trim()],
  ['khy-mirror/main', tryGit(['rev-parse', '--short=10', 'refs/remotes/khy-mirror/main']).trim()],
  ['gitee/main', tryGit(['rev-parse', '--short=10', 'refs/remotes/gitee/main']).trim()],
];
const backupRefs = tryGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads/backup'])
  .split('\n').filter(Boolean);
const stashCount = tryGit(['stash', 'list']).split('\n').filter(Boolean).length;
const countDirs = (rel) => {
  try {
    return fs.readdirSync(path.join(REPO, rel), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch { return 0; }
};
const countFiles = (rel, filter) => {
  try {
    return fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })
      .filter((e) => e.isFile() && filter(e.name)).length;
  } catch { return 0; }
};
const feedbackDirs = countDirs('works/data/khy/feedback');
const designDocs = (() => {
  let n = 0;
  (function walk(d) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith('.md')) n += 1;
    }
  })(path.join(REPO, 'docs', '03_DESIGN_设计'));
  return n;
})();
const guardCount = countFiles('scripts/ci', (n) => n.startsWith('check-') && n.endsWith('.js'));
const bundleFiles = (() => {
  try {
    return fs.readdirSync(path.join(REPO, '.khyos', 'backup'))
      .filter((n) => n.endsWith('.bundle'))
      .map((n) => {
        const st = fs.statSync(path.join(REPO, '.khyos', 'backup', n));
        return `${n}（${(st.size / 1048576).toFixed(1)}MB）`;
      });
  } catch { return []; }
})();

// ── 5. 组装文档 ────────────────────────────────────────────────────────────
const L = [];
L.push('<!-- 本文件由 scripts/evidence/build-git-record.js 生成，勿手改数字与哈希；改口径请改生成器。 -->');
L.push('');
L.push('# 提交记录与证据链（git 记录 ↔ 证据 ↔ 复算命令）');
L.push('');
L.push('> 用途：把 `main` 的**全部提交记录**逐条摆出来，并给每条记录配三类可核验证据 ——');
L.push('> ① 交付载体（仓内路径与规模，实测）② 原始血统可追溯（备份引用 + 三远端）③ 当场可复算的命令。');
L.push('> 任何一条记录被质疑时，按下表当场复核即可，不必听信陈述。');
L.push('>');
L.push(`> 快照日期：${new Date().toISOString().slice(0, 10)}；本分支口径**实时计算**（重跑生成器即刷新）。`);
L.push('');

L.push('## 一、口径与性质声明（先读，避免误读）');
L.push('');
L.push('| 口径 | 范围 | 数字 | 用途 |');
L.push('|---|---|---|---|');
L.push(`| 本分支 | \`main\` | ${commits.length} 提交 / ${treeCount} 文件 / ${authors.length} 位作者 | 交付物与登记材料引用 |`);
L.push(`| 全分支 | 全部 ref（含备份与三远端） | ${allRefCommits} 提交 / ${branchCount} 个本地分支 | 完整开发过程，可追溯 |`);
L.push('');
L.push('诚实条款（引用本文件时必须一并保留）：');
L.push('');
L.push(`1. \`main\` 是**分层重放**的重建历史：按模块分 12 阶段重放，每批内容 / 日期 / 顺序确定可复算。`);
L.push(`   本链 ${commits.length} 提交「删除行 ${totalDel}」是重放形态（每个文件只在其归属批新增一次），`);
L.push('   **不得**叙述为逐日自然开发。');
L.push(`2. 旧发布 tag（${TAGS.join(' / ')}）为**纪念性重锚**：原始发布点仍在本仓对象库与三远端可追溯，`);
L.push('   重锚依据（日期邻近 + 顺序单调 + 内容覆盖率）逐条落在 `.khyos/backup/legacy-tags-remap-20260927.md`。');
L.push('3. `rebuild-57-verified` tag 随每轮重建**移动到最新验证链**，不是不可变发布点。');
L.push('4. `.khy/`、`.khyos/` 是本机态（被 gitignore）——开发存证与过程产物**不在 git 记录内**，随材料另附。');
L.push('5. 哈希列的语义：`main` 若再次被重建（分层重放），**主题与日期这条叙述骨架保持不变**，');
L.push('   哈希与「文件」列随工作区内容变化 —— 用 §五 命令当场重取，或重跑本生成器刷新。');
L.push('');

L.push('## 二、本分支提交记录（全量）');
L.push('');
L.push('| # | 日期 | 提交 | 主题 | 文件 | +行 | −行 |');
L.push('|---|---|---|---|---|---|---|');
for (const c of commits) {
  const tag = tagAnchor.get(c.seq);
  const mark = tag ? ` 🏷${tag.join('/')}` : '';
  L.push(`| ${c.seq} | ${c.date} | \`${c.short}\` | ${esc(c.subject)}${mark} | ${c.files} | ${c.add} | ${c.del} |`);
}
L.push('');
L.push(`合计：文件 ${commits.reduce((s, c) => s + c.files, 0)}、新增行 ${totalAdd}、删除行 ${totalDel}。`);
L.push('');
L.push(`时间线特征（复核命令见 §五）：首 ${commits[0].date} ${commits[0].time} → 末 ${commits[commits.length - 1].date} ${commits[commits.length - 1].time}（+08:00）；`);
L.push(`严格单调递增；凌晨 0–6 点提交 ${early} 次；单日最多 ${peak} 次；周末 ${weekend} 次（${((weekend / commits.length) * 100).toFixed(1)}%）。`);
L.push('');

L.push('## 三、逐阶段证据链（每条记录凭什么可信）');
L.push('');
L.push('「全分支口径触及」= 该载体在**全部本地分支 + 三远端 main** 上的提交数（逐引用遍历、按提交去重，');
L.push('含本链贡献）；数字越大 = 该模块背后可追溯的真实开发过程越多。');
L.push('旧血统含 2026-09-22 对象库事故的损伤对象，带路径的整仓遍历会中断，故本列**逐引用**统计；');
L.push('不可读的引用计入跳过，不虚报为 0（跳过数见 §六）。');
L.push('');
L.push('| 阶段 | 提交区间 | 日期范围 | 本阶段文件/行 | 交付载体（仓内路径） | 全分支口径触及 |');
L.push('|---|---|---|---|---|---|');
for (const [name, from, to, paths] of PHASES) {
  const seg = commits.filter((c) => c.seq >= from && c.seq <= to);
  const files = seg.reduce((s, c) => s + c.files, 0);
  const added = seg.reduce((s, c) => s + c.add, 0);
  const touched = touchCount(paths);
  L.push(`| ${name} | #${from}–#${to} | ${seg[0].date} → ${seg[seg.length - 1].date} | ${files} / +${added} | ${paths.map((p) => '`' + p + '`').join(' ')} | ${touched} |`);
}
L.push('');

L.push('## 四、证据源（五类，均可复核）');
L.push('');
L.push('1. **原始血统与三远端** —— 完整开发过程（含本链之外的历史）在这些引用上可达：');
for (const [name, sha] of remotes) L.push(`   - \`${name}\` = \`${sha}\``);
L.push(`2. **本地备份引用** —— ${backupRefs.length} 条 \`backup/*\`（逐轮重建链与旧血统快照）+ \`rebuild/staged-rebuild\` + ${stashCount} 个孤儿 stash；`);
L.push(`   保险 bundle：${bundleFiles.length ? bundleFiles.join('、') : '（.khyos/backup 不可读）'}。含钥旧链只在本地、永不推送。`);
L.push('3. **重建过程产物**（`.khyos/diag/`，本机态）—— `verify-rebuild-57-report.json`（19 项独立验证）、');
L.push('   `blueprint-audit-report.json`（纯增量性 / 路径唯一性 / 密钥 / 完整性缺口）、`rebuild-result-run*.json`（逐提交时刻）、');
L.push('   `refs-before-r*.txt`（保护 ref 基线）、`2026-09-27-git-history-rebuild-execution-report.md`（逐轮执行报告）。');
L.push(`4. **仓内开发存证** —— \`works/data/khy/feedback/\` ${feedbackDirs} 个任务目录（三模态存证：complaint / repro-before / differential /`);
L.push('   repro-after / requirement-5q / rollback / mode.json）；`.ai/hq/{PROGRESS,BUGS}.json`（多机共享台账）；');
L.push(`   \`docs/03_DESIGN_设计/\` ${designDocs} 篇设计文档；\`scripts/ci/check-*.js\` ${guardCount} 个守卫检查器。`);
L.push('5. **材料指标与图片** —— `works/record/evidence/04_机器可读/contribution-metrics.json`（每个数字带复算命令）；');
L.push('   `works/record/evidence/03_图片/`（图表与截图由指标渲染 / 实机采集，不手绘）。');
L.push('');

L.push('## 五、复算命令（逐条可跑，注释内为期望值）');
L.push('');
L.push('```bash');
L.push(`git log --reverse --format="%h %ad %s" --date=short main   # ${commits.length} 行`);
L.push(`git rev-list --count main                                  # ${commits.length}`);
L.push(`git ls-tree -r --name-only main | wc -l                     # ${treeCount}`);
L.push('git shortlog -sne main                                      # 单一作者');
L.push(`git log --all --oneline | wc -l                             # ${allRefCommits}（全分支口径）`);
L.push('git rev-parse origin/main refs/remotes/khy-mirror/main refs/remotes/gitee/main');
L.push('git log origin/main --format=%H -- kernel | wc -l         # 阶段表列算法：逐引用（本地分支 + 三远端 main）遍历后按提交去重');
L.push(`ls scripts/ci/check-*.js | wc -l                           # ${guardCount}（守卫检查器，本机态口径见 §四）`);
L.push(`find works/data/khy/feedback -mindepth 1 -maxdepth 1 -type d | wc -l  # ${feedbackDirs}（本机态存证目录）`);
L.push('node scripts/evidence/build-git-record.js                   # 重生成本文件（刷新哈希与数字）');
L.push('```');
L.push('');

L.push('## 六、待核与未知（如实列出）');
L.push('');
L.push('- 材料指标 `contribution-metrics.json` 是**快照**（生成时间见该文件）；与本文件的实时数字口径相同、时刻不同。');
L.push('  材料冻结时按 `npm run evidence:collect && npm run evidence:build && npm run evidence:images` 重算对齐。');
L.push('- 收录路径：本文件在 `works/record/evidence/05_索引与对账/证据总清单.json` 的**下一次** `npm run evidence:build` 后进入清单；');
L.push('  其 `.html` 孪生由 `node scripts/docs/build_docs_site.js` 生成 —— 改完本 `.md` 请重跑该构建，保持孪生同步。');
L.push('- 本文件与其 `.html` 孪生**自身**也计入树文件数（+2）——独立复核 `git ls-tree` 时会看到比上表多出的正是它们。');
L.push('- 旧血统存在 7 个不可达对象哈希（2026-09-22 对象库事故，见 `.khyos/diag/object-store-damage-20260922.md`）；');
L.push('  全仓 `git fsck` 的缺陷哈希全部位于旧血统、与本链**无交集**（验证项 A9b）。');
L.push(`  本文档生成时的遍历口径：${ALL_REFS.length} 个引用 × ${PHASES.length} 个阶段 = ${ALL_REFS.length * PHASES.length} 次逐引用遍历，`);
L.push(`  其中 ${skippedRefs} 次因损伤对象不可读被跳过（涉及 ${failedRefs.size} 个引用${failedRefs.size ? '：' + [...failedRefs].slice(0, 6).map((r) => '`' + r + '`').join(' ') + (failedRefs.size > 6 ? ' …' : '') : ''}）。`);
L.push('- 本仓历史曾上传真实凭据 → 已完成消毒并把钥匙迁出仓库（执行报告 §十）；**8 把钥匙的轮换**仍未完成（人工事项）。');
L.push('');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const text = L.join('\n') + '\n';
fs.writeFileSync(OUT, text, 'utf8');

// 对账闸：表格行数必须与链长一致（防生成器悄悄漏行）
const tableRows = (text.match(/^\| \d+ \| \d{4}-\d{2}-\d{2} \|/gm) || []).length;
if (tableRows !== commits.length) {
  process.stderr.write(`生成异常（对账不通过）: 提交表 ${tableRows} 行 ≠ 链长 ${commits.length}\n`);
  process.exitCode = 1;
}
process.stdout.write(`生成 ${path.relative(REPO, OUT).replace(/\\/g, '/')} —— ${text.split('\n').length} 行 / ${fs.statSync(OUT).size} 字节\n`);
process.stdout.write(`  提交表 ${tableRows} 行；树 ${treeCount} 文件；全分支口径 ${allRefCommits} 提交；备份引用 ${backupRefs.length} 条\n`);
