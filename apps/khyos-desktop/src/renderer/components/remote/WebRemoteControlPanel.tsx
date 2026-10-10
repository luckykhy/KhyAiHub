import { useCallback, useEffect, useRef, useState } from 'react'
import { useDispatch } from 'react-redux'
import { addToast } from '../../state/toastSlice'

// ── 移动端远程控制（ZC-ALIGN-002 M3 / [DESIGN-ARCH-092] §7.21）──
// 文案真源：zcode-analysis/i18n-zh.json 的 webRemoteControl.*，逐字照抄；原案缺
// 「目标 + 进度」的（如「正在启动远程控制...」）按规则 2 补齐后半截。本组件族
// （SettingsPage / UsageSettings / BrowserCuaSettings）一律用中文字面量而非 i18n
// 运行时查表，这里跟随局部约定。

type RemoteStatus = {
  status?: 'idle' | 'starting' | 'running' | 'active' | 'error'
  detail?: string
  url?: string | null
  port?: number
  bindHost?: string
  lanEnabled?: boolean
  pairCode?: string | null
  qrDataUrl?: string | null
  phoneConnected?: boolean
  role?: string | null
  forwardedEvents?: number
  devices?: { deviceId: string; name: string; role: string; lastSeenAt: number }[]
  pending?: { pairingId: string; deviceInfo?: { name?: string } | null; expiresAt: number }[]
}

type BridgeProbe = { found?: boolean; url?: string; port?: number; error?: string }

type RemoteApi = {
  remoteStart: (opts?: { lanEnabled?: boolean }) => Promise<unknown>
  remoteStop: () => Promise<unknown>
  remoteStatus: () => Promise<RemoteStatus>
  remoteRefreshQr: () => Promise<{ code?: string; url?: string }>
  remoteApprove: (pairingId: string, role: string) => Promise<{ ok?: boolean; device?: { role: string } }>
  remoteReject: (pairingId: string) => Promise<unknown>
  remoteRevoke: (deviceId: string) => Promise<unknown>
  remoteProbeBridge: () => Promise<BridgeProbe>
  onRemoteEvent: (cb: (payload: RemoteStatus & { kind?: string; pairingId?: string }) => void) => () => void
}

function api(): RemoteApi | null {
  return ((window as unknown) as { __KHYOS__?: RemoteApi }).__KHYOS__ || null
}

const STATUS_LABEL: Record<string, string> = {
  idle: '未开启',
  starting: '启动中',
  running: '等待手机连接',
  active: '手机已连接',
  error: '连接失败',
}

export function WebRemoteControlPanel() {
  const dispatch = useDispatch()
  const [target, setTarget] = useState<'workspace' | 'cli'>('workspace')
  const [status, setStatus] = useState<RemoteStatus>({ status: 'idle', detail: '等待连接。' })
  const [lanEnabled, setLanEnabled] = useState(false)
  const [confirmRefresh, setConfirmRefresh] = useState(false)
  const [bridge, setBridge] = useState<BridgeProbe | null>(null)
  const [probing, setProbing] = useState(false)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const notify = useCallback(
    (msg: string, type: 'info' | 'success' | 'error' = 'info') => dispatch(addToast({ type, title: msg })),
    [dispatch],
  )

  const pull = useCallback(async () => {
    const a = api()
    if (!a) return
    try {
      const s = await a.remoteStatus()
      if (alive.current && s && typeof s === 'object') {
        setStatus(s)
        if (typeof s.lanEnabled === 'boolean') setLanEnabled(s.lanEnabled)
      }
    } catch {
      /* 服务未起时 status 是本地兜底值，不打扰用户 */
    }
  }, [])

  useEffect(() => {
    const a = api()
    void pull()
    if (!a) return
    const off = a.onRemoteEvent((payload) => {
      if (!alive.current) return
      if (payload.kind === 'pairRequest') {
        notify(`收到配对请求 · ${payload.pairingId || '未知配对码'}，请在面板上确认`)
      }
      void pull()
    })
    return off
  }, [pull, notify])

  async function toggle(on: boolean) {
    const a = api()
    if (!a) return
    setBusy(true)
    try {
      if (on) {
        await a.remoteStart({ lanEnabled })
        notify(lanEnabled ? '已开启 Web 远程控制（局域网监听，同 Wi-Fi 手机可扫码）' : '已开启 Web 远程控制（仅本机监听）')
      } else {
        await a.remoteStop()
        notify('已关闭 Web 远程控制')
      }
      await pull()
    } catch (err) {
      notify(`开启 Web 远程控制失败：${String((err as Error).message || err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function refresh() {
    const a = api()
    setConfirmRefresh(false)
    if (!a) return
    try {
      await a.remoteRefreshQr()
      await pull()
      notify('已刷新远程控制二维码')
    } catch (err) {
      notify(`刷新远程控制二维码失败：${String((err as Error).message || err)}`)
    }
  }

  async function copyLink() {
    const a = api()
    if (!a) return
    try {
      await navigator.clipboard.writeText(String(status.url || ''))
      notify('已复制远程控制链接')
    } catch (err) {
      notify(`复制远程控制链接失败：${String((err as Error).message || err)}`)
    }
  }

  async function decide(pairingId: string, role: 'viewer' | 'operator' | 'reject') {
    const a = api()
    if (!a) return
    try {
      if (role === 'reject') await a.remoteReject(pairingId)
      else await a.remoteApprove(pairingId, role)
      await pull()
    } catch (err) {
      notify(`配对处理失败：${String((err as Error).message || err)}`)
    }
  }

  async function probeCli() {
    const a = api()
    if (!a) return
    setProbing(true)
    setBridge(null)
    try {
      const r = await a.remoteProbeBridge()
      setBridge(r)
    } finally {
      setProbing(false)
    }
  }

  const running = status.status && status.status !== 'idle'

  return (
    <div className="space-y-5">
      {/* 控制对象：桌面窗口自己的工作区 vs 本机 CLI 会话（bridge） */}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-foreground/50">控制对象</span>
        {(['workspace', 'cli'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setTarget(k)}
            className={`px-3 py-1.5 rounded-lg transition-colors ${
              target === k ? 'bg-selected text-foreground' : 'text-foreground/60 hover:bg-surface-hover'
            }`}
          >
            {k === 'workspace' ? '桌面工作区' : '后端 CLI 会话'}
          </button>
        ))}
      </div>

      {target === 'cli' ? (
        <div className="space-y-3">
          <p className="text-xs text-foreground/50">
            CLI 档由本机 <code>khy bridge</code> 服务承载：桌面端不代它启动，也拿不到它打印在终端里的 PIN。
          </p>
          <button
            onClick={probeCli}
            disabled={probing}
            className="px-3 py-1.5 rounded-lg bg-brand/10 text-brand hover:bg-brand/20 text-sm disabled:opacity-50"
          >
            {probing ? '探测本机 bridge 端口中…' : '探测并生成二维码'}
          </button>
          {bridge?.found && (
            <div className="text-sm text-foreground/80">
              <div>bridge 可达 · {bridge.url}</div>
              <div className="text-xs text-foreground/50 mt-1">
                在手机上打开上面的地址；PIN 由终端侧签发，请在 CLI 窗口查看。
              </div>
            </div>
          )}
          {bridge && !bridge.found && (
            <div className="text-sm text-foreground/60">{bridge.error}</div>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <button
              onClick={() => toggle(!running)}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-brand/10 text-brand hover:bg-brand/20 text-sm disabled:opacity-50"
            >
              {busy ? '正在切换远程控制服务（等待端口与配对状态落定）' : running ? '停止' : '开启'}
            </button>
            <label className="flex items-center gap-2 text-sm text-foreground/70">
              <input
                type="checkbox"
                checked={lanEnabled}
                onChange={(e) => setLanEnabled(e.target.checked)}
              />
              允许局域网设备控制
            </label>
          </div>

          <div className="border border-card-border rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="px-2 py-0.5 rounded-full bg-surface-hover text-foreground/70 text-xs">
                {STATUS_LABEL[status.status || 'idle']}
              </span>
              {status.phoneConnected && status.role && (
                <span className="px-2 py-0.5 rounded-full bg-brand/15 text-brand text-xs">手机 · {status.role}</span>
              )}
              {status.forwardedEvents ? (
                <span className="text-xs text-foreground/40">已转发 {status.forwardedEvents} 条事件</span>
              ) : null}
            </div>
            <div className="text-sm text-foreground/70">{status.detail}</div>

            {running && (
              <div className="flex items-start gap-4 pt-1">
                {status.qrDataUrl ? (
                  <img
                    src={status.qrDataUrl}
                    alt="Web 远程控制二维码"
                    className="w-40 h-40 rounded-lg bg-white p-2"
                  />
                ) : (
                  <div className="w-40 h-40 rounded-lg bg-surface-hover flex items-center justify-center text-xs text-foreground/40">
                    正在准备二维码…
                  </div>
                )}
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="text-xs text-foreground/50">远程控制链接</div>
                  <div className="text-sm break-all text-foreground/80">
                    {status.url || '远程控制链接就绪后会显示在这里。'}
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={copyLink} className="text-xs px-2 py-1 rounded-lg border border-card-border">
                      复制链接
                    </button>
                    <button
                      onClick={() => setConfirmRefresh(true)}
                      className="text-xs px-2 py-1 rounded-lg border border-card-border"
                    >
                      刷新二维码
                    </button>
                  </div>
                  <p className="text-xs text-foreground/40">
                    无法扫码？可以在手机上打开链接。同一时间只支持一个手机页面；如果已经在别的页面打开，请先关闭旧页面。
                  </p>
                </div>
              </div>
            )}

            {confirmRefresh && (
              <div className="border border-card-border rounded-lg p-3 text-sm space-y-2">
                <div className="font-medium">刷新二维码？</div>
                <div className="text-xs text-foreground/50">
                  刷新后，之前复制或扫码得到的远程控制链接将失效，已连接的手机需要重新扫码。
                </div>
                <div className="flex gap-2">
                  <button onClick={refresh} className="px-3 py-1 rounded-lg bg-brand/10 text-brand hover:bg-brand/20 text-xs">刷新</button>
                  <button onClick={() => setConfirmRefresh(false)} className="px-3 py-1 rounded-lg border border-card-border text-xs">取消</button>
                </div>
              </div>
            )}
          </div>

          {(status.pending || []).length > 0 && (
            <div className="border border-card-border rounded-xl p-4 space-y-2">
              <div className="text-sm font-medium">待确认的配对请求</div>
              {status.pending!.map((p) => (
                <div key={p.pairingId} className="flex items-center gap-3 text-sm">
                  <span className="flex-1 truncate">
                    {p.deviceInfo?.name || '未知设备'} · 配对码 {p.pairingId}
                  </span>
                  <button
                    onClick={() => decide(p.pairingId, 'viewer')}
                    className="px-2 py-1 rounded-lg border border-card-border text-xs"
                  >
                    同意（只读）
                  </button>
                  <button
                    onClick={() => decide(p.pairingId, 'operator')}
                    className="px-2 py-1 rounded-lg bg-brand/10 text-brand hover:bg-brand/20 text-xs"
                  >
                    同意（可发消息）
                  </button>
                  <button
                    onClick={() => decide(p.pairingId, 'reject')}
                    className="px-2 py-1 rounded-lg border border-card-border text-xs text-foreground/60"
                  >
                    拒绝
                  </button>
                </div>
              ))}
            </div>
          )}

          {(status.devices || []).length > 0 && (
            <div className="border border-card-border rounded-xl p-4 space-y-2">
              <div className="text-sm font-medium">已配对设备</div>
              {status.devices!.map((d) => (
                <div key={d.deviceId} className="flex items-center gap-3 text-sm">
                  <span className="flex-1 truncate">
                    {d.name} · {d.role} · 最近在线 {new Date(d.lastSeenAt).toLocaleString()}
                  </span>
                  <button
                    onClick={() => void api()?.remoteRevoke(d.deviceId).then(pull)}
                    className="px-2 py-1 rounded-lg border border-card-border text-xs text-foreground/60"
                  >
                    撤销
                  </button>
                </div>
              ))}
            </div>
          )}

          <p className="text-xs text-foreground/40">
            工具执行权限始终由桌面端判定，手机只能转达同意或拒绝。外网 relay 档未实现，见 ZC-ALIGN-002 M3 回填。
          </p>
        </>
      )}
    </div>
  )
}
