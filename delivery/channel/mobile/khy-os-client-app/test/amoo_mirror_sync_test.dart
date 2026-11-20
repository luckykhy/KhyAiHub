import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:khy_os_client/core/mirror/amoo_mirror_account_store.dart';
import 'package:khy_os_client/core/mirror/amoo_mirror_cache.dart';
import 'package:khy_os_client/core/mirror/amoo_mirror_models.dart';
import 'package:khy_os_client/core/mirror/amoo_mirror_sync.dart';

/// 同步状态机的纯逻辑测试：假 transport + 内存 cache + 子类化账号存储。
///
/// 为什么每个失败分支都要钉：这个类的失败不是抛异常，而是「换一句话继续展示
/// 缓存」。一次措辞退化成「同步中」或「没有会话」，用户在界面上看到的不是
/// 报错，是一个**谎**——所以每条横幅文案都在这里逐字断言。
///
/// 纪律：本文件不碰 sqflite（主机没有 sqlite3.dll，store 层只能真机验，
/// 同 test/amoo_turn_test.dart:6-9），也不起真实 socket。
void main() {
  const baseUrl = 'http://127.0.0.1:8931';

  http.Response jsonBody(Object? body, int status,
      {Map<String, String>? headers}) {
    return http.Response.bytes(
      utf8.encode(jsonEncode(body)),
      status,
      headers: <String, String>{
        'content-type': 'application/json; charset=utf-8',
        ...?headers,
      },
    );
  }

  Map<String, dynamic> sessionJson(String id,
      {String agentKey = 'amoo', int updatedAt = 1000}) {
    return <String, dynamic>{
      'id': id,
      'title': '会话 $id',
      'updatedAt': updatedAt,
      'lastPreview': '预览 $id',
      'messageCount': 1,
      'agentKey': agentKey,
      'compacted': false,
    };
  }

  Map<String, dynamic> messageJson(String id, int ts,
      {String role = 'user', Object? blocks}) {
    return <String, dynamic>{
      'id': id,
      'timestamp': ts,
      'role': role,
      'blocks': blocks ??
          <dynamic>[
            <String, dynamic>{'type': 'text', 'text': '正文 $id'},
          ],
    };
  }

  /// 假服务端：cursor 排他翻页，hasMore=false 仍返回最后一条的 <ts>:<id>
  /// （契约如此——验证 3「第二轮带 cursor」押在它上面）。
  Future<http.Response> Function(http.Request) cursorPaging(
    List<Map<String, dynamic>> messages, {
    int pageSize = 200,
  }) {
    return (req) async {
      final cursor = AmooMirrorCursor.parse(req.url.queryParameters['cursor']);
      // 测试数据时间戳互不相同，所以「严格晚于该时间」与「严格晚于 (ts,id)」
      // 等价；同秒消息的次序由服务端定，端侧不猜。
      final visible = cursor == null
          ? messages
          : messages
              .where((m) => (m['timestamp'] as int) > cursor.timestamp)
              .toList();
      final page = visible.take(pageSize).toList();
      final last = page.isEmpty ? null : page.last;
      return jsonBody(<String, dynamic>{
        'items': page,
        'nextCursor': last == null ? '' : '${last['timestamp']}:${last['id']}',
        'hasMore': visible.length > page.length,
      }, 200);
    };
  }

  Future<http.Response> Function(http.Request) okStep(Object? body) =>
      (req) async => jsonBody(body, 200);

  Future<http.Response> Function(http.Request) statusStep(
    int status, {
    String? retryAfter,
  }) {
    return (req) async => jsonBody(
      <String, dynamic>{'error': 'boom'},
      status,
      headers: retryAfter == null
          ? null
          : <String, String>{'retry-after': retryAfter},
    );
  }

  Future<http.Response> Function(http.Request) transportStep() =>
      (req) async => throw const SocketException('connection refused');

  group('夹具', () {
    late _Fixture fx;

    setUp(() => fx = _Fixture());

    test('内存 cache 重复写了 loadSessions 的 limit 默认值（接口注释钉的坑）', () {
      // 抽象方法省略默认值是 missing_default_value_for_parameter 编译错误；
      // 这里能编译就说明假件没漏写。
      expect(fx.cache.loadSessions(), isA<Future<List<AmooMirrorSession>>>());
    });

    test('未配置时 ensureReady 零请求', () async {
      await fx.sync.ensureReady();
      expect(fx.requests, isEmpty);
      expect(fx.sync.state.status, AmooMirrorSyncStatus.unconfigured);
      expect(fx.sync.state.message, contains('尚未配置'));
    });

    test('有端点没 token → needsPairing，零请求', () async {
      fx.accounts.account =
          const AmooMirrorAccount(baseUrl: baseUrl, deviceToken: '', pairedAt: 0);
      await fx.sync.ensureReady();
      expect(fx.requests, isEmpty);
      expect(fx.sync.state.status, AmooMirrorSyncStatus.needsPairing);
      expect(fx.sync.state.message, contains('尚未配对'));
    });

    test('两者皆有 → idle', () async {
      fx.accounts.account =
          const AmooMirrorAccount(baseUrl: baseUrl, deviceToken: 'tok-1', pairedAt: 1);
      await fx.sync.ensureReady();
      expect(fx.requests, isEmpty);
      expect(fx.sync.state.status, AmooMirrorSyncStatus.idle);
      expect(fx.sync.state.message, isNull);
    });

    test('本地库不可用 → storageUnavailable，零请求', () async {
      fx.cache.available = false;
      fx.accounts.account =
          const AmooMirrorAccount(baseUrl: baseUrl, deviceToken: 'tok-1', pairedAt: 1);
      await fx.sync.ensureReady();
      expect(fx.requests, isEmpty);
      expect(fx.sync.state.status, AmooMirrorSyncStatus.offline);
      expect(fx.sync.state.message, contains('本地缓存不可用'));
      expect(await capture(fx.sync.syncSessions),
          AmooMirrorSyncOutcome.storageUnavailable);
      expect(fx.requests, isEmpty);
    });

    test('未配置时 syncSessions 也零请求', () async {
      expect(await capture(fx.sync.syncSessions),
          AmooMirrorSyncOutcome.unconfigured);
      expect(fx.requests, isEmpty);
    });
  });

  group('syncSessions', () {
    late _Fixture fx;

    setUp(() => fx = _Fixture(account: _account()));

    test('全量拉取 → upsert 合并 + ok + lastSyncAt', () async {
      fx.steps.add(okStep(<dynamic>[
        sessionJson('s-1', updatedAt: 2000),
        sessionJson('s-2', updatedAt: 1000),
      ]));
      final outcome = await capture(fx.sync.syncSessions);
      expect(outcome, AmooMirrorSyncOutcome.ok);
      expect(fx.requests.single.url.toString(),
          '$baseUrl/sessions?since=0&limit=50');
      expect(fx.cache.sessions.map((s) => s.id), unorderedEquals(<String>['s-1', 's-2']));
      expect(fx.sync.state.status, AmooMirrorSyncStatus.ok);
      expect(fx.sync.state.consecutiveFailures, 0);
      expect(fx.sync.state.lastSyncAt, fx.nowMs);
      expect(fx.sync.state.message, isNull);
    });

    test('并发同轮合流：两连发只打一个请求', () async {
      fx.steps.add(okStep(<dynamic>[sessionJson('s-1')]));
      final a = fx.sync.syncSessions();
      final b = fx.sync.syncSessions();
      expect(identical(a, b), isTrue,
          reason: '第二轮必须搭上在飞的那一轮，各发一会双倍打服务端');
      await Future.wait(<Future<AmooMirrorSyncOutcome>>[a, b]);
      expect(fx.requests, hasLength(1));
      expect(fx.exhausted, 0);
    });

    test('401 → needsPairing 一次请求；同 token 零请求；换 token 自动开闸', () async {
      fx.steps.add(statusStep(401));
      expect(await capture(fx.sync.syncSessions),
          AmooMirrorSyncOutcome.needsPairing);
      expect(fx.requests, hasLength(1));
      expect(fx.sync.state.status, AmooMirrorSyncStatus.needsPairing);
      expect(fx.sync.state.message, contains('未授权 (401)'));
      expect(fx.sync.state.consecutiveFailures, 0, reason: '401 不计连续失败');

      // 同一把 token 永不重试：再拉也不发请求（契约的「禁止静默重试」）。
      expect(await capture(fx.sync.syncSessions),
          AmooMirrorSyncOutcome.needsPairing);
      expect(fx.requests, hasLength(1));

      // 换一把 token 自动开闸。
      fx.accounts.account =
          const AmooMirrorAccount(baseUrl: baseUrl, deviceToken: 'tok-2', pairedAt: 2);
      fx.steps.add(okStep(<dynamic>[sessionJson('s-1')]));
      expect(await capture(fx.sync.syncSessions), AmooMirrorSyncOutcome.ok);
      expect(fx.requests, hasLength(2));
      expect(fx.requests.last.headers['authorization'], 'Bearer tok-2');
    });

    test('acknowledgePairing 显式开闸', () async {
      fx.steps.add(statusStep(401));
      await capture(fx.sync.syncSessions);
      fx.sync.acknowledgePairing();
      expect(fx.sync.state.status, AmooMirrorSyncStatus.idle);
      fx.steps.add(okStep(<dynamic>[sessionJson('s-1')]));
      expect(await capture(fx.sync.syncSessions), AmooMirrorSyncOutcome.ok);
      expect(fx.requests, hasLength(2));
    });

    test('429 → rateLimited + 守门零请求 + force 破闸 + 不计连续失败', () async {
      fx.steps.add(statusStep(429, retryAfter: '15'));
      expect(await capture(fx.sync.syncSessions),
          AmooMirrorSyncOutcome.rateLimited);
      expect(fx.sync.state.status, AmooMirrorSyncStatus.rateLimited);
      expect(fx.sync.state.notBeforeMs, fx.nowMs + 15000);
      expect(fx.sync.state.consecutiveFailures, 0, reason: '429 不计连续失败');

      expect(await capture(fx.sync.syncSessions),
          AmooMirrorSyncOutcome.rateLimited);
      expect(fx.requests, hasLength(1), reason: '未到期直接返回，不打网络');

      fx.steps.add(okStep(<dynamic>[sessionJson('s-1')]));
      expect(await capture(() => fx.sync.syncSessions(force: true)),
          AmooMirrorSyncOutcome.ok);
      expect(fx.requests, hasLength(2));
      expect(fx.sync.state.notBeforeMs, isNull, reason: '成功后守门清零');
    });

    test('Retry-After 小于 10s 被钳到 10s（key_pool 解析器的既定行为）', () async {
      // parseRetryAfterCooldown 的夹子是 [10s, 600s]（key_pool.dart:30/:33）。
      // 服务端真发 2s 时端侧会等 10s——宁可多等，不可把退避当成 0。
      fx.steps.add(statusStep(429, retryAfter: '2'));
      await capture(fx.sync.syncSessions);
      expect(fx.sync.state.notBeforeMs, fx.nowMs + 10000);
    });

    test('传输失败一次 → 「展示缓存」横幅且 status 保持 ok', () async {
      fx.steps.add(transportStep());
      fx.steps.add(transportStep()); // 本调用内重试那一次
      expect(await capture(fx.sync.syncSessions),
          AmooMirrorSyncOutcome.offline);
      expect(fx.sync.state.status, AmooMirrorSyncStatus.ok);
      expect(fx.sync.state.consecutiveFailures, 1);
      expect(fx.sync.state.message, '同步失败，展示缓存（第 1/3 次）');
      expect(fx.sync.state.lastSyncAt, isNull, reason: '失败不清上次成功时间');
    });

    test('重试前真的会等一会儿，不是立刻重放', () async {
      final slow = _Fixture(
        account: _account(),
        retryDelay: const Duration(milliseconds: 80),
      );
      slow.steps.add(transportStep());
      slow.steps.add(transportStep());
      final watch = Stopwatch()..start();
      await capture(slow.sync.syncSessions);
      watch.stop();
      // Future.delayed 只会晚不会早，所以这个下界是硬保证——它证明退避真的
      // 存在，而不是把同一个请求立刻重放打服务端。
      expect(watch.elapsedMilliseconds, greaterThanOrEqualTo(60));
      expect(slow.requests, hasLength(2));
    });

    test('连续三次 → 离线；再成功清零', () async {
      for (var i = 0; i < 3; i++) {
        fx.steps.add(transportStep());
        fx.steps.add(transportStep());
        await capture(fx.sync.syncSessions);
      }
      expect(fx.sync.state.status, AmooMirrorSyncStatus.offline);
      expect(fx.sync.state.consecutiveFailures, 3);
      expect(fx.sync.state.message, '离线，展示缓存');

      fx.steps.add(okStep(<dynamic>[sessionJson('s-1')]));
      expect(await capture(fx.sync.syncSessions), AmooMirrorSyncOutcome.ok);
      expect(fx.sync.state.status, AmooMirrorSyncStatus.ok);
      expect(fx.sync.state.consecutiveFailures, 0);
      expect(fx.sync.state.message, isNull);
    });

    test('端点热更：同一同步器下一轮打到新地址', () async {
      fx.steps.add(okStep(<dynamic>[]));
      await capture(fx.sync.syncSessions);
      fx.accounts.account =
          const AmooMirrorAccount(baseUrl: 'http://10.0.0.9:8787', deviceToken: 'tok-1', pairedAt: 1);
      fx.steps.add(okStep(<dynamic>[]));
      await capture(fx.sync.syncSessions);
      expect(fx.requests.last.url.toString(),
          'http://10.0.0.9:8787/sessions?since=0&limit=50');
    });
  });

  group('syncMessages', () {
    late _Fixture fx;

    setUp(() => fx = _Fixture(account: _account()));

    test('全量：不带 cursor 参数，消息与游标都落库', () async {
      fx.steps.add(cursorPaging(<Map<String, dynamic>>[
        messageJson('m-1', 1000),
        messageJson('m-2', 2000, role: 'assistant'),
      ]));
      final outcome = await capture(() => fx.sync.syncMessages('s-1'));
      expect(outcome, AmooMirrorSyncOutcome.ok);
      expect(fx.requests.single.url.queryParameters.containsKey('cursor'), isFalse);
      expect(fx.cache.messages.map((m) => m.id), <String>['m-1', 'm-2']);
      expect(fx.cache.cursors['s-1'], '2000:m-2',
          reason: 'hasMore=false 也存最后一条的游标，下一轮才续得上');
      expect(fx.sync.state.lastAdded, 2);
    });

    test('增量：第二轮带 cursor，只新增不重复', () async {
      final server = <Map<String, dynamic>>[
        messageJson('m-1', 1000),
        messageJson('m-2', 2000),
      ];
      fx.steps.add(cursorPaging(server));
      await capture(() => fx.sync.syncMessages('s-1'));

      // 同一会话又说了两句。
      server.add(messageJson('m-3', 3000));
      server.add(messageJson('m-4', 4000));
      fx.steps.add(cursorPaging(server));
      await capture(() => fx.sync.syncMessages('s-1'));

      expect(fx.requests.last.url.queryParameters['cursor'], '2000:m-2');
      expect(fx.cache.messages.map((m) => m.id),
          <String>['m-1', 'm-2', 'm-3', 'm-4']);
      expect(fx.sync.state.lastAdded, 2, reason: '上一轮新增条数是幂等的证据');
      expect(fx.cache.cursors['s-1'], '4000:m-4');
    });

    test('force 不清游标：force 后第二轮仍带 cursor', () async {
      final server = <Map<String, dynamic>>[messageJson('m-1', 1000)];
      fx.steps.add(cursorPaging(server));
      await capture(() => fx.sync.syncMessages('s-1'));
      fx.steps.add(cursorPaging(server));
      await capture(() => fx.sync.syncMessages('s-1', force: true));
      expect(fx.requests.last.url.queryParameters['cursor'], '1000:m-1',
          reason: 'force 只跳过节流，绝不清 cursor');
    });

    test('坏行（缺 id / 缺 blocks）被 api 丢掉，同步器不抛', () async {
      fx.steps.add(okStep(<String, dynamic>{
        'items': <dynamic>[
          <String, dynamic>{'timestamp': 1, 'role': 'user', 'blocks': <dynamic>[]},
          messageJson('m-ok', 2),
        ],
        'nextCursor': '2:m-ok',
        'hasMore': false,
      }));
      final outcome = await capture(() => fx.sync.syncMessages('s-1'));
      expect(outcome, AmooMirrorSyncOutcome.ok);
      expect(fx.cache.messages.map((m) => m.id), <String>['m-ok']);
      expect(fx.exhausted, 0);
    });

    test('404 → sessionGone，本地行不删', () async {
      fx.cache.messages.addAll(<AmooMirrorMessage>[
        AmooMirrorMessage(id: 'm-1', sessionId: 's-1', timestamp: 1, role: AmooMirrorRole.user),
      ]);
      fx.steps.add(statusStep(404));
      expect(await capture(() => fx.sync.syncMessages('s-1')),
          AmooMirrorSyncOutcome.sessionGone);
      expect(fx.cache.messages, hasLength(1), reason: '服务端没了也得让用户看缓存');
      expect(fx.sync.state.message, contains('会话不存在 (404)'));
    });

    test('409 一次 → 同调用内不带 cursor 整体重拉，历史不回退', () async {
      final server = <Map<String, dynamic>>[
        messageJson('m-1', 1000),
        messageJson('m-2', 2000),
      ];
      fx.steps.add(cursorPaging(server));
      await capture(() => fx.sync.syncMessages('s-1'));

      fx.steps.add(statusStep(409));
      fx.steps.add(cursorPaging(server));
      final outcome = await capture(() => fx.sync.syncMessages('s-1'));
      expect(outcome, AmooMirrorSyncOutcome.ok);
      expect(fx.requests[1].url.queryParameters['cursor'], '2000:m-2');
      expect(fx.requests[2].url.queryParameters.containsKey('cursor'), isFalse,
          reason: '重拉必须从头来，否则还是同一个失效游标');
      expect(fx.cache.messages, hasLength(2), reason: 'INSERT OR IGNORE 不重复也不删');
      expect(fx.cache.cursors['s-1'], '2000:m-2');
    });

    test('409 二次 → cursorStale 诚实截断，不发第三次', () async {
      fx.steps.add(statusStep(409));
      fx.steps.add(statusStep(409));
      expect(await capture(() => fx.sync.syncMessages('s-1')),
          AmooMirrorSyncOutcome.cursorStale);
      expect(fx.requests, hasLength(2), reason: '上限一次，不无限重拉');
      expect(fx.sync.state.status, AmooMirrorSyncStatus.ok,
          reason: '缓存照常展示，只是不再重拉');
      expect(fx.sync.state.message, contains('服务端持续拒绝游标 (409)'));
    });

    test('429 守门对消息同步同样生效', () async {
      fx.steps.add(statusStep(429, retryAfter: '5'));
      expect(await capture(() => fx.sync.syncMessages('s-1')),
          AmooMirrorSyncOutcome.rateLimited);
      expect(await capture(() => fx.sync.syncMessages('s-1')),
          AmooMirrorSyncOutcome.rateLimited);
      expect(fx.requests, hasLength(1));
    });

    test('hasMore 恒真 → 50 页截断，不死循环', () async {
      Future<http.Response> Function(http.Request) alwaysMore() {
        var n = 0;
        return (req) async {
          final id = 'm-p$n';
          n++;
          return jsonBody(<String, dynamic>{
            'items': <dynamic>[messageJson(id, 1000 + n)],
            'nextCursor': '${1000 + n}:$id',
            'hasMore': true,
          }, 200);
        };
      }

      for (var i = 0; i < 60; i++) {
        fx.steps.add(alwaysMore());
      }
      final outcome = await capture(() => fx.sync.syncMessages('s-1'));
      expect(outcome, AmooMirrorSyncOutcome.ok);
      expect(fx.requests, hasLength(kAmooMirrorMaxPages));
      expect(fx.exhausted, 0);
    });

    test('hasMore=true 但 nextCursor 为空 → 本轮到此为止', () async {
      fx.steps.add(okStep(<String, dynamic>{
        'items': <dynamic>[messageJson('m-1', 1000)],
        'nextCursor': '',
        'hasMore': true,
      }));
      final outcome = await capture(() => fx.sync.syncMessages('s-1'));
      expect(outcome, AmooMirrorSyncOutcome.ok);
      expect(fx.requests, hasLength(1));
      expect(fx.cache.cursors['s-1'], isNull, reason: '空游标按追平');
    });

    test('消息并发同轮合流', () async {
      fx.steps.add(cursorPaging(<Map<String, dynamic>>[messageJson('m-1', 1000)]));
      final a = fx.sync.syncMessages('s-1');
      final b = fx.sync.syncMessages('s-1');
      await Future.wait(<Future<AmooMirrorSyncOutcome>>[a, b]);
      expect(fx.requests, hasLength(1));
    });
  });

  group('Riverpod provider', () {
    test('同一个容器里读多少次都是同一个同步器', () {
      // 列表页与详情页共享一个实例，401 闸门与失败计数才对得上；各构造一份
      // 会出现「刚配完对的那个页面能用，另一个还在 needsPairing」。
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final first = container.read(amooMirrorSyncProvider);
      final second = container.read(amooMirrorSyncProvider);
      expect(identical(first, second), isTrue);
      expect(first, isA<AmooMirrorSync>());
    });
  });
}

AmooMirrorAccount _account() =>
    const AmooMirrorAccount(baseUrl: 'http://127.0.0.1:8931', deviceToken: 'tok-1', pairedAt: 1);

/// 把一次同步调用取出来：`Future<T> Function()` → `T`。
/// 包一层是为了让带命名参数的调用（force: true）也能直接塞进 expect。
Future<T?> capture<T>(Future<T> Function() call) async => call();

class _Fixture {
  _Fixture({
    AmooMirrorAccount? account,
    this.retryDelay = Duration.zero,
  })  : cache = _FakeCache(),
        accounts = _FakeAccounts(account) {
    sync = AmooMirrorSync(
      cache: cache,
      accounts: accounts,
      client: _buildClient(),
      clock: () => DateTime.fromMillisecondsSinceEpoch(nowMs),
      transportRetryDelay: retryDelay,
    );
  }

  final _FakeCache cache;
  final _FakeAccounts accounts;
  final Duration retryDelay;
  final List<http.Request> requests = <http.Request>[];
  final List<Future<http.Response> Function(http.Request)> steps =
      <Future<http.Response> Function(http.Request)>[];

  /// 夹具时钟，epoch ms。可变：要验证退避到期就得能往前拨。
  int nowMs = 1730000000000;

  /// 脚本用尽的次数。真用尽时假 client 抛 SocketException（会被 api 层转成
  /// transport 错误），所以不能靠 fail()——那样断言会打在错误的分支上。
  int exhausted = 0;

  late final AmooMirrorSync sync;

  http.Client _buildClient() {
    var i = 0;
    return MockClient((req) async {
      requests.add(req);
      if (i >= steps.length) {
        exhausted++;
        throw const SocketException('script exhausted');
      }
      return steps[i++](req);
    });
  }
}

class _FakeAccounts extends AmooMirrorAccountStore {
  _FakeAccounts(this._account) : super();

  AmooMirrorAccount? _account;

  set account(AmooMirrorAccount? value) => _account = value;

  @override
  Future<AmooMirrorAccount?> load() async => _account;
}

/// 内存 cache 假件。**loadSessions 必须重复写 limit 的默认值**——抽象方法省略
/// 默认值是 missing_default_value_for_parameter 编译错误
/// （amoo_mirror_cache.dart 接口注释钉的坑）。
class _FakeCache implements AmooMirrorCache {
  final List<AmooMirrorSession> sessions = <AmooMirrorSession>[];
  final List<AmooMirrorMessage> messages = <AmooMirrorMessage>[];
  final Map<String, String?> cursors = <String, String?>{};
  bool available = true;

  @override
  bool get isAvailable => available;

  @override
  Future<List<AmooMirrorSession>> loadSessions(
      {int limit = kAmooMirrorSessionsLimit}) async {
    final sorted = sessions.toList()
      ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return sorted.take(limit).toList();
  }

  @override
  Future<AmooMirrorSession?> loadSession(String sessionId) async {
    for (final s in sessions) {
      if (s.id == sessionId) return s;
    }
    return null;
  }

  @override
  Future<void> upsertSessions(List<AmooMirrorSession> incoming) async {
    for (final s in incoming) {
      final i = sessions.indexWhere((e) => e.id == s.id);
      if (i >= 0) {
        sessions[i] = s;
      } else {
        sessions.add(s);
      }
    }
  }

  @override
  Future<String?> loadCursor(String sessionId) async => cursors[sessionId];

  @override
  Future<void> saveCursor(String sessionId, String? cursor) async {
    cursors[sessionId] = cursor;
  }

  @override
  Future<int> insertMessages(
      String sessionId, List<AmooMirrorMessage> incoming) async {
    var added = 0;
    for (final m in incoming) {
      final known = messages
          .any((e) => e.id == m.id && e.sessionId == sessionId);
      if (known) continue;
      messages.add(m);
      added++;
    }
    return added;
  }

  @override
  Future<List<AmooMirrorMessage>> loadMessages(String sessionId) async {
    final out = messages.where((m) => m.sessionId == sessionId).toList()
      ..sort((a, b) => a.timestamp.compareTo(b.timestamp));
    return out;
  }
}
