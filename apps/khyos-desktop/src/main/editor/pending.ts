import { createRequire } from 'node:module'
import path from 'node:path'
import type { EditorPendingItem } from '../../shared/editorContract'
import { MAX_DIFF_ROWS, type DiffRow } from '../../shared/toolDiff'

// AI 改动待审卡片的数据装配（DESIGN-ARCH-210 M3）。
// 行模型仍由后端 cli/writeDiffRows 生成 —— 与聊天工具卡、终端看到的是同一份
// 「改了什么」；这里只做中文 gap 文案与 stat 行去掉（卡片头已经有 ±N）。

const nodeRequire = createRequire(import.meta.url)

const resolveKhyOsRoot = (): string =>
  process.env.KHY_OS_DIR ? path.resolve(process.env.KHY_OS_DIR) : path.resolve(__dirname, '..', '..', '..', '..')

type DiffRowsModule = {
  buildWriteDiffRows: (ctx: unknown, expanded?: boolean) => DiffRow[] | null
}

let diffRowsModule: DiffRowsModule | null | undefined

function loadDiffRows(): DiffRowsModule | null {
  if (diffRowsModule !== undefined) return diffRowsModule
  try {
    const mod = nodeRequire(
      path.join(resolveKhyOsRoot(), 'runtime', 'node', 'backend', 'src', 'cli', 'writeDiffRows.js'),
    ) as Partial<DiffRowsModule>
    diffRowsModule = typeof mod?.buildWriteDiffRows === 'function' ? (mod as DiffRowsModule) : null
  } catch (err) {
    console.log('[editor] 后端 writeDiffRows 加载失败，待审 diff 不可用:', String(err))
    diffRowsModule = null
  }
  return diffRowsModule
}

function localizeDiffRows(rows: DiffRow[]): DiffRow[] {
  const out: DiffRow[] = []
  for (const row of rows) {
    if (row.kind === 'stat') continue
    if (row.kind === 'gap') {
      const gap = /^⋯\s*(\d+)\s+unchanged lines?$/.exec(row.text)
      if (gap) {
        out.push({ ...row, text: `⋯ ${gap[1]} 行未改动` })
        continue
      }
    }
    out.push(row)
  }
  return out
}

export interface RawPendingRequest {
  id?: unknown
  filePath?: unknown
  reason?: unknown
  beforeContent?: unknown
  afterContent?: unknown
  baseMtimeMs?: unknown
}

/** 返回 null = 拿不到可审的行模型（后端旧版 / 内容相同），调用方按拒绝处理。 */
export function buildPendingItem(raw: RawPendingRequest): EditorPendingItem | null {
  const id = typeof raw.id === 'string' ? raw.id : ''
  const filePath = typeof raw.filePath === 'string' ? raw.filePath : ''
  if (!id || !filePath) return null
  const before = typeof raw.beforeContent === 'string' ? raw.beforeContent : ''
  const after = typeof raw.afterContent === 'string' ? raw.afterContent : ''
  if (before === after) return null
  const mod = loadDiffRows()
  if (!mod) return null
  let rows: DiffRow[] | null
  try {
    rows = mod.buildWriteDiffRows({ filePath, beforeContent: before, afterContent: after }, true)
  } catch {
    return null
  }
  if (!Array.isArray(rows) || rows.length === 0) return null
  let added = 0
  let removed = 0
  for (const row of rows) {
    if (row.kind === 'add') added++
    else if (row.kind === 'del') removed++
  }
  const localized = localizeDiffRows(rows)
  const truncated = localized.length > MAX_DIFF_ROWS
  return {
    id,
    filePath,
    reason: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : '工具',
    rows: truncated ? localized.slice(0, MAX_DIFF_ROWS) : localized,
    added,
    removed,
    truncated,
    baseMtimeMs: typeof raw.baseMtimeMs === 'number' ? raw.baseMtimeMs : undefined,
    createdAt: Date.now(),
  }
}
