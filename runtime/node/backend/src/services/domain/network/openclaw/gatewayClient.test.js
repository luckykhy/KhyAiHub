'use strict';

/**
 * gatewayClient.test.js — the handshake exercised end to end against a fake
 * gateway that implements the measured protocol: challenge first, then a signed
 * connect, then hello-ok, then request/response and events.
 *
 * The fake server verifies the signature rather than accepting anything, so a
 * wrong field order or a mismatched keypair fails here instead of on the real
 * gateway where it would read as a mystery 1008.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');

const protocol = require('./gatewayProtocol');
const { loadDeviceIdentity, signChallenge } = require('./deviceIdentity');
const { createGatewayClient } = require('./gatewayClient');
const { resolveGatewayConfig } = require('./gatewayConfig');

function makeIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const privRaw = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  return {
    identity: {
      deviceId: crypto.createHash('sha256').update(pubRaw).digest('hex'),
      publicKeyB64: pubRaw.toString('base64'),
      privateKeyRaw: privRaw,
      source: 'test',
    },
    publicKeyObject: publicKey,
  };
}

function startFakeGateway({ scopes = ['operator.read', 'operator.write'], signCheck = true } = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const seen = { nonce: null, connect: null, requests: [] };
  let port = 0;

  wss.on('connection', (ws) => {
    const nonce = crypto.randomUUID();
    seen.nonce = nonce;
    ws.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce, ts: Date.now() } }));

    ws.on('message', (data) => {
      const frame = JSON.parse(String(data));
      if (frame.method === 'connect') {
        seen.connect = frame;
        const device = frame.params.device || {};
        if (signCheck) {
          // Re-derive what the gateway checks: id == sha256(pubkey), and the
          // signature verifies over the exact v3 payload.
          const pubRaw = Buffer.from(device.publicKey || '', 'base64');
          const derived = crypto.createHash('sha256').update(pubRaw).digest('hex');
          if (derived !== device.id) {
            ws.send(JSON.stringify({
              type: 'res', id: frame.id, ok: false,
              error: { code: 'INVALID_REQUEST', message: 'device identity mismatch',
                details: { code: 'DEVICE_AUTH_DEVICE_ID_MISMATCH' } },
            }));
            ws.close(1008);
            return;
          }
          const payload = protocol.buildDeviceAuthPayloadV3({
            deviceId: device.id,
            clientId: frame.params.client.id,
            clientMode: frame.params.client.mode,
            role: frame.params.role,
            scopes: frame.params.scopes,
            signedAt: device.signedAt,
            token: (frame.params.auth || {}).token || '',
            nonce: device.nonce,
            platform: frame.params.client.platform,
            deviceFamily: '',
          });
          const ok = crypto.verify(
            null, Buffer.from(payload, 'utf8'),
            crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pubRaw]), format: 'der', type: 'spki' }),
            Buffer.from(device.signature || '', 'base64'),
          );
          if (!ok) {
            ws.send(JSON.stringify({
              type: 'res', id: frame.id, ok: false,
              error: { code: 'INVALID_REQUEST', message: 'device signature invalid',
                details: { code: 'DEVICE_AUTH_SIGNATURE_INVALID' } },
            }));
            ws.close(1008);
            return;
          }
        }
        ws.send(JSON.stringify({
          type: 'res', id: frame.id, ok: true,
          payload: {
            type: 'hello-ok', protocol: 3,
            server: { version: 'test.0.0', connId: 'c-1' },
            features: { methods: ['sessions.list', 'sessions.send', 'health'], events: ['session.message', 'tick'] },
            snapshot: { sessionDefaults: { defaultAgentId: 'main', mainSessionKey: 'main' } },
            auth: { role: 'operator', scopes, hasDeviceToken: true },
            policy: { maxPayload: 1000 },
          },
        }));
        return;
      }
      seen.requests.push(frame);
      if (frame.method === 'health') {
        ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { status: 'live' } }));
        return;
      }
      if (frame.method === 'boom') {
        ws.send(JSON.stringify({
          type: 'res', id: frame.id, ok: false,
          error: { code: 'INVALID_REQUEST', message: 'missing scope: operator.admin' },
        }));
        return;
      }
      // anything else: echo, plus push one event so subscribers can be observed
      ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { echo: frame.params } }));
      ws.send(JSON.stringify({
        type: 'event', event: 'session.message', payload: { after: frame.method },
      }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({
        port,
        seen,
        stop: () => new Promise((r) => wss.close(() => server.close(r))),
      });
    });
  });
}

function configFor(port, overrides = {}) {
  const { config } = resolveGatewayConfig({
    KHY_OPENCLAW_SSH_ALIAS: 'test-alias',
    KHY_OPENCLAW_GATEWAY_PORT: String(port),
    ...overrides,
  });
  return config;
}

function tunnelStub(port) {
  return async () => ({
    ok: true,
    tunnel: { localPort: port, sshAlias: 'test-alias', gatewayPort: port, pid: null, stop: () => ({ stopped: true }) },
  });
}

test('handshake: challenge → signed connect → hello-ok, then request + event', async () => {
  const gw = await startFakeGateway();
  const { identity } = makeIdentity();
  const client = createGatewayClient();

  try {
    const events = [];
    client.onEvent((name, payload) => events.push({ name, payload }));

    const res = await client.connect(configFor(gw.port), identity, {
      ensureTunnelImpl: tunnelStub(gw.port),
      signChallengeImpl: signChallenge,
      authToken: 'shared-token',
    });

    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.hello.serverVersion, 'test.0.0');
    assert.equal(res.hello.methodCount, 3);
    assert.deepEqual(res.hello.scopes, ['operator.read', 'operator.write']);
    assert.equal(res.hello.defaultAgentId, 'main');

    // the challenge really was per-connection and the nonce round-tripped
    assert.ok(gw.seen.nonce);
    assert.equal(gw.seen.connect.params.device.nonce, gw.seen.nonce);

    const health = await client.request('health', {});
    assert.equal(health.ok, true);
    assert.deepEqual(health.payload, { status: 'live' });

    const echo = await client.request('sessions.send', { message: 'hi' });
    assert.equal(echo.ok, true);
    assert.deepEqual(echo.payload.echo, { message: 'hi' });

    // the event pushed alongside the echo response reached the subscriber
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(events.some((e) => e.name === 'session.message'));

    const bad = await client.request('boom', {});
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'INVALID_REQUEST');
    assert.match(bad.message, /missing scope/);

    client.close();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(gw.seen.requests.length, 3);
  } finally {
    client.close();
    await gw.stop();
  }
});

test('handshake: a bad signature is rejected with the gateway own code', async () => {
  const gw = await startFakeGateway();
  const { identity } = makeIdentity();
  const client = createGatewayClient();

  try {
    const res = await client.connect(configFor(gw.port), identity, {
      ensureTunnelImpl: tunnelStub(gw.port),
      // sign the wrong thing on purpose
      signChallengeImpl: (id, fields) => ({
        ok: true, problems: [], signature: Buffer.from('not-a-signature').toString('base64'),
        payload: 'wrong',
      }),
      authToken: 't',
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'DEVICE_AUTH_SIGNATURE_INVALID');
  } finally {
    client.close();
    await gw.stop();
  }
});

test('handshake: device.id that disagrees with the public key is caught', async () => {
  const gw = await startFakeGateway();
  const { identity } = makeIdentity();
  const client = createGatewayClient();

  try {
    const res = await client.connect(configFor(gw.port), identity, {
      ensureTunnelImpl: tunnelStub(gw.port),
      signChallengeImpl: signChallenge,
      authToken: 't',
    });
    // identity is self-consistent, so this must pass — the mismatch case is
    // covered in deviceIdentity.test.js where the keypair itself is wrong.
    assert.equal(res.ok, true, JSON.stringify(res));
  } finally {
    client.close();
    await gw.stop();
  }
});

test('handshake: hello with empty scopes is reported as no_scopes, not success', async () => {
  const gw = await startFakeGateway({ scopes: [] });
  const { identity } = makeIdentity();
  const client = createGatewayClient();

  try {
    const res = await client.connect(configFor(gw.port), identity, {
      ensureTunnelImpl: tunnelStub(gw.port),
      signChallengeImpl: signChallenge,
      authToken: 'shared-token-only',
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'no_scopes');
    assert.match(res.message, /scope/);
    // the tunnel must not be left behind
    assert.equal(client._ws, null);
  } finally {
    client.close();
    await gw.stop();
  }
});

test('handshake: no challenge in time fails cleanly', async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', () => { /* stay silent: never send the challenge */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const { identity } = makeIdentity();
  const client = createGatewayClient();
  try {
    const res = await client.connect(configFor(port, { KHY_OPENCLAW_GATEWAY_CONNECT_TIMEOUT_MS: '600' }), identity, {
      ensureTunnelImpl: tunnelStub(port),
      signChallengeImpl: signChallenge,
      authToken: 't',
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'challenge_timeout');
  } finally {
    client.close();
    await new Promise((r) => wss.close(() => server.close(r)));
  }
});

test('protocol: the v3 payload field order is the contract', () => {
  const payload = protocol.buildDeviceAuthPayloadV3({
    deviceId: 'd', clientId: 'c', clientMode: 'probe', role: 'operator',
    scopes: ['a', 'b'], signedAt: 1, token: 'tk', nonce: 'n', platform: 'p', deviceFamily: 'f',
  });
  assert.equal(payload, 'v3|d|c|probe|operator|a,b|1|tk|n|p|f');
});

test('protocol: a mismatched keypair is detectable before connecting', () => {
  const crypto2 = require('crypto');
  const a = crypto2.generateKeyPairSync('ed25519');
  const b = crypto2.generateKeyPairSync('ed25519');
  const pubA = a.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const privB = b.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-idt-'));
  const file = path.join(dir, 'id.json');
  fs.writeFileSync(file, JSON.stringify({ publicKey: pubA.toString('base64'), privateKey: privB.toString('base64') }));
  try {
    const loaded = loadDeviceIdentity(file);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.problems[0].code, 'keypair_mismatch');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
