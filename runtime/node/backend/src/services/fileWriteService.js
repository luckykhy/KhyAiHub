'use strict';

/**
 * fileWriteService.js — 人（编辑器）与 AI（工具循环）共用的唯一写盘落点。
 *
 * 为什么需要它：此前 `codeEditor:write` 与 toolCalling 的工具各写各的 ——
 * 没有共享锁、没有共享 mtime 基线、也没有共享的「先读后写」台账。两边同时改
 * 一个文件时后到者静默覆盖，谁都不知道丢了改动（DESIGN-ARCH-210 §6）。
 *
 * 顺序固定：校验 → stat → mtime 冲突 → 待审闸门（M3）→ 快照/turn 记录 →
 * 诊断基线 → mkdir + tmp/rename → markRead。任何一步拒绝都**不落盘**。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

/** 与 _readTracker.isStale 同口径：mtime 差异超过 50ms 才算「别人改过」。 */
const MTIME_TOLERANCE_MS = 50;
const DEFAULT_LOCK_TIMEOUT_MS = 30000;

const _lazy = { lock: undefined, tracker: undefined, history: undefined, turn: undefined, diag: undefined };

function _fileLock() {
  if (_lazy.lock === undefined) {
    try {
      _lazy.lock = require('../tools/_fileLock');
    } catch {
      _lazy.lock = null;
    }
  }
  return _lazy.lock;
}

function _readTracker() {
  if (_lazy.tracker === undefined) {
    try {
      _lazy.tracker = require('../tools/_readTracker');
    } catch {
      _lazy.tracker = null;
    }
  }
  return _lazy.tracker;
}

function _module(key, request) {
  if (_lazy[key] === undefined) {
    try {
      _lazy[key] = require(request);
    } catch {
      _lazy[key] = null;
    }
  }
  return _lazy[key];
}

/**
 * M3 待审闸门。host 在启动时注册；主进程里没有闸门（人保存不该被拦）。
 * 契约：返回 { action: 'write' } 继续写；{ action: 'reject', error } 拒绝；
 * { action: 'write', content } 用该内容替换落盘内容（只批准部分改动块时）。
 * 抛错一律 fail-closed 当成拒绝 —— 权限/审批判定失败不得默认放行。
 * @param {null | ((req: object) => Promise<{action: string, error?: string, content?: string} | void>)} fn
 */
let _pendingGate = null;
function setPendingGate(fn) {
  _pendingGate = typeof fn === 'function' ? fn : null;
}

function _reject(state, error, extra) {
  return { ok: false, state, error, ...(extra || {}) };
}

async function _statOrNull(filePath) {
  try {
    return await fsp.stat(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

function _mtimeMismatch(diskMtimeMs, baseMtimeMs) {
  if (typeof baseMtimeMs !== 'number' || !Number.isFinite(baseMtimeMs)) {
    return false;
  }
  return Math.abs(diskMtimeMs - baseMtimeMs) > MTIME_TOLERANCE_MS;
}

/**
 * @param {{
 *   filePath: string,
 *   content: string,
 *   baseMtimeMs?: number,
 *   createIfMissing?: boolean,
 *   actor?: 'tool'|'editor'|'system',
 *   reason?: string,
 *   beforeContent?: string,
 *   turnId?: string,
 *   diagCwd?: string,
 *   lockTimeoutMs?: number,
 *   skipAudit?: boolean,
 * }} args
 * @returns {Promise<{ok:boolean, state:string, mtimeMs?:number, bytes?:number,
 *   diskMtimeMs?:number, error?:string}>}
 */
async function write(args) {
  const opts = args || {};
  if (typeof opts.filePath !== 'string' || !opts.filePath.trim()) {
    return _reject('rejected', '未提供目标文件路径：请先选择要保存的文件');
  }
  if (typeof opts.content !== 'string') {
    return _reject('rejected', '写入内容不是文本：已拒绝写盘');
  }

  const filePath = path.resolve(opts.filePath.trim());
  const actor = opts.actor === 'editor' || opts.actor === 'system' ? opts.actor : 'tool';
  const reason = typeof opts.reason === 'string' && opts.reason.trim() ? opts.reason.trim() : actor;

  let disk;
  try {
    disk = await _statOrNull(filePath);
  } catch (err) {
    return _reject('error', `无法读取目标文件状态：${err.message}`);
  }
  if (disk && disk.isDirectory()) {
    return _reject('rejected', `目标是目录不是文件：${filePath}`);
  }
  if (!disk && !opts.createIfMissing) {
    return _reject('missing', `文件不存在：${filePath}，请刷新后重试`);
  }
  if (disk && _mtimeMismatch(disk.mtimeMs, opts.baseMtimeMs)) {
    return _reject('conflict', '文件已在磁盘上被修改：直接覆盖会丢掉对方的改动，请重新加载后再改', {
      diskMtimeMs: Math.round(disk.mtimeMs),
    });
  }

  const lk = _fileLock();
  let lock = null;
  if (lk) {
    try {
      lock = await lk.acquire(filePath, {
        mode: 'exclusive',
        timeoutMs: opts.lockTimeoutMs || DEFAULT_LOCK_TIMEOUT_MS,
        toolName: reason,
      });
    } catch (err) {
      return _reject('error', `文件被其他写入占用（${(opts.lockTimeoutMs || DEFAULT_LOCK_TIMEOUT_MS) / 1000}s 内未取到锁）：${filePath}`);
    }
  }

  try {
    // 取锁后重新 stat：上面那次检查与真正写盘之间可能有人插了一笔。
    let fresh;
    try {
      fresh = await _statOrNull(filePath);
    } catch (err) {
      return _reject('error', `无法读取目标文件状态：${err.message}`);
    }
    if (!fresh && !opts.createIfMissing) {
      return _reject('missing', `文件不存在：${filePath}，请刷新后重试`);
    }
    if (fresh && _mtimeMismatch(fresh.mtimeMs, opts.baseMtimeMs)) {
      return _reject('conflict', '文件已在磁盘上被修改：直接覆盖会丢掉对方的改动，请重新加载后再改', {
        diskMtimeMs: Math.round(fresh.mtimeMs),
      });
    }

    // 最终落盘内容。待审闸门可以只批准部分改动块（逐 hunk 接受）——此时它用
    // verdict.content 给出按块拼好的子集，而不是让调用方自己再写一遍。
    let finalContent = opts.content;
    if (_pendingGate) {
      let verdict;
      try {
        verdict = await _pendingGate({
          filePath,
          content: opts.content,
          beforeContent: opts.beforeContent,
          baseMtimeMs: fresh ? fresh.mtimeMs : undefined,
          actor,
          reason,
        });
      } catch (err) {
        return _reject('rejected', `改动未获批准：${err && err.message ? err.message : '审批通道不可用'}`);
      }
      if (verdict && verdict.action === 'reject') {
        return _reject('rejected', verdict.error || '用户未批准该改动（磁盘保持原样）');
      }
      if (verdict && typeof verdict.content === 'string') {
        finalContent = verdict.content;
      }
      // 等人批准可能等了几十秒，期间磁盘可能被外部程序改过：取锁后那次 stat
      // 已经过期，落盘前再看一眼，绝不覆盖批准期间的新改动。
      let settled;
      try {
        settled = await _statOrNull(filePath);
      } catch (err) {
        return _reject('error', `无法读取目标文件状态：${err.message}`);
      }
      if (!settled && !opts.createIfMissing) {
        return _reject('missing', `文件不存在：${filePath}，请刷新后重试`);
      }
      if (settled && _mtimeMismatch(settled.mtimeMs, opts.baseMtimeMs)) {
        return _reject('conflict', '文件已在磁盘上被修改（批准期间）：直接覆盖会丢掉对方的改动，请重新加载后再改', {
          diskMtimeMs: Math.round(settled.mtimeMs),
        });
      }
    }

    // 快照 / turn 记录 / 诊断基线：全部 fail-soft，绝不因为审计设施缺席而拒绝写盘。
    // skipAudit 只给「调用方已经按批登记过」的场景（ApplyPatchTool 的多文件全成或全回滚）。
    if (!opts.skipAudit) {
      if (fresh) {
        const history = _module('history', './fileHistoryService');
        if (history) {
          try {
            history.takeSnapshot(filePath, { reason, content: opts.beforeContent });
          } catch {
            /* non-critical */
          }
        }
        if (opts.turnId) {
          const turn = _module('turn', './turnCheckpointService');
          if (turn) {
            try {
              turn.recordMutatedFile(opts.turnId, filePath, { reason, content: opts.beforeContent });
            } catch {
              /* non-critical */
            }
          }
        }
      }
      const diag = _module('diag', './postEditDiagnostics');
      if (diag) {
        try {
          diag.captureBaseline(filePath, opts.diagCwd || path.dirname(filePath));
        } catch {
          /* diagnostics baseline is best-effort; never blocks the write */
        }
      }
    }

    const dir = path.dirname(filePath);
    const tmp = path.join(dir, `.${path.basename(filePath)}.khy-write-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(tmp, finalContent, 'utf-8');
      await fsp.rename(tmp, filePath);
    } catch (err) {
      try {
        await fsp.unlink(tmp);
      } catch {
        /* best-effort temp cleanup */
      }
      return _reject('error', `保存失败：${err.message}，请检查文件是否被其他程序占用`);
    }

    const after = await fsp.stat(filePath);
    const mtimeMs = Math.round(after.mtimeMs);
    const tracker = _readTracker();
    if (tracker) {
      try {
        tracker.markRead(filePath, mtimeMs);
      } catch {
        /* tracker 缺席不影响写入本身 */
      }
    }
    return { ok: true, state: 'ok', mtimeMs, bytes: Buffer.byteLength(finalContent, 'utf-8') };
  } finally {
    if (lock) {
      try {
        lock.release();
      } catch {
        /* idempotent release */
      }
    }
  }
}

module.exports = { write, setPendingGate, MTIME_TOLERANCE_MS };
