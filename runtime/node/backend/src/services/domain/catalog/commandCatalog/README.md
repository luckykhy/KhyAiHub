# commandCatalog — khy 功能索引的分组目录（D2 功能单元）

一句话：把命令注册表 SSOT（`constants/commandSchema` 的 `getBuiltinSlashCommands`）整形成
**按类分组、可浏览、可折叠别名**的功能目录，让 CLI/TUI 的 `/features`、HTTP 的 `GET /api/commands`、
前端「功能索引」视图三处消费**同一份**数据——goal「有了功能用户却不知去哪用」的单一真源。

本叶子只**整形与分组，不发明功能**：清单永远来自 SSOT，它自己不持有任何命令知识。

清单：`khy.module.json`（`domain` / `mayDependOn` / `fanIn` / `lifecycle.stage` 四字段被
`npm run check:layout` 的 entry-buffer 规则读取；本单元的 D2→D1 边按偏差登记，不写白名单）。

## 逐成员

| 文件 | 角色 | require | 同名测试 |
|------|------|---------|----------|
| `commandCatalog.js` | 门控判定 + 目录整形（分组、排序、字段规整、别名折叠） | `../../../../utils/trimIfString`（D3）、`../../../../constants/commandSchema`（D3，命令 + 别名 SSOT，惰性）、`../../../commandOverlapAudit`（**D1**，面板门控集中判定，缺失则不折叠） | `commandCatalog.test.js` |

## 消费者（实测 fan-in = 4）

`cli/handlers/features.js`（`/features`）、`routes/commands.js`（`GET /api/commands`）、
`services/commandCatalog/index.js`（D1 再导出壳）、`services/selfProfile.js`（自审画像）。

顺带一条实测事实：那个 D1 再导出壳自身在 `src/` 下**零消费者**——三个消费方都直接 require D2 路径，
壳只为历史路径兼容留着（与 `memory/compact` 的壳情况不同：那边的壳是唯一入边）。

## 契约（每条都对应命名测试）

1. **两道门各管一件事，且关档都是逐字节回退**：`KHY_COMMAND_CATALOG` 关 → 整个目录是
   `{categories:[],total:0,generatedBy:'commandSchema'}`（消费方据此隐藏入口）；
   `KHY_COMMAND_PRIMARY_PANEL` 关 → 不折叠别名，退回全量列举，且**不添加 `aliases` 字段**。
   → `gate is default-on and only the documented off-words disable it`、
   `a disabled gate returns the empty directory, byte-for-byte the documented shape`、
   `panel off keeps every row and adds no aliases field (byte-for-byte fallback)`
2. **关闭词表是显式的**：`0/false/off/no/disable/disabled`（大小写与两端空白不敏感）关闭；
   空白、缺省、null、无法识别的取值一律**开**；坏 env（null / 无参）不抛。
   → `gate treats absent/blank/whitespace as on and never throws on a bad env`
3. **排序确定**：类别按 `CATEGORY_META.order`，同 order 按 key 字母序；组内命令按 `cmd` 字母序；
   `total` 恒等于各组命令数之和（不自相矛盾）。
   → `categories sort by CATEGORY_META.order then key, commands sort by cmd`
4. **条目只留发现所需的最小字段**：`{cmd,name,label,desc,route}`（折叠时才追加 `aliases`）；
   `label` 缺省回退去斜杠的 `name`，`desc` 缺省回退 `description`，再缺省为空串（不出现 undefined）。
   → `each entry is normalized to the discovery minimum`、
   `label falls back to the slash-stripped name and desc falls back to description`
5. **绝不抛，脏数据只被跳过**：`null` / 字符串 / 数字条目、空白 `cmd`、纯斜杠 `cmd`（`/`、`//`）
   都被丢弃；命令源不可达（返回非数组或自己抛错）→ 空目录。
   → `junk entries are skipped rather than thrown on`、
   `an unresolvable command source yields the empty directory, not a throw`
6. **同桶内按 cmd 去重，保留首次**（第一次出现的 desc 胜出，不是后者覆盖）。
   → `duplicate cmd within a category is folded to the first occurrence`
7. **未知类别兜底「其他」**（`order: 99`），不会被塞进已知组、也不会顶掉排序。
   → `unknown categories land in the 其他 bucket with order 99`
8. **别名折叠是 route 驱动**：`COMMAND_ALIASES` 的值是 canonical 的 **route**，凡 route 命中的条目
   挂上排序后的 `aliases[]`，别名自身不再单独占位。因此别名可以落到另一条 cmd 上（实测：
   `/apikey` 折叠进 route 为 `gateway config` 的那一行）。用例注入的是**真别名表**，不是假数据。
   → `panel on drops the alias row and hangs it under the canonical command`、
   `folding is route-driven, so an alias joins the canonical row even under another cmd`
9. **对真 SSOT 防空转**：不加注入地跑一遍真实命令表，断言输入面 >0（210 条命令）、
   每个类别都有非空中文标签与整数 order、每组非空、`total` 与分组之和一致。
   → `the real SSOT builds a non-empty directory with every label resolved`

## 本单元修掉的缺陷（B26-F1，复现/复诊在 `.khy/feedback/b26-F1/`）

`_categoryMeta` 原本写作 `CATEGORY_META[cat] || CATEGORY_META.other`，而 `cat` 取自**数据字段**
（命令的 `category`）。当它是 `constructor` / `valueOf` / `toString` 这类 `Object.prototype`
继承键时，取到的是继承值而不是兜底「其他」，于是分组头的 `label` 与 `order` 双双变成 `undefined`，
排序也退化成按 key 字母序。改法是本文件别名折叠处已经在用的 `hasOwnProperty` 自有键判定；
对表内 8 个类别**逐字节等价**，真实 SSOT 的 7 个类别读数不受影响（复现文件里最后一行就是这条证据）。
这是本会话在 D2 里第 **4** 次命中同一族失效模式（前三次：`executorRegistry.getExecutor`、
`intentTrees.getIntentTree`、以及 `formatInspect` 里核实后判定不可达而未改的那处）。
→ `a category named after an Object.prototype key still falls back to 其他`

## 已知边界（现状，**未**由本单元改动）

- 门控词表在本叶子是**本地实现**（`_OFF` 常量），与仓内 SSOT `utils/isOffValue` 档位不一致：
  `{KHY_COMMAND_CATALOG: false}` 或 `0`（非字符串）会被读成「未设置」而**保持开启**——
  因为源码走的是 `String((env && env.KHY_COMMAND_CATALOG) || '')`。
  经由 `process.env` 的真实调用永远是字符串，所以现状无行为差异；
  但「三份关闭词表各自漂移」是可发现性层面的债，**收敛到哪一份属人的裁决**（与 `config/keybindings`
  单元记的同一族问题合并上报），本单元不做静默改写。
  → `gate treats absent/blank/whitespace as on and never throws on a bad env`
- `env` 形参缺省时取 `process.env`，所以「零 IO」的准确说法是**默认注入 process.env、可被入参覆盖**；
  两个消费者都显式传 `process.env`，测试一律传字面对象。

## 测试怎么跑

```bash
cd services/backend
node --test src/services/domain/catalog/commandCatalog/commandCatalog.test.js
```

15 例、0 skip、零真 IO。改动本文件后请连仓级三份 node:test 方言的用例一起复跑
（`tests/services/commandCatalog.test.js`、`tests/allCommandsCatalog.test.js`、
`tests/services/selfAuditRegistry.test.js`），它们直接消费这个叶子。
