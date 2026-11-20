import type {
  EditorCreateResult,
  EditorFileChanged,
  EditorPendingDecision,
  EditorPendingItem,
  EditorPendingSettled,
  EditorReadResult,
  EditorSearchOptions,
  EditorSearchProgress,
  EditorSearchResult,
  EditorWatchSetResult,
  EditorWriteResult,
} from '../../../shared/editorContract'

// 工作台对 preload 的唯一入口。渲染层不直接碰 window 上的每个方法名：
// 少一处拼错就少一次「通道不可用」的夜间事故。
export interface EditorBridge {
  editorRead: (filePath: string) => Promise<EditorReadResult>
  editorWrite: (filePath: string, content: string, baseMtimeMs?: number) => Promise<EditorWriteResult>
  editorCreateFile: (dirPath: string, fileName: string) => Promise<EditorCreateResult>
  editorSearch: (query: string, options?: EditorSearchOptions) => Promise<EditorSearchResult>
  editorSearchCancel: (searchId: string) => Promise<{ ok: boolean }>
  editorWatchSet: (filePaths: string[]) => Promise<EditorWatchSetResult>
  /** AI 改动待审（M3）：旧 preload 没有这几个方法时降级为「无待审轨」 */
  editorPendingList?: () => Promise<EditorPendingItem[]>
  editorPendingDecision?: (decision: EditorPendingDecision) => Promise<{ ok: boolean; existed?: boolean; error?: string }>
  onEditorPending?: (cb: (item: EditorPendingItem) => void) => () => void
  onEditorPendingSettled?: (cb: (evt: EditorPendingSettled) => void) => () => void
  onEditorFileChanged: (cb: (evt: EditorFileChanged) => void) => () => void
  onEditorSearchProgress: (cb: (progress: EditorSearchProgress) => void) => () => void
  /** 未传 rootPath 时的兜底根（与 FileTree 回退口径一致） */
  getWorkspacePath?: () => Promise<string>
}

export const EDITOR_BRIDGE_MISSING = '编辑器通道不可用：preload 未注入 __KHYOS__.editorRead，请重启应用'

export function editorBridge(): EditorBridge | null {
  const api = (window as unknown as { __KHYOS__?: Partial<EditorBridge> }).__KHYOS__
  if (!api?.editorRead || !api.editorWrite) return null
  return api as EditorBridge
}
