import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/endpoint_defaults.dart';
import 'package:khy_os_client/core/gateway/provider_adapter.dart';
import 'package:khy_os_client/core/services/arena_runner.dart';
import 'package:khy_os_client/data/models/models.dart';

/// arena_runner 的单测。
///
/// 三件事按验收逐条钉：并行扇出（不是排队）、单模型失败不带塌其余、指标
/// 计算（Jaccard / 延迟 / 字数 / 代码块）。网络全走假适配器——真发请求的
/// 测试在 CI 上会变成谁先超时谁说了算。
///
/// 指标口径与 runtime/node/backend/src/services/arenaManager.js
/// generateArenaSummary（296-351 行）对齐；分数是确定性启发式，测试里同样
/// 只断言确定性，不断言"好不好"。
class _FakeAdapter implements ProviderAdapter {
  _FakeAdapter(this._chat);

  final Future<ChatResponse> Function(ChatRequest request) _chat;

  @override
  String get id => 'fake';

  @override
  String get name => 'fake';

  @override
  bool get isAvailable => true;

  @override
  bool supports(List<Capability> capabilities) => true;

  @override
  Future<ChatResponse> chat(ChatRequest request) => _chat(request);

  @override
  Future<Stream<ChatResponse>> streamChat(ChatRequest request) async =>
      const Stream<ChatResponse>.empty();
}

ChatResponse _reply(String content, {TokenUsage? usage}) => ChatResponse(
      id: 'r',
      content: content,
      role: MessageRole.assistant,
      usage: usage,
      done: true,
    );

ArenaContestant _contestant(String label, ProviderAdapter adapter) =>
    ArenaContestant(adapter: adapter, model: label, label: label);

void main() {
  group('并行扇出', () {
    test('两个模型同时在飞：第二个发出时第一个还没返回', () async {
      final starts = <int>[];
      final ends = <int>[];
      final clock = Stopwatch()..start();
      Future<ChatResponse> timed(ChatRequest request) async {
        starts.add(clock.elapsedMilliseconds);
        // 让出事件循环：串行实现会在这里等完才发下一个，starts[1] 就会晚于
        // ends[0]。
        await Future<void>.delayed(const Duration(milliseconds: 60));
        ends.add(clock.elapsedMilliseconds);
        return _reply('ok');
      }

      final run = await const ArenaRunner().run('prompt', [
        _contestant('A · m', _FakeAdapter(timed)),
        _contestant('B · m', _FakeAdapter(timed)),
      ]);

      expect(starts, hasLength(2));
      expect(ends, hasLength(2));
      expect(starts[1], lessThan(ends[0]),
          reason: '第二个模型在第一个返回前就已发出，否则是排队不是并行');
      expect(run.results, hasLength(2));
    });

    test('结果顺序跟随参赛顺序，不跟随完成顺序', () async {
      Future<ChatResponse> slow(ChatRequest request) async {
        await Future<void>.delayed(const Duration(milliseconds: 80));
        return _reply('slow');
      }

      Future<ChatResponse> fast(ChatRequest request) async => _reply('fast');

      final run = await const ArenaRunner().run('prompt', [
        _contestant('慢 · m', _FakeAdapter(slow)),
        _contestant('快 · m', _FakeAdapter(fast)),
      ]);

      expect(run.results.map((r) => r.contestant.label).toList(),
          <String>['慢 · m', '快 · m']);
      expect(run.results.first.content, 'slow');
    });
  });

  group('单模型失败不影响其余', () {
    test('一个抛 429，另一个照常返回且指标齐全', () async {
      Future<ChatResponse> boom(ChatRequest request) async {
        await Future<void>.delayed(const Duration(milliseconds: 10));
        throw DioException(
          requestOptions: RequestOptions(path: '/chat/completions'),
          response: Response(
            requestOptions: RequestOptions(path: '/chat/completions'),
            statusCode: 429,
          ),
        );
      }

      Future<ChatResponse> fine(ChatRequest request) async => _reply(
            '答：```\ncode\n```',
            usage: const TokenUsage(
                promptTokens: 10, completionTokens: 20, totalTokens: 30),
          );

      final run = await const ArenaRunner().run('prompt', [
        _contestant('A · m', _FakeAdapter(boom)),
        _contestant('B · m', _FakeAdapter(fine)),
      ]);

      expect(run.results.first.failed, true);
      expect(run.results.first.error, contains('429'));
      expect(run.results.first.error, contains('修复'));
      expect(run.results.first.content, isEmpty);

      expect(run.results.last.ok, true);
      expect(run.results.last.tokens, 30);

      final summary = run.summary;
      expect(summary.totalModels, 2);
      expect(summary.successCount, 1);
      expect(summary.failedCount, 1);
      expect(summary.failed.single.contestant.label, 'A · m');
      expect(summary.metrics.single.model, 'B · m');
    });

    test('超时只吃掉那一个模型：错误说清超时与修复', () async {
      Future<ChatResponse> hang(ChatRequest request) async =>
          Completer<ChatResponse>().future;

      final runner = ArenaRunner(timeout: const Duration(milliseconds: 30));
      final run = await runner.run('prompt', [
        _contestant('卡死 · m', _FakeAdapter(hang)),
        _contestant('正常 · m',
            _FakeAdapter((request) async => _reply('回来了'))),
      ]);

      expect(run.results.first.failed, true);
      expect(run.results.first.error, contains('请求超时'));
      expect(run.results.first.error, contains('重试'));
      expect(run.results.last.ok, true);
      expect(run.summary.successCount, 1);
    });

    test('全部失败时摘要不炸：fastest 为 null、指标为空', () async {
      Future<ChatResponse> boom(ChatRequest request) async =>
          throw StateError('炸了');

      final run = await const ArenaRunner().run('prompt', [
        _contestant('A · m', _FakeAdapter(boom)),
        _contestant('B · m', _FakeAdapter(boom)),
      ]);

      expect(run.summary.metrics, isEmpty);
      expect(run.summary.fastest, isNull);
      expect(run.summary.similarities, isEmpty);
      expect(run.summary.failedCount, 2);
    });
  });

  group('指标计算', () {
    test('延迟取真实耗时：80ms 的假适配器记出 ≥60ms', () async {
      final run = await const ArenaRunner().run('prompt', [
        _contestant('A · m', _FakeAdapter((request) async {
          await Future<void>.delayed(const Duration(milliseconds: 80));
          return _reply('x');
        })),
        _contestant('B · m', _FakeAdapter((request) async => _reply('y'))),
      ]);

      expect(run.results.first.latencyMs, greaterThanOrEqualTo(60));
      expect(run.summary.fastest!.model, 'B · m');
    });

    test('字数/内容长度/代码块数按 arenaManager 口径', () {
      final summary = buildArenaSummary([
        ArenaResult(
          contestant: _contestant('A · m', _FakeAdapter((_) async => _reply(''))),
          content: 'hello world again',
          latencyMs: 100,
        ),
        ArenaResult(
          contestant: _contestant('B · m', _FakeAdapter((_) async => _reply(''))),
          content: '```dart\nvoid main() {}\n```\ntail\n```\nsecond\n```',
          latencyMs: 200,
        ),
      ]);

      final a = summary.metrics.firstWhere((m) => m.model == 'A · m');
      expect(a.contentLength, 'hello world again'.length);
      expect(a.wordCount, 3);
      expect(a.hasCode, false);
      expect(a.codeBlockCount, 0);

      final b = summary.metrics.firstWhere((m) => m.model == 'B · m');
      expect(b.hasCode, true);
      expect(b.codeBlockCount, 2);
      expect(a.latencyMs, 100);
    });

    test('Jaccard：相同 100、不相交 0、部分相交按词集比例', () {
      expect(arenaJaccardPercent('a b c', 'a b c'), 100);
      expect(arenaJaccardPercent('a b c', 'x y z'), 0);
      expect(arenaJaccardPercent('a b c', 'a b d'), 50);
      // 两个空答案不是 100%："都没说"不是"说得一样"。
      expect(arenaJaccardPercent('', ''), 0);
    });

    test('相似度只统计成功项，失败项不进相似度矩阵', () {
      final summary = buildArenaSummary([
        ArenaResult(
          contestant: _contestant('A · m', _FakeAdapter((_) async => _reply(''))),
          content: 'same words here',
        ),
        ArenaResult(
          contestant: _contestant('B · m', _FakeAdapter((_) async => _reply(''))),
          content: 'same words here',
        ),
        ArenaResult(
          contestant: _contestant('C · m', _FakeAdapter((_) async => _reply(''))),
          error: '请求失败',
        ),
      ]);

      expect(summary.similarities, hasLength(1));
      expect(summary.similarities.single.similarity, 100);
      expect(summary.failedCount, 1);
    });

    test('结构信号：有序列表/无序列表/标题/段落数', () {
      final summary = buildArenaSummary([
        ArenaResult(
          contestant: _contestant('A · m', _FakeAdapter((_) async => _reply(''))),
          content: '# 标题\n\n1. 第一\n2. 第二\n\n- 项目\n\n段落二',
        ),
      ]);

      final s = summary.structures.single;
      expect(s.hasHeadings, true);
      expect(s.hasNumberedList, true);
      expect(s.hasBulletList, true);
      expect(s.paragraphs, 4);
    });
  });

  group('启发式分数', () {
    test('确定性：同一输入两次同分，且不靠随机', () {
      const text = '```dart\nvoid main() {}\n```';
      expect(arenaHeuristicScore(text), arenaHeuristicScore(text));
      expect(arenaHeuristicScore(text), greaterThan(0));
    });

    test('被截断的回答低于完整回答', () {
      final complete = arenaHeuristicScore('这是完整的回答。');
      final cut = arenaHeuristicScore('```dart\nvoid main() {');
      expect(cut, lessThan(complete));
    });

    test('空内容 0 分', () {
      expect(arenaHeuristicScore(''), 0);
      expect(arenaHeuristicScore('   \n  '), 0);
    });

    test('分数有界（0-100）且只由内容决定', () {
      // 不靠时钟也不靠随机：同一份内容在哪台机器、跑几次都同分。
      for (final text in <String>[
        '',
        '短',
        '答' * 500,
        '```\nx\n```',
        '未闭合的```块',
      ]) {
        final score = arenaHeuristicScore(text);
        expect(score, inInclusiveRange(0, 100));
        expect(score, arenaHeuristicScore(text));
      }
    });
  });

  group('错误消息', () {
    DioException dioError(int? status) => DioException(
          requestOptions: RequestOptions(path: '/x'),
          response: status == null
              ? null
              : Response(
                  requestOptions: RequestOptions(path: '/x'),
                  statusCode: status,
                ),
        );

    test('超时说清秒数与修复', () {
      final msg = arenaErrorMessage(
          const TimeoutException('t'), const Duration(seconds: 120));
      expect(msg, contains('120'));
      expect(msg, contains('重试'));
    });

    test('401/403/404/429/5xx 各自带状态码与一行修复', () {
      for (final (status, keyword) in [
        (401, 'API key'),
        (403, '权限'),
        (404, '模型名'),
        (413, 'prompt'),
        (429, '限流'),
        (503, '稍后重试'),
      ]) {
        final msg = arenaErrorMessage(dioError(status), kArenaRequestTimeout);
        expect(msg, contains('$status'), reason: '$status 必须出现在消息里');
        expect(msg, contains('修复'), reason: '$status 必须带修复建议');
        expect(msg, contains(keyword), reason: '$status 应说明原因：$keyword');
      }
    });

    test('无状态码的网络错误也说修复', () {
      final msg = arenaErrorMessage(dioError(null), kArenaRequestTimeout);
      expect(msg, contains('网络错误'));
      expect(msg, contains('修复'));
    });

    test('Dio 自带的 receiveTimeout 说成超时，不甩锅给网络', () {
      // 回归护栏：OpenAI/DeepSeek 适配器的 Dio receiveTimeout 是 60s，比竞技场
      // 的 120s 先炸，产出无 statusCode 的 DioException。把它报成「网络错误」
      // 会让用户为慢模型去查网络——原因和修复双双错配（规则 2.2）。
      final msg = arenaErrorMessage(
        DioException(
          requestOptions: RequestOptions(path: '/x'),
          type: DioExceptionType.receiveTimeout,
        ),
        kArenaRequestTimeout,
      );
      expect(msg, contains('请求超时'));
      expect(msg, isNot(contains('网络错误')));
      expect(msg, contains('120'), reason: '要说明竞技场的外层上限是多少');
      expect(msg, contains('修复'));
    });

    test('未知异常原样带出，不吞', () {
      final msg =
          arenaErrorMessage(StateError('炸了'), kArenaRequestTimeout);
      expect(msg, contains('炸了'));
      expect(msg, contains('修复'));
    });
  });

  group('适配器选择与候选', () {
    test('四类端点各走既有适配器，不新写传输', () {
      expect(
        arenaAdapterFor(
          baseUrl: 'https://api.anthropic.com/v1',
          apiKey: 'k',
          model: 'm',
        ),
        isA<AnthropicAdapter>(),
      );
      expect(
        arenaAdapterFor(
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'k',
          model: 'm',
        ),
        isA<DeepSeekAdapter>(),
      );
      expect(
        arenaAdapterFor(
          baseUrl: kDefaultOllamaBaseUrl,
          apiKey: '',
          model: 'm',
        ),
        isA<OllamaAdapter>(),
      );
      expect(
        arenaAdapterFor(
          baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
          apiKey: 'k',
          model: 'm',
        ),
        isA<OpenAIAdapter>(),
      );
    });

    test('候选的 key 含提供商：同名模型在不同提供商不撞车', () {
      const a = ArenaCandidate(
          provider: 'A', model: 'same', baseUrl: 'https://a/v1', apiKey: 'k');
      const b = ArenaCandidate(
          provider: 'B', model: 'same', baseUrl: 'https://b/v1', apiKey: 'k');
      expect(a.key, 'A::same');
      expect(b.key, 'B::same');
      expect(a.key, isNot(b.key));
      expect(a.label, 'A · same');
      expect(a.toContestant().label, 'A · same');
      expect(a.toContestant().model, 'same');
    });
  });
}
