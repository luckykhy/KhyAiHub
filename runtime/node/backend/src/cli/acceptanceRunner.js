'use strict';

/**
 * acceptanceRunner.js — 验收判据的**执行面**（IO 全在这里）。
 *
 * 分工（同 hqStore 的「纯叶子 + 薄 IO」契约）：
 *   - 判据怎么算 → `acceptanceVerdict.js`（零 IO、纯函数）
 *   - 判据怎么跑、证据怎么落 → 本文件
 *
 * 证据只有一种形态：append-only 的 `acceptance.jsonl`，每行一条运行记录。
 * 它记录的是**系统亲眼看到的**东西 —— 命令、退出码、期望是否命中、跑在哪个
 * HEAD 上、当时工作树脏度、判据指纹。模型写的 `acceptance.md` 不再是真相，
 * 只是给人看的渲染视图。
 *
 * 为什么必须由系统写：旧口径里 `PASS` 的证据允许是一句话（「一句话也行」），
 * 于是「模型说通过了」与「真的跑过并通过」在数据上不可区分。运行记录把这
 * 两者分开：没有 record 就是 no-run，不是 pass。
 *
 * @module cli/acceptanceRunner
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const verdict = require('./acceptanceVerdict');

const RECORDS_FILE = 'acceptance.jsonl';
const DEFAULT_TIMEOUT_MS = 120 * 1000;
const MAX_OUTPUT_TAIL = 4000;

function _str(v) {
  return String(v == null ? '' : v).trim();
}

function _gitBin() {
  return process.env.KHY_GIT_BIN || 'git';
}

function _tail(text) {
  const s = String(text == null ? '' : text);
  return s.length > MAX_OUTPUT_TAIL ? `…${s.slice(-MAX_OUTPUT_TAIL)}` : s;
}

function _sha16(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text)).digest('hex').slice(0, 16);
}

function recordsPath(evidenceDir) {
  return path.join(evidenceDir, RECORDS_FILE);
}

/**
 * 读运行记录。损坏行只丢该行（append-only 文件被中断时尾部常见），
 * 绝不让一个坏字节把整份证据判成空。
 *
 * @param {string} evidenceDir
 * @returns {object[]}
 */
function readRunRecords(evidenceDir) {
  let text = '';
  try {
    text = fs.readFileSync(recordsPath(evidenceDir), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) {
      continue;
    }
    try {
      const rec = JSON.parse(s);
      if (rec && typeof rec === 'object') {
        out.push(rec);
      }
    } catch {
      /* 损坏行跳过，保留其余证据 */
    }
  }
  return out;
}

function appendRunRecord(evidenceDir, record) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.appendFileSync(recordsPath(evidenceDir), JSON.stringify(record) + '\n', 'utf8');
}

/** 只取 HEAD（不跑 status）—— 判据校验时逐条比对祖先关系，跑 status 太贵。 */
function currentHead(repoRoot) {
  const run = spawnSync(_gitBin(), ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  return run.error || run.status !== 0 ? null : _str(run.stdout);
}

/** 当前 HEAD 与工作树脏度。git 不可用时返回 null 字段 —— 不编造。 */
function gitSnapshot(repoRoot) {
  const head = currentHead(repoRoot);
  const statusRun = spawnSync(_gitBin(), ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  let dirtyCount = null;
  if (!statusRun.error && (statusRun.status === 0 || statusRun.status === null)) {
    dirtyCount = String(statusRun.stdout || '').split(/\r?\n/).filter((l) => l.trim()).length;
  }
  return { head, dirtyCount };
}

/**
 * 判据覆盖路径的指纹：只由这些路径的 git 状态决定。
 * 与 HEAD 解耦 —— 别的会话提交别的东西，不该让本判据的证据失效。
 */
function pathsFingerprint(repoRoot, paths) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (!list.length) {
    return '';
  }
  const r = spawnSync(_gitBin(), ['status', '--porcelain', '--', ...list], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error || (r.status !== 0 && r.status !== null)) {
    return '';
  }
  return _sha16(r.stdout || '');
}

/** 记录所属 HEAD 是否仍在当前历史里（非快进改写会让它 false）。 */
function headStillAncestor(repoRoot, recordHead, currentHead) {
  if (!recordHead || !currentHead || recordHead === currentHead) {
    return undefined;
  }
  const r = spawnSync(_gitBin(), ['merge-base', '--is-ancestor', recordHead, currentHead], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.error || r.status === null) {
    return undefined;
  }
  return r.status === 0;
}

function _matchExpect(expect, stdout) {
  if (!expect || expect.kind === 'exit') {
    return { kind: 'exit' };
  }
  let re;
  try {
    re = new RegExp(expect.re || '', expect.flags || '');
  } catch (e) {
    return { kind: expect.kind, error: `正则非法: ${e.message}` };
  }
  const hit = re.test(String(stdout || ''));
  return { kind: expect.kind, hit };
}

/**
 * 跑一条 cmd 判据。
 * @returns {object} 运行记录（未含 id/checkHash，由 runAcceptance 补齐）
 */
function runCommandCriterion(criterion, opts) {
  const c = criterion || {};
  const started = Date.now();
  const timeout = c.timeoutMs || opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const cwd = c.cwd ? path.resolve(opts.repoRoot, c.cwd) : opts.repoRoot;
  const r = spawnSync(c.cmd, {
    shell: true,
    cwd,
    timeout,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: Object.assign({}, process.env, opts.env || {}),
  });
  const durationMs = Date.now() - started;
  const errCode = r.error && r.error.code;
  const timedOut = errCode === 'ETIMEDOUT' || (r.signal === 'SIGTERM' && r.status === null);
  const exit = typeof r.status === 'number' ? r.status : null;
  const stdout = String(r.stdout || '');
  const stderr = String(r.stderr || '');
  const base = {
    cmd: c.cmd,
    cwd: c.cwd || '',
    durationMs,
    exit,
    timedOut,
    stdoutTail: _tail(stdout),
    stderrTail: _tail(stderr),
  };
  if (r.error && !timedOut) {
    return Object.assign(base, { result: 'unknown', reason: `spawn-error: ${r.error.message}` });
  }
  if (timedOut) {
    return Object.assign(base, { result: 'unknown', reason: `timeout ${timeout}ms` });
  }
  const got = _matchExpect(c.expect, stdout);
  if (got.error) {
    return Object.assign(base, { result: 'unknown', reason: got.error });
  }
  if (got.kind === 'exit') {
    const want = Number(c.expect && c.expect.value);
    const pass = exit === want;
    return Object.assign(base, {
      result: pass ? 'pass' : 'fail',
      reason: pass ? '' : `exit=${exit}（期望 ${want}）`,
    });
  }
  const pass = got.kind === 'stdout-match' ? got.hit : !got.hit;
  return Object.assign(base, {
    result: pass ? 'pass' : 'fail',
    reason: pass ? '' : `stdout ${got.kind === 'stdout-match' ? '未命中' : '命中了排除正则'} /${c.expect.re}/`,
  });
}

/**
 * 跑一整套判据并把运行记录追加进证据目录。
 *
 * @param {object} task
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.evidenceDir
 * @param {Map|object} [opts.manual] 人工判据结果：{ [id]: {result, signedBy, note} }
 * @param {number} [opts.maxAgeMs]
 * @param {number} [opts.timeoutMs]
 * @param {object} [opts.env] 额外环境变量
 * @param {(acceptance: string) => string[]} [opts.splitAcceptance]
 * @returns {{result: object, newRecords: object[], snapshot: object}}
 */
function runAcceptance(task, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  if (!o.repoRoot || !o.evidenceDir) {
    throw new Error('runAcceptance 需要 repoRoot 与 evidenceDir');
  }
  const norm = verdict.normalizeTaskCriteria(task, o.splitAcceptance);
  const snapshot = gitSnapshot(o.repoRoot);
  const now = Date.now();
  const manualMap = o.manual instanceof Map
    ? Object.fromEntries(o.manual)
    : (o.manual && typeof o.manual === 'object' ? o.manual : {});
  const newRecords = [];

  for (const c of norm.criteria) {
    if (c.invalid) {
      continue;
    }
    const common = {
      id: c.id,
      kind: c.kind,
      checkHash: verdict.checkHash(c),
      at: new Date(now).toISOString(),
      atMs: now,
      head: snapshot.head,
      dirtyCount: snapshot.dirtyCount,
      paths: c.paths,
      pathsFingerprint: pathsFingerprint(o.repoRoot, c.paths),
    };
    if (c.kind === 'manual') {
      const m = manualMap[c.id];
      if (!m || typeof m !== 'object') {
        continue;
      }
      newRecords.push(Object.assign(common, {
        result: m.result === 'pass' || m.result === 'fail' || m.result === 'skip' ? m.result : 'skip',
        signedBy: _str(m.signedBy),
        note: _str(m.note),
        source: 'human',
      }));
      continue;
    }
    const run = runCommandCriterion(c, o);
    newRecords.push(Object.assign(common, run, { source: 'system' }));
  }

  for (const rec of newRecords) {
    appendRunRecord(o.evidenceDir, rec);
  }

  const records = readRunRecords(o.evidenceDir);
  const ctx = {
    now: Date.now(),
    maxAgeMs: o.maxAgeMs,
    fingerprintFor: (rec) => pathsFingerprint(o.repoRoot, rec && rec.paths),
  };
  for (const rec of records) {
    if (rec && rec.head) {
      rec.headStillAncestor = headStillAncestor(o.repoRoot, rec.head, snapshot.head);
    }
  }
  const result = verdict.evaluateAcceptance(task, records, ctx, o.splitAcceptance);
  return { result, newRecords, snapshot };
}

module.exports = {
  RECORDS_FILE,
  DEFAULT_TIMEOUT_MS,
  recordsPath,
  readRunRecords,
  appendRunRecord,
  currentHead,
  gitSnapshot,
  pathsFingerprint,
  headStillAncestor,
  runCommandCriterion,
  runAcceptance,
};
