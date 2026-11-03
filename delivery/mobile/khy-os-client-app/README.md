# khy_os_client

A new Flutter project.

## 迭代方式（先读这段，能省掉每次几分钟的等待）

**改 Dart 就用 `flutter run`，不要用 `flutter build apk`。**

本工程的原生侧是 llama.cpp + mtmd + `GGML_CPU_ALL_VARIANTS` 的 7 个 CPU 后端
+ quickjs-ng，`.cxx` 产物 1.4 GB，一次全量重编以分钟计。而源码是 **Dart 88 个
文件 / 31,086 行**、Kotlin 18 个文件 / 6,442 行——绝大部分改动落在 Dart 侧，
那一侧根本不需要重新构建。

```powershell
D:\Portable\2-tools\flutter\flutter\bin\flutter.bat run
```

连上真机后改 Dart → 按 `r` 热重载（秒级）、按 `R` 热重启。不重编原生、不重新
打包、不跑 R8。只有改了 Kotlin / C++（`android/app/src/main/cpp/`）/
`CMakeLists.txt` / `build.gradle` 才需要完整重建。

**一个工作时段内别在 debug 与 release 之间来回切。** `.cxx/Debug` 与
`.cxx/RelWithDebInfo` 是两套独立产物，每切一次就把整个 llama.cpp + 7 个后端
变体重编一遍。本地看效果固定用 `flutter run`（debug）；要出包才用
`scripts\release\build-android.ps1 -ApkOnly`（release，会跑 R8 与签名）。

**别为了构建速度去关 `GGML_CPU_ALL_VARIANTS`。** 那是拿运行时推理速度换构建
时间，方向反了；压缩构建时间的方向是热重载和 Gradle 缓存，不是砍后端变体。

## Getting Started

This project is a starting point for a Flutter application.

A few resources to get you started if this is your first Flutter project:

- [Learn Flutter](https://docs.flutter.dev/get-started/learn-flutter)
- [Write your first Flutter app](https://docs.flutter.dev/get-started/codelab)
- [Flutter learning resources](https://docs.flutter.dev/reference/learning-resources)

For help getting started with Flutter development, view the
[online documentation](https://docs.flutter.dev/), which offers tutorials,
samples, guidance on mobile development, and a full API reference.
