# trajectoryNarrative — 任务叙事（热奈特话语层）

把一次会话的执行记录讲成一个可追溯的故事。设计真源：
`docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-130] 任务叙事-热奈特话语层.md`。

## 流水线

```
buildConversationChain(sessionId)
  → storyCollect.collectStory   故事层：严格时序 StoryEvent[]，每条带 seq
  → discourse.buildNarrative    话语层：热奈特五范畴算子 → NarrativePlan
  → render.renderNarrative      成稿：过程叙事 + 结果叙事（预叙）+ 证据锚点表
  → polish.maybePolish          可选：模型润色（KHY_NARRATIVE_POLISH，默认关）
```

## 五范畴速查

| 范畴 | 规则 |
|---|---|
| 时序 | 顺叙；折返修订标「回到第 k 步」（倒叙）；结果前置（预叙） |
| 时距 | 场景=失败/写入/耗时≥10s/用户请求；概要=常规只读；省略=turn 统计；停顿=thinking（仅 `--focus reasoning`） |
| 频率 | 连续同名同目标工具调用合并为「N 次尝试」 |
| 语式 | `--focus task` 外聚焦 / `--focus reasoning` 内聚焦 |
| 语态 | 外叙述者 · 事后叙述 · 第三人称「KHY」 |

## 红线

过程段每句以 `[#n]` 回指故事层事件；润色稿丢锚点 / 造锚点 / 超长 3 倍
一律丢弃回退骨架。模型只改文风，不改事实。

## 怎么验

```bash
cd runtime/node/backend
node --test src/services/domain/trajectory/trajectoryNarrative/trajectoryNarrative.test.js
node bin/khy.js recap narrative            # 当前会话
node bin/khy.js recap narrative --mode process --focus reasoning
```
