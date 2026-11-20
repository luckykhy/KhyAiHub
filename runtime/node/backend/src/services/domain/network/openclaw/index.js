'use strict';

/**
 * openclaw — khyos ↔ OpenClaw gateway (the cloud sandbox) direct channel.
 *
 * What this unit is for: the gateway is reachable without the phone. It speaks
 * WS on one port, authenticates with a per-connection signed challenge, and
 * advertises its whole RPC surface in the hello frame. That makes the
 * "orchestration" half of today's adb-mediated path replaceable by a
 * program-to-program call — while the phone-local half (UI automation,
 * clipboard, /sdcard, camera) stays where it is, because the gateway cannot do
 * those.
 *
 * Layering, and why:
 *   gatewayConfig     pure — where the gateway is and how we present ourselves
 *   gatewayProtocol   pure — frame shapes and the signed payload string
 *   deviceIdentity    IO   — keypair load + consistency check + signing
 *   gatewayTunnel     IO   — the ssh local forward (no public IP, so the only way in)
 *   gatewayClient     IO   — the socket, the handshake, one RPC at a time
 *
 * Nothing here decides policy: which methods khyos is allowed to call, and
 * whether an action needs confirmation, belongs to the caller.
 */

const { resolveGatewayConfig } = require('./gatewayConfig');
const { loadDeviceIdentity, deriveDeviceId, signChallenge } = require('./deviceIdentity');
const { ensureTunnel } = require('./gatewayTunnel');
const { createGatewayClient } = require('./gatewayClient');
const protocol = require('./gatewayProtocol');

module.exports = {
  resolveGatewayConfig,
  loadDeviceIdentity,
  deriveDeviceId,
  signChallenge,
  ensureTunnel,
  createGatewayClient,
  protocol,
};
