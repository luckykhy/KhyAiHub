'use strict';

/**
 * phoneBridgeConfig.js — pure leaf (zero IO, deterministic, never throws).
 *
 * Resolves every knob the phone bridge needs: which adb to spawn, which device
 * serial, which port the bridge listens on, where the token and the mailbox
 * live, and how long each step may take. Every default is imported from
 * constants/serviceDefaults.js so no host/port literal lives in product code;
 * every value is env-overridable through KHY_PHONE_BRIDGE_*.
 *
 * The adb path is resolved WITHOUT touching the filesystem: the caller injects
 * a `hasExecutable` probe (the IO shell passes fs.existsSync, tests pass a
 * stub). With no probe the resolver falls back to the bare executable name and
 * lets spawn resolve it against PATH — which fails loudly with a Chinese
 * message telling the user to set KHY_PHONE_BRIDGE_ADB, instead of silently
 * picking a wrong binary.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  PHONE_BRIDGE_DEFAULT_PORT,
  PHONE_BRIDGE_DEFAULT_SERIAL,
  PHONE_BRIDGE_ADB_FALLBACK,
  PHONE_BRIDGE_MAILBOX_DIR,
  PHONE_BRIDGE_TOKEN_REMOTE_PATH,
  PHONE_BRIDGE_HTTP_TIMEOUT_MS,
  PHONE_BRIDGE_ADB_TIMEOUT_MS,
  PHONE_BRIDGE_RETRY_COUNT,
  PHONE_BRIDGE_MAILBOX_POLL_MS,
  PHONE_BRIDGE_MAILBOX_TIMEOUT_MS,
} = require('../../../../constants/serviceDefaults');

const ADB_EXECUTABLE_NAMES = Object.freeze(
  process.platform === 'win32' ? ['adb.exe', 'adb'] : ['adb', 'adb.exe']
);

function _readString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function _readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function _readNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function _pathDirectories(env) {
  const raw = _readString(env.PATH) || _readString(env.Path);
  if (!raw) {
    return [];
  }
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Standard Android SDK install locations — the second place adb actually lives.
 * Measured on the dev box: adb at %LOCALAPPDATA%\Android\Sdk\platform-tools,
 * ANDROID_HOME unset and PATH untouched, so spawn's PATH lookup answered
 * `spawn adb.exe ENOENT` while a perfectly good adb sat two directories away.
 *
 * Candidates still go through the injected hasExecutable probe, so this leaf
 * stays zero-IO: no probe → no candidate probed → bare-name fallback unchanged.
 * `homedir` is injectable for tests; it defaults to os.homedir() (env lookup,
 * not file IO).
 */
function _sdkPlatformToolsDirs(env, homedir) {
  const dirs = [];
  for (const key of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const root = _readString(env[key]);
    if (root) {
      dirs.push(path.join(root, 'platform-tools'));
    }
  }
  if (homedir) {
    if (process.platform === 'win32') {
      dirs.push(path.join(homedir, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools'));
    } else if (process.platform === 'darwin') {
      dirs.push(path.join(homedir, 'Library', 'Android', 'sdk', 'platform-tools'));
    } else {
      dirs.push(path.join(homedir, 'Android', 'Sdk', 'platform-tools'));
    }
  }
  return dirs;
}

function _firstProbeHit(probe, dirs) {
  for (const dir of dirs) {
    for (const name of ADB_EXECUTABLE_NAMES) {
      const candidate = path.join(dir, name);
      let found = false;
      try {
        found = probe(candidate) === true;
      } catch {
        found = false;
      }
      if (found) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Ordered resolution: explicit env override -> first PATH hit -> first standard
 * SDK hit -> bare name. The bare-name fallback is deliberate: it is the only
 * option that works on a machine where adb is reachable through a shell alias or
 * a wrapper we cannot see, and its failure mode (ENOENT) is honest.
 */
function resolveAdbExecutable(env = process.env, options = {}) {
  const explicit = _readString(env.KHY_PHONE_BRIDGE_ADB);
  if (explicit) {
    return explicit;
  }
  const probe = typeof options.hasExecutable === 'function' ? options.hasExecutable : null;
  if (probe) {
    let homedir = _readString(options.homedir);
    if (!homedir) {
      try {
        homedir = os.homedir() || '';
      } catch {
        homedir = '';
      }
    }
    const hit = _firstProbeHit(probe, [
      ..._pathDirectories(env),
      ..._sdkPlatformToolsDirs(env, homedir),
    ]);
    if (hit) {
      return hit;
    }
  }
  return PHONE_BRIDGE_ADB_FALLBACK;
}

/**
 * 自动档：env 显式 > 检测到的设备 > 旧默认。检测本身要跑 adb（`adb devices` /
 * `adb mdns services`），是 IO——那是 phoneBridgeClient 的活；本叶子只收下
 * IO 层交来的结论（options.detectedSerial），保证零 IO。
 *
 * 旧默认（PHONE_BRIDGE_DEFAULT_SERIAL）是另一台机器的地址：没有检测结果时
 * 仍然回它，让失败信息指名道姓，而不是静默连到空处。
 */
function resolveDeviceSerial(env = process.env, options = {}) {
  const explicit = _readString(env.KHY_PHONE_BRIDGE_SERIAL);
  if (explicit) {
    return explicit;
  }
  const detected = _readString(options.detectedSerial);
  if (detected) {
    return detected;
  }
  return PHONE_BRIDGE_DEFAULT_SERIAL;
}

// adb devices 里能拿来当串行号的两种形态：IP:port（无线调试连上后的权威形态）
// 与 mDNS 实例名（自动 TLS 连接的设备在设备表里的形态）。
const SERIAL_IP_SHAPE = /^[\d.]+:\d+$/;
const SERIAL_MDNS_CONNECT_SUFFIX = '._adb-tls-connect._tcp';

/**
 * 自动档的候选判定（纯函数，IO 层把 adb 输出解析好再喂进来）。
 *
 * 实测：同一台手机在 `adb devices -l` 里会同时留下两条 state=device 条目——
 * IP:port 形态与 mDNS 实例名形态，同一条 transport 身份。「唯一」判定必须按
 * 物理身份归并（mdnsMap 把实例名映到 IP:port），否则一台真机会被误判成多台。
 *
 * 顺序：IP 形态 > 经 mdnsMap 归并的实例名 > 其它（USB 序列号）。归并后恰好
 * 一个物理身份才命中；多台真机一律 ambiguous（多候选列名要求 -s，由
 * buildAdbArgv 统一加），绝不猜。
 *
 * @param {{devices?: Array<{serial:string,state:string}>, mdnsMap?: object|null}} input
 * @returns {{ok:boolean, serial:string, source:string}}
 */
function pickDeviceSerial({ devices = [], mdnsMap = null } = {}) {
  const entries = (Array.isArray(devices) ? devices : []).filter(
    (d) => d && _readString(d.serial) && (d.state || '') === 'device'
  );
  const isIpForm = (s) => SERIAL_IP_SHAPE.test(s);
  const isMdnsForm = (s) => !isIpForm(s) && s.includes(SERIAL_MDNS_CONNECT_SUFFIX);

  const ipForm = [];
  const mdnsForm = [];
  const otherForm = [];
  for (const d of entries) {
    const s = _readString(d.serial);
    if (isIpForm(s)) {
      ipForm.push(s);
    } else if (isMdnsForm(s)) {
      mdnsForm.push(s);
    } else {
      otherForm.push(s);
    }
  }

  // identity -> 代表串行号（IP 形态优先）
  const identities = new Map();
  const adopt = (identity, repr) => {
    if (!identities.has(identity) || isIpForm(repr)) {
      identities.set(identity, repr);
    }
  };
  for (const s of ipForm) {
    adopt(s, s);
  }
  const mdnsUnmapped = [];
  for (const s of mdnsForm) {
    const mapped = mdnsMap && typeof mdnsMap === 'object' ? _readString(mdnsMap[s]) : '';
    if (mapped) {
      adopt(mapped, s);
    } else {
      mdnsUnmapped.push(s);
    }
  }
  for (const s of otherForm) {
    adopt(s, s);
  }

  if (identities.size === 1) {
    const repr = [...identities.values()][0];
    return {
      ok: true,
      serial: repr,
      source: isMdnsForm(repr) ? 'adb-devices-mdns' : 'adb-devices',
    };
  }
  // 恰好一个 IP 形态条目、其余身份全部来自无法归并的 mdns 实例名：优先 IP 形态。
  // 同一台手机的两种形态条目、而 mdns 服务没给出映射时，不该把唯一真机判成多台。
  // 真正多台（两个不同 IP / USB+IP / mdns 映射到别的 host）仍走 ambiguous。
  const unmappedIdentities = new Set(mdnsUnmapped);
  if (ipForm.length === 1 && unmappedIdentities.size > 0
      && identities.size === 1 + unmappedIdentities.size) {
    return { ok: true, serial: ipForm[0], source: 'adb-devices-prefer-ip' };
  }
  if (identities.size === 0) {
    return { ok: false, serial: '', source: 'none' };
  }
  return { ok: false, serial: '', source: 'ambiguous' };
}

/**
 * 设备表没有任何 device 态条目时的兜底档：`adb mdns services` 里
 * `_adb-tls-connect` 实例的 host:port。只取 connect 实例——pairing 实例是
 * 配对档口，对它跑 `adb pair` 会 protocol fault 且配不上任何东西。
 */
function pickMdnsSerial(instances = []) {
  const uniq = [...new Set(
    (Array.isArray(instances) ? instances : []).map((value) => _readString(value)).filter(Boolean)
  )];
  if (uniq.length === 1) {
    return { ok: true, serial: uniq[0], source: 'adb-mdns' };
  }
  return { ok: false, serial: '', source: uniq.length > 1 ? 'ambiguous' : 'none' };
}

function resolveHttpPort(env = process.env) {
  return _readPositiveInt(env.KHY_PHONE_BRIDGE_PORT, PHONE_BRIDGE_DEFAULT_PORT);
}

/**
 * The loopback base URL is built by interpolation, never pinned as a literal:
 * the phone bridge only listens on 8896 on the device and is reached here
 * through `adb forward tcp:<port> tcp:<port>`, so 127.0.0.1 is the transport,
 * not a configured endpoint. This deliberately bypasses
 * services/urlSafety.js assertPublicHttpUrlResolved, which rejects loopback and
 * private literals by design — that guard protects OUTBOUND calls to public
 * hosts, and this one is a tunnel to the user's own device.
 */
function buildLoopbackBaseUrl(port, host = '127.0.0.1') {
  const safePort = _readPositiveInt(port, PHONE_BRIDGE_DEFAULT_PORT);
  const safeHost = _readString(host) || '127.0.0.1';
  return `http://${safeHost}:${safePort}`;
}

function resolveMailboxDir(env = process.env) {
  const explicit = _readString(env.KHY_PHONE_BRIDGE_MAILBOX_DIR);
  return explicit || PHONE_BRIDGE_MAILBOX_DIR;
}

function resolveTokenRemotePath(env = process.env) {
  const explicit = _readString(env.KHY_PHONE_BRIDGE_TOKEN_PATH);
  if (explicit) {
    return explicit;
  }
  // Only fall back to the mailbox-derived default when the mailbox dir itself
  // is at its default; an overridden mailbox dir with the default token path
  // would point at a directory that does not exist.
  if (_readString(env.KHY_PHONE_BRIDGE_MAILBOX_DIR)) {
    return `${resolveMailboxDir(env)}/token.txt`;
  }
  return PHONE_BRIDGE_TOKEN_REMOTE_PATH;
}

/**
 * 同机发现结果的共享落点：`<userDataDir>/phone/discovery.json`。
 *
 * 两条桥（本单元 PC→手机 8896、delivery/extension/bridges/khy-amoon-bridge
 * 的 KhyOS↔amoon 18765）各自做 adb 发现，但目标常常是同一台手机。把探测结果
 * 写成一个运行时文件，另一条桥读它当兜底候选——共享的是**数据**，不是代码，
 * 所以 runtime/ 不必反向依赖 delivery/（层级规范），任一方缺席也都能独立工作。
 *
 * 纯叶子：只拼路径，不做 IO，不判断存在性。
 */
function discoveryFile(env = process.env, options = {}) {
  const explicit = _readString(env.KHY_PHONE_DISCOVERY_FILE);
  if (explicit) {
    return explicit;
  }
  let base = _readString(options.userDataDir);
  if (!base) {
    try {
      base = os.homedir() || '';
    } catch {
      base = '';
    }
  }
  if (!base) {
    return '';
  }
  return path.join(base, '.khyquant', 'phone', 'discovery.json');
}

function resolveTimeouts(env = process.env) {  return {
    httpTimeoutMs: _readPositiveInt(env.KHY_PHONE_BRIDGE_HTTP_TIMEOUT_MS, PHONE_BRIDGE_HTTP_TIMEOUT_MS),
    adbTimeoutMs: _readPositiveInt(env.KHY_PHONE_BRIDGE_ADB_TIMEOUT_MS, PHONE_BRIDGE_ADB_TIMEOUT_MS),
    retryCount: _readNonNegativeInt(env.KHY_PHONE_BRIDGE_RETRY_COUNT, PHONE_BRIDGE_RETRY_COUNT),
    mailboxPollMs: _readPositiveInt(
      env.KHY_PHONE_BRIDGE_MAILBOX_POLL_MS,
      PHONE_BRIDGE_MAILBOX_POLL_MS
    ),
    mailboxTimeoutMs: _readPositiveInt(
      env.KHY_PHONE_BRIDGE_MAILBOX_TIMEOUT_MS,
      PHONE_BRIDGE_MAILBOX_TIMEOUT_MS
    ),
  };
}

/**
 * The full resolved picture. `localPort` is the PC-side forward port, which the
 * task brief called 8898 — kept as an alias so brief-compatible scripts keep
 * working, but the phone only ever listens on 8896.
 */
function resolvePhoneBridgeConfig(env = process.env, options = {}) {
  const httpPort = resolveHttpPort(env);
  const timeouts = resolveTimeouts(env);
  const mailboxDir = resolveMailboxDir(env);
  const serial = resolveDeviceSerial(env, options);
  return {
    adbExecutable: resolveAdbExecutable(env, options),
    serial,
    // serial 的来源，供 IO 层决定要不要走自动档（default → 探测并写回）。
    serialSource: _readString(env.KHY_PHONE_BRIDGE_SERIAL)
      ? 'env'
      : serial !== PHONE_BRIDGE_DEFAULT_SERIAL ? 'auto' : 'default',
    httpPort,
    localPort: _readPositiveInt(env.KHY_PHONE_BRIDGE_LOCAL_PORT, httpPort),
    loopbackHost: '127.0.0.1',
    baseUrl: buildLoopbackBaseUrl(httpPort),
    mailboxDir,
    tokenRemotePath: resolveTokenRemotePath(env),
    statusRemotePath: `${mailboxDir}/status.json`,
    ...timeouts,
  };
}

/**
 * The default "does this executable exist" probe.
 *
 * WHY THIS EXISTS. `resolveAdbExecutable(env)` with no probe returns the bare
 * fallback name (`adb.exe`), which only works when adb is on PATH. On this
 * machine it is not — it lives at `~/.khyos/android_sdk/platform-tools/adb.exe`,
 * which `_sdkPlatformToolsDirs` already knows how to find. So the bare call
 * resolves to a name `spawn` cannot execute, and the caller gets ENOENT with
 * nothing pointing at the real path.
 *
 * The client had this probe inline. A second consumer (stepneoCloud, which runs
 * `adb logcat` to read the account token) needed the same resolution, and two
 * inline copies of a probe is how they drift — so it is one exported function
 * now and the client calls it too.
 */
function defaultExecutableProbe(candidate) {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}

/** resolveAdbExecutable with the default probe applied. */
function resolveAdbExecutableProbed(env = process.env, options = {}) {
  return resolveAdbExecutable(env, {
    ...options,
    hasExecutable: typeof options.hasExecutable === 'function'
      ? options.hasExecutable
      : defaultExecutableProbe,
  });
}

module.exports = {
  ADB_EXECUTABLE_NAMES,
  resolveAdbExecutable,
  resolveAdbExecutableProbed,
  defaultExecutableProbe,
  resolveDeviceSerial,
  resolveHttpPort,
  resolveMailboxDir,
  resolveTokenRemotePath,
  resolveTimeouts,
  buildLoopbackBaseUrl,
  pickDeviceSerial,
  pickMdnsSerial,
  discoveryFile,
  resolvePhoneBridgeConfig,
};
