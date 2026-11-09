// AmooSecretaryMemory 的 jsdom 挂载点：真 DOM + 直接传 props，验证写入上限
// 值从探测回包（memoryLimits prop）一路走到计数器与按钮禁用。由
// tests/amooSecretaryUiContract.test.cjs 用 esbuild 打包后加载（先例：
// amooPanel.harness.tsx）。只挂记忆区，不挂主面板——主面板会拉进
// Icon/lucide 与整条渲染树，而这里要隔离验证的只有上限这一个入参。
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AmooSecretaryMemory, type MemoryLimits } from '../src/renderer/components/amoon/AmooSecretaryMemory'
import type { Capability } from '../src/renderer/components/amoon/amoonShared'

let root: Root | null = null

export function mount(props: { capability: Capability; memoryLimits?: MemoryLimits }): void {
  const host = document.getElementById('root')
  if (!host) throw new Error('缺少 #root 挂载点')
  if (!root) root = createRoot(host)
  root.render(React.createElement(AmooSecretaryMemory, props))
}

export function unmount(): void {
  root?.unmount()
  root = null
}
