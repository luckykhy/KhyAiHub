<!-- khy-metadata:auto khy-metadata/4 fingerprint=f87cc549fea7fda8 -->
<!-- 本文件由 khy 机械生成，可被 `khy metadata refresh` 安全覆盖。删除上面这行标记即视为人工接管，刷新将不再覆盖本文件。 -->
# MAP — khy-os 骨架与导航

> 由 khy 自动生成的可维护性种子文档（无需 AI 即可据此维护）。配套 `works/record/ai/CONTEXT.yaml`（契约/符号）`works/record/ai/GUARDS.md`（红线/无AI维护指南）。
> 人工语义层：`works/record/ai/READING-GUIDE.md`（分层图 / 三条链路 / 阅读路线 / 任务反查表）。本文件回答「有什么」，它回答「为什么、读哪个」。
> 本文为确定性扫描产物：目录职责按约定推断，入口/构建命令来自 manifest，符号清单来自轻量正则。带 `TODO(人工)` 处需维护者补全意图。
> 扫描窗口：20000 个文件（上限 20000）——**已达上限，下列目录规模是下界而非全量**。

## 技术栈
`node` · `monorepo` · `python` · `docker` · `docker-compose`

## 核心入口点
- `runtime/substrate/platform/packages/shared/src/index.js` (node-main, workspace:@khy/shared#main)
- `runtime/substrate/platform/packages/core/src/contracts/index.js` (node-main, workspace:@khy/core#main)
- `runtime/substrate/platform/packages/ui-shared/src/index.js` (node-main, workspace:@khy/ui-shared#main)
- `runtime/substrate/platform/packages/plugin-sdk/index.js` (node-main, workspace:@khy/plugin-sdk#main)
- `runtime/node/backend/server.js` (node-main, workspace:khy-os-backend#main)
- `runtime/node/backend/bin/khy.js` (cli-bin, workspace:khy-os-backend bin:khyquant)
- `runtime/node/backend/bin/khy.js` (cli-bin, workspace:khy-os-backend bin:khy-os)
- `runtime/node/backend/bin/khy.js` (cli-bin, workspace:khy-os-backend bin:khy)
- `runtime/node/ai-backend/server.js` (node-main, workspace:khy-ai-backend#main)
- `delivery/channel/web/provider-hub/dist/main/index.js` (node-main, workspace:khy-provider-hub#main)
- `delivery/extension/tools/khy-markdown/khyos-md-bridge.js` (node-main, workspace:khyos-markdown#main)
- `delivery/extension/tools/khy-markdown/khyos-md-bridge.js` (cli-bin, workspace:khyos-markdown bin:khyos-markdown)

## 分层视图（L0–L6）

```mermaid
flowchart LR
  N0["L0 内核<br/>runtime/boot/kernel"]
  N1["L1 Python 启动层<br/>runtime/substrate/platform"]
  N2["L2 Node 运行时<br/>runtime/node"]
  N3["L3 平台应用<br/>apps"]
  N4["L4 垂直应用<br/>delivery/channel"]
  N5["L5 扩展<br/>delivery/extension"]
  N6["L6 扩展工具<br/>delivery/extension/tools"]
  N1 --> N2
  N2 --> N3
  N2 --> N4
  N2 --> N5
  N5 --> N6
```
> 依赖方向自上而下；L0 内核独立于应用依赖链。名册真源 `scripts/ci/check-repo-layout.js` 的 `LAYERS`。

## 目录结构与职责
- `apps/` — 多应用（301 文件 / 7.5 MB）
  - `apps/khyos-desktop/`
- `delivery/` — 交付层（L4–L6：垂直应用 / 扩展 / 扩展工具）（795 文件 / 67.3 MB）
  - `delivery/channel/` — 垂直应用载体（L4）
  - `delivery/extension/` — 扩展与交付工具（L5）
- `docs/` — 文档（2149 文件 / 62.7 MB）
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
- `entries/` — 构建产物单一根（LAYOUT-005）（11944 文件 / 2964.5 MB）
  - `entries/apk-unpack/`
  - `entries/electron/`
  - `entries/executables/`
  - `entries/pip/`
  - `entries/research/`
  - `entries/ruleguard/`
  - `entries/tools/` — 工具
  - `entries/workflow-out/`
- `runtime/` — 运行时层（L0–L2：内核 / Python 启动 / Node 业务）（4095 文件 / 36.4 MB）
  - `runtime/boot/` — 引导层（L0）
  - `runtime/node/` — Node 运行时（L2）
  - `runtime/substrate/` — Python 启动层（L1）
- `scripts/` — 脚本（构建/CI/运维）（497 文件 / 5.3 MB）
  - `scripts/admin/`
  - `scripts/backend/` — 后端
  - `scripts/brand/`
  - `scripts/ci/`
  - `scripts/copyright/`
  - `scripts/desktop/` — 桌面端
  - `scripts/docs/` — 文档
  - `scripts/evidence/`
  - `scripts/frontend/` — 前端
  - `scripts/hooks/`
  - `scripts/install/`
  - `scripts/lib/` — 库代码
- `vibe_images/` — TODO(人工): 补全顶层目录职责（9 文件 / 16.8 MB）
- `works/` — 工作区（数据 / 记录 / 打包 / 门禁）（179 文件 / 85.7 MB）
  - `works/brand/`
  - `works/deploy/` — 部署
  - `works/design/`
  - `works/market/`
  - `works/patches/`
  - `works/ship/` — 发布物与打包清单
- 根文件: `.clinerules`, `.dockerignore`, `.editorconfig`, `.env.example`, `.gitattributes`, `.gitignore`, `.npmrc`, `.portable`, `AGENTS.md`, `CHANGELOG.md`, `CLAUDE.md`, `Dockerfile`, `MANIFEST.in`, `Portable.lnk`, `README.md`, `docker-compose.yml`, `fly.staging.toml`, `install-khy.ps1`, `khy-cli.bat`, `khy-env.bat`

## 构建 / 运行 / 测试
- **安装**: `npm install` ; `pip install -e .`
- **测试**: `npm test --workspaces --if-present` ; `pytest`

## 关键文件符号速览
> 导航 teaser（按详略档位裁剪，`KHY_META_DETAIL=brief|standard|full`）。完整逐文件逐符号清单见 `CONTEXT.yaml`。
- `khy.sh` (shell): _无导出符号_
- `portable-setup.sh` (shell): _无导出符号_
- `entries/launch.js` (javascript): fail, printUsage, translate, main
- `scripts/check_builtin_keys.py` (python): array_bytes, decode_arrays, iter_source_files, changed_paths, find_apks, scan_blob, main
- `scripts/findIgnored.js` (javascript): findStandaloneTestFiles
- `scripts/gen_keys.py` (python): keys_file, load_keys, encode, decode, dart_arrays, load_endpoints, camel, _emit, render, check
- `scripts/install-hooks.sh` (shell): _无导出符号_
- `scripts/test-replace.js` (javascript): _无导出符号_
- `apps/khyos-desktop/electron.vite.config.ts` (typescript): _无导出符号_
- `apps/khyos-desktop/vite.host.config.ts` (typescript): _无导出符号_
- `apps/khyos-desktop/vite.scheduler.config.ts` (typescript): _无导出符号_
- `entries/research/archer-geo.js` (javascript): creased, v3, hull, cbox, superPts, f, cyl, cylZ, cylX, ring, …(+20)
- `entries/research/engine.js` (javascript): fsMat, Engine, blur
- `entries/research/glsl.js` (javascript): _无导出符号_
- `entries/research/lev-anim.js` (javascript): of, vecCurve, layCurve, get, f, atDist, mid, f, layBody, brP, …(+12)
- `entries/research/lev-body.js` (javascript): ss, gauss, curve, section, scuteH, sculpt, bellyOf, loftBody, place, addV, …(+20)
- `entries/research/lev-mat.js` (javascript): VS, hideMaterial, Geo, addTube, th
- `entries/research/lev-spine.js` (javascript): spineGLSL, Spine, baseQuat, ArcPath
- `entries/research/main.js` (javascript): dept, num3, stateFor, renderState
- `entries/research/materials.js` (javascript): base, mat, celMaterial, overlayMaterial
- `entries/research/passes-env.js` (javascript): _无导出符号_
- `entries/research/render.mjs` (javascript): stamp, log, logOnly, fmtT, pad5, sourceHash, walk, reapOrphan, noteErrors, n, …(+16)
- `entries/research/util.js` (javascript): mulberry32, Rng, clamp, lerp, invLerp, smooth, smoother, easeIn, easeOut, easeInOut, …(+8)
- `scripts/admin/_check-credentials.js` (javascript): _无导出符号_
- `scripts/admin/_create-admin.js` (javascript): main
- `scripts/admin/_del-creds.js` (javascript): _无导出符号_
- `scripts/admin/_fix-admin.js` (javascript): query, main, loginReq
- `scripts/admin/_insert-user.js` (javascript): main
- `scripts/admin/_insert-user.py` (python): _无导出符号_
- `scripts/admin/_reset-users.py` (python): _无导出符号_
- `scripts/backend/fix-deprecated-encoding.js` (javascript): processFile, fixDeprecatedEncoding
- `scripts/brand/build-brand-assets.js` (javascript): findBrowser, gradientDef, markSvg, MARK_BBOX, appIconSvg, off, faviconMarkSvg, lockupSvg, wordmarkSvg, filingMarkSvg, …(+17)
- `scripts/brand/build-pet-model.py` (python): srgb, make_mat, set_input, make_mark_mat, shade_smooth, add_sphere, add_cyl, add_cone, add_cube, add_torus, …(+17)
- `scripts/brand/build-pet-realistic-relief.py` (python): linear_to_srgb, dilate, erode_std, erode, morph_close, flood_from_border, cutout_background, write_cutout, setup_scene, build_relief, …(+5)
- `scripts/brand/build-pet-realistic.py` (python): parse_args, clear_scene, setup_scene, aim_camera, rot, world_bounds, strip_stray_geometry, bake_and_normalize, export_glb, render_previews, …(+3)
- `works/brand/khy-brand-geometry.js` (javascript): f, polar, a, orient, toPath, ringBladePaths, kSlotPaths, corePath, markParts
- `works/brand/khy-brand-wordmark.js` (javascript): _无导出符号_
- `apps/khyos-desktop/dist-ts/electron.vite.config.d.ts` (typescript): _无导出符号_
- `apps/khyos-desktop/dist-ts/electron.vite.config.js` (javascript): _无导出符号_
- `apps/khyos-desktop/tests/agentWriters.test.mjs` (javascript): makeProxyFiles, card, card, card
- `apps/khyos-desktop/tests/agentbusClient.test.mjs` (javascript): load, sleep, startFakeBus, reply, emitEvent, closeBus, finish, writeFailingConnect, connectImpl, fakeAdb, …(+14)
- `apps/khyos-desktop/tests/agentbusPanel.harness.tsx` (typescript): Root, Loose, setStatus, setResult, setAsk, setSettingsReply, emitEvent, mount, unmount
- `apps/khyos-desktop/tests/agentbusPanel.test.cjs` (javascript): flush, text, buttons, byText, click, type, typeInput, read, hits
- `apps/khyos-desktop/tests/agentbusProtocol.test.mjs` (javascript): load, frame, msg, sessionOf
- `apps/khyos-desktop/tests/amooBridge.test.mjs` (javascript): tempState, writeRuntime, writeToken, startFakeBridge, send, startUnhealthyBridge, fakeSpawn, tempBridgeRoot
- `apps/khyos-desktop/tests/amooPanel.harness.tsx` (typescript): Root, Loose, runningStatus, setStatus, setSend, setInbox, mount, unmount
- `apps/khyos-desktop/tests/amooPanel.test.cjs` (javascript): flush, text, buttons, byText, click, type
- `apps/khyos-desktop/tests/amooSecretary.test.mjs` (javascript): withRepoRoot, fakeClient, getPayload, coreTimer, drain, walkClock, coreClient, coreHarness, refusal, probeWith, …(+3)
- …其余 72 个文件的符号见 `CONTEXT.yaml`（完整逐文件清单）。

