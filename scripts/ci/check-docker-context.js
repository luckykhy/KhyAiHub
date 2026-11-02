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
 * 推导「构建上下文 = 仓库根」的 Dockerfile 集合。
 *
 * 真源 = docker-compose.yml 的 `dockerfile:` 项 + .github/workflows/docker.yml 的
 * `file: ./...` 项。这两处引用的 Dockerfile 用仓库根作上下文，受仓库根的
 * `.dockerignore` 管辖；B 组策略判据（MUST_EXCLUDE / MUST_NOT_EXCLUDE）也只对
 * 它们成立——那些表是按主镜像的目录形状写的。
 *
 * 为什么不能「遍历全部 Dockerfile 都按仓库根判」：不同 Dockerfile 的上下文不同。
 * 实测（2026-11-02 第一版）那样会得到 40 项 error，其中 22 项来自 third_party
 * 下 llama.cpp 的 .devops 批次——它们用自己的上下文，源路径本就不该相对仓库根解析。
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
  return found;
}

/** 单段 glob → 正则（用于展开 `COPY package*.json` 这类源）。 */
function globToRegex(pat) {
  let out = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp('^' + out + '$');
}

/**
 * 判定一个 COPY 源在上下文内是否可解析。
 * Docker 的 COPY 支持 glob（`COPY package*.json ./`），字面量判存在会假红
 * （第一版扩展上下文时就踩到：把 `package*.json` 当成不存在的文件报了 error）。
 * 目录段带 glob 的情况本守卫不展开，返回 'skip' —— 宁可少判，不可假红。
 */
function resolveCopySource(ctxDir, srcRel) {
  if (!/[*?[]/.test(srcRel)) {
    return fs.existsSync(path.join(ctxDir, srcRel)) ? 'ok' : 'missing';
  }
  const parts = srcRel.split('/');
  let dir = ctxDir;
  for (const d of parts.slice(0, -1)) {
    if (/[*?[]/.test(d)) return 'skip';
    dir = path.join(dir, d);
  }
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 'missing';
  }
  const re = globToRegex(parts[parts.length - 1]);
  return entries.some(e => re.test(e)) ? 'ok' : 'missing';
}

/**
 * 目录型 COPY 的泄漏检查。
 *
 * 为什么必须有这一条：`copy-source-excluded` 只覆盖**具名** COPY 源
 * （`COPY package.json ./`）。而 `COPY . .` / `COPY src/ ./src/` 的源是目录，
 * 永远"存在"也永远不会被"排除"——于是「上下文里有 node_modules，而 .dockerignore
 * 忘了排它」这种最要命的形态，前两版守卫**一条都抓不到**。
 *
 * 实测教训（2026-11-02）：delivery/channel/khyquant/frontend 正是这个形态。
 * 它的 Dockerfile 是 `npm install` 先、`COPY . .` 后，宿主机 node_modules 里
 * 20 个指向 /d/Portable/... 的绝对软链被合并进 builder 阶段，覆盖前一步装好的
 * 同名真实目录 ⇒ npm run build 直接 MODULE_NOT_FOUND。第一版守卫反向测试
 * 「删掉该目录 .dockerignore 里的 node_modules」时全绿，才暴露出这个盲区。
 *
 * 判据：目录型 COPY 的源目录下，若磁盘上存在 MUST_NOT_ENTER_DIR_COPY 里的条目，
 * 而该上下文又没有把它排除掉 ⇒ error。
 */
const MUST_NOT_ENTER_DIR_COPY = [
  ['node_modules', '安装产物；pnpm/npm 布局下是指向宿主 .pnpm 的软链农场，'
    + '进镜像会覆盖前一步刚装好的同名真实目录'],
  ['dist', '构建输出，由构建步骤重新生成'],
];

function checkDirCopy(ctx, srcRel, df) {
  const abs = path.join(ctx.ctxDir, srcRel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return; // 不是目录（或读不到）—— 由具名 COPY 检查负责
  }
  for (const [name, why] of MUST_NOT_ENTER_DIR_COPY) {
    const present = entries.some(e => e.name === name);
    if (!present) continue;
    // 子条目相对**上下文根**的完整路径。这里不能用裸 name：
    // .dockerignore 的模式是相对上下文根的，而 COPY 的源目录可能只是上下文的
    // 一个子树（如 `COPY delivery/web/ai-frontend/ ...`，其 dist 的完整路径是
    // `delivery/web/ai-frontend/dist`）。第一版用裸 name，导致明明排除了还报错。
    const childRel = srcRel === '.' || srcRel === '' ? name : srcRel + '/' + name;
    if (ctx.patterns && isExcluded(ctx.patterns, childRel)) continue;
    findings.push({
      id: 'dir-copy-leaks-build-artifact',
      severity: 'error',
      file: df,
      detail: `目录型 COPY（${srcRel}）会把 ${name} 一起带进镜像，而上下文 `
        + `${ctx.useRepoRoot ? '.' : './' + path.relative(REPO_ROOT, ctx.ctxDir)
          .split(path.sep).join('/')}`
        + ' 的 .dockerignore 没有排除它 —— ' + why,
    });
  }
}

/**
 * Dockerfile 是否声明自己「不参与本守卫判据」。
 *
 * 用法：在文件头部注释里写一行 `# docker-context: skip <理由>`。
 *
 * 为什么需要：runtime/node/backend/Dockerfile 是 2026-11-02 标记为死文件的
 * 旧版 Dockerfile（所有 COPY 路径都是 forest layout 迁移前的形状，构建必然失败）。
 * 它的存在本身是历史证据（PROCESS-013 规则卡引用它），但让守卫对它恒红只会
 * 教人忽视守卫。显式跳过 + 理由，比悄悄漏掉它诚实。
 */
function isSkipped(text) {
  return /^#\s*docker-context:\s*skip\b/m.test(text);
}

/**
 * 判定一份 Dockerfile 的构建上下文根，以及该上下文的 .dockerignore。
 *
 * 规则（2026-11-02 扩充）：compose/CI 引用的用仓库根；**其余用它自己所在目录**。
 *
 * 为什么必须补第二条：`delivery/channel/khyquant/frontend/Dockerfile` 的上下文
 * 就是那个目录自己（Dockerfile 里是 `COPY . .`），仓库根那份 .dockerignore 管不到。
 * 而它缺一份自己的 .dockerignore 时，实测宿主机 node_modules 里 20 个指向
 * `/d/Portable/...` 的绝对软链会被 `COPY . .` 合并进 builder 阶段，**覆盖**
 * 前一步 `npm install` 刚装好的同名真实目录 ⇒ `npm run build` 直接
 * MODULE_NOT_FOUND。CI 用干净 checkout、没有 node_modules，所以全绿。
 * 这与主镜像的 ④ 号缺陷是同一条机制，只是被 nginx:alpine 最终阶段洗掉了。
 *
 * 反向也要防：不能因为「不在 compose 里」就跳过。跳过等于把这类文件设为盲区。
 */
function resolveContext(dfRel) {
  const rootCtx = resolveRootContextDockerfiles();
  const useRepoRoot = rootCtx.has(dfRel);
  const ctxDir = useRepoRoot ? REPO_ROOT : path.join(REPO_ROOT, path.dirname(dfRel));
  const ignorePath = path.join(ctxDir, '.dockerignore');
  let patterns = null;
  try {
    patterns = parseDockerignore(fs.readFileSync(ignorePath, 'utf8'));
  } catch {
    patterns = null;
  }
  return { ctxDir, useRepoRoot, patterns, ignorePath };
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

/** 解析 .dockerignore 文本为模式表。文本不存在/读不到由调用方决定返回什么。 */
function parseDockerignore(text) {
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

const findings = [];
const allDockerfiles = findDockerfiles(REPO_ROOT, 0, []);

// 仓库根上下文必须有一份 .dockerignore（B 组判据的前提）
let rootPatterns = null;
try {
  rootPatterns = parseDockerignore(
    fs.readFileSync(path.join(REPO_ROOT, '.dockerignore'), 'utf8'));
} catch {
  rootPatterns = null;
}
if (!rootPatterns) {
  findings.push({
    id: 'dockerignore-missing',
    severity: 'error',
    detail: '仓库根没有 .dockerignore —— 整个上下文（含 node_modules）都会进构建上下文',
  });
}

if (allDockerfiles.length === 0) {
  findings.push({
    id: 'no-dockerfile',
    severity: 'error',
    detail: '一个 Dockerfile 都没找到（遍历深度 6）—— 遍历逻辑或仓库结构有问题，判据失效',
  });
}

// ── A 组：逐份 Dockerfile，按它自己的上下文判 COPY 源 ────────────────────────
let copySourceCount = 0;
const contextSummary = [];

for (const df of allDockerfiles) {
  const ctx = resolveContext(df);
  let text;
  try {
    text = fs.readFileSync(path.join(REPO_ROOT, df), 'utf8');
  } catch {
    continue;
  }
  if (isSkipped(text)) {
    contextSummary.push({ df, ctxLabel: '(skip)', hasIgnore: !!ctx.patterns, skipped: true });
    continue;
  }
  // 上下文目录相对仓库根的路径（用于报错信息）。注意方向：from=REPO_ROOT, to=ctxDir。
  const ctxLabel = ctx.useRepoRoot
    ? '.'
    : './' + path.relative(REPO_ROOT, ctx.ctxDir).split(path.sep).join('/');
  contextSummary.push({ df, ctxLabel, hasIgnore: !!ctx.patterns });

  // 缺 .dockerignore 与 COPY 源是否存在是两件独立的事：前者不阻断后者的检查。
  // （第一版在这里 `continue`，导致所有非仓库根上下文的 Dockerfile 的 COPY 检查
  //   全被跳过 —— 那正好把最需要查的那类文件变成了盲区。）
  if (!ctx.patterns) {
    findings.push({
      id: 'context-dockerignore-missing',
      severity: 'warning',
      file: df,
      detail: `上下文 ${ctxLabel} 没有 .dockerignore —— 该上下文内的一切（含 node_modules、dist）`
        + ' 都会被 COPY 进去；若 Dockerfile 里有 `COPY . .`，宿主机 node_modules 会覆盖'
        + ' 前一步刚装好的依赖（khyquant 前端 2026-11-02 实测到这条）',
    });
  }

  for (const srcs of copySources(toLogicalLines(text))) {
    for (const src of srcs) {
      const srcRel = src.replace(/^\.\//, '').replace(/\/+$/, '');
      copySourceCount++;
      // COPY 源相对**上下文根**解析
      const verdict = resolveCopySource(ctx.ctxDir, srcRel);
      if (verdict === 'skip') continue;
      if (verdict === 'missing') {
        findings.push({
          id: 'copy-source-missing',
          severity: 'error',
          file: df,
          detail: `COPY 源在上下文 ${ctxLabel} 下不存在：${srcRel} —— docker build 会当场 file not found`,
        });
        continue;
      }
      if (ctx.patterns && isExcluded(ctx.patterns, srcRel)) {
        findings.push({
          id: 'copy-source-excluded',
          severity: 'error',
          file: df,
          detail: `COPY 源被 ${ctxLabel}/.dockerignore 排除：${srcRel} —— 构建失败，`
            + '或更坏：构建绿但容器起来才 MODULE_NOT_FOUND',
        });
        continue;
      }
      // 目录型 COPY：查它会不会把 node_modules / dist 一起带进去。
      // `COPY . .` 的 srcRel 是 `.`，resolveCopySource 判它存在，落到这里。
      checkDirCopy(ctx, srcRel === '' ? '.' : srcRel, df);
    }
  }
}

// ── B 组：排除策略（只对仓库根上下文成立，那些表是按主镜像形状写的）──────────
if (rootPatterns) {
  for (const [rel, why] of MUST_EXCLUDE) {
    if (!isExcluded(rootPatterns, rel)) {
      findings.push({
        id: 'should-be-excluded',
        severity: 'warning',
        detail: `应排除而未排除：${rel} —— ${why}`,
      });
    }
  }
  for (const [rel, why] of MUST_NOT_EXCLUDE) {
    if (isExcluded(rootPatterns, rel)) {
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
    dockerfiles: allDockerfiles,
    contexts: contextSummary,
    copySourceCount,
    errors: errors.length,
    warnings: warnings.length,
    findings,
  }, null, 2));
} else {
  console.log(`[docker-context] Dockerfile ${allDockerfiles.length} 份，COPY 源 ${copySourceCount} 条`
    + `，策略判据 ${MUST_EXCLUDE.length + MUST_NOT_EXCLUDE.length} 条`);
  for (const c of contextSummary) {
    if (c.skipped) {
      console.log(`[docker-context]   ${pad(c.df, 56)} 上下文 (skip，已声明不参与判据)`);
      continue;
    }
    console.log(`[docker-context]   ${pad(c.df, 56)} 上下文 ${c.ctxLabel}`
      + `${c.hasIgnore ? '' : '  ⚠ 无 .dockerignore'}`);
  }
  for (const f of findings) {
    const head = f.severity === 'error' ? '[error]' : '[warn ]';
    const where = f.file ? pad(f.file, 56) + ' ' : '';
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
