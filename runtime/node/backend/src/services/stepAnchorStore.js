'use strict';

/**
 * stepAnchorStore.js — 步骤锚点：把「每步完成态」变成**可还原**的东西。
 *
 * WHY THIS EXISTS:
 *   [IMPL-DOC-001] §12.7 的缺口：planModeService 逐步执行时，每步有**校验**
 *   （`validateStepResult`）与**重试**（`maxStepRetry`），但**没有任何快照**。
 *   `maxStepRetry` 只在**同一个（可能已被改坏的）基础上**再让模型改一次
 *   ⇒ 回不到上一步完成时的磁盘状态。这正是「一次很大的改变改坏无法修复」的机制成因。
 *
 *   ⚠ 本仓 `checkpoint` 一词**不是**还原点：`pipelineOrchestrator.createCheckpointTracker`
 *   与 `toolUseLoopCore` 的 `PHASE_SELF_CHECK` / `PHASE_SUMMARY` 全是**往对话里注入
 *   自检/进度提示**，不产生快照。本模块才是快照那一半。
 *
 * WHAT IT DOES:
 *   - createAnchor()  每步完成后，把「本步目标文件」的当前状态存成一份锚点（原始字节 + sha256）
 *   - readAnchor()    读回某一步的锚点清单
 *   - listAnchors()   列出某个 run 下已完成的步骤锚点
 *   - restoreAnchor() **显式**还原到某一步的完成态，并**逐字节验收**
 *
 * ⚠ 关于 `files` 到底该传什么（决定 restoreAnchor 是否名副其实）:
 *   调用方传的**不是**「本步碰过的文件」，而是「**全计划**目标文件集」。理由是
 *   `restoreAnchor(N)` 只应用**第 N 步那一份 manifest**，所以那份 manifest 必须已经
 *   覆盖「第 N 步之后才第一次被碰到的文件」—— 否则还原到第 N 步时，那些文件既不在
 *   manifest 里、也就无从知道它们当时存不存在，于是不会被删回「当时不存在」。
 *   实测反例（2026-09-26 多步用例）：3 步计划、b.md 由第 2 步创建 ⇒ 若第 1 步的 manifest
 *   只含本步目标，`restoreAnchor(0)` 不会删掉 b.md，「退回第 1 步完成态」名不副实。
 *   `plan.steps` 在开工时就已知 ⇒ 全计划目标集可以**一次算全**，单份 manifest 即足够。
 *   blob 的运行级内容寻址（`blobs/<sha256>.bin`）是这一步的前提：否则同一份内容会在
 *   每步重复落盘，存储量变成 O(步数 × 文件数)。
 *
 * ROLLOUT (PROCESS-008):
 *   S1 观察者。**只写锚点 + 旁路记录，绝不自动还原**：没有任何调用方会在步骤失败时
 *   自动回滚（§12.7.4 Q2「自动还原 vs 仅提示」尚未裁定）。`restoreAnchor()` 只供
 *   **显式调用**（人或上层显式发起），S1 阶段不构成自动化行为，故不涉「阻断」。
 *   Gate: KHY_STEP_ANCHOR（默认 on）。Stage: KHY_STEP_ANCHOR_STAGE（默认 S1）。
 *
 * 落点（为什么不在 `.khyos/` 下）:
 *   §12.7.3 初稿写的是「非 git 索引路径（`.khyos/` 下）」。实现时改判为**数据家目录**
 *   （`~/.khyquant/projects/<hash>/step-anchors/`，与 trajectoryStatsStore 同族）：
 *   锚点的用途是「工作区被改坏后还能退回去」，把它放在**工作区里面**意味着
 *   `git clean -xfd` / 误删目录会连锚点一起毁掉 —— 恰恰在最需要它的时候失效。
 *
 * Contract: **fail-soft 到处适用** —— 任何 IO/解析错误都不抛，只返回失败结果或 null。
 *   锚点是「可恢复性增强」，绝不能因为它自己出错而阻断步骤执行。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 单个文件超过此大小就不进锚点（记 skipped，不静默丢）。8 MiB。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** runId 长度上限（拼进路径，防超长）。 */
const MAX_RUN_ID = 64;
/** 永不纳入锚点的路径片段（相对 cwd）。 */
const DENY_PARTS = ['/.git/', '/node_modules/', '/.khyos/', '/.khyquant/'];

// ── Gate（对齐 trajectoryStatsStore / crossModelVerify 的既有范式）────────

/**
 * 门控是否开启。默认开；仅显式 0/false/off/no 关。
 *
 * 判定**委派给中央注册表**（`flagRegistry.isFlagEnabled`，本 flag 已登记为
 * `default-on/CANON`），使登记条目不是装饰性的。本地 CANON 回退保留：
 * 它覆盖的**不是** `require` 失败（本仓 `require('../services/flagRegistry')` 永不抛，
 * 那种「require 失败回退」是死代码，见 flagRegistry 头部注释），而是
 * `isFlagEnabled` 缺失/改名的情况。两条路径语义完全一致，故行为无分支差异。
 *
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_STEP_ANCHOR', env);
    }
  } catch {
    /* fall through to local CANON */
  }
  const raw = String((env && env.KHY_STEP_ANCHOR) || 'true')
    .trim()
    .toLowerCase();
  return !_FALSY.has(raw);
}

/**
 * 落地阶段**字面真源**。
 *
 * ⚠ 必须是**字面量**，不能只从 env 读：`scripts/ci/check-rollout-stage.js` 用
 * `const\s+KHY_STEP_ANCHOR_STAGE\s*=\s*['"](S[1-4])['"]` 在本文件里找它，再与
 * `FEATURE-OWNERSHIP.json` 的登记阶段比对；找不到就报 `rollout-stage-authority-drift`
 * （warning）。本仓三个同族先例（read-before-edit / cross-model-verify / trajectory-routing）
 * 都只从 env 读、于是三条都挂着该 warning —— 本模块刻意避开这个形态。
 *
 * 默认值也从它派生，避免 'S1' 在文件里写两遍、改一处漏一处。
 */
const KHY_STEP_ANCHOR_STAGE = 'S1';

/**
 * 落地阶段。默认 S1（观察者）；仅认 S2/S3，其余一律回落 S1（绝不 fail-open 到更高阶段）。
 * @param {object} [env]
 * @returns {'S1'|'S2'|'S3'}
 */
function getStage(env = process.env) {
  const raw = String((env && env.KHY_STEP_ANCHOR_STAGE) || KHY_STEP_ANCHOR_STAGE)
    .trim()
    .toUpperCase();
  if (raw === 'S2' || raw === 'S3') {
    return raw;
  }
  return KHY_STEP_ANCHOR_STAGE;
}

// ── 路径解析 ────────────────────────────────────────────────────────────

function _hashPath(dirPath) {
  return crypto.createHash('sha256').update(String(dirPath)).digest('hex').slice(0, 16);
}

function _projectsDir() {
  try {
    const dataHome = require('../utils/dataHome');
    if (typeof dataHome.isPortableDeployment === 'function' && dataHome.isPortableDeployment()) {
      return dataHome.getProjectDataDir('projects');
    }
  } catch {
    /* fall through */
  }
  return path.join(os.homedir(), '.khyquant', 'projects');
}

/** runId 只留安全字符；空/非法 → 'default'。 */
function _safeRunId(runId) {
  const s = String(runId == null ? '' : runId)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, MAX_RUN_ID);
  return s || 'default';
}

/**
 * 锚点根目录。cwd 参与哈希 ⇒ 不同工作区的锚点互不混淆。
 *
 * 优先级：显式 `override`（测试/调用方注入） > `KHY_STEP_ANCHOR_ROOT`（运维重定位；
 * 也让端到端测试不必碰真实数据家目录） > 默认数据家目录。
 */
function _anchorRoot(cwd, override) {
  if (override) {
    return String(override);
  }
  const fromEnv = String((process.env && process.env.KHY_STEP_ANCHOR_ROOT) || '').trim();
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(_projectsDir(), _hashPath(path.resolve(String(cwd || process.cwd()))), 'step-anchors');
}

/** 第 N 步的锚点目录。stepIndex 非负整数，否则返回 null。 */
function _stepDir(root, runId, stepIndex) {
  const n = Number(stepIndex);
  if (!Number.isInteger(n) || n < 0) {
    return null;
  }
  return path.join(_runDir(root, runId), `step-${String(n).padStart(4, '0')}`);
}

/** 某次运行的目录。blob 与台账都挂在这一层。 */
function _runDir(root, runId) {
  return path.join(root, _safeRunId(runId));
}

/**
 * 读一个 blob。当前布局是**运行级内容寻址**（`<runDir>/blobs/<sha256>.bin`）。
 * 回退读**步级** `blobs/<NNN>.bin` 是为了兼容本机制落地当天更早创建的锚点
 * （那时 blob 存在步目录下、按序号命名）—— 否则旧锚点会突然读不出来。
 */
function _readBlob(io, root, runId, stepDir, blob) {
  const runLevel = path.join(_runDir(root, runId), 'blobs', blob);
  if (io.existsSync(runLevel)) {
    return io.readFileSync(runLevel);
  }
  return io.readFileSync(path.join(stepDir, 'blobs', blob));
}

/**
 * 把调用方给的路径归一到「cwd 内的相对路径」。
 * 不在 cwd 内、命中 DENY_PARTS、或为空 → null（调用方记 skipped）。
 * @returns {string|null}
 */
function _normalizeRel(cwd, p) {
  const raw = String(p == null ? '' : p).trim();
  if (!raw) {
    return null;
  }
  const abs = path.resolve(cwd, raw);
  const base = path.resolve(cwd);
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (abs !== base && !abs.startsWith(withSep)) {
    return null; // 越界：绝不快照 cwd 之外的东西
  }
  const rel = path.relative(base, abs).split(path.sep).join('/');
  if (!rel) {
    return null;
  }
  const probe = `/${rel}/`;
  if (DENY_PARTS.some((d) => probe.includes(d))) {
    return null;
  }
  return rel;
}

// ── 纯逻辑：锚点计划（可单测，零 IO）────────────────────────────────────

/**
 * 由「本步写过的文件清单」算出锚点计划。**纯函数**，不碰磁盘。
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {string[]} args.files - 本步写过的文件（相对或绝对）
 * @param {object} [args.io] - FS 适配器（只需 statSync；缺省用 fs）
 * @returns {{ entries: Array<{rel:string, abs:string}>, skipped: Array<{path:string, reason:string}> }}
 */
function planAnchor({ cwd, files, io } = {}) {
  const _io = io || fs;
  const base = path.resolve(String(cwd || process.cwd()));
  const entries = [];
  const skipped = [];
  const seen = new Set();

  for (const f of Array.isArray(files) ? files : []) {
    const rel = _normalizeRel(base, f);
    if (!rel) {
      skipped.push({ path: String(f == null ? '' : f), reason: 'outside-cwd-or-denied' });
      continue;
    }
    if (seen.has(rel)) {
      continue; // 同一步里重复写同一文件只锚一次
    }
    seen.add(rel);

    const abs = path.join(base, rel);
    let size = 0;
    try {
      const st = _io.statSync(abs);
      if (!st.isFile()) {
        skipped.push({ path: rel, reason: 'not-a-file' });
        continue;
      }
      size = Number(st.size) || 0;
    } catch {
      // 文件不存在 = 本步把它删了。这也要进锚点：还原时得把它删回去。
      entries.push({ rel, abs, missing: true, size: 0 });
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      skipped.push({ path: rel, reason: `too-large:${size}` });
      continue;
    }
    entries.push({ rel, abs, missing: false, size });
  }
  return { entries, skipped };
}

/**
 * 由锚点清单算出「还原动作 + 验收期望」。**纯函数**，不碰磁盘。
 *
 * 还原动作只有两种：写回原字节 / 删掉（锚点建立时该文件不存在）。
 * 验收期望 = 每条动作执行后该文件应有的 sha256（删除 → null）。
 *
 * @param {object} manifest - createAnchor 产出的清单
 * @returns {{ actions: Array<object>, expected: Array<{rel:string, sha256:string|null}> }}
 */
function planRestore(manifest) {
  const files = (manifest && Array.isArray(manifest.files) ? manifest.files : []).filter(
    (e) => e && typeof e.rel === 'string' && e.rel
  );
  const actions = [];
  const expected = [];
  for (const e of files) {
    if (e.missing === true) {
      actions.push({ op: 'delete', rel: e.rel });
      expected.push({ rel: e.rel, sha256: null });
    } else {
      actions.push({ op: 'write', rel: e.rel, blob: e.blob });
      expected.push({ rel: e.rel, sha256: String(e.sha256 || '') || null });
    }
  }
  return { actions, expected };
}

/** sha256 of bytes (hex)。坏输入 → ''。 */
function _sha256(bytes) {
  try {
    return crypto.createHash('sha256').update(bytes).digest('hex');
  } catch {
    return '';
  }
}

// ── 落盘 ────────────────────────────────────────────────────────────────

function _appendLedger(_io, root, runId, event) {
  try {
    _io.mkdirSync(path.join(root, _safeRunId(runId)), { recursive: true });
    const file = path.join(root, _safeRunId(runId), 'ledger.jsonl');
    const prev = _io.existsSync(file) ? _io.readFileSync(file, 'utf8') : '';
    _io.writeFileSync(file, `${prev}${JSON.stringify(event)}\n`);
  } catch {
    /* fail-soft：台账写不进不影响锚点本身 */
  }
}

/**
 * 为某一步创建锚点。
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {string} args.runId - 本次计划/运行的标识
 * @param {number} args.stepIndex - 步骤序号（0 基）
 * @param {string[]} args.files - **全计划目标文件集**（见文件头 ⚠：不是本步目标）
 * @param {object} [args.io] - FS 适配器（缺省 fs）
 * @param {string} [args.root] - 锚点根（测试注入）
 * @param {object} [args.env] - 环境变量（测试注入）
 * @param {number} [args.now] - 时间戳（测试注入，保证确定性）
 * @returns {{ok:boolean, id?:string, dir?:string, files?:Array, skipped?:Array, reason?:string}}
 */
function createAnchor({ cwd, runId, stepIndex, files, io, root, env, now } = {}) {
  const _io = io || fs;
  try {
    if (!isEnabled(env)) {
      return { ok: false, reason: 'gate-off' };
    }
    const _root = _anchorRoot(cwd, root);
    const dir = _stepDir(_root, runId, stepIndex);
    if (!dir) {
      return { ok: false, reason: 'bad-step-index' };
    }

    const { entries, skipped } = planAnchor({ cwd, files, io: _io });
    // blob 存在**运行级**目录、按 sha256 命名 ⇒ 内容寻址天然去重。
    //
    // ⚠ 这是「累积式 manifest」能负担得起的前提：调用方每步传的是**全计划目标**文件集
    // （不是本步目标），于是同一份内容会在很多步里被引用。没有去重的话存储量是
    // O(步数 × 文件数)；有了去重，落盘量只与**不同内容**的个数有关。
    const blobsDir = path.join(_runDir(_root, runId), 'blobs');
    // ⚠ 步目录必须**显式**创建。blob 挪到运行级（`<runDir>/blobs/`）之后，
    // `step-NNNN/` 不再是「写 blob」的副产物；真 fs 下缺它会让 manifest 写入直接
    // ENOENT ⇒ createAnchor 整体失败（在内存 FS 适配器上却看不出来，因为那里的
    // writeFileSync 不检查父目录）。这个坑由 listAnchors / 端到端用例抓出来。
    _io.mkdirSync(dir, { recursive: true });
    _io.mkdirSync(blobsDir, { recursive: true });

    const recorded = [];
    for (const e of entries) {
      if (e.missing) {
        recorded.push({ rel: e.rel, missing: true, sha256: null, bytes: 0 });
        continue;
      }
      let buf;
      try {
        buf = _io.readFileSync(e.abs);
      } catch {
        skipped.push({ path: e.rel, reason: 'unreadable' });
        continue;
      }
      const sha = _sha256(buf);
      const name = `${sha}.bin`;
      try {
        // 同内容已落盘就不重写（去重）。
        if (!_io.existsSync(path.join(blobsDir, name))) {
          _io.writeFileSync(path.join(blobsDir, name), buf);
        }
      } catch {
        skipped.push({ path: e.rel, reason: 'blob-write-failed' });
        continue;
      }
      recorded.push({
        rel: e.rel,
        missing: false,
        blob: name,
        sha256: sha,
        bytes: buf.length,
      });
    }

    const manifest = {
      version: 1,
      runId: _safeRunId(runId),
      stepIndex: Number(stepIndex),
      cwd: path.resolve(String(cwd || process.cwd())),
      createdAt: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
      stage: getStage(env),
      files: recorded,
      skipped,
    };
    _io.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    _appendLedger(_io, _root, runId, {
      event: 'anchor-created',
      stepIndex: Number(stepIndex),
      files: recorded.length,
      skipped: skipped.length,
      at: manifest.createdAt,
    });
    return { ok: true, id: `${_safeRunId(runId)}#${Number(stepIndex)}`, dir, files: recorded, skipped };
  } catch (err) {
    return { ok: false, reason: 'exception', error: String((err && err.message) || err) };
  }
}

/**
 * 读回某一步的锚点清单。
 * @returns {object|null}
 */
function readAnchor({ cwd, runId, stepIndex, io, root } = {}) {
  const _io = io || fs;
  try {
    const dir = _stepDir(_anchorRoot(cwd, root), runId, stepIndex);
    if (!dir) {
      return null;
    }
    const file = path.join(dir, 'manifest.json');
    if (!_io.existsSync(file)) {
      return null;
    }
    return JSON.parse(_io.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 列出某个 run 下已锚的步骤（按 stepIndex 升序）。目录不存在 → []。
 * @returns {Array<{stepIndex:number, createdAt:string, fileCount:number}>}
 */
function listAnchors({ cwd, runId, io, root } = {}) {
  const _io = io || fs;
  try {
    const runDir = path.join(_anchorRoot(cwd, root), _safeRunId(runId));
    if (!_io.existsSync(runDir)) {
      return [];
    }
    const out = [];
    for (const name of _io.readdirSync(runDir)) {
      const m = /^step-(\d+)$/.exec(String(name));
      if (!m) {
        continue;
      }
      const manifest = readAnchor({ cwd, runId, stepIndex: Number(m[1]), io: _io, root });
      if (manifest) {
        out.push({
          stepIndex: Number(manifest.stepIndex),
          createdAt: manifest.createdAt,
          fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
        });
      }
    }
    return out.sort((a, b) => a.stepIndex - b.stepIndex);
  } catch {
    return [];
  }
}

/**
 * **显式**还原到某一步的完成态，并**逐字节验收**。
 *
 * ⚠ 只供显式调用。本模块不提供任何「步骤失败自动回滚」路径（§12.7.4 Q2 未裁定）。
 *
 * @param {object} args
 * @param {boolean} [args.dryRun] - 只算不写（默认 false）
 * @returns {{ok:boolean, reason?:string, restored:string[], deleted:string[], skipped:Array,
 *            verified:boolean, mismatches:Array, stage:string}}
 */
function restoreAnchor({ cwd, runId, stepIndex, io, root, env, dryRun = false } = {}) {
  const _io = io || fs;
  const stage = getStage(env);
  const empty = { ok: false, restored: [], deleted: [], skipped: [], verified: false, mismatches: [], stage };
  try {
    const manifest = readAnchor({ cwd, runId, stepIndex, io: _io, root });
    if (!manifest) {
      return { ...empty, reason: 'no-anchor' };
    }
    const base = path.resolve(String(cwd || process.cwd()));
    const _root = _anchorRoot(cwd, root);
    const dir = _stepDir(_root, runId, stepIndex);
    const { actions } = planRestore(manifest);

    const restored = [];
    const deleted = [];
    const skipped = [];

    for (const a of actions) {
      // 二次越界检查：manifest 可能被外部改过，绝不照着它写到 cwd 之外
      const rel = _normalizeRel(base, a.rel);
      if (!rel) {
        skipped.push({ path: a.rel, reason: 'outside-cwd-or-denied' });
        continue;
      }
      const abs = path.join(base, rel);
      try {
        if (a.op === 'delete') {
          if (!dryRun) {
            _io.rmSync(abs, { force: true });
          }
          deleted.push(rel);
        } else {
          const buf = _readBlob(_io, _root, runId, dir, String(a.blob));
          if (!dryRun) {
            _io.mkdirSync(path.dirname(abs), { recursive: true });
            _io.writeFileSync(abs, buf);
          }
          restored.push(rel);
        }
      } catch (err) {
        skipped.push({ path: rel, reason: `write-failed:${String((err && err.message) || err)}` });
      }
    }

    const verify = verifyRestore({ cwd, runId, stepIndex, io: _io, root, manifest });
    _appendLedger(_io, _anchorRoot(cwd, root), runId, {
      event: dryRun ? 'restore-planned' : 'restore-applied',
      stepIndex: Number(stepIndex),
      restored: restored.length,
      deleted: deleted.length,
      skipped: skipped.length,
      verified: verify.equal,
      stage,
      at: new Date().toISOString(),
    });

    return {
      ok: skipped.length === 0,
      restored,
      deleted,
      skipped,
      verified: verify.equal,
      mismatches: verify.mismatches,
      stage,
    };
  } catch (err) {
    return { ...empty, reason: 'exception', error: String((err && err.message) || err) };
  }
}

/**
 * 逐字节验收：把 cwd 下的现状与锚点清单逐个 sha256 比对。
 * 「看着一样」不算 —— 这正是本仓 `[DESIGN-ARCH-127]` 的验收范式。
 *
 * @returns {{equal:boolean, mismatches:Array<{rel:string, expected:string|null, actual:string|null}>}}
 */
function verifyRestore({ cwd, runId, stepIndex, io, root, manifest } = {}) {
  const _io = io || fs;
  try {
    const man = manifest || readAnchor({ cwd, runId, stepIndex, io: _io, root });
    if (!man) {
      return { equal: false, mismatches: [{ rel: '(manifest)', expected: null, actual: null }] };
    }
    const base = path.resolve(String(cwd || process.cwd()));
    const mismatches = [];
    for (const e of Array.isArray(man.files) ? man.files : []) {
      const abs = path.join(base, e.rel);
      let actual = null;
      try {
        actual = _sha256(_io.readFileSync(abs));
      } catch {
        actual = null; // 不存在
      }
      const expected = e.missing === true ? null : String(e.sha256 || '') || null;
      if (actual !== expected) {
        mismatches.push({ rel: e.rel, expected, actual });
      }
    }
    return { equal: mismatches.length === 0, mismatches };
  } catch {
    return { equal: false, mismatches: [{ rel: '(exception)', expected: null, actual: null }] };
  }
}

module.exports = {
  isEnabled,
  getStage,
  KHY_STEP_ANCHOR_STAGE,
  planAnchor,
  planRestore,
  createAnchor,
  readAnchor,
  listAnchors,
  restoreAnchor,
  verifyRestore,
  MAX_FILE_BYTES,
  DENY_PARTS,
};
