'use strict';

// 纯逻辑单测:零网络、零 mock。叶子 = src/services/tool/httpEncoding.js
const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');

const enc = require('../src/services/tool/httpEncoding');

// ── 请求侧:显式不协商压缩 ─────────────────────────────────────────────
test('withIdentityAcceptEncoding:补上 identity', () => {
  const out = enc.withIdentityAcceptEncoding({ Accept: 'text/html' });
  assert.equal(out['Accept-Encoding'], 'identity');
  assert.equal(out.Accept, 'text/html');
});

test('withIdentityAcceptEncoding:调用方已声明的值优先,不被覆盖(任意大小写)', () => {
  for (const key of ['Accept-Encoding', 'accept-encoding', 'ACCEPT-ENCODING']) {
    const out = enc.withIdentityAcceptEncoding({ [key]: 'gzip' });
    assert.equal(out[key], 'gzip', `调用方的值必须原样保留(来源 ${key})`);
    const keys = Object.keys(out).filter((k) => k.toLowerCase() === 'accept-encoding');
    assert.equal(keys.length, 1, `不得出现第二个 accept-encoding 键(来源 ${key})`);
    assert.equal(out[keys[0]], 'gzip', '唯一那个键的值必须是调用方声明的 gzip,而非 identity');
  }
});

test('withIdentityAcceptEncoding:返回新对象,不改入参;坏输入不抛', () => {
  const src = { A: '1' };
  const out = enc.withIdentityAcceptEncoding(src);
  assert.notStrictEqual(out, src);
  assert.equal(src['Accept-Encoding'], undefined, '入参不得被修改');
  for (const bad of [null, undefined, 'x', 42]) {
    assert.equal(enc.withIdentityAcceptEncoding(bad)['Accept-Encoding'], 'identity');
  }
});

test('IDENTITY 常量就是 identity(测试与实现同源)', () => {
  assert.equal(enc.IDENTITY, 'identity');
});

// ── normalizeEncoding / isCompressed ────────────────────────────────────
test('normalizeEncoding:identity/空 → ""(视为不压缩)', () => {
  for (const v of ['', '   ', undefined, null, 'identity', 'IDENTITY']) {
    assert.equal(enc.normalizeEncoding(v), '');
  }
});

test('normalizeEncoding:多段取最后一段(解码顺序为逆序)', () => {
  assert.equal(enc.normalizeEncoding('gzip, br'), 'br');
  assert.equal(enc.normalizeEncoding(' GZIP '), 'gzip');
});

test('isCompressed:只认会真正改变字节的编码', () => {
  for (const v of ['gzip', 'x-gzip', 'deflate', 'br', 'zlib']) {
    assert.equal(enc.isCompressed(v), true, `${v} 应判为已压缩`);
  }
  for (const v of ['identity', '', undefined, 'zstd', 'compress']) {
    assert.equal(enc.isCompressed(v), false, `${v} 不应判为已压缩`);
  }
});

// ── 响应侧:解压 ────────────────────────────────────────────────────────
const TEXT = 'hello 新闻 <html>正文</html>';

test('decodeBody:gzip 往返正确(不再产生乱码)', () => {
  assert.equal(enc.decodeBody(zlib.gzipSync(Buffer.from(TEXT)), 'gzip').toString('utf8'), TEXT);
  assert.equal(enc.decodeBody(zlib.gzipSync(Buffer.from(TEXT)), 'x-gzip').toString('utf8'), TEXT);
});

test('decodeBody:brotli 往返正确', () => {
  assert.equal(enc.decodeBody(zlib.brotliCompressSync(Buffer.from(TEXT)), 'br').toString('utf8'), TEXT);
});

test('decodeBody:deflate 两种形态都解(zlib 包装 + 裸 deflate)', () => {
  assert.equal(enc.decodeBody(zlib.deflateSync(Buffer.from(TEXT)), 'deflate').toString('utf8'), TEXT);
  assert.equal(
    enc.decodeBody(zlib.deflateRawSync(Buffer.from(TEXT)), 'deflate').toString('utf8'),
    TEXT
  );
});

test('decodeBody:identity / 未知编码 → 原样返回(不臆测)', () => {
  const buf = Buffer.from(TEXT);
  assert.equal(enc.decodeBody(buf, 'identity').toString('utf8'), TEXT);
  assert.equal(enc.decodeBody(buf, undefined).toString('utf8'), TEXT);
  assert.equal(enc.decodeBody(buf, 'zstd').toString('utf8'), TEXT);
});

test('decodeBody:标了 gzip 但不是 gzip → 原样返回,绝不抛、绝不丢数据', () => {
  assert.equal(enc.decodeBody(Buffer.from('not-gzip'), 'gzip').toString('utf8'), 'not-gzip');
});

test('decodeBody:空体 / 坏输入 fail-soft', () => {
  assert.equal(enc.decodeBody(Buffer.alloc(0), 'gzip').length, 0);
  assert.equal(enc.decodeBody(null, 'gzip').length, 0);
  assert.equal(enc.decodeBody(undefined, 'gzip').length, 0);
  assert.equal(typeof enc.decodeBody('plain string', 'identity').toString, 'function');
});

// ── 接线:WebFetchTool 在 charset 解码前先解压 ───────────────────────────
test('WebFetchTool._decodeBody:gzip 体 + 第三参 content-encoding → 正确正文', () => {
  const tool = require('../src/tools/WebFetchTool/index');
  const gz = zlib.gzipSync(Buffer.from('<html><body>新闻正文</body></html>'));
  const out = tool._decodeBody(gz, 'text/html; charset=utf-8', 'gzip');
  assert.equal(out, '<html><body>新闻正文</body></html>');
});

test('WebFetchTool._decodeBody:两参调用(旧签名)行为不变', () => {
  const tool = require('../src/tools/WebFetchTool/index');
  const out = tool._decodeBody(Buffer.from('<html>ok</html>'), 'text/html; charset=utf-8');
  assert.equal(out, '<html>ok</html>');
});

// ── 接线:搜索专用引擎请求头 + 响应体 ───────────────────────────────────
test('webSearchService._engineHeaders:引擎请求显式不协商压缩', () => {
  const svc = require('../src/services/webSearchService');
  const h = svc.__parsersForTests.engineHeaders({ Accept: 'text/html', 'User-Agent': 'ua' });
  assert.equal(h['Accept-Encoding'], 'identity');
  assert.equal(h.Accept, 'text/html');
});

test('webSearchService._readBody:gzip 响应被解开后才交给解析器', async () => {
  const svc = require('../src/services/webSearchService');
  const readBody = svc.__parsersForTests.readBody;
  const html = '<html><body>搜索结果</body></html>';

  // 用最小假响应对象驱动:只需要 on/data/end/destroy/headers。
  const fakeRes = () => {
    const handlers = {};
    return {
      headers: { 'content-encoding': 'gzip' },
      on(ev, fn) {
        handlers[ev] = fn;
        return this;
      },
      destroy() {
        handlers.destroyed = true;
      },
      fire() {
        handlers.data(zlib.gzipSync(Buffer.from(html)));
        handlers.end();
      },
    };
  };

  const res = fakeRes();
  const got = await new Promise((resolve) => {
    readBody(res, 2 * 1024 * 1024, resolve);
    res.fire();
  });
  assert.equal(got, html, '必须是解压后的 HTML —— 否则解析器只会拿到二进制乱码');
});

test('webSearchService._readBody:未压缩响应原样通过', async () => {
  const svc = require('../src/services/webSearchService');
  const readBody = svc.__parsersForTests.readBody;
  const html = '<html>plain</html>';
  const handlers = {};
  const res = {
    headers: {},
    on(ev, fn) {
      handlers[ev] = fn;
      return this;
    },
    destroy() {},
  };
  const got = await new Promise((resolve) => {
    readBody(res, 2 * 1024 * 1024, resolve);
    handlers.data(Buffer.from(html));
    handlers.end();
  });
  assert.equal(got, html);
});
