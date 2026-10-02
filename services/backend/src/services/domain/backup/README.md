# backup — 备份、磁盘分析与清理（D2）

子上下文：`backup` / `restore` / `diskAnalyze` / `diskCleanup`。
业务入口是 `khy backup` 系列与磁盘体检。

## 谁要（角色）

- **备份/恢复的人**：`cli/handlers/backup.js` require `domain/backup`，
  对外壳为 `services/backup/index.js` 与 `services/restore/index.js`。
- **体检链**：`services/dbHealthService.js` 取本目录（SQLite 状态健康度），
  壳 `services/{diskAnalyze,diskCleanup}/index.js` 分别指向 `diskAnalyze/`、
  `diskCleanup/`。

## 为什么这么做

备份这件事最容易出的事故不是「备不全」而是「备错了东西」：
所以清单（manifest）必须先于复制成立——`tests/backupManifest.test.js` 就是这根尺，
它断言清单内容而不是断言复制结果。同族的
`tests/backupNoRawDbCopy.test.js` 名字即判据：**不得**把正在写的 SQLite 裸文件
当备份物（应先落一致的导出），这条约束的存在理由就是「复制了也 restore 不回来」。
`diskAnalyze` / `diskCleanup` 分开是因为分析与删除的力道档不同——
删除属规则 7（要部位清单 + 可执行 `rollback.txt`），分析属只读。

## 怎么验

```bash
cd services/backend
node --test tests/backupManifest.test.js                         # 29 tests / 29 pass / 0 fail
```
`tests/{backupColdExport,backupRestoreDrill,backupNoRawDbCopy,backupAssetPlan,
diskAnalyzeCatalog}.test.js` 是同族套件（本卡未逐条复跑，形态未核）。

## 已知缺陷（登记，不在本单元擅自修）

`restore` 子上下文的可恢复性只能靠 `backupRestoreDrill.test.js` 证明；
本卡未复跑它，因此**不声明**「恢复已验证」。要声明必须实跑并记录原始输出。
