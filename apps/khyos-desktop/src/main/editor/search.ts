import { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  EDITOR_SEARCH_PREVIEW_CHARS,
  SEARCH_BUDGET_MS,
  SEARCH_MAX_FILE_BYTES,
  SEARCH_MAX_HITS,
  SEARCH_MAX_HIT_FILES,
  SEARCH_MAX_HITS_PER_FILE,
  SEARCH_MAX_TOTAL_BYTES,
  SEARCH_PROGRESS_EVERY_FILES,
  SEARCH_YIELD_EVERY_FILES,
  type EditorSearchHit,
  type EditorSearchOptions,
  type EditorSearchProgress,
  type EditorSearchResult,
} from '../../shared/editorContract.ts'
import { MAX_INDEX_DEPTH, MAX_INDEX_FILES, isSkippedDir, isTextFileName } from './workspaceRules.ts'

// 工作区全局搜索：无 ripgrep 依赖（PROCESS-013 零新增依赖），用有界 fs 遍历。
//
// 三条硬约束：
//   ① 不设 kill 定时器 —— 循环内协作式检查耗时预算并 `await setImmediate`
//      让出事件循环（RUNTIME-003：不硬杀长任务，到点诚实收尾）；
//   ② 四件套上限同时生效，任一触顶就 truncated + 写明「还有 N 个文件未扫描」，
//      不许把「搜不完」说成「没找到」（RUNTIME-002）；
//   ③ 取消走标志位 + 下一轮循环检查，主进程不做线程强杀。

interface ActiveSearch {
  cancelled: boolean
}

const activeSearches = new Map<string, ActiveSearch>()
let searchSeq = 0

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

export function cancelEditorSearch(searchId: string): boolean {
  const state = activeSearches.get(searchId)
  if (!state) return false
  state.cancelled = true
  return true
}

export interface SearchDeps {
  onProgress: (progress: EditorSearchProgress) => void
}

interface CollectResult {
  files: string[]
  /** 枚举阶段自己就触顶（文件数 / 耗时）时为 true */
  capped: boolean
}

function previewLine(line: string): string {
  return line.trim().slice(0, EDITOR_SEARCH_PREVIEW_CHARS)
}

async function collectFiles(root: string, state: ActiveSearch, deadline: number): Promise<CollectResult> {
  const files: string[] = []
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  let capped = false
  while (queue.length > 0) {
    if (state.cancelled) return { files, capped }
    if (Date.now() > deadline) return { files, capped: true }
    const current = queue.shift() as { dir: string; depth: number }
    let entries
    try {
      entries = await fsp.readdir(current.dir, { withFileTypes: true })
    } catch {
      continue // 读不了的子目录跳过，不让一个目录的权限问题废掉整次搜索
    }
    for (const ent of entries) {
      if (files.length >= MAX_INDEX_FILES) {
        capped = true
        break
      }
      if (ent.isDirectory()) {
        if (current.depth < MAX_INDEX_DEPTH && !isSkippedDir(ent.name) && !ent.name.startsWith('.')) {
          queue.push({ dir: path.join(current.dir, ent.name), depth: current.depth + 1 })
        }
      } else if (ent.isFile() && isTextFileName(ent.name)) {
        files.push(path.join(current.dir, ent.name))
      }
    }
    if (capped) break
    await yieldToEventLoop()
  }
  return { files, capped }
}

export async function runEditorSearch(
  root: string,
  query: string,
  options: EditorSearchOptions,
  deps: SearchDeps,
): Promise<EditorSearchResult> {
  // 允许渲染层预生成 id（取消按钮在结果返回之前就需要它）；只接受安全字符
  // 与有限长度，避免调用方把任意字符串灌进地图键。
  const requested = typeof options.searchId === 'string' ? options.searchId.trim() : ''
  const searchId = /^[A-Za-z0-9_-]{1,64}$/.test(requested)
    ? requested
    : `editor_search_${Date.now()}_${++searchSeq}`
  const state: ActiveSearch = { cancelled: false }
  activeSearches.set(searchId, state)
  const startedAt = Date.now()
  const deadline = startedAt + SEARCH_BUDGET_MS
  const result = (partial: Partial<EditorSearchResult> & { scannedFiles: number; totalFiles: number }): EditorSearchResult => ({
    ok: true,
    searchId,
    hits: [],
    skippedFiles: 0,
    truncated: false,
    ...partial,
  })

  try {
    const needleRaw = typeof query === 'string' ? query : ''
    if (!needleRaw.trim()) {
      return {
        ok: false,
        searchId,
        hits: [],
        scannedFiles: 0,
        totalFiles: 0,
        skippedFiles: 0,
        truncated: false,
        error: '搜索内容为空：请输入要查找的文本',
      }
    }
    const needle = options.caseSensitive ? needleRaw : needleRaw.toLowerCase()
    const { files, capped } = await collectFiles(root, state, deadline)
    if (state.cancelled) {
      return result({ scannedFiles: 0, totalFiles: files.length, truncated: true, cancelled: true, reason: '搜索已取消：未返回任何结果' })
    }
    const totalFiles = files.length
    const hits: EditorSearchHit[] = []
    const hitFiles = new Set<string>()
    let scanned = 0
    let skipped = 0
    let totalBytes = 0
    let truncated = capped
    let reason = capped ? `文件索引达到 ${MAX_INDEX_FILES} 个上限：只搜索了前 ${totalFiles} 个文件` : ''

    deps.onProgress({ searchId, scannedFiles: 0, totalFiles, hitCount: 0, hitFiles: 0 })

    for (const filePath of files) {
      if (state.cancelled) {
        return result({
          scannedFiles: scanned,
          totalFiles,
          hits,
          skippedFiles: skipped,
          truncated: true,
          cancelled: true,
          reason: `搜索已取消：已扫描 ${scanned}/${totalFiles} 个文件，返回此前命中的 ${hits.length} 处`,
        })
      }
      if (Date.now() - startedAt > SEARCH_BUDGET_MS) {
        truncated = true
        reason = `搜索已用满 ${SEARCH_BUDGET_MS / 1000}s 时间预算：还有 ${totalFiles - scanned} 个文件未扫描`
        break
      }
      if (hits.length >= SEARCH_MAX_HITS) {
        truncated = true
        reason = `命中数达到 ${SEARCH_MAX_HITS} 处上限：还有 ${totalFiles - scanned} 个文件未扫描`
        break
      }
      if (hitFiles.size >= SEARCH_MAX_HIT_FILES) {
        truncated = true
        reason = `命中文件数达到 ${SEARCH_MAX_HIT_FILES} 个上限：还有 ${totalFiles - scanned} 个文件未扫描`
        break
      }
      if (totalBytes >= SEARCH_MAX_TOTAL_BYTES) {
        truncated = true
        reason = `已读取 ${SEARCH_MAX_TOTAL_BYTES / 1024 / 1024} MiB 内容上限：还有 ${totalFiles - scanned} 个文件未扫描`
        break
      }

      let size = 0
      try {
        const stat = await fsp.stat(filePath)
        size = stat.size
        if (!stat.isFile() || size > SEARCH_MAX_FILE_BYTES) {
          skipped++
          scanned++
          continue
        }
      } catch {
        skipped++
        scanned++
        continue
      }
      if (totalBytes + size > SEARCH_MAX_TOTAL_BYTES) {
        truncated = true
        reason = `已读取 ${SEARCH_MAX_TOTAL_BYTES / 1024 / 1024} MiB 内容上限：还有 ${totalFiles - scanned} 个文件未扫描`
        break
      }

      let buf: Buffer
      try {
        buf = await fsp.readFile(filePath)
      } catch {
        skipped++
        scanned++
        continue
      }
      totalBytes += buf.length
      if (buf.subarray(0, Math.min(buf.length, 8192)).includes(0)) {
        skipped++
        scanned++
        continue
      }
      const lines = buf.toString('utf-8').split('\n')
      let fileHits = 0
      for (let i = 0; i < lines.length; i++) {
        if (fileHits >= SEARCH_MAX_HITS_PER_FILE || hits.length >= SEARCH_MAX_HITS) break
        const line = lines[i]
        const hay = options.caseSensitive ? line : line.toLowerCase()
        let from = 0
        while (fileHits < SEARCH_MAX_HITS_PER_FILE && hits.length < SEARCH_MAX_HITS) {
          const col = hay.indexOf(needle, from)
          if (col < 0) break
          hits.push({ filePath, line: i + 1, column: col + 1, preview: previewLine(line) })
          fileHits++
          from = col + Math.max(needle.length, 1)
        }
        if (fileHits > 0) hitFiles.add(filePath)
      }
      scanned++
      if (scanned % SEARCH_YIELD_EVERY_FILES === 0) await yieldToEventLoop()
      if (scanned % SEARCH_PROGRESS_EVERY_FILES === 0) {
        deps.onProgress({ searchId, scannedFiles: scanned, totalFiles, hitCount: hits.length, hitFiles: hitFiles.size })
      }
    }

    deps.onProgress({ searchId, scannedFiles: scanned, totalFiles, hitCount: hits.length, hitFiles: hitFiles.size })
    return result({
      scannedFiles: scanned,
      totalFiles,
      hits,
      skippedFiles: skipped,
      truncated,
      ...(reason ? { reason } : {}),
    })
  } catch (err) {
    return {
      ok: false,
      searchId,
      hits: [],
      scannedFiles: 0,
      totalFiles: 0,
      skippedFiles: 0,
      truncated: false,
      error: `搜索失败：${(err as Error)?.message || String(err)}，请检查工作区目录权限`,
    }
  } finally {
    activeSearches.delete(searchId)
  }
}
