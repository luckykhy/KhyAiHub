// khy-canary: Khy-20261101-094-JX7RVXF8
//
// ⚠️ **本文件当前是死代码**：`RetryEngine` / `RetryConfig` / `RetryStrategy` /
// `CircuitBreakerOpenException` 在全仓（`lib/`、`test/`、`integration_test/`）
// 零代码引用，只有设计文档与 canary manifest 提到它。
//
// 第三十轮在这里修过一个真 bug（熔断阈值读的是全局配置而非调用方的 config，
// 即「假旋钮」），并补了 12 例测试——但那些测试测的是**逻辑**，
// 不代表它接在了某个流程上。
//
// 为什么不删：登记在 `scripts/release/canary-manifest.json` 与
// `[DESIGN-ARCH-187]` 的文件去向表里，删文件会触发守卫。
// **要接线还是删除，等拍板。**
import 'dart:math' as math;
import 'dart:async';

/// 重试策略
enum RetryStrategy { none, exponential, linear }

/// 单次重试配置
class RetryConfig {
  final int maxAttempts;
  final int initialDelayMs;
  final double backoffMultiplier;
  final int circuitBreakerThreshold; // 连续失败 N 次后熔断
  final Duration circuitBreakerCooldown;

  const RetryConfig({
    this.maxAttempts = 3,
    this.initialDelayMs = 1000,
    this.backoffMultiplier = 2.0,
    this.circuitBreakerThreshold = 5,
    this.circuitBreakerCooldown = const Duration(minutes: 5),
  });

  /// 获取第 N 次重试的等待时间（毫秒）
  int delayFor(int attempt) {
    if (attempt <= 0) return 0;
    return (initialDelayMs * math.pow(backoffMultiplier, attempt - 1))
        .toInt();
  }
}

/// 默认重试配置
const defaultRetryConfig = RetryConfig(
  maxAttempts: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2.0,
);

/// 网络工具重试（更保守）
const networkRetryConfig = RetryConfig(
  maxAttempts: 3,
  initialDelayMs: 2000,
  backoffMultiplier: 2.0,
  circuitBreakerThreshold: 5,
);

/// 重试执行器
class RetryEngine {
  final Map<String, int> _failureCounts = {};
  final Map<String, DateTime> _circuitOpenTime = {};

  /// 执行一个可能失败的操作（带重试）
  Future<T> execute<T>(
    String operation,
    Future<T> Function() action, {
    required RetryConfig config,
    void Function(int attempt, String error)? onRetry,
  }) async {
    // 检查熔断
    if (_isCircuitOpen(operation)) {
      throw CircuitBreakerOpenException(operation);
    }

    T? result;
    for (var attempt = 0; attempt < config.maxAttempts; attempt++) {
      try {
        result = await action();
        // 成功：重置计数
        _failureCounts[operation] = 0;
        return result!;
      } catch (e) {
        if (attempt == config.maxAttempts - 1) {
          // 最后一次也失败。
          // rethrow 而不是 throw e：保住原始堆栈，调用方才知道是从哪一行
          // 冒出来的（throw e 会把栈重置到这一行）。
          _recordFailure(operation, config);
          rethrow;
        }

        // 等待后重试
        final delayMs = config.delayFor(attempt + 1);
        _recordFailure(operation, config);
        onRetry?.call(attempt + 1, e.toString());
        await Future.delayed(Duration(milliseconds: delayMs));
      }
    }
    throw StateError('RetryEngine: unreachable');
  }

  /// 记录失败（用于熔断判断）
  ///
  /// 阈值与冷却期从**本次调用的 config** 取，不从某个全局配置取：
  /// 调用方在 `RetryConfig` 里设的 `circuitBreakerThreshold` /
  /// `circuitBreakerCooldown` 必须是生效的。原先这里读的是
  /// `networkRetryConfig` 的字段——于是「给这个操作配一个更宽松的熔断」
  /// 这件事看起来支持、实际上静默无效（假旋钮）。
  void _recordFailure(String operation, RetryConfig config) {
    _failureCounts[operation] =
        (_failureCounts[operation] ?? 0) + 1;
    if ((_failureCounts[operation] ?? 0) >= config.circuitBreakerThreshold) {
      _circuitOpenTime[operation] =
          DateTime.now().add(config.circuitBreakerCooldown);
    }
  }

  /// 检查熔断状态
  bool _isCircuitOpen(String operation) {
    final openTime = _circuitOpenTime[operation];
    if (openTime == null) return false;
    if (DateTime.now().isAfter(openTime)) {
      // 冷却期过，半开
      _circuitOpenTime.remove(operation);
      _failureCounts[operation] = 0;
      return false;
    }
    return true;
  }

  /// 获取某操作的连续失败次数
  int getFailureCount(String operation) =>
      _failureCounts[operation] ?? 0;

  /// 重置所有状态
  void reset() {
    _failureCounts.clear();
    _circuitOpenTime.clear();
  }
}

/// 熔断异常
class CircuitBreakerOpenException implements Exception {
  final String operation;
  CircuitBreakerOpenException(this.operation);

  @override
  String toString() =>
      '熔断器开启：$operation 连续失败过多，冷却中';
}
