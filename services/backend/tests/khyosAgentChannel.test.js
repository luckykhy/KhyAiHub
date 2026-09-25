'use strict';

/**
 * khyosAgentChannel — host-side tests for the AI link of the web kernel terminal.
 *
 * The kernel's shell asks the agent on COM2 (`ai <prose>` / `agentask <question>`)
 * by emitting a DECISION_REQ frame and blocking the caller until a DECISION_RESP
 * arrives or the kernel's own deadline (agentask.h: AGENTASK_DEFAULT_TIMEOUT_MS)
 * expires. This service is the other end of that wire: it attaches the host bridge
 * to the runner's COM2 loopback and answers through a brain.
 *
 * No QEMU and no real gateway: the kernel is replaced by a fake COM2 peer that
 * speaks the same frames (kernel/bridge/khy-frame.js, the codec the kernel's
 * agentframe.c mirrors byte-for-byte), and the gateway by a stub HTTP server.
 * That keeps the test hermetic while still exercising the real wire format, the
 * real bridge, and the real brain.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const http = require('http');

const channelMod = require('../src/services/khyosAgentChannel');

// The bridge module is what the channel itself resolves (KHY_KERNEL_SRC_DIR →
// repo kernel/bridge → bundled layout); reusing that keeps module identity, so a
// stub installed here is the very object the channel calls.
const bridgeMod = channelMod.resolveKernelBridge();
const { frame, protocol, defaultBrain, makeGatewayBrain } = bridgeMod;

// Intent codes — parity with kernel/src/agentask.h (AGENT_INTENT_GENERIC/NL) and
// khy-agent.js. Not re-exported from the bridge index, so declared here.
const INTENT_GENERIC = 0x0000; // agentask <question> → ALLOW / DENY
const INTENT_NL = 0x0001; // ai <prose>        → one SET / GET / SAY line

const AGENT_CONF_PATH = '/disk/etc/agent.conf';

const SAVED_ENV = {};
const ENV_KEYS = ['KHY_GATEWAY_URL', 'PROXY_AUTH_TOKEN', 'KHY_BRAIN_TIMEOUT_MS', 'KHY_BRAIN_MODEL'];

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

/** Send one wire frame to the peer over the socket. */
function send(sock, type, seq, code, payload) {
  if (!sock || sock.destroyed) return; // a detached channel closes COM2 under us
  sock.write(frame.encodeFrame({ type, seq, code, payload: payload || Buffer.alloc(0) }));
}

/**
 * A fake kernel on the other end of COM2: it serves the control plane (answers
 * READ for /disk/etc/agent.conf) and drives the decision plane (sends
 * DECISION_REQ, records the DECISION_RESP it gets back).
 */
function startPeer({ configText = '', readStatus = protocol.STATUS.OK } = {}) {
  const state = { reads: 0, replies: [], sockets: [], seq: 0x80000000 };
  const waiters = [];

  const server = net.createServer((sock) => {
    state.sockets.push(sock);
    // The channel closes COM2 on stop(); a peer socket reset is expected noise here.
    sock.on('error', () => {});
    sock.on('data', (chunk) =>
      frameSplitter.push(chunk));
    const frameSplitter = new frame.FrameSplitter((wire) => {
      let f;
      try {
        f = frame.decodeFrame(wire);
      } catch {
        return; // corrupt frame: ignore, like the kernel does
      }
      if (f.type === frame.TYPE.REQUEST && f.code === protocol.VERB.READ) {
        state.reads += 1;
        const offset = Number(f.payload.readBigUInt64LE(0));
        const want = f.payload.readUInt32LE(8);
        if (readStatus !== protocol.STATUS.OK) {
          send(sock, frame.TYPE.RESPONSE, f.seq, f.code, Buffer.from([readStatus]));
          return;
        }
        const body = Buffer.from(configText, 'utf8');
        const slice = body.subarray(offset, Math.min(body.length, offset + want));
        send(
          sock,
          frame.TYPE.RESPONSE,
          f.seq,
          f.code,
          Buffer.concat([Buffer.from([protocol.STATUS.OK]), u32(slice.length), slice]),
        );
        return;
      }
      if (f.type === frame.TYPE.DECISION_RESP) {
        state.replies.push({ seq: f.seq, code: f.code, text: f.payload.toString('utf8') });
        for (const w of waiters.splice(0)) w();
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        state,
        /** Ask the channel a question, like `ai` / `agentask` does. */
        async ask(question, code, timeoutMs = 4000) {
          const seq = (state.seq = (state.seq + 1) >>> 0);
          const before = state.replies.length;
          send(state.sockets[0], frame.TYPE.DECISION_REQ, seq, code, Buffer.from(question, 'utf8'));
          await waitFor(() => state.replies.length > before, timeoutMs, 'no DECISION_RESP');
          const reply = state.replies[state.replies.length - 1];
          assert.equal(reply.seq, seq, 'DECISION_RESP must echo the request seq');
          return reply;
        },
        close() {
          for (const s of state.sockets) s.destroy();
          server.close();
        },
      });
    });
  });
}

/** Poll a predicate until it holds (or fail loudly). */
function waitFor(predicate, timeoutMs = 2000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let ok = false;
      try {
        ok = !!predicate();
      } catch {
        ok = false;
      }
      if (ok) return resolve(true);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

/** A runner stub with the surface the channel actually uses. */
function makeRunner(port, { agentChannel = true } = {}) {
  return {
    agentChannel,
    agentPort: agentChannel ? port : null,
    connectAgentChannel() {
      return new Promise((resolve, reject) => {
        const sock = net.connect({ host: '127.0.0.1', port }, () => resolve(sock));
        sock.once('error', reject);
      });
    },
  };
}

/** A stub OpenAI-compatible gateway that records what it was asked. */
function startGateway(reply) {
  const seen = { hits: 0, authorization: null, model: null, system: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      seen.hits += 1;
      seen.authorization = req.headers.authorization || null;
      try {
        const parsed = JSON.parse(body);
        seen.model = parsed.model;
        seen.system = parsed.messages[0].content;
      } catch {
        /* leave nulls */
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        seen,
        url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        close: () => server.close(),
      });
    });
  });
}

/** An address nothing listens on (never a hardcoded port). */
function closedPortUrl() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(`http://127.0.0.1:${port}/v1/chat/completions`));
    });
  });
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
  delete process.env.KHY_KHYOS_AGENT_CHANNEL;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

describe('khyosAgentChannel', () => {
  test('resolves the bridge from the kernel tree', () => {
    assert.ok(bridgeMod, 'kernel/bridge must resolve in the repo layout');
    assert.equal(typeof bridgeMod.KhyBridge, 'function');
  });

  test('attaches COM2 and answers the decision plane (rule brain, no gateway)', async () => {
    const peer = await startPeer();
    const closed = await closedPortUrl();
    // Point the brain at a dead endpoint so the fallback is what answers, whatever
    // the ambient state of the real gateway may be.
    process.env.KHY_GATEWAY_URL = closed;
    process.env.KHY_BRAIN_TIMEOUT_MS = '200';

    const channel = channelMod.createKhyosAgentChannel({ runner: makeRunner(peer.port) });
    try {
      assert.equal(await channel.start(), true, 'start() must attach');
      assert.equal(channel.attached, true);

      const decision = await peer.ask('may I list the ramfs root?', INTENT_GENERIC);
      assert.match(decision.text, /^(ALLOW|DENY)$/, 'the decision plane must get a verdict');
      assert.equal(decision.text, defaultBrain('may I list the ramfs root?', INTENT_GENERIC));

      const action = await peer.ask('say hello from the kernel', INTENT_NL);
      assert.match(
        action.text,
        /^(SET|GET|SAY)\b/,
        'the natural-language plane must get exactly one action line',
      );
    } finally {
      channel.stop();
      peer.close();
    }
  });

  test('reads /disk/etc/agent.conf and routes the model from it', async () => {
    const peer = await startPeer({ configText: '# agent config\nmodel=stub/model\nendpoint=\n' });
    const seenConfig = [];
    const realFactory = bridgeMod.makeGatewayBrain;
    // Stub the brain factory: it is what the channel caches off the bridge module,
    // so this observes the exact (question, code, config) tuple the kernel's
    // question arrives with — no ambient gateway involved.
    bridgeMod.makeGatewayBrain = (opts) => {
      seenConfig.push({ opts });
      return async (question, code, config) => {
        seenConfig[seenConfig.length - 1].config = config;
        seenConfig[seenConfig.length - 1].question = question;
        seenConfig[seenConfig.length - 1].code = code;
        return `SAY ${config.model || 'unset'}`;
      };
    };

    const channel = channelMod.createKhyosAgentChannel({ runner: makeRunner(peer.port) });
    try {
      assert.equal(await channel.start(), true);
      await waitFor(() => channel.describe().model === 'stub/model', 3000, 'agent.conf to be read back');
      assert.ok(peer.state.reads >= 1, 'the config must come from the control plane');

      const reply = await peer.ask('which model are you?', INTENT_NL);
      assert.equal(reply.text, 'SAY stub/model', 'the in-system model must reach the brain');
      assert.equal(seenConfig[0].config.model, 'stub/model');
      assert.equal(seenConfig[0].code, INTENT_NL);
      assert.ok(seenConfig[0].opts, 'the factory must be called with brain options');
    } finally {
      channel.stop();
      peer.close();
      bridgeMod.makeGatewayBrain = realFactory;
    }
  });

  test('a control-plane error still leaves the decision plane answerable', async () => {
    const peer = await startPeer({ readStatus: protocol.STATUS.ENOENT });
    const channel = channelMod.createKhyosAgentChannel({ runner: makeRunner(peer.port) });
    try {
      assert.equal(await channel.start(), true);
      const decision = await peer.ask('reboot now?', INTENT_GENERIC);
      assert.match(decision.text, /^(ALLOW|DENY)$/);
    } finally {
      channel.stop();
      peer.close();
    }
  });

  test('no COM2 on the runner → fail-soft, no throw', async () => {
    const channel = channelMod.createKhyosAgentChannel({
      runner: makeRunner(0, { agentChannel: false }),
    });
    assert.equal(await channel.start(), false);
    assert.equal(channel.attached, false);
    assert.equal(channel.describe().attached, false);
    channel.stop();
    channel.stop(); // idempotent
  });

  test('the gate KHY_KHYOS_AGENT_CHANNEL=0 keeps it off', async () => {
    process.env.KHY_KHYOS_AGENT_CHANNEL = '0';
    assert.equal(channelMod._khyosAgentChannelEnabled(), false);
    const peer = await startPeer();
    const channel = channelMod.createKhyosAgentChannel({ runner: makeRunner(peer.port) });
    try {
      assert.equal(await channel.start(), false);
      assert.equal(channel.attached, false);
    } finally {
      peer.close();
    }
  });

  test('stop() detaches and the peer stops receiving replies', async () => {
    const peer = await startPeer();
    const channel = channelMod.createKhyosAgentChannel({ runner: makeRunner(peer.port) });
    assert.equal(await channel.start(), true);
    channel.stop();
    assert.equal(channel.attached, false);
    const seq = (peer.state.seq = (peer.state.seq + 1) >>> 0);
    send(peer.state.sockets[0], frame.TYPE.DECISION_REQ, seq, INTENT_GENERIC, Buffer.from('anyone?'));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(peer.state.replies.length, 0, 'a stopped channel must not answer');
    peer.close();
  });
});

describe('gateway brain (the real-model half of the channel)', () => {
  test('answers from the model and carries the bearer token', async () => {
    const gw = await startGateway('SAY answered by the model');
    process.env.PROXY_AUTH_TOKEN = 'khy-test-token';
    try {
      const brain = makeGatewayBrain({ url: gw.url, model: 'fallback/model', timeoutMs: 1500 });
      const out = await brain('say something', INTENT_NL, {});
      assert.equal(out, 'SAY answered by the model');
      assert.equal(gw.seen.authorization, 'Bearer khy-test-token');
      assert.equal(gw.seen.model, 'fallback/model', 'the configured model must be requested');
      assert.match(gw.seen.system, /SET|GET|SAY/, 'the NL plane prompt states the action grammar');
    } finally {
      gw.close();
    }
  });

  test('the kernel-persisted model wins over the fallback', async () => {
    const gw = await startGateway('SAY ok');
    try {
      const brain = makeGatewayBrain({ url: gw.url, model: 'fallback/model', timeoutMs: 1500 });
      await brain('hi', INTENT_GENERIC, { model: 'kernel-configured/model' });
      assert.equal(gw.seen.model, 'kernel-configured/model');
      assert.match(gw.seen.system, /ALLOW|DENY/, 'the decision plane prompt demands a verdict');
    } finally {
      gw.close();
    }
  });

  test('an unreachable gateway degrades to the rule brain instead of blocking', async () => {
    const closed = await closedPortUrl();
    const brain = makeGatewayBrain({ url: closed, timeoutMs: 300 });
    const question = 'delete every file in /disk now';
    const out = await brain(question, INTENT_GENERIC, {});
    assert.equal(out, defaultBrain(question, INTENT_GENERIC), 'must fall back to the rule brain');
    assert.match(out, /^(ALLOW|DENY)$/);
  });

  test('prose from the model is coerced into the action grammar', async () => {
    const gw = await startGateway('Sure! I would be glad to help you with that.');
    try {
      const brain = makeGatewayBrain({ url: gw.url, timeoutMs: 1500 });
      const out = await brain('hello', INTENT_NL, {});
      assert.match(out, /^SAY /, 'unrecognized prose becomes something to say');
    } finally {
      gw.close();
    }
  });
});