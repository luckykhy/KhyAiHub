// khy-canary: Khy-20261102-264-YT8Z1FMK
// ipc — Key/Endpoint Manager IPC handlers (DESIGN-ARCH-091 §6).
//
// Registered once from main/index.ts. All payloads honor the masking
// invariant: plaintext keys only ever leave via keys:reveal (rate-limited +
// audited). Agent activation (Mode B) writes the local relay token — never a
// real provider key (contract test ⑲).

import type { IpcMain } from 'electron'
import {
  listPool,
  addKey,
  updateKey,
  removeKey,
  toggleKey,
  revealKey,
  importMarkdown,
  resolveRepoRoot,
  loadCcDoc,
  addCard,
  updateCard,
  removeCard,
  listCustomProviders,
  addCustomProvider,
  removeCustomProvider,
  fetchModels,
  validateEndpoint,
  loadPresets,
  keyIdFor,
  listPoolEntriesPlain
} from './keyStore.ts'
import { listAudit, exportAudit, appendAudit } from './audit.ts'
import { applyProxyMode, applyDirectMode, agentMatrix, revertAgent, _auditBackendResolution } from './agentWriters.ts'
import { proxyStatus, startProxy } from './proxyStatus.ts'
import { probeAll, type ProbeTarget } from './health.ts'
import { PROBE_TIMEOUT_MS } from './types.ts'
import {
  listManagedModels,
  addManagedModel,
  updateManagedModel,
  removeManagedModel,
  applyModelToApp,
  probeManagedModel,
  catalogForCard,
  type ModelsAddInput,
  type ModelsUpdateInput,
  type ModelsRemoveInput,
  type ModelsApplyInput,
  type ModelsProbeInput,
  type ModelsCatalogInput
} from './models.ts'
import { resolvePoolKeyForCard, routableModelName } from './keyStore.ts'

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data }
}

function err(error: string, extra?: Record<string, unknown>): { ok: false; error: string } & Record<string, unknown> {
  return { ok: false, error, ...extra }
}

export function registerKeyManagerIpc(ipc: IpcMain, repoRootOverride?: string): void {
  // audit the backend-resolution outcome once (fail-soft, never blocks startup)
  _auditBackendResolution().catch(() => {})
  const repoRoot = () => repoRootOverride || resolveRepoRoot()

  // ── keys (T1 池 CRUD + 导入 + reveal) ─────────────────────────────
  ipc.handle('keys:list', async () => ok(await listPool()))

  ipc.handle('keys:add', async (_e, input: { provider: string; label?: string; endpoint?: string; key?: string; priority?: number }) => {
    const r = await addKey(input || {})
    return r.ok ? ok({ keyId: r.keyId, provider: r.provider }) : err(r.error || 'add failed')
  })

  ipc.handle('keys:update', async (_e, provider: string, keyId: string, patch: Record<string, unknown>) => {
    const r = await updateKey(provider, keyId, (patch || {}) as never)
    return r.ok ? ok({ newKeyId: r.newKeyId, reattachedCards: r.reattachedCards || 0 }) : err(r.error || 'update failed')
  })

  ipc.handle('keys:remove', async (_e, provider: string, keyId: string) => {
    const r = await removeKey(provider, keyId)
    return r.ok ? ok({}) : err(r.error || 'remove failed', { blockedCards: r.blockedCards })
  })

  ipc.handle('keys:toggle', async (_e, provider: string, keyId: string, enabled: boolean) => {
    const r = await toggleKey(provider, keyId, enabled)
    return r.ok ? ok({}) : err(r.error || 'toggle failed')
  })

  ipc.handle('keys:reveal', async (_e, provider: string, keyId: string) => {
    const r = await revealKey(provider, keyId)
    return r.ok ? ok({ key: r.key }) : err(r.error || 'reveal failed')
  })

  // one-click import of docs/opencode-provider-keys.md (spec §9)
  ipc.handle('keys:import', async () => {
    const root = repoRoot()
    if (!root) return err('仓库根未解析：设置 env KHYOS_DESKTOP_REPO_ROOT 后重试')
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    let md = ''
    try {
      md = readFileSync(join(root, 'docs', 'opencode-provider-keys.md'), 'utf-8')
    } catch {
      return err('导入源不存在：docs/opencode-provider-keys.md（动作: 检查文档 目标: docs/）')
    }
    const r = await importMarkdown(md)
    return ok({ added: r.added, skipped: r.skipped })
  })

  // ── custom providers (元数据) ──────────────────────────────────────
  ipc.handle('providers:list', async () => ok(await listCustomProviders()))
  ipc.handle('providers:add', async (_e, p: Record<string, unknown>) => ok(await addCustomProvider(p as never)))
  ipc.handle('providers:remove', async (_e, id: string) => ok(await removeCustomProvider(id)))

  // ── endpoints / models (T2 预设 + 任意模型探测) ──────────────────
  ipc.handle('endpoints:presets', async () => ok(await loadPresets()))
  ipc.handle('endpoints:validate', async (_e, input: { endpoint: string; protocol?: string; key?: string }) =>
    ok(await validateEndpoint(input?.endpoint || '', input?.protocol || 'openai', input?.key || ''))
  )
  ipc.handle('models:fetch', async (_e, input: { endpoint: string; protocol?: string; key?: string }) =>
    ok(await fetchModels(input?.endpoint || '', input?.protocol || 'openai', input?.key || ''))
  )

  // ── cards (无凭据设计) ────────────────────────────────────────────
  ipc.handle('cards:list', async () => {
    const doc = await loadCcDoc()
    return ok({ cards: doc.cards, active: doc.active, agentMode: doc.agentMode || {} })
  })

  ipc.handle('cards:add', async (_e, input: Record<string, unknown>) => {
    const r = await addCard(input as never)
    return r.ok ? ok({ cardId: r.cardId }) : err(r.error || 'card add failed')
  })

  ipc.handle('cards:update', async (_e, cardId: string, patch: Record<string, unknown>) => {
    const r = await updateCard(cardId, patch as never)
    return r.ok ? ok({}) : err(r.error || 'card update failed')
  })

  ipc.handle('cards:remove', async (_e, cardId: string) => {
    const r = await removeCard(cardId)
    return r.ok ? ok({}) : err(r.error || 'card remove failed')
  })

  // ── agents (T3 一键激活) ─────────────────────────────────────────
  ipc.handle('agents:matrix', async () => ok(await agentMatrix()))

  ipc.handle('agents:apply', async (_e, input: { app: string; cardId: string; mode: 'proxy' | 'direct' }) => {
    const app = input?.app || ''
    const cardId = input?.cardId || ''
    const mode: 'proxy' | 'direct' = input?.mode === 'direct' ? 'direct' : 'proxy'
    const doc = await loadCcDoc()
    const card = doc.cards.find((c) => c.id === cardId)
    if (!card) return err('卡片不存在：cardId 已失效（动作: 刷新卡片列表 目标: 端点预设）')
    // proxy 模式给 Claude Code 写「可路由三名」api:<pool>:<model>（与
    // models:apply 同口径）：裸 id 进网关走 builtin-family，可能被 IDE 适配器
    // 级联截走。opencode / qodercli 不读 opts（opts 只被 claude-code 消费），
    // 老路径行为零变化。
    const routableModel =
      mode === 'proxy' && app === 'claude-code'
        ? routableModelName(await resolvePoolKeyForCard(card), card.defaultModel || card.models[0] || '')
        : ''
    const r =
      mode === 'proxy'
        ? await applyProxyMode(app, card, { routableModel })
        : await applyDirectMode(app, card)
    if (!r.ok) return err(r.error || 'apply failed')
    // mode bookkeeping (cc_switch.json agentMode) happens inside the writers
    await appendAudit({ op: 'apply', target: app, detail: `${mode} card=${card.id}` })
    return ok({ detail: r.detail, targetPath: r.targetPath, mode, cardId: card.id })
  })

  ipc.handle('agents:revert', async (_e, app: string) => {
    const r = await revertAgent(app)
    return r.ok ? ok({ detail: r.detail, targetPath: r.targetPath }) : err(r.error || 'revert failed')
  })

  // ── proxy (Mode B 基建状态) ──────────────────────────────────────
  ipc.handle('proxy:status', async () => ok(await proxyStatus()))
  ipc.handle('proxy:start', async () => {
    const r = await startProxy()
    return r.ok ? ok({ detail: r.detail }) : err(r.error || 'proxy start failed')
  })

  // ── models（受管模型列表：Card.models[]/defaultModel 的派生视图）──
  // 通道名一律 models:<action> 全小写（desktopUiContract D6 正则）。
  // 严禁命名为 models:list —— 该名字已被 main/index.ts 的 host 转发（模型
  // 选择器数据）占用，重复注册在 Electron 44.2.0 会抛
  // 'Attempted to register a second handler'。
  ipc.handle('models:managed', async () => ok(await listManagedModels()))

  ipc.handle('models:add', async (_e, input: ModelsAddInput) => {
    const r = await addManagedModel(input || { cardId: '', model: '' })
    return r.ok ? ok({ model: r.model }) : err(r.error || 'model add failed')
  })

  ipc.handle('models:update', async (_e, input: ModelsUpdateInput) => {
    const r = await updateManagedModel(input || { cardId: '', from: '' })
    return r.ok ? ok({ model: r.model, ccWarning: r.ccWarning }) : err(r.error || 'model update failed')
  })

  ipc.handle('models:remove', async (_e, input: ModelsRemoveInput) => {
    const r = await removeManagedModel(input || { cardId: '', model: '' })
    return r.ok
      ? ok({ defaultModelCleared: r.defaultModelCleared, ccWarning: r.ccWarning })
      : err(r.error || 'model remove failed')
  })

  // 返回体只含 detail/targetPath/model/mode —— 不含任何明文 key（脱敏不变式）
  ipc.handle('models:apply', async (_e, input: ModelsApplyInput) => {
    const r = await applyModelToApp(input || { app: 'claude-code', cardId: '', model: '', mode: 'proxy' })
    return r.ok
      ? ok({ detail: r.detail, targetPath: r.targetPath, model: r.model, mode: r.mode })
      : err(r.error || 'model apply failed')
  })

  ipc.handle('models:probe', async (_e, input: ModelsProbeInput) => {
    const r = await probeManagedModel(input || { cardId: '', model: '' })
    return r.ok ? ok(r.data) : err(r.error || 'model probe failed')
  })

  ipc.handle('models:catalog', async (_e, input: ModelsCatalogInput) => {
    const r = await catalogForCard(input || { cardId: '' })
    return r.ok
      ? ok({ verified: r.verified, models: r.models, error: r.error })
      : err(r.error || 'model catalog failed')
  })

  // ── health / audit (T4) ─────────────────────────────────────────
  ipc.handle('health:probe', async (_e, input?: { keyId?: string }) => {
    const plain = await listPoolEntriesPlain()
    let targets: ProbeTarget[] = plain.map((e) => ({
      keyId: keyIdFor(e.provider, e.key),
      provider: e.provider,
      endpoint: e.endpoint,
      key: e.key,
      protocol: 'openai'
    }))
    if (input?.keyId) targets = targets.filter((t) => t.keyId === input.keyId)
    const results = await probeAll(targets)
    // strip plaintext keys out of the IPC payload (masking invariant)
    const { maskKey, keyFingerprint } = await import('./keyStore.ts')
    return ok({
      results: results.map((r) => ({ ...r, detail: `${r.detail} [${r.keyId}]` })),
      fingerprints: Object.fromEntries(targets.map((t) => [t.keyId, keyFingerprint(t.key)])),
      masks: Object.fromEntries(targets.map((t) => [t.keyId, maskKey(t.key)])),
      timeoutMs: PROBE_TIMEOUT_MS
    })
  })

  ipc.handle('health:audit-list', async (_e, limit?: number) => ok(await listAudit(limit || 200)))
  ipc.handle('health:audit-export', async (_e, dest: string) => ok(await exportAudit(dest)))
}

