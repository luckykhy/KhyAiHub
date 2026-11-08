#!/usr/bin/env node
/**
 * External image-to-3D service client for the Khy OS realistic pet form.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The realistic pet form needs a real 3D mesh. Two routes exist:
 *
 *   A. LOCAL  — scripts/brand/run-image-to-3d.py runs StableFast3D on this
 *               machine. No token needed, but CPU-only and slow.
 *   B. REMOTE — a hosted image-to-3D API (Replicate / SiliconFlow / DashScope)
 *               is faster and higher quality, but needs a token.
 *
 * This script is route B. It reads the token from the gitignored key pool
 * (works/data/khy/api_keys.json, provider field `realtime3d`) or from the
 * KHY_3D_API_KEY / REPLICATE_API_TOKEN environment variables. **The token is
 * never hardcoded here and never written to the repo** (SECURITY-001 / R2).
 *
 * Usage:
 *   node scripts/brand/image-to-3d-service.js --input <png> --output <glb>
 *   node scripts/brand/image-to-3d-service.js --provider replicate --model owner/model
 *   node scripts/brand/image-to-3d-service.js --probe        # only check reachability
 *
 * Provider registry:
 *   replicate    POST https://api.replicate.com/v1/predictions  (header: Authorization)
 *   siliconflow  POST https://api.siliconflow.cn/v1/images/generations  (3D mesh models)
 *   dashscope    POST https://dashscope.aliyuncs.com/api/v1/services/aigc/text-to-3d
 *
 * Output: the downloaded GLB. Model/version identifiers are **not** hardcoded
 * to a specific paid model — the caller passes --model, and the default is the
 * best-known public image-to-3D model per provider.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');

/** Providers: endpoint, auth header shape, and how the GLB comes back. */
const PROVIDERS = {
  replicate: {
    base: 'https://api.replicate.com/v1',
    defaultModel: 'tencent/hunyuan3d-2',
    // Replicate prediction flow: create -> poll -> fetch output URL.
    kind: 'prediction',
  },
  siliconflow: {
    base: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Kwai/Kwai3D',
    kind: 'inline',
  },
  dashscope: {
    base: 'https://dashscope.aliyuncs.com/api/v1',
    defaultModel: 'tripo3d',
    kind: 'task',
  },
};

function parseArgs(argv) {
  const out = {
    input: '',
    output: '',
    provider: 'replicate',
    model: '',
    probe: false,
    timeoutMs: 15 * 60 * 1000,
    pollMs: 4000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') out.input = argv[++i];
    else if (a === '--output') out.output = argv[++i];
    else if (a === '--provider') out.provider = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--probe') out.probe = true;
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
  }
  if (!out.probe && (!out.input || !out.output)) {
    console.error('usage: --input <png> --output <glb> [--provider p] [--model m] | --probe');
    process.exit(2);
  }
  return out;
}

/** Resolve the data home the same way the runtime does (no cwd-relative paths). */
function resolveDataHome() {
  const env = process.env.KHY_DATA_HOME || process.env.KHY_OS_DIR;
  const candidates = [];
  if (env) candidates.push(path.join(env, 'works', 'data', 'khy'));
  candidates.push(path.join(REPO, 'works', 'data', 'khy'));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'api_keys.json'))) return dir;
  }
  return candidates[candidates.length - 1];
}

/**
 * Read the token for the 3D service.
 * Order: explicit env var -> key pool `realtime3d` entry -> provider-named entry.
 * The key pool is gitignored, so nothing here ever reaches the repo.
 */
function resolveToken(provider) {
  const envNames = ['KHY_3D_API_KEY', 'REPLICATE_API_TOKEN', 'SILICONFLOW_API_KEY', 'DASHSCOPE_API_KEY'];
  for (const name of envNames) {
    const v = process.env[name];
    if (v && String(v).trim()) return { token: String(v).trim(), source: `env:${name}` };
  }
  const poolPath = path.join(resolveDataHome(), 'api_keys.json');
  if (!fs.existsSync(poolPath)) return { token: '', source: '' };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
  } catch {
    return { token: '', source: '' };
  }
  const order = ['realtime3d', provider, 'realtime-3d'];
  for (const name of order) {
    const raw = doc[name];
    if (!raw) continue;
    // The pool file accepts both shapes: an array of entries, or a single
    // entry object. Normalize to a list before reading.
    const entries = Array.isArray(raw) ? raw : typeof raw === 'object' ? [raw] : [];
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue;
      if (e.disabled) continue;
      const value = e.key || e.token || e.apiKey || e.api_key || '';
      const text = String(value).trim();
      if (!text || text === '(endpoint-only)') continue;
      return { token: text, source: `pool:${name}` };
    }
  }
  return { token: '', source: '' };
}

async function postJson(url, body, headers, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON error body */
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, headers, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the GLB URL out of whatever shape the provider returned. */
function findGlbUrl(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return /\.glb(\?|$)/i.test(payload) ? payload : '';
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findGlbUrl(item);
      if (found) return found;
    }
    return '';
  }
  if (typeof payload === 'object') {
    for (const key of ['output', 'model_mesh', 'mesh', 'file', 'url', 'glb', 'data']) {
      if (key in payload) {
        const found = findGlbUrl(payload[key]);
        if (found) return found;
      }
    }
  }
  return '';
}

async function download(url, dest, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function runReplicate(cfg, token, inputB64) {
  const headers = { Authorization: `Bearer ${token}` };
  // Replicate has two prediction endpoints. The model-scoped one
  // (POST /v1/models/{owner}/{name}/predictions) tracks the latest version
  // automatically, so no version id has to be pinned here - pinning a stale
  // id is how this script would silently rot.
  const modelPath = String(cfg.model || '').replace(/^https?:\/\/[^/]+\//, '');
  const url = modelPath.includes('/')
    ? `${cfg.base}/models/${modelPath}/predictions`
    : `${cfg.base}/predictions`;
  const body = modelPath.includes('/')
    ? { input: { image: `data:image/png;base64,${inputB64}` } }
    : { version: cfg.model, input: { image: `data:image/png;base64,${inputB64}` } };
  const create = await postJson(url, body, headers, 120000);
  if (create.status >= 400) {
    throw new Error(`replicate create HTTP ${create.status}: ${String(create.text).slice(0, 300)}`);
  }
  const id = create.json && (create.json.id || (create.json.urls && create.json.urls.get));
  if (!id) throw new Error('replicate: no prediction id in response');
  console.log(`[3d] replicate prediction ${id}`);

  const deadline = Date.now() + cfg.timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, cfg.pollMs));
    const poll = await getJson(`${cfg.base}/predictions/${id}`, headers, 60000);
    const status = (poll.json && poll.json.status) || '';
    if (status !== lastStatus) {
      console.log(`[3d] status: ${status || 'unknown'}`);
      lastStatus = status;
    }
    if (status === 'succeeded') {
      const url = findGlbUrl(poll.json.output);
      if (!url) throw new Error('replicate: succeeded but no GLB url in output');
      return url;
    }
    if (status === 'failed' || status === 'canceled') {
      throw new Error(`replicate prediction ${status}: ${String((poll.json && poll.json.error) || '').slice(0, 300)}`);
    }
  }
  throw new Error('replicate: timed out waiting for prediction');
}

async function runInline(cfg, token, inputB64) {
  const headers = { Authorization: `Bearer ${token}` };
  const res = await postJson(
    `${cfg.base}/images/generations`,
    { model: cfg.model, image: `data:image/png;base64,${inputB64}` },
    headers,
    cfg.timeoutMs
  );
  if (res.status >= 400) {
    throw new Error(`HTTP ${res.status}: ${String(res.text).slice(0, 300)}`);
  }
  const url = findGlbUrl(res.json);
  if (!url) throw new Error(`no GLB url in response: ${String(res.text).slice(0, 300)}`);
  return url;
}

async function runTask(cfg, token, inputB64) {
  const headers = { Authorization: `Bearer ${token}` };
  const create = await postJson(
    `${cfg.base}/services/aigc/text-to-3d`,
    { model: cfg.model, input: { image_url: `data:image/png;base64,${inputB64}` } },
    headers,
    120000
  );
  if (create.status >= 400) {
    throw new Error(`HTTP ${create.status}: ${String(create.text).slice(0, 300)}`);
  }
  const taskId = create.json && create.json.output && create.json.output.task_id;
  if (!taskId) throw new Error('no task_id in response');
  console.log(`[3d] dashscope task ${taskId}`);
  const deadline = Date.now() + cfg.timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, cfg.pollMs));
    const poll = await getJson(`${cfg.base}/tasks/${taskId}`, headers, 60000);
    const st = (poll.json && poll.json.output && poll.json.output.task_status) || '';
    console.log(`[3d] task status: ${st}`);
    if (st === 'SUCCEEDED') {
      const url = findGlbUrl(poll.json);
      if (!url) throw new Error('no GLB url in task result');
      return url;
    }
    if (st === 'FAILED' || st === 'CANCELED') {
      throw new Error(`dashscope task ${st}: ${String(poll.text).slice(0, 300)}`);
    }
  }
  throw new Error('dashscope: timed out');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = PROVIDERS[args.provider];
  if (!cfg) {
    console.error(`unknown provider: ${args.provider} (known: ${Object.keys(PROVIDERS).join(', ')})`);
    process.exit(2);
  }
  const { token, source } = resolveToken(args.provider);
  if (!token) {
    console.error(
      `no token for provider "${args.provider}".\n` +
        'Provide one of: KHY_3D_API_KEY / REPLICATE_API_TOKEN / SILICONFLOW_API_KEY / DASHSCOPE_API_KEY\n' +
        `or add it to ${path.join(resolveDataHome(), 'api_keys.json')} under the "realtime3d" provider.`
    );
    process.exit(3);
  }
  console.log(`[3d] provider=${args.provider} model=${args.model || cfg.defaultModel} token=${source}`);

  if (args.probe) {
    const res = await getJson(`${cfg.base}/models`, { Authorization: `Bearer ${token}` }, 30000).catch((e) => ({
      status: 'ERR',
      text: String(e.message),
    }));
    console.log(`[3d] probe ${cfg.base}/models -> ${res.status}`);
    if (res.status === 200 || res.status === 401) {
      console.log(res.status === 200 ? '[3d] token accepted' : '[3d] token rejected (401)');
    }
    return;
  }

  const inputB64 = fs.readFileSync(args.input).toString('base64');
  let url;
  if (cfg.kind === 'prediction') url = await runReplicate(cfg, token, inputB64);
  else if (cfg.kind === 'task') url = await runTask(cfg, token, inputB64);
  else url = await runInline(cfg, token, inputB64);

  const bytes = await download(url, args.output, { Authorization: `Bearer ${token}` });
  console.log(`[3d] wrote ${path.relative(REPO, args.output)} (${bytes} bytes)`);
}

main().catch((e) => {
  console.error('[3d] FAILED:', e && e.message ? e.message : e);
  process.exit(1);
});
