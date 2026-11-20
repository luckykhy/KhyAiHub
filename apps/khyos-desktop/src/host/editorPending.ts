// AI 改动待审（DESIGN-ARCH-210 M3）的 host 侧状态。
//
// 闸门挂在 fileWriteService.setPendingGate 上 —— 工具链没有干净的写前钩子：
// riskGate / PreToolUse 都发生在「新内容算出之前」，_khyWriteDiff 是写后回读。
// 写盘收口到唯一落点之后，闸门就是一个 if。
//
// 状态归属：before/after、mtime 基线与 promise resolve 都在这里；主进程只做
// 中继 + 镜像（窗口重载后 editor:pending-list 靠它重建）。未批准的改动从未
// 落到磁盘，拒绝/超时/关窗都不需要回滚。

import fs from 'node:fs'
import path from 'node:path'
import { PENDING_REVIEW_TIMEOUT_MS } from '../shared/editorContract.ts'
import { applyAcceptedHunks, type StructuredDiffHunk } from '../shared/editorDiff.ts'

export type PendingVerdict =
  | { action: 'accept'; content?: string }
  | { action: 'reject'; error?: string }

export interface PendingGateInput {
  filePath: string
  content: string
  beforeContent?: string
  baseMtimeMs?: number
  actor: string
  reason: string
}

interface PendingEntry {
  id: string
  filePath: string
  before: string
  after: string
  reason: string
  timer: ReturnType<typeof setTimeout>
  resolve: (verdict: PendingVerdict) => void
}

export interface EditorPendingDeps {
  send: (msg: unknown) => void
  nodeRequire: (id: string) => unknown
  resolveKhyOsDir: () => string
}

interface StructuredHunkRow {
  kind: 'ctx' | 'del' | 'add'
  num: number
  text: string
}

interface StructuredHunk {
  rows: StructuredHunkRow[]
}

const MAX_PENDING = 16

export function createEditorPendingGate(deps: EditorPendingDeps) {
  const openPaths = new Set<string>()
  // 一个文件同时只允许一处待审：第二笔写如果排队等锁，会把工具的 30s 锁超时
  // 变成用户看到的「文件被其他写入占用」，原因完全不可解释。
  const pending = new Map<string, PendingEntry>()
  let seq = 0

  const normalize = (p: string): string => {
    const resolved = path.resolve(String(p || ''))
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  function setOpenPaths(paths: string[]): void {
    openPaths.clear()
    for (const p of paths) {
      if (typeof p === 'string' && p.trim()) openPaths.add(normalize(p))
    }
  }

  function settleAll(reason: string): number {
    const entries = Array.from(pending.values())
    pending.clear()
    for (const entry of entries) {
      clearTimeout(entry.timer)
      deps.send({ type: 'editor.pendingSettled', id: entry.id, ok: false, state: 'rejected', error: reason })
      entry.resolve({ action: 'reject', error: reason })
    }
    return entries.length
  }

  async function gate(input: PendingGateInput): Promise<PendingVerdict> {
    // 人自己的保存不走闸门；只有工具写盘需要人批准。
    if (!input || input.actor !== 'tool') return { action: 'accept' }
    const filePath = String(input.filePath || '')
    if (!filePath) return { action: 'accept' }
    if (!openPaths.has(normalize(filePath))) return { action: 'accept' }
    if (pending.size >= MAX_PENDING) {
      return { action: 'reject', error: `同时等待批准的改动已达 ${MAX_PENDING} 处：请先在编辑器里处理已有待审改动` }
    }
    const key = normalize(filePath)
    const existing = pending.get(key)
    if (existing) {
      return {
        action: 'reject',
        error: `该文件已有待审改动（${existing.reason}）：请先在编辑器里接受或拒绝上一处 AI 改动`,
      }
    }

    let before = typeof input.beforeContent === 'string' ? input.beforeContent : ''
    if (typeof input.beforeContent !== 'string') {
      try {
        before = await fs.promises.readFile(filePath, 'utf8')
      } catch {
        // 读不到磁盘（新文件 / 权限）：按空内容展示 —— diff 会退化成整文件新增，
        // 但「看不到 before」不该被伪装成「不需要审」。
        before = ''
      }
    }
    const after = input.content
    if (before === after) return { action: 'accept' }

    const id = `pr_${Date.now().toString(36)}_${++seq}`
    return await new Promise<PendingVerdict>((resolve) => {
      // RUNTIME-003 合法例外「仅 reject 的 Promise 超时」：到点只拒绝并放行
      // 工具循环，不 kill 任何任务；磁盘从未被改动。
      const timer = setTimeout(() => {
        pending.delete(key)
        const error = `等待批准超时（${Math.round(PENDING_REVIEW_TIMEOUT_MS / 1000)} 秒）：该改动未写入磁盘`
        deps.send({ type: 'editor.pendingSettled', id, ok: false, state: 'timeout', error })
        resolve({ action: 'reject', error })
      }, PENDING_REVIEW_TIMEOUT_MS)
      timer.unref?.()
      pending.set(key, {
        id,
        filePath,
        before,
        after,
        reason: input.reason || '工具',
        timer,
        resolve: (verdict) => {
          clearTimeout(timer)
          pending.delete(key)
          resolve(verdict)
        },
      })
      deps.send({
        type: 'editor.pendingRequest',
        id,
        filePath,
        reason: input.reason || '工具',
        beforeContent: before,
        afterContent: after,
        baseMtimeMs: input.baseMtimeMs,
      })
    })
  }

  function decide(id: string, decision: { accept?: unknown; acceptedHunks?: unknown }): { ok: boolean; error?: string } {
    const entry = Array.from(pending.values()).find((item) => item.id === id)
    if (!entry) {
      return { ok: false, error: '该待审改动已结束（可能已超时或已被处理）：磁盘未被修改' }
    }
    if (!decision || decision.accept !== true) {
      entry.resolve({ action: 'reject', error: '用户未批准该改动（磁盘保持原样）' })
      deps.send({ type: 'editor.pendingSettled', id, ok: false, state: 'rejected' })
      return { ok: true }
    }

    const accepted = Array.isArray(decision.acceptedHunks)
      ? new Set(decision.acceptedHunks.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0))
      : null
    if (accepted && accepted.size === 0) {
      entry.resolve({ action: 'reject', error: '你拒绝了全部改动块：磁盘保持原样' })
      deps.send({ type: 'editor.pendingSettled', id, ok: false, state: 'rejected' })
      return { ok: true }
    }

    let content = entry.after
    if (accepted) {
      const rebuilt = rebuildAcceptedContent(deps, entry.before, entry.after, accepted)
      if (rebuilt === null) {
        // 不留一个「用户以为已接受、工具却在等 120s」的悬空 Promise：按拒绝收束
        // 并把原因送回界面，让用户重新选择。
        const error = '部分接受不可用：无法切分改动块（diff 引擎不可用），请让 AI 重试后改用「全部接受」'
        entry.resolve({ action: 'reject', error })
        deps.send({ type: 'editor.pendingSettled', id, ok: false, state: 'error', error })
        return { ok: false, error }
      }
      content = rebuilt
    }
    entry.resolve({ action: 'accept', content })
    deps.send({ type: 'editor.pendingSettled', id, ok: true, state: 'accepted' })
    return { ok: true }
  }

  return { gate, setOpenPaths, decide, settleAll }
}

export type EditorPendingGate = ReturnType<typeof createEditorPendingGate>

type StructuredHunksModule = {
  computeStructuredDiffHunks: (
    before: string,
    after: string,
    opts?: { context?: number },
  ) => { hunks?: StructuredDiffHunk[] } | null
}

/**
 * 按块重建「接受子集」后的内容。返回 null = 引擎不可用/无块可切，调用方必须
 * 让用户改选全部接受或拒绝，绝不偷偷按「全部接受」处理未经批准的块。
 */
function rebuildAcceptedContent(
  deps: EditorPendingDeps,
  before: string,
  after: string,
  accepted: Set<number>,
): string | null {
  let mod: StructuredHunksModule
  try {
    mod = deps.nodeRequire(
      path.join(deps.resolveKhyOsDir(), 'runtime', 'node', 'backend', 'src', 'utils', 'diff', 'structuredHunks.js'),
    ) as StructuredHunksModule
  } catch {
    return null
  }
  if (!mod || typeof mod.computeStructuredDiffHunks !== 'function') return null
  let hunks: StructuredDiffHunk[]
  try {
    const model = mod.computeStructuredDiffHunks(before, after, { context: 3 })
    hunks = model && Array.isArray(model.hunks) ? model.hunks : []
  } catch {
    return null
  }
  if (!hunks.length) return null
  return applyAcceptedHunks(before, after, hunks, accepted)
}
