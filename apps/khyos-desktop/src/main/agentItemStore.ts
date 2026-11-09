// khy-canary: Khy-20261102-317-AGST01BB
// agentItemStore — settings Pattern-B list pages (命令/钩子/技能/子智能体/记忆)
// and the onboarding 数据迁移向导.
//
// None of these pages are desktop-private: they read and write the exact stores
// the khy terminal consumes (hooks.json, skills/, agents/, .claude/commands,
// commands/*.js, <dataHome>/memory + MEMORY.md) through terminalSources (CH-2
// module reuse). There is no desktop-side registry any more.
//
// Every write still arrives through the main IPC 正门; nothing here writes a
// renderer-supplied path directly.

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDataHome } from './keyManager/keyStore'
import {
  listTerminalItems,
  createTerminalItem,
  setTerminalItemEnabled,
  deleteTerminalItem,
  importTerminalItems,
} from './terminalSources'
import { slashCommandItems } from './slashCommandSources'

export const AGENT_ITEM_KINDS = new Set(['command', 'hook', 'skill', 'subagent', 'memory'])

export interface AgentItem {
  id: string
  kind: string
  name: string
  description: string
  content: string
  enabled: boolean
  // 'user' | 'imported:<sourceId>' | terminal source labels
  source: string
  sourceLabel?: string
  createdAt: number
  updatedAt: number
  // Terminal-derived rows that the desktop must not edit in place.
  readOnly?: boolean
  toggleable?: boolean
  deletable?: boolean
}

function kindError(kind: string): string | null {
  if (!AGENT_ITEM_KINDS.has(kind)) {
    return `未知的条目类型「${kind}」：请通过设置页重试，或重启应用`
  }
  return null
}

function failure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message || '操作失败：请重启应用后重试'
}

// ── Registry CRUD (IPC 正门) ──────────────────────────────────────────

export async function listItems(
  kind: string
): Promise<{ ok: boolean; items?: AgentItem[]; error?: string }> {
  const err = kindError(kind)
  if (err) return { ok: false, error: err }
  try {
    const items = await listTerminalItems(kind)
    if (kind === 'command') {
      // 设置页「命令」页与终端同源：CC 桥/插件行之外，把 khy 斜杠命令面
      // （内置 + 用户技能触发）整列接入。行只读，排序口径与其它 kind 一致。
      const khy = slashCommandItems()
      return { ok: true, items: [...items, ...khy].sort((a, z) => a.name.localeCompare(z.name)) }
    }
    return { ok: true, items }
  } catch (e) {
    return { ok: false, error: `终端数据读取失败：${failure(e)}` }
  }
}

export async function createItem(
  kind: string,
  input: unknown
): Promise<{ ok: boolean; item?: AgentItem; error?: string }> {
  const err = kindError(kind)
  if (err) return { ok: false, error: err }
  try {
    const item = await createTerminalItem(kind, (input || {}) as Record<string, unknown>)
    return { ok: true, item }
  } catch (e) {
    return { ok: false, error: failure(e) }
  }
}

export async function setItemEnabled(
  kind: string,
  id: string,
  enabled: boolean
): Promise<{ ok: boolean; error?: string }> {
  const err = kindError(kind)
  if (err) return { ok: false, error: err }
  try {
    await setTerminalItemEnabled(kind, id, enabled)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: failure(e) }
  }
}

export async function deleteItem(
  kind: string,
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const err = kindError(kind)
  if (err) return { ok: false, error: err }
  try {
    await deleteTerminalItem(kind, id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: failure(e) }
  }
}

// 导入 — rows: [{name, description?, content?}]. Invalid rows and duplicates
// are skipped (counted), matching the terminal create contract.
export async function importItems(
  kind: string,
  rows: unknown
): Promise<{ ok: boolean; created?: number; skipped?: number; error?: string }> {
  const err = kindError(kind)
  if (err) return { ok: false, error: err }
  if (!Array.isArray(rows)) {
    return { ok: false, error: '导入内容不是 JSON 数组：请复制 [{name, content}] 形式后重试' }
  }
  try {
    return { ok: true, ...(await importTerminalItems(kind, rows)) }
  } catch (e) {
    return { ok: false, error: failure(e) }
  }
}

// ── 外部 Agent 迁移（onboarding 数据迁移向导，D5/s-8）──────────────────
// Scans REAL config directories under the OS home; counts are read from disk
// at scan time. 导入 copies definitions into the SAME stores the settings
// pages read (native skill dirs / CC command markdown), so migrated items stay
// visible to both the desktop and the terminal.

export interface MigrationSection {
  // Subdirectory under the agent config dir, e.g. 'commands'
  dir: string
  // Destination item kind in this registry
  kind: string
  label: string
}

export interface MigrationSource {
  id: string
  label: string
  // Config dir name under the OS home
  homeDir: string
  sections: MigrationSection[]
}

const MIGRATION_SOURCES: MigrationSource[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    homeDir: '.claude',
    sections: [
      { dir: 'commands', kind: 'command', label: '命令' },
      { dir: 'skills', kind: 'skill', label: '技能' },
    ],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    homeDir: '.cursor',
    sections: [{ dir: 'rules', kind: 'skill', label: '规则' }],
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    homeDir: '.codex',
    sections: [{ dir: 'prompts', kind: 'command', label: '提示词' }],
  },
]

async function mdFilesIn(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name)
  } catch {
    return []
  }
}

export async function scanMigrations(): Promise<{
  ok: boolean
  sources?: Array<{ id: string; label: string; found: boolean; counts: Array<{ label: string; count: number }> }>
  error?: string
}> {
  const home = os.homedir()
  const sources = []
  for (const src of MIGRATION_SOURCES) {
    const configDir = path.join(home, src.homeDir)
    let found = false
    const counts: Array<{ label: string; count: number }> = []
    try {
      await fs.access(configDir)
      found = true
    } catch {
      found = false
    }
    if (found) {
      for (const section of src.sections) {
        const files = await mdFilesIn(path.join(configDir, section.dir))
        counts.push({ label: section.label, count: files.length })
      }
    }
    sources.push({ id: src.id, label: src.label, found, counts })
  }
  return { ok: true, sources }
}

export async function importMigration(
  sourceId: string
): Promise<{ ok: boolean; created?: number; skipped?: number; error?: string }> {
  const src = MIGRATION_SOURCES.find((s) => s.id === sourceId)
  if (!src) {
    return { ok: false, error: `未知的迁移来源「${sourceId}」：请重新检测后导入` }
  }
  const home = os.homedir()
  const configDir = path.join(home, src.homeDir)
  try {
    await fs.access(configDir)
  } catch {
    return { ok: false, error: `未找到 ${src.label} 的配置目录（${src.homeDir}）：请确认已安装后重试` }
  }
  let created = 0
  let skipped = 0
  for (const section of src.sections) {
    const sectionDir = path.join(configDir, section.dir)
    const files = await mdFilesIn(sectionDir)
    for (const file of files) {
      const name = path.basename(file, '.md')
      try {
        const content = await fs.readFile(path.join(sectionDir, file), 'utf-8')
        await createTerminalItem(section.kind, {
          name,
          description: firstLine(content),
          content,
        })
        created += 1
      } catch {
        // Duplicate (already shared with khy) or unreadable: skip honestly.
        skipped += 1
      }
    }
  }
  return { ok: true, created, skipped }
}

function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'))
  return line ? line.slice(0, 80) : ''
}

// Data home root used by the onboarding dialog's "数据存储位置" hint — exported
// for IPC so the renderer never hardcodes a path (Rule 1).
export function migrationDataHome(): string {
  return getDataHome()
}
