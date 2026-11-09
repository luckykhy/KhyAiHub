/**
 * Multi-level khy.md instruction file discovery and loading.
 *
 * Mirrors CLAUDE.md pattern — discovers instruction files
 * at four levels (global, project, rules, cwd) and merges them into a
 * single block for injection into the AI system prompt.
 *
 * Levels (all loaded, bottom-up):
 *   ~/.khyquant/khy.md (or KHY.md) → global user instructions
 *   <git-root>/khy.md (or KHY.md)  → project-level instructions
 *   <git-root>/.khy/rules/*.md     → rule files
 *   <dir>/khy.md (or KHY.md)       → every directory from cwd up to (excluding)
 *                                    git-root, nearest first
 *
 * The directory tier walks cwd → git-root instead of probing cwd alone: CC reads
 * its memory files at every level of that chain, and a two-point probe left a
 * session started in a subdirectory with neither intermediate nor root
 * instructions.
 *
 * Limits:
 *   - Single file: max 8000 chars (truncated with warning)
 *   - Total merged: max 24000 chars
 */
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 生态层规则的声明式真源(纯叶子:表 + 门控 + 作用域过滤,零 IO)。
// 用在下方 discoverEcosystemInstructionFiles();接入理由见那里的注释与该模块文档。
const _ecoReg = require('./instructionEcosystemRegistry');
// External-include detection (aligns CC ClaudeMdExternalIncludesDialog 背后逻辑):
// flags `@path` imports resolving OUTSIDE the repo/cwd trust boundary so
// loadInstructions can surface a security warning — display/awareness only, the
// allow/deny gate in resolveIncludes is untouched. Pure leaf (no fs).
const {
  detectExternalIncludes,
  buildExternalIncludeWarning,
  INCLUDE_LINE_SOURCE,
} = require('./instructionExternalIncludes');

const MAX_FILE_CHARS = 8000;
const MAX_TOTAL_CHARS = 24000;
const FILENAMES = ['khy.md', 'KHY.md'];
const RULES_DIR = '.khy/rules';
const MAX_INCLUDE_DEPTH = 3;
const MAX_INCLUDE_FILES = 10;
// AGENTS.md (plural) is the established cross-tool convention and stays first so
// its discovery priority is unchanged. agent.md / AGENT.md (singular) are added so
// that content written to a singular agent.md (via SaveInstruction target='agent')
// is also discovered and injected. Plural-before-singular keeps legacy behaviour
// byte-identical when both exist.
const COMPAT_FILENAMES = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md', 'agent.md', 'AGENT.md'];

// ── Helpers ─────────────────────────────────────────────────────────────

// git rev-parse costs ~100ms on Windows and one prompt build asks for the same
// root several times (own tier, compat chain, section cache key), so the verdict
// is memoized per cwd for a short TTL — same shape as prompts.js's _isGitCache.
// A root that changes mid-session (repo moved, fresh git init) self-heals on the
// next expiry.
const _gitRootCache = new Map();
const _GIT_ROOT_TTL_MS = 30000;

function findGitRoot(from) {
  const key = String(from || '');
  const hit = _gitRootCache.get(key);
  if (hit && Date.now() - hit.at < _GIT_ROOT_TTL_MS) {
    return hit.root;
  }
  let root = null;
  try {
    root =
      execSync('git rev-parse --show-toplevel', {
        cwd: from,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim() || null;
  } catch {
    root = null;
  }
  _gitRootCache.set(key, { root, at: Date.now() });
  return root;
}

// Truncation must leave a trace inside the injected text. A bare slice hands the
// model the head of a rule file while it believes it read all of it, and the only
// existing notice (`/memory`'s "(截断)") is terminal-only — it never reaches the
// prompt. The notice itself spends the budget so content.length stays <= maxChars;
// the ecosystem tier's ECO_MAX_FILE_CHARS assertion depends on that invariant.
function _truncationNotice(originalChars, maxChars) {
  return (
    `\n\n[TRUNCATED: 该文件原文 ${originalChars} 字符，超过单文件上限 ${maxChars}，` +
    `本段只保留开头部分；完整内容用 Read 工具直接读该文件]`
  );
}

function readFileSafe(filePath, maxChars = MAX_FILE_CHARS) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return null;
    }

    let content = fs.readFileSync(filePath, 'utf-8');
    let truncated = false;
    if (content.length > maxChars) {
      const notice = _truncationNotice(content.length, maxChars);
      content = content.slice(0, Math.max(0, maxChars - notice.length)) + notice;
      truncated = true;
    }
    return { content, truncated, size: stat.size };
  } catch {
    return null;
  }
}

/**
 * Process @include directives in instruction file content.
 * Supports: @path/to/file.md (relative to the instruction file's directory)
 *
 * Recursion is bounded by MAX_INCLUDE_DEPTH and MAX_INCLUDE_FILES.
 *
 * @param {string} content - Raw content with possible @include directives
 * @param {string} baseDir - Directory of the file containing the directives
 * @param {number} [depth=0] - Current recursion depth
 * @param {Set<string>} [visited] - Already-included paths (cycle prevention)
 * @returns {string} Content with includes resolved
 */
function resolveIncludes(content, baseDir, depth = 0, visited = new Set()) {
  if (depth >= MAX_INCLUDE_DEPTH || visited.size >= MAX_INCLUDE_FILES) {
    return content;
  }

  // Match @path/to/file patterns on their own line
  return content.replace(/^@(\S+)\s*$/gm, (match, relPath) => {
    if (visited.size >= MAX_INCLUDE_FILES) {
      return match;
    }

    const absPath = path.resolve(baseDir, relPath);
    const resolved = path.resolve(absPath);

    // Security: don't allow includes outside the project tree
    // 门控 KHY_INCLUDE_BOUNDARY_ANCHOR(默认开):裸 startsWith 会把名字前缀相同的兄弟目录
    // (proj-evil vs proj)、另一用户 home(/home/user2 vs /home/user)误判「允许范围内」而内联其
    // 文件进系统提示词(@include 注入 / 机密内联);锚定分隔符边界收紧。门关/异常 → 回退 legacy。
    let _includeAllowed = resolved.startsWith(baseDir) || resolved.startsWith(os.homedir());
    try {
      const _a = require('./instructionIncludeBoundary').isIncludeAllowed(
        resolved,
        baseDir,
        os.homedir(),
        path.sep,
        process.env
      );
      if (_a !== null) {
        _includeAllowed = _a;
      }
    } catch {
      /* fail-soft → legacy naive startsWith */
    }
    if (!_includeAllowed) {
      return `<!-- @include denied: ${relPath} (outside allowed scope) -->`;
    }

    if (visited.has(resolved)) {
      return `<!-- @include cycle: ${relPath} -->`;
    }

    const included = readFileSafe(resolved, MAX_FILE_CHARS);
    if (!included) {
      return `<!-- @include not found: ${relPath} -->`;
    }

    visited.add(resolved);
    // Recurse for nested includes
    return resolveIncludes(included.content, path.dirname(resolved), depth + 1, visited);
  });
}

/**
 * Discover rule files from .khy/rules/ directory (glob *.md).
 * Mirrors CLAUDE.md's .claude/rules/*.md convention.
 *
 * @param {string} projectRoot - Git root or cwd
 * @returns {Array<{ path: string, content: string, truncated: boolean, size: number }>}
 */
function discoverRuleFiles(projectRoot) {
  const rulesDir = path.join(projectRoot, RULES_DIR);
  const results = [];

  try {
    if (!fs.existsSync(rulesDir) || !fs.statSync(rulesDir).isDirectory()) {
      return results;
    }

    const files = fs
      .readdirSync(rulesDir)
      .filter((f) => f.endsWith('.md'))
      .sort(); // Deterministic order

    for (const file of files) {
      const filePath = path.join(rulesDir, file);
      const entry = readFileSafe(filePath);
      if (entry) {
        results.push({
          path: filePath,
          content: entry.content,
          truncated: entry.truncated,
          size: entry.size,
        });
      }
    }
  } catch {
    // rules directory unreadable
  }

  return results;
}

// ── Core API ────────────────────────────────────────────────────────────

/**
 * Discover all khy.md files for the given working directory.
 * @param {string} [cwd] - defaults to process.cwd()
 * @returns {Array<{ path: string, content: string, level: string, truncated: boolean, size: number }>}
 */
/**
 * 在目录下搜索 FILENAMES 中第一个存在的文件。
 * @param {string} dir
 * @returns {{ path: string, file: { content: string, truncated: boolean, size: number } } | null}
 */
function findFirstInstructionFile(dir) {
  for (const filename of FILENAMES) {
    const filePath = path.join(dir, filename);
    const file = readFileSafe(filePath);
    if (file) {
      return { path: filePath, file };
    }
  }
  return null;
}

// Portable-aware app home; fallback to the legacy ~/.khyquant location.
function _appHome() {
  try {
    const { getAppHome } = require('../utils/dataHome');
    return getAppHome();
  } catch {
    return path.join(os.homedir(), '.khyquant');
  }
}

// Directories from cwd up to git-root INCLUSIVE, nearest first. Shared by the
// own directory tier below and the CLAUDE.md/AGENTS.md compat discovery in
// constants/prompts.js, so both walk the same chain (CC reads its memory files
// at every level of it). git rev-parse prints forward slashes on Windows while
// path.resolve yields backslashes, so both ends go through one normalized form
// before comparison — otherwise the walk silently bails on a cosmetic separator
// difference and the root tier is lost again. Yields [cwd] when there is no git
// root or cwd sits outside it, which is the pre-traversal behaviour.
// @param {string} [gitRoot] pass the already-resolved root to skip the git probe.
function instructionDirsToGitRoot(cwd, gitRoot) {
  if (gitRoot === undefined) {
    gitRoot = findGitRoot(cwd);
  }
  if (!gitRoot) {
    return [cwd];
  }
  const norm = (p) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const root = norm(gitRoot);
  const chain = [];
  let current = cwd;
  for (let depth = 0; depth < 64; depth++) {
    const currentNorm = norm(current);
    if (currentNorm === root) {
      chain.push(gitRoot);
      return chain;
    }
    if (!currentNorm.startsWith(root + path.sep)) {
      // cwd sits outside the repo (other drive, symlink escape, …): keep the old
      // single-directory probe instead of jumping straight to the root.
      return [cwd];
    }
    chain.push(current);
    const resolved = path.resolve(current);
    const parent = path.dirname(resolved);
    if (parent === resolved) {
      break;
    }
    current = parent;
  }
  return [cwd];
}

// ── 生态指令层(蹭规则生态)────────────────────────────────────────────────
//
// 别的 agent 早就在这个仓库里写好了「该怎么干活」的规则文件(AGENTS.md / CLAUDE.md /
// .cursor/rules / .github/copilot-instructions.md / …),而此前 khy 只读自己的 khy.md ——
// 连 COMPAT_FILENAMES 里的 CLAUDE.md / AGENTS.md 也只在 getCompatInstructionSummary()
// 的展示列表里出现,**从未进过系统提示词**。这一层把这些既有资产接进来。
//
// 位置在 khy 自己的三层之后 = 最低优先级;三道闸(注入扫描复用同一条路径、独立字符预算、
// 作用域过滤)见 instructionEcosystemRegistry 的文档。门控关 → sources 为空 → 整段空转,
// discoverInstructionFiles 的返回值与接入前逐字节相同。(_ecoReg 在文件顶部 import 组里。)

// 生态层总预算(ECO_MAX_TOTAL_CHARS)砍下来的告知,与 _truncationNotice 同构,但说清
// 这是层总预算而不是单文件上限 —— 否则模型会把「只剩开头」当成规则本来就这么短。
// alsoFileCapped 时一并说明该文件先被 4000 砍过一次,两刀叠加不能只报一刀。
// notice 自身占用预算,content.length <= ECO_MAX_FILE_CHARS 的不变式因此保持。
function _ecoBudgetNotice(originalChars, alsoFileCapped) {
  return (
    `\n\n[TRUNCATED: 生态层总预算 ${_ecoReg.ECO_MAX_TOTAL_CHARS} 字符已用尽，` +
    `本文件只保留开头部分（原文 ${originalChars} 字符` +
    `${alsoFileCapped ? '，且已超单文件上限先被截过一次' : ''}）；` +
    `完整内容用 Read 工具直接读该文件]`
  );
}

// 生态层丢失汇总。发现层丢掉的文件(作用域/预算/目录上限)不进 results,注入文本里
// 就零标记 —— 模型分不清「这条规则本来不存在」和「存在但被这一层丢了」。有丢弃时
// 在生态结果头部插一条 notice 条目(见 discoverEcosystemInstructionFiles),由
// loadInstructions 作为独立段渲染。每类原因最多列 5 个路径,防病态仓库把汇总刷爆。
function _ecoDropNotice(dropped, injectedCount) {
  const reasons = {
    scoped: 'globs/applyTo/inclusion 作用域规则，非全局生效',
    budget: `生态层总预算 ${_ecoReg.ECO_MAX_TOTAL_CHARS} 字符已用尽`,
    'dir-cap': `每目录最多 ${_ecoReg.ECO_MAX_FILES_PER_DIR} 个文件`,
  };
  const lines = [
    `⚠ [ECO-SUMMARY] 生态指令层：共发现 ${dropped.length + injectedCount} 个第三方规则文件，` +
      `注入 ${injectedCount} 个，未注入 ${dropped.length} 个；未注入规则的完整内容请用 Read 工具直接读对应文件`,
  ];
  for (const [reason, why] of Object.entries(reasons)) {
    const paths = dropped.filter((d) => d.reason === reason).map((d) => d.path);
    if (paths.length === 0) {
      continue;
    }
    const shown = paths.slice(0, 5).join('、');
    const more = paths.length > 5 ? ` 等 ${paths.length} 个` : '';
    lines.push(`⚠ [SKIPPED: ${reason}] ${shown}${more}（${why}）`);
  }
  return {
    path: '',
    content: lines.join('\n'),
    level: 'ecosystem',
    ecosystem: '',
    label: '生态指令层汇总',
    kind: 'notice',
    size: 0,
    truncated: false,
  };
}

// 生态文件里的裸 `@path` 行:resolveIncludes 只对 khy 自己的指令文件展开(见
// discoverInstructionFiles 第 4 步的注释),第三方文件的 @ 引用原样进提示词。
// 模型看到一行 `@foo/bar.md` 会以为内容已内联,这里按注入文本里真实存在的行计数
// (截断后的),由 loadInstructions 在条目旁渲染一行说明。行形状与 resolveIncludes
// 完全一致,直接复用 instructionExternalIncludes 的同一份真源。
const _INCLUDE_LINE = new RegExp(INCLUDE_LINE_SOURCE, 'gm');
function _countIncludeRefs(content) {
  const hits = String(content || '').match(_INCLUDE_LINE);
  return hits ? hits.length : 0;
}

// 文件型 source 的存在性预检:不存在就不进候选。否则预算死掉时会把从没存在过的
// 路径记进「整体缺席」名单 —— 汇总行对一个幽灵文件说谎,比不汇总更糟。
function _ecoFileExists(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * 列出一个目录型 source 里的全部规则文件(按文件名排序)。
 * 每目录 maxFiles 的上限由调用方施加并记账:超出的那份要记为 dir-cap 丢失,
 * 不能在这里静默截掉。
 * @returns {string[]} 绝对路径
 */
function _listEcoDirFiles(src) {
  try {
    if (!fs.existsSync(src.path) || !fs.statSync(src.path).isDirectory()) {
      return [];
    }
    return fs
      .readdirSync(src.path)
      .filter((f) => src.exts.some((ext) => f.toLowerCase().endsWith(ext)))
      .sort()
      .map((f) => path.join(src.path, f));
  } catch {
    return [];
  }
}

/**
 * 发现生态规则文件。纯壳:所有「在哪、要不要收」的判断都在 registry 叶子里。
 *
 * 先列全候选文件(含每目录 maxFiles 上限之外的),再逐个读:预算死掉时要把「还没
 * 轮到」的文件也记进 dropped,否则整体缺席在注入文本里照样零标记。
 *
 * @param {string} projectDir 项目根(git-root || cwd)
 * @param {Set<string>} seen  已收录的 path.resolve 结果(去重,khy 自己的文件优先)
 * @returns {Array<{path,content,level:'ecosystem',ecosystem,label,kind,truncated,size,includeRefs}>}
 *   有丢失时首个元素是 kind:'notice' 的汇总条目(无对应文件,path 为空)。
 */
function discoverEcosystemInstructionFiles(projectDir, seen) {
  const results = [];
  const dropped = [];
  let budget = _ecoReg.ECO_MAX_TOTAL_CHARS;
  try {
    const sources = _ecoReg.instructionEcosystemSources({
      homedir: os.homedir(),
      projectDir,
      env: process.env,
    });
    const candidates = [];
    for (const src of sources) {
      if (src.mode === 'dir') {
        for (const [index, filePath] of _listEcoDirFiles(src).entries()) {
          if (index >= src.maxFiles) {
            dropped.push({ path: filePath, reason: 'dir-cap' });
            continue;
          }
          candidates.push({ src, filePath });
        }
        continue;
      }
      if (_ecoFileExists(src.path)) {
        candidates.push({ src, filePath: src.path });
      }
    }
    for (const [index, candidate] of candidates.entries()) {
      if (budget <= 0) {
        for (const rest of candidates.slice(index)) {
          dropped.push({ path: rest.filePath, reason: 'budget' });
        }
        break;
      }
      const { src, filePath } = candidate;
      const resolved = path.resolve(filePath);
      // seen 命中说明 khy 原生层已经收录同一文件 —— 没有丢,只是换了一层,不计入 dropped。
      if (seen.has(resolved)) {
        continue;
      }
      const entry = readFileSafe(filePath, _ecoReg.ECO_MAX_FILE_CHARS);
      if (!entry) {
        continue;
      }
      // 带作用域的规则(Cursor alwaysApply/globs、Copilot applyTo、Kiro inclusion)
      // 只收「全局生效」的那些 —— khy 的提示词没有 per-file 作用域。
      if (src.scoped && !_ecoReg.evaluateScopedRule(entry.content).accept) {
        dropped.push({ path: filePath, reason: 'scoped' });
        continue;
      }
      let content = entry.content;
      if (content.length > budget) {
        const notice = _ecoBudgetNotice(content.length, entry.truncated);
        // 剩余预算连一条声明都装不下时,这个文件整体出局:记 budget 后把 budget 归零,
        // 由下一轮候选的 budget<=0 分支统一记账收尾。硬塞整条 notice 会让 budget 变负,
        // 生态层总预算被撑爆最多一条声明的长度。
        if (notice.length >= budget) {
          dropped.push({ path: filePath, reason: 'budget' });
          budget = 0;
          continue;
        }
        content = content.slice(0, budget - notice.length) + notice;
      }
      if (!content.trim()) {
        continue;
      }
      budget -= content.length;
      seen.add(resolved);
      results.push({
        path: filePath,
        content,
        level: 'ecosystem',
        ecosystem: src.ecosystem,
        label: src.label,
        kind: src.kind,
        truncated: entry.truncated || content.length < entry.content.length,
        size: entry.size,
        includeRefs: _countIncludeRefs(content),
      });
    }
  } catch {
    // 生态层永远不能拖垮 khy 自己的指令发现
  }
  if (dropped.length > 0) {
    results.unshift(_ecoDropNotice(dropped, results.length));
  }
  return results;
}

function discoverInstructionFiles(cwd) {
  cwd = cwd || process.cwd();
  const results = [];
  const seen = new Set();

  // 1. Global: ~/.khyquant/khy.md 或 KHY.md
  const globalHit = findFirstInstructionFile(_appHome());
  if (globalHit) {
    const content = resolveIncludes(globalHit.file.content, path.dirname(globalHit.path));
    results.push({
      path: globalHit.path,
      content,
      level: 'global',
      truncated: globalHit.file.truncated,
      size: globalHit.file.size,
    });
    seen.add(path.resolve(globalHit.path));
  }

  // 2. Project: <git-root>/khy.md 或 KHY.md
  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    const projectHit = findFirstInstructionFile(gitRoot);
    if (projectHit) {
      const resolved = path.resolve(projectHit.path);
      if (!seen.has(resolved)) {
        const content = resolveIncludes(projectHit.file.content, path.dirname(projectHit.path));
        results.push({
          path: projectHit.path,
          content,
          level: 'project',
          truncated: projectHit.file.truncated,
          size: projectHit.file.size,
          externalIncludes: detectExternalIncludes(
            projectHit.file.content,
            path.dirname(projectHit.path),
            gitRoot
          ),
        });
        seen.add(resolved);
      }
    }

    // 2b. Rules: <git-root>/.khy/rules/*.md
    const ruleFiles = discoverRuleFiles(gitRoot);
    for (const rf of ruleFiles) {
      const rfResolved = path.resolve(rf.path);
      if (!seen.has(rfResolved)) {
        const content = resolveIncludes(rf.content, path.dirname(rf.path));
        results.push({
          path: rf.path,
          content,
          level: 'rules',
          truncated: rf.truncated,
          size: rf.size,
          externalIncludes: detectExternalIncludes(rf.content, path.dirname(rf.path), gitRoot),
        });
        seen.add(rfResolved);
      }
    }
  }

  // 3. Directory: every <dir>/khy.md from cwd up to (excluding) git-root,
  //    nearest first. The git-root entry itself is already in `seen` from the
  //    project tier above, so the shared inclusive chain dedups naturally.
  for (const dir of instructionDirsToGitRoot(cwd, gitRoot)) {
    const dirHit = findFirstInstructionFile(dir);
    if (!dirHit) {
      continue;
    }
    const dirResolved = path.resolve(dirHit.path);
    if (seen.has(dirResolved)) {
      continue;
    }
    const content = resolveIncludes(dirHit.file.content, path.dirname(dirHit.path));
    results.push({
      path: dirHit.path,
      content,
      level: 'directory',
      truncated: dirHit.file.truncated,
      size: dirHit.file.size,
      externalIncludes: detectExternalIncludes(dirHit.file.content, path.dirname(dirHit.path), dir),
    });
    seen.add(dirResolved);
  }

  // 4. 生态层:别的 agent 已经写好的规则文件(最低优先级,门控默认开;关 → 空数组)。
  //    刻意**不**对生态文件跑 resolveIncludes():`@path` 导入是 khy 自己指令文件的约定,
  //    对第三方文件展开它等于替别人的文件拉取任意路径 —— 多一层信任面,不值当。
  results.push(...discoverEcosystemInstructionFiles(gitRoot || cwd, seen));

  return results;
}

/**
 * Load and merge all khy.md instructions into a single string.
 * Suitable for direct injection into the AI system prompt.
 *
 * @param {string} [cwd]
 * @returns {string} merged instructions (empty string if none found)
 */
function _droppedByBudgetNotice(dropped) {
  // 生态层汇总条目(kind:'notice')没有对应文件,混进「未注入」名单只会多个空路径。
  const paths = dropped.filter((f) => f.kind !== 'notice').map((f) => f.path);
  if (paths.length === 0) {
    return '';
  }
  return (
    `⚠ [BUDGET] 指令总预算 ${MAX_TOTAL_CHARS} 字符已用尽，以下文件未注入：` +
    `${paths.join('、')}；完整内容用 Read 工具直接读对应文件`
  );
}

function loadInstructions(cwd) {
  const files = discoverInstructionFiles(cwd);
  if (files.length === 0) {
    return '';
  }

  const LEVEL_LABELS = {
    global: '全局指令',
    project: '项目指令',
    rules: '规则指令',
    directory: '目录指令',
    ecosystem: '生态指令',
  };

  const sections = [];
  let totalChars = 0;

  for (const [index, file] of files.entries()) {
    // 生态层丢失汇总自带完整文本、没有对应文件:不走下面的 header/预算/扫描,
    // 作为独立段渲染即可(它排在生态块头部,见 discoverEcosystemInstructionFiles)。
    if (file.kind === 'notice') {
      sections.push(file.content);
      totalChars += file.content.length;
      continue;
    }
    // 生态文件必须**标明出处**:模型看到的是第三方文本,来源要可归因(也让用户一眼看出
    // 哪条约束不是自己写的)。
    const label =
      file.level === 'ecosystem' && file.label
        ? `${LEVEL_LABELS.ecosystem}(${file.label})`
        : LEVEL_LABELS[file.level] || file.level;
    const header = `[${label} - ${file.path}]`;
    let content = file.content;

    // Security scan: detect potential prompt injection patterns
    const scanResult = scanForPromptInjection(content);
    if (scanResult.length > 0) {
      const warnings = scanResult.map((s) => s.pattern).join(', ');
      const warningLine = `⚠ [SECURITY] Potential prompt injection detected in ${file.path}: ${warnings}`;
      // Strip dangerous lines but keep the rest
      for (const match of scanResult) {
        if (match.line !== undefined) {
          const lines = content.split('\n');
          lines[match.line] = `[REDACTED: ${match.pattern}]`;
          content = lines.join('\n');
        }
      }
      sections.push(warningLine);
    }

    // External-include security notice (aligns CC ClaudeMdExternalIncludesDialog):
    // if this file's `@path` imports resolve OUTSIDE the repo/cwd trust boundary,
    // surface a one-line warning next to the injection notice. Detection is gated
    // (KHY_EXTERNAL_INCLUDE_WARNING, default on) inside detectExternalIncludes →
    // empty array when off, so no line is appended (byte-identical fallback). This
    // only WARNS — resolveIncludes already made the allow/deny decision; we never
    // alter it here (read/awareness only, security control flow untouched).
    const extWarn = buildExternalIncludeWarning(file.path, file.externalIncludes);
    if (extWarn) {
      sections.push(extWarn);
    }

    // 生态文件的 `@path` 行刻意不展开(discoverInstructionFiles 第 4 步),原样行进
    // 提示词会让模型以为内容已内联 —— 在条目旁边说清,与上面的外引告知同形。
    if (file.level === 'ecosystem' && file.includeRefs > 0) {
      sections.push(
        `⚠ [INCLUDE-NOT-EXPANDED] ${file.path}：含 ${file.includeRefs} 行 @ 路径引用未展开` +
          `（生态层不替第三方规则拉取外部文件）；需要时用 Read 工具读取对应文件`
      );
    }

    // Enforce total limit. A file that never makes it in (or is cut by the
    // remaining budget) must say so in the prompt — a silently dropped rule file
    // is indistinguishable from one that was never written.
    const remaining = MAX_TOTAL_CHARS - totalChars - header.length - 2;
    if (remaining <= 0) {
      const dropNotice = _droppedByBudgetNotice(files.slice(index));
      if (dropNotice) {
        sections.push(dropNotice);
      }
      break;
    }
    if (content.length > remaining) {
      sections.push(
        `⚠ [BUDGET] ${file.path} 超出指令总预算：原文 ${content.length} 字符，仅注入前 ${remaining} 字符；完整内容用 Read 工具直接读该文件`
      );
      content = content.slice(0, remaining);
    }

    const section = `${header}\n${content}`;
    sections.push(section);
    totalChars += section.length;

    if (totalChars >= MAX_TOTAL_CHARS) {
      const dropNotice = _droppedByBudgetNotice(files.slice(index + 1));
      if (dropNotice) {
        sections.push(dropNotice);
      }
      break;
    }
  }

  return sections.join('\n\n');
}

// ── Prompt Injection Detection ─────────────────────────────────────

/**
 * Scan text for common prompt injection patterns.
 * Returns array of matches with pattern name and line number.
 *
 * Patterns detected:
 * - Role override attempts ("you are now", "act as", "new system prompt")
 * - Instruction override ("ignore previous", "disregard above", "forget instructions")
 * - System prompt escape ("</system>", "[SYSTEM]:", "<<SYS>>")
 * - Hidden instructions (base64 encoded commands, zero-width chars)
 * - Privilege escalation ("admin mode", "developer mode", "jailbreak")
 *
 * @param {string} text
 * @returns {Array<{pattern: string, line: number, snippet: string}>}
 */
const INJECTION_PATTERNS = [
  {
    name: 'instruction_override',
    regex:
      /(?:^|\n)\s*(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+)?(?:previous|above|prior|earlier|existing)\s+(?:instructions?|rules?|prompts?|guidelines?)/im,
  },
  {
    name: 'role_hijack',
    regex:
      /(?:^|\n)\s*(?:you are now|from now on you are|act as|pretend (?:to be|you are)|assume the role of|new system prompt|your new (?:role|instructions?|prompt))/im,
  },
  {
    name: 'system_escape',
    regex: /<\/system>|<<SYS>>|<\|im_start\|>system|\[SYSTEM\]\s*:|<\|system\|>/i,
  },
  {
    name: 'base64_command',
    regex: /(?:execute|run|eval|decode)\s*(?:this\s+)?base64[:\s]+[A-Za-z0-9+/]{40,}={0,2}/i,
  },
  {
    name: 'privilege_escalation',
    regex:
      /(?:^|\n)\s*(?:enable|activate|enter|switch to)\s+(?:admin|developer|debug|god|root|sudo|jailbreak|unrestricted)\s+mode/im,
  },
  {
    name: 'output_suppression',
    regex:
      /(?:do not|don't|never)\s+(?:mention|reveal|disclose|show|output)\s+(?:this|these|the)\s+(?:instructions?|rules?|prompt|system)/im,
  },
];

function scanForPromptInjection(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }
  const results = [];
  const lines = text.split('\n');

  // Layer 1: Built-in patterns (6 patterns, fast)
  for (const { name, regex } of INJECTION_PATTERNS) {
    const match = regex.exec(text);
    if (match) {
      let charCount = 0;
      let lineNum = 0;
      for (let i = 0; i < lines.length; i++) {
        charCount += lines[i].length + 1;
        if (charCount > match.index) {
          lineNum = i;
          break;
        }
      }
      results.push({
        pattern: name,
        line: lineNum,
        snippet: match[0].trim().slice(0, 80),
      });
    }
  }

  // Layer 2: Delegate to securityGuardService for deeper analysis (30+ patterns)
  // Unified scanning pipeline — catches patterns the built-in set misses
  try {
    const secGuard = require('./securityGuardService');
    if (secGuard && typeof secGuard.analyzeInput === 'function') {
      const analysis = secGuard.analyzeInput(text);
      if (analysis && !analysis.safe && analysis.severity !== 'LOW') {
        const existing = new Set(results.map((r) => r.pattern));
        if (!existing.has(analysis.threat)) {
          results.push({
            pattern: `security_guard:${analysis.threat || 'unknown'}`,
            line: 0,
            snippet: `[${analysis.severity}] ${(analysis.refusal || '').slice(0, 60)}`,
          });
        }
      }
    }
  } catch {
    /* securityGuardService not available */
  }

  return results;
}

/**
 * Get a summary of loaded instruction files (for /memory command).
 * @param {string} [cwd]
 * @returns {Array<{ path: string, level: string, size: number, truncated: boolean }>}
 */
function getInstructionSummary(cwd) {
  // kind:'notice' 是生态层丢失汇总,不是文件 —— /memory 只列真实文件,保持原输出。
  return discoverInstructionFiles(cwd)
    .filter((f) => f.kind !== 'notice')
    .map(({ path: p, level, size, truncated, label }) => ({
      path: p,
      level,
      size,
      truncated,
      // 生态层带上出处名(如 'Cursor'),让 /memory 能显示这条规则是蹭谁的。
      ...(label ? { label } : {}),
    }));
}

// Compat-tier search dirs: the cwd → git-root chain (nearest first) plus the
// home dir. The /memory summary below must list exactly what
// getProjectInstructionsSection injects, so it walks the same chain as the
// compat reader in constants/prompts.js instead of probing [cwd, home] alone.
function _compatSearchDirs(cwd, homeDir) {
  const dirs = new Set(instructionDirsToGitRoot(cwd));
  if (homeDir !== cwd) {
    dirs.add(homeDir);
  }
  return [...dirs];
}

function getCompatInstructionSummary(cwd) {
  cwd = cwd || process.cwd();
  const results = [];
  const seen = new Set();
  const homeDir = os.homedir();

  for (const dir of _compatSearchDirs(cwd, homeDir)) {
    for (const filename of COMPAT_FILENAMES) {
      const filePath = path.join(dir, filename);
      const resolved = path.resolve(filePath);
      if (seen.has(resolved)) {
        continue;
      }
      const file = readFileSafe(filePath);
      if (!file) {
        continue;
      }
      seen.add(resolved);
      results.push({
        path: filePath,
        type: /agents?\.md$/i.test(filename) ? 'agents' : 'claude',
        size: file.size,
        truncated: file.truncated,
      });
    }
  }

  return results;
}

const QUICK_MEMORY_HEADING = '## Memories';

/**
 * Resolve the target instruction file for a quick-add memory.
 *   scope='project' (default) → existing khy.md under git-root (or cwd if no
 *                               git root), else <root>/khy.md to be created.
 *   scope='global'            → existing khy.md under ~/.khyquant, else create.
 * @returns {{ file: string, dir: string }}
 */
function _resolveQuickMemoryTarget(scope, cwd) {
  cwd = cwd || process.cwd();
  let dir;
  if (scope === 'global') {
    dir = _appHome();
  } else {
    dir = findGitRoot(cwd) || cwd;
  }
  // Reuse an existing instruction file name if present, else default to khy.md.
  for (const name of FILENAMES) {
    if (fs.existsSync(path.join(dir, name))) {
      return { file: path.join(dir, name), dir };
    }
  }
  return { file: path.join(dir, FILENAMES[0]), dir };
}

// Singular agent.md family (target='agent'). Plural AGENTS.md is intentionally NOT
// a write target — it is the cross-tool shared file khy only reads; khy writes its
// own agent.md so it never clobbers a tool-ecosystem AGENTS.md.
const AGENT_FILENAMES = ['agent.md', 'AGENT.md'];

/**
 * Resolve the on-disk instruction file for a quick-add write, honoring the
 * `target` file family ('khy' → khy.md/KHY.md, 'agent' → agent.md/AGENT.md).
 * Mirrors _resolveQuickMemoryTarget's "reuse existing casing, else default"
 * behaviour so re-writes append to the same file the user already has.
 *
 * @param {'khy'|'agent'} target
 * @param {'project'|'global'} scope
 * @param {string} [cwd]
 * @returns {{ file: string, dir: string }}
 */
function _resolveInstructionTarget(target, scope, cwd) {
  if (target !== 'agent') {
    return _resolveQuickMemoryTarget(scope, cwd);
  }
  cwd = cwd || process.cwd();
  const dir = scope === 'global' ? _appHome() : findGitRoot(cwd) || cwd;
  for (const name of AGENT_FILENAMES) {
    if (fs.existsSync(path.join(dir, name))) {
      return { file: path.join(dir, name), dir };
    }
  }
  return { file: path.join(dir, AGENT_FILENAMES[0]), dir };
}

/**
 * Append a one-line memory to an instruction file — the user-driven counterpart
 * to the auto-memory pipeline, mirroring Claude Code's `#` quick-add. Because the
 * instruction file is ALWAYS injected into the system prompt, the note is first
 * screened for prompt-injection and rejected if it trips the scanner (we must not
 * let a stray `#` line plant attacker instructions into every future turn).
 *
 * The note is appended as a bullet under a `## Memories` section, created if
 * absent. The target file/dir is created on demand.
 *
 * @param {string} note - the memory text (already stripped of the leading `#`).
 * @param {object} [opts]
 * @param {'project'|'global'} [opts.scope='project']
 * @param {'khy'|'agent'} [opts.target='khy'] - target file family (agent → agent.md).
 * @param {string} [opts.cwd]
 * @param {Date} [opts.now] - injectable clock for deterministic tests.
 * @returns {{ success:boolean, file?:string, created?:boolean, note?:string, scope?:string, error?:string, threats?:Array, warning?:string }}
 */
function appendQuickMemory(note, opts = {}) {
  const text = String(note || '').trim();
  if (!text) {
    return { success: false, error: '空记忆：# 后需跟随要记住的内容' };
  }

  const scope = opts.scope === 'global' ? 'global' : 'project';
  const target = opts.target === 'agent' ? 'agent' : 'khy';

  const threats = scanForPromptInjection(text);
  if (threats.length > 0) {
    return {
      success: false,
      error: '记忆内容触发了提示注入检测，已拒绝写入（指令文件会注入到系统提示，必须保持可信）',
      threats,
    };
  }

  const { file, dir } = _resolveInstructionTarget(target, scope, opts.cwd);
  const stamp = (opts.now instanceof Date ? opts.now : new Date()).toISOString().slice(0, 10);
  const bullet = `- (${stamp}) ${text}`;

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const created = !fs.existsSync(file);
    let content = created ? '' : fs.readFileSync(file, 'utf-8');

    if (content.includes(QUICK_MEMORY_HEADING)) {
      // Insert the bullet at the end of the existing Memories section (right
      // before the next heading, or at EOF if it is the last section).
      const lines = content.split('\n');
      const headIdx = lines.findIndex((l) => l.trim() === QUICK_MEMORY_HEADING);
      let insertAt = lines.length;
      for (let i = headIdx + 1; i < lines.length; i++) {
        if (/^#{1,6}\s/.test(lines[i])) {
          insertAt = i;
          break;
        }
      }
      // Trim trailing blank lines inside the section so bullets stay contiguous.
      let end = insertAt;
      while (end > headIdx + 1 && lines[end - 1].trim() === '') {
        end--;
      }
      lines.splice(end, 0, bullet);
      content = lines.join('\n');
    } else {
      const sep = content && !content.endsWith('\n') ? '\n' : '';
      const lead = content ? `${sep}\n` : '';
      content = `${content}${lead}${QUICK_MEMORY_HEADING}\n\n${bullet}\n`;
    }

    fs.writeFileSync(file, content, 'utf-8');
    // Past MAX_FILE_CHARS the overflow never reaches the prompt (readFileSafe keeps
    // only the head), so a plain `success: true` would tell the user "remembered"
    // about a note the model can never see. Report it instead of staying silent.
    if (content.length > MAX_FILE_CHARS) {
      return {
        success: true,
        file,
        created,
        note: text,
        scope,
        warning:
          `已写入 ${file}，但该文件现有 ${content.length} 字符，超过单文件上限 ${MAX_FILE_CHARS}：` +
          `超出部分不会进入系统提示词，本条记忆可能到不了模型。请精简该文件，或拆分到 .khy/rules/*.md`,
      };
    }
    return { success: true, file, created, note: text, scope };
  } catch (err) {
    return { success: false, error: `写入失败: ${err.message}` };
  }
}

module.exports = {
  discoverInstructionFiles,
  findFirstInstructionFile,
  loadInstructions,
  appendQuickMemory,
  _resolveInstructionTarget,
  getInstructionSummary,
  getCompatInstructionSummary,
  resolveIncludes,
  discoverRuleFiles,
  discoverEcosystemInstructionFiles,
  scanForPromptInjection,
  instructionDirsToGitRoot,
  FILENAMES,
  AGENT_FILENAMES,
  COMPAT_FILENAMES,
  MAX_FILE_CHARS,
  MAX_TOTAL_CHARS,
  MAX_INCLUDE_DEPTH,
  MAX_INCLUDE_FILES,
  RULES_DIR,
};
