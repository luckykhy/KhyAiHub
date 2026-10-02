# `utils/text/` — 文本宽度 / 引用扫描 / 收尾判定纯叶子（D3 共享底座）

> 生命周期记录见同目录 `khy.module.json`（domain `D3`、fan-in 18、stage `stable`）。
> 判据真源：`[RESEARCH-018]` §2.3「功能单元」与 §4 C-5「入口缓冲」；层级真源 `[DESIGN-LAY-005]`。

## 为什么这一族住在 D3 而不是 `cli/`

本目录的 7 个成员里，有 6 个原本是 `cli/` 下的文件，按 `[RESEARCH-018]` §3.1 P1/P2 归位过来。
归位的判据不是「它被 CLI 用」，而是**它本身没有任何运行时依赖，却被多个域用**：

| 成员 | require（仓内） | 消费者面 |
|---|---|---|
| `displayWidthMemo.js` | 零 | `cli/displayWidthMemo.js`（壳）、`width.js` |
| `inlineFileRefs.js` | 零 | `cli/repl/inlineFileRefs.js`（壳）、`services/imageContextCardService.js`、`imageIntent.js` |
| `permissionReply.js` | 零 | `cli/permissionReply.js`（壳）、`services/tool/toolCallingPermissions.js` |
| `resultGuard.js` | 零 | `cli/resultGuard.js`（壳）、`services/tool/toolUseLoopCore.js` |
| `width.js` | `./displayWidthMemo` + npm `strip-ansi`/`string-width` | `cli/formatters.js`、`services/aiMonitor.js`、`utils/format/*` |
| `imageIntent.js` | `./inlineFileRefs` | `cli/repl/imageIntent.js`（壳）、`services/gateway/inlineImageOcrGuardPolicy.js` 等 3 处服务 |
| `keyFindings.js` | `../normalizeToolName`（D3 叶子） | `cli/keyFindings.js`（壳）、`cli/replSession.js`、`cli/tui/hooks/useQueryBridge.js`、`toolUseLoop*` |

`cli/` 里的旧路径全部留下**一行再导出壳**，223 个消费者的 require 串一个字没改（同一模块对象已实测）。
留在 D1 的后果是：`services/tool/*` 与 `utils/format/*` 这些同为 D3/D2 的消费者要向下伸回运行时取一个纯字符串算法——
那正是 `d3-purity` 亮红的形态。搬真身、不改编排，边就消失了。

## 契约（逐条有测试锁）

1. **纯**：零 IO、确定性、绝不抛。垃圾入参（`null` / 数字 / 超长串）返回回退值而不是异常。
2. **门控一律 env、缺省为开、关闭即逐字节回退历史**。`OFF` 取值集是 `0/false/off/no`（`permissionReply`、
   `resultGuard` 用 `FALSY` 集），这样关掉开关的机器与归位前的代码路径输出完全一致——这是归位不改变行为的**可验证形式**。
3. **宽度算法由调用方注入**：`displayWidthMemo.getDisplayWidth(str, computeFn, env)` 自己不认得终端，
   `width.js` 把 `_computeDisplayWidth` 作为 `computeFn` 传进去。缓存因此与任何具体宽度实现无关（LRU，`MAX_ENTRIES` 2048，
   超过 `MAX_KEY_LEN` 4096 的串不入缓存，只缓存有限数值）。
4. **结论判据由调用方注入**：`resultGuard.assessClosure` 只吃 `hasDeliveredConclusion` 这个**已算好的布尔**，
   绝不在此重新推导结论（`[DESIGN-ARCH-163]` 的单一真源约束）。
5. **图片与文档两个扩展名集合刻意不相交**：`inlineFileRefs.FILE_EXT_SET` 不含 `png/jpg/jpeg/gif/webp`，
   图片原子归 `imageIntent`；调用方按「先图后文」合并即无歧义。
6. **权限答复：否定优先 → allow-always → allow → 不认识返回 `null`**（`null` 让 call-site 保持 default-deny，
   不认识绝不算同意）。

## 测试

- 共置 7 份 `*.test.js` 是**单元契约**测试（`node --test`）：导出面、零 require 纯度锁、门控语义、永不抛、上面 6 条契约。
- `services/backend/tests/cli/{displayWidthMemo,keyFindings,permissionReply,resultGuard}.test.js` 是归位前的**行为回归**测试，
  判据不同，不与共置契约测试互相替代；合并需一次 `git mv`（未闭合，见 `scripts/quarantine/README.md`）。

跑法（本仓无 root jest bin，见 `[DESIGN-LAY-008]` §12.2 工具链注）：
`node --test services/backend/src/utils/text/`
