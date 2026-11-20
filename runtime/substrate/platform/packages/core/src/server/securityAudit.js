'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');

const REQUIRED = ['subject', 'action', 'object', 'decision', 'reason'];
const INTERNAL = ['time', 'seq', 'prev_hash', 'hash'];

function jsonSnapshot(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new TypeError('审计数据必须是无循环的 JSON 数据，请移除不支持的值');
  }
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError('审计数据只接受普通 JSON 对象，请先转换数据');
  }
  ancestors.add(value);
  const result = array ? [] : Object.create(null);
  const keys = Reflect.ownKeys(value).filter((key) => !(array && key === 'length'));
  if (array && keys.length !== value.length) throw new TypeError('审计数据不接受稀疏数组');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
        (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
      throw new TypeError('审计数据必须是 JSON 数据，不能包含访问器或隐藏字段');
    }
    result[key] = jsonSnapshot(descriptor.value, ancestors);
  }
  ancestors.delete(value);
  return result;
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('审计记录必须是对象');
  }
  for (const key of REQUIRED) {
    if (typeof record[key] !== 'string' || !record[key].trim()) {
      throw new TypeError(`审计字段 ${key} 必须是非空字符串`);
    }
  }
  if (record.ticket_id !== null && (typeof record.ticket_id !== 'string' || !record.ticket_id.trim())) {
    throw new TypeError('审计字段 ticket_id 必须是非空字符串或 null');
  }
  if (!Number.isSafeInteger(record.time) || record.time < 0) {
    throw new TypeError('审计字段 time 必须是非负安全整数毫秒时间戳');
  }
  for (const key of ['task_id', 'terminal_id']) {
    if (Object.hasOwn(record, key) && (typeof record[key] !== 'string' || !record[key].trim())) {
      throw new TypeError(`审计字段 ${key} 必须是非空字符串`);
    }
  }
}

function digest(record) {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function clone(record) {
  return JSON.parse(JSON.stringify(record));
}

exports.jsonSnapshot = jsonSnapshot;

// This hash chain detects disk corruption; it is not OS-level tamper protection.
exports.createSecurityAudit = function createSecurityAudit({ filePath, now = Date.now } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new TypeError('安全账本 filePath 必须是宿主提供的绝对路径');
  }
  if (typeof now !== 'function') throw new TypeError('安全账本 now 必须是函数');
  filePath = path.join(fs.realpathSync(path.dirname(filePath)), path.basename(filePath));
  try {
    filePath = fs.realpathSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const lockPath = `${filePath}.lock`;
  // Never remove a pre-existing lock, even when its owner may have crashed.
  const lockFd = fs.openSync(lockPath, 'wx', 0o600);
  let fd;
  let closed = false;
  let poisoned = false;
  const records = [];
  const contentHash = createHash('sha256');
  let contentLength = 0;

  function release() {
    const errors = [];
    const attempt = (operation) => {
      try { operation(); } catch (error) { errors.push(error); }
    };
    if (fd !== undefined) attempt(() => fs.closeSync(fd));
    let ownLock = false;
    attempt(() => {
      const lockIdentity = fs.fstatSync(lockFd);
      const current = fs.lstatSync(lockPath);
      ownLock = current.dev === lockIdentity.dev && current.ino === lockIdentity.ino;
      if (!ownLock) throw new Error('安全账本锁已被替换，拒绝删除他人的锁');
    });
    attempt(() => fs.closeSync(lockFd));
    if (ownLock) attempt(() => fs.unlinkSync(lockPath));
    if (errors.length) throw new AggregateError(errors, '安全账本资源释放失败，请检查文件与锁状态');
  }

  try {
    fd = fs.openSync(filePath, 'a+', 0o600);
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(fd));
    if (content && !content.endsWith('\n')) throw new Error('安全账本尾行不完整，拒绝打开；请人工核查');
    for (const line of content ? content.slice(0, -1).split('\n') : []) {
      const record = JSON.parse(line);
      validateRecord(record);
      const { hash, ...body } = record;
      const previous = records.length ? records[records.length - 1].hash : null;
      if (record.seq !== records.length + 1 || record.prev_hash !== previous ||
          typeof hash !== 'string' || hash !== digest(body) || JSON.stringify(record) !== line) {
        throw new Error(`安全账本第 ${records.length + 1} 行损坏，拒绝打开；请人工核查`);
      }
      records.push(record);
    }
    contentHash.update(content);
    contentLength = Buffer.byteLength(content);
  } catch (error) {
    try { release(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], '安全账本初始化及清理失败');
    }
    throw error;
  }

  function assertOpen() {
    if (closed) throw new Error('安全账本已关闭，请重新打开实例');
    if (poisoned) throw new Error('安全账本实例 poisoned：先前追加失败，请关闭并核查磁盘账本');
  }

  function verifyDisk() {
    try {
      const opened = fs.fstatSync(fd);
      const current = fs.lstatSync(filePath);
      const ownedLock = fs.fstatSync(lockFd);
      const currentLock = fs.lstatSync(lockPath);
      if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino
        || current.size !== contentLength || opened.size !== contentLength
        || currentLock.dev !== ownedLock.dev || currentLock.ino !== ownedLock.ino
        || createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') !== contentHash.copy().digest('hex')) {
        throw new Error('安全账本或锁运行中被修改，停止读写并请人工核查');
      }
    } catch (error) {
      poisoned = true;
      throw error;
    }
  }

  function append(input) {
    assertOpen();
    try {
      verifyDisk();
      const body = jsonSnapshot(input);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('审计记录必须是对象');
      if (INTERNAL.some((key) => Object.hasOwn(body, key))) {
        throw new TypeError('time、seq、prev_hash、hash 由安全账本生成，调用者不可提供');
      }
      body.time = now();
      validateRecord(body);
      body.seq = records.length + 1;
      body.prev_hash = records.length ? records[records.length - 1].hash : null;
      const record = { ...body, hash: digest(body) };
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) {
          throw new Error('安全账本写入未推进，请核查磁盘状态');
        }
        offset += written;
      }
      fs.fsyncSync(fd);
      contentHash.update(bytes);
      contentLength += bytes.length;
      verifyDisk();
      records.push(record);
      return clone(record);
    } catch (error) {
      poisoned = true;
      throw error;
    }
  }

  function query({ terminal_id, task_id, limit = records.length } = {}) {
    assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('查询 limit 必须是非负安全整数');
    for (const value of [terminal_id, task_id]) {
      if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
        throw new TypeError('查询 terminal_id / task_id 必须是非空字符串');
      }
    }
    verifyDisk();
    const result = [];
    for (let i = records.length - 1; i >= 0 && result.length < limit; i--) {
      const record = records[i];
      if (terminal_id !== undefined && record.terminal_id !== terminal_id) continue;
      if (task_id !== undefined && record.task_id !== task_id) continue;
      result.push(clone(record));
    }
    return result;
  }

  function close() {
    if (closed) return;
    closed = true;
    release();
  }

  return { append, query, close, get poisoned() { return poisoned; }, get filePath() { return filePath; } };
};
