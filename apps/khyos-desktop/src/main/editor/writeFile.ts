import { promises as fsp } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  EDITOR_NAME_MAX_CHARS,
  type EditorCreateResult,
  type EditorWriteResult,
} from '../../shared/editorContract'
import { isInsideAnyRoot } from './workspaceRules'

// 工作台写通道。三重约束与 codeEditor:write 相同：白名单根、已存在文件
// （新建走 createEditorFile）、mtime 基线。落盘交给后端 fileWriteService —
// 人保存与 AI 工具写盘共用同一条通道（同一把锁、同一份快照、同一个先读后写
// 台账），这是 M2 的核心不变量：两条路径各写一份就必然静默互相覆盖。

const nodeRequire = createRequire(import.meta.url)

// 与 main/index.ts 的 resolveKhyOsRoot 同一基准：开发态从 out/main 上溯四级，
// 装着环境由 KHY_OS_DIR 指定。
const resolveKhyOsRoot = (): string =>
  process.env.KHY_OS_DIR ? path.resolve(process.env.KHY_OS_DIR) : path.resolve(__dirname, '..', '..', '..', '..')

type WriteSink = {
  write: (args: {
    filePath: string
    content: string
    baseMtimeMs?: number
    actor: 'tool' | 'editor'
    reason: string
    diagCwd?: string
  }) => Promise<{
    ok: boolean
    state: 'ok' | 'conflict' | 'missing' | 'rejected' | 'error'
    mtimeMs?: number
    diskMtimeMs?: number
    error?: string
  }>
}

function loadWriteSink(): WriteSink {
  return nodeRequire(
    path.join(resolveKhyOsRoot(), 'runtime', 'node', 'backend', 'src', 'services', 'fileWriteService.js'),
  ) as WriteSink
}

export interface EditorWriteHooks {
  /** 写成功后调用：watcher 抑制「自写自触发」，M2 还会据此通知 host 更新 readTracker */
  afterWrite?: (filePath: string, mtimeMs: number) => void
}

type ResolveResult =
  | { ok: true; resolved: string }
  | { ok: false; state: 'missing' | 'outsideWorkspace'; error: string }

function resolveInsideRoots(rawPath: string, roots: Set<string>): ResolveResult {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return { ok: false, state: 'missing', error: '路径为空：请先打开一个文件再操作' }
  }
  const resolved = path.resolve(rawPath.trim())
  if (!isInsideAnyRoot(resolved, roots)) {
    return {
      ok: false,
      state: 'outsideWorkspace',
      error: `拒绝写入 ${resolved}：该文件不在已登记的工作区内，请先用「打开工作区」登记它的目录`,
    }
  }
  return { ok: true, resolved }
}

export async function writeEditorFile(
  args: { filePath: string; content: string; baseMtimeMs?: number },
  roots: Set<string>,
  hooks: EditorWriteHooks = {},
): Promise<EditorWriteResult> {
  if (typeof args.content !== 'string') {
    return { ok: false, state: 'error', error: '保存内容不是文本：已拒绝写入' }
  }
  const target = resolveInsideRoots(args.filePath, roots)
  if (!target.ok) return { ok: false, state: target.state, error: target.error }
  const resolved = target.resolved

  let sink: WriteSink
  try {
    sink = loadWriteSink()
  } catch (err) {
    return {
      ok: false,
      state: 'error',
      error: `保存失败：统一写通道不可用（${(err as Error)?.message || String(err)}），请检查 KHY_OS_DIR 是否指向仓库根`,
    }
  }

  try {
    const stat = await fsp.stat(resolved)
    if (!stat.isFile()) {
      return { ok: false, state: 'missing', error: `目标不是已存在的文件：${resolved}` }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      return { ok: false, state: 'missing', error: `文件不存在：${resolved}，请刷新文件树后重试` }
    }
    return {
      ok: false,
      state: 'error',
      error: `读取文件失败：${(err as Error)?.message || String(err)}，请检查文件是否被其他程序占用`,
    }
  }

  const written = await sink.write({
    filePath: resolved,
    content: args.content,
    // 缺省 = 「覆盖写入」这一档人明确选择过的路径，服务端不再比对 mtime。
    baseMtimeMs: args.baseMtimeMs,
    actor: 'editor',
    reason: 'editor-workbench',
    diagCwd: path.dirname(resolved),
  })

  if (!written.ok) {
    const state = written.state === 'ok' ? 'error' : written.state
    return {
      ok: false,
      state,
      diskMtimeMs: written.diskMtimeMs,
      error: written.error || '保存失败：写盘没有完成，磁盘内容保持原样',
    }
  }

  const mtimeMs = Math.round(written.mtimeMs ?? Date.now())
  hooks.afterWrite?.(resolved, mtimeMs)
  return { ok: true, state: 'ok', mtimeMs }
}

// Windows 文件名禁用字符 + 控制字符 + 结尾空格/点。校验放在系统边界
// （用户在输入框里打出的名字），主进程是最后一道。
const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/

function invalidNameReason(name: string): string | null {
  if (!name) return '文件名不能为空'
  if (name.length > EDITOR_NAME_MAX_CHARS) return `文件名超过 ${EDITOR_NAME_MAX_CHARS} 个字符：请缩短后重试`
  if (name === '.' || name === '..') return '文件名不能是 . 或 ..'
  if (INVALID_NAME_CHARS.test(name)) return '文件名含非法字符（< > : " / \\ | ? *）：请去掉后重试'
  if (/[. ]$/.test(name)) return '文件名不能以空格或点结尾：Windows 会拒绝创建'
  return null
}

export async function createEditorFile(
  args: { dirPath: string; fileName: string },
  roots: Set<string>,
  hooks: EditorWriteHooks = {},
): Promise<EditorCreateResult> {
  const base = resolveInsideRoots(args.dirPath, roots)
  if (!base.ok) return { ok: false, state: base.state, error: base.error }
  const dir = base.resolved
  const name = typeof args.fileName === 'string' ? args.fileName.trim() : ''
  const nameError = invalidNameReason(name)
  if (nameError) return { ok: false, state: 'rejected', error: nameError }
  const target = path.join(dir, name)
  if (path.dirname(target) !== dir) {
    return { ok: false, state: 'rejected', error: `新建路径越过了目标目录：${target}` }
  }
  try {
    const dirStat = await fsp.stat(dir)
    if (!dirStat.isDirectory()) {
      return { ok: false, state: 'missing', error: `目标不是目录：${dir}，请先在文件树里选择一个目录` }
    }
    // 'wx' 是原子的存在性检查：并发两次同名新建只有一次成功
    await fsp.writeFile(target, '', { flag: 'wx', encoding: 'utf-8' })
    const stat = await fsp.stat(target)
    const mtimeMs = Math.round(stat.mtimeMs)
    hooks.afterWrite?.(target, mtimeMs)
    return { ok: true, state: 'ok', filePath: target, mtimeMs }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EEXIST') {
      return {
        ok: false,
        state: 'exists',
        filePath: target,
        error: `文件已存在：${name}，请换一个名字或直接在文件树里打开它`,
      }
    }
    return {
      ok: false,
      state: 'error',
      error: `新建文件失败：${(err as Error)?.message || String(err)}，请检查目录权限`,
    }
  }
}
