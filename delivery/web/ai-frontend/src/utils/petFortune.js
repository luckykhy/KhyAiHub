/**
 * petFortune — pure-logic leaf for the Lucky daily fortune.
 *
 * The web, desktop and mobile clients must agree bit for bit (same day + same
 * character → same result), so this file depends on nothing but data and
 * strings: no Vue, no DOM, no localStorage — every client unit-tests the same
 * vectors against it.
 *
 * Algorithm (verbatim from delivery/brand/pet/pet-fortune.json → seed.formula):
 *   seed  = fnv1a32(dateKey + ':' + characterId)
 *   level = weighted pick over the cumulative intervals of levels[].weight
 *           (r = seed % totalWeight)
 *   tip   = tips[(seed >>> 8) % tips.length]
 *   color = luckyColors[(seed >>> 16) % luckyColors.length]
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * String → UTF-8 byte array.
 * Uses TextEncoder (present in browsers and Node); falls back to a hand-rolled
 * encoder so a runtime without TextEncoder can never silently switch to a
 * different algorithm.
 *
 * @param {string} input Any string.
 * @returns {number[]} UTF-8 bytes.
 */
function utf8Bytes(input) {
  const text = String(input);
  if (typeof TextEncoder !== 'undefined') {
    return Array.from(new TextEncoder().encode(text));
  }
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i);
    if (code > 0xffff) i += 1; // surrogate pair: skip the trailing unit
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return out;
}

/**
 * FNV-1a 32-bit hash (unsigned).
 *
 * @param {string} input String to hash.
 * @returns {number} Integer in 0 .. 2^32-1.
 */
export function fnv1a32(input) {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of utf8Bytes(input)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Local date key: 'YYYY-MM-DD'.
 * Local time, not UTC — a user's "today" must match their own calendar, or the
 * "one fortune per day" would flip over at midnight.
 *
 * @param {Date} [date] Defaults to now.
 * @returns {string} e.g. '2026-11-03'.
 */
export function localDateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Pick one entry by cumulative weight interval.
 *
 * @param {Array<{weight:number}>} levels Level table (array order matters).
 * @param {number} r Draw in [0, totalWeight).
 * @returns {object|null} The hit level; null when the table is empty.
 */
function weightedPick(levels, r) {
  let remaining = r;
  for (const level of levels) {
    const weight = Number(level && level.weight) || 0;
    if (remaining < weight) return level;
    remaining -= weight;
  }
  return levels.length ? levels[levels.length - 1] : null;
}

/**
 * Daily fortune for a date + character: level, tip and lucky colour.
 *
 * Same day + same character → same seed → same result. A different character
 * gives a different seed (characterId is part of the seed string), so the two
 * characters draw their own fortune every day.
 *
 * @param {string} dateKey     Local date key 'YYYY-MM-DD'.
 * @param {string} characterId Character id: 'female' | 'male'.
 * @param {object} data        The whole pet-fortune.json payload.
 * @returns {{seed:number, level:object|null, tip:string, color:object|null}}
 */
export function dailyFortune(dateKey, characterId, data) {
  const levels = Array.isArray(data && data.levels) ? data.levels : [];
  const tips = Array.isArray(data && data.tips) ? data.tips : [];
  const colors = Array.isArray(data && data.luckyColors) ? data.luckyColors : [];

  const seed = fnv1a32(`${dateKey}:${characterId}`);
  const totalWeight = levels.reduce((sum, level) => sum + (Number(level && level.weight) || 0), 0);

  let level = null;
  if (totalWeight > 0) {
    level = weightedPick(levels, seed % totalWeight);
  } else if (levels.length) {
    level = levels[0];
  }

  const tip = tips.length ? tips[(seed >>> 8) % tips.length] : '';
  const color = colors.length ? colors[(seed >>> 16) % colors.length] : null;

  return { seed, level, tip, color };
}
