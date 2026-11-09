// 离线意图解析的判据测试。
//
// 这里钉的是「认得准」与「不乱认」两件事：
//   - 认得准：「把 A 移到 B」要拆成 source=A / target=B；
//   - 不乱认：认不出来就说认不出来，**不能猜**——猜出来的计划会被执行，
//     猜错一次就可能删错文件。
//
// 还钉了一件更重要的事：本地解析出来的计划必须**走同一条护栏**——
// 越界路径照样被拒，风险分级照样生效。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/ai_plan.dart';
import 'package:khy_os_client/core/vfs/ai_plan_generator.dart';
import 'package:khy_os_client/core/vfs/local_intent_parser.dart';
import 'package:khy_os_client/core/vfs/vfs_context.dart';

void main() {
  group('常见中文指令', () {
    test('移动：把 A 移到 B', () {
      final result = LocalIntentParser.parse('把 /storage/emulated/0/a.txt 移到 /sdcard/b.txt');
      expect(result.plan.operations, hasLength(1));
      final op = result.plan.operations.first;
      expect(op.kind, AiOpKind.move);
      expect(op.sourcePath, '/storage/emulated/0/a.txt');
      expect(op.targetPath, '/sdcard/b.txt');
      expect(op.risk, AiRisk.caution);
    });

    test('复制：复制 A 到 B', () {
      final result = LocalIntentParser.parse('复制 /sdcard/a.txt 到 /sdcard/b.txt');
      expect(result.plan.operations, hasLength(1));
      expect(result.plan.operations.first.kind, AiOpKind.copy);
    });

    test('删除：删除 A（高危）', () {
      final result = LocalIntentParser.parse('删除 /sdcard/a.txt');
      expect(result.plan.operations, hasLength(1));
      expect(result.plan.operations.first.kind, AiOpKind.delete);
      expect(result.plan.operations.first.risk, AiRisk.destructive);
    });

    test('重命名：把 A 重命名为 B', () {
      final result = LocalIntentParser.parse('把 /sdcard/a.txt 重命名为 b.txt');
      expect(result.plan.operations, hasLength(1));
      final op = result.plan.operations.first;
      expect(op.kind, AiOpKind.rename);
      expect(op.targetPath, 'b.txt');
    });

    test('新建目录', () {
      final result = LocalIntentParser.parse('新建目录 /sdcard/Work');
      expect(result.plan.operations, hasLength(1));
      expect(result.plan.operations.first.kind, AiOpKind.mkdir);
    });

    test('搜索', () {
      final result = LocalIntentParser.parse('查找 /sdcard/a.txt');
      expect(result.plan.operations, hasLength(1));
      expect(result.plan.operations.first.kind, AiOpKind.search);
    });

    test('引号里的内容优先当作路径', () {
      final result = LocalIntentParser.parse('把「/sdcard/my file.txt」移到「/sdcard/b.txt」');
      expect(result.plan.operations, hasLength(1));
      expect(result.plan.operations.first.sourcePath, '/sdcard/my file.txt');
    });
  });

  group('不乱认', () {
    test('认不出来的指令给出空计划而不是猜', () {
      final result = LocalIntentParser.parse('今天天气怎么样');
      expect(result.plan.operations, isEmpty);
      expect(result.plan.summary, contains('离线模式'));
    });

    test('空指令', () {
      final result = LocalIntentParser.parse('   ');
      expect(result.plan.operations, isEmpty);
    });

    test('有动词但缺路径时也不猜', () {
      final result = LocalIntentParser.parse('把它移到那边');
      expect(result.plan.operations, isEmpty);
    });
  });

  group('生成器的离线兜底', () {
    test('offline=true 时完全不联网，直接用本地规则', () async {
      final plan = await AiPlanGenerator.generate(
        instruction: '把 /sdcard/a.txt 移到 /sdcard/b.txt',
        context: const VfsContext(currentPath: '/sdcard'),
        offline: true,
      );
      expect(plan.operations, hasLength(1));
      expect(plan.operations.first.kind, AiOpKind.move);
    });

    test('没配模型时自动落到本地规则，并说明来源', () async {
      // 测试环境没有 secure storage，AppConfig 读不到 → 视为「未配置模型」。
      final plan = await AiPlanGenerator.generate(
        instruction: '删除 /sdcard/a.txt',
        context: const VfsContext(currentPath: '/sdcard'),
      );
      expect(plan.operations, hasLength(1));
      expect(plan.summary, contains('离线规则'));
    });

    test('没配模型且本地也认不出时，如实说做不到', () async {
      final plan = await AiPlanGenerator.generate(
        instruction: '今天天气怎么样',
        context: const VfsContext(currentPath: '/sdcard'),
      );
      expect(plan.operations, isEmpty);
      expect(plan.summary, isNotEmpty);
    });
  });

  group('本地解析也走同一套护栏', () {    test('越界路径照样被拒', () {
      final result = LocalIntentParser.parse('删除 /sdcard/../data/data');
      expect(result.plan.operations, isEmpty);
      expect(result.plan.rejected, isNotEmpty);
    });

    test('系统分区写入被拒', () {
      final result = LocalIntentParser.parse('把 /sdcard/a.txt 移到 /system/app');
      expect(result.plan.operations, isEmpty);
      expect(result.plan.rejected, isNotEmpty);
    });

    test('删除私有目录里的文件判为高危', () {
      final result = LocalIntentParser.parse('删除 /data/data/com.foo/files/a.db');
      expect(result.plan.operations, hasLength(1));
      expect(result.plan.operations.first.risk, AiRisk.destructive);
    });
  });
}
