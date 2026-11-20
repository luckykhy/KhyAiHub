// 会话续写的纯函数面：host 的 AI 回合既要喂给模型，也要写回 .khy/sessions。
// 两者需求不同——模型只认 role/content，落盘要保留原有消息对象（uuid/parentUuid
// 链），所以拆成两个投影，避免「为了喂模型把历史洗掉、再把洗掉的历史存回去」。

export type ContinuationMessage = { role: 'user' | 'assistant'; content: unknown }

export function toContinuationMessages(prior: unknown): ContinuationMessage[] {
  if (!Array.isArray(prior)) return []
  const out: ContinuationMessage[] = []
  for (const item of prior) {
    if (!item || typeof item !== 'object') continue
    const m = item as { role?: unknown; content?: unknown }
    if ((m.role === 'user' || m.role === 'assistant') && m.content !== undefined) {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

export function appendTurn(prior: unknown, prompt: string, reply: string): unknown[] {
  const base = Array.isArray(prior) ? prior.slice() : []
  base.push({ role: 'user', content: prompt })
  base.push({ role: 'assistant', content: reply })
  return base
}

// 会话列表只显示标题；首轮用户话是最容易被认出来的标签，超过一行就没有信息量。
export function titleForPrompt(prompt: string, max = 40): string {
  const oneLine = String(prompt || '').replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

export type PersistState = {
  messages: unknown[]
  model?: string
  metadata?: { cwd?: string; projectDir?: string; source?: { type: string; id?: string } }
  title?: string
  createdAt?: number
}

/**
 * 组装 persistSession 的入参。title / createdAt 必须显式带回：persistSession
 * 每轮整份重写 JSON 快照，缺省会把续写会话的标题清成空串、创建时间刷成「此刻」。
 */
export function composePersistState(input: {
  prior: unknown
  prompt: string
  reply: string
  sessionId: string
  title?: string
  createdAt?: number
  model?: string
  cwd: string
  source: { type: string; id: string }
}): PersistState {
  return {
    messages: input.reply
      ? appendTurn(input.prior, input.prompt, input.reply)
      : [...(Array.isArray(input.prior) ? input.prior : []), { role: 'user', content: input.prompt }],
    model: input.model || '',
    metadata: { cwd: input.cwd, source: input.source },
    title: input.title || (input.sessionId ? '' : titleForPrompt(input.prompt)),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  }
}
