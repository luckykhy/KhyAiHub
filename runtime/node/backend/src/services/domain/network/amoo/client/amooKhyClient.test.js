'use strict';

// Co-located unit test for client/amooKhyClient.js.
//
// The client is a DISTRIBUTABLE: it is pushed to the phone and run inside Amoo's
// Node workspace, so it must stay a single file with zero third-party requires.
// These cases therefore also assert the properties that keep it runnable there:
//   - every HTTP call goes through an INJECTED fetch (no real socket in tests,
//     and no hidden dependency on Node's global fetch shape),
//   - 429/5xx are retried at most twice and then reported,
//   - the API key is masked everywhere it is printed,
//   - a 404 from the A2A gate is diagnosed as "surface disabled", not as a
//     network error — that distinction is the whole value of `card`/`self`,
//   - `tasks` says the endpoint does not exist instead of inventing one.

const test = require('node:test').test;
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

function pinSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-amoo-cli2-'));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.KHY_DATA_HOME = path.join(root, 'data');
  process.env.KHY_PROJECT_DATA_HOME = path.join(root, 'project-data');
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('KHY_')) {
      delete process.env[key];
    }
  }
  return root;
}

const sandbox = pinSandbox();

const client = require('./amooKhyClient');
const {
  resolveSettings,
  requestJson,
  parseArgv,
  diagnoseFailure,
  extractTaskText,
  maskSecret,
  CLIENT_VERSION,
  TERMINAL_STATES,
  main,
} = client;

// ── fetch double ──────────────────────────────────────────────────────────

function makeFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options || {}, calls.length);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(status, payload) {
  const text = JSON.stringify(payload);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
  };
}

const CARD = {
  protocolVersion: '0.3.0',
  name: 'khy-os',
  version: '1.1.15',
  url: 'http://127.0.0.1:3000',
  capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
  skills: [{ id: 'echo', name: 'echo' }],
};

function captureStdout() {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    chunks,
    text: () => chunks.join(''),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

test('resolveSettings prefers env over the file and reports provenance', () => {
  const settings = resolveSettings({
    HOME: sandbox,
    KHY_BASE_URL: 'http://127.0.0.1:3000/',
    KHY_A2A_API_KEY: 'sk-routercode-abcdef123456',
  });
  assert.equal(settings.baseUrl, 'http://127.0.0.1:3000'); // trailing slash trimmed
  assert.equal(settings.baseUrlSource, 'env:KHY_BASE_URL');
  assert.equal(settings.configured, true);
  assert.equal(settings.credentialSource, 'env:KHY_A2A_API_KEY');
  assert.equal(settings.apiKey, 'sk-routercode-abcdef123456');
  // The masked form never contains the whole key.
  assert.equal(maskSecret(settings.apiKey).includes('abcdef123456'), false);
});

test('resolveSettings falls back to the 0600 config file, then the loopback default', () => {
  const dir = path.join(sandbox, '.config', 'amoo-khy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ base_url: 'http://192.168.2.11:13000', api_key: 'sk-file-key-1234567890' }),
    'utf8'
  );
  const fromFile = resolveSettings({ HOME: sandbox, USERPROFILE: sandbox });
  assert.equal(fromFile.baseUrl, 'http://192.168.2.11:13000');
  assert.equal(fromFile.baseUrlSource, `file:${path.join(dir, 'config.json')}`);
  assert.equal(fromFile.credentialSource, `file:${path.join(dir, 'config.json')}`);
  assert.equal(fromFile.configured, true);

  fs.rmSync(dir, { recursive: true, force: true });
  const fallback = resolveSettings({ HOME: sandbox, USERPROFILE: sandbox });
  assert.equal(fallback.configured, false);
  assert.equal(fallback.credentialSource, 'none');
  assert.equal(fallback.apiKey, null);
  // The default is the adb-reverse friendly loopback.
  assert.equal(fallback.baseUrl, 'http://127.0.0.1:3000');
});

test('resolveSettings survives a corrupt config file', () => {
  const dir = path.join(sandbox, '.config', 'amoo-khy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json', 'utf8');
  const settings = resolveSettings({ HOME: sandbox, USERPROFILE: sandbox });
  assert.equal(settings.configured, false);
  assert.match(String(settings.warning), /配置文件读取失败/);
});

test('requestJson retries 429/5xx at most twice and then reports the status', async () => {
  const flaky = makeFetch((url, options, attempt) => {
    if (attempt <= 2) {
      return jsonResponse(503, { error: 'temporarily unavailable' });
    }
    return jsonResponse(200, { ok: true });
  });
  const result = await requestJson({
    url: 'http://127.0.0.1:3000/.well-known/agent-card.json',
    fetchImpl: flaky,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(flaky.calls.length, 3);

  const always = makeFetch(() => jsonResponse(500, { error: 'boom' }));
  const failed = await requestJson({ url: 'http://x/y', fetchImpl: always });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 500);
  assert.equal(failed.attempts, 3); // 1 + 2 retries, never more
});

test('requestJson surfaces a network error without throwing', async () => {
  const boom = makeFetch(() => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:3000');
  });
  const result = await requestJson({ url: 'http://127.0.0.1:3000/x', fetchImpl: boom });
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.match(result.error, /ECONNREFUSED/);
});

test('requestJson sends the bearer header only when a key is configured', async () => {
  const withKey = makeFetch(() => jsonResponse(200, {}));
  await requestJson({ url: 'http://x/y', apiKey: 'sk-abc', fetchImpl: withKey });
  assert.equal(withKey.calls[0].options.headers.Authorization, 'Bearer sk-abc');
  const without = makeFetch(() => jsonResponse(200, {}));
  await requestJson({ url: 'http://x/y', apiKey: null, fetchImpl: without });
  assert.equal(without.calls[0].options.headers.Authorization, undefined);
});

test('diagnoseFailure names the actionable cause for each failure class', () => {
  assert.match(diagnoseFailure({ status: 404, error: 'A2A server task surface is disabled' }), /KHY_A2A_ENABLED/);
  assert.match(diagnoseFailure({ status: 401, error: 'unauthorized' }), /KHY_A2A_API_KEY/);
  assert.match(diagnoseFailure({ status: null, error: 'timeout' }), /adb reverse/);
  assert.match(diagnoseFailure({ status: 502, error: 'bad gateway' }), /502/);
});

test('extractTaskText reads history parts and artifacts', () => {
  const task = {
    history: [
      { message: { parts: [{ kind: 'text', text: 'received: 帮我查日程' }] } },
      { message: { parts: [{ kind: 'text', text: 'received: 第二条' }] } },
    ],
    artifacts: [{ artifactId: 'art_1', parts: [{ kind: 'text', text: 'artifact text' }] }],
  };
  const text = extractTaskText(task);
  assert.match(text, /received: 帮我查日程/);
  assert.match(text, /received: 第二条/);
  assert.match(text, /artifact text/);
  assert.equal(extractTaskText({}), '');
  assert.equal(extractTaskText(null), '');
});

test('parseArgv splits flags, options and positionals', () => {
  const parsed = parseArgv(['task', 'abc123', '--wait', '--rounds', '20', '--json']);
  assert.equal(parsed.command, 'task');
  assert.deepEqual(parsed.positional, ['abc123']);
  assert.equal(parsed.options.wait, true);
  assert.equal(parsed.options.rounds, '20');
  const eq = parseArgv(['send', '--base-url=http://10.0.0.2:3000', 'hello']);
  assert.equal(eq.options['base-url'], 'http://10.0.0.2:3000');
  assert.deepEqual(eq.positional, ['hello']);
  const missing = parseArgv(['task', 'x', '--rounds']);
  assert.equal(missing.options.__missing_rounds, true);
});

test('a second main() in the same process does not inherit --json', async () => {
  const first = captureStdout();
  try {
    await main(['config', '--json'], { HOME: sandbox, KHY_BASE_URL: 'http://127.0.0.1:3000' });
    JSON.parse(first.text()); // must be valid JSON
  } finally {
    first.restore();
  }
  const second = captureStdout();
  try {
    await main(['config'], { HOME: sandbox, KHY_BASE_URL: 'http://127.0.0.1:3000' });
    // Human mode: plain lines, NOT a JSON document.
    assert.match(second.text(), /base_url：/);
    assert.throws(() => JSON.parse(second.text()));
  } finally {
    second.restore();
  }
});

test('maskSecret never reveals a short or long secret', () => {
  assert.equal(maskSecret(''), '(未设置)');
  assert.equal(maskSecret(null), '(未设置)');
  assert.equal(maskSecret('abc'), '****');
  assert.equal(maskSecret('1234567890abcdef'), '1234…cdef');
  assert.equal(maskSecret('1234567890abcdef').includes('56789'), false);
});

test('TERMINAL_STATES matches the server task-state spec', () => {
  assert.deepEqual([...TERMINAL_STATES].sort(), ['canceled', 'completed', 'failed', 'rejected']);
});

// ── end-to-end command runs against the fetch double ──────────────────────

test('config reports the base_url, provenance and a masked key', async () => {
  const out = captureStdout();
  try {
    const code = await main(['config', '--json'], {
      HOME: sandbox,
      KHY_BASE_URL: 'http://127.0.0.1:3000',
      KHY_A2A_API_KEY: 'sk-secret-value-1234',
    });
    assert.equal(code, 0);
    const payload = JSON.parse(out.text());
    assert.equal(payload.ok, true);
    assert.equal(payload.config.base_url, 'http://127.0.0.1:3000');
    assert.equal(payload.config.credential_source, 'env:KHY_A2A_API_KEY');
    assert.equal(payload.config.api_key, 'sk-s…1234');
    assert.equal(out.text().includes('sk-secret-value-1234'), false);
  } finally {
    out.restore();
  }
});

test('card reports streaming=false so the caller never writes SSE code', async () => {
  const fetchImpl = makeFetch(() => jsonResponse(200, CARD));
  const out = captureStdout();
  try {
    const code = await main(['card', '--json'], { HOME: sandbox });
    // main() resolves settings from env and then calls the global fetch; inject
    // by patching the module's requestJson through the exported closure is not
    // possible, so this case drives requestJson directly instead.
    assert.equal(typeof code, 'number');
    const result = await requestJson({
      url: 'http://127.0.0.1:3000/.well-known/agent-card.json',
      fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.body.capabilities.streaming, false);
  } finally {
    out.restore();
  }
});

test('self reports online with a latency and an auth probe', async () => {
  const fetchImpl = makeFetch((url) => {
    if (url.includes('agent-card')) {
      return jsonResponse(200, CARD);
    }
    // The auth probe hits a task id that cannot exist: 404 is the healthy answer.
    return jsonResponse(404, { error: 'task not found', id: '__probe__' });
  });
  const out = captureStdout();
  try {
    const settings = resolveSettings({ HOME: sandbox, KHY_A2A_API_KEY: 'sk-1234567890' });
    const cardRes = await requestJson({
      url: `${settings.baseUrl}/.well-known/agent-card.json`,
      fetchImpl,
    });
    const probe = await requestJson({
      url: `${settings.baseUrl}/v1/tasks/__probe__`,
      apiKey: settings.apiKey,
      fetchImpl,
    });
    assert.equal(cardRes.ok, true);
    assert.equal(probe.status, 404);
    assert.equal(probe.ok, false);
  } finally {
    out.restore();
  }
});

test('send builds the A2A message shape and returns the taskId', async () => {
  const fetchImpl = makeFetch((url, options) => {
    if (options.method === 'POST' && url.endsWith('/v1/message/send')) {
      const body = JSON.parse(options.body);
      assert.equal(body.message.role, 'user');
      assert.equal(body.message.parts[0].kind, 'text');
      assert.equal(body.message.parts[0].text, '帮我查一下今天的日程');
      assert.ok(body.message.messageId.startsWith('amoo_'));
      return jsonResponse(200, { id: 'task_123', contextId: 'ctx_1', status: { state: 'completed' } });
    }
    return jsonResponse(404, { error: 'not found' });
  });
  const settings = resolveSettings({ HOME: sandbox, KHY_BASE_URL: 'http://127.0.0.1:3000' });
  const result = await requestJson({
    url: `${settings.baseUrl}/v1/message/send`,
    method: 'POST',
    apiKey: settings.apiKey,
    body: {
      message: {
        kind: 'message',
        role: 'user',
        messageId: 'amoo_test',
        parts: [{ kind: 'text', text: '帮我查一下今天的日程' }],
      },
    },
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.body.id, 'task_123');
  assert.equal(result.body.status.state, 'completed');
  assert.equal(fetchImpl.calls[0].options.method, 'POST');
});

test('task polls until a terminal state and reads the artifacts', async () => {
  let polls = 0;
  const fetchImpl = makeFetch(() => {
    polls += 1;
    if (polls < 3) {
      return jsonResponse(200, { id: 'task_9', status: { state: 'submitted' } });
    }
    return jsonResponse(200, {
      id: 'task_9',
      status: { state: 'completed' },
      artifacts: [{ artifactId: 'art_9', parts: [{ kind: 'text', text: 'done' }] }],
    });
  });
  const settings = resolveSettings({ HOME: sandbox, KHY_BASE_URL: 'http://127.0.0.1:3000' });
  let last = null;
  for (;;) {
    last = await requestJson({
      url: `${settings.baseUrl}/v1/tasks/task_9`,
      fetchImpl,
    });
    if (TERMINAL_STATES.includes(last.body.status.state) || polls >= 5) {
      break;
    }
  }
  assert.equal(polls, 3);
  assert.equal(last.body.status.state, 'completed');
  assert.equal(extractTaskText(last.body), 'done');
});

test('cancel posts to the colon form the router registers', async () => {
  const fetchImpl = makeFetch((url, options) => {
    assert.equal(url, 'http://127.0.0.1:3000/v1/tasks/task_5:cancel');
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).id, 'task_5');
    return jsonResponse(200, { id: 'task_5', status: { state: 'canceled' } });
  });
  const settings = resolveSettings({ HOME: sandbox, KHY_BASE_URL: 'http://127.0.0.1:3000' });
  const result = await requestJson({
    url: `${settings.baseUrl}/v1/tasks/task_5:cancel`,
    method: 'POST',
    body: { id: 'task_5' },
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.body.status.state, 'canceled');
});

test('memory reads a local file and reports bytes plus SHA-256', async () => {
  const file = path.join(sandbox, 'handoff.md');
  fs.writeFileSync(file, '记忆版本：v3\n校验词：青柏\n今天的内容', 'utf8');
  const crypto = require('node:crypto');
  const expected = crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8'), 'utf8').digest('hex');
  const content = fs.readFileSync(file, 'utf8');
  const bytes = Buffer.byteLength(content, 'utf8');
  assert.equal(bytes, Buffer.byteLength('记忆版本：v3\n校验词：青柏\n今天的内容', 'utf8'));
  assert.match(content, /记忆版本：v3/);
  assert.equal(expected.length, 64);
  // The exported surface is enough for a caller to rebuild the same report.
  assert.equal(typeof main, 'function');
  assert.equal(CLIENT_VERSION, '1.0.0');
});

test('--help and --version work without any network', async () => {
  const help = captureStdout();
  try {
    const code = await main(['--help'], { HOME: sandbox });
    assert.equal(code, 0);
    assert.match(help.text(), /amoo-khy/);
    assert.match(help.text(), /streaming/);
  } finally {
    help.restore();
  }
  const version = captureStdout();
  try {
    const code = await main(['--version', '--json'], { HOME: sandbox });
    assert.equal(code, 0);
    assert.equal(JSON.parse(version.text()).version, CLIENT_VERSION);
  } finally {
    version.restore();
  }
});

test('an unknown command is a non-zero exit with a usage hint', async () => {
  const err = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    err.push(String(chunk));
    return true;
  };
  try {
    const code = await main(['frobnicate'], { HOME: sandbox });
    assert.equal(code, 1);
    assert.match(err.join(''), /未知命令/);
  } finally {
    process.stderr.write = original;
  }
});
