import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/gateway/market_catalog.dart';

/// 生态市场载荷的读法测试。
///
/// 这些断言钉的是**后端真实返回的形状**（`GET /api/eco-markets` 的 data）：
/// 不同上游的字段差异很大，手机端只建模自己用得到的部分，其余原样保留。
/// 任何"上游新增字段"都不该让解析失败——只有 eco 缺失的整组才被丢弃。
void main() {
  group('MarketCatalogPayload.fromJson', () {
    test('parses the live payload shape', () {
      final payload = MarketCatalogPayload.fromJson(<String, dynamic>{
        'status': 'ok',
        'generatedAt': '2026-11-02T10:00:00.000Z',
        'fetchedAt': '2026-11-02T10:02:03.000Z',
        'refreshing': false,
        'refreshStartedAt': '',
        'rules': <dynamic>['只安装 MIT/Apache-2.0', '阻塞条目不执行'],
        'licenseGate': 'MIT / Apache-2.0 / BSD',
        'ecosystems': <dynamic>[
          <String, dynamic>{
            'eco': 'stepfun',
            'title': '阶跃水产市场',
            'live': true,
            'surveyedAt': '2026-11-02T10:01:00.000Z',
            'counts': <String, dynamic>{'entries': 2, 'blocked': 1},
            'entries': <dynamic>[
              <String, dynamic>{
                'name': 'office-tools',
                'what': '文档与表格处理',
                'type': 'skill',
                'license': 'MIT',
                'author': 'stepfun',
                'khyCommand': 'khy skill add https://example.invalid/office',
                'installSpec': <String, dynamic>{
                  'mode': 'skill',
                  'source': <String, dynamic>{'url': 'https://example.invalid/office'},
                },
                'agentScope': <dynamic>['office'],
              },
              <String, dynamic>{
                'name': 'already-installed',
                'installed': true,
                'installedAt': '2026-11-01T09:00:00.000Z',
                'installedSummary': 'khy skill add',
              },
            ],
            'blocked': <dynamic>[
              <String, dynamic>{
                'name': 'paid-agent',
                'reason': '需要商业授权',
              },
            ],
            'marketplaces': <dynamic>[
              <String, dynamic>{'id': 'stepfun-openclaw', 'url': 'https://example.invalid'},
            ],
            'uncertainties': <dynamic>['头像来自上游，可能过期'],
          },
        ],
        'sources': <dynamic>[
          <String, dynamic>{
            'id': 'stepfun-openclaw',
            'title': '阶跃 OpenClaw',
            'kind': 'live',
            'status': 'ok',
            'eco': 'stepfun',
            'entries': 2,
            'blocked': 1,
            'fetchedAt': '2026-11-02T10:02:00.000Z',
            'message': '',
          },
          <String, dynamic>{
            'id': 'open-vsx',
            'title': 'Open VSX',
            'kind': 'live',
            'status': 'stale',
            'message': '上次拉取失败，沿用缓存',
          },
        ],
        'totals': <String, dynamic>{
          'ecosystems': 1,
          'entries': 2,
          'blocked': 1,
          'installed': 1,
          'live': 1,
        },
        'warnings': <dynamic>['MCP Registry 未接入：超时'],
        'degraded': '',
        'futureField': <String, dynamic>{'ignored': true},
      });

      expect(payload.ecosystems, hasLength(1));
      final eco = payload.ecosystems.single;
      expect(eco.label, '阶跃水产市场');
      expect(eco.live, isTrue);
      expect(eco.entries, hasLength(2));
      expect(eco.blocked, hasLength(1));
      expect(eco.marketplaces, hasLength(1));
      expect(eco.uncertainties, <String>['头像来自上游，可能过期']);
      expect(eco.counts['entries'], 2);

      expect(payload.sources, hasLength(2));
      expect(payload.sources[1].label, 'Open VSX');
      expect(payload.totals!.installed, 1);
      expect(payload.warnings, <String>['MCP Registry 未接入：超时']);
      expect(payload.licenseGate, 'MIT / Apache-2.0 / BSD');
      expect(payload.rules, hasLength(2));
      expect(payload.refreshing, isFalse);
    });

    test('drops ecosystems without an eco and tolerates non-map rows', () {
      final payload = MarketCatalogPayload.fromJson(<String, dynamic>{
        'ecosystems': <dynamic>[
          'not-a-map',
          <String, dynamic>{'title': '无 eco'},
          <String, dynamic>{'eco': 'kimi-code', 'entries': <dynamic>['bad', 42]},
        ],
        'sources': <dynamic>['bad'],
      });
      expect(payload.ecosystems, hasLength(1));
      expect(payload.ecosystems.single.eco, 'kimi-code');
      expect(payload.ecosystems.single.entries, isEmpty);
      expect(payload.sources, isEmpty);
    });

    test('computes totals when the backend omits them', () {
      final payload = MarketCatalogPayload.fromJson(<String, dynamic>{
        'ecosystems': <dynamic>[
          <String, dynamic>{
            'eco': 'a',
            'live': true,
            'entries': <dynamic>[
              <String, dynamic>{'name': 'x', 'installed': true},
              <String, dynamic>{'name': 'y'},
            ],
            'blocked': <dynamic>[
              <String, dynamic>{'name': 'z'},
            ],
          },
          <String, dynamic>{
            'eco': 'b',
            'entries': <dynamic>[
              <String, dynamic>{'name': 'w'},
            ],
          },
        ],
      });
      final totals = payload.effectiveTotals;
      expect(totals.ecosystems, 2);
      expect(totals.entries, 3);
      expect(totals.blocked, 1);
      expect(totals.installed, 1);
      expect(totals.live, 1);
    });

    test('treats a non-map totals field as missing', () {
      final payload = MarketCatalogPayload.fromJson(<String, dynamic>{
        'totals': 'nope',
        'ecosystems': <dynamic>[
          <String, dynamic>{'eco': 'a', 'entries': <dynamic>[]},
        ],
      });
      expect(payload.totals, isNull);
      expect(payload.effectiveTotals.ecosystems, 1);
    });
  });

  group('entry helpers', () {
    test('name falls back instead of rendering an empty row', () {
      expect(marketEntryName(<String, dynamic>{}), '未命名条目');
      expect(marketEntryName(<String, dynamic>{'name': '  '}), '未命名条目');
      expect(marketEntryName(<String, dynamic>{'name': 'zeta'}), 'zeta');
    });

    test('haystack covers name, what, author and commands, lowercased', () {
      final haystack = marketEntryHaystack(<String, dynamic>{
        'name': 'Office Helper',
        'what': '表格处理',
        'author': 'StepFun',
        'khyCommand': 'khy skill add https://example.invalid/office',
        'license': 'MIT',
        'unknown': '不该进搜索',
      });
      expect(haystack, contains('office helper'));
      expect(haystack, contains('表格处理'));
      expect(haystack, contains('stepfun'));
      expect(haystack, contains('khy skill add'));
      expect(haystack, contains('mit'));
      expect(haystack, isNot(contains('不该进搜索')));
    });

    test('accessCommand prefers the translated khy command', () {
      expect(
        marketAccessCommand(<String, dynamic>{
          'khyCommand': 'khy mcp add https://example.invalid/mcp',
          'upstreamUrl': 'https://example.invalid/other',
          'compat': 'adapter-needed',
        }),
        'khy mcp add https://example.invalid/mcp',
      );
    });

    test('accessCommand derives a command only for direct entries', () {
      expect(
        marketAccessCommand(<String, dynamic>{
          'upstreamUrl': 'https://example.invalid/skill',
          'compat': 'direct',
          'khyosMarket': 'skill',
        }),
        'khy skill add https://example.invalid/skill',
      );
      expect(
        marketAccessCommand(<String, dynamic>{
          'upstreamUrl': 'https://example.invalid/ext',
          'compat': 'direct',
          'khyosMarket': 'extension',
        }),
        'khy ext install https://example.invalid/ext',
      );
      expect(
        marketAccessCommand(<String, dynamic>{
          'upstreamUrl': 'https://example.invalid/needs-adapter',
          'compat': 'adapter-needed',
          'khyosMarket': 'skill',
        }),
        isNull,
      );
      expect(
        marketAccessCommand(<String, dynamic>{
          'compat': 'direct',
          'khyosMarket': 'skill',
        }),
        isNull,
      );
    });

    test('category label takes the backend label, then the key, then 其他', () {
      expect(
        marketCategoryLabel(<String, dynamic>{'categoryLabel': '办公与文档', 'category': 'office'}),
        '办公与文档',
      );
      expect(marketCategoryLabel(<String, dynamic>{'category': 'dev'}), '开发工具');
      expect(marketCategoryLabel(<String, dynamic>{'category': 'unknown'}), '其他');
      expect(marketCategoryLabel(<String, dynamic>{}), '其他');
    });

    test('install mode is skill/mcp only, and never for blocked or covered', () {
      expect(
        marketInstallMode(<String, dynamic>{
          'installSpec': <String, dynamic>{'mode': 'skill'},
          'compat': 'direct',
        }),
        'skill',
      );
      expect(
        marketInstallMode(<String, dynamic>{
          'installSpec': <String, dynamic>{'mode': 'mcp'},
        }),
        'mcp',
      );
      expect(
        marketInstallMode(<String, dynamic>{
          'installSpec': <String, dynamic>{'mode': 'skill'},
          'compat': 'blocked',
        }),
        isNull,
      );
      expect(
        marketInstallMode(<String, dynamic>{
          'installSpec': <String, dynamic>{'mode': 'skill'},
          'compat': 'covered',
        }),
        isNull,
      );
      expect(
        marketInstallMode(<String, dynamic>{
          'installSpec': <String, dynamic>{'mode': 'extension'},
        }),
        isNull,
      );
      expect(marketInstallMode(<String, dynamic>{}), isNull);
    });

    test('entry key prefers marketId, then owner:name, then eco:name', () {
      expect(
        marketEntryKey(<String, dynamic>{'marketId': 'stepfun:office'}, 'stepfun'),
        'stepfun:office',
      );
      expect(
        marketEntryKey(
          <String, dynamic>{'name': 'office', 'agentScope': <dynamic>['stepfun']},
          'ignored',
        ),
        'stepfun:office',
      );
      expect(
        marketEntryKey(<String, dynamic>{'name': 'office'}, 'kimi-code'),
        'kimi-code:office',
      );
    });
  });

  group('install / uninstall', () {
    test('endpoints live under the skills route, not a second install surface', () {
      expect(MarketCatalogClient.installPath, '/api/skills/install');
      expect(MarketCatalogClient.uninstallPath, '/api/skills/uninstall');
    });

    test('install payload carries the entry and the collected values', () {
      final entry = <String, dynamic>{
        'name': 'office',
        'installSpec': <String, dynamic>{'mode': 'skill'},
      };
      final payload = marketInstallPayload(
        entry,
        env: <String, String>{'TOKEN': 't'},
        headers: <String, String>{'X-Key': 'k'},
      );
      expect(payload.keys.toSet(), <String>{'entry', 'values'});
      // 条目原样透传：桌面 Electron IPC 传的就是同一个 entry 对象，
      // 手机侧重挑字段会让两边慢慢对不上。
      expect(payload['entry'], same(entry));
      expect(
        payload['values'],
        <String, dynamic>{
          'env': <String, String>{'TOKEN': 't'},
          'headers': <String, String>{'X-Key': 'k'},
        },
      );
      // 没有必填项时空 map 也要在：缺键与空对象对后端必须同义。
      expect(
        marketInstallPayload(entry)['values'],
        <String, dynamic>{'env': <String, String>{}, 'headers': <String, String>{}},
      );
    });

    test('install result keeps partial apart from a clean success', () {
      final partial = MarketInstallResult.fromJson(<String, dynamic>{
        'ok': true,
        'mode': 'skill',
        'partial': true,
        'installed': <dynamic>[
          <String, dynamic>{'name': 'office'},
          <String, dynamic>{'name': 'notes'},
        ],
        'message': '已导入 2/3 个技能；失败：repo-c：网络错误',
      });
      expect(partial.ok, isTrue);
      expect(partial.partial, isTrue);
      expect(partial.mode, 'skill');
      expect(partial.artifacts, <String>['office', 'notes']);
      expect(partial.message, contains('2/3'));

      final clean = MarketInstallResult.fromJson(<String, dynamic>{
        'ok': true,
        'mode': 'mcp',
        'installed': <dynamic>[<String, dynamic>{'name': 'fetch'}],
        'message': '已写入 MCP 服务器 fetch',
      });
      expect(clean.partial, isFalse);
      expect(clean.artifacts, <String>['fetch']);
    });

    test('uninstall result reads the removed artifact names', () {
      final result = MarketInstallResult.fromJson(<String, dynamic>{
        'ok': true,
        'removed': <dynamic>['office'],
        'partial': false,
        'message': '已卸载 office，对应页面会同步刷新。',
      });
      expect(result.ok, isTrue);
      expect(result.partial, isFalse);
      expect(result.artifacts, <String>['office']);
      expect(result.message, contains('已卸载'));
    });
  });

  group('source status text', () {
    MarketSourceStatus source(String kind, String status) =>
        MarketSourceStatus.fromJson(<String, dynamic>{
          'id': 'x',
          'kind': kind,
          'status': status,
        });

    test('live statuses map to the four honest states', () {
      expect(marketSourceStatusText(source('live', 'ok')), '实时');
      expect(marketSourceStatusText(source('live', 'stale')), '缓存');
      expect(marketSourceStatusText(source('live', 'error')), '失败');
      expect(marketSourceStatusText(source('live', 'pending')), '拉取中');
      expect(marketSourceStatusText(source('live', 'off')), '已关闭');
      expect(marketSourceStatusText(source('live', 'weird')), 'weird');
      expect(marketSourceStatusText(source('live', '')), '未知');
    });

    test('static status distinguishes a read failure from a loaded catalog', () {
      expect(marketSourceStatusText(source('static', 'ok')), '已载入');
      expect(marketSourceStatusText(source('static', 'error')), '读取失败');
    });
  });

  group('marketDescribeDioError', () {
    DioException withStatus(int status, {Object? data}) => DioException(
          requestOptions: RequestOptions(path: '/api/eco-markets'),
          type: DioExceptionType.badResponse,
          response: Response<dynamic>(
            requestOptions: RequestOptions(path: '/api/eco-markets'),
            statusCode: status,
            data: data,
          ),
        );

    test('401 names the login fix', () {
      final message = marketDescribeDioError(withStatus(401));
      expect(message, contains('认证失败 (401)'));
      expect(message, contains('登录'));
    });

    test('403 names the permission fix', () {
      expect(marketDescribeDioError(withStatus(403)), contains('权限不足 (403)'));
    });

    test('404 points at the wrong endpoint, not at the network', () {
      final message = marketDescribeDioError(withStatus(404));
      expect(message, contains('接口不存在 (404)'));
      expect(message, contains('升级'));
    });

    test('403 and 503 surface the backend reason when it has one', () {
      final message = marketDescribeDioError(withStatus(503, data: <String, dynamic>{
        'success': false,
        'error': <String, dynamic>{'message': '编目装配中'},
      }));
      expect(message, contains('503'));
      expect(message, contains('编目装配中'));
    });

    test('connection failures carry the base URL and a concrete fix', () {
      final error = DioException(
        requestOptions: RequestOptions(path: '/api/eco-markets'),
        type: DioExceptionType.connectionError,
        message: 'Connection refused',
      );
      final message = marketDescribeDioError(error, baseUrl: 'http://10.0.0.5:3000');
      expect(message, contains('网络连接失败'));
      expect(message, contains('http://10.0.0.5:3000'));
      expect(message, contains('同一局域网'));
    });

    test('timeouts are reported as timeouts, not as auth failures', () {
      final error = DioException(
        requestOptions: RequestOptions(path: '/api/eco-markets'),
        type: DioExceptionType.receiveTimeout,
      );
      final message = marketDescribeDioError(error, baseUrl: 'http://10.0.0.5:3000');
      expect(message, contains('请求超时'));
      expect(message, contains('http://10.0.0.5:3000'));
    });
  });

  group('marketDescribeDioError with an install/uninstall action', () {
    DioException withStatus(int status, {Object? data}) => DioException(
          requestOptions: RequestOptions(path: '/api/skills/install'),
          type: DioExceptionType.badResponse,
          response: Response<dynamic>(
            requestOptions: RequestOptions(path: '/api/skills/install'),
            statusCode: status,
            data: data,
          ),
        );

    test('a refused install keeps the backend reason and drops the refresh advice', () {
      final message = marketDescribeDioError(
        withStatus(400, data: <String, dynamic>{
          'success': false,
          'error': <String, dynamic>{'message': '该条目没有可执行的安装规格：请复制命令手动接入。'},
        }),
        action: '安装',
      );
      expect(message, contains('安装失败 (HTTP 400)'));
      expect(message, contains('该条目没有可执行的安装规格'));
      // 刷新修不好一次被拒的安装。
      expect(message, isNot(contains('点刷新')));
      expect(message, isNot(contains('读取生态市场')));
    });

    test('404 names the missing skills namespace, not the catalog endpoint', () {
      final message = marketDescribeDioError(withStatus(404), action: '卸载');
      expect(message, contains('接口不存在 (404)'));
      expect(message, contains('/api/skills/install'));
      expect(message, isNot(contains('/api/eco-markets')));
      expect(message, contains('挂载'));
    });

    test('403 says the account may not install, not that it may not read', () {
      expect(
        marketDescribeDioError(withStatus(403), action: '安装'),
        contains('无权安装'),
      );
    });

    test('the read path keeps its own wording when no action is given', () {
      final message = marketDescribeDioError(withStatus(404));
      expect(message, contains('/api/eco-markets'));
      expect(message, isNot(contains('/api/skills')));
    });
  });
}
