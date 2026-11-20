// 集成测试的 host 端驱动。
//
// **为什么需要这个文件**：`flutter drive` 分两端——设备上跑的 target（本文档
// 指 `integration_test/` 下的测试）与主机上跑的 driver。这个文件就是 driver，
// 它只负责把设备端的测试结果收回来。
//
// **为什么用 `flutter drive` 而不是 `flutter test integration_test/`**：
// `flutter test` 只会构建 **debug** APK，而本项目的 debug 构建与 release 构建
// **签名不同**（release 用 `key.properties` 里的真实凭据，debug 用 AGP 自动
// 生成的 debug keystore）。于是 `flutter test` 装包时会报
// `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，并且 flutter 会**先卸载设备上原有的包**
// 再装——共享设备上这么干是有风险的。
//
// `flutter drive --release` 构建的是与设备上现装包**同一签名**的 APK，
// 能直接覆盖安装，不碰包名、不动其它状态。
//
// 配套命令见 DESIGN-ARCH-206 §9.22。

import 'package:integration_test/integration_test_driver.dart';

Future<void> main() => integrationDriver(writeResponseOnFailure: true);
