// khy-canary: Khy-20261102-300-PCANHZRT
import { useState } from 'react'
import { useAppSelector } from '../../state/store'
import { Icon } from '../ui/Icon'
import type { IconName } from '../ui/Icon'
import { useTicker } from '../ui/useTicker'
import type { ToolExecution } from '../../state/toolExecutionSlice'
import { DiffViewer } from './DiffViewer'

type ToolFamily = 'terminal' | 'read' | 'write' | 'search' | 'fetch' | 'other'

// 一张卡一眼看出是哪类动作：终端命令 / 读文件 / 写文件 / 搜索 / 抓网页。
// 状态仍由左侧圆点承担颜色，图标只做形状区分。
const FAMILY_ICONS: Record<ToolFamily, IconName> = {
  terminal: 'terminal',
  read: 'file-text',
  write: 'code',
  search: 'search',
  fetch: 'browser',
  other: 'info',
}

// 工具名归一化：小写 + 去掉空白/下划线/连字符。口径照后端
// runtime/node/backend/src/cli/renderTheme.js 的 normalizeToolKind ——
// 后端发来的是注册名（bash / readFile / webSearch / MultiEdit…），
// 大小写与分隔符在这里收口，卡片不再逐工具写 if。
const normalizeName = (name: string) => String(name || '').toLowerCase().replace(/[\s_-]/g, '')

const FAMILY_ALIASES: Record<string, ToolFamily> = {
  bash: 'terminal',
  sh: 'terminal',
  shell: 'terminal',
  shellcommand: 'terminal',
  cmd: 'terminal',
  command: 'terminal',
  powershell: 'terminal',
  terminal: 'terminal',
  read: 'read',
  readfile: 'read',
  cat: 'read',
  notebookread: 'read',
  listdir: 'read',
  ls: 'read',
  write: 'write',
  writefile: 'write',
  createfile: 'write',
  edit: 'write',
  editfile: 'write',
  multiedit: 'write',
  applypatch: 'write',
  notebookedit: 'write',
  glob: 'search',
  find: 'search',
  findfiles: 'search',
  grep: 'search',
  search: 'search',
  searchcontent: 'search',
  websearch: 'search',
  webfetch: 'fetch',
  fetch: 'fetch',
  browser: 'fetch',
}

const familyOf = (name: string): ToolFamily => FAMILY_ALIASES[normalizeName(name)] || 'other'

function verbOf(name: string, family: ToolFamily): string {
  if (family === 'terminal') return '执行命令'
  if (family === 'read') return '读取文件'
  if (family === 'write') return /edit|patch/.test(normalizeName(name)) ? '修改文件' : '写入文件'
  if (family === 'search') return '搜索'
  if (family === 'fetch') return '抓取网页'
  return '调用工具'
}

function firstString(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

// 卡片头上那一行「到底在动什么」：命令原文 / 文件路径 / 搜索词 / URL。
// 取不到已知字段时退到第一个字符串参数 —— 显示参数名本身也好过只写工具名。
function targetOf(execution: ToolExecution): string {
  const { input, name } = execution
  const family = familyOf(name)
  if (family === 'terminal') return firstString(input, ['command', 'cmd', 'script', 'shell', 'input'])
  if (family === 'read' || family === 'write') {
    return firstString(input, ['path', 'file_path', 'filePath', 'notebook_path', 'notebookPath', 'target'])
  }
  if (family === 'search') {
    const query = firstString(input, ['pattern', 'query', 'q', 'search', 'term'])
    const where = firstString(input, ['path', 'dir', 'directory', 'glob'])
    return [query && `"${query}"`, where && `· ${where}`].filter(Boolean).join(' ')
  }
  if (family === 'fetch') return firstString(input, ['url', 'href'])
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

// 三点脉冲：写在「等待输出」旁边，告诉用户不是卡住了。
function LoadingDots({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 ${className}`} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1 h-1 rounded-full bg-current animate-pulse"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  )
}

// 不定长进度条：工具没有可报告的百分比（跑多久取决于命令本身），
// 所以只表达「仍在推进」，绝不编一个假百分比。
function RunningBar() {
  return (
    <div
      className="relative h-0.5 overflow-hidden bg-warning/20"
      role="progressbar"
      aria-label="工具执行进度"
      aria-valuetext="进行中"
    >
      <span className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-warning khy-indeterminate" />
    </div>
  )
}

function ToolExecutionItem({ execution }: { execution: ToolExecution }) {
  const [expanded, setExpanded] = useState(execution.status === 'running')
  const [copied, setCopied] = useState(false)
  const now = useTicker(execution.status === 'running', 500)

  // icon 字段此前无消费方（渲染只用 color/bg/label），已随装饰字符一并删除
  const statusConfig = {
    pending: { color: 'text-foreground-muted', bg: 'bg-foreground/20', label: '等待中' },
    running: { color: 'text-warning', bg: 'bg-warning/20', label: '运行中' },
    success: { color: 'text-success', bg: 'bg-success/20', label: '完成' },
    error: { color: 'text-destructive', bg: 'bg-destructive/20', label: '失败' },
    cancelled: { color: 'text-foreground-muted', bg: 'bg-foreground/20', label: '已取消' },
  }

  const status = statusConfig[execution.status]
  const family = familyOf(execution.name)
  const verb = verbOf(execution.name, family)
  const target = targetOf(execution)

  // 历史会话里的执行只有 startedAt、没有 completedAt：那时显示 null 而不是
  // 一个「0.0s」的假耗时。运行中按 0.5s 心跳刷新，停下即停表。
  const duration = execution.completedAt
    ? `${((execution.completedAt - execution.startedAt) / 1000).toFixed(1)}s`
    : execution.status === 'running'
    ? `${Math.max(0, (now - execution.startedAt) / 1000).toFixed(1)}s`
    : null

  const isRunning = execution.status === 'running'
  // 终端卡：命令原文进「$ 命令」行，其余参数（timeout 之类）落到参数区。
  const terminalCommand = family === 'terminal'
    ? firstString(execution.input, ['command', 'cmd', 'script', 'shell', 'input'])
    : ''
  // 有红绿 diff 时，被改动的正文（old_string/new_string/content…）不再重复铺一遍：
  // 它们正是 diff 的原料，铺出来只会把卡片撑成两面墙。
  const diffCoversBodyKeys = Boolean(execution.diff)
  const BODY_KEYS = ['old_string', 'new_string', 'old_str', 'new_str', 'content', 'new_content', 'edits']
  const detailEntries = Object.entries(execution.input).filter(([key, value]) => {
    if (family === 'terminal' && ['command', 'cmd', 'script', 'shell', 'input'].includes(key)) return false
    if (diffCoversBodyKeys && BODY_KEYS.includes(key)) return false
    return value !== undefined && value !== ''
  })

  const copyText = execution.result ?? execution.error ?? JSON.stringify(execution.input, null, 2)
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await navigator.clipboard.writeText(copyText)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className={`border rounded-lg overflow-hidden ${isRunning ? 'border-warning/40' : 'border-card-border'}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface-hover transition-colors"
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${status.bg} ${status.color} ${isRunning ? 'animate-pulse' : ''}`} />
        <span className="text-foreground-muted shrink-0">
          <Icon name={FAMILY_ICONS[family]} size={12} />
        </span>
        <span className="font-medium text-foreground shrink-0">{execution.name}</span>
        <span className="text-xs text-foreground-muted truncate min-w-0 flex-1 text-left">
          {target || verb}
        </span>
        {execution.diff && (
          <span className="text-xs tabular-nums shrink-0" title="本次改动行数">
            {execution.diff.added > 0 && <span className="text-success">+{execution.diff.added}</span>}
            {execution.diff.added > 0 && execution.diff.removed > 0 && ' '}
            {execution.diff.removed > 0 && <span className="text-destructive">-{execution.diff.removed}</span>}
          </span>
        )}
        {duration && <span className="text-xs text-foreground-muted tabular-nums shrink-0">{duration}</span>}
        <span className={`text-xs shrink-0 ${status.color}`}>{status.label}</span>
        <span
          role="button"
          onClick={handleCopy}
          className="text-xs text-foreground-muted hover:text-foreground px-1 shrink-0"
          title="复制结果"
        >
          {copied ? <Icon name="check" size={12} /> : '复制'}
        </span>
        <span className={`text-foreground-subtle transition-transform duration-200 shrink-0 ${expanded ? 'rotate-180' : ''}`}>
          <Icon name="chevron-down" size={12} />
        </span>
      </button>
      {isRunning && <RunningBar />}
      {expanded && (
        <div className="px-3 pb-3 pt-1 animate-slide-down space-y-1">
          {family === 'terminal' ? (
            <div className="rounded-lg bg-input overflow-hidden">
              {/* 命令行用 $ 前缀独占一行：多行脚本也按原文换行，不做词法着色 */}
              <div className="px-2.5 py-2 font-mono text-xs text-foreground whitespace-pre-wrap break-all">
                <span className="text-success select-none">$ </span>
                {terminalCommand || '（未提供命令参数）'}
              </div>
              <div className="border-t border-card-border px-2.5 py-2 font-mono text-xs max-h-48 overflow-auto">
                {execution.error ? (
                  <pre className="whitespace-pre-wrap break-all text-destructive/80">{execution.error}</pre>
                ) : execution.result ? (
                  <pre className="whitespace-pre-wrap break-all text-foreground/80">{execution.result}</pre>
                ) : isRunning ? (
                  <span className="inline-flex items-center gap-1.5 text-foreground-muted">
                    等待输出
                    <LoadingDots />
                  </span>
                ) : (
                  <span className="text-foreground-muted">（无输出）</span>
                )}
              </div>
            </div>
          ) : (
            <>
              {detailEntries.length > 0 && (
                <div className="text-xs bg-input rounded-lg p-2 max-h-40 overflow-auto">
                  {detailEntries.map(([key, value]) => (
                    <div key={key} className="flex gap-2 leading-relaxed">
                      <span className="text-foreground-muted shrink-0 font-mono">{key}</span>
                      <span className="font-mono text-foreground/80 whitespace-pre-wrap break-all">{formatValue(value)}</span>
                    </div>
                  ))}
                </div>
              )}
              {execution.diff && <DiffViewer diff={execution.diff} embedded />}
              {execution.error ? (
                <div className="text-xs font-mono text-destructive/80 bg-destructive/10 rounded-lg p-2 max-h-48 overflow-auto">
                  <pre className="whitespace-pre-wrap break-all">{execution.error}</pre>
                </div>
              ) : execution.diff ? null : execution.result ? (
                <div className="text-xs font-mono text-foreground/80 bg-input rounded-lg p-2 max-h-48 overflow-auto">
                  <pre className="whitespace-pre-wrap break-all">{execution.result}</pre>
                </div>
              ) : isRunning ? (
                <div className="flex items-center gap-1.5 text-xs text-foreground-muted">
                  等待输出
                  <LoadingDots />
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function ToolExecutionPanel({ messageId }: { messageId: string }) {
  const all = useAppSelector(state => state.toolExecution.executions)
  const activeIds = useAppSelector(state => state.toolExecution.activeIds)
  const [collapsed, setCollapsed] = useState(false)

  // 只渲染属于本条消息（= 本轮提问）的执行。归属由 Composer 在发送时登记、
  // slice 在 startToolExecution 时盖章；会话切换与新一轮提问都会清空，
  // 迟到且没有归属的执行（messageId 为空）任何消息都不认领。
  const executions = all.filter(e => e.messageId === messageId)

  // 显示本轮全部工具执行（含已完成）。只显示「进行中」会让卡片在几十毫秒内
  // 一闪而过——用户看不到 agent 到底干过什么，而「看得见在干活」正是本面板的
  // 存在理由。清空交给下一轮提问（Composer 的 beginToolTurn）与切换会话。
  const running = executions.filter(e => activeIds.includes(e.id)).length

  if (executions.length === 0) return null

  return (
    <div className="khy-content-col my-2 khy-tui bg-card border border-card-border rounded-xl overflow-hidden animate-slide-down">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface-hover transition-colors"
      >
        <span className={`w-2 h-2 rounded-full ${running > 0 ? 'bg-warning animate-pulse' : 'bg-success'}`} />
        <span className="font-medium text-foreground">{running > 0 ? '正在执行' : '工具执行'}</span>
        <span className="text-xs text-foreground-muted">
          {running > 0 ? `${running} 个进行中` : `${executions.length} 个`}
        </span>
        <span className="text-xs text-foreground-muted ml-auto">{collapsed ? '展开' : '收起'}</span>
      </button>
      {running > 0 && <RunningBar />}
      {!collapsed && (
        <div className="px-3 pb-3 pt-1 space-y-1">
          {executions.map(execution => (
            <ToolExecutionItem key={execution.id} execution={execution} />
          ))}
        </div>
      )}
    </div>
  )
}
