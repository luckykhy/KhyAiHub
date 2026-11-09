// khy-canary: Khy-20261102-280-W2HPHMPT
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../ui/Icon'
import { ATTACHMENT_ICON, attachmentTint, type AttachmentKind } from './attachmentKind'

// 输入区上方的附件列表。此前这里是一个**没人引用**的组件（2026-11-01 前全仓
// 无 import），带着一套上传状态机（queued/uploading/finishing/retrying…）和
// 大卡片版式 —— 那是 Web 端上传管线的形状。桌面端的附件是**本地路径**，不经
// 上传，状态机在这里永远不会离开 completed，留着就是假状态。
//
// 所以接进 Composer 时按桌面端现实裁剪：只留「图标 / 名字 / 大小 / 移除」。
// 版式保持 2026-10-26 定下的 chip 形态（一行 flex-wrap，不是纵向卡片），
// 图标与 @ 上下文列表同一张映射表。
export interface ComposerAttachment {
  id: string
  /** chip 上显示的名字（粘贴进来的图片没有真实文件名，给「粘贴图片」） */
  name: string
  /** 落盘后的真实路径 —— 后续要交给后端读的就是它 */
  path: string
  /** 字节数（选文件时由主进程 stat 带回；拿不到时是 0，此时不显示大小） */
  size: number
  kind: AttachmentKind
}

// B / KB / MB 三档，保留一位小数。桌面端附件是本地文件，GB 级极少，不引 GB 档。
export function formatFileSize(bytes: number): string {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

type ImageReadResult = { ok: boolean; dataUrl?: string; error?: string }

// 灯箱走 portal 挂到 body：Composer 外层有 overflow-hidden 的滚动容器，
// 直接 fixed 会被裁掉。图片本体由 main 读成 data URL（渲染层不碰文件系统）。
function ImagePreviewDialog({ attachment, onClose }: { attachment: ComposerAttachment; onClose: () => void }) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; dataUrl?: string; error?: string }>({
    status: 'loading',
  })

  useEffect(() => {
    let cancelled = false
    const api = (window as unknown as { __KHYOS__?: { readImageDataUrl?: (p: string) => Promise<ImageReadResult> } })
      .__KHYOS__
    if (!api?.readImageDataUrl) {
      setState({ status: 'error', error: '图片预览不可用：preload 未注入 readImageDataUrl，请重启应用' })
      return
    }
    void api
      .readImageDataUrl(attachment.path)
      .then((res) => {
        if (cancelled) return
        if (res?.ok && res.dataUrl) setState({ status: 'ready', dataUrl: res.dataUrl })
        else setState({ status: 'error', error: res?.error || `读取图片 ${attachment.name} 失败：返回内容为空` })
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: 'error', error: `读取图片 ${attachment.name} 失败：${String(err)}，请重试` })
      })
    return () => {
      cancelled = true
    }
  }, [attachment.name, attachment.path])

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex flex-col animate-fade-in"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      role="dialog"
      aria-modal="true"
      aria-label={`预览图片 ${attachment.name}`}
    >
      <div className="absolute inset-0 bg-black/80" onClick={onClose} />
      <div className="relative flex items-start justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-white truncate" title={attachment.path}>
            {attachment.name}
          </div>
          <div className="mt-0.5 text-xs text-white/60 truncate" title={attachment.path}>
            {attachment.size > 0 ? `${formatFileSize(attachment.size)} · ` : ''}
            {attachment.path}
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 text-white/80 hover:text-white hover:bg-white/10 transition-colors"
          title="关闭图片预览（Esc）"
          aria-label="关闭图片预览"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="relative flex-1 flex items-center justify-center p-4 overflow-hidden" onClick={onClose}>
        {state.status === 'loading' && (
          <div className="text-sm text-white/80" onClick={(e) => e.stopPropagation()}>
            读取图片 {attachment.name}
            {attachment.size > 0 ? `（${formatFileSize(attachment.size)}）` : ''}…
          </div>
        )}
        {state.status === 'error' && (
          <div
            className="max-w-[560px] rounded-lg bg-black/60 px-4 py-3 text-sm text-white/85"
            onClick={(e) => e.stopPropagation()}
          >
            {state.error}
          </div>
        )}
        {state.status === 'ready' && state.dataUrl && (
          <img
            src={state.dataUrl}
            alt={attachment.name}
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onError={() =>
              setState({
                status: 'error',
                error: `图片 ${attachment.name} 解码失败：文件可能已损坏，请用系统看图工具打开 ${attachment.path}`,
              })
            }
          />
        )}
      </div>
    </div>,
    document.body,
  )
}

export function AttachmentList({
  attachments,
  onRemove,
}: {
  attachments: ComposerAttachment[]
  onRemove: (id: string) => void
}) {
  const [previewId, setPreviewId] = useState<string | null>(null)
  if (attachments.length === 0) return null

  const preview = attachments.find((a) => a.id === previewId) ?? null

  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {attachments.map((att) => {
        const previewable = att.kind === 'image'
        const body = (
          <>
            <Icon
              name={ATTACHMENT_ICON[att.kind]}
              size={15}
              className={`shrink-0 ${attachmentTint(att.kind)}`}
            />
            <span className="text-foreground truncate max-w-[220px]" title={att.path}>
              {att.name}
            </span>
            {att.size > 0 && (
              <span className="text-xs text-foreground-muted shrink-0">{formatFileSize(att.size)}</span>
            )}
          </>
        )
        return (
          <div
            key={att.id}
            className="flex items-center gap-2 bg-card border border-card-border rounded-lg pl-2.5 pr-1.5 py-1.5 text-sm"
          >
            {previewable ? (
              <button
                onClick={() => setPreviewId(att.id)}
                className="flex items-center gap-2 min-w-0 text-left rounded cursor-zoom-in hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
                title={`点击放大查看：${att.name}`}
                aria-label={`放大查看图片 ${att.name}`}
              >
                {body}
              </button>
            ) : (
              <div className="flex items-center gap-2 min-w-0">{body}</div>
            )}
            <button
              onClick={() => onRemove(att.id)}
              className="w-5 h-5 rounded flex items-center justify-center text-foreground-subtle hover:text-destructive hover:bg-surface-hover transition-colors shrink-0"
              title={`移除附件：${att.name}`}
              aria-label={`移除附件 ${att.name}`}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        )
      })}
      {preview && <ImagePreviewDialog attachment={preview} onClose={() => setPreviewId(null)} />}
    </div>
  )
}
