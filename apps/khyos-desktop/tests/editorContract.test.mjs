// editorContract.test.mjs — 内建代码编辑器工作台（DESIGN-ARCH-210）的跨进程契约守卫。
// 这里断言的是「三处各写一份就会漂移」的那几件事：
//   ① 上限常量只有 shared/editorContract.ts 一份，且数值关系自洽；
//   ② 主进程注册的通道名与 preload 暴露的调用名一一配对；
//   ③ 渲染层只走 editor:* 通道，绝不碰 fs:readFile / fs:writeFile 孤儿通道；
//   ④ 工作台保持 lazy 装载（CORE-LAYERS 首屏预算零容差），Monaco 只在 lazy 入口引入。
//
// Run: node --experimental-strip-types --test tests/editorContract.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = (...p) => path.join(here, '..', 'src', ...p)
const read = (...p) => fs.readFileSync(src(...p), 'utf8')

const C = await import('../src/shared/editorContract.ts')

test('上限常量集中在 editorContract，数值关系自洽', () => {
  assert.equal(C.EDITOR_READ_MAX_BYTES, 4 * 1024 * 1024)
  assert.equal(C.SEARCH_MAX_FILE_BYTES, 512 * 1024)
  assert.equal(C.SEARCH_MAX_TOTAL_BYTES, 64 * 1024 * 1024)
  assert.equal(C.SEARCH_MAX_HITS, 500)
  assert.equal(C.SEARCH_MAX_HIT_FILES, 200)
  assert.equal(C.SEARCH_MAX_HITS_PER_FILE, 20)
  assert.equal(C.SEARCH_BUDGET_MS, 15_000)
  assert.equal(C.WATCH_MAX_DIRS, 64)
  assert.equal(C.PENDING_REVIEW_TIMEOUT_MS, 120_000)
  // 单文件搜索上限必须小于可编辑上限：否则「能搜到却打不开」的割裂
  assert.ok(C.SEARCH_MAX_FILE_BYTES < C.EDITOR_READ_MAX_BYTES)
  // 单文件命中上限 × 命中文件上限不得低于总命中上限（否则后两个上限永远不生效）
  assert.ok(C.SEARCH_MAX_HITS_PER_FILE * C.SEARCH_MAX_HIT_FILES >= C.SEARCH_MAX_HITS)
  assert.ok(C.SEARCH_YIELD_EVERY_FILES < C.SEARCH_PROGRESS_EVERY_FILES)
})

test('搜索实现引用契约常量，而不是各写一份字面量', () => {
  const text = read('main', 'editor', 'search.ts')
  for (const name of [
    'SEARCH_MAX_FILE_BYTES',
    'SEARCH_MAX_TOTAL_BYTES',
    'SEARCH_MAX_HITS',
    'SEARCH_MAX_HIT_FILES',
    'SEARCH_MAX_HITS_PER_FILE',
    'SEARCH_BUDGET_MS',
  ]) {
    assert.match(text, new RegExp(`\\b${name}\\b`), `search.ts 应引用 ${name} 而非另写字面量`)
  }
  // RUNTIME-003：时间预算只用协作式检查，不得出现 kill/abort 定时器
  assert.doesNotMatch(text, /setTimeout\s*\(/)
  assert.doesNotMatch(text, /\.kill\s*\(/)
})

test('主进程注册的 editor:* 通道与 preload 暴露的调用一一配对', () => {
  const mainIpc = read('main', 'editor', 'ipc.ts')
  const preload = read('preload', 'editor.ts')

  const mainChannels = [...mainIpc.matchAll(/handle\(\s*'([^']+)'/g)].map((m) => m[1]).sort()
  const preloadChannels = [...preload.matchAll(/invoke\(\s*'([^']+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(mainChannels, preloadChannels, '主进程与 preload 的通道集合必须完全一致')

  const expect = [
    'editor:read',
    'editor:write',
    'editor:create-file',
    'editor:search',
    'editor:search-cancel',
    'editor:watch-set',
    'editor:pending-list',
    'editor:pending-decision',
  ]
  assert.deepEqual(mainChannels, [...expect].sort())

  // 待审事件经 sendToRenderer 转发（通道名是字面量参数），两条形态都要算进集合，
  // 否则「主进程有发、preload 没人听」会被漏掉。
  const mainEvents = [
    ...mainIpc.matchAll(/\.send\(\s*'([^']+)'/g),
    ...mainIpc.matchAll(/sendToRenderer\(\s*'([^']+)'/g),
  ].map((m) => m[1]).sort()
  const preloadEvents = [...preload.matchAll(/(?:on|removeListener)\(\s*'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual([...new Set(mainEvents)].sort(), [...new Set(preloadEvents)].sort())
  for (const ch of mainChannels) assert.match(ch, /^editor:[a-z][a-z-]*$/)
})

test('渲染层工作台只走 editor 桥，不碰 fs:readFile / fs:writeFile 孤儿通道', () => {
  const dir = src('renderer', 'components', 'editor')
  for (const name of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8')
    assert.doesNotMatch(text, /fs:(read|write)File/, `${name} 不得调用无白名单的 fs:* 孤儿通道`)
    assert.doesNotMatch(text, /ipcRenderer/, `${name} 不得绕过 editorApi 直接摸 ipcRenderer`)
  }
  const preload = read('preload', 'editor.ts')
  assert.doesNotMatch(preload, /fs:(read|write)File/)
})

test('工作台保持 lazy 装载，AppLayout 不得静态 import 它', () => {
  const layout = read('renderer', 'components', 'layout', 'AppLayout.tsx')
  assert.match(layout, /const\s+EditorWorkbench\s*=\s*lazy\(/, '工作台必须以内联 lazy() 引入')
  assert.doesNotMatch(layout, /^import[^\n]*EditorWorkbench/m, 'AppLayout 不得静态 import EditorWorkbench')
  assert.match(layout, /<Suspense/, 'lazy 组件必须包在 Suspense 内')
})

test('Monaco 只在 lazy 入口引入，不进首屏 main.tsx', () => {
  const mainEntry = read('renderer', 'main.tsx')
  assert.doesNotMatch(mainEntry, /import\s+['"][^'"]*monacoSetup['"]/, '首屏入口不得 import monacoSetup')
  for (const rel of [
    ['renderer', 'components', 'editor', 'EditorSurface.tsx'],
    ['renderer', 'components', 'viewer', 'CodeEditorPane.tsx'],
  ]) {
    assert.match(read(...rel), /import\s+['"][^'"]*monacoSetup['"]/, `${rel.join('/')} 应自行引入 monacoSetup`)
  }
})

test('语言与运行器表只有一份（编辑器与旧查看面板共用）', () => {
  const shared = read('renderer', 'components', 'editor', 'editorLanguages.ts')
  assert.match(shared, /export\s+function\s+languageForPath/)
  assert.match(shared, /export\s+function\s+runnerForPath/)
  const pane = read('renderer', 'components', 'viewer', 'CodeEditorPane.tsx')
  assert.match(pane, /from '\.\.\/editor\/editorLanguages'/, '旧查看面板应复用同一张语言表')
  assert.doesNotMatch(pane, /const\s+LANGUAGES\s*=/, '旧查看面板不得再留一份 LANGUAGES')
  assert.doesNotMatch(pane, /const\s+RUNNERS\s*=/, '旧查看面板不得再留一份 RUNNERS')
})

test('忽略目录与可索引扩展名收敛到 workspaceRules 单一真源', () => {
  const index = read('main', 'index.ts')
  assert.match(index, /from '\.\/editor\/workspaceRules'/, 'main/index.ts 应从 workspaceRules 引入')
  assert.doesNotMatch(index, /const\s+SKIP_DIRS\s*=/, 'main/index.ts 不得再留一份 SKIP_DIRS')
  assert.doesNotMatch(index, /const\s+TEXT_EXTS\s*=/, 'main/index.ts 不得再留一份 TEXT_EXTS')
})
