#!/usr/bin/env node
'use strict';

/**
 * path-integrity.js —— 目录迁移后的路径完整性检查与自愈。
 *
 * 为什么存在
 * ----------
 * 本仓做过一次大迁移（方案 P：services/ → runtime/node/ 等，见下方 MIGRATION_ALIASES）。
 * 迁移会在三类地方留下「指向旧路径」的引用：
 *   ① node_modules 里的 workspace 符号链接（pnpm/npm 建的；迁移后悬空）
 *   ② package.json 的 workspaces 声明 与 scripts 里的 --prefix / --workspace
 *   ③ 启动器 / 配置脚本里的路径字符串
 *
 * ①最危险：悬空链接是**静默失败** —— require 不报「路径错」，只报「找不到模块」，
 * 于是能力全在、测试全绿、运行时才崩。而且 Windows 上 `existsSync` 对
 * **指向空路径的 junction 仍返回 true**，肉眼与脚本都容易误判为已修好。
 *
 * 用法
 * ----
 *   node scripts/maintenance/path-integrity.js           # 只检查；有 BROKEN 则 exit 1
 *   node scripts/maintenance/path-integrity.js --fix     # 自动重连可确定的
 *   node scripts/maintenance/path-integrity.js --scan-refs  # 扫源码/配置里的陈旧路径引用（只报告）
 *   node scripts/maintenance/path-integrity.js --scan-split-refs  # 扫**拆段字面量**（--scan-refs 的盲区，恒 exit 0）
 *   node scripts/maintenance/path-integrity.js --json    # 机器可读
 *
 * ★ 下次再迁移目录时：**只改 MIGRATION_ALIASES**，然后跑 --fix（重连链接）
 *   与 --scan-refs（找出源码里写死旧路径的地方）。别名表是「旧路径 → 新路径」
 *   的唯一真源，别在别处再写一遍。
 *
 * 不做什么
 * --------
 * 不改 git 跟踪的文件（只重连 node_modules 里的链接）。配置/脚本里的路径字符串
 * 只**报告**不自动改写 —— 自动改写源码风险远高于收益，交给人裁决。
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 迁移别名表 —— 唯一的迁移真源。
 * 顺序无关：脚本内部按 from 长度降序排，保证最长前缀优先。
 * from 以 '/' 结尾者按前缀匹配，否则按整段匹配（用于精确指向某个包目录）。
 */
const MIGRATION_ALIASES = [
  ['services/',          'runtime/node/'],
  ['platform/',          'runtime/substrate/platform/'],
  ['extensions/',        'delivery/extension/'],
  ['software/khyquant/', 'delivery/channel/khyquant/'],
  ['packaging/',         'works/ship/'],
  ['apps/ai-frontend',   'delivery/web/ai-frontend'],
  ['apps/provider-hub',  'delivery/web/provider-hub'],
  ['docs/06_DEPLOY_部署/', 'docs/06_DEPLOY_部署/其它部署/'],
  // 故意不列 'apps/khyos-desktop' → 'delivery/desktop/khyos-desktop'：
  // package.json workspaces 已声明新位置，但该目录**尚未建立**（迁移在途）。
  // 列上会让检查器把它当成"可自愈"，掩盖真实缺口。让它如实报 BROKEN。
];

// 遍历符号链接时跳过的目录：体积大且与「接线」无关。
// 注意 `works/` 既含构建产物（works/ship）也含测试残留（works/data），
// 但两者都不该有 wiring 级别的链接；为性能整棵跳过。**引用扫描不走这个集合**
// （它只吃 git ls-files 的跟踪文件，works/ship 里的源码会被扫到）。
const SKIP_DIRS = new Set(['.git', 'works', '.khy', '.khyos']);

const ALIASES_SORTED = [...MIGRATION_ALIASES].sort((a, b) => b[0].length - a[0].length);

// ── 路径工具 ────────────────────────────────────────────────────────────────

/** 把任意形式的链接目标规范成「相对仓库根的 posix 路径」；不在仓内则返回 null。 */
function toRepoRelative(target) {
  const abs = path.resolve(target);
  const rel = path.relative(REPO_ROOT, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** 按别名表重映射；无匹配返回 null。 */
function remapPath(relPath) {
  for (const [from, to] of ALIASES_SORTED) {
    let hit = -1;
    if (from.endsWith('/')) {
      if (relPath.startsWith(from)) hit = from.length;
    } else if (relPath === from || relPath.startsWith(from + '/')) {
      hit = from.length;
    }
    if (hit < 0) continue;
    // 幂等保护：当 `to` 本身就在 `from` 之下（如
    // `docs/06_DEPLOY_部署/` → `docs/06_DEPLOY_部署/其它部署/`）时，
    // 已迁移的路径仍会命中 `from`，再映射一次会变成 `…/其它部署/其它部署/…`。
    if (to.startsWith(from) && relPath.startsWith(to)) return relPath;
    return to + relPath.slice(hit);
  }
  return null;
}

// ── ① 悬空符号链接 ──────────────────────────────────────────────────────────

function walkSymlinks(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 权限/竞态一律跳过，检查器不该因单个目录失败
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      out.push(full);
    } else if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkSymlinks(full, out);
    }
  }
  return out;
}

function checkSymlinks() {
  const links = walkSymlinks(REPO_ROOT, []);
  const broken = [];
  const healthy = [];

  for (const link of links) {
    let rawTarget;
    try {
      rawTarget = fs.readlinkSync(link);
    } catch {
      continue;
    }
    const absTarget = path.resolve(path.dirname(link), rawTarget);

    // 用 lstat 判断目标本身是否存在，而不是 existsSync(link)：
    // Windows 上指向空路径的 junction，existsSync(link) 会是 true（假绿）。
    let targetOk = false;
    try {
      fs.statSync(absTarget);
      targetOk = true;
    } catch {
      targetOk = false;
    }
    if (targetOk) { healthy.push(link); continue; }

    const relTarget = toRepoRelative(absTarget);
    const relLink = path.relative(REPO_ROOT, link).split(path.sep).join('/');
    const suggested = relTarget ? remapPath(relTarget) : null;
    const suggestedExists = suggested
      ? fs.existsSync(path.join(REPO_ROOT, suggested))
      : false;

    broken.push({
      link: relLink,
      oldTarget: relTarget || absTarget,
      suggestedTarget: suggested,
      newTarget: suggestedExists ? suggested : null,
      reason: !relTarget
        ? 'target-outside-repo'
        : suggested
          ? (suggestedExists ? 'remappable' : 'remap-target-missing')
          : 'no-alias-match',
    });
  }
  return { broken, healthyCount: healthy.length };
}

// ── ② workspaces 与 ③ npm scripts 目标 ──────────────────────────────────────

function checkWorkspaces() {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  } catch (e) {
    return [{ item: 'package.json', reason: 'unreadable: ' + e.message }];
  }
  const out = [];
  for (const w of pkg.workspaces || []) {
    if (!fs.existsSync(path.join(REPO_ROOT, w))) {
      const suggested = remapPath(w.replace(/\/$/, ''));
      out.push({
        item: `workspaces: ${w}`,
        reason: 'missing',
        newTarget: suggested && fs.existsSync(path.join(REPO_ROOT, suggested)) ? suggested : null,
      });
    }
  }
  return out;
}

function checkScriptTargets() {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  const re = /--(?:prefix|workspace)[= ]+([^\s"']+)/g;
  const out = [];
  for (const [name, body] of Object.entries(pkg.scripts || {})) {
    if (typeof body !== 'string') continue;
    let m;
    while ((m = re.exec(body))) {
      const t = m[1];
      if (!fs.existsSync(path.join(REPO_ROOT, t))) {
        const suggested = remapPath(t.replace(/\/$/, ''));
        out.push({
          item: `scripts.${name} → ${t}`,
          reason: 'missing',
          newTarget: suggested && fs.existsSync(path.join(REPO_ROOT, suggested)) ? suggested : null,
        });
      }
    }
  }
  return out;
}

// ── ④ 陈旧路径引用扫描（只报告，不改写）───────────────────────────────────────

/**
 * 为什么单独做这一档
 * ------------------
 * 悬空符号链接会让 require 直接崩，所以「修好了」可验证。
 * 但**源码/配置里的路径字符串**是另一种断法：不崩，而是**静默失配**。
 *
 * 实测 2026-10-04：`runtime/node/backend/scripts/archDebtScan.js` 的 `--changed`
 * 门禁里写死 `const prefix = 'services/backend/'`。方案P 迁移后该前缀永不匹配，
 * 于是 `scanned` 恒为 0、恒报「改动文件体积全部达标」——守卫活着，判据死了。
 * 这类「假绿」比崩溃危险得多：崩溃有人修，假绿没人知道。
 *
 * 本档职责：把这类引用找出来，按 **活代码 / 注释 / 文档** 分级，并对活代码里的
 * 路径做**存在性判定**（旧路径不存在 + 重映射后存在 = 真断）。
 *
 * 为什么只报告不自动改写
 * ----------------------
 * 本仓 docs/ 与 evidence/ 里存在**迁移映射表**（方案P 全量文件去向表），
 * 它们把旧路径当「来源列」**故意保留**。自动改写会连历史记录一起毁掉。
 * 实测：全仓 `services/backend` 命中 1919 个文件，绝大多数是这类记录。
 * 因此「这条该不该改」必须由人裁决，工具只负责把真断挑出来。
 */

const DOC_EXT = new Set(['.md', '.html', '.htm']);
const TEXT_EXT = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.ps1', '.psm1',
  '.bat', '.cmd', '.sh', '.json', '.yaml', '.yml', '.toml', '.in', '.npmrc',
  '.txt', '.md', '.html', '.htm', '.cfg', '.conf', '.env',
]);
const PATH_CHAR = /[A-Za-z0-9_./\\${}%-]/;

/**
 * 由别名表生成「旧路径」正则（posix 与 win 两种分隔符都匹配）。
 *
 * 左边界只排除 `[A-Za-z0-9_-]`，**不排除 `/`** —— 因为本仓大量使用
 * `"$ROOT_DIR/extensions/..."` / `"%KHY_OS_ROOT%services\backend\..."` 这类
 * 「变量 + 路径」写法；若把 `/` 也算作边界字符，这些引用会被整个漏掉。
 * 代价是可能命中 `x/platform/packages` 这类子串，但随后的存在性判定会滤掉。
 */
function buildAliasRegexes() {
  return ALIASES_SORTED.map(([from]) => {
    const body = from
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\//g, '[\\\\/]');
    return new RegExp(`(?<![A-Za-z0-9_-])${body}(?=[A-Za-z0-9_.\\\\-])`, 'g');
  });
}

/** 从命中区间 `[start, end)` 向两侧扩出完整路径 token，同时回报 token 的行内起点。 */
function extractPathToken(line, start, end) {
  let s = start;
  let e = end;
  while (s > 0 && PATH_CHAR.test(line[s - 1])) s--;
  while (e < line.length && PATH_CHAR.test(line[e])) e++;
  return { token: line.slice(s, e), start: s };
}

/** 把 token 规范化成「相对仓库根的 posix 路径」；无法判定时返回 null。 */
function normalizeRef(token) {
  let t = token.replace(/\\/g, '/').replace(/\/+$/, '');
  // 剥掉变量前缀：`$ROOT_DIR/` ` ${KHY_ROOT}/ ` `%KHY_OS_ROOT%/` —— 留下真正的仓内路径。
  t = t
    .replace(/^\$\{[^}]*\}\//, '')
    .replace(/^\$[A-Za-z_][A-Za-z0-9_]*\//, '')
    .replace(/^%[^%/]+%\//, '');
  while (t.startsWith('./')) t = t.slice(2);
  // 绝对式仓内路径（如 dependabot 的 `directory: /services/backend`）：只有去掉前导 `/`
  // 后**确实命中一条迁移别名**才认，否则 `/usr/local` 之类会被误当仓内路径。
  if (t.startsWith('/') && ALIASES_SORTED.some(([from]) => t.slice(1) === from || t.slice(1).startsWith(from))) {
    t = t.slice(1);
  }
  if (!t || t.startsWith('/') || t.startsWith('../') || /^[A-Za-z]:/.test(t)) return null;
  return t;
}

/** 用 `#` 作注释的语言。 */
const HASH_LANGS = new Set([
  '.py', '.sh', '.ps1', '.psm1', '.yaml', '.yml', '.toml',
  '.npmrc', '.in', '.env', '.cfg', '.conf',
]);

/** 粗粒度判断命中点之前是否处于注释里。 */
function isCommentHit(line, index, ext) {
  const before = line.slice(0, index);
  const t = before.trimStart();
  if (HASH_LANGS.has(ext)) {
    if (t.startsWith('#')) return true;
    // 行内 `#` 注释：`#` 前必须是空白（排除 `${#var}`、URL 片段、色值 #fff）
    if (/\s#\s?/.test(before)) return true;
  }
  if (ext === '.bat' || ext === '.cmd') {
    if (/^(rem\b|::)/i.test(t)) return true;
  }
  if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return true;
  // 行内注释：`//` 之前不是 `:`（排除 http:// https:// file://）
  const m = before.lastIndexOf('//');
  if (m >= 0 && before[m - 1] !== ':') return true;
  return false;
}

/**
 * 判断该行是不是「打印/帮助文本」。
 * 这类行里的路径是**给人看的用法示例**，不是被程序消费的路径 —— 改了也不影响行为，
 * 但改了会让帮助文本与真实路径不符，所以归为「消息」单独计，不与真断混在一起。
 */
function looksLikeMessage(line) {
  const t = line.trim();
  if (/^(echo|printf|print|info|warn|log|Write-Host|Write-Output|Write-Error|console\.(?:log|warn|error))\b/i.test(t)) {
    return true;
  }
  if (/\busage\b/i.test(t)) return true;
  if (/\[options\]|<dir>|\[--|\[OPTIONS\]/.test(t)) return true;
  return false;
}

const CJK = /[\u4e00-\u9fff]/;
const QUOTE_CH = /['"`]/;

/**
 * 按「路径被写错后果有多严重」给文件分级。1 最危险，4 通常是刻意保留的记录。
 *
 *   1  打包 / 构建 / 启动器 / CI 工作流 —— 写错=产物缺件或直接崩
 *   2  运行时配置（会被程序当路径消费的 json/yaml/toml/ini）
 *   3  源码里的字符串字面量 —— 看用途，多为 require/路径拼接
 *   4  刻意保留旧路径的记录 —— 迁移映射表 / 历史归档 / **人读清单**
 *
 * 关于 `khy.module.json`：它自述「执行器只读 domain / mayDependOn / fanIn /
 * lifecycle.stage 四个字段，其余字段是给人读的」。所以它里面的 `fanInEvidence`
 * 路径清单**不进判据**，归 T4；别把它当 T2 去大改。
 *
 * 分级只是**排序与解释**，不隐藏任何条目：T4 也会计数并在末尾说明。
 */
function tierOf(rel) {
  const p = rel.replace(/\\/g, '/');
  const base = p.slice(p.lastIndexOf('/') + 1);
  // T4：刻意保留旧路径的记录 / 归档 / 人读清单
  if (base === 'khy.module.json') return 4;
  if (p.includes('/registry/')) return 4;
  if (/(映射表|注册表|去向表)/.test(base)) return 4;
  if (/^docs\/\d+_[^/]*\/历史\//.test(p)) return 4;
  if (/^works\/record\//.test(p)) return 4;
  if (/^evidence\//.test(p)) return 4;
  if (/\.(patch|diff)$/.test(base)) return 4;
  // T1：打包 / 构建 / 启动器 / CI
  if (base === 'MANIFEST.in' || base === 'Dockerfile' || base === 'docker-compose.yml') return 1;
  if (/\.(bat|cmd|sh|ps1|psm1)$/.test(base)) return 1;
  if (/^\.github\/workflows\//.test(p)) return 1;
  if (base === 'package.json' || base === 'pyproject.toml') return 1;
  // T2：运行时配置
  if (/\.(json|ya?ml|toml|in|npmrc|cfg|conf)$/.test(base)) return 2;
  // T3：源码
  return 3;
}

/**
 * 判断命中处的**用法**，用于把「功能性路径」和「散文里提到路径」分开。
 *
 *   literal —— 路径整个就是字符串字面量（`'services/backend'` / `"apps/x/y"`）→ 功能性
 *   bare    —— 路径作为裸参数出现（`include services/...` / `cd /d apps/...`）→ 功能性
 *   prose   —— 路径嵌在散文里（`- CLI 与 TUI (services/backend/src/cli)`）→ 描述性
 *
 * 判据：先看是否被引号包裹；否则看该行（**去掉行内注释后**）是否含中文 ——
 * 含中文且未被引号包裹的多半是说明文字，不是被程序消费的路径。
 * 这是启发式，不是真解析；所以 --scan-refs 只报告、绝不自动改写。
 */
function classifyUsage(line, s, e) {
  const before = line.slice(0, s);
  const after = line.slice(e);
  const afterNoComment = after.replace(/(\/\/|#).*$/, '');
  const cb = before[before.length - 1] ?? '';
  const ca = afterNoComment[0] ?? '';
  if (QUOTE_CH.test(cb) && (QUOTE_CH.test(ca) || ca === '')) return 'literal';
  if (CJK.test(before + afterNoComment)) return 'prose';
  return 'bare';
}

function scanStaleRefs() {
  let files;
  try {
    files = require('child_process')
      .execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
      .split('\0')
      .filter(Boolean);
  } catch (e) {
    return { error: 'git ls-files 失败：' + (e.code || e.message) };
  }

  const regexes = buildAliasRegexes();
  const codeHits = [];
  const commentHits = [];
  const proseHits = [];
  const docHits = [];
  let scannedFiles = 0;

  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue; // 二进制
    scannedFiles++;

    // 按 \r?\n 切：本仓有 CRLF 文件（如 MANIFEST.in），留着 \r 会让
    // existsSync 永远失败，把已经正确的路径误报成「不存在」。
    const lines = text.split(/\r?\n/);
    const isShell = ext === '.sh' || ext === '.bash';
    // shell heredoc 跟踪：`<<'EOF'` 与行首 `EOF` 之间是帮助/数据文本，不是被执行的代码。
    // 本仓的用法说明大量写在 heredoc 里（如 install-khy.sh 的 usage()），
    // 不跟踪会把整块帮助文本误报成「真断」。
    let heredocTag = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let inHeredoc = false;
      if (isShell) {
        if (heredocTag !== null) {
          if (line.trim() === heredocTag) heredocTag = null;
          else inHeredoc = true;
        } else {
          const hm = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
          if (hm) heredocTag = hm[1];
        }
      }
      if (!/services|platform|extensions|software|packaging|apps/.test(line)) continue;
      for (const re of regexes) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) {
          const s = m.index;
          const e = s + m[0].length;
          const { token, start } = extractPathToken(line, s, e);
          const ref = normalizeRef(token);
          const remapped = ref ? remapPath(ref) : null;
          const oldExists = ref ? fs.existsSync(path.join(REPO_ROOT, ref)) : false;
          const newExists = remapped ? fs.existsSync(path.join(REPO_ROOT, remapped)) : false;
          const usage = DOC_EXT.has(ext) ? 'doc' : classifyUsage(line, s, e);
          // 只登记「旧路径引用」，滤掉两类假阳性：
          //   ① 新路径里恰好含旧别名子串（如 runtime/substrate/platform/… 含 platform/）——
          //      映射不适用（remapped=null）且该路径真实存在，说明它本来就是新路径；
          //   ② 已迁移、映射后原地不动（如 docs/06_DEPLOY_部署/其它部署/…）——remapped === ref。
          // 不滤的话 --scan-refs 会被上万条噪声淹没，真断反而看不见。
          const noop = remapped === null ? oldExists : remapped === ref;
          if (ref === null || noop) {
            if (m[0].length === 0) re.lastIndex++;
            continue;
          }
          // ★ 落刀区间 = 「ref 对应的那一段」，**不是**整个 raw token。
          //   normalizeRef 会剥掉变量前缀（`$ROOT_DIR/` `%KHY_ROOT%/`）与尾部斜杠，
          //   而 raw 仍含它们；若按 raw 长度去 splice，就会把前缀/分隔符一起吃掉
          //   （实测：`"$ROOT_DIR/services/backend"` → `"runtime/node/backend"`，
          //     `services/backend/src/**` → `runtime/node/backend/src**`）。
          //   spanCol/span 是可直接 `line.slice(spanCol-1, spanCol-1+span.length) === span`
          //   校验、并按 `span.length` 长度替换的精确区间。
          const norm = token.replace(/\\/g, '/');
          const spanOff = Math.max(0, norm.indexOf(ref));
          const span = token.slice(spanOff, spanOff + ref.length);
          const rec = {
            file: rel,
            line: i + 1,
            // col/raw：别名命中处的**原始 token**（含变量前缀与尾分隔符）—— 仅供人读与报表。
            col: start + 1,
            ref: ref,
            raw: token,
            // spanCol/span：**精确可替换区间**，与 remapped 一一对应（长度可不等）。
            // 修复器请一律用 span/spanCol，不要用 raw/col 落刀。
            spanCol: start + spanOff + 1,
            span: span,
            usage,
            tier: tierOf(rel),
            oldExists,
            remapped,
            newExists,
            snippet: line.trim().slice(0, 150),
          };
          const bucket = DOC_EXT.has(ext)
            ? docHits
            : inHeredoc || isCommentHit(line, s, ext)
              ? commentHits
              : usage === 'prose' || looksLikeMessage(line)
                ? proseHits
                : codeHits;
          bucket.push(rec);
          if (m[0].length === 0) re.lastIndex++;
        }
      }
    }
  }

  // 「真断」= 功能性用法 + 旧路径不存在 + 重映射后存在。
  const actionable = codeHits.filter((h) => h.ref && !h.oldExists && h.newExists);
  return { scannedFiles, codeHits, commentHits, proseHits, docHits, actionable };
}

// ── ② 拆段字面量扫描（--scan-split-refs）────────────────────────────────────
//
// 为什么需要这个模式（2026-10-04 实测撞到的**漏报**，不是误报）：
// 上面 scanStaleRefs 的别名正则（buildAliasRegexes）要求**连续的** `services/` token，
// 但大量代码写的是 `path.join(...)` 的**多参形式**：
//
//     path.join(resolveKhyOsDir(), 'services', 'backend', '.env')
//
// 行里根本没有 `services/` 这个子串 ⇒ 正则永不命中，**该文件连候选都进不了**。
// 实测最小复现：连续写法命中 true / 拆段写法命中 false。
// 后果：`--scan-refs` 报 3544 处真断，而 `apps/khyos-desktop` 出现 0 次 ——
// 桌面端 host 的 8 条 backend 加载路径全在盲区里。
//
// ★ 本模式**只报告、不改写、恒 exit 0**，且**刻意不进任何 CI 门禁**：
//   拆段写法里相当一部分是**刻意**引用旧路径（自愈服务 sourceHealService /
//   portableSyncService、where.js 的展示、测试 fixture），放开成门禁会制造误报洪水。
//   公理 A4「误报比漏报更贵」—— 所以这里给的是**人工裁决清单**，不是判据。
//   判定「该不该改」的判据是「这行是不是真的要去读那个路径」，机器答不了。

/** 单行内的字符串字面量（单/双引号都收，含转义）。 */
const STR_LIT_RE = /'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/g;

/**
 * 把一行里**由逗号分隔的连续字符串字面量**归组。
 * `path.join(a, 'x', 'y')` → [['x','y']]；`f('a', 'b'), g('c')` → [['a','b']]（g 只有 1 段，丢弃）。
 * 只收 ≥2 段的组：单段字面量归 --scan-refs 管，不重复报。
 */
function splitSegmentGroups(line) {
  const lits = [];
  STR_LIT_RE.lastIndex = 0;
  let m;
  while ((m = STR_LIT_RE.exec(line))) {
    lits.push({ s: m.index, e: m.index + m[0].length, val: m[1] !== undefined ? m[1] : m[2] });
  }
  const groups = [];
  let cur = null;
  for (const lit of lits) {
    if (cur && /^\s*,\s*$/.test(line.slice(cur[cur.length - 1].e, lit.s))) {
      cur.push(lit);
      continue;
    }
    if (cur && cur.length >= 2) groups.push(cur);
    cur = [lit];
  }
  if (cur && cur.length >= 2) groups.push(cur);
  return groups;
}

/**
 * 在「拼起来的路径」里找别名（不要求出现在开头）。
 * `khy-os/services/backend/src/services` 也要能命中 `services/` ⇒ 逐个 from 找，
 * 左边界只排除 `[A-Za-z0-9_-]`（与 buildAliasRegexes 同口径）。
 *
 * ★ 必须滤掉「新路径里含旧别名子串」这一类**假阳性**（与 scanStaleRefs 的 noop 规则同旨）：
 *   迁移后的路径 `runtime/node/backend/src/services/gateway/x.js` 里含 `services/`，
 *   而 `runtime/substrate/platform/packages/shared` 里含 `platform/` —— 这两行本来就是对的。
 *   判据：命中点**已经在**新路径里（前缀含 `to`，或「前缀 + from」以 `to` 开头）。
 *
 * 取**最靠左**的可接受命中（并列时取最长的 from）—— 左边界才是旧路径真正的起点。
 */
function remapWithin(joined) {
  let best = null;
  for (const [from, to] of ALIASES_SORTED) {
    let idx = joined.indexOf(from);
    while (idx >= 0) {
      const prev = idx > 0 ? joined[idx - 1] : '';
      if (!/[A-Za-z0-9_-]/.test(prev)) {
        const prefix = joined.slice(0, idx);
        const alreadyMigrated = prefix.includes(to) || (prefix + from).startsWith(to);
        if (!alreadyMigrated && (best === null || idx < best.idx || (idx === best.idx && from.length > best.from.length))) {
          best = { idx, from, to, prefix };
        }
      }
      idx = joined.indexOf(from, idx + 1);
    }
  }
  if (!best) return null;
  return {
    prefix: best.prefix,
    ref: joined.slice(best.idx),
    remapped: best.to + joined.slice(best.idx + best.from.length),
  };
}

/**
 * 逐行判定（纯函数，无 I/O）—— 便于单测，也让 scanSplitRefs 只负责遍历与存在性判定。
 * 返回 `{ line, joined, ref, remapped, prefix }[]`（line 为 1-based）。
 */
function splitHitsInText(text, ext) {
  const out = [];
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 快筛：拆段写法必然有引号 + 逗号；没有就整行跳过（性能）。
    if (!line.includes(',') || (!line.includes("'") && !line.includes('"'))) continue;
    for (const group of splitSegmentGroups(line)) {
      const start = group[0].s;
      if (isCommentHit(line, start, ext)) continue; // 注释里的不算
      if (looksLikeMessage(line)) continue;         // 帮助文本 / echo 输出不算
      const joined = group.map((g) => g.val).join('/');
      const hit = remapWithin(joined);
      if (!hit) continue;
      out.push({ line: i + 1, joined, ref: hit.ref, remapped: hit.remapped, prefix: hit.prefix });
    }
  }
  return out;
}

function scanSplitRefs() {
  let files;
  try {
    files = require('child_process')
      .execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
      .split('\0')
      .filter(Boolean);
  } catch (e) {
    return { error: 'git ls-files 失败：' + (e.code || e.message) };
  }

  let scannedFiles = 0;
  const broken = [];   // 旧不存在 + 新存在 ⇒ 高置信真断
  const bothGone = []; // 新旧都不存在 ⇒ 多为便携/仓外相对路径，需人工看
  const oldAlive = []; // 旧路径还在 ⇒ 大概率刻意保留

  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    scannedFiles++;

    for (const h of splitHitsInText(text, ext)) {
      const oldExists = fs.existsSync(path.join(REPO_ROOT, h.ref));
      const newExists = fs.existsSync(path.join(REPO_ROOT, h.remapped));
      const rec = { file: rel, ...h };
      if (oldExists) oldAlive.push(rec);
      else if (newExists) broken.push(rec);
      else bothGone.push(rec);
    }
  }

  return { scannedFiles, broken, bothGone, oldAlive };
}

// ── 自愈 ────────────────────────────────────────────────────────────────────

function relink(entry) {
  const absLink = path.join(REPO_ROOT, entry.link);
  const absTarget = path.join(REPO_ROOT, entry.newTarget);
  try {
    try { fs.unlinkSync(absLink); } catch { /* 断链，unlink 可能失败于 junction */ }
    try { fs.rmdirSync(absLink); } catch { /* 同上 */ }
    // Windows: 'dir' 类型会建成 junction，且 Node 会把**相对** target 按进程 cwd 解析，
    // 导致建出空目录而 existsSync 仍为 true。必须用绝对路径。
    fs.symlinkSync(absTarget, absLink, 'junction');
    let ok = false;
    try { fs.statSync(absTarget); ok = true; } catch { ok = false; }
    return ok;
  } catch (e) {
    return { error: e.code || e.message };
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const doFix = args.includes('--fix');
  const asJson = args.includes('--json');
  const scanRefs = args.includes('--scan-refs');
  const scanSplitRefsMode = args.includes('--scan-split-refs');

  if (scanRefs) {
    const r = scanStaleRefs();
    if (r.error) {
      console.error(r.error);
      process.exit(2);
    }
    if (asJson) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log('path-integrity --scan-refs —— 陈旧路径引用扫描（只报告，不改写）');
      console.log(`扫描跟踪文本文件 ${r.scannedFiles} 个`);
      console.log('');
      console.log(`分级：功能性用法 ${r.codeHits.length} 处 / 注释 ${r.commentHits.length} 处 / 散文描述 ${r.proseHits.length} 处 / 文档 ${r.docHits.length} 处`);
      console.log('');

      console.log(`★ 真断（功能性用法 + 旧路径不存在 + 重映射后存在）${r.actionable.length} 处：`);
      if (!r.actionable.length) {
        console.log('  （无）');
      } else {
        const TIER_LABEL = {
          1: 'T1 打包/构建/启动器/CI —— 写错=产物缺件或直接崩',
          2: 'T2 运行时配置 —— 会被程序当路径消费',
          3: 'T3 源码字符串',
          4: 'T4 迁移映射表/历史归档/人读清单 —— 通常刻意保留，先别改',
        };
        const byTier = new Map();
        for (const h of r.actionable) {
          if (!byTier.has(h.tier)) byTier.set(h.tier, new Map());
          const m = byTier.get(h.tier);
          if (!m.has(h.file)) m.set(h.file, []);
          m.get(h.file).push(h);
        }
        for (const t of [1, 2, 3, 4]) {
          const m = byTier.get(t);
          if (!m) continue;
          const total = [...m.values()].reduce((a, b) => a + b.length, 0);
          console.log('');
          console.log(`  ── ${TIER_LABEL[t]}（${m.size} 文件 / ${total} 处）`);
          const ranked = [...m.entries()].sort((a, b) => b[1].length - a[1].length);
          for (const [file, hits] of ranked) {
            console.log(`     ${file}  (${hits.length} 处)`);
            for (const h of hits.slice(0, 4)) {
              console.log(`       :${h.line}  ${h.ref}  →  ${h.remapped}`);
            }
            if (hits.length > 4) console.log(`       …（其余 ${hits.length - 4} 处）`);
          }
        }
      }
      console.log('');

      // 功能性用法但旧路径仍存在：多半是「新旧两处并存」的过渡期写法，需人眼判断。
      const ambiguous = r.codeHits.filter((h) => h.ref && h.oldExists);
      if (ambiguous.length) {
        console.log(`需人眼判断 ${ambiguous.length} 处（功能性用法，但旧路径**仍存在**）：`);
        for (const h of ambiguous.slice(0, 30)) {
          console.log(`  ?      ${h.file}:${h.line}  ${h.ref}`);
        }
        if (ambiguous.length > 30) console.log(`  …（其余 ${ambiguous.length - 30} 处省略）`);
        console.log('');
      }

      console.log('注释 / 散文描述 / 文档里的旧路径**不算缺陷**（迁移映射表刻意保留来源列），');
      console.log('故不逐条列出。确认该改的：手动改，或把该目录补进 MIGRATION_ALIASES 后跑 --fix。');
    }
    process.exit(r.actionable.length > 0 ? 1 : 0);
  }

  if (scanSplitRefsMode) {
    const r = scanSplitRefs();
    if (r.error) {
      console.error(r.error);
      process.exit(2);
    }
    if (asJson) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log('path-integrity --scan-split-refs —— 拆段字面量扫描（只报告，不改写，恒 exit 0）');
      console.log(`扫描跟踪文本文件 ${r.scannedFiles} 个`);
      console.log('');
      console.log('覆盖的是 --scan-refs 的**盲区**：path.join(root, \'services\', \'backend\', \'.env\')');
      console.log('这种多参写法里没有连续的 `services/` 子串，别名正则永不命中。');
      console.log('');
      console.log(`★ 真断（旧路径不存在 + 重映射后存在）${r.broken.length} 处：`);
      if (!r.broken.length) {
        console.log('  （无）');
      } else {
        const byFile = new Map();
        for (const h of r.broken) {
          if (!byFile.has(h.file)) byFile.set(h.file, []);
          byFile.get(h.file).push(h);
        }
        const ranked = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
        for (const [file, hits] of ranked) {
          console.log(`  ${file}  (${hits.length} 处)`);
          for (const h of hits.slice(0, 4)) console.log(`    :${h.line}  ${h.ref}  →  ${h.remapped}`);
          if (hits.length > 4) console.log(`    …（其余 ${hits.length - 4} 处）`);
        }
      }
      console.log('');
      console.log(`另外两类**需人工看**（不自动判缺陷）：`);
      console.log(`  旧路径仍在 ${r.oldAlive.length} 处 / 新旧都不存在 ${r.bothGone.length} 处`);
      console.log('  （后者多为便携包/仓外的相对路径；前者多为自愈服务刻意引用旧路径）');
      if (r.broken.length) {
        const byTop = new Map();
        for (const h of r.broken) {
          const k = h.file.split('/')[0];
          byTop.set(k, (byTop.get(k) || 0) + 1);
        }
        const parts = [...byTop.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`);
        const testHits = r.broken.filter((h) => /(^|\/)tests?\//.test(h.file) || /\.test\.[cm]?js$/.test(h.file)).length;
        console.log('');
        console.log(`按顶层目录：${parts.join(' / ')}`);
        console.log(`其中落在测试文件里：${testHits} 处（fixture 常照抄真仓的同款病）`);
      }
      console.log('');
      console.log('⚠ 判定「该不该改」的判据是「这行是不是真的要去读那个路径」，机器答不了 ——');
      console.log('  本模式刻意不进任何 CI 门禁（公理 A4：误报比漏报更贵）。');
    }
    process.exit(0);
  }

  const { broken, healthyCount } = checkSymlinks();
  const wsIssues = checkWorkspaces();
  const scriptIssues = checkScriptTargets();

  const fixed = [];
  const stillBroken = [];

  for (const b of broken) {
    if (doFix && b.newTarget) {
      const r = relink(b);
      if (r === true) { fixed.push(b); continue; }
      stillBroken.push({ ...b, reason: 'relink-failed: ' + (r.error || 'unknown') });
    } else {
      stillBroken.push(b);
    }
  }

  if (asJson) {
    console.log(JSON.stringify({
      healthySymlinks: healthyCount,
      brokenFound: broken.length,
      fixed,
      stillBroken,
      workspacesIssues: wsIssues,
      scriptIssues,
    }, null, 2));
  } else {
    console.log('path-integrity —— 目录迁移后的路径完整性检查' + (doFix ? '（--fix 已启用）' : ''));
    console.log(`符号链接：健康 ${healthyCount} 个，悬空 ${broken.length} 个`);
    console.log('');

    if (fixed.length) {
      console.log(`已自愈（重连到新路径）${fixed.length} 个：`);
      for (const f of fixed) console.log(`  FIXED   ${f.link}\n            ${f.oldTarget}  →  ${f.newTarget}`);
      console.log('');
    }

    if (stillBroken.length) {
      console.log(`仍需处理 ${stillBroken.length} 个：`);
      for (const b of stillBroken) {
        const hint = b.newTarget ? `（可自愈 → ${b.newTarget}；加 --fix 执行）`
          : b.reason === 'no-alias-match' ? '（别名表无匹配；若这是新迁移，请补 MIGRATION_ALIASES）'
            : b.reason === 'remap-target-missing' ? `（别名表映射到 ${b.suggestedTarget}，但该目录不存在 —— 迁移未完成，需人工补建）`
              : b.reason === 'target-outside-repo' ? '（目标在仓外，非迁移问题）'
                : `（${b.reason}）`;
        console.log(`  BROKEN  ${b.link}\n            → ${b.oldTarget} ${hint}`);
      }
      console.log('');
    }

    const configIssues = [...wsIssues, ...scriptIssues];
    if (configIssues.length) {
      console.log(`配置层缺口 ${configIssues.length} 处（不自动改写，需人工裁决）：`);
      for (const c of configIssues) {
        console.log(`  MISS    ${c.item}${c.newTarget ? `  → 建议 ${c.newTarget}` : ''}`);
      }
      console.log('');
    }

    if (!stillBroken.length && !configIssues.length) console.log('全部通过。');
  }

  process.exit(stillBroken.length > 0 ? 1 : 0);
}

if (require.main === module) main();

// 供其它工具复用（如按 span 精确落刀的修复器）。
// 别名表是唯一真源 —— 任何下游都从这里取，别在别处再抄一份。
module.exports = {
  MIGRATION_ALIASES,
  ALIASES_SORTED,
  remapPath,
  normalizeRef,
  extractPathToken,
  buildAliasRegexes,
  PATH_CHAR,
  scanSplitRefs,
  splitHitsInText,
  splitSegmentGroups,
  remapWithin,
};
