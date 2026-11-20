// 「电脑端 AI」preload API 片段：四条 invoke 通道 + 一条无主事件订阅。通道名与
// main 侧 agentbusBridge 的注册一一配对。从 preload/index.ts 整块搬来，让这条
// 车道的接线增量可归因到自己的模块；index.ts 只留一次 spread。

import type { IpcRenderer } from 'electron'

export function createAgentbusApi(ipcRenderer: IpcRenderer) {
  return {
    // 探测：一次 adb devices + 一次 observe 握手（不唤醒、不延长手机任务窗口）。
    // 不随轮次发生，只随面板挂载与手动刷新发生。
    agentbusStatus: () => ipcRenderer.invoke('agentbus:status'),
    // 问一句：立即回 {ok,jobId,budgetMs}，进度走事件通道（手机一想以分钟计，
    // invoke 不该被按住那么久）。
    agentbusAsk: (input: { prompt: string; budgetMs?: number }) => ipcRenderer.invoke('agentbus:ask', input),
    // 拉一次车道结果：相位 / 回复 / 用量 / 失败原因。恒定带 unverified: true。
    agentbusResult: () => ipcRenderer.invoke('agentbus:result'),
    // 中止失败必须让调用方看见：一个不抛错的 {ok:false} 会被面板读成中止成功
    // （amooSecretary.ts preload 先例，同一个不许有的谎）。
    agentbusStop: async () => {
      const r = (await ipcRenderer.invoke('agentbus:stop')) as { ok?: boolean; message?: string }
      if (r && r.ok === false) throw new Error(r.message || '中止未被接受')
      return r
    },
    // 事件是无主广播：job 生命周期比 ask RPC 长，车道不按窗口寻址，渲染层只接受
    // 当前 jobId 的事件。退订只移除监听——车道不代停手机任务（窗口全关也不收起
    // 进行中的轮次，socket 与 forward 端口保留到终态或预算用尽）。
    onAgentbusEvent: (cb: (payload: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown) => cb(payload)
      ipcRenderer.on('agentbus:event', listener)
      return () => ipcRenderer.removeListener('agentbus:event', listener)
    },
  }
}
