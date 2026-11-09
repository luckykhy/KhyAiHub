// khy-canary: Khy-20261102-316-6JAGRA29
import { useState, useEffect, useCallback } from 'react'

// ── 使用统计 settings page（ZC-ALIGN-002 I8, a11y s-7）──
// 数据真源：后端 tokenUsageService 的 getUsageHistory（持久化日桶，8 键）/
// getModelUsage（本进程 records）/ getCostCoverage/getUsageFileStamp，
// 经 preload getUsageHistory → main usage:history → host usage.history（CH-2）。
// ZC-ALIGN-001 P13 之前这里是 Math.random 假数据。
//
// 页面刻意不做的事（口径未定就不画，见 shared/usageChartMath.ts 头注）：
// 不画缓存堆叠段、不出缓存命中率百分比、不画成本堆叠/折线、不做按模型环形饼图。

import { csvFromDays, type UsageDay } from '../../shared/usageChartMath'
import { formatCompactNumber } from '../../shared/compactNumber'
import { CoverageBar, StackedDailyBars, ThresholdBar, type CoverageData } from './usageCharts'

interface ModelUsageRow {
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  requests: number
  costUSD: number
  percentage: number
  scope?: string
}

interface UsageHistoryResponse {
  ok: boolean
  history?: UsageDay[] | null
  models?: ModelUsageRow[] | null
  coverage?: CoverageData | null
  stamp?: string | null
  error?: string
}

interface UsageBucket {
  totalTokens: number
  requests: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

interface KhyOsApi {
  getUsageHistory?: (days?: number) => Promise<UsageHistoryResponse>
  getTokenUsage?: () => Promise<{ ok: boolean; usage?: { month?: UsageBucket; today?: UsageBucket } | null; error?: string }>
  getSettings?: () => Promise<Record<string, unknown>>
  setSetting?: (key: string, value: unknown) => Promise<unknown>
  exportUsageCsv?: (csv: string) => Promise<{ ok: boolean; fileName?: string; path?: string; error?: string }>
}

function khyApi(): KhyOsApi | undefined {
  return (window as unknown as { __KHYOS__?: KhyOsApi }).__KHYOS__
}

function fmtDayLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  return `${Number(m[2])}月${Number(m[3])}日`
}

const RANGES = [
  { key: '7d', label: '近 7 日', days: 7 },
  { key: '30d', label: '近 30 日', days: 30 },
  { key: '90d', label: '近 90 日', days: 90 },
] as const

type RangeKey = (typeof RANGES)[number]['key']

// 图表分类色走 globals.css 的 --color-chart-1..5（深浅各一套）：此前这里是
// 十六进制字面量，浅色主题下不换色。
const MODEL_ROW_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
]

export function UsageSettings() {
  const [range, setRange] = useState<RangeKey>('30d')
  const [history, setHistory] = useState<UsageDay[] | null>(null)
  const [models, setModels] = useState<ModelUsageRow[] | null>(null)
  const [coverage, setCoverage] = useState<CoverageData | null>(null)
  const [stamp, setStamp] = useState<string | null>(null)
  const [month, setMonth] = useState<UsageBucket | null>(null)
  const [today, setToday] = useState<UsageBucket | null>(null)
  const [limit, setLimit] = useState<number>(0)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [usageError, setUsageError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)

  const rangeDays = RANGES.find((r) => r.key === range)?.days ?? 30

  const loadHistory = useCallback((days: number) => {
    const api = khyApi()
    if (!api?.getUsageHistory) {
      setUsageError('用量数据不可用：preload 未注入 __KHYOS__，请重启应用')
      setLoading(false)
      return
    }
    setLoading(true)
    api.getUsageHistory(days).then((res) => {
      // 规则 2.1：失败时区分「history 没拿到」与「models/coverage 没拿到」——
      // 后者不影响出数，不该让整页落空态。
      if (res?.ok && res.history) {
        setHistory(res.history)
        setModels(res.models || [])
        setCoverage(res.coverage || null)
        setStamp(res.stamp || null)
        setUsageError('')
      } else {
        setUsageError(res?.error || '用量历史读取失败：后端未返回数据，请重启应用后重试')
      }
      setLoading(false)
    }).catch(() => {
      setUsageError('用量历史读取失败：host 进程无响应，请重启应用')
      setLoading(false)
    })
  }, [])

  // 本月 / 今日桶走 token:usage（另一条 IPC），供阈值条与四数原始数字行。
  const loadBuckets = useCallback(() => {
    const api = khyApi()
    api?.getTokenUsage?.().then((res) => {
      if (res?.ok && res.usage) {
        setMonth(res.usage.month || null)
        setToday(res.usage.today || null)
      }
    }).catch(() => { /* 阈值条与原始数字行降级不显示，不阻断主区 */ })
    // 上限读侧只有 getSettings() 全量返回，必须显式取该键；0 或缺省 = 不显示。
    api?.getSettings?.().then((s) => {
      const v = Number(s?.usageMonthlyTokenLimit)
      setLimit(Number.isFinite(v) && v > 0 ? v : 0)
    }).catch(() => { /* 无上限设置：不画条 */ })
  }, [])

  // Load on mount and whenever the range tab changes (real refetch, not a
  // local slice — host clamps days to the 90-day persistence horizon).
  useEffect(() => { loadHistory(rangeDays) }, [rangeDays, loadHistory])
  useEffect(() => { loadBuckets() }, [loadBuckets])

  const days = history || []
  const totalTokens = days.reduce((sum, d) => sum + (d.totalTokens || 0), 0)
  const totalRequests = days.reduce((sum, d) => sum + (d.requests || 0), 0)
  const totalCost = days.reduce((sum, d) => sum + (d.costUSD || 0), 0)
  const recordedDays = days.filter((d) => (d.requests || 0) > 0).length
  const firstDay = days[0]?.date
  const selectedDay = selectedDate ? days.find((d) => d.date === selectedDate) || null : null

  const exportCsv = () => {
    const api = khyApi()
    if (!api?.exportUsageCsv) {
      setNotice('导出失败：preload 未注入 exportUsageCsv，请重启应用')
      return
    }
    // 只传 CSV 串，文件名与落盘目录由 main 自拼。
    const csv = csvFromDays(days, { stamp, rangeDays })
    api.exportUsageCsv(csv).then((r) => {
      setNotice(r?.ok ? `已导出：${r.fileName}（${r.path}）` : `导出失败：${r?.error || '未知错误'}`)
    }).catch(() => { setNotice('导出失败：主进程无响应，请重启应用') })
  }

  return (
    <div className="max-w-4xl">
      {/* ── Date range tabs + refresh ── */}
      <div className="flex items-center gap-1 mb-2">
        {RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => setRange(r.key)}
            className={`px-4 py-1.5 text-sm rounded-lg transition-colors ${
              range === r.key
                ? 'bg-selected text-foreground font-medium'
                : 'text-foreground-muted hover:text-foreground hover:bg-surface-hover'
            }`}
          >
            {r.label}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={() => { loadHistory(rangeDays); loadBuckets() }}
          className="px-3 py-1.5 text-sm text-foreground-muted hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors flex items-center gap-1.5"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 6a4 4 0 1 1 8 0a4 4 0 0 1-8 0z" stroke="currentColor" strokeWidth="0.8" />
            <path d="M6 4v2l1.5 1.5" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
          </svg>
          刷新
        </button>
      </div>
      {/* 切档只是换窗口，不是重新取数（host 只夹 days）——不加这句会被读成「切档 = 更新数据」。 */}
      <div className="text-xs text-foreground-muted mb-6">切换仅改变统计窗口，数据以页脚时间戳为准</div>

      {usageError && (
        <div className="mb-4 px-4 py-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl">
          {usageError}
        </div>
      )}
      {notice && (
        <div className="mb-4 px-4 py-3 text-sm text-foreground/70 bg-surface border border-card-border rounded-xl">
          {notice}
        </div>
      )}

      {/* ── Summary card ── */}
      <div className="bg-card border border-card-border rounded-xl p-6 mb-6">
        <div className="text-sm text-foreground-muted mb-1">总用量（{RANGES.find((r) => r.key === range)?.label}）</div>
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold text-foreground tabular-nums">
            {loading && !history ? '—' : formatCompactNumber(totalTokens)}
          </span>
          <span className="text-sm text-foreground-muted">tokens</span>
        </div>
        {/* costUSD 主路径恒 0，画金额就是画一条假零线。有值时才给数，并说清它从哪来。 */}
        <div className="text-xs text-foreground-muted mt-2">
          {totalRequests} 次请求 · {recordedDays}/{days.length} 天有记录 ·{' '}
          {totalCost > 0
            ? `$${totalCost.toFixed(3)}（仅 ccSwitch 扫描当天写入）`
            : '成本估计：未接入计价'}
        </div>
      </div>

      {/* ── Daily stacked bars（两段：输入 / 输出）── */}
      <div className="bg-card border border-card-border rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-foreground">每日用量</h3>
          <button
            onClick={exportCsv}
            disabled={days.length === 0}
            className="px-3 py-1.5 text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
          >
            导出 CSV
          </button>
        </div>
        {days.length === 0 ? (
          <div className="h-32 flex items-center justify-center text-sm text-foreground-muted">
            {/* 规则 2.6：动作 + 目标 + 进度 */}
            {loading
              ? `读取用量历史（近 ${rangeDays} 日，0/${rangeDays} 天）…`
              : '该窗口内无任何请求记录'}
          </div>
        ) : (
          <StackedDailyBars
            days={days}
            stamp={stamp}
            onSelectDay={(d) => setSelectedDate((cur) => (cur === d ? null : d))}
            selectedDate={selectedDate}
          />
        )}
        {days.length > 0 && (
          <div className="text-xs text-foreground-muted mt-3">
            {firstDay ? `${fmtDayLabel(firstDay)} 起` : ''} · 点击柱子下钻当日明细
          </div>
        )}

        {/* 单日下钻：就地展开，字段逐个改名以免与图冲突 */}
        {selectedDay && (
          <div className="mt-4 border-t border-card-border pt-3 text-sm">
            <div className="flex items-center justify-between mb-1">
              <span className="font-medium text-foreground">{fmtDayLabel(selectedDay.date)} 明细</span>
              <button onClick={() => setSelectedDate(null)} className="text-xs text-foreground-muted hover:text-foreground">
                收起
              </button>
            </div>
            <p className="text-xs text-foreground-muted mb-2">
              本桶含本应用请求与 ccSwitch 扫描导入的外部会话，两者不可按桶拆分。
            </p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-foreground/70">
              <div className="flex justify-between"><dt>输入 inputTokens</dt><dd className="tabular-nums">{formatCompactNumber(selectedDay.inputTokens)}</dd></div>
              <div className="flex justify-between"><dt>输出 outputTokens</dt><dd className="tabular-nums">{formatCompactNumber(selectedDay.outputTokens)}</dd></div>
              <div className="flex justify-between"><dt>合计（输入 + 输出，不含缓存）</dt><dd className="tabular-nums">{formatCompactNumber(selectedDay.totalTokens)}</dd></div>
              <div className="flex justify-between"><dt>请求数 requests</dt><dd className="tabular-nums">{formatCompactNumber(selectedDay.requests)}</dd></div>
              <div className="flex justify-between">
                <dt>成本估计 costUSD</dt>
                <dd className="tabular-nums">
                  {selectedDay.costUSD > 0
                    ? `$${selectedDay.costUSD.toFixed(3)}（仅 ccSwitch 扫描路径写入；0 表示未接入计价，不是免费）`
                    : '$0.000（未接入计价，不是免费）'}
                </dd>
              </div>
            </dl>
          </div>
        )}

        {/* 今日四数原始数字行。缓存两数只列原始值 + 口径未审计标注，
            不出命中率百分比 —— 百分比的分母依赖同一个未定口径。 */}
        {today && (
          <div className="mt-4 border-t border-card-border pt-3">
            <div className="text-xs text-foreground mb-2">今日四桶原始数字</div>
            <div className="grid grid-cols-4 gap-3 text-sm">
              <div><div className="text-foreground-muted text-xs">输入</div><div className="tabular-nums text-foreground">{formatCompactNumber(today.inputTokens || 0)}</div></div>
              <div><div className="text-foreground-muted text-xs">输出</div><div className="tabular-nums text-foreground">{formatCompactNumber(today.outputTokens || 0)}</div></div>
              <div>
                <div className="text-foreground-muted text-xs">缓存读</div>
                <div className="tabular-nums text-foreground">{formatCompactNumber(today.cacheReadTokens || 0)}</div>
              </div>
              <div>
                <div className="text-foreground-muted text-xs">缓存写</div>
                <div className="tabular-nums text-foreground">{formatCompactNumber(today.cacheWriteTokens || 0)}</div>
              </div>
            </div>
            <p className="text-xs text-foreground-muted mt-2">
              缓存读 / 缓存写：口径未审计，未计入上图 —— 两条通道的缓存列是否与 input 互斥尚未验证，
              故不画堆叠段也不出命中率。
            </p>
          </div>
        )}
      </div>

      {/* ── Coverage + threshold ── */}
      <div className="bg-card border border-card-border rounded-xl p-5 mb-6">
        <h3 className="text-sm font-semibold text-foreground mb-4">计价覆盖率</h3>
        <CoverageBar data={coverage} rangeDays={rangeDays} />
        {limit > 0 && month && (
          <div className="mt-6 pt-4 border-t border-card-border">
            <ThresholdBar used={month.totalTokens || 0} limit={limit} />
          </div>
        )}
      </div>

      {/* ── Model usage breakdown ── */}
      <div className="bg-card border border-card-border rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-card-border flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">模型用量</h3>
          <span className="text-xs text-foreground-muted">仅本次进程，退出即失</span>
        </div>
        <div className="divide-y divide-card-border">
          {!loading && models && models.length === 0 && (
            <div className="px-5 py-8 text-center">
              <p className="text-sm text-foreground-muted mb-2">本次进程暂无模型用量记录</p>
              <p className="text-xs text-foreground-muted">
                发起 AI 对话后按模型归组的累计用量会在此展示；它不落盘，重启后归零。
              </p>
            </div>
          )}
          {(models || []).map((row, i) => (
            <div key={row.model} className="px-5 py-4 hover:bg-surface-hover transition-colors">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: MODEL_ROW_COLORS[i % MODEL_ROW_COLORS.length] }}
                  />
                  <span className="text-sm font-mono text-foreground">{row.model}</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-sm text-foreground-muted">{formatCompactNumber(row.totalTokens)} tokens</span>
                  <span className="text-sm font-medium text-foreground tabular-nums w-12 text-right">{row.percentage}%</span>
                </div>
              </div>
              <div className="h-1.5 bg-surface rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, row.percentage)}%`,
                    backgroundColor: MODEL_ROW_COLORS[i % MODEL_ROW_COLORS.length],
                  }}
                />
              </div>
            </div>
          ))}
          {loading && !models && (
            <div className="px-5 py-8 text-center text-sm text-foreground-muted">
              读取用量历史（近 {rangeDays} 日，0/{rangeDays} 天）…
            </div>
          )}
        </div>
      </div>

      {/* ── Footer ── 两行解耦：stamp 为 null 时整行不渲染（不写「数据截至 undefined」）── */}
      <div className="mt-4 text-xs text-foreground-muted space-y-1">
        {stamp && <div>数据截至 {stamp}</div>}
        <div>{RANGES.find((r) => r.key === range)?.label}为滚动窗口（90 天日桶 / 6 个月桶），非全量历史</div>
      </div>
    </div>
  )
}