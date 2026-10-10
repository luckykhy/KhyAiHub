'use strict';

/**
 * webRemoteControl — 移动端远程控制（桌面端面板 + 手机浏览器）的对外入口。
 *
 * 桌面端（apps/khyos-desktop/src/main/remote）按路径 require 本模块并把 capabilities
 * 注进来：本模块不认识 Electron，只认识「列工作区 / 列任务 / 读会话 / 发消息 /
 * 中止 / 转达审批」这六个动作，因此 CLI 侧将来要复用同一套协议不需要改这里。
 */

const { REMOTE_DEFAULT_PORT } = require('../constants/serviceDefaults');
const { PairingStore } = require('./pairingCode');
const { createWebRemoteServer } = require('./server');
const protocol = require('./protocol');

function createRemoteControl(opts = {}) {
  const pairing = opts.pairing || new PairingStore({ logger: opts.logger });
  const server = createWebRemoteServer({
    ...opts,
    pairing,
    port: Number(opts.port) > 0 ? Number(opts.port) : REMOTE_DEFAULT_PORT,
  });
  return { ...server, pairing };
}

module.exports = {
  createRemoteControl,
  PairingStore,
  createWebRemoteServer,
  STATUS: protocol.STATUS,
  ROLE: protocol.ROLE,
  INBOUND: protocol.INBOUND,
  OUTBOUND: protocol.OUTBOUND,
  ERROR_CODE: protocol.ERROR_CODE,
};
