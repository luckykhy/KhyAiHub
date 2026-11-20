// 「内建代码编辑器工作台」preload API 片段（DESIGN-ARCH-210）：读/写/新建/搜索/
// 磁盘变更 + 搜索进度。通道名与 main 侧 src/main/editor/ipc.ts 的注册一一配对。
//
// 为什么拆成片段：这块原本内联在 preload/index.ts 的 api 对象里，而那一个对象
// 早已超过仓库的 maxFuncLines 上限——每往它里面加一段，棘轮门就红一次。amoo 秘书
// 与「电脑端 AI」两条车道都走「自己的模块 + index.ts 一次 spread」，编辑器这条
// 没有理由例外。从 index.ts 整块搬来，行为不变（同样的键、同样的通道）。
import type { IpcRenderer } from 'electron'
import type {
  EditorFileChanged,
  EditorPendingDecision,
  EditorPendingItem,
  EditorPendingSettled,
  EditorSearchOptions,
  EditorSearchProgress,
} from '../shared/editorContract'

export function createEditorApi(ipcRenderer: IpcRenderer) {
  return {
    // 与 codeViewer/codeEditor 两条旧通道并存：工作台是独立形态，旧的侧栏编辑态
    // 继续走旧通道，等 M2 统一写落点后再收口。
    editorRead: (filePath: string) => ipcRenderer.invoke('editor:read', filePath),
    editorWrite: (filePath: string, content: string, baseMtimeMs?: number) =>
      ipcRenderer.invoke('editor:write', filePath, content, baseMtimeMs),
    editorCreateFile: (dirPath: string, fileName: string) => ipcRenderer.invoke('editor:create-file', dirPath, fileName),
    editorSearch: (query: string, options?: EditorSearchOptions) => ipcRenderer.invoke('editor:search', query, options || {}),
    editorSearchCancel: (searchId: string) => ipcRenderer.invoke('editor:search-cancel', searchId),
    editorWatchSet: (filePaths: string[]) => ipcRenderer.invoke('editor:watch-set', filePaths),
    // AI 改动待审（M3）：列表用于窗口重载后重建；决定只有「接受/拒绝」两种。
    editorPendingList: () => ipcRenderer.invoke('editor:pending-list'),
    editorPendingDecision: (decision: EditorPendingDecision) =>
      ipcRenderer.invoke('editor:pending-decision', decision),
    // 磁盘变更与搜索进度是 main → renderer 的单向事件，退订只移除监听。
    onEditorFileChanged: (cb: (evt: EditorFileChanged) => void) => {
      const listener = (_e: unknown, evt: EditorFileChanged) => cb(evt)
      ipcRenderer.on('editor:fileChanged', listener)
      return () => ipcRenderer.removeListener('editor:fileChanged', listener)
    },
    onEditorSearchProgress: (cb: (progress: EditorSearchProgress) => void) => {
      const listener = (_e: unknown, progress: EditorSearchProgress) => cb(progress)
      ipcRenderer.on('editor:searchProgress', listener)
      return () => ipcRenderer.removeListener('editor:searchProgress', listener)
    },
    onEditorPending: (cb: (item: EditorPendingItem) => void) => {
      const listener = (_e: unknown, item: EditorPendingItem) => cb(item)
      ipcRenderer.on('editor:pending', listener)
      return () => ipcRenderer.removeListener('editor:pending', listener)
    },
    onEditorPendingSettled: (cb: (evt: EditorPendingSettled) => void) => {
      const listener = (_e: unknown, evt: EditorPendingSettled) => cb(evt)
      ipcRenderer.on('editor:pendingSettled', listener)
      return () => ipcRenderer.removeListener('editor:pendingSettled', listener)
    },
  }
}
