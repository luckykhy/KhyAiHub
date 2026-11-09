// khy-canary: Khy-20261102-270-NN1R2AR4
// pluginStore — the settings 插件 page's data source. Lists the runtime
// extensions the khy terminal actually loads (extensionRoots.discover), flips
// the same enabled flags (extensions_state.json) and uninstalls through the
// backend extension manager. No desktop-only plugins.json anymore: the blank
// page was caused by that registry diverging from the terminal's.
//
// installPlugin is intentionally not faked — the desktop has no marketplace
// protocol, so it returns an honest error pointing at `khy ext install`.

import {
  listTerminalPlugins,
  setTerminalPluginEnabled,
  uninstallTerminalPlugin,
  installTerminalPlugin,
  listEcoMarkets,
  installMarketEntry,
  uninstallMarketEntry,
} from './terminalSources'

export interface PluginComponents {
  skills: number
  commands: number
  hooks: number
  mcp: number
  agents: number
  lsp: number
}

export interface Plugin {
  id: string
  name: string
  version: string
  description: string
  // 'builtin' → settings.plugins.source.builtin; otherwise 'user'
  source: string
  enabled: boolean
  installedAt: number
  installPath: string
  updateAvailable?: boolean
  components: PluginComponents
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toPlugin(row: Awaited<ReturnType<typeof listTerminalPlugins>>[number]): Plugin {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    source: row.source,
    enabled: row.enabled,
    installedAt: row.installedAt,
    installPath: row.installPath,
    updateAvailable: row.updateAvailable,
    components: row.components,
  }
}

export async function getPlugins(): Promise<Plugin[]> {
  try {
    return (await listTerminalPlugins()).map(toPlugin)
  } catch {
    return []
  }
}

// 启用/停用 toggle — the only state the settings page flips per row.
export async function setPluginEnabled(
  id: string,
  enabled: boolean
): Promise<{ ok: boolean; plugin?: Plugin; error?: string }> {
  try {
    const row = await setTerminalPluginEnabled(id, !!enabled)
    return { ok: true, plugin: toPlugin(row) }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

// 卸载 — removes the extension through the backend extension manager.
export async function uninstallPlugin(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await uninstallTerminalPlugin(id)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

// 安装 — no marketplace protocol in the desktop; honest refusal with the
// terminal command that does work.
export async function installPlugin(_input: Record<string, unknown>): Promise<{
  ok: boolean
  plugin?: Plugin
  error?: string
}> {
  return installTerminalPlugin()
}

// 检查更新 — the terminal's extension roots carry no upstream version index,
// so there is nothing to compare against. Refuse honestly instead of
// reporting "all up to date" without having checked anything.
export async function checkPluginUpdates(): Promise<{ ok: boolean; count: number; error?: string }> {
  return {
    ok: false,
    count: 0,
    error: '无法检查插件更新：桌面端未接入插件市场，请用终端执行 khy ext list 查看已安装版本',
  }
}

// 发现 tab — the surveyed multi-ecosystem catalog (delivery/market) plus the
// live StepFun marketplace, read through the same CH-2 services. `force`
// bypasses both the static catalog's 30-minute TTL and StepFun's 5-minute TTL.
export async function getEcoMarketCatalog(force = false): Promise<{
  ok: boolean
  payload?: Record<string, unknown>
  error?: string
}> {
  try {
    return { ok: true, payload: await listEcoMarkets(!!force) }
  } catch (err) {
    return {
      ok: false,
      error: `生态市场编目读取失败：${errorText(err)}；请确认应用以完整仓库或便携版启动后重试`,
    }
  }
}

// 市场条目安装/卸载 — entry is the catalog row the pane already shows; the
// backend executes its khy-market/1 installSpec and writes the ledger.
export async function installEcoMarketEntry(
  entry: Record<string, unknown>,
  values?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  try {
    return await installMarketEntry(entry, values)
  } catch (err) {
    return { ok: false, error: `安装失败：${errorText(err)}` }
  }
}

export async function uninstallEcoMarketEntry(entry: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return await uninstallMarketEntry(entry)
  } catch (err) {
    return { ok: false, error: `卸载失败：${errorText(err)}` }
  }
}
