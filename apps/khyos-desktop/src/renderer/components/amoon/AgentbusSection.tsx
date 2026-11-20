// AgentbusSection — the「电脑端 AI」block at the bottom of the amoo secretary
// pane. Data comes only from window.__KHYOS__.agentbus* (preload → main); this
// component never fetches, never reads files and never sees a token.
//
// Why it is a section and not its own tab: the ask was「在现有 Amoon 面板里加」,
// so it hangs off the secretary pane instead of adding a fifth tile.
//
// Everything this block draws is the phone's own report, re-labelled rather than
// re-interpreted: the reply carries 未验证, a measured duration says so, and a
// truncated reply is disclosed from the message row's own flag.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { Notice } from './amoonShared'

const PROMPT_MAX = 20000
const RUNNING_STATES = ['opening', 'sending', 'waiting', 'reading']

type LaneState =
  | 'idle'
  | 'opening'
  | 'sending'
  | 'waiting'
  | 'reading'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'budget_exhausted'

type LaneUsage = {
  input_tokens: number | null
  output_tokens: number | null
  total_tokens?: number | null
  context_used: number | null
  context_limit: number | null
  tokens_per_second: number | null
  response_ms: number | null
  response_ms_source: 'server' | 'measured' | null
}

type LaneStatus = {
  ok?: boolean
  code?: string
  message?: string
  hint?: string
  serial?: string
  serverVersion?: string
  protocol?: number
}

type LaneResult = {
  state: LaneState
  elapsedMs?: number
  budgetMs?: number
  reply?: string | null
  replyTruncated?: boolean
  usage?: LaneUsage | null
  sessionKey?: string
  runId?: string
  note?: string | null
  error?: { code?: string; message?: string } | null
  unverified?: boolean
}

type AskResult =
  | { ok: true; jobId: string; budgetMs: number; unverified: true }
  | { ok: false; error: { code: string; message: string } }

type AgentbusApi = {
  agentbusStatus: () => Promise<LaneStatus>
  agentbusAsk: (input: { prompt: string; budgetMs?: number }) => Promise<AskResult>
  agentbusResult: () => Promise<LaneResult>
  agentbusStop: () => Promise<{ ok: boolean; message?: string }>
  onAgentbusEvent: (cb: (payload: unknown) => void) => () => void
  // Same injected object as preload/index.ts:19-20; the serial row persists its
  // value through these two instead of asking main for a dedicated channel.
  getSettings: () => Promise<Record<string, unknown>>
  setSetting: (key: string, value: unknown) => Promise<unknown>
}

function api(): AgentbusApi | null {
  return ((window as unknown) as { __KHYOS__?: AgentbusApi }).__KHYOS__ || null
}

function isRunning(state: LaneState | undefined): boolean {
  return !!state && RUNNING_STATES.includes(state)
}

function seconds(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms < 0) return '0s'
  return `${Math.round(ms / 1000)}s`
}

function num(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
}

// ── sub-blocks ───────────────────────────────────────────────────────────────

function StatusLine({ status, probing }: { status: LaneStatus | null; probing: boolean }) {
  if (probing) return <p className="text-[11px] text-foreground-muted">正在读取手机连接状态…</p>
  if (!status) return <Notice tone="amber">读不到车道状态：请重启桌面端后重试。</Notice>
  return (
    <div className="space-y-1">
      <p className="text-xs text-foreground/80">{status.message || '状态未知'}</p>
      {status.hint ? <p className="text-[11px] text-foreground-muted">下一步：{status.hint}</p> : null}
    </div>
  )
}

function ProgressLine({ lane }: { lane: LaneResult }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-foreground-muted">
        {`已等 ${seconds(lane.elapsedMs)} / 上限 ${seconds(lane.budgetMs)}`}
      </p>
      <p className="text-[11px] text-foreground-muted">手机熄屏时这一轮可能迟迟没有响应；手机可能仍在执行。</p>
      {lane.note ? <p className="text-[11px] text-amber-200">{lane.note}</p> : null}
    </div>
  )
}

function ReplyBlock({ lane }: { lane: LaneResult }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground-muted">未验证</span>
        <span className="text-[11px] text-foreground-muted">回复未经桌面校验</span>
      </div>
      <p className="whitespace-pre-wrap text-xs text-foreground/90">{lane.reply || '（本轮没有取回文本）'}</p>
      {lane.replyTruncated ? <p className="text-[11px] text-amber-200">回复可能被截断：完整文本只在手机上</p> : null}
    </div>
  )
}

function UsageLine({ usage }: { usage: LaneUsage }) {
  const hasSpeed = usage.response_ms !== null && usage.output_tokens !== null && usage.output_tokens > 0
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-foreground-muted">
        {`输入 ${num(usage.input_tokens)} · 输出 ${num(usage.output_tokens)} · 平均 ${num(usage.tokens_per_second)} tok/s`}
        {usage.response_ms_source === 'measured' ? '（桌面实测耗时，非服务端上报）' : ''}
        {` · 上下文 ${num(usage.context_used)} / ${num(usage.context_limit)}`}
      </p>
      {!hasSpeed ? <p className="text-[11px] text-foreground-muted">服务端未给耗时或输出 token 为 0：不画 tok/s</p> : null}
      <p className="text-[11px] text-foreground-muted">Token 来自服务返回的消息记录，不根据字符数估算，未经桌面校验</p>
    </div>
  )
}

// Two honest fallbacks, because the two states are not the same failure:
//   - failed: something went wrong on the way. Say what, and tell the user to
//     check on the phone — never to resubmit, because the phone may already be
//     running the turn the desktop could not confirm.
//   - budget_exhausted: the DESKTOP stopped waiting; the phone was never told to
//     stop and may still be executing. Telling the user to retry here is exactly
//     the retry-nudge this lane forbids: a resubmit would spend the quota twice.
const FAILED_FALLBACK = '这一轮没有结果：请先在手机上核对，不要直接重复提交'
const BUDGET_FALLBACK = '本轮预算用尽：桌面端已停止等待，手机可能仍在执行'

function FailureBlock({ lane }: { lane: LaneResult }) {
  const code = lane.error?.code || lane.state
  const message = lane.error?.message || (lane.state === 'budget_exhausted' ? BUDGET_FALLBACK : FAILED_FALLBACK)
  return (
    <div className="space-y-1">
      <p className="text-xs text-red-300">{message}</p>
      <p className="text-[11px] text-foreground-muted">分类：{code}</p>
      {lane.note ? <p className="text-[11px] text-foreground-muted">{lane.note}</p> : null}
    </div>
  )
}

// ── section ──────────────────────────────────────────────────────────────────

export function AgentbusSection() {
  const [status, setStatus] = useState<LaneStatus | null>(null)
  const [channelMissing, setChannelMissing] = useState(false)
  const [probing, setProbing] = useState(true)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [askError, setAskError] = useState('')
  // The stop reply is kept until the next ask: the wrapping-up tier must stay on
  // screen even though the lane's own verdict is already the terminal 'stopped'.
  const [stopNotice, setStopNotice] = useState<string | null>(null)
  const [lane, setLane] = useState<LaneResult | null>(null)
  const [serialDraft, setSerialDraft] = useState('')
  const [serialSaving, setSerialSaving] = useState(false)
  const [serialNotice, setSerialNotice] = useState('')
  const alive = useRef(true)

  const pullResult = useCallback(async () => {
    const a = api()
    if (!a) return
    try {
      const r = await a.agentbusResult()
      if (alive.current) setLane(r)
    } catch (err) {
      if (alive.current) setAskError(`读取车道结果失败：${String((err as Error).message || err)}`)
    }
  }, [])

  // The serial row reads the persisted value once. A later save only rewrites
  // settings.json — the hub resolved its config when the window was created — so
  // the row says the change lands after a restart instead of implying the live
  // lane picked it up.
  const loadSerial = useCallback(async () => {
    const a = api()
    if (!a || typeof a.getSettings !== 'function') return
    try {
      const settings = await a.getSettings()
      const raw = settings ? settings.agentbusSerial : ''
      if (alive.current) setSerialDraft(typeof raw === 'string' ? raw : '')
    } catch {
      /* settings unreadable: keep the empty draft, the lane itself still works */
    }
  }, [])

  const probe = useCallback(async () => {
    const a = api()
    if (!a || !a.agentbusStatus) {
      setChannelMissing(true)
      setProbing(false)
      return
    }
    setProbing(true)
    try {
      const r = await a.agentbusStatus()
      if (alive.current) setStatus(r)
    } catch {
      if (alive.current) setStatus(null)
    } finally {
      if (alive.current) setProbing(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    void probe()
    void pullResult()
    void loadSerial()
  }, [probe, pullResult, loadSerial])

  // The lane pushes phase/state changes; re-pulling on each event keeps this
  // section in step without guessing the payload shape. Unsubscribing is what
  // keeps events away from an unmounted pane.
  useEffect(() => {
    const a = api()
    const off = a && a.onAgentbusEvent ? a.onAgentbusEvent(() => void pullResult()) : null
    return () => {
      if (off) off()
    }
  }, [pullResult])

  // The hub only broadcasts when something arrives from the phone. A silent wait
  // (screen off, slow turn) therefore arrives as zero events, and this section
  // would keep showing the elapsed value from the last pull while hub.result()
  // is already computing a live one. Poll once a second for as long as the lane
  // reports a running state; the cleanup is what stops it on unmount or on the
  // terminal state.
  const laneRunning = isRunning(lane?.state)
  useEffect(() => {
    if (!laneRunning) return
    const timer = setInterval(() => void pullResult(), 1000)
    return () => clearInterval(timer)
  }, [laneRunning, pullResult])

  async function saveSerial() {
    const a = api()
    if (!a || typeof a.setSetting !== 'function') return
    setSerialSaving(true)
    setSerialNotice('')
    try {
      await a.setSetting('agentbusSerial', serialDraft.trim())
      if (alive.current) setSerialNotice('已保存串号：重启桌面端后生效')
    } catch (err) {
      if (alive.current) setSerialNotice(`保存串号失败：${String((err as Error).message || err)}`)
    } finally {
      if (alive.current) setSerialSaving(false)
    }
  }

  async function ask() {
    const a = api()
    if (!a) return
    const prompt = draft.trim()
    if (!prompt) return
    setSending(true)
    setAskError('')
    setStopNotice(null)
    setLane(null)
    try {
      const r = await a.agentbusAsk({ prompt })
      if (!alive.current) return
      if (r && r.ok === true) {
        setDraft('')
        void pullResult()
      } else {
        setAskError(r?.error?.message || '提交未被接受')
      }
    } catch (err) {
      if (alive.current) setAskError(`提交失败：${String((err as Error).message || err)}`)
    } finally {
      if (alive.current) setSending(false)
    }
  }

  async function stopAsk() {
    const a = api()
    if (!a) return
    try {
      const r = await a.agentbusStop()
      if (!alive.current) return
      // One honest tier only: the desktop stopped waiting (and asked the phone to
      // stop, best-effort). The phone may still be executing.
      if (r && r.message) setStopNotice(r.message)
      setLane({ state: 'stopped' })
    } catch (err) {
      if (alive.current) setAskError(`中止失败：${String((err as Error).message || err)}`)
    }
  }

  const canSend =
    !channelMissing && status?.ok === true && !sending && !isRunning(lane?.state) && draft.trim().length > 0 && draft.length <= PROMPT_MAX
  const running = isRunning(lane?.state) || sending
  const stopped = lane?.state === 'stopped'

  return (
    <div className="space-y-2 border-t border-border/60 pt-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <Icon name="chat" size={14} className="text-foreground/70" />
          电脑端 AI
        </span>
        <button
          className="text-xs text-foreground-muted hover:text-foreground disabled:opacity-40"
          onClick={() => {
            void probe()
            void pullResult()
          }}
          disabled={probing}
        >
          {probing ? '检测中…' : '刷新'}
        </button>
      </div>

      {channelMissing ? <Notice tone="red">preload 未注入 agentbus 通道：请重启桌面端</Notice> : null}
      <StatusLine status={status} probing={probing && !channelMissing} />

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium">手机串号</span>
          <span className="text-[11px] text-foreground-muted">{`当前生效：${status?.serial?.trim() || '未连接'}`}</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={serialDraft}
            onChange={(e) => setSerialDraft(e.target.value)}
            placeholder="留空 = 用环境变量或 adb 唯一设备"
            className="min-w-0 flex-1 rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-xs outline-none placeholder:text-foreground-muted focus:border-brand/60"
          />
          <button
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground-muted hover:text-foreground disabled:opacity-40"
            onClick={() => void saveSerial()}
            disabled={serialSaving}
          >
            {serialSaving ? '保存中' : '保存'}
          </button>
        </div>
        <p className="text-[11px] leading-relaxed text-foreground-muted">
          环境变量 KHY_AGENTBUS_SERIAL / KHY_PHONE_BRIDGE_SERIAL 任一存在时以环境变量为准；改串号需重启桌面端后生效。
        </p>
        {serialNotice ? <Notice tone="amber">{serialNotice}</Notice> : null}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium">发给手机上的 Amoo</span>
          <span className={`text-[11px] ${draft.length > PROMPT_MAX ? 'text-red-400' : 'text-foreground-muted'}`}>
            {draft.length}/{PROMPT_MAX}
          </span>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder="输入要发给手机 Amoo 的一句话…"
          disabled={channelMissing || running}
          className="w-full resize-none rounded-lg border border-border bg-transparent px-2.5 py-2 text-xs outline-none placeholder:text-foreground-muted focus:border-brand/60 disabled:opacity-50"
        />
        <div className="flex items-center gap-2">
          <button
            className="flex-1 rounded-lg bg-brand px-3 py-2 text-xs font-medium text-white hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => void ask()}
            disabled={!canSend}
          >
            {sending ? '提交中' : '发送'}
          </button>
          {running ? (
            <button
              className="rounded-lg border border-border px-3 py-2 text-xs text-foreground-muted hover:text-foreground disabled:opacity-40"
              onClick={() => void stopAsk()}
            >
              中止
            </button>
          ) : null}
        </div>
        <p className="text-[11px] leading-relaxed text-foreground-muted">
          每一轮新建一条手机会话并发一句；回复由手机端取回后展示。等待期间可以切走这个标签。
        </p>
        {askError ? <Notice tone="red">{askError}</Notice> : null}
      </div>

      <div className="space-y-2">
        <span className="text-xs font-medium">这一轮</span>
        {lane && lane.state === 'done' ? <ReplyBlock lane={lane} /> : null}
        {lane && lane.state === 'done' && lane.usage ? <UsageLine usage={lane.usage} /> : null}
        {lane && isRunning(lane.state) ? <ProgressLine lane={lane} /> : null}
        {stopped && stopNotice ? <Notice tone="amber">{stopNotice}</Notice> : null}
        {lane && (lane.state === 'failed' || lane.state === 'budget_exhausted') ? <FailureBlock lane={lane} /> : null}
        {!lane || lane.state === 'idle' ? (
          <p className="text-[11px] text-foreground-muted">还没有发送。发送后这里显示手机那端的回复与用量。</p>
        ) : null}
      </div>
    </div>
  )
}
