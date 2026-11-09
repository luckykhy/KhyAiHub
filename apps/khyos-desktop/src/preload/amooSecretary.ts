// 「Amoo 秘书」preload API 片段：桌面端问 Amoo 一句 + 中止 + 共享记忆 + 循环
// 状态。通道名与 main 侧 amooSecretaryBridge 的注册一一配对。从 preload/index.ts
// 整块搬来，让秘书的接线增量可归因到自己的模块；index.ts 只留一次 spread。

import type { IpcRenderer } from 'electron'

export function createAmooSecretaryApi(ipcRenderer: IpcRenderer) {
  return {
    // ── Amoo 秘书（桌面端问 Amoo 一句 + 中止 + 共享记忆）：通道名与 main 的 amooSecretary:* 配对 ──
    // 渲染层叫 status（秘书面板的词汇），host 车道叫 probe（phoneBridgeClient.probe
    // 的词汇）——同一个探测，两个名字各随其消费者。
    amooSecretaryStatus: () => ipcRenderer.invoke('amooSecretary:status'),
    amooSecretaryAsk: (input: { prompt: string; timeoutMs?: number }) => ipcRenderer.invoke('amooSecretary:ask', input),
    amooSecretaryResult: () => ipcRenderer.invoke('amooSecretary:result'),
    // 中止失败必须让调用方看见：面板用 try/catch 区分「已中止」与「没中止成功」，
    // 一个不抛错的 {ok:false} 会被它读成中止成功——那正是本功能最不该有的谎。
    amooSecretaryStop: async () => {
      const r = (await ipcRenderer.invoke('amooSecretary:stop')) as { ok?: boolean; error?: { message?: string } }
      if (r && r.ok === false) throw new Error(r.error?.message || '中止未被桥接受')
      return r
    },
    // 只停车道的轮询，不动手机侧任务：面板卸载/切标签时调用（事件寻址是无主的，
    // 没有这一下，没有人看的进度会继续每 5s 拉一次手机）。
    amooSecretaryStopPolling: () => ipcRenderer.invoke('amooSecretary:stopPolling'),
    // 手机侧循环状态：只读快照（桥本地 loop_status，ACCESS_READ）。running/mode/
    // report 都是手机自报，渲染层只呈现不判断；启停循环在手机端，桌面不代管。
    amooSecretaryLoopStatus: () => ipcRenderer.invoke('amooSecretary:loopStatus'),
    // 共享记忆：唯一持有者在手机（/sdcard/bridge-amoobridge/amoo_memory.json），
    // 这里只调不存——桌面不落第二份记忆文件，也不缓存 get 的结果。
    amooSecretaryMemory: (input: { op: 'get' | 'set'; id?: string; text?: string; verified?: boolean; provenance?: string }) =>
      ipcRenderer.invoke('amooSecretary:memory', input),
    // 轮询事件是无主广播（job 生命周期比 ask RPC 长，main 不按窗口寻址），每个
    // 事件带 jobId，渲染层只接受当前 job 的。退订即告知主进程停轮询：amoo 标签
    // 页切走会卸载面板（SidePane 条件渲染），没人看进度时车道不该继续每 5s 拉
    // 一次手机。
    onAmooSecretaryEvent: (cb: (payload: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown) => cb(payload)
      ipcRenderer.on('amooSecretary:event', listener)
      return () => {
        ipcRenderer.removeListener('amooSecretary:event', listener)
        ipcRenderer.send('amooSecretary:release')
      }
    },
  }
}
