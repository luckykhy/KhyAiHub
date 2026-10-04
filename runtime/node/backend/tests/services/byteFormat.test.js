'use strict';

const { humanBytes } = require('../../src/services/byteFormat');

describe('byteFormat.humanBytes', () => {
  test('degenerate inputs collapse to 0 B', () => {
    expect(humanBytes(0)).toBe('0 B');
    expect(humanBytes(-5)).toBe('0 B');
    expect(humanBytes(NaN)).toBe('0 B');
  });

  test('formats each tier with spaced unit', () => {
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(1536)).toBe('1.5 KB');
    expect(humanBytes(340 * 1024 * 1024)).toBe('340 MB');
    expect(humanBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });

  test('carries to the next unit at the rounding boundary (never "1024 KB/MB")', () => {
    // The ladder loop must test the post-rounded value, otherwise a count whose
    // display rounds up to 1024 stays stuck one tier low.
    expect(humanBytes(1048575)).toBe('1.0 MB');
    expect(humanBytes(1073741823)).toBe('1.0 GB');
    expect(humanBytes(1048000)).toBe('1023 KB'); // below threshold stays one tier down
  });
});
