import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { EDITOR_READ_MAX_BYTES, type EditorReadResult } from '../../shared/editorContract'
import { isInsideAnyRoot } from './workspaceRules'

// 工作台读通道：与 codeViewer:read（256KB 只读预览）分开 —— 编辑需要更大的
// 上限、需要行尾与 BOM 元信息（否则一保存就把 CRLF 全改成 LF），也需要
// 白名单校验（只读预览不写盘，写通道必须自己把住根目录）。
//
// 模型内部统一 \n；eol 只作为保存时的还原依据。

export async function readEditorFile(filePath: string, roots: Set<string>): Promise<EditorReadResult> {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { ok: false, state: 'missing', error: '文件路径为空：请先在工作台左侧选择文件' }
  }
  const resolved = path.resolve(filePath.trim())
  if (!isInsideAnyRoot(resolved, roots)) {
    return {
      ok: false,
      state: 'outsideWorkspace',
      error: `拒绝读取 ${resolved}：该文件不在已登记的工作区内，请先用「打开工作区」登记它的目录`,
    }
  }
  try {
    const stat = await fsp.stat(resolved)
    if (!stat.isFile()) {
      return { ok: false, state: 'missing', error: `目标不是文件：${resolved}，请在文件树里选择一个文件` }
    }
    if (stat.size > EDITOR_READ_MAX_BYTES) {
      const sizeMb = (stat.size / 1024 / 1024).toFixed(1)
      const limitMb = (EDITOR_READ_MAX_BYTES / 1024 / 1024).toFixed(0)
      return {
        ok: false,
        state: 'tooLarge',
        size: stat.size,
        error: `文件 ${path.basename(resolved)} 为 ${sizeMb} MiB，超过 ${limitMb} MiB 编辑上限：请改用外部编辑器打开`,
      }
    }
    const buf = await fsp.readFile(resolved)
    const probe = buf.subarray(0, Math.min(buf.length, 8192))
    if (probe.includes(0)) {
      return {
        ok: false,
        state: 'binary',
        size: stat.size,
        error: `文件 ${path.basename(resolved)} 含二进制内容（NUL 字节）：不能按文本编辑`,
      }
    }
    const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
    const raw = buf.toString('utf-8', bom ? 3 : 0)
    const eol: 'lf' | 'crlf' = raw.includes('\r\n') ? 'crlf' : 'lf'
    const content = eol === 'crlf' ? raw.replace(/\r\n/g, '\n') : raw
    return {
      ok: true,
      state: content.length === 0 ? 'empty' : 'ok',
      content,
      mtimeMs: Math.round(stat.mtimeMs),
      size: stat.size,
      eol,
      bom,
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      return { ok: false, state: 'missing', error: `文件不存在：${resolved}，请刷新文件树后重试` }
    }
    return {
      ok: false,
      state: 'error',
      error: `读取 ${path.basename(resolved)} 失败：${(err as Error)?.message || String(err)}，请检查文件权限`,
    }
  }
}
