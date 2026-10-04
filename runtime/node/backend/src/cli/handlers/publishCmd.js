'use strict';

/**
 * publishCmd.js — dispatch bridge for the top-level `publish` command.
 *
 * After the publish.js god-file carve-out (B1, services/domain/deploy/publish/*),
 * publish.js kept a single manifest export (`restore`), so the `publish` verb lost
 * its dispatch leg: the parser resolved `khy publish check` to command='publish'
 * (ROUTER_COMMANDS + 20+ aliases.js entries advertise it) but neither
 * commandAutoRegistry nor any router switch handled it, and the raw text fell
 * through to the AI gateway as chat. This bridge re-registers the verb against
 * the existing `handlePublish` engine — zero behavior defined here.
 */

const { MANIFEST_EXPORT_KEY } = require('../commandManifest');

module.exports = {
  [MANIFEST_EXPORT_KEY]: {
    name: 'publish',
    description: '发布流水线：检查/构建/打包/上传/源码还原/自修复',
    usage: 'publish <check|build|pypi|testpypi|docker-bundle|pip-dir-bundle|npm-dir-bundle|origin-code|git-push|self-fix|self-pypi|self-release|help> [options]',
    category: 'system',
    subCommands: [
      'check',
      'build',
      'pypi',
      'testpypi',
      'docker-bundle',
      'bundle-docker',
      'docker',
      'pip-dir-bundle',
      'bundle-pip',
      'pip-bundle',
      'pipdir',
      'npm-dir-bundle',
      'bundle-npm',
      'npm-bundle',
      'npmdir',
      'origin-code',
      'restore-origin',
      'origin',
      'git-push',
      'push-git',
      'push',
      'self-fix',
      'self-bugfix',
      'autofix',
      'self-pypi',
      'self-testpypi',
      'self-release',
      'help',
    ],
    handler: async (parsed) => {
      const { handlePublish } = require('./publish');
      return handlePublish(parsed.subCommand, parsed.args || [], parsed.options || {});
    },
  },
};
