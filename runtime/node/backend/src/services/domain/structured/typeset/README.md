# typeset — 文档排版语义层（内容与样式分离的「内容」半边）

D2 业务上下文里的一个功能单元：把「模型可以写的东西」与「文档长什么样」彻底切开。
模型只交语义结构（标题 / 段落 / 列表 / 表格 / 引用 / 代码 / 分页 / 图 / 条目），
字号、字体、页边距、分页策略一律由 `src/templates/docstyles/*.json` 的样式模板
与渲染器 `docTypeset.py` 决定。本单元是这条分界的**机器可判入口**。

4 个源文件，全部有同名同目录的共置测试（`node --test`，91 例 / 0 fail，2026-09-29 实测）。

## 各文件的职责（取自各文件头注释，未做二次概括）

| 文件 | 角色 |
|---|---|
| `contentSchema.js` | 语义 AST 的封闭块型集 + `validateDocument()`：结构校验**与**「夹带排版码即拒」的防呆 |
| `markdownToAst.js` | 确定性的 Markdown → 语义 AST 解析器，无模型参与、不认任何表现层写法 |
| `styleTemplates.js` | 样式模板的加载与解析（内置名 / 绝对路径 / 内联对象），`overrides` 深合并到基线之上 |
| `textEmphasisPolicy.js` | 「什么该加粗、标题第几档、是否字面双宽放大」的唯一判定真源，纯叶子 |

分页只有一条路：显式哨兵行 `[[newpage]]` 或 `<<<pagebreak>>>`。空行、换页符、`---`
都不产生分页（`---` 是水平线，直接丢弃）——这条是头注释写明的防呆设计，测试已钉住。

## 谁在用本单元

**直接 require 本单元路径的文件只有 1 个**（绞杀者模式留下的再导出壳）：

- `src/services/typeset/index.js:34-37` —— 注释首行自称 `Auto-generated shim - re-export`，
  按文件基名摊平再导出，保住拆分前的历史调用形状。

壳的下游消费者 2 个（它们 require 的是壳，不是本单元）：

- `src/cli/markdownRenderer.js:59` —— 取 `textEmphasisPolicy`，且写了 `{...}` 兜底对象，
  单元不可用时终端渲染照常（fail-soft）。
- `src/tools/renderDocument.js:33-35` —— 取 `validateDocument` / `markdownToAst` /
  `resolveTemplate` + `listTemplates`，是文档排版工具的执行入口。

## 出域边（实测）

**0 条跨域 require**。`styleTemplates.js:22-23` 只 require Node 内置 `fs` / `path`，
其余三个文件零 require。本单元按 `DOMAIN-DEPS.json` 的 D2 名义边界申报
`mayDependOn: ["D2","D3"]`，实际连 D3 都没碰——它是 D2 里少数的纯叶子单元。

> ⚠ `src/tools/renderDocument.js` 所在的 `services/backend/src/tools/**` 在
> `DOMAIN-DEPS.json` 里没有域根映射（同 §12.31 的「未映射 7」）。这条不属于本单元的
> 出域边，但影响「谁依赖我」的口径，登记备查。

## 本批实测钉住的九条结构缺陷（一律登记不修）

改任何一条都是行为变更，需甲/乙裁决；已用 `KNOWN-DEFECT` 断言把现状钉死。

1. **`resolveTemplate(null)` 交出模块级缓存对象本体**（`styleTemplates.js:133-136` 的
   `source === 'builtin:default' ? base : ...` 直接返回 `builtins.default`）。调用方
   「临时改一下页边距」会永久污染本进程后续所有解析；`gbt7714` / `ieee` 因走深合并拷贝而不受影响。
2. **`builtins[spec]` 是裸下标取值，无 `hasOwnProperty` 守卫**：`resolveTemplate('constructor')`
   交出一个**函数**当模板，`'__proto__'` 静默退回 default 内容 —— 用户把模板名拼错成这些词时
   绕过了「未知模板名」报错。与 `toolchainVersions.supportedVersions('constructor')` 同族。
3. **`overrides` 的子对象按引用进结果**（`_deepMerge` 对 base 里不存在的键直接 `out[k] = over[k]`），
   调用方随后改写 overrides 会穿透进已解析的模板。
4. **只有表头的 Markdown 表格被凭空补出一行空数据**（`markdownToAst.js:188` 的
   `rows.length ? rows : [header.map(() => '')]`）：源文本里没有数据行，且这份伪造行
   让 `contentSchema` 的「table.rows 必须非空」判据永远拦不到空表。
5. **`| - | - |` 形态的表格分隔行整表静默退化成段落**（`_isTableSep` 要求 `-{2,}`）：
   不报错、不警告，用户的表格内容变成一串带竖线的正文。
6. **`textEmphasisPolicy` 对级别的类型门与同单元的 `contentSchema` 相反**：
   `contentSchema` 用 `Number.isInteger` 严格拒收 `'2'`，`headingDescriptor` / `bigHeadingPrefix`
   用 `Number.isFinite`（对字符串恒 false）把 `'3'` 当 H1；且 `bigHeadingPrefix` 的
   `lvl <= 2` 没有下界，`0` / `-1` / `NaN` / 对象一律发出 DEC 双宽控制序列。

7. **防呆扫描不扫 `meta`**：`title` 与所有块文本都过 `scanFormatCodes`，`meta.author` /
   `meta.abstract` / `meta.keywords` 一行都不扫 —— 同一个 `\textbf{}` 放进 `title` 被拒，
   放进 `meta.abstract` 长驱直入渲染层。
8. **空集合的判据在各块型之间不一致**：`paragraph.runs: []` 放行，而 `list.items` /
   `table.rows` / `reference.entries` 都要求非空；`figure` 两个字段皆可缺仍 valid（空图块）。
9. **封闭集只封块型、不封字段**：`{type:'paragraph',text:'x',fontSize:99}` 与
   `runs:[{text:'a',underline:true}]` 都判 valid —— 伪装成语义结构的排版主张可以穿过校验器，
   而头注释写的是「AST 刻意小而封闭」。

## 生命周期

`khy.module.json` 记 **`stage: staged`**，不是 stable：形式三判据齐（本 README + 整数 fanIn + 四源文件全有同名测试），
但下面九条缺陷里有两类是用户可见的行为缺陷（缓存本体交出、原型链名被当内置模板）。
按第 30/31 批同一口径，带着下面九条里的头两类签 stable 等于自签假合格证。

## 怎么验

```bash
cd services/backend && node --test \
  src/services/domain/structured/typeset/contentSchema.test.js \
  src/services/domain/structured/typeset/markdownToAst.test.js \
  src/services/domain/structured/typeset/styleTemplates.test.js \
  src/services/domain/structured/typeset/textEmphasisPolicy.test.js
```

单元级自洽判据（测试里已断言）：`markdownToAst(全块型样例)` 的产物必须被
`contentSchema.validateDocument()` 判 valid —— 解析器与校验器对同一 AST 不许各说各话。
