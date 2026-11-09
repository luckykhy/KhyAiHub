# utils/terminal — 终端几何与终端能力（通用层）

> **本目录是「剥洋葱」第一刀的产物**：8 个原住在 `src/cli/tui/`（视觉皮）下的
> **纯能力叶子**下沉到此。语义真源：[DESIGN-ARCH-197] §5；
> 机器可读契约：`docs/10_规范/registry/CORE-LAYERS.json`；
> 守卫：`scripts/ci/check-core-layers.js`（`npm run check:core-layers`）。

## 为什么要下沉

这些能力**不是渲染代码**，而是终端环境的通用事实：

| 文件 | 性质 | 为什么不住在 `cli/tui/` |
|---|---|---|
| `effectiveDims.js` | 终端尺寸真源（stickyCols / stickyRows / contentWidth / contentHeight / bandCols） | 经典 REPL、CLI handler、TUI 渲染都要算终端宽度 |
| `effectiveCols.js` | 上述的 legacy 别名 | 同上 |
| `sidebarLayout.js` | 侧栏宽度算术（纯函数，零 IO） | 被侧栏与右栏两个布局器共用 |
| `railLayout.js` | 右栏几何（纯函数，零 IO） | 同上 |
| `chromeBudget.js` | 固定 chrome 行数账本（纯算术） | 被 effectiveDims / railLayout / ccLayout 共用 |
| `terminalCapabilities.js` | 终端能力探测 | 文件头自述「across ALL surfaces (CLI, TUI)」——归属早写在代码里了 |
| `mouseButtons.js` | 鼠标序列解析 / 命中测试 / 事件分级 | 零依赖纯叶子，与 ink 渲染无关 |
| `noticeInbox.js` | 一行话收件箱（发布订阅） | 逻辑侧投递、表现侧订阅，机制与渲染无关 |

它们此前住在视觉皮下，直接后果是**逻辑芯渗入视觉皮**：

```
核心 toolUseLoopCore → AgentTool → cli/ai.js → … → cli/handlers/gateway.js → cli/tui/
```

实测：核心的可达闭包里有 **8 个 `cli/tui/` 文件**。下沉后 → **0**。

## 剥洋葱的操作口径

剥洋葱分三种切法，本目录选的是**下沉**而不是剪边：

- **剪边** —— 把 `require` 断掉。重量是藏起来了，能力仍然错位，下次有人再引一次就回来了。
- **剪层** —— 一次性剪掉某外壳的**全部入边**。实测剪 `src/cli/handlers/` 整层可让核心
  少 8.5 万行 / 214 文件，但那是接口重构，属人的决定。
- **下沉**（本目录）—— 把该在通用层的能力归位。归位之后依赖方向本身就正确，
  不需要靠人记着别再引错。

## 皮侧门面（re-export）

`src/cli/tui/` 下保留了 8 个同名 re-export 门面，指向本目录的真源：

```
cli/tui/effectiveDims.js          → utils/terminal/effectiveDims.js
cli/tui/effectiveCols.js          → utils/terminal/effectiveCols.js
cli/tui/sidebarLayout.js          → utils/terminal/sidebarLayout.js
cli/tui/railLayout.js             → utils/terminal/railLayout.js
cli/tui/chromeBudget.js           → utils/terminal/chromeBudget.js
cli/tui/mouseButtons.js           → utils/terminal/mouseButtons.js
cli/tui/noticeInbox.js            → utils/terminal/noticeInbox.js
cli/tui/runtime/terminalCapabilities.js → utils/terminal/terminalCapabilities.js
```

**既有调用路径字节等价可用，调用方零改动。** 新代码请直接 require 本目录。

跨层调用（从逻辑侧引用终端能力）必须直连本目录，不得经 `cli/tui/` 门面 ——
门面的存在是为了兼容，不是为了让人继续走老路。

## 不变量

1. **零 IO 优先**：本目录的叶子不读 `process.stdout`，需要尺寸就由调用方传入
   （`contentWidth(colsArg, env, fallback)` 走显式参数优先）。
2. **纯函数可测**：不抛、不写全局状态（除 sticky 缓存这一族刻意持有者）。
3. **同组相对引用自洽**：8 个叶子之间的 `require` 全部是同目录相对引用，
   搬迁后路径自动成立——这是「它们是真叶子簇、不是互相撑起来的假模块」的证明。

## 相关

- 规范：[DESIGN-ARCH-197] 剥洋葱：Khy OS 最小核心与分层重量治理
- 契约：`docs/10_规范/registry/CORE-LAYERS.json`
- 守卫：`scripts/ci/check-core-layers.js`
- 规则：`TOOLING-012` 洋葱分层重量与芯纯净
- TUI 侧约束：`src/cli/tui/AGENTS.md`（终端尺寸真源、chrome 账本、鼠标判据等条目仍然有效，
  只是真源路径已迁到本目录）
