import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;

/// 只读纪律的守卫：镜像这批文件一个都不许碰 Amoo 的写通道。
///
/// 为什么用 import 白名单而不是靠人记得：禁的四个模块（device_control /
/// amoo_driver / amoo_chat_service / amoo_service）每一个都是「向 Amoo 提交
/// 内容或拉起 Amoo」的现成入口。它们不在白名单里，引一个就红——比在 code
/// review 里用肉眼找 import 可靠。
///
/// 文件集合用**发现**而不是写死名单：UI 那三个文件由另一个 owner 落地，路径
/// 万一不在方案写的位置上，写死的名单会静默漏掉它们。发现不到的只有一种情况
/// ——文件还没写，那是进度问题，不是纪律问题。
void main() {
  group('import 归一化', () {
    test('package:khy_os_client/... → lib/ 下的仓库路径', () {
      expect(
        normalizeImport(
          'package:khy_os_client/core/mirror/amoo_mirror_models.dart',
          'lib/core/mirror/amoo_mirror_sync.dart',
        ),
        'lib/core/mirror/amoo_mirror_models.dart',
      );
    });

    test('dart: → dart 标记', () {
      expect(
        normalizeImport('dart:async', 'lib/core/mirror/amoo_mirror_sync.dart'),
        'dart',
      );
    });

    test('第三方包 → 包名（flutter 前缀整族放行）', () {
      expect(
        normalizeImport(
          'package:flutter_riverpod/flutter_riverpod.dart',
          'lib/core/mirror/amoo_mirror_sync.dart',
        ),
        'package:flutter_riverpod',
      );
      expect(
        normalizeImport(
          'package:http/http.dart',
          'lib/core/mirror/amoo_mirror_api.dart',
        ),
        'package:http',
      );
    });

    test('相对 import 按文件所在目录解析', () {
      expect(
        normalizeImport(
          '../gateway/key_pool.dart',
          'lib/core/mirror/amoo_mirror_sync.dart',
        ),
        'lib/core/gateway/key_pool.dart',
      );
      expect(
        normalizeImport(
          'amoo_mirror_api.dart',
          'lib/core/mirror/amoo_mirror_sync.dart',
        ),
        'lib/core/mirror/amoo_mirror_api.dart',
      );
      expect(
        normalizeImport(
          '../db/amoo_mirror_store.dart',
          'lib/core/mirror/amoo_mirror_sync.dart',
        ),
        'lib/core/db/amoo_mirror_store.dart',
      );
    });

    test('tool/ 下的基准：只认 dart: 与 endpoint_defaults', () {
      // mock 服务端跑在 App 目录外（dart run tool/...），它要引用同一个端点
      // 常量，走 package: 形式而不是相对路径——相对路径会把它和 App 的 lib/
      // 目录结构绑死。
      expect(
        normalizeImport(
          'package:khy_os_client/core/config/endpoint_defaults.dart',
          'tool/amoo_mirror_mock_server.dart',
        ),
        'lib/core/config/endpoint_defaults.dart',
      );
      expect(
        normalizeImport('../lib/core/config/endpoint_defaults.dart',
            'tool/amoo_mirror_mock_server.dart'),
        'lib/core/config/endpoint_defaults.dart',
      );
    });

    test('跑出仓库的相对 import 判红', () {
      expect(
        normalizeImport('../../../../etc/passwd',
            'lib/core/mirror/amoo_mirror_sync.dart'),
        isNull,
        reason: '解析结果不在 lib/ 或 tool/ 下就是逃逸',
      );
      expect(
        normalizeImport('foo.dart', 'tool/amoo_mirror_mock_server.dart'),
        'tool/foo.dart',
      );
    });
  });

  group('镜像文件的 import 全在白名单内', () {
    test('扫描到的每个 amoo_mirror* 文件都不引写通道', () {
      final scanned = _discover();
      expect(
        scanned.length,
        greaterThanOrEqualTo(_requiredFloor.length),
        reason: '以下必检文件不在工作区：${_missing(scanned).join(', ')}',
      );

      final offenders = <String>[];
      for (final path in scanned) {
        final source = File(path).readAsStringSync();
        final matches = RegExp(r"^\s*(?:import|export)\s+'([^']+)'",
                multiLine: true)
            .allMatches(source);
        for (final m in matches) {
          final target = normalizeImport(m.group(1)!, path);
          if (target == null) {
            offenders.add('$path:${_lineOf(source, m.start)} → ${m.group(1)}（跑出仓库）');
            continue;
          }
          if (!_allowed(target, from: path)) {
            offenders.add('$path:${_lineOf(source, m.start)} → $target');
          }
        }
      }
      expect(
        offenders,
        isEmpty,
        reason: '只读镜像只许引用这些模块：白名单在 test/amoo_mirror_readonly_test.dart。'
            '要放行新依赖先在这条测试里加，并写清楚为什么它不是写通道',
      );
    });

    test('必检清单里至少含同步器与数据层的每一个文件', () {
      // 发现机制的兜底：万一目录改名，这里会先说少了谁。
      final scanned = _discover().toSet();
      for (final required in _requiredFloor) {
        expect(scanned, contains(required), reason: '$required 没有被扫到');
      }
    });
  });
}

/// 已落地的文件（数据层 10 + 同步器 1 + 端点默认值 1）。少任何一个都说明这批
/// 文件被移动或删除了，守卫要响——静默少扫一个文件比报错危险得多。
const List<String> _requiredFloor = <String>[
  'lib/core/mirror/amoo_mirror_models.dart',
  'lib/core/mirror/amoo_mirror_cache.dart',
  'lib/core/mirror/amoo_mirror_api.dart',
  'lib/core/mirror/amoo_mirror_errors.dart',
  'lib/core/mirror/amoo_mirror_sanitize.dart',
  'lib/core/mirror/amoo_mirror_account_store.dart',
  'lib/core/mirror/amoo_mirror_config.dart',
  'lib/core/mirror/amoo_mirror_sync.dart',
  'lib/core/db/amoo_mirror_schema.dart',
  'lib/core/db/amoo_mirror_store.dart',
  'lib/core/config/endpoint_defaults.dart',
];

List<String> _discover() {
  final found = <String>[];
  for (final dir in <String>['lib', 'tool']) {
    final root = Directory(dir);
    if (!root.existsSync()) continue;
    for (final entity in root.listSync(recursive: true)) {
      if (entity is! File) continue;
      final normalized = p.normalize(entity.path).replaceAll('\\', '/');
      final base = p.basename(normalized);
      if (!base.startsWith('amoo_mirror')) continue;
      if (!normalized.endsWith('.dart')) continue;
      found.add(normalized);
    }
  }
  // endpoint_defaults 是本feature唯一的 modify，名字不带 amoo_mirror 前缀。
  const defaults = 'lib/core/config/endpoint_defaults.dart';
  if (File(defaults).existsSync()) found.add(defaults);
  found.sort();
  return found;
}

List<String> _missing(List<String> scanned) {
  final have = scanned.toSet();
  return _requiredFloor.where((f) => !have.contains(f)).toList();
}

int _lineOf(String source, int index) {
  var line = 1;
  for (var i = 0; i < index && i < source.length; i++) {
    if (source.codeUnitAt(i) == 0x0A) line++;
  }
  return line;
}

/// 把一个 import 串归一成：
///   `dart`                         —— dart:*
///   `package:<name>`               —— 第三方包（只留包名）
///   `lib/...` / `tool/...`         —— 仓库内路径
///   null                           —— 解析结果逃逸出 lib/ 与 tool/
String? normalizeImport(String importPath, String fromFile) {
  if (importPath.startsWith('dart:')) return 'dart';
  if (importPath.startsWith('package:')) {
    final rest = importPath.substring('package:'.length);
    final slash = rest.indexOf('/');
    final name = slash < 0 ? rest : rest.substring(0, slash);
    if (name == 'khy_os_client') {
      final inner = rest.substring('khy_os_client/'.length);
      final resolved = 'lib/$inner';
      return resolved.startsWith('lib/') ? resolved : null;
    }
    return 'package:$name';
  }
  final joined = p.normalize(p.join(p.dirname(fromFile), importPath));
  final normalized = joined.replaceAll('\\', '/');
  if (normalized.startsWith('lib/') || normalized.startsWith('tool/')) {
    return normalized;
  }
  return null;
}

bool _allowed(String target, {required String from}) {
  if (target == 'dart') return true;
  if (target.startsWith('package:')) {
    // flutter 前缀整族放行：material / riverpod / secure_storage / test。
    if (target.startsWith('package:flutter')) return true;
    const thirdParty = <String>{
      'package:http',
      'package:sqflite',
      'package:path',
      'package:path_provider',
      'package:meta',
    };
    return thirdParty.contains(target);
  }
  if (from.startsWith('tool/')) {
    // tool/ 跑在 App 进程外：只许 dart: 与那一个端点常量（readonly 基准）。
    return target == 'lib/core/config/endpoint_defaults.dart';
  }
  // 本次自建文件之间可以互引（列表页推详情页、配置块与同步器对话）——它们是
  // 同一个 feature 的局部部件，不是写通道。发现机制保证这里只会出现
  // amoo_mirror* 文件。
  if (p.basename(target).startsWith('amoo_mirror')) return true;
  if (target == 'lib/core/config/endpoint_defaults.dart') return true;
  if (target == 'lib/core/services/app_logger.dart') return true;
  if (target == 'lib/core/gateway/key_pool.dart') return true;
  if (target.startsWith('lib/ui/theme/')) return true;
  if (target == 'lib/ui/widgets/aurora.dart') return true;
  return false;
}
