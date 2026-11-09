// khy-canary: Khy-20261102-318-N9YVCZGC
// 使用统计页的图表——手写 SVG / div，零第三方图表库（package.json 现有依赖里
// 图表类命中 0，维持 0）。
//
// 几何一律委托 shared/usageChartMath.ts，本文件不重复实现纯函数：纯函数写在
// .tsx 里就只能靠构建才能测。

import { useState } from 'react'
import {
  isEmptyDay,
  niceCeilLinear,
  stackSegments,
  type UsageDay,
} from '../../shared/usageChartMath'
import { formatCompactNumber } from '../../shared/compactNumber'

const PLOT_H = 132
const PLOT_W = 720
const PAD_L = 8
const PAD_R = 8
const PLOT_T = 8

const COLOR_INPUT = 'var(--color-trajectory-user)'
const COLOR_OUTPUT = 'var(--color-trajectory-assistant)'
// 第三色只用于 Missing 态，与两段真实数据**必须**不同：同色会把「那天没记」
// 读成「那天没量」。
const COLOR_MISSING = 'var(--color-diff-removed)'

function fmtDayLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  return `${Number(m[2])}/${Number(m[3])}`
}

/**
 * 每日堆叠柱（两段：输入 / 输出，线性标度）。
 *
 * 只画两段：柱高 = inputTokens + outputTokens = 日桶 totalTokens 原值，图上
 * 不存在第三个「总量」口径。空桶画 1px 基线（Missing 态），不参与 hover 与下钻。
 * 每根柱是一个可聚焦的 <g role="button">，键盘可达（Tab / Enter）。
 */
export function StackedDailyBars({
  days,
  stamp,
  onSelectDay,
  selectedDate,
}: {
  days: UsageDay[]
  stamp: string | null
  onSelectDay?: (date: string) => void
  selectedDate?: string | null
}) {
  const [hover, setHover] = useState<string | null>(null)
  const list = Array.isArray(days) ? days : []
  const maxTotal = Math.max(0, ...list.map((d) => (d.inputTokens || 0) + (d.outputTokens || 0)))
  const axisMax = niceCeilLinear(maxTotal)
  const slot = (PLOT_W - PAD_L - PAD_R) / Math.max(1, list.length)
  const barW = Math.max(1, Math.min(18, slot * 0.7))

  const active = hover || selectedDate || null

  return (
    <div>
      <svg
        viewBox={`0 0 ${PLOT_W} ${PLOT_H + PLOT_T}`}
        className="w-full"
        style={{ height: PLOT_H + PLOT_T }}
        role="img"
        aria-label={`每日用量堆叠柱图，近 ${list.length} 日，共 ${list.filter((d) => !isEmptyDay(d)).length} 天有记录`}
      >
        <title>每日用量（输入 / 输出 两段堆叠）</title>
        <line
          x1={PAD_L}
          y1={PLOT_T + PLOT_H}
          x2={PLOT_W - PAD_R}
          y2={PLOT_T + PLOT_H}
          stroke="var(--color-card-border)"
          strokeWidth={1}
        />
        {list.map((d, i) => {
          const x = PAD_L + i * slot + (slot - barW) / 2
          const segs = stackSegments(d, axisMax, PLOT_H)
          const missing = isEmptyDay(d)
          const label = missing
            ? `${fmtDayLabel(d.date)}：无记录`
            : `${fmtDayLabel(d.date)}：输入 ${d.inputTokens} · 输出 ${d.outputTokens} · 合计 ${d.totalTokens} tokens · ${d.requests} 次请求`
          return (
            <g
              key={d.date}
              role="button"
              tabIndex={missing ? -1 : 0}
              aria-label={label}
              onMouseEnter={() => setHover(d.date)}
              onMouseLeave={() => setHover((h) => (h === d.date ? null : h))}
              onFocus={() => setHover(d.date)}
              onBlur={() => setHover((h) => (h === d.date ? null : h))}
              onClick={() => { if (!missing) onSelectDay?.(d.date) }}
              onKeyDown={(e) => {
                if (missing) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelectDay?.(d.date)
                }
              }}
              style={{ cursor: missing ? 'default' : 'pointer', outline: 'none' }}
            >
              <title>{label}</title>
              <rect
                x={x}
                y={PLOT_T}
                width={barW}
                height={PLOT_H}
                fill="transparent"
              />
              {missing ? (
                // Missing 态：1px 基线，与真实数据异色。不写 title 以外的语义。
                <rect
                  x={x}
                  y={PLOT_T + PLOT_H - 1}
                  width={barW}
                  height={1}
                  fill={COLOR_MISSING}
                  opacity={0.5}
                />
              ) : (
                segs.map((s) => (
                  <rect
                    key={s.key}
                    x={x}
                    y={PLOT_T + s.y}
                    width={barW}
                    height={Math.max(1, s.height)}
                    fill={s.key === 'input' ? COLOR_INPUT : COLOR_OUTPUT}
                    opacity={active && active !== d.date ? 0.45 : 1}
                  />
                ))
              )}
              {active === d.date && (
                <rect
                  x={x - 1}
                  y={PLOT_T - 4}
                  width={barW + 2}
                  height={PLOT_H + 4}
                  fill="none"
                  stroke="var(--color-foreground)"
                  strokeWidth={1}
                  opacity={0.5}
                />
              )}
            </g>
          )
        })}
      </svg>
      <div className="flex justify-between mt-1 text-xs text-foreground-muted">
        <span>{list.length ? fmtDayLabel(list[0].date) : ''}</span>
        <span>今日</span>
      </div>
      <div className="flex items-center gap-4 mt-2 text-xs text-foreground-muted">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: COLOR_INPUT }} />
          输入
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: COLOR_OUTPUT }} />
          输出
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-0.5 rounded-sm" style={{ backgroundColor: COLOR_MISSING }} />
          无记录（未记 ≠ 零用量）
        </span>
        <span className="ml-auto">纵轴上限 {formatCompactNumber(axisMax)} tokens</span>
      </div>
      {stamp && (
        <div className="text-xs text-foreground-muted mt-1">数据截至 {stamp}</div>
      )}
    </div>
  )
}

/** 一根条。ratio 缺失按 0 画，label 旁永远有分子/分母原文。 */
function Bar({ ratio, color, ariaLabel }: { ratio: number; color: string; ariaLabel: string }) {
  const pct = Math.max(0, Math.min(100, ratio * 100))
  return (
    <div
      className="h-2 bg-surface rounded-full overflow-hidden"
      role="meter"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  )
}

export interface CoverageData {
  byDay: { daysWithRequests: number; pricedDays: number; unpricedDays: number; unpricedDayDates: string[] }
  flatThisProcess: { requests: number; providers: string[]; tokens: number; recalculatedUSD: number; degraded: boolean }
}

/**
 * 计价覆盖率。**两条各自独立的条**，不共用一根：byDay 是日级（跨 N 天），
 * flatThisProcess 是进程级（本次 REPL/host 进程内），时间轴不同，相加即造假。
 */
export function CoverageBar({ data, rangeDays }: { data: CoverageData | null; rangeDays: number }) {
  if (!data) {
    return <div className="text-sm text-destructive">计价覆盖率不可用：后端服务未提供该口径数据</div>
  }
  const { byDay, flatThisProcess } = data
  const ratio = byDay.daysWithRequests > 0 ? byDay.pricedDays / byDay.daysWithRequests : 0
  const color =
    byDay.daysWithRequests === 0
      ? COLOR_MISSING
      : byDay.pricedDays === 0
        ? COLOR_MISSING
        : COLOR_OUTPUT
  return (
    <div className="space-y-4">
      <div>
        <div className="flex justify-between text-sm mb-1.5">
          <span className="text-foreground/70">按天计价覆盖（近 {rangeDays} 日）</span>
          <span className="text-foreground-muted tabular-nums">
            {byDay.daysWithRequests === 0
              ? '范围内无请求记录'
              : `${byDay.pricedDays}/${byDay.daysWithRequests} 天有成本估计`}
          </span>
        </div>
        <Bar
          ratio={ratio}
          color={color}
          ariaLabel={`按天计价覆盖：${byDay.pricedDays} / ${byDay.daysWithRequests} 天`}
        />
        <p className="text-xs text-foreground-muted mt-1.5">
          反映 ccSwitch 扫描当天是否跑过（扫描是唯一写 costUSD 的路径，主路径恒传 0），
          不代表 AI 适配器产不产价。
          {byDay.unpricedDays > 0 && ` 未计价：${byDay.unpricedDays} 天。`}
        </p>
      </div>
      <div>
        <div className="flex justify-between text-sm mb-1.5">
          <span className="text-foreground/70">本进程订阅制通道</span>
          <span className="text-foreground-muted tabular-nums">
            {flatThisProcess.degraded
              ? 'flat 通道审计未跑成'
              : `${flatThisProcess.requests} 次请求走订阅制通道`}
          </span>
        </div>
        <Bar
          ratio={flatThisProcess.degraded ? 0 : Math.min(1, flatThisProcess.requests / Math.max(1, flatThisProcess.requests + flatThisProcess.tokens / 1e6))}
          color={flatThisProcess.degraded ? COLOR_MISSING : COLOR_INPUT}
          ariaLabel={flatThisProcess.degraded ? 'flat 通道审计未跑成' : `本进程 ${flatThisProcess.requests} 次请求走订阅制通道`}
        />
        <p className="text-xs text-foreground-muted mt-1.5">
          {flatThisProcess.degraded
            ? '价目表不可用，审计没有跑完 —— 这既不是「有订阅制通道」也不是「没有」，请重试。'
            : flatThisProcess.requests === 0
              ? '本次进程内没有走订阅制通道的请求（kiro / cursor / trae / warp 等按 token 计价不成立）。'
              : `走订阅制通道：${flatThisProcess.providers.join('、')}，按 token 计价本就不成立。`}
        </p>
      </div>
    </div>
  )
}

/** 本月 token 阈值条。量纲必须是 token —— costUSD 主路径恒 0，画美元条会是空条。 */
export function ThresholdBar({ used, limit }: { used: number; limit: number }) {
  const ratio = limit > 0 ? used / limit : 0
  const over = ratio > 1
  return (
    <div>
      <div className="flex justify-between text-sm mb-1.5">
        <span className="text-foreground/70">本月 token 用量 / 自设上限</span>
        <span className="text-foreground-muted tabular-nums">
          {formatCompactNumber(used)} / {formatCompactNumber(limit)}（{Math.round(ratio * 100)}%）
        </span>
      </div>
      <Bar
        ratio={ratio}
        color={over ? COLOR_MISSING : COLOR_INPUT}
        ariaLabel={`本月 token 用量 ${used}，上限 ${limit}，占比 ${Math.round(ratio * 100)}%`}
      />
      <p className="text-xs text-foreground-muted mt-1.5">
        每月 1 日重置 · totalTokens = 输入 + 输出，不含缓存读/写
      </p>
    </div>
  )
}