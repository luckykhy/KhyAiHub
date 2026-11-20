# [DEPLOY-MAN-022] Android 签名发布链与 CI 归档

> 交付物：`dist/android/`（`app-release.apk` + `app-release.aab` + `mapping.txt` + `SHA256SUMS.txt`）。
> 本篇管它在 CI 里怎么被构建、签名、归档。**本地怎么构建见 `scripts/release/build-android.ps1` 头注**，两处不重复。
> 登记表侧的条目是 `BUILD-OUTPUTS.json` 的 `android-release-chain`（2026-11-20 补登记）。

## 0. 为什么需要 CI 归档这一环

`dist/android` 被 `.gitignore` 的三条规则同时屏蔽——`dist/`（L9）、`*.apk`（L265）、`*.aab`（L266）。
git 追踪不到它，所以它**没有任何版本库意义上的备份**。

2026-11-20 的实证：一次 `clean.js --apply` 把它（171 MB）连同 `mapping.txt`、`SHA256SUMS.txt`
永久删掉，只能靠重跑构建恢复。重建出的 APK 与原件**只差 4 字节但 sha256 不同**
（`627e0e0a…` vs `0d0decef…`）——版本号与签名身份一致，可正常发布，但任何记录旧哈希的地方都要更新。

所以：**GitHub Release 是它唯一的耐久归档。** CI 不上传，就等于没有备份。

## 1. CI 怎么跑

`build-executables.yml` 的 `build-android` job，`windows-latest`：

| 步骤 | 做什么 |
|---|---|
| Setup JDK 17 | `actions/setup-java@v4`，temurin。`android/app/build.gradle` 锁 `VERSION_17` |
| Setup Android SDK | `android-actions/setup-android@v3`，设 `ANDROID_SDK_ROOT` / `ANDROID_HOME`（脚本 `:152-163` 认这两个），并自动接受 licence |
| Setup Flutter | `subosito/flutter-action@v2`，**pin 3.47.2**（自带 Dart 3.13.2，对齐 pubspec 的 `sdk: ^3.13.2`） |
| Materialize release keystore | 从 secret 解出 keystore 到 `android/khyos-release.keystore` |
| Build signed release APK and AAB | 直接调 `scripts/release/build-android.ps1`，不重写构建逻辑 |
| Verify release signature | `verify-android-signature.js` 交叉核对 APK signer 与 keystore；非 release 签名就 `throw` |
| Upload artifacts | `actions/upload-artifact@v4`，retention 30 天 |

**触发条件**：`refs/tags/v*` 或 `workflow_dispatch`。
main 上的常规推送**不跑**——APK 是发布件，不是每次提交都要的构件，这样也省掉每次推送几分钟的 flutter 构建。
`release` job 的 `needs` 里有 `build-android`，所以 tag 构建一定等它完成。

## 2. 需要配的 4 个 secret

Settings → Secrets and variables → Actions → New repository secret：

| Secret | 值 | 本机怎么取 |
|---|---|---|
| `KHY_ANDROID_KEYSTORE_BASE64` | base64 编码的 `khyos-release.keystore` | `certutil -encode android\khyos-release.keystore tmp.b64`，或 `openssl base64 -in … ` |
| `KHY_ANDROID_KEY_ALIAS` | `key.properties` 的 `keyAlias` | 默认 `khyos-release` |
| `KHY_ANDROID_STORE_PASSWORD` | `key.properties` 的 `storePassword` | 同文件 |
| `KHY_ANDROID_KEY_PASSWORD` | `key.properties` 的 `keyPassword` | 同文件 |

**为什么不落 `key.properties`**：`android/app/build.gradle` 的签名优先级是
`KHY_ANDROID_*` 环境变量 > `key.properties` > debug 回退。环境变量是最高优先级，
且不必在 CI 里管一个 gitignored 文件。

> `key.properties` 里 `storePassword` / `keyPassword` 是**明文**。备份签名身份必须连它一起备，
> 只备 keystore 恢复不了。机外备份脚本见本篇 §6。

## 3. 缺 secret 会怎样（优雅降级，不是静默失败）

`build-android.ps1` 检测不到 release 凭证时自动回退 debug 签名，并按「命名跟随签名事实」
（脚本 `:574-575`）把产物命名为 **`app-debug.apk` / `app-debug.aab`**。

而 `release` job 的上传 glob **只匹配 `app-release.*`**，所以：

- debug 包**结构上不可能**被当成发布件上传，不需要额外闸门
- `fail_on_unmatched_files: false` 让可选的 Android 归档不拖垮整个 release
- workflow 会打 `::warning::` 提示缺哪个 secret

也就是说：**忘了配 secret，结果是"这次 release 没有 Android 包"，不会是"release 里混进一个 debug 签名的包"。**

## 4. 已验证 / 未验证

**已验证（2026-11-20，本机）**：

- workflow 用 `js-yaml` 真解析通过，30 条结构断言全过（job 依赖、`if` 条件、4 个 env 是否齐全、
  上传路径不含 `app-debug.*`、全文无 `X:\` 绝对路径、无裸冒号 step name）
- 两个 PowerShell `run:` 块在 **PowerShell 5.1 的解析器**下干净通过
- 复杂的那块（`Verify release signature`）与送检片段**逐字节一致**
- `bash base64 -d` 字节级往返一致
- `build-android.ps1` 在 5.1 下解析干净，且已用 5.1 跑通过一次完整签名构建
- `scripts/ci/check-workflow-sanity.js --changed`：0 error

**未验证**（需要推 tag 才能测，属于发布动作，没做）：

- `subosito/flutter-action` 的 SDK 缓存是否命中
- `android-actions/setup-android` 的 licence 自动接受
- `shell: powershell` 在 GitHub `windows-latest` 上的实际行为（本机只有 5.1，runner 镜像两者都预装；
  选 5.1 是因为它与 `package.json` 的 `android:release` 调用方式一致、且已实测跑通）
- flutter 在 runner 上走 `$env:FLUTTER` → `local.properties` → PATH 的解析顺序
  （`local.properties` 里是 `D:\Portable\…` 机器路径，runner 上不存在，应落到 PATH）

## 5. 手动触发一次看结果

```
gh workflow run build-executables.yml --ref refactor/core-multiterm
gh run watch
```

在分支上 `workflow_dispatch` **不会**创建 release（`release` job 要求 `refs/tags/v`），
只会跑 `build`（4 平台矩阵）和 `build-android`，产物落在 Actions 的 artifacts 里。
注意这会消耗较多 CI 分钟。

真要出 release：推 `v*` tag，`release` job 会把四个 Android 文件一起挂到 GitHub Release 上。

## 6. 相关文件

| 用途 | 路径 |
|---|---|
| 构建脚本（签名优先级、产物命名的真源） | `scripts/release/build-android.ps1` |
| 签名校验（交叉核对 APK signer 与 keystore） | `scripts/release/verify-android-signature.js` |
| gradle 签名配置（读 `KHY_ANDROID_*` 与 `key.properties`） | `delivery/channel/mobile/khy-os-client-app/android/app/build.gradle:156-196` |
| CI job | `.github/workflows/build-executables.yml` 的 `build-android` |
| 登记表条目 | `docs/10_规范/registry/BUILD-OUTPUTS.json` 的 `android-release-chain` |
| keystore / 口令（**gitignored，全仓唯一一份**） | `delivery/channel/mobile/khy-os-client-app/android/khyos-release.keystore`、同目录 `key.properties` |
| 防误删 | `scripts/maintenance/clean.js` 的 `PROTECTED_FILE_EXACT` |

> `PROTECTED_FILE_EXACT` 里同时列了 `android/app/build.gradle`（Groovy，签名配置所在）和
> `android/build.gradle.kts`（Kotlin，项目级）——两个都存在、都未被 git 跟踪、都是承重构建入口。
> 2026-11-20 第一版只写了 `.kts`，差点漏掉真正装签名配置的那个。
