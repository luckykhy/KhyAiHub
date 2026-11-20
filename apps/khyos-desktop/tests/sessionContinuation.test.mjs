// 会话续写的运行时契约：host 的 ai.generate 拿 sessionId 时必须落在同一条
// .khy/sessions 链上（桌面 / 手机 9413 / TUI 读同一份）。这里两头都验——
// 纯投影函数（喂给模型的消息）与真实 sessionPersistence 的落盘往返（磁盘上
// 的消息链），因为「中间件看着对、写下去却把标题清空」正是这类改动最容易漏的地方。
import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')

const { appendTurn, composePersistState, titleForPrompt, toContinuationMessages } = await import(
  pathToFileURL(path.resolve(here, '../src/host/sessionContinuation.ts')).href
)

test('toContinuationMessages 只留 user/assistant 的角色与内容', () => {
  const prior = [
    { role: 'user', content: '第一问', timestamp: 1, uuid: 'u1', parentUuid: null },
    { role: 'assistant', content: [{ type: 'text', text: '第一答' }], timestamp: 2 },
    { role: 'system', content: '系统提示不应重复注入' },
    { role: 'tool', content: '工具输出' },
    null,
    'garbage',
  ]
  assert.deepEqual(toContinuationMessages(prior), [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: [{ type: 'text', text: '第一答' }] },
  ])
  assert.deepEqual(toContinuationMessages(null), [])
})

test('appendTurn 保留历史并追加本轮两跳', () => {
  const prior = [{ role: 'user', content: '旧问' }, { role: 'assistant', content: '旧答' }]
  const next = appendTurn(prior, '新问', '新答')
  assert.equal(prior.length, 2, '不能就地改调用方的数组')
  assert.deepEqual(next.slice(2), [
    { role: 'user', content: '新问' },
    { role: 'assistant', content: '新答' },
  ])
})

test('titleForPrompt 压成一行并截断', () => {
  assert.equal(titleForPrompt('  帮我\n看下   日志  '), '帮我 看下 日志')
  assert.equal(titleForPrompt('一二三四五六', 4), '一二三四…')
})

test('composePersistState：首轮铸标题，续写原样带回标题与创建时间', () => {
  const source = { type: 'manual', id: '' }
  const first = composePersistState({
    prior: [],
    prompt: '帮我看下\n这个报错',
    reply: '好',
    sessionId: '',
    cwd: 'D:/ws',
    source,
  })
  assert.equal(first.title, '帮我看下 这个报错')
  assert.equal(first.createdAt, undefined, '首轮没有历史创建时间可带')
  assert.deepEqual(first.messages.map((m) => m.role), ['user', 'assistant'])

  const createdAt = 1_700_000_000_000
  const next = composePersistState({
    prior: [{ role: 'user', content: '旧问' }, { role: 'assistant', content: '旧答' }],
    prompt: '新问',
    reply: '新答',
    sessionId: 'sess-abc',
    title: '帮我看下 这个报错',
    createdAt,
    cwd: 'D:/ws',
    source,
  })
  // 这两条是回归点：缺了它们，persistSession 会把续写会话的标题清空、创建时间刷成此刻。
  assert.equal(next.title, '帮我看下 这个报错')
  assert.equal(next.createdAt, createdAt)
  assert.equal(next.messages.length, 4)
})

test('续写同一会话：消息接在链上，标题与创建时间不被重写', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-session-cont-'))
  process.env.KHY_PROJECT_DATA_HOME = path.join(home, 'khy')
  // sessionPersistence 是 CommonJS，且在 require 时按 env 解析数据家 —— 必须
  // 在设置 KHY_PROJECT_DATA_HOME 之后再解析它。
  const nodeRequire = createRequire(import.meta.url)
  const sp = nodeRequire(path.join(repoRoot, 'runtime', 'node', 'backend', 'src', 'services', 'sessionPersistence.js'))
  const cwd = path.join(home, 'workspace')
  fs.mkdirSync(cwd, { recursive: true })
  const createdAt = Date.now() - 60_000

  const source = { type: 'manual', id: '' }
  const id = sp.persistSession(undefined, composePersistState({
    prior: [],
    prompt: '第一问',
    reply: '第一答',
    sessionId: '',
    model: 'provider/model-a',
    cwd,
    source,
    createdAt,
  }))
  assert.ok(id, '未给 id 时应自铸一个会话 id')

  const restored = sp.restoreSession(id)
  assert.equal(restored.messages.length, 2)
  assert.equal(restored.title, '第一问')
  assert.equal(restored.createdAt, createdAt)
  assert.deepEqual(
    restored.messages.map((m) => m.role),
    ['user', 'assistant']
  )

  // 第二轮：host 的续写路径 = 恢复 → 只把角色/内容喂模型 → 整个状态写回。
  const second = sp.persistSession(id, composePersistState({
    prior: restored.messages,
    prompt: '第二问',
    reply: '第二答',
    sessionId: id,
    title: restored.title,
    createdAt: restored.createdAt,
    model: restored.model,
    cwd,
    source,
  }))
  assert.equal(second, id, '续写不得另开会话')

  // persistSession 对「进程内已建立」的会话把 JSON 快照改写挪到收尾 tick
  // （JSONL 才是权威源，用户回车后不必等整份 pretty-print）。等一拍再读快照字段。
  await new Promise((res) => setImmediate(res))
  const after = sp.restoreSession(id)
  assert.deepEqual(
    after.messages.map((m) => [m.role, m.content]),
    [
      ['user', '第一问'],
      ['assistant', '第一答'],
      ['user', '第二问'],
      ['assistant', '第二答'],
    ],
    '第二轮必须接在第一轮后面，而不是覆盖或重写'
  )
  assert.equal(after.title, '第一问', '续写不得把标题清空')
  assert.equal(after.createdAt, createdAt, '续写不得把创建时间刷成此刻')
  assert.equal(after.model, 'provider/model-a')

  // persistSession 对「进程内已建立」的会话把 JSON 快照改写挪到收尾 tick
  // （JSONL 才是权威源，用户回车后不必等整份 pretty-print）。等一拍再读快照。
  await new Promise((res) => setImmediate(res))
  const listed = sp.listPersistedSessions({ limit: 10 }).find((s) => s.sessionId === id)
  assert.ok(listed, '续写后的会话应出现在同一会话列表里')
  assert.equal(listed.messageCount, 4)

  // 模型的续写上下文只带角色与内容，不回灌磁盘字段（uuid/parentUuid/timestamp）。
  assert.deepEqual(toContinuationMessages(after.messages), [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' },
    { role: 'assistant', content: '第二答' },
  ])

  // 搜索索引是写穿到 sessions.db 的：先关掉连接再删临时目录，否则 Windows 报 EBUSY。
  try {
    nodeRequire(path.join(repoRoot, 'runtime', 'node', 'backend', 'src', 'services', 'sessionSearchIndex.js')).shutdown()
  } catch {
    /* 索引未启用时没有连接可关 */
  }
  fs.rmSync(home, { recursive: true, force: true })
})
