// slashCommandMerge — khy 斜杠命令面接入桌面的纯逻辑叶（零 IO / 零 electron / 不抛）。
// main 侧 slashCommandSources.ts 消费；tests/slashCommandMerge.test.cjs 经
// ts.transpileModule 直接单测（compactNumber.test.cjs 成例）。
//
// runnable 分类与执行通道一一对应（执行体在 slashCommandSources.runSlashCommand）：
//   routed → main 进程 router.parseInput + route() 执行并回收输出
//   prompt → 读技能/CC 命令正文拼成一条 AI 消息（replSession 同语义），渲染层经 aiSend 发送
//   cc     → 维持桌面现状：插文本，用户回车后原文经 aiSend 发给模型
//   none   → 执行体在终端 REPL 闭包里（思考档/vim/全屏面板等会话状态），桌面无通道
//            —— 不渲染可点项，输入时诚实报错（不把命令原文当普通文本发给模型）

export type SlashRunnable = 'routed' | 'prompt' | 'cc' | 'none'

export interface SlashCommandRow {
  cmd: string
  label: string
  desc: string
  route: string | null
  flag: string | null
  category: string
  _skillDir?: string | null
  _commandFile?: string | null
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

export function classifySlashRunnable(row: Partial<SlashCommandRow> | null | undefined): SlashRunnable {
  if (!row || typeof row.cmd !== 'string' || !row.cmd.startsWith('/')) return 'none'
  if (typeof row.route === 'string' && row.route.trim()) return 'routed'
  // route 为空但带技能/命令文件的行，终端 REPL 的语义就是「读正文拼一条 AI 消息」
  // （replSession.js 的 _skillDir/_commandFile 分支），桌面用 prompt 通道对齐。
  if (nonEmpty(row._skillDir) || nonEmpty(row._commandFile)) return 'prompt'
  return 'none'
}

export interface SlashAliasEntry {
  alias: string
  command: string
  subCommand: string
}

// ALIAS_MAP 的 value 是对象（可带默认子命令），commandAutoRegistry.getAliases() 的
// value 是纯字符串 —— 两种形态在这里归一，调用方不再各自判型。
export function normalizeAliasEntry(alias: unknown, target: unknown): SlashAliasEntry | null {
  if (typeof alias !== 'string' || !alias.trim()) return null
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const command = (target as { command?: unknown }).command
    if (typeof command !== 'string' || !command.trim()) return null
    const subCommand = (target as { subCommand?: unknown }).subCommand
    return {
      alias,
      command: command.trim(),
      subCommand: typeof subCommand === 'string' ? subCommand.trim() : '',
    }
  }
  if (typeof target === 'string' && target.trim()) {
    return { alias, command: target.trim(), subCommand: '' }
  }
  return null
}

// 别名 → 斜杠命令的连接规则（数据面的全部真相）：ALIAS_MAP 的 target 指向 CLI
// 动词（可带默认子命令），斜杠命令的 route 也指向 CLI 动词串，两者在
// 「动词(+子命令)」上 join。join 不上的别名（实测 模型→models list 在斜杠面没有
// 对应 route）就不贡献搜索词 —— 不猜，避免「敲别名」命中随机命令。
export function aliasTermsForRow(route: string | null | undefined, aliases: SlashAliasEntry[]): string[] {
  if (typeof route !== 'string' || !route.trim()) return []
  const parts = route.trim().split(/\s+/)
  const head = (parts[0] || '').toLowerCase()
  const second = (parts[1] || '').toLowerCase()
  const out: string[] = []
  const seen = new Set<string>()
  for (const a of Array.isArray(aliases) ? aliases : []) {
    if (!a || a.command.toLowerCase() !== head) continue
    if (a.subCommand && a.subCommand.toLowerCase() !== second) continue
    // 菜单搜索按 includes 大小写不敏感匹配 —— 仅大小写不同的别名键是重复项。
    const key = a.alias.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(a.alias)
  }
  return out
}

export interface SlashMenuRow {
  id: string
  cmd: string
  label: string
  description: string
  runnable: SlashRunnable
  source: string
  aliases: string[]
}

// 提及菜单合并（「既有优先」与 slashExtraCommands.mergeExtraCommands 同语义）：
// primary = khy 命令注册表（与终端 REPL 菜单同一真源，重名时 registry 的优先级
// 规则本来就让 builtin 压过 CC 文件），secondary = agent:list 'command' 侧的
// CC/插件行。key 用归一斜杠 token；插件名（无 / 前缀）归一后同样参与碰撞判定，
// 避免插件与内置命令在菜单里出双份。
export function mergeSlashMenuRows(primary: SlashMenuRow[], secondary: SlashMenuRow[]): SlashMenuRow[] {
  const keyOf = (cmd: string): string => `/${cmd.replace(/^\//, '').toLowerCase()}`
  const taken = new Set<string>()
  const out: SlashMenuRow[] = []
  const rows = [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]
  for (const row of rows) {
    if (!row || typeof row.cmd !== 'string' || !row.cmd.trim()) continue
    const key = keyOf(row.cmd)
    if (taken.has(key)) continue
    taken.add(key)
    out.push(row)
  }
  return out
}
