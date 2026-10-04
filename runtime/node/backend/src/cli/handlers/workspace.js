/**
 * workspace.js — Workspace checkpoint save/restore/diff
 *
 * Provides local workspace snapshot management: save state via git-diff
 * or tar, restore to a previous point, compare diffs between checkpoints.
 * Designed for safe experimentation without polluting git history.
 *
 * @module handlers/workspace
 */
'use strict';

// ── Imports ──

const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const path = require('path');

const chalk = require('chalk').default || require('chalk');

const _formatBytesAtom = require('../../utils/formatBytes');
const { printSuccess, printError, printWarn, printInfo, printTable } = require('../formatters');

let _checkpointService = null;

function _getService() {
  if (!_checkpointService) {
    _checkpointService = require('../../services/domain/workspace/workspace/checkpointService.js');
  }
  return _checkpointService;
}

function _getProjectDir() {
  // Use current working directory as the project root
  return process.cwd();
}

// ─── Save ──────────────────────────────────────────────────────────────────

async function handleWorkspaceSave(args = [], options = {}) {
  const svc = _getService();
  const projectDir = _getProjectDir();
  const message = options.m || options.message || args.join(' ') || undefined;
  const mode = options.mode || 'auto';

  try {
    printInfo(`保存工作区检查点（模式=${mode}）`);
    const result = svc.saveCheckpoint(projectDir, { message, mode });
    printSuccess(`检查点已保存：${chalk.cyan(result.id)}`);
    console.log(`  模式：  ${result.mode}`);
    console.log(`  说明：  ${result.message}`);
    console.log(`  分支：  ${result.branch || '无'}`);
    console.log(`  提交：  ${result.commitHash || '无'}`);
    if (result.size > 0) {
      console.log(`  大小：  ${_formatSize(result.size)}`);
    }
    return result;
  } catch (err) {
    printError(`保存检查点失败：${err.message}；跑 \`workspace stats\` 查看存储状况。`);
    return null;
  }
}

// ─── Restore ───────────────────────────────────────────────────────────────

async function handleWorkspaceRestore(args = [], options = {}) {
  const svc = _getService();
  const projectDir = _getProjectDir();
  const checkpointId = args[0];

  if (!checkpointId) {
    printError('用法：workspace restore <检查点 ID>（ID 见 `workspace list`）');
    return null;
  }

  const dryRun = options['dry-run'] || options.dryRun || false;

  try {
    if (dryRun) {
      printInfo(`[dry-run] 预演恢复检查点 ${checkpointId}（不改动文件）`);
    } else {
      printWarn(`恢复检查点 ${chalk.cyan(checkpointId)}：将覆盖当前工作区文件`);
    }

    const result = svc.restoreCheckpoint(projectDir, checkpointId, { dryRun });
    if (result.restored) {
      printSuccess(`已恢复：${result.message}`);
    } else {
      printInfo(result.message);
    }
    return result;
  } catch (err) {
    printError(`恢复检查点 ${checkpointId} 失败：${err.message}；跑 \`workspace list\` 核对 ID。`);
    return null;
  }
}

// ─── List ──────────────────────────────────────────────────────────────────

async function handleWorkspaceList() {
  const svc = _getService();
  const projectDir = _getProjectDir();

  const checkpoints = svc.listCheckpoints(projectDir);
  if (checkpoints.length === 0) {
    printInfo('暂无检查点。用 `workspace save` 创建第一个。');
    return [];
  }

  console.log(`\n  ${chalk.bold('工作区检查点')}（${checkpoints.length} 个）\n`);

  const rows = checkpoints.map((c, i) => [
    String(i + 1),
    c.id,
    c.mode,
    c.branch || '-',
    c.commitHash || '-',
    _formatSize(c.size || 0),
    c.timestamp ? new Date(c.timestamp).toLocaleString() : '-',
    (c.message || '').slice(0, 40),
  ]);

  printTable(['#', 'ID', '模式', '分支', '提交', '大小', '时间', '说明'], rows);

  return checkpoints;
}

// ─── Diff ──────────────────────────────────────────────────────────────────

async function handleWorkspaceDiff(args = []) {
  const svc = _getService();
  const projectDir = _getProjectDir();
  const checkpointId = args[0];

  if (!checkpointId) {
    printError('用法：workspace diff <检查点 ID>（ID 见 `workspace list`）');
    return null;
  }

  try {
    const result = svc.diffCheckpoint(projectDir, checkpointId);
    if (result.diff) {
      console.log(result.diff);
      if (result.stats.additions || result.stats.deletions) {
        console.log(
          `\n  ${chalk.green(`+${result.stats.additions}`)} / ${chalk.red(`-${result.stats.deletions}`)}`
        );
      }
    }
    return result;
  } catch (err) {
    printError(`对比检查点 ${checkpointId} 失败：${err.message}；跑 \`workspace list\` 核对 ID。`);
    return null;
  }
}

// ─── Delete ────────────────────────────────────────────────────────────────

async function handleWorkspaceDelete(args = []) {
  const svc = _getService();
  const projectDir = _getProjectDir();
  const checkpointId = args[0];

  if (!checkpointId) {
    printError('用法：workspace delete <检查点 ID>（ID 见 `workspace list`）');
    return null;
  }

  try {
    const ok = svc.deleteCheckpoint(projectDir, checkpointId);
    if (ok) {
      printSuccess(`已删除检查点：${checkpointId}`);
    } else {
      printWarn(`未找到检查点 ${checkpointId}：跑 \`workspace list\` 核对 ID。`);
    }
    return ok;
  } catch (err) {
    printError(`删除检查点 ${checkpointId} 失败：${err.message}`);
    return false;
  }
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

async function handleWorkspaceCleanup(args = [], options = {}) {
  const svc = _getService();
  const projectDir = _getProjectDir();
  const keep = parseInt(options.keep, 10) || 10;

  try {
    const removed = svc.cleanupCheckpoints(projectDir, keep);
    if (removed > 0) {
      printSuccess(`已清理 ${removed} 个旧检查点，保留最近 ${keep} 个。`);
    } else {
      printInfo(
        `无需清理 — ${svc.listCheckpoints(projectDir).length} 个检查点均未超出保留上限 ${keep}。`
      );
    }
    return removed;
  } catch (err) {
    printError(`清理失败：${err.message}；可先用 \`workspace list\` 查看后手动 \`workspace delete <ID>\`。`);
    return 0;
  }
}

// ─── Stats ─────────────────────────────────────────────────────────────────

async function handleWorkspaceStats() {
  const svc = _getService();
  const projectDir = _getProjectDir();

  const stats = svc.getCheckpointStats(projectDir);
  console.log(`\n  ${chalk.bold('检查点统计')}`);
  console.log(`  项目目录：${projectDir}`);
  console.log(`  检查点数：${stats.count}`);
  console.log(`  总占用：  ${stats.formatted}`);
  return stats;
}

// ─── Router ────────────────────────────────────────────────────────────────

/**
 * Route workspace sub-commands.
 * @param {string[]} args - Sub-command and arguments
 * @param {object} options - Parsed flags
 */
async function handleWorkspace(args = [], options = {}) {
  const subCommand = args[0] || 'list';
  const subArgs = args.slice(1);

  switch (subCommand) {
    case 'save':
    case 's':
      return handleWorkspaceSave(subArgs, options);
    case 'restore':
    case 'r':
      return handleWorkspaceRestore(subArgs, options);
    case 'list':
    case 'ls':
    case 'l':
      return handleWorkspaceList();
    case 'diff':
    case 'd':
      return handleWorkspaceDiff(subArgs);
    case 'delete':
    case 'rm':
      return handleWorkspaceDelete(subArgs);
    case 'cleanup':
    case 'clean':
      return handleWorkspaceCleanup(subArgs, options);
    case 'stats':
    case 'info':
      return handleWorkspaceStats();
    default:
      printError(`未知 workspace 子命令 "${subCommand}"`);
      console.log('  可用：save、restore、list、diff、delete、cleanup、stats');
      return null;
  }
}

// CC 后端口径对齐:字节数 → 人类可读走 CC `formatFileSize` 单一真源(ccFormat SSOT)。
// 门控 KHY_CC_FORMAT(经 ccFormatEnabled)默认开;关 / require 失败 → 逐字节回退旧本地口径。
function _formatSize(bytes, env = process.env) {
  try {
    const { ccFormatEnabled, ccFormatFileSize } = require('../ccFormat');
    if (ccFormatEnabled(env)) {
      const out = ccFormatFileSize(bytes);
      if (out) {
        return out;
      }
    }
  } catch {
    /* fall through to legacy */
  }
  // Legacy fallback: thin delegate to the canonical formatter (utils/formatBytes);
  // the default 3-tier B/KB/MB cascade is byte-identical to the old local code.
  return _formatBytesAtom(bytes);
}

module.exports = {
  handleWorkspace,
  handleWorkspaceSave,
  handleWorkspaceRestore,
  handleWorkspaceList,
  handleWorkspaceDiff,
  handleWorkspaceDelete,
  handleWorkspaceCleanup,
  handleWorkspaceStats,
  [MANIFEST_EXPORT_KEY]: {
    name: 'workspace',
    description: '工作区快照：保存/恢复/对比（基于 git diff）',
    category: 'system',
    handler: async (parsed) => handleWorkspace(parsed.subCommand ? [parsed.subCommand, ...parsed.args] : parsed.args, parsed.options),
  },
};
