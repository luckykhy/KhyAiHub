// MessageList 的 jsdom 挂载点：用真 DOM 验证「工具执行过程挂在对应提问下」。
// 由 tests/toolExecutionPlacement.test.cjs 用 esbuild 打包后加载。
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Provider } from 'react-redux'
import { store } from '../src/renderer/state/store'
import { MessageList } from '../src/renderer/components/message/MessageBubble'
import { setMessages, addMessage, clearMessages } from '../src/renderer/state/messageSlice'
import {
  beginToolTurn,
  startToolExecution,
  updateToolExecution,
  clearExecutions,
  hydrateToolExecutions,
} from '../src/renderer/state/toolExecutionSlice'

let root: Root | null = null

export function mount() {
  const el = document.getElementById('root')
  if (!el) throw new Error('缺少 #root 容器')
  root = createRoot(el)
  root.render(
    <Provider store={store}>
      <MessageList onQuickAction={() => {}} showReasoning={false} />
    </Provider>
  )
}

export function unmount() {
  if (root) {
    root.unmount()
    root = null
  }
}

export {
  store,
  setMessages,
  addMessage,
  clearMessages,
  beginToolTurn,
  startToolExecution,
  updateToolExecution,
  clearExecutions,
  hydrateToolExecutions,
}
