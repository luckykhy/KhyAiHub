/*
 * agentbusRound.ts — one round of the lane: open, send, wait for the turn to
 * end, read the history back. Orchestration only; every byte-level decision is
 * already made in the client, and every meaning-level decision in the protocol
 * modules.
 *
 * Two rules this file exists to keep straight:
 *   1. The reconnect-and-resend lives inside client.call() only. On the event
 *      path an EOF fails the round — the reference's poll_stream_events also
 *      just marks the stream tainted on EOF (amoo.rs:1475-1477) and never
 *      replays from there. Waiting for a phone turn is exactly the situation
 *      where a replay would double-charge the user's quota.
 *   2. The reply is chosen by selectReplyText (documented there), and a
 *      truncated reply is disclosed from the message row's OWN flag — never
 *      inferred from text length.
 */

import {
  chatHistoryParams,
  chatSendParams,
  chatSendReceipt,
  historyHasMore,
  isRoundFinished,
  parseHistoryMessages,
  roundUsage,
  selectReplyText,
  sessionsResetParams,
  stepclawScreenOff,
  withObservedResponseMs,
  type MessageUsage,
} from './agentbusProtocol.ts'
import type { AgentbusClient } from './agentbusClient.ts'

export type RoundPhase = 'opening' | 'sending' | 'waiting' | 'reading'

export type RoundJob = {
  jobId: string
  prompt: string
  budgetMs: number
}

export type RoundOutcome = {
  state: 'done' | 'failed' | 'stopped' | 'budget_exhausted'
  sessionKey: string
  runId: string
  reply: string | null
  replyTruncated: boolean
  usage: MessageUsage | null
  /** True when chat.history reported more pages than the one we read. */
  partial: boolean
  stopReason: string | null
  error: { code: string; message: string } | null
  note: string | null
  elapsedMs: number
}

export type RoundHooks = {
  onPhase: (phase: RoundPhase) => void
  /** Set by the hub when the user asked to stop. */
  shouldStop: () => boolean
  now: () => number
  sleep: (ms: number) => Promise<void>
}

type WaitResult =
  | { kind: 'terminal' }
  | { kind: 'budget' }
  | { kind: 'stopped' }
  | { kind: 'stream_lost' }

/** Fresh session key per round; the reference never resets an existing key (amoo.rs:1753-1754). */
function newSessionKey(client: AgentbusClient): string {
  return `agent:main:desktop-${client.newRequestId().replace(/^[a-z]+-/, '')}`
}

/** open + sessions.reset. A cold-stream failure here fails the round outright. */
async function openRound(
  client: AgentbusClient,
  hooks: RoundHooks,
): Promise<{ ok: true; sessionKey: string } | { ok: false; code: string; message: string }> {
  hooks.onPhase('opening')
  const opened = await client.open()
  if (!opened.ok) return opened
  const sessionKey = newSessionKey(client)
  // Per-method budget, not the handshake budget: the reference spends its full
  // REQUEST_TIMEOUT on sessions.reset (amoo.rs:1755 -> amoo.rs:1156).
  const reset = await client.call(
    'sessions.reset',
    sessionsResetParams(sessionKey),
    client.config.round.sessionsResetMs,
  )
  if (!reset.ok) return { ok: false, code: reset.code, message: reset.message }
  return { ok: true, sessionKey }
}

/** chat.send + receipt validation. The runId the phone echoes back wins over ours. */
async function sendTurn(
  client: AgentbusClient,
  sessionKey: string,
  prompt: string,
  hooks: RoundHooks,
): Promise<{ ok: true; runId: string } | { ok: false; code: string; message: string }> {
  hooks.onPhase('sending')
  const runId = client.newRequestId()
  // chat.send gets its own budget (default 45s, the reference's REQUEST_TIMEOUT).
  // It used to share bus.handshakeMs (3s), which is a loopback round trip and far
  // too short for the call that spends the user's phone quota.
  const sent = await client.call(
    'chat.send',
    chatSendParams({ sessionId: sessionKey, text: prompt, runId }),
    client.config.round.chatSendMs,
  )
  if (!sent.ok) return { ok: false, code: sent.code, message: sent.message }
  const receipt = chatSendReceipt(sent.payload, runId)
  if (!receipt.ok) return { ok: false, code: receipt.code, message: receipt.message }
  return { ok: true, runId: receipt.runId }
}

/** Watch the event stream until this round's turn reports itself finished. */
async function awaitTerminal(
  client: AgentbusClient,
  sessionKey: string,
  runId: string,
  budgetMs: number,
  hooks: RoundHooks,
  notes: string[],
): Promise<WaitResult> {
  hooks.onPhase('waiting')
  const deadline = hooks.now() + budgetMs
  for (;;) {
    if (hooks.shouldStop()) return { kind: 'stopped' }
    const remaining = deadline - hooks.now()
    if (remaining <= 0) return { kind: 'budget' }
    const event = await client.nextEvent(Math.min(client.config.round.pollIntervalMs, remaining))
    if (event.kind === 'eof') return { kind: 'stream_lost' }
    if (event.kind === 'status') {
      if (stepclawScreenOff(event.status)) {
        // Not a failure: the phone may simply not answer while the screen is off.
        notes.push('手机端上报熄屏：这一轮可能迟迟没有响应，手机可能仍在执行')
      }
      continue
    }
    if (event.kind === 'delta') {
      // Another session's event is not this round's; dropping it is what stops a
      // cross-session reply from being drawn into the wrong turn.
      if (event.delta.sessionKey !== sessionKey) continue
      if (event.delta.finished) return { kind: 'terminal' }
      if (event.delta.runId && event.delta.runId !== runId) continue
    }
    await hooks.sleep(0)
  }
}

/** chat.history for this round's session, plus the reply/usage read off it. */
async function loadRoundHistory(
  client: AgentbusClient,
  sessionKey: string,
  runId: string,
  startedAt: number,
  hooks: RoundHooks,
  notes: string[],
): Promise<
  | {
      ok: true
      reply: string | null
      replyTruncated: boolean
      stopReason: string
      usage: MessageUsage | null
      partial: boolean
      finished: boolean
    }
  | { ok: false; code: string; message: string }
> {
  hooks.onPhase('reading')
  // chat.history reads one page back; it gets its own budget (default 45s, the
  // reference's REQUEST_TIMEOUT) rather than the handshake budget it used to share.
  const history = await client.call(
    'chat.history',
    chatHistoryParams(sessionKey, client.config.round.historyLimit),
    client.config.round.chatHistoryMs,
  )
  if (!history.ok) return { ok: false, code: history.code, message: history.message }
  const messages = parseHistoryMessages((history.payload as { messages?: unknown }).messages)
  const partial = historyHasMore(history.payload)
  if (partial) {
    // One page of 100 rows is what the reference asks for too; when the phone
    // reports more, the usage below is not the whole session's.
    notes.push('会话历史还有更多页：这里的用量只覆盖已取回的那一页')
  }
  const session = { key: sessionKey, messages }
  const picked = selectReplyText({ sessionKey, runId }, session)
  const usage = roundUsage(messages)
  // A client-measured duration is only filled in when the service reported none
  // AND there are output tokens to divide; the UI labels it as measured.
  const elapsedMs = Math.max(1, hooks.now() - startedAt)
  const withMeasured = usage.output_tokens !== null && usage.response_ms === null ? withObservedResponseMs(usage, elapsedMs) : usage
  return {
    ok: true,
    reply: picked ? picked.text : null,
    replyTruncated: picked ? picked.truncated : false,
    stopReason: picked ? picked.stopReason : '',
    usage: withMeasured,
    partial,
    finished: isRoundFinished({ sessionKey, runId }, session),
  }
}

/**
 * Run one round end to end. Never throws: every failure comes back as an outcome
 * with a classified code, because the panel has to render it either way.
 */
export async function runRound(client: AgentbusClient, job: RoundJob, hooks: RoundHooks): Promise<RoundOutcome> {
  const notes: string[] = []
  const roundStartedAt = hooks.now()
  const base = {
    sessionKey: '',
    runId: '',
    reply: null as string | null,
    replyTruncated: false,
    usage: null as MessageUsage | null,
    partial: false,
    stopReason: null as string | null,
    error: null as { code: string; message: string } | null,
    note: null as string | null,
    elapsedMs: 0,
  }
  const fail = (code: string, message: string): RoundOutcome => ({
    ...base,
    state: 'failed',
    error: { code, message },
    note: notes.length > 0 ? notes.join('；') : null,
    elapsedMs: hooks.now() - roundStartedAt,
  })

  const opened = await openRound(client, hooks)
  if (!opened.ok) return fail(opened.code, opened.message)
  base.sessionKey = opened.sessionKey

  const sent = await sendTurn(client, opened.sessionKey, job.prompt, hooks)
  if (!sent.ok) return fail(sent.code, sent.message)
  base.runId = sent.runId

  const waited = await awaitTerminal(client, opened.sessionKey, sent.runId, job.budgetMs, hooks, notes)
  if (waited.kind === 'stopped' || waited.kind === 'budget') {
    // Both tiers ask the phone to stop, best-effort: the desktop cannot confirm
    // the phone obeyed, which is exactly what the stop copy discloses.
    await client.abort(opened.sessionKey, sent.runId)
    return {
      ...base,
      state: waited.kind === 'stopped' ? 'stopped' : 'budget_exhausted',
      note: notes.length > 0 ? notes.join('；') : null,
      elapsedMs: hooks.now() - roundStartedAt,
    }
  }
  if (waited.kind === 'stream_lost') {
    return fail('stream_lost', '与手机的连接中断：这一轮的状态无法确认')
  }

  const loaded = await loadRoundHistory(client, opened.sessionKey, sent.runId, roundStartedAt, hooks, notes)
  if (!loaded.ok) return fail(loaded.code, loaded.message)
  if (!loaded.finished) {
    // The event said finished but the history disagrees: report what we have and
    // say so, rather than claiming a reply the history does not back.
    notes.push('事件已报结束，但会话历史里本轮尚未落定：以下内容可能不完整')
  }
  if (loaded.stopReason) base.stopReason = loaded.stopReason
  return {
    ...base,
    state: 'done',
    reply: loaded.reply,
    replyTruncated: loaded.replyTruncated,
    usage: loaded.usage,
    partial: loaded.partial,
    note: notes.length > 0 ? notes.join('；') : null,
    elapsedMs: hooks.now() - roundStartedAt,
  }
}
