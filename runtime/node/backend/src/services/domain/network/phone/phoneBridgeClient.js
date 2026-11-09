'use strict';

/**
 * phoneBridgeClient.js — thin IO shell for the phone bridge (khy-os -> StepBridge).
 *
 * Outbound only. This is deliberately NOT part of src/bridge/*: that server is
 * the INBOUND direction (the phone connects to the PC over LAN with a JWT).
 * Here the PC dials the phone.
 *
 * Channel order, and why:
 *   1. `adb connect` only when the device list is empty. NEVER `adb pair` —
 *      33743 is the connect port, not a pairing port; pairing against it fails
 *      with a protocol fault. Pairing was done once by the user, out of band.
 *   2. `adb forward tcp:<local> tcp:<remote>` — idempotent, safe to re-run.
 *   3. HTTP POST /ping /status /call against the loopback forward, one socket
 *      per call (the bridge answers `Connection: close` and has no keep-alive).
 *   4. File mailbox under /sdcard/bridge-amoobridge ONLY when HTTP is dead.
 *
 * The loopback base URL is built by interpolation and never routed through
 * services/urlSafety.js assertPublicHttpUrlResolved: that guard rejects
 * loopback/private literals by design because it protects OUTBOUND calls to
 * PUBLIC hosts, and this one is a tunnel to the user's own device through adb.
 *
 * The bearer token is read from the device at call time, cached in memory for
 * the process lifetime, and never written to disk, never logged, and never
 * echoed into a result. R2.
 */

const fs = require('fs');
const http = require('node:http');
const path = require('path');
const { spawn } = require('child_process');

const { safeKill } = require('../../../../tools/platformUtils');
const {
  resolvePhoneBridgeConfig, pickDeviceSerial, pickMdnsSerial, discoveryFile,
  defaultExecutableProbe,
} = require('./phoneBridgeConfig');
const {
  buildConnectArgv,
  buildForwardArgv,
  buildTokenReadArgv,
  buildStatusReadArgv,
  buildSizeArgv,
  buildStatArgv,
  buildPullArgv,
  buildPushArgv,
  buildMkdirArgv,
  buildReviveArgv,
  classifyBridgeCall,
  planBridgeCall,
  normalizeToken,
  isValidTokenShape,
  redactSecrets,
  buildAdbArgv,
} = require('./phoneBridgePolicy');
const { createPhoneBridgeMailbox } = require('./phoneBridgeMailbox');
const { truncateBridgeResultText, isPhoneBridgeUiToolName, ACCESS_READ, uiToolResultFieldCap, ASSISTANT_RELAY_TOOL_NAMES } = require('./phoneBridgeCatalog');
const { PHONE_BRIDGE_MAX_TRANSFER_BYTES, PHONE_BRIDGE_MAX_COLLECT_FILES, PHONE_BRIDGE_MAX_COLLECT_BYTES } = require('../../../../constants/serviceDefaults');
const collect = require('./phoneCollect');

const DEVICE_STATE_DEVICE = 'device';
const MAX_ADB_OUTPUT_CHARS = 64 * 1024;
const HTTP_PATHS = Object.freeze({ ping: '/ping', status: '/status', call: '/call' });

// 空 serial（未设 env、自动探测也没命中）时走两条路：拼出来的 `adb connect ''` 与
// 多设备时的设备串，都能把人的引号错到别的设备上去；所以直接报「未发现手机」。
const DEVICE_NOT_FOUND_ERROR =
  '未发现手机：adb 设备表为空，mDNS 也没有 _adb-tls-connect 实例。'
  + '请确认手机与电脑在同一局域网、无线调试已开启且此前完成过一次配对；'
  + '本机可用 `adb mdns services` 查看手机广播的连接实例，再重试。';

function _parentGateEnabled(env = process.env) {
  try {
    return require('../../../../utils/flagRegistry').isFlagEnabled('KHY_PHONE_BRIDGE', env);
  } catch {
    const raw = env && env.KHY_PHONE_BRIDGE;
    if (raw === undefined || raw === null) {
      return true;
    }
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

function _mailboxGateEnabled(env = process.env) {
  try {
    return require('../../../../utils/flagRegistry').isFlagEnabled('KHY_PHONE_BRIDGE_MAILBOX', env);
  } catch {
    const raw = env && env.KHY_PHONE_BRIDGE_MAILBOX;
    if (raw === undefined || raw === null) {
      return true;
    }
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

function _truncate(text) {
  const input = String(text ?? '');
  if (input.length <= MAX_ADB_OUTPUT_CHARS) {
    return input;
  }
  return `${input.slice(0, MAX_ADB_OUTPUT_CHARS)}\n...[adb 输出已截断]`;
}

/**
 * Default adb transport. argv arrays only — never a shell string, so nothing in
 * a device path can be reinterpreted by the PC's shell. Termination goes through
 * AbortSignal (spawn's own `signal` option) rather than a local setTimeout, so
 * there is exactly one deadline owner and no timer that outlives the call.
 */
function createAdbTransport(options = {}) {
  const adbExecutable = options.adbExecutable || 'adb';
  const defaultTimeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10000;
  const spawnImpl = options.spawn || spawn;
  const killImpl = options.safeKill || safeKill;
  const signalFactory =
    typeof options.signalFactory === 'function'
      ? options.signalFactory
      : (ms) => AbortSignal.timeout(ms);

  /**
   * Wires one spawned child to a single resolve. Kept out of run() so the
   * deadline owner (the guard timer) and the settle path stay adjacent and
   * idempotent — a late 'close' after an abort must not overwrite the result.
   */
  function _collectOnce(spawnImpl, adbExecutable, args, timeoutMs, resolve) {
    let child;
    try {
      child = spawnImpl(adbExecutable, args, {
        windowsHide: true,
        signal: signalFactory(timeoutMs),
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String((err && err.message) || err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let settled = false;
    const finish = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(guard);
      resolve({
        ok: code === 0 && !aborted,
        code: aborted ? -1 : code,
        stdout: _truncate(stdout),
        stderr: _truncate(stderr),
        aborted,
      });
    };
    if (child && child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
    }
    if (child && child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
    }
    child.on('error', (err) => {
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
        aborted = true;
        finish(-1);
        return;
      }
      stderr += `${(err && err.message) || err}\n`;
      finish(-1);
    });
    child.on('close', (code) => {
      finish(typeof code === 'number' ? code : -1);
    });
    // Defensive: a transport that ignores `signal` still must not outlive the
    // deadline. The guard is deliberately NOT unref'd — an awaited call keeps
    // the loop alive by design, and clearing it in finish() means it never
    // leaks past a resolved call.
    const guard = setTimeout(() => {
      aborted = true;
      try {
        killImpl(child, 'SIGTERM', 1000);
      } catch {
        /* already gone */
      }
      finish(-1);
    }, timeoutMs + 500);
  }

  function run(argv, runOptions = {}) {
    const timeoutMs = Number(runOptions.timeoutMs) > 0 ? Number(runOptions.timeoutMs) : defaultTimeoutMs;
    const args = Array.isArray(argv) ? argv.map((value) => String(value)) : [];
    return new Promise((resolve) => {
      _collectOnce(spawnImpl, adbExecutable, args, timeoutMs, resolve);
    });
  }

  return {
    run,
    async push(localPath, remotePath) {
      const res = await run(['push', String(localPath), String(remotePath)]);
      return res.ok
        ? { ok: true }
        : { ok: false, error: redactSecrets(res.stderr || res.stdout || 'adb push 失败') };
    },
  };
}

/**
 * Default HTTP transport. node:http rather than fetch so the request is
 * unambiguously one-shot: no keep-alive agent, explicit Content-Length (the
 * bridge reads bodies strictly by content-length and rejects chunked), and the
 * deadline rides on AbortSignal.
 */
function createHttpTransport(options = {}) {
  const requestImpl = options.request || http.request;
  const agent = options.agent || new http.Agent({ keepAlive: false, maxSockets: 1 });
  const defaultTimeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10000;
  const signalFactory =
    typeof options.signalFactory === 'function'
      ? options.signalFactory
      : (ms) => AbortSignal.timeout(ms);

  function _readResponse(res, resolve) {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      raw += String(chunk);
    });
    res.on('end', () => {
      resolve({ status: res.statusCode || 0, body: raw, ok: (res.statusCode || 0) === 200 });
    });
  }

  function request({ method = 'POST', url, headers = {}, body = '', timeoutMs }) {
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : defaultTimeoutMs;
    const payload = typeof body === 'string' ? body : JSON.stringify(body || {});
    return new Promise((resolve) => {
      let req;
      try {
        req = requestImpl(
          url,
          {
            method,
            agent,
            headers: {
              ...headers,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload, 'utf8'),
              Connection: 'close',
            },
            signal: signalFactory(ms),
          },
          (res) => _readResponse(res, resolve)
        );
      } catch (err) {
        resolve({ status: 0, body: '', ok: false, error: String((err && err.message) || err) });
        return;
      }
      req.on('error', (err) => {
        const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
        resolve({
          status: 0,
          body: '',
          ok: false,
          error: aborted ? `HTTP 请求 ${ms}ms 超时` : String((err && err.message) || err),
        });
      });
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  return { request };
}

function _parseDeviceList(stdout) {
  const states = new Map();
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('List of devices') || line.startsWith('* daemon')) {
      continue;
    }
    // 无线调试的 mDNS 实例名自带空格（"adb-XXX (2)._adb-tls-connect._tcp"），
    // 按空白切 [serial, state] 会把这类条目切成非法状态而丢掉。行尾最后一个
    // 词才是状态，serial 是它前面的整段（本解析只吃 `adb devices` 的输出）。
    const tokens = line.split(/\s+/);
    if (tokens.length === 1) {
      states.set(tokens[0], 'unknown');
      continue;
    }
    const serial = tokens.slice(0, tokens.length - 1).join(' ');
    const state = tokens[tokens.length - 1];
    if (serial) {
      states.set(serial, state || 'unknown');
    }
  }
  return states;
}

const MDNS_CONNECT_SERVICE = '_adb-tls-connect._tcp.';
const MDNS_IP_PORT_SHAPE = /^[\d.]+:\d+$/;

/**
 * `adb mdns services` 里可连接的实例。只收 `_adb-tls-connect`——配对实例
 * (`_adb-tls-pairing`) 是配对档口，对它跑 `adb pair` 会 protocol fault，
 * 本单元绝不配对（配对由用户在仓外一次性完成）。
 *
 * 返回 [{ instance, address }]；address 只接受 IPv4:port。
 */
function _parseMdnsConnectServices(stdout) {
  const out = [];
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.includes(MDNS_CONNECT_SERVICE)) {
      continue;
    }
    const parts = line.split(/\s+/);
    const address = parts[parts.length - 1] || '';
    if (!MDNS_IP_PORT_SHAPE.test(address)) {
      continue;
    }
    out.push({ instance: parts[0], address });
  }
  return out;
}

/**
 * 助手协同组（Amoo 反代）的可用性三态，只认桥自报的 status.json：
 * - withheld 里出现 relay 名 → 缺对应 App → 不可用（false），并把 withheld 原样透出；
 * - withheld 为空但有 tools → 全部 relay 工具都在 → 可用（true）；一个都不在 → false；
 * - 两个字段都没有（旧版桥）→ 未知（null），不把「没报到」说成「缺 App」。
 * @param {object|null} parsed status.json 的解析结果
 * @returns {{available: boolean|null, withheld: string[]|null}}
 */
function _relayAvailability(parsed) {
  const withheld = parsed && Array.isArray(parsed.withheld)
    ? parsed.withheld.map((name) => String(name))
    : null;
  const toolsArr = parsed && Array.isArray(parsed.tools)
    ? parsed.tools.map((name) => String(name))
    : null;
  if (withheld) {
    return {
      available: withheld.some((name) => ASSISTANT_RELAY_TOOL_NAMES.includes(name)) ? false : true,
      withheld,
    };
  }
  if (toolsArr) {
    const present = ASSISTANT_RELAY_TOOL_NAMES.filter((name) => toolsArr.includes(name));
    let available = null;
    if (present.length === ASSISTANT_RELAY_TOOL_NAMES.length) {
      available = true;
    } else if (present.length === 0) {
      available = false;
    }
    return { available, withheld };
  }
  return { available: null, withheld };
}

function createPhoneBridgeClient(options = {}) {
  const env = options.env || process.env;
  // SDK 位置候选要真的被探测：纯叶子自己零 IO，能传真探针的只有这层 IO 壳。
  // 缺了它，adb 不在 PATH 时 resolve 只会给出裸名 → `spawn adb.exe ENOENT`。
  const config = options.config || resolvePhoneBridgeConfig(env, {
    // The shared probe, not an inline copy: a second consumer (stepneoCloud)
    // resolves adb the same way to run `adb logcat`, and two inline probes drift.
    hasExecutable: options.hasExecutable || defaultExecutableProbe,
  });  const adbTransport =
    options.adbTransport
    || createAdbTransport({
      adbExecutable: config.adbExecutable,
      timeoutMs: config.adbTimeoutMs,
      spawn: options.spawn,
      safeKill: options.safeKill,
      signalFactory: options.signalFactory,
    });
  const httpTransport =
    options.httpTransport
    || createHttpTransport({ timeoutMs: config.httpTimeoutMs, signalFactory: options.signalFactory });
  const mailbox = createPhoneBridgeMailbox({
    config,
    transport: adbTransport,
    fs: options.fs,
    os: options.os,
    path: options.path,
    now: options.now,
    sleep: options.sleep,
    createId: options.createId,
  });
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleep = typeof options.sleep === 'function' ? options.sleep : (ms) => new Promise((r) => {
    setTimeout(r, ms);
  });

  const state = {
    connected: false,
    lastConnectAttemptAt: null,
    lastConnectError: null,
    forwardReady: false,
    tokenLoaded: false,
    tokenLength: 0,
    lastHttpOkAt: null,
    lastHttpError: null,
    lastChannel: null,
    lastBridgeStatus: null,
    autoSerial: null,
    totalCalls: 0,
  };

  let token = '';
  let connectInFlight = null;
  // 自动档每次进程只探测一轮：连上后 state.connected 短路，force 重连也不重复
  // spawn adb mdns。
  let autoDetectDone = false;

  function _gateBlocked() {
    if (_parentGateEnabled(env)) {
      return null;
    }
    return {
      ok: false,
      code: 'bridge_disabled',
      error: '手机桥接未启用（KHY_PHONE_BRIDGE=0）。开启后重试。',
    };
  }

  async function _runAdb(argv, timeoutMs) {
    return adbTransport.run(argv, { timeoutMs: timeoutMs || config.adbTimeoutMs });
  }

  async function listDevices() {
    const res = await _runAdb(['devices']);
    if (!res.ok) {
      return { ok: false, error: redactSecrets(res.stderr || 'adb devices 执行失败') };
    }
    const map = _parseDeviceList(res.stdout);
    return { ok: true, devices: Array.from(map.entries()).map(([serial, deviceState]) => ({ serial, state: deviceState })) };
  }

  function _writeBackSerial(serial, source) {
    // 写回既有 PC 配置真源：本单元串行号的真源是 KHY_PHONE_BRIDGE_SERIAL 这道
    // env（serviceDefaults 只兜底常量），client 持有的 config 又是连接/转发/
    // 调用与 getState 展示共用的解析结果——两处写同一值，全链一致。env 是
    // 进程级的：新进程连接前重新探测，机器本地值绝不写进仓库。
    config.serial = serial;
    // 探测出来的值不再算「默认档」：展示层据此说「自动探测」，也不会触发第二轮。
    config.serialSource = 'auto';
    env.KHY_PHONE_BRIDGE_SERIAL = serial;
    state.autoSerial = { serial, source, detectedAt: new Date(now()).toISOString() };
    _publishDiscovery(serial, source);
    return true;
  }

  /**
   * 把探测结果广播给同机的另一条桥（KhyOS ↔ amoon）。
   *
   * 两条桥各自做 adb 发现，但看的是同一台手机；amoon 桥读这份文件作为
   * 「环境显式指定」之外的兜底候选。写的是运行时状态目录（gitignored），
   * 不是产品配置——谁都不依赖谁先启动，文件缺失时两边都退回自己的探测。
   * 失败一律吞掉：广播是加强，不是主路径。
   */
  function _publishDiscovery(serial, source) {
    const file = discoveryFile();
    if (!file) {
      return;
    }
    try {
      fs.mkdirSync(require('path').dirname(file), { recursive: true });
      const payload = {
        schema: 'khy-phone-discovery/1',
        serial,
        source,
        adb: config.adbExecutable,
        httpPort: config.httpPort,
        detectedAt: new Date(now()).toISOString(),
        by: 'khy-phone',
      };
      fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch {
      /* 广播失败不影响连接本身 */
    }
  }

  /**
   * 让直接跑 adb 的命令（probe / revive）在 serial 还是旧默认时先探测一轮。
   * status / ping / call 走 ensureForward → ensureConnected，已覆盖；probe 与
   * revive 不接这一步就会拿旧默认 serial 报 `device not found`——实机形态。
   */
  async function _ensureSerialAdopted() {
    if (autoDetectDone) {
      return;
    }
    if ((config.serialSource || 'env') !== 'default') {
      autoDetectDone = true;
      return;
    }
    const listed = await listDevices();
    await _adoptAutoSerial({ devices: listed.ok ? listed.devices : null });
  }

  /**
   * 只读的 serial 探测：设备表优先、mdns 兜底、env 显式指定永远赢。
   * status / connect / setup 的展示层用它取「实际会用的 serial」——各自
   * 重新 resolve 一份 config 会拿到写回之前的旧默认值。
   */
  async function detectSerial() {
    const blocked = _gateBlocked();
    if (blocked) {
      return blocked;
    }
    await _ensureSerialAdopted();
    return {
      ok: true,
      serial: config.serial,
      serialSource: config.serialSource || 'env',
      autoSerial: state.autoSerial,
    };
  }

  /**
   * 自动档接线。serial 不是 env 显式指定（serialSource === 'default'）时，
   * 在第一次连接前探测一轮：`adb devices` 的 device 态条目优先（按物理身份
   * 去重、IP 形态优先），`adb mdns services` 的 `_adb-tls-connect` 实例兜底
   * （手机在局域网里、还没被 adb connect 过的那一档）。命中唯一物理设备就
   * 写回 PC 配置真源；env 显式指定永远赢；绝不 `adb pair`，多台真机不猜
   * （多候选列名要求 -s，由 buildAdbArgv 统一加）。
   */
  async function _adoptAutoSerial({ devices = null } = {}) {
    if (autoDetectDone) {
      return false;
    }
    autoDetectDone = true;
    if ((config.serialSource || 'env') !== 'default') {
      return false;
    }
    if (Array.isArray(devices)) {
      const picked = pickDeviceSerial({ devices });
      if (picked.ok && picked.serial === config.serial) {
        return false;
      }
      if (picked.ok) {
        return _writeBackSerial(picked.serial, picked.source);
      }
      if (picked.source !== 'none') {
        // 多台真机：不猜；mdns 也解不了歧义。
        return false;
      }
    }
    // devices 表没有任何 device 态条目（或 adb devices 本身没跑成）：mdns 兜底档。
    const mdnsRes = await _runAdb(['mdns', 'services']);
    if (!mdnsRes.ok) {
      return false;
    }
    const services = _parseMdnsConnectServices(mdnsRes.stdout);
    const picked = pickMdnsSerial(services.map((entry) => entry.address));
    if (picked.ok && picked.serial && picked.serial !== config.serial) {
      return _writeBackSerial(picked.serial, picked.source);
    }
    return false;
  }

  async function _attemptConnect() {
    state.lastConnectAttemptAt = new Date(now()).toISOString();
    const listed = await listDevices();
    if (listed.ok) {
      // 自动档：serial 来自旧默认时，趁设备表在手先探测一轮，命中就写回——
      // 写回后紧接着的这次查找直接命中，一轮 adb 不多跑。
      await _adoptAutoSerial({ devices: listed.devices });
      const hit = listed.devices.find((d) => d.serial === config.serial);
      if (hit && hit.state === DEVICE_STATE_DEVICE) {
        state.connected = true;
        state.lastConnectError = null;
        return { ok: true, connected: true, reused: true };
      }
    }
    // Never `adb pair`: this serial's port is the CONNECT port. Pairing
    // against it fails with a protocol fault and pairs nothing.
    //
    // 空 serial：adoptAutoSerial 没命中，config.serial 仍是空的。此时
    // `adb connect ''`（或多设备时设备串）能把人的引号错到别的设备上去，
    // 直接报「未发现手机」，不猜。
    if (!config.serial) {
      state.connected = false;
      state.lastConnectError = DEVICE_NOT_FOUND_ERROR;
      return { ok: false, code: 'device_not_found', error: DEVICE_NOT_FOUND_ERROR };
    }
    const res = await _runAdb(buildConnectArgv(config));
    const stdout = String(res.stdout || '');
    if (!res.ok || /cannot connect|failed|refused|error/i.test(stdout)) {
      state.connected = false;
      state.lastConnectError = redactSecrets(res.stderr || stdout || 'adb connect 失败');
      // serial 来自旧默认（另一台机器的地址）时，说「没找到设备」而不是
      // 「连不上 <过期地址>」——后者会让人以为自己的手机坏了。
      if ((config.serialSource || 'env') === 'default') {
        return {
          ok: false,
          code: 'device_not_found',
          error: DEVICE_NOT_FOUND_ERROR,
        };
      }
      return {
        ok: false,
        code: 'adb_connect_failed',
        error: `无法连接手机 ${config.serial}：${state.lastConnectError}。`
          + '请确认手机与电脑在同一局域网、无线调试已开启，且该设备此前已完成配对。',
      };
    }
    state.connected = true;
    state.lastConnectError = null;
    return { ok: true, connected: true, connected_now: true };
  }

  /**
   * Connects only when the serial is absent from the device list. Re-running
   * `adb connect` against an already-attached device is harmless but noisy, and
   * a stale `connected` in adb's own table is the one case where the list can
   * still lie — hence the explicit state check.
   */
  async function ensureConnected(options_ = {}) {
    const blocked = _gateBlocked();
    if (blocked) {
      return blocked;
    }
    const force = options_.force === true;
    if (state.connected && !force && !connectInFlight) {
      return { ok: true, connected: true, reused: true };
    }
    if (connectInFlight) {
      return connectInFlight;
    }
    connectInFlight = _attemptConnect();
    try {
      return await connectInFlight;
    } finally {
      connectInFlight = null;
    }
  }

  /**
   * adb forward is idempotent: re-running it just rebinds the same pair.
   */
  async function ensureForward() {
    const connected = await ensureConnected();
    if (!connected.ok) {
      return connected;
    }
    // adb forward is idempotent, but re-running it costs a process spawn on
    // every call. Once the pair is bound it stays bound until the device drops,
    // so only re-establish it after a connect or a revive.
    if (state.forwardReady) {
      return { ok: true, localPort: config.localPort, remotePort: config.httpPort, reused: true };
    }
    const argv = buildForwardArgv(config, config.localPort, config.httpPort);
    const res = await _runAdb(argv, Math.min(config.adbTimeoutMs, 8000));
    if (!res.ok) {
      state.forwardReady = false;
      return {
        ok: false,
        code: 'adb_forward_failed',
        error: `无法建立端口转发 tcp:${config.localPort} -> tcp:${config.httpPort}：`
          + redactSecrets(res.stderr || res.stdout || 'adb forward 失败'),
      };
    }
    state.forwardReady = true;
    return { ok: true, localPort: config.localPort, remotePort: config.httpPort };
  }

  /**
   * Reads the bearer token off the device and caches it for the process
   * lifetime. The token is re-read only on demand: it survives app restarts
   * (MANAGE_EXTERNAL_STORAGE keeps /sdcard/bridge-amoobridge writable) but is
   * regenerated on reinstall.
   */
  async function readToken(force = false) {
    const blocked = _gateBlocked();
    if (blocked) {
      return blocked;
    }
    if (token && !force) {
      return { ok: true, cached: true };
    }
    const res = await _runAdb(buildTokenReadArgv(config, config.tokenRemotePath));
    if (!res.ok) {
      return {
        ok: false,
        code: 'token_read_failed',
        error: `读取手机桥接 token 失败（${config.tokenRemotePath}）。`
          + '请确认 khy-os App 已安装并启动过至少一次，且已授予「所有文件访问」。',
      };
    }
    const candidate = normalizeToken(res.stdout);
    if (!isValidTokenShape(candidate)) {
      return {
        ok: false,
        code: 'token_invalid',
        error: '手机上的 token 文件内容不是 32 位十六进制字符串；请重启桥应用后重试。',
      };
    }
    token = candidate;
    state.tokenLoaded = true;
    state.tokenLength = token.length;
    return { ok: true, cached: false };
  }

  /**
   * 把设备上的一个文件拉到主机。这是唯一能把图片/视频/音频/JSON 搬进主机的通道
   * （桥的 HTTP 面只回文本），所以先问体积再动手：超限就说清多大、限额多少，
   * 而不是拉到一半才失败。
   */
  async function pullFile(options = {}) {
    const remotePath = String(options.remotePath || '').trim();
    const localPath = String(options.localPath || '').trim();
    const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : PHONE_BRIDGE_MAX_TRANSFER_BYTES;
    if (!remotePath.startsWith('/')) {
      return { ok: false, code: 'invalid_path', error: `设备侧路径必须是绝对路径：${remotePath || '(空)'}` };
    }
    if (!localPath) {
      return { ok: false, code: 'invalid_path', error: '缺少主机侧目标路径' };
    }
    const started = await ensureConnected();
    if (!started.ok) {
      return started;
    }
    const sizeRes = await _runAdb(buildSizeArgv(config, remotePath), 10000);
    let bytes = null;
    if (sizeRes.ok) {
      const matched = /(\d+)/.exec(String(sizeRes.stdout || ''));
      if (matched) {
        bytes = Number(matched[1]);
      }
    }
    if (bytes !== null && bytes > maxBytes) {
      return {
        ok: false,
        code: 'too_large',
        error: `文件 ${remotePath} 有 ${(bytes / 1048576).toFixed(1)} MB，超过单次上限 `
          + `${(maxBytes / 1048576).toFixed(0)} MB；调 KHY_PHONE_BRIDGE_MAX_TRANSFER_BYTES 或换小文件。`,
      };
    }
    // 拉取耗时随体积走：按 1 MB/s 估，再加 adb 自身超时。视频比 token 大两个数量级，
    // 固定短超时会把大文件判死。
    const timeoutMs = Math.max(config.adbTimeoutMs, 60000)
      + (bytes ? Math.ceil(bytes / (1024 * 1024)) * 1000 : 0);
    const pulled = await _runAdb(buildPullArgv(config, remotePath, localPath), timeoutMs);
    if (!pulled.ok) {
      return {
        ok: false,
        code: 'adb_pull_failed',
        error: `拉取 ${remotePath} 失败：${redactSecrets(pulled.stderr || pulled.stdout || 'adb pull 失败')}`,
      };
    }
    let landed = null;
    try {
      landed = fs.statSync(localPath).size;
    } catch {
      landed = null;
    }
    return { ok: true, remotePath, localPath, bytes: landed === null ? bytes : landed };
  }

  /**
   * 问一次文件的大小与修改时间。stat 一次给两个字段；老设备没有 stat 就退回
   * wc -c（只有大小，mtime 记为未知——时间窗筛不了，但不假装筛过）。
   */
  async function _fileMeta(remotePath) {
    const statRes = await _runAdb(buildStatArgv(config, remotePath), 10000);
    if (statRes.ok) {
      const matched = /(\d+)\s+(\d+)/.exec(String(statRes.stdout || ''));
      if (matched) {
        return { bytes: Number(matched[1]), mtimeMs: Number(matched[2]) * 1000 };
      }
    }
    const sizeRes = await _runAdb(buildSizeArgv(config, remotePath), 10000);
    if (sizeRes.ok) {
      const matched = /(\d+)/.exec(String(sizeRes.stdout || ''));
      if (matched) {
        return { bytes: Number(matched[1]), mtimeMs: null };
      }
    }
    return { bytes: null, mtimeMs: null };
  }

  /**
   * 只枚举不下载：先看有什么，再决定采不采（视频动辄几百 MB，先看清单更稳）。
   * 与 collectFiles 共用同一条枚举路径——两条命令看到的必须是同一批文件。
   */
  async function scanFiles(options = {}) {
    const remoteDir = String(options.remoteDir || '').trim();
    const types = Array.isArray(options.types) ? options.types : [];
    if (!remoteDir.startsWith('/')) {
      return { ok: false, code: 'invalid_path', error: `设备侧目录必须是绝对路径：${remoteDir || '(空)'}` };
    }
    const started = await ensureConnected();
    if (!started.ok) {
      return started;
    }
    const findRes = await _runAdb(collect.buildFindArgv(config, remoteDir), config.adbTimeoutMs);
    if (!findRes.ok) {
      return {
        ok: false,
        code: 'adb_find_failed',
        error: `枚举 ${remoteDir} 失败：${redactSecrets(findRes.stderr || findRes.stdout || 'adb shell find 失败')}`,
      };
    }
    const found = String(findRes.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const wanted = new Set(
      (types.length ? types : collect.TYPE_NAMES)
        .map((t) => String(t).toLowerCase())
        .filter((t) => collect.TYPE_NAMES.includes(t)),
    );
    const skipped = [];
    const sized = [];
    for (const candidate of collect.listCandidates({ paths: found, remoteDir, maxDepth: options.maxDepth })) {
      // 类型没点名或压根不认识的文件也要进清单：用户要知道「枚举到几个、采了几个」。
      if (!candidate.type) {
        skipped.push({ remotePath: candidate.remotePath, reason: 'unknown-type' });
        continue;
      }
      if (!wanted.has(candidate.type)) {
        skipped.push({ remotePath: candidate.remotePath, reason: 'type-not-requested', type: candidate.type });
        continue;
      }
      sized.push({ ...candidate, ...(await _fileMeta(candidate.remotePath)) });
    }
    const sinceMs = Number.isFinite(Number(options.sinceMs)) ? Number(options.sinceMs) : null;
    const window = collect.filterBySince(sized, sinceMs);
    for (const item of window.dropped) {
      skipped.push({ remotePath: item.remotePath, reason: 'older-than-window', mtimeMs: item.mtimeMs });
    }
    const counts = {};
    for (const item of window.kept) {
      counts[item.type] = (counts[item.type] || 0) + 1;
    }
    return {
      ok: true,
      entries: window.kept,
      skipped,
      counts,
      sinceMs,
      sinceUnknown: window.unknown,
    };
  }

  /**
   * 按类型批量采集：设备上枚举 → 筛类型 → 逐个拉 → 落清单。
   *
   * 单文件上限管不住「200 个大文件」，所以文件数与总字节数各有一道闸；被跳过的
   * 也要写进清单（skip 原因），否则用户以为采全了。
   */
  async function collectFiles(options = {}) {
    const remoteDir = String(options.remoteDir || '').trim();
    const localDir = String(options.localDir || '').trim();
    const types = Array.isArray(options.types) ? options.types : [];
    const maxFiles = Number(options.maxFiles) > 0
      ? Number(options.maxFiles)
      : PHONE_BRIDGE_MAX_COLLECT_FILES;
    const maxTotal = Number(options.maxTotalBytes) > 0
      ? Number(options.maxTotalBytes)
      : PHONE_BRIDGE_MAX_COLLECT_BYTES;
    const maxPerFile = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : PHONE_BRIDGE_MAX_TRANSFER_BYTES;
    if (!remoteDir.startsWith('/')) {
      return { ok: false, code: 'invalid_path', error: `设备侧目录必须是绝对路径：${remoteDir || '(空)'}` };
    }
    if (!localDir) {
      return { ok: false, code: 'invalid_path', error: '缺少主机侧目录' };
    }
    const started = await ensureConnected();
    if (!started.ok) {
      return started;
    }
    // 先把主机侧目录建好：adb pull 不会替我们建父目录。
    try {
      fs.mkdirSync(localDir, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        code: 'local_dir_failed',
        error: `主机侧目录建不出来：${localDir}（${err && err.message ? err.message : '未知错误'}）`,
      };
    }
    const scan = await scanFiles({
      remoteDir,
      types,
      sinceMs: options.sinceMs,
      maxDepth: options.maxDepth,
    });
    if (!scan.ok) {
      return scan;
    }
    const files = [];
    const skipped = scan.skipped;
    const counts = {};
    let total = 0;
    let budgetHit = false;
    for (const item of scan.entries) {
      if (files.length >= maxFiles || budgetHit) {
        skipped.push({ remotePath: item.remotePath, reason: 'budget' });
        continue;
      }
      const bytes = item.bytes;
      if (bytes !== null && bytes > maxPerFile) {
        skipped.push({ remotePath: item.remotePath, reason: 'too_large', bytes });
        continue;
      }
      if (total + (bytes || 0) > maxTotal) {
        budgetHit = true;
        skipped.push({ remotePath: item.remotePath, reason: 'total_cap', bytes });
        continue;
      }
      // 落盘保留相对路径：不同子目录里的同名文件（DCIM/Camera/a.jpg 与
      // DCIM/Backup/a.jpg）用 basename 会互相覆盖，后一个悄悄盖掉前一个。
      const relative = item.remotePath.startsWith(`${remoteDir}/`)
        ? item.remotePath.slice(remoteDir.length + 1)
        : path.basename(item.remotePath);
      const localPath = path.join(localDir, relative);
      try {
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
      } catch (err) {
        skipped.push({
          remotePath: item.remotePath,
          reason: 'local_dir_failed',
          error: err && err.message ? err.message : '未知错误',
        });
        continue;
      }
      const timeoutMs = Math.max(config.adbTimeoutMs, 60000)
        + (bytes ? Math.ceil(bytes / (1024 * 1024)) * 1000 : 0);
      const pulled = await _runAdb(buildPullArgv(config, item.remotePath, localPath), timeoutMs);
      if (!pulled.ok) {
        skipped.push({
          remotePath: item.remotePath,
          reason: 'pull_failed',
          error: redactSecrets(pulled.stderr || pulled.stdout || 'adb pull 失败'),
        });
        continue;
      }
      total += bytes || 0;
      counts[item.type] = (counts[item.type] || 0) + 1;
      files.push({
        remotePath: item.remotePath,
        localPath,
        type: item.type,
        bytes,
        mtimeMs: item.mtimeMs,
      });
    }
    const manifest = collect.buildManifest({
      remoteDir,
      localDir,
      types,
      sinceMs: scan.sinceMs,
      sinceUnknown: scan.sinceUnknown,
      counts,
      files,
      skipped,
    });
    try {
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(
        path.join(localDir, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      );
    } catch (err) {
      return {
        ok: false,
        code: 'manifest_write_failed',
        error: `清单写入失败：${err && err.message ? err.message : '未知错误'}（文件已拉到 ${localDir}）`,
        files,
      };
    }
    return { ok: true, manifest, totalBytes: total };
  }

  /**
   * 把主机上的文件推到设备。pull 的对向：把构建产物/脚本/配置送上手机，
   * 是「手机当开发机」这条回路的另一半。设备侧父目录要先建——adb push 不会
   * 替我们建目录，缺目录时它只会报一个含糊的失败。
   */
  async function pushFile(options = {}) {
    const localPath = String(options.localPath || '').trim();
    const remotePath = String(options.remotePath || '').trim();
    const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : PHONE_BRIDGE_MAX_TRANSFER_BYTES;
    if (!localPath) {
      return { ok: false, code: 'invalid_path', error: '缺少主机侧源文件路径' };
    }
    if (!remotePath.startsWith('/')) {
      return { ok: false, code: 'invalid_path', error: `设备侧路径必须是绝对路径：${remotePath || '(空)'}` };
    }
    let bytes = null;
    try {
      const stat = fs.statSync(localPath);
      if (!stat.isFile()) {
        return { ok: false, code: 'invalid_path', error: `主机侧不是文件：${localPath}` };
      }
      bytes = stat.size;
    } catch (err) {
      return {
        ok: false,
        code: 'local_file_missing',
        error: `主机侧文件读不到：${localPath}（${err && err.message ? err.message : '未知错误'}）`,
      };
    }
    if (bytes > maxBytes) {
      return {
        ok: false,
        code: 'too_large',
        error: `文件 ${localPath} 有 ${(bytes / 1048576).toFixed(1)} MB，超过单次上限 `
          + `${(maxBytes / 1048576).toFixed(0)} MB；调 KHY_PHONE_BRIDGE_MAX_TRANSFER_BYTES 或换小文件。`,
      };
    }
    const started = await ensureConnected();
    if (!started.ok) {
      return started;
    }
    const remoteDir = remotePath.split('/').slice(0, -1).join('/');
    if (remoteDir) {
      const mkdir = await _runAdb(buildMkdirArgv(config, remoteDir), config.adbTimeoutMs);
      if (!mkdir.ok) {
        return {
          ok: false,
          code: 'adb_mkdir_failed',
          error: `设备侧目录建不出来：${remoteDir}（${redactSecrets(mkdir.stderr || mkdir.stdout || 'adb shell mkdir 失败')}）`,
        };
      }
    }
    const timeoutMs = Math.max(config.adbTimeoutMs, 60000)
      + Math.ceil(bytes / (1024 * 1024)) * 1000;
    const pushed = await _runAdb(buildPushArgv(config, localPath, remotePath), timeoutMs);
    if (!pushed.ok) {
      return {
        ok: false,
        code: 'adb_push_failed',
        error: `推送 ${localPath} → ${remotePath} 失败：${redactSecrets(pushed.stderr || pushed.stdout || 'adb push 失败')}`,
      };
    }
    return { ok: true, localPath, remotePath, bytes };
  }

  function _authHeaders() {
    return { Authorization: `Bearer ${token}` };
  }

  async function _httpPost(pathname, payload, timeoutMs) {
    const url = `${config.baseUrl}${pathname}`;
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const res = await httpTransport.request({
      method: 'POST',
      url,
      headers: _authHeaders(),
      body,
      timeoutMs: timeoutMs || config.httpTimeoutMs,
    });
    return res;
  }

  async function ping() {
    const blocked = _gateBlocked();
    if (blocked) {
      return blocked;
    }
    const started = await ensureForward();
    if (!started.ok) {
      return started;
    }
    const tokenRes = await readToken();
    if (!tokenRes.ok) {
      return tokenRes;
    }
    let lastError = null;
    for (let attempt = 0; attempt <= config.retryCount; attempt += 1) {
      const res = await _httpPost(HTTP_PATHS.ping);
      if (res.ok) {
        state.lastHttpOkAt = new Date(now()).toISOString();
        state.lastHttpError = null;
        state.lastChannel = 'http';
        return { ok: true, channel: 'http', status: res.status, body: res.body };
      }
      lastError = res.error || `HTTP ${res.status}`;
      if (attempt < config.retryCount) {
        await sleep(250 * (attempt + 1));
      }
    }
    state.lastHttpError = lastError;
    return { ok: false, code: 'http_ping_failed', error: `桥服务无响应：${lastError}` };
  }

  /**
   * 桥的无障碍实时状态。缓存（上一次 status() 的结果）说 true 就走快路径；
   * 否则现拉一次 /status——刚在手机上授权完无障碍时，缓存里还是旧的 false，
   * 不重拉就会把可用的能力误拒。拉不到一律 false：准入宁可误拒，不可放过。
   * @returns {Promise<boolean>}
   */
  async function _resolveUiAvailable() {
    const cached = state.lastBridgeStatus;
    if (cached && cached.ui === true) {
      return true;
    }
    const fresh = await status();
    return Boolean(fresh.ok && fresh.status && fresh.status.ui === true);
  }

  async function status() {
    const blocked = _gateBlocked();
    if (blocked) {
      return blocked;
    }
    const started = await ensureForward();
    if (!started.ok) {
      return started;
    }
    const tokenRes = await readToken();
    if (!tokenRes.ok) {
      return tokenRes;
    }
    const res = await _httpPost(HTTP_PATHS.status);
    if (!res.ok) {
      state.lastHttpError = res.error || `HTTP ${res.status}`;
      return { ok: false, code: 'http_status_failed', error: `读取桥状态失败：${state.lastHttpError}` };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      parsed = null;
    }
    state.lastHttpOkAt = new Date(now()).toISOString();
    state.lastHttpError = null;
    state.lastChannel = 'http';
    state.lastBridgeStatus = parsed;
    return { ok: true, channel: 'http', status: parsed };
  }

  /**
   * The cheapest liveness probe that does not need the HTTP port at all: the
   * service rewrites status.json every 2s. Polling its mtime is the only way to
   * tell "service dead" from "HTTP port dead" — the bridge fails silently when
   * the bind throws.
   */
  async function probe() {
    const blocked = _gateBlocked();
    if (blocked) {
      return blocked;
    }
    await _ensureSerialAdopted();
    // serial 仍是空的（没设 env、自动探测也没命中）：`adb shell cat` 在多设备时
    // 会报 more than one device，不如直接说没找到手机。
    if (!config.serial) {
      return { ok: false, code: 'device_not_found', error: DEVICE_NOT_FOUND_ERROR };
    }
    const res = await _runAdb(buildStatusReadArgv(config, config.statusRemotePath));
    if (!res.ok || !res.stdout.trim()) {
      return {
        ok: false,
        code: 'probe_failed',
        error: `读不到 ${config.statusRemotePath}：桥服务可能没有在运行。`,
      };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      parsed = null;
    }
    // 助手协同组（Amoo 反代）的可用性：只认桥自报的 withheld / tools，
    // 缺 App → false，桥没报 → null（未知），不替桥编结论。
    const relay = _relayAvailability(parsed);
    return {
      ok: true,
      channel: 'adb-shell',
      status: parsed,
      httpPortBound: !!(parsed && Number(parsed.http_port) > 0),
      canWrite: !!(parsed && parsed.canWrite === true),
      uiAvailable: !!(parsed && parsed.ui === true),
      assistantAvailable: relay.available,
      relayWithheld: relay.withheld,
      // 「桥看似在线但 PC 永远 401」的唯一静默成因：令牌没落盘，只剩内存份。
      // 旧版 APK（独立 StepBridge）的 status.json 没有这个字段——缺字段判
      // 「未知」（null），不判失败。
      tokenPersisted: parsed && typeof parsed.token_persisted === 'boolean'
        ? parsed.token_persisted
        : null,
      // 手机侧自述「PC 最近有没有来过」。null = 旧版桥没上报，判「未知」。
      // 它不是这条命令的成败判据：PC 不在时手机照常独立工作，这是正常模式。
      pcReachable: parsed && typeof parsed.pc_reachable === 'boolean'
        ? parsed.pc_reachable
        : null,
      pcIdleMs: parsed && typeof parsed.pc_idle_ms === 'number' ? parsed.pc_idle_ms : null,
    };
  }

  /**
   * Recovery. Measured: after a force-stop the service does NOT come back on
   * its own (the watchdog is exported=false and setInexactRepeating, so Doze
   * batches it; the JobScheduler period is 15 min). `am start` is swallowed by
   * a stale AMS top-most record and lies about it, and `am start-service` is
   * refused because BridgeService is exported=false. The launcher monkey event
   * is the only path that works.
   */
  async function revive() {
    const blocked = _gateBlocked();
    if (blocked) {
      return blocked;
    }
    await _ensureSerialAdopted();
    const res = await _runAdb(buildReviveArgv(config), Math.max(config.adbTimeoutMs, 15000));
    if (!res.ok) {
      return {
        ok: false,
        code: 'revive_failed',
        error: `唤醒桥失败：${redactSecrets(res.stderr || res.stdout || '广播执行失败')}`,
      };
    }
    state.connected = true;
    state.forwardReady = false;
    return {
      ok: true,
      message: '已通过广播唤醒 khy-os 桥；HTTP 通道可能需要几秒后才能再次连通。',
    };
  }

  /**
   * Mailbox fallback. Only reached when the HTTP channel is unreachable — a
   * bridge-level refusal is handled by the caller, because replaying it over
   * the mailbox would just produce the same refusal one channel later.
   */
  async function _fallbackToMailbox(classified, httpResult, callOptions) {
    if (callOptions.allowMailbox === false || !_mailboxGateEnabled(env)) {
      return { success: false, error: httpResult.error, code: httpResult.code, channel: 'http' };
    }
    const mailboxResult = await mailbox.call(classified.bridgeName, classified.args, {
      timeoutMs: callOptions.mailboxTimeoutMs,
    });
    if (mailboxResult.ok) {
      state.lastChannel = 'mailbox';
      return _shapeResult(mailboxResult.result, 'mailbox', classified);
    }
    return {
      success: false,
      error: `HTTP 主通道失败（${httpResult.error}）；信箱兜底也未成功（${mailboxResult.error}）。`,
      code: 'both_channels_failed',
      channel: 'http+mailbox',
    };
  }

  /**
   * 确认门：计划要求 confirm 而调用方没给时，返回待审批结果（一个字节都不发）。
   * @returns {object|null} null 表示放行
   */
  function _confirmGate(plan, callOptions) {
    if (plan.requiresConfirm && callOptions.confirm !== true) {
      return {
        success: false,
        requiresConfirm: true,
        code: 'requires_confirm',
        plan: plan.plan,
        message: plan.message,
        warning: plan.warning,
      };
    }
    return null;
  }

  /**
   * 分类 + UI 准入一并做：UI 工具的准入看桥的实时 ui 字段（见 UI_TOOL_ACCESS），
   * 缓存说 true 走快路径，否则现拉一次 /status——刚授权完无障碍时缓存还是旧
   * false，不重拉就会误拒。非 UI 工具零额外开销。
   * @returns {Promise<{uiAvailable:boolean, classified:object}>}
   */
  async function _classifyForCall(tool, args) {
    const uiAvailable = isPhoneBridgeUiToolName(tool) ? await _resolveUiAvailable() : false;
    return { uiAvailable, classified: classifyBridgeCall(tool, args, { uiAvailable }) };
  }

  async function call(tool, args = {}, callOptions = {}) {
    const blocked = _gateBlocked();
    if (blocked) {
      return blocked;
    }
    state.totalCalls += 1;

    const { uiAvailable, classified } = await _classifyForCall(tool, args);
    if (!classified.ok) {
      return {
        success: false,
        error: classified.error,
        code: classified.code,
        detail: classified.detail,
        requiresAccessibility: classified.requiresAccessibility === true,
      };
    }
    const plan = planBridgeCall({ tool: classified.bridgeName, args: classified.args, baseUrl: config.baseUrl, uiAvailable });
    const gated = _confirmGate(plan, callOptions);
    if (gated) {
      return gated;
    }

    const httpResult = await _callOverHttp(classified);
    if (httpResult.ok) {
      state.lastChannel = 'http';
      return _shapeResult(httpResult.result, 'http', classified);
    }
    // A bridge-level answer (it replied ok:false) is a real result, not a dead
    // channel: retrying it over the mailbox would just produce the same refusal.
    if (httpResult.retriable === false) {
      return {
        success: false,
        error: httpResult.error,
        code: httpResult.code,
        channel: 'http',
        result: httpResult.result,
      };
    }
    return _fallbackToMailbox(classified, httpResult, callOptions);
  }

  /**
   * Interprets one 200 response. A parse failure or a bridge-level ok:false is
   * marked retriable:false — the bridge ANSWERED, so the channel is alive and
   * the mailbox would only repeat the same refusal.
   */
  function _interpretBridgeBody(body) {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      return {
        ok: false,
        retriable: false,
        error: `桥返回的不是合法 JSON：${(err && err.message) || err}`,
        code: 'bad_json',
      };
    }
    if (parsed && parsed.ok === false) {
      return {
        ok: false,
        retriable: false,
        error: String(parsed.error || '桥接返回失败'),
        code: 'bridge_error',
        result: parsed,
      };
    }
    return { ok: true, result: parsed };
  }

  async function _callOverHttp(classified) {
    const started = await ensureForward();
    if (!started.ok) {
      return { ok: false, retriable: false, error: started.error, code: started.code };
    }
    const tokenRes = await readToken();
    if (!tokenRes.ok) {
      return { ok: false, retriable: false, error: tokenRes.error, code: tokenRes.code };
    }
    let lastError = null;
    for (let attempt = 0; attempt <= config.retryCount; attempt += 1) {
      const res = await _httpPost(
        HTTP_PATHS.call,
        { tool: classified.bridgeName, args: classified.args },
        // A read cannot change the phone, so the short deadline is safe. An
        // actuating call (exec especially) legitimately needs longer, and its
        // own bridge-side timeout is capped at 120s.
        classified.access === ACCESS_READ ? config.httpTimeoutMs : config.httpTimeoutMs * 3
      );
      if (res.ok) {
        state.lastHttpOkAt = new Date(now()).toISOString();
        state.lastHttpError = null;
        state.lastChannel = 'http';
        return _interpretBridgeBody(res.body);
      }
      lastError = res.error || `HTTP ${res.status}`;
      if (attempt < config.retryCount) {
        await sleep(250 * (attempt + 1));
      }
    }
    state.lastHttpError = lastError;
    return { ok: false, retriable: true, error: lastError, code: 'http_call_failed' };
  }

  function _shapeResult(result, channel, classified) {
    const shaped = { success: true, channel, tool: classified.bridgeName };
    for (const [key, value] of Object.entries(result || {})) {
      if (key === 'ok' || key === 'tool') {
        continue;
      }
      if (typeof value === 'string') {
        // Field-level exemption first, the tool's own cap second. The UI branch
        // of classifyBridgeCall carries no resultCapChars, so without the
        // exemption a screenshot's base64 silently fell back to the 8000-char
        // default and the model received a corrupt image with no error.
        const fieldCap = uiToolResultFieldCap(classified.bridgeName, key);
        const cap = fieldCap != null ? fieldCap : classified.resultCapChars;
        const trimmed = truncateBridgeResultText(value, cap);
        shaped[key] = trimmed.text;
        if (trimmed.truncated) {
          shaped.truncated = true;
        }
        continue;
      }
      shaped[key] = value;
    }
    return shaped;
  }

  function getState() {
    return {
      enabled: _parentGateEnabled(env),
      mailboxFallbackEnabled: _mailboxGateEnabled(env),
      serial: config.serial,
      serialSource: config.serialSource || 'env',
      autoSerial: state.autoSerial,
      httpPort: config.httpPort,
      localPort: config.localPort,
      baseUrl: config.baseUrl,
      mailboxDir: config.mailboxDir,
      tokenRemotePath: config.tokenRemotePath,
      // The token itself is never surfaced; only whether one is loaded and how
      // long it is. R2.
      tokenLoaded: state.tokenLoaded,
      tokenLength: state.tokenLength,
      connected: state.connected,
      forwardReady: state.forwardReady,
      lastConnectAttemptAt: state.lastConnectAttemptAt,
      lastConnectError: state.lastConnectError,
      lastHttpOkAt: state.lastHttpOkAt,
      lastHttpError: state.lastHttpError,
      lastChannel: state.lastChannel,
      lastBridgeStatus: state.lastBridgeStatus,
      totalCalls: state.totalCalls,
    };
  }

  function resetForTests() {
    token = '';
    state.connected = false;
    state.forwardReady = false;
    state.tokenLoaded = false;
    state.tokenLength = 0;
    state.lastConnectAttemptAt = null;
    state.lastConnectError = null;
    state.lastHttpOkAt = null;
    state.lastHttpError = null;
    state.lastChannel = null;
    state.lastBridgeStatus = null;
    state.autoSerial = null;
    state.totalCalls = 0;
    connectInFlight = null;
    autoDetectDone = false;
  }

  return {
    config,
    listDevices,
    detectSerial,
    ensureConnected,
    ensureForward,
    readToken,
    pullFile,
    pushFile,
    collectFiles,
    scanFiles,
    ping,
    status,
    probe,
    revive,
    call,
    mailboxCall: (tool, args, opts) => mailbox.call(tool, args, opts),
    getState,
    resetForTests,
    buildAdbArgv: (args) => buildAdbArgv(config, args),
  };
}

module.exports = {
  HTTP_PATHS,
  createAdbTransport,
  createHttpTransport,
  createPhoneBridgeClient,
  parseDeviceList: _parseDeviceList,
  parseMdnsConnectServices: _parseMdnsConnectServices,
};
