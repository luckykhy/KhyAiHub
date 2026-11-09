'use strict';

/**
 * lib/bootstrap.js — push the phone-side onboarding bundle over ADB.
 *
 * What it does (idempotent):
 *   1. Creates the mailbox tree under /sdcard/khy-amoon-bridge.
 *   2. Pushes phone/README.md, phone/tools.json and phone/kb with LF line
 *      endings, using push-to-tmp + mv so a reader never sees a partial file.
 *   3. Writes port.txt from the actual listening port.
 *   4. Writes token.txt only when the caller supplies a phone-scope token.
 *      There is deliberately NO default token source: the operator token must
 *      never be copied to the phone, and this module cannot mint a phone token.
 *   5. chmod 755 on kb (best effort on FUSE), 600 on token.txt.
 *
 * Idempotency is content-based: the remote file is pulled and compared by
 * sha256; unchanged files are not re-pushed (unless {force:true}).
 *
 * This module uses only the frozen AdbTransport surface (push/pull/shell) and
 * never prints token material.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const C = require('./contracts');

const ASSET_SPECS = Object.freeze([
  { name: 'README.md', local: 'README.md', mode: '644' },
  { name: 'tools.json', local: 'tools.json', mode: '644' },
  { name: 'kb', local: 'kb', mode: '755' },
]);

const TOKEN_REMOTE_NAME = 'token.txt';
const PORT_REMOTE_NAME = 'port.txt';
const TOKEN_MAX_BYTES = 512;

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Normalize text to LF and ensure a trailing newline.
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  const lf = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return lf.endsWith('\n') ? lf : `${lf}\n`;
}

function safeLeaf(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('..') ||
    /[\/\\\u0000-\u001f]/.test(name)
  ) {
    throw new C.BridgeError('invalid_args', `非法的远端文件名：${String(name)}`);
  }
  return name;
}

function normalizeRoot(root) {
  if (typeof root !== 'string' || !root.startsWith('/') || root.includes('..') || /[\u0000-\u001f\\]/.test(root)) {
    throw new C.BridgeError('invalid_config', `手机目录必须是绝对 POSIX 路径：${String(root)}`);
  }
  return root.replace(/\/+$/, '') || '/';
}

/**
 * @param {{
 *   config?: object,
 *   adb: {shell:Function,push:Function,pull:Function},
 *   logger?: object,
 *   assetsDir?: string,
 *   root?: string,
 *   clock?: {now:()=>number},
 * }} options
 * @returns {{run:Function,plan:Function,status:Function,dispose:Function,root:string,assetsDir:string}}
 */
function createBootstrap(options = {}) {
  if (!options || typeof options !== 'object') {
    throw new C.BridgeError('invalid_config', 'createBootstrap 需要 options 对象');
  }
  const config = options.config || {};
  const adb = options.adb;
  if (!adb || typeof adb.shell !== 'function' || typeof adb.push !== 'function' || typeof adb.pull !== 'function') {
    throw new C.BridgeError('invalid_config', 'bootstrap 需要 AdbTransport（shell/push/pull）');
  }
  const logger = options.logger || { debug() {}, info() {}, warn() {}, error() {} };
  const clock = options.clock && typeof options.clock.now === 'function' ? options.clock : { now: Date.now };
  const root = normalizeRoot(options.root || (config.remote && config.remote.root) || C.REMOTE_ROOT);
  const assetsDir = options.assetsDir || path.join(config.extRoot || path.resolve(__dirname, '..'), 'phone');
  const shellTimeoutMs = 20000;

  let lastReport = null;
  let localDirPath = null;

  function getLocalDir() {
    if (!localDirPath) {
      localDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-amoon-bootstrap-'));
    }
    return localDirPath;
  }

  function noteWarn(message, details) {
    logger.warn(message, details);
  }

  async function shell(cmd, timeoutMs = shellTimeoutMs) {
    return adb.shell(cmd, { timeoutMs, maxBytes: C.LIMITS.commandBytes });
  }

  async function remoteExists(remote) {
    const res = await shell(`test -f ${shQuote(remote)} && echo 1 || echo 0`);
    return Boolean(res && res.exit === 0 && String(res.stdout || '').trim() === '1');
  }

  async function ensureRemoteDirs() {
    const dirs = [root, ...C.REMOTE_DIR_NAMES.map((name) => `${root}/${name}`)];
    for (const dir of dirs) {
      const res = await shell(`mkdir -p ${shQuote(dir)}`);
      if (!res || res.exit !== 0) {
        throw new C.BridgeError('adb_unavailable', `无法创建手机目录：${dir}`);
      }
    }
    return dirs;
  }

  /**
   * Atomic remote write: push to <root>/tmp, then mv -f to the final path.
   * @param {string} local
   * @param {string} remoteFinal
   */
  async function pushAtomic(local, remoteFinal) {
    const name = safeLeaf(path.posix.basename(remoteFinal));
    const remoteTmp = `${root}/tmp/${name}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    const pushed = await adb.push(local, remoteTmp, { timeoutMs: 60000 });
    if (!pushed || (typeof pushed.bytes === 'number' && pushed.bytes === 0 && fs.statSync(local).size > 0)) {
      throw new C.BridgeError('adb_unavailable', `写入手机文件失败：${remoteFinal}`);
    }
    const mv = await shell(`mv -f ${shQuote(remoteTmp)} ${shQuote(remoteFinal)}`);
    if (!mv || mv.exit !== 0) {
      await shell(`rm -f ${shQuote(remoteTmp)}`);
      throw new C.BridgeError('adb_unavailable', `无法将临时文件移动到 ${remoteFinal}`);
    }
    return remoteFinal;
  }

  /**
   * Read the current remote content (or null when absent/unreadable).
   * @param {string} remote
   * @returns {Promise<Buffer|null>}
   */
  async function pullBytes(remote) {
    const local = path.join(getLocalDir(), `pull-${crypto.randomBytes(6).toString('hex')}.bin`);
    try {
      await adb.pull(remote, local, { timeoutMs: shellTimeoutMs, maxBytes: 2 * 1024 * 1024 });
      return fs.readFileSync(local);
    } catch {
      return null;
    } finally {
      fs.rmSync(local, { force: true });
    }
  }

  /**
   * Sync one text file to the phone unless the content already matches.
   *
   * @param {{localPath:string, remoteName:string, mode:string, force?:boolean, label:string}} spec
   * @returns {Promise<object>}
   */
  async function syncTextFile(spec) {
    const remote = `${root}/${spec.remoteName}`;
    const source = fs.readFileSync(spec.localPath, 'utf8');
    const text = normalizeText(source);
    const buffer = Buffer.from(text, 'utf8');
    const digest = sha256(buffer);

    if (!spec.force) {
      const existing = await pullBytes(remote);
      if (existing && sha256(existing) === digest) {
        const modeApplied = await chmod(remote, spec.mode);
        return {
          name: spec.remoteName,
          label: spec.label,
          remote,
          bytes: buffer.length,
          sha256: digest,
          mode: spec.mode,
          mode_applied: modeApplied,
          changed: false,
          verified: await remoteExists(remote),
        };
      }
    }

    const local = path.join(getLocalDir(), `push-${spec.remoteName}-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(local, buffer);
    try {
      await pushAtomic(local, remote);
    } finally {
      fs.rmSync(local, { force: true });
    }
    const modeApplied = await chmod(remote, spec.mode);
    return {
      name: spec.remoteName,
      label: spec.label,
      remote,
      bytes: buffer.length,
      sha256: digest,
      mode: spec.mode,
      mode_applied: modeApplied,
      changed: true,
      verified: await remoteExists(remote),
    };
  }

  /**
   * Best-effort chmod; FUSE may ignore it, so a failure is a warning at most.
   * @param {string} remote
   * @param {string} mode
   */
  async function chmod(remote, mode) {
    const res = await shell(`chmod ${mode} ${shQuote(remote)}`);
    return Boolean(res && res.exit === 0);
  }

  /**
   * @param {{token?:string|null, port?:number, force?:boolean}} [input]
   * @returns {Promise<object>} DeployReport-like object
   */
  async function run(input = {}) {
    const report = {
      ok: false,
      root,
      assets_dir: assetsDir,
      at: new Date(clock.now()).toISOString(),
      files: [],
      token: { provided: false, pushed: false, changed: false, remote: `${root}/${TOKEN_REMOTE_NAME}` },
      port: { value: null, pushed: false, changed: false, remote: `${root}/${PORT_REMOTE_NAME}` },
      dirs: [],
      warnings: [],
      errors: [],
    };

    try {
      report.dirs = await ensureRemoteDirs();
    } catch (err) {
      report.errors.push({ code: err.code || 'adb_unavailable', message: err.message });
      lastReport = report;
      return report;
    }

    // ── assets ────────────────────────────────────────────────────────────
    for (const spec of ASSET_SPECS) {
      const localPath = path.join(assetsDir, spec.local);
      try {
        const stat = fs.statSync(localPath);
        if (!stat.isFile()) throw new Error('not a file');
      } catch {
        report.errors.push({
          code: 'invalid_config',
          message: `缺少手机侧资产：${localPath}`,
        });
        continue;
      }
      try {
        report.files.push(
          await syncTextFile({
            localPath,
            remoteName: spec.name,
            mode: spec.mode,
            force: input.force === true,
            label: spec.local,
          })
        );
      } catch (err) {
        report.errors.push({ code: err.code || 'internal_error', message: err.message, file: spec.name });
      }
    }

    // ── port.txt ──────────────────────────────────────────────────────────
    const port = Number(input.port !== undefined ? input.port : config.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      report.errors.push({ code: 'invalid_args', message: `非法端口：${String(input.port)}` });
    } else {
      const portLocal = path.join(getLocalDir(), `port-${process.pid}.txt`);
      fs.writeFileSync(portLocal, `${port}\n`, 'utf8');
      try {
        const synced = await syncTextFile({
          localPath: portLocal,
          remoteName: PORT_REMOTE_NAME,
          mode: '644',
          force: input.force === true,
          label: 'port.txt',
        });
        report.port = { value: port, pushed: true, changed: synced.changed, remote: synced.remote };
        report.files.push(synced);
      } catch (err) {
        report.errors.push({ code: err.code || 'internal_error', message: err.message, file: PORT_REMOTE_NAME });
      } finally {
        fs.rmSync(portLocal, { force: true });
      }
    }

    // ── token.txt (phone-scope token only; never operator) ────────────────
    const token = input.token;
    if (token === undefined || token === null || token === '') {
      report.warnings.push(
        '未提供 phone token，跳过 token.txt。operator token 永远不会被推送到手机；请用 TokenStore.issue({scope:"phone"}) 生成后传入。'
      );
    } else if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/=-]{16,}$/.test(token)) {
      report.errors.push({
        code: 'invalid_args',
        message: 'token 必须是长度 ≥ 16 的不含空白字符的字符串',
      });
    } else {
      report.token.provided = true;
      const tokenLocal = path.join(getLocalDir(), `token-${process.pid}.txt`);
      fs.writeFileSync(tokenLocal, `${token}\n`, 'utf8');
      try {
        const synced = await syncTextFile({
          localPath: tokenLocal,
          remoteName: TOKEN_REMOTE_NAME,
          mode: '600',
          force: input.force === true,
          label: 'token.txt',
        });
        report.token.pushed = true;
        report.token.changed = synced.changed;
        report.files.push(synced);
        if (!token.startsWith('khy_')) {
          report.warnings.push('token 不以 khy_ 开头：请确认这是 phone scope token，而不是 operator token。');
        }
      } catch (err) {
        report.errors.push({ code: err.code || 'internal_error', message: err.message, file: TOKEN_REMOTE_NAME });
      } finally {
        // Remove the token copy from the local temp directory immediately.
        fs.rmSync(tokenLocal, { force: true });
      }
    }

    report.ok = report.errors.length === 0;
    lastReport = report;
    logger.info('phone bootstrap finished', {
      root,
      ok: report.ok,
      changed: report.files.filter((f) => f.changed).map((f) => f.name),
      errors: report.errors.length,
    });
    return report;
  }

  /**
   * Static description of what run() would push (no ADB access).
   * @returns {{root:string,assets_dir:string,assets:Array<{local:string,remote:string,mode:string}>}}
   */
  function plan() {
    return {
      root,
      assets_dir: assetsDir,
      assets: ASSET_SPECS.map((spec) => ({
        local: path.join(assetsDir, spec.local),
        remote: `${root}/${spec.name}`,
        mode: spec.mode,
      })).concat([
        { local: '(generated)', remote: `${root}/${PORT_REMOTE_NAME}`, mode: '644' },
        { local: '(generated, phone token only)', remote: `${root}/${TOKEN_REMOTE_NAME}`, mode: '600' },
      ]),
    };
  }

  function status() {
    return lastReport;
  }

  function dispose() {
    if (localDirPath) {
      try {
        fs.rmSync(localDirPath, { recursive: true, force: true });
      } catch {
        // best effort
      }
      localDirPath = null;
    }
  }

  return { run, plan, status, dispose, root, assetsDir };
}

module.exports = {
  createBootstrap,
  ASSET_SPECS,
  TOKEN_REMOTE_NAME,
  PORT_REMOTE_NAME,
  normalizeText,
  sha256,
};
