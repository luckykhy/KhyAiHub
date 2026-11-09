// khy-canary: Khy-20261102-281-3FDNJAHB
import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { useAppDispatch, useAppSelector } from '../../state/store'
import { store } from '../../state/store'
import { addMessage, updateMessage, setMessageStatus, setStreaming, setAgentWorking, recordLastPrompt, clearSessionLoadError } from '../../state/messageSlice'
import { beginToolTurn } from '../../state/toolExecutionSlice'
import { addToast } from '../../state/toastSlice'
import { useModelCatalog, groupByProvider, getModelOptionLabel, type ModelOption } from '../../utils/useModelCatalog'
import { ModeSelector, DEFAULT_AGENT_MODE } from './ModeSelector'
import { Icon } from '../ui/Icon'
import { ATTACHMENT_ICON, attachmentKind, attachmentTint, extensionsOf, type AttachmentKind } from './attachmentKind'
import { AttachmentList, type ComposerAttachment } from './AttachmentList'
import { preparePastedImage } from './imagePaste'
import { Spinner } from '../ui/Spinner'
import { formatCompactNumber } from '../../shared/compactNumber'
import {
  runSlashToSession,
  callSlashRun,
  callSlashList,
  type SlashRunOutcome,
  type SlashMenuRowPayload,
} from '../../utils/slashRun'

type MentionType = '@' | '#' | '$' | '/' | null

// 附件以绝对路径进来；chip 只显示文件名，完整路径留给 title（Windows 路径一行
// 可达 80+ 字符，多个附件叠起来会撑掉输入区上方的两三行）。
const baseName = (p: string) => p.split(/[\\/]/).pop() || p

// 附件模型与列表渲染在 ./AttachmentList.tsx（ComposerAttachment 从那里导出）：
// 格式判定在 ./attachmentKind.ts，纯叶、可单测，chip、@ 上下文列表、文件选择
// 对话框三处共用同一份真源。

// 推理强度档位 — 对齐 i18n chat.toolbar.thoughtLevel.value.* 真源
const THOUGHT_LEVELS: { id: string; label: string }[] = [
  { id: 'off', label: '不思考' },
  { id: 'low', label: '低' },
  { id: 'high', label: '高' },
  { id: 'max', label: '最高' },
]

// 「添加上下文」按钮 — 对齐 ZCode G0 实测（s-22）的四项菜单：
// 添加附件 / 使用 @ 添加上下文 / 使用 / 选择能力 / 使用 $ 选择技能。
// 附件走真实文件选择对话框（fs:selectFiles），不再自造 file_N.tsx 假名；
// @ / $ 三项把触发字符插进输入框并拉起对应的提及面板。
function AddContextButton({
  onAttach,
  onInsertTrigger,
}: {
  onAttach: (kind: 'file' | 'image') => void
  onInsertTrigger: (trigger: '@' | '$' | '/') => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const items: { id: string; label: string; run: () => void }[] = [
    { id: 'attach', label: '添加附件', run: () => onAttach('file') },
    { id: 'image', label: '上传图片', run: () => onAttach('image') },
    { id: 'at', label: '使用 @ 添加上下文', run: () => onInsertTrigger('@') },
    { id: 'slash', label: '使用 / 选择能力', run: () => onInsertTrigger('/') },
    { id: 'dollar', label: '使用 $ 选择技能', run: () => onInsertTrigger('$') },
  ]

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        className="p-2 rounded-lg text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
        title="添加上下文"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="plus" size={18} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full mb-2 left-0 w-52 bg-popover border border-popover-border rounded-lg shadow-xl overflow-hidden z-50"
        >
          <div className="px-3 py-2 text-xs font-semibold text-foreground-muted border-b border-popover-border">
            添加上下文
          </div>
          {items.map((it) => (
            <button
              key={it.id}
              role="menuitem"
              onClick={() => { setOpen(false); it.run() }}
              className="w-full text-left px-3 py-2 text-sm text-popover-foreground hover:bg-surface-hover transition-colors"
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// 「上下文已用 X / 总量 Y」按钮 + 用量弹窗 — 对齐 ZCode 实测 a57 的 pressable
// 统计按钮与 G0d 的上下文容量弹窗。数字来自 host 的 estimateTokens 真源启发式
// （tokenUsageService）。ZCode 弹窗里的「分类明细（消息/MCP 工具/系统提示词…）
// + 缓存命中率」需要后端分类统计，本端只有总量估算 —— 弹窗如实说明这一点，
// 不给造出来的百分比。
function ContextUsageButton({ used, total, error }: { used: number; total: number; error: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const pct = total > 0 ? (used / total) * 100 : 0
  const pctLabel = pct >= 10 ? `${pct.toFixed(0)}%` : `${pct.toFixed(1)}%`

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center h-7 px-2 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors tabular-nums whitespace-nowrap"
        title={error || `当前会话上下文已用 ${formatCompactNumber(used)} tokens`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        上下文已用 {formatCompactNumber(used)} / 总量 {formatCompactNumber(total)}
      </button>
      {open && (
        <div className="absolute bottom-full mb-2 right-0 w-72 bg-popover border border-popover-border rounded-lg shadow-xl overflow-hidden z-50">
          <div className="px-3 py-2 text-xs font-semibold text-foreground-muted border-b border-popover-border">
            上下文容量
          </div>
          <div className="px-3 py-2.5">
            <div className="flex items-baseline justify-between text-sm text-popover-foreground">
              <span className="tabular-nums">{pctLabel}</span>
              <span className="text-xs text-foreground-muted tabular-nums">
                {formatCompactNumber(used)} / {formatCompactNumber(total)} tokens
              </span>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-input overflow-hidden">
              <div
                className={`h-full rounded-full ${pct > 90 ? 'bg-destructive' : 'bg-brand'}`}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
            {error ? (
              <p className="mt-2 text-xs text-destructive">{error}</p>
            ) : (
              <p className="mt-2 text-xs text-foreground-muted leading-relaxed">
                分类明细（消息 / 工具 / 系统提示词）与缓存命中率需后端分类统计，当前未接线，因此只显示总量估算。
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// 「打开运行中的后台任务」按钮（P3-6①）— 对齐 ZCode i18n
// chat.composer.backgroundWorks.ariaLabel「Bash {n} 个，子智能体 {n} 个，
// 共 {n} 个」；count=0 时隐藏（ZCode 实测空态无此按钮）。数据经
// host → background.status（在途 ai.generate 集合，含自动化运行）。
// 点击展开面板列出在途任务 id（host 真值）；bash/subagent 计数事件流仍待接，
// 面板里如实标注恒 0，不给假数。
function BackgroundTasksButton() {
  const [count, setCount] = useState(0)
  const [bashCount, setBashCount] = useState(0)
  const [subagentCount, setSubagentCount] = useState(0)
  const [taskIds, setTaskIds] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const refresh = useCallback(() => {
    const api = (window as unknown as {
      __KHYOS__?: {
        backgroundStatus?: () => Promise<{
          ok: boolean
          status?: { count: number; bash: number; subagents: number; taskIds?: string[] }
          error?: string
        }>
      }
    }).__KHYOS__
    if (!api?.backgroundStatus) return
    api.backgroundStatus().then((res) => {
      if (res?.ok && res.status) {
        setCount(res.status.count)
        setBashCount(res.status.bash)
        setSubagentCount(res.status.subagents)
        setTaskIds(res.status.taskIds || [])
      }
    }).catch(() => {
      /* fail-soft：host 不可用时按钮保持隐藏 */
    })
  }, [])

  // 3s 轮询（纯 UI 计数刷新，非任务截止——规则 3 合规）
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (count === 0) return null
  const label = `Bash ${bashCount} 个，子智能体 ${subagentCount} 个，共 ${count} 个`
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center h-7 px-2 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors gap-1.5 whitespace-nowrap"
        title={`打开运行中的后台任务：${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M4.5 4.5l3.5 2.5-3.5 2.5" stroke="currentColor" strokeWidth="0.93" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="1.5" y="1.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="0.93" />
        </svg>
        <span>{label}</span>
      </button>
      {open && (
        <div className="absolute bottom-full mb-2 right-0 w-72 bg-popover border border-popover-border rounded-lg shadow-xl overflow-hidden z-50">
          <div className="px-3 py-2 text-xs font-semibold text-foreground-muted border-b border-popover-border">
            运行中的后台任务
          </div>
          <div className="max-h-56 overflow-auto py-1">
            {taskIds.length === 0 ? (
              <div className="px-3 py-2 text-xs text-foreground-muted">没有在途任务。</div>
            ) : (
              taskIds.map((id) => (
                <div key={id} className="px-3 py-1.5 text-xs text-popover-foreground font-mono truncate" title={id}>
                  {id.startsWith('auto_') ? `定时任务运行 ${id}` : `AI 生成 ${id}`}
                </div>
              ))
            )}
          </div>
          <div className="px-3 py-2 border-t border-popover-border text-xs text-foreground-muted leading-relaxed">
            Bash 子进程与子智能体计数需后端执行事件流（bash.start/stop），当前恒 0 —— 不计为已连接。
          </div>
        </div>
      )}
    </div>
  )
}

// 模型选择器 — **两级**：顶部选提供商，下面列这家提供商的模型。
//
// 数据源与终端 `/model` 同一份（host 侧走 collectModelEntries 采集叶），所以
// 「终端里选得到的这里也有、反之亦然」是构造保证的，不是两套清单对齐出来的。
// 之前是一屏混列所有提供商的模型，加了几个中转站就找不到自己要的那家。
function ModelSelector({ current, currentLabel, error, onChange, options }: {
  // current 是选项表主键（选项 id），不是展示标签：拿标签去比 o.id 恒 miss，
  // 打勾、光标、一级展开会全部落空。currentLabel 只用于折叠态按钮文案。
  current: string
  currentLabel?: string
  error?: string
  onChange: (id: string) => void
  options: ModelOption[]
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [providerKey, setProviderKey] = useState('')
  const [cursor, setCursor] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  // 关闭即清 providerKey：activeKey 把 providerKey 排在当前选中模型之前，
  // 不清的话重开面板停在上次点过的那家，而不是当前选中模型所在家。
  const close = () => {
    setOpen(false)
    setProviderKey('')
  }

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const groups = groupByProvider(options)
  const currentOption = options.find((o) => o.id === current)

  // 当前展开哪家：优先用户点过的那家，否则跟着当前选中模型走，再否则第一家。
  const activeKey = providerKey || currentOption?.group || groups[0]?.key || ''
  const activeGroup = groups.find((g) => g.key === activeKey) || groups[0]

  // 搜索命中集即候选集（空搜索词命中全部）。
  const q = query.trim().toLowerCase()
  const hitGroups = groups.filter(
    (g) =>
      g.label.toLowerCase().includes(q) ||
      g.options.some((o) => o.label.toLowerCase().includes(q) || (o.model || '').toLowerCase().includes(q))
  )
  // 二级栏、标题与一级打勾共用这一个组：命中集里优先当前家，否则第一家。
  // 各算各的会出现「上面列 A、下面列 B 家的模型」，用户无从判断自己在选谁。
  const shownGroup = hitGroups.find((x) => x.key === activeGroup?.key) || hitGroups[0]

  // 第二级要显示的条目 = 该提供商的模型 + 当前搜索词下的那批。
  const rows = useMemo(() => {
    const g = shownGroup
    if (!g) return []
    if (!q) return g.options
    return g.options.filter(
      (o) =>
        g.label.toLowerCase().includes(q) ||
        o.label.toLowerCase().includes(q) ||
        (o.model || '').toLowerCase().includes(q)
    )
  }, [shownGroup, q])

  useEffect(() => {
    if (!open) return
    const at = rows.findIndex((r) => r.id === current)
    setCursor(at >= 0 ? at : 0)
  }, [open, activeKey, q]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (id: string) => {
    onChange(id)
    close()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      close()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!rows.length) return
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setCursor((c) => (c + delta + rows.length) % rows.length)
      return
    }
    if (e.key === 'Enter' && rows[cursor]) {
      e.preventDefault()
      pick(rows[cursor].id)
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => { if (open) close(); else { setOpen(true); setQuery('') } }}
        className="inline-flex items-center h-7 px-2 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors gap-1 max-w-[180px]"
        title="选择模型"
      >
        <span className="truncate">{currentOption?.label ?? (currentLabel || '选择模型')}</span>
        <Icon name="chevron-down" size={12} className="shrink-0 opacity-70" />
      </button>
      {open && (
        <div
          className="absolute bottom-full mb-2 right-0 w-72 bg-popover border border-popover-border rounded-lg shadow-xl overflow-hidden animate-slide-down z-50"
          onKeyDown={onKeyDown}
        >
          <div className="px-3 py-2 border-b border-popover-border">
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setCursor(0) }}
              placeholder="搜索模型…"
              className="w-full bg-input border border-input-border rounded-lg px-2 py-1.5 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none"
            />
          </div>
          {/* ── 第一级：提供商 ─────────────────────────────────── */}
          <div className="border-b border-popover-border py-1">
            <div className="px-3 pt-1 pb-0.5 text-[10px] text-foreground">提供商</div>
            <div className="max-h-24 overflow-auto">
              {(q ? hitGroups : groups).map((g) => (
                <button
                  key={g.key}
                  onClick={() => { setProviderKey(g.key); setQuery(''); setCursor(0) }}
                  className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition-colors ${
                    g.key === shownGroup?.key ? 'bg-surface-hover text-foreground' : 'text-popover-foreground'
                  }`}
                >
                  <span className="w-3 shrink-0 text-brand text-xs">
                    {g.key === shownGroup?.key ? <Icon name="check" size={12} className="text-brand" /> : null}
                  </span>
                  <span className="truncate flex-1">{g.label}</span>
                  <span className="shrink-0 rounded border border-popover-border px-1 py-px text-[10px] text-foreground-muted">
                    {credentialBadge(g.options[0]?.adapter || g.key)}
                  </span>
                  <span className="shrink-0 text-[10px] text-foreground">{g.options.length}</span>
                </button>
              ))}
              {groups.length === 0 && (
                <div className="px-3 py-2 text-xs text-foreground-muted">{error || '加载模型列表…'}</div>
              )}
            </div>
          </div>

          {/* ── 第二级：该提供商的模型 ────────────────────────── */}
          <div className="py-1">
            <div className="px-3 pt-1 pb-0.5 text-[10px] text-foreground">
              {shownGroup ? `${shownGroup.label} 的模型（${rows.length}）` : '模型'}
            </div>
            <div className="max-h-56 overflow-auto">
              {rows.map((m, index) => {
                const active = current === m.id
                return (
                  <button
                    key={m.id}
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => pick(m.id)}
                    className={`w-full text-left px-3 py-1.5 text-sm text-popover-foreground transition-colors flex items-center gap-2 ${
                      cursor === index ? 'bg-surface-hover' : ''
                    } ${active ? 'text-brand' : ''} ${m.fromUpstream ? '' : 'opacity-60'}`}
                  >
                    <span className="w-3 shrink-0 text-brand text-xs">
                      {active ? <Icon name="check" size={12} className="text-brand" /> : null}
                    </span>
                    <span className="truncate flex-1">{m.label}</span>
                    {(m.tags ?? []).map((t) => (
                      <span
                        key={t}
                        className="shrink-0 rounded border border-popover-border px-1 py-px text-[10px] text-foreground-muted"
                      >
                        {t}
                      </span>
                    ))}
                  </button>
                )
              })}
              {options.length > 0 && rows.length === 0 && (
                <div className="px-3 py-3 text-xs text-foreground-muted">没有匹配的模型</div>
              )}
              {/* 静态目录兜底的条目没经上游确认，标出来而不是混在真实模型里。 */}
              {rows.some((m) => !m.fromUpstream) && (
                <div className="px-3 pt-1 pb-0.5 text-[10px] text-foreground">
                  调暗项来自内置目录，未经该上游确认
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// provider 行的凭据形态徽章，与 host 侧 credentialBadgeOf 同一套判定词表
// （两侧都对齐 ZCode 的 provider 标签语义；桌面拿不到 host 的映射表，按
// channel 名再判一次，认不出的归 API —— 中转站本来就是 API key）。
function credentialBadge(channel: string): string {
  const key = String(channel || '').toLowerCase()
  if (['ollama', 'lmstudio', 'local'].includes(key)) return '本地'
  if (['claude', 'codex', 'kiro', 'cursor', 'cursor2api', 'trae', 'qoder', 'gemini-cli'].includes(key)) return '订阅'
  return 'API'
}

// 推理强度按钮（对齐 i18n chat.toolbar.thoughtLevel.*，Ctrl+T 循环切换）
function ThoughtLevelButton({ level, onChange }: { level: string; onChange: (l: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = THOUGHT_LEVELS.find((l) => l.id === level) ?? THOUGHT_LEVELS[0]

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center h-7 px-2 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors gap-1"
        title="推理强度 (Ctrl+T)"
      >
        <span>{current.label}</span>
        <Icon name="chevron-down" size={12} className="shrink-0 opacity-70" />
      </button>
      {open && (
        <div className="absolute bottom-full mb-2 right-0 w-36 bg-popover border border-popover-border rounded-lg shadow-xl overflow-hidden animate-slide-down z-50">
          {THOUGHT_LEVELS.map((l) => (
            <button
              key={l.id}
              onClick={() => { onChange(l.id); setOpen(false) }}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-surface-hover transition-colors ${
                level === l.id ? 'bg-selected text-foreground' : 'text-popover-foreground'
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface MentionItem {
  id: string
  label: string
  description?: string
  icon?: string
  /** '@' 的文件条目带上桶名，列表里按格式给图标（与附件 chip 同一张映射表）。 */
  kind?: AttachmentKind
  /** '/' 分类：slash:list 同源的命令 token（'/model'；插件名无 / 前缀），用于搜索与发送拦截。 */
  cmd?: string
  /** '/' 分类：经 aliasTermsForRow 连接上的别名键（如 项目→/project），参与菜单搜索。 */
  aliases?: string[]
  /** '/' 分类：main 侧分好的执行通道（见 slashCommandMerge.classifySlashRunnable）。 */
  runnable?: 'routed' | 'prompt' | 'cc' | 'none'
}

// '/' 菜单搜索：label 之外还匹配命令 token 与别名键。别名 join 不上的键
// （实测 模型→models list 无对应 route）本来就不在 aliases 里，不产生假命中。
function matchesMention(item: MentionItem, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (item.label.toLowerCase().includes(q)) return true
  if (item.cmd && item.cmd.toLowerCase().includes(q)) return true
  return (item.aliases || []).some((a) => a.toLowerCase().includes(q))
}

// slash:list 载荷 → 菜单条目。菜单懒加载与发送拦截的「先补清单」两处共用同一映射，
// 避免两处字段漂移。
function slashRowsToMentionItems(commands: SlashMenuRowPayload[] | undefined): MentionItem[] {
  return (commands || []).map((row) => ({
    id: row.id,
    label: row.label,
    description: row.description,
    cmd: row.cmd,
    aliases: row.aliases || [],
    runnable: row.runnable,
  }))
}

// 提及分类的静态框架（ZCode chat.mention.category 六分类中的四项；画板/插件
// 入口尚未实现）。条目本身不再写死 mock —— 会话来自 host session.list（真实
// .khy/sessions）、技能/命令来自 agentItemStore（agent:list），在 Composer 内
// 按需拉取。拉不到就显示空态提示，不拿假数据充数（P3-1/P3-4 同类问题）。
const MENTION_META: Record<string, { label: string }> = {
  '@': { label: '添加上下文' },
  '#': { label: '插入会话' },
  '$': { label: '选择技能' },
  '/': { label: '选择能力' },
}

// 提及空态：问题 + 原因 + 补救入口（规则 2.2 错误/空态模板）。四类数据各有各的
// 「为什么是空的」，此前共用一句「数据来自本地会话/技能/命令索引，可在设置中补齐」——
// 对 @（来自当前工作区索引，与设置无关）与 #（来自历史会话）都是误导，且「可在设置中
// 补齐」说了地方却没给路。settingsPage 只在该分类确实在设置页有管理入口时给出
// （设置页 id 见 SettingsPage 的 navGroups），否则不渲染跳转按钮 —— 不给假入口。
const MENTION_EMPTY: Record<string, { hint: string; settingsPage?: string; settingsLabel?: string }> = {
  '@': { hint: '没有匹配的文件：数据来自当前工作区索引，可先按 Ctrl+O 打开工作区。' },
  '#': { hint: '还没有已保存的会话：发过消息之后，这里会列出近期记录。' },
  '$': { hint: '还没有技能：技能来自本机技能目录（如 .claude/skills、.cursor/rules）。', settingsPage: 'skills', settingsLabel: '技能' },
  '/': { hint: '还没有可用命令：命令来自 khy 终端命令注册表与本机命令目录（如 .claude/commands、.codex/prompts）。', settingsPage: 'commands', settingsLabel: '命令' },
}

export function Composer({
  modelName,
  modelId,
  prefillText,
  onPrefillConsumed,
  header,
  variant = 'bottom',
  thoughtLevel = 'max',
  onThoughtLevelChange,
  onModelChange,
  agentMode = DEFAULT_AGENT_MODE,
  onModeChange,
}: {
  // 当前选中模型的展示名（App 用 getModelOptionLabel 解析后传入）。此前这个 prop
  // 被解构并使用，却没写进类型里 —— App.tsx 传它时一直是类型错误。
  modelName?: string
  /** 选中的模型**选项 id**（如 `agnes/agnes-2.0-flash`）。modelName 是显示标签，
   *  含 `provider · model` 前缀，拿它查上下文窗口会 miss，故分母走这个。 */
  modelId?: string
  prefillText?: string
  onPrefillConsumed?: () => void
  // 卡片顶端的可选槽位（[DESIGN-ARCH-125] P-01）：空态首页传入工作空间选择行；
  // 日常会话不传。Composer 不关心槽位里是什么，只负责版式位置与分隔线。
  header?: ReactNode
  // 'bottom' = 钉在页面底部的会话输入条（有消息时）；
  // 'card'   = 居中悬浮输入卡片（空态首页，ZC-ALIGN-005 E3）。
  variant?: 'bottom' | 'card'
  // P3-8：推理强度 / 模型 选择器 props（与 ZCode Composer 右下角整簇对齐）
  thoughtLevel?: string
  onThoughtLevelChange?: (level: string) => void
  onModelChange?: (modelId: string) => void
  // 模式选择器（ZCode G0b「切换模式」combobox）
  agentMode?: string
  onModeChange?: (mode: string) => void
}) {
  const [input, setInput] = useState('')
  const [mentionType, setMentionType] = useState<MentionType>(null)
  const [mentionQuery, setMentionQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [sending, setSending] = useState(false)
  // 请求生命周期对全部 Composer 实例透明：流式状态来自全局 messageSlice
  // （此前 sending 是局部 state —— 空态卡片发出的请求在切换到会话视图后，
  // 底部输入条看不到在途请求，导致无横幅、无停止按钮的无限等待）。
  const globalStreaming = useAppSelector((s) => s.message.isStreaming)
  const streamingSince = useAppSelector((s) => s.message.streamingSince)
  const retryRequest = useAppSelector((s) => s.message.retry)
  const inFlight = sending || globalStreaming
  // 已等待秒数（纯 UI 计时器，1s 心跳，非任务截止 —— 规则 3 合规）
  const [elapsedSec, setElapsedSec] = useState(0)
  useEffect(() => {
    if (!streamingSince) {
      setElapsedSec(0)
      return
    }
    const tick = () => setElapsedSec(Math.floor((Date.now() - streamingSince) / 1000))
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [streamingSince])
  // 提及条目按触发字符懒加载（真实数据源，见 loadMentionItems）
  const [mentionItems, setMentionItems] = useState<Record<string, MentionItem[]>>({})
  // 上下文窗口估算（P3-5/P3-6：对齐 ZCode「上下文已用 X / 总量 Y」按钮，
  // 数据经 host → tokenUsageService.estimateTokens 真源启发式，非自造）
  const [ctxUsed, setCtxUsed] = useState(0)
  const [ctxTotal, setCtxTotal] = useState(0)
  const [ctxError, setCtxError] = useState('')
  // P3-7③：模型选项表（host 采集的终端同源选项 + presets 静态目录兜底，
  // 经模块级缓存共享）——handleSend 用它把选中 provider 的 channel 钉进
  // options.preferredAdapter。
  const catalog = useModelCatalog()
  const catalogOptions = catalog.options
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mentionRef = useRef<HTMLDivElement>(null)
  // 斜杠拦截的在途闭锁：拦截等待清单往返期间，同一条 / 输入可能被再次回车。
  const slashInterceptBusy = useRef(false)
  const dispatch = useAppDispatch()

  // 估算当前会话上下文 token 数：汇总消息流文本 + 当前输入，经 host 真源启发式。
  // model 一并透传：分母按所选模型的真实窗口算（host 侧解析链见 host/index.ts
  // contextWindowLimit），否则会恒显示 128000。
  const refreshContextEstimate = useCallback((currentInput: string, currentModel?: string) => {
    const api = (window as unknown as {
      __KHYOS__?: { estimateContextSize?: (text?: string, model?: string) => Promise<{ ok: boolean; estimate?: { used: number; total: number }; error?: string }> }
    }).__KHYOS__
    if (!api?.estimateContextSize) {
      setCtxError('上下文估算不可用：preload 未注入 __KHYOS__，请重启应用')
      return
    }
    const { messages } = store.getState().message
    const text = [...messages.map((m) => m.content), currentInput].join('\n').slice(0, 400_000)
    api.estimateContextSize(text, currentModel).then((res) => {
      if (res?.ok && res.estimate) {
        setCtxUsed(res.estimate.used)
        setCtxTotal(res.estimate.total)
        setCtxError('')
      } else {
        setCtxError(res?.error || '上下文估算失败：host 进程无响应，请重启应用')
      }
    }).catch(() => {
      setCtxError('上下文估算失败：host 进程无响应，请重启应用')
    })
  }, [])

  // 会话内容、输入或所选模型变化时刷新估算（输入侧 300ms 防抖，避免逐字符打 host）
  useEffect(() => {
    const t = setTimeout(() => refreshContextEstimate(input, modelId), 300)
    return () => clearTimeout(t)
  }, [input, modelId, refreshContextEstimate])

  // 消息流追加（ai:chunk 经 appendMessageContent 更新 store）时同步刷新
  useEffect(() => {
    return store.subscribe(() => {
      const { isStreaming } = store.getState().message
      if (isStreaming) refreshContextEstimate('', modelId)
    })
  }, [modelId, refreshContextEstimate])

  // 「添加上下文」菜单 → 添加附件 / 上传图片：走真实文件选择对话框
  // （fs:selectFiles），加入的是用户挑中的真实路径；取消则不动。
  const handleAttach = useCallback((kind: 'file' | 'image') => {
    const api = (window as unknown as {
      __KHYOS__?: {
        selectFiles?: (filters?: { name: string; extensions: string[] }[]) => Promise<{ path: string; size: number }[]>
      }
    }).__KHYOS__
    if (!api?.selectFiles) {
      dispatch(addToast({ type: 'error', title: '附件选择不可用：preload 未注入 __KHYOS__，请重启应用' }))
      return
    }
    // 筛选器按桶分组给出（原先只有「图片 / 文本与代码」两组，pdf、docx、mp4
    // 在对话框里根本选不到 —— 图标做得再细，用户选不中也白搭）。末组放开
    // 所有文件：格式认不出来也能加，chip 退回通用 file 字形。
    const filters = kind === 'image'
      ? [{ name: '图片', extensions: extensionsOf('image') }]
      : [
          { name: '文档', extensions: extensionsOf('pdf', 'doc', 'sheet', 'slide') },
          { name: '图片与音视频', extensions: extensionsOf('image', 'video', 'audio') },
          { name: '文本与代码', extensions: extensionsOf('text', 'code') },
          { name: '压缩包', extensions: extensionsOf('archive') },
          { name: '所有文件', extensions: ['*'] },
        ]
    void api.selectFiles(filters).then((picked) => {
      if (!picked || picked.length === 0) return
      setAttachments((prev) => {
        const known = new Set(prev.map((a) => a.path))
        const added = picked
          .filter((f) => !known.has(f.path))
          .map((f, i) => ({
            id: `att_${Date.now()}_${i}`,
            name: baseName(f.path),
            path: f.path,
            size: f.size,
            kind: attachmentKind(f.path),
          }))
        return [...prev, ...added]
      })
    }).catch((err: unknown) => {
      dispatch(addToast({ type: 'error', title: `选择文件失败：${String(err)}，请重试` }))
    })
  }, [dispatch])

  // ── 粘贴附件（Ctrl+V）────────────────────────────────────────────────────
  // 剪贴板里带文件/图片时（截图工具复制、网页图片复制、资源管理器复制文件），
  // 这些内容落盘成临时文件后作为附件入列，chip 用 SVG 图标区分类型。
  // 落盘走主进程：渲染层不碰文件系统，路径也必须是真实路径（后续要交给后端读）。
  // 图片先经 preparePastedImage 缩放 + 重编码：整屏截图原样 base64 会撑大 IPC
  // 载荷，也超出视觉模型的长边上限（原因见 imagePaste.ts 文件头）。
  const addPastedFiles = useCallback(async (files: File[]) => {
    const api = (window as unknown as {
      __KHYOS__?: {
        saveClipboardFile?: (name: string, base64: string) => Promise<{ ok: boolean; path?: string; size?: number; error?: string }>
      }
    }).__KHYOS__
    if (!api?.saveClipboardFile) {
      dispatch(addToast({ type: 'error', title: '粘贴附件不可用：preload 未注入 __KHYOS__，请重启应用' }))
      return
    }
    const added: ComposerAttachment[] = []
    const scaled: string[] = []
    for (const file of files) {
      const fallback = file.name || (file.type.startsWith('image/') ? '粘贴图片' : '粘贴文件')
      try {
        const prepared = await preparePastedImage(file)
        const res = await api.saveClipboardFile(prepared.fileName, prepared.base64)
        if (!res?.ok || !res.path) {
          dispatch(addToast({ type: 'error', title: `粘贴「${fallback}」失败：${res?.error || '未知错误'}` }))
          continue
        }
        const dims = prepared.width && prepared.height ? `${prepared.width}×${prepared.height}` : ''
        const name = prepared.scaled && dims ? `粘贴图片 ${dims}` : fallback
        if (prepared.scaled) scaled.push(dims)
        added.push({
          id: `att_${Date.now()}_${added.length}`,
          name,
          path: res.path,
          size: res.size ?? prepared.size,
          kind: attachmentKind(prepared.fileName, prepared.mime),
        })
      } catch (err: unknown) {
        dispatch(addToast({ type: 'error', title: `粘贴「${fallback}」失败：${String(err)}` }))
      }
    }
    if (added.length > 0) {
      setAttachments((prev) => [...prev, ...added])
      const detail = scaled.length > 0 ? `，其中 ${scaled.length} 张压缩到 ${scaled.join('、')}` : ''
      dispatch(addToast({ type: 'info', title: `已添加 ${added.length} 个粘贴附件${detail}` }))
    }
  }, [dispatch])

  // paste 事件：只有确实带文件时才拦下默认粘贴 —— 纯文本粘贴必须原样进正文，
  // 拦了就等于吞掉用户复制的内容。
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = e.clipboardData
    if (!dt) return
    const files = Array.from(dt.files ?? [])
    if (files.length === 0) return
    e.preventDefault()
    void addPastedFiles(files)
  }, [addPastedFiles])

  // 把 @ / $ / / 触发字符插入光标处并拉起对应提及面板（添加上下文菜单的三个入口）
  const handleInsertTrigger = useCallback((trigger: '@' | '$' | '/') => {
    const t = textareaRef.current
    const s = t?.selectionStart ?? input.length
    const e = t?.selectionEnd ?? s
    setInput(input.slice(0, s) + trigger + input.slice(e))
    requestAnimationFrame(() => {
      t?.focus()
      t?.setSelectionRange(s + 1, s + 1)
    })
    setMentionType(trigger)
    setMentionQuery('')
    setSelectedIndex(0)
  }, [input])

  const handleInput = useCallback((value: string) => {
    setInput(value)
    const lastChar = value.slice(-1)
    if (['@', '#', '$', '/'].includes(lastChar)) {
      setMentionType(lastChar as MentionType)
      setMentionQuery('')
      setSelectedIndex(0)
    } else if (mentionType) {
      const triggerIndex = value.lastIndexOf(mentionType)
      if (triggerIndex < 0) {
        // 触发字符被删掉了（退格删 /、整段重打）—— 面板必须跟着关：
        // 再留着它就只剩一个空查询列表，输入框里却已经没有那个触发字符了。
        setMentionType(null)
      } else {
        const after = value.slice(triggerIndex + 1)
        if (after.includes(' ')) {
          setMentionType(null)
        } else {
          setMentionQuery(after)
        }
      }
    }
  }, [mentionType])

  // runnable 'none'（终端 REPL 闭包命令）不渲染成可点项 —— 诚实边界：不留点了
  // 没反应的假按钮。它们仍留在 mentionItems 里，发送拦截靠它给出诚实报错。
  const filteredItems = mentionType
    ? (mentionItems[mentionType] ?? [])
        .filter(item => item.runnable !== 'none')
        .filter(item => matchesMention(item, mentionQuery))
    : []
  // 空态文案与补救入口（见 MENTION_EMPTY 注释）。抽成变量而非在 JSX 里查表：
  // 跳转按钮的回调是闭包，闭包里 TS 无法保持 mentionType 的非空收窄。
  const mentionEmpty = mentionType ? MENTION_EMPTY[mentionType] : undefined

  // 提及条目的真实数据源：'#' 会话（host session.list）/'$' 技能（agentItemStore）、
  // '/' 命令（slash:list —— khy 注册表 + CC 桥/插件在 main 侧合并后的同一份清单，
  // 不在渲染层再并一次表）。首次打开该分类时拉取，失败置空并记错误（不造数据）。
  const loadMentionItems = useCallback((trigger: MentionType) => {
    if (!trigger || mentionItems[trigger]) return
    const api = (window as unknown as {
      __KHYOS__?: {
        listSessions?: (limit?: number) => Promise<{ ok: boolean; sessions?: { sessionId: string; title: string; firstUserMessage?: string; updatedAt: number }[] }>
        agentList?: (kind: string) => Promise<{ ok: boolean; items?: { id: string; name: string; description?: string }[] }>
        slashList?: () => Promise<{ ok: boolean; commands?: SlashMenuRowPayload[]; error?: string }>
      }
    }).__KHYOS__
    const setItems = (items: MentionItem[]) => setMentionItems((prev) => ({ ...prev, [trigger]: items }))
    if (trigger === '#') {
      void api?.listSessions?.(20).then((res) => {
        setItems((res?.sessions || []).map((s) => ({
          id: `sess:${s.sessionId}`,
          label: s.title === '(untitled)' && s.firstUserMessage ? `${s.firstUserMessage.slice(0, 30)}${s.firstUserMessage.length > 30 ? '…' : ''}` : (s.title || s.sessionId.slice(0, 12)),
          description: new Date(s.updatedAt).toLocaleString(),
        })))
      }).catch(() => setItems([]))
      return
    }
    if (trigger === '$') {
      void api?.agentList?.('skill').then((res) => {
        setItems((res?.items || []).map((it) => ({
          id: `skill:${it.id}`,
          label: it.name,
          description: it.description || '技能',
        })))
      }).catch(() => setItems([]))
      return
    }
    if (trigger === '/') {
      void api?.slashList?.().then((res) => {
        setItems(slashRowsToMentionItems(res?.commands))
      }).catch(() => setItems([]))
      return
    }
    // '@'：工作区文件（workspace 文件索引，有界）
    const wapi = (window as unknown as { __KHYOS__?: { workspaceListFiles?: (q?: string) => Promise<{ ok: boolean; files?: { path: string; name: string }[] }> } }).__KHYOS__
    void wapi?.workspaceListFiles?.('').then((res) => {
      setItems((res?.files || []).slice(0, 200).map((f) => ({
        id: `file:${f.path}`,
        label: f.name,
        description: f.path,
        kind: attachmentKind(f.name),
      })))
    }).catch(() => setItems([]))
  }, [mentionItems])

  useEffect(() => {
    loadMentionItems(mentionType)
  }, [mentionType, loadMentionItems])

  // 菜单选中（键盘 Enter/Tab 与点击共用）：统一插「/token 」，token 归一到单斜杠。
  // CC 命令名自带 '/'，原先 mentionType + label 的拼法会插出 '//' —— 这里顺手修掉。
  // 只插文本不立即执行：带参数的命令（/msg send x）要留位置；执行分叉在 handleSend。
  const applyMentionSelection = useCallback((item: MentionItem) => {
    if (!mentionType) return
    const triggerIndex = input.lastIndexOf(mentionType)
    const before = triggerIndex >= 0 ? input.slice(0, triggerIndex) : input
    const token = (item.cmd || item.label).replace(/^\//, '')
    setInput(`${before}${mentionType}${token} `)
    setMentionType(null)
  }, [input, mentionType])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Esc 先于「有没有条目」判定：列表为空或筛到 0 条时同样要能关，
    // 否则菜单只能靠删掉触发字符或选中一条才消失。
    if (mentionType && e.key === 'Escape') {
      e.preventDefault()
      setMentionType(null)
      return
    }
    if (mentionType && filteredItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(i => (i + 1) % filteredItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(i => (i - 1 + filteredItems.length) % filteredItems.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const item = filteredItems[selectedIndex]
        if (item) applyMentionSelection(item)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [mentionType, filteredItems, selectedIndex, input, applyMentionSelection])

  // ── 斜杠命令发送拦截 ─────────────────────────────────────────────────
  // 输入以 / 开头且首 token 命中 khy 命令面（slash:list 载荷）时，发送按 main
  // 侧分好的通道分流，不再把命令原文当普通文本发给模型：
  //   routed → slash:run 执行，输出回填会话（runSlashToSession）
  //   prompt → slash:run 拼好的提示词经 aiSend 发送，界面显示命令原文
  //   none   → 诚实报错（执行体在终端 REPL 内），不发 AI
  // 'cc'（CC 桥/插件，维持插文本现状）与未知命令保持原行为：原文发给模型。
  // 带附件时不拦截：附件是给 AI 的上下文，用户此时要的是对话不是命令。
  //
  // 清单是懒加载的（只在敲下 / 触发字符时拉取），两条可达路径会绕过它：粘贴
  // 「/model …」不触发 onChange 的末字符分支；菜单 IPC 未返回就回车。所以拦截前
  // 若缓存未就绪（未拉取过，或上次拉取失败/为空）先 await 一次清单再查——否则
  // 已知 routed 命令查不到行，原文被当聊天文本发给模型，用户看到的是静默假成功。
  // 拉取仍失败/仍为空时才回落原文（此时 slash:run 同样不可用，报「未找到命令」
  // 反而是谎报）。
  const reportSlashFailure = (display: string, res: SlashRunOutcome | undefined) => {
    dispatch(addMessage({
      id: `a_${Date.now()}`,
      role: 'assistant' as const,
      content: String(res?.error || `命令 ${display} 执行失败：未知原因，请重试`),
      timestamp: Date.now(),
      status: 'error' as const,
      error: res?.error,
    }))
  }

  const interceptSlashSend = async (text: string): Promise<boolean> => {
    if (attachments.length > 0) return false
    if (!text.startsWith('/') || text.length < 2) return false
    let rows = mentionItems['/']
    if (!rows || rows.length === 0) {
      try {
        const res = await callSlashList()
        const mapped = slashRowsToMentionItems(res?.commands)
        if (res?.ok && mapped.length > 0) {
          rows = mapped
          setMentionItems((prev) => ({ ...prev, '/': mapped }))
        }
      } catch {
        /* 拉取失败 → 行查不到，回落原文现状 */
      }
    }
    const token = '/' + text.slice(1).split(/\s+/)[0].toLowerCase()
    const rest = text.slice(token.length).trim()
    const row = (rows || []).find((it) => (it.cmd || '').toLowerCase() === token)
    if (!row || !row.runnable || row.runnable === 'cc') return false
    const display = `${row.cmd}${rest ? ` ${rest}` : ''}`
    if (row.runnable === 'routed') {
      void runSlashToSession(row.cmd!, rest)
      return true
    }
    if (row.runnable === 'prompt') {
      void (async () => {
        let res: SlashRunOutcome
        try {
          res = await callSlashRun(row.cmd!, rest)
        } catch (err) {
          reportSlashFailure(display, { ok: false, error: String(err) })
          return
        }
        if (res?.ok && res.action === 'prompt' && res.prompt) {
          // 等 slash:run 往返的间隙里用户可能已发出另一条消息：在途守卫重查一次，
          // 避免技能提示词与那条消息并发进网关。
          if (store.getState().message.isStreaming) {
            reportSlashFailure(display, { ok: false, error: '已有消息在发送中：技能提示词未发出，请重试该命令' })
            return
          }
          sendPrompt(display, res.prompt)
        } else {
          reportSlashFailure(display, res)
        }
      })()
      return true
    }
    dispatch(addMessage({
      id: `u_${Date.now()}`,
      role: 'user' as const,
      content: display,
      timestamp: Date.now(),
      status: 'complete' as const,
    }))
    reportSlashFailure(display, {
      ok: false,
      error: `桌面端无法执行 ${row.cmd}：它的执行体在 khy 终端 REPL 内（会话状态/交互面板），主进程调不到。请打开终端面板运行 khy 后输入该命令`,
    })
    return true
  }

  const handleSend = (overrideText?: string) => {
    // 全局在途守卫：任一 Composer 实例已有请求在飞（含错误卡片触发的重试）
    // 时拒绝重复发送，避免双实例各发一遍。
    if (sending || store.getState().message.isStreaming) return
    const text = (overrideText ?? input).trim()
    if (!text && attachments.length === 0) return
    if (!text.startsWith('/')) {
      sendPrompt(text, text)
      return
    }
    // 拦截现在是异步的（缓存未就绪要先补清单）：同一输入在 await 窗口内可能
    // 被回车第二次，闭锁挡掉双发；结果回来后再重查一次全局在途守卫。
    if (slashInterceptBusy.current) return
    slashInterceptBusy.current = true
    void interceptSlashSend(text)
      .then((intercepted) => {
        slashInterceptBusy.current = false
        if (store.getState().message.isStreaming) return
        if (intercepted) {
          setInput('')
          return
        }
        sendPrompt(text, text)
      })
      .catch(() => {
        slashInterceptBusy.current = false
      })
  }

  // 显示文案与实际载荷分离的唯一发送路径：普通发送两者相同；斜杠技能命令
  // （prompt 通道）显示命令原文，载荷是 main 拼好的提示词正文。
  const sendPrompt = (displayText: string, payloadPrompt: string) => {
    const userMsg = {
      id: `u_${Date.now()}`,
      role: 'user' as const,
      content: displayText,
      timestamp: Date.now(),
      status: 'complete' as const,
    }
    // 用户已开始新动作 → 上一次会话加载失败的原因作废（错误态优先级高于列表，
    // 不清除的话新消息与流式回复会被永久挡在错误面板后面）。
    dispatch(clearSessionLoadError())
    dispatch(addMessage(userMsg))
    const assistantId = `a_${Date.now()}`
    // 本轮工具执行归属这条助手消息：渲染层据此把过程挂回本轮的提问下面，
    // 而不是挂成一个全局块（那会跟着会话一起漂移）。
    dispatch(beginToolTurn({ messageId: assistantId }))
    dispatch(addMessage({ id: assistantId, role: 'assistant', content: '', timestamp: Date.now(), status: 'streaming' }))
    dispatch(setStreaming(true))
    dispatch(setAgentWorking(true))
    dispatch(recordLastPrompt(displayText))
    setSending(true)
    setInput('')
    setAttachments([])
    setMentionType(null)

    // CH-2: renderer → main IPC → host fork → KhyOS 后端 agent 工具循环。
    // 返回字段与 host 的 ai.result 对齐：empty 只在「既无正文也无工具执行」时为真，
    // 纯工具轮次（模型只用工具回答）不算空回复。
    const api = (window as unknown as {
      __KHYOS__?: {
        aiSend: (p: unknown) => Promise<{
          ok: boolean
          text?: string
          empty?: boolean
          error?: string
          provider?: string
          actualAdapter?: string
          fallbackReason?: string
          errorType?: string
          toolCallCount?: number
        }>
      }
    }).__KHYOS__
    if (!api?.aiSend) {
      dispatch(updateMessage({ id: assistantId, updates: { content: '', status: 'error', error: 'preload 未注入：__KHYOS__ 不可用，请重启应用' } }))
      dispatch(setStreaming(false))
      dispatch(setAgentWorking(false))
      setSending(false)
      return
    }
// P3-7：把当前选中的 provider 透传给 aiGateway（options.preferredAdapter，
    // 与 CLI `khy gateway` 的通道选择同契约）。
    //
    // 模型级选项 id 形如 `provider/model`，channel 字段按生产者分：采集路径是
    // 适配器类型（entry.value.adapter，'api'），presets 兜底路径才是后端池 key；
    // channelKnown=false 时（聚合网关等未注册池）不钉 preferredAdapter，走网关
    // 默认通道级联。
    //
    // **modelId 而非 modelName**：modelName 是展示标签（含 `provider · model`
    // 前缀），拿它查选项表必然 miss —— 那样选中的模型压根传不到网关，桌面只
    // 换通道不换模型。modelId 是选项表主键，查得到就同时钉住 preferredModel。
    const selId = modelId ?? ''
    const currentOption = catalogOptions.find((o) => o.id === selId)
    const pid = selId ? selId.split('/')[0] : ''
    const providerOpt = currentOption ?? catalogOptions.find((o) => o.id === pid)
    const sendOptions: Record<string, unknown> = {}
    const adapterKey = providerOpt?.channel || (pid && selId.includes('/') ? pid : selId)
    if (adapterKey && providerOpt?.channelKnown !== false) sendOptions.preferredAdapter = adapterKey
    const selectedModelId = currentOption?.model || (selId.includes('/') ? selId.slice(selId.indexOf('/') + 1) : '')
    if (selectedModelId) sendOptions.preferredModel = selectedModelId
    api.aiSend({ prompt: payloadPrompt, options: sendOptions }).then((res) => {
      if (res?.ok && res.text) {
        dispatch(updateMessage({ id: assistantId, updates: { content: res.text, status: 'complete' } }))
        dispatch(setMessageStatus({ id: assistantId, status: 'complete' }))
      } else if (res?.ok && res.empty) {
        const chan = res.actualAdapter || res.provider || '未知通道'
        dispatch(updateMessage({
          id: assistantId,
          updates: {
            content: `网关通道 ${chan} 已收到模型答复但未返回正文${res.fallbackReason ? `（fallback：${res.fallbackReason}）` : ''}。请运行 khy gateway status 查看通道健康`,
            status: 'error',
            error: 'empty reply',
          },
        }))
      } else if (res?.ok) {
        dispatch(updateMessage({ id: assistantId, updates: { content: '', status: 'complete' } }))
      } else {
        const chan = res?.actualAdapter || res?.provider || ''
        const detail = res?.error || res?.fallbackReason || '请运行 khy gateway status 检查通道配置'
        dispatch(updateMessage({
          id: assistantId,
          updates: { content: `AI 网关调用失败${chan ? `（通道 ${chan}）` : ''}：${detail}`, status: 'error', error: res?.error },
        }))
      }
      dispatch(setStreaming(false))
      dispatch(setAgentWorking(false))
      setSending(false)
    }).catch((err: unknown) => {
      dispatch(updateMessage({ id: assistantId, updates: { content: `AI 请求失败：${String(err)}，请稍后重试`, status: 'error', error: String(err) } }))
      dispatch(setStreaming(false))
      dispatch(setAgentWorking(false))
      setSending(false)
    })
  }

  // 错误卡片「重试」消费端：监听全局 retry 信号，用出错前的 prompt 原文重发。
  // 只由底部输入条（variant='bottom'）消费 —— 重试发生时消息流必然非空，
  // 空态卡片 composer 已卸载，因此恰好一个实例响应，不会重复发送。
  const lastRetrySeqRef = useRef(0)
  useEffect(() => {
    if (!retryRequest || variant !== 'bottom') return
    if (lastRetrySeqRef.current >= retryRequest.seq) return
    lastRetrySeqRef.current = retryRequest.seq
    handleSend(retryRequest.prompt)
  }, [retryRequest, variant])

  // Quick-action cards prefill the composer: fill the text once when
  // prefillText changes (parent clears it via onPrefillConsumed), then
  // hand focus to the textarea so the user can edit before sending.
  const lastPrefillRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (prefillText === undefined || prefillText === lastPrefillRef.current) return
    lastPrefillRef.current = prefillText
    setInput(prefillText)
    textareaRef.current?.focus()
    onPrefillConsumed?.()
  }, [prefillText, onPrefillConsumed])

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 240) + 'px'
    }
  }, [input])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (mentionRef.current && !mentionRef.current.contains(e.target as Node)) {
        // click outside closes mention
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // 两种形态：'bottom' 钉在会话底部的输入条（顶部分隔线由外层容器给）；'card' 居中悬浮
  // 输入卡片（ZCode 空态首页，圆角卡片 + 阴影，无顶部分隔线）——对齐 ZC-ALIGN-005 E3 实测。
  // card 形态用 bg-card（比 bg-panel 亮一档）配 ring-1 + shadow-2xl，在暗底上真正浮起；
  // bottom 形态沿用 bg-panel 承托输入区，与消息区（--color-background）拉开明度差。
  //
  // **单框原则（2026-10-26 人定，两轮）**：输入区有且只有**一个框**，框里**没有分隔线**。
  //   · card 形态：这个框就是外层卡片本身（ring-1）。输入框自己再套一层圆角描边
  //     就是「框中框」（回字形），已删。
  //   · bottom 形态：外层只是面板条，真正的框是内容容器（rounded-xl + 边框）。
  // 两形态的框内都只有「正文 + 工具栏」，中间不再画横线。
  const isCard = variant === 'card'
  const outerClass = isCard
    ? 'bg-card rounded-xl ring-1 ring-card-border shadow-2xl px-4 py-2.5 focus-within:ring-input-border-focused transition-colors'
    : 'bg-panel px-4 py-3'
  // 框内留白：card 的框自带 px-4/py-2.5，内容不再各留一层；bottom 的框是内容容器，
  // 正文与工具栏自己留内边距（与改前一致）。
  const frameClass = isCard
    ? ''
    : 'rounded-xl border border-input-border bg-input focus-within:border-input-border-focused transition-colors'
  const textPadClass = isCard ? 'px-0 pt-2' : 'px-4 pt-3'
  const barPadClass = isCard ? 'pt-1.5' : 'px-3 pb-2.5 pt-1.5'
  // 加号按钮自带 p-2；card 形态下负边距把图标拉回与正文同一列。
  const leftGroupClass = isCard ? '-ml-2' : ''

  return (
    <div className={outerClass}>
      {/* header 槽位（[DESIGN-ARCH-125] P-01）：空态卡片顶端的「工作空间选择行」。
          日常会话（bottom 形态）不传，即为无 header。
          **这里不画分隔线**（2026-10-26 人定）：输入区只保留一个框，框里零线条，
          header 与正文之间用留白隔开。 */}
      {header && <div className="mb-2">{header}</div>}
      {/* 提及弹出层 — 条目来自真实数据源；拉不到时显示空态行而不是静默关闭 */}
      {mentionType && (
        <div
          ref={mentionRef}
          className="mb-2 bg-popover border border-popover-border rounded-lg shadow-xl overflow-hidden animate-slide-down"
        >
          <div className="px-3 py-2 border-b border-popover-border">
            <span className="text-xs font-semibold text-foreground-muted">{MENTION_META[mentionType]?.label}</span>
            <span className="text-xs text-foreground-muted ml-2">↑↓ 选择 · ↵ 确认 · Esc 关闭</span>
          </div>
          <div className="max-h-48 overflow-auto py-1">
            {filteredItems.length === 0 && (
              <div className="px-3 py-2.5 text-xs text-foreground-muted">
                {mentionQuery ? (
                  '没有匹配的条目：换个关键词，或清空搜索看全部。'
                ) : (
                  <>
                    <div>{mentionEmpty?.hint ?? '暂无可选条目。'}</div>
                    {mentionEmpty?.settingsPage && (
                      <button
                        onClick={() => {
                          setMentionType(null)
                          window.location.hash = `#/settings/${mentionEmpty.settingsPage}`
                        }}
                        className="mt-1.5 text-brand hover:underline"
                      >
                        去设置里管理{mentionEmpty.settingsLabel ?? '条目'} ›
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            {filteredItems.map((item, index) => (
              <button
                key={item.id}
                onClick={() => applyMentionSelection(item)}
                className={`w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors ${
                  index === selectedIndex ? 'bg-selected' : 'hover:bg-surface-hover'
                }`}
              >
                {item.kind ? (
                  <Icon
                    name={ATTACHMENT_ICON[item.kind]}
                    size={16}
                    className={`shrink-0 ${attachmentTint(item.kind)}`}
                  />
                ) : item.icon ? (
                  <span className="text-base">{item.icon}</span>
                ) : null}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-popover-foreground">{item.label}</div>
                  {item.description && (
                    <div className="text-xs text-foreground-muted mt-0.5 truncate">{item.description}</div>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 附件预览 — 交给 AttachmentList：一枚 chip 一个附件，图标按**格式**取
          （pdf / word / 表格 / 演示 / 视频 / 音频 / 压缩包 / Markdown / 文本 /
          代码 / 图片 / 兜底），并带上文件大小。粘贴进来的附件与对话框选的附件
          同列同形 —— 用户不该分得出两者来历。 */}
      <AttachmentList
        attachments={attachments}
        onRemove={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
      />

      {/* 输入区 — **单框、无内线**（2026-10-26 人定，两轮）：
          输入区有且只有一个框（card 形态=卡片本身；bottom 形态=下面这层容器），
          框里没有分隔线 —— 正文与工具栏之间那条横线已删（此前是「框中框 + 一条线」，
          正文下方空出一块没用的地）。
          min-height 从 80px 收到 44px（一行文字的高度），随输入自动长高。

          焦点提示没跟着框一起丢：内框描边变白 → card 形态改为卡片描边（ring）
          变 --color-input-border-focused，bottom 形态仍是容器描边变白。
          relative 只给在途细条当包含块；这里不能加 overflow-hidden ——
          底部工具栏六个向上展开的面板（模型 / 模式 / 推理强度 / 上下文用量 /
          添加上下文 / 后台任务）全是它的后代，会被裁到容器上沿。 */}
      <div className={frameClass}>
        <div className="relative">
          {inFlight && (
            <>
              {/* 在途细条：贴在正文区上沿的一小段品牌色。框内不再有别的线，
                  这条只在请求在途时出现，是进度指示不是分隔线。 */}
              <div className="h-0.5 rounded-full bg-brand/40 animate-pulse mb-1.5" />
              <div className="pb-1 text-xs text-foreground-muted flex items-center gap-2">
                <Spinner size="sm" className="shrink-0 text-brand" />
                <span>
                  等待 KhyOS 网关回复（多通道重试中）· 已等待 {elapsedSec}s{elapsedSec >= 60 ? '，可点「停止」中断' : ''}
                </span>
              </div>
            </>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => handleInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={inFlight ? '继续输入以排队后续修改' : '向 KhyOS 提问，使用 @ 添加上下文，使用 / 选择命令或能力'}
            className={`w-full bg-transparent text-foreground placeholder:text-foreground-muted resize-none focus:outline-none text-sm leading-relaxed pb-2 ${textPadClass}`}
            style={{ minHeight: '44px', maxHeight: '240px' }}
            rows={1}
          />

          {/* 底部工具栏 — 左：添加上下文（ZCode G0 四项菜单）；右：ZCode E5b
              整簇（上下文用量 / 后台任务 / 模式 / 推理强度 / 模型 / 停止 / 发送）。
              **这里不画分隔线**（2026-10-26 人定）：框内零线条，工具栏与正文靠
              留白隔开。
              右侧拆成两个子簇：状态簇（字数 / 上下文用量 / 后台任务，纯读数）与
              动作簇（模式 / 强度 / 模型 / 停止 / 发送，可点）。簇间 gap-2、簇内
              gap-1，动作簇 shrink-0 —— 窄窗换行时状态簇整体让位到上一行，发送
              按钮不会被拆散混排。各项 whitespace-nowrap，窄窗口下换行而不是把
              发送按钮挤出卡片（此前无 nowrap 导致提示文字竖排、发送被裁切）。 */}
          <div className={`flex items-center justify-between gap-2 ${barPadClass}`}>
            <div className={`flex items-center gap-0.5 shrink-0 ${leftGroupClass}`}>
            <AddContextButton
              onAttach={handleAttach}
              onInsertTrigger={handleInsertTrigger}
            />
          </div>

            <div className="flex items-center gap-2 flex-wrap justify-end min-w-0">
              {/* 状态簇 — 读数型信息，视觉上退到背景（更淡的中性色）。 */}
              <div className="flex items-center gap-1 min-w-0">
                {/* 字数最先让位：窗口 <900px 时隐藏（最小窗宽 800，见 desktopUiContract） */}
                {input.length > 0 && (
                  <span className="hidden min-[900px]:inline text-xs text-foreground-muted tabular-nums">{input.length} 字</span>
                )}
                {/* P3-6: 上下文已用/总量 按钮 — 对齐 ZCode 实测 a57
                    「上下文已用 X / 总量 Y」+ G0d 用量弹窗（点开看容量与占比） */}
                {ctxTotal > 0 && (
                  <ContextUsageButton used={ctxUsed} total={ctxTotal} error={ctxError} />
                )}
                {/* P3-6①: 运行中后台任务计数按钮（i18n chat.composer.backgroundWorks；
                    count=0 时隐藏，与 ZCode 空态行为一致） */}
                <BackgroundTasksButton />
              </div>

              {/* 动作簇 — 可点控件，整体不换行、不压缩。 */}
              <div className="flex items-center gap-1 shrink-0">
                {/* 模式选择器（ZCode G0b「切换模式」combobox，四项 mode.description.*） */}
                {onModeChange && <ModeSelector mode={agentMode} onModeChange={onModeChange} />}
                {/* P3-8: 推理强度 选择器（对齐 ZCode a259 combobox 高） */}
                {onThoughtLevelChange && (
                  <ThoughtLevelButton level={thoughtLevel} onChange={onThoughtLevelChange} />
                )}
                {/* P3-7: 模型选择器 — 接后端 providerPresets 真源（useModelCatalog），
                    对齐 ZCode「选择模型」combobox；无 onChange 时退化为只读 chip */}
                {onModelChange ? (
                  <ModelSelector
                    current={modelId ?? ''}
                    currentLabel={modelName}
                    error={catalog.error}
                    onChange={onModelChange}
                    options={catalogOptions}
                  />
                ) : modelName ? (
                  <button
                    className="inline-flex items-center h-7 px-2 rounded-md text-xs text-foreground-muted transition-colors gap-1 whitespace-nowrap"
                    title={`当前模型 ${modelName}（只读）`}
                    disabled
                  >
                    <span>{modelName}</span>
                  </button>
                ) : null}
                {inFlight && (
                  <button
                    onClick={() => {
                      const api = (window as unknown as { __KHYOS__?: { aiAbort?: () => Promise<{ ok: boolean; aborted?: number }> } }).__KHYOS__
                      void api?.aiAbort?.()
                    }}
                    className="inline-flex items-center h-7 px-2.5 rounded-md border border-border text-xs text-foreground/70 hover:text-foreground hover:bg-surface-hover transition-colors gap-1.5 whitespace-nowrap"
                    title="停止等待回复"
                  >
                    <Icon name="stop" size={11} className="shrink-0" />
                    <span>停止</span>
                  </button>
                )}
                <button
                  onClick={() => handleSend()}
                  disabled={inFlight || (!input.trim() && attachments.length === 0)}
                  className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-primary hover:bg-primary-hover active:bg-primary-active transition-colors flex items-center gap-2 shrink-0 whitespace-nowrap"
                >
                  <span>发送</span>
                  <Icon name="send" size={14} className="shrink-0" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

