'use strict';

/**
 * amooWorkspaceClient.js — 双向同步工作区的 IO 壳。
 *
 * 三个动作全部走 adb（push/pull/ls），刻意不依赖桥的 HTTP：桥会自己卡死
 * （实测累计 5 次），而「同步代码」这种高频动作不能跟着桥共存亡。桥只是
 * status 的加分项（ls 工具带大小与时间），不在线就退回 adb 名字列表，
 * 并在渲染里说明来源——用户看得出数据质量的差别。
 *
 * 契约（与 amooBridgeClient 一致）：不抛。每个动作返回 {ok, ...}，
 * 失败带中文 error 与可执行的下一步。
 *
 * @module services/domain/network/amoo/amooWorkspaceClient
 */

const fs = require('fs');
const nodePath = require('path');
const crypto = require('crypto');

const {
  MANIFEST_NAME,
  DEFAULT_REMOTE_DIR,
  buildRemoteListArgv,
  buildPushArgv,
  buildPullArgv,
  readManifest,
  writeManifest,
  planPush,
} = require('./amooWorkspacePlan');

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

/**
 * @param {object} [opts]
 * @param {object} [opts.config] resolveAmooConfig 的输出（取 adb.serial）
 * @param {NodeJS.ProcessEnv} [opts.env] 默认 process.env；测试显式注入
 * @param {Function} [opts.resolveSerial] 惰性解析 serial 的注入点；handler 经
 *   amooBridgeClient.ensureDevice()（带发现+写回）提供。缺省时回落 config.adb.serial。
 * @param {Function} [opts.runAdb] (argv) => Promise<{ok,stdout,stderr,error}>
 * @param {Function} [opts.hashFile] (path) => string sha256（测试注入）
 * @param {Function} [opts.sleep]
 * @param {Function} [opts.now]
 */
function createAmooWorkspaceClient(opts = {}) {
  const config = opts.config || {};
  const env = opts.env || process.env;
  // 注入点：handler 经 amooBridgeClient.ensureDevice()（带发现+写回）提供 serial，
  // 别处写回的 serial 后续操作也看得见（惰性解析，不是构造期一次性快照）。
  const resolveSerial = typeof opts.resolveSerial === 'function' ? opts.resolveSerial : null;
  const runAdb = typeof opts.runAdb === 'function' ? opts.runAdb : null;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;
  const hashFile =
    typeof opts.hashFile === 'function'
      ? opts.hashFile
      : (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  function _remoteDir(override) {
    const fromEnv = env.KHY_AMOO_WORKSPACE_DIR;
    return _clean(override) || _clean(fromEnv) || DEFAULT_REMOTE_DIR;
  }

  function _clean(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function _noRunner() {
    return { ok: false, code: 'no_adb_runner', error: '没有可用的 adb 执行器（runAdb 未注入）。' };
  }

  /**
   * 惰性解析 serial：优先注入的 resolveSerial（handler 经 ensureDevice 发现+写回后
   * 提供），否则回落 config.adb.serial。空 serial 时返回结构化错误，而不是打出
   * `adb -s '' push` 这种畸形 argv——workspace 是纯 adb 文件同步，桥卡死时仍要可用，
   * 但不能从「连过期地址」退化成畸形 argv。
   * @returns {Promise<{ok:true, serial:string}|{ok:false, code:string, error:string}>}
   */
  async function _serial() {
    if (resolveSerial) {
      const resolved = await resolveSerial();
      if (typeof resolved === 'string' && resolved.trim()) {
        return { ok: true, serial: resolved.trim() };
      }
    } else {
      const fromConfig = config.adb ? config.adb.serial : '';
      if (typeof fromConfig === 'string' && fromConfig.trim()) {
        return { ok: true, serial: fromConfig.trim() };
      }
    }
    return {
      ok: false,
      code: 'device_not_found',
      error: '未发现手机：adb 设备表为空，mDNS 也没有 _adb-tls-connect 实例。'
        + '请确认手机与电脑在同一局域网、无线调试已开启且此前完成过一次配对；'
        + '本机可用 `adb mdns services` 查看手机广播的连接实例，再重试。'
        + '（或设 KHY_AMOO_DEVICE_SERIAL 指定设备）',
    };
  }

  /** 本地目录的扁平文件清单（跳过 manifest 与子目录，v1 约定）。 */
  function _listLocal(localDir) {
    let entries = [];
    try {
      entries = fs.readdirSync(localDir, { withFileTypes: true });
    } catch (error) {
      return { ok: false, code: 'local_dir_unreadable', error: `读不到本地目录 ${localDir}：${error.message}` };
    }
    const files = [];
    const skippedDirs = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        skippedDirs.push(entry.name);
        continue;
      }
      if (entry.name === MANIFEST_NAME) continue;
      const full = nodePath.join(localDir, entry.name);
      try {
        const stat = fs.statSync(full);
        files.push({ name: entry.name, size: stat.size, sha256: hashFile(full) });
      } catch {
        skippedDirs.push(entry.name);
      }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, files, skippedDirs };
  }

  /**
   * 上传哈希变动的文件。先算计划再动手，一个都不传时说清楚为什么。
   * @param {string} localDir
   * @returns {Promise<object>}
   */
  async function push(localDir) {
    if (!runAdb) return _noRunner();
    const dir = _clean(localDir);
    if (!dir) {
      return { ok: false, code: 'local_dir_missing', error: 'push 需要本地目录。' };
    }
    const remoteDir = _remoteDir('');
    const local = _listLocal(dir);
    if (!local.ok) {
      return local;
    }
    let manifestText = '';
    try {
      manifestText = fs.readFileSync(nodePath.join(dir, MANIFEST_NAME), 'utf8');
    } catch {
      manifestText = ''; // 第一次同步本来就没有
    }
    const manifest = readManifest(manifestText);
    const plan = planPush(local.files, manifest);

    const serialRes = await _serial();
    if (!serialRes.ok) {
      return {
        ok: false,
        code: serialRes.code,
        error: serialRes.error,
        pushed: [],
        skipped: plan.skip,
        remove: plan.remove,
        failed: [],
        remoteDir,
        localDir: dir,
      };
    }
    const uploaded = await _uploadFiles(plan.upload, dir, remoteDir, local.files, manifest, serialRes.serial);
    const pushed = uploaded.pushed;
    const failed = uploaded.failed;

    if (pushed.length > 0) {      try {
        fs.writeFileSync(nodePath.join(dir, MANIFEST_NAME), writeManifest(manifest.files), 'utf8');
      } catch {
        /* manifest 写不出去不影响本次上传，下次按全量重算 */
      }
    }
    return {
      ok: failed.length === 0,
      code: failed.length > 0 ? 'push_partial' : 'ok',
      pushed,
      skipped: plan.skip,
      remove: plan.remove,
      failed,
      remoteDir,
      localDir: dir,
      error: failed.length > 0 ? `${failed.length} 个文件上传失败` : null,
    };
  }

  /**
   * 逐个上传。成功的即时回写 manifest（含 sha256 与 size），失败的收集起来
   * 由调用方决定是否写 manifest——部分失败时刻意不写，下次按全量重算，
   * 比写一份「半真半假」的 manifest 安全。
   * @returns {Promise<{pushed:string[], failed:{name:string,error:string}[]}>}
   */
  async function _uploadFiles(names, dir, remoteDir, localFiles, manifest, serial) {
    const pushed = [];
    const failed = [];
    for (const name of names) {
      const run = await runAdb(buildPushArgv(serial, nodePath.join(dir, name), `${remoteDir}/${name}`));
      if (run.ok) {
        pushed.push(name);
        manifest.files[name] = { sha256: sha256Of(localFiles, name), size: sizeOf(localFiles, name) };
      } else {
        failed.push({ name, error: (run.stderr || run.error || '').trim() || 'adb push 失败' });
      }
    }
    return { pushed, failed };
  }

  function sha256Of(files, name) {
    const hit = files.find((f) => f.name === name);
    return hit ? hit.sha256 : '';
  }

  function sizeOf(files, name) {
    const hit = files.find((f) => f.name === name);
    return hit ? hit.size : 0;
  }

  /**
   * 把手机工作区拉回本地。远端名字列表来自 adb ls（桥不在线也能拉），
   * 逐个文件 pull——flat 约定下这比整目录 pull 的结果可预期。
   * @param {string} [localDir]
   * @returns {Promise<object>}
   */
  async function pull(localDir) {
    if (!runAdb) return _noRunner();
    const serialRes = await _serial();
    if (!serialRes.ok) {
      return { ok: false, code: serialRes.code, error: serialRes.error, pulled: [], failed: [] };
    }
    const serial = serialRes.serial;
    const remoteDir = _remoteDir('');
    const dir = _clean(localDir) || nodePath.join(process.cwd(), 'amoo-dev-pulled');
    const listed = await runAdb(buildRemoteListArgv(serial, remoteDir));
    if (!listed.ok) {
      return {
        ok: false,
        code: 'remote_list_failed',
        error: `列不出手机工作区 ${remoteDir}：${(listed.stderr || listed.error || '').trim() || 'adb ls 失败'}`,
      };
    }
    const names = String(listed.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (names.length === 0) {
      return { ok: true, code: 'remote_empty', pulled: [], localDir: dir, remoteDir, error: null };
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      return { ok: false, code: 'local_dir_unwritable', error: `建不出本地目录 ${dir}：${error.message}` };
    }
    const pulled = [];
    const failed = [];
    for (const name of names) {
      const run = await runAdb(buildPullArgv(serial, `${remoteDir}/${name}`, nodePath.join(dir, name)));
      if (run.ok) pulled.push(name);
      else failed.push(name);
    }
    return {
      ok: failed.length === 0,
      code: failed.length > 0 ? 'pull_partial' : 'ok',
      pulled,
      failed,
      localDir: dir,
      remoteDir,
      error: failed.length > 0 ? `${failed.length} 个文件拉取失败` : null,
    };
  }

  /**
   * 对账：本地清单 + 远端清单。远端优先桥的 ls（带大小），不在线退回 adb
   * 名字列表——来源写进结果，渲染时如实标注。
   * @returns {Promise<object>}
   */
  async function status() {
    const remoteDir = _remoteDir('');
    const localDir = _clean(env.KHY_AMOO_WORKSPACE_LOCAL);
    const local = localDir ? _listLocal(localDir) : { ok: true, files: [], skippedDirs: [] };

    const serialRes = await _serial();
    if (!serialRes.ok) {
      return {
        ok: false,
        code: serialRes.code,
        localDir: localDir || '（未设置 KHY_AMOO_WORKSPACE_LOCAL，只显示手机侧）',
        remoteDir,
        local: local.files || [],
        localSkippedDirs: local.skippedDirs || [],
        remote: [],
        remoteSource: 'adb',
        error: serialRes.error,
      };
    }
    const serial = serialRes.serial;
    const listed = await runAdb(buildRemoteListArgv(serial, remoteDir));
    let remote = [];
    let remoteSource = 'adb';
    let error = null;
    if (listed.ok) {
      remote = String(listed.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((name) => name.length > 0 && name !== MANIFEST_NAME);
    } else {
      error = (listed.stderr || listed.error || '').trim() || 'adb ls 失败';
    }
    return {
      ok: listed.ok,
      code: listed.ok ? 'ok' : 'remote_list_failed',
      localDir: localDir || '（未设置 KHY_AMOO_WORKSPACE_LOCAL，只显示手机侧）',
      remoteDir,
      local: local.files || [],
      localSkippedDirs: local.skippedDirs || [],
      remote,
      remoteSource,
      error,
    };
  }

  return { push, pull, status, remoteDir: _remoteDir('') };
}

module.exports = { createAmooWorkspaceClient };
