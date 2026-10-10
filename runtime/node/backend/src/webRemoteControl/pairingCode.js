'use strict';

/**
 * pairingCode.js — 一次性配对码 + 已配对设备，委托 services/devicePairing.js 管身份与作用域。
 *
 * 本文件是 devicePairing.js（Ed25519 身份、角色层级、token 作用域、配对生命周期）
 * 入库以来的第一个消费者：配对密码学不在这里重写，只补它没有的两件事——
 *   1. 面向人的 8 位一次性配对码（手机扫码带过来的就是它）；
 *   2. 「桌面端确认时才决定角色」的顺序：先挂起，人点了同意才 createPairingRequest
 *      + approvePairing，避免未确认的设备先占一个 operator 记录。
 *
 * token 只存内存：桌面端重启后必须重新扫码。这是刻意选择——把 token 落盘会与本模块
 * 的委托对象（DevicePairingManager 的 _tokenIndex）形成两份真源。
 */

const crypto = require('crypto');
const path = require('path');

const { DevicePairingManager, PAIRING_STATE } = require('../services/devicePairing');
const { getDataHome } = require('../utils/dataHome');
const {
  PAIR_CODE_ALPHABET,
  PAIR_CODE_LENGTH,
  PAIR_CODE_TTL_MS,
  ROLE,
} = require('./protocol');

const MAX_LIVE_CODES = 3;
const IDENTITY_BASENAME = path.join('web-remote', 'identity.json');

function randomPairCode() {
  const bytes = crypto.randomBytes(PAIR_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < PAIR_CODE_LENGTH; i += 1) {
    out += PAIR_CODE_ALPHABET[bytes[i] % PAIR_CODE_ALPHABET.length];
  }
  return out;
}

/**
 * 配对码的 sha256 充当远端设备指纹：扫码阶段手机没有公钥，而配对码本身就是这段
 * 关系的唯一凭据，由它派生 deviceId 可让同一码的重复提交收敛到同一条记录。
 */
function fingerprintOfCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function normalizeRole(role) {
  return role === ROLE.OPERATOR ? ROLE.OPERATOR : ROLE.VIEWER;
}

class PairingStore {
  constructor(opts = {}) {
    this._ttlMs = Number(opts.requestTtlMs) > 0 ? Number(opts.requestTtlMs) : PAIR_CODE_TTL_MS;
    this._logger = opts.logger || null;
    this._identityPath =
      opts.identityPath || path.join(getDataHome(), IDENTITY_BASENAME);
    this._manager = new DevicePairingManager({
      identityPath: this._identityPath,
      requestTtlMs: this._ttlMs,
      tokenTtlMs: Number(opts.tokenTtlMs) > 0 ? Number(opts.tokenTtlMs) : undefined,
    });
    /** @type {Map<string, {code:string, expiresAt:number, deviceInfo:object|null}>} */
    this._codes = new Map();
    // 已通过配对码、等待人在面板上点同意的请求：pairingId(=已消费的码) → 同一 entry
    this._pending = new Map();
    this._localIdentity = null;
  }

  async getLocalIdentity(deviceName) {
    if (!this._localIdentity) {
      this._localIdentity = await this._manager.getLocalIdentity(deviceName);
    }
    return this._localIdentity;
  }

  _pruneCodes() {
    const now = Date.now();
    for (const [code, entry] of this._codes) {
      if (entry.expiresAt <= now) this._codes.delete(code);
    }
    while (this._codes.size >= MAX_LIVE_CODES) {
      const oldest = [...this._codes.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (!oldest) break;
      this._codes.delete(oldest[0]);
    }
  }

  /** 生成（或复用）一个待扫码的配对码。 */
  issueCode() {
    this._pruneCodes();
    const fresh = randomPairCode();
    this._codes.set(fresh, { code: fresh, expiresAt: Date.now() + this._ttlMs, deviceInfo: null });
    return { code: fresh, expiresAt: this._codes.get(fresh).expiresAt };
  }

  /**
   * 手机带着配对码来敲门：只登记设备信息并转入待确认，不发 token。
   * @returns {{ok:true, pairingId:string, deviceInfo:object}|{ok:false, code:string}}
   */
  submitPairing(rawCode, deviceInfo) {
    this._pruneCodes();
    const code = String(rawCode || '').trim().toUpperCase();
    const entry = this._codes.get(code);
    if (!entry) return { ok: false, code: 'SESSION_NOT_FOUND' };
    if (entry.expiresAt <= Date.now()) {
      this._codes.delete(code);
      return { ok: false, code: 'SESSION_EXPIRED' };
    }
    entry.deviceInfo = deviceInfo && typeof deviceInfo === 'object' ? deviceInfo : null;
    // 配对码一次一用：确认页刷新时手机会拿到 SESSION_NOT_FOUND 并提示重新扫码。
    this._codes.delete(code);
    this._pending.set(code, entry);
    return { ok: true, pairingId: code, deviceInfo: entry.deviceInfo };
  }

  /** 待桌面端确认的配对请求（面板上的确认框数据源）。 */
  pendingRequests() {
    const now = Date.now();
    for (const [id, e] of this._pending) {
      if (e.expiresAt <= now) this._pending.delete(id);
    }
    return [...this._pending.values()].map((e) => ({
      pairingId: e.code,
      deviceInfo: e.deviceInfo,
      expiresAt: e.expiresAt,
    }));
  }

  /**
   * 人点「同意」之后才真正建设备并发 token。
   * @returns {Promise<{ok:true, token:string, expiresAt:number, device:object}>}
   */
  async approve(pairingId, role) {
    const entry = this._pending.get(String(pairingId || ''));
    if (!entry) return { ok: false, code: 'SESSION_NOT_FOUND' };
    this._pending.delete(entry.code);
    if (entry.expiresAt <= Date.now()) return { ok: false, code: 'SESSION_EXPIRED' };

    const normalized = normalizeRole(role);
    const name = String((entry.deviceInfo && entry.deviceInfo.name) || 'phone').slice(0, 60);
    const created = await this._manager.createPairingRequest(
      fingerprintOfCode(entry.code),
      name,
      normalized,
    );
    const issued = await this._manager.approvePairing(created.deviceId);
    const device = this._manager.listDevices().find((d) => d.deviceId === created.deviceId) || null;
    this._logger?.info?.(
      `[web-remote] 设备已配对 ${created.deviceId} 角色 ${normalized} 名称 ${name}`,
    );
    return { ok: true, ...issued, device };
  }

  /** 人点「拒绝」或确认框超时。 */
  async reject(pairingId) {
    const entry = this._pending.get(String(pairingId || ''));
    if (!entry) return { ok: false, code: 'SESSION_NOT_FOUND' };
    this._pending.delete(entry.code);
    return { ok: true };
  }

  validateToken(token) {
    const r = this._manager.validateToken(token);
    if (!r.valid) return { valid: false };
    return { valid: true, device: r.device, scopes: r.scopes, role: r.device?.role };
  }

  listDevices() {
    return this._manager
      .listDevices()
      .filter((d) => d.state === PAIRING_STATE.ACTIVE)
      .map((d) => ({
        deviceId: d.deviceId,
        name: d.name,
        role: d.role,
        pairedAt: d.pairedAt,
        lastSeenAt: d.lastSeenAt,
      }));
  }

  async revoke(deviceId) {
    await this._manager.revokePairing(String(deviceId || ''));
    this._logger?.info?.(`[web-remote] 设备已撤销 ${deviceId}`);
    return { ok: true };
  }

  /**
   * 刷新二维码：作废所有未使用的配对码与待确认请求，并撤销全部在用设备——
   * 「之前复制或扫码得到的链接将失效」的兑现。
   */
  async rotate() {
    this._codes.clear();
    this._pending.clear();
    for (const d of this._manager.listDevices()) {
      if (d.state === PAIRING_STATE.ACTIVE) await this._manager.revokePairing(d.deviceId);
    }
    return this.issueCode();
  }

  /** 服务停止时清空一次性凭据，不留在内存里。 */
  clear() {
    this._codes.clear();
    this._pending.clear();
  }
}

module.exports = {
  PairingStore,
  randomPairCode,
  fingerprintOfCode,
  MAX_LIVE_CODES,
};
