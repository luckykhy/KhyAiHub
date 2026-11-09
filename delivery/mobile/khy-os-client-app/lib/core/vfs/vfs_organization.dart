// 书签、最近访问与标签。
//
// 这一组是「组织功能」——专业文件管理器里最被低估的能力。用户真正会反复回来的
// 不是目录树上的某个固定位置，而是「昨天那个项目目录」「装包的那个下载目录」。
// 没有书签，用户每次都要重新点进去。
//
// 标签比书签多一层：书签是路径，标签是**跨路径的归类**（比如把散在 Download 与
// Documents 里的同一个项目的文件都打上「项目A」标签）。本轮标签先落数据模型与
// 读写接口，界面上的标签视图随存储分析一起做。
//
// 落盘位置一律经 path_provider 解析，不写 cwd 相对路径。

import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

/// 一个书签。
class VfsBookmark {
  final String path;
  final String name;
  final DateTime createdAt;

  const VfsBookmark({
    required this.path,
    required this.name,
    required this.createdAt,
  });

  Map<String, dynamic> toJson() => <String, dynamic>{
        'path': path,
        'name': name,
        'createdAt': createdAt.millisecondsSinceEpoch,
      };

  factory VfsBookmark.fromJson(Map<String, dynamic> json) => VfsBookmark(
        path: (json['path'] ?? '').toString(),
        name: (json['name'] ?? '').toString(),
        createdAt: DateTime.fromMillisecondsSinceEpoch(
          (json['createdAt'] as num?)?.toInt() ?? 0,
        ),
      );
}

/// 一条最近访问记录。
class VfsHistoryEntry {
  final String path;
  final DateTime visitedAt;

  const VfsHistoryEntry({required this.path, required this.visitedAt});

  Map<String, dynamic> toJson() => <String, dynamic>{
        'path': path,
        'visitedAt': visitedAt.millisecondsSinceEpoch,
      };

  factory VfsHistoryEntry.fromJson(Map<String, dynamic> json) => VfsHistoryEntry(
        path: (json['path'] ?? '').toString(),
        visitedAt: DateTime.fromMillisecondsSinceEpoch(
          (json['visitedAt'] as num?)?.toInt() ?? 0,
        ),
      );
}

/// 一个标签（跨路径的归类）。
class VfsTag {
  final String name;
  final String color;

  /// 被打上这个标签的路径。
  final List<String> paths;

  const VfsTag({
    required this.name,
    this.color = '',
    this.paths = const <String>[],
  });

  Map<String, dynamic> toJson() => <String, dynamic>{
        'name': name,
        'color': color,
        'paths': paths,
      };

  factory VfsTag.fromJson(Map<String, dynamic> json) {
    final raw = json['paths'];
    final paths = <String>[];
    if (raw is List) {
      for (final item in raw) {
        final text = item?.toString() ?? '';
        if (text.isNotEmpty) paths.add(text);
      }
    }
    return VfsTag(
      name: (json['name'] ?? '').toString(),
      color: (json['color'] ?? '').toString(),
      paths: paths,
    );
  }
}

/// 书签 / 历史 / 标签的存储。
abstract final class VfsOrganizationStore {
  /// 最近访问最多留多少条。
  static const int maxHistory = 50;

  static File? _bookmarksFile;

  // ---------------- 书签 ----------------

  static Future<List<VfsBookmark>> loadBookmarks() async {
    final items = await _readJson('bookmarks.json');
    return items
        .whereType<Map<String, dynamic>>()
        .map(VfsBookmark.fromJson)
        .where((VfsBookmark b) => b.path.isNotEmpty)
        .toList();
  }

  static Future<void> addBookmark(String path, String name) async {
    if (path.isEmpty) return;
    final bookmarks = await loadBookmarks();
    bookmarks.removeWhere((VfsBookmark b) => b.path == path);
    bookmarks.insert(
      0,
      VfsBookmark(path: path, name: name, createdAt: DateTime.now()),
    );
    await _writeJson('bookmarks.json', bookmarks
        .map((VfsBookmark b) => b.toJson())
        .toList(growable: false));
  }

  static Future<void> removeBookmark(String path) async {
    final bookmarks = await loadBookmarks()
      ..removeWhere((VfsBookmark b) => b.path == path);
    await _writeJson('bookmarks.json', bookmarks
        .map((VfsBookmark b) => b.toJson())
        .toList(growable: false));
  }

  // ---------------- 最近访问 ----------------

  static Future<List<VfsHistoryEntry>> loadHistory() async {
    final items = await _readJson('history.json');
    final entries = items
        .whereType<Map<String, dynamic>>()
        .map(VfsHistoryEntry.fromJson)
        .where((VfsHistoryEntry e) => e.path.isNotEmpty)
        .toList();
    entries.sort((VfsHistoryEntry a, VfsHistoryEntry b) =>
        b.visitedAt.compareTo(a.visitedAt));
    return entries;
  }

  /// 记一次访问。重复访问只更新时间，不重复占位。
  static Future<void> recordVisit(String path) async {
    if (path.isEmpty || path == '/') return;
    final entries = await loadHistory()
      ..removeWhere((VfsHistoryEntry e) => e.path == path);
    entries.insert(0, VfsHistoryEntry(path: path, visitedAt: DateTime.now()));
    if (entries.length > maxHistory) {
      entries.removeRange(maxHistory, entries.length);
    }
    await _writeJson('history.json', entries
        .map((VfsHistoryEntry e) => e.toJson())
        .toList(growable: false));
  }

  static Future<void> clearHistory() async {
    await _writeJson('history.json', const <Map<String, dynamic>>[]);
  }

  // ---------------- 标签 ----------------

  static Future<List<VfsTag>> loadTags() async {
    final items = await _readJson('tags.json');
    return items
        .whereType<Map<String, dynamic>>()
        .map(VfsTag.fromJson)
        .where((VfsTag t) => t.name.isNotEmpty)
        .toList();
  }

  /// 给一个路径打标签。同名标签合并，不覆盖已有路径。
  static Future<void> tagPath(String tagName, String path) async {
    if (tagName.isEmpty || path.isEmpty) return;
    final tags = await loadTags();
    final existing = tags.where((VfsTag t) => t.name == tagName).toList();
    if (existing.isEmpty) {
      tags.add(VfsTag(name: tagName, paths: <String>[path]));
    } else {
      final target = existing.first;
      final paths = List<String>.of(target.paths);
      if (!paths.contains(path)) paths.add(path);
      tags.remove(existing.first);
      tags.add(VfsTag(name: target.name, color: target.color, paths: paths));
    }
    await _writeJson(
      'tags.json',
      tags.map((VfsTag t) => t.toJson()).toList(growable: false),
    );
  }

  static Future<void> removeTag(String tagName) async {
    final tags = await loadTags()
      ..removeWhere((VfsTag t) => t.name == tagName);
    await _writeJson(
      'tags.json',
      tags.map((VfsTag t) => t.toJson()).toList(growable: false),
    );
  }

  // ---------------- 落盘 ----------------

  static Future<List<dynamic>> _readJson(String name) async {
    try {
      final file = await _resolve(name);
      if (!await file.exists()) return const <dynamic>[];
      final raw = await file.readAsString();
      if (raw.trim().isEmpty) return const <dynamic>[];
      final decoded = jsonDecode(raw);
      return decoded is List ? decoded : const <dynamic>[];
    } catch (_) {
      return const <dynamic>[];
    }
  }

  static Future<void> _writeJson(String name, List<dynamic> items) async {
    try {
      final file = await _resolve(name);
      await file.writeAsString(jsonEncode(items), flush: true);
    } catch (_) {
      // 写不进去不该阻断用户在做的正事——书签丢一条，下次再点一次就有了。
    }
  }

  static Future<File> _resolve(String name) async {
    final cached = _bookmarksFile;
    if (cached != null && name == 'bookmarks.json') return cached;
    final support = await getApplicationSupportDirectory();
    final dir = Directory(p.join(support.path, 'vfs'));
    if (!await dir.exists()) await dir.create(recursive: true);
    final file = File(p.join(dir.path, name));
    if (name == 'bookmarks.json') _bookmarksFile = file;
    return file;
  }
}
