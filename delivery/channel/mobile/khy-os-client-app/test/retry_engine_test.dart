// 重试引擎：退避序列与熔断判据。
//
// 这个文件此前零测试引用——全仓扫「没有测试引用的源文件」时捞出来的
// （lib/ 下 51 个，它是少数几个纯逻辑而非 UI 的）。
//
// 钉四件事：
//   1. **退避序列**：第 N 次重试等多久，三种策略各自对；
//   2. **成功即清零**：连续失败计数在成功后归零，不会把历史失败算进熔断；
//   3. **熔断阈值来自本次 config**：调用方设的 circuitBreakerThreshold
//      必须生效（原先读的是另一个全局配置的字段——假旋钮）；
//   4. **熔断后直接抛**，不再调 action。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/tools/retry_engine.dart';

void main() {
  group('退避序列', () {
    test('attempt <= 0 不等', () {
      const c = RetryConfig();
      expect(c.delayFor(0), 0);
      expect(c.delayFor(-1), 0);
    });

    test('指数退避：初始值 * 倍率^(n-1)', () {
      const c = RetryConfig(initialDelayMs: 1000, backoffMultiplier: 2.0);
      expect(c.delayFor(1), 1000);
      expect(c.delayFor(2), 2000);
      expect(c.delayFor(3), 4000);
      expect(c.delayFor(4), 8000);
    });

    test('线性退避：每次加同一个初始值', () {
      const c = RetryConfig(
        initialDelayMs: 500,
        backoffMultiplier: 1.0,
      );
      expect(c.delayFor(1), 500);
      expect(c.delayFor(2), 500);
      expect(c.delayFor(3), 500);
    });

    test('三倍率', () {
      const c = RetryConfig(initialDelayMs: 100, backoffMultiplier: 3.0);
      expect(c.delayFor(1), 100);
      expect(c.delayFor(2), 300);
      expect(c.delayFor(3), 900);
    });
  });

  group('重试执行', () {
    test('一次成功就不重试', () async {
      final engine = RetryEngine();
      var calls = 0;
      final result = await engine.execute(
        'op',
        () async {
          calls++;
          return 'ok';
        },
        config: const RetryConfig(maxAttempts: 3, initialDelayMs: 1),
      );
      expect(result, 'ok');
      expect(calls, 1);
      expect(engine.getFailureCount('op'), 0);
    });

    test('失败后重试到成功', () async {
      final engine = RetryEngine();
      var calls = 0;
      final result = await engine.execute(
        'op',
        () async {
          calls++;
          if (calls < 3) throw StateError('boom');
          return 'ok';
        },
        config: const RetryConfig(maxAttempts: 3, initialDelayMs: 1),
        onRetry: (_, _) {},
      );
      expect(result, 'ok');
      expect(calls, 3);
    });

    test('全部失败则抛最后一次的异常，且用尽尝试次数', () async {
      final engine = RetryEngine();
      var calls = 0;
      await expectLater(
        engine.execute(
          'op',
          () async {
            calls++;
            throw StateError('boom $calls');
          },
          config: const RetryConfig(maxAttempts: 3, initialDelayMs: 1),
          onRetry: (_, _) {},
        ),
        throwsA(isA<StateError>()),
      );
      expect(calls, 3);
    });

    test('onRetry 回调每次重试都触发', () async {
      final engine = RetryEngine();
      final seen = <int>[];
      await expectLater(
        engine.execute(
          'op',
          () async => throw StateError('boom'),
          config: const RetryConfig(maxAttempts: 3, initialDelayMs: 1),
          onRetry: (attempt, _) => seen.add(attempt),
        ),
        throwsA(isA<StateError>()),
      );
      // maxAttempts=3 → 两次重试（attempt 1、2），最后一次不再回调。
      expect(seen, <int>[1, 2]);
    });

    test('成功会清零此前的连续失败计数', () async {
      final engine = RetryEngine();
      // 先失败一轮，把计数抬起来。
      await expectLater(
        engine.execute(
          'op',
          () async => throw StateError('boom'),
          config: const RetryConfig(maxAttempts: 2, initialDelayMs: 1),
          onRetry: (_, _) {},
        ),
        throwsA(isA<StateError>()),
      );
      expect(engine.getFailureCount('op'), 2);

      // 再成功一次，计数必须归零——否则历史失败会被算进下一次熔断。
      await engine.execute(
        'op',
        () async => 'ok',
        config: const RetryConfig(maxAttempts: 2, initialDelayMs: 1),
      );
      expect(engine.getFailureCount('op'), 0);
    });
  });

  group('熔断', () {
    test('阈值来自本次 config，不是某个全局配置', () async {
      // 这是本套件最要紧的一条：调用方把阈值设成 10，就必须第 10 次才熔断。
      // 原先实现读的是 networkRetryConfig.circuitBreakerThreshold(=5)，
      // 于是「给这个操作配一个更宽松的熔断」看起来支持、实际静默无效。
      final engine = RetryEngine();
      const config = RetryConfig(
        maxAttempts: 1,
        initialDelayMs: 1,
        circuitBreakerThreshold: 10,
        circuitBreakerCooldown: Duration(minutes: 5),
      );

      // 连续 10 次单次失败：第 10 次把计数推到 10，熔断开启。
      // （maxAttempts=1 时每次 execute 只记 1 次失败，所以是 10 次而不是 9 次。）
      for (var i = 0; i < 10; i++) {
        await expectLater(
          engine.execute('op', () async => throw StateError('boom'),
              config: config),
          throwsA(isA<StateError>()),
        );
      }
      expect(engine.getFailureCount('op'), 10);

      // 第 11 次：熔断已开启，action 一次都不该被调。
      var called = false;
      await expectLater(
        engine.execute('op', () async {
          called = true;
          return 'ok';
        }, config: config),
        throwsA(isA<CircuitBreakerOpenException>()),
      );
      expect(called, isFalse, reason: '熔断后不该再调 action');
    });

    test('默认阈值 5：连续 5 次失败后熔断', () async {
      final engine = RetryEngine();
      const config = RetryConfig(maxAttempts: 1, initialDelayMs: 1);

      for (var i = 0; i < 5; i++) {
        await expectLater(
          engine.execute('op', () async => throw StateError('boom'),
              config: config),
          throwsA(isA<StateError>()),
        );
      }

      var called = false;
      await expectLater(
        engine.execute('op', () async {
          called = true;
          return 'ok';
        }, config: config),
        throwsA(isA<CircuitBreakerOpenException>()),
      );
      expect(called, isFalse);
    });

    test('reset 清空熔断状态', () async {
      final engine = RetryEngine();
      const config = RetryConfig(maxAttempts: 1, initialDelayMs: 1);
      for (var i = 0; i < 5; i++) {
        await expectLater(
          engine.execute('op', () async => throw StateError('boom'),
              config: config),
          throwsA(isA<StateError>()),
        );
      }
      engine.reset();
      // 熔断已清：这次能真的调 action。
      final ok = await engine.execute('op', () async => 'ok', config: config);
      expect(ok, 'ok');
    });
  });
}
