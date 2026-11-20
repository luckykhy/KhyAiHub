// 应用管理：文件管理器里的「系统管理」能力。
//
// 这一层刻意放在 Dart 侧而不是原生侧：卸载、冻结、启用的命令都是 `pm` 系列，
// 而 `DeviceControl.execShellElevated` 已经封装了「优先走 提权代理、退回普通 shell」
// 这件事。在 Dart 侧复用它，就不用在原生侧再写一遍同样的降级逻辑——
// 而降级逻辑写两遍必然会漂移。
//
// 权限现实要说清楚：`pm uninstall` / `pm disable-user` 需要 shell 权限。
// 普通 shell（App 自己的 uid）会被系统拒绝，提权代理（adb shell）才行。
// 所以这些操作在没激活 提权代理 时**必然失败**，界面要如实说，而不是假装成功。

import '../services/audit_log.dart';
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

  /// 失败且原因是权限不足——界面要引导去激活 提权代理，而不是显示「未知错误」。
  bool get needsPrivilege =>
      !ok && (message.contains('Permission Denial') || message.contains('提权代理'));
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
  /// 普通应用拿不到），拿不到就不能假装有。安装包体积一次 PackageManager 就能
  /// 全部拿到，而且对「精简」这个诉求更直接——占空间大的预装包就是该考虑的对象。
  ///
  /// 体积从原生 VFS 通道拿（PackageManager 知道 base APK 的路径与长度），
  /// **不走 shell**：原来的做法是一段 `for` 循环脚本跑 `pm path` + `stat`，
  /// 而那段脚本含 `;` `|` `$(` 与换行，会被原生那道「控制符一律拒」的闸门整体
  /// 挡回来——于是「按体积排序」从来没真正生效过，一直悄悄退化成「按名称排序」
  /// （§9.24）。
  static Future<List<ManagedAppSize>> listSystemAppsBySize() async {
    final packages = await list(onlySystem: true);
    final sizes = await apkSizes();

    final sized = <ManagedAppSize>[];
    for (final app in packages) {
      // 拿不到体积就是拿不到（0），但**这个应用仍然要出现在列表里**——
      // 少了它就等于「体积读不到的应用从精简清单里消失了」。
      sized.add(ManagedAppSize(app: app, apkBytes: sizes[app.pkg] ?? 0));
    }
    // 体积降序；体积一样时按名称排——Dart 的 sort **不稳定**，不给一个确定的
    // 次序键，每次刷新的顺序都可能不一样，看着就像列表在乱跳。
    sized.sort((ManagedAppSize a, ManagedAppSize b) {
      final bySize = b.apkBytes.compareTo(a.apkBytes);
      if (bySize != 0) return bySize;
      return a.app.displayName.compareTo(b.app.displayName);
    });
    return sized;
  }

  /// 包名 → 安装包字节数。
  ///
  /// 走 VFS 通道的 `packages` 操作：原生侧用 PackageManager 取 base APK 长度。
  /// 拿不到就返回空表——调用方据此让所有体积都记 0，而不是显示一排 0 字节。
  static Future<Map<String, int>> apkSizes() async {
    final result = await VfsChannel.call('packages');
    final raw = result['packages'];
    if (raw is! List) return <String, int>{};
    final sizes = <String, int>{};
    for (final item in raw) {
      if (item is! Map) continue;
      final pkg = (item['pkg'] ?? '').toString();
      if (pkg.isEmpty) continue;
      final bytes =
          (item['sizeBytes'] is num) ? (item['sizeBytes'] as num).toInt() : 0;
      if (bytes > 0) sizes[pkg] = bytes;
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
  ///
  /// 走 VFS 通道的 `appUninstall` 操作，**不走 shell 命令串**：原生那道闸门
  /// （`MainActivity.SHELL_ALLOW`）是 AI 与设备控制用的前缀白名单，里面只有
  /// `pm list packages` / `pm path ` / `pm dump `，**没有** `pm uninstall`——
  /// 从那条通道发出去必然被自己的闸门挡回来（§9.24）。
  ///
  /// 搬过来还顺带解决了两件事：包名在原生侧过了严格校验才拼进命令行（不再靠
  /// Dart 侧拼字符串），失败语义由原生按 `pm` 的词表翻译成机器码。
  static Future<AppActionResult> uninstall(String pkg) async {
    final result = await VfsChannel.call(
      'appUninstall',
      <String, dynamic>{'pkg': pkg},
    );
    return _actionResult(result, '卸载', '已卸载');
  }

  /// 冻结（禁用）应用。
  static Future<AppActionResult> disable(String pkg) async {
    final result = await VfsChannel.call(
      'appDisable',
      <String, dynamic>{'pkg': pkg},
    );
    return _actionResult(result, '冻结', '已冻结');
  }

  /// 解冻（启用）应用。
  static Future<AppActionResult> enable(String pkg) async {
    final result = await VfsChannel.call(
      'appEnable',
      <String, dynamic>{'pkg': pkg},
    );
    return _actionResult(result, '启用', '已启用');
  }

  /// 把 VFS 通道的答复归一成 [AppActionResult]。
  ///
  /// 失败时**带上原因**：只说「卸载失败」等于让用户猜。原生侧给的是机器码 +
  /// 人话（「应用未安装」/「权限不足（需要 提权代理 授权）」/「提权代理 未激活」），
  /// 这里原样透出——[AppActionResult.needsPrivilege] 认的就是其中的「提权代理」。
  static AppActionResult _actionResult(
    Map<String, dynamic> result,
    String verb,
    String successMessage,
  ) {
    if (result['ok'] == true) return AppActionResult(true, successMessage);
    final code = (result['error'] ?? 'unknown').toString();
    final message = (result['message'] ?? '').toString().trim();
    return AppActionResult(
      false,
      message.isEmpty ? '$verb失败（$code）' : message,
    );
  }

  /// 启动应用。
  static Future<AppActionResult> launch(String pkg) async {
    final ok = await DeviceControl.openApp(pkg);
    return AppActionResult(ok, ok ? '已启动' : '启动失败：$pkg');
  }

  /// 提取应用信息（dumpsys package）。
  ///
  /// [source] 传 [AuditSource.user]：这一下是用户在「系统应用管理」面板里点的，
  /// 不是 AI 干的。操作日志要能分清这两者——把用户自己点的记成「AI 建议」，
  /// 日志就成了对用户的诬告，比不记更糟。
  static Future<String> dumpInfo(String pkg) async {
    final result = await DeviceControl.execShellElevated(
      'dumpsys package $pkg',
      source: AuditSource.user,
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
