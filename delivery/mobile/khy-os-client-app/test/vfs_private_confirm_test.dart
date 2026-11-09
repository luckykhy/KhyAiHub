// 私有目录识别与访问确认策略的判据测试。
//
// 两条判据：
//   1. 路径 → 包名要准（/data/user/0/<pkg> 的第一段是 userId，不是包名）；
//   2. 确认过的包要记住、且能跨进程存活（策略序列化）。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/vfs_policy.dart';
import 'package:khy_os_client/core/vfs/vfs_route.dart';

void main() {
  group('私有目录的包名解析', () {
    test('/data/data/<pkg> 与其子目录', () {
      expect(VfsPrivate.packageOf('/data/data/com.foo'), 'com.foo');
      expect(
        VfsPrivate.packageOf('/data/data/com.foo/shared_prefs/x.xml'),
        'com.foo',
      );
    });

    test('/data/user/<userId>/<pkg> 的包名是第二段', () {
      expect(VfsPrivate.packageOf('/data/user/0/com.foo'), 'com.foo');
      expect(
        VfsPrivate.packageOf('/data/user/10/com.bar/files/a.txt'),
        'com.bar',
      );
    });

    test('非私有目录返回 null', () {
      expect(VfsPrivate.packageOf('/storage/emulated/0'), isNull);
      expect(VfsPrivate.packageOf('/system/app'), isNull);
      expect(VfsPrivate.packageOf('/'), isNull);
    });

    test('只有 /data/user 段（没有 userId 与包名）返回 null', () {
      expect(VfsPrivate.packageOf('/data/user'), isNull);
      expect(VfsPrivate.packageOf('/data/user/0'), isNull);
    });
  });

  group('访问确认策略', () {
    test('已确认的包被记住并能序列化回去', () {
      const policy = VfsPolicy(
        confirmedPrivatePackages: <String>['com.foo', 'com.bar'],
      );
      final restored = VfsPolicy.fromJson(policy.toJson());
      expect(restored.confirmedPrivatePackages, hasLength(2));
      expect(restored.confirmedPrivatePackages, contains('com.foo'));
    });

    test('默认没有确认过任何包', () {
      const policy = VfsPolicy();
      expect(policy.confirmedPrivatePackages, isEmpty);
      expect(policy.copyWith().confirmedPrivatePackages, isEmpty);
    });

    test('其它策略字段不受影响', () {
      const policy = VfsPolicy(
        safeMode: true,
        aiLevel: AiAssistLevel.suggest,
        advancedDataEdit: true,
        defaultConflict: VfsConflict.merge,
        confirmedPrivatePackages: <String>['com.foo'],
      );
      final restored = VfsPolicy.fromJson(policy.toJson());
      expect(restored.safeMode, isTrue);
      expect(restored.aiLevel, AiAssistLevel.suggest);
      expect(restored.advancedDataEdit, isTrue);
      expect(restored.defaultConflict, VfsConflict.merge);
    });
  });
}
