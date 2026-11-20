// keyManagerContract.test.cjs — Key/Endpoint Manager 契约测试
//（DESIGN-ARCH-091 §10.1 ⑯-⑱ + desktopUiContract D6 扩展）。
//
// Run: node --test apps/khyos-desktop/tests/keyManagerContract.test.cjs
//（纯文本契约，无需 strip-types。）

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { unregisteredChannels, duplicateChannels } = require('./ipcChannelScan.cjs');

const projectRoot = join(__dirname, '..')
const read = (p) => {
  const full = join(projectRoot, p)
  return existsSync(full) ? readFileSync(full, 'utf-8') : ''
}

const indexSrc = read('src/main/index.ts')
const ipcSrc = read('src/main/keyManager/ipc.ts')
const keyStoreSrc = read('src/main/keyManager/keyStore.ts')
const agentWritersSrc = read('src/main/keyManager/agentWriters.ts')
const modelsSrc = read('src/main/keyManager/models.ts')

// ⑯ 所有 keys:*/endpoints:*/agents:*/health:*/proxy:*/cards:*/providers:* 通道
//    在 ipc.ts 注册，且与 preload 方法一一对应
test('⑯ keyManager IPC 通道已在主进程注册', () => {
  assert.ok(ipcSrc.length > 0, 'ipc.ts 缺失')
  const required = [
    'keys:list', 'keys:add', 'keys:update', 'keys:remove', 'keys:toggle', 'keys:reveal', 'keys:import',
    'providers:list', 'providers:add', 'providers:remove',
    'endpoints:presets', 'endpoints:validate', 'models:fetch',
    // 受管模型列表（DESIGN-ARCH-091 §8b）。通道名是 models:managed 而非
    // models:list —— 后者已被 main/index.ts 的 host 转发占用（重复注册在
    // Electron 44.2.0 会抛 'Attempted to register a second handler'，
    // 而 registerKeyManagerIpc 早于 createWindow 调用，崩了约 44 个 handler）。
    'models:managed', 'models:add', 'models:update', 'models:remove',
    'models:apply', 'models:probe', 'models:catalog',
    'cards:list', 'cards:add', 'cards:update', 'cards:remove',
    'agents:matrix', 'agents:apply', 'agents:revert',
    'proxy:status', 'proxy:start',
    'health:probe', 'health:audit-list', 'health:audit-export'
  ]
  for (const ch of required) {
    assert.ok(ipcSrc.includes(`handle('${ch}'`), `通道 ${ch} 未在 ipc.ts 注册`)
  }
})

test('⑯ preload 的 invoke 通道与主进程 handler 对齐（无 API 漂移）', () => {
  const missing = unregisteredChannels(projectRoot)
  assert.deepEqual(missing, [], `preload 调用通道未注册：${missing.join(', ')}`)
})

// ⑯b 主进程侧无重复注册。unregisteredChannels 问「有没有人 handle」，撞名时两边
// 都有人 handle，它永远绿；而 Electron 44.2.0 的 ipcMain.handle 对已注册通道抛
// 'Attempted to register a second handler'。真实事故形态：registerKeyManagerIpc
// 早于 createWindow 调用，createWindow 内部又注册同名通道 → createWindow 抛错，
// 其后约 44 个 handler 全丢、主窗永不显示。假 ipc（Map）会静默覆盖，所以这条
// 必须扫真实源码而不是跑注册。
test('⑯b 主进程侧无重复注册通道（撞名 = 启动即崩）', () => {
  const dup = duplicateChannels(projectRoot)
  assert.deepEqual(dup, [], `通道被注册两次：${dup.join(', ')}（Electron 会抛 Attempted to register a second handler）`)
})

test('⑯ index.ts 在 whenReady 注册 KeyManager IPC', () => {
  assert.ok(indexSrc.includes('registerKeyManagerIpc'), 'index.ts 未接入 registerKeyManagerIpc')
})

// D6 扩展：keyManager 通道命名必须 namespace:action
test('D6: keyManager IPC 通道命名符合 namespace:action', () => {
  const channels = [...ipcSrc.matchAll(/handle\('([^']+)'/g)].map((m) => m[1])
  assert.ok(channels.length > 0)
  for (const ch of channels) {
    assert.match(ch, /^[a-z][a-z-]*:[a-z][a-z-]*$/, `${ch} 不符合 namespace:action`)
  }
})

// ⑰ 脱敏不变式：除 keys:reveal 外，任何 IPC 负载不得回传完整 key
test('⑰ 脱敏不变式：plaintext key 只在 keys:reveal 单一出口', () => {
  // 主进程侧：明文 key 的读取点（resolvePoolKey / listPoolEntriesPlain）
  // 只允许出现在 agentWriters（Mode A 直连凭据路径）与 keyStore 内部，
  // ipc.ts 不得把 pool 明文注入任何非 reveal 的返回体。
  const revealHandlers = ipcSrc.match(/revealKey\(/g) || []
  assert.ok(revealHandlers.length >= 1, 'keys:reveal 未接入 revealKey')
  // agents:apply 的 direct 路径经 resolvePoolKey（agentWriters 内部），
  // 返回体只含 detail/targetPath，不含 key 值：
  const applyBlock = ipcSrc.match(/agents:apply[\s\S]{0,900}/)
  assert.ok(applyBlock, 'agents:apply handler 缺失')
  assert.ok(!/return\s+ok\(\{\s*key:/.test(applyBlock[0]), 'agents:apply 不得回传明文 key')
})

test('⑰ keyStore.listPool 输出全部脱敏（mask + fingerprint）', () => {
  assert.ok(keyStoreSrc.includes('maskKey'), 'keyStore 未实现脱敏函数')
  assert.ok(keyStoreSrc.includes('keyFingerprint'), 'keyStore 未实现指纹函数')
  // listPool 返回的 MaskedKey 结构不含 key 字段
  const listPoolBody = keyStoreSrc.match(/export async function listPool\(\)[\s\S]{0,1200}/)
  assert.ok(listPoolBody, 'listPool 缺失')
  assert.ok(!/\bkey:\s*e\.key\b/.test(listPoolBody[0]), 'listPool 泄漏明文 key')
})

// ⑱ 新文件零硬编码：khy 代理端点必须来自 runtime 文件/env，不得写死 host:port。
// 注意：keyStore 的 BUILTIN_PRESETS 是公开参考目录（Ollama 等本地默认端口属
// 公开数据，真源在 backend providerPresets.js），不在本检查范围内。
// models.ts（受管模型列表）2026-11-19 新增时漏在名单外 —— 它同样会碰代理端点
// 与池名，必须一并扫。
test('⑱ keyManager 模块零硬编码端点（代理端点来源可审计）', () => {
  const files = [
    agentWritersSrc,
    modelsSrc,
    read('src/main/keyManager/ipc.ts'),
    read('src/main/keyManager/health.ts'),
    read('src/main/keyManager/proxyStatus.ts'),
    read('src/main/keyManager/audit.ts')
  ]
  for (const src of files) {
    if (!src) continue
    // no literal host:port for the khy proxy (ports come from runtime files)
    const bad = src.match(/(localhost|127\.0\.0\.1):\d+/g)
    assert.equal(bad ? bad.length : 0, 0, `硬编码 host:port 字面量: ${(bad || []).join(', ')}`)
  }
  // proxy endpoint derivation must be runtime-file driven
  assert.ok(
    read('src/main/keyManager/proxyStatus.ts').includes('proxy_server_runtime.json') ||
      read('src/main/keyManager/proxyStatus.ts').includes('PROXY_RUNTIME_FILE'),
    '代理端点必须来自 runtime 文件（零硬编码）'
  )
})

// ⑱b models.ts 的池名归一化必须与后端 constants.js/_canonicalPoolProviderName
// 同算法：旧 `cc-switch:<cardId>` 命名空间要逐字映射成 `cc_switch_<cardId>`，
// 通用字符折叠会把 `-` 留在名里，与 apiKeyPool 的别名表对不上。
test('⑱b models/keyStore 的池名归一化逐字映射旧 cc-switch 命名空间', () => {
  assert.ok(modelsSrc.length > 0, 'models.ts 缺失')
  assert.ok(
    /canonicalPoolProviderName/.test(modelsSrc) || /canonicalPoolProviderName/.test(keyStoreSrc),
    'models/keyStore 必须实现 canonicalPoolProviderName（后端 proxyAccess.js:186 的桌面侧镜像）'
  )
  assert.ok(
    keyStoreSrc.includes("'cc-switch:'") && keyStoreSrc.includes('cc_switch_'),
    '池名归一化必须逐字映射 cc-switch:<id> → cc_switch_<id>（constants.js:88-96）'
  )
})

// ⑱c models.ts 的 apply/probe 必须有 poolKey 下限校验：poolKey 空/非法时
// routableModelName 会原样退回裸 id，掉进网关 builtin-family 级联坑。
test('⑱c models.ts 对 poolKey 空/非法拒绝而非静默退回裸 id', () => {
  assert.ok(/poolKeyRejectReason/.test(modelsSrc), 'models.ts 缺 poolKey 下限校验函数')
  const applyBody = modelsSrc.match(/export async function applyModelToApp[\s\S]{0,2500}/)
  assert.ok(applyBody, 'applyModelToApp 缺失')
  assert.ok(/poolKeyRejectReason/.test(applyBody[0]), 'applyModelToApp 必须校验 poolKey')
  const probeBody = modelsSrc.match(/export async function probeManagedModel[\s\S]{0,3000}/)
  assert.ok(probeBody, 'probeManagedModel 缺失')
  assert.ok(/poolKeyRejectReason/.test(probeBody[0]), 'probeManagedModel 必须校验 poolKey')
})

test('⑱ agentWriters 四级 backend 解析（env → 仓库 → 便携根 → 内置降级）', () => {
  assert.ok(agentWritersSrc.includes('KHY_BACKEND_SERVICES'), '缺 KHY_BACKEND_SERVICES 一级')
  assert.ok(agentWritersSrc.includes('KHY_PORTABLE_ROOT') || agentWritersSrc.includes('KHYQUANT_PORTABLE_ROOT'), '缺便携根一级')
  assert.ok(agentWritersSrc.includes('backend-resolve-failed'), '缺内置降级审计事件')
})
