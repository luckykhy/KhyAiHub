// khy-canary: Khy-20261102-339-R7ZWCS5P
// Typed access to the __KHYOS__ preload surface (KeyManager extension,
// DESIGN-ARCH-091 §6). The preload exposes plain invoke wrappers; this module
// adds the result contracts so renderer code stays type-safe.

export interface MaskedKey {
  keyId: string
  label: string
  endpoint: string
  priority: number
  enabled: boolean
  source: 'pool' | 'env'
  mask: string
  fingerprint: string
}

export interface ProviderView {
  id: string
  keys: MaskedKey[]
}

export interface EnvOverlayView {
  provider: string
  envName: string
  set: boolean
}

export interface Card {
  id: string
  name: string
  baseUrl: string
  keyId: string
  protocol: string
  wireApi?: string
  models: string[]
  defaultModel: string
  apps: string[]
  enabled: boolean
}

export interface Preset {
  id: string
  label: string
  baseUrl: string
  apiFormat: string
  defaultModel: string
  keyField: string
  source: 'backend' | 'builtin-fallback'
}

export interface MatrixRow {
  app: string
  label: string
  writer: string
  mode: 'none' | 'proxy' | 'direct'
  cardId: string
  targetPath: string
  lastApplied: string
  hint: string
}

export interface ProxyState {
  running: boolean
  endpoint: string
  host: string
  port: number | null
  relayFingerprint: string | null
  detail: string
}

// ── models（受管模型列表，DESIGN-ARCH-091 §8b）──────────────────────────────
// 这些契约与 main/keyManager/models.ts 的同名接口逐字对应（该文件顶部注释即
// 要求「mirrored verbatim in renderer/keyManager/api.ts」）：main 侧改形状，
// 这里必须同改，否则渲染层又会退化成 unknown。
// 数据来源是 Card.models[]/defaultModel 的派生视图（不新建存储）。

export interface ManagedModel {
  /** stable key `${cardId}::${model}` */
  id: string
  cardId: string
  cardName: string
  /** card protocol (Card.protocol) */
  protocol: Card['protocol']
  /** upstream wire model id, e.g. gpt-4o-mini */
  model: string
  /** routable three-part name api:<poolKey>:<model> */
  routableName: string
  /** whether card.defaultModel points at this entry */
  isDefault: boolean
  /** card key reference (Card.keyId — a pointer, not a credential) */
  keyId: string
  /** card endpoint (Card.baseUrl) */
  baseUrl: string
  /** Claude Code active state (agentMode['claude-code']) */
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

export interface ModelsProbeResult {
  status: 'ok' | 'auth' | 'rate' | 'upstream' | 'timeout'
  latencyMs: number
  detail: string
  sample?: string
}

export interface ModelsCatalogResult {
  verified: boolean
  models: string[]
  error?: string
}

// 六个 input 载荷：与 main/keyManager/models.ts 的同名接口逐字对应。此前这里
// 只镜像了 4 个 result 类型、input 全部内联在方法签名里 —— 结果「双侧同名类型」
// 清单对不上（main 侧导出 ModelsProbeInput / ModelsCatalogInput，渲染侧没有），
// 按清单落地就会缺导出。现在补齐，方法签名直接引用它们。
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

export interface ModelsCatalogInput {
  cardId: string
}

export interface HealthResult {
  keyId: string
  provider: string
  endpoint: string
  status: string
  detail: string
  latencyMs: number
}

export interface AuditEntry {
  ts: string
  op: string
  target?: string
  fingerprint?: string
  detail?: string
}

export type KhyOsApi = Record<string, (...args: never[]) => Promise<unknown>> & {
  // 窗口控制（preload/index.ts:13/307/310）。这三个此前只靠上面的索引签名兜底：
  // 调用点写 `api.closeWindow()` 能过（0 实参配 never[]），但实参一旦多一个就炸
  // TS2345，且返回值退化成 unknown。显式声明后 ModelsPage 的 ✕ 与「端点与密钥
  // 管理」（独立窗里改开第二个管理窗）才是类型安全的。
  closeWindow(): Promise<unknown>
  openKeyManagerWindow(): Promise<unknown>
  openModelsWindow(): Promise<unknown>
  keysList(): Promise<{ ok: boolean; data?: { providers: ProviderView[]; envOverlay: EnvOverlayView[] }; error?: string }>
  keysAdd(input: { provider: string; label?: string; endpoint?: string; key?: string; priority?: number }): Promise<{
    ok: boolean
    data?: { keyId: string; provider: string }
    error?: string
  }>
  keysUpdate(
    provider: string,
    keyId: string,
    patch: Record<string, unknown>
  ): Promise<{ ok: boolean; data?: { newKeyId: string; reattachedCards: number }; error?: string }>
  keysRemove(provider: string, keyId: string): Promise<{ ok: boolean; error?: string; blockedCards?: string[] }>
  keysToggle(provider: string, keyId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>
  keysReveal(provider: string, keyId: string): Promise<{ ok: boolean; data?: { key: string }; error?: string }>
  keysImport(): Promise<{
    ok: boolean
    data?: { added: number; skipped: { name: string; reason: string }[] }
    error?: string
  }>
  providersList(): Promise<{ ok: boolean; data?: unknown[] }>
  providersAdd(p: Record<string, unknown>): Promise<{ ok: boolean }>
  providersRemove(id: string): Promise<{ ok: boolean }>
  endpointsPresets(): Promise<{ ok: boolean; data?: Preset[]; source?: string }>
  endpointsValidate(input: {
    endpoint: string
    protocol?: string
    key?: string
  }): Promise<{ ok: boolean; data?: { reachable: boolean; status?: number; latencyMs: number; error?: string }; error?: string }>
  modelsFetch(input: {
    endpoint: string
    protocol?: string
    key?: string
  }): Promise<{ ok: boolean; data?: { verified: boolean; models: string[]; error?: string }; error?: string }>
  // models（受管模型列表）。通道名是 models:managed 而非 models:list（后者已被
  // host 转发的模型选择器占用）；catalog 由 main 按 cardId 解析明文 key，
  // 渲染层不传凭据。
  modelsManaged(): Promise<{ ok: boolean; data?: ManagedModelsResult; error?: string }>
  modelsAdd(input: ModelsAddInput): Promise<{ ok: boolean; data?: { model?: ManagedModel }; error?: string }>
  modelsUpdate(input: ModelsUpdateInput): Promise<{ ok: boolean; data?: { model?: ManagedModel; ccWarning?: string }; error?: string }>
  modelsRemove(input: ModelsRemoveInput): Promise<{ ok: boolean; data?: { defaultModelCleared?: boolean; ccWarning?: string }; error?: string }>
  modelsApply(input: ModelsApplyInput): Promise<{
    ok: boolean
    data?: { detail?: string; targetPath?: string; model?: string; mode?: 'proxy' | 'direct' }
    error?: string
  }>
  modelsProbe(input: ModelsProbeInput): Promise<{ ok: boolean; data?: ModelsProbeResult; error?: string }>
  modelsCatalog(input: ModelsCatalogInput): Promise<{ ok: boolean; data?: ModelsCatalogResult; error?: string }>
  cardsList(): Promise<{
    ok: boolean
    data?: { cards: Card[]; active: Record<string, string>; agentMode?: Record<string, { mode: string; cardId: string; ts: string }> }
  }>
  cardsAdd(input: Record<string, unknown>): Promise<{ ok: boolean; data?: { cardId: string }; error?: string }>
  cardsUpdate(cardId: string, patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>
  cardsRemove(cardId: string): Promise<{ ok: boolean; error?: string }>
  agentsMatrix(): Promise<{ ok: boolean; data?: MatrixRow[]; apps?: string[]; labels?: Record<string, string> }>
  agentsApply(input: {
    app: string
    cardId: string
    mode: 'proxy' | 'direct'
  }): Promise<{ ok: boolean; data?: { detail?: string; targetPath?: string }; error?: string }>
  agentsRevert(app: string): Promise<{ ok: boolean; data?: { detail?: string }; error?: string }>
  proxyStatus(): Promise<{ ok: boolean; data?: ProxyState }>
  proxyStart(): Promise<{ ok: boolean; data?: { detail?: string }; error?: string }>
  healthProbe(input?: { keyId?: string }): Promise<{
    ok: boolean
    data?: { results: HealthResult[]; fingerprints?: Record<string, string>; masks?: Record<string, string>; timeoutMs?: number }
    error?: string
  }>
  healthAuditList(limit?: number): Promise<{ ok: boolean; data?: AuditEntry[] }>
  healthAuditExport(dest: string): Promise<{ ok: boolean; data?: { count: number }; error?: string }>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function khyosApi(): KhyOsApi | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (window as any).__KHYOS__ as KhyOsApi | null
}
