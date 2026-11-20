// 内建代码编辑器工作台（DESIGN-ARCH-210）—— 主进程 / preload / 渲染层共用的
// 载荷契约与上限。三个进程不再各写一份数字：改上限只改这里。

import type { DiffRow } from './toolDiff'

/** 单文件可编辑上限。超过即 tooLarge，不把 200MB 日志塞进 Monaco。 */
export const EDITOR_READ_MAX_BYTES = 4 * 1024 * 1024

/** 新建文件名上限（Windows 单个文件名字符上限 255，留余量）。 */
export const EDITOR_NAME_MAX_CHARS = 120

// ── 全局搜索预算 ──
// 四个上限同时生效，任一触顶即返回 truncated + reason，UI 如实说「还有 N 个
// 文件未扫描」，不许假装搜完了。
export const SEARCH_MAX_FILE_BYTES = 512 * 1024
export const SEARCH_MAX_TOTAL_BYTES = 64 * 1024 * 1024
export const SEARCH_MAX_HITS = 500
export const SEARCH_MAX_HIT_FILES = 200
export const SEARCH_MAX_HITS_PER_FILE = 20
/** 单次搜索的协作式时间预算（循环内检查，到点主动收尾，不 kill 任何任务）。 */
export const SEARCH_BUDGET_MS = 15_000
export const SEARCH_PROGRESS_EVERY_FILES = 200
/** 每扫多少个文件让出一次事件循环（否则一次大搜索会把主进程冻住）。 */
export const SEARCH_YIELD_EVERY_FILES = 50

// ── 文件监听 ──
export const WATCH_DEBOUNCE_MS = 150
export const WATCH_MAX_DIRS = 64
/** 自己刚写完的文件在此时窗内不算「磁盘已变」。 */
export const SELF_WRITE_SUPPRESS_MS = 2_000

// ── AI 改动待审（M3）──
export const PENDING_REVIEW_TIMEOUT_MS = 120_000

export type EditorReadState =
  | 'ok'
  | 'empty'
  | 'tooLarge'
  | 'binary'
  | 'missing'
  | 'outsideWorkspace'
  | 'error'

export interface EditorReadResult {
  ok: boolean
  state: EditorReadState
  /** 统一为 \n 的文本（模型内部行尾口径；保存时按 eol 还原） */
  content?: string
  mtimeMs?: number
  size?: number
  /** 磁盘原始行尾 */
  eol?: 'lf' | 'crlf'
  bom?: boolean
  error?: string
}

export type EditorWriteState =
  | 'ok'
  | 'conflict'
  | 'missing'
  | 'outsideWorkspace'
  | 'rejected'
  | 'error'

export interface EditorWriteResult {
  ok: boolean
  state: EditorWriteState
  mtimeMs?: number
  diskMtimeMs?: number
  error?: string
}

export type EditorCreateState = 'ok' | 'exists' | 'missing' | 'outsideWorkspace' | 'rejected' | 'error'

export interface EditorCreateResult {
  ok: boolean
  state: EditorCreateState
  filePath?: string
  mtimeMs?: number
  error?: string
}

export interface EditorSearchOptions {
  caseSensitive?: boolean
  /** 搜索根（会话级工作区可能不同于当前工作区根）；主进程仍按白名单校验 */
  root?: string
  /** 渲染层预生成的搜索 id：结果返回前就要能取消，否则「取消」按钮无 id 可用 */
  searchId?: string
}

export interface EditorSearchHit {
  filePath: string
  /** 1-based */
  line: number
  /** 1-based，字符列（不是字节列） */
  column: number
  /** 命中行原文（已截断到 EDITOR_SEARCH_PREVIEW_CHARS） */
  preview: string
}

export const EDITOR_SEARCH_PREVIEW_CHARS = 240

export interface EditorSearchProgress {
  searchId: string
  scannedFiles: number
  totalFiles: number
  hitCount: number
  hitFiles: number
}

export interface EditorSearchResult {
  ok: boolean
  searchId: string
  hits: EditorSearchHit[]
  scannedFiles: number
  totalFiles: number
  /** 因超大 / 二进制 / 读失败被跳过的文件数 */
  skippedFiles: number
  truncated: boolean
  /** truncated 的原因，UI 原样展示（含「还有 N 个文件未扫描」） */
  reason?: string
  cancelled?: boolean
  error?: string
}

export interface EditorFileChanged {
  filePath: string
  state: 'changed' | 'gone'
  mtimeMs?: number
}

export interface EditorWatchSetResult {
  ok: boolean
  /** 实际建立监听的目录数 */
  watchedDirs: number
  /** 超出 WATCH_MAX_DIRS 未建立的路径数 */
  dropped: number
  error?: string
}

// ── AI 改动待审（M3）──
// 只审「编辑器打开集合」内的路径：未打开的照旧直写，AI 能力不退化。
export interface EditorPendingItem {
  id: string
  filePath: string
  /** 触发改动的工具名（editFile / ApplyPatchTool …），展示用 */
  reason: string
  /** 完整的 ± 行模型（expanded，最多 MAX_DIFF_ROWS 行） */
  rows: DiffRow[]
  added: number
  removed: number
  truncated: boolean
  /** 待审期间磁盘的 mtime 基线；接受时写盘仍按它做冲突检查 */
  baseMtimeMs?: number
  createdAt: number
}

export interface EditorPendingDecision {
  id: string
  accept: boolean
  /** 接受的块下标（splitDiffHunks 的 index）；缺省 = 全部接受 */
  acceptedHunks?: number[]
}

export interface EditorPendingSettled {
  id: string
  ok: boolean
  state: 'accepted' | 'rejected' | 'timeout' | 'error'
  error?: string
}
