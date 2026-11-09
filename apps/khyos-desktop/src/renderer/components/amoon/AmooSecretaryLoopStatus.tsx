import { useCallback, useEffect, useRef, useState } from 'react'
import { errText, Notice, type Capability } from './amoonShared'

// amoo 秘书面板的手机循环状态区。从 AmooSecretaryPane 独立成节的原因与共享记忆
// 相同：与提问/等回答不共享状态，只共享 capability 一个入参。
// 数据只走 window.__KHYOS__.amooSecretaryLoopStatus（host 车道的 loop_status，
// 桥本地能力）；本组件不 fetch、不读文件、不做轮询——快照随 capability 就绪
// 拉一次，之后只由「刷新」触发。

// The phone's own reply shape, projected field by field by the lane
// (amooSecretary.ts readLoopStatus). running may be null: the bridge did not
// report the field, and unknown must not render as "not running".
export type LoopStatusResult =
  | {
      ok: true
      running: boolean | null
      mode: string
      report: string
      reportTruncated?: boolean
      unverified?: true
    }
  | { ok: false; error: { code: string; message: string } }

type LoopChannel = {
  amooSecretaryLoopStatus: () => Promise<LoopStatusResult>
}

function api(): LoopChannel | null {
  return ((window as unknown) as { __KHYOS__?: LoopChannel }).__KHYOS__ || null
}

// 门控文案沿用能力三态的既有口径（手机桥不在线 / 桥上未报到助手协同能力 /
// 桥未报到，能力未知）。off/null 也禁用是刻意保守：loop_status 本身虽是桥本地
// 能力，但桥不报助手协同组时，桌面分不清旧版桥和没装 Amoo，此时展示「循环未
// 运行」会替手机说出它没说过的话。
function LoopDisabledNotice({ capability }: { capability: Capability }) {
  if (capability === 'offline' || capability === 'missing') {
    return (
      <Notice tone="red">
        <div className="font-medium">手机桥不在线</div>
        <div className="mt-1 text-foreground-muted">
          循环状态读取已停用。确认手机与桌面端已连接、桥 daemon 在运行，修好后点「刷新」。
        </div>
      </Notice>
    )
  }
  if (capability === 'off') {
    return (
      <Notice tone="amber">
        <div className="font-medium">桥上未报到助手协同能力</div>
        <div className="mt-1 text-foreground-muted">
          循环状态读取已停用：这一组能力整组随 Amoo 安装态关闭，不是单个开关没打开。装好后点「刷新」重试。
        </div>
      </Notice>
    )
  }
  return (
    <Notice tone="amber">
      <div className="font-medium">桥未报到，能力未知</div>
      <div className="mt-1 text-foreground-muted">
        桥没有回答这一组能力是否可用。没报到不等于没有，先按不可用处理；点「刷新」重试。
      </div>
    </Notice>
  )
}

// running 的三态徽标。false 才是「未在运行」——null（桥没报）必须与它分开。
function loopRunningBadge(running: boolean | null): { label: string; className: string } {
  if (running === true) {
    return { label: '手机侧自报 · 运行中', className: 'bg-emerald-500/15 text-emerald-300' }
  }
  if (running === false) {
    return { label: '手机侧自报 · 未在运行', className: 'bg-surface-hover/60 text-foreground-muted' }
  }
  return { label: '桥未报告运行与否', className: 'bg-amber-500/15 text-amber-300' }
}

type LoopView =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'ready'; running: boolean | null; mode: string; report: string; reportTruncated?: boolean }
  | { kind: 'error'; message: string }

export function LoopStatusSection({ capability }: { capability: Capability }) {
  const [view, setView] = useState<LoopView>({ kind: 'idle' })
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const pull = useCallback(async () => {
    const a = api()
    if (!a || !a.amooSecretaryLoopStatus) {
      setView({ kind: 'error', message: 'preload 未注入循环状态通道：请重启桌面端' })
      return
    }
    setView({ kind: 'reading' })
    try {
      const r = await a.amooSecretaryLoopStatus()
      if (!alive.current) return
      if (r && r.ok === true) {
        setView({
          kind: 'ready',
          running: r.running === true ? true : r.running === false ? false : null,
          mode: typeof r.mode === 'string' ? r.mode : '',
          report: typeof r.report === 'string' ? r.report : '',
          ...(r.reportTruncated === true ? { reportTruncated: true } : {}),
        })
      } else {
        // 检测不到就说检测不到：原因照车道回包原样给出，绝不落成 running 的
        // 任何一个值。
        setView({ kind: 'error', message: errText(r, '读取循环状态失败') })
      }
    } catch (err) {
      if (alive.current) setView({ kind: 'error', message: `读取循环状态失败：${String((err as Error).message || err)}` })
    }
  }, [])

  useEffect(() => {
    if (capability !== 'on') {
      setView({ kind: 'idle' })
      return
    }
    void pull()
  }, [capability, pull])

  return (
    <div className="space-y-2 border-t border-border/60 pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">手机循环状态</span>
        <button
          className="text-[11px] text-foreground-muted hover:text-foreground disabled:opacity-40"
          onClick={() => void pull()}
          disabled={capability !== 'on' || view.kind === 'reading'}
          title={capability === 'on' ? undefined : '能力未就绪：先看上面的说明'}
        >
          {view.kind === 'reading' ? '读取中…' : '刷新'}
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-foreground-muted">
        Amoo 手机端本地执行循环的只读镜像：运行与否、闸门模式、最近一条进展都由手机自报，桌面未做校验；
        循环的启动与停止在手机端操作，桌面不代管。
      </p>

      {capability !== 'on' ? <LoopDisabledNotice capability={capability} /> : null}

      {view.kind === 'ready' ? (
        <div className="space-y-1.5 rounded-lg border border-border/60 bg-surface-hover/40 px-2.5 py-2 text-[11px]">
          <div className="flex items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 ${loopRunningBadge(view.running).className}`}>
              {loopRunningBadge(view.running).label}
            </span>
            <span className="text-foreground-muted">
              {view.mode ? `闸门模式：${view.mode}` : '桥未报告闸门模式'}
            </span>
          </div>
          {view.report ? (
            <div className="space-y-1 border-t border-border/50 pt-1.5">
              <div className="flex items-center gap-2">
                <span className="font-medium text-foreground/80">最近一条进展</span>
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">手机侧自报 · 未验证</span>
              </div>
              <p className="whitespace-pre-wrap break-words text-foreground/75">{view.report}</p>
              <p className="leading-relaxed text-foreground-muted">
                Amoo 侧文本：不是本面板任何提问的回复，也不进问答台账。
              </p>
              {view.reportTruncated ? (
                <p className="text-amber-300">进展文本可能被截断：完整内容只在手机上。</p>
              ) : null}
            </div>
          ) : (
            <p className="text-foreground-muted">手机没有留下进展说明。</p>
          )}
        </div>
      ) : null}
      {view.kind === 'error' ? <Notice tone="red">{view.message}</Notice> : null}
      {view.kind === 'idle' && capability === 'on' ? (
        <p className="text-[11px] text-foreground-muted">还没有读取过。点「刷新」查看手机侧循环状态。</p>
      ) : null}
    </div>
  )
}
