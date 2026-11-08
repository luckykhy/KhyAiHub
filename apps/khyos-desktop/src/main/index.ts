// khy-canary: Khy-20261102-259-GYN5NSGG
import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { execFile, fork } from 'child_process'
import { openKeyManagerWindow } from './keyManagerWindow'
import { registerKeyManagerIpc } from './keyManager/ipc'
import { ptyCreate, ptyWrite, ptyResize, ptyKill, disposeAllPtys } from './ptyHost'
import { createRemoteHub, type RemoteHub } from './remote/index'
import { createAmoonHub, resolveBridgeRoot, type AmoonHub } from './amoon/index'
import { handleAmooSecretaryHostMessage, installAmooSecretaryBridge, releaseAmooSecretary } from './amooSecretaryBridge'
import { getSettingsStore, setSetting, getTheme, setTheme } from './settingsStore'
import { getDataHome, baseHomeFile, _resetDataHomeCache } from './keyManager/keyStore'
import {
  getAutomations,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  recordRunStart,
  recordRunSkipped,
  recordRunEnd,
  type Automation,
} from './automationStore'
import {
  getPlugins,
  installPlugin,
  setPluginEnabled,
  uninstallPlugin,
  checkPluginUpdates,
  getEcoMarketCatalog,
  installEcoMarketEntry,
  uninstallEcoMarketEntry,
} from './pluginStore'
import {
  getMcpServers,
  createMcpServer,
  setMcpServerEnabled,
  deleteMcpServer,
  importMcpServers,
} from './mcpStore'
import {
  listItems,
  createItem,
  setItemEnabled,
  deleteItem,
  importItems,
  scanMigrations,
  importMigration,
  migrationDataHome,
} from './agentItemStore'
import {
  listIndexes,
  createIndex,
  rebuildIndex,
  setIndexEnabled,
  deleteIndex,
} from './indexStore'

// ZCode has a frameless window with NO native menu bar: all actions live in a
// custom top-right "窗口菜单" dropdown (ZC-ALIGN-002 L 区实测 12 项). The native
// application menu is therefore unset; accelerators (Ctrl+N/O) move to renderer.
const nodeRequire = createRequire(import.meta.url)

// 桌面端调后端模块（serviceDefaults / downloadsCatalog）时的仓库根。开发态从
// out/main 上溯四级（out/main → out → khyos-desktop → apps → <repo>），装着
// 环境由 KHY_OS_DIR 指定 —— 与 app:brandingLinks 同一基准，别再各写一份。
const resolveKhyOsRoot = (): string =>
  process.env.KHY_OS_DIR ? path.resolve(process.env.KHY_OS_DIR) : path.resolve(__dirname, '..', '..', '..', '..')

// 允许从桌面端用 http 打开的主机名（只放回环）。URL#hostname 对 IPv6 带方括号。
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

// ── GPU / WebGL ────────────────────────────────────────────────────────────
//
// 桌宠的 3D 形态（真 3D Q 版模型、立绘浮雕、写实真人模型）需要 **WebGL 上下文**。
// 这里原先显式关掉了 `disableHardwareAcceleration` + `disable-gpu` +
// `disable-software-rasterizer`，代价是**整个进程没有任何 WebGL**：3D 桌宠
// 只能退回 PNG 或转盘序列，「立绘浮雕」也只剩一张平面图（没有厚度、没有转角）。
//
// 现在的口径：**有显卡走硬件，没显卡走 SwiftShader 软件渲染**，WebGL 至少能用。
//   · `enable-unsafe-swiftshader` —— 允许用软件光栅化兜底。较新的 Chromium
//     默认禁用 SwiftShader，没有这条，没显卡的机器直接没有 WebGL。
//   · `ignore-gpu-blocklist` —— 允许在驱动被列入黑名单的机器上启用 GPU。
//   · `in-process-gpu` —— GPU 进程并入主进程，少一层 IPC，Windows 上更稳。
//   · `disable-gpu-sandbox` + `disable-gpu-compositing` —— **保留**：这两个是
//     为了消掉 gpu_channel_manager 的 "Failed to create shared context" 噪音，
//     去掉会刷屏。
//   · `disk-cache-dir` —— 指向可写的临时目录，避免 GPUCache ACCESS_DENIED。
//
// ⚠ 不要加 `use-angle=swiftshader`：那会把**所有**渲染强行拉到软件光栅化，
// 有显卡的机器也要走 SwiftShader，白白慢一截。这里只放开兜底，不强制降级。
app.commandLine.appendSwitch('enable-unsafe-swiftshader')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('in-process-gpu')
app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('disable-gpu-compositing')
// CacheDir default is the user profile; when running from a read-only / portable
// drive the cache files can be locked → GPUCache ACCESS_DENIED. Point the disk
// cache at a per-app dir under OS temp (always writable, no lock-on-open risk).
// os/path already imported at module top as node:fs/node:path — reuse via import.meta.
app.commandLine.appendSwitch('disk-cache-dir', path.join(os.tmpdir(), 'KhyOS-Desktop', 'GPUCache'))

// ── 单实例闸门 ────────────────────────────────────────────────────────────
// 桌面端是「一个工作区一个窗口」的形态。此前重复双击快捷方式会起第二个完整
// 实例：第二个主窗 + 第二套 host/scheduler 子进程 + 第二个 remote hub（两个
// 进程抢同一个监听端口）。锁必须在任何初始化副作用之前拿到 —— whenReady 里的
// startHostProcess / startSchedulerProcess 一旦跑起来就晚了。
// 拿不到锁的进程只做一件事：退出。把「用户想看到窗口」交给持有锁那一侧的
// second-instance 事件（见下方 handler），不在这里建窗。
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

// Phase 0a + 0b + 0c: 最小主进程 + IPC handler + host 进程
// KeyManager (DESIGN-ARCH-091 P1): standalone key/endpoint manager window

let hostProcess: ReturnType<typeof fork> | null = null
// scheduler 子进程（四进程架构的第四位，见 startSchedulerProcess）
let schedulerProcess: ReturnType<typeof fork> | null = null
// 移动端远程控制（ZC-ALIGN-002 M3）：协议与监听都在后端 src/webRemoteControl/，
// 这里只持有接线实例，退出时显式 stop。
let remoteHub: RemoteHub | null = null
// amoo 桥接：HTTP/operator token 全在主进程，渲染层只经 amoon:* 通道拿脱敏状态。
let amoonHub: AmoonHub | null = null
// 主窗引用。second-instance（用户重复点图标）要把它恢复/置前，而不是新建一个 ——
// createWindow 返回的 win 原先没人保存，所以重复启动除了再建一个窗口别无选择。
let mainWindow: BrowserWindow | null = null

// Single workspace-root resolver. 打开工作区 / 添加项目 persist the chosen
// directory to settings.desktopWorkspacePath; every workspace-scoped channel
// (app:workspacePath, workspace:listFiles, workspace:readTree default) reads
// through here so the chip, the file tree and the file index can never
// disagree. Unset or no-longer-existing path falls back to process.cwd().
async function getWorkspaceRoot(): Promise<string> {
  try {
    const settings = await getSettingsStore()
    const configured = settings.desktopWorkspacePath
    if (typeof configured === 'string' && configured.trim()) {
      const resolved = path.resolve(configured.trim())
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved
    }
  } catch {
    /* fail-soft: settings unreadable → cwd */
  }
  return process.cwd()
}

// 编辑器写通道的根白名单 = 已登记工作区（当前 / MRU / 项目登记）∪ 本会话
// 文件树合法展开过的根。会话级工作区（task.workspacePath）可能落在登记集合
// 之外，但用户要能在文件树里看到它才打得开 —— readTree 顺手登记，写通道据此
// 放行；消息引用一个从没展开过的仓外路径，仍然只读、不可写。
const browsedTreeRoots = new Set<string>()

async function editorWritableRoots(): Promise<Set<string>> {
  const roots = new Set<string>([await getWorkspaceRoot(), ...browsedTreeRoots])
  try {
    const settings = await getSettingsStore()
    const recent = settings.desktopRecentWorkspaces
    if (Array.isArray(recent)) {
      for (const entry of recent) {
        if (typeof entry === 'string' && entry.trim()) roots.add(path.resolve(entry.trim()))
      }
    }
    const projects = settings.desktopProjects
    if (Array.isArray(projects)) {
      for (const entry of projects) {
        const p = (entry as { path?: unknown } | null)?.path
        if (typeof p === 'string' && p.trim()) roots.add(path.resolve(p.trim()))
      }
    }
  } catch {
    /* fail-soft: 至少还有当前工作区与本会话展开过的根 */
  }
  return roots
}

// ── 工作空间候选集（[DESIGN-ARCH-125] P-02）──
// MRU 上限。列表项要能真的切过去，所以读取侧先过滤已不存在的路径 ——
// 诚实红线：宁可列表为空（选择器只渲染兜底项），也不返回切不过去的死链。
const RECENT_WORKSPACES_MAX = 8

async function readRecentWorkspaces(): Promise<{ path: string; name: string }[]> {
  try {
    const settings = await getSettingsStore()
    const raw = settings.desktopRecentWorkspaces
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const out: { path: string; name: string }[] = []
    for (const entry of raw) {
      if (typeof entry !== 'string' || !entry.trim()) continue
      const resolved = path.resolve(entry.trim())
      if (seen.has(resolved)) continue
      seen.add(resolved)
      try {
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) continue
      } catch {
        continue
      }
      out.push({ path: resolved, name: path.basename(resolved) || resolved })
    }
    return out
  } catch {
    /* fail-soft: settings unreadable → 空列表，选择器退化为只有「打开其他文件夹…」 */
    return []
  }
}

// 切换工作空间根：校验 → 写 desktopWorkspacePath（唯一真源）→ 更新 MRU。
// 校验失败即返回错误且**不动任何持久化状态**，避免把坏路径写进真源后
// getWorkspaceRoot 静默回落到 cwd、UI 却显示已切换。
async function switchWorkspace(rawPath: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const resolved = path.resolve(rawPath)
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { ok: false, error: `该路径不是可用目录：${resolved}` }
    }
  } catch (err) {
    return { ok: false, error: `无法访问该路径：${String(err)}` }
  }
  await setSetting('desktopWorkspacePath', resolved)
  const settings = await getSettingsStore()
  const prev = Array.isArray(settings.desktopRecentWorkspaces) ? settings.desktopRecentWorkspaces : []
  const next = [resolved, ...prev.filter((p) => typeof p === 'string' && path.resolve(p) !== resolved)]
    .slice(0, RECENT_WORKSPACES_MAX)
  await setSetting('desktopRecentWorkspaces', next)
  return { ok: true, path: resolved }
}

// Pending ai.generate requests: id → resolver, answered by host messages.
const pendingAi = new Map<string, { resolve: (v: unknown) => void; win: BrowserWindow }>()
// Pending session.list requests: id → resolver.
const pendingSessionList = new Map<string, { resolve: (v: unknown) => void }>()
// Pending sessionGroup.* requests: id → resolver（分组操作共用一张表）。
const pendingSessionGroup = new Map<string, { resolve: (v: unknown) => void }>()

// 会话列表的 host 往返超时。15s 是从「host 冷启动要同步 require 一堆后端模块」
// 的年代留下来的：首次请求要付这笔冷启动成本，容易踩线。现在 host 在启动后
// 主动热身（见 host/index.ts 的 warmUpHostModules），这里的超时只兜真正的
// 卡死，所以给到 20s；超时后 main 还会自动重试一次。
const SESSION_LIST_TIMEOUT_MS = 20_000
// 分组是纯本地 SQLite 操作，应当毫秒级返回 —— 10s 超时足够宽松。
const SESSION_GROUP_TIMEOUT_MS = 10_000
// Pending session.create requests: id → resolver.
const pendingSessionCreate = new Map<string, { resolve: (v: unknown) => void }>()
// Pending session.messages requests: id → resolver.
const pendingSessionMessages = new Map<string, { resolve: (v: unknown) => void }>()
// Pending token.usage requests: id → resolver.
const pendingTokenUsage = new Map<string, { resolve: (v: unknown) => void }>()
// Pending usage.history requests: id → resolver.
const pendingUsageHistory = new Map<string, { resolve: (v: unknown) => void }>()
// Pending context.size requests: id → resolver.
const pendingContextSize = new Map<string, { resolve: (v: unknown) => void }>()
// Pending models.list requests: id → resolver.
const pendingModelList = new Map<string, { resolve: (v: unknown) => void }>()
// models.list 的 IPC 超时。host 侧这条链路走的是「全量采集 + 逐适配器探测」
// （collectModelEntries）：gateway.init() 最长 15s + 探测 30s + 抖动重试 + 逐适配器
// listModels，最坏合计约 60s。原来的 15s 远小于它 → 采集还在跑，IPC 先超时，
// host 回 {ok:false}，模型选择器于是永远空（useModelCatalog 走 error 分支）。
// 终端侧对同一采集有 45s 的构建预算（KHY_MODEL_BUILD_TIMEOUT_MS），桌面侧与之对齐。
const MODELS_LIST_TIMEOUT_MS = 45000
// Pending desktopGate requests: id → resolver.
const pendingDesktopGate = new Map<string, { resolve: (v: unknown) => void }>()
// Pending background.status requests: id → resolver.
const pendingBackgroundStatus = new Map<string, { resolve: (v: unknown) => void }>()
// In-flight automation runs: host request id → { automationId, startedAt }.
// A run settles only on ai.result or host process exit — no wall-clock kill
// (Rule 3: the gateway owns its own HTTP timeouts).
const pendingAutomationRuns = new Map<string, { automationId: string; startedAt: number }>()
// One run per automation at a time (ZCode: runNowAlreadyRunning)
const runningAutomationIds = new Set<string>()
let aiSeq = 0

const AUTOMATION_HOST_PREFIX = 'auto_'

// host 消息类型（点号）→ renderer 事件通道（冒号）。preload 的 onAi* 监听
// 冒号通道（见 src/preload/index.ts），host 的 type 字段是点号风格 —— 单一
// 映射点，新增流事件类型时两边同步登记。
const HOST_EVENT_TO_RENDERER_CHANNEL: Record<string, string> = {
  'ai.chunk': 'ai:chunk',
  'ai.toolCall': 'ai:toolCall',
  'ai.toolResult': 'ai:toolResult',
  'ai.controlRequest': 'ai:controlRequest',
  'ai.result': 'ai:result',
  // amooSecretary.event 不在此表：秘书接线（含它的无主事件广播）整体在
  // ./amooSecretaryBridge，通道映射随接线走。
}

// Parse `git status --porcelain=v1 -z --branch` output into the review panel's
// change model. -z uses NUL separators so paths with spaces/newlines survive.
// Branch header lines: `## main...origin/main [ahead 1, behind 2]` (possibly
// `## No commits yet on main`, or `## HEAD (no branch)` for detached HEAD).
export interface GitStatusResult {
  ok: boolean
  state?: 'ok' | 'notRepository' | 'gitUnavailable' | 'error'
  branch?: string
  upstream?: string
  ahead?: number
  behind?: number
  changes?: { path: string; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'; staged: boolean }[]
  error?: string
}

function parseGitStatus(stdout: string): GitStatusResult {
  const entries = stdout.split('\0').filter((s) => s.length > 0)
  const branchEntry = entries.find((s) => s.startsWith('## '))
  const changes: GitStatusResult['changes'] = []
  let branch: string | undefined
  let upstream: string | undefined
  let ahead: number | undefined
  let behind: number | undefined
  if (branchEntry) {
    const header = branchEntry.slice(3)
    const m = header.match(/^([^.\s]+(?:\/[^.\s]+)?)?(\.{2,3}(\S+))?\s*(\[ahead (\d+)(?:, )?(?:behind (\d+))?\]|\[behind (\d+)\])?/)
    branch = m?.[1] || (header.includes('HEAD') ? 'HEAD' : header.split(/\s|\.{2,3}/)[0] || undefined)
    upstream = m?.[3]
    const aheadStr = m?.[5]
    const behindStr = m?.[6] || m?.[7]
    if (aheadStr) ahead = Number(aheadStr)
    if (behindStr) behind = Number(behindStr)
  }
  // XY status codes → panel kind. X = staged, Y = worktree. Rename entries end
  // with \0<oldPath> in -z mode (handled below via the 2-entry peek).
  const entriesNoBranch = entries.filter((s) => !s.startsWith('## '))
  for (let i = 0; i < entriesNoBranch.length; i++) {
    const entry = entriesNoBranch[i]
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const rawPath = entry.slice(3)
    let status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
    if (xy === '??') {
      status = 'untracked'
    } else if (xy[0] === 'R' || xy[1] === 'R') {
      // -z rename format: `XY new\0old` — the next NUL entry holds the old path
      if (i + 1 < entriesNoBranch.length) i++
      status = 'renamed'
    } else if (xy[0] === 'A' || xy[1] === 'A') {
      status = 'added'
    } else if (xy[0] === 'D' || xy[1] === 'D') {
      status = 'deleted'
    } else {
      status = 'modified'
    }
    // X (staged column) non-blank = staged; '?'/'untracked' never staged
    const staged = xy !== '??' && xy[0] !== ' '
    changes.push({ path: rawPath, status, staged })
  }
  return { ok: true, state: 'ok', branch, upstream, ahead, behind, changes }
}

// After 'ready', detach host-side sockets from the main event loop: a
// long-lived in-flight AI call must not block app exit (sockets unref'd).
function unrefSockets(proc: { stdout?: NodeJS.ReadableStream; stderr?: NodeJS.ReadableStream }): void {
  try {
    for (const s of [proc.stdout, proc.stderr]) {
      const unref = (s as { unref?: () => void } | null | undefined)?.unref
      if (typeof unref === 'function') unref.call(s)
    }
  } catch {
    /* best effort */
  }
}

function handleHostMessage(msg: unknown): void {
  const m = msg as { type?: string; id?: string; [k: string]: unknown }
  if (!m || typeof m !== 'object') return
  // 远程控制接线优先看一眼：它自己发的 RPC 用 remote_* 前缀，主路由的 pending map
  // 里没有这些 id，会在这里被 resolve 掉（流事件则照常继续转发给渲染层）。
  remoteHub?.consume(m)
  if (m.type === 'session.listResult' && m.id) {
    const entry = pendingSessionList.get(m.id)
    if (entry) {
      pendingSessionList.delete(m.id)
      entry.resolve(m)
    }
    return
  }
  // 会话分组（[DESIGN-ARCH-183]）：所有分组操作共用一个 result 类型 + 一张
  // pending 表 —— 分组有 7 个操作，逐个开 result 类型只会让路由表变成噪音。
  if (m.type === 'sessionGroup.result' && m.id) {
    const entry = pendingSessionGroup.get(m.id)
    if (entry) {
      pendingSessionGroup.delete(m.id)
      entry.resolve(m)
    }
    return
  }
  if (m.type === 'session.createResult' && m.id) {
    const entry = pendingSessionCreate.get(m.id)
    if (entry) {
      pendingSessionCreate.delete(m.id)
      entry.resolve(m)
    }
    return
  }
  if (m.type === 'session.messagesResult' && m.id) {
    const entry = pendingSessionMessages.get(m.id)
    if (entry) {
      pendingSessionMessages.delete(m.id)
      entry.resolve(m)
    }
    return
  }
  if (m.type === 'token.usageResult' && m.id) {
    const entry = pendingTokenUsage.get(m.id)
    if (entry) {
      pendingTokenUsage.delete(m.id)
      entry.resolve(m)
    }
    return
  }
  if (m.type === 'usage.historyResult' && m.id) {
    const entry = pendingUsageHistory.get(m.id)
    if (entry) {
      pendingUsageHistory.delete(m.id)
      entry.resolve(m)
    }
    return
  }
  if (m.type === 'context.sizeResult' && m.id) {
    const entry = pendingContextSize.get(m.id)
    if (entry) {
      pendingContextSize.delete(m.id)
      entry.resolve(m)
    }
    return
  }
  if (m.type === 'models.listResult' && m.id) {
    const entry = pendingModelList.get(m.id)
    if (entry) {
      pendingModelList.delete(m.id)
      entry.resolve(m)
    }
    return
  }
  if ((m.type === 'desktopGate.setResult' || m.type === 'desktopGate.getResult') && m.id) {
    const entry = pendingDesktopGate.get(m.id)
    if (entry) {
      pendingDesktopGate.delete(m.id)
      entry.resolve(m)
      return
    }
    // settings:set 的 fire-and-forget 推送没有等待方——落到日志供导出排查。
    console.log('[host] desktopGate:', JSON.stringify(m))
    return
  }
  if (m.type === 'background.statusResult' && m.id) {
    const entry = pendingBackgroundStatus.get(m.id)
    if (entry) {
      pendingBackgroundStatus.delete(m.id)
      entry.resolve(m)
    }
    return
  }
  // amooSecretary 的 result 认领与 event 广播都在 ./amooSecretaryBridge，这里只留挂钩。
  if (handleAmooSecretaryHostMessage(m)) return
  // Automation runs ride the same host ai.generate channel; results settle the
  // run history entry instead of being forwarded to a renderer window.
  if (m.type === 'ai.result' && m.id && String(m.id).startsWith(AUTOMATION_HOST_PREFIX)) {
    void settleAutomationRun(m.id, m)
    return
  }
  // 流事件中继：文本/思考 chunk、工具调用与结果、终局 result 都发回发起窗口。
  // toolCall / toolResult 来自 runToolUseLoop 的循环级回调（不是 chat 的 onChunk），
  // 桌面端靠它们把「agent 真的在干活」渲染出来 —— 缺这两条通道时它们会被静默丢弃。
  // host 消息类型是点号风格（'ai.chunk'），preload 监听的是冒号风格（'ai:chunk'）——
  // 此前直接 send(m.type) 导致两条命名从未对上，渲染层收不到任何流事件
  // （无流式正文、无工具卡片、无审批弹窗）。这里统一映射到 preload 契约通道。
  if (
    (m.type === 'ai.chunk' ||
      m.type === 'ai.toolCall' ||
      m.type === 'ai.toolResult' ||
      m.type === 'ai.controlRequest' ||
      m.type === 'ai.result') &&
    m.id
  ) {
    const rendererChannel = HOST_EVENT_TO_RENDERER_CHANNEL[m.type]
    const entry = pendingAi.get(m.id)
    if (m.type === 'ai.result') pendingAi.delete(m.id)
    // Guard every hop: the sender window may be gone before the reply lands.
    const wc = entry?.win
    if (wc && !wc.isDestroyed()) {
      try {
        wc.webContents.send(rendererChannel, m)
      } catch (err) {
        console.log('[host] send to renderer failed:', String(err))
      }
    }
    if (m.type === 'ai.result') {
      try {
        entry?.resolve(m)
      } catch (err) {
        console.log('[host] resolve failed:', String(err))
      }
    }
    return
  }
  // Detach host sockets from the event loop on ready: a long-lived in-flight
  // AI call must not block app exit. Runs settle via ai.result / host exit /
  // app quit — not via the pipe.
  if (m.type === 'ready') {
    console.log('[host] ready:', JSON.stringify(m))
    unrefSockets(hostProcess)
    void applyDesktopGateFromSettings()
    return
  }
  console.log('[host] message:', JSON.stringify(m))
}

// ── 电脑控制安全闸（backend desktopControl/safetyGate）联动 ──
// safetyGate 每次授权调用都重读 host 进程的 process.env
// （KHY_DESKTOP_CONTROL / KHY_DESKTOP_MAX_ACTUATIONS /
// KHY_COMPUTER_USE_ALLOWED_APPS），所以设置页写入这三个设置键后由 main
// 转发 host 改写自己的 env，下一次操作立即生效；host 就绪时也用持久化
// 设置初始化一遍。fail-closed：缺省不写 = off（总闸关闭）。
const CUA_GATE_KEYS = ['cuaDesktopControlMode', 'cuaMaxActuations', 'cuaAllowedApps']

async function desktopGatePatchFromSettings(): Promise<{
  mode?: string
  budget?: string
  allowedApps?: string
}> {
  const settings = await getSettingsStore()
  const patch: { mode?: string; budget?: string; allowedApps?: string } = {}
  const mode = String(settings.cuaDesktopControlMode || '').trim().toLowerCase()
  if (['off', 'ask', 'on', 'strict'].includes(mode)) patch.mode = mode
  const budget = String(settings.cuaMaxActuations ?? '').trim()
  if (/^\d+$/.test(budget) && Number(budget) > 0) patch.budget = budget
  if (typeof settings.cuaAllowedApps === 'string') patch.allowedApps = settings.cuaAllowedApps.trim()
  return patch
}

async function applyDesktopGateFromSettings(): Promise<void> {
  if (!hostProcess || !hostProcess.connected) return
  try {
    const patch = await desktopGatePatchFromSettings()
    if (Object.keys(patch).length === 0) return
    const id = `desktop_gate_${Date.now()}_${++aiSeq}`
    hostProcess.send({ type: 'desktopGate.set', id, ...patch })
  } catch (err) {
    console.log('[host] desktopGate 初始化失败:', String(err))
  }
}

const KEY_MANAGER_STANDALONE = process.argv.includes('--key-manager')

// Fire one automation run through the host bridge (CH-2). One run per
// automation at a time; manual triggers while busy fail with ZCode's copy,
// schedule triggers while busy record a skipped history entry.
// skipped：调度触发撞上「上一条还在跑」时置 true（下面 runningAutomationIds 分支
// 会记 skipped 历史并回这个标记）。原返回类型漏了它，导致渲染层读 res.skipped
// 报类型错 —— 运行时本就返回，是契约没写全。
async function fireAutomation(id: string, trigger: 'manual' | 'schedule'): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  if (!hostProcess || !hostProcess.connected) {
    return { ok: false, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
  }
  const list = await getAutomations()
  const a = list.find((x) => x.id === id)
  if (!a) {
    return { ok: false, error: '未找到该定时任务，可能已被删除' }
  }
  if (runningAutomationIds.has(id)) {
    if (trigger === 'manual') {
      return { ok: false, error: '上一条正在运行中，请稍后再试' }
    }
    await recordRunSkipped(id)
    return { ok: true, skipped: true }
  }
  const started = await recordRunStart(id, trigger)
  if (!started.ok || !started.automation) {
    return { ok: false, error: started.error || '触发运行失败' }
  }
  const hostReqId = `${AUTOMATION_HOST_PREFIX}${Date.now().toString(36)}_${++aiSeq}`
  runningAutomationIds.add(id)
  pendingAutomationRuns.set(hostReqId, { automationId: id, startedAt: Date.now() })
  // 来源标记（[DESIGN-ARCH-183] §4）：定时任务产生的会话落盘时带 source，
  // 侧栏「分组」视图自动归入「定时任务」组 —— 不靠标题前缀辨认。
  hostProcess.send({
    type: 'ai.generate',
    id: hostReqId,
    prompt: a.prompt,
    options: { source: { type: 'automation', id } },
  })
  return { ok: true }
}

async function settleAutomationRun(hostReqId: string, result: { ok?: boolean; error?: string; text?: string }): Promise<void> {
  const entry = pendingAutomationRuns.get(hostReqId)
  pendingAutomationRuns.delete(hostReqId)
  if (!entry) return
  runningAutomationIds.delete(entry.automationId)
  const durationMs = Date.now() - entry.startedAt
  const okFlag = result.ok !== false && typeof result.text === 'string' && result.text.length > 0
  await recordRunEnd(entry.automationId, entry.startedAt, okFlag ? 'succeeded' : 'failed', {
    durationMs,
    error: okFlag ? undefined : (result.error || '模型无输出：可能端点错误/模型名无效/额度不足，运行 khy gateway status 检查'),
    resultPreview: okFlag && typeof result.text === 'string' ? result.text.slice(0, 400) : undefined,
  }).catch((e: unknown) => {
    console.log(`[automation] 运行记录落盘失败: ${e instanceof Error ? e.message : String(e)}`)
  })
}

// Scheduler tick: fire every enabled automation whose nextRunAt is due.
// Periodic poll, not a task deadline — Rule 3 compliant (no kill path; runs
// settle on ai.result or host exit only).
const AUTOMATION_TICK_MS = 30_000
let automationTimer: NodeJS.Timeout | null = null

async function runDueAutomations(): Promise<void> {
  const list = await getAutomations()
  for (const a of list) {
    if (a.enabled && a.nextRunAt !== null && a.nextRunAt <= Date.now()) {
      const r = await fireAutomation(a.id, 'schedule')
      if (!r.ok) console.log(`[automation] 调度触发失败 (${a.title}): ${r.error}`)
    }
  }
}

function startAutomationScheduler(): void {
  if (automationTimer) return
  automationTimer = setInterval(() => {
    void runDueAutomations()
  }, AUTOMATION_TICK_MS)
  automationTimer.unref?.()
}

// Host died mid-run: settle every in-flight automation run as failed so the
// history never shows a forever-进行中 entry.
function failAllAutomationRuns(reason: string): void {
  for (const [hostReqId, entry] of pendingAutomationRuns) {
    pendingAutomationRuns.delete(hostReqId)
    runningAutomationIds.delete(entry.automationId)
    void recordRunEnd(entry.automationId, entry.startedAt, 'failed', {
      durationMs: Date.now() - entry.startedAt,
      error: reason,
    }).catch((e: unknown) => {
      console.log(`[automation] 运行记录落盘失败: ${e instanceof Error ? e.message : String(e)}`)
    })
  }
}

// App quitting (window-all-closed / tray exit) while a run is in flight:
// settle as failed so a restart never inherits a dangling 进行中 entry.
function settleAutomationRunsOnQuit(): void {
  if (pendingAutomationRuns.size === 0) return
  failAllAutomationRuns('应用已退出，运行中断')
  // recordRunEnd is async fs — give it a beat before the event loop can end
  setTimeout(() => {}, 500)
}

function startHostProcess() {
  // 打包态：host 落在 app.asar 里，而 fork 出来的子进程是 Electron-as-Node ——
  // asar 支持只在主/渲染进程生效，子进程读不到 asar 里的文件（报 Cannot find module）。
  // 所以优先指向 asar.unpacked 里的实体副本（package.json 的 asarUnpack 已包含 out/host/**）。
  const hostPath = path.join(__dirname, '../host/index.js')
  const unpackedHostPath = hostPath.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  )
  const finalHostPath = fs.existsSync(unpackedHostPath) ? unpackedHostPath : hostPath
  hostProcess = fork(finalHostPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
  // EPIPE guard: writing to a closed stdout/stderr pipe throws EPIPE
  // (uncaught in the main process = crash). Wrap every relayed line so a
  // host exit mid-stream degrades to a logged note instead of a kill.
  const logSafe = (tag: string, write: (s: string) => void) => (data: Buffer) => {
    const text = data.toString()
    try {
      write(text)
    } catch (err) {
      console.log(`[host] ${tag} 输出管道已关闭，停止转发: ${String(err)}`)
    }
  }
  hostProcess.stdout?.on('data', logSafe('stdout', (s) => console.log(`[host] ${s}`)))
  hostProcess.stderr?.on('data', logSafe('stderr', (s) => console.error(`[host] ${s}`)))
  hostProcess.on('message', handleHostMessage)
  hostProcess.on('exit', (code) => {
    console.log(`[host] 进程退出, code=${code}`)
    hostProcess = null
    failAllAutomationRuns(`host 进程退出 (code=${code})，运行中断`)
  })
}

// 四进程架构（092 Phase 0d / CLAUDE.md「四进程 + 五 preload」）：main 拉起
// host（Agent 运行时）与 scheduler（定时任务/闲时算力）。scheduler 的业务逻辑
// 仍在 Phase 10，这里只保证进程存活 + IPC 通道可达，进程监视器据此显示真实 pid。
function startSchedulerProcess() {
  const schedulerPath = path.join(__dirname, '../scheduler/index.js')
  try {
    schedulerProcess = fork(schedulerPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
  } catch (err) {
    console.log(`[scheduler] 进程启动失败: ${String(err)}`)
    schedulerProcess = null
    return
  }
  const logSafe = (tag: string, write: (s: string) => void) => (data: Buffer) => {
    const text = data.toString()
    try {
      write(text)
    } catch {
      console.log(`[scheduler] ${tag} 输出管道已关闭，停止转发`)
    }
  }
  schedulerProcess.stdout?.on('data', logSafe('stdout', (s) => console.log(`[scheduler] ${s}`)))
  schedulerProcess.stderr?.on('data', logSafe('stderr', (s) => console.error(`[scheduler] ${s}`)))
  schedulerProcess.on('message', (msg: unknown) => {
    const m = msg as { type?: string; pid?: number } | null
    if (m?.type === 'ready') console.log(`[scheduler] ready: pid=${m.pid}`)
  })
  schedulerProcess.on('exit', (code) => {
    console.log(`[scheduler] 进程退出, code=${code}`)
    schedulerProcess = null
  })
}

// Resolve the refined app icon (deep-space blue rounded square + white K) for
// the taskbar / window chrome. The .ico ships in several places depending on
// how the app is launched (repo source tree vs electron-builder packaged run),
// so probe known locations and use the first that exists; if none, start
// without a custom icon rather than break launch.
function resolveAppIcon(): string | undefined {
  const candidates = [
    // electron-builder packaged resources (win.icon in package.json build block)
    path.join(process.resourcesPath, 'icon', 'icon.ico'),
    path.join(process.resourcesPath, 'icon.ico'),
    // Repo / portable source tree (public dir next to the main entry's out/)
    path.join(__dirname, '../../public/icon.ico'),
    path.join(__dirname, '../renderer/icon.ico'),
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return undefined
}

async function createWindow() {
  // Restore last window geometry from settings.json (desktopWindowSize,
  // ZC-ALIGN-003 backend wiring) — falls back to ZCode's 1216×808 default.
  const settings = await getSettingsStore()
  const size = (settings.desktopWindowSize as {
    width?: number; height?: number; maximized?: boolean
  }) || {}
  const width = typeof size.width === 'number' && size.width >= 800 ? size.width : 1216
  const height = typeof size.height === 'number' && size.height >= 600 ? size.height : 808

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    show: false,
    // Refined KhyOS app icon on the taskbar / window chrome (deep-space blue
    // rounded square + white K). Resolved from known locations; undefined when
    // none exist so launch never breaks.
    ...(resolveAppIcon() ? { icon: resolveAppIcon() } : {}),
    webPreferences: {
      // Preload is built as CJS (electron.vite.config.ts forces format:'cjs')
      // because sandboxed preloads cannot be ESM — see P0-6 in ZC-ALIGN-001.
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Browser tab (BrowserPane) embeds live pages via <webview> — ZCode uses
      // a guest view for its side-panel browser; webview is the Electron
      // equivalent (back/forward/reload + did-navigate/did-fail-load events).
      webviewTag: true
    }
  })
  // 记下主窗：second-instance 与 activate 都靠它判断「已经有一个了」。
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    // 最后一个窗口也没了：没有人再看 Amoo 的轮询进度，车道停推（手机侧任务
    // 不动——中止是用户显式那一下，这里不代劳）。还有窗口开着时照常轮询。
    if (BrowserWindow.getAllWindows().length === 0) releaseAmooSecretary(hostProcess)
  })

  // Persist window geometry on close so the next launch restores it.
  const persistGeometry = () => {
    if (win.isDestroyed()) return
    // getNormalBounds returns the restored size even while maximized
    const bounds = win.getNormalBounds()
    setSetting('desktopWindowSize', {
      width: bounds.width,
      height: bounds.height,
      maximized: win.isMaximized(),
    }).catch((e: unknown) => {
      console.log(`[settings] 窗口尺寸保存失败: ${e instanceof Error ? e.message : String(e)}`)
    })
  }
  win.on('close', persistGeometry)

  // dev-server URL from env (electron-vite injects VITE_DEV_SERVER_URL); the
  // port falls back to a variable (zero-hardcoding exemption class)
  const devPort = process.env.VITE_DEV_PORT || '5173'
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || `http://localhost:${devPort}/`
  if (process.env.VITE_DEV_SERVER_URL || process.env.NODE_ENV === 'development') {
    win.loadURL(devServerUrl)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => {
    win.show()
    // Re-maximize if the last session closed while maximized
    if (size.maximized === true) win.maximize()
  })

  // 窗口控制（minimize/maximize/close）不在此注册：见 whenReady 里「窗口级键位」一节。

  ipcMain.handle('app:version', () => app.getVersion())
  // Real workspace root: the cwd the app was launched from (the open
  // workspace), replacing the previous hardcoded demo path (Rule 1).
  ipcMain.handle('app:workspacePath', () => getWorkspaceRoot())

  // ── 移动端远程控制（ZC-ALIGN-002 M3 / [DESIGN-ARCH-092] §7.21）──
  // 面板要的五件事：开关、状态、二维码刷新、配对确认、设备撤销。
  remoteHub = createRemoteHub({
    sendToHost: (m) => {
      if (hostProcess?.connected) hostProcess.send(m as never)
    },
    hostAlive: () => Boolean(hostProcess && hostProcess.connected),
    getWorkspaceRoot,
    onEvent: (payload) => {
      if (win.isDestroyed()) return
      try {
        win.webContents.send('remote:event', payload)
      } catch (err) {
        console.log('[remote] 事件推送失败:', String(err))
      }
    },
    logger: (line) => console.log(line),
  })
  const readLanFlag = async (): Promise<boolean> => {
    try {
      const s = (await getSettingsStore()) as unknown as Record<string, unknown>
      return s.webRemoteLanEnabled === true
    } catch {
      return false
    }
  }
  ipcMain.handle('remote:start', async (_e, opts?: { lanEnabled?: boolean }) => {
    const requested = typeof opts?.lanEnabled === 'boolean' ? opts.lanEnabled : null
    if (requested !== null) {
      try {
        await setSetting('webRemoteLanEnabled', requested)
      } catch (err) {
        console.log('[remote] 局域网开关持久化失败:', String(err))
      }
    }
    return remoteHub!.start({ lanEnabled: requested ?? (await readLanFlag()) })
  })
  ipcMain.handle('remote:stop', () => remoteHub!.stop())
  ipcMain.handle('remote:status', () => remoteHub!.status())
  ipcMain.handle('remote:refreshQr', () => remoteHub!.refreshQr())
  ipcMain.handle('remote:approve', (_e, pairingId: string, role: string) =>
    remoteHub!.approve(String(pairingId || ''), String(role || 'viewer')),
  )
  ipcMain.handle('remote:reject', (_e, pairingId: string) => remoteHub!.reject(String(pairingId || '')))
  ipcMain.handle('remote:revoke', (_e, deviceId: string) => remoteHub!.revoke(String(deviceId || '')))
  ipcMain.handle('remote:probeBridge', () => remoteHub!.probeBridge())

  // ── amoo 桥接（桌面端主入口：SidePane 的 amoo 标签）──
  // 与 remote 同一注册点。状态/发送/回执全部在主进程完成：渲染层拿不到 token，
  // 也不自己 fetch（bridge 会 403 任何带 Origin 的请求）。
  // 注意：桌面端退出不 stop daemon —— daemon 是 detached 的，CLI 与桌面端共用。
  // 从 out/main 上溯到仓库根找桥源码；打包后找不到时 cliFound=false，UI 给提示。
  amoonHub = createAmoonHub({
    bridgeRoot: resolveBridgeRoot(process.env, __dirname),
    logger: (line) => console.log(line),
  })
  const amoonSafe = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await fn()
    } catch (err) {
      const message = String((err as Error)?.message || err)
      console.log('[amoon] 未处理错误:', message)
      return { ok: false, error: { code: 'internal_error', message } }
    }
  }
  ipcMain.handle('amoon:status', () => amoonSafe(() => amoonHub!.status()))
  ipcMain.handle('amoon:send', (_e, input?: { text?: unknown; openChat?: unknown }) =>
    amoonSafe(() => amoonHub!.send({ text: String(input?.text ?? ''), openChat: input?.openChat === true })),
  )
  ipcMain.handle('amoon:inbox', (_e, limit?: unknown) =>
    amoonSafe(() => amoonHub!.inbox(typeof limit === 'number' ? limit : 20)),
  )
  ipcMain.handle('amoon:start', () => amoonSafe(() => amoonHub!.start()))
  ipcMain.handle('amoon:stop', () => amoonSafe(() => amoonHub!.stop()))

  // ── Amoo 秘书（桌面端问 Amoo 一句 + 中止 + 共享记忆 + 循环状态）─────────
  // 六个渲染层通道、pending 表与无主事件广播整体在 ./amooSecretaryBridge
  // （错误形状的归一也在那里：normalizeAmooReply 只在 pending 认领这一处包）。
  // 这里只留一次安装；host fork 句柄每次调用现取——这些通道在 startHostProcess
  // 之前就已注册，安装时快照会拿到 null。
  installAmooSecretaryBridge(ipcMain, () => hostProcess)

  // ── 工作空间选择（[DESIGN-ARCH-125] P-01/P-02）──
  // 读：当前根 + 最近打开候选集 + 项目登记。当前值一律经 getWorkspaceRoot() 的唯一真源
  // 给出；desktopRecentWorkspaces 只回答「可切到哪几个」，不参与「当前是谁」。
  // projects（[DESIGN-ARCH-177]）是**扩展既有返回值**而非新增通道 —— 另开
  // workspace:projects 就是第二个真源，正是 settingsStore 注释反复警告的那件事。
  ipcMain.handle('workspace:list', async () => {
    const settings = await getSettingsStore()
    return {
      ok: true,
      current: await getWorkspaceRoot(),
      recents: await readRecentWorkspaces(),
      projects: Array.isArray(settings.desktopProjects) ? settings.desktopProjects : [],
      // 系统临时目录根：侧栏判定层据此把 Temp 下的会话归入「未归属」。
      // 这是**环境事实**（不是按目录名猜形状），所以不违反 177 §3.2 的反模式。
      // 主进程唯一一处知道 os.tmpdir()，渲染层不自己拼路径。
      tempRoots: [os.tmpdir()],
    }
  })
  // 切：带 target 就切到它（选择器点「最近打开」），不带就弹系统目录框
  // （「打开其他文件夹…」）。取消不算失败，用 canceled 区分，调用方不报错。
  ipcMain.handle('workspace:open', async (_e, target?: string) => {
    const requested = typeof target === 'string' ? target.trim() : ''
    let chosen = requested
    if (!chosen) {
      const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true }
      chosen = result.filePaths[0]
    }
    return switchWorkspace(chosen)
  })

  // 设置读写（持久化到 baseHome/settings.json）
  ipcMain.handle('settings:get', async () => {
    return getSettingsStore()
  })
  ipcMain.handle('settings:set', async (_e, key: string, value: unknown) => {
    await setSetting(key, value)
    if (typeof key === 'string' && CUA_GATE_KEYS.includes(key)) {
      await applyDesktopGateFromSettings()
    }
    return true
  })

  // 数据存储路径变更：复制现有数据到 <newPath>/.khy，然后写指针。
  // 迁移采用「复制而非移动」——base home 的 settings.json（存指针的文件）
  // 不迁移，旧数据保留，用户可手动清理（可逆、零数据丢失）。
  ipcMain.handle('settings:setDataPath', async (_e, newPath: string) => {
    if (typeof newPath !== 'string' || !newPath.trim()) {
      return { ok: false, error: '路径为空：请选择或输入有效的数据存储路径' }
    }
    const target = path.resolve(newPath.trim())
    const baseSettings = baseHomeFile('settings.json')
    const currentHome = getDataHome()
    const newHome = path.join(target, '.khy')
    if (newHome === currentHome) {
      return { ok: true, moved: false, home: newHome }
    }
    try {
      const fs = await import('node:fs')
      // fs.cp recursive copy of the current data home (skips settings.json
      // via filter — the pointer file stays in the base home)
      await fs.promises.cp(currentHome, newHome, {
        recursive: true,
        force: true,
        filter: (src) => path.resolve(src) !== path.resolve(baseSettings),
      })
      await setSetting('dataPath', target)
      // Switch the running process to the new home immediately
      _resetDataHomeCache()
      return { ok: true, moved: true, home: newHome }
    } catch (err) {
      return {
        ok: false,
        error: `数据迁移失败：${err instanceof Error ? err.message : String(err)}，已保留原路径，请检查目标磁盘可写后重试`,
      }
    }
  })

  // 主题（持久化到 settings.json 的 theme 字段）
  ipcMain.handle('theme:get', async () => {
    return getTheme()
  })
  ipcMain.handle('theme:set', async (_e, mode: string) => {
    await setTheme(mode)
    // 通知所有渲染窗口更新主题 class
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('theme:changed', mode)
      }
    }
    return true
  })

  // 界面缩放：clamped 0.5–2.0, applied to the sender window only (ZCode
  // account-menu 界面缩放 submenu: 放大/缩小/实际大小). Returns the applied
  // factor so callers can update any local UI state.
  ipcMain.handle('zoom:set', async (e, factor: number) => {
    const clamped = Math.min(2, Math.max(0.5, Number(factor)))
    const wc = e.sender
    if (!Number.isFinite(clamped)) {
      throw new Error('缩放值无效：请传入 0.5–2.0 之间的数字')
    }
    wc.setZoomFactor(clamped)
    return clamped
  })

  // 文件系统
  ipcMain.handle('fs:openDirectory', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      return result.canceled ? null : result.filePaths[0]
  })
  // 附件/图片选择（Composer 添加上下文 → 添加附件 / 上传图片）。filters 由
  // 调用方给出（按格式桶分组），multiSelections 允许一次多个 —— 返回值是真实
  // 路径 + 字节数，取消返回空数组（不再自造 file_N.tsx 假名）。
  // 大小一并带回来是因为附件列表要显示它；在 main 侧 stat 比让渲染层再开一条
  // 通道省一次 IPC 往返，渲染层也不必碰文件系统。stat 失败按 0 处理（文件可能
  // 在选中后立刻被移走，不该因此让整个选择失败）。
  ipcMain.handle('fs:selectFiles', async (_e, filters?: { name: string; extensions: string[] }[]) => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: Array.isArray(filters) && filters.length > 0 ? filters : undefined,
    })
    if (result.canceled) return []
    return Promise.all(
      result.filePaths.map(async (filePath) => {
        let size = 0
        try {
          size = (await fs.promises.stat(filePath)).size
        } catch {
          size = 0
        }
        return { path: filePath, size }
      })
    )
  })
  ipcMain.handle('fs:readFile', async (e, filePath: string) => {
    const fs = await import('fs/promises')
    return fs.readFile(filePath, 'utf-8')
  })
  // 附件图片放大预览（AttachmentList 的灯箱）。不能复用 fs:readFile —— 那条通道
  // 是 utf-8，二进制图片会被解码破坏；也不注册 file:// 协议，dev 下渲染层是
  // http://localhost，file:// 会被当成跨源。这里按扩展名定 MIME、整体编码成
  // data URL，20MB 上限防止一张大图把渲染进程的内存打满。
  ipcMain.handle('fs:readImageDataUrl', async (_e, filePath: string) => {
    const IMAGE_PREVIEW_LIMIT = 20 * 1024 * 1024
    const MIME_BY_EXT: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      svg: 'image/svg+xml',
      ico: 'image/x-icon',
      avif: 'image/avif',
      heic: 'image/heic',
    }
    try {
      if (typeof filePath !== 'string' || !filePath.trim()) {
        return { ok: false, error: '缺少文件路径' }
      }
      const ext = path.extname(filePath).slice(1).toLowerCase()
      const mime = MIME_BY_EXT[ext]
      if (!mime) {
        return { ok: false, error: `不是可预览的图片格式（.${ext || '无扩展名'}）：请用系统看图工具打开 ${filePath}` }
      }
      const stat = await fs.promises.stat(filePath)
      if (!stat.isFile()) {
        return { ok: false, error: `${filePath} 不是文件，无法预览` }
      }
      if (stat.size > IMAGE_PREVIEW_LIMIT) {
        return {
          ok: false,
          error: `图片 ${(stat.size / (1024 * 1024)).toFixed(1)} MB，超过 20 MB 预览上限：请用系统看图工具打开 ${filePath}`,
        }
      }
      const buf = await fs.promises.readFile(filePath)
      return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
    } catch (err) {
      return { ok: false, error: `读取图片 ${filePath} 失败：${String(err)}，请确认文件仍存在` }
    }
  })
  ipcMain.handle('fs:writeFile', async (e, filePath: string, content: string) => {
    const fs = await import('fs/promises')
    await fs.writeFile(filePath, content, 'utf-8')
    return true
  })
  // ── 粘贴附件落盘（Composer 的 Ctrl+V）────────────────────────────────
  // 渲染层把剪贴板里的文件/图片读成 base64 送过来，这里落盘成临时文件并返回
  // 真实路径 —— 附件要的是路径（后续由后端按路径读），不是 dataURL。
  // 落点：系统临时目录下的 KhyOS-Desktop/clipboard（与 GPUCache 同族目录，
  // 见文件头「缓存目录」注释：放系统临时目录，避免锁与权限问题）。
  // 文件名做净化（只保留 [A-Za-z0-9._-]），防路径穿越。
  ipcMain.handle('fs:saveClipboardFile', async (_e, fileName: string, base64: string) => {
    try {
      if (typeof fileName !== 'string' || !fileName.trim()) {
        return { ok: false, error: '缺少文件名' }
      }
      if (typeof base64 !== 'string' || !base64.length) {
        return { ok: false, error: '内容为空' }
      }
      const dir = path.join(os.tmpdir(), 'KhyOS-Desktop', 'clipboard')
      await fs.promises.mkdir(dir, { recursive: true })
      const safe = path.basename(fileName).replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'pasted'
      const target = path.join(dir, `${Date.now()}-${safe}`)
      const bytes = Buffer.from(base64, 'base64')
      await fs.promises.writeFile(target, bytes)
      // size 直接取写入的字节数，不用再 stat 一次。
      return { ok: true, path: target, size: bytes.length }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // ── 代码查看（codeViewer.* 文案）— 只读预览通道，四态契约 ──
  // ok（文本内容）/ tooLarge（>256KB 预览上限）/ binary（NUL 字节检测）/
  // missing / empty。只读短 I/O，无长任务截止，Rule 3 无涉。
  ipcMain.handle('codeViewer:read', async (_e, filePath: string) => {
    const PREVIEW_LIMIT = 256 * 1024
    try {
      if (typeof filePath !== 'string' || !filePath.trim()) {
        return { ok: false, state: 'missing' as const }
      }
      const stat = await fs.promises.stat(filePath)
      if (!stat.isFile()) {
        return { ok: false, state: 'missing' as const }
      }
      if (stat.size > PREVIEW_LIMIT) {
        return { ok: false, state: 'tooLarge' as const, size: stat.size }
      }
      const buf = await fs.promises.readFile(filePath)
      if (buf.length === 0) {
        return { ok: false, state: 'empty' as const }
      }
      // Binary heuristic: a NUL byte in the first 8KB means not previewable text
      const probe = buf.subarray(0, Math.min(buf.length, 8192))
      if (probe.includes(0)) {
        return { ok: false, state: 'binary' as const }
      }
      return { ok: true, state: 'ok' as const, content: buf.toString('utf-8'), size: buf.length, mtimeMs: Math.round(stat.mtimeMs) }
    } catch {
      return { ok: false, state: 'missing' as const }
    }
  })

  // ── 内置代码编辑器写通道（viewer 编辑态 Ctrl+S）────────────────────
  // 与 fs:writeFile（渲染层任意路径直写的孤儿 stub，usage:exportCsv 注释
  // 点名的反面先例）划清界限，三重约束：
  //   1. 目标必须是**已存在**的常规文件（v1 只改不建）；
  //   2. 路径必须落在已登记工作区根（当前/MRU/项目）或本会话用文件树合法
  //      展开过的目录内 —— 消息引用一个仓外路径就能盲写是不被允许的；
  //   3. 渲染层带打开时的 mtime 作基线，磁盘上已被外部改动就拒写（conflict），
  //      由用户明示覆盖还是重载，不静默丢对方的改动。
  // 写入走 tmp + rename 原子替换（同 settingsStore.setSetting 模式），半截
  // 文件不会留在原路径上。
  ipcMain.handle('codeEditor:write', async (_e, filePath: string, content: string, baseMtimeMs?: number) => {
    try {
      if (typeof filePath !== 'string' || !filePath.trim()) {
        return { ok: false, state: 'missing' as const, error: '文件路径为空：请先打开一个文件再保存' }
      }
      if (typeof content !== 'string') {
        return { ok: false, state: 'error' as const, error: '保存内容不是文本：已拒绝写入' }
      }
      const resolved = path.resolve(filePath.trim())
      const roots = await editorWritableRoots()
      const inside = [...roots].some((root) => resolved === root || resolved.startsWith(root + path.sep))
      if (!inside) {
        return {
          ok: false,
          state: 'outsideWorkspace' as const,
          error: `拒绝写入 ${resolved}：该文件不在已登记的工作区或本会话打开过的文件树内，请先用「打开工作区」登记它的目录`,
        }
      }
      const stat = await fs.promises.stat(resolved)
      if (!stat.isFile()) {
        return { ok: false, state: 'missing' as const, error: `目标不是已存在的文件：${resolved}` }
      }
      if (typeof baseMtimeMs === 'number' && Number.isFinite(baseMtimeMs) && Math.round(stat.mtimeMs) !== Math.round(baseMtimeMs)) {
        return {
          ok: false,
          state: 'conflict' as const,
          diskMtimeMs: Math.round(stat.mtimeMs),
          error: `文件已在磁盘上被修改（打开后磁盘又变了）：直接覆盖会丢掉对方的改动，请选择「覆盖写入」或「重新加载」`,
        }
      }
      const tmp = `${resolved}.khyos-editor-tmp`
      await fs.promises.writeFile(tmp, content, 'utf-8')
      await fs.promises.rename(tmp, resolved)
      const after = await fs.promises.stat(resolved)
      return { ok: true, mtimeMs: Math.round(after.mtimeMs) }
    } catch (err) {
      return { ok: false, state: 'error' as const, error: `保存失败：${String((err as Error)?.message || err)}，请检查文件是否被其他程序占用` }
    }
  })

  // ── 打开文件（sidePane.openFile）：workspace 文件索引，仅返回文本类文件 ──
  // 深度/数量有界（Rule 3 精神：单次遍历，无长任务）；忽略 node_modules 等噪声目录。
  ipcMain.handle('workspace:listFiles', async (_e, query: string) => {
    const root = await getWorkspaceRoot()
    const SKIP_DIRS = new Set([
      'node_modules', '.git', 'dist', 'out', 'build', '.khy', 'coverage', '.next', '.turbo',
    ])
    const TEXT_EXTS = new Set([
      '.md', '.markdown', '.txt', '.json', '.js', '.jsx', '.ts', '.tsx', '.vue', '.css',
      '.html', '.yml', '.yaml', '.toml', '.ini', '.sh', '.bat', '.ps1', '.py', '.cjs', '.mjs',
    ])
    const MAX_FILES = 5000
    const results: { path: string; name: string }[] = []
    const q = (query || '').trim().toLowerCase()
    try {
      const walk = (dir: string, depth: number) => {
        if (results.length >= MAX_FILES || depth > 8) return
        let entries: fs.Dirent[]
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          return // unreadable subdir: skip, don't fail the whole index
        }
        for (const ent of entries) {
          if (results.length >= MAX_FILES) return
          const full = path.join(dir, ent.name)
          if (ent.isDirectory()) {
            if (!SKIP_DIRS.has(ent.name.toLowerCase()) && !ent.name.startsWith('.')) {
              walk(full, depth + 1)
            }
          } else if (ent.isFile()) {
            const ext = path.extname(ent.name).toLowerCase()
            if (!TEXT_EXTS.has(ext)) continue
            if (q && !full.toLowerCase().includes(q)) continue
            results.push({ path: full, name: ent.name })
          }
        }
      }
      walk(root, 0)
      return { ok: true, root, files: results }
    } catch (err) {
      return { ok: false, error: `工作区文件索引失败：${err instanceof Error ? err.message : String(err)}，请检查工作区目录权限` }
    }
  })

  // ── 工作区文件树（侧栏 fileTree 视图，workspaceFileTree.* 文案）：单目录懒加载 ──
  // 每次只读一层（readdir withFileTypes），展开目录时再拉取子层，避免一次性
  // 深遍历大工作区（Rule 3 精神：按需短 I/O，无长任务）。隐藏项与噪声目录
  // （node_modules/.git 等，与 workspace:listFiles 的 SKIP_DIRS 一致）默认折叠
  // 为 "pruned" 条目并计入，由渲染层按需懒加载展开。query 提供子串过滤。
  ipcMain.handle('workspace:readTree', async (_e, dirPath: string, query: string) => {
    const root = (typeof dirPath === 'string' && dirPath.trim()) ? path.resolve(dirPath.trim()) : await getWorkspaceRoot()
    // 登记合法展开过的根：编辑器写通道的白名单据此纳入会话级工作区
    browsedTreeRoots.add(root)
    const SKIP_DIRS = new Set([
      'node_modules', '.git', 'dist', 'out', 'build', '.khy', 'coverage', '.next', '.turbo',
    ])
    const q = (query || '').trim().toLowerCase()
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true })
      const items = entries
        .map((ent) => ({
          name: ent.name,
          path: path.join(root, ent.name),
          kind: ent.isDirectory() ? 'directory' as const
            : ent.isFile() ? 'file' as const
            : 'other' as const,
        }))
        // .name files/dirs (dotfiles) stay visible like any IDE tree; only
        // dependency-cache and build-output dirs are pruned as noise.
        .filter((it) => it.kind !== 'other')
        .filter((it) => !(it.kind === 'directory' && SKIP_DIRS.has(it.name.toLowerCase())))
        .filter((it) => !q || it.name.toLowerCase().includes(q))
        // Directories first, then files; each bucket alphabetical (case-insensitive)
        .sort((a, b) =>
          a.kind === b.kind
            ? a.name.toLowerCase().localeCompare(b.name.toLowerCase())
            : a.kind === 'directory' ? -1 : 1
        )
      return { ok: true, root, items }
    } catch (err) {
      return { ok: false, error: `读取目录失败：${err instanceof Error ? err.message : String(err)}，请检查目录权限后重试` }
    }
  })

  // AI 网关 — 转发给 host 进程，host 动态 require KhyOS 后端 AI 入口（CH-2）。
  // 工作区根在这里注入（单一真源 getWorkspaceRoot）：agent 的读写 / 命令都以它为
  // 执行根，不注入则 host 会拿 apps/khyos-desktop 当根目录 —— 能跑通但改错地方。
  ipcMain.handle('ai:send', async (e, payload: { prompt?: string; options?: Record<string, unknown> }) => {
    const prompt = payload?.prompt
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return { ok: false, error: '请求缺少 prompt：请输入要发送的内容后重试' }
    }
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `ai_${Date.now()}_${++aiSeq}`
    const senderWin = BrowserWindow.fromWebContents(e.sender)
    if (!senderWin || senderWin.isDestroyed()) {
      return { ok: false, error: '发送窗口已关闭：请重试' }
    }
    const workspaceRoot = await getWorkspaceRoot()
    const options = { ...(payload?.options || {}), cwd: workspaceRoot }
    return new Promise((resolve) => {
      pendingAi.set(id, { resolve: resolve as (v: unknown) => void, win: senderWin })
      hostProcess!.send({ type: 'ai.generate', id, prompt, options })
      // Guard: host died mid-request
      setTimeout(() => {
        if (pendingAi.has(id)) {
          pendingAi.delete(id)
          resolve({ ok: false, error: 'host 进程响应超时：请查看导出日志排查 host 状态' })
        }
      }, 300000)
    })
  })
  ipcMain.handle('ai:stream', async (e, payload: unknown) => {
    console.log('[ai] stream (streaming flows through ai:send + ai:chunk)', payload)
    return { ok: true }
  })

  // 会话 — 转发给 host 进程，host 动态 require KhyOS 后端 sessionPersistence（CH-2），
  // 读本地 .khy/sessions 真源（与 `khy` CLI 同源），替代旧的静态 [] stub。
  //
  // **一次超时不等于会话读不到**：host 可能正卡在一次冷启动的模块加载（首次
  // session.list 会同步 require sessionPersistence + 搜索索引）上，或被别的请求
  // 排在后面。旧实现超时即失败，渲染层又没有重试 —— 一次丢包就把整个侧栏变成
  // 「会话列表读取失败」，必须重启应用才恢复（用户实测：总是加载失败）。
  // 现在：超时后自动重试一次（host 已热身时第二次必然秒回），仍失败才报失败。
  ipcMain.handle('session:list', async (e, limit?: number) => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, sessions: [], error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const runOnce = (): Promise<{ ok: boolean; sessions?: unknown[]; error?: string }> => {
      const id = `sess_list_${Date.now()}_${++aiSeq}`
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingSessionList.delete(id)
          resolve({ ok: false, sessions: [], error: '会话列表读取超时：请查看导出日志排查 host 状态' })
        }, SESSION_LIST_TIMEOUT_MS)
        pendingSessionList.set(id, {
          resolve: (v: unknown) => { clearTimeout(timer); resolve(v as { ok: boolean; sessions?: unknown[]; error?: string }) },
        })
        hostProcess!.send({ type: 'session.list', id, limit: typeof limit === 'number' ? limit : 50 })
      })
    }
    const first = await runOnce()
    if (first.ok || first.error !== '会话列表读取超时：请查看导出日志排查 host 状态') return first
    // 第一次超时 → 重试一次（host 这时通常已完成热身）
    console.log('[session] 会话列表读取超时，自动重试一次')
    const second = await runOnce()
    if (second.ok) return second
    return {
      ...second,
      error: '会话列表读取失败：host 进程连续两次无响应，请重启 KhyOS Desktop 后重试',
    }
  })

  // ── 会话分组（[DESIGN-ARCH-183]）────────────────────────────────────
  // 分组的唯一所有者是后端 SQLite（sessionGroupService）；main 只做转发，
  // 不缓存第二份真源。超时比会话列表短：分组是纯本地 DB 操作，应当毫秒级返回。
  const askSessionGroup = async (
    payload: Record<string, unknown>,
    timeoutMs = SESSION_GROUP_TIMEOUT_MS,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `sess_group_${Date.now()}_${++aiSeq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingSessionGroup.delete(id)
        resolve({ ok: false, error: '会话分组读取超时：请查看导出日志排查 host 状态' })
      }, timeoutMs)
      pendingSessionGroup.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v as { ok: boolean; result?: unknown; error?: string }) },
      })
      hostProcess!.send({ type: 'sessionGroup.request', id, ...payload })
    })
  }

  ipcMain.handle('sessionGroup:list', async (_e, limit?: number) =>
    askSessionGroup({ op: 'list', limit: typeof limit === 'number' ? limit : 50 }))
  ipcMain.handle('sessionGroup:create', async (_e, title: string, color?: string) =>
    askSessionGroup({ op: 'create', title, color }))
  ipcMain.handle('sessionGroup:update', async (_e, groupId: string, patch: { title?: string; color?: string }) =>
    askSessionGroup({ op: 'update', groupId, patch }))
  ipcMain.handle('sessionGroup:delete', async (_e, groupId: string) =>
    askSessionGroup({ op: 'delete', groupId }))
  ipcMain.handle('sessionGroup:move', async (_e, sessionId: string, groupId: string | null, projectKey?: string) =>
    askSessionGroup({ op: 'move', sessionId, groupId, projectKey }))
  ipcMain.handle('sessionGroup:reorder', async (_e, order: string[]) =>
    askSessionGroup({ op: 'reorder', order }))
  ipcMain.handle('sessionGroup:import', async (_e, groups: unknown[], assignments: Record<string, string>) =>
    askSessionGroup({ op: 'import', groups, assignments }))

  // 新建会话 — 同 session:list 链路：host 直调 sessionPersistence.persistSession
  // （CH-2），空消息 + cwd/projectDir 元数据落盘，返回新 sessionId。
  ipcMain.handle('session:create', async (e, workspacePath?: string) => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `sess_create_${Date.now()}_${++aiSeq}`
    const cwd = typeof workspacePath === 'string' && workspacePath ? workspacePath : process.cwd()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingSessionCreate.delete(id)
        resolve({ ok: false, error: '会话创建超时：请查看导出日志排查 host 状态' })
      }, 15000)
      pendingSessionCreate.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
      })
      hostProcess!.send({ type: 'session.create', id, cwd })
    })
  })

  // 会话消息 — 点击侧栏任务 / 「重载会话」时加载该会话的真实消息流。
  // 同 session:list 链路：host 直调 sessionPersistence.restoreSession（CH-2），
  // 返回 { sessionId, title, model, messages[] }。没有这条通道时点会话只换高亮
  // 不换内容（复刻端侧栏「跳转」形同虚设）。
  // messages 元素形如 { role, content, timestamp, reasoning }：content 是拍平后的
  // 正文字符串，reasoning 是思维链全文字符串（host 侧独立字段，不并进 content）。
  // 这里 resolve 的是整个 host 消息对象，不做字段裁剪，renderer 原样收到。
  ipcMain.handle('session:messages', async (e, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return { ok: false, messages: [], error: '会话 ID 为空：请先在左侧任务列表中选择一个会话' }
    }
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, messages: [], error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `sess_msgs_${Date.now()}_${++aiSeq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingSessionMessages.delete(id)
        resolve({ ok: false, messages: [], error: '会话内容读取超时：请查看导出日志排查 host 状态' })
      }, 15000)
      pendingSessionMessages.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
      })
      hostProcess!.send({ type: 'session.messages', id, sessionId })
    })
  })

  // host 进程状态
  ipcMain.handle('host:status', async () => {
    return { running: !!hostProcess, pid: hostProcess?.pid }
  })

  // Token 用量 — 转发给 host 进程，host 动态 require KhyOS 后端
  // tokenUsageService（CH-2），替代 UI 侧的自造假数据（ZC-ALIGN-001 P3-3）。
  ipcMain.handle('token:usage', async (e) => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, usage: null, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `token_usage_${Date.now()}_${++aiSeq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingTokenUsage.delete(id)
        resolve({ ok: false, usage: null, error: 'Token 用量读取超时：请查看导出日志排查 host 状态' })
      }, 15000)
      pendingTokenUsage.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
      })
      hostProcess!.send({ type: 'token.usage', id })
    })
  })

  // 用量历史（近 N 日 + 按模型分桶）—转发给 host，host 读后端
  // tokenUsageService.getUsageHistory/getModelUsage/getCostCoverage/getUsageFileStamp（CH-2）。
  // 后端真源已兑现这四个导出；host 侧对后端新增导出一律有 typeof 兜底，
  // 所以本 handler 不做字段白名单（entry.resolve(m) 是整条原样透传）。
  ipcMain.handle('usage:history', async (_e, days?: number) => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, history: null, models: null, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `usage_history_${Date.now()}_${++aiSeq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingUsageHistory.delete(id)
        resolve({ ok: false, history: null, models: null, error: '用量历史读取超时：请查看导出日志排查 host 状态' })
      }, 15000)
      pendingUsageHistory.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
      })
      hostProcess!.send({ type: 'usage.history', id, days: typeof days === 'number' && days > 0 ? Math.floor(days) : 30 })
    })
  })

  // 用量历史导出 CSV。CSV 字符串由渲染层拼（数据已在它内存里），本侧只负责落盘。
  //
  // **文件名完全由 main 自拼**（usage-YYYYMMDD-HHmm.csv），忽略渲染层传来的任何内容：
  // 渲染层能给的只是路径，而 dataHomeFile(name) 只是 path.join(getDataHome(), name)
  // —— '../../' 会原样出去。health:audit-export(dest) 更宽（path.resolve + mkdir -p
  // + writeFile 的任意路径写入，见 keyManager/audit.ts:55-64），那是反面先例：
  // 只抄「main 落盘」这个形状，不抄「渲染层给路径」。
  ipcMain.handle('usage:exportCsv', async (_e, csv: string) => {
    if (typeof csv !== 'string' || !csv.trim()) {
      return { ok: false, error: '导出失败：CSV 内容为空，请先加载用量数据后重试' }
    }
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const fileName = `usage-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.csv`
    const dest = path.join(getDataHome(), fileName)
    try {
      await fs.promises.mkdir(getDataHome(), { recursive: true })
      await fs.promises.writeFile(dest, csv, 'utf-8')
      return { ok: true, fileName, path: dest }
    } catch (e) {
      return { ok: false, error: `导出失败（${e instanceof Error ? e.message : String(e)}）：请检查数据目录 ${getDataHome()} 是否可写` }
    }
  })

  // 运行中后台任务计数（P3-6①）— 转发给 host，host 统计在途 ai.generate
  // （含自动化运行，其 hostReqId 也落在 host 侧 activeGenerations 集合）。
  // Composer「打开运行中的后台任务」按钮数据源；count=0 时 UI 隐藏按钮，
  // 与 ZCode 实测空态行为一致（i18n chat.composer.backgroundWorks 模板）。
  ipcMain.handle('background:status', async () => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, status: null, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `bg_status_${Date.now()}_${++aiSeq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingBackgroundStatus.delete(id)
        resolve({ ok: false, status: null, error: '后台任务计数读取超时：请查看导出日志排查 host 状态' })
      }, 15000)
      pendingBackgroundStatus.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
      })
      hostProcess!.send({ type: 'background.status', id })
    })
  })

  // 电脑控制安全闸生效状态 — 从 host 读回当前真实 env（设置页展示后端
  // 实际生效的 mode/预算/白名单，而非渲染进程自报的写入值）。
  ipcMain.handle('desktopGate:get', async () => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, gate: null, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `desktop_gate_${Date.now()}_${++aiSeq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingDesktopGate.delete(id)
        resolve({ ok: false, gate: null, error: '安全闸状态读取超时：请查看导出日志排查 host 状态' })
      }, 15000)
      pendingDesktopGate.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
      })
      hostProcess!.send({ type: 'desktopGate.get', id })
    })
  })

  // 上下文窗口估算 — 转发给 host，host 用后端 tokenUsageService.estimateTokens
  // （与 /cost 同源启发式）估算当前会话 token 数 + 上下文窗口上限（ZC-ALIGN-001 P3-5/P3-6）。
  ipcMain.handle('context:size', async (_e, text?: string, model?: string) => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, estimate: null, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `ctx_size_${Date.now()}_${++aiSeq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingContextSize.delete(id)
        resolve({ ok: false, estimate: null, error: '上下文估算超时：请查看导出日志排查 host 状态' })
      }, 15000)
      pendingContextSize.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
      })
      hostProcess!.send({ type: 'context.size', id, text: typeof text === 'string' ? text : '', model: typeof model === 'string' ? model : '' })
    })
  })

  // 模型/provider 列表 — 转发给 host，host 用后端 providerPresets.getProviderPresets()
  // （模型选择器真源，CH-2，ZC-ALIGN-001 P3-7）。
  ipcMain.handle('models:list', async () => {
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, models: [], error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    const id = `models_list_${Date.now()}_${++aiSeq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingModelList.delete(id)
        resolve({ ok: false, models: [], error: '模型列表读取超时：请查看导出日志排查 host 状态' })
      }, MODELS_LIST_TIMEOUT_MS)
      pendingModelList.set(id, {
        resolve: (v: unknown) => { clearTimeout(timer); resolve(v) },
      })
      hostProcess!.send({ type: 'models.list', id })
    })
  })

  // ── 自动化（定时任务）— store 落盘 + 调度 tick + 经 host ai.generate 执行 ──
  ipcMain.handle('automation:list', async () => {
    return { ok: true, automations: await getAutomations() }
  })
  ipcMain.handle('automation:create', (_e, input: Parameters<typeof createAutomation>[0]) => createAutomation(input || {}))
  ipcMain.handle('automation:update', (_e, id: string, patch: Parameters<typeof updateAutomation>[1]) =>
    updateAutomation(id, patch || {})
  )
  ipcMain.handle('automation:delete', (_e, id: string) => deleteAutomation(id))
  ipcMain.handle('automation:runNow', (_e, id: string) => fireAutomation(id, 'manual'))

  // ── 插件设置页 — pluginStore 落盘（registry + 启用态 + 卸载 + 检查更新）──
  ipcMain.handle('plugin:list', async () => {
    return { ok: true, plugins: await getPlugins() }
  })
  ipcMain.handle('plugin:install', (_e, input: Parameters<typeof installPlugin>[0]) =>
    installPlugin(input || {})
  )
  ipcMain.handle('plugin:setEnabled', (_e, id: string, enabled: boolean) => setPluginEnabled(id, enabled))
  ipcMain.handle('plugin:uninstall', (_e, id: string) => uninstallPlugin(id))
  ipcMain.handle('plugin:checkUpdates', async () => checkPluginUpdates())
  // 发现 tab — 多生态勘察编目（delivery/market，只读）。force 跳过服务端 TTL。
  ipcMain.handle('plugin:ecoMarket', async (_e, force?: boolean) => getEcoMarketCatalog(!!force))
  // 发现 tab — 条目安装/卸载（技能目录与 mcp.json 由后端服务写入，台账记住产物）
  ipcMain.handle('plugin:marketInstall', async (_e, entry: Record<string, unknown>, values?: Record<string, unknown>) =>
    installEcoMarketEntry(entry || {}, values)
  )
  ipcMain.handle('plugin:marketUninstall', async (_e, entry: Record<string, unknown>) =>
    uninstallEcoMarketEntry(entry || {})
  )

  // ── MCP 设置页 — mcpStore 落盘（用户自建服务器：新建/启用/删除/导入）──
  // 插件宿主区不在此列：宿主服务器由 plugin:list 按 components.mcp>0 派生（只读）。
  ipcMain.handle('mcp:list', async () => {
    return { ok: true, servers: await getMcpServers() }
  })
  ipcMain.handle('mcp:create', (_e, input: Parameters<typeof createMcpServer>[0]) => createMcpServer(input || {}))
  ipcMain.handle('mcp:setEnabled', (_e, id: string, enabled: boolean) => setMcpServerEnabled(id, enabled))
  ipcMain.handle('mcp:delete', (_e, id: string) => deleteMcpServer(id))
  ipcMain.handle('mcp:import', (_e, rows: unknown) => importMcpServers(rows))

  // ── Agent 扩展条目（命令/钩子/技能/子智能体/记忆）— agentItemStore 正门 ──
  // 列表页 Pattern-B 六页的 CRUD + 导入；kind 由 preload 传入（command/hook/
  // skill/subagent/memory），store 侧白名单校验。
  ipcMain.handle('agent:list', (_e, kind: string) => listItems(kind))
  ipcMain.handle('agent:create', (_e, kind: string, input: unknown) => createItem(kind, input))
  ipcMain.handle('agent:setEnabled', (_e, kind: string, id: string, enabled: boolean) =>
    setItemEnabled(kind, id, enabled))
  ipcMain.handle('agent:delete', (_e, kind: string, id: string) => deleteItem(kind, id))
  ipcMain.handle('agent:import', (_e, kind: string, rows: unknown) => importItems(kind, rows))

  // ── 索引库页 — indexStore（真实磁盘扫描统计）──
  ipcMain.handle('index:list', async () => listIndexes())
  ipcMain.handle('index:create', (_e, input: unknown) => createIndex(input))
  ipcMain.handle('index:rebuild', (_e, id: string) => rebuildIndex(id))
  ipcMain.handle('index:setEnabled', (_e, id: string, enabled: boolean) => setIndexEnabled(id, enabled))
  ipcMain.handle('index:delete', (_e, id: string) => deleteIndex(id))

  // ── 外部 Agent 迁移（引导弹窗「数据迁移向导」，D5/s-8）— 只读扫描 +
  //    导入到 agent_items.json；数据根路径只读查询（Rule 1：不硬编码路径）──
  ipcMain.handle('migration:scan', async () => scanMigrations())
  ipcMain.handle('migration:import', (_e, sourceId: string) => importMigration(sourceId))
  ipcMain.handle('app:dataHome', () => migrationDataHome())

  // ── 审查面板（Git 状态）— 只读 git status -z --branch，作用于当前工作区 cwd ──
  // 结果四态：ok（含改动）/ notRepository / gitUnavailable（本机无 git.exe，
  // 诚实呈现 git.empty.gitUnavailable* 文案）/ error。只读短 I/O 超时属 Rule 3
  // 合法例外（防挂死的探测调用，非长任务截止）。
  ipcMain.handle('git:status', async () => {
    const cwd = process.cwd()
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile('git', ['status', '--porcelain=v1', '-z', '--branch'], { cwd, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
          if (err) reject(err)
          else resolve(out)
        })
      })
      return parseGitStatus(stdout)
    } catch (err) {
      const e = err as { code?: string; stderr?: string; message?: string }
      // spawn ENOENT: no git binary on this machine — distinct from not-a-repo
      if (e.code === 'ENOENT') {
        return { ok: false, state: 'gitUnavailable' as const }
      }
      // fatal: not a git repository (or any of the parent directories)
      if (typeof e.stderr === 'string' && /not a git repository/i.test(e.stderr)) {
        return { ok: false, state: 'notRepository' as const }
      }
      // 128 with the repo detection phrase is the same not-a-repo outcome
      if (e.code === '128' && typeof e.message === 'string' && /not a git repository/i.test(e.message)) {
        return { ok: false, state: 'notRepository' as const }
      }
      return { ok: false, state: 'error' as const, error: e.stderr?.trim() || e.message || 'git status 执行失败' }
    }
  })

  // ── 窗口菜单动作（L 区对齐：自绘下拉，替代原生菜单栏）──
  // https 一律放行；http 只放回环（网页版默认同源后端地址就是 http://127.0.0.1）。
  // 放开整个 http 等于给任意 http 页面一个从桌面端被打开的入口，仍然只放回环。
  const isAllowedExternalUrl = (raw: string): boolean => {
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      return false
    }
    if (parsed.protocol === 'https:') return true
    if (parsed.protocol === 'http:') return LOOPBACK_HOSTNAMES.has(parsed.hostname)
    return false
  }
  ipcMain.handle('app:openExternal', async (_e, url: string) => {
    if (typeof url !== 'string' || !isAllowedExternalUrl(url)) {
      return {
        ok: false,
        error: '仅允许 https 链接与本机回环 http：已拒绝其它协议的打开请求',
      }
    }
    await shell.openExternal(url)
    return { ok: true }
  })
  // 网页版地址：设置里填了就用设置，否则用本机网页版端口。网页 UI 不在后端
  // 端口上 —— 它由 `khy gateway manage start` 的 daemon 在 WEB_FRONTEND_PORT
  // 托管 delivery/web/ai-frontend/dist 并反代 API；后端 3000 只服务 API 与
  // （已不存在的）runtime/node/frontend/dist。端口读 serviceDefaults，不写死。
  ipcMain.handle('app:webVersion', async () => {
    let configured = ''
    try {
      const settings = (await getSettingsStore()) as unknown as Record<string, unknown>
      if (typeof settings.webVersionUrl === 'string') configured = settings.webVersionUrl.trim()
    } catch {
      /* fail-soft：读不到设置就退默认地址 */
    }
    if (configured) return { ok: true, url: configured, source: 'settings' as const }
    try {
      const sd = nodeRequire(
        path.join(resolveKhyOsRoot(), 'runtime', 'node', 'backend', 'src', 'constants', 'serviceDefaults.js')
      )
      return { ok: true, url: `http://127.0.0.1:${sd.WEB_FRONTEND_PORT}`, source: 'default' as const }
    } catch (err) {
      return { ok: false, error: `网页版地址不可用：serviceDefaults 加载失败（${String((err as Error)?.message || err)}）` }
    }
  })
  // 下载入口：本机有产物就直接把文件亮出来（不执行安装器），没有产物就打开
  // 发布页；两样都没有就如实说清楚缺什么、怎么补。绝不打开一个假地址。
  ipcMain.handle('app:downloadArtifact', async (_e, platform: string) => {
    if (platform !== 'android' && platform !== 'windows') {
      return { ok: false, error: `未知下载目标「${String(platform)}」：只支持 android / windows` }
    }
    const label = platform === 'android' ? 'Android 安装包（APK）' : 'Windows 安装包'
    let catalog: { latestArtifact: (p: string) => { fileName: string; fullPath: string } | null; releasePageUrl: (env: unknown) => string | null }
    try {
      catalog = nodeRequire(
        path.join(resolveKhyOsRoot(), 'runtime', 'node', 'backend', 'src', 'services', 'downloadsCatalog.js')
      )
    } catch (err) {
      return { ok: false, error: `下载清单不可用：${String((err as Error)?.message || err)}` }
    }
    const artifact = catalog.latestArtifact(platform)
    if (artifact) {
      shell.showItemInFolder(artifact.fullPath)
      return { ok: true, state: 'local' as const, fileName: artifact.fileName, filePath: artifact.fullPath }
    }
    const releasePage = catalog.releasePageUrl(process.env)
    if (releasePage) {
      await shell.openExternal(releasePage)
      return { ok: true, state: 'release' as const, url: releasePage }
    }
    return {
      ok: false,
      state: 'missing' as const,
      error: `本机没有${label}，也没有配置发布页：先构建该端，或设置 KHY_DOWNLOAD_GITHUB_REPOSITORY / KHY_DOWNLOAD_${platform.toUpperCase()}_DIR 后重试`,
    }
  })
  ipcMain.handle('app:openPath', async (_e, dir: string) => {
    if (typeof dir !== 'string' || !dir.trim()) {
      return { ok: false, error: '路径为空：请先选择工作区' }
    }
    const err = shell.openPath(dir)
    return err ? { ok: false, error: `无法打开目录 ${dir}：${err}` } : { ok: true }
  })
  // 「在编辑器中打开」（appHeader D6 / D9）。编辑器来自 settings.desktopEditor
  // 或 KHY_EDITOR env（零硬编码：源码里没有字面量编辑器名/路径）。两者都未
  // 配置时如实说明怎么配，而不是静默无响应或改开资源管理器。
  ipcMain.handle('app:openInEditor', async (_e, target?: string) => {
    let editor = ''
    try {
      const settings = await getSettingsStore()
      if (typeof settings.desktopEditor === 'string') editor = settings.desktopEditor.trim()
    } catch {
      /* fail-soft */
    }
    if (!editor) editor = (process.env.KHY_EDITOR || '').trim()
    if (!editor) {
      return {
        ok: false,
        state: 'unconfigured' as const,
        error: '未配置编辑器：请在「设置 → 常规」填写编辑器命令，或设置 KHY_EDITOR 环境变量（例如 code），然后重试',
      }
    }
    const dir = typeof target === 'string' && target.trim() ? target.trim() : await getWorkspaceRoot()
    return new Promise((resolve) => {
      try {
        const child = execFile(editor, [dir], { windowsHide: true }, (err) => {
          if (err) resolve({ ok: false, error: `编辑器 "${editor}" 启动失败：${err.message}` })
        })
        child.unref()
        // execFile 的 error 回调只在启动失败时触发；resolve 成功路径用一次性定时器
        // 兜底（短 I/O 探针，非长任务截止 —— Rule 3 合规）
        setTimeout(() => resolve({ ok: true, editor, target: dir }), 600)
      } catch (err) {
        resolve({ ok: false, error: `编辑器 "${editor}" 启动失败：${String((err as Error)?.message || err)}` })
      }
    })
  })
  // 进程监视器（窗口菜单 → 进程监视器，ZCode M1）。返回 main/host/scheduler
  // 的真实 pid 与存活状态，供 renderer 的监视器弹窗渲染（不再是 disabled 死项）。
  ipcMain.handle('app:processInfo', async () => {
    const mem = process.memoryUsage()
    return {
      ok: true,
      main: { pid: process.pid, rssBytes: mem.rss, uptimeMs: Math.round(process.uptime() * 1000) },
      host: { pid: hostProcess?.pid ?? null, alive: Boolean(hostProcess?.connected) },
      scheduler: { pid: schedulerProcess?.pid ?? null, alive: Boolean(schedulerProcess?.connected) },
      rendererCount: BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length,
      platform: `${os.platform()} ${os.release()}`,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    }
  })
  // First-party URLs come from servicesDefaults (single truth source); main
  // resolves it via KHY_OS_DIR / relative fallback, same as the host bridge.
  // 相对回退的基准是 out/main（`__dirname`），到仓库根要**上溯 4 级**
  // （out/main → out → khyos-desktop → apps → <repo>）；此前写 3 级会停在
  // `<repo>/apps`，叠加迁移前的旧路径段后整行恒不可达。
  ipcMain.handle('app:brandingLinks', async () => {
    try {
      const sd = nodeRequire(path.join(resolveKhyOsRoot(), 'runtime', 'node', 'backend', 'src', 'constants', 'serviceDefaults.js'))
      const host = sd.CLOUD_DEFAULT_HOST || ''
      return {
        ok: true,
        cloudHost: host,
        feedback: host ? `https://${host}/feedback` : '',
        docs: host ? `https://${host}/docs` : '',
        community: host ? `https://${host}/community` : '',
        issues: host ? `https://${host}/issues` : '',
      }
    } catch (err) {
      return { ok: false, error: `品牌链接真源不可用：${String((err as Error)?.message || err)}` }
    }
  })
  // 停止等待：放弃 pending 请求（底层 HTTP 无法中断，UI 立即恢复并如实说明）
  // 人在环应答（P1）：renderer 的审批 / 提问回答 → host → toolUseLoop 的
  // onControlRequest promise。这里只做透传，不做语义校验 —— {behavior} 三态
  // 解码在后端解码器、超时 fail-closed 在 host 侧，两层兜底不在 main 重复造。
  ipcMain.handle('ai:controlResponse', (_e, payload: { id?: string; requestId?: string; response?: unknown }) => {
    const id = payload?.id
    const requestId = payload?.requestId
    if (typeof id !== 'string' || !id || typeof requestId !== 'string' || !requestId) {
      return { ok: false, error: '应答缺少 id 或 requestId：请重试' }
    }
    if (!hostProcess || !hostProcess.connected) {
      return { ok: false, error: 'host 进程未启动：请重启 KhyOS Desktop 后重试' }
    }
    hostProcess.send({ type: 'ai.controlResponse', id, requestId, response: payload?.response })
    return { ok: true }
  })

  ipcMain.handle('ai:abort', async (e) => {
    let aborted = 0
    const senderWin = BrowserWindow.fromWebContents(e.sender)
    for (const [id, entry] of pendingAi) {
      if (entry.win === senderWin) {
        pendingAi.delete(id)
        // 真的中断 host 侧的工具循环（abortSignal），而不只是本地丢弃结果：
        // 否则用户点了停止，in-flight 的 Bash / 写文件仍会在后台跑完。
        if (hostProcess && hostProcess.connected) {
          try {
            hostProcess.send({ type: 'ai.abort', id })
          } catch {
            /* host 已断开：本地丢弃已足够 */
          }
        }
        entry.resolve({ ok: false, error: '已停止：本轮工具执行已请求中断，已产生的中间结果将被丢弃' })
        aborted++
      }
    }
    return { ok: true, aborted }
  })

  return win
}

app.whenReady().then(() => {
  // 没拿到单实例锁的进程已经在上面 app.quit()；这里再挡一道，保证它连
  // host/scheduler 子进程都不会起（quit 是异步的，不能假设 ready 一定不触发）。
  if (!hasSingleInstanceLock) return

  // Key/Endpoint Manager IPC (DESIGN-ARCH-091 §6) — global, registered once
  registerKeyManagerIpc(ipcMain)

  // [DESIGN-ARCH-091] §5.1 入口①「主窗菜单 → 密钥与端点管理」：打开独立管理窗口。
  // 此前该入口只存在于 src/main/menu.ts 的菜单项里，而那份菜单从未接线 —— 独立
  // 管理窗口除 `--key-manager` 启动（入口③）外无路可入。入口②（设置页内嵌）一直是
  // 通的，缺的是这个独立窗口入口。键位 Ctrl+Shift+K 沿用 091/旧菜单的既有值。
  ipcMain.handle('keymanager:openWindow', () => {
    openKeyManagerWindow()
  })

  // 窗口级键位（F11 全屏 / F12 开发者工具）：原先只写在 src/main/menu.ts 的菜单项里，
  // 而那份菜单从未被 import、又被 Menu.setApplicationMenu(null) 摘掉 —— 两个键在整个
  // 应用里都没有第二条实现路径，等于不存在（[DESIGN-ARCH-125] §5.2 step 4 删除分支，
  // 现状迁到这里）。注册点选在 whenReady 而非 createWindow：这样 `--key-manager`
  // 独立启动（入口③，不建主窗）时同样可用；目标窗口一律取**发起方**窗口，
  // 而不是闭包里捕获的主窗 —— 否则在密钥管理窗按 F11 会去全屏主窗。
  // minimize/maximize/close 同此一条规矩（密钥管理窗右上角 ✕「没有用」）：原先它们
  // 注册在 createWindow 内、目标是闭包里的 win，于是 ① 独立启动时通道根本没注册，
  // ✕ 按下去是个「No handler registered」的空 reject；② 从主窗菜单打开时 ✕ 关掉的
  // 是主窗，管理窗留在原地。按钮在哪个窗，就该关哪个窗。
  const senderWindow = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender)
  ipcMain.handle('window:minimize', (e) => senderWindow(e)?.minimize())
  ipcMain.handle('window:maximize', (e) => {
    const target = senderWindow(e)
    if (!target) return false
    if (target.isMaximized()) target.unmaximize()
    else target.maximize()
    return target.isMaximized()
  })
  ipcMain.handle('window:close', (e) => senderWindow(e)?.close())
  ipcMain.handle('window:toggleFullScreen', (e) => {
    const target = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getAllWindows()[0]
    if (!target) return false
    target.setFullScreen(!target.isFullScreen())
    return target.isFullScreen()
  })
  ipcMain.handle('devtools:toggle', (e) => {
    const target = BrowserWindow.fromWebContents(e.sender)
    target?.webContents.toggleDevTools()
  })

  // ── 真终端 PTY（[DESIGN-ARCH-176] A3）：handle 必须字面写在本文件 ——
  // desktopUiContract D6 扫描本文件的 handle 字面量做 preload↔main 配对，
  // 实现体在 ./ptyHost（懒加载 @lydell/node-pty，fail-soft）。
  ipcMain.handle('pty:create', (e, opts) => ptyCreate(opts || {}, e.sender))
  ipcMain.handle('pty:write', (e, id, data) => ptyWrite(id, data, e.sender))
  ipcMain.handle('pty:resize', (e, id, cols, rows) => ptyResize(id, cols, rows, e.sender))
  ipcMain.handle('pty:kill', (e, id) => ptyKill(id, e.sender))

  if (KEY_MANAGER_STANDALONE) {
    // standalone entry: `npm run dev -- --key-manager` — only the manager
    // window is created, no main window / host process (spec §5.1 入口③)
    openKeyManagerWindow({ standalone: true })
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openKeyManagerWindow({ standalone: true })
    })
    return
  }

  startHostProcess()
  startSchedulerProcess()
  // 自动化调度：先算一次 nextRunAt（老数据可能缺该字段），再启动周期 tick
  void (async () => {
    const list = await getAutomations()
    for (const a of list) {
      if (a.enabled && a.nextRunAt === null) {
        await updateAutomation(a.id, {})
      }
    }
  })()
  startAutomationScheduler()
  void createWindow()
  // Frameless, no native menu bar — actions live in the TitleBar 窗口菜单
  // dropdown (L 区对齐). Menu items fire via IPC (menu:new-task etc.) which
  // createWindow registers on every window.
  Menu.setApplicationMenu(null)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// 第二个实例唯一的职责：把「用户又点了一次图标」翻译成「把已有窗口拿到前面」。
// 不重建窗口、不重启 host/scheduler —— 那些只属于持有锁的那一个进程。
// 带 --key-manager 的第二次启动是「打开管理窗」的意图，不该抢主窗焦点。
if (hasSingleInstanceLock) {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--key-manager')) {
      openKeyManagerWindow({ standalone: KEY_MANAGER_STANDALONE })
      return
    }
    const target =
      mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!target) {
      // 窗口全关了但进程还活着（macOS 语义）：补一个，等同 activate。
      void createWindow()
      return
    }
    if (target.isMinimized()) target.restore()
    target.show()
    target.focus()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    settleAutomationRunsOnQuit()
    app.quit()
  }
})

app.on('will-quit', () => {
  settleAutomationRunsOnQuit()
  // PTY 子进程（shell）不随父进程自退，必须显式杀（ptyHost.ts 同策略）
  try {
    disposeAllPtys()
  } catch {
    /* already gone */
  }
  // 远程控制是主进程持有的监听 socket：退出前显式停，手机侧收到 KICKED 而不是悬空。
  try {
    void remoteHub?.stop()
  } catch {
    /* already stopped */
  }
  // 子进程随应用退出（scheduler 也会在 IPC disconnect 时自退，这里是双保险）
  try {
    schedulerProcess?.send?.({ type: 'shutdown' })
  } catch {
    /* already gone */
  }
})
