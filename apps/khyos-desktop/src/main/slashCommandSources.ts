// slashCommandSources — khy 终端斜杠命令面接入桌面的 main 侧正门（CH-2 require）。
//
// 列表真源与终端两个交互入口（replSession / tui useCompletions）同一份：
// commandRegistry.toSlashCommands()（内置种子 + 用户技能 + CC 桥）+ slashExtraCommands
// 的 extras 并表 + aliases 两张表。桌面不复制任何命令字面量（防棘轮），清单全部
// 运行时取得；模块路径解析复用 terminalSources 的 resolveBackendSrcRoot + createRequire。
//
// 执行通道（分类逻辑在 ./slashCommandMerge.classifySlashRunnable）：
//   routed → router.parseInput + route()（与 bin/khy.js 单命令模式同一条入口）。
//            默认子命令 vs 用户子命令的分叉由 parseInput 内部的
//            KHY_SLASH_SUBCOMMAND_PASSTHROUGH 处理，桌面不自己拼 route。
//            输出经「patch stdout/stderr + 透传」收集 —— 与 cli/tui/commandOutputSink.js
//            同一手法；主进程没有 ink 帧，差别只在收集的同时透传给原始 write，
//            诊断日志不因命令执行而丢失。
//   prompt → loadUserSkillPrompt / loadCcCommandBody + renderCcCommandBody（REPL
//            用的同一批叶子模块，不复制拼装逻辑），返回 prompt 由渲染层走既有
//            aiSend 通道（= REPL 经内部行重放喂进主 agentic 通道的桌面等价物）。
//   none   → 无通道：执行体在 replSession 闭包里（思考档/vim/全屏面板等会话状态），
//            main 进程调不到，PTY 里敲也不成立 —— 诚实报错，渲染层不渲染可点项。
//
// 审计：本通道是桌面第一个「渲染层可触发后端命令执行」的面，每次 run 落一行
// JSONL 到 <dataHome>/slash_command_audit.jsonl（keyManager/audit.ts 同款形态）。
// 只记命令与参数长度，不记参数原文 —— /apikey 一类命令的参数可能是密钥。

import path from 'node:path'
import { appendFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import {
  aliasTermsForRow,
  classifySlashRunnable,
  mergeSlashMenuRows,
  normalizeAliasEntry,
  type SlashAliasEntry,
  type SlashCommandRow,
  type SlashMenuRow,
  type SlashRunnable,
} from './slashCommandMerge'
import { getDataHome } from './keyManager/keyStore'
import { listTerminalItems, resolveBackendSrcRoot, terminalProjectRoot, type TerminalItem } from './terminalSources'

type AnyModule = Record<string, any>

interface CliModules {
  srcRoot: string
  commandRegistry: AnyModule
  slashExtra: AnyModule
  aliases: AnyModule
  autoRegistry: AnyModule
  userSkills: AnyModule
  ccCommands: AnyModule
  stripAnsi: (s: string) => string
  // 懒加载：只有 slash:run 需要 router（它模块级会再扫一遍技能/CC 桥），
  // 列表路径不付这份加载成本。
  router: AnyModule | null
  require: NodeRequire
}

let _cli: CliModules | null | undefined
let _cliError = ''

function cli(): CliModules {
  if (_cli) return _cli
  if (_cli === null) {
    throw new Error(_cliError || 'khy 命令源不可用：请以完整仓库或便携版运行后重启应用')
  }
  const srcRoot = resolveBackendSrcRoot()
  if (!srcRoot) {
    _cli = null
    _cliError = 'khy 命令源不可用：未找到 runtime/node/backend/src，请确认应用以完整仓库或便携版运行'
    throw new Error(_cliError)
  }
  const req = createRequire(path.join(srcRoot, 'noop.cjs'))
  const load = (rel: string): AnyModule => req(path.join(srcRoot, rel))
  try {
    _cli = {
      srcRoot,
      commandRegistry: load('cli/commandRegistry.js'),
      slashExtra: load('cli/slashExtraCommands.js'),
      aliases: load('cli/aliases.js'),
      autoRegistry: load('cli/commandAutoRegistry.js'),
      userSkills: load('cli/repl/userSkillCommands.js'),
      ccCommands: load('cli/repl/ccUserCommands.js'),
      stripAnsi: load('utils/stripAnsi.js') as (s: string) => string,
      router: null,
      require: req,
    }
    return _cli
  } catch (err) {
    _cli = null
    _cliError = `khy 命令源加载失败：${err instanceof Error ? err.message : String(err)}；请重启应用，若仍失败请检查后端依赖是否完整`
    throw new Error(_cliError)
  }
}

// 与终端同参重扫：技能/CC 桥的 cwd 用终端项目根（terminalSources 同一解析），
// 设置页里新增的技能下一次打开菜单就能看到。两者内部绝不抛（发现失败 → 跳过，
// 不影响内置命令，与 router.js 模块级注册同策）。
function refreshRegistry(m: CliModules): void {
  const cwd = terminalProjectRoot()
  m.commandRegistry.registerUserSkills({ cwd })
  m.commandRegistry.registerCcCommands({ cwd })
}

function collectAliases(m: CliModules): SlashAliasEntry[] {
  const out: SlashAliasEntry[] = []
  const seen = new Set<string>()
  const push = (alias: unknown, target: unknown) => {
    const entry = normalizeAliasEntry(alias, target)
    if (entry && !seen.has(entry.alias)) {
      seen.add(entry.alias)
      out.push(entry)
    }
  }
  const staticMap = (m.aliases.ALIAS_MAP || {}) as Record<string, unknown>
  for (const [alias, target] of Object.entries(staticMap)) push(alias, target)
  try {
    const auto = m.autoRegistry.getAliases() as Record<string, string>
    for (const [alias, target] of Object.entries(auto || {})) push(alias, target)
  } catch {
    /* 自动别名注册表不可用 → 只用静态表 */
  }
  return out
}

function describeRow(row: SlashCommandRow, runnable: SlashRunnable): string {
  const parts = [row.cmd]
  if (row.desc) parts.push(row.desc)
  if (runnable === 'routed') parts.push('khy 命令')
  else if (runnable === 'prompt') parts.push('发送为提示词')
  else if (runnable === 'cc') parts.push('插入输入框')
  else parts.push('终端内生效')
  return parts.join(' · ')
}

// agent:list 'command' 同源的 CC 桥/命令插件行（terminalSources.listTerminalItems
// 就是读 ccCommands.listCcCommands + 命令插件目录）。runnable 'cc' = 维持桌面现状：
// 菜单选中插文本，回车后原文经 aiSend 发给模型。
function ccRowsFromTerminalItems(items: Awaited<ReturnType<typeof listTerminalItems>>): SlashMenuRow[] {
  const rows: SlashMenuRow[] = []
  for (const item of items) {
    const name = String(item.name || '').trim()
    if (!name) continue
    const isPlugin = !name.startsWith('/')
    rows.push({
      id: `cc:${item.id}`,
      cmd: name,
      label: name,
      description: [item.description, isPlugin ? '命令插件 · 插入输入框' : 'Claude Code · 插入输入框']
        .filter(Boolean)
        .join(' · '),
      runnable: 'cc',
      source: isPlugin ? 'plugin' : 'claude-code',
      aliases: [],
    })
  }
  return rows
}

export interface SlashListResult {
  ok: boolean
  commands?: SlashMenuRow[]
  error?: string
}

// 列表路径与设置页「命令」页共用的 khy 行收集：registry + extras + 别名，
// 不含 CC 桥/插件行（那一节设置页由 terminalSources.listCommands 自己给）。
function collectKhyRows(m: CliModules): SlashMenuRow[] {
  const rows = m.slashExtra.mergeExtraCommands(m.commandRegistry.toSlashCommands()) as SlashCommandRow[]
  const aliases = collectAliases(m)
  return rows.map((row) => {
    const runnable = classifySlashRunnable(row)
    return {
      id: `khy:${String(row.cmd).toLowerCase()}`,
      cmd: String(row.cmd),
      label: String(row.label || String(row.cmd).slice(1)),
      description: describeRow(row, runnable),
      runnable,
      source: row._commandFile ? 'claude-code' : row._skillDir ? 'khy-skill' : 'khy',
      aliases: aliasTermsForRow(row.route, aliases),
    }
  })
}

export async function listSlashCommands(): Promise<SlashListResult> {
  let m: CliModules
  try {
    m = cli()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  try {
    refreshRegistry(m)
    let ccRows: SlashMenuRow[] = []
    try {
      ccRows = ccRowsFromTerminalItems(await listTerminalItems('command'))
    } catch {
      // CC/插件面拉不到不挡 khy 面：菜单少一节比整页空态好。
    }
    return { ok: true, commands: mergeSlashMenuRows(collectKhyRows(m), ccRows) }
  } catch (err) {
    return {
      ok: false,
      error: `khy 命令列表读取失败：${err instanceof Error ? err.message : String(err)}；请确认应用以完整仓库或便携版运行后重启`,
    }
  }
}

// 设置页「命令」页与终端同源：把 khy 斜杠命令面（内置 + 用户技能触发）整列接进来，
// 行形态与 terminalSources 的 TerminalItem 一致（只读、不可启停、不可删）。
// CC 桥/命令插件行不在此重复——那一节设置页已由 listCommands 提供。
// 绝不抛：拉不到只是设置页少一节，不挡页面与其它 kind。
export function slashCommandItems(): TerminalItem[] {
  try {
    const m = cli()
    refreshRegistry(m)
    const out: TerminalItem[] = []
    for (const row of collectKhyRows(m)) {
      if (row.source !== 'khy' && row.source !== 'khy-skill') continue
      const usage =
        row.runnable === 'routed'
          ? '在输入框敲该命令执行；输出以消息卡形式回到当前会话'
          : row.runnable === 'prompt'
            ? '发送为提示词：命令正文拼进消息发给 AI'
            : row.runnable === 'none'
              ? '仅 khy 终端内生效（会话状态/交互面板）：桌面端不可执行，请打开终端面板运行 khy 后使用'
              : ''
      out.push({
        id: `khy-slash:${row.cmd.toLowerCase()}`,
        kind: 'command',
        name: row.cmd,
        description: row.description,
        content: [usage, row.aliases.length > 0 ? `别名: ${row.aliases.join(', ')}` : ''].filter(Boolean).join('\n'),
        enabled: true,
        source: 'khy',
        sourceLabel: row.source === 'khy-skill' ? 'Khy · 技能' : 'Khy 内置',
        createdAt: 0,
        updatedAt: 0,
        readOnly: true,
        toggleable: false,
        deletable: false,
      })
    }
    return out
  } catch {
    return []
  }
}

// ── slash:run ────────────────────────────────────────────────────────────

// 300s 与 ai:send 的 host 守卫同档（/model 一类要探测全部网关通道，30s 级；
// /update 这类重命令合法地跑几分钟）。守卫到点**不杀** route()（它没有可取消的
// 通道，杀也不诚实）：只停收输出、释放互斥、如实告诉用户命令可能还在后台跑。
const RUN_GUARD_MS = 300_000
// 消息卡里放 16k 字符已经远超一屏；再长的输出请到终端面板看。
const OUTPUT_LIMIT = 16_000

export interface SlashRunResult {
  ok: boolean
  action?: 'output' | 'prompt'
  output?: string
  prompt?: string
  reason?: string
  error?: string
}

const AUDIT_FILE = 'slash_command_audit.jsonl'

async function auditRun(cmd: string, args: string, action: string, ok: boolean, reason?: string): Promise<void> {
  try {
    const file = path.join(getDataHome(), AUDIT_FILE)
    await mkdir(path.dirname(file), { recursive: true })
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      op: 'slash:run',
      cmd,
      argsLen: args.length,
      action,
      ok,
    }
    if (reason) entry.reason = reason
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf-8')
  } catch {
    /* 审计失败不影响命令结果（fail-soft，与 keyManager/audit 同策） */
  }
}

function noChannelResult(row: SlashCommandRow): SlashRunResult {
  return {
    ok: false,
    reason: 'no-channel',
    error: `桌面端无法执行「${row.cmd}」：它的执行体在 khy 终端 REPL 内（会话状态/交互面板），主进程调不到；请打开终端面板运行 khy 后输入该命令`,
  }
}

// 技能/CC 命令 → AI 消息。拼装与 replSession 的 _skillDir/_commandFile 分支逐句
// 对齐：技能正文 + 空行 + 参数；CC 正文经 renderCcCommandBody 兑现 $ARGUMENTS。
function runnablePrompt(m: CliModules, row: SlashCommandRow, args: string): string | null {
  try {
    if (row._skillDir) {
      const body = m.userSkills.loadUserSkillPrompt(String(row._skillDir))
      if (!body) return null
      return args ? `${body}\n\n${args}` : String(body)
    }
    if (row._commandFile) {
      const body = m.ccCommands.loadCcCommandBody(String(row._commandFile))
      if (!body) return null
      try {
        return String(m.ccCommands.renderCcCommandBody(String(body), args) || body)
      } catch {
        return String(body)
      }
    }
  } catch {
    return null
  }
  return null
}

interface OutputCapture {
  restore: () => void
  text: () => string
}

// patch stdout/stderr 两个 write 点（console.* 与 formatters 全走它们），收集并
// 透传。restore 必须在 finally 里成对调用，否则主进程日志会一直被吞。
interface WritableLike {
  write(...args: unknown[]): boolean
}

function createOutputCapture(m: CliModules): OutputCapture {
  const streams: WritableLike[] = [process.stdout, process.stderr]
  const origWrites = streams.map((s) => s.write.bind(s))
  const parts: string[] = []
  let live = true
  const push = (chunk: unknown): void => {
    if (!live) return
    try {
      parts.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk == null ? '' : chunk))
    } catch {
      /* 收集绝不抛 */
    }
  }
  streams.forEach((stream, i) => {
    stream.write = (...args: unknown[]): boolean => {
      push(args[0])
      try {
        return origWrites[i](...args)
      } catch {
        /* 透传失败不影响收集（主进程 stdout 本就少有人消费） */
        return true
      }
    }
  })
  return {
    restore: () => {
      if (!live) return
      live = false
      streams.forEach((stream, i) => {
        stream.write = origWrites[i]
      })
    },
    text: () => {
      const raw = parts.join('')
      if (!raw) return ''
      const lines = raw
        .split('\n')
        .map((ln) => {
          const stripped = m.stripAnsi(String(ln)).replace(/\r/g, '').replace(/\s+$/, '')
          // 原行就是空行 → 保留（排版的一部分）；剥完控制序列才变空的行 → 丢弃。
          if (ln.trim() === '') return stripped
          return stripped.trim() === '' ? null : stripped
        })
        .filter((ln) => ln !== null)
      while (lines.length && lines[0].trim() === '') lines.shift()
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
      return lines.join('\n')
    },
  }
}

function truncateOutput(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text
  return `${text.slice(0, OUTPUT_LIMIT)}\n…（输出已截断：共 ${text.length} 字符，完整输出请到终端面板运行 khy 查看）`
}

function loadRouter(m: CliModules): AnyModule | null {
  if (m.router) return m.router
  try {
    m.router = m.require(path.join(m.srcRoot, 'cli', 'router.js'))
    return m.router
  } catch {
    return null
  }
}

async function runRouted(m: CliModules, row: SlashCommandRow, args: string): Promise<SlashRunResult> {
  const router = loadRouter(m)
  if (!router || typeof router.parseInput !== 'function' || typeof router.route !== 'function') {
    return {
      ok: false,
      error: '命令执行失败：后端 router 模块缺失，请确认应用以完整仓库或便携版运行后重启',
    }
  }
  const line = args ? `${row.cmd} ${args}` : String(row.cmd)
  const capture = createOutputCapture(m)
  let guardTimer: ReturnType<typeof setTimeout> | undefined
  let output = ''
  try {
    const parsed = router.parseInput(line)
    if (!parsed) {
      return { ok: false, error: `命令「${line}」无法解析：请检查命令与参数后重试` }
    }
    // route() 的返回值：true = 已处理并打印；字符串是给 REPL 的动作哨兵
    // （router.js:1281-1285，'exit'/'menu' 等 —— 意思是「作用于终端会话本身」）。
    // 主进程收到哨兵什么都不会发生，必须如实告诉用户而不是回填「执行完成：无输出」。
    let routed: unknown
    const raced = await Promise.race([
      router.route(parsed).then((v: unknown) => {
        routed = v
        return 'done' as const
      }),
      new Promise<'guard'>((resolve) => {
        guardTimer = setTimeout(() => resolve('guard'), RUN_GUARD_MS)
      }),
    ])
    output = capture.text()
    if (raced === 'guard') {
      void auditRun(row.cmd, args, 'output', false, 'guard-timeout')
      return {
        ok: false,
        reason: 'guard-timeout',
        output: output || undefined,
        error: `命令「${row.cmd}」超过 ${Math.round(RUN_GUARD_MS / 1000)} 秒未返回：它可能仍在后台执行，本结果不含后续输出；请到终端面板运行 khy 查看实际状态`,
      }
    }
  } catch (err) {
    output = capture.text()
    void auditRun(row.cmd, args, 'output', false)
    const detail = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: `命令「${row.cmd}」执行报错：${detail}${output ? `；已捕获输出：\n${truncateOutput(output)}` : '；请到终端面板运行 khy 重试'}`,
    }
  } finally {
    if (guardTimer) clearTimeout(guardTimer)
    capture.restore()
  }
  if (typeof routed === 'string' && routed.trim()) {
    void auditRun(row.cmd, args, 'repl-only', false)
    return {
      ok: false,
      reason: 'repl-only',
      error: `命令「${row.cmd}」的作用对象是终端 REPL 会话本身，桌面端执行它没有任何效果；请打开终端面板运行 khy 后使用该命令`,
    }
  }
  void auditRun(row.cmd, args, 'output', true)
  return { ok: true, action: 'output', output: truncateOutput(output) }
}

// 互斥：route() 期间 stdout 被收集器占用，两条并发 run 的输出会互相串线。
// 一次一条，第二条拿到的是明确的「上一条还在跑」，不是静默串输出。
let _runInFlight = false

export async function runSlashCommand(rawCmd: unknown, rawArgs: unknown): Promise<SlashRunResult> {
  const cmd = typeof rawCmd === 'string' ? rawCmd.trim().toLowerCase() : ''
  const args = typeof rawArgs === 'string' ? rawArgs.trim() : ''
  if (!cmd || !cmd.startsWith('/') || cmd.length < 2) {
    return { ok: false, error: '命令格式无效：请以 / 开头的命令调用，或按 / 从菜单选择' }
  }
  let m: CliModules
  try {
    m = cli()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  try {
    refreshRegistry(m)
  } catch {
    /* 技能/CC 发现失败不影响内置命令（与 router.js 同策） */
  }
  let row: SlashCommandRow | undefined
  try {
    const rows = m.slashExtra.mergeExtraCommands(m.commandRegistry.toSlashCommands()) as SlashCommandRow[]
    row = rows.find((r) => String(r?.cmd || '').toLowerCase() === cmd)
  } catch (err) {
    return {
      ok: false,
      error: `命令执行失败：khy 命令注册表读取失败（${err instanceof Error ? err.message : String(err)}），请重启应用后重试`,
    }
  }
  if (!row) {
    return { ok: false, error: `未找到命令「${cmd}」：请按 / 打开命令菜单从列表选择` }
  }
  const runnable = classifySlashRunnable(row)
  if (runnable === 'prompt') {
    const prompt = runnablePrompt(m, row, args)
    if (!prompt) {
      return {
        ok: false,
        error: `命令「${row.cmd}」缺少正文：技能目录下没有 prompt.md（或 SKILL.md），或命令文件为空；请补全后重试`,
      }
    }
    void auditRun(row.cmd, args, 'prompt', true)
    return { ok: true, action: 'prompt', prompt }
  }
  if (runnable !== 'routed') {
    void auditRun(row.cmd, args, 'none', false, 'no-channel')
    return noChannelResult(row)
  }
  if (_runInFlight) {
    return { ok: false, error: '上一条命令仍在执行：请等它返回后再试，或在终端面板查看进度' }
  }
  _runInFlight = true
  try {
    return await runRouted(m, row, args)
  } finally {
    _runInFlight = false
  }
}

// 启动预热：首次 require commandRegistry 会触发 commandAutoRegistry 全量 prescan
// （commandSchema 自记 100-290ms）。窗口出现后调用一次，用户第一次敲 / 不付这笔
// 钱。绝不抛：预热失败只是首敲慢一点，列表路径自己会再试。
export function warmSlashCommandSources(): void {
  try {
    void listSlashCommands().catch(() => {})
  } catch {
    /* fail-soft */
  }
}
