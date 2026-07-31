#!/usr/bin/env node
/* agentbus_brain_resolve_test.js — host-only checks of where the gateway brain
 * looks for its gateway and its bearer token. No QEMU and no kernel: this is the
 * half of the agent channel that a portable install got wrong.
 *
 * The failure pinned here: a portable install keeps its data home at
 * <install root>/.khy, and the gateway writes proxy_server_auth.json there —
 * while the brain originally read only ~/.khy/proxy_server_auth.json. The model
 * call therefore came back 401 and the brain silently fell back to its rule set,
 * which looks exactly like "the kernel's `ai` does nothing intelligent" while
 * every other test still passes.
 *
 * Usage:  node kernel/tools/agentbus_brain_resolve_test.js
 * Exit:   0 = all checks pass, non-zero = failure.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeGatewayBrain, DEFAULT_MODEL } = require('../bridge/khy-brain-gateway');

const INTENT_GENERIC = 0x0000; // parity with AGENT_INTENT_GENERIC (agentask.h)
const INTENT_NL = 0x0001; // parity with AGENT_INTENT_NL

let passes = 0;
let fails = 0;
let skips = 0;
function check(ok, msg) {
  if (ok) {
    passes++;
    console.log(`[PASS] ${msg}`);
  } else {
    fails++;
    console.log(`[FAIL] ${msg}`);
  }
}
function skip(msg) {
  skips++;
  console.log(`[SKIP] ${msg}`);
}

/* A stand-in gateway: records the bearer token and the requested model, then
 * answers in the exact grammar the asked-about plane expects (one word for a
 * generic decision, one action line for a natural-language command). */
function startStubGateway() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (_e) {
        /* leave {} */
      }
      const system = String(((body.messages || [])[0] || {}).content || '');
      const nl = /SET <key> <value>/.test(system);
      seen.push({ authorization: req.headers.authorization || '', model: body.model || '' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: nl ? 'SET model from-stub' : 'ALLOW' } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

/* Port that nothing is listening on: bind, note, close. Avoids pinning a literal
 * port that might happen to be occupied on some other machine. */
function closedPort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/* The brain reads its configuration when it is BUILT (opts → env → files), so
 * each case builds a fresh brain under a scrubbed environment and only then
 * calls it. `fn` must return the brain. */
const ENV_KEYS = [
  'KHY_DATA_HOME',
  'KHY_PROJECT_DATA_HOME',
  'KHY_GATEWAY_URL',
  'KHY_BRAIN_MODEL',
  'PROXY_AUTH_TOKEN',
  'PROXY_HOST',
  'PROXY_PORT',
];
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v !== undefined && v !== null) process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function tempDataHome(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `khy-brain-${name}-`));
  return dir;
}
function writeAuth(dir, token) {
  fs.writeFileSync(path.join(dir, 'proxy_server_auth.json'), JSON.stringify({ authToken: token }));
}

async function main() {
  const stub = await startStubGateway();
  const temps = [];

  try {
    // ── 1. KHY_DATA_HOME token reaches the gateway ──────────────────────────
    const homeA = tempDataHome('a');
    temps.push(homeA);
    writeAuth(homeA, 'khy-token-from-data-home');
    const brainA = withEnv({ KHY_DATA_HOME: homeA, KHY_GATEWAY_URL: `http://127.0.0.1:${stub.port}/v1/chat/completions` }, () =>
      makeGatewayBrain()
    );
    const answerA = await brainA('may I proceed?', INTENT_GENERIC, {});
    const seenA = stub.seen[stub.seen.length - 1] || {};
    check(answerA === 'ALLOW', `gateway brain answers the generic plane (got '${answerA}')`);
    check(
      seenA.authorization === 'Bearer khy-token-from-data-home',
      `KHY_DATA_HOME token is the bearer (got '${seenA.authorization}')`
    );
    check(seenA.model === DEFAULT_MODEL, `no in-system model → brain default '${DEFAULT_MODEL}' (got '${seenA.model}')`);

    // ── 2. The repo-scoped data home (portable install) ────────────────────
    const repoTokenFile = path.resolve(__dirname, '..', '..', '.khy', 'proxy_server_auth.json');
    let repoToken = null;
    try {
      const j = JSON.parse(fs.readFileSync(repoTokenFile, 'utf8'));
      repoToken = j && j.authToken ? j.authToken : null;
    } catch (_e) {
      repoToken = null;
    }
    if (!repoToken) {
      skip(`no portable story to assert: ${repoTokenFile} does not exist`);
    } else {
      const before = stub.seen.length;
      const brainB = withEnv({ KHY_GATEWAY_URL: `http://127.0.0.1:${stub.port}/v1/chat/completions` }, () => makeGatewayBrain());
      await brainB('may I proceed?', INTENT_GENERIC, {});
      const seenB = stub.seen.slice(before)[0] || {};
      check(
        seenB.authorization === `Bearer ${repoToken}`,
        `portable install: token comes from <repo>/.khy (not ~/.khy) — got '${String(seenB.authorization).slice(0, 14)}…'`
      );
    }

    // ── 3. In-system model choice routes the brain; port from runtime file ──
    const homeC = tempDataHome('c');
    temps.push(homeC);
    writeAuth(homeC, 'khy-token-from-runtime-home');
    fs.writeFileSync(
      path.join(homeC, 'proxy_server_runtime.json'),
      JSON.stringify({ host: '127.0.0.1', httpPort: stub.port, httpsEnabled: false })
    );
    const before3 = stub.seen.length;
    // No KHY_GATEWAY_URL and no PROXY_PORT: the port must come from the runtime
    // file, i.e. the port the gateway actually bound (it retries upward when the
    // default is taken, so guessing 9100 would reach nothing).
    const brainC = withEnv({ KHY_DATA_HOME: homeC }, () => makeGatewayBrain());
    const answerC = await brainC('use model kernel-chosen', INTENT_NL, { model: 'kernel-chosen' });
    const seenC = stub.seen.slice(before3)[0] || {};
    check(!!seenC.model, 'runtime-file port reached the gateway (a request arrived)');
    check(seenC.model === 'kernel-chosen', `in-system model routes the brain (got '${seenC.model}')`);
    check(
      String(seenC.authorization) === 'Bearer khy-token-from-runtime-home',
      `runtime-home token is the bearer (got '${seenC.authorization}')`
    );
    check(answerC === 'SET model from-stub', `NL intent keeps the model's action line (got '${answerC}')`);

    // ── 4. Loose coupling: a dead gateway still yields an answer ───────────
    const dead = await closedPort();
    const brainD = withEnv({ KHY_GATEWAY_URL: `http://127.0.0.1:${dead}/v1/chat/completions` }, () => makeGatewayBrain());
    const t0 = Date.now();
    const answerD = await brainD('use model claude-opus', INTENT_NL, {});
    const elapsed = Date.now() - t0;
    check(/^(SET|GET|SAY)\b/.test(String(answerD)), `dead gateway → rule brain still answers: '${answerD}'`);
    check(elapsed < 4000, `dead gateway degrades promptly (${elapsed}ms)`);
    const answerE = await brainD('please delete the entire disk', INTENT_GENERIC, {});
    check(answerE === 'DENY', `dead gateway still denies a destructive request (got '${answerE}')`);

    console.log(`\n${passes} passed, ${fails} failed, ${skips} skipped`);
    return fails === 0 ? 0 : 1;
  } finally {
    for (const dir of temps) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_e) {
        /* best-effort cleanup */
      }
    }
    stub.server.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[FAIL] uncaught:', err);
    process.exit(1);
  });