# skills — 技能蒸馏、威胁扫描与验收脚手架（D2）

业务上下文：`/learn`（从目录或 URL 学一个技能）、`skill journey`、
`/init-verifiers`。本目录五个文件**全部纯函数**，读写盘留在
`services/skillLearningService.js`。

## 谁要（角色）

- **跑 `/learn` 的人**：`constants/commandSchema.js:166`（子命令 `:358`，
  路由 `:2067`）→ `services/skillLearningService.js:21,22,873` 取
  `skillSourceDistiller` 与 `skillThreatScanner`。
- **看技能历程的人**：`cli/handlers/skill.js:387-388` 取 `journeyTimeline`。
- **初始化验收器的人**：`commandSchema.js:1080-1084` →
  `cli/handlers/initVerifiers.js:21` 取 `verifierScaffoldPlan`。
- **门控文档**：`services/flagRegistry.js:1116-1136` 记录这几个开关的语义。
- 壳：`services/skills/index.js:4-7`。

## 为什么这么做

「从外部内容生成技能」是一条**把不可信输入变成可执行资产**的通路，所以判级必须
与写入分离且能独立追问：`skillSourceDistiller.js`（`:9,16` 的头部注释即声明
fs/HTTP 留在调用方）负责抽取——`deriveSkillName / clampDescription / extractCommands /
extractHeadings / buildSkillBody`；`skillThreatPatterns.js` 是**数据表**
（`_THREAT_PATTERNS`、`_SEVERITY_ORDER`、`_INVISIBLE_CHARS` 与三档判定常量），
`skillThreatScanner.js` 只做 `runThreatScan` / `deriveVerdict` / `shouldAllowLearn`。
这样「为什么这条被标 dangerous」的答案永远落在一张表上，而不是散在 if 里；
`_INVISIBLE_CHARS` 单独列出，防的是零宽字符伪装（同 `[RESEARCH-018]` 对
不可信输入透明性的要求）。`verifierScaffoldPlan.js` 把 `/init-verifiers` 的
命名与脚手架指令做成纯计划（`VERIFIER_TYPES` / `planVerifierNameScoped`）。

## 怎么验

```bash
cd services/backend
node --test tests/services/skills/skillThreatScanner.test.js     # 16 tests / 13 pass / 3 fail
```
**当前是红的**，原样记录：16 tests / 13 pass / **3 fail**（失败用例名未在本卡采集，
不做分布推断）。同一时刻 `skills/skillThreatPatterns.js` 是本目录唯一脏文件
（` M`），而它正是 Scanner 的数据源——红点与该脏文件**同侧**是观察，不是因果结论；
需按规则 5 复现并立独立改动集。
同族（本卡未逐条复跑）：`tests/services/skills/{journeyTimeline,
skillSourceDistiller,verifierScaffoldPlan}.test.js`，
接线锁在 `tests/services/skillLearningServiceLearnFromSource.test.js:92,173`。

## 已知缺陷（登记，不在本单元擅自修）

1. 上述 3 条红（与 `skillThreatPatterns.js` 的在做中改动同侧）。
2. `skillThreatPatterns.js` 无同名测试，只经 Scanner 间接覆盖。
