'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMatrixPolicy, canonicalPath } = require('./matrixPolicy');
const { jsonSnapshot } = require('./securityAudit');

function requireCanonicalRoots(matrix) {
  const roots = [...matrix.shared_scope, ...matrix.terminals.flatMap((row) => row.data_scope)];
  if (roots.some((root) => canonicalPath(root) !== root)) throw new Error('已确认的数据根目录被重定向，拒绝激活矩阵');
}

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });

// The administrator object comes from an authenticated host channel, never from request JSON.
function createMatrixStore({ filePath, audit, administrator, invalidateTickets, onViolation, protectedPaths = [] }) {
  if (!path.isAbsolute(filePath) || !administrator || typeof administrator !== 'object'
    || typeof audit?.append !== 'function' || typeof audit?.query !== 'function'
    || typeof audit.filePath !== 'string' || !path.isAbsolute(audit.filePath)
    || typeof invalidateTickets !== 'function' || typeof onViolation !== 'function') {
    throw new TypeError('矩阵存储需要绝对路径、可信管理员身份、审计、同步清票与违规通知通道');
  }
  const directory = fs.realpathSync.native(path.dirname(filePath));
  filePath = path.join(directory, path.basename(filePath));
  const lockPath = `${filePath}.lock`;
  const pendingPath = `${filePath}.pending`;
  const policyOptions = { protectedPaths: [filePath, lockPath, pendingPath, audit.filePath, `${audit.filePath}.lock`, ...protectedPaths] };
  let policy = createMatrixPolicy(null, policyOptions);
  const lockFd = fs.openSync(lockPath, 'wx', 0o600);
  let closed = false;
  let poisoned = false;
  let loaded = false;
  let pending = null;
  let diskDigest = null;
  let revision = 0;

  function ensureOpen() {
    if (closed || poisoned) throw fail('CORE_CONFIG_UNAVAILABLE', '矩阵存储不可用：请核查配置与审计后重启核心');
  }

  function suspend(reason) {
    policy = createMatrixPolicy(null);
    pending = null;
    const result = invalidateTickets(reason);
    if (result !== undefined) throw new TypeError('清票必须同步完成且无返回值');
  }

  function record(action, decision, reason, extra = {}) {
    try {
      const event = audit.append({ subject: 'core', action, object: filePath, decision, reason, ticket_id: null, ...extra });
      if (!event || !Number.isSafeInteger(event.seq) || typeof event.hash !== 'string') throw new Error('审计未返回持久化回执');
      return event;
    } catch (error) {
      poisoned = true;
      suspend('矩阵审计失败，全部票据作废');
      throw error;
    }
  }

  function readDisk() {
    if (fs.realpathSync.native(directory) !== directory) throw new Error('矩阵目录已重定向，拒绝加载或覆盖');
    const originalLock = fs.fstatSync(lockFd);
    const currentLock = fs.lstatSync(lockPath);
    if (originalLock.dev !== currentLock.dev || originalLock.ino !== currentLock.ino) throw new Error('矩阵锁已被替换，拒绝加载或覆盖');
    let stat;
    try { stat = fs.lstatSync(filePath); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('矩阵必须是普通文件，不能是链接或目录');
    return fs.readFileSync(filePath);
  }

  function load() {
    ensureOpen();
    try {
      suspend('重新加载矩阵，旧票据作废');
      loaded = false;
      const committed = audit.query().find((event) => event.action === 'khyos.config.write'
        && event.object === filePath && event.decision === 'allow');
      revision = committed ? committed.revision : 0;
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('矩阵审计版本无效');
      const bytes = readDisk();
      if (bytes === null) {
        record('khyos.config.load', 'missing', '配置不存在，必须重新勘察并由管理员确认');
        diskDigest = null;
        loaded = true;
        return null;
      }
      const candidate = createMatrixPolicy(JSON.parse(bytes.toString('utf8')), policyOptions);
      requireCanonicalRoots(candidate.matrix);
      if (!committed || committed.digest !== digest(bytes) || candidate.matrix.revision !== revision) {
        throw new Error('矩阵文件与最近一次已提交审批不一致，保留原文件并请管理员核查');
      }
      record('khyos.config.load', 'allow', '矩阵与审批审计一致，恢复服务', { digest: committed.digest, revision });
      policy = candidate;
      diskDigest = committed.digest;
      loaded = true;
      return policy.matrix;
    } catch (error) {
      poisoned = true;
      record('khyos.config.load', 'deny', error.message);
      throw error;
    }
  }

  async function requireAdministrator(principal, action, evidence) {
    ensureOpen();
    if (principal === administrator) return;
    let snapshot;
    try { snapshot = jsonSnapshot(evidence); } catch { snapshot = { invalid_json: true, missing: evidence === undefined }; }
    const event = record('forge_admin', 'deny', '非管理员通道请求修改矩阵，已拒绝', { attempted_action: action, evidence: snapshot });
    try {
      await onViolation(principal, Object.freeze({ event: 'forge_admin', audit_seq: event.seq, reason: event.reason }));
    } catch (error) {
      record('security.notify', 'failed', '矩阵提权请求已拒绝，但违规通知通道失败');
      throw fail('CORE_NOTIFICATION_UNAVAILABLE', '越权已拒绝且存证，但通知失败：请检查宿主通知通道');
    }
    record('security.notify', 'delivered', '宿主违规处理与通知通道已返回');
    throw fail('CORE_ADMIN_REQUIRED', '只有可信管理员会话能审批或修改矩阵');
  }

  async function propose(principal, value) {
    await requireAdministrator(principal, 'khyos.config.propose', value);
    ensureOpen();
    if (!loaded) throw fail('CORE_CONFIG_NOT_LOADED', '请先加载配置，再起草矩阵');
    const validated = createMatrixPolicy(value, policyOptions).matrix;
    const candidate = createMatrixPolicy({
      ...validated,
      shared_scope: validated.shared_scope.map(canonicalPath),
      terminals: validated.terminals.map((row) => ({ ...row, data_scope: row.data_scope.map(canonicalPath) })),
    }, policyOptions);
    if (candidate.matrix.revision !== revision + 1) throw fail('CORE_CONFIG_REVISION', '矩阵版本已变化：请按当前版本重新起草');
    const bytes = `${JSON.stringify(candidate.matrix, null, 2)}\n`;
    const proposal = Object.freeze({ challenge_id: crypto.randomUUID(), digest: digest(bytes), matrix: candidate.matrix });
    record('khyos.config.propose', 'need_human', '完整矩阵等待管理员明确确认', {
      challenge_id: proposal.challenge_id, digest: proposal.digest, revision: candidate.matrix.revision, matrix: candidate.matrix,
    });
    pending = { proposal, candidate, bytes };
    return proposal;
  }

  async function confirm(principal, response) {
    await requireAdministrator(principal, 'khyos.config.confirm', response);
    ensureOpen();
    const draft = pending;
    if (!draft || response?.challenge_id !== draft.proposal.challenge_id || response.digest !== draft.proposal.digest) {
      record('khyos.config.confirm', 'deny', '确认请求已失效或与完整矩阵摘要不匹配');
      throw fail('CORE_CONFIRMATION_INVALID', '确认请求不匹配：请查看最新完整矩阵后重新确认');
    }
    pending = null;
    if (response.decision !== '确认') {
      record('khyos.config.confirm', 'deny', '管理员未明确确认，草案已取消', { challenge_id: response.challenge_id });
      throw fail('CORE_CONFIRMATION_REQUIRED', '未收到明确确认：矩阵未改变');
    }
    try {
      suspend('管理员确认矩阵变更，旧票据永久作废');
      requireCanonicalRoots(draft.proposal.matrix);
      const current = readDisk();
      if ((current === null ? null : digest(current)) !== diskDigest) throw new Error('确认期间配置被外部修改，拒绝覆盖');
      record('khyos.config.confirm', 'allow', '管理员确认了本次完整矩阵', {
        challenge_id: draft.proposal.challenge_id, digest: draft.proposal.digest, revision: draft.proposal.matrix.revision,
      });
      const fd = fs.openSync(pendingPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, draft.bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(pendingPath, filePath);
      record('khyos.config.write', 'allow', '矩阵已落盘且审计提交完成', {
        challenge_id: draft.proposal.challenge_id, digest: draft.proposal.digest,
        revision: draft.proposal.matrix.revision, matrix: draft.proposal.matrix,
      });
      policy = draft.candidate;
      diskDigest = draft.proposal.digest;
      revision = policy.matrix.revision;
      return policy.matrix;
    } catch (error) {
      poisoned = true;
      record('khyos.config.write', 'failed', `配置未激活，保留现场供管理员核查：${error.message}`);
      throw error;
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    const errors = [];
    try { suspend('矩阵存储关闭，全部票据作废'); } catch (error) { errors.push(error); }
    let ownLock = false;
    try {
      const original = fs.fstatSync(lockFd);
      const current = fs.lstatSync(lockPath);
      ownLock = original.dev === current.dev && original.ino === current.ino;
      if (!ownLock) throw new Error('矩阵锁已被替换，不删除他人的锁');
    } catch (error) { errors.push(error); }
    try { fs.closeSync(lockFd); } catch (error) { errors.push(error); }
    if (ownLock) {
      try { fs.unlinkSync(lockPath); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, '矩阵存储关闭失败，请核查文件与锁状态');
  }

  return Object.freeze({
    load, propose, confirm, close, assertAdministrator: requireAdministrator,
    get matrix() { return policy.matrix; },
    get revision() { return revision; },
    check(context, facts) {
      ensureOpen();
      return policy.check(context, facts);
    },
  });
}

module.exports = { createMatrixStore };
