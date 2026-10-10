// 面板的测试替身挂载点：把 WebRemoteControlPanel 装进真 DOM（jsdom）+ 假 __KHYOS__，
// 让测试能真的点击它。由 tests/webRemotePanel.test.cjs 用 esbuild 打包后加载。
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import toastReducer from '../src/renderer/state/toastSlice'
import { WebRemoteControlPanel } from '../src/renderer/components/remote/WebRemoteControlPanel'

export const calls: [string, ...unknown[]][] = []
export const listeners: ((p: Record<string, unknown>) => void)[] = []

let current: Record<string, unknown> = {
  status: 'idle',
  detail: '等待连接。',
  devices: [],
  pending: [],
}

export function setStatus(s: Record<string, unknown>): void {
  current = { ...current, ...s }
}

const api = {
  remoteStart: async (opts?: { lanEnabled?: boolean }) => {
    calls.push(['start', opts])
    setStatus({
      status: 'running',
      detail: '等待手机连接 · http://127.0.0.1:9413/r#p=ABCD1234（配对码 10 分钟后过期）',
      url: 'http://127.0.0.1:9413/r#p=ABCD1234',
      qrDataUrl: 'data:image/png;base64,QUJD',
      port: 9413,
      bindHost: '127.0.0.1',
      pairCode: 'ABCD1234',
      phoneConnected: false,
      devices: [],
      pending: [],
    })
    return { ok: true }
  },
  remoteStop: async () => {
    calls.push(['stop'])
    setStatus({ status: 'idle', detail: '等待连接。', url: null, qrDataUrl: null, devices: [], pending: [] })
    return { ok: true }
  },
  remoteStatus: async () => current,
  remoteRefreshQr: async () => {
    calls.push(['refreshQr'])
    setStatus({ pairCode: 'ZZZZ9999', url: 'http://127.0.0.1:9413/r#p=ZZZZ9999' })
    return { code: 'ZZZZ9999' }
  },
  remoteApprove: async (pairingId: string, role: string) => {
    calls.push(['approve', pairingId, role])
    setStatus({ pending: [] })
    return { ok: true }
  },
  remoteReject: async (pairingId: string) => {
    calls.push(['reject', pairingId])
    setStatus({ pending: [] })
    return { ok: true }
  },
  remoteRevoke: async (deviceId: string) => {
    calls.push(['revoke', deviceId])
    setStatus({ devices: [] })
    return { ok: true }
  },
  remoteProbeBridge: async () => {
    calls.push(['probeBridge'])
    return { found: true, port: 9222, url: 'http://192.168.1.7:9222' }
  },
  onRemoteEvent: (cb: (p: Record<string, unknown>) => void) => {
    listeners.push(cb)
    return () => {
      const i = listeners.indexOf(cb)
      if (i >= 0) listeners.splice(i, 1)
    }
  },
}

;(globalThis as unknown as { __KHYOS__: unknown }).__KHYOS__ = api
if (typeof window !== 'undefined') {
  (window as unknown as { __KHYOS__: unknown }).__KHYOS__ = api
}

export function mount(): void {
  const store = configureStore({ reducer: { toast: toastReducer } })
  const host = document.getElementById('root')
  if (!host) throw new Error('缺少 #root 挂载点')
  createRoot(host).render(
    React.createElement(Provider, { store }, React.createElement(WebRemoteControlPanel)),
  )
}

export function emit(payload: Record<string, unknown>): void {
  listeners.slice().forEach((l) => l(payload))
}
