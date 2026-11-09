import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/services/conversation_db.dart';
import 'package:khy_os_client/core/services/knowledge_store.dart';
import 'package:khy_os_client/core/services/rag_retrieval.dart';

/// Pure-logic tests for rag_retrieval.dart plus the pure half of
/// knowledge_store.dart.
///
/// Deliberately does not touch sqflite or FlutterSecureStorage: the host has
/// no sqlite3.dll, so the real DB roundtrip of KnowledgeStore /
/// SessionHistorySource can only run on a device (same situation as
/// amoo_turn_test.dart). What is tested here is the half that needs no
/// native library — tokenizing, scoring, fusion, formatting, DDL and row
/// mapping. That is also where every silent lie lives: a wrong SQL statement
/// throws, but showing '学习知识' as '内置知识' misleads without a sound.
void main() {
  group('normalizeSpace / ragTruncate', () {
    test('连续空白折叠成单空格并去首尾', () {
      expect(normalizeSpace('  止损\t是\n离场  点位  '), '止损 是 离场 点位');
    });

    test('未超长原样返回，超长补省略号且不超 220', () {
      expect(ragTruncate('短文本'), '短文本');
      final truncated = ragTruncate('a' * 300);
      expect(truncated.length, ragSnippetMaxLen);
      expect(truncated, endsWith('...'));
    });

    test('maxLen 小于 3 时不抛', () {
      expect(ragTruncate('abcd', maxLen: 2), '...');
    });
  });

  group('tokenize', () {
    test('中文按 1/2/3 gram 切分', () {
      expect(tokenize('量化'), <String>['量', '量化', '化']);
      expect(tokenize('止损'), <String>['止', '止损', '损']);
    });

    test('长中文串的三 gram 不越界', () {
      expect(tokenize('量化交易'), <String>[
        '量', '量化', '量化交',
        '化', '化交', '化交易',
        '交', '交易',
        '易',
      ]);
    });

    test('英文词带 4 前缀与 ing/tion/ed 词干', () {
      // backtesting: whole word + 4-char prefix + ing stripped
      expect(tokenize('backtesting'), <String>['backtesting', 'back', 'backtest']);
      // position: the 4-char prefix and the tion-strip both yield 'posi'
      expect(tokenize('position'), <String>['position', 'posi']);
      // hedged: the 4-char prefix and the ed-strip both yield 'hedg'
      expect(tokenize('hedged'), <String>['hedged', 'hedg']);
    });

    test('下划线算英文词的一部分，另取 4 前缀', () {
      expect(tokenize('stop_loss'), <String>['stop_loss', 'stop']);
    });

    test('数字与标点被切开，空串与纯标点无 token', () {
      expect(tokenize('rsi 14, macd!'), <String>['rsi', '14', 'macd']);
      expect(tokenize(''), isEmpty);
      expect(tokenize('，。！'), isEmpty);
    });

    test('同一 token 只出现一次', () {
      final tokens = tokenize('回测回测');
      expect(tokens.toSet().length, tokens.length);
    });
  });

  group('expandWithSynonyms', () {
    test('命中词表时按序追加同义词', () {
      expect(expandWithSynonyms(<String>['量化']),
          <String>['量化', 'quant', '程序化']);
    });

    test('未命中词表时原样返回', () {
      expect(expandWithSynonyms(<String>['随便']), <String>['随便']);
    });

    test('双向词表都能扩展', () {
      expect(expandWithSynonyms(<String>['quant']), <String>['quant', '量化']);
      expect(expandWithSynonyms(<String>['stop_loss']),
          <String>['stop_loss', '止损']);
    });

    test('不修改入参', () {
      final tokens = <String>['止损'];
      expandWithSynonyms(tokens);
      expect(tokens, <String>['止损']);
    });
  });

  group('overlapScore', () {
    test('空查询或空文本得 0', () {
      expect(overlapScore(<String>[], '任何文本'), 0);
      expect(overlapScore(<String>['量化'], ''), 0);
      expect(overlapScore(<String>['量化'], '，。'), 0);
    });

    test('直接命中计满分', () {
      expect(overlapScore(<String>['量化'], '量化交易入门'), 1.0);
    });

    test('同义词命中有 0.3 权重', () {
      // '止损' expands to stop_loss / 离场, both present in the doc:
      // synHit 2 / synTotal 2 * 0.3
      final query = tokenize('止损');
      final score = overlapScore(
          query, 'stop_loss 是离场点位', expandWithSynonyms(query));
      expect(score, closeTo(0.3, 1e-9));
    });

    test('模糊部分命中按 0.15 权重折算', () {
      // Query backtesting/back/backtest against doc 'backtest': 2/3 direct;
      // fuzzy matches all three query tokens at 0.5 each = 1.5,
      // so (1.5/3)*0.15 = 0.075
      final score = overlapScore(
          <String>['backtesting', 'back', 'backtest'], 'backtest');
      expect(score, closeTo(2 / 3 + 0.075, 1e-9));
    });

    test('总分封顶 1', () {
      final query = tokenize('量化');
      final score =
          overlapScore(query, '量化 quant 程序化', expandWithSynonyms(query));
      expect(score, 1.0);
    });

    test('扩展集不大于查询集时同义词项为 0', () {
      // Passing the same set by hand: expandedTokens.length ==
      // queryTokens.length skips the synonym branch, so the score is pure
      // direct overlap.
      final query = <String>['量化'];
      expect(overlapScore(query, '量化交易', query), 1.0);
    });
  });

  group('keywordScore', () {
    test('空查询或空关键词得 0', () {
      expect(keywordScore('', <String>['止损']), 0);
      expect(keywordScore('量化', <String>[]), 0);
    });

    test('查询包含关键词或关键词包含查询都算整中', () {
      expect(keywordScore('量化', <String>['量化交易']), 1.0);
      expect(keywordScore('量化交易策略', <String>['量化']), 1.0);
    });

    test('分母封顶 4 个关键词', () {
      // 5 keywords with 1 hit: base takes min(4,5)=4
      expect(
          keywordScore('量化', <String>['量化交易', 'a', 'b', 'c', 'd']),
          closeTo(0.25, 1e-9));
    });

    test('共享前缀 >= 2 按比例计部分分', () {
      // 'quantx' and 'quantize' share a 5-char prefix: 5/8 * 0.4 = 0.25
      expect(keywordScore('quantx', <String>['quantize']), closeTo(0.25, 1e-9));
    });

    test('前缀只共享 1 字符不计分', () {
      expect(keywordScore('ax', <String>['ab']), 0);
    });
  });

  group('scoreKnowledge', () {
    KnowledgeItem item(
      String title,
      String content, {
      List<String> keywords = const <String>[],
      String source = 'learned',
    }) {
      return KnowledgeItem(
        title: title,
        content: content,
        keywords: keywords,
        source: source,
      );
    }

    test('按分数降序返回，阈值以下被滤掉', () {
      final hits = scoreKnowledge('止损', <KnowledgeItem>[
        item('无关标题', '完全不相干的内容'),
        item('止损策略', '止损是离场点位， quant 离场管理'),
        item('回测基础', '回测 backtest 是什么'),
      ]);
      expect(hits.length, 1);
      expect(hits.single.title, '止损策略');
    });

    test('0.06 阈值以下不进候选', () {
      expect(scoreKnowledge('止损', <KnowledgeItem>[item('无关', '毫不相干')]),
          isEmpty);
    });

    test('空 content 的条目不进候选', () {
      // A full title hit gives 0.18 + source 0.04 + coverage 0.06, but there
      // is no content to inject.
      expect(scoreKnowledge('止损', <KnowledgeItem>[item('止损', '   ')]),
          isEmpty);
    });

    test('builtin 与 learned 的 sourceBoost 差 0.04', () {
      final learned = scoreKnowledge('止损', <KnowledgeItem>[
        item('止损策略', '止损点位', source: 'learned'),
      ]).single;
      final builtin = scoreKnowledge('止损', <KnowledgeItem>[
        item('止损策略', '止损点位', source: 'builtin'),
      ]).single;
      expect(learned.score - builtin.score, closeTo(0.04, 1e-9));
    });

    test('titleBoost 大小写敏感是平台原样', () {
      // Platform :294 compares the un-lowercased query against the raw title.
      // Both items share the same content, so the only difference is title
      // case and the gap is exactly titleBoost 0.18.
      final hits = scoreKnowledge('RISK', <KnowledgeItem>[
        item('Risk 管理', '风险控制'),
        item('RISK 管理', '风险控制'),
      ]);
      expect(hits.length, 2);
      expect(hits.first.title, 'RISK 管理');
      expect(hits.first.score - hits.last.score, closeTo(0.18, 1e-9));
    });

    test('limit 截断', () {
      final items = List<KnowledgeItem>.generate(
        5,
        (i) => item('止损策略 $i', '止损点位 $i'),
      );
      expect(scoreKnowledge('止损', items, limit: 2).length, 2);
    });
  });

  group('scoreSessionRows', () {
    SessionRow row(
      String content,
      int timestampMs, {
      String title = '旧对话',
      String role = 'user',
      String sessionId = 's1',
    }) {
      return SessionRow(
        sessionId: sessionId,
        title: title,
        role: role,
        content: content,
        timestamp: timestampMs,
      );
    }

    final now = DateTime.utc(2026, 11, 4, 12);

    test('新近度随时间衰减', () {
      final fresh = scoreSessionRows('止损', <SessionRow>[
        row('止损点位', now.millisecondsSinceEpoch),
      ]).single;
      final old = scoreSessionRows('止损', <SessionRow>[
        row('止损点位', now.millisecondsSinceEpoch - 30 * 86400000),
      ]).single;
      expect(fresh.score, closeTo(0.52 + 0.18, 1e-9));
      expect(old.score, closeTo(0.52 + (1 - 30 / 45) * 0.18, 1e-9));
      expect(fresh.score, greaterThan(old.score));
    });

    test('45 天以上的消息新近度为 0', () {
      final hits = scoreSessionRows('止损', <SessionRow>[
        row('止损点位', now.millisecondsSinceEpoch - 60 * 86400000),
      ], now: now);
      expect(hits.single.score, closeTo(0.52, 1e-9));
    });

    test('0.07 阈值以下不进候选（陈旧且不相关）', () {
      final hits = scoreSessionRows('止损', <SessionRow>[
        row('完全无关的内容', now.millisecondsSinceEpoch - 60 * 86400000),
      ], now: now);
      expect(hits, isEmpty);
    });

    test('新近度单独就能过阈值（平台原样，未加额外过滤）', () {
      // Platform :350: recency*0.18 lets a fresh but irrelevant message
      // through. This locks that behavior in so nobody "helpfully" adds a
      // filter and forks the desktop semantics.
      final hits = scoreSessionRows('止损', <SessionRow>[
        row('完全无关的内容', now.millisecondsSinceEpoch),
      ], now: now);
      expect(hits.single.score, closeTo(0.18, 1e-9));
    });

    test('时间戳 0 按"现在"计（平台 || 语义）', () {
      final hits = scoreSessionRows('止损', <SessionRow>[
        row('止损点位', 0),
      ], now: now);
      expect(hits.single.score, closeTo(0.52 + 0.18, 1e-9));
    });

    test('未来时间戳的负年龄被钳为 0，等同"刚刚"', () {
      final hits = scoreSessionRows('止损', <SessionRow>[
        row('止损点位', now.millisecondsSinceEpoch + 86400000),
      ], now: now);
      expect(hits.single.score, closeTo(0.52 + 0.18, 1e-9));
    });

    test('limit 截断', () {
      final rows = List<SessionRow>.generate(
        5,
        (i) => row('止损点位 $i', now.millisecondsSinceEpoch - i * 1000),
      );
      expect(scoreSessionRows('止损', rows, limit: 2).length, 2);
    });
  });

  group('mergeCandidates / dedupe', () {
    KnowledgeCandidate knowledge(String title, String content, double score) =>
        KnowledgeCandidate(
          source: 'learned',
          category: '策略',
          title: title,
          content: content,
          score: score,
        );

    SessionCandidate session(String title, String content, double score) =>
        SessionCandidate(
          sessionId: 's1',
          title: title,
          role: 'user',
          content: content,
          timestamp: 0,
          score: score,
        );

    test('同源同标题同内容前缀只留一条', () {
      final dup = knowledge('止损', '止损点位说明' + 'x' * 200, 0.5);
      final merged =
          mergeCandidates(<KnowledgeCandidate>[dup, dup], const <SessionCandidate>[]);
      expect(merged.length, 1);
    });

    test('跨源同内容不去重（kind 是真源的一部分）', () {
      final merged = mergeCandidates(
        <KnowledgeCandidate>[knowledge('止损', '同样的正文', 0.5)],
        <SessionCandidate>[session('旧对话', '同样的正文', 0.5)],
      );
      expect(merged.length, 2);
    });

    test('按分数降序合并并截断到 totalTopK', () {
      final knowledgeItems = <KnowledgeCandidate>[
        knowledge('k1', 'c1', 0.1),
        knowledge('k2', 'c2', 0.9),
        knowledge('k3', 'c3', 0.5),
        knowledge('k4', 'c4', 0.4),
      ];
      final sessions = <SessionCandidate>[
        session('s1', 'c1', 0.8),
        session('s2', 'c2', 0.2),
        session('s3', 'c3', 0.3),
      ];
      final merged = mergeCandidates(knowledgeItems, sessions, totalTopK: 5);
      expect(merged.map((c) => c.score).toList(),
          <double>[0.9, 0.8, 0.5, 0.4, 0.3]);
    });

    test('默认 totalTopK 为 6', () {
      final many = List<KnowledgeCandidate>.generate(
        9,
        (i) => knowledge('k$i', 'c$i', 0.1 * (9 - i)),
      );
      expect(
          mergeCandidates(many, const <SessionCandidate>[]).length, 6);
    });

    test('同分时按入序稳定（知识库在前）', () {
      final merged = mergeCandidates(
        <KnowledgeCandidate>[knowledge('k', 'c', 0.5)],
        <SessionCandidate>[session('s', 'c', 0.5)],
      );
      expect(merged.first, isA<KnowledgeCandidate>());
    });
  });

  group('formatContext', () {
    test('知识条目带来源/分类标签，会话条目带标题', () {
      final text = formatContext(const <RagCandidate>[
        KnowledgeCandidate(
          source: 'learned',
          category: '策略',
          title: '止损策略',
          content: '止损是离场点位',
          score: 0.9,
        ),
        KnowledgeCandidate(
          source: 'builtin',
          category: '',
          title: '',
          content: '内置条目内容',
          score: 0.8,
        ),
        SessionCandidate(
          sessionId: 'abc',
          title: '上周的对话',
          role: 'user',
          content: '上次聊过止损',
          timestamp: 0,
          score: 0.7,
        ),
      ]);
      expect(text, startsWith(ragContextHeader));
      expect(text, contains('1. [学习知识|策略] 止损策略'));
      expect(text, contains('   止损是离场点位'));
      expect(text, contains('2. [内置知识|通用] 无标题'));
      expect(text, contains('3. [历史会话|上周的对话]'));
      expect(text, contains('   上次聊过止损'));
      expect(text, endsWith(ragContextTail));
    });

    test('无标题会话回退 sessionId 再回退 untitled', () {
      final text = formatContext(const <RagCandidate>[
        SessionCandidate(
          sessionId: 'conv-7',
          title: '',
          role: 'user',
          content: 'x',
          timestamp: 0,
          score: 0.5,
        ),
        SessionCandidate(
          sessionId: '',
          title: '',
          role: 'user',
          content: 'y',
          timestamp: 0,
          score: 0.4,
        ),
      ]);
      expect(text, contains('[历史会话|conv-7]'));
      expect(text, contains('[历史会话|untitled]'));
    });

    test('单条内容截到 220 字符', () {
      final text = formatContext(const <RagCandidate>[
        KnowledgeCandidate(
          source: 'learned',
          category: '策略',
          title: 't',
          content: '止' * 400,
          score: 0.9,
        ),
      ]);
      final snippetLine = text.split('\n')[2];
      expect(snippetLine.length, 3 + ragSnippetMaxLen);
      expect(snippetLine, endsWith('...'));
    });

    test('整体不超过 maxChars，超出时以换行省略号收尾', () {
      final many = List<RagCandidate>.generate(
        12,
        (i) => KnowledgeCandidate(
          source: 'learned',
          category: '策略',
          title: '标题 $i',
          content: '内' * 300,
          score: 0.9 - i * 0.01,
        ),
      );
      final text = formatContext(many, maxChars: defaultMaxContextChars);
      expect(text.length, lessThanOrEqualTo(defaultMaxContextChars));
      expect(text, endsWith('\n...'));
      // Truncation only bites the tail: the leading usage note must survive.
      expect(text, startsWith(ragContextHeader));
    });

    test('未超限时完整保留尾句', () {
      final text = formatContext(const <RagCandidate>[
        KnowledgeCandidate(
          source: 'learned',
          category: '策略',
          title: 't',
          content: 'c',
          score: 0.9,
        ),
      ]);
      expect(text.length, lessThanOrEqualTo(defaultMaxContextChars));
      expect(text, endsWith(ragContextTail));
    });
  });

  group('shouldRetrieve 四类跳过', () {
    test('问候语跳过', () {
      const greetings = <String>[
        'hi', 'hello', 'hey', 'yo', '你好', '您好', '在吗', '在么', '嗨',
      ];
      for (final greeting in greetings) {
        expect(shouldRetrieve(greeting), isFalse, reason: greeting);
      }
      expect(shouldRetrieve('  Hello  '), isFalse);
    });

    test('追问跳过', () {
      expect(shouldRetrieve('量化交易怎么做', isFollowUp: true), isFalse);
      expect(shouldRetrieve('量化交易怎么做'), isTrue);
    });

    test('斜杠命令跳过', () {
      expect(shouldRetrieve('/kb_search 止损'), isFalse);
      expect(shouldRetrieve('/model'), isFalse);
    });

    test('短英文跳过，短中文不跳过', () {
      expect(shouldRetrieve('abc'), isFalse);
      expect(shouldRetrieve('ab'), isFalse);
      expect(shouldRetrieve('止损'), isTrue);
      expect(shouldRetrieve('abcd'), isTrue);
    });

    test('开关关闭跳过，空查询跳过', () {
      expect(shouldRetrieve('量化交易', enabled: false), isFalse);
      expect(shouldRetrieve(''), isFalse);
      expect(shouldRetrieve('   '), isFalse);
    });
  });

  group('buildRetrievalContext', () {
    final now = DateTime.utc(2026, 11, 4, 12);

    KnowledgeItem item(String title, String content) =>
        KnowledgeItem(title: title, content: content);

    test('跳过时 used=false 且不带 context', () {
      final result = buildRetrievalContext('你好');
      expect(result.used, isFalse);
      expect(result.context, isEmpty);
      expect(result.outcome, RagOutcome.skipped);
    });

    test('无命中时 used=false、outcome=noMatch，两源计数为 0', () {
      final result = buildRetrievalContext(
        '量子纠缠的十种解释',
        knowledge: <KnowledgeItem>[item('做饭', '今天吃什么')],
        now: now,
      );
      expect(result.outcome, RagOutcome.noMatch);
      expect(result.used, isFalse);
      expect(result.knowledgeHits, 0);
      expect(result.sessionHits, 0);
    });

    test('双源都命中时合并注入并分别计数', () {
      final result = buildRetrievalContext(
        '止损',
        knowledge: <KnowledgeItem>[item('止损策略', '止损是离场点位')],
        sessions: <SessionRow>[
          SessionRow(
            sessionId: 's1',
            title: '旧对话',
            role: 'user',
            content: '上次聊的止损',
            timestamp: now.millisecondsSinceEpoch,
          ),
        ],
        now: now,
      );
      expect(result.outcome, RagOutcome.matched);
      expect(result.used, isTrue);
      expect(result.knowledgeHits, 1);
      expect(result.sessionHits, 1);
      expect(result.selectedCount, 2);
      expect(result.contextChars, result.context.length);
      expect(result.context, contains('[学习知识|通用] 止损策略'));
      expect(result.context, contains('[历史会话|旧对话]'));
      expect(result.context, endsWith(ragContextTail));
    });

    test('双源合并后按 totalTopK 截断', () {
      final items = List<KnowledgeItem>.generate(
        5,
        (i) => item('止损策略 $i', '止损点位 $i'),
      );
      final rows = List<SessionRow>.generate(
        3,
        (i) => SessionRow(
          sessionId: 's$i',
          title: '对话 $i',
          role: 'user',
          content: '止损 $i',
          timestamp: now.millisecondsSinceEpoch - i * 1000,
        ),
      );
      final result = buildRetrievalContext(
        '止损',
        knowledge: items,
        sessions: rows,
        totalTopK: 4,
        now: now,
      );
      expect(result.knowledgeHits, 4);
      expect(result.sessionHits, 3);
      expect(result.selectedCount, 4);
    });

    test('topK 参数被钳在平台区间内', () {
      final items = List<KnowledgeItem>.generate(
        8,
        (i) => item('止损策略 $i', '止损点位 $i'),
      );
      final result = buildRetrievalContext(
        '止损',
        knowledge: items,
        knowledgeTopK: 99,
        totalTopK: 0,
        now: now,
      );
      expect(result.knowledgeHits, 8);
      expect(result.selectedCount, 1);
    });

    test('maxChars 被钳到平台下限 400', () {
      final result = buildRetrievalContext(
        '止损',
        knowledge: <KnowledgeItem>[item('止损策略', '止损是离场点位')],
        maxChars: 10,
        now: now,
      );
      expect(result.context.length, lessThanOrEqualTo(400));
      expect(result.context.length, greaterThan(10));
    });
  });

  group('KnowledgeSchema', () {
    test('建表语句覆盖约定字段', () {
      const ddl = KnowledgeSchema.createTable;
      for (final column in <String>[
        'title',
        'content',
        'keywords',
        'category',
        'source',
        'ts',
      ]) {
        expect(ddl, contains(column), reason: '缺列 $column');
      }
      expect(ddl, contains(KnowledgeSchema.table));
      expect(KnowledgeSchema.indexTs, contains('idx_knowledge_ts'));
      expect(KnowledgeSchema.version, 1);
    });
  });

  group('KnowledgeEntry 行映射', () {
    test('toRow/fromRow 往返保持每个字段', () {
      const entry = KnowledgeEntry(
        id: 3,
        title: '止损策略',
        content: '止损是离场点位',
        keywords: <String>['止损', 'stop_loss'],
        category: '风险管理',
        source: 'learned',
        ts: 1730000000000,
      );
      final back = KnowledgeEntry.fromRow(entry.toRow());
      expect(back.id, entry.id);
      expect(back.title, entry.title);
      expect(back.content, entry.content);
      expect(back.keywords, entry.keywords);
      expect(back.category, entry.category);
      expect(back.source, entry.source);
      expect(back.ts, entry.ts);
    });

    test('keywords 以 JSON 存，读坏值不抛', () {
      expect(
        KnowledgeEntry.fromRow(const <String, Object?>{'keywords': 'not json'})
            .keywords,
        isEmpty,
      );
      expect(
        KnowledgeEntry.fromRow(const <String, Object?>{}).keywords,
        isEmpty,
      );
      expect(
        KnowledgeEntry.fromRow(
          const <String, Object?>{'keywords': '["a", 1, "b"]'},
        ).keywords,
        <String>['a', 'b'],
      );
    });

    test('导入工厂裁剪并丢弃空关键词', () {
      final entry = KnowledgeEntry.fromImport(
        title: '  止损策略  ',
        content: '  止损是离场点位  ',
        keywords: <String>[' 止损 ', '', '   '],
        category: '  风险管理 ',
        source: '  ',
        ts: 1730000000000,
      );
      expect(entry.title, '止损策略');
      expect(entry.content, '止损是离场点位');
      expect(entry.keywords, <String>['止损']);
      expect(entry.category, '风险管理');
      expect(entry.source, 'learned');
    });

    test('ts 缺省用当前时间', () {
      final before = DateTime.now().millisecondsSinceEpoch;
      final entry = KnowledgeEntry.fromImport(title: 't', content: 'c');
      expect(entry.ts, greaterThanOrEqualTo(before));
    });

    test('toItem 把行映射成检索视图', () {
      const entry = KnowledgeEntry(
        id: 1,
        title: 't',
        content: 'c',
        keywords: <String>['k'],
        category: 'cat',
        source: 'learned',
        ts: 0,
      );
      final item = entry.toItem();
      expect(item.title, 't');
      expect(item.content, 'c');
      expect(item.keywords, <String>['k']);
      expect(item.category, 'cat');
      expect(item.source, 'learned');
    });
  });

  group('SessionHistorySource.rowsOf', () {
    test('消息映射成行，空内容跳过', () {
      final conv = Conversation(
        id: 'conv-1',
        title: '旧对话',
        messages: <ChatMsg>[
          ChatMsg(
            role: 'user',
            content: '止损怎么设',
            timestamp: DateTime.utc(2026, 11, 1),
          ),
          ChatMsg(
            role: 'assistant',
            content: '   ',
            timestamp: DateTime.utc(2026, 11, 2),
          ),
          ChatMsg(
            role: 'assistant',
            content: '设在成本价下方',
            timestamp: DateTime.utc(2026, 11, 3),
          ),
        ],
      );
      final rows = SessionHistorySource.rowsOf(conv);
      expect(rows.length, 2);
      expect(rows.first.sessionId, 'conv-1');
      expect(rows.first.title, '旧对话');
      expect(rows.first.role, 'user');
      expect(rows.first.content, '止损怎么设');
      expect(
        rows.first.timestamp,
        DateTime.utc(2026, 11, 1).millisecondsSinceEpoch,
      );
      expect(rows.last.role, 'assistant');
    });

    test('空会话给空行', () {
      expect(SessionHistorySource.rowsOf(Conversation(id: 'c')), isEmpty);
    });
  });
}
