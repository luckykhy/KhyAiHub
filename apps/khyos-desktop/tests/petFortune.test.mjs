/**
 * petFortune —— 桌面端「每日一签」的真逻辑测试。
 *
 * 这一层跑的是真的算法（Node 22.6+ 类型剥离，直接 import .ts，不经构建），
 * 锁死三件事：
 *   ① FNV-1a 32 的标准向量 + UTF-8 字节口径；
 *   ② 跨端锚点：同一天同一角色，三端必须给出**同一个**种子/档位/提示/幸运色
 *      （锚点值由本仓共享数据源 delivery/brand/pet/pet-fortune.json 算出）；
 *   ③ 加权档位、提示与幸运色的派生位偏移不得漂移。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const {
  fnv1a32,
  localDateKey,
  dailyFortune,
  pickLine,
} = await import('../src/renderer/components/pet/petFortune.ts')

const projectRoot = join(import.meta.dirname, '..')
const fortune = JSON.parse(
  readFileSync(join(projectRoot, 'src', 'renderer', 'assets', 'pet', 'pet-fortune.json'), 'utf-8'),
)

function day(offsetDays) {
  const date = new Date(2026, 10, 3 + offsetDays, 12, 0, 0)
  return date
}

// ── ① FNV-1a 标准向量 ──────────────────────────────────────────

test('fnv1a32 命中 FNV-1a 32 官方测试向量', () => {
  assert.equal(fnv1a32(''), 0x811c9dc5)
  assert.equal(fnv1a32('a'), 0xe40c292c)
  assert.equal(fnv1a32('b'), 0xe70c2de5)
  assert.equal(fnv1a32('foobar'), 0xbf9cf968)
})

test('fnv1a32 按 UTF-8 字节算，不是按码元', () => {
  const bytes = Buffer.from('澪', 'utf8')
  let expected = 0x811c9dc5
  for (const byte of bytes) {
    expected = (expected ^ byte) >>> 0
    expected = Math.imul(expected, 0x01000193) >>> 0
  }
  assert.equal(fnv1a32('澪'), expected >>> 0)
  // 码元口径会得到别的值（说明断言真的在测字节而不是字符）
  assert.notEqual(fnv1a32('澪'), fnv1a32('a'))
})

test('localDateKey 输出 YYYY-MM-DD 的本地日历日', () => {
  assert.equal(localDateKey(new Date(2026, 10, 3, 23, 59)), '2026-11-03')
  assert.equal(localDateKey(new Date(2026, 0, 9, 0, 0)), '2026-01-09')
})

// ── ② 跨端锚点 ────────────────────────────────────────────────

test('跨端锚点：2026-11-03 澪的签三端必须一致', () => {
  const result = dailyFortune(fortune, 'female', new Date(2026, 10, 3, 9, 0))
  assert.equal(result.seed, 3218103208)
  assert.equal(result.level.label, '平稳')
  assert.equal(result.tip, '适合学一点新东西，一次只学一个点。')
  assert.equal(result.color?.name, '米白')
})

test('跨端锚点：2026-11-03 凯的签三端必须一致', () => {
  const result = dailyFortune(fortune, 'male', new Date(2026, 10, 3, 9, 0))
  assert.equal(result.seed, 1865385925)
  assert.equal(result.level.label, '小吉')
  assert.equal(result.tip, '适合在动手前先问一句「为什么现在要做」。')
  assert.equal(result.color?.name, '好运红')
})

test('跨端锚点：2026-11-03 锦鲤的签三端必须一致', () => {
  const result = dailyFortune(fortune, 'koi', new Date(2026, 10, 3, 9, 0))
  assert.equal(result.seed, 2058371121)
  assert.equal(result.level.label, '吉')
  assert.equal(result.tip, '适合把版本号和变更日志对齐。')
  assert.equal(result.color?.name, '好运红')
})

test('同一天同一角色结果恒定（每日一签）', () => {
  const morning = dailyFortune(fortune, 'female', new Date(2026, 10, 3, 8, 0))
  const night = dailyFortune(fortune, 'female', new Date(2026, 10, 3, 23, 30))
  assert.deepEqual(morning, night)
})

test('不同日期会给出不同的签（30 天里不止一档）', () => {
  const labels = new Set()
  for (let i = 0; i < 30; i += 1) {
    labels.add(dailyFortune(fortune, 'female', day(i)).level.label)
  }
  assert.ok(labels.size >= 2, `30 天里只出现了 ${labels.size} 档，播种没生效`)
})

// ── ③ 派生位偏移与加权档位 ──────────────────────────────────────

test('提示与幸运色由种子的第 8/16 位派生', () => {
  for (let i = 0; i < 20; i += 1) {
    const result = dailyFortune(fortune, 'female', day(i))
    assert.equal(result.tip, fortune.tips[(result.seed >>> 8) % fortune.tips.length])
    assert.equal(result.color?.name, fortune.luckyColors[(result.seed >>> 16) % fortune.luckyColors.length].name)
  }
})

test('档位按 levels[].weight 的累计区间命中', () => {
  const total = fortune.levels.reduce((sum, level) => sum + level.weight, 0)
  assert.equal(total, 10)
  for (let i = 0; i < 20; i += 1) {
    const result = dailyFortune(fortune, 'female', day(i))
    const remainder = result.seed % total
    let accumulated = 0
    let expected = null
    for (const candidate of fortune.levels) {
      accumulated += candidate.weight
      if (remainder < accumulated) {
        expected = candidate
        break
      }
    }
    assert.equal(result.level.id, expected?.id)
  }
})

test('权重决定分布：稀有权重很少被抽中', () => {
  const synthetic = {
    ...fortune,
    levels: [
      { id: 'rare', label: '稀有', weight: 1, hint: '' },
      { id: 'common', label: '常见', weight: 99, hint: '' },
    ],
  }
  let rare = 0
  for (let i = 0; i < 200; i += 1) {
    if (dailyFortune(synthetic, 'female', day(i)).level.id === 'rare') rare += 1
  }
  assert.ok(rare <= 8, `稀有档被抽中 ${rare} 次，权重区间没生效`)
})

// ── ④ 台词不重复 ──────────────────────────────────────────────

test('pickLine 不会连着说同一句', () => {
  const lines = ['a', 'b', 'c']
  for (let i = 0; i < 50; i += 1) {
    const line = pickLine(lines, 'a')
    assert.notEqual(line, 'a')
    assert.ok(lines.includes(line))
  }
  assert.equal(pickLine([], null), '')
  assert.equal(pickLine(['only'], null), 'only')
})
