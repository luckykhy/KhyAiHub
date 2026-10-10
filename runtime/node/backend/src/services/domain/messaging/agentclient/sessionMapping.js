'use strict';

/**
 * sessionMapping.js — ACP sessionId ↔ 会话记录的进程内单一真源（P0/P1 内存态）。
 *
 * P1 的对话上下文由 ai.chat 的 live session（模块级 _chatState）承载并自动持久化，
 * 本表只登记 ACP 侧会话元数据（id/cwd/时间），供方法面校验与 P2 的 session/load 扩展。
 *
 * 已知限制（[DESIGN-ARCH-184] §11）：多 ACP 会话并发时共享进程级上下文——P1 回合
 * 串行执行（一次只跑一个 prompt turn），跨会话隔离留 P2（需 per-session 上下文切换）。
 */

const crypto = require('crypto');

const sessions = new Map();

/**
 * 创建会话记录。cwd 必须绝对路径（协议 MUST），由调用方校验。
 * @param {string} cwd
 * @param {object} [extra]
 * @returns {{id: string, cwd: string, createdAt: string}}
 */
function createSession(cwd, extra = {}) {
  const id = `sess_${crypto.randomBytes(9).toString('hex')}`;
  const rec = { id, cwd, createdAt: new Date().toISOString(), ...extra };
  sessions.set(id, rec);
  return rec;
}

function getSession(id) {
  return sessions.get(String(id || '')) || null;
}

function listSessions() {
  return Array.from(sessions.values());
}

/** 会话结束（session/close / 连接断开）时清登记。 */
function deleteSession(id) {
  return sessions.delete(String(id || ''));
}

function resetForTest() {
  sessions.clear();
}

module.exports = { createSession, getSession, listSessions, deleteSession, resetForTest };
