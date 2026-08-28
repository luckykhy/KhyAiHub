'use strict';

/**
 * gitDiffCollect.js — 纯叶子(注入式 runner、零 IO、确定性、绝不抛、可单测)。
 *
 * `/diff` 工作区差异采集:把**未跟踪(新建)文件**也纳入差异输出。
 *
 * 复现痛点(用户实测):khy 的 diff 显示里,绿色的 `+` 只有在「已有文件中新加行」时才出现,
 * 新建文件则是「透明的」(根本不显示)。
 *
 * 根因:`/diff` 两处入口(cli/repl.js、cli/router.js)都跑**裸 `git diff`**。`git diff`(无参)
 * 只输出已跟踪文件的「未暂存」修改,**完全忽略未跟踪(新建)文件**。于是改已有文件→渲染器把
 * `+` 行涂绿;新建文件→无任何 diff 输出→屏上什么都没有=用户说的「透明」。
 *
 * 修法:对每个未跟踪文件用 `git diff --no-index -- /dev/null <f>` 合成整份 unified diff
 * (全 `+` 行),追加到 tracked diff 之后,交给既有渲染器正常涂绿。
 *
 * 与渲染器无关(已排除):inline write/edit diff 对「新建 vs 编辑」生成的行 kind 对称,涂色正确;
 * 问题纯在「喂给渲染器的 diff 文本本身漏了新文件」。
 *
 * leaf-contract:本叶子不 require `child_process`。真正执行 git 的 `runGit(argsArray)` 由调用方
 * 注入(薄壳 execFileSync),约定**绝不抛**并返回 `{ stdout: string }`;`git diff --no-index`
 * 在有差异时退出码为 1(execFileSync 会抛),调用方负责把 `err.stdout` 也捕获回来。
 *
 * 门控:KHY_DIFF_INCLUDE_UNTRACKED(默认开)。=0/false/off/no → 关 → 直接返回裸 `git diff` 的
 * trim,与历史逐字节一致。
 */

const FALSY = new Set(['0', 'false', 'off', 'no']);

function includeUntrackedEnabled(env = process.env) {
  const flag = String((env && env.KHY_DIFF_INCLUDE_UNTRACKED) || '')
    .trim()
    .toLowerCase();
  return !FALSY.has(flag);
}

function _stdout(result) {
  // runGit 约定返回 { stdout }；防呆:非对象 / stdout 缺失 → ''。
  if (!result || typeof result !== 'object') {
    return '';
  }
  const out = result.stdout;
  return typeof out === 'string' ? out : out == null ? '' : String(out);
}

const DEFAULT_MAX_UNTRACKED = 50;

/**
 * 采集工作区差异:tracked(未暂存)+ 未跟踪新文件(经 --no-index 合成)。
 *
 * @param {(args: string[]) => {stdout: string}} runGit  注入的 git runner,绝不抛。
 * @param {object} [env=process.env]
 * @param {object} [opts]
 * @param {number} [opts.maxUntracked=50]  未跟踪文件展示上限(超出追加诚实标记,不静默截断)。
 * @returns {string} 合并后的 unified diff 文本(已 trim 各段;调用方可再 .trim())。
 */
function collectWorkingTreeDiff(runGit, env = process.env, opts = {}) {
  const run =
    typeof runGit === 'function'
      ? (args) => {
          try {
            return runGit(args);
          } catch (_e) {
            return { stdout: '' };
          }
        }
      : () => ({ stdout: '' });

  const tracked = _stdout(run(['diff'])).trim();

  // 门控关 → 逐字节回退历史(只裸 git diff)。
  if (!includeUntrackedEnabled(env)) {
    return tracked;
  }

  const listRaw = _stdout(run(['ls-files', '--others', '--exclude-standard', '-z']));
  const untracked = listRaw.split('\0').filter(Boolean);

  let max = Number(opts && opts.maxUntracked);
  if (!Number.isFinite(max) || max < 0) {
    max = DEFAULT_MAX_UNTRACKED;
  }

  const parts = [];
  if (tracked) {
    parts.push(tracked);
  }

  const shown = untracked.slice(0, max);
  for (const f of shown) {
    const synth = _stdout(run(['diff', '--no-index', '--', '/dev/null', f])).trim();
    if (synth) {
      parts.push(synth);
    }
  }

  const omitted = untracked.length - shown.length;
  if (omitted > 0) {
    // no silent caps:数量过多时诚实提示,绝不静默丢弃。
    parts.push(`… +${omitted} 个新文件未显示(数量过多;手动 git add 后再看全量)`);
  }

  return parts.join('\n');
}

// ── 文件级概览(/diff 首屏第一眼答案)─────────────────────────────────────
//
// DSH 对齐(deepseek-ai/deepseek-harness「Turn review tab」/changed-files card):
// 全量 diff 倾倒上百行之前,先给「动了哪些文件、各 ±几行」的概览表 —— 这是对
// 「直观展示改动」的第一眼答案,行级红绿是第二眼。解析与渲染都是纯函数:
// 解析(unified diff 文本 → 每文件 ±计数)归本叶子(它是 /diff 的数据采集 SSOT),
// 拼版(formatDiffOverview → 字符串行)也在这里,call-site 只 console.log。

function diffOverviewEnabled(env = process.env) {
  const flag = String((env && env.KHY_DIFF_OVERVIEW) || '')
    .trim()
    .toLowerCase();
  return !FALSY.has(flag);
}

const DEFAULT_MAX_OVERVIEW_FILES = 20;
const OVERVIEW_BAR_CELLS = 10;

/**
 * 解析 unified diff 文本,按文件统计 ±行数。文件段以 `diff --git a/… b/…` 开切
 * (tracked 与 --no-index 合成的未跟踪 diff 都带该头;无头段落并入当前文件)。
 * 只认单个 `+`/`-` 前缀的正文行,`+++`/`---` 头不计;新文件段路径取 `+++ b/<path>`。
 * 纯函数、绝不抛。
 * @param {string} diffText
 * @returns {Array<{path:string,added:number,removed:number}>} 按改动量降序
 */
function summarizeDiffFiles(diffText) {
  const text = String(diffText ?? '');
  if (!text) {
    return [];
  }
  const files = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.path) {
      files.push(cur);
    }
    cur = null;
  };
  for (const ln of text.split('\n')) {
    if (/^diff --git /.test(ln)) {
      flush();
      cur = { path: '', added: 0, removed: 0 };
      continue;
    }
    if (!cur) {
      // 无 `diff --git` 头的裸段落(如手工拼接的片段):宽容建段。
      cur = { path: '', added: 0, removed: 0 };
    }
    if (/^\+\+\+ /.test(ln)) {
      // +++ b/services/foo.js → 剥 b/ 前缀;/dev/null(删除侧)不作为路径真源。
      const p = ln.slice(4).trim();
      if (p && p !== '/dev/null' && !cur.path) {
        cur.path = p.replace(/^b\//, '');
      }
      continue;
    }
    if (/^--- /.test(ln)) {
      const p = ln.slice(4).trim();
      if (p && p !== '/dev/null' && !cur.path) {
        cur.path = p.replace(/^a\//, '');
      }
      continue;
    }
    if (/^\+/.test(ln)) {
      cur.added++;
    } else if (/^-/.test(ln)) {
      cur.removed++;
    }
  }
  flush();
  return files.sort((a, b) => b.added + b.removed - (a.added + a.removed));
}

/**
 * 把概览表拼成可直接打印的行数组(ANSI 由 call-site 的 chalk 施加,这里产纯文本,
 * 与 editStatLine 同一「纯文本叶子」分工)。
 *   改动概览: 3 个文件, +42 -7
 *     services/foo.js        +21 -4  █████▌░░░░░
 * 超过 maxFiles 个文件时诚实追加省略行,不静默截断。
 * @param {Array<{path:string,added:number,removed:number}>} entries
 * @param {object} [opts] {maxFiles?:number}
 * @returns {string[]}
 */
function formatDiffOverview(entries, opts = {}) {
  if (!Array.isArray(entries) || !entries.length) {
    return [];
  }
  let max = Number(opts && opts.maxFiles);
  if (!Number.isFinite(max) || max < 1) {
    max = DEFAULT_MAX_OVERVIEW_FILES;
  }
  const totalAdded = entries.reduce((s, e) => s + e.added, 0);
  const totalRemoved = entries.reduce((s, e) => s + e.removed, 0);
  const lines = [
    `改动概览: ${entries.length} 个文件, +${totalAdded} -${totalRemoved}`,
  ];
  const shown = entries.slice(0, max);
  const pathWidth = Math.max(0, ...shown.map((e) => e.path.length));
  for (const e of shown) {
    const changed = e.added + e.removed;
    const total = Math.max(1, totalAdded + totalRemoved);
    const filled = Math.max(changed > 0 ? 1 : 0, Math.round((changed / total) * OVERVIEW_BAR_CELLS));
    const bar = '█'.repeat(filled) + '░'.repeat(OVERVIEW_BAR_CELLS - filled);
    const stat = `+${e.added} -${e.removed}`;
    lines.push(`  ${e.path.padEnd(pathWidth)}  ${stat.padStart(12)}  ${bar}`);
  }
  const omitted = entries.length - shown.length;
  if (omitted > 0) {
    lines.push(`  … 另有 ${omitted} 个文件未列出(输入 /diff <路径> 看单文件)`);
  }
  return lines;
}

module.exports = {
  includeUntrackedEnabled,
  collectWorkingTreeDiff,
  diffOverviewEnabled,
  summarizeDiffFiles,
  formatDiffOverview,
};
