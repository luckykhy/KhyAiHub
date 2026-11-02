#!/usr/bin/env node
'use strict';

/**
 * check-docker-context.js —— Docker 构建上下文与镜像内容的契约守卫
 *
 * ## 为什么需要这条守卫
 *
 * 2026-11-02 那次镜像精简（commit b9ebd41a）改的全部是 `.dockerignore` 与
 * Dockerfile。这两类文件有一个共同点：**改错了不会有任何既有守卫报红**。
 *
 *   · `.dockerignore` 多排了一个路径 → 构建全绿，容器起来才 MODULE_NOT_FOUND；
 *   · Dockerfile 的 COPY 源指向不存在的路径 → 构建当场失败（这条至少会红）。
 *
 * 而 `.dockerignore` 的匹配语义极其反直觉：Docker 用 Go filepath.Match 规则，
 * `*` **不跨 `/`**，未加 `**` 前缀的模式只匹配上下文根。官方文档对递归的表述是
 * 「以 ** 前缀加 /*.go 会排除所有目录下的 .go，包括上下文根」——反过来说，只写
 * `*.go` 就只排根。那次整改的起点正是这个：旧版把 `node_modules` / `tests` /
 * `*.db` / `*.log` / `.khy` 全写在根级，实测 1678 个嵌套 node_modules 逃过排除。
 *
 * ⚠ 本文件的块注释里不能出现 `**` 紧接 `/*` 的字面量：那会被当成注释结束符。
 *   上面因此写成「** 前缀加 /*.go」这种绕口形式，改动时别「顺手修顺滑」。
 *
 * 本守卫把两类判据固化成机器可查的：
 *   A) 每个 COPY 源都必须在磁盘上存在，且不被 `.dockerignore` 排除；
 *   B) 一组功能地雷路径的排除状态必须符合既定策略（见下方 MUST_* 两张表）。
 *
 * B 之所以重要：它防的是「顺手泛化」。把 src 下的 html 收窄模式泛化成递归 html
 * 模式看着更整洁，但 delivery/web/ai-frontend/index.html 是 Vite 的构建入口；
 * 把只排根的 `*.md` 改成递归 md 模式更对称，但 src/ 下有 109 个 SKILL.md /
 * prompt.md 是技能加载器运行时逐个读的。这两类误伤都不会让构建失败，
 * 只会在运行时静默少一块功能。
 *
 * ## 用法
 *   node scripts/ci/check-docker-context.js            # 检查，error 退出 1
 *   node scripts/ci/check-docker-context.js --report    # 只报告，不判违规
 *   node scripts/ci/check-docker-context.js --json      # 机器可读
 *
 * 判据真源：本文件的 MUST_EXCLUDE / MUST_NOT_EXCLUDE 两张表 + 各 Dockerfile 的
 * COPY 指令。**不执行 docker**（构建机上才有），所以 `.dockerignore` 的匹配是按
 * 文档规则复现的保守实现：宁可多报，不可漏报。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.env.KHY_REPO_LAYOUT_ROOT
  ? path.resolve(process.env.KHY_REPO_LAYOUT_ROOT)
  : path.resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
const reportOnly = args.includes('--report');
const jsonMode = args.includes('--json');

// ── B 组判据：排除策略 ────────────────────────────────────────────────────────
// mustExclude  = 绝不进镜像（进了就是体积/泄漏问题）
// mustNotExclude = 必须能进镜像（排了就是功能静默缺失，且构建不会报错）
//
// 每一条都注明「排错了会怎样」。没有出处的一条都不该留在这里。
const MUST_EXCLUDE = [
  // 这一条是 `**/node_modules` 的**专属**防线，不能被别的模式顺带满足：
  // 宿主机 runtime/node/backend/node_modules 是 pnpm 的符号链接农场（84 KB），
  // 漏进镜像会覆盖容器内刚 --prod 装好的依赖。CI 用干净 checkout 没有这个目录
  // 所以全绿，本机构建则镜像内容取决于开发机装了什么 —— 正是最难发现的那类。
  // （`apps/...` 那条满足不了它：那是由整树排除 apps 覆盖的，与 **/node_modules 无关。）
  ['runtime/node/backend/node_modules/express',
    '宿主机 pnpm 符号链接农场；漏进镜像会覆盖容器内 prod 依赖（④ 号缺陷）'],
  ['runtime/node/backend/vendor/shared/node_modules/winston',
    '同上，link: 目标自带的 node_modules'],
  ['runtime/node/ai-backend/node_modules/express',
    '同上，ai-backend 侧'],
  ['apps/khyos-desktop/node_modules/electron/dist/electron',
    'electron 381 MB 家族；整树 apps 无任何 Dockerfile COPY'],
  ['runtime/node/backend/tests/helpers/jestCompat.js',
    '25 MB 测试树；生产代码零引用（全仓 grep 确认）'],
  ['runtime/node/backend/src/services/foo.test.js',
    'src 内 437 个 node:test 套件，装到容器里不会跑'],
  ['runtime/node/backend/.khy/khyquant/data/khy-quant.db',
    '本机 sqlite 库；.gitignore 已 ignore'],
  ['runtime/node/backend/proxy-debug.log',
    '本机调试日志'],
  ['runtime/substrate/platform/packages/shared/logs/active/app.log',
    'shared 被整树 COPY 进两个镜像，其 winston 日志必须排掉'],
  ['delivery/web/ai-frontend/build-bg.log',
    '前端被整树 COPY，其构建日志必须排掉'],
  ['runtime/substrate/platform/khy_platform/bundled/runtime/khy/bundle.mjs',
    '17.9 MB 兜底 bundle；会进镜像但不必进构建上下文（无 Dockerfile COPY 它）'],
];

const MUST_NOT_EXCLUDE = [
  ['runtime/node/backend/src/data/cliAnythingRegistry/skills/cli-anything-blender/SKILL.md',
    '技能加载器运行时逐个读 src 下的 109 个 SKILL.md/prompt.md；全排 = 容器内技能全灭'],
  ['runtime/node/backend/src/skills/foo/prompt.md',
    '同上'],
  ['delivery/web/ai-frontend/index.html',
    'Vite 构建入口；排了它 pnpm --filter khy-ai-frontend run build 直接失败'],
  ['delivery/web/ai-frontend/nginx.conf',
    'Dockerfile 直接 COPY 它当反代配置'],
  ['runtime/node/backend/data/.admin_initial_password',
    'git 跟踪的初始管理员口令真源；删了会改掉首次启动行为'],
  ['runtime/node/backend/server.js', 'HTTP 服务入口'],
  ['runtime/node/backend/docker-entrypoint.js', '容器 CMD'],
  ['runtime/node/backend/bin/khy.js', 'CLI 入口'],
  ['runtime/node/backend/vendor/shared/src/index.js',
    '@khy/shared 的 link: 目标，缺了 install 期就是悬空软链'],
  ['runtime/node/backend/migrations/001.js', '数据库迁移'],
  ['runtime/node/backend/config/default.json', '运行时配置'],
  ['runtime/node/backend/akshare_scripts/requirements.txt', 'akshare 依赖清单'],
  ['works/patches/node-pty@1.0.0.patch',
    'patchedDependencies 求 hash 的输入；缺了 pnpm 以 Linux errno=-2 退 254'],
  ['scripts/install/link-shared-dev.js', '根 preinstall 钩子；缺了 install 期 MODULE_NOT_FOUND'],
  ['pnpm-lock.yaml', '锁文件口径输入'],
  ['pnpm-workspace.yaml', 'workspace 成员清单真源'],
  ['.npmrc', 'autoInstallPeers=false 的真源'],
  ['.env.example', 'git 跟踪的配置样本（不被 **/.env 命中）'],
];

// ── Dockerfile 解析 ──────────────────────────────────────────────────────────

/** 有界遍历找 Dockerfile*，不进 node_modules/.git/third_party（仅用于清点，不作判据）。 */
function findDockerfiles(dir, depth, out) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    // third_party/ 是第三方 vendored 代码（如 llama.cpp 的 .devops/*.Dockerfile），
    // 它们用**自己的**构建上下文，源路径本就不该相对仓库根解析。
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'third_party') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      findDockerfiles(full, depth + 1, out);
    } else if (/^Dockerfile(\..+)?$/.test(e.name) || e.name.endsWith('.Dockerfile')) {
      out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
    }
  }
  return out;
}

/**
 * 推导「构建上下文 = 仓库根」的 Dockerfile 集合 —— 也只有这一集合受仓库根的
 * `.dockerignore` 管辖。
 *
 * 为什么不遍历全部 Dockerfile：不同 Dockerfile 的上下文不同。
 *   · runtime/boot/kernel/Dockerfile.kernel-build 的上下文是 runtime/boot/kernel；
 *   · delivery/extension/scripts/khy-alpine-iso/Dockerfile.iso-builder 同理；
 *   · third_party/ 下 llama.cpp 的那批用自己的上下文。
 * 拿仓库根去解析它们的 COPY 源，会得到一片假红（本次实测 40 项 error，其中 22 项
 * 来自 third_party，正是这个原因）。
 *
 * 真源 = docker-compose.yml 的 `dockerfile:` 项 + .github/workflows/docker.yml 的
 * `file: ./...` 项。这样新 Dockerfile 一旦接进 compose/CI 就自动进入判据，
 * 不需要回来改本文件。解析用正则而非 YAML 库：scripts/ 下守卫约定零依赖
 * （见 check-dependency-size.js 头部）。
 */
function resolveRootContextDockerfiles() {
  const found = new Set();
  const scan = (rel, patterns) => {
    let text;
    try {
      text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    } catch {
      return;
    }
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const p = m[1].trim().replace(/^\.\//, '').replace(/^\/+/, '');
        if (p && !p.startsWith('..')) found.add(p);
      }
    }
  };
  scan('docker-compose.yml', [/dockerfile:\s*(\S+)/g]);
  scan('.github/workflows/docker.yml', [/file:\s*(\.\/\S+)/g]);
  // 仓库根 Dockerfile 是主镜像，compose 与 CI 都以 `dockerfile: Dockerfile` 引用，
  // 但若两者都漏写，它仍必须是判据对象。
  if (fs.existsSync(path.join(REPO_ROOT, 'Dockerfile'))) found.add('Dockerfile');
  return [...found].sort();
}

/** 把反斜杠接续的 Dockerfile 折成逻辑行。 */
function toLogicalLines(text) {
  const out = [];
  let buf = '';
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    buf = buf ? buf + ' ' + t : t;
    if (buf.endsWith('\\')) { buf = buf.slice(0, -1); continue; }
    out.push(buf);
    buf = '';
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * 取一条 COPY 的上下文侧源路径列表。
 * 跳过 `--from=<stage>`：那种源在另一个 stage 的文件系统里，宿主机上本就不存在，
 * 也不受 .dockerignore 管辖（.dockerignore 只作用于上下文）。
 */
function copySources(logicalLines) {
  const out = [];
  for (const line of logicalLines) {
    if (!/^COPY\s/i.test(line)) continue;
    let rest = line.replace(/^COPY\s+/i, '');
    let crossStage = false;
    for (;;) {
      const m = rest.match(/^--[\w-]+(=\S+)?\s+/);
      if (!m) break;
      if (/^--from=/i.test(m[0])) crossStage = true;
      rest = rest.slice(m[0].length);
    }
    const parts = rest.split(/\s+/).filter(Boolean);
    if (parts.length < 2 || crossStage) continue;
    out.push(parts.slice(0, -1)); // 最后一个是目标
  }
  return out;
}

// ── .dockerignore 匹配（保守复现）────────────────────────────────────────────

function loadPatterns() {
  let text;
  try {
    text = fs.readFileSync(path.join(REPO_ROOT, '.dockerignore'), 'utf8');
  } catch {
    return null; // 没有 .dockerignore ⇒ 整个上下文都进镜像，本身就该报
  }
  const pats = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let neg = false;
    if (line.startsWith('!')) { neg = true; line = line.slice(1).trim(); }
    line = line.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (line) pats.push({ neg, line });
  }
  return pats;
}

function toRegex(p) {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') { out += '.*'; i++; if (p[i + 1] === '/') i++; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp('^' + out + '$');
}

/** 目录排除会连带排除其子路径（Docker 的 MatchesOrParentMatches 语义）。 */
function matchesPattern(p, rel) {
  const segs = rel.split('/');
  for (let i = 1; i <= segs.length; i++) {
    if (toRegex(p).test(segs.slice(0, i).join('/'))) return true;
  }
  return false;
}

function isExcluded(patterns, rel) {
  let excluded = false;
  for (const p of patterns) {
    if (matchesPattern(p.line, rel)) excluded = !p.neg;
  }
  return excluded;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const patterns = loadPatterns();
const findings = [];
const allDockerfiles = findDockerfiles(REPO_ROOT, 0, []);
const dockerfiles = resolveRootContextDockerfiles().filter(df => allDockerfiles.includes(df));

if (!patterns) {
  findings.push({
    id: 'dockerignore-missing',
    severity: 'error',
    detail: '仓库根没有 .dockerignore —— 整个上下文（含 node_modules）都会进构建上下文',
  });
}

if (dockerfiles.length === 0) {
  findings.push({
    id: 'no-root-context-dockerfile',
    severity: 'error',
    detail: '推导不出「上下文 = 仓库根」的 Dockerfile（compose / docker.yml 都没引用）—— 判据失效',
  });
}

const unchecked = allDockerfiles.filter(df => !dockerfiles.includes(df));

// A 组：COPY 源存在性 + 不被 .dockerignore 排除
let copySourceCount = 0;
for (const df of dockerfiles) {
  let text;
  try {
    text = fs.readFileSync(path.join(REPO_ROOT, df), 'utf8');
  } catch {
    continue;
  }
  for (const srcs of copySources(toLogicalLines(text))) {
    for (const src of srcs) {
      const rel = src.replace(/^\.\//, '').replace(/\/+$/, '');
      copySourceCount++;
      if (!fs.existsSync(path.join(REPO_ROOT, rel))) {
        findings.push({
          id: 'copy-source-missing',
          severity: 'error',
          file: df,
          detail: `COPY 源在磁盘上不存在：${rel} —— docker build 会当场 file not found`,
        });
      } else if (patterns && isExcluded(patterns, rel)) {
        findings.push({
          id: 'copy-source-excluded',
          severity: 'error',
          file: df,
          detail: `COPY 源被 .dockerignore 排除：${rel} —— 构建失败，或更坏：构建绿但容器起来才 MODULE_NOT_FOUND`,
        });
      }
    }
  }
}

// B 组：排除策略
if (patterns) {
  for (const [rel, why] of MUST_EXCLUDE) {
    if (!isExcluded(patterns, rel)) {
      findings.push({
        id: 'should-be-excluded',
        severity: 'warning',
        detail: `应排除而未排除：${rel} —— ${why}`,
      });
    }
  }
  for (const [rel, why] of MUST_NOT_EXCLUDE) {
    if (isExcluded(patterns, rel)) {
      findings.push({
        id: 'must-not-be-excluded',
        severity: 'error',
        detail: `被误排除：${rel} —— ${why}`,
      });
    }
  }
}

const pad = (s, n) => String(s).padEnd(n);

const errors = findings.filter(f => f.severity === 'error');
const warnings = findings.filter(f => f.severity === 'warning');

if (jsonMode) {
  console.log(JSON.stringify({
    checkedDockerfiles: dockerfiles,
    uncheckedDockerfiles: unchecked,
    copySourceCount,
    errors: errors.length,
    warnings: warnings.length,
    findings,
  }, null, 2));
} else {
  console.log(`[docker-context] 判据对象 ${dockerfiles.length} 份（上下文 = 仓库根）：`
    + dockerfiles.join(', '));
  if (unchecked.length) {
    console.log(`[docker-context] 另有 ${unchecked.length} 份 Dockerfile 不用仓库根作上下文，不判：`
      + unchecked.join(', '));
  }
  console.log(`[docker-context] COPY 源 ${copySourceCount} 条，策略判据 `
    + `${MUST_EXCLUDE.length + MUST_NOT_EXCLUDE.length} 条`);
  for (const f of findings) {
    const head = f.severity === 'error' ? '[error]' : '[warn ]';
    const where = f.file ? pad(f.file, 30) + ' ' : '';
    console.log(head + ' ' + where + f.detail);
  }
  if (!findings.length) console.log('[docker-context] 全部通过。');
}

if (errors.length > 0) {
  console.log(`\n[docker-context] ${errors.length} 项 error。`
    + 'COPY 源缺失就修 Dockerfile；被 .dockerignore 误伤就收窄那条模式'
    + '（注意 Docker 的 * 不跨 /，递归必须写 **/）。');
  if (!reportOnly) process.exit(1);
} else if (warnings.length > 0 && !reportOnly) {
  console.log(`\n[docker-context] ${warnings.length} 项 warning（不阻断）。`);
}
process.exit(0);
