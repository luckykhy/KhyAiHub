# android-agent-kit · vendored 出处与使用边界

本目录是**逐字入库**的上游代码，不是本仓实现。改行为请写适配层
（`runtime/node/backend/src/services/domain/network/phone/androidRef/`），
本目录内文件一行不改——上游行号在本仓文档与测试里被引用，改一个字就对不上了。

## 上游

| 项 | 值 |
| --- | --- |
| 来源 | `android-agent-kit` v0.1.0（GitHub 归档包 `android-agent-kit-main.zip`） |
| 版本日期 | 2026-10-27（上游 `MANIFEST.md` §头部「版本日期」） |
| 归档快照 | `android-agent-kit-main.zip`，787,345 B，SHA-256 `691916c7fba717c8ac5444cf8e79eafe2e986597797c2c65fa19258dfe7fab1a` |
| 许可证 | Apache-2.0（模块根 `LICENSE`，全文 11,358 B） |
| 版权人 | **无具名版权人**。三份 `LICENSE`（仓库根 / `uidref/` / `screendiff/`）逐字节相同，SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`，附录仍是未填占位「Copyright [yyyy] [name of copyright owner]」；上游 md/py/js/json/toml 里 `Copyright` 零命中 |

**为什么不填版权人**：Apache-2.0 §4(a) 要求分发时保留许可证原文与（若有）NOTICE。
上游没有具名版权人，替它编一个等于伪造归属；原样保留未填占位是唯一诚实的做法。

## 版本钉与 B-M1 #6 偏差（批准 ledger 行即同时批准本条）

B-M1 第 6 条要求 vendored 登记写明「依赖版本与上游 commit」。本条目**做不到 commit
那一半**，原因是上游归档本身没有：`android-agent-kit-main.zip` 解包后根目录只有
`LICENSE` / `MANIFEST.md` / `README.md` / `QUICKSTART.md` / `requirements.txt` /
`run-tests.sh` / `.gitignore` / `.gitattributes` 与各模块目录——**没有 `.git` 目录**
（`.gitignore`/`.gitattributes` 只是快照里的两个文件，不含历史），全归档 217 个文本
文件（md/py/js/json/toml/txt/sh + 上述两个点文件）grep `commit` 与 40 位十六进制哈希
**零命中**（本批实测；
该归档是 GitHub 的 main 分支快照下载，不是 `git clone`）。

因此版本钉只能钉快照：

```
versionPin = 归档快照：zip SHA-256 = 691916c7fba717c8ac5444cf8e79eafe2e986597797c2c65fa19258dfe7fab1a
             + 上游 MANIFEST.md 版本日期 2026-10-27
```

批准 ledger 行前请看清三件事：

1. `approvedBy` / `approvedAt` **同时就是批准这条 B-M1 #6 偏差**——批准的是一个
   归档快照哈希，不是一个「看起来像 commit」的值；
2. 日后若拿到上游真 commit（上游补 tag、或提供 git 历史），**必须换钉**，并在 ledger
   `notes` 写明换钉原因与新旧值（B-L3：versionPin 一旦登记不得静默变更）；
3. 复核不依赖网络：任何拿到同一 zip 的人重算 SHA-256 即可确认与本目录同源。

`FEATURE-OWNERSHIP.json` 的 `notes`（androidui 批同批落）会再写一遍这条偏差——B-M1 #6
的字面落点是那一行（`method='vendored'` 的登记载体），本文件是它的证据附件。

## 逐字声明

除本文件（`SOURCE.md`——本批新写的出处文档，不在上游归档中）外，本目录全部文件按归档
原始字节复制（二进制拷贝，未做行尾归一化、未重排、未加注释），入库时逐文件 SHA-256
与归档内同名文件比对一致（13 个具名文件 + 13 个向量全部一致）。行为校验脚本见
`runtime/node/backend/tests/vendor/androidAgentKitConformance.test.js`
（该测试不比对上游哈希——上游归档不入仓；它比对行为：向量 + 真实 dump）。

## 文件清单

`uidref/js` 5 个文件 613 行，`screendiff/js` 3 个文件 273 行（`find /c /v ""` 实测，含空行）：

| 本仓路径 | 字节 | 行 | 用途 |
| --- | --- | --- | --- |
| `uidref/LICENSE` | 11,358 | — | Apache-2.0 全文（§4(a) 随包保留） |
| `uidref/js/uidref.js` | 15,097 | 433 | 核心库：uiautomator XML → snapshot + digest + 稳定 ref |
| `uidref/js/conformance.js` | 3,175 | 97 | 向量运行器（CLI 壳） |
| `uidref/js/impl.js` | 1,206 | 48 | 契约 CLI 包装（XML 文件 → JSON） |
| `uidref/js/dumpjson.js` | 798 | 21 | 跨语言差分工具（CLI 壳） |
| `uidref/js/package.json` | 365 | 14 | 零依赖清单：`:4` description、`:5` license `Apache-2.0`、`:11` engines `node>=18`、`:12` dependencies 为空对象 |
| `uidref/vectors/*.json` | — | — | 7 个向量文件 / 45 个用例（上游自带，随包） |
| `uidref/fixtures/settings-storage.xml` | 29,361 | — | 真实设备 dump（见下「夹具」） |
| `screendiff/LICENSE` | 11,358 | — | 同上 |
| `screendiff/js/screendiff.js` | 7,019 | 204 | 核心库：两份 snapshot → ChangeSet / effectOf / isStuck / isLoading |
| `screendiff/js/conformance.js` | 2,083 | 38 | 向量运行器（CLI 壳） |
| `screendiff/js/impl.js` | 848 | 31 | 契约 CLI 包装 |
| `screendiff/vectors/*.json` | — | — | 6 个向量文件 / 27 个用例 |
| `screendiff/fixtures/c1.xml` | 22,754 | — | 真实设备 dump，diff 的 prev |
| `screendiff/fixtures/c2.xml` | 22,841 | — | 真实设备 dump，diff 的 cur |

`screendiff/js` 没有 `package.json`（上游就没有），所以没有第二条零依赖声明可抄；
它的零依赖是实测事实：`screendiff.js` 全文零 `require`，`conformance.js` / `impl.js`
只引 `fs`/`path`/`process` 这类 Node 内建。

## 夹具（fixtures/）

三份 XML 是**上游自带测试数据**（真实设备 uiautomator dump），不是用户界面截图，
来自上游 `uidref/dumps/settings-storage.xml`、`screendiff/dumps/c1.xml`、
`screendiff/dumps/c2.xml`，Apache-2.0 随包。它们放在模块自己的 `fixtures/` 下（与
`LICENSE` 同模块根），因此仍受 B-M1 第 4 条「同路径保留 LICENSE」覆盖。

其余 dump 不入库：上游四处 `dumps/` 共 32 份（`uidref/dumps` 16、`screendiff/dumps` 4、
`scrollkey/dumps` 7、`crosstrack/dumps` 5），只收录这 3 份；未收录的 29 份中还有多组内容
重复（例如 `c1.xml` 与 `settings-search.xml` 同内容），入仓只会增加体积而不增加覆盖。

## 未入库（excluded）

| 未入项 | 原因 |
| --- | --- |
| 6 个 Python 模块（`screenpoint`/`pointparse`/`imespec`/`blindspot`/`fieldstate`/`swipefind`）与 `scrollkey`/`crosstrack`/`claimcheck`/`claimaudit`/`capturetrap`/`textin`/`e2e` | 宿主是 Node，不为此引入 Python 运行时；按需分批移植成 TS，届时按 `method='reference'` 另行登记，不复制上游源码 |
| `uidref/http_api.py`（本地 `:8770` 回环服务） | 同上；桌面侧用 JS 实现，不跑 Python sidecar |
| `tests/`、`tools/`、`docs/`、`提案/`、各模块 `README*.md` / `SPEC.md` | 文档与设备探针脚本，运行时不需要 |
| 其余 29 份 dump（`uidref/dumps` 另外 15 份、`screendiff/dumps` 的 c3/d1、`scrollkey/dumps` 7 份、`crosstrack/dumps` 5 份） | 见上「夹具」 |
| `uidref/` 下的 0 字节杂物文件「1」 | 上游解压遗留，非代码 |

## Node 使用注意

- `uidref.js` 核心只需一个 Node 内建：`:12` `require('crypto')`。
- 两处 `Buffer.byteLength`：`uidref.js:309`（`xml_bytes`）与 `:374-376`（digest 字节数与
  `compression`/`est_tokens`）。浏览器环境需以 `TextEncoder` 替换。
- `uidref.js:333` `crypto.createHash('sha256')`（`snapshotIdOf`）。浏览器环境需 WebCrypto，
  或改由本仓适配层注入 snapshot id。
- 因此 `uidref.js` 与 `screendiff.js` 只在 Node 后端可用；`conformance.js` / `impl.js` /
  `dumpjson.js` 是 CLI 壳（`fs`/`path`/`process`），不经后端加载。

## 上游 quirk（照录，不改）

`uidref.js:320-321`：`parse()` 返回的 `digest()` / `metrics()` 闭包只传了
`{package, rotation, width, height, elements…}`，**没有传 `snapshot_id`**。后果：

- `p.digest()` 的首行渲染成 `[undefined] <package> <w>x<h> rot=… elements=…`
  （实测：`[undefined] com.android.settings 1080x2337 rot=0 elements=11`）；
- `p.metrics()` 的返回对象里**没有 `snapshot_id` 字段**（`undefined` 被 JSON 序列化丢掉）。

vendored 文件不改这个行为（改了就不是逐字入库）。适配层要用 snapshot id 时取
`p.snapshot_id`，**不要**解析 `digest()` 首行；冒烟断言同理。两个函数的其余输出正常，
可以照常使用。

## 可整删

`deletableAsWhole: true` —— 删掉本目录后，本仓失去 `androidRef` 适配层的底层实现（表现为
`uidrefAdapter` 加载失败并按 fail-soft 报错），但不会影响任何其他模块、构建或测试装配；
本仓自己的代码里没有对上游文件的引用（引用只出现在适配层与
`tests/vendor/androidAgentKitConformance.test.js`）。

## 登记状态（两步走，本 PR 只完成第一步）

1. **`SOURCING-PROVENANCE.json`**：本目录记为 `observedVendorDirs.dirs[]` 的
   `state: "pending-approval"`，并由 `knownGaps` 的 `gap-5` 覆盖（`path` 与目录逐字相等；
   `gap-5` 的 `description` 里写明同上「B-M1 #6 commit 缺失偏差」，批准人读 gap 即可见）。
   **不写 `ledger` 行**：`check-provenance.js:114-118` 对 vendored 缺 `approvedBy` 直接判
   error，而 `approvedBy` 必须是维护者且 ≠ 实现者（B-P3），属 `STOP_FOR_USER` 的
   **人的决定**，AI 不得代填。批准人提交 ledger 行时：`versionPin` 用上文「版本钉与
   B-M1 #6 偏差」里的快照字符串、`approvedBy`/`approvedAt` 一并即批准该偏差；随后把
   state 改回 `ledgered`、删掉 `gap-5`。
2. **`FEATURE-OWNERSHIP.json`** 的 capability 行（`domain: "android-ui-ref"`、
   `method: "vendored"`）**由 androidui 批次同批落**：`check-feature-ownership.js:116-118`
   （`ownership-canonical-missing`）要求 `canonical` 在盘上存在，而 canonical
   （`runtime/node/backend/src/services/domain/network/phone/androidRef/index.js`）
   由 androidui 创建，本批次不能先写。
