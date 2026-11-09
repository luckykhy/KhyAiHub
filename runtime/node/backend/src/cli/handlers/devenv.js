'use strict';

/**
 * devenv.js — `khy devenv` 命令：开发环境盘点 / 缺失清单 / 一键安装 / 清单导出导入。
 *
 * 场景（[DESIGN-ARCH-204]）：换电脑一键恢复（export → 带 JSON → import --apply）、
 * 开新项目先查再装（scan / install）、日常巡检（scan）。盘点/版本/清单/编排全部
 * 委派 services/domain/network/dependency 门面（单一真源）；本文件是薄 CLI 表层。
 *
 * 命令名不取 `env`：route() 派发里 routerDispatchSlash 的 case 'env'（打印
 * Platform/Node/CWD 环境信息）先于 commandAutoRegistry，自注册 env 会被截胡。
 *
 * 安全红线（与子系统同源）：
 *   - 安装命令仅来自 curated 表（registry / toolchainVersions），绝不取自模型/
 *     报错文本/清单文件——导入只读 depId+version 两个 token。
 *   - manual 条目（moonbit 等 script 形态）在 buildInstallPlan **之前**被
 *     assertInstallable 短路拒绝：展示安装命令供人复制，khy 绝不代跑（实测
 *     既有链不会拒，该闸由本命令强制）。
 *   - 绝不自动提权：winget/系统级安装可能弹 UAC，khy 不替用户确认。
 *
 * 门面经 `deps` 参数注入（默认真实门面）；测试注入纯内存桩，零网络零真实安装。
 */

const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const chalk = require('chalk').default || require('chalk');
const fs = require('fs');
const path = require('path');
const { printSuccess, printError, printWarn, printInfo, printTable } = require('../formatters');
const _markFailure = require('../../utils/markProcessFailure');

/** 盘点表的状态列（中文四态）。 */
function _stateLabel(entry) {
  if (entry.kind === 'informational') {
    return chalk.dim('信息');
  }
  if (entry.kind === 'manual') {
    return chalk.yellow('手动');
  }
  return entry.present ? chalk.green('已装') : chalk.red('缺失');
}

/** 安装方式列：从 registry curated 数据只读展示（不构建执行计划）。 */
function _installChannel(dep, entry, platform) {
  if (entry.kind === 'informational') {
    return '无独立运行时，无需安装';
  }
  if (entry.kind === 'manual') {
    return '官方脚本（khy 拒绝代跑，见 DEV_ENV_MANUAL_ONLY）';
  }
  const def = dep.getDependency(entry.depId) || {};
  const inst = def.install || {};
  const argv = (inst.platform && inst.platform[platform]) || inst.command || [];
  if (!argv.length) {
    return def.docsUrl || '-';
  }
  const manager = String(argv[0] || '').toLowerCase();
  if (manager === 'winget') {
    const idAt = argv.indexOf('--id');
    return `winget ${idAt >= 0 ? argv[idAt + 1] : ''}`.trim();
  }
  if (manager === 'npm') {
    return `npm -g ${argv.slice(argv.indexOf('install') + 1).filter((a) => a !== '-g').join(' ')}`.trim();
  }
  return `${manager} ${argv.slice(1).join(' ')}`.trim();
}

/** 盘点表通用渲染（scan 与 missing 共用同一份快照）。 */
function _printInventoryTable(dep, snapshot, { onlyMissing = false } = {}) {
  const platform = snapshot.platform || process.platform;
  const rows = [];
  const shown = [];
  for (const e of snapshot.entries) {
    const missingLike = e.kind === 'manual' || (e.kind !== 'informational' && !e.present);
    if (onlyMissing && !missingLike) {
      continue;
    }
    shown.push(e);
    rows.push([
      e.language,
      e.depId,
      _stateLabel(e),
      e.version || '-',
      _installChannel(dep, e, platform),
    ]);
  }
  printTable(['语言', 'depId', '状态', '版本', '安装方式'], rows);
  return shown;
}

/** 汇总尾行。 */
function _printSummary(snapshot) {
  const c = depSummarize(snapshot);
  printInfo(
    `盘点完成：共 ${c.total} 类，已装 ${c.present} · 缺失 ${c.missing} · 手动 ${c.manual} · 信息 ${c.informational}。` +
      '补装：`khy devenv install <depId>`'
  );
}

// 门面在 handler 内延迟解析（与 deps.js 同款），保证注入测试可覆盖。
let _depFacade = null;
function depFacade() {
  return _depFacade || require('../../services/dependency');
}
function depSummarize(snapshot) {
  return depFacade().summarizeInventory(snapshot);
}

/** `khy devenv scan` — 全量盘点（写 scan-latest.json 快照）。 */
async function _scan(dep, options) {
  const snapshot = await dep.scanInventory();
  if (options.json) {
    process.stdout.write(
      JSON.stringify({ snapshot, summary: dep.summarizeInventory(snapshot) }) + '\n'
    );
    return snapshot;
  }
  _printInventoryTable(dep, snapshot);
  _printSummary(snapshot);
  printInfo(`快照已缓存（可再生）：${dep.getSnapshotPath()}`);
  return snapshot;
}

/**
 * `khy devenv missing` — 缺失/手动项过滤视图。契约语义是「= scan 的过滤视图，
 * 同一份快照」：只读 scan-latest.json 过滤，不重新探测（重扫会覆写快照，
 * 且 3-10s 的全量探测对过滤视图是纯浪费）；无快照诚实提示先跑 scan。
 */
function _missing(dep, options) {
  const snapshot = dep.loadLatestSnapshot();
  if (!snapshot) {
    printError('尚未盘点：请先运行 `khy devenv scan` 生成快照（missing 是同一份快照的过滤视图，不重复探测）。');
    _markFailure();
    return;
  }
  const shown = snapshot.entries.filter(
    (e) => e.kind === 'manual' || (e.kind !== 'informational' && !e.present)
  );
  if (options.json) {
    process.stdout.write(
      JSON.stringify({
        scannedAt: snapshot.scannedAt,
        platform: snapshot.platform,
        entries: shown,
        summary: dep.summarizeInventory(snapshot),
      }) + '\n'
    );
    return;
  }
  _printInventoryTable(dep, { ...snapshot, entries: shown });
  printInfo(
    `共 ${shown.length} 项待处理（快照 ${snapshot.scannedAt}）。全量重扫：\`khy devenv scan\`。`
  );
}

/** `khy devenv install <语言名|depId>[@版本]` — 单项安装 + 装后复验。 */
async function _install(dep, spec, options) {
  if (!spec) {
    printWarn('用法:khy devenv install <语言名|depId>[@版本]  (如 jdk@17 / c / python3@3.12)');
    return;
  }
  const at = spec.indexOf('@');
  const rawName = at >= 0 ? spec.slice(0, at) : spec;
  const version = at >= 0 ? spec.slice(at + 1).trim() || null : null;
  const depId = dep.normalizeToDepId(rawName) || String(rawName).trim().toLowerCase();

  // 闸先于计划：manual/informational/未知在此拒绝，绝不 buildInstallPlan。
  const gate = dep.assertInstallable(depId);
  if (!gate.ok) {
    if (gate.code === 'DEV_ENV_MANUAL_ONLY') {
      printError(
        `${gate.message}。安装命令（供手动复制执行）：${gate.installHint || '见官方文档'}`
      );
    } else if (gate.code === 'DEV_ENV_NOT_INSTALLABLE') {
      printWarn(`${gate.message}${gate.note ? '（' + gate.note + '）' : ''}`);
    } else {
      printError(`${gate.message}（可选:${dep.listDependencyIds().join(', ')}）`);
    }
    _markFailure();
    return;
  }

  const env = dep.defaultEnv();

  // 已就绪则免装（幂等；诚实告知版本）。
  const before = dep.probe(depId);
  if (before.present && !options.force) {
    const v = await dep.probeVersion(depId);
    if (options.json) {
      process.stdout.write(JSON.stringify({ depId, alreadyPresent: true, version: v.version }) + '\n');
      return;
    }
    printSuccess(`${depId} 已就绪${v.version ? `（${v.version}）` : ''}，无需安装。加 --force 可强制重装。`);
    return;
  }

  const plan = dep.buildInstallPlan(depId, env, { version });
  if (!plan) {
    const def = dep.getDependency(depId) || {};
    printError(`${depId} 无可用安装计划（本平台无预置命令）。请参考:${def.docsUrl || '官方文档'}`);
    _markFailure();
    return;
  }

  if (!options.json) {
    printInfo(
      chalk.bold(`准备安装 ${plan.label}`) +
        (plan.version ? chalk.cyan(`  版本 ${plan.version}`) : '') +
        (plan.versionUnavailable
          ? chalk.yellow(`  (请求版本 ${plan.requestedVersion} 无预置映射，改用默认版本)`)
          : '')
    );
    console.log(`    命令:${chalk.cyan(plan.displayCommand)}`);
    if (plan.requiresElevation) {
      printWarn(
        '此为系统级安装，安装过程中可能弹出 UAC 提权确认。khyos 不会替你确认；' +
          '若因权限失败，请手动以管理员身份重跑上述命令。'
      );
    }
    console.log(`    ${chalk.dim(`正在安装 ${plan.label}（第 1/1 项）…`)}`);
  }

  const result = await dep.runInstall(plan, { cwd: env.cwd });

  // 装后复验：必须真就绪才算成功（绝不「装了就当好」）；版本同步采集。
  const after = dep.probe(depId);
  const ok = !!(result && result.ok) && after.present;
  const v = ok ? await dep.probeVersion(depId) : { version: null };

  if (options.json) {
    process.stdout.write(
      JSON.stringify({
        depId,
        version: plan.version,
        requestedVersion: plan.requestedVersion,
        versionUnavailable: plan.versionUnavailable,
        command: plan.displayCommand,
        install: result,
        verified: after.present,
        detectedVersion: v.version,
        ok,
      }) + '\n'
    );
    return;
  }

  if (ok) {
    printSuccess(
      `安装完成并已校验就绪：${plan.label}${v.version ? ' ' + v.version : ''}`
    );
    return;
  }
  if (result && result.ok && !after.present) {
    printWarn(
      `安装命令已执行，但 ${depId} 仍未探测到就绪(${after.detail || ''})。` +
        '可能需重开终端刷新 PATH,或手动确认安装位置。'
    );
    _markFailure();
    return;
  }
  if (result && result.hint) {
    printError(`安装失败:${result.hint}`);
  } else if (plan.requiresElevation) {
    printError(
      `安装失败(${(result && result.error) || 'exit-nonzero'})。系统级安装通常需提权,` +
        `请手动运行:${chalk.cyan((process.platform === 'win32' ? '' : 'sudo ') + plan.displayCommand)}`
    );
  } else {
    printError(
      `安装失败(${(result && result.error) || 'unknown'})。请检查网络/权限,或参考 ${plan.docsUrl || '官方文档'}。`
    );
  }
  _markFailure();
}

/** `khy devenv export [--out <路径>]` — 默认打印清单 JSON 到 stdout。 */
async function _export(dep, options) {
  let manifest;
  try {
    manifest = dep.buildManifestFromLatest({ now: new Date() });
  } catch (e) {
    printError(`${e.message}（先运行 \`khy devenv scan\`）`);
    _markFailure();
    return;
  }
  if (options.out) {
    const target = path.resolve(String(options.out));
    try {
      const tmp = `${target}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
      fs.renameSync(tmp, target);
    } catch (e) {
      printError(`导出失败：无法写入 ${target}（${e.message}）。请检查路径与写权限后重试。`);
      _markFailure();
      return;
    }
    const n = manifest.entries.length;
    if (options.json) {
      process.stdout.write(JSON.stringify({ exported: true, out: target, entries: n }) + '\n');
      return;
    }
    printSuccess(`已导出 ${n} 项到 ${target}`);
    return;
  }
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
}

/** `khy devenv import <清单文件> [--apply]` — 默认仅预览；--apply 才逐项安装。 */
async function _import(dep, fileArg, options) {
  if (!fileArg) {
    printWarn('用法:khy devenv import <清单文件> [--apply]');
    _markFailure();
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.resolve(String(fileArg)), 'utf8'));
  } catch (e) {
    printError(`清单读取失败：无法解析 ${fileArg}（${e.message}）。请确认文件存在且为 khy devenv export 的 JSON。`);
    _markFailure();
    return;
  }

  let plan;
  try {
    plan = await dep.previewImport(manifest, {});
  } catch (e) {
    printError(`${e.message}（清单需由 \`khy devenv export\` 生成，depId/version 之外的字段不参与执行）`);
    _markFailure();
    return;
  }

  // --json 全程机器可读（deps.js:75-78 形状）：预览段与 apply 段都绝不能混入
  // 人类可读文本，否则管道消费方解析不到纯 JSON。
  if (options.json) {
    if (!options.apply) {
      process.stdout.write(JSON.stringify(plan) + '\n');
      if (plan.unknown.length) {
        _markFailure();
      }
      return;
    }
    if (plan.unknown.length) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          state: 'failed',
          refused: plan.unknown,
          message: '存在被拒绝的未知依赖项：请修正清单后重试（本机未安装任何项）',
          plan,
        }) + '\n'
      );
      _markFailure();
      return;
    }
    // 0 项场景也走 applyImport（空 toInstall 直接 settle）：其 skipped 已并入
    // manual 条目（DEV_ENV_MANUAL_ONLY），与有安装项时的结果形状完全一致。
    const runJson = await dep.applyImport(manifest, {});
    if (runJson.failed > 0) {
      _markFailure();
    }
    process.stdout.write(JSON.stringify(runJson) + '\n');
    return;
  }

  printInfo(chalk.bold('导入预览'));
  if (plan.unknown.length) {
    printError(
      `拒绝 ${plan.unknown.length} 项（未知依赖，不在 curated 表）：${plan.unknown.join(', ')}。` +
        `可选:${dep.devCatalog.map((e) => e.depId).join(', ')}`
    );
  }
  if (plan.toInstall.length) {
    console.log(chalk.bold(`将安装 ${plan.toInstall.length} 项：`));
    for (const item of plan.toInstall) {
      console.log(
        `    ${chalk.cyan(item.depId)}${item.version ? chalk.cyan('@' + item.version) : ''}  ${item.command}` +
          (item.note ? chalk.yellow(`  (${item.note})`) : '')
      );
    }
  } else {
    console.log('    将安装 0 项');
  }
  for (const s of plan.skipped) {
    console.log(`    ${chalk.dim(`跳过 ${s.depId}：${s.reason}`)}`);
  }
  for (const m of plan.manual) {
    console.log(
      `    ${chalk.yellow(`手动 ${m.depId}：khy 拒绝代跑，请手动执行`)}${m.installHint ? chalk.dim(` — ${m.installHint}`) : ''}`
    );
  }

  if (!options.apply) {
    printInfo('预览模式：确认无误后加 --apply 执行安装。');
    if (plan.unknown.length) {
      _markFailure();
    }
    return;
  }

  if (plan.unknown.length) {
    // 拒绝项存在时不静默继续装其余项——换机恢复要的是「全对上」。
    printError('存在被拒绝的未知依赖项：请修正清单后重试（本机未安装任何项）。');
    _markFailure();
    return;
  }
  if (!plan.toInstall.length) {
    printSuccess('无需安装：清单里没有本机缺失的可安装项。');
    return;
  }

  const run = await dep.applyImport(manifest, {
    onProgress: (info) => {
      console.log(`    ${chalk.dim(info.label)}`);
    },
  });
  for (const r of run.results) {
    if (r.ok) {
      printSuccess(`${r.depId} 安装完成并已校验就绪`);
    } else if (r.installOk && !r.verified) {
      printWarn(`${r.depId} 安装命令已执行但未探测到就绪，可能需重开终端刷新 PATH 后重跑 \`khy devenv scan\` 复验`);
    } else {
      printError(`${r.depId} 安装失败（${r.error || 'unknown'}）${r.hint ? '：' + r.hint : ''}`);
    }
  }
  printInfo(`完成：成功 ${run.succeeded} · 失败 ${run.failed} · 跳过 ${run.skipped.length}`);
  if (run.failed > 0) {
    _markFailure();
  }
}

function _help() {
  printInfo('khy devenv — 开发环境盘点 / 一键安装 / 清单导出导入（换电脑一键恢复）');
  console.log('    khy devenv scan [--json]             全量盘点:已装/版本/winget 可用性,写快照');
  console.log('    khy devenv missing [--json]          只列缺失与手动项(读 scan 快照过滤,不重扫)');
  console.log('    khy devenv install <名>[@版本] [--json]');
  console.log('                                         安装单项,例 `khy devenv install jdk@17` / `install c`');
  console.log('    khy devenv export [--out <路径>] [--json]');
  console.log('                                         导出随身清单(默认打印到 stdout)');
  console.log('    khy devenv import <文件> [--apply] [--json]');
  console.log('                                         导入清单(默认仅预览,--apply 才安装)');
  console.log('    khy devenv help                      本帮助');
  console.log(
    chalk.dim('    注:语言名自动归一(c→gcc / c++→gpp / c#→dotnet / java|jdk→openjdk / js→nodejs / wasm→wabt / python→python3)。')
  );
  console.log(chalk.dim('    手动项(moonbit)只展示官方安装命令,khy 绝不代跑脚本。'));
}

/**
 * Handle the `khy devenv` command.
 * @param {string} subCommand
 * @param {string[]} args
 * @param {object} options - parsed flags ({ json, force, out, apply })
 * @param {object} [deps] - injected services/dependency facade (default: real)
 * @returns {Promise<boolean>} true (command handled)
 */
async function handleDevenv(subCommand, args = [], options = {}, deps = null) {
  if (deps) {
    _depFacade = deps;
  }
  const dep = depFacade();
  // 未在 ROUTER_SUB_COMMANDS 声明的词会落进 args[0]；peel 兜底（deps.js 先例）。
  const sub = String(subCommand || (args && args[0]) || 'scan').toLowerCase();
  const rest = subCommand ? args : args.slice(1);

  if (sub === 'help' || options.help) {
    _help();
    return true;
  }
  if (sub === 'scan') {
    await _scan(dep, options);
    return true;
  }
  if (sub === 'missing') {
    _missing(dep, options);
    return true;
  }
  if (sub === 'install') {
    await _install(dep, rest[0], options);
    return true;
  }
  if (sub === 'export') {
    await _export(dep, options);
    return true;
  }
  if (sub === 'import') {
    await _import(dep, rest[0], options);
    return true;
  }

  // 未知子命令：保守走 help,不误执行。
  printError(`未知子命令:devenv ${sub}`);
  _help();
  _markFailure();
  return true;
}

module.exports = {
  handleDevenv,
  [MANIFEST_EXPORT_KEY]: {
    name: 'devenv',
    description: '开发环境盘点/一键安装/清单导出导入（换电脑一键恢复）',
    usage: 'devenv <scan|missing|install|export|import> [--json]',
    subCommands: ['scan', 'missing', 'install', 'export', 'import', 'help'],
    category: 'dev',
    handler: async (parsed) =>
      handleDevenv(parsed.subCommand, parsed.args, parsed.options),
  },
};
