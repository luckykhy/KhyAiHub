import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/ui/widgets/vfs/vfs_elevation_guide.dart';

/// 「激活提权」引导页的文案契约。
///
/// 这组断言守的是五件事：
///   1. 步骤讲得清**怎么把 khyos 自带的代理拉起来**（手机自己来为主、电脑侧兜底）；
///   2. 不再让用户去装任何第三方提权 App（2026-11-12 人裁决：完全移除）；
///   3. 诚实写出「重启后代理不保留」这条平台事实；
///   4. 「手机自己来」这条路讲清**配对在 App 内完成、只需一次**——
///      2026-11-17 起不再需要电脑代办配对（[DESIGN-ARCH-212] 期 2）；
///   5. 提权默认关闭、开启要用户显式动作（任务书红线）。
void main() {
  group('提权激活教程', () {
    test('讲清了提权通道怎么起来', () {
      final all = kElevationActivationSteps.join('\n');
      expect(all, contains('无线调试'));
      expect(all, contains('adb'));
      expect(all, contains('uid 2000'));
      expect(all, contains(kElevationHostCommand));
    });

    test('不再提任何第三方提权 App', () {
      final all = kElevationActivationSteps.join('\n') +
          kElevationNotes.join('\n') +
          kElevationSelfServiceSteps.join('\n');
      expect(all, isNot(contains('Shizuku')));
      expect(all, isNot(contains('安装包')));
    });

    test('说清了重启后代理不保留', () {
      final notes = kElevationNotes.join('\n');
      expect(notes, contains('重启'));
    });

    test('主机命令指向仓内的兜底脚本', () {
      expect(kElevationHostCommand, contains('provision-shell-sidecar.ps1'));
      expect(kElevationHostCommand, contains('-FromDevice'));
    });

    test('手机自己来的路线讲清了配对在 App 内完成且只需一次', () {
      final all = kElevationSelfServiceSteps.join('\n');
      expect(all, contains('无线调试'));
      expect(all, contains('配对'));
      expect(all, contains('只需做一次'));
      // 配对码由用户从系统弹窗读出、填进 App——不再有电脑代办配对的命令。
      expect(all, contains('6 位数字'));
    });

    test('不再引导用户去电脑上跑配对命令', () {
      // 旧路径（导出私钥到 /sdcard + 电脑上 pair-khyos-key.ps1）已删除：
      // 私钥落共享存储违反 T6（/sdcard 零密钥残留）。
      final all = kElevationSelfServiceSteps.join('\n') +
          kElevationActivationSteps.join('\n');
      expect(all, isNot(contains('pair-khyos-key')));
      expect(all, isNot(contains('导出配对钥匙')));
    });

    test('提权默认关闭、开启要显式动作', () {
      final all = kElevationNotes.join('\n');
      expect(all, contains('默认关闭'));
      expect(all, contains('两步都在你手上'));
    });
  });
}
