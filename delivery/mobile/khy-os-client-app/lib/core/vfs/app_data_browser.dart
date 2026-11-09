// 应用数据浏览器：把应用私有目录里的常见配置解析成结构化视图。
//
// 为什么要「结构化」而不是直接给二进制：用户打开别人的 SharedPreferences 或
// SQLite 库，真正想看的是「有哪些键、值是什么」，而不是一坨 XML/DB 文件。
// 直接丢二进制给用户，等于给了个文件管理器（那是 VFS 已经做到的），不是这一层。
//
// 解析放在 Dart 侧而不是原生侧：SharedPreferences 是 XML、JSON 是 JSON，
// 两者都是文本，用 Dart 正则/JSON 解析更短也更可测；只有 SQLite 需要真库，
// 那部分走 sqflite（先复制一份再只读打开，避免和应用正在运行的实例抢锁）。
//
// 权限现实：私有目录要 Shizuku。没激活时这一页显示灰色占位符 + 引导，
// 不是报错。

import 'dart:convert';

import 'package:meta/meta.dart';

import 'vfs_node.dart';
import 'vfs_route.dart';
import 'vfs_service.dart';

/// 私有目录里常见文件的种类。
enum AppDataKind {
  /// SharedPreferences 的 XML。
  sharedPreferences,

  /// JSON 配置。
  json,

  /// SQLite 数据库。
  sqlite,

  /// 其它文本。
  text,

  /// 二进制。
  binary,

  /// 目录。
  directory;

  String get label {
    switch (this) {
      case AppDataKind.sharedPreferences:
        return '偏好配置';
      case AppDataKind.json:
        return 'JSON 配置';
      case AppDataKind.sqlite:
        return '数据库';
      case AppDataKind.text:
        return '文本';
      case AppDataKind.binary:
        return '二进制';
      case AppDataKind.directory:
        return '目录';
    }
  }
}

/// 一个配置项。
@immutable
class ConfigEntry {
  /// 键（JSON 里是展开后的路径，如 `server.url`）。
  final String key;

  /// 值（统一转成字符串展示）。
  final String value;

  /// 值的类型。
  final String type;

  const ConfigEntry({
    required this.key,
    required this.value,
    this.type = 'string',
  });
}

/// 应用数据浏览入口。
abstract final class AppDataBrowser {
  /// 列出设备上的应用包（私有目录的上一层）。
  static Future<List<VfsNode>> listPackages() async {
    final listing = await VfsService.instance.list('/data/data');
    return listing.nodes.where((VfsNode node) => node.isDirectory).toList();
  }

  /// 列出某个包的私有目录内容（第一层）。
  static Future<List<VfsNode>> listAppFiles(String pkg) async {
    final listing = await VfsService.instance.list('/data/data/$pkg');
    return listing.nodes;
  }

  /// 判断一个条目的种类。
  ///
  /// 判据看**路径与扩展名**两处：SharedPreferences 只在 `shared_prefs/` 下且是 .xml；
  /// SQLite 在 `databases/` 下且是 .db/.sqlite/.sqlite3。
  static AppDataKind classify(VfsNode node, String pkg) {
    if (node.isDirectory) return AppDataKind.directory;
    final path = node.path.toLowerCase();
    final name = node.name.toLowerCase();
    if (path.contains('/shared_prefs/') && name.endsWith('.xml')) {
      return AppDataKind.sharedPreferences;
    }
    if (path.contains('/databases/') &&
        (name.endsWith('.db') ||
            name.endsWith('.sqlite') ||
            name.endsWith('.sqlite3'))) {
      return AppDataKind.sqlite;
    }
    if (name.endsWith('.json')) return AppDataKind.json;
    if (node.mime.startsWith('text/')) return AppDataKind.text;
    return AppDataKind.binary;
  }

  /// 解析 SharedPreferences 的 XML。
  ///
  /// 格式固定：`<map>` 里放 `<string name="k">v</string>`、`<int name="k" value="1" />`、
  /// `<boolean name="k" value="true" />`、`<set name="k"><string>…</string></set>` 这些。
  /// 用正则而不是 XML 解析器，是因为本仓不引 XML 依赖，而这个格式足够规整——
  /// 规整到能写死正则，就不值得为它加一个依赖。
  static List<ConfigEntry> parseSharedPreferences(String xml) {
    final entries = <ConfigEntry>[];
    var working = xml;

    // 集合先摘出来：它的内部也是 <string>，留在原地会被当成顶层条目解析。
    final sets = <String, List<String>>{};
    working = working.replaceAllMapped(
      RegExp(r'<set\s+name="([^"]*)"[^>]*>([\s\S]*?)</set>'),
      (Match match) {
        final values = RegExp(r'<string>([\s\S]*?)</string>')
            .allMatches(match.group(2) ?? '')
            .map((Match m) => m.group(1) ?? '')
            .toList();
        sets[match.group(1) ?? ''] = values;
        return '';
      },
    );

    final scalar = RegExp(
      r'<(string|int|long|float|boolean)\s+name="([^"]*)"'
      r'(?:\s+value="([^"]*)")?\s*(?:/>|>([\s\S]*?)</\1>)',
    );
    for (final match in scalar.allMatches(working)) {
      final type = match.group(1) ?? 'string';
      final key = match.group(2) ?? '';
      final attribute = match.group(3);
      final inner = match.group(4);
      final value = attribute ?? (inner ?? '').trim();
      entries.add(ConfigEntry(key: key, value: value, type: type));
    }

    for (final entry in sets.entries) {
      entries.add(ConfigEntry(
        key: entry.key,
        value: entry.value.join(', '),
        type: 'set',
      ));
    }

    entries.sort((ConfigEntry a, ConfigEntry b) => a.key.compareTo(b.key));
    return entries;
  }

  /// 解析 JSON 配置，展平成键值列表。
  ///
  /// 嵌套对象用点号展开（`server.url`），数组用下标（`tags[0]`）——
  /// 展平之后才能放进一张表里看，比嵌套树更适合「查一个键在哪」。
  static List<ConfigEntry> parseJsonConfig(String text) {
    final entries = <ConfigEntry>[];
    try {
      final decoded = jsonDecode(text);
      _flatten(decoded, '', entries);
    } catch (_) {
      // 不是合法 JSON：交给调用方当文本处理，不要在这里假装解析成功。
    }
    entries.sort((ConfigEntry a, ConfigEntry b) => a.key.compareTo(b.key));
    return entries;
  }

  static void _flatten(Object? value, String prefix, List<ConfigEntry> out) {
    if (value is Map) {
      for (final entry in value.entries) {
        final key = prefix.isEmpty
            ? entry.key.toString()
            : '$prefix.${entry.key}';
        _flatten(entry.value, key, out);
      }
      return;
    }
    if (value is List) {
      for (var i = 0; i < value.length; i++) {
        _flatten(value[i], '$prefix[$i]', out);
      }
      return;
    }
    out.add(ConfigEntry(
      key: prefix.isEmpty ? '(根)' : prefix,
      value: value?.toString() ?? 'null',
      type: value == null ? 'null' : value.runtimeType.toString(),
    ));
  }

  /// 把私有目录里的文件复制到公共存储（导出）。
  ///
  /// 这一步是**跨权限操作**（私有目录 → 公共存储），所以它需要 Shizuku，
  /// 而且要用户明确确认目标位置。审计日志会记下这一条。
  static Future<String> exportTo(
    String sourcePath,
    String targetDir, {
    String name = '',
  }) async {
    final target = name.isEmpty
        ? VfsPath.join(targetDir, VfsPath.basename(sourcePath))
        : VfsPath.join(targetDir, name);
    await VfsService.instance.copy(sourcePath, target);
    return target;
  }
}
