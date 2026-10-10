'use strict';

/**
 * handlers/where.js — `khy where` self-location diagnostic command.
 *
 * Prints the absolute path of the khy entry point, project root, version,
 * installation type, and Node.js runtime info. Helps disambiguate which
 * installed copy is actually running (dev / portable / npm / pip).
 */

const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const fs = require('fs');
const path = require('path');

const chalk = require('chalk');

/**
 * Detect installation type based on entry path and project markers.
 * @param {string} entryPath - Absolute path to bin/khy.js
 * @param {string} projectRoot - Absolute path to project root
 * @returns {string} Human-readable installation type label
 */
function _detectInstallType(entryPath, projectRoot) {
  const normalized = entryPath.replace(/\\/g, '/');

  // npm global install
  if (normalized.includes('node_modules')) {
    return 'npm 全局安装';
  }

  // pip install (site-packages or pyproject.toml + Python Scripts path)
  if (normalized.includes('site-packages')) {
    return 'pip 安装';
  }
  try {
    const hasPyproject = fs.existsSync(path.join(projectRoot, 'pyproject.toml'));
    const inScripts = /[/\\]Scripts[/\\]/i.test(normalized);
    if (hasPyproject && inScripts) {
      return 'pip 安装';
    }
  } catch {
    /* ignore */
  }

  // Portable edition
  if (/Portable/i.test(normalized)) {
    return '便携版';
  }
  try {
    if (fs.existsSync(path.join(projectRoot, '.portable'))) {
      return '便携版';
    }
  } catch {
    /* ignore */
  }

  // Default: dev source
  return '开发版（源码运行）';
}

/**
 * Walk up from startDir to find the true project root
 * (identified by pyproject.toml or .git).
 * Falls back to walking up for a layout marker if no direct hit.
 */
function _findProjectRoot(startDir) {
  // bin/khy.js lives at <root>/runtime/node/backend/bin/khy.js
  // startDir = <root>/runtime/node/backend/bin → root is 3 levels up
  const candidate = path.resolve(startDir, '..', '..', '..');
  // Validate: the candidate should contain the backend bin dir.
  // New layout runtime/node/backend/bin; legacy services/backend/bin.
  const check = path.join(candidate, 'runtime', 'node', 'backend', 'bin');
  const checkLegacy = path.join(candidate, 'services', 'backend', 'bin');
  if (fs.existsSync(check) || fs.existsSync(checkLegacy)) {
    return candidate;
  }
  // Fallback: walk up looking for a khy-os root marker — pyproject.toml, or the
  // platform tree in either layout (new runtime/substrate/platform, legacy platform/).
  let dir = startDir;
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (
      fs.existsSync(path.join(dir, 'pyproject.toml')) ||
      fs.existsSync(path.join(dir, 'runtime', 'substrate', 'platform')) ||
      fs.existsSync(path.join(dir, 'platform'))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return startDir;
}

/**
 * Main handler for `khy where`.
 */
function handleWhere() {
  // Entry point: bin/khy.js
  const entryPath = path.resolve(__dirname, '../../..', 'bin/khy.js');
  // Backend root (services/backend): one level up from bin/
  const backendRoot = path.resolve(entryPath, '..');
  // Project root: climb up until we find pyproject.toml or top-level marker
  const projectRoot = _findProjectRoot(backendRoot);

  // Version from package.json (try project root first, then the backend package
  // in either layout — new runtime/node/backend, legacy services/backend)
  let version = 'unknown';
  const pkgCandidates = [
    path.join(projectRoot, 'package.json'),
    path.join(projectRoot, 'runtime', 'node', 'backend', 'package.json'),
    path.join(projectRoot, 'services', 'backend', 'package.json'),
    path.join(backendRoot, '..', 'package.json'),
  ];
  for (const pkgPath of pkgCandidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.version) {
        version = pkg.version;
        break;
      }
    } catch {
      /* try next */
    }
  }

  const installType = _detectInstallType(entryPath, projectRoot);
  const nodeVersion = process.version;
  const nodeExec = process.execPath;

  console.log('');
  console.log(chalk.bold('khy where') + chalk.dim(' — 安装位置诊断'));
  console.log('');
  console.log(`  ${chalk.cyan('入口文件')}   ${entryPath}`);
  console.log(`  ${chalk.cyan('项目根目录')} ${projectRoot}`);
  console.log(`  ${chalk.cyan('版本')}       ${chalk.green('v' + version)}`);
  console.log(`  ${chalk.cyan('安装类型')}   ${installType}`);
  console.log(`  ${chalk.cyan('Node.js')}    ${nodeVersion} (${nodeExec})`);
  console.log('');
}

module.exports = {
  handleWhere,
  [MANIFEST_EXPORT_KEY]: {
    name: 'where',
    description: '自定位：入口/项目根/版本/数据家路径',
    category: 'system',
    handler: async () => { handleWhere(); return true; },
  },
};
