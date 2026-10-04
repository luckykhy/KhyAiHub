/**
 * mcpServerProtocol.test.js — 钉死 khy 作 MCP server 的 JSON-RPC 2.0 协议纯叶子。
 *
 * 为什么这支套件必须存在：这个叶子是 server 侧协议单一真源（parse/构形/协商/
 * 转换/派发），mcpServer、mcpStdioServer、mcpHttpServer 三个传输全部复用它；
 * PROTOCOL_CONFORMANCE 矩阵还被守卫脚本实测。契约"零 IO、绝不抛"里，"绝不抛"
 * 只在正常路径成立——dispatch 对 handler 抛出是 reject 而非兜底，这一点必须钉住，
 * 否则调用方会误以为可以省 try/catch。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. dispatch 不吞 handler 异常：handler throw → 返回 rejected Promise，由引擎
 *    兜成 -32603 —— "本函数绝不抛"契约只对查表兜底，不对 handler 兜底 — 实测钉住。
 * 2. parseMessage: id:0 是合法请求（hasId 判据只看 undefined/null）；id:null 被
 *    当通知；jsonrpc 缺字段宽容放行、写错字段回 -32600。
 * 3. checkProtocolVersionHeader 缺头回落 '2024-11-05'（assumed:true），与规范
 *    "缺头假定 2025-03-26"故意不一致（源码注释自认的回落决策）— 实测钉住。
 * 4. toolResultToMcp 透传分支只认 Array.isArray(content)：{content:[42]} 这种
 *    非 MCP content 形也原样透传，元素形状不校验。
 * 5. toolDefToMcp 的 inputSchema 是 def.parameters 的对象引用（非拷贝）— 变异泄漏注册。
 * 6. replayEventIdsAfter 的切片按 Number(id) 比较：非数字 id 一律被滤掉。
 * 7. isServeEnabled 走 flagRegistry（CANON 四词），关词 '0'/'false'/'off'/'no' 全生效。
 * 8. dispatch 查表 `table[m.method]` 无 own 键守卫：method='constructor'/'toString'
 *    会命中 Object.prototype 内建函数并被当 handler 调用、把其返回值包成 result —
 *    任意 MCP 客户端可让 server "成功"返回 '[object Undefined]' 之类的原型噪声，
 *    或经 valueOf/hasOwnProperty 触发 reject — 偏差注册（实测钉住）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const P = require('./mcpServerProtocol');

test('proto: 导出面与常量单一真源', () => {
  assert.deepStrictEqual(Object.keys(P).sort(), [
    'DEFAULT_ASSUMED_VERSION', 'ERROR_CODES', 'PROTOCOL_CONFORMANCE', 'PROTOCOL_VERSION',
    'PROTOCOL_VERSION_HEADER', 'SERVER_NAME', 'SUPPORTED_PROTOCOL_VERSIONS',
    'buildError', 'buildInitializeResult', 'buildResult', 'checkProtocolVersionHeader',
    'declaredRevisions', 'dispatch', 'isRevisionFullyImplemented', 'isServeEnabled',
    'negotiateProtocolVersion', 'parseMessage', 'replayEventIdsAfter', 'resolveStreamableContentType',
    'serverInfo', 'toolDefToMcp', 'toolResultToMcp',
  ]);
  assert.equal(P.PROTOCOL_VERSION, '2024-11-05');
  assert.equal(P.SERVER_NAME, 'khy-os');
  assert.equal(P.PROTOCOL_VERSION_HEADER, 'mcp-protocol-version');
  assert.equal(P.DEFAULT_ASSUMED_VERSION, '2024-11-05');
  assert.deepStrictEqual([...P.SUPPORTED_PROTOCOL_VERSIONS], ['2024-11-05', '2025-03-26']);
  assert.ok(Object.isFrozen(P.SUPPORTED_PROTOCOL_VERSIONS));
  assert.deepStrictEqual({ ...P.ERROR_CODES }, {
    PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602, INTERNAL_ERROR: -32603,
  });
});

test('proto: isServeEnabled —— flagRegistry CANON 四词关，默认开', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(P.isServeEnabled({ KHY_MCP_SERVE: off }), false, off);
  }
  for (const on of [undefined, '', '1', 'true', 'yes']) {
    assert.equal(P.isServeEnabled({ KHY_MCP_SERVE: on }), true, JSON.stringify(on));
  }
  assert.equal(P.isServeEnabled(null), true);
  assert.equal(typeof P.isServeEnabled(), 'boolean'); // 默认读 process.env 不抛
});

test('proto: parseMessage —— 信封校验与通知判定（id:0 是请求！）', () => {
  const req = P.parseMessage('{"jsonrpc":"2.0","id":7,"method":"ping","params":{"a":1}}');
  assert.equal(req.ok, true);
  assert.equal(req.id, 7);
  assert.equal(req.isNotification, false);
  // id:0 合法请求（0 不是 undefined/null）
  const zero = P.parseMessage('{"jsonrpc":"2.0","id":0,"method":"ping"}');
  assert.equal(zero.ok, true);
  assert.equal(zero.id, 0);
  assert.equal(zero.isNotification, false);
  // id:null → 视为通知（hasId 排除 null）— 实测钉住
  const nul = P.parseMessage('{"jsonrpc":"2.0","id":null,"method":"ping"}');
  assert.equal(nul.isNotification, true);
  // 无 id 有 method → 通知
  assert.equal(P.parseMessage('{"method":"notifications/initialized"}').isNotification, true);
  // jsonrpc 缺字段宽容；写错 → -32600
  assert.equal(P.parseMessage('{"id":1,"method":"ping"}').ok, true);
  const bad = P.parseMessage('{"jsonrpc":"1.0","id":1,"method":"ping"}');
  assert.equal(bad.ok, false);
  assert.equal(bad.errorCode, P.ERROR_CODES.INVALID_REQUEST);
  const badNum = P.parseMessage('{"jsonrpc":2,"id":1,"method":"ping"}');
  assert.equal(badNum.errorCode, -32600);
  // 非 JSON → -32700；null/空白行走同一分支
  assert.equal(P.parseMessage('not json').errorCode, -32700);
  assert.equal(P.parseMessage(null).errorCode, -32700);
  assert.equal(P.parseMessage('').errorCode, -32700);
  // JSON 标量/数组 → -32600（不是 -32700）
  assert.equal(P.parseMessage('123').errorCode, -32600);
  assert.equal(P.parseMessage('[]').errorCode, -32600);
  assert.equal(P.parseMessage('null').errorCode, -32600);
  // params 非对象 → {}；无 method → isNotification false（method undefined）
  const noParams = P.parseMessage('{"id":1,"params":42}');
  assert.deepStrictEqual(noParams.params, {});
  assert.equal(noParams.isNotification, false);
});

test('proto: buildResult/buildError 构形', () => {
  assert.deepStrictEqual(P.buildResult(3, { ok: 1 }), { jsonrpc: '2.0', id: 3, result: { ok: 1 } });
  assert.equal(P.buildResult(undefined, 'x').id, null);
  assert.equal(P.buildResult(0, 'x').id, 0);
  const e = P.buildError(5, -32603, 'boom');
  assert.deepStrictEqual(e, { jsonrpc: '2.0', id: 5, error: { code: -32603, message: 'boom' } });
  assert.equal('data' in e, false);
  assert.deepStrictEqual(P.buildError(1, -1, 'm', { d: 2 }).error.data, { d: 2 });
  assert.equal(P.buildError(1, -1, null).error.message, ''); // null → 空串
});

test('proto: negotiateProtocolVersion + checkProtocolVersionHeader', () => {
  assert.equal(P.negotiateProtocolVersion('2025-03-26'), '2025-03-26');
  assert.equal(P.negotiateProtocolVersion('2025-06-18'), '2024-11-05');
  assert.equal(P.negotiateProtocolVersion(undefined), '2024-11-05');
  assert.equal(P.negotiateProtocolVersion(' 2024-11-05 '), '2024-11-05'); // trim 宽容
  const miss = P.checkProtocolVersionHeader(undefined);
  assert.deepEqual({ ...miss }, { ok: true, version: '2024-11-05', assumed: true, supported: ['2024-11-05', '2025-03-26'] });
  assert.equal(P.checkProtocolVersionHeader('2025-03-26').ok, true);
  const rej = P.checkProtocolVersionHeader('2025-06-18');
  assert.equal(rej.ok, false);
  assert.equal(rej.reason, 'unsupported protocol version: 2025-06-18');
});

test('proto: resolveStreamableContentType / replayEventIdsAfter', () => {
  assert.equal(P.resolveStreamableContentType('text/event-stream'), 'text/event-stream');
  assert.equal(P.resolveStreamableContentType('TEXT/EVENT-STREAM'), 'text/event-stream');
  assert.equal(P.resolveStreamableContentType('*/*'), 'application/json');
  assert.equal(P.resolveStreamableContentType(undefined), 'application/json');
  assert.deepStrictEqual(P.replayEventIdsAfter('2', ['1', '2', '3', 'x', '4']), ['3', '4']); // 非数字 id 被滤
  assert.deepStrictEqual(P.replayEventIdsAfter(undefined, ['1']), []);
  assert.deepStrictEqual(P.replayEventIdsAfter('', ['1']), []);
  assert.deepStrictEqual(P.replayEventIdsAfter('-1', ['1']), []);
  assert.deepStrictEqual(P.replayEventIdsAfter('1', null), []);
  assert.deepStrictEqual(P.replayEventIdsAfter('0', ['0', '1']), []); // n<=0 一律无锚点（含 0）— 实测钉住
});

test('proto: serverInfo / buildInitializeResult 只声明 tools（诚实不虚报）', () => {
  assert.deepEqual(P.serverInfo('1.2.3'), { name: 'khy-os', version: '1.2.3' });
  assert.equal(P.serverInfo(null).version, '0.0.0');
  assert.equal(P.serverInfo(42).version, '42');
  const r = P.buildInitializeResult({ version: 'v', requestedVersion: '2025-03-26' });
  assert.deepEqual(r.capabilities, { tools: {} });
  assert.equal(r.protocolVersion, '2025-03-26');
  assert.deepEqual(P.buildInitializeResult(null).serverInfo, { name: 'khy-os', version: '0.0.0' });
  assert.deepEqual(P.buildInitializeResult().capabilities, { tools: {} });
});

test('proto: toolDefToMcp —— rename parameters→inputSchema 且是引用；可选项仅在真实存在时出现', () => {
  const params = { type: 'object', properties: { a: { type: 'string' } } };
  const out = P.toolDefToMcp({ name: 't', description: 'd', parameters: params, aliases: ['x'] });
  assert.equal(out.inputSchema, params); // 引用（非拷贝）— 变异泄漏注册
  assert.equal('aliases' in out, false);
  assert.equal('title' in out, false);
  assert.equal('annotations' in out, false);
  assert.equal('outputSchema' in out, false);
  const full = P.toolDefToMcp({ name: 't', title: 'Ti', annotations: { readOnlyHint: true }, outputSchema: { type: 'object' } });
  assert.equal(full.title, 'Ti');
  assert.deepEqual(full.annotations, { readOnlyHint: true });
  assert.equal(full.description, '');
  assert.deepEqual(P.toolDefToMcp(null), { name: '', description: '', inputSchema: { type: 'object', properties: {} } });
  assert.equal(P.toolDefToMcp({ name: 't', title: '' }).title, undefined); // 空 title 不透传
});

test('proto: toolResultToMcp —— content 数组透传不校验元素形；对象结果成对回 structuredContent', () => {
  const pass = P.toolResultToMcp({ content: [{ type: 'text', text: 'hi' }], isError: true });
  assert.deepEqual(pass, { content: [{ type: 'text', text: 'hi' }], isError: true });
  // 非 MCP 形数组也照抄 — 实测钉住
  assert.deepEqual(P.toolResultToMcp({ content: [42] }).content, [42]);
  // success:false 且无 isError → 补 isError:true
  assert.equal(P.toolResultToMcp({ content: [], success: false }).isError, true);
  // khy 归一形：对象 → text+structuredContent 成对
  const obj = P.toolResultToMcp({ success: true, content: { a: 1 } });
  assert.deepEqual(obj.content, [{ type: 'text', text: '{"a":1}' }]);
  assert.deepEqual(obj.structuredContent, { a: 1 });
  assert.equal(obj.isError, false);
  // 数组结果（非透传场景不会出现——Array content 走透传；这里验证 error 字段是数组时不进 structured）
  const err = P.toolResultToMcp({ success: false, error: 'boom' });
  assert.deepEqual(err.content, [{ type: 'text', text: 'boom' }]);
  assert.equal('structuredContent' in err, false);
  // 标量
  assert.deepEqual(P.toolResultToMcp({ success: true, content: 7 }).content, [{ type: 'text', text: '7' }]);
  // 循环对象 → stringify 失败回落 String() → '[object Object]' — 实测钉住
  const circ = {}; circ.self = circ;
  assert.equal(P.toolResultToMcp({ content: circ }).content[0].text, '[object Object]');
  assert.deepEqual(P.toolResultToMcp(null), { content: [{ type: 'text', text: '' }], isError: false });
});

test('proto: dispatch —— 通知 null / 未知 -32601 / handler 抛 reject 不吞（实测钉住）', async () => {
  const handlers = {
    ping: async (params) => ({ echo: params }),
    boom: async () => { throw new Error('kapow'); },
  };
  const ok = await P.dispatch({ id: 1, method: 'ping', params: { x: 1 } }, handlers);
  assert.deepEqual(ok, { jsonrpc: '2.0', id: 1, result: { echo: { x: 1 } } });
  // 通知 → null（无回包）
  assert.equal(await P.dispatch({ id: null, method: 'notifications/initialized', isNotification: true }, handlers), null);
  // notifications/* 即便带 id 也按通知吞掉 — 实测钉住
  assert.equal(await P.dispatch({ id: 9, method: 'notifications/cancelled' }, handlers), null);
  // 未知方法 → -32601
  const nf = await P.dispatch({ id: 2, method: 'nope' }, handlers);
  assert.equal(nf.error.code, -32601);
  assert.equal(nf.error.message, 'method not found: nope');
  // 原型链方法名不再回落 METHOD_NOT_FOUND —— table[m.method] 无 hasOwnProperty 守卫：
  // 'constructor'/'toString' 命中的是 Object.prototype 内建函数并被当作 handler 调用 — 偏差注册
  const ctor = await P.dispatch({ id: 3, method: 'constructor' }, handlers);
  assert.equal('error' in ctor, false);
  assert.equal(ctor.jsonrpc, '2.0');
  const ts = await P.dispatch({ id: 3.5, method: 'toString' }, handlers);
  assert.equal(ts.result, '[object Undefined]'); // detached 调用 this=undefined 的实测产物
  await assert.rejects(P.dispatch({ id: 3.7, method: 'valueOf' }, handlers), /Cannot convert/); // reject 交给引擎 -32603
  const proto = await P.dispatch({ id: 3.6, method: '__proto__' }, handlers);
  assert.equal(proto.error.code, -32601); // __proto__ 值是对象不是函数 → 仍 METHOD_NOT_FOUND
  // handler 抛 → dispatch 本身 reject（引擎负责 -32603），"绝不抛"契约不含此路径 — 实测钉住
  await assert.rejects(P.dispatch({ id: 4, method: 'boom' }, handlers), /kapow/);
  // 脏 msg/handlers 全兜底
  assert.equal((await P.dispatch(null, null)).error.code, -32601);
  assert.equal((await P.dispatch(null, null)).error.message, 'method not found: undefined');
});

test('proto: PROTOCOL_CONFORMANCE 矩阵与修订自洽', () => {
  assert.ok(Object.isFrozen(P.PROTOCOL_CONFORMANCE));
  assert.ok(P.PROTOCOL_CONFORMANCE.length > 20); // 非空输入防呆
  assert.deepEqual(P.declaredRevisions(), [...P.SUPPORTED_PROTOCOL_VERSIONS]);
  assert.equal(P.isRevisionFullyImplemented('2024-11-05'), true);
  assert.equal(P.isRevisionFullyImplemented('2025-03-26'), true);
  assert.equal(P.isRevisionFullyImplemented('2025-06-18'), false); // 无 required 行 → false
  assert.equal(P.isRevisionFullyImplemented('bogus'), false);
  for (const row of P.PROTOCOL_CONFORMANCE) {
    assert.ok(['server', 'client', 'shared'].includes(row.role), row.id);
    if (row.required && P.SUPPORTED_PROTOCOL_VERSIONS.includes(row.revision)) {
      assert.equal(row.implemented, true, `required 特性 ${row.id} 未实现却声明修订`);
    }
  }
});
