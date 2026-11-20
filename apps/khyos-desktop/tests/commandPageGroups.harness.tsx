// ListSettingsPage 命令页分组的 jsdom 挂载点：真 DOM + 假 __KHYOS__.agentList，
// 让测试能验证只有挂载后才存在的行为 —— 组头顺序与计数、默认全折叠、搜索并集
// 语义与强制展开、四 kind 走平铺分支。由 tests/commandPageGroups.test.cjs 用
// esbuild 打包后加载（先例 tests/agentbusPanel.harness.tsx / toolExecutionPlacement.harness.tsx）。
//
// 分组/过滤逻辑不复制进本文件：挂的就是真组件，测的就是真代码路径 —— 复制一份
// 就成了影子副本，组件改了测试还以为自己绿。
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ListSettingsPage } from '../src/renderer/components/settings/ListSettingsPage'

type Loose = Record<string, unknown>

export const calls: string[] = []

let listReply: Loose = { ok: true, items: [], groups: [] }

export function setList(r: Loose): void {
  listReply = r
}

const api = {
  agentList: async (kind: string) => {
    calls.push(kind)
    return listReply
  },
  agentCreate: async () => ({ ok: false, error: 'harness：不创建' }),
  agentSetEnabled: async () => ({ ok: true }),
  agentDelete: async () => ({ ok: true }),
  agentImport: async () => ({ ok: true, created: 0, skipped: 0 }),
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
  root.render(React.createElement(ListSettingsPage, props))
}

export function unmount(): void {
  root?.unmount()
  root = null
}
