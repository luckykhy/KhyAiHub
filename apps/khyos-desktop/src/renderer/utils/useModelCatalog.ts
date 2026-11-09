// khy-canary: Khy-20261102-355-HKC1P7TG
import { useState, useEffect } from 'react'

// 模型/provider 选项（后端终端同源采集叶 collectModelEntries，采集为空时
// 回退 providerPresets.getProviderPresets() 静态目录，经 host CH-2 桥转发，
// P3-7）。provider 级选项
// format 同 apiFormat；模型级选项 id 形如 `<provider>/<model>`。channel 的口径
// 按生产者分：采集路径填的是适配器类型（entry.value.adapter，'api'），presets
// 兜底路径才填后端池 key；channelKnown=false 时（聚合网关等未注册池）不应钉
// preferredAdapter。
export interface ModelOption {
  id: string
  label: string
  format: string
  channel?: string
  channelKnown?: boolean
  // 网关适配器类型与模型 id（终端选中后传给网关的同一对值）。
  adapter?: string
  model?: string
  // 分组依据 = 上游提供商名（终端 composeModelDisplay().group 同口径）。
  group?: string
  // 该条目来自上游真实 /models。false = providerPresets 静态目录兜底。
  fromUpstream?: boolean
  // 能力徽章（视觉 / 图像 / 视频 / 音频），判定在后端做。
  tags?: string[]
}

interface ModelCatalogState {
  options: ModelOption[]
  loading: boolean
  error: string
}

// 选中模型持久化键（settingsStore，主进程 settings.json 原子写，P3-7②）。
// 存选项 id（`<provider>` 或 `<provider>/<model>`）——跨重启恢复时若该
// provider 已从 presets 消失，调用方回退到首个可用选项，永不写死模型名。
const SETTING_KEY = 'selectedModel'

// 从全量选项表（终端同源采集叶，或采集为空时的 presets 静态目录）解析某
// id 的展示标签；未知 id 返回 null（调用方自行兜底为 '选择模型'）。
// P3-7④ 起 App/ModelSelector 共用，替代 App.tsx 里已删除的 GLM 静态默认名。
export function getModelOptionLabel(id: string, options: ModelOption[]): string | null {
  if (!id) return null
  const hit = options.find((o) => o.id === id)
  if (hit) return hit.label
  // provider 级 `<provider>/<model>`：未知 model（动态拉取结果不在表里）→
  // 退化为 provider 标签，避免裸 id 字符串泄漏到 UI。
  if (id.includes('/')) {
    const provider = options.find((o) => o.id === id.slice(0, id.indexOf('/')))
    if (provider) return provider.label
  }
  return null
}

// 持久化模型选中态（P3-7②）：经 settingsStore（main 进程 settings.json）
// 落盘，重启后 loadPersistedModelSelection 恢复。fail-soft：preload 未注入
// 或写入失败静默忽略——选中态丢失不阻断会话。
export function persistModelSelection(id: string): void {
  void (window as unknown as {
    __KHYOS__?: { setSetting?: (k: string, v: unknown) => Promise<void> } }
  ).__KHYOS__?.setSetting?.(SETTING_KEY, id).catch(() => {})
}

// 启动时恢复模型选中态（P3-7②）；settingsStore 不可用时返回 null。
export async function loadPersistedModelSelection(): Promise<string | null> {
  const api = (window as unknown as {
    __KHYOS__?: { getSettings?: () => Promise<Record<string, unknown>> } }
  ).__KHYOS__
  if (!api?.getSettings) return null
  try {
    const s = await api.getSettings()
    const v = s?.[SETTING_KEY]
    return typeof v === 'string' && v ? v : null
  } catch {
    return null
  }
}

// 模型选项表：一次拉取，模块级缓存共享给所有 useModelCatalog() 实例。
//
// 没有「按通道补拉」的第二条路径：host 侧的 listModels 一次性返回终端同源的
// 全量采集结果（或 presets 静态兜底），传通道名也只会拿回同一份全量 ——
// 早前的 fetchDynamicModels 因此是空转，还要为此在渲染侧加一层订阅才「看起来」
// 会更新。
let cached: ModelOption[] | null = null

export function useModelCatalog(): ModelCatalogState {
  const [state, setState] = useState<ModelCatalogState>({
    options: cached ?? [],
    loading: cached === null,
    error: '',
  })

  useEffect(() => {
    const api = (window as unknown as {
      __KHYOS__?: {
        listModels?: () => Promise<{
          ok: boolean
          models?: ModelOption[]
          error?: string
        }>
      }
    }).__KHYOS__
    if (!api?.listModels) {
      setState((s) => ({
        ...s,
        loading: false,
        error: '模型列表不可用：preload 未注入 __KHYOS__，请重启应用',
      }))
      return
    }
    if (cached !== null) {
      setState({ options: cached, loading: false, error: '' })
      return
    }
    let cancelled = false
    api.listModels().then((res) => {
      if (cancelled) return
      if (res?.ok && Array.isArray(res.models)) {
        cached = res.models
        setState({ options: res.models, loading: false, error: '' })
      } else {
        setState((s) => ({ ...s, loading: false, error: res?.error || '模型列表读取失败：host 进程无响应，请重启应用' }))
      }
    }).catch(() => {
      if (cancelled) return
      setState((s) => ({ ...s, loading: false, error: '模型列表读取失败：host 进程无响应，请重启应用' }))
    })
    return () => { cancelled = true }
  }, [])

  return state
}

// 按**提供商**分组模型选项（两级选择器的第一级）。
//
// 分组依据是 ModelOption.group —— 后端 composeModelDisplay().group 给出的上游
// 提供商名，与终端 `/model` 的分组同一口径。刻意不用 id 前缀：所有中转站走的
// 都是 api 适配器，按前缀分会把它们塌成「api」一组，用户加了几个中转站就分不清。
//
// 组内上游真实模型排前面，静态目录兜底的排后面 —— 前者是「这家现在真的在售」，
// 后者是「可能卖过」，两者混排会让人选到早已改版的模型。
export interface ProviderGroup {
  key: string
  label: string
  options: ModelOption[]
}

export function groupByProvider(options: ModelOption[]): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>()
  for (const o of options) {
    const key = o.group || o.id.split('/')[0] || o.id
    let g = groups.get(key)
    if (!g) {
      g = { key, label: o.group || key, options: [] }
      groups.set(key, g)
    }
    g.options.push(o)
  }
  return Array.from(groups.values()).map((g) => ({
    ...g,
    options: g.options.sort(
      (a, b) => Number(Boolean(b.fromUpstream)) - Number(Boolean(a.fromUpstream))
    ),
  }))
}
