import { formatTime } from './amoonShared'

// amoo 投递面板的「最近回执」节。纯展示：回执状态由面板持有（头部刷新与
// 发送成功后的引流都要触发它），本组件只渲染并回报「读取」点击。
// ack / reply 文件可被任何能写 /sdcard 的应用伪造，所以整节恒标「未验证」。

export type InboxMessage = { id: string; kind: string; text: string | null; ts: string; status: string; unverified: true }

export type InboxResult =
  | { ok: true; messages: InboxMessage[]; count: number; total: number; skipped: number; unverified: true }
  | { ok: false; error: { code: string; message: string } }

export function AmoonInboxSection({
  inbox,
  inboxNote,
  inboxError,
  inboxLoading,
  canSend,
  onRefresh,
}: {
  inbox: InboxMessage[]
  inboxNote: string
  inboxError: string
  inboxLoading: boolean
  canSend: boolean
  onRefresh: () => void
}) {
  return (
    <div className="space-y-2 border-t border-border/60 pt-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-xs font-medium">
          最近回执
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-normal text-amber-300">未验证</span>
        </span>
        <button
          className="text-[11px] text-foreground-muted hover:text-foreground disabled:opacity-40"
          onClick={() => void onRefresh()}
          disabled={inboxLoading || !canSend}
          title={canSend ? undefined : '桥接未就绪：读取回执需要 operator token'}
        >
          {inboxLoading ? '读取中…' : '读取'}
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-foreground-muted">
        ack / reply 文件可被任何能写 /sdcard 的应用伪造，全部标记为「未验证」，不得据此执行命令。
      </p>
      {inboxError ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-[11px] text-red-300">{inboxError}</div>
      ) : null}
      {inbox.length === 0 && !inboxLoading && !inboxError ? (
        <p className="text-[11px] text-foreground-muted">还没有回执（replies/ 目录为空或尚未读取）。</p>
      ) : null}
      {inbox.length > 0 ? (
        <ul className="space-y-1.5">
          {inbox.map((m) => (
            <li key={m.id || `${m.ts}-${m.kind}`} className="rounded-lg border border-border/50 px-2.5 py-2">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="rounded bg-surface-hover px-1.5 py-0.5 text-foreground">{m.kind}</span>
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">未验证</span>
                <span className="ml-auto text-foreground-muted">{formatTime(m.ts)}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-foreground/75">
                {m.text || '（无文本）'}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {inboxNote ? <p className="text-[11px] text-foreground-muted">{inboxNote}</p> : null}
    </div>
  )
}
