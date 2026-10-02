# ansiSanitizer — 剥离 ANSI/CSI/OSC/裸 ESC 控制序列的单一真源

**域**：D3 共享底座 ｜ **归位**：2026-09-28，[RESEARCH-018] P2 第 20 批（旧路径
`services/backend/src/cli/ansiSanitizer.js` 现在是一行再导出壳）｜ **lifecycle**：stable（存量归位，非经
`scripts/quarantine/` 晋级）

## 为什么住在 D3 而不是 cli/

真身全文**零 `require`**（搬迁前置闸断言过计数为 0），却被两侧同时消费：

| 消费方 | 域 | 用法 |
|---|---|---|
| `services/backend/src/utils/stripAnsi.js:37` | D3 | `stripAnsi()` 的 body 就是它 |
| `services/backend/src/cli/tui/selection.js` | D1 | 选区复制前剥残留（[DESIGN-ARCH-149]） |

住 `cli/` 时，D3 的 `stripAnsi` 必须**向下伸进运行时**取它——那是一条 `d3-purity` 禁止边
（`DOMAIN-DEPS.json` D3 的 `mayDependOn` 只有 `[D3]`）。搬真身、留壳、只改 D3 侧那一处 require 串，
边即消失，而 D1 侧消费者的 require 串逐字节未动。

与第 19 批判为「喂尺」的那七个 prompt 引擎的区别，就是这里的判据：**纯叶子 + 跨域消费**。
那些是带状态与 IO 的服务、且只有 `constants/prompts.js` 一个 D3 消费者，搬进 D3 只会把边换个方向数。

## 契约

- **纯**：零 require / 零 IO / 确定性 / 绝不抛。非字符串输入**原样返回**（`null`、`undefined`、`42` 都不抛）。
- **顺序敏感**：多字节序列（OSC/CSI/DCS）→ 短序列与两字节 → 裸控制字符 → 零宽/BOM。换顺序会留残参。
- **剥一半比不剥更糟**：旧路径 `modelTextNormalizer._stripInvisible` 只吃 `0x1B` 一个字节，紧跟的
  `[1m` 留在屏上成可见 ASCII，并破坏紧随 `_` 的 left-flanking 条件 → `_标题_` 强调不成立。
  这是 `stripAnsiSequences(String.fromCharCode(27) + '[1m_标题_') === '_标题_'` 这条回归锚存在的原因。

导出：`stripAnsiSequences` / `hasAnsiSequences` / `RE_CSI` / `RE_OSC` / `RE_DCS` / `RE_ESC_SHORT` /
`RE_BARE_CONTROL` / `RE_ZERO_WIDTH`（正则外供是为了让观测埋点复用同一张判定，不再各写一份正则）。

## 测试

- 本单元：`index.test.js`（壳与真身同一模块对象 / 壳零逻辑 / 导出符号集 / D3 消费者不回指 D1）
- 行为契约：`services/backend/tests/ansiSanitizer.test.js`、`services/backend/tests/stripAnsi.test.js`
  （jest 方言；本仓无 root jest bin 时可经 `.khyos/tmp/jest-lite.js` 跑，注意该 shim 未实现
  `toBeNull` / `not.toMatch` / `toThrow`，命中这三条的样本须手工复验）
