// khy-canary: Khy-20261102-317-PMKT01AA
// PluginMarketplace — 插件设置页「发现」tab. Renders the surveyed external
// ecosystem catalog (delivery/market) that the backend already serves to the
// web UI, grouped one section per upstream ecosystem. Read-only by design:
// installs still go through the khy CLI gates, so this pane only shows what
// was surveyed, how it maps, and where it comes from.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'

export interface EcoMarketSource {
  name?: string
  url?: string
  kind?: string
  note?: string
}

export interface EcoMarketEntry {
  name?: string
  upstreamUrl?: string
  type?: string
  khyosMarket?: string
  targetPath?: string
  compat?: string
  compatNote?: string
  license?: string
  relationship?: string
  agentScope?: string[]
  what?: string
  reason?: string
  // Live sources (阶跃水产市场) carry the upstream's own install command and the
  // translated KhyOS command side by side, plus the author's avatar.
  command?: string
  khyCommand?: string
  author?: string
  avatarUrl?: string
  version?: string
  downloads?: string
  assetId?: string
  protocol?: EcoMarketProtocol
  // khy-market/1 install spec: what the desktop executes when the user clicks
  // 安装. `installed` comes from the backend ledger + on-disk artifact check.
  marketId?: string
  publishedAt?: string
  updatedAt?: string
  // Domain category: upstream field when the source has one, otherwise a
  // deterministic keyword read reported as `derived`.
  category?: string
  categoryLabel?: string
  categorySource?: string
  installSpec?: MarketInstallSpec | null
  installRequires?: MarketInstallRequires | null
  installed?: boolean
  installedAt?: string
  installedSummary?: string
}

export interface MarketInstallSpec {
  mode?: string
  source?: string
  skills?: string[]
  name?: string
  scope?: string
}

export interface MarketRequirement {
  name?: string
  description?: string
  required?: boolean
  secret?: boolean
}

export interface MarketInstallRequires {
  env?: MarketRequirement[]
  headers?: MarketRequirement[]
}

export interface MarketInstallResult {
  ok?: boolean
  mode?: string
  message?: string
  error?: string
  partial?: boolean
  missing?: string[]
  removed?: string[]
  installed?: Array<{ name?: string; path?: string }>
}

export interface EcoMarketProtocol {
  id?: string
  kind?: string
  market?: string
  compat?: string
  adapter?: string | null
  blocker?: {
    code?: string
    category?: string
    resolution?: string
    note?: string
  } | null
}

export interface EcoMarket {
  eco: string
  title?: string
  surveyedAt?: string
  live?: boolean
  counts?: Record<string, number>
  marketplaces?: EcoMarketSource[]
  entries?: EcoMarketEntry[]
  blocked?: EcoMarketEntry[]
  uncertainties?: string[]
}

// Per-source freshness record from services/marketCatalog: the pane must show
// which upstream is live, which fell back to cache, and which failed — the same
// labels the web page and `khy plugin market` print.
export interface EcoMarketSourceStatus {
  id: string
  title: string
  kind?: string
  status?: string
  eco?: string
  entries?: number
  blocked?: number
  fetchedAt?: string
  message?: string
}

export interface EcoMarketTotals {
  ecosystems: number
  entries: number
  blocked: number
  installed: number
  live: number
}

export interface EcoMarketPayload {
  status?: string
  generatedAt?: string
  fetchedAt?: string
  refreshing?: boolean
  refreshStartedAt?: string
  refreshError?: string
  ecosystems?: EcoMarket[]
  rules?: string[]
  licenseGate?: string
  degraded?: string
  warnings?: string[]
  sources?: EcoMarketSourceStatus[]
  totals?: EcoMarketTotals
}

interface KhyosMarketApi {
  pluginsEcoMarket?: (
    force?: boolean
  ) => Promise<{ ok: boolean; payload?: EcoMarketPayload; error?: string }>
  pluginsMarketInstall?: (
    entry: EcoMarketEntry,
    values?: { env?: Record<string, string>; headers?: Record<string, string> }
  ) => Promise<MarketInstallResult>
  pluginsMarketUninstall?: (entry: EcoMarketEntry) => Promise<MarketInstallResult>
  openExternal?: (url: string) => Promise<{ ok: boolean; error?: string }>
}

function api(): KhyosMarketApi {
  return (window as unknown as { __KHYOS__?: KhyosMarketApi }).__KHYOS__ || {}
}

// The first five sections follow the requested grouping order. Ecosystems the
// survey has not covered yet stay visible as explicit empty groups instead of
// silently disappearing — an absent group must read as "not surveyed", never
// as "no such ecosystem".
const REQUESTED_GROUPS: Array<{ eco: string; label: string; pending: string }> = [
  {
    eco: 'deepseek-harness',
    label: 'DeepSeek Harness',
    pending: '编目尚未收录该生态。',
  },
  {
    eco: 'codex',
    label: 'Codex',
    pending:
      '编目尚未收录 OpenAI Codex 生态：现有条目只在兼容说明里提到 Codex，没有独立的 Codex 市场勘察。补编目需要先确认上游清单来源，确认后此分组会自动出现条目。',
  },
  {
    eco: 'zcode',
    label: 'ZCode',
    pending: '编目尚未收录该生态。',
  },
  {
    eco: 'coder',
    label: 'Coder',
    pending:
      '编目尚未收录名为「Coder」的生态：该名称可能指 OpenCode / Claude Code / Cursor 之一。确认上游后补编目；在此之前不展示未经核实的来源链接。',
  },
  {
    eco: 'mcode',
    label: 'MiniMax Code',
    pending: '编目尚未收录该生态。',
  },
  {
    eco: 'stepfun-openclaw',
    label: '阶跃 OpenClaw',
    pending:
      '阶跃水产市场未接上：本次实时检索失败或后端缺少 marketProtocol/stepfunOpenclaw.js。修复：检查网络后点「刷新编目」重试。',
  },
  {
    eco: 'vscode',
    label: 'VS Code 扩展',
    pending:
      'VS Code 扩展市场未接上：本次 Open VSX 实时检索失败或后端缺少 marketProtocol/vscodeMarketplace.js。修复：检查网络后点「刷新编目」重试。',
  },
  {
    eco: 'kimi-code',
    label: 'Kimi Code',
    pending:
      'Kimi Code 插件市场未接上：公开 marketplace 读取失败或后端缺少 marketProtocol/kimiCode.js。修复：检查网络（或 KHY_KIMI_MARKETPLACE_URLS）后点「刷新编目」重试。',
  },
  {
    eco: 'mcp-registry',
    label: 'MCP Registry',
    pending:
      '官方 MCP Registry 未接上：本次实时检索失败或后端缺少 marketProtocol/mcpRegistry.js。修复：检查网络（或 KHY_MCP_REGISTRY_ENDPOINT）后点「刷新编目」重试。',
  },
]

const COMPAT_BADGE: Record<string, { label: string; cls: string }> = {
  direct: { label: '直连', cls: 'bg-green-500/10 text-green-500' },
  'adapter-needed': { label: '需适配', cls: 'bg-amber-500/15 text-amber-500' },
  covered: { label: '已覆盖', cls: 'bg-emerald-500/10 text-emerald-400' },
  blocked: { label: '阻塞', cls: 'bg-red-500/10 text-red-400' },
}

const ROUTE_BADGE: Record<string, string> = {
  skill: 'Skill',
  mcp: 'MCP',
  extension: '拓展',
  none: '不路由',
}

const KIND_LABEL: Record<string, string> = {
  skill: '技能',
  plugin: '插件',
  agent: 'Agent',
  experience: '经验',
  trigger: '触发器',
  connector: '通信器',
  mcp: 'MCP',
}

function asList<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : []
}

function entryHaystack(entry: EcoMarketEntry): string {
  return [
    entry.name,
    entry.what,
    entry.compatNote,
    entry.reason,
    entry.type,
    entry.license,
    entry.author,
    entry.command,
    entry.khyCommand,
  ]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase()
}

function marketMatches(market: EcoMarket, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [...asList(market.entries), ...asList(market.blocked)].some((e) => entryHaystack(e).includes(q))
}

// Every surveyed upstream is a GitHub repository, so the owner avatar is the
// plugin's own picture. Non-GitHub or offline loads fall back to a monogram
// tile instead of a broken image.
const GITHUB_HOST = 'github.com'

function githubOwner(url?: string): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== GITHUB_HOST) return undefined
    return parsed.pathname.split('/').filter(Boolean)[0]
  } catch {
    return undefined
  }
}

function upstreamLabel(url?: string): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname.replace(/^\/|\/$/g, '')
    return parsed.hostname === GITHUB_HOST ? pathname : `${parsed.hostname}/${pathname}`
  } catch {
    return undefined
  }
}

function monogram(label: string): string {
  const clean = label.trim()
  if (!clean) return '?'
  if (/^[A-Za-z0-9]/.test(clean)) {
    return clean.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || clean.slice(0, 1)
  }
  return clean.slice(0, 1)
}

function hueOf(label: string): number {
  let hue = 0
  for (let i = 0; i < label.length; i += 1) hue = (hue * 31 + label.charCodeAt(i)) % 360
  return hue
}

// Live sources already carry the author's avatar URL; static survey entries are
// GitHub repos, where the owner avatar is the plugin's own picture. Anything
// else falls back to a monogram tile instead of a broken image.
function Avatar({ url, src: explicitSrc, label, size = 28 }: {
  url?: string
  src?: string
  label: string
  size?: number
}) {
  const [failed, setFailed] = useState(false)
  const owner = githubOwner(url)
  const src = explicitSrc || (owner ? `https://${GITHUB_HOST}/${encodeURIComponent(owner)}.png?size=96` : undefined)
  if (!src || failed) {
    return (
      <span
        aria-hidden="true"
        className="flex-shrink-0 flex items-center justify-center rounded-md text-[11px] font-medium text-white/90"
        style={{ width: size, height: size, background: `hsl(${hueOf(label)} 45% 30%)` }}
      >
        {monogram(label)}
      </span>
    )
  }
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="flex-shrink-0 rounded-md object-cover bg-foreground/5"
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  )
}

// Direct entries can be pulled by the same CLI gates the terminal uses; the
// marketplace only hands over the exact command instead of running installs
// behind the user's back. Live sources ship a translated khy command even when
// the route needs an adapter (placeholders are filled after unpacking).
function accessCommand(entry: EcoMarketEntry): string | undefined {
  if (entry.khyCommand) return entry.khyCommand
  if (!entry.upstreamUrl || entry.compat !== 'direct') return undefined
  if (entry.khyosMarket === 'skill') return `khy skill add ${entry.upstreamUrl}`
  if (entry.khyosMarket === 'extension') return `khy ext install ${entry.upstreamUrl}`
  return undefined
}

function compatTally(entries: EcoMarketEntry[]): { direct: number; adapt: number; covered: number; blocked: number } {
  const tally = { direct: 0, adapt: 0, covered: 0, blocked: 0 }
  for (const entry of entries) {
    if (entry.compat === 'direct') tally.direct += 1
    else if (entry.compat === 'adapter-needed') tally.adapt += 1
    else if (entry.compat === 'covered') tally.covered += 1
    else if (entry.compat === 'blocked') tally.blocked += 1
  }
  return tally
}

function entryKey(entry: EcoMarketEntry, eco?: string): string {
  if (entry.marketId) return entry.marketId
  const scope = eco || entry.agentScope?.[0] || ''
  return `${scope}:${entry.name || ''}`
}

function requirementsOf(entry: EcoMarketEntry): Array<{ group: 'env' | 'headers'; item: MarketRequirement }> {
  const requires = entry.installRequires || {}
  return [
    ...asList(requires.env).map((item) => ({ group: 'env' as const, item })),
    ...asList(requires.headers).map((item) => ({ group: 'headers' as const, item })),
  ].filter((row) => row.item && row.item.name)
}

// Only skill/MCP routes have a backend executor. Extension installs still need
// the terminal gate, and blocked/covered rows have nothing to install.
function installModeOf(entry: EcoMarketEntry): 'skill' | 'mcp' | null {
  const mode = entry.installSpec?.mode
  if (mode !== 'skill' && mode !== 'mcp') return null
  if (entry.compat === 'blocked' || entry.compat === 'covered') return null
  return mode
}

const MODE_LABEL: Record<string, string> = {
  skill: '技能',
  mcp: 'MCP 服务器',
}

// Fallback labels keep an older backend payload readable; the protocol sends
// categoryLabel alongside the key.
const CATEGORY_LABELS: Record<string, string> = {
  office: '办公效率',
  dev: '开发工具',
  data: '数据与分析',
  web: '搜索与浏览',
  design: '设计媒体',
  comm: '沟通协作',
  ops: '系统运维',
  security: '安全合规',
  ai: 'AI 与模型',
  other: '其他',
}

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS)

function categoryKeyOf(entry: EcoMarketEntry): string {
  return entry.category && CATEGORY_LABELS[entry.category] ? entry.category : 'other'
}

function categoryLabelOf(entry: EcoMarketEntry): string {
  return entry.categoryLabel || CATEGORY_LABELS[categoryKeyOf(entry)]
}

function Badges({ entry }: { entry: EcoMarketEntry }) {
  const compat = entry.compat ? COMPAT_BADGE[entry.compat] : undefined
  const adapter = entry.protocol?.adapter
  return (
    <>
      {compat && (
        <span className={`px-1.5 py-0.5 text-xs rounded ${compat.cls}`}>{compat.label}</span>
      )}
      {entry.compat && !compat && (
        <span className="px-1.5 py-0.5 text-xs rounded bg-foreground/5 text-foreground-muted">
          {entry.compat}
        </span>
      )}
      {entry.compat === 'covered' ? (
        <span className="px-1.5 py-0.5 text-xs rounded bg-foreground/5 text-foreground-muted">
          原生
        </span>
      ) : entry.khyosMarket && (
        <span className="px-1.5 py-0.5 text-xs rounded bg-foreground/5 text-foreground-muted">
          {ROUTE_BADGE[entry.khyosMarket] || entry.khyosMarket}
        </span>
      )}
      {entry.compat === 'adapter-needed' && adapter && (
        <span className="px-1.5 py-0.5 text-xs rounded bg-foreground/5 text-foreground-muted">
          适配 {adapter}
        </span>
      )}
      {entry.license && (
        <span
          title={entry.license}
          className="max-w-[16rem] truncate px-1.5 py-0.5 text-xs rounded bg-foreground/5 text-foreground-muted"
        >
          {entry.license}
        </span>
      )}
      {entry.category && (
        <span
          title={entry.categorySource === 'upstream' ? '按上游市场分类' : '按名称与描述归类'}
          className="px-1.5 py-0.5 text-xs rounded bg-sky-500/10 text-sky-400"
        >
          {categoryLabelOf(entry)}
        </span>
      )}
    </>
  )
}

function UpstreamLink({ url, label = '上游', onError }: {
  url?: string
  label?: string
  onError?: (message: string) => void
}) {
  if (!url) return null
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation()
        try {
          const res = await api().openExternal?.(url)
          if (res && !res.ok) {
            onError?.(res.error || '无法打开上游链接：请复制地址后手动访问')
          }
        } catch {
          onError?.('无法打开上游链接：请复制地址后手动访问')
        }
      }}
      className="inline-flex items-center gap-1 text-xs text-foreground/60 hover:text-foreground transition-colors"
      title={url}
    >
      {label}
      <Icon name="external-link" size={11} />
    </button>
  )
}

function CopyCommand({ command, onError }: { command: string; onError?: (message: string) => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation()
        try {
          await navigator.clipboard.writeText(command)
          setCopied(true)
        } catch {
          onError?.('复制命令失败：请手动选中命令复制')
        }
      }}
      className="px-2 py-0.5 rounded bg-foreground/5 hover:bg-foreground/10 text-foreground/70 hover:text-foreground transition-colors"
    >
      {copied ? '已复制' : '复制命令'}
    </button>
  )
}

function EntryRow({ entry, onOpen, onInstall, onUninstall, busy, onError }: {
  entry: EcoMarketEntry
  onOpen: () => void
  onInstall: (entry: EcoMarketEntry) => void
  onUninstall: (entry: EcoMarketEntry) => void
  busy?: boolean
  onError?: (message: string) => void
}) {
  const mode = installModeOf(entry)
  const needsInput = requirementsOf(entry).length > 0
  const upstream = upstreamLabel(entry.upstreamUrl)
  const meta = [
    entry.author ? `作者 ${entry.author}` : '',
    entry.version ? `v${entry.version}` : '',
    entry.downloads ? `下载 ${entry.downloads}` : '',
  ].filter(Boolean)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      className="border border-card-border rounded-lg px-3 py-2.5 cursor-pointer hover:border-card-border-focused transition-colors"
    >
      <div className="flex items-start gap-2.5">
        <Avatar url={entry.upstreamUrl} src={entry.avatarUrl} label={entry.name || '条目'} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-1.5 flex-wrap min-w-0">
              <span className="text-sm text-foreground truncate">{entry.name || '未命名条目'}</span>
              <Badges entry={entry} />
              {entry.installed && (
                <span className="px-1.5 py-0.5 text-xs rounded bg-emerald-500/10 text-emerald-400">已安装</span>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <UpstreamLink url={entry.upstreamUrl} onError={onError} />
              {mode && (entry.installed ? (
                <button
                  onClick={(event) => {
                    event.stopPropagation()
                    onUninstall(entry)
                  }}
                  disabled={busy}
                  className="px-2 py-0.5 rounded bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {busy ? '卸载中…' : '卸载'}
                </button>
              ) : (
                <button
                  onClick={(event) => {
                    event.stopPropagation()
                    if (needsInput) onOpen()
                    else onInstall(entry)
                  }}
                  disabled={busy}
                  className="px-2 py-0.5 rounded bg-foreground/10 hover:bg-foreground/15 text-foreground/80 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {busy ? '安装中…' : needsInput ? '填写并安装' : '安装'}
                </button>
              ))}
              <Icon name="chevron-right" size={12} />
            </div>
          </div>
          {meta.length > 0 && (
            <p className="text-[11px] text-foreground-muted mt-0.5 truncate">{meta.join(' · ')}</p>
          )}
          {upstream && (
            <p className="text-[11px] text-foreground-muted/70 font-mono mt-0.5 truncate">{upstream}</p>
          )}
          {entry.what && (
            <p className="text-xs text-foreground-muted mt-1 line-clamp-2">{entry.what}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function EntryDetailDialog({ entry, ecoTitle, onClose, onInstall, onUninstall, busy, onError }: {
  entry: EcoMarketEntry
  ecoTitle: string
  onClose: () => void
  onInstall: (
    entry: EcoMarketEntry,
    values: { env?: Record<string, string>; headers?: Record<string, string> }
  ) => Promise<MarketInstallResult>
  onUninstall: (entry: EcoMarketEntry) => Promise<MarketInstallResult | null>
  busy: boolean
  onError?: (message: string) => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const mode = installModeOf(entry)
  const requirements = requirementsOf(entry)
  const spec = entry.installSpec
  const missingRequired = requirements.filter(
    (row) => row.item.required && !values[`${row.group}:${row.item.name}`]?.trim()
  )
  const command = accessCommand(entry)
  const commandNeedsUnpack = !!command && command.includes('<')
  const upstream = upstreamLabel(entry.upstreamUrl)

  const submitInstall = async () => {
    const env: Record<string, string> = {}
    const headers: Record<string, string> = {}
    for (const row of requirements) {
      const value = values[`${row.group}:${row.item.name}`]?.trim()
      if (!value) continue
      if (row.group === 'env') env[row.item.name as string] = value
      else headers[row.item.name as string] = value
    }
    const res = await onInstall(entry, { env, headers })
    setResult({ ok: !!res.ok, text: res.ok ? res.message || '安装完成' : res.error || '安装失败：后端未返回原因' })
  }

  const submitUninstall = async () => {
    const res = await onUninstall(entry)
    if (!res) return
    setResult({ ok: !!res.ok, text: res.ok ? res.message || '已卸载' : res.error || '卸载失败：后端未返回原因' })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${entry.name || '条目'} 详情`}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-2xl max-h-[85vh] overflow-y-auto bg-card border border-card-border rounded-xl shadow-2xl"
      >
        <div className="flex items-start gap-3 border-b border-card-border px-5 py-4">
          <Avatar url={entry.upstreamUrl} src={entry.avatarUrl} label={entry.name || '条目'} size={44} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h2 className="text-base font-medium text-foreground">{entry.name || '未命名条目'}</h2>
              <Badges entry={entry} />
              {entry.installed && (
                <span className="px-1.5 py-0.5 text-xs rounded bg-emerald-500/10 text-emerald-400">已安装</span>
              )}
            </div>
            <p className="text-xs text-foreground-muted mt-1">
              {ecoTitle}
              {upstream ? ` · ${upstream}` : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭详情"
            className="p-1 rounded text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {(entry.what || entry.compatNote) && (
            <p className="text-sm text-foreground-muted whitespace-pre-wrap">{entry.what || entry.compatNote}</p>
          )}

          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-xs">
            {entry.author && (
              <div>
                <dt className="text-foreground/70">作者</dt>
                <dd className="text-foreground-muted">{entry.author}</dd>
              </div>
            )}
            {entry.version && (
              <div>
                <dt className="text-foreground/70">版本</dt>
                <dd className="text-foreground-muted">
                  v{entry.version}
                  {entry.downloads ? ` · 下载 ${entry.downloads}` : ''}
                </dd>
              </div>
            )}
            {entry.license && (
              <div>
                <dt className="text-foreground/70">许可证</dt>
                <dd className="text-foreground-muted">{entry.license}</dd>
              </div>
            )}
            {entry.category && (
              <div>
                <dt className="text-foreground/70">用途类型</dt>
                <dd className="text-foreground-muted">
                  {categoryLabelOf(entry)}
                  <span className="text-foreground-muted/60">
                    {entry.categorySource === 'upstream' ? ' · 上游分类' : ' · 按名称与描述归类'}
                  </span>
                </dd>
              </div>
            )}
            {(entry.updatedAt || entry.publishedAt) && (
              <div>
                <dt className="text-foreground/70">上游更新</dt>
                <dd className="text-foreground-muted">{entry.updatedAt || entry.publishedAt}</dd>
              </div>
            )}
            {entry.khyosMarket && (
              <div>
                <dt className="text-foreground/70">接入面</dt>
                <dd className="text-foreground-muted">{ROUTE_BADGE[entry.khyosMarket] || entry.khyosMarket}</dd>
              </div>
            )}
            {entry.agentScope?.length ? (
              <div>
                <dt className="text-foreground/70">适用生态</dt>
                <dd className="text-foreground-muted">{entry.agentScope.join('、')}</dd>
              </div>
            ) : null}
            {upstream && (
              <div className="sm:col-span-2">
                <dt className="text-foreground/70">上游仓库</dt>
                <dd className="text-foreground-muted break-all font-mono">{upstream}</dd>
              </div>
            )}
            {entry.targetPath && (
              <div className="sm:col-span-2">
                <dt className="text-foreground/70">落点</dt>
                <dd className="text-foreground-muted break-all font-mono">{entry.targetPath}</dd>
              </div>
            )}
          </dl>

          {entry.relationship && (
            <p className="text-xs text-foreground-muted">与上游关系：{entry.relationship}</p>
          )}

          <div className="rounded-lg border border-card-border px-3 py-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-foreground">安装</p>
              {entry.installed ? (
                <button
                  onClick={submitUninstall}
                  disabled={busy}
                  className="px-2.5 py-1 rounded bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {busy ? '卸载中…' : '卸载'}
                </button>
              ) : mode ? (
                <button
                  onClick={submitInstall}
                  disabled={busy || missingRequired.length > 0}
                  title={missingRequired.length > 0 ? `还需填写 ${missingRequired.map((row) => row.item.name).join('、')}` : undefined}
                  className="px-2.5 py-1 rounded bg-foreground/10 hover:bg-foreground/15 text-foreground/80 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {busy ? '安装中…' : `安装到${MODE_LABEL[mode]}`}
                </button>
              ) : null}
            </div>
            {entry.installed && (
              <p className="text-xs text-emerald-400">
                {entry.installedSummary || '已写入终端存储'}
                {entry.installedAt ? ` · ${entry.installedAt}` : ''}
              </p>
            )}
            {!entry.installed && mode === 'skill' && (
              <p className="text-xs text-foreground-muted">
                从 <span className="font-mono break-all">{spec?.source}</span> 克隆，导入到技能库
                {asList(spec?.skills).length
                  ? `（子目录 ${asList(spec?.skills).join('、')}）`
                  : '（仓库根目录）'}
                ；装完在「技能」页可见。
              </p>
            )}
            {!entry.installed && mode === 'mcp' && (
              <p className="text-xs text-foreground-muted">
                写入{spec?.scope === 'project' ? '项目级' : '用户级'} <span className="font-mono">mcp.json</span>，
                服务器名 <span className="font-mono">{spec?.name}</span>；装完在「MCP 服务器」页可见。
              </p>
            )}
            {!mode && (
              <p className="text-xs text-foreground-muted">
                {entry.compat === 'blocked'
                  ? '该条目被上游形态阻塞，暂不能自动安装；可复制下方命令手动处理。'
                  : entry.compat === 'covered'
                    ? '该能力平台已原生覆盖，无需安装。'
                    : entry.installSpec?.mode === 'extension'
                      ? '扩展类条目仍需在终端执行 khy ext install，桌面端只提供命令。'
                      : '该条目没有可执行的安装规格：请复制下方命令手动接入。'}
              </p>
            )}
            {!entry.installed && requirements.length > 0 && (
              <div className="space-y-2">
                {requirements.map((row) => {
                  const fieldKey = `${row.group}:${row.item.name}`
                  return (
                    <label key={fieldKey} className="block">
                      <span className="text-xs text-foreground/70">
                        {row.group === 'env' ? '环境变量' : '请求头'}{' '}
                        <span className="font-mono">{row.item.name}</span>
                        {row.item.required ? (
                          <span className="text-red-400"> *</span>
                        ) : (
                          <span className="text-foreground-muted">（可选）</span>
                        )}
                      </span>
                      <input
                        type={row.item.secret ? 'password' : 'text'}
                        value={values[fieldKey] || ''}
                        onChange={(event) =>
                          setValues((prev) => ({ ...prev, [fieldKey]: event.target.value }))
                        }
                        placeholder={
                          row.item.description ||
                          (row.item.secret ? '填写密钥，只随本次安装写入配置' : '填写值')
                        }
                        className="mt-1 w-full rounded-lg bg-foreground/5 border border-card-border px-2.5 py-1.5 text-xs text-foreground placeholder:text-foreground-muted/60 focus:outline-none focus:border-card-border-focused"
                      />
                    </label>
                  )
                })}
                {missingRequired.length > 0 && (
                  <p className="text-xs text-amber-500/90">
                    还需填写：{missingRequired.map((row) => row.item.name).join('、')}
                  </p>
                )}
              </div>
            )}
            {result && (
              <p className={`text-xs whitespace-pre-wrap ${result.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                {result.text}
              </p>
            )}
          </div>

          {entriesCommands(entry, command, commandNeedsUnpack, onError)}

          {entry.protocol?.id && (
            <div className="text-xs">
              <p className="text-foreground/70 mb-1">翻译协议</p>
              <p className="text-foreground-muted">
                {entry.protocol.id} · 类型 {KIND_LABEL[entry.protocol.kind || ''] || entry.protocol.kind}
                {' · '}路由{' '}
                {entry.compat === 'covered'
                  ? '原生（不导入）'
                  : ROUTE_BADGE[entry.protocol.market || ''] || entry.protocol.market}
                {' · '}适配 {entry.protocol.adapter || '原生'}
              </p>
              {entry.protocol.blocker?.note && (
                <p
                  className={
                    entry.compat === 'covered' ? 'text-emerald-400 mt-1' : 'text-amber-500/90 mt-1'
                  }
                >
                  {entry.compat === 'covered'
                    ? `原生覆盖（${entry.protocol.blocker.code}）：${entry.protocol.blocker.note}`
                    : entry.compat === 'blocked'
                      ? `阻塞（${entry.protocol.blocker.code}）：${entry.protocol.blocker.note}`
                      : `导入闸门（${entry.protocol.blocker.code}）：${entry.protocol.blocker.note}`}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function entriesCommands(
  entry: EcoMarketEntry,
  command: string | undefined,
  commandNeedsUnpack: boolean,
  onError?: (message: string) => void
) {
  if (!entry.command && !command) return null
  return (
    <div className="space-y-2 text-xs">
      {entry.command && (
        <div>
          <p className="text-foreground/70">上游安装命令</p>
          <code className="block break-all rounded bg-foreground/5 px-2 py-1 font-mono text-foreground-muted mt-1">
            {entry.command}
          </code>
          <span className="flex items-center gap-2 flex-wrap mt-1 text-foreground-muted">
            <CopyCommand command={entry.command} onError={onError} />
            <span>写入上游自己的目录；KhyOS 不读取该目录</span>
          </span>
        </div>
      )}
      {command && (
        <div>
          <p className="text-foreground/70">{entry.khyCommand ? 'KhyOS 侧接入命令' : '接入命令'}</p>
          <code className="block break-all rounded bg-foreground/5 px-2 py-1 font-mono text-foreground-muted mt-1">
            {command}
          </code>
          <span className="flex items-center gap-2 flex-wrap mt-1 text-foreground-muted">
            <CopyCommand command={command} onError={onError} />
            <span>
              {commandNeedsUnpack
                ? '先按上游说明取包解压，替换占位符为实际目录后在终端运行'
                : `在终端运行${
                    entry.khyosMarket === 'skill' && !command.includes('--skill ')
                      ? '；仓库含多个技能时追加 --skill <名称>'
                      : ''
                  }`}
            </span>
          </span>
        </div>
      )}
    </div>
  )
}

function BlockedRow({ entry, onError }: {
  entry: EcoMarketEntry
  onError?: (message: string) => void
}) {
  return (
    <div className="border border-card-border rounded-lg px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <Avatar url={entry.upstreamUrl} src={entry.avatarUrl} label={entry.name || '条目'} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <span className="text-sm text-foreground truncate">{entry.name || '未命名条目'}</span>
            <UpstreamLink url={entry.upstreamUrl} onError={onError} />
          </div>
          {entry.reason && (
            <p className="text-xs text-foreground-muted mt-1 whitespace-pre-wrap">{entry.reason}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function EcosystemCard({ market, index, query, category = 'all', onError, defaultOpen = false, onOpenEntry, onInstall, onUninstall, busyKey }: {
  market: EcoMarket
  index?: number
  query: string
  category?: string
  onError?: (message: string) => void
  defaultOpen?: boolean
  onOpenEntry: (entry: EcoMarketEntry) => void
  onInstall: (entry: EcoMarketEntry) => void
  onUninstall: (entry: EcoMarketEntry) => void
  busyKey: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [showBlocked, setShowBlocked] = useState(false)
  const [showSources, setShowSources] = useState(false)

  const entries = asList(market.entries)
  const blocked = asList(market.blocked)
  const marketplaces = asList(market.marketplaces)
  const avatarSource = marketplaces.find((source) => source.url)?.url || entries[0]?.upstreamUrl
  const tally = compatTally(entries)
  const q = query.trim().toLowerCase()
  const inCategory = (entry: EcoMarketEntry) => category === 'all' || categoryKeyOf(entry) === category
  const visibleEntries = entries.filter((e) => inCategory(e) && (!q || entryHaystack(e).includes(q)))
  // Blocked rows carry no category: they are upstream failures, not items the
  // category chips are describing, so a category filter hides them.
  const visibleBlocked = category !== 'all' ? [] : q ? blocked.filter((e) => entryHaystack(e).includes(q)) : blocked
  const matchCount = visibleEntries.length + visibleBlocked.length

  if ((q || category !== 'all') && matchCount === 0) return null

  const bodyOpen = open || !!q

  return (
    <div className="bg-card border border-card-border rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-surface-hover transition-colors"
      >
        <div className="flex items-center gap-2.5 flex-wrap min-w-0">
          <Avatar url={avatarSource} label={market.title || market.eco} size={26} />
          {typeof index === 'number' && (
            <span className="w-5 h-5 flex-shrink-0 flex items-center justify-center rounded bg-foreground/5 text-xs text-foreground-muted">
              {index}
            </span>
          )}
          <span className="text-sm font-medium text-foreground">
            {market.title || market.eco}
          </span>
          {market.live && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-sky-500/10 text-sky-400">实时</span>
          )}
          <span className="text-xs text-foreground-muted">
            {q
              ? `匹配 ${matchCount} 条 · 条目 ${entries.length} · 阻塞 ${blocked.length}`
              : `条目 ${entries.length} · 阻塞 ${blocked.length}${tally.covered > 0 ? ` · 已覆盖 ${tally.covered}` : ''} · 市场源 ${marketplaces.length}`}
          </span>
        </div>
        <Icon name={bodyOpen ? 'chevron-up' : 'chevron-down'} size={14} />
      </button>

      {bodyOpen && (
        <div className="px-4 pb-4 space-y-3">
          {market.surveyedAt && (
            <p className="text-xs text-foreground-muted">
              {market.live ? '实时检索于' : '勘察于'} {market.surveyedAt}
            </p>
          )}

          {entries.length > 0 && (
            <p className="text-xs text-foreground-muted">
              兼容分布：直连 {tally.direct} · 需适配 {tally.adapt} · 已覆盖 {tally.covered} · 阻塞 {tally.blocked}
            </p>
          )}

          {market.counts && Object.keys(market.counts).length > 0 && (
            <p className="text-xs text-foreground-muted">
              按类型：{' '}
              {Object.entries(market.counts)
                .map(([kind, count]) => `${KIND_LABEL[kind] || kind} ${count}`)
                .join(' · ')}
            </p>
          )}

          {marketplaces.length > 0 && (
            <div>
              <button
                onClick={() => setShowSources((v) => !v)}
                className="text-xs text-foreground/70 hover:text-foreground transition-colors"
              >
                {showSources ? '收起市场来源' : `查看市场来源（${marketplaces.length}）`}
              </button>
              {showSources && (
                <ul className="mt-2 space-y-2">
                  {marketplaces.map((source, i) => (
                    <li key={`${source.name || 'source'}:${i}`} className="border border-card-border rounded-lg px-3 py-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-foreground">{source.name || '未命名来源'}</span>
                        {source.kind && (
                          <span className="px-1.5 py-0.5 text-xs rounded bg-foreground/5 text-foreground-muted">
                            {source.kind}
                          </span>
                        )}
                        <UpstreamLink url={source.url} label="打开来源" onError={onError} />
                      </div>
                      {source.note && (
                        <p className="text-xs text-foreground-muted mt-1">{source.note}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {visibleEntries.length > 0 ? (
            <div className="space-y-2">
              {visibleEntries.map((entry, i) => {
                const key = `${entryKey(entry, market.eco)}:${i}`
                return (
                  <EntryRow
                    key={key}
                    entry={entry}
                    onOpen={() => onOpenEntry(entry)}
                    onInstall={onInstall}
                    onUninstall={onUninstall}
                    busy={busyKey === entryKey(entry, market.eco)}
                    onError={onError}
                  />
                )
              })}
            </div>
          ) : (
            <p className="text-xs text-foreground-muted">
              {q ? '该分组没有匹配搜索的条目' : '该生态暂无编目条目'}
            </p>
          )}

          {visibleBlocked.length > 0 && (
            <div>
              <button
                onClick={() => setShowBlocked((v) => !v)}
                className="text-xs text-red-400/80 hover:text-red-400 transition-colors"
              >
                {showBlocked ? '收起阻塞条目' : `查看阻塞条目（${visibleBlocked.length}）`}
              </button>
              {showBlocked && (
                <div className="mt-2 space-y-2">
                  {visibleBlocked.map((entry, i) => (
                    <BlockedRow
                      key={`${market.eco}:blocked:${entry.name || i}`}
                      entry={entry}
                      onError={onError}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {asList(market.uncertainties).length > 0 && (
            <details className="text-xs text-foreground-muted">
              <summary className="cursor-pointer text-foreground/70">
                残留风险（{asList(market.uncertainties).length}）
              </summary>
              <ul className="mt-2 space-y-1 pl-4 list-disc">
                {asList(market.uncertainties).map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

function PendingCard({ index, label, note }: { index?: number; label: string; note: string }) {
  return (
    <div className="bg-card border border-dashed border-card-border rounded-xl px-4 py-3">
      <div className="flex items-center gap-2 flex-wrap">
        {typeof index === 'number' && (
          <span className="w-5 h-5 flex-shrink-0 flex items-center justify-center rounded bg-foreground/5 text-xs text-foreground-muted">
            {index}
          </span>
        )}
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="px-1.5 py-0.5 text-xs rounded bg-foreground/5 text-foreground-muted">
          尚未编目
        </span>
      </div>
      <p className="text-xs text-foreground-muted mt-1.5">{note}</p>
    </div>
  )
}

function fmtStamp(value?: string): string {
  if (!value) return ''
  if (value.length <= 10) return value
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

const SOURCE_STATUS_LABEL: Record<string, string> = {
  ok: '实时',
  stale: '缓存',
  error: '失败',
  pending: '拉取中',
  off: '已关闭',
}

function sourceStatusClass(status?: string): string {
  if (status === 'ok') return 'text-emerald-400 bg-emerald-500/10'
  if (status === 'stale') return 'text-amber-400 bg-amber-500/10'
  if (status === 'error') return 'text-red-400 bg-red-500/10'
  return 'text-foreground-muted bg-foreground/5'
}

// The static catalog reports `ok` when it was read successfully — it was never
// live, so it must not wear the 实时 badge the live sources use.
function sourceStatusText(source: EcoMarketSourceStatus): string {
  if (source.kind === 'static') return source.status === 'error' ? '读取失败' : '已载入'
  return SOURCE_STATUS_LABEL[source.status || ''] || source.status || '未知'
}

export function PluginMarketplace({ search }: { search: string }) {
  const [payload, setPayload] = useState<EcoMarketPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [flash, setFlash] = useState('')
  const [tab, setTab] = useState('all')
  const [category, setCategory] = useState('all')
  const [detail, setDetail] = useState<{ eco: string; key: string } | null>(null)
  const [busyKey, setBusyKey] = useState('')
  const hasSnapshot = useRef(false)
  const inFlight = useRef(false)

  const load = useCallback(async (force = false) => {
    // The 60s poll and a manual refresh must not stack two full assemblies.
    if (inFlight.current) return
    inFlight.current = true
    // Polling must not flash the full-pane spinner over a populated table.
    if (!hasSnapshot.current) setLoading(true)
    setNotice('')
    try {
      const res = await api().pluginsEcoMarket?.(force)
      if (res?.ok && res.payload) {
        hasSnapshot.current = true
        setPayload(res.payload)
        setError('')
      } else {
        setError(res?.error || '生态市场编目读取失败：preload 未注入插件市场通道，请重启应用后重试')
      }
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }, [])

  const runInstall = useCallback(
    async (
      entry: EcoMarketEntry,
      values?: { env?: Record<string, string>; headers?: Record<string, string> }
    ): Promise<MarketInstallResult> => {
      const key = entryKey(entry)
      setBusyKey(key)
      setNotice('')
      setFlash('')
      const res = await api().pluginsMarketInstall?.(entry, values)
      setBusyKey('')
      if (!res) {
        const missing = { ok: false, error: '安装失败：preload 未注入市场安装通道，请重启应用后重试' }
        setNotice(missing.error)
        return missing
      }
      if (!res.ok) {
        setNotice(res.error || '安装失败：后端未返回原因')
        return res
      }
      setFlash(res.message || '安装完成，可在对应设置页查看')
      setNotice('')
      await load(false)
      return res
    },
    [load]
  )

  const runUninstall = useCallback(
    async (entry: EcoMarketEntry): Promise<MarketInstallResult | null> => {
      const label = entry.name || '该条目'
      const confirmed =
        typeof window === 'undefined' ||
        window.confirm(`确定卸载「${label}」？会删除它写入终端存储的技能目录或 MCP 配置。`)
      if (!confirmed) return null
      const key = entryKey(entry)
      setBusyKey(key)
      setNotice('')
      setFlash('')
      const res = await api().pluginsMarketUninstall?.(entry)
      setBusyKey('')
      if (!res) {
        const missing = { ok: false, error: '卸载失败：preload 未注入市场卸载通道，请重启应用后重试' }
        setNotice(missing.error)
        return missing
      }
      if (!res.ok) {
        setNotice(res.error || '卸载失败：后端未返回原因')
        return res
      }
      setFlash(res.message || '已卸载，对应页面会同步刷新')
      setNotice('')
      await load(false)
      return res
    },
    [load]
  )

  const openEntry = useCallback((market: EcoMarket, entry: EcoMarketEntry) => {
    setNotice('')
    setDetail({ eco: market.eco, key: entryKey(entry, market.eco) })
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  // Keep this pane in step with the terminal and the web page while it is
  // visible: all three read one backend snapshot, so an open pane must not keep
  // advertising yesterday's counts. 60s matches the web poll, and every live
  // source still serves its own TTL cache unless the user forces a refresh.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void load(false)
    }, 60000)
    return () => window.clearInterval(timer)
  }, [load])

  // A search is always cross-source: leaving a source tab selected would hide
  // matches that live in another ecosystem.
  useEffect(() => {
    if (search.trim()) setTab('all')
  }, [search])

  const ecosystems = asList(payload?.ecosystems)
  const degraded = payload?.degraded || ''
  const warnings = asList(payload?.warnings)
  const rules = asList(payload?.rules)
  const fetchedAt = payload?.fetchedAt || ''
  const refreshing = payload?.refreshing === true
  const refreshError = payload?.refreshError || ''
  const sources = asList(payload?.sources)
  const byEco = useMemo(
    () => new Map<string, EcoMarket>(ecosystems.map((m) => [m.eco, m])),
    [ecosystems]
  )
  const requestedEcos = useMemo(() => new Set(REQUESTED_GROUPS.map((g) => g.eco)), [])
  const others = useMemo(
    () => ecosystems.filter((m) => !requestedEcos.has(m.eco)),
    [ecosystems, requestedEcos]
  )
  const visibleOthers = search.trim() ? others.filter((m) => marketMatches(m, search)) : others

  const totals = useMemo<EcoMarketTotals>(() => {
    // The backend snapshot owns the counts; the local sum only covers a payload
    // that predates totals (or a degraded response with no ecosystems).
    if (payload?.totals) return payload.totals
    let entries = 0
    let blocked = 0
    let installed = 0
    let live = 0
    for (const m of ecosystems) {
      const rows = asList(m.entries)
      entries += rows.length
      blocked += asList(m.blocked).length
      installed += rows.filter((entry) => entry.installed).length
      if (m.live) live += 1
    }
    return { ecosystems: ecosystems.length, entries, blocked, installed, live }
  }, [payload, ecosystems])

  const sourceTabs = useMemo(() => {
    const query = search.trim().toLowerCase()
    // Blocked entries are a subset of `entries`, so counting both double-counts.
    const countOf = (market: EcoMarket) => {
      const entries = asList(market.entries)
      return query
        ? entries.filter((entry) => entryHaystack(entry).includes(query)).length
        : entries.length
    }
    return [
      {
        key: 'all',
        label: '全部',
        count: ecosystems.reduce((sum, market) => sum + countOf(market), 0),
      },
      ...REQUESTED_GROUPS.map((group) => {
        const market = byEco.get(group.eco)
        return {
          key: group.eco,
          label: group.label,
          count: market ? countOf(market) : undefined,
        }
      }),
      ...others.map((market) => ({
        key: market.eco,
        label: market.title || market.eco,
        count: countOf(market),
      })),
    ]
  }, [ecosystems, byEco, others, search])

  const q = search.trim()
  const activeMarket = tab === 'all' ? null : byEco.get(tab)
  const activePending = tab === 'all' ? null : REQUESTED_GROUPS.find((group) => group.eco === tab)
  const activeIndex = tab === 'all' ? -1 : REQUESTED_GROUPS.findIndex((group) => group.eco === tab)

  // Second-level split inside the selected source (or across all sources).
  // Counts follow the search box so a chip never advertises hidden rows.
  const categoryTabs = useMemo(() => {
    const query = search.trim().toLowerCase()
    const scope = tab === 'all' ? ecosystems : [byEco.get(tab)].filter((m): m is EcoMarket => Boolean(m))
    const counts = new Map<string, number>()
    for (const market of scope) {
      for (const entry of asList(market.entries)) {
        if (query && !entryHaystack(entry).includes(query)) continue
        const key = categoryKeyOf(entry)
        counts.set(key, (counts.get(key) || 0) + 1)
      }
    }
    const items = CATEGORY_ORDER.filter((key) => (counts.get(key) || 0) > 0).map((key) => ({
      key,
      label: CATEGORY_LABELS[key],
      count: counts.get(key) || 0,
    }))
    return { total: items.reduce((sum, item) => sum + item.count, 0), items }
  }, [tab, ecosystems, byEco, search])
  const categoryKeys = categoryTabs.items.map((item) => item.key).join(',')

  useEffect(() => {
    if (category !== 'all' && !categoryKeys.split(',').includes(category)) setCategory('all')
  }, [category, categoryKeys])

  const selectSource = useCallback((key: string) => {
    setTab(key)
    setCategory('all')
  }, [])


  // Resolve the open entry from the latest payload so an install/uninstall
  // reload updates the dialog's 已安装 state without closing it.
  const detailEntry = useMemo(() => {
    if (!detail) return null
    const market = byEco.get(detail.eco)
    if (!market) return null
    return (
      [...asList(market.entries), ...asList(market.blocked)].find(
        (entry) => entryKey(entry, market.eco) === detail.key
      ) || null
    )
  }, [detail, byEco])
  const detailMarket = detail ? byEco.get(detail.eco) : undefined

  return (
    <div className="space-y-4">
      <div className="bg-card border border-card-border rounded-xl p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground mb-1">
              多生态插件市场
            </p>
            <p className="text-xs text-foreground-muted">
              按来源分标签浏览，每个条目保留上游仓库与原介绍。静态编目来自勘察；阶跃水产市场、
              VS Code（Open VSX）扩展市场、Kimi Code 公开插件市场、官方 MCP Registry 为实时检索；
              所有条目都经 <span className="font-mono">khy-market/1</span> 翻译协议归一到技能 / MCP / 拓展三个安装面。
              技能与 MCP 可直接安装或卸载，写入终端同一存储（「技能」「MCP 服务器」页同步出现）；
              点条目看详情、填必填项、复制上游与 KhyOS 两侧命令；拓展类仍需终端{' '}
              <span className="font-mono">khy ext install</span>。
            </p>
            {payload && !degraded && (
              <p className="text-xs text-foreground-muted mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  className={`inline-flex items-center gap-1.5 ${
                    refreshing ? 'text-amber-400' : fetchedAt ? 'text-emerald-400' : 'text-foreground-muted'
                  }`}
                >
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full ${
                      refreshing ? 'bg-amber-400 animate-pulse' : fetchedAt ? 'bg-emerald-400' : 'bg-foreground-muted'
                    }`}
                  />
                  {refreshing ? '正在拉取实时来源' : fetchedAt ? '实时数据已同步' : '静态编目'}
                </span>
                <span>
                  共 {totals.ecosystems} 个生态 · 收录 {totals.entries} 条 · 阻塞 {totals.blocked} 条 · 已安装{' '}
                  {totals.installed}
                </span>
                {fetchedAt && <span>更新于 {fmtStamp(fetchedAt)}</span>}
                {payload.generatedAt && <span>静态编目生成于 {payload.generatedAt}</span>}
              </p>
            )}
            {sources.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                {sources.map((source) => (
                  <span
                    key={source.id}
                    title={source.message || source.title}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full ${sourceStatusClass(
                      source.status
                    )}`}
                  >
                    {source.title}
                    <span className="opacity-70">{sourceStatusText(source)}</span>
                    {typeof source.entries === 'number' && source.entries > 0 && (
                      <span className="opacity-70">{source.entries}</span>
                    )}
                  </span>
                ))}
              </div>
            )}
            {refreshError && (
              <p className="text-xs text-amber-400 mt-2">
                上次实时刷新失败：{refreshError}（当前展示 {fetchedAt ? fmtStamp(fetchedAt) : '静态编目'} 的快照）
              </p>
            )}
          </div>
          <button
            onClick={() => {
              void load(true)
            }}
            disabled={loading}
            className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          >
            {loading ? '拉取中：静态 + 4 个实时来源' : '刷新实时数据'}
          </button>
        </div>
        {notice && <p className="text-xs text-red-400 mt-2">{notice}</p>}
        {flash && <p className="text-xs text-emerald-400 mt-2">{flash}</p>}
      </div>

      {loading && !payload && (
        <div className="bg-card border border-card-border rounded-xl p-8 text-center text-sm text-foreground-muted">
          读取生态编目：解析 delivery/market 静态编目，并实时检索阶跃水产市场六类资产、VS Code 扩展、Kimi Code 插件与官方 MCP Registry…
        </div>
      )}

      {error && (
        <div className="bg-card border border-red-500/30 rounded-xl p-4">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {degraded && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
          <p className="text-sm font-medium text-amber-500 mb-1">生态编目读取降级</p>
          <p className="text-xs text-amber-500/90 whitespace-pre-wrap">{degraded}</p>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
          <p className="text-sm font-medium text-amber-500 mb-1">
            编目装配有 {warnings.length} 条告警
          </p>
          <ul className="text-xs text-amber-500/90 space-y-1 pl-4 list-disc">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {payload && !degraded && (
        <>
          <div
            role="tablist"
            aria-label="按来源筛选"
            className="flex items-center gap-1.5 overflow-x-auto pb-0.5"
          >
            {sourceTabs.map((item) => {
              const active = tab === item.key
              return (
                <button
                  key={item.key}
                  role="tab"
                  aria-selected={active}
                  onClick={() => selectSource(item.key)}
                  className={`flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full border transition-colors ${
                    active
                      ? 'bg-foreground/10 text-foreground border-card-border-focused'
                      : 'border-card-border text-foreground-muted hover:text-foreground hover:bg-surface-hover'
                  }`}
                >
                  <span className="max-w-[10rem] truncate" title={item.label}>
                    {item.label}
                  </span>
                  <span className={`text-[11px] ${active ? 'text-foreground/60' : 'text-foreground-muted/70'}`}>
                    {item.count === undefined ? '未编目' : item.count}
                  </span>
                </button>
              )
            })}
          </div>

          {categoryTabs.items.length > 1 && (
            <div role="tablist" aria-label="按用途类型筛选" className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
              <button
                role="tab"
                aria-selected={category === 'all'}
                onClick={() => setCategory('all')}
                className={`flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border transition-colors ${
                  category === 'all'
                    ? 'bg-sky-500/15 text-sky-300 border-sky-500/40'
                    : 'border-card-border text-foreground-muted hover:text-foreground hover:bg-surface-hover'
                }`}
              >
                全部类型
                <span className="text-[11px] opacity-70">{categoryTabs.total}</span>
              </button>
              {categoryTabs.items.map((item) => {
                const active = category === item.key
                return (
                  <button
                    key={item.key}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setCategory(active ? 'all' : item.key)}
                    className={`flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border transition-colors ${
                      active
                        ? 'bg-sky-500/15 text-sky-300 border-sky-500/40'
                        : 'border-card-border text-foreground-muted hover:text-foreground hover:bg-surface-hover'
                    }`}
                  >
                    {item.label}
                    <span className="text-[11px] opacity-70">{item.count}</span>
                  </button>
                )
              })}
            </div>
          )}

          {tab === 'all' ? (
            <>
              {REQUESTED_GROUPS.map((group, i) => {
                const market = byEco.get(group.eco)
                if (!market) {
                  return q ? null : (
                    <PendingCard key={group.eco} index={i + 1} label={group.label} note={group.pending} />
                  )
                }
                return (
                  <EcosystemCard
                    key={group.eco}
                    market={market}
                    index={i + 1}
                    query={search}
                    category={category}
                    onError={setNotice}
                    defaultOpen={i === 0}
                    onOpenEntry={(entry) => openEntry(market, entry)}
                    onInstall={runInstall}
                    onUninstall={runUninstall}
                    busyKey={busyKey}
                  />
                )
              })}

              {visibleOthers.length > 0 && (
                <div className="pt-2">
                  <p className="text-xs font-medium text-foreground-muted mb-2">其他已编目生态</p>
                  <div className="space-y-3">
                    {visibleOthers.map((market) => (
                      <EcosystemCard
                        key={market.eco}
                        market={market}
                        query={search}
                        category={category}
                        onError={setNotice}
                        onOpenEntry={(entry) => openEntry(market, entry)}
                        onInstall={runInstall}
                        onUninstall={runUninstall}
                        busyKey={busyKey}
                      />
                    ))}
                  </div>
                </div>
              )}

              {ecosystems.length === 0 && (
                <div className="bg-card border border-card-border rounded-xl p-8 text-center">
                  <p className="text-sm text-foreground-muted mb-1">生态编目为空</p>
                  <p className="text-xs text-foreground-muted">
                    后端返回了 0 个生态：请确认 delivery/market/index.json 存在，或点击「刷新编目」重试。
                  </p>
                </div>
              )}

              {q && ecosystems.length > 0 && (
                <p className="text-xs text-foreground-muted">
                  以上为匹配「{q}」的分组；清空搜索可查看尚未编目的分组。
                </p>
              )}
            </>
          ) : activeMarket && (!q || marketMatches(activeMarket, search)) ? (
            <EcosystemCard
              key={`${activeMarket.eco}:tab`}
              market={activeMarket}
              index={activeIndex >= 0 ? activeIndex + 1 : undefined}
              query={search}
              category={category}
              onError={setNotice}
              defaultOpen
              onOpenEntry={(entry) => openEntry(activeMarket, entry)}
              onInstall={runInstall}
              onUninstall={runUninstall}
              busyKey={busyKey}
            />
          ) : activeMarket ? (
            <div className="bg-card border border-card-border rounded-xl p-6 text-center text-sm text-foreground-muted">
              该来源没有匹配「{q}」的条目；切换到「全部」可查看其他来源的匹配结果。
            </div>
          ) : (
            <PendingCard
              label={activePending?.label || tab}
              note={activePending?.pending || '编目尚未收录该生态。'}
            />
          )}
        </>
      )}

      {rules.length > 0 && (
        <details className="bg-card border border-card-border rounded-xl p-4">
          <summary className="text-sm font-medium text-foreground cursor-pointer">
            导入路由闸门规则（{rules.length}）
          </summary>
          <ol className="mt-2 text-xs text-foreground-muted space-y-1.5 pl-5 list-decimal">
            {rules.map((rule, i) => (
              <li key={i}>{rule}</li>
            ))}
          </ol>
          {payload?.licenseGate && (
            <p className="text-xs text-foreground-muted mt-3">许可证闸：{payload.licenseGate}</p>
          )}
        </details>
      )}

      {detailEntry && detailMarket && (
        <EntryDetailDialog
          entry={detailEntry}
          ecoTitle={detailMarket.title || detailMarket.eco}
          onClose={() => setDetail(null)}
          onInstall={runInstall}
          onUninstall={runUninstall}
          busy={busyKey === entryKey(detailEntry, detailMarket.eco)}
          onError={setNotice}
        />
      )}
    </div>
  )
}
