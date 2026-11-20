# androidRef — Android GUI 闭环（桌面侧，不改手机 APK）

`uiautomator dump → uidref digest → 按 ref 动作 → screendiff 复检`。全部经 adb 完成，
手机侧不需要无障碍服务、不需要安装额外 APK；元素引用与变化判定用
`runtime/node/backend/vendor/android-agent-kit` 的 `uidref/js`、`screendiff/js`（Apache-2.0，
逐字入库，出处见 `vendor/android-agent-kit/SOURCE.md`）。

## 文件分工

| 文件 | 角色 | 关键契约 |
|---|---|---|
| `androidUiPolicy.js` | 纯判定叶（零 IO、绝不抛） | 门控、confirm 计划、keyevent 码表、设备侧 argv、复检结论映射 |
| `uidrefAdapter.js` | 薄 IO 壳 | 跑一次 dump、解析成 snapshot；截断/空/坏 XML 都返回结构化失败 |
| `index.js` | 装配 + 编排 | 惰性单例；只有在一次写动作里才串起 prev dump → input → 复检 dump |

`index.js` 是唯一 require `vendor/` 的源文件。相对路径是 **6 级**
（`androidRef → phone → network → domain → services → src → backend`）。5 级会落到
`src/vendor`、4 级落到 `services/vendor`，两者都不存在；多一级越出 backend。
核对方式：

```
node scripts/ci/check-repo-layout.js --list=unresolved-require
```

## 为什么坐标不经 screenpoint 反算

`uiautomator dump` 的 `bounds` 本身就是**设备像素**。uidref 的 `centerOf` 给出的
`center` 可以直接喂 `input tap`，不存在「模型给的是缩略图坐标、要按 fit/stretch 反算」
的问题。screenpoint 是给「模型自己报坐标」的场景用的，本单元的模型只说 ref。

## 门控

| flag | 读点 | 关掉之后 |
|---|---|---|
| `KHY_ANDROID_UI_TOOL` | `src/tools/AndroidUiTool/index.js: _gateEnabled`（require 期） | 工具导出 disabled 占位，自动发现跳过 |
| `KHY_ANDROID_UI_DUMP` | `androidUiPolicy.js: planAndroidUiAction`（每个动作都要先 dump） | `{success:false, code:'dump_disabled'}`，不 spawn adb |
| `KHY_ANDROID_UI_TEXT` | 同上，`type` 分支 | `{success:false, code:'text_disabled'}`，只回计划 |
| `KHY_ANDROID_UI_VERIFY_MS` | `index.js: resolveVerifyMs`（numeric，默认 20000，范围 5000–60000） | 缺值回退 20000 |

前三个是 `default-on`，父链依次是 `KHY_PHONE_BRIDGE → KHY_ANDROID_UI_TOOL`。
`VERIFY_MS` 的父门只作声明（`resolveNumeric` 不看父链），它的唯一消费方就是
`AndroidUiTool`，而那个工具的登记门已经是 `KHY_ANDROID_UI_TOOL`。

`DUMP` 门的读点是 `planAndroidUiAction`，门面导出的 `snapshot()` 也走同一个判定
（`index.js` 里先 plan 再 dump）——未来新增的调用方拿不到一条绕开门的抓屏入口。

## 文本输入：码表，不是 `input text`

`adb shell input text` 是设备侧 shell 注入面（上游 `textin` 实测：19 类字符只有 4 类
干净落地，反引号会被当命令执行）。本单元只发 `input keyevent <数字码>`：

- 允许：小写字母、数字、空格、`, . - = [ ] ; / @ + # *`
- 拒绝：大写、中文/非 ASCII、引号、反引号、`$`、换行、制表
- 单次 ≤ 80 字符；目标 ref 必须 `editable:true`

被拒时返回 `code:'text_not_supported'` 并给出替代路径：`PhoneBridge` 的 `ui_type`
（full 构建 + 无障碍授权）或 hiao 的 `ui_type`（带审批）。

## 复检语义（不装成功，也不装失败）

看的是 `screendiff.effectOf(changeSet, ref)` 的结论：

| conclusion | effective | 文案 |
|---|---|---|
| `target_changed` | `true` | 目标发生变化（moved / label_changed / …） |
| `target_gone` | `true` | 目标已从界面消失 |
| `target_unchanged` | `false` | 无可见变化，可能没点中或应用未响应 |
| `unknown_target` / 复检 dump 失败 | `null` | 无法判断——**不把没有证据当作未生效** |

`back/home/recents` 没有 ref，按整屏结构变化判（`is_identical` 才算没效果）。

## 晋级三判据（对 `check-repo-layout` 的 entry-buffer）

1. 单元级 `README.md` ✓（本文件）
2. 3 个源文件全部同名同目录测试 ✓（`androidUiPolicy.test.js` / `uidrefAdapter.test.js` / `index.test.js`）；
   `khy.module.json` 的 `tests` 另列第 4 条 = 唯一非测试消费者 `src/tools/AndroidUiTool/index.test.js`
3. 整数 `fanIn` 声明 ✓（=1，唯一消费方 `src/tools/AndroidUiTool`）

## 失败码（适配层一律结构化返回，绝不抛）

`dump_failed` / `dump_truncated` / `dump_empty` / `dump_unparsable` / `digest_failed` /
`adapter_misconfigured`。`digest_failed` 兜的是「dump 抓到了但 `metrics()`/`digest()`
算不出来」——上游返回形状变化时不能让异常穿出 `snapshot()`。

## 不做清单（诚实边界）

- 不接 `imespec` / `blindspot` 的键盘遮挡与幻影可点预检：它们需要窗口 JSON 与截图，
  本批只有 dump + input 两条 adb 原语。点按前请先用 digest 确认目标可见。
- 不做 `scrollkey` 的跨滚动稳定键：ref 只在一帧内有效，滚动后必须重新 snapshot。
- 不做失败重试与自动换目标：`target_unchanged` 如实回 false，重试由调用方决定。
- 不清理复检留下的 dump（全在内存，无落盘）；也没有新增磁盘清理机制。
- 不覆盖锁屏/支付页：这类界面会拒绝 dump，适配层如实报 `dump_failed`。
