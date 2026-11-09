import { createRequire } from 'node:module'
import type { ChildProcess } from 'child_process'
import type { IpcMain } from 'electron'

const nodeRequire = createRequire(import.meta.url)

// Single owner of the amoo secretary reply shape at the main-process IPC
// boundary (amooSecretaryRequest — now in the wiring section below — wraps
// every secretary RPC through normalizeAmooReply before the renderer sees it).
//
// Why this exists: three ok:false shapes used to reach AmooSecretaryPane —
// the lane's nested {error:{code,message}}, the memory verb's top-level
// {code,message}, and flat-string catch-alls (host relay + main-side
// host-down/timeout replies). The pane's errText only read two of them, so an
// infrastructure failure surfaced as the generic 「桥拒绝了这次提问」. The
// renderer's own types already declared the nested shape; normalization at
// this one boundary makes the runtime match the declaration. The lane keeps
// its own wording and failure codes — this module rewrites shapes, never
// meanings, and the lane is not asked to speak the IPC shape too (one owner
// per atomic capability, [DESIGN-ARCH-194] §2.4).

export type AmooSecretaryError = { code: string; message: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function codeOf(rec: Record<string, unknown>): string {
  return typeof rec.code === 'string' && rec.code ? rec.code : 'unknown'
}

/**
 * ok:false replies leave this function in exactly one shape:
 * { ok:false, error:{code,message} }. Anything not ok:false (probe payloads,
 * the result verb's {state,...} reply, ok:true receipts) passes through
 * untouched — the result verb carries no ok field on purpose and must not be
 * pushed into one. Legacy fields (top-level code/message) do not survive next
 * to the nested error, or the next consumer restarts the same two-shape drift
 * this module exists to end.
 */
export function normalizeAmooReply(reply: unknown): unknown {
  const rec = asRecord(reply)
  if (!rec || rec.ok !== false) return reply
  const err = asRecord(rec.error)
  // Already canonical — the lane's classified wording passes through verbatim.
  if (err && typeof err.message === 'string' && err.message) return reply
  const legacy =
    typeof rec.error === 'string' && rec.error
      ? rec.error
      : typeof rec.message === 'string' && rec.message
        ? rec.message
        : null
  if (legacy === null) return reply
  const next: Record<string, unknown> = { ...rec, error: { code: codeOf(rec), message: legacy } }
  delete next.code
  delete next.message
  return next
}

// The two failures amooSecretaryRequest itself answers with (host process
// gone / RPC budget spent). They used to be flat strings — exactly the shape
// the pane's errText could not read — so they are built canonical at the
// source instead of being normalized after the fact. Message wording kept
// from the flat-string era; only the shape changed.
export function hostUnavailableReply(): { ok: false; error: AmooSecretaryError } {
  return { ok: false, error: { code: 'host_unavailable', message: 'host 进程未启动：请重启 KhyOS Desktop 后重试' } }
}

export function secretaryTimeoutReply(): { ok: false; error: AmooSecretaryError } {
  return { ok: false, error: { code: 'rpc_timeout', message: 'Amoo 桥接响应超时：请查看导出日志排查 host 状态' } }
}

// ── Wiring section (extracted from main/index.ts) ──────────────────────────
// Owns the pending table for the secretary RPCs, the ownerless event
// broadcast, and the ipcMain registration block, so the secretary's
// incremental footprint in main/index.ts shrinks to thin hooks. The reply
// normalizers above are the shape contract; this section is the transport —
// they do not call each other, and splitting into two files later costs
// nothing (this file has no history yet).

// host fork handle: the real ChildProcess (null = not started yet). Typed as
// the concrete class rather than a structural subset because send's parameter
// is Serializable, which an unknown-typed callback would not satisfy.
type HostProcessLike = ChildProcess | null

// Pending amooSecretary requests: id → resolver. Only the RPCs land here; the
// polling events are ownerless and broadcast instead (see
// handleAmooSecretaryHostMessage).
const pendingAmooSecretary = new Map<string, { resolve: (v: unknown) => void }>()
// amooSecretary RPC 的超时。probe 要跑 adb（默认 15s）+ 自动探测，ask 的
// HTTP  actuate 预算最坏约 30s 起，都比普通会话请求宽，故不套用 15s 档。
const AMOO_SECRETARY_TIMEOUT_MS = 120000

// host 消息点号 → 渲染层冒号。此前登记在 main/index.ts 的
// HOST_EVENT_TO_RENDERER_CHANNEL 表里，随接线整体搬来本模块；ai.* 家族仍留在
// 那张表——两条通道族各自一个映射点，通道名与事件语义不变。
const AMOO_SECRETARY_EVENT_CHANNEL = 'amooSecretary:event'

// The correlation-id sequence is private to this module: ids live only in the
// pending table (never persisted, never parsed), so sharing main/index.ts's
// global counter vs. this one is not observable.
let amooSeq = 0

// host 消息里的 amooSecretary 两族（result 认领 + event 广播）：命中返回 true，
// 调用方据此 return。result 认领原本在 main/index.ts handleHostMessage 的
// pending 表分支、广播在其后的独立分支——两族消息类型不相交，合成一个入口
// 不改变任何消息的可观察路由；ai.* 与 ready 仍归 main/index.ts 原分支。
export function handleAmooSecretaryHostMessage(m: unknown): boolean {
  const msg = m as { type?: string; id?: string }
  if (msg.type === 'amooSecretary.result' && msg.id) {
    const entry = pendingAmooSecretary.get(msg.id)
    if (entry) {
      pendingAmooSecretary.delete(msg.id)
      entry.resolve(m)
    }
    return true
  }
  // Amoo 秘书轮询事件：**无主事件广播**，先例是 theme:changed 的
  // getAllWindows 循环。不能并进流事件那条分支——ask 是一次性 RPC，它的
  // pending 条目在 ask 返回时就已删除，而轮询/预算耗尽/done 事件在那之后才
  // 到来；照 pendingAi 寻址会取到 undefined，该分支又没有 else 兜底，于是一个
  // 字节都不送（现象：提问有反应、进度条永远停在第 0 轮，而底层链路是好的）。
  // job 生命周期比 RPC 长、面板可关可开、车道是进程级单例，pending 表天然
  // 对不上；渲染层按事件里的 jobId 自行过滤。
  if (msg.type === 'amooSecretary.event') {
    // electron is resolved lazily (same createRequire pattern as
    // main/index.ts's nodeRequire): this module is imported by tests under
    // plain node, where the electron specifier is a bare path stub — a static
    // import would fail the whole file at link time.
    const { BrowserWindow } = nodeRequire('electron') as typeof import('electron')
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(AMOO_SECRETARY_EVENT_CHANNEL, m)
      }
    }
    return true
  }
  return false
}

// 即发即忘的 release（车道停轮询）：最后一个窗口关闭汇到这里；手机侧任务
// 不动——中止是用户显式那一下，这里不代劳。
export function releaseAmooSecretary(host: HostProcessLike): void {
  if (!host?.connected) return
  try {
    host.send({ type: 'amooSecretary.release' })
  } catch {
    /* host 已断开：没有可收尾的车道 */
  }
}

// Register the renderer-facing channels. Same registration point as amoon
// (inside createWindow — re-registered per window, same as before) and same
// send mode (hostProcess.send, CH-2 direct call). The host handle is read
// through getHostProcess on every call: these channels register before
// startHostProcess runs, so a snapshot taken at install time would go stale.
export function installAmooSecretaryBridge(
  ipc: IpcMain,
  getHostProcess: () => HostProcessLike,
): void {
  // 六个 RPC 共用一个 id 前缀与一张 pending 表；轮询事件、release 与
  // stopPolling 都不走这里——事件是无主广播（见 handleAmooSecretaryHostMessage），
  // 后两个只转告车道停轮询（面板卸载/切标签、最后一个窗口关闭），不动手机侧任务。
  const amooSecretaryRequest = (
    op: 'probe' | 'ask' | 'result' | 'stop' | 'memory' | 'loop_status',
    payload: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const host = getHostProcess()
    if (!host || !host.connected) {
      return Promise.resolve(hostUnavailableReply())
    }
    const id = `amoo_sec_${Date.now()}_${++amooSeq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingAmooSecretary.delete(id)
        resolve(secretaryTimeoutReply())
      }, AMOO_SECRETARY_TIMEOUT_MS)
      pendingAmooSecretary.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timer)
          resolve(normalizeAmooReply(v))
        },
      })
      host.send({ type: `amooSecretary.${op}`, id, ...payload })
    })
  }
  // 渲染层的 status 通道对到 host 车道的 probe 操作（两个名字各随其消费者，
  // 见 preload 的同处注释）。
  ipc.handle('amooSecretary:status', () => amooSecretaryRequest('probe'))
  ipc.handle('amooSecretary:ask', (_e, input?: { prompt?: unknown; timeoutMs?: unknown }) =>
    amooSecretaryRequest('ask', {
      prompt: String(input?.prompt ?? ''),
      ...(typeof input?.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
    }),
  )
  ipc.handle('amooSecretary:result', () => amooSecretaryRequest('result'))
  ipc.handle('amooSecretary:stop', () => amooSecretaryRequest('stop'))
  // 手机侧循环状态：只读快照，无载荷。running/mode/report 都由手机自报，
  // main 不加工；桌面不做 loop_start/loop_stop（手机端行为）。
  ipc.handle('amooSecretary:loopStatus', () => amooSecretaryRequest('loop_status'))
  // 停轮询：即发即忘的 host release（与 ipcMain.on 那条同一目的地），但走
  // invoke 好让面板的 await 有个确定的回包；手机侧任务不动。与窗口关闭那条
  // 不同，这里保持原来的无 try/catch 形状：send 抛错要照旧回流成 invoke 拒绝。
  ipc.handle('amooSecretary:stopPolling', () => {
    const host = getHostProcess()
    if (host?.connected) host.send({ type: 'amooSecretary.release' })
    return { ok: true }
  })
  // 共享记忆：渲染层的字段名叫 id（与车道 memory(op,id,…) 签名一致），到 host
  // 消息里改叫 entryId —— id 在 fork IPC 协议里恒为 RPC 关联 id，条目键沿用
  // 这个名字会在 spread 时把关联 id 顶掉（pending 表随之失配）。
  ipc.handle('amooSecretary:memory', (_e, input?: { op?: unknown; id?: unknown; text?: unknown; verified?: unknown; provenance?: unknown }) =>
    amooSecretaryRequest('memory', {
      op: String(input?.op ?? ''),
      ...(typeof input?.id === 'string' ? { entryId: input.id } : {}),
      ...(typeof input?.text === 'string' ? { text: input.text } : {}),
      ...(typeof input?.verified === 'boolean' ? { verified: input.verified } : {}),
      ...(typeof input?.provenance === 'string' ? { provenance: input.provenance } : {}),
    }),
  )
  ipc.on('amooSecretary:release', () => {
    const host = getHostProcess()
    if (host?.connected) host.send({ type: 'amooSecretary.release' })
  })
}
