import { useEffect, useRef, useState } from 'react'
import { errText, Notice, type Capability } from './amoonShared'

// amoo 秘书面板的共享记忆区。从 AmooSecretaryPane 拆出的原因：面板单组件体量
// 超过新增文件 maxFuncLines=300 的闸门（B1），而记忆区是唯一能整块剥离的节——
// 提问/等回答与记忆互不共享状态，只共享 capability 与 memoryLimits 两个入参。
// 数据仍只走 window.__KHYOS__.amooSecretaryMemory；本组件不 fetch、不读文件。

// One shared-memory fact as the phone reported it. confidence/provenance are
// the phone's own fields, carried through untouched.
export type MemoryEntry = {
  id: string
  text: string
  confidence: string
  provenance: string
}

export type MemoryResult =
  | {
      ok: true
      entries?: MemoryEntry[]
      entryCount?: number
      verifiedCount?: number
      unverifiedCount?: number
      partial?: boolean
      message?: string
    }
  | { ok: false; error: { code: string; message: string } }

// The write-form caps, read from the probe reply (status.memoryLimits) — the
// lane derives them from the backend catalog and this pane keeps no copy of
// the numbers. Undefined = the probe reply did not carry them (catalog
// unreadable this session): writing is disabled and said so, never guessed.
export type MemoryLimits = { id: number; text: number; provenance: number }

// ── shared memory (amoo_memory: call-only, never a second copy) ───────────
// The memory's only holder is the phone (/sdcard/bridge-amoobridge/
// amoo_memory.json). The desktop writes no second file and caches no get
// result — every 「读取」 is a real bridge call.
const DESKTOP_PROVENANCE = 'desktop'

type MemoryView =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'writing' }
  | {
      kind: 'get'
      entries: MemoryEntry[]
      entryCount: number
      verifiedCount: number
      unverifiedCount: number
      partial: boolean
      message?: string
    }
  | { kind: 'set'; entryCount: number; verifiedCount: number; message?: string }
  | { kind: 'error'; message: string }

type MemoryChannel = {
  amooSecretaryMemory: (input: {
    op: 'get' | 'set'
    id?: string
    text?: string
    verified?: boolean
    provenance?: string
  }) => Promise<MemoryResult>
}

function api(): MemoryChannel | null {
  return ((window as unknown) as { __KHYOS__?: MemoryChannel }).__KHYOS__ || null
}

function MemoryDisabledNotice({ capability }: { capability: Capability }) {
  if (capability === 'offline' || capability === 'missing') {
    return (
      <Notice tone="red">
        <div className="font-medium">手机桥不在线</div>
        <div className="mt-1 text-foreground-muted">
          共享记忆的读取与写入都已停用。确认手机与桌面端已连接、桥 daemon 在运行，修好后点「刷新」。
        </div>
      </Notice>
    )
  }
  if (capability === 'off') {
    return (
      <Notice tone="amber">
        <div className="font-medium">桥上未报到助手协同能力</div>
        <div className="mt-1 text-foreground-muted">这一组能力整组随 Amoo 安装态关闭，不是单个开关没打开。装好后点「刷新」重试。</div>
      </Notice>
    )
  }
  return (
    <Notice tone="amber">
      <div className="font-medium">桥未报到，能力未知</div>
      <div className="mt-1 text-foreground-muted">
        桥没有回答这一组能力是否可用。没报到不等于没有，先按不可用处理：读取与写入都已停用，点「刷新」重试。
      </div>
    </Notice>
  )
}

function MemoryEntryRow({ entry }: { entry: MemoryEntry }) {
  // A desktop-written entry always shows 未验证: provenance is pinned to
  // 'desktop', which means a human typed it into the form — not that a command
  // the phone executed verified it. Ticking 「标为已核实」 does not launder a
  // manual assertion into a machine measurement here (the same reason
  // phoneBridgeCatalog defaults the verified arg to false). The phone's own
  // verified entries keep their 已核实 badge.
  const desktopWritten = entry.provenance === DESKTOP_PROVENANCE
  const verified = !desktopWritten && entry.confidence === 'verified'
  return (
    <li className="rounded-lg border border-border/50 px-2.5 py-2">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="truncate font-medium text-foreground/80" title={entry.id}>
          {entry.id || '—'}
        </span>
        <span
          className={`rounded px-1.5 py-0.5 ${
            verified ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
          }`}
        >
          {verified ? '已核实' : '未验证'}
        </span>
        {entry.provenance ? (
          <span className="ml-auto truncate text-foreground-muted" title={entry.provenance}>
            来源：{entry.provenance}
          </span>
        ) : null}
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-foreground/75">{entry.text}</p>
    </li>
  )
}

function MemoryGetView({ view }: { view: Extract<MemoryView, { kind: 'get' }> }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-foreground-muted">
        桥上计：共 {view.entryCount} 条 · 已核实 {view.verifiedCount} 条 · 未验证 {view.unverifiedCount} 条
      </p>
      {view.partial ? <Notice tone="amber">{view.message || '记忆文档不完整：下面不是全部条目。'}</Notice> : null}
      {view.entries.length === 0 && !view.partial ? (
        <p className="text-[11px] text-foreground-muted">手机上还没有共享记忆条目。</p>
      ) : null}
      {view.entries.length > 0 ? (
        <ul className="space-y-1.5">
          {view.entries.map((entry) => (
            <MemoryEntryRow key={entry.id || entry.text} entry={entry} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function AmooSecretaryMemory({ capability, memoryLimits }: { capability: Capability; memoryLimits?: MemoryLimits }) {
  const [memId, setMemId] = useState('')
  const [memText, setMemText] = useState('')
  const [memVerified, setMemVerified] = useState(false)
  const [memView, setMemView] = useState<MemoryView>({ kind: 'idle' })
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // Shared memory: every read is a real bridge call; the result is not cached
  // on the desktop (the phone is the only holder).
  async function readMemory() {
    const a = api()
    if (!a || !a.amooSecretaryMemory) return
    setMemView({ kind: 'reading' })
    try {
      const r = await a.amooSecretaryMemory({ op: 'get' })
      if (!alive.current) return
      if (r && r.ok === true) {
        setMemView({
          kind: 'get',
          entries: Array.isArray(r.entries) ? r.entries : [],
          entryCount: typeof r.entryCount === 'number' ? r.entryCount : 0,
          verifiedCount: typeof r.verifiedCount === 'number' ? r.verifiedCount : 0,
          unverifiedCount: typeof r.unverifiedCount === 'number' ? r.unverifiedCount : 0,
          partial: r.partial === true,
          ...(r.message ? { message: r.message } : {}),
        })
      } else {
        setMemView({ kind: 'error', message: errText(r, '读取共享记忆失败') })
      }
    } catch (err) {
      if (alive.current) setMemView({ kind: 'error', message: `读取共享记忆失败：${String((err as Error).message || err)}` })
    }
  }

  async function writeMemory() {
    const a = api()
    if (!a || !a.amooSecretaryMemory) return
    const id = memId.trim()
    const text = memText.trim()
    if (!id || !text) return
    setMemView({ kind: 'writing' })
    try {
      // provenance is pinned to 'desktop' so every desktop write carries its
      // source and the UI can keep it 未验证. verified comes from the
      // checkbox and defaults to unchecked.
      const r = await a.amooSecretaryMemory({ op: 'set', id, text, verified: memVerified, provenance: DESKTOP_PROVENANCE })
      if (!alive.current) return
      if (r && r.ok === true) {
        setMemView({
          kind: 'set',
          entryCount: typeof r.entryCount === 'number' ? r.entryCount : 0,
          verifiedCount: typeof r.verifiedCount === 'number' ? r.verifiedCount : 0,
          ...(r.message ? { message: r.message } : {}),
        })
        setMemText('')
      } else {
        setMemView({ kind: 'error', message: errText(r, '写入共享记忆失败') })
      }
    } catch (err) {
      if (alive.current) setMemView({ kind: 'error', message: `写入共享记忆失败：${String((err as Error).message || err)}` })
    }
  }

  // Shared memory: call-only. No second memory file on the desktop, no cached
  // get result.
  return (
    <div className="space-y-2 border-t border-border/60 pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">共享记忆</span>
        <button
          className="text-[11px] text-foreground-muted hover:text-foreground disabled:opacity-40"
          onClick={() => void readMemory()}
          disabled={capability !== 'on' || memView.kind === 'reading'}
          title={capability === 'on' ? undefined : '能力未就绪：先看上面的说明'}
        >
          {memView.kind === 'reading' ? '读取中…' : '读取'}
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-foreground-muted">
        记忆只存在手机（/sdcard/bridge-amoobridge/amoo_memory.json），桌面只读只写这一份，不另存、不缓存。
        「已核实」只能由手机侧命令验证通过后写入；桌面手工写入的条目在这里恒记「未验证」。
      </p>

      {capability !== 'on' ? <MemoryDisabledNotice capability={capability} /> : null}

      {memView.kind === 'idle' ? (
        <p className="text-[11px] text-foreground-muted">还没有读取过。点「读取」查看手机上的共享记忆。</p>
      ) : null}
      {memView.kind === 'get' ? <MemoryGetView view={memView} /> : null}
      {memView.kind === 'set' ? (
        <div className="space-y-1 rounded-lg border border-border/60 bg-surface-hover/40 px-2.5 py-2 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400">桥上已接受这次写入</span>
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">未验证</span>
          </div>
          <p className="leading-relaxed text-foreground-muted">
            {memView.message || '写入回执不带送达证明：手机侧落盘失败会被静默忽略。'}
          </p>
          <p className="text-foreground-muted">
            当前共 {memView.entryCount} 条 · 已核实 {memView.verifiedCount} 条（桥上计）
          </p>
        </div>
      ) : null}
      {memView.kind === 'error' ? <Notice tone="red">{memView.message}</Notice> : null}

      <div className="space-y-2 border-t border-border/60 pt-3">
        <span className="text-xs font-medium">写入一条</span>
        {capability === 'on' && !memoryLimits ? (
          <Notice tone="amber">
            <div className="font-medium">未取得共享记忆的规格上限</div>
            <div className="mt-1 text-foreground-muted">
              本次探测回包没有携带 amoo_memory 的字数上限，写入已停用；读取不受影响。
              常见原因是桌面侧规格目录加载失败或后端版本过旧，重启桌面端后点「刷新」重试。
            </div>
          </Notice>
        ) : null}
        <input
          value={memId}
          onChange={(e) => setMemId(e.target.value)}
          placeholder="id（稳定键，同 id 覆盖）"
          disabled={capability !== 'on' || !memoryLimits || memView.kind === 'writing'}
          className="w-full rounded-lg border border-border bg-transparent px-2.5 py-2 text-xs outline-none placeholder:text-foreground-muted focus:border-brand/60 disabled:opacity-50"
        />
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-foreground-muted">内容，一行</span>
          {memoryLimits ? (
            <span className={`text-[11px] ${memText.length > memoryLimits.text ? 'text-red-400' : 'text-foreground-muted'}`}>
              {memText.length}/{memoryLimits.text}
            </span>
          ) : null}
        </div>
        <textarea
          value={memText}
          onChange={(e) => setMemText(e.target.value)}
          rows={2}
          placeholder={capability === 'on' ? '要记住的一条事实' : '能力未就绪：先看上面的说明'}
          disabled={capability !== 'on' || !memoryLimits || memView.kind === 'writing'}
          className="w-full resize-none rounded-lg border border-border bg-transparent px-2.5 py-2 text-xs outline-none placeholder:text-foreground-muted focus:border-brand/60 disabled:opacity-50"
        />
        <label className="flex items-center gap-2 text-[11px] text-foreground-muted">
          <input
            type="checkbox"
            checked={memVerified}
            onChange={(e) => setMemVerified(e.target.checked)}
            disabled={capability !== 'on' || !memoryLimits || memView.kind === 'writing'}
          />
          标为已核实
        </label>
        <p className="text-[11px] leading-relaxed text-foreground-muted">
          来源固定记录为 desktop。手工设置不该冒充满测量结果：勾选后手机侧会把它当作已核实前提，桌面展示仍记「未验证」。
        </p>
        <button
          className="w-full rounded-lg bg-brand px-3 py-2 text-xs font-medium text-white hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => void writeMemory()}
          disabled={
            capability !== 'on' ||
            !memoryLimits ||
            memView.kind === 'writing' ||
            memId.trim().length === 0 ||
            memText.trim().length === 0 ||
            memId.length > memoryLimits.id ||
            memText.length > memoryLimits.text
          }
        >
          {memView.kind === 'writing' ? '写入中…' : '写入共享记忆'}
        </button>
      </div>
    </div>
  )
}
