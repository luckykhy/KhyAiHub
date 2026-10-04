<!-- khy-metadata:auto khy-metadata/4 fingerprint=827777870c045271 -->
<!-- 本文件由 khy 机械生成，可被 `khy metadata refresh` 安全覆盖。删除上面这行标记即视为人工接管，刷新将不再覆盖本文件。 -->
# MAP — backend 骨架与导航

> 由 khy 自动生成的可维护性种子文档（无需 AI 即可据此维护）。配套 `.ai/CONTEXT.yaml`（契约/符号）`.ai/GUARDS.md`（红线/无AI维护指南）。
> 本文为确定性扫描产物：目录职责按约定推断，入口/构建命令来自 manifest，符号清单来自轻量正则。带 `TODO(人工)` 处需维护者补全意图。

## 技术栈
`node` · `node>=20.18.1` · `docker`

## 核心入口点
- `server.js` (node-main, package.json#main)
- `./bin/khy.js` (cli-bin, bin:khyquant)
- `./bin/khy.js` (cli-bin, bin:khy-os)
- `./bin/khy.js` (cli-bin, bin:khy)

## 目录结构与职责
- `_产物/`
- `akshare_scripts/`
- `assets/` — 静态资源
  - `assets/mascot/`
- `config/` — 配置
  - `config/models/` — 数据模型
- `data/`
  - `data/training/`
- `migrations/` — 数据库迁移
- `pack/`
- `python/`
- `scripts/` — 脚本（构建/CI/运维）
- `sql/`
- `src/` — 源代码主目录
  - `src/adapters/`
  - `src/agents/`
  - `src/assistant/`
  - `src/blueprints/`
  - `src/bootstrap/`
  - `src/bridge/`
  - `src/buddy/`
  - `src/classic/`
  - `src/cli/`
  - `src/commands/`
  - `src/config/` — 配置
  - `src/constants/`
- `test/` — 测试
- `test-data-criterion-1/`
- `test-data-criterion-2/`
  - `test-data-criterion-2/db_backup/`
- `test-data-criterion-3/`
- `tests/` — 测试
  - `tests/__tests__/` — 测试
  - `tests/_smoke/`
  - `tests/agents/`
  - `tests/bootstrap/`
  - `tests/bridge/`
  - `tests/ci/`
  - `tests/cli/`
  - `tests/commands/`
  - `tests/config/` — 配置
  - `tests/constants/`
  - `tests/contextScope/`
  - `tests/coordinator/`
- `wasm-chain/`
  - `wasm-chain/cmd/`
- `wasm-context/`
  - `wasm-context/cmd/`
- `wasm-indicators/`
  - `wasm-indicators/cmd/`
- 根文件: `.cbssp-test.log`, `.env`, `.env.bak-20260914-codexpin`, `.env.bak-20260917-statusfix`, `.env.bak-cleanup`, `.env.example`, `.eslintrc.json`, `.gitignore`, `.khy_ide_gateway_configured`, `.khy_kiro_cw_sdk_fixed`, `.khy_quant_bootstrapped`, `.khy_quant_optional_fixed`, `.khy_quant_seeded`, `.khy_trae_bridge_installed`, `.khy_version_stamp`, `.khyos-diag-tui-final.txt`, `.npmrc`, `.prettierignore`, `.prettierrc`, `Dockerfile`

## 构建 / 运行 / 测试
- **安装**: `npm install`
- **运行**: `npm start` ; `npm run dev`
- **测试**: `npm test`

## 关键文件符号速览
> 导航 teaser（按详略档位裁剪，`KHY_META_DETAIL=brief|standard|full`）。完整逐文件逐符号清单见 `CONTEXT.yaml`。
- `TmpKoh.java` (java): TmpKoh
- `check-env.js` (javascript): _无导出符号_
- `create-test-users.js` (javascript): _无导出符号_
- `docker-entrypoint.js` (javascript): _无导出符号_
- `esbuild.config.js` (javascript): build, sizeKB
- `eslint.config.js` (javascript): _无导出符号_
- `inference_server.py` (python): get_model, InferenceHandler, log_message, _send_json, do_GET, do_POST, _timeout_handler, main
- `jest.config.js` (javascript): findNodeTestFiles, findStandaloneTestFiles, escapeRegExp
- `make_proxy.py` (python): od
- `proxy.js` (javascript): sj, se, ct, at2o
- `proxy_test2.js` (javascript): _无导出符号_
- `reset-database.js` (javascript): main
- `server.js` (javascript): _buildDefaultCorsOrigins, _discoverPgPaths, mountOptional, reportSkippedMounts, createAiProxy, healthHandler, getActiveWsClientCount, resetIdleShutdown, startIdleShutdownIfEmpty, startWsProtocolHeartbeat, …(+9)
- `setup.js` (javascript): ok, fail, warn, info, step, getPlatform, cnMirrorOptIn, runSilent, runVisible, createPrompt, …(+13)
- `start-daemon.js` (javascript): main
- `start-with-db.js` (javascript): findPostgreSQLPath, checkPostgreSQLStatus, startPostgreSQL, startBackend, main
- `test-db-connection.js` (javascript): main
- `akshare_scripts/akshare_data.py` (python): setup_session, patched_get, patched_post, get_stock_realtime, get_stock_kline, get_index_realtime
- `akshare_scripts/akshare_data_fixed.py` (python): create_session, get_stock_realtime, get_stock_kline, get_index_realtime
- `akshare_scripts/akshare_data_full_history.py` (python): get_stock_realtime, get_stock_kline, get_index_realtime
- `akshare_scripts/akshare_data_server.py` (python): get_stock_kline
- `akshare_scripts/akshare_data_v2.py` (python): get_stock_kline
- `akshare_scripts/alternative_data_sources.py` (python): normalize_symbol, http_get, fetch_eastmoney_kline, fetch_eastmoney_quote, fetch_tencent_kline, fetch_tencent_quote, fetch_sina_quote, fetch_netease_kline, fetch_netease_quote, fetch_yahoo_kline, …(+4)
- `migrations/add-close-fields.js` (javascript): migrate
- `migrations/add-order-type-field.js` (javascript): addOrderTypeField
- `migrations/add-webauthn-to-users.js` (javascript): up
- `migrations/create-kline-cache-table.js` (javascript): up, down
- `migrations/create-user-favorites-table.js` (javascript): createUserFavoritesTable
- `migrations/fix-instruments-name-nullable.js` (javascript): _无导出符号_
- `scripts/_tmp_dbg.js` (javascript): _bracketBodyEnd
- `scripts/_tmp_dbg10.js` (javascript): _无导出符号_
- `scripts/_tmp_dbg11.js` (javascript): must, immediately
- `scripts/_tmp_dbg12.js` (javascript): safely
- `scripts/_tmp_dbg14.js` (javascript): _无导出符号_
- `scripts/_tmp_dbg15.js` (javascript): must, escapes, char
- `scripts/_tmp_dbg16.js` (javascript): built, means, members
- `scripts/_tmp_dbg18.js` (javascript): excluding
- `scripts/_tmp_dbg2.js` (javascript): _无导出符号_
- `scripts/_tmp_dbg3.js` (javascript): _无导出符号_
- `scripts/_tmp_dbg4.js` (javascript): _无导出符号_
- `scripts/_tmp_dbg5.js` (javascript): should, match
- `scripts/_tmp_dbg6.js` (javascript): in
- `scripts/_tmp_dbg7.js` (javascript): _无导出符号_
- `scripts/_tmp_dbg8.js` (javascript): _无导出符号_
- `scripts/_tmp_dbg9.js` (javascript): is, is, must, containing
- `scripts/ai-manage-daemon.js` (javascript): _runtimeFiles, addActivityProbe, anyProbeActive, noteRequestActivity, getState, _resetForTests, parseIntArg, parsePortArg, parseStringArg, hasFlag, …(+20)
- `scripts/archDebtScan.js` (javascript): intEnv, ratioEnv, listJsFiles, rel, _prevSignificant, _startsRegex, stripComments, extractRequires, scanLayering, scanGodFiles, …(+20)
- `scripts/ccCommandParityAudit.js` (javascript): norm, loadCcCommands, loadKhyCommands, main
- …其余 72 个文件的符号见 `CONTEXT.yaml`（完整逐文件清单）。

