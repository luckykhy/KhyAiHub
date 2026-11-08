// DiffViewer / DiffSummary 的 jsdom 挂载点：验证「红绿 ±行真的渲染出来」。
// 由 tests/toolDiffView.test.cjs 用 esbuild 打包后加载。
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DiffSummary, DiffViewer } from '../src/renderer/components/message/DiffViewer'
import type { ToolDiff } from '../src/shared/toolDiff'

export const FIXTURE: ToolDiff = {
  filePath: 'src/sort/quicksort.ts',
  added: 2,
  removed: 1,
  truncated: false,
  rows: [
    { kind: 'ctx', num: 1, numNew: 1, text: 'function quicksort(arr: number[]): number[] {' },
    { kind: 'del', num: 2, text: '  if (arr.length === 0) return [];' },
    { kind: 'add', num: 2, numNew: 2, text: '  if (arr.length <= 1) return arr;' },
    { kind: 'add', num: 3, numNew: 3, text: '  const middle = arr.filter((x) => x === pivot);' },
    { kind: 'ctx', num: 3, numNew: 4, text: '  const pivot = arr[0];' },
    { kind: 'stat', text: '└ 增加 2 行，删除 1 行' },
  ],
}

let root: Root | null = null

function render(node: React.ReactNode) {
  const el = document.getElementById('root')
  if (!el) throw new Error('缺少 #root 容器')
  root = createRoot(el)
  root.render(node)
}

export function mountViewer(diff: ToolDiff = FIXTURE) {
  render(<DiffViewer diff={diff} />)
}

export function mountSummary(files: Parameters<typeof DiffSummary>[0]['files']) {
  render(<DiffSummary files={files} onViewDiff={() => {}} />)
}

export function unmount() {
  if (root) {
    root.unmount()
    root = null
  }
}
