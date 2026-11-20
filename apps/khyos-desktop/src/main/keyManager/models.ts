// khy-canary: Khy-20261119-318-QK4MZ9TB
// models — managed model list (DESIGN-ARCH-091 §8b extension): a derived view
// over Card.models[]/defaultModel plus add/update/remove/set-default/probe/
// apply-to-Claude-Code.
//
// Reuse, never extend (hard constraints):
//   • No new store file, no CcSwitchDoc/Card schema change — the entry set is a
//     live projection of union(card.models, card.defaultModel); nothing here
//     writes a fourth data file.
//   • All mutations go through the existing updateCard patch whitelist
//     (models/defaultModel are already in it) — that is how the "UI-less dead
//     fields" get activated.
//   • Proxy-mode activation writes the ROUTABLE THREE-PART name
//     api:<poolKey>:<model> (keyStore.routableModelName, a desktop-side mirror
//     of backend proxyAccess.js): a bare id entering the gateway takes the
//     builtin-family branch and can be stolen by an IDE adapter cascade — see
//     the comment in agentWriters.applyProxyMode.
//   • The renderer never touches a plaintext key: catalog resolves the pool
//     entry by cardId in main; apply/probe payloads carry only
//     detail/targetPath/model/mode (masking invariant direction).

import {
  loadCcDoc,
  updateCard,
  resolvePoolKeyForCard,
  routableModelName,
  listPoolEntriesPlain,
  keyIdFor,
  fetchModels
} from './keyStore.ts'
import { applyProxyMode, applyDirectMode, agentTargetPath } from './agentWriters.ts'
import { proxyStatus, readProxyToken } from './proxyStatus.ts'
import { appendAudit } from './audit.ts'
import { PROBE_TIMEOUT_MS } from './types.ts'
import { readFileSync } from 'node:fs'
import type { Card, CcSwitchDoc } from './types.ts'

// ── payload contracts (mirrored verbatim in renderer/keyManager/api.ts) ─────

export interface ManagedModel {
  /** stable key `${cardId}::${model}` — model ids are unique per card, so no
   * second id store is introduced */
  id: string
  cardId: string
  cardName: string
  /** card protocol (Card.protocol) */
  protocol: Card['protocol']
  /** upstream wire model id, e.g. gpt-4o-mini */
  model: string
  /** routable three-part name api:<poolKey>:<model> — the name Claude Code
   * actually receives */
  routableName: string
  /** whether card.defaultModel points at this entry */
  isDefault: boolean
  /** card key reference (Card.keyId — a pointer, not a credential; the renderer
   * only ever displays the first 8 chars) */
  keyId: string
  /** card endpoint (Card.baseUrl) */
  baseUrl: string
  /** Claude Code active state: agentMode['claude-code'].cardId===cardId AND
   * that card's defaultModel===model */
  ccActive: boolean
}

export interface ManagedModelsResult {
  models: ManagedModel[]
  cc: {
    mode: 'none' | 'proxy' | 'direct'
    cardId: string
    cardName: string
    model: string
    routableName: string
    lastApplied: string
  }
}

export interface ModelsAddInput {
  cardId: string
  model: string
  makeDefault?: boolean
}

export interface ModelsUpdateInput {
  cardId: string
  from: string
  to?: string
  makeDefault?: boolean
}

export interface ModelsRemoveInput {
  cardId: string
  model: string
}

export interface ModelsApplyInput {
  app: 'claude-code'
  cardId: string
  model: string
  mode: 'proxy' | 'direct'
}

export interface ModelsProbeInput {
  cardId: string
  model: string
}

export interface ModelsProbeResult {
  status: 'ok' | 'auth' | 'rate' | 'upstream' | 'timeout'
  latencyMs: number
  detail: string
  sample?: string
}

export interface ModelsCatalogInput {
  cardId: string
}

export interface ModelsCatalogResult {
  verified: boolean
  models: string[]
  error?: string
}

// main-side operation results (never cross IPC as-is; ipc.ts maps them onto
// the { ok, data } / { ok, error } envelope)
export interface AddModelResult {
  ok: boolean
  error?: string
  model?: ManagedModel
}

export interface UpdateModelResult {
  ok: boolean
  error?: string
  model?: ManagedModel
  ccWarning?: string
}

export interface RemoveModelResult {
  ok: boolean
  error?: string
  defaultModelCleared?: boolean
  ccWarning?: string
}

export interface ApplyModelResult {
  ok: boolean
  error?: string
  detail?: string
  targetPath?: string
  model?: string
  mode?: 'proxy' | 'direct'
}

export interface ProbeModelResult {
  ok: boolean
  error?: string
  data?: ModelsProbeResult
}

export interface CatalogModelResult {
  ok: boolean
  error?: string
  verified?: boolean
  models?: string[]
}

// ── shared internals ─────────────────────────────────────────────────────────

const ERR_CARD_MISSING = '卡片不存在：cardId 已失效（动作: 刷新卡片列表 目标: 端点与密钥管理）'
const ERR_MODEL_NOT_IN_CARD = '模型 id 不属于该卡片：请先加入受管模型'
const CC_WARNING_RENAMED = 'Claude Code 正在使用该模型：设置文件里仍是旧名，重新应用后生效'
const CC_WARNING_REMOVED = 'Claude Code 正在使用该模型：重新应用后生效'
// Neutral 401/403 wording: the gateway enforces the relay token itself, so a
// relay mismatch also lands here. Reusing health.ts' "update the key in the
// Provider page" would point the user at the wrong fix (RUNTIME-002).
const PROBE_AUTH_DETAIL =
  '鉴权失败 (401)：本地网关 relay 令牌或上游提供商密钥无效（动作: 重启本地网关 或 在密钥与端点管理更新 Provider 密钥）'

type AgentModeEntry = NonNullable<CcSwitchDoc['agentMode']>[string]

// ── poolKey 下限校验（P1：回退路径不许静默退化）────────────────────────────
//
// 三名 `api:<poolKey>:<model>` 的池段必须匹配网关三段式正则 /^[a-z0-9_-]+$/
// （constants.js:84-94 记了这个坑：池段含冒号会被截断、模型 id 被污染）。
// poolKey 为空（池扫不到 + 卡片名 slug 也空，如纯非 ASCII 卡片名）或非法时，
// routableModelName 会**原样退回裸 id** —— 而那正是本模块要避免的
// builtin-family 级联坑（裸 id 进网关 → strict:false → preferredAdapter 被清
// → 掉进级联，可能被 IDE 适配器截走）。
// 所以：凡是要把名字写出/发出去了的路径（apply / probe），一律先校验，
// 不合格就诚实拒绝，不硬拼一个会静默退化的名字。
// 只改卡片数据的路径（add/update/remove）不拦 —— 录条目不该被池解析堵死，
// 那边的 routableName 仅作展示，真相由本函数在 apply/probe 处把着。
const POOL_KEY_RE = /^[a-z0-9_-]+$/

function poolKeyRejectReason(poolKey: string): string | null {
  const pk = String(poolKey || '').trim()
  if (!pk) {
    return '解不出该卡片的密钥池名（poolKey 为空）：请在密钥与端点管理为该卡片绑定 Provider 密钥后重试（动作: 绑定密钥 目标: 端点与密钥管理）'
  }
  if (!POOL_KEY_RE.test(pk)) {
    return `密钥池名非法（${pk}）：网关三名只认 [a-z0-9_-]，请把卡片/provider 名改成字母数字（动作: 改名 目标: 端点与密钥管理）`
  }
  return null
}

// Hand-built cards may lack models (cc_switch.json has no schema validator):
// normalize on the read side so one malformed entry cannot break the page.
function cardModels(card: Card): string[] {
  return Array.isArray(card.models) ? card.models : []
}

function buildEntry(
  card: Card,
  model: string,
  poolKey: string,
  am: AgentModeEntry | undefined
): ManagedModel {
  return {
    id: `${card.id}::${model}`,
    cardId: card.id,
    cardName: card.name,
    protocol: card.protocol,
    model,
    routableName: routableModelName(poolKey, model),
    isDefault: model === card.defaultModel,
    keyId: card.keyId,
    baseUrl: card.baseUrl,
    ccActive: Boolean(am && am.cardId === card.id && card.defaultModel === model)
  }
}

// ── 1. list (the single data source; nothing is persisted) ──────────────────

// Claude Code **实际在用的**模型名：读 settings.json 的 env.ANTHROPIC_MODEL，
// 而不是从 card.defaultModel 推。
//
// 为什么必须读回来：apply 时才写 env.ANTHROPIC_MODEL（agentWriters.ts:211），
// 用户「应用到模型 A → 把 A 改名成 B 或把卡片默认改成 B 但不重新应用」之后，
// 卡片默认已经是 B 而文件里仍是 api:<pool>:A。按卡片默认显示会让页面显示
// 「正在用 B」而 Claude Code 实际发的是 A —— 违状态透明原则（proxyStatus.ts
// 头部的 truthful state 约定）。读不到（文件缺失 / 无 env 块 / 非字符串）时
// 返回空串，由调用方回落到卡片默认。
// 只读一个字段，不做任何写；文件不存在是正常态（从未激活过）。
function readCcActiveModel(): string {
  try {
    const doc = JSON.parse(readFileSync(agentTargetPath('claude-code'), 'utf-8')) as {
      env?: Record<string, unknown>
    }
    const v = doc?.env?.ANTHROPIC_MODEL
    return typeof v === 'string' ? v.trim() : ''
  } catch {
    return ''
  }
}

export async function listManagedModels(): Promise<ManagedModelsResult> {
  const doc = await loadCcDoc()
  const am = doc.agentMode?.['claude-code']
  const out: ManagedModel[] = []
  for (const card of doc.cards) {
    const poolKey = await resolvePoolKeyForCard(card)
    // UNION, not just models[]: a hand-built card may have models=[] with a
    // non-empty defaultModel (or the reverse) — deriving from one side only
    // would make such a card invisible here and disagree with its real default.
    const entries = [...new Set([...cardModels(card), ...(card.defaultModel ? [card.defaultModel] : [])])]
    for (const model of entries) out.push(buildEntry(card, model, poolKey, am))
  }
  out.sort((a, b) => a.cardName.localeCompare(b.cardName) || a.model.localeCompare(b.model))
  const ccCard = am ? doc.cards.find((c) => c.id === am.cardId) : undefined
  // cc.model 取 settings.json 的实际值（读不到才回落卡片默认）——见
  // readCcActiveModel 的说明。ccActive 仍按 agentMode 判（那是「本工具激活过」
  // 的记录），两者分工：mode 记「有没有激活过」，model 记「此刻实际写的是什么」。
  const ccFileModel = am ? readCcActiveModel() : ''
  const ccModel = ccFileModel || (ccCard ? ccCard.defaultModel || cardModels(ccCard)[0] || '' : '')
  const ccPoolKey = ccCard ? await resolvePoolKeyForCard(ccCard) : ''
  return {
    models: out,
    cc: {
      mode: am ? am.mode : 'none',
      cardId: am ? am.cardId : '',
      cardName: ccCard ? ccCard.name : '',
      model: ccModel,
      routableName: am && ccCard ? routableModelName(ccPoolKey, ccModel) : '',
      lastApplied: am ? am.ts : ''
    }
  }
}

// ── 2. add ──────────────────────────────────────────────────────────────────

export async function addManagedModel(input: ModelsAddInput): Promise<AddModelResult> {
  const doc = await loadCcDoc()
  const card = doc.cards.find((c) => c.id === input?.cardId)
  if (!card) return { ok: false, error: ERR_CARD_MISSING }
  const model = String(input?.model || '').trim()
  if (!model) {
    return { ok: false, error: '模型 id 去空白后为空：请填写上游线格式的模型 id（如 gpt-4o-mini）' }
  }
  const exists = cardModels(card).includes(model)
  // Duplicate id: only a makeDefault request turns this into a set-default.
  if (exists && input?.makeDefault !== true) {
    return { ok: false, error: '该卡片已存在同 id 模型（勾选「设为默认」可把现有模型设为卡片默认）' }
  }
  const patch: { models?: string[]; defaultModel?: string } = {}
  if (!exists) patch.models = [...cardModels(card), model]
  // "models without a default" is a broken intermediate state: when the card
  // had no default, this model becomes the default regardless of makeDefault.
  if (input?.makeDefault === true || !card.defaultModel) patch.defaultModel = model
  const r = await updateCard(card.id, patch)
  if (!r.ok) return { ok: false, error: r.error || '模型加入失败' }
  const after = await loadCcDoc()
  const next = after.cards.find((c) => c.id === card.id) || card
  const poolKey = await resolvePoolKeyForCard(next)
  await appendAudit({ op: 'model-add', target: `model:${card.id}`, detail: model })
  return { ok: true, model: buildEntry(next, model, poolKey, after.agentMode?.['claude-code']) }
}

// ── 3. update (rename id / set default) ─────────────────────────────────────

export async function updateManagedModel(input: ModelsUpdateInput): Promise<UpdateModelResult> {
  const doc = await loadCcDoc()
  const card = doc.cards.find((c) => c.id === input?.cardId)
  if (!card) return { ok: false, error: ERR_CARD_MISSING }
  const from = String(input?.from || '').trim()
  const to = input?.to === undefined ? '' : String(input.to || '').trim()
  const makeDefault = input?.makeDefault === true
  if (!to && !makeDefault) {
    return { ok: false, error: '未指定修改内容：请填写新的模型 id 或勾选「设为默认」' }
  }
  if (!cardModels(card).includes(from) && card.defaultModel !== from) {
    return { ok: false, error: ERR_MODEL_NOT_IN_CARD }
  }
  const finalModel = to || from
  if (to && to !== from && (cardModels(card).includes(to) || card.defaultModel === to)) {
    return { ok: false, error: '目标模型 id 在该卡片已存在：请换一个模型 id' }
  }
  const patch: { models?: string[]; defaultModel?: string } = {}
  if (to && to !== from) {
    patch.models = cardModels(card).map((m) => (m === from ? to : m))
    // the old name was the default → follow the rename, otherwise the default
    // pointer would dangle at an id that no longer exists
    if (card.defaultModel === from) patch.defaultModel = to
  }
  if (makeDefault) patch.defaultModel = finalModel
  const r = await updateCard(card.id, patch)
  if (!r.ok) return { ok: false, error: r.error || '模型更新失败' }
  const after = await loadCcDoc()
  const next = after.cards.find((c) => c.id === card.id) || card
  const poolKey = await resolvePoolKeyForCard(next)
  const am = after.agentMode?.['claude-code']
  // Renaming/re-defaulting exactly the model Claude Code is running: the
  // settings file still holds the old name. Say so honestly (never silently
  // diverge) without breaking the chain — the gateway still routes the old
  // three-part name.
  const ccWarning =
    am && am.cardId === card.id && card.defaultModel === from ? CC_WARNING_RENAMED : undefined
  await appendAudit({
    op: 'model-update',
    target: `model:${card.id}`,
    detail: to && to !== from ? `${from} → ${to}` : `default=${finalModel}`
  })
  return { ok: true, model: buildEntry(next, finalModel, poolKey, am), ccWarning }
}

// ── 4. remove ───────────────────────────────────────────────────────────────

export async function removeManagedModel(input: ModelsRemoveInput): Promise<RemoveModelResult> {
  const doc = await loadCcDoc()
  const card = doc.cards.find((c) => c.id === input?.cardId)
  if (!card) return { ok: false, error: ERR_CARD_MISSING }
  const model = String(input?.model || '').trim()
  if (!model) return { ok: false, error: '模型 id 为空：请先选中要删除的受管模型' }
  if (!cardModels(card).includes(model) && card.defaultModel !== model) {
    return { ok: false, error: ERR_MODEL_NOT_IN_CARD }
  }
  const wasDefault = card.defaultModel === model
  const nextModels = cardModels(card).filter((m) => m !== model)
  const patch: { models: string[]; defaultModel?: string } = { models: nextModels }
  if (wasDefault) {
    // deleting the default falls back to the remaining models[0] or '' — the
    // caller surfaces defaultModelCleared, nothing happens silently
    patch.defaultModel = nextModels[0] || ''
  }
  const r = await updateCard(card.id, patch)
  if (!r.ok) return { ok: false, error: r.error || '模型删除失败' }
  const am = doc.agentMode?.['claude-code']
  const ccWarning =
    am && am.cardId === card.id && wasDefault ? CC_WARNING_REMOVED : undefined
  await appendAudit({ op: 'model-remove', target: `model:${card.id}`, detail: model })
  return { ok: true, defaultModelCleared: wasDefault, ccWarning }
}

// ── 5. apply to Claude Code (the "replace model" core action) ───────────────

export async function applyModelToApp(input: ModelsApplyInput): Promise<ApplyModelResult> {
  // app narrowed to the 'claude-code' literal: the page only serves Claude
  // Code. opencode activation stays with KeyManagerPage T3 — its khy/ prefix
  // ('khy' is absent from modelRouter's DEFAULT_PREFIX_TO_ADAPTER) would drag
  // the same cascade trap onto this page's users.
  if (input?.app !== 'claude-code') {
    return {
      ok: false,
      error: '模型管理页只服务 Claude Code：opencode/qodercli 请在密钥与端点管理的 Agent 应用页激活'
    }
  }
  const doc = await loadCcDoc()
  const card = doc.cards.find((c) => c.id === input?.cardId)
  if (!card) return { ok: false, error: ERR_CARD_MISSING }
  const model = String(input?.model || '').trim()
  if (!model) return { ok: false, error: '模型 id 为空：请先选中要应用的受管模型' }
  // lower-bound validation: no arbitrary string may become the card default
  // and land in ~/.claude/settings.json
  if (!cardModels(card).includes(model) && card.defaultModel !== model) {
    return { ok: false, error: ERR_MODEL_NOT_IN_CARD }
  }
  const mode: 'proxy' | 'direct' = input?.mode === 'direct' ? 'direct' : 'proxy'
  // b. poolKey → routable three-part name
  const poolKey = await resolvePoolKeyForCard(card)
  // 下限校验：poolKey 空/非法时 routableModelName 会退回裸 id 掉进级联坑，
  // 这里先拒绝（P1：回退路径不许静默退化）。
  const poolKeyBad = poolKeyRejectReason(poolKey)
  if (poolKeyBad) return { ok: false, error: poolKeyBad }
  const routable = routableModelName(poolKey, model)
  // c. the card default stores the BARE id (card data stays clean; the
  // three-part name only ever appears in the Claude Code settings write)
  const upd = await updateCard(card.id, { defaultModel: model })
  if (!upd.ok) return { ok: false, error: upd.error || '写入卡片默认模型失败' }
  // updateCard persisted its own copy of the doc; the local card object's
  // defaultModel is now stale — re-read before handing it to the writer
  // (the direct branch reads card.defaultModel for ANTHROPIC_MODEL).
  const after = await loadCcDoc()
  const live = after.cards.find((c) => c.id === card.id) || card
  // d. direct mode passes NO routableModel: the direct upstream knows bare ids
  const r =
    mode === 'proxy'
      ? await applyProxyMode('claude-code', live, { routableModel: routable })
      : await applyDirectMode('claude-code', live)
  if (!r.ok) return { ok: false, error: r.error || '应用失败' }
  await appendAudit({ op: 'model-apply', target: `claude-code:${card.id}`, detail: `${mode} ${model}` })
  return {
    ok: true,
    detail: r.detail || '',
    targetPath: r.targetPath || '',
    // the name actually written into Claude Code (proxy = three-part, direct = bare)
    model: mode === 'proxy' ? routable : model,
    mode
  }
}

// ── 6. probe (real connectivity: one test request through the gateway) ──────

// Same shape as what Claude Code actually sends after applyProxyMode writes
// ANTHROPIC_AUTH_TOKEN: POST <gateway root>/v1/messages + Bearer relay +
// anthropic-version. The second parameter is the test seam (inject a fake
// fetch); production uses the global fetch.
export type ProbeFetch = (url: string, init?: RequestInit) => Promise<Response>

export async function probeManagedModel(
  input: ModelsProbeInput,
  fetchImpl: ProbeFetch = fetch
): Promise<ProbeModelResult> {
  const doc = await loadCcDoc()
  const card = doc.cards.find((c) => c.id === input?.cardId)
  if (!card) return { ok: false, error: ERR_CARD_MISSING }
  const model = String(input?.model || '').trim()
  if (!model) return { ok: false, error: '模型 id 为空：请先选中要测连通的受管模型' }
  // Proxy liveness goes through proxyStatus() (with its /health handshake) —
  // NOT readProxyRuntime(): a stale runtime file would be misread as running,
  // and the follow-up fetch ECONNREFUSED would surface as status 'upstream' +
  // "network failed" instead of the honest "proxy not running".
  const st = await proxyStatus()
  if (!st.running) return { ok: false, error: st.detail }
  const poolKey = await resolvePoolKeyForCard(card)
  // 与 applyModelToApp 同一条下限：探测发出去的名字也必须是能解出池的三名，
  // 否则 200/401 都是假信号（池 pick 不到会静默退化成直发）。
  const poolKeyBad = poolKeyRejectReason(poolKey)
  if (poolKeyBad) return { ok: false, error: poolKeyBad }
  const routable = routableModelName(poolKey, model)
  const relay = readProxyToken()
  // Same address Claude Code uses: ANTHROPIC_BASE_URL is the gateway root
  // (no /v1); CC appends /v1/messages itself.
  const root = st.endpoint.replace(/\/v1\/?$/, '').replace(/\/+$/, '')
  const t0 = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  let result: ModelsProbeResult
  try {
    const res = await fetchImpl(`${root}/v1/messages`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${relay}`,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: routable,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }]
      })
    })
    const latencyMs = Date.now() - t0
    if (res.status === 401 || res.status === 403) {
      result = { status: 'auth', latencyMs, detail: PROBE_AUTH_DETAIL }
    } else if (res.status === 429) {
      result = { status: 'rate', latencyMs, detail: `限流 (429)：请求过多，稍后重试（模型 ${routable}）` }
    } else if (res.status >= 500) {
      result = {
        status: 'upstream',
        latencyMs,
        detail: `上游异常 (${res.status})：模型服务暂不可用，请稍后重试`
      }
    } else if (res.status >= 200 && res.status < 300) {
      // Proof of "real text came back": the first text block of content,
      // first 40 chars — the essential difference from the /v1/models probe.
      let sample = ''
      try {
        const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }> }
        const block = (body.content || []).find((b) => b.type === 'text' && typeof b.text === 'string')
        sample = String(block?.text || '').slice(0, 40)
      } catch {
        /* streaming / non-JSON body: no sample available, verdict unaffected */
      }
      const okResult: ModelsProbeResult = {
        status: 'ok',
        latencyMs,
        detail: `模型 ${routable} 可用：本地网关响应 ${latencyMs}ms`
      }
      if (sample) okResult.sample = sample
      result = okResult
    } else {
      result = {
        status: 'upstream',
        latencyMs,
        detail: `网关返回 ${res.status}：请求被拒绝，请查看网关日志（动作: 检查日志 目标: 本地网关）`
      }
    }
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    result = {
      status: aborted ? 'timeout' : 'upstream',
      latencyMs: Date.now() - t0,
      detail: aborted
        ? `请求超时（${PROBE_TIMEOUT_MS}ms）：网络或网关响应慢，请稍后重试`
        : `网络连接失败：${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`
    }
  } finally {
    clearTimeout(timer)
  }
  await appendAudit({ op: 'model-probe', target: `model:${card.id}`, detail: `${model} → ${result.status}` })
  return { ok: true, data: result }
}

// ── 7. catalog (pull the endpoint's model directory; renderer sees no key) ──

export async function catalogForCard(input: ModelsCatalogInput): Promise<CatalogModelResult> {
  const doc = await loadCcDoc()
  const card = doc.cards.find((c) => c.id === input?.cardId)
  if (!card) return { ok: false, error: ERR_CARD_MISSING }
  // The renderer never passes a plaintext key (unlike models:fetch): main
  // resolves the pool entry from Card.keyId (a pointer) right here.
  const plain = await listPoolEntriesPlain()
  const entry = card.keyId
    ? plain.find((e) => e.key && keyIdFor(e.provider, e.key) === card.keyId)
    : undefined
  // non-openai protocols: fetchModels answers verified:false + "no public
  // model directory, fill the id in by hand" — passed through verbatim
  const r = await fetchModels(card.baseUrl, card.protocol, entry?.key || '')
  return { ok: true, verified: r.verified, models: r.models, error: r.error }
}
