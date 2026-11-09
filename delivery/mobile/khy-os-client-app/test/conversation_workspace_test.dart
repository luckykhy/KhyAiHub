import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/workspace/conversation_workspace.dart';

/// 对话级工作空间根目录的校验测试。
///
/// 全在主机上跑：这一层是纯函数，而它守的正是目录逃逸——原生侧
/// `resolvePath` 的 containment 检查对着的是这里给出的 base，这里松一寸，
/// 那道 SecurityException 就是对空气挥拳。所以每条规则都有正反两例。
void main() {
  group('规范化', () {
    test('压掉重复斜杠、去末尾斜杠，但保留根目录的斜杠', () {
      expect(ConversationWorkspace.normalize('/sdcard//khy-os/'), '/sdcard/khy-os');
      expect(ConversationWorkspace.normalize('/sdcard/khy-os'), '/sdcard/khy-os');
      expect(ConversationWorkspace.normalize('  /sdcard/khy-os  '), '/sdcard/khy-os');
      expect(ConversationWorkspace.normalize('/'), '/');
      expect(ConversationWorkspace.normalize(''), '');
    });

    test('规范化是幂等的——拧两次和拧一次一样', () {
      // 不幂等就会出现"界面显示的根"和"实际生效的根"慢慢漂移。
      for (final raw in ['/sdcard//a/', ' /sdcard/a///b// ', '/sdcard/a/../b']) {
        final once = ConversationWorkspace.normalize(raw);
        expect(ConversationWorkspace.normalize(once), once);
      }
    });
  });

  group('校验', () {
    test('一个正常的绝对路径通过，并给出规范化值', () {
      final c = ConversationWorkspace.check('/sdcard/khy-os');
      expect(c.ok, true);
      expect(c.normalized, '/sdcard/khy-os');
      expect(c.reason, '');
    });

    test('展示用原样、生效用规范化，两者不同', () {
      // 存进去的必须是规范化值，否则界面上看着对、落盘差一点。
      final c = ConversationWorkspace.check('  /sdcard//khy-os/  ');
      expect(c.ok, true);
      expect(c.normalized, '/sdcard/khy-os');
    });

    test('空与超长都被拒', () {
      expect(ConversationWorkspace.check('').ok, false);
      expect(ConversationWorkspace.check('   ').reason, '根目录不能为空。');
      final long = '/sdcard/${'a' * 300}';
      expect(ConversationWorkspace.check(long).ok, false);
      expect(ConversationWorkspace.check(long).reason, contains('过长'));
    });

    test('相对路径被拒——它会落到不确定的位置', () {
      final c = ConversationWorkspace.check('sdcard/khy-os');
      expect(c.ok, false);
      expect(c.reason, contains('绝对路径'));
    });

    test('含 .. 的路径被拒，包括拧干之后才现形的形态', () {
      expect(ConversationWorkspace.check('/sdcard/../etc').ok, false);
      expect(ConversationWorkspace.check('/sdcard/./a/../..').ok, false);
      expect(ConversationWorkspace.check('/sdcard/a/../b').ok, false);
      expect(ConversationWorkspace.check('/sdcard/../etc').reason, contains('..'));
    });

    test('整个存储根被拒——那等于没有工作目录', () {
      expect(ConversationWorkspace.check('/').ok, false);
      expect(ConversationWorkspace.check('/').reason, contains('没有工作目录'));
    });

    test('/sdcard 之外的根通过但被标注', () {
      // 不阻止（用户可能有外置卡），但要提醒，因为文件管理器可能看不到。
      final c = ConversationWorkspace.check('/storage/ABCD-1234/game');
      expect(c.ok, true);
      expect(c.outsideSharedStorage, true);
      expect(ConversationWorkspace.check('/sdcard/khy-os').outsideSharedStorage, false);
    });
  });

  group('生效值', () {
    test('没挑 = null = 用 App 既有默认，行为一字不变', () {
      expect(ConversationWorkspace.effectiveRoot(null), isNull);
      expect(ConversationWorkspace.effectiveRoot(''), isNull);
      expect(ConversationWorkspace.effectiveRoot('   '), isNull);
    });

    test('挑了就用挑的（规范化后）', () {
      expect(ConversationWorkspace.effectiveRoot('/sdcard/khy-os'),
          '/sdcard/khy-os');
      expect(ConversationWorkspace.effectiveRoot(' /sdcard//khy-os/ '),
          '/sdcard/khy-os');
    });

    test('认得出 App 自己设计的那个根', () {
      expect(ConversationWorkspace.isDesignedRoot('/sdcard/khy-os'), true);
      expect(ConversationWorkspace.isDesignedRoot('/sdcard/other'), false);
      // 没挑不等于设计根——两者描述完全不同，别混。
      expect(ConversationWorkspace.isDesignedRoot(null), false);
    });
  });

  group('描述', () {
    test('没挑时说清"文件管理器里看不到"', () {
      // 这句话是给用户的第一手线索：为什么写了文件却找不到。
      expect(ConversationWorkspace.describeRoot(null), contains('看不到'));
    });

    test('挑了设计根时说清"可见"', () {
      expect(ConversationWorkspace.describeRoot('/sdcard/khy-os'), contains('可见'));
    });

    test('选了 /sdcard 之外要给提醒', () {
      expect(ConversationWorkspace.describeRoot('/storage/X/game'), contains('之外'));
    });
  });
}
