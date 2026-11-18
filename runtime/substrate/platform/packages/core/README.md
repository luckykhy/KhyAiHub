# @khy/core

KhyOS 双模核心的契约与接入面。一核多终端：终端之间不直接引用，只经 CoreHandle 消费能力。

## 导出面（封闭 exports，深导入一律 `ERR_PACKAGE_PATH_NOT_EXPORTED`）

| 子路径 | 给谁用 | 内容 |
|---|---|---|
| `@khy/core` / `@khy/core/contracts` | 所有端 | CoreHandle 六成员契约、错误码、健康指纹（零 `node:`） |
| `@khy/core/contracts/core-env` | backend 与浏览器 | `KHY_CORE_*` 键名与读取的唯一真源（守卫式读 env） |
| `@khy/core/client` | 浏览器 / 第三方 attached | `obtainCore(opts)`——只 attach，不读文件、不 spawn |
| `@khy/core/locator-host` | Node 宿主 / CLI / daemon | `obtainCoreNode(opts)`——auto/embedded 的唯一入口，包内唯一允许 `node:` 的源文件 |
| `@khy/core/server` | embedded 宿主 | core server 骨架（本刀零业务，S4 起承接 HTTP/WS） |

## 两种形态

- **embedded**：`obtainCoreNode({ mode:'embedded', allowSpawn?, bundledEntry?, paths? })`——定位实现
  （显式注入 > 宿主 bundled 入口 > `node_modules/@khy/core` > 诚实报错 `CORE_LOCATOR_FAILED`）、
  抢独占锁（pid + port + token + epoch + 心跳），抢不到且持锁者新鲜就转 attach，绝不起新核心。
- **attached**：`obtainCore({ endpoint, token, terminalId, clientVersion })` 或 Node 侧
  `obtainCoreNode({ mode:'attached', endpoint })`——`/core/health` 指纹比对后走 `/core/hello` 握手。

## 测试

```bash
node --test src test
```

同目录同名测试覆盖每个源文件（entry-buffer colocated 判据）；`test/` 只放跨进程用例。

## 边界

core 只做统筹：能力注册与发现、事件、配置、会话与计量、AI 网关（唯一出口）、插件生命周期、锁与
epoch、路径解析。终端 UI、终端专属业务、任务编排与观测采样模块本体**不进 core**
（`scripts/ci/check-core-boundary.js` 机判）。版本轨道不并入 G2；起步版本与归组在首个发布前由人拍板。
