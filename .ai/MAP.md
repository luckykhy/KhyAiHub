<!-- khy-metadata:auto khy-metadata/4 fingerprint=d2a8095ef4f28929 -->
<!-- 本文件由 khy 机械生成，可被 `khy metadata refresh` 安全覆盖。删除上面这行标记即视为人工接管，刷新将不再覆盖本文件。 -->
# MAP — khy-os 骨架与导航

> 由 khy 自动生成的可维护性种子文档（无需 AI 即可据此维护）。配套 `.ai/CONTEXT.yaml`（契约/符号）`.ai/GUARDS.md`（红线/无AI维护指南）。
> 本文为确定性扫描产物：目录职责按约定推断，入口/构建命令来自 manifest，符号清单来自轻量正则。带 `TODO(人工)` 处需维护者补全意图。

## 技术栈
`node` · `monorepo` · `python` · `docker` · `docker-compose`

## 核心入口点
- `platform/packages/shared/src/index.js` (node-main, workspace:@khy/shared#main)
- `platform/packages/ui-shared/src/index.js` (node-main, workspace:@khy/ui-shared#main)
- `services/backend/server.js` (node-main, workspace:khy-os-backend#main)
- `services/backend/bin/khy.js` (cli-bin, workspace:khy-os-backend bin:khyquant)
- `services/backend/bin/khy.js` (cli-bin, workspace:khy-os-backend bin:khy-os)
- `services/backend/bin/khy.js` (cli-bin, workspace:khy-os-backend bin:khy)
- `services/ai-backend/server.js` (node-main, workspace:khy-ai-backend#main)
- `apps/khyos-desktop/out/main/index.js` (node-main, workspace:khyos-desktop#main)
- `apps/provider-hub/dist/main/index.js` (node-main, workspace:khy-provider-hub#main)
- `platform/khy_platform/cli.py` (python-entry, pyproject scripts)

## 目录结构与职责
- `-p/`
- `_产物/`
  - `_产物/bg-orchestration/`
- `apps/` — 多应用
  - `apps/ai-frontend/`
  - `apps/khy-os-client-app/`
  - `apps/khyos-desktop/`
  - `apps/provider-hub/`
- `backups/`
- `deploy/` — 部署
  - `deploy/free-test/`
- `docs/` — 文档
  - `docs/01_INIT_立项/`
  - `docs/02_CONCEPTS_概念入门/`
  - `docs/03_DESIGN_设计/`
  - `docs/04_IMPL_实现/`
  - `docs/05_TEST_测试/`
  - `docs/06_DEPLOY_部署/`
  - `docs/07_OPS_运维/`
  - `docs/08_MGMT_项目管理/`
  - `docs/09_STORY_修仙学AI/`
  - `docs/10_规范/`
  - `docs/11_报告/`
  - `docs/12_模板/`
- `electron/`
  - `electron/services/` — 服务/业务逻辑
- `entries/`
- `extensions/`
  - `extensions/bridges/`
  - `extensions/scripts/` — 脚本（构建/CI/运维）
  - `extensions/tools/` — 工具
- `gui-test-screenshots/`
- `kernel/` — 内核
  - `kernel/boot/` — 引导
  - `kernel/bridge/`
  - `kernel/docs/` — 文档
  - `kernel/iso/`
  - `kernel/moonbit/`
  - `kernel/src/` — 源代码主目录
  - `kernel/tools/` — 工具
  - `kernel/userland/`
- `khy_os.egg-info/`
- `packaging/` — 打包
  - `packaging/installer/`
  - `packaging/modules/`
  - `packaging/npm/`
- `patches/`
- `platform/`
  - `platform/delivery/`
  - `platform/khy_platform/`
  - `platform/packages/`
  - `platform/tests/` — 测试
- `scripts/` — 脚本（构建/CI/运维）
  - `scripts/admin/`
  - `scripts/backend/` — 后端
  - `scripts/ci/`
  - `scripts/docs/` — 文档
  - `scripts/frontend/` — 前端
  - `scripts/hooks/`
  - `scripts/install/`
  - `scripts/lib/` — 库代码
  - `scripts/maintenance/`
  - `scripts/memory/`
  - `scripts/moonbit/`
  - `scripts/portable/`
- `services/` — 服务/业务逻辑
  - `services/Tools/` — 工具
  - `services/ai-backend/`
  - `services/backend/` — 后端
- `software/`
  - `software/akshare_scripts/`
  - `software/khyquant/`
- `tests/` — 测试
- `tools/` — 工具
  - `tools/deepseek-eyes/`
- 根文件: `...md`, `.clinerules`, `.dockerignore`, `.duplication-baseline.json`, `.editorconfig`, `.env.example`, `.git-blame-ignore-revs`, `.gitattributes`, `.gitignore`, `.khy_orphan_sweep`, `.mailmap`, `.npmrc`, `.portable`, `0)`, `AGENTS.html`, `AGENTS.md`, `CHANGELOG.html`, `CHANGELOG.md`, `CLAUDE.html`, `CLAUDE.md`

## 构建 / 运行 / 测试
- **安装**: `npm install` ; `pip install -e .`
- **测试**: `npm test --workspaces --if-present` ; `pytest`

## 关键文件符号速览
> 导航 teaser（按详略档位裁剪，`KHY_META_DETAIL=brief|standard|full`）。完整逐文件逐符号清单见 `CONTEXT.yaml`。
- `khy.sh` (shell): _无导出符号_
- `portable-setup.sh` (shell): _无导出符号_
- `_产物/append-141-acceptance.js` (javascript): _无导出符号_
- `_产物/append-memory-22-5.js` (javascript): _无导出符号_
- `_产物/append-memory-mem-and-log.js` (javascript): bytes
- `_产物/board-lane-map.js` (javascript): deriveRuntimeId, joinPrefix, readStoreSource, extractStringArray, extractSet, extractTransitions, extractLauncherCommands, extractTaskFields, extractPayloadKeys, countWorktreeBindCallSites, …(+10)
- `_产物/classify-collateral-141.js` (javascript): git
- `_产物/touch-cost-probe.js` (javascript): argOf, sh, countLines
- `_产物/tui-startup-probe-e2e.js` (javascript): finish
- `_产物/tui-startup-probe-profile.js` (javascript): relPath, describe, bucketOf, url, w
- `_产物/tui-startup-probe-render.js` (javascript): elapsed, stamp, log
- `_产物/tui-startup-probe-require.js` (javascript): ms, rel, isRepo, sum
- `_产物/update-doc-141.js` (javascript): _无导出符号_
- `backups/replayEngine.pre-trajectory-flip.js` (javascript): _stepTimeoutMs, _shellAllowList, fromEnv, _shellPreApproved, _approveParams, _replayControlResponder, _executeWithTimeout, _preconditionCheck, _verifyArtifacts, _maybeRepair, …(+6)
- `electron/main.js` (javascript): createWindow, getMainWindow, registerIpcHandlers
- `electron/preload.js` (javascript): handler, handler, handler, handler
- `entries/launch.js` (javascript): fail, printUsage, translate, main
- `kernel/tools_gen_blob.sh` (shell): _无导出符号_
- `scripts/check_builtin_keys.py` (python): decode_arrays, iter_source_files, changed_paths, find_apks, scan_blob, main
- `scripts/electron-dev.js` (javascript): _无导出符号_
- `scripts/findIgnored.js` (javascript): findStandaloneTestFiles
- `scripts/gen_keys.py` (python): encode, decode, dart_arrays, render, check
- `scripts/install-hooks.sh` (shell): _无导出符号_
- `scripts/test-replace.js` (javascript): _无导出符号_
- `apps/ai-frontend/.eslintrc.cjs` (javascript): _无导出符号_
- `apps/ai-frontend/backendDiscovery.mjs` (javascript): isPidAlive, portOf, isTargetReachable, done, readApiPortFromRuntime, readPointerDataHomes, resolvePortable, resolveBackendTarget, resolveWebBackendTarget
- `apps/ai-frontend/vite.config.js` (javascript): _无导出符号_
- `apps/ai-frontend/vite.config.js.timestamp-1789957335018-e8635f872fa44.mjs` (javascript): isPidAlive, portOf, isTargetReachable, done, readApiPortFromRuntime, readPointerDataHomes, resolvePortable, resolveBackendTarget, resolveWebBackendTarget
- `apps/ai-frontend/vite.config.js.timestamp-1790123653267-c1e736cfc7eaf.mjs` (javascript): isPidAlive, portOf, isTargetReachable, done, readApiPortFromRuntime, readPointerDataHomes, resolvePortable, resolveBackendTarget, resolveWebBackendTarget
- `apps/ai-frontend/vite.config.js.timestamp-1790124145320-83db522268f09.mjs` (javascript): isPidAlive, portOf, isTargetReachable, done, readApiPortFromRuntime, readPointerDataHomes, resolvePortable, resolveBackendTarget, resolveWebBackendTarget
- `apps/ai-frontend/vite.config.js.timestamp-1790124352831-5f4202511f4bc.mjs` (javascript): isPidAlive, portOf, isTargetReachable, done, readApiPortFromRuntime, readPointerDataHomes, resolvePortable, resolveBackendTarget, resolveWebBackendTarget
- `apps/ai-frontend/vite.config.js.timestamp-1790124706547-65ae8d1b091a3.mjs` (javascript): isPidAlive, portOf, isTargetReachable, done, readApiPortFromRuntime, readPointerDataHomes, resolvePortable, resolveBackendTarget, resolveWebBackendTarget
- `apps/khyos-desktop/.build_run.cjs` (javascript): _无导出符号_
- `apps/khyos-desktop/.launch_verify.cjs` (javascript): _无导出符号_
- `apps/khyos-desktop/electron.vite.config.ts` (typescript): _无导出符号_
- `electron/services/aiGatewayService.js` (javascript): getApiConfig, httpRequest
- `electron/services/authService.js` (javascript): ensureConfigDir, readConfig, writeConfig
- `electron/services/backendService.js` (javascript): findBackendEntry
- `electron/services/connectionServer.js` (javascript): getServerUrl
- `electron/services/fileService.js` (javascript): buildTree
- `electron/services/messageService.js` (javascript): _无导出符号_
- `electron/services/sessionService.js` (javascript): ensureDir, sessionFile, loadSession, saveSession, listSessionFiles
- `electron/services/syncService.js` (javascript): sendToRenderer
- `electron/services/terminalService.js` (javascript): getShell, sendToRenderer
- `kernel/bridge/index.js` (javascript): _无导出符号_
- `kernel/bridge/khy-agent-run.js` (javascript): log, main, shutdown
- `kernel/bridge/khy-agent.js` (javascript): defaultBrain, KhyAgent
- `kernel/bridge/khy-brain-gateway.js` (javascript): readAuthTokenFile, defaultGatewayUrl, host, port, postJson, assistantText, firstLine, buildMessages, shapeReply, makeGatewayBrain, …(+2)
- …其余 72 个文件的符号见 `CONTEXT.yaml`（完整逐文件清单）。

