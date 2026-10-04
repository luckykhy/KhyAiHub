# cpa — CPA 密钥池、协议转换与服务面（D2）

三个文件：`cpaKeyPool.js`（加密凭据池）、`cpaService.js`（服务面 + 端口探活）、
`cpaProtocolConverter.js`（Anthropic ↔ OpenAI ↔ Gemini 的纯转换）。

## 谁要（角色）

- **目前只有测试**：`tests/services/domain/cpa/{cpaService,cpaKeyPool,
  cpaProtocolConverter}.test.js`。
- **生产侧消费者：零**（本次在 `services/backend/src`（本目录之外）、`apps/`、
  `platform/`、`scripts/`、`software/` 全量 grep `domain/cpa` 无命中）。
  相关提及全是注释：`constants/serviceDefaults.js:423,627`、
  `gateway/keyStrategyDict.js:9`。
- **命令入口：无**——`commandSchema.js` 与 `src/cli` 里没有 `cpa` 分派点。

## 为什么这么做

`cpaProtocolConverter.js` 头部（`:6`）写明「纯函数、无 IO、确定性」，
它确实不 require `fs`——协议转换必须是可表驱动的纯映射，
否则「同一条消息转成 OpenAI 形状」每次结果不同就没法验收。
IO 的两件各有单点：`cpaKeyPool.js:23` 只经 `fs` 写加密池，
落点走 `getDataDir('cpa')`（`:70`，规则 1：根来自 dataHome 而非字面量）；
`cpaService.js:15` 用 `node:net` 做 `probePort` / `findAvailablePort`
（端口不硬编码，符合规则 1 的端口韧性）。

## 怎么验

```bash
cd services/backend
node --test tests/services/domain/cpa/cpaService.test.js          # 7 tests / 7 pass / 0 fail
```
同目录另有 `cpaKeyPool.test.js`、`cpaProtocolConverter.test.js`（node:test，
本卡未复跑）。

## 已知缺陷（登记，需人裁决，AI 不代决）

**这是一个「已建好但零接线」的单元**：没有命令入口、没有生产 require，
只有设计文档（DESIGN-CPA-002 P1）与三个测试。按 `[RESEARCH-018]` 的立场，
这属于「新机制先落缓冲区再晋级」的正当形态，但也可以被裁为「未完成的特性」。
无论哪种，**删除或接线都必须由人决定**：删除属规则 7（部位清单 +
可执行 `rollback.txt` + 文档背书核查，而它正有设计文档背书 → 会被
`delete-documented-code` 拒放行）；接线属规则 6（需求五问）。
