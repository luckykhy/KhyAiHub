'use strict';

const { humanBytes } = require('../../src/utils/humanBytes');

describe('humanBytes', () => {
  test('returns 0 B for zero', () => {
    expect(humanBytes(0)).toBe('0 B');
  });

  test('returns 0 B for negative', () => {
    expect(humanBytes(-100)).toBe('0 B');
  });

  test('returns 0 B for NaN', () => {
    expect(humanBytes(NaN)).toBe('0 B');
  });

  test('formats bytes', () => {
    expect(humanBytes(512)).toBe('512 B');
  });

  test('formats KB', () => {
    expect(humanBytes(1536)).toBe('1.5 KB');
  });

  test('formats MB', () => {
    expect(humanBytes(340 * 1024 * 1024)).toBe('340 MB');
  });

  test('formats GB', () => {
    // Contract: >=100 (or the B tier) rounds, else keep 1 decimal → 2.0 GB
    expect(humanBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });

  test('carries to the next unit at the rounding boundary (never "1024 KB/MB")', () => {
    // Regression: the ladder loop tested the pre-rounded value, so a count whose
    // display rounds up to 1024 was stuck one tier low (e.g. "1024 KB" not "1.0 MB").
    expect(humanBytes(1048500)).toBe('1.0 MB');
    expect(humanBytes(1048575)).toBe('1.0 MB');
    expect(humanBytes(1073322394)).toBe('1.0 GB');
    expect(humanBytes(1048000)).toBe('1023 KB'); // below threshold stays one tier down
  });
});
