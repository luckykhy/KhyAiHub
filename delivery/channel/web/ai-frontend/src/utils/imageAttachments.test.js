// 纯决策层测试：resizeImageForUpload 依赖 canvas/createImageBitmap，
// 在 vitest 的 node 环境里无法执行，故只锁 planImageResize / 类型判定。
import { describe, it, expect } from 'vitest';
import {
  planImageResize,
  isResizableImageType,
  imageFileNameForJpeg,
  DEFAULT_MAX_EDGE,
  DEFAULT_PASSTHROUGH_BYTES,
} from './imageAttachments.js';

describe('planImageResize', () => {
  it('within edge and byte budget → null (upload untouched)', () => {
    expect(planImageResize(1200, 800, 500 * 1024)).toBeNull();
    expect(planImageResize(DEFAULT_MAX_EDGE, DEFAULT_MAX_EDGE, 1)).toBeNull();
  });

  it('over the long edge → aspect-preserving target', () => {
    const plan = planImageResize(4000, 3000, 2 * 1024 * 1024);
    expect(plan).toMatchObject({ width: 1568, height: 1176, reason: 'edge' });
    expect(plan.scale).toBeCloseTo(1568 / 4000, 5);
  });

  it('portrait orientation uses the height as long edge', () => {
    const plan = planImageResize(1000, 3200, 1024);
    expect(plan.height).toBe(1568);
    expect(plan.width).toBe(490);
  });

  it('byte budget alone triggers a re-encode at the same size', () => {
    const plan = planImageResize(1200, 800, DEFAULT_PASSTHROUGH_BYTES + 1);
    expect(plan).toMatchObject({ width: 1200, height: 800, scale: 1, reason: 'bytes' });
  });

  it('honors maxEdge / passthroughBytes overrides', () => {
    expect(planImageResize(2000, 1000, 1, { maxEdge: 1024 })).toMatchObject({
      width: 1024,
      height: 512,
    });
    expect(planImageResize(10, 10, 500, { passthroughBytes: 1000 })).toBeNull();
  });

  it('invalid dimensions → null', () => {
    expect(planImageResize(0, 100, 1)).toBeNull();
    expect(planImageResize('x', 100, 1)).toBeNull();
  });
});

describe('isResizableImageType', () => {
  it('accepts png/jpeg/webp/bmp, rejects gif and non-images', () => {
    expect(isResizableImageType('image/png')).toBe(true);
    expect(isResizableImageType('image/jpeg')).toBe(true);
    expect(isResizableImageType('image/jpg')).toBe(true);
    expect(isResizableImageType('image/webp')).toBe(true);
    expect(isResizableImageType('image/bmp')).toBe(true);
    expect(isResizableImageType('image/gif')).toBe(false);
    expect(isResizableImageType('application/pdf')).toBe(false);
    expect(isResizableImageType('')).toBe(false);
  });
});

describe('imageFileNameForJpeg', () => {
  it('swaps the extension and keeps the stem', () => {
    expect(imageFileNameForJpeg('shot.png')).toBe('shot.jpg');
    expect(imageFileNameForJpeg('screen.capture.webp')).toBe('screen.capture.jpg');
    expect(imageFileNameForJpeg('')).toBe('pasted-image.jpg');
  });
});
