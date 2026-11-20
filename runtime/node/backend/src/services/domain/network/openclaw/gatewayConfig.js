'use strict';

/**
 * gatewayConfig.js — pure leaf (zero IO, deterministic, never throws).
 *
 * Resolves how khyos reaches the OpenClaw gateway. Every value is env-overridable
 * and every default comes from constants/serviceDefaults.js — no hostnames, no
 * ports, no absolute paths in this file (RUNTIME-001).
 *
 * The one non-obvious rule: an empty sshAlias disables the gateway instead of
 * falling back to a guessed host. The server has no public address, so a guessed
 * host is always wrong and the failure reads as "the server is down" rather than
 * "you have not told me how to reach it".
 */

const defaults = require('../../../../constants/serviceDefaults');

function _int(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function _str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveGatewayConfig(env = process.env) {
  const sshAlias = _str(env.KHY_OPENCLAW_SSH_ALIAS) || defaults.OPENCLAW_GATEWAY_SSH_ALIAS;
  const identityFile = _str(env.KHY_OPENCLAW_IDENTITY_FILE);
  const clientId = _str(env.KHY_OPENCLAW_CLIENT_ID) || 'khyos';
  const clientMode = _str(env.KHY_OPENCLAW_CLIENT_MODE) || 'probe';
  const platform = _str(env.KHY_OPENCLAW_CLIENT_PLATFORM) || process.platform;
  const deviceFamily = _str(env.KHY_OPENCLAW_CLIENT_DEVICE_FAMILY) || 'khyos';
  const clientVersion = _str(env.KHY_OPENCLAW_CLIENT_VERSION) || '0.1.0';

  const scopes = _str(env.KHY_OPENCLAW_SCOPES)
    ? _str(env.KHY_OPENCLAW_SCOPES).split(',').map((s) => s.trim()).filter(Boolean)
    : ['operator.read', 'operator.write'];

  const role = _str(env.KHY_OPENCLAW_ROLE) || 'operator';

  const config = {
    sshAlias,
    gatewayPort: _int(env.KHY_OPENCLAW_GATEWAY_PORT, defaults.OPENCLAW_GATEWAY_DEFAULT_PORT),
    localPort: _int(env.KHY_OPENCLAW_LOCAL_PORT, 0),
    sshReadyTimeoutMs: _int(
      env.KHY_OPENCLAW_GATEWAY_SSH_READY_TIMEOUT_MS,
      defaults.OPENCLAW_GATEWAY_SSH_READY_TIMEOUT_MS,
    ),
    connectTimeoutMs: _int(
      env.KHY_OPENCLAW_GATEWAY_CONNECT_TIMEOUT_MS,
      defaults.OPENCLAW_GATEWAY_CONNECT_TIMEOUT_MS,
    ),
    requestTimeoutMs: _int(
      env.KHY_OPENCLAW_GATEWAY_REQUEST_TIMEOUT_MS,
      defaults.OPENCLAW_GATEWAY_REQUEST_TIMEOUT_MS,
    ),
    identityFile: identityFile || null,
    clientId,
    clientMode,
    clientVersion,
    platform,
    deviceFamily,
    role,
    scopes,
  };

  const problems = [];
  if (!config.sshAlias) {
    problems.push({
      code: 'ssh_alias_missing',
      message: '未配置 OpenClaw 网关的 ssh 别名：设 KHY_OPENCLAW_SSH_ALIAS（或在 ~/.ssh/config 里建对应 Host）',
    });
  }
  if (config.gatewayPort < 1 || config.gatewayPort > 65535) {
    problems.push({ code: 'gateway_port_invalid', message: `网关端口不合法：${config.gatewayPort}` });
  }

  return { ok: problems.length === 0, problems, config };
}

module.exports = { resolveGatewayConfig };
