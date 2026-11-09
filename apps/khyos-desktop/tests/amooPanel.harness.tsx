// AmoonPane 的 jsdom 挂载点：真 DOM + 假 __KHYOS__，让测试能点击面板。
// 由 tests/amooPanel.test.cjs 用 esbuild 打包后加载。
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AmoonPane } from '../src/renderer/components/amoon/AmoonPane'

type Loose = Record<string, unknown>

export const calls: [string, ...unknown[]][] = []

function runningStatus(): Loose {
  return {
    ok: true,
    phase: 'running',
    message: '桥接在运行（127.0.0.1:18765，pid 4321）',
    hint: '发送只会把消息投递到手机 outbox 或启动 amoo 分享页；送达与回执都不可验证。',
    stateDir: 'C:\\Users\\u\\AppData\\Local\\khy-amoon-bridge',
    stateDirExists: true,
    token: { present: true, valid: true, length: 47 },
    runtime: { present: true, pid: 4321, port: 18765, malformed: false },
    health: true,
    bridge: { root: 'D:\\repo\\delivery\\extension\\bridges\\khy-amoon-bridge', cliFound: true },
    daemon: {
      protocol: 'khy-amoon/1',
      port: 18765,
      state: 'RUNNING',
      adbOk: true,
      lastPoll: '2026-10-22T10:00:00.000Z',
      lastError: null,
      auth: { present: true, valid: true, length: 47 },
      counters: { requests: 3 },
    },
    canSend: true,
    checkedAt: '2026-10-22T10:00:00.000Z',
    _running: true,
  }
}

let statusReply: Loose = runningStatus()
let sendReply: Loose = {
  ok: true,
  id: 'msg_1',
  state: 'pushed',
  channel: 'file',
  intentSent: false,
  intentError: null,
  openChat: null,
  requiresAck: true,
  verified: false,
  remotePath: '/sdcard/khy-amoon-bridge/outbox/msg_1.json',
  pushError: null,
}
let inboxReply: Loose = {
  ok: true,
  messages: [
    { id: 'ack_1', kind: 'ack', text: '收到', ts: '2026-10-22T10:01:00.000Z', status: 'received', unverified: true },
  ],
  count: 1,
  total: 1,
  skipped: 0,
  unverified: true,
}

export function setStatus(s: Loose): void {
  statusReply = s
}
export function setSend(r: Loose): void {
  sendReply = r
}
export function setInbox(r: Loose): void {
  inboxReply = r
}

const api = {
  amoonStatus: async () => {
    calls.push(['status'])
    return statusReply
  },
  amoonSend: async (input: { text: string; openChat?: boolean }) => {
    calls.push(['send', input])
    return sendReply
  },
  amoonInbox: async (limit?: number) => {
    calls.push(['inbox', limit])
    return inboxReply
  },
  amoonStart: async () => {
    calls.push(['start'])
    return { ok: true, message: '启动后仍未就绪：测试桩', status: statusReply }
  },
  amoonStop: async () => {
    calls.push(['stop'])
    return { ok: true, message: '已停止 amoo 桥接', status: statusReply }
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
  root.render(React.createElement(AmoonPane))
}

export function unmount(): void {
  root?.unmount()
  root = null
}

export { runningStatus }
