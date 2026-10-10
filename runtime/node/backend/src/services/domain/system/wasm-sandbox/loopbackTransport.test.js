'use strict';

// Co-located contract tests for loopbackTransport.js (C-4, [RESEARCH-018] §2.3).
// This is the in-process M1 router/transport pair used behind the wasm sandbox: a builtin
// router (fake NET/WM answers + a real FS router confined to fsRoot) and a loopback transport
// that speaks IPC frames. Filesystem work happens only inside os.tmpdir()/khy-b45f-* -- never
// inside the repository -- and no socket or child process is used.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mod = require('./loopbackTransport');
const { createHeader, encodeFrame, decodeFrame } = require('./ipcCodec');
const { ERRNO, IPC, METHOD, SERVICE, negErrno } = require('./m1Constants');

const { createBuiltinRouter, createLoopbackTransport } = mod;

let root;
let tmpDirs = [];

function mkreq(serviceId, methodId, payload, requestId = 11n) {
  const body = typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
  return encodeFrame({
    header: createHeader({ msgType: IPC.MSG_TYPE.REQUEST, serviceId, methodId, requestId }),
    payload: body,
  });
}

function readFrame(frame) {
  const d = decodeFrame(frame);
  return {
    msgType: d.header.msgType,
    status: d.header.status,
    requestId: d.header.requestId,
    serviceId: d.header.serviceId,
    methodId: d.header.methodId,
    body: d.payload.length ? JSON.parse(d.payload.toString('utf-8')) : null,
  };
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-b45f-'));
  tmpDirs.push(root);
  fs.writeFileSync(path.join(root, 'hello.txt'), 'content-here', 'utf-8');
  fs.mkdirSync(path.join(root, 'sub'));
});

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('模块面与构造', () => {
  test('导出恰为两个工厂，工厂产物面各自固定', () => {
    assert.deepEqual(Object.keys(mod), ['createBuiltinRouter', 'createLoopbackTransport']);
    assert.deepEqual(Object.keys(createBuiltinRouter()), ['route']);
    assert.deepEqual(Object.keys(createLoopbackTransport()), ['call', 'callSync', 'router']);
    assert.equal(typeof createLoopbackTransport().call, 'function');
  });

  test('不传任何选项时 FS 一律 EPERM，因为 fsRoot 未配置', () => {
    const router = createBuiltinRouter();
    for (const methodId of [METHOD.FS.READ_FILE, METHOD.FS.STAT]) {
      const r = router.route({ serviceId: SERVICE.FS, methodId, payload: { path: 'hello.txt' } });
      assert.equal(r.status, negErrno(ERRNO.EPERM), `method ${methodId}`);
      assert.deepEqual(r.body, { error: 'fsRoot is not configured' });
    }
  });

  test('fsRoot 的 falsy 值等于未配置，传了 router 时其余选项被忽略', () => {
    for (const bad of [0, '', null, undefined, false]) {
      assert.equal(createBuiltinRouter({ fsRoot: bad }).route({ serviceId: SERVICE.FS, methodId: METHOD.FS.READ_FILE, payload: { path: 'a' } }).status, negErrno(ERRNO.EPERM), `fsRoot ${String(bad)}`);
    }
    const transport = createLoopbackTransport({ router: { route: () => ({ status: 0, body: { custom: true } }) }, fsRoot: root });
    assert.deepEqual(readFrame(transport.callSync(mkreq(SERVICE.FS, METHOD.FS.READ_FILE, { path: 'hello.txt' }))).body, { custom: true }, '自带 router 时 fsRoot 不再参与');
  });
});

describe('内置路由：NET/WM 假应答', () => {
  test('HTTP_GET 走确定性伪随机温度，同城同值且落在 15~32 区间', () => {
    const router = createBuiltinRouter({ now: () => 'FIXED' });
    const a = router.route({ serviceId: SERVICE.NET, methodId: METHOD.NET.HTTP_GET, payload: { city: 'berlin' } });
    const b = router.route({ serviceId: SERVICE.NET, methodId: METHOD.NET.HTTP_GET, payload: { city: 'berlin' } });
    assert.equal(a.status, 0);
    assert.deepEqual(a.body, { provider: 'loopback-netd', city: 'berlin', temperatureC: 18.5, condition: 'partly-cloudy', at: 'FIXED' });
    assert.equal(b.body.temperatureC, a.body.temperatureC);
    for (const city of ['', 'x', '北京', 'unknown', 'rome']) {
      const t = router.route({ serviceId: SERVICE.NET, methodId: METHOD.NET.HTTP_GET, payload: { city } }).body.temperatureC;
      assert.ok(t >= 15 && t <= 32, `${city || 'empty'} => ${t} 越界`);
    }
  });

  test('KNOWN-DEFECT: city/q 与 text/host 的取值用 || 兜底，0 与空串被静默换成默认', () => {
    // loopbackTransport.js:70,84,151 use `payload.city || payload.q || 'unknown'` and
    // `String(payload.text || '')`. Falsy-but-meaningful values (0, empty string) collapse into
    // the default, so a guest asking for city 0 is answered as if it had asked for 'unknown'.
    const router = createBuiltinRouter({ now: () => 'FIXED' });
    const zero = router.route({ serviceId: SERVICE.NET, methodId: METHOD.NET.HTTP_GET, payload: { city: 0 } });
    const unknown = router.route({ serviceId: SERVICE.NET, methodId: METHOD.NET.HTTP_GET, payload: {} });
    assert.equal(zero.body.city, 'unknown');
    assert.deepEqual(zero.body, unknown.body, 'city=0 与完全没传 city 无法区分');
    const dnsZero = router.route({ serviceId: SERVICE.NET, methodId: METHOD.NET.DNS_RESOLVE, payload: { host: 0 } });
    assert.equal(dnsZero.body.host, 'localhost');
    const textZero = router.route({ serviceId: SERVICE.WM, methodId: METHOD.WM.PRESENT_TEXT, payload: { text: 0 } });
    assert.deepEqual(textZero.body, { provider: 'loopback-wmd', displayed: '' }, 'text=0 被吞成空串');
  });

  test('KNOWN-DEFECT: BLIT_RGBA 的宽高用 Number(x||0)，非数字变 NaN 后在线路上塌成 null', () => {
    // loopbackTransport.js:162-163 `Number(payload.width || 0)`. 'abc' becomes NaN, and the
    // JSON.stringify at line 18 turns NaN into null, so the guest cannot tell "no width" from
    // "garbage width". A negative width passes straight through unvalidated.
    const router = createBuiltinRouter();
    const ok = router.route({ serviceId: SERVICE.WM, methodId: METHOD.WM.BLIT_RGBA, payload: { width: 10, height: '20' } });
    assert.deepEqual(ok.body, { provider: 'loopback-wmd', blitted: true, width: 10, height: 20 });
    const garbage = router.route({ serviceId: SERVICE.WM, methodId: METHOD.WM.BLIT_RGBA, payload: { width: 'abc', height: -3 } });
    assert.equal(Number.isNaN(garbage.body.width), true, '路由内部确实是 NaN');
    const transport = createLoopbackTransport({ router });
    const onWire = readFrame(transport.callSync(mkreq(SERVICE.WM, METHOD.WM.BLIT_RGBA, { width: 'abc', height: -3 })));
    assert.equal(onWire.status, 0, '尺寸垃圾仍算成功');
    assert.equal(onWire.body.width, null, 'NaN 经 JSON 序列化变成 null');
    assert.equal(onWire.body.height, -3);
  });

  test('DNS_RESOLVE 恒定回环地址，不触碰真实网络', () => {
    const router = createBuiltinRouter();
    const r = router.route({ serviceId: SERVICE.NET, methodId: METHOD.NET.DNS_RESOLVE, payload: { host: 'example.invalid' } });
    assert.deepEqual(r.body, { provider: 'loopback-netd', host: 'example.invalid', addresses: ['127.0.0.1'], ttl: 60 });
    const domain = router.route({ serviceId: SERVICE.NET, methodId: METHOD.NET.DNS_RESOLVE, payload: { domain: 'alt' } });
    assert.equal(domain.body.host, 'alt', 'domain 是 host 的备选键');
  });

  test('未登记的服务/方法回落 ENOSYS，并把两个 ID 回写进 body', () => {
    const router = createBuiltinRouter();
    const r = router.route({ serviceId: 99, methodId: 7, payload: {} });
    assert.equal(r.status, negErrno(ERRNO.ENOSYS));
    assert.deepEqual(r.body, { error: 'service/method not implemented', serviceId: 99, methodId: 7 });
    const empty = router.route({});
    assert.equal(empty.status, negErrno(ERRNO.ENOSYS), '缺参路由也走 ENOSYS');
    assert.deepEqual(JSON.parse(JSON.stringify(empty.body)), { error: 'service/method not implemented' }, 'undefined 的 ID 经序列化被 JSON 丢键');
  });

  test('now 传入非函数时静默用真实时钟而不是报错', () => {
    const router = createBuiltinRouter({ now: 'clock' });
    const at = router.route({ serviceId: SERVICE.NET, methodId: METHOD.NET.HTTP_GET, payload: { city: 'a' } }).body.at;
    assert.match(String(at), /^\d{4}-\d{2}-\d{2}T/, `拿到的是真实 ISO 时间而不是报错：${String(at)}`);
  });
});

describe('内置路由：FS 与 fsRoot 约束', () => {
  test('READ_FILE 在根内正常读取，返回的 path 原样回显请求', () => {
    const router = createBuiltinRouter({ fsRoot: root });
    const r = router.route({ serviceId: SERVICE.FS, methodId: METHOD.FS.READ_FILE, payload: { path: 'hello.txt' } });
    assert.deepEqual(r, { status: 0, body: { path: 'hello.txt', content: 'content-here' } });
    const nested = router.route({ serviceId: SERVICE.FS, methodId: METHOD.FS.READ_FILE, payload: { path: './hello.txt' } });
    assert.equal(nested.status, 0, './ 前缀仍落在根内');
  });

  test('READ_FILE 的空 path 走 EINVAL，包括 0 这种假值', () => {
    const router = createBuiltinRouter({ fsRoot: root });
    for (const bad of [undefined, null, '', 0, false, NaN]) {
      const r = router.route({ serviceId: SERVICE.FS, methodId: METHOD.FS.READ_FILE, payload: { path: bad } });
      assert.equal(r.status, negErrno(ERRNO.EINVAL), `path ${String(bad)}`);
      assert.deepEqual(r.body, { error: 'path is required' });
    }
  });

  test('目录穿越与绝对路径逃逸都被 fsRoot 拦在门外', () => {
    const router = createBuiltinRouter({ fsRoot: root });
    for (const bad of ['../../etc/passwd', '..', path.join(os.tmpdir(), '..', 'windows', 'win.ini'), path.resolve(root, '..', 'outside.txt'), '/etc/hosts']) {
      const r = router.route({ serviceId: SERVICE.FS, methodId: METHOD.FS.READ_FILE, payload: { path: bad } });
      assert.notEqual(r.status, 0, `${bad} 竟被放行`);
      assert.equal(r.status, negErrno(ERRNO.EIO), `${bad} 的错误码`);
    }
  });

  test('KNOWN-DEFECT: fsRoot 逃逸被归类成 EIO，与真实磁盘故障同码', () => {
    // loopbackTransport.js:104-113: _safeResolveUnderRoot throws a bare Error with no `code`,
    // so the catch falls to the EIO branch instead of EACCES/EPERM. An auditor reading the
    // errno cannot distinguish "guest tried to escape the sandbox" from "disk failure", and the
    // escape attempt's own message becomes the body text.
    const router = createBuiltinRouter({ fsRoot: root });
    const escape = router.route({ serviceId: SERVICE.FS, methodId: METHOD.FS.READ_FILE, payload: { path: '../secret.txt' } });
    assert.equal(escape.status, negErrno(ERRNO.EIO));
    assert.deepEqual(escape.body, { error: 'path escapes fsRoot' });
    const missing = router.route({ serviceId: SERVICE.FS, methodId: METHOD.FS.READ_FILE, payload: { path: 'nope.txt' } });
    assert.equal(missing.status, negErrno(ERRNO.ENOENT), '真·文件不存在走的是 ENOENT');
    const dir = router.route({ serviceId: SERVICE.FS, methodId: METHOD.FS.READ_FILE, payload: { path: 'sub' } });
    assert.equal(dir.status, negErrno(ERRNO.EIO));
    assert.equal(dir.body.error.startsWith('EISDIR'), true, '读目录的原始 fs 文案直接透给 guest');
  });

  test('STAT 把"不存在"报成 status 0 + exists:false，与 READ_FILE 的 ENOENT 不一致', () => {
    // loopbackTransport.js:139-141 vs 109-110: the same fact (no such file) yields -2 from
    // READ_FILE and a success frame from STAT. A guest that only maps status to errno treats a
    // missing file as a successful stat.
    const router = createBuiltinRouter({ fsRoot: root });
    const read = router.route({ serviceId: SERVICE.FS, methodId: METHOD.FS.READ_FILE, payload: { path: 'gone' } });
    const stat = router.route({ serviceId: SERVICE.FS, methodId: METHOD.FS.STAT, payload: { path: 'gone' } });
    assert.equal(read.status, negErrno(ERRNO.ENOENT));
    assert.equal(stat.status, 0);
    assert.deepEqual(stat.body, { path: 'gone', exists: false });
    const hit = router.route({ serviceId: SERVICE.FS, methodId: METHOD.FS.STAT, payload: { path: 'hello.txt' } });
    assert.equal(hit.status, 0);
    assert.equal(hit.body.exists, true);
    assert.equal(hit.body.isFile, true);
    assert.equal(hit.body.isDirectory, false);
    assert.equal(hit.body.size, fs.statSync(path.join(root, 'hello.txt')).size);
    const dir = router.route({ serviceId: SERVICE.FS, methodId: METHOD.FS.STAT, payload: { path: 'sub' } });
    assert.equal(dir.body.isDirectory, true);
    assert.equal(dir.body.isFile, false);
  });

  test('STAT 的越界与空路径分支和 READ_FILE 同码', () => {
    const router = createBuiltinRouter({ fsRoot: root });
    assert.deepEqual(router.route({ serviceId: SERVICE.FS, methodId: METHOD.FS.STAT, payload: {} }), { status: negErrno(ERRNO.EINVAL), body: { error: 'path is required' } });
    assert.deepEqual(router.route({ serviceId: SERVICE.FS, methodId: METHOD.FS.STAT, payload: { path: '../x' } }), { status: negErrno(ERRNO.EIO), body: { error: 'path escapes fsRoot' } });
  });
});

describe('自定义 handlers 的接管与回落', () => {
  test('精确 "service:method" 键的处理器接管内建实现，payload/meta 原样透传', () => {
    const seen = [];
    const router = createBuiltinRouter({
      fsRoot: root,
      handlers: {
        [`${SERVICE.FS}:${METHOD.FS.READ_FILE}`]: (payload, meta) => {
          seen.push({ payload, meta });
          return { status: 0, body: { overridden: true, payload } };
        },
      },
    });
    const r = router.route({ serviceId: SERVICE.FS, methodId: METHOD.FS.READ_FILE, payload: { path: 'hello.txt' }, meta: { trace: 'x' } });
    assert.deepEqual(r.body, { overridden: true, payload: { path: 'hello.txt' } }, '内建的真实读盘没有发生');
    assert.deepEqual(seen, [{ payload: { path: 'hello.txt' }, meta: { trace: 'x' } }]);
  });

  test('KNOWN-DEFECT: handlers 里 falsy 的覆盖值被静默忽略，请求退回内建实现', () => {
    // loopbackTransport.js:56-60 `if (exact) return exact;` -- a registered handler whose value
    // is falsy (0, '', null, NaN) is not treated as a misconfiguration but dropped, so the
    // builtin FS reader runs instead. Truthy-but-not-a-function values are kept and crash later.
    const router = createBuiltinRouter({
      fsRoot: root,
      handlers: { '1:1': 0, '2:1': null, '3:1': '', '1:2': undefined },
    });
    assert.deepEqual(router.route({ serviceId: SERVICE.FS, methodId: METHOD.FS.READ_FILE, payload: { path: 'hello.txt' } }).body,
      { path: 'hello.txt', content: 'content-here' }, '声明了覆盖却被内建读盘顶替');
    assert.equal(router.route({ serviceId: SERVICE.NET, methodId: METHOD.NET.HTTP_GET, payload: { city: 'a' } }).body.provider, 'loopback-netd');
    const crash = createBuiltinRouter({ handlers: { '1:1': 'not-a-function' } });
    assert.throws(() => crash.route({ serviceId: SERVICE.FS, methodId: 1, payload: {} }), TypeError, /handler is not a function/);
  });

  test('handler 键只按字符串拼接匹配，原型键名拼不进去', () => {
    const router = createBuiltinRouter({ handlers: {} });
    assert.equal(router.route({ serviceId: 'constructor', methodId: 1, payload: {} }).status, negErrno(ERRNO.ENOSYS));
    assert.equal(({}).polluted, undefined);
    // 计算键写法让 __proto__ 成为**自身属性**（字面量 `__proto__:` 会改原型，污染全局）。
    const injected = { ['__proto__']: { '7:7': () => ({ status: 0, body: { evil: true } }) } };
    const polluted = createBuiltinRouter({ handlers: injected });
    assert.equal(polluted.route({ serviceId: 7, methodId: 7, payload: {} }).status, negErrno(ERRNO.ENOSYS), '__proto__ 写入不构成可用 handler');
  });
});

describe('loopback 传输层：帧进出', () => {
  test('REQUEST 进、RESPONSE 出，requestId/serviceId/methodId 逐项回显', () => {
    const transport = createLoopbackTransport({ fsRoot: root });
    const res = readFrame(transport.callSync(mkreq(SERVICE.FS, METHOD.FS.READ_FILE, { path: 'hello.txt' }, 777n)));
    assert.equal(res.msgType, IPC.MSG_TYPE.RESPONSE);
    assert.equal(res.status, 0);
    assert.equal(res.requestId, 777n);
    assert.equal(res.serviceId, SERVICE.FS);
    assert.equal(res.methodId, METHOD.FS.READ_FILE);
    assert.deepEqual(res.body, { path: 'hello.txt', content: 'content-here' });
  });

  test('负 status 编成 ERROR 帧，非负编成 RESPONSE 帧', () => {
    const transport = createLoopbackTransport();
    const res = readFrame(transport.callSync(mkreq(SERVICE.FS, METHOD.FS.READ_FILE, { path: 'x' })));
    assert.equal(res.msgType, IPC.MSG_TYPE.ERROR);
    assert.equal(res.status, negErrno(ERRNO.EPERM));
    const zero = readFrame(createLoopbackTransport({ router: { route: () => ({ status: 0, body: {} }) } }).callSync(mkreq(9, 9, {})));
    assert.equal(zero.msgType, IPC.MSG_TYPE.RESPONSE);
  });

  test('非 REQUEST 帧一律拒绝，call 侧是 reject 而不是错误帧', async () => {
    const transport = createLoopbackTransport({ fsRoot: root });
    const respFrame = encodeFrame({ header: createHeader({ msgType: IPC.MSG_TYPE.RESPONSE, requestId: 1n, serviceId: 2, methodId: 1 }), payload: '{}' });
    assert.throws(() => transport.callSync(respFrame), /loopback transport expects REQUEST frame, got msgType=2/);
    await assert.rejects(() => transport.call(respFrame), /got msgType=2/);
    assert.throws(() => transport.callSync('nope'), /frame too short: 4/);
    await assert.rejects(() => transport.call(mkreq(SERVICE.NET, 1, {}).subarray(0, 20)), /frame too short: 20/);
  });

  test('载荷不是合法 JSON 时回 EINVAL 错误帧并带解析器原文', () => {
    const transport = createLoopbackTransport({ fsRoot: root });
    const res = readFrame(transport.callSync(mkreq(SERVICE.NET, METHOD.NET.HTTP_GET, '{oops')));
    assert.equal(res.msgType, IPC.MSG_TYPE.ERROR);
    assert.equal(res.status, negErrno(ERRNO.EINVAL));
    assert.equal(res.body.error, 'invalid JSON payload');
    assert.match(res.body.detail, /Expected property name or '\}' in JSON at position 1/);
  });

  test('空载荷与 JSON 标量载荷都按 {}/原值交给路由', () => {
    const transport = createLoopbackTransport({ fsRoot: root });
    assert.deepEqual(readFrame(transport.callSync(mkreq(SERVICE.NET, METHOD.NET.DNS_RESOLVE, ''))).body.host, 'localhost', '零字节载荷 => {}');
    assert.deepEqual(readFrame(transport.callSync(mkreq(SERVICE.NET, METHOD.NET.DNS_RESOLVE, Buffer.alloc(0)))).body.addresses, ['127.0.0.1']);
    assert.equal(readFrame(transport.callSync(mkreq(SERVICE.NET, METHOD.NET.HTTP_GET, '5'))).body.city, 'unknown', '数字载荷取属性得 undefined');
    assert.equal(readFrame(transport.callSync(mkreq(SERVICE.WM, METHOD.WM.PRESENT_TEXT, '"city"'))).body.displayed, '');
    assert.deepEqual(readFrame(transport.callSync(mkreq(SERVICE.WM, METHOD.WM.PRESENT_TEXT, '[1,2]'))).body, { provider: 'loopback-wmd', displayed: '' });
  });

  test('响应里的 __proto__ 载荷键不会污染 Object.prototype', () => {
    const transport = createLoopbackTransport({ fsRoot: root });
    const res = readFrame(transport.callSync(mkreq(SERVICE.NET, METHOD.NET.DNS_RESOLVE, '{"__proto__":{"polluted":true},"host":"h"}')));
    assert.equal(res.body.host, 'h');
    assert.equal({}.polluted, undefined);
  });

  test('meta 原样转发给路由，缺省为空对象', () => {
    const seen = [];
    const transport = createLoopbackTransport({ router: { route: (args) => { seen.push(args); return { status: 0, body: {} }; } } });
    transport.callSync(mkreq(1, 1, {}));
    transport.callSync(mkreq(1, 1, {}), { requestId: 5n, from: 'host' });
    assert.deepEqual(seen[0].meta, {});
    assert.deepEqual(Object.keys(seen[0]), ['serviceId', 'methodId', 'payload', 'meta']);
    assert.equal(seen[1].meta.from, 'host');
    assert.equal(seen[1].meta.requestId, 5n);
  });
});

describe('KNOWN-DEFECT 族：异步与同步两副面孔', () => {
  test('KNOWN-DEFECT: callSync 对处理器异常零隔离，同一处理器在 call 下得到 EIO 错误帧', () => {
    // loopbackTransport.js:235 calls router.route outside any try/catch, while the async call()
    // wraps the same invocation at lines 201-213 and converts a throwing handler into an EIO
    // ERROR frame. A guest that drives the sync path (khy_sys) therefore gets raw exceptions
    // out of the transport instead of a protocol-level answer.
    const transport = createLoopbackTransport({
      router: {
        route: ({ methodId }) => {
          if (methodId === 6) throw new Error('handler exploded');
          return { status: 0, body: {} };
        },
      },
    });
    assert.throws(() => transport.callSync(mkreq(7, 6, {})), /handler exploded/);
    return transport.call(mkreq(7, 6, {})).then((frame) => {
      const res = readFrame(frame);
      assert.equal(res.status, negErrno(ERRNO.EIO));
      assert.deepEqual(res.body, { error: 'loopback handler failed', detail: 'handler exploded' });
    });
  });

  test('KNOWN-DEFECT: 路由返回 null 或 undefined 都被当成 status 0 的成功空应答', () => {
    // loopbackTransport.js:215,246 `Number.isInteger(result?.status) ? result.status : 0` plus
    // line 216/247 `result?.body || {}`: a handler that forgets to return anything -- or returns
    // null -- is reported to the guest as a successful, empty RESPONSE frame.
    for (const value of [undefined, null, 0, '', false, NaN, 'nope', 5]) {
      const transport = createLoopbackTransport({ router: { route: () => value } });
      const res = readFrame(transport.callSync(mkreq(2, 1, {})));
      assert.equal(res.status, 0, `route => ${String(value)} 仍算成功`);
      assert.equal(res.msgType, IPC.MSG_TYPE.RESPONSE);
      assert.deepEqual(res.body, {});
    }
  });

  test('KNOWN-DEFECT: 负数/字符串状态被静默改写成 0，错误答案以成功帧上线', () => {
    // loopbackTransport.js:215/246: any non-integer status becomes 0, so -13.5 (a plausible
    // truncated errno) and '0' both turn into a success frame. The wrong status is what the
    // caller persists, and ok=true is computed from it upstream.
    const transport = createLoopbackTransport({
      router: {
        route: ({ methodId }) => {
          if (methodId === 1) return { status: '0', body: { coerced: true } };
          if (methodId === 2) return { status: -13.5, body: { denied: true } };
          if (methodId === 3) return { status: -0.5, body: { denied: true } };
          return { status: 0, body: {} };
        },
      },
    });
    assert.equal(readFrame(transport.callSync(mkreq(7, 1, {}))).status, 0);
    const neg = readFrame(transport.callSync(mkreq(7, 2, {})));
    assert.equal(neg.status, 0, '-13.5 被抹平成 0');
    assert.equal(neg.msgType, IPC.MSG_TYPE.RESPONSE, '而且帧类型也变成 RESPONSE');
    assert.deepEqual(neg.body, { denied: true });
    assert.equal(readFrame(transport.callSync(mkreq(7, 3, {}))).status, 0);
    // a genuine integer errno still survives
    assert.equal(readFrame(transport.callSync(mkreq(7, 4, {}))).status, 0);
  });

  test('KNOWN-DEFECT: 应答编码阶段的 RangeError 绕过兜底，call 与 callSync 一起炸', () => {
    // loopbackTransport.js:216/247 build the response frame outside the try/catch that guards
    // route(). A handler returning an out-of-int32 status or a >64 KiB body therefore crashes
    // the transport instead of being reported as an error frame, on both entry points.
    const transport = createLoopbackTransport({
      router: {
        route: ({ methodId }) => {
          if (methodId === 1) return { status: 2 ** 40, body: {} };
          if (methodId === 2) return { status: 0, body: { huge: 'x'.repeat(70000) } };
          if (methodId === 3) return { status: (-(2 ** 31)) - 1, body: {} };
          return { status: 0, body: {} };
        },
      },
    });
    assert.throws(() => transport.callSync(mkreq(7, 1, {})), RangeError);
    assert.throws(() => transport.callSync(mkreq(7, 2, {})), /payload exceeds M1 max 65536 bytes/);
    assert.throws(() => transport.callSync(mkreq(7, 3, {})), /status out of range/);
    return Promise.all([
      assert.rejects(() => transport.call(mkreq(7, 1, {})), RangeError),
      assert.rejects(() => transport.call(mkreq(7, 2, {})), /payload exceeds/),
      assert.rejects(() => transport.call(mkreq(7, 3, {})), /status out of range/),
    ]);
  });

  test('KNOWN-DEFECT: callSync 的"必须是同步处理器"检查跑在处理器已经执行之后', () => {
    // loopbackTransport.js:235 awaits nothing and calls route() first; the thenable check is at
    // line 242. By the time the transport refuses to continue, the async handler has already run
    // and its side effects are committed, even though the caller gets an exception.
    let sideEffects = 0;
    const transport = createLoopbackTransport({
      router: {
        route: () => {
          sideEffects += 1;
          return Promise.resolve({ status: 0, body: { async: 1 } });
        },
      },
    });
    assert.throws(() => transport.callSync(mkreq(7, 1, {})), /loopback callSync requires sync route handlers/);
    assert.equal(sideEffects, 1, '副作用已经发生了一次');
    return transport.call(mkreq(7, 1, {})).then((frame) => {
      assert.deepEqual(readFrame(frame).body, { async: 1 }, '同一路由在 call 下是正常应答');
      assert.equal(sideEffects, 2);
    });
  });

  test('KNOWN-DEFECT: router 缺 route 方法要到调用时才炸，构造期不校验形状', () => {
    // loopbackTransport.js:182 takes options.router as-is. With call() the missing method is
    // swallowed into an EIO frame (line 201-213), so a misconfigured sandbox answers requests
    // forever instead of failing at startup; with callSync it is a raw TypeError.
    const transport = createLoopbackTransport({ router: {} });
    assert.throws(() => transport.callSync(mkreq(1, 1, {})), TypeError, /router\.route is not a function/);
    return transport.call(mkreq(1, 1, {})).then((frame) => {
      const res = readFrame(frame);
      assert.equal(res.status, negErrno(ERRNO.EIO));
      assert.match(res.body.detail, /router\.route is not a function/);
    });
  });
});

function require0() {
  return null;
}
