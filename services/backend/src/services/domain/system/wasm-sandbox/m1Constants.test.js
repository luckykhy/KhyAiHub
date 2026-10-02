'use strict';

// Co-located contract tests for m1Constants.js (C-4, [RESEARCH-018] §2.3).
// These are the wire-level IDs the M1 microkernel publishes ("Keep these IDs stable once
// published"), plus the two helpers that decide whether a capability check passes. The
// stability of the numeric IDs is what the host and the wasm adapters agree on, and
// hasCapability is the single gate every privileged call goes through.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const m1 = require('./m1Constants');

const {
  toBigInt,
  SYSCALL,
  CAP,
  SERVICE,
  METHOD,
  IPC,
  ERRNO,
  negErrno,
  capMask,
  hasCapability,
} = m1;

describe('模块面与常量稳定性', () => {
  test('对外面恰为 10 个成员', () => {
    assert.deepEqual(Object.keys(m1).sort(), [
      'CAP',
      'ERRNO',
      'IPC',
      'METHOD',
      'SERVICE',
      'SYSCALL',
      'capMask',
      'hasCapability',
      'negErrno',
      'toBigInt',
    ]);
  });

  test('已发布的 syscall ID 一字不改（跨端 ABI 契约）', () => {
    assert.deepEqual({ ...SYSCALL }, {
      PROC_SPAWN: 0x01,
      PROC_EXIT: 0x02,
      CAP_GRANT: 0x03,
      CAP_REVOKE: 0x04,
      IPC_CALL: 0x10,
      IPC_REPLY: 0x11,
      IPC_SEND: 0x12,
      IPC_RECV: 0x13,
      SHM_CREATE: 0x20,
      SHM_MAP: 0x21,
      IRQ_BIND: 0x30,
      IRQ_ACK: 0x31,
    });
  });

  test('capability 位互不重叠，且 capMask 组合后逐位可判', () => {
    const bits = Object.values(CAP);
    assert.equal(new Set(bits).size, bits.length, 'capability 位图出现重复位');
    for (const bit of bits) {
      assert.equal(typeof bit, 'bigint', 'capability 必须是 bigint，否则与 mask 比较失真');
      assert.equal(bit & (bit - 1n), 0n, `${bit} 不是 2 的幂`);
    }
    const all = capMask(...bits);
    for (const bit of bits) {
      assert.equal(hasCapability(all, bit), true, `${bit} 组合后应可读回`);
    }
    assert.equal(all, 127n, '七位能力全给应为 0b1111111');
  });

  test('服务与方法 ID 分层：FS/NET/WM 各自 1..n，服务号不重叠', () => {
    assert.deepEqual({ ...SERVICE }, { FS: 1, NET: 2, WM: 3 });
    assert.deepEqual({ ...METHOD.FS }, { READ_FILE: 1, STAT: 2 });
    assert.deepEqual({ ...METHOD.NET }, { HTTP_GET: 1, DNS_RESOLVE: 2 });
    assert.deepEqual({ ...METHOD.WM }, { PRESENT_TEXT: 1, BLIT_RGBA: 2 });
  });

  test('IPC 头布局常量自洽：header 36 字节且 magic 数值是 KHYP 的大端拼写', () => {
    assert.equal(IPC.MAGIC, 0x4b485950);
    // m1Constants.js:65 comments MAGIC as "KHYP". That spelling only holds big-endian:
    // 'K','H','Y','P' are 0x4b,0x48,0x59,0x50 in that order, so a big-endian buffer reads
    // back exactly the constant. ipcCodec writes it with writeUInt32LE, which puts the
    // bytes on the wire reversed (see ipcCodec.test.js) -- the number is still compared
    // numerically on both sides, so this is a naming/comment mismatch, not a corruption.
    const be = Buffer.alloc(4);
    be.writeUInt32BE(IPC.MAGIC, 0);
    assert.equal(be.toString('latin1'), 'KHYP');
    assert.equal(be.readUInt32LE(0), 0x5059484b, '小端读出的是反序字节，说明注释按大端理解');
    assert.equal(IPC.VERSION, 1);
    assert.equal(IPC.HEADER_SIZE, 36);
    assert.equal(IPC.MAX_PAYLOAD_BYTES, 64 * 1024);
    assert.equal(IPC.DEFAULT_TIMEOUT_MS, 3000);
    assert.deepEqual({ ...IPC.MSG_TYPE }, { REQUEST: 1, RESPONSE: 2, EVENT: 3, ERROR: 4 });
  });

  test('errno 表覆盖 khy_sys 实际回传的每一个码', () => {
    for (const name of ['EPERM', 'ENOENT', 'EACCES', 'EINVAL', 'ENOSYS', 'ETIMEDOUT', 'EPROTO', 'EMSGSIZE']) {
      assert.equal(typeof ERRNO[name], 'number', `${name} 缺失会导致 host 回传裸数字`);
      assert.equal(ERRNO[name] > 0, true);
    }
    assert.equal(new Set(Object.values(ERRNO)).size, Object.values(ERRNO).length, 'errno 值有重复');
  });

  test('表与其嵌套层都被冻结，写不进去也改不了嵌套引用', () => {
    for (const table of [SYSCALL, CAP, SERVICE, METHOD, METHOD.FS, METHOD.NET, METHOD.WM, IPC, IPC.MSG_TYPE, ERRNO]) {
      assert.equal(Object.isFrozen(table), true);
    }
    assert.throws(() => {
      'use strict';
      IPC.HEADER_SIZE = 12;
    }, TypeError);
    assert.throws(() => {
      'use strict';
      METHOD.FS.READ_FILE = 99;
    }, TypeError);
    assert.throws(() => {
      'use strict';
      CAP.IPC = 0n;
    }, TypeError);
    assert.equal(IPC.HEADER_SIZE, 36);
    assert.equal(METHOD.FS.READ_FILE, 1);
  });
});

describe('toBigInt：跨 wasm 边界的整数收口', () => {
  test('bigint 原样通过，安全整数转换，其它一律拒绝', () => {
    assert.equal(toBigInt(7n), 7n);
    assert.equal(toBigInt(0), 0n);
    assert.equal(toBigInt(-8), -8n);
    assert.equal(toBigInt(3.0), 3n, '整数值的 number 写法（3.0）也算整数');
    assert.equal(toBigInt(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER));
  });

  test('小数/字符串/NaN/Infinity/不安全整数/对象/布尔都抛 TypeError', () => {
    const bad = [3.5, -0.5, '5', '', NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53), null, undefined, {}, [], true, false, Symbol('s')];
    for (const value of bad) {
      assert.throws(() => toBigInt(value), TypeError, `${String(value)} 必须被拒`);
    }
  });

  test('KNOWN-DEFECT: toBigInt 对 bigint 侧不设位宽上界，远超 u64 的位掩码照收', () => {
    // m1Constants.js:9-11 returns any bigint untouched while the number branch is capped by
    // Number.isSafeInteger, and the error text promises "a safe integer or bigint". A mask
    // wider than 64 bits is therefore accepted here and only explodes much later inside
    // Buffer.writeBigUInt64LE (ipcCodec.js:92) as a RangeError from the codec, not from the
    // gate that was supposed to validate it.
    assert.equal(toBigInt(0xffn << 100n), 0xffn << 100n);
    assert.equal(toBigInt(-1n), -1n, '负 bigint 同样原样通过，无符号语义无人把关');
    // The very value the gate waved through is what ipcCodec.js:92 later hands to
    // Buffer.writeBigUInt64LE, i.e. the failure surfaces as a RangeError at encode time.
    assert.throws(() => Buffer.alloc(8).writeBigUInt64LE(toBigInt(0xffn << 100n), 0), RangeError);
    assert.throws(() => Buffer.alloc(8).writeBigUInt64LE(toBigInt(-1n), 0), RangeError);
  });

  test('label 参数出现在报错里，便于定位是哪一侧的字段', () => {
    assert.throws(() => toBigInt('x', 'capabilityMask'), /capabilityMask must be a safe integer or bigint/);
    assert.throws(() => toBigInt('x'), /value must be a safe integer or bigint/, '缺省 label 是 value');
  });
});

describe('negErrno / capMask / hasCapability', () => {
  test('negErrno 只接受正整数并返回负值', () => {
    assert.equal(negErrno(ERRNO.EACCES), -13);
    assert.equal(negErrno(1), -1);
    for (const bad of [0, -1, 1.5, '1', null, undefined, NaN, Infinity, 10n, {}]) {
      assert.throws(() => negErrno(bad), TypeError);
    }
    assert.throws(() => negErrno(0), /errnoCode must be positive integer, got 0/);
  });

  test('capMask 无参得 0n，重复位幂等，非整数拒绝', () => {
    assert.equal(capMask(), 0n);
    assert.equal(capMask(CAP.NET), CAP.NET);
    assert.equal(capMask(CAP.NET, CAP.NET), CAP.NET);
    assert.equal(capMask(CAP.NET, CAP.FS_READ), 6n);
    assert.throws(() => capMask(1.5), TypeError);
    assert.throws(() => capMask('IPC'), TypeError);
  });

  test('hasCapability 对 mask/capBit 两侧都做 toBigInt 收口，number 与 bigint 混用仍可比', () => {
    assert.equal(hasCapability(2, 2), true);
    assert.equal(hasCapability(2n, 2), true);
    assert.equal(hasCapability(2, 2n), true);
    assert.equal(hasCapability(CAP.NET, CAP.NET), true);
    assert.equal(hasCapability(CAP.NET, CAP.FS_READ), false);
    assert.equal(hasCapability(capMask(CAP.NET, CAP.SHM), CAP.SHM), true);
    assert.throws(() => hasCapability(null, CAP.NET), TypeError);
    assert.throws(() => hasCapability(CAP.NET, undefined), TypeError);
  });

  test('多位子集判定要求每一位都在：mask=0b0011 不含 0b0101', () => {
    assert.equal(hasCapability(0b0011n, 0b0101n), false);
    assert.equal(hasCapability(0b0111n, 0b0101n), true);
  });

  test('KNOWN-DEFECT: capBit 为 0 时恒判通过——未登记的能力位被当成已授予（fail-open）', () => {
    // m1Constants.js:109 `(m & c) === c` with c === 0n is satisfied by every mask, including
    // the empty one. A caller that resolves the required bit from an unregistered service id
    // (e.g. `CAP[name]` misspelled → undefined → coerced by toBigInt throws, but an explicit
    // 0 / 0n from a table default) gets an unconditional allow with no log line.
    assert.equal(hasCapability(0n, 0n), true, '零权限 mask 也放行');
    assert.equal(hasCapability(CAP.NET, 0n), true);
    assert.equal(hasCapability(-1n, 0n), true);
    // The same zero bit also passes through the composite helper, so nothing upstream flags it.
    assert.equal(hasCapability(capMask(), 0n), true);
  });

  test('KNOWN-DEFECT: 负数 mask 视作「全 1 补码」，任何能力位都算已授予', () => {
    // m1Constants.js:107 accepts any bigint including negatives because toBigInt does not
    // range-check, and bigint bitwise AND on a negative operand follows two's complement
    // with infinitely many leading 1s. A mask that underflows (e.g. revoke computed with a
    // subtraction) therefore silently upgrades to full capability instead of being rejected.
    assert.equal(hasCapability(-1n, CAP.IRQ_BIND), true);
    assert.equal(hasCapability(-1n, capMask(CAP.NET, CAP.FS_WRITE, CAP.SHM)), true);
    assert.equal(hasCapability(-2n, CAP.IPC), false, '只有最低位为 0 时才拦得住');
  });
});
