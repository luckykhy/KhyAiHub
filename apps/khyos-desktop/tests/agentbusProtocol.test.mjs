// 纯逻辑契约：帧编解码、握手四键、响应匹配四分支、发送回执三分支、两套终态集、
// finished() 六分支、回复选取、用量族。全部不碰网络与子进程——协议语义在这一层
// 钉死，IO 层与假服务的测试才有东西可对照。
import { test } from 'node:test'
import assert from 'node:assert'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = (rel) => import(pathToFileURL(path.resolve(here, '../src/main/agentbus', rel)).href)

const protocol = await load('agentbusProtocol.ts')
const clientMod = await load('agentbusClient.ts')

// ── 帧 ───────────────────────────────────────────────────────────────────────

test('帧：编码后能解回来，长度头是大端四字节', () => {
  const encoded = protocol.encodeFrame({ hello: 'world' })
  assert.ok(encoded.ok)
  assert.equal(encoded.bytes.readUInt32BE(0), encoded.bytes.length - 4)
  const header = protocol.decodeFrameHeader(encoded.bytes.subarray(0, 4))
  assert.deepEqual(header, { ok: true, size: encoded.bytes.length - 4 })
})

test('帧：size=0 与超限都被拒，且不分配 body', () => {
  assert.deepEqual(protocol.decodeFrameHeader(Buffer.from([0, 0, 0, 0])), { ok: false, error: 'empty_frame' })
  const big = Buffer.alloc(4)
  big.writeUInt32BE(protocol.MAX_FRAME_BYTES + 1, 0)
  assert.deepEqual(protocol.decodeFrameHeader(big), { ok: false, error: 'frame_too_large' })
  const tooBig = protocol.encodeFrame({ blob: 'x'.repeat(protocol.MAX_FRAME_BYTES) })
  assert.deepEqual(tooBig, { ok: false, error: 'frame_too_large' })
})

test('帧：增量解码跨 chunk 边界，坏 JSON 只丢那一帧', () => {
  const decoder = new protocol.FrameDecoder()
  const a = protocol.encodeFrame({ n: 1 }).bytes
  const b = protocol.encodeFrame({ n: 2 }).bytes
  assert.deepEqual(decoder.push(a.subarray(0, 2)), [])
  assert.deepEqual(decoder.push(a.subarray(2)), [{ n: 1 }])
  assert.deepEqual(decoder.push(b), [{ n: 2 }])
  assert.equal(decoder.pendingBytes, 0)

  const brokenBody = Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from('abc')])
  const out = decoder.push(Buffer.concat([protocol.encodeFrame({ ok: true }).bytes, brokenBody]))
  assert.equal(out.length, 1)
  assert.equal(decoder.skippedFrames, 1)
})

test('帧：超限声明的长度把解码器置坏，后续字节不再解', () => {
  const decoder = new protocol.FrameDecoder()
  const bad = Buffer.alloc(4)
  bad.writeUInt32BE(protocol.MAX_FRAME_BYTES + 1, 0)
  decoder.push(bad)
  assert.equal(decoder.isBroken, true)
  assert.deepEqual(decoder.push(protocol.encodeFrame({ n: 9 }).bytes), [])
})

// ── 握手 ─────────────────────────────────────────────────────────────────────

test('握手：只有四键，字节流里没有 token/auth/scopes/device', () => {
  const params = protocol.helloParams({
    protocol: 3,
    clientId: 'khyos-agentbus-0123456789abcdef',
    clientVersion: '0.1.0',
    platform: 'linux',
  })
  assert.deepEqual(Object.keys(params).sort(), ['client', 'maxProtocol', 'minProtocol', 'role'])
  assert.deepEqual(Object.keys(params.client).sort(), ['displayName', 'id', 'platform', 'version'])
  const bytes = protocol.encodeFrame(params).bytes.toString('utf8').toLowerCase()
  for (const word of ['token', 'auth', 'scopes', 'device', 'serial']) {
    assert.ok(!bytes.includes(word), `握手字节流不许出现 ${word}`)
  }
})

test('握手：协议不符即拒绝，不静默降级', () => {
  assert.deepEqual(protocol.helloServer({ server: { version: '1.2.3', protocol: 3 } }, 3), {
    ok: true,
    server: { version: '1.2.3', protocol: 3 },
  })
  const bad = protocol.helloServer({ server: { version: '9', protocol: 2 } }, 3)
  assert.equal(bad.ok, false)
  assert.match(bad.error, /协议不受支持/)
})

// ── 请求 id ───────────────────────────────────────────────────────────────────

test('请求 id：stepx- 加 32 位小写十六进制，1000 个不重复', () => {
  const client = clientMod.createAgentbusClient({
    config: protocol.resolveAgentbusConfig({}),
    spawnImpl: () => {
      throw new Error('构造客户端不该起子进程')
    },
  })
  const re = /^stepx-[0-9a-f]{32}$/
  const seen = new Set()
  for (let i = 0; i < 1000; i += 1) {
    const id = client.newRequestId()
    assert.match(id, re)
    seen.add(id)
  }
  assert.equal(seen.size, 1000)
})

test('信封：type/id/method/params 四键', () => {
  assert.deepEqual(protocol.requestEnvelope('stepx-aa', 'chat.send', { text: 'hi' }), {
    type: 'req',
    id: 'stepx-aa',
    method: 'chat.send',
    params: { text: 'hi' },
  })
})

// ── 响应匹配四分支 ────────────────────────────────────────────────────────────

test('响应匹配：四分支各走各的路', () => {
  assert.deepEqual(protocol.matchResponse({ id: 'other' }, 'mine'), { kind: 'not_ours' })
  assert.deepEqual(protocol.matchResponse({ id: 'mine', ok: false, error: { code: 'E1', message: '坏了' } }, 'mine'), {
    kind: 'error',
    code: 'E1',
    message: '坏了',
  })
  assert.deepEqual(protocol.matchResponse({ id: 'mine', ok: true }, 'mine'), { kind: 'malformed', message: '响应缺少 payload' })
  assert.deepEqual(protocol.matchResponse({ id: 'mine', ok: true, payload: { ok: false } }, 'mine'), { kind: 'incomplete' })
  assert.deepEqual(protocol.matchResponse({ id: 'mine', ok: true, payload: { ok: true, key: 'k' } }, 'mine'), {
    kind: 'ok',
    payload: { ok: true, key: 'k' },
  })
  const noCode = protocol.matchResponse({ id: 'mine', ok: false }, 'mine')
  assert.equal(noCode.kind, 'error')
  assert.equal(noCode.code, 'UNKNOWN')
})

// ── chat.send 回执三分支 ─────────────────────────────────────────────────────

test('chat.send 回执：拒绝 / 无回执 / 收下', () => {
  assert.deepEqual(protocol.chatSendReceipt({ accepted: false }, 'local'), {
    ok: false,
    code: 'not_accepted',
    message: 'Amoo 未接受此消息，输入内容已保留',
  })
  assert.deepEqual(protocol.chatSendReceipt({ accepted: true }, 'local'), { ok: true, runId: 'local' })
  assert.deepEqual(protocol.chatSendReceipt({ runId: 'phone-run' }, 'local'), { ok: true, runId: 'phone-run' })
  assert.deepEqual(protocol.chatSendReceipt({ status: 'queued' }, 'local'), { ok: true, runId: 'local' })
  const bad = protocol.chatSendReceipt({ status: 'thinking' }, 'local')
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'no_receipt')
})

// ── 两套终态集 ────────────────────────────────────────────────────────────────

test('两套终态集逐成员钉住，且互异', () => {
  const stopOnly = ['length', 'tracking_limit', 'task_delivered', 'stop_sequence']
  const eventOnly = ['turn_done', 'final']
  const both = ['stop', 'end_turn', 'error', 'aborted', 'cancelled', 'completed', 'done', 'finished']
  for (const reason of [...stopOnly, ...both]) {
    assert.equal(protocol.isTerminalStopReason(reason), true, `${reason} 应在 history 集`)
    assert.equal(protocol.isTerminalStopReason(reason.toUpperCase()), true, `${reason} 应大小写不敏感`)
  }
  for (const state of [...eventOnly, ...both]) {
    assert.equal(protocol.isTerminalEventState({ state }), true, `${state} 应在事件集`)
  }
  for (const reason of stopOnly) {
    assert.equal(protocol.isTerminalEventState({ state: reason }), false, `${reason} 不在事件集`)
  }
  for (const state of eventOnly) {
    assert.equal(protocol.isTerminalStopReason(state), false, `${state} 不在 history 集`)
  }
  for (const neither of ['child_running', 'running', 'streaming', 'tool_use', '']) {
    assert.equal(protocol.isTerminalStopReason(neither), false)
    assert.equal(protocol.isTerminalEventState({ state: neither }), false)
  }
  assert.equal(protocol.isTerminalEventState({ done: true }), true)
  assert.equal(protocol.isTerminalEventState({ finished: true }), true)
  assert.equal(protocol.isTerminalEventState({ final: true }), true)
  assert.equal(protocol.isTerminalEventState({ done: false, state: 'nope' }), false)
})

// ── 事件解析 ──────────────────────────────────────────────────────────────────

test('事件：done/finished/final 布尔与 state 都算结束', () => {
  const base = { sessionKey: 'sess-1', role: 'assistant', text: 'hi' }
  assert.equal(protocol.parseStreamEvent({ type: 'event', event: 'chat.message', payload: { ...base, done: true } }).finished, true)
  assert.equal(protocol.parseStreamEvent({ type: 'event', event: 'chat.message', payload: { ...base, state: 'turn_done' } }).finished, true)
  assert.equal(protocol.parseStreamEvent({ type: 'event', event: 'chat.message', payload: { ...base, state: 'running' } }).finished, false)
})

test('事件：没有 sessionKey 的事件被丢弃（防跨会话串台）', () => {
  assert.equal(protocol.parseStreamEvent({ type: 'event', event: 'chat.message', payload: { role: 'assistant', done: true } }), null)
})

test('事件：node.event 形状与 event 形状都认', () => {
  const viaReq = protocol.parseStreamEvent({
    type: 'req',
    method: 'node.event',
    params: { event: 'chat.delta', payload: { sessionKey: 's', role: 'assistant', delta: '一段' } },
  })
  assert.equal(viaReq.deltaText, '一段')
  const unrelated = protocol.parseStreamEvent({ type: 'req', method: 'other.thing', params: {} })
  assert.equal(unrelated, null)
})

test('事件：role 只认 assistant/tool，其余整帧丢弃', () => {
  const frame = (role) => ({
    type: 'event',
    event: 'session.message',
    payload: { sessionKey: 'sess-1', role, text: '某段文本', metadata: { runId: 'run-1' } },
  })
  // 非空且不在 {assistant, tool} 里的 role 让整帧消失，不是只丢掉文本
  // （amoo.rs:477-480；system / user / 任何拼错的变体都算）
  for (const role of ['system', 'user', 'tool_runner', 'Assistant', 'TOOL']) {
    assert.equal(protocol.parseStreamEvent(frame(role)), null, `role=${role} 必须整帧丢弃`)
  }
  // 两个合法 role 仍然进来
  assert.equal(protocol.parseStreamEvent(frame('assistant')).finished, false)
  const tool = protocol.parseStreamEvent(frame('tool'))
  assert.equal(tool.finished, false)
  assert.equal(tool.deltaText, '')
  assert.equal(tool.fullText, '')
})

test('事件：role=tool 不标记 finished，streaming=false + TOOL_CALLS 也不算完成', () => {
  // 工具结果帧：手机把 streaming 置 false 并给了 stopReason，但这是工具输出，
  // 既不许算本轮结束，也不许把原始 JSON 漏进 assistant 的增量/全文
  // （amoo.rs:633、amoo.rs:3656-3685）
  const toolResult = protocol.parseStreamEvent({
    type: 'req',
    method: 'node.event',
    params: {
      event: 'session.message',
      payload: {
        sessionKey: 'agent:main:stepx-1',
        role: 'tool',
        text: '{"raw_tool_json": 12345}',
        delta: '{"raw_tool_json": 12345}',
        metadata: { runId: 'run-1', streaming: false, toolName: 'web_search' },
      },
    },
  })
  assert.ok(toolResult, '工具结果帧仍是一条增量：工具状态要画出来')
  assert.equal(toolResult.finished, false, 'role=tool 不得标记本轮结束')
  assert.equal(toolResult.deltaText, '', '工具输出不许漏进 assistant 增量')
  assert.equal(toolResult.fullText, '', '工具输出不许漏进 assistant 全文')
  assert.match(String(toolResult.toolStatus), /正在调用工具/)

  // 中间工具调用帧：streaming=false + stopReason=TOOL_CALLS + toolCalls，
  // 手机还在跑工具，这一轮没完（amoo.rs:3631-3654）
  const toolCall = protocol.parseStreamEvent({
    type: 'req',
    method: 'node.event',
    params: {
      event: 'session.message',
      payload: {
        sessionKey: 'agent:main:stepx-1',
        role: 'assistant',
        text: '',
        stopReason: 'TOOL_CALLS',
        toolCalls: [{ name: 'web_search' }],
        metadata: { runId: 'run-1', streaming: false },
      },
    },
  })
  assert.ok(toolCall, '中间工具调用帧也要画工具状态')
  assert.equal(toolCall.finished, false, 'TOOL_CALLS 中间步不得算完成')
  assert.equal(toolCall.fullText, '')
  assert.match(String(toolCall.toolStatus), /web_search/)
})

test('stepclaw 状态：熄屏判据只认 upstream unavailable + screen_off', () => {
  const frameObj = {
    type: 'event',
    event: 'stepclaw.status.change',
    payload: { resources: { chat: { status: 'available' }, upstream: { status: 'unavailable', reason: 'screen_off' } } },
  }
  const status = protocol.parseStepclawStatus(frameObj)
  assert.equal(status.upstreamReason, 'screen_off')
  assert.equal(protocol.stepclawScreenOff(status), true)
  assert.equal(protocol.stepclawScreenOff(null), false)
  const awake = protocol.parseStepclawStatus({
    type: 'event',
    event: 'stepclaw.status.change',
    payload: { resources: { chat: { status: 'available' }, upstream: { status: 'available', reason: '' } } },
  })
  assert.equal(protocol.stepclawScreenOff(awake), false)
})

// ── finished() 六分支 ─────────────────────────────────────────────────────────

const msg = (role, runId, stopReason, text = '') => ({ role, runId, stopReason, text, truncated: false, usage: protocol.EMPTY_USAGE })
const PENDING = { sessionKey: 'sess-1', runId: 'run-1' }
const sessionOf = (messages, key = 'sess-1') => ({ key, messages })

test('finished：会话键不符即未完成', () => {
  assert.equal(protocol.isRoundFinished(PENDING, sessionOf([msg('assistant', 'run-1', 'stop')], 'other')), false)
})

test('finished：tracking_limit 直接算完成', () => {
  assert.equal(protocol.isRoundFinished(PENDING, sessionOf([msg('assistant', 'run-1', 'tracking_limit')])), true)
})

test('finished：child_running 直接算未完成，且压过终态行', () => {
  assert.equal(protocol.isRoundFinished(PENDING, sessionOf([msg('assistant', 'run-1', 'child_running')])), false)
  assert.equal(
    protocol.isRoundFinished(PENDING, sessionOf([msg('assistant', 'run-1', 'child_running'), msg('assistant', 'run-1', 'stop')])),
    false,
  )
})

test('finished：run_id 命中的终态 assistant 行算完成', () => {
  assert.equal(protocol.isRoundFinished(PENDING, sessionOf([msg('user', 'run-1', ''), msg('assistant', 'run-1', 'end_turn')])), true)
  assert.equal(protocol.isRoundFinished(PENDING, sessionOf([msg('user', 'run-1', ''), msg('assistant', 'run-1', 'running')])), false)
})

test('finished：回退分支要求严格位于 user turn 之后 + run_id 为空 + 终态', () => {
  const rows = [msg('user', 'run-1', ''), msg('assistant', '', 'stop')]
  assert.equal(protocol.isRoundFinished(PENDING, sessionOf(rows)), true)
  assert.equal(protocol.isRoundFinished(PENDING, sessionOf([msg('assistant', '', 'stop'), msg('user', 'run-1', '')])), false)
  assert.equal(protocol.isRoundFinished(PENDING, sessionOf([msg('user', 'run-1', ''), msg('assistant', 'other-run', 'stop')])), false)
  assert.equal(protocol.isRoundFinished(PENDING, sessionOf([msg('user', 'run-1', ''), msg('assistant', '', 'running')])), false)
  assert.equal(protocol.isRoundFinished(PENDING, sessionOf([msg('user', 'run-1', ''), msg('tool', '', 'stop')])), false)
})

test('finished：其余一律未完成', () => {
  assert.equal(protocol.isRoundFinished(PENDING, sessionOf([])), false)
  assert.equal(protocol.isRoundFinished(PENDING, sessionOf([msg('user', 'run-1', '')])), false)
})

// ── 回复选取 ──────────────────────────────────────────────────────────────────

test('回复选取：优先最后一条 run_id 命中的终态 assistant', () => {
  const rows = [
    msg('user', 'run-1', ''),
    msg('assistant', 'run-1', 'stop', '第一段'),
    msg('assistant', 'run-1', 'end_turn', '最后一段'),
  ]
  assert.deepEqual(protocol.selectReplyText(PENDING, sessionOf(rows)), {
    text: '最后一段',
    truncated: false,
    stopReason: 'end_turn',
  })
})

test('回复选取：会话键不符则无文本', () => {
  assert.equal(protocol.selectReplyText(PENDING, sessionOf([msg('assistant', 'run-1', 'stop', 'x')], 'other')), null)
})

test('回复选取：没有 run_id 命中时取回退分支第一条', () => {
  const rows = [msg('user', 'run-1', ''), msg('assistant', '', 'stop', '回退一'), msg('assistant', '', 'end_turn', '回退二')]
  assert.deepEqual(protocol.selectReplyText(PENDING, sessionOf(rows)), {
    text: '回退一',
    truncated: false,
    stopReason: 'stop',
  })
})

test('回复选取：都没有则无文本', () => {
  assert.equal(protocol.selectReplyText(PENDING, sessionOf([msg('user', 'run-1', '')])), null)
  assert.equal(protocol.selectReplyText(PENDING, sessionOf([])), null)
})

// ── 历史行 ────────────────────────────────────────────────────────────────────

test('历史行：只认 user/assistant，truncated 只取行自带标志', () => {
  const rows = protocol.parseHistoryMessages([
    { role: 'assistant', runId: 'run-1', stopReason: 'stop', text: '一段话', truncated: true },
    { role: 'tool', runId: 'run-1', stopReason: 'stop', text: '工具输出' },
    { role: 'user', runId: 'run-1', content: [{ type: 'text', text: '问题' }] },
    { role: 'assistant', runId: 'run-1', stopReason: 'stop', text: '很长很长很长' },
  ])
  assert.equal(rows.length, 3)
  assert.equal(rows[0].truncated, true)
  assert.equal(rows[2].truncated, false, '不得从文本长度推断截断')
  assert.equal(rows[1].text, '问题')
})

test('历史行：page.hasMore 判部分历史', () => {
  assert.equal(protocol.historyHasMore({ page: { hasMore: true } }), true)
  assert.equal(protocol.historyHasMore({ page: { hasMore: false } }), false)
  assert.equal(protocol.historyHasMore({}), false)
})

// ── 用量族 ────────────────────────────────────────────────────────────────────

test('用量：容器优先级 usage → tokenUsage → metadata.usage', () => {
  const direct = protocol.parseMessageUsage({ usage: { input: 1, output: 2 } })
  assert.equal(direct.input_tokens, 1)
  const tokenUsage = protocol.parseMessageUsage({ tokenUsage: { input: 3, output: 4 } })
  assert.equal(tokenUsage.input_tokens, 3)
  const nested = protocol.parseMessageUsage({ metadata: { usage: '{"input":5,"output":6}' } })
  assert.equal(nested.input_tokens, 5)
  assert.equal(protocol.parseMessageUsage({}).input_tokens, null, '没有容器时不猜数')
})

test('用量：字符串计数认，0 是合法值，负数与非安全整数被拒', () => {
  const asString = protocol.parseMessageUsage({ usage: { input: '30', output: '20' } })
  assert.equal(asString.input_tokens, 30)
  const zero = protocol.parseMessageUsage({ usage: { input: 0, output: 0 } })
  assert.equal(zero.input_tokens, 0)
  assert.equal(protocol.usageHasTokens(zero), true)
  const bad = protocol.parseMessageUsage({ usage: { input: -5, output: 1.5, totalTokens: Number.MAX_SAFE_INTEGER + 2 } })
  assert.equal(bad.input_tokens, null)
  assert.equal(bad.output_tokens, null)
  assert.equal(bad.total_tokens, null)
})

test('用量：total 缺失时由输入输出相加，溢出则留空', () => {
  const summed = protocol.parseMessageUsage({ usage: { input: 10, output: 20 } })
  assert.equal(summed.total_tokens, 30)
  const overflow = protocol.parseMessageUsage({ usage: { input: Number.MAX_SAFE_INTEGER, output: Number.MAX_SAFE_INTEGER } })
  assert.equal(overflow.total_tokens, null)
  const declared = protocol.parseMessageUsage({ usage: { input: 1, output: 2, totalTokens: 99 } })
  assert.equal(declared.total_tokens, 99)
})

test('用量：context_used 退化到 input，context_limit 与 response_ms 必须为正', () => {
  const degenerate = protocol.parseMessageUsage({ usage: { input: 27014, output: 252 } })
  assert.equal(degenerate.context_used, 27014)
  assert.equal(degenerate.context_limit, null)
  const withContext = protocol.parseMessageUsage({ usage: { contextTokens: 100 }, contextWindow: 128000 })
  assert.equal(withContext.context_used, 100)
  assert.equal(withContext.context_limit, 128000)
  assert.equal(protocol.parseMessageUsage({ usage: { output: 5 }, contextWindow: 0 }).context_limit, null)
  assert.equal(protocol.parseMessageUsage({ usage: { output: 5 }, durationMs: 0 }).response_ms, null)
  const timed = protocol.parseMessageUsage({ usage: { output: 2000 }, durationMs: 4000 })
  assert.equal(timed.response_ms, 4000)
  assert.equal(timed.response_ms_source, 'server')
  assert.equal(timed.tokens_per_second, 500)
})

test('用量：cost_usd 只在币种是 USD 时取', () => {
  assert.equal(protocol.parseMessageUsage({ usage: { cost: { total: 0.25 } } }).cost_usd, null)
  assert.equal(protocol.parseMessageUsage({ usage: { cost: { currency: 'USD', total: 0.25 } } }).cost_usd, 0.25)
  assert.equal(protocol.parseMessageUsage({ cost_usd: '0.01' }).cost_usd, 0.01)
  assert.equal(protocol.parseMessageUsage({ usage: { cost: { currency: 'USD', total: -1 } } }).cost_usd, null)
})

test('用量：cache_read 回退到 prompt_tokens_details.cached_tokens', () => {
  // OpenAI 形状的嵌套计数是同一条回退链的最后一环（amoo_usage.rs:91-95）
  const nested = protocol.parseMessageUsage({ usage: { prompt_tokens_details: { cached_tokens: 4096 } } })
  assert.equal(nested.cache_read_tokens, 4096)
  // 三个扁平拼写仍然优先，回退只在它们全缺时生效
  const explicit = protocol.parseMessageUsage({ usage: { cacheRead: 7, prompt_tokens_details: { cached_tokens: 4096 } } })
  assert.equal(explicit.cache_read_tokens, 7)
  const flatAlt = protocol.parseMessageUsage({ usage: { cache_read_input_tokens: 12, prompt_tokens_details: { cached_tokens: 4096 } } })
  assert.equal(flatAlt.cache_read_tokens, 12)
  // 非对象容器与非法计数都留空，不猜数
  assert.equal(protocol.parseMessageUsage({ usage: { prompt_tokens_details: 5 } }).cache_read_tokens, null)
  assert.equal(protocol.parseMessageUsage({ usage: { prompt_tokens_details: { cached_tokens: -1 } } }).cache_read_tokens, null)
  assert.equal(protocol.parseMessageUsage({ usage: {} }).cache_read_tokens, null)
})

test('用量：桌面实测耗时只在服务端没给且 output>0 时填，且标 measured', () => {
  const withServer = protocol.withObservedResponseMs(protocol.parseMessageUsage({ usage: { output: 10 }, durationMs: 100 }), 9999)
  assert.equal(withServer.response_ms, 100)
  assert.equal(withServer.response_ms_source, 'server')
  const measured = protocol.withObservedResponseMs(protocol.parseMessageUsage({ usage: { output: 100 } }), 2000)
  assert.equal(measured.response_ms, 2000)
  assert.equal(measured.response_ms_source, 'measured')
  assert.equal(measured.tokens_per_second, 50)
  const noOutput = protocol.withObservedResponseMs(protocol.parseMessageUsage({ usage: { input: 5 } }), 2000)
  assert.equal(noOutput.response_ms, null)
  assert.equal(noOutput.response_ms_source, null)
})

test('用量：聚合只累加显式计数，上下文与速度取最后一条有数的', () => {
  const rows = [
    protocol.parseMessageUsage({ usage: { input: 10, output: 20, totalTokens: 30 } }),
    protocol.parseMessageUsage({ usage: { input: 1, output: 2, contextTokens: 500 }, durationMs: 1000 }),
  ]
  const sum = protocol.aggregateUsage(rows)
  assert.equal(sum.input_tokens, 11)
  assert.equal(sum.output_tokens, 22)
  assert.equal(sum.context_used, 500)
  assert.equal(sum.response_ms, 1000)
  assert.equal(protocol.latestUsageWithTokens(rows).output_tokens, 2)
  assert.equal(protocol.latestUsageWithTokens([protocol.EMPTY_USAGE]), null)
})

// ── 配置 ─────────────────────────────────────────────────────────────────────

test('配置：默认值只在注释记来源，env 覆盖记 env，垃圾值记 default-invalid', () => {
  const dflt = protocol.resolveAgentbusConfig({})
  assert.equal(dflt.bus.remoteSpec, 'localabstract:agentbus')
  assert.equal(dflt.bus.protocol, 3)
  assert.equal(dflt.bus.clientVersion, '0.1.0')
  assert.equal(dflt.bus.platform, 'linux')
  assert.equal(protocol.LOOPBACK_HOST, '127.0.0.1')
  assert.equal(dflt.sources.remoteSpec, 'default')

  const overridden = protocol.resolveAgentbusConfig({
    KHY_AGENTBUS_ADB_PATH: 'D:/tools/adb.exe',
    KHY_AGENTBUS_SERIAL: 'SERIAL9',
    KHY_AGENTBUS_PROTOCOL: '4',
    KHY_AGENTBUS_BUDGET_MS: '60000',
  })
  assert.equal(overridden.adb.path, 'D:/tools/adb.exe')
  assert.equal(overridden.adb.serialSource, 'agentbus')
  assert.equal(overridden.bus.protocol, 4)
  assert.equal(overridden.round.budgetMs, 60000)
  assert.equal(overridden.sources.adbPath, 'env')

  const garbage = protocol.resolveAgentbusConfig({ KHY_AGENTBUS_PROTOCOL: 'abc', KHY_AGENTBUS_BUDGET_MS: '1' })
  assert.equal(garbage.bus.protocol, 3)
  assert.equal(garbage.round.budgetMs, 420000)
  assert.equal(garbage.sources.protocol, 'default-invalid')
  assert.equal(garbage.sources.budgetMs, 'default-invalid')
})

test('配置：串号双 env，AGENTBUS 专属优先，缺省回退 PHONE_BRIDGE', () => {
  assert.equal(protocol.resolveAgentbusConfig({ KHY_PHONE_BRIDGE_SERIAL: 'PHONE1' }).adb.serialSource, 'phone')
  const both = protocol.resolveAgentbusConfig({ KHY_AGENTBUS_SERIAL: 'A', KHY_PHONE_BRIDGE_SERIAL: 'B' })
  assert.equal(both.adb.serial, 'A')
  assert.equal(both.adb.serialSource, 'agentbus')
  assert.equal(protocol.resolveAgentbusConfig({}).adb.serial, '')
  assert.equal(protocol.resolveAgentbusConfig({}).adb.serialSource, 'default')
})

test('配置：轮次 RPC 超时按方法分开，默认 45s 且绝不是 handshakeMs', () => {
  const dflt = protocol.resolveAgentbusConfig({})
  assert.equal(dflt.bus.handshakeMs, 3000, '握手仍是 3s：一个回环往返')
  assert.equal(dflt.round.chatSendMs, 45000, 'chat.send 默认走参考实现的 REQUEST_TIMEOUT')
  assert.equal(dflt.round.chatHistoryMs, 45000)
  assert.equal(dflt.round.sessionsResetMs, 45000)
  assert.notEqual(dflt.round.chatSendMs, dflt.bus.handshakeMs, '发送超时不许可诺成握手超时')
  assert.equal(dflt.sources.chatSendMs, 'default')

  const over = protocol.resolveAgentbusConfig({
    KHY_AGENTBUS_SEND_TIMEOUT_MS: '60000',
    KHY_AGENTBUS_HISTORY_TIMEOUT_MS: '70000',
    KHY_AGENTBUS_RESET_TIMEOUT_MS: '80000',
  })
  assert.equal(over.round.chatSendMs, 60000)
  assert.equal(over.round.chatHistoryMs, 70000)
  assert.equal(over.round.sessionsResetMs, 80000)
  assert.equal(over.sources.chatSendMs, 'env')
  assert.equal(over.sources.chatHistoryMs, 'env')
  assert.equal(over.sources.sessionsResetMs, 'env')

  // 垃圾值不许把车道带下去：回落默认并记 default-invalid
  const bad = protocol.resolveAgentbusConfig({ KHY_AGENTBUS_SEND_TIMEOUT_MS: 'abc', KHY_AGENTBUS_HISTORY_TIMEOUT_MS: '1' })
  assert.equal(bad.round.chatSendMs, 45000)
  assert.equal(bad.round.chatHistoryMs, 45000)
  assert.equal(bad.sources.chatSendMs, 'default-invalid')
  assert.equal(bad.sources.chatHistoryMs, 'default-invalid')
})
