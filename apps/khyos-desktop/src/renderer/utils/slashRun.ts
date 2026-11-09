// slashRun — khy 斜杠命令在桌面会话里的执行与回填（Composer 与 CommandCenter 共用）。
//
// 回填形态与终端里的「命令回显 + 输出」同构：用户消息放敲入的命令原文，
// assistant 消息放围栏代码块 —— 复用现有消息渲染，不新增消息类型。
// prompt 动作（技能/CC 命令 → 一条 AI 消息）不经这里：它要接 Composer 的 aiSend
// 流式管线（显示文案与实际载荷不同），由 Composer 拿到 prompt 后自己走 sendPrompt。

import { store } from '../state/store'
import { addMessage } from '../state/messageSlice'

export interface SlashRunOutcome {
  ok: boolean
  action?: 'output' | 'prompt'
  output?: string
  prompt?: string
  reason?: string
  error?: string
}

export interface SlashMenuRowPayload {
  id: string
  cmd: string
  label: string
  description: string
  runnable: 'routed' | 'prompt' | 'cc' | 'none'
  source: string
  aliases?: string[]
}

export interface SlashListResult {
  ok: boolean
  commands?: SlashMenuRowPayload[]
  error?: string
}

interface SlashApi {
  slashList?: () => Promise<SlashListResult>
  slashRun?: (cmd: string, args?: string) => Promise<SlashRunOutcome>
}

export function khySlashApi(): SlashApi | undefined {
  return (window as unknown as { __KHYOS__?: SlashApi }).__KHYOS__
}

export async function callSlashList(): Promise<SlashListResult> {
  const api = khySlashApi()
  if (!api?.slashList) {
    return { ok: false, error: 'preload 未注入 __KHYOS__，请重启应用' }
  }
  return api.slashList()
}

export async function callSlashRun(cmd: string, args?: string): Promise<SlashRunOutcome> {
  const api = khySlashApi()
  if (!api?.slashRun) {
    return { ok: false, error: 'preload 未注入 __KHYOS__，请重启应用' }
  }
  return api.slashRun(cmd, args)
}

// 执行 routed 命令并把结果写进当前会话消息流。调用方不再重复 addMessage。
export async function runSlashToSession(cmd: string, args?: string): Promise<SlashRunOutcome> {
  const display = `/${cmd.replace(/^\//, '')}${args ? ` ${args}` : ''}`
  store.dispatch(
    addMessage({
      id: `u_${Date.now()}`,
      role: 'user',
      content: display,
      timestamp: Date.now(),
      status: 'complete',
    })
  )
  const reply = (content: string, status: 'complete' | 'error', error?: string) =>
    store.dispatch(
      addMessage({
        id: `a_${Date.now()}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
        status,
        ...(error ? { error } : {}),
      })
    )
  let res: SlashRunOutcome
  try {
    res = await callSlashRun(cmd, args)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    reply(`命令 ${display} 执行失败：${detail}，请重试或改用终端面板执行 khy`, 'error', detail)
    return { ok: false, error: detail }
  }
  if (res?.ok && res.action === 'prompt') {
    // 调用方（Composer）负责把 prompt 送进 AI 通道；这里已补用户消息，避免双份。
    return res
  }
  if (res?.ok && res.action === 'output') {
    const text = String(res.output || '').trim()
    reply(
      text
        ? `命令 ${display} 执行结果：\n\n\`\`\`\n${text}\n\`\`\``
        : `命令 ${display} 执行完成：无输出`,
      'complete'
    )
    return res
  }
  reply(String(res?.error || `命令 ${display} 执行失败：未知原因，请重试`), 'error', res?.error)
  return res || { ok: false, error: 'empty response' }
}
