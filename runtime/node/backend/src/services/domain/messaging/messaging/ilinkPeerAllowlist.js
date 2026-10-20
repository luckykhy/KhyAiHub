'use strict';

/**
 * ilinkPeerAllowlist.js — 微信入站发送者准入判定（四层并集，命中任一即放行）。
 *
 * 为什么需要：ilinkDispatcher 的 handle() 过去对来路一视同仁——任何人只要扫到绑定
 * 二维码、在微信里跟这个 bot 说一句话，消息就进了 agent（带 cwd / 工具 / 权限审批）。
 * 绑定二维码是**可转发**的（`_sendBindQrCode` 本身就提示「这张码等同于你的 khy 授权
 * 入口」），所以「谁能驱动这个实例」必须是一份显式清单，而不是「谁扫过码」。
 *
 * 四层（并集）：
 *   1. 隐式层：账号记录里的 userId（ilinkAccountStore.getAccount(accountId).userId，
 *      落盘见 saveAccount）。现算不写盘 —— 账号主人自己的 id 不该需要额外配置。
 *   2. env 层：KHY_ILINK_ALLOWED_PEERS（逗号/空白分隔，跨账号）。
 *   3. 存储层：~/.khyos/ilink-peers.json，形状
 *      `{ peers: { [accountId]: { [userId]: { addedAt, source } } } }`。
 *   4. 逃生层：ILINK_ALLOW_UNLISTED（默认关 → 未列名者拒答；显式 =1 才进观察期放行）。
 *
 * **不放 binding store**：binding 是 account → workspace 路由（无绑定即 no-op，
 * 见 ilinkDispatcher._applyBindingRouting），信任判定必须在**没有绑定时**也生效。
 *
 * 写法逐字对齐 ilinkBindingStore（0600 + 原子写 + .bak + fail-soft + 同一个 accountId
 * 字符集）。fail-soft：读不到 → 空表（判定按「未列名」走），写不进 → { ok:false }。
 *
 * @module services/messaging/ilinkPeerAllowlist
 */

const fs = require('fs');
const path = require('path');

const defaults = require('../../../../constants/serviceDefaults');

const { FILE_MODE, _dir, _peersFile, _peersBak, _isValidAccountId } = require('./ilinkStorePaths');

/** 档位中文名。三个展示面（khy wx status / wx allow list / 微信内 /wx）共用这一份。
 *
 * 观察期标签**不写 env 名**：这三个展示面 + wx.js 的提示都会渲染它，env 名一旦写进
 * 标签就会跟着重复（实测渲染成「…(手动 KHY_ILINK_ALLOW_UNLISTED=1)(观察期需手动
 * KHY_ILINK_ALLOW_UNLISTED=1);…」）。env 名由 wx.js 的 _allowModeNotice 承担一次。
 */
const MODE_LABELS = Object.freeze({
  strict: '仅允许名单内(严格)',
  warnOnly: '观察期档(未列名者放行)',
});

/** 读信任表;缺失/损坏 → { peers:{} }。绝不抛。 */
function _readPeers() {
  try {
    const file = _peersFile();
    if (!fs.existsSync(file)) {
      return { peers: {} };
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const peers = raw && typeof raw.peers === 'object' && raw.peers ? raw.peers : {};
    return { peers };
  } catch {
    return { peers: {} };
  }
}

function _writePeers(state) {
  const dir = _dir();
  const file = _peersFile();
  try {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, _peersBak());
      try {
        fs.chmodSync(_peersBak(), FILE_MODE);
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
  const payload = {
    peers: state.peers || {},
    updatedAt: new Date().toISOString(),
  };
  const tmp = path.join(dir, `.ilink-peers.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: FILE_MODE });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, FILE_MODE);
  } catch {
    /* best-effort */
  }
}

/**
 * 取账号存储（隐式层要用账号记录里的 userId）。显式注入优先（测试缝），
 * 未注入时惰性加载真模块；取不到返回 null（隐式层按「无隐式放行」处理）。
 * @param {{accountStore?:object}} [opts]
 * @returns {object|null}
 */
function _accountStore(opts = {}) {
  if (opts && opts.accountStore) {
    return opts.accountStore;
  }
  try {
    return require('./ilinkAccountStore');
  } catch {
    return null;
  }
}

/**
 * 取某账号登录时落盘的 userId（= ilink_user_id）。**现算不写盘。**
 * @param {string} accountId
 * @param {{accountStore?:object}} [opts]
 * @returns {string} 无记录/取不到时为空串
 */
function accountLoginUserId(accountId, opts = {}) {
  if (!_isValidAccountId(accountId)) {
    return '';
  }
  const store = _accountStore(opts);
  if (!store || typeof store.getAccount !== 'function') {
    return '';
  }
  try {
    const acc = store.getAccount(accountId);
    return acc && acc.userId ? String(acc.userId) : '';
  } catch {
    return '';
  }
}

/** env 层的 userId 集合（接受字符串或已切好的数组，便于测试注入）。 */
function _envPeers() {
  const raw = defaults.ILINK_ALLOWED_PEERS;
  return new Set(
    String(raw == null ? '' : raw)
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * 这条入站消息的发送者是否被放行（四层并集；逃生层不在这里，在调用方）。
 * @param {string} accountId
 * @param {string} userId
 * @param {{accountStore?:object}} [opts]
 * @returns {boolean}
 */
function isPeerAllowed(accountId, userId, opts = {}) {
  const uid = String(userId == null ? '' : userId).trim();
  if (!uid) {
    return false;
  }
  if (_envPeers().has(uid)) {
    return true;
  }
  if (accountLoginUserId(accountId, opts) === uid) {
    return true;
  }
  if (!_isValidAccountId(accountId)) {
    return false;
  }
  const bucket = _readPeers().peers[accountId];
  return !!(bucket && typeof bucket === 'object' && Object.prototype.hasOwnProperty.call(bucket, uid));
}

/**
 * 把一个 userId 加入某账号的信任表。
 * @param {string} accountId
 * @param {string} userId
 * @param {string} [source] 来源标记（cli/store/...），只作展示
 * @returns {{ok:true, accountId:string, userId:string, addedAt:string, existed:boolean}|{ok:false, error:string}}
 */
function addPeer(accountId, userId, source) {
  if (!_isValidAccountId(accountId)) {
    return { ok: false, error: 'accountId 非法' };
  }
  const uid = String(userId == null ? '' : userId).trim();
  if (!uid) {
    return { ok: false, error: '缺少 userId' };
  }
  try {
    const state = _readPeers();
    const bucket =
      state.peers[accountId] && typeof state.peers[accountId] === 'object' ? state.peers[accountId] : {};
    const existed = Object.prototype.hasOwnProperty.call(bucket, uid);
    const addedAt = (existed && bucket[uid] && bucket[uid].addedAt) || new Date().toISOString();
    bucket[uid] = { addedAt, source: String(source || 'cli') };
    state.peers[accountId] = bucket;
    _writePeers(state);
    return { ok: true, accountId, userId: uid, addedAt, existed };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 从某账号的信任表移除一个 userId（幂等：不在表里也算成功）。
 * @param {string} accountId
 * @param {string} userId
 * @returns {{ok:true, accountId:string, userId:string}|{ok:false, error:string}}
 */
function removePeer(accountId, userId) {
  if (!_isValidAccountId(accountId)) {
    return { ok: false, error: 'accountId 非法' };
  }
  const uid = String(userId == null ? '' : userId).trim();
  if (!uid) {
    return { ok: false, error: '缺少 userId' };
  }
  try {
    const state = _readPeers();
    const bucket = state.peers[accountId];
    if (bucket && typeof bucket === 'object' && Object.prototype.hasOwnProperty.call(bucket, uid)) {
      delete bucket[uid];
      if (Object.keys(bucket).length) {
        state.peers[accountId] = bucket;
      } else {
        delete state.peers[accountId];
      }
      _writePeers(state);
    }
    return { ok: true, accountId, userId: uid };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 列出信任表全部条目（扁平）。
 * @returns {Array<{accountId:string, userId:string, addedAt:string, source:string}>}
 */
function listPeers() {
  const state = _readPeers();
  return Object.keys(state.peers).flatMap((accountId) => {
    const bucket = state.peers[accountId];
    if (!bucket || typeof bucket !== 'object') {
      return [];
    }
    return Object.keys(bucket).map((userId) => ({
      accountId,
      userId,
      addedAt: (bucket[userId] && bucket[userId].addedAt) || '',
      source: (bucket[userId] && bucket[userId].source) || '',
    }));
  });
}

/** 信任表里的条目数（三处展示共用一个口径）。 */
function peerCount() {
  return listPeers().length;
}

/**
 * 当前准入档位。**三个展示面（khy wx status / wx allow list / 微信内 /wx）都读它**，
 * 否则同一件事会出现三份不一致的说法。
 * @returns {{strict:boolean, label:string}}
 */
function allowMode() {
  // `!== true`，不是 `!== false`：只有**显式** KHY_ILINK_ALLOW_UNLISTED=1 才算开观察期。
  // 常量缺字段 / undefined（本仓测试的桩就会这样）也落到严格档 —— 这是刻意的
  // fail-closed，闸门宁可误拒不可误放。
  //
  // ⚠ 与 wx.js `_draftMode()` 的 `ILINK_DRAFT_CONFIRM !== false` 形状相同、极性相反：
  // DRAFT_CONFIRM fallback=true、开着=安全；本常量 fallback=false、关着=安全。
  // 别为了「统一风格」把这里改成 `!== false` —— 那一改会让默认档重新变成放行。
  const strict = defaults.ILINK_ALLOW_UNLISTED !== true;
  return { strict, label: strict ? MODE_LABELS.strict : MODE_LABELS.warnOnly };
}

module.exports = {
  isPeerAllowed,
  addPeer,
  removePeer,
  listPeers,
  peerCount,
  accountLoginUserId,
  allowMode,
  MODE_LABELS,
  // 供测试
  _peersFile,
};
