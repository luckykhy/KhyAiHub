// Amoo secretary wiring for the host fork-IPC surface: the fire-and-forget
// release plus the RPC ops (probe / ask / result / stop / memory / loop_status)
// share one result type with an op discriminator (same convention as
// sessionGroup). Extracted from host/index.ts so the secretary's incremental
// footprint is attributable to its own module; the shared host file keeps only
// one dispatch hook. The per-op dispatch lives in a flat helper instead of the
// original nested else-if chain — new files are held to the file-ratchet caps
// (maxNesting ≤ 6), which the moved shape would have failed.
//
// The lane instance is injected by host/index.ts instead of imported here:
// this module stays loadable under `node --test` without pulling the lane's
// backend file graph, and the singleton assembly stays in one visible place.

import type { AmooSecretary } from './amooSecretary'

// Subset of the host fork-IPC message shape this wiring reads. Declared
// locally (HostMsg lives unexported in host/index.ts) so the wiring is
// self-contained; the fields mirror the lane call sites verbatim.
type AmooSecretaryMsg = {
  type: string
  id?: string
  prompt?: string
  timeoutMs?: number
  op?: string
  entryId?: string
  text?: string
  verified?: boolean
  provenance?: string
}

const AMOO_SECRETARY_OPS = new Set([
  'amooSecretary.probe',
  'amooSecretary.ask',
  'amooSecretary.result',
  'amooSecretary.stop',
  'amooSecretary.memory',
  'amooSecretary.loop_status',
])

async function dispatchAmooSecretaryOp(
  lane: AmooSecretary,
  op: string,
  msg: AmooSecretaryMsg,
): Promise<Record<string, unknown>> {
  if (op === 'probe') {
    // 顶层平铺，不套 probe 字段：渲染层读的就是状态对象本身
    // （assistantAvailable/message/hint），多一层壳会被读成「能力未知」。
    return { ...(await lane.probe()) }
  }
  if (op === 'ask') {
    return { ...(await lane.ask({ prompt: String(msg.prompt ?? ''), timeoutMs: msg.timeoutMs })) }
  }
  if (op === 'result') {
    return { ...(await lane.result()) }
  }
  if (op === 'memory') {
    // 消息体的 op 才是记忆操作的 get/set（type 里的 op 恒为 'memory'）。
    // 条目键叫 entryId 而不是 id：id 在这套 fork IPC 协议里恒为 RPC 关联
    // id（pending 表的键），记忆条目键若也叫 id 会在 spread 时把它顶掉。
    // 五个字段原样透传给车道，取值校验与默认值都在车道内做，这里不做
    // 第二份裁剪——否则两处规则会漂移。
    return {
      ...(await lane.memory(
        msg.op === 'set' ? 'set' : 'get',
        msg.entryId,
        msg.text,
        msg.verified,
        msg.provenance,
      )),
    }
  }
  if (op === 'loop_status') {
    // 手机侧循环的只读快照（桥本地能力，ACCESS_READ）：车道内零状态、
    // 不进台账，start/stop 留在手机端，桌面只呈现手机自报的 running/mode/report。
    return { ...(await lane.loopStatus()) }
  }
  // stop 没有专属判定：六个 op 里最后一个兜底（与原 else 分支同一语义）。
  return { ...(await lane.stop()) }
}

export function createAmooSecretaryIpc(lane: AmooSecretary): {
  handleMessage: (msg: AmooSecretaryMsg) => boolean
} {
  // host fork-IPC send: without process.send (stdin JSON debug mode) the
  // message lands in the log instead of being silently dropped.
  const send = (m: unknown): void => {
    if (process.send) process.send(m)
    else console.log('[host]', JSON.stringify(m))
  }
  return {
    handleMessage(msg: AmooSecretaryMsg): boolean {
      // Amoo 秘书：release 是即发即忘的生命周期收尾（面板卸载/切标签/最后一个
      // 窗口关闭），没有等待方，故不占 id；六个 RPC 操作共用一个 result 类型 +
      // op 字段分档（与 sessionGroup 同一约定）。
      if (msg.type === 'amooSecretary.release') {
        lane.release()
        return true
      }
      if (msg.id && AMOO_SECRETARY_OPS.has(msg.type)) {
        const op = msg.type.slice('amooSecretary.'.length)
        const reply = (payload: Record<string, unknown>) =>
          send({ type: 'amooSecretary.result', id: msg.id, op, ...payload })
        // 二参 then = 原 try/catch 的等价形：车道抛错照旧回流成 ok:false 回包，
        // 绝不静默丢（规则 2.2 的错误消息模板原样保留）。
        void dispatchAmooSecretaryOp(lane, op, msg).then(reply, (error: unknown) => {
          reply({ ok: false, error: `Amoo 秘书车道失败：${String((error as Error)?.message || error)}，请查看导出日志排查 host 状态` })
        })
        return true
      }
      return false
    },
  }
}
