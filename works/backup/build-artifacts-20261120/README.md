# 冗余构建归档 · 2026-11-20

本目录收纳**冗余构建产物**——同一版本/同一管线的重复或历史输出，活性产物不在此列。
归档而非删除：需要时可按「原始位置」一列搬回。

## 清单

| 内容 | 原始位置 | 体积 | 为什么判冗余 |
|---|---|---|---|
| ~~`khyos-electron-variants/dist-electron-3d`~~ | ~~`entries/electron/dist-electron-3d`~~ | — | **已不存在**：本表原写 368 MB，2026-11-20 实测该目录 0 文件。`works/record/ai/CONTEXT.yaml:49` 仍指向它下面的 `builder-debug.yml`，那条引用是死的 |
| `khyos-electron-variants/dist-electron-new` | `entries/electron/dist-electron-new` | 224 KB | 同上，实验变体 |
| `khyos-electron-variants/dist-electron-pack` | `entries/electron/dist-electron-pack` | 112 KB | 同上，实验变体 |
| `khyos-electron-variants/dist-electron-pet` | `entries/electron/dist-electron-pet` | 791 MB | 桌宠变体；仍被 `scripts/desktop/package-and-launch.ps1` 用作**打包缺 exe 时的回退启动位**，故保留不删 |
| `khyos-electron-variants/dist-electron-pkg` | `entries/electron/dist-electron-pkg` | 63 MB | 实验变体（原表写 654 MB，实测 63 MB，差 10 倍） |
| `mobile-apk-archive/khy-os-client-20260915-2206.apk` | `delivery/channel/mobile/khy-os-client-app/release/` | 56 MB | 9-15 人工按日期拷的发布快照；`BUILD-OUTPUTS.json` 原文：「不由任何脚本自动产出」。当前发布件在 `dist/android/`（签名链路读取处，未动） |
| `khy-main-apk-versions/prev-1.1.18.apk` | `.qoder/tmp/` | 91.8 MB | khy 主程序（G1 版本轨道）历史版本包，qoder 的 tmp 遗留；全仓零引用，qoder 进程未运行 |
| `khy-main-apk-versions/khy-1.1.19.apk` | `.qoder/tmp/` | 91.8 MB | 同上 |
| `khy-main-apk-versions/khy-1.1.20.apk` | `.qoder/tmp/` | 91.8 MB | 同上 |
| `khy-main-apk-versions/installed.apk` | `.qoder/tmp/` | 63.9 MB | 装机快照（11-13）；与 `scripts/.../provision-shell-sidecar.ps1` 自产的 `khyos-installed.apk` 同名不同物，无冲突 |

合计约 **1.23 GB**（原表写 2.25 GB，实测 1.226 GB；差额几乎全部来自上面那三条错的数字）。

> **2026-11-20 复核**：本表是归档目录唯一的记录，而它自己也被 `.gitignore` 的
> `works/backup/` 屏蔽，所以数字漂移没有任何机制能发现。已为
> `works/backup/build-artifacts-20261120/README.md` 单开一条反选让其入版本库，
> 二进制本体继续忽略。改动数字前请先实测——本表已经错过一轮。

## 刻意未动的内容（活性产物，动了会断管线）

| 位置 | 不动的理由 |
|---|---|
| `entries/electron/dist-electron` | 唯一正品，electron-builder 的 `directories.output` 指向它；launcher 与 create-shortcut 也读它 |
| `dist/android/app-release.apk`（+ .aab/mapping/SHA256SUMS） | 签名发布件：`build-android.ps1` 的产出位、`verify-android-signature.js` 的校验对象、`downloadsCatalog.js` 的下载目录都指向它 |
| `delivery/channel/mobile/khy-os-client-app/build/app/outputs/{apk/release,flutter-apk}/app-release.apk` | Flutter 工具链一次构建必然双写（AGP 输出位 + Flutter 规范位）；`build-android.ps1` 读 flutter-apk 那份作源。属官方行为，消不掉 |
| `apps/khyos-desktop/out/`、`dist-ts/`、`android/app/build/`、`.dart_tool/` | 工具活性输出/缓存，删了只是拖慢下次构建 |
| `entries/apk-unpack/` | 活性分析区：里面有 11-20 19:40 还在更新的《khyos-手机版欠缺功能》文档 |
| `.qoder/tmp/` 其余内容（约 129 MB，非 APK） | qoder 的其它 tmp 杂物（如 `acc-e2e` 夹具）；本次只按建议收走 4 个 APK，其余未动 |

## 恢复方法

整目录搬回原始位置即可（同盘移动是瞬时改名），例如：

```bash
mv works/backup/build-artifacts-20261120/khyos-electron-variants/dist-electron-pet \
   entries/electron/
```

## 备注

- 本目录已被根 `.gitignore` 忽略（`works/backup/`），不会进版本库。
- 归档后 `BUILD-OUTPUTS.json` 的 `electron-builder` / `flutter-android-release` 两条 note 已记录本动作；
  `works/record/ai/CONTEXT.yaml` 里登记的变体路径已同步改指本目录。
