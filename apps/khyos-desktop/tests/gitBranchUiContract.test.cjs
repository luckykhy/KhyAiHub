// 桌面端 Git 分支选择器的源码契约：接线是「字符串 + 状态机」写成的，类型检查
// 抓不到「分支选择器没挂进 GitPanel」「IPC 通道名拼错」「错误码没对上后端」
// 这类断链。这里直接读源文件断言。
//
// 契约要点：
//   1. GitPanel 头部挂上 BranchSwitcher（分支名可点）
//   2. preload 暴露 gitBranchList / gitBranchSwitch
//   3. 主进程注册 git:branchList / git:branchSwitch，且通道名与 preload 一致
//   4. 前端错误码表覆盖后端 branchGuard 的全部错误码
//   5. 前端不做第二套分支名合法性判定（判据归后端）
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const gitPanel = read('src/renderer/components/git/GitPanel.tsx')
const branchSwitcher = read('src/renderer/components/git/BranchSwitcher.tsx')
const preload = read('src/preload/index.ts')
const main = read('src/main/index.ts')

// ── 1. GitPanel 挂上分支选择器 ───────────────────────────────────────────────

test('GitPanel：头部挂上 BranchSwitcher 并把当前分支名传进去', () => {
  assert.match(gitPanel, /import\s*\{\s*BranchSwitcher\s*\}/, '必须 import BranchSwitcher')
  assert.match(gitPanel, /<BranchSwitcher/, '必须渲染 BranchSwitcher')
  assert.match(gitPanel, /currentBranch=\{state\.data\.branch\}/, '必须把当前分支名传给选择器')
})

test('GitPanel：切换成功后刷新改动列表', () => {
  assert.match(gitPanel, /onSwitched=/, '必须传 onSwitched 回调')
  assert.match(gitPanel, /onSwitched=\{[^}]*load\(/s, 'onSwitched 必须触发重新加载')
})

// ── 2. preload 暴露 ─────────────────────────────────────────────────────────

test('preload：暴露 gitBranchList / gitBranchSwitch', () => {
  assert.match(preload, /gitBranchList\s*:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('git:branchList'\)/)
  assert.match(preload, /gitBranchSwitch\s*:/, '必须暴露 gitBranchSwitch')
  assert.match(preload, /ipcRenderer\.invoke\('git:branchSwitch'/, 'gitBranchSwitch 必须走 git:branchSwitch 通道')
})

// ── 3. 主进程注册且通道名一致 ───────────────────────────────────────────────

test('main：注册 git:branchList / git:branchSwitch', () => {
  assert.match(main, /ipcMain\.handle\('git:branchList'/, '必须注册 git:branchList')
  assert.match(main, /ipcMain\.handle\('git:branchSwitch'/, '必须注册 git:branchSwitch')
})

test('main：分支通道的 handler 名与 preload 完全一致', () => {
  const preloadInvokes = preload.match(/ipcRenderer\.invoke\('(git:[^']+)'/g) || []
  const mainHandles = main.match(/ipcMain\.handle\('(git:[^']+)'/g) || []
  const preloadNames = preloadInvokes.map((s) => s.match(/'([^']+)'/)[1])
  const mainNames = mainHandles.map((s) => s.match(/'([^']+)'/)[1])
  for (const name of preloadNames) {
    assert.ok(mainNames.includes(name), `preload 调用的 ${name} 在主进程没有对应 handler`)
  }
})

// ── 4. 错误码表与后端判据对齐 ───────────────────────────────────────────────

test('BranchSwitcher：错误码表覆盖后端 branchGuard 的全部错误码', () => {
  // 后端 branchGuard.js 产出的错误码集合（判据的单一真源）。
  const backendCodes = [
    'invalidBranchName',
    'branchAlreadyExists',
    'targetBranchNotFound',
    'conflictsPresent',
    'operationInProgress',
    'branchInOtherWorktree',
    'dirtyWorkingTree',
    'unknown',
  ]
  for (const code of backendCodes) {
    assert.ok(
      branchSwitcher.includes(code),
      `前端错误码表缺少后端错误码 ${code} —— 会把已知原因降级成「未知错误」`
    )
  }
})

test('BranchSwitcher：错误码表指向 git.branchSwitcher.error.* 既有词条', () => {
  // 上游基线已留下 44 条 git.branchSwitcher.* 词条——本方案是「接回既有设计」，
  // 不是另写一套文案。故错误码表必须映射到那些既有键上。
  const mapping = branchSwitcher.match(/git\.branchSwitcher\.error\.\w+/g) || []
  assert.ok(mapping.length >= 8, `错误码表应至少映射 8 个既有词条，实际 ${mapping.length}`)

  // 被引用的每个键都必须在 zh-CN.json 里真实存在。
  const dict = JSON.parse(read('src/renderer/i18n/zh-CN.json'))
  for (const key of new Set(mapping)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(dict, key),
      `组件引用了不存在的 i18n 键 ${key}`
    )
  }
})

test('BranchSwitcher：组件引用的每个 i18n 键都在 zh-CN.json 里存在', () => {
  // 漏键在运行时会显示成裸键名（如 "git.branchSwitcher.xxx"），用户看到的是
  // 一串路径而不是人话——这类问题类型检查抓不到，只能由契约守住。
  const dict = JSON.parse(read('src/renderer/i18n/zh-CN.json'))
  // 只匹配完整的键名（末尾是单词字符），避免把模板串
  // `git.branchSwitcher.error.${ERROR_KEYS[code]}` 误抓成半个键。
  const used = new Set(branchSwitcher.match(/git\.branchSwitcher\.[\w]+(?:\.[\w]+)*/g) || [])
  used.delete('git.branchSwitcher.error')
  assert.ok(used.size >= 10, `组件应引用多条既有词条，实际 ${used.size}`)
  for (const key of used) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(dict, key),
      `组件引用了不存在的 i18n 键 ${key} —— 运行时会显示裸键名`
    )
  }
})

test('BranchSwitcher：组件走 useTranslation 取词条而非硬编码文案', () => {
  assert.match(branchSwitcher, /useTranslation/, '必须使用 react-i18next 的 useTranslation')
  assert.match(branchSwitcher, /from 'react-i18next'/)
  // 至少有一处 t(...) 调用。
  assert.match(branchSwitcher, /t\('git\.branchSwitcher\./, '必须用 t() 取既有词条')
})

test('BranchSwitcher：notRepository 也必须有对应文案', () => {
  assert.match(branchSwitcher, /notRepository/)
})

// ── 5. 前端不做第二套判定 ───────────────────────────────────────────────────

test('BranchSwitcher：前端不自带分支名合法性判定（判据归后端）', () => {
  // 前端若自带一份分支名校验，两端规则必然漂移——这正是本方案要消除的
  // 「判据在两处」问题。故断言前端源码里没有 Git 分支名的合法性正则。
  // 判据形态：含 ".." 模式的正则、或 refname/check-ref-format 之类的
  // check-ref-format 复刻。
  // 先剥掉注释与字符串字面量——它们常提到 ".." 这类形态却不是判定逻辑。
  const code = branchSwitcher
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'[^'\n]*'/g, "''")
    .replace(/"[^"\n]*"/g, '""')

  assert.doesNotMatch(
    code,
    /\.\.[\\/]/,
    '前端不应出现 ".." 形式的分支名合法性判定'
  )
  assert.doesNotMatch(
    code,
    /refname|check-ref-format/,
    '前端不应复刻 Git 的 ref 格式校验'
  )
})

test('BranchSwitcher：脏文件阻断必须给两条明确出路', () => {
  assert.match(branchSwitcher, /dirtyWorkingTree/, '必须识别 dirtyWorkingTree 阻断')
  // 两条出路各对应一个既有词条：submitAction（提交并切换）与 forceAction（丢弃改动并切换）。
  assert.match(
    branchSwitcher,
    /git\.branchSwitcher\.blockedDialog\.submitAction/,
    '必须提供「提交并切换」出路'
  )
  assert.match(
    branchSwitcher,
    /git\.branchSwitcher\.blockedDialog\.forceAction/,
    '必须提供「丢弃改动并切换」出路'
  )
})

test('BranchSwitcher：强制切换必须显式传 force，不能默认丢弃改动', () => {
  assert.match(branchSwitcher, /\{ force: true \}/, '强制切换必须显式传 force')
  // 默认路径不得带 force —— 否则普通切换会静默丢弃用户改动。
  assert.doesNotMatch(
    branchSwitcher,
    /gitBranchSwitch\?\.\([^)]*force: true[^)]*\)[^}]*switch\(filtered/,
    '普通切换路径不得默认 force'
  )
})
