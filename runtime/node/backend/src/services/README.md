# services — D1 服务域根

## 谁要

CLI（src/cli）、HTTP 路由（src/routes）、交付面（delivery/*）与 AI 后端（runtime/node/ai-backend）。

## 为什么

本层承载全部业务副作用与状态，CLI 与交付面都只调它。分层的目的是让「谁能写盘、谁能发请求、谁能读凭据」有唯一归属。

## 里面有什么

- gateway/ —— 网关：适配器、路由、额度、委派闸
- tool/ —— 工具执行与工具循环
- domain/ —— 业务上下文（D2 的物理落点，其下各单元另有自己的 khy.module.json）
- reasoning/ —— 思维链仲裁与预算闭环
- tokenUsageService.js / confidenceCalibration*.js / clueVault.js —— 用量、确信度校准、线索保全

## 怎么验

- `node --test "src/services/**/*.test.js" —— 服务层单元测试`
- `npm run check:layout —— 层级/入口缓冲/根目录守卫`
- `node --check src/services/**/*.js —— 语法`

## 生命周期

本单元的 `khy.module.json` 记 `lifecycle.stage = staged`、`provenance = recorded-after-the-fact`：代码是直接写进核心域的，没有经过 `scripts/quarantine/` 缓冲区（判据见 `scripts/quarantine/README.md`）。单元内仍有源文件缺同名同目录测试，晋级三判据未齐，故不签 stable。
