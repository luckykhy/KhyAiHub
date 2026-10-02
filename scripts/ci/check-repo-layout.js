#!/usr/bin/env node
/**
 * 仓库层级/结构守卫 —— [DESIGN-LAY-005] 仓库层级板块规范 的强制执行者。
 *
 * Usage:
 *   node scripts/ci/check-repo-layout.js
 *   node scripts/ci/check-repo-layout.js --strict-warnings
 *   node scripts/ci/check-repo-layout.js --promote=root-whitelist,docs-index-first,layer-registry
 *   node scripts/ci/check-repo-layout.js --list=cross-layer-require,unresolved-require
 *   node scripts/ci/check-repo-layout.js --update-baseline
 *
 * 与 check-change-safety.js 共用一套 finding 形态（id / severity / --promote /
 * --strict-warnings / 未知 id 退 2）。本脚本刻意**全仓扫描**而非 --changed：
 * 层级是仓库的全局属性，只看改动集会漏掉「别人搬走了索引文件」这类破坏。
 *
 * 真源关系（改本脚本必须同步改文档，否则守卫与规范会各说各话）：
 *   - 层级清单 L0-L6 与横切层  → docs/10_规范/DESIGN-LAY/[DESIGN-LAY-005] 仓库层级板块规范.md 第一节
 *   - 根目录封闭白名单          → docs/08_MGMT_项目管理/MGMT-STD/[MGMT-STD-001] 项目文档结构与索引铁律规范.md 第 1.3 条
 *   - docs/ 索引首位铁律        → 同上 第 2.1/2.2 条与 CP-5
 *   - 任务入口命名与「每个入口须有脚本」→ [DESIGN-LAY-005] 第五节
 *   - 五域依赖方向 (domain-direction)   → docs/10_规范/registry/DOMAIN-DEPS.json（判据真源 [RESEARCH-018] §4 C-7）
 *   - 功能单元缺件 (functional-unit)     → 同上 §4 C-4 与 §2.3 模板，扫描范围取该表的 D2 roots
 *   - 源码入口缓冲 (entry-buffer)        → 同上 §4 C-5 与 §3 P5，范围/缓冲区/manifest 名取该表的 _entry_buffer 块
 *
 * HOW-TO-EXTEND（给维护者/小模型）：
 *   新增一条规则 = ①写一个 checkXxx(findings) 函数；②把 finding id 加进 ALL_FINDING_IDS；
 *   ③若是 warning-with-baseline 型，把 id 加进 BASELINE_IDS 并在 baseline json 里补一项；
 *   ④在 scripts/tests/check-repo-layout.test.js 补用例。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const repoRoot = process.env.KHY_REPO_LAYOUT_ROOT
  // 仅供 scripts/tests/check-repo-layout.test.js 指向临时 fixture 仓库使用。
  // 规则逻辑必须能脱离本仓库当时的真实状态被验证，否则「基线一改测试就绿」。
  ? path.resolve(process.env.KHY_REPO_LAYOUT_ROOT)
  : path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const strictWarnings = args.includes('--strict-warnings');
const updateBaseline = args.includes('--update-baseline');
const promotedIds = new Set(
  args
    .filter(arg => arg.startsWith('--promote='))
    .flatMap(arg => arg.slice('--promote='.length).split(','))
    .map(id => id.trim())
    .filter(Boolean)
);

const BASELINE_PATH = path.join(repoRoot, 'scripts', 'ci', 'repo-layout-baseline.json');

// --list=<id,id>：把这些 finding 的**全量**清单打出来（默认只打前几条预览）。
// 修存量违规时需要完整名单，翻 CI 日志比重跑一次便宜。
const listIds = new Set(
  args
    .filter(arg => arg.startsWith('--list='))
    .flatMap(arg => arg.slice('--list='.length).split(','))
    .map(id => id.trim())
    .filter(Boolean)
);

const ALL_FINDING_IDS = new Set([
  'root-whitelist',
  'root-junk',
  'docs-index-first',
  'layer-registry',
  'dangling-task',
  'cross-layer-require',
  'unresolved-require',
  'docs-index-complete',
  'extension-contract',
  'extension-id-hardcode',
  'extension-path-drift',
  'domain-direction',
  'functional-unit',
  'entry-buffer',
]);

// 这几条是「已知违规存量 + 只降不升」型：超过基线才升为 error。
const BASELINE_IDS = new Set([
  'dangling-task',
  'cross-layer-require',
  'unresolved-require',
  'docs-index-complete',
  'extension-contract',
  'extension-id-hardcode',
  'extension-path-drift',
  'domain-direction',
  'functional-unit',
  'entry-buffer',
]);

// ── 层级清单（真源 [DESIGN-LAY-005] 第一节）────────────────────────────────
const LAYERS = {
  kernel: 'L0 手写 OS 内核',
  platform: 'L1 Python 启动器 + 共享包 + 交付',
  services: 'L2 Node 运行时（全部业务逻辑）',
  apps: 'L3 平台自带管理前端',
  software: 'L4 跑在平台之上的内置应用',
  extensions: 'L5 内置拓展（随主包分发，契约见 [DESIGN-TOOL-002]）',
  tools: 'L6 独立开发者工具',
};
// 横切层：服务于所有层，不参与依赖判定（真源同上 第 1.2/1.4 节）。
const CROSSCUTTING = {
  docs: '全部文档',
  scripts: '工程任务脚本',
  packaging: '打包清单与板块切分',
  _source: '加密源码快照与恢复说明',
  // 运行时横切（与上面四项的「工程横切」不同类，但同样「服务于所有层、不参与依赖
  // 判定」，故登记在同一张表；真源 [DESIGN-LAY-005] 第 1.2 节）：
  // 多端入口的**真源数据**——有哪些端、入口在哪、怎么起、怎么构建。
  // 它必须待在根：Python 启动器、Node CLI、脚本与文档都要按路径读同一份表，
  // 埋进任何一层的实现目录都会让其余读取方绕路或触碰禁止边。实现（含
  // child_process）仍在 L2 `services/backend/src/services/entrypoints/`。
  // 规范 [DESIGN-ARCH-117]。
  entries: '多端入口真源数据（端矩阵 entries.json + 人读地图 + 跨平台入口壳）',
  // 软著登记底档（真源 [DESIGN-IP-001] C-E4，2026-09-28 由人拍板改为入库；层级登记见
  // [DESIGN-LAY-005] 第 1.2 节）。放根的理由：它的读取方横跨 L0（kernel 手写层原创规模）、
  // L1/L2（启动器与业务逻辑的开发过程存证）、L3/L4（界面截图）与横切（docs/ 设计决策、
  // scripts/ 采集器）。埋进任何一层都会让其余证据引用变成跨层路径读取。
  // 内容只有两类：人写的说明文档 + 由 scripts/evidence/ 从仓库实测数据派生的 JSON 与图片。
  evidence: '软著登记底档（人类贡献与原创性证据：说明文档 + 实测数据 JSON + 图片）',
  // 根级例外目录（真源 [DESIGN-LAY-005] 第 1.4 节）：不属 L0-L6，也不属
  // scripts/packaging/docs 这类工程横切，是历史遗留的根级实体，登记在册以免
  // 每次都被 layer-registry 判违规。
  electron: '根级 Electron 桌面壳（根 package.json 的 electron:dev 入口）',
  tests: '根级测试债务登记（DEBT.md，内容属文档性质，待迁 docs/05_TEST_测试/）',
  // 只收**交付物**；过程态工具（探针/扫描脚本/未接线原型）落 .khyos/，判据真源
  // [DESIGN-LAY-002] §3.1（2026-09-29 分流，此前两类混住，见该节表格）。
  '_产物': '根级工作产物暂存区（交付物：诊断报告/能力矩阵/方案文档，含非文档资产）',
  deploy: '根级部署配置与试验（deploy/free-test/）',
  patches: '根级第三方依赖补丁（npm 依赖的本地 patch）',
};
// 构建/打包工具在仓库根生成的目录，不是源码层。保持封闭集合，新增项须有对应忽略规则。
const GENERATED_TOP_LEVEL_DIRS = new Set(['build', 'dist', 'dist-electron', 'khy_os.egg-info']);

// ── 根目录白名单（真源 [MGMT-STD-001] 第 1.3 条，封闭、严禁扩张）──────────────
// 说明性文件白名单：README 及其语言变体 + 平台/工具链按根路径强制加载的文件。
const ROOT_DOC_WHITELIST = new Set([
  'README.md',
  'LICENSE',
  'LICENSE.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'AGENTS.md',
  'CLAUDE.md',
  'khy.md',
]);
const README_VARIANT_RE = /^README(?:\.[A-Za-z-]+)?\.md$/;
// 只有 .md / .txt 属「说明性文件」范畴；其余扩展名（.json/.toml/.bat/.sh…）不在本规则内。
const ROOT_DOC_EXT_RE = /\.(?:md|txt)$/i;

// ── 规则 1b：根目录垃圾签名（CP-1 补充）──────────────────────────────────────
// 规则 1 只扫 `.md`/`.txt` 且只扫**文件**，因此下面这些现场真实落地的残留
// 全部在它视野之外、门禁一路绿着放行（历史 commit dafef34c 曾手工清过一批
// 同类垃圾，说明这是复发问题，必须由门禁兜住而不是靠人记得清）：
//   `1` / `console.log(r))` / `console.log((11441+i)+'`  → 重定向或贴错的截断名
//   `tmp-*.js` / `tmp-*.out` / `tmp-*.txt`（20+ 个）      → 临时探测产物
//   `_flagcheck.txt` / `_gitst.txt` / `_p*.txt`            → 下划线开头的一次性笔记
//   `.coverage` / `.tmp_startup_lines.txt`                 → 构建工具残留
//   `-p/`                                                  → shell 事故目录
//
// 取向是**高精度签名**：只抓「明显是临时/事故产物」的名字，不试图枚举合法根文件
// （那需要一个封闭白名单 —— 属方案文档 Phase 2，可随时收严）。
const ROOT_JUNK_FILE_RES = [
  /^tmp[-_.]/i, // tmp-x / tmp_x / tmp.x
  /^_/, // _flagcheck.txt / _gitst.txt / _p2.txt
  /^\d+$/, // 1 之类纯数字（重定向事故）
  /^\.(?:tmp|coverage|nyc_output|eslintcache|stylelintcache)/i, // .coverage / .tmp_*
  /[-+]{1,}$/, // 以运算符结尾（命令被行尾截断的痕迹）
  /[(){}'"`\s]/, // 含 shell/jest 元字符：合法仓库文件名不会带这些
];
// 目录只吃更窄的签名：`_产物`/`对齐` 这类是**未登记**（layer-registry 负责），
// 不是垃圾，不能在这里误伤。
const ROOT_JUNK_DIR_RES = [/^-/, /^tmp[-_.]/i, /[(){}'"`\s]/];

function _matchesAny(res, name) {
  return res.some((re) => re.test(name));
}

/** 根目录条目名是否命中垃圾签名。绝不抛。 */
function isRootJunkName(name) {
  try {
    const n = String(name == null ? '' : name);
    if (!n) {
      return false;
    }
    return _matchesAny(ROOT_JUNK_FILE_RES, n);
  } catch {
    return false;
  }
}

/** 从 readdir 结果里挑出垃圾条目名（文件与目录用各自的签名）。绝不抛。 */
function findRootJunkEntries(entries) {
  try {
    if (!Array.isArray(entries)) {
      return [];
    }
    return entries
      .filter((e) => e && typeof e.name === 'string' && e.name)
      .filter((e) =>
        e.isDirectory ? _matchesAny(ROOT_JUNK_DIR_RES, e.name) : isRootJunkName(e.name)
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function checkRootJunk(findings) {
  const offenders = findRootJunkEntries(
    fs.readdirSync(repoRoot, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    }))
  );
  if (offenders.length === 0) return;
  findings.push({
    id: 'root-junk',
    severity: 'error',
    message: `根目录有 ${offenders.length} 个临时/事故残留（[MGMT-STD-001] 第 1.3 条，CP-1 补充）。`,
    detail: `删除或收容进 .khy/tmp 后重跑：${offenders.join(', ')}`,
    full: offenders,
  });
}

// ── 跨层深引用（真源 [DESIGN-LAY-005] 第二节禁止边）─────────────────────────
// workspace 根：一个 require 若从文件所在 workspace 根逃出去，就是跨包深引用。
const WORKSPACE_ROOTS = [
  'services/backend',
  'services/ai-backend',
  'apps/ai-frontend',
  'software/khyquant',
  'software/khyquant/frontend',
  'platform/packages/shared',
  'platform/packages/moonbit-plugin-sdk',
  'platform/delivery',
  'extensions/tools/khy-markdown',
  'tools/deepseek-eyes',
  'extensions/bridges/khy-trae-bridge',
];

function git(cmdArgs) {
  try {
    return cp.execFileSync('git', cmdArgs, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

function toPosix(p) {
  return String(p || '').replace(/\\/g, '/');
}

// ── 规则 1：根目录说明性文件白名单（CP-1）──────────────────────────────────
function checkRootWhitelist(findings) {
  const offenders = fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => ROOT_DOC_EXT_RE.test(name))
    .filter(name => !ROOT_DOC_WHITELIST.has(name) && !README_VARIANT_RE.test(name))
    .sort();

  if (offenders.length === 0) return;
  findings.push({
    id: 'root-whitelist',
    severity: 'error',
    message: `根目录有 ${offenders.length} 个白名单外的说明性文件（[MGMT-STD-001] 第 1.1/1.2 条，CP-1）。`,
    detail: `须收容进 docs/ 对应子目录：${offenders.join(', ')}`,
    full: offenders,
  });
}

// ── 规则 2：docs/ 分类目录须有排序首位的 00_INDEX_*（第 2.1/2.2 条，CP-5）────
// 只查 docs/ 的一级子目录，且只查「直接含 .md 的目录」——这样 19_资产/（纯资产）
// 与 _ref/（爬取样本）不会被误判，无需维护特例名单。
function checkDocsIndexFirst(findings) {
  const docsRoot = path.join(repoRoot, 'docs');
  if (!fs.existsSync(docsRoot)) return;

  const missing = [];
  const notFirst = [];
  for (const entry of fs.readdirSync(docsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(docsRoot, entry.name);
    const names = fs.readdirSync(dir).sort();
    const markdown = names.filter(n => n.toLowerCase().endsWith('.md'));
    if (markdown.length === 0) continue;

    const indexes = markdown.filter(n => n.startsWith('00_INDEX_'));
    if (indexes.length === 0) {
      missing.push(`docs/${entry.name}/`);
      continue;
    }
    if (markdown[0] !== indexes[0]) {
      notFirst.push(`docs/${entry.name}/ (首位是 ${markdown[0]})`);
    }
  }

  if (missing.length > 0) {
    findings.push({
      id: 'docs-index-first',
      severity: 'error',
      message: `${missing.length} 个 docs/ 分类目录缺总领索引 00_INDEX_*（[MGMT-STD-001] 第 2.1 条，CP-4）。`,
      detail: missing.join(', '),
    });
  }
  if (notFirst.length > 0) {
    findings.push({
      id: 'docs-index-first',
      severity: 'error',
      message: `${notFirst.length} 个 docs/ 分类目录的索引未居字典序首位（第 2.2 条，CP-5）。`,
      detail: notFirst.join(', '),
    });
  }
}

// ── 规则 2.5：主索引须列全每个阶段目录的文档（[MGMT-STD-001] CP-3）──────────
// 规则 2 只管「每个目录有没有就近索引」，管不到「主入口 docs/00_INDEX_文档索引.md
// 有没有漏链」。实测漏链是三位数量级，故走 warning + 基线只降不升，而不是一次性硬门。
//
// 匹配方式：主索引里的链接是百分号编码的（`%5B` = `[`、`%20` = 空格），
// 先把这三种还原再做纯文本包含判断。只要文件名在页面任意处出现（链接或正文提及）
// 就算「已列」——本规则查的是**可达性**，不是链接语法是否规范。
const MASTER_INDEX_REL = 'docs/00_INDEX_文档索引.md';
// 阶段目录 = `01`–`09`（生命周期阶段段）。`10`–`19` 是**跨阶段段**（规范/报告/模板/传承/
// 维护者/维护记录/设计模式/AI协作预设包/归档/资产），不属于任何单一阶段，完整性由各自目录内的
// `00_INDEX_*` 就近索引维护（`docs-index-first` 仍会查它们有没有索引），**不要求**在主索引逐篇点名。
// 真源：`[DESIGN-LAY-005]` §3.1「01–09 阶段 / 10–19 跨阶段」。
// 2026-09-16 前这批目录用 `_` 前缀，天然不被本正则命中；双轴收敛为编号轴后，
// 若仍用 /^\d{2}_/ 会把它们误判为阶段目录（实测一次冒出 78 条假漏链），故收窄为 0[1-9]。
const STAGE_DIR_RE = /^0[1-9]_/;
// 02/09 两个小白向目录**刻意不**要求主索引逐篇点名：它们的可达性由另一条守卫
// scripts/docs/check_beginner_docs.js（`npm run docs:check-beginner`）保证——
// 禁孤儿页、禁死链、禁无导航死胡同页，比「主索引里有没有这一行」更强。
// 主索引只链它们的目录入口。改动此豁免须同步改 [MGMT-STD-001] CP-3 的落地说明。
const MASTER_INDEX_EXEMPT_DIRS = new Set(['02_CONCEPTS_概念入门', '09_STORY_修仙学AI']);

// B8（2026-09-18）去重写法：主索引**不再被要求逐篇点名**阶段文档。
// 覆盖判据放宽为「主索引里有」**或**「本阶段目录自己的 00_INDEX_* 就近索引里有」——
// 后者才是清单的真源，主索引退回「导读」角色（[MGMT-PLAN-009] §2 五层骨架 L-D0）。
// 这样做的收益：新增阶段文档只要登记就近索引即合规，不必再往主索引里塞一行，
// 主索引不再因「必须列举全部」而无限膨胀、也不必与就近索引重复同一份清单。
// 仍会亮红的只剩「两处都没有」的真漏链。被就近索引接管的份数另计入
// `docs-index-delegated`（观察口径，不入基线、不判违规）。

function decodeIndexText(raw) {
  return raw
    .replace(/%5B/gi, '[')
    .replace(/%5D/gi, ']')
    .replace(/%20/gi, ' ');
}

function checkDocsIndexComplete(findings, counts) {
  const masterPath = path.join(repoRoot, MASTER_INDEX_REL);
  const docsRoot = path.join(repoRoot, 'docs');
  counts['docs-index-complete'] = 0;
  counts['docs-index-delegated'] = 0;
  if (!fs.existsSync(masterPath) || !fs.existsSync(docsRoot)) return;

  const text = decodeIndexText(fs.readFileSync(masterPath, 'utf8'));
  const stageDirs = fs
    .readdirSync(docsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && STAGE_DIR_RE.test(entry.name))
    .filter(entry => !MASTER_INDEX_EXEMPT_DIRS.has(entry.name))
    .map(entry => entry.name)
    .sort();

  const missing = [];
  const perStage = {};
  let delegated = 0;
  for (const dir of stageDirs) {
    const dirPath = path.join(docsRoot, dir);
    // 就近索引：本阶段目录自己的 00_INDEX_*.md —— 阶段内清单的真源（B8）。
    const nearbyText = fs
      .readdirSync(dirPath)
      .filter(name => name.toLowerCase().endsWith('.md') && name.startsWith('00_INDEX_'))
      .map(name => decodeIndexText(fs.readFileSync(path.join(dirPath, name), 'utf8')))
      .join('\n');
    let dirMissing = 0;
    for (const name of fs.readdirSync(dirPath).sort()) {
      if (!name.toLowerCase().endsWith('.md')) continue;
      // 就近索引自身不必被主索引逐个点名（主索引按阶段分区链接正文文档）。
      if (name.startsWith('00_INDEX_')) continue;
      if (text.includes(name)) continue;
      // 就近索引已收录 → 视为主索引的合法委派，不再算漏链（B8 去重）。
      if (nearbyText.includes(name)) {
        delegated += 1;
        continue;
      }
      missing.push(`docs/${dir}/${name}`);
      dirMissing += 1;
    }
    if (dirMissing > 0) perStage[dir] = dirMissing;
  }

  counts['docs-index-complete'] = missing.length;
  counts['docs-index-delegated'] = delegated;
  if (missing.length === 0) return;

  const breakdown = Object.entries(perStage)
    .map(([dir, n]) => `${dir} ${n}`)
    .join(' / ');
  findings.push({
    id: 'docs-index-complete',
    severity: 'warning',
    message: `${missing.length} 份阶段文档既不在主索引 ${MASTER_INDEX_REL}、也不在本阶段就近 00_INDEX_* 里（CP-3 漏链）。`,
    detail:
      `分布：${breakdown}。另有 ${delegated} 份由就近索引接管（主索引已不必逐篇点名，B8 去重）；` +
      `排查时以就近索引为准；全量名单用 --list=docs-index-complete。`,
    full: missing,
  });
}


function checkLayerRegistry(findings) {
  const known = new Set([...Object.keys(LAYERS), ...Object.keys(CROSSCUTTING)]);
  const unregistered = fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    // 点目录（.git/.github/.khy…）、node_modules 与声明过的生成目录不属层级体系。
    .filter(name => !name.startsWith('.') && name !== 'node_modules')
    .filter(name => !GENERATED_TOP_LEVEL_DIRS.has(name))
    .filter(name => !known.has(name))
    .sort();

  if (unregistered.length === 0) return;
  findings.push({
    id: 'layer-registry',
    severity: 'error',
    message: `${unregistered.length} 个顶层目录未登记在层级清单里。`,
    detail:
      `${unregistered.join(', ')} —— 要新增顶层目录，先改 ` +
      `docs/10_规范/DESIGN-LAY/[DESIGN-LAY-005] 仓库层级板块规范.md 第一节，再改本脚本的 LAYERS / CROSSCUTTING。`,
  });
}

// ── 规则 8：extensions/ 下每个目录都须遵守拓展契约 ────────────────────────
// 真源 docs/10_规范/其它规范/[DESIGN-TOOL-002] 拓展契约与核心边界规范.md 第三节。
// 字段清单同时在 services/backend/src/services/extensions/extensionRoots.js 落地；
// 这里刻意**不 require** 那个模块 —— 守卫属横切层，按 [DESIGN-LAY-005] 第二节
// 「任何层 → L5/L6」的禁止边，scripts/ 只许按路径操作，不许 import L2 的实现。
// 代价是两处各有一份字段名，收益是守卫不会因为被守卫的代码坏掉而一起坏掉。
const EXTENSION_MANIFEST = 'khy.extension.json';
const EXTENSION_KINDS = new Set(['runtime', 'ide-bridge', 'asset', 'toolchain', 'reference']);

// 仓库自己的分类名白名单（真源 [DESIGN-TOOL-002] §2.3 的表；来自用户原话枚举的六类：
// tool / plugin / scripts / mcp / software / 协议）。
//
// 加载器**不**认这份表 —— 它只认「有没有 manifest」，任何空壳目录都能当分类（见
// extensionRoots 的 MAX_DEPTH 注释）。收敛分类名纯属**仓库卫生**：不收的话
// extensions/ 会长出一棵谁也说不清的树，而那正是本契约要消灭的东西。用户目录与
// KHY_EXTENSION_PATH 下的拓展不受这条约束 —— 那是别人的磁盘，不是本仓的卫生。
const EXTENSION_CATEGORIES = new Set(['tools', 'protocols', 'mcp', 'scripts', 'software', 'bridges']);

function listSubdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(name => !name.startsWith('.') && name !== 'node_modules')
      .sort();
  } catch {
    return [];
  }
}

/**
 * 枚举 extensions/ 下的拓展目录，深度与 extensionRoots.discover() 一致（两层，§2.3）。
 *
 * 刻意重复实现而不 require 那个模块：守卫属横切层，按 [DESIGN-LAY-005] 第二节的禁止边
 * scripts/ 不许 import L2 的实现 —— 代价是两份深度逻辑，收益是守卫不会因为被守卫的
 * 代码坏掉而一起坏掉。两处的一致性由 contribToolLifecycle.test.js 的分类用例组兜住。
 *
 * 与加载器的一处**刻意差异**：这里用「manifest 文件存在」判定是不是拓展，加载器用
 * 「manifest 可解析」。于是 JSON 写坏的目录在加载器眼里退化成分类目录（下面没东西 →
 * 静默消失），在守卫眼里仍是一个坏拓展 —— 该报出来，而不是跟着一起消失。
 *
 * @returns {{extensions: Array<{rel:string,abs:string,id:string,category:string|null}>,
 *           structural: string[]}} structural 是布局本身的违规（分类名越界、说不清的目录）
 */
function collectExtensionDirs(extRoot) {
  const extensions = [];
  const structural = [];
  for (const name of listSubdirs(extRoot)) {
    const abs = path.join(extRoot, name);
    if (fs.existsSync(path.join(abs, EXTENSION_MANIFEST))) {
      // 自带 manifest → 是拓展，不再下探（与加载器同一优先级：显式声明胜过结构推断）
      extensions.push({ rel: `extensions/${name}`, abs, id: name, category: null });
      continue;
    }
    const children = listSubdirs(abs);
    const inner = children.filter(c => fs.existsSync(path.join(abs, c, EXTENSION_MANIFEST)));
    if (inner.length === 0) {
      structural.push(
        `extensions/${name} —— 既不是拓展（缺 ${EXTENSION_MANIFEST}）也不是分类目录（下面没有任何拓展）`
      );
      continue;
    }
    if (!EXTENSION_CATEGORIES.has(name)) {
      structural.push(
        `extensions/${name} —— 分类名不在 ${[...EXTENSION_CATEGORIES].join(' / ')} 内`
      );
    }
    for (const child of children) {
      const childAbs = path.join(abs, child);
      if (!inner.includes(child)) {
        structural.push(
          `extensions/${name}/${child} —— 缺 ${EXTENSION_MANIFEST}；` +
            `分类目录下只能直接放拓展，不能再套一层分类（发现只下探两层）`
        );
        continue;
      }
      extensions.push({
        rel: `extensions/${name}/${child}`,
        abs: childAbs,
        id: child,
        category: name,
      });
    }
  }
  return { extensions, structural };
}

/**
 * v2.0 扩展契约严格校验。
 * 新增校验项：
 *   - kind 不能是 'asset'（应改为 'toolchain' 或 'reference'）
 *   - commands 不能为空数组（应列出所有可执行入口）
 *   - provides 必须存在且非空
 */
function _checkV2ExtensionViolations(manifest, rel, violations) {
  // kind 校验：v2.0 不允许 'asset'（只读资源应使用 'reference' 或 'toolchain'）
  if (manifest.kind === 'asset') {
    violations.push(`${rel} —— v2.0 契约不允许 kind=asset，应改为 toolchain 或 reference`);
  }

  // commands 校验：v2.0 要求列出所有可执行入口（reference 类型豁免）
  if (Array.isArray(manifest.commands) && manifest.commands.length === 0 && 
      manifest.kind !== 'asset' && manifest.kind !== 'reference') {
    violations.push(`${rel} —— v2.0 契约要求 commands 列出所有可执行入口（空数组仅允许 kind=asset 或 kind=reference）`);
  }

  // provides 校验：v2.0 要求声明提供的能力（reference 类型豁免）
  if ((!Array.isArray(manifest.provides) || manifest.provides.length === 0) && 
      manifest.kind !== 'reference') {
    violations.push(`${rel} —— v2.0 契约要求 provides 声明提供的能力（非空数组，reference 类型豁免）`);
  }
}

function checkExtensionContract(findings, counts) {
  const extRoot = path.join(repoRoot, 'extensions');
  if (!fs.existsSync(extRoot)) {
    counts['extension-contract'] = 0;
    return; // 没有 extensions/ 目录 → 无可违规（fixture 仓库的常态）
  }
  const { extensions, structural } = collectExtensionDirs(extRoot);

  const violations = [...structural];
  for (const { rel, abs, id: name } of extensions) {
    const manifestPath = path.join(abs, EXTENSION_MANIFEST);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      violations.push(
        `${rel} —— ${err.code === 'ENOENT' ? `缺 ${EXTENSION_MANIFEST}` : `${EXTENSION_MANIFEST} 不是合法 JSON`}`
      );
      continue;
    }
    if (!manifest || typeof manifest !== 'object') {
      violations.push(`${rel} —— ${EXTENSION_MANIFEST} 顶层不是对象`);
      continue;
    }

    // schemaVersion 校验（v2.0 契约版本化）
    const schemaVersion = manifest.schemaVersion || '1.0';
    if (schemaVersion === '2.0') {
      // v2.0 严格校验
      _checkV2ExtensionViolations(manifest, rel, violations);
    }
    // v1.0 宽松校验（保持向后兼容）
    // id 必须等于**叶子**目录名：否则「删目录即消失」的键就藏在文件内容里，孤儿检测
    // 无从核对。分类名刻意不进 id（§2.3）—— 移进分类目录不得改变拓展身份。
    if (manifest.id !== name) {
      violations.push(`${rel} —— id (${JSON.stringify(manifest.id)}) 与目录名不一致`);
    }
    const kind = manifest.kind === undefined ? 'runtime' : manifest.kind;
    if (!EXTENSION_KINDS.has(kind)) {
      violations.push(`${rel} —— kind (${JSON.stringify(manifest.kind)}) 不在 ${[...EXTENSION_KINDS].join(' / ')} 内`);
    } else if (kind === 'runtime') {
      // runtime 拓展的入口必须现在就能解析到：一个指向空气的 main 只会在首次调用
      // 时才暴露，而那时报的是「未知命令」，没人会想到是 manifest 写错了。
      if (typeof manifest.main !== 'string' || !manifest.main) {
        violations.push(`${rel} —— kind=runtime 但没声明 main`);
      } else if (!fs.existsSync(path.join(abs, manifest.main))) {
        violations.push(`${rel} —— main (${manifest.main}) 在磁盘上不存在`);
      }
    } else if (kind === 'toolchain') {
      // toolchain 的入口不是 main 而是 commands[].script（核经 ext-run 起子进程调它）。
      // 这里必须现在就核对：ext-run 只有在**用户真的敲了那条命令**时才会发现脚本不存在，
      // 而那通常是发布当天。manifest 说得出名字就得指得出脚本。
      for (const cmd of Array.isArray(manifest.commands) ? manifest.commands : []) {
        if (!cmd || typeof cmd.name !== 'string' || !cmd.name) {
          violations.push(`${rel} —— commands 里有一条没有 name`);
          continue;
        }
        if (typeof cmd.script !== 'string' || !cmd.script) {
          violations.push(`${rel} —— kind=toolchain 的命令 "${cmd.name}" 没声明 script`);
        } else if (!fs.existsSync(path.join(abs, cmd.script))) {
          violations.push(`${rel} —— 命令 "${cmd.name}" 的 script (${cmd.script}) 在磁盘上不存在`);
        }
      }
    }
  }

  counts['extension-contract'] = violations.length;
  if (violations.length === 0) return;
  findings.push({
    id: 'extension-contract',
    severity: 'warning',
    message: `${violations.length} 处 extensions/ 目录不合拓展契约。`,
    detail:
      `${violations.slice(0, 3).join('；')}${violations.length > 3 ? ' …' : ''} —— 契约见 ` +
      `docs/10_规范/其它规范/[DESIGN-TOOL-002] 拓展契约与核心边界规范.md 第三节；` +
      `全量清单用 --list=extension-contract。`,
    full: violations,
  });
}

// ── 规则：核里不得硬编码拓展 id ──────────────────────────
// 真源 [DESIGN-TOOL-002] §1.3 第四条：「核里**不允许**出现任何拓展 id 的硬编码分支」。
//
// 为什么需要机器强制：这条此前靠人守，而人没守住 —— khy-markdown 一个拓展就在核里
// 积了**三份**互不认识的定位逻辑，其中 docs.js 那份在拓展迁目录后指向空气，
// 而 fail-soft 把失败掩成一句提示，`khy docs browse` 静默坏了一整轮无人发觉。
// 硬编码一个 id 的代价不是「不够优雅」，是下一次移动时多一处会烂掉的路径。
//
// **只算分派用途的字面量**。注释与面向用户的提示文案不算：一句「未找到 khy-markdown
// 拓展」不是分支，禁掉它只会逼人把有用的错误信息写模糊，对架构没有任何好处。
// 判据是字面量是否出现在**代码**里（剥掉注释后仍在）且**不在字符串拼接的提示上下文**。
const CORE_SCAN_DIRS = ['services/backend/src'];
// 允许名单：**文件 → 该文件被豁免的 id 集合**（`'*'` = 整文件豁免）。
//
// 为什么是「文件 + id」而不是整文件：整文件豁免会连带放过这个文件**将来**新写的
// 真·分派分支，等于把守卫在这个文件上永久关掉。按 id 登记则只放过已知的那一条，
// 别的 id 一出现照报。
//
// 什么算正当理由：只有「该字面量不是为了在运行机器上定位一个拓展」。
// 描述**仓库布局**（重建源码包时要复制哪个目录）与记述**历史**（bug 案例的文件清单）
// 都属此类——它们换成服务名既无意义也无从解析，因为那时根本没有一个在位的拓展可解析。
// 名单保持封闭：新增项须在此显式登记并写明理由。
const EXTENSION_ID_ALLOWLIST = new Map([
  // 契约自身的实现件：它必须能写出 id，否则契约模块过不了它自己的规则。
  ['services/backend/src/services/extensions/markdownWorkbench.js', '*'], // LEGACY_ID 迁移期兜底
  // pip 源码包重建：它按**仓库布局**逐目录复制（'docs'、'frontend'、'packages/shared' 同理），
  // 描述的是要重建出的那棵树长什么样，不是在这台机器上找一个已安装的拓展。
  ['services/backend/src/cli/handlers/publish.js', new Set(['khy-alpine-iso'])],
  // 历史 bug 案例数据集：files[] 记的是**当年那次事故**改了哪些文件，是史料不是分派。
  ['services/backend/src/data/bugCases.js', new Set(['khy-alpine-iso'])],
]);

/** 该文件的该 id 是否已登记豁免。 */
function _idAllowed(file, id) {
  const entry = EXTENSION_ID_ALLOWLIST.get(file);
  if (!entry) return false;
  return entry === '*' || entry.has(id);
}

/**
 * 把一份源码剥成「只剩会被执行的代码」的逐行数组。
 *
 * 剥掉两类**不算分支**的文本：
 *   ① 注释（行注释 + 跨行块注释）—— 注释记述历史、指路、写迁移说明，本来就该能提 id；
 *   ② 含中文的字符串字面量 —— 面向用户的提示文案。禁掉它只会逼人把
 *      「未找到 khy-markdown 拓展」写成「未找到拓展」，对架构毫无好处，只是让报错变模糊。
 *
 * 必须整文件扫而不是逐行扫：JSDoc 的续行长这样 `  * 底层复用 khy-markdown 拓展`，
 * 单看这一行没有任何注释标记，逐行剥离会把整个文档块当成代码 —— 那正是本规则
 * 第一版 6 个命中里 5 个是误报的原因。块注释状态必须跨行保持。
 *
 * @param {string} text 源码全文
 * @returns {string[]} 与原文行号一一对应的「代码残余」（被剥掉的部分留空串）
 */
function stripToCode(text) {
  const src = text.split(/\r?\n/);
  const out = new Array(src.length).fill("");
  let inBlock = false;
  for (let li = 0; li < src.length; li++) {
    const line = src[li];
    let acc = "";
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const close = line.indexOf("*/", i);
        if (close === -1) { i = line.length; break; }
        inBlock = false;
        i = close + 2;
        continue;
      }
      const c = line[i];
      if (c === "/" && line[i + 1] === "/") break;          // 行注释 → 丢弃本行剩余
      if (c === "/" && line[i + 1] === "*") { inBlock = true; i += 2; continue; }
      if (c === "'" || c === "\"" || c === "`") {
        const quote = c;
        let j = i + 1;
        let body = "";
        while (j < line.length) {
          if (line[j] === "\\") { body += line[j + 1] || ""; j += 2; continue; }
          if (line[j] === quote) break;
          body += line[j];
          j += 1;
        }
        // 含中文 → 提示文案，抹掉；纯 ASCII → 可能是分派用的 id，保留。
        acc += /[\u4e00-\u9fa5]/.test(body) ? "" : quote + body + quote;
        i = j + 1;
        continue;
      }
      acc += c;
      i += 1;
    }
    out[li] = acc;
  }
  return out;
}

function checkExtensionIdHardcode(findings, counts) {
  const extRoot = path.join(repoRoot, 'extensions');
  if (!fs.existsSync(extRoot)) {
    counts['extension-id-hardcode'] = 0;
    return;
  }
  // 两层枚举（§2.3）：拓展可能在 extensions/<分类>/<id>。只看一层的话，一批拓展
  // 移进分类目录后这条守卫会静默变成空转 —— 「核里不许点名拓展 id」从此不再被检查。
  const ids = collectExtensionDirs(extRoot)
    .extensions
    // kind: ide-bridge 不纳入。它交付的是给外部 IDE 安装的 VSIX，宿主是 IDE 而不是
    // khy 进程（契约 §2.2：核**不激活**它）。核里写它的名字时，拼的是
    // `<IDE globalStorage>/<id>/` 这种由 **IDE 侧**规则决定的路径 —— 那不是
    // 「核为了找拓展而点名它」，而是读一个外部系统按它自己规则存的文件，
    // 改成服务名也无法影响它。强制这类 id 只会造出无法修复的违规。
    .filter(({ abs }) => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(abs, EXTENSION_MANIFEST), 'utf8'));
        return !m || m.kind !== 'ide-bridge';
      } catch {
        return true; // 读不到 manifest → 保守地纳入（extension-contract 那条会先报它）
      }
    })
    .map(({ id }) => id);
  if (ids.length === 0) {
    counts['extension-id-hardcode'] = 0;
    return;
  }

  // 用目录 pathspec + 后缀过滤，而不是 `${d}/**/*.js`：git 的 pathspec 里 `**`
  // 不是递归通配，`src/**/*.js` 匹配不到直接放在 src/ 下的文件 —— 真实仓库
  // 因为核代码都在子目录里才碰巧有结果，夹具里一放到 src/ 根下就静默漏掉。
  const files = git(['ls-files', ...CORE_SCAN_DIRS])
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean)
    .filter(f => f.endsWith('.js'))
    .filter(f => !f.includes('node_modules/'))
    .filter(f => EXTENSION_ID_ALLOWLIST.get(f) !== '*');

  const violations = [];
  for (const rel of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    // 快通道：整文不含任何 id 就不必逐行剥离。
    if (!ids.some(id => text.includes(id))) continue;
    const lines = stripToCode(text);
    for (let i = 0; i < lines.length; i++) {
      const code = lines[i];
      for (const id of ids) {
        if (code.includes(id) && !_idAllowed(rel, id)) {
          violations.push(`${rel}:${i + 1} —— 硬编码拓展 id ${JSON.stringify(id)}`);
          break;
        }
      }
    }
  }

  counts['extension-id-hardcode'] = violations.length;
  if (violations.length === 0) return;
  findings.push({
    id: 'extension-id-hardcode',
    severity: 'warning',
    message: `${violations.length} 处核代码硬编码了拓展 id。`,
    detail:
      `${violations.slice(0, 3).join('；')}${violations.length > 3 ? ' …' : ''} —— ` +
      `改用服务名定位（manifest 的 provides + extensionRoots.findProvider），契约见 ` +
      `docs/10_规范/其它规范/[DESIGN-TOOL-002] 拓展契约与核心边界规范.md §1.3；` +
      `全量清单用 --list=extension-id-hardcode。`,
    full: violations,
  });
}

// ── 规则 4：npm run 目标须能解析到已定义脚本 ──────────────────────────────

// 非目标名的「引用」形态。规则本意是「文档承诺了一条命令，它必须真的存在」，
// 但 `npm run <token>` 这个字面形态在四类语境里并不构成承诺，收进集合只会制造
// 误报（公理 A4：误报比漏报更贵）。这四类全部有实证（2026-09-19 全量 98 条分类）：
//   ① 通配符截断   `npm run check:*` → 正则 `[a-zA-Z0-9:_-]+` 吃到 `check:`；
//      仓内实例：check: / test: / portable: / quality: / memory:restore:
//   ② 占位符与夹具  文档里的 `npm run X`（[DESIGN-LAY-005] §5.1 自己举的反例）、
//      测试夹具里的假命令名（scripts/tests/buildDepsCleanup.test.js 用 `npm run x`、
//      `npm run rebuild-me`；check-agent-docs.js 用 `npm run does-not-exist`）。
//      **夹具的假名被当成真违规**，这是最不该发生的误报。
//   ③ 尖括号形式   `npm run <目标>` —— [DESIGN-LAY-005] §5.1 指定的占位符写法。
//   ④ 非命令语境   诊断/对比报告里描述**别人**的做法（[MGMT-RPT-005] 写
//      「KHY 缺 CI pipeline | npm run test:ci」是描述缺失，不是本仓承诺）。
//      这一类靠名字无法判别，仍由基线棘轮兜底，不在此处排除。
const TASK_NON_TARGETS = new Set([
  // ② 占位符 / 测试夹具里的假命令名
  'X', 'x',
  'does-not-exist',
  'rebuild-me',
  'targets',
  'foo', 'bar', 'baz', // 常见的占位示例名
]);

function isNonTargetTask(target) {
  if (!target) return true;
  // ① 通配符/示例被截断：`check:*`、`test:<单场景>` 一律留下尾冒号
  if (target.endsWith(':')) return true;
  // ③ 尖括号占位：`<目标>`、`<name>`
  if (/^<.*>$/.test(target)) return true;
  // ② 明确的占位/夹具名单
  if (TASK_NON_TARGETS.has(target)) return true;
  return false;
}

function collectDefinedScripts() {
  const defined = new Set();
  const manifests = git(['ls-files', '*package.json'])
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(p => !p.includes('node_modules/'));

  for (const rel of manifests) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
      for (const name of Object.keys(parsed.scripts || {})) defined.add(name);
    } catch {
      /* 坏 json 由 check:json-schemas 负责，这里不重复报 */
    }
  }
  return defined;
}

function collectReferencedTasks() {
  const out = git(['grep', '-I', '-o', '-h', '-E', 'npm run [a-zA-Z0-9:_-]+']);
  const referenced = new Map(); // target -> count
  for (const line of out.split('\n')) {
    const match = line.match(/npm run ([a-zA-Z0-9:_-]+)/);
    if (!match) continue;
    const target = match[1];
    // `npm run --workspace …` 之类的 flag 形态不是目标名。
    if (target.startsWith('-')) continue;
    // 通配符截断 / 占位符 / 测试夹具里的假命令名 —— 不是「文档承诺了这条命令」，
    // 详见 isNonTargetTask() 上方注释。
    if (isNonTargetTask(target)) continue;
    referenced.set(target, (referenced.get(target) || 0) + 1);
  }
  return referenced;
}

function checkDanglingTasks(findings, counts) {
  const defined = collectDefinedScripts();
  const referenced = collectReferencedTasks();
  const dangling = [...referenced.keys()].filter(t => !defined.has(t)).sort();
  counts['dangling-task'] = dangling.length;
  if (dangling.length === 0) return;

  const preview = dangling.slice(0, 12).join(', ');
  findings.push({
    id: 'dangling-task',
    severity: 'warning',
    message: `${dangling.length} 个被引用的 npm run 目标没有对应脚本定义（[DESIGN-LAY-005] 第 5.1 节）。`,
    detail: `${preview}${dangling.length > 12 ? ` …（共 ${dangling.length} 个，全量用 --list=dangling-task）` : ''}`,
    full: dangling,
  });
}

// ── 规则 5：跨 workspace 的深层相对 require ───────────────────────────────
function workspaceRootOf(relFile) {
  // 取最长匹配，使 software/khyquant/frontend 优先于 software/khyquant。
  let best = null;
  for (const root of WORKSPACE_ROOTS) {
    if (relFile === root || relFile.startsWith(`${root}/`)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  return best;
}

// 纯 re-export 壳文件：整个文件（去掉注释与空行）就是一句
// `module.exports = require('…')`。这是仓库里刻意的**兼容别名**手法 ——
// services/backend 保持自己的稳定路径，实现归 software/khyquant 所有。
// 它不引入逻辑耦合，只是一个路径别名，所以不计入 cross-layer-require；
// 但仍会做存在性校验（落到 unresolved-require），因为壳指空是必崩的。
const SHIM_CACHE = new Map();
function isPureReexportShim(relFile) {
  if (SHIM_CACHE.has(relFile)) return SHIM_CACHE.get(relFile);
  let verdict = false;
  try {
    const body = fs
      .readFileSync(path.join(repoRoot, relFile), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('//'))
      .join(' ');
    verdict = /^module\.exports\s*=\s*require\((['"])[^'"]+\1\);?$/.test(body);
  } catch {
    verdict = false;
  }
  SHIM_CACHE.set(relFile, verdict);
  return verdict;
}

// require 目标能否解析到磁盘上真实存在的东西（Node 的 CJS 解析顺序简化版）。
function resolvesOnDisk(relTarget) {
  const base = path.join(repoRoot, relTarget);
  const candidates = [base, `${base}.js`, `${base}.json`, `${base}.node`, `${base}.cjs`];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return true;
    } catch { /* 忽略 */ }
  }
  try {
    if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      return ['index.js', 'index.json', 'package.json'].some(n => fs.existsSync(path.join(base, n)));
    }
  } catch { /* 忽略 */ }
  return false;
}

// git grep 按行匹配，会把注释里举例的 require 也抓进来（本仓库注释里大量引用
// 路径做说明）。只用行内特征排除，够用且零依赖：行首是 // 或 *（块注释续行）
// 或 #，或者 // 出现在 require( 之前。
function looksLikeComment(rawLine, requireIndex) {
  const trimmed = rawLine.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('#')) {
    return true;
  }
  const lineComment = rawLine.indexOf('//');
  return lineComment >= 0 && lineComment < requireIndex;
}

function isTestFixture(relFile) {
  return /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/.test(relFile)
    || /(?:^|\.)test\.[cm]?js$/.test(relFile);
}

// ── 拓展路径漂移（[DESIGN-TOOL-002] §4.1 的机器化）─────────────────────────
// 为什么单列一条而不是靠 unresolved-require：那条只看 `../../` 起步的深层 require，
// 于是漏掉两类「搬目录搬坏了」的典型：
//   ① 单层 `../lib/x` —— 拓展从 scripts/<子目录>/ 挪到 extensions/scripts/<id>/ 后，
//      同一个 `../lib` 指向的已经不是同一个地方了；
//   ② `path.resolve(__dirname, '..', '..')` 这类爬根算术 —— 它**不会**在加载期抛错，
//      只会静默算出一个错的根，然后在运行时表现为「什么都没探测到」。②比①危险得多。
// 只查 extensions/：拓展是会被整体搬动的那类目录，深度敏感的代码在这里最脆。
function collectExtensionSources() {
  const out = [];
  const root = path.join(repoRoot, 'extensions');
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'vendor' || entry.name === '.git') continue;
        walk(abs);
      } else if (/\.[cm]?js$/.test(entry.name)) {
        out.push(abs);
      }
    }
  };
  walk(root);
  return out;
}

// 从任意目录往上找到它所属拓展的根（带 khy.extension.json 的那一层）。
// 找不到就返回 null —— extensions/ 下也存在还没上契约的目录，那由 extension-contract 管。
function extensionRootOf(dir) {
  const stop = path.join(repoRoot, 'extensions');
  let cur = dir;
  while (cur.startsWith(stop) && cur !== stop) {
    if (fs.existsSync(path.join(cur, 'khy.extension.json'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

function checkExtensionPathDrift(findings, counts) {
  const RELATIVE_REQUIRE = /require\(\s*['"](\.[^'"]*)['"]\s*\)/g;
  // 只接全字面量参数：出现变量就判不了，交给人。
  // 不认死 `path.` 这个接收者：`require('path').resolve(...)`、`nodePath.join(...)` 一样要认。
  // 第一个实参就是 __dirname 已经是足够强的特征，再要求接收者叫 path 只会漏。
  const DIRNAME_JOIN = /\.(?:join|resolve)\(\s*__dirname\s*,([^)]*)\)/g;
  const LITERAL = /^\s*(['"])(.*?)\1\s*$/;
  const broken = [];

  for (const abs of collectExtensionSources()) {
    const rel = toPosix(path.relative(repoRoot, abs));
    let src;
    try {
      src = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    const dir = path.dirname(abs);
    const lineOf = (index) => src.slice(0, index).split('\n').length;
    const lineTextOf = (index) => src.slice(src.lastIndexOf('\n', index) + 1, src.indexOf('\n', index) + 1 || undefined);

    RELATIVE_REQUIRE.lastIndex = 0;
    for (let m = RELATIVE_REQUIRE.exec(src); m; m = RELATIVE_REQUIRE.exec(src)) {
      const lineText = lineTextOf(m.index);
      if (looksLikeComment(lineText, lineText.indexOf('require('))) continue;
      const target = path.resolve(dir, m[1]);
      if (!resolvesOnDisk(toPosix(path.relative(repoRoot, target)))) {
        broken.push(`${rel}:${lineOf(m.index)} → require('${m[1]}')（不存在）`);
      }
    }

    DIRNAME_JOIN.lastIndex = 0;
    for (let m = DIRNAME_JOIN.exec(src); m; m = DIRNAME_JOIN.exec(src)) {
      const pieces = m[1].split(',').map(x => x.trim()).filter(Boolean);
      const parts = [];
      let allLiteral = pieces.length > 0;
      for (const piece of pieces) {
        const lm = piece.match(LITERAL);
        if (!lm) { allLiteral = false; break; }
        parts.push(...lm[2].split('/').filter(Boolean));
      }
      // 只查「往上爬」的：不以 .. 开头的是脚本自己旁边的路径（如运行时自建的输出
      // 目录），与所在深度无关，天然不会因为搬家而漂。
      if (!allLiteral || parts[0] !== '..') continue;
      const lineText = lineTextOf(m.index);
      if (looksLikeComment(lineText, 0)) continue;
      const target = path.resolve(dir, ...parts);

      if (parts.every(part => part === '..')) {
        // 纯 `..` 序列 = 拿某个祖先目录当基准。在拓展里只有两个落点说得通：
        // **仓库根**（要读仓库里的东西）或**本拓展内部**（含自己的根，如 test/ 往上一层）。
        // 落在两者之间的 extensions/ 或 extensions/<分类>/ 上没有任何意义 —— 那是布局
        // 的中间层，不是谁的根 —— 而这恰恰是拓展被搬深一层后必然出现的症状。
        // 这一条不能靠「路径存不存在」来判：那些中间目录**都存在**，正是它让这类漂移
        // 完全无声（不抛错、不报缺失，只是从此什么都探测不到）。所以直接钉死落点。
        const extRoot = extensionRootOf(dir);
        const inExt = extRoot && (target === extRoot || target.startsWith(extRoot + path.sep));
        if (path.resolve(target) !== path.resolve(repoRoot) && !inExt) {
          broken.push(`${rel}:${lineOf(m.index)} → __dirname/${parts.join('/')} `
            + `落在 ${toPosix(path.relative(repoRoot, target)) || '.'}，`
            + '既不是仓库根也不在本拓展内（爬根层数算错）');
        }
        continue;
      }

      // 带具体段的：有的当 require 说明符用（无扩展名），所以要试模块后缀；
      // 这里问的是「存不存在」，不是「node 能不能 require」——用 existsSync 而不是
      // resolvesOnDisk，后者会因为目录里没有 index.js 就把一个真实存在的目录判为不存在。
      const hit = ['', '.js', '.cjs', '.mjs', '.json'].some(ext => fs.existsSync(target + ext));
      if (!hit) {
        broken.push(`${rel}:${lineOf(m.index)} → __dirname/${parts.join('/')}（不存在）`);
      }
    }
  }

  counts['extension-path-drift'] = broken.length;
  if (broken.length > 0) {
    findings.push({
      id: 'extension-path-drift',
      severity: 'warning',
      message: `${broken.length} 处拓展内的相对路径指向磁盘上不存在的位置（搬目录时级数算错）。`,
      detail: '相对 require 会在加载期抛 MODULE_NOT_FOUND；__dirname 爬根算术不抛错，'
        + `只会静默算错根、到运行时才表现为「什么都没找到」。首例：${broken.slice(0, 4).join(' | ')}`,
      full: broken,
    });
  }
}

function checkCrossLayerRequires(findings, counts) {
  const out = git([
    'grep',
    '-n',
    '-I',
    '-E',
    "require\\(['\"](\\.\\./){2,}",
    '--',
    'services',
    'apps',
    'software',
    'platform',
    'tools',
    'extensions',
  ]);

  const offenders = [];
  const unresolved = [];
  let shimCount = 0;

  for (const line of out.split('\n')) {
    if (!line.trim() || line.includes('node_modules/')) continue;
    const firstColon = line.indexOf(':');
    const secondColon = line.indexOf(':', firstColon + 1);
    if (firstColon < 0 || secondColon < 0) continue;
    const file = toPosix(line.slice(0, firstColon));
    // 这条规则约束可发布的运行时模块图。测试可直接加载相邻 workspace 的
    // fixture / implementation 做契约验证，不会形成产品运行时依赖边。
    if (isTestFixture(file)) continue;
    const lineNo = line.slice(firstColon + 1, secondColon);
    const body = line.slice(secondColon + 1);

    const specMatch = body.match(/require\(['"]((?:\.\.\/){2,}[^'"]*)['"]\)?/);
    if (!specMatch) continue;
    if (looksLikeComment(body, specMatch.index)) continue;
    const spec = specMatch[1];

    const wsRoot = workspaceRootOf(file);
    if (!wsRoot) continue;

    // 解析 require 目标，判断是否逃出了 workspace 根。
    const resolved = toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
    const escapes = !(resolved === wsRoot || resolved.startsWith(`${wsRoot}/`));

    // 指向不存在的路径 = 潜伏崩溃（多半是搬文件时 ../ 少算/多算一级）。
    // 惰性 require（写在函数体里）不会在启动期暴露，只在跑到那条命令时炸。
    if (!resolvesOnDisk(resolved)) {
      unresolved.push(`${file}:${lineNo} → ${resolved}（不存在）`);
      continue;
    }

    if (!escapes) continue;

    if (isPureReexportShim(file)) {
      shimCount += 1;
      continue;
    }
    offenders.push(`${file}:${lineNo} → ${resolved}`);
  }

  counts['cross-layer-require'] = offenders.length;
  counts['unresolved-require'] = unresolved.length;
  if (shimCount > 0) counts['_reexport-shims'] = shimCount;

  if (offenders.length > 0) {
    findings.push({
      id: 'cross-layer-require',
      severity: 'warning',
      message: `${offenders.length} 处跨 workspace 的深层相对 require（[DESIGN-LAY-005] 第二节禁止边）。`
        + `${shimCount > 0 ? ` 另有 ${shimCount} 处纯 re-export 壳文件按兼容别名豁免。` : ''}`,
      detail: `应改为 workspace 包名（如 @khy/shared）。首例：${offenders.slice(0, 3).join(' | ')}`,
      full: offenders,
    });
  }

  if (unresolved.length > 0) {
    findings.push({
      id: 'unresolved-require',
      severity: 'warning',
      message: `${unresolved.length} 处深层相对 require 指向磁盘上不存在的路径（潜伏崩溃）。`,
      detail: `多为搬迁文件时 ../ 级数算错；惰性 require 只在跑到那条命令时才炸。首例：${unresolved.slice(0, 4).join(' | ')}`,
      full: unresolved,
    });
  }
}

// ── 规则 11：五域（D1–D5）依赖方向 ───────────────────────────────────────
// 判据真源：docs/10_规范/registry/DOMAIN-DEPS.json（域划分与禁止边都在那里，本函数
// 不硬编码任何路径清单 —— 改登记表即改守卫）。设计依据：5-3-1 §5「单向依赖」，
// 落地口径见 [RESEARCH-018] §2.1/§2.3 与 §4 C-7。
// 为什么只管两条边（D3 纯净性、任何域 →D5）：D2→D1 与 archDebtScan R1
// （src/services/** → src/cli/**）是同一批边，两处判定就是两份真源
// （[MGMT-STD-008] §2.2「重叠即违规」）；那条归 R1 的基线棘轮管。
const DOMAIN_DEPS_PATH = path.join(repoRoot, 'docs', '10_规范', 'registry', 'DOMAIN-DEPS.json');

function loadDomainDeclaration() {
  try {
    return JSON.parse(fs.readFileSync(DOMAIN_DEPS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// 登记表里的 roots 拍平成 (prefix, domain) 表；同一文件命中多个前缀时取**最长前缀**，
// 于是 services/backend/src/services/domain 归 D2 而不是它的父集 services。
function buildDomainPrefixes(decl) {
  const out = [];
  for (const [id, def] of Object.entries(decl.domains || {})) {
    for (const root of def.roots || []) {
      const prefix = toPosix(String(root)).replace(/\/+$/, '');
      if (prefix) out.push({ prefix, domain: id });
    }
  }
  return out;
}

function domainOf(rel, prefixes) {
  let best = null;
  for (const p of prefixes) {
    if (rel === p.prefix || rel.startsWith(`${p.prefix}/`)) {
      if (!best || p.prefix.length > best.prefix.length) best = p;
    }
  }
  return best ? best.domain : null;
}

function checkDomainDirection(findings, counts) {
  counts['domain-direction'] = 0;
  const decl = loadDomainDeclaration();
  if (!decl) {
    // 只在「本仓确实有规范登记表目录」时把缺失判成 error：测试用临时 fixture 指向
    // 一个最小仓库（scripts/tests/check-repo-layout.test.js），那里根本没有规范区，
    // 报 error 会让所有既有 fixture 用例误红。
    const hasRegistryDir = fs.existsSync(path.join(repoRoot, 'docs', '10_规范', 'registry'));
    if (!hasRegistryDir) return;
    // 声明缺失时守卫没有判据 —— 这不是「全绿」，必须亮红，否则域边界会无声消失。
    findings.push({
      id: 'domain-direction',
      severity: 'error',
      message: '五域依赖声明缺失：docs/10_规范/registry/DOMAIN-DEPS.json 读不到或不是合法 JSON。',
      detail: 'domain-direction 规则的全部判据来自该登记表（真源 [RESEARCH-018] §2.1/§4 C-7）。',
    });
    return;
  }

  const prefixes = buildDomainPrefixes(decl);
  const enforced = (decl.enforced || []).map(rule => ({
    id: rule.id,
    clause: rule.clause || '',
    from: new Set(rule.from || []),
    forbid: new Set(rule.forbidTargets || []),
  }));
  if (prefixes.length === 0 || enforced.length === 0) {
    findings.push({
      id: 'domain-direction',
      severity: 'error',
      message: '五域依赖声明为空（domains[].roots 或 enforced[] 缺项），规则无法判定。',
      detail: `已解析 domains=${Object.keys(decl.domains || {}).length} enforced=${enforced.length}`,
    });
    return;
  }

  // 扫描源 = 所有被 enforced.from 点名的域的 roots（D5 作为源不受限：工程脚本读
  // 运行时代码是它的职责，见登记表的 _asymmetry）。
  const fromDomains = new Set(enforced.flatMap(r => [...r.from]));
  const sourceRoots = [...new Set(
    prefixes.filter(p => fromDomains.has(p.domain)).map(p => p.prefix)
  )].filter(root => fs.existsSync(path.join(repoRoot, root)));
  if (sourceRoots.length === 0) {
    counts['domain-direction'] = 0;
    findings.push({
      id: 'domain-direction',
      severity: 'error',
      message: 'domain-direction 无扫描源：DOMAIN-DEPS.json 点名的域 roots 在磁盘上一个都不存在。',
      detail: `enforced.from=${[...fromDomains].join('/')}`,
    });
    return;
  }

  // 不复用 git()：它在任何异常时返回空串，对本规则等于「扫不到 = 全绿」的 fail-open
  // （规则 10 A2-7：判定失败禁止静默降级为放行）。这里要区分「没有违规」与「没扫成」。
  let out;
  try {
    out = cp.execFileSync('git', ['grep', '-n', '-I', '-E', "require\\(['\"]\\.", '--', ...sourceRoots], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    // git grep 的「零命中」是 exit 1 且无输出，那不是故障；其余（含 buffer 超限）必须报出来。
    if (err.status === 1 && !err.stdout) out = '';
    else {
      counts['domain-direction'] = 0;
      findings.push({
        id: 'domain-direction',
        severity: 'error',
        message: `domain-direction 扫描未成功（git grep 失败：${String(err.message).split('\n')[0]}）—— 本规则不 fail-open。`,
        detail: `扫描源：${sourceRoots.join(', ')}`,
      });
      return;
    }
  }

  const violations = [];
  const byRule = {};
  for (const line of out.split('\n')) {
    if (!line.trim() || line.includes('node_modules/')) continue;
    const firstColon = line.indexOf(':');
    const secondColon = line.indexOf(':', firstColon + 1);
    if (firstColon < 0 || secondColon < 0) continue;
    const file = toPosix(line.slice(0, firstColon));
    if (!/\.[cm]?js$/.test(file)) continue;
    if (isTestFixture(file)) continue;
    const lineNo = line.slice(firstColon + 1, secondColon);
    const body = line.slice(secondColon + 1);

    const specMatch = body.match(/require\(\s*(['"])(\.[^'"]*)\1/);
    if (!specMatch) continue;
    if (looksLikeComment(body, specMatch.index)) continue;

    const srcDomain = domainOf(file, prefixes);
    if (!srcDomain) continue;

    const rawTarget = toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(file), specMatch[2])));
    const target = rawTarget.replace(/\.[cm]?js$|\.json$/, '');
    const dstDomain = domainOf(target, prefixes);
    if (!dstDomain) continue;

    const rule = enforced.find(r => r.from.has(srcDomain) && r.forbid.has(dstDomain));
    if (!rule) continue;
    byRule[rule.id] = (byRule[rule.id] || 0) + 1;
    violations.push(`${file}:${lineNo} ${srcDomain}→${dstDomain} → ${target}`);
  }

  counts['domain-direction'] = violations.length;
  if (violations.length === 0) return;

  const breakdown = Object.entries(byRule)
    .map(([id, n]) => `${id} ${n} 处`)
    .join('，');
  findings.push({
    id: 'domain-direction',
    severity: 'warning',
    message: `${violations.length} 处跨域禁止边（${breakdown}；判据 DOMAIN-DEPS.json，真源 [RESEARCH-018] §4 C-7）。`,
    detail: '共享底座 D3（utils/ + constants/）不得反向 require 运行时/业务/交付面；'
      + `任何运行时代码不得伸进工程档案区 D5。首例：${violations.slice(0, 4).join(' | ')}`,
    full: violations,
  });
}

// ── functional-unit：功能单元缺件（[RESEARCH-018] §4 C-4）────────────────────
// 判据两半的**范围**都取自 DOMAIN-DEPS.json 的 D2 roots，功能单元 = root 的直接子目录
// （§2.3 模板里 `D2/trajectory/` 那一整个业务上下文）。守卫里刻意不再另列一份目录清单，
// 否则「什么算 D2」会长出两份真源（[MGMT-STD-008] §2.2）。
//
// 这条是**存在性**判据，不是质量判据：它只问「同名测试在不在同一个目录、单元目录里有
// 没有 README」，不问测试是否有效、README 是否空洞。§5 结论 2 写明共置率「不是目录问题，
// 搬目录治不了」，所以本规则的作用是把缺口变成一根只降不升的读数，供 P3 逐上下文补件时
// 计量，而不是替代人判断内容。
const FUNCTIONAL_UNIT_SUBRULES = {
  'test-colocated': '5-3-1 §3 功能单元含测试 / [RESEARCH-018] §2.3「*.test.js 与源同目录」',
  'readme-missing': '5-3-1 §3 功能单元含文档 / [RESEARCH-018] §2.3 README.md（谁要 / 为什么 / 怎么验）',
};

const SOURCE_UNIT_EXT_RE = /\.(?:[cm]?js)$/;
const COLOCATED_TEST_EXTS = ['.test.js', '.test.cjs', '.test.mjs'];

function listUnitSourceFiles(absDir, relDir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
        listUnitSourceFiles(abs, rel, acc);
      }
      continue;
    }
    if (!entry.isFile() || !SOURCE_UNIT_EXT_RE.test(entry.name)) continue;
    if (COLOCATED_TEST_EXTS.some(ext => entry.name.endsWith(ext))) continue;
    acc.push({ abs, rel, base: entry.name.replace(SOURCE_UNIT_EXT_RE, '') });
  }
  return acc;
}

// 磁盘扫描会把 gitignore 掉的**构建产物**当成核心域源文件。实测事故：
// platform/khy_platform/bundled/runtime/khy/bundle.mjs（17.7 MB，.gitignore:137 命中）
// 单独把 entry-buffer 从基线 2667 顶到 2668 并升级为 error —— 而 C-5 判据管的是
// 「新**代码**禁直写核心域」，产物不是代码，补 manifest 既无意义也不该做。
// 一次 `git check-ignore --stdin` 批量剔除；git 不可用（迷你 fixture 仓）时**不剔**，
// 宁可保留原读数，也不给规则开出静默放行的口子。
function dropGitIgnoredSources(files) {
  if (!files.length) return files;
  let out;
  try {
    out = cp.execFileSync('git', ['check-ignore', '--stdin', '-z'], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: files.map((f) => toPosix(f.rel)).join('\0'),
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return files;
  }
  const ignored = new Set(String(out).split('\0').filter(Boolean));
  if (ignored.size === 0) return files;
  return files.filter((f) => !ignored.has(toPosix(f.rel)));
}

function checkFunctionalUnit(findings, counts) {
  counts['functional-unit'] = 0;
  // 与 domain-direction 共用声明文件：读不到时那边已经亮红，这里不重复报，
  // 免得一份坏 JSON 变成两条 finding 互相掩盖真实原因。
  const decl = loadDomainDeclaration();
  if (!decl) return;
  // 登记表里没声明 D2 = 这个仓库还没有「业务上下文」这一域，规则无从判起（测试用的
  // 迷你登记表正是这种仓库）。声明了 D2 但 roots 落空则相反 —— 那是判据目标消失了，
  // 按「判定失败禁止静默降级为放行」（规则 10 A2-7）亮 error。
  if (!decl.domains || !decl.domains.D2) return;
  const roots = (decl.domains.D2.roots || []).filter(Boolean);
  const present = roots.filter(root => {
    try {
      return fs.statSync(path.join(repoRoot, root)).isDirectory();
    } catch {
      return false;
    }
  });
  if (roots.length === 0 || present.length === 0) {
    findings.push({
      id: 'functional-unit',
      severity: 'error',
      message: 'functional-unit 无扫描源：DOMAIN-DEPS.json 声明了 D2，但它的 roots 在磁盘上一个都不存在。',
      detail: `roots=${JSON.stringify(roots)}（真源 [RESEARCH-018] §4 C-4）。本规则不 fail-open。`,
    });
    return;
  }

  const violations = [];
  const byRule = {};
  const bump = (ruleId) => { byRule[ruleId] = (byRule[ruleId] || 0) + 1; };
  let unitTotal = 0;
  let contextTotal = 0;

  for (const root of present) {
    const rootAbs = path.join(repoRoot, root);
    // 判据 ①README：功能单元 = root 的直接子目录（§2.3 模板的 D2/<上下文>/ 那一层）。
    for (const context of listSubdirs(rootAbs)) {
      contextTotal += 1;
      if (fs.existsSync(path.join(rootAbs, context, 'README.md'))) continue;
      bump('readme-missing');
      violations.push(`${root}/${context}/ 缺 README.md（${FUNCTIONAL_UNIT_SUBRULES['readme-missing']}）`);
    }
    // 判据 ②共置测试：D2 内每个源文件（含裸挂在 root 上的，它只是没有归属单元，
    // 测试共置仍要求）。
    for (const src of dropGitIgnoredSources(listUnitSourceFiles(rootAbs, root, []))) {
      unitTotal += 1;
      const hit = COLOCATED_TEST_EXTS.some(ext => fs.existsSync(path.join(path.dirname(src.abs), src.base + ext)));
      if (hit) continue;
      bump('test-colocated');
      violations.push(`${src.rel} 缺 ${src.base}.test.js（${FUNCTIONAL_UNIT_SUBRULES['test-colocated']}）`);
    }
  }
  violations.sort();

  counts['functional-unit'] = violations.length;
  if (violations.length === 0) return;

  const breakdown = Object.entries(byRule)
    .map(([id, n]) => `${id} ${n} 处`)
    .join('，');
  findings.push({
    id: 'functional-unit',
    severity: 'warning',
    message: `${violations.length} 处功能单元缺件（${breakdown}；判据 [RESEARCH-018] §4 C-4，范围取 DOMAIN-DEPS.json 的 D2 roots）。`,
    detail: `D2 实测 ${contextTotal} 个功能单元目录、${unitTotal} 个源文件。两半都是纯新增可降项：`
      + '补一份单元级 README 降一处，补一个同名同目录测试降一处。'
      + `首例：${violations.slice(0, 3).join(' | ')}`,
    full: violations,
  });
}

// ── 规则：源码入口缓冲（entry-buffer）───────────────────────────────────────
// 判据真源 [RESEARCH-018] §4 C-5「核心域内新文件必须带 lifecycle: staged→stable 记录」
// 与 §3 P5 行「新代码必须先落 D5/quarantine/<日期>/ 再晋级，晋级判据 = 有测试 + 有 README
// + fan-in 声明」。适用范围（核心域）、缓冲区位置、manifest 文件名与阶段取值都取自
// DOMAIN-DEPS.json 的 _entry_buffer 块 —— 不在这里硬编码目录清单（同一张表已是域清单真源）。
const ENTRY_BUFFER_SUBRULES = {
  'manifest-missing': '5-3-1 §4「新代码禁直写核心域」/ [RESEARCH-018] §4 C-5「核心域内新文件必须带 lifecycle: staged→stable 记录」',
  'manifest-invalid': '同上 C-5：记录存在但不可用（JSON 非法 / domain 不在五域表 / lifecycle.stage 取值非法）',
  'manifest-overstates-edge': '5-3-1 §5 依赖方向 / [RESEARCH-018] §2.3「khy.module.json 声明允许依赖的域」—— 单元自述的依赖面不得宽于本表名义边界',
  'promotion-incomplete': '[RESEARCH-018] §3 P5 晋级判据 = 有测试 + 有 README + fan-in 声明',
  'buffer-missing': '5-3-1 §4 入口缓冲：缓冲区目录本身不存在，「先入缓冲再晋级」这条路径就无从谈起',
};

// 从文件所在目录向上走到它所属 declared root（含 root 本身），取第一份 manifest。
// 一个单元 = 一层目录，§2.3 模板里 khy.module.json 住在单元目录而不是逐文件挂。
function findGoverningManifest(startDir, stopDir, manifestName) {
  let dir = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  for (;;) {
    const candidate = path.join(dir, manifestName);
    if (fs.existsSync(candidate)) return { abs: candidate, dir };
    if (dir === stop || !dir.startsWith(`${stop}${path.sep}`)) return null;
    dir = path.dirname(dir);
  }
}

function checkEntryBuffer(findings, counts) {
  counts['entry-buffer'] = 0;
  // 与 domain-direction / functional-unit 共用声明文件：读不到时那边已经亮红，
  // 这里不重复报，免得一份坏 JSON 变成两条 finding 互相掩盖真实原因。
  const decl = loadDomainDeclaration();
  if (!decl) return;
  const eb = decl._entry_buffer;
  // 本仓还没采纳入口缓冲机制（测试用的迷你登记表正是这种仓库）→ 整条规则静默。
  if (!eb) return;
  const manifestName = eb.manifestName || 'khy.module.json';
  const stages = eb.stages || ['staged', 'stable'];
  const coreIds = (eb.coreDomains || []).filter(Boolean);
  const domains = decl.domains || {};

  const rootsOf = [];
  let declaredRoots = 0;
  for (const id of coreIds) {
    for (const root of ((domains[id] && domains[id].roots) || []).filter(Boolean)) {
      declaredRoots += 1;
      try {
        if (fs.statSync(path.join(repoRoot, root)).isDirectory()) {
          rootsOf.push({ id, root: toPosix(root).replace(/\/+$/, '') });
        }
      } catch { /* 磁盘上不存在 = 未落地的 root，不参与扫描 */ }
    }
  }
  // 声明了核心域却一个扫描源都没有：判据目标消失，按规则 10 A2-7 不 fail-open。
  if (coreIds.length === 0 || declaredRoots === 0 || rootsOf.length === 0) {
    findings.push({
      id: 'entry-buffer',
      severity: 'error',
      message: 'entry-buffer 无扫描源：DOMAIN-DEPS.json 声明了 _entry_buffer，但它的 coreDomains 在本表里找不到任何落地 roots。',
      detail: `coreDomains=${JSON.stringify(coreIds)}（真源 [RESEARCH-018] §4 C-5）。本规则不 fail-open。`,
    });
    return;
  }

  const violations = [];
  const byRule = {};
  const bump = (ruleId) => { byRule[ruleId] = (byRule[ruleId] || 0) + 1; };

  if (eb.bufferRoot && !fs.existsSync(path.join(repoRoot, eb.bufferRoot))) {
    bump('buffer-missing');
    violations.push(`${eb.bufferRoot}/ 缓冲区目录不存在（${ENTRY_BUFFER_SUBRULES['buffer-missing']}）`);
  }

  // D2 的 root 嵌在 D1 的 root 里（domain/ 在 services/ 之下），同一物理文件只记一次。
  const files = new Map();
  for (const { root } of rootsOf) {
    for (const src of dropGitIgnoredSources(listUnitSourceFiles(path.join(repoRoot, root), root, []))) {
      if (!files.has(src.rel)) files.set(src.rel, { ...src, root });
    }
  }

  const manifestCache = new Map();
  const loadManifest = (abs) => {
    if (manifestCache.has(abs)) return manifestCache.get(abs);
    let parsed = null;
    let error = null;
    try {
      parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (err) {
      error = err.message;
    }
    const hit = { parsed, error };
    manifestCache.set(abs, hit);
    return hit;
  };
  // README / fan-in 是**单元级**判据，一个 manifest 只报一次；共置测试是文件级判据。
  const unitLevelReported = new Set();
  let recorded = 0;

  const sorted = [...files.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const src of sorted) {
    const rootEntry = rootsOf.find(r => r.root === src.root);
    const gov = findGoverningManifest(path.dirname(src.abs), path.join(repoRoot, rootEntry.root), manifestName);
    const short = `${src.rel}`;
    if (!gov) {
      bump('manifest-missing');
      violations.push(`${short} 无生命周期记录：从所在目录到 ${src.root} 边界内找不到 ${manifestName}（${ENTRY_BUFFER_SUBRULES['manifest-missing']}）`);
      continue;
    }
    const { parsed, error } = loadManifest(gov.abs);
    const relManifest = toPosix(path.relative(repoRoot, gov.abs));
    if (error) {
      bump('manifest-invalid');
      violations.push(`${short} 的记录 ${relManifest} 不是合法 JSON：${error}（${ENTRY_BUFFER_SUBRULES['manifest-invalid']}）`);
      continue;
    }
    const stage = parsed && parsed.lifecycle ? parsed.lifecycle.stage : null;
    const domainId = parsed ? parsed.domain : null;
    if (!stages.includes(stage)) {
      bump('manifest-invalid');
      violations.push(`${short} 的记录 ${relManifest} 缺 lifecycle.stage 或取值不在 ${JSON.stringify(stages)}（实测 ${JSON.stringify(stage)}）（${ENTRY_BUFFER_SUBRULES['manifest-invalid']}）`);
      continue;
    }
    if (!domains[domainId]) {
      bump('manifest-invalid');
      violations.push(`${short} 的记录 ${relManifest} 声明 domain=${JSON.stringify(domainId)}，五域表里没有这一域（${ENTRY_BUFFER_SUBRULES['manifest-invalid']}）`);
      continue;
    }
    recorded += 1;

    const nominal = (domains[domainId].mayDependOn || []);
    const declared = Array.isArray(parsed.mayDependOn) ? parsed.mayDependOn : null;
    if (declared) {
      const overstates = declared.filter(id => !nominal.includes(id));
      if (overstates.length > 0) {
        bump('manifest-overstates-edge');
        violations.push(`${relManifest} 声明 mayDependOn 含 ${JSON.stringify(overstates)}，超出 ${domainId} 名义边界 ${JSON.stringify(nominal)}（${ENTRY_BUFFER_SUBRULES['manifest-overstates-edge']}）`);
      }
    }

    // 晋级判据对两个阶段都判：staged 是「还没达标」，stable 是「声称已晋级却判据不齐」——
    // 后者更该亮，因为它是一张已经被人签过字的假合格证。
    const unitKey = gov.abs;
    const unitMissing = [];
    if (!fs.existsSync(path.join(gov.dir, 'README.md'))) unitMissing.push('缺单元级 README.md');
    if (!Number.isInteger(parsed.fanIn)) unitMissing.push(`fan-in 未声明（fanIn=${JSON.stringify(parsed.fanIn)}，须为整数）`);
    if (unitMissing.length > 0 && !unitLevelReported.has(unitKey)) {
      unitLevelReported.add(unitKey);
      bump('promotion-incomplete');
      violations.push(`${relManifest}（stage=${stage}）：${unitMissing.join('、')}（${ENTRY_BUFFER_SUBRULES['promotion-incomplete']}）`);
    }
    const hasTest = COLOCATED_TEST_EXTS.some(ext => fs.existsSync(path.join(path.dirname(src.abs), src.base + ext)));
    if (!hasTest) {
      bump('promotion-incomplete');
      violations.push(`${short}（stage=${stage}）缺同名同目录测试 ${src.base}.test.js（${ENTRY_BUFFER_SUBRULES['promotion-incomplete']}）`);
    }
  }

  counts['entry-buffer'] = violations.length;
  if (violations.length === 0) return;
  const breakdown = Object.entries(byRule).map(([id, n]) => `${id} ${n} 处`).join('，');
  findings.push({
    id: 'entry-buffer',
    severity: 'warning',
    message: `${violations.length} 处入口缓冲缺件（${breakdown}；判据 [RESEARCH-018] §4 C-5，范围取 DOMAIN-DEPS.json 的 _entry_buffer.coreDomains）。`,
    detail: `核心域实测 ${files.size} 个源文件，其中 ${recorded} 个已有可用记录。降法只有两种：`
      + '给单元补一份 khy.module.json（覆盖其下所有文件，一次降多处），或让 staged 单元补齐晋级判据。'
      + `首例：${violations.slice(0, 3).join(' | ')}`,
    full: violations,
  });
}

// ── 基线 ────────────────────────────────────────────────────────────────
function loadBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  const unknown = [...promotedIds, ...listIds].filter(id => !ALL_FINDING_IDS.has(id));
  if (unknown.length > 0) {
    console.error(`check-repo-layout: 未知的 --promote / --list id: ${unknown.join(', ')}`);
    console.error(`  可用 id: ${[...ALL_FINDING_IDS].join(', ')}`);
    process.exit(2);
  }

  const findings = [];
  const counts = {};

  checkRootWhitelist(findings);
  checkRootJunk(findings);
  checkDocsIndexFirst(findings);
  checkDocsIndexComplete(findings, counts);
  checkLayerRegistry(findings);
  checkDanglingTasks(findings, counts);
  checkCrossLayerRequires(findings, counts);
  checkExtensionContract(findings, counts);
  checkExtensionIdHardcode(findings, counts);
  checkExtensionPathDrift(findings, counts);
  checkDomainDirection(findings, counts);
  checkFunctionalUnit(findings, counts);
  checkEntryBuffer(findings, counts);

  if (updateBaseline) {
    // 保留 baseline json 里 `_` 前缀的说明字段（_note/_source/_meaning），
    // 否则每次下调基线都会把「只降不升」这条约定的解释顺手删掉。
    const prev = loadBaseline() || {};
    const next = {};
    for (const [k, v] of Object.entries(prev)) {
      if (k.startsWith('_')) next[k] = v;
    }
    next.updated = new Date().toISOString().slice(0, 10);
    next.counts = {};
    for (const id of BASELINE_IDS) next.counts[id] = counts[id] || 0;
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    console.log(`check-repo-layout: 基线已更新 → ${toPosix(path.relative(repoRoot, BASELINE_PATH))}`);
    console.log(`  ${JSON.stringify(next.counts)}`);
    return;
  }

  const baseline = loadBaseline();
  const regressions = [];
  for (const id of BASELINE_IDS) {
    const allowed = baseline && baseline.counts && Number.isInteger(baseline.counts[id])
      ? baseline.counts[id]
      : null;
    const actual = counts[id] || 0;
    if (allowed === null) continue;
    if (actual > allowed) regressions.push({ id, allowed, actual });
  }

  // 基线只降不升：超出即升为 error（这才是棘轮，不然基线只是个数字）。
  const effectiveSeverity = (finding) => {
    if (finding.severity !== 'warning') return finding.severity;
    if (finding.id && promotedIds.has(finding.id)) return 'error';
    if (regressions.some(r => r.id === finding.id)) return 'error';
    if (strictWarnings) return 'error';
    return 'warning';
  };

  console.log('check-repo-layout: 层级/结构守卫（真源 [DESIGN-LAY-005] + [MGMT-STD-001]）');
  console.log(`counts: ${JSON.stringify(counts)}`);
  if (baseline && baseline.counts) {
    console.log(`baseline: ${JSON.stringify(baseline.counts)} (updated ${baseline.updated || 'n/a'})`);
  } else {
    console.log('baseline: 缺失 —— 跑 node scripts/ci/check-repo-layout.js --update-baseline 建立');
  }

  if (findings.length === 0) {
    console.log('result: 无结构发现，层级规范全绿。');
  } else {
    console.log('result:');
    for (const finding of findings) {
      const eff = effectiveSeverity(finding);
      const mark = eff !== finding.severity ? ` (promoted from ${finding.severity})` : '';
      console.log(` - [${eff}]${mark} ${finding.message} (id: ${finding.id})`);
      if (finding.detail) console.log(`   ${finding.detail}`);
      if (listIds.has(finding.id) && Array.isArray(finding.full)) {
        for (const item of finding.full) console.log(`     · ${item}`);
      }
    }
  }

  for (const r of regressions) {
    console.error(`check-repo-layout: ${r.id} 超出基线（基线 ${r.allowed}，实测 ${r.actual}）—— 只允许下降。`);
    console.error('  修掉新增违规，或在确有正当理由时用 --update-baseline 显式下调/记录。');
  }

  if (findings.some(finding => effectiveSeverity(finding) === 'error')) {
    process.exit(1);
  }
}

// 只在作为 CLI 直接运行时才执行 —— main() 会在有 error 时 process.exit(1)，
// 若在 require 时无条件跑，任何想复用下面这些纯函数的测试都会被直接终止进程。
if (require.main === module) {
  main();
}

module.exports = {
  isRootJunkName,
  findRootJunkEntries,
  checkRootJunk,
  ROOT_JUNK_FILE_RES,
  ROOT_JUNK_DIR_RES,
};
