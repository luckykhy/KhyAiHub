/**
 * petFortune — the Lucky daily fortune, pure logic for the desktop pet.
 *
 * The web, desktop and mobile clients must agree bit for bit (same day + same
 * character → same result), so this module depends on nothing but data and
 * strings: no React, no DOM, no localStorage. The shipped data source is
 * `src/renderer/assets/pet/pet-fortune.json` (copied from
 * `delivery/brand/pet/pet-fortune.json` by scripts/brand/build-brand-assets.js);
 * it is passed in as an argument so this file stays importable by plain node
 * (the .mjs unit test imports it directly via type stripping).
 *
 * Algorithm (verbatim from pet-fortune.json → seed.formula):
 *   seed  = fnv1a32(dateKey + ':' + characterId)
 *   level = weighted pick over the cumulative intervals of levels[].weight
 *           (r = seed % totalWeight)
 *   tip   = tips[(seed >>> 8) % tips.length]
 *   color = luckyColors[(seed >>> 16) % luckyColors.length]
 */

export interface PetFortuneLevel {
  id: string
  label: string
  weight: number
  hint: string
}

export interface PetFortuneColor {
  name: string
  hex: string
}

export interface PetFortuneCharacter {
  name: string
  title: string
  idle: string[]
  lucky: string[]
}

export interface PetFortuneData {
  brand: { name: string; tagline: string }
  levels: PetFortuneLevel[]
  tips: string[]
  luckyColors: PetFortuneColor[]
  characters: Record<string, PetFortuneCharacter>
  actions: Record<string, string>
}

export type PetCharacterId = 'female' | 'male' | 'koi'

export interface DailyFortune {
  level: PetFortuneLevel
  tip: string
  color: PetFortuneColor | null
  seed: number
  dateKey: string
}

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * FNV-1a 32-bit hash over the UTF-8 bytes of the input.
 *
 * `Math.imul` is mandatory here: a plain `h * 0x01000193` exceeds 2^53 and
 * silently loses precision, which would make the desktop end disagree with
 * the other two ends on the very same day.
 */
export function fnv1a32(input: string): number {
  const bytes = new TextEncoder().encode(input)
  let hash = FNV_OFFSET_BASIS
  for (const byte of bytes) {
    hash = (hash ^ byte) >>> 0
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash >>> 0
}

/** Local calendar day as `YYYY-MM-DD`. */
export function localDateKey(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * The fortune of one day for one character.
 *
 * Same day + same character → same result, on every end. That is the whole
 * point of seeding by date instead of by randomness.
 */
export function dailyFortune(
  data: PetFortuneData,
  characterId: PetCharacterId,
  now: Date = new Date(),
): DailyFortune {
  const dateKey = localDateKey(now)
  const seed = fnv1a32(`${dateKey}:${characterId}`)

  const totalWeight = data.levels.reduce((sum, level) => sum + level.weight, 0)
  const remainder = totalWeight > 0 ? seed % totalWeight : 0
  let accumulated = 0
  let level: PetFortuneLevel = data.levels[0] ?? { id: 'none', label: '', weight: 0, hint: '' }
  for (const candidate of data.levels) {
    accumulated += candidate.weight
    if (remainder < accumulated) {
      level = candidate
      break
    }
  }

  const tip = data.tips.length > 0 ? data.tips[(seed >>> 8) % data.tips.length] : ''
  const color = data.luckyColors.length > 0 ? data.luckyColors[(seed >>> 16) % data.luckyColors.length] : null

  return { level, tip, color, seed, dateKey }
}

/**
 * A line for the speech bubble: never the same one twice in a row, so the pet
 * does not feel like a broken record.
 */
export function pickLine(lines: string[], previous: string | null): string {
  if (!lines || lines.length === 0) return ''
  if (lines.length === 1) return lines[0]
  const candidates = lines.filter((line) => line !== previous)
  const pool = candidates.length > 0 ? candidates : lines
  return pool[Math.floor(Math.random() * pool.length)]
}
