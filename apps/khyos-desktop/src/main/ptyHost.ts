import type { IPty } from '@lydell/node-pty'
import type { WebContents } from 'electron'

// ptyHost — 桌面端真终端的 PTY 管理器（[DESIGN-ARCH-176] A3，方案 A + 解法②）。
//
// 包选型依据（A2-pre 实测，不要凭记忆改包名）：
//   `node-pty@1.0.0` 的二进制是 Node ABI 127，Electron 44 是 ABI 149 —— spawn 即报
//   "compiled against a different Node.js version"，而本机没有 MSVC 工具链无法 rebuild。
//   `@lydell/node-pty` 带平台子包 prebuilds（win32-x64 conpty.node），N-API 跨 ABI，
//   Electron 44 下实测 spawn OK。CLI 侧 `services/backend/src/cli/pty.js` 仍用
//   node-pty@1.0.0（Node 22 ABI 匹配），两包**共存而非替换**，patches/ 保留不动。
//
// IPC 通道（pty:create/write/resize/kill）的字面 handle 注册在 src/main/index.ts ——
// desktopUiContract D6 只扫描 index.ts 与 keyManager/ipc.ts 的 handle 字面量做
// preload↔main 配对校验，注册挪进本模块会让契约测试误报 API 漂移。
//
// 懒加载：`@lydell/node-pty` 在模块顶层静态 import 的话，平台子包缺失/加载失败
// 会把整个主进程拖死。这里用动态 import 缓存 —— 失败只让单次 pty:create 返回
// { ok:false, error }，渲染层降级为提示文案（fail-soft，与 cli/pty.js 同策）。

interface PtySession {
  pty: IPty
  sender: WebContents
}

const sessions = new Map<string, PtySession>()
let nextId = 1
let ptyMod: typeof import('@lydell/node-pty') | null = null

// 并发上限：侧栏终端标签是唯一消费方，正常 1-2 个；上限只防泄漏，不是功能。
const MAX_SESSIONS = 8

async function loadPty(): Promise<typeof import('@lydell/node-pty')> {
  if (!ptyMod) ptyMod = await import('@lydell/node-pty')
  return ptyMod
}

export interface PtyCreateResult {
  ok: boolean
  id?: string
  pid?: number
  error?: string
}

export async function ptyCreate(
  opts: { cols?: number; rows?: number; cwd?: string },
  sender: WebContents
): Promise<PtyCreateResult> {
  if (sessions.size >= MAX_SESSIONS) {
    return { ok: false, error: `PTY session limit reached (${MAX_SESSIONS})` }
  }
  let mod: typeof import('@lydell/node-pty')
  try {
    mod = await loadPty()
  } catch (err) {
    return { ok: false, error: `pty module unavailable: ${(err as Error)?.message || String(err)}` }
  }
  // shell 选择：ComSpec 在 Windows 上必有；KHY_DESKTOP_SHELL 留给用户显式覆盖。
  const file = process.env.KHY_DESKTOP_SHELL || process.env.ComSpec || 'cmd.exe'
  const cols = Math.max(2, Math.floor(opts?.cols ?? 80))
  const rows = Math.max(2, Math.floor(opts?.rows ?? 24))
  const cwd = opts?.cwd || process.cwd()
  try {
    const pty = mod.spawn(file, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env } as { [key: string]: string | undefined },
    })
    const id = `pty-${nextId++}`
    sessions.set(id, { pty, sender })
    pty.onData((data) => {
      if (sender.isDestroyed()) {
        try { pty.kill() } catch { /* already gone */ }
        sessions.delete(id)
        return
      }
      sender.send('pty:data', { id, data })
    })
    pty.onExit(({ exitCode }) => {
      sessions.delete(id)
      if (!sender.isDestroyed()) sender.send('pty:exit', { id, code: exitCode })
    })
    return { ok: true, id, pid: pty.pid }
  } catch (err) {
    return { ok: false, error: `pty spawn failed: ${(err as Error)?.message || String(err)}` }
  }
}

export function ptyWrite(id: string, data: string): void {
  const s = sessions.get(id)
  if (!s) return
  try { s.pty.write(String(data ?? '')) } catch { /* dead pty: exit event will clean up */ }
}

export function ptyResize(id: string, cols: number, rows: number): void {
  const s = sessions.get(id)
  if (!s) return
  try { s.pty.resize(Math.max(2, Math.floor(cols)), Math.max(2, Math.floor(rows))) } catch { /* dead pty */ }
}

export function ptyKill(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  try { s.pty.kill() } catch { /* already gone */ }
}

// will-quit 清理：PTY 子进程（shell）不随父进程自退，必须显式杀。
export function disposeAllPtys(): void {
  for (const [, s] of sessions) {
    try { s.pty.kill() } catch { /* already gone */ }
  }
  sessions.clear()
}
