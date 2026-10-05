'use strict';

/**
 * Handler for `khy modules` command.
 * Manages modular packaging — list, info, and build standalone executables.
 */

const fs = require('fs');
const path = require('path');
const { MANIFEST_EXPORT_KEY } = require('../commandManifest');

const chalk = require('chalk');

// handlers/ sits five levels below the repo root
// (services/backend/src/cli/handlers), same convention as handlers/docs.js.
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const MODULES_JSON = path.join(REPO_ROOT, 'works/ship/modules/modules.json');
const BUILD_SCRIPT = path.join(REPO_ROOT, 'works/ship/build/build-all.js');

/**
 * @returns {{catalog: object|null, problem?: string}} — `problem` is a finished
 * user-facing sentence, and it distinguishes "the file is not there" from "the
 * file is there but is not valid JSON": both used to print 未找到, which sent
 * users checking for a file that existed.
 */
function loadModulesCatalog() {
  let raw;
  try {
    raw = fs.readFileSync(MODULES_JSON, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { catalog: null, problem: `模块清单不存在: ${MODULES_JSON}` };
    }
    return { catalog: null, problem: `模块清单读取失败: ${MODULES_JSON} — ${err.message}` };
  }
  try {
    return { catalog: JSON.parse(raw) };
  } catch (err) {
    return {
      catalog: null,
      problem: `模块清单不是合法 JSON: ${MODULES_JSON} — ${err.message}；请修复该文件或从仓库重新拉取`,
    };
  }
}

async function handleModules(args) {
  const subCommand = args[0] || 'list';

  switch (subCommand) {
    case 'list':
      return listModules();
    case 'info':
      return infoModule(args[1]);
    case 'build':
      return buildModule(args[1]);
    default:
      console.log(chalk.yellow(`未知子命令: ${subCommand}`));
      console.log('用法: khy modules [list|info|build] [module-id]');
  }
}

function listModules() {
  const { catalog, problem } = loadModulesCatalog();
  if (!catalog) {
    console.log(chalk.red(problem));
    return;
  }

  const Table = require('cli-table3');
  const table = new Table({
    head: [
      chalk.cyan('Module ID'),
      chalk.cyan('Name'),
      chalk.cyan('Platforms'),
      chalk.cyan('Handlers'),
    ],
    style: { head: [], border: [] },
  });

  for (const mod of catalog.modules) {
    table.push([
      chalk.green(mod.id),
      mod.name,
      mod.platforms.length + ' targets',
      Array.isArray(mod.handlers)
        ? mod.handlers[0] === '*'
          ? 'ALL'
          : mod.handlers.length.toString()
        : '0',
    ]);
  }

  console.log(chalk.bold('\n  Khy OS Modules\n'));
  console.log(table.toString());
  console.log(`\n  Total: ${catalog.modules.length} modules | Version: ${catalog.version}`);
  console.log(`  Build: ${chalk.dim('khy modules build <module-id>')}\n`);
}

function infoModule(moduleId) {
  if (!moduleId) {
    console.log(chalk.yellow('用法: khy modules info <module-id>'));
    return;
  }

  const { catalog, problem } = loadModulesCatalog();
  if (!catalog) {
    console.log(chalk.red(problem));
    return;
  }

  const mod = catalog.modules.find((m) => m.id === moduleId);
  if (!mod) {
    console.log(chalk.red(`模块 "${moduleId}" 未找到。`));
    console.log('可用模块: ' + catalog.modules.map((m) => m.id).join(', '));
    return;
  }

  console.log(chalk.bold(`\n  Module: ${mod.name} (${mod.id})\n`));
  console.log(`  ${chalk.dim('Description:')} ${mod.description}`);
  console.log(`  ${chalk.dim('Entry:')}       ${mod.entry}`);
  console.log(`  ${chalk.dim('Platforms:')}   ${mod.platforms.join(', ')}`);
  console.log(
    `  ${chalk.dim('Handlers:')}    ${Array.isArray(mod.handlers) ? (mod.handlers[0] === '*' ? 'ALL' : mod.handlers.join(', ')) : 'none'}`
  );
  if (mod.excludeDeps && mod.excludeDeps.length > 0) {
    console.log(`  ${chalk.dim('Excluded:')}    ${mod.excludeDeps.join(', ')}`);
  }
  console.log('');
}

async function buildModule(moduleId) {
  const { catalog, problem } = loadModulesCatalog();
  if (!catalog) {
    console.log(chalk.red(problem));
    return;
  }

  if (moduleId && !catalog.modules.find((m) => m.id === moduleId)) {
    console.log(chalk.red(`模块 "${moduleId}" 未找到。`));
    return;
  }

  if (!fs.existsSync(BUILD_SCRIPT)) {
    console.log(chalk.red(`构建脚本不存在: ${BUILD_SCRIPT}`));
    console.log(chalk.dim('请先完成构建基础设施的搭建。'));
    return;
  }

  const { spawn } = require('child_process');
  const spawnArgs = [BUILD_SCRIPT];
  if (moduleId) {
    spawnArgs.push('--module', moduleId);
  }

  const target = moduleId || '所有模块';
  console.log(chalk.cyan(`\n  正在构建 ${target}...\n`));

  const child = spawn(process.execPath, spawnArgs, {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    windowsHide: true,
  });

  return new Promise((resolve) => {
    child.on('close', (code) => {
      if (code === 0) {
        console.log(chalk.green(`\n  构建完成: ${target}`));
      } else {
        console.log(chalk.red(`\n  构建失败，退出码 ${code}`));
      }
      resolve();
    });
  });
}

const _wrapper = (parsed) => handleModules((parsed && parsed.args) || []);
_wrapper[MANIFEST_EXPORT_KEY] = {
  name: 'modules',
  aliases: ['mod', '模块'],
  description: '模块打包管理：列表/信息/构建独立可执行文件',
  usage: 'modules <subcommand> [args]',
  category: 'dev',
  handler: _wrapper,
};
module.exports = _wrapper;
