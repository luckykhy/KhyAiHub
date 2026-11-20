// 跨权限审计的判据测试。
//
// 为什么单独测一个纯函数：目标 §五 要求「所有跨权限操作（如从私有目录复制到
// 公共存储）记录审计日志」。这条要求能不能落地，全看「跨不跨」这一句判据准不准。
//
// 判据放宽了，普通复制会被误标成跨权限——用户自己拷几百个文件，日志全刷黄，
// 真要看的条目反而被埋掉；判据收紧了，私有目录导出又会漏标——越界操作混在
// 普通复制里，日志上根本看不出来。两种错法都不会报错，只会让承诺悄悄失效，
// 所以它必须有测试。
//
// 旧日志的兼容也要测：升级之后要能读旧账，不能因为少一个字段就崩。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/audit_log.dart';
import 'package:khy_os_client/core/vfs/vfs_route.dart';

void main() {
  group('跨权限判据', () {
    test('同一档内不算跨权限', () {
      expect(crossTierLabel(VfsTier.basic, VfsTier.basic), isEmpty);
      expect(crossTierLabel(VfsTier.privateData, VfsTier.privateData), isEmpty);
      expect(crossTierLabel(VfsTier.container, VfsTier.container), isEmpty);
    });

    test('私有目录导出到公共存储算跨权限', () {
      final label = crossTierLabel(VfsTier.privateData, VfsTier.basic);
      expect(label, isNotEmpty);
      expect(label, contains('应用私有目录'));
      expect(label, contains('基础文件管理'));
    });

    test('方向不同则标记不同', () {
      expect(
        crossTierLabel(VfsTier.basic, VfsTier.privateData),
        isNot(crossTierLabel(VfsTier.privateData, VfsTier.basic)),
      );
    });

    test('容器与宿主之间互算跨权限', () {
      expect(crossTierLabel(VfsTier.container, VfsTier.basic), isNotEmpty);
      expect(crossTierLabel(VfsTier.basic, VfsTier.container), isNotEmpty);
    });

    test('系统只读分区参与判档', () {
      expect(crossTierLabel(VfsTier.systemRead, VfsTier.basic), isNotEmpty);
    });
  });

  group('审计条目的跨权限字段', () {
    test('有标记时 isCrossTier 为真', () {
      final entry = AuditEntry(
        time: DateTime.fromMillisecondsSinceEpoch(0),
        source: AuditSource.user,
        operation: 'copy',
        path: '/data/data/com.x',
        crossTier: crossTierLabel(VfsTier.privateData, VfsTier.basic),
      );
      expect(entry.isCrossTier, isTrue);
    });

    test('没有标记时 isCrossTier 为假', () {
      final entry = AuditEntry(
        time: DateTime.fromMillisecondsSinceEpoch(0),
        source: AuditSource.user,
        operation: 'copy',
        path: '/sdcard/a.txt',
      );
      expect(entry.isCrossTier, isFalse);
    });

    test('JSON 往返保留跨权限标记', () {
      final entry = AuditEntry(
        time: DateTime.fromMillisecondsSinceEpoch(1700000000000),
        source: AuditSource.ai,
        operation: 'copy',
        path: '/data/data/com.x',
        detail: '/sdcard/out',
        crossTier: crossTierLabel(VfsTier.privateData, VfsTier.basic),
      );
      final restored = AuditEntry.fromJson(entry.toJson());
      expect(restored.crossTier, entry.crossTier);
      expect(restored.isCrossTier, isTrue);
      expect(restored.source, AuditSource.ai);
      expect(restored.detail, '/sdcard/out');
    });

    test('旧日志没有该字段时按不跨权限读', () {
      final restored = AuditEntry.fromJson(<String, dynamic>{
        'time': 1700000000000,
        'source': 'user',
        'operation': 'copy',
        'path': '/sdcard/a.txt',
      });
      expect(restored.crossTier, isEmpty);
      expect(restored.isCrossTier, isFalse);
    });
  });
}
