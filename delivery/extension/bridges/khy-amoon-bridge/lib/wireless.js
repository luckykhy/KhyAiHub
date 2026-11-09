'use strict';

/**
 * wireless.js — device discovery, reconnection, reverse and heartbeat.
 *
 * The measured workstation exposes the same phone through two ADB transports
 * at once (an IP:port entry and an mDNS entry). Therefore:
 *   - serial resolution dedupes transports by `ro.serialno` before deciding;
 *   - two *different* physical devices raise `device_ambiguous` instead of
 *     silently picking one;
 *   - every reverse/heartbeat command carries the resolved `-s <serial>`
 *     (the Transport enforces this).
 *
 * This module never builds a phone command from raw user input. The only
 * device text is the fixed `curl --noproxy '*' ...` health probe and
 * `getprop <name>` with a quoted property name.
 *
 * `start()` is intentionally non-fatal: a missing phone must not crash the
 * daemon; the bridge goes DEGRADED_ADB and retries with 1/2/4/8/16/30s backoff.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const C = require('./contracts');
const adbLib = require('./adb');

const RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
const STATE_INTERVAL_MS = 15000;
const REVERSE_INTERVAL_MS = 30000;
const CONNECT_TIMEOUT_MS = 10000;
const PROBE_TIMEOUT_MS = 6000;
// detectedAt was written by both discovery producers but checked by no reader:
// this workstation once carried a 2023 entry, and adopting its address means a
// blind `adb connect` with no rollback afterwards. Older than this TTL the file
// counts as "that bridge never ran", never as a live device.
const DISCOVERY_TTL_MS = 5 * 60 * 1000;
const SERIAL_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function fail(code, message, details) {
  return new C.BridgeError(code, message, details);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/** Persisted physical identity so an IP:port reassignment cannot silently switch phones. */
function identityFileFor(config) {
  const dir = (config && config.paths && config.paths.stateDir) || (config && config.stateDir);
  return dir ? path.join(dir, 'device.json') : null;
}

function readIdentity(file) {
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data.serial === 'string' && data.serial ? data.serial : null;
  } catch {
    return null;
  }
}

function writeIdentity(file, serial) {
  if (!file || !serial) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ serial, at: new Date().toISOString() })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
  } catch {
    // identity persistence is best effort; the in-memory value still works
  }
}

function isTransportAddress(serial) {
  return typeof serial === 'string' && /:\d+$/.test(serial);
}

/**
 * 同机发现结果的共享落点，与 runtime/node/backend 的 phoneBridgeConfig.discoveryFile()
 * 同一个路径约定（`<home>/.khyquant/phone/discovery.json`，KHY_PHONE_DISCOVERY_FILE 可覆盖）。
 *
 * 两条桥看的是同一台手机，但**不互相 require**：runtime/ 不能反向依赖 delivery/，
 * 而这层只需要一个文件约定。任何异常都返回 null——文件不存在就是「那条桥没跑过」，
 * 与「设备不可用」是两件事，不能混。
 *
 * Freshness is enforced the same way: an entry whose detectedAt is older than
 * DISCOVERY_TTL_MS (or missing/unparseable — fail closed) also returns null.
 * Adopting a stale address is a blind `adb connect` with no rollback, so it
 * counts as "that bridge never ran" instead.
 */
function readSharedDiscovery() {
  const file = process.env.KHY_PHONE_DISCOVERY_FILE
    || path.join(os.homedir(), '.khyquant', 'phone', 'discovery.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const serial = data && typeof data.serial === 'string' ? data.serial.trim() : '';
    if (!serial || !SERIAL_RE.test(serial) || serial.startsWith('-')) return null;
    const detectedAt = Date.parse(data.detectedAt);
    if (!Number.isFinite(detectedAt) || Date.now() - detectedAt > DISCOVERY_TTL_MS) return null;
    return { serial, source: typeof data.source === 'string' ? data.source : 'shared' };
  } catch {
    return null;
  }
}

function looksLikeMdnsSerial(serial) {
  return typeof serial === 'string' && (/[\s()]/.test(serial) || serial.includes('_adb-tls'));
}

/**
 * Create the wireless lifecycle.
 *
 * Additive helpers beyond the design sketch: `resolveSerial`, `connect`,
 * `removeReverse`, `probeReverse`, `reverseList`, `pairHint`, `snapshot`.
 *
 * @param {{
 *   config?: object,
 *   transport?: object,
 *   logger?: object,
 *   onState?: (state:string, meta:object)=>void,
 *   clock?: ()=>number,
 *   expectedSerial?: string,
 * }} [options]
 */
function createWireless(options = {}) {
  const config = options.config || {};
  const logger = options.logger || silentLogger;
  const adb = options.transport || adbLib.createAdbTransport({ config, logger });
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const onState = typeof options.onState === 'function' ? options.onState : null;
  const expectedSerialOption = typeof options.expectedSerial === 'string' ? options.expectedSerial : null;

  let state = config.enabled === false ? C.STATES.DISABLED : C.STATES.STOPPED;
  let stateReason = '';
  let lastError = null;
  let lastSeen = null;
  let resolved = null;
  let lastGoodSerial = null;
  const identityFile = options.identityFile || identityFileFor(config);
  let lastDeviceSerial = readIdentity(identityFile);
  let failureCount = 0;
  let retryIndex = 0;
  let retryTimer = null;
  let stateTimer = null;
  let reverseTimer = null;
  let stopped = true;
  let checking = false;
  let activePort = null;
  let probeEnabled = true;
  let reverseState = { port: null, mapped: false, lastOk: null, lastError: null };

  function setState(next, reason, meta = {}) {
    const previous = state;
    state = next;
    stateReason = reason || '';
    if (previous !== next) {
      logger.info('wireless state change', { from: previous, to: next, reason: stateReason });
      if (onState) {
        try {
          onState(next, { from: previous, reason: stateReason, ...meta });
        } catch (err) {
          logger.warn('onState callback failed', { error: String(err && err.message) });
        }
      }
    }
  }

  function requireAdb() {
    if (!adb || typeof adb.host !== 'function') {
      throw fail('adb_unavailable', 'ADB transport 未初始化');
    }
    return adb;
  }

  function currentSerial() {
    if (resolved && resolved.serial) return resolved.serial;
    if (typeof adb.getSerial === 'function') {
      const value = adb.getSerial();
      if (value) return value;
    }
    return config.serial || null;
  }

  function expectedDeviceSerial() {
    if (expectedSerialOption) return expectedSerialOption;
    const configured = config.serial || null;
    if (!configured) return lastDeviceSerial;
    // KHY_AMOON_SERIAL may be a transport address, not ro.serialno.
    if (isTransportAddress(configured) || looksLikeMdnsSerial(configured)) return lastDeviceSerial;
    return configured;
  }

  async function hostOk(argv, opts = {}) {
    const transport = requireAdb();
    const result = await transport.host(argv, opts);
    if (result.timedOut) {
      throw fail('timeout', `adb 命令超时：${argv.join(' ')}`);
    }
    if (result.exit !== 0) {
      const detail = String(result.stderr || '').trim().slice(0, 300) || `退出码 ${result.exit}`;
      throw fail('adb_unavailable', `adb 命令失败：${detail}`, { argv: argv.join(' ') });
    }
    return result.stdout;
  }

  async function listDevices() {
    const text = await hostOk(['devices', '-l'], { serial: false, timeoutMs: 10000, maxBytes: 256 * 1024 });
    return adbLib.parseDevices(text);
  }

  async function listMdns() {
    const text = await hostOk(['mdns', 'services'], { serial: false, timeoutMs: 10000, maxBytes: 256 * 1024 });
    return adbLib.parseMdns(text);
  }

  async function getStateOf(serial) {
    const text = await hostOk(['get-state'], { serial, timeoutMs: 5000, maxBytes: 16 * 1024 });
    return text.trim();
  }

  async function getProp(serial, name) {
    try {
      const text = await hostOk(['shell', `getprop ${adbLib.shQuote(name)}`], {
        serial,
        timeoutMs: 5000,
        maxBytes: 64 * 1024,
      });
      const value = text.trim();
      return value || null;
    } catch {
      return null;
    }
  }

  async function refreshDeviceInfo(serial) {
    const model = await getProp(serial, 'ro.product.model');
    const sdkRaw = await getProp(serial, 'ro.build.version.sdk');
    const sdk = sdkRaw && /^\d+$/.test(sdkRaw) ? Number(sdkRaw) : null;
    if (typeof adb.setDeviceInfo === 'function') adb.setDeviceInfo({ model, sdk });
    return { model, sdk };
  }

  async function verifyIdentity(serial) {
    const expected = expectedDeviceSerial();
    const actual = await getProp(serial, 'ro.serialno');
    if (expected && actual && actual !== expected) {
      throw fail('invalid_config', `设备身份不匹配：期望 ${expected}，实际 ${actual}`, {
        reason: 'serial_mismatch',
        serial,
      });
    }
    // First contact through an IP:port/none config has no expected serial.
    // Record ro.serialno now so a later DHCP reassignment fails closed instead
    // of silently accepting whichever phone answered.
    if (actual && actual !== lastDeviceSerial) {
      lastDeviceSerial = actual;
      writeIdentity(identityFile, actual);
    }
    return actual;
  }

  function accept(serial, transportId, source, extra = {}) {
    if (typeof adb.setSerial === 'function') adb.setSerial(serial);
    const deviceSerial = extra.deviceSerial || lastDeviceSerial || null;
    if (deviceSerial && deviceSerial !== lastDeviceSerial) {
      lastDeviceSerial = deviceSerial;
      writeIdentity(identityFile, deviceSerial);
    }
    lastGoodSerial = serial;
    lastSeen = clock();
    resolved = {
      serial,
      transportId: transportId === undefined ? null : transportId,
      deviceSerial,
      source,
    };
    logger.info('adb serial resolved', { serial, source, deviceSerial });
    return { ...resolved };
  }

  function chooseTransport(group, configured) {
    if (configured) {
      const exact = group.find((entry) => entry.serial === configured);
      if (exact) return exact;
    }
    // Prefer a plain USB/IP transport over the mDNS instance name: it is
    // shorter, stable across mDNS renames and accepted by all adb versions.
    const plain = group.find((entry) => !looksLikeMdnsSerial(entry.serial) && !entry.serial.includes(' '));
    if (plain) return plain;
    return group[0];
  }

  function ambiguousError(groups) {
    const candidates = [...groups.entries()].map(([deviceSerial, entries]) => ({
      deviceSerial,
      transports: entries.map((entry) => entry.serial),
    }));
    return fail('device_ambiguous', '检测到多台设备，请显式设置 KHY_AMOON_SERIAL 指定目标设备。', {
      candidates,
    });
  }

  /**
   * Resolve the transport serial from KHY_AMOON_SERIAL, `adb devices -l`, or
   * mDNS (in that order). Dedupes multiple transports of the same phone.
   *
   * @param {{force?: boolean, includeMdns?: boolean}} [opts]
   * @returns {Promise<{serial:string,transportId:number|null,deviceSerial:string|null,source:string}>}
   */
  async function resolveSerial(opts = {}) {
    if (resolved && !opts.force) return { ...resolved };

    const configured = config.serial || null;
    let devices = [];
    try {
      devices = await listDevices();
    } catch (err) {
      lastError = { code: err.code || 'adb_unavailable', message: err.message, at: iso(clock()) };
      throw err;
    }

    const usable = devices.filter((entry) => entry.state === 'device' && !entry.serial.startsWith('-'));

    if (configured) {
      const exact = usable.find((entry) => entry.serial === configured);
      if (exact) {
        // A DHCP address can be reassigned: verify ro.serialno against the
        // last known physical device when one is known.
        const verified = await verifyIdentity(exact.serial);
        const info = accept(exact.serial, exact.transportId, 'config', {
          deviceSerial: verified || lastDeviceSerial,
        });
        await refreshDeviceInfo(info.serial);
        return info;
      }
      if (isTransportAddress(configured)) {
        try {
          const connected = await connect(configured);
          const info = accept(configured, null, 'config-connect', { deviceSerial: connected.deviceSerial });
          await refreshDeviceInfo(info.serial);
          return info;
        } catch (err) {
          lastError = { code: err.code || 'adb_unavailable', message: err.message, at: iso(clock()) };
          // Fall through to discovery; another transport may still reach it.
        }
      }
    }

    // Dedupe by physical device identity, not by transport name.
    const groups = new Map();
    for (const entry of usable) {
      const ro = await getProp(entry.serial, 'ro.serialno');
      const key = ro || `unknown:${entry.serial}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...entry, deviceSerial: ro });
    }

    // 同机另一条桥（khy phone，PC→手机 8896）已经探测到过哪台设备？它把结果写在
    // 共享发现文件里。只有「用户没显式配置 serial、且设备表里没有任何可用设备」时
    // 才采用——显式配置永远优先于别的进程写的文件，否则一台机器上两条桥会互相劫持
    // 对方的设备选择。读不到/读坏一律忽略：这是加强，不是依赖。
    if (usable.length === 0 && !configured) {
      const shared = readSharedDiscovery();
      if (shared && isTransportAddress(shared.serial)) {
        try {
          const connected = await connect(shared.serial);
          const info = accept(shared.serial, null, 'shared-discovery', {
            deviceSerial: connected.deviceSerial,
          });
          await refreshDeviceInfo(info.serial);
          return info;
        } catch (err) {
          lastError = { code: err.code || 'adb_unavailable', message: err.message, at: iso(clock()) };
        }
      }
    }

    if (groups.size === 1) {
      const group = [...groups.values()][0];
      const chosen = chooseTransport(group, configured);
      const source = group.length > 1 ? 'dedupe' : 'devices';
      const info = accept(chosen.serial, chosen.transportId, source, {
        deviceSerial: chosen.deviceSerial || lastDeviceSerial,
      });
      await refreshDeviceInfo(info.serial);
      return info;
    }

    if (groups.size > 1) {
      if (configured && groups.has(configured)) {
        const group = groups.get(configured);
        const chosen = chooseTransport(group, configured);
        const info = accept(chosen.serial, chosen.transportId, 'config-device', {
          deviceSerial: configured,
        });
        await refreshDeviceInfo(info.serial);
        return info;
      }
      if (lastDeviceSerial && groups.has(lastDeviceSerial)) {
        const group = groups.get(lastDeviceSerial);
        const chosen = chooseTransport(group, configured);
        const info = accept(chosen.serial, chosen.transportId, 'last_good', {
          deviceSerial: lastDeviceSerial,
        });
        await refreshDeviceInfo(info.serial);
        return info;
      }
      throw ambiguousError(groups);
    }

    // No connected transport: try every mDNS connect endpoint once.
    if (opts.includeMdns !== false) {
      let services = [];
      try {
        services = await listMdns();
      } catch (err) {
        logger.warn('mdns discovery failed', { error: String(err && err.message) });
      }
      const tried = new Set();
      for (const service of services) {
        if (service.kind !== 'connect') continue;
        if (tried.has(service.address)) continue;
        tried.add(service.address);
        try {
          const connected = await connect(service.address);
          const info = accept(service.address, null, 'mdns', {
            deviceSerial: connected.deviceSerial || lastDeviceSerial,
          });
          await refreshDeviceInfo(info.serial);
          return info;
        } catch (err) {
          lastError = { code: err.code || 'adb_unavailable', message: err.message, at: iso(clock()) };
        }
      }
    }

    throw fail(
      'adb_unavailable',
      '未发现可用设备。请确认手机已开启无线调试、与 PC 同网，并运行 `adb connect <ip:port>`；必要时先 `adb pair`。',
      {
        hint: '本桥不会自动输入配对码，也不会 kill adb server。',
        candidates: devices.map((entry) => ({ serial: entry.serial, state: entry.state })),
      }
    );
  }

  /**
   * Connect to an `ip:port` endpoint and verify it is a usable device.
   *
   * @param {string} address
   */
  async function connect(address) {
    if (typeof address !== 'string' || !SERIAL_RE.test(address) || address.startsWith('-')) {
      throw fail('invalid_args', `非法的设备地址：${String(address)}`);
    }
    const output = await hostOk(['connect', address], {
      serial: false,
      timeoutMs: CONNECT_TIMEOUT_MS,
      maxBytes: 64 * 1024,
    });
    if (/failed to connect|unable to connect|cannot connect|error:/i.test(output)) {
      throw fail('adb_unavailable', `无法连接 ${address}：${output.trim().slice(0, 200)}`);
    }
    const stateText = await getStateOf(address);
    if (stateText !== 'device') {
      const hint =
        stateText === 'unauthorized'
          ? '请在手机上允许 USB 调试并勾选“始终允许”。'
          : stateText === 'offline'
            ? '设备 offline：先 adb disconnect 再重连。'
            : '';
      throw fail('adb_unavailable', `设备状态为 ${stateText || 'unknown'}。${hint}`, { address });
    }
    const deviceSerial = await verifyIdentity(address);
    if (typeof adb.setSerial === 'function') adb.setSerial(address);
    lastSeen = clock();
    lastGoodSerial = address;
    if (deviceSerial) lastDeviceSerial = deviceSerial;
    return { serial: address, deviceSerial, state: stateText };
  }

  function validatePort(port) {
    const value = port === undefined || port === null ? config.port || C.DEFAULTS.port : Number(port);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) {
      throw fail('invalid_config', `端口必须在 1024..65535：${String(port)}`);
    }
    return value;
  }

  async function reverseList() {
    const text = await hostOk(['reverse', '--list'], { timeoutMs: 10000, maxBytes: 64 * 1024 });
    return adbLib.parseReverseList(text);
  }

  async function hasReverse(port) {
    const entries = await reverseList();
    return entries.some((entry) => entry.remotePort === port && entry.localPort === port);
  }

  async function addReverse(port) {
    const output = await hostOk(['reverse', `tcp:${port}`, `tcp:${port}`], {
      timeoutMs: 10000,
      maxBytes: 64 * 1024,
    });
    if (/error|failed|cannot|refused/i.test(output)) {
      throw fail('adb_unavailable', `adb reverse 失败：${output.trim().slice(0, 200)}`);
    }
    return hasReverse(port);
  }

  async function removeReverse(port) {
    const value = validatePort(port);
    try {
      await hostOk(['reverse', '--remove', `tcp:${value}`], { timeoutMs: 10000, maxBytes: 64 * 1024 });
    } catch (err) {
      // "reverse not found" is expected when the mapping already vanished.
      logger.warn('reverse remove reported an error', { error: String(err && err.message) });
    }
    let mapped = false;
    try {
      mapped = await hasReverse(value);
    } catch {
      mapped = false;
    }
    if (!mapped) {
      reverseState = { port: value, mapped: false, lastOk: reverseState.lastOk, lastError: null };
      if (typeof adb.setReverse === 'function') adb.setReverse({ port: value, mapped: false });
    }
    return { removed: !mapped, stillMapped: mapped };
  }

  async function probeReverse(port, opts = {}) {
    const value = validatePort(port);
    const seconds = Math.max(1, Math.floor((opts.timeoutMs || PROBE_TIMEOUT_MS) / 1000) - 1);
    const command = `curl --noproxy '*' -sS --max-time ${seconds} http://127.0.0.1:${value}/health`;
    let result;
    try {
      result =
        typeof adb.shell === 'function'
          ? await adb.shell(command, { timeoutMs: opts.timeoutMs || PROBE_TIMEOUT_MS, maxBytes: 64 * 1024 })
          : await adb.host(['shell', command], {
              timeoutMs: opts.timeoutMs || PROBE_TIMEOUT_MS,
              maxBytes: 64 * 1024,
            });
    } catch (err) {
      return { ok: false, port: value, error: { code: err.code || 'adb_unavailable', message: err.message } };
    }
    const output = String(result.stdout || '').trim().slice(0, 500);
    const ok = !result.timedOut && result.exit === 0 && /"ok"\s*:\s*true/.test(output);
    return {
      ok,
      port: value,
      exit: result.exit,
      output,
      error: ok
        ? null
        : {
            code: result.timedOut ? 'timeout' : 'adb_unavailable',
            message: output || String(result.stderr || '').trim().slice(0, 200) || 'reverse 健康探测失败',
          },
    };
  }

  /**
   * Ensure `reverse tcp:<port> tcp:<port>` for this serial. Never uses
   * `--remove-all`; only this port is managed.
   *
   * @param {number} port
   * @param {{probe?: boolean}} [opts]
   * @returns {Promise<{mapped:boolean,rebuilt:boolean,port:number,probe?:object,error?:object}>}
   */
  async function ensureReverse(port, opts = {}) {
    const value = validatePort(port);
    activePort = value;
    reverseState.port = value;
    let rebuilt = false;
    try {
      if (!currentSerial()) await resolveSerial({ force: true });
      let mapped = await hasReverse(value);
      if (!mapped) {
        try {
          mapped = await addReverse(value);
        } catch (firstError) {
          logger.warn('reverse add failed; rebuilding once', {
            error: String(firstError && firstError.message),
          });
          await removeReverse(value);
          rebuilt = true;
          mapped = await addReverse(value);
        }
      }
      reverseState.mapped = mapped;
      if (mapped) {
        reverseState.lastOk = iso(clock());
        reverseState.lastError = null;
      }
      if (typeof adb.setReverse === 'function') {
        adb.setReverse({ port: value, mapped, lastOk: reverseState.lastOk });
      }

      let probeResult;
      if (opts.probe && mapped) {
        probeResult = await probeReverse(value);
        if (!probeResult.ok) {
          logger.warn('reverse health probe failed; rebuilding once', { port: value });
          await removeReverse(value);
          rebuilt = true;
          mapped = await addReverse(value);
          reverseState.mapped = mapped;
          if (mapped) {
            reverseState.lastOk = iso(clock());
            reverseState.lastError = null;
          }
          probeResult = await probeReverse(value);
        }
        if (!probeResult.ok) {
          reverseState.mapped = false;
          reverseState.lastError = probeResult.error;
          if (typeof adb.setReverse === 'function') adb.setReverse({ port: value, mapped: false });
          setState(C.STATES.DEGRADED_REVERSE, probeResult.error ? probeResult.error.message : 'reverse 探测失败');
          return { mapped: false, rebuilt, port: value, probe: probeResult, error: probeResult.error };
        }
      }

      if (mapped) {
        setState(C.STATES.HEALTHY, 'reverse ok');
      } else {
        const error = { code: 'adb_unavailable', message: 'adb reverse 未建立' };
        reverseState.mapped = false;
        reverseState.lastError = error;
        setState(C.STATES.DEGRADED_REVERSE, error.message);
        return { mapped: false, rebuilt, port: value, probe: probeResult, error };
      }
      return { mapped: true, rebuilt, port: value, probe: probeResult };
    } catch (err) {
      const error = { code: err.code || 'adb_unavailable', message: err.message };
      reverseState.mapped = false;
      reverseState.lastError = error;
      lastError = { ...error, at: iso(clock()) };
      if (typeof adb.setReverse === 'function') adb.setReverse({ port: value, mapped: false });
      setState(C.STATES.DEGRADED_REVERSE, error.message);
      logger.warn('ensureReverse failed', { port: value, error: error.message });
      return { mapped: false, rebuilt, port: value, error };
    }
  }

  async function heartbeat() {
    if (config.enabled === false) {
      setState(C.STATES.DISABLED, 'KHY_AMOON_ENABLED=0');
      return snapshot();
    }
    if (checking) return snapshot();
    checking = true;
    try {
      let serial = currentSerial();
      if (!serial) {
        const info = await resolveSerial({ force: true });
        serial = info.serial;
      }
      const stateText = await getStateOf(serial);
      if (stateText !== 'device') {
        throw fail('adb_unavailable', `设备状态为 ${stateText || 'unknown'}`, { serial });
      }
      failureCount = 0;
      retryIndex = 0;
      lastSeen = clock();
      lastError = null;

      let reverseOk = true;
      if (activePort) {
        const reverse = await ensureReverse(activePort, { probe: probeEnabled });
        reverseOk = reverse.mapped;
      }
      if (reverseOk) setState(C.STATES.HEALTHY, 'heartbeat ok');
    } catch (err) {
      failureCount += 1;
      const error = {
        code: err.code || 'adb_unavailable',
        message: err.message,
        at: iso(clock()),
      };
      lastError = error;
      logger.warn('heartbeat failed', { failures: failureCount, error: error.message });
      // Design: degrade only after two consecutive failures.
      if (failureCount >= 2) {
        setState(C.STATES.DEGRADED_ADB, error.message, { failures: failureCount });
        scheduleReconnect();
      }
    } finally {
      checking = false;
    }
    return snapshot();
  }

  async function checkReverse() {
    if (!activePort || stopped) return reverseState.mapped;
    if (checking) return reverseState.mapped;
    checking = true;
    try {
      const result = await ensureReverse(activePort, { probe: probeEnabled });
      return result.mapped;
    } finally {
      checking = false;
    }
  }

  async function reconnectOnce() {
    const target = (resolved && resolved.serial) || lastGoodSerial || config.serial;
    if (target && isTransportAddress(target)) {
      try {
        await connect(target);
      } catch (err) {
        logger.warn('reconnect attempt failed; rediscovering', { error: String(err && err.message) });
      }
    }
    const info = await resolveSerial({ force: true });
    if (activePort) await ensureReverse(activePort, { probe: probeEnabled });
    failureCount = 0;
    retryIndex = 0;
    lastSeen = clock();
    lastError = null;
    setState(C.STATES.HEALTHY, `reconnected via ${info.source}`);
    return info;
  }

  function scheduleReconnect() {
    if (stopped || retryTimer) return;
    const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
    retryIndex += 1;
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      if (stopped) return;
      try {
        await reconnectOnce();
      } catch (err) {
        lastError = { code: err.code || 'adb_unavailable', message: err.message, at: iso(clock()) };
        logger.warn('reconnect failed', { retryInMs: RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)] });
        scheduleReconnect();
      }
    }, delay);
    if (retryTimer.unref) retryTimer.unref();
  }

  /**
   * Start keepalive timers. Returns the current snapshot; never rejects for a
   * missing device (state becomes DEGRADED_ADB).
   *
   * @param {{port?: number, probe?: boolean, stateIntervalMs?: number, reverseIntervalMs?: number}} [opts]
   */
  async function start(opts = {}) {
    if (config.enabled === false) {
      setState(C.STATES.DISABLED, 'KHY_AMOON_ENABLED=0');
      return snapshot();
    }
    stopped = false;
    activePort = validatePort(opts.port);
    probeEnabled = opts.probe !== false;
    try {
      const info = await resolveSerial();
      activePort = validatePort(opts.port || activePort);
      await ensureReverse(activePort, { probe: probeEnabled });
      lastSeen = clock();
      logger.info('wireless started', { serial: info.serial, port: activePort });
    } catch (err) {
      lastError = { code: err.code || 'adb_unavailable', message: err.message, at: iso(clock()) };
      setState(C.STATES.DEGRADED_ADB, err.message);
      scheduleReconnect();
    }

    // stop() may have been called while discovery/reverse was in flight (early
    // shutdown). Do not install heartbeat timers after a stop.
    if (stopped) {
      return snapshot();
    }

    if (stateTimer) clearInterval(stateTimer);
    if (reverseTimer) clearInterval(reverseTimer);
    stateTimer = setInterval(() => {
      heartbeat().catch((err) => logger.warn('heartbeat crashed', { error: String(err && err.message) }));
    }, opts.stateIntervalMs || STATE_INTERVAL_MS);
    reverseTimer = setInterval(() => {
      checkReverse().catch((err) => logger.warn('reverse check crashed', { error: String(err && err.message) }));
    }, opts.reverseIntervalMs || REVERSE_INTERVAL_MS);
    if (stateTimer.unref) stateTimer.unref();
    if (reverseTimer.unref) reverseTimer.unref();
    return snapshot();
  }

  function stop() {
    stopped = true;
    if (stateTimer) clearInterval(stateTimer);
    if (reverseTimer) clearInterval(reverseTimer);
    if (retryTimer) clearTimeout(retryTimer);
    stateTimer = null;
    reverseTimer = null;
    retryTimer = null;
    setState(C.STATES.STOPPED, 'wireless stopped');
    return snapshot();
  }

  function reasonsFor(stateName) {
    switch (stateName) {
      case C.STATES.DEGRADED_ADB:
        return ['ADB 设备不可用：手机工具返回 adb_unavailable；文件信箱会排队等待重连。'];
      case C.STATES.DEGRADED_REVERSE:
        return ['adb reverse 不可用：HTTP 快通道不可用；文件信箱仍可用。'];
      case C.STATES.DISABLED:
        return ['桥已被 KHY_AMOON_ENABLED=0 关闭。'];
      case C.STATES.STOPPED:
        return ['无线生命周期未启动。'];
      case C.STATES.DEGRADED_AMOON:
        return ['amoon 能力未通过 Phase 0 探测。'];
      default:
        return [];
    }
  }

  function snapshot() {
    const adbSnap = typeof adb.snapshot === 'function' ? adb.snapshot() : {};
    return {
      state,
      serial: adbSnap.serial || currentSerial(),
      model: adbSnap.model || null,
      sdk: adbSnap.sdk || null,
      reverse: {
        port: activePort || reverseState.port || config.port || C.DEFAULTS.port,
        mapped: Boolean(reverseState.mapped),
        lastOk: reverseState.lastOk,
        lastError: reverseState.lastError,
      },
      lastError,
      lastSeen: lastSeen ? iso(lastSeen) : null,
      reason: stateReason,
      reasons: reasonsFor(state),
    };
  }

  /**
   * Build a pairing instruction. It never runs `adb pair`, never stores the
   * code, and never echoes it into logs/audit.
   *
   * @param {{host?: string, port?: number, code?: string}} [opts]
   * @returns {{ok:boolean, command?:string, address?:string, note?:string, error?:object}}
   */
  function pairHint(opts = {}) {
    try {
      const host = typeof opts.host === 'string' ? opts.host.trim() : '';
      if (!host || !/^[A-Za-z0-9._:-]{1,200}$/.test(host)) {
        throw fail('invalid_args', 'pair 需要合法的手机 IP/主机名（--host）');
      }
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw fail('invalid_args', 'pair 需要合法的配对端口（--port，手机无线调试配对页显示）');
      }
      if (opts.code !== undefined && opts.code !== null && opts.code !== '') {
        if (!/^\d{6}$/.test(String(opts.code))) {
          throw fail('invalid_args', '配对码必须是 6 位数字');
        }
      }
      return {
        ok: true,
        command: `adb pair ${host}:${port}`,
        address: `${host}:${port}`,
        note: '请在本机终端运行上面的命令，并按提示输入手机上显示的 6 位配对码。本工具不会自动输码，也不会把配对码写入日志、审计或状态文件。配对成功后再用 connect 的地址连接；配对端口与连接端口通常不同。',
      };
    } catch (err) {
      const be = C.isBridgeError(err) ? err : new C.BridgeError('internal_error', String(err && err.message));
      return { ok: false, error: be.toJSON() };
    }
  }

  return {
    start,
    stop,
    heartbeat,
    ensureReverse,
    removeReverse,
    probeReverse,
    reverseList,
    resolveSerial,
    connect,
    snapshot,
    status: snapshot,
    pairHint,
    setState,
    get state() {
      return state;
    },
    get transport() {
      return adb;
    },
  };
}

module.exports = {
  RETRY_DELAYS_MS,
  STATE_INTERVAL_MS,
  REVERSE_INTERVAL_MS,
  DISCOVERY_TTL_MS,
  createWireless,
};
