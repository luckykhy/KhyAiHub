// 桌面端 amoo 接入的运行时契约测试：不启 Electron，用真实的本地 HTTP 假桥
// 驱动 src/main/amoon/index.ts，验证「磁盘事实 → /health → /status → /v1/call」
// 这条链，以及 token 永远不出现在状态对象里。
import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(path.resolve(here, '../src/main/amoon/index.ts')).href)
const { createAmoonHub, resolveBridgeRoot, resolveStateDir, readRuntimeFile, readOperatorTokenInfo } = mod

const TOKEN = 'khy_' + 'a'.repeat(43)

function tempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-amoon-test-'))
  return dir
}

function writeRuntime(dir, port, pid = process.pid) {
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ port, pid, host: '127.0.0.1' }), 'utf8')
}

function writeToken(dir, value = TOKEN) {
  fs.writeFileSync(path.join(dir, 'operator.token'), value, 'utf8')
}

// 假桥：严格模拟真桥的三条外部行为
//   1. 带 Origin 一律 403（server.js:848-859）
//   2. /health 免鉴权（server.js:874-893）
//   3. /status 与 /v1/call 需要 Bearer（server.js:896-918, 476+）
async function startFakeBridge({ token = TOKEN, healthStatus = 200 } = {}) {
  const seen = []
  // /v1/call 的请求体：断言桌面端真的按桥的契约传了 mode/open_chat/requires_ack/limit。
  const calls = []
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers, method: req.method })
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers.origin) {
      send(403, { ok: false, error: { code: 'forbidden_scope', message: '不接受浏览器 Origin 请求' } })
      return
    }
    const port = server.address().port
    if (req.url === '/health') {
      // 用真实的 503 模拟「端口有人监听但 daemon 未就绪」，不依赖端口恰好空着
      send(healthStatus, healthStatus === 200 ? { ok: true } : { ok: false, error: { code: 'unavailable' } })
      return
    }
    const auth = String(req.headers.authorization || '')
    if (!auth.startsWith('Bearer ') || auth.slice(7) !== token) {
      send(401, { ok: false, error: { code: 'unauthorized', message: 'bad token' } })
      return
    }
    if (req.url === '/status') {
      send(200, {
        ok: true,
        id: 'req',
        data: {
          protocol: 'khy-amoon/1',
          port,
          auth: { present: true, valid: true, length: token.length },
          counters: { requests: 1, authorized: 1 },
          tasks: { state: 'RUNNING' },
          adb_ok: true,
          last_poll: new Date().toISOString(),
          last_error: null,
        },
      })
      return
    }
    if (req.url === '/v1/call' && req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => {
        raw += c
      })
      req.on('end', () => {
        const body = JSON.parse(raw)
        calls.push(body)
        if (body.tool === 'amoon_send' && body.args.text === '__QUEUE__') {
          // file 模式 push 失败：桥抛 BridgeError(details={state:'queued',local_path})
          send(503, {
            ok: false,
            id: body.id,
            tool: 'amoon_send',
            error: {
              code: 'adb_unavailable',
              message: '手机端 mv 失败（outbox 未写入）',
              details: { id: 'msg_q', state: 'queued', local_path: 'C:/tmp/spool/msg_q.json' },
            },
          })
        } else if (body.tool === 'amoon_send') {
          send(200, {
            ok: true,
            id: body.id,
            tool: 'amoon_send',
            data: {
              id: 'msg_1',
              state: 'pushed',
              channel: body.args.mode,
              intent_sent: false,
              intent_error: null,
              open_chat: null,
              requires_ack: body.args.requires_ack,
              verified: false,
              local_path: 'C:/tmp/spool/msg_1.json',
              spool_retired: true,
              remote_path: '/sdcard/khy-amoon-bridge/outbox/msg_1.json',
              push_error: null,
            },
          })
        } else if (body.tool === 'amoon_inbox') {
          send(200, {
            ok: true,
            id: body.id,
            tool: 'amoon_inbox',
            data: {
              messages: [
                { id: 'ack_1', kind: 'ack', text: 'ok', ts: new Date().toISOString(), status: 'received', unverified: true },
              ],
              count: 1,
              total: 1,
              skipped: 0,
              unverified: true,
            },
          })
        } else {
          send(400, { ok: false, error: { code: 'unknown_tool', message: body.tool } })
        }
      })
      return
    }
    send(404, { ok: false, error: { code: 'not_found', message: req.url } })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, seen, calls, port: server.address().port }
}

async function startUnhealthyBridge() {
  // 「端口有人监听但 /health 503」的假桥，专门制造 unhealthy。
  return startFakeBridge({ healthStatus: 503 })
}

// 假 spawn：记录调用，并在子进程 close 前执行 onSpawn(args)（用于模拟 CLI 副作用）。
// 不使用真实子进程，也不赌博任何端口是否空着。
function fakeSpawn(record, onSpawn) {
  return (cmd, args, opts) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    record.push({ cmd, args, env: opts?.env, cwd: opts?.cwd })
    setTimeout(() => {
      try {
        onSpawn?.(args)
      } catch {
        /* 副作用失败也照常 close，由 hub 重新探测并报错 */
      }
      child.emit('close', 0)
    }, 0)
    return child
  }
}

function tempBridgeRoot() {
  const root = tempState()
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'bin', 'cli.js'), '// fake cli\n', 'utf8')
  return root
}

test('resolveStateDir：KHY_AMOON_HOME 优先，其次 LOCALAPPDATA\\khy-amoon-bridge', () => {
  assert.equal(resolveStateDir({ KHY_AMOON_HOME: 'D:/x/state' }, 'win32'), path.resolve('D:/x/state'))
  assert.equal(
    resolveStateDir({ LOCALAPPDATA: 'C:/Users/u/AppData/Local' }, 'win32'),
    path.join(path.resolve('C:/Users/u/AppData/Local'), 'khy-amoon-bridge'),
  )
})

test('runtime.json 与 operator.token 的磁盘判据与真桥一致', () => {
  const dir = tempState()
  try {
    assert.deepEqual(readRuntimeFile(dir), { present: false, pid: null, port: null, malformed: false })

    fs.writeFileSync(path.join(dir, 'runtime.json'), '{not json', 'utf8')
    assert.equal(readRuntimeFile(dir).malformed, true)

    writeRuntime(dir, 18765, 4321)
    assert.deepEqual(readRuntimeFile(dir), { present: true, pid: 4321, port: 18765, malformed: false })

    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ port: 70000, pid: 1 }), 'utf8')
    assert.equal(readRuntimeFile(dir).malformed, true)

    assert.deepEqual(readOperatorTokenInfo(dir), { present: false, valid: false, length: 0 })
    writeToken(dir, 'short')
    assert.deepEqual(readOperatorTokenInfo(dir), { present: true, valid: false, length: 5 })
    writeToken(dir)
    assert.deepEqual(readOperatorTokenInfo(dir), { present: true, valid: true, length: TOKEN.length })
    // 这个对象就是跨 IPC 的全部 token 信息，不允许带原文
    assert.deepEqual(Object.keys(readOperatorTokenInfo(dir)).sort(), ['length', 'present', 'valid'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('状态目录不存在 → uninstalled（不创建目录、不伪造在线）', async () => {
  const dir = path.join(tempState(), 'missing')
  const hub = createAmoonHub({ env: { KHY_AMOON_HOME: dir }, platform: 'win32', bridgeRoot: null })
  const s = await hub.status()
  assert.equal(s.phase, 'uninstalled')
  assert.equal(s.stateDirExists, false)
  assert.equal(s.health, false)
  assert.equal(s.canSend, false)
  assert.equal(fs.existsSync(dir), false, 'status 是只读的：不能创建状态目录')
  assert.match(s.message, /未安装 amoo 桥接/)
})

test('runtime.json 存在但 /health 返回 503 → unhealthy（不是 running）', async () => {
  const fake = await startUnhealthyBridge()
  const dir = tempState()
  try {
    writeToken(dir)
    writeRuntime(dir, fake.port)
    const hub = createAmoonHub({ env: { KHY_AMOON_HOME: dir }, platform: 'win32', bridgeRoot: null })
    const s = await hub.status()
    assert.equal(s.phase, 'unhealthy')
    assert.equal(s.health, false)
    assert.match(s.message, /\/health 不通/)
    assert.equal(s.runtime.port, fake.port)
    assert.equal(s.canSend, false)
  } finally {
    fake.server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('health 通但 token 缺失 → running 且 canSend=false（fail-closed）', async () => {
  const fake = await startFakeBridge()
  const dir = tempState()
  try {
    writeRuntime(dir, fake.port)
    const hub = createAmoonHub({ env: { KHY_AMOON_HOME: dir }, platform: 'win32', bridgeRoot: null })
    const s = await hub.status()
    assert.equal(s.phase, 'running')
    assert.equal(s.health, true)
    assert.equal(s.token.present, false)
    assert.equal(s.canSend, false)
  } finally {
    fake.server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('running：status/send/inbox 全程不泄露 token，/v1/call 不带 Origin', async () => {
  const fake = await startFakeBridge()
  const dir = tempState()
  try {
    writeToken(dir)
    writeRuntime(dir, fake.port)
    const hub = createAmoonHub({ env: { KHY_AMOON_HOME: dir }, platform: 'win32', bridgeRoot: null })

    const s = await hub.status()
    assert.equal(s.phase, 'running')
    assert.equal(s.canSend, true)
    assert.equal(s.daemon?.state, 'RUNNING')
    assert.equal(s.daemon?.adbOk, true)
    assert.equal(s.token.length, TOKEN.length)
    const serialized = JSON.stringify(s)
    assert.ok(!serialized.includes(TOKEN), '状态对象不得包含 operator token 原文')

    const sent = await hub.send({ text: '你好 amoo', openChat: false })
    assert.equal(sent.ok, true)
    assert.equal(sent.state, 'pushed')
    assert.equal(sent.verified, false)
    assert.equal(sent.requiresAck, true)

    const inbox = await hub.inbox(10)
    assert.equal(inbox.ok, true)
    assert.equal(inbox.messages.length, 1)
    assert.equal(inbox.messages[0].unverified, true)
    assert.equal(inbox.unverified, true)

    const call = fake.seen.find((r) => r.url === '/v1/call')
    assert.ok(call, '必须真的发出 /v1/call')
    assert.equal(call.headers.origin, undefined, '主进程 fetch 不能带 Origin（否则 bridge 403）')
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`)

    // send/inbox 的请求参数必须符合桥契约（contracts.js:488-496、amoon_inbox limit 1..100）
    const sendCall = fake.calls.find((c) => c.tool === 'amoon_send')
    assert.deepEqual(sendCall.args, { text: '你好 amoo', mode: 'file', open_chat: false, requires_ack: true })
    const inboxCall = fake.calls.find((c) => c.tool === 'amoon_inbox')
    assert.deepEqual(inboxCall.args, { limit: 10 })

    const statusReq = fake.seen.find((r) => r.url === '/status')
    assert.equal(statusReq.headers.authorization, `Bearer ${TOKEN}`)
    const healthReq = fake.seen.find((r) => r.url === '/health')
    assert.equal(healthReq.headers.authorization, undefined, '/health 不应携带 token')
  } finally {
    fake.server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('发送前校验：空文本/超长都在本地拒绝，不发 HTTP', async () => {
  const fake = await startFakeBridge()
  const dir = tempState()
  try {
    writeToken(dir)
    writeRuntime(dir, fake.port)
    const hub = createAmoonHub({ env: { KHY_AMOON_HOME: dir }, platform: 'win32', bridgeRoot: null })
    const empty = await hub.send({ text: '   ' })
    assert.equal(empty.ok, false)
    assert.equal(empty.error.code, 'invalid_args')
    const long = await hub.send({ text: 'x'.repeat(4001) })
    assert.equal(long.ok, false)
    assert.match(long.error.message, /4000/)
    assert.equal(fake.seen.filter((r) => r.url === '/v1/call').length, 0)
  } finally {
    fake.server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('bridge 的 401 被如实转成面板错误（不抛异常、不降级成成功）', async () => {
  const fake = await startFakeBridge()
  const dir = tempState()
  try {
    writeToken(dir, 'khy_' + 'b'.repeat(43))
    writeRuntime(dir, fake.port)
    const hub = createAmoonHub({ env: { KHY_AMOON_HOME: dir }, platform: 'win32', bridgeRoot: null })
    const r = await hub.send({ text: 'hi' })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'unauthorized')
  } finally {
    fake.server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('file 模式 push 失败 → queued 卡带 local_path，不降级成普通错误', async () => {
  const fake = await startFakeBridge()
  const dir = tempState()
  try {
    writeToken(dir)
    writeRuntime(dir, fake.port)
    const hub = createAmoonHub({ env: { KHY_AMOON_HOME: dir }, platform: 'win32', bridgeRoot: null })
    const r = await hub.send({ text: '__QUEUE__' })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'adb_unavailable')
    assert.equal(r.queued.localPath, 'C:/tmp/spool/msg_q.json')
  } finally {
    fake.server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveBridgeRoot：找到 bin/cli.js 才返回目录，否则 null', () => {
  const root = tempState()
  try {
    const bridge = path.join(root, 'delivery', 'extension', 'bridges', 'khy-amoon-bridge')
    fs.mkdirSync(path.join(bridge, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(bridge, 'bin', 'cli.js'), '// fake cli\n', 'utf8')
    assert.equal(resolveBridgeRoot({}, root), bridge)
    assert.equal(resolveBridgeRoot({ KHY_AMOON_BRIDGE_DIR: bridge }, tempState()), bridge)
    assert.equal(resolveBridgeRoot({}, tempState()), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('start：注入 spawnImpl 走 start --state-dir，带 ELECTRON_RUN_AS_NODE=1', async () => {
  const fake = await startFakeBridge()
  const dir = tempState()
  const bridgeRoot = tempBridgeRoot()
  const spawned = []
  try {
    writeToken(dir)
    const hub = createAmoonHub({
      env: { KHY_AMOON_HOME: dir },
      platform: 'win32',
      bridgeRoot,
      spawnImpl: fakeSpawn(spawned, () => writeRuntime(dir, fake.port)),
    })
    const r = await hub.start()
    assert.equal(r.ok, true)
    assert.equal(r.status.phase, 'running')
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].args[1], 'start')
    assert.deepEqual(spawned[0].args.slice(2), ['--state-dir', dir])
    assert.equal(spawned[0].env.ELECTRON_RUN_AS_NODE, '1')
  } finally {
    fake.server.close()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(bridgeRoot, { recursive: true, force: true })
  }
})

test('start：runtime.json 残留（unhealthy）时先 stop 再 start', async () => {
  const fake = await startFakeBridge({ healthStatus: 503 })
  const dir = tempState()
  const bridgeRoot = tempBridgeRoot()
  const spawned = []
  try {
    writeToken(dir)
    writeRuntime(dir, fake.port)
    const hub = createAmoonHub({
      env: { KHY_AMOON_HOME: dir },
      platform: 'win32',
      bridgeRoot,
      spawnImpl: fakeSpawn(spawned, () => {}),
    })
    const r = await hub.start()
    assert.equal(r.ok, false)
    assert.deepEqual(spawned.map((s) => s.args[1]), ['stop', 'start'])
  } finally {
    fake.server.close()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(bridgeRoot, { recursive: true, force: true })
  }
})

test('stop：CLI stop 后重新探测为未运行', async () => {
  const fake = await startFakeBridge()
  const dir = tempState()
  const bridgeRoot = tempBridgeRoot()
  const spawned = []
  try {
    writeToken(dir)
    writeRuntime(dir, fake.port)
    const hub = createAmoonHub({
      env: { KHY_AMOON_HOME: dir },
      platform: 'win32',
      bridgeRoot,
      spawnImpl: fakeSpawn(spawned, () => fs.rmSync(path.join(dir, 'runtime.json'), { force: true })),
    })
    const r = await hub.stop()
    assert.equal(r.ok, true)
    assert.equal(r.status.phase, 'not_running')
    assert.equal(spawned[0].args[1], 'stop')
  } finally {
    fake.server.close()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(bridgeRoot, { recursive: true, force: true })
  }
})
