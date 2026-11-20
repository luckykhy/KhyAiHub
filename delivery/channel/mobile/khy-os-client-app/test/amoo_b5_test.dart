import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/db/amoo_turn.dart';
import 'package:khy_os_client/core/services/amoo_shared_store.dart';
import 'package:khy_os_client/core/services/conversation_db.dart';

/// B5 共享数据的完成判定（amoo-bridge-20261112）。
///
/// 守五条硬规则，逐条对应 TASK.md §4 B5 与 contract.md §8：
///   白名单写入前生效（K-72）／删除传播（K-73）／设备侧单写者、读到即最终态（K-70）
///   哈希一致且差异能定位到字段（K-74）／保留期 24h-1h-72h（K-74）。
///
/// 权威方已由 TASK.md §C2 拍板为**设备侧单写者**，所以本组没有任何"合并两个文档"的
/// 测试——合并函数不该存在；判据换成"同一份输入在任何一端投影出同一个哈希"。
/// 版本向量同理不测：C2 明定不用。
///
/// 今天是红的：`lib/core/services/amoo_shared_store.dart` 不存在（2026-11-12 实读，
/// 全 lib 无 shared store / outbox 实现），编译即失败。实现落到通过后，本文件的 API
/// 形状即判定契约；要改形状得改判定，不许为了让测试过而删断言。
void main() {
  Conversation conv({
    String id = 'c1',
    bool? syncToDesktop,
    List<ChatMsg>? messages,
  }) =>
      Conversation(
        id: id,
        title: '对话$id',
        messages: messages ?? const <ChatMsg>[],
        syncToDesktop: syncToDesktop,
      );

  group('白名单在写入前生效（K-72）', () {
    test('单对话关掉、或全局关且没单独表过态 → 这条不进共享面', () {
      // 真值表必须与 ConversationSync.effectiveEnabled 一致（K-00b 复用优先）：
      // override 为 null 时跟随全局，非 null 时 override 赢。
      expect(
        AmooSharedStore.projectConversation(conv(syncToDesktop: false),
            globalSyncDefault: true),
        isNull,
      );
      expect(
        AmooSharedStore.projectConversation(conv(syncToDesktop: null),
            globalSyncDefault: false),
        isNull,
      );
    });

    test('单对话打开、或没表过态而全局开着 → 进共享面', () {
      expect(
        AmooSharedStore.projectConversation(conv(syncToDesktop: true),
            globalSyncDefault: false),
        isNotNull,
      );
      expect(
        AmooSharedStore.projectConversation(conv(syncToDesktop: null),
            globalSyncDefault: true),
        isNotNull,
      );
    });

    test('凭据、剪贴板原文、截屏原图不进共享文档', () {
      // K-72 默认不出本机五项里的三条可确定构造的。写成"投影后文档里搜不到原文"
      // 而不是规定实现：元数据投影、内容脱敏投影都算过，只有"原样带出去"算不过。
      const clipboardRaw = 'clipboard-raw-7f3a9c2b';
      const shotDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg';
      const credential = 'sk-live-9c1f4b2a7e5d';
      final c = conv(
        messages: <ChatMsg>[
          ChatMsg(role: 'user', content: '我的密钥是 $credential'),
          ChatMsg(role: 'tool', content: clipboardRaw),
          ChatMsg(role: 'tool', content: shotDataUrl),
        ],
      );
      final entry =
          AmooSharedStore.projectConversation(c, globalSyncDefault: true);
      // 普通对话本身要能共享，否则这条判定可以被"什么都不投影"蒙过去。
      expect(entry, isNotNull);
      final json =
          AmooSharedStore.canonicalJson(AmooSharedStore.build(<SharedEntry>[entry!]));
      expect(json, isNot(contains(clipboardRaw)));
      expect(json, isNot(contains(shotDataUrl)));
      expect(json, isNot(contains(credential)));
    });

    test('memory 敏感条目不进共享面，普通条目进', () {
      // amoo_memory.json 的条目形状见 AmooMemory.java:102-144（id/text/confidence/
      // provenance）。sensitive 是本次新增的可选键：Java 侧 fromJson 只 optString
      // 已知四个键，多一个键不影响旧解析，所以标记加在文档里而不是另起一份。
      final plain = AmooSharedStore.projectMemory(<String, Object?>{
        'id': 'm1',
        'text': '用户偏好深色模式',
        'confidence': 'unverified',
      });
      expect(plain, isNotNull);
      expect(
        AmooSharedStore.canonicalJson(AmooSharedStore.build(<SharedEntry>[plain!])),
        contains('用户偏好深色模式'),
      );
      expect(
        AmooSharedStore.projectMemory(<String, Object?>{
          'id': 'm2',
          'text': '银行卡号 6222021234567890',
          'confidence': 'verified',
          'sensitive': true,
        }),
        isNull,
      );
    });

    test('投影出来的 key 就是对话 id（墓碑才对得上）', () {
      // 删除传播靠同 key 相消：投影若另起一个 id，墓碑就永远对不上活记录，
      // 删除在共享文档里表现为"多了一条"而不是"这条没了"。
      final e = AmooSharedStore.projectConversation(
          conv(id: 'c1', syncToDesktop: true),
          globalSyncDefault: true);
      expect(e, isNotNull);
      expect(e!.source, SharedSource.conversation);
      expect(e.id, 'c1');
    });

    test('没进白名单的记录在文档里连占位都没有', () {
      final shared =
          AmooSharedStore.projectConversation(conv(id: 'c1', syncToDesktop: true),
              globalSyncDefault: true);
      final withheld =
          AmooSharedStore.projectConversation(conv(id: 'c2', syncToDesktop: false),
              globalSyncDefault: true);
      expect(withheld, isNull);
      final json =
          AmooSharedStore.canonicalJson(AmooSharedStore.build(<SharedEntry>[shared!]));
      expect(json, contains('c1'));
      expect(json, isNot(contains('c2')));
    });
  });

  group('删除传播（K-73 / N10）', () {
    test('墓碑留在文档里，存活条数归零', () {
      final live =
          AmooSharedStore.projectConversation(conv(id: 'c1'), globalSyncDefault: true);
      final doc = AmooSharedStore.build(<SharedEntry>[
        live!,
        AmooSharedStore.tombstone(SharedSource.conversation, 'c1'),
      ]);
      // 墓碑必须在文档里：另一端靠它知道"这条没了"，删掉墓碑等于删除传不过去。
      expect(doc.length, 1);
      expect(doc.single.deleted, true);
      expect(doc.where((SharedEntry e) => !e.deleted).length, 0);
    });

    test('同一墓碑重复应用不增殖（5 轮里反复删同一条）', () {
      final doc = AmooSharedStore.build(<SharedEntry>[
        AmooSharedStore.tombstone(SharedSource.conversation, 'c1'),
        AmooSharedStore.tombstone(SharedSource.conversation, 'c1'),
      ]);
      expect(doc.length, 1);
    });

    test('删一个从未共享过的 id 也只是一条墓碑', () {
      final doc = AmooSharedStore.build(<SharedEntry>[
        AmooSharedStore.tombstone(SharedSource.amooTurn, 'ask-1'),
      ]);
      expect(doc.length, 1);
      expect(doc.single.source, SharedSource.amooTurn);
      expect(doc.single.id, 'ask-1');
    });
  });

  group('设备侧单写者与读到即最终态（K-70 / C2）', () {
    test('同一份输入重复投影，字节一致', () {
      List<SharedEntry> project() => <SharedEntry>[
            AmooSharedStore.projectConversation(conv(id: 'c1', syncToDesktop: true),
                globalSyncDefault: true)!,
            AmooSharedStore.projectAmooTurn(
              const AmooTurn(job: 'ask-1', prompt: '打开微信', askedAt: 1730000000000),
            )!,
          ];
      expect(
        AmooSharedStore.canonicalJson(AmooSharedStore.build(project())),
        AmooSharedStore.canonicalJson(AmooSharedStore.build(project())),
      );
    });

    test('同 key 后者胜，不做合并仲裁', () {
      final doc = AmooSharedStore.build(<SharedEntry>[
        const SharedEntry(
            source: SharedSource.conversation, id: 'c1', fields: <String, Object?>{'title': '旧'}),
        const SharedEntry(
            source: SharedSource.conversation, id: 'c1', fields: <String, Object?>{'title': '新'}),
      ]);
      expect(doc.length, 1);
      final json = AmooSharedStore.canonicalJson(doc);
      expect(json, contains('新'));
      expect(json, isNot(contains('旧')));
    });

    test('5 轮投影：条数一致、无重复、哈希只随内容变', () {
      final emptyDigest =
          AmooSharedStore.digest(AmooSharedStore.build(<SharedEntry>[]));
      final perRound = <String>[];
      for (var round = 1; round <= 5; round++) {
        final entries = <SharedEntry>[];
        for (var k = 0; k < round; k++) {
          final e = AmooSharedStore.projectConversation(
              conv(id: 'c$k', syncToDesktop: true),
              globalSyncDefault: true);
          expect(e, isNotNull, reason: '第 $round 轮 c$k 必须进共享面');
          entries.add(e!);
        }
        final doc = AmooSharedStore.build(entries);
        final keys = doc.map((SharedEntry e) => '${e.source.name}:${e.id}').toSet();
        expect(doc.length, keys.length, reason: '同一 key 不允许出现两条');
        expect(doc.length, round);
        perRound.add(AmooSharedStore.digest(doc));
      }
      // 每轮哈希都不是空文档的哈希：投影确实带进了内容。
      for (final d in perRound) {
        expect(d, isNot(emptyDigest));
      }
      // 五轮哈希互不相同：内容确实在变，否则这条判定是恒真的。
      expect(perRound.toSet().length, 5);
    });

    test('两端各投影同一份设备态，哈希差异 0', () {
      List<SharedEntry> project() => <SharedEntry>[
            AmooSharedStore.projectConversation(conv(id: 'c1', syncToDesktop: true),
                globalSyncDefault: true)!,
            AmooSharedStore.projectConversation(conv(id: 'c2', syncToDesktop: true),
                globalSyncDefault: true)!,
          ];
      final a = AmooSharedStore.build(project());
      final b = AmooSharedStore.build(project());
      expect(AmooSharedStore.digest(a), AmooSharedStore.digest(b));
      expect(AmooSharedStore.diffFields(a, b), isEmpty);
    });
  });

  group('哈希与差异定位（K-74 / N9）', () {
    test('摘要形状：64 位小写十六进制，内容不同则不同', () {
      final a = AmooSharedStore.build(<SharedEntry>[
        const SharedEntry(
            source: SharedSource.conversation, id: 'c1', fields: <String, Object?>{'title': 'a'}),
      ]);
      final b = AmooSharedStore.build(<SharedEntry>[
        const SharedEntry(
            source: SharedSource.conversation, id: 'c1', fields: <String, Object?>{'title': 'b'}),
      ]);
      expect(AmooSharedStore.digest(a), matches(RegExp(r'^[0-9a-f]{64}$')));
      expect(AmooSharedStore.digest(a), isNot(AmooSharedStore.digest(b)));
    });

    test('差异非 0 时每条都指到记录与字段', () {
      final a = AmooSharedStore.build(<SharedEntry>[
        const SharedEntry(
            source: SharedSource.conversation, id: 'c1', fields: <String, Object?>{'title': '旧'}),
        const SharedEntry(
            source: SharedSource.conversation, id: 'c2', fields: <String, Object?>{'title': '不动'}),
      ]);
      final b = AmooSharedStore.build(<SharedEntry>[
        const SharedEntry(
            source: SharedSource.conversation, id: 'c1', fields: <String, Object?>{'title': '新'}),
        const SharedEntry(
            source: SharedSource.conversation, id: 'c2', fields: <String, Object?>{'title': '不动'}),
      ]);
      final diff = AmooSharedStore.diffFields(a, b);
      expect(diff, isNotEmpty);
      for (final d in diff) {
        expect(d, contains('c1'));
        expect(d, contains('title'));
      }
      expect(diff.where((String d) => d.contains('c2')), isEmpty);
    });
  });

  group('保留期（K-74，与信箱同一组数）', () {
    test('result 24h / tmp 1h / processing 72h', () {
      // 数值真源在 BridgeService.java:56-59，不新造第二份。
      expect(AmooSharedStore.retention(SharedArtifactKind.result),
          const Duration(hours: 24));
      expect(AmooSharedStore.retention(SharedArtifactKind.tmp),
          const Duration(hours: 1));
      expect(AmooSharedStore.retention(SharedArtifactKind.processing),
          const Duration(hours: 72));
    });

    test('过期判定严格大于，负年龄不删', () {
      // 与 BridgeService.java:313-319 的 age > RETENTION 同一边界：等于保留期
      // 时还没过期。负年龄（时钟被改）走不删的一侧。
      final day = const Duration(hours: 24).inMilliseconds;
      expect(AmooSharedStore.artifactExpired(SharedArtifactKind.result, day), false);
      expect(AmooSharedStore.artifactExpired(SharedArtifactKind.result, day + 1), true);
      expect(AmooSharedStore.artifactExpired(SharedArtifactKind.result, -1), false);
    });
  });
}
