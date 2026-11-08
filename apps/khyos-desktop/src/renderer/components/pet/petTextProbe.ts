/**
 * petTextProbe — the DOM side of "the pet steps aside when it covers text".
 *
 * The desktop pet floats above the workspace in a fixed card. When the app
 * underneath it renders text (a chat message, a file name, a button label),
 * the pet should move somewhere else instead of hiding the words.
 *
 * This module answers one question: **which parts of the viewport hold
 * visible text?** The answer is a list of line-level rectangles, which the
 * pet then intersects with its own footprint to get a coverage ratio.
 *
 * Two design points that are easy to get wrong:
 *
 *   1. **Line rects, not element boxes.** A `<p>` with one short sentence is
 *      a 600px-wide box but only ~40px of ink. Using the element box would
 *      make the pet think it covers a paragraph when it covers a corner of
 *      whitespace. So the rects come from `Range.getClientRects()` over the
 *      text nodes themselves — the real inked area, per line.
 *
 *   2. **Prune by region, not by whole document.** The pet only ever sits in
 *      a handful of places, so the scan walks the DOM but skips every
 *      subtree whose box lies outside the regions of interest. Text can
 *      never leave its parent's box, so pruning is exact, not a heuristic.
 *
 * The scan reads layout but never mutates the DOM, so it does not force a
 * reflow storm; the caller runs it from an idle callback.
 */

import type { Rect, TextSpan } from './petAvoidance'

export type { Rect, TextSpan }

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

function isInvisible(element: Element): boolean {
  const style = window.getComputedStyle(element)
  if (style.visibility === 'hidden' || style.display === 'none') return true
  if (Number.parseFloat(style.opacity) === 0) return true
  return element.getAttribute('aria-hidden') === 'true'
}

/**
 * Collect the visible text inside `root` that falls inside `regions`.
 *
 * `exclude` is the pet's own DOM: the pet must not count the name and the
 * button labels on its own card as "text it is covering".
 */
export function collectTextSpans(
  root: Element,
  exclude: Element | null,
  regions: Rect[],
): TextSpan[] {
  const spans: TextSpan[] = []
  if (regions.length === 0) return spans
  const range = document.createRange()
  const stack: Element[] = []
  for (let i = root.children.length - 1; i >= 0; i -= 1) {
    stack.push(root.children[i])
  }
  while (stack.length > 0) {
    const element = stack.pop() as Element
    if (exclude && (element === exclude || exclude.contains(element))) continue
    const box = element.getBoundingClientRect()
    if (box.width <= 0 && box.height <= 0) continue
    const elementRect: Rect = { left: box.left, top: box.top, right: box.right, bottom: box.bottom }
    // Text can never leave its parent's box: if the box misses every region
    // of interest, the whole subtree misses them too.
    if (!regions.some((region) => rectsIntersect(region, elementRect))) continue

    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType !== Node.TEXT_NODE) continue
      const text = child.textContent
      if (!text || text.trim().length === 0) continue
      range.selectNodeContents(child)
      for (const ink of range.getClientRects()) {
        if (ink.width <= 0 || ink.height <= 0) continue
        const span: Rect = { left: ink.left, top: ink.top, right: ink.right, bottom: ink.bottom }
        if (!regions.some((region) => rectsIntersect(region, span))) continue
        spans.push(span)
      }
    }

    if (!isInvisible(element)) {
      for (let i = element.children.length - 1; i >= 0; i -= 1) {
        stack.push(element.children[i])
      }
    }
  }
  return spans
}

/**
 * Whether the pet card is the topmost thing at its own centre.
 *
 * When a modal or a popover covers the pet, the pet is not visible and
 * whatever is under it is not hidden by the pet either — so the pet must
 * not run away in that case.
 */
export function isPetOnTop(petElement: Element, rect: Rect): boolean {
  const x = Math.min(window.innerWidth - 1, Math.max(0, (rect.left + rect.right) / 2))
  const y = Math.min(window.innerHeight - 1, Math.max(0, (rect.top + rect.bottom) / 2))
  const top = document.elementFromPoint(x, y)
  if (!top) return true
  return top === petElement || petElement.contains(top)
}
