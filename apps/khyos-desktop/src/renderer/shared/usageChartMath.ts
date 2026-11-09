// khy-canary: Khy-20261102-343-BG5G8YJT
// 使用统计页的图表数学—— 纯函数，零 import、零 IO（与 sidebarProjectClassify 同构）。
//
// 为什么要单独一层：几何计算一旦写进 .tsx 就只能靠构建才能测，而 host 目录
// 本轮没有类型门。纯叶子可直接转译求值跑 node:test。

/** 与 UsageSettings 共用的日桶形状（后端 getUsageHistory 的 8 键投影）。 */
export interface UsageDay {
  date: string
  inputTokens: number
  outputTokens: number
  /** 日桶 totalTokens 原值 = inputTokens + outputTokens。 */
  totalTokens: number
  requests: number
  costUSD: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type StackSegment = { key: 'input' | 'output'; y: number; height: number }

/**
 * 一日柱子的两段几何（SVG 用户坐标，y 向下）。
 *
 * 段高之和恒等于该日 inputTokens + outputTokens，也就是日桶 totalTokens 的原值——
 * **不返回四桶之和**。缓存读/写是独立累加器（recordUsage :241-244），把它们
 * 叠进「总量」就等于凭空造出第三个总量口径。
 *
 * 空桶（requests === 0 且四桶全 0）返回 []，由调用方画 Missing 态 1px 基线，
 * 不参与 hover 与下钻。
 */
export function stackSegments(day: UsageDay, maxTotal: number, height: number): StackSegment[] {
  if (!day || isEmptyDay(day)) return []
  const input = Number(day.inputTokens) || 0
  const output = Number(day.outputTokens) || 0
  const total = input + output
  if (total <= 0 || maxTotal <= 0 || height <= 0) return []
  const px = (v: number) => (v / maxTotal) * height
  const inH = px(input)
  const outH = px(output)
  const outY = height - outH
  const inY = outY - inH
  return [
    { key: 'input', y: inY, height: inH },
    { key: 'output', y: outY, height: outH },
  ]
}

/** 空桶判定：那天没有任何请求记录。没有它，28 根空柱会被读成「那天没量」。 */
export function isEmptyDay(day: UsageDay | null | undefined): boolean {
  if (!day) return true
  return (
    (Number(day.requests) || 0) <= 0 &&
    (Number(day.inputTokens) || 0) <= 0 &&
    (Number(day.outputTokens) || 0) <= 0
  )
}

// 线性轴的 nice-number 序列。**只适用于线性标度** —— nice-number 是线性刻度技巧，
// 用在 sqrt 轴上会让每个标签系统性说谎（方案已因此撤掉 sqrt）。
const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]

/** 线性轴上限：不小于 max 的最小 nice 值。非有限/非正输入回 1（不炸不画假轴）。 */
export function niceCeilLinear(max: number): number {
  const v = Number(max)
  if (!Number.isFinite(v) || v <= 0) return 1
  const exp = Math.floor(Math.log10(v))
  const pow = 10 ** exp
  for (const step of NICE_STEPS) {
    const candidate = step * pow
    if (candidate >= v - 1e-9) return candidate
  }
  return 10 * pow
}

// CSV 第 9 列：口径列。日桶确实混着两种来源（usageScan.js:427 把 ccSwitch 扫到的
// 外部会话写进同一张 daily 表），逐行恒同值，但**必须显式写出**——不给这列，
// 导出文件会被当成「纯本应用请求」。
export const CSV_SOURCES_NOTE = '本应用请求 + ccSwitch 扫描导入'
export const CSV_HEADERS = [
  'date',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'requests',
  'costUSD',
  'cacheReadTokens',
  'cacheWriteTokens',
  'sources',
] as const

/** 元信息行（抬头 + 口径注记）。null/空值不写行，而不是写 "null"。 */
function metaLine(label: string, value: unknown): string {
  return value === null || value === undefined || value === '' ? '' : `${label}: ${value}`
}

/**
 * 由日桶数组拼 CSV。
 *
 * 表头**恰 9 列**，列数写死在这里、由 tests/usageChartMath.test.cjs 钉住：
 * date / input / output / total / requests / costUSD / cacheRead / cacheWrite / sources。
 * 抬头写明非全量历史（90 天日桶 + 6 个月桶是滚动窗口），注记写明 totalTokens
 * 的口径（= 输入 + 输出，不含缓存）——不给这两行，导出的数字会被当成全量与全口径。
 */
export function csvFromDays(days: UsageDay[], meta?: { stamp?: string | null; rangeDays?: number }): string {
  const head: string[] = []
  const stamp = meta?.stamp ?? null
  const range = meta?.rangeDays ?? null
  const note1 = metaLine('数据截至', stamp)
  const note2 = metaLine('统计窗口', range === null ? null : `近 ${range} 日`)
  if (note1) head.push(`# ${note1}`)
  if (note2) head.push(`# ${note2}`)
  head.push('# 本机数据，非全量历史（90 天日桶 / 6 个月桶为滚动窗口）')
  head.push('# 合计 = 输入 + 输出，不含缓存读/写')
  head.push(CSV_HEADERS.join(','))

  const rows = (Array.isArray(days) ? days : []).map((d) =>
    [
      d.date,
      Number(d.inputTokens) || 0,
      Number(d.outputTokens) || 0,
      Number(d.totalTokens) || 0,
      Number(d.requests) || 0,
      Number(d.costUSD) || 0,
      Number(d.cacheReadTokens) || 0,
      Number(d.cacheWriteTokens) || 0,
      CSV_SOURCES_NOTE,
    ].join(','),
  )
  return [...head, ...rows].join('\n') + '\n'
}