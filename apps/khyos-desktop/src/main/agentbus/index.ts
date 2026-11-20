/*
 * agentbus/index.ts — the lane's hub: the one place that owns a round, the
 * budget, the stop flag and the ownerless event broadcast. Mirrors the shape of
 * src/main/amoon/index.ts (createAmoonHub) so the desktop's wiring sections stay
 * interchangeable.
 *
 * Honesty rules encoded here rather than left to the panel:
 *   - every reply carries unverified: true. The phone's own session store is the
 *     only record; the desktop never claims to have checked it.
 *   - stop() has exactly ONE tier: the desktop stopped waiting (and asked the
 *     phone to stop, best-effort). The phone may still be executing, so the copy
 *     says to check on the phone and not to resubmit. Precedent:
 *     main/index.ts:876 releaseAmooSecretary also never claims a phone task ended.
 *   - a client-measured response duration is labelled measured
 *     (usage.responseMsSource) and the UI must print the disclosure next to it.
 *   - no local ledger, nothing on disk: history lives in process memory for the
 *     lifetime of the round. Persisting it would need a DATA-LOCATIONS entry
 *     first.
 */

import { createAgentbusClient, type AgentbusClient, type AgentbusClientDeps } from './agentbusClient.ts'
import { runRound, type RoundOutcome, type RoundPhase } from './agentbusRound.ts'
import { resolveAgentbusConfig, type AgentbusConfig } from './agentbusProtocol.ts'
import type { AgentbusStatus } from './agentbusTransport.ts'

export type AgentbusLaneState =
  | 'idle'
  | 'opening'
  | 'sending'
  | 'waiting'
  | 'reading'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'budget_exhausted'

export type AgentbusEvent =
  | { type: 'phase'; jobId: string; phase: RoundPhase }
  | { type: 'state'; jobId: string; state: AgentbusLaneState; round?: RoundOutcome }

export type AgentbusAskInput = { prompt: string; budgetMs?: number }

export type AgentbusAskResult =
  | { ok: true; jobId: string; budgetMs: number; unverified: true }
  | { ok: false; error: { code: string; message: string } }

export type AgentbusRoundResult = {
  state: AgentbusLaneState
  elapsedMs: number
  budgetMs: number
  round?: RoundOutcome
  reply?: string | null
  replyTruncated?: boolean
  usage?: RoundOutcome['usage']
  sessionKey?: string
  runId?: string
  note?: string | null
  stopReason?: string | null
  error?: { code: string; message: string } | null
  unverified: true
}

export type AgentbusHubDeps = {
  env?: NodeJS.ProcessEnv
  client?: AgentbusClient
  /** Extra deps forwarded to createAgentbusClient when no client is injected. */
  clientDeps?: AgentbusClientDeps
  send?: (event: AgentbusEvent) => void
  now?: () => number
  logger?: (line: string) => void
}

/** Stop copy has exactly one tier — see the header. */
const STOP_MESSAGE = '已停止桌面等待；手机可能仍在执行，请在手机上核对，勿直接重复提交'
const PROMPT_MAX = 20000

type RunningJob = { jobId: string; prompt: string; budgetMs: number; startedAt: number }

export function createAgentbusHub(deps: AgentbusHubDeps = {}) {
  const config: AgentbusConfig = deps.env ? resolveAgentbusConfig(deps.env) : resolveAgentbusConfig()
  const now = deps.now || (() => Date.now())
  const log = deps.logger || (() => {})

  const client: AgentbusClient =
    deps.client ||
    createAgentbusClient({
      config,
      logger: log,
      now,
      ...(deps.clientDeps || {}),
    })

  let job: RunningJob | null = null
  let phase: RoundPhase = 'waiting'
  let stopRequested = false
  let outcome: RoundOutcome | null = null
  const listeners = new Set<(event: AgentbusEvent) => void>()

  function broadcast(event: AgentbusEvent): void {
    if (deps.send) deps.send(event)
    for (const listener of listeners) listener(event)
  }

  async function status(): Promise<AgentbusStatus> {
    return client.status()
  }

  function result(): AgentbusRoundResult {
    if (!job) return { state: 'idle', elapsedMs: 0, budgetMs: config.round.budgetMs, unverified: true }
    const base: AgentbusRoundResult = {
      state: outcome ? outcome.state : phase,
      elapsedMs: outcome ? outcome.elapsedMs : now() - job.startedAt,
      budgetMs: job.budgetMs,
      unverified: true,
    }
    if (!outcome) return base
    return {
      ...base,
      round: outcome,
      reply: outcome.reply,
      replyTruncated: outcome.replyTruncated,
      usage: outcome.usage,
      sessionKey: outcome.sessionKey,
      runId: outcome.runId,
      note: outcome.note,
      stopReason: outcome.stopReason,
      error: outcome.error,
    }
  }

  function ask(input: AgentbusAskInput): AgentbusAskResult {
    const prompt = String(input?.prompt ?? '')
    if (!prompt.trim()) {
      return { ok: false, error: { code: 'empty_prompt', message: '请输入要发给手机的内容' } }
    }
    if (prompt.length > PROMPT_MAX) {
      return { ok: false, error: { code: 'prompt_too_long', message: `输入超过 ${PROMPT_MAX} 字：请分批发送` } }
    }
    // A second ask while a round is live would spend the user's phone quota twice
    // for one visible turn; refuse it instead of queueing it silently.
    if (job && !outcome) {
      return { ok: false, error: { code: 'already_running', message: '已有一轮正在进行：请等它结束或先中止' } }
    }
    const budgetMs =
      typeof input?.budgetMs === 'number' && Number.isFinite(input.budgetMs) && input.budgetMs > 0
        ? Math.floor(input.budgetMs)
        : config.round.budgetMs
    const startedAt = now()
    const next: RunningJob = {
      jobId: `agb_${startedAt.toString(36)}_${client.newRequestId().slice(-8)}`,
      prompt,
      budgetMs,
      startedAt,
    }
    job = next
    phase = 'waiting'
    outcome = null
    stopRequested = false
    // Ask returns immediately: a phone turn takes minutes and the IPC caller must
    // not be held for it. Progress arrives on the ownerless event channel.
    void runJob(next)
    return { ok: true, jobId: next.jobId, budgetMs, unverified: true }
  }

  async function runJob(current: RunningJob): Promise<void> {
    const hooks = {
      onPhase: (next: RoundPhase) => {
        phase = next
        broadcast({ type: 'phase', jobId: current.jobId, phase: next })
      },
      shouldStop: () => stopRequested,
      now,
      sleep: (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, ms))
          if (typeof timer.unref === 'function') timer.unref()
        }),
    }
    let final: RoundOutcome
    try {
      final = await runRound(client, { jobId: current.jobId, prompt: current.prompt, budgetMs: current.budgetMs }, hooks)
    } catch (err) {
      final = {
        state: 'failed',
        sessionKey: '',
        runId: '',
        reply: null,
        replyTruncated: false,
        usage: null,
        partial: false,
        stopReason: null,
        error: { code: 'internal_error', message: String((err as Error)?.message || err) },
        note: null,
        elapsedMs: now() - current.startedAt,
      }
    }
    // The round owns the abort for both the stopped and the budget tier; the hub
    // only closes the connection once the round is over.
    client.close()
    outcome = final
    broadcast({ type: 'state', jobId: current.jobId, state: final.state, round: final })
  }

  function stop(): { ok: true; message: string; unverified: true } {
    stopRequested = true
    return { ok: true, message: STOP_MESSAGE, unverified: true }
  }

  function onEvent(cb: (event: AgentbusEvent) => void): () => void {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  }

  return { config, status, ask, result, stop, onEvent }
}

export type AgentbusHub = ReturnType<typeof createAgentbusHub>
