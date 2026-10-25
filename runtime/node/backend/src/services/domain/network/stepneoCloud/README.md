# stepneoCloud — 手机当执行器，模型走云端网关

把 **StepOS 云端模型**（`biz-gw.stepaos.com/stepfun-proxy`，`step-5-preview`）接成本地可调用的
OpenAI 兼容能力，并把**手机桥的设备工具**（`exec` / `ls` / `read` / `write` / `ui_*`）作为
function calling 交给模型。

一句话分工：**模型在云端，执行器在手机，策略在桥里。**

---

## 为什么有这一个单元

手机侧原本的反代是 `delivery/mobile/khy-os-client-app` 里的 `AmooLoop`：它通过无障碍服务
** scraping Amoo 的聊天气泡**来驱动。实测代价（2026-10-25，PZ261A / StepOS / Android 16）：

| 问题 | 实测 |
| --- | --- |
| 单轮延迟 | 约 6 分钟（Amoo 流式输出 + 两次稳定采样） |
| 前置条件 | 无障碍服务必须开启，否则空转到超时 |
| 进程生命周期 | StepOS 会在 App 退后台时冻结它（`Became not working FGS`），桥的 LISTEN 套接字还在但无人应答 |
| 截止时间 | 单任务上限被提到 3 小时 |

云端网关这条路把这些全绕开了：工具调用就是工具调用，不需要读屏、不需要前台、没有分钟级延迟。
**实测一次签名请求即通**：`HTTP 200`，`content: "47"`，`usage` 正常。

设备工具那一半不变——仍然走 `domain/network/phone` 的桥客户端。

---

## 文件

| 文件 | 职责 | IO |
| --- | --- | --- |
| `signing.js` | `zy-sign` 计算与请求头组装 | 无 |
| `accountToken.js` | 从手机账号服务日志取 token；解码自描述 JSON | adb logcat（只读） |
| `upstream.js` | 签名转发 + 失败映射 | HTTPS |
| `toolSchemas.js` | 桥工具表 → OpenAI function schema | 无 |
| `agentLoop.js` | 工具调用循环 | 委托上两者 |
| `index.js` | facade + `createStepneoSession` | 无 |

每个源文件都有同名同目录的 `*.test.js`，共 83 个用例，`node --test` 全绿，**不需要手机和网络**。

---

## 签名协议

```
sign = HMAC_SHA256(key = appSecret,
                   message = appId + nonce + timestamp + appSecret)
```

四段直接拼接，**无分隔符**，小写十六进制。路径、请求体、token、设备号都不参与签名，
所以换模型、换内容不需要改签名逻辑，但每次请求仍要新的 `nonce` / `timestamp`
（服务端校验时间戳，本机时钟偏差过大会失败）。

请求头：`Authorization`、`zy-app-id`、`zy-app-package`、`zy-client-type`、
`zy-scene-type`、`zy-device-id`、`zy-nonce`、`zy-timestamp`、`zy-sign`、`zy-trace-id`。

生产与测试两套配对（均在 `com.stepos.aiengine` 的 dex 里，`BffGatewayBootstrap$Params`
与 `FileStorageBootstrap$Params` 各存一份，值相同）：

| 环境 | appId | 网关 |
| --- | --- | --- |
| prod | `ai-engine-prod` | `biz-gw.stepaos.com` |
| test | `ai-engine-test` | `biz-gw-in.zyql.com` |

**签名密钥不在本仓，也不进任何文件**，只从 `STEPNEO_APP_SECRET` 读（见下）。

---

## 凭据（R2：只走 env，绝不落盘）

| 名称 | 用途 | 来源 | 环境变量 |
| --- | --- | --- | --- |
| 应用签名密钥 | 算 `zy-sign` | StepOS 客户端静态制品（APK 内） | `STEPNEO_APP_SECRET` |
| 账号 token | 证明是哪个账号 | 手机账号服务日志（一次性读取） | `STEPNEO_TOKEN`（可选，缺则现场取） |
| 设备号 | `zy-device-id` | token 的 `a` 字段，不需要单独配 | — |

token **没有 `exp` 字段**，客户端看不到服务端有效期，只能观测。实测一份用到约 19.7 小时、
另一份 47 小时仍正常。所以续期做成「需要时重新读一次」，不做无据的过期判断。

`accountToken.js` 只读手机账号服务**已经为 AIEngine / Ability 打印出来**的诊断日志行
（`[getAuthToken] ... basic, package = <pkg>` 与同线程的 `local db token:`），
不读账号密码、不写手机、值只进内存。刻意排除 `fullAuth` 形态——那不属于本服务的持握范围。

---

## 安全契约

这一单元**自己不设策略**。所有设备调用都经过
`domain/network/phone` 的 `phoneBridgeClient.call()`，由桥做判定：

1. **`classifyBridgeCall()` + `planBridgeCall()`** —— 会改变手机状态的工具
   （`write` / `exec` / `rm` / `ui_*` actuate 等）没有 `confirm:true` 就**拒绝执行**，
   只返回将要做什么。`agentLoop` **从不代替模型注入 `confirm:true`**，
   有专门用例钉住这一点。
2. **会话预算**（字节 / 条目 / 复制次数）在桥内累计，本循环**不按轮重置**，
   所以「同一个文件要 200 次」绕不过去。
3. **轮数上限** `DEFAULT_MAX_ROUNDS`（默认 24，可用 `STEPNEO_MAX_ROUNDS` 覆盖），
   撞上限报 `max_rounds`，与正常收尾区分开——模型没做完不是 crashed turn。

`upstream.js` 的失败映射也按这个思路写：**HTTP 200 但正文为空算失败**
（模型先思考后产出正文，`max_tokens` 太小会在思考阶段用尽，`finish_reason=length`），
并提示把 `max_tokens` 设到 128 以上；401 同时点名「签名密钥不对」和「token 过期」
两个相反方向的原因，不把人送去续一个本来没坏的 token。

---

## 用法

```js
const {
  readAccountTokenFromDevice, createStepneoSession,
} = require('./index');   // 或 require('../domain/network/phone') 拿桥客户端

// 1. 取凭据（一次性；之后请求不再需要手机）
const acct = await readAccountTokenFromDevice({ serial: 'SERIAL' });
if (!acct.ok) throw new Error(`${acct.code}: ${acct.error}`);

// 2. 组装一次会话
const session = createStepneoSession({
  token: acct.token,          // 仅内存
  deviceId: acct.deviceId,    // 取自 token.a
  appSecret: process.env.STEPNEO_APP_SECRET,
  bridge: getPhoneBridgeClient(),
});

// 3. 跑一轮
const messages = [{ role: 'user', content: '在 /sdcard/khy-os/workspace 写个贪吃蛇' }];
const out = await session.run(messages, { onProgress: (s) => console.log(s) });
console.log(out.message.content);
```

`messages` 会被就地追加（assistant 轮 + tool 结果），调用方可以自行持久化整段对话。

---

## 未验证项

- token 的服务端有效期，以及是否与手机会话绑定。
- 图片 / 音频等多模态输入（上游遇到图片输入会明确报错）。
- `usage` 与套餐扣量的对应关系；一切以服务端为准。
- 本单元尚无 D1 消费方（工具 / CLI 都还没接），所以 `khy.module.json` 里 `fanIn: 0`、
  lifecycle 记 `staged`。
