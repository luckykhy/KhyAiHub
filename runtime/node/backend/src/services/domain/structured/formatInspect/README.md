# formatInspect — 文件格式判定与文本精确定位（D2 功能单元）

一句话：把「这是不是什么格式的文件」与「替换文中第 N 段第 M 句里第 K 次出现的那个词」两件事
收敛成零依赖的判定层——前者由扩展名画像 + 魔数 + 二进制启发式三路合议（内容优先于扩展名），
后者由偏移保真的段落/句子切分 + 从后往前的区间替换保证「除目标处外原文逐字不变」。

清单：`khy.module.json`（`domain` / `mayDependOn` / `fanIn` / `lifecycle.stage` 四字段被
`npm run check:layout` 的 entry-buffer 规则读取，其余给人看）。

## 逐成员

| 文件 | 角色 | require | 同名测试 |
|------|------|---------|----------|
| `fileFormatData.js` | 纯字面量叶子：`EXT_FORMAT`（扩展名→格式画像，单一真源）、`SKIP_DIRS`（工程扫描跳过表）、`UNKNOWN`（兜底画像） | 无 | `fileFormatData.test.js` |
| `fileFormatDetector.js` | 判定面 `fromExtension` / `detectByMagic` / `looksBinary` / `detectBuffer`（全为纯函数）+ 唯一 IO 面 `detectFile` / `inspectProject` / `_readHeadTail` | `fs`、`path`（内建）、`./fileFormatData` | `fileFormatDetector.test.js` |
| `textAddress.js` | 零依赖纯函数：`splitParagraphs` / `splitSentences`（偏移保真切分）、`replaceAtLocation`（按段落/句子/第 K 次出现精确替换）、`locateWord`（只定位不替换） | 无 | `textAddress.test.js` |

## 消费者（实测 fan-in = 6，均非测试文件）

`services/formatInspect/index.js`（D1 再导出壳）、`tools/FileReadTool/index.js`、
`tools/inspectDocument.js`、`tools/readBinaryGuard.js`、`tools/readFile.js`、
`tools/replaceAtLocation.js`。方向合法：D1 依赖 D2，本单元不反向伸入 D1/D3。

## 契约（每条都对应命名测试）

1. **扩展名画像归一**：带点/不带点、大小写混写都解析到同一画像；未知或空一律落 `UNKNOWN`。
   → `fromExtension: dotted and dotless spellings agree, case is ignored`、
   `fromExtension: unknown and empty spellings fall back to the UNKNOWN profile`
2. **画像发出的是副本**：调用方改写返回值不得污染 `EXT_FORMAT` 这张单一真源表。
   → `fromExtension hands out copies — a caller mutation cannot poison the table`
3. **内容优先于扩展名**：`.txt` 里装 PDF 时报 `pdf` 且 `confidence='magic'`；
   扩展名与内容一致时不得误报冲突。
   → `detectBuffer: content wins over the extension, with confidence=magic`
4. **二进制判定的边界**：窗口内出现一个 NUL 即为二进制；`\t \n \r \f` 之外的控制字节占比 >0.3 才算二进制；
   空 Buffer/null 一律「非二进制」。截断的魔数前缀不算命中。
   → `looksBinary: NUL anywhere in the window is decisive; clean text is not binary`、
   `detectByMagic: a prefix shorter than the signature must not match`
5. **切分是偏移保真的**：每个段落/句子给出在原（或整篇）字符串里的 `[start,end)`，
   且 `slice(start,end) === text`；空行分段，CJK 句末标点归入本句，西文 `. ! ? ;` 只有后接空白/结尾才是界。
   → `splitParagraphs: blank line is the separator, offsets are faithful`、
   `splitSentences: CJK terminators stay inside their sentence`、
   `splitSentences: only whitespace-final punctuation splits, so 3.14 stays whole`
6. **精确定位替换**：默认只替换第 1 次出现，`occurrence` 越界/非正整数一律拒绝并回报范围内实际次数，
   `occurrence:'all'` 只在作用范围内全替，替换串长度不同也不得移动其后文本；
   段/句不存在时报错并附「共几段/几句」。
   → `replaceAtLocation: occurrence is 1-based, defaults to 1, and rejects bad k`、
   `replaceAtLocation: "all" replaces within scope only, leaving the rest verbatim`、
   `replaceAtLocation: paragraph/sentence addressing reports what was available`
7. **原型键不可达**（本仓单元默认检查项）：`fromExtension` 先把入参归一成带点形式再查表，
   `'constructor'`/`'__proto__'` 只会被查成不存在的 `.constructor`/`.__proto__`，一律落 `UNKNOWN`，
   因此裸表查找在本单元没有可达的继承键泄漏。
   → `prototype keys cannot reach the bare table lookup (keys are dot-normalised)`

## 已知限制（如实记下，不当缺陷修）

- `splitSentences` 无法区分句末点号与缩写点号：`e.g. ` 这类「点后接空格」的缩写**会**被当句界
  （JSDoc 里「避免 3.14 / e.g.」只对 `3.14` 成立）。要真正区分需要词典或更大启发式，属功能改动，不在本单元范围内。
- `EXT_FORMAT` / `SKIP_DIRS` / `UNKNOWN` 均为可变对象（浅层字面量，未 `Object.freeze`）。
  跨模块引用同一性是钉住的（`the detector re-exports the data leaf by reference`），
  但「不可变」本身没有守卫——深度冻结会波及现有调用方的解构写法，另案处理。
- `detectFile` / `inspectProject` 触盘且依赖真实目录结构，本单元只锁纯判定面；
  端到端行为由仓级 `services/backend/tests/formatInspect.test.js` 覆盖（已登记在清单的 `behaviourTestsOutsideUnit`）。

## 怎么跑

```bash
# 三份共置测试（Windows 下 node --test 必须给显式文件名，不能只给目录）
node --test services/backend/src/services/domain/structured/formatInspect/textAddress.test.js \
  services/backend/src/services/domain/structured/formatInspect/fileFormatData.test.js \
  services/backend/src/services/domain/structured/formatInspect/fileFormatDetector.test.js
# 层级守卫：本单元应从两个缺件清单里彻底消失
node scripts/ci/check-repo-layout.js --list=functional-unit | grep -c formatInspect
node scripts/ci/check-repo-layout.js --list=entry-buffer | grep -c "domain/structured/formatInspect"
```

净算术与第 21/22/23 批同一口径：一份清单覆盖 3 个源文件 = `entry-buffer` −3；
一份同名同目录测试 = `functional-unit` −1。新增 `README.md` 后须跑
`node scripts/docs/build_docs_site.js` 生成同名 `.html` 孪生，否则 `docs:verify` 会报缺件。
