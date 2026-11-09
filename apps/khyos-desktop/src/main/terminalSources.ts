// khy-canary: Khy-20261102-316-TSRC01AA
// terminalSources — read/write the SAME stores the khy terminal uses, so the
// settings pages (命令/钩子/技能/子智能体/MCP/插件) show and edit one shared
// dataset instead of desktop-only JSON files.
//
// The backend CJS modules are the single source of truth for discovery paths
// and formats. This module requires them from the main process (CH-2) so path
// resolution never diverges: hookRegistry's hooks.json, mcp loadConfig's merged
// map, skills.discoverAllSkills, agents.getAgentDefinitions, ccUserCommands,
// cli/plugins, extensionRoots.discover.
//
// Writes stay on the terminal's own contracts:
//   hook   → <appHome>/hooks.json           (append hook / disabled[])
//   skill  → <dataHome>/skills/<dir>/       (manifest.json + prompt.md)
//   agent  → <dataHome>/agents/<file>.md
//   command→ <home>/.claude/commands/<x>.md (CC bridge, read by khy too)
//   mcp    → mcpConfigStore.addServer/...   (user mcp.json)
//   plugin → extensionRoots.discover + extensions_state.json
//   memory → memdir.saveMemory + MEMORY.md   (same store the terminal injects)

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, promises as fsp } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { resolveRepoRoot, getDataHome as desktopDataHome } from './keyManager/keyStore'

export interface TerminalItem {
  id: string
  kind: string
  name: string
  description: string
  content: string
  enabled: boolean
  source: string
  sourceLabel: string
  createdAt: number
  updatedAt: number
  readOnly: boolean
  toggleable: boolean
  deletable: boolean
}

type AnyModule = Record<string, any>

interface Backend {
  srcRoot: string
  dataHome: AnyModule
  skills: AnyModule
  agents: AnyModule
  hooks: AnyModule
  ccCommands: AnyModule
  cliPlugins: AnyModule
  extensions: AnyModule
  extensionManager: AnyModule
  mcp: AnyModule
  mcpStore: AnyModule
  memdir: AnyModule
  atomicWriteJson: AnyModule
  // Single market assembler shared with the web route and the CLI. Optional so
  // an install predating this module still boots; the pane then reports the
  // missing module instead of taking the other settings pages down.
  marketCatalog: AnyModule | null
  // Executes khy-market/1 install specs into the terminal's own stores and
  // remembers what each marketplace entry produced (market-installed.json).
  marketInstall: AnyModule | null
  require: NodeRequire
}

let _backend: Backend | null | undefined
let _backendError = ''

function backendSrcCandidates(): string[] {
  const out: string[] = []
  const push = (dir: string | null | undefined) => {
    if (dir) out.push(path.resolve(dir))
  }
  push(process.env.KHY_BACKEND_SRC)
  const services = process.env.KHY_BACKEND_SERVICES
  if (services) push(path.join(path.dirname(path.resolve(services)), ''))
  const repoRoot = resolveRepoRoot()
  if (repoRoot) push(path.join(repoRoot, 'runtime', 'node', 'backend', 'src'))
  const portable = process.env.KHY_PORTABLE_ROOT || process.env.KHYQUANT_PORTABLE_ROOT
  if (portable) {
    push(path.join(portable, 'khy-os', 'runtime', 'node', 'backend', 'src'))
    push(path.join(portable, 'runtime', 'node', 'backend', 'src'))
  }
  return out
}

export function resolveBackendSrcRoot(): string | null {
  for (const dir of backendSrcCandidates()) {
    try {
      if (existsSync(path.join(dir, 'skills', 'index.js')) && existsSync(path.join(dir, 'utils', 'dataHome.js'))) {
        return dir
      }
    } catch {
      /* unreadable candidate → try next */
    }
  }
  return null
}

function backend(): Backend {
  if (_backend) return _backend
  if (_backend === null) {
    throw new Error(_backendError || '终端数据源不可用：未找到后端模块，请以完整仓库或便携版运行后重启应用')
  }
  const srcRoot = resolveBackendSrcRoot()
  if (!srcRoot) {
    _backend = null
    _backendError = '终端数据源不可用：未找到 runtime/node/backend/src，请确认应用以完整仓库或便携版运行'
    throw new Error(_backendError)
  }
  const req = createRequire(path.join(srcRoot, 'noop.cjs'))
  const load = (rel: string): AnyModule => req(path.join(srcRoot, rel))
  try {
    _backend = {
      srcRoot,
      dataHome: load('utils/dataHome.js'),
      skills: load('skills/index.js'),
      agents: load('agents/index.js'),
      hooks: load('services/domain/extensions/hooks/hookRegistry.js'),
      ccCommands: load('cli/repl/ccUserCommands.js'),
      cliPlugins: load('cli/plugins.js'),
      extensions: load('services/domain/extensions/extensions/extensionRoots.js'),
      extensionManager: load('services/domain/extensions/extensions/extensionManager.js'),
      mcp: load('services/domain/messaging/mcp/index.js'),
      mcpStore: load('services/domain/messaging/mcp/mcpConfigStore.js'),
      memdir: load('memdir/index.js'),
      atomicWriteJson: load('utils/atomicWriteJson.js'),
      marketCatalog: (() => {
        try {
          return load('services/marketCatalog.js')
        } catch {
          return null
        }
      })(),
      marketInstall: (() => {
        try {
          return load('services/marketInstallService.js')
        } catch {
          return null
        }
      })(),
      require: req,
    }
    return _backend
  } catch (err) {
    _backend = null
    _backendError = `终端数据源加载失败：${(err as Error).message}；请重启应用，若仍失败请检查后端依赖是否完整`
    throw new Error(_backendError)
  }
}

export function terminalDataHome(): string {
  try {
    return backend().dataHome.getDataHome()
  } catch {
    return desktopDataHome()
  }
}

export function terminalAppHome(): string {
  try {
    return backend().dataHome.getAppHome()
  } catch {
    return desktopDataHome()
  }
}

export function terminalProjectRoot(): string {
  return resolveRepoRoot() || process.cwd()
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url')
}

function un64<T>(text: string): T | null {
  try {
    return JSON.parse(Buffer.from(text, 'base64url').toString('utf-8')) as T
  } catch {
    return null
  }
}

function makeId(prefix: string, payload: unknown): string {
  return `${prefix}:${b64(payload)}`
}

function splitId(id: string, prefix: string): unknown | null {
  if (typeof id !== 'string' || !id.startsWith(`${prefix}:`)) return null
  return un64(id.slice(prefix.length + 1))
}

function isInside(dir: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(dir))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function slugify(name: string): string {
  const slug = name
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || `item-${Date.now().toString(36)}`
}

function firstLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'))
  return line ? line.slice(0, 80) : ''
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── hooks ────────────────────────────────────────────────────────────────

interface HooksDoc {
  hooks: AnyModule[]
  disabled: string[]
  shape: 'array' | 'object'
  version?: unknown
}

function hookFiles(): Array<{ file: string; scope: 'global' | 'project' }> {
  const out: Array<{ file: string; scope: 'global' | 'project' }> = []
  const seen = new Set<string>()
  const push = (file: string, scope: 'global' | 'project') => {
    const resolved = path.resolve(file)
    if (seen.has(resolved)) return
    seen.add(resolved)
    out.push({ file: resolved, scope })
  }
  push(path.join(terminalAppHome(), 'hooks.json'), 'global')
  push(path.join(terminalProjectRoot(), 'works', 'data', 'khy', 'hooks.json'), 'project')
  return out
}

function readHooksDoc(file: string): HooksDoc {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    if (Array.isArray(raw)) {
      return { hooks: raw as AnyModule[], disabled: [], shape: 'array' }
    }
    const doc = (raw || {}) as AnyModule
    return {
      hooks: Array.isArray(doc.hooks) ? doc.hooks : [],
      disabled: Array.isArray(doc.disabled) ? doc.disabled.map(String) : [],
      shape: 'object',
      version: doc.version,
    }
  } catch {
    return { hooks: [], disabled: [], shape: 'object' }
  }
}

function writeHooksDoc(file: string, doc: HooksDoc): void {
  const dir = path.dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const payload: unknown =
    doc.shape === 'array' && doc.disabled.length === 0
      ? doc.hooks
      : { ...(doc.version !== undefined ? { version: doc.version } : { version: 1 }), hooks: doc.hooks, disabled: doc.disabled }
  const { atomicWriteJson } = backend()
  if (!atomicWriteJson(file, payload, { trailingNewline: true })) {
    throw new Error(`无法写入钩子配置：${file}`)
  }
}

function hookIdentity(hook: AnyModule, index: number): string {
  if (typeof hook.source === 'string' && hook.source.trim()) return hook.source.trim()
  return `${hook.event || 'hook'}#${index + 1}`
}

function listHooks(): TerminalItem[] {
  const { HOOK_EVENTS } = backend().hooks as { HOOK_EVENTS: string[] }
  const rows: TerminalItem[] = []
  for (const { file, scope } of hookFiles()) {
    if (!existsSync(file)) continue
    const doc = readHooksDoc(file)
    doc.hooks.forEach((hook, index) => {
      const identity = hookIdentity(hook, index)
      const event = HOOK_EVENTS.includes(hook.event) ? hook.event : String(hook.event || '未知事件')
      const meta = [event]
      if (hook.priority !== undefined) meta.push(`优先级 ${hook.priority}`)
      if (hook.timeout !== undefined) meta.push(`超时 ${hook.timeout}ms`)
      rows.push({
        id: makeId('hook', [file, identity]),
        kind: 'hook',
        name: identity,
        description: meta.join(' · '),
        content: typeof hook.command === 'string' ? hook.command : '',
        enabled: hook.enabled !== false && doc.disabled.includes(identity) === false,
        source: scope === 'project' ? 'project' : 'user',
        sourceLabel: scope === 'project' ? '项目配置' : '全局配置',
        createdAt: 0,
        updatedAt: 0,
        readOnly: false,
        toggleable: true,
        deletable: true,
      })
    })
  }
  return rows
}

function parseHookInput(input: { name?: unknown; description?: unknown; content?: unknown }): {
  identity: string
  event: string
  command: string
} | null {
  const { HOOK_EVENTS } = backend().hooks as { HOOK_EVENTS: string[] }
  const identity = typeof input.name === 'string' ? input.name.trim() : ''
  const rawContent = typeof input.content === 'string' ? input.content.trim() : ''
  if (!identity || !rawContent) return null
  const desc = typeof input.description === 'string' ? input.description.trim() : ''
  let event = HOOK_EVENTS.includes(desc) ? desc : ''
  let command = rawContent
  const m = rawContent.match(/^([A-Za-z]+)\s*:\s*([\s\S]+)$/)
  if (m && HOOK_EVENTS.includes(m[1])) {
    event = m[1]
    command = m[2].trim()
  }
  if (!event) event = 'PreToolUse'
  if (!command) return null
  return { identity, event, command }
}

function createHook(input: Parameters<typeof parseHookInput>[0]): TerminalItem {
  const parsed = parseHookInput(input)
  if (!parsed) {
    throw new Error('钩子信息无效：名称与脚本必填；脚本格式为「事件: 命令」，例如 PreToolUse: node check.js')
  }
  const file = hookFiles()[0].file
  const doc = readHooksDoc(file)
  if (doc.hooks.some((hook, i) => hookIdentity(hook, i) === parsed.identity)) {
    throw new Error(`钩子「${parsed.identity}」已存在：请换一个名称，或先在列表中删除`)
  }
  doc.hooks.push({
    event: parsed.event,
    command: parsed.command,
    timeout: 10000,
    priority: 100,
    source: parsed.identity,
    enabled: true,
  })
  writeHooksDoc(file, doc)
  return requireRow(listHooks(), makeId('hook', [file, parsed.identity]))
}

function setHookEnabled(id: string, enabled: boolean): void {
  const key = splitId(id, 'hook') as [string, string] | null
  if (!key) throw new Error('钩子标识无效：请刷新列表后重试')
  const [file, identity] = key
  const allowed = hookFiles().some((f) => f.file === path.resolve(file))
  if (!allowed) throw new Error('钩子文件不在可管理范围内：请刷新列表后重试')
  const doc = readHooksDoc(file)
  const hook = doc.hooks.find((h, i) => hookIdentity(h, i) === identity)
  if (!hook) throw new Error('未找到该钩子，可能已被删除：请刷新列表后重试')
  // Two readers agree on different keys: hookRegistry.load() honors the entry's
  // own `enabled` flag, while guard code consults the top-level `disabled` list.
  hook.enabled = !!enabled
  const next = new Set(doc.disabled)
  if (enabled) next.delete(identity)
  else next.add(identity)
  doc.disabled = [...next]
  writeHooksDoc(file, doc)
}

function deleteHook(id: string): void {
  const key = splitId(id, 'hook') as [string, string] | null
  if (!key) throw new Error('钩子标识无效：请刷新列表后重试')
  const [file, identity] = key
  const allowed = hookFiles().some((f) => f.file === path.resolve(file))
  if (!allowed) throw new Error('钩子文件不在可管理范围内：请刷新列表后重试')
  const doc = readHooksDoc(file)
  const before = doc.hooks.length
  doc.hooks = doc.hooks.filter((hook, i) => hookIdentity(hook, i) !== identity)
  if (doc.hooks.length === before) throw new Error('未找到该钩子，可能已被删除')
  doc.disabled = doc.disabled.filter((x) => x !== identity)
  writeHooksDoc(file, doc)
}

// ── skills ───────────────────────────────────────────────────────────────

const SKILL_SOURCE_LABEL: Record<string, string> = {
  'built-in': '内置',
  project: '项目',
  user: '用户',
  'cc-user': 'Claude Code',
  'cc-project': 'Claude Code',
  'oc-user': 'OpenClaw',
}

function skillContent(skill: AnyModule): string {
  if (typeof skill._legacyBody === 'string' && skill._legacyBody.trim()) return skill._legacyBody
  if (typeof skill.promptPath === 'string') {
    try {
      return readFileSync(skill.promptPath, 'utf-8')
    } catch {
      return ''
    }
  }
  return ''
}

function skillRoots(): string[] {
  const roots = [
    path.join(terminalDataHome(), 'skills'),
    path.join(terminalProjectRoot(), 'works', 'data', 'khy', 'skills'),
    path.join(os.homedir(), '.khyquant', 'skills'),
  ]
  return roots.map((r) => path.resolve(r))
}

function listSkills(): TerminalItem[] {
  const map: Map<string, AnyModule> = backend().skills.discoverAllSkills(terminalProjectRoot())
  const rows: TerminalItem[] = []
  for (const skill of map.values()) {
    const source = String(skill.source || 'user')
    const readOnly = source === 'built-in'
    const dir = typeof skill.dir === 'string' ? skill.dir : ''
    const deletable = !readOnly && !!dir && skillRoots().some((root) => isInside(dir, root))
    const trigger = typeof skill.trigger === 'string' ? skill.trigger : ''
    rows.push({
      id: makeId('skill', [dir, skill.name]),
      kind: 'skill',
      name: String(skill.name || ''),
      description: [skill.description, trigger].filter(Boolean).join(' · '),
      content: skillContent(skill),
      enabled: true,
      source,
      sourceLabel: SKILL_SOURCE_LABEL[source] || source,
      createdAt: 0,
      updatedAt: 0,
      readOnly,
      toggleable: false,
      deletable,
    })
  }
  return rows
}

function createSkill(input: { name?: unknown; description?: unknown; content?: unknown }): TerminalItem {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const content = typeof input.content === 'string' ? input.content.trim() : ''
  if (!name) throw new Error('技能名称不能为空：请填写名称后保存')
  if (!content) throw new Error('技能内容不能为空：请填写技能指令后保存')
  const map = backend().skills.discoverAllSkills(terminalProjectRoot()) as Map<string, AnyModule>
  if (map.has(name)) throw new Error(`技能「${name}」已存在：请换一个名称，或先删除同名技能`)
  const dir = path.join(terminalDataHome(), 'skills', slugify(name))
  if (existsSync(dir)) throw new Error(`技能目录已存在：${dir}，请换一个名称后重试`)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    name,
    description: description || firstLine(content),
    trigger: `/${slugify(name)}`,
    user_invocable: true,
    category: 'user',
    tags: [],
  }
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  writeFileSync(path.join(dir, 'prompt.md'), `${content}\n`, 'utf-8')
  backend().skills.invalidateCache()
  return requireRow(listSkills(), makeId('skill', [dir, name]))
}

async function deleteSkill(id: string): Promise<void> {
  const key = splitId(id, 'skill') as [string, string] | null
  if (!key) throw new Error('技能标识无效：请刷新列表后重试')
  const [dir, name] = key
  if (!dir || !skillRoots().some((root) => isInside(dir, root))) {
    throw new Error('内置或外接技能不能在此删除：请到对应来源目录处理')
  }
  if (!existsSync(dir)) throw new Error('技能目录已不存在：请刷新列表后重试')
  const manifestPath = path.join(dir, 'manifest.json')
  let manifestName = name
  try {
    manifestName = String(JSON.parse(readFileSync(manifestPath, 'utf-8')).name || name)
  } catch {
    /* 无 manifest 的遗留技能仍按目录删除 */
  }
  if (manifestName !== name) throw new Error('技能标识与目录不一致：请刷新列表后重试')
  await fsp.rm(dir, { recursive: true, force: true })
  backend().skills.invalidateCache()
}

// ── subagents ────────────────────────────────────────────────────────────

function agentRoots(): string[] {
  return [
    path.join(terminalDataHome(), 'agents'),
    path.join(terminalProjectRoot(), '.claude', 'agents'),
    path.join(terminalProjectRoot(), 'works', 'data', 'khy', 'agents'),
  ].map((r) => path.resolve(r))
}

function subagentSourceLabel(source: string): string {
  if (source === 'built-in') return '内置'
  if (source === 'userSettings') return '用户'
  if (source === 'projectSettings') return '项目'
  if (source.startsWith('cc')) return 'Claude Code'
  return source
}

async function listSubagents(): Promise<TerminalItem[]> {
  const result = await backend().agents.getAgentDefinitions(terminalProjectRoot())
  const rows: TerminalItem[] = []
  for (const agent of result.allAgents as AnyModule[]) {
    const source = String(agent.source || 'userSettings')
    const readOnly = source === 'built-in' || source === 'plugin' || source.startsWith('cc')
    const dir = typeof agent.baseDir === 'string' ? agent.baseDir : ''
    const deletable = !readOnly && !!dir && agentRoots().some((root) => isInside(dir, root))
    let prompt = ''
    if (!readOnly && typeof agent.getSystemPrompt === 'function') {
      try {
        prompt = String(agent.getSystemPrompt() || '')
      } catch {
        prompt = ''
      }
    }
    rows.push({
      id: makeId('subagent', [dir, agent.filename || agent.agentType]),
      kind: 'subagent',
      name: String(agent.agentType || ''),
      description: String(agent.whenToUse || ''),
      content: prompt,
      enabled: true,
      source,
      sourceLabel: subagentSourceLabel(source),
      createdAt: 0,
      updatedAt: 0,
      readOnly,
      toggleable: false,
      deletable,
    })
  }
  return rows
}

async function createSubagent(input: { name?: unknown; description?: unknown; content?: unknown }): Promise<TerminalItem> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const content = typeof input.content === 'string' ? input.content.trim() : ''
  if (!name) throw new Error('子智能体名称不能为空：请填写名称后保存')
  if (!description) throw new Error('子智能体描述不能为空：请填写「何时使用」后保存')
  if (!content) throw new Error('子智能体提示词不能为空：请填写职责与指令后保存')
  const existing = await listSubagents()
  if (existing.some((row) => row.name === name)) {
    throw new Error(`子智能体「${name}」已存在：请换一个名称，或先删除同名配置`)
  }
  const dir = path.join(terminalDataHome(), 'agents')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${slugify(name)}.md`)
  if (existsSync(file)) throw new Error(`子智能体文件已存在：${file}，请换一个名称后重试`)
  writeFileSync(
    file,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}\n`,
    'utf-8',
  )
  backend().agents.clearAgentCache()
  // Row ids carry the loader's `filename` (basename WITHOUT .md), so the
  // lookup must use the same shape or the fresh row is never found.
  return requireRow(await listSubagents(), makeId('subagent', [dir, slugify(name)]))
}

async function deleteSubagent(id: string): Promise<void> {
  const key = splitId(id, 'subagent') as [string, string] | null
  if (!key) throw new Error('子智能体标识无效：请刷新列表后重试')
  // Id carries the basename without extension (loader contract); the file on
  // disk is always <basename>.md.
  const [dir, basename] = key
  if (!dir || !basename || !agentRoots().some((root) => isInside(dir, root))) {
    throw new Error('内置或外接子智能体不能在此删除：请到对应来源目录处理')
  }
  const file = path.join(dir, `${basename}.md`)
  if (!existsSync(file)) throw new Error('子智能体文件已不存在：请刷新列表后重试')
  await fsp.rm(file, { force: true })
  backend().agents.clearAgentCache()
}

// ── commands ─────────────────────────────────────────────────────────────

function userCcCommandsDir(): string {
  return path.join(os.homedir(), '.claude', 'commands')
}

function ccCommandRoots(): string[] {
  return [path.join(terminalProjectRoot(), '.claude', 'commands'), userCcCommandsDir()].map((r) =>
    path.resolve(r)
  )
}

function listCommands(): TerminalItem[] {
  const rows: TerminalItem[] = []
  const cc: AnyModule[] = backend().ccCommands.listCcCommands({ cwd: terminalProjectRoot() })
  for (const cmd of cc) {
    const file = typeof cmd._commandFile === 'string' ? cmd._commandFile : ''
    if (!file) continue
    let content = ''
    try {
      content = String(backend().ccCommands.loadCcCommandBody(file) || '')
    } catch {
      content = ''
    }
    const inProject = isInside(file, path.join(terminalProjectRoot(), '.claude', 'commands'))
    rows.push({
      id: makeId('command', [file]),
      kind: 'command',
      name: String(cmd.cmd || cmd.label || ''),
      description: [cmd.desc, cmd._argumentHint ? `参数 ${cmd._argumentHint}` : ''].filter(Boolean).join(' · '),
      content,
      enabled: true,
      source: inProject ? 'project' : 'claude-code',
      sourceLabel: inProject ? 'Claude Code · 项目' : 'Claude Code',
      createdAt: 0,
      updatedAt: 0,
      readOnly: false,
      toggleable: false,
      deletable: true,
    })
  }
  const pluginDir = String(backend().cliPlugins.PLUGINS_DIR || '')
  if (pluginDir && existsSync(pluginDir)) {
    let files: string[] = []
    try {
      files = readdirSync(pluginDir).filter((f) => f.endsWith('.js'))
    } catch {
      files = []
    }
    for (const file of files) {
      const abs = path.join(pluginDir, file)
      try {
        const plugin = backend().require(abs) as AnyModule
        if (!plugin || typeof plugin.name !== 'string' || typeof plugin.handler !== 'function') continue
        const aliases = Array.isArray(plugin.aliases) ? plugin.aliases.map(String) : []
        rows.push({
          id: makeId('command-js', [abs]),
          kind: 'command',
          name: String(plugin.name),
          description: [plugin.description, aliases.length ? `别名 ${aliases.join(' / ')}` : ''].filter(Boolean).join(' · '),
          content: [
            plugin.usage ? `用法: ${plugin.usage}` : '',
            aliases.length ? `别名: ${aliases.join(', ')}` : '',
            `文件: ${abs}`,
          ].filter(Boolean).join('\n'),
          enabled: true,
          source: 'user',
          sourceLabel: '命令插件',
          createdAt: 0,
          updatedAt: 0,
          readOnly: false,
          toggleable: false,
          deletable: true,
        })
      } catch {
        /* broken plugin: the terminal also skips it */
      }
    }
  }
  return rows
}

function createCommand(input: { name?: unknown; description?: unknown; content?: unknown }): TerminalItem {
  const rawName = typeof input.name === 'string' ? input.name.trim() : ''
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const content = typeof input.content === 'string' ? input.content.trim() : ''
  if (!rawName) throw new Error('命令名称不能为空：请填写名称后保存')
  if (!content) throw new Error('命令内容不能为空：请填写提示词正文后保存')
  const name = slugify(rawName).replace(/^\/+/, '')
  const existing = listCommands()
  if (existing.some((row) => row.name === `/${name}` || row.name === name)) {
    throw new Error(`命令「/${name}」已存在：请换一个名称，或先删除同名命令`)
  }
  const dir = userCcCommandsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.md`)
  if (existsSync(file)) throw new Error(`命令文件已存在：${file}，请换一个名称后重试`)
  writeFileSync(
    file,
    `${description ? `---\ndescription: ${description}\n---\n\n` : ''}${content}\n`,
    'utf-8',
  )
  return requireRow(listCommands(), makeId('command', [file]))
}

async function deleteCommand(id: string): Promise<void> {
  const ccKey = splitId(id, 'command') as [string] | null
  if (ccKey) {
    const [file] = ccKey
    if (!file || !ccCommandRoots().some((root) => isInside(file, root))) {
      throw new Error('命令文件不在可管理范围内：请刷新列表后重试')
    }
    if (!existsSync(file)) throw new Error('命令文件已不存在：请刷新列表后重试')
    await fsp.rm(file, { force: true })
    return
  }
  const jsKey = splitId(id, 'command-js') as [string] | null
  if (jsKey) {
    const [file] = jsKey
    const pluginDir = path.resolve(String(backend().cliPlugins.PLUGINS_DIR || ''))
    if (!file || !pluginDir || !isInside(file, pluginDir)) {
      throw new Error('命令插件不在可管理范围内：请刷新列表后重试')
    }
    if (!existsSync(file)) throw new Error('命令插件已不存在：请刷新列表后重试')
    await fsp.rm(file, { force: true })
    backend().cliPlugins.reloadPlugins()
    return
  }
  throw new Error('命令标识无效：请刷新列表后重试')
}

// ── memory (terminal memdir: <dataHome>/memory) ──────────────────────────

const MEMORY_TYPE_LABEL: Record<string, string> = {
  user: '用户记忆',
  feedback: '反馈记忆',
  project: '项目记忆',
  reference: '参考记忆',
}

// logs/ is the daily progress log and .archive/ the distilled-away set — both
// live under the memory dir but neither is an editable memory entry.
const MEMORY_SKIP_DIRS = new Set(['.archive', 'logs'])

function memoryRoot(): string {
  return path.resolve(backend().memdir.getMemoryDir())
}

function walkMemoryFiles(root: string, rel = '', depth = 0): string[] {
  if (depth > 2) return []
  let entries
  try {
    entries = readdirSync(path.join(root, rel), { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || MEMORY_SKIP_DIRS.has(entry.name)) continue
      out.push(...walkMemoryFiles(root, childRel, depth + 1))
    } else if (entry.isFile() && entry.name.endsWith('.md') && childRel !== 'MEMORY.md') {
      out.push(childRel)
    }
  }
  return out
}

function memoryName(rel: string, frontmatter: AnyModule, body: string): string {
  if (typeof frontmatter.name === 'string' && frontmatter.name.trim()) return frontmatter.name.trim()
  // Older bucket files (e.g. user/zlibrary-access.md) predate frontmatter;
  // their first heading is the human title.
  const heading = body.match(/^#\s+(.+)$/m)
  if (heading) return heading[1].trim()
  return path.basename(rel).replace(/\.md$/i, '')
}

function memoryType(rel: string, frontmatter: AnyModule): string {
  const declared = typeof frontmatter.type === 'string' ? frontmatter.type.trim().toLowerCase() : ''
  if (MEMORY_TYPE_LABEL[declared]) return declared
  const bucket = rel.includes('/') ? rel.split('/')[0] : ''
  return MEMORY_TYPE_LABEL[bucket] ? bucket : ''
}

async function listMemories(): Promise<TerminalItem[]> {
  const root = memoryRoot()
  const { parseFrontmatter } = backend().memdir as {
    parseFrontmatter: (text: string) => { frontmatter: AnyModule; body: string }
  }
  const rows: TerminalItem[] = []
  for (const rel of walkMemoryFiles(root)) {
    const abs = path.join(root, rel)
    try {
      const [raw, stat] = await Promise.all([fsp.readFile(abs, 'utf-8'), fsp.stat(abs)])
      const parsed = parseFrontmatter(raw)
      const type = memoryType(rel, parsed.frontmatter)
      rows.push({
        id: makeId('memory', [rel]),
        kind: 'memory',
        name: memoryName(rel, parsed.frontmatter, parsed.body),
        description: typeof parsed.frontmatter.description === 'string' ? parsed.frontmatter.description : '',
        content: parsed.body.trim() || raw,
        enabled: true,
        source: type || 'memory',
        sourceLabel: MEMORY_TYPE_LABEL[type] || '记忆库',
        createdAt: stat.mtimeMs,
        updatedAt: stat.mtimeMs,
        readOnly: false,
        toggleable: false,
        deletable: true,
      })
    } catch {
      /* unreadable entry → skip, same as the terminal's own listing */
    }
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

async function createMemory(input: { name?: unknown; description?: unknown; content?: unknown; type?: unknown }): Promise<TerminalItem> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) throw new Error('记忆信息无效：名称不能为空，请填写名称后保存')
  const declared = typeof input.type === 'string' ? input.type.trim().toLowerCase() : ''
  const type = MEMORY_TYPE_LABEL[declared] ? declared : 'user'
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const content = typeof input.content === 'string' ? input.content : ''
  if ((await listMemories()).some((row) => row.name.trim().toLowerCase() === name.toLowerCase())) {
    throw new Error(`记忆「${name}」已存在：请换一个名称，或先删除同名记忆`)
  }
  const memdir = backend().memdir as AnyModule
  const saved = memdir.saveMemory(type, name, content, { description: description || name }) as {
    filename: string
  }
  // MEMORY.md is the only thing the terminal injects into the system prompt —
  // writing the file without the pointer leaves the memory invisible.
  memdir.updateMemoryIndex([{ title: name, filename: saved.filename, description: description || name }])
  return requireRow(await listMemories(), makeId('memory', [saved.filename]))
}

async function removeMemoryIndexEntry(rel: string): Promise<void> {
  const indexPath = path.resolve(backend().memdir.getMemoryIndexPath() as string)
  let content: string
  try {
    content = await fsp.readFile(indexPath, 'utf-8')
  } catch {
    return
  }
  const next = content
    .split('\n')
    .filter((line) => {
      const match = line.match(/\(([^)]+)\)/)
      return !(match && match[1] === rel)
    })
    .join('\n')
  if (next === content) return
  const tmp = `${indexPath}.${process.pid}.tmp`
  await fsp.writeFile(tmp, next, 'utf-8')
  await fsp.rename(tmp, indexPath)
}

async function deleteMemory(id: string): Promise<void> {
  const key = splitId(id, 'memory') as [string] | null
  const rel = key?.[0]
  if (!rel || !rel.endsWith('.md')) throw new Error('记忆标识无效：请刷新列表后重试')
  const root = memoryRoot()
  const abs = path.resolve(root, rel)
  const blocked = rel
    .split('/')
    .slice(0, -1)
    .some((segment) => segment.startsWith('.') || segment === 'logs')
  if (blocked || !isInside(abs, root) || abs === path.join(root, 'MEMORY.md')) {
    throw new Error('该记忆不在可管理范围内：请刷新列表后重试')
  }
  if (!existsSync(abs)) throw new Error('记忆文件已不存在：请刷新列表后重试')
  await fsp.rm(abs, { force: true })
  await removeMemoryIndexEntry(rel)
}

// ── row lookup ───────────────────────────────────────────────────────────

function requireRow(rows: TerminalItem[], id: string): TerminalItem {
  const found = rows.find((row) => row.id === id)
  if (!found) throw new Error('操作完成但列表中未找到该条目：请点击「刷新」确认结果')
  return found
}

// ── dispatcher ───────────────────────────────────────────────────────────

async function listByKind(kind: string): Promise<TerminalItem[]> {
  switch (kind) {
    case 'hook':
      return listHooks().sort((a, z) => a.name.localeCompare(z.name))
    case 'skill':
      return listSkills().sort((a, z) => a.name.localeCompare(z.name))
    case 'subagent':
      return (await listSubagents()).sort((a, z) => a.name.localeCompare(z.name))
    case 'command':
      return listCommands().sort((a, z) => a.name.localeCompare(z.name))
    case 'memory':
      return listMemories()
    default:
      throw new Error(`未知的终端条目类型「${kind}」：请通过设置页重试`)
  }
}

export async function listTerminalItems(kind: string): Promise<TerminalItem[]> {
  return listByKind(kind)
}

export async function createTerminalItem(
  kind: string,
  input: { name?: unknown; description?: unknown; content?: unknown }
): Promise<TerminalItem> {
  switch (kind) {
    case 'hook':
      return createHook(input)
    case 'skill':
      return createSkill(input)
    case 'subagent':
      return createSubagent(input)
    case 'command':
      return createCommand(input)
    case 'memory':
      return createMemory(input)
    default:
      throw new Error(`未知的终端条目类型「${kind}」：请通过设置页重试`)
  }
}

export async function setTerminalItemEnabled(kind: string, id: string, enabled: boolean): Promise<void> {
  if (kind === 'memory') {
    throw new Error('记忆不支持启停：请删除该条目，或新建一条替代')
  }
  if (kind !== 'hook') {
    throw new Error('该条目由终端按目录自动发现，不支持启停：需要停用请删除对应文件')
  }
  setHookEnabled(id, !!enabled)
}

export async function deleteTerminalItem(kind: string, id: string): Promise<void> {
  switch (kind) {
    case 'hook':
      deleteHook(id)
      return
    case 'skill':
      await deleteSkill(id)
      return
    case 'subagent':
      await deleteSubagent(id)
      return
    case 'command':
      await deleteCommand(id)
      return
    case 'memory':
      await deleteMemory(id)
      return
    default:
      throw new Error(`未知的终端条目类型「${kind}」：请通过设置页重试`)
  }
}

export async function importTerminalItems(
  kind: string,
  rows: unknown
): Promise<{ created: number; skipped: number }> {
  if (!Array.isArray(rows)) {
    throw new Error('导入内容不是 JSON 数组：请复制 [{name, content}] 形式后重试')
  }
  let created = 0
  let skipped = 0
  for (const row of rows) {
    const r = (row || {}) as { name?: unknown; description?: unknown; content?: unknown }
    try {
      await createTerminalItem(kind, r)
      created += 1
    } catch {
      skipped += 1
    }
  }
  return { created, skipped }
}

// ── MCP (terminal mcp.json) ──────────────────────────────────────────────

interface TerminalMcpServer {
  id: string
  name: string
  command: string
  enabled: boolean
  createdAt: number
  readOnly: boolean
  toggleable: boolean
  deletable: boolean
  source: string
  sourceLabel: string
  detail: string
}

function mcpPaths(): { user: string; project: string } {
  const b = backend()
  const cwd = terminalProjectRoot()
  return {
    user: path.resolve(b.mcpStore.scopePath('user', { cwd })),
    project: path.resolve(b.mcpStore.scopePath('project', { cwd })),
  }
}

function mcpCommandLine(config: AnyModule): string {
  if (typeof config.url === 'string' && config.url) return config.url
  if (typeof config.command === 'string') {
    const args = Array.isArray(config.args) ? config.args.map(String) : []
    // Re-quote args that were stored with spaces, so the displayed line can be
    // pasted back into the 新建 box without losing argument boundaries.
    const shown = args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))
    return [config.command, ...shown].join(' ')
  }
  return ''
}

function mcpSourceLabel(config: AnyModule, scope: 'user' | 'project' | 'external'): string {
  if (config._ccBridged) return 'Claude Code'
  if (config._ocBridged) return 'OpenClaw'
  if (config._ecoBridged) return String(config._ecoBridged)
  if (scope === 'project') return '项目配置'
  if (scope === 'user') return '用户配置'
  return '外部配置'
}

export async function listTerminalMcpServers(): Promise<TerminalMcpServer[]> {
  const b = backend()
  const paths = mcpPaths()
  const merged = b.mcp.loadConfig(terminalProjectRoot()) as AnyModule
  const servers = (merged.mcpServers || {}) as Record<string, AnyModule>
  const rows: TerminalMcpServer[] = []
  for (const [name, config] of Object.entries(servers)) {
    const configPath = typeof config._configPath === 'string' ? path.resolve(config._configPath) : ''
    // In portable mode the user and project scopes resolve to the SAME file;
    // report it as user scope, which is also where addServer writes by default.
    const isUser = configPath === paths.user
    const isProject = !isUser && configPath === paths.project
    const scope: 'user' | 'project' | 'external' = isUser ? 'user' : isProject ? 'project' : 'external'
    const readOnly = !isUser && !isProject
    const type = typeof config.type === 'string' ? config.type : config.url ? 'http' : 'stdio'
    rows.push({
      id: makeId('mcp', [scope, name]),
      name,
      command: mcpCommandLine(config),
      enabled: config._disabled !== true && config.disabled !== true,
      createdAt: 0,
      readOnly,
      toggleable: !readOnly,
      deletable: !readOnly,
      source: scope,
      sourceLabel: mcpSourceLabel(config, scope),
      detail: [
        `传输 ${type}`,
        config.workingDirectory ? `工作目录 ${config.workingDirectory}` : '',
        configPath ? `文件 ${configPath}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    })
  }
  return rows.sort((a, z) => a.name.localeCompare(z.name))
}

function splitCommandLine(line: string): string[] {
  const out: string[] = []
  let current = ''
  let quote = ''
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = ''
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current) {
        out.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) out.push(current)
  return out
}

function mcpConfigFromInput(name: string, command: string): AnyModule {
  if (!name) throw new Error('服务器名称不能为空：请填写名称后保存')
  if (!command) throw new Error('启动命令/URL 不能为空：请填写 stdio 命令或 http(s) URL 后保存')
  if (/^https?:\/\//i.test(command)) {
    return { type: 'http', url: command }
  }
  const parts = splitCommandLine(command)
  if (!parts.length) throw new Error('启动命令无效：请填写可执行的 stdio 命令（例如 npx -y xxx）或 http(s) URL')
  return { type: 'stdio', command: parts[0], args: parts.slice(1) }
}

function mcpNameTaken(name: string): boolean {
  const merged = backend().mcp.loadConfig(terminalProjectRoot()) as AnyModule
  return Object.prototype.hasOwnProperty.call(merged.mcpServers || {}, name)
}

export async function createTerminalMcpServer(input: { name?: unknown; command?: unknown }): Promise<TerminalMcpServer> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const command = typeof input.command === 'string' ? input.command.trim() : ''
  const config = mcpConfigFromInput(name, command)
  if (mcpNameTaken(name)) {
    throw new Error(`名称「${name}」已被使用：请换一个名称，或先删除同名服务器`)
  }
  backend().mcpStore.addServer(name, config, { scope: 'user', cwd: terminalProjectRoot() })
  const row = (await listTerminalMcpServers()).find((s) => s.name === name)
  if (!row) throw new Error('服务器已写入但未出现在列表中：请点击「刷新」确认结果')
  return row
}

function decodeMcpId(id: string): { scope: 'user' | 'project'; name: string } {
  const key = splitId(id, 'mcp') as [string, string] | null
  if (!key) throw new Error('服务器标识无效：请刷新列表后重试')
  const [scope, name] = key
  if ((scope !== 'user' && scope !== 'project') || !name) {
    throw new Error('该服务器来自外部配置，桌面端只读：请到对应工具中修改')
  }
  return { scope, name }
}

export async function setTerminalMcpEnabled(id: string, enabled: boolean): Promise<void> {
  const { scope, name } = decodeMcpId(id)
  const res = backend().mcpStore.setServerEnabled(name, !!enabled, { scope, cwd: terminalProjectRoot() })
  if (!res.found) throw new Error(`未找到服务器「${name}」：请刷新列表后重试`)
}

export async function deleteTerminalMcpServer(id: string): Promise<void> {
  const { scope, name } = decodeMcpId(id)
  const res = backend().mcpStore.removeServer(name, { scope, cwd: terminalProjectRoot() })
  if (!res.removed) throw new Error(`未找到服务器「${name}」：请刷新列表后重试`)
}

export async function importTerminalMcpServers(
  rows: unknown
): Promise<{ created: number; skipped: number }> {
  if (!Array.isArray(rows)) {
    throw new Error('导入内容不是 JSON 数组：请复制 [{name, command}] 形式后重试')
  }
  let created = 0
  let skipped = 0
  for (const row of rows) {
    const r = (row || {}) as { name?: unknown; command?: unknown }
    const name = typeof r.name === 'string' ? r.name.trim() : ''
    const command = typeof r.command === 'string' ? r.command.trim() : ''
    try {
      const config = mcpConfigFromInput(name, command)
      if (mcpNameTaken(name)) {
        skipped += 1
        continue
      }
      backend().mcpStore.addServer(name, config, { scope: 'user', cwd: terminalProjectRoot() })
      created += 1
    } catch {
      skipped += 1
    }
  }
  return { created, skipped }
}

// ── plugins (terminal extension roots) ───────────────────────────────────

export interface TerminalPlugin {
  id: string
  name: string
  version: string
  description: string
  source: string
  enabled: boolean
  installedAt: number
  installPath: string
  updateAvailable?: boolean
  components: { skills: number; commands: number; hooks: number; mcp: number; agents: number; lsp: number }
}

export async function listTerminalPlugins(): Promise<TerminalPlugin[]> {
  const b = backend()
  const found = b.extensions.discover({ includeDisabled: true }) as AnyModule[]
  return found
    .filter((ext) => ext.kind === 'runtime' && ext.main)
    .map((ext) => ({
      id: String(ext.id),
      name: String(ext.name || ext.id),
      version: String(ext.version || '0.0.0'),
      description: String(ext.description || ''),
      source: ext.builtin ? 'builtin' : 'user',
      enabled: ext.enabled !== false,
      installedAt: 0,
      installPath: String(ext.dir || ''),
      updateAvailable: false,
      components: {
        skills: Array.isArray(ext.skills) ? ext.skills.length : 0,
        commands: Array.isArray(ext.commands) ? ext.commands.length : 0,
        hooks: 0,
        mcp: ext.mcp && typeof ext.mcp === 'object' ? Object.keys(ext.mcp).length : 0,
        agents: 0,
        lsp: 0,
      },
    }))
    .sort((a, z) => a.name.localeCompare(z.name))
}

function findPlugin(id: string): AnyModule {
  const found = backend().extensions.discover({ includeDisabled: true }) as AnyModule[]
  const ext = found.find((e) => String(e.id) === id)
  if (!ext) throw new Error('未找到该插件，可能已被移除：请点击「刷新」确认')
  return ext
}

export async function setTerminalPluginEnabled(
  id: string,
  enabled: boolean
): Promise<TerminalPlugin> {
  const b = backend()
  findPlugin(id)
  const file = String(b.extensions.stateFilePath())
  let state: AnyModule = {}
  try {
    state = JSON.parse(readFileSync(file, 'utf-8')) as AnyModule
  } catch {
    state = {}
  }
  state[id] = { ...(state[id] && typeof state[id] === 'object' ? state[id] : {}), enabled: !!enabled }
  const dir = path.dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (!b.atomicWriteJson(file, state, { trailingNewline: true })) {
    throw new Error(`无法写入插件状态：${file}`)
  }
  const plugins = await listTerminalPlugins()
  const row = plugins.find((p) => p.id === id)
  if (!row) throw new Error('插件状态已写入但未出现在列表中：请点击「刷新」确认')
  return row
}

export async function uninstallTerminalPlugin(id: string): Promise<void> {
  const ext = findPlugin(id)
  if (ext.builtin) {
    throw new Error('内置插件随平台分发，不能卸载：可在列表中停用')
  }
  try {
    backend().extensionManager.uninstallExtension(id)
  } catch (err) {
    throw new Error(`无法自动卸载该插件（${errorText(err)}）：请用终端执行 khy ext uninstall ${id}`)
  }
}

export async function installTerminalPlugin(): Promise<{ ok: false; error: string }> {
  return { ok: false, error: '桌面端未接入插件市场：请用终端执行 khy ext list / khy ext install 后在此管理' }
}

// ── ecosystem survey catalog (delivery/market) + live sources ───────────
// Read-only data for the 发现 tab. Assembly lives in the backend
// services/marketCatalog module — the same one the web route and the CLI call —
// so the three surfaces cannot report different ecosystem counts or freshness.
// `force` bypasses every TTL. A failed live fetch becomes a recorded source
// status (and a warning) instead of erasing the static catalog.

export async function listEcoMarkets(force = false): Promise<AnyModule> {
  const b = backend()
  if (!b.marketCatalog) {
    throw new Error(
      '生态市场装配模块不可用：后端缺少 services/marketCatalog.js，请以完整仓库或便携版运行后重启应用'
    )
  }
  return b.marketCatalog.assembleEcoMarkets({ force })
}

// Install/uninstall go through the backend marketInstallService so the artifact
// lands in the same store `khy skill add` / `khy mcp add` writes — the desktop
// never grows a second skills directory or mcp.json.
function marketEntry(entry: unknown): AnyModule {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('市场条目无效：请点击「刷新编目」后重试')
  }
  return entry as AnyModule
}

export async function installMarketEntry(entry: unknown, values?: unknown): Promise<AnyModule> {
  const b = backend()
  if (!b.marketInstall) {
    throw new Error('市场安装服务不可用：后端缺少 services/marketInstallService.js，请以完整仓库或便携版运行后重启应用')
  }
  const opts: AnyModule = {}
  if (values && typeof values === 'object' && !Array.isArray(values)) opts.values = values
  return b.marketInstall.installEntry(marketEntry(entry), opts)
}

export async function uninstallMarketEntry(entry: unknown): Promise<AnyModule> {
  const b = backend()
  if (!b.marketInstall) {
    throw new Error('市场卸载服务不可用：后端缺少 services/marketInstallService.js，请以完整仓库或便携版运行后重启应用')
  }
  return b.marketInstall.uninstallEntry(marketEntry(entry), {})
}
