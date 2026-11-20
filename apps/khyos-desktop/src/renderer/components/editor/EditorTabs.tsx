import { Icon, type IconName } from '../ui/Icon'

export interface EditorTabView {
  filePath: string
  name: string
  dirty: boolean
  /** 读取失败 / 过大 / 二进制：标签仍可关闭，但不进编辑器 */
  blocked: boolean
}

interface EditorTabsProps {
  tabs: EditorTabView[]
  activePath: string
  onSelect: (filePath: string) => void
  onClose: (filePath: string) => void
}

const TAB_ICONS: Record<string, IconName> = {
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code',
  vue: 'code', json: 'file', md: 'doc', css: 'file', html: 'file',
  py: 'file', sh: 'terminal', yml: 'terminal', yaml: 'terminal', toml: 'terminal',
}

function tabIcon(name: string): IconName {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return TAB_ICONS[ext] ?? 'file'
}

export function EditorTabs({ tabs, activePath, onSelect, onClose }: EditorTabsProps) {
  return (
    <div role="tablist" className="flex items-stretch h-9 shrink-0 border-b border-border bg-surface/50 overflow-x-auto select-none">
      {tabs.map((tab) => {
        const active = tab.filePath === activePath
        return (
          <div
            key={tab.filePath}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => onSelect(tab.filePath)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(tab.filePath)
              }
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                onClose(tab.filePath)
              }
            }}
            title={tab.filePath}
            className={`group relative flex items-center gap-1.5 pl-2.5 pr-1.5 text-xs cursor-pointer border-r border-border transition-colors shrink-0 max-w-[220px] ${
              active ? 'bg-background text-foreground' : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground'
            }`}
          >
            <span className={tab.blocked ? 'text-destructive' : 'text-foreground-subtle'}>
              <Icon name={tab.blocked ? 'warning' : tabIcon(tab.name)} size={12} />
            </span>
            <span className="truncate">{tab.name}</span>
            {tab.dirty && <span className="w-1.5 h-1.5 rounded-full bg-brand shrink-0" aria-label="未保存" />}
            <button
              onClick={(e) => {
                e.stopPropagation()
                onClose(tab.filePath)
              }}
              className="w-5 h-5 rounded flex items-center justify-center text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors shrink-0"
              title={`关闭 ${tab.name}`}
              aria-label={`关闭 ${tab.name}`}
            >
              <Icon name="close" size={11} />
            </button>
            {active && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-brand" aria-hidden="true" />}
          </div>
        )
      })}
      <div className="flex-1" />
    </div>
  )
}
