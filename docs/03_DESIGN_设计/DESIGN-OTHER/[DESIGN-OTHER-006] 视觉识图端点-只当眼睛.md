<!-- IMPL-STATUS: done -->
<!-- IMPL-DRIFT-AUDIT: 2026-10-28 · 本次落地即按本文档实施，无漂移 -->
# DESIGN-OTHER-006 · 视觉识图端点（只当眼睛）——配置入口与一个被绕过的潜在缺陷

> **状态**：已实现（后端 + 终端 CLI）。网页与桌面端 UI 留到下一轮。
> **触发**：人 2026-10-27 明示「视觉模型与推理模型要提供两个配置入口，这样在模型没有视觉时就可以相互组合了，包括终端、网页、桌面端口」。
> **裁决记录**：范围 = 先做后端 + 终端；组合方式 = **视觉只当眼睛，推理模型作答**。
> **红线**：R1（不自动 commit/push）、R2（密钥不进任何会被提交/镜像的文件）、B7（不动版本号）、B3（外科手术式改动）。

---

## 一、要解决的是什么

带图请求遇到一个**没有视觉能力**的推理模型时，系统本来就有答案：让视觉模型描述图片、把描述注入 prompt、由推理模型作答。这条链路（`KHY_VISION_DESCRIBE_RETURN`，`services/gateway/visionDescribeReturn.js` + `aiGatewayGenerateMethod.js:3205-3307`）**早就存在且默认开启**。

缺的从来不是组合逻辑，是**声明入口**：

| 面 | 此前状态 |
|---|---|
| 手机端 | 早就有 `visionBaseUrl` / `visionApiKey` / `visionModel` 三字段（`app_config.dart`） |
| PC 终端 | **只有一个环境变量 `KHY_VISION_FALLBACK_MODEL`，而全仓没有任何生产代码写它**；`khy config set` 白名单里也没有它 |
| 网页 / 桌面 | 没有入口 |

于是 PC 侧给识图配一个独立端点（本地 Ollama、或另一家厂商）的唯一办法是**手改 `.env`**。本设计补的就是这个入口。

---

## 二、三个持久平面，以及为什么这样分工

```
<dataHome>/vision_endpoint.json     声明式 {baseUrl, model, updatedAt}，零密钥材料
<dataHome>/api_keys.json            保留池 khy-vision 的 key + endpoint
.env                                不写
```

**为什么密钥进 `api_keys.json` 而不是 `custom_providers.json`**：后者**没有热加载监听**（`customProviderRegistry._load` 的 `_cache` 只被测试里的 `_resetCache` 失效）。另一个 CLI 进程写进去的注册表，对正在跑的网关守护进程要重启才可见。`apiKeyPoolWatcher` 确认监听 `apiKeyPool.getPoolFilePath()`（`apiKeyPoolWatcher.js:270-285`）。

**为什么不走 `registerCustomProvider`**：它写 `custom_providers.json`（见上），还会写三个 env map，实测全部非必需——
- `apiAdapter.resolveProviderScope:392-410` 对未知 provider 名走 `getPoolServiceMap()[poolKey] || 'openai'` 默认分支；
- `GATEWAY_API_POOL_DEFAULT_MODEL_MAP` 只在 model 串不带 id 时才被 `defaultModelForPoolProvider` 碰到，而我们的 pin 总带 id；
- `PROXY_MODEL_ROUTE_MAP` 是代理侧，describe 调用显式传了 `apiPoolProvider`。

**为什么 `.env` 一个字节都不写**：pin 只注入**每请求的 routing env 副本**。先例是 `aiGatewayGenerateMethod.js:3145-3150` 的 GLM 默认兜底——同一段形状，同一套理由。写 `.env` 会让「另一个 CLI 进程 / 常驻网关看不看得见这次改动」变成运气问题。

**`khy-vision` 登记为保留池名**（`customProviderRegistry.BUILTIN_POOL_KEYS`）：blast radius 只有四处消费者——`saveProvider:132` 拒绝覆盖、`normalizePoolKey:89` / `unregisterCustomProvider:266` 拒绝、以及三处用户可见选择器过滤掉它（这本就是想要的：它是内部池，不是用户可注册的自定义 provider）。只有已经手注册了名叫 `khy-vision` 的自定义 provider 的用户受影响，改名即可。

**密钥簿记刻意手写而不复用 `customProviderRegistrar.replaceProviderKeys`**：那个函数快照旧 id → 容忍重复添加错误 → 删快照，**重设同一个 key 会把它删掉**（`addKey` 对已存在的 key 抛 "already exists" 被它吞掉，然后它把快照里的旧 id 删了）。`priority: 10` 与 `registerCustomProvider` 同档，盖过 env 兜底的 0（`apiKeyPool.pick:621-626` 按 priority 降序）。label **不能是 `'env'`**——`apiKeyPool.save` 会静默丢弃 env 标签条目，密钥就白写了。

---

## 三、核心：两道注入缺一不可

`visionRoutingEnvPatch(env, config, hasPoolKey)` 是零依赖纯函数，做两件事：

```js
KHY_VISION_FALLBACK_MODEL = pin     // ① visionRouting.js:88-103 的显式钉选分支
KHY_VISION_MODELS         += pin    // ② visionCapability.js:116-119 的精确集命中
```

**② 不是死代码，是与池名无关的那道保证。** 实测（`visionEndpointStore.test.js` 里那条用例用 `khy-eyes/` 而非我们真实的 `khy-vision/`，正是因为后者**池名本身含 `vision` 片段、会误打误撞命中启发式，从而掩盖 ② 的作用**）：

| pin | 只有 ① | ① + ② |
|---|---|---|
| `my-pool/qwen-vl-4b` | switch-model ✓（命中 `qwen-vl` 片段） | ✓ |
| `my-pool/x-vl` | switch-model ✓（命中 `-vl`） | ✓ |
| **`my-pool/some-model`** | **ocr-fallback ✗ 静默丢弃** | **switch-model ✓** |
| **`khy-eyes/plain-model`** | **ocr-fallback ✗** | **switch-model ✓** |
| `stepfun/step-3.7-flash` | switch-model ✓（有人手把带前缀形式登记进了 `BUILTIN_VISION_MODELS`） | ✓ |

---

## 四、必须记下来的潜在缺陷（根治留给后续）

### 4.1 缺陷本体

`decideVisionRouting` 的钉选分支（`visionRouting.js:93`）拿**完整带前缀的 pin** 去问 `isVisionCapableModel(pinned)`，而 `_normModel` 就是 `utils/trimLowerNullish.js`——**只 trim + 转小写，不剥 pool 前缀**。可所有能力来源存的多是**裸模型名**。

**后果**：用户配一个名字不含那约 20 个 `VISION_NAME_HINTS` 片段之一的视觉模型，pin 分支被整个跳过、**悄悄退回 OCR，不报错、不告警**。GLM 能跑通纯属 `isGlmVisionModel` 子串判定的侥幸。

### 4.2 附带发现：provider 声明机制对跨 pool 实际上是失效的

`custom_providers.json` 的 `capabilities:{vision:true}` / `visionModels:[...]` 声明（`customProviderVision.js:41-61`）存的也是**裸 id**，对带前缀的 pin 同样匹配不上。**也就是说网页/桌面上那个让人去填 `visionModels` 的 UI，在跨 pool 场景下是不工作的**——用户填了、保存成功、没有任何报错，然后识图静默走 OCR。

下一个人看到那个 UI 会以为它有效。**这里明确记下：它对跨 pool 无效。**

### 4.3 本次的规避（不是修复）

注入时把带前缀的 pin **同时追加进 `KHY_VISION_MODELS`**（`visionCapability` 是精确集命中，`parseListToSet` 按 `/[,\s]+/` 切分，`khy-vision/my-model` 原样存活）。这是 `BUILTIN_VISION_MODELS` **已经在用的惯例**——它自己就登记了 `'stepfun/step-3.7-flash'` 这种带前缀形式，所以不是新发明。

**规避的边界**：只覆盖我们自己的注入路径。用户自己手写 `KHY_VISION_FALLBACK_MODEL=other-pool/plain-id` 而不同时写 `KHY_VISION_MODELS`，仍会静默走 OCR。

### 4.4 根治方案（独立一处改动，带自己的测试）

`visionRouting.js` 在钉选分支里**剥前缀后二次判定**：先用完整 pin 问一次（保住现有行为），不中再用 `_modelProviderPrefix(pin)` 剥掉的前缀后半部分问一次。这一改能让 §4.2 的 provider 声明机制对跨 pool 生效，是它本来的设计意图。

**为什么不本次做**：它改的是路由判定的核心叶子，影响面覆盖所有带图请求，需要自己的完整测试矩阵与回归基线。本次的范围是「补配置入口」，把路由核心的语义变化裹进来违背 B3。

---

## 五、三个入口共用同一份 ops

```
khy vision config                              四步向导（交互）
khy config set model.vision.base_url|api_key|model <值>    非交互
khy manage vision-config get|set|clear         管理资源（CLI 与后续 Web/桌面的共同漏斗）
```

管理资源是 `resourceContract.js:11` 那道红线的落地：**ops 是写入真源的唯一漏斗**。三个入口都经 `managementRegistry.invoke('vision-config', …)`，所以对同一资源、同一操作，两端执行的是同一份代码——矛盾从架构上消除，而不是靠纪律比对。`parityGuard.js:44-55` 钉住 `manage` 子命令与资源 id 完全相等。

**`clear` 为什么是独立能力而不是 `set` 传空串**：`writeVisionEndpoint` 对空 `baseUrl` 抛错，而「删掉」与「URL 打错了」在空串上不可区分。让漏斗自己判，比让调用方猜可靠。

**增量写作为什么放在 store 而不是漏斗**：第一版把合并放在 resource 的 `_mergeArgs` 里，结果 `khy config set model.vision.base_url <url>` 在一台新机器上**永远失败**——漏斗要求两个字段同时到齐，而用户天然是一个一个填的。把合并下沉到 store（合并源是 `_readRaw()` 而不是 `readVisionEndpoint()`：后者对半配置返回 null，URL 就找不回来了，二者互相把对方锁死），半配置于是可以落盘但**读回来是 null**，行为与「完全没配」逐字节相同。真正拦住「把路由钉到不存在的模型上」的是那道**读取闸**，不是写入闸。

---

## 六、写入前的连通性自检

复用 `customProviderVerify.verifyCustomProviderDraft`——与 `khy manage custom-providers add` **同一道闸**，所以「探测不过就不写任何配置」这条纪律在两个入口上一致，不会出现「这边能写那边不能写」。

它还会做一件有用的事：上游报了模型列表时，**手敲的模型 id 必须真的在里面**（`customProviderVerify.js:272-279`）。写错名字过去要等到真实对话才炸成 400/404。探不到列表（老中转没实现 `/models`）则跳过这一步，交给对话自检。

---

## 七、已知不对称（记录，不是阻塞）

1. **`mcp-vision` 兜底路径**（`aiGatewayGenerateMethod.js:3692`）读的是 `process.env` 而不是 `_routingEnv`，所以用户设了 `KHY_MCP_VISION_SERVER` 且我们的 pin 被跳过时，它看不到视觉端点。pin 触发时不可达（`decideVisionRouting` 里钉选先于 MCP），且 GLM 默认兜底今天有**完全相同**的不对称。
2. **`KHY_VISION_MODELS` 注入是每请求作用域**，所以那个 pin id 在 `pickVisionCandidate` 的兄弟扫描和 `'auto'` 跨 provider 扫描里不是全局视觉 capable。刻意如此：把改动面收在一个请求里。
3. **`KHY_VISION_FALLBACK_MODEL=auto` 会禁用视觉端点**——我们的补丁见到显式 env 值就整体退出（`'auto'` 算未设，因为它本来就是「跳过钉选、交给后续步骤」的约定值）。这是用户显式选择不钉选，向导里会 warn。
4. **`adapterVisionCapability.NATIVE_VISION_ADAPTERS = ['codex']`**——codex 领先的请求会保留图片、从不咨询视觉端点。既有行为，不变。
5. **`KHY_TEXT_ONLY_MODELS` 是个陷阱**：它优先级最高，用户如果把 pin 也填进去，钉选会被判纯文本。
6. **`apiKeyPool.save` 的文件模式在 Windows 上不生效**：`atomicWriteJson(..., {mode: 0o600})` 在 Linux 上是 0600，在 Windows 上 `fs.chmodSync` 只映射只读位，实测落盘是 666。这不是本次引入的暴露面——`api_keys.json` 本来就是这个模式，且 dataHome 已 gitignore。

---

## 八、架构债：为什么新叶子没有进那个 200 成员的环

`visionConfigEditor.js` 依赖 `../formatters` 与管理漏斗，二者都在一个 200 成员的强连通分量里；`gatewayConfigEditor.js` 也在环内。

第一版在 `gatewayConfigEditor.js` 里静态 `require('./visionConfigEditor')`，`archDebtScan` 立刻报「新增架构债」——多一条回边，把新叶子也拉进环中。

**解法：菜单项经 `commandAutoRegistry.dispatch('vision', …)` 分发，不静态 require。** 两个好处：
- 单一实现——菜单与 `khy vision config` 走同一个 manifest handler，不会出现「菜单里能写、命令行里不能写」两份逻辑；
- `commandAutoRegistry` 是运行期按文件名动态加载的，静态扫描看不见这条边，于是 `visionConfigEditor.js` 是指向环内的叶子而不是环的成员。

Slice A 的 `visionEndpointStore.js` 同理：`apiKeyPool` 与 `configGuard` 都改成**调用方传入**，让纯函数零依赖，新增文件因此不扩大既有环。

---

## 九、本次明确不做

- **网页和桌面的 UI**（下一轮：`MyGateway.vue` 加卡片 + `/api/user-gateway/vision-config`；`KeyManagerPage.tsx` 加 tab + `vision:*` IPC）。后端打通后它们只是壳。
- **根治 §4 的 pin 前缀缺陷**。本方案用注入 `KHY_VISION_MODELS` 规避，但「provider 声明机制对跨 pool 失效」这一点必须留在文档里，否则下一个人会以为填了 `visionModels` 就有效。
- `router.js` 的任何改动（用自注册 manifest 绕开；它是基线钉死的上帝文件）。

---

## 十、验收

| 命令 | 结果 |
|---|---|
| `node --test`（6 个相关套件） | 84 pass / 0 fail |
| `npx jest tests/cli/config.vision.test.js config.handler.test.js gatewayConfigEditorLeaf.test.js` | 45 pass / 0 fail |
| `node scripts/archDebtScan.js` | ✓ 无超出基线的新增架构债 |
| `node scripts/ci/check-agent-rules.js <13 个改动文件>` | passed |
| `node scripts/ci/check-change-safety.js <同上>` | 2 条非致命 warning（本机无 Python → 内置密钥明文检查跑不了；改动文件数 9 超过低开销扫描阈值 8） |
| `node scripts/ci/check-gov-rules.js` | passed |

**顺带修掉的两条存量红测**：`tests/cli/config.handler.test.js` 的 `list prints model config table` / `show behaves as list alias` 自 2026-10-04（`bc43302f`）起就钉着英文 `Config file:`，而产品输出按 CLAUDE.md §五 一直是中文 `配置文件：`。改断言不改产品行为。

**端到端手测**（未做，留给人）：手写 `vision_endpoint.json` + `api_keys.json` → 用一个纯文本模型发一条带图请求 → 断言日志出现「识图方法: 视觉模型代理 — 调用 khy-vision/<model> 识图」。配好之后再走 `khy vision config` 四步向导、`khy config get model.vision.model`、`khy manage vision-config get --json`。
