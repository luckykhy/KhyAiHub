import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/gateway/zen_gate.dart';
import 'package:khy_os_client/core/gateway/zen_models.dart';

/// 免费模型过滤与退役账本。
///
/// 为什么静态表只放永久项：电脑版表里的临时项探针于 2026-10-09、TTL 7 天，
/// 照抄等于带着过期死数据出货。这里钉住"临时项只能由带时间戳的反馈产生"。
class _MemRetiredStore implements ZenRetiredStore {
  _MemRetiredStore([this.value]);

  String? value;
  bool throwOnRead = false;

  @override
  Future<String?> read() async {
    if (throwOnRead) throw StateError('read failed');
    return value;
  }

  @override
  Future<void> write(String v) async => value = v;
}

void main() {
  group('形状判据', () {
    test('-free 后缀与显式例外集', () {
      expect(isZenFreeModelId('mimo-v2.6-flash-free'), isTrue);
      expect(isZenFreeModelId('big-pickle'), isTrue);
      expect(isZenFreeModelId('BIG-PICKLE'), isTrue);
      expect(isZenFreeModelId('deepseek-v4-pro'), isFalse);
      expect(isZenFreeModelId(''), isFalse);
    });

    test('免费模型指到非免费根时给出可行动的一句话', () {
      expect(
          freeModelEndpointProblem(
              'https://opencode.ai/zen/v1', 'mimo-v2.6-flash-free'),
          isNull);
      // 同属 opencode.ai 家族但不是免费根（OpenCode Go）。
      expect(
          freeModelEndpointProblem(
              'https://opencode.ai/zen/go/v1', 'ox-alpha-free'),
          contains('免费根'));
      // 别的供应商自有 -free 模型：端点本来就不是 Zen，不该拦。
      expect(
          freeModelEndpointProblem(
              'https://api.commandcode.ai/provider/v1',
              'minimax/minimax-m3-free'),
          isNull);
      expect(freeModelEndpointProblem('', 'mimo-v2.6-flash-free'),
          contains('Base URL'));
    });
  });

  group('filterFreeStatic', () {
    test('保留 -free 与 big-pickle，剔除永久退役与付费 id', () {
      final kept = ZenModelCatalog.filterFreeStatic(const [
        'mimo-v2.6-flash-free',
        'big-pickle',
        'beam-free',
        'exo-free',
        'mimo-v2.5-free',
        'deepseek-v4-flash-free',
        'deepseek-v4-pro',
        'claude-sonnet-4-5',
      ]);
      expect(kept, containsAll(['mimo-v2.6-flash-free', 'big-pickle', 'beam-free']));
      expect(kept, isNot(contains('exo-free')));
      expect(kept, isNot(contains('mimo-v2.5-free')));
      expect(kept, isNot(contains('deepseek-v4-flash-free')));
      expect(kept, isNot(contains('deepseek-v4-pro')));
      expect(kept, isNot(contains('claude-sonnet-4-5')));
    });
  });

  group('调用时反馈账本', () {
    setUp(() {
      ZenModelCatalog.resetForTest(store: _MemRetiredStore());
    });

    test('临时退役在 7 天内隐藏、过期后放回', () async {
      final now = DateTime.now().millisecondsSinceEpoch;
      final store = _MemRetiredStore(jsonEncode({
        'ling-3.0-flash-fin-free': {'reason': 'unavailable', 'at': now},
      }));
      ZenModelCatalog.resetForTest(store: store);

      var kept = await ZenModelCatalog.filterFree(
          ['mimo-v2.6-flash-free', 'ling-3.0-flash-fin-free']);
      expect(kept, ['mimo-v2.6-flash-free']);

      // 换一份 8 天前的账本：TTL 过期，模型自动放回（上游可能已恢复）。
      final old = now - const Duration(days: 8).inMilliseconds;
      ZenModelCatalog.resetForTest(
        store: _MemRetiredStore(jsonEncode({
          'ling-3.0-flash-fin-free': {'reason': 'unavailable', 'at': old},
        })),
      );
      kept = await ZenModelCatalog.filterFree(
          ['mimo-v2.6-flash-free', 'ling-3.0-flash-fin-free']);
      expect(kept, contains('ling-3.0-flash-fin-free'));
    });

    test('永久退役永不放回', () async {
      final old = DateTime.now().millisecondsSinceEpoch -
          const Duration(days: 3650).inMilliseconds;
      ZenModelCatalog.resetForTest(
        store: _MemRetiredStore(jsonEncode({
          'beam-free': {'reason': 'deprecated', 'at': old},
        })),
      );
      final kept = await ZenModelCatalog.filterFree(['beam-free', 'flint-40b-free']);
      expect(kept, ['flint-40b-free']);
    });

    test('只有 401/404/410 + 上游明文才记账', () async {
      expect(
          await ZenModelCatalog.recordFromUpstreamError(
              status: 403,
              body: 'ModelDeprecated: has been deprecated',
              modelId: 'beam-free'),
          isFalse);
      expect(
          await ZenModelCatalog.recordFromUpstreamError(
              status: 429,
              body: 'FreeUsageLimitError',
              modelId: 'beam-free'),
          isFalse);
      expect(
          await ZenModelCatalog.recordFromUpstreamError(
              status: 500,
              body: 'has been deprecated',
              modelId: 'beam-free'),
          isFalse);
      expect(
          await ZenModelCatalog.recordFromUpstreamError(
              status: 404,
              body: 'model is not supported',
              modelId: 'beam-free'),
          isTrue);
      final kept = await ZenModelCatalog.filterFree(['beam-free']);
      expect(kept, isEmpty);
    });
  });
}
