// AI 辅助强度四档的判据测试。
//
// 背景：目标 §四 要求「设置中提供 AI 辅助强度滑块：从『仅被动响应』到
// 『主动建议』多档可调，**甚至完全关闭 AI**」。这一档是用户对「这个 App
// 该多主动」的**决定**，所以落盘在 VfsPolicy 里、设置页可改。
//
// 钉四件事：
//   1. parse 的往返与未知值兜底；
//   2. 每档的 label / description 都存在且不重名；
//   3. showsAssistant / suggests 两个判据把四档切成**三种**可观察行为；
//   4. **mayAct 目前没有消费点**——所以「主动建议」与「主动建议并可代执行」
//      这两档在界面上完全一样。这个事实必须被钉住：它是已知的未接线项，
//      不是 bug，但下次有人「顺手」改窄某一档时，测试会告诉他这里动过。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/vfs/vfs_policy.dart';

void main() {
  group('parse', () {
    test('每档都能按名字往返', () {
      for (final level in AiAssistLevel.values) {
        expect(AiAssistLevel.parse(level.name), level);
      }
    });

    test('未知值与空值都兜底到 passive', () {
      expect(AiAssistLevel.parse('nonsense'), AiAssistLevel.passive);
      expect(AiAssistLevel.parse(null), AiAssistLevel.passive);
      expect(AiAssistLevel.parse(''), AiAssistLevel.passive);
    });

    test('大小写不匹配会兜底 passive（精确匹配，不猜）', () {
      // 写入用的是 level.name（全小写），读回也是同一个串，所以往返精确。
      // 这里钉的是「认不出来就兜底」而不是「大小写不敏感」——认不出来时
      // 退到 passive（AI 少说话）是安全方向，退到 active 才危险。
      expect(AiAssistLevel.parse('OFF'), AiAssistLevel.passive);
      expect(AiAssistLevel.parse('Suggest'), AiAssistLevel.passive);
      expect(AiAssistLevel.parse('off'), AiAssistLevel.off);
      expect(AiAssistLevel.parse('suggest'), AiAssistLevel.suggest);
    });
  });

  group('label 与 description', () {
    test('每档都有 label，且互不重复', () {
      final labels = AiAssistLevel.values.map((AiAssistLevel l) => l.label).toSet();
      expect(labels, hasLength(AiAssistLevel.values.length));
      for (final level in AiAssistLevel.values) {
        expect(level.label, isNotEmpty, reason: '$level 的 label 不能空');
      }
    });

    test('每档都有 description，且互不重复', () {
      final descriptions =
          AiAssistLevel.values.map((AiAssistLevel l) => l.description).toSet();
      expect(descriptions, hasLength(AiAssistLevel.values.length));
      for (final level in AiAssistLevel.values) {
        expect(level.description, isNotEmpty, reason: '$level 的 description 不能空');
      }
    });
  });

  group('可观察行为：四档切成三种', () {
    test('off 不显示 AI 入口，其余三档都显示', () {
      expect(AiAssistLevel.off.showsAssistant, isFalse);
      expect(AiAssistLevel.passive.showsAssistant, isTrue);
      expect(AiAssistLevel.suggest.showsAssistant, isTrue);
      expect(AiAssistLevel.active.showsAssistant, isTrue);
    });

    test('只有 suggest 与 active 主动给建议', () {
      expect(AiAssistLevel.off.suggests, isFalse);
      expect(AiAssistLevel.passive.suggests, isFalse);
      expect(AiAssistLevel.suggest.suggests, isTrue);
      expect(AiAssistLevel.active.suggests, isTrue);
    });

    test('三种可观察行为确实互不相同', () {
      // off / passive / suggest-or-active 三组的 (shows, suggests) 组合两两不同。
      final off = (AiAssistLevel.off.showsAssistant, AiAssistLevel.off.suggests);
      final passive =
          (AiAssistLevel.passive.showsAssistant, AiAssistLevel.passive.suggests);
      final proactive = (
        AiAssistLevel.suggest.showsAssistant,
        AiAssistLevel.suggest.suggests,
      );
      expect(off, isNot(equals(passive)));
      expect(passive, isNot(equals(proactive)));
      expect(off, isNot(equals(proactive)));
    });
  });

  group('mayAct：定义了但没有消费点', () {
    test('判据本身是对的', () {
      expect(AiAssistLevel.active.mayAct, isTrue);
      expect(AiAssistLevel.suggest.mayAct, isFalse);
      expect(AiAssistLevel.passive.mayAct, isFalse);
      expect(AiAssistLevel.off.mayAct, isFalse);
    });

    test('但 suggest 与 active 的可观察行为完全相同', () {
      // 这是已知的未接线项：设置页有四档，界面上只有三种效果。
      // 钉住它，免得以后有人以为改窄某一档是安全的。
      expect(
        AiAssistLevel.suggest.showsAssistant,
        AiAssistLevel.active.showsAssistant,
      );
      expect(AiAssistLevel.suggest.suggests, AiAssistLevel.active.suggests);
    });
  });

  group('VfsPolicy 默认值', () {
    test('默认 passive：不主动说话，但 AI 入口在', () {
      const policy = VfsPolicy();
      expect(policy.aiLevel, AiAssistLevel.passive);
      expect(policy.aiLevel.showsAssistant, isTrue);
      expect(policy.aiLevel.suggests, isFalse);
    });

    test('默认不开安全模式、不开高级数据编辑', () {
      const policy = VfsPolicy();
      expect(policy.safeMode, isFalse);
      expect(policy.advancedDataEdit, isFalse);
    });

    test('aiLevel 能落盘往返', () {
      const policy = VfsPolicy(aiLevel: AiAssistLevel.active);
      final json = policy.toJson();
      expect(json['aiLevel'], 'active');
      expect(VfsPolicy.fromJson(json).aiLevel, AiAssistLevel.active);
    });

    test('JSON 里没有 aiLevel 时兜底 passive（老配置不崩）', () {
      expect(VfsPolicy.fromJson(const <String, dynamic>{}).aiLevel,
          AiAssistLevel.passive);
    });

    test('copyWith 只改指定字段', () {
      const base = VfsPolicy(aiLevel: AiAssistLevel.passive, safeMode: false);
      final changed = base.copyWith(aiLevel: AiAssistLevel.off);
      expect(changed.aiLevel, AiAssistLevel.off);
      expect(changed.safeMode, base.safeMode,
          reason: '没点的字段不该被顺带动');
    });
  });
}
