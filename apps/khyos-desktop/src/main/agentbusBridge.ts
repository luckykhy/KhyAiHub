/*
 * agentbusBridge.ts — renderer-facing channels for the「电脑端 AI」lane, plus the
 * ownerless event broadcast. Extracted from main/index.ts the same way
 * amooSecretaryBridge.ts was, so the lane's footprint in main/index.ts is a
 * single import plus a single install call.
 *
 * Idempotent on purpose: createWindow registers these channels on every window
 * (main/index.ts:2221/:2241 call it again for a second window), and Electron
 * throws when a channel is registered twice. Every handler is therefore removed
 * before it is registered — removeHandler on a channel that was never registered
 * is a no-op in Electron 44, so the first call is safe too. The event fan-out is
 * subscribed once per hub for the same reason.
 *
 * The hub is a process-level singleton (created once in main/index.ts next to
 * amoonHub): a round outlives any single window, so the channels must not be
 * bound to a window's lifetime.
 */

import { createRequire } from 'node:module'
import type { IpcMain } from 'electron'

const nodeRequire = createRequire(import.meta.url)

export type AgentbusWindowLike = {
  isDestroyed: () => boolean
  webContents: { send: (channel: string, payload: unknown) => void }
}

export type AgentbusBridgeDeps = {
  ipc: IpcMain
  hub: {
    status: () => Promise<unknown>
    ask: (input: { prompt: string; budgetMs?: number }) => unknown
    result: () => unknown
    stop: () => unknown
    onEvent: (cb: (event: unknown) => void) => () => void
  }
  /** Injected in tests so no electron require happens at all. */
  getAllWindows?: () => AgentbusWindowLike[]
}

const CHANNEL_STATUS = 'agentbus:status'
const CHANNEL_ASK = 'agentbus:ask'
const CHANNEL_RESULT = 'agentbus:result'
const CHANNEL_STOP = 'agentbus:stop'
const CHANNEL_EVENT = 'agentbus:event'

const HANDLED_CHANNELS = [CHANNEL_STATUS, CHANNEL_ASK, CHANNEL_RESULT, CHANNEL_STOP]

/** Hubs already wired to the event fan-out; a second install must not double it. */
const subscribedHubs = new WeakSet<object>()

export function installAgentbusBridge(deps: AgentbusBridgeDeps): void {
  const { ipc, hub } = deps
  // Re-registration guard: a second createWindow must not throw on an
  // already-registered channel.
  for (const channel of HANDLED_CHANNELS) {
    ipc.removeHandler(channel)
  }
  ipc.handle(CHANNEL_STATUS, () => hub.status())
  ipc.handle(CHANNEL_ASK, (_e, input?: { prompt?: unknown; budgetMs?: unknown }) =>
    hub.ask({
      prompt: String(input?.prompt ?? ''),
      ...(typeof input?.budgetMs === 'number' ? { budgetMs: input.budgetMs } : {}),
    }),
  )
  ipc.handle(CHANNEL_RESULT, () => hub.result())
  ipc.handle(CHANNEL_STOP, () => hub.stop())

  if (subscribedHubs.has(hub)) return
  subscribedHubs.add(hub)
  // Ownerless broadcast, same shape as amooSecretaryBridge's event fan-out: a
  // round's lifetime is longer than the ask RPC that started it, so the events
  // cannot be addressed to a pending caller. The renderer filters by jobId.
  const getAllWindows =
    deps.getAllWindows ||
    (() => {
      // electron is resolved lazily (same createRequire pattern as
      // amooSecretaryBridge.ts:130): tests import this module under plain node,
      // where the electron specifier is a bare path stub and a static import
      // would fail the whole file at link time.
      const { BrowserWindow } = nodeRequire('electron') as typeof import('electron')
      return BrowserWindow.getAllWindows() as unknown as AgentbusWindowLike[]
    })
  hub.onEvent((event) => {
    for (const win of getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(CHANNEL_EVENT, event)
    }
  })
}

export const AGENTBUS_CHANNELS = {
  status: CHANNEL_STATUS,
  ask: CHANNEL_ASK,
  result: CHANNEL_RESULT,
  stop: CHANNEL_STOP,
  event: CHANNEL_EVENT,
}
