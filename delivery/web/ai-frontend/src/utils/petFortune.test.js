import { describe, it, expect } from 'vitest';
import { dailyFortune, fnv1a32, localDateKey } from './petFortune';
import fortuneData from '../data/pet-fortune.json';

/**
 * petFortune — unit tests for the pure daily-fortune logic.
 *
 * The web, desktop and mobile clients must agree bit for bit, so what is
 * locked here is the **algorithm itself** (not component wiring): the standard
 * FNV-1a 32 vectors, the UTF-8 byte convention, the local-timezone date key,
 * and the three derivation rules (level by cumulative weight interval, tip
 * from the high seed byte, colour from the higher one). If any client changes
 * a shift amount or the weight convention, this file goes red first.
 */

/** Byte-level reference implementation (used to cross-check the UTF-8 convention). */
function fnv1a32Bytes(bytes) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

describe('fnv1a32', () => {
  it('matches the standard FNV-1a 32 test vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('hashes UTF-8 bytes (a CJK character is 3 bytes, not 1 code unit)', () => {
    expect(fnv1a32('澪')).toBe(fnv1a32Bytes([0xe6, 0xbe, 0xaa]));
    expect(fnv1a32('凯')).toBe(fnv1a32Bytes([0xe5, 0x87, 0xaf]));
  });

  it('returns an unsigned integer in 0 .. 2^32-1', () => {
    for (const s of ['', 'a', '2026-11-03:female', '2026-11-03:male']) {
      const h = fnv1a32(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('localDateKey', () => {
  it('emits a zero-padded local date key YYYY-MM-DD', () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(localDateKey(new Date(2026, 10, 3))).toBe('2026-11-03');
  });

  it('uses local time, not UTC (23:30 local is still the same day)', () => {
    expect(localDateKey(new Date(2026, 10, 3, 23, 30))).toBe('2026-11-03');
    expect(localDateKey(new Date(2026, 10, 3, 0, 5))).toBe('2026-11-03');
  });
});

describe('dailyFortune', () => {
  it('same day + same character → same result (one fortune per day)', () => {
    const a = dailyFortune('2026-11-03', 'female', fortuneData);
    const b = dailyFortune('2026-11-03', 'female', fortuneData);
    expect(a).toEqual(b);
    expect(a.seed).toBe(b.seed);
  });

  it('different character → different seed (each character draws its own)', () => {
    const female = dailyFortune('2026-11-03', 'female', fortuneData);
    const male = dailyFortune('2026-11-03', 'male', fortuneData);
    expect(female.seed).not.toBe(male.seed);
  });

  it('different day → different seed (the fortune changes across days)', () => {
    const d1 = dailyFortune('2026-11-03', 'female', fortuneData);
    const d2 = dailyFortune('2026-11-04', 'female', fortuneData);
    expect(d1.seed).not.toBe(d2.seed);
  });

  it('seed = fnv1a32(dateKey + ":" + characterId)', () => {
    const f = dailyFortune('2026-11-03', 'female', fortuneData);
    expect(f.seed).toBe(fnv1a32('2026-11-03:female'));
  });

  it('level is picked by cumulative weight interval (r = seed % totalWeight)', () => {
    const f = dailyFortune('2026-11-03', 'female', fortuneData);
    const total = fortuneData.levels.reduce((sum, l) => sum + l.weight, 0);
    const r = f.seed % total;
    let acc = 0;
    let expected = null;
    for (const level of fortuneData.levels) {
      if (r >= acc && r < acc + level.weight) {
        expected = level;
        break;
      }
      acc += level.weight;
    }
    expect(expected).not.toBeNull();
    expect(f.level).toEqual(expected);
  });

  it('tip = tips[(seed >>> 8) % tips.length], color = luckyColors[(seed >>> 16) % luckyColors.length]', () => {
    for (const dateKey of ['2026-11-03', '2026-11-04', '2026-12-31']) {
      for (const characterId of ['female', 'male']) {
        const f = dailyFortune(dateKey, characterId, fortuneData);
        expect(f.tip).toBe(fortuneData.tips[(f.seed >>> 8) % fortuneData.tips.length]);
        expect(f.color).toEqual(fortuneData.luckyColors[(f.seed >>> 16) % fortuneData.luckyColors.length]);
      }
    }
  });

  it('result fields come from the data source itself (no hard-coded label / colour)', () => {
    const f = dailyFortune('2026-11-03', 'female', fortuneData);
    expect(fortuneData.levels.map((l) => l.label)).toContain(f.level.label);
    expect(fortuneData.luckyColors.map((c) => c.name)).toContain(f.color.name);
    expect(fortuneData.tips).toContain(f.tip);
  });
});
