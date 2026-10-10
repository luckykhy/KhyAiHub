<!-- khy-metadata:auto khy-metadata/4 fingerprint=faec02371204c4a2 -->
<!-- 本文件由 khy 机械生成，可被 `khy metadata refresh` 安全覆盖。删除上面这行标记即视为人工接管，刷新将不再覆盖本文件。 -->
# MAP — khy-os 骨架与导航

> 由 khy 自动生成的可维护性种子文档（无需 AI 即可据此维护）。配套 `works/record/ai/CONTEXT.yaml`（契约/符号）`works/record/ai/GUARDS.md`（红线/无AI维护指南）。
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
- `apps/` — 多应用
  - `apps/ai-frontend/`
  - `apps/khy-os-client-app/`
  - `apps/khyos-desktop/`
  - `apps/provider-hub/`
- `delivery/`
  - `delivery/channel/`
  - `delivery/extension/`
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
- `entries/`
  - `entries/executables/`
  - `entries/pip/`
  - `entries/tools/` — 工具
- `evidence/`
  - `evidence/01_人类贡献/`
  - `evidence/02_独创性/`
  - `evidence/03_图片/`
  - `evidence/04_机器可读/`
  - `evidence/05_索引与对账/`
  - `evidence/06_申报材料/`
- `kernel/` — 内核
  - `kernel/boot/` — 引导
  - `kernel/bridge/`
  - `kernel/docs/` — 文档
  - `kernel/iso/`
  - `kernel/moonbit/`
  - `kernel/src/` — 源代码主目录
  - `kernel/tools/` — 工具
  - `kernel/userland/`
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
- `runtime/`
  - `runtime/node/`
- `scripts/` — 脚本（构建/CI/运维）
  - `scripts/admin/`
  - `scripts/backend/` — 后端
  - `scripts/ci/`
  - `scripts/copyright/`
  - `scripts/docs/` — 文档
  - `scripts/evidence/`
  - `scripts/frontend/` — 前端
  - `scripts/hooks/`
  - `scripts/install/`
  - `scripts/lib/` — 库代码
  - `scripts/maintenance/`
  - `scripts/memory/`
- `services/` — 服务/业务逻辑
  - `services/Tools/` — 工具
  - `services/ai-backend/`
  - `services/backend/` — 后端
- `works/`
  - `works/deploy/` — 部署
  - `works/record/`
- 根文件: `.clinerules`, `.dockerignore`, `.editorconfig`, `.env.example`, `.gitattributes`, `.gitignore`, `.npmrc`, `.portable`, `AGENTS.md`, `CHANGELOG.md`, `CLAUDE.md`, `Dockerfile`, `MANIFEST.in`, `README.md`, `SECURITY.md`, `docker-compose.yml`, `fly.staging.toml`, `install-khy.ps1`, `khy-cli.bat`, `khy.bat`

## 构建 / 运行 / 测试
- **安装**: `npm install` ; `pip install -e .`
- **测试**: `npm test --workspaces --if-present` ; `pytest`

## 关键文件符号速览
> 导航 teaser（按详略档位裁剪，`KHY_META_DETAIL=brief|standard|full`）。完整逐文件逐符号清单见 `CONTEXT.yaml`。
- `khy.sh` (shell): _无导出符号_
- `portable-setup.sh` (shell): _无导出符号_
- `entries/launch.js` (javascript): fail, printUsage, translate, main
- `kernel/tools_gen_blob.sh` (shell): _无导出符号_
- `scripts/check_builtin_keys.py` (python): decode_arrays, iter_source_files, changed_paths, find_apks, scan_blob, main
- `scripts/findIgnored.js` (javascript): findStandaloneTestFiles
- `scripts/gen_keys.py` (python): keys_file, load_keys, encode, decode, dart_arrays, render, check
- `scripts/install-hooks.sh` (shell): _无导出符号_
- `scripts/test-replace.js` (javascript): _无导出符号_
- `apps/ai-frontend/.eslintrc.cjs` (javascript): _无导出符号_
- `apps/ai-frontend/backendDiscovery.mjs` (javascript): isPidAlive, portOf, isTargetReachable, done, readApiPortCandidates, readPointerDataHomes, resolvePortable, resolveDataHomes, resolveBackendTarget, resolveWebBackendTarget
- `apps/ai-frontend/frontendRuntime.mjs` (javascript): validPort, canBindPort, resolveServePort, primaryDataHome, publishFrontendRuntime, clearFrontendRuntime, khyFrontendIdentityPlugin, identity, attach
- `apps/ai-frontend/vite.config.js` (javascript): _无导出符号_
- `apps/ai-frontend/vite.config.js.timestamp-1789957335018-e8635f872fa44.mjs` (javascript): isPidAlive, portOf, isTargetReachable, done, readApiPortFromRuntime, readPointerDataHomes, resolvePortable, resolveBackendTarget, resolveWebBackendTarget
- `apps/ai-frontend/vite.config.js.timestamp-1790123653267-c1e736cfc7eaf.mjs` (javascript): isPidAlive, portOf, isTargetReachable, done, readApiPortFromRuntime, readPointerDataHomes, resolvePortable, resolveBackendTarget, resolveWebBackendTarget
- `apps/ai-frontend/vite.config.js.timestamp-1790124145320-83db522268f09.mjs` (javascript): isPidAlive, portOf, isTargetReachable, done, readApiPortFromRuntime, readPointerDataHomes, resolvePortable, resolveBackendTarget, resolveWebBackendTarget
- `apps/ai-frontend/vite.config.js.timestamp-1790124352831-5f4202511f4bc.mjs` (javascript): isPidAlive, portOf, isTargetReachable, done, readApiPortFromRuntime, readPointerDataHomes, resolvePortable, resolveBackendTarget, resolveWebBackendTarget
- `apps/ai-frontend/vite.config.js.timestamp-1790124706547-65ae8d1b091a3.mjs` (javascript): isPidAlive, portOf, isTargetReachable, done, readApiPortFromRuntime, readPointerDataHomes, resolvePortable, resolveBackendTarget, resolveWebBackendTarget
- `apps/khyos-desktop/.build_run.cjs` (javascript): _无导出符号_
- `apps/khyos-desktop/.launch_verify.cjs` (javascript): _无导出符号_
- `apps/khyos-desktop/electron.vite.config.ts` (typescript): _无导出符号_
- `apps/khyos-desktop/vite.config.js` (javascript): _无导出符号_
- `apps/khyos-desktop/vite.host.config.ts` (typescript): _无导出符号_
- `apps/khyos-desktop/vite.scheduler.config.ts` (typescript): _无导出符号_
- `apps/provider-hub/electron.vite.config.1790238272970.mjs` (javascript): _无导出符号_
- `apps/provider-hub/electron.vite.config.1790238291707.mjs` (javascript): _无导出符号_
- `apps/provider-hub/electron.vite.config.1790238642419.mjs` (javascript): _无导出符号_
- `kernel/bridge/index.js` (javascript): _无导出符号_
- `kernel/bridge/khy-agent-run.js` (javascript): log, main, shutdown
- `kernel/bridge/khy-agent.js` (javascript): defaultBrain, KhyAgent
- `kernel/bridge/khy-brain-gateway.js` (javascript): dataHomeCandidates, push, readAuthTokenFile, defaultGatewayUrl, host, postJson, assistantText, firstLine, buildMessages, shapeReply, …(+3)
- `kernel/bridge/khy-bridge.js` (javascript): KhyStatusError, KhyBridge, reply, seq
- `kernel/bridge/khy-frame.js` (javascript): crc16, cobsEncode, cobsDecode, encodeFrame, decodeFrame, FrameSplitter
- `kernel/bridge/khy-mcp.js` (javascript): KhyMcpServer, sleep, connectWithWait, main, log, shutdown
- `kernel/bridge/khy-protocol.js` (javascript): enc, statReq, listReq, readReq, writeReq, pathReq, psReq, splitStatus, parseStat, parseListPage, …(+4)
- `kernel/bridge/khy-tools.js` (javascript): makeTools
- `kernel/src/agentask.c` (c): waiter, ask_crit_enter, ask_crit_leave, agentask_init, agentask_on_response, agentask_tick
- `kernel/src/agentask.h` (c): agentframe
- `kernel/src/agentbus.c` (c): agentbus_send_frame, dispatch_frame, agentbus_rx_byte, agentbus_init, agentbus_task
- `kernel/src/agentbus.h` (c): agentframe
- `kernel/src/agentconf.c` (c): key_ok, val_ok, disk_ready, agentconf_set, agentconf_get
- `kernel/src/agentconf.h` (c): _无导出符号_
- `kernel/src/agentctl.c` (c): w_u16, w_u32, w_u64, r_u32, r_u64, reply_status, guard_mutation, do_stat, do_list, do_read, …(+5)
- `kernel/src/agentctl.h` (c): _无导出符号_
- `packaging/installer/build_installer.js` (javascript): getVersion, findKhyExecutable, buildPayload, zipSize, checkNsis, compileNsi, main, size
- `platform/delivery/deliveryController.js` (javascript): DeliveryController
- `platform/delivery/demo.js` (javascript): main
- `platform/khy_platform/__init__.py` (python): _detect_version
- …其余 72 个文件的符号见 `CONTEXT.yaml`（完整逐文件清单）。

