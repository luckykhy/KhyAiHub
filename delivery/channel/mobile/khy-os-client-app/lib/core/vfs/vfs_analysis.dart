// 存储占用分析。
//
// 专业用户最常问的一个问题是「我的空间被什么占了」。这个答案要按维度给：
// 按类型（图片/视频/文档/安装包…）、按目录（哪个文件夹最大）、按时间（哪个月涨得多）、
// 以及最大的若干个文件。只给一个总数没有用——用户要的是「下一步该清什么」。
//
// 扫描有上限（条目数与深度），超出会被截断并如实说明：宁可说「只扫到前 20000 项」，
// 也不要给一个看起来完整其实漏了一半的统计。

import 'vfs_channel.dart';

/// 一类文件的占用。
class StorageTypeStat {
  final String type;
  final int bytes;
  final int count;

  const StorageTypeStat({
    required this.type,
    required this.bytes,
    required this.count,
  });

  factory StorageTypeStat.fromMap(Map<String, dynamic> map) => StorageTypeStat(
        type: (map['type'] ?? '').toString(),
        bytes: (map['bytes'] as num?)?.toInt() ?? 0,
        count: (map['count'] as num?)?.toInt() ?? 0,
      );
}

/// 一个目录的占用。
class StorageFolderStat {
  final String path;
  final int bytes;

  const StorageFolderStat({required this.path, required this.bytes});

  factory StorageFolderStat.fromMap(Map<String, dynamic> map) =>
      StorageFolderStat(
        path: (map['path'] ?? '').toString(),
        bytes: (map['bytes'] as num?)?.toInt() ?? 0,
      );
}

/// 一个文件的占用。
class StorageFileStat {
  final String path;
  final int bytes;

  const StorageFileStat({required this.path, required this.bytes});

  factory StorageFileStat.fromMap(Map<String, dynamic> map) => StorageFileStat(
        path: (map['path'] ?? '').toString(),
        bytes: (map['bytes'] as num?)?.toInt() ?? 0,
      );
}

/// 一个月的占用。
class StorageMonthStat {
  final String month;
  final int bytes;

  const StorageMonthStat({required this.month, required this.bytes});

  factory StorageMonthStat.fromMap(Map<String, dynamic> map) => StorageMonthStat(
        month: (map['month'] ?? '').toString(),
        bytes: (map['bytes'] as num?)?.toInt() ?? 0,
      );
}

/// 一次分析的结果。
class StorageAnalysis {
  final int totalBytes;
  final int fileCount;
  final int dirCount;
  final List<StorageTypeStat> byType;
  final List<StorageFolderStat> byFolder;
  final List<StorageFileStat> largest;
  final List<StorageMonthStat> byMonth;

  /// 扫描被截断时的说明（为空表示扫完了）。
  final String notice;

  const StorageAnalysis({
    this.totalBytes = 0,
    this.fileCount = 0,
    this.dirCount = 0,
    this.byType = const <StorageTypeStat>[],
    this.byFolder = const <StorageFolderStat>[],
    this.largest = const <StorageFileStat>[],
    this.byMonth = const <StorageMonthStat>[],
    this.notice = '',
  });

  factory StorageAnalysis.fromMap(Map<String, dynamic> map) {
    List<T> parse<T>(
      Object? raw,
      T Function(Map<String, dynamic>) build,
    ) {
      if (raw is! List) return <T>[];
      final items = <T>[];
      for (final item in raw) {
        if (item is Map) {
          items.add(build(
            item.map((Object? key, Object? value) =>
                MapEntry<String, dynamic>(key.toString(), value)),
          ));
        }
      }
      return items;
    }

    return StorageAnalysis(
      totalBytes: (map['totalBytes'] as num?)?.toInt() ?? 0,
      fileCount: (map['fileCount'] as num?)?.toInt() ?? 0,
      dirCount: (map['dirCount'] as num?)?.toInt() ?? 0,
      byType: parse<StorageTypeStat>(
        map['byType'],
        StorageTypeStat.fromMap,
      ),
      byFolder: parse<StorageFolderStat>(
        map['byFolder'],
        StorageFolderStat.fromMap,
      ),
      largest: parse<StorageFileStat>(map['largest'], StorageFileStat.fromMap),
      byMonth: parse<StorageMonthStat>(map['byMonth'], StorageMonthStat.fromMap),
      // 原生侧用 `message` 说明「扫描被截断」；`notice` 是本仓 Dart 侧的旧叫法，
      // 两个都读是为了让「有说明」这件事不因为字段名对不上而丢掉。
      notice: (map['message'] ?? map['notice'] ?? '').toString(),
    );
  }

  /// 可读的总量。
  String get readableTotal {
    if (totalBytes < 1024) return '$totalBytes B';
    const units = <String>['KB', 'MB', 'GB', 'TB'];
    var value = totalBytes / 1024;
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return '${value.toStringAsFixed(value >= 100 ? 0 : 1)} ${units[unit]}';
  }

  /// 某一类占总量的比例（0~1），用于画条。
  double ratioOf(int bytes) => totalBytes <= 0 ? 0 : bytes / totalBytes;
}

/// 分析入口。
abstract final class VfsAnalysis {
  /// 分析一个目录的占用。
  static Future<StorageAnalysis> analyze(
    String path, {
    int maxDepth = 6,
  }) async {
    final result = await VfsChannel.call('analyze', <String, dynamic>{
      'path': path,
      'maxDepth': maxDepth,
    });
    if (result['ok'] != true) {
      return StorageAnalysis(
        notice: (result['message'] ?? '分析失败').toString(),
      );
    }
    return StorageAnalysis.fromMap(result);
  }
}
