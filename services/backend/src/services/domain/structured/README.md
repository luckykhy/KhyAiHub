# structured — 结构化输出、格式勘察与排版（D2）

业务上下文：模型的工具 `StructuredOutput` / `Read` / `inspectDocument` /
`replace_at_location` / `renderDocument` 背后的判定层——「这段输出合不合 schema」
「这个文件是什么格式」「这一处编辑落在文本哪个坐标」。

## 谁要（角色）

- **让模型产出结构化结果**：`tools/StructuredOutputTool/index.js:114` 取
  `output/jsonSchemaValidate`。
- **读文件/勘察格式**：`tools/FileReadTool/index.js:305`、`tools/readFile.js:237`、
  `tools/inspectDocument.js:32`（`detectFile`）。
- **定点改写**：`tools/replaceAtLocation.js:13-14`（`textAddress` 的段落/句/词坐标）。
- **排版与回合信封**：`tools/renderDocument.js:33-35` 与
  `cli/markdownRenderer.js:59`（`typeset/`）；`services/queryEngine.js:787,1141`
  取 `structuredResults/turnEnvelope` 的 `buildTurnEnvelope`。
- **炉子（furnace）**：`services/tool/toolUseLoopHelpers.js:1330`。
- 壳：`services/{formatInspect,output,structuredFurnace,typeset}/index.js`。

## 为什么这么做

五个子上下文里只允许两个碰盘（`formatInspect/fileFormatDetector.js` 与
`typeset/styleTemplates.js`），其余是判定：`structuredFurnace/` 把「一句含糊指令」
拆成动作原语（`forgeSchema` 的 `validateActionIntent / validateTaskGraph`、
`intentWeaver`、`dimensionReducer`、`skeletonReconstructor`），并用
`chaosInterceptor` 的密封/伪造检测（`assertForged` / `isForged`，只用 `crypto` 做
确定性哈希）拒绝被伪造的自检结果；`structuredResults/turnEnvelope` 定义
「这一回合到底算不算成功」的 schema（`SCHEMA_VERSION` + `_classify` +
`_resolveSuccess`）。本单元**没有任何 slash 命令**是设计事实：它是工具回路的地基，
入口在模型侧而非人侧——所以「谁要」的答案一律是具体工具文件，不是终端用户。

## 怎么验

```bash
cd services/backend
node --test tests/services/structuredFurnace/structuredFurnace.test.js   # 25 tests / 25 pass / 0 fail
node --test tests/services/output/jsonSchemaValidate.test.js             # 20 tests / 20 pass / 0 fail
```
同族：`tests/structuredResults.turnEnvelope.test.js`、`tests/formatInspect.test.js`、
`tests/services/typeset/markdownToAst.test.js`、`tests/textEmphasisPolicy.test.js`（node:test）。

## 已知缺陷（登记，不在本单元擅自修）

本目录 20 个源文件当前干净（无 ` M`/`A `），但**零**共置测试——
`check:layout --list=functional-unit` 逐文件点名，属 `[RESEARCH-018]` C-4 存量。
