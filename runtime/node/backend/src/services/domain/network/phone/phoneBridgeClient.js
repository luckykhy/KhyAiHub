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
 * The credential is a device-signed certificate held by THIS PC, plus a signature
 * made with this PC's own private key on every request (see
 * phoneBridgeCredential.js). The device no longer publishes any long-lived secret
 * on shared storage; the old `/sdcard/.../token.txt` read is gone. R2.
 */

const fs = require('fs');
const http = require('node:http');
const os = require('node:os');
const path = require('path');
const { spawn } = require('child_process');

const { safeKill } = require('../../../../tools/platformUtils');
const {
  resolvePhoneBridgeConfig, pickDeviceSerial, pickMdnsSerial, discoveryFile,
  defaultExecutableProbe, parsePortSpec, splitHostPort, pickScannedAdbPort, sameSubnet,
} = require('./phoneBridgeConfig');
const { scanHostPorts } = require('./phoneAdbPortScan');
const { readPairCodeViaAdb } = require('./phonePairCodeReader');
const {
  buildConnectArgv,
  buildForwardArgv,
  buildStatusReadArgv,
  buildSizeArgv,
  buildStatArgv,
  buildPullArgv,
  buildPushArgv,
  buildMkdirArgv,
  buildLsArgv,
  buildFindArgv,
  buildReviveArgv,
  classifyBridgeCall,
  planBridgeCall,
  redactSecrets,
  buildAdbArgv,
} = require('./phoneBridgePolicy');
const { createPhoneBridgeCredential } = require('./phoneBridgeCredential');
const { createPhoneBridgeMailbox } = require('./phoneBridgeMailbox');
const { parseBridgeStatus } = require('../amoo/amooBridgePolicy');
const { truncateBridgeResultText, isPhoneBridgeUiToolName, ACCESS_READ, uiToolResultFieldCap, ASSISTANT_RELAY_TOOL_NAMES } = require('./phoneBridgeCatalog');
const {
  PHONE_BRIDGE_MAX_TRANSFER_BYTES, PHONE_BRIDGE_MAX_COLLECT_FILES, PHONE_BRIDGE_MAX_COLLECT_BYTES,
  PHONE_BRIDGE_ADB_PORTS, PHONE_BRIDGE_ADB_SCAN_CONCURRENCY, PHONE_BRIDGE_ADB_SCAN_TIMEOUT_MS,
  DEVICE_LINK_ADMIN_PORT, DEVICE_LINK_ADMIN_REGISTER_PATH, DEVICE_LINK_ADMIN_STATE_PATH,
} = require('../../../../constants/serviceDefaults');
/** admin 口的两条路径与 deviceLinkWss 共用同一份常量（真源在 constants/serviceDefaults）。 */
const ADMIN_REGISTER_PATH = DEVICE_LINK_ADMIN_REGISTER_PATH;
const ADMIN_STATE_PATH = DEVICE_LINK_ADMIN_STATE_PATH;
const collect = require('./phoneCollect');

const DEVICE_STATE_DEVICE = 'device';
const MAX_ADB_OUTPUT_CHARS = 64 * 1024;
const HTTP_PATHS = Object.freeze({ ping: '/ping', status: '/status', call: '/call' });
// 出向链路登记是本机 loopback 调用（127.0.0.1 的 admin 口）：服务没起时 connect
// 立刻被拒，3s 只是给「起来了但卡住」一个上限，不是任务期限。
const DEVICE_LINK_ENROLL_TIMEOUT_MS = 3000;
// 缓存路径的 /state 探测节流与上限（S0 验收裁决 2026-11-17 的具体值）：
// 十分钟内至多探一次；探测/补登记失败后本进程退避（不再二探），退避期间任何
// 补登记只能靠非缓存路径（pair / 凭据重建）触发。
const DEVICE_LINK_PROBE_INTERVAL_MS = 10 * 60 * 1000;
const DEVICE_LINK_PROBE_TIMEOUT_MS = 1500;

// status.json 的新鲜度门槛，与手机侧 BridgeService.HEARTBEAT_STALE_MS 同值：
// 一条长 exec 能让 worker loop 正当地阻塞约 120s，短于这个数的文件年龄不该
// 被读成「桥停了」。超过它才说这份快照不可信。
const STATUS_STALE_MS = 180000;

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

/**
 * Truncate adb output and report honestly whether it was cut.
 *
 * cap is adjustable for androidRef: its dump is ~276KB, and the 64KB cap would
 * slice the XML into fragments that a parser then reads as a partial element set —
 * tapping a ref from that set taps the wrong control. Phone call sites pass no
 * cap and keep the original 64KB, so their output is byte-identical.
 */
function _truncate(text, cap = MAX_ADB_OUTPUT_CHARS) {
  const input = String(text ?? '');
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : MAX_ADB_OUTPUT_CHARS;
  if (input.length <= limit) {
    return { text: input, truncated: false };
  }
  return { text: `${input.slice(0, limit)}\n...[adb 输出已截断]`, truncated: true };
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
  const maxOutputChars = Number(options.maxOutputChars) > 0
    ? Number(options.maxOutputChars)
    : MAX_ADB_OUTPUT_CHARS;
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
      const out = _truncate(stdout, maxOutputChars);
      const err = _truncate(stderr, maxOutputChars);
      resolve({
        ok: code === 0 && !aborted,
        code: aborted ? -1 : code,
        stdout: out.text,
        stderr: err.text,
        aborted,
        truncated: out.truncated || err.truncated,
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

const MDNS_CONNECT_SERVICE = '_adb-tls-connect._tcp';
const MDNS_PAIRING_SERVICE = '_adb-tls-pairing._tcp';
const MDNS_IP_PORT_SHAPE = /^[\d.]+:\d+$/;

/**
 * `adb mdns services` 里可连接的实例。只收 `_adb-tls-connect`——配对实例
 * (`_adb-tls-pairing`) 是配对档口，对它跑 `adb pair` 会 protocol fault，
 * 本单元绝不配对（配对由用户在仓外一次性完成）。
 *
 * 返回 [{ instance, address }]；address 只接受 IPv4:port。
 *
 * 2026-11-18 修：服务名这一列**不带尾点**（真机输出是
 * `adb-XXX\t_adb-tls-connect._tcp\t192.168.2.46:36973`），而旧实现按
 * `_adb-tls-connect._tcp.`（带尾点）做子串匹配——于是**一条都解析不出来**，
 * mDNS 兜底档成了死代码：手机重连后 adb 忘了旧 transport（设备表空）时，
 * 自动发现的两条路同时失效，用户只能手输地址。
 * 旧测试用的正是带尾点那种形态，把「错误的现实」钉住了，所以一直没被发现。
 *
 * 现在按「头部含服务名 + 末列是 IPv4:port」判定，两种列形态都认：
 *   三列：adb-XXX <TAB> _adb-tls-connect._tcp <TAB> 192.168.2.46:36973（真机）
 *   两列：adb-XXX._adb-tls-connect._tcp <TAB> 192.168.2.46:36973（服务名拼在实例名里）
 * 两种形态的尾点写法（有/无）也都认。
 */
function _parseMdnsConnectServices(stdout) {
  const out = [];
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split(/\s+/);
    const address = parts[parts.length - 1] || '';
    if (!MDNS_IP_PORT_SHAPE.test(address)) {
      continue;
    }
    // 头部 = 末列以外的全部（实例名，可能自带空格，也可能带服务后缀）
    const head = parts.slice(0, parts.length - 1).join(' ');
    if (!head.includes(MDNS_CONNECT_SERVICE)) {
      continue;
    }
    if (head.includes(MDNS_PAIRING_SERVICE)) {
      continue;
    }
    // 实例名去掉服务后缀，剩下的才是实例名本身
    const instance = head.split(MDNS_CONNECT_SERVICE)[0].trim();
    out.push({ instance, address });
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
  // 信箱的 adb argv（shell ls/cat/rm/push）不经过 phoneBridgePolicy 的构建器，
  // 因此不自带 -s；双 transport（同一台手机的 IP 形态与 mDNS 形态）时 adb 会报
  // "more than one device/emulator"，消费通道直接不可用（2026-11-17 实测）。
  // 包一层而不是改 mailbox：注入面仍保持 {run,push} 两份契约，测试假 transport
  // 不受影响。serialSource=default 时不硬塞——那是个占位地址，拿它当 -s 会把
  // 命令发给不存在的设备。
  function _withSerialArgv(argv) {
    const args = Array.isArray(argv) ? argv.map((value) => String(value)) : [];
    if (!config.serial || config.serialSource === 'default') return args;
    if (args[0] === '-s' || args[0] === '-t') return args;
    return ['-s', config.serial, ...args];
  }
  const mailboxTransport = {
    async push(localPath, remotePath) {
      const res = await adbTransport.run(
        _withSerialArgv(['push', String(localPath), String(remotePath)]),
        { timeoutMs: config.adbTimeoutMs },
      );
      return res.ok
        ? { ok: true }
        : { ok: false, error: redactSecrets(res.stderr || res.stdout || 'adb push 失败') };
    },
    run: (argv, opts) => adbTransport.run(_withSerialArgv(argv), opts),
  };
  const mailbox = createPhoneBridgeMailbox({
    config,
    transport: mailboxTransport,
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
    // 出向链路登记的结论（status 面）：{reg_state, last_reg_ms,
    // registration_source, deviceId, code}。null = 本进程还没确认过。
    registration: null,
  };

  // 凭据（断点二）：设备签发的短期证书 + 本机私钥。测试可以注入一个假的，
  // 但默认就是真东西——默认值若是「不配对也能跑」，那 T5 的静态扫描就只是在
  // 扫一个没人用的分支。
  //
  // 配对码从哪来：凭据层在没有可用证书时会问 promptCode。默认问法是
  // 「读手机通知栏」——设备侧刻意不回传码（要让码的人看见码），但本机已经
  // 握着 adb 时，对这台手机已有完全控制权，通知栏里的码不再增加防线，却把
  // 「必须有人站在手机前」卡死在凌晨三点的无人值守任务上。取舍与边界写在
  // phonePairCodeReader.js 的文件头。注入的 promptCode 优先（测试与人机交互用）。
  const promptCode = options.promptCode || (async () => {
    const res = await readPairCodeViaAdb({
      run: (argv, timeoutMs) => adbTransport.run(argv, { timeoutMs }),
      argv: buildAdbArgv(config, ['shell', 'dumpsys', 'notification', '--noredact']),
      timeoutMs: config.adbTimeoutMs,
    });
    return res.ok ? res.code : '';
  });
  const credential = options.credential || createPhoneBridgeCredential({
    request: (req) => httpTransport.request(req),
    baseUrl: config.baseUrl,
    env,
    fs: options.fs,
    path: options.path,
    os: options.os,
    now,
    promptCode,
    storePath: options.credentialStorePath,
  });
  let credentialReady = false;
  let connectInFlight = null;
  // 出向链路的登记结论（deviceId → receipt）：成功的同 id 只登记一次，失败允许
  // 下一次调用重试——服务没起是正常状态，不能因此每拍重打，也不能因此永远不补。
  const deviceLinkEnrollments = new Map();
  // 缓存路径的 /state 探测状态：上次探测时刻 + 进程内失败退避。
  let deviceLinkProbeAt = 0;
  let deviceLinkProbeBackedOff = false;
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
   * 上次连成功过的手机主机（只要 IP，不要端口）。
   *
   * 端口会变、IP 通常不变：每次开关无线调试或重启手机，adb 无线调试的端口
   * 就换一个（实测 34103 / 37801 / 45315 / 41631 / 35097 / 40871 …），而 DHCP
   * 租约还在。所以「上次的端点」真正能复用的部分是主机，不是端口。
   *
   * 来源按可靠性排：共享发现文件（本机上次成功连接的广播）→ 当前 config 里
   * 的 ip:port 形态 → 进程内记录的 autoSerial。
   */
  function _lastKnownHost() {
    const candidates = [];
    // 用客户端自己的 env，而不是 process.env：注入的 env 是这个 client 的
    // 真相来源（测试与多实例场景都靠它隔离），读 process.env 会读到别人的
    // 记录——实测过一次：注入的发现文件被忽略，结果拿了真实用户的旧地址。
    const file = discoveryFile(env);
    if (file) {
      try {
        const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
        candidates.push(payload && payload.serial);
      } catch {
        /* 文件缺失或写坏：不影响其余来源 */
      }
    }
    candidates.push(config.serial);
    if (state.autoSerial && state.autoSerial.serial) {
      candidates.push(state.autoSerial.serial);
    }
    for (const candidate of candidates) {
      const split = splitHostPort(candidate);
      if (split) {
        return split.host;
      }
    }
    return '';
  }

  /**
   * 这台电脑在局域网里的 IPv4（取第一个非回环的 IPv4）。
   *
   * 只用来判断「记住的那台手机是不是还在同一个网段」——手机走 Wi-Fi 连 adb，
   * 必然与电脑同网段；记住的 IP 若不同网段，那条记录多半是陈旧的。
   */
  function _localIPv4() {
    try {
      const interfaces = os.networkInterfaces();
      for (const name of Object.keys(interfaces)) {
        for (const entry of interfaces[name] || []) {
          if (entry.family === 'IPv4' && !entry.internal && entry.address) {
            return entry.address;
          }
        }
      }
    } catch {
      /* 拿不到就当没有：下面的判断会退化成「不同网段」 */
    }
    return '';
  }

  /**
   * 发现路的最后一档：记住上次的 IP，在它上面扫 adb 无线调试的端口。
   *
   * 为什么要有这一档：手机重连后 adb 忘了旧 transport，`adb devices` 没有
   * device 态条目；mDNS 又常被路由器挡掉（2026-11-13 实测：手机在
   * 192.168.2.46 上 ICMP 通，mdns 列表空）。两条常规路同时空的场合，只剩
   * 「同一台机器、上次那个 IP」这一条线索——扫出端口后交给 adb connect 验证，
   * 认不认是 adb 说了算。
   *
   * 只扫一台主机，不扫网段；并发与超时都有预算（serviceDefaults 里的
   * PHONE_BRIDGE_ADB_SCAN_*）。扫不出来也留下证据：refused 多 = 主机活着但
   * 端口全关（无线调试没开），unreachable 多 = 主机不在。
   */
  async function _scanForAdbPort() {
    const host = _lastKnownHost();
    if (!host) {
      return { ok: false, reason: 'no_known_host' };
    }
    // 记下的 IP 与电脑不在同一网段 → 那多半是陈旧记录（手机换了 Wi-Fi）。
    // 对着不同网段的主机扫端口只会白等到超时，不如把这件事直接说出来。
    const local = _localIPv4();
    if (local && !sameSubnet(host, local)) {
      return { ok: false, reason: 'host-off-subnet', host, local };
    }
    const ports = parsePortSpec(PHONE_BRIDGE_ADB_PORTS, [5555]);
    const scan = await scanHostPorts({
      host,
      ports,
      concurrency: PHONE_BRIDGE_ADB_SCAN_CONCURRENCY,
      timeoutMs: PHONE_BRIDGE_ADB_SCAN_TIMEOUT_MS,
      deadlineMs: Math.max(PHONE_BRIDGE_ADB_SCAN_TIMEOUT_MS * 4, 4000),
    });
    state.lastPortScan = {
      host,
      at: new Date(now()).toISOString(),
      openPorts: scan.openPorts,
      elapsedMs: scan.elapsedMs,
      refused: scan.refused,
      unreachable: scan.unreachable,
      timedOutCount: scan.timedOutCount,
    };
    if (!scan.ok) {
      return { ok: false, reason: 'no_open_port', host, scan };
    }
    const picked = pickScannedAdbPort(scan.openPorts);
    if (!picked.ok) {
      return { ok: false, reason: picked.source, host, scan };
    }
    return { ok: true, host, port: picked.port, scan };
  }

  /**
   * 把「扫到了端口」变成「真的连上了」：adb connect 认不认由 adb 说了算，
   * 扫出开着端口不等于那是 adb。
   */
  async function _connectScannedEndpoint(scan) {
    const serial = `${scan.host}:${scan.port}`;
    const res = await _runAdb(['connect', serial]);
    const stdout = String(res.stdout || '');
    if (!res.ok || /cannot connect|failed|refused|error/i.test(stdout)) {
      return {
        ok: false,
        code: 'scanned_port_not_adb',
        error: `${scan.host} 的 ${scan.port} 端口开着，但 adb 不认：${redactSecrets(res.stderr || stdout || 'adb connect 失败')}`,
      };
    }
    const listed = await listDevices();
    const hit = listed.ok
      ? listed.devices.find((d) => d.serial === serial && d.state === DEVICE_STATE_DEVICE)
      : null;
    if (!hit) {
      return {
        ok: false,
        code: 'scanned_port_not_adb',
        error: `${scan.host}:${scan.port} 连上了但设备不在 device 态（可能是别的服务占了这个端口）。`,
      };
    }
    _writeBackSerial(serial, 'adb-scan');
    state.connected = true;
    state.lastConnectError = null;
    return { ok: true, connected: true, serial, source: 'adb-scan' };
  }

  /**
   * 发现落空时的诊断：把「主机活着但端口全关」与「主机根本不在」分开说。
   *
   * 这两种坏法的处置完全不同——前者要用户在手机上开无线调试，后者要用户
   * 确认手机还在这个 Wi-Fi 上。说成同一句「未发现手机」，用户只能自己猜。
   */
  function _diagnoseDiscoveryMiss(scan) {
    if (!scan || !scan.host) {
      return DEVICE_NOT_FOUND_ERROR;
    }
    if (scan.reason === 'host-off-subnet') {
      return `上次连上的手机在 ${scan.host}，而这台电脑在 ${scan.local} 这个网段——`
        + '手机多半换了 Wi-Fi。打开手机的「无线调试」后 mDNS 会重新发现它；'
        + '若手机就在本机网段，用 KHY_PHONE_BRIDGE_SERIAL=<ip>:<端口> 直接指定。';
    }
    if (scan.reason === 'scanned-ambiguous') {
      return `上次的手机 ${scan.host} 上有多个端口开着（${scan.scan.openPorts.join(', ')}），不确定哪个是 adb：`
        + '请在手机的无线调试界面看当前端口，用 KHY_PHONE_BRIDGE_SERIAL=<ip>:<端口> 指定。';
    }
    if (scan.scan && scan.scan.unreachable > scan.scan.refused) {
      return `上次的手机 ${scan.host} 现在不在网络上（${scan.scan.unreachable} 个端口不可达）：`
        + '请确认手机开着、连着同一个 Wi-Fi，且没有被路由器隔离（AP isolation）。';
    }
    if (scan.scan && scan.scan.refused > 0) {
      return `上次的手机 ${scan.host} 在网络上，但 adb 端口一个都没开（${scan.scan.refused} 个端口拒绝连接）：`
        + '请在手机「设置 → 开发者选项 → 无线调试」里打开无线调试。';
    }
    if (scan.scan && scan.scan.timedOutCount > 0 && scan.scan.refused === 0) {
      return `上次的手机 ${scan.host} 的所有端口都超时（${scan.scan.timedOutCount} 个），既不拒绝也不应答：`
        + '它多半不在这个网段，或被防火墙挡着。打开手机无线调试让 mDNS 重新发现它。';
    }
    return DEVICE_NOT_FOUND_ERROR;
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
    const file = discoveryFile(env);
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
    if (!picked.ok || !picked.serial) {
      return false;
    }
    // 同主机多端口时**不猜**：一条手机会同时广播两个端口，其中一个可能已经失效
    // （2026-11-18 实测：36973 拒绝连接、42359 是活的）。挑中死端口的表现是
    // 「自动发现找不到手机」，用户只好手输地址——所以逐个试连，取第一个真连上的。
    const candidates = Array.isArray(picked.candidates) && picked.candidates.length
      ? picked.candidates
      : [picked.serial];
    if (candidates.length > 1) {
      const live = await _firstConnectable(candidates);
      if (live) {
        return live === config.serial ? false : _writeBackSerial(live, 'adb-mdns-same-host');
      }
      // 一个都连不上：仍然写回第一个候选，让随后的 connect 报出可读的错误
      // （「连不上 <地址>」），而不是一句「没找到手机」。
    }
    if (picked.serial !== config.serial) {
      return _writeBackSerial(picked.serial, picked.source);
    }
    return false;
  }

  /**
   * 逐个候选试连，返回第一个真连上的端点。
   *
   * adb connect 对已连接设备是幂等的（回 already connected），对死端口立刻回
   * 拒绝连接——两次调用都是秒级，所以「试到连上为止」比「猜一个」划算。
   */
  async function _firstConnectable(candidates = []) {
    for (const candidate of candidates) {
      const res = await _runAdb(['connect', candidate], 8000);
      const stdout = String(res.stdout || '');
      if (res.ok && !/cannot connect|failed|refused|error/i.test(stdout)) {
        return candidate;
      }
    }
    return '';
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
    // 直连优先：有串号就用它（一次 adb 调用，很便宜）。成了就不必扫端口。
    let directError = null;
    if (config.serial) {
      const res = await _runAdb(buildConnectArgv(config));
      const stdout = String(res.stdout || '');
      if (res.ok && !/cannot connect|failed|refused|error/i.test(stdout)) {
        state.connected = true;
        state.lastConnectError = null;
        return { ok: true, connected: true, connected_now: true };
      }
      directError = redactSecrets(res.stderr || stdout || 'adb connect 失败');
    }
    state.connected = false;
    state.lastConnectError = directError || DEVICE_NOT_FOUND_ERROR;

    // 直连没成（或压根没有串号）：上扫描档。
    //
    // 端口可能只是变了：手机重连后 adb 无线调试换一个端口，而 IP 通常不变。
    // 设备表与 mDNS 两条常规发现路都空的时候，扫上次那个 IP 上的端口，
    // 找到了再让 adb connect 去认（认不认是 adb 说了算）。env 显式指定的
    // 串号是人的决定，这档不介入。
    const scanSource = config.serialSource || 'env';
    if (scanSource !== 'env') {
      const scan = await _scanForAdbPort();
      if (scan.ok) {
        const connected = await _connectScannedEndpoint(scan);
        if (connected.ok) {
          return {
            ok: true,
            connected: true,
            connected_now: true,
            serial: connected.serial,
            source: 'adb-scan',
          };
        }
        state.lastConnectError = connected.error || state.lastConnectError;
        return { ok: false, code: connected.code, error: connected.error };
      }
      state.lastDiscoveryScan = scan;
      return { ok: false, code: 'device_not_found', error: _diagnoseDiscoveryMiss(scan) };
    }

    // 空 serial：adoptAutoSerial 没命中，config.serial 仍是空的。此时
    // `adb connect ''`（或多设备时设备串）能把人的引号错到别的设备上去，
    // 直接报「未发现手机」，不猜。
    if (!config.serial) {
      return { ok: false, code: 'device_not_found', error: DEVICE_NOT_FOUND_ERROR };
    }
    {
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
   * 从设备的 status.json 里读设备身份（device_id + 公钥）。
   *
   * <p>为什么走 adb 读文件而不是问 HTTP：问 HTTP 要先有凭据，而有凭据要先知道
   * 这台设备是谁——鸡生蛋。status.json 里放的是**公钥**，公开信息，放共享存储
   * 没有风险；这也正是断点二允许留在 /sdcard 上的唯一一类东西。
   *
   * <p>status.json 可能滞后（写盘失败时是几小时前的快照）。滞后不影响这里：
   * device_id 是公钥指纹，除非重装不会变；变了就是「换了台设备/换了身份」，
   * 那时凭据本来也该重配。
   */
  async function _readDeviceIdentity() {
    const res = await _runAdb(buildStatusReadArgv(config, config.statusRemotePath), 10000);
    if (!res.ok) {
      return {
        ok: false,
        code: 'device_identity_unreadable',
        error: `读不到设备状态文件（${config.statusRemotePath}）。`
          + '确认 khy-os App 启动过至少一次，且已授予「所有文件访问」。',
      };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(res.stdout || '{}');
    } catch {
      parsed = null;
    }
    const identity = parsed && parsed.identity;
    const deviceId = String((identity && identity.device_id) || '').trim();
    if (!deviceId) {
      return {
        ok: false,
        code: 'device_identity_missing',
        error: '设备状态里没有 identity.device_id：手机上的 khy-os 版本太旧（未启用设备密钥对）。'
          + '升级到带 DeviceIdentity 的版本后重试。',
      };
    }
    return { ok: true, deviceId, publicKey: String(identity.public_key_b64 || '') };
  }

  /**
   * 出向链路自动登记（S0）：本地有密钥但服务端不认识 → 用既有出向链路服务的
   * loopback admin 口把身份登记进去，全程无人工介入。
   *
   * <p>为什么走 admin 口而不是新开一个登记面：deviceLinkWss 的登记真源只有
   * DeviceKeyRegistry 一份，admin POST 是它现成的写入口（deviceLinkWss.js
   * 的 ADMIN_REGISTER_PATH）；再开第三个面只会长出第二份「谁认识谁」。
   *
   * <p>fail-soft 是刻意的：admin 服务没起是出向链路的正常状态（runner 不一定
   * 在跑），登记失败绝不判配对失败——这里只回答「链路认不认识这台设备」，
   * 不回答「桥能不能用」。
   *
   * <p>同 deviceId 只登记一次（进程内 Map 去重）；失败可重试，下一次取身份时
   * 再打。登记帧里的 `source:'auto'` 是 status 面区分 auto/manual 的依据。
   *
   * @param {{ok: true, deviceId: string, publicKey: string}|{ok: false}} identity
   * @returns {Promise<{ok: true, deviceId: string, alreadyEnrolled: boolean,
   *          registeredAt?: number, regSource?: string, deduped?: boolean}
   *          |{ok: false, deviceId: string, code: string, used?: number,
   *          max?: number, error?: string}|null>}
   */
  async function _ensureDeviceLinkEnrolled(identity) {
    if (!identity || identity.ok !== true) return null;
    const deviceId = String(identity.deviceId || '');
    const publicKey = String(identity.publicKey || '');
    if (!deviceId) return null;
    if (!publicKey) {
      // 旧版桥的 status.json 没有 public_key_b64：没有公钥就没法登记，如实记
      // 「未登记」，不去 admin 口打一发注定被拒的请求。
      const receipt = { ok: false, deviceId, code: 'public_key_missing' };
      deviceLinkEnrollments.set(deviceId, receipt);
      _noteRegistration(receipt);
      return receipt;
    }
    const cached = deviceLinkEnrollments.get(deviceId);
    if (cached && cached.ok) {
      const deduped = { ...cached, deduped: true };
      _noteRegistration(deduped);
      return deduped;
    }
    let receipt;
    let res = null;
    try {
      res = await httpTransport.request({
        method: 'POST',
        url: `http://127.0.0.1:${DEVICE_LINK_ADMIN_PORT}${ADMIN_REGISTER_PATH}`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          publicKey,
          userId: 'local',
          platform: 'android',
          deviceName: config.serial || '',
          source: 'auto',
        }),
        timeoutMs: DEVICE_LINK_ENROLL_TIMEOUT_MS,
      });
    } catch (err) {
      res = { status: 0, body: '', ok: false, error: String((err && err.message) || err) };
    }
    if (!res || res.status === 0) {
      receipt = {
        ok: false,
        deviceId,
        code: 'admin_unreachable',
        error: res && res.error ? redactSecrets(res.error) : '出向链路 admin 口无响应',
      };
    } else {
      let parsed = null;
      try { parsed = JSON.parse(res.body || '{}'); } catch { parsed = null; }
      if (parsed && parsed.ok === true) {
        receipt = {
          ok: true,
          deviceId: String(parsed.deviceId || deviceId),
          alreadyEnrolled: parsed.alreadyEnrolled === true,
          registeredAt: Number.isFinite(parsed.registeredAt) ? parsed.registeredAt : now(),
          regSource: parsed.regSource === 'manual' ? 'manual' : 'auto',
        };
      } else {
        receipt = {
          ok: false,
          deviceId,
          code: (parsed && parsed.code) || `admin_http_${res.status}`,
        };
        if (parsed && Number.isFinite(parsed.used)) receipt.used = parsed.used;
        if (parsed && Number.isFinite(parsed.max)) receipt.max = parsed.max;
        if (res.status !== 400) {
          receipt.error = `出向链路 admin 口回了 HTTP ${res.status}`;
        }
      }
    }
    deviceLinkEnrollments.set(deviceId, receipt);
    _noteRegistration(receipt);
    return receipt;
  }

  /**
   * 缓存凭据路径的补登记（S0 验收裁决 2026-11-17）。
   *
   * <p>旧承诺原文在 readToken 里：「已经有可用凭据时**不去问设备它叫什么**：
   * 证书里就写着 device_id…每进程再读一次 status.json 只多一次 adb 往返，
   * 换不到任何额外保证」。裁决把它收窄为「**服务端认识这台设备时**不去问
   * 它」——凭据可用不等于服务端还认识它：PC 重启后登记表可能已经忘了这台
   * 设备，而设备侧只会被 device_not_enrolled 无限拒绝。
   *
   * <p>触发条件（严格三段，不放宽）：
   *   1. 凭据可用时做**节流的** loopback `GET /state`（只打 127.0.0.1，
   *      不向局域网/外网发送任何设备标识）；
   *   2. 只有「admin 可达 且 登记表里没有该 deviceId」才读一次 status.json
   *      并自动补登记；
   *   3. admin 不可达 / 设备已在册 → 一次都不读 status.json。
   *
   * <p>节流：≥10 分钟一次（DEVICE_LINK_PROBE_INTERVAL_MS）；探测或补登记
   * 失败后本进程退避，不再二探（失败可重试只走非缓存路径）。名额满按已定
   * 取舍：只报错不顶人，reg_state 停在 unregistered，原因落进 status。
   *
   * @param {{paired?: boolean, usable?: boolean, deviceId?: string}} desc
   * @returns {Promise<object|null>} 本次的登记结论（未探测时为 null）
   */
  async function _ensureDeviceLinkRegistrationCached(desc) {
    try {
      const deviceId = String((desc && desc.deviceId) || '');
      if (!deviceId) return null;
      const settled = deviceLinkEnrollments.get(deviceId);
      if (settled && settled.ok) return null; // 本进程已登记/已确认在册
      if (deviceLinkProbeBackedOff) return null; // 失败退避：进程内不再探
      const at = now();
      if (deviceLinkProbeAt && at - deviceLinkProbeAt < DEVICE_LINK_PROBE_INTERVAL_MS) return null;
      deviceLinkProbeAt = at;

      let res = null;
      try {
        res = await httpTransport.request({
          method: 'GET',
          url: `http://127.0.0.1:${DEVICE_LINK_ADMIN_PORT}${ADMIN_STATE_PATH}`,
          headers: {},
          body: '',
          timeoutMs: DEVICE_LINK_PROBE_TIMEOUT_MS,
        });
      } catch (err) {
        res = { status: 0, body: '', ok: false, error: String((err && err.message) || err) };
      }
      if (!res || res.status === 0) {
        deviceLinkProbeBackedOff = true;
        const receipt = {
          ok: false,
          deviceId,
          code: 'admin_unreachable',
          error: res && res.error ? redactSecrets(res.error) : '出向链路 admin 口无响应',
        };
        _noteRegistration(receipt);
        return receipt;
      }

      let parsed = null;
      try { parsed = JSON.parse(res.body || '{}'); } catch { parsed = null; }
      const devices = parsed && parsed.registry && Array.isArray(parsed.registry.devices)
        ? parsed.registry.devices
        : null;
      if (!devices) {
        // 旧版/异常 admin 应答：不认识形状就不猜，按失败退避。
        deviceLinkProbeBackedOff = true;
        const receipt = { ok: false, deviceId, code: 'admin_state_unreadable' };
        _noteRegistration(receipt);
        return receipt;
      }
      const row = devices
        .map((d) => (typeof d === 'string' ? { deviceId: d } : d))
        .find((d) => d && d.deviceId === deviceId);
      if (row) {
        // 服务端在册：不读 status.json，只把服务端的登记事实报进 status。
        const receipt = {
          ok: true,
          deviceId,
          alreadyEnrolled: true,
          registeredAt: Number.isFinite(row.registeredAt) ? row.registeredAt : null,
          regSource: row.regSource === 'auto' ? 'auto' : 'manual',
          probe: 'state',
        };
        _noteRegistration(receipt);
        return receipt;
      }

      // 服务端明确不认识这台设备：这时读一次身份才「换得到东西」。
      const identity = await _readDeviceIdentity();
      if (!identity.ok) {
        deviceLinkProbeBackedOff = true;
        const receipt = { ok: false, deviceId, code: identity.code || 'device_identity_unreadable' };
        _noteRegistration(receipt);
        return receipt;
      }
      const receipt = await _ensureDeviceLinkEnrolled(identity);
      if (!receipt || receipt.ok !== true) deviceLinkProbeBackedOff = true;
      return receipt;
    } catch {
      deviceLinkProbeBackedOff = true;
      return null;
    }
  }

  /** 登记结论 → status 面。成功才刷新 last_reg_ms/source；失败保留上一次的。 */
  function _noteRegistration(receipt) {
    if (!receipt) return;
    const prev = state.registration || {};
    state.registration = {
      reg_state: receipt.ok ? (receipt.alreadyEnrolled ? 'registered' : 're_registered') : 'unregistered',
      last_reg_ms: receipt.ok && Number.isFinite(receipt.registeredAt)
        ? receipt.registeredAt
        : (Number.isFinite(prev.last_reg_ms) ? prev.last_reg_ms : null),
      registration_source: receipt.ok
        ? (receipt.regSource === 'manual' ? 'manual' : 'auto')
        : (prev.registration_source || null),
      deviceId: receipt.deviceId || prev.deviceId || null,
      code: receipt.ok ? null : (receipt.code || null),
    };
  }

  /**
   * 确保有一个可用的桥凭据（配对一次，之后缓存 24 小时）。
   *
   * <p>函数名保留 `readToken` 是因为三个调用点（ping/status/call）都按这个契约
   * 判成败；语义已经换成「取到可用凭据」。改名会让 diff 看起来更大，却不会让
   * 任何一处更正确。
   */
  async function readToken(force = false) {
    const blocked = _gateBlocked();
    if (blocked) {
      return blocked;
    }
    if (credentialReady && !force) {
      return { ok: true, cached: true };
    }
    // 旧承诺：「已经有可用凭据时**不去问设备它叫什么**：证书里就写着
    // device_id，桥自己会拿设备公钥验它。每进程再读一次 status.json 只多一次
    // adb 往返，换不到任何额外保证——而 status.json 本身还可能是几小时前的
    // 快照。」
    // S0 验收裁决（2026-11-17）把这句收窄为「**服务端认识这台设备时**不去问
    // 它」：凭据可用不等于出向链路还认识它（PC 重启会忘）。探测只打本机
    // admin 的 /state（127.0.0.1，不外发设备标识），且节流 ≥10 分钟、失败
    // 进程内退避；只有服务端明确不认识这台设备时才读一次 status.json 补登记。
    if (!force) {
      const desc = credential.describe();
      if (desc && desc.paired === true && desc.usable === true) {
        credentialReady = true;
        state.tokenLoaded = true;
        await _ensureDeviceLinkRegistrationCached(desc);
        return { ok: true, cached: true, deviceId: desc.deviceId || '' };
      }
    }
    const identity = await _readDeviceIdentity();
    if (!identity.ok) {
      state.tokenLoaded = false;
      state.tokenLength = 0;
      return identity;
    }
    // 身份到手就先补出向链路登记：这与桥凭据是两条独立的链路，失败不挡配对。
    const enroll = await _ensureDeviceLinkEnrolled(identity);
    const res = await credential.ensure({ deviceId: identity.deviceId, force });
    if (!res.ok) {
      state.tokenLoaded = false;
      state.tokenLength = 0;
      return res;
    }
    credentialReady = true;
    state.tokenLoaded = true;
    // 这个字段的含义变成「凭据可用」，长度不再有意义；保留是为了让 getState
    // 的既有读者不会读到 undefined。
    state.tokenLength = 0;
    return {
      ok: true,
      cached: res.cached === true,
      deviceId: res.deviceId || identity.deviceId,
      enroll,
    };
  }

  /**
   * 配对一次（换一张 24 小时有效的证书）。
   *
   * 为什么要有这个入口：凭据层早就把「配对」做成了能力，但 CLI 侧从来没接过它——
   * 报错文案让人跑 `khy phone pair`，而那条命令当时并不存在（2026-11-17 实测）。
   * 提示指向一条不存在的命令，等于把人引到死路。
   *
   * 顺序有讲究：先建转发（凭据层的 HTTP 走 127.0.0.1:8896，没有转发就够不着
   * 设备），再配对。配对码在凭据层内部取——本机有 adb 时从通知栏读（见
   * phonePairCodeReader.js 的取舍说明），没有就只能靠 KHY_PAIR_CODE 或人工。
   */
  async function pair(options_ = {}) {
    const blocked = _gateBlocked();
    if (blocked) {
      return blocked;
    }
    const started = await ensureForward();
    if (!started.ok) {
      return started;
    }
    const identity = await _readDeviceIdentity();
    const enroll = identity.ok ? await _ensureDeviceLinkEnrolled(identity) : null;
    const res = await credential.ensure({
      deviceId: identity.ok ? identity.deviceId : '',
      force: options_.force === true,
    });
    if (!res.ok) {
      credentialReady = false;
      state.tokenLoaded = false;
      return res;
    }
    credentialReady = true;
    state.tokenLoaded = true;
    state.tokenLength = 0;
    return {
      ok: true,
      paired: true,
      deviceId: res.deviceId || (identity.ok ? identity.deviceId : ''),
      expiresInMs: credential.describe().expiresInMs,
      enroll,
    };
  }

  /** 凭据现状（诊断用）：不泄露私钥，也不回显证书内容。 */
  function credentialInfo() {
    return credential.describe();
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
    // adb pull 不会替你建父目录：目标路径的目录不存在时它直接回
    // "cannot create file/directory ... No such file or directory"——报错指向
    // adb，看起来像手机侧的问题，其实是主机侧少了一级目录。先建好。
    try {
      fs.mkdirSync(require('path').dirname(localPath), { recursive: true });
    } catch (e) {
      return {
        ok: false,
        code: 'local_dir_unwritable',
        error: `建不了本地目录 ${require('path').dirname(localPath)}：${(e && e.message) || e}`,
      };
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
    const findRes = await _runAdb(buildFindArgv(config, remoteDir), config.adbTimeoutMs);
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
    for (const candidate of collect.listCandidates({
        paths: found,
        remoteDir,
        maxDepth: options.maxDepth,
        includeUnknown: options.includeUnknown === true,
      })) {
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
    // 多根目录（collect-media 一次扫完手机上的媒体目录）；单目录时行为不变。
    const remoteDirs = (Array.isArray(options.remoteDirs) && options.remoteDirs.length
      ? options.remoteDirs
      : [String(options.remoteDir || '').trim()])
      .map((d) => String(d || '').trim())
      .filter(Boolean);
    const remoteDir = remoteDirs[0] || '';
    const localDir = String(options.localDir || '').trim();
    const types = Array.isArray(options.types) ? options.types : [];
    const maxFiles = Number(options.maxFiles) > 0
      ? Number(options.maxFiles)
      : PHONE_BRIDGE_MAX_COLLECT_FILES;
    const maxTotal = Number(options.maxTotalBytes) > 0
      ? Number(options.maxTotalBytes)
      : PHONE_BRIDGE_MAX_COLLECT_BYTES;
    const maxPerFile = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : PHONE_BRIDGE_MAX_TRANSFER_BYTES;
    const badDir = remoteDirs.find((d) => !d.startsWith('/'));
    if (badDir) {
      return { ok: false, code: 'invalid_path', error: `设备侧目录必须是绝对路径：${badDir}` };
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
    const files = [];
    const skipped = [];
    const scanned = [];
    const rootReports = [];
    let sinceUnknown = 0;
    for (const root of remoteDirs) {
      const one = await scanFiles({
        remoteDir: root,
        types,
        sinceMs: options.sinceMs,
        maxDepth: options.maxDepth,
        includeUnknown: options.includeUnknown === true,
      });
      if (!one.ok) {
        // 设备上没有这个目录是常态（机型不同目录就不同）：记一笔继续，不当失败
        rootReports.push({ root, ok: false, error: one.error });
        skipped.push({ root, reason: 'root_unavailable', error: one.error });
        continue;
      }
      rootReports.push({ root, ok: true, files: one.entries.length });
      sinceUnknown += one.sinceUnknown;
      for (const entry of one.entries) {
        scanned.push({ ...entry, root });
      }
      for (const item of one.skipped) {
        skipped.push({ ...item, root });
      }
    }
    const counts = {};
    let total = 0;
    let budgetHit = false;
    for (const item of scanned) {
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
      const root = item.root || remoteDir;
      const relative = item.remotePath.startsWith(`${root}/`)
        ? item.remotePath.slice(root.length + 1)
        : path.basename(item.remotePath);
      const rootName = path.basename(root) || 'root';
      // 类型分桶：图片/音频/视频/文本各归各的目录，一次采集也能分门别类。
      const localPath = options.bucketByType === true
        ? path.join(localDir, item.type || 'other', rootName, relative)
        : path.join(localDir, relative);
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
      remoteDirs,
      roots: rootReports,
      localDir,
      types,
      sinceMs: options.sinceMs === undefined ? null : Number(options.sinceMs),
      sinceUnknown,
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

  /**
   * 「这台手机现在能不能当开发机」的一页体检：adb、设备、串号、转发、桥心跳、令牌、采集通道，
   * 逐项给结论与下一步。夜间任务与排障都靠它，不再手工串六条命令。
   */
  async function doctor() {
    const checks = [];
    const next = [];

    checks.push({ name: 'adb 可执行文件', ok: true, detail: config.adbExecutable });

    let listed = { ok: false, devices: [] };
    try {
      listed = await listDevices();
    } catch {
      listed = { ok: false, devices: [] };
    }
    const readyDevices = listed.ok
      ? listed.devices.filter((d) => d.state === DEVICE_STATE_DEVICE)
      : [];
    const deviceReady = readyDevices.length > 0;
    checks.push({
      name: '设备在场',
      ok: deviceReady,
      detail: deviceReady
        ? readyDevices.map((d) => d.serial).join(', ')
        : 'adb devices 里没有 device 态条目',
    });
    if (!deviceReady) {
      next.push('手机没连上：确认与电脑同一局域网、无线调试已开启（adb mdns services 能看到 _adb-tls-connect 实例）');
    }

    const forwarded = await ensureForward();
    // 转发存在只证明隧道搭好了；桥的 HTTP 服务可能自己死了（端口没绑上）。
    // 真发一次 /ping 才算「HTTP 通道可用」——顺带让手机侧的 pc_reachable 反映这次体检。
    const pingRes = forwarded.ok === true ? await ping() : { ok: false, error: forwarded.error };

    checks.push({
      name: 'HTTP 通道',
      ok: forwarded.ok === true && pingRes.ok === true,
      detail: forwarded.ok !== true
        ? (forwarded.error || '转发未建立')
        : pingRes.ok === true
          ? `转发 tcp:${config.localPort} → tcp:${config.httpPort}，/ping 已回`
          : `转发已建立但 HTTP 无响应：${pingRes.error || '未知'}`,
    });
    if (forwarded.ok !== true) {
      next.push('端口转发没建起来：手机上的桥可能没在跑，khy phone revive 可拉回');
    } else if (pingRes.ok !== true) {
      next.push('HTTP 没回应：桥进程可能在但端口没绑上，khy phone revive 重启桥后重试');
    }

    // 端口扫描这一档的读数：只在手机不在场时才有话说——它是「上次的 IP 上
    // 到底有没有 adb 端口」的证据，把「无线调试没开」和「手机不在网」分开。
    // 扫描发生在上面的 ensureForward → ensureConnected 里，所以必须排在它之后。
    if (!deviceReady) {
      const scan = state.lastPortScan;
      checks.push({
        name: '上次手机端口扫描',
        ok: false,
        detail: scan
          ? `${scan.host}：开着 ${scan.openPorts.length} 个端口`
            + `（拒绝 ${scan.refused} / 不可达 ${scan.unreachable}，${scan.elapsedMs}ms）`
          : (state.lastDiscoveryScan && state.lastDiscoveryScan.reason === 'host-off-subnet'
            ? `${state.lastDiscoveryScan.host} 与本机（${state.lastDiscoveryScan.local}）不同网段，未扫描`
            : '未执行（没有可扫描的上次地址）'),
      });
    }

    // 串号在 ensureForward → ensureConnected 里才会被自动探测写回；必须排在它之后，
    // 否则会读到探测前的空串，报出「没有可用串号」却同时打着勾。
    const serialKnown = Boolean(config.serial) && (config.serialSource || 'env') !== 'default';
    checks.push({
      name: '串号已解析',
      ok: serialKnown,
      detail: serialKnown ? `${config.serial}（${config.serialSource}）` : '没有可用串号',
    });

    const beat = await probe();
    const toolCount = beat.ok && beat.status && Array.isArray(beat.status.tools) ? beat.status.tools.length : null;
    // 探不到心跳时，若上面已经查出了原因（连接档给的是可执行的诊断），就用它
    // 顶上——一屏里摆两条互相矛盾的「未发现手机」只会让人以为是两回事。
    const beatReason = beat.ok
      ? null
      : (beat.code === 'device_not_found' && forwarded.ok !== true && forwarded.error
        ? forwarded.error
        : (beat.error || '读不到 status.json'));
    checks.push({
      name: '桥心跳',
      ok: beat.ok === true,
      detail: beat.ok
        ? `running=${beat.status && beat.status.running === true}，工具 ${toolCount === null ? '?' : toolCount} 个`
          + (beat.statusFresh === false
            ? `；但 status.json 已 ${Math.round((beat.statusAgeMs || 0) / 1000)}s 未更新——这份快照本身不可信（手机侧写盘每拍都失败？先查「所有文件访问」）`
            : '')
        : beatReason,
    });
    if (beat.ok !== true && beat.code !== 'device_not_found') {
      next.push('桥服务没起来：khy phone revive 拉回它；仍不通就重启手机上的 khy-os App');
    }
    if (beat.ok === true && beat.statusFresh === false) {
      next.push('status.json 停更：手机大概率没授予「所有文件访问」（写盘每拍 EACCES）。'
        + '授予后自愈心跳会补写；停更期间本页所有字段都是旧快照');
    }

    // 断点二之后，「PC 能不能用桥」不再取决于某个落盘的共享秘密，而取决于
    // 两件各自可核的事：设备有没有一把只在私有目录的私钥，本机有没有一张
    // 未过期的设备签发证书。这两条分开报——合成一条「就绪」的话，失败时
    // 说不清该去手机还是该在 PC 上重配。
    const identity = beat.ok === true && beat.status ? beat.status.identity : null;
    const identityOk = Boolean(
      identity && identity.ok === true && identity.key_private_location === true,
    );
    checks.push({
      name: '设备身份（私钥在私有目录）',
      ok: identityOk,
      detail: identity
        ? `device_id=${identity.device_id || '?'}，私钥${identity.key_private_location === true ? '在' : '不在'}私有目录`
          + `（${identity.key_path || '?'}）`
        : '未知（旧版桥未上报 identity）',
    });
    if (identity && identity.key_private_location === false) {
      next.push('私钥不在 App 私有目录：这是断点二明令禁止的形态，重装 App 让它重新生成');
    }

    const cred = credential.describe();
    const credOk = cred.paired === true && cred.usable === true;
    checks.push({
      name: '本机凭据（设备签发的证书）',
      ok: credOk,
      detail: cred.paired
        ? `${cred.usable ? '可用' : '已过期'}，约 ${Math.round((cred.expiresInMs || 0) / 60000)} 分钟后到期（${cred.storePath}）`
        : '未配对：配对码显示在手机通知栏，只在那里',
    });
    if (!credOk) {
      next.push('本机没有可用凭据：配对一次即可，证书 24 小时有效（过期后需新的配对码）');
    }

    const ls = await _runAdb(buildLsArgv(config, config.mailboxDir), 10000);
    checks.push({
      name: '采集通道',
      ok: ls.ok === true,
      detail: ls.ok
        ? `信箱目录可读：${config.mailboxDir}`
        : '信箱目录读不了：手机可能没授予「所有文件访问」',
    });

    return {
      ok: true,
      ready: deviceReady && serialKnown && forwarded.ok === true && beat.ok === true
        && identityOk && credOk,
      serial: config.serial,
      checks,
      next,
    };
  }

  /**
   * 401 的三种可执行形态。桥回执里的 `code` 决定下一步：
   *
   * - `pairing_required` / `cert_invalid` / `device_mismatch` / `credential_expired`
   *   → 凭据本身没用了，清掉重配一次（重配需要新的配对码）。
   * - `pop_required` / `pop_stale` / `pop_invalid` → 凭据还在，是**这一条请求**
   *   的持有证明不对（时钟偏了、签名串不一致）。重配没用，重试也没用——这种
   *   情况必须原样报出去，否则会被当成「配对过期」反复重配，永远配不好。
   * - 其它 401 → 按普通失败处理，不猜。
   */
  const _CREDENTIAL_DEAD_CODES = new Set([
    'pairing_required', 'cert_invalid', 'device_mismatch', 'credential_expired',
  ]);
  const _POP_CODES = new Set(['pop_required', 'pop_stale', 'pop_invalid']);

  function _authFailure(res) {
    if (!res || res.status !== 401) {
      return null;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(res.body || '{}');
    } catch {
      return null;
    }
    if (!parsed || !parsed.code) return null;
    if (_CREDENTIAL_DEAD_CODES.has(parsed.code)) return { ...parsed, kind: 'credential' };
    if (_POP_CODES.has(parsed.code)) return { ...parsed, kind: 'pop' };
    return null;
  }

  function _authFailureReceipt(failure, verb) {
    if (failure.kind === 'pop') {
      return {
        ok: false,
        code: failure.code,
        error: `持有证明被拒（code=${failure.code}）：${verb}。`
          + '凭据还在，问题在这条请求的签名上——先查 PC 与手机的时钟差（窗口 60 秒），'
          + '再确认没有代理改写请求体。重配无效。',
      };
    }
    const hint = failure.code === 'credential_expired'
      ? '证书 24 小时到期了：重跑一次配对（手机通知栏会出新的配对码）。'
      : failure.code === 'device_mismatch'
        ? '这张证书不是这台设备签的（换过手机，或 adb 连到了另一台）：重新配对。'
        : '先配对：khy phone pair（配对码在手机通知栏）。';
    return { ok: false, code: failure.code, error: `${verb}：${hint}` };
  }

  async function _httpPost(pathname, payload, timeoutMs) {
    const url = `${config.baseUrl}${pathname}`;
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const signed = credential.signedHeaders({ method: 'POST', path: pathname, body });
    if (!signed.ok) {
      return { status: 0, body: '', ok: false, error: signed.error, code: signed.code };
    }
    const res = await httpTransport.request({
      method: 'POST',
      url,
      headers: signed.headers,
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
    let failure = null;
    let repaire = false;
    for (let attempt = 0; attempt <= config.retryCount; attempt += 1) {
      const res = await _httpPost(HTTP_PATHS.ping);
      if (res.ok) {
        state.lastHttpOkAt = new Date(now()).toISOString();
        state.lastHttpError = null;
        state.lastChannel = 'http';
        return { ok: true, channel: 'http', status: res.status, body: res.body };
      }
      if (res.status === 0 && res.code) {
        // 签名头都拼不出来（没有凭据 / 私钥读不出）：这不是 HTTP 失败，
        // 直接把它原样报出去，别包成「桥无响应」让人去查 adb。
        return { ok: false, code: res.code, error: res.error };
      }
      failure = _authFailure(res);
      if (failure && failure.kind === 'pop') {
        // 持有证明被拒：再发一次同样的签名只会得到同样的拒绝，还会把「第一个
        // 失败原因」冲掉。立刻返回。
        state.lastHttpError = failure.code;
        return _authFailureReceipt(failure, 'ping 未通');
      }
      if (failure && failure.kind === 'credential' && !repaire) {
        // 凭据死了（过期/换机/被清）：清掉缓存重配一次。/ping 只读，重放安全。
        // pop 类的失败**不**走这里：重配解决不了时钟或签名串的问题。
        repaire = true;
        credential.invalidate();
        credentialReady = false;
        await readToken(true);
        continue;
      }
      lastError = res.error || `HTTP ${res.status}`;
      if (attempt < config.retryCount) {
        await sleep(250 * (attempt + 1));
      }
    }
    if (failure) {
      state.lastHttpError = failure.error || failure.code;
      return _authFailureReceipt(failure, 'ping 未通');
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
    let res = await _httpPost(HTTP_PATHS.status);
    if (res.status === 0 && res.code) {
      return { ok: false, code: res.code, error: res.error };
    }
    // 凭据死了（过期/换机）：清掉重配一次再试——/status 只读，重放安全。
    let failure = _authFailure(res);
    if (failure && failure.kind === 'credential') {
      credential.invalidate();
      credentialReady = false;
      await readToken(true);
      res = await _httpPost(HTTP_PATHS.status);
      failure = _authFailure(res);
    }
    if (!res.ok) {
      state.lastHttpError = res.error || `HTTP ${res.status}`;
      if (failure) {
        state.lastHttpError = failure.error || failure.code;
        return _authFailureReceipt(failure, '读不到桥状态');
      }
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
    // 文件本身的新鲜度。2026-11-14 实测：未授「所有文件访问」时桥每拍写盘都
    // EACCES，status.json 会停在几小时前的快照上，而 probe 只读这一个文件——
    // 于是「pc_reachable:false」「token_persisted:true」全是旧进程的遗言。
    // 把 age 报出来，读的人才能区分「PC 真的不在」和「这份快照本身不可信」。
    // 阈值跟桥自己的 HEARTBEAT_STALE_MS 对齐：长 exec 会让 loop 正当地阻塞，
    // 短于此值的文件年龄不该报警。
    const ts = parsed && typeof parsed.ts === 'number' ? parsed.ts : null;
    const statusAgeMs = ts === null ? null : Math.max(0, now() - ts);
    // S1：同一份 status.json 的信箱事实交给唯一解析器（amooBridgePolicy），
    // 不在 probe 里再写一份对它的理解。tools 两形归一 + mailbox 块（含
    // oldest_result_age_ms / dropped）；status 原样透传，既有读者不变。
    const beat = parseBridgeStatus(parsed, { nowMs: now() });
    return {
      ok: true,
      channel: 'adb-shell',
      status: parsed,
      toolsCount: beat.tools,
      mailbox: beat.mailbox,
      httpPortBound: !!(parsed && Number(parsed.http_port) > 0),
      canWrite: !!(parsed && parsed.canWrite === true),
      uiAvailable: !!(parsed && parsed.ui === true),
      assistantAvailable: relay.available,
      relayWithheld: relay.withheld,
      statusAgeMs,
      statusFresh: statusAgeMs === null ? null : statusAgeMs <= STATUS_STALE_MS,
      // 断点二之后这个字段恒为 false：明文令牌已停写、旧文件已删。保留透传是
      // 为了老版本对照与 T5 的静态判据（`token_persisted:false` + 盘上没有
      // token.txt 才算「真的下线了」）。PC 不再据此判可用性。
      tokenPersisted: parsed && typeof parsed.token_persisted === 'boolean'
        ? parsed.token_persisted
        : null,
      // 桥自述「明文令牌已退役」。缺字段 = 旧版桥，判「未知」。
      tokenRetired: parsed && parsed.token_retired === true,
      // 设备身份（公钥指纹 + 私钥位置）。配对要用它，体检要报它。
      deviceIdentity: parsed && parsed.identity ? parsed.identity : null,
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
    let failure = null;
    let repaire = false;
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
      if (res.status === 0 && res.code) {
        // 没有可用凭据：这条命令根本没发出去，信箱兜底还能走完（信箱不靠凭据）。
        return { ok: false, retriable: true, error: res.error, code: res.code };
      }
      failure = _authFailure(res) || failure;
      if (failure && failure.kind === 'pop') {
        // 持有证明被拒：重发同一份签名没有意义。跳出重试，交给信箱兜底——
        // 信箱走 adb 文件通道，不需要凭据，这条命令还能执行完。
        lastError = failure.code;
        break;
      }
      if (failure && failure.kind === 'credential' && !repaire) {
        repaire = true;
        credential.invalidate();
        credentialReady = false;
        await readToken(true);
        continue;
      }
      lastError = res.error || `HTTP ${res.status}`;
      if (attempt < config.retryCount) {
        await sleep(250 * (attempt + 1));
      }
    }
    state.lastHttpError = lastError;
    if (failure) {
      // retriable 保持 true：信箱兜底不用凭据，这条 call 还能从文件信箱走完。
      // 把它判成 retriable:false 会把一条本可以成功的命令按死。
      return { ..._authFailureReceipt(failure, 'HTTP 通道未派发'), retriable: true };
    }
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
      // 出向链路登记（status 面）：reg_state / last_reg_ms / registration_source。
      // null = 本进程还没确认过（问 probe/pair 才会去问 admin 口）。
      registration: state.registration,
    };
  }

  function resetForTests() {
    credentialReady = false;
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
    state.registration = null;
    deviceLinkEnrollments.clear();
    deviceLinkProbeAt = 0;
    deviceLinkProbeBackedOff = false;
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
    doctor,
    ping,
    status,
    probe,
    revive,
    pair,
    credentialInfo,
    call,
    mailboxCall: (tool, args, opts) => mailbox.call(tool, args, opts),
    // 信箱卫生：重复执行、幂等的清理器（读后即删 + 残留清扫），供 daemon / 手工维护调用。
    mailboxSweep: (opts) => mailbox.sweep(opts),
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
