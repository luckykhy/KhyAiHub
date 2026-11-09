'use strict';

/**
 * server.test.js — loopback HTTP behavior: auth, status codes, request ids,
 * body/response caps, rate limiting, audit records, and the 202 job flow.
 *
 * Every server listens on port 0 (ephemeral) and uses a temp state directory.
 * khy.ask is exercised with a fake khy.js only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const C = require('../lib/contracts');
const { createServer } = require('../lib/server');
const { createAudit } = require('../lib/audit');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoon-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function start(t, options = {}) {
  const root = tempDir(t);
  const state = path.join(root, 'state');
  const app = createServer({
    stateDir: state,
    port: 0,
    writeRoots: [root],
    readRoots: [root],
    ...options,
  });
  const token = app.auth.ensure().token;
  const { port } = await app.listen();
  t.after(() => app.close());
  return { root, state, app, token, port, base: `http://127.0.0.1:${port}` };
}

function headersFor(token, extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function post(base, body, token, extra = {}) {
  return postTo(base, '/call', body, token, extra);
}

async function postTo(base, pathName, body, token, extra = {}) {
  const res = await fetch(`${base}${pathName}`, {
    method: 'POST',
    headers: headersFor(token, extra),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

async function get(base, pathName, token, extra = {}) {
  const res = await fetch(`${base}${pathName}`, { headers: headersFor(token, extra) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/**
 * Poll task.get until the job reaches a terminal state (or the deadline).
 * Used instead of a fixed sleep so a loaded machine cannot make the fake CLI
 * appear still-running.
 */
async function waitForJob(base, token, id, timeoutMs = 5000) {
  const terminal = new Set(['done', 'failed', 'cancelled']);
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await post(base, { tool: 'task.get', args: { id } }, token);
    if (last.status === 200 && last.json && last.json.data && terminal.has(last.json.data.state)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

function rawRequest(port, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: options.method || 'GET', path: options.path || '/', headers: options.headers || {} },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end(options.body === undefined ? undefined : options.body);
  });
}

/**
 * Use node:http instead of the global fetch for these loopback assertions.
 *
 * Under a parallel `node --test` run on Windows, undici's lazy dispatcher was
 * observed to stall before opening a socket (the server was listening, with
 * zero outbound connections, and the test never progressed). The tests only
 * need status/headers/text/json, so a tiny adapter keeps them deterministic.
 */
function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined && headers['Content-Length'] === undefined && headers['content-length'] === undefined) {
      headers['Content-Length'] = Buffer.byteLength(String(options.body));
    }
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method || 'GET',
        headers,
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode,
            headers: { get: (name) => res.headers[String(name).toLowerCase()] || null },
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('loopback request timeout')));
    req.on('error', reject);
    req.end(options.body === undefined ? undefined : options.body);
  });
}

function writeFakeKhy(root, delayMs = 0) {
  const file = path.join(root, 'fake-khy.js');
  fs.writeFileSync(
    file,
    [
      "'use strict';",
      'const args = process.argv.slice(2);',
      "const i = args.indexOf('-p');",
      "const q = i >= 0 ? args[i + 1] : '';",
      `setTimeout(() => { console.log(JSON.stringify({ result: 'fake answer: ' + q })); }, ${delayMs});`,
    ].join('\n'),
    'utf8'
  );
  return file;
}

test('GET /health is unauthenticated and minimal', async (t) => {
  const { base } = await start(t);
  const res = await get(base, '/health', null);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
  assert.ok(res.headers.get('x-request-id'));

  const wrongMethod = await fetch(`${base}/health`, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
});

test('GET /status requires a valid bearer token', async (t) => {
  const { base, token } = await start(t);

  const missing = await get(base, '/status', null);
  assert.equal(missing.status, 401);
  assert.equal(missing.json.error.code, 'unauthorized');

  const wrong = await get(base, '/status', 'not-the-token');
  assert.equal(wrong.status, 401);

  const ok = await get(base, '/status', token);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.data.tools.length, 24);
  assert.equal(ok.json.data.security.loopback_only, true);
  assert.equal(ok.json.data.auth.present, true);
  assert.ok(ok.json.data.rate_limit.limit >= 1);
  assert.ok(!ok.text.includes(token), 'status must never echo the token');
});

test('POST /call ping round-trips and echoes a caller-supplied request id', async (t) => {
  const { base, token } = await start(t);
  const res = await post(base, { tool: 'ping' }, token, { 'X-Request-Id': 'req-abcdefgh' });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.tool, 'ping');
  assert.equal(res.json.id, 'req-abcdefgh');
  assert.equal(res.headers.get('x-request-id'), 'req-abcdefgh');
  assert.equal(res.json.data.pong, true);
  assert.equal(typeof res.json.duration_ms, 'number');
});

test('body.id is accepted when valid and becomes the request id', async (t) => {
  const { base, token } = await start(t);
  const ok = await post(base, { tool: 'ping', id: 'client-request-01' }, token);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.id, 'client-request-01');
  assert.equal(ok.headers.get('x-request-id'), 'client-request-01');

  const bad = await post(base, { tool: 'ping', id: 'x' }, token);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'invalid_args');
});

test('malformed requests map to 400/404/405 with stable codes', async (t) => {
  const { base, token } = await start(t);

  const invalidJson = await post(base, '{', token);
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.json.error.code, 'invalid_request');

  const arrayBody = await post(base, '[]', token);
  assert.equal(arrayBody.status, 400);

  const noTool = await post(base, { args: {} }, token);
  assert.equal(noTool.status, 400);
  assert.equal(noTool.json.error.code, 'invalid_request');

  const badArgs = await post(base, { tool: 'ping', args: [] }, token);
  assert.equal(badArgs.status, 400);
  assert.equal(badArgs.json.error.code, 'invalid_args');

  const unknownTool = await post(base, { tool: 'nope' }, token);
  assert.equal(unknownTool.status, 404);
  assert.equal(unknownTool.json.error.code, 'not_found');

  const wrongMethod = await get(base, '/call', token);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');

  const unknownPath = await get(base, '/nope', token);
  assert.equal(unknownPath.status, 404);
  assert.equal(unknownPath.json.error.code, 'not_found');

  const wrongType = await post(base, { tool: 'ping' }, token, { 'Content-Type': 'text/plain' });
  assert.equal(wrongType.status, 400);
  assert.equal(wrongType.json.error.code, 'invalid_request');
});

test('a missing token file fails closed with 503', async (t) => {
  const root = tempDir(t);
  const app = createServer({
    stateDir: path.join(root, 'fresh-state'),
    port: 0,
    writeRoots: [root],
    readRoots: [root],
  });
  const { port } = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${port}`;

  const health = await get(base, '/health', null);
  assert.equal(health.status, 200);

  const call = await post(base, { tool: 'ping' }, 'any-token-value');
  assert.equal(call.status, 503);
  assert.equal(call.json.error.code, 'auth_unavailable');

  const status = await get(base, '/status', 'any-token-value');
  assert.equal(status.status, 503);
  assert.equal(status.json.error.code, 'auth_unavailable');
});

test('browser Origin and mismatched Host are rejected', async (t) => {
  const { base, token, port } = await start(t);

  const origin = await post(base, { tool: 'ping' }, token, { Origin: 'http://evil.example' });
  assert.equal(origin.status, 403);
  assert.equal(origin.json.error.code, 'forbidden_scope');

  const host = await rawRequest(port, {
    method: 'GET',
    path: '/status',
    headers: { Host: 'evil.example', Authorization: `Bearer ${token}` },
  });
  assert.equal(host.status, 403);
  assert.equal(JSON.parse(host.body).error.code, 'forbidden_scope');

  const goodHost = await rawRequest(port, {
    method: 'GET',
    path: '/status',
    headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` },
  });
  assert.equal(goodHost.status, 200);
});

test('request bodies over the configured cap return 413', async (t) => {
  const { base, token, port } = await start(t, { bodyLimit: 1024 });
  const body = JSON.stringify({ tool: 'ping', args: { blob: 'x'.repeat(4096) } });
  let result;
  try {
    result = await post(base, body, token);
  } catch {
    // A client may observe the server closing the connection after responding;
    // retry with a raw request to read the written 413.
    const raw = await rawRequest(port, {
      method: 'POST',
      path: '/call',
      headers: {
        Host: `127.0.0.1:${port}`,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      },
      body,
    });
    result = { status: raw.status, json: JSON.parse(raw.body) };
  }
  assert.equal(result.status, 413);
  assert.equal(result.json.error.code, 'payload_too_large');
});

test('rate limiting returns 429 with Retry-After', async (t) => {
  const { base, token } = await start(t, { rateLimitPerMinute: 2 });
  const first = await post(base, { tool: 'ping' }, token);
  const second = await post(base, { tool: 'ping' }, token);
  const third = await post(base, { tool: 'ping' }, token);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 429);
  assert.equal(third.json.error.code, 'rate_limited');
  assert.ok(Number(third.headers.get('retry-after')) >= 1);
});

test('audit JSONL records every call with a digest, not the raw args', async (t) => {
  const { base, token, state, app } = await start(t);

  await post(base, { tool: 'ping' }, token, { 'X-Request-Id': 'audit-request-01' });
  await post(base, { tool: 'ping', args: { secret: 'super-secret-value' } }, token);
  await post(base, { tool: 'nope' }, token);
  await get(base, '/call', token); // 405, not audited as a tool call

  const auditDir = path.join(state, 'audit');
  const files = fs.readdirSync(auditDir).filter((name) => name.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  const text = fs.readFileSync(path.join(auditDir, files[0]), 'utf8');
  assert.ok(!text.includes('super-secret-value'), 'raw args must not reach the audit log');

  const records = text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(records.length >= 3);

  for (const record of records) {
    assert.equal(typeof record.ts, 'string');
    assert.equal(record.source, 'http');
    assert.equal(typeof record.args_sha256, 'string');
    assert.equal(record.args_sha256.length, 64);
    assert.equal(typeof record.args_bytes, 'number');
    assert.ok(Array.isArray(record.args_keys));
    assert.equal(typeof record.duration_ms, 'number');
    assert.equal(typeof record.status, 'number');
    assert.equal(typeof record.seq, 'number');
    assert.equal(record.prev.length, 64);
  }

  const pingRecord = records.find((record) => record.tool === 'ping' && record.ok === true);
  assert.ok(pingRecord);
  assert.equal(pingRecord.request_id, 'audit-request-01');
  assert.equal(pingRecord.error_code, null);

  const badArgsRecord = records.find((record) => record.error_code === 'invalid_args');
  assert.ok(badArgsRecord);
  assert.deepEqual(badArgsRecord.args_keys, ['secret']);

  const notFoundRecord = records.find((record) => record.error_code === 'not_found');
  assert.ok(notFoundRecord);

  const verification = app.audit.verify();
  assert.equal(verification.ok, true);
  assert.ok(verification.files.length >= 1);
});

test('audit records the real caller principal, not a hardcoded operator', async (t) => {
  const { base, state, app, token } = await start(t);
  const phone = app.tokenStore.issue({ scope: 'phone', name: 'audit-phone' });

  await post(base, { tool: 'ping' }, phone.token, { 'X-Request-Id': 'principal-phone-01' });
  await post(base, { tool: 'ping' }, token, { 'X-Request-Id': 'principal-op-01' });

  const auditDir = path.join(state, 'audit');
  const files = fs.readdirSync(auditDir).filter((name) => name.endsWith('.jsonl'));
  const records = fs
    .readFileSync(path.join(auditDir, files[0]), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const phoneRecord = records.find((record) => record.request_id === 'principal-phone-01');
  const operatorRecord = records.find((record) => record.request_id === 'principal-op-01');
  assert.ok(phoneRecord && operatorRecord);
  assert.match(phoneRecord.principal, /^phone:/);
  assert.match(operatorRecord.principal, /^operator/);
  assert.notEqual(phoneRecord.principal, operatorRecord.principal);
});

test('body.id replays a stored response and rejects a different args digest', async (t) => {
  const { base, token, root } = await start(t);
  const file = path.join(root, 'idem.txt');
  fs.writeFileSync(file, 'hello idempotency');
  const args = { path: file, limit: 10 };

  const first = await post(base, { tool: 'read', args, id: 'idem00001' }, token);
  assert.equal(first.status, 200);
  assert.equal(first.json.replayed, undefined);

  const second = await post(base, { tool: 'read', args, id: 'idem00001' }, token);
  assert.equal(second.status, 200);
  assert.equal(second.json.replayed, true);
  assert.equal(second.headers.get('x-idempotent-replay'), '1');

  const conflict = await post(
    base,
    { tool: 'read', args: { path: file, limit: 11 }, id: 'idem00001' },
    token
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, 'id_conflict');
});

test('audit rotates at the byte cap and every physical file verifies', (t) => {
  const dir = tempDir(t);
  const noon = Date.parse('2026-06-15T12:00:00.000Z');
  let now = noon;
  const audit = createAudit({ dir, maxBytes: 700, clock: () => now });

  for (let i = 0; i < 30; i += 1) {
    audit.write({ tool: 'ping', ok: true, index: i, padding: 'x'.repeat(20) });
    now += 1000;
  }

  const files = fs.readdirSync(dir).filter((name) => name.includes('.jsonl'));
  assert.ok(files.length > 1, 'rotation must produce more than one file');
  const verification = audit.verify('2026-06-15');
  assert.equal(verification.ok, true);
  assert.equal(verification.files.length, files.length);
  for (const file of verification.files) assert.equal(file.ok, true);

  const tail = audit.tail(5);
  assert.equal(tail.length, 5);
  assert.equal(tail[4].index, 29);
  assert.equal(typeof tail[4].seq, 'number');
  assert.equal(tail[4].prev.length, 64);
});

test('auth failures are audited too', async (t) => {
  const { base, state } = await start(t);
  await post(base, { tool: 'ping' }, null);

  const auditDir = path.join(state, 'audit');
  const files = fs.readdirSync(auditDir).filter((name) => name.endsWith('.jsonl'));
  const records = fs
    .readFileSync(path.join(auditDir, files[0]), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(records.some((record) => record.error_code === 'unauthorized' && record.tool === null));
});

test('khy.ask returns 202 and wait_ms can wait for the job result', async (t) => {
  const root = tempDir(t);
  const fake = writeFakeKhy(root, 50);
  const app = createServer({
    stateDir: path.join(root, 'state'),
    port: 0,
    writeRoots: [root],
    readRoots: [root],
    khyJs: fake,
  });
  const token = app.auth.ensure().token;
  const { port } = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${port}`;

  const immediate = await post(base, { tool: 'khy.ask', args: { question: 'hi' } }, token);
  assert.equal(immediate.status, 202);
  assert.equal(immediate.json.pending, true);
  assert.equal(immediate.json.ok, true);
  assert.match(immediate.json.job_id, /^job-/);

  // Poll the job through the task.get tool. A fixed sleep is flaky under a
  // loaded parallel test run: the fake CLI is a real child process.
  const got = await waitForJob(base, token, immediate.json.job_id, 5000);
  assert.equal(got.status, 200);
  assert.equal(got.json.data.state, 'done');
  assert.match(got.json.data.result.answer, /fake answer: hi/);

  const waited = await post(
    base,
    { tool: 'khy.ask', args: { question: 'wait' }, wait_ms: 5000 },
    token
  );
  assert.equal(waited.status, 200);
  assert.equal(waited.json.ok, true);
  assert.match(waited.json.data.answer, /fake answer: wait/);

  const badWait = await post(base, { tool: 'ping', wait_ms: 999999 }, token);
  assert.equal(badWait.status, 400);
  assert.equal(badWait.json.error.code, 'invalid_args');
});

test('read-only mode rejects mutating tools but keeps inspection tools', async (t) => {
  const root = tempDir(t);
  const app = createServer({
    stateDir: path.join(root, 'state'),
    port: 0,
    writeRoots: [root],
    readRoots: [root],
    readOnly: true,
  });
  const token = app.auth.ensure().token;
  const { port } = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${port}`;

  const ping = await post(base, { tool: 'ping' }, token);
  assert.equal(ping.status, 200);

  const write = await post(base, { tool: 'write', args: { path: path.join(root, 'x.txt'), content: 'x' } }, token);
  assert.equal(write.status, 403);
  assert.equal(write.json.error.code, 'forbidden_scope');
});

test('unexpected handler errors return 500 without leaking the message', async (t) => {
  const root = tempDir(t);
  const fakeTools = {
    get: () => ({ responseMaxBytes: 1024 * 1024, timeoutMs: 5000 }),
    call: async () => {
      throw new Error('boom-secret-detail');
    },
    status: () => ({}),
    close: async () => {},
  };
  const app = createServer({
    stateDir: path.join(root, 'state'),
    port: 0,
    tools: fakeTools,
  });
  const token = app.auth.ensure().token;
  const { port } = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${port}`;

  const res = await post(base, { tool: 'ping' }, token);
  assert.equal(res.status, 500);
  assert.equal(res.json.error.code, 'internal_error');
  assert.equal(res.json.error.message, '内部错误');
  assert.ok(!res.text.includes('boom-secret-detail'));
});

test('responses over the tool cap return 413', async (t) => {
  const root = tempDir(t);
  const fakeTools = {
    get: () => ({ responseMaxBytes: 64, timeoutMs: 5000 }),
    call: async () => ({ ok: true, data: { big: 'x'.repeat(1024) } }),
    status: () => ({}),
    close: async () => {},
  };
  const app = createServer({
    stateDir: path.join(root, 'state'),
    port: 0,
    tools: fakeTools,
  });
  const token = app.auth.ensure().token;
  const { port } = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${port}`;

  const res = await post(base, { tool: 'ping' }, token);
  assert.equal(res.status, 413);
  assert.equal(res.json.error.code, 'payload_too_large');
});

test('the listener refuses a non-loopback host', async (t) => {
  const root = tempDir(t);
  const app = createServer({ stateDir: path.join(root, 'state'), port: 0 });
  await assert.rejects(app.listen({ host: '0.0.0.0' }), (err) => err.code === 'invalid_config');
  await app.close();
});

test('GET /v1/tools filters by scope (12 operator, 4 phone)', async (t) => {
  const descriptors = (scope) =>
    C.TOOLS.filter(
      (tool) => !scope || scope === 'operator' || (Array.isArray(tool.scopes) && tool.scopes.includes(scope))
    );
  const tools = {
    get: (name) => C.getTool(name),
    list: descriptors,
    call: async (name) => ({ ok: true, data: { tool: name } }),
    status: (scope) => ({ tools: descriptors(scope).map((tool) => tool.name), tool_count: descriptors(scope).length }),
    waitForJob: async (id) => ({ id, state: 'done', result: {} }),
    close: async () => {},
  };
  const { base, token, app } = await start(t, { tools });
  const operator = await get(base, '/v1/tools', token);
  assert.equal(operator.status, 200);
  assert.equal(operator.json.data.tools.length, 12);
  const names = operator.json.data.tools.map((tool) => tool.name);
  assert.ok(names.includes('phone_exec'));
  assert.ok(!names.includes('exec'), 'PC local tools must not be exposed');

  const phone = app.tokenStore.issuePhone();
  const phoneTools = await get(base, '/v1/tools', phone.token);
  assert.equal(phoneTools.status, 200);
  assert.deepEqual(
    phoneTools.json.data.tools.map((tool) => tool.name).sort(),
    ['bridge_status', 'khy_ask', 'mailbox_status', 'ping']
  );
});

test('GET /v1/audit/tail is operator-only and returns records', async (t) => {
  const { base, token, app } = await start(t);
  await post(base, { tool: 'ping' }, token);
  const tail = await get(base, '/v1/audit/tail?n=5', token);
  assert.equal(tail.status, 200);
  assert.ok(Array.isArray(tail.json.data.records));
  assert.ok(tail.json.data.records.length >= 1);

  const phone = app.tokenStore.issuePhone();
  const denied = await get(base, '/v1/audit/tail', phone.token);
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, 'forbidden_scope');
});

test('POST /v1/rotate is two-phase: old phone token survives until commit', async (t) => {
  const { base, token, app } = await start(t);
  const oldPhone = app.tokenStore.issuePhone();
  assert.equal((await post(base, { tool: 'ping' }, oldPhone.token)).status, 200);

  const rotated = await postTo(base, '/v1/rotate', {}, token);
  assert.equal(rotated.status, 200);
  assert.match(rotated.json.data.token, /^khy_/);
  assert.ok(rotated.json.data.record_id);

  // Push has not happened yet: the old phone token must still work.
  assert.equal((await post(base, { tool: 'ping' }, oldPhone.token)).status, 200);
  assert.equal((await post(base, { tool: 'ping' }, rotated.json.data.token)).status, 200);

  const committed = await postTo(base, '/v1/rotate/commit', { record_id: rotated.json.data.record_id }, token);
  assert.equal(committed.status, 200);
  assert.equal((await post(base, { tool: 'ping' }, oldPhone.token)).status, 401);
  assert.equal((await post(base, { tool: 'ping' }, rotated.json.data.token)).status, 200);

  // Phone tokens cannot rotate or commit.
  const phoneRotate = await postTo(base, '/v1/rotate', {}, rotated.json.data.token);
  assert.equal(phoneRotate.status, 403);
});

test('GET /v1/jobs/:id validates ids and returns 202/200 for a real job', async (t) => {
  const { base, token } = await start(t);
  const bad = await get(base, '/v1/jobs/x', token);
  assert.equal(bad.status, 400);

  const missing = await get(base, '/v1/jobs/job-00000000', token);
  assert.equal(missing.status, 404);

  const submitted = await post(base, { tool: 'task.submit', args: { tool: 'ping', args: {} } }, token);
  assert.equal(submitted.status, 202);
  assert.match(submitted.json.job_id, /^job-/);
  const first = await get(base, `/v1/jobs/${submitted.json.job_id}`, token);
  assert.ok(first.status === 202 || first.status === 200);
});
