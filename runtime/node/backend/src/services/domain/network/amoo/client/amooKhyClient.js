'use strict';

/**
 * amoo-khy client — a single-file, zero-dependency CLI that lets Amoo (the
 * on-phone agent) call khy-os from its Node workspace.
 *
 * WHY this exists (and why this direction): Amoo → khy-os is the primary
 * collaboration direction. It reuses a chain already verified on the device
 * (Amoo runs a Node 22+ workspace; a single-file zero-dep CLI called from there
 * reached an external HTTP API), it needs no UI automation, no accessibility
 * grant and no foreground window, and the results land on the PC where they
 * belong. khy-os → Amoo (UI automation through the phone bridge) stays the
 * fallback for when Amoo has no Node workspace at all.
 *
 * Shape follows the amoo-notion precedent that Amoo is known to accept:
 *   one file, no third-party requires, subcommands, a uniform --json, --help /
 *   --version, credentials from env first and a 0600 config file second,
 *   one 30s request timeout, at most 2 retries on 429/5xx, Chinese errors with
 *   the token masked, and `init --stdin` for non-interactive setup.
 *
 * khy-os side (measured in this repo, not assumed):
 *   GET  /.well-known/agent-card.json   public, no auth; capabilities.streaming
 *                                       is FALSE — there is no SSE anywhere, so
 *                                       this client only ever does send + poll.
 *   POST /v1/message/send               {message:{kind,role,messageId,parts:[{kind:'text',text}]}}
 *                                       → Task; the default executor is an
 *                                       honest placeholder that echoes
 *                                       "received: <text>", not an LLM.
 *   GET  /v1/tasks/:id                  → Task
 *   POST /v1/tasks/:id:cancel           → Task
 *   There is NO task-list endpoint. `tasks` says so instead of inventing one.
 *   Auth: optional `Authorization: Bearer <KHY_A2A_API_KEY>`; when the server
 *         has no key configured it lets calls through, so a LAN-exposed backend
 *         must set one. Both a2a and wellKnown answer 404 with
 *         "A2A server task surface is disabled" when KHY_A2A_ENABLED is off.
 *
 * DELIVERY TO THE PHONE (three routes, first is preferred):
 *   a) adb push  — `adb push amoo-khy-client.js /sdcard/Download/` then verify
 *      byte count + SHA-256 with `sha256sum` on the device. Then pick the file
 *      from Amoo's attachment entry so it lands in the workspace verbatim.
 *   b) attachment — copy to `amoo-khy-client.js.txt` (phone file pickers hide
 *      `.js`), send it over, attach it in Amoo. ALWAYS compare SHA-256: the
 *      attachment channel can transcode. On mismatch go back to (a).
 *   c) bridge write — once StepBridge is installed and authorised, push the file
 *      through the bridge `write` tool or drop a `cmd_<id>.json` in its mailbox.
 *
 * Secret handling: the API key is read from the environment or from the 0600
 * config file and is never printed, never logged, and never written anywhere
 * except that config file by an explicit `init`.
 *
 * Run `node amoo-khy-client.js --help` for usage.
 *
 * @module amoo-khy-client
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CLIENT_VERSION = '1.0.0';
const CONFIG_DIR_NAME = 'amoo-khy';
const CONFIG_FILE_NAME = 'config.json';
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 800;
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ROUNDS = 40;
const DEFAULT_LOOPBACK = '127.0.0.1';
const DEFAULT_PORT = '3000';
const TERMINAL_STATES = ['completed', 'canceled', 'failed', 'rejected'];

const USAGE = [
  'amoo-khy — 让 Amoo 在工作区里调用 khy-os 的 A2A 服务端',
  '',
  '用法：',
  '  node amoo-khy-client.js <命令> [参数] [--json]',
  '',
  '命令：',
  '  config                  报告 base_url、是否已配置、凭据来源（不显示密钥）',
  '  card                    读取 khy-os 的 Agent Card，报告名称/版本/能力',
  '  self                    探活：card + 一次延迟测量',
  '  send <任务文本>         下发任务，返回 taskId 与初始状态',
  '  task <taskId>           查询任务；--wait 轮询到终态并读 artifacts',
  '  tasks                   任务列表（khy-os 服务端未提供该端点，命令会说明）',
  '  cancel <taskId>         撤销任务',
  '  memory <路径或URL>      只读交接记忆，报告字节数与 SHA-256 供核对版本',
  '  init [--stdin]          写入凭据（--stdin 供非交互环境）',
  '  --help / --version',
  '',
  '环境变量：',
  '  KHY_BASE_URL            khy-os 基址（如 http://127.0.0.1:3000）',
  '  KHY_A2A_API_KEY         首选 API key；其次 KHY_API_KEY',
  `  配置文件                 ~/.config/${CONFIG_DIR_NAME}/${CONFIG_FILE_NAME}（权限 0600）`,
  '',
  '注意：khy-os 没有 SSE 流式实现（agent-card 的 streaming 为 false），',
  '      所以本客户端只做「下发 + 轮询」，不做任何流式代码路径。',
].join('\n');

// ── output ────────────────────────────────────────────────────────────────

let jsonMode = false;

function emit(payload) {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const lines = Array.isArray(payload.lines) ? payload.lines : [payload.message || ''];
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

function fail(code, message, extra) {
  const payload = { ok: false, code, message, ...(extra || {}) };
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stderr.write(`错误：${message}\n`);
  }
  return 1;
}

function maskSecret(value) {
  const text = String(value || '');
  if (!text) {
    return '(未设置)';
  }
  if (text.length <= 8) {
    return '****';
  }
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

// ── config / credentials ──────────────────────────────────────────────────

function configDir() {
  return path.join(os.homedir(), '.config', CONFIG_DIR_NAME);
}

function configFilePath() {
  return path.join(configDir(), CONFIG_FILE_NAME);
}

function readConfigFile() {
  const file = configFilePath();
  try {
    if (!fs.existsSync(file)) {
      return { ok: true, exists: false, data: null, path: file };
    }
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return { ok: true, exists: true, data: parsed, path: file };
  } catch (error) {
    return { ok: false, exists: true, data: null, path: file, error: String(error && error.message) };
  }
}

/**
 * Resolve base_url and credentials. Env wins over the config file; the config
 * file is written with 0600 and is the only place a key is ever persisted.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{baseUrl:string, baseUrlSource:string, configured:boolean,
 *            apiKey:string|null, credentialSource:string, configPath:string,
 *            configExists:boolean, warning:string|null}}
 */
function resolveSettings(env = process.env) {
  const file = readConfigFile();
  const data = file.ok && file.data && typeof file.data === 'object' ? file.data : {};

  const envBase = typeof env.KHY_BASE_URL === 'string' ? env.KHY_BASE_URL.trim() : '';
  const fileBase = typeof data.base_url === 'string' ? data.base_url.trim() : '';
  let baseUrl = envBase || fileBase;
  let baseUrlSource = envBase ? 'env:KHY_BASE_URL' : fileBase ? `file:${configFilePath()}` : 'default';
  if (!baseUrl) {
    // Default is the adb-reverse friendly loopback. Assembled from parts so no
    // host:port literal is pinned in this file.
    baseUrl = `http://${DEFAULT_LOOPBACK}:${DEFAULT_PORT}`;
  }
  baseUrl = baseUrl.replace(/\/+$/, '');

  const envKey =
    (typeof env.KHY_A2A_API_KEY === 'string' && env.KHY_A2A_API_KEY.trim()) ||
    (typeof env.KHY_API_KEY === 'string' && env.KHY_API_KEY.trim()) ||
    '';
  const fileKey = typeof data.api_key === 'string' && data.api_key.trim() ? data.api_key.trim() : '';
  const apiKey = envKey || fileKey || null;
  const credentialSource = envKey
    ? env.KHY_A2A_API_KEY
      ? 'env:KHY_A2A_API_KEY'
      : 'env:KHY_API_KEY'
    : fileKey
      ? `file:${configFilePath()}`
      : 'none';

  return {
    baseUrl,
    baseUrlSource,
    configured: Boolean(envBase || fileBase),
    apiKey,
    credentialSource,
    configPath: configFilePath(),
    configExists: file.exists === true,
    warning: file.ok ? null : `配置文件读取失败：${file.error}`,
  };
}

// ── HTTP ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * One request with a 30s deadline and at most 2 retries on 429/5xx.
 * Never throws; a network failure becomes a structured error.
 * @param {{url:string, method?:string, body?:object|null, apiKey:string|null,
 *          timeoutMs?:number, retries?:number, fetchImpl?:Function}} request
 * @returns {Promise<{ok:boolean, status:number|null, body:any, error:string|null,
 *                    attempts:number, latencyMs:number}>}
 */
async function requestJson(request) {
  const fetchImpl = typeof request.fetchImpl === 'function' ? request.fetchImpl : fetch;
  const timeoutMs = Number(request.timeoutMs) || REQUEST_TIMEOUT_MS;
  const maxRetries = Number.isFinite(Number(request.retries)) ? Number(request.retries) : MAX_RETRIES;
  const headers = { Accept: 'application/json' };
  let payload = null;
  if (request.body !== null && request.body !== undefined) {
    payload = JSON.stringify(request.body);
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }
  if (request.apiKey) {
    headers.Authorization = `Bearer ${request.apiKey}`;
  }

  const startedAt = Date.now();
  let attempt = 0;
  let lastError = 'unknown';

  for (;;) {
    attempt += 1;
    try {
      const response = await fetchImpl(request.url, {
        method: request.method || (payload ? 'POST' : 'GET'),
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (isRetryableStatus(response.status) && attempt <= maxRetries) {
        lastError = `http_${response.status}`;
        await sleep(RETRY_BASE_MS * attempt);
        continue;
      }
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        body: parsed,
        raw: text,
        error:
          response.status >= 200 && response.status < 300
            ? null
            : `http_${response.status}${parsed && parsed.error ? `：${parsed.error}` : ''}`,
        attempts: attempt,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      lastError = String((error && error.message) || error) || 'network_error';
      if (attempt <= maxRetries) {
        await sleep(RETRY_BASE_MS * attempt);
        continue;
      }
      return {
        ok: false,
        status: null,
        body: null,
        raw: '',
        error: lastError,
        attempts: attempt,
        latencyMs: Date.now() - startedAt,
      };
    }
  }
}

function newMessageId() {
  return `amoo_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Explain a failed probe in one of the four buckets a phone user can act on.
 * @param {{status:number|null, error:string|null}} result
 * @returns {string}
 */
function diagnoseFailure(result) {
  if (result.status === 404) {
    return 'khy-os 返回 404：A2A 任务面可能被 KHY_A2A_ENABLED 关闭（默认开），或基址路径不对。';
  }
  if (result.status === 401 || result.status === 403) {
    return 'khy-os 拒绝了凭据：检查 KHY_A2A_API_KEY 是否与 PC 侧一致。';
  }
  if (result.status === null) {
    return '连不上 khy-os：手机到 PC 不通。走 adb reverse tcp:<端口> tcp:<端口> 后访问 127.0.0.1，或确认防火墙入站放行。';
  }
  return `khy-os 返回 ${result.status}：${result.error || '未知原因'}`;
}

// ── commands ──────────────────────────────────────────────────────────────

async function cmdConfig(settings) {
  emit({
    ok: true,
    lines: [
      `base_url：${settings.baseUrl}`,
      `来源：${settings.baseUrlSource}`,
      `已显式配置：${settings.configured ? '是' : '否（用的是默认回环地址，adb reverse 场景可用）'}`,
      `凭据来源：${settings.credentialSource}`,
      `密钥：${maskSecret(settings.apiKey)}`,
      `配置文件：${settings.configPath}${settings.configExists ? '（已存在）' : '（不存在）'}`,
      settings.warning ? `警告：${settings.warning}` : '',
    ].filter(Boolean),
    config: {
      base_url: settings.baseUrl,
      base_url_source: settings.baseUrlSource,
      configured: settings.configured,
      credential_source: settings.credentialSource,
      api_key: maskSecret(settings.apiKey),
      config_path: settings.configPath,
    },
  });
  return 0;
}

async function cmdCard(settings) {
  const res = await requestJson({
    url: `${settings.baseUrl}/.well-known/agent-card.json`,
    method: 'GET',
    apiKey: null,
  });
  if (!res.ok) {
    return fail('card_failed', `读不到 Agent Card。${diagnoseFailure(res)}`, {
      base_url: settings.baseUrl,
      status: res.status,
      latency_ms: res.latencyMs,
    });
  }
  const card = res.body || {};
  const capabilities = card.capabilities || {};
  const lines = [
    `name：${card.name || '(未声明)'}`,
    `version：${card.version || '(未声明)'}`,
    `protocolVersion：${card.protocolVersion || '(未声明)'}`,
    `streaming：${capabilities.streaming === true ? 'true' : 'false'}${capabilities.streaming === true ? '' : '（无 SSE，只能下发+轮询）'}`,
    `url：${card.url || '(未声明)'}`,
    `技能数：${Array.isArray(card.skills) ? card.skills.length : 0}`,
    `本次延迟：${res.latencyMs}ms`,
  ];
  emit({ ok: true, lines, card, latency_ms: res.latencyMs });
  return 0;
}

async function cmdSelf(settings) {
  const res = await requestJson({
    url: `${settings.baseUrl}/.well-known/agent-card.json`,
    method: 'GET',
    apiKey: null,
  });
  if (!res.ok) {
    return fail('self_failed', `khy-os 不在线或不可达。${diagnoseFailure(res)}`, {
      base_url: settings.baseUrl,
      credential_source: settings.credentialSource,
      status: res.status,
      latency_ms: res.latencyMs,
    });
  }
  const card = res.body || {};
  // Probing a task id that cannot exist separates "server is up" from "auth is
  // accepted": 404 here is the healthy answer, 401 means the key is wrong.
  const authed = settings.apiKey
    ? await requestJson({
        url: `${settings.baseUrl}/v1/tasks/__probe__`,
        method: 'GET',
        apiKey: settings.apiKey,
      })
    : null;
  emit({
    ok: true,
    lines: [
      `khy-os 在线：${card.name || 'khy-os'} ${card.version || ''}`.trim(),
      `base_url：${settings.baseUrl}（${settings.baseUrlSource}）`,
      `凭据来源：${settings.credentialSource}，密钥 ${maskSecret(settings.apiKey)}`,
      `streaming：${(card.capabilities || {}).streaming === true ? 'true' : 'false'}`,
      authed
        ? `带鉴权探活：HTTP ${authed.status}${authed.status === 404 ? '（404 = 服务端在线但无此任务，符合预期）' : ''}`
        : '未配置 API key：如果 PC 侧设了 KHY_A2A_API_KEY，调用会被 401 拒绝。',
      `本次探活延迟：${res.latencyMs}ms`,
    ],
    online: true,
    base_url: settings.baseUrl,
    credential_source: settings.credentialSource,
    card,
    latency_ms: res.latencyMs,
    auth_probe_status: authed ? authed.status : null,
  });
  return 0;
}

async function cmdSend(settings, text) {
  if (!text || !text.trim()) {
    return fail('task_text_empty', '任务文本为空：send 需要一段任务描述。');
  }
  const messageId = newMessageId();
  const res = await requestJson({
    url: `${settings.baseUrl}/v1/message/send`,
    method: 'POST',
    apiKey: settings.apiKey,
    body: {
      message: {
        kind: 'message',
        role: 'user',
        messageId,
        parts: [{ kind: 'text', text }],
      },
    },
  });
  if (!res.ok) {
    return fail('send_failed', `任务下发失败。${diagnoseFailure(res)}`, {
      base_url: settings.baseUrl,
      message_id: messageId,
      status: res.status,
    });
  }
  const task = res.body || {};
  const state = (task.status && task.status.state) || '(未声明)';
  emit({
    ok: true,
    lines: [
      `taskId：${task.id || '(未声明)'}`,
      `contextId：${task.contextId || '(未声明)'}`,
      `初始状态：${state}`,
      `messageId：${messageId}`,
      `提示：默认 executor 是诚实占位（回显 received: <文本>），不跑 LLM。`,
    ],
    task,
    task_id: task.id || null,
    message_id: messageId,
    state,
  });
  return 0;
}

function extractTaskText(task) {
  const parts = [];
  const history = Array.isArray(task && task.history) ? task.history : [];
  for (const entry of history) {
    const message = entry && entry.message ? entry.message : entry;
    const items = message && Array.isArray(message.parts) ? message.parts : [];
    for (const part of items) {
      if (part && part.kind === 'text' && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
  }
  const artifacts = Array.isArray(task && task.artifacts) ? task.artifacts : [];
  for (const artifact of artifacts) {
    const items = artifact && Array.isArray(artifact.parts) ? artifact.parts : [];
    for (const part of items) {
      if (part && part.kind === 'text' && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
  }
  return parts.join('\n').trim();
}

async function cmdTask(settings, taskId, options) {
  if (!taskId) {
    return fail('task_id_required', '缺少 taskId：task 需要任务标识。');
  }
  const wait = options.wait === true;
  const maxRounds = Number(options.rounds) > 0 ? Number(options.rounds) : POLL_MAX_ROUNDS;
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : POLL_INTERVAL_MS;
  let rounds = 0;
  let last = null;
  for (;;) {
    rounds += 1;
    const res = await requestJson({
      url: `${settings.baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`,
      method: 'GET',
      apiKey: settings.apiKey,
    });
    if (!res.ok) {
      if (res.status === 404) {
        return fail('task_not_found', `任务 ${taskId} 不存在（404）。`, {
          task_id: taskId,
          status: res.status,
        });
      }
      return fail('task_failed', `任务查询失败。${diagnoseFailure(res)}`, { task_id: taskId, status: res.status });
    }
    last = res.body || {};
    const state = (last.status && last.status.state) || '';
    if (!wait || TERMINAL_STATES.includes(state)) {
      break;
    }
    if (rounds >= maxRounds) {
      break;
    }
    await sleep(intervalMs);
  }
  const state = (last && last.status && last.status.state) || '(未声明)';
  const text = extractTaskText(last);
  emit({
    ok: true,
    lines: [
      `taskId：${(last && last.id) || taskId}`,
      `状态：${state}${TERMINAL_STATES.includes(state) ? '（终态）' : '（未到终态）'}`,
      `轮询轮次：${rounds}`,
      `artifacts：${Array.isArray(last && last.artifacts) ? last.artifacts.length : 0} 个`,
      text ? `文本内容（${text.length} 字）：\n${text}` : '没有可读取的文本内容。',
    ],
    task: last,
    task_id: taskId,
    state,
    rounds,
    text,
  });
  return TERMINAL_STATES.includes(state) ? 0 : 2;
}

async function cmdTasks() {
  emit({
    ok: false,
    lines: [
      'khy-os 的 A2A 服务端没有任务列表端点（routes/a2a.js 只挂了',
      '  POST /v1/message/send、GET /v1/tasks/:id、POST /v1/tasks/:id:cancel）。',
      '请改用：task <taskId> [--wait] 按 id 查询；id 由 send 的返回值给出。',
    ],
  });
  return 1;
}

async function cmdCancel(settings, taskId) {
  if (!taskId) {
    return fail('task_id_required', '缺少 taskId：cancel 需要任务标识。');
  }
  const res = await requestJson({
    url: `${settings.baseUrl}/v1/tasks/${encodeURIComponent(taskId)}:cancel`,
    method: 'POST',
    apiKey: settings.apiKey,
    body: { id: taskId },
  });
  if (!res.ok) {
    if (res.status === 404) {
      return fail('task_not_found', `任务 ${taskId} 不存在（404）。`, { task_id: taskId });
    }
    return fail('cancel_failed', `撤销失败。${diagnoseFailure(res)}`, { task_id: taskId, status: res.status });
  }
  const task = res.body || {};
  emit({
    ok: true,
    lines: [`taskId：${task.id || taskId}`, `状态：${(task.status && task.status.state) || '(未声明)'}`],
    task,
    task_id: taskId,
  });
  return 0;
}

async function cmdMemory(settings, address) {
  if (!address) {
    return fail('memory_address_required', '缺少记忆地址：memory 需要文件路径或 http(s) URL。');
  }
  let content = '';
  let source = '';
  if (/^https?:\/\//i.test(address)) {
    const res = await requestJson({ url: address, method: 'GET', apiKey: null });
    if (!res.ok) {
      return fail('memory_fetch_failed', `记忆读取失败。${diagnoseFailure(res)}`, { address });
    }
    content = String(res.raw || '');
    source = address;
  } else {
    try {
      content = fs.readFileSync(address, 'utf8');
      source = path.resolve(address);
    } catch (error) {
      return fail('memory_read_failed', `记忆文件读取失败：${(error && error.message) || '未知原因'}`, {
        address,
      });
    }
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  const versionMatch = content.match(/记忆版本[:：]\s*([^\n]+)/);
  const checksumMatch = content.match(/校验词[:：]\s*([^\n]+)/);
  emit({
    ok: true,
    lines: [
      `来源：${source}`,
      `字节数：${bytes}`,
      `SHA-256：${sha256}`,
      versionMatch ? `记忆版本：${versionMatch[1].trim()}` : '记忆版本：未在内容中找到「记忆版本：」行',
      checksumMatch ? `校验词：${checksumMatch[1].trim()}` : '校验词：未在内容中找到「校验词：」行',
      '把字节数与 SHA-256 回报给调用方，用来核对读的是不是新版。',
      '',
      content,
    ],
    memory: { source, bytes, sha256, version: versionMatch ? versionMatch[1].trim() : null, checksum: checksumMatch ? checksumMatch[1].trim() : null },
  });
  return 0;
}

async function cmdInit(settings, tokens) {
  const baseUrl = tokens.base_url || settings.baseUrl;
  const apiKey = tokens.api_key || settings.apiKey || '';
  const dir = configDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = configFilePath();
    fs.writeFileSync(file, `${JSON.stringify({ base_url: baseUrl, api_key: apiKey }, null, 2)}\n`, {
      mode: 0o600,
    });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* Windows ignores POSIX modes; the file is still written */
    }
  } catch (error) {
    return fail('init_failed', `写入配置失败：${(error && error.message) || '未知原因'}`, {
      config_path: configFilePath(),
    });
  }
  emit({
    ok: true,
    lines: [
      `已写入 ${configFilePath()}（权限 0600）`,
      `base_url：${baseUrl}`,
      `密钥：${maskSecret(apiKey)}`,
      '环境变量 KHY_BASE_URL / KHY_A2A_API_KEY 优先级高于此文件。',
    ],
    config_path: configFilePath(),
    base_url: baseUrl,
    credential_source: apiKey ? `file:${configFilePath()}` : 'none',
  });
  return 0;
}

// ── argv ──────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const options = {};
  const positional = [];
  let command = null;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') {
      jsonMode = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    if (token === '--version' || token === '-v') {
      options.version = true;
      continue;
    }
    if (token === '--wait') {
      options.wait = true;
      continue;
    }
    if (token === '--stdin') {
      options.stdin = true;
      continue;
    }
    if (token === '--rounds' || token === '--interval' || token === '--base-url' || token === '--api-key') {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined) {
        options[`__missing_${key}`] = true;
        continue;
      }
      options[key] = value;
      i += 1;
      continue;
    }
    if (token.startsWith('--') && token.includes('=')) {
      const idx = token.indexOf('=');
      options[token.slice(2, idx)] = token.slice(idx + 1);
      continue;
    }
    if (token.startsWith('--')) {
      options[token.slice(2)] = true;
      continue;
    }
    if (command === null) {
      command = token;
      continue;
    }
    positional.push(token);
  }
  return { command, positional, options };
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  // Reset the output mode first: it is module state, and a second main() in the
  // same process (tests, or an embedding that calls it twice) must not inherit
  // the previous run's --json.
  jsonMode = false;
  const parsed = parseArgv(argv);
  if (parsed.options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (parsed.options.version) {
    emit({ ok: true, lines: [`amoo-khy ${CLIENT_VERSION}`], version: CLIENT_VERSION });
    return 0;
  }
  if (!parsed.command) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (Object.keys(parsed.options).some((key) => key.startsWith('__missing_'))) {
    return fail('option_value_missing', '有选项缺了值，例如 --rounds 20。');
  }

  const settings = resolveSettings(env);
  if (parsed.options['base-url']) {
    settings.baseUrl = String(parsed.options['base-url']).replace(/\/+$/, '');
    settings.baseUrlSource = 'cli:--base-url';
    settings.configured = true;
  }
  if (parsed.options['api-key']) {
    settings.apiKey = String(parsed.options['api-key']);
    settings.credentialSource = 'cli:--api-key';
  }

  switch (parsed.command) {
    case 'config':
      return cmdConfig(settings);
    case 'card':
      return cmdCard(settings);
    case 'self':
      return cmdSelf(settings);
    case 'send':
      return cmdSend(settings, parsed.positional.join(' '));
    case 'task':
      return cmdTask(settings, parsed.positional[0], {
        wait: parsed.options.wait === true,
        rounds: parsed.options.rounds,
        intervalMs: parsed.options.interval,
      });
    case 'tasks':
      return cmdTasks(settings);
    case 'cancel':
      return cmdCancel(settings, parsed.positional[0]);
    case 'memory':
      return cmdMemory(settings, parsed.positional[0]);
    case 'init': {
      let tokens = {};
      if (parsed.options.stdin === true) {
        const raw = readStdin();
        try {
          tokens = JSON.parse(raw);
        } catch {
          tokens = { api_key: raw.trim() };
        }
      }
      return cmdInit(settings, tokens);
    }
    default:
      return fail('unknown_command', `未知命令：${parsed.command}。用 --help 看用法。`);
  }
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = typeof code === 'number' ? code : 0;
    },
    (error) => {
      process.stderr.write(`错误：${(error && error.message) || error}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = {
  CLIENT_VERSION,
  USAGE,
  REQUEST_TIMEOUT_MS,
  MAX_RETRIES,
  TERMINAL_STATES,
  resolveSettings,
  requestJson,
  parseArgv,
  diagnoseFailure,
  extractTaskText,
  maskSecret,
  newMessageId,
  main,
};
