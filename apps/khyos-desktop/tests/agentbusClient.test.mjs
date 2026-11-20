// IO 壳契约：真回环 TCP 假 agentbus + 注入的假 adb。不要求真机、不碰 PATH。
// 重点钉住 warm/cold 流规则（握手后流是冷的；只有「本连接上至少成功完成过一次
// 非 connect RPC」之后的干净 EOF 才允许一次重连重发），以及 adb 侧的探活 argv、
// forward --remove 的尽力而为语义。
import { test } from 'node:test'
import assert from 'node:assert'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = (rel) => import(pathToFileURL(path.resolve(here, '../src/main/agentbus', rel)).href)

const protocol = await load('agentbusProtocol.ts')
const clientMod = await load('agentbusClient.ts')
const roundMod = await load('agentbusRound.ts')
const hubMod = await load('index.ts')

const SERIAL = 'SERIAL1'
const DEVICES_OK = `List of devices attached\n${SERIAL}\tdevice\n`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 假 agentbus：真回环 TCP，帧用车道自己的编解码器说 ────────────────────────

function startFakeBus(handler) {
  const state = { connections: 0, requests: [] }
  const server = net.createServer((sock) => {
    state.connections += 1
    const conn = state.connections
    const decoder = new protocol.FrameDecoder()
    sock.on('data', (chunk) => {
      for (const f of decoder.push(chunk)) {
        state.requests.push({ conn, method: f.method, id: f.id, params: f.params })
        handler({ sock, conn, frame: f, state })
      }
    })
    sock.on('error', () => {})
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }))
  })
}

function reply(sock, id, payload) {
  sock.write(protocol.encodeFrame({ type: 'res', id, ok: true, payload }).bytes)
}

function emitEvent(sock, payload) {
  sock.write(protocol.encodeFrame({ type: 'event', event: 'chat.message', payload }).bytes)
}

/** server.close() 会等所有活连接；测试不许因此挂住。 */
function closeBus(bus) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    bus.server.close(finish)
    setTimeout(finish, 500).unref?.()
  })
}

/**
 * connectImpl 替身：socket 从头到尾是开的。connect / sessions.reset 的写在内存里
 * 被应答，此后每一次写都以错误收场。
 *
 * 这是「写失败」唯一可复现的形状：对端已经没了，但本地 socket 既没有 end 也没有
 * error，所以失败必然落在 sock.write 的回调里，而不是落在「连接已关」上。
 */
function writeFailingConnect() {
  const writes = []
  let sock = null
  const connectImpl = async () => {
    const s = new EventEmitter()
    s.destroyed = false
    s.write = (bytes, cb) => {
      const frames = new protocol.FrameDecoder().push(bytes)
      const frame = frames[0]
      writes.push(frame ? frame.method : '<unparsed>')
      // 只应答握手与建会话：chat.* / chat.history 一律写失败。
      const answerable = !!frame && (frame.method === 'connect' || frame.method === 'sessions.reset')
      if (answerable) {
        const payload =
          frame.method === 'connect'
            ? { server: { version: '1.0.0', protocol: 3 } }
            : { ok: true, key: frame.params ? frame.params.key : undefined }
        const res = protocol.encodeFrame({ type: 'res', id: frame.id, ok: true, payload })
        setImmediate(() => s.emit('data', res.bytes))
      }
      setImmediate(() =>
        answerable ? cb(null) : cb(new Error('EPIPE：写不进去，但本地连接仍是开的')),
      )
      return true
    }
    s.destroy = () => {
      s.destroyed = true
    }
    sock = s
    return s
  }
  return { connectImpl, writes, isOpen: () => !!sock && sock.destroyed === false }
}

// ── 假 adb：只认本车道会发的三种形态 ─────────────────────────────────────────

function fakeAdb({ port, devicesOut = DEVICES_OK, enoent = false, forwardOut } = {}) {
  const calls = []
  const state = { port }
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 4242
    child.kill = () => true
    setImmediate(() => {
      if (enoent) {
        const err = new Error('spawn adb ENOENT')
        err.code = 'ENOENT'
        child.emit('error', err)
        return
      }
      if (args[0] === 'devices') {
        child.stdout.emit('data', Buffer.from(devicesOut))
      } else if (args[0] === '-s' && args[2] === 'forward' && args[3] === 'tcp:0') {
        // forwardOut 让假 adb 吐出非数字端口：真实 adb 只在成功时打印端口，
        // 所以这条分支钉的是「解析前不信任 stdout」。
        child.stdout.emit('data', Buffer.from(forwardOut !== undefined ? forwardOut : `${state.port}\n`))
      }
      // forward --remove 的成功形态就是 stdout 为空；这里故意什么都不发。
      child.emit('close', 0)
    })
    return child
  }
  return { spawnImpl, calls, setPort: (next) => {
    state.port = next
  } }
}

function makeConfig(overrides = {}) {
  return protocol.resolveAgentbusConfig({
    KHY_AGENTBUS_SERIAL: SERIAL,
    KHY_AGENTBUS_POLL_MS: '20',
    KHY_AGENTBUS_HANDSHAKE_MS: '2000',
    KHY_AGENTBUS_ADB_TIMEOUT_MS: '3000',
    ...overrides,
  })
}

let idSeq = 0

/** Deterministic but distinct: both id uniqueness and id format must be pinnable. */
function seqHex(bytes) {
  idSeq += 1
  return String(idSeq).padStart(bytes * 2, '0')
}

function makeClient(adb, overrides = {}) {
  return clientMod.createAgentbusClient({
    config: makeConfig(overrides),
    spawnImpl: adb.spawnImpl,
    randomHex: seqHex,
  })
}

const forwardsOf = (adb) => adb.calls.filter((c) => c.args[3] === 'tcp:0')
const removesOf = (adb) => adb.calls.filter((c) => c.args[3] === '--remove')

function hooks() {
  const phases = []
  return {
    phases,
    onPhase: (phase) => phases.push(phase),
    shouldStop: () => false,
    now: () => Date.now(),
    sleep: () => Promise.resolve(),
  }
}

/** 假服务的默认剧本：握手 / reset / send / history / abort 全按协议回。 */
function happyScript() {
  let lastRunId = ''
  return ({ sock, frame }) => {
    if (frame.method === 'connect') {
      reply(sock, frame.id, { server: { version: '1.0.0', protocol: 3 } })
      return
    }
    if (frame.method === 'sessions.reset') {
      reply(sock, frame.id, { ok: true, key: frame.params.key })
      return
    }
    if (frame.method === 'chat.send') {
      lastRunId = frame.params.idempotencyKey
      reply(sock, frame.id, { ok: true, accepted: true, runId: lastRunId })
      setTimeout(() => {
        emitEvent(sock, { sessionKey: frame.params.sessionId, role: 'assistant', state: 'done', text: '手机说好的' })
      }, 10)
      return
    }
    if (frame.method === 'chat.history') {
      reply(sock, frame.id, {
        ok: true,
        messages: [
          { role: 'user', runId: lastRunId, text: '问题' },
          { role: 'assistant', runId: lastRunId, stopReason: 'stop', text: '手机说好的', usage: { input: 10, output: 20, totalTokens: 30 } },
        ],
        page: { hasMore: false },
      })
      return
    }
    if (frame.method === 'chat.abort') reply(sock, frame.id, { ok: true })
  }
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

test('整轮 happy path：四相位、回复、用量都从手机那端取回', async () => {
  const bus = await startFakeBus(happyScript())
  const adb = fakeAdb({ port: bus.port })
  const client = makeClient(adb)
  const h = hooks()
  try {
    const outcome = await roundMod.runRound(client, { jobId: 'j1', prompt: '你好', budgetMs: 5000 }, h)
    assert.equal(outcome.state, 'done')
    assert.equal(outcome.reply, '手机说好的')
    assert.equal(outcome.replyTruncated, false)
    assert.equal(outcome.usage.input_tokens, 10)
    assert.equal(outcome.usage.output_tokens, 20)
    assert.equal(outcome.usage.response_ms_source, 'measured', '服务端没给耗时应标桌面实测')
    assert.deepEqual(h.phases, ['opening', 'sending', 'waiting', 'reading'])
    assert.equal(forwardsOf(adb).length, 1)
    assert.equal(bus.state.connections, 1)
    assert.equal(bus.state.requests.filter((r) => r.method === 'chat.send').length, 1)
  } finally {
    client.close()
    await closeBus(bus)
  }
})

test('握手后空闲 EOF（首 RPC 尚未成功）：不重连、不重发、直接报错', async () => {
  const bus = await startFakeBus(({ sock, frame }) => {
    if (frame.method === 'connect') {
      reply(sock, frame.id, { server: { version: '1.0.0', protocol: 3 } })
      sock.end()
    }
  })
  const adb = fakeAdb({ port: bus.port })
  const client = makeClient(adb)
  try {
    const opened = await client.open()
    assert.equal(opened.ok, true, '握手本身应当成功')
    const reset = await client.call('sessions.reset', { key: 'k', reason: 'new' }, 2000)
    assert.equal(reset.ok, false)
    assert.equal(reset.code, 'stream_lost')
    assert.equal(bus.state.connections, 1, '握手后流是冷的：不许产生第二连接')
    assert.equal(forwardsOf(adb).length, 1)
  } finally {
    client.close()
    await closeBus(bus)
  }
})

test('sessions.reset 成功后的空闲 EOF（落在 chat.send 上）：重连一次、第二次重发握手、id 不同', async () => {
  const bus = await startFakeBus(({ sock, conn, frame }) => {
    if (frame.method === 'connect') {
      reply(sock, frame.id, { server: { version: '1.0.0', protocol: 3 } })
      return
    }
    if (frame.method === 'sessions.reset') {
      reply(sock, frame.id, { ok: true, key: frame.params.key })
      // 第一连接上 reset 一成功就半 closes：客户端随后发 chat.send 时只会读到 EOF
      if (conn === 1) sock.end()
      return
    }
    if (frame.method === 'chat.send' && conn > 1) {
      reply(sock, frame.id, { ok: true, accepted: true, runId: frame.params.idempotencyKey })
    }
  })
  const adb = fakeAdb({ port: bus.port })
  const client = makeClient(adb)
  try {
    const opened = await client.open()
    assert.equal(opened.ok, true)
    const reset = await client.call('sessions.reset', { key: 'k', reason: 'new' }, 2000)
    assert.equal(reset.ok, true, 'sessions.reset 成功后流才变暖')
    const sent = await client.call('chat.send', { sessionId: 'k', text: 'hi', attachments: [], idempotencyKey: 'r1' }, 2000)
    assert.equal(sent.ok, true, '暖流上的干净 EOF 允许一次重连重发')
    assert.equal(bus.state.connections, 2)
    assert.equal(forwardsOf(adb).length, 1, '隧道复用，不重新 forward')
    const firstOnSecondConn = bus.state.requests.find((r) => r.conn === 2)
    assert.equal(firstOnSecondConn.method, 'connect', '第二次连接必须重发握手')
    const sendIds = bus.state.requests.filter((r) => r.method === 'chat.send').map((r) => r.id)
    assert.equal(sendIds.length, 2)
    assert.notEqual(sendIds[0], sendIds[1], '重连后的请求 id 必须与首次不同')
  } finally {
    client.close()
    await closeBus(bus)
  }
})

test('半包头 EOF：不产生第二连接', async () => {
  const bus = await startFakeBus(({ sock, conn, frame }) => {
    if (frame.method === 'connect') {
      reply(sock, frame.id, { server: { version: '1.0.0', protocol: 3 } })
      return
    }
    if (frame.method === 'sessions.reset') {
      reply(sock, frame.id, { ok: true, key: frame.params.key })
      if (conn === 1) {
        sock.write(Buffer.from([0, 0]))
        sock.end()
      }
    }
  })
  const adb = fakeAdb({ port: bus.port })
  const client = makeClient(adb)
  try {
    assert.equal((await client.open()).ok, true)
    assert.equal((await client.call('sessions.reset', { key: 'k' }, 2000)).ok, true)
    const sent = await client.call('chat.send', { sessionId: 'k', text: 'hi' }, 2000)
    assert.equal(sent.ok, false)
    assert.equal(sent.code, 'stream_lost')
    assert.equal(bus.state.connections, 1, '收到过部分字节：一律不重发')
  } finally {
    client.close()
    await closeBus(bus)
  }
})

test('半包体 EOF：不产生第二连接', async () => {
  const bus = await startFakeBus(({ sock, conn, frame }) => {
    if (frame.method === 'connect') {
      reply(sock, frame.id, { server: { version: '1.0.0', protocol: 3 } })
      return
    }
    if (frame.method === 'sessions.reset') {
      reply(sock, frame.id, { ok: true, key: frame.params.key })
      if (conn === 1) {
        const header = Buffer.alloc(4)
        header.writeUInt32BE(100, 0)
        sock.write(Buffer.concat([header, Buffer.from('半个包体')]))
        sock.end()
      }
    }
  })
  const adb = fakeAdb({ port: bus.port })
  const client = makeClient(adb)
  try {
    assert.equal((await client.open()).ok, true)
    assert.equal((await client.call('sessions.reset', { key: 'k' }, 2000)).ok, true)
    const sent = await client.call('chat.send', { sessionId: 'k', text: 'hi' }, 2000)
    assert.equal(sent.ok, false)
    assert.equal(sent.code, 'stream_lost')
    assert.equal(bus.state.connections, 1, '收到过部分字节：一律不重发')
  } finally {
    client.close()
    await closeBus(bus)
  }
})

test('写失败：一律不重发（本车道比参考实现更严，登记为偏差）', async () => {
  const bus = await startFakeBus(({ sock, conn, frame }) => {
    if (frame.method === 'connect') {
      reply(sock, frame.id, { server: { version: '1.0.0', protocol: 3 } })
      return
    }
    if (frame.method === 'sessions.reset') {
      reply(sock, frame.id, { ok: true, key: frame.params.key })
      if (conn === 1) sock.destroy()
    }
  })
  const adb = fakeAdb({ port: bus.port })
  const client = makeClient(adb)
  try {
    assert.equal((await client.open()).ok, true)
    assert.equal((await client.call('sessions.reset', { key: 'k' }, 2000)).ok, true)
    // 等对端销毁传到本地，让写入必然失败（而不是读超时）
    await sleep(50)
    const sent = await client.call('chat.send', { sessionId: 'k', text: 'hi' }, 2000)
    assert.equal(sent.ok, false)
    // 对端先销毁时本地 socket 可能已经 close，此时连写的机会都没有——两种码都算
    // 「没有重发」；真正要钉住的是连接数与请求数都不翻倍。
    assert.ok(['not_open', 'write_failed'].includes(sent.code), `未预期的失败码 ${sent.code}`)
    assert.equal(bus.state.connections, 1)
    // 帧可能根本没送到对端（socket 已销毁），所以只钉「至多一次、绝不两次」。
    assert.ok(bus.state.requests.filter((r) => r.method === 'chat.send').length <= 1, '写失败后不许重发')
  } finally {
    client.close()
    await closeBus(bus)
  }
})

test('写失败而连接仍开着：报 write_failed（不是 not_open），chat.send 至多一次', async () => {
  // 参考实现在暖流上会重连并重发（amoo.rs:1355-1361）；本车道刻意不重发，
  // 因为半写出去的帧无法判定重放是否安全。这里把这条偏差钉在「连接是开的」
  // 这个前提上——上一个用例里对端先销毁，本地可能连写的机会都没有。
  const link = writeFailingConnect()
  const adb = fakeAdb({ port: 5599 })
  const client = clientMod.createAgentbusClient({
    config: makeConfig(),
    spawnImpl: adb.spawnImpl,
    connectImpl: link.connectImpl,
    randomHex: seqHex,
  })
  try {
    assert.equal((await client.open()).ok, true)
    assert.equal(link.writes.filter((m) => m === 'connect').length, 1)
    assert.equal((await client.call('sessions.reset', { key: 'k', reason: 'new' }, 2000)).ok, true)
    const sent = await client.call('chat.send', { sessionId: 'k', text: 'hi', attachments: [], idempotencyKey: 'r1' }, 2000)
    assert.equal(sent.ok, false)
    assert.equal(sent.code, 'write_failed', '连接仍开着：必须是写失败，不能滑进 not_open')
    assert.match(sent.message, /写入手机端失败/)
    assert.equal(link.writes.filter((m) => m === 'chat.send').length, 1, '写失败后一律不重发')
    assert.equal(link.writes.filter((m) => m === 'connect').length, 1, '也不许为此重连')
    assert.equal(link.isOpen(), true, '本地 socket 自始至终没被销毁：失败确实来自写')
    assert.equal(forwardsOf(adb).length, 1, '没重连就不该重新 forward')
  } finally {
    client.close()
  }
})

test('adb forward 回非数字端口：报 forward_failed，文案就是「adb 没有返回可用的转发端口」', async () => {
  // 空串、英文、小数、负数、超范围、0：没有一种能被当成端口
  for (const forwardOut of ['', 'not-a-port', '12.5', '-1', '70000', '0']) {
    const adb = fakeAdb({ port: 5599, forwardOut })
    const client = makeClient(adb)
    try {
      const opened = await client.open()
      assert.equal(opened.ok, false, `forwardOut=${JSON.stringify(forwardOut)} 必须失败`)
      assert.equal(opened.code, 'forward_failed')
      assert.equal(opened.message, 'adb 没有返回可用的转发端口')
      // 端口没拿到就不该连、不该 --remove、更不该握手
      assert.equal(removesOf(adb).length, 0)
      assert.equal(adb.calls.filter((c) => c.args.length === 1).length, 0, '没有 devices 调用')
    } finally {
      client.close()
    }
  }
  // 正对照：stdout 两侧的空白与换行要被 trim 掉，端口照旧拿到服务，
  // 防止校验被写成「永远失败」
  const link = writeFailingConnect()
  for (const forwardOut of ['5599\n', '  5599  \n']) {
    const adb = fakeAdb({ port: 5599, forwardOut })
    const good = clientMod.createAgentbusClient({
      config: makeConfig(),
      spawnImpl: adb.spawnImpl,
      connectImpl: link.connectImpl,
      randomHex: seqHex,
    })
    try {
      assert.equal((await good.open()).ok, true, `forwardOut=${JSON.stringify(forwardOut)} 必须拿到服务`)
    } finally {
      good.close()
    }
  }
  assert.equal(link.writes.filter((m) => m === 'connect').length, 2)
})

test('事件流了很久响应不来：requestMs 超时，且不重发', async () => {
  const bus = await startFakeBus(({ sock, conn, frame }) => {
    if (frame.method === 'connect') {
      reply(sock, frame.id, { server: { version: '1.0.0', protocol: 3 } })
      return
    }
    if (frame.method === 'sessions.reset') {
      reply(sock, frame.id, { ok: true, key: frame.params.key })
      if (conn === 1) {
        const timer = setInterval(() => {
          emitEvent(sock, { sessionKey: 'unrelated', role: 'assistant', text: '别处的增量' })
        }, 10)
        sock.on('close', () => clearInterval(timer))
      }
    }
  })
  const adb = fakeAdb({ port: bus.port })
  const client = makeClient(adb)
  try {
    assert.equal((await client.open()).ok, true)
    assert.equal((await client.call('sessions.reset', { key: 'k' }, 2000)).ok, true)
    const sent = await client.call('chat.send', { sessionId: 'k', text: 'hi' }, 80)
    assert.equal(sent.ok, false)
    assert.equal(sent.code, 'rpc_timeout')
    assert.equal(bus.state.connections, 1)
  } finally {
    client.close()
    await closeBus(bus)
  }
})

test('awaitTerminal 撞 EOF：stream_lost 失败且不重连', async () => {
  const bus = await startFakeBus(({ sock, conn, frame }) => {
    if (frame.method === 'connect') {
      reply(sock, frame.id, { server: { version: '1.0.0', protocol: 3 } })
      return
    }
    if (frame.method === 'sessions.reset') {
      reply(sock, frame.id, { ok: true, key: frame.params.key })
      return
    }
    if (frame.method === 'chat.send') {
      reply(sock, frame.id, { ok: true, accepted: true, runId: frame.params.idempotencyKey })
      if (conn === 1) sock.end()
    }
  })
  const adb = fakeAdb({ port: bus.port })
  const client = makeClient(adb)
  try {
    const outcome = await roundMod.runRound(client, { jobId: 'j', prompt: '你好', budgetMs: 5000 }, hooks())
    assert.equal(outcome.state, 'failed')
    assert.equal(outcome.error.code, 'stream_lost')
    assert.equal(outcome.error.message, '与手机的连接中断：这一轮的状态无法确认')
    assert.equal(bus.state.connections, 1, '事件读环不走重连')
  } finally {
    client.close()
    await closeBus(bus)
  }
})

test('chat.abort 对永不回包的服务器约 3s resolve，且不抛', async () => {
  const bus = await startFakeBus(({ sock, frame }) => {
    if (frame.method === 'connect') reply(sock, frame.id, { server: { version: '1.0.0', protocol: 3 } })
    else if (frame.method === 'sessions.reset') reply(sock, frame.id, { ok: true, key: frame.params.key })
    // chat.abort 故意不回
  })
  const adb = fakeAdb({ port: bus.port })
  const client = makeClient(adb)
  try {
    assert.equal((await client.open()).ok, true)
    assert.equal((await client.call('sessions.reset', { key: 'k' }, 2000)).ok, true)
    const startedAt = Date.now()
    await client.abort('k', 'r1')
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed >= 2500 && elapsed <= 6000, `abort 应在 ~3s 回落，实测 ${elapsed}ms`)
  } finally {
    client.close()
    await closeBus(bus)
  }
})

test('协议不符：报 protocol_unsupported，且假 adb 收到 forward --remove tcp:<port>', async () => {
  const bus = await startFakeBus(({ sock, frame }) => {
    if (frame.method === 'connect') reply(sock, frame.id, { server: { version: '9.9.9', protocol: 2 } })
  })
  const adb = fakeAdb({ port: bus.port })
  const client = makeClient(adb)
  try {
    const opened = await client.open()
    assert.equal(opened.ok, false)
    assert.equal(opened.code, 'protocol_unsupported')
    const removes = removesOf(adb)
    assert.equal(removes.length, 1)
    assert.deepEqual(removes[0].args, ['-s', SERIAL, 'forward', '--remove', `tcp:${bus.port}`])
  } finally {
    client.close()
    await closeBus(bus)
  }
})

test('缓存端口连不上：--remove 空 stdout 不被误判，重取后仍成功', async () => {
  const first = await startFakeBus(({ sock, frame }) => {
    if (frame.method === 'connect') reply(sock, frame.id, { server: { version: '1.0.0', protocol: 3 } })
  })
  const adb = fakeAdb({ port: first.port })
  const client = makeClient(adb)
  try {
    assert.equal((await client.open()).ok, true)
    assert.equal(forwardsOf(adb).length, 1)
    client.close()
    await closeBus(first)

    const second = await startFakeBus(({ sock, frame }) => {
      if (frame.method === 'connect') reply(sock, frame.id, { server: { version: '2.0.0', protocol: 3 } })
    })
    adb.setPort(second.port)
    try {
      const again = await client.open()
      assert.equal(again.ok, true, '失效端口应被 --remove 后重取，而不是报 forward_failed')
      assert.equal(removesOf(adb).length, 1, '失效的缓存端口要 --remove')
      assert.equal(forwardsOf(adb).length, 2, '然后走一次新的 forward')
      assert.equal(second.state.connections, 1)
    } finally {
      client.close()
      await closeBus(second)
    }
  } finally {
    client.close()
    await closeBus(first)
  }
})

test('超大入帧与 size=0：都让本轮以 stream_lost 失败，且不重连', async () => {
  for (const size of [protocol.MAX_FRAME_BYTES + 1, 0]) {
    const bus = await startFakeBus(({ sock, conn, frame }) => {
      if (frame.method === 'connect') {
        reply(sock, frame.id, { server: { version: '1.0.0', protocol: 3 } })
        return
      }
      if (frame.method === 'sessions.reset') {
        reply(sock, frame.id, { ok: true, key: frame.params.key })
        if (conn === 1) {
          const header = Buffer.alloc(4)
          header.writeUInt32BE(size, 0)
          sock.write(header)
          sock.end()
        }
      }
    })
    const adb = fakeAdb({ port: bus.port })
    const client = makeClient(adb)
    try {
      assert.equal((await client.open()).ok, true)
      assert.equal((await client.call('sessions.reset', { key: 'k' }, 2000)).ok, true)
      const sent = await client.call('chat.send', { sessionId: 'k', text: 'hi' }, 2000)
      assert.equal(sent.ok, false, `size=${size} 必须失败`)
      assert.equal(sent.code, 'stream_lost')
      assert.equal(bus.state.connections, 1)
    } finally {
      client.close()
      await closeBus(bus)
    }
  }
})

test('adb ENOENT：status 回 adb_not_found，hint 是 env 赋值', async () => {
  const adb = fakeAdb({ port: 1, enoent: true })
  const client = makeClient(adb)
  const status = await client.status()
  assert.equal(status.ok, false)
  assert.equal(status.code, 'adb_not_found')
  assert.match(status.hint, /^KHY_AGENTBUS_ADB_PATH=/)
  assert.equal(adb.calls.length, 1)
})

test('串号缺失：零 spawn，status 回 serial_missing', async () => {
  const adb = fakeAdb({ port: 1 })
  const client = clientMod.createAgentbusClient({
    config: makeConfig({ KHY_AGENTBUS_SERIAL: '' }),
    spawnImpl: adb.spawnImpl,
  })
  const status = await client.status()
  assert.equal(status.ok, false)
  assert.equal(status.code, 'serial_missing')
  assert.match(status.hint, /^KHY_AGENTBUS_SERIAL=/)
  assert.equal(adb.calls.length, 0, '串号缺失时一个子进程都不该起')
})

test('探活 argv 恰为 [devices]，串号不在表内时 hint 就是 adb devices', async () => {
  const bus = await startFakeBus(({ sock, frame }) => {
    if (frame.method === 'connect') reply(sock, frame.id, { server: { version: '1.0.0', protocol: 3 } })
  })
  const adb = fakeAdb({ port: bus.port })
  const client = makeClient(adb)
  try {
    const status = await client.status()
    assert.equal(status.ok, true)
    const probes = adb.calls.filter((c) => c.args.length === 1)
    assert.equal(probes.length, 1)
    assert.deepEqual(probes[0].args, ['devices'])
    for (const call of adb.calls) {
      assert.ok(!call.args.includes('pair'), 'argv 永不许出现 pair')
    }
  } finally {
    client.close()
    await closeBus(bus)
  }

  const absent = fakeAdb({ port: bus.port, devicesOut: 'List of devices attached\nOTHER\tdevice\n' })
  const client2 = makeClient(absent)
  const status2 = await client2.status()
  assert.equal(status2.code, 'serial_not_connected')
  assert.equal(status2.hint, 'adb devices')
  assert.equal(absent.calls.filter((c) => c.args[0] === 'devices').length, 1)
  client2.close()
})

test('端口缓存：第二轮 open 复用隧道，不再 forward', async () => {
  const bus = await startFakeBus(({ sock, frame }) => {
    if (frame.method === 'connect') reply(sock, frame.id, { server: { version: '1.0.0', protocol: 3 } })
  })
  const adb = fakeAdb({ port: bus.port })
  const client = makeClient(adb)
  try {
    assert.equal((await client.open()).ok, true)
    client.close()
    assert.equal((await client.open()).ok, true)
    assert.equal(forwardsOf(adb).length, 1)
    assert.equal(bus.state.connections, 2)
  } finally {
    client.close()
    await closeBus(bus)
  }
})

// ── 车道状态机（原 agentbusHub.test.mjs，合并以压住 change-safety 的文件数上限）──
// fakeAdb / hooks / sleep 复用上面 IO 壳那几个同形状的假件，不重复声明。


const RUN_ID = 'stepx-' + 'c'.repeat(32)
// 轮次执行器用 client.newRequestId() 派生会话键，假 client 的 id 是固定的，
// 所以会话键可预测：事件里的 sessionKey 必须与它一致才算「这一轮的」。
const SESSION_KEY = 'agent:main:desktop-' + 'b'.repeat(32)

const finishedEvent = {
  kind: 'delta',
  delta: { sessionKey: SESSION_KEY, runId: RUN_ID, finished: true, deltaText: '', fullText: '', toolStatus: null },
}

const OK_STATUS = {
  ok: true,
  code: 'ok',
  message: '已连上手机端 Amoo 后台服务（1.0.0）',
  hint: '',
  serial: 'S1',
  serialSource: 'agentbus',
  serverVersion: '1.0.0',
  protocol: 3,
}

const DEFAULT_HISTORY = {
  ok: true,
  messages: [
    { role: 'user', runId: RUN_ID, text: '问题' },
    { role: 'assistant', runId: RUN_ID, stopReason: 'stop', text: '手机说好的', usage: { input: 11, output: 22, totalTokens: 33 } },
  ],
  page: { hasMore: false },
}

/** 假 client：剧本化回应，并把每次调用记进 log。 */
function fakeClient(opts = {}) {
  const log = []
  const config = protocol.resolveAgentbusConfig({
    KHY_AGENTBUS_SERIAL: 'S1',
    KHY_AGENTBUS_POLL_MS: '20',
    ...(opts.env || {}),
  })
  const events = opts.events ? [...opts.events] : []
  return {
    config,
    log,
    newRequestId: () => `stepx-${'b'.repeat(32)}`,
    status: async () => opts.status || OK_STATUS,
    open: async () => {
      log.push(['open'])
      return opts.openError ? { ok: false, code: opts.openError, message: '打不开' } : { ok: true, serverVersion: '1.0.0' }
    },
    // 第三个参数（timeoutMs）一并记下来：轮次级超时是「按方法配置」的，
    // 不记就看不见 chat.send 到底吃了哪个预算。
    call: async (method, params, timeoutMs) => {
      log.push(['call', method, timeoutMs])
      if (method === 'sessions.reset') return { ok: true, payload: { ok: true, key: params.key } }
      if (method === 'chat.send') return { ok: true, payload: { ok: true, accepted: true, runId: RUN_ID } }
      if (method === 'chat.history') return { ok: true, payload: opts.history || DEFAULT_HISTORY }
      if (method === 'chat.abort') return { ok: true, payload: { ok: true } }
      return { ok: false, code: 'unexpected_method', message: method }
    },
    nextEvent: async () => {
      log.push(['nextEvent'])
      return events.shift() || opts.idleEvent || { kind: 'timeout' }
    },
    abort: async () => {
      log.push(['abort'])
    },
    close: () => {
      log.push(['close'])
    },
    lastStepclawStatus: () => null,
  }
}


/** Wait for the lane to reach a terminal state; the ticker must stop itself or the
 *  process never drains (the tick chain is what advances the fake clock). */
function settle(hub, startTick) {
  let stopTick = () => {}
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stopTick()
      reject(new Error('lane never reached a terminal state'))
    }, 10000)
    hub.onEvent((event) => {
      if (event.type !== 'state') return
      clearTimeout(timer)
      stopTick()
      resolve(event)
    })
    if (startTick) stopTick = startTick() || stopTick
  })
  return promise
}


test('status 四态：hint 只含 adb devices 或 env 赋值', async () => {
  const cases = [
    { env: {}, code: 'serial_missing', hint: /^KHY_AGENTBUS_SERIAL=/ },
    { env: { KHY_AGENTBUS_SERIAL: 'S1', KHY_AGENTBUS_ADB_PATH: 'nope-adb' }, enoent: true, code: 'adb_not_found', hint: /^KHY_AGENTBUS_ADB_PATH=/ },
    {
      env: { KHY_AGENTBUS_SERIAL: 'S1' },
      devicesOut: 'List of devices attached\nOTHER\tdevice\n',
      code: 'serial_not_connected',
      hint: 'adb devices',
    },
    {
      env: { KHY_AGENTBUS_SERIAL: 'S1' },
      devicesOut: 'List of devices attached\nS1\tunauthorized\n',
      code: 'serial_not_connected',
      hint: 'adb devices',
    },
  ]
  for (const item of cases) {
    const adb = fakeAdb({ devicesOut: item.devicesOut, enoent: item.enoent })
    const hub = hubMod.createAgentbusHub({ env: item.env, clientDeps: { spawnImpl: adb.spawnImpl } })
    const status = await hub.status()
    assert.equal(status.code, item.code, `env=${JSON.stringify(item.env)}`)
    if (typeof item.hint === 'string') assert.equal(status.hint, item.hint)
    else assert.match(status.hint, item.hint)
    assert.ok(
      status.hint === '' || /^adb devices$/.test(status.hint) || /^KHY_AGENTBUS_[A-Z_]+=/.test(status.hint),
      `hint 只能是探活命令或 env 赋值：${status.hint}`,
    )
  }

  // ok 态用假 client：真探活的四态归 agentbusClient.test.mjs，这里只验 hub 原样回传。
  const okHub = hubMod.createAgentbusHub({
    client: fakeClient({ status: { ok: true, code: 'ok', message: '已连上', hint: '', serial: 'S1', serialSource: 'agentbus', serverVersion: '1.0.0', protocol: 3 } }),
  })
  const ok = await okHub.status()
  assert.equal(ok.ok, true)
  assert.equal(ok.code, 'ok')
  assert.equal(ok.hint, '')
})

test('ask 校验：空 prompt / 超长 / 运行中二次 ask 都被拒', async () => {
  const client = fakeClient({ events: [finishedEvent] })
  const hub = hubMod.createAgentbusHub({ client })
  const empty = hub.ask({ prompt: '   ' })
  assert.equal(empty.ok, false)
  assert.equal(empty.error.code, 'empty_prompt')
  const long = hub.ask({ prompt: 'x'.repeat(20001) })
  assert.equal(long.ok, false)
  assert.equal(long.error.code, 'prompt_too_long')
  const first = hub.ask({ prompt: '你好' })
  assert.equal(first.ok, true)
  assert.equal(first.unverified, true)
  const second = hub.ask({ prompt: '再来' })
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'already_running')
  await settle(hub)
})

test('整轮 happy path：相位、回复、用量、会话恰好关闭一次', async () => {
  const client = fakeClient({ events: [finishedEvent] })
  const hub = hubMod.createAgentbusHub({ client })
  const phases = []
  hub.onEvent((event) => {
    if (event.type === 'phase') phases.push(event.phase)
  })
  const asked = hub.ask({ prompt: '你好' })
  assert.equal(asked.ok, true)
  const done = await settle(hub)
  assert.equal(done.state, 'done')
  const result = hub.result()
  assert.equal(result.state, 'done')
  assert.equal(result.reply, '手机说好的')
  assert.equal(result.replyTruncated, false)
  assert.equal(result.usage.input_tokens, 11)
  assert.equal(result.usage.output_tokens, 22)
  assert.equal(result.usage.response_ms_source, 'measured')
  assert.equal(result.unverified, true)
  assert.deepEqual(phases, ['opening', 'sending', 'waiting', 'reading'])
  assert.equal(client.log.filter(([kind]) => kind === 'open').length, 1)
  assert.equal(client.log.filter(([kind]) => kind === 'close').length, 1, '会话恰好关闭一次')
  assert.equal(client.log.filter(([, method]) => method === 'sessions.reset').length, 1)
  assert.equal(client.log.filter(([, method]) => method === 'chat.history').length, 1)
})

test('预算用尽：budget_exhausted 且 abort 尽力而为', async () => {
  let clock = 0
  const client = fakeClient({ idleEvent: { kind: 'timeout' } })
  const hub = hubMod.createAgentbusHub({ client, now: () => clock, env: { KHY_AGENTBUS_BUDGET_MS: '30000' } })
  hub.ask({ prompt: '你好' })
  const done = await settle(hub, () => {
    let stopped = false
    const tick = () => {
      if (stopped) return
      clock += 10000
      setTimeout(tick, 5)
    }
    tick()
    return () => {
      stopped = true
    }
  })
  assert.equal(done.state, 'budget_exhausted')
  assert.ok(client.log.some(([kind]) => kind === 'abort'), '预算用尽要尽力 abort')
  assert.equal(hub.result().budgetMs, 30000)
})

test('stop 单一诚实档：文案就是那一句，且尽力 abort', async () => {
  const client = fakeClient({ idleEvent: { kind: 'timeout' } })
  const hub = hubMod.createAgentbusHub({ client, env: { KHY_AGENTBUS_BUDGET_MS: '600000' } })
  hub.ask({ prompt: '你好' })
  const stopped = hub.stop()
  assert.deepEqual(stopped, {
    ok: true,
    message: '已停止桌面等待；手机可能仍在执行，请在手机上核对，勿直接重复提交',
    unverified: true,
  })
  const done = await settle(hub)
  assert.equal(done.state, 'stopped')
  assert.ok(client.log.some(([kind]) => kind === 'abort'), '停止也要尽力 abort')
})

test('熄屏事件进 note，不当失败', async () => {
  const screenOff = {
    kind: 'status',
    status: { chatStatus: 'available', chatReason: '', upstreamStatus: 'unavailable', upstreamReason: 'screen_off' },
  }
  const client = fakeClient({ events: [screenOff, finishedEvent] })
  const hub = hubMod.createAgentbusHub({ client })
  hub.ask({ prompt: '你好' })
  const done = await settle(hub)
  assert.equal(done.state, 'done')
  assert.match(String(hub.result().note), /熄屏/)
})

test('无任务时 result=idle；open 失败即 failed 且不开会话', async () => {
  const idle = hubMod.createAgentbusHub({ client: fakeClient() })
  const empty = idle.result()
  assert.equal(empty.state, 'idle')
  assert.equal(empty.elapsedMs, 0)
  assert.equal(empty.unverified, true)

  const failing = fakeClient({ openError: 'connect_failed' })
  const hub = hubMod.createAgentbusHub({ client: failing })
  hub.ask({ prompt: '你好' })
  const done = await settle(hub)
  assert.equal(done.state, 'failed')
  assert.equal(done.round.error.code, 'connect_failed')
  assert.equal(failing.log.some(([, method]) => method === 'sessions.reset'), false, '打不开就不该建会话')
  assert.equal(failing.log.some(([kind]) => kind === 'close'), true)
})

test('跨会话事件不画进本轮：别处的 finished 只被跳过', async () => {
  const foreign = {
    kind: 'delta',
    delta: {
      sessionKey: 'agent:main:desktop-SOMEONE-ELSE',
      runId: RUN_ID,
      finished: true,
      deltaText: '别处的增量',
      fullText: '别处的全文',
      toolStatus: null,
    },
  }
  const own = {
    kind: 'delta',
    delta: { sessionKey: SESSION_KEY, runId: RUN_ID, finished: true, deltaText: '', fullText: '', toolStatus: null },
  }

  // 别处那场先说「我完了」。若 sessionKey 过滤被删掉，本轮会在这里收工，
  // 于是拿到的不是 stream_lost 而是一场假的 done。
  const client = fakeClient({ events: [foreign], idleEvent: { kind: 'eof' } })
  const outcome = await roundMod.runRound(client, { jobId: 'j', prompt: '你好', budgetMs: 5000 }, hooks())
  assert.equal(outcome.state, 'failed', '别处的 finished 不许把本轮判成完成')
  assert.equal(outcome.error.code, 'stream_lost')
  assert.equal(outcome.reply, null, '跨会话的文本不许变成本轮回复')
  assert.ok(
    client.log.filter(([kind]) => kind === 'nextEvent').length >= 2,
    '跳过后必须继续读事件，而不是当成本轮结束',
  )

  // 正对照：同一会话的 finished 照样收工，过滤不是「全丢」
  const good = fakeClient({ events: [foreign, own] })
  const ok = await roundMod.runRound(good, { jobId: 'j', prompt: '你好', budgetMs: 5000 }, hooks())
  assert.equal(ok.state, 'done')
  assert.equal(ok.reply, '手机说好的')
})

test('轮次超时按方法配置：chat.send 不用 handshakeMs，三个 env 各自生效', async () => {
  const client = fakeClient({
    events: [finishedEvent],
    env: {
      KHY_AGENTBUS_SEND_TIMEOUT_MS: '12345',
      KHY_AGENTBUS_HISTORY_TIMEOUT_MS: '23456',
      KHY_AGENTBUS_RESET_TIMEOUT_MS: '34567',
    },
  })
  const outcome = await roundMod.runRound(client, { jobId: 'j', prompt: '你好', budgetMs: 5000 }, hooks())
  assert.equal(outcome.state, 'done')
  const timeoutOf = (method) => {
    const entry = client.log.find(([kind, m]) => kind === 'call' && m === method)
    assert.ok(entry, `应有 ${method} 调用`)
    return entry[2]
  }
  assert.equal(timeoutOf('sessions.reset'), 34567)
  assert.equal(timeoutOf('chat.send'), 12345)
  assert.equal(timeoutOf('chat.history'), 23456)
  assert.notEqual(timeoutOf('chat.send'), client.config.bus.handshakeMs, 'chat.send 不许再吃握手超时')
  assert.notEqual(timeoutOf('chat.history'), client.config.bus.handshakeMs, 'chat.history 也是')
})

test('轮次超时默认值：不配 env 时 chat.send 拿 45s，握手仍是 3s', async () => {
  const client = fakeClient({ events: [finishedEvent] })
  const outcome = await roundMod.runRound(client, { jobId: 'j', prompt: '你好', budgetMs: 5000 }, hooks())
  assert.equal(outcome.state, 'done')
  const send = client.log.find(([kind, m]) => kind === 'call' && m === 'chat.send')
  const history = client.log.find(([kind, m]) => kind === 'call' && m === 'chat.history')
  assert.equal(send[2], 45000, '默认走参考实现的 REQUEST_TIMEOUT')
  assert.equal(history[2], 45000)
  assert.equal(client.config.bus.handshakeMs, 3000, '握手预算不变，仍是一个回环往返')
})

// ── preload 片段行为契约（原 agentbusPreload.test.mjs）───────────────────────

const preloadLoad = (rel) => import(pathToFileURL(path.resolve(here, '../src/preload', rel)).href)
const preloadAgentbus = await preloadLoad('agentbus.ts')
const preloadSecretary = await preloadLoad('amooSecretary.ts')

function fakeIpc() {
  const invokes = []
  const subscriptions = []
  const sends = []
  return {
    invokes,
    subscriptions,
    sends,
    invoke: async (channel, ...args) => {
      invokes.push({ channel, args })
      return { ok: true }
    },
    on: (channel) => {
      subscriptions.push(channel)
    },
    removeListener: () => {},
    send: (channel) => {
      sends.push(channel)
    },
  }
}

test('「电脑端 AI」片段：四条 invoke 的通道名与 main 侧注册一一配对', async () => {
  const ipc = fakeIpc()
  const api = preloadAgentbus.createAgentbusApi(ipc)
  await api.agentbusStatus()
  await api.agentbusAsk({ prompt: '你好', budgetMs: 1000 })
  await api.agentbusResult()
  await api.agentbusStop()
  assert.deepEqual(
    ipc.invokes.map((c) => c.channel),
    ['agentbus:status', 'agentbus:ask', 'agentbus:result', 'agentbus:stop'],
  )
  assert.deepEqual(ipc.invokes[1].args[0], { prompt: '你好', budgetMs: 1000 })
  const off = api.onAgentbusEvent(() => {})
  assert.deepEqual(ipc.subscriptions, ['agentbus:event'])
  off()
})

test('「电脑端 AI」片段：stop 在 ok:false 时抛错，不让面板读成中止成功', async () => {
  const ipc = fakeIpc()
  ipc.invoke = async () => ({ ok: false, message: '桥没接' })
  const api = preloadAgentbus.createAgentbusApi(ipc)
  await assert.rejects(() => api.agentbusStop(), /桥没接/)
  const okIpc = fakeIpc()
  okIpc.invoke = async () => ({ ok: true, message: '已停止桌面等待' })
  const okApi = preloadAgentbus.createAgentbusApi(okIpc)
  assert.deepEqual(await okApi.agentbusStop(), { ok: true, message: '已停止桌面等待' })
})

test('Amoo 秘书片段：七条 invoke + 一条事件订阅，通道名不变', async () => {
  const ipc = fakeIpc()
  const api = preloadSecretary.createAmooSecretaryApi(ipc)
  await api.amooSecretaryStatus()
  await api.amooSecretaryAsk({ prompt: '在吗' })
  await api.amooSecretaryResult()
  await api.amooSecretaryLoopStatus()
  await api.amooSecretaryMemory({ op: 'get', id: 'e1' })
  await api.amooSecretaryStopPolling()
  const off = api.onAmooSecretaryEvent(() => {})
  assert.deepEqual(
    ipc.invokes.map((c) => c.channel),
    [
      'amooSecretary:status',
      'amooSecretary:ask',
      'amooSecretary:result',
      'amooSecretary:loopStatus',
      'amooSecretary:memory',
      'amooSecretary:stopPolling',
    ],
  )
  assert.deepEqual(ipc.subscriptions, ['amooSecretary:event'])
  // 退订不只是移除监听：还要告知主进程停轮询，否则没人看的进度会继续每 5s 拉手机。
  off()
  assert.deepEqual(ipc.sends, ['amooSecretary:release'])
})

// 编辑器工作台那段（src/preload/editor.ts）是编辑器车道（DESIGN-ARCH-210）的模块，
// 不属于本车道改动集，所以这里不钉它——它自己的契约该由它自己的测试钉。
// 本车道只为把它从 preload/index.ts 的 api 对象里搬出去（否则那个对象超过
// maxFuncLines 上限），搬运行为不变与否由他们那条车道负责。
