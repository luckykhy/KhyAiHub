'use strict';

/**
 * Vision image normalizer (services/imageNormalize) — deterministic leaf tests.
 *
 * The platform resize branch is intentionally not exercised here: it shells out
 * to System.Drawing/sips/ImageMagick and is covered by the GLM downscaler
 * suite. What must stay pinned is the *decision* surface — gate defaults,
 * long-edge clamping, and every fail-soft passthrough.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const norm = require('../../src/services/imageNormalize');

function pngHeader(w, h) {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function gifHeader(w, h) {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}

test('normalizeEnabled: default on, explicit falsy → off', () => {
  assert.strictEqual(norm.normalizeEnabled({}), true);
  for (const v of ['0', 'false', 'off', 'no', ' OFF ']) {
    assert.strictEqual(norm.normalizeEnabled({ KHY_VISION_IMAGE_NORMALIZE: v }), false, v);
  }
  assert.strictEqual(norm.normalizeEnabled({ KHY_VISION_IMAGE_NORMALIZE: '1' }), true);
});

test('getMaxEdge: default 1568, clamped to 512..4096', () => {
  assert.strictEqual(norm.getMaxEdge({}), 1568);
  assert.strictEqual(norm.getMaxEdge({ KHY_VISION_IMAGE_MAX_EDGE: '2048' }), 2048);
  assert.strictEqual(norm.getMaxEdge({ KHY_VISION_IMAGE_MAX_EDGE: '10' }), 512);
  assert.strictEqual(norm.getMaxEdge({ KHY_VISION_IMAGE_MAX_EDGE: '999999' }), 4096);
  assert.strictEqual(norm.getMaxEdge({ KHY_VISION_IMAGE_MAX_EDGE: 'abc' }), 1568);
});

test('planImageNormalize: within cap → null; over cap → aspect-preserving target', () => {
  assert.strictEqual(norm.planImageNormalize(1568, 900, {}), null);
  assert.strictEqual(norm.planImageNormalize(1560, 1568, {}), null);
  assert.strictEqual(norm.planImageNormalize(0, 900, {}), null);
  assert.strictEqual(norm.planImageNormalize('x', 900, {}), null);

  const landscape = norm.planImageNormalize(4000, 3000, {});
  assert.deepStrictEqual(
    { w: landscape.width, h: landscape.height },
    { w: 1568, h: 1176 }
  );

  const portrait = norm.planImageNormalize(1000, 3200, {});
  assert.strictEqual(portrait.height, 1568);
  assert.strictEqual(portrait.width, 490);
  assert.ok(portrait.scale > 0 && portrait.scale < 1);

  const wide = norm.planImageNormalize(4000, 3000, { KHY_VISION_IMAGE_MAX_EDGE: '1024' });
  assert.strictEqual(wide.width, 1024);
  assert.strictEqual(wide.height, 768);
});

test('normalizeImageBuffer: gate off → null before any resize', () => {
  const res = norm.normalizeImageBuffer(pngHeader(4000, 3000), {
    env: { KHY_VISION_IMAGE_NORMALIZE: '0' },
  });
  assert.strictEqual(res, null);
});

test('normalizeImageBuffer: GIF is never re-encoded', () => {
  const res = norm.normalizeImageBuffer(gifHeader(4000, 3000), { env: {} });
  assert.strictEqual(res, null);
});

test('normalizeImageBuffer: unknown / undersized input → null', () => {
  assert.strictEqual(norm.normalizeImageBuffer(Buffer.alloc(64, 0x41), { env: {} }), null);
  assert.strictEqual(norm.normalizeImageBuffer(Buffer.alloc(10), { env: {} }), null);
  assert.strictEqual(norm.normalizeImageBuffer(null, { env: {} }), null);
});

test('normalizeImageBuffer: image already within cap → null (no recompression)', () => {
  assert.strictEqual(norm.normalizeImageBuffer(pngHeader(800, 600), { env: {} }), null);
});

test('normalizeImageBase64: non-string / invalid base64 → null', () => {
  assert.strictEqual(norm.normalizeImageBase64(null, {}), null);
  assert.strictEqual(norm.normalizeImageBase64(123, {}), null);
  assert.strictEqual(norm.normalizeImageBase64('', {}), null);
});
