import { useRef, useState } from 'react'
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { Icon } from '../ui/Icon'
import { languageForPath } from './editorLanguages'
import '../../monacoSetup'

// 工作台的唯一 Monaco 实例。切标签只换 path（模型按 URI 复用，
// keepCurrentModel 保住 undo 栈与折叠状态），不重建编辑器 —— 重建会把
// 每个标签的撤销历史一起丢掉。
//
// 受控口径：永远只给 defaultValue，不给 value。给了 value 后
// @monaco-editor/react 会在每次重渲染时 setValue，等于把 undo 栈清空。

export interface EditorSurfaceTab {
  filePath: string
  uri: string
  content: string
  /** 状态栏展示用：保存时按这个行尾还原（模型内部统一 \n） */
  eol: 'lf' | 'crlf'
  bom: boolean
}

interface EditorSurfaceProps {
  tab: EditorSurfaceTab
  saving: boolean
  onMount: (instance: editor.IStandaloneCodeEditor, monaco: Monaco) => void
  onContentChange: () => void
  onSaveShortcut: () => void
}

interface CursorInfo {
  line: number
  column: number
  total: number
}

export function EditorSurface({ tab, saving, onMount, onContentChange, onSaveShortcut }: EditorSurfaceProps) {
  const [cursor, setCursor] = useState<CursorInfo>({ line: 1, column: 1, total: 1 })
  const saveRef = useRef(onSaveShortcut)
  saveRef.current = onSaveShortcut
  const changeRef = useRef(onContentChange)
  changeRef.current = onContentChange
  const mountRef = useRef(onMount)
  mountRef.current = onMount

  const handleMount: OnMount = (instance, monaco) => {
    // Ctrl+S 走编辑器自身命令：焦点在 Monaco 内时页面级 keydown 收不到
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current())
    const sync = () => {
      const position = instance.getPosition()
      setCursor({
        line: position?.lineNumber ?? 1,
        column: position?.column ?? 1,
        total: instance.getModel()?.getLineCount() ?? 1,
      })
    }
    instance.onDidChangeCursorPosition(sync)
    instance.onDidChangeModelContent(sync)
    instance.onDidChangeModel(sync)
    sync()
    mountRef.current(instance, monaco)
  }

  const language = languageForPath(tab.filePath)

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 relative">
        <Editor
          height="100%"
          path={tab.uri}
          defaultValue={tab.content}
          language={language}
          keepCurrentModel
          theme="vs-dark"
          onMount={handleMount}
          onChange={() => changeRef.current()}
          options={{
            automaticLayout: true,
            minimap: { enabled: true, maxColumn: 80 },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            tabSize: 2,
            renderWhitespace: 'selection',
            fixedOverflowWidgets: true,
            smoothScrolling: true,
          }}
        />
      </div>
      <div className="h-7 shrink-0 flex items-center gap-3 px-3 border-t border-border bg-surface/60 text-[11px] text-foreground-muted select-none">
        <span className="tabular-nums">
          第 {cursor.line} 行，第 {cursor.column} 列
        </span>
        <span className="tabular-nums">{cursor.total} 行</span>
        <span>{language}</span>
        <span>
          {tab.eol === 'crlf' ? 'CRLF' : 'LF'}
          {tab.bom ? ' · BOM' : ''}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => saveRef.current()}
          disabled={saving}
          className="flex items-center gap-1 px-2 h-5 rounded text-[11px] text-foreground-muted hover:text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors"
          title="保存当前文件（Ctrl+S）"
        >
          <Icon name="save" size={11} />
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}
