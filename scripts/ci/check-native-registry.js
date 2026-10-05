#!/usr/bin/env node
'use strict';

/**
 * check-native-registry.js — `PROCESS-013`「构建与交付依赖须原生官方源」的执行器。
 *
 * ## 为什么需要它
 *
 * `docker compose up` 一键部署的前提是**镜像可复现**。只要构建链路里出现
 * 「阿里云 / 淘宝 / 清华」这类公共镜像主机，镜像内容就取决于构建机所在网络：
 * 同一份 Dockerfile 在两地构建会拉到不同 tarball（甚至镜像未同步时的旧版本），
 * 而**没有任何既有守卫会发现这件事** —— 构建照样成功，产物却不可复现。
 *
 * 实测起点（2026-09-23）：`runtime/node/backend/Dockerfile` 有 3 处 `-i mirrors.aliyun.com`，
 * 6 个 `package-lock.json` 共 3005 条 `resolved` 指向 `registry.npmmirror.com`。
 *
 * ## 三层判据（分工明确，不重叠）
 *
 * | 层 | 判据 id | 管辖 | 是否容忍镜像 |
 * |---|---|---|---|
 * | 构建/交付配置 | `non-native-registry` | Dockerfile / compose / .npmrc / CI / 构建脚本 / **package.json** | **零容忍** |
 * | 构建参数 | `mirror-injection-knob` | `*_MIRROR` 形态的注入开关 | 零容忍（开关本身就是口子） |
 * | 锁文件 | `non-official-lockfile-resolution` | `package-lock.json` 的 `resolved` | 只认官方 host |
 * | 运行时源码 | `ungated-runtime-mirror` | `platform/**`、`services/**`、`software/**` | **须显式开关门控** |
 *
 * 运行时那一层为什么不是零容忍：`_bootstrap.py` 的国内加速是**刻意设计**的用户体验
 * （按需自愈装 `node-llama-cpp` 时国内直连极易失败）。规范对它的要求不是「删掉」，
 * 而是「**不得默认生效**」—— 故判据是「镜像主机出现在运行时源码里，且同文件没有出现
 * 显式开关名」。想用镜像，就必须在同一个文件里写出开关常量。
 *
 * ## 门档语义
 *
 * `gate=commit` + `severity=advisory`（`PROCESS-006` PP-1 观察期）：
 * - 恒 `exit 0`，不阻断任何提交；
 * - 但会出现在 `rules:gate:commit` 的 `action=start` 里 ⇒ 证明它**真的被执行**，
 *   而不是像 `gate=advisory` 那样恒不被 spawn（见登记表 meta.note 的 2026-09-18 订正）。
 *
 * ⚠ `STAGE` 是阶段唯一权威（`FEATURE-OWNERSHIP.json` 只是镜像，`check-rollout-stage.js`
 * 会比对两者，漂移即 error）。`severityFor()` 由 `STAGE` **单点派生** —— 若把 severity
 * 写死在判定处，S1 与 S3 会跑出完全相同的输出，升阶后仍然不拦截，而所有守卫全绿。
 * 测试 `scripts/tests/check-native-registry.test.js` 专门钉死「S1 与 S3 的 error 数必须不同」。
 *
 * ## 用法
 *
 *   node scripts/ci/check-native-registry.js                 # 全量扫描
 *   node scripts/ci/check-native-registry.js --changed        # commit 快档（只看暂存集）
 *   node scripts/ci/check-native-registry.js --worktree       # 工作区全量（含未暂存）
 *   node scripts/ci/check-native-registry.js --files=a,b      # 指定文件
 *   node scripts/ci/check-native-registry.js --json           # 机器可读
 *   node scripts/ci/check-native-registry.js --list           # 列出豁免登记
 *   node scripts/ci/check-native-registry.js --scenario=<名>  # 离线场景（不读盘）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── 阶段常量：唯一权威（FEATURE-OWNERSHIP.json 的 rollout 段只是镜像）──────────
const STAGE = 'S1';

/** 已知公共镜像主机（不带 scheme 也能命中，因为源码里常只写主机名）。 */
const MIRROR_HOST_PATTERNS = [
  'npmmirror\\.com',
  'mirrors?\\.aliyun\\.com',
  'mirrors?\\.aliyuncs\\.com',
  'mirrors?\\.cloud\\.tencent\\.com',
  'mirrors?\\.tencent\\.com',
  'mirrors?\\.tuna\\.tsinghua\\.edu\\.cn',
  'pypi\\.tuna\\.tsinghua\\.edu\\.cn',
  'mirrors?\\.ustc\\.edu\\.cn',
  'mirrors?\\.sustc\\.edu\\.cn',
  'mirrors?\\.huaweicloud\\.com',
  'repo\\.huaweicloud\\.com',
  'mirrors?\\.163\\.com',
  'mirrors?\\.sohu\\.com',
  'mirrors?\\.bfsu\\.edu\\.cn',
  'mirrors?\\.nju\\.edu\\.cn',
  'mirrors?\\.zju\\.edu\\.cn',
  'mirrors?\\.pku\\.edu\\.cn',
  'mirror\\.sjtu\\.edu\\.cn',
  'mirrors?\\.sjtug\\.sjtu\\.edu\\.cn',
  'mirrors?\\.cernet\\.edu\\.cn',
  'npm\\.taobao\\.org',
  'registry\\.cnpmjs\\.org',
  'pypi\\.douban(?:io)?\\.com',
];

const MIRROR_LINE_RE = new RegExp(`(${MIRROR_HOST_PATTERNS.join('|')})`, 'i');

/** `*_MIRROR` 形态的注入开关：开关本身就是一个「把镜像塞进构建」的口子。 */
const MIRROR_KNOB_RE = /\b[A-Z][A-Z0-9_]*_MIRROR\b/;

/** 锁文件里允许出现的下载 host（官方源）。 */
const OFFICIAL_LOCKFILE_HOSTS = new Set(['registry.npmjs.org']);

/** 运行时「显式开关」的名字：出现其一即视为已门控。 */
const EXPLICIT_GATE_NAMES = ['KHY_USE_CN_MIRROR', 'KHY_KHYOS_PREFER_CN'];

/**
 * 豁免登记（每条必须带 reason；reviewBy 到期后应重判，不允许无限期挂着）。
 * 只接受「镜像主机出现在**非配置语境**」的文件，配置类文件一律不豁免。
 */
const EXEMPT = [
  {
    path: 'runtime/node/backend/src/services/offlineKnowledge.js',
    reason: '离线知识库的正文文本，镜像地址是「给用户看的说明」而非可执行配置',
    reviewBy: '2027-03-31',
  },
];

// ── 文件分类 ─────────────────────────────────────────────────────────────────

const BUILD_CONFIG_BASENAME_RE = [
  /^Dockerfile(\..+)?$/i,
  /^docker-compose.*\.ya?ml$/i,
  /^compose.*\.ya?ml$/i,
  /^\.npmrc$/,
  // package.json 同属构建配置：`scripts.*` 是构建入口，且 electron-builder 的
  // `build.electronDownload.mirror` 会把镜像钉进**构建期下载**。
  // 实测 2026-09-23：delivery/desktop/khyos-desktop/package.json 的 electronDownload.mirror
  // 指向 npmmirror 且无任何开关门控 —— 属 C1 零容忍（此前因本集合不含 package.json
  // 而静默漏检）。
  /^package\.json$/,
  /^package-lock\.json$/,
  /^npm-shrinkwrap\.json$/,
  /^pnpm-lock\.yaml$/,
  /^requirements.*\.txt$/i,
  /^constraints.*\.txt$/i,
  /^pip\.conf$/i,
  /^pip\.ini$/i,
  /^pyproject\.toml$/,
  /^setup\.cfg$/,
  /^fly.*\.toml$/i,
  /^Makefile$/,
  /\.nsi$/i,
];

const LOCKFILE_BASENAME_RE = [/^package-lock\.json$/, /^npm-shrinkwrap\.json$/];

/** 归一化路径：统一为正斜杠、去掉 `./` 前缀。 */
function normalize(rel) {
  return String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function isWorkflow(rel) {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel);
}

function isLockfile(rel) {
  const base = rel.split('/').pop();
  return LOCKFILE_BASENAME_RE.some((re) => re.test(base));
}

function isBuildConfig(rel) {
  if (isWorkflow(rel)) return true;
  const base = rel.split('/').pop();
  if (BUILD_CONFIG_BASENAME_RE.some((re) => re.test(base))) return true;
  // 安装/构建类脚本：镜像写进去同样是「构建不可复现」
  return /\.(sh|ps1|psm1|bat|cmd)$/i.test(base);
}

const RUNTIME_SOURCE_RE = [
  /^platform\/.*\.py$/,
  /^services\/.*\.(js|mjs|cjs|ts)$/,
  /^software\/.*\.(py|js|mjs|cjs|ts|vue)$/,
  /^apps\/.*\.(js|mjs|cjs|ts|vue)$/,
  /^extensions\/.*\.(js|mjs|cjs|ts|py)$/,
];

function isRuntimeSource(rel) {
  return RUNTIME_SOURCE_RE.some((re) => re.test(rel));
}

function isExempt(rel) {
  return EXEMPT.find((e) => e.path === rel);
}

// ── 判定（纯函数，零 I/O，便于离线单测）──────────────────────────────────────

/** 内部 severity 只存小写规范形；渲染时经 `labelOf()` 映射成定宽 6 字符方言。 */
function severityFor(criterion, stage = STAGE) {
  // S1/S2 观察期：一律降级为 warning，且不参与放行（PROCESS-006 PP-3）
  if (stage === 'S1' || stage === 'S2') return 'warning';
  if (criterion === 'non-native-registry') return 'error';
  if (criterion === 'non-official-lockfile-resolution') return 'error';
  // 开关与「未门控」两类在 S3 仍只提示：它们是前置条件而非最终产物问题
  return 'warning';
}

function labelOf(severity) {
  return severity === 'error' ? '[ERROR]' : '[WARN ]';
}

/** 在一行里找镜像主机，返回命中的主机文本（找不到返 null）。 */
function mirrorHostInLine(line) {
  const m = MIRROR_LINE_RE.exec(line);
  return m ? m[1] : null;
}

/**
 * 是否为注释行。
 *
 * ⚠ 这一条是精度关键：本守卫要求「删除镜像注入口子」，而**解释为什么删除**的注释
 * 必然要提到 `APT_MIRROR` 这类名字 —— 不排除注释就会让守卫去报自己的说明文字，
 * 于是每加一句解释就多一条误报。实测初版对真实仓库跑出 5 条这样的自伤误报。
 *
 * 注释不参与执行，故一律跳过（`.npmrc` 里被注释掉的 `registry=` 同样不生效）。
 */
const COMMENT_PREFIXES = ['#', '//', '<!--'];

function isCommentLine(line) {
  const t = String(line == null ? '' : line).trimStart();
  return COMMENT_PREFIXES.some((p) => t.startsWith(p));
}

/** 取一行里第一个 http(s) host（用于锁文件 resolved 判定）。 */
function hostOfLine(line) {
  const m = /https?:\/\/([^/\s"'\\]+)/i.exec(line);
  return m ? m[1].toLowerCase() : null;
}

/**
 * 判定一个文件的内容。纯函数：同样输入必得同样输出，不读盘、不看时间。
 * @param {{path:string, content:string}} entry
 * @param {{stage?:string}} [opts]
 * @returns {Array<{criterion:string,severity:string,line:number,message:string}>}
 */
function evaluateFile(entry, opts = {}) {
  const stage = opts.stage || STAGE;
  const rel = normalize(entry.path);
  const content = String(entry.content == null ? '' : entry.content);
  const lines = content.split(/\r?\n/);
  const out = [];

  const exempt = isExempt(rel);
  if (exempt) return out;

  // ── 锁文件：只看 resolved 的 host 是否官方（这一条已涵盖「已知镜像」）──────
  if (isLockfile(rel)) {
    const bad = [];
    const hosts = new Map();
    lines.forEach((line, i) => {
      if (!/"resolved"\s*:/.test(line)) return;
      const host = hostOfLine(line);
      if (!host) return;
      if (OFFICIAL_LOCKFILE_HOSTS.has(host)) return;
      bad.push(i + 1);
      hosts.set(host, (hosts.get(host) || 0) + 1);
    });
    if (bad.length) {
      const detail = [...hosts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([h, n]) => `${h}×${n}`)
        .join(', ');
      out.push({
        criterion: 'non-official-lockfile-resolution',
        severity: severityFor('non-official-lockfile-resolution', stage),
        line: bad[0],
        message: `${bad.length} 处 resolved 指向非官方 host（${detail}）；锁文件应只解析到 registry.npmjs.org`,
      });
    }
    return out;
  }

  // ── 构建 / 交付配置：镜像零容忍，另抓注入开关 ─────────────────────────────
  if (isBuildConfig(rel)) {
    // ① 镜像主机：逐行报（行级才可行动，且能挂 khy-allow 抑制锚点）
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      const host = mirrorHostInLine(line);
      if (!host) return;
      out.push({
        criterion: 'non-native-registry',
        severity: severityFor('non-native-registry', stage),
        line: i + 1,
        message: `构建/交付配置指向公共镜像 ${host}；须改为官方源（pypi.org / registry.npmjs.org / deb.debian.org）`,
      });
    });

    // ② 注入开关：**按 (文件, 开关名) 去重**。
    // 一个 `ARG APT_MIRROR` 会在声明 + 4 处引用上各命中一次，逐行报会让单个文件
    // 产出 5 条同义 finding ⇒ 快档信噪比归零 ⇒ 整条守卫被忽略（比没有守卫更糟）。
    const knobs = new Map();
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      const knob = MIRROR_KNOB_RE.exec(line);
      if (!knob) return;
      const name = knob[0];
      if (!knobs.has(name)) knobs.set(name, { first: i + 1, count: 0 });
      knobs.get(name).count += 1;
    });
    for (const [name, info] of knobs) {
      out.push({
        criterion: 'mirror-injection-knob',
        severity: severityFor('mirror-injection-knob', stage),
        line: info.first,
        message:
          `构建参数 ${name} 是「把镜像塞进构建」的注入开关（本文件出现 ${info.count} 处）；` +
          `原生依赖要求删除该口子`,
      });
    }
    return out;
  }

  // ── 运行时源码：允许镜像，但必须在同文件里有显式开关 ───────────────────────
  if (isRuntimeSource(rel)) {
    if (EXPLICIT_GATE_NAMES.some((n) => content.includes(n))) return out;

    // 按**文件**聚合：运行时文件里出现几张镜像表不重要，重要的是「这个文件默认会用镜像」
    // 这一个事实。逐行报会让 setup.js 一次产出 9 条同义 finding。
    const hosts = new Map();
    let first = 0;
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      const host = mirrorHostInLine(line);
      if (!host) return;
      if (!first) first = i + 1;
      hosts.set(host, (hosts.get(host) || 0) + 1);
    });
    if (first) {
      const detail = [...hosts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([h, n]) => (n > 1 ? `${h}×${n}` : h))
        .join(', ');
      out.push({
        criterion: 'ungated-runtime-mirror',
        severity: severityFor('ungated-runtime-mirror', stage),
        line: first,
        message:
          `运行时源码出现 ${hosts.size} 个公共镜像（${detail}）但本文件无显式开关` +
          `（须出现 ${EXPLICIT_GATE_NAMES.join(' 或 ')}）；默认必须走官方源，镜像只能是用户显式 opt-in`,
      });
    }
  }

  return out;
}

/** 对一批条目求值。纯函数。 */
function evaluate(entries, opts = {}) {
  const stage = opts.stage || STAGE;
  const findings = [];
  for (const entry of entries || []) {
    const rel = normalize(entry.path);
    const hits = evaluateFile(entry, { stage });
    for (const h of hits) findings.push({ ...h, file: rel });
  }
  return findings;
}

function summarize(findings) {
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  return { errors, warnings, total: findings.length };
}

// ── 采集（唯一的 I/O 面）─────────────────────────────────────────────────────

const ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return path.resolve(__dirname, '..', '..');
  }
})();

function gitLines(args) {
  try {
    const out = execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1e8,
    });
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 解析 `--files=`。
 * ⚠ 必须区分「传了但为空」与「没传」：`argValue()` 对两者都返 ''，
 * 而空值会静默 fall through 到真实暂存集（本仓暂存集有数千项）⇒ 视角错位。
 */
function filesArgOrNull(argv) {
  const hit = argv.find((a) => a.startsWith('--files='));
  if (!hit) return null;
  return hit.slice('--files='.length);
}

function collect(argv) {
  const explicit = filesArgOrNull(argv);
  let candidates;

  if (explicit !== null) {
    candidates = explicit
      .split(',')
      .map((s) => normalize(s.trim()))
      .filter(Boolean);
  } else if (argv.includes('--changed')) {
    // 判改动集一律用暂存区（--cached）：工作区长期数千项未提交，全量视角只会产出
    // 「真实但不可行动」的结论 ⇒ finding 变常驻噪声 ⇒ 被整体忽略。
    candidates = gitLines(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  } else if (argv.includes('--worktree')) {
    candidates = gitLines(['ls-files', '-m', '-o', '--exclude-standard']).concat(
      gitLines(['ls-files', '-c'])
    );
  } else {
    candidates = gitLines(['ls-files']);
  }

  const wanted = [...new Set(candidates)].filter(
    (rel) => isBuildConfig(rel) || isRuntimeSource(rel)
  );

  const entries = [];
  for (const rel of wanted) {
    try {
      entries.push({ path: rel, content: fs.readFileSync(path.join(ROOT, rel), 'utf8') });
    } catch {
      /* 文件已删除或不可读：跳过，不阻断 */
    }
  }
  return { entries, scanned: wanted.length, mode: explicit !== null ? 'files' : argv.includes('--changed') ? 'changed' : argv.includes('--worktree') ? 'worktree' : 'full' };
}

// ── 离线场景（供人工复核与测试复现，不读盘）──────────────────────────────────

const SCENARIOS = {
  'official-only': [
    {
      path: 'Dockerfile',
      content: 'FROM python:3.12-slim\nRUN pip install --no-cache-dir khy-os\n',
    },
    {
      path: 'package-lock.json',
      content: '{"packages":{"node_modules/x":{"resolved":"https://registry.npmjs.org/x/-/x-1.0.0.tgz"}}}\n',
    },
  ],
  'aliyun-pip': [
    {
      path: 'runtime/node/backend/Dockerfile',
      content: 'RUN pip install -r req.txt -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com\n',
    },
  ],
  'apt-mirror-knob': [
    { path: 'runtime/node/ai-backend/Dockerfile', content: 'ARG APT_MIRROR=""\nRUN apt-get update\n' },
  ],
  'lockfile-npmmirror': [
    {
      path: 'runtime/node/backend/package-lock.json',
      content:
        '{\n "packages": {\n  "node_modules/a": {\n   "resolved": "https://registry.npmmirror.com/a/-/a-1.0.0.tgz"\n  },\n  "node_modules/b": {\n   "resolved": "https://registry.npmmirror.com/b/-/b-2.0.0.tgz"\n  }\n }\n}\n',
    },
  ],
  'runtime-ungated': [
    { path: 'runtime/substrate/platform/khy_platform/_bootstrap.py', content: 'npmrc.write_text("registry=https://registry.npmmirror.com\\n")\n' },
  ],
  'runtime-gated': [
    {
      path: 'runtime/substrate/platform/khy_platform/_bootstrap.py',
      content: 'if os.environ.get("KHY_USE_CN_MIRROR") == "1":\n    npmrc.write_text("registry=https://registry.npmmirror.com\\n")\n',
    },
  ],
};

// ── 渲染与入口 ───────────────────────────────────────────────────────────────

function render(findings, meta) {
  const L = [];
  L.push('═══ PROCESS-013 构建与交付依赖须原生官方源 ═══');
  L.push(`阶段 ${STAGE}（观察期，只记录不阻断）｜模式 ${meta.mode}｜扫描 ${meta.scanned} 个文件`);
  L.push('');

  if (!findings.length) {
    L.push('✓ 构建/交付配置与锁文件均只使用官方源；运行时镜像均已被显式开关门控。');
    return L.join('\n');
  }

  // 逐项方言：`[WARN ] <finding-id> <file>:<line>` + 两空格缩进的消息体
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
    console.log(`  - ${e.path}`);
    console.log(`      理由：${e.reason}`);
    console.log(`      复核到期：${e.reviewBy}`);
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
    // ⚠ `$g` 约定：--json 后仍追加 Summary 行 ⇒ 消费者先 split(/\n(?=Summary:)/)[0] 再 parse
    console.log(JSON.stringify({ stage: STAGE, meta, findings, summary: s }, null, 2));
    console.log(`\nSummary: ${s.errors} error(s), ${s.warnings} warning(s).`);
    return s.errors > 0 ? 1 : 0;
  }

  console.log(render(findings, meta));
  console.log('');
  if (EXEMPT.length) {
    console.log(`（豁免登记 ${EXEMPT.length} 条，见 --list）`);
  }
  console.log(`Summary: ${s.errors} error(s), ${s.warnings} warning(s).`);

  // gate=commit + severity=advisory ⇒ S1 恒 exit 0；升到 S3 后由 severityFor 派生 error 才阻断
  return s.errors > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  STAGE,
  EXEMPT,
  SCENARIOS,
  EXPLICIT_GATE_NAMES,
  OFFICIAL_LOCKFILE_HOSTS,
  isBuildConfig,
  isLockfile,
  isRuntimeSource,
  isCommentLine,
  isExempt,
  severityFor,
  labelOf,
  evaluateFile,
  evaluate,
  summarize,
  normalize,
};
