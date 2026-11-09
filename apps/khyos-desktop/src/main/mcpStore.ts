// khy-canary: Khy-20261102-269-KG2B71C8
// mcpStore — the settings MCP page's data source. Reads and writes the SAME
// mcp.json files the khy terminal loads (user scope + project scope + the
// ecosystem bridges merged by the backend loader), so a server added here is
// immediately visible to `khy` and vice versa.
//
// All path/format truth lives in terminalSources (backend mcpConfigStore);
// this module only adapts its exceptions into the {ok, server?, error?}
// result shape the IPC handlers and the page already speak.

import {
  listTerminalMcpServers,
  createTerminalMcpServer,
  setTerminalMcpEnabled,
  deleteTerminalMcpServer,
  importTerminalMcpServers,
} from './terminalSources'

export interface McpServer {
  id: string
  name: string
  // Server transport: shell command line (stdio) or http(s) URL (sse/streamable)
  command: string
  enabled: boolean
  createdAt: number
  // External/bridged entries are listed for visibility but cannot be edited
  // from the desktop — the owning tool keeps that file.
  readOnly: boolean
  toggleable: boolean
  deletable: boolean
  source: string
  sourceLabel: string
  detail: string
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function getMcpServers(): Promise<McpServer[]> {
  return listTerminalMcpServers()
}

// 新建 MCP 服务器 — validates name + transport, writes into the user mcp.json.
export async function createMcpServer(input: {
  name?: unknown
  command?: unknown
  enabled?: unknown
}): Promise<{ ok: boolean; server?: McpServer; error?: string }> {
  try {
    const server = await createTerminalMcpServer({ name: input.name, command: input.command })
    return { ok: true, server }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

// 启用/停用 per-row toggle — flips `disabled` in the owning mcp.json.
export async function setMcpServerEnabled(
  id: string,
  enabled: boolean
): Promise<{ ok: boolean; server?: McpServer; error?: string }> {
  try {
    await setTerminalMcpEnabled(id, !!enabled)
    const server = (await listTerminalMcpServers()).find((s) => s.id === id)
    return { ok: true, server }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

// 删除 — removes the entry from the mcp.json that owns it.
export async function deleteMcpServer(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await deleteTerminalMcpServer(id)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

// 导入 — bulk-create from a parsed JSON payload (clipboard import). Skips
// invalid/duplicate rows, reports created/skipped counts honestly.
export async function importMcpServers(
  rows: unknown
): Promise<{ ok: boolean; created: number; skipped: number; error?: string }> {
  try {
    const { created, skipped } = await importTerminalMcpServers(rows)
    return { ok: true, created, skipped }
  } catch (err) {
    return { ok: false, created: 0, skipped: 0, error: errorText(err) }
  }
}
