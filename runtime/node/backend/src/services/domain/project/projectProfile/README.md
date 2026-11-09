# projectProfile — khy-os 的项目自我认知

**单一真源。** 改这一处，手机上的 AI 和 PC 上的 AI 同时改对自己的认知。

## 为什么有这一层

跑在手机上的 AI 和跑在 PC 上的 AI，系统提示原本都是**项目盲**的：

- 手机侧 `delivery/mobile/khy-os-client-app/lib/core/agent/agent_loop.dart` 只说
  「你是 khy-os AI 助手，运行在用户的 Android 手机上」
- PC 侧 `services/domain/network/stepneoCloud/agentLoop.js` 连项目名都没有，
  只有「你是一个能在用户手机上执行操作的智能体」

它们知道怎么操作设备，却不知道自己在维护什么、**什么不许做**。一个不知道 R1/R2 的
agent 下次就可能自动 commit，或把密钥写进源码——那不是它坏，是没人告诉它。

## 内容

| 段 | 作用 |
|---|---|
| `PROJECT_PROFILE.layout` | 结构速查，指路 `works/record/ai/MAP.md` |
| `PROJECT_PROFILE.redLines` | R1–R4，破线必须停手问人 |
| `PROJECT_PROFILE.behaviorRules` | B3/B4/B7/B8，只收与「AI 动手」直接相关的 |
| `PROJECT_PROFILE.phone` | 手机侧特有：工作目录绑定、桥的事实 |
| `readVersionTracks(repoRoot)` | 运行时读三条版本轨道，**不写死** |
| `renderProfileSection({...})` | 渲染成系统提示的一段 |

## 两条设计约束

**版本号不写死在 `PROJECT_PROFILE` 里。** 硬编码会和
`scripts/ci/check-copyright-readiness.js` 的五处一致性打架，而且必然过期。
一律 `readVersionTracks()` 从真源读；一致性校验的真源是
`scripts/ci/check-version-sync.js`，本模块只取每条轨道一个代表源用于展示。

**真源放后端侧，不放 `delivery/`。** node 运行时反向 require 交付面会新增
`scripts/ci/check-repo-layout.js` 的 `cross-layer-require` 违规。生成脚本是构建期工具，
不受该约束（同 `scripts/brand/build-brand-assets.js` 往 `runtime/node/backend` 写产物的路子）。

## 消费方

1. `services/domain/network/stepneoCloud/agentLoop.js` —— PC 侧云模型 loop 的系统提示
2. `scripts/project-profile/build-project-profile.js` —— 生成
   `delivery/mobile/khy-os-client-app/lib/core/config/project_profile.g.dart`
   （手机侧系统提示 + 设置页「项目」区块）

## 重新生成

```bash
node scripts/project-profile/build-project-profile.js
```

改完本单元必须重跑，否则 Dart 侧拿到的是旧画像。产物文件头部标了「勿手改」。
