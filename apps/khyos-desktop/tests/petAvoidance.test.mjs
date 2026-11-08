/**
 * petAvoidance —— 桌宠「挡住字就自己挪开」的判定逻辑测试。
 *
 * 这一层跑的是纯函数（Node 22.6+ 类型剥离，直接 import .ts，不经构建），
 * 锁死四件事：
 *   ① 覆盖度：文字矩形与桌宠足迹的交集面积占比；
 *   ② 压住几行：触发条件按「行」算，不按面积阈值算（否则一行小字就够把
 *      桌宠逼走，而一行长字反而不触发）；
 *   ③ 候选位与逃逸选择：只在「明显更空」时才挪，且同样空时走近的；
 *   ④ 回家条件：家那边清了、且连续清够次数才回，避免来回蹦。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const {
  overlapArea,
  coverageRatio,
  blockedLines,
  candidateSlots,
  slotRect,
  chooseEscapeSlot,
  shouldReturnHome,
  IMPROVE_FACTOR,
  CLEAR_RATIO,
  HOME_CLEAR_STREAK,
  MIN_BLOCKED_WIDTH,
  MIN_BLOCKED_HEIGHT,
} = await import('../src/renderer/components/pet/petAvoidance.ts')

function rect(left, top, width, height) {
  return { left, top, right: left + width, bottom: top + height }
}

// ── ① 覆盖度 ──────────────────────────────────────────────────

test('① 覆盖度：重叠面积占比，0 与 1 两端正确', () => {
  const card = rect(0, 0, 100, 100)
  assert.equal(overlapArea(card, rect(200, 200, 10, 10)), 0)
  assert.equal(overlapArea(card, rect(50, 50, 50, 50)), 2500)
  // 完全覆盖
  assert.equal(coverageRatio(card, [rect(0, 0, 100, 100)]), 1)
  // 完全不重叠
  assert.equal(coverageRatio(card, [rect(200, 200, 10, 10)]), 0)
  // 半个
  assert.equal(coverageRatio(card, [rect(0, 0, 50, 100)]), 0.5)
})

test('① 覆盖度：多段文字的覆盖面积相加，且结果不超过 1', () => {
  const card = rect(0, 0, 100, 100)
  const spans = [rect(0, 0, 20, 100), rect(80, 0, 20, 100)]
  assert.equal(coverageRatio(card, spans), 0.4)
  // 极端输入（理论重叠）也必须被夹在 1 以内
  const overlapping = [rect(0, 0, 100, 100), rect(0, 0, 100, 100)]
  assert.equal(coverageRatio(card, overlapping), 1)
})

// ── ② 压住几行 ────────────────────────────────────────────────

test('② 压住几行：一行文字被盖住即算一行', () => {
  const card = rect(0, 0, 148, 196)
  // 一条 16px 高的文字行横穿卡片
  assert.equal(blockedLines(card, [rect(10, 40, 100, 16)]), 1)
  // 三行 → 三行
  assert.equal(
    blockedLines(card, [rect(10, 40, 100, 16), rect(10, 60, 100, 16), rect(10, 80, 100, 16)]),
    3,
  )
})

test('② 压住几行：擦边不算（宽度或高度不够就忽略）', () => {
  const card = rect(0, 0, 148, 196)
  // 宽度不足 MIN_BLOCKED_WIDTH
  assert.equal(blockedLines(card, [rect(10, 40, MIN_BLOCKED_WIDTH - 1, 16)]), 0)
  // 高度不足 MIN_BLOCKED_HEIGHT
  assert.equal(blockedLines(card, [rect(10, 40, 100, MIN_BLOCKED_HEIGHT - 1)]), 0)
  // 完全不相交
  assert.equal(blockedLines(card, [rect(500, 500, 100, 16)]), 0)
})

test('② 压住几行：擦边判定用的是「被盖住的那一段」，不是文字全长', () => {
  const card = rect(0, 0, 148, 196)
  // 一条很长的文字，只有尾巴 4px 探进卡片 → 不算挡住了
  assert.equal(blockedLines(card, [rect(-500, 40, 504, 16)]), 0)
  // 同一条文字，有 30px 在卡片里 → 算挡住了
  assert.equal(blockedLines(card, [rect(-500, 40, 530, 16)]), 1)
})

// ── ③ 候选位与逃逸选择 ────────────────────────────────────────

test('③ 候选位：四角与四边中点，且都留在视口内', () => {
  const slots = candidateSlots(1200, 800, 148, 196, 12)
  assert.equal(slots.length, 8)
  for (const slot of slots) {
    assert.ok(slot.left >= 0, `${slot.id} 左边越界`)
    assert.ok(slot.top >= 0, `${slot.id} 上边越界`)
    assert.ok(slot.left + 148 <= 1200, `${slot.id} 右边越界`)
    assert.ok(slot.top + 196 <= 800, `${slot.id} 下边越界`)
  }
  const ids = slots.map((s) => s.id)
  for (const id of ['bottom-left', 'bottom-right', 'top-left', 'top-right']) {
    assert.ok(ids.includes(id), `缺少候选位 ${id}`)
  }
})

test('③ 逃逸选择：明显更空的位置才被选中', () => {
  const slots = candidateSlots(1200, 800, 148, 196, 12)
  const current = { left: 24, top: 800 - 196 - 24 }
  // bottom-right 全空（0），其余都压着字（0.5）→ 唯一解
  const ratios = new Map(slots.map((s) => [s.id, 0.5]))
  ratios.set('bottom-right', 0)
  const picked = chooseEscapeSlot({
    slots,
    current,
    currentRatio: 0.5,
    coverageOf: (slot) => ratios.get(slot.id) ?? 0.5,
  })
  assert.ok(picked, '应该选出一个位置')
  assert.equal(picked.id, 'bottom-right')
})

test('③ 逃逸选择：没有明显更空的位置就原地不动', () => {
  const slots = candidateSlots(1200, 800, 148, 196, 12)
  const current = { left: 24, top: 800 - 196 - 24 }
  // 所有候选位都一样挤（0.5），当前也是 0.5 → 不该挪
  const picked = chooseEscapeSlot({
    slots,
    current,
    currentRatio: 0.5,
    coverageOf: () => 0.5,
  })
  assert.equal(picked, null)
})

test('③ 逃逸选择：同样空时走近的那个（少走路）', () => {
  const slots = candidateSlots(1200, 800, 148, 196, 12)
  const current = { left: 24, top: 800 - 196 - 24 }
  // 全部为空 → 选离当前最近的
  const picked = chooseEscapeSlot({
    slots,
    current,
    currentRatio: 0.5,
    coverageOf: () => 0,
  })
  assert.ok(picked)
  const dist = (s) => Math.hypot(s.left - current.left, s.top - current.top)
  const nearest = slots
    .filter((s) => !(s.left === current.left && s.top === current.top))
    .reduce((a, b) => (dist(a) <= dist(b) ? a : b))
  assert.equal(picked.id, nearest.id)
})

test('③ 逃逸选择：绝不选「当前所在的那个位置」', () => {
  const slots = candidateSlots(1200, 800, 148, 196, 12)
  const current = { left: 12, top: 800 - 196 - 12 } // 正好是 bottom-left
  const picked = chooseEscapeSlot({
    slots,
    current,
    currentRatio: 0.9,
    // 只有 bottom-left 是空的（它被排除），其余都挤 → 仍要挑一个更空的
    coverageOf: (slot) => (slot.left === current.left && slot.top === current.top ? 0 : 0.4),
  })
  assert.ok(picked)
  assert.notEqual(picked.id, 'bottom-left')
})

test('③ 逃逸选择：稍微好一点不算「明显更好」', () => {
  const slots = candidateSlots(1200, 800, 148, 196, 12)
  const current = { left: 24, top: 800 - 196 - 24 }
  // 当前 0.5，最优 0.3 —— 0.3 > 0.5 * IMPROVE_FACTOR(0.5)=0.25 → 不挪
  const ratios = new Map(slots.map((s) => [s.id, 0.3]))
  ratios.set('bottom-left', 0.5)
  const picked = chooseEscapeSlot({
    slots,
    current,
    currentRatio: 0.5,
    coverageOf: (slot) => ratios.get(slot.id) ?? 0.3,
  })
  assert.equal(picked, null)
})

test('③ 逃逸选择：明显更好（≤ IMPROVE_FACTOR 倍）就挪', () => {
  const slots = candidateSlots(1200, 800, 148, 196, 12)
  const current = { left: 24, top: 800 - 196 - 24 }
  const target = 0.5 * IMPROVE_FACTOR
  const ratios = new Map(slots.map((s) => [s.id, target]))
  ratios.set('bottom-left', 0.5)
  const picked = chooseEscapeSlot({
    slots,
    current,
    currentRatio: 0.5,
    coverageOf: (slot) => ratios.get(slot.id) ?? target,
  })
  assert.ok(picked, '明显更好时应该挪')
})

test('③ 逃逸选择：当前脚下没字时不动（没有躲避的必要）', () => {
  const slots = candidateSlots(1200, 800, 148, 196, 12)
  const picked = chooseEscapeSlot({
    slots,
    current: { left: 24, top: 800 - 196 - 24 },
    currentRatio: 0,
    coverageOf: () => 0,
  })
  assert.equal(picked, null)
})

// ── ④ 回家条件 ────────────────────────────────────────────────

test('④ 回家：家那边还有字就不回', () => {
  assert.equal(shouldReturnHome({ homeBlocked: true, clearStreak: 99 }), false)
})

test('④ 回家：家清了但次数不够也不回（防来回蹦）', () => {
  assert.equal(shouldReturnHome({ homeBlocked: false, clearStreak: HOME_CLEAR_STREAK - 1 }), false)
  assert.equal(shouldReturnHome({ homeBlocked: false, clearStreak: HOME_CLEAR_STREAK }), true)
})

// ── 槽位矩形 ──────────────────────────────────────────────────

test('槽位矩形：位置 + 尺寸，落在视口内', () => {
  const slot = { id: 'top-left', left: 12, top: 12 }
  const r = slotRect(slot, 148, 196)
  assert.deepEqual(r, { left: 12, top: 12, right: 160, bottom: 208 })
})

// ── 常量口径 ──────────────────────────────────────────────────

test('常量：清空阈值与改进系数符合口径', () => {
  assert.equal(CLEAR_RATIO, 0.02)
  assert.equal(IMPROVE_FACTOR, 0.5)
  assert.equal(HOME_CLEAR_STREAK, 2)
})
