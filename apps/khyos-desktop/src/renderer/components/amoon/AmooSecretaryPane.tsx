import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { AmooSecretaryMemory, type MemoryLimits, type MemoryResult } from './AmooSecretaryMemory'
import { LoopStatusSection } from './AmooSecretaryLoopStatus'
import { errText, Notice, type Capability } from './amoonShared'

// amoo secretary pane — ask a question, wait for the answer, read the result.
// Data comes only from window.__KHYOS__.amooSecretary* (preload → main); this
// component never fetches, never reads files and never sees the token.
//
// Why a separate pane from amoo delivery: delivery only proves a message
// reached the phone outbox, this lane waits for the phone to answer. One
// shared tab made the next reader mistake a question for a delivery.

type LaneState =
  | 'idle'
  | 'asking'
  | 'polling'
  | 'done'
  | 'failed'
  // This round could not READ the phone's state (connection/bridge problem).
  // Nobody said the ask failed — titling it like 'failed' made an offline
  // phone read as 「桥报了失败」, so the two tiers get separate copy below.
  | 'read_failed'
  | 'stopped'
  | 'budget_exhausted'
  | 'no_ask_running'
  | ''

type SecretaryStatus = {
  ok?: boolean
  // false = the assistant-collaboration group is absent (Amoo not installed);
  // null = the bridge said nothing about it. Both block asking, for different
  // reasons that must stay distinguishable instead of collapsing into one line.
  assistantAvailable?: boolean | null
  message?: string
  hint?: string
  // The lane derives amoo_memory's caps from the backend catalog and hands
  // them over here; absent means it could not read the catalog this session,
  // and the memory pane must disable writes instead of guessing a limit.
  memoryLimits?: MemoryLimits
  history?: LedgerSlice
  error?: { code?: string; message?: string }
}

type AskResult =
  | { ok: true; askId: string; unverified: true }
  | { ok: false; error: { code: string; message: string } }

type LaneResult = {
  state: LaneState
  round?: number
  waitedMs?: number
  budgetMs?: number
  reply?: string | null
  replyTruncated?: boolean
  stopReason?: string | null
  history?: LedgerSlice
  unverified: true
  /** The round's capability name, verbatim from the tool contract. */
  displayName?: string
  error?: { code: string; message: string }
}

// One ledger row as the host recorded it. The ledger (host process) is the
// only holder; the renderer sees a read-only slice riding on probe/result
// replies and never writes. unverified is forced host-side to the literal
// true — every row quotes Amoo content, none of it is verified here.
type LedgerOutcome = 'done' | 'failed' | 'stopped' | 'budget_exhausted' | 'no_ask_running'

type LedgerEntry = {
  ts: number
  askId: string
  prompt: string
  startedAt: number
  endedAt: number
  durationMs: number
  rounds: number
  outcome: LedgerOutcome
  stopReason?: string
  reply?: string
  replyTruncated?: boolean
  replyExcerpted?: boolean
  /** The round's capability name, recorded by the lane from the tool contract. */
  displayName?: string
  error?: { code: string; message: string }
  unverified: true
}

type LedgerSlice = { total: number; entries: LedgerEntry[]; persisted: boolean }

type AmooSecretaryApi = {
  amooSecretaryStatus: () =>
    Promise<SecretaryStatus | { ok: false; error: { code: string; message: string }; history?: LedgerSlice }>
  amooSecretaryAsk: (input: { prompt: string }) => Promise<AskResult>
  // ok:false replies (host gone / RPC timeout / lane catch-all) carry no state
  // and arrive normalized to the nested error shape by main's
  // amooSecretaryBridge — the failure arm here is that one shape, nothing else.
  amooSecretaryResult: () => Promise<LaneResult | { ok: false; error: { code: string; message: string } }>
  amooSecretaryStop: () => Promise<{ ok: boolean; message?: string }>
  amooSecretaryMemory: (input: {
    op: 'get' | 'set'
    id?: string
    text?: string
    verified?: boolean
    provenance?: string
  }) => Promise<MemoryResult>
  // Stops the lane's polling loop only; the question itself stays alive on the
  // phone. Called when this pane goes away so no event targets a dead window.
  amooSecretaryStopPolling: () => Promise<unknown> | void
  onAmooSecretaryEvent: (cb: (payload: unknown) => void) => () => void
}

function api(): AmooSecretaryApi | null {
  return ((window as unknown) as { __KHYOS__?: AmooSecretaryApi }).__KHYOS__ || null
}

// Only the first half (up to 未校验) is copied from the phone bridge catalog
// (phoneBridgeCatalog.js, amoo_result note). The second half is THIS pane's
// addition and the catalog does not carry it: the note does not say that
// concurrent Amoo chat can displace the bubble — that is a measured protocol
// fact about "reply = latest bubble", spelled out here. Calling the whole
// sentence catalog text borrowed an authority the second half never had. The
// wording still stays fixed, so this pane and the CLI tool do not drift on
// what "done" means.
const REPLY_DISCLAIMER =
  'Amoo 聊天气泡原文，未解析、未摘要、未校验；Amoo 聊天有其它活动时，最新气泡不保证就是这条提问的回答'

const NO_ASK_TITLE = '手机上没有进行中的提问'

const POLL_INTERVAL_MS = 3000
const PROMPT_MAX = 20000

const RUNNING_STATES: LaneState[] = ['asking', 'polling']

function isRunning(state: LaneState): boolean {
  return RUNNING_STATES.includes(state)
}

function seconds(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms < 0) return '0s'
  return `${Math.round(ms / 1000)}s`
}

function capabilityOf(status: SecretaryStatus | null): Capability {
  if (!status || status.ok === false) return 'offline'
  if (status.assistantAvailable === true) return 'on'
  if (status.assistantAvailable === false) return 'off'
  return 'unknown'
}

function CapabilityNotice({ capability }: { capability: Capability }) {
  if (capability === 'missing') {
    return <Notice>preload 未注入 amooSecretary 通道：请重启桌面端。</Notice>
  }
  if (capability === 'offline') {
    return (
      <Notice tone="red">
        <div className="font-medium">手机桥不在线</div>
        <div className="mt-1 text-foreground-muted">
          确认手机与桌面端已连接、桥 daemon 在运行；修好后用 khy phone tools 复查能力清单。
        </div>
      </Notice>
    )
  }
  if (capability === 'off') {
    return (
      <Notice tone="amber">
        <div className="font-medium">桥上未报到助手协同能力</div>
        <div className="mt-1 text-foreground-muted">
          amoo 提问 / 等回答这一组工具没有出现。装好后用 khy phone tools 复查。
        </div>
        <div className="mt-1 text-foreground-muted">这一组能力整组随 Amoo 安装态关闭，不是单个开关没打开。</div>
      </Notice>
    )
  }
  return (
    <Notice tone="amber">
      <div className="font-medium">桥未报到，能力未知</div>
      <div className="mt-1 text-foreground-muted">
        桥没有回答这一组能力是否可用。没报到不等于没有，先按不可用处理；用 khy phone tools 复查。
      </div>
    </Notice>
  )
}

// Terminal-but-not-success outcomes. Each keeps its own branch: a used-up
// budget and an empty state string are neither success nor a plain failure,
// and merging them would lie about what the bridge actually said. 'failed'
// and 'read_failed' are tiered on purpose: 'failed' is the bridge saying the
// ask itself failed, 'read_failed' means this round never read the phone's
// state at all — one shared title used to make an offline phone read as a
// failed ask. Title + detail + action stay per-tier; the history badge below
// reuses these titles so the ledger never invents a second wording.
function laneFailureView(state: LaneState): { title: string; detail: string; action?: string } | null {
  if (state === 'budget_exhausted') {
    return {
      title: '等待预算已用尽',
      detail: '在桥的等待上限内没有拿到回复。这不是成功也不是失败：提问可能仍在手机上进行。可再问一次，或先「中止」确认状态。',
    }
  }
  if (state === 'stopped') {
    return { title: '已中止', detail: '已通知手机端停止本轮提问，本轮没有可显示的回复。' }
  }
  if (state === 'failed') {
    return {
      title: '提问失败 · 桥报了失败',
      detail: '下面的原因由桥原样给出，未做改写。',
      action: '按桥上报的原因处理后重试；orphaned_ask（上一笔卡死已释放）可直接再问。',
    }
  }
  if (state === 'read_failed') {
    return {
      title: '读取状态失败',
      detail: '这一轮没能从手机读到提问状态（连接或桥的问题）。这不是「桥报了失败」：手机侧的提问不因此失败。',
      action: '检查手机与桌面端的连接（adb / 桥 daemon），然后点「刷新」重试。',
    }
  }
  if (state === '') {
    return { title: NO_ASK_TITLE, detail: '桥返回了空状态：既没有进行中的提问，也没有可显示的回复。' }
  }
  if (state === 'no_ask_running') {
    return { title: NO_ASK_TITLE, detail: '桥明确报告没有进行中的提问。重新提问会再启动一轮。' }
  }
  return null
}
// 结局分档：被拒绝（手机/桥当场拒绝这一问）与失败（这一问真跑了、没成）是两件事。
// 一个笼统徽章会把两者混成一句谎，所以分档标签单独一个徽标，不与「未验证」共用。
// 拒绝码由车道的 classifyAmooFailure 给出（手机侧原话，本面板不另造一套）。
const REJECTION_CODES = new Set([
  'requires_confirm',
  'amoo_not_foreground',
  'orphaned_ask',
  'single_flight',
  'refused',
])

type ReceiptTier = { label: string; tone: 'ok' | 'warn' | 'bad' }

function receiptTier(state: LaneState, errorCode?: string): ReceiptTier | null {
  if (state === 'done') return { label: '已回复', tone: 'ok' }
  if (state === 'failed') {
    return errorCode && REJECTION_CODES.has(errorCode)
      ? { label: '被拒绝', tone: 'warn' }
      : { label: '失败', tone: 'bad' }
  }
  if (state === 'read_failed') return { label: '读取失败', tone: 'warn' }
  if (state === 'budget_exhausted') return { label: '预算用尽', tone: 'warn' }
  if (state === 'stopped') return { label: '已中止', tone: 'warn' }
  if (state === 'no_ask_running' || state === '') return { label: '没有进行中的提问', tone: 'warn' }
  return null
}

function tierSkin(tone: ReceiptTier['tone']): string {
  if (tone === 'ok') return 'bg-emerald-500/15 text-emerald-300'
  if (tone === 'bad') return 'bg-red-500/15 text-red-300'
  return 'bg-amber-500/15 text-amber-300'
}

// 回执抬头：能力名（契约 displayName）+ 轮次 + 「未验证」+ 结局分档。
// 「未验证」说的是内容可信度（回复原文永远没被桌面校验过），结局分档说的是这一轮
// 怎么收的场——两件事各占一个徽标，合成一个就成了笼统的谎。
function ReceiptHeader({
  title,
  displayName,
  round,
  tier,
}: {
  title: string
  displayName?: string
  round?: number
  tier?: ReceiptTier | null
}) {
  const meta = [displayName || '', typeof round === 'number' && round > 0 ? `第 ${round} 轮` : '']
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground/80">{title}</span>
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">未验证</span>
        {tier ? <span className={`rounded px-1.5 py-0.5 ${tierSkin(tier.tone)}`}>{tier.label}</span> : null}
      </div>
      {meta ? <p className="text-[11px] text-foreground-muted">{meta}</p> : null}
    </div>
  )
}

// single_flight is the bridge's own lock (one question at a time). It is a
// rejection, not a failed question, and must read as neither success nor a
// generic error.
function askErrorText(r: unknown): string {
  const rec = (r || {}) as { error?: { code?: string; message?: string } }
  if (rec.error?.code === 'single_flight') {
    return '手机端已有进行中的提问：同一时间只能有一个。等上一轮结束，或先「中止」它再问。'
  }
  return `提交失败：${errText(r, '桥拒绝了这次提问')}`
}

function ProgressLine({ lane }: { lane: LaneResult }) {
  if (lane.state === 'asking') {
    return <p className="text-xs text-foreground/80">正在把问题提交到手机桥 · 已等 {seconds(lane.waitedMs)}</p>
  }
  const round = typeof lane.round === 'number' && lane.round > 0 ? `第 ${lane.round} 轮 · ` : ''
  const budget = typeof lane.budgetMs === 'number' && lane.budgetMs > 0 ? ` / 上限 ${seconds(lane.budgetMs)}` : ''
  return (
    <p className="text-xs text-foreground/80">
      {round}已等 {seconds(lane.waitedMs)}
      {budget}
    </p>
  )
}

function ReplyBlock({ lane }: { lane: LaneResult }) {
  return (
    <div className="space-y-1 rounded-lg border border-border/60 bg-surface-hover/40 px-2.5 py-2 text-[11px]">
      <ReceiptHeader
        title="手机那端的回复"
        displayName={lane.displayName}
        round={lane.round}
        tier={receiptTier(lane.state, lane.error?.code)}
      />
      <p className="whitespace-pre-wrap break-words text-foreground/75">{lane.reply || '（桥没有给出回复文本）'}</p>
      <p className="leading-relaxed text-foreground-muted">{REPLY_DISCLAIMER}</p>
      {lane.replyTruncated ? <p className="text-amber-300">回复可能被截断：完整文本只在手机上。</p> : null}
    </div>
  )
}

function FailureBlock({ lane }: { lane: LaneResult }) {
  const view = laneFailureView(lane.state)
  if (!view) return null
  const tier = receiptTier(lane.state, lane.error?.code)
  return (
    <div className="space-y-1 rounded-lg border border-border/60 bg-surface-hover/40 px-2.5 py-2 text-[11px]">
      <ReceiptHeader title={view.title} displayName={lane.displayName} round={lane.round} tier={tier} />
      <p className="leading-relaxed text-foreground-muted">{view.detail}</p>
      {tier?.label === '被拒绝' ? (
        <p className="leading-relaxed text-foreground-muted">这一问是被手机侧当场拒绝的（没问成），不是问完之后才失败。</p>
      ) : null}
      {view.action ? <p className="leading-relaxed text-foreground-muted">建议：{view.action}</p> : null}
      {lane.stopReason ? <p className="break-words text-amber-300">桥上报的停止原因：{lane.stopReason}</p> : null}
      {/* errText reads a reply's nested error; lane.error IS that error, so it
          goes in wrapped — calling errText(lane.error, '') rendered an empty
          paragraph (the one line that never showed the reason it guards). */}
      {lane.error?.message ? (
        <p className="break-words text-red-300">{errText({ error: lane.error }, '')}</p>
      ) : null}
    </div>
  )
}

// The stop reply's own sentence, rendered verbatim. The lane answers ok:true
// in both tiers; amber marks the wrapping-up tier (phone still reports
// ask_running): the abort was delivered but the ask is not over, so this must
// not read as a finished round and 中止 stays clickable for a second attempt.
function StopNoticeBlock({ notice }: { notice: { wrappingUp: boolean; message: string } }) {
  return (
    <div
      className={`space-y-1 rounded-lg border px-2.5 py-2 text-[11px] ${
        notice.wrappingUp ? 'border-amber-500/30 bg-amber-500/10 text-amber-200' : 'border-border/60 bg-surface-hover/40'
      }`}
    >
      <p className="whitespace-pre-wrap break-words text-foreground/75">{notice.message}</p>
    </div>
  )
}

// ── 问答历史（本地台账，只读）──────────────────────────────────────────────
// 台账唯一持有者在 host 进程（amooSecretaryLedger.ts），面板只经 probe/result
// 回包拿只读切片：不写、不读文件、不接触 token。它记录的是本地观察，不是
// Amoo 侧真源，因此历史回复一律带「未验证」；非 done 的结局徽标沿用
// laneFailureView 的标题口径，不把预算耗尽/中止/失败画成成功。

function historyBadge(entry: LedgerEntry): { label: string; ok: boolean } {
  if (entry.outcome === 'done') return { label: '已回复', ok: true }
  const view = laneFailureView(entry.outcome)
  return { label: view ? view.title : entry.outcome, ok: false }
}

function formatClock(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return '—'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function HistoryEntryRow({ entry }: { entry: LedgerEntry }) {
  const badge = historyBadge(entry)
  const tier = receiptTier(entry.outcome, entry.error?.code)
  return (
    <li className="rounded-lg border border-border/50 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span
          className={`rounded px-1.5 py-0.5 ${
            badge.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
          }`}
        >
          {badge.label}
        </span>
        {/* 可信度徽标与结局分档各占一个徽标：前者说内容没被桌面校验过，后者说
            这一轮怎么收的场。台账记的是本地观察，不是 Amoo 侧的核实，所以每行都带。 */}
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">未验证</span>
        {tier && tier.label !== badge.label ? (
          <span className={`rounded px-1.5 py-0.5 ${tierSkin(tier.tone)}`}>{tier.label}</span>
        ) : null}
        <span className="text-foreground-muted">
          {entry.displayName ? `${entry.displayName} · ` : ''}
          {formatClock(entry.startedAt)}–{formatClock(entry.endedAt)} · 耗时 {seconds(entry.durationMs)} · 第 {entry.rounds} 轮
        </span>
        <span className="ml-auto truncate text-foreground-muted" title={entry.askId}>
          {entry.askId}
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-foreground/75">{entry.prompt}</p>
      {entry.outcome === 'done' && entry.reply ? (
        <div className="mt-1 space-y-1 rounded-lg bg-surface-hover/40 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-foreground/80">回复</span>
          </div>
          <p className="whitespace-pre-wrap break-words text-[11px] text-foreground/75">{entry.reply}</p>
          {entry.replyExcerpted ? (
            <p className="text-[11px] text-amber-300">历史切片只保留前 600 字，不是完整回复。</p>
          ) : null}
          {entry.replyTruncated ? <p className="text-[11px] text-amber-300">回复可能被截断：完整文本只在手机上。</p> : null}
        </div>
      ) : null}
      {entry.outcome === 'done' && !entry.reply ? (
        <p className="mt-1 text-[11px] text-foreground-muted">（记录里没有回复文本）</p>
      ) : null}
      {entry.stopReason ? <p className="mt-1 break-words text-[11px] text-amber-300">桥上报的停止原因：{entry.stopReason}</p> : null}
      {entry.error?.message ? (
        <p className="mt-1 break-words text-[11px] text-red-300">{errText({ error: entry.error }, '')}</p>
      ) : null}
    </li>
  )
}

function HistorySection({ history }: { history: LedgerSlice | null }) {
  // 本地数据：不受 assistantAvailable 门控——Amoo 完全缺席时也要能回看。
  return (
    <div className="space-y-2 border-t border-border/60 pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">问答历史</span>
        {history ? (
          <span className="text-[11px] text-foreground-muted">
            共 {history.total} 条 · 新→旧{history.persisted ? '' : ' · 落盘不可用：仅本次运行'}
          </span>
        ) : null}
      </div>
      {!history || history.entries.length === 0 ? (
        <p className="text-[11px] text-foreground-muted">
          还没有可回看的记录。每轮问答出结果后记入本地台账（这台电脑上最多 500 条），不是 Amoo 侧的记录。
        </p>
      ) : (
        <ul className="space-y-1.5">
          {history.entries.map((entry) => (
            <HistoryEntryRow key={`${entry.ts}:${entry.askId}`} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  )
}

export function AmooSecretaryPane() {
  const [status, setStatus] = useState<SecretaryStatus | null>(null)
  const [channelMissing, setChannelMissing] = useState(false)
  const [statusError, setStatusError] = useState('')
  const [probing, setProbing] = useState(true)
  const [draft, setDraft] = useState('')
  const [asking, setAsking] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [askError, setAskError] = useState('')
  const [lane, setLane] = useState<LaneResult | null>(null)
  // The last stop reply, kept until the next ask: the wrapping-up tier must
  // stay on screen (and keep 中止 clickable) even though the lane's own
  // verdict is already the terminal 'stopped'.
  const [stopNotice, setStopNotice] = useState<{ wrappingUp: boolean; message: string } | null>(null)
  const [history, setHistory] = useState<LedgerSlice | null>(null)
  const alive = useRef(true)
  const pollRef = useRef<number | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  // One read path for the lane result: the interval tick, the lane event and
  // the post-ask refresh all come through here, so there is no second place
  // that can drift on what a state means.
  const pullResult = useCallback(async () => {
    const a = api()
    if (!a) return
    let r: LaneResult | { ok: false; error: { code: string; message: string } }
    try {
      r = await a.amooSecretaryResult()
    } catch (err) {
      if (alive.current) setAskError(`读取提问结果失败：${String((err as Error).message || err)}`)
      stopPolling()
      return
    }
    if (!alive.current) return
    // ok:false (host gone / RPC timeout / lane catch-all) carries no state;
    // errText reads its nested error — the shape main's amooSecretaryBridge
    // guarantees — so the reason shows instead of the generic fallback.
    if (!('state' in r) || typeof r.state !== 'string') {
      setAskError(errText(r, '读取提问结果失败：桥返回了无法识别的状态'))
      stopPolling()
      return
    }
    setLane(r)
    // 终态事件入账在先，回包里的切片已含刚记的那条：历史区不用新 IPC 就能跟上。
    if (r.history) setHistory(r.history)
    if (isRunning(r.state)) {
      if (pollRef.current === null) {
        pollRef.current = window.setInterval(() => void pullResult(), POLL_INTERVAL_MS)
      }
    } else {
      stopPolling()
    }
  }, [stopPolling])

  const probe = useCallback(async (initial: boolean) => {
    const a = api()
    if (!a || !a.amooSecretaryStatus) {
      setChannelMissing(true)
      setStatusError('preload 未注入 amooSecretary 通道：请重启桌面端')
      setProbing(false)
      return
    }
    if (initial) setProbing(true)
    try {
      const r = await a.amooSecretaryStatus()
      if (!alive.current) return
      // 历史是本地台账，与探测成败无关：Amoo 缺席也要能回看（先取历史，再分流状态）。
      if (r && r.history) setHistory(r.history)
      // ok:false only means the probe did not fully succeed — the pane then
      // shows the offline notice instead of pretending the bridge is there.
      if (r && r.ok !== false) {
        setStatus(r)
        setStatusError('')
      } else {
        setStatus(null)
        setStatusError('')
      }
    } catch {
      if (alive.current) {
        setStatus(null)
        setStatusError('')
      }
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
    void probe(true)
    void pullResult()
  }, [probe, pullResult])

  // The lane pushes state changes; re-pulling on each event keeps this pane in
  // step without guessing the payload shape. Unsubscribing here (plus telling
  // the lane to stop its loop) is what keeps events away from a dead window.
  useEffect(() => {
    const a = api()
    const off = a && a.onAmooSecretaryEvent ? a.onAmooSecretaryEvent(() => void pullResult()) : null
    return () => {
      if (off) off()
      stopPolling()
      if (a && a.amooSecretaryStopPolling) void a.amooSecretaryStopPolling()
    }
  }, [pullResult, stopPolling])

  async function ask() {
    const a = api()
    if (!a) return
    const prompt = draft.trim()
    if (!prompt) return
    setAsking(true)
    setAskError('')
    setLane(null)
    setStopNotice(null)
    try {
      const r = await a.amooSecretaryAsk({ prompt })
      if (!alive.current) return
      if (r && r.ok === true) {
        setDraft('')
        void pullResult()
      } else {
        setAskError(askErrorText(r))
      }
    } catch (err) {
      if (alive.current) setAskError(`提交失败：${String((err as Error).message || err)}`)
    } finally {
      if (alive.current) setAsking(false)
    }
  }

  async function stopAsk() {
    const a = api()
    if (!a) return
    setStopping(true)
    try {
      const r = await a.amooSecretaryStop()
      if (!alive.current) return
      // The lane's two ok:true stop tiers differ only in message wording
      // (amooSecretary.ts stopAsk); 「仍在收尾」 is the phone saying the ask
      // is not over, so the round must not be drawn as finished and 中止
      // must stay clickable for a second attempt.
      const wrappingUp = !!r.message && r.message.includes('仍在收尾')
      setStopNotice(r.message ? { wrappingUp, message: r.message } : null)
      setLane({ state: 'stopped', unverified: true, stopReason: null })
      stopPolling()
    } catch (err) {
      if (alive.current) setAskError(`中止失败：${String((err as Error).message || err)}`)
    } finally {
      if (alive.current) setStopping(false)
    }
  }

  const capability: Capability = channelMissing ? 'missing' : capabilityOf(status)
  const canAsk =
    capability === 'on' && !asking && !stopping && draft.trim().length > 0 && draft.length <= PROMPT_MAX
  const running = lane ? isRunning(lane.state) : false
  const showStop = running || asking || stopNotice?.wrappingUp === true

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <Icon name="remote-mobile" size={16} className="text-foreground/70" />
        <span className="font-medium">amoo 秘书</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            className="text-xs text-foreground-muted hover:text-foreground disabled:opacity-40"
            onClick={() => {
              void probe(false)
              void pullResult()
            }}
            disabled={probing}
          >
            {probing ? '检测中…' : '刷新'}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {statusError ? <Notice tone="red">{statusError}</Notice> : null}
        {capability !== 'on' ? <CapabilityNotice capability={capability} /> : null}
        {status?.message ? <p className="text-xs text-foreground/80">{status.message}</p> : null}
        {status?.hint ? <p className="text-[11px] leading-relaxed text-foreground-muted">{status.hint}</p> : null}

        <div className="space-y-2 border-t border-border/60 pt-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">问 Amoo 一个问题</span>
            <span className={`text-[11px] ${draft.length > PROMPT_MAX ? 'text-red-400' : 'text-foreground-muted'}`}>
              {draft.length}/{PROMPT_MAX}
            </span>
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder={capability === 'on' ? '输入要问 Amoo 的问题…' : '能力未就绪：先看上面的说明'}
            disabled={capability !== 'on' || asking}
            className="w-full resize-none rounded-lg border border-border bg-transparent px-2.5 py-2 text-xs outline-none placeholder:text-foreground-muted focus:border-brand/60 disabled:opacity-50"
          />
          <div className="flex items-center gap-2">
            <button
              className="flex-1 rounded-lg bg-brand px-3 py-2 text-xs font-medium text-white hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => void ask()}
              disabled={!canAsk}
            >
              {asking ? '提交中' : '提问'}
            </button>
            {showStop ? (
              <button
                className="rounded-lg border border-border px-3 py-2 text-xs text-foreground-muted hover:text-foreground disabled:opacity-40"
                onClick={() => void stopAsk()}
                disabled={stopping}
              >
                {stopping ? '中止中…' : '中止'}
              </button>
            ) : null}
          </div>
          <p className="text-[11px] leading-relaxed text-foreground-muted">
            问题会原样写进 Amoo 的输入框并发送；回复由轮询取回。Amoo 一想约 6 分钟，等待期间可以切走这个标签。
          </p>
          {askError ? <Notice tone="red">{askError}</Notice> : null}
        </div>

        <div className="space-y-2 border-t border-border/60 pt-3">
          <span className="text-xs font-medium">等回答</span>
          {lane && lane.state === 'done' ? <ReplyBlock lane={lane} /> : null}
          {lane && isRunning(lane.state) ? <ProgressLine lane={lane} /> : null}
          {lane && laneFailureView(lane.state) ? (
            lane.state === 'stopped' && stopNotice ? (
              <StopNoticeBlock notice={stopNotice} />
            ) : (
              <FailureBlock lane={lane} />
            )
          ) : null}
          {!lane || lane.state === 'idle' ? (
            <p className="text-[11px] text-foreground-muted">还没有提问。提交后这里显示手机那端的回复。</p>
          ) : null}
        </div>

        <HistorySection history={history} />

        <LoopStatusSection capability={capability} />

        <AmooSecretaryMemory capability={capability} memoryLimits={status?.memoryLimits} />
      </div>
    </div>
  )
}
