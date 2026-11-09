// khy-canary: Khy-20261102-284-F23HRJ25
import { useCallback, useEffect, useState } from 'react'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { Spinner } from '../ui/Spinner'
import { BranchSwitcher } from './BranchSwitcher'

// Result contract of main's git:status handler (git status --porcelain=v1
// -z --branch over the workspace cwd). Four outcome states:
// ok / notRepository / gitUnavailable (no git.exe on PATH) / error.
interface GitStatusResult {
  ok: boolean
  state?: 'ok' | 'notRepository' | 'gitUnavailable' | 'error'
  branch?: string
  upstream?: string
  ahead?: number
  behind?: number
  changes?: { path: string; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'; staged: boolean }[]
  error?: string
}

interface GitChange {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
}

// git.kind.* i18n: 新增 / 冲突 / 删除 / 修改 / 重命名 (untracked falls under
// the untracked section, labeled by section.untracked)
const KIND_LABEL: Record<GitChange['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
  untracked: '新增',
}

const STATUS_CONFIG: Record<GitChange['status'], { color: string; letter: string }> = {
  modified: { color: 'var(--color-git-modified)', letter: 'M' },
  added: { color: 'var(--color-git-added)', letter: 'A' },
  deleted: { color: 'var(--color-git-deleted)', letter: 'D' },
  renamed: { color: 'var(--color-git-renamed)', letter: 'R' },
  untracked: { color: 'var(--color-git-untracked)', letter: 'U' },
}

type PanelState =
  | { phase: 'loading' }
  | { phase: 'ready'; data: GitStatusResult }
  | { phase: 'empty'; data: GitStatusResult }
  | { phase: 'gitUnavailable' }
  | { phase: 'notRepository' }
  | { phase: 'error'; message: string }

function classify(result: GitStatusResult | null, err?: unknown): PanelState {
  if (!result) {
    // preload not injected or IPC threw before returning a payload
    const msg = err instanceof Error ? err.message : String(err ?? '未知错误')
    return { phase: 'error', message: msg || 'preload 未注入：__KHYOS__ 不可用，请重启应用' }
  }
  if (!result.ok) {
    if (result.state === 'gitUnavailable') return { phase: 'gitUnavailable' }
    if (result.state === 'notRepository') return { phase: 'notRepository' }
    return { phase: 'error', message: result.error || 'git status 执行失败' }
  }
  const changes = result.changes || []
  if (changes.length === 0) return { phase: 'empty', data: result }
  return { phase: 'ready', data: result }
}

function ChangeRow({ change }: { change: GitChange }) {
  const config = STATUS_CONFIG[change.status]
  return (
    // 行几何与侧栏任务行（WorkspaceSidebar 的 px-3 py-2.5 rounded-lg）对到同一
    // 8px 网格档：此前的 px-3 py-1.5 + mx-1 是两套口径混用（水平外边距把行推到
    // px-4 起、纵向又比侧栏矮一档），与相邻面板切换时整列行高跳变。mx-1 已删。
    <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-surface-hover transition-colors">
      <span
        className="w-5 h-5 rounded-md text-[11px] font-semibold leading-none flex items-center justify-center shrink-0"
        style={{
          // 此前是 config.color + '20'，拼出来的是 var(--color-git-modified)20
          // 这种非法颜色值，整块底色不渲染，只剩一个彩色字母裸奔。color-mix 是
          // 合法语法，百分比独立可调，不必再往颜色值尾巴上拼十六进制。
          backgroundColor: `color-mix(in srgb, ${config.color} 16%, transparent)`,
          // 内描边补一层存在感：浅色主题下 16% 的橙/红混色接近纸白，只靠底色
          // 徽章会糊成一个点。
          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${config.color} 32%, transparent)`,
          color: config.color,
        }}
      >
        {config.letter}
      </span>
      <span
        className="text-xs font-mono text-foreground/80 truncate flex-1 min-w-0"
        title={change.path}
        dir="ltr"
      >
        {change.path}
      </span>
      <span className="text-xs shrink-0" style={{ color: config.color }}>
        {KIND_LABEL[change.status]}
      </span>
    </div>
  )
}

function Section({ title, changes }: { title: string; changes: GitChange[] }) {
  if (changes.length === 0) return null
  return (
    <div>
      {/* 节头左缘与行内徽章对齐（同行 px-3），此前的 px-4 比下面所有行右移一格。 */}
      <div className="flex items-baseline gap-2 px-3 pt-3 pb-1.5">
        <span className="text-xs font-medium text-foreground">{title}</span>
        <span className="text-xs tabular-nums text-foreground-muted">{changes.length}</span>
      </div>
      <div className="space-y-0.5 pb-0.5">
        {changes.map((c) => (
          <ChangeRow key={`${c.staged ? 's' : 'u'}:${c.path}`} change={c} />
        ))}
      </div>
    </div>
  )
}

export function GitPanel() {
  const [state, setState] = useState<PanelState>({ phase: 'loading' })
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    const api = (window as unknown as {
      __KHYOS__?: { gitStatus?: () => Promise<GitStatusResult> }
    }).__KHYOS__
    if (!api?.gitStatus) {
      setState({ phase: 'error', message: 'preload 未注入：__KHYOS__ 不可用，请重启应用' })
      return
    }
    try {
      const result = await api.gitStatus()
      setState(classify(result))
    } catch (err) {
      setState(classify(null, err))
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="h-full flex flex-col">
      {/* 头部：分支选择器 + 刷新（git.action.refresh） */}
      <div className="flex items-center gap-2 px-3 h-11 border-b border-border shrink-0">
        {state.phase === 'ready' && (
          <>
            {/* 分支名可点击 → 打开分支选择器（此前只是只读文字，用户看得见
                分支却换不了；分支判据由后端 git 领域服务承担）。 */}
            <BranchSwitcher
              currentBranch={state.data.branch}
              onSwitched={() => {
                setRefreshing(true)
                void load()
              }}
            />
            {/* ↑/↓ 计数标记按设计方案 §3.1 豁免表保留字符（与数字并排的记号，
                换成图标反而读不成 "领先几个/落后几个"）。 */}
            {state.data.ahead !== undefined && state.data.behind !== undefined && (
              <span className="text-xs tabular-nums text-foreground-muted">
                (↑{state.data.ahead} ↓{state.data.behind})
              </span>
            )}
          </>
        )}
        <div className="flex-1" />
        <button
          onClick={() => {
            setRefreshing(true)
            void load()
          }}
          disabled={refreshing}
          className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-surface-hover text-foreground-muted hover:text-foreground transition-colors disabled:opacity-40"
          title="刷新"
          aria-label="刷新"
        >
          {refreshing ? (
            <Spinner size="sm" />
          ) : (
            /* 此前是面板内手写的一枚 inline SVG（strokeWidth 1.4），与全应用的
               Icon 注册表描边 1.6 不一致；改走注册表的 reload 字形。 */
            <Icon name="reload" size={14} />
          )}
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {state.phase === 'loading' && (
          <div className="flex flex-col items-center justify-center h-full text-center px-8 animate-fade-in">
            <Spinner size="md" />
            <p className="text-sm text-foreground-muted mt-3">正在读取当前工作区的 Git 状态和文件改动。</p>
          </div>
        )}

        {state.phase === 'gitUnavailable' && (
          <EmptyState
            icon="warning"
            title="当前环境没有可用的 Git"
            description="请先安装 Git，或确认当前运行环境里可以执行 git 命令。"
          />
        )}

        {state.phase === 'notRepository' && (
          <EmptyState
            icon="folder"
            title="当前工作区不在 Git 仓库中"
            description="打开一个 Git 仓库目录后，这里会展示当前工作区作用域内的改动。"
          />
        )}

        {state.phase === 'error' && (
          <EmptyState
            icon="warning"
            title="无法加载 Git 改动"
            description={`Git 返回错误：${state.message}`}
          />
        )}

        {state.phase === 'empty' && (
          <EmptyState
            icon="check"
            title="当前来源下没有可展示的改动"
            description="可以切换其它来源，或等当前工作区产生新的 Git 改动后再查看。"
          />
        )}

        {state.phase === 'ready' && (
          <div className="pb-3">
            {/* git.section.* 三节：已暂存 / 未暂存 / 未跟踪 */}
            <Section
              title="已暂存"
              changes={(state.data.changes || []).filter((c) => c.staged)}
            />
            <Section
              title="未暂存"
              changes={(state.data.changes || []).filter((c) => !c.staged && c.status !== 'untracked')}
            />
            <Section
              title="未跟踪"
              changes={(state.data.changes || []).filter((c) => c.status === 'untracked')}
            />
          </div>
        )}
      </div>
    </div>
  )
}
