# conversation — `/btw` 旁注的纯文本叶子与进程级队列（D2 功能单元）

一句话：把「模型正在忙时补一句、等下一回合并入用户输入」这条语义收敛成两层——
`btwNote.js` 只算文本（零 IO、确定性、绝不抛），`btwNoteQueue.js` 只持有队列状态
（进程级单例、零文件 IO）。历史上这套语义是 `cli/repl.js` 的闭包私有变量 `_btwQueue`，
router 分发与 ink TUI 都看不见它；本单元把那部分纯逻辑提出来，让三个入口共用。

清单：`khy.module.json`（`domain` / `mayDependOn` / `fanIn` / `lifecycle.stage` 四字段被
`npm run check:layout` 的 entry-buffer 规则读取，其余给人看）。

## 逐成员

| 文件 | 角色 | require | 同名测试 |
|------|------|---------|----------|
| `btwNote.js` | 纯叶子：`normalizeNote`（trim + 4000 上限）、`mergeHints`（并入格式单一真源）、`isEnabled`（KHY_BTW 门控，env 经入参） | 无 | `btwNote.test.js` |
| `btwNoteQueue.js` | 薄壳存储：`enqueue` / `count` / `drainAll` / `clear`，模块级单例，只在内存 | `./btwNote` | `btwNoteQueue.test.js` |

## 消费者（实测 fan-in = 5，均非测试文件）

`cli/handlers/btw.js`、`cli/tui/ink-components/App.js`、`cli/replSession.js`、
`services/conversation/index.js`（D1 再导出壳）、`services/selfEditWatcher.js`。
方向合法：D1 依赖 D2。注意 `cli/replSession.js` 是作者 in-flight 文件，本单元只读其引用关系。

## 契约（每条都对应命名测试）

1. **规范化**：去首尾空白、内部空白保留；`null`/空白一律 `''`（调用方据此不入队）；
   非字符串走 `String()`；超长截到 4000 而不是拒绝。
   → `normalizeNote: trims edges, keeps inner text, empty-ish yields empty string`、
   `normalizeNote: non-strings are stringified, then capped at _MAX_NOTE_LEN`
2. **并入格式是单一真源**：`${input}\n\n[附加提示]\n${逐条一行}`，
   无提示时输入逐字节不变；非数组/空数组/全空白提示都不加尾巴。
   → `mergeHints: SSOT join format is exactly ...`、
   `mergeHints: no hints means the input is returned byte-identical`
3. **门控默认开、显式关**：`KHY_BTW` 缺省为真，`'0'/'false'/'off'/'no'/空` 关，
   大小写与首尾空白容错；叶子绝不读 `process.env`。
   → `isEnabled: default on, explicit falsy off, case and padding tolerated`、
   `the leaf reads no env and no fs (purity lock on the source text)`
4. **队列状态语义**：入队即规范化后的文本（拒绝空条目且不计数）；
   FIFO 保序；`drainAll` 一次清空并返回脱离引用的副本（改副本不能回填队列）；
   `clear` 是无返回值的丢弃操作，与 `drainAll` 区分。
   → `enqueue normalizes through the leaf and reports whether it stored anything`、
   `FIFO order is preserved and capped the same way as the leaf`、
   `drainAll empties in one shot and hands back a detached copy`、
   `clear drops pending notes without returning them`
5. **每进程一份 = 每会话一份**：`require` 缓存保证单例，跨句柄看到同一状态。
   → `the queue is one instance per process (require cache is the single source)`
6. **本单元零 IO**：存储层不写盘、不起进程、不发请求；IO 与回显归 call-site。
   → `the store holds no file/network IO (purity lock on the source text)`

## 已知限制

- 队列只在内存，进程退出即丢——设计如此（旁注是「下一回合」的短生命周期输入），不做起盘持久化。
- `mergeHints` 的头部字面量 `[附加提示]` 是对外可见格式的一部分，改它等于改历史 REPL 行为，
  属跨入口协议变更，须同步 `tests/services/conversation/*` 与 TUI 投影，不在本单元内擅改。

## 怎么跑

```bash
node --test services/backend/src/services/domain/session/conversation/btwNote.test.js \
  services/backend/src/services/domain/session/conversation/btwNoteQueue.test.js
node scripts/ci/check-repo-layout.js --list=functional-unit | grep -c "session/conversation"   # 期望 0
node scripts/ci/check-repo-layout.js --list=entry-buffer | grep -c "domain/session/conversation" # 期望 0
```

新增 `README.md` 后须跑 `node scripts/docs/build_docs_site.js` 生成同名 `.html` 孪生，
否则 `node scripts/docs/verify_docs_site.js` 会报缺件（`check:layout` 对此不报错）。
