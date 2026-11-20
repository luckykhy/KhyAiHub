#!/usr/bin/env pwsh
# khy-os Android signed-release builder (PowerShell, cross-platform).
#
# Builds the khy-os mobile app (delivery/channel/mobile/khy-os-client-app, Flutter) into a signed
# release APK + AAB, verifies the signature, and copies both into
# ./dist/android with a SHA-256 manifest.
#
# Signing precedence (handled by android/app/build.gradle):
#   1. KHY_ANDROID_* env vars (CI/CD)
#   2. android/key.properties (local dev, gitignored)
#   3. debug keystore fallback (build never breaks, but NOT Play-store-ready)
#
# Why a separate script (not part of publish-dual.sh): Android is a THIRD
# distribution channel with its own toolchain (JDK + Android SDK + Flutter +
# gradle). Wedging it into the pip/npm audit gate would let a missing Android
# SDK abort a perfectly good pip/npm publish. This script is fail-soft: a
# missing toolchain prints actionable guidance and exits non-zero without
# touching the dual-channel artifacts.
#
# Usage:
#   powershell -File scripts/release/build-android.ps1
#   powershell -File scripts/release/build-android.ps1 -AabOnly
#   powershell -File scripts/release/build-android.ps1 -ApkOnly
#   powershell -File scripts/release/build-android.ps1 -SkipBuild
#   $env:KHY_ANDROID_STORE_FILE='...' ; ... ; powershell -File scripts/release/build-android.ps1
#
# Notes (single-maintainer cheat sheet):
#   Local:    .\scripts\release\build-android.ps1
#   Artifacts: dist/android/app-release.apk + app-release.aab + mapping.txt
#     + SHA256SUMS.txt
#     Debug fallback 时产物按签名事实命名：app-debug.apk / app-debug.aab。
#   If the script WARNS "DEBUG-signed": no release credentials were found;
#     the output is NOT Play-store-ready. Check android/key.properties or set
#     the KHY_ANDROID_* env vars, then re-run.
#   If the script WARNS that R8 mapping.txt was not found: no minification
#     output exists in the build tree (minify disabled or outputs cleaned), so
#     obfuscated stack traces cannot be symbolized; WARN-only by design.
#   Assets budget: android/app/src/main/assets over KHY_ASSETS_BUDGET_MB
#     (default 10) prints its top-5 largest files and WARNS;
#     KHY_ASSETS_STRICT=1 escalates the overrun to a hard FAIL.

[CmdletBinding()]
param(
  [switch]$AabOnly,
  [switch]$ApkOnly,
  [switch]$SkipVerify,
  [switch]$SkipBuild,
  [string]$OutputDir,
  [string]$DistDir
)

$ErrorActionPreference = 'Stop'
# scripts/release/ -> up two levels = repo root.
$root = (Get-Item $PSScriptRoot).Parent.Parent.FullName
$appDir = Join-Path $root 'delivery\channel\mobile\khy-os-client-app'
$androidDir = Join-Path $appDir 'android'
$keyProps = Join-Path $androidDir 'key.properties'

if (-not $DistDir) { $DistDir = Join-Path $root 'dist\android' }
if (-not $OutputDir) { $OutputDir = $DistDir }

Write-Host ""
Write-Host "=== Locating Android toolchain ==="

function Say-Info([string]$m) { Write-Host "[INFO]  $m" -ForegroundColor Cyan }
function Say-Ok([string]$m) { Write-Host "[OK]    $m" -ForegroundColor Green }
function Say-Warn([string]$m) { Write-Host "[WARN]  $m" -ForegroundColor Yellow }
function Say-Fail([string]$m) {
  Write-Host "[FAIL]  $m" -ForegroundColor Red
  exit 1
}

# Run a native .bat/.exe and surface its real exit code. Native tool output
# (flutter/gradle warnings) goes to stderr and, under PowerShell's
# $ErrorActionPreference='Stop', would otherwise throw a NativeCommandError on
# benign warning text. Capture combined output via a child process that writes
# to a temp file, echo it, and read the child's real exit code. Returns ONLY
# the exit code; the captured output is written to $script:LastToolOutput for
# inspection on failure.
function Invoke-Tool([string[]]$cmd, [string]$workDir = '') {
  $exe = $cmd[0]
  $argStr = if ($cmd.Length -gt 1) { $cmd[1..($cmd.Length - 1)] -join ' ' } else { '' }
  $tmpOut = [System.IO.Path]::GetTempFileName()
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = $argStr
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $psi.CreateNoWindow = $true
  if ($workDir) { $psi.WorkingDirectory = $workDir }
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  $proc.Start() | Out-Null
  $stdoutTxt = $proc.StandardOutput.ReadToEnd()
  $stderrTxt = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  $code = $proc.ExitCode
  $script:LastToolOutput = ($stdoutTxt + "`n" + $stderrTxt).Trim()
  Remove-Item $tmpOut -ErrorAction SilentlyContinue
  if ($script:LastToolOutput) { Write-Host $script:LastToolOutput }
  return $code
}

$ErrorActionPreference = 'Stop'

# ── Flutter ───────────────────────────────────────────────────────────────────
function Read-FlutterSdkFromLocalProps {
  # local.properties is the Flutter-managed, machine-local truth for the SDK path
  # (gitignored; settings.gradle.kts already loads flutter.sdk from it). Reading it
  # here keeps the build working after the SDK moves, without a repo-wide hardcode.
  $props = Join-Path $androidDir 'local.properties'
  if (-not (Test-Path $props)) { return '' }
  $line = Select-String -Path $props -Pattern '^flutter\.sdk=' | Select-Object -First 1
  if (-not $line) { return '' }
  # .properties escapes backslashes (D:\\a\\b), so unescape before Test-Path sees it.
  return ($line.Line -replace '^flutter\.sdk=', '').Trim().Replace('\\', '\')
}

$flutter = $env:FLUTTER
if (-not $flutter -or -not (Test-Path $flutter)) {
  $sdk = Read-FlutterSdkFromLocalProps
  if ($sdk) { $flutter = Join-Path $sdk 'bin\flutter.bat' }
}
if (-not $flutter -or -not (Test-Path $flutter)) {
  $cmd = Get-Command flutter -ErrorAction SilentlyContinue
  if ($cmd) { $flutter = $cmd.Source }
}
if (-not $flutter -or -not (Test-Path $flutter)) {
  Say-Fail "flutter not found. Set \$FLUTTER to the flutter executable, or add it to PATH."
}
Say-Ok "flutter: $flutter"

# ── JAVA_HOME ────────────────────────────────────────────────────────────────
# 找不到就报错——**不猜本机盘符**。写死 'D:\Portable\Tools\jdk-…' 这类机器本地路径会让
# 本仓自己的 no-hardcoded-abs-path 守卫（scripts/ci/check-agent-rules.js）对本文件报红，
# 提交即 CI 红。开发机上把 JAVA_HOME / ANDROID_SDK_ROOT 指到自己的安装位即可。
if (-not $env:JAVA_HOME) {
  $jks = @(
    (Join-Path $HOME 'jdk-21')
  )
  foreach ($j in $jks) { if (Test-Path $j) { $env:JAVA_HOME = $j; break } }
}
if (-not $env:JAVA_HOME) {
  Say-Fail "JAVA_HOME not set and no JDK found. Set JAVA_HOME to a JDK 17+ install."
}
Say-Ok "JAVA_HOME: $($env:JAVA_HOME)"

# ── Android SDK ──────────────────────────────────────────────────────────────
$sdk = $env:ANDROID_SDK_ROOT
if (-not $sdk) { $sdk = $env:ANDROID_HOME }
if (-not $sdk) {
  $sdkCands = @(
    (Join-Path $HOME '.khyos\android_sdk')
  )
  foreach ($s in $sdkCands) { if (Test-Path $s) { $sdk = $s; break } }
}
if (-not $sdk -or -not (Test-Path $sdk)) {
  Say-Fail "Android SDK not found. Set ANDROID_SDK_ROOT to the SDK root."
}
$env:ANDROID_SDK_ROOT = $sdk
Say-Ok "ANDROID_SDK_ROOT: $sdk"

# apksigner: prefer the NEWEST build-tools that has it (newer apksigner
# understands v2/v3 signatures; older ones can fail to report them).
$apksigner = $null
$apksignerVer = ''
foreach ($bt in @('36.0.0','35.0.0','34.0.0')) {
  $exe = Join-Path $sdk "build-tools\$bt\apksigner.bat"
  if (Test-Path $exe) { $apksigner = $exe; $apksignerVer = $bt; break }
}

# ── Signing source detection ────────────────────────────────────────────────
function Read-Prop([string]$key) {
  if (Test-Path $keyProps) {
    $line = Select-String -Path $keyProps -Pattern "^$key=" | Select-Object -First 1
    if ($line) { return ($line.Line -replace "^$key=",'').Trim() }
  }
  return ''
}

$relStoreFile = if ($env:KHY_ANDROID_STORE_FILE) { $env:KHY_ANDROID_STORE_FILE } else { Read-Prop 'storeFile' }
$relStorePass = if ($env:KHY_ANDROID_STORE_PASSWORD) { $env:KHY_ANDROID_STORE_PASSWORD } else { Read-Prop 'storePassword' }
$relKeyAlias = if ($env:KHY_ANDROID_KEY_ALIAS) { $env:KHY_ANDROID_KEY_ALIAS } else { Read-Prop 'keyAlias' }
$relKeyPass = if ($env:KHY_ANDROID_KEY_PASSWORD) { $env:KHY_ANDROID_KEY_PASSWORD } else { Read-Prop 'keyPassword' }

$expectSigning = 'debug'
if ($relStoreFile) {
  $absStore = if ([System.IO.Path]::IsPathRooted($relStoreFile)) { $relStoreFile } else { Join-Path $androidDir $relStoreFile }
  if (Test-Path $absStore) {
    $expectSigning = 'release'
    $relStoreFile = $absStore
  } else {
    Say-Warn "release keystore not found at $absStore — the build will fall back to the DEBUG keystore (output NOT Play-store-ready, and it will be named app-debug.apk)."
  }
} else {
  Say-Warn "no release signing credentials (env or key.properties) — output will be DEBUG-signed and named app-debug.apk, NOT Play-store-ready."
}

# ── Canary stamp (per-delivery) ──────────────────────────────────────────────
# One unique marker per build run: "Khy-<version>-<yyyyMMddHHmm>-<8 rand>".
# Three routes into the artifact — android/canary.properties (primary; see
# build.gradle for why it beats the env var: a Gradle daemon pins env at
# daemon start), KHY_CANARY env (secondary), --dart-define (Dart side).
# Charset is digits + Crockford Base32 minus I/L/O/U, so the value crosses
# HTTP headers, XML attributes and an unquoted -D compiler flag unharmed.
# Skipped under -SkipBuild: a stamp generated without a build would end up in
# the ledger next to hashes of an artifact it is not baked into.
if (-not $SkipBuild) {
  $pubspec = Join-Path $appDir 'pubspec.yaml'
  $verLine = Select-String -Path $pubspec -Pattern '^version:\s*(\S+)' | Select-Object -First 1
  if (-not $verLine) { Say-Fail "cannot read version from $pubspec" }
  $appVersion = $verLine.Matches[0].Groups[1].Value
  $canaryTs = Get-Date -Format 'yyyyMMddHHmm'
  $rnd = New-Object byte[] 8
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($rnd) } finally { $rng.Dispose() }
  # One byte per character; 256 = 8 * 32, so the mask keeps every index uniform.
  $canaryRand = -join ($rnd | ForEach-Object { '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[$_ -band 31] })
  $khyCanary = "Khy-$appVersion-$canaryTs-$canaryRand"
  # Overwrite every run: the stamp is per-delivery, a stale value must never
  # survive into the next build.
  Set-Content -Path (Join-Path $androidDir 'canary.properties') -Value "khy.canary=$khyCanary" -Encoding ascii
  $env:KHY_CANARY = $khyCanary
  Say-Ok "canary: $khyCanary"
}

# ── Build ─────────────────────────────────────────────────────────────────────
if (-not $SkipBuild) {
  Write-Host ""
  $buildLabel = if ($ApkOnly) { 'Building release APK' } elseif ($AabOnly) { 'Building release AAB' } else { 'Building release APK + AAB' }
  Write-Host "=== $buildLabel ==="
  # Pre-build gate (fail-fast): the generated plugin registrant must not carry a
  # dev-dependency plugin registration. integration_test is this app's only dev
  # dependency that ships an Android plugin (pubspec.yaml:70-88), and a stale
  # registration block for it cannot compile in release.
  # Mechanism, end to end:
  #   * Every command that runs with releaseMode=false -- flutter pub get,
  #     flutter test, debug flutter run/drive -- calls
  #     regeneratePlatformSpecificTooling(releaseMode:false), and injectPlugins
  #     drops dev dependencies ONLY when releaseMode is true
  #     (flutter_tools/lib/src/flutter_plugins.dart:1407-1413). A stale
  #     registrant can therefore contain dev-dependency registrations.
  #   * Gradle puts a dev-dependency plugin on a buildType's classpath only
  #     when that buildType is NOT release
  #     (flutter_tools/gradle/src/main/kotlin/plugins/PluginHandler.kt:113-118),
  #     so the release variant cannot resolve the plugin's classes.
  #   * The registrant lives in android/app/src/main/java -- the MAIN source
  #     set, which the release variant compiles too -- so a stale block fails
  #     late and cryptically inside javac with
  #     "package dev.flutter.plugins.integration_test does not exist".
  #   * flutter build apk/appbundle --release normally regenerates the
  #     registrant with dev dependencies filtered out, but the regeneration
  #     only WRITES when the content differs (flutter_plugins.dart:538-543
  #     renders through _renderTemplateToFile). So a stale file survives, and
  #     a concurrent `flutter pub get` / `flutter test` in the same tree can
  #     dirty it WHILE gradle is running -- a pre-build check cannot see that.
  #   * Therefore this stage REPAINS instead of failing: it deletes the dirty
  #     generated file so the tool rewrites it clean, and the release APK is
  #     then inspected directly (Verify plugin registration below) so neither a
  #     missed repair nor a concurrent dirtying can reach the artifact.
  $registrant = Join-Path $androidDir 'app\src\main\java\io\flutter\plugins\GeneratedPluginRegistrant.java'

  # 同一棵树上还有别的 flutter 在跑吗？
  #
  # 这是 registrant 被中途写脏的**已观测来源**（2026-11-13 实测）：同机另一个
  # 会话正在跑 `flutter test`，而 flutter test / pub get / debug run 都是
  # releaseMode=false 的命令，会用 dev 依赖重生成 registrant（flutter_plugins.dart
  # 1407-1413 的过滤只在 releaseMode=true 时生效）。实测那次脏写就落在构建跑了
  # 640 秒之后——不是构建自己的 pub get（那会紧跟在 release 重生成后面）。
  #
  # 匹配要看对地方：flutter 命令行的参数是相对路径（test/drivers/xxx.dart），
  # 进程命令行里**不含** App 目录——所以只能认「flutter 工具快照在跑」这个形态。
  # gradle 侧相反：命令行里带 App 绝对路径。
  #
  # 拦不住它，但能说出来：看到这条告警，就知道构建失败不是随机事件，而是有人
  # 同时在构建。产物级检查保证这种竞争最多让构建失败，不会让坏 APK 出厂。
  try {
    $flutterTools = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -eq 'dart.exe' -and $_.CommandLine -like '*flutter_tools.snapshot*'
      })
    $gradleHere = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -eq 'java.exe' -and $_.CommandLine -like "*$([IO.Path]::GetFileName($appDir))*"
      })
    if ($flutterTools.Count -gt 0 -or $gradleHere.Count -gt 0) {
      $pids = @($flutterTools | ForEach-Object { $_.ProcessId }) + @($gradleHere | ForEach-Object { $_.ProcessId })
      Say-Warn ("检测到 {0} 个 flutter/gradle 进程正在跑（PID: {1}）。" -f $pids.Count, ($pids -join ', '))
      Say-Warn "其中 flutter 的 pub get / test / debug run 会用 dev 依赖重生成 GeneratedPluginRegistrant.java，可能让本次构建在 javac 阶段失败（不会产出坏 APK）。"
      Say-Warn "并发来源：同一台机器上的另一个会话（工作区共享）。等它跑完再重试。"
    }
  } catch {
    # 查不到就当没有：这道告警是提示，不是闸门。
  }

  if (Test-Path $registrant) {
    $staleDevLines = @(Select-String -Path $registrant -Pattern 'dev\.flutter\.plugins\.integration_test' | ForEach-Object { $_.LineNumber })
    if ($staleDevLines.Count -gt 0) {
      # 自愈，而不是死路。这份文件是 gitignored 的纯生成物（android/.gitignore
      # 里的 GeneratedPluginRegistrant.java），Flutter 工具会在 release 模式下
      # 重新生成它——injectPlugins 只在 releaseMode=true 时滤掉 dev 依赖
      # （flutter_plugins.dart:1407-1413）。删掉它，工具就会用干净的插件集重写。
      #
      # 为什么原来是硬失败：javac 会在 MAIN 源集上编译它，而 release 变体没有
      # :integration_test 的编译期依赖（PluginHandler.kt:113-118），报错是
      # "package dev.flutter.plugins.integration_test does not exist"——晚且难懂。
      # 但硬失败只是把同一个坑推给下一个人手工再填一遍，而填法有两条（删文件 /
      # 手工跑一次 release 构建），两条都会被人忘。
      #
      # 删除的唯一风险是「插件静默不注册」——所以配套加了产物级检查
      # （下方 Verify plugin registration）：它读的是编进 dex 的字节，不是
      # 中间文件。生成物没了、插件没编进去，发布构建会当场红，不会带着
      # NoClassDefFoundError 上架。
      Remove-Item -Force $registrant
      Say-Warn "registrant carried a dev-dependency plugin (line(s) $($staleDevLines -join ', ')); deleted the generated file so the release-mode regeneration rewrites it clean. The APK is re-checked below."

      # 机制备查（免得这段自愈被当成「绕过检查」）：
      #   flutter_tools/lib/src/flutter_plugins.dart:1407-1413
      #     injectPlugins 只在 releaseMode=true 时滤掉 dev 依赖
      #   flutter_tools/lib/src/commands/packages.dart:395-398
      #     工具自己的注释承认 pub get 会用 releaseMode=false 重生成（污染）
      #   flutter_tools/lib/src/runner/flutter_command.dart:1982-1987
      #     release 构建在跑命令前会用 release 模式重生成一次——但内容相同就
      #     跳过写盘，所以「脏文件」与「并发污染」都会漏过前置检查，
      #     这正是下面要做产物级检查的原因。
    }
  }
  # 先把依赖 settle 掉，再构建。
  #
  # 顺序是有讲究的，理由是实测出来的（2026-11-13）：
  #   * `flutter pub get` 会用 releaseMode=false 重生成 registrant（写入 dev 依赖
  #     的注册块）；
  #   * `flutter build apk --release` 会在跑命令前用 releaseMode=true 重生成一次，
  #     把上面那份脏的覆盖成干净的；
  #   * 但构建内部的 pub get 是**后台异步**的：依赖没缓存时，它会在 release 重生成
  #     之后几秒才把脏文件写回来，javac 编译到的就是脏的那份（实测时间线：
  #     干净写入 → 3 秒后脏写入 → javac 报 integration_test 不存在）。
  # 先单独跑一次 pub get，缓存就settle了：构建内部的 pub get 随即短路，不再有脏写。
  # 证据：依赖已缓存的那轮构建日志里没有 "Resolving dependencies"，也没失败过。
  #
  # 代价是多一条 flutter 调用（约 20-30s）；换来的是 release 构建不再靠运气。
  $code = Invoke-Tool @($flutter, 'pub', 'get') $appDir
  if ($code -ne 0) { Say-Warn "flutter pub get failed (exit $code) — 继续构建，依赖若不全会由构建自己报错。" }

  # pub get 刚把 registrant 写成脏的（dev 依赖在册）：删掉它，让接下来的 release
  # 重生成写一份干净的。检测在前一次已经做过，这里是 pub get 之后必须再做一次。
  if (Test-Path $registrant) {
    $staleAfterPub = @(Select-String -Path $registrant -Pattern 'dev\.flutter\.plugins\.integration_test' | ForEach-Object { $_.LineNumber })
    if ($staleAfterPub.Count -gt 0) {
      Remove-Item -Force $registrant
      Say-Warn "pub get 把 registrant 写成了含 dev 依赖的样子（line(s) $($staleAfterPub -join ', ')）；已删除，release 重生成会写干净的。"
    }
  }

  # 跑一次 release 构建。失败时只有一种情况值得自动重试：registrant 是脏的。
  # 那说明构建期间有并发 flutter（另一个会话的 pub get / test / debug run）
  # 把它写脏了——不是我们这次构建的锅（我们启动前已经删过一次、release 重生成
  # 也写过干净的）。删掉重试一次，并如实说明重试原因。
  function Invoke-ReleaseBuild([string[]]$flutterArgs, [string]$label) {
    $exit = Invoke-Tool $flutterArgs $appDir
    if ($exit -eq 0) {
      return 0
    }
    if (Test-Path $registrant) {
      $dirty = @(Select-String -Path $registrant -Pattern 'dev\.flutter\.plugins\.integration_test' | ForEach-Object { $_.LineNumber })
      if ($dirty.Count -gt 0) {
        Say-Warn "$label failed (exit $exit)，而 registrant 正带着 dev 依赖（line(s) $($dirty -join ', ')）——这是并发 flutter 写脏它的已知形态。删掉重试一次。"
        Remove-Item -Force $registrant
        $exit = Invoke-Tool $flutterArgs $appDir
        if ($exit -eq 0) {
          # 不把首次失败的原因断言成「 registrant 脏」——并发构建还会以别的形态
          # 失败（实测：mergeReleaseNativeLibs 读 libflutter.so 时 MD5 失败，
          # 文件被另一个构建占着）。只说「形态一致」，不编因果。
          Say-Ok "$label 重试后成功（首次失败的形态与并发写脏 registrant 一致，具体原因见上面首次构建的输出）"
        }
      }
    }
    return $exit
  }

  if (-not $AabOnly) {
    $code = Invoke-ReleaseBuild @($flutter, 'build', 'apk', '--release', "--dart-define=KHY_CANARY=$khyCanary") 'flutter build apk --release'
    if ($code -ne 0) { Say-Fail "flutter build apk --release failed (exit $code)" }
  }
  if (-not $ApkOnly) {
    $code = Invoke-ReleaseBuild @($flutter, 'build', 'appbundle', '--release', "--dart-define=KHY_CANARY=$khyCanary") 'flutter build appbundle --release'
    if ($code -ne 0) { Say-Fail "flutter build appbundle --release failed (exit $code)" }
  }
  Say-Ok "gradle build complete"
} else {
  Write-Host ""
  Write-Host "=== Skipping build (-SkipBuild) ==="
}

# ── Locate built artifacts ──────────────────────────────────────────────────
function Find-First([string[]]$cands) {
  foreach ($c in $cands) { if (Test-Path $c) { return $c } }
  return $null
}

$apkPath = $null
$aabPath = $null

$apkCandidates = @(
  (Join-Path $appDir 'build\app\outputs\flutter-apk\app-release.apk'),
  (Join-Path $appDir 'build\app\outputs\apk\release\app-release.apk')
)
$aabCandidates = @(
  (Join-Path $appDir 'build\app\outputs\flutter-aab\app-release.aab'),
  (Join-Path $appDir 'build\app\outputs\bundle\release\app-release.aab')
)

if (-not $AabOnly) {
  $apkPath = Find-First $apkCandidates
  if (-not $apkPath) { Say-Fail ("release APK not found in: {0}" -f ($apkCandidates -join ', ')) }
}
if (-not $ApkOnly) {
  $aabPath = Find-First $aabCandidates
  if (-not $aabPath) { Say-Fail ("release AAB not found in: {0}" -f ($aabCandidates -join ', ')) }
}

# ── Verify signature ────────────────────────────────────────────────────────
# 签名者指纹与 DN 在验证时就取好：产物名要跟随签名事实，台账里也该带上
# 「这份文件是谁签的」——只有 hash 的台账分不出 release 与 debug。
$signerDigest = ''
$signerDn = ''
if ($apkPath -and -not $SkipVerify) {
  Write-Host ""
  Write-Host "=== Verifying signature ==="
  if (-not $apksigner) {
    Say-Warn "apksigner not found in $sdk\build-tools — skipping signature check."
  } else {
    # --verbose is what makes apksigner print the "Verified using vN scheme" lines;
    # without it every scheme reads as unknown even when the APK is signed.
    $certOut = & $apksigner verify --verbose --print-certs $apkPath 2>$null
    # "Verifies" appears only when v1 (JAR) is in play; a v2/v3-only APK still
    # verifies (exit 0) but omits that word. Treat "either Verifies OR a valid
    # signer cert digest" as success.
    $verifies = ($certOut -match 'Verifies') -or ($certOut -match 'Signer #1 certificate SHA-256 digest')
    if (-not $verifies) {
      Say-Fail "APK signature verification failed (apksigner reported no valid signer):`n$certOut"
    }
    $sha256Line = ($certOut | Select-String 'Signer #1 certificate SHA-256 digest' | Select-Object -First 1).Line
    if ($sha256Line) {
      $signerDigest = ($sha256Line -replace '.*SHA-256 digest:\s*', '').Trim()
    }
    $dnLine = ($certOut | Select-String 'Signer #1 certificate DN' | Select-Object -First 1).Line
    if ($dnLine) {
      $signerDn = ($dnLine -replace '.*certificate DN:\s*', '').Trim()
    }
    # Report every scheme that actually verified, not just the first one found:
    # v2 alone (minSdk 24+) and v2+v3 both ship in the wild.
    $schemes = @()
    foreach ($s in @('v1', 'v2', 'v3', 'v3.1', 'v4')) {
      if ($certOut -match ("Verified using " + [regex]::Escape($s) + " scheme.*: true")) { $schemes += $s }
    }
    $schemeText = if ($schemes.Count -gt 0) { $schemes -join '+' } else { 'unknown' }
    Say-Ok "signature valid ($schemeText scheme). $(if ($sha256Line) { $sha256Line.Trim() } else { 'digest line not reported' })"

    if ($expectSigning -eq 'release' -and $relStoreFile -and (Test-Path $relStoreFile)) {
      # JAVA_HOME's bin holds keytool.exe on Windows; Test-Path needs the
      # extension or the whole cross-check silently disappears.
      $keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
      if (-not (Test-Path $keytool)) { $keytool = Join-Path $env:JAVA_HOME 'bin\keytool' }
      if (Test-Path $keytool) {
        # keytool prints a blank separator line before "SHA256: ..."; Select-String
        # will grab the first SHA256 match which belongs to the keystore's key.
        $keyShaRaw = & $keytool -list -v -keystore $relStoreFile -storepass $relStorePass 2>$null
        $keyShaLine = ($keyShaRaw | Select-String 'SHA256:' | Select-Object -First 1).Line
        Say-Info "cross-checking APK signer against $relStoreFile (keyAlias=$relKeyAlias)"
        if ($sha256Line -and $keyShaLine) {
          $apkSha = ($sha256Line -replace '.*SHA-256 digest:\s*','').Trim() -replace ':',''
          $keySha = ($keyShaLine -replace '.*SHA256:\s*','').Trim() -replace ':',''
          Say-Info "  APK signer  : $apkSha"
          Say-Info "  keystore key: $keySha"
          if ($apkSha -ne $keySha) {
            Say-Warn "APK signer does NOT match the release keystore ($relStoreFile) — it was signed by a DIFFERENT key. Do not upload to Play."
          } else {
            Say-Ok "APK signer matches the release keystore ($relStoreFile)"
          }
        } else {
          Say-Info "could not cross-check keystore fingerprint (keytool output unavailable) — verifying signature validity only."
        }
      }
    } elseif ($expectSigning -eq 'debug') {
      Say-Warn "output is DEBUG-signed (no release credentials found) and named app-debug.apk. This APK is NOT Play-store-ready; regenerate with release credentials for an upload."
    }
  }
}

# ── Verify plugin registration in the shipped APK ─────────────────────────────
# 为什么查产物而不是查中间文件：registrant 住在 android/app/src/main/java/…/
# GeneratedPluginRegistrant.java —— 一份 gitignored、共享、可被任意并发
# `flutter pub get` / `flutter test` / debug run 改写的文件。前置检查只看得到
# 它「此刻」的样子，看不到 gradle 跑的过程中别人把它写脏。
#
# 而脏 registrant 进到 release 产物里，两种坏法都很难查：
#   * javac 先过、脏块编进 dex —— 构建不报错，装机第一次启动才
#     NoClassDefFoundError（dev 插件不在 release APK 里）。
#   * registrant 被删、工具没重写 —— 构建照样过，所有插件静默不注册，
#     功能一个个缺失，没人知道是构建期丢的。
# 所以这条检查直接读编进 dex 的字节：注册块必须在（插件没丢），dev 依赖必须不在。
if ($apkPath) {
  Write-Host ""
  Write-Host "=== Verifying plugin registration in the APK ==="
  $dexText = ''
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    $zip = [IO.Compression.ZipFile]::OpenRead($apkPath)
    try {
      $parts = New-Object System.Collections.Generic.List[string]
      foreach ($entry in $zip.Entries) {
        if ($entry.FullName -match '^classes\d*\.dex$') {
          $stream = $entry.Open()
          $mem = New-Object System.IO.MemoryStream
          $stream.CopyTo($mem)
          $stream.Close()
          $parts.Add([Text.Encoding]::ASCII.GetString($mem.ToArray()))
          $mem.Dispose()
        }
      }
      $dexText = [string]::Join('', $parts)
    } finally { $zip.Dispose() }
  } catch {
    Say-Warn "could not read dex from the APK ($($_.Exception.Message)) — skipping plugin-registration check."
  }
  if ($dexText) {
    $hasRegistrant = $dexText.Contains('io/flutter/plugins/GeneratedPluginRegistrant')
    $hasDevPlugin = $dexText.Contains('dev/flutter/plugins/integration_test')
    if (-not $hasRegistrant) {
      Say-Fail @"
the release APK contains no plugin-registration block (io/flutter/plugins/GeneratedPluginRegistrant).

Every Flutter plugin is missing from the APK -- the app will start but each
plugin's features will be dead, with no build error to point at the cause.
Most likely the generated registrant was deleted and the tool never rewrote it.
Check that android/app/src/main/java/io/flutter/plugins/GeneratedPluginRegistrant.java
exists and registers the app's plugins, then rebuild.
"@
    }
    if ($hasDevPlugin) {
      Say-Fail @"
the release APK references the dev-dependency plugin dev/flutter/plugins/integration_test.

That plugin is not shipped in a release build, so the app will crash on start
with NoClassDefFoundError. Something wrote a dev-mode registrant into the
build (a concurrent 'flutter pub get' / 'flutter test' / debug run in this
working tree is the usual culprit) and the dirty file was compiled in.
Rebuild in a quiet tree, or re-run the repair step above.
"@
    }
    if ($hasRegistrant -and -not $hasDevPlugin) {
      Say-Ok "plugin registration present; no dev-dependency plugin in the release dex"
    }
  }
}

# ── Collect into dist + SHA-256 manifest ────────────────────────────────────
Write-Host ""
Write-Host "=== Collecting artifacts to $OutputDir ==="
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$manifest = Join-Path $OutputDir 'SHA256SUMS.txt'
Set-Content -Path $manifest -Value '' -Encoding ascii

$artifacts = @()

# 产物名跟随签名事实（S5 / T15）：文件名不证明签名——debug 签名的包落成
# app-release.apk，就是给「要装错的那个包」起了一个「能装」的名字（实测
# Download 里同名不同签名的两批 APK 的结构性成因）。签名档位在 :188-198
# 已经判过，这里按同一判定落地，并在台账里带上签名者指纹。
$apkName = if ($expectSigning -eq 'debug') { 'app-debug.apk' } else { 'app-release.apk' }
$aabName = if ($expectSigning -eq 'debug') { 'app-debug.aab' } else { 'app-release.aab' }

if ($apkPath) {
  $dest = Join-Path $OutputDir $apkName
  Copy-Item -Force $apkPath $dest
  $h = (Get-FileHash -Algorithm SHA256 $dest).Hash
  Add-Content -Path $manifest -Value ("{0}  {1}" -f $h, $apkName)
  if ($signerDigest) {
    Add-Content -Path $manifest -Value ("# signer: {0}  {1}" -f $apkName, $signerDigest)
    if ($signerDn) { Add-Content -Path $manifest -Value ("# signer-dn: {0}  {1}" -f $apkName, $signerDn) }
  }
  $artifacts += $dest
  Say-Ok "APK -> $dest"
}
if ($aabPath) {
  $dest = Join-Path $OutputDir $aabName
  Copy-Item -Force $aabPath $dest
  $h = (Get-FileHash -Algorithm SHA256 $dest).Hash
  Add-Content -Path $manifest -Value ("{0}  {1}" -f $h, $aabName)
  if ($signerDigest) {
    Add-Content -Path $manifest -Value ("# signer: {0}  {1}" -f $aabName, $signerDigest)
  }
  $artifacts += $dest
  Say-Ok "AAB -> $dest"
}
# R8 mapping must ship with the release: without it a minified stack trace is
# unretrievable and Play deobfuscation has nothing to upload. The variant
# writes it under the AGP output dir, which the buildDir redirect in
# android/build.gradle.kts moves into the Flutter build tree — hence two
# candidate roots, mirroring the APK/AAB lookup above. WARN-only: a build with
# minify disabled legitimately has no mapping and must not block the release.
$mappingCandidates = @(
  (Join-Path $appDir 'build\app\outputs\mapping\release\mapping.txt'),
  (Join-Path $androidDir 'app\build\outputs\mapping\release\mapping.txt')
)
$mappingPath = Find-First $mappingCandidates
if ($mappingPath) {
  $dest = Join-Path $OutputDir 'mapping.txt'
  Copy-Item -Force $mappingPath $dest
  $h = (Get-FileHash -Algorithm SHA256 $dest).Hash
  Add-Content -Path $manifest -Value ("{0}  mapping.txt" -f $h)
  $artifacts += $dest
  Say-Ok "mapping.txt -> $dest"
} else {
  Say-Warn ("未找到 R8 mapping.txt（查过: {0}）——混淆堆栈将无法符号化、Play 反混淆无文件可传；确认 app 模块 minify 未被关闭后重跑可消除本条。" -f ($mappingCandidates -join ', '))
}
# Canary faces in the receipt: the stamp line inside SHA256SUMS.txt witnesses
# which delivery the hashes belong to; ledger.jsonl (gitignored, works/data) is
# the per-delivery map and never enters the repo. Ledger write is fail-soft —
# a bookkeeping failure must not discard the artifacts above.
if ($khyCanary) {
  Add-Content -Path $manifest -Value "# khy-canary: $khyCanary" -Encoding ascii
  $apkShaForLedger = if ($apkPath) { (Get-FileHash -Algorithm SHA256 (Join-Path $OutputDir $apkName)).Hash } else { '' }
  $aabShaForLedger = if ($aabPath) { (Get-FileHash -Algorithm SHA256 (Join-Path $OutputDir $aabName)).Hash } else { '' }
  try {
    $ledgerDir = Join-Path $root 'works\data\khy\canary'
    if (-not (Test-Path $ledgerDir)) { New-Item -ItemType Directory -Force -Path $ledgerDir | Out-Null }
    $ledgerLine = [ordered]@{ ts = $canaryTs; canary = $khyCanary; apkSha256 = $apkShaForLedger; aabSha256 = $aabShaForLedger } | ConvertTo-Json -Compress
    Add-Content -Path (Join-Path $ledgerDir 'ledger.jsonl') -Value $ledgerLine -Encoding ascii
    Say-Ok "canary ledger: $khyCanary"
  } catch {
    Say-Warn "canary ledger write failed ($($_.Exception.Message)) — artifacts above are unaffected."
  }
}
Say-Ok "SHA-256 manifest: $manifest"

# ── Assets budget gate ───────────────────────────────────────────────────────
# Budgets the native assets gradle packs verbatim into the APK
# (android/app/src/main/assets; the Flutter asset tree is a separate payload
# and out of scope here). Default 10MB is ~4x the current contents (the
# bundled shizuku runner dominates) — headroom for real growth, tight enough
# to catch a stray media/debug dump dropped into assets. WARN-only by default
# so a bulky-but-intended addition can still ship; KHY_ASSETS_STRICT=1 turns
# the overrun into a hard FAIL (non-zero exit; already-collected artifacts
# stay in dist for inspection).
Write-Host ""
Write-Host "=== Assets budget check ==="
$assetsDir = Join-Path $androidDir 'app\src\main\assets'
if (-not (Test-Path $assetsDir)) {
  Say-Info "android/app/src/main/assets 不存在——无进包 native assets，跳过体积预算检查。"
} else {
  $budgetMb = 10
  if ($env:KHY_ASSETS_BUDGET_MB) {
    $parsed = 0
    if (-not [int]::TryParse($env:KHY_ASSETS_BUDGET_MB, [ref]$parsed) -or $parsed -lt 0) {
      Say-Fail "KHY_ASSETS_BUDGET_MB='$($env:KHY_ASSETS_BUDGET_MB)' 不是非负整数（单位 MB）——改成如 10 后重跑。"
    }
    $budgetMb = $parsed
  }
  $assetFiles = @(Get-ChildItem $assetsDir -Recurse -File)
  $assetBytes = 0
  if ($assetFiles.Count -gt 0) { $assetBytes = ($assetFiles | Measure-Object Length -Sum).Sum }
  $assetMb = [math]::Round($assetBytes / 1MB, 2)
  if ($assetBytes -gt ($budgetMb * 1MB)) {
    $assetFiles | Sort-Object Length -Descending | Select-Object -First 5 | ForEach-Object {
      Write-Host ("  {0,10:N1} KB  {1}" -f ($_.Length / 1KB), $_.FullName.Substring($assetsDir.Length + 1))
    }
    $over = "assets 体积 {0} MB 超过预算 {1} MB（android/app/src/main/assets，共 {2} 个文件）" -f $assetMb, $budgetMb, $assetFiles.Count
    if ($env:KHY_ASSETS_STRICT -eq '1') {
      Say-Fail "$over —— KHY_ASSETS_STRICT=1 生效为硬门；清理或移出上面的大文件（或用 KHY_ASSETS_BUDGET_MB 调阈值）后重跑，已收集产物保留在 $OutputDir 供排查。"
    } else {
      Say-Warn "$over —— 默认仅提醒不阻断；设 KHY_ASSETS_STRICT=1 升为硬门，设 KHY_ASSETS_BUDGET_MB 调阈值。"
    }
  } else {
    Say-Ok ("assets 体积 {0} MB / 预算 {1} MB（android/app/src/main/assets，共 {2} 个文件），预算内" -f $assetMb, $budgetMb, $assetFiles.Count)
  }
}

# ── Summary ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Release artifacts ==="
foreach ($f in $artifacts) {
  $size = [math]::Round((Get-Item $f).Length / 1MB, 1)
  $sha = (Get-FileHash -Algorithm SHA256 $f).Hash.Substring(0, 16)
  Write-Host ("  {0,-18} {1,8} MB  sha256 {2}..." -f (Split-Path $f -Leaf), $size, $sha)
}

if ($expectSigning -eq 'debug') {
  Say-Warn "these artifacts are DEBUG-signed (no release keystore was found) and named app-debug.* — do not deliver them as release."
  Say-Warn "to produce a Play-store-ready package, create android/key.properties + a release keystore, or set KHY_ANDROID_* env vars, then re-run this script."
} else {
  Say-Ok "artifacts are RELEASE-signed and ready for Play upload."
}
Say-Ok "done."
