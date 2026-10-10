# eval — GUI 评测与 Web 前端评测（D2）

子上下文：`guiEval`（8 个文件）/ `webFrontendEval`（4 个文件）。
无 CLI 命令入口，可达路径只有 HTTP。

## 谁要（角色）

- **`/api/web-frontend-eval`**：`services/aiManagementServer.js:416` →
  `routes/webFrontendEval.js:13` → 壳 `services/webFrontendEval/index.js:9` →
  本目录 `webFrontendEval/`。
- **测试侧唯一消费者**：`tests/services/computerUse/crossAppTask.test.js:300`
  取 `guiEval/runEngine`。
- **`guiEval/` 的生产消费者：零。** 本卡实跑的核查（原始输出）：

  ```bash
  $ grep -rn "domain/eval" services/backend/src services/backend/tests --include=*.js \
      | grep -v "src/services/domain/eval/"
  services/backend/src/services/webFrontendEval/index.js:9:module.exports = require('../domain/eval/webFrontendEval');
  ```
  即：`src` 内只有 webFrontendEval 的壳指过来，`guiEval` 一条都没有。
  再看 `/api/gui-eval`（`aiManagementServer.js:399`）的实现文件
  `routes/guiEval.js`：它 `:5` 直接 `require('@khy/shared/models')` 拿
  `GuiEvalTask / GuiEvalRun` 操作数据库，**从不 require 本目录的 `guiEval/`**。

## 为什么这么做

本目录内部的分层是对的：`pricingEngine` / `scoringEngine` 是纯确定性计算
（计价与打分必须可复算），`checkpointVerifier` / `runEngine` /
`recordingCollector` 才碰 `fs` / `child_process` / `vm`，
`taskStore` / `reviewService` / `index` 走 Sequelize。`webFrontendEval/`
同理：`qcEngine.runQC` 与 `trajectoryPackager` 的
`validateStructure / generateManifest / zipPackage` 是质检与打包，
`taskStore` 管落库。问题不在分层，在**接线**：`/api/gui-eval` 那条路绕开了
这套引擎，直接用模型层拼查询。

## 怎么验

**本卡没有可执行的验证命令**，这是如实登记而非省略：
`guiEval` 唯一相关套件 `tests/services/computerUse/crossAppTask.test.js` 是
jest 形态（本机 jest 渠道不可用，见 `security/README.md` 已知缺陷 3），
`webFrontendEval/` 则**没有任何测试文件**。上面 grep 的「零消费者」是本机实跑读数。

## 已知缺陷（登记，需人裁决，AI 不代决）

1. `guiEval/` 是「有实现、有测试（但测不到）、无生产接线」的单元，
   且 `/api/gui-eval` 走的是另一条路——**两套 GUI 评测并存**的形态与
   规则 10 A2-5「同一个概念禁止两份不一致定义」相冲。
2. `webFrontendEval/` 零测试。
3. 裁决选项：接线（属规则 6，要先答需求五问）/ 合并两套（属规则 5 的独立改动集）/
   下线（属规则 7，需部位清单 + 可执行 `rollback.txt` + 文档背书核查）。
   本 README 不代做决定。
