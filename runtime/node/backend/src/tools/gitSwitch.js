'use strict';

/**
 * gitSwitch — switch to an existing branch, or create a new one and switch to it.
 *
 * Risk model (mirrors gitPush's shape, and deliberately one notch stricter
 * about *what it changes*):
 *   · Switching branches rewrites the working tree. It is normally reversible
 *     (`git switch <old-branch>` gets you back) and it never destroys commits
 *     on its own → `risk:'medium'`, NOT destructive → L1 confirm, never the
 *     red line.
 *   · The `force` flag discards local modifications that the target branch
 *     would overwrite. That IS data loss → `isDestructive()` returns true so
 *     the syscall gateway sends it to L2 (red line).
 *
 * Read-only counterpart: gitBranch (listing branches is auto-approvable).
 */

const { defineTool, isGitRepo } = require('./_baseTool');
const gitBranchService = require('../services/domain/git/gitBranchService');

/** Force mode = discarding local modifications = irreversible data loss. */
function _isForce(params) {
  return !!(params && (params.force === true || params.create === true));
}

module.exports = defineTool({
  name: 'gitSwitch',
  description:
    'Switch the current working tree to another Git branch, optionally creating that branch first (based on the current HEAD). ' +
    'Refuses to run when local changes would be overwritten, when conflicts are unresolved, or when the target branch is checked out in another worktree. ' +
    'Use gitBranch first to see the available branches; use force only when the user explicitly asks to discard local changes.',
  category: 'git',
  risk: 'medium',
  isReadOnly: false,
  // Dynamic: force discards local modifications (irreversible), create is not.
  isDestructive: (params) => !!(params && params.force === true),
  isConcurrencySafe: false,
  isEnabled: isGitRepo,
  aliases: ['git_switch', 'gitCheckout'],
  searchHint: 'switch branch checkout create 切换分支 检出 新建分支',
  inputSchema: {
    branch: {
      type: 'string',
      required: true,
      maxLength: 255,
      description:
        'Target branch name to switch to, e.g. "feature/login". The name must be a valid Git branch name (no spaces, no "..", no leading "-").',
      example: 'feature/login',
    },
    create: {
      type: 'boolean',
      required: false,
      description:
        'Create the branch based on the current HEAD before switching to it (default: false). Fails if a branch with that name already exists.',
      example: false,
    },
    force: {
      type: 'boolean',
      required: false,
      description:
        'Discard local modifications that the target branch would overwrite (default: false). Destructive: it can lose uncommitted work, so only set it when the user explicitly asks.',
      example: false,
    },
  },
  async execute(params, context) {
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    const name = String((params && params.branch) || '').trim();

    if (!name) {
      return { success: false, error: '请指定要切换到的分支名。' };
    }

    const res = params && params.create
      ? gitBranchService.createBranch(cwd, name)
      : gitBranchService.switchBranch(cwd, name, { force: !!(params && params.force) });

    if (!res.ok) {
      // 结构化错误码随结果一起返回：调用方（CLI / 桌面端）可据此翻译成
      // 人话，而不必去解析英文 stderr。
      return {
        success: false,
        error: res.message || '切换分支失败',
        code: res.code,
        detail: res.detail,
      };
    }

    return {
      success: true,
      output: `已切换到分支：${res.branch}`,
      branch: res.branch,
    };
  },
});
