'use strict';

/**
 * gitBranch — list the local branches of the current repository.
 *
 * Complements the native git tool family (gitStatus / gitDiff / gitLog /
 * gitCommit / gitPush already exist): before the model can switch branches it
 * must be able to *see* them, otherwise it guesses names or falls back to a
 * raw shell command.
 *
 * Read-only and safe to auto-approve. The write counterpart is gitSwitch,
 * which is gated behind a human confirmation.
 */

const { defineTool, isGitRepo } = require('./_baseTool');
const gitBranchService = require('../services/domain/git/gitBranchService');

module.exports = defineTool({
  name: 'gitBranch',
  description:
    'List the local Git branches of the current repository, marking the current one and each branch\'s upstream/ahead/behind counts. ' +
    'Read-only; use it before gitSwitch to pick an existing branch name, and to check whether a branch exists before creating it.',
  category: 'git',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  isEnabled: isGitRepo,
  aliases: ['git_branch', 'gitBranches'],
  searchHint: 'branch list branches current upstream 分支 列表 当前分支',
  inputSchema: {
    include_remote: {
      type: 'boolean',
      required: false,
      description:
        'Also include remote-tracking branches (origin/main etc.) in the list (default: false — only local branches are returned).',
      example: false,
    },
  },
  async execute(params, context) {
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    const res = gitBranchService.listBranches(cwd);
    if (!res.ok) {
      return { success: false, error: res.message || '读取分支列表失败' };
    }

    const branches = res.branches.map((b) => ({
      name: b.name,
      current: b.current,
      upstream: b.upstream,
      ahead: b.ahead,
      behind: b.behind,
      inOtherWorktree: b.inOtherWorktree,
    }));

    const lines = branches.map((b) => {
      const mark = b.current ? '*' : ' ';
      const sync =
        b.upstream == null
          ? ''
          : b.ahead || b.behind
            ? ` (ahead ${b.ahead}, behind ${b.behind})`
            : ' (in sync)';
      const wt = b.inOtherWorktree ? ' [checked out in another worktree]' : '';
      return `${mark} ${b.name}${sync}${wt}`;
    });

    return {
      success: true,
      output: lines.length ? lines.join('\n') : '（没有本地分支）',
      branches,
    };
  },
});
