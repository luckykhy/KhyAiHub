// 工具改动的红绿 ±行模型（host → renderer 的载荷契约）。
//
// 行由后端 `runtime/node/backend/src/cli/writeDiffRows.js` 生产，形状与终端端
// 逐字节一致（kind/num/numNew/text）——四端共用同一份「改了什么」，渲染层只负责
// 上色与折叠。渲染层不再自己解析 before/after 算 diff：那会让桌面端与终端端
// 各有一套口径，同一次改动两端显示不一致。
export type DiffRowKind = 'add' | 'del' | 'ctx' | 'gap' | 'meta' | 'more' | 'stat'

export interface DiffRow {
  kind: DiffRowKind
  /** 旧文件 1-based 行号（del/ctx）；单列 gutter 下 add 行也用它表示新行号。 */
  num?: number
  /** 新文件 1-based 行号（双列 gutter 开时 ctx/add 行携带）。 */
  numNew?: number
  text: string
}

export interface ToolDiff {
  filePath: string
  rows: DiffRow[]
  added: number
  removed: number
  /** 行数超过上限被截断：界面必须说明「还有 N 行未显示」，不许假装完整。 */
  truncated: boolean
}

/** 单次工具结果进入渲染层的行数上限；超出部分不传，由 truncated 标记兜底说明。 */
export const MAX_DIFF_ROWS = 2000
