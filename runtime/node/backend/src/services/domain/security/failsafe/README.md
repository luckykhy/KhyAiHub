# failsafe — 零静默失败与精准归因子系统

D2 业务上下文里的一个功能单元：把**任意原始失败信号**归并到 E01–E08 错误码，
并保证失败不会被静默吞掉（拦截器基座 + 兜底协议不可绕过）。

6 个源文件，全部有同名同目录的共置测试（27 处 `KNOWN-DEFECT` 断言钉住实测错误行为）。

## 各文件的职责（取自各文件头注释）

| 文件 | 角色 |
|---|---|
| `index.js` | 单元门面 |
| `classifier.js` | `ErrorClassifier`：把任意原始失败信号归并到 E01–E08 |
| `classifierSignals.js` | 分类器的「信号识别 + 文本脱敏/裁剪」层 |
| `errorCodes.js` | 精准归因错误字典，**单一真源** |
| `safeResponse.js` | `SafeResponseWrapper`：零静默失败拦截器基座 |
| `streamInjector.js` | `StreamFailSafeInjector`：兜底协议不可绕过 |

## 谁在用本单元（非测试外部消费者，去重 2 个）

- `src/services/failsafe/index.js:4` —— D1 侧历史路径再导出壳（`module.exports = require('../domain/security/failsafe')`）。
- `src/services/domain/maintenance/selfHeal/errorDiagnostician.js:41` —— D2 内惰性 require，自愈诊断面。

## 出域边（如实登记，不写白名单）

- `classifierSignals.js:24` → `services/errorClassifier.js`（**D1**）。D2 的名义边界只有 `["D2","D3"]`，
  这条属 `DOMAIN-DEPS.json` 的 `declared_not_enforced` D2→D1，交 `archDebtScan` R1 / `cross-layer-require` 棘轮管辖
  （逐条裁决面见 `[DESIGN-LAY-008]` §12.43）。本单元没有任何指向 D3 的 require。

## 已知缺陷（共置测试钉住，一律登记不修）

- 再归因（幂等）只保住错误码，必填字段全部退化成 unknown。
- `ctx` 里过期的 `error_code` 压过 `input` 更强的显式信号；原型链上的 `error_code` 被当成显式归因（凭空信任继承属性）。
- 只读（frozen）失败信号被降级成 E04，本应归 E06；`auth` / `billing` / 404 一类网关侧失败被归成「工具执行崩溃」。
- `detail` 用真值判断渲染，值为 `0` 的数字字段被从文案里抹掉；E07 的授权级别 `0`（L0）被当成缺失。
- `ctx` 传 `null` / 缺省时 `_readMissingDep`、`_detectKind` 直接解引用抛 TypeError —— 兜底路径自身会抛。
- 嵌套 `error.code` 绕过全大写形态校验，任意字符串都被当作合法错误码。
