# clientApps（路由单元）

`[DESIGN-ARCH-189]` 应用中心方案的 **S1 只读层**。本目录只有一个文件 `index.js`，
把「本机装了哪些 AI 客户端、每个配好了没」暴露成两个 HTTP 端点。

```
GET  /api/client-apps/catalog   登记表本身（appId/name/desc/pkgName/category）
POST /api/client-apps/scan      探测本机（installed / configured / configuredVerified / badge）
```

## 边界

**本单元不做任何 IO。** 不读写客户端配置文件、不碰 SQLite、不发起探测——
`catalog.json` 的装载与 `scan.js` 的机器探测都在 D2 的
`services/domain/config/clientApps/` 里发生，这里只做 Express 适配、admin 门禁
与入参校验。数据形状以那两个模块为真源，本单元不复制、不改写。

覆盖范围按裁决 **D2 = ①**：只有 `ccSwitch` 在册的 12 个 CLI 应用。
桌面端与参考对象的其余项需要新的 `externalApps` 写者，不在本切片内。

## 为什么没有「一键配置」

按 `RUNTIME-010`，S1 的「只读」必须由**执行面**保证——本单元不挂载任何写路由——
而不是靠前端把按钮置灰。所以 `/configure` 与 `/restore` 在这里**不存在**
（测试用源码文本断言 + 404 探测双向钉住）。前端因此把这两个动作显示成
**常驻不可用**，而不是「禁用中」这种暗示即将开放的说法。

模型绑定同样未开放：per-app 绑定表（裁决 **D6 = ②**）尚未落地，没有可绑的数据。
显示一个能选但选了不生效的下拉就是 fail-open，所以页面上只有一句
「模型绑定：未开放」。

## 门禁

两端点都需登录且需 admin 角色（裁决 **D5 = ①**，对齐 `/api/cc-switch`）。
「按本机用户放宽」需要新判据（多用户主机、远程访问），没有判据就不放宽。

## 已知上游缺陷（P3 已在原语层容错，写编排仍须逐个适配）

D2 的 `scan.js` / 写者对三个 adapter 不同构，S1 只读面不受影响。**P3 的双档备份原语已在原语层容忍这三个形状**
（目录/空路径 → 跳过并说明原因，绝不 throw），但 S2 写编排仍须逐个适配：

| adapter | 问题 |
|---|---|
| `traeAppAdapter.js` | `remove(query, {confirmed}, env)` 是**位置参数**，统一按 options 调会失败 |
| `codexAdapter.js` | 写者在 `gateway/adapters/`，探测返回形状与 CLI adapter 不同 |
| `cozeAdapter.js` | `configPath()` 返回**目录**而非文件，且 `COZE_HOME` 未设时返回空串 |

已记入 `[DESIGN-ARCH-189]` 实施计划的 P5。

## 测试

`index.test.js`（与 D2 侧 `catalog.test.js` 同样同名同目录共置（C-5 晋级判据要求））。
53 例（含 D2 侧 catalog/scan/backup），本单元 8 例钉住四件事：server.js 真挂载（防死代码 404）、门禁接线、**无写路由**、
未知 appId 报 400 而非静默返回短清单。

```bash
cd runtime/node/backend
node --test src/routes/clientApps/index.test.js
```
