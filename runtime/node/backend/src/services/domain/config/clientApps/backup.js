'use strict';

/**
 * 双档备份原语 —— [DESIGN-ARCH-189] P3。
 *
 * 契约（§7.3 共同要求①）：
 *   - `.orig` **永不覆盖**：第一次备份留下的是「用户改之前的出厂/原始态」，
 *     之后无论写多少次都不能动它。它是唯一的回退锚点。
 *   - `.prev` **每次刷新**：最近一次写入前的状态，用于「刚才那次改错了，退回去」。
 *   - `backupKey` 是备份文件的命名空间，**不得等于 appId**：同一个 appId 下可能
 *     有多个受管文件（config.toml + auth.json），两个不同 app 也可能写同一个文件。
 *     用 appId 当 key 会让它们互相覆盖。
 *
 * 三个本原语必须容忍的形状（实测，见 README「已知上游缺陷」）：
 *   1. **目标根本不存在** —— 没东西可备，是成功而非失败（首次配置就是这样）。
 *   2. **目标是目录而非文件** —— coze 的 configPath() 返回模板目录
 *      （cozeAdapter.js 明确注释「供上层显示定位结果」）。备份目录没有意义，
 *      跳过并说明原因，绝不 throw。
 *   3. **空路径** —— COZE_HOME 未设时 configPath() 返回 ''。同上，跳过。
 *
 * 本原语**不决定**该备哪些文件——那是编排层（P5）的职责。这里只提供「给定一个
 * 文件路径和 key，安全地留下双档」以及「一组文件任一失败就整体回退」。
 */

const fs = require('fs');
const path = require('path');

const ORIG_SUFFIX = '.orig';
const PREV_SUFFIX = '.prev';

// backupKey 会进文件名，收紧字符集：只允许字母数字与 -_.，且不以点开头
// （避免 `..` 逃逸或隐藏文件）。
const BACKUP_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function _fail(where, why) {
  const err = new Error(`clientApps 备份原语 ${where}：${why}`);
  err.code = 'CLIENT_APPS_BACKUP_INVALID';
  return err;
}

/**
 * 校验 backupKey。非法即抛 —— 静默接受一个坏 key 会让备份落到意外位置，
 * 而备份失败是最不该静默的一类错误。
 */
function assertBackupKey(backupKey) {
  const k = typeof backupKey === 'string' ? backupKey.trim() : '';
  if (!k) throw _fail('assertBackupKey', 'backupKey 不能为空');
  if (k.includes(path.sep) || k.includes('/')) {
    throw _fail('assertBackupKey', `backupKey 不得含路径分隔符：${JSON.stringify(k)}`);
  }
  if (!BACKUP_KEY_RE.test(k)) {
    throw _fail('assertBackupKey', `backupKey 含非法字符：${JSON.stringify(k)}（只允许字母数字与 -_.，且不以点开头）`);
  }
  return k;
}

/**
 * 备份单文件。
 *
 * @param {string} file 受管文件的绝对路径
 * @param {string} backupKey 备份命名空间（≠ appId）
 * @param {object} [opts]
 * @param {string} [opts.dir] 备份存放目录；缺省与受管文件同目录
 * @returns {{status:'backed-up'|'nothing-to-back-up'|'skipped',
 *            origCreated:boolean, prevWritten:boolean, reason?:string,
 *            origPath?:string, prevPath?:string}}
 */
function backupManagedFile(file, backupKey, opts = {}) {
  const key = assertBackupKey(backupKey);
  const dir = opts.dir || (file ? path.dirname(file) : '');
  const origPath = path.join(dir, `${key}${ORIG_SUFFIX}`);
  const prevPath = path.join(dir, `${key}${PREV_SUFFIX}`);

  // 形状 3：空/非字符串路径
  if (typeof file !== 'string' || !file.trim()) {
    return { status: 'skipped', origCreated: false, prevWritten: false, reason: '目标路径为空（探测未解析）' };
  }
  const target = file.trim();

  // 形状 1：目标不存在 —— 首次配置，没有可备的内容
  if (!fs.existsSync(target)) {
    return {
      status: 'nothing-to-back-up',
      origCreated: false,
      prevWritten: false,
      origPath,
      prevPath,
      reason: '目标文件不存在（首次配置）',
    };
  }

  // 形状 2：目标是目录 —— coze 的 configPath() 就是模板目录
  let st;
  try {
    st = fs.statSync(target);
  } catch (e) {
    return { status: 'skipped', origCreated: false, prevWritten: false, reason: `无法 stat 目标：${e.message}` };
  }
  if (!st.isFile()) {
    return {
      status: 'skipped',
      origCreated: false,
      prevWritten: false,
      reason: st.isDirectory() ? '目标是目录而非文件（coze 的 configPath 语义）' : '目标不是常规文件',
    };
  }

  let origCreated = false;
  let prevWritten = false;

  try {
    fs.mkdirSync(dir, { recursive: true });

    // `.orig` 永不覆盖：只在不存在时创建。已存在就一字不动。
    if (!fs.existsSync(origPath)) {
      fs.copyFileSync(target, origPath);
      origCreated = true;
    }

    // `.prev` 每次刷新：先写临时文件再 rename，避免半截文件被当成有效备份。
    const tmp = path.join(dir, `.${key}${PREV_SUFFIX}.tmp-${process.pid}`);
    fs.copyFileSync(target, tmp);
    fs.renameSync(tmp, prevPath);
    prevWritten = true;
  } catch (e) {
    // 备份失败必须让调用方知道：静默继续写入等于把用户的原文件置于无保护状态。
    throw _fail('backupManagedFile', `备份失败（${origPath} / ${prevPath}）：${e.message}`);
  }

  return { status: 'backed-up', origCreated, prevWritten, origPath, prevPath };
}

/**
 * 备份一组文件，任一失败则**整体回退**。
 *
 * 为什么需要：实测有两个 app 的顺序写是两个文件（reasonixAdapter.js 的两处
 * atomicWrite、commandCodeAdapter.js 同理），而 atomicWrite 是单文件的——
 * 第二个文件失败时第一个已经被改了。「整笔回退」指把本次已刷新过 `.prev`
 * 的文件还原回受管文件，让这批写入整体作废。
 *
 * 注意：`.orig` **不参与回退**。它是原始态锚点，回退用它会把「第二次配置」
 * 也打回出厂态，那不是调用方要的。
 *
 * @param {Array<{file:string, backupKey:string, opts?:object}>} specs
 * @returns {{ok:boolean, results:Array, restored:string[], error?:string}}
 */
function backupManagedSet(specs) {
  if (!Array.isArray(specs)) throw _fail('backupManagedSet', 'specs 必须是数组');
  const results = [];
  const restored = [];

  for (const spec of specs) {
    if (!spec || typeof spec !== 'object') throw _fail('backupManagedSet', 'spec 条目必须是 {file, backupKey}');
    let r;
    try {
      r = backupManagedFile(spec.file, spec.backupKey, spec.opts || {});
    } catch (e) {
      // 回退本次已经刷新过 .prev 的那些文件。results 里带 file（下方 push 时
      // 合入），所以还原目标是明确的，不需要调用方再传一遍。
      for (const done of results) {
        if (done.status !== 'backed-up' || !done.prevPath || !done.file) continue;
        try {
          if (fs.existsSync(done.prevPath)) {
            fs.copyFileSync(done.prevPath, done.file);
            restored.push(done.file);
          }
        } catch {
          /* 回退尽力而为；调用方应把 restored 与 error 一并上报 */
        }
      }
      return { ok: false, results, restored, error: e.message };
    }
    results.push(Object.assign({ file: spec.file }, r));
  }

  return { ok: true, results, restored };
}

module.exports = {
  backupManagedFile,
  backupManagedSet,
  assertBackupKey,
  ORIG_SUFFIX,
  PREV_SUFFIX,
  BACKUP_KEY_RE,
};
