/// recognize_image（识图工具）的传输契约。
///
/// 工具本体的注册在 `builtin_tools.dart`（接线阶段合入），这里钉的是它依赖的
/// 那一半：**图片读取 → base64 → 请求体**。三件事各自容易静默错掉——
///
///   1. 读到的字节与磁盘上的不是同一份（路径解析错、读了别的文件）；
///   2. data URI 的 mime 与真实格式不符，服务端解不开，症状是模型说"看不到图"；
///   3. 请求体形状与既有视觉调用不同构，于是同一张图在 analyze_screen 那条路上
///      能用、在 recognize_image 这条路上不能——而没有任何一方会报错。
///
/// 所以第三条与 `lib/core/tools/vision_tools.dart` 的 `_askVision` 逐键对齐：
/// 那一处早就在发这个形状，本机 llama.cpp 回环端点与云端多模态端点都照单接收。
/// recognize_image 不新造引擎，复用的就是这条传输。
///
/// 只测不依赖设备的那一半：不碰真网络、不碰 FlutterSecureStorage（工具的
/// `cfg.visionBaseUrl/visionModel/effectiveVisionKey` 归配置层，此处用两个不同
/// baseUrl 的适配器代表「本地 / 云端」两条路）。
library;

import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/endpoint_defaults.dart';
import 'package:khy_os_client/core/gateway/provider_adapter.dart';
import 'package:khy_os_client/data/models/models.dart';

/// 一张 1x1 的合法 PNG（70 字节）。要的是「真是个能解码的图」。
const String _pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';

/// recognize_image 的提示词。与桌面 `runtime/node/backend/src/tools/recognizeImage.js`
/// 同一职责：把图中文字按阅读顺序交出来。UI 侧不得宣称「精确 OCR」——本地
/// Qwen3-VL 对密集中文小字的逐字识别弱于桌面 Tesseract，措辞由界面层把关，
/// 这里只钉它确实作为正文发给了模型。
const String _prompt = '识别图中所有文字并按阅读顺序输出';

const String _chatOkBody =
    '{"id":"cmpl-1","choices":[{"index":0,"message":{"role":"assistant",'
    '"content":"图中的文字是……"},"finish_reason":"stop"}],"model":"m"}';

/// 捕获请求体、回一份最小合法响应。只为钉**发出去的形状**。
class _CaptureAdapter implements HttpClientAdapter {
  _CaptureAdapter(this._body);

  final String _body;
  Object? captured;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    captured = options.data;
    return ResponseBody.fromString(_body, 200, headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
    });
  }

  @override
  void close({bool force = false}) {}
}

Dio _dioCapturing(_CaptureAdapter adapter) {
  final dio = Dio();
  dio.httpClientAdapter = adapter;
  return dio;
}

OpenAIAdapter _visionAdapter(String baseUrl, _CaptureAdapter cap) =>
    OpenAIAdapter(
      id: 'vision',
      name: 'vision',
      // 端点不写字面量：本地那条取自 endpoint_defaults 的默认回环，云端那条
      // 由用户在设置里填（VisionConfigSection）。
      baseUrl: baseUrl,
      apiKey: 'placeholder-not-a-real-key',
      model: 'vision-model',
      dio: _dioCapturing(cap),
    );

/// 一次识图请求：一个 user 消息 = 提示词 + 一张图。
ChatRequest _recognizeRequest(String imagePath) => ChatRequest(
      messages: [
        ChatMessage(
          id: 'u1',
          conversationId: 'c1',
          role: MessageRole.user,
          content: _prompt,
          attachments: [
            MessageAttachment(
              id: 'att-1',
              type: AttachmentType.image,
              path: imagePath,
              size: 70,
            ),
          ],
          timestamp: DateTime.fromMillisecondsSinceEpoch(0),
        ),
      ],
    );

List<dynamic> _blocksOf(Object? body) {
  final messages = (body as Map<String, dynamic>)['messages'] as List;
  return messages[0]['content'] as List;
}

void main() {
  late Directory sandbox;
  late String imagePath;

  setUp(() {
    sandbox = Directory.systemTemp.createTempSync('khyos-recognize-test');
    imagePath = '${sandbox.path}/photo.png';
    File(imagePath).writeAsBytesSync(base64Decode(_pngBase64));
  });

  tearDown(() => sandbox.deleteSync(recursive: true));

  group('图片读取 → base64 → data URI', () {
    test('data URI 的字节逐字节来自磁盘上那个文件', () async {
      final cap = _CaptureAdapter(_chatOkBody);
      await _visionAdapter(kDefaultOllamaVisionBaseUrl, cap)
          .chat(_recognizeRequest(imagePath));

      final blocks = _blocksOf(cap.captured);
      final url = ((blocks[1] as Map)['image_url'] as Map)['url'] as String;
      expect(url, startsWith('data:image/png;base64,'));
      final sent = base64Decode(url.substring(url.indexOf(',') + 1));
      // 与磁盘上的文件逐字节相同：路径解析错会在这里现形。
      expect(sent, File(imagePath).readAsBytesSync());
    });

    test('提示词进 text 块，与图同属一个 user 消息', () async {
      final cap = _CaptureAdapter(_chatOkBody);
      await _visionAdapter(kDefaultOllamaVisionBaseUrl, cap)
          .chat(_recognizeRequest(imagePath));

      final body = cap.captured as Map<String, dynamic>;
      final messages = body['messages'] as List;
      // 单轮：识图不需要对话历史，多带一条就多一分把旧图重发一遍的风险。
      expect(messages, hasLength(1));
      expect(messages[0]['role'], 'user');
      final blocks = messages[0]['content'] as List;
      expect(blocks[0], {'type': 'text', 'text': _prompt});
    });
  });

  group('请求体形状与 vision_tools 的视觉调用同构', () {
    test('键与块序逐项对齐：text 在前、image_url 的 url 一个键', () async {
      final cap = _CaptureAdapter(_chatOkBody);
      await _visionAdapter(kDefaultOllamaVisionBaseUrl, cap)
          .chat(_recognizeRequest(imagePath));

      final blocks = _blocksOf(cap.captured);
      expect(blocks, hasLength(2));

      // 整块深等：多一个 detail 之类，某些兼容端会整块拒收；少一个键，图就发不
      // 出去。两种都没有症状，所以连键集一起钉。块序也在这里——text 在前。
      expect(blocks[0], {'type': 'text', 'text': _prompt});
      expect(blocks[1], {
        'type': 'image_url',
        'image_url': {'url': startsWith('data:image/png;base64,')},
      });
    });
  });

  group('本地 / 云端端点：同一个形状', () {
    test('回环 llama.cpp 与远端多模态端点的请求体逐字节相同', () async {
      // 端点只决定请求发去哪、带哪把钥匙，不决定 body 的形状。若形状随端点
      // 分叉，同一张图就会在一条路上能用、另一条路上不能——没有症状。
      final localCap = _CaptureAdapter(_chatOkBody);
      final cloudCap = _CaptureAdapter(_chatOkBody);

      await _visionAdapter(kDefaultOllamaVisionBaseUrl, localCap)
          .chat(_recognizeRequest(imagePath));
      await _visionAdapter('https://vision.example.invalid/v1', cloudCap)
          .chat(_recognizeRequest(imagePath));

      final local = _blocksOf(localCap.captured);
      final cloud = _blocksOf(cloudCap.captured);
      expect(local, cloud);

      // 顺带钉住本地那条默认值真的来自 endpoint_defaults（RUNTIME-001：
      // 端点不写字面量，改端口只改那一处）。
      expect(kDefaultOllamaVisionBaseUrl, endsWith('/v1'));
    });

    test('换一张图、换一个提示词：只有内容变，形状不变', () async {
      final other = '${sandbox.path}/photo2.png';
      File(other).writeAsBytesSync(base64Decode(_pngBase64));

      final cap = _CaptureAdapter(_chatOkBody);
      await _visionAdapter('https://vision.example.invalid/v1', cap).chat(
        ChatRequest(
          messages: [
            ChatMessage(
              id: 'u2',
              conversationId: 'c1',
              role: MessageRole.user,
              content: '这张发票的金额是多少？',
              attachments: [
                MessageAttachment(
                  id: 'att-2',
                  type: AttachmentType.image,
                  path: other,
                  mimeType: 'image/png',
                ),
              ],
              timestamp: DateTime.fromMillisecondsSinceEpoch(0),
            ),
          ],
        ),
      );

      final blocks = _blocksOf(cap.captured);
      expect(blocks, hasLength(2));
      expect(blocks[0], {'type': 'text', 'text': '这张发票的金额是多少？'});
      final url = ((blocks[1] as Map)['image_url'] as Map)['url'] as String;
      expect(url, startsWith('data:image/png;base64,'));
    });
  });
}
