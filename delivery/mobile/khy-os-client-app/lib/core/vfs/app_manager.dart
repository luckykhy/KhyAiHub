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

/// 一个系统应用及其安装包体积。
class ManagedAppSize {
  final ManagedApp app;

  /// 安装包字节数；拿不到时为 0。
  final int apkBytes;

  const ManagedAppSize({required this.app, this.apkBytes = 0});
}

/// 应用管理入口。
abstract final class AppManager {
  /// 列出系统应用，并按**安装包体积**排序。
  ///
  /// 为什么按体积而不是「使用频率」：使用频率要 Usage Access 权限（系统级权限，
  /// 普通应用拿不到），拿不到就不能假装有。安装包体积一次 shell 就能全部拿到，
  /// 而且对「精简」这个诉求更直接——占空间大的预装包就是该考虑的对象。
  ///
  /// 体积靠一次 shell 拿到（循环 pm path + stat），不逐个 App 起进程。
  static Future<List<ManagedAppSize>> listSystemAppsBySize() async {
    final packages = await list(onlySystem: true);
    final byPkg = <String, ManagedApp>{
      for (final app in packages) app.pkg: app,
    };

    const script = r'''
for p in $(pm list packages -s 2>/dev/null | cut -d: -f2); do
  ap=$(pm path "$p" 2>/dev/null | head -1 | cut -d: -f2)
  if [ -n "$ap" ]; then
    s=$(stat -c %s "$ap" 2>/dev/null || echo 0)
    echo "$p|$s"
  else
    echo "$p|0"
  fi
done
''';

    final result = await DeviceControl.execShellElevated(
      script,
      timeoutSeconds: 60,
    );
    final sizes = parseSizeOutput(result.stdout);
    if (sizes.isEmpty) {
      // shell 不可用（没有 Shizuku）：退回按名称排序，体积拿不到就是拿不到。
      return packages
          .map((ManagedApp app) => ManagedAppSize(app: app))
          .toList();
    }

    final sized = <ManagedAppSize>[];
    for (final entry in sizes.entries) {
      final app = byPkg[entry.key];
      if (app == null) continue;
      sized.add(ManagedAppSize(app: app, apkBytes: entry.value));
    }
    sized.sort((ManagedAppSize a, ManagedAppSize b) =>
        b.apkBytes.compareTo(a.apkBytes));
    return sized;
  }

  /// 解析 `包名|字节数` 的多行输出。
  ///
  /// 单独抽出来是为了能测：这段解析错了会让「按体积排序」变成随机序，
  /// 而随机序的界面看着还挺像正常的。
  static Map<String, int> parseSizeOutput(String stdout) {
    final sizes = <String, int>{};
    for (final line in stdout.split('\n')) {
      final trimmed = line.trim();
      if (trimmed.isEmpty) continue;
      final parts = trimmed.split('|');
      if (parts.length < 2) continue;
      final pkg = parts[0].trim();
      if (pkg.isEmpty) continue;
      // 字节数解析不出来就跳过整行：把「x|y」当成包名 x、体积 0 收进来，
      // 会让清单里多出一个不存在的应用——比少一行更糟。
      final bytes = int.tryParse(parts[1].trim());
      if (bytes == null) continue;
      sizes[pkg] = bytes;
    }
    return sizes;
  }

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
