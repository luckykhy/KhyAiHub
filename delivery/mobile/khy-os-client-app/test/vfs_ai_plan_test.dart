// AI 操作计划与安全护栏的判据测试。
//
// 这里钉的是「AI 不能干什么」——比「AI 能干什么」更重要。计划解码器是最后一道闸：
// 模型说什么不算数，白名单与风险分级说了算。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/ai_plan.dart';
import 'package:khy_os_client/core/vfs/ai_safety.dart';

void main() {
  group('AiPlanDecoder 白名单', () {
    test('解析合法计划', () {
      final plan = AiPlanDecoder.decode(
        '{"summary":"搬运文件","operations":['
        '{"op":"copy","source":"/storage/emulated/0/a.pdf","target":"/storage/emulated/0/Documents"}'
        ']}',
      );
      expect(plan.operations, hasLength(1));
      expect(plan.rejected, isEmpty);
      final op = plan.operations.first;
      expect(op.kind, AiOpKind.copy);
      expect(op.sourcePath, '/storage/emulated/0/a.pdf');
      expect(op.targetPath, '/storage/emulated/0/Documents');
      expect(op.risk, AiRisk.caution);
    });

    test('未知操作类型被拒绝并留下原因', () {
      final plan = AiPlanDecoder.decode(
        '{"operations":[{"op":"format_disk","source":"/"}]}',
      );
      expect(plan.operations, isEmpty);
      expect(plan.rejected, hasLength(1));
      expect(plan.rejected.first.reason, contains('白名单'));
    });

    test('含 .. 的越界路径被拒绝', () {
      final plan = AiPlanDecoder.decode(
        '{"operations":[{"op":"delete","source":"/storage/emulated/0/../../data/data"}]}',
      );
      expect(plan.operations, isEmpty);
      expect(plan.rejected, hasLength(1));
    });

    test('删除系统根目录被拒绝', () {
      final plan = AiPlanDecoder.decode(
        '{"operations":[{"op":"delete","source":"/system"}]}',
      );
      expect(plan.operations, isEmpty);
      expect(plan.rejected, hasLength(1));
    });

    test('坏项被丢弃但好项照常进入计划', () {
      final plan = AiPlanDecoder.decode(
        '{"operations":['
        '{"op":"delete","source":"/system"},'
        '{"op":"mkdir","source":"/storage/emulated/0/Work"}'
        ']}',
      );
      expect(plan.operations, hasLength(1));
      expect(plan.operations.first.kind, AiOpKind.mkdir);
      expect(plan.rejected, hasLength(1));
    });

    test('代码块包裹的 JSON 也能解析', () {
      final plan = AiPlanDecoder.decode(
        '```json\n{"operations":[{"op":"mkdir","source":"/storage/emulated/0/X"}]}\n```',
      );
      expect(plan.operations, hasLength(1));
    });

    test('不是 JSON 时给出诚实摘要而不是抛异常', () {
      final plan = AiPlanDecoder.decode('我想把文件整理一下');
      expect(plan.operations, isEmpty);
      expect(plan.summary, isNotEmpty);
    });

    test('同义词归一', () {
      expect(AiOpKind.parse('rm'), AiOpKind.delete);
      expect(AiOpKind.parse('mv'), AiOpKind.move);
      expect(AiOpKind.parse('cp'), AiOpKind.copy);
      expect(AiOpKind.parse('make_dir'), AiOpKind.mkdir);
      expect(AiOpKind.parse('rm -rf /'), isNull);
    });
  });

  group('风险分级', () {
    AiOperationPlan decodeOne(String json) => AiPlanDecoder.decode(json);

    test('删除一律高危', () {
      final plan = decodeOne(
        '{"operations":[{"op":"delete","source":"/storage/emulated/0/a.txt"}]}',
      );
      expect(plan.operations.first.risk, AiRisk.destructive);
    });

    test('涉及应用私有目录的写操作一律高危', () {
      final plan = decodeOne(
        '{"operations":[{"op":"copy","source":"/data/data/com.foo/f","target":"/storage/emulated/0/f"}]}',
      );
      expect(plan.operations.first.risk, AiRisk.destructive);
    });

    test('递归操作一律高危', () {
      final plan = decodeOne(
        '{"operations":[{"op":"move","source":"/storage/emulated/0/A","target":"/storage/emulated/0/B","recursive":true}]}',
      );
      expect(plan.operations.first.risk, AiRisk.destructive);
    });

    test('普通移动是需确认，新建目录是低风险', () {
      final plan = decodeOne(
        '{"operations":['
        '{"op":"move","source":"/storage/emulated/0/a","target":"/storage/emulated/0/b"},'
        '{"op":"mkdir","source":"/storage/emulated/0/c"}]}',
      );
      expect(plan.operations[0].risk, AiRisk.caution);
      expect(plan.operations[1].risk, AiRisk.safe);
      expect(plan.maxRisk, AiRisk.caution);
      expect(plan.destructiveCount, 0);
    });
  });

  group('AiSafetyFilter', () {
    test('拒绝根目录', () {
      expect(AiSafetyFilter.checkPath('/', forWrite: true).allowed, isFalse);
    });

    test('拒绝写系统分区与危险根', () {
      expect(
        AiSafetyFilter.checkPath('/system/app', forWrite: true).allowed,
        isFalse,
      );
      expect(
        AiSafetyFilter.checkPath('/data/data', forWrite: true).allowed,
        isFalse,
      );
      expect(
        AiSafetyFilter.checkPath('/storage/emulated/0/Download', forWrite: true)
            .allowed,
        isTrue,
      );
    });

    test('拒绝越界路径', () {
      expect(
        AiSafetyFilter.checkPath('/storage/../data', forWrite: true).allowed,
        isFalse,
      );
    });

    test('危险命令被拒绝', () {
      const dangerous = <String>[
        'rm -rf /',
        'rm -fr /',
        'chmod 777 /system',
        'mkfs.ext4 /dev/block/sda',
        'dd if=/dev/zero of=/dev/block/mmcblk0',
        ':(){ :|:& };:',
        'setenforce 0',
        'insmod evil.ko',
        'shred -u file',
      ];
      for (final command in dangerous) {
        expect(
          AiSafetyFilter.checkCommand(command).allowed,
          isFalse,
          reason: '$command 应当被拒绝',
        );
      }
    });

    test('普通命令放行', () {
      expect(AiSafetyFilter.checkCommand('ls -la /storage').allowed, isTrue);
      expect(
        AiSafetyFilter.checkCommand('cp -a /a /b').allowed,
        isTrue,
      );
    });
  });
}
