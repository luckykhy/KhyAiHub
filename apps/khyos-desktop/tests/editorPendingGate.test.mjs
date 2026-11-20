// host 侧待审闸门（DESIGN-ARCH-210 M3）的状态机守卫。
// 这里守的是「谁能被拦、拦了之后决定怎么收束」：只有 actor='tool' 且路径在
// 编辑器打开集合内才拦；拒绝/关窗/重复都要把工具立即收束，绝不留悬空 Promise。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createEditorPendingGate } from '../src/host/editorPending.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..', '..', '..')
const require = createRequire(import.meta.url)

function makeGate() {
  const sent = []
  const gate = createEditorPendingGate({
    send: (m) => sent.push(m),
    nodeRequire: (id) => require(id),
    resolveKhyOsDir: () => repoRoot,
  })
  return { gate, sent }
}

function tempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-pending-gate-'))
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, content)
  return filePath
}

test('人保存（actor=editor）与未打开的文件都不进待审，直接放行', async () => {
  const { gate, sent } = makeGate()
  const filePath = tempFile('a.js', 'old\n')
  gate.setOpenPaths([filePath])
  assert.deepEqual(await gate.gate({ filePath, content: 'new\n', actor: 'editor', reason: 'save' }), {
    action: 'accept',
  })
  gate.setOpenPaths([])
  assert.deepEqual(await gate.gate({ filePath, content: 'new\n', actor: 'tool', reason: 'edit' }), {
    action: 'accept',
  })
  assert.equal(sent.length, 0)
})

test('工具改已打开文件：发卡片，拒绝后以明确错误收束工具', async () => {
  const { gate, sent } = makeGate()
  const filePath = tempFile('b.js', 'old\n')
  gate.setOpenPaths([filePath])
  const verdictPromise = gate.gate({
    filePath,
    content: 'new\n',
    beforeContent: 'old\n',
    actor: 'tool',
    reason: 'edit b',
  })
  const request = sent.find((m) => m.type === 'editor.pendingRequest')
  assert.ok(request, '应先把待审卡片发给主进程')
  assert.equal(request.beforeContent, 'old\n')
  assert.equal(request.afterContent, 'new\n')
  assert.equal(gate.decide(request.id, { accept: false }).ok, true)
  const verdict = await verdictPromise
  assert.equal(verdict.action, 'reject')
  assert.match(verdict.error, /未批准/)
  assert.equal(sent.some((m) => m.type === 'editor.pendingSettled' && m.state === 'rejected'), true)
})

test('逐块接受：只把选中的块拼进落盘内容', async () => {
  const { gate, sent } = makeGate()
  const beforeLines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
  const afterLines = beforeLines.slice()
  afterLines[1] = 'line 2 CHANGED'
  afterLines[37] = 'line 38 CHANGED'
  const before = `${beforeLines.join('\n')}\n`
  const after = `${afterLines.join('\n')}\n`
  const filePath = tempFile('c.js', before)
  gate.setOpenPaths([filePath])
  const verdictPromise = gate.gate({ filePath, content: after, beforeContent: before, actor: 'tool', reason: 'edit c' })
  const request = sent.find((m) => m.type === 'editor.pendingRequest')
  assert.equal(gate.decide(request.id, { accept: true, acceptedHunks: [0] }).ok, true)
  const verdict = await verdictPromise
  assert.equal(verdict.action, 'accept')
  const lines = verdict.content.split('\n')
  assert.equal(lines[1], 'line 2 CHANGED')
  assert.equal(lines[37], 'line 38')
})

test('同文件已有待审时第二笔直接拒绝（不让工具去撞 30s 锁超时）', async () => {
  const { gate, sent } = makeGate()
  const filePath = tempFile('d.js', 'one\n')
  gate.setOpenPaths([filePath])
  const first = gate.gate({ filePath, content: 'two\n', beforeContent: 'one\n', actor: 'tool', reason: 'first' })
  const second = await gate.gate({ filePath, content: 'three\n', beforeContent: 'one\n', actor: 'tool', reason: 'second' })
  assert.equal(second.action, 'reject')
  assert.match(second.error, /已有待审改动/)
  const request = sent.find((m) => m.type === 'editor.pendingRequest')
  gate.decide(request.id, { accept: false })
  assert.equal((await first).action, 'reject')
})

test('关窗 settleAll：全部待审以拒绝收束，并清理待审表', async () => {
  const { gate, sent } = makeGate()
  const filePath = tempFile('e.js', 'old\n')
  gate.setOpenPaths([filePath])
  const pending = gate.gate({ filePath, content: 'new\n', beforeContent: 'old\n', actor: 'tool', reason: 'edit e' })
  assert.equal(gate.settleAll('编辑器窗口已关闭：未批准的改动不落盘'), 1)
  const verdict = await pending
  assert.equal(verdict.action, 'reject')
  assert.match(verdict.error, /窗口已关闭/)
  assert.equal(sent.filter((m) => m.type === 'editor.pendingSettled').length, 1)
  assert.equal(gate.settleAll('again'), 0)
})
