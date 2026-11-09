#!/usr/bin/env node
'use strict';

/**
 * bin/cli.js — command dispatcher.
 *
 * Commands:
 *   start [--foreground]   spawn the detached daemon (or run it in-process)
 *   stop [--force]         PID-identity-checked stop + reverse cleanup
 *   status                 read-only: config + runtime.json + /health + bridge_status
 *   doctor [--probe]       environment checks; --probe touches adb devices (read-only)
 *   call <tool> [json]     POST /v1/call via the MCP daemon client
 *   phone <alias> [json]   phone_screenshot / phone_ui_dump shortcut
 *   install [--dry-run]    register the MCP server with KhyOS (`khy mcp add`)
 *   uninstall [--dry-run]  remove the MCP registration (`khy mcp remove`)
 *
 * Global: --json --state-dir <dir> --port <n> --serial <s> --khy-js <path>
 *         --no-autostart --foreground --force --dry-run --scope user|project
 *         --timeout <ms> --probe --help --version
 *
 * Nothing here starts a real phone session on its own: `start` only launches the
 * local daemon; ADB work is attempted by the daemon and degrades if no device.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const C = require('../lib/contracts');
const {
  loadConfig,
  describeConfig,
  describeToken,
  ensureStateDirs,
  parsePort,
  parseSerial,
} = require('../lib/config');
const { createLogger } = require('../lib/logger');
const { ensureTokenFile } = require('../lib/auth');
const { readRuntime, isPidAlive, startDaemon, stopDaemon, runDaemonProcess } = require('../lib/daemon');
const mcp = require('../lib/mcp');
const adbLib = require('../lib/adb');
const khyTools = require('../lib/khy-tools');

const VERSION = C.BRIDGE_VERSION;
const DAEMON_JS = path.join(__dirname, 'daemon.js');

const COMMAND_HELP = [
  { name: 'start', args: '[--foreground]', text: '启动本机 daemon（单例；默认后台）' },
  { name: 'stop', args: '[--force]', text: '停止 daemon（核对 PID 身份，清理 reverse）' },
  { name: 'status', args: '[--json]', text: '只读：配置 + runtime + /health + bridge_status' },
  { name: 'doctor', args: '[--probe]', text: '环境自检；--probe 才读 adb devices' },
  { name: 'call', args: '<tool> [json-args]', text: '经 daemon 调用一个工具' },
  { name: 'phone', args: '<screenshot|ui-dump> [json]', text: 'phone_* 工具快捷方式' },
  { name: 'install', args: '[--scope user|project] [--dry-run]', text: '注册 MCP server（khy mcp add）' },
  { name: 'uninstall', args: '[--scope user|project] [--dry-run]', text: '移除 MCP 注册（不删手机文件）' },
];

const VALUE_FLAGS = new Set(['--state-dir', '--port', '--serial', '--khy-js', '--scope', '--timeout']);

// ── entry ───────────────────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @param {{stdout?: {write:Function}, stderr?: {write:Function}, env?: object}} [io]
 * @returns {Promise<number>} process exit code
 */
async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;

  const parsed = parseArgv(argv);

  if (parsed.help) {
    writeHelp(stdout);
    return C.EXIT_CODES.OK;
  }
  if (parsed.version) {
    stdout.write(`${VERSION}\n`);
    return C.EXIT_CODES.OK;
  }
  if (parsed.unknown.length > 0) {
    return fail(
      new C.BridgeError('invalid_request', `未知选项：${parsed.unknown[0]}`, {
        hint: '运行 khy-amoon-bridge --help 查看可用选项。',
      }),
      { json: parsed.json, stdout, stderr }
    );
  }
  if (parsed.positional.length === 0 || parsed.positional[0] === 'help') {
    writeHelp(stdout);
    return C.EXIT_CODES.OK;
  }

  const command = parsed.positional[0];
  const args = parsed.positional.slice(1);
  const flags = parsed.flags;

  let config;
  try {
    config = loadConfig({ env, stateDir: flags.stateDir || undefined });
    if (flags.port !== undefined) config.port = parsePort(String(flags.port), config.port);
    if (flags.serial !== undefined) config.serial = parseSerial(String(flags.serial));
    if (flags.khyJs !== undefined) config.khy.js = path.resolve(flags.khyJs);
  } catch (err) {
    return fail(err, { json: flags.json, stdout, stderr });
  }

  const ioCtx = { json: flags.json, stdout, stderr, env };

  try {
    switch (command) {
      case 'start':
        return await cmdStart(config, flags, ioCtx);
      case 'stop':
        return await cmdStop(config, flags, ioCtx);
      case 'status':
        return await cmdStatus(config, flags, ioCtx);
      case 'doctor':
        return await cmdDoctor(config, flags, ioCtx);
      case 'call':
        return await cmdCall(config, args, flags, ioCtx);
      case 'phone':
        return await cmdPhone(config, args, flags, ioCtx);
      case 'install':
        return await cmdInstall(config, flags, ioCtx);
      case 'uninstall':
        return await cmdUninstall(config, flags, ioCtx);
      default:
        throw new C.BridgeError('invalid_request', `未知命令：${command}`, {
          hint: '运行 khy-amoon-bridge --help 查看可用命令。',
        });
    }
  } catch (err) {
    return fail(err, ioCtx);
  }
}

// ── start / stop ────────────────────────────────────────────────────────────

async function cmdStart(config, flags, { json, stdout, stderr }) {
  if (flags.foreground) {
    await runDaemonProcess(['--state-dir', config.stateDir, '--port', String(config.port)]);
    return C.EXIT_CODES.OK;
  }

  const existing = readRuntime(config);
  if (existing && (await mcp.checkHealth(existing.port, 800))) {
    emit(json, stdout, {
      ok: true,
      command: 'start',
      data: { already_running: true, pid: existing.pid, port: existing.port, state_dir: config.stateDir },
    }, [
      `daemon 已在运行：pid=${existing.pid} port=${existing.port}`,
    ]);
    return C.EXIT_CODES.OK;
  }

  const logger = createLogger({ level: config.log.level, file: config.log.file, stderr: null });
  ensureStateDirs(config);
  ensureTokenFile({ config, logger });

  const childEnv = { ...process.env, KHY_AMOON_PORT: String(config.port) };
  if (flags.stateDir) childEnv[C.ENV.home] = config.stateDir;
  if (config.serial) childEnv[C.ENV.serial] = config.serial;
  if (config.khy.js) childEnv[C.ENV.khyJs] = config.khy.js;

  const child = spawn(process.execPath, [DAEMON_JS], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: childEnv,
  });
  child.unref();

  const deadline = Date.now() + 15000;
  let runtime = null;
  let health = false;
  while (Date.now() < deadline) {
    if (!isPidAlive(child.pid)) break;
    runtime = readRuntime(config);
    if (runtime && runtime.pid === child.pid) {
      health = await mcp.checkHealth(runtime.port, 300);
      if (health) break;
    }
    await sleep(100);
  }

  if (runtime && health) {
    emit(json, stdout, {
      ok: true,
      command: 'start',
      data: { pid: runtime.pid, port: runtime.port, state_dir: config.stateDir, health: true },
    }, [
      `daemon 已启动：pid=${runtime.pid} port=${runtime.port}`,
      `状态目录：${config.stateDir}`,
      `健康检查：http://127.0.0.1:${runtime.port}/health`,
    ]);
    return C.EXIT_CODES.OK;
  }

  const tail = tailLog(config);
  const message = isPidAlive(child.pid)
    ? `daemon 在 15s 内未写出 runtime.json 或 /health 未就绪（新进程 pid=${child.pid}）`
    : `daemon 进程启动后退出（pid=${child.pid}，exit=${child.exitCode}）`;
  throw new C.BridgeError('daemon_unavailable', message, {
    daemon_log_tail: tail,
    hint: '查看 %LOCALAPPDATA%\\khy-amoon-bridge\\daemon.log；若端口被占用可传 --port。',
  });
}

async function cmdStop(config, flags, { json, stdout }) {
  const result = await stopDaemon({ config, force: flags.force === true });
  const text =
    result.reason === 'not_running'
      ? ['daemon 未运行（没有 runtime.json）。']
      : result.reason === 'already_dead'
        ? [`runtime.json 指向的 pid=${result.pid} 已不存在，已清理残留文件。`]
        : [
            `daemon 已停止：pid=${result.pid} port=${result.port}${result.forced ? '（强制）' : ''}`,
            '已尝试移除本端口的 adb reverse（不会使用 --remove-all）。',
          ];
  emit(json, stdout, { ok: true, command: 'stop', data: result }, text);
  return C.EXIT_CODES.OK;
}

// ── status ──────────────────────────────────────────────────────────────────

async function cmdStatus(config, flags, { json, stdout }) {
  const runtime = readRuntime(config);
  let health = false;
  let bridge = null;
  let bridgeError = null;

  if (runtime) {
    health = await mcp.checkHealth(runtime.port, 800);
    if (health) {
      try {
        const client = mcp.createDaemonClient({
          config,
          logger: silentLogger(),
          autostart: false,
        });
        bridge = await client.callTool('bridge_status', { verbose: true }, { timeoutMs: 8000 });
      } catch (err) {
        bridgeError = C.isBridgeError(err) ? err.toJSON() : { code: 'internal_error', message: String(err && err.message) };
      }
    }
  }

  const data = {
    ...describeConfig(config),
    daemon: {
      running: Boolean(runtime && health),
      runtimePresent: Boolean(runtime),
      health,
      pid: runtime ? runtime.pid : null,
      port: runtime ? runtime.port : null,
      runtime,
      bridge_error: bridgeError,
    },
    bridge: bridge && bridge.ok === true ? bridge.data : null,
  };

  const text = [
    `版本: ${data.version}（${data.protocol}）`,
    `启用: ${data.enabled ? '是' : '否（KHY_AMOON_ENABLED=0）'}`,
    `状态目录: ${data.stateDir}${data.stateDirExists ? '' : '（尚未创建）'}`,
    `监听: ${data.host}:${data.port}（仅 loopback + adb reverse）`,
    `串号: ${data.serial || (data.bridge && data.bridge.adb ? data.bridge.adb.serial : null) || '（未解析）'}`,
    `operator token: ${data.security.operatorToken.present ? `存在（长度 ${data.security.operatorToken.length}${data.security.operatorToken.valid ? '' : '，过短/无效'}）` : '缺失（fail-closed）'}`,
    `手机侧 khy_ask: ${data.security.allowPhoneAsk ? '显式开启' : '默认关闭'}`,
    `daemon: ${data.daemon.running ? `运行中 pid=${data.daemon.pid} port=${data.daemon.port}` : data.daemon.runtimePresent ? 'runtime.json 存在，但 /health 不通' : '未运行'}`,
    ...(data.bridge
      ? [
          `桥状态: ${data.bridge.state}`,
          `reverse: ${data.bridge.adb && data.bridge.adb.reverse ? `${data.bridge.adb.reverse.mapped ? '已映射' : '未映射'} port=${data.bridge.adb.reverse.port}` : 'n/a'}`,
          `信箱: ${data.bridge.mailbox ? `${data.bridge.mailbox.running ? '轮询中' : '未轮询'} inflight=${data.bridge.mailbox.inflight}` : 'n/a'}`,
          `amoon→PC: ${data.bridge.capabilities.amoonToPc}（未通过 Phase 0 时不得宣称双向）`,
        ]
      : []),
    ...(bridgeError ? [`bridge_status 调用失败: [${bridgeError.code}] ${bridgeError.message}`] : []),
  ];

  emit(json, stdout, { ok: true, command: 'status', data }, text);
  return C.EXIT_CODES.OK;
}

// ── doctor ──────────────────────────────────────────────────────────────────

async function cmdDoctor(config, flags, { json, stdout }) {
  const checks = [];
  const push = (name, level, detail) => checks.push({ name, level, detail });

  const major = Number(String(process.versions.node).split('.')[0]);
  push('node', major >= 22 ? 'ok' : 'fail', `Node ${process.versions.node}${major >= 22 ? '' : '（需要 >= 22）'}`);
  push('platform', process.platform === 'win32' ? 'ok' : 'warn', `${process.platform} ${process.arch}`);
  push(
    'state_dir',
    config.stateIsDefault ? 'ok' : 'warn',
    config.stateIsDefault ? config.stateDir : `${config.stateDir}（KHY_AMOON_HOME 覆盖）`
  );

  let stateExists = false;
  try {
    stateExists = fs.statSync(config.stateDir).isDirectory();
  } catch {
    stateExists = false;
  }
  let writable = false;
  if (stateExists) {
    try {
      fs.accessSync(config.stateDir, fs.constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
  }
  push(
    'state_dir_ready',
    stateExists && writable ? 'ok' : 'warn',
    stateExists ? (writable ? '目录存在且可写' : '目录存在但不可写') : '目录尚未创建（install/start 会创建）'
  );

  const token = describeToken(config);
  push(
    'operator_token',
    token.valid ? 'ok' : 'warn',
    token.present ? `存在（长度 ${token.length}${token.valid ? '' : '，低于最小长度'}）` : '缺失；daemon 将 fail-closed'
  );

  let adbSource;
  try {
    adbSource = adbLib.selectAdbSource(config);
  } catch (err) {
    adbSource = { command: null, error: err.message };
  }
  const adbCommand = adbSource.command || 'adb';
  if (adbSource.error) {
    push('adb_command', 'fail', adbSource.error);
  } else if (path.isAbsolute(adbCommand) || adbCommand.includes('/') || adbCommand.includes('\\')) {
    push('adb_command', fs.existsSync(adbCommand) ? 'ok' : 'fail', adbCommand);
  } else {
    push('adb_command', 'warn', `${adbCommand}（未在 PATH/SDK 解析到绝对路径）`);
  }

  let khyJs = config.khy.js;
  let khySource = khyJs ? 'configured' : null;
  if (!khyJs) {
    const found = khyTools.findKhyOsInstallation({ env: process.env, extRoot: config.extRoot });
    if (found) {
      khyJs = found.khyJs;
      khySource = found.source;
    }
  }
  push(
    'khy_js',
    khyJs && fs.existsSync(khyJs) ? 'ok' : 'warn',
    khyJs ? `${khyJs}（${khySource}）` : '未找到；khy_ask 不可用（可传 --khy-js）'
  );

  const runtime = readRuntime(config);
  const health = runtime ? await mcp.checkHealth(runtime.port, 800) : false;
  push(
    'daemon',
    health ? 'ok' : 'warn',
    runtime
      ? `runtime pid=${runtime.pid} port=${runtime.port}；/health=${health ? '200' : '不可达'}`
      : '未运行（没有 runtime.json）'
  );

  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(config.extRoot, 'khy.extension.json'), 'utf8'));
    const idOk = manifest.id === path.basename(config.extRoot);
    const mainOk = typeof manifest.main === 'string' && fs.existsSync(path.join(config.extRoot, manifest.main));
    push(
      'manifest',
      idOk && mainOk ? 'ok' : 'fail',
      `id=${manifest.id} kind=${manifest.kind} main=${manifest.main}${idOk ? '' : '（id 与目录名不一致）'}`
    );
  } catch (err) {
    push('manifest', 'fail', `khy.extension.json 解析失败：${err.message}`);
  }

  push('readme', fs.existsSync(path.join(config.extRoot, 'README.md')) ? 'ok' : 'warn', 'README.md');

  if (flags.probe) {
    try {
      const logger = createLogger({ level: config.log.level, file: null, stderr: null });
      const transport = adbLib.createAdbTransport({ config, logger });
      const result = await transport.host(['devices', '-l'], { serial: false, timeoutMs: 10000 });
      if (result.exit !== 0) {
        push('adb_probe', 'fail', String(result.stderr || `退出码 ${result.exit}`).trim().slice(0, 200));
      } else {
        const devices = adbLib.parseDevices(result.stdout);
        const ready = devices.filter((d) => d.state === 'device');
        push('adb_probe', ready.length > 0 ? 'ok' : 'warn', `devices=${devices.length} device=${ready.length}`);
      }
    } catch (err) {
      push('adb_probe', 'fail', err && err.message ? err.message : String(err));
    }
  } else {
    push('adb_probe', 'warn', '未探测（加 --probe 才运行 adb devices -l；只读）');
  }

  const hasFail = checks.some((item) => item.level === 'fail');
  const data = {
    ok: !hasFail,
    checks,
    note: '未验证：真机 screencap/uiautomator/input、adb reverse 往返、Doze/锁屏、Phase 0 能力。',
  };
  const text = [
    `doctor — ${VERSION}`,
    ...checks.map((item) => `[${item.level}] ${item.name}: ${item.detail}`),
    hasFail ? '结论: 存在 fail 项。' : '结论: 基础检查通过；真机能力仍需 Phase 0/联调验证。',
  ];
  emit(json, stdout, { ok: !hasFail, command: 'doctor', data }, text);
  return hasFail ? C.EXIT_CODES.UNAVAILABLE : C.EXIT_CODES.OK;
}

// ── call / phone ────────────────────────────────────────────────────────────

async function cmdCall(config, args, flags, { json, stdout }) {
  if (args.length === 0) {
    throw new C.BridgeError('invalid_request', '用法：khy-amoon-bridge call <tool> [json-args]', {
      hint: 'Phase 1 工具：' + C.listToolNames().join(', '),
    });
  }
  const name = args[0];
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(name)) {
    throw new C.BridgeError('invalid_args', `工具名不合法：${name}`);
  }
  const toolArgs = parseInlineJson(args[1]);

  const descriptor = C.getTool(name);
  const timeoutMs =
    flags.timeout !== undefined
      ? Number(flags.timeout)
      : descriptor
        ? descriptor.timeoutMs
        : 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
    throw new C.BridgeError('invalid_args', '--timeout 必须是 1000..300000 的整数');
  }

  const client = mcp.createDaemonClient({
    config,
    logger: flags.json ? silentLogger() : createLogger({ level: config.log.level, file: null }),
    autostart: flags.noAutostart !== true,
  });
  const started = Date.now();
  const envelope = await client.callTool(name, toolArgs, { timeoutMs });
  const duration = Date.now() - started;

  emit(
    json,
    stdout,
    { ok: envelope.ok !== false, command: 'call', tool: name, duration_ms: duration, envelope },
    [
      `工具: ${name}`,
      `结果: ${envelope.ok === false ? `失败 [${envelope.error && envelope.error.code}] ${envelope.error && envelope.error.message}` : '成功'}`,
      `耗时: ${duration}ms`,
      `数据: ${JSON.stringify(envelope.data === undefined ? envelope.pending || null : envelope.data, null, 2)}`,
    ]
  );
  return envelope.ok === false ? C.EXIT_CODES.ERROR : C.EXIT_CODES.OK;
}

async function cmdPhone(config, args, flags, io) {
  if (args.length === 0) {
    throw new C.BridgeError('invalid_request', '用法：khy-amoon-bridge phone <screenshot|ui-dump> [json-args]');
  }
  const alias = {
    screenshot: 'phone_screenshot',
    'ui-dump': 'phone_ui_dump',
    ui_dump: 'phone_ui_dump',
  };
  const name = alias[args[0]] || args[0];
  if (!name.startsWith('phone_')) {
    throw new C.BridgeError('invalid_args', `phone 命令只接受 phone_* 工具：${args[0]}`);
  }
  if (C.getTool(name) === null) {
    throw new C.BridgeError('not_found', `未注册的 phone 工具：${name}（Phase 2 工具不在 Phase 1 注册）`);
  }
  return cmdCall(config, [name, ...args.slice(1)], flags, io);
}

// ── install / uninstall ─────────────────────────────────────────────────────

async function cmdInstall(config, flags, { json, stdout }) {
  const scope = normalizeScope(flags.scope);
  const logger = createLogger({ level: config.log.level, file: config.log.file, stderr: null });

  const khyJs = resolveKhyJs(config, flags);
  if (!khyJs) {
    throw new C.BridgeError('invalid_config', '未找到 KhyOS 的 khy.js；请传 --khy-js <path> 或设置 KHY_JS。');
  }

  const entry = khyTools.getMcpServerEntry({
    nodePath: process.execPath,
    extRoot: config.extRoot,
    stateDir: config.stateDir,
    khyJs,
  });
  const argv = khyTools.buildMcpAddArgv({
    nodePath: process.execPath,
    extRoot: config.extRoot,
    stateDir: config.stateDir,
    khyJs,
    scope,
  });
  const target = khyTools.resolveMcpJsonPath({ scope, env: process.env, khyJs });

  const existingRead = khyTools.readMcpJson(target.path);
  if (!existingRead.ok) {
    throw new C.BridgeError('invalid_config', `mcp.json 无法读取/已损坏，拒绝覆盖：${existingRead.error}`, {
      path: target.path,
    });
  }
  const existing = khyTools.findRegisteredServer(existingRead.data, 'amoon');

  if (existing && flags.force !== true && flags.dryRun !== true) {
    emit(json, stdout, {
      ok: false,
      command: 'install',
      data: {
        reason: 'already_registered',
        target: target.path,
        scope,
        current: khyTools.describeRegisteredServer(existing),
        hint: '已存在 amoon；加 --force 覆盖，或先 uninstall。',
      },
    }, [
      `已存在 amoon 注册（${target.path}）；未覆盖。加 --force 覆盖。`,
    ]);
    return C.EXIT_CODES.UNAVAILABLE;
  }

  const command = [process.execPath, khyJs, ...argv];
  const commandText = command.map((part) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part)).join(' ');

  if (flags.dryRun) {
    emit(json, stdout, {
      ok: true,
      command: 'install',
      dry_run: true,
      data: { target: target.path, scope, entry, argv, command: commandText, existing: Boolean(existing) },
    }, [
      `[dry-run] 将写入：${target.path}`,
      `[dry-run] 命令：${commandText}`,
    ]);
    return C.EXIT_CODES.OK;
  }

  if (existing && flags.force === true) {
    const removeArgv = khyTools.buildMcpRemoveArgv({ khyJs, scope });
    spawnSync(process.execPath, [khyJs, ...removeArgv], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  }

  // Real install only: provision the state dir and operator token now. A
  // --dry-run must not create either (it only prints the command).
  ensureStateDirs(config);
  ensureTokenFile({ config, logger });

  const result = spawnSync(process.execPath, [khyJs, ...argv], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  const ok = result.status === 0;
  emit(json, stdout, {
    ok,
    command: 'install',
    data: {
      target: target.path,
      scope,
      exit_code: result.status,
      stdout: (result.stdout || '').trim().slice(0, 4000),
      stderr: (result.stderr || '').trim().slice(0, 4000),
    },
  }, ok
    ? [`已注册 amoon（${target.path}）。`, '验收请用真实 tools/call（khy -p ...），不要用 khy mcp test。']
    : [`khy mcp add 失败（exit=${result.status}）：${(result.stderr || result.stdout || '').trim()}`]);
  return ok ? C.EXIT_CODES.OK : C.EXIT_CODES.UNAVAILABLE;
}

async function cmdUninstall(config, flags, { json, stdout }) {
  const scope = normalizeScope(flags.scope);
  const khyJs = resolveKhyJs(config, flags);
  if (!khyJs) {
    throw new C.BridgeError('invalid_config', '未找到 KhyOS 的 khy.js；请传 --khy-js <path>。');
  }
  const argv = khyTools.buildMcpRemoveArgv({ khyJs, scope });
  const command = [process.execPath, khyJs, ...argv];
  if (flags.dryRun) {
    emit(json, stdout, {
      ok: true,
      command: 'uninstall',
      dry_run: true,
      data: { scope, argv, command: command.join(' ') },
    }, [`[dry-run] 命令：${command.join(' ')}`]);
    return C.EXIT_CODES.OK;
  }
  const result = spawnSync(process.execPath, command, { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const ok = result.status === 0;
  emit(json, stdout, {
    ok,
    command: 'uninstall',
    data: {
      scope,
      exit_code: result.status,
      stdout: (result.stdout || '').trim().slice(0, 4000),
      stderr: (result.stderr || '').trim().slice(0, 4000),
    },
  }, ok ? [`已移除 amoon 注册（${scope}）。`] : [`khy mcp remove 失败（exit=${result.status}）。`]);
  return ok ? C.EXIT_CODES.OK : C.EXIT_CODES.UNAVAILABLE;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function resolveKhyJs(config, flags) {
  if (config.khy && config.khy.js && fs.existsSync(config.khy.js)) return config.khy.js;
  const found = khyTools.findKhyOsInstallation({ env: process.env, extRoot: config.extRoot });
  return found ? found.khyJs : null;
}

function normalizeScope(raw) {
  if (raw === undefined || raw === null) return 'user';
  if (raw === 'user' || raw === 'project') return raw;
  throw new C.BridgeError('invalid_args', '--scope 只能是 user 或 project');
}

function parseArgv(argv) {
  const positional = [];
  const unknown = [];
  const flags = {
    json: false,
    help: false,
    version: false,
    noAutostart: false,
    foreground: false,
    force: false,
    dryRun: false,
    probe: false,
    stateDir: undefined,
    port: undefined,
    serial: undefined,
    khyJs: undefined,
    scope: undefined,
    timeout: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (typeof raw !== 'string') continue;
    if (raw === '--json') flags.json = true;
    else if (raw === '--help' || raw === '-h') flags.help = true;
    else if (raw === '--version' || raw === '-v') flags.version = true;
    else if (raw === '--no-autostart') flags.noAutostart = true;
    else if (raw === '--foreground') flags.foreground = true;
    else if (raw === '--force') flags.force = true;
    else if (raw === '--dry-run') flags.dryRun = true;
    else if (raw === '--probe') flags.probe = true;
    else if (VALUE_FLAGS.has(raw)) {
      const value = argv[i + 1];
      if (value === undefined || (typeof value === 'string' && value.startsWith('--'))) {
        unknown.push(`${raw} <value>`);
        continue;
      }
      i += 1;
      if (raw === '--state-dir') flags.stateDir = value;
      else if (raw === '--port') flags.port = value;
      else if (raw === '--serial') flags.serial = value;
      else if (raw === '--khy-js') flags.khyJs = value;
      else if (raw === '--scope') flags.scope = value;
      else if (raw === '--timeout') flags.timeout = value;
    } else if (raw.startsWith('-')) unknown.push(raw);
    else positional.push(raw);
  }

  return { positional, unknown, flags, json: flags.json, help: flags.help, version: flags.version };
}

function parseInlineJson(raw) {
  if (raw === undefined) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new C.BridgeError('invalid_args', '第二个参数必须是 JSON 对象字符串');
  }
}

function emit(json, stdout, payload, lines) {
  if (json) {
    stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  stdout.write(`${lines.join('\n')}\n`);
}

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function tailLog(config) {
  try {
    const text = fs.readFileSync(config.log.file, 'utf8');
    return text.split('\n').filter(Boolean).slice(-20).join('\n').slice(-4000);
  } catch {
    return '';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(err, { json, stdout, stderr }) {
  const be = C.isBridgeError(err)
    ? err
    : new C.BridgeError('internal_error', err && err.message ? err.message : String(err));
  if (json) {
    stdout.write(`${JSON.stringify({ ok: false, error: be.toJSON() })}\n`);
  } else {
    stderr.write(`错误 [${be.code}]：${be.message}\n`);
    if (be.details && be.details.hint) stderr.write(`提示：${be.details.hint}\n`);
  }
  return exitCodeFor(be.code);
}

function exitCodeFor(code) {
  switch (code) {
    case 'invalid_request':
    case 'invalid_args':
    case 'invalid_config':
    case 'not_found':
      return C.EXIT_CODES.USAGE;
    case 'not_implemented':
    case 'daemon_unavailable':
    case 'adb_unavailable':
    case 'auth_unavailable':
    case 'bridge_disabled':
    case 'capability_unverified':
    case 'phone_ask_disabled':
    case 'forbidden_scope':
      return C.EXIT_CODES.UNAVAILABLE;
    default:
      return C.EXIT_CODES.ERROR;
  }
}

function writeHelp(stdout) {
  const lines = [
    `khy-amoon-bridge ${VERSION} — KhyOS ↔ 手机 amoon 桥（Phase 1）`,
    '',
    '用法:',
    '  khy-amoon-bridge <命令> [选项]',
    '  khy-amoon-bridge --help | --version',
    '',
    '命令:',
    ...COMMAND_HELP.map((c) => {
      const label = `${c.name}${c.args ? ` ${c.args}` : ''}`;
      return `  ${label.padEnd(46)}${c.text}`;
    }),
    '',
    '全局选项:',
    '  --json                机器可读输出（错误也走 stdout）',
    '  --state-dir <dir>     覆盖状态目录（默认 %LOCALAPPDATA%\\khy-amoon-bridge）',
    '  --port <n>            覆盖监听端口（默认 18765）',
    '  --serial <serial>     固定设备 serial',
    '  --khy-js <path>       KhyOS CLI 路径（khy_ask / install 用）',
    '  --no-autostart        call 时不自动启动 daemon',
    '  --foreground          start 在当前进程运行（调试）',
    '  --force               stop 跳过 PID 身份核对 / install 覆盖已有注册',
    '  --dry-run             install/uninstall 只打印命令',
    '  --scope user|project  install/uninstall 的 mcp.json 作用域',
    '  --timeout <ms>        call 的超时（1000..300000）',
    '  --probe               doctor 额外运行只读的 adb devices -l',
    '  -h, --help            显示本帮助',
    '  -v, --version         显示版本',
    '',
    '环境变量:',
    `  ${C.ENV.home}     覆盖状态目录`,
    `  ${C.ENV.port}     监听端口`,
    `  ${C.ENV.serial}   固定设备 serial`,
    `  ${C.ENV.enabled}=0  关闭桥`,
    '',
    '说明: 本 CLI 不会主动连接手机；start 只启动本机 daemon，ADB 失败会降级但 HTTP 仍可用。',
    '文档: README.md',
  ];
  stdout.write(`${lines.join('\n')}\n`);
}

module.exports = { main, parseArgv, exitCodeFor, VERSION };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`错误 [internal_error]：${err && err.message ? err.message : err}\n`);
      process.exitCode = 1;
    }
  );
}
