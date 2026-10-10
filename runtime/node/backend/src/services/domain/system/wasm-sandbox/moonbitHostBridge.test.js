'use strict';

// Co-located contract tests for moonbitHostBridge.js (C-4, [RESEARCH-018] §2.3).
// The bridge is the capability-gated JSON IPC facade a Moonbit guest calls through.
// Everything here is driven by fake in-memory transports: no socket, no wasm module, no
// child process. The surface worth pinning is (a) the capability map's fail-open tail and
// (b) which failures the bridge translates into its three Ipc*/Capability* error classes
// and which it lets escape raw.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('./moonbitHostBridge');
const { encodeFrame, decodeFrame } = require('./ipcCodec');
const { CAP, IPC, METHOD, SERVICE, capMask } = require('./m1Constants');

const {
  createMoonbitHostBridge,
  requiredCapabilityForCall,
  CapabilityError,
  IpcTransportError,
  IpcProtocolError,
} = mod;

const ALL = capMask(CAP.IPC, CAP.NET, CAP.FS_READ, CAP.FS_WRITE, CAP.WINDOW);

// In-memory transport that echoes a well-formed RESPONSE frame; records every call.
function echoTransport(responseOverrides = {}) {
  const calls = [];
  return {
    calls,
    lastRequest() {
      return decodeFrame(calls[calls.length - 1].frame);
    },
    lastMeta() {
      return calls[calls.length - 1].meta;
    },
    callSync(frame, meta) {
      calls.push({ frame, meta });
      return buildResponse(frame, responseOverrides);
    },
  };
}

function buildResponse(requestFrame, overrides = {}) {
  const req = decodeFrame(requestFrame);
  const header = {
    msgType: IPC.MSG_TYPE.RESPONSE,
    requestId: req.header.requestId,
    serviceId: req.header.serviceId,
    methodId: req.header.methodId,
    status: 0,
    ...overrides,
  };
  const payload = overrides.payload === undefined ? '{}' : overrides.payload;
  return encodeFrame({ header, payload });
}

describe('requiredCapabilityForCall：服务号到能力位的映射', () => {
  test('已登记服务的映射逐条对得上', () => {
    assert.equal(requiredCapabilityForCall(SERVICE.FS, METHOD.FS.READ_FILE), CAP.FS_READ);
    assert.equal(requiredCapabilityForCall(SERVICE.FS, METHOD.FS.STAT), CAP.FS_READ);
    assert.equal(requiredCapabilityForCall(SERVICE.NET, METHOD.NET.HTTP_GET), CAP.NET);
    assert.equal(requiredCapabilityForCall(SERVICE.NET, METHOD.NET.DNS_RESOLVE), CAP.NET);
    assert.equal(requiredCapabilityForCall(SERVICE.WM, METHOD.WM.PRESENT_TEXT), CAP.WINDOW);
    assert.equal(requiredCapabilityForCall(SERVICE.WM, METHOD.WM.BLIT_RGBA), CAP.WINDOW);
  });

  test('FS 的未登记方法落到更重的 FS_WRITE，读权限不够写调用', () => {
    // moonbitHostBridge.js:39-42: only READ_FILE/STAT map to FS_READ, everything else in the
    // FS service falls through to FS_WRITE, so an unlisted method is treated as a write.
    for (const methodId of [0, 3, 7, 0xffff]) {
      assert.equal(requiredCapabilityForCall(SERVICE.FS, methodId), CAP.FS_WRITE);
    }
    const readOnly = createMoonbitHostBridge({ transport: echoTransport(), capabilityMask: CAP.IPC | CAP.FS_READ });
    assert.equal(readOnly.callJsonSync(SERVICE.FS, METHOD.FS.READ_FILE, {}).ok, true);
    assert.throws(() => readOnly.callJsonSync(SERVICE.FS, 7, {}), CapabilityError);
  });

  test('KNOWN-DEFECT: NET/WM 的任意 methodId 一律放行，未登记方法不需要更细的能力', () => {
    // moonbitHostBridge.js:34-37,45-47: the whole NET service is gated by a single CAP.NET bit
    // and the whole WM service by CAP.WINDOW, independent of methodId. A guest holding CAP.NET
    // can therefore invoke method 999 on NET, which no service table defines, and the bridge
    // reports the call as capability-legal.
    const netOnly = createMoonbitHostBridge({ transport: echoTransport(), capabilityMask: CAP.IPC | CAP.NET });
    assert.equal(requiredCapabilityForCall(SERVICE.NET, 999), CAP.NET);
    assert.equal(requiredCapabilityForCall(SERVICE.NET, 0), CAP.NET);
    assert.equal(netOnly.callJsonSync(SERVICE.NET, 999, {}).ok, true, '未定义方法照样走完整个调用链');
    assert.equal(netOnly.callJsonSync(SERVICE.NET, 999, {}).status, 0);
  });

  test('KNOWN-DEFECT: 未登记的服务号只要求 CAP.IPC——未知服务比已知服务更好走（fail-open）', () => {
    // moonbitHostBridge.js:49 `return CAP.IPC;` is the tail for every serviceId outside
    // SERVICE.FS/NET/WM, so service 99 (undefined) needs strictly less privilege than service
    // 1 (FS). The comparison is `===` against numbers, so a string or a prototype-key serviceId
    // also lands on the CAP.IPC tail instead of being rejected as "no such service".
    const ipcOnly = createMoonbitHostBridge({ transport: echoTransport(), capabilityMask: CAP.IPC });
    for (const serviceId of [99, 0, 4, 0xffff, -1, 2.5, '2', 'constructor', null, undefined]) {
      assert.equal(requiredCapabilityForCall(serviceId, 1), CAP.IPC, `service ${String(serviceId)} 只要 CAP_IPC`);
    }
    assert.equal(ipcOnly.callJsonSync(99, 1, {}).ok, true, '一个只被授予 CAP_IPC 的访客可以调用任何未知服务');
    assert.throws(() => ipcOnly.callJsonSync(SERVICE.NET, 1, {}), CapabilityError, '而已登记服务是拦得住的');
  });
});

describe('createMoonbitHostBridge：构造与能力面', () => {
  test('transport 必须带 call 或 callSync 之一，其余形状一律 TypeError', () => {
    for (const transport of [undefined, null, {}, { call: 'x' }, { callSync: 0 }, { other() {} }, [], 'str']) {
      assert.throws(() => createMoonbitHostBridge({ transport }), TypeError, /transport\.call\(frame, meta\) or transport\.callSync\(frame, meta\) is required/);
    }
    assert.throws(() => createMoonbitHostBridge(), TypeError, '整个参数缺省也被拒');
    assert.equal(typeof createMoonbitHostBridge({ transport: { call: () => {} } }), 'object');
    assert.equal(typeof createMoonbitHostBridge({ transport: { callSync: () => {} } }), 'object');
  });

  test('桥面对象恰为 5 个方法，能力掩码只经闭包暴露', () => {
    const bridge = createMoonbitHostBridge({ transport: echoTransport(), capabilityMask: ALL });
    assert.deepEqual(Object.keys(bridge), ['getCapabilityMask', 'setCapabilityMask', 'hasCapability', 'callJson', 'callJsonSync']);
    assert.equal(bridge.capabilityMask, undefined, '不把内部状态以裸字段漏出去');
  });

  test('capabilityMask 缺省为空掩码，number 收口为 bigint，非法类型拒绝', () => {
    const t = echoTransport();
    assert.equal(createMoonbitHostBridge({ transport: t }).getCapabilityMask(), 0n);
    assert.equal(createMoonbitHostBridge({ transport: t, capabilityMask: 0 }).getCapabilityMask(), 0n);
    assert.equal(createMoonbitHostBridge({ transport: t, capabilityMask: 3 }).getCapabilityMask(), 3n);
    assert.equal(createMoonbitHostBridge({ transport: t, capabilityMask: 7n }).getCapabilityMask(), 7n);
    for (const bad of ['7', 1.5, null, undefined2Null(), NaN, {}, []]) {
      assert.throws(() => createMoonbitHostBridge({ transport: t, capabilityMask: bad }), TypeError, /capabilityMask must be a safe integer or bigint/);
    }
  });

  // helper: `undefined` must stay a real undefined for the default-parameter path
  function undefined2Null() {
    return null;
  }

  test('setCapabilityMask 生效即时，赋值失败不留下半写状态', () => {
    const bridge = createMoonbitHostBridge({ transport: echoTransport(), capabilityMask: CAP.IPC | CAP.NET });
    assert.equal(bridge.hasCapability(CAP.FS_READ), false);
    assert.throws(() => bridge.setCapabilityMask('7'), TypeError);
    assert.equal(bridge.getCapabilityMask(), CAP.IPC | CAP.NET, '抛错后掩码仍是原值');
    assert.equal(bridge.hasCapability(CAP.NET), true);
    bridge.setCapabilityMask(ALL);
    assert.equal(bridge.hasCapability(CAP.WINDOW), true);
    bridge.setCapabilityMask(0n);
    assert.equal(bridge.hasCapability(CAP.NET), false);
  });

  test('KNOWN-DEFECT: 负数掩码让每一个能力位判定通过（fail-open）', () => {
    // moonbitHostBridge.js:113,121 only run the value through toBigInt, which accepts any
    // bigint without a range check, and hasCapability (m1Constants.js:109) bitwise-ANDs the
    // two's-complement -1n, which contains every bit. So a guest whose mask is written as -1n
    // (e.g. a signed cast from an FFI boundary) is granted all seven capabilities.
    const bridge = createMoonbitHostBridge({ transport: echoTransport(), capabilityMask: -1n });
    for (const bit of Object.values(CAP)) {
      assert.equal(bridge.hasCapability(bit), true, `能力位 ${bit} 被放行`);
    }
    assert.equal(bridge.hasCapability(0n), true, '未登记的 0 位同样放行');
    assert.equal(bridge.callJsonSync(SERVICE.FS, 7, {}).ok, true);
    assert.equal(bridge.callJsonSync(99, 1, {}).ok, true);
  });
});

describe('callJsonSync：出站请求编码', () => {
  test('上线的是合法 REQUEST 帧，头字段与入参逐一对应', () => {
    const t = echoTransport();
    const bridge = createMoonbitHostBridge({ transport: t, capabilityMask: ALL });
    bridge.callJsonSync(SERVICE.NET, METHOD.NET.HTTP_GET, { q: 'berlin' }, { timeoutMs: 1200 });
    const req = t.lastRequest();
    assert.equal(req.header.msgType, IPC.MSG_TYPE.REQUEST);
    assert.equal(req.header.serviceId, SERVICE.NET);
    assert.equal(req.header.methodId, METHOD.NET.HTTP_GET);
    assert.equal(req.header.status, 0);
    assert.equal(req.payload.toString('utf-8'), '{"q":"berlin"}');
    assert.deepEqual(t.lastMeta(), { requestId: req.header.requestId, serviceId: SERVICE.NET, methodId: METHOD.NET.HTTP_GET, timeoutMs: 1200 });
  });

  test('KNOWN-DEFECT: undefined 与 null/0/false/空串走不同分支，空串以零字节上线', () => {
    // moonbitHostBridge.js:59-68: undefined becomes '{}', but every other falsy value is
    // serialized by JSON.stringify, so null goes out as the literal 'null' and 0/false as a
    // bare number/boolean -- which the guest-side decoder then reads back as null/0/false
    // rather than "no payload". An empty string is passed through as zero bytes at all.
    const t = echoTransport();
    const bridge = createMoonbitHostBridge({ transport: t, capabilityMask: ALL });
    const cases = [[undefined, '{}'], [null, 'null'], [0, '0'], [false, 'false'], ['', ''], [Buffer.from('raw-bytes'), 'raw-bytes'], ['not json', 'not json']];
    for (const [payload, expect] of cases) {
      bridge.callJsonSync(SERVICE.NET, 1, payload);
      assert.equal(t.lastRequest().payload.toString('latin1'), expect, `payload ${String(payload)}`);
    }
  });

  test('KNOWN-DEFECT: 名为 callJson 的入口不校验 Buffer/string 载荷是否为 JSON', () => {
    // moonbitHostBridge.js:62-67 returns Buffer/string payloads untouched, while the response
    // path (_decodeJsonResponse, line 71) insists on JSON.parse. The request side can therefore
    // emit bytes no JSON parser can read and the mismatch only surfaces at the peer.
    const t = echoTransport();
    const bridge = createMoonbitHostBridge({ transport: t, capabilityMask: ALL });
    bridge.callJsonSync(SERVICE.NET, 1, '{oops');
    assert.equal(t.lastRequest().payload.toString('latin1'), '{oops');
    bridge.callJsonSync(SERVICE.NET, 1, Buffer.from([0x00, 0x01, 0xfe]));
    assert.deepEqual([...t.lastRequest().payload], [0, 1, 0xfe]);
    assert.throws(() => createMoonbitHostBridge({
      transport: { callSync: () => Buffer.from([0xff, 0xfe]) },
      capabilityMask: ALL,
    }).callJsonSync(SERVICE.NET, 1, {}), IpcProtocolError, '同一批字节作为响应回来时会被拒');
  });

  test('载荷超过 65536 字节抛的是裸 RangeError，不进 Ipc* 错误体系', () => {
    // moonbitHostBridge.js:139-141 throws before any transport is touched.
    const bridge = createMoonbitHostBridge({ transport: echoTransport(), capabilityMask: ALL });
    assert.throws(() => bridge.callJsonSync(SERVICE.NET, 1, Buffer.alloc(IPC.MAX_PAYLOAD_BYTES + 1, 7)),
      new RangeError(`JSON payload too large: ${IPC.MAX_PAYLOAD_BYTES + 1} bytes`));
    assert.equal(bridge.callJsonSync(SERVICE.NET, 1, Buffer.alloc(IPC.MAX_PAYLOAD_BYTES, 7)).ok, true, '恰好 65536 仍可发');
  });

  test('KNOWN-DEFECT: 载荷长度校验发生在发号之后，被拒的调用烧掉 requestId', () => {
    // moonbitHostBridge.js:137 allocates nextRequestId() and line 139 rejects the payload
    // afterwards, so the id is consumed without any frame ever reaching the peer. A guest that
    // retries with oversized payloads produces holes in its own id sequence.
    const t = echoTransport();
    const bridge = createMoonbitHostBridge({ transport: t, capabilityMask: ALL });
    const first = bridge.callJsonSync(SERVICE.NET, 1, {}).requestId;
    assert.throws(() => bridge.callJsonSync(SERVICE.NET, 1, Buffer.alloc(70000)), RangeError);
    const second = bridge.callJsonSync(SERVICE.NET, 1, {}).requestId;
    assert.equal(second - first, 2n, '中间那个号被烧掉了');
    assert.equal(t.calls.length, 2, '但只有一次请求真的上线');
  });

  test('KNOWN-DEFECT: 循环引用/BigInt 载荷以裸 TypeError 逃出序列化', () => {
    // moonbitHostBridge.js:68 calls JSON.stringify without a try/catch, unlike the response
    // side which wraps parse failures in IpcProtocolError. Guests that pass a structure Node
    // cannot serialize get a raw TypeError with no code/errno, so the host's error mapping
    // (_errnoFromError in khySysHost) has nothing to read.
    const bridge = createMoonbitHostBridge({ transport: echoTransport(), capabilityMask: ALL });
    const circular = {};
    circular.self = circular;
    assert.throws(() => bridge.callJsonSync(SERVICE.NET, 1, circular), (err) => err instanceof TypeError && !err.code);
    assert.throws(() => bridge.callJsonSync(SERVICE.NET, 1, { v: 1n }), /Do not know how to serialize a BigInt/);
    assert.equal(bridge.callJsonSync(SERVICE.NET, 1, { n: NaN, i: Infinity }).ok, true, 'NaN/Infinity 被静默写成 null');
  });

  test('入参 serviceId/methodId 越界抛裸 RangeError，能力门却已经先按 fail-open 放行', () => {
    const bridge = createMoonbitHostBridge({ transport: echoTransport(), capabilityMask: ALL });
    assert.throws(() => bridge.callJsonSync('x', 1, {}), (err) => {
      assert.equal(err instanceof RangeError, true, '未被翻译为 Ipc* 错误');
      assert.equal(err.code, undefined);
      assert.match(err.message, /serviceId out of range: x/);
      return true;
    });
    assert.throws(() => bridge.callJsonSync(SERVICE.NET, 70000, {}), /methodId out of range: 70000/);
    assert.throws(() => bridge.callJsonSync(70000, 1, {}), /serviceId out of range: 70000/);
    assert.throws(() => bridge.callJsonSync(1.5, 1, {}), /serviceId out of range: 1.5/);
  });

  test('options.timeoutMs 只有正整数生效，其余全部回落默认值', () => {
    const t = echoTransport();
    const bridge = createMoonbitHostBridge({ transport: t, capabilityMask: ALL });
    for (const bad of [0, -1, 1.5, '30', null, NaN, Infinity, true, {}]) {
      bridge.callJsonSync(SERVICE.NET, 1, {}, { timeoutMs: bad });
      assert.equal(t.lastMeta().timeoutMs, IPC.DEFAULT_TIMEOUT_MS, `timeoutMs ${String(bad)} 被忽略`);
    }
    bridge.callJsonSync(SERVICE.NET, 1, {}, { timeoutMs: 2 ** 31 });
    assert.equal(t.lastMeta().timeoutMs, 2 ** 31, '超过 32 位的正整数不被视为异常，原样透传');
    bridge.callJsonSync(SERVICE.NET, 1, {}, { timeoutMs: 1 });
    assert.equal(t.lastMeta().timeoutMs, 1);
    bridge.callJsonSync(SERVICE.NET, 1, {}, { timeoutMs: Number.MAX_SAFE_INTEGER });
    assert.equal(t.lastMeta().timeoutMs, Number.MAX_SAFE_INTEGER, '正整数没有上界');
  });

  test('KNOWN-DEFECT: defaultTimeoutMs 零校验，字符串/负数/null 原样送进 transport', () => {
    // moonbitHostBridge.js:102 accepts anything for defaultTimeoutMs and lines 132-135/206-209
    // fall back to it verbatim, so a typo at construction time reaches the transport as a
    // non-number timeout instead of failing fast.
    const t = echoTransport();
    for (const bad of ['soon', -1, 0, 1.5, null]) {
      const bridge = createMoonbitHostBridge({ transport: t, capabilityMask: ALL, defaultTimeoutMs: bad });
      bridge.callJsonSync(SERVICE.NET, 1, {});
      assert.equal(t.lastMeta().timeoutMs, bad, `默认值 ${String(bad)} 未被拦下`);
    }
    const undef = createMoonbitHostBridge({ transport: t, capabilityMask: ALL, defaultTimeoutMs: undefined });
    undef.callJsonSync(SERVICE.NET, 1, {});
    assert.equal(t.lastMeta().timeoutMs, IPC.DEFAULT_TIMEOUT_MS, '只有 undefined 走参数默认值');
  });

  test('KNOWN-DEFECT: options 传 null 时在读 timeoutMs 处崩溃', () => {
    // moonbitHostBridge.js:128/198 only defaults options when the argument is undefined, and
    // the capability gate (129-130/199-200) has already run, so callers get a raw TypeError
    // after the privilege check instead of an argument error before it.
    const bridge = createMoonbitHostBridge({ transport: echoTransport(), capabilityMask: ALL });
    assert.throws(() => bridge.callJsonSync(SERVICE.NET, 1, {}, null), (err) => {
      assert.equal(err instanceof TypeError, true, '既不是 CapabilityError 也不是 Ipc* 错误');
      assert.equal(err.code, undefined);
      assert.match(err.message, /Cannot read properties of null \(reading 'timeoutMs'\)/);
      return true;
    });
    return assert.rejects(() => bridge.callJson(SERVICE.NET, 1, {}, null), TypeError, '异步面同样 reject 裸 TypeError');
  });

  test('options 传字符串等非对象时静默用默认超时', () => {
    const t = echoTransport();
    const bridge = createMoonbitHostBridge({ transport: t, capabilityMask: ALL });
    bridge.callJsonSync(SERVICE.NET, 1, {}, 'x');
    assert.equal(t.lastMeta().timeoutMs, IPC.DEFAULT_TIMEOUT_MS);
    bridge.callJsonSync(SERVICE.NET, 1, {}, 0);
    assert.equal(t.lastMeta().timeoutMs, IPC.DEFAULT_TIMEOUT_MS);
    bridge.callJsonSync(SERVICE.NET, 1, {}, []);
    assert.equal(t.lastMeta().timeoutMs, IPC.DEFAULT_TIMEOUT_MS);
  });
});

describe('callJsonSync：入站响应校验', () => {
  test('RESPONSE + status 0 闭环：ok/data/rawPayload 三者一致', () => {
    const bridge = createMoonbitHostBridge({ transport: echoTransport({ payload: '{"a":1}' }), capabilityMask: ALL });
    const r = bridge.callJsonSync(SERVICE.NET, 1, {});
    assert.equal(r.ok, true);
    assert.equal(r.status, 0);
    assert.deepEqual(r.data, { a: 1 });
    assert.equal(r.rawPayload.toString('utf-8'), '{"a":1}');
    assert.equal(typeof r.requestId, 'bigint');
    assert.deepEqual(Object.keys(r), ['requestId', 'status', 'ok', 'data', 'rawPayload']);
  });

  test('RESPONSE 带负 status 只把 ok 置 false，不抛错', () => {
    // moonbitHostBridge.js:192: ok = status >= 0 && msgType === RESPONSE. A guest that only
    // reads `data` will happily consume the body of an errored reply.
    const bridge = createMoonbitHostBridge({ transport: echoTransport({ status: -13, payload: '{"error":"denied"}' }), capabilityMask: ALL });
    const r = bridge.callJsonSync(SERVICE.NET, 1, {});
    assert.equal(r.ok, false);
    assert.equal(r.status, -13);
    assert.deepEqual(r.data, { error: 'denied' });
  });

  test('ERROR 帧即使 status 为 0 也只算失败', () => {
    const bridge = createMoonbitHostBridge({ transport: echoTransport({ msgType: IPC.MSG_TYPE.ERROR, status: 0, payload: '{"a":1}' }), capabilityMask: ALL });
    const r = bridge.callJsonSync(SERVICE.NET, 1, {});
    assert.equal(r.ok, false);
    assert.equal(r.status, 0);
    assert.deepEqual(r.data, { a: 1 });
  });

  test('requestId 不匹配报 IpcProtocolError，两侧值写进文案', () => {
    const bridge = createMoonbitHostBridge({ transport: echoTransport({ requestId: 999999n }), capabilityMask: ALL });
    assert.throws(() => bridge.callJsonSync(SERVICE.NET, 1, {}), (err) => {
      assert.equal(err instanceof IpcProtocolError, true);
      assert.equal(err.code, 'EPROTO');
      assert.equal(err.errno, -71);
      assert.match(err.message, /Mismatched request_id: expected=\d+ actual=999999/);
      return true;
    });
  });

  test('msgType 既非 RESPONSE 也非 ERROR 一律 IpcProtocolError', () => {
    for (const msgType of [IPC.MSG_TYPE.REQUEST, IPC.MSG_TYPE.EVENT]) {
      const bridge = createMoonbitHostBridge({ transport: { callSync: (frame) => buildResponse(frame, { msgType, payload: '{}' }) }, capabilityMask: ALL });
      assert.throws(() => bridge.callJsonSync(SERVICE.NET, 1, {}), IpcProtocolError, /Unexpected response msg_type/);
    }
  });

  test('空载荷解析成 {}，而 null/[]/7 字面量原样成为 data', () => {
    for (const [payload, expected] of [['', {}], ['null', null], ['[]', []], ['7', 7], ['"str"', 'str'], ['true', true]]) {
      const bridge = createMoonbitHostBridge({ transport: echoTransport({ payload }), capabilityMask: ALL });
      const r = bridge.callJsonSync(SERVICE.NET, 1, {});
      assert.deepEqual(r.data, expected, `payload ${payload}`);
      assert.equal(r.rawPayload.toString('latin1'), payload);
    }
  });

  test('响应体不是合法 JSON 时报 IpcProtocolError 并带上解析器原文', () => {
    const bridge = createMoonbitHostBridge({ transport: echoTransport({ payload: '{bad' }), capabilityMask: ALL });
    assert.throws(() => bridge.callJsonSync(SERVICE.NET, 1, {}), IpcProtocolError, /Response JSON parse failed/);
  });

  test('响应里的 __proto__ 键不会污染全局原型', () => {
    const bridge = createMoonbitHostBridge({
      transport: echoTransport({ payload: '{"__proto__":{"polluted":true},"x":1}' }),
      capabilityMask: ALL,
    });
    const r = bridge.callJsonSync(SERVICE.NET, 1, {});
    assert.equal(Object.getPrototypeOf(r.data), Object.prototype);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(r.data, '__proto__'), true, 'JSON.parse 把它落成自身键');
    assert.equal(r.data.x, 1);
  });

  test('rawPayload 是独立副本，写它不会脏到响应帧本身', () => {
    let saved;
    const transport = {
      callSync(frame) {
        saved = buildResponse(frame, { payload: '{"a":1}' });
        return saved;
      },
    };
    const r = createMoonbitHostBridge({ transport, capabilityMask: ALL }).callJsonSync(SERVICE.NET, 1, {});
    r.rawPayload[0] = 0x5a;
    assert.equal(saved.subarray(IPC.HEADER_SIZE).toString('latin1'), '{"a":1}', 'moonbitHostBridge.js:194 Buffer.from 做了拷贝');
    assert.deepEqual(r.data, { a: 1 });
  });

  test('transport 抛错被包成 IpcTransportError 并保留原 message', () => {
    const bridge = createMoonbitHostBridge({ transport: { callSync() { throw new Error('boom'); } }, capabilityMask: ALL });
    assert.throws(() => bridge.callJsonSync(SERVICE.NET, 1, {}), (err) => {
      assert.equal(err instanceof IpcTransportError, true);
      assert.equal(err.code, 'EIO');
      assert.equal(err.errno, -5);
      assert.equal(err.message, 'IPC sync transport failed: boom');
      return true;
    });
    const asyncBridge = createMoonbitHostBridge({ transport: { async call() { throw new TypeError('net down'); } }, capabilityMask: ALL });
    return assert.rejects(() => asyncBridge.callJson(SERVICE.NET, 1, {}), IpcTransportError, /IPC transport failed: net down/);
  });

  test('transport 返回非帧的三种脏值都收敛为 IpcProtocolError', () => {
    const cases = [
      ['not-a-frame', /Failed to decode IPC response: frame too short: 11/],
      [undefined, /Failed to decode IPC response: frame too short: 0/],
      [Buffer.alloc(40), /Failed to decode IPC response: invalid magic: 0x0/],
      [{}, /Failed to decode IPC response: payload must be Buffer/],
    ];
    for (const [value, pattern] of cases) {
      const bridge = createMoonbitHostBridge({ transport: { callSync: () => value }, capabilityMask: ALL });
      assert.throws(() => bridge.callJsonSync(SERVICE.NET, 1, {}), IpcProtocolError, pattern, String(value));
    }
  });

  test('KNOWN-DEFECT: callSync 误返回 Promise 时报 EPROTO 而不是明确的用法错误', () => {
    // moonbitHostBridge.js:232 takes whatever callSync returns and hands it to decodeFrame
    // (line 244). A transport whose "sync" method is really async yields a Promise, which
    // normalizePayload rejects -- the guest sees IpcProtocolError/EPROTO and cannot tell that
    // its transport is mislabelled.
    const bridge = createMoonbitHostBridge({ transport: { callSync: async () => Buffer.alloc(36) }, capabilityMask: ALL });
    assert.throws(() => bridge.callJsonSync(SERVICE.NET, 1, {}), IpcProtocolError, /payload must be Buffer, Uint8Array, string, null, or undefined/);
  });

  test('只有异步 call 的传输上调 callJsonSync 得到明确的 IpcTransportError', () => {
    const bridge = createMoonbitHostBridge({ transport: { async call() { return Buffer.alloc(36); } }, capabilityMask: ALL });
    assert.throws(() => bridge.callJsonSync(SERVICE.NET, 1, {}), IpcTransportError, /IPC sync transport is not available/);
  });

  test('能力不足时同步面抛、异步面 reject，且 transport 一次都没被调用', () => {
    const t = echoTransport();
    const bridge = createMoonbitHostBridge({ transport: t, capabilityMask: 0n });
    assert.throws(() => bridge.callJsonSync(SERVICE.NET, 1, {}), CapabilityError, /Missing capability: CAP_IPC/);
    assert.equal(t.calls.length, 0);
    return assert.rejects(() => bridge.callJson(SERVICE.NET, 1, {}), CapabilityError, /Missing capability: CAP_IPC/);
  });
});

describe('callJson 异步面与同步面同规则', () => {
  test('异步传输闭环：结果形状与 callJsonSync 完全一致', async () => {
    const seen = [];
    const transport = {
      async call(frame, meta) {
        seen.push(meta);
        return buildResponse(frame, { payload: '{"async":true}' });
      },
    };
    const bridge = createMoonbitHostBridge({ transport, capabilityMask: ALL });
    const r = await bridge.callJson(SERVICE.NET, METHOD.NET.HTTP_GET, { q: 1 }, { timeoutMs: 250 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.data, { async: true });
    assert.equal(seen.length, 1);
    assert.deepEqual(Object.keys(seen[0]), ['requestId', 'serviceId', 'methodId', 'timeoutMs']);
    assert.equal(seen[0].requestId, r.requestId, 'meta 与返回值带同一个 requestId');
    assert.equal(seen[0].timeoutMs, 250);
  });

  test('异步面优先用 transport.call，call 不存在时才退到 callSync', async () => {
    const used = [];
    const both = {
      async call(frame) {
        used.push('call');
        return buildResponse(frame, { payload: '{"via":"call"}' });
      },
      callSync() {
        used.push('callSync');
        throw new Error('should not be used');
      },
    };
    const bridge = createMoonbitHostBridge({ transport: both, capabilityMask: ALL });
    const r = await bridge.callJson(SERVICE.NET, 1, {});
    assert.deepEqual(r.data, { via: 'call' });
    assert.deepEqual(used, ['call']);

    const syncOnly = echoTransport({ payload: '{"via":"callSync"}' });
    const bridge2 = createMoonbitHostBridge({ transport: syncOnly, capabilityMask: ALL });
    const r2 = await bridge2.callJson(SERVICE.NET, 1, {});
    assert.deepEqual(r2.data, { via: 'callSync' });
  });

  test('异步面同样把超载荷/循环引用/脏响应原样抛出对应类型', async () => {
    const bridge = createMoonbitHostBridge({ transport: echoTransport(), capabilityMask: ALL });
    await assert.rejects(() => bridge.callJson(SERVICE.NET, 1, Buffer.alloc(70000)), RangeError);
    const circular = {};
    circular.self = circular;
    await assert.rejects(() => bridge.callJson(SERVICE.NET, 1, circular), TypeError);
    const dirty = createMoonbitHostBridge({ transport: { async call() { return 'nope'; } }, capabilityMask: ALL });
    await assert.rejects(() => dirty.callJson(SERVICE.NET, 1, {}), IpcProtocolError);
  });

  test('异步面复用同一能力映射：未知服务只需 CAP.IPC 即可发出', async () => {
    const t = echoTransport();
    const bridge = createMoonbitHostBridge({ transport: t, capabilityMask: CAP.IPC });
    const r = await bridge.callJson(4242, 1, {});
    assert.equal(r.ok, true);
    assert.equal(t.lastRequest().header.serviceId, 4242);
    await assert.rejects(() => bridge.callJson(SERVICE.WM, 1, {}), CapabilityError);
  });

  test('三个错误类各自带 code/errno，且都是 Error 子类', () => {
    const checks = [[CapabilityError, 'EACCES', -13], [IpcTransportError, 'EIO', -5], [IpcProtocolError, 'EPROTO', -71]];
    for (const [Ctor, code, errno] of checks) {
      const err = new Ctor('x');
      assert.equal(err instanceof Error, true);
      assert.equal(err.name, Ctor.name);
      assert.equal(err.code, code);
      assert.equal(err.errno, errno);
      assert.equal(err.message, 'x');
      assert.equal(Object.getPrototypeOf(Ctor), Error, `${Ctor.name} 直接继承 Error`);
      assert.equal(Object.getPrototypeOf(Ctor.prototype), Error.prototype);
      assert.equal(err.stack.includes(Ctor.name), true);
    }
  });

  test('模块面恰为 5 个导出', () => {
    assert.deepEqual(Object.keys(mod).sort(), ['CapabilityError', 'IpcProtocolError', 'IpcTransportError', 'createMoonbitHostBridge', 'requiredCapabilityForCall']);
  });
});
