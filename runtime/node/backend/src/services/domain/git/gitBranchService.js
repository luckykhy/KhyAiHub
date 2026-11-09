'use strict';

/**
 * gitBranchService.js — Git 分支领域的执行层（后端单一真源）。
 *
 * 职责边界：
 *   · 本模块**跑 git**（list / switch / create），产出结构化结果。
 *   · 判定（分支名合法性、会不会覆盖改动、有无冲突……）全部委托给纯叶子
 *     `branchGuard.js`——本模块不重新发明判据。
 *   · 失败一律翻译成 `branchGuard` 的错误码，**绝不把 git 的英文 stderr
 *     直接透给用户**（桌面端 i18n 已为每个错误码备好中文文案）。
 *
 * 复用既有资产，绝不另起一套 git 解析：
 *   · git 可执行文件解析 → `services/gitExecutableDetector`（Windows 优先 Git Bash）
 *   · 无 shell 派生 spawn → `services/gitSpawnPlan`
 *
 * 全程 fail-soft：任何一步失败都返回 `{ ok: false, code, message }`，
 * 绝不抛出——调用方（工具层 / 桌面端 IPC）只处理结果，不处理异常。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const guard = require('./branchGuard');

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * 解析 git 可执行文件路径。Windows 优先 Git Bash 的 git.exe，其它平台保持
 * 'git'（与既有 `gitContextService` / `gitStatus` 的行为一致）。
 *
 * @returns {string|null} 解析不到时返回 null
 */
function _resolveGit() {
  if (process.platform === 'win32') {
    try {
      const detector = require('../../gitExecutableDetector');
      const detected = detector.detectGitExecutable();
      if (detected) {
        return detected;
      }
    } catch {
      /* 检测失败 → 回退 'git' */
    }
  }
  return 'git';
}

/**
 * 跑一条 git 命令，返回 `{ ok, out, err }`（不抛）。
 *
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} [timeout]
 * @returns {{ ok: boolean, out: string, err: string }}
 */
function _git(args, cwd, timeout) {
  const git = _resolveGit();
  if (!git) {
    return { ok: false, out: '', err: '本机未找到可用的 Git 可执行文件' };
  }
  try {
    const out = execFileSync(git, args, {
      cwd,
      encoding: 'utf-8',
      timeout: timeout || DEFAULT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { ok: true, out: String(out || ''), err: '' };
  } catch (err) {
    const stderr = (err && err.stderr ? err.stderr.toString() : '') || '';
    return { ok: false, out: '', err: stderr || (err && err.message) || String(err) };
  }
}

/**
 * 当前目录是否在 git 工作树内。
 *
 * @param {string} cwd
 * @returns {boolean}
 */
function isGitRepo(cwd) {
  const res = _git(['rev-parse', '--is-inside-work-tree'], cwd, 5000);
  return res.ok && res.out.trim() === 'true';
}

/**
 * 采集仓库的进行中操作标志（rebase / merge / cherry-pick / bisect）。
 *
 * 判据文件在 `.git` 目录下。注意 worktree 场景下 `.git` 可能是文件而非目录，
 * 故先解析 `git rev-parse --git-dir` 拿真实路径。
 *
 * @param {string} cwd
 * @returns {string[]} 存在的标志名列表
 */
function _operationMarkers(cwd) {
  const gitDirRes = _git(['rev-parse', '--absolute-git-dir'], cwd, 5000);
  const gitDir = gitDirRes.ok ? gitDirRes.out.trim() : '';
  if (!gitDir) {
    return [];
  }
  const candidates = [
    'rebase-merge',
    'rebase-apply',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG',
  ];
  const found = [];
  for (const name of candidates) {
    try {
      if (fs.existsSync(path.join(gitDir, name))) {
        found.push(name);
      }
    } catch {
      /* 探测失败按「不存在」处理 */
    }
  }
  return found;
}

/**
 * 列出本地分支（含当前分支标记、upstream、ahead/behind、worktree 占用）。
 *
 * @param {string} cwd
 * @returns {object} `{ ok: true, branches: [...] }` 或 `{ ok: false, code, message }`
 */
function listBranches(cwd) {
  if (!isGitRepo(cwd)) {
    return { ok: false, code: 'notRepository', message: '当前工作区不在 Git 仓库中' };
  }

  // 用 for-each-ref 一次拿到结构化信息，避免逐分支 spawn。
  const fmt = '%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(worktreepath)';
  const res = _git(['for-each-ref', `--format=${fmt}`, 'refs/heads/'], cwd);
  if (!res.ok) {
    return {
      ok: false,
      code: guard.classifyGitFailure(res.err),
      message: res.err.trim() || '读取分支列表失败',
    };
  }

  const branches = [];
  for (const raw of res.out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const parts = line.split('\t');
    const name = parts[0] || '';
    if (!name) {
      continue;
    }
    const isCurrent = (parts[1] || '').trim() === '*';
    const upstream = (parts[2] || '').trim();
    const track = (parts[3] || '').trim();
    const worktreePath = (parts[4] || '').trim();

    // upstream:track 形如 "[ahead 2, behind 1]" / "[gone]"。
    let ahead = 0;
    let behind = 0;
    let gone = false;
    if (track) {
      const a = track.match(/ahead (\d+)/);
      const b = track.match(/behind (\d+)/);
      if (a) ahead = Number(a[1]);
      if (b) behind = Number(b[1]);
      gone = /gone/.test(track);
    }

    branches.push({
      name,
      current: isCurrent,
      upstream: upstream || null,
      ahead,
      behind,
      gone,
      // `%(worktreepath)` 对**当前** worktree 检出的分支同样返回路径（不是
      // 只有「别的 worktree」才非空），故必须再判一次「这个分支是不是当前
      // 分支」——否则当前分支会被误标成「已在其它 worktree 检出」。
      inOtherWorktree: Boolean(worktreePath) && !isCurrent,
      worktreePath: worktreePath || null,
    });
  }

  // 当前分支排最前，其余按名称排序 —— 与 Git 自身的展示习惯一致。
  branches.sort((a, b) => {
    if (a.current !== b.current) {
      return a.current ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return { ok: true, branches };
}

/**
 * 采集「切换到目标分支会覆盖哪些本地改动」。
 *
 * 判据：工作区有脏文件时，`git switch <target>` 会因下列文件失败——
 *   · 已跟踪文件：目标分支的版本与本地修改不同 → 会被覆盖。
 *   · 未跟踪文件：目标分支存在同名文件 → 会被覆盖。
 *
 * 用 `git diff --name-only <target>` 与工作区比对得出「会被覆盖」的集合。
 * 执行层只负责采集路径集合，判定交给 `branchGuard.assessOverwriteRisk`。
 *
 * @param {string} cwd
 * @param {string} branchName
 * @returns {{ tracked: string[], untracked: string[] }}
 */
function _collectOverwritePaths(cwd, branchName) {
  const empty = { tracked: [], untracked: [] };

  // 已跟踪：本地有修改，且目标分支上该文件与 HEAD 不同 → 切换会覆盖本地修改。
  const diffRes = _git(['diff', '--name-only', 'HEAD', branchName], cwd);
  if (!diffRes.ok) {
    return empty;
  }
  const differsOnTarget = new Set(
    diffRes.out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const modifiedRes = _git(['diff', '--name-only'], cwd);
  if (!modifiedRes.ok) {
    return empty;
  }
  const locallyModified = modifiedRes.out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const tracked = locallyModified.filter((p) => differsOnTarget.has(p));

  // 未跟踪：目标分支上存在同名文件的未跟踪文件。
  const untrackedRes = _git(['ls-files', '--others', '--exclude-standard'], cwd);
  if (!untrackedRes.ok) {
    return { tracked, untracked: [] };
  }
  const untracked = untrackedRes.out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => differsOnTarget.has(p));

  return { tracked, untracked };
}

/**
 * 切换分支。
 *
 * @param {string} cwd
 * @param {string} branchName
 * @param {object} [options]
 * @param {boolean} [options.force] - 强制覆盖本地改动（危险，调用方须显式确认）
 * @returns {object} `{ ok: true, branch }` 或 `{ ok: false, code, message, detail? }`
 */
function switchBranch(cwd, branchName, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const name = typeof branchName === 'string' ? branchName.trim() : '';

  if (!isGitRepo(cwd)) {
    return { ok: false, code: 'notRepository', message: '当前工作区不在 Git 仓库中' };
  }

  const branchList = listBranches(cwd);
  if (!branchList.ok) {
    return branchList;
  }
  const exists = branchList.branches.some((b) => b.name === name);

  const conflictedRes = _git(['diff', '--name-only', '--diff-filter=U'], cwd);
  const conflicted = guard.hasUnresolvedConflicts(conflictedRes.out);
  const markers = _operationMarkers(cwd);
  const operationInProgress = guard.hasOperationInProgress(markers);
  const inOtherWorktree = guard.isBranchInOtherWorktree(
    _git(['worktree', 'list', '--porcelain'], cwd).out,
    name,
    cwd
  );

  // 已跟踪/未跟踪的覆盖风险只在「目标分支存在」时采集——目标不存在时根本
  // 无从切换，覆盖风险无意义（会先被 targetBranchNotFound 拦下）。
  let trackedOverwrite = [];
  let untrackedOverwrite = [];
  if (exists) {
    const risk = _collectOverwritePaths(cwd, name);
    trackedOverwrite = risk.tracked;
    untrackedOverwrite = risk.untracked;
  }

  const verdict = guard.assessSwitch({
    branchName: name,
    branchExists: exists,
    conflicted,
    operationInProgress,
    inOtherWorktree,
    trackedOverwrite,
    untrackedOverwrite,
  });

  if (!verdict.allowed) {
    if (verdict.code === 'dirtyWorkingTree' && !opts.force) {
      return {
        ok: false,
        code: verdict.code,
        message: '本地有改动会被目标分支覆盖，需先提交或显式强制切换',
        detail: verdict.detail,
      };
    }
    if (verdict.code !== 'dirtyWorkingTree') {
      return {
        ok: false,
        code: verdict.code,
        message: _MESSAGE[verdict.code] || '切换分支失败',
      };
    }
  }

  // 优先 `git switch`（安全：拒绝覆盖本地改动）；老版本 Git 回退 `git checkout`。
  let res = _git(['switch', name], cwd);
  if (!res.ok) {
    res = _git(['checkout', name], cwd);
  }
  if (!res.ok) {
    return {
      ok: false,
      code: guard.classifyGitFailure(res.err),
      message: res.err.trim() || '切换分支失败',
    };
  }

  return { ok: true, branch: name };
}

/**
 * 创建分支并切换过去（基于当前 HEAD）。
 *
 * @param {string} cwd
 * @param {string} branchName
 * @returns {object}
 */
function createBranch(cwd, branchName) {
  const name = typeof branchName === 'string' ? branchName.trim() : '';

  if (!isGitRepo(cwd)) {
    return { ok: false, code: 'notRepository', message: '当前工作区不在 Git 仓库中' };
  }

  const branchList = listBranches(cwd);
  if (!branchList.ok) {
    return branchList;
  }
  const exists = branchList.branches.some((b) => b.name === name);

  const conflictedRes = _git(['diff', '--name-only', '--diff-filter=U'], cwd);
  const conflicted = guard.hasUnresolvedConflicts(conflictedRes.out);
  const operationInProgress = guard.hasOperationInProgress(_operationMarkers(cwd));

  const verdict = guard.assessCreate({
    branchName: name,
    branchExists: exists,
    conflicted,
    operationInProgress,
  });
  if (!verdict.allowed) {
    return {
      ok: false,
      code: verdict.code,
      message: _MESSAGE[verdict.code] || '创建分支失败',
    };
  }

  const res = _git(['switch', '-c', name], cwd);
  if (!res.ok) {
    return {
      ok: false,
      code: guard.classifyGitFailure(res.err),
      message: res.err.trim() || '创建分支失败',
    };
  }
  return { ok: true, branch: name };
}

/**
 * 各错误码对应的中文兜底文案。桌面端有更完整的 i18n 文案，此处是后端
 * 直连场景（工具层 / CLI）的兜底，保证任何路径都不吐英文 stderr。
 */
const _MESSAGE = {
  invalidBranchName: '分支名无效',
  branchAlreadyExists: '分支已存在',
  targetBranchNotFound: '目标分支不存在',
  conflictsPresent: '仓库还有未解决的冲突',
  operationInProgress: '有进行中的 Git 操作',
  branchInOtherWorktree: '目标分支已在其他 worktree 中被检出',
  dirtyWorkingTree: '本地改动会被目标分支覆盖',
  notRepository: '当前工作区不在 Git 仓库中',
  unknown: '分支操作失败',
};

module.exports = {
  isGitRepo,
  listBranches,
  switchBranch,
  createBranch,
  _MESSAGE,
};
