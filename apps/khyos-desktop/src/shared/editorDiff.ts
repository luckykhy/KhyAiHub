import type { DiffRow } from './toolDiff'

// AI 改动待审的纯函数层（DESIGN-ARCH-210 M3）。
// 行模型只有一份生产者（后端 cli/writeDiffRows），多段改动之间固定插入一条
// kind==='gap' 行 —— 这里按它切块，供「逐块接受/拒绝」用。切块下标必须与
// 后端 utils/diff/structuredHunks 的 hunks 下标一一对应（同一份行模型），
// 否则部分接受会把批准块拼错位置。

export interface EditorDiffHunk {
  /** 与 computeStructuredDiffHunks 的 hunks 下标一致 */
  index: number
  rows: DiffRow[]
}

/** 后端 utils/diff/structuredHunks 的行形状（只取拼接要用的字段） */
export interface StructuredDiffRow {
  kind: 'ctx' | 'del' | 'add'
  num: number
  text: string
}

export interface StructuredDiffHunk {
  rows: StructuredDiffRow[]
}

/** 切块：gap 是块边界；stat / more 不属于任何块（统计行/折叠提示）。 */
export function splitDiffHunks(rows: DiffRow[]): EditorDiffHunk[] {
  const hunks: EditorDiffHunk[] = []
  let current: DiffRow[] = []
  const flush = () => {
    if (!current.length) return
    hunks.push({ index: hunks.length, rows: current })
    current = []
  }
  for (const row of rows) {
    if (row.kind === 'gap') {
      flush()
      continue
    }
    if (row.kind === 'add' || row.kind === 'del' || row.kind === 'ctx') current.push(row)
  }
  flush()
  return hunks
}

/**
 * 把「接受的块子集」拼回一份完整内容（host 侧闸门用）。
 * 块的旧行范围取自 ctx/del 行的旧行号（add 行的 num 是新文件行号，不能拿来
 * 定位旧文件），因此不依赖双列 gutter 开关。全部接受时直接原样返回 after，
 * 保住字节级一致（含末尾换行）。
 */
export function applyAcceptedHunks(
  before: string,
  after: string,
  hunks: StructuredDiffHunk[],
  accepted: Set<number>,
): string {
  if (!hunks.length || accepted.size >= hunks.length) return after
  const splitLines = (text: string): string[] => {
    const arr = String(text ?? '').split('\n')
    if (arr.length && arr[arr.length - 1] === '') arr.pop()
    return arr
  }
  const oldLines = splitLines(before)
  const out: string[] = []
  let oldIdx = 0
  for (let h = 0; h < hunks.length; h++) {
    const rows = hunks[h].rows
    const firstOld = rows.find((r) => r.kind !== 'add')
    const hunkOldStart = firstOld ? Math.max(0, firstOld.num - 1) : oldLines.length
    while (oldIdx < hunkOldStart && oldIdx < oldLines.length) {
      out.push(oldLines[oldIdx])
      oldIdx++
    }
    const take = accepted.has(h)
    for (const row of rows) {
      if (row.kind === 'ctx') {
        out.push(oldLines[oldIdx] ?? row.text)
        oldIdx++
      } else if (row.kind === 'del') {
        if (!take) out.push(oldLines[oldIdx] ?? row.text)
        oldIdx++
      } else if (take) {
        out.push(row.text)
      }
    }
  }
  while (oldIdx < oldLines.length) {
    out.push(oldLines[oldIdx])
    oldIdx++
  }
  const endsWithNewline = /\n$/.test(after)
  return out.join('\n') + (endsWithNewline && out.length ? '\n' : '')
}
