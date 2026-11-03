// khy-canary: Khy-20261102-255-9N6M6NCW
// host 进程：Agent 运行时适配 — 桥接 KhyOS 后端
// 通道选择（AGENTS.md 五通道决策矩阵）：host 与 backend 同为 Node 进程语义，
// 用 CH-2 服务直调（运行时 require aiGateway）；main↔host 用 Electron fork IPC。
//
// 协议（fork IPC，process.send/on('message')）：
//   ← { type: 'ai.generate', id, prompt, options? }
//   → { type: 'ai.chunk',   id, chunk }          (流式，best effort)
//   → { type: 'ai.result',  id, ok, text?, model?, tokenUsage?, error? }
//   ← { type: 'session.list', id, limit? }
//   → { type: 'session.listResult', id, ok, sessions?, error? }
//   ← { type: 'session.create', id, cwd }
//   → { type: 'session.createResult', id, ok, sessionId?, error? }
//   ← { type: 'session.messages', id, sessionId }
//   → { type: 'session.messagesResult', id, ok, sessionId?, title?, model?, messages?, error? }
//   ← { type: 'sessionGroup.request', id, op: 'list'|'create'|'update'|'delete'|'move'|'reorder'|'import', ... }
//   → { type: 'sessionGroup.result', id, ok, result?, error? }
//   ← { type: 'token.usage', id }
//   → { type: 'token.usageResult', id, ok, usage?, error? }
//   ← { type: 'usage.history', id, days? }
//   → { type: 'usage.historyResult', id, ok, history?, models?, error? }
//   ← { type: 'context.size', id, contentChars }
//   → { type: 'context.sizeResult', id, ok, estimate?, error? }
//   ← { type: 'models.list', id }
//   → { type: 'models.listResult', id, ok, models?, presets?, error? }
//   ← { type: 'gateway.status', id }
//   → { type: 'gateway.statusResult', id, ok, status?, error? }
//   ← { type: 'desktopGate.set', id, mode?, budget?, allowedApps? }
//   → { type: 'desktopGate.setResult', id, ok, gate?, error? }
//   ← { type: 'desktopGate.get', id }
//   → { type: 'desktopGate.getResult', id, ok, gate?, error? }
//   ← { type: 'background.status', id }
//   → { type: 'background.statusResult', id, ok, status?, error? }
//   ← { type: 'ping' }  →  { type: 'ready', pid }
//
// backend 发现顺序（零硬编码）：KHY_OS_DIR env → cwd/../../（apps/khyos-desktop 相对仓库根）。

import path from 'node:path'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { createAmooSecretary } from './amooSecretary'
import { createAmooSecretaryIpc } from './amooSecretaryIpc'

const nodeRequire = createRequire(import.meta.url)

function resolveKhyOsDir(): string {
  if (process.env.KHY_OS_DIR) return path.resolve(process.env.KHY_OS_DIR)
  // out/host/index.js → out/host → out → apps/khyos-desktop → apps → <repo root>
  return path.resolve(process.cwd(), '..', '..')
}

// Pre-load the gateway .env (canonical: runtime/node/backend/.env, same file the
// `khy gateway config` CLI writes). The electron-spawned host does not go
// through the khy CLI dotenv loader, so load it here — before aiGateway is
// required — without overriding values already present in the environment.
function loadGatewayEnvFile(): void {
  const envPath = path.join(resolveKhyOsDir(), 'runtime', 'node', 'backend', '.env')
  let content = ''
  try {
    content = fs.readFileSync(envPath, 'utf8')
  } catch {
    console.log('[host] 无网关 .env（', envPath, '），AI 通道未配置时将返回引导错误')
    return
  }
  let loaded = 0
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const key = m[1]
    const value = m[2].replace(/^["']|["']$/g, '')
    if (!(key in process.env)) {
      process.env[key] = value
      loaded++
    }
  }
  console.log('[host] 已加载网关 .env（新注入', loaded, '项，不覆盖已有环境）')
}

type PersistedSession = {
  sessionId: string
  title: string
  model: string
  messageCount: number
  createdAt: number
  updatedAt: number
  projectDir: string
  cwd: string
  firstUserMessage: string
}

// 主进程 → host 的请求信封。sessionId / contentChars 是既有处理分支一直在读的
// 两个字段，此前没在类型里声明（TS2339 全是这一条）。
type HostMsg = { type: string; id?: string; prompt?: string; limit?: number; cwd?: string; text?: string; days?: number; mode?: string; budget?: string; allowedApps?: string; options?: Record<string, unknown>; requestId?: string; response?: unknown; sessionId?: string; contentChars?: number; timeoutMs?: number; op?: string; entryId?: string; verified?: boolean; provenance?: string }

let gateway: { generate: (prompt: string, options?: Record<string, unknown>) => Promise<{ text?: string; model?: string; tokenUsage?: unknown }> } | null = null

type GatewayModule = { generate: (prompt: string, options?: Record<string, unknown>) => Promise<{ text?: string; model?: string; tokenUsage?: unknown }> }

function loadGateway(): GatewayModule {
  if (gateway) return gateway
  const gwPath = path.join(resolveKhyOsDir(), 'runtime', 'node', 'backend', 'src', 'services', 'gateway', 'aiGateway.js')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const loaded = nodeRequire(gwPath) as GatewayModule
  gateway = loaded
  console.log('[host] aiGateway 已加载:', gwPath)
  return loaded
}

// ── 智能体工具循环（CH-2 服务直调）──────────────────────────────────
// 桌面端此前只调 aiGateway.generate(prompt)：单轮文本、不跑工具循环，于是
// tool_use 被静默丢弃，用户只看到一条回复——与网页端修复前完全同病（见
// runtime/node/backend/src/services/aiManagementChatHttp.js 的 transport 注释）。
// 这里改用与 CLI / 网页端 / AgentTool 同一条 canonical 路径：
//   runToolUseLoop(msg, { chat, chatOpts, onToolCall, onToolResult, ... })
// 由既有循环负责工具派发、截断恢复、权限闸门与去重，host 只做事件适配，
// 不自行实现任何循环逻辑（否则会与 toolUseLoopCore 漂移）。
// 工作区根走 chatOpts.cwd —— toolUseLoopCore 的 effectiveChatOpts.cwd 是其
// 唯一消费点（工具执行根目录 / 路径解析 / 目标存储作用域）。

type AiChatFn = (userMessage: string, opts?: Record<string, unknown>) => Promise<unknown>

type ToolLoopResult = {
  finalResponse?: string
  toolCallLog?: unknown[]
  iterations?: number
  provider?: string
}

type ToolLoopFn = (userMessage: string, options?: Record<string, unknown>) => Promise<ToolLoopResult>

let aiChat: AiChatFn | null = null
let toolLoop: { runToolUseLoop: ToolLoopFn } | null = null

// cli/ai.js 的模块句柄（chat + 来源标记 setter）。整个模块只 require 一次。
type AiModule = {
  chat: AiChatFn
  setPendingSessionSource?: (source: { type: string; id?: string } | null) => void
  clearPendingSessionSource?: () => void
}

let aiModule: AiModule | null = null

function loadAiModule(): AiModule {
  if (aiModule) return aiModule
  const chatPath = path.join(resolveKhyOsDir(), 'runtime', 'node', 'backend', 'src', 'cli', 'ai.js')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  aiModule = nodeRequire(chatPath) as AiModule
  return aiModule
}

function loadAiChat(): AiChatFn {
  if (aiChat) return aiChat
  aiChat = loadAiModule().chat
  return aiChat
}

/**
 * 会话来源标记（[DESIGN-ARCH-183] §4）：定时任务 → automation，其余 → manual。
 *
 * 来源在会话落盘那一刻写进 metadata.source，侧栏「分组」视图据此自动归组，
 * 不再靠标题前缀辨认（「[Scheduled] …」只是显示层提示，不是判据）。
 */
function normalizeSessionSource(raw: unknown): { type: string; id: string } | null {
  if (!raw) return null
  if (typeof raw === 'string') {
    const type = raw.trim()
    return type ? { type, id: '' } : null
  }
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    const type = typeof o.type === 'string' ? o.type.trim() : ''
    if (!type) return null
    const id = o.id === undefined || o.id === null ? '' : String(o.id)
    return { type, id }
  }
  return null
}

function loadToolLoop(): { runToolUseLoop: ToolLoopFn } {
  if (toolLoop) return toolLoop
  const loopPath = path.join(resolveKhyOsDir(), 'runtime', 'node', 'backend', 'src', 'services', 'toolUseLoop.js')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  toolLoop = nodeRequire(loopPath) as { runToolUseLoop: ToolLoopFn }
  return toolLoop
}

/**
 * 落库 content 数组 → 思维链全文（host 侧纯函数）。
 *
 * 持久化块的字段名是 `.thinking` 而不是 `.text`（见后端 contentBlockUtils），
 * 因此下面把 content 拍平成字符串时，thinking 块只贡献空串 —— 思维链必须走
 * 独立的 reasoning 字段，绝不能并进 content 字符串：那会被 MarkdownRenderer
 * 当正文渲染，也会被 Composer 的 `updateMessage({ content: res.text })` 整体覆盖。
 */
function extractReasoningFromContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const b = block as { type?: string; thinking?: string }
      return b && b.type === 'thinking' && typeof b.thinking === 'string' ? b.thinking : ''
    })
    .join('')
}

type SessionPersistenceModule = {
  listPersistedSessions: (opts?: { limit?: number }) => PersistedSession[]
  persistSession: (sessionId: string | undefined, state: { messages: unknown[]; metadata?: { cwd?: string; projectDir?: string; source?: { type: string; id?: string } }; title?: string }) => string
}

let sessionPersistence: SessionPersistenceModule | null = null

function loadSessionPersistence(): SessionPersistenceModule {
  if (sessionPersistence) return sessionPersistence
  const spPath = path.join(resolveKhyOsDir(), 'runtime', 'node', 'backend', 'src', 'services', 'sessionPersistence.js')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const loaded = nodeRequire(spPath) as SessionPersistenceModule
  sessionPersistence = loaded
  console.log('[host] sessionPersistence 已加载:', spPath)
  return loaded
}

// ── 会话分组服务（[DESIGN-ARCH-183]）────────────────────────────────
// 分组的唯一所有者是后端 SQLite；host 只做转发，不缓存第二份真源。
type SessionGroupServiceModule = {
  listSessionsWithGroups: (opts?: { limit?: number }) => {
    ok: boolean
    groups?: Array<{ id: string; title: string; color: string; kind: string; rule: string | null; sortOrder: number }>
    assignment?: Record<string, string>
    counts?: Record<string, number>
    ungrouped?: string[]
    error?: string
  }
  createGroup: (input: { title: string; color?: string }) => { ok: boolean; group?: unknown; error?: string }
  updateGroup: (groupId: string, patch: { title?: string; color?: string }) => { ok: boolean; group?: unknown; error?: string }
  deleteGroup: (groupId: string) => { ok: boolean; error?: string }
  moveSession: (sessionId: string, groupId: string | null, projectKey?: string) => { ok: boolean; error?: string }
  reorderGroups: (order: string[]) => { ok: boolean; error?: string }
  importLegacyGroups: (payload: { groups?: unknown[]; assignments?: Record<string, string> }) => { ok: boolean; error?: string }
}

let sessionGroupService: SessionGroupServiceModule | null = null

function loadSessionGroupService(): SessionGroupServiceModule {
  if (sessionGroupService) return sessionGroupService
  const svcPath = path.join(resolveKhyOsDir(), 'runtime', 'node', 'backend', 'src', 'services', 'sessionGroupService.js')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const loaded = nodeRequire(svcPath) as SessionGroupServiceModule
  sessionGroupService = loaded
  console.log('[host] sessionGroupService 已加载:', svcPath)
  return loaded
}

type UsageBucket = { inputTokens: number; outputTokens: number; totalTokens: number; requests: number; costUSD: number }

/** 日桶投影（后端 getUsageHistory 的返回形状，8 键）。 */
export interface UsageHistoryDay {
  date: string
  inputTokens: number
  outputTokens: number
  /** 沿用日桶原值 = inputTokens + outputTokens，**不是**含缓存的四桶之和。 */
  totalTokens: number
  requests: number
  costUSD: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface ModelUsageRow {
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  requests: number
  costUSD: number
  percentage: number
  /** 仅本次进程，退出即失（后端 records 不落盘）。 */
  scope?: string
}

/** 计价覆盖率。两个字段的时间轴口径不同，渲染层不得当同一维度相加。 */
export interface UsageCostCoverage {
  /** 日级：跨近 N 天，测「那几天跑过 ccSwitch 扫描」。 */
  byDay: { daysWithRequests: number; pricedDays: number; unpricedDays: number; unpricedDayDates: string[] }
  /** 进程级：本次 REPL/host 进程内的订阅制通道审计，原样透出 degraded。 */
  flatThisProcess: { requests: number; providers: string[]; tokens: number; recalculatedUSD: number; degraded: boolean }
}

// 三个新导出全部标可选：宿主承认后端可能还是旧版（该模块在 apps/ 之外独立演进，
// 桌面端不重新构建 host 就跑得起来），兜底才合法。
type TokenUsageService = {
  getTodayUsage: () => UsageBucket
  getMonthUsage: () => UsageBucket
  getSessionUsage: () => UsageBucket & { records?: unknown[] }
  getRemainingQuota: () => { allowed: boolean; remaining: number; limit: number; used: number }
  estimateTokens: (text: string) => number
  getUsageHistory: (days?: number) => UsageHistoryDay[]
  getModelUsage?: () => ModelUsageRow[]
  getCostCoverage?: (days?: number) => UsageCostCoverage
  getUsageFileStamp?: () => string | null
}

let tokenUsageService: TokenUsageService | null = null

function loadTokenUsageService(): TokenUsageService {
  if (tokenUsageService) return tokenUsageService
  const tuPath = path.join(resolveKhyOsDir(), 'runtime', 'node', 'backend', 'src', 'services', 'tokenUsageService.js')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  tokenUsageService = nodeRequire(tuPath) as TokenUsageService
  console.log('[host] tokenUsageService 已加载:', tuPath)
  return tokenUsageService
}

// 上下文窗口分母「总量 Y」的解析链（与 CLI/TUI 同一套真源，DESIGN-ARCH-154）：
//   网关已解析的真值 > env KHY_CONTEXT_WINDOW > 静态真源表 > 128000 兜底
//
// 改动前这里是 `return 128000` 的字面量，与模型、与网关缓存全无关联 —— 于是
// agnes（真实 256K~512K）显示成 128K、deepseek-chat（真实 64K）也显示成 128K，
// 后者会让自动压缩算晚一倍，真发请求时上游直接 400。静态表取「宁可写小不可写大」
// 的保守值（见 constants/modelContextWindows.js 逐条注释与出处）。
//
// 兜底那个数从 contextWindowDefaults 取，不写字面量：本仓的病灶之一就是同一个回退值
// 散在多处各写一遍，改一处不跟其余（contextWindowDefaults.js 文件头自述）。
function loadContextWindowDefaults(): { UNKNOWN_MODEL_CONTEXT_WINDOW?: number } {
  try {
    return nodeRequire(
      path.join(resolveKhyOsDir(), 'runtime', 'node', 'backend', 'src', 'constants', 'contextWindowDefaults.js')
    )
  } catch {
    return {}
  }
}

function contextWindowLimit(model?: string): number {
  const unknown = loadContextWindowDefaults().UNKNOWN_MODEL_CONTEXT_WINDOW || 128000
  const modelId = String(model || '').trim()
  if (modelId) {
    try {
      // 走 loadGateway() 而非读模块级 gateway 变量：AIGateway 构造函数会把「上次实测到的
      // 窗口」播种进它的缓存，这里必须保证那一刻已经发生，否则首屏会绕过记忆、退回静态表。
      // loadGateway 也在 try 内 —— 后端未部署时它会抛，若放到外面就把「回落静态表」变成
      // 「整条 context.size 报错」。
      const gw = loadGateway() as unknown as { getModelContextWindow?: (id: string) => number } | null
      // 同步 getter 自身已在 miss 时 fire-and-forget 触发后台解析（网关路由层
      // getModelContextWindow 内部如此），故这里不必也不应再 await 一次。
      const live: number | undefined = gw?.getModelContextWindow?.(modelId)
      if (typeof live === 'number' && Number.isFinite(live) && live > 0) return Math.floor(live)
    } catch {
      /* 真值不可得（网关未部署/后端缺文件）：落到下面的静态表 */
    }
  }
  const envVal = Number(process.env.KHY_CONTEXT_WINDOW)
  if (Number.isFinite(envVal) && envVal > 0) return Math.floor(envVal)
  if (!modelId) return unknown
  try {
    const { resolveModelContextWindow } = nodeRequire(
      path.join(resolveKhyOsDir(), 'runtime', 'node', 'backend', 'src', 'constants', 'modelContextWindows.js')
    )
    return resolveModelContextWindow(modelId, unknown)
  } catch {
    /* 静态表不可用（后端未部署/路径变了）：回到真源兜底 */
    return unknown
  }
}

type ModelOption = {
  id: string
  label: string
  format: string
  channel?: string
  channelKnown?: boolean
  // 网关适配器类型（'api' / 'claude' / …）与模型 id —— 与终端选中后传给网关的
  // 是同一对值（collectModelEntries 的 entry.value）。没有它们，桌面选了模型
  // 也只能换通道、换不了模型。
  adapter?: string
  model?: string
  // 分组依据 = 上游提供商名（终端 composeModelDisplay().group，同一口径）。
  // 用它而不是 id 前缀：所有中转站走的都是 api 适配器，按前缀分会塌成一组。
  group?: string
  // 该条目来自上游真实 /models。false = 来自 providerPresets 静态目录兜底，
  // 那是一份「可能卖过」的猜测，UI 据此调暗显示。
  fromUpstream?: boolean
  // 能力徽章（视觉 / 图像 / 视频 / 音频），判定在采集叶里做。
  tags?: string[]
}

// providerPresets 的条目形状（后端 providerPresets.js 的对外投影）。defaultModel
// 是真源里带的字段，listModelOptions 读它拼 provider 行的标签。
type ProviderPreset = {
  id: string
  label?: string
  name?: string
  apiFormat?: string
  format?: string
  models?: unknown[]
  defaultModel?: string
}

type ProviderPresetSource = { getProviderPresets: () => ProviderPreset[] }

let providerPresets: ProviderPresetSource | null = null

function loadProviderPresets(): ProviderPresetSource {
  if (providerPresets) return providerPresets
  const ppPath = path.join(resolveKhyOsDir(), 'runtime', 'node', 'backend', 'src', 'services', 'gateway', 'providerPresets.js')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const loaded = nodeRequire(ppPath) as ProviderPresetSource
  providerPresets = loaded
  console.log('[host] providerPresets 已加载:', ppPath)
  return loaded
}

// 把 providerPresets 真源投影成模型选择器的选项列表（provider 一级 + 模型二级）。
// 选项的 channel 字段是后端池 key（poolKey）——网关 preferredAdapter 认的是池
// 名（glm/agnes/qwen/deepseek/anthropic/openai/...），不是 preset 的目录 id
// （zhipu/openrouter/...，AGENTS 红线「未注册通道静默空返回」）。preset 无
// poolKey 映射时（聚合网关/第三方，如 openrouter/groq），channel 回退 preset
// id 并标记 channelKnown=false，UI 端据此不传 preferredAdapter（走网关默认
// 通道级联），避免钉死未注册通道。
async function listModelOptions(): Promise<ModelOption[]> {
  const pp = loadProviderPresets()
  const presets = pp.getProviderPresets()
  // 池 key 映射：built-in providerConfig.js 的 poolKey 真源（CH-2 同进程可直调）
  let poolKeyByPreset: Record<string, string> = {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bpc = nodeRequire(path.join(resolveKhyOsDir(), 'runtime', 'node', 'backend', 'src', 'services', 'gateway', 'builtinProviderConfig.js'))
    const builtins: Array<{ poolKey?: string; name?: string; defaultEndpoint?: string }> =
      (bpc.BUILTIN_PROVIDERS || bpc.builtinProviders || []).filter(Boolean)
    // 通过 label 名称匹配 preset 与 built-in（两侧都归一化中文括号/空格）
    const norm = (s: string) => String(s || '').replace(/[\s（）()·\/]/g, '').toLowerCase()
    for (const b of builtins) {
      if (!b.poolKey) continue
      const bName = norm(b.name || '')
      for (const p of presets) {
        const pLabel = norm(p.label || p.name || p.id)
        if (pLabel && bName && (pLabel === bName || pLabel.includes(bName) || bName.includes(pLabel))) {
          poolKeyByPreset[p.id] = b.poolKey
        }
      }
      // id 直匹配（preset id 与 poolKey 同名时，如 openai/anthropic/deepseek）
      if (presets.some((p) => p.id === b.poolKey)) {
        poolKeyByPreset[b.poolKey] = b.poolKey
      }
    }
    console.log('[host] poolKey 映射（preset→通道）:', JSON.stringify(poolKeyByPreset))
  } catch {
    /* fail-soft：映射加载失败时回退 preset id（channelKnown=false） */
  }
  // 运行时选项一律走**终端同一个采集真源** modelEntryCollection.collectModelEntries。
  //
  // 为什么不是自己调 listModels：那份「哪些模型可选、归哪组、叫什么」的判定
  // （modelListTruth 真值收敛 / 可靠性过滤 / provider 分组 / 视觉标记）全在采集叶
  // 里，桌面另起一套必然与终端漂移 —— 终端里选得到的模型桌面选不到，反之亦然。
  // presets 静态目录只作**兜底**：采集为空（网关未起 / 一个 key 都没有）时才用，
  // 且标 fromUpstream=false 让 UI 调暗。两套 id 命名空间不相交（采集叶
  // `api/<pool>:<model>` vs presets `<presetId>/<model>`），并屏会让同一模型出现
  // 两条看着一样的条目、一级栏计数虚高 —— 终端 /model 同样只列采集结果。
  const collected = await collectModelEntriesFromGateway()
  return collected.length > 0 ? collected : presetOptions(poolKeyByPreset, presets)
}

// presets 静态目录 → 选项（兜底基线，非真实上游）。
function presetOptions(poolKeyByPreset: Record<string, string>, presets: ProviderPreset[]): ModelOption[] {
  const out: ModelOption[] = []
  for (const p of presets) {
    const label = p.label || p.name || p.id
    const mapped = poolKeyByPreset[p.id]
    const channelId = mapped || p.id
    const format = p.apiFormat || p.format || 'openai'
    out.push({
      id: p.id,
      channel: channelId,
      channelKnown: Boolean(mapped),
      adapter: channelId,
      model: '',
      group: label,
      label: p.defaultModel ? `${label} · ${p.defaultModel}` : label,
      format,
      fromUpstream: false,
    })
    if (Array.isArray(p.models) && p.models.length > 0) {
      for (const m of p.models) {
        const mid = typeof m === 'string' ? m : String((m as { id?: string }).id || m)
        out.push({
          id: `${p.id}/${mid}`,
          channel: channelId,
          channelKnown: Boolean(mapped),
          adapter: channelId,
          model: mid,
          group: label,
          label: mid,
          format,
          fromUpstream: false,
        })
      }
    }
  }
  return out
}

// 采集叶（终端同源）→ 选项。
//
// entry.value 是 {adapter, model} —— 与终端选中后传给网关的完全同一对值，桌面
// 因此能真正把「选中的模型」钉进请求，而不是只换一个通道。
async function collectModelEntriesFromGateway(): Promise<ModelOption[]> {
  try {
    const gw = loadGateway() as unknown as Record<string, unknown>
    const collectedPath = path.join(
      resolveKhyOsDir(),
      'runtime', 'node', 'backend', 'src', 'services', 'gateway', 'modelEntryCollection.js'
    )
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { collectModelEntries } = nodeRequire(collectedPath) as {
      collectModelEntries: (opts: { gateway: unknown }) => Promise<{ entries: unknown[] }>
    }
    const result = await collectModelEntries({ gateway: gw })
    const out: ModelOption[] = []
    for (const raw of Array.isArray(result?.entries) ? result.entries : []) {
      const entry = raw as {
        kind?: string
        group?: string
        display?: { primary?: string; secondary?: string }
        value?: { adapter?: string; model?: string | null }
        model?: { isDefault?: boolean } | null
      }
      const adapter = String(entry.value?.adapter || '')
      const model = String(entry.value?.model || '')
      if (!adapter) continue
      const primary = String(entry.display?.primary || model || adapter)
      // 采集叶的 secondary 已把「视觉 / 来源 / 连接 / ✓ 当前」拼好；桌面只取
      // 能力标签，来源与连接态各有各的呈现口径，不在这里复述。
      const secondary = String(entry.display?.secondary || '')
      const tags = ['视觉', '图像', '视频', '音频'].filter((t) => secondary.includes(t))
      out.push({
        id: model ? `${adapter}/${model}` : adapter,
        label: primary,
        format: 'openai',
        adapter,
        model,
        channel: adapter,
        channelKnown: true,
        group: String(entry.group || adapter),
        fromUpstream: entry.kind === 'model',
        ...(tags.length > 0 ? { tags } : {}),
      })
    }
    return out
  } catch (err) {
    console.log('[host] collectModelEntries 失败，回落 presets 静态目录:', String((err as Error)?.message || err))
    return []
  }
}

// In-flight ai.generate ids → start time; a background task, per the i18n
// 真源 template (chat.composer.backgroundWorks.ariaLabel: "Bash {n} 个，
// 子智能体 {n} 个，共 {n} 个"), is anything still awaiting an aiGateway
// reply. Settle entries on ai.result/abort so idle state hides the button.
const activeGenerations = new Map<string, number>()

// 在途工具循环的中断句柄：main 的 ai:abort 经 IPC 到达后立即 abort，让 in-flight
// 工具释放（toolUseLoop 的 abortSignal 语义），而不是干等它跑完自己的超时。
const activeAborts = new Map<string, AbortController>()

// runToolUseLoop 的 onToolCall/onToolResult 只给工具名，不给调用 id；而同一批次里
// 同名工具可能并行多个。这里按「同名先进先出」自行配对 —— 循环按派发顺序回结果，
// 所以 FIFO 是安全口径；不配对则界面只能按名字猜，并行同名会张冠李戴。
const pendingToolCalls = new Map<string, string[]>()
let toolCallSeq = 0

function registerToolCall(generationId: string, toolName: string): string {
  const callId = `tc_${++toolCallSeq}`
  const key = `${generationId}\u0000${toolName}`
  const queue = pendingToolCalls.get(key)
  if (queue) queue.push(callId)
  else pendingToolCalls.set(key, [callId])
  return callId
}

function settleToolCall(generationId: string, toolName: string): string | null {
  const key = `${generationId}\u0000${toolName}`
  const queue = pendingToolCalls.get(key)
  if (!queue || queue.length === 0) return null
  const callId = queue.shift() as string
  if (queue.length === 0) pendingToolCalls.delete(key)
  return callId
}

function clearToolCallQueue(generationId: string): void {
  const prefix = `${generationId}\u0000`
  for (const key of Array.from(pendingToolCalls.keys())) {
    if (key.startsWith(prefix)) pendingToolCalls.delete(key)
  }
}

// 人在环（P1）：审批 / 提问等待用户应答的 promise 注册表。
// onControlRequest 发出请求后把 resolve 挂在这里，ai.controlResponse 到达时取走。
// 超时 fail-closed（RUNTIME-010：授权解析不得 fail-open）——用户未及时响应按拒绝处理，
// 绝不能挂死工具循环，更不能默认放行。
const pendingControls = new Map<string, { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>()
const CONTROL_RESPONSE_TIMEOUT_MS = 300_000

function settleControl(generationId: string, requestId: string, response: unknown): boolean {
  const key = `${generationId}\u0000${requestId}`
  const entry = pendingControls.get(key)
  if (!entry) return false
  pendingControls.delete(key)
  clearTimeout(entry.timer)
  entry.resolve(response)
  return true
}

function failAllControls(generationId: string): void {
  const prefix = `${generationId}\u0000`
  for (const key of Array.from(pendingControls.keys())) {
    if (!key.startsWith(prefix)) continue
    const entry = pendingControls.get(key)
    if (!entry) continue
    pendingControls.delete(key)
    clearTimeout(entry.timer)
    // 显式 deny 而非 undefined：三态解码器把 undefined 也读成 deny，
    // 但显式值让行为可解释（用户未响应 ≠ 通道故障）。
    entry.resolve({ behavior: 'deny' })
  }
}

// 编辑类工具（小写归一）：其参数指明要改的目标文件，用于「本轮文件改动」列表。
// 参数键口径与 guardApproval._rememberApprovedDirectory 相同（file_path / filePath / path）。
// 只在 tool_result 里附带文件名，不解析行数 —— 行数要么造假要么脆弱，DiffSummary
// 对 0 不渲染数字，诚实留空。
const EDITING_TOOL_NAMES = new Set(['edit', 'write', 'multiedit', 'applypatch', 'notebookedit'])

function affectedFilesOf(toolName: string, params: unknown): string[] {
  if (!EDITING_TOOL_NAMES.has(String(toolName).toLowerCase())) return []
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
  const raw = p.file_path || p.filePath || p.path || p.notebook_path || ''
  const s = typeof raw === 'string' ? raw.trim() : ''
  return s ? [s] : []
}

async function handleAiGenerate(id: string, prompt: string, options: Record<string, unknown> = {}): Promise<void> {
  const send = (msg: unknown) => {
    if (process.send) process.send(msg)
    else console.log('[host]', JSON.stringify(msg))
  }
  activeGenerations.set(id, Date.now())
  const controller = new AbortController()
  activeAborts.set(id, controller)
  try {
    loadGatewayEnvFile()
    const chat = loadAiChat()
    // 来源标记（[DESIGN-ARCH-183] §4）：落盘那一刻写进会话，后续分组读它。
    // 桌面端自动化传 {type:'automation', id}；普通对话没有 source → 记 manual。
    const source = normalizeSessionSource(options.source) || { type: 'manual', id: '' }
    const ai = loadAiModule()
    if (typeof ai.setPendingSessionSource === 'function') {
      ai.setPendingSessionSource(source)
    }
    const loop = loadToolLoop()
    // 工作区根：main 侧 getWorkspaceRoot() 注入（工作区单一真源）；缺省回退 host 进程 cwd。
    const cwd = typeof options.cwd === 'string' && options.cwd.trim() ? options.cwd.trim() : process.cwd()
    const costSink: { usage?: unknown } = {}
    // 单一执行路径：runToolUseLoop 是 canonical 循环（CLI / 网页端 / AgentTool 同款），
    // 这里只把它的回调适配成 main↔host 的 IPC 事件流，不自建任何循环逻辑。
    const result = await loop.runToolUseLoop(prompt, {
      chat,
      chatOpts: {
        cwd,
        effort: options.effort,
        preferredAdapter: options.preferredAdapter,
        preferredModel: options.preferredModel,
        images: options.images,
        onChunk: (chunk: unknown) => send({ type: 'ai.chunk', id, chunk }),
      },
      abortSignal: controller.signal,
      onCost: (usage: unknown) => {
        costSink.usage = usage
      },
      onToolCall: (name: string, params: unknown) =>
        send({ type: 'ai.toolCall', id, callId: registerToolCall(id, name), tool: name, input: params || {} }),
      onToolResult: (name: string, params: unknown, toolResult: unknown, iteration: number, elapsed: number) =>
        send({
          type: 'ai.toolResult',
          id,
          callId: settleToolCall(id, name),
          tool: name,
          input: params || {},
          result: toolResult,
          iteration,
          elapsed,
          affectedFiles: affectedFilesOf(name, params),
        }),
      // 人在环（P1）：审批 / 提问。同一通道承载多条产生路径（guardApproval 的软守卫审批、
      // Stage 7 requestPermission、shell 命令审批、AskUserQuestion），request 统一为
      // { subtype:'can_use_tool', tool_name, input }，响应按 { behavior } 三态解码
      // （toolCallingPermissions._decisionFromControl：allow / allow-always / 其它=deny）。
      // 5 分钟未响应 → 显式 deny（fail-closed），不挂死循环、绝不默认放行。
      onControlRequest: ({ requestId, request }: { requestId: string; request: unknown }) => {
        const key = `${id}\u0000${requestId}`
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (pendingControls.delete(key)) {
              resolve({ behavior: 'deny' })
            }
          }, CONTROL_RESPONSE_TIMEOUT_MS)
          pendingControls.set(key, { resolve, timer })
          send({ type: 'ai.controlRequest', id, requestId, request })
        })
      },
    })
    const replyText = String((result && result.finalResponse) || '')
    const toolCallLog = Array.isArray(result?.toolCallLog) ? result.toolCallLog : []
    // 纯工具轮次没有正文是正常的（模型只用工具回答）；不能把它当"空回复"报错，
    // 否则每完成一次纯工具任务都会弹「未返回正文」。判空需同时看工具日志。
    const okFlag = !!replyText || toolCallLog.length > 0
    send({
      type: 'ai.result',
      id,
      ok: okFlag,
      text: replyText,
      empty: !replyText && toolCallLog.length === 0,
      provider: result?.provider,
      iterations: result?.iterations,
      toolCallCount: toolCallLog.length,
      tokenUsage: costSink.usage,
    })
  } catch (error) {
    // 规则 2.2：错误消息 = 问题 + 原因 + 修复建议
    send({
      type: 'ai.result',
      id,
      ok: false,
      error: `AI 调用失败：${String((error as Error)?.message || error)}，请运行 khy gateway status 检查通道配置`,
    })
  } finally {
    clearToolCallQueue(id)
    failAllControls(id)
    activeAborts.delete(id)
    activeGenerations.delete(id)
  }
}

// P3-6①：运行中的后台任务计数（供 Composer「打开运行中的后台任务」按钮，
// 对齐 i18n chat.composer.backgroundWorks.ariaLabel 模板）。数据源是 host
// 进程在途 ai.generate 集合（aiGateway 调用期间）——main 侧另有自动化
// 运行集合（pendingAutomationRuns，经 ai.generate 执行，其 id 也落在
// activeGenerations 里），两边 union 后按 id 去重即得全局在途任务。
// 无任务时 count=0，UI 侧据此隐藏按钮（ZCode 实测空态无此按钮）。
function backgroundTaskStatus(): { count: number; bash: number; subagents: number; taskIds: string[] } {
  const taskIds = Array.from(activeGenerations.keys())
  // 分类启发式：自动化运行 id 带 `auto_` 前缀（main 侧 hostReqId），其余
  // 视为交互会话发起的 AI 调用。Bash 工具子进程计数暂为 0——khy 后端的
  // bash 工具执行不经 aiGateway，事件流桥（bash.start/stop）登记为下轮
  // 余留，不在本轮猜测。
  const subagents = taskIds.filter((tid) => tid.startsWith('auto_')).length
  const bash = 0
  return { count: taskIds.length, bash, subagents, taskIds }
}

// 电脑控制安全闸（backend desktopControl/safetyGate）生效状态：host 进程
// env 是单一真源，safetyGate._envMode() 每次授权调用重读——这里的归一化
// 规则与其保持一致（未知值保守视为 off，fail-closed）。
function desktopGateState(): { mode: string; budget: string | null; allowedApps: string } {
  const raw = String(process.env.KHY_DESKTOP_CONTROL || '').trim().toLowerCase()
  let mode = 'off'
  if (raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes') mode = 'on'
  else if (raw === 'ask') mode = 'ask'
  else if (raw === 'strict') mode = 'strict'
  const budgetRaw = String(process.env.KHY_DESKTOP_MAX_ACTUATIONS || '').trim()
  return {
    mode,
    budget: /^\d+$/.test(budgetRaw) && Number(budgetRaw) > 0 ? budgetRaw : null,
    allowedApps: String(process.env.KHY_COMPUTER_USE_ALLOWED_APPS || '').trim(),
  }
}

// ── Amoo 秘书车道（桌面端「问 Amoo 一句」+ 中止 + 共享记忆）─────────────────
// 客户端经后端 phoneBridgeClient 的工厂创建（CH-2 服务直调，与上面 10+ 个
// nodeRequire 同一先例，不开新进程、不起 HTTP 服务器）；Amoo 完全缺席时车道
// 零 IO（客户端懒加载），host 启动与其它车道不受影响。release 与六个 RPC 的
// 分派都在 ./amooSecretaryIpc，本文件只留这一处装配挂钩。
const amooSecretaryIpc = createAmooSecretaryIpc(createAmooSecretary())

function handleMessage(msg: HostMsg): void {
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'ping') {
    if (process.send) process.send({ type: 'ready', pid: process.pid })
    return
  }
  if (msg.type === 'ai.generate' && msg.id && typeof msg.prompt === 'string') {
    void handleAiGenerate(msg.id, msg.prompt, msg.options)
    return
  }
  if (msg.type === 'ai.abort' && msg.id) {
    const controller = activeAborts.get(msg.id)
    if (controller) {
      try {
        controller.abort('aborted by host caller')
      } catch {
        /* already aborted — idempotent */
      }
    }
    return
  }
  if (msg.type === 'ai.controlResponse' && msg.id && typeof msg.requestId === 'string') {
    settleControl(msg.id, msg.requestId, msg.response)
    return
  }
  if (msg.type === 'session.list' && msg.id) {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    const limit = typeof msg.limit === 'number' && msg.limit > 0 ? Math.min(msg.limit, 500) : 50
    try {
      const sp = loadSessionPersistence()
      const sessions = sp.listPersistedSessions({ limit })
      console.log('[host] session.listResult: ', sessions.length, 'sessions')
      send({ type: 'session.listResult', id: msg.id, ok: true, sessions })
    } catch (error) {
      // 规则 2.2：错误消息 = 问题 + 原因 + 修复建议
      send({
        type: 'session.listResult',
        id: msg.id,
        ok: false,
        error: `读取本地会话列表失败：${String((error as Error)?.message || error)}，请确认 KHY_OS_DIR 指向仓库根目录后重启应用`,
      })
    }
    return
  }
  if (msg.type === 'sessionGroup.request' && msg.id) {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    const op = String((msg as { op?: string }).op || '')
    const reply = (payload: Record<string, unknown>) =>
      send({ type: 'sessionGroup.result', id: msg.id, ok: true, result: payload })
    const fail = (error: string) =>
      send({ type: 'sessionGroup.result', id: msg.id, ok: false, error })
    try {
      const svc = loadSessionGroupService()
      switch (op) {
        case 'list': {
          const limit = typeof msg.limit === 'number' && msg.limit > 0 ? Math.min(msg.limit, 500) : 50
          const res = svc.listSessionsWithGroups({ limit })
          if (!res.ok) { fail(res.error || '读取会话分组失败：请查看导出日志排查 host 状态'); return }
          reply({
            groups: res.groups || [],
            assignment: res.assignment || {},
            counts: res.counts || {},
            ungrouped: res.ungrouped || [],
          })
          return
        }
        case 'create': {
          const res = svc.createGroup({
            title: String((msg as { title?: string }).title || ''),
            color: String((msg as { color?: string }).color || ''),
          })
          if (!res.ok) { fail(res.error || '创建分组失败'); return }
          reply({ group: res.group })
          return
        }
        case 'update': {
          const patch = ((msg as { patch?: unknown }).patch || {}) as { title?: string; color?: string }
          const res = svc.updateGroup(String((msg as { groupId?: string }).groupId || ''), patch)
          if (!res.ok) { fail(res.error || '修改分组失败'); return }
          reply({ group: res.group })
          return
        }
        case 'delete': {
          const res = svc.deleteGroup(String((msg as { groupId?: string }).groupId || ''))
          if (!res.ok) { fail(res.error || '删除分组失败'); return }
          reply({})
          return
        }
        case 'move': {
          const raw = (msg as { groupId?: string | null }).groupId
          const res = svc.moveSession(
            String((msg as { sessionId?: string }).sessionId || ''),
            raw === null || raw === undefined ? null : String(raw),
            String((msg as { projectKey?: string }).projectKey || ''),
          )
          if (!res.ok) { fail(res.error || '归组失败'); return }
          reply({ sessionId: (msg as { sessionId?: string }).sessionId, groupId: raw ?? null })
          return
        }
        case 'reorder': {
          const order = Array.isArray((msg as { order?: unknown }).order)
            ? ((msg as { order?: unknown[] }).order || []).map((x) => String(x))
            : []
          const res = svc.reorderGroups(order)
          if (!res.ok) { fail(res.error || '排序保存失败'); return }
          reply({})
          return
        }
        case 'import': {
          const payload = {
            groups: Array.isArray((msg as { groups?: unknown }).groups)
              ? ((msg as { groups?: unknown[] }).groups || [])
              : [],
            assignments: ((msg as { assignments?: unknown }).assignments || {}) as Record<string, string>,
          }
          const res = svc.importLegacyGroups(payload)
          if (!res.ok) { fail(res.error || '导入旧分组失败'); return }
          reply({ imported: true })
          return
        }
        default:
          fail(`未知的分组操作：${op || '(空)'}`)
          return
      }
    } catch (error) {
      fail(`会话分组操作失败：${String((error as Error)?.message || error)}，请查看导出日志排查 host 状态`)
    }
    return
  }
  if (msg.type === 'session.create' && msg.id && typeof msg.cwd === 'string') {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    try {
      const sp = loadSessionPersistence() as {
        listPersistedSessions: (opts?: { limit?: number }) => PersistedSession[]
        persistSession: (sessionId: string | undefined, state: { messages: unknown[]; metadata?: { cwd?: string; projectDir?: string }; title?: string }) => string
      }
      const sessionId = sp.persistSession(undefined, {
        messages: [],
        metadata: { cwd: msg.cwd, projectDir: msg.cwd },
        title: '',
      })
      console.log('[host] session.createResult:', sessionId)
      send({ type: 'session.createResult', id: msg.id, ok: true, sessionId })
    } catch (error) {
      // 规则 2.2：错误消息 = 问题 + 原因 + 修复建议
      send({
        type: 'session.createResult',
        id: msg.id,
        ok: false,
        error: `创建会话失败：${String((error as Error)?.message || error)}，请确认 KHY_OS_DIR 指向仓库根目录后重启应用`,
      })
    }
    return
  }
  if (msg.type === 'session.messages' && msg.id && typeof msg.sessionId === 'string') {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    try {
      // 经 unknown 中转：sessionPersistence 真实实现同时带 restoreSession 与
      // listPersistedSessions/persistSession，这里只声明本分支用到的那半个面，
      // 直接 as 会因「两侧都不充分重叠」被 TS2352 拒掉。
      const sp = loadSessionPersistence() as unknown as {
        restoreSession: (sessionId: string) => {
          sessionId: string
          title?: string
          model?: string
          messages?: { role?: string; content?: unknown; uuid?: string; timestamp?: number }[]
        }
        jsonlPathFor?: (sessionId: string) => string
      }
      const restored = sp.restoreSession(msg.sessionId)
      const messages = (restored.messages || []).map((m) => ({
        role: m.role === 'assistant' || m.role === 'system' ? m.role : 'user',
        // content may be a string, a content-part array, or an object — flatten
        // to the display text the bubble renders (same normalization as
        // listPersistedSessions' firstUserMessage).
        content:
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p) => (p && typeof p === 'object' ? String((p as { text?: string }).text || '') : String(p || ''))).join(' ')
              : m.content && typeof m.content === 'object'
                ? String((m.content as { text?: string }).text || '')
                : '',
        timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.now(),
        // 思维链独立字段：content 拍平只看 .text，thinking 块的文本只在这里产出。
        reasoning: extractReasoningFromContent(m.content),
      }))
      console.log('[host] session.messagesResult:', msg.sessionId, messages.length, 'messages')
      // 会话落盘路径（复制路径/复制 JSONL 路径用）：来自后端 jsonlPathFor 的
      // 真实解析结果，renderer 侧不再拼造路径。后端无此方法时留空（UI 会
      // 如实显示「路径不可用」而不是复制一个不存在的文件路径）。
      let jsonlPath = ''
      try {
        jsonlPath = sp.jsonlPathFor?.(msg.sessionId) || ''
      } catch {
        jsonlPath = ''
      }
      send({
        type: 'session.messagesResult',
        id: msg.id,
        ok: true,
        sessionId: restored.sessionId || msg.sessionId,
        title: restored.title || '',
        model: restored.model || '',
        messages,
        jsonlPath,
      })
    } catch (error) {
      send({
        type: 'session.messagesResult',
        id: msg.id,
        ok: false,
        messages: [],
        error: `读取会话内容失败：${String((error as Error)?.message || error)}，请确认该会话仍存在于 .khy/sessions 后重试`,
      })
    }
    return
  }
  if (msg.type === 'token.usage' && msg.id) {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    try {
      const tu = loadTokenUsageService()
      const usage = {
        today: tu.getTodayUsage(),
        month: tu.getMonthUsage(),
        session: tu.getSessionUsage(),
        quota: tu.getRemainingQuota(),
      }
      console.log('[host] token.usageResult: month.totalTokens=', usage.month.totalTokens)
      send({ type: 'token.usageResult', id: msg.id, ok: true, usage })
    } catch (error) {
      // 规则 2.2：错误消息 = 问题 + 原因 + 修复建议
      send({
        type: 'token.usageResult',
        id: msg.id,
        ok: false,
        error: `读取 Token 用量统计失败：${String((error as Error)?.message || error)}，请确认 KHY_OS_DIR 指向仓库根目录后重启应用`,
      })
    }
    return
  }
  if (msg.type === 'usage.history' && msg.id) {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
// Clamp to the persistence horizon (recordUsage prunes days > 90).
    const days = typeof msg.days === 'number' && msg.days > 0 ? Math.min(Math.floor(msg.days), 90) : 30
    // 两类失败必须分开说：require 失败（KHY_OS_DIR 指错，后端文件找不到）与
    // 后端版本落后（模块在、导出缺）修法完全相反，混成一句话会把用户引向错的方向。
    const usageErrorMessage = (error: unknown): string => {
      const raw = String((error as Error)?.message || error)
      const code = (error as { code?: string })?.code
      if (code === 'MODULE_NOT_FOUND' || raw.includes('Cannot find module')) {
        return `读取用量历史失败：后端服务模块未找到（${raw}），请确认 KHY_OS_DIR 指向仓库根目录后重启应用`
      }
      return `读取用量历史失败：后端服务版本不匹配（${raw}），请重新构建 host 后重试`
    }
    let tu: TokenUsageService
    let history: UsageHistoryDay[]
    try {
      tu = loadTokenUsageService()
      history = tu.getUsageHistory(days)
    } catch (error) {
      // 规则 2.2：错误消息 = 问题 + 原因 + 修复建议
      send({
        type: 'usage.historyResult',
        id: msg.id,
        ok: false,
        error: usageErrorMessage(error),
      })
      return
    }
    // 下面三个是**可选**导出，各自独立兜底 —— 写在这个 try 之外是刻意的：
    // 把它们塞进同一个 try，任一缺失/抛错都会把已经取到的 history 连坐掉，
    // 渲染层因 models 为空而整页落空态（症状：总用量 0 + 每日暂无记录）。
    let models: ModelUsageRow[] = []
    let coverage: UsageCostCoverage | null = null
    let stamp: string | null = null
    if (typeof tu.getModelUsage === 'function') {
      try {
        models = tu.getModelUsage() || []
      } catch (error) {
        console.log('[host] usage.history: getModelUsage 失败，模型维度留空:', String((error as Error)?.message || error))
      }
    } else {
      console.log('[host] usage.history: 后端无 getModelUsage 导出（服务版本落后），模型维度留空')
    }
    if (typeof tu.getCostCoverage === 'function') {
      try {
        coverage = tu.getCostCoverage(days)
      } catch (error) {
        console.log('[host] usage.history: getCostCoverage 失败:', String((error as Error)?.message || error))
      }
    }
    if (typeof tu.getUsageFileStamp === 'function') {
      try {
        stamp = tu.getUsageFileStamp()
      } catch (error) {
        console.log('[host] usage.history: getUsageFileStamp 失败:', String((error as Error)?.message || error))
      }
    }
    console.log(
      '[host] usage.historyResult: days=', days,
      '| history=', history.length,
      '| models=', models.length,
      '| coverage=', coverage ? `计价 ${coverage.byDay.pricedDays}/${coverage.byDay.daysWithRequests} 天` : '不可用',
      '| stamp=', stamp || '未知',
    )
    send({ type: 'usage.historyResult', id: msg.id, ok: true, history, models, coverage, stamp })
    return
  }
  if (msg.type === 'context.size' && msg.id) {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    const contentChars = typeof msg.contentChars === 'number' ? msg.contentChars : 0
    const text = String((msg as { text?: string }).text ?? '').slice(0, 400_000)
    try {
      const tu = loadTokenUsageService()
      // estimateTokens(text) is the backend's real heuristic (tokenPricing,
      // 同 /cost 与 gateway token-budget 同源) — 比字符数更贴近真实 token 数。
      const estimate = tu.estimateTokens(text)
      send({
        type: 'context.sizeResult',
        id: msg.id,
        ok: true,
        estimate: { used: estimate, total: contextWindowLimit(String((msg as { model?: string }).model ?? '')) },
      })
    } catch (error) {
      // 规则 2.2：错误消息 = 问题 + 原因 + 修复建议
      send({
        type: 'context.sizeResult',
        id: msg.id,
        ok: false,
        error: `估算上下文 token 数失败：${String((error as Error)?.message || error)}，请确认 KHY_OS_DIR 指向仓库根目录后重启应用`,
      })
    }
    return
  }
  if (msg.type === 'models.list' && msg.id) {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    listModelOptions().then((models) => {
      console.log('[host] models.listResult:', models.length, 'options')
      send({ type: 'models.listResult', id: msg.id, ok: true, models })
    }).catch((error) => {
      // 规则 2.2：错误消息 = 问题 + 原因 + 修复建议
      send({
        type: 'models.listResult',
        id: msg.id,
        ok: false,
        error: `读取模型列表失败：${String((error as Error)?.message || error)}，请确认 KHY_OS_DIR 指向仓库根目录后重启应用`,
      })
    })
    return
  }
  if (msg.type === 'background.status' && msg.id) {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    const status = backgroundTaskStatus()
    send({ type: 'background.statusResult', id: msg.id, ok: true, status })
    return
  }
  if (msg.type === 'desktopGate.set' && msg.id) {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    // fail-closed：非法值一律忽略，绝不落入宽松模式。
    const mode = typeof msg.mode === 'string' ? msg.mode.trim().toLowerCase() : ''
    if (['off', 'ask', 'on', 'strict'].includes(mode)) process.env.KHY_DESKTOP_CONTROL = mode
    const budget = typeof msg.budget === 'string' ? msg.budget.trim() : ''
    if (/^\d+$/.test(budget) && Number(budget) > 0) process.env.KHY_DESKTOP_MAX_ACTUATIONS = budget
    if (typeof msg.allowedApps === 'string') {
      if (msg.allowedApps.trim()) process.env.KHY_COMPUTER_USE_ALLOWED_APPS = msg.allowedApps.trim()
      else delete process.env.KHY_COMPUTER_USE_ALLOWED_APPS
    }
    console.log('[host] desktopGate.set:', JSON.stringify(desktopGateState()))
    send({ type: 'desktopGate.setResult', id: msg.id, ok: true, gate: desktopGateState() })
    return
  }
  if (msg.type === 'desktopGate.get' && msg.id) {
    const send = (m: unknown) => {
      if (process.send) process.send(m)
      else console.log('[host]', JSON.stringify(m))
    }
    send({ type: 'desktopGate.getResult', id: msg.id, ok: true, gate: desktopGateState() })
    return
  }
  // Amoo 秘书的 release 与六个 RPC 分派都在 ./amooSecretaryIpc，这里只留挂钩。
  if (amooSecretaryIpc.handleMessage(msg)) return
}

process.on('message', handleMessage)

// 兼容 stdin JSON（保留 Phase 0c 行为）
process.stdin.on('data', (data) => {
  for (const line of data.toString().split('\n')) {
    if (!line.trim()) continue
    try {
      handleMessage(JSON.parse(line))
    } catch {
      /* ignore malformed line */
    }
  }
})

console.log('[host] 进程启动, pid:', process.pid)
if (process.send) process.send({ type: 'ready', pid: process.pid })

// ── 启动热身 ────────────────────────────────────────────────────────────
// 首次 session.list 要**同步**读全部会话快照（实测 714 个 .json / 约 12MB），
// 冷盘上这一趟要几秒。这笔成本原本算在用户的第一次请求头上：侧栏在应用刚启动
// 时立刻拉会话列表，正好撞上它 —— 碰上慢盘/冷缓存就超时，用户看到
// 「会话列表读取失败」，而侧栏没有重试，只能重启应用（用户实测：总是加载失败）。
//
// 现在把成本挪到启动后的空闲时刻：host 先报 ready（窗口立刻可用），再在
// setTimeout 里热身 —— 模块加载 + **会话清单读一遍**（把元数据缓存焐热）。
// 用户的第一笔请求到来时，缓存已经是热的，列表读回是毫秒级。
function warmUpHostModules(): void {
  const timer = setTimeout(() => {
    try {
      loadSessionPersistence()
      console.log('[host] 会话模块热身完成')
    } catch (error) {
      console.log('[host] 会话模块热身失败:', String((error as Error)?.message || error))
    }
    // 焐热会话元数据缓存：这一趟是全量读，冷盘上要几秒；读完之后
    // 用户的第一次列表请求就是毫秒级（否则那几秒算在他的请求头上）。
    try {
      const sp = loadSessionPersistence()
      const list = sp.listPersistedSessions({ limit: 50 })
      console.log('[host] 会话清单缓存已预热:', list.length, 'sessions')
    } catch (error) {
      console.log('[host] 会话清单预热失败:', String((error as Error)?.message || error))
    }
    try {
      const svcPath = path.join(resolveKhyOsDir(), 'runtime', 'node', 'backend', 'src', 'services', 'sessionGroupService.js')
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const svc = nodeRequire(svcPath) as { ensureSystemGroups?: () => boolean }
      svc.ensureSystemGroups?.()
      console.log('[host] 会话分组模块热身完成')
    } catch (error) {
      console.log('[host] 会话分组模块热身失败:', String((error as Error)?.message || error))
    }
  }, 0)
  timer.unref?.()
}
warmUpHostModules()
