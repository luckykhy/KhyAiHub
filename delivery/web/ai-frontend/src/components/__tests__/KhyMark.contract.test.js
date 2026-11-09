import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

// KhyMark 的路径数据必须与几何真源**逐字节一致**。
//
// 真源：delivery/brand/khy-brand-geometry.js（CJS）。
// 组件里之所以是副本而不是 import：Vite dev server 的 fs.allow 不覆盖仓根，
// 跨目录 import 会让 dev 与 build 的行为不一致。故用「副本 + 断言」锁住漂移 ——
// 改形状只能改真源，然后跑 `node scripts/brand/build-brand-assets.js`。

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..', '..', '..')

const geo = require(join(repoRoot, 'delivery', 'brand', 'khy-brand-geometry.js'))
const parts = geo.markParts()

const markSrc = readFileSync(join(here, '..', 'KhyMark.vue'), 'utf-8')

/** 只保留路径字符，让「源码里被引号与加号拆开的同一段路径」能被连续匹配。 */
function normalize(text) {
  return text.replace(/[^A-Za-z0-9.-]/g, '')
}

const normalizedSrc = normalize(markSrc)

describe('KhyMark 与品牌几何真源一致', () => {
  it('四段弧叶的路径逐条一致', () => {
    expect(parts.blades).toHaveLength(4)
    for (const d of parts.blades) {
      expect(normalizedSrc).toContain(normalize(d))
    }
  })

  it('菱形内核 + K 负槽的路径一致', () => {
    expect(normalizedSrc).toContain(normalize(parts.core))
  })

  it('旧版字母 K 单标已下线（kind="logo" 的手画 K 不得再出现）', () => {
    expect(markSrc).not.toContain('M8 5.2v13.6')
  })
})
