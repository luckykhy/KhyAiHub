// CommandCenter（Ctrl+K 面板）的 jsdom 挂载点：真 DOM + 假 __KHYOS__.slashList/slashRun，
// 让测试能验证只有挂载后才存在的行为 —— khy 行按载荷目录归堆、组头序（静态四组在前
// + 目录序 + 目录外键补后）、跨组 data-index 连续、搜组名带整组、非 routed 行不进面板。
// 由 tests/commandCenterGroups.test.cjs 用 esbuild 打包后加载（先例
// tests/commandPageGroups.harness.tsx / tests/agentbusPanel.harness.tsx）。
//
// 分组/过滤逻辑不复制进本文件：挂的就是真组件，测的就是真代码路径 —— 复制一份
// 就成了影子副本，组件改了测试还以为自己绿。
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CommandCenter } from '../src/renderer/components/message/CommandCenter'

type Loose = Record<string, unknown>

let listReply: Loose = { ok: true, commands: [], groups: [] }

export function setList(r: Loose): void {
  listReply = r
}

const api = {
  slashList: async () => listReply,
  slashRun: async () => ({ ok: true, action: 'output', output: '' }),
}

;(globalThis as unknown as { __KHYOS__: unknown }).__KHYOS__ = api
if (typeof window !== 'undefined') {
  (window as unknown as { __KHYOS__: unknown }).__KHYOS__ = api
}

let root: Root | null = null

export function mount(props: Record<string, unknown>): void {
  const host = document.getElementById('root')
  if (!host) throw new Error('缺少 #root 挂载点')
  root = createRoot(host)
  root.render(React.createElement(CommandCenter, props))
}

export function unmount(): void {
  root?.unmount()
  root = null
}
