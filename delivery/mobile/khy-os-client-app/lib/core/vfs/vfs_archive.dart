// 归档（压缩包）的浏览、提取与创建。
//
// 格式边界说在前面：**只支持 ZIP 与 TAR.GZ**。RAR / 7Z 不做——
// 没有第三方库硬解它们，而引入 zip4j / commons-compress 意味着给 APK 增重
// （本仓对依赖体积有守卫）。遇到 .rar / .7z 时如实说「当前版本只支持 ZIP 与 TAR.GZ」，
// 好过给一个点了报错的按钮。
//
// 安全边界：解包由原生侧做 Zip Slip 防护与压缩炸弹上限；Dart 侧只负责
// 「把用户的意图说清楚」——哪些条目要解开、解到哪。

import 'package:meta/meta.dart';

import 'vfs_channel.dart';
import 'vfs_service.dart';

/// 归档内的一个条目。
@immutable
class ArchiveEntry {
  /// 归档内的相对路径（如 `docs/a.txt`）。
  final String name;

  final bool isDirectory;
  final int size;
  final int compressedSize;
  final int modifiedMs;
  final String mode;
  final String mime;

  const ArchiveEntry({
    required this.name,
    required this.isDirectory,
    this.size = 0,
    this.compressedSize = 0,
    this.modifiedMs = 0,
    this.mode = '',
    this.mime = 'application/octet-stream',
  });

  factory ArchiveEntry.fromMap(Map<String, dynamic> map) => ArchiveEntry(
        name: (map['name'] ?? '').toString(),
        isDirectory: map['isDirectory'] == true,
        size: _int(map['size']),
        compressedSize: _int(map['compressedSize']),
        modifiedMs: _int(map['modifiedMs']),
        mode: (map['mode'] ?? '').toString(),
        mime: (map['mime'] ?? 'application/octet-stream').toString(),
      );

  static int _int(Object? value) {
    if (value is num) return value.toInt();
    if (value is String) return int.tryParse(value) ?? 0;
    return 0;
  }

  /// 可读大小。
  String get readableSize {
    if (isDirectory) return '';
    if (size < 1024) return '$size B';
    const units = <String>['KB', 'MB', 'GB'];
    var value = size / 1024;
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return '${value.toStringAsFixed(value >= 100 ? 0 : 1)} ${units[unit]}';
  }
}

/// 归档列表。
class ArchiveListing {
  final String format;
  final List<ArchiveEntry> entries;

  const ArchiveListing({required this.format, this.entries = const <ArchiveEntry>[]});

  /// 目录优先、再按名称。
  List<ArchiveEntry> get sorted {
    final items = List<ArchiveEntry>.of(entries);
    items.sort((ArchiveEntry a, ArchiveEntry b) {
      if (a.isDirectory != b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.toLowerCase().compareTo(b.name.toLowerCase());
    });
    return items;
  }

  int get totalBytes => entries.fold<int>(0, (int sum, ArchiveEntry e) => sum + e.size);
}

/// 提取结果。
class ArchiveExtractResult {
  /// 实际写出的路径（虚拟路径）。
  final List<String> paths;

  /// 原生侧的说明：跳过了几个（已存在 / 越界 / 超限）。
  ///
  /// **成功也可能带说明**——「解开了 8 个，跳过 2 个已存在」是成功，不是失败。
  /// 只报成功数会让用户以为包解全了。
  final String message;

  const ArchiveExtractResult({this.paths = const <String>[], this.message = ''});

  int get count => paths.length;
}

/// 归档操作入口。
abstract final class VfsArchive {
  /// 这个路径是不是归档文件。
  static bool isArchivePath(String path) {
    final lower = path.toLowerCase();
    return lower.endsWith('.zip') ||
        lower.endsWith('.tar.gz') ||
        lower.endsWith('.tgz');
  }

  /// 列出归档内容。失败返回 null（原因由调用方另行提示）。
  static Future<ArchiveListing?> list(String path) async {
    final result = await VfsChannel.call('archiveList', <String, dynamic>{
      'path': path,
    });
    if (result['ok'] != true) return null;
    final raw = result['entries'];
    final entries = <ArchiveEntry>[];
    if (raw is List) {
      for (final item in raw) {
        if (item is Map) {
          entries.add(ArchiveEntry.fromMap(
            item.map((Object? key, Object? value) =>
                MapEntry<String, dynamic>(key.toString(), value)),
          ));
        }
      }
    }
    return ArchiveListing(
      format: (result['format'] ?? '').toString(),
      entries: entries,
    );
  }

  /// 提取。返回实际写出的路径与原生侧的说明。
  ///
  /// [selected] 为空表示全部解包。
  static Future<ArchiveExtractResult> extract(
    String path,
    String targetDir, {
    List<String> selected = const <String>[],
    bool overwrite = false,
  }) async {
    final result = await VfsChannel.call('archiveExtract', <String, dynamic>{
      'path': path,
      'targetDir': targetDir,
      'selectedNames': selected,
      'overwrite': overwrite,
    });
    if (result['ok'] != true) {
      throw VfsException(
        (result['error'] ?? 'unknown').toString(),
        (result['message'] ?? '解压失败').toString(),
      );
    }
    final raw = result['extracted'];
    final paths = <String>[];
    if (raw is List) {
      for (final item in raw) {
        final text = item?.toString() ?? '';
        if (text.isNotEmpty) paths.add(text);
      }
    }
    return ArchiveExtractResult(
      paths: paths,
      message: (result['message'] ?? '').toString(),
    );
  }

  /// 加密归档的扩展名。
  static const String encryptedExtension = '.khyenc';

  /// 这个路径是不是加密归档。
  static bool isEncryptedPath(String path) =>
      path.toLowerCase().endsWith(encryptedExtension);

  /// 把一个 zip 加密成 `.khyenc`。
  ///
  /// 明文就是完整的 zip 字节流，所以加密包解开后能直接走现有的 zip 浏览/提取，
  /// 不需要第二套解析器。
  static Future<String> encrypt(
    String sourceZipPath,
    String targetPath,
    String password,
  ) async {
    if (password.isEmpty) {
      throw const VfsException('invalid_path', '密码不能为空');
    }
    final result = await VfsChannel.call('archiveEncrypt', <String, dynamic>{
      'sourcePath': sourceZipPath,
      'targetPath': targetPath,
      'password': password,
    });
    if (result['ok'] != true) {
      throw VfsException(
        (result['error'] ?? 'unknown').toString(),
        (result['message'] ?? '加密失败').toString(),
      );
    }
    return (result['path'] ?? targetPath).toString();
  }

  /// 解密 `.khyenc` 得到 zip。
  ///
  /// 密码错与文件损坏都归到 `denied`——对用户来说这两者没法区分，也不必区分。
  static Future<String> decrypt(
    String sourcePath,
    String targetPath,
    String password,
  ) async {
    if (password.isEmpty) {
      throw const VfsException('invalid_path', '密码不能为空');
    }
    final result = await VfsChannel.call('archiveDecrypt', <String, dynamic>{
      'sourcePath': sourcePath,
      'targetPath': targetPath,
      'password': password,
    });
    if (result['ok'] != true) {
      throw VfsException(
        (result['error'] ?? 'unknown').toString(),
        (result['message'] ?? '解密失败').toString(),
      );
    }
    return (result['path'] ?? targetPath).toString();
  }

  /// 创建归档。
  ///
  /// [format] ∈ `zip` / `tar.gz`。目标已存在会失败（由原生侧判 conflict），
  /// 不静默覆盖——覆盖一个已存在的压缩包意味着丢掉用户之前的东西。
  static Future<String> create(
    String targetPath,
    List<String> sourcePaths, {
    String format = 'zip',
  }) async {
    final result = await VfsChannel.call('archiveCreate', <String, dynamic>{
      'targetPath': targetPath,
      'sourcePaths': sourcePaths,
      'format': format,
    });
    if (result['ok'] != true) {
      throw VfsException(
        (result['error'] ?? 'unknown').toString(),
        (result['message'] ?? '压缩失败').toString(),
      );
    }
    return (result['path'] ?? targetPath).toString();
  }
}
