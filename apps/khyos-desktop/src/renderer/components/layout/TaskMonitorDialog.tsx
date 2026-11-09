import { useEffect, useState } from 'react'
import { Icon } from '../ui/Icon'

// 任务监控（窗口菜单 → 任务监控，与进程监视器并列）。
// 数据两段：本进程在跑的会话/工具（host 进程内存登记）+ 文件真源里的队列任务
// （largeTaskRuntimeStore → works/data/khy/tasks/large_task_runtime.json）。
// 跨进程的工具调用汇总不在首版范围：网页端只显示网页后端进程在跑的，桌面端只看
// 本机 host 进程在跑的。只读，不提供中止/重试。

interface MonitorTool {
  callId: string | null
  tool: string
  status: string
  success: boolean | null
  inputPreview: string
  resultPreview: string
  startedAt: number
  finishedAt: number | null
  elapsedMs: number
}

interface MonitorRun {
  key: string
  scope: string
  id: string
  title: string
  status: string
  startedAt: number
  lastActivityAt: number
  finishedAt: number | null
  elapsedMs: number
  idleMs: number
  error: string | null
  toolCount: number
  tools: MonitorTool[]
}

interface MonitorTask {
  id: string
  type: string | null
  status: string
  group: string
  source: string | null
  label: string
  priority: number
  progressPct: number | null
  attemptCount: number
  maxAttempts: number
  createdAt: string | null
  updatedAt: string | null
  completedAt: string | null
  leaseOwner: string | null
  lastError: string | null
}

interface MonitorCounts {
  runsRunning: number
  runsFinished: number
  tasksRunning: number
  tasksQueued: number
  tasksPaused: number
  tasksFailed: number
  tasksTotal: number
}

interface MonitorSnapshot {
  generatedAt: string
  process: { pid: number; scope: string; nodeVersion: string }
  counts: MonitorCounts
  runs: MonitorRun[]
  tasks: MonitorTask[]
  tasksError: string | null
}

interface SnapshotResponse {
  ok: boolean
  snapshot?: MonitorSnapshot
  error?: string
}

const RUN_STATUS_LABEL: Record<string, string> = {
  running: '在跑',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
}

const TASK_STATUS_LABEL: Record<string, string> = {
  queued: '排队',
  claimed: '已领取',
  running: '在跑',
  retry_wait: '等待重试',
  pausing: '暂停中',
  paused: '已暂停',
  cancelling: '取消中',
  cancelled: '已取消',
  succeeded: '成功',
  failed: '失败',
  dead_letter: '死信',
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total} 秒`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return `${m} 分 ${String(s).padStart(2, '0')} 秒`
  return `${Math.floor(m / 60)} 时 ${String(m % 60).padStart(2, '0')} 分`
}

function formatClock(iso: string | null): string {
  if (!iso) return '-'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '-'
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

function statusTone(status: string): string {
  if (status === 'running' || status === 'claimed') return 'text-brand'
  if (status === 'failed' || status === 'dead_letter') return 'text-destructive'
  if (status === 'cancelled') return 'text-foreground-subtle'
  return 'text-foreground-muted'
}

function DetailLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-xs leading-5">
      <span className="w-20 flex-shrink-0 text-foreground-subtle">{label}</span>
      <span className="flex-1 min-w-0 break-words text-foreground-muted">{children}</span>
    </div>
  )
}

function RunRow({ run }: { run: MonitorRun }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full text-left px-3 py-2 hover:bg-surface-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className={`text-xs w-10 flex-shrink-0 ${statusTone(run.status)}`}>
            {RUN_STATUS_LABEL[run.status] || run.status}
          </span>
          <span className="text-sm text-foreground flex-1 truncate" title={run.title}>
            {run.title}
          </span>
          <span className="text-xs text-foreground-muted tabular-nums flex-shrink-0">
            {formatDuration(run.elapsedMs)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-3 text-xs text-foreground-subtle">
          <span>工具 {run.toolCount} 次</span>
          <span>{run.scope === 'desktop' ? '桌面 host' : '网页后端'}</span>
          {run.status === 'running' && <span>空闲 {formatDuration(run.idleMs)}</span>}
          <span>{expanded ? '收起详情' : '展开详情'}</span>
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-2 pl-[3.75rem]">
          <DetailLine label="运行 id">{run.id}</DetailLine>
          <DetailLine label="开始时间">{formatClock(new Date(run.startedAt).toISOString())}</DetailLine>
          <DetailLine label="最后活动">{formatClock(new Date(run.lastActivityAt).toISOString())}</DetailLine>
          {run.error && <DetailLine label="错误">{run.error}</DetailLine>}
          {run.tools.length === 0 ? (
            <DetailLine label="工具">本轮还没有工具调用</DetailLine>
          ) : (
            run.tools.map((tool, index) => (
              <div key={`${tool.callId || tool.tool}-${index}`} className="mt-1 rounded border border-border px-2 py-1">
                <div className="flex items-center gap-2 text-xs">
                  <span className={`w-10 flex-shrink-0 ${statusTone(tool.status)}`}>
                    {RUN_STATUS_LABEL[tool.status] || tool.status}
                  </span>
                  <span className="text-foreground flex-1 truncate">{tool.tool}</span>
                  <span className="text-foreground-muted tabular-nums">{formatDuration(tool.elapsedMs)}</span>
                </div>
                {tool.inputPreview && (
                  <div className="mt-0.5 text-xs text-foreground-subtle break-words">参数：{tool.inputPreview}</div>
                )}
                {tool.resultPreview && (
                  <div className="text-xs text-foreground-subtle break-words">结果：{tool.resultPreview}</div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function TaskRow({ task }: { task: MonitorTask }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full text-left px-3 py-2 hover:bg-surface-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className={`text-xs w-14 flex-shrink-0 ${statusTone(task.status)}`}>
            {TASK_STATUS_LABEL[task.status] || task.status}
          </span>
          <span className="text-sm text-foreground flex-1 truncate" title={task.label}>
            {task.label}
          </span>
          <span className="text-xs text-foreground-muted tabular-nums flex-shrink-0">
            {task.progressPct === null ? '' : `${task.progressPct}%`}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-3 text-xs text-foreground-subtle">
          <span>{task.id}</span>
          {task.source && <span>来源 {task.source}</span>}
          <span>更新 {formatClock(task.updatedAt)}</span>
          <span>{expanded ? '收起详情' : '展开详情'}</span>
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-2 pl-[4.25rem]">
          <DetailLine label="类型">{task.type || '-'}</DetailLine>
          <DetailLine label="尝试次数">
            {task.attemptCount}/{task.maxAttempts || '-'}
          </DetailLine>
          <DetailLine label="优先级">{task.priority}</DetailLine>
          <DetailLine label="创建时间">{formatClock(task.createdAt)}</DetailLine>
          <DetailLine label="结束时间">{formatClock(task.completedAt)}</DetailLine>
          {task.leaseOwner && <DetailLine label="领取者">{task.leaseOwner}</DetailLine>}
          {task.lastError && <DetailLine label="错误">{task.lastError}</DetailLine>}
        </div>
      )}
    </div>
  )
}

export function TaskMonitorDialog({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<SnapshotResponse | null>(null)

  useEffect(() => {
    const api = (window as unknown as {
      __KHYOS__?: { taskMonitorSnapshot?: () => Promise<SnapshotResponse> }
    }).__KHYOS__
    if (!api?.taskMonitorSnapshot) {
      setData({ ok: false, error: '任务监控不可用：preload 未注入 __KHYOS__，请重启应用' })
      return
    }
    let cancelled = false
    const load = () => {
      api
        .taskMonitorSnapshot!()
        .then((res) => {
          if (!cancelled) setData(res)
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setData({ ok: false, error: `读取任务快照失败：${String(err)}，请重启应用后重试` })
          }
        })
    }
    load()
    // 1s 轮询只刷新只读快照（不是任务截止计时，规则 3 合规）；耗时由快照里的
    // startedAt/lastActivityAt 计算，界面每一轮自然递增。
    const timer = setInterval(load, 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  const snapshot = data?.ok ? data.snapshot : undefined
  const counts = snapshot?.counts

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[560px] max-h-[80vh] flex flex-col rounded-lg border border-border bg-popover shadow-2xl animate-scale-in"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        role="dialog"
        aria-label="任务监控"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <h2 className="text-sm font-semibold text-foreground">任务监控</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-md flex items-center justify-center text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
            aria-label="关闭任务监控"
          >
            <Icon name="close" size={12} />
          </button>
        </div>

        {!data ? (
          <div className="px-4 py-6 text-sm text-foreground-muted">读取任务快照…</div>
        ) : !data.ok ? (
          <div className="px-4 py-6 text-sm text-destructive">{data.error || '任务快照不可用'}</div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {counts && (
              <div className="px-3 py-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-foreground-muted border-b border-border">
                <span>在跑会话 {counts.runsRunning}</span>
                <span>已结束 {counts.runsFinished}</span>
                <span>任务在跑 {counts.tasksRunning}</span>
                <span>任务排队 {counts.tasksQueued}</span>
                <span>任务失败 {counts.tasksFailed}</span>
                <span>任务总数 {counts.tasksTotal}</span>
                <span>pid {snapshot?.process.pid}</span>
              </div>
            )}

            <div className="px-3 pt-2 pb-1 text-xs font-medium text-foreground-subtle">会话在跑</div>
            {!snapshot || snapshot.runs.length === 0 ? (
              <div className="px-3 py-2 text-xs text-foreground-muted">本进程当前没有在跑的会话</div>
            ) : (
              snapshot.runs.map((run) => <RunRow key={run.key} run={run} />)
            )}

            <div className="px-3 pt-3 pb-1 text-xs font-medium text-foreground-subtle">队列/后台任务</div>
            {snapshot?.tasksError ? (
              <div className="px-3 py-2 text-xs text-destructive">{snapshot.tasksError}</div>
            ) : !snapshot || snapshot.tasks.length === 0 ? (
              <div className="px-3 py-2 text-xs text-foreground-muted">任务台账里没有记录</div>
            ) : (
              snapshot.tasks.map((task) => <TaskRow key={task.id} task={task} />)
            )}
          </div>
        )}
      </div>
    </>
  )
}
