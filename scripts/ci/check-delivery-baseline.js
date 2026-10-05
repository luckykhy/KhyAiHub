#!/usr/bin/env node
'use strict';

/**
 * check-delivery-baseline.js — 「可交付性基线」记分板（PROCESS-014）。
 *
 * ## 为什么需要它
 *
 * [DESIGN-DELIV-001] §5.1 的诊断：**仓库的治理全部指向内部一致性，
 * 没有一条指向外部可交付性**（"陌生人能否在陌生机器上从公开渠道安装、运行、
 * 信任并升级"）。本仓现有 93 条规则里，0 条守这件事；现有 75 个 check-* 里，
 * 0 个检查"发布物是否存在"。一个恒被测量的内部 + 一个从不被测量的外部，
 * 就是「治理通过率很高但交付很差」的结构性成因。
 *
 * 本脚本把 [DESIGN-DELIV-001] 的 D1–D10 十条判据（此前只是散文）
 * 变成一份**可跑、可 JSON、可反向验证**的记分板，并额外承担
 * [DESIGN-DELIV-002] §2.3 的**任务面棘轮**（命令/别名/handler/规则数只降不升）。
 *
 * ## 阈值真源（不得在本文件内硬编码）
 *
 * 全部阈值与任务面基线来自 `[DESIGN-DELIV-002] 产品任务面与交付律.md` §4 的
 * ```json khy-delivery-surface/1``` 代码块。本文件**只读**它。
 * 删掉那个块 ⇒ 报 `delivery-thresholds-missing`，**不会**静默退回内置默认值
 * —— 那正是本仓两次踩过的「空转断言」形态（check-zcode-baseline.js 打印 PASS 7
 * 却自述恒返回 0；source-hygiene-scan.js 自述 ALWAYS exits 0）。
 *
 * ## 落地阶段（PROCESS-006 PP-1 / PROCESS-008）
 *
 * `STAGE = 'S1'`：**观察者，只记录不阻断，恒 exit 0**。
 * 阶段登记在 `FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]`
 * （id=`delivery-baseline-guard`），`check-rollout-stage.js` 会比对本常量与登记值，
 * 漂移即报 `rollout-stage-authority-drift`。
 *
 * ⚠ **升阶是人的决定，不是脚本的决定。** [DESIGN-DELIV-001] §4.3 主张
 * D1/D4/D7 因引用权威外部判定（`git fsck` / 文本事实 / 既有棘轮）可直进 S3。
 * 该主张需要一次显式裁决；本脚本**不代为豁免**，也**不自行阻断**。
 * 升阶动作 = 三处同步：本文件 `STAGE='S3'` + 登记表 `severity` +
 * `releaseGateStages.js` 该阶段 `tier` 由 `recommended` 改 `must`（并给命令加 `--strict`）。
 *
 * ## 输出契约（与 scripts/ruleguard 一致）
 *
 * stdout **只放 finding**，两种方言：
 *   - 可定位的：`[ERROR|WARN ] <finding-id> <无空格路径>:<真实行号>` + 两空格缩进正文
 *   - 聚合的：  `- [error|warn] <说明> (id: <finding-id>)`
 *     （用于 D1/D2/D3/D10/棘轮这类"没有单一行号"的读数——见 check-repo-layout 同款理由：
 *      宁可没有锚点，也不伪造一个行号）
 * 记分板 / 表头等**诊断信息一律走 stderr**（否则缩进行会被解析器当成上一条的正文）。
 *
 * 纪律：[RUNTIME-001] 无字面量路径/主机（仓库根由 __dirname 推导）；
 * [RUNTIME-003] git 探测属短生命周期 I/O（≤10s，见 GIT_PROBE_TIMEOUT_MS），
 * 不是对长任务的无条件 kill；[RUNTIME-004] 不用滚动区；零外部依赖、只读、绝不抛。
 *
 * Usage:
 *   node scripts/ci/check-delivery-baseline.js              # 记分板 + findings
 *   node scripts/ci/check-delivery-baseline.js --json       # 机读（测试消费）
 *   node scripts/ci/check-delivery-baseline.js --changed    # 只报与本次改动相关的项
 *   node scripts/ci/check-delivery-baseline.js --strict     # 升阶后模式：GAP 即 exit 1
 *   node scripts/ci/check-delivery-baseline.js --explain    # 逐项解释判据来源
 * Fixture root: KHY_DELIVERY_ROOT=<dir> node scripts/ci/check-delivery-baseline.js
 *
 * Exit: 0 clean（S1 恒 0）· 1 GAP（仅 --strict）· 2 用法错误。
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// ── 阶段权威（PP 一致性：check-rollout-stage.js 读本常量与登记表比对） ────────
const STAGE = 'S1';

/** S1/S2 只记录不阻断：error 级 finding 降级为 WARN（对齐 PROCESS-008 PP-3）。 */
const OBSERVER_STAGES = new Set(['S1', 'S2']);

/** 阈值真源文档（语义真源 = [DESIGN-DELIV-001]；阈值真源 = 本文件的 §4 JSON 块）。 */
const THRESHOLD_DOC_REL = 'docs/10_规范/其它规范/[DESIGN-DELIV-002] 产品任务面与交付律.md';
const THRESHOLD_SCHEMA = 'khy-delivery-surface/1';
const REGISTRY_REL = 'docs/10_规范/registry/RULES-REGISTRY.json';
const OWNERSHIP_REL = 'docs/10_规范/registry/FEATURE-OWNERSHIP.json';
const STAGES_LIB_REL = 'scripts/release/lib/releaseGateStages.js';
const RELEASE_WORKFLOW_REL = '.github/workflows/dual-channel-release.yml';

/**
 * git 探测的两档超时。属 [RUNTIME-003] 合法例外清单里的「短 I/O 超时」：
 * 都是**探测**（probe），防的是挂死的 I/O，**不是**对活跃计算的无条件 kill，
 * 也不参与任何任务截止判定。
 *
 * 为什么要分两档（实测教训）：`git fsck` 要遍历整个对象库，本仓两次实测
 * 27.6s / 43.9s，而 8s 档会把它杀在半路。spawnSync 超时后 `error.code === 'ETIMEDOUT'`，
 * 旧代码只看 `!ok` 就断言「git 不可用／仓库不可读」——于是**探针预算不够**被误报成
 * **环境缺 git**，还引导读者去查 .git/index.lock（错误动作）。本仓 D1 因此恒为 UNKNOWN，
 * 而 `git fsck` 明明跑得动、而且真的报了断链。预算不够是守卫自己的缺陷，不是仓库的结论。
 */
const GIT_PROBE_TIMEOUT_MS = 8000;
/** 全图遍历档：对象库越大越慢（本仓 ≈10^4 提交 / 10^4 文件），给足预算读数才有意义。 */
const GIT_FSCK_TIMEOUT_MS = 120000;

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const changedMode = args.includes('--changed');
const strictMode = args.includes('--strict');
const explainMode = args.includes('--explain');

if (args.some((a) => a.startsWith('-') && !['--json', '--changed', '--strict', '--explain'].includes(a))) {
  process.stderr.write(`用法：node scripts/ci/check-delivery-baseline.js [--json] [--changed] [--strict] [--explain]\n`);
  process.exit(2);
}

function resolveRoot() {
  return process.env.KHY_DELIVERY_ROOT
    ? path.resolve(process.env.KHY_DELIVERY_ROOT)
    : path.resolve(__dirname, '..', '..');
}

const ROOT = resolveRoot();

// ── 事实采集的小工具（全部 fail-soft：读不到就返回 null，绝不抛） ────────────

const readText = (rel) => {
  try {
    const abs = path.join(ROOT, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  } catch {
    return null;
  }
};

const relExists = (rel) => {
  try {
    return fs.existsSync(path.join(ROOT, rel));
  } catch {
    return false;
  }
};

/** 短生命周期探测（非任务截止判定）：git 不可用 ⇒ ok=false，调用方据此报 UNKNOWN。 */
function gitProbe(gitArgs, timeoutMs = GIT_PROBE_TIMEOUT_MS) {
  try {
    const r = cp.spawnSync(gitBin(), gitArgs, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (r.error) return { ok: false, reason: r.error.code || r.error.message };
    return { ok: true, status: typeof r.status === 'number' ? r.status : -1, out: r.stdout || '', err: r.stderr || '' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * git 可执行文件。默认取 PATH 上的 `git`；`KHY_GIT_BIN` 可指向具体二进制
 * （便携版 / 自检环境里 git 常常装了但不在 PATH 上——那属于**环境**问题，
 * 不该让 D1/D3 永远读不出数）。[RUNTIME-001]：路径来自环境变量，非字面量。
 */
function gitBin() {
  const fromEnv = String(process.env.KHY_GIT_BIN || '').trim();
  return fromEnv || 'git';
}

/**
 * git 不可用时的现场诊断：把"本机没有 git 二进制"与"仓库索引已损坏"分开报。
 * 两者对读者的下一步动作完全不同（装 git / 修索引），只写"git 不可用"会让人误判。
 *
 * ⚠ 顺序很关键：ENOENT（git 压根没被调起来）**必须**先于锁/损坏件报告。
 * 否则本机会读到一条**指向错误修复动作**的诊断——实测：git 不在 PATH 时，
 * 只要 .git/ 里恰有一个陈旧的 index.lock，诊断就会说"疑似索引损坏 ⇒ 移除锁"，
 * 而真正的修复是"把 git 加进 PATH"。修错地方浪费时间，还会让人怀疑仓库真坏了。
 */
function gitDiagnosis(reason) {
  const notes = [];
  if (String(reason || '') === 'ENOENT') {
    notes.push(
      `git 二进制不在 PATH（spawnSync ENOENT；KHY_GIT_BIN ${process.env.KHY_GIT_BIN ? '已设置但仍不可执行' : '未设置'}）` +
        `⇒ 修复：把 git 加入 PATH，或用 KHY_GIT_BIN 指定 git 的绝对路径后重跑`
    );
  }
  let entries;
  try {
    entries = fs.readdirSync(path.join(ROOT, '.git'));
  } catch {
    if (!notes.length) return '（诊断：.git 目录不可读或不存在）';
    return `（诊断：${notes.join('；')}；另：.git 目录不可读或不存在）`;
  }
  const lock = entries.includes('index.lock');
  const damaged = entries.filter((f) => /^index\.(corrupt|bak)/.test(f));
  // git 调不起来时，锁与损坏件只是**观察**，不能据此断定它们就是原因。
  const prefix = notes.length ? '另观察到（不足以断定是本次原因）：' : '';
  if (lock) {
    let size = '未知';
    try {
      size = fs.statSync(path.join(ROOT, '.git', 'index.lock')).size;
    } catch {
      /* 读不到大小不影响"锁存在"这一事实 */
    }
    notes.push(`${prefix}.git/index.lock 存在（${size}${size === 0 ? ' 字节 ⇒ 陈旧锁' : ' 字节'}）`);
  }
  if (damaged.length) notes.push(`${prefix}索引损坏件/备份 ${damaged.join('、')}`);
  if (!notes.length) {
    return '（诊断：未见 index.lock 与索引损坏件 ⇒ 疑似 git 二进制不在 PATH）';
  }
  if (lock || damaged.length) {
    const hint = String(reason || '') === 'ENOENT'
      ? ''
      : '；修复：确认 git 可用后重跑 git status，必要时移除陈旧 .git/index.lock';
    return `（诊断：${notes.join('；')}${hint}）`;
  }
  return `（诊断：${notes.join('；')}）`;
}

/** 递归收集匹配的文件（相对路径，正斜杠）。受深度与数量上限保护，绝不失控。 */
function walk(rel, filter, acc = [], depth = 0) {
  if (depth > 8) return acc;
  const abs = path.join(ROOT, rel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const childRel = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__'].includes(e.name)) continue;
      walk(childRel, filter, acc, depth + 1);
    } else if (e.isFile() && filter(childRel)) {
      acc.push(childRel);
    }
    if (acc.length > 4000) return acc;
  }
  return acc;
}

/** 行号必须真实（0 号行永远匹配不上 khy-allow 抑制锚点）。 */
const lineOf = (text, needle) => {
  const i = String(text).indexOf(needle);
  return i < 0 ? 1 : String(text).slice(0, i).split('\n').length;
};

/**
 * 剥掉围栏代码块，只留正文。
 *
 * ⚠ 这一步是精度要求，不是洁癖：阈值 JSON 块里本来就含有 `electron` / `android` /
 * `nsis` 这些键名与 `"requiresUnsupportedList": true` 这类声明。若让判定扫全文，
 * 那个块会**自证**——"边界文档写了不支持清单"这件事会被 JSON 的键名满足，
 * 而不是被正文里的人话满足。低精度守卫比没有守卫更糟（[DESIGN-ARCH-127] §5）。
 */
const proseOf = (text) => String(text || '').replace(/```[\s\S]*?```/g, '\n');

// ── 阈值加载：只读文档，缺失即报 finding（禁止静默退回内置值） ──────────────

function loadThresholds() {
  const text = readText(THRESHOLD_DOC_REL);
  if (text === null) return { ok: false, reason: `阈值真源文档不存在：${THRESHOLD_DOC_REL}` };
  const fence = /```json\s*([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(text)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue; // 别的示例块解析失败与本块无关
    }
    if (parsed && parsed.$schema === THRESHOLD_SCHEMA) {
      return { ok: true, data: parsed, line: lineOf(text, THRESHOLD_SCHEMA) };
    }
  }
  return { ok: false, reason: `文档里找不到 $schema=${THRESHOLD_SCHEMA} 的 json 代码块` };
}

// ── 各判据实现：只返回读数，不做阶段降级（降级在输出层统一做） ──────────────

/** 收集 find 的结构：{ severity, finding, file, line, message } 或聚合形态。 */
function makeFindings() {
  const items = [];
  const add = (severity, finding, file, line, message) => {
    items.push({ severity, finding, file, line, message, aggregate: !file });
  };
  return { items, add };
}

/** 取诊断文本的首个非空行——现场样本比转述有用（原文照抄，不改写）。 */
function firstLine(text) {
  const line = String(text || '')
    .split(/\r?\n/)
    .find((l) => l.trim());
  return line ? line.trim().slice(0, 120) : '(无输出)';
}

/**
 * git 探针本身失败时，把三类原因分开报——它们的下一步动作完全不同：
 *   ETIMEDOUT ⇒ **探针预算不够**（不是 git 不可用），别去修索引；
 *   ENOENT    ⇒ git 不在 PATH，用 KHY_GIT_BIN 指定绝对路径；
 *   其他       ⇒ 现场诊断（陈旧锁 / 索引损坏件）。
 * 把三类混成一句「git 不可用」会让 D1 永远读不出数，还会把人引向错误的修复动作。
 */
function gitProbeFailure(probe, label) {
  const reason = String(probe.reason || '');
  if (reason === 'ETIMEDOUT') {
    return `${label} 在本次探针预算内没跑完 ⇒ 这不是「git 不可用」，而是对象库大到超预算：提高 GIT_FSCK_TIMEOUT_MS 后重跑，或手动跑一遍看结果`;
  }
  if (reason === 'ENOENT') return `git 二进制不可执行${gitDiagnosis(reason)}`;
  return `${label} 探测失败（${reason || '未知原因'}）${gitDiagnosis(reason)}`;
}

// ── D1 仓库完整性 ───────────────────────────────────────────────────────────
function checkD1(add) {
  const fsck = gitProbe(['fsck', '--no-progress', '--no-dangling'], GIT_FSCK_TIMEOUT_MS);
  const log = gitProbe(['log', '--oneline', '--all']);
  if (!fsck.ok || !log.ok) {
    const label = !fsck.ok ? 'git fsck' : 'git log --all';
    return { status: 'UNKNOWN', detail: `本机无法判定仓库完整性：${gitProbeFailure(!fsck.ok ? fsck : log, label)}` };
  }
  // 非工作树（fixture / 导出包 / 无 .git 的目录）：两个命令都会以 128 退出并报同一句。
  // 这条必须先判，否则"没有仓库"会被读成"仓库坏了"——那是两种完全不同的结论。
  const combined = `${fsck.out || ''}${fsck.err || ''}`;
  if (/not a git repository|this operation must be run in a work tree/i.test(combined)) {
    return {
      status: 'UNKNOWN',
      detail: `本目录不是 git 工作树 ⇒ D1 只能在真实克隆里复测（fixture / 导出包内没有 .git）。现场：${firstLine(combined)}`,
    };
  }
  const count = (re) => (fsck.out.match(re) || []).length;
  const missingBlob = count(/missing blob/g);
  const missingTree = count(/missing tree/g);
  const missingCommit = count(/missing commit/g);
  const brokenLink = count(/broken link from/g);
  const cacheTree = count(/invalid sha1 pointer in cache-tree/g);
  // 诊断分两股：断链/缺失走 stdout，`error: <oid>: ...`（如 hash-path mismatch）走 stderr。
  // 只数 stdout 会漏掉一整类损坏；只信退出码则读不出规模。两股都数。
  const objErrors = (fsck.err.match(/^error: /gm) || []).length;
  const total = missingBlob + missingTree + missingCommit + brokenLink + cacheTree + objErrors;
  const logFatal = log.status !== 0;
  const fsckFailed = fsck.status !== 0;
  const detail = `git fsck 退出码=${fsck.status} · missing blob=${missingBlob} · tree=${missingTree} · commit=${missingCommit} · broken link=${brokenLink} · cache-tree=${cacheTree} · 对象库报错行=${objErrors} · git log --all 退出码=${log.status}`;
  if (total > 0 || logFatal || fsckFailed) {
    add(
      'error',
      'delivery-repo-integrity',
      null,
      0,
      `仓库完整性不达标：交付的第一动作是 git clone，一个 git log --all 都失败或对象库有洞的仓库对下游不可审计（[DESIGN-DELIV-001] D1）。实测 ${detail}。样本：${firstLine(fsck.out || fsck.err)}`
    );
    return { status: 'GAP', detail };
  }
  return { status: 'PASS', detail };
}

// ── D2 发布物真实存在 ───────────────────────────────────────────────────────
function checkD2(add, th) {
  const cfg = (th && th.artifactRoot) || {};
  const rootRel = cfg.path || 'dist';
  const abs = path.join(ROOT, rootRel);
  if (!relExists(rootRel)) {
    add(
      'error',
      'delivery-artifact-missing',
      null,
      0,
      `发布物根目录 ${rootRel}/ 不存在 ⇒ 可安装包从未在本机产出过（[DESIGN-DELIV-001] D2）。判据：${rootRel}/ 内 wheel + sdist 均存在且非零字节。`
    );
    return { status: 'GAP', detail: `${rootRel}/ 不存在` };
  }
  const kinds = { wheel: /\.whl$/, sdist: /\.tar\.gz$/, npm: /\.tgz$/ };
  const wanted = Array.isArray(cfg.requiredFiles) && cfg.requiredFiles.length ? cfg.requiredFiles : ['wheel', 'sdist'];
  const found = walk(rootRel, () => true);
  const nonEmpty = found.filter((f) => {
    try {
      return fs.statSync(path.join(ROOT, f)).size > 0;
    } catch {
      return false;
    }
  });
  const missing = wanted.filter((k) => kinds[k] && !nonEmpty.some((f) => kinds[k].test(f)));
  if (missing.length) {
    add(
      'error',
      'delivery-artifact-missing',
      null,
      0,
      `${rootRel}/ 存在但缺少非零字节的：${missing.join(', ')}（现 ${nonEmpty.length} 个非空文件）——「命令写好了」不等于「产物做出来了」。`
    );
    return { status: 'GAP', detail: `${rootRel}/ 缺 ${missing.join(',')}` };
  }
  return { status: 'PASS', detail: `${rootRel}/ 含 ${wanted.join(' + ')}（${nonEmpty.length} 个非空文件）` };
}

// ── D3 新克隆零缺件 ─────────────────────────────────────────────────────────
function checkD3(add) {
  const st = gitProbe(['status', '--porcelain']);
  if (!st.ok) return { status: 'UNKNOWN', detail: `git 不可用 ⇒ 无法读工作区状态${gitDiagnosis(st.reason)}` };
  // ⚠ 退出码必须先判：`git status` 在非工作树里以 128 退出、stdout 为空 —— 若只数行，
  // 空输出会被读成 `?? = 0 · D = 0` 并给出 **PASS**。本机 git 在 PATH 上而目录不是仓库
  // （fixture / 导出包 / sdist 解包目录）时就会踩到；本仓的 D3 用例正是在这里翻红的。
  // 与 D1 同款两条分支：非工作树 → UNKNOWN；其它非零退出码 → UNKNOWN（不假装零缺件）。
  if (st.status !== 0) {
    const combined = `${st.out || ''}${st.err || ''}`;
    if (/not a git repository|this operation must be run in a work tree/i.test(combined)) {
      return {
        status: 'UNKNOWN',
        detail: `本目录不是 git 工作树 ⇒ D3 只能在真实克隆里复测（fixture / 导出包内没有 .git）。现场：${firstLine(combined)}`,
      };
    }
    return { status: 'UNKNOWN', detail: `git status 退出码=${st.status} ⇒ 读不出工作区状态，不假装零缺件。现场：${firstLine(combined)}` };
  }
  const lines = st.out.split(/\r?\n/).filter((l) => l.trim());
  const untracked = lines.filter((l) => l.startsWith('??')).length;
  const deleted = lines.filter((l) => /^(D|.D)/.test(l)).length;
  const detail = `?? = ${untracked} · D = ${deleted}（改动集 ${lines.length} 项）`;
  if (untracked > 0 || deleted > 0) {
    add(
      'error',
      'delivery-clone-incomplete',
      null,
      0,
      `工作区与任何已提交状态都不一致：${detail}。克隆出来的必须就是能跑的那份（[DESIGN-DELIV-001] D3）——未跟踪的真实缺件会让新克隆少文件，已删除未提交会让"读到的工作区"不等于 HEAD。`
    );
    return { status: 'GAP', detail };
  }
  return { status: 'PASS', detail };
}

// ── D4 失败必须阻断（校验类步骤不得被吞） ───────────────────────────────────
function checkD4(add) {
  const targets = [RELEASE_WORKFLOW_REL, ...walk('scripts/release', (f) => /\.(js|sh|ps1|py|mjs)$/.test(f))];
  const verifyish = /sign|verify|checksum|audit|sbom/i;
  const swallowed = /\|\|\s*(echo|true)\b|continue-on-error\s*:\s*true/;
  const hits = [];
  for (const rel of targets) {
    const text = readText(rel);
    if (!text) continue;
    text.split(/\r?\n/).forEach((line, i) => {
      if (line.trim().startsWith('#')) return; // 注释不执行，也不参与判定
      if (verifyish.test(line) && swallowed.test(line)) hits.push({ rel, line: i + 1, text: line.trim().slice(0, 160) });
    });
  }
  if (hits.length) {
    for (const h of hits) {
      // ⚠ 路径必须不含空格：FINDING_LINE 的 file 捕获组是 \S+。
      if (/\s/.test(h.rel)) continue;
      add('error', 'delivery-swallowed-failure', h.rel, h.line, `校验类步骤失败被吞掉，发布仍继续：${h.text}。判据是"校验不是可选项"——签名/校验和/审计失败必须使整次发布 NO-GO，或明确声明本仓不做它并移除该步骤。`);
    }
    return { status: 'GAP', detail: `${hits.length} 处校验类步骤失败被吞` };
  }
  return { status: 'PASS', detail: '发布链上无被吞掉的校验类步骤' };
}

// ── D5 产物校验和可被下载侧独立验证 ─────────────────────────────────────────
function checkD5(add) {
  const targets = [RELEASE_WORKFLOW_REL, ...walk('scripts/release', (f) => /\.(js|sh|ps1|py|mjs)$/.test(f))];
  let generates = null;
  for (const rel of targets) {
    const text = readText(rel);
    if (text && /SHA256SUMS|sha256sum|\.sha256\b/i.test(text)) {
      generates = rel;
      break;
    }
  }
  if (!generates) {
    add(
      'error',
      'delivery-checksum-not-published',
      null,
      0,
      '发布链上看不到任何校验和信息（SHA256SUMS / .sha256）⇒ 下载侧无法独立校验产物完整性（[DESIGN-DELIV-001] D5，对标 ZCode 与 tarball 同目录的 sha256.txt）。'
    );
    return { status: 'GAP', detail: '未发现校验和生成' };
  }
  const text = readText(generates) || '';
  const published = /upload|attach|release\s+(create|upload)|gh release/i.test(text);
  if (!published) {
    add(
      'error',
      'delivery-checksum-not-published',
      /\s/.test(generates) ? null : generates,
      /\s/.test(generates) ? 0 : 1,
      `校验和只在 ${generates} 里生成，但看不到把它与产物同源发布出去的步骤 ⇒ 生成但无回路，等于装饰（[DESIGN-DELIV-001] D5）。`
    );
    return { status: 'GAP', detail: `${generates} 生成但未见发布回路` };
  }
  return { status: 'PASS', detail: `${generates} 生成且见发布回路` };
}

// ── D6 SBOM 必须被消费 ─────────────────────────────────────────────────────
function checkD6(add) {
  const text = readText(RELEASE_WORKFLOW_REL);
  if (!text) return { status: 'UNKNOWN', detail: `${RELEASE_WORKFLOW_REL} 不存在 ⇒ 无法判定` };
  if (!/sbom/i.test(text)) {
    add('error', 'delivery-sbom-unconsumed', RELEASE_WORKFLOW_REL, 1, '发布链上没有 SBOM ⇒ 下游无从扫漏洞（[DESIGN-DELIV-001] D6）。');
    return { status: 'GAP', detail: '无 SBOM' };
  }
  const consumer = /grype|osv-scanner|trivy|anchore|cyclonedx.*validate/i.exec(text);
  if (!consumer) {
    add(
      'error',
      'delivery-sbom-unconsumed',
      RELEASE_WORKFLOW_REL,
      lineOf(text, 'sbom') || 1,
      'SBOM 被生成，但同一条 workflow 里没有任何消费步骤（grype / osv-scanner / trivy 等）⇒ 只 upload-artifact 的 SBOM 是装饰，不是保障（[DESIGN-DELIV-001] D6）。'
    );
    return { status: 'GAP', detail: 'SBOM 生成但无消费者' };
  }
  return { status: 'PASS', detail: `SBOM 有消费者：${consumer[0]}` };
}

// ── D7 债务必须可收敛（复用既有棘轮，不新建机制） ───────────────────────────
function checkD7(add) {
  const scriptRel = 'scripts/ci/check-debt-ledger.js';
  if (!relExists(scriptRel)) return { status: 'UNKNOWN', detail: '既有棘轮 check-debt-ledger.js 不存在' };
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, scriptRel)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: GIT_PROBE_TIMEOUT_MS * 4,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) return { status: 'UNKNOWN', detail: `棘轮跑不起来：${r.error.code || r.error.message}` };
  const status = typeof r.status === 'number' ? r.status : -1;
  if (status !== 0) {
    add(
      'error',
      'delivery-debt-not-converging',
      null,
      0,
      `既有债务棘轮（check-debt-ledger）未通过（退出码 ${status}）⇒ 存量豁免不再单调递减，棘轮失效（[DESIGN-DELIV-001] D7）。棘轮本仓已验证，故复用而不新建。`
    );
    return { status: 'GAP', detail: `check-debt-ledger 退出码 ${status}` };
  }
  return { status: 'PASS', detail: '既有棘轮通过（measured → target 单调）' };
}

// ── D8 发布相关机制不得停在 S1 超一个周期 ───────────────────────────────────
function checkD8(add, th) {
  const raw = readText(OWNERSHIP_REL);
  const stages = readText(STAGES_LIB_REL);
  if (!raw || !stages) return { status: 'UNKNOWN', detail: '登记表或发布门阶段表读不到' };
  let mechanisms;
  try {
    mechanisms = (JSON.parse(raw).rollout || {}).mechanisms || [];
  } catch {
    return { status: 'UNKNOWN', detail: '登记表不是合法 JSON' };
  }
  const maxDays = Number((th && th.thresholds && th.thresholds.s1MaxDays) || 90);
  const now = Date.now();
  const overdue = [];
  for (const m of mechanisms) {
    const stage = String(m.stage || '');
    if (stage !== 'S1' && stage !== 'S2') continue;
    const exec = String((m.executorStage && m.executorStage.file) || m.executor || '');
    const base = exec ? path.basename(exec) : '';
    if (!base || !stages.includes(base)) continue; // 与发布门无关的机制不在此项管辖内
    const since = Date.parse(String(m.stageSince || ''));
    if (!Number.isFinite(since)) {
      overdue.push(`${m.id}(无 stageSince)`);
      continue;
    }
    const days = Math.floor((now - since) / 86400000);
    if (days > maxDays) overdue.push(`${m.id}(${stage} ${days} 天 > ${maxDays})`);
  }
  if (overdue.length) {
    add(
      'error',
      'delivery-stage-unsettled',
      null,
      0,
      `发布相关机制停在观察档超过一个周期（阈值 ${maxDays} 天）：${overdue.join('、')} ⇒ S1 正在变成墓碑：登记了观察期却从不结算（[DESIGN-DELIV-001] D8）。`
    );
    return { status: 'GAP', detail: overdue.join('、') };
  }
  return { status: 'PASS', detail: `无发布相关机制逾期停在 S1/S2（阈值 ${maxDays} 天）` };
}

// ── D9 端到端黄金路径已被验证 ───────────────────────────────────────────────
function checkD9(add) {
  const stages = readText(STAGES_LIB_REL) || '';
  const hasGolden = /check-golden-path|golden-path/i.test(stages);
  const scriptExists = relExists('scripts/ci/check-golden-path.js');
  if (!hasGolden || !scriptExists) {
    add(
      'error',
      'delivery-golden-path-unverified',
      null,
      0,
      `不存在被发布门引用的黄金路径检查（脚本存在=${scriptExists} · 门引用=${hasGolden}）⇒ "从零到可运行"没有任何一条被端到端验证过（[DESIGN-DELIV-001] D9）。对标：ZCode 的 install.sh、opencode 的一行 curl | bash。`
    );
    return { status: 'GAP', detail: `脚本存在=${scriptExists} · 门引用=${hasGolden}` };
  }
  return { status: 'PASS', detail: '黄金路径检查存在且已被门引用' };
}

// ── D10 边界必须写明（含"不支持清单"） ──────────────────────────────────────
function checkD10(add, th) {
  const cfg = (th && th.boundaryDoc) || {};
  const docRel = cfg.docPath || THRESHOLD_DOC_REL;
  const text = readText(docRel);
  if (text === null) {
    add('error', 'delivery-boundary-missing', null, 0, `边界文档不存在：${docRel}（[DESIGN-DELIV-001] D10）。`);
    return { status: 'GAP', detail: '边界文档不存在' };
  }
  const needsUnsupported = cfg.requiresUnsupportedList !== false;
  const hasUnsupported = /不支持/.test(proseOf(text));
  if (needsUnsupported && !hasUnsupported) {
    add(
      'error',
      'delivery-boundary-missing',
      null,
      0,
      `边界文档存在但不含"不支持清单"⇒ 读者无法知道什么不用指望（[DESIGN-DELIV-001] D10）。对标 opencode SECURITY.md 明文写"Windows package managers are not supported"。`
    );
    return { status: 'GAP', detail: '边界文档缺不支持清单' };
  }
  return { status: 'PASS', detail: `${docRel} 含不支持清单` };
}

// ── 任务面棘轮（[DESIGN-DELIV-002] §2.3 棘轮 1/2） ──────────────────────────
function countRouterCommands() {
  const rel = 'runtime/node/backend/src/constants/commandSchema.js';
  const text = readText(rel);
  if (!text) return null;
  const m = /ROUTER_COMMANDS\s*[:=]\s*\[([\s\S]*?)\]/.exec(text);
  if (!m) return null;
  const ids = m[1].split(',').map((s) => s.trim().replace(/^['"`]|['"`]$/g, '')).filter(Boolean);
  return ids.length || null;
}

function countAliasEntries() {
  const rel = 'runtime/node/backend/src/cli/aliases.js';
  const text = readText(rel);
  if (!text) return null;
  const n = (text.match(/\bcommand\s*:/g) || []).length;
  return n || null;
}

function countHandlerFiles() {
  try {
    return fs.readdirSync(path.join(ROOT, 'runtime/node/backend/src/cli/handlers')).filter((f) => f.endsWith('.js')).length || null;
  } catch {
    return null;
  }
}

function countRules() {
  try {
    const j = JSON.parse(readText(REGISTRY_REL) || '{}');
    return Array.isArray(j.rules) ? j.rules.length : null;
  } catch {
    return null;
  }
}

function checkSurfaceRatchet(add, th) {
  const base = (th && th.ratchet) || {};
  const src = { routerCommands: countRouterCommands, aliasEntries: countAliasEntries, handlerFiles: countHandlerFiles, ruleCount: countRules };
  const readings = [];
  let breached = 0;
  for (const key of Object.keys(src)) {
    const cfg = base[key];
    if (!cfg || typeof cfg.baseline !== 'number') continue;
    const measured = src[key]();
    if (measured === null) {
      readings.push(`${key}=?`);
      continue;
    }
    readings.push(`${key}=${measured}/${cfg.baseline}`);
    if (measured > cfg.baseline) breached += 1;
  }
  if (breached > 0) {
    add(
      'error',
      'delivery-surface-ratchet-breach',
      null,
      0,
      `任务面棘轮被突破（只降不升）：${readings.join(' · ')} ⇒ 命令面在扩，不在收（[DESIGN-DELIV-002] §2.3）。要加一个命令，先退役一个；基线只在退役后下调。`
    );
    return { status: 'GAP', detail: readings.join(' · '), readings };
  }
  return { status: 'PASS', detail: readings.join(' · '), readings };
}

// ── 有构建脚本但没有 CI 的交付渠道（[DESIGN-DELIV-002] §3.2） ──────────────
function checkChannels(add, th) {
  const ch = (th && th.channels) || {};
  const noCi = [];
  for (const [name, cfg] of Object.entries(ch)) {
    if (name === 'note' || !cfg || typeof cfg !== 'object') continue;
    if (cfg.ciWorkflow === null) noCi.push(name);
  }
  if (!noCi.length) return { status: 'PASS', detail: '每个声明的渠道都有 CI workflow' };
  // 只认正文（不看阈值 JSON 块里的键名），且大小写不敏感 —— 正文里写的是
  // `Electron` / `Android` / `NSIS`，键名是 `electron` / `android` / `nsis`。
  const boundary = proseOf(readText(THRESHOLD_DOC_REL));
  const undeclared = noCi.filter((n) => !new RegExp(n, 'i').test(boundary));
  if (undeclared.length) {
    add(
      'error',
      'delivery-channel-no-ci',
      null,
      0,
      `渠道 ${undeclared.join('、')} 有构建脚本但无 CI workflow，且未在边界文档正文里声明为"不承诺交付"⇒ 用户会以为它们可用（[DESIGN-DELIV-002] §3.2/§3.3）。二选一：补 CI，或宣布不交付。`
    );
    return { status: 'GAP', detail: `无 CI 且未声明：${undeclared.join('、')}` };
  }
  return { status: 'PASS', detail: `无 CI 渠道已在边界文档声明不承诺交付：${noCi.join('、')}` };
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

function main() {
  const { items, add } = makeFindings();
  const results = [];

  const th = loadThresholds();
  if (!th.ok) {
    add(
      'error',
      'delivery-thresholds-missing',
      null,
      0,
      `${th.reason} ⇒ 阈值与任务面基线失去单一真源。本守卫**故意不**退回内置默认值：删掉真源必须让读数失去意义，而不是静默继续（防空转断言，[DESIGN-DELIV-002] §2.4）。`
    );
  }
  const data = th.ok ? th.data : null;

  // D1/D2/D3/D7 是全仓状态读数，与单次提交无关 ⇒ --changed 下不报（但仍测量并计入 JSON）。
  const reportFullState = !changedMode;

  const d1 = checkD1(reportFullState ? add : () => {});
  const d2 = checkD2(reportFullState ? add : () => {}, data);
  const d3 = checkD3(reportFullState ? add : () => {});
  const d4 = checkD4(add);
  const d5 = checkD5(add);
  const d6 = checkD6(add);
  const d7 = checkD7(reportFullState ? add : () => {});
  const d8 = checkD8(add, data);
  const d9 = checkD9(add);
  const d10 = checkD10(add, data);
  const surf = checkSurfaceRatchet(add, data);
  const chan = checkChannels(add, data);

  results.push({ id: 'D1', title: '仓库完整性', ...d1 });
  results.push({ id: 'D2', title: '发布物真实存在', ...d2 });
  results.push({ id: 'D3', title: '新克隆零缺件', ...d3 });
  results.push({ id: 'D4', title: '失败必须阻断', ...d4 });
  results.push({ id: 'D5', title: '产物完整性可验（校验和）', ...d5 });
  results.push({ id: 'D6', title: 'SBOM 被消费', ...d6 });
  results.push({ id: 'D7', title: '债务可收敛', ...d7 });
  results.push({ id: 'D8', title: '阶段已结算', ...d8 });
  results.push({ id: 'D9', title: '端到端黄金路径', ...d9 });
  results.push({ id: 'D10', title: '边界写明', ...d10 });
  results.push({ id: 'TS', title: '任务面棘轮', ...surf });
  results.push({ id: 'CH', title: '交付渠道有 CI 或已声明', ...chan });

  // ── 阶段降级（PROCESS-008 PP-3）：S1/S2 只记录不阻断 ────────────────────
  const isObserver = OBSERVER_STAGES.has(STAGE);
  const effective = items.map((f) => ({
    ...f,
    severity: isObserver && !strictMode && f.severity === 'error' ? 'warning' : f.severity,
  }));

  const counts = {
    PASS: results.filter((r) => r.status === 'PASS').length,
    PARTIAL: results.filter((r) => r.status === 'PARTIAL').length,
    GAP: results.filter((r) => r.status === 'GAP').length,
    UNKNOWN: results.filter((r) => r.status === 'UNKNOWN').length,
  };
  const errors = effective.filter((f) => f.severity === 'error');
  const warnings = effective.filter((f) => f.severity === 'warning');

  // ── 机读输出 ────────────────────────────────────────────────────────────
  if (jsonMode) {
    process.stdout.write(
      JSON.stringify(
        {
          stage: STAGE,
          root: ROOT,
          counts,
          results,
          findings: effective,
          thresholds: th.ok ? { ok: true, schema: data.$schema, updated: data.updated } : { ok: false, reason: th.reason },
        },
        null,
        2
      ) + '\n'
    );
    return strictMode && counts.GAP > 0 ? 1 : 0;
  }

  // ── 人读记分板 → stderr（stdout 必须留给 finding） ──────────────────────
  const w = process.stderr;
  w.write(`== 可交付性记分板（PROCESS-014 · [DESIGN-DELIV-001] D1–D10）==\n`);
  w.write(`阶段: ${STAGE}${isObserver ? '（观察者：只记录不阻断）' : ''}   根: ${ROOT}\n`);
  w.write(`阈值真源: ${th.ok ? THRESHOLD_DOC_REL : `缺失（${th.reason}）`}\n`);
  w.write(`${'-'.repeat(72)}\n`);
  for (const r of results) {
    w.write(`[${r.id} ${String(r.status).padEnd(7)}] ${r.title}\n`);
    w.write(`            ${r.detail}\n`);
    if (explainMode) w.write(`            判据来源：[DESIGN-DELIV-001] §3 / 阈值见 [DESIGN-DELIV-002] §4\n`);
  }
  w.write(`${'-'.repeat(72)}\n`);
  w.write(`汇总: PASS ${counts.PASS} · PARTIAL ${counts.PARTIAL} · GAP ${counts.GAP} · UNKNOWN ${counts.UNKNOWN}\n`);
  if (isObserver && !strictMode && items.some((f) => f.severity === 'error')) {
    w.write(`注: 阶段 ${STAGE} 下 ${items.filter((f) => f.severity === 'error').length} 个 GAP 已降级为 WARN（不参与放行）。升阶见 [DESIGN-DELIV-002] §5.2。\n`);
  }

  // ── findings → stdout（ruleguard 方言） ────────────────────────────────
  for (const f of effective) {
    const tag = f.severity === 'error' ? '[ERROR]' : '[WARN ]';
    if (f.aggregate) {
      process.stdout.write(`- [${f.severity}] ${f.message} (id: ${f.finding})\n`);
    } else {
      process.stdout.write(`${tag} ${f.finding} ${f.file}:${f.line}\n`);
      process.stdout.write(`  ${f.message}\n`);
    }
  }
  process.stdout.write(`Summary: ${errors.length} error(s), ${warnings.length} warning(s).\n`);

  return strictMode && (errors.length > 0 || counts.GAP > 0) ? 1 : 0;
}

process.exit(main());