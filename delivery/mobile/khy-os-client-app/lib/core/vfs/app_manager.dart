// 应用管理：文件管理器里的「系统管理」能力。
//
// 这一层刻意放在 Dart 侧而不是原生侧：卸载、冻结、启用的命令都是 `pm` 系列，
// 而 `DeviceControl.execShellElevated` 已经封装了「优先走 Shizuku、退回普通 shell」
// 这件事。在 Dart 侧复用它，就不用在原生侧再写一遍同样的降级逻辑——
// 而降级逻辑写两遍必然会漂移。
//
// 权限现实要说清楚：`pm uninstall` / `pm disable-user` 需要 shell 权限。
// 普通 shell（App 自己的 uid）会被系统拒绝，Shizuku（adb shell）才行。
// 所以这些操作在没激活 Shizuku 时**必然失败**，界面要如实说，而不是假装成功。

import '../services/device_control.dart';
import 'vfs_channel.dart';

/// 一个已安装应用。
class ManagedApp {
  final String pkg;
  final String label;
  final String versionName;
  final bool isSystem;

  const ManagedApp({
    required this.pkg,
    required this.label,
    this.versionName = '',
    this.isSystem = false,
  });

  /// 显示名，优先用应用名。
  String get displayName => label.isEmpty ? pkg : label;
}

/// 操作结果。
class AppActionResult {
  final bool ok;
  final String message;

  const AppActionResult(this.ok, this.message);

  /// 失败且原因是权限不足——界面要引导去激活 Shizuku，而不是显示「未知错误」。
  bool get needsPrivilege =>
      !ok && (message.contains('Permission Denial') || message.contains('Shizuku'));
}

/// APK 归档信息。
class ApkInfo {
  final String pkg;
  final String label;
  final String versionName;
  final int versionCode;
  final int sizeBytes;
  final int minSdk;
  final int targetSdk;
  final List<String> permissions;

  const ApkInfo({
    required this.pkg,
    required this.label,
    this.versionName = '',
    this.versionCode = 0,
    this.sizeBytes = 0,
    this.minSdk = 0,
    this.targetSdk = 0,
    this.permissions = const <String>[],
  });

  factory ApkInfo.fromMap(Map<String, dynamic> map) {
    final raw = map['permissions'];
    final permissions = <String>[];
    if (raw is List) {
      for (final item in raw) {
        final text = item?.toString() ?? '';
        if (text.isNotEmpty) permissions.add(text);
      }
    }
    return ApkInfo(
      pkg: (map['package'] ?? '').toString(),
      label: (map['label'] ?? '').toString(),
      versionName: (map['versionName'] ?? '').toString(),
      versionCode: (map['versionCode'] is num)
          ? (map['versionCode'] as num).toInt()
          : 0,
      sizeBytes: (map['sizeBytes'] is num)
          ? (map['sizeBytes'] as num).toInt()
          : 0,
      minSdk: (map['minSdk'] is num) ? (map['minSdk'] as num).toInt() : 0,
      targetSdk: (map['targetSdk'] is num) ? (map['targetSdk'] as num).toInt() : 0,
      permissions: permissions,
    );
  }
}

/// 应用管理入口。
abstract final class AppManager {
  /// 列出已安装应用。
  static Future<List<ManagedApp>> list({
    String query = '',
    bool onlySystem = false,
    bool onlyUser = false,
  }) async {
    final raw = await DeviceControl.getInstalledPackages();
    final apps = <ManagedApp>[];
    for (final item in raw) {
      final pkg = (item['package'] ?? '').toString();
      if (pkg.isEmpty) continue;
      final isSystem = item['isSystem'] == true;
      if (onlySystem && !isSystem) continue;
      if (onlyUser && isSystem) continue;
      final app = ManagedApp(
        pkg: pkg,
        label: (item['label'] ?? '').toString(),
        versionName: (item['versionName'] ?? '').toString(),
        isSystem: isSystem,
      );
      if (query.isNotEmpty &&
          !app.pkg.toLowerCase().contains(query.toLowerCase()) &&
          !app.displayName.toLowerCase().contains(query.toLowerCase())) {
        continue;
      }
      apps.add(app);
    }
    apps.sort((ManagedApp a, ManagedApp b) {
      if (a.isSystem != b.isSystem) return a.isSystem ? 1 : -1;
      return a.displayName.compareTo(b.displayName);
    });
    return apps;
  }

  /// 卸载应用。
  static Future<AppActionResult> uninstall(String pkg) async {
    final result = await DeviceControl.execShellElevated('pm uninstall $pkg');
    if (!result.success) {
      return AppActionResult(false, result.stderr.trim().isEmpty
          ? '卸载失败'
          : result.stderr.trim());
    }
    final output = '${result.stdout}\n${result.stderr}';
    if (output.contains('Failure')) {
      return AppActionResult(false, output.trim());
    }
    return const AppActionResult(true, '已卸载');
  }

  /// 冻结（禁用）应用。
  static Future<AppActionResult> disable(String pkg) async {
    final result =
        await DeviceControl.execShellElevated('pm disable-user --user 0 $pkg');
    if (!result.success) {
      return AppActionResult(false, result.stderr.trim().isEmpty
          ? '冻结失败'
          : result.stderr.trim());
    }
    final output = '${result.stdout}\n${result.stderr}';
    if (output.contains('Error') || output.contains('Exception')) {
      return AppActionResult(false, output.trim());
    }
    return const AppActionResult(true, '已冻结');
  }

  /// 解冻（启用）应用。
  static Future<AppActionResult> enable(String pkg) async {
    final result = await DeviceControl.execShellElevated('pm enable $pkg');
    if (!result.success) {
      return AppActionResult(false, result.stderr.trim().isEmpty
          ? '启用失败'
          : result.stderr.trim());
    }
    return const AppActionResult(true, '已启用');
  }

  /// 启动应用。
  static Future<AppActionResult> launch(String pkg) async {
    final ok = await DeviceControl.openApp(pkg);
    return AppActionResult(ok, ok ? '已启动' : '启动失败：$pkg');
  }

  /// 提取应用信息（dumpsys package）。
  static Future<String> dumpInfo(String pkg) async {
    final result = await DeviceControl.execShellElevated(
      'dumpsys package $pkg',
      timeoutSeconds: 20,
    );
    final text = result.stdout.trim();
    return text.isEmpty ? result.stderr.trim() : text;
  }

  /// 解析 APK 归档，取出包名与版本信息。
  ///
  /// 长按 APK 时的「卸载 / 冻结 / 禁用 / 提取信息」四个选项都需要包名，
  /// 而包名只能从归档清单里读——所以这一步走原生。
  static Future<ApkInfo?> readApk(String path) async {
    final result = await VfsChannel.call('apkInfo', <String, dynamic>{
      'path': path,
    });
    if (result['ok'] != true) return null;
    final info = result['info'];
    if (info is! Map) return null;
    return ApkInfo.fromMap(
      info.map((Object? key, Object? value) =>
          MapEntry<String, dynamic>(key.toString(), value)),
    );
  }
}
