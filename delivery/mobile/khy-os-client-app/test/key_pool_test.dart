import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/built_in_keys.dart';
import 'package:khy_os_client/core/gateway/key_health.dart';
import 'package:khy_os_client/core/gateway/key_pool.dart';

/// 密钥池与逐 key 探测的单测。
///
/// 两个注入点让纯逻辑可以离线跑：clock（假时钟，退避与 TTL 全靠它推进）和
/// read/write（内存存储替代 FlutterSecureStorage，不走平台通道）。
/// probeOne/probeAll 发真网络请求，不在本套件内执行；这里只测它们的分类
/// 纯函数。
void main() {
  // 冻结的假时钟：只有测试自己累加 now 才会推进，退避毫秒数因此可精确断言。
  final t0 = DateTime.utc(2026, 1, 1, 12);

  KeyPool newPool({
    DateTime Function()? clock,
    String? stored,
    List<String>? writes,
  }) =>
      KeyPool(
        clock: clock ?? (() => t0),
        read: () async => stored,
        write: (v) async => writes?.add(v),
      );

  Future<KeyPool> poolWithKeys(
    List<String> keys, {
    String provider = 'p',
    DateTime Function()? clock,
    List<String>? writes,
  }) async {
    final pool = newPool(clock: clock, writes: writes);
    for (final k in keys) {
      await pool.addKey(provider, key: k, endpoint: 'https://api.example.com/v1');
    }
    return pool;
  }

  group('round-robin', () {
    test('同级 key 依次轮换，周而复始', () async {
      final pool = await poolWithKeys(['sk-a', 'sk-b', 'sk-c']);
      final picks = [for (var i = 0; i < 6; i++) pool.pick('p')!.key];
      expect(picks, ['sk-a', 'sk-b', 'sk-c', 'sk-a', 'sk-b', 'sk-c']);
    });

    test('冷却中的 key 退出轮换，期满后回来', () async {
      var now = t0;
      // a 优先级高、b 低：topGroup 只有 a，断言不依赖同优先级的排序细节。
      final pool = newPool(clock: () => now);
      await pool.addKey('p', key: 'sk-a', priority: 20);
      await pool.addKey('p', key: 'sk-b', priority: 10);

      final first = pool.pick('p')!;
      expect(first.key, 'sk-a');
      pool.markFailure(first.keyId, 429); // a 冷却 10s

      now = now.add(const Duration(seconds: 1));
      expect(pool.pick('p')!.key, 'sk-b');

      now = now.add(const Duration(seconds: 15));
      expect(pool.pick('p')!.key, 'sk-a'); // 冷却期满复活
    });

    test('高优先级组盖过低优先级组', () async {
      final pool = await poolWithKeys(['sk-low']);
      await pool.addKey('p', key: 'sk-high', priority: 20);
      for (var i = 0; i < 3; i++) {
        expect(pool.pick('p')!.key, 'sk-high');
      }
    });

    test('空 provider 与整池冷却都取不到 key', () async {
      final pool = await poolWithKeys(['sk-a']);
      expect(pool.pick('nobody'), isNull);
      expect(pool.hasAvailableKeys('nobody'), false);

      pool.markFailure(pool.pick('p')!.keyId, 429);
      expect(pool.hasAvailableKeys('p'), false);
      expect(pool.pick('p'), isNull);
    });

    test('pick 计数与 lastUsedAt 随选中推进', () async {
      final pool = await poolWithKeys(['sk-a']);
      pool.pick('p');
      pool.pick('p');
      final entry = pool.entriesFor('p').single;
      expect(entry.totalRequests, 2);
      expect(entry.lastUsedAt, t0.millisecondsSinceEpoch);
    });
  });

  group('退避', () {
    test('429 逐级 10/20/40/80/160s，级数封顶 5', () async {
      final pool = await poolWithKeys(['sk-a']);
      final id = pool.pick('p')!.keyId;
      for (final expectedSec in const [10, 20, 40, 80, 160, 160]) {
        pool.markFailure(id, 429);
        final view = pool.statusFor('p').first;
        expect(view.status, KeyStatus.cooldown);
        expect(view.cooldownRemainingSec, expectedSec);
      }
    });

    test('300s 封顶在公式上生效（级数上限挡不住的那一级）', () {
      // 级数封顶 5 时指数最多到 160s，300s 夹子只有直接调公式才看得到——
      // 与桌面 Math.min(MAX_COOLDOWN_MS, ...) 逐字节一致。
      expect(cooldownForBackoffLevel(1), 10000);
      expect(cooldownForBackoffLevel(5), 160000);
      expect(cooldownForBackoffLevel(6), 300000);
      expect(cooldownForBackoffLevel(20), 300000);
      expect(cooldownForBackoffLevel(0), 10000);
    });

    test('500 只记失败不冷却——一次上游抖动不该关掉好 key', () async {
      final pool = await poolWithKeys(['sk-a']);
      final id = pool.pick('p')!.keyId;
      pool.markFailure(id, 500, errorMsg: 'Internal Server Error');
      final view = pool.statusFor('p').first;
      expect(view.status, KeyStatus.active);
      expect(view.totalFailures, 1);
      expect(view.lastError, contains('Internal Server Error'));
      expect(pool.hasAvailableKeys('p'), true);
    });

    test('消息含 rate limit 措辞时，没有 429 状态码也冷却', () async {
      final pool = await poolWithKeys(['sk-a']);
      final id = pool.pick('p')!.keyId;
      pool.markFailure(id, 400, errorMsg: 'Rate limit reached for default model');
      expect(pool.statusFor('p').first.status, KeyStatus.cooldown);
    });

    test('401/403 也冷却', () async {
      final pool = await poolWithKeys(['sk-a', 'sk-b']);
      final sel = pool.pick('p')!;
      pool.markFailure(sel.keyId, 401);
      expect(pool.statusFor('p').first.status, KeyStatus.cooldown);
      expect(pool.pick('p')!.key, 'sk-b');
    });
  });

  group('Retry-After', () {
    test('429 的 Retry-After 优先于指数退避，且不叠加', () async {
      final pool = await poolWithKeys(['sk-a']);
      final id = pool.pick('p')!.keyId;
      pool.markFailure(id, 429, retryAfter: '30');
      expect(pool.statusFor('p').first.cooldownRemainingSec, 30);
      pool.markFailure(id, 429, retryAfter: '30');
      expect(pool.statusFor('p').first.cooldownRemainingSec, 30);
    });

    test('非 429 的状态码不读 Retry-After（401 带 Retry-After 仍走指数）', () async {
      final pool = await poolWithKeys(['sk-a']);
      final id = pool.pick('p')!.keyId;
      pool.markFailure(id, 401, retryAfter: '30');
      expect(pool.statusFor('p').first.cooldownRemainingSec, 10);
    });

    test('数字按秒，钳在 [10s, 600s]', () {
      final nowMs = t0.millisecondsSinceEpoch;
      expect(parseRetryAfterCooldown('45', nowMs: nowMs), 45000);
      expect(parseRetryAfterCooldown('1', nowMs: nowMs), 10000);
      expect(parseRetryAfterCooldown('1200', nowMs: nowMs), 600000);
      expect(parseRetryAfterCooldown('86400', nowMs: nowMs), 600000);
      expect(parseRetryAfterCooldown('', nowMs: nowMs), 10000);
      expect(parseRetryAfterCooldown('soon', nowMs: nowMs), 10000);
    });

    test('HTTP-date 形态按与当前的差值算', () {
      // Dart 核心库只解析 ISO-8601，RFC 7231 的 HTTP-date 由 key_pool 自己解。
      final nowMs = t0.millisecondsSinceEpoch;
      expect(parseRetryAfterCooldown('Thu, 01 Jan 2026 12:00:45 GMT', nowMs: nowMs),
          45000);
      // 已经过去的日期 → 夹回基础冷却，不会出现负冷却。
      expect(parseRetryAfterCooldown('Wed, 31 Dec 2025 12:00:00 GMT', nowMs: nowMs),
          10000);
    });
  });

  group('markSuccess 衰减', () {
    test('每次成功衰减一级，归零后不再衰减', () async {
      final pool = await poolWithKeys(['sk-a']);
      final id = pool.pick('p')!.keyId;
      pool.markFailure(id, 429);
      pool.markFailure(id, 429);
      pool.markFailure(id, 429);
      expect(pool.statusFor('p').first.cooldownRemainingSec, 40);

      pool.markSuccess(id);
      pool.markSuccess(id);
      pool.markSuccess(id);
      pool.markSuccess(id); // 多一次不该变成负数级数

      pool.markFailure(id, 429);
      expect(pool.statusFor('p').first.cooldownRemainingSec, 10);
    });

    test('成功即放行：冷却中的 key 标记成功后立即可用', () async {
      // 桌面 markSuccess 不清 cooldownUntil，只把状态置 active——语义是
      // 「这把 key 刚成功过，别再关着」。保持同一行为。
      final pool = await poolWithKeys(['sk-a']);
      final id = pool.pick('p')!.keyId;
      pool.markFailure(id, 429);
      expect(pool.hasAvailableKeys('p'), false);

      pool.markSuccess(id);
      expect(pool.hasAvailableKeys('p'), true);
      expect(pool.statusFor('p').first.status, KeyStatus.active);
      expect(pool.statusFor('p').first.lastError, isNull);
    });

    test('对不存在的 keyId 调用是空操作', () async {
      final pool = await poolWithKeys(['sk-a']);
      pool.markSuccess('no-such-id');
      pool.markFailure('no-such-id', 429);
      expect(pool.statusFor('p').first.status, KeyStatus.active);
    });
  });

  group('持久化与老安装迁移', () {
    test('单 key 老安装迁移：灌池后取 key 行为不变', () async {
      // 迁移前：请求直接用 AppConfig.effectiveApiKey（唯一那一把用户 key）。
      // 迁移后：池里只有这一把，pick 必须永远返回它，不能冒出内置 key。
      final writes = <String>[];
      final pool = newPool(writes: writes);
      await pool.addKey(
        'https://api.deepseek.com/v1',
        key: 'sk-legacy-user-key',
        endpoint: 'https://api.deepseek.com/v1',
      );
      for (var i = 0; i < 4; i++) {
        expect(pool.pick('https://api.deepseek.com/v1')!.key, 'sk-legacy-user-key');
      }

      // 重启：从落盘 JSON 原样恢复，还是同一把。
      final restored = newPool(stored: writes.single);
      await restored.load();
      expect(restored.pick('https://api.deepseek.com/v1')!.key, 'sk-legacy-user-key');
      expect(restored.entriesFor('https://api.deepseek.com/v1').single.key,
          'sk-legacy-user-key');
    });

    test('落盘只含配置字段，冷却与计数不持久化', () async {
      final writes = <String>[];
      final pool = newPool(writes: writes);
      await pool.addKey('p', key: 'sk-a', label: 'built-in');
      pool.markFailure(pool.pick('p')!.keyId, 429);

      final decoded = jsonDecode(writes.single) as Map<String, dynamic>;
      final entries = decoded['p'] as List;
      expect(entries.single['key'], 'sk-a');
      expect(entries.single['label'], 'built-in');
      expect(entries.single.containsKey('cooldownUntil'), false);
      expect(entries.single.containsKey('totalFailures'), false);
    });

    test('损坏的存档按空池起步，不抛', () async {
      final pool = newPool(stored: '{not json');
      await pool.load();
      expect(pool.providers, isEmpty);
      expect(pool.pick('p'), isNull);
    });

    test('removeKey 后该 key 不再被选中', () async {
      final writes = <String>[];
      final pool = await poolWithKeys(['sk-a', 'sk-b'], writes: writes);
      final id = pool.entriesFor('p').first.keyId;
      await pool.removeKey('p', id);
      expect(pool.entriesFor('p').single.key, 'sk-b');
      expect(pool.pick('p')!.key, 'sk-b');
    });

    test('同一把 key 不能重复入池', () async {
      final pool = await poolWithKeys(['sk-a']);
      await expectLater(
        pool.addKey('p', key: 'sk-a'),
        throwsA(isA<KeyPoolException>()),
      );
    });

    test('空 key 拒绝入池', () async {
      final pool = newPool();
      await expectLater(
        pool.addKey('p', key: '   '),
        throwsA(isA<ArgumentError>()),
      );
    });

    test('keyId 稳定、12 位十六进制、随 provider 区分', () {
      final id = keyIdFor('p', 'sk-x');
      expect(id, keyIdFor('p', 'sk-x'));
      expect(id, isNot(keyIdFor('q', 'sk-x')));
      expect(RegExp(r'^[0-9a-f]{12}$').hasMatch(id), true);
    });

    test('maskKey 短 key 全遮、长 key 留头 6 尾 4', () {
      expect(maskKey('short'), '***');
      expect(maskKey('sk-examplekey12345'), 'sk-exa...2345');
    });
  });

  group('BuiltInKeys.builtInPoolEntry', () {
    test('仓库态没有任何内置 key → 全部返回 null（R2 守卫）', () {
      // 与 app_config_test 的 R2 守卫同一条红线：内置 key 已迁出仓库，
      // 一旦这里为非空，说明有明文 key 被贴回了 built_in_keys.dart。
      for (final p in BuiltInKeys.providers.values) {
        expect(BuiltInKeys.builtInPoolEntry(p.baseUrl), isNull,
            reason: '${p.baseUrl} 不该在内置 key 消毒后仍产出池种子');
      }
    });

    test('未知 baseUrl 返回 null', () {
      expect(BuiltInKeys.builtInPoolEntry('https://not-a-provider.example/v1'),
          isNull);
    });
  });

  group('key_health 分类', () {
    // probeOne/probeAll 的 10s 单项超时不在单测里跑（真网络）：它是
    // RUNTIME-003 的合法短 I/O 例外——防挂死的连接，不是杀活跃的长任务；
    // 整批无墙钟 kill，卡住的一项只占一个 worker。这里只测分类纯函数。
    test('2xx/404/405 → ok', () {
      expect(classifyProbeStatus(200), HealthStatus.ok);
      expect(classifyProbeStatus(204), HealthStatus.ok);
      expect(classifyProbeStatus(404), HealthStatus.ok);
      expect(classifyProbeStatus(405), HealthStatus.ok);
      expect(classifyProbeStatus(400), HealthStatus.ok);
    });

    test('401/403 → auth，429 → rate，5xx → upstream', () {
      expect(classifyProbeStatus(401), HealthStatus.auth);
      expect(classifyProbeStatus(403), HealthStatus.auth);
      expect(classifyProbeStatus(429), HealthStatus.rate);
      expect(classifyProbeStatus(500), HealthStatus.upstream);
      expect(classifyProbeStatus(503), HealthStatus.upstream);
    });

    test('文案沿用规则 2.2 模板（问题+原因+一行修复）', () {
      expect(healthStatusHint(HealthStatus.auth), contains('认证失败 (401/403)'));
      expect(healthStatusHint(HealthStatus.auth), contains('请在设置中更新'));
      expect(healthStatusHint(HealthStatus.rate), contains('限流 (429)'));
      expect(healthStatusHint(HealthStatus.upstream), contains('上游异常 (5xx)'));
      expect(healthStatusHint(HealthStatus.timeout), contains('请求超时'));
    });

    test('进度标签带动作+目标+进度', () {
      final target = const ProbeTarget(
        keyId: 'k',
        provider: 'https://api.deepseek.com/v1',
        endpoint: 'https://api.deepseek.com/v1',
        key: 'sk-x',
      );
      expect(probeLabel(2, 5, target), '探测 2/5：api.deepseek.com');
    });
  });

  group('模型坏标记账本', () {
    test('404 + 明说模型不存在才记坏，TTL 30 分钟', () {
      var now = t0;
      final ledger = ModelHealthLedger(clock: () => now);

      expect(
          isPermanentModelError(404, '{"error":{"code":"model_not_found"}}'), true);
      expect(isPermanentModelError(404, '模型不存在：gpt-9'), true);
      expect(isPermanentModelError(404, '模型 gpt9 不存在'), true);
      // 只有 404 算永久：401 是 key 的事，不该关模型。
      expect(isPermanentModelError(401, 'model_not_found'), false);
      // 404 但没说模型不存在（URL 打错也会 404）→ 不记坏。
      expect(isPermanentModelError(404, 'page not found'), false);
      expect(isPermanentModelError(200, 'model_not_found'), false);

      ledger.markBroken('p', 'gpt-5.6-luna');
      expect(ledger.isBroken('p', 'gpt-5.6-luna'), true);
      expect(ledger.isBroken('p', 'gpt-5.5'), false);

      now = now.add(const Duration(minutes: 29));
      expect(ledger.isBroken('p', 'gpt-5.6-luna'), true);

      now = now.add(const Duration(minutes: 2));
      expect(ledger.isBroken('p', 'gpt-5.6-luna'), false); // TTL 到期自动放行
      expect(ledger.broken, isEmpty);
    });

    test('clear 立即放行', () {
      final ledger = ModelHealthLedger(clock: () => t0);
      ledger.markBroken('p', 'm');
      expect(ledger.broken.length, 1);
      ledger.clear('p', 'm');
      expect(ledger.isBroken('p', 'm'), false);
    });
  });
}
