# project-profile 生成脚本

把「项目自我认知」烘成手机 App 能用的 Dart。

```
scripts/project-profile/
├── build-project-profile.js     快，确定性落盘（APK 构建时跑）
└── record-guard-snapshot.js     慢，跑守卫写快照（人或 CI 在合适时机跑）
```

单一真源在 **node 侧**，不在这里：

```
runtime/node/backend/src/services/domain/project/projectProfile/index.js
```

## 为什么拆成两个脚本

跑一遍守卫要几分钟，而且**跑不跑得过取决于改动集**，不是构建机能决定的。
塞进 `flutter build apk` 会让每次打包都慢到不可用，还会让「构建失败」和
「守卫不过」混成一句。所以：

| 脚本 | 何时跑 | 产出 |
|---|---|---|
| `build-project-profile.js` | 每次打包 APK 前 | `lib/core/config/project_profile.g.dart` |
| `record-guard-snapshot.js` | 想更新守卫结论时 | `works/record/ai/GUARD-SNAPSHOT.json` |

第二个的产出会被第一个读走并烘进 APK，**原样带上 `takenAt`**——一个没有日期的
绿灯比不显示更糟，基线性守卫（`check-repo-layout` 的三项）会随代码增长重新变红。

## 改完画像必须重跑

```bash
node scripts/project-profile/build-project-profile.js
```

不重跑，手机 App 拿到的是旧画像。产物文件头部标了「勿手改」，
`projectProfile/index.test.js` 里有两条同步测试钉着生成物与渲染器一致
（改渲染器忘了重跑，它们会红）。

## 为什么 Dart 侧不自己渲染

渲染器只有一份（node），Dart 只持有烘好的文本。两边各写一份渲染逻辑，格式就会漂——
而漂了的症状是手机上的 AI 和 PC 上的 AI 对同一条红线给出不同表述，
**没有任何一方会报错**。

工作目录后缀同理：`WORKSPACE_SUFFIX_TEMPLATE` 由渲染器导出，生成脚本直接用它，
不手抄。

## 不含 check-change-safety

`record-guard-snapshot.js` 故意不跑 `check-change-safety.js`：它按改动集扫描，
而本仓当前没有任何提交，`--changed` 会把整个仓库当成改动集，于是恒定报
「blast radius too large」。那不是守卫的结论，是仓库状态的副产品。
要跑它请单独跑并按需显式传路径。
