import { useEffect, useRef, useState } from 'react'
import { errText } from './amoonShared'

// amoo 投递面板的「发消息」节。从 AmoonPane 拆出的原因：单组件体量超过新增
// 文件 maxFuncLines=300 的闸门（B2），发送是唯一自带全部状态的节。
// 数据只走 window.__KHYOS__.amoonSend；发送成功后经 onSent 通知面板在 1.2s 后
// 刷新回执（原先的 setTimeout 时机原样保留，只是回调改为面板传入）。

export type SendResult =
  | {
      ok: true
      id: string
      state: 'pushed' | 'sent' | 'queued'
      channel: string
      intentSent: boolean
      intentError: string | null
      openChat: boolean | null
      requiresAck: boolean
      verified: false
      remotePath: string | null
      pushError: string | null
    }
  | { ok: false; error: { code: string; message: string }; queued?: { localPath: string | null } }

const SEND_STATE_LABEL: Record<string, string> = {
  pushed: '已投递到手机 outbox',
  sent: '已启动 amoo 分享页',
}

type SendChannel = {
  amoonSend: (input: { text: string; openChat?: boolean }) => Promise<SendResult>
}

function api(): SendChannel | null {
  return ((window as unknown) as { __KHYOS__?: SendChannel }).__KHYOS__ || null
}

export function AmoonSendSection({ canSend, onSent }: { canSend: boolean; onSent: () => void }) {
  const [draft, setDraft] = useState('')
  const [openChat, setOpenChat] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendResult, setSendResult] = useState<SendResult | null>(null)
  const [sendError, setSendError] = useState('')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  async function send() {
    const a = api()
    if (!a) return
    const text = draft.trim()
    if (!text) return
    setSending(true)
    setSendError('')
    setSendResult(null)
    try {
      const r = await a.amoonSend({ text, openChat })
      setSendResult(r)
      if (r && r.ok === true) {
        setDraft('')
        window.setTimeout(() => void onSent(), 1200)
      }
    } catch (err) {
      setSendError(`发送失败：${String((err as Error).message || err)}`)
    } finally {
      if (alive.current) setSending(false)
    }
  }

  const charCount = draft.length
  const sendingDisabled = !canSend || sending || draft.trim().length === 0 || charCount > 4000

  return (
    <div className="space-y-2 border-t border-border/60 pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">发消息到 amoo</span>
        <span className={`text-[11px] ${charCount > 4000 ? 'text-red-400' : 'text-foreground-muted'}`}>{charCount}/4000</span>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        placeholder={canSend ? '输入要投递到 amoo 的文本…' : '桥接未就绪：先启动桥接再发送'}
        disabled={!canSend || sending}
        className="w-full resize-none rounded-lg border border-border bg-transparent px-2.5 py-2 text-xs outline-none placeholder:text-foreground-muted focus:border-brand/60 disabled:opacity-50"
      />
      <label className="flex items-center gap-2 text-[11px] text-foreground-muted">
        <input type="checkbox" checked={openChat} onChange={(e) => setOpenChat(e.target.checked)} disabled={!canSend} />
        同时打开 amoo 聊天页（open_chat）
      </label>
      <button
        className="w-full rounded-lg bg-brand px-3 py-2 text-xs font-medium text-white hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => void send()}
        disabled={sendingDisabled}
      >
        {sending ? '发送中…' : '发送（投递，不等于送达）'}
      </button>
      <p className="text-[11px] leading-relaxed text-foreground-muted">
        桥接只会把消息写入手机 outbox，或启动 amoo 分享页。返回状态最多是「已投递」，永远不是「已送达」。
      </p>

      {sendError ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-[11px] text-red-300">{sendError}</div>
      ) : null}
      {sendResult && sendResult.ok === false ? (
        sendResult.queued ? (
          <div className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-200">
            <div className="flex items-center gap-2 font-medium">
              已排队（未投递）
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5">未验证</span>
            </div>
            <div>手机 outbox 写入失败：{errText(sendResult, '推送失败')}</div>
            {sendResult.queued.localPath ? (
              <div className="break-all text-amber-300/80">本地 spool：{sendResult.queued.localPath}</div>
            ) : null}
            <div className="text-amber-200/70">消息只留在本机，不会自动重试。</div>
          </div>
        ) : (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-[11px] text-red-300">
            {errText(sendResult, '发送失败')}
          </div>
        )
      ) : null}
      {sendResult && sendResult.ok === true ? (
        <div className="space-y-1 rounded-lg border border-border/60 bg-surface-hover/40 px-2.5 py-2 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400">{SEND_STATE_LABEL[sendResult.state] || sendResult.state}</span>
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">未验证</span>
          </div>
          <div className="text-foreground-muted">id：{sendResult.id || '—'} · channel：{sendResult.channel}</div>
          {sendResult.intentError ? <div className="text-amber-300">Intent：{sendResult.intentError}</div> : null}
          {sendResult.pushError ? <div className="text-amber-300">文件投递：{sendResult.pushError}</div> : null}
        </div>
      ) : null}
    </div>
  )
}
