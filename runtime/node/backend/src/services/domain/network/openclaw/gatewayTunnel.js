'use strict';

/**
 * gatewayTunnel.js — thin IO shell: bring up the ssh local forward that reaches
 * the gateway.
 *
 * The server has no public address and binds every application port to loopback,
 * so a forward is the only way in. ssh resolves the alias through ~/.ssh/config
 * (including any ProxyCommand), which is why this spawns the system ssh rather
 * than speaking the protocol itself.
 *
 * Two details that are easy to get wrong and were measured rather than assumed:
 *   - readiness must be probed by connecting to the local port, not by watching
 *     the ssh process. ssh reports "connected" before the forward is usable.
 *   - teardown must be idempotent and must not leave a half-dead port behind,
 *     because a stale forward on the same local port fails silently later.
 */

const { spawn } = require('child_process');
const net = require('net');

function _pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function _canConnect(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host, timeout: timeoutMs });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    socket.on('timeout', () => done(false));
  });
}

async function _waitForPort(port, timeoutMs, host = '127.0.0.1') {
  const deadline = Date.now() + timeoutMs;
  const step = 250;
  for (;;) {
    if (await _canConnect(port, host, Math.min(2000, Math.max(200, deadline - Date.now())))) {
      return { ok: true, waitedMs: timeoutMs - Math.max(0, deadline - Date.now()) };
    }
    if (Date.now() >= deadline) return { ok: false, waitedMs: timeoutMs };
    await new Promise((r) => setTimeout(r, step));
  }
}

/**
 * @returns {Promise<{ok:boolean, code?:string, message?:string, tunnel?:object}>}
 *   tunnel = { localPort, sshAlias, pid, stop() }
 */
async function ensureTunnel(config, deps = {}) {
  const spawnImpl = deps.spawnImpl || spawn;
  if (!config || !config.sshAlias) {
    return {
      ok: false,
      code: 'ssh_alias_missing',
      message: '未配置 ssh 别名，无法建立到 OpenClaw 网关的隧道',
    };
  }

  const localPort = config.localPort > 0 ? config.localPort : await _pickFreePort();
  const args = [
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-L',
    `${localPort}:127.0.0.1:${config.gatewayPort}`,
    config.sshAlias,
  ];

  let child;
  try {
    child = spawnImpl('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return { ok: false, code: 'ssh_spawn_failed', message: `无法启动 ssh：${err.message}` };
  }

  let stderr = '';
  if (child.stderr && child.stderr.on) {
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
  }

  const stopped = { value: false };
  const stop = () => {
    if (stopped.value) return { stopped: false };
    stopped.value = true;
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
    return { stopped: true };
  };
  child.on('exit', () => {
    stopped.value = true;
  });

  const ready = await _waitForPort(localPort, config.sshReadyTimeoutMs);
  if (!ready.ok) {
    stop();
    return {
      ok: false,
      code: 'tunnel_not_ready',
      message:
        `ssh 隧道在 ${config.sshReadyTimeoutMs}ms 内未就绪（本地口 ${localPort} → ${config.sshAlias}:${config.gatewayPort}）` +
        (stderr.trim() ? `；ssh 输出：${stderr.trim().slice(0, 400)}` : ''),
    };
  }

  return {
    ok: true,
    tunnel: {
      localPort,
      sshAlias: config.sshAlias,
      gatewayPort: config.gatewayPort,
      pid: child.pid || null,
      stop,
    },
  };
}

module.exports = { ensureTunnel, _pickFreePort, _waitForPort };
