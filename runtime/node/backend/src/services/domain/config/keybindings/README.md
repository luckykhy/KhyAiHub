# keybindings — 键位目录单一真源与 Ctrl+R 反向历史搜索（D2 功能单元）

一句话：把「有哪些快捷键」与「Ctrl+R 往回搜历史该选中哪一条」两件事做成零 IO 叶子——
前者是一张**按上下文分组、与真实处理器一一对应**的键位目录（同时驱动 `/keybindings` 全列举
与 `?` 帮助浮层，取代此前散落且互不一致的几份拷贝），后者是大小写不敏感的**反向增量匹配**
（输入旧→新，命中新→旧，再按跳到更旧一条、到最旧停住不回绕）。

清单：`khy.module.json`（`domain` / `mayDependOn` / `fanIn` / `lifecycle.stage` 四字段被
`npm run check:layout` 的 entry-buffer 规则读取，其余给人看）。

## 逐成员

| 文件 | 角色 | require | 同名测试 |
|------|------|---------|----------|
| `keybindingCatalog.js` | 键位目录 `KEYBINDING_CATALOG`（冻结）+ 精简视图 `ESSENTIAL_SHORTCUTS` + `selectCatalog`（按上下文/查询筛选）+ `formatCatalog`（确定性纯文本渲染）+ `isEnabled` | `../../../../utils/isOffValue`（D3） | `keybindingCatalog.test.js` |
| `historyReverseSearch.js` | 反向搜索决策核心：`search(history, query, {from})` / `nextMatch(history, state)` / `isEnabled(env)` | 无 | `historyReverseSearch.test.js` |

## 消费者（实测 fan-in = 6，均非测试文件）

`cli/handlers/keybindings.js`、`cli/tui/ink-components/HelpMenu.js`、`App.js`、
`HistorySearchOverlay.js`、`cli/tui/chatChords.js`、`services/keybindings/index.js`（D1 再导出壳）。
`utils/flagRegistry/index.js` 与 `utils/isOffValue.js` 的文本里也提到本单元，但实测是注释，不构成边。

## 契约（每条都对应命名测试）

1. **目录是冻结的数据模型**：上下文名唯一、每条都有 `keys` 与非空 `desc`。
   → `catalog shape: frozen groups, unique contexts, every binding has keys + non-empty desc`
2. **诚实边界写进数据而不是承诺**：`Ctrl + J` 标注「实测可用」，
   `Shift + Enter`（与 Enter 同字节）、`Ctrl + Enter`（零字节送达）、`Alt + Enter`（本机不可用）
   一律带终端前提——这是 BUG-35 的教训：只看「处理器有没有这条分支」不够，还须确认终端送得出可区分的字节。
   → `the honest boundary is encoded in the data, not promised away`
3. **筛选是纯函数且绝不抛**：上下文名或中文标签都能寻址、大小写与首尾空白容错；
   查询在 keys/desc/label 三处做子串匹配并丢掉空组；两个条件取交集可为空；
   非对象入参退化为「返回全量副本」。
   → `selectCatalog: ...` 四条用例
4. **返回的是结构副本**：调用方改动拷贝不得污染 SSOT。
   → `selectCatalog: no options is a structural copy of every group`
5. **渲染确定性**：键列右对齐到本组最长键宽 +2 空格、组间恰好一个空行、零 ANSI 颜色；
   空数组/null/空组都产出空串而非抛错。
   → `formatCatalog: group header, two-space indent, key column padded to the widest key`、
   `formatCatalog: two groups are separated by exactly one blank line`
6. **反向匹配的次序与游标**：命中下标天然新→旧；`opts.from` 越界双向 clamp；
   `nextMatch` 到最旧一条停住不回绕；历史与 matches 错位时产出空文本而不是抛错。
   → `search: case-insensitive substring, ordered new→old, indices point into the input`、
   `search: opts.from selects the nth match and is clamped at both ends`、
   `nextMatch: Ctrl+R again walks older and stops at the oldest (bash semantics)`、
   `nextMatch: degenerate states degrade to an empty selection instead of throwing`
7. **两扇门控**：`KHY_KEYBINDINGS` 与 `KHY_HISTORY_REVERSE_SEARCH` 都默认开；
   前者的 off 集含空串（委托 `utils/isOffValue`），后者不含空串——两侧不完全一致，各自钉住以免误改。
   另实测一处**不对称的退化**：`isEnabled(undefined)` 走默认形参 `env = {}` 判**开**，
   而 `isEnabled(null)` 是实值，`env &&` 在默认值之前短路，判**关**——两者结果相反。
   调用方要拿默认开就必须传对象（`{}`）。
   → `isEnabled: KHY_KEYBINDINGS default-on, off values close it`、
   `isEnabled: default on; only the four off values close it`

## 已知偏差与限制

- **不提供重映射引擎**：khy 的键位硬编码在 Ink 输入处理器里，没有「配置文件 → 解析 → 喂处理器」的通路。
  刻意不对齐 Claude Code 的那一半，因为写一套跑不通的 JSON 重映射就是假功能。将来真接通输入层再议。
- **`ESSENTIAL_SHORTCUTS` 实测 18 条，而源码注释写「只列最常用的 15 条」**——文档漂移。
  测试按实测 18 钉住（`essential view is frozen tuples and comes from the same module`），
  增删条目时注释与测试必须同步；这条属**注释订正**，不在本单元擅改语义。
- `getEssentialShortcuts()` 返回的是 SSOT 本身（冻结数组），不是副本；调用方只能读，不能改。

## 怎么跑

```bash
node --test services/backend/src/services/domain/config/keybindings/keybindingCatalog.test.js \
  services/backend/src/services/domain/config/keybindings/historyReverseSearch.test.js
node scripts/ci/check-repo-layout.js --list=functional-unit | grep -c "config/keybindings"   # 期望 0
node scripts/ci/check-repo-layout.js --list=entry-buffer | grep -c "domain/config/keybindings" # 期望 0
```

新增 `README.md` 后须跑 `node scripts/docs/build_docs_site.js` 生成同名 `.html` 孪生，
否则 `node scripts/docs/verify_docs_site.js` 会报缺件。
