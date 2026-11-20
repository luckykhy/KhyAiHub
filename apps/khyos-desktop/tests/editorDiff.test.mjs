// AI 改动待审的块的切分与子集拼接（DESIGN-ARCH-210 M3）。
// 这里守的是最贵的一条不变量：界面上勾的「第几块」必须和 host 拼接时用的
// hunks 下标是同一份模型 —— 错一位就等于把用户拒绝的改动写进磁盘。
//
// Run: node --experimental-strip-types --test tests/editorDiff.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { applyAcceptedHunks, splitDiffHunks } from '../src/shared/editorDiff.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const backendSrc = path.join(here, '..', '..', '..', 'runtime', 'node', 'backend', 'src')
const { computeStructuredDiffHunks } = require(path.join(backendSrc, 'utils', 'diff', 'structuredHunks.js'))
const { buildWriteDiffRows } = require(path.join(backendSrc, 'cli', 'writeDiffRows.js'))

const row = (kind, text, extra = {}) => ({ kind, text, ...extra })

test('splitDiffHunks：按 gap 切块，stat / more 不计入任何块', () => {
  const rows = [
    row('ctx', 'a'),
    row('del', 'b'),
    row('add', 'b2'),
    row('gap', '⋯ 20 个未改动行'),
    row('ctx', 'c'),
    row('add', 'c2'),
    row('stat', '└ +2 -1'),
  ]
  const hunks = splitDiffHunks(rows)
  assert.equal(hunks.length, 2)
  assert.deepEqual(hunks[0].rows.map((r) => r.kind), ['ctx', 'del', 'add'])
  assert.deepEqual(hunks[1].rows.map((r) => r.kind), ['ctx', 'add'])
  assert.deepEqual(hunks.map((h) => h.index), [0, 1])
})

test('splitDiffHunks：没有 gap 时只有一块；空行集返回空数组', () => {
  assert.equal(splitDiffHunks([row('add', 'x')]).length, 1)
  assert.deepEqual(splitDiffHunks([row('stat', '└ +0 -0'), row('more', '…')]), [])
})

function samplePair() {
  const beforeLines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
  const afterLines = beforeLines.slice()
  afterLines[1] = 'line 2 CHANGED'
  afterLines[37] = 'line 38 CHANGED'
  return {
    before: `${beforeLines.join('\n')}\n`,
    after: `${afterLines.join('\n')}\n`,
    beforeLines,
    afterLines,
  }
}

test('applyAcceptedHunks：接受第一块只写第一处改动', () => {
  const { before, after, afterLines } = samplePair()
  const { hunks } = computeStructuredDiffHunks(before, after, { context: 3 })
  assert.equal(hunks.length, 2, '两处相隔 36 行的改动应切成两块')
  const rebuilt = applyAcceptedHunks(before, after, hunks, new Set([0]))
  const lines = rebuilt.split('\n')
  assert.equal(lines[1], 'line 2 CHANGED')
  assert.equal(lines[37], 'line 38')
  assert.deepEqual(lines.slice(0, 40), [...afterLines.slice(0, 37), 'line 38', ...afterLines.slice(38)])
})

test('applyAcceptedHunks：接受第二块只写第二处改动', () => {
  const { before, after } = samplePair()
  const { hunks } = computeStructuredDiffHunks(before, after, { context: 3 })
  const rebuilt = applyAcceptedHunks(before, after, hunks, new Set([1]))
  const lines = rebuilt.split('\n')
  assert.equal(lines[1], 'line 2')
  assert.equal(lines[37], 'line 38 CHANGED')
})

test('applyAcceptedHunks：全部接受 = after 原样，一块不接受 = before 原样', () => {
  const { before, after } = samplePair()
  const { hunks } = computeStructuredDiffHunks(before, after, { context: 3 })
  assert.equal(applyAcceptedHunks(before, after, hunks, new Set([0, 1])), after)
  assert.equal(applyAcceptedHunks(before, after, hunks, new Set()), before)
})

test('buildWriteDiffRows 的 gap 行数与 structuredHunks 的块下标一一对应', () => {
  const { before, after } = samplePair()
  const { hunks } = computeStructuredDiffHunks(before, after, { context: 3 })
  const rows = buildWriteDiffRows({ filePath: 'x.js', beforeContent: before, afterContent: after }, true)
  assert.ok(Array.isArray(rows))
  const uiHunks = splitDiffHunks(rows)
  assert.equal(uiHunks.length, hunks.length, '界面切块数必须等于拼接用的 hunks 数')
})
