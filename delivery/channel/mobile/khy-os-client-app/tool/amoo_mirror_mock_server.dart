// Amoo 对话记录镜像的本地测试替身（mock server）。
//
// 为什么存在：本仓没有真实的 Amoo 镜像服务端，而「端侧只读镜像」的 wire 形状、
// cursor 语义与错误码需要在真机上端到端验证。这里用 dart:io 手写一个回环 HTTP
// 服务，行为严格对齐任务书「接口契约」节；它只服务 GET 与测试专用的 append，
// 不写 Amoo、不拉 Amoo 前台、不进 App 构建产物（tool/ 没有任何打包入口引用它）。
//
// 字段名以契约为准，本文件不自行发明键名。权威契约文档不在仓内，见交付 README
// AMOO-MIRROR.md 的 escalation 段。
//
// 端点字面量走 package:khy_os_client/core/config/endpoint_defaults.dart，与设置页
// 「填入内置 mock」chip 同一处；本文件不写第二份主机/端口。
//
// 控制面两套并存：任务书点名的 /__mock/mode|append|requests，与交付方案钉死的
// /__control/log|reset|append|auth|cursor409|retryafter。删任何一套都会让另一侧
// 的验证判据失去执行面——/__control/log 的形状被 7 项真机验证中的 4 项押注。
//
// 用法：
//   dart run tool/amoo_mirror_mock_server.dart \
//     [--port 8931] [--host 127.0.0.1] \
//     [--token mirror-device-token-0001] [--log <jsonl 路径>]

import 'dart:convert';
import 'dart:io';

import 'package:khy_os_client/core/config/endpoint_defaults.dart';

/// 测试替身 device_token。真实环境由配对流程签发，而该流程本仓没有定义（见
/// README escalation）；固定值让 401 验证可复现，不是任何真实凭据。
const String kAmooMirrorMockToken = 'mirror-device-token-0001';

/// 种子数据的时间基准（2025-01-01T00:00:00Z）。固定而不取启动时刻，是为了让同
/// 一份请求在任何一次运行里拿到逐字节相同的响应——验证判据要比对输出。
const int kAmooMirrorSeedBaseMs = 1735689600000;

/// 内存请求日志只留最近 200 条；JSONL 文件不限条数。
const int kAmooMirrorRequestLogLimit = 200;

const int kAmooMirrorSessionsDefaultLimit = 50;
const int kAmooMirrorSessionsMaxLimit = 500;
const int kAmooMirrorMessagesDefaultLimit = 200;
const int kAmooMirrorMessagesMaxLimit = 1000;

const String _kMockModePath = '/__mock/mode';
const String _kMockAppendPath = '/__mock/append';
const String _kMockRequestsPath = '/__mock/requests';
const String _kControlLogPath = '/__control/log';
const String _kControlResetPath = '/__control/reset';
const String _kControlAppendPath = '/__control/append';
const String _kControlAuthPath = '/__control/auth';
const String _kControlCursor409Path = '/__control/cursor409';
const String _kControlRetryAfterPath = '/__control/retryafter';

final RegExp _messagesPathRe = RegExp(r'^/sessions/([^/]+)/messages$');
final RegExp _streamPathRe = RegExp(r'^/sessions/([^/]+)/stream$');

final class _Cursor {
  const _Cursor(this.timestamp, this.id);

  final int timestamp;
  final String id;
}

final class _MockSession {
  _MockSession({
    required this.id,
    required this.title,
    required this.agentKey,
    required this.compacted,
    required this.messages,
  }) {
    recompute();
  }

  final String id;
  final String title;
  final String agentKey;
  final bool compacted;
  final List<Map<String, Object?>> messages;

  int updatedAt = 0;
  int messageCount = 0;
  String lastPreview = '';

  /// 追加消息后原子重算三个派生字段——服务端自己是这三个字段的真源，端侧只读。
  void recompute() {
    messageCount = messages.length;
    if (messages.isEmpty) {
      updatedAt = 0;
      lastPreview = '';
      return;
    }
    final last = messages.last;
    updatedAt = last['timestamp'] as int;
    lastPreview = _previewOf(last);
  }
}

final class _AmooMirrorMockServer {
  _AmooMirrorMockServer({
    required this.host,
    required this.port,
    required this.deviceToken,
    this.logPath,
  });

  final String host;
  final int port;
  final String deviceToken;
  final String? logPath;

  final Map<String, _MockSession> _sessions = <String, _MockSession>{};
  final List<Map<String, Object?>> _requests = <Map<String, Object?>>[];
  final Set<String> _messagesRequestPaths = <String>{};

  // 故障注入状态。409/429 是一次性（消费即清），401 是持续到显式关闭——持续才
  // 能让「客户端静默重试」在请求日志里现形（第二条 401）。
  bool _authEnforced = false;
  bool _pendingCursorStaleAnySession = false;
  final Set<String> _pendingCursorStaleSessions = <String>{};
  bool _pendingRateLimit = false;
  int _retryAfterSeconds = 2;

  int _appendCounter = 0;
  IOSink? _logSink;
  HttpServer? _server;

  Future<void> start() async {
    _seed();
    _openLogSink();
    _server = await HttpServer.bind(host, port);
    // 不 await 单个请求：慢客户端不应阻塞其它请求。监听套接字本身会让事件循环
    // 保持存活，main 不需要再挂什么。
    _server!.listen((HttpRequest request) async {
      await _handle(request);
    });
    _say(_banner());
  }

  Future<void> _handle(HttpRequest request) async {
    var status = 500;
    try {
      final path = request.uri.path;
      if (request.method == 'GET' && path == '/sessions') {
        status = await _serveSessions(request);
      } else if (request.method == 'GET' && _messagesPathRe.hasMatch(path)) {
        status = await _serveMessages(
          request,
          _messagesPathRe.firstMatch(path)!.group(1)!,
        );
      } else if (request.method == 'GET' && _streamPathRe.hasMatch(path)) {
        status = await _rejectStream(
          request,
          _streamPathRe.firstMatch(path)!.group(1)!,
        );
      } else if (path.startsWith('/__control/') ||
          path.startsWith('/__mock/')) {
        status = await _serveControl(request, path);
      } else {
        status = await _sendJson(request, 404, <String, Object?>{
          'error': 'not_found',
          'message': '路径不存在（404）：${request.method} $path',
        });
      }
    } catch (e) {
      status = await _sendJson(request, 500, <String, Object?>{
        'error': 'mock_internal_error',
        'message': 'mock 内部错误（500）：$e',
      });
      _say('内部错误：$e');
    }
    _record(request, status);
  }

  // ── 契约端点 ────────────────────────────────────────────────────────────

  Future<int> _serveSessions(HttpRequest request) async {
    if (!_authorized(request)) {
      return _sendJson(request, 401, _unauthorizedBody());
    }
    if (_consumeRateLimit()) {
      return _sendJson(
        request,
        429,
        _rateLimitedBody(),
        headers: <String, String>{'Retry-After': '$_retryAfterSeconds'},
      );
    }
    final query = request.uri.queryParameters;
    // since 语义：契约没定义开闭区间，这里取「updatedAt >= since」的含下界解释。
    // 端侧恒传 0，两种解释等价；取含下界是为了同一毫秒更新的会话不漏。
    final since = int.tryParse(query['since'] ?? '') ?? 0;
    var limit = int.tryParse(query['limit'] ?? '') ?? kAmooMirrorSessionsDefaultLimit;
    if (limit <= 0) limit = kAmooMirrorSessionsDefaultLimit;
    if (limit > kAmooMirrorSessionsMaxLimit) limit = kAmooMirrorSessionsMaxLimit;
    final rows = _sessions.values
        .where((_MockSession s) => s.updatedAt >= since)
        .toList()
      // 契约无排序承诺；这里按 updatedAt 降序（同值按 id 升序兜确定性，Dart 的
      // sort 不稳定，不写兜底判据两次运行的顺序可能不同）。
      ..sort((_MockSession a, _MockSession b) {
        final byTime = b.updatedAt.compareTo(a.updatedAt);
        return byTime != 0 ? byTime : a.id.compareTo(b.id);
      });
    return _sendJson(
      request,
      200,
      <Map<String, Object?>>[
        for (final s in rows.take(limit)) _sessionWire(s),
      ],
    );
  }

  Future<int> _serveMessages(HttpRequest request, String sessionId) async {
    if (!_authorized(request)) {
      return _sendJson(request, 401, _unauthorizedBody());
    }
    if (_consumeRateLimit()) {
      return _sendJson(
        request,
        429,
        _rateLimitedBody(),
        headers: <String, String>{'Retry-After': '$_retryAfterSeconds'},
      );
    }
    // 409 先于 404：一次性故障要稳定消费掉，不然它会粘到下一次无关请求上。
    if (_consumeCursorStale(sessionId)) {
      return _sendJson(request, 409, _cursorStaleBody());
    }
    final session = _sessions[sessionId];
    if (session == null) {
      return _sendJson(request, 404, _sessionGoneBody(sessionId));
    }
    final query = request.uri.queryParameters;
    var limit = int.tryParse(query['limit'] ?? '') ?? kAmooMirrorMessagesDefaultLimit;
    if (limit <= 0) limit = kAmooMirrorMessagesDefaultLimit;
    if (limit > kAmooMirrorMessagesMaxLimit) limit = kAmooMirrorMessagesMaxLimit;

    // 页序 = (timestamp, id) 升序。追加消息的 timestamp 恒晚于既有消息，这里仍
    // 显式排序：不依赖「没人写出乱序数据」这个假设。
    final ordered = List<Map<String, Object?>>.of(session.messages)
      ..sort(_compareMessages);
    final cursor = _parseCursor(query['cursor']);
    final start = cursor == null ? 0 : _firstIndexAfter(ordered, cursor);
    final page = ordered.skip(start).take(limit).toList();
    final hasMore = start + page.length < ordered.length;
    // 契约：hasMore=false 时仍返回最后一个消息的 <ts>:<id>；空页返回空串（端侧
    // 按追平处理，存 NULL）。
    final nextCursor = page.isEmpty
        ? ''
        : '${page.last['timestamp']}:${page.last['id']}';
    return _sendJson(request, 200, <String, Object?>{
      'items': page,
      'nextCursor': nextCursor,
      'hasMore': hasMore,
    });
  }

  Future<int> _rejectStream(HttpRequest request, String sessionId) async {
    if (!_authorized(request)) {
      return _sendJson(request, 401, _unauthorizedBody());
    }
    // 契约自标 SSE 可选、第二阶段；这里不实现，恒 404，让端侧拿到明确信号。
    return _sendJson(request, 404, <String, Object?>{
      'error': 'not_implemented',
      'message': 'SSE /sessions/$sessionId/stream 不在本替身范围内（契约标注可选、第二阶段）',
    });
  }

  // ── 控制端点 ───────────────────────────────────────────────────────────

  Future<int> _serveControl(HttpRequest request, String path) async {
    if (path == _kMockRequestsPath || path == _kControlLogPath) {
      if (request.method != 'GET') return _methodNotAllowed(request, 'GET');
      return _sendJson(request, 200, _logPayload());
    }
    if (request.method != 'POST') return _methodNotAllowed(request, 'POST');
    switch (path) {
      case _kMockModePath:
        return _setMode(request);
      case _kMockAppendPath:
        return _appendFromBody(request);
      case _kControlResetPath:
        return _reset(request);
      case _kControlAppendPath:
        return _appendFromQuery(request);
      case _kControlAuthPath:
        return _setAuth(request);
      case _kControlCursor409Path:
        return _armCursorStale(request);
      case _kControlRetryAfterPath:
        return _armRateLimit(request);
      default:
        return _sendJson(request, 404, <String, Object?>{
          'error': 'not_found',
          'message': '控制端点不存在（404）：${request.method} $path',
        });
    }
  }

  Future<int> _setMode(HttpRequest request) async {
    final body = await _decodeJsonBody(request);
    if (body == null) {
      return _sendJson(request, 400, <String, Object?>{
        'error': 'bad_request',
        'message': '请求体不是 JSON 对象（400）',
      });
    }
    final mode = body['mode'];
    if (mode is! String) {
      return _sendJson(request, 400, <String, Object?>{
        'error': 'bad_request',
        'message': 'body 需要 {"mode":"normal|401|409|429"[, "retryAfter":<秒>]}（400）',
      });
    }
    switch (mode) {
      case 'normal':
        _authEnforced = false;
        _pendingCursorStaleAnySession = false;
        _pendingCursorStaleSessions.clear();
        _pendingRateLimit = false;
        return _sendJson(request, 200, <String, Object?>{
          'ok': true,
          'mode': 'normal',
          'authEnforced': false,
        });
      case '401':
        _authEnforced = true;
        return _sendJson(request, 200, <String, Object?>{
          'ok': true,
          'mode': '401',
          'authEnforced': true,
          'expectedToken': deviceToken,
        });
      case '409':
        _pendingCursorStaleAnySession = true;
        return _sendJson(request, 200, <String, Object?>{
          'ok': true,
          'mode': '409',
          'oneShot': true,
        });
      case '429':
        _pendingRateLimit = true;
        final raw = body['retryAfter'];
        final parsed = raw is int ? raw : int.tryParse('$raw');
        _retryAfterSeconds = parsed != null && parsed > 0 ? parsed : 2;
        return _sendJson(request, 200, <String, Object?>{
          'ok': true,
          'mode': '429',
          'oneShot': true,
          'retryAfter': _retryAfterSeconds,
        });
      default:
        return _sendJson(request, 400, <String, Object?>{
          'error': 'bad_mode',
          'message': 'mode 只支持 normal|401|409|429，收到 "$mode"（400）',
        });
    }
  }

  Future<int> _appendFromBody(HttpRequest request) async {
    final body = await _decodeJsonBody(request);
    if (body == null) {
      return _sendJson(request, 400, <String, Object?>{
        'error': 'bad_request',
        'message': '请求体不是 JSON 对象（400）',
      });
    }
    final sessionId = body['session'];
    if (sessionId is! String || sessionId.isEmpty) {
      return _sendJson(request, 400, <String, Object?>{
        'error': 'bad_request',
        'message': 'body 需要 {"session":"<id>"[, "count":<1..100>]}（400）',
      });
    }
    final session = _sessions[sessionId];
    if (session == null) {
      return _sendJson(request, 404, _sessionGoneBody(sessionId));
    }
    final rawCount = body['count'];
    final count = rawCount is int ? rawCount : int.tryParse('$rawCount') ?? 2;
    if (count <= 0 || count > 100) {
      return _sendJson(request, 400, <String, Object?>{
        'error': 'bad_request',
        'message': 'count 需在 1..100，收到 $count（400）',
      });
    }
    return _appendAndRespond(request, session, count);
  }

  Future<int> _appendFromQuery(HttpRequest request) async {
    final sessionId = request.uri.queryParameters['session'];
    if (sessionId == null || sessionId.isEmpty) {
      return _sendJson(request, 400, <String, Object?>{
        'error': 'bad_request',
        'message': '需要 ?session=<会话 id>（400）',
      });
    }
    final session = _sessions[sessionId];
    if (session == null) {
      return _sendJson(request, 404, _sessionGoneBody(sessionId));
    }
    return _appendAndRespond(request, session, 2);
  }

  Future<int> _appendAndRespond(
    HttpRequest request,
    _MockSession session,
    int count,
  ) async {
    final appended = _appendMessages(session, count);
    return _sendJson(request, 200, <String, Object?>{
      'ok': true,
      'session': session.id,
      'appended': appended,
      'messageCount': session.messageCount,
      'updatedAt': session.updatedAt,
      'lastPreview': session.lastPreview,
    });
  }

  Future<int> _setAuth(HttpRequest request) async {
    final mode = request.uri.queryParameters['mode'];
    if (mode != 'on' && mode != 'off') {
      return _sendJson(request, 400, <String, Object?>{
        'error': 'bad_request',
        'message': '需要 ?mode=on 或 ?mode=off（400）',
      });
    }
    _authEnforced = mode == 'on';
    return _sendJson(request, 200, <String, Object?>{
      'ok': true,
      'authEnforced': _authEnforced,
      'expectedToken': deviceToken,
    });
  }

  Future<int> _armCursorStale(HttpRequest request) async {
    final sessionId = request.uri.queryParameters['session'];
    if (sessionId == null || sessionId.isEmpty) {
      return _sendJson(request, 400, <String, Object?>{
        'error': 'bad_request',
        'message': '需要 ?session=<会话 id>（400）',
      });
    }
    if (!_sessions.containsKey(sessionId)) {
      return _sendJson(request, 404, _sessionGoneBody(sessionId));
    }
    _pendingCursorStaleSessions.add(sessionId);
    return _sendJson(request, 200, <String, Object?>{
      'ok': true,
      'session': sessionId,
      'oneShot': true,
    });
  }

  Future<int> _armRateLimit(HttpRequest request) async {
    final raw = request.uri.queryParameters['value'];
    final seconds = raw == null ? null : int.tryParse(raw);
    if (seconds == null || seconds <= 0) {
      return _sendJson(request, 400, <String, Object?>{
        'error': 'bad_request',
        'message': '需要 ?value=<正整数秒>（400）',
      });
    }
    _pendingRateLimit = true;
    _retryAfterSeconds = seconds;
    return _sendJson(request, 200, <String, Object?>{
      'ok': true,
      'retryAfter': seconds,
      'oneShot': true,
    });
  }

  Future<int> _reset(HttpRequest request) async {
    _requests.clear();
    _messagesRequestPaths.clear();
    _pendingCursorStaleAnySession = false;
    _pendingCursorStaleSessions.clear();
    _pendingRateLimit = false;
    // authEnforced 刻意不在这里清：配对态要被显式关闭，避免一次 reset 把
    // 「服务端正在拒凭证」悄悄翻回正常。
    return _sendJson(request, 200, <String, Object?>{
      'ok': true,
      'cleared': <String>['requests', 'summary', 'oneShotFaults'],
      'authEnforced': _authEnforced,
    });
  }

  // ── 鉴权 / 故障注入 ─────────────────────────────────────────────────────

  /// normal 模式不校验 Bearer（测试便利：契约只约束客户端必须发，没约束服务端
  /// 必须拒；宽松不影响守约客户端）。401 模式（/__mock/mode=401 或
  /// /__control/auth?mode=on）起才严格校验，且要求令牌等于 --token 值——
  /// 所以要在持正确令牌的 App 上触发 401，先把 App 里的 device_token 改成错值，
  /// 再开 401 模式；改成正确值即恢复。
  bool _authorized(HttpRequest request) {
    if (!_authEnforced) return true;
    final header = request.headers.value('Authorization');
    if (header == null || !header.startsWith('Bearer ')) return false;
    return header.substring('Bearer '.length).trim() == deviceToken;
  }

  bool _consumeRateLimit() {
    if (!_pendingRateLimit) return false;
    _pendingRateLimit = false;
    return true;
  }

  bool _consumeCursorStale(String sessionId) {
    if (_pendingCursorStaleAnySession) {
      _pendingCursorStaleAnySession = false;
      return true;
    }
    return _pendingCursorStaleSessions.remove(sessionId);
  }

  // ── 种子数据 ───────────────────────────────────────────────────────────

  void _seed() {
    // 与 s-research-002 同名不同主：串台时标题分不出来，只能靠 agentKey 与内容
    // 暴露——这是「不串会话」判据的素材。
    _sessions['s-amoo-001'] = _MockSession(
      id: 's-amoo-001',
      title: '联调记录',
      agentKey: 'amoo',
      compacted: false,
      messages: <Map<String, Object?>>[
        _messageWire(
          id: 'm-001',
          parentId: null,
          timestamp: kAmooMirrorSeedBaseMs + 1000,
          role: 'user',
          blocks: <Map<String, Object?>>[
            _textBlock('帮我看下 Amoo 对话记录镜像的同步逻辑。'),
          ],
        ),
        _messageWire(
          id: 'm-002',
          parentId: 'm-001',
          timestamp: kAmooMirrorSeedBaseMs + 2000,
          role: 'assistant',
          blocks: <Map<String, Object?>>[
            _textBlock('分两路：列表走 /sessions，消息走 cursor 增量，INSERT OR IGNORE 保证幂等。'),
            _toolBlock('read_file', '读取 amoo_mirror_sync.dart（312 行）'),
          ],
        ),
        _messageWire(
          id: 'm-003',
          parentId: 'm-002',
          timestamp: kAmooMirrorSeedBaseMs + 3000,
          role: 'user',
          blocks: <Map<String, Object?>>[
            _textBlock('cursor 失效时怎么处理？'),
          ],
        ),
        _messageWire(
          id: 'm-004',
          parentId: 'm-003',
          timestamp: kAmooMirrorSeedBaseMs + 4000,
          role: 'assistant',
          blocks: <Map<String, Object?>>[
            _textBlock('409 时清空 cursor 整体重拉，本地行不删，历史不回退。'),
          ],
        ),
        _messageWire(
          id: 'm-005',
          parentId: 'm-004',
          timestamp: kAmooMirrorSeedBaseMs + 5000,
          role: 'assistant',
          blocks: <Map<String, Object?>>[
            _textBlock('（分支起点）同一条父消息下挂两个子回复。'),
          ],
        ),
        // m-006 / m-007 共享 parentId=m-005：分支消息按 timestamp 线性展示、
        // 保留 parentId 但不建树的素材。
        _messageWire(
          id: 'm-006',
          parentId: 'm-005',
          timestamp: kAmooMirrorSeedBaseMs + 6000,
          role: 'assistant',
          blocks: <Map<String, Object?>>[
            _textBlock('分支 A：先落库再渲染。'),
          ],
        ),
        _messageWire(
          id: 'm-007',
          parentId: 'm-005',
          timestamp: kAmooMirrorSeedBaseMs + 7000,
          role: 'assistant',
          blocks: <Map<String, Object?>>[
            _textBlock('分支 B：parentId 保留但不建树。'),
          ],
        ),
      ],
    );

    _sessions['s-research-002'] = _MockSession(
      id: 's-research-002',
      title: '联调记录',
      agentKey: 'researcher',
      compacted: true,
      messages: <Map<String, Object?>>[
        _messageWire(
          id: 'r-001',
          parentId: null,
          timestamp: kAmooMirrorSeedBaseMs + 1000,
          role: 'user',
          blocks: <Map<String, Object?>>[
            _textBlock('整理一下本周的镜像同步方案。'),
          ],
        ),
        // 1200 字符正文：端侧 800 截断边界的素材；里面的绝对路径与令牌样式串是
        // 渲染前脱敏的真机判据（形态对齐 amoo_approval.dart 的 _kSecretShapes）。
        _messageWire(
          id: 'r-002',
          parentId: 'r-001',
          timestamp: kAmooMirrorSeedBaseMs + 2000,
          role: 'assistant',
          blocks: <Map<String, Object?>>[
            _textBlock(_buildSanitizeFixture()),
          ],
        ),
        // 30KB tool summary + 服务端自标 truncated：与端侧 800 截断是两件事，
        // 详情页要分别标注。
        _messageWire(
          id: 'r-003',
          parentId: 'r-002',
          timestamp: kAmooMirrorSeedBaseMs + 3000,
          role: 'assistant',
          blocks: <Map<String, Object?>>[
            _toolBlock('run_tests', _buildLongToolSummary(), truncated: true),
          ],
        ),
      ],
    );

    _sessions['s-code-003'] = _MockSession(
      id: 's-code-003',
      title: '长会话压测',
      agentKey: 'amoo',
      compacted: false,
      messages: _buildLongSessionMessages(),
    );
  }

  List<Map<String, Object?>> _buildLongSessionMessages() {
    final out = <Map<String, Object?>>[];
    for (var i = 1; i <= 320; i++) {
      final isUser = i.isOdd;
      out.add(_messageWire(
        id: 'c-${i.toString().padLeft(4, '0')}',
        parentId: i == 1
            ? null
            : 'c-${(i - 1).toString().padLeft(4, '0')}',
        timestamp: kAmooMirrorSeedBaseMs + 1000 * i,
        role: isUser ? 'user' : 'assistant',
        blocks: <Map<String, Object?>>[
          _textBlock(isUser
              ? '长会话压测：第 $i 条用户消息。'
              : '长会话压测：第 $i 条助手回复。'),
        ],
      ));
    }
    return out;
  }

  /// 追加消息：id 全局递增、timestamp 接在该会话最后一条之后（恒晚于既有消息，
  /// cursor 排他性因此成立），角色与上一条交替。
  int _appendMessages(_MockSession session, int count) {
    var ts = session.updatedAt;
    var role = session.messages.isEmpty
        ? 'user'
        : session.messages.last['role'] as String;
    for (var i = 0; i < count; i++) {
      final previous =
          session.messages.isEmpty ? null : session.messages.last['id'] as String;
      _appendCounter++;
      ts += 1000;
      role = role == 'user' ? 'assistant' : 'user';
      session.messages.add(_messageWire(
        id: 'app-${_appendCounter.toString().padLeft(4, '0')}',
        parentId: previous,
        timestamp: ts,
        role: role,
        blocks: <Map<String, Object?>>[
          // 带会话 id：串台时渲染出来的内容会自证身份。
          _textBlock(role == 'user'
              ? '追加消息（${session.id}）：第 $_appendCounter 条用户输入。'
              : '追加消息（${session.id}）：第 $_appendCounter 条助手回复。'),
        ],
      ));
    }
    session.recompute();
    return count;
  }

  // ── 请求日志 ───────────────────────────────────────────────────────────

  Map<String, Object?> _logPayload() => <String, Object?>{
        'requests': _requests,
        'summary': <String, Object?>{
          // 只收 /sessions/{id}/messages 的 path（去重、保初见序）：列表同步的
          // /sessions 混进来的话，「不串会话」判据必红。
          'messagesRequestPaths': _messagesRequestPaths.toList(),
        },
      };

  void _record(HttpRequest request, int status) {
    final path = request.uri.path;
    final record = <String, Object?>{
      't': DateTime.now().millisecondsSinceEpoch,
      'method': request.method,
      'path': path,
      'query': request.uri.query,
      'status': status,
    };
    _requests.add(record);
    if (_requests.length > kAmooMirrorRequestLogLimit) {
      _requests.removeAt(0);
    }
    if (_messagesPathRe.hasMatch(path)) {
      _messagesRequestPaths.add(path);
    }
    // 逐条 flush：测试替身的请求量微不足道，而「进程被杀后日志少最后一条」会在
    // 验证时被当成没发过请求。
    _logSink?.writeln(jsonEncode(record));
    _logSink?.flush();
    final querySuffix = record['query'] == '' ? '' : '?${record['query']}';
    stdout.writeln('${request.method} $path$querySuffix → $status');
  }

  void _openLogSink() {
    final path = logPath;
    if (path == null || path.isEmpty) return;
    try {
      _logSink = File(path).openWrite(mode: FileMode.append);
    } catch (e) {
      // 日志文件打不开不该让替身起不来：内存日志与 stdout 仍在，验证可继续。
      stderr.writeln('警告：JSONL 日志文件 $path 打不开（$e），本次只写内存日志。');
    }
  }

  // ── 工具 ───────────────────────────────────────────────────────────────

  int _compareMessages(Map<String, Object?> a, Map<String, Object?> b) {
    final byTime = (a['timestamp'] as int).compareTo(b['timestamp'] as int);
    return byTime != 0 ? byTime : (a['id'] as String).compareTo(b['id'] as String);
  }

  int _firstIndexAfter(List<Map<String, Object?>> messages, _Cursor cursor) {
    for (var i = 0; i < messages.length; i++) {
      final m = messages[i];
      final ts = m['timestamp'] as int;
      final id = m['id'] as String;
      // cursor 排他：严格晚于该点才返回。
      if (ts > cursor.timestamp || (ts == cursor.timestamp && id.compareTo(cursor.id) > 0)) {
        return i;
      }
    }
    return messages.length;
  }

  /// 畸形 cursor 按「没有 cursor」处理（全量拉取）而不是发明第 5 种错误码——
  /// 客户端发来的 cursor 都是自己 parse 过的，畸形只可能是别处的 bug。
  _Cursor? _parseCursor(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    final sep = raw.indexOf(':');
    if (sep <= 0) return null;
    final ts = int.tryParse(raw.substring(0, sep));
    if (ts == null) return null;
    final id = raw.substring(sep + 1);
    if (id.isEmpty) return null;
    return _Cursor(ts, id);
  }

  Future<Map<String, dynamic>?> _decodeJsonBody(HttpRequest request) async {
    final text = await utf8.decoder.bind(request).join();
    if (text.trim().isEmpty) return <String, dynamic>{};
    final decoded = jsonDecode(text);
    if (decoded is Map<String, dynamic>) return decoded;
    if (decoded is Map) return Map<String, dynamic>.from(decoded);
    return null;
  }

  Future<int> _sendJson(
    HttpRequest request,
    int status,
    Object? body, {
    Map<String, String>? headers,
  }) async {
    final bytes = utf8.encode(jsonEncode(body));
    request.response.statusCode = status;
    request.response.headers.contentType = ContentType.json;
    request.response.headers.contentLength = bytes.length;
    headers?.forEach(request.response.headers.set);
    request.response.add(bytes);
    await request.response.close();
    return status;
  }

  Future<int> _methodNotAllowed(HttpRequest request, String expected) async {
    return _sendJson(request, 405, <String, Object?>{
      'error': 'method_not_allowed',
      'message': '该端点只接受 $expected，收到 ${request.method}（405）',
    });
  }

  Map<String, Object?> _sessionWire(_MockSession s) => <String, Object?>{
        'id': s.id,
        'title': s.title,
        'updatedAt': s.updatedAt,
        'lastPreview': s.lastPreview,
        'messageCount': s.messageCount,
        'agentKey': s.agentKey,
        'compacted': s.compacted,
      };

  Map<String, Object?> _textBlock(String text) =>
      <String, Object?>{'type': 'text', 'text': text};

  Map<String, Object?> _toolBlock(
    String name,
    String summary, {
    bool truncated = false,
  }) =>
      <String, Object?>{
        'type': 'tool',
        'name': name,
        'summary': summary,
        'truncated': truncated,
      };

  Map<String, Object?> _messageWire({
    required String id,
    required String? parentId,
    required int timestamp,
    required String role,
    required List<Map<String, Object?>> blocks,
  }) =>
      <String, Object?>{
        'id': id,
        'parentId': parentId,
        'timestamp': timestamp,
        'role': role,
        'blocks': blocks,
      };

  Map<String, Object?> _unauthorizedBody() => <String, Object?>{
        'error': 'unauthorized',
        'message': '未授权（401）：Authorization: Bearer <device_token> 缺失或与测试替身令牌不符',
      };

  Map<String, Object?> _sessionGoneBody(String sessionId) =>
      <String, Object?>{
        'error': 'session_not_found',
        'message': '会话不存在（404）：$sessionId',
      };

  Map<String, Object?> _cursorStaleBody() => <String, Object?>{
        'error': 'cursor_stale',
        'message': 'cursor 失效（409）：请整体重拉',
      };

  Map<String, Object?> _rateLimitedBody() => <String, Object?>{
        'error': 'rate_limited',
        'message': '限频（429）：请按 Retry-After 退避',
      };

  String _banner() {
    final buffer = StringBuffer()
      ..writeln('Amoo 对话记录镜像 mock 服务端已启动（测试替身，不进 App 构建产物）')
      ..writeln('  监听        $kAmooMirrorMockBaseUrl')
      ..writeln('  device_token $deviceToken（测试替身，非真实凭据）')
      ..writeln('  端点        GET /sessions | GET /sessions/{id}/messages | GET /sessions/{id}/stream(恒404)')
      ..writeln('  控制        POST /__mock/mode | POST /__mock/append | GET /__mock/requests')
      ..writeln('              POST /__control/reset | POST /__control/append | POST /__control/auth')
      ..writeln('              POST /__control/cursor409 | POST /__control/retryafter | GET /__control/log')
      ..writeln('  真机        先 adb reverse tcp:8931 tcp:8931，再在设置页把 Base URL 填成 $kAmooMirrorMockBaseUrl')
      ..writeln('  Ctrl+C 停止');
    return buffer.toString();
  }
}

// ── 种子素材构造 ──────────────────────────────────────────────────────────

String _clip(String text, int max) =>
    text.length <= max ? text : '${text.substring(0, max)}…';

/// 列表页 lastPreview 的取法：优先最后一个 text 块（压平成一行），否则退到
/// tool 块的「名字 + 摘要」。会话空消息时返回空串。
String _previewOf(Map<String, Object?> message) {
  final blocks = message['blocks'] as List<Object?>;
  for (final block in blocks) {
    if (block is! Map) continue;
    if (block['type'] != 'text') continue;
    final text = block['text'];
    if (text is! String) continue;
    return _clip(text.replaceAll('\n', ' ').trim(), 60);
  }
  for (final block in blocks) {
    if (block is! Map) continue;
    if (block['type'] != 'tool') continue;
    final name = block['name'];
    final summary = block['summary'];
    if (name is! String || summary is! String) continue;
    return _clip('[工具] $name · $summary', 60);
  }
  return '';
}

/// 脱敏判据素材：绝对路径（Windows/Unix 两种）+ 令牌样式串（Bearer / sk- 两种，
/// 形态对齐 lib/core/services/amoo_approval.dart:155-156 的 _kSecretShapes），
/// 总长 1200 字符以越过端侧 800 截断线。
String _buildSanitizeFixture() {
  final b = StringBuffer()
    ..writeln('同步方案对谈：第 1 步读游标推进逻辑，第 2 步对齐字段名。')
    ..writeln('Windows 上的库文件在 C:\\Users\\dev\\khy-os\\lib\\core\\db\\amoo_mirror_store.dart。')
    ..writeln('同一台开发机若走 WSL，路径是 /home/dev/khy-os/lib/core/db/amoo_mirror_store.dart。')
    ..writeln('请求头带 Authorization: Bearer mirror-device-token-0001，另一处还躺着 sk-abc123def456ghi789jkl012mno345pqr。')
    ..writeln('以上路径与令牌在渲染前都应被替换为占位符——这是脱敏规则的真机判据。');
  const filler = '（填充行文：本行不含敏感信息，仅用于把正文推到 800 字符截断边界之上，方便验证截断与展开。）';
  while (b.length < 1200) {
    b.writeln(filler);
  }
  final text = b.toString();
  return text.length <= 1200 ? text : text.substring(0, 1200);
}

/// 30KB tool summary（30*1024 字符）。服务端自标 truncated=true，与端侧 800
/// 截断是两件事，详情页要分别标注。
String _buildLongToolSummary() {
  final b = StringBuffer();
  var round = 0;
  while (b.length < 30 * 1024) {
    round++;
    b.write('第 $round 轮回归：run_tests 命中 3 处游标推进，编译期零告警；');
  }
  final text = b.toString();
  return text.length <= 30 * 1024 ? text : text.substring(0, 30 * 1024);
}

// ── 入口 ────────────────────────────────────────────────────────────────

const String _usage = '''
Amoo 对话记录镜像 mock 服务端（测试替身，不进 App 构建产物）

用法：
  dart run tool/amoo_mirror_mock_server.dart [选项]

选项：
  --port <端口>     监听端口，默认 8931
  --host <地址>     监听地址，默认 127.0.0.1（adb reverse 只需回环）
  --token <令牌>    测试替身 device_token，默认 mirror-device-token-0001
  --log <路径>      请求日志 JSONL（每行一条 {t,method,path,query,status}）
  --help            打印本帮助

契约端点：
  GET  /sessions?since=<epoch_ms>&limit=<n>                 裸 JSON 数组
  GET  /sessions/{id}/messages?cursor=<ts>:<id>&limit=<n>   {items,nextCursor,hasMore}
  GET  /sessions/{id}/stream                                恒 404（SSE 契约标注可选、第二阶段）

控制端点（两套并存，语义等价）：
  POST /__mock/mode        body {"mode":"normal|401|409|429"[,"retryAfter":<秒>]}
  POST /__mock/append      body {"session":"<id>"[,"count":<1..100>]}
  GET  /__mock/requests    请求日志
  GET  /__control/log      请求日志（同上）
  POST /__control/reset    清空请求日志与一次性故障
  POST /__control/append?session=<id>              追加 2 条消息
  POST /__control/auth?mode=on|off                 401 严格校验开关
  POST /__control/cursor409?session=<id>            该会话下一条 messages 返 409（一次性）
  POST /__control/retryafter?value=<秒>            下一条 /sessions* 返 429（一次性）

模式说明：
  normal（默认）不校验 Bearer；401 模式起才严格校验，要求令牌等于 --token 值。
  要在持正确令牌的 App 上触发 401：先把 App 里的 device_token 改成错值，再开
  401 模式；改回正确值即恢复（401 持续有效，静默重试会在日志里留下第二条 401）。
  409/429 均一次性，消费即清。
''';

String? _argValue(List<String> args, String name) {
  final i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return null;
  return args[i + 1];
}

void _say(Object? line) => stdout.writeln(line);

Future<void> main(List<String> args) async {
  if (args.contains('--help') || args.contains('-h')) {
    _say(_usage);
    return;
  }
  final host = _argValue(args, '--host') ?? kAmooMirrorMockHost;
  final portText = _argValue(args, '--port');
  final port = portText == null
      ? int.parse(kAmooMirrorMockPort)
      : int.tryParse(portText);
  if (port == null || port <= 0 || port > 65535) {
    stderr.writeln('--port 需要 1..65535 的整数，收到 "$portText"（400）。');
    exitCode = 1;
    return;
  }
  final token = _argValue(args, '--token') ?? kAmooMirrorMockToken;
  final logPath = _argValue(args, '--log');

  final server = _AmooMirrorMockServer(
    host: host,
    port: port,
    deviceToken: token,
    logPath: logPath,
  );
  try {
    await server.start();
  } on SocketException catch (e) {
    stderr.writeln(
      '绑定 $host:$port 失败：$e。换一个 --port，或先结束占用该端口的进程'
      '（netstat -ano | findstr $port）。',
    );
    exitCode = 1;
    return;
  }
}
