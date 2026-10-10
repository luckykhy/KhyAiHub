// wiringRuntime.test.mjs — 接线运行态验证（[DESIGN-ARCH-171]）。
//
// 与 check-f2e-wiring.js 的分工：
//   · check-f2e-wiring.js  —— 静态审计源码里的通道字符串（改前误报 25 项，见 171 §1.3）
//   · 本文件               —— 真的调用 registerKeyManagerIpc()，看运行态实际注册了什么
// 两者互为独立口径：静态判据可以因正则收窄而失真，运行态不会。
//
// 第三组断言覆盖「按钮响应」：renderer 每处 `await api.xxx()` 必须消费返回值
// （r.ok / r.data / r.error），否则用户点了会静默无反应。
//
// Run: node --experimental-strip-types --test apps/khyos-desktop/tests/wiringRuntime.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerKeyManagerIpc } from '../src/main/keyManager/ipc.ts'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => (existsSync(join(projectRoot, p)) ? readFileSync(join(projectRoot, p), 'utf-8') : '')

// preload 侧真实暴露的 25 个通道（真源：src/preload/index.ts:176-212）
const PRELOAD_CHANNELS = [
  'keys:list', 'keys:add', 'keys:update', 'keys:remove', 'keys:toggle', 'keys:reveal', 'keys:import',
  'providers:list', 'providers:add', 'providers:remove',
  'endpoints:presets', 'endpoints:validate', 'models:fetch',
  'cards:list', 'cards:add', 'cards:update', 'cards:remove',
  'agents:matrix', 'agents:apply', 'agents:revert',
  'proxy:status', 'proxy:start',
  'health:probe', 'health:audit-list', 'health:audit-export'
]

function captureRegistration() {
  const handlers = new Map()
  const ipc = { handle(ch, fn) { handlers.set(ch, fn) }, on() {} }
  registerKeyManagerIpc(ipc)
  return handlers
}

test('运行态：registerKeyManagerIpc 实际注册 preload 暴露的全部 25 个通道', () => {
  const handlers = captureRegistration()
  const missing = PRELOAD_CHANNELS.filter((ch) => !handlers.has(ch))
  assert.equal(handlers.size, 25, `实际注册 ${handlers.size} 个，期望 25`)
  assert.deepEqual(missing, [], `未注册：${missing.join(', ')}`)
})

test('运行态：注册无重复（重复注册静默覆盖，是真实事故形态）', () => {
  const channels = []
  const ipc = { handle(ch) { channels.push(ch) }, on() {} }
  registerKeyManagerIpc(ipc)
  const dup = [...new Set(channels.filter((ch, i) => channels.indexOf(ch) !== i))]
  assert.deepEqual(dup, [], `重复注册：${dup.join(', ')}`)
})

test('运行态：25 个 handler 全是函数（非 undefined 占位）', () => {
  const handlers = captureRegistration()
  for (const ch of PRELOAD_CHANNELS) {
    assert.equal(typeof handlers.get(ch), 'function', `${ch} 的 handler 不是函数`)
  }
})

test('运行态：只读通道真调用返回 {ok:true,data}（非空壳）', async () => {
  const handlers = captureRegistration()
  const ev = { sender: { id: 1 } }
  const readOnly = ['keys:list', 'providers:list', 'endpoints:presets', 'cards:list', 'agents:matrix', 'proxy:status', 'health:audit-list']
  for (const ch of readOnly) {
    const r = await handlers.get(ch)(ev, undefined)
    assert.equal(r?.ok, true, `${ch} 未返回 ok:true，得到 ${JSON.stringify(r)?.slice(0, 120)}`)
    assert.ok('data' in r, `${ch} 返回缺少 data 字段`)
  }
})

// ── 按钮响应契约：每个 api.xxx() 调用点的返回值必须被消费 ────────────────────
//
// 判据是**结构**而非**文案**：找每个 `api.foo(` 调用点，看它是否处于
//   ① `const x = await api.foo(` / `let x = …`  —— 绑定到变量，或
//   ② `api.foo().then((r) => …)`               —— 回调消费
// 若两者皆非（裸 `await api.foo()` 或裸 `api.foo()`），说明用户点击后拿不到结果，
// 正是「按钮没反应」的形态。
//
// 职责边界（2026-10-01 反向断言实测确定）：
//   · 本测试负责 —— 接线缺失（调了不接返回值、无失败回流、无成功反馈出口）
//   · tsc 负责   —— 符号不存在（如把 setMsg 写成 setMsgXXX，TS2552 会报）
// 因此**不要**把断言写成「页面里必须出现 setMsg({kind:'err'}) 字面量」：那种
// 文案断言既抓不住结构变异，又会因无关改名误红（[DESIGN-ARCH-156] §5
// 「低精度守卫比没有守卫更糟」）。已实测：结构判据对「否定判定改 if(true)」
// 「移除成功反馈」「加裸 await」三类变异全部报红。
test('按钮响应：每个 api 调用点的返回值都被消费（结构判据）', () => {
  const src = read('src/renderer/components/keymanager/KeyManagerPage.tsx')
  assert.ok(src.length > 0, 'KeyManagerPage.tsx 缺失')

  const unconsumed = []
  const lines = src.split(/\r?\n/)
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    // 只看「发起调用且不接返回值」的形态
    const m = /^(?:void\s+)?(?:await\s+)?api\.([a-zA-Z]+)\(/.exec(trimmed)
    if (!m) return
    // 绑定到变量 / 被 .then 消费 / 被 return —— 都算消费
    const consumed = /(?:const|let|var)\s+[\w{[\s,]+\]\s*=/.test(trimmed) || /\.then\(|\.catch\(/.test(trimmed) || /^return\s/.test(trimmed)
    if (!consumed) unconsumed.push(`${i + 1}: ${trimmed.slice(0, 80)}`)
  })

  assert.deepEqual(unconsumed, [], `以下调用未消费返回值（点击后将无反馈）：\n${unconsumed.join('\n')}`)
})

test('按钮响应：存在失败回流（否定判定 + 提前返回）与成功反馈', () => {
  const src = read('src/renderer/components/keymanager/KeyManagerPage.tsx')
  // 失败回流：`if (!X.ok) {` 后 200 字符内出现 return 或错误提示
  const hasFailurePath = /if\s*\(\s*!\s*[a-zA-Z_$][\w$]*\.ok\s*\)\s*\{[\s\S]{0,300}?(?:return|setMsg|setError)/.test(src)
  assert.ok(hasFailurePath, '缺少失败回流：应有 `if (!X.ok) { …return/提示… }`')
  // 成功反馈：页面必须有某种「操作成功」的可观测出口
  const hasSuccessSignal = /setMsg\(\{\s*kind:\s*'ok'|setMsg\(\{\s*kind:\s*"ok"/.test(src)
  assert.ok(hasSuccessSignal, '缺少成功反馈出口（用户看不到操作已完成）')
})

test('按钮响应：页面的交互按钮数量与 api 调用数量匹配（无「点了没反应」的装饰按钮）', () => {
  const src = read('src/renderer/components/keymanager/KeyManagerPage.tsx')
  const onClickHandlers = [...src.matchAll(/onClick=\{(?:async\s+)?\(\)\s*=>\s*\{?/g)]
  // 这些是纯 UI 态切换（切 tab / 展开表单 / 关闭弹窗），不需要 API
  const uiOnly = [...src.matchAll(/onClick=\{\(\)\s*=>\s*(?:set[A-Z][a-zA-Z]*|toggle[A-Z]|api\.closeWindow)/g)]
  const actionButtons = onClickHandlers.length - uiOnly.length
  assert.ok(actionButtons > 0, '未识别到任何动作按钮')
  // 动作按钮应主要由 api 调用承担；api 调用点数量不应少于动作按钮的 1/2
  const apiCalls = [...src.matchAll(/api\.[a-zA-Z]+\(/g)]
  assert.ok(apiCalls.length >= actionButtons / 2, `动作按钮 ${actionButtons} 个但 api 调用仅 ${apiCalls.length} 处`)
})
