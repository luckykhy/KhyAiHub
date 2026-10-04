'use strict';

/**
 * CLI handler for daemon management commands.
 *
 * Usage:
 *   /daemon start [--port 9090]
 *   /daemon stop
 *   /daemon status
 *   /daemon restart
 *   /daemon logs
 *   /daemon sessions
 */

const dm = require('../../services/daemonManager');
const sp = require('../../services/sessionPersistence');
const { foldOutput } = require('../toolDisplayPolicy');

/**
 * Handle daemon subcommands.
 * @param {string} input - Subcommand and args
 * @param {object} deps
 * @param {object} deps.chalk
 * @param {object} [deps.options]
 */
async function handleDaemon(input, deps) {
  const { chalk: c } = deps;
  const options = deps.options || {};
  const args = String(input || '')
    .trim()
    .split(/\s+/);
  const sub = (args[0] || 'status').toLowerCase();

  switch (sub) {
    case 'start':
      return _start(c, options);
    case 'stop':
      return _stop(c);
    case 'status':
      return _status(c);
    case 'restart':
      return _restart(c, options);
    case 'logs':
      return _logs(c);
    case 'sessions':
      return _sessions(c);
    default:
      _help(c);
  }
}

const _sleep = require('../../utils/sleep'); // single-source sleep ([MGMT-RPT-020] REQ-2026-010)

async function _resolveStartedDaemon(result, options = {}) {
  const attempts = Number.isInteger(options.attempts) ? options.attempts : 8;
  const delayMs = Number.isInteger(options.delayMs) ? options.delayMs : 250;
  let latest = {
    running: true,
    pid: result.pid,
    port: result.port,
    uptime: null,
    health: null,
  };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const status = await dm.daemonStatus();
      if (status?.running && Number(status.pid) === Number(result.pid)) {
        latest = status;
        if (status.port !== result.port || status.health) {
          return latest;
        }
      }
    } catch {
      /* best effort */
    }

    if (attempt < attempts) {
      await _sleep(delayMs);
    }
  }

  return latest;
}

function _formatStartMessage(action, requestedPort, status) {
  const confirmedPort = status?.port || requestedPort;
  if (requestedPort && confirmedPort && requestedPort !== confirmedPort) {
    return `  守护进程${action}（PID ${status.pid}，端口 ${confirmedPort}；请求的 ${requestedPort} 已被占用，自动改用空闲端口）`;
  }
  return `  守护进程${action}（PID ${status.pid}，端口 ${confirmedPort}）`;
}

async function _start(c, options) {
  try {
    const port = options.port ? parseInt(options.port, 10) : undefined;
    const result = dm.daemonStart({ port });
    const status = await _resolveStartedDaemon(result);
    console.log(c.green(_formatStartMessage('已启动', result.port, status)));
    console.log(c.dim(`  日志: ${dm.getLogPath()}`));
  } catch (err) {
    console.log(c.yellow(`  ${err.message}`));
  }
}

function _stop(c) {
  const stopped = dm.daemonStop();
  if (stopped) {
    console.log(c.green('  守护进程已停止'));
  } else {
    console.log(c.yellow('  守护进程未在运行'));
  }
}

async function _status(c) {
  const status = await dm.daemonStatus();
  console.log('');
  if (status.running) {
    const upSec = Math.round((status.uptime || 0) / 1000);
    const upStr = upSec < 60 ? `${upSec}s` : `${Math.round(upSec / 60)}m`;
    console.log(c.green('  守护进程: 运行中'));
    console.log(`  PID:      ${status.pid}`);
    console.log(`  端口:     ${status.port}`);
    console.log(`  运行时长: ${upStr}`);
    if (status.health) {
      console.log(`  健康状态: ${JSON.stringify(status.health)}`);
    }
  } else {
    console.log(c.dim('  守护进程: 未运行'));
  }
  console.log('');
}

async function _restart(c, options) {
  try {
    const port = options.port ? parseInt(options.port, 10) : undefined;
    const result = dm.daemonRestart({ port });
    const status = await _resolveStartedDaemon(result);
    console.log(c.green(_formatStartMessage('已重启', result.port, status)));
  } catch (err) {
    console.log(c.red(`  重启失败: ${err.message}`));
  }
}

function _logs(c) {
  const logPath = dm.getLogPath();
  console.log(c.dim(`  日志文件: ${logPath}`));
  try {
    const fs = require('fs');
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const { lines: foldedLines } = foldOutput(lines, { maxLines: 30, foldHead: 0, foldTail: 30 });
    console.log('');
    for (const line of foldedLines) {
      console.log(`  ${c.dim(line)}`);
    }
    console.log('');
  } catch {
    console.log(c.yellow('  暂无日志文件（守护进程还没启动过）。'));
  }
}

function _sessions(c) {
  const sessions = sp.listPersistedSessions();
  if (sessions.length === 0) {
    console.log(c.dim('  暂无已持久化的会话。'));
    return;
  }
  console.log('');
  console.log(c.bold(`  已持久化会话（${sessions.length}）`));
  console.log('');
  for (const s of sessions) {
    const date = new Date(s.updatedAt).toLocaleString();
    console.log(`  ${c.cyan(s.sessionId)}  ${s.title}  ${c.dim(date)}  (${s.messageCount} 条消息)`);
  }
  console.log('');
}

function _help(c) {
  console.log('');
  console.log(c.bold('  守护进程管理'));
  console.log('');
  console.log(c.dim('    /daemon start [--port 9090]   启动守护进程'));
  console.log(c.dim('    /daemon stop                  停止守护进程'));
  console.log(c.dim('    /daemon status                查看运行状态'));
  console.log(c.dim('    /daemon restart               重启守护进程'));
  console.log(c.dim('    /daemon logs                  查看最近日志'));
  console.log(c.dim('    /daemon sessions              列出已持久化会话'));
  console.log('');
}

module.exports = { handleDaemon };
