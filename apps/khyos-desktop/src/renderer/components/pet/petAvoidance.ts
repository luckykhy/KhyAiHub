/**
 * petAvoidance — where the desktop pet may sit without covering text.
 *
 * Pure logic, no DOM and no React: the .mjs unit test imports this module
 * directly via Node's type stripping (same pattern as petFortune.ts).
 *
 * The desktop pet floats above the workspace. When the app underneath it
 * renders text (a chat message, a file name, a button label), the pet steps
 * aside on its own instead of hiding the words.
 *
 * Three ideas carry the whole module:
 *
 *   1. **Coverage** — how much of the pet's footprint sits on top of visible
 *      text, as a ratio in [0, 1]. A ratio, not a boolean: covering one thin
 *      line is very different from covering a paragraph.
 *
 *   2. **Blocked lines** — the trigger. A ratio alone is too blunt: a chat
 *      line is ~16px tall, so a whole line under the card is only ~8% of the
 *      footprint yet it is exactly the thing the user cannot read. So the
 *      pet reacts to *lines it actually hides*, not to an area threshold.
 *
 *   3. **Escape slot** — the pet picks the candidate slot with the least
 *      coverage, and only if that slot is materially better than where it is
 *      now. Without that test the pet would flap between two equally bad
 *      spots on every check.
 *
 * The DOM side (how coverage is measured) lives in petTextProbe.ts and is
 * injected as a callback, so this module stays testable without a browser.
 *
 * The home/escape split lives in the component (KhyPet.tsx): the position the
 * user dragged to is the *home* and is persisted; an escape is a temporary
 * detour that the pet walks back from once home is clear again.
 */

/** A rectangle in viewport coordinates. */
export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** One line of visible text (the inked area, not the element's box). */
export type TextSpan = Rect

/** A named resting place the pet may move to. */
export interface Slot {
  id: string
  left: number
  top: number
}

/** A slot counts as "free" when it covers at most this fraction of text. */
export const CLEAR_RATIO = 0.02
/** The destination must cover at most this fraction of the current coverage. */
export const IMPROVE_FACTOR = 0.5
/** Minimum gap between two automatic moves, in ms. */
export const AUTO_MOVE_COOLDOWN_MS = 2500
/** How often the pet looks at the screen, in ms. */
export const CHECK_INTERVAL_MS = 1500
/** Consecutive clear checks before the pet walks home again. */
export const HOME_CLEAR_STREAK = 2
/**
 * How long a manual drag keeps the pet where the user put it, in ms.
 *
 * The pet would otherwise run away the instant the user releases it, which
 * reads as "the app ignores me". A drag buys a short grace period; the
 * feature is still there once the grace period is over.
 */
export const MANUAL_GRACE_MS = 10000
/** A hidden line must be at least this wide to count as blocked. */
export const MIN_BLOCKED_WIDTH = 12
/** ...and at least this tall. */
export const MIN_BLOCKED_HEIGHT = 5

/** Area of the overlap between two rectangles. */
export function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  if (width <= 0 || height <= 0) return 0
  return width * height
}

/**
 * How much of `rect` is covered by text, as a ratio in [0, 1].
 *
 * Text spans are inked lines of different elements; they do not overlap
 * each other in practice, so summing the intersections is a faithful union
 * area. The result is clamped anyway.
 */
export function coverageRatio(rect: Rect, spans: TextSpan[]): number {
  const area = Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top)
  if (area <= 0) return 0
  let covered = 0
  for (const span of spans) {
    covered += overlapArea(rect, span)
  }
  return Math.min(1, covered / area)
}

/**
 * How many text lines the pet is actually hiding.
 *
 * A line counts only when a real chunk of it is under the pet: a hairline
 * graze of a descender is not something a reader would miss.
 */
export function blockedLines(rect: Rect, spans: TextSpan[]): number {
  let count = 0
  for (const span of spans) {
    const width = Math.min(rect.right, span.right) - Math.max(rect.left, span.left)
    const height = Math.min(rect.bottom, span.bottom) - Math.max(rect.top, span.top)
    if (width >= MIN_BLOCKED_WIDTH && height >= MIN_BLOCKED_HEIGHT) count += 1
  }
  return count
}

/**
 * Candidate resting places around the viewport.
 *
 * Corners and edge midpoints only — the centre of the screen is where the
 * conversation lives, so it is never a candidate. Slots that do not fit in
 * the viewport are dropped.
 */
export function candidateSlots(
  viewportWidth: number,
  viewportHeight: number,
  cardWidth: number,
  cardHeight: number,
  margin = 12,
): Slot[] {
  const raw: Array<[string, number, number]> = [
    ['bottom-left', margin, viewportHeight - cardHeight - margin],
    ['bottom-right', viewportWidth - cardWidth - margin, viewportHeight - cardHeight - margin],
    ['top-left', margin, margin],
    ['top-right', viewportWidth - cardWidth - margin, margin],
    ['bottom-center', Math.round((viewportWidth - cardWidth) / 2), viewportHeight - cardHeight - margin],
    ['top-center', Math.round((viewportWidth - cardWidth) / 2), margin],
    ['left-middle', margin, Math.round((viewportHeight - cardHeight) / 2)],
    ['right-middle', viewportWidth - cardWidth - margin, Math.round((viewportHeight - cardHeight) / 2)],
  ]
  return raw
    .filter(([, left, top]) => left >= 0 && top >= 0)
    .map(([id, left, top]) => ({ id, left, top }))
}

/** The footprint the pet occupies when it sits at a slot. */
export function slotRect(slot: Slot, cardWidth: number, cardHeight: number): Rect {
  return {
    left: slot.left,
    top: slot.top,
    right: slot.left + cardWidth,
    bottom: slot.top + cardHeight,
  }
}

/**
 * The slot the pet should run to, or null when nowhere is clearly better.
 *
 * "Better" is decided by coverage first and distance second: among equally
 * clear slots the nearest one wins, so the pet takes the shortest walk.
 * `coverageOf` is injected so this stays a pure function of its inputs.
 */
export function chooseEscapeSlot(params: {
  slots: Slot[]
  current: { left: number; top: number }
  currentRatio: number
  coverageOf: (slot: Slot) => number
  improveFactor?: number
  clearRatio?: number
}): Slot | null {
  const {
    slots,
    current,
    currentRatio,
    coverageOf,
    improveFactor = IMPROVE_FACTOR,
    clearRatio = CLEAR_RATIO,
  } = params
  // 脚下没压住字 → 没有躲避的必要，留在原地。
  // （少了这一句，currentRatio=0 时 `ratio <= 0 * improveFactor` 恒成立，
  //  桌宠会在根本没挡字时也去挑位置。）
  if (currentRatio <= 0) return null
  let best: { slot: Slot; ratio: number; distance: number } | null = null
  for (const slot of slots) {
    // Never "escape" to where the pet already is.
    if (slot.left === current.left && slot.top === current.top) continue
    const ratio = coverageOf(slot)
    const distance = Math.hypot(slot.left - current.left, slot.top - current.top)
    if (
      !best
      || ratio < best.ratio - 1e-6
      || (Math.abs(ratio - best.ratio) <= 1e-6 && distance < best.distance)
    ) {
      best = { slot, ratio, distance }
    }
  }
  if (!best) return null
  // A genuinely free spot always wins. Otherwise the destination has to be
  // materially better, otherwise the pet would hop between two equally
  // crowded corners on every check.
  if (best.ratio <= clearRatio) return best.slot
  if (best.ratio <= currentRatio * improveFactor) return best.slot
  return null
}

/**
 * Whether the pet may walk back to its home position.
 *
 * Home has to be clear of text — that is the whole reason the pet left. The
 * streak makes sure it does not walk back and forth on a single stray line.
 */
export function shouldReturnHome(params: {
  homeBlocked: boolean
  clearStreak: number
  requiredStreak?: number
}): boolean {
  const { homeBlocked, clearStreak, requiredStreak = HOME_CLEAR_STREAK } = params
  if (homeBlocked) return false
  return clearStreak >= requiredStreak
}
