import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:khy_os_client/core/mirror/amoo_mirror_account_store.dart';
import 'package:khy_os_client/core/mirror/amoo_mirror_cache.dart';
import 'package:khy_os_client/core/mirror/amoo_mirror_models.dart';
import 'package:khy_os_client/core/mirror/amoo_mirror_sync.dart';
import 'package:khy_os_client/ui/screens/amoo_mirror_detail_screen.dart';
import 'package:khy_os_client/ui/screens/amoo_mirror_list_screen.dart';
import 'package:khy_os_client/ui/theme/app_theme.dart';
import 'package:khy_os_client/ui/widgets/amoo_mirror_config_section.dart';
import 'package:flutter_test/flutter_test.dart';

/// 对话记录界面的行为护栏。
///
/// 这些用例钉的是「只读镜像」在界面侧的三个事实：列表按 agentKey 分组不串会话、
/// 详情按 timestamp 线性不建树、以及整棵树上没有任何跳转 Amoo 的动作。
/// 假件都走构造注入（cache/sync/accounts/client），不碰 sqflite 与 secure
/// storage——主机上没有 sqlite3.dll，那两层只能上真机。
void main() {
  AmooMirrorSession session(
    String id, {
    String agentKey = 'amoo',
    String title = '联调记录',
    int updatedAt = 1000,
    bool compacted = false,
    int messageCount = 4,
    String lastPreview = '预览',
  }) {
    return AmooMirrorSession(
      id: id,
      title: title,
      updatedAt: updatedAt,
      lastPreview: lastPreview,
      messageCount: messageCount,
      agentKey: agentKey,
      compacted: compacted,
    );
  }

  AmooMirrorMessage message(
    String id, {
    required AmooMirrorRole role,
    String sessionId = 's-amoo-001',
    int timestamp = 1000,
    String? parentId,
    List<AmooMirrorBlock> blocks = const <AmooMirrorBlock>[],
  }) {
    return AmooMirrorMessage(
      id: id,
      sessionId: sessionId,
      parentId: parentId,
      timestamp: timestamp,
      role: role,
      blocks: blocks,
    );
  }

  Widget host(Widget child) =>
      MaterialApp(theme: AppTheme.dark(), home: Scaffold(body: child));

  group('列表页', () {
    testWidgets('按 agentKey 分组，compacted 会话带徽标', (tester) async {
      final cache = _FakeCache(sessions: <AmooMirrorSession>[
        session('s-amoo-001', updatedAt: 1000),
        session('s-research-002',
            agentKey: 'researcher', updatedAt: 2000, compacted: true),
        session('s-code-003', title: '长会话压测', updatedAt: 500),
      ]);
      await tester.pumpWidget(host(AmooMirrorListScreen(
        cache: cache,
        sync: _FakeSync(cache),
      )));
      await tester.pumpAndSettle();

      expect(find.text('amoo'), findsOneWidget);
      expect(find.text('researcher'), findsOneWidget);
      expect(find.text('2'), findsOneWidget);
      expect(find.text('1'), findsOneWidget);
      expect(find.text('联调记录'), findsNWidgets(2));
      expect(find.text('已压缩'), findsOneWidget);
    });

    testWidgets('满一页时提示只显示最近 50 个', (tester) async {
      final cache = _FakeCache(
        sessions: <AmooMirrorSession>[
          for (var i = 0; i < 50; i++) session('s-$i', updatedAt: 1000 + i),
        ],
      );
      await tester.pumpWidget(host(AmooMirrorListScreen(
        cache: cache,
        sync: _FakeSync(cache),
      )));
      await tester.pumpAndSettle();

      // 提示在列表末尾，ListView 惰性构建——滚到底才算进树（accessibility_one_tap_test
      // 里同款手写循环，scrollUntilVisible 在这个版本上有空 finder 崩溃问题）。
      for (var i = 0;
          i < 40 && !tester.any(find.text('仅显示最近 50 个会话'));
          i++) {
        await tester.drag(find.byType(Scrollable).first, const Offset(0, -600));
        await tester.pumpAndSettle();
      }
      expect(find.text('仅显示最近 50 个会话'), findsOneWidget);
    });

    testWidgets('空态：未配置', (tester) async {
      final cache = _FakeCache();
      await tester.pumpWidget(host(AmooMirrorListScreen(
        cache: cache,
        sync: _FakeSync(cache)
          ..pushState(const AmooMirrorSyncState(
            status: AmooMirrorSyncStatus.unconfigured,
          )),
      )));
      await tester.pumpAndSettle();
      expect(find.text('尚未配置对话记录服务'), findsOneWidget);
      expect(find.text('去配置'), findsOneWidget);
    });

    testWidgets('空态：同步失败且没有缓存', (tester) async {
      final cache = _FakeCache();
      await tester.pumpWidget(host(AmooMirrorListScreen(
        cache: cache,
        sync: _FakeSync(cache)
          ..pushState(const AmooMirrorSyncState(
            status: AmooMirrorSyncStatus.ok,
            message: '同步失败，展示缓存（第 1/3 次）',
          ))
          ..sessionsOutcome = AmooMirrorSyncOutcome.offline,
      )));
      await tester.pumpAndSettle();
      expect(find.text('同步失败，暂无可展示的缓存'), findsOneWidget);
      expect(find.text('重试'), findsOneWidget);
    });

    testWidgets('空态：缓存库打不开也算没拿到', (tester) async {
      final cache = _FakeCache(available: false);
      await tester.pumpWidget(host(AmooMirrorListScreen(
        cache: cache,
        sync: _FakeSync(cache)
          ..pushState(const AmooMirrorSyncState(
            status: AmooMirrorSyncStatus.offline,
            message: '本地缓存不可用：对话记录既读不出也写不进，请重启应用',
          ))
          ..sessionsOutcome = AmooMirrorSyncOutcome.storageUnavailable,
      )));
      await tester.pumpAndSettle();
      expect(find.text('同步失败，暂无可展示的缓存'), findsOneWidget);
    });

    testWidgets('空态：真的没有会话', (tester) async {
      final cache = _FakeCache();
      await tester.pumpWidget(host(AmooMirrorListScreen(
        cache: cache,
        sync: _FakeSync(cache),
      )));
      await tester.pumpAndSettle();
      expect(find.text('没有会话记录'), findsOneWidget);
    });

    testWidgets('横幅：离线，展示缓存', (tester) async {
      final cache = _FakeCache(sessions: <AmooMirrorSession>[
        session('s-amoo-001'),
      ]);
      await tester.pumpWidget(host(AmooMirrorListScreen(
        cache: cache,
        sync: _FakeSync(cache)
          ..pushState(const AmooMirrorSyncState(
            status: AmooMirrorSyncStatus.offline,
            consecutiveFailures: 3,
            message: '离线，展示缓存',
          )),
      )));
      await tester.pumpAndSettle();
      expect(find.text('离线，展示缓存'), findsOneWidget);
    });

    testWidgets('横幅：未授权，需要配对', (tester) async {
      final cache = _FakeCache(sessions: <AmooMirrorSession>[
        session('s-amoo-001'),
      ]);
      await tester.pumpWidget(host(AmooMirrorListScreen(
        cache: cache,
        sync: _FakeSync(cache)
          ..pushState(const AmooMirrorSyncState(
            status: AmooMirrorSyncStatus.needsPairing,
            message: '未授权 (401)：设备令牌无效或过期，请在设置「对话记录」重新配对（粘贴 device_token）',
          )),
      )));
      await tester.pumpAndSettle();
      expect(find.textContaining('未授权 (401)'), findsOneWidget);
    });

    testWidgets('横幅：单次失败仍展示缓存（status 保持 ok）', (tester) async {
      final cache = _FakeCache(sessions: <AmooMirrorSession>[
        session('s-amoo-001'),
      ]);
      await tester.pumpWidget(host(AmooMirrorListScreen(
        cache: cache,
        sync: _FakeSync(cache)
          ..pushState(const AmooMirrorSyncState(
            status: AmooMirrorSyncStatus.ok,
            message: '同步失败，展示缓存（第 1/3 次）',
          )),
      )));
      await tester.pumpAndSettle();
      expect(find.text('同步失败，展示缓存（第 1/3 次）'), findsOneWidget);
    });

    testWidgets('横幅：更新于 HH:mm', (tester) async {
      final cache = _FakeCache(sessions: <AmooMirrorSession>[
        session('s-amoo-001'),
      ]);
      await tester.pumpWidget(host(AmooMirrorListScreen(
        cache: cache,
        sync: _FakeSync(cache)
          ..pushState(AmooMirrorSyncState(
            status: AmooMirrorSyncStatus.ok,
            lastSyncAt: DateTime(2026, 11, 18, 9, 5).millisecondsSinceEpoch,
          )),
      )));
      await tester.pumpAndSettle();
      expect(find.textContaining('更新于 11-18 09:05'), findsOneWidget);
    });

    testWidgets('点卡片把同一个 sync 实例交给详情页', (tester) async {
      final cache = _FakeCache(
        sessions: <AmooMirrorSession>[session('s-amoo-001')],
        messages: <AmooMirrorMessage>[
          message('m-001', role: AmooMirrorRole.user),
        ],
      );
      final sync = _FakeSync(cache);
      await tester.pumpWidget(host(AmooMirrorListScreen(
        cache: cache,
        sync: sync,
      )));
      await tester.pumpAndSettle();

      await tester.tap(find.text('联调记录'));
      await tester.pumpAndSettle();

      // 详情页 initState 就会同步一次：记录里出现这个 session id，即证明它拿到
      // 的是列表页注入的那一个 sync（否则请求会打到另一个假件上）。
      expect(sync.messageSyncs, <String>['s-amoo-001']);
      expect(find.byType(AmooMirrorDetailScreen), findsOneWidget);

      await tester.pageBack();
      await tester.pumpAndSettle();
      // 返回后列表重载并 force 重同步。
      expect(sync.sessionSyncs, 2);
    });

    testWidgets('整棵树没有跳转 Amoo 的动作', (tester) async {
      final cache = _FakeCache(sessions: <AmooMirrorSession>[
        session('s-amoo-001'),
      ]);
      await tester.pumpWidget(host(AmooMirrorListScreen(
        cache: cache,
        sync: _FakeSync(cache),
      )));
      await tester.pumpAndSettle();

      expect(find.textContaining('打开 Amoo'), findsNothing);
      expect(find.textContaining('继续对话'), findsNothing);
    });
  });

  group('详情页', () {
    testWidgets('user 右 / assistant 左，tool 块默认折叠可展开', (tester) async {
      final cache = _FakeCache(
        sessions: <AmooMirrorSession>[session('s-amoo-001')],
        messages: <AmooMirrorMessage>[
          message('u-1', role: AmooMirrorRole.user, timestamp: 1000),
          message('a-1',
              role: AmooMirrorRole.assistant,
              timestamp: 2000,
              parentId: 'u-1',
              blocks: <AmooMirrorBlock>[
                const AmooMirrorToolBlock(
                  name: 'read_file',
                  summary: '第一行摘要\n第二行不该出现在折叠行里',
                ),
              ]),
        ],
      );
      await tester.pumpWidget(host(AmooMirrorDetailScreen(
        session: cache.sessions.first,
        cache: cache,
        sync: _FakeSync(cache),
      )));
      await tester.pumpAndSettle();

      final userAlign = tester.widget<Align>(find
          .ancestor(
            of: find.byKey(const ValueKey('amoo-mirror-msg-u-1')),
            matching: find.byType(Align),
          )
          .first);
      expect(userAlign.alignment, Alignment.centerRight);

      final assistantAlign = tester.widget<Align>(find
          .ancestor(
            of: find.byKey(const ValueKey('amoo-mirror-msg-a-1')),
            matching: find.byType(Align),
          )
          .first);
      expect(assistantAlign.alignment, Alignment.centerLeft);

      // 折叠行是一行：换行被 oneLine 吃掉，展开后才出现原文。
      expect(find.textContaining('工具 read_file · 第一行摘要 第二行不该出现在折叠行里'),
          findsOneWidget);
      expect(find.textContaining('第一行摘要\n第二行'), findsNothing);

      await tester.tap(find.textContaining('工具 read_file ·'));
      await tester.pumpAndSettle();
      expect(find.textContaining('第一行摘要\n第二行不该出现在折叠行里'),
          findsOneWidget);
    });

    testWidgets('正文超 800 字符打截断标记，点击展开全文', (tester) async {
      final long = '正' * 900;
      final cache = _FakeCache(
        sessions: <AmooMirrorSession>[session('s-amoo-001')],
        messages: <AmooMirrorMessage>[
          message('a-1',
              role: AmooMirrorRole.assistant,
              timestamp: 1000,
              blocks: <AmooMirrorBlock>[AmooMirrorTextBlock(long)]),
        ],
      );
      await tester.pumpWidget(host(AmooMirrorDetailScreen(
        session: cache.sessions.first,
        cache: cache,
        sync: _FakeSync(cache),
      )));
      await tester.pumpAndSettle();

      expect(find.text('已截断 · 点击展开全文'), findsOneWidget);
      // 截断后只渲染前 800 字符 + 省略号。
      expect(find.text('${'正' * 800}…'), findsOneWidget);

      // 900 字正文把标记挤到首屏外，先滚出来再点。
      await tester.ensureVisible(find.text('已截断 · 点击展开全文'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('已截断 · 点击展开全文'));
      await tester.pumpAndSettle();
      expect(find.text(long), findsOneWidget);
    });

    testWidgets('渲染前脱敏：路径与令牌样式串被替换', (tester) async {
      final cache = _FakeCache(
        sessions: <AmooMirrorSession>[session('s-amoo-001')],
        messages: <AmooMirrorMessage>[
          message('a-1',
              role: AmooMirrorRole.assistant,
              timestamp: 1000,
              blocks: <AmooMirrorBlock>[
                const AmooMirrorTextBlock(
                  '库文件在 C:\\Users\\dev\\khy-os\\lib\\core\\db\\amoo_mirror_store.dart，'
                  '令牌是 Bearer mirror-device-token-0001。',
                ),
              ]),
        ],
      );
      await tester.pumpWidget(host(AmooMirrorDetailScreen(
        session: cache.sessions.first,
        cache: cache,
        sync: _FakeSync(cache),
      )));
      await tester.pumpAndSettle();

      expect(find.textContaining('C:\\Users\\dev'), findsNothing);
      expect(find.textContaining('mirror-device-token-0001'), findsNothing);
      expect(find.textContaining('[路径]'), findsOneWidget);
      expect(find.textContaining('[已脱秘]'), findsOneWidget);
    });

    testWidgets('compacted 会话有横幅，整棵树没有跳转 Amoo 的动作', (tester) async {
      final cache = _FakeCache(
        sessions: <AmooMirrorSession>[
          session('s-research-002', compacted: true, agentKey: 'researcher'),
        ],
        messages: <AmooMirrorMessage>[
          message('r-001', role: AmooMirrorRole.user, timestamp: 1000),
        ],
      );
      await tester.pumpWidget(host(AmooMirrorDetailScreen(
        session: cache.sessions.first,
        cache: cache,
        sync: _FakeSync(cache),
      )));
      await tester.pumpAndSettle();

      expect(find.textContaining('该会话历史已被压缩'), findsOneWidget);
      expect(find.text('打开 Amoo'), findsNothing);
      expect(find.text('继续对话'), findsNothing);
    });

    testWidgets('下拉刷新再同步一次', (tester) async {
      final cache = _FakeCache(
        sessions: <AmooMirrorSession>[session('s-amoo-001')],
        messages: <AmooMirrorMessage>[
          message('m-001', role: AmooMirrorRole.user, timestamp: 1000),
        ],
      );
      final sync = _FakeSync(cache);
      await tester.pumpWidget(host(AmooMirrorDetailScreen(
        session: cache.sessions.first,
        cache: cache,
        sync: sync,
      )));
      await tester.pumpAndSettle();
      expect(sync.messageSyncs, <String>['s-amoo-001']);

      await tester.drag(find.byType(ListView).first, const Offset(0, 300));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 600));

      expect(sync.messageSyncs, <String>['s-amoo-001', 's-amoo-001']);
    });

    testWidgets('404 时本地副本仍可看，且不出现「打开 Amoo」', (tester) async {
      final cache = _FakeCache(
        sessions: <AmooMirrorSession>[session('s-amoo-001')],
        messages: <AmooMirrorMessage>[
          message('m-001', role: AmooMirrorRole.user, timestamp: 1000),
        ],
      );
      await tester.pumpWidget(host(AmooMirrorDetailScreen(
        session: cache.sessions.first,
        cache: cache,
        sync: _FakeSync(cache)
          ..messagesOutcome = AmooMirrorSyncOutcome.sessionGone,
      )));
      await tester.pumpAndSettle();

      expect(find.textContaining('服务端已无此会话'), findsOneWidget);
      expect(find.byKey(const ValueKey('amoo-mirror-msg-m-001')), findsOneWidget);
    });
  });

  group('配置块', () {
    testWidgets('保存走注入的 accounts，并闭合配对闸门', (tester) async {
      final accounts = _FakeAccounts();
      final sync = _FakeSync(_FakeCache());
      await tester.pumpWidget(host(AmooMirrorConfigSection(
        accounts: accounts,
        sync: sync,
      )));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).first, 'http://127.0.0.1:8931');
      await tester.enterText(
          find.byType(TextField).at(1), 'mirror-device-token-0001');
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();

      expect(accounts.saved, isNotNull);
      expect(accounts.saved!.baseUrl, 'http://127.0.0.1:8931');
      expect(accounts.saved!.deviceToken, 'mirror-device-token-0001');
      expect(sync.pairingAcknowledged, isTrue);
    });

    testWidgets('「填入内置 mock」chip 填的是 endpoint_defaults 的那一处',
        (tester) async {
      final accounts = _FakeAccounts();
      await tester.pumpWidget(host(AmooMirrorConfigSection(
        accounts: accounts,
        sync: _FakeSync(_FakeCache()),
      )));
      await tester.pumpAndSettle();

      await tester.tap(find.text('填入内置 mock'));
      await tester.pumpAndSettle();

      expect(tester.widget<TextField>(find.byType(TextField).first).controller!.text,
          'http://127.0.0.1:8931');
    });

    testWidgets('探测用的是屏幕上还没保存的值', (tester) async {
      final accounts = _FakeAccounts();
      final seen = <String>[];
      final client = MockClient((http.Request req) async {
        seen.add(req.url.toString());
        return http.Response.bytes(
          utf8.encode(jsonEncode(<Object?>[
            <String, Object?>{
              'id': 's-1',
              'title': 't',
              'updatedAt': 1,
              'lastPreview': '',
              'messageCount': 1,
              'agentKey': 'amoo',
              'compacted': false,
            }
          ])),
          200,
          headers: <String, String>{'content-type': 'application/json'},
        );
      });
      await tester.pumpWidget(host(AmooMirrorConfigSection(
        accounts: accounts,
        client: client,
        sync: _FakeSync(_FakeCache()),
      )));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).first, 'http://127.0.0.1:9999');
      await tester.enterText(find.byType(TextField).at(1), 'tok');
      await tester.tap(find.text('测试连接'));
      await tester.pumpAndSettle();

      expect(seen, hasLength(1));
      expect(seen.single, startsWith('http://127.0.0.1:9999/sessions?'));
      expect(find.textContaining('连接成功'), findsOneWidget);
      // 探测不等于保存：accounts 里还是空的。
      expect(accounts.saved, isNull);
    });
  });
}

/// 内存缓存假件。**loadSessions 的 limit 默认值必须重复写一遍**：抽象方法省略
/// 默认值即 missing_default_value_for_parameter（amoo_mirror_cache.dart 头注）。
class _FakeCache implements AmooMirrorCache {
  _FakeCache({
    this.sessions = const <AmooMirrorSession>[],
    this.messages = const <AmooMirrorMessage>[],
    this.available = true,
  });

  List<AmooMirrorSession> sessions;
  List<AmooMirrorMessage> messages;
  final bool available;
  final Map<String, String?> cursors = <String, String?>{};

  @override
  Future<List<AmooMirrorSession>> loadSessions(
      {int limit = kAmooMirrorSessionsLimit}) async {
    return sessions.take(limit).toList();
  }

  @override
  Future<AmooMirrorSession?> loadSession(String sessionId) async {
    for (final s in sessions) {
      if (s.id == sessionId) return s;
    }
    return null;
  }

  @override
  Future<void> upsertSessions(List<AmooMirrorSession> next) async {
    sessions = next;
  }

  @override
  Future<String?> loadCursor(String sessionId) async => cursors[sessionId];

  @override
  Future<void> saveCursor(String sessionId, String? cursor) async {
    cursors[sessionId] = cursor;
  }

  @override
  Future<int> insertMessages(
      String sessionId, List<AmooMirrorMessage> next) async {
    messages = <AmooMirrorMessage>[...messages, ...next];
    return next.length;
  }

  @override
  Future<List<AmooMirrorMessage>> loadMessages(String sessionId) async {
    return messages.where((m) => m.sessionId == sessionId).toList();
  }

  @override
  bool get isAvailable => available;
}

/// 记录型假同步器。AmooMirrorSync 刻意不标 final，就是为了让这个子类存在。
class _FakeSync extends AmooMirrorSync {
  _FakeSync(AmooMirrorCache cache) : super(cache: cache);

  AmooMirrorSyncState _state = const AmooMirrorSyncState();
  final List<String> messageSyncs = <String>[];
  int sessionSyncs = 0;
  bool pairingAcknowledged = false;
  AmooMirrorSyncOutcome sessionsOutcome = AmooMirrorSyncOutcome.ok;
  AmooMirrorSyncOutcome messagesOutcome = AmooMirrorSyncOutcome.ok;

  @override
  AmooMirrorSyncState get state => _state;

  void pushState(AmooMirrorSyncState next) {
    _state = next;
    notifyListeners();
  }

  @override
  Future<void> ensureReady() async {}

  @override
  Future<AmooMirrorSyncOutcome> syncSessions({bool force = false}) async {
    sessionSyncs++;
    return sessionsOutcome;
  }

  @override
  Future<AmooMirrorSyncOutcome> syncMessages(
    String sessionId, {
    bool force = false,
  }) async {
    messageSyncs.add(sessionId);
    return messagesOutcome;
  }

  @override
  void acknowledgePairing() {
    pairingAcknowledged = true;
  }
}

/// 内存账号假件：覆盖读写，真实 store 的 FlutterSecureStorage 一次都不碰。
class _FakeAccounts extends AmooMirrorAccountStore {
  AmooMirrorAccount? stored;
  AmooMirrorAccount? saved;

  @override
  Future<AmooMirrorAccount?> load() async => stored;

  @override
  Future<void> save(AmooMirrorAccount account) async {
    saved = account;
    stored = account;
  }
}
