'use strict';

/**
 * CLI Handler — Extension marketplace commands.
 *
 * Subcommands:
 *   ext list             — List installed extensions
 *   ext search <query>   — Search the registry
 *   ext install <name>   — Install from registry or URL
 *   ext uninstall <name> — Remove an extension
 *   ext enable <name>    — Enable a disabled extension
 *   ext disable <name>   — Disable without removing
 *   ext update [name]    — Update one or all extensions
 *   ext link <path>      — Link local dir for development
 *   ext new <name>       — Scaffold a new extension project
 *
 * @module handlers/extension
 */

const marketplace = require('../../services/extensionMarketplace');
const { printSuccess, printError, printInfo, printWarn, printTable } = require('../formatters');
const { MANIFEST_EXPORT_KEY } = require('../commandManifest');

async function handleExtension(input, deps) {
  const parts = (input || '').trim().split(/\s+/);
  const subcommand = parts[0] || 'list';
  const args = parts.slice(1);

  switch (subcommand) {
    case 'list':
    case 'ls':
      return _handleList();

    case 'search':
    case 'find':
      return _handleSearch(args.join(' '));

    case 'install':
    case 'add':
      return _handleInstall(args[0], args.slice(1));

    case 'uninstall':
    case 'remove':
    case 'rm':
      return _handleUninstall(args[0]);

    case 'enable':
      return _handleEnable(args[0]);

    case 'disable':
      return _handleDisable(args[0]);

    case 'update':
    case 'upgrade':
      return _handleUpdate(args[0]);

    case 'link':
      return _handleLink(args[0]);

    case 'unlink':
      return _handleUnlink(args[0]);

    case 'new':
    case 'create':
    case 'init':
      return _handleNew(args[0], args.slice(1));

    case 'info':
      return _handleInfo(args[0]);

    case 'help':
      return _printHelp();

    default:
      // 未知子命令不再静默打印帮助：先明确指出输错了什么
      printError(`未知 ext 子命令 "${subcommand}"：跑 \`ext help\` 查看全部子命令。`);
      require('../../utils/markProcessFailure')();;
      return _printHelp();
  }
}

// ── Subcommand Handlers ──

function _handleList() {
  const extensions = marketplace.list();

  if (extensions.length === 0) {
    printInfo('暂无已安装拓展。用 `ext search <关键词>` 搜索拓展市场。');
    return;
  }

  const headers = ['名称', '版本', '状态', '能力'];
  const rows = extensions.map((ext) => [
    ext.name,
    ext.version,
    ext.enabled ? '已启用' : '已禁用',
    (ext.capabilities || []).join(', ') || '-',
  ]);

  printTable(headers, rows);
  printInfo(`共 ${extensions.length} 个已安装拓展`);
}

async function _handleSearch(query) {
  if (!query) {
    printWarn('用法：ext search <关键词>');
    return;
  }

  printInfo(`搜索市场：「${query}」`);
  const results = await marketplace.search(query);

  if (results.length === 0) {
    printInfo(`未找到与「${query}」匹配的拓展。`);
    return;
  }

  const headers = ['名称', '版本', '描述', '作者'];
  const rows = results.map((r) => [
    r.name,
    r.version || '-',
    (r.description || '').substring(0, 40),
    r.author || '-',
  ]);

  printTable(headers, rows);
  printInfo(`${results.length} 条结果。安装：ext install <名称>`);
}

async function _handleInstall(source, extraArgs) {
  if (!source) {
    printWarn('用法：ext install <名称|url|路径>');
    return;
  }

  try {
    printInfo(`安装「${source}」`);

    let result;
    if (source.startsWith('http') || source.startsWith('/') || source.startsWith('.')) {
      result = marketplace.install(source);
    } else {
      // Try registry first
      result = await marketplace.installFromRegistry(source);
    }

    printSuccess(`拓展「${result.name}」安装完成`);
    if (result.version) {
      printInfo(`版本：${result.version}`);
    }
  } catch (err) {
    printError(`安装「${source}」失败：${err.message}；跑 \`ext search ${source}\` 确认名称，或检查网络后重试。`);
    require('../../utils/markProcessFailure')();;
  }
}

function _handleUninstall(name) {
  if (!name) {
    printWarn('用法：ext uninstall <名称>');
    return;
  }

  try {
    marketplace.uninstall(name);
    printSuccess(`拓展「${name}」已卸载`);
  } catch (err) {
    printError(`卸载「${name}」失败：${err.message}；跑 \`ext list\` 核对名称。`);
    require('../../utils/markProcessFailure')();;
  }
}

function _handleEnable(name) {
  if (!name) {
    printWarn('用法：ext enable <名称>');
    return;
  }

  try {
    marketplace.enable(name);
    printSuccess(`拓展「${name}」已启用`);
  } catch (err) {
    printError(`启用「${name}」失败：${err.message}；跑 \`ext list\` 核对该拓展是否存在。`);
    require('../../utils/markProcessFailure')();;
  }
}

function _handleDisable(name) {
  if (!name) {
    printWarn('用法：ext disable <名称>');
    return;
  }

  try {
    marketplace.disable(name);
    printSuccess(`拓展「${name}」已禁用（未删除，可随时 ext enable 恢复）`);
  } catch (err) {
    printError(`禁用「${name}」失败：${err.message}；跑 \`ext list\` 核对该拓展是否存在。`);
    require('../../utils/markProcessFailure')();;
  }
}

async function _handleUpdate(name) {
  try {
    if (name) {
      printInfo(`更新「${name}」`);
      const result = await marketplace.updateExtension(name);
      printSuccess(`「${result.name}」已从 ${result.oldVersion} 更新到 ${result.newVersion}`);
    } else {
      printInfo('检查全部拓展的可用更新');
      const updates = await marketplace.checkUpdates();
      const available = updates.filter((u) => u.updateAvailable);

      if (available.length === 0) {
        printSuccess(`全部 ${updates.length} 个拓展均已是最新版本`);
        return;
      }

      printInfo(`发现 ${available.length} 个可更新拓展：`);
      for (const u of available) {
        printInfo(`  ${u.name}: ${u.currentVersion} → ${u.latestVersion}`);
      }

      // Update all
      for (const u of available) {
        try {
          await marketplace.updateExtension(u.name);
          printSuccess(`已更新「${u.name}」`);
        } catch (err) {
          printError(`更新「${u.name}」失败：${err.message}；可单独重试 \`ext update ${u.name}\`。`);
          require('../../utils/markProcessFailure')();;
        }
      }
    }
  } catch (err) {
    printError(`更新失败：${err.message}；检查网络后重试，或 \`ext update <名称>\` 单独更新。`);
    require('../../utils/markProcessFailure')();;
  }
}

function _handleLink(dir) {
  if (!dir) {
    printWarn('用法：ext link <目录>');
    return;
  }

  try {
    const result = marketplace.link(dir);
    printSuccess(`已链接「${result.name}」（来源：${dir}）`);
  } catch (err) {
    printError(`链接 ${dir} 失败：${err.message}；请确认该目录含有效的拓展清单文件。`);
    require('../../utils/markProcessFailure')();;
  }
}

function _handleUnlink(name) {
  if (!name) {
    printWarn('用法：ext unlink <名称>');
    return;
  }

  try {
    marketplace.unlink(name);
    printSuccess(`已移除链接「${name}」`);
  } catch (err) {
    printError(`移除链接「${name}」失败：${err.message}；跑 \`ext list\` 核对名称。`);
    require('../../utils/markProcessFailure')();;
  }
}

function _handleNew(name, extraArgs) {
  if (!name) {
    printWarn('用法：ext new <名称> [--capabilities skill,mcp-server]');
    return;
  }

  const opts = {};
  const capIdx = extraArgs.indexOf('--capabilities');
  if (capIdx >= 0 && extraArgs[capIdx + 1]) {
    opts.capabilities = extraArgs[capIdx + 1].split(',');
  }

  try {
    const result = marketplace.scaffold(name, process.cwd(), opts);
    printSuccess(`拓展「${name}」已创建于 ${result.path}`);
    printInfo('生成的文件：');
    result.files.forEach((f) => printInfo(`  ${f}`));
    console.log('');
    printInfo('后续步骤：');
    printInfo(`  cd ${name}`);
    printInfo('  npm install');
    printInfo('  khy ext link .');
  } catch (err) {
    printError(`创建拓展「${name}」失败：${err.message}；请确认名称合法且目标目录不存在。`);
    require('../../utils/markProcessFailure')();;
  }
}

async function _handleInfo(name) {
  if (!name) {
    printWarn('用法：ext info <名称>');
    return;
  }

  // Check local first
  const installed = marketplace.list().find((e) => e.name === name);
  if (installed) {
    printInfo(`${installed.name} v${installed.version}（已安装）`);
    printInfo(`  状态：${installed.enabled ? '已启用' : '已禁用'}`);
    printInfo(`  能力：${(installed.capabilities || []).join(', ') || '无'}`);
    printInfo(`  路径：${installed.path}`);
    if (installed.description) {
      printInfo(`  描述：${installed.description}`);
    }
    return;
  }

  // Try registry
  printInfo(`查询市场中的「${name}」`);
  const info = await marketplace.getInfo(name);
  if (!info) {
    printWarn(`市场中未找到拓展「${name}」；跑 \`ext search <关键词>\` 试试模糊搜索。`);
    return;
  }

  printInfo(`${info.name} v${info.version || info.latestVersion || '?'}`);
  if (info.description) {
    printInfo(`  描述：${info.description}`);
  }
  if (info.author) {
    printInfo(`  作者：${info.author}`);
  }
  if (info.downloads) {
    printInfo(`  下载量：${info.downloads}`);
  }
  if (info.repository) {
    printInfo(`  仓库：${info.repository}`);
  }
  console.log('');
  printInfo(`安装：ext install ${name}`);
}

function _printHelp() {
  const lines = [
    '',
    '  拓展管理器',
    '  ─────────────────',
    '',
    '  ext list              列出已安装拓展',
    '  ext search <关键词>    搜索拓展市场',
    '  ext install <名称>     从市场、URL 或本地路径安装',
    '  ext uninstall <名称>   卸载拓展',
    '  ext enable <名称>      启用已禁用的拓展',
    '  ext disable <名称>     禁用（不删除）',
    '  ext update [名称]      更新单个或全部拓展',
    '  ext info <名称>        查看拓展详情',
    '  ext link <路径>        链接本地目录（开发用）',
    '  ext unlink <名称>      移除已链接的拓展',
    '  ext new <名称>         新建拓展项目骨架',
    '',
    '  选项:',
    '    --capabilities skill,mcp-server    （用于 ext new）',
    '',
  ];
  console.log(lines.join('\n'));
}

module.exports = {
  handleExtension,
  [MANIFEST_EXPORT_KEY]: {
    name: 'extension',
    aliases: ['ext'],
    description: '拓展市场：列表/搜索/安装/卸载/启用/禁用/更新/信息/链接/新建',
    usage: 'extension <list|search|install|uninstall|enable|disable|update|info|link|unlink|new>',
    subCommands: ['list', 'search', 'install', 'uninstall', 'enable', 'disable', 'update', 'info', 'link', 'unlink', 'new'],
    category: 'system',
    handler: async (parsed) => {
      const input = [parsed.subCommand, ...(parsed.args || [])].filter(Boolean).join(' ');
      await handleExtension(input, { options: parsed.options });
      return true;
    },
  },
};
