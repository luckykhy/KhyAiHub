// EnvironmentsPage — 开发环境盘点/一键安装/清单导出导入（route #/environments，
// sidebar「开发环境」entry）。数据链：envLastScan/envCatalog/envScan/envInstall/
// envExport/envImport* → main IPC → host env.* → 后端 dependency 门面（单一真源，
// 桌面端不做第二套探测/安装机器）。进度事件经 onEnvProgress/onEnvJobDone 订阅
// （host env.progress / env.jobDone → main 广播）。
// 页面无本地持久化：盘点快照的真源在后端数据家（scan-latest.json），渲染层每次
// 进页重读，不缓存第二份。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type EnvKind = 'installable' | 'manual' | 'informational'

// kind 允许未知值透传（后端可能新增形态），消费处一律 String() 归一后分派。
interface CatalogEntry {
  depId: string
  language?: string
  label?: string
  kind?: EnvKind | string
  versionable?: boolean
  versions?: string[]
  docsUrl?: string
  note?: string
  installHint?: string
}

interface InventoryEntry extends CatalogEntry {
  present?: boolean
  version?: string | null
  versionDetail?: string | null
}

interface InventorySnapshot {
  scannedAt?: string
  platform?: string
  winget?: { present?: boolean; detail?: string }
  entries?: InventoryEntry[]
}

interface InstallResultShape {
  ok?: boolean
  alreadyPresent?: boolean
  label?: string
  version?: string | null
  command?: string
  verified?: boolean
  needsReopenHint?: boolean
  requiresElevation?: boolean
  installError?: string
  probe?: { present?: boolean; detail?: string }
}

interface ImportPlan {
  toInstall?: { depId?: string; version?: string | null; command?: string; note?: string }[]
  skipped?: { depId?: string; reason?: string }[]
  manual?: { depId?: string; installHint?: string }[]
  // 后端 previewImport 的 unknown 是纯 depId 字符串数组（manifestIo.js: unknown.push(depId)）
  unknown?: (string | { depId?: string })[]
}

interface ImportResult {
  succeeded?: number
  failed?: number
  skipped?: number
  summary?: string
}

interface KhyosEnvApi {
  envCatalog?: () => Promise<{ ok?: boolean; catalog?: { platform?: string; toolchains?: CatalogEntry[] }; error?: string }>
  envScan?: () => Promise<{ ok?: boolean; inventory?: InventorySnapshot; error?: string }>
  envInstall?: (depId: string, version?: string) => Promise<{ ok?: boolean; result?: InstallResultShape; code?: string; installHint?: string; error?: string }>
  envImportPreview?: (manifestJson: string) => Promise<{ ok?: boolean; plan?: ImportPlan; error?: string }>
  envImportApply?: (manifestJson: string) => Promise<{ ok?: boolean; result?: ImportResult; error?: string }>
  envExport?: () => Promise<{ ok?: boolean; canceled?: boolean; fileName?: string; path?: string; error?: string }>
  envLastScan?: () => Promise<{ ok?: boolean; missing?: boolean; snapshot?: InventorySnapshot; error?: string }>
  onEnvProgress?: (cb: (p: { jobId?: string; progress?: string; items?: unknown[] }) => void) => () => void
  onEnvJobDone?: (cb: (p: { jobId?: string; state?: string; result?: unknown; error?: string }) => void) => () => void
  openExternal?: (url: string) => Promise<{ ok?: boolean; error?: string }>
}

function api(): KhyosEnvApi {
  return (window as unknown as { __KHYOS__?: KhyosEnvApi }).__KHYOS__ || {}
}

// 版本下拉的「默认版本」哨兵：不选具体版本 = 不传 version，由后端按默认矩阵装。
const DEFAULT_VERSION = '__default__'

function kindOf(e: CatalogEntry): string {
  return String(e.kind || 'installable')
}

// 状态列：快照行按 present 分已装/缺失；目录行（未盘点）不猜状态。
function rowStatus(e: InventoryEntry, scanned: boolean): { label: string; cls: string } {
  const k = kindOf(e)
  if (k === 'informational') return { label: '信息 · 无需安装', cls: 'text-foreground-muted' }
  if (k === 'manual') return { label: '手动', cls: 'text-foreground' }
  if (!scanned) return { label: '未盘点', cls: 'text-foreground-muted' }
  if (e.present) return { label: '已装', cls: 'text-success' }
  return { label: '缺失', cls: 'text-destructive' }
}

// 安装方式列：winget 可用性来自快照的探测结果，不本地重探。
function methodLabel(e: InventoryEntry, wingetPresent: boolean | null): string {
  const k = kindOf(e)
  if (k === 'informational') return '—'
  if (k === 'manual') return '手动'
  if (wingetPresent === false) return '官方安装器（winget 缺失）'
  return 'winget'
}

function scanSummaryText(s: InventorySnapshot): string {
  let installed = 0
  let missing = 0
  let manual = 0
  let info = 0
  for (const e of s.entries || []) {
    const k = kindOf(e)
    if (k === 'informational') info++
    else if (k === 'manual') manual++
    else if (e.present) installed++
    else missing++
  }
  return `盘点完成：已装 ${installed} · 缺失 ${missing} · 手动 ${manual} · 信息 ${info}`
}

function formatScanTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function EnvironmentsPage() {
  const [rows, setRows] = useState<InventoryEntry[]>([])
  const [scanned, setScanned] = useState(false)
  const [scannedAt, setScannedAt] = useState('')
  const [platform, setPlatform] = useState('')
  const [wingetPresent, setWingetPresent] = useState<boolean | null>(null)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeError, setNoticeError] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [importingPlan, setImportingPlan] = useState(false)
  const [applyingImport, setApplyingImport] = useState(false)
  const [installingDep, setInstallingDep] = useState('')
  const [progressLine, setProgressLine] = useState('')
  const [versionSel, setVersionSel] = useState<Record<string, string>>({})
  const [confirmInstall, setConfirmInstall] = useState<InventoryEntry | null>(null)
  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null)
  const importManifestRef = useRef('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const flash = useCallback((msg: string, isError = false) => {
    setNotice(msg)
    setNoticeError(isError)
  }, [])

  const applySnapshot = useCallback((s: InventorySnapshot) => {
    setRows((s.entries || []).map((e) => ({ ...e })))
    setScanned(true)
    setScannedAt(typeof s.scannedAt === 'string' ? s.scannedAt : '')
    setPlatform(typeof s.platform === 'string' ? s.platform : '')
    setWingetPresent(s.winget && typeof s.winget.present === 'boolean' ? s.winget.present : null)
  }, [])

  // 进度/收尾订阅（挂载一次）：progressLine 只在任务进行中显示，jobDone 收敛。
  useEffect(() => {
    const a = api()
    if (!a.onEnvProgress || !a.onEnvJobDone) return
    const offP = a.onEnvProgress((p) => {
      if (p?.progress) setProgressLine(p.progress)
    })
    const offD = a.onEnvJobDone((p) => {
      if (p?.state === 'succeeded') setProgressLine('')
      else if (p?.state === 'failed') setProgressLine(p?.error ? `任务失败：${p.error}` : '')
    })
    return () => {
      offP()
      offD()
    }
  }, [])

  // 首屏：先读上次快照（不探测，秒回）；没有快照再拉静态目录，行标「未盘点」。
  // 绝不静默替用户跑一次扫描 —— 3-10s 的探测要显式触发。
  const load = useCallback(async () => {
    setLoadError('')
    const res = await api().envLastScan?.()
    if (res?.ok && res.snapshot) {
      applySnapshot(res.snapshot)
      return
    }
    const cat = await api().envCatalog?.()
    if (cat?.ok && cat.catalog) {
      setRows((cat.catalog.toolchains || []).map((t) => ({ ...t, depId: String(t.depId || '') })))
      setScanned(false)
      setScannedAt('')
      setPlatform(cat.catalog.platform || '')
      setWingetPresent(null)
    } else {
      // host 未启动等失败：main 已带修复动作文案（「请重启 KhyOS Desktop」），原样展示。
      setLoadError(cat?.error || res?.error || '读取开发环境数据失败：请重启应用后重试')
    }
  }, [applySnapshot])

  useEffect(() => {
    void load()
  }, [load])

  const runScan = useCallback(async () => {
    setScanning(true)
    setProgressLine('正在盘点开发环境…')
    try {
      const res = await api().envScan?.()
      if (res?.ok && res.inventory) {
        applySnapshot(res.inventory)
        flash(scanSummaryText(res.inventory))
      } else {
        flash(res?.error || '盘点失败：请重试', true)
      }
    } finally {
      setScanning(false)
    }
  }, [applySnapshot, flash])

  const doInstall = useCallback(
    async (entry: InventoryEntry) => {
      const depId = entry.depId
      setInstallingDep(depId)
      setProgressLine(`正在安装 ${entry.label || depId}…`)
      try {
        const picked = versionSel[depId]
        const version = picked && picked !== DEFAULT_VERSION ? picked : undefined
        const res = await api().envInstall?.(depId, version)
        const r = res?.result
        if (!res?.ok) {
          flash(res?.error || `${entry.label || depId} 安装失败：请查看导出日志排查 host 状态`, true)
        } else if (r?.alreadyPresent) {
          flash(`${entry.label || depId} 已就绪（${r.probe?.detail || '已检测到'}），无需安装`)
        } else if (r?.ok && r.verified) {
          flash(`${r.label || depId} 安装完成并已校验就绪${r.version ? `：${r.version}` : ''}。建议重新盘点刷新状态`)
        } else if (r?.needsReopenHint) {
          flash(`${r.label || depId} 安装命令已执行，但尚未探测到就绪：可能需重启 KhyOS Desktop 刷新 PATH 后重新盘点`, true)
        } else {
          flash(`${entry.label || depId} 安装未完成：${r?.installError || '请查看导出日志排查 host 状态'}`, true)
        }
      } finally {
        setInstallingDep('')
        setConfirmInstall(null)
      }
    },
    [flash, versionSel]
  )

  const copyText = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text)
        flash(`已复制 ${label} 安装命令，请在终端手动执行`)
      } catch {
        // 剪贴板 API 不可用（file:// 上下文可能受限）→ 退回 execCommand 路径
        try {
          const ta = document.createElement('textarea')
          ta.value = text
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          document.body.removeChild(ta)
          flash(`已复制 ${label} 安装命令，请在终端手动执行`)
        } catch {
          flash(`复制失败：请手动选中复制：${text}`, true)
        }
      }
    },
    [flash]
  )

  const doExport = useCallback(async () => {
    setExporting(true)
    try {
      const res = await api().envExport?.()
      if (res?.ok) flash(`已导出环境清单：${res.fileName || res.path || ''}`)
      else if (!res?.canceled) flash(res?.error || '导出失败：请先盘点后重试', true)
    } finally {
      setExporting(false)
    }
  }, [flash])

  const onImportFile = useCallback(
    async (file: File) => {
      let text = ''
      try {
        text = await file.text()
      } catch {
        flash(`读取清单文件失败：${file.name}，请确认文件仍存在`, true)
        return
      }
      importManifestRef.current = text
      setImportingPlan(true)
      try {
        const res = await api().envImportPreview?.(text)
        if (res?.ok && res.plan) {
          setImportPlan(res.plan)
        } else {
          flash(res?.error || '导入预览失败：请确认文件是 khy 导出的环境清单', true)
        }
      } finally {
        setImportingPlan(false)
      }
    },
    [flash]
  )

  const doImportApply = useCallback(async () => {
    const manifestJson = importManifestRef.current
    if (!manifestJson) return
    setApplyingImport(true)
    setProgressLine('正在按清单逐项安装…')
    try {
      const res = await api().envImportApply?.(manifestJson)
      if (res?.ok) {
        const r = res.result
        const parts: string[] = []
        if (typeof r?.succeeded === 'number') parts.push(`成功 ${r.succeeded}`)
        if (typeof r?.failed === 'number') parts.push(`失败 ${r.failed}`)
        if (typeof r?.skipped === 'number') parts.push(`跳过 ${r.skipped}`)
        flash(`导入完成：${parts.length > 0 ? parts.join(' · ') : '任务已结束'}。建议重新盘点刷新状态`)
        setImportPlan(null)
        importManifestRef.current = ''
      } else {
        flash(res?.error || '导入安装失败：请重试', true)
      }
    } finally {
      setApplyingImport(false)
    }
  }, [flash])

  const counts = useMemo(() => {
    let installed = 0
    let missing = 0
    let manual = 0
    let info = 0
    for (const r of rows) {
      const k = kindOf(r)
      if (k === 'informational') info++
      else if (k === 'manual') manual++
      else if (scanned && r.present) installed++
      else if (scanned) missing++
    }
    return { installed, missing, manual, info }
  }, [rows, scanned])

  const toInstallCount = (importPlan?.toInstall || []).length

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Top bar — same frame as AutomationsPage (返回工作区 back entry) */}
      <div className="flex items-center justify-between h-[60px] px-4 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">KhyOS</span>
        </div>
        <button
          onClick={() => {
            window.location.hash = ''
          }}
          className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
        >
          返回工作区
        </button>
      </div>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-8 pt-8 pb-16">
          {/* Page header */}
          <div className="flex items-start justify-between mb-2">
            <div>
              <h1 className="text-xl font-semibold text-foreground">开发环境</h1>
              <p className="text-sm text-foreground-muted mt-1">
                盘点已装工具链与版本、一键安装缺失项、清单导出/导入（换电脑一键恢复）。
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => {
                  void load()
                }}
                className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
              >
                刷新
              </button>
              <button
                onClick={() => {
                  void doExport()
                }}
                disabled={exporting}
                className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                导出清单
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={importingPlan || applyingImport}
                className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                导入清单
              </button>
              <button
                onClick={() => {
                  void runScan()
                }}
                disabled={scanning || installingDep !== '' || applyingImport}
                className="px-3 py-1.5 text-sm font-medium rounded-lg transition-colors bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {scanning ? '盘点中…' : '开始盘点'}
              </button>
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files && e.target.files[0]
              if (f) void onImportFile(f)
              e.target.value = ''
            }}
          />

          <div className="text-xs text-foreground-muted mb-4 flex items-center gap-3 flex-wrap">
            <span>{platform ? `平台 ${platform}` : ''}</span>
            {scanned && scannedAt && <span>盘点于 {formatScanTime(scannedAt)}</span>}
            {scanned && (
              <span>
                共 {rows.length} 项：已装 {counts.installed} · 缺失 {counts.missing} · 手动 {counts.manual} · 信息 {counts.info}
              </span>
            )}
            {!scanned && <span>尚未盘点：下表为可管理工具链目录，点「开始盘点」探测就绪状态与版本</span>}
          </div>

          {/* 首次加载失败（host 未启动等）：显式失败态 + main 带来的修复动作文案 */}
          {loadError && (
            <div className="mb-4 px-4 py-2.5 rounded-lg text-sm bg-destructive/10 text-destructive flex items-center justify-between gap-4">
              <span>{loadError}</span>
              <button
                onClick={() => {
                  void load()
                }}
                className="px-2.5 py-1 text-xs font-medium rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors flex-shrink-0"
              >
                重试
              </button>
            </div>
          )}

          {/* winget 缺失提示（来自快照探测结果，不本地重探） */}
          {scanned && wingetPresent === false && (
            <div className="mb-4 px-4 py-2.5 rounded-lg text-sm bg-foreground/10 text-foreground">
              本机未检测到 winget：可安装项将退回官方安装器或需手动安装。
            </div>
          )}

          {/* 操作反馈 */}
          {notice && (
            <div
              className={`mb-4 px-4 py-2.5 rounded-lg text-sm ${
                noticeError ? 'bg-destructive/10 text-destructive' : 'bg-success/10 text-success'
              }`}
            >
              {notice}
            </div>
          )}

          {/* 任务进度行（动作+目标+进度，来自 host env.progress 流事件） */}
          {progressLine && (
            <div className="mb-4 px-4 py-2.5 rounded-lg text-sm bg-brand/10 text-brand">{progressLine}</div>
          )}

          {/* 安装确认卡：显式确认 + UAC 提示，绝不静默提权 */}
          {confirmInstall && (
            <div className="bg-card border border-card-border rounded-xl p-5 mb-4">
              <h2 className="text-sm font-medium text-foreground mb-1">
                安装 {confirmInstall.label || confirmInstall.depId}
                {versionSel[confirmInstall.depId] && versionSel[confirmInstall.depId] !== DEFAULT_VERSION
                  ? `（版本 ${versionSel[confirmInstall.depId]}）`
                  : ''}
              </h2>
              <p className="text-xs text-foreground-muted mb-3">
                安装命令来自 khy 的内置 curated 安装表（本机 winget）。系统级安装需要管理员权限时会弹出
                UAC 确认窗 —— khy 不会静默提权。安装完成后若探测不到就绪，多为 PATH 未刷新：
                重启 KhyOS Desktop 后重新盘点即可。
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    void doInstall(confirmInstall)
                  }}
                  disabled={installingDep !== ''}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {installingDep === confirmInstall.depId ? '安装中…' : '确认安装'}
                </button>
                <button
                  onClick={() => setConfirmInstall(null)}
                  className="px-4 py-2 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* 导入预览（四段：将安装 / 跳过 / 手动 / 拒绝），确认后才 apply */}
          {importPlan && (
            <div className="bg-card border border-card-border rounded-xl p-5 mb-4">
              <h2 className="text-sm font-medium text-foreground mb-3">导入预览</h2>
              <div className="space-y-3 text-xs">
                <div>
                  <div className="font-medium text-foreground mb-1">将安装 {(importPlan.toInstall || []).length} 项</div>
                  {(importPlan.toInstall || []).length === 0 ? (
                    <p className="text-foreground-muted">无待安装项。</p>
                  ) : (
                    <ul className="space-y-1">
                      {(importPlan.toInstall || []).map((it, i) => (
                        <li key={i} className="text-foreground-muted">
                          {it.depId}
                          {it.version ? ` @${it.version}` : ''}
                          {it.command ? ` — ${it.command}` : ''}
                          {it.note ? `（${it.note}）` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {(importPlan.skipped || []).length > 0 && (
                  <div>
                    <div className="font-medium text-foreground mb-1">跳过 {(importPlan.skipped || []).length} 项</div>
                    <ul className="space-y-1">
                      {(importPlan.skipped || []).map((it, i) => (
                        <li key={i} className="text-foreground-muted">
                          {it.depId || '未知'}{it.reason ? ` — ${it.reason}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {(importPlan.manual || []).length > 0 && (
                  <div>
                    <div className="font-medium text-foreground mb-1">手动 {(importPlan.manual || []).length} 项（khy 拒绝代跑，请手动执行）</div>
                    <ul className="space-y-1">
                      {(importPlan.manual || []).map((it, i) => (
                        <li key={i} className="text-foreground-muted break-all">
                          {it.depId || '未知'}
                          {it.installHint ? ` — ${it.installHint}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {(importPlan.unknown || []).length > 0 && (
                  <div>
                    <div className="font-medium text-destructive mb-1">拒绝 {(importPlan.unknown || []).length} 项（depId 未登记）</div>
                    <ul className="space-y-1">
                      {(importPlan.unknown || []).map((it, i) => (
                        <li key={i} className="text-destructive/80">{typeof it === 'string' ? it : it?.depId || '未知'}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3 pt-3">
                <button
                  onClick={() => {
                    void doImportApply()
                  }}
                  disabled={toInstallCount === 0 || applyingImport}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                  title={toInstallCount === 0 ? '没有待安装项' : undefined}
                >
                  {applyingImport ? '安装中…' : `安装 ${toInstallCount} 项`}
                </button>
                <button
                  onClick={() => {
                    setImportPlan(null)
                    importManifestRef.current = ''
                  }}
                  className="px-4 py-2 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* 盘点表 / 空态 */}
          {rows.length === 0 && !loadError ? (
            <div className="bg-card border border-card-border rounded-xl p-12 text-center">
              <span className="text-3xl mb-3 block">⌗</span>
              <p className="text-sm font-medium text-foreground/70 mb-1">还没有可展示的工具链</p>
              <p className="text-xs text-foreground-muted mb-5">
                后端目录为空或读取失败：请确认 KhyOS 后端已部署，然后点「开始盘点」。
              </p>
              <button
                onClick={() => {
                  void runScan()
                }}
                disabled={scanning}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-brand/30 text-brand hover:bg-brand/10 transition-colors disabled:opacity-40"
              >
                {scanning ? '盘点中…' : '开始盘点'}
              </button>
            </div>
          ) : (
            <div className="bg-card border border-card-border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-foreground-muted border-b border-card-border">
                    <th className="px-4 py-2.5 font-medium">语言</th>
                    <th className="px-4 py-2.5 font-medium">depId</th>
                    <th className="px-4 py-2.5 font-medium">状态</th>
                    <th className="px-4 py-2.5 font-medium">版本</th>
                    <th className="px-4 py-2.5 font-medium">安装方式</th>
                    <th className="px-4 py-2.5 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => {
                    const st = rowStatus(e, scanned)
                    const k = kindOf(e)
                    const installing = installingDep === e.depId
                    const versionOptions = Array.isArray(e.versions) ? e.versions : []
                    return (
                      <tr key={e.depId} className="border-b border-card-border last:border-b-0">
                        <td className="px-4 py-2.5 text-foreground">{e.label || e.language || e.depId}</td>
                        <td className="px-4 py-2.5 text-foreground-muted font-mono text-xs">{e.depId}</td>
                        <td className={`px-4 py-2.5 ${st.cls}`}>{st.label}</td>
                        <td className="px-4 py-2.5 text-foreground-muted">
                          {k === 'informational' ? '—' : e.version || (scanned && !e.present ? '—' : '')}
                        </td>
                        <td className="px-4 py-2.5 text-foreground-muted">
                          {methodLabel(e, wingetPresent)}
                          {k === 'manual' && e.installHint && (
                            <div className="text-xs text-foreground-subtle break-all mt-0.5">{e.installHint}</div>
                          )}
                          {e.note && <div className="text-xs text-foreground-subtle mt-0.5">{e.note}</div>}
                        </td>
                        <td className="px-4 py-2.5 text-right whitespace-nowrap">
                          {k === 'installable' && (
                            <span className="inline-flex items-center gap-1.5">
                              {versionOptions.length > 0 && (
                                <select
                                  value={versionSel[e.depId] || DEFAULT_VERSION}
                                  onChange={(ev) => setVersionSel((m) => ({ ...m, [e.depId]: ev.target.value }))}
                                  title="安装版本"
                                  aria-label={`选择 ${e.label || e.depId} 的安装版本`}
                                  className="khy-select text-xs bg-input border border-input-border rounded-md px-1.5 py-1 text-foreground-muted focus:outline-none focus:border-input-border-focused"
                                >
                                  <option value={DEFAULT_VERSION}>默认版本</option>
                                  {versionOptions.map((v) => (
                                    <option key={v} value={v}>{v}</option>
                                  ))}
                                </select>
                              )}
                              <button
                                onClick={() => setConfirmInstall(e)}
                                disabled={installing || applyingImport}
                                className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-brand/30 text-brand hover:bg-brand/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                {installing ? '安装中…' : '安装'}
                              </button>
                            </span>
                          )}
                          {k === 'manual' && e.installHint && (
                            <button
                              onClick={() => {
                                void copyText(e.installHint || '', e.label || e.depId)
                              }}
                              className="px-2.5 py-1.5 text-xs text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
                              title={e.installHint}
                            >
                              复制命令
                            </button>
                          )}
                          {e.docsUrl && (
                            <button
                              onClick={() => {
                                void api().openExternal?.(e.docsUrl || '')
                              }}
                              className="ml-1.5 px-2.5 py-1.5 text-xs text-foreground/50 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
                            >
                              文档
                            </button>
                          )}
                          {k === 'informational' && !e.docsUrl && <span className="text-foreground-subtle text-xs">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-foreground-muted mt-4">
            终端同源命令：<span className="font-mono">khy devenv scan / install / export / import</span>
            。任务记录不持久化：重启应用后进行中的任务状态即失，重新盘点即可获得最新状态。
          </p>
        </div>
      </main>
    </div>
  )
}
