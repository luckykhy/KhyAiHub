<template>
  <!--
    KhyPet — Lucky-themed community desktop pet for the web client.

    Spec highlights (identical across web / desktop / mobile):
      · An in-app floating card (NOT a system-level overlay window). It rests
        in the bottom-left corner by default (left 24 / bottom 24) to stay
        clear of KhyFloatBall in the bottom-right.
      · The hit area is the card itself only: the outer layer is
        pointer-events: none, the card is auto — every click on the rest of
        the page must still reach the page.
      · Drag the character image to move the card; the drop point is persisted
        to localStorage (khy_pet_pos).
      · Three interactions: tap the character for an idle line, tap the
        omamori button to draw a fortune, switch character (Mio / Kai).
      · Collapsing the card shrinks it into a 32px real-brand badge; tapping
        the badge brings it back.

    Data and algorithm are shared with the desktop and mobile clients:
    src/data/pet-fortune.json + src/utils/petFortune.js (see the algorithm
    notes in that file's header).
  -->
  <div ref="rootEl" class="khy-pet" :class="{ 'is-dragging': dragging }" :style="cardStyle">
    <div v-if="!collapsed" class="khy-pet__card">
      <div class="khy-pet__head">
        <KhyMark :aria-label="brandName" class="khy-pet__mark" size="sm" />
        <span class="khy-pet__brand">{{ brandName }}</span>
        <button
          :aria-label="actions.collapse"
          class="khy-pet__collapse"
          :title="actions.hide"
          type="button"
          @click="collapse"
        >
          <span aria-hidden="true">－</span>
        </button>
      </div>

      <div class="khy-pet__stage">
        <button
          :aria-label="greetLabel"
          class="khy-pet__avatar"
          :class="{ 'is-lucky': lucky }"
          type="button"
          @click="onAvatarClick"
          @pointerdown="onPointerDown"
        >
          <img :alt="characterAlt" class="khy-pet__img" draggable="false" :src="characterImage" />
        </button>

        <div v-if="bubble" aria-live="polite" class="khy-pet__bubble" role="status">
          <p v-if="bubble.levelLabel" class="khy-pet__bubble-level">{{ bubble.levelLabel }}</p>
          <p class="khy-pet__bubble-text">{{ bubble.text }}</p>
          <p v-if="bubble.colorName" class="khy-pet__bubble-color">
            <span aria-hidden="true" class="khy-pet__bubble-swatch" :style="{ background: bubble.colorHex }" />
            {{ bubble.colorName }}
          </p>
        </div>
      </div>

      <div class="khy-pet__actions">
        <button
          :aria-label="actions.draw"
          class="khy-pet__omamori"
          :title="actions.draw"
          type="button"
          @click="drawFortune"
        >
          <KhyMark aria-hidden="true" class="khy-pet__omamori-mark" tone="ink" />
        </button>
        <button
          :aria-label="switchLabel"
          class="khy-pet__switch"
          type="button"
          @click="switchCharacter"
        >
          {{ characterName }}
        </button>
      </div>
    </div>

    <button
      v-else
      :aria-label="actions.show"
      class="khy-pet__badge"
      :title="actions.show"
      type="button"
      @click="expand"
    >
      <KhyMark aria-hidden="true" class="khy-pet__badge-mark" tone="ink" />
    </button>
  </div>
</template>

<script setup>
/**
 * KhyPet — Lucky-themed community desktop pet for the web client.
 *
 * Three interactions: tap the character (an idle line), tap the omamori
 * button (draw a fortune), switch character (Mio / Kai) — plus collapse and
 * restore. Every piece of state is persisted locally (localStorage); no new
 * IPC channel is introduced.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { safeGet, safeSet } from '@/utils/safeStorage';
import { dailyFortune, localDateKey } from '@/utils/petFortune';
import petData from '@/data/pet-fortune.json';

import KhyMark from './KhyMark.vue';

// ── Constants ──────────────────────────────────────────────────────────────
const POS_KEY = 'khy_pet_pos'; // drag drop point {left, top}
const CHAR_KEY = 'khy_pet_char'; // current character 'female' | 'male'
const HIDDEN_KEY = 'khy_pet_hidden'; // collapsed state '1' | '0'
const CHARACTER_IDS = ['female', 'male'];
const DRAG_THRESHOLD = 4; // px: below this the gesture counts as a click
const BUBBLE_MS = 2500; // bubble auto-hide
const LUCKY_MS = 2500; // lucky pose duration before falling back to idle

// ── State ──────────────────────────────────────────────────────────────────
const rootEl = ref(null);
const dragging = ref(false);
const collapsed = ref(loadHidden());
const characterId = ref(loadCharacter());
const lucky = ref(false);
const bubble = ref(null);
const pos = ref(loadPos()); // null = default corner (CSS), otherwise the drop point

let bubbleTimer = null;
let luckyTimer = null;
let lastIdleIndex = -1; // index of the previous idle line: never repeat it

// ── Local storage ──────────────────────────────────────────────────────────
function loadCharacter() {
  const saved = safeGet(CHAR_KEY);
  return CHARACTER_IDS.indexOf(saved) >= 0 ? saved : CHARACTER_IDS[0];
}

function loadHidden() {
  return safeGet(HIDDEN_KEY) === '1';
}

function loadPos() {
  try {
    const raw = JSON.parse(safeGet(POS_KEY) || 'null');
    if (raw && Number.isFinite(raw.left) && Number.isFinite(raw.top)) {
      return { left: Math.max(0, raw.left), top: Math.max(0, raw.top) };
    }
  } catch {
    /* invalid storage → default corner */
  }
  return null;
}

function savePos() {
  if (!pos.value) return;
  safeSet(POS_KEY, JSON.stringify({ left: pos.value.left, top: pos.value.top }));
}

// ── Viewport helpers ───────────────────────────────────────────────────────
function winW() {
  return (typeof window !== 'undefined' && window.innerWidth) || 1280;
}

function winH() {
  return (typeof window !== 'undefined' && window.innerHeight) || 800;
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

// ── Derived state ──────────────────────────────────────────────────────────
const brandName = computed(() => petData.brand.name);
const actions = computed(() => petData.actions);
const character = computed(
  () => petData.characters[characterId.value] || petData.characters[CHARACTER_IDS[0]]
);
const characterName = computed(() => character.value.name);
const characterAlt = computed(() => `${character.value.name}·${character.value.title}`);
const characterImage = computed(
  () => `/brand/pet/khy-pet-${characterId.value}-${lucky.value ? 'lucky' : 'idle'}.png`
);
const greetLabel = computed(() => `${actions.value.greet}·${characterName.value}`);
const switchLabel = computed(() => `切换角色（当前：${characterName.value}）`);

// With a drop point we position by left/top (bottom must go to auto, otherwise
// the vertical anchoring would fight the stored top).
const cardStyle = computed(() => {
  if (!pos.value) return {};
  return {
    left: `${pos.value.left}px`,
    top: `${pos.value.top}px`,
    bottom: 'auto',
  };
});

// ── Bubble ─────────────────────────────────────────────────────────────────
function showBubble(next) {
  bubble.value = next;
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    bubble.value = null;
  }, BUBBLE_MS);
}

function fortuneBubble(fortune) {
  return {
    kind: 'fortune',
    levelLabel: fortune.level ? fortune.level.label : '',
    text: fortune.level ? fortune.level.hint : fortune.tip,
    colorName: fortune.color ? fortune.color.name : '',
    colorHex: fortune.color ? fortune.color.hex : 'transparent',
  };
}

// ── Interaction 1: tap the character → a random idle line (never the last) ─
function greet() {
  const lines = character.value.idle || [];
  if (!lines.length) return;
  let index = Math.floor(Math.random() * lines.length);
  if (lines.length > 1 && index === lastIdleIndex) index = (index + 1) % lines.length;
  lastIdleIndex = index;
  showBubble({
    kind: 'idle',
    levelLabel: '',
    text: lines[index],
    colorName: '',
    colorHex: 'transparent',
  });
}

function onAvatarClick() {
  if (dragging.value) return; // just finished a drag → swallow this click
  greet();
}

// ── Interaction 2: tap the omamori → draw a fortune (same result per day) ──
function drawFortune() {
  const fortune = dailyFortune(localDateKey(), characterId.value, petData);
  lucky.value = true;
  showBubble(fortuneBubble(fortune));
  if (luckyTimer) clearTimeout(luckyTimer);
  luckyTimer = setTimeout(() => {
    lucky.value = false;
  }, LUCKY_MS);
}

// ── Interaction 3: switch character (Mio ↔ Kai), lines and fortune follow ──
function switchCharacter() {
  const index = CHARACTER_IDS.indexOf(characterId.value);
  characterId.value = CHARACTER_IDS[(index + 1) % CHARACTER_IDS.length];
  safeSet(CHAR_KEY, characterId.value);
  lastIdleIndex = -1;
  if (bubble.value) refreshBubble();
}

// After a character switch the visible bubble is recomputed for the new
// character (a new idle line, or the fortune drawn for that character).
function refreshBubble() {
  if (!bubble.value) return;
  if (bubble.value.kind === 'fortune') {
    showBubble(fortuneBubble(dailyFortune(localDateKey(), characterId.value, petData)));
  } else {
    greet();
  }
}

// ── Collapse / restore ─────────────────────────────────────────────────────
function collapse() {
  collapsed.value = true;
  safeSet(HIDDEN_KEY, '1');
}

function expand() {
  collapsed.value = false;
  safeSet(HIDDEN_KEY, '0');
}

// ── Drag: press the character image and move; the drop point is persisted ──
let dragState = null;
let rafId = null;
let pendingEvent = null;
let prevUserSelect = '';

function onPointerDown(e) {
  if (!rootEl.value) return;
  if (typeof e.button === 'number' && e.button !== 0) return; // primary button only
  const rect = rootEl.value.getBoundingClientRect();
  dragState = {
    startX: e.clientX,
    startY: e.clientY,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    vw: winW(), // viewport snapshot: the drag hot path reads no DOM
    vh: winH(),
    moved: false,
  };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

// Pointer moves are buffered and flushed once per animation frame.
function onPointerMove(e) {
  if (!dragState) return;
  pendingEvent = e;
  if (rafId == null) rafId = requestAnimationFrame(flushDrag);
}

function flushDrag() {
  rafId = null;
  const e = pendingEvent;
  pendingEvent = null;
  if (!e || !dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  if (!dragState.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return; // leave it to the click
  if (!dragState.moved) {
    dragState.moved = true;
    dragging.value = true;
    lockTextSelection(true); // no text selection while dragging
  }
  const maxLeft = Math.max(0, dragState.vw - dragState.width);
  const maxTop = Math.max(0, dragState.vh - dragState.height);
  pos.value = {
    left: clamp(dragState.left + dx, 0, maxLeft),
    top: clamp(dragState.top + dy, 0, maxTop),
  };
}

function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerUp);
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  pendingEvent = null;
  lockTextSelection(false);
  if (dragState && dragState.moved) {
    savePos();
    setTimeout(() => {
      dragging.value = false;
    }, 0); // swallow the click that ends the drag
  }
  dragState = null;
}

// No text selection while dragging (otherwise a drag becomes a text swipe).
function lockTextSelection(locked) {
  if (typeof document === 'undefined' || !document.body) return;
  if (locked) {
    prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
  } else {
    document.body.style.userSelect = prevUserSelect;
    prevUserSelect = '';
  }
}

// On resize / first mount the drop point is clamped back into the viewport so
// the card can never end up off-screen for good.
function clampIntoViewport() {
  if (!pos.value || !rootEl.value) return;
  const rect = rootEl.value.getBoundingClientRect();
  pos.value = {
    left: clamp(pos.value.left, 0, Math.max(0, winW() - rect.width)),
    top: clamp(pos.value.top, 0, Math.max(0, winH() - rect.height)),
  };
}

function onResize() {
  clampIntoViewport();
}

onMounted(() => {
  window.addEventListener('resize', onResize, { passive: true });
  clampIntoViewport();
});

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerUp);
  window.removeEventListener('resize', onResize);
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  pendingEvent = null;
  lockTextSelection(false);
  if (bubbleTimer) clearTimeout(bubbleTimer);
  if (luckyTimer) clearTimeout(luckyTimer);
});
</script>

<style scoped>
.khy-pet {
  position: fixed;
  left: 24px;
  bottom: 24px;
  /* Above the page content, below Element Plus dialogs and KhyFloatBall (3000) */
  z-index: 1200;
  /* The hit area is the card itself: this layer blocks nothing */
  pointer-events: none;
  font-family: var(--khy-font);
  color: var(--khy-text-main);
}

/* ── Card ──────────────────────────────────────────────────────────────── */
.khy-pet__card {
  pointer-events: auto;
  width: 148px;
  padding: 8px 8px 10px;
  border: 1px solid var(--khy-border);
  border-radius: var(--khy-radius-lg);
  background: var(--khy-bg-elevated);
  box-shadow: var(--khy-shadow-lift);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.khy-pet__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px 2px;
}
.khy-pet__mark {
  width: 16px;
  height: 16px;
  flex: none;
}
.khy-pet__brand {
  font-size: var(--khy-text-xs);
  font-weight: 600;
  color: var(--khy-text-secondary);
}
.khy-pet__collapse {
  margin-left: auto;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: var(--khy-radius-sm);
  background: transparent;
  color: var(--khy-text-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.khy-pet__collapse:hover {
  background: var(--khy-bg-hover);
  color: var(--khy-text-main);
}

/* ── Character image (draggable) ───────────────────────────────────────── */
.khy-pet__stage {
  position: relative;
  display: flex;
  justify-content: center;
}
.khy-pet__avatar {
  width: 132px;
  height: 132px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: grab;
  touch-action: none;
  user-select: none;
  display: block;
}
.khy-pet__avatar:focus-visible {
  outline: 2px solid var(--khy-accent);
  outline-offset: 2px;
}
.khy-pet.is-dragging .khy-pet__avatar {
  cursor: grabbing;
}
.khy-pet__img {
  width: 132px;
  height: 132px;
  object-fit: contain;
  display: block;
  pointer-events: none;
}
.khy-pet__avatar.is-lucky {
  animation: khy-pet-lucky 0.7s ease-in-out infinite alternate;
}
@keyframes khy-pet-lucky {
  from {
    transform: translateY(0);
  }
  to {
    transform: translateY(-3px);
  }
}

/* ── Bubble (idle line / fortune) ─────────────────────────────────────── */
.khy-pet__bubble {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  width: 200px;
  max-width: calc(100vw - 48px);
  padding: 10px 12px;
  border: 1px solid var(--khy-accent-soft);
  border-radius: var(--khy-radius-md);
  background: var(--khy-bg-elevated);
  box-shadow: var(--khy-shadow-lift);
  pointer-events: none;
  animation: khy-pet-bubble-in 0.22s var(--khy-easing-enter) both;
}
.khy-pet__bubble::after {
  content: '';
  position: absolute;
  left: 22px;
  bottom: -6px;
  width: 10px;
  height: 10px;
  border-right: 1px solid var(--khy-accent-soft);
  border-bottom: 1px solid var(--khy-accent-soft);
  background: var(--khy-bg-elevated);
  transform: rotate(45deg);
}
@keyframes khy-pet-bubble-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.khy-pet__bubble-level {
  margin: 0 0 4px;
  font-size: var(--khy-text-lg);
  font-weight: 700;
  color: var(--khy-accent);
}
.khy-pet__bubble-text {
  margin: 0;
  font-size: var(--khy-text-sm);
  line-height: var(--khy-leading-normal);
  color: var(--khy-text-main);
}
.khy-pet__bubble-color {
  margin: 6px 0 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--khy-text-xs);
  color: var(--khy-text-secondary);
}
.khy-pet__bubble-swatch {
  width: 12px;
  height: 12px;
  flex: none;
  border: 1px solid var(--khy-border);
  border-radius: 3px;
}

/* ── Button row: omamori (draw) + character switch ─────────────────────── */
.khy-pet__actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.khy-pet__omamori {
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid var(--khy-accent-soft);
  border-radius: 50%;
  background: var(--khy-accent-soft);
  color: var(--khy-accent);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.14s var(--khy-easing-standard);
}
.khy-pet__omamori:hover {
  transform: scale(1.06);
}
.khy-pet__omamori-mark {
  width: 18px;
  height: 18px;
}
.khy-pet__switch {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--khy-border);
  border-radius: 999px;
  background: transparent;
  color: var(--khy-text-secondary);
  font-size: var(--khy-text-xs);
  cursor: pointer;
}
.khy-pet__switch:hover {
  border-color: var(--khy-accent);
  color: var(--khy-accent);
}

/* ── Collapsed state: 32px real-brand badge ───────────────────────────── */
.khy-pet__badge {
  pointer-events: auto;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--khy-accent-soft);
  border-radius: 50%;
  background: var(--khy-accent-soft);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: khy-pet-breathe 2.8s ease-in-out infinite;
}
.khy-pet__badge-mark {
  width: 20px;
  height: 20px;
}
@keyframes khy-pet-breathe {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.08);
  }
}

@media (prefers-reduced-motion: reduce) {
  .khy-pet__bubble,
  .khy-pet__badge,
  .khy-pet__avatar.is-lucky {
    animation: none;
  }
  .khy-pet__omamori {
    transition: none;
  }
}
</style>
