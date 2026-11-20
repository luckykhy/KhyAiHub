import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/gateway/zen_gate.dart';

/// Zen 身份派生。
///
/// 为什么要单独一个套件：身份一旦依赖落盘值，安全存储读失败就会让每次冷启动
/// 换一份身份——上游眼里就是同一台手机在刷量。这里钉住"只由种子决定"。
class _FixedSeed implements ZenSeedSource {
  _FixedSeed(this.value);
  final String? value;

  @override
  Future<String?> seed() async => value;
}

class _MemStore implements ZenIdentityStore {
  _MemStore([this.value]);

  String? value;
  final List<String> writes = [];
  bool throwOnRead = false;
  bool throwOnWrite = false;

  @override
  Future<String?> read() async {
    if (throwOnRead) throw StateError('read failed');
    return value;
  }

  @override
  Future<void> write(String v) async {
    if (throwOnWrite) throw StateError('write failed');
    value = v;
    writes.add(v);
  }
}

final _seedA = List.filled(64, 'a').join();
final _seedB = List.filled(64, 'b').join();

void main() {
  group('derive', () {
    test('同一种子恒定（纯函数，无 DateTime.now）', () {
      final first = ZenGate.derive(_seedA);
      final second = ZenGate.derive(_seedA);
      expect(first.sessionId, second.sessionId);
      expect(first.projectUuid, second.projectUuid);
      expect(first.createdAtMs, second.createdAtMs);
    });

    test('身份形态贴在电脑版同一形状上', () {
      final id = ZenGate.derive(_seedA);
      // 上游免费层拒收不是 12 位 hex 开头的 session id。
      expect(RegExp(r'^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$').hasMatch(id.sessionId),
          isTrue, reason: id.sessionId);
      expect(
          RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-'
                  r'[0-9a-f]{12}$')
              .hasMatch(id.projectUuid),
          isTrue,
          reason: id.projectUuid);
    });

    test('异种子 → 整串 id 与 project uuid 都不同', () {
      final a = ZenGate.derive(_seedA);
      final b = ZenGate.derive(_seedB);
      expect(a.sessionId, isNot(b.sessionId));
      expect(a.projectUuid, isNot(b.projectUuid));
      expect(a.createdAtMs, isNot(b.createdAtMs));
    });
  });

  group('identity()', () {
    setUp(() {
      ZenGate.resetForTest(
        store: _MemStore(),
        seedSource: _FixedSeed(_seedA),
      );
    });

    test('有种子时身份就是 derive 结果，存储里的垃圾不参与', () async {
      final store = _MemStore('{not even json');
      ZenGate.resetForTest(
        store: store,
        seedSource: _FixedSeed(_seedA),
      );
      final id = await ZenGate.identity();
      final expected = ZenGate.derive(_seedA);
      expect(id.sessionId, expected.sessionId);
      expect(id.projectUuid, expected.projectUuid);
      expect(id.createdAtMs, expected.createdAtMs);
    });

    test('存储读抛异常也不影响身份', () async {
      final store = _MemStore()..throwOnRead = true;
      ZenGate.resetForTest(
        store: store,
        seedSource: _FixedSeed(_seedA),
      );
      final id = await ZenGate.identity();
      expect(id.sessionId, ZenGate.derive(_seedA).sessionId);
    });

    test('落盘只写派生结果，且不含种子原文', () async {
      final store = _MemStore();
      ZenGate.resetForTest(
        store: store,
        seedSource: _FixedSeed(_seedA),
      );
      final id = await ZenGate.identity();
      expect(store.writes, isNotEmpty);
      final written = store.writes.last;
      expect(written.contains(_seedA), isFalse);
      final map = jsonDecode(written) as Map<String, dynamic>;
      expect(map.keys.toSet(),
          {'v', 'sessionId', 'projectUuid', 'createdAtMs'});
      expect(map['sessionId'], id.sessionId);
    });

    test('没有种子才回落落盘身份', () async {
      final saved = jsonEncode(ZenGate.derive(_seedB).toJson());
      final store = _MemStore(saved);
      ZenGate.resetForTest(
        store: store,
        seedSource: _FixedSeed(null),
      );
      final id = await ZenGate.identity();
      expect(id.sessionId, ZenGate.derive(_seedB).sessionId);
      expect(store.writes, isEmpty);
    });

    test('没有种子且落盘不可用 → 安装期随机身份（形态仍合法）', () async {
      final store = _MemStore()
        ..throwOnRead = true
        ..throwOnWrite = true;
      ZenGate.resetForTest(
        store: store,
        seedSource: _FixedSeed(null),
      );
      final id = await ZenGate.identity();
      expect(RegExp(r'^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$').hasMatch(id.sessionId),
          isTrue);
    });
  });

  test('UA 与电脑版同源（读真源文件，不在测试里抄一份）', () {
    final file = File(
        '../../../runtime/node/backend/src/constants/serviceDefaults.js');
    expect(file.existsSync(), isTrue,
        reason: '读不到 serviceDefaults.js：UA 漂移会静默发生');
    final src = file.readAsStringSync();
    final m = RegExp(r"OPENCODE_USER_AGENT\s*=\s*[^;]*?\|\|\s*'([^']+)'")
        .firstMatch(src);
    expect(m, isNotNull, reason: 'serviceDefaults.js 里的默认 UA 形态变了');
    expect(kZenUserAgent, m!.group(1));
  });
}
