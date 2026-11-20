'use strict';

/**
 * phoneAdbPortScan.js — 在已知主机上找开着 adb 无线调试的那一个端口。
 *
 * 为什么需要它：adb 无线调试的端口每次开关无线调试 / 重启手机都会换（实测
 * 34103 / 37801 / 45315 / 41631 / 35097 / 40871 / 33743 …），而 IP 通常不变。
 * 手机重连后 adb 会忘了旧 transport，此时两条常规发现路同时是空的：
 *   * `adb devices` 里没有 device 态条目（连接已失效）；
 *   * `adb mdns services` 空——实测本机所在网络的路由器不转发组播，mDNS
 *     靠不住（2026-11-13 实测：手机在 192.168.2.46 上 ICMP 通，mdns 列表空）。
 * 只剩「记住上次的 IP，在它上面扫端口」这一条路。
 *
 * 边界（别把它当万能钥匙）：
 *   * 只扫**一个**已知主机（上次连成功过的那台），不扫网段——扫网段既慢又
 *     像攻击行为；
 *   * 只在常规发现路全部落空后才走，且有并发与超时预算；
 *   * 扫出端口也不等于能用：adb connect 认不认是另一回事，由调用方验证。
 *
 * IO 叶子：只做 TCP 连接探测，不认识 adb、不认识桥。
 */

const net = require('node:net');

/**
 * 扫一个主机上的若干端口，返回开着的那几个。
 *
 * @param {object} options
 * @param {string} options.host 目标主机（IP）
 * @param {number[]} options.ports 要试的端口
 * @param {number} [options.concurrency=400] 并发连接数
 * @param {number} [options.timeoutMs=400] 单个连接的等待上限
 * @param {number} [options.deadlineMs=8000] 整体时间预算
 * @returns {Promise<{ok:boolean, openPorts:number[], elapsedMs:number, timedOut:boolean, error?:string, refused:number, unreachable:number, timedOutCount:number}>}
 *   refused / unreachable / timedOutCount 是「为什么没扫到」的证据：
 *   refused 占多数 = 主机活着但端口都关着（无线调试没开）；
 *   unreachable 占多数 = 主机根本不在（换了 Wi-Fi 或手机离线）。
 */
async function scanHostPorts(options = {}) {
  const host = String(options.host || '').trim();
  const ports = (Array.isArray(options.ports) ? options.ports : [])
    .map((p) => Number(p))
    .filter((p) => Number.isInteger(p) && p > 0 && p <= 65535);
  const concurrency = Math.max(1, Number(options.concurrency) || 400);
  const timeoutMs = Math.max(50, Number(options.timeoutMs) || 400);
  const deadlineMs = Math.max(timeoutMs, Number(options.deadlineMs) || 8000);

  if (!host || ports.length === 0) {
    return {
      ok: false, openPorts: [], elapsedMs: 0, timedOut: false,
      refused: 0, unreachable: 0, timedOutCount: 0, error: 'host 或端口列表为空',
    };
  }

  const started = Date.now();
  const openPorts = [];
  let cursor = 0;
  let timedOut = false;
  let refused = 0;
  let unreachable = 0;
  let timedOutCount = 0;

  const probeOne = (port) => new Promise((resolve) => {
    if (Date.now() - started > deadlineMs) {
      timedOut = true;
      resolve(false);
      return;
    }
    const socket = new net.Socket();
    let settled = false;
    const finish = (open) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => { timedOutCount += 1; finish(false); });
    socket.on('error', (err) => {
      const code = err && err.code ? String(err.code) : 'UNKNOWN';
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
        refused += 1;
      } else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENETDOWN') {
        unreachable += 1;
      }
      finish(false);
    });
    socket.connect(port, host);
  });

  const worker = async () => {
    for (;;) {
      if (timedOut || Date.now() - started > deadlineMs) {
        timedOut = true;
        return;
      }
      const index = cursor;
      cursor += 1;
      if (index >= ports.length) {
        return;
      }
      const open = await probeOne(ports[index]);
      if (open) {
        openPorts.push(ports[index]);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, worker));

  return {
    ok: openPorts.length > 0,
    openPorts: openPorts.sort((a, b) => a - b),
    elapsedMs: Date.now() - started,
    timedOut,
    refused,
    unreachable,
    timedOutCount,
  };
}

module.exports = { scanHostPorts };
