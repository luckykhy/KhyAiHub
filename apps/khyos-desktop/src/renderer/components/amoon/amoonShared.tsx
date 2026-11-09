import type { ReactNode } from 'react'

// 两个 amoo 面板（投递 / 秘书）共用的最小件。只放纯函数与无状态展示，
// 不放车道逻辑——车道数据一律走各自 preload 通道，这里不碰 window.__KHYOS__。

// 错误回包到用户可读文本：优先嵌套 {error:{code,message}}，其次顶层 message，
// 都没有才落 fallback。车道/面板两边共用，防止三处各写一份然后漂移。
// 秘书面板的 ok:false 回包在 main 出口（amooSecretaryBridge.normalizeAmooReply）
// 已归一成嵌套形状，走第一分支；第二分支是投递面板还在用的——amoonHub 的
// start/stop 有两处只回顶层 message 的失败（src/main/amoon/index.ts），在它们
// 自己的源头归一之前删掉这一支，会把具体原因退化成通用 fallback。
export function errText(r: unknown, fallback: string): string {
  const rec = (r || {}) as { error?: { code?: string; message?: string }; message?: string }
  if (rec.error?.message) return `${rec.error.code || 'error'}：${rec.error.message}`
  if (rec.message) return rec.message
  return fallback
}

export function formatTime(iso: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export type Capability = 'missing' | 'offline' | 'off' | 'unknown' | 'on'

export function Notice({ tone, children }: { tone?: 'red' | 'amber'; children: ReactNode }) {
  const skin =
    tone === 'red'
      ? 'border-red-500/30 bg-red-500/10 text-red-300'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
  return <div className={`rounded-lg border px-2.5 py-2 text-[11px] ${skin}`}>{children}</div>
}
