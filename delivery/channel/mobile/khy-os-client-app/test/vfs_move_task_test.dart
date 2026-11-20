// 移动走多线程引擎的判据测试。
//
// 目标 §二 要求「多线程复制/移动」。移动要拿到多线程、字节级续传与进度，
// 就得走原生侧那套复制引擎；但那套引擎跑在 Java IO 上，够不到 提权代理 才能
// 看的路径（应用私有目录、系统分区）。
//
// 所以判据是：**两端的访问通道都必须是 storage 才走线程引擎**，否则退回
// shell 通道的同步实现。判据一旦悄悄放宽，移动私有目录就会从「能用」变成
// 「报错」，而那种错法在界面上完全看不出原因——所以它必须被测。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/vfs_copy_task.dart';
import 'package:khy_os_client/core/vfs/vfs_route.dart';

void main() {
  group('移动能不能走多线程通道', () {
    test('两端都在普通文件系统上时可以', () {
      expect(canUseThreadedMove(VfsVia.storage, VfsVia.storage), isTrue);
    });

    test('源要提权时不行', () {
      expect(canUseThreadedMove(VfsVia.shell, VfsVia.storage), isFalse);
    });

    test('目标要提权时也不行', () {
      expect(canUseThreadedMove(VfsVia.storage, VfsVia.shell), isFalse);
    });

    test('两端都要提权时也不行', () {
      expect(canUseThreadedMove(VfsVia.shell, VfsVia.shell), isFalse);
    });

    test('虚拟根（via 为 null）不行', () {
      // via == null 表示这是虚拟根入口，不是真实路径——压根不该发移动。
      expect(canUseThreadedMove(null, VfsVia.storage), isFalse);
      expect(canUseThreadedMove(VfsVia.storage, null), isFalse);
      expect(canUseThreadedMove(null, null), isFalse);
    });
  });

  group('进度里的 moveLeft', () {
    test('解析出搬走后仍留在原地的源文件数', () {
      final progress = CopyProgress.fromMap(<String, dynamic>{
        'taskId': 't1',
        'state': 'done',
        'moveLeft': 3,
      });
      expect(progress.moveLeft, 3);
      expect(progress.finished, isTrue);
    });

    test('复制时恒为 0', () {
      final progress = CopyProgress.fromMap(<String, dynamic>{
        'taskId': 't2',
        'state': 'done',
      });
      expect(progress.moveLeft, 0);
    });

    test('srcGone 区分「搬完了」与「被跳过了」', () {
      // 目标已存在且策略是跳过时，任务状态也是 done，但源根本没动。
      // 靠 srcGone 才能把这两者分开——否则界面会报「移动完成」，那是在骗人。
      final moved = CopyProgress.fromMap(<String, dynamic>{
        'taskId': 't3',
        'state': 'done',
        'srcGone': true,
      });
      expect(moved.srcGone, isTrue);

      final skipped = CopyProgress.fromMap(<String, dynamic>{
        'taskId': 't4',
        'state': 'done',
        'srcGone': false,
      });
      expect(skipped.srcGone, isFalse);
    });
  });
}
