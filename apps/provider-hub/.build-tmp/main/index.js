import { Tray, nativeImage, Menu, app, BrowserWindow, ipcMain } from "electron";
import { promises, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const CC_SWITCH_FILE = "cc_switch.json";
const API_KEYS_FILE = "api_keys.json";
const AUDIT_FILE = "provider_hub_audit.jsonl";
let _dataHome = null;
function getDataHome() {
  if (_dataHome) return _dataHome;
  const envHome = process.env.KHY_DATA_HOME;
  if (envHome) {
    _dataHome = path.resolve(envHome);
    return _dataHome;
  }
  const portableRoot = process.env.KHY_PORTABLE_ROOT || process.env.KHYQUANT_PORTABLE_ROOT;
  if (portableRoot) {
    _dataHome = path.join(portableRoot, ".khy");
    return _dataHome;
  }
  const explicitRepo = process.env.KHYPHUB_REPO_ROOT;
  if (explicitRepo) {
    _dataHome = path.join(explicitRepo, ".khy");
    return _dataHome;
  }
  const repoRoot = _walkForPortableRoot();
  if (repoRoot) {
    _dataHome = path.join(repoRoot, ".khy");
    return _dataHome;
  }
  _dataHome = path.join(os.homedir(), ".khy");
  return _dataHome;
}
function _walkForPortableRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    try {
      if (existsSync(path.join(dir, ".portable"))) return dir;
    } catch {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
function fileInDataHome(name) {
  return path.join(getDataHome(), name);
}
let _tmpSeq = 0;
async function atomicWriteJson(file, data) {
  const dir = path.dirname(file);
  await promises.mkdir(dir, { recursive: true });
  const tmp = `${dir}/${path.basename(file)}.tmp-${process.pid}-${_tmpSeq++}`;
  await promises.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await promises.rename(tmp, file);
      break;
    } catch (e) {
      const code = e.code;
      if (code !== "EPERM" && code !== "EBUSY") throw e;
      if (attempt === 4) {
        await promises.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
        await promises.unlink(tmp).catch(() => {
        });
      } else {
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
      }
    }
  }
  try {
    await promises.copyFile(file, `${file}.bak`);
  } catch {
  }
}
async function safeReadJson(file, fallback) {
  let raw = null;
  try {
    raw = await promises.readFile(file, "utf-8");
  } catch {
    return { data: fallback, recovered: false };
  }
  try {
    return { data: JSON.parse(raw), recovered: false };
  } catch {
    try {
      const bak = await promises.readFile(`${file}.bak`, "utf-8");
      const parsed = JSON.parse(bak);
      await atomicWriteJson(file, parsed);
      return { data: parsed, recovered: true };
    } catch {
      return { data: fallback, recovered: false };
    }
  }
}
function keyIdFor(provider, key) {
  return createHash("md5").update(`${provider}:${key}`, "utf-8").digest("hex").slice(0, 12);
}
function maskKey(key) {
  if (!key) return "(empty)";
  if (key.length <= 8) return `${key.slice(0, 1)}…${key.slice(-2)}`;
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
function keyFingerprint(key) {
  return createHash("sha256").update(key, "utf-8").digest("hex").slice(0, 8);
}
function emptyDoc() {
  return { schemaVersion: 1, cards: [], active: {}, failover: {}, apps: {} };
}
async function loadCcDoc() {
  const { data, recovered } = await safeReadJson(fileInDataHome(CC_SWITCH_FILE), emptyDoc());
  const doc = {
    schemaVersion: 1,
    cards: Array.isArray(data.cards) ? data.cards : [],
    active: data.active && typeof data.active === "object" ? data.active : {},
    failover: data.failover && typeof data.failover === "object" ? data.failover : {},
    apps: data.apps && typeof data.apps === "object" ? data.apps : {},
    agentMode: data.agentMode && typeof data.agentMode === "object" ? data.agentMode : void 0
  };
  return { doc, recovered };
}
async function saveCcDoc(doc) {
  await atomicWriteJson(fileInDataHome(CC_SWITCH_FILE), doc);
}
async function listCards() {
  const { doc, recovered } = await loadCcDoc();
  const known = new Set(doc.cards.map((c) => c.id));
  const failover = {};
  for (const [app2, ids] of Object.entries(doc.failover || {})) {
    failover[app2] = (Array.isArray(ids) ? ids : []).filter((id) => known.has(id));
  }
  return { cards: doc.cards, active: doc.active, failover, agentMode: doc.agentMode || {}, recovered };
}
async function addCard(input) {
  const name = String(input.name || "").trim();
  const baseUrl = String(input.baseUrl || "").trim();
  if (!name || !baseUrl) return { ok: false, error: "卡片名称与端点必填" };
  const { doc } = await loadCcDoc();
  const dup = doc.cards.find((c) => c.name === name && c.baseUrl === baseUrl);
  if (dup) return { ok: true, cardId: dup.id };
  const id = `c_${createHash("md5").update(`${name}:${baseUrl}:${Date.now()}`).digest("hex").slice(0, 10)}`;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const models = input.models || [];
  doc.cards.push({
    id,
    name,
    baseUrl,
    keyId: input.keyId || "",
    protocol: input.protocol || "openai",
    wireApi: input.wireApi,
    models,
    defaultModel: input.defaultModel || models[0] || "",
    apps: input.apps || [],
    enabled: true,
    createdAt: now,
    updatedAt: now
  });
  await saveCcDoc(doc);
  await appendAudit({ op: "add", target: `card:${id}` });
  return { ok: true, cardId: id };
}
async function updateCard(cardId, patch) {
  const { doc } = await loadCcDoc();
  const card = doc.cards.find((c) => c.id === cardId);
  if (!card) return { ok: false, error: "卡片不存在" };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== void 0) card[k] = v;
  }
  card.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  await saveCcDoc(doc);
  await appendAudit({ op: "update", target: `card:${cardId}` });
  return { ok: true };
}
async function duplicateCard(cardId) {
  const { doc } = await loadCcDoc();
  const src = doc.cards.find((c) => c.id === cardId);
  if (!src) return { ok: false, error: "卡片不存在" };
  const id = `c_${createHash("md5").update(`${src.name}:${src.baseUrl}:dup:${Date.now()}`).digest("hex").slice(0, 10)}`;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  doc.cards.push({
    ...src,
    id,
    name: `${src.name}-copy`,
    enabled: false,
    createdAt: now,
    updatedAt: now
  });
  await saveCcDoc(doc);
  await appendAudit({ op: "duplicate", target: `card:${id}`, detail: `from ${cardId}` });
  return { ok: true, cardId: id };
}
async function removeCard(cardId) {
  const { doc } = await loadCcDoc();
  const idx = doc.cards.findIndex((c) => c.id === cardId);
  if (idx < 0) return { ok: false, error: "卡片不存在" };
  const activeApps = Object.entries(doc.active).filter(([, id]) => id === cardId).map(([app2]) => app2);
  for (const [app2, m] of Object.entries(doc.agentMode || {})) {
    if (m?.cardId === cardId && !activeApps.includes(app2)) activeApps.push(app2);
  }
  if (activeApps.length > 0) {
    return {
      ok: false,
      activeApps,
      error: `该卡正被 ${activeApps.join(" / ")} 激活，先切换到其它卡片再删除`
    };
  }
  doc.cards.splice(idx, 1);
  await saveCcDoc(doc);
  await appendAudit({ op: "remove", target: `card:${cardId}` });
  return { ok: true };
}
async function reorderCards(cardId, toIndex) {
  const { doc } = await loadCcDoc();
  const from = doc.cards.findIndex((c) => c.id === cardId);
  if (from < 0) return { ok: false, error: "卡片不存在" };
  const [card] = doc.cards.splice(from, 1);
  const clamped = Math.max(0, Math.min(toIndex, doc.cards.length));
  doc.cards.splice(clamped, 0, card);
  await saveCcDoc(doc);
  return { ok: true };
}
async function setActive(app2, cardId) {
  const { doc } = await loadCcDoc();
  if (!doc.cards.some((c) => c.id === cardId)) return { ok: false, error: "卡片不存在" };
  doc.active[app2] = cardId;
  await saveCcDoc(doc);
  await appendAudit({ op: "activate", target: app2, detail: cardId });
  return { ok: true };
}
async function clearActive(app2) {
  const { doc } = await loadCcDoc();
  delete doc.active[app2];
  await saveCcDoc(doc);
  return { ok: true };
}
async function setAgentMode(app2, mode, cardId = "") {
  if (!app2) return { ok: false, error: "app 必填" };
  const { doc } = await loadCcDoc();
  doc.agentMode = doc.agentMode || {};
  if (mode == null) {
    delete doc.agentMode[app2];
  } else if (mode !== "proxy" && mode !== "direct") {
    return { ok: false, error: `未知模式: ${mode}（应为 proxy 或 direct）` };
  } else {
    doc.agentMode[app2] = { mode, cardId: cardId || "", ts: (/* @__PURE__ */ new Date()).toISOString() };
  }
  await saveCcDoc(doc);
  await appendAudit({ op: "agent-mode", target: app2, detail: mode });
  return { ok: true };
}
async function setFailover(app2, cardIds) {
  const { doc } = await loadCcDoc();
  const known = new Set(doc.cards.map((c) => c.id));
  doc.failover = doc.failover || {};
  doc.failover[app2] = (Array.isArray(cardIds) ? cardIds : []).filter((id) => known.has(id));
  await saveCcDoc(doc);
  await appendAudit({ op: "failover-set", target: app2, detail: `${doc.failover[app2].length} 张备卡` });
  return { ok: true };
}
async function rotateFailover(app2) {
  const { doc } = await loadCcDoc();
  const known = new Set(doc.cards.map((c) => c.id));
  const queue = ((doc.failover || {})[app2] || []).filter((id) => known.has(id));
  const activeId = doc.active[app2] || "";
  if (queue.length === 0) {
    const error = activeId ? `无备用卡片：该工具未设置 failover 队列（动作: setFailover 添加备卡 目标: ${app2}）` : `未激活且无备用卡片：${app2} 没有可轮换的卡片`;
    return { ok: false, error };
  }
  const promoted = queue[0];
  queue.shift();
  if (activeId) queue.push(activeId);
  doc.failover = doc.failover || {};
  doc.failover[app2] = queue;
  doc.active[app2] = promoted;
  await saveCcDoc(doc);
  await appendAudit({ op: "failover-rotate", target: app2, detail: `${activeId || "(none)"} → ${promoted}` });
  return { ok: true, promoted, retired: activeId };
}
async function loadPool() {
  const { data } = await safeReadJson(fileInDataHome(API_KEYS_FILE), {});
  return data && typeof data === "object" ? data : {};
}
async function listPoolMasked() {
  const doc = await loadPool();
  const providers2 = [];
  for (const [provider, entries] of Object.entries(doc)) {
    const keys = (entries || []).map((e) => ({
      keyId: keyIdFor(provider, e.key),
      label: e.label || "",
      endpoint: e.endpoint || "",
      mask: maskKey(e.key),
      fingerprint: keyFingerprint(e.key)
    }));
    providers2.push({ id: provider, keys });
  }
  return { providers: providers2 };
}
async function addKey(input) {
  const provider = String(input.provider || "").trim().toLowerCase();
  const key = String(input.key || "").trim();
  if (!provider || !key) return { ok: false, error: "provider 与 key 必填" };
  const doc = await loadPool();
  const entries = Array.isArray(doc[provider]) ? doc[provider] : [];
  const dup = entries.find((e) => e.key === key);
  if (dup) {
    dup.endpoint = input.endpoint || dup.endpoint;
    dup.label = input.label || dup.label;
  } else {
    entries.push({
      key,
      endpoint: input.endpoint || "",
      label: input.label || provider,
      priority: input.priority ?? 0,
      id: keyIdFor(provider, key)
    });
  }
  doc[provider] = entries;
  await atomicWriteJson(fileInDataHome(API_KEYS_FILE), doc);
  await appendAudit({ op: "add", target: provider, fingerprint: keyFingerprint(key) });
  return { ok: true, keyId: keyIdFor(provider, key), provider };
}
async function appendAudit(event) {
  try {
    const line = `${JSON.stringify({ ...event, ts: (/* @__PURE__ */ new Date()).toISOString() })}
`;
    const file = fileInDataHome(AUDIT_FILE);
    await promises.mkdir(path.dirname(file), { recursive: true });
    await promises.appendFile(file, line, "utf-8");
  } catch {
  }
}
const providers = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  addCard,
  addKey,
  appendAudit,
  atomicWriteJson,
  clearActive,
  duplicateCard,
  getDataHome,
  keyFingerprint,
  keyIdFor,
  listCards,
  listPoolMasked,
  loadCcDoc,
  maskKey,
  removeCard,
  reorderCards,
  rotateFailover,
  safeReadJson,
  setActive,
  setAgentMode,
  setFailover,
  updateCard
}, Symbol.toStringTag, { value: "Module" }));
function normalizeBase(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}
async function fetchModelCatalog(card, opts = {}) {
  const protocol = String(card.protocol || "").toLowerCase();
  const fetchImpl = opts.fetchImpl || ((url2, init) => fetch(url2, init));
  const timeoutMs = opts.timeoutMs ?? 15e3;
  const base = normalizeBase(card.baseUrl);
  const t0 = Date.now();
  if (protocol === "gemini") {
    return {
      ok: true,
      verified: false,
      models: [],
      error: "该协议无公开模型目录，请手工填写模型 id"
    };
  }
  const isAnthropic = protocol === "anthropic";
  const url = isAnthropic ? `${base}/v1/models` : `${base}/v1/models`;
  const headers = {};
  if (isAnthropic) {
    if (card.key) headers["x-api-key"] = card.key;
    headers["anthropic-version"] = "2023-06-01";
  } else if (card.key) {
    headers.authorization = `Bearer ${card.key}`;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: ctrl.signal, headers });
    if (res.status === 401 || res.status === 403) {
      return {
        ok: true,
        verified: false,
        models: [],
        latencyMs: Date.now() - t0,
        error: `鉴权失败 (${res.status})：API key 无效或过期，请运行 khy gateway config 更新密钥或重新填入`
      };
    }
    if (!res.ok) {
      return {
        ok: true,
        verified: false,
        models: [],
        latencyMs: Date.now() - t0,
        error: `模型目录不可用 (${res.status})：上游服务暂不可用，请稍后重试或手工填写模型 id`
      };
    }
    const body = await res.json();
    const models = (body.data || []).map((m) => String(m.id)).filter(Boolean);
    return { ok: true, verified: true, models, latencyMs: Date.now() - t0 };
  } catch (e) {
    const aborted = e?.name === "AbortError" || ctrl.signal.aborted;
    const msg = e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80);
    return {
      ok: true,
      verified: false,
      models: [],
      latencyMs: Date.now() - t0,
      error: aborted ? `端点不可达（空闲 ${timeoutMs}ms 超时）：模型服务未响应，请重试或切换卡片` : `端点不可达 (${msg})：请检查网络/代理设置，或手工填写模型 id`
    };
  } finally {
    clearTimeout(timer);
  }
}
function mergeCatalog(existing, fetched) {
  const out = [...existing || []];
  for (const m of fetched || []) {
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}
function resolveDefault(existingDefault, models) {
  const def = existingDefault || "";
  if (def && models.includes(def)) return def;
  return models[0] || "";
}
async function probeEndpoint(endpoint, protocol, key, timeoutMs = 5e3) {
  const isAnthropic = String(protocol || "").toLowerCase() === "anthropic";
  const base = normalizeBase(endpoint);
  const url = `${base}/v1/models`;
  const headers = {};
  if (key) {
    if (isAnthropic) headers["x-api-key"] = key;
    else headers.authorization = `Bearer ${key}`;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: "GET", signal: ctrl.signal, headers });
    return { reachable: true, status: res.status, latencyMs: Date.now() - t0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80);
    return { reachable: false, latencyMs: Date.now() - t0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
function usageCandidates() {
  const dataHome = process.env.KHY_DATA_HOME;
  if (dataHome) return [path.join(dataHome, "token_usage.json")];
  const out = [];
  const portable = process.env.KHY_PORTABLE_ROOT || process.env.KHYQUANT_PORTABLE_ROOT;
  if (portable) out.push(path.join(portable, ".khyquant", "token_usage.json"));
  out.push(path.join(os.homedir(), ".khyquant", "token_usage.json"));
  return out;
}
function dateKey(d) {
  return d.toISOString().slice(0, 10);
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
async function usageSummary(days = 7) {
  const n = Math.max(1, Math.min(Number(days) || 7, 90));
  let file = "";
  let doc = null;
  for (const cand of usageCandidates()) {
    try {
      const raw = await promises.readFile(cand, "utf-8");
      file = cand;
      doc = JSON.parse(raw);
      break;
    } catch {
      continue;
    }
  }
  if (!doc) {
    return {
      available: false,
      days: [],
      error: "无用量数据：token_usage.json 不存在或未记录（动作: 使用 khy 产生用量后重试 目标: dataHome/.khyquant）"
    };
  }
  const daily = doc.daily && typeof doc.daily === "object" ? doc.daily : {};
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = /* @__PURE__ */ new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const key = dateKey(d);
    const e = daily[key] || {};
    out.push({
      date: key,
      inputTokens: num(e.inputTokens),
      outputTokens: num(e.outputTokens),
      totalTokens: num(e.totalTokens),
      requests: num(e.requests),
      costUSD: num(e.costUSD)
    });
  }
  return { available: true, days: out, source: file };
}
let _root;
let _backend;
let _auditDone = false;
function resolveBackendServicesRoot() {
  if (_root !== void 0) return _root;
  const candidates = [];
  const explicit = process.env.KHY_BACKEND_SERVICES;
  if (explicit) candidates.push(path.resolve(explicit));
  const portable = process.env.KHY_PORTABLE_ROOT || process.env.KHYQUANT_PORTABLE_ROOT;
  if (portable) {
    candidates.push(path.join(portable, "khy-os", "services", "backend", "src", "services"));
    candidates.push(path.join(portable, "services", "backend", "src", "services"));
  }
  const walked = _walkRepoRoot();
  if (walked) candidates.push(path.join(walked, "services", "backend", "src", "services"));
  for (const c of candidates) {
    try {
      if (existsSync(path.join(c, "gateway", "providerPresets.js"))) {
        _root = c;
        return c;
      }
    } catch {
      continue;
    }
  }
  _root = null;
  return null;
}
function _walkRepoRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    try {
      if (existsSync(path.join(dir, ".portable"))) return dir;
    } catch {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, "services", "backend", "src", "services", "gateway", "providerPresets.js"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
function loadBackend() {
  if (_backend !== void 0) return _backend;
  const root = resolveBackendServicesRoot();
  if (!root) return null;
  try {
    const req = createRequire(path.join(root, "noop.js"));
    const aw = req(path.join(root, "domain", "config", "ccSwitch", "appWriters.js"));
    _backend = {
      applyCardToApp: aw.applyCardToApp,
      detectCardInApp: aw.detectCardInApp,
      preflightCardForApp: aw.preflightCardForApp,
      // DESIGN-ARCH-101 §7 步骤 2：代理接入（端点 + 令牌）解析后端 SSoT，
      // 本模块不复制发现逻辑（零硬编码端点）。
      resolveProxyAccess: aw.resolveProxyAccess
    };
  } catch {
    _backend = null;
  }
  return _backend;
}
async function _auditBackendResolution() {
  if (_auditDone) return;
  _auditDone = true;
  const root = resolveBackendServicesRoot();
  if (root) await appendAudit({ op: "backend-resolve-ok", target: root });
  else await appendAudit({ op: "backend-resolve-failed", detail: "use built-in writers" });
}
function _notResolvable(action) {
  return `${action}失败：khy 后端服务未解析（动作: 设置 env KHY_BACKEND_SERVICES 指向 services/backend/src/services，或安装 khy-os 后重试）`;
}
const DEFAULT_TOOLS = [
  "claude-code",
  "codex",
  "opencode",
  "zcode",
  "deepseek",
  "reasonix",
  "openclaw",
  "coze",
  "trae",
  "command-code",
  "ycode",
  "gemini"
];
async function detectToolProviders(apps) {
  const backend = loadBackend();
  if (!backend) return { ok: false, results: [], error: _notResolvable("工具探测") };
  const known = apps && apps.length ? apps : DEFAULT_TOOLS.slice();
  const results = [];
  for (const app2 of known) {
    try {
      const r = backend.detectCardInApp(app2);
      results.push({
        app: app2,
        success: Boolean(r.success),
        providers: Array.isArray(r.providers) ? r.providers : [],
        error: r.error
      });
    } catch (e) {
      results.push({ app: app2, success: false, providers: [], error: String(e.message || e) });
    }
  }
  return { ok: true, results };
}
async function proxyAccess() {
  const backend = loadBackend();
  if (!backend) {
    return { ok: false, running: false, endpoint: "", tokenMasked: "", error: _notResolvable("代理接入解析") };
  }
  try {
    const r = backend.resolveProxyAccess();
    const token = String(r.proxyToken || "");
    return {
      ok: Boolean(r.ok),
      running: Boolean(r.ok),
      endpoint: r.proxyEndpoint || "",
      tokenMasked: token ? `${token.slice(0, 6)}…${token.slice(-4)}` : "",
      error: r.error
    };
  } catch (e) {
    return { ok: false, running: false, endpoint: "", tokenMasked: "", error: String(e.message || e) };
  }
}
async function importFromTool(app2, view) {
  const { addCard: addCard2 } = await Promise.resolve().then(() => providers);
  const name = String(view.name || view.id || app2);
  const baseUrl = String(view.endpoint || "");
  if (!baseUrl) return { ok: false, error: "探测结果缺少端点，无法导入（动作: 检查该工具配置 目标: live config）" };
  const kind = String(view.kind || "");
  let protocol = "openai";
  if (kind === "anthropic") protocol = "anthropic";
  else if (kind === "openai") protocol = "openai";
  else if (kind === "openai-compatible") protocol = "openai";
  else if (kind === "openai_responses") protocol = "openai_responses";
  if (!kind && app2 === "claude-code") protocol = "anthropic";
  const models = Array.isArray(view.models) ? view.models.map(String) : [];
  const r = await addCard2({
    name,
    baseUrl,
    protocol,
    keyId: "",
    models,
    defaultModel: String(view.defaultModel || models[0] || "")
  });
  if (!r.ok) return r;
  await appendAudit({ op: "import", target: `${app2}:${name}`, detail: `card:${r.cardId}` });
  return { ok: true, cardId: r.cardId };
}
async function applyCardToTool(app2, card, opts) {
  const backend = loadBackend();
  if (!backend) return { ok: false, error: _notResolvable("应用卡片到工具") };
  const mode = opts?.mode === "direct" ? "direct" : "proxy";
  try {
    const result = await backend.applyCardToApp(card, app2, {
      key: opts?.key,
      mode,
      store: opts?.store
    });
    if (!result.success) {
      return { ok: false, error: result.error || "应用失败（详见后端 preflight 校验）", mode };
    }
    await appendAudit({ op: "apply", target: app2, detail: `card:${card.id} mode:${mode}` });
    return { ok: true, detail: result.detail, mode };
  } catch (e) {
    return {
      ok: false,
      mode,
      error: `应用失败 (${String(e.message || e).slice(0, 120)})：请检查该工具配置路径后重试`
    };
  }
}
const PROXY_RUNTIME_FILE = "proxy_server_runtime.json";
async function proxyStatus() {
  const envEndpoint = process.env.KHY_PROXY_ENDPOINT;
  if (envEndpoint) {
    return { running: true, endpoint: envEndpoint, port: 0, source: "env" };
  }
  const file = path.join(getDataHome(), PROXY_RUNTIME_FILE);
  try {
    const raw = await promises.readFile(file, "utf-8");
    const doc = JSON.parse(raw);
    const endpoint = doc.endpoint || "";
    const port = Number(doc.port) || 0;
    const fresh = doc.startedAt ? Date.now() - Date.parse(doc.startedAt) < 5 * 6e4 : true;
    return {
      running: Boolean(doc.running) && endpoint !== "" && fresh,
      endpoint,
      port,
      pid: doc.pid,
      startedAt: doc.startedAt,
      source: "runtime-file"
    };
  } catch {
    return { running: false, endpoint: "", port: 0, source: "absent" };
  }
}
async function startProxy() {
  const status = await proxyStatus();
  if (status.running) {
    return { ok: true, detail: `网关已在运行（端点 ${status.endpoint || "(env)"}，发现源: ${status.source}）` };
  }
  return {
    ok: false,
    error: "本地网关未运行：请在终端执行 khy gateway manage 启动 khy 后端，或设置 env KHY_PROXY_ENDPOINT 指向已运行网关；provider-hub 只读运行时文件发现端口，不代启服务"
  };
}
function ok(data) {
  return { ok: true, data };
}
function err(error, extra) {
  return { ok: false, error, ...extra };
}
const _revealWindow = /* @__PURE__ */ new Map();
const REVEAL_COOLDOWN_MS = 3e4;
async function revealKey(provider, keyId) {
  const now = Date.now();
  const last = _revealWindow.get(keyId) || 0;
  if (now - last < REVEAL_COOLDOWN_MS) {
    await appendAudit({ op: "reveal-rejected", target: provider, detail: "cooldown" });
    return { ok: false, error: `reveal 冷却中：请 ${Math.ceil((REVEAL_COOLDOWN_MS - (now - last)) / 1e3)}s 后重试` };
  }
  _revealWindow.set(keyId, now);
  try {
    const raw = await promises.readFile(path.join(getDataHome(), "api_keys.json"), "utf-8");
    const doc = JSON.parse(raw);
    for (const [p, entries] of Object.entries(doc)) {
      for (const e of entries || []) {
        if (keyIdFor(p, e.key) === keyId && p === provider) {
          await appendAudit({ op: "reveal", target: provider, fingerprint: keyFingerprint(e.key) });
          return { ok: true, key: e.key };
        }
      }
    }
    return { ok: false, error: "密钥不存在（keyId 已变更或条目被移除）" };
  } catch {
    return { ok: false, error: "密钥池读取失败（动作: 检查 api_keys.json 可读性 目标: dataHome）" };
  }
}
function registerHubIpc(ipc) {
  _auditBackendResolution().catch(() => {
  });
  ipc.handle("cards:list", async () => {
    const r = await listCards();
    return ok({ cards: r.cards, active: r.active, agentMode: r.agentMode, recovered: r.recovered });
  });
  ipc.handle("cards:add", async (_e, input) => {
    const r = await addCard(input || {});
    return r.ok ? ok({ cardId: r.cardId }) : err(r.error || "卡片添加失败");
  });
  ipc.handle("cards:update", async (_e, cardId, patch) => {
    const r = await updateCard(cardId, patch || {});
    return r.ok ? ok({}) : err(r.error || "卡片更新失败");
  });
  ipc.handle("cards:duplicate", async (_e, cardId) => {
    const r = await duplicateCard(cardId);
    return r.ok ? ok({ cardId: r.cardId }) : err(r.error || "卡片复制失败");
  });
  ipc.handle("cards:remove", async (_e, cardId) => {
    const r = await removeCard(cardId);
    return r.ok ? ok({}) : err(r.error || "卡片删除失败", { activeApps: r.activeApps });
  });
  ipc.handle("cards:reorder", async (_e, cardId, toIndex) => {
    const r = await reorderCards(cardId, toIndex);
    return r.ok ? ok({}) : err(r.error || "排序失败");
  });
  ipc.handle("cards:set-active", async (_e, app2, cardId) => {
    const r = await setActive(app2, cardId);
    return r.ok ? ok({}) : err(r.error || "激活失败");
  });
  ipc.handle("cards:clear-active", async (_e, app2) => ok(await clearActive(app2)));
  ipc.handle("cards:failover-set", async (_e, app2, cardIds) => {
    const r = await setFailover(app2, cardIds || []);
    return r.ok ? ok({}) : err(r.error || "备卡队列设置失败");
  });
  ipc.handle("cards:failover-rotate", async (_e, app2) => {
    const r = await rotateFailover(app2);
    return r.ok ? ok({ promoted: r.promoted, retired: r.retired }) : err(r.error || "轮换失败");
  });
  ipc.handle("keys:list", async () => ok(await listPoolMasked()));
  ipc.handle("keys:add", async (_e, input) => {
    const r = await addKey(input || {});
    return r.ok ? ok({ keyId: r.keyId, provider: r.provider }) : err(r.error || "密钥添加失败");
  });
  ipc.handle("keys:reveal", async (_e, provider, keyId) => {
    const r = await revealKey(provider, keyId);
    return r.ok ? ok({ key: r.key }) : err(r.error || "reveal 失败");
  });
  ipc.handle("models:fetch", async (_e, input) => {
    const { cards } = await listCards();
    const card = cards.find((c) => c.id === input?.cardId);
    if (!card) return err("卡片不存在：cardId 已失效（动作: 刷新卡片列表 目标: cards）");
    const key = await _resolveKey(card);
    const r = await fetchModelCatalog({ protocol: card.protocol, baseUrl: card.baseUrl, key });
    return ok({ ...r, keyMask: key ? maskKey(key) : "", keyFp: key ? keyFingerprint(key) : "" });
  });
  ipc.handle("models:apply", async (_e, input) => {
    const { cards } = await listCards();
    const card = cards.find((c) => c.id === input?.cardId);
    if (!card) return err("卡片不存在");
    const models = mergeCatalog(card.models, input?.models || []);
    const defaultModel = resolveDefault(card.defaultModel, models);
    const r = await updateCard(card.id, { models, defaultModel });
    return r.ok ? ok({ models, defaultModel }) : err(r.error || "模型保存失败");
  });
  ipc.handle("tools:matrix", async () => ok(await detectToolProviders()));
  ipc.handle("tools:detect", async (_e, apps) => ok(await detectToolProviders(apps)));
  ipc.handle("tools:import", async (_e, input) => {
    const r = await importFromTool(input?.app || "", input?.provider || {});
    return r.ok ? ok({ cardId: r.cardId }) : err(r.error || "导入失败");
  });
  ipc.handle("tools:apply", async (_e, input) => {
    const { cards } = await listCards();
    const card = cards.find((c) => c.id === input?.cardId);
    if (!card) return err("卡片不存在：cardId 已失效（动作: 刷新卡片列表 目标: cards）");
    const mode = input?.mode === "direct" ? "direct" : "proxy";
    if (mode === "proxy") {
      const access = await proxyAccess();
      if (!access.ok) return err(access.error || "代理未运行：无法写入代理模式配置");
    }
    const key = await _resolveKey(card);
    const r = await applyCardToTool(input?.app || "", card, { key, mode });
    if (r.ok) {
      await setAgentMode(input?.app || "", mode, card.id);
    }
    return r.ok ? ok({ detail: r.detail, mode: r.mode }) : err(r.error || "应用失败");
  });
  ipc.handle("proxy:status", async () => ok(await proxyStatus()));
  ipc.handle("proxy:access", async () => {
    const r = await proxyAccess();
    return r.ok ? ok({ endpoint: r.endpoint, tokenMasked: r.tokenMasked }) : err(r.error || "代理接入解析失败", { endpoint: r.endpoint, tokenMasked: r.tokenMasked });
  });
  ipc.handle("proxy:start", async () => {
    const r = await startProxy();
    return r.ok ? ok({ detail: r.detail }) : err(r.error || "网关启动失败");
  });
  ipc.handle("health:probe", async (_e, input) => {
    const { cards } = await listCards();
    const card = cards.find((c) => c.id === input?.cardId);
    if (!card) return err("卡片不存在");
    const key = await _resolveKey(card);
    const r = await probeEndpoint(card.baseUrl, card.protocol, key);
    if (!r.reachable) {
      r.hint = "端点不可达：若该卡是激活卡，可执行 failover 轮换到下一备卡";
    }
    return ok({ ...r, keyMask: key ? maskKey(key) : "" });
  });
  ipc.handle("usage:summary", async (_e, days) => ok(await usageSummary(days)));
}
async function _resolveKey(card) {
  if (!card.keyId) return "";
  try {
    const raw = await promises.readFile(path.join(getDataHome(), "api_keys.json"), "utf-8");
    const doc = JSON.parse(raw);
    for (const [provider, entries] of Object.entries(doc)) {
      for (const e of entries || []) {
        if (keyIdFor(provider, e.key) === card.keyId) return e.key;
      }
    }
  } catch {
  }
  return "";
}
const TOOLS = ["claude-code", "opencode", "zcode", "codex", "command-code", "ycode"];
function buildIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const onBorder = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      buf[i] = onBorder ? 79 : 28;
      buf[i + 1] = onBorder ? 140 : 32;
      buf[i + 2] = onBorder ? 255 : 41;
      buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}
async function setupTray() {
  let tray;
  try {
    tray = new Tray(buildIcon());
  } catch {
    return null;
  }
  tray.setToolTip("KhyOS Provider Hub");
  await rebuildTrayMenu(tray);
  return tray;
}
async function rebuildTrayMenu(tray) {
  const { cards, active, failover } = await listCards();
  const items = [];
  for (const tool of TOOLS) {
    const activeId = active[tool] || "";
    const activeName = cards.find((c) => c.id === activeId)?.name || "";
    const cardItems = cards.map((card) => ({
      label: card.name,
      type: "checkbox",
      checked: activeId === card.id,
      click: async () => {
        if (activeId === card.id) await clearActive(tool);
        else await setActive(tool, card.id);
        await rebuildTrayMenu(tray);
      }
    }));
    const queue = failover[tool] || [];
    const rotateItem = {
      label: `failover 轮换（${queue.length} 张备卡）`,
      enabled: queue.length > 0,
      click: async () => {
        await rotateFailover(tool);
        await rebuildTrayMenu(tray);
      }
    };
    items.push({
      label: `${tool}${activeId ? ` · ${activeName || activeId}` : " · (未激活)"}`,
      submenu: [...cardItems, { type: "separator" }, rotateItem]
    });
  }
  tray.setContextMenu(Menu.buildFromTemplate(items));
}
const DEV_RENDERER = process.env.KHYPHUB_DEV_RENDERER === "1";
function preloadPath() {
  const base = path.join(__dirname, "../preload/index");
  if (existsSync(`${base}.js`)) return `${base}.js`;
  if (existsSync(`${base}.cjs`)) return `${base}.cjs`;
  if (existsSync(`${base}.mjs`)) return `${base}.mjs`;
  return `${base}.js`;
}
function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    title: "KhyOS Provider Hub",
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (DEV_RENDERER) {
    win.loadFile(path.join(__dirname, "../../src/renderer/index.html"));
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  return win;
}
app.whenReady().then(() => {
  registerHubIpc(ipcMain);
  const win = createWindow();
  setupTray().catch(() => {
  });
  if (process.env.KHYPHUB_SMOKE === "1") {
    const failTimer = setTimeout(() => {
      console.error("SMOKE FAIL: 窗口 15s 内未完成加载");
      app.exit(1);
    }, 15e3);
    win.webContents.on("did-finish-load", () => {
      console.log("SMOKE OK: 窗口加载完成（preload + renderer + IPC 注册成功）");
      clearTimeout(failTimer);
      setTimeout(() => app.exit(0), 500);
    });
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
