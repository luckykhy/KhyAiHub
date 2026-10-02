# accountPool — 凭据池：探测、导入、调度与回写

D2 业务上下文里的一个功能单元：本机 IDE/CLI 登录态的**凭据池**。5 个源文件全部有同名同目录的共置测试
（**102 例 / 0 fail**，2026-09-29 本道显式路径复跑；`grep -c KNOWN-DEFECT` 实测 **30** 处钉住）。

## 各文件的职责（取自各文件头注释）

| 文件 | 角色 |
|---|---|
| `candidateDetect.js` | 凭据来源探测与候选采集 |
| `poolImporter.js` | 扫描本机 IDE 登录存储（Trae / Cursor / Kiro / Warp / Nirvana）导入池 |
| `poolScheduler.js` | 过期租约周期清理与自动回收 |
| `poolSync.js` | 把活跃池凭据回写进本机 IDE/CLI 存储 |
| `credentialHelpers.js` | 凭据规范化助手（自 `src/services/accountPool.js` 逐字抽出） |

## 谁在用本单元（非测试外部消费者 4 个）

`services/accountPool/index.js`（D1 再导出壳）、`services/accountPool.js`（D1 门面本体）、
`services/localBrainProviderConfig.js`（D1）、`tools/ConfigureModelProvider/index.js`（`src/tools/**`，
在 `DOMAIN-DEPS.json` 里**没有域根映射** —— 即 §12.43 的 Q4 归属空洞，本道不代裁）。

## 出域边（如实登记，不写白名单）

- **D1 共 2 处**：`candidateDetect.js:608` → `src/config/sqlite-adapter.js`、`poolImporter.js:325` →
  `services/gateway/adapters/ideDetector.js`。前者所在的 `src/config/` 同样**无域根映射**（被路径前缀判成 D1 是误判，
  这是 §12.43「建门前先定判据」的又一活样本）。
- **零条 D3 边**：本单元不 import `utils/` 或 `constants/`，数据根与路径全部自取 —— 这本身是一条待归位项，
  登记而不改（改动即行为变更）。

## 已知缺陷（全部登记不修，任务 #17 第 16 项）

30 处 `KNOWN-DEFECT` 中两条高危已具名：

1. `candidateDetect.js:184` 把**私人邮箱做成语义默认值**（`process.env.NIRVANA_DEFAULT_LOGIN_EMAIL || '<脱敏：2578***@qq.com>'`，
   本道刻意不把完整地址复制进任何会生成公开 HTML 孪生的文件；原文按 `file:line` 引用）。实测传播面：无该 env 时
   `poolImporter` 给**每条导入凭据记录**写 `email` 与 `label = 'trae:<该地址>'`。同时违反 `RUNTIME-001`。
2. `credentialHelpers.js:55` `PROVIDER_ALIASES[raw] || raw` 无 own-property 守卫 ⇒ `poolType='constructor'`
   返回 `Object` 构造函数本体，并作为 **SQL 参数**传给 `upsertTokenRecord`（原型键一族）。
