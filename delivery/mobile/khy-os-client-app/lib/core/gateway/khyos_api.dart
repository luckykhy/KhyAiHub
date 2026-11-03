// khy-canary: Khy-20261101-074-5VWTWB50
import 'dart:async';
import 'dart:convert';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../data/models/models.dart';

/// 远程流式对话期间后端明确报的错（SSE `type=error`）。
///
/// 与网络异常分开：后者是"没连上"，前者是"连上了、但这次失败了，原话在
/// [message] 里"。界面对两者的下一步不同，吞成同一种就分不出来了。
class KhyOsStreamException implements Exception {
  final String message;

  const KhyOsStreamException(this.message);

  @override
  String toString() => 'KhyOsStreamException: $message';
}

/// 后端 `/api/ai/chat/stream` 的 SSE 事件类型全集。
///
/// 真源在 `runtime/node/backend/src/routes/ai.js` 的 sendEvent 调用处。这里抄
/// 一份，是为了让 Dart 侧不再拿字符串字面量散着比对——`'thinking_content'`
/// 拼错一个字母的后果是思维链静默丢失，而那种丢失在界面上与"模型没思考"
/// 一模一样，没有一方会报错。
class KhyOsStreamEvent {
  static const String start = 'start';
  static const String status = 'status';
  static const String heartbeat = 'heartbeat';
  static const String controlRequest = 'control_request';
  static const String chunk = 'chunk';

  /// 思维链增量。后端在 routes/ai.js 的 onChunk 里把网关的 `{type:'thinking'}`
  /// 转成这个类型下发，正文在 `text` 字段。
  static const String thinking = 'thinking_content';
  static const String done = 'done';
  static const String error = 'error';

  /// 这个事件是不是思维链 delta。
  static bool isReasoning(Map<String, dynamic> event) =>
      event['type'] == thinking;

  /// 取思维链正文；不是思维链事件返回 null。
  ///
  /// 认 `text`（后端与 Web 前端都用这个键），另外两个键名是防御：同一条链路上
  /// 的其它转发层 historically 换过叫法，认不出来时返回 null 而不是空串——
  /// 空串会被上层理解成"有思维链但内容为空"，于是渲染出一个空块。
  static String? reasoningOf(Map<String, dynamic> event) {
    if (!isReasoning(event)) return null;
    for (final key in const ['text', 'reasoning', 'content']) {
      final value = event[key];
      if (value is String && value.isNotEmpty) return value;
    }
    return null;
  }

  /// 一个事件对「正文」和「思维链」各自的增量贡献。
  ///
  /// 两者永远分开：它们在 UI 上是两个区块，混过一次就再也分不开，而且混进
  /// 正文的思维链会随对话历史上传，等于把"怎么想的"固化成"说过什么"。
  static KhyOsEventDelta deltaOf(Map<String, dynamic> event) {
    switch (event['type']) {
      case chunk:
        return KhyOsEventDelta(content: _text(event['content']));
      case thinking:
        // 走 reasoningOf 而不是直接读 'text'：两个函数认的键名必须同一套，
        // 否则「reasoningOf 认得出来、折叠时读不到」的事件会被静默丢掉——
        // 而那正是这段代码要防的那种无声失败。
        return KhyOsEventDelta(reasoning: reasoningOf(event) ?? '');
      default:
        // start / status / heartbeat / control_request / done / error：
        // 都不携带正文或思维链增量。
        return const KhyOsEventDelta();
    }
  }

  static String _text(Object? value) => value == null ? '' : value.toString();
}

/// 一个 SSE 事件的增量贡献。两个字段默认空串，相加即"无贡献"。
class KhyOsEventDelta {
  final String content;
  final String reasoning;

  const KhyOsEventDelta({this.content = '', this.reasoning = ''});
}

/// khy-os 后端连接配置
class KhyOsConnection {
  final String apiBaseUrl;
  final String? accessToken;
  final String? refreshToken;
  final Map<String, dynamic>? user;

  const KhyOsConnection({
    required this.apiBaseUrl,
    this.accessToken,
    this.refreshToken,
    this.user,
  });

  bool get isConnected => apiBaseUrl.isNotEmpty;
  bool get isAuthenticated => accessToken?.isNotEmpty == true;

  Map<String, dynamic> toJson() => {
        'apiBaseUrl': apiBaseUrl,
        'accessToken': accessToken,
        'refreshToken': refreshToken,
        'user': user,
      };

  factory KhyOsConnection.fromJson(Map<String, dynamic> json) => KhyOsConnection(
        apiBaseUrl: json['apiBaseUrl'] ?? '',
        accessToken: json['accessToken'],
        refreshToken: json['refreshToken'],
        user: json['user'],
      );

  KhyOsConnection copyWith({
    String? apiBaseUrl,
    String? accessToken,
    String? refreshToken,
    Map<String, dynamic>? user,
  }) =>
      KhyOsConnection(
        apiBaseUrl: apiBaseUrl ?? this.apiBaseUrl,
        accessToken: accessToken ?? this.accessToken,
        refreshToken: refreshToken ?? this.refreshToken,
        user: user ?? this.user,
      );
}

/// khy-os 后端 API 服务
class KhyOsApi {
  static const _storage = FlutterSecureStorage();
  static const _keyConnection = 'khyos_connection';

  KhyOsConnection? _connection;
  final _connectionController = StreamController<KhyOsConnection?>.broadcast();

  Stream<KhyOsConnection?> get connectionStream => _connectionController.stream;
  KhyOsConnection? get connection => _connection;
  bool get isConnected => _connection?.isConnected == true;
  bool get isAuthenticated => _connection?.isAuthenticated == true;

  /// 加载保存的连接配置
  Future<KhyOsConnection?> loadConnection() async {
    final raw = await _storage.read(key: _keyConnection);
    if (raw == null) return null;
    try {
      _connection = KhyOsConnection.fromJson(jsonDecode(raw));
      _connectionController.add(_connection);
      return _connection;
    } catch (_) {
      return null;
    }
  }

  /// 保存连接配置
  Future<void> saveConnection(KhyOsConnection conn) async {
    _connection = conn;
    await _storage.write(key: _keyConnection, value: jsonEncode(conn.toJson()));
    _connectionController.add(_connection);
  }

  /// 清除连接配置
  Future<void> clearConnection() async {
    _connection = null;
    await _storage.delete(key: _keyConnection);
    _connectionController.add(null);
  }

  /// 验证并保存后端地址
  Future<void> verifyAndSave(String apiBaseUrl) async {
    final dio = Dio(BaseOptions(
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 15),
    ));

    // 验证后端是否可达
    final response = await dio.get('$apiBaseUrl/api/health');
    if (response.statusCode != 200) {
      throw Exception('后端不可达 (HTTP ${response.statusCode})');
    }

    await saveConnection(KhyOsConnection(apiBaseUrl: apiBaseUrl));
  }

  /// 登录
  Future<Map<String, dynamic>> login(String username, String password) async {
    if (_connection == null) throw Exception('请先配置后端地址');

    final dio = Dio(BaseOptions(
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 15),
    ));

    final response = await dio.post(
      '${_connection!.apiBaseUrl}/api/auth/login',
      data: {'username', 'password'},
      options: Options(contentType: 'application/json'),
    );

    final data = response.data;
    final conn = _connection!.copyWith(
      accessToken: data['accessToken'] ?? data['access_token'],
      refreshToken: data['refreshToken'] ?? data['refresh_token'],
      user: data['user'],
    );
    await saveConnection(conn);

    return data;
  }

  /// 刷新 Token
  Future<void> refreshSession() async {
    if (_connection?.refreshToken == null) throw Exception('无刷新令牌');

    final dio = Dio();
    final response = await dio.post(
      '${_connection!.apiBaseUrl}/api/auth/refresh',
      data: {'refreshToken': _connection!.refreshToken},
      options: Options(contentType: 'application/json'),
    );

    final conn = _connection!.copyWith(
      accessToken: response.data['accessToken'] ?? response.data['access_token'],
      refreshToken: response.data['refreshToken'] ?? response.data['refresh_token'] ?? _connection!.refreshToken,
    );
    await saveConnection(conn);
  }

  /// 登出
  Future<void> logout() async {
    if (_connection?.accessToken != null) {
      try {
        final dio = Dio();
        await dio.post(
          '${_connection!.apiBaseUrl}/api/auth/logout',
          options: Options(
            headers: {'Authorization': 'Bearer ${_connection!.accessToken}'},
          ),
        );
      } catch (_) {}
    }
    await clearConnection();
  }

  /// 获取可用模型列表
  Future<List<Map<String, dynamic>>> fetchModels() async {
    if (_connection == null) return [];

    final dio = Dio(BaseOptions(
      connectTimeout: const Duration(seconds: 15),
      headers: {'Authorization': 'Bearer ${_connection!.accessToken}'},
    ));

    final response = await dio.get('${_connection!.apiBaseUrl}/api/ai/models');
    if (response.data is List) {
      return List<Map<String, dynamic>>.from(response.data);
    }
    return [];
  }

  /// SSE 流式聊天。
  ///
  /// 原样吐出后端事件，`type` 全集见 [KhyOsStreamEvent]。其中
  /// [KhyOsStreamEvent.thinking] 是思维链增量，调用方要自己按独立字段累加——
  /// 想要已经累加好的消息，用 [streamChatMessage]。
  Stream<Map<String, dynamic>> streamChat({
    required String question,
    required List<Map<String, String>> history,
  }) async* {
    if (_connection == null) throw Exception('未连接到 khy-os 后端');

    final dio = Dio(BaseOptions(
      connectTimeout: const Duration(seconds: 30),
      receiveTimeout: const Duration(minutes: 5),
      headers: {
        'Authorization': 'Bearer ${_connection!.accessToken}',
        'Content-Type': 'application/json',
      },
      responseType: ResponseType.stream,
    ));

    final response = await dio.post(
      '${_connection!.apiBaseUrl}/api/ai/chat/stream',
      data: {
        'question': question,
        'conversationHistory': history,
      },
    );

    if (response.statusCode != 200) {
      throw Exception('流式连接失败 (HTTP ${response.statusCode})');
    }

    await for (final chunk in response.data.stream) {
      final text = utf8.decode(chunk);
      final lines = text.split('\n');
      for (final line in lines) {
        if (line.startsWith('data:')) {
          final raw = line.substring(5).trim();
          if (raw.isEmpty || raw == '[DONE]') continue;
          try {
            final event = jsonDecode(raw);
            if (event is Map) {
              // 思维链事件额外挂一个 reasoning 键（后端发的是 text）：上层按
              // reasoning 读更直白，也不必每个调用方都记得这个别名。其余事件
              // 一个字节都不动。
              final reasoning = KhyOsStreamEvent.reasoningOf(
                  Map<String, dynamic>.from(event));
              if (reasoning != null) event['reasoning'] = reasoning;
            }
            yield event as Map<String, dynamic>;
          } catch (_) {
            yield {'type': 'chunk', 'content': raw};
          }
        }
      }
    }
  }

  /// 把 SSE 事件流折叠成一条**正在生长**的 assistant 消息。
  ///
  /// 与 `AIGateway.streamChatMessage` 同一语义：每次 emit 都是到目前为止的
  /// 完整快照，content 与 reasoning 各自累计。差别只有一处——`done` 事件带的
  /// 是**完整正文**而不是增量，所以这里按覆盖处理（后端在 dedup 命中时只发一个
  /// chunk，而那一个也是全文；按增量累加同样正确）。
  ///
  /// 静态、且不吃 [KhyOsConnection]，是为了能脱离设备单测：事件流的形状才是
  /// 容易错的那一半，而连接/鉴权错了会立刻抛，藏不住。
  static Stream<ChatMessage> foldEventStream(
    Stream<Map<String, dynamic>> events,
    ChatMessage seed,
  ) async* {
    var content = '';
    var reasoning = '';
    await for (final event in events) {
      switch (event['type']) {
        case KhyOsStreamEvent.done:
          // 覆盖而非追加：done.content 是整条回复。追加一遍会把全文写两遍。
          final full = event['content'];
          if (full != null) content = full.toString();
          break;
        case KhyOsStreamEvent.error:
          // 不吞。后端明确说这次失败了还继续 yield 的话，界面会停在一个
          // "已完成"的假象上：转圈停了，内容停在半句。
          throw KhyOsStreamException(
              (event['message'] ?? '远程请求失败').toString());
        default:
          final delta = KhyOsStreamEvent.deltaOf(event);
          content += delta.content;
          reasoning += delta.reasoning;
      }
      yield seed.copyWith(
        content: content,
        // 空串折算成 null：UI 判的是「有没有思维链」，空串会让它渲染一个空块。
        reasoning: reasoning.isEmpty ? null : reasoning,
      );
    }
  }

  /// 远程流式对话 → 一条正在生长的 assistant 消息。
  ///
  /// 思维链在这里第一次变成 [ChatMessage.reasoning]：后端从 routes/ai.js 的
  /// onChunk 起就一直在发 `thinking_content`，此前 Dart 侧只消费
  /// chunk/done/error 三种，它落在无形。
  Stream<ChatMessage> streamChatMessage({
    required String question,
    required List<Map<String, String>> history,
    required ChatMessage seed,
  }) =>
      foldEventStream(streamChat(question: question, history: history), seed);

  /// 通用 API 请求
  Future<Response> apiFetch(String path, {
    String method = 'GET',
    Map<String, dynamic>? data,
    bool auth = true,
  }) async {
    if (_connection == null) throw Exception('未连接到 khy-os 后端');

    final headers = <String, String>{};
    if (auth && _connection!.accessToken != null) {
      headers['Authorization'] = 'Bearer ${_connection!.accessToken}';
    }

    final dio = Dio(BaseOptions(
      baseUrl: '${_connection!.apiBaseUrl}/',
      headers: headers,
    ));

    return dio.request(
      path,
      data: data,
      options: Options(method: method, contentType: 'application/json'),
    );
  }

  /// 上报工具执行日志到 khy-os 后端
  Future<void> reportExecution(Map<String, dynamic> log) async {
    if (!isConnected) return;
    try {
      await apiFetch('/api/mobile/execution-log',
          method: 'POST', data: log);
    } catch (_) {
      // 上报失败不影响本地执行
    }
  }

  void dispose() {
    _connectionController.close();
  }
}
