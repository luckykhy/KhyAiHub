// khy-canary: Khy-20261119-501-Q7XB4M2K
// ModelsPage — 模型管理（受管模型列表，hash 路由 #/model-manager，独立窗口同 hash）。
//
// 与 KeyManagerPage 的分工：那边维护「端点卡片 + 密钥 + 协议」（Card 是容器，
// T2 端点预设 / T1 Provider 与密钥），本页把 Card.models[] 与 Card.defaultModel
// 收成一张「受管模型列表」——逐条增、删、改、设默认、测连通，并一键
// 「应用到 Claude Code」。
//
// 数据不新建存储：受管条目是 cc_switch.json 卡片的派生视图（main 侧
// listManagedModels 每次现算），增删改全部落回 Card.models[]/defaultModel
// （既有 updateCard 白名单），应用走既有 agentWriters.applyProxyMode /
// applyDirectMode，代理态走既有 proxyStatus。本页只经 keyManager/api.ts 的
// KhyOsApi 消费，渲染层不碰明文 key（models:catalog 由 main 按 cardId 解析）。
//
// 七个数据通道（models:managed / add / update / remove / apply / probe /
// catalog）由 main/keyManager/ipc.ts 注册、preload 以字面量 invoke 暴露；
// 窗口通道 models:openWindow 由 main/index.ts 注册。均不在本文件声明，
// 按 pinnedContract 的名字消费，不自建第二套。

import { useCallback, useEffect, useState } from 'react'
import {
  khyosApi,
  type Card,
  type ManagedModel,
  type ManagedModelsResult,
  type ModelsCatalogResult,
  type ModelsProbeResult,
  type ProxyState
} from '../../keyManager/api'
import { Icon } from '../ui/Icon'

// 探针结果徽标：status 分类与 main 侧 health.ts classify 同口径
// （2xx→ok；401/403→auth；429→rate；5xx→upstream；另有 timeout）。
// 纯内存态（不落盘）：刷新页面即重新探测，不假装「历史上通过」。
const PROBE_LABEL: Record<ModelsProbeResult['status'], string> = {
  ok: '连通',
  auth: '鉴权失败',
  rate: '限流',
  upstream: '上游错误',
  timeout: '超时'
}

const PROBE_CLS: Record<ModelsProbeResult['status'], string> = {
  ok: 'border-success/30 text-success bg-success/10',
  auth: 'border-destructive/30 text-destructive bg-destructive/10',
  rate: 'border-warning/30 text-warning bg-warning/10',
  upstream: 'border-warning/30 text-warning bg-warning/10',
  timeout: 'border-card-border text-foreground-muted bg-input'
}

// 非 anthropic 线卡片禁「应用（直连）」时附的文案：与 agentWriters.ts
// preflight(claude-code, direct) 的 warning 同一句（OpenAI 线必须经 khy
// 代理转 anthropic 线，直连过去 Claude Code 读不懂）。
const DIRECT_BLOCKED_HINT =
  '卡片为 OpenAI 线，Claude Code 需经 khy 代理转 anthropic 线（建议 Mode B 聚合模式）：「应用（直连）」已禁用，请用「应用到 Claude Code」'

// Claude Code 的期望管理：启动时读 settings.json，本页不做热切换。
const CC_RESTART_HINT = '重启 Claude Code 或新开会话生效'

type CcState = ManagedModelsResult['cc']

interface CatalogState extends ModelsCatalogResult {
  cardId: string
}

interface EditState {
  cardId: string
  from: string
  to: string
  makeDefault: boolean
}

// ── shared bits ──────────────────────────────────────────────────────────────

function Notice({ kind, children }: { kind: 'ok' | 'err' | 'info'; children: React.ReactNode }) {
  const cls =
    kind === 'ok'
      ? 'border-success/40 text-success bg-success/10'
      : kind === 'err'
        ? 'border-destructive/40 text-destructive bg-destructive/10'
        : 'border-card-border text-foreground/70 bg-input'
  return <div className={`text-xs rounded-lg border px-3 py-2 my-2 ${cls}`}>{children}</div>
}

// 统一小徽标：默认 / CC 当前 / 协议 / 探针状态共用一套形态。
function Badge({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={`text-xs px-1.5 py-0.5 rounded border ${className}`}>{children}</span>
}

export function ModelsPage({ standalone = false }: { standalone?: boolean }) {
  const api = khyosApi()
  if (!api) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-foreground-muted bg-panel">
        模型管理模块不可用：preload 未就绪，请重启 KhyOS 桌面端
      </div>
    )
  }
  return <ModelsPane api={api} standalone={standalone} />
}

function ModelsPane({
  api,
  standalone = false
}: {
  api: NonNullable<ReturnType<typeof khyosApi>>
  standalone?: boolean
}) {
  const [tick, setTick] = useState(0)
  const bump = useCallback(() => setTick((t) => t + 1), [])
  const [loading, setLoading] = useState(true)
  // 块3 主数据：受管模型列表（models:managed 是唯一数据源）
  const [models, setModels] = useState<ManagedModel[]>([])
  const [cc, setCc] = useState<CcState | null>(null)
  // 块4 卡片下拉：cards:list 一次拿到卡片（含 protocol / models / defaultModel）
  const [cards, setCards] = useState<Card[]>([])
  // 块1 网关态：proxyStatus()（带 /health 探活），与 probe 的代理态判定同源
  const [proxy, setProxy] = useState<ProxyState | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState('')
  // 块3 行内探针状态（内存态，不落盘）
  const [probes, setProbes] = useState<Record<string, ModelsProbeResult>>({})
  // 块4 新增表单
  const [addCardId, setAddCardId] = useState('')
  const [addModel, setAddModel] = useState('')
  const [addDefault, setAddDefault] = useState(false)
  const [catalog, setCatalog] = useState<CatalogState | null>(null)
  const [picked, setPicked] = useState<Set<string>>(() => new Set<string>())
  // 块5 行内编辑 / 替换
  const [edit, setEdit] = useState<EditState | null>(null)

  // 一次拉齐三块数据：受管列表 + 卡片下拉 + 网关态。tick 变化（任何写操作后）
  // 整体重读，不维护第二份缓存。
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const mr = await api.modelsManaged()
        if (mr.ok && mr.data && !cancelled) {
          setModels(mr.data.models)
          setCc(mr.data.cc)
        }
        const cr = await api.cardsList()
        if (cr.ok && cr.data && !cancelled) setCards(cr.data.cards)
        const ps = await api.proxyStatus()
        if (ps.ok && ps.data && !cancelled) setProxy(ps.data)
      } catch (e) {
        if (!cancelled) {
          setMsg({
            kind: 'err',
            text: `加载失败：${e instanceof Error ? e.message : String(e)}（请确认主进程已注册 models:* 通道并重启桌面端）`
          })
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  const errText = (e: unknown, what: string) =>
    `${what}失败：${e instanceof Error ? e.message : String(e)}`

  // 「去端点与密钥管理」的唯一出口。主窗整屏分支跳 hash（有返回）；独立无框窗
  // （standalone）改成**再开一个独立管理窗** —— 在 frame:false 的管理窗里跳
  // #/key-manager 会把本页换成 KeyManagerPage，而它的 ✕ 是 api.closeWindow()，
  // 关掉的是本窗自己，用户得到「密钥窗 + 模型窗消失」的错位结果。
  // 顶栏按钮与块4 零卡片态的「去创建 →」共用这一个函数，不留第二条路。
  const goKeyManager = () => {
    if (standalone) {
      void api.openKeyManagerWindow?.()
      return
    }
    window.location.hash = '#/key-manager'
  }

  // ── 块1：一键启动本地网关 ──────────────────────────────────────────────────
  async function doStartProxy() {
    setBusy('proxy-start')
    setMsg(null)
    try {
      const r = await api.proxyStart()
      if (!r.ok) {
        setMsg({ kind: 'err', text: r.error || '启动失败：backend 服务不可用，请改用 khy CLI 启动网关' })
        return
      }
      setMsg({ kind: 'ok', text: `本地网关已启动：${r.data?.detail || ''}` })
      bump()
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e, '启动网关') })
    } finally {
      setBusy('')
    }
  }

  // ── 块2：撤销 Claude Code 激活（既有 agents:revert 通道） ──────────────────
  async function doRevertCc() {
    setBusy('revert')
    setMsg(null)
    try {
      const r = await api.agentsRevert('claude-code')
      if (!r.ok) {
        setMsg({ kind: 'err', text: r.error || '撤销失败' })
        return
      }
      setMsg({ kind: 'ok', text: `已撤销 Claude Code 激活：${r.data?.detail || ''}` })
      bump()
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e, '撤销激活') })
    } finally {
      setBusy('')
    }
  }

  // ── 块4：加入受管模型 ──────────────────────────────────────────────────────
  async function doAdd() {
    const model = addModel.trim()
    if (!addCardId) {
      setMsg({ kind: 'err', text: '请先选择一张端点卡片：模型条目挂在端点卡片下' })
      return
    }
    if (!model) {
      setMsg({ kind: 'err', text: '模型 id 不能为空（去空白后）' })
      return
    }
    setBusy('add')
    setMsg(null)
    try {
      const r = await api.modelsAdd({ cardId: addCardId, model, makeDefault: addDefault })
      if (!r.ok) {
        setMsg({ kind: 'err', text: r.error || '加入失败' })
        return
      }
      setMsg({ kind: 'ok', text: `已加入受管模型 ${model}${addDefault ? '（并设为默认）' : ''}` })
      setAddModel('')
      setAddDefault(false)
      bump()
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e, '加入模型') })
    } finally {
      setBusy('')
    }
  }

  // ── 块4：从端点拉模型目录（main 按 cardId 解析明文 key，渲染层不传 key） ────
  async function doCatalog() {
    if (!addCardId) {
      setMsg({ kind: 'err', text: '请先选择一张端点卡片' })
      return
    }
    setBusy('catalog')
    setMsg(null)
    try {
      const r = await api.modelsCatalog({ cardId: addCardId })
      if (!r.ok || !r.data) {
        setMsg({ kind: 'err', text: r.error || '目录拉取失败' })
        return
      }
      setCatalog({ cardId: addCardId, verified: r.data.verified, models: r.data.models, error: r.data.error })
      setPicked(new Set<string>())
      // verified:false（如非 openai 协议）的文案在下方目录区原样透显，不在此重复弹
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e, '拉取目录') })
    } finally {
      setBusy('')
    }
  }

  // ── 块4：目录勾选批量加入（已在卡片里的跳过，不让查重错误刷屏） ────────────
  async function doAddPicked() {
    const card = cards.find((c) => c.id === addCardId)
    const inCard = new Set<string>([...(card?.models || []), ...(card?.defaultModel ? [card.defaultModel] : [])])
    const fresh = catalog ? catalog.models.filter((x) => picked.has(x) && !inCard.has(x)) : []
    if (fresh.length === 0) {
      setMsg({ kind: 'err', text: '没有可新增的模型：勾选项已在卡片中，或尚未勾选' })
      return
    }
    setBusy('batch')
    setMsg(null)
    const added: string[] = []
    try {
      for (const model of fresh) {
        const r = await api.modelsAdd({ cardId: addCardId, model, makeDefault: false })
        if (r.ok) added.push(model)
      }
    } catch (e) {
      // 中途抛错也如实报已成功的条数，并刷新列表（部分成果不许看不见）
      setMsg({ kind: 'err', text: `${errText(e, '批量加入')}（已成功 ${added.length} 个，列表已刷新）` })
      bump()
      return
    } finally {
      setBusy('')
    }
    setMsg({ kind: 'ok', text: `已批量加入 ${added.length}/${fresh.length} 个模型（默认模型未改动，需要请单独设默认）` })
    setPicked(new Set<string>())
    bump()
  }

  // ── 块5：编辑 / 替换（改名 + 设默认） ─────────────────────────────────────
  async function doUpdate() {
    if (!edit) return
    const to = edit.to.trim()
    if (!to && !edit.makeDefault) {
      setMsg({ kind: 'err', text: '未指定修改内容：可改模型 id 或勾选「设为默认」' })
      return
    }
    // 原名原样提交不算改名：main 侧查重会把「目标已存在」当错误，这里先短路。
    const rename = to && to !== edit.from ? to : undefined
    setBusy('update')
    setMsg(null)
    try {
      const r = await api.modelsUpdate({ cardId: edit.cardId, from: edit.from, to: rename, makeDefault: edit.makeDefault })
      if (!r.ok) {
        setMsg({ kind: 'err', text: r.error || '保存失败' })
        return
      }
      const warn = r.data?.ccWarning ? `；${r.data.ccWarning}` : ''
      setMsg({ kind: 'ok', text: `已保存模型改动（${edit.from}${rename ? ` → ${rename}` : ''}）${warn}` })
      setEdit(null)
      bump()
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e, '保存模型改动') })
    } finally {
      setBusy('')
    }
  }

  // ── 块3：删除 ──────────────────────────────────────────────────────────────
  async function doRemove(m: ManagedModel) {
    setBusy(`${m.id}:remove`)
    setMsg(null)
    try {
      const r = await api.modelsRemove({ cardId: m.cardId, model: m.model })
      if (!r.ok) {
        setMsg({ kind: 'err', text: r.error || '删除失败' })
        return
      }
      const parts = [`已删除受管模型 ${m.model}`]
      if (r.data?.defaultModelCleared) parts.push('（该模型是卡片默认，已回落为剩余首个模型或清空）')
      if (r.data?.ccWarning) parts.push(`；${r.data.ccWarning}`)
      setMsg({ kind: 'ok', text: parts.join('') })
      bump()
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e, '删除模型') })
    } finally {
      setBusy('')
    }
  }

  // ── 块6：应用到 Claude Code ───────────────────────────────────────────────
  async function doApply(m: ManagedModel, mode: 'proxy' | 'direct') {
    setBusy(`${m.id}:${mode}`)
    setMsg(null)
    try {
      const r = await api.modelsApply({ app: 'claude-code', cardId: m.cardId, model: m.model, mode })
      if (!r.ok) {
        setMsg({ kind: 'err', text: r.error || '应用失败' })
        return
      }
      setMsg({
        kind: 'ok',
        text: `${r.data?.detail || '已应用到 Claude Code'}；已写入 ${r.data?.targetPath || ''}；${CC_RESTART_HINT}`
      })
      bump()
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e, '应用模型') })
    } finally {
      setBusy('')
    }
  }

  // ── 块3：真·测连通（经网关用该模型发一句测试请求，主进程 proxyStatus 判活） ──
  async function doProbe(m: ManagedModel) {
    setBusy(`${m.id}:probe`)
    setMsg(null)
    try {
      const r = await api.modelsProbe({ cardId: m.cardId, model: m.model })
      if (!r.ok || !r.data) {
        setMsg({ kind: 'err', text: r.error || '探测失败' })
        return
      }
      const d: ModelsProbeResult = r.data
      setProbes((prev) => ({ ...prev, [m.id]: d }))
      setMsg({
        kind: d.status === 'ok' ? 'ok' : 'err',
        text: `探测 ${m.model}：${PROBE_LABEL[d.status]}（${d.latencyMs}ms）${d.detail}${d.sample ? ` · 样例：${d.sample}` : ''}`
      })
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e, '测连通') })
    } finally {
      setBusy('')
    }
  }

  const ccActive = cc !== null && cc.mode !== 'none'

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 块0 顶栏。两种窗口形态的出口是**互补**的，不是同一套：
          · 主窗整屏分支（侧栏入口）不渲染 AppLayout/侧栏/TitleBar → 必须自带
            「返回工作区」，否则用户卡死在本页；
          · 独立无框窗（frame:false）既没有系统关闭钮也没有侧栏 → 必须自带 ✕，
            而「返回工作区」在那里面是死路（见下）。 */}
      <div className="flex items-center justify-between h-11 px-4 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {/* 「返回工作区」只在主窗整屏分支有意义：那个分支不渲染 AppLayout/侧栏/
              TitleBar，没有这条出口用户就卡死在本页（侧栏入口是唯一进来的路）。
              独立无框窗（standalone）反过来：点它会把 1080×720 的管理窗变成一屏
              AppLayout 工作区，而且那个窗既没有侧栏也没有 TitleBar —— 进去就出不来。
              所以 standalone 时这条不渲染，出口由下面的 ✕ 承担。 */}
          {!standalone && (
            <button
              onClick={() => {
                window.location.hash = ''
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors flex-shrink-0"
            >
              <Icon name="chevron-left" size={12} />
              返回工作区
            </button>
          )}
          {/* 端点与密钥管理：主窗里跳 hash（整屏替换，有返回）；独立窗里改成
              **再开一个独立管理窗** —— 在无框管理窗里跳 #/key-manager 会把本页
              换成 KeyManagerPage，而它的 ✕ 是 api.closeWindow()，关掉的是本窗自己，
              用户得到「第二个密钥管理窗 + 模型窗消失」的错位结果。 */}
          <button
            onClick={goKeyManager}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors flex-shrink-0"
          >
            <Icon name="settings" size={12} />
            端点与密钥管理
          </button>
          <span className="text-sm font-semibold text-foreground truncate">模型管理</span>
        </div>
        {/* ✕：standalone（frame:false 的独立窗）没有系统关闭钮，必须由页面画。
            主窗整屏分支有 TitleBar 的窗口控制按钮，不重复画。 */}
        {standalone && (
          <button
            onClick={() => void api.closeWindow?.()}
            className="text-foreground-muted hover:text-foreground leading-none px-2 flex-shrink-0"
            aria-label="关闭窗口"
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </div>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-8 pt-6 pb-16">
          {/* 定位说明（块0 附句）：本页与 KeyManagerPage 的边界 */}
          <p className="text-sm text-foreground-muted mb-4">
            模型条目挂在端点卡片下；端点/密钥/协议在「端点与密钥管理」维护。本页负责受管模型的增删改、设默认、测连通与「应用到 Claude Code」。
          </p>

          {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

          {/* 块1 网关状态与一键启动：proxyStatus() 带 /health 探活；
              OpenAI 等线格式模型必须经它翻译成 Claude Code 的 Anthropic 线。 */}
          {proxy && (
            <div
              className={`rounded-xl border px-4 py-3 mb-4 flex items-center gap-3 ${
                proxy.running ? 'border-success/40 bg-success/10' : 'border-warning/40 bg-warning/10'
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium ${proxy.running ? 'text-success' : 'text-warning'}`}>
                  {proxy.running ? `khy 本地网关运行中：${proxy.endpoint}` : proxy.detail}
                </div>
                <div className="text-xs text-foreground-muted mt-0.5">
                  {proxy.running
                    ? 'OpenAI 等线格式的模型经本地网关翻译成 Claude Code 的 Anthropic 线（聚合模式可用：换模型/换 key 纯 khy 侧操作）'
                    : '聚合模式暂不可用（anthropic 线卡片仍可直连；OpenAI 线卡片需先启动网关）'}
                </div>
              </div>
              {!proxy.running && (
                <button
                  onClick={() => void doStartProxy()}
                  disabled={busy === 'proxy-start'}
                  className="px-3 py-1.5 text-xs rounded-lg bg-primary text-primary-foreground disabled:opacity-50 flex-shrink-0"
                >
                  {busy === 'proxy-start' ? '启动中…' : '启动网关'}
                </button>
              )}
            </div>
          )}

          {/* 块2 Claude Code 当前态（models:managed 的 cc 块派生） */}
          <div className="bg-card border border-card-border rounded-xl px-4 py-3 mb-5">
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium flex items-center gap-1.5">
                  <Icon name="chat" size={13} className="text-foreground-muted" />
                  Claude Code 当前态
                </div>
                <div className="text-xs text-foreground-muted mt-1 truncate">
                  {ccActive && cc
                    ? `正在用 ${cc.model || '(卡片默认)'}（${cc.routableName || '—'}）· 卡片 ${cc.cardName} · 模式 ${cc.mode}${
                        cc.mode === 'proxy' ? '（khy 聚合）' : ''
                      }${cc.lastApplied ? ` · 上次应用 ${new Date(cc.lastApplied).toLocaleString()}` : ''}`
                    : '未激活：尚未把任何模型应用到 Claude Code'}
                </div>
              </div>
              {ccActive && (
                <button
                  onClick={() => void doRevertCc()}
                  disabled={busy === 'revert'}
                  className="px-3 py-1.5 text-xs rounded-lg border border-card-border text-foreground/70 hover:bg-surface-hover disabled:opacity-50 flex-shrink-0"
                >
                  {busy === 'revert' ? '撤销中…' : '撤销激活'}
                </button>
              )}
            </div>
            <div className="text-xs text-foreground-muted mt-2">
              期望管理：Claude Code 启动时读取 settings.json；替换模型后需{CC_RESTART_HINT}，本页不做热切换。
            </div>
          </div>

          {/* 块3 模型列表（主区） */}
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-medium text-foreground-muted">受管模型（{models.length}）</div>
            <button
              onClick={() => bump()}
              className="text-xs text-foreground-muted hover:text-foreground inline-flex items-center gap-1"
            >
              <Icon name="reload" size={12} />
              刷新
            </button>
          </div>
          {loading ? (
            <div className="bg-card border border-card-border rounded-xl px-4 py-8 text-center text-xs text-foreground-muted">
              加载中…
            </div>
          ) : models.length === 0 ? (
            <div className="bg-card border border-card-border rounded-xl px-4 py-8 text-center text-xs text-foreground-muted">
              暂无受管模型，在下方添加（需要先有一张端点卡片）
            </div>
          ) : (
            <div className="bg-card border border-card-border rounded-xl divide-y divide-card-border">
              {models.map((m) => {
                const probe = probes[m.id]
                const card = cards.find((c) => c.id === m.cardId)
                const directBlocked = (card?.protocol || m.protocol) !== 'anthropic'
                const editing = edit !== null && edit.cardId === m.cardId && edit.from === m.model
                return (
                  <div key={m.id} className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
                          <span className="truncate">{m.model}</span>
                          {m.isDefault && <Badge className="border-brand/30 bg-brand/10 text-brand">默认</Badge>}
                          {m.ccActive && <Badge className="border-success/30 bg-success/10 text-success">CC 当前</Badge>}
                          {probe && <Badge className={PROBE_CLS[probe.status]}>{`${PROBE_LABEL[probe.status]} · ${probe.latencyMs}ms`}</Badge>}
                        </div>
                        {/* 副文本：Claude Code 实际收到的可路由三名 */}
                        <div className="text-xs text-foreground-muted mt-0.5 truncate" title="Claude Code 实际收到的模型名（可路由三名）">
                          可路由名 {m.routableName}
                        </div>
                        <div className="text-xs text-foreground-muted mt-0.5 flex items-center gap-1.5 flex-wrap">
                          <span>卡片 {m.cardName}</span>
                          <Badge className="border-card-border bg-input text-foreground/70">{m.protocol}</Badge>
                          <span>key {m.keyId ? m.keyId.slice(0, 8) : '(未绑定)'}</span>
                        </div>
                        {probe && (
                          <div className="text-xs text-foreground-muted mt-0.5">
                            {probe.detail}
                            {probe.sample ? ` · 样例：${probe.sample}` : ''}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap justify-end">
                        <button
                          onClick={() => void doApply(m, 'proxy')}
                          disabled={busy !== ''}
                          className="px-3 py-1.5 text-xs rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
                        >
                          {busy === `${m.id}:proxy` ? '应用中…' : '应用到 Claude Code'}
                        </button>
                        <button
                          onClick={() => void doApply(m, 'direct')}
                          disabled={busy !== '' || directBlocked}
                          title={directBlocked ? DIRECT_BLOCKED_HINT : undefined}
                          className="px-3 py-1.5 text-xs rounded-lg border border-card-border text-foreground/70 hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          应用（直连）
                        </button>
                        <button
                          onClick={() => void doProbe(m)}
                          disabled={busy !== ''}
                          className="px-3 py-1.5 text-xs rounded-lg border border-card-border text-foreground/70 hover:bg-surface-hover disabled:opacity-50"
                        >
                          {busy === `${m.id}:probe` ? '探测中…' : '测连通'}
                        </button>
                        <button
                          onClick={() => setEdit({ cardId: m.cardId, from: m.model, to: m.model, makeDefault: m.isDefault })}
                          className="px-3 py-1.5 text-xs rounded-lg border border-card-border text-foreground/70 hover:bg-surface-hover"
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => void doRemove(m)}
                          disabled={busy !== ''}
                          className="px-3 py-1.5 text-xs rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10 disabled:opacity-50"
                        >
                          {busy === `${m.id}:remove` ? '删除中…' : '删除'}
                        </button>
                      </div>
                    </div>
                    {directBlocked && <div className="text-xs text-warning mt-1.5">{DIRECT_BLOCKED_HINT}</div>}
                    {editing && edit && (
                      <div className="mt-3 border border-brand/40 rounded-lg p-3 space-y-2 bg-input/40">
                        <div className="text-xs font-medium text-foreground-muted">编辑 / 替换模型 — {m.cardName}</div>
                        <div className="flex gap-2 items-center flex-wrap">
                          <input
                            value={edit.to}
                            onChange={(e) => setEdit({ ...edit, to: e.target.value })}
                            placeholder="模型 id（留空则不改名）"
                            className="flex-1 min-w-[220px] bg-input border border-input-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-input-border-focused"
                          />
                          <label className="inline-flex items-center gap-1.5 text-xs text-foreground/70">
                            <input
                              type="checkbox"
                              checked={edit.makeDefault}
                              onChange={(e) => setEdit({ ...edit, makeDefault: e.target.checked })}
                            />
                            设为默认
                          </label>
                          <button
                            onClick={() => void doUpdate()}
                            disabled={busy === 'update'}
                            className="px-4 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
                          >
                            {busy === 'update' ? '保存中…' : '保存'}
                          </button>
                          <button
                            onClick={() => setEdit(null)}
                            className="px-3 py-1.5 text-xs rounded-lg border border-card-border text-foreground/70 hover:bg-surface-hover"
                          >
                            取消
                          </button>
                        </div>
                        <div className="text-xs text-foreground-muted">
                          替换 Claude Code 当前模型 = 设默认 + 应用到 Claude Code；改名只改模型 id，不改端点/密钥。
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* 块4 新增（卡片下拉钉死 cards:list） */}
          <div className="mt-6 bg-card border border-card-border rounded-xl p-4 space-y-3">
            <div className="text-xs font-medium text-foreground-muted">新增受管模型</div>
            {cards.length === 0 ? (
              /* 零卡片态（首次使用）：不死空态，给出唯一修复动作 */
              <div className="text-xs text-foreground-muted">
                还没有端点卡片：模型条目挂在端点卡片下，请先到「端点与密钥管理」创建。
                <button
                  onClick={goKeyManager}
                  className="ml-2 text-brand hover:underline"
                >
                  去创建 →
                </button>
              </div>
            ) : (
              <>
                <div className="flex gap-2 flex-wrap items-center">
                  <select
                    value={addCardId}
                    onChange={(e) => {
                      setAddCardId(e.target.value)
                      setCatalog(null)
                      setPicked(new Set<string>())
                    }}
                    className="khy-select bg-input border border-input-border rounded-lg px-3 py-1.5 text-sm min-w-[200px] focus:outline-none"
                  >
                    <option value="">选择端点卡片…</option>
                    {cards.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} [{c.protocol}]
                      </option>
                    ))}
                  </select>
                  <input
                    value={addModel}
                    onChange={(e) => setAddModel(e.target.value)}
                    placeholder="模型 id（如 gpt-4o-mini）"
                    className="flex-1 min-w-[200px] bg-input border border-input-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-input-border-focused"
                  />
                  <label className="inline-flex items-center gap-1.5 text-xs text-foreground/70">
                    <input type="checkbox" checked={addDefault} onChange={(e) => setAddDefault(e.target.checked)} />
                    设为默认
                  </label>
                  <button
                    onClick={() => void doAdd()}
                    disabled={busy === 'add'}
                    className="px-4 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
                  >
                    {busy === 'add' ? '加入中…' : '加入'}
                  </button>
                  <button
                    onClick={() => void doCatalog()}
                    disabled={busy === 'catalog'}
                    className="px-3 py-1.5 text-xs rounded-lg border border-card-border text-foreground/70 hover:bg-surface-hover disabled:opacity-50"
                  >
                    {busy === 'catalog' ? '拉取中…' : '拉取端点目录'}
                  </button>
                </div>
                {catalog && catalog.cardId === addCardId && (
                  <div className="border-t border-card-border pt-3 space-y-2">
                    {!catalog.verified ? (
                      /* 非 openai 协议：main 的 verified:false 文案原样透显 */
                      <div className="text-xs text-warning">
                        {catalog.error || '该协议无公开模型目录，请手工填写模型 id'}
                      </div>
                    ) : (
                      <>
                        <div className="text-xs text-foreground-muted">
                          端点目录（{catalog.models.length} 个，勾选后批量加入；已在卡片中的不可勾选）
                        </div>
                        <div className="max-h-48 overflow-auto grid grid-cols-2 gap-1">
                          {catalog.models.map((x) => {
                            const card = cards.find((c) => c.id === addCardId)
                            const inCard = card?.models.includes(x) || card?.defaultModel === x
                            return (
                              <label
                                key={x}
                                className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-card-border ${
                                  inCard ? 'text-foreground-muted' : 'text-foreground/70 hover:bg-surface-hover'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={picked.has(x)}
                                  disabled={inCard}
                                  onChange={(e) =>
                                    setPicked((prev) => {
                                      const next = new Set(prev)
                                      if (e.target.checked) next.add(x)
                                      else next.delete(x)
                                      return next
                                    })
                                  }
                                />
                                <span className="truncate">{x}</span>
                                {inCard && <span className="text-foreground-muted flex-shrink-0">已在卡片中</span>}
                              </label>
                            )
                          })}
                        </div>
                        <button
                          onClick={() => void doAddPicked()}
                          disabled={busy === 'batch' || picked.size === 0}
                          className="px-3 py-1.5 text-xs rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
                        >
                          {busy === 'batch' ? '加入中…' : `加入勾选项（${picked.size}）`}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* 块7 审计出口：写操作都有独立审计 op，明细在 KeyManager 页健康与审计 */}
          <div className="text-xs text-foreground-muted mt-6">
            操作审计见 密钥与端点管理页 → 健康与审计（models:apply / models:probe 有独立审计 op）
          </div>
        </div>
      </main>
    </div>
  )
}
