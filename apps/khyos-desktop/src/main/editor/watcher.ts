import { promises as fsp, watch as fsWatch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import {
  SELF_WRITE_SUPPRESS_MS,
  WATCH_DEBOUNCE_MS,
  WATCH_MAX_DIRS,
  type EditorFileChanged,
  type EditorWatchSetResult,
} from '../../shared/editorContract'

// 只为「编辑器打开着的文件」监听父目录（非递归）。AI 或外部程序改了磁盘，
// 编辑器必须知道 —— 否则下一次保存就是静默覆盖。
//
// 限制如实上报：目录数超上限返回 dropped，渲染层据此提示「部分文件不会自动
// 感知磁盘变化」，不假装全都监听着。

export interface EditorWatcher {
  /** 重建监听集合（传空数组 = 全部停掉）。 */
  setTargets(filePaths: string[]): EditorWatchSetResult
}

const selfWrites = new Map<string, { mtimeMs: number; at: number }>()

/** 编辑器自己刚写完：记一笔，watcher 在时窗内不把它当成「磁盘已变」。 */
export function noteEditorSelfWrite(filePath: string, mtimeMs: number): void {
  const now = Date.now()
  for (const [key, rec] of selfWrites) {
    if (now - rec.at > SELF_WRITE_SUPPRESS_MS) selfWrites.delete(key)
  }
  selfWrites.set(path.resolve(filePath), { mtimeMs, at: now })
}

function consumeSelfWrite(resolved: string, mtimeMs: number | null): boolean {
  const rec = selfWrites.get(resolved)
  if (!rec) return false
  selfWrites.delete(resolved)
  if (Date.now() - rec.at > SELF_WRITE_SUPPRESS_MS) return false
  if (mtimeMs === null) return true
  return Math.abs(rec.mtimeMs - mtimeMs) < 1
}

export function createEditorWatcher(send: (evt: EditorFileChanged) => void): EditorWatcher {
  const dirWatchers = new Map<string, FSWatcher>()
  const debounceTimers = new Map<string, NodeJS.Timeout>()

  const checkFile = async (fullPath: string): Promise<void> => {
    let mtimeMs: number | null = null
    try {
      const stat = await fsp.stat(fullPath)
      if (!stat.isFile()) {
        if (consumeSelfWrite(fullPath, null)) return
        send({ filePath: fullPath, state: 'gone' })
        return
      }
      mtimeMs = Math.round(stat.mtimeMs)
    } catch {
      if (consumeSelfWrite(fullPath, null)) return
      send({ filePath: fullPath, state: 'gone' })
      return
    }
    if (consumeSelfWrite(fullPath, mtimeMs)) return
    send({ filePath: fullPath, state: 'changed', mtimeMs })
  }

  const scheduleCheck = (fullPath: string): void => {
    const existing = debounceTimers.get(fullPath)
    if (existing) clearTimeout(existing)
    debounceTimers.set(
      fullPath,
      setTimeout(() => {
        debounceTimers.delete(fullPath)
        void checkFile(fullPath)
      }, WATCH_DEBOUNCE_MS),
    )
  }

  const closeAll = (): void => {
    for (const timer of debounceTimers.values()) clearTimeout(timer)
    debounceTimers.clear()
    for (const watcher of dirWatchers.values()) watcher.close()
    dirWatchers.clear()
  }

  const setTargets = (filePaths: string[]): EditorWatchSetResult => {
    closeAll()
    const byDir = new Map<string, Map<string, string>>()
    let dropped = 0
    for (const raw of filePaths) {
      if (typeof raw !== 'string' || !raw.trim()) continue
      const resolved = path.resolve(raw)
      const dir = path.dirname(resolved)
      let names = byDir.get(dir)
      if (!names) {
        if (byDir.size >= WATCH_MAX_DIRS) {
          dropped++
          continue
        }
        names = new Map()
        byDir.set(dir, names)
      }
      names.set(path.basename(resolved), resolved)
    }
    for (const [dir, names] of byDir) {
      try {
        const watcher = fsWatch(dir, { persistent: false }, (_event, filename) => {
          const name = typeof filename === 'string' ? filename : ''
          if (name) {
            const full = names.get(name)
            if (full) scheduleCheck(full)
            return
          }
          // 部分平台不提供 filename：该目录下所有目标都查一遍
          for (const full of names.values()) scheduleCheck(full)
        })
        watcher.on('error', () => {
          // 目录被删 / 权限变化：静默关闭这只看门狗，编辑器本身不受影响
          watcher.close()
          dirWatchers.delete(dir)
        })
        dirWatchers.set(dir, watcher)
      } catch {
        dropped += names.size
      }
    }
    return { ok: true, watchedDirs: dirWatchers.size, dropped }
  }

  return { setTargets }
}
