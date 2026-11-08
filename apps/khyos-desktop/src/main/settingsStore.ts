// settingsStore — file-backed settings persistence for the main process.
//
// Stores all app settings (locale, theme, data path, toggles, proxy, terminal,
// etc.) in a single settings.json under the BASE dataHome (env/portable/repo/
// homedir chain from keyStore — never the dataPath-diverted effective home:
// settings.json holds the dataPath pointer itself, so it must stay findable at
// boot before the effective home is known). Atomic write + defaults merge; read
// is cached in-memory after first load and invalidated on write.
//
// This replaces the stub handlers in index.ts (ZC-ALIGN-003: "backend wired").

import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { baseHomeFile, SETTINGS_FILE } from './keyManager/keyStore'

function settingsPath(): string {
  // Base home, NOT the dataPath-diverted effective home (see file header):
  // settings.json holds the dataPath pointer itself, so it must stay findable
  // at boot before the effective home is known.
  return baseHomeFile(SETTINGS_FILE)
}

async function ensureDir(): Promise<void> {
  const dir = path.dirname(settingsPath())
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true })
  }
}

// Default settings — mirrors the stub return + ZCode v3.11.2 a11y defaults
const DEFAULTS: Record<string, unknown> = {
  locale: 'system',
  theme: 'dark',
  dataPath: '',
  archiveRetention: '7d',
  autoArchive: true,
  groupFileChanges: true,
  groupTerminalCommands: true,
  groupExploreTools: true,
  showTodo: false,
  showReasoning: true,
  keepFullModelIO: false,
  autoContinueQuestions: true,
  interactionBehavior: 'queue',
  preventIdleSleep: false,
  hideToTray: false,
  notificationSound: true,
  taskNotifications: true,
  autoUpdate: false,
  prereleaseUpdates: false,
  hardwareAcceleration: true,
  customCert: '',
  noProxy: '',
  httpProxy: '',
  enhancedFindGrep: false,
  terminalShell: 'auto',
  terminalFont: '',
  inheritTerminalProfile: true,
  optInExperience: false,
  // Appearance: message body font size consumed via --khy-message-font-size
  // CSS var on <html> (MarkdownRenderer); CUA dispatch interval in ms.
  messageFontSize: '14',
  cuaActionInterval: '500',
  // Model selection (P3-7②): option id (`<provider>` or `<provider>/<model>`)
  // persisted by the renderer via setSetting; empty string = no selection yet.
  selectedModel: '',
  // Workspace root chosen via 窗口菜单 → 打开工作区 / 侧栏 添加项目. Empty
  // string = no explicit choice yet, main falls back to process.cwd()
  // (getWorkspaceRoot in index.ts). Single source for the workspace chip, the
  // file tree and workspace:listFiles — one value, no divergent copies.
  desktopWorkspacePath: '',
  // 最近打开的工作空间（[DESIGN-ARCH-125] P-02）：MRU 候选集，上限 8。
  // 它**不是**第二个真源 —— 「当前是哪个工作空间」仍只由 desktopWorkspacePath
  // 回答，本字段只回答「可以切到哪几个」，供卡片/标题栏的选择器列出最近目录，
  // 免去每次切换都弹系统目录框。读取侧（workspace:list）会过滤掉已不存在的
  // 路径：列出来的项必须真的能切过去，不做死链陈列。
  desktopRecentWorkspaces: [],
  // 项目登记（[DESIGN-ARCH-177] §3.1）：数组，每项 { path, name, icon?, color? }。
  // 解决侧栏「项目」tab 的可辨识性崩塌 —— 旧实现拿会话 workspacePath 的**路径末段**
  // 当项目名，于是父目录（D:\Portable → "Portable"）与仓外临时目录
  // （khy-durable-transcript-*）都冒充项目，且同名项目无法区分。
  // path 是分桶键（**精确匹配，非前缀**：登记 D:\a\b 不会让 D:\a\b\c 继承身份）。
  // name 是用户可写的显示名，允许与目录名不同 —— 这是「显示名 ≠ 目录名」的关键。
  // icon / color 可选，缺省即不渲染标识（不给假数据）。
  // ⚠ 消费方是渲染层 shared/sidebarProjectClassify.ts 的三态判定；**不参与**
  // 「当前工作空间是谁」—— 那仍只由 desktopWorkspacePath 回答。
  desktopProjects: [],
  // Agent 模式（Composer 工具行「切换模式」选择器，i18n mode.label.glm.*）：
  // 'confirm' | 'autoEdit' | 'plan' | 'fullAccess'
  // P3-9①：默认对齐 ZCode 实测「完全访问」（mode.label.glm.yolo）；
  // 用户显式切换后经 setSetting 落盘覆盖此默认值。
  desktopAgentMode: 'fullAccess',
  // 桌宠角色（设置 → 常规 → 桌宠 的三选一）：'female' | 'male' | 'koi'。
  // 真源在这里，不在渲染层的 localStorage —— 否则设置页与桌宠各存一份，
  // 就是 settingsStore 文件头警告的「第二个真源」。
  // 消费方：renderer/components/pet/KhyPet.tsx（角色图、台词、抽签内容）。
  desktopPetCharacter: 'female',
  // 账号用户名（本地模式下没有登录，就是用户自报的名字）。空串 = 用渲染层
  // 的默认名「本地用户」。消费方：消息头用户轮、侧栏与设置页的账号块
  // （renderer/shared/chatIdentity.ts 是唯一的读取层）。
  desktopAccountName: '',
  // 账号头像：原文件的绝对路径（空串 = 回落到桌宠立绘的默认头像）。
  // 渲染层不存副本，只按路径经 fs:readImageDataUrl 取 data URL —— 换头像
  // 只改这一个文件即可；文件被移走时回落到桌宠立绘，不静默空白。
  // 消费方：renderer/shared/accountAvatar.ts（唯一的读取层）。
  desktopAccountAvatar: '',
  // 自定义桌宠名：填了就用它当消息头里的助手名字（自建桌宠/DIY 命名），
  // 空串 = 按 desktopPetCharacter 从角色表派生「khy · 澪 · 引导者」。
  desktopPetName: '',
  // 桌宠形态：'relief' = 立绘浮雕（定妆照烘出的带厚度浮雕，最像，默认）
  // / 'model' = 真 3D Q 版模型 / 'realistic' = 写实真人 3D 模型（外部 AI 3D 服务出模）。
  // 消费方：renderer/components/pet/KhyPet.tsx（卡片上的形态切换按钮）。
  desktopPetForm: 'relief',
  // Editor binary for 在编辑器中打开 (e.g. "code"). Empty = fall back to
  // KHY_EDITOR env; both empty → the action reports how to configure it.
  desktopEditor: '',
  // 网页版地址（窗口菜单 → 打开网页版）。空 = 本机后端同源地址，端口取自
  // backend serviceDefaults，不在渲染层写死。
  webVersionUrl: '',
  // Window geometry
  desktopWindowSize: { width: 1216, height: 808, maximized: false },
}

let cache: Record<string, unknown> | null = null

export async function getSettingsStore(): Promise<Record<string, unknown>> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(settingsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    // Merge: defaults ← stored (stored wins)
    cache = { ...DEFAULTS, ...parsed }
  } catch {
    // File missing or invalid → use defaults
    cache = { ...DEFAULTS }
  }
  return cache
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const current = await getSettingsStore()
  current[key] = value
  cache = current
  await ensureDir()
  // Atomic write: write to .tmp then rename
  const tmpPath = settingsPath() + '.tmp'
  await fs.writeFile(tmpPath, JSON.stringify(current, null, 2), 'utf-8')
  await fs.rename(tmpPath, settingsPath())
}

export async function getTheme(): Promise<string> {
  const settings = await getSettingsStore()
  return (settings.theme as string) || 'dark'
}

export async function setTheme(mode: string): Promise<void> {
  await setSetting('theme', mode)
}
