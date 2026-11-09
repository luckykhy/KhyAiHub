import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/memory/memory_store.dart';

/// 记忆库的纯逻辑与存储行为测试。
///
/// 为什么这些测试跑得起来：`FlutterSecureStorage.setMockInitialValues` 把平台
/// 实现换成内存表（见包内 `test/test_flutter_secure_storage_platform.dart`），
/// 不需要方法通道。对比 `amoo_turn_store` 用 sqflite、主机没有 sqlite3.dll，
/// 它的存储那一半只能留在设备上跑——这正是这里选 secure storage 的理由之一。
void main() {
  const storage = FlutterSecureStorage();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
  });

  /// 一条足够长的记忆，避开「正文过短」那条蒸馏规则，让其它断言不被干扰。
  MemoryEntry longEntry({
    String id = 'user_abc12345',
    String name = '常用编辑器',
    String description = '',
    MemoryType type = MemoryType.user,
    MemoryTier? tier,
    String body = '用户主力编辑器是 VS Code，装在 D 盘，插件约三十个。',
    DateTime? updated,
    int recallCount = 0,
  }) {
    return MemoryEntry(
      id: id,
      name: name,
      description: description,
      type: type,
      tier: tier,
      body: body,
      updated: updated ?? DateTime.utc(2026, 11, 4, 12),
      recallCount: recallCount,
    );
  }

  group('tier 派生', () {
    test('无显式 tier 时 user → permanent，其余 → cross_session', () {
      expect(MemoryTier.fromType(MemoryType.user), MemoryTier.permanent);
      expect(MemoryTier.fromType(MemoryType.feedback), MemoryTier.crossSession);
      expect(MemoryTier.fromType(MemoryType.project), MemoryTier.crossSession);
      expect(MemoryTier.fromType(MemoryType.reference), MemoryTier.crossSession);
    });

    test('没有任何 type 派生为 short_term', () {
      for (final t in MemoryType.values) {
        expect(MemoryTier.fromType(t), isNot(MemoryTier.shortTerm),
            reason: '$t 不该自动变成短期层');
      }
    });

    test('显式 tier 胜出', () {
      final e = longEntry(type: MemoryType.user, tier: MemoryTier.shortTerm);
      expect(e.effectiveTier, MemoryTier.shortTerm);
    });

    test('非法 tier 串按缺失处理（回落到 type 派生）', () {
      expect(MemoryTier.parse('forever'), isNull);
      final e = longEntry();
      final back = MemoryEntry.fromJson(<String, dynamic>{
        ...e.toJson(),
        'tier': 'forever',
      });
      expect(back.tier, isNull);
      expect(back.effectiveTier, MemoryTier.permanent);
    });

    test('permanent 永不自动遗忘（硬不变量）', () {
      // 显式与派生两条路都必须关上，漏一条就等于给蒸馏开了后门。
      expect(longEntry(type: MemoryType.user).forgetEligible, isFalse);
      expect(longEntry(type: MemoryType.user, tier: MemoryTier.permanent).forgetEligible, isFalse);
      expect(longEntry(type: MemoryType.project).forgetEligible, isTrue);
      expect(longEntry(type: MemoryType.project, tier: MemoryTier.shortTerm).forgetEligible, isTrue);
    });

    test('promote 逐级上升，到顶不变', () {
      expect(MemoryTier.shortTerm.next, MemoryTier.crossSession);
      expect(MemoryTier.crossSession.next, MemoryTier.permanent);
      expect(MemoryTier.permanent.next, MemoryTier.permanent);
    });
  });

  group('JSON 形状与 memdir frontmatter 兼容', () {
    test('键名与 frontmatter 一致', () {
      final json = longEntry(tier: MemoryTier.crossSession).toJson();
      expect(json['name'], '常用编辑器');
      expect(json['description'], '');
      expect(json['type'], 'user');
      expect(json['tier'], 'cross_session');
      expect(json['body'], isA<String>());
      expect(json['recallCount'], 0);
      // ISO-8601 UTC，和平台 frontmatter 的 `updated` 同一形状
      expect(json['updated'], isA<String>());
      expect(json['updated'] as String, endsWith('Z'));
    });

    test('无显式 tier 时不写 tier 键', () {
      // 与 memdir 一致：读取侧从 type 派生，老记录无需迁移。
      final json = longEntry().toJson();
      expect(json.containsKey('tier'), isFalse);
    });

    test('未知 type 落回 user，且因此进永久层', () {
      final back = MemoryEntry.fromJson(<String, dynamic>{
        'id': 'x',
        'name': 'n',
        'type': 'projct',
        'body': 'b',
        'updated': '2026-01-01T00:00:00.000Z',
        'recallCount': 2,
      });
      expect(back.type, MemoryType.user);
      expect(back.effectiveTier, MemoryTier.permanent);
      expect(back.forgetEligible, isFalse);
    });

    test('recallCount 与每个字段都能往返', () {
      final e = longEntry(
        id: 'feedback_x1',
        name: '回复偏好',
        description: '喜欢先结论后展开',
        type: MemoryType.feedback,
        tier: MemoryTier.crossSession,
        recallCount: 7,
      );
      final back = MemoryEntry.fromJson(e.toJson());
      expect(back.id, e.id);
      expect(back.name, e.name);
      expect(back.description, e.description);
      expect(back.type, e.type);
      expect(back.tier, e.tier);
      expect(back.body, e.body);
      expect(back.updatedMs, e.updatedMs);
      expect(back.recallCount, 7);
    });

    test('字段类型被写坏时不抛', () {
      // 这些字节在 secure storage 里，可能被手改或写坏。`as String` 遇到 int
      // 会抛，异常会一路穿过列表打到界面上，表现成「一开记忆列表就白屏」。
      final back = MemoryEntry.fromJson(<String, dynamic>{
        'id': 42,
        'name': <String>['x'],
        'type': 7,
        'updated': 'not-a-date',
        'recallCount': '3',
      });
      expect(back.id, '');
      expect(back.name, '');
      expect(back.type, MemoryType.user);
      expect(back.recallCount, 0);
    });
  });

  group('store 增删查', () {
    test('remember → find → listAll', () async {
      final store = MemoryStore.instance;
      final a = await store.remember(
        type: MemoryType.user,
        name: '住在杭州',
        body: '用户常驻杭州，周末有时去上海。',
      );
      final b = await store.remember(
        type: MemoryType.project,
        name: '手机版记忆工程',
        body: '正在给 khy-os 手机版补主动召回与蒸馏。',
      );

      expect(a.id, startsWith('user_'));
      expect(b.id, startsWith('project_'));

      final found = await store.find(a.id);
      expect(found, isNotNull);
      expect(found!.name, '住在杭州');

      final all = await store.listAll();
      expect(all.length, 2);
      expect(all.map((e) => e.id), containsAll(<String>[a.id, b.id]));
    });

    test('listAll 按写入时间新的在前', () async {
      final store = MemoryStore.instance;
      final old = await store.remember(
        type: MemoryType.project,
        name: '旧项目',
        body: '上个季度的事情，已经收尾了。',
        updated: DateTime.utc(2026, 1, 1),
      );
      final fresh = await store.remember(
        type: MemoryType.project,
        name: '新项目',
        body: '本周启动的事情，还在进行。',
        updated: DateTime.utc(2026, 11, 1),
      );
      final all = await store.listAll();
      expect(all.first.id, fresh.id);
      expect(all.last.id, old.id);
    });

    test('update 覆盖同 id，不新增条目', () async {
      final store = MemoryStore.instance;
      final e = await store.remember(
        type: MemoryType.project,
        name: '项目背景',
        body: '最初一版描述。',
      );
      await store.update(e.copyWith(body: '改过的描述。'));
      final all = await store.listAll();
      expect(all.length, 1);
      expect(all.single.body, '改过的描述。');
    });

    test('noteRecall 只加召回数，不动写入时间', () async {
      final store = MemoryStore.instance;
      final e = await store.remember(
        type: MemoryType.reference,
        name: '文档站',
        body: 'khy-os 的文档站地址与目录结构说明。',
      );
      await store.noteRecall(<String>[e.id]);
      await store.noteRecall(<String>[e.id]);
      final back = await store.find(e.id);
      expect(back!.recallCount, 2);
      expect(back.updatedMs, e.updatedMs);
    });

    test('noteRecall 对不存在的 id 静默跳过', () async {
      final store = MemoryStore.instance;
      await store.noteRecall(<String>['nope']);
      expect(await store.listAll(), isEmpty);
    });

    test('forget 移入归档，listAll 不再有它', () async {
      final store = MemoryStore.instance;
      final e = await store.remember(
        type: MemoryType.project,
        name: '已完结项目',
        body: '这个项目已经收尾，不再需要上下文。',
      );
      final record = await store.forget(
        e.id,
        reason: 'stale',
        detail: '已 200 天未更新',
      );
      expect(record, isNotNull);
      expect(record!.id, e.id);
      expect(record.reason, 'stale');

      expect(await store.find(e.id), isNull);
      expect(await store.listAll(), isEmpty);

      final archived = await store.listArchived();
      expect(archived.length, 1);
      expect(archived.single.detail, '已 200 天未更新');
    });

    test('restore 原样恢复，归档清单随之清空', () async {
      final store = MemoryStore.instance;
      final e = await store.remember(
        type: MemoryType.project,
        name: '误归档的项目',
        body: '被蒸馏误判为陈旧，其实还在用。',
      );
      await store.forget(e.id, reason: 'stale', detail: '误判');
      final back = await store.restore(e.id);

      expect(back, isNotNull);
      expect(back!.id, e.id);
      expect(back.name, e.name);
      expect(back.body, e.body);
      expect(await store.listArchived(), isEmpty);
      expect((await store.listAll()).length, 1);
    });

    test('两次归档各留一份，恢复只动那一条', () async {
      final store = MemoryStore.instance;
      final first = await store.remember(
        type: MemoryType.project,
        name: '第一条',
        body: '第一次归档时的正文。',
      );
      final second = await store.remember(
        type: MemoryType.project,
        name: '第二条',
        body: '第二次写入的正文，内容变了。',
      );
      await store.forget(first.id, reason: 'stale', detail: '第一次');
      await store.forget(second.id, reason: 'duplicate', detail: '第二次');

      final archived = await store.listArchived();
      expect(archived.length, 2);

      final restored = await store.restore(second.id);
      expect(restored, isNotNull);
      expect(restored!.body, '第二次写入的正文，内容变了。');
      expect((await store.listArchived()).length, 1);
      expect((await store.listArchived()).single.id, first.id);
    });

    test('permanent 记忆拒绝归档，库里与归档里都不动', () async {
      final store = MemoryStore.instance;
      final e = await store.remember(
        type: MemoryType.user,
        name: '用户身份',
        body: '这是永久层记忆，任何自动遗忘都不得碰它。',
      );
      final record = await store.forget(e.id, reason: 'empty', detail: 'x');
      expect(record, isNull);
      expect(await store.find(e.id), isNotNull);
      expect(await store.listArchived(), isEmpty);
    });

    test('update 不复活已归档的条目', () async {
      final store = MemoryStore.instance;
      final e = await store.remember(
        type: MemoryType.project,
        name: '归档后又被编辑',
        body: '正文。',
      );
      await store.forget(e.id, reason: 'manual', detail: '用户手动遗忘');
      await store.update(e);
      expect(await store.find(e.id), isNull);
      expect((await store.listArchived()).length, 1);
    });

    test('restore 遇到同 id 活条目时拒绝覆盖', () async {
      final store = MemoryStore.instance;
      final e = await store.remember(
        type: MemoryType.project,
        name: '同名',
        body: '归档前的正文。',
      );
      await store.forget(e.id, reason: 'stale', detail: '误判');

      // 没有 API 能造出 id 冲突（remember 带随机后缀），所以这里直接往存储里
      // 塞一条同 id 的活条目，模拟「恢复之前用户又写了一条」。护栏要防的正是
      // 这种它自己造不出来的情况。
      await storage.write(
        key: 'mem_entry_${e.id}',
        value: jsonEncode(e.copyWith(body: '恢复前用户又写了一条新的。').toJson()),
      );

      final back = await store.restore(e.id);
      expect(back, isNull);
      expect((await store.listArchived()).length, 1);
      expect((await store.find(e.id))!.body, '恢复前用户又写了一条新的。');
    });

    test('promote 升到永久层后仍可被继续查找', () async {
      final store = MemoryStore.instance;
      final e = await store.remember(
        type: MemoryType.project,
        name: '要升层的项目',
        body: '这个项目的背景被反复确认，值得永久保留。',
      );
      expect(e.effectiveTier, MemoryTier.crossSession);
      final raised = await store.promote(e.id);
      expect(raised, isNotNull);
      expect(raised!.effectiveTier, MemoryTier.permanent);
      expect(raised.tier, MemoryTier.permanent);

      final again = await store.promote(e.id);
      expect(again!.effectiveTier, MemoryTier.permanent);

      // 升层之后蒸馏再也动不了它
      expect((await store.find(e.id))!.forgetEligible, isFalse);
    });

    test('promote 对不存在的 id 返回 null', () async {
      expect(await MemoryStore.instance.promote('nope'), isNull);
    });

    test('索引被写坏时按空库处理，不抛', () async {
      await storage.write(key: 'mem_index', value: '{ 这不是 JSON');
      expect(await MemoryStore.instance.listAll(), isEmpty);
    });

    test('单条记忆被写坏时只丢那一条', () async {
      final store = MemoryStore.instance;
      final good = await store.remember(
        type: MemoryType.project,
        name: '好的那条',
        body: '这条是好的。',
      );
      final bad = await store.remember(
        type: MemoryType.project,
        name: '坏的那条',
        body: '这条会被写坏。',
      );
      await storage.write(key: 'mem_entry_${bad.id}', value: '坏数据');

      final all = await store.listAll();
      expect(all.length, 1);
      expect(all.single.id, good.id);
    });
  });
}
