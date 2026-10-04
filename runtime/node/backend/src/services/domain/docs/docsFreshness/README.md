# docsFreshness — 文档新鲜度自检（D2 功能单元）

一句话：代码常更新、文档跟不上。本单元把「改了源码 → 哪些文档可能过时，请复核」做成
**四层可判定流水线**：L1 从文档正文既有约定反推 source→doc 映射并列出嫌疑（纯解析）、
L2 规划已 committed 的 .html/.pdf 兄弟重生成（纯规划）、L3 按 SSOT 填充 `khy-docs-sync`
标记块的值（纯替换）、L4 为高置信嫌疑构造改稿提示词（纯文本）；IO（git / 读 docs / 写盘 /
re-stage / 调 md-to-pdf）全部收在唯一的薄壳 `docsFreshnessRunner.js` 里。

清单：`khy.module.json`（`domain` / `mayDependOn` / `fanIn` / `lifecycle.stage` 四字段被
`npm run check:layout` 的 entry-buffer 规则读取，其余给人看）。
入口：`khy docs check`（`services/backend/src/cli/handlers/docs.js` 的 `handleDocsFreshness`）。
定位：**warn-only** —— 默认只报不写；写盘只发生在 `fix` 模式；CI 阻断由 handler 依
`KHY_DOCS_FRESHNESS_BLOCK` / `--ci` 决定退出码，本单元自身不决定阻断。

## 逐成员

| 文件 | 角色 | 仓内 require | 同名测试 |
|------|------|-------------|----------|
| `docPathIndex.js` | L1 纯叶子：反引号正文 → 源码路径 → 反向索引 → exact/prefix 嫌疑 | 无（零 require） | `docPathIndex.test.js` |
| `docProductPlan.js` | L2 纯叶子：变更 .md + committed 产物清单 → 重生成计划 | 无 | `docProductPlan.test.js` |
| `docMarkerSync.js` | L3 纯叶子：`khy-docs-sync` 标记块按 valueMap 填充（幂等） | 无 | `docMarkerSync.test.js` |
| `docSuggestDraft.js` | L4 纯叶子：改稿提示词构造器（不调模型、不写文件） | 无 | `docSuggestDraft.test.js` |
| `docsFreshnessRunner.js` | 唯一 IO 薄壳：git 探测、读 `docs/**.md`、写盘、re-stage、调 md-to-pdf | `child_process/fs/path`（内建）、单元内 3 件、`src/utils/gitSoftExec`、`src/constants/commandSchema`、`src/constants/serviceDefaults`（均 D3） | `docsFreshnessRunner.test.js` |

四个叶子是**真零 IO**：源码里连 `require(` 都不出现，env 只在默认参数一处（`env = process.env`），
这条由各份同名测试的「纯度锁」守住，不靠注释。

外部消费者 2 个（fanIn 实测口径见清单 `_fanIn_note`）：
`cli/handlers/docs.js`（取 `docsFreshnessRunner` + `docSuggestDraft`）、
`services/docsFreshness/index.js`（归位遗留的再导出壳，逐一 re-export 5 个成员）。

## 契约（每条都有具名测试兜）

1. **门控方言不漂移**：L1/L2/L3 三个开关（`KHY_DOCS_FRESHNESS` / `KHY_DOCS_REGEN` /
   `KHY_DOCS_MARKER_SYNC`）默认开、只有 `{0,false,off,no}` 关且先 trim+lowercase；
   **L4 方向相反**（`KHY_DOCS_AI_SUGGEST` 默认关，仅 `{1,true,on,yes}` 开，且布尔 `true`/数字 `1` 算开）
   → `docPathIndex.test.js`、`docProductPlan.test.js`、`docMarkerSync.test.js`、`docSuggestDraft.test.js`
2. **注入压过环境**（可测性契约）：四个叶子显式传 env 时，进程环境里的同名开关**必须**无效
   → 同上四份测试的「注入 env 优先于进程环境」
3. **正文解析只认锚定路径**：反引号 token 必须首段在 `ROOT_SEGMENTS`、扩展名在 `SOURCE_EXTS`、
   至少 `dir/file` 两段、不含 `..`；行号/范围/列/锚点与 Windows 反斜杠、`./`、前导 `/` 都要剥掉；
   每篇上限 200 条 → `docPathIndex.test.js`
4. **嫌疑分两级且 exact 一定排在前**：exact（文档直接引用该文件）> prefix（同目录兄弟，跨目录绝不命中），
   同一文档先 prefix 后 exact 会升级；输出确定（与入参顺序无关）、`matchedSources` 升序 → `docPathIndex.test.js`
5. **坏输入返回空结构，绝不抛**：`extractSourcePaths(12345)` → `[]`、`buildDocPathIndex(null)` → 空索引、
   `planDocProducts(null, null)` → 空计划、`syncManagedRegions(42, …)` → `text:''`、
   `collectChangedSources` 遇 git 抛错 → `[]` → 对应各叶子测试
6. **L2 红线「绝不新建产物」的清单侧**：`regen.products` 永远是 committed 清单的子集，
   同名兄弟判据不误伤别的文档，`mode` 严格为 `'--html-only' | null`（不是 `undefined`）
   → `docProductPlan.test.js`
7. **L3 三态处置**：已知 key → 块内重建为 `NOTICE + 值`（begin/end 行逐字保留）；未知 key → 整块原样
   + `unknownKeys`；不平衡/嵌套/key 不匹配 → 原样 + `skipped`。嵌套只废外层，内层照常填充。
   free prose 与孤立 end 行绝不动；填过的文本再跑一次 `changed=false`（幂等）
   → `docMarkerSync.test.js`
8. **无 SSOT 不杜撰**：`buildValueMap` 只认 `slash-commands` / `ai-backend-port` / `khy-version` 三个 key，
   缺依赖即不入表，`frontend-port` 永远不入表 → `docMarkerSync.test.js`
9. **L4 两条红线**：①只产文本——零 `require`、不碰 `fs`/`child_process`/网关，片段与 diff 各截 4000 字符，
   最小输入的骨架逐字节固定；②确定性层（L1/L2/L3 + runner）**绝不**引用 `docSuggestDraft`
   → `docSuggestDraft.test.js`（红线②是对 4 个兄弟源文件文本的实扫，不是自我声明）
10. **runner 的 IO 纪律**：门控关 → 返回逐字固定的空壳（连 `changedSources` 都不带）；
    默认 warn-only 零写盘；`fix` 才动盘且幂等；`markerSync:false` 或 `KHY_DOCS_MARKER_SYNC=0` 一个字节都不写；
    `git add` 失败 → `restaged:false`（写盘副作用已发生，如实报）；`git add` 抛错 → `ok:false + err`；
    md-to-pdf 不在位 → Layer 2 空手而归且不新建产物；`docs/**` 读取跳过 `node_modules/.git/bundled/dist/build/.ai/coverage`，
    单篇 > 512 KB 不收（恰好 512 KB 收）→ `docsFreshnessRunner.test.js`

## 已登记的偏差（不在本单元内悄悄修，也不写进 `mayDependOn` 冒充许可）

- **L1 的 ROOT 锚点表不含 `platform` / `software`**：实测 `docs/**.md` 正文里有 103 处
  `` `platform/...` ``、50 处 `` `software/...` `` 引用被 `_cleanSourcePath` 判成非法而丢弃
  （探针 `.khyos/tmp/b23-rootgap-probe.js`）。这两个都是本仓真实的顶层目录，于是「改了 Python 启动器
  或 khyquant 载体 → 哪些文档过时」这条提醒**结构性缺失**。反向也有噪音：表里的 `src`/`bin`/`lib`/
  `packages`/`frontend` 五个段在本仓根**并不存在**，它们产生的索引键永远匹配不上 `git diff` 的路径
  （实测 461 处 `src/...` 形式的引用属此类）。头注释自称「假阳/假阴必有，故定位为复核提醒」，
  所以这不是崩溃型缺陷，但它是**可量化的覆盖面缺口**，补哪一段该由人拍板。
- **L2 的 pdf-only 分支曾违反自家「绝不新建产物」红线（本批已修，planner 现给 --pdf-only）**：committed 只有 `.pdf` 时 planner 给 `mode:null`
  （全量），runner 据此**不带 flag** 调 `scripts/docs/md-to-pdf.js`，而该脚本无 flag 时默认同时写
  `.html` 与 `.pdf`（`md-to-pdf.js:581/585`），且它**从不使用**已经存在的 `--pdf-only`。
  后果：pdf-only 文档的重生成要么新建一个未版本控制的 `.html`（有 Chrome 时），要么整体失败（无 Chrome 时）。
  复现与判据见 `.khy/feedback/b23-docsFreshness/repro-before.txt`。叶子测试只**锁当前 planner 输出**，
  不背书该语义。
- **再导出壳 `services/docsFreshness/index.js` 零消费者**：它 re-export 本单元 5 个成员，
  但全仓没有任何文件 require 它（实测见 `_fanIn_note`）——即一张指向本单元的死地址。
  按 [DESIGN-LAY-008] 归位约定，壳仍算真实入口时才计入 fanIn；这里如实计入并标注其下游为空。
- **L4 的 `buildSuggestionPrompt` 无生产调用者**：handler 的 `--ai` 分支只判了门控就打印
  「已生成提示词模板」，实际一次都没调用构造器（`handlers/docs.js:774-781`）。
  门控与文本本身有测试，「草稿是否真出现在用户面前」没有。
- **同族仓级测试里有一份跑不起来**：`services/backend/tests/services/docSuggestDraft.test.js` 是
  jest 方言（`describe/expect`），`node --test` 直接 `ReferenceError: describe is not defined` 整文件失败，
  且其中两条断言把 `.toBeTruthy()` 写进了字符串字面量（恒真、无判定）。本目录的共置测试是它的替代品，
  旧文件按「不修改既有文件」的约束留在原地。
- **CRLF 文档的块内注入行用 LF**：`docs/` 下 125 个 `.md` 工作树是 CRLF，标记块被填后会出现
  LF/CRLF 混排（第二次跑即收敛，不会反复 re-stage）。现状由 `docMarkerSync.test.js` 锁定，不美化。

## 怎么跑

```bash
# 共置契约测试（node:test 方言；Windows 下必须逐个列文件名，目录参数会被当模块路径）
node --test \
  services/backend/src/services/domain/docs/docsFreshness/docPathIndex.test.js \
  services/backend/src/services/domain/docs/docsFreshness/docProductPlan.test.js \
  services/backend/src/services/domain/docs/docsFreshness/docMarkerSync.test.js \
  services/backend/src/services/domain/docs/docsFreshness/docSuggestDraft.test.js \
  services/backend/src/services/domain/docs/docsFreshness/docsFreshnessRunner.test.js

# 守卫（functional-unit 共置 + entry-buffer 清单）
node scripts/ci/check-repo-layout.js --list=functional-unit
node scripts/ci/check-repo-layout.js
```

runner 的测试自带临时仓库 fixture（建在 `.khyos/tmp/` 下、`t.after` 清理），
git 一律走注入的假 `gitSoft`，**绝不**碰真 git、真 `docs/`；fix 分支的测试也只写自己的 fixture 文件，
并断言 fixture 内不存在 `scripts/docs/md-to-pdf.js`，所以永远不会执行真实产物工具。

`*.test.js` / `*.md` / `*.json` 不计入源文件数，所以本单元的记录动作是
「5 份同名同目录测试 + 1 份清单 + 本 README」：按守卫实测，每补一份共置测试 `functional-unit` 降 1，
补清单一次 `entry-buffer` 降 5。
