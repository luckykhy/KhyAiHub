'use strict';

/**
 * ilinkDeliveryGuard — 「这个文件能不能从微信发出去」的唯一判定点。
 *
 * 为什么必须有这一层：`SendUserFile` 工具本身是只读的（它只 stat 并回路径，见
 * SendUserFileTool/index.js），真正的对外副作用发生在投递那一刻 —— 把本机文件
 * 的字节通过微信 CDN 上传并推给对端。任何「模型被诱导去读一个它不该读的文件」
 * 的攻击，最终都要过这里。所以闸门放在**出站点**，不在权限层。
 *
 * ── 为什么必须先 realpath ────────────────────────────────────────────────
 * 本机 `C:\Users\25789\.khyquant` 本身就是符号链接（`lstatSync().isSymbolicLink()`
 * 为 true，`realpathSync()` = `C:\.khyquant`）。而调用方给守卫的是路径字符串，
 * 紧接着的 `fs.promises.stat` / `fs.promises.readFile` **都会跟随链接**。
 * 于是 `D:\workspace\notes.txt` 只要是指向 `~/.khyquant/built-in-keys.json`
 * 的链接，按字符串比前缀就完全绕过，而内容照发不误。
 * 结论：**危险判定一律作用在 realpath 之后的路径上。**
 *
 * ── 为什么 realpath 挡不住硬链接 ──────────────────────────────────────────
 * realpath 只跟随**符号链接**；对硬链接它返回链接自身（实测
 * `realpath(alias) === realpath(realpath(alias))` 为 true）。于是把
 * `~/.khyquant/built-in-keys.json` 硬链接成允许目录下的 `notes.txt`，前缀规则与文件名
 * 规则全部落空，字节照发不误（复核员实测外发 889 字节真实凭据，守卫全程 ok:true）。
 * 硬链接在禁发目录之外没有「真名」可查 —— 别名就是文件名 —— 所以只能按 nlink 收：
 * 默认只放行唯一目录项（ILINK_DELIVERY_MAX_NLINKS）。
 *
 * ── 为什么文件名规则判两个名字的并集 ──────────────────────────────────────
 * 只判 real 名会新开一条路：`<allow>/.env` 是指向 `<allow>/real.txt` 的文件符号链接，
 * 今天按调用方给的名字被拒，改成只判 real 名反而放行。只判 raw 名又对「名字无害、
 * 目标有害」的链接无能为力。两边都判，是唯一不比现状更松的取值。
 *
 * ── 边界：这是纵深防御，不是沙箱 ──────────────────────────────────────────
 * realpath 与随后的 readFile 之间仍有 TOCTOU 窗口（链接可被换）。这里能关掉的
 * 是「静态放错位置」，关不掉的是「判定后改链接」的真并发攻击。别把它当密室。
 *
 * 禁发清单是启发式的：伪装成 `notes.txt` 的密钥内容挡不住（那要内容扫描，
 * 不在本次范围）。它的定位是「让凭据目录与常见密钥文件在结构上出不去」。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 把一个 glob 片段编译成匹配器。`*` 通配任意字符（含空），其余字符按字面量转义。
 * @param {string} glob 已小写的片段
 * @returns {(name: string) => boolean}
 */
function _globMatcher(glob) {
  const body = glob
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const re = new RegExp(`^${body}$`);
  return (name) => re.test(name);
}

/**
 * 比前缀用的归一化键。Windows 上大小写不敏感，POSIX 上敏感 —— 跟着文件系统走，
 * 不写死一套。
 * @param {string} p
 * @returns {string}
 */
function _key(p) {
  const normalized = path.resolve(p);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** `child` 是否等于 `parent` 或位于其之下。两侧都应当已 `_key` 归一。 */
function _under(parent, child) {
  if (child === parent) {
    return true;
  }
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

/**
 * 对一个目录做实解析，失败返回 null（目录不存在时原路径形态仍然要入表 ——
 * 目录还没建出来不等于这个位置将来安全）。
 * @param {string} dir
 * @returns {string|null}
 */
function _realDir(dir) {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return null;
  }
}

/**
 * 构造禁发目录表：每个目录**同时**收录原路径形态与 realpath 形态。
 *
 * 为什么必须两种形态都在：`~/.khyquant` 在本机是链接，判定路径 realpath 之后是
 * `C:\.khyquant\...`，而调用方给的可能是 `C:\Users\25789\.khyquant\...`；
 * 只收一种就等于两种表示里漏一种。手写两套常量不可能不漂，所以每个目录自己
 * 调一次 realpathSync.native 再入表。
 *
 * @param {{home?: string, dataHome?: string, appHome?: string, baseHome?: string}} [env]
 * @returns {{homeKeys: string[], denyDirKeys: string[]}}
 */
function _denyTable(env = {}) {
  // 显式传 '' 表示「这一项不设」（测试要能真的摘掉一条前缀，否则钉不死
  // 「嵌套目录只有一个有效前缀」那条事实）。未传的键才回落到真实解析器。
  const has = (k) => Object.prototype.hasOwnProperty.call(env, k);
  const home = has('home') ? env.home : os.homedir();
  const pick = (k, fn) => (has(k) ? env[k] : _dataHome(fn));
  const dataHome = pick('dataHome', 'getDataHome');
  const appHome = pick('appHome', 'getAppHome');
  const baseHome = pick('baseHome', 'getBaseHome');

  const dirs = [
    home && path.join(home, '.khyquant'),
    home && path.join(home, '.khy'),
    home && path.join(home, '.ssh'),
    home && path.join(home, '.aws'),
    home && path.join(home, '.gnupg'),
    home && path.join(home, '.config', 'gh'),
    appHome,
    dataHome,
    baseHome,
  ].filter(Boolean);

  const denyDirKeys = [];
  for (const dir of dirs) {
    for (const form of [dir, _realDir(dir)]) {
      if (form) {
        denyDirKeys.push(_key(form));
      }
    }
  }
  return {
    homeKeys: home ? [_key(home), _key(_realDir(home) || home)].filter(Boolean) : [],
    denyDirKeys,
  };
}

/**
 * 取 dataHome 家族的目录。解析器读不出来时返回 ''（那一项就当没配），
 * 而不是抛错把整条投递链路带走。
 * @param {'getDataHome'|'getAppHome'|'getBaseHome'} fn
 * @returns {string}
 */
function _dataHome(fn) {
  try {
    return require('../../../../utils/dataHome')[fn]() || '';
  } catch {
    return '';
  }
}

// 默认形态的禁发表只算一次：dataHome 解析器本身带进程内缓存，而每次投递都重算
// 一次 realpathSync 是白付的 IO。带覆盖项的调用（测试）走独立分支，不进缓存。
let _cachedTable = null;

function _tableFor(overrides) {
  if (overrides) {
    return _denyTable(overrides);
  }
  if (!_cachedTable) {
    _cachedTable = _denyTable();
  }
  return _cachedTable;
}

/**
 * 判定一个路径能不能经微信投递出去。
 *
 * @param {string} absPath 调用方给的绝对路径（可能含符号链接）
 * @param {object} [opts]
 * @param {string[]} [opts.roots] 覆盖 ILINK_DELIVERY_ROOTS（空 = 不限根）
 * @param {string[]} [opts.denyNames] 覆盖 ILINK_DELIVERY_DENY_NAMES
 * @param {object} [opts.pathEnv] 覆盖家目录解析（测试用，见 _denyTable）
 * @param {number} [opts.maxNlinks] 覆盖 ILINK_DELIVERY_MAX_NLINKS（测试用）
 * @returns {Promise<{ok:true, realPath:string, fileName:string}|{ok:false, reason:string, rule:string, realPath?:string}>}
 */
async function isDeliverablePath(absPath, opts = {}) {
  const raw = String(absPath == null ? '' : absPath).trim();
  if (!raw) {
    return { ok: false, rule: 'empty-path', reason: '文件路径为空' };
  }
  if (!path.isAbsolute(raw)) {
    return { ok: false, rule: 'not-absolute', reason: `路径不是绝对路径:${raw}` };
  }

  // 危险判定只作用在 realpath 之后 —— 见文件头「为什么必须先 realpath」。
  let real;
  try {
    real = await fs.promises.realpath(raw);
  } catch (err) {
    // 断链 / 权限不足 / 循环链接都走这里。按拒绝处理：本守卫的默认方向是 fail-closed。
    const detail = (err && (err.code || err.message)) || String(err);
    return {
      ok: false,
      rule: 'resolve-failed',
      reason: `路径解析失败(${detail})`,
    };
  }

  const absKey = _key(raw);
  const realKey = _key(real);
  // 文件名判定取两个名字的并集，见文件头「为什么文件名规则判两个名字的并集」。
  const rawName = path.basename(raw);
  const fileName = path.basename(real);

  // 目录不是「可投递文件」:不查它,免得 ok:true 报一个随后 readFile 必炸(EISDIR)的路径。
  let st;
  try {
    st = await fs.promises.stat(real);
    if (!st.isFile()) {
      return { ok: false, rule: 'not-a-file', reason: `不是普通文件(目录/设备等):${real}`, realPath: real };
    }
  } catch (err) {
    const detail = (err && (err.code || err.message)) || String(err);
    return { ok: false, rule: 'resolve-failed', reason: `路径不可读(${detail})`, realPath: real };
  }

  // 硬链接在 realpath 之后不留任何痕迹，唯一可判的信号就是 nlink；复用上面这次 stat，
  // 不新增 syscall。排在文件名之前：nlink>1 时「文件名」已不是这段字节的稳定标识
  // （同一个 inode 有 N 个目录项，任一个都可能是无害的那个），先拒再谈名字。
  const maxNlinks = Number(opts.maxNlinks) || _defaults().ILINK_DELIVERY_MAX_NLINKS || 1;
  const nlink = st.nlink;
  if (!Number.isInteger(nlink) || nlink < 1 || nlink > maxNlinks) {
    const detail = Number.isInteger(nlink)
      ? `${nlink} 个目录项(上限 ${maxNlinks})`
      : '目录项数不可判定';
    return {
      ok: false,
      rule: 'hardlink',
      reason: `硬链接数不满足可投递条件(${detail}),同一份字节在本机不止一处:${real}`,
      realPath: real,
    };
  }

  const denyNames = (opts.denyNames || _defaults().ILINK_DELIVERY_DENY_NAMES || [])
    .map((n) => String(n).toLowerCase());
  for (const [where, name] of [['调用方给的路径', rawName], ['真实位置', fileName]]) {
    const lower = name.toLowerCase();
    if (denyNames.some((pattern) => _globMatcher(pattern)(lower))) {
      return { ok: false, rule: 'deny-name', reason: `文件名命中禁发规则(${where}):${name}`, realPath: real };
    }
  }

  const { homeKeys, denyDirKeys } = _tableFor(opts.pathEnv);
  for (const dirKey of denyDirKeys) {
    // 两种形态都查：调用方给的原路径形态，以及 realpath 之后的真实位置。
    if (_under(dirKey, absKey) || _under(dirKey, realKey)) {
      return {
        ok: false,
        rule: 'deny-dir',
        reason: `路径位于禁发目录之下:${real}`,
        realPath: real,
      };
    }
  }

  // 家目录根下的 rc 文件（.netrc / .npmrc / .gitconfig …）——目录前缀挡不住它们，
  // 只能按「父目录 == 家目录 + 文件名匹配」这一条形状收。
  const inHome = homeKeys.some(
    (hk) => path.dirname(absKey) === hk || path.dirname(realKey) === hk
  );
  const rcName = inHome ? [rawName, fileName].find((n) => /^\.?.*rc$/.test(n.toLowerCase())) : null;
  if (rcName) {
    return {
      ok: false,
      rule: 'deny-home-rc',
      reason: `家目录下的 rc/凭据文件:${rcName}`,
      realPath: real,
    };
  }

  const roots = opts.roots || _defaults().ILINK_DELIVERY_ROOTS || [];
  if (roots.length) {
    const rootKeys = roots.map((r) => _key(_realDir(r) || r));
    if (!rootKeys.some((rk) => _under(rk, realKey))) {
      // 只比 realKey：realpath 已经把 `..` 解析掉，`<root>/../secret` 落在根外即拒。
      return { ok: false, rule: 'outside-roots', reason: `不在允许投递的根目录之下:${real}`, realPath: real };
    }
  }

  return { ok: true, realPath: real, fileName };
}

/** @returns {object} serviceDefaults（惰性 require：它带一批 IO 相关的解析器） */
function _defaults() {
  try {
    return require('../../../../constants/serviceDefaults');
  } catch {
    return {};
  }
}

module.exports = { isDeliverablePath };
