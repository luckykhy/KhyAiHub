'use strict';

// Co-located contract tests for ipcCodec.js (C-4, [RESEARCH-018] §2.3).
// This is the M1 IPC wire codec: a 36-byte little-endian header plus an opaque payload.
// Everything here runs on in-memory Buffers only -- no socket, no child process, no wasm.
// The interesting surface is the asymmetry between the encode path (createHeader gates every
// field into its wire range) and the decode path (decodeFrame only gates magic, version and
// total length), because a hostile guest feeds the decode path.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const codec = require('./ipcCodec');
const { IPC } = require('./m1Constants');

const { normalizePayload, nextRequestId, createHeader, encodeFrame, decodeFrame } = codec;

const REQ = { msgType: IPC.MSG_TYPE.REQUEST, serviceId: 2, methodId: 1 };

function frameOf(payload, extra = {}) {
  return encodeFrame({
    header: { msgType: IPC.MSG_TYPE.REQUEST, serviceId: 2, methodId: 1, requestId: 42n, ...extra },
    payload,
  });
}

describe('normalizePayload：载荷归一', () => {
  test('null 与 undefined 归一为零长 Buffer，空串同样零长', () => {
    for (const value of [null, undefined]) {
      const out = normalizePayload(value);
      assert.ok(Buffer.isBuffer(out));
      assert.equal(out.length, 0);
    }
    assert.equal(normalizePayload('').length, 0);
  });

  test('字符串按 utf-8 编码，中文按字节数而非字符数计长', () => {
    const out = normalizePayload('你好ab');
    assert.deepEqual([...out], [...Buffer.from('你好ab', 'utf-8')]);
    assert.equal(out.length, 8, '2 个中文 6 字节 + 2 个 ascii');
  });

  test('Uint8Array 走拷贝：归一结果与源不共享内存', () => {
    const src = new Uint8Array([1, 2, 3]);
    const out = normalizePayload(src);
    assert.ok(Buffer.isBuffer(out));
    assert.notEqual(out.buffer, src.buffer, '拷贝而非视图');
    src[0] = 99;
    assert.equal(out[0], 1, '源被改不影响已归一的载荷');
  });

  test('KNOWN-DEFECT: Buffer 入参直接原样返回同一实例，归一不提供任何隔离', () => {
    // ipcCodec.js:18-20 `if (Buffer.isBuffer(payload)) return payload;` -- the function is
    // named "normalize" and copies for every other typed input, so a caller that expects the
    // returned buffer to be detached still owns the same memory the caller wrote.
    const src = Buffer.from('abc');
    const out = normalizePayload(src);
    assert.equal(out, src, '同一实例，不是拷贝');
    out[0] = 0x5a;
    assert.equal(src.toString(), 'Zbc', '写归一结果即写脏调用方对象');
  });

  test('数字/布尔/对象/数组/函数/谎报 length 的对象一律 TypeError', () => {
    const bad = [0, -1, 1.5, NaN, 2 ** 53, true, false, {}, [], () => {}, Symbol('s'),
      { length: 9999 }, { constructor: 1 }, { byteLength: 4 }, new Uint16Array([1, 2])];
    for (const value of bad) {
      assert.throws(() => normalizePayload(value), TypeError, `${String(value)} 必须被拒`);
    }
    // 连 0 与空数组这类 falsy 值也不被静默当成空载荷，而是明确拒绝
    assert.throws(() => normalizePayload(0), /payload must be Buffer, Uint8Array, string, null, or undefined/);
  });
});

describe('createHeader：逐字段入域校验', () => {
  test('缺省 flags/status/payloadLen 为 0，requestId 缺省自动分配', () => {
    const hdr = createHeader({ msgType: 1, serviceId: 2, methodId: 3 });
    assert.deepEqual(Object.keys(hdr), ['magic', 'version', 'msgType', 'requestId', 'serviceId', 'methodId', 'flags', 'status', 'payloadLen']);
    assert.equal(hdr.magic, IPC.MAGIC);
    assert.equal(hdr.version, IPC.VERSION);
    assert.equal(hdr.flags, 0);
    assert.equal(hdr.status, 0);
    assert.equal(hdr.payloadLen, 0);
    assert.equal(typeof hdr.requestId, 'bigint');
  });

  test('msgType 只收 1..0xffff 的整数，0/越界/小数/字符串/undefined 全拒', () => {
    assert.equal(createHeader({ msgType: 1, serviceId: 0, methodId: 0 }).msgType, 1);
    assert.equal(createHeader({ msgType: 0xffff, serviceId: 0, methodId: 0 }).msgType, 0xffff);
    for (const bad of [0, -1, 0x10000, 1.5, '1', NaN, Infinity, null, undefined, {}]) {
      assert.throws(() => createHeader({ msgType: bad, serviceId: 0, methodId: 0 }), RangeError, `${String(bad)} 必须被拒`);
    }
  });

  test('serviceId/methodId 允许 0 但不允许越界或负数', () => {
    assert.equal(createHeader({ msgType: 1, serviceId: 0, methodId: 0 }).serviceId, 0);
    assert.throws(() => createHeader({ msgType: 1, serviceId: -1, methodId: 0 }), RangeError);
    assert.throws(() => createHeader({ msgType: 1, serviceId: 0x10000, methodId: 0 }), RangeError);
    assert.throws(() => createHeader({ msgType: 1, serviceId: 0, methodId: 0x10000 }), RangeError);
    assert.throws(() => createHeader({ msgType: 1, serviceId: 0 }), RangeError, 'methodId 缺省即 undefined 也被拒');
  });

  test('flags 上限 0xffffffff，status 为有符号 32 位两端都封住', () => {
    assert.equal(createHeader({ msgType: 1, serviceId: 0, methodId: 0, flags: 0xffffffff }).flags, 0xffffffff);
    assert.throws(() => createHeader({ msgType: 1, serviceId: 0, methodId: 0, flags: 0x100000000 }), /flags out of range/);
    assert.throws(() => createHeader({ msgType: 1, serviceId: 0, methodId: 0, flags: -1 }), /flags out of range/);
    assert.equal(createHeader({ msgType: 1, serviceId: 0, methodId: 0, status: -0x80000000 }).status, -0x80000000);
    assert.equal(createHeader({ msgType: 1, serviceId: 0, methodId: 0, status: 0x7fffffff }).status, 0x7fffffff);
    assert.throws(() => createHeader({ msgType: 1, serviceId: 0, methodId: 0, status: 0x80000000 }), /status out of range/);
    assert.throws(() => createHeader({ msgType: 1, serviceId: 0, methodId: 0, status: -0x80000001 }), /status out of range/);
  });

  test('payloadLen 以 65536 为硬界，超限报的是 M1 上限而不是 out of range', () => {
    assert.equal(createHeader({ msgType: 1, serviceId: 0, methodId: 0, payloadLen: 65536 }).payloadLen, 65536);
    assert.throws(() => createHeader({ msgType: 1, serviceId: 0, methodId: 0, payloadLen: 65537 }),
      new RangeError(`payload exceeds M1 max ${IPC.MAX_PAYLOAD_BYTES} bytes`));
    assert.throws(() => createHeader({ msgType: 1, serviceId: 0, methodId: 0, payloadLen: -1 }), /payloadLen out of range/);
  });

  test('requestId 半开区间 (0, 2^63-1]，number 侧仍受安全整数约束', () => {
    assert.equal(createHeader({ msgType: 1, serviceId: 0, methodId: 0, requestId: (1n << 63n) - 1n }).requestId, (1n << 63n) - 1n);
    assert.equal(createHeader({ msgType: 1, serviceId: 0, methodId: 0, requestId: 5 }).requestId, 5n);
    assert.throws(() => createHeader({ msgType: 1, serviceId: 0, methodId: 0, requestId: 0n }), /requestId out of range: 0/);
    assert.throws(() => createHeader({ msgType: 1, serviceId: 0, methodId: 0, requestId: -1n }), /requestId out of range: -1/);
    assert.throws(() => createHeader({ msgType: 1, serviceId: 0, methodId: 0, requestId: 1n << 63n }), /requestId out of range/);
    assert.throws(() => createHeader({ msgType: 1, serviceId: 0, methodId: 0, requestId: 2 ** 53 }), TypeError);
  });

  test('入参里的原型键进不了返回对象', () => {
    const hdr = createHeader({ msgType: 1, serviceId: 0, methodId: 0, '__proto__': { evil: 1 }, constructor: 7, toString: 'x' });
    assert.equal(Object.getPrototypeOf(hdr), Object.prototype);
    assert.equal(hdr.evil, undefined);
    assert.equal(Object.keys(hdr).length, 9);
    assert.equal(typeof hdr.requestId, 'bigint', '未指定 requestId 时仍由发号器补上');
  });

  test('无参/传 null 走的是解构 TypeError，不是字段 RangeError', () => {
    // Not a documented promise, but the two error families differ: callers cannot treat
    // RangeError as the only "bad input" signal from this function.
    assert.throws(() => createHeader(), TypeError);
    assert.throws(() => createHeader(null), TypeError);
    assert.throws(() => createHeader(undefined), TypeError);
  });
});

describe('encodeFrame：36 字节小端头 + 载荷落盘', () => {
  test('头部逐字段偏移与保留字节全零', () => {
    const f = encodeFrame({
      header: { msgType: 2, serviceId: 3, methodId: 4, requestId: 1234n, flags: 5, status: -13 },
      payload: 'khy',
    });
    assert.equal(f.length, IPC.HEADER_SIZE + 3);
    assert.equal(f.readUInt32LE(0), IPC.MAGIC);
    assert.equal(f.readUInt16LE(4), IPC.VERSION);
    assert.equal(f.readUInt16LE(6), 2);
    assert.equal(f.readBigUInt64LE(8), 1234n);
    assert.equal(f.readUInt16LE(16), 3);
    assert.equal(f.readUInt16LE(18), 4);
    assert.equal(f.readUInt32LE(20), 5);
    assert.equal(f.readInt32LE(24), -13);
    assert.equal(f.readUInt32LE(28), 3);
    assert.deepEqual([...f.subarray(32, 36)], [0, 0, 0, 0], 'bytes 32-35 是保留位');
    assert.equal(f.subarray(36).toString(), 'khy');
  });

  test('magic 的线路字节序是小端，与 m1Constants 注释的字面拼写相反', () => {
    // m1Constants.js:65 labels MAGIC as "KHYP", ipcCodec.js:89 writes it with writeUInt32LE,
    // so the first four bytes on the wire are 50 59 48 4b. A peer that follows the comment and
    // sends the ASCII literal is rejected by decodeFrame -- see the matching pin below.
    const f = frameOf('x');
    assert.deepEqual([...f.subarray(0, 4)], [0x50, 0x59, 0x48, 0x4b]);
  });

  test('header 缺 / 非对象 / 空对象分别抛 TypeError 与 RangeError', () => {
    assert.throws(() => encodeFrame({ payload: 'x' }), TypeError, /header is required/);
    assert.throws(() => encodeFrame({ header: null }), TypeError, /header is required/);
    assert.throws(() => encodeFrame({ header: 'str' }), TypeError, /header is required/);
    assert.throws(() => encodeFrame({ header: 0 }), TypeError, /header is required/);
    assert.throws(() => encodeFrame({}), TypeError, /header is required/);
    assert.throws(() => encodeFrame({ header: {} }), RangeError, /msgType out of range: undefined/);
  });

  test('调用方伪造的 magic/version 被常量覆盖，不写进帧', () => {
    const f = encodeFrame({
      header: { magic: 0xdeadbeef, version: 99, msgType: 1, serviceId: 2, methodId: 1, requestId: 7n },
      payload: 'hi',
    });
    assert.equal(f.readUInt32LE(0), IPC.MAGIC);
    assert.equal(f.readUInt16LE(4), IPC.VERSION);
  });

  test('谎报的 payloadLen 一律以真实载荷长度覆盖，编码侧不信任入参', () => {
    const big = encodeFrame({ header: { ...REQ, payloadLen: 999 }, payload: 'abc' });
    assert.equal(big.readUInt32LE(28), 3);
    assert.equal(big.length, IPC.HEADER_SIZE + 3);
    const small = encodeFrame({ header: { ...REQ, payloadLen: 1 }, payload: 'abcdefgh' });
    assert.equal(small.readUInt32LE(28), 8);
    assert.equal(small.length, IPC.HEADER_SIZE + 8);
  });

  test('载荷超过 65536 字节直接拒，不静默截断', () => {
    assert.equal(encodeFrame({ header: REQ, payload: Buffer.alloc(IPC.MAX_PAYLOAD_BYTES, 7) }).length, IPC.HEADER_SIZE + 65536);
    assert.throws(() => encodeFrame({ header: REQ, payload: Buffer.alloc(65537, 1) }), /payload exceeds M1 max 65536 bytes/);
    assert.throws(() => encodeFrame({ header: REQ, payload: 'x'.repeat(70000) }), RangeError);
  });

  test('编码后的帧与入参 Buffer 载荷不共享内存', () => {
    const src = Buffer.from('abc');
    const f = encodeFrame({ header: REQ, payload: src });
    src[0] = 0x5a;
    assert.equal(f.subarray(36).toString(), 'abc', 'encodeFrame 内部 copy 而非引用');
  });
});

describe('decodeFrame：入站帧守门', () => {
  test('编解码往返闭合：头字段与载荷逐字节一致', () => {
    const f = encodeFrame({
      header: { msgType: 0xffff, serviceId: 0xffff, methodId: 0xffff, requestId: (1n << 63n) - 1n, flags: 0xffffffff, status: -0x80000000 },
      payload: '中文payload',
    });
    const d = decodeFrame(f);
    assert.equal(d.header.msgType, 0xffff);
    assert.equal(d.header.serviceId, 0xffff);
    assert.equal(d.header.methodId, 0xffff);
    assert.equal(d.header.requestId, (1n << 63n) - 1n);
    assert.equal(d.header.flags, 0xffffffff);
    assert.equal(d.header.status, -0x80000000);
    assert.equal(d.payload.toString('utf-8'), '中文payload');
    assert.deepEqual(Object.keys(d.header), ['magic', 'version', 'msgType', 'requestId', 'serviceId', 'methodId', 'flags', 'status', 'payloadLen']);
  });

  test('零长载荷帧恰为 36 字节，解码得到空 Buffer 而不是 undefined', () => {
    const f = encodeFrame({ header: REQ });
    assert.equal(f.length, IPC.HEADER_SIZE);
    const d = decodeFrame(f);
    assert.equal(d.header.payloadLen, 0);
    assert.ok(Buffer.isBuffer(d.payload));
    assert.equal(d.payload.length, 0);
  });

  test('短于 36 字节 / 半截载荷 / 长度字段不符三类畸形各自报错', () => {
    const f = encodeFrame({ header: REQ, payload: 'abcdefgh' });
    assert.throws(() => decodeFrame(f.subarray(0, 35)), /frame too short: 35/);
    assert.throws(() => decodeFrame(Buffer.alloc(0)), /frame too short: 0/);
    assert.throws(() => decodeFrame(f.subarray(0, 40)), /frame length mismatch: got 40, expected 44/);
    const lying = Buffer.from(f);
    lying.writeUInt32LE(100, 28);
    assert.throws(() => decodeFrame(lying), /frame length mismatch: got 44, expected 136/);
  });

  test('magic 或 version 不符即拒，错误里带上实际读到的值', () => {
    const badMagic = Buffer.from(frameOf('x'));
    badMagic.writeUInt32LE(0xdeadbeef, 0);
    assert.throws(() => decodeFrame(badMagic), /invalid magic: 0xdeadbeef/);
    const badVersion = Buffer.from(frameOf('x'));
    badVersion.writeUInt16LE(2, 4);
    assert.throws(() => decodeFrame(badVersion), /unsupported IPC version: 2/);
  });

  test('payloadLen 字段超过 M1 上限在长度核对之前就拒', () => {
    const raw = Buffer.alloc(IPC.HEADER_SIZE);
    raw.writeUInt32LE(IPC.MAGIC, 0);
    raw.writeUInt16LE(IPC.VERSION, 4);
    raw.writeUInt16LE(1, 6);
    raw.writeBigUInt64LE(1n, 8);
    raw.writeUInt32LE(0xffffffff, 28);
    assert.throws(() => decodeFrame(raw), /payload_len too large: 4294967295/);
  });

  test('KNOWN-DEFECT: 按 m1Constants 注释把 magic 拼成字面 "KHYP" 的对端被拒', () => {
    // ipcCodec.js:110 compares readUInt32LE against IPC.MAGIC, while m1Constants.js:65
    // documents that constant as the string "KHYP". A peer honouring the comment writes the
    // four ASCII bytes and lands on 0x5059484b little-endian -- rejected as invalid magic.
    const raw = Buffer.alloc(IPC.HEADER_SIZE);
    raw.write('KHYP', 0, 'latin1');
    raw.writeUInt16LE(IPC.VERSION, 4);
    raw.writeUInt16LE(1, 6);
    raw.writeBigUInt64LE(1n, 8);
    assert.throws(() => decodeFrame(raw), /invalid magic: 0x5059484b/);
  });

  test('KNOWN-DEFECT: 解码侧不复核 msgType/serviceId/methodId/requestId 的取值域', () => {
    // encodeFrame/createHeader (ipcCodec.js:48-53, 60-62) reject msgType 0, requestId 0n and
    // ids above 0xffff, but decodeFrame reads those fields raw (lines 120-126) and returns
    // them. Every downstream consumer that trusts a decoded header therefore has to redo the
    // range checks itself; nothing in the codec guarantees it.
    const raw = Buffer.from(frameOf('x'));
    raw.writeUInt16LE(0, 6);
    raw.writeBigUInt64LE(0n, 8);
    raw.writeUInt16LE(0, 16);
    raw.writeUInt16LE(0xffff, 18);
    const d = decodeFrame(raw);
    assert.equal(d.header.msgType, 0, '编码器视为非法的 0 从解码器出来了');
    assert.equal(d.header.requestId, 0n, 'requestId 0n 在解码侧被原样交还');
    assert.equal(d.header.serviceId, 0);
    assert.equal(d.header.methodId, 0xffff);
    assert.throws(() => createHeader({ msgType: 0, serviceId: 0, methodId: 0xffff, requestId: 0n }), RangeError, '同一组值自己编码会被拒');
  });

  test('KNOWN-DEFECT: 解码出的 payload 是原帧的视图，写它会脏调用方的缓冲区', () => {
    // ipcCodec.js:149 returns `buf.subarray(HEADER_SIZE)`, which shares the ArrayBuffer with
    // the frame that was handed in (and with normalizePayload's pass-through Buffer). A guest
    // handler that mutates the payload in place corrupts the still-buffered wire frame.
    const frame = encodeFrame({ header: REQ, payload: 'abc' });
    const d = decodeFrame(frame);
    assert.equal(d.payload.buffer, frame.buffer, '同一个 ArrayBuffer');
    assert.equal(d.payload.byteOffset, IPC.HEADER_SIZE);
    d.payload[0] = 0x5a;
    assert.equal(frame.subarray(36).toString(), 'Zbc', '原始帧已被写脏');
    const again = decodeFrame(frame);
    assert.equal(again.payload.toString(), 'Zbc', '再次解码同一帧读到的是被改后的内容');
  });

  test('KNOWN-DEFECT: decodeFrame(null/undefined) 被当成空缓冲，报 too short 而不是类型错', () => {
    // ipcCodec.js:105 runs the argument through normalizePayload, which maps null/undefined to
    // a zero-length Buffer (lines 15-17). A caller that forgot to await a read therefore gets a
    // length error instead of "you passed nothing", and the two are conflated with a genuinely
    // empty frame body of 0 bytes.
    assert.throws(() => decodeFrame(null), /frame too short: 0/);
    assert.throws(() => decodeFrame(undefined), /frame too short: 0/);
    assert.throws(() => decodeFrame('tiny'), /frame too short: 4/);
    assert.throws(() => decodeFrame(42), TypeError, '数字仍然进不了归一化');
    assert.throws(() => decodeFrame(NaN), TypeError);
  });

  test('字符串帧按 utf-8 解释：多字节字符会让字符数与字节数错位', () => {
    // decodeFrame accepts a string because normalizePayload does; the magic check then reads
    // the first four *bytes*, which for CJK text are not what the character index suggests.
    const mb = '你好世界codec-string-frame-is-long-enough';
    assert.equal(mb.length, 37, '37 个字符');
    assert.equal(Buffer.byteLength(mb, 'utf-8'), 45, '但 45 字节');
    assert.throws(() => decodeFrame(mb), /invalid magic: 0xe5a0bde4/);
  });

  test('Uint8Array 帧可解，解码结果不与源视图共享内存', () => {
    const frame = encodeFrame({ header: REQ, payload: 'abc' });
    const view = new Uint8Array(frame.buffer.slice(0, frame.length));
    const d = decodeFrame(view);
    assert.equal(d.payload.toString(), 'abc');
    assert.notEqual(d.payload.buffer, view.buffer, '非 Buffer 入参先被拷贝');
  });

  test('解码返回对象不带原型污染，header 键集合固定为 9 个', () => {
    const d = decodeFrame(frameOf('x'));
    assert.equal(Object.getPrototypeOf(d), Object.prototype);
    assert.equal(Object.getPrototypeOf(d.header), Object.prototype);
    assert.equal(d.header.evil, undefined);
    assert.equal(Object.keys(d).join(','), 'header,payload');
  });
});

describe('nextRequestId：模块级发号器', () => {
  test('返回 bigint 且严格单调 +1', () => {
    const a = nextRequestId();
    const b = nextRequestId();
    const c = nextRequestId();
    assert.equal(typeof a, 'bigint');
    assert.equal(b - a, 1n);
    assert.equal(c - b, 1n);
    assert.ok(a > 0n);
  });

  test('KNOWN-DEFECT: 发号器是进程级共享可变计数器，与连接/会话无关', () => {
    // ipcCodec.js:6 keeps one module-scope `_requestCounter` and lines 33-35 rewind it to 1n
    // past 2^63-1, so ids are unique only within a single process and only until the rewind:
    // two independently started peers mint the exact same sequence (1n, 2n, 3n ...) and any
    // id-keyed reply table on the wire cannot tell them apart.
    const fresh = require('./ipcCodec');
    assert.equal(fresh, codec, '同一模块实例，没有按会话隔离的入口');
    const first = fresh.nextRequestId();
    const second = codec.nextRequestId();
    assert.equal(second - first, 1n, '两个"引用"共用同一条序列，没有按会话分叉');
  });
});
