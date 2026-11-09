/**
 * KhyPet — source-level contract test (node environment: no component mount,
 * readFileSync + regex assertions).
 *
 * Why source-level: this component is a composite of "floating card + drag
 * persistence + three interactions + collapse/restore". Almost all behaviour
 * lives inside <script setup> and depends on localStorage,
 * requestAnimationFrame and DOM measurement, none of which exist in the node
 * test environment. What is locked here are the wiring invariants: storage
 * keys, the fortune-algorithm wiring, hit area and stacking, the brand-mark
 * source, character switching and collapse/restore.
 * File: src/components/KhyPet.vue
 */
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'KhyPet.vue'), 'utf-8');
const APP = readFileSync(join(here, '..', '..', 'App.vue'), 'utf-8');

/** Extract the declaration block of a CSS selector (first match in the source). */
function cssBlock(selector) {
  const start = SRC.indexOf(`${selector} {`);
  if (start < 0) return '';
  const open = SRC.indexOf('{', start);
  const close = SRC.indexOf('}', open);
  return SRC.slice(open + 1, close);
}

test('mounted from App.vue next to KhyFloatBall', () => {
  expect(APP).toContain("import KhyPet from '@/components/KhyPet.vue';");
  expect(APP).toContain('<KhyPet />');
  expect(APP).toContain('<KhyFloatBall />');
});

test('storage keys are stable: khy_pet_pos / khy_pet_char / khy_pet_hidden', () => {
  expect(SRC).toContain("const POS_KEY = 'khy_pet_pos'");
  expect(SRC).toContain("const CHAR_KEY = 'khy_pet_char'");
  expect(SRC).toContain("const HIDDEN_KEY = 'khy_pet_hidden'");
  // always through safeGet / safeSet (never bare localStorage)
  expect(SRC).toContain('safeGet(POS_KEY)');
  expect(SRC).toContain('safeGet(CHAR_KEY)');
  expect(SRC).toContain('safeGet(HIDDEN_KEY)');
  expect(SRC).toContain('safeSet(POS_KEY, JSON.stringify(');
  expect(SRC).toContain('safeSet(CHAR_KEY, characterId.value)');
  expect(SRC).toContain("safeSet(HIDDEN_KEY, '1')");
  expect(SRC).toContain("safeSet(HIDDEN_KEY, '0')");
});

test('the drag drop point stores exactly {left, top}', () => {
  expect(SRC).toMatch(/safeSet\(POS_KEY, JSON\.stringify\(\{ left: pos\.value\.left, top: pos\.value\.top \}\)\)/);
  expect(SRC).toContain('Number.isFinite(raw.left)');
  expect(SRC).toContain('Number.isFinite(raw.top)');
});

test('4px drag threshold separates click from drag; text selection is locked while dragging', () => {
  expect(SRC).toContain('const DRAG_THRESHOLD = 4;');
  expect(SRC).toContain('Math.hypot(dx, dy) < DRAG_THRESHOLD');
  expect(SRC).toContain("document.body.style.userSelect = 'none';");
  expect(SRC).toContain('lockTextSelection(false)');
});

test('hit area: outer layer pointer-events none, card / badge auto', () => {
  expect(cssBlock('.khy-pet')).toContain('pointer-events: none;');
  expect(cssBlock('.khy-pet__card')).toContain('pointer-events: auto;');
  expect(cssBlock('.khy-pet__badge')).toContain('pointer-events: auto;');
});

test('the card is not a full-screen container: the outer layer is content-sized', () => {
  const root = cssBlock('.khy-pet');
  expect(root).toContain('position: fixed;');
  expect(root).not.toMatch(/width:\s*100%|100vw|100vh|inset:\s*0/);
  // default bottom-left corner, clear of the float ball in the bottom-right
  expect(root).toContain('left: 24px;');
  expect(root).toContain('bottom: 24px;');
});

test('stacking: z-index 1200 (above content, below Element Plus dialogs and the 3000 float ball)', () => {
  expect(cssBlock('.khy-pet')).toContain('z-index: 1200;');
});

test('real brand mark via the KhyMark component (no hand-drawn SVG), header shows the brand name', () => {
  expect(SRC).toContain("import KhyMark from './KhyMark.vue';");
  const marks = SRC.match(/<KhyMark/g) || [];
  // header mark + omamori mark + collapsed badge mark
  expect(marks.length).toBeGreaterThanOrEqual(3);
  expect(SRC).not.toMatch(/<svg/); // the brand mark must never be drawn by hand
  expect(SRC).toContain('{{ brandName }}');
  expect(SRC).toContain('petData.brand.name');
});

test('character image comes from the /brand/pet/ static assets (idle / lucky)', () => {
  expect(SRC).toContain("/brand/pet/khy-pet-${characterId.value}-${lucky.value ? 'lucky' : 'idle'}.png");
});

test('interaction 1: tapping the character shows an idle line, never the previous one, bubble hides after 2.5s', () => {
  expect(SRC).toContain('const BUBBLE_MS = 2500;');
  expect(SRC).toContain('character.value.idle');
  expect(SRC).toContain('lastIdleIndex');
  expect(SRC).toContain('function onAvatarClick()');
  expect(SRC).toMatch(/if \(dragging\.value\) return;/);
});

test('interaction 2: the omamori button draws a fortune — level label + hint + lucky colour, seeded by date', () => {
  expect(SRC).toContain('function drawFortune()');
  expect(SRC).toContain('dailyFortune(localDateKey(), characterId.value, petData)');
  expect(SRC).toContain('fortune.level.label');
  expect(SRC).toContain('fortune.level.hint');
  expect(SRC).toContain('fortune.color.name');
  // the lucky pose falls back to idle after 2.5s
  expect(SRC).toContain('const LUCKY_MS = 2500;');
  expect(SRC).toMatch(/luckyTimer = setTimeout\(\(\) => \{\s*lucky\.value = false;/);
});

test('interaction 3: character switching cycles female / male and is persisted', () => {
  expect(SRC).toContain("const CHARACTER_IDS = ['female', 'male'];");
  expect(SRC).toContain('function switchCharacter()');
  expect(SRC).toMatch(/CHARACTER_IDS\[\(index \+ 1\) % CHARACTER_IDS\.length\]/);
  // the visible line and the fortune text follow the new character
  expect(SRC).toContain('function refreshBubble()');
});

test('collapse / restore: the header button shrinks the card into a 32px badge, the badge brings it back', () => {
  expect(SRC).toContain('function collapse()');
  expect(SRC).toContain('function expand()');
  expect(SRC).toContain('v-else');
  const badge = cssBlock('.khy-pet__badge');
  expect(badge).toContain('width: 32px;');
  expect(badge).toContain('height: 32px;');
  expect(badge).toContain('border-radius: 50%;');
});

test('the character image is about 132×132 and the card carries one row of small buttons', () => {
  const img = cssBlock('.khy-pet__img');
  expect(img).toContain('width: 132px;');
  expect(img).toContain('height: 132px;');
  expect(SRC).toContain('class="khy-pet__actions"');
  expect(SRC).toContain('class="khy-pet__omamori"');
  expect(SRC).toContain('class="khy-pet__switch"');
});

test('keyboard reachable: every clickable element is a native button with an aria-label', () => {
  const buttons = SRC.match(/<button[\s\S]*?>/g) || [];
  expect(buttons.length).toBeGreaterThanOrEqual(5);
  for (const tag of buttons) {
    expect(tag).toContain('aria-label');
    expect(tag).toContain('type="button"');
  }
  // no click handler outside a button
  const clicks = (SRC.match(/@click=/g) || []).length;
  expect(clicks).toBe(buttons.length);
});

test('respects prefers-reduced-motion (component ships its own fallback block)', () => {
  expect(SRC).toContain('prefers-reduced-motion');
  const block = SRC.match(/@media\s*\(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/);
  expect(block).not.toBeNull();
  expect(block[0]).toMatch(/animation:\s*none/);
});
