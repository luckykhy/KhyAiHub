import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';

import '../config/endpoint_defaults.dart';
import 'zen_errors.dart';

/// OpenCode Zen 免费档的客户端门控——电脑版 `services/zenGatekeeper.js` 的手机镜像。
///
/// 为什么手机侧要另写一份：手机不跑 Node 后端，请求直接从 Dart 发出，
/// 电脑侧那套 gate 在这里一行都不会执行。缺了它，上游只看到"裸 HTTP 客户端"，
/// 回 403 FreeTierError（can only be used from within OpenCode）——而这与
/// key 填错、网络不通看起来一模一样。
///
/// 上游的三道门（2026-10-24 实测 + 2026-11-17 复测，见 docs/opencode-provider-keys.md §9）：
///   · UA 必须是 `opencode/<channel>/<version>/<client>` 形态；
///   · 请求体必须 stream:true 且 tools[] 里同时有 bash 和 read；
///   · **免费额度按客户端凭据发放，不按 IP / 设备 / 模型**。2026-11-17 实测：
///     换 session/project、换模型、换 IPv4/IPv6、换设备、换网段仍是 429；而真正的
///     opencode 客户端在同一台机器、同一网络、未登录时能正常回答。未登录的请求
///     （`Bearer public` 或不带 Authorization）落进一个共享匿名池，池子空了就 429。
///     填入账号 Key（官网登录后只勾免费模型生成）才走账号额度。
///
/// 因此身份仍然是「这台设备一份、跨重启稳定」：进程级随机 id 每重启换一次，正是
/// 上游反滥用模型里最像批量刷量的形态。身份由原生层交来的设备种子**纯函数派生**
/// （[ZenGate.derive]），与电脑版 `zenIdentity.js` 同构；落盘只作为取不到种子时的
/// 回退与诊断，不参与身份计算。注意：身份不解决额度问题，它只保证"同一台设备不被
/// 当成一批设备"。

/// 与电脑版 `constants/serviceDefaults.js` 的 `OPENCODE_USER_AGENT` 同一个值。
/// 上游认的是形态而不是版本号，但两边必须同源，否则电脑能过、手机过不了。
const String kZenUserAgent = 'opencode/latest/1.18.27/cli';

/// 免费档的 bearer。电脑版所有免费通道都发 `Bearer public`。
const String kZenPublicBearer = 'public';

const String _base62 =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const String _identityStorageKey = 'zen_identity_v1';

/// opencode Identifier.create 形态：`ses_` + 12 位 hex + 14 位 base62。
/// 上游免费层会拒收不是 12 位 hex 开头的 session id。
String newZenSessionId(int createdAtMs) =>
    'ses_${_timeHex(createdAtMs, descending: true)}${_randomBase62(14)}';

/// message/request id 形态，与电脑版 `newRequestId()` 对齐。
String newZenRequestId() =>
    'msg_${_timeHex(DateTime.now().millisecondsSinceEpoch, descending: false)}'
    '${_randomBase62(14)}';

String _timeHex(int createdAtMs, {required bool descending}) {
  var now = BigInt.from(createdAtMs) * BigInt.from(0x1000) + BigInt.one;
  if (descending) now = ~now;
  final out = StringBuffer();
  for (var i = 0; i < 6; i++) {
    // 移位量是 int，不能包 BigInt.from：BigInt 的 >> 操作符收 int。
    // （原写法 `now >> BigInt.from(...)` 编不过，整个 release 构建会卡在这一行。）
    final byte = (now >> (40 - 8 * i)) & BigInt.from(0xff);
    out.write(byte.toRadixString(16).padLeft(2, '0'));
  }
  return out.toString();
}

String _randomBase62(int len) {
  final rng = Random.secure();
  final out = StringBuffer();
  for (var i = 0; i < len; i++) {
    out.write(_base62[rng.nextInt(_base62.length)]);
  }
  return out.toString();
}

/// 免费模型的形状判据：【`-free` 后缀】或显式例外集。
///
/// 为什么要有例外集：`big-pickle` 没有 `-free` 后缀，但上游实测对免费层开放
/// （built_in_keys.dart:106-109）。纯后缀过滤会把它剔掉——这正是电脑版
/// `filterFreeZenModels` 与静态清单口径不一致的那一处。
const Set<String> kZenNoSuffixFreeModels = {'big-pickle'};

bool isZenFreeModelId(String id) {
  final v = id.trim().toLowerCase();
  if (v.isEmpty) return false;
  if (v.endsWith('-free')) return true;
  return kZenNoSuffixFreeModels.contains(v);
}

/// 免费模型被指到不匹配的端点时返回一句可行动的话，没问题返回 null。
///
/// 只对 opencode.ai 家族判定：Command Code / OpenCode Go 里也有带 `-free` 的
/// 自有模型（`minimax/minimax-m3-free`、`ox-alpha-free`），它们的端点本来
/// 就不是 Zen 免费根，拿这条判据去拦只会把能用的通道拦死。
String? freeModelEndpointProblem(String baseUrl, String model) {
  if (!isZenFreeModelId(model)) return null;
  final uri = Uri.tryParse(baseUrl.trim());
  if (uri == null || !uri.hasAuthority) {
    return '免费模型 $model 需要端点，当前 Base URL 为空';
  }
  if (!uri.host.toLowerCase().endsWith('opencode.ai')) return null;
  if (ZenGate.isZenEndpoint(baseUrl)) return null;
  return '免费模型 $model 只能直连 $kOpencodeZenBaseUrl：'
      '当前端点是 $baseUrl（不是免费根），请求未发送';
}

/// 设备种子的来源。抽出来只有一个目的：单测里不需要真的碰 MethodChannel。
abstract class ZenSeedSource {
  Future<String?> seed();
}

class _ChannelZenSeedSource implements ZenSeedSource {
  const _ChannelZenSeedSource();

  static const _channel = MethodChannel('com.khyos.khy_os_client/device');

  @override
  Future<String?> seed() async {
    try {
      final r = await _channel.invokeMapMethod<String, dynamic>('zenDeviceSeed');
      if (r == null || r['ok'] != true) return null;
      final s = r['seed'];
      if (s is! String || !RegExp(r'^[0-9a-f]{64}$').hasMatch(s)) return null;
      return s;
    } catch (_) {
      // 通道不可用（纯 Dart 单测、旧原生壳）→ 当作没有种子，走安装期回退。
      return null;
    }
  }
}

class ZenIdentity {
  final String sessionId;
  final String projectUuid;
  final int createdAtMs;

  const ZenIdentity({
    required this.sessionId,
    required this.projectUuid,
    required this.createdAtMs,
  });

  Map<String, dynamic> toJson() => {
        'v': 1,
        'sessionId': sessionId,
        'projectUuid': projectUuid,
        'createdAtMs': createdAtMs,
      };

  static ZenIdentity? tryParse(String raw) {
    try {
      final map = jsonDecode(raw);
      if (map is! Map) return null;
      final sessionId = map['sessionId'];
      final projectUuid = map['projectUuid'];
      final createdAtMs = map['createdAtMs'];
      if (sessionId is! String || projectUuid is! String) return null;
      if (createdAtMs is! num) return null;
      if (!RegExp(r'^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$').hasMatch(sessionId)) {
        return null;
      }
      if (!RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-'
              r'[0-9a-f]{12}$')
          .hasMatch(projectUuid)) {
        return null;
      }
      return ZenIdentity(
        sessionId: sessionId,
        projectUuid: projectUuid,
        createdAtMs: createdAtMs.toInt(),
      );
    } catch (_) {
      return null;
    }
  }
}

/// 身份的落盘位置。抽出来只有一个目的：单测里不需要真的碰平台存储。
abstract class ZenIdentityStore {
  Future<String?> read();
  Future<void> write(String value);
}

class _SecureZenIdentityStore implements ZenIdentityStore {
  const _SecureZenIdentityStore();

  static const _storage = FlutterSecureStorage();

  @override
  Future<String?> read() => _storage.read(key: _identityStorageKey);

  @override
  Future<void> write(String value) =>
      _storage.write(key: _identityStorageKey, value: value);
}

class ZenGate {
  ZenGate._();

  /// 单测可替换。默认落 FlutterSecureStorage（应用私有、卸载才消失）。
  static ZenIdentityStore store = const _SecureZenIdentityStore();

  /// 单测可替换。默认走原生设备种子（ANDROID_ID 的 HMAC 摘要）。
  static ZenSeedSource seedSource = const _ChannelZenSeedSource();

  static ZenIdentity? _cached;
  static Future<ZenIdentity>? _pending;

  /// 只清内存态，不动落盘文件（与电脑版 `_reset()` 同语义）。
  static void resetForTest({
    ZenIdentityStore? store,
    ZenSeedSource? seedSource,
  }) {
    _cached = null;
    _pending = null;
    if (store != null) ZenGate.store = store;
    if (seedSource != null) ZenGate.seedSource = seedSource;
  }

  /// 本机身份：有设备种子时**每次重算同一份**，没有时才落到安装期身份。
  ///
  /// 为什么身份不再以落盘值为准：落盘读失败（安全存储损坏、备份恢复不完整）
  /// 时旧实现会静默生成一份新身份，于是每次冷启动都换一个"设备"——上游眼里
  /// 同一台手机在刷量。种子派生不依赖任何存储，读失败这个病例从根上不存在。
  ///
  /// 落盘仍然写：取不到种子（ANDROID_ID 为空/坏值）的设备要靠它跨重启稳定，
  /// 同一台设备从"有种子"退回"无种子"时也有个连续的身份可用。
  static Future<ZenIdentity> identity() {
    final cached = _cached;
    if (cached != null) return Future.value(cached);
    final pending = _pending;
    if (pending != null) return pending;

    final future = _loadOrCreate().then((value) {
      _cached = value;
      return value;
    });
    _pending = future;
    return future.whenComplete(() {
      _pending = null;
    });
  }

  static Future<ZenIdentity> _loadOrCreate() async {
    String? seed;
    try {
      seed = await seedSource.seed();
    } catch (_) {
      seed = null;
    }
    if (seed != null && seed.isNotEmpty) {
      final derived = derive(seed);
      try {
        await store.write(jsonEncode(derived.toJson()));
      } catch (_) {
        // 写不进去不影响身份：它是算出来的，不是读出来的。
      }
      return derived;
    }

    try {
      final raw = await store.read();
      if (raw != null && raw.isNotEmpty) {
        final parsed = ZenIdentity.tryParse(raw);
        if (parsed != null) return parsed;
      }
    } catch (_) {
      // 存储读不到 → 生成一份内存身份，不让请求被身份模块挡住。
    }

    final createdAtMs = DateTime.now().millisecondsSinceEpoch;
    final created = ZenIdentity(
      sessionId: newZenSessionId(createdAtMs),
      projectUuid: const Uuid().v4(),
      createdAtMs: createdAtMs,
    );
    try {
      await store.write(jsonEncode(created.toJson()));
    } catch (_) {
      // 写不进去就只保内存；下一次启动会重新生成。
    }
    return created;
  }

  /// 从设备种子派生身份——纯函数，同一 seed 永远同一结果。
  ///
  /// 与电脑版 `zenIdentity.js:109-151` 同构：HMAC-SHA256（域串
  /// `khy-zen-identity-v1`）分别派生 session 尾段、project uuid 和"创建时刻"。
  /// 12 位 hex 前缀不能取 `DateTime.now()`：那样每次冷启动前缀都会变，
  /// 整个 session id 跟着变——正是要修的病例。这里把它映射到 2024-01-01 起的
  /// 一个 730 天固定窗口，同种子恒定。
  static ZenIdentity derive(String seed) {
    final tailBytes = _deriveBytes(seed, 'session-tail');
    final tail = StringBuffer();
    for (var i = 0; i < 14; i++) {
      tail.write(_base62[tailBytes[i % tailBytes.length] % _base62.length]);
    }

    final uuidBytes = List<int>.from(_deriveBytes(seed, 'project').take(16));
    uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x40;
    uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80;
    final hex = uuidBytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    final projectUuid = '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
        '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';

    final atBytes = _deriveBytes(seed, 'created-at');
    var window = 0;
    for (var i = 0; i < 6; i++) {
      window = window * 256 + atBytes[i];
    }
    final createdAtMs = 1_704_067_200_000 + (window % 63_072_000_000);

    return ZenIdentity(
      sessionId: 'ses_${_timeHex(createdAtMs, descending: true)}$tail',
      projectUuid: projectUuid,
      createdAtMs: createdAtMs,
    );
  }

  static const _identityDomain = 'khy-zen-identity-v1';

  static List<int> _deriveBytes(String seed, String purpose) {
    final hmac = Hmac(sha256, utf8.encode(_identityDomain));
    return hmac.convert(utf8.encode('$purpose\u0000$seed')).bytes;
  }

  /// True when [url] 指向 Zen 免费档（容忍尾部斜杠与任一侧的 /v1）。
  static bool isZenEndpoint(String url) {
    final raw = url.trim();
    if (raw.isEmpty) return false;
    final a = Uri.tryParse(raw);
    if (a == null || !a.hasAuthority) return false;
    final b = Uri.parse(kOpencodeZenBaseUrl);
    if (a.host.toLowerCase() != b.host.toLowerCase()) return false;
    return _stripPath(a.path) == _stripPath(b.path);
  }

  static String _stripPath(String path) {
    var p = path.replaceAll(RegExp(r'/+$'), '');
    if (p.endsWith('/v1')) p = p.substring(0, p.length - 3);
    return p;
  }

  /// 真正免费档会用的 bearer：用户明确填了真 key 就尊重它，否则发 public。
  static String _bearer(String? apiKey) {
    final value = (apiKey ?? '').trim();
    if (value.isEmpty || value == kZenPublicBearer) return kZenPublicBearer;
    return value;
  }

  /// 每次请求都要新的一套头；session/project 稳定，request id 每请求一条。
  static Future<Map<String, String>> headers({
    String? bearer,
    String? requestId,
  }) async {
    final id = await identity();
    return {
      'User-Agent': kZenUserAgent,
      'x-opencode-session': id.sessionId,
      'x-opencode-request': requestId ?? newZenRequestId(),
      'x-opencode-client': 'cli',
      'x-opencode-project': id.projectUuid,
      'x-session-id': id.sessionId,
      'Authorization': 'Bearer ${_bearer(bearer)}',
    };
  }

  /// 非 chat 请求（/models、连通性测试）用同一套指纹，只是没有 body 门。
  /// 上游对"裸 UA"的判断发生在端点入口，模型列表同样拦。
  static Future<Map<String, String>> requestHeaders({
    required String baseUrl,
    required String apiKey,
    bool includeContentType = false,
  }) async {
    if (!isZenEndpoint(baseUrl)) {
      return {
        'Authorization': 'Bearer $apiKey',
        if (includeContentType) 'Content-Type': 'application/json',
      };
    }
    final h = await headers();
    if (includeContentType) h['Content-Type'] = 'application/json';
    return h;
  }

  /// 免费档 body 门接受的工具声明。上游只认名字 `bash` / `read`（区分大小写），
  /// schema 形状不作指纹；实测证据见电脑版 `ZEN_GATE_TOOLS` 注释。
  static const List<Map<String, dynamic>> zenGateTools = [
    {
      'type': 'function',
      'function': {
        'name': 'bash',
        'description': 'Execute a shell command and return its output.',
        'parameters': {
          'type': 'object',
          'properties': {
            'command': {'type': 'string', 'description': 'Shell command to run'},
          },
          'required': ['command'],
        },
      },
    },
    {
      'type': 'function',
      'function': {
        'name': 'read',
        'description': 'Read a file from disk and return its contents.',
        'parameters': {
          'type': 'object',
          'properties': {
            'filePath': {
              'type': 'string',
              'description': 'Absolute path to the file',
            },
          },
          'required': ['filePath'],
        },
      },
    },
  ];

  static String _toolName(dynamic tool) {
    if (tool is! Map) return '';
    final fn = tool['function'];
    if (fn is Map && fn['name'] != null) return fn['name'].toString();
    if (tool['name'] != null) return tool['name'].toString();
    return '';
  }

  /// 就地改造 body：强制 stream:true，并保证 tools[] 含 bash 与 read。
  ///
  /// `hadCallerTools` 决定要不要补 `tool_choice:'none'`：调用方本来就带工具时
  /// 不补，否则模型会被禁掉真正的工具调用；只有门控工具时补上，避免模型去调
  /// 两个它并不拥有的 bash/read。
  static void applyBodyGate(
    Map<String, dynamic> body, {
    bool? hadCallerTools,
  }) {
    body['stream'] = true;

    final gateNames = zenGateTools.map(_toolName).toSet();
    final existing = body['tools'];
    final tools = existing is List
        ? List<dynamic>.from(existing)
        : <dynamic>[];
    final presentBefore = tools.map(_toolName).toSet();
    final hadNonGate = presentBefore.any((n) => n.isNotEmpty && !gateNames.contains(n));
    final effectiveHadCallerTools =
        hadCallerTools ?? hadNonGate;

    for (final gateTool in zenGateTools) {
      final name = _toolName(gateTool);
      if (!presentBefore.contains(name)) {
        tools.add(gateTool);
        presentBefore.add(name);
      }
    }
    if (tools.isNotEmpty) body['tools'] = tools;

    if (!effectiveHadCallerTools && body['tool_choice'] == null) {
      body['tool_choice'] = 'none';
    }
  }

  /// OpenAI 兼容 chat 请求的统一入口。
  ///
  /// 非 Zen 端点原样 POST；Zen 端点自动加指纹头、过 body 门，并把上游的
  /// SSE 流折叠成一条普通 OpenAI 响应。折叠这一步是必须的：免费档强制
  /// stream:true，而手机上所有调用方读的都是 `choices[0].message`。
  static Future<Map<String, dynamic>> postChatCompletion({
    required Dio dio,
    required String baseUrl,
    required String apiKey,
    required Map<String, dynamic> body,
  }) async {
    final url = '$baseUrl/chat/completions';
    if (!isZenEndpoint(baseUrl)) {
      final resp = await dio.post(
        url,
        data: body,
        options: Options(headers: {
          'Authorization': 'Bearer $apiKey',
          'Content-Type': 'application/json',
        }),
      );
      return _asJsonMap(resp.data);
    }

    final existingTools = body['tools'];
    applyBodyGate(
      body,
      hadCallerTools: existingTools is List && existingTools.isNotEmpty,
    );

    final Response<dynamic> resp;
    try {
      resp = await dio.post(
        url,
        data: body,
        options: Options(
          headers: {
            ...await headers(),
            'Content-Type': 'application/json',
          },
          responseType: ResponseType.stream,
        ),
      );
    } on DioException catch (e) {
      throw await materializeErrorBody(e);
    }
    return collectZenStream(
      resp.data,
      fallbackModel: body['model']?.toString() ?? '',
    );
  }

  /// 把流式错误响应的 `ResponseBody` 排干成文本，再重建异常。
  ///
  /// 为什么必须做：`ResponseType.stream` 下 dio 对错误响应也走 transform，
  /// 而 `ResponseBody` 原样返回（fused_transformer），于是
  /// `e.response.data` 不是字符串。调用方拿它去匹配 `FreeTierError`
  /// 之类的识别码，一条都命中不了——错误分类全落到"未知"。
  ///
  /// 用 [DioException.copyWith] 重建：`_handleDioErr` 是同步的 void 方法，
  /// 另起一个异步错误路径会让所有调用方都得改成 await。
  static Future<DioException> materializeErrorBody(DioException e) async {
    final response = e.response;
    final data = response?.data;
    if (response == null || data is! ResponseBody) return e;
    final text = await drainResponseBody(data);
    return e.copyWith(
      response: Response<String>(
        data: text,
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        requestOptions: response.requestOptions,
        headers: response.headers,
        isRedirect: response.isRedirect,
        redirects: response.redirects,
        extra: response.extra,
      ),
    );
  }

  static Map<String, dynamic> _asJsonMap(dynamic data) {
    if (data is Map) return data.cast<String, dynamic>();
    if (data is String) {
      final decoded = jsonDecode(data);
      if (decoded is Map) return decoded.cast<String, dynamic>();
    }
    throw const FormatException('模型返回了无法识别的响应');
  }

  /// 把 Zen 的 SSE 流折叠成非流式响应。
  ///
  /// 只保留对调用方有意义的字段：正文、思维链、工具调用、finish_reason、
  /// id/model/usage。逐 chunk 的原始事件没有第二个消费方，攒着只会让
  /// 内存随回复长度一起长。
  static Future<Map<String, dynamic>> collectZenStream(
    dynamic responseData, {
    String fallbackModel = '',
  }) async {
    final Stream<List<int>> bytes =
        responseData.stream.cast<List<int>>();
    final content = StringBuffer();
    final reasoning = StringBuffer();
    final rawFallback = StringBuffer();
    final toolCalls = <int, _ToolCallAcc>{};
    var sawEvent = false;
    var id = '';
    var model = '';
    String? finishReason;
    Map<String, dynamic>? usage;

    await for (final line
        in bytes.transform(utf8.decoder).transform(const LineSplitter())) {
      if (line.isEmpty) continue;
      if (!line.startsWith('data:')) {
        rawFallback.write(line);
        continue;
      }
      sawEvent = true;
      final payload = line.substring(5).trim();
      if (payload.isEmpty || payload == '[DONE]') continue;

      final decoded = jsonDecode(payload);
      if (decoded is! Map) continue;
      final json = decoded.cast<String, dynamic>();

      if (json['id'] is String) id = json['id'] as String;
      if (json['model'] is String) model = json['model'] as String;
      if (json['usage'] is Map) {
        usage = (json['usage'] as Map).cast<String, dynamic>();
      }

      final choices = json['choices'];
      if (choices is! List || choices.isEmpty) continue;
      final choice = choices.first;
      if (choice is! Map) continue;

      if (choice['finish_reason'] != null) {
        finishReason = choice['finish_reason'].toString();
      }
      // 多数上游发 delta；也有把完整 message 塞在最后一个事件的实现。
      final delta = choice['delta'] is Map
          ? choice['delta'] as Map
          : (choice['message'] is Map ? choice['message'] as Map : null);
      if (delta == null) continue;

      final text = delta['content'];
      if (text is String) content.write(text);

      for (final key in const ['reasoning_content', 'reasoning', 'thinking']) {
        final value = delta[key];
        if (value is String && value.isNotEmpty) {
          reasoning.write(value);
          break;
        }
      }

      final calls = delta['tool_calls'];
      if (calls is List) {
        for (final raw in calls) {
          if (raw is! Map) continue;
          final index = raw['index'] is int ? raw['index'] as int : 0;
          final acc = toolCalls.putIfAbsent(index, _ToolCallAcc.new);
          final callId = raw['id'];
          if (callId is String && callId.isNotEmpty) acc.id = callId;
          final fn = raw['function'];
          if (fn is Map) {
            final name = fn['name'];
            if (name is String && name.isNotEmpty) acc.name = name;
            final args = fn['arguments'];
            if (args is String) acc.arguments.write(args);
          }
        }
      }
    }

    // 上游若忽略 stream:true 直接回了整份 JSON，这里把它交回去，
    // 而不是返回一条空回复让用户以为模型没说话。
    if (!sawEvent && rawFallback.isNotEmpty) {
      final decoded = jsonDecode(rawFallback.toString());
      if (decoded is Map) return decoded.cast<String, dynamic>();
    }

    final message = <String, dynamic>{
      'role': 'assistant',
      'content': content.toString(),
    };
    if (reasoning.isNotEmpty) {
      message['reasoning_content'] = reasoning.toString();
    }
    if (toolCalls.isNotEmpty) {
      final indexes = toolCalls.keys.toList()..sort();
      message['tool_calls'] = [
        for (final index in indexes)
          {
            'id': toolCalls[index]!.id.isEmpty
                ? 'call_$index'
                : toolCalls[index]!.id,
            'type': 'function',
            'function': {
              'name': toolCalls[index]!.name,
              'arguments': toolCalls[index]!.arguments.toString(),
            },
          },
      ];
    }

    final result = <String, dynamic>{
      'id': id.isEmpty ? 'chatcmpl-zen' : id,
      'object': 'chat.completion',
      'created': DateTime.now().millisecondsSinceEpoch ~/ 1000,
      'model': model.isEmpty ? fallbackModel : model,
      'choices': [
        {
          'index': 0,
          'message': message,
          'finish_reason': finishReason ??
              (toolCalls.isEmpty ? 'stop' : 'tool_calls'),
        },
      ],
    };
    if (usage != null) result['usage'] = usage;
    return result;
  }
}

class _ToolCallAcc {
  String id = '';
  String name = '';
  final StringBuffer arguments = StringBuffer();
}
