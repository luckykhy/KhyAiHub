'use strict';

/**
 * [DESIGN-ARCH-163] D1/D2 的确定性测试（node:test）。
 *
 * 锁定:
 *  ① readImageDimensions 各格式头部解析与不可解析 → null（不猜）;
 *  ② classifyScene 判据优先级与 unknown 兜底;
 *  ③ buildContextCard 的说明书结构（含低置信 ⚠、长图建议、无 OCR 如实标注）;
 *  ④ attachContextCard 门控关/无图 → prompt 逐字节不变;
 *  ⑤ readImageFromFile 超限:门控关 → 旧错误逐字节;门开且不可压缩 → 新错误含修复建议。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const leaf = require('../../src/services/imageContextCard');

// ── fixtures: 最小合法头部 ─────────────────────────────────────────────────
function pngBuf(w, h) {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function gifBuf(w, h) {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}
function jpegBuf(w, h) {
  // SOI + APP0(带长度) + SOF0(高在+5 宽在+7)
  const b = Buffer.alloc(2 + 2 + 8 + 2 + 15);
  let i = 0;
  b[i++] = 0xff; b[i++] = 0xd8;
  b[i++] = 0xff; b[i++] = 0xe0;
  b.writeUInt16BE(8 + 2, i - 2); // 保持简单:APP0 长度字段
  i += 8;                        // 跳过 APP0 载荷
  b[i++] = 0xff; b[i++] = 0xc0;  // SOF0
  b.writeUInt16BE(17, i); i += 2; // 段长
  b[i++] = 8;                    // 精度
  b.writeUInt16BE(h, i); i += 2;
  b.writeUInt16BE(w, i); i += 2;
  b[i] = 3;
  return b;
}

test('readImageDimensions: PNG/GIF/JPEG 正确、乱字节与短缓冲 → null', () => {
  assert.deepStrictEqual(leaf.readImageDimensions(pngBuf(1440, 900)), { width: 1440, height: 900 });
  assert.deepStrictEqual(leaf.readImageDimensions(gifBuf(320, 240)), { width: 320, height: 240 });
  assert.deepStrictEqual(leaf.readImageDimensions(jpegBuf(800, 600)), { width: 800, height: 600 });
  assert.strictEqual(leaf.readImageDimensions(Buffer.from('not an image at all')), null);
  assert.strictEqual(leaf.readImageDimensions(Buffer.from([1, 2])), null);
  assert.strictEqual(leaf.readImageDimensions(null), null);
});

test('classifyScene: 判据优先级 error > diagram > ui > document,空文本 unknown', () => {
  assert.strictEqual(leaf.classifyScene({ ocrText: "TypeError: x is not a function\n    at foo (a.js:1:2)" }), 'error-screenshot');
  assert.strictEqual(leaf.classifyScene({ ocrText: 'graph TD\nA[下单] --> B{库存校验}' }), 'diagram');
  assert.strictEqual(leaf.classifyScene({ ocrText: '主色 #1677FF 字号 16px 间距 24px' }), 'ui-design');
  assert.strictEqual(leaf.classifyScene({ ocrText: '1. 需求背景\n2. 功能说明\n3. 验收标准' }), 'document');
  assert.strictEqual(leaf.classifyScene({ ocrText: '  ' }), 'unknown');
  assert.strictEqual(leaf.classifyScene({}), 'unknown');
  // 报错特征强于箭头 → 先判 error（优先级）
  assert.strictEqual(leaf.classifyScene({ ocrText: 'Fatal error --> see log' }), 'error-screenshot');
});

test('buildContextCard: 结构完整,低置信出 ⚠,无 OCR 如实标注', () => {
  const card = leaf.buildContextCard([
    {
      source: '剪贴板',
      sizeBytes: 850 * 1024,
      width: 1440, height: 900,
      format: 'png',
      scene: leaf.classifyScene({ ocrText: 'RollupError: Unexpected token' }),
      ocrText: 'RollupError: Unexpected token',
      ocrConfidence: 42,
    },
  ]);
  assert.match(card, /【图片说明书 1\/1】/);
  assert.match(card, /- 来源: 剪贴板/);
  assert.match(card, /1440x900px/);
  assert.match(card, /场景判定: 报错截图/);
  assert.match(card, /RollupError: Unexpected token/);
  assert.match(card, /⚠ 置信度低/);
  assert.match(card, /【待确认】/);

  const noOcr = leaf.buildContextCard([{ sizeBytes: 10, width: 800, height: 2400 }]);
  assert.match(noOcr, /【OCR 转录】未获取/);
  assert.match(noOcr, /【建议】长图/);
  assert.doesNotMatch(noOcr, /【待确认】/); // unknown 不出待确认
  assert.strictEqual(leaf.buildContextCard([]), '');
});

test('cardEnabled: 默认开,显式 falsy 关', () => {
  assert.strictEqual(leaf.cardEnabled({}), true);
  assert.strictEqual(leaf.cardEnabled({ KHY_IMAGE_CONTEXT_CARD: '0' }), false);
  assert.strictEqual(leaf.cardEnabled({ KHY_IMAGE_CONTEXT_CARD: '1' }), true);
});

test('attachContextCard: 门控关/无 base64 图 → prompt 逐字节不变', async () => {
  const svc = require('../../src/services/imageContextCardService');
  assert.strictEqual(await svc.attachContextCard('hi', { images: [] }, {}), 'hi');
  assert.strictEqual(
    await svc.attachContextCard('hi', { images: [{ base64: 'aaaa' }] }, { KHY_IMAGE_CONTEXT_CARD: '0' }),
    'hi'
  );
});

test('readImageFromFile 超限: 门关旧错逐字节;门开不可压缩 → 新错含修复建议', () => {
  const imageService = require('../../src/services/imageService');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khycard-')), 'big.bin');
  fs.writeFileSync(tmp, Buffer.alloc(imageService.MAX_IMAGE_BYTES + 10, 0x41));
  try {
    assert.strictEqual(imageService._autoDownscaleEnabled({}), true);
    assert.strictEqual(imageService._autoDownscaleEnabled({ KHY_IMAGE_AUTO_DOWNSCALE: '0' }), false);
    // 门关 → 旧错误文本逐字节
    const orig = process.env.KHY_IMAGE_AUTO_DOWNSCALE;
    process.env.KHY_IMAGE_AUTO_DOWNSCALE = '0';
    try {
      assert.throws(
        () => imageService.readImageFromFile(tmp),
        /^Error: Image too large \(\d+\.\dMB\)\. Max: 5MB$/
      );
    } finally {
      if (orig === undefined) delete process.env.KHY_IMAGE_AUTO_DOWNSCALE;
      else process.env.KHY_IMAGE_AUTO_DOWNSCALE = orig;
    }
    // 门开 + 非图像字节 → 新错误含「自动压缩未成功」与修复建议
    assert.throws(
      () => imageService.readImageFromFile(tmp),
      /自动压缩未成功.*缩小后重试|文本粘贴/s
    );
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
});
