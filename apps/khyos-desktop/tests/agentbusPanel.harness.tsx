// AgentbusSection 的 jsdom 挂载点：真 DOM + 假 __KHYOS__，让测试能点击面板。
// 由 tests/agentbusPanel.test.cjs 用 esbuild 打包后加载（先例 tests/amooPanel.harness.tsx）。
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AgentbusSection } from '../src/renderer/components/amoon/AgentbusSection'

type Loose = Record<string, unknown>

export const calls: [string, ...unknown[]][] = []

let statusReply: Loose = {
  ok: true,
  code: 'ok',
  message: '已连上手机端 Amoo 后台服务（1.0.0）',
  hint: '',
  serial: 'SERIAL1',
  serialSource: 'agentbus',
  serverVersion: '1.0.0',
  protocol: 3,
}
let resultReply: Loose = { state: 'idle', elapsedMs: 0, budgetMs: 420000, unverified: true }
let askReply: Loose = { ok: true, jobId: 'agb_1', budgetMs: 420000, unverified: true }
let stopReply: Loose = { ok: true, message: '已停止桌面等待；手机可能仍在执行，请在手机上核对，勿直接重复提交', unverified: true }
let settingsReply: Loose = { agentbusSerial: 'SERIAL1' }
let listener: ((payload: unknown) => void) | null = null

export function setStatus(s: Loose): void {
  statusReply = s
}
export function setResult(r: Loose): void {
  resultReply = r
}
export function setAsk(r: Loose): void {
  askReply = r
}
export function setSettingsReply(s: Loose): void {
  settingsReply = s
}
export function emitEvent(payload: Loose): void {
  if (listener) listener(payload)
}

const api = {
  agentbusStatus: async () => {
    calls.push(['status'])
    return statusReply
  },
  agentbusAsk: async (input: { prompt: string; budgetMs?: number }) => {
    calls.push(['ask', input])
    return askReply
  },
  agentbusResult: async () => {
    calls.push(['result'])
    return resultReply
  },
  agentbusStop: async () => {
    calls.push(['stop'])
    return stopReply
  },
  onAgentbusEvent: (cb: (payload: unknown) => void) => {
    listener = cb
    return () => {
      listener = null
    }
  },
  getSettings: async () => {
    calls.push(['getSettings'])
    return settingsReply
  },
  setSetting: async (key: string, value: unknown) => {
    calls.push(['setSetting', key, value])
    return { ok: true }
  },
}

;(globalThis as unknown as { __KHYOS__: unknown }).__KHYOS__ = api
if (typeof window !== 'undefined') {
  (window as unknown as { __KHYOS__: unknown }).__KHYOS__ = api
}

let root: Root | null = null

export function mount(): void {
  const host = document.getElementById('root')
  if (!host) throw new Error('缺少 #root 挂载点')
  root = createRoot(host)
  root.render(React.createElement(AgentbusSection))
}

export function unmount(): void {
  root?.unmount()
  root = null
}
