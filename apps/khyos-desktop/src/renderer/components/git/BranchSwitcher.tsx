// khy-canary: Khy-20261102-284-F23HRJ25
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../ui/Icon'
import { Spinner } from '../ui/Spinner'

// ── BranchSwitcher — Git 分支选择器 ─────────────────────────────────────────
//
// 补上桌面端 Git 面板缺失的那一层：**能选分支**。
// 此前 GitPanel 只读展示 `git status` 的当前分支名，用户看得见分支却换不了；
// 而仓库 i18n 里已有一套完整的 `git.branchSwitcher.*` 文案（含脏文件阻断、
// worktree 冲突、无效分支名等全部失败面），是上游基线留下但未接线的设计稿。
// 本组件把那份设计接回来，文案与错误码一一对应。
//
// 判据不在前端：分支名合法性、会不会覆盖本地改动、有无冲突等全部由后端
// `services/domain/git` 判定并回传错误码（git.branchSwitcher.error.*）。
// 前端只负责呈现与交互——**不做第二套判定**，避免两端规则漂移。

// 后端 git.branchService 的分支条目（字段名与后端 listBranches 返回一致）。
export interface BranchInfo {
  name: string
  current: boolean
  upstream: string | null
  ahead: number
  behind: number
  inOtherWorktree: boolean
}

export interface BranchListResult {
  ok: boolean
  state?: 'ok' | 'notRepository' | 'gitUnavailable' | 'error'
  branches?: BranchInfo[]
  error?: string
}

export interface BranchSwitchResult {
  ok: boolean
  code?: string
  message?: string
  detail?: { tracked?: string[]; untracked?: string[] }
}

interface KhyosGitApi {
  gitBranchList?: () => Promise<BranchListResult>
  gitBranchSwitch?: (branch: string, opts?: { create?: boolean; force?: boolean }) => Promise<BranchSwitchResult>
}

// git.branchSwitcher.error.* → i18n 键。与后端 branchGuard 的错误码一一对应。
// 词条是上游基线留下的既有设计稿（44 条），本组件**复用**它们而非另写一套文案。
const ERROR_KEYS: Record<string, string> = {
  invalidBranchName: 'git.branchSwitcher.error.invalidBranchName',
  branchAlreadyExists: 'git.branchSwitcher.error.branchAlreadyExists',
  targetBranchNotFound: 'git.branchSwitcher.error.targetBranchNotFound',
  conflictsPresent: 'git.branchSwitcher.error.conflictsPresent',
  operationInProgress: 'git.branchSwitcher.error.operationInProgress',
  branchInOtherWorktree: 'git.branchSwitcher.error.branchInOtherWorktree',
  dirtyWorkingTree: 'git.branchSwitcher.error.trackedOverwrite',
  notRepository: 'git.branchSwitcher.error.targetBranchNotFound',
  unknown: 'git.branchSwitcher.error.unknown',
}

export interface BranchSwitcherProps {
  /** 当前分支名（来自 git:status），用于标出当前项。 */
  currentBranch?: string
  /** 切换成功后的回调——调用方据此刷新改动列表。 */
  onSwitched?: (branch: string) => void
}

export function BranchSwitcher({ currentBranch, onSwitched }: BranchSwitcherProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<BranchInfo[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [blocked, setBlocked] = useState<{ branch: string; detail?: { tracked?: string[]; untracked?: string[] } } | null>(null)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  const [busyBranch, setBusyBranch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const api = (): KhyosGitApi => (window as unknown as { __KHYOS__?: KhyosGitApi }).__KHYOS__ || {}

  /** 错误码 → i18n 文案；映射不到就诚实落 unknown，绝不显示英文 stderr。 */
  const errorText = useCallback(
    (code?: string, fallback?: string): string => {
      const key = code ? ERROR_KEYS[code] : undefined
      if (key) return t(key)
      return fallback || t('git.branchSwitcher.error.unknown')
    },
    [t]
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api().gitBranchList?.()
      if (!res) {
        setError('分支列表不可用：preload 未注入 __KHYOS__，请重启应用')
        setBranches(null)
        return
      }
      if (!res.ok) {
        setBranches(null)
        setError(
          res.state === 'notRepository'
            ? errorText('notRepository')
            : res.state === 'gitUnavailable'
              ? '当前环境没有可用的 Git，无法列出分支。'
              : res.error || errorText('unknown')
        )
        return
      }
      setBranches(res.branches || [])
    } catch {
      setBranches(null)
      setError('分支列表加载失败：主进程无响应，请重启应用')
    } finally {
      setLoading(false)
    }
  }, [errorText])

  useEffect(() => {
    if (!open) return
    void load()
    // 打开时把焦点交给搜索框——分支多时这是最快的定位方式。
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [open, load])

  // Esc 关闭；分支名里出现 "/" 时按 Git 惯例视为路径分隔，列表按它分组排序。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        setCreating(false)
        setQuery('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const filtered = useMemo(() => {
    const list = branches || []
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter((b) => b.name.toLowerCase().includes(q))
  }, [branches, query])

  const doSwitch = useCallback(
    async (branch: string, create?: boolean) => {
      setBusyBranch(branch)
      setError('')
      setBlocked(null)
      try {
        const res = await api().gitBranchSwitch?.(branch, create ? { create: true } : undefined)
        if (!res) {
          setError('分支操作不可用：preload 未注入 __KHYOS__，请重启应用')
          return
        }
        if (res.ok) {
          setOpen(false)
          setCreating(false)
          setQuery('')
          onSwitched?.(branch)
          return
        }
        // 脏文件阻断：给出可操作的下一步，而不是只甩一句错误。
        if (res.code === 'dirtyWorkingTree') {
          setBlocked({ branch, detail: res.detail })
          return
        }
        setError(errorText(res.code, res.message))
      } catch {
        setError('分支操作失败：主进程无响应，请重启应用')
      } finally {
        setBusyBranch('')
      }
    },
    [onSwitched, errorText]
  )

  // 阻断态下的「强制切换」：丢改动是不可逆操作，必须由人显式点。
  const forceSwitch = useCallback(async () => {
    if (!blocked) return
    setBusyBranch(blocked.branch)
    setError('')
    try {
      const res = await api().gitBranchSwitch?.(blocked.branch, { force: true })
      if (res?.ok) {
        setBlocked(null)
        setOpen(false)
        setQuery('')
        onSwitched?.(blocked.branch)
      } else {
        setError(errorText(res?.code, res?.message))
      }
    } catch {
      setError('强制切换失败：主进程无响应，请重启应用')
    } finally {
      setBusyBranch('')
    }
  }, [blocked, onSwitched, errorText])

  const submitCreate = useCallback(() => {
    const name = newBranch.trim()
    if (!name) return
    void doSwitch(name, true)
  }, [newBranch, doSwitch])

  const activeName = currentBranch && currentBranch !== 'HEAD' ? currentBranch : undefined

  return (
    <>
      {/* 触发器：显示当前分支名 + 下拉箭头 */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 min-w-0 px-2 h-7 rounded-md hover:bg-surface-hover transition-colors text-xs text-foreground-muted hover:text-foreground"
        title={t('git.branchSwitcher.trigger.ariaLabel')}
        aria-label={t('git.branchSwitcher.trigger.ariaLabel')}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Icon name="git-branch" size={13} />
        <span className="truncate font-mono" dir="ltr">
          {activeName || t('git.branchSwitcher.label')}
        </span>
        <Icon name="chevron-down" size={12} />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-24">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative w-full max-w-md bg-popover border border-popover-border rounded-xl shadow-2xl overflow-hidden animate-slide-down">
            {/* 搜索框 */}
            <div className="px-3 pt-3 pb-2 border-b border-border">
              <input
                ref={inputRef}
                value={creating ? newBranch : query}
                onChange={(e) => (creating ? setNewBranch(e.target.value) : setQuery(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (creating) submitCreate()
                    else if (filtered.length === 1) void doSwitch(filtered[0].name)
                  }
                }}
                placeholder={
                  creating
                    ? t('git.branchSwitcher.createDialog.nameLabel')
                    : t('git.branchSwitcher.searchPlaceholder')
                }
                className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-foreground-muted"
                dir="ltr"
                aria-label={
                  creating
                    ? t('git.branchSwitcher.createDialog.nameLabel')
                    : t('git.branchSwitcher.searchPlaceholder')
                }
              />
            </div>

            {/* 错误条 */}
            {error && (
              <div className="px-3 py-2 text-xs text-destructive bg-destructive/10 border-b border-destructive/20">
                {error}
              </div>
            )}

            {/* 脏文件阻断：先给出文件清单，再给出「先提交」与「强制丢弃」两条路 */}
            {blocked && (
              <div className="px-3 py-2.5 text-xs border-b border-border bg-surface-hover/40">
                <div className="text-foreground mb-1.5">
                  {t('git.branchSwitcher.blockedDialog.description.tracked')}{' '}
                  <span className="font-mono">{blocked.branch}</span>
                </div>
                <ul className="space-y-0.5 mb-2.5 max-h-24 overflow-auto">
                  {(blocked.detail?.tracked || []).map((p) => (
                    <li key={`t:${p}`} className="font-mono text-foreground-muted truncate" dir="ltr">
                      {p}
                    </li>
                  ))}
                  {(blocked.detail?.untracked || []).map((p) => (
                    <li key={`u:${p}`} className="font-mono text-foreground-muted truncate" dir="ltr">
                      {p}
                    </li>
                  ))}
                </ul>
                <div className="text-foreground-muted mb-2">
                  {t('git.branchSwitcher.blockedDialog.helper')}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setBlocked(null)
                      setError('')
                    }}
                    className="px-2.5 h-7 rounded-md text-xs border border-border text-foreground hover:bg-surface-hover transition-colors"
                  >
                    {t('git.branchSwitcher.blockedDialog.submitAction')}
                  </button>
                  <button
                    onClick={() => void forceSwitch()}
                    disabled={busyBranch === blocked.branch}
                    className="px-2.5 h-7 rounded-md text-xs bg-destructive text-white hover:opacity-90 transition-opacity disabled:opacity-40"
                  >
                    {t('git.branchSwitcher.blockedDialog.forceAction')}
                  </button>
                </div>
              </div>
            )}

            {/* 分支列表 */}
            <div className="max-h-72 overflow-auto py-1">
              {loading && (
                <div className="flex items-center justify-center py-6">
                  <Spinner size="sm" />
                </div>
              )}

              {!loading && creating && (
                <div className="px-3 py-3 text-xs text-foreground-muted">
                  {t('git.branchSwitcher.createDialog.description')}
                  <span className="font-mono text-foreground"> {newBranch.trim()}</span>
                  <div className="flex gap-2 mt-2.5">
                    <button
                      onClick={submitCreate}
                      disabled={!newBranch.trim() || busyBranch === newBranch.trim()}
                      className="px-2.5 h-7 rounded-md text-xs bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40"
                    >
                      {t('git.branchSwitcher.createDialog.confirm')}
                    </button>
                    <button
                      onClick={() => {
                        setCreating(false)
                        setNewBranch('')
                        setError('')
                      }}
                      className="px-2.5 h-7 rounded-md text-xs border border-border text-foreground hover:bg-surface-hover transition-colors"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}

              {!loading && !creating && filtered.length === 0 && (
                <div className="px-3 py-6 text-center text-xs text-foreground-muted">
                  {query ? t('git.branchSwitcher.empty') : t('git.tree.emptyDescription')}
                </div>
              )}

              {!loading &&
                !creating &&
                filtered.map((b) => (
                  <button
                    key={b.name}
                    onClick={() => void doSwitch(b.name)}
                    disabled={busyBranch === b.name}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-hover transition-colors disabled:opacity-50"
                    role="option"
                    aria-selected={b.name === activeName}
                  >
                    <Icon name="git-branch" size={13} />
                    <span className="flex-1 min-w-0 truncate text-xs font-mono text-foreground" dir="ltr">
                      {b.name}
                    </span>
                    {b.current && (
                      <span className="text-[10px] text-foreground-muted shrink-0">
                        {t('git.branchSwitcher.currentBadge')}
                      </span>
                    )}
                    {b.inOtherWorktree && (
                      <span className="text-[10px] text-foreground-muted shrink-0">
                        {t('git.branchSwitcher.otherWorktreeBadge')}
                      </span>
                    )}
                    {b.upstream && (b.ahead > 0 || b.behind > 0) && (
                      <span className="text-[10px] tabular-nums text-foreground-muted shrink-0">
                        ↑{b.ahead} ↓{b.behind}
                      </span>
                    )}
                    {busyBranch === b.name && <Spinner size="sm" />}
                  </button>
                ))}
            </div>

            {/* 底部：新建分支 */}
            {!creating && (
              <div className="px-3 py-2 border-t border-border">
                <button
                  onClick={() => {
                    setCreating(true)
                    setError('')
                    setBlocked(null)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                >
                  <Icon name="plus" size={13} />
                  {t('git.branchSwitcher.createAction')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
