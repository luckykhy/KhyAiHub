// khy-canary: Khy-20261102-276-A1QSV8Y6
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { AmoonSendSection, type SendResult } from './AmoonSendSection'
import { AmoonInboxSection, type InboxMessage, type InboxResult } from './AmoonInboxSection'
import { errText, formatTime } from './amoonShared'

// ── amoo 桥接面板（侧边面板主入口）──────────────────────────────────────────
// 数据只来自 window.__KHYOS__.amoon*（preload → main）；本组件不 fetch、不读文件、
// 不接触 token。首屏显示的就是 main 读到的事实：状态目录/runtime.json/health。
// 发送只在用户点击「发送」时发生，回车不会触发发送。

type AmoonPhase = 'uninstalled' | 'not_running' | 'unhealthy' | 'running'

type AmoonStatus = {
  ok?: boolean
  phase?: AmoonPhase
  message?: string
  hint?: string
  stateDir?: string
  stateDirExists?: boolean
  token?: { present?: boolean; valid?: boolean; length?: number }
  runtime?: { present?: boolean; pid?: number | null; port?: number | null; malformed?: boolean }
  health?: boolean
  bridge?: { root?: string | null; cliFound?: boolean }
  daemon?: {
    protocol?: string | null
    port?: number | null
    state?: string | null
    adbOk?: boolean | null
    lastPoll?: string | null
    lastError?: string | null
    auth?: { present?: boolean; valid?: boolean; length?: number } | null
    counters?: Record<string, number> | null
  } | null
  canSend?: boolean
  checkedAt?: string
  error?: { code?: string; message?: string }
}

type ActionOrError = { ok: boolean; message?: string; status?: AmoonStatus; error?: { code?: string; message?: string } }

type AmoonApi = {
  amoonStatus: () => Promise<AmoonStatus | { ok: false; error: { code: string; message: string } }>
  amoonSend: (input: { text: string; openChat?: boolean }) => Promise<SendResult>
  amoonInbox: (limit?: number) => Promise<InboxResult>
  amoonStart: () => Promise<ActionOrError>
  amoonStop: () => Promise<ActionOrError>
}

function api(): AmoonApi | null {
  return ((window as unknown) as { __KHYOS__?: AmoonApi }).__KHYOS__ || null
}

const PHASE_LABEL: Record<AmoonPhase, string> = {
  uninstalled: '未安装',
  not_running: '未运行',
  unhealthy: '不健康',
  running: '运行中',
}

const PHASE_DOT: Record<AmoonPhase, string> = {
  uninstalled: 'bg-foreground/25',
  not_running: 'bg-amber-400',
  unhealthy: 'bg-red-400',
  running: 'bg-emerald-500',
}

const PHASES: AmoonPhase[] = ['uninstalled', 'not_running', 'unhealthy', 'running']

// 关键：ok:false 只表示「探测没有完全成功」，不代表没有状态。
// hub 在 malformed / /health 不通 / token 缺失 / 401 时都返回 ok:false + phase；
// 这里必须继续渲染那份可诊断状态，否则 unhealthy 会被误显示成「未运行」。
function asStatus(r: unknown): AmoonStatus | null {
  if (!r || typeof r !== 'object') return null
  const rec = r as Record<string, unknown>
  if (typeof rec.phase !== 'string' || !PHASES.includes(rec.phase as AmoonPhase)) return null
  return rec as AmoonStatus
}

export function AmoonPane() {
  const [status, setStatus] = useState<AmoonStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null)
  const [confirmStop, setConfirmStop] = useState(false)
  const [inbox, setInbox] = useState<InboxMessage[]>([])
  const [inboxNote, setInboxNote] = useState('')
  const [inboxError, setInboxError] = useState('')
  const [inboxLoading, setInboxLoading] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const pull = useCallback(async (initial = false) => {
    const a = api()
    if (!a) {
      setStatusError('preload 未注入 __KHYOS__：请重启应用')
      setLoading(false)
      return
    }
    if (initial) setLoading(true)
    try {
      const r = await a.amoonStatus()
      if (!alive.current) return
      const s = asStatus(r)
      if (!s) {
        setStatusError(errText(r, '读取 amoo 状态失败'))
      } else {
        setStatus(s)
        setStatusError(s.ok === false && s.error?.message ? `${s.error.code || 'error'}：${s.error.message}` : '')
      }
    } catch (err) {
      if (alive.current) setStatusError(`读取 amoo 状态失败：${String((err as Error).message || err)}`)
    } finally {
      if (alive.current && initial) setLoading(false)
    }
  }, [])

  // 只读轮询：status 只做 fs 读取 + /health 探测，不会创建状态目录（cli status 同判据）。
  useEffect(() => {
    void pull(true)
    const timer = window.setInterval(() => void pull(false), 15000)
    return () => window.clearInterval(timer)
  }, [pull])

  const refreshInbox = useCallback(async () => {
    const a = api()
    if (!a) return
    setInboxLoading(true)
    try {
      const r = await a.amoonInbox(20)
      if (!alive.current) return
      if (r && r.ok === true) {
        setInbox(r.messages)
        setInboxNote(
          r.total > r.count
            ? `显示最近 ${r.count} / 共 ${r.total} 条（跳过 ${r.skipped} 条非法文件）`
            : `共 ${r.total} 条`,
        )
        setInboxError('')
      } else {
        setInboxError(errText(r, '读取回执失败'))
      }
    } catch (err) {
      if (alive.current) setInboxError(`读取回执失败：${String((err as Error).message || err)}`)
    } finally {
      if (alive.current) setInboxLoading(false)
    }
  }, [])

  async function startBridge() {
    const a = api()
    if (!a) return
    setBusy('start')
    setStatusError('')
    try {
      const r = await a.amoonStart()
      const s = asStatus(r?.status)
      if (s) setStatus(s)
      if (!r?.ok) setStatusError(errText(r, '启动失败'))
      else void pull(false)
    } catch (err) {
      setStatusError(`启动失败：${String((err as Error).message || err)}`)
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  async function stopBridge() {
    const a = api()
    if (!a) return
    setBusy('stop')
    setConfirmStop(false)
    try {
      const r = await a.amoonStop()
      const s = asStatus(r?.status)
      if (s) setStatus(s)
      if (!r?.ok) setStatusError(errText(r, '停止失败'))
    } catch (err) {
      setStatusError(`停止失败：${String((err as Error).message || err)}`)
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  const phase: AmoonPhase = status?.phase || 'not_running'
  const canSend = Boolean(status?.canSend)
  const cliFound = status?.bridge?.cliFound !== false
  const runtimePresent = status?.runtime?.present === true

  return (
    <div className="flex h-full flex-col text-sm">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <Icon name="remote-mobile" size={16} className="text-foreground/70" />
        <span className="font-medium">amoo</span>
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${PHASE_DOT[phase]}`} />
        <span className="text-xs text-foreground-muted">{status ? PHASE_LABEL[phase] : '读取中'}</span>
        <div className="ml-auto flex items-center gap-2">
          {runtimePresent || phase === 'running' ? (
            confirmStop ? (
              <>
                <button className="text-xs text-red-400 hover:underline" onClick={() => void stopBridge()} disabled={busy !== null}>
                  {busy === 'stop' ? '停止中…' : '确认停止'}
                </button>
                <button className="text-xs text-foreground-muted hover:underline" onClick={() => setConfirmStop(false)}>
                  取消
                </button>
              </>
            ) : (
              <button className="text-xs text-foreground-muted hover:underline" onClick={() => setConfirmStop(true)}>
                停止
              </button>
            )
          ) : null}
          <button
            className="text-xs text-foreground-muted hover:text-foreground disabled:opacity-40"
            onClick={() => {
              void pull(false)
              void refreshInbox()
            }}
            disabled={loading}
          >
            {loading ? '检测中…' : '刷新'}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {/* 状态 */}
        {statusError ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{statusError}</div>
        ) : null}
        <div className="space-y-1">
          <p className="text-xs text-foreground/80">{status?.message || '正在读取桥接状态…'}</p>
          {status?.hint ? <p className="text-[11px] leading-relaxed text-foreground-muted">{status.hint}</p> : null}
        </div>

        {status?.phase !== 'running' ? (
          <>
            <button
              className="w-full rounded-lg bg-brand/10 px-3 py-2 text-xs text-brand hover:bg-brand/20 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void startBridge()}
              disabled={busy !== null || !cliFound}
            >
              {busy === 'start' ? '启动中（最长 25s）…' : '启动本机桥接'}
            </button>
            {!cliFound ? (
              <p className="text-[11px] leading-relaxed text-red-300">
                未找到 khy-amoon-bridge 源码目录：设置 KHY_AMOON_BRIDGE_DIR 或 KHY_OS_DIR 后重启桌面端。
              </p>
            ) : runtimePresent ? (
              <p className="text-[11px] leading-relaxed text-foreground-muted">
                runtime.json 仍在：启动前会先执行一次 CLI stop 清理残留，避免撞 daemon.lock。
              </p>
            ) : null}
          </>
        ) : null}

        {/* 事实表：全部是 main 读到的字段，没有装饰性假数据 */}
        {status ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 rounded-lg border border-border/60 px-2.5 py-2 text-[11px]">
            <dt className="text-foreground-muted">状态目录</dt>
            <dd className="truncate text-foreground/70" title={status.stateDir}>
              {status.stateDir || '—'}
            </dd>
            <dt className="text-foreground-muted">operator token</dt>
            <dd className="text-foreground/70">
              {status.token?.present
                ? `存在（长度 ${status.token.length}${status.token.valid ? '' : '，过短'}）`
                : '缺失（写操作 fail-closed）'}
            </dd>
            <dt className="text-foreground-muted">runtime.json</dt>
            <dd className="text-foreground/70">
              {status.runtime?.present
                ? `pid ${status.runtime.pid ?? '?'} · 端口 ${status.runtime.port ?? '?'}`
                : '不存在'}
            </dd>
            <dt className="text-foreground-muted">/health</dt>
            <dd className={status.health ? 'text-emerald-400' : 'text-foreground/70'}>
              {status.health ? '通' : '不通'}
            </dd>
            {status.daemon ? (
              <>
                <dt className="text-foreground-muted">daemon</dt>
                <dd className="text-foreground/70">
                  {status.daemon.state || '—'}
                  {status.daemon.adbOk === null ? '' : ` · adb ${status.daemon.adbOk ? '在线' : '不可用'}`}
                </dd>
                {status.daemon.lastPoll ? (
                  <>
                    <dt className="text-foreground-muted">上次轮询</dt>
                    <dd className="text-foreground/70">{formatTime(status.daemon.lastPoll)}</dd>
                  </>
                ) : null}
              </>
            ) : null}
            {status.bridge?.cliFound === false ? (
              <>
                <dt className="text-foreground-muted">桥接源码</dt>
                <dd className="text-red-300">未找到（设置 KHY_AMOON_BRIDGE_DIR）</dd>
              </>
            ) : null}
          </dl>
        ) : null}

        {status?.daemon?.lastError ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-200">
            daemon 最近一次错误：{status.daemon.lastError}
          </div>
        ) : null}

        {/* 发送 */}
        <AmoonSendSection canSend={canSend} onSent={() => void refreshInbox()} />

        {/* 回执 */}
        <AmoonInboxSection
          inbox={inbox}
          inboxNote={inboxNote}
          inboxError={inboxError}
          inboxLoading={inboxLoading}
          canSend={canSend}
          onRefresh={() => void refreshInbox()}
        />
      </div>
    </div>
  )
}
