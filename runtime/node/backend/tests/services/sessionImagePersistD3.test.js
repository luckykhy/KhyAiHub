'use strict';

/**
 * [DESIGN-ARCH-163] D3 会话图片引用化持久 —— 写侧 content-addressed image_ref +
 * 读侧 buildConversationChain 回解析/诚实降级。node:test。
 * KHY_DATA_HOME 在 require 业务模块前钉到临时目录，图片库与会话 JSONL 全部落盘于此。
 */

process.env.KHY_DATA_HOME = require('path').join(require('os').tmpdir(), 'khy-d3-image-persist-home');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const sp = require('../../src/services/sessionPersistence');

function pngBytes(seed) {
  // 任意确定性字节即可——D3 不解析图像格式，只看 base64 字节。
  const buf = Buffer.alloc(200);
  for (let i = 0; i < buf.length; i += 1) buf[i] = (seed * 31 + i * 7) & 0xff;
  return buf;
}

function sha16(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function anthropicImageBlock(buf) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') } };
}

function readLine(sessionId) {
  const file = sp.jsonlPathFor(sessionId);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test('D3-1 string content 逐字节不变(不触引用化)', () => {
  const id = `d3-str-${Date.now()}`;
  sp.appendMessage(id, { role: 'user', content: '纯文本消息' });
  const entry = readLine(id);
  assert.strictEqual(entry.content, '纯文本消息');
});

test('D3-2 anthropic 图像块 → image_ref + 字节落 images/<sha16>.png，行内无 base64', () => {
  const buf = pngBytes(1);
  const id = `d3-ref-${Date.now()}`;
  sp.appendMessage(id, {
    role: 'user',
    content: [{ type: 'text', text: '看这张图' }, anthropicImageBlock(buf)],
  });
  const raw = fs.readFileSync(sp.jsonlPathFor(id), 'utf8');
  assert.ok(!raw.includes(buf.toString('base64')), 'base64 不得再进 transcript');
  const entry = readLine(id);
  const ref = entry.content[1];
  assert.strictEqual(ref.type, 'image_ref');
  assert.strictEqual(ref.sha16, sha16(buf));
  assert.strictEqual(ref.bytes, buf.length);
  assert.strictEqual(ref.stored, true);
  const onDisk = fs.readFileSync(path.join(sp._imagesDir(), ref.path));
  assert.deepStrictEqual(onDisk, buf);
  assert.deepStrictEqual(entry.content[0], { type: 'text', text: '看这张图' });
});

test('D3-3 openai image_url data-URL 同样引用化', () => {
  const buf = pngBytes(2);
  const id = `d3-durl-${Date.now()}`;
  sp.appendMessage(id, {
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${buf.toString('base64')}`, detail: 'auto' } }],
  });
  const ref = readLine(id).content[0];
  assert.strictEqual(ref.type, 'image_ref');
  assert.strictEqual(ref.sha16, sha16(buf));
});

test('D3-4 内容寻址去重：同字节两次落盘只有一份文件', () => {
  const buf = Buffer.concat([pngBytes(3), Buffer.from(`unique-${Date.now()}-${Math.random()}`)]);
  const before = fs.readdirSync(sp._imagesDir()).filter((f) => f.startsWith(sha16(buf))).length;
  sp.appendMessage(`d3-dup-a-${Date.now()}`, { role: 'user', content: [anthropicImageBlock(buf)] });
  sp.appendMessage(`d3-dup-b-${Date.now()}`, { role: 'user', content: [anthropicImageBlock(buf)] });
  const after = fs.readdirSync(sp._imagesDir()).filter((f) => f.startsWith(sha16(buf))).length;
  assert.strictEqual(after, before + 1);
});

test('D3-5 体积闸门 >2MB：只存引用与摘要，不复制字节', () => {
  const big = Buffer.alloc(sp.IMAGE_PERSIST_MAX_BYTES + 1, 7);
  const id = `d3-big-${Date.now()}`;
  sp.appendMessage(id, { role: 'user', content: [anthropicImageBlock(big)] });
  const ref = readLine(id).content[0];
  assert.strictEqual(ref.type, 'image_ref');
  assert.strictEqual(ref.stored, false);
  assert.strictEqual(ref.bytes, big.length);
  assert.ok(!fs.existsSync(path.join(sp._imagesDir(), ref.path)), '超大图字节不得落盘');
});

test('D3-6 门控 KHY_SESSION_IMAGE_PERSIST=0 → base64 原样落行(逐字节旧行为)', () => {
  const buf = pngBytes(4);
  const id = `d3-off-${Date.now()}`;
  const prev = process.env.KHY_SESSION_IMAGE_PERSIST;
  process.env.KHY_SESSION_IMAGE_PERSIST = '0';
  try {
    sp.appendMessage(id, { role: 'user', content: [anthropicImageBlock(buf)] });
  } finally {
    if (prev === undefined) delete process.env.KHY_SESSION_IMAGE_PERSIST;
    else process.env.KHY_SESSION_IMAGE_PERSIST = prev;
  }
  assert.strictEqual(readLine(id).content[0].type, 'image', '门控关 → 不引用化');
  assert.ok(fs.readFileSync(sp.jsonlPathFor(id), 'utf8').includes(buf.toString('base64')));
});

test('D3-7 resume 回读：image_ref 还原为等效 base64 图像块', () => {
  const buf = pngBytes(5);
  const id = `d3-roundtrip-${Date.now()}`;
  sp.appendMessage(id, { role: 'user', content: [anthropicImageBlock(buf)] });
  const chain = sp.buildConversationChain(id);
  assert.strictEqual(chain.length, 1);
  const block = chain[0].content[0];
  assert.strictEqual(block.type, 'image');
  assert.strictEqual(block.source.media_type, 'image/png');
  assert.strictEqual(block.source.data, buf.toString('base64'));
});

test('D3-8 文件缺失 → 诚实占位文本；带 ocrDigest 时给出摘要', () => {
  const buf = pngBytes(6);
  const id = `d3-missing-${Date.now()}`;
  sp.appendMessage(id, { role: 'user', content: [anthropicImageBlock(buf)] });
  const ref = readLine(id).content[0];
  fs.unlinkSync(path.join(sp._imagesDir(), ref.path));
  const block = sp.buildConversationChain(id)[0].content[0];
  assert.strictEqual(block.type, 'text');
  assert.match(block.text, /图片正文缺失/);
  assert.ok(block.text.includes(ref.sha16), '占位文本须带引用摘要(sha16)');

  const id2 = `d3-ocr-${Date.now()}`;
  sp.appendMessage(id2, {
    role: 'user',
    content: [{ type: 'image_ref', path: 'deadbeef.png', mimeType: 'image/png', bytes: 10, sha16: 'deadbeef', ocrDigest: '报错截图: NPE at line 42' }],
  });
  const b2 = sp.buildConversationChain(id2)[0].content[0];
  assert.strictEqual(b2.type, 'text');
  assert.ok(b2.text.includes('OCR 摘要') && b2.text.includes('NPE at line 42'));
});

test('D3-9 恶意 path 不越界：image_ref.path 只取 basename', () => {
  const id = `d3-traversal-${Date.now()}`;
  const escaped = path.join(os.tmpdir(), 'khy-d3-escape-canary');
  fs.writeFileSync(escaped, 'canary');
  try {
    sp.appendMessage(id, {
      role: 'user',
      content: [{ type: 'image_ref', path: `../../../..${path.sep}khy-d3-escape-canary`, mimeType: 'image/png', bytes: 6, sha16: 'x' }],
    });
    const block = sp.buildConversationChain(id)[0].content[0];
    assert.strictEqual(block.type, 'text', '不得把仓库外文件内容当图片还原');
    assert.match(block.text, /图片正文缺失/);
  } finally {
    fs.unlinkSync(escaped);
  }
});
