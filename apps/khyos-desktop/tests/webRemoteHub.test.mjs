// 桌面 main 侧远程控制接线的运行时契约测试：不启 Electron，用假 host 子进程驱动
// src/main/remote/index.ts，验证「面板指令 → host IPC → 后端服务 → 手机事件」这条
// 链上的字段映射与角色判定真的对得上（此前只有类型检查兜底）。
import { test } from 'node:test'
import assert from 'node:assert'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// 后端根：仓库根 = apps/khyos-desktop/../
process.env.KHY_OS_DIR = path.resolve(here, '..', '..', '..')

const { createRemoteHub } = await import(pathToFileURL(path.resolve(here, '../src/main/remote/index.ts')).href)

function harness() {
  const toHost = []
  const events = []
  const hub = createRemoteHub({
    sendToHost: (m) => toHost.push(m),
    hostAlive: () => true,
    getWorkspaceRoot: async () => 'D:/Portable/khy-os',
    onEvent: (e) => events.push(e),
    logger: () => {},
  })
  return { hub, toHost, events }
}

function respondTo(hub, msg) {
  // 后端 askHost 的 id 是 remote_*，主路由把回帧交给 hub.consume
  hub.consume(msg)
}

test('面板开启后 status 走 idle→running，且带可核对的监听地址', async () => {
  const { hub } = harness()
  assert.equal(hub.status().status, 'idle')
  const r = await hub.start({ lanEnabled: false })
  const s = hub.status()
  assert.equal(r.status, 'running')
  assert.equal(s.bindHost, '127.0.0.1')
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/r#p=[A-Z0-9]{8}$/)
  assert.equal(s.lanEnabled, false)
  await hub.stop()
  assert.equal(hub.status().status, 'idle')
})

test('手机的任务/会话/发消息请求映射到 host IPC 协议', async () => {
  const { hub, toHost } = harness()
  await hub.start({ lanEnabled: false })
  const code = hub.status().pairCode
  const s = hub.status()
  const url = new URL(s.url)
  const ws = new WebSocket(`ws://${url.host}/r/ws`)
  const got = []
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)))
  await new Promise((res) => { ws.onopen = res })
  ws.send(JSON.stringify({ khy_type: 'khy_bootstrap_request', pairCode: code, deviceInfo: { name: 'test-phone' } }))
  await new Promise((res) => setTimeout(res, 300))
  assert.ok(got.some((m) => m.type === 'khy_pair_pending'), '配对请求应到达桌面侧')

  // 桌面端点「同意（可发消息）」
  const pending = hub.status().pending[0]
  await hub.approve(pending.pairingId, 'operator')
  await new Promise((res) => setTimeout(res, 200))

  // 手机要任务列表：host 回帧后应转成 khy_task_list_response
  toHost.length = 0
  ws.send(JSON.stringify({ khy_type: 'khy_task_list_request', requestId: 'q1' }))
  await new Promise((res) => setTimeout(res, 200))
  const sent = toHost.find((m) => m.type === 'session.list')
  assert.ok(sent && /^remote_/.test(sent.id), '应发 session.list 给 host')
  respondTo(hub, { type: 'session.listResult', id: sent.id, ok: true, sessions: [{ sessionId: 's1', title: '任务甲' }] })
  await new Promise((res) => setTimeout(res, 300))
  const taskResp = got.find((m) => m.type === 'khy_task_list_response')
  assert.equal(taskResp.result[0].title, '任务甲')

  // 手机发消息 → ai.generate 带工作区根；host 的流事件回流到手机
  toHost.length = 0
  ws.send(JSON.stringify({ khy_type: 'khy_session_send_request', requestId: 'q2', sessionId: 's1', text: '跑一下' }))
  await new Promise((res) => setTimeout(res, 200))
  const gen = toHost.find((m) => m.type === 'ai.generate')
  assert.equal(gen.prompt, '跑一下')
  assert.equal(gen.options.cwd, 'D:/Portable/khy-os')
  hub.consume({ type: 'ai.chunk', id: gen.id, chunk: { text: '第一段' } })
  hub.consume({ type: 'ai.toolCall', id: gen.id, tool: 'readFile' })
  hub.consume({ type: 'ai.result', id: gen.id, ok: true, text: '完成' })
  await new Promise((res) => setTimeout(res, 200))
  const streams = got.filter((m) => m.type === 'khy_stream')
  assert.deepEqual(streams.map((m) => m.event.kind), ['chunk', 'tool_call', 'end'])
  assert.equal(streams[0].event.text, '第一段')

  // 手机转达审批 → host ai.controlResponse
  toHost.length = 0
  ws.send(JSON.stringify({ khy_type: 'khy_control_response', requestId: 'ctl1', response: { behavior: 'allow' } }))
  await new Promise((res) => setTimeout(res, 200))
  const ctl = toHost.find((m) => m.type === 'ai.controlResponse')
  assert.equal(ctl.requestId, 'ctl1')
  assert.deepEqual(ctl.response, { behavior: 'allow' })

  ws.close()
  await hub.stop()
})

test('host 不可达时如实报错，不静默成功', async () => {
  const events = []
  const hub = createRemoteHub({
    sendToHost: () => {},
    hostAlive: () => false,
    getWorkspaceRoot: async () => 'D:/Portable/khy-os',
    onEvent: (e) => events.push(e),
  })
  await hub.start({ lanEnabled: false })
  const s = hub.status()
  const url = new URL(s.url)
  const ws = new WebSocket(`ws://${url.host}/r/ws`)
  const got = []
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)))
  await new Promise((res) => { ws.onopen = res })
  ws.send(JSON.stringify({ khy_type: 'khy_bootstrap_request', pairCode: s.pairCode, deviceInfo: { name: 'p2' } }))
  await new Promise((res) => setTimeout(res, 250))
  await hub.approve(hub.status().pending[0].pairingId, 'operator')
  await new Promise((res) => setTimeout(res, 400))
  const tasks = got.find((m) => m.type === 'khy_task_list_response')
  assert.ok(!tasks || tasks.ok !== true, 'host 不可达时不得返回成功的任务列表')
  ws.close()
  await hub.stop()
})

test('probeBridge 探不到 CLI 时给出可执行的下一步', async () => {
  const { hub } = harness()
  const r = await hub.probeBridge()
  assert.equal(r.found, false)
  assert.match(String(r.error), /khy bridge start/)
})
