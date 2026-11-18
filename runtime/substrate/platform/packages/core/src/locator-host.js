'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const { CoreError, formatCoreError } = require('./contracts/errors');
const { CORE_MODE_VALUES, DEFAULT_BIND_HOST } = require('./contracts/core-env');
const { CORE_PROTOCOL_VERSION } = require('./contracts/health');
const { LocatorRecordSchema } = require('./contracts/schemas/core-handle.schema');
const { obtainCore } = require('./client/obtain-core');

// 包内唯一允许 node: 的源文件（CH-1）。锁/locator 的读写与 embedded 定位都在这里，
// contracts/client 因此保持零 node:。心跳 10s、stale 30s + 一次 10s 二次确认（[DESIGN-ARCH-220] §4.2）。
const LOCK_DIRNAME = 'core';
const LOCK_FILENAME = 'core.lock';
const LOCATOR_FILENAME = 'locator.json';
const HEARTBEAT_MS = 10000;
const STALE_AFTER_MS = 30000;
const STALE_CONFIRM_MS = 10000;

function coreDir(dataHome) {
  return path.join(dataHome, LOCK_DIRNAME);
}

function lockPath(dataHome) {
  return path.join(coreDir(dataHome), LOCK_FILENAME);
}

function locatorPath(dataHome) {
  return path.join(coreDir(dataHome), LOCATOR_FILENAME);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = 进程不存在；EPERM = 存在但无信号权限（仍算活）。
    return err.code === 'EPERM';
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readLock(dataHome) {
  return readJson(lockPath(dataHome));
}

function readLocatorFile(dataHome) {
  const raw = readJson(locatorPath(dataHome));
  return raw ? LocatorRecordSchema.parse(raw) : null;
}

// 防后写者覆盖：只有 epoch 严格更大的写入才落盘（§4.2「写 locator/计量前必须比对 epoch」）。
function writeLocatorFile(dataHome, record) {
  const parsed = LocatorRecordSchema.parse(record);
  fs.mkdirSync(coreDir(dataHome), { recursive: true });
  const current = readJson(locatorPath(dataHome));
  if (current && typeof current.epoch === 'number' && current.epoch >= parsed.epoch) {
    return false;
  }
  const target = locatorPath(dataHome);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2));
  fs.renameSync(tmp, target);
  return true;
}

function isLockStale(lock) {
  if (!lock) return true;
  if (!isAlive(lock.pid)) return true;
  return Date.now() - lock.heartbeatAt > STALE_AFTER_MS;
}

async function acquireLock(dataHome, self, options = {}) {
  const confirmMs = options.staleConfirmMs === undefined ? STALE_CONFIRM_MS : options.staleConfirmMs;
  fs.mkdirSync(coreDir(dataHome), { recursive: true });
  const target = lockPath(dataHome);
  try {
    const fd = fs.openSync(target, 'wx');
    fs.writeSync(fd, JSON.stringify(self, null, 2));
    fs.closeSync(fd);
    return self;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  let existing = readLock(dataHome);
  if (!isLockStale(existing)) {
    throw new CoreError(
      'CORE_LOCKED',
      `已有核心运行于 PID ${existing.pid}、端口 ${existing.port}（心跳 ${Math.round((Date.now() - existing.heartbeatAt) / 1000)}s 前，epoch ${existing.epoch}），` +
        '同一数据家只允许一个写者；运行 khy doctor 查看核心状态，或设置 KHY_CORE_ENDPOINT 连接它',
      { retryable: false, details: { lock: existing } },
    );
  }

  // 二次确认：一次 GC 停顿不该被误判成死亡（RUNTIME-003：这是等待，不是 kill）。
  await new Promise((resolve) => setTimeout(resolve, confirmMs));
  existing = readLock(dataHome);
  if (existing && !isLockStale(existing)) {
    throw new CoreError('CORE_LOCKED', `锁在二次确认期间恢复心跳（PID ${existing.pid}）：放弃接管`, {
      retryable: false,
      details: { lock: existing },
    });
  }

  if (existing) {
    // 旧锁隔离留档不删除（LAYOUT-004 只隔离不删除）。
    fs.renameSync(target, `${target}.stale.${existing.pid}.${Date.now()}`);
  }
  const taken = { ...self, epoch: (existing && existing.epoch ? existing.epoch : 0) + 1 };
  fs.writeFileSync(target, JSON.stringify(taken, null, 2));
  return taken;
}

function heartbeatLock(dataHome, self) {
  const existing = readLock(dataHome);
  if (!existing) {
    throw new CoreError('CORE_TAKEN_OVER', '锁文件已消失：本实例失去写者资格，降级为 attach', { retryable: false });
  }
  if (existing.coreId !== self.coreId) {
    throw new CoreError('CORE_TAKEN_OVER', `锁已被 coreId=${existing.coreId}（epoch ${existing.epoch}）接管，本实例 epoch=${self.epoch}：降级为 attach`, {
      retryable: false,
      details: { existing },
    });
  }
  fs.writeFileSync(lockPath(dataHome), JSON.stringify({ ...existing, heartbeatAt: Date.now() }, null, 2));
}

function releaseLock(dataHome, self) {
  const existing = readLock(dataHome);
  if (!existing || existing.coreId !== self.coreId) return false; // 幂等：别人的锁/无锁都不动
  fs.unlinkSync(lockPath(dataHome));
  return true;
}

// 四段定位（§8#1）：显式注入 > 宿主 bundled 入口 > node_modules/@khy/core > 诚实报错。
// nodeModulesCwd 默认取调用进程 cwd：第三方 embedded 从自己的项目目录解析 @khy/core。
function resolveEmbedded(options = {}) {
  if (options.entry !== undefined) {
    const mod = loadExplicit(options.entry, 'entry');
    return { module: mod, source: 'explicit' };
  }
  if (options.bundledEntry !== undefined) {
    const mod = loadExplicit(options.bundledEntry, 'bundledEntry');
    return { module: mod, source: 'bundled' };
  }
  const from = options.nodeModulesCwd || process.cwd();
  // createRequire 从调用方位置起解析：本包内的 self-reference 会让 @khy/core/server
  // 永远命中（实测），那不是「第三方装了 @khy/core」的那一段。
  try {
    const consumerRequire = createRequire(path.join(from, 'noop.js'));
    const resolved = consumerRequire.resolve('@khy/core/server');
    return { module: consumerRequire(resolved), source: 'node-modules' };
  } catch (_) {
    throw new CoreError(
      'CORE_LOCATOR_FAILED',
      `${formatCoreError('CORE_LOCATOR_FAILED', `三段定位均未命中（显式注入/宿主 bundled 入口/node_modules@khy/core，解析起点 ${from}）`)}`,
      { retryable: false, details: { nodeModulesCwd: from } },
    );
  }
}

function loadExplicit(entry, label) {
  if (typeof entry === 'object' && entry !== null) return entry; // electron-vite 注入已加载模块
  if (typeof entry === 'string' && fs.existsSync(entry)) return require(entry);
  throw new CoreError(
    'CORE_LOCATOR_FAILED',
    `${formatCoreError('CORE_LOCATOR_FAILED', `${label} 提供的实现入口不存在：${String(entry)}`)}`,
    { retryable: false, details: { label, entry: String(entry) } },
  );
}

async function obtainCoreNode(opts) {
  if (!opts || !opts.terminalId || !opts.clientVersion) {
    throw new CoreError('CORE_INVALID_ARGUMENT', 'obtainCoreNode 需要 terminalId 与 clientVersion');
  }
  const mode = opts.mode || 'auto';
  if (!CORE_MODE_VALUES.includes(mode)) {
    throw new CoreError('CORE_INVALID_ARGUMENT', `mode 只能是 ${CORE_MODE_VALUES.join('/')}，收到 ${mode}`);
  }
  if (mode === 'attached') return obtainCore(opts);

  if (mode === 'auto') {
    try {
      return await obtainCore(opts);
    } catch (err) {
      if (!(err instanceof CoreError)) throw err;
      if (opts.allowSpawn !== true) throw err;
      // 明确允许 embedded 回退时才继续；否则把 attach 的失败原样抛给调用方。
    }
  }

  if (opts.paths && opts.paths.dataHome) {
    const locator = readLocatorFile(opts.paths.dataHome);
    if (locator) {
      // 先试 attach：抢不到锁且持锁者新鲜时绝不 spawn（§4.4）。
      try {
        return await obtainCore({ ...opts, locator });
      } catch (err) {
        if (!(err instanceof CoreError)) throw err;
        if (err.code === 'CORE_PROTOCOL_MISMATCH' || err.code === 'CORE_LOCKED') throw err;
      }
    }
  }

  const impl = resolveEmbedded(opts);
  const dataHome = opts.paths ? opts.paths.dataHome : null;
  const self = {
    coreId: `core-${process.pid}-${Date.now()}`,
    pid: process.pid,
    port: 0,
    host: DEFAULT_BIND_HOST,
    tokenHash: 'unhashed-until-s4',
    protocolVersion: CORE_PROTOCOL_VERSION,
    coreVersion: '0.1.0',
    epoch: 0,
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
  };

  const lock = dataHome ? await acquireLock(dataHome, self, opts.lockOptions) : self;
  let server = null;
  try {
    server = await impl.module.createCoreServer({
      dataHome,
      bindHost: opts.bindHost || DEFAULT_BIND_HOST,
      lock,
    });
    await server.start();
  } catch (err) {
    if (dataHome) releaseLock(dataHome, lock);
    throw err;
  }

  if (dataHome) {
    writeLocatorFile(dataHome, {
      coreId: lock.coreId,
      protocolVersion: lock.protocolVersion,
      pid: lock.pid,
      endpoint: `http://${lock.host}:${server.port || 0}`,
      tokenHash: lock.tokenHash,
      epoch: lock.epoch,
      coreVersion: lock.coreVersion,
      heartbeatAt: lock.heartbeatAt,
    });
  }

  const heartbeat = dataHome
    ? setInterval(() => {
        try {
          heartbeatLock(dataHome, lock);
        } catch (err) {
          clearInterval(heartbeat);
          if (typeof opts.onTakenOver === 'function') opts.onTakenOver(err);
        }
      }, HEARTBEAT_MS)
    : null;
  if (heartbeat) heartbeat.unref();

  // 六成员通道在 S5 逐块迁移；本刀起的是零业务骨架 server，成员调用如实报未接线。
  const handle = {
    mode: 'embedded',
    coreId: lock.coreId,
    epoch: lock.epoch,
    version: { core: lock.coreVersion, protocol: lock.protocolVersion, enginesKhy: opts.enginesKhy || '>=1.0.0 <2.0.0' },
    paths: opts.paths || {},
    gateway: pendingMember('gateway'),
    events: pendingMember('events'),
    storage: pendingMember('storage'),
    session: pendingMember('session'),
    capabilities: pendingMember('capabilities'),
    plugins: pendingMember('plugins'),
    async close() {
      if (heartbeat) clearInterval(heartbeat);
      if (server && typeof server.close === 'function') await server.close();
      if (dataHome) releaseLock(dataHome, lock);
    },
  };
  return handle;
}

function pendingMember(label) {
  const notYet = async () => {
    throw new CoreError(
      'CORE_UNAVAILABLE',
      `${label} 成员通道未接线：六成员调用面随 S4/S5 落地，本刀只交付发现、锁与骨架 server`,
      { retryable: false, details: { reason: 'member-pending', member: label } },
    );
  };
  return new Proxy({}, { get: (_t, prop) => (typeof prop === 'string' ? notYet : undefined) });
}

module.exports = {
  obtainCoreNode,
  readLocatorFile,
  writeLocatorFile,
  acquireLock,
  heartbeatLock,
  releaseLock,
  isAlive,
  resolveEmbedded,
  HEARTBEAT_MS,
  STALE_AFTER_MS,
  STALE_CONFIRM_MS,
  LOCATOR_FILENAME,
  LOCK_FILENAME,
};
