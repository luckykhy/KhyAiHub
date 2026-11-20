import path from 'node:path'
import type { BrowserWindow, IpcMain } from 'electron'
import type { EditorPendingDecision, EditorPendingItem, EditorSearchOptions } from '../../shared/editorContract'
import { readEditorFile } from './readFile'
import { createEditorFile, writeEditorFile } from './writeFile'
import { buildPendingItem, type RawPendingRequest } from './pending'
import { cancelEditorSearch, runEditorSearch } from './search'
import { createEditorWatcher, noteEditorSelfWrite } from './watcher'
import { isInsideAnyRoot } from './workspaceRules'

// 工作台 IPC（DESIGN-ARCH-210 M1）。注册点只有一个（whenReady），通道名
// namespace:action；desktopUiContract 的 D6 会把这个文件纳入主进程侧扫描，
// preload 里每条 invoke 都必须在这里找得到对应 handle。

export interface EditorIpcDeps {
  /** 写/读/建的白名单根：当前工作区 ∪ MRU ∪ 项目登记 ∪ 本会话展开过的树根 */
  getWritableRoots: () => Promise<Set<string>>
  getWorkspaceRoot: () => Promise<string>
  getWindow: () => BrowserWindow | null
  /**
   * 人保存成功后通知 host 更新它的先读后写台账（M2）。不同步的话：人刚存完，
   * AI 下一个 Edit 会按「磁盘已变」拒绝，而它其实读过这份文件。
   * 新建空文件不走这里——那会把「没读过」伪装成「读过了」。
   */
  notifyHostFileWritten?: (filePath: string, mtimeMs: number) => void
  /** 编辑器打开集合变化：host 只对这些路径的 AI 改动设待审闸门 */
  notifyHostWatchSet?: (filePaths: string[]) => void
  /** 人对待审卡片做了决定：转给 host 放行/拒绝那笔写盘 */
  notifyHostPendingDecision?: (decision: EditorPendingDecision) => void
  /** 主窗关闭：host 把所有待审改动按拒绝收束（磁盘从未被改动） */
  notifyHostCancelAllPending?: () => void
}

export interface EditorIpcHandle {
  /** host 报告一处 AI 改动待批准：装配 diff 行并推给渲染层 */
  handleHostPendingRequest: (raw: RawPendingRequest) => void
  handleHostPendingSettled: (raw: { id?: unknown; ok?: unknown; state?: unknown; error?: unknown }) => void
  /** 主窗关闭：清掉镜像并让 host 拒绝全部待审 */
  cancelAllPending: () => void
}

export function registerEditorIpc(ipc: IpcMain, deps: EditorIpcDeps): EditorIpcHandle {
  // 镜像只服务于窗口重载后的 editor:pending-list 重建；待审真身在 host（持有
  // before/after、mtime 基线与 promise resolve）。主进程不替 host 决定任何事。
  const pendingReviews = new Map<string, EditorPendingItem>()

  const sendToRenderer = (channel: string, payload: unknown) => {
    const win = deps.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
  const watcher = createEditorWatcher((evt) => {
    const win = deps.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('editor:fileChanged', evt)
  })

  ipc.handle('editor:read', async (_e, filePath: string) => readEditorFile(filePath, await deps.getWritableRoots()))

  ipc.handle('editor:write', async (_e, filePath: string, content: string, baseMtimeMs?: number) =>
    writeEditorFile({ filePath, content, baseMtimeMs }, await deps.getWritableRoots(), {
      afterWrite: (writtenPath, mtimeMs) => {
        noteEditorSelfWrite(writtenPath, mtimeMs)
        deps.notifyHostFileWritten?.(writtenPath, mtimeMs)
      },
    }),
  )

  ipc.handle('editor:create-file', async (_e, dirPath: string, fileName: string) =>
    createEditorFile({ dirPath, fileName }, await deps.getWritableRoots(), {
      afterWrite: noteEditorSelfWrite,
    }),
  )

  ipc.handle('editor:search', async (e, query: string, options?: EditorSearchOptions) => {
    const roots = await deps.getWritableRoots()
    const requested =
      typeof options?.root === 'string' && options.root.trim()
        ? path.resolve(options.root.trim())
        : await deps.getWorkspaceRoot()
    if (!isInsideAnyRoot(requested, roots)) {
      return {
        ok: false,
        searchId: '',
        hits: [],
        scannedFiles: 0,
        totalFiles: 0,
        skippedFiles: 0,
        truncated: false,
        error: `拒绝搜索 ${requested}：该目录不在已登记的工作区内，请先用「打开工作区」登记它`,
      }
    }
    return runEditorSearch(requested, query, options || {}, {
      onProgress: (progress) => {
        if (!e.sender.isDestroyed()) e.sender.send('editor:searchProgress', progress)
      },
    })
  })

  ipc.handle('editor:search-cancel', async (_e, searchId: string) => ({ ok: cancelEditorSearch(searchId) }))

  // 空集合 = 停掉全部看门狗（工作台卸载 / 关窗时由渲染层发一次）
  ipc.handle('editor:watch-set', async (_e, filePaths: string[]) => {
    const paths = Array.isArray(filePaths) ? filePaths.filter((p): p is string => typeof p === 'string') : []
    // 同一份集合也是 host 的「需要审阅」边界：未打开的路径照旧直写。
    deps.notifyHostWatchSet?.(paths)
    return watcher.setTargets(paths)
  })

  ipc.handle('editor:pending-list', async () => Array.from(pendingReviews.values()))

  ipc.handle('editor:pending-decision', async (_e, decision: EditorPendingDecision) => {
    if (!decision || typeof decision.id !== 'string') {
      return { ok: false, error: '待审 id 缺失：无法提交决定，请刷新后重试' }
    }
    const existed = pendingReviews.delete(decision.id)
    deps.notifyHostPendingDecision?.({
      id: decision.id,
      accept: decision.accept === true,
      acceptedHunks: Array.isArray(decision.acceptedHunks) ? decision.acceptedHunks : undefined,
    })
    return { ok: true, existed }
  })

  return {
    handleHostPendingRequest: (raw) => {
      const item = buildPendingItem(raw)
      if (!item) {
        // 没有可渲染的 diff 就绝不弹一张「看不见改动」的批准卡——按拒绝收束，
        // 让工具如实返回未批准（fail-closed：没有审阅依据就不能落盘）。
        if (typeof raw.id === 'string') {
          deps.notifyHostPendingDecision?.({ id: raw.id, accept: false })
        }
        return
      }
      pendingReviews.set(item.id, item)
      sendToRenderer('editor:pending', item)
    },
    handleHostPendingSettled: (raw) => {
      if (typeof raw.id !== 'string') return
      pendingReviews.delete(raw.id)
      sendToRenderer('editor:pendingSettled', {
        id: raw.id,
        ok: raw.ok === true,
        state: typeof raw.state === 'string' ? raw.state : 'error',
        error: typeof raw.error === 'string' ? raw.error : undefined,
      })
    },
    cancelAllPending: () => {
      pendingReviews.clear()
      deps.notifyHostCancelAllPending?.()
    },
  }
}
