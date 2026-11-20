/// 用户图片入口的 wire 契约。
///
/// 一条红线贯穿全部用例：带图的 user 消息在**四种适配器**上产出同一个形状的
/// content block（text + image_url data-URI）。形状分叉是没有症状的——只是某些
/// 模型永远收不到用户发的那张图，而界面一切正常。
///
/// 这张形状不是本端发明的：`lib/core/tools/vision_tools.dart` 的视觉调用早就
/// 在发它，本机 llama.cpp 回环端点与云端多模态端点都照单接收。所以这里钉住的
/// 是「与既有视觉调用同构」，不是「恰好能跑」。
///
/// 只测不依赖设备的那一半：不碰真网络、不碰相册权限、不碰 MethodChannel。
library;

import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/gateway/provider_adapter.dart';
import 'package:khy_os_client/data/models/models.dart';
import 'package:khy_os_client/ui/theme/app_theme.dart';
import 'package:khy_os_client/ui/widgets/chat_message_row.dart';

/// 一张 1x1 的合法 PNG（70 字节）。图片内容无关紧要，要的是「真是个能解码的
/// 图」——缩略渲染那条路走的是 Image.file，喂垃圾字节会落到 errorBuilder，
/// 那就测不到正常路径了。
const String _pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';

const String _openAiChatBody =
    '{"id":"cmpl-1","choices":[{"index":0,"message":{"role":"assistant",'
    '"content":"看见了一张图"},"finish_reason":"stop"}],"model":"m"}';

const String _openAiSseBody =
    'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"看见"}}]}\n'
    '\n'
    'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"content":"了一张图"},'
    '"finish_reason":"stop"}]}\n'
    '\n'
    'data: [DONE]\n'
    '\n';

const String _anthropicChatBody =
    '{"id":"msg_1","type":"message","role":"assistant",'
    '"content":[{"type":"text","text":"看见了一张图"}],"model":"claude"}';

const String _anthropicSseBody =
    'data: {"type":"message_start","message":{"id":"msg_1"}}\n'
    '\n'
    'data: {"type":"content_block_delta","index":0,'
    '"delta":{"type":"text_delta","text":"看见了一张图"}}\n'
    '\n'
    'data: {"type":"message_stop"}\n'
    '\n';

const String _ollamaChatBody =
    '{"model":"llama3.2-vision","message":{"role":"assistant",'
    '"content":"看见了一张图"},"done":true}';

const String _ollamaSseBody =
    '{"model":"llama3.2-vision","message":{"content":"看见了一张图"},"done":true}\n';

/// 捕获请求体、回一份最小合法响应。
///
/// 只为钉**发出去的形状**。形状错了在真网络上也看得见（模型回答"看不到图"），
/// 但那时已经烧掉一次用户请求，且没有一方会报错。
class _CaptureAdapter implements HttpClientAdapter {
  _CaptureAdapter(this._body, {String contentType = Headers.jsonContentType})
      : _headers = {
          Headers.contentTypeHeader: [contentType],
        };

  final String _body;
  final Map<String, List<String>> _headers;

  /// 原始请求体（Map）。null = 这个适配器没发出请求。
  Object? captured;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    captured = options.data;
    return ResponseBody.fromString(_body, 200, headers: _headers);
  }

  @override
  void close({bool force = false}) {}
}

Dio _dioCapturing(_CaptureAdapter adapter) {
  final dio = Dio();
  dio.httpClientAdapter = adapter;
  return dio;
}

ChatMessage _msg(
  String id, {
  MessageRole role = MessageRole.user,
  String content = '这张图里有什么？',
  List<MessageAttachment>? attachments,
}) =>
    ChatMessage(
      id: id,
      conversationId: 'c1',
      role: role,
      content: content,
      attachments: attachments,
      timestamp: DateTime.fromMillisecondsSinceEpoch(0),
    );

MessageAttachment _image(String path, {String? mimeType}) => MessageAttachment(
      id: 'att-$path',
      type: AttachmentType.image,
      path: path,
      mimeType: mimeType,
      size: 70,
    );

/// 从捕获体里取第一条消息的 content。
///
/// 四家的 messages 都在顶层、content 都在 messages[0]——这个测试要钉的正是它。
List<dynamic> _contentOf(Object? body) {
  final messages = (body as Map<String, dynamic>)['messages'] as List;
  return messages[0]['content'] as List;
}

/// 期望的块数组：text 在前，image_url 的 data URI 逐字节来自磁盘上的那个文件。
List<Map<String, dynamic>> _expectedBlocks(String text, String path,
        {String mime = 'image/jpeg'}) =>
    [
      {'type': 'text', 'text': text},
      {
        'type': 'image_url',
        'image_url': {
          'url': 'data:$mime;base64,${base64Encode(File(path).readAsBytesSync())}',
        },
      },
    ];

void main() {
  late Directory sandbox;
  late String pngPath;

  setUp(() {
    sandbox = Directory.systemTemp.createTempSync('khyos-mm-test');
    pngPath = '${sandbox.path}/shot.png';
    File(pngPath).writeAsBytesSync(base64Decode(_pngBase64));
  });

  tearDown(() => sandbox.deleteSync(recursive: true));

  group('models：imageAttachments 是发送链与渲染共用的那一个定义', () {
    test('没有 attachments 字段时是空列表，不是 null', () {
      expect(_msg('u').imageAttachments, isEmpty);
    });

    test('只收图片；文件/音频/视频不进来', () {
      // 视频抽帧要原生工（Android 无 ffmpeg），音频与文件也没有多模态通道。
      // 混进来只会造出发过去也没人读的块。
      final m = _msg('u', attachments: [
        _image(pngPath),
        const MessageAttachment(
            id: 'f', type: AttachmentType.file, path: '/tmp/a.pdf'),
        const MessageAttachment(
            id: 'a', type: AttachmentType.audio, path: '/tmp/a.m4a'),
        const MessageAttachment(
            id: 'v', type: AttachmentType.video, path: '/tmp/a.mp4'),
      ]);
      expect(m.imageAttachments.map((a) => a.id), ['att-$pngPath']);
    });

    test('序列化往返后图片附件还在', () {
      // 发送链读的是消息字段；存下去再读回来少一张图，历史重放就会静默丢图。
      final m = _msg('u', attachments: [_image(pngPath, mimeType: 'image/png')]);
      final back = ChatMessage.fromJson(m.toJson());
      expect(back.imageAttachments.single.path, pngPath);
      expect(back.imageAttachments.single.mimeType, 'image/png');
    });

    test('copyWith 不丢附件', () {
      // 流式期间上层每个 chunk 都在 copyWith(content: ...)。这里丢了的话，
      // 第一个正文字节到达时用户发的那张图就从消息上消失。
      final m = _msg('u', attachments: [_image(pngPath)]);
      final next = m.copyWith(content: '${m.content}再问一句');
      expect(next.imageAttachments, hasLength(1));
    });
  });

  group('四种适配器：带图消息产出同一个 content block 形状', () {
    test('OpenAI 兼容：chat 与 stream 两条路都带图', () async {
      for (final stream in const [false, true]) {
        final cap = _CaptureAdapter(
          stream ? _openAiSseBody : _openAiChatBody,
          contentType:
              stream ? Headers.textPlainContentType : Headers.jsonContentType,
        );
        final adapter = OpenAIAdapter(
          id: 'o',
          name: 'OpenAI 兼容',
          baseUrl: 'https://example.invalid/v1',
          apiKey: 'placeholder-not-a-real-key',
          model: 'm',
          dio: _dioCapturing(cap),
        );
        final request = ChatRequest(
          messages: [_msg('u1', attachments: [_image(pngPath)])],
        );
        if (stream) {
          await (await adapter.streamChat(request)).toList();
        } else {
          await adapter.chat(request);
        }

        expect(cap.captured, isNotNull, reason: '请求没发出去');
        final body = cap.captured as Map<String, dynamic>;
        expect((body['messages'] as List).first['role'], 'user');
        expect(_contentOf(body), _expectedBlocks('这张图里有什么？', pngPath, mime: 'image/png'));
      }
    });

    test('DeepSeek：与 OpenAI 同一条翻译路径', () async {
      final cap = _CaptureAdapter(_openAiChatBody);
      final adapter = DeepSeekAdapter(
        id: 'd',
        name: 'DeepSeek',
        apiKey: 'placeholder-not-a-real-key',
        model: 'm',
        dio: _dioCapturing(cap),
      );
      await adapter.chat(ChatRequest(
        messages: [_msg('u1', attachments: [_image(pngPath)])],
      ));

      expect(_contentOf(cap.captured), _expectedBlocks('这张图里有什么？', pngPath, mime: 'image/png'));
    });

    test('Anthropic：chat 与 stream 两条路都带图', () async {
      for (final stream in const [false, true]) {
        final cap = _CaptureAdapter(
          stream ? _anthropicSseBody : _anthropicChatBody,
          contentType:
              stream ? Headers.textPlainContentType : Headers.jsonContentType,
        );
        final adapter = AnthropicAdapter(
          id: 'a',
          name: 'Anthropic',
          apiKey: 'placeholder-not-a-real-key',
          dio: _dioCapturing(cap),
        );
        final request = ChatRequest(
          messages: [_msg('u1', attachments: [_image(pngPath)])],
        );
        if (stream) {
          await (await adapter.streamChat(request)).toList();
        } else {
          await adapter.chat(request);
        }

        expect(_contentOf(cap.captured), _expectedBlocks('这张图里有什么？', pngPath, mime: 'image/png'));
      }
    });

    test('Ollama：chat 与 stream 两条路都带图', () async {
      for (final stream in const [false, true]) {
        final cap = _CaptureAdapter(
          stream ? _ollamaSseBody : _ollamaChatBody,
          contentType:
              stream ? Headers.textPlainContentType : Headers.jsonContentType,
        );
        final adapter = OllamaAdapter(
          id: 'l',
          name: 'Ollama',
          dio: _dioCapturing(cap),
        );
        final request = ChatRequest(
          messages: [_msg('u1', attachments: [_image(pngPath)])],
        );
        if (stream) {
          await (await adapter.streamChat(request)).toList();
        } else {
          await adapter.chat(request);
        }

        expect(_contentOf(cap.captured), _expectedBlocks('这张图里有什么？', pngPath, mime: 'image/png'));
      }
    });

    test('多张图：text 之后按附件顺序排，角色不变', () async {
      final second = '${sandbox.path}/shot2.png';
      File(second).writeAsBytesSync(base64Decode(_pngBase64));
      final cap = _CaptureAdapter(_openAiChatBody);
      final adapter = OpenAIAdapter(
        id: 'o',
        name: 'o',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'placeholder-not-a-real-key',
        model: 'm',
        dio: _dioCapturing(cap),
      );
      await adapter.chat(ChatRequest(
        messages: [
          _msg('u1', attachments: [_image(pngPath), _image(second)]),
          _msg('a1',
              role: MessageRole.assistant,
              content: '看见了两张',
              attachments: [_image(pngPath)]),
        ],
      ));

      final messages = (cap.captured as Map<String, dynamic>)['messages'] as List;
      expect(messages[0]['role'], 'user');
      expect(messages[1]['role'], 'assistant');
      final blocks = messages[0]['content'] as List;
      expect(blocks, hasLength(3));
      expect((blocks[1] as Map)['image_url']['url'],
          'data:image/png;base64,${base64Encode(File(pngPath).readAsBytesSync())}');
      expect((blocks[2] as Map)['image_url']['url'],
          'data:image/png;base64,${base64Encode(File(second).readAsBytesSync())}');
      // assistant 那条也走块数组：形状不随角色变，换谁读都是同一种解析。
      expect(messages[1]['content'],
          _expectedBlocks('看见了两张', pngPath, mime: 'image/png'));
    });
  });

  group('不带图的消息：老形状一字不变', () {
    test('四种适配器上 content 仍是纯字符串', () async {
      final cases = <ProviderAdapter Function(_CaptureAdapter)>[
        (cap) => OpenAIAdapter(
              id: 'o',
              name: 'o',
              baseUrl: 'https://example.invalid/v1',
              apiKey: 'placeholder-not-a-real-key',
              model: 'm',
              dio: _dioCapturing(cap),
            ),
        (cap) => DeepSeekAdapter(
              id: 'd',
              name: 'd',
              apiKey: 'placeholder-not-a-real-key',
              model: 'm',
              dio: _dioCapturing(cap),
            ),
        (cap) => AnthropicAdapter(
              id: 'a',
              name: 'a',
              apiKey: 'placeholder-not-a-real-key',
              dio: _dioCapturing(cap),
            ),
        (cap) => OllamaAdapter(id: 'l', name: 'l', dio: _dioCapturing(cap)),
      ];
      final bodies = [
        _openAiChatBody,
        _openAiChatBody,
        _anthropicChatBody,
        _ollamaChatBody,
      ];

      for (var i = 0; i < cases.length; i++) {
        final cap = _CaptureAdapter(bodies[i]);
        final adapter = cases[i](cap);
        await adapter.chat(ChatRequest(messages: [_msg('u1')]));
        final messages =
            (cap.captured as Map<String, dynamic>)['messages'] as List;
        // 纯字符串，不是块数组：给不看图的消息也换成块，改动的面是全量请求。
        expect(messages[0]['content'], '这张图里有什么？', reason: '第 $i 个适配器');
      }
    });

    test('非图片附件不产生块，也不把文件名塞进正文', () async {
      final cap = _CaptureAdapter(_openAiChatBody);
      final adapter = OpenAIAdapter(
        id: 'o',
        name: 'o',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'placeholder-not-a-real-key',
        model: 'm',
        dio: _dioCapturing(cap),
      );
      await adapter.chat(ChatRequest(
        messages: [
          _msg('u1', attachments: [
            const MessageAttachment(
                id: 'f', type: AttachmentType.file, path: '/tmp/a.pdf'),
          ]),
        ],
      ));

      final messages = (cap.captured as Map<String, dynamic>)['messages'] as List;
      expect(messages[0]['content'], '这张图里有什么？');
    });
  });

  group('读不到的图片：少发一个块，请求照样发得出去', () {
    test('文件不在时只留 text 块，不抛', () async {
      // 相册/相机挑出来的临时文件可能已被系统清掉。为一张旧图让整次请求失败，
      // 比少发一张图糟得多——尤其是对话历史上传那条路。
      final cap = _CaptureAdapter(_openAiChatBody);
      final adapter = OpenAIAdapter(
        id: 'o',
        name: 'o',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'placeholder-not-a-real-key',
        model: 'm',
        dio: _dioCapturing(cap),
      );
      await adapter.chat(ChatRequest(
        messages: [
          _msg('u1', attachments: [_image('${sandbox.path}/已被清掉.png')]),
        ],
      ));

      expect(_contentOf(cap.captured), [
        {'type': 'text', 'text': '这张图里有什么？'},
      ]);
    });
  });

  group('data URI 的 mime', () {
    test('附件自带 mimeType 时照用', () async {
      final cap = _CaptureAdapter(_openAiChatBody);
      final adapter = OpenAIAdapter(
        id: 'o',
        name: 'o',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'placeholder-not-a-real-key',
        model: 'm',
        dio: _dioCapturing(cap),
      );
      await adapter.chat(ChatRequest(
        messages: [
          _msg('u1',
              attachments: [_image(pngPath, mimeType: 'image/png')]),
        ],
      ));

      final blocks = _contentOf(cap.captured);
      expect((blocks[1] as Map)['image_url']['url'] as String,
          startsWith('data:image/png;base64,'));
    });

    test('mimeType 为空时按扩展名猜，png 不说成 jpeg', () async {
      // 把 PNG 说成 jpeg，较严格的服务端解不开这张图——症状是模型说"看不到图"，
      // 谁都看不出是 mime 写错了。
      final cap = _CaptureAdapter(_openAiChatBody);
      final adapter = OpenAIAdapter(
        id: 'o',
        name: 'o',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'placeholder-not-a-real-key',
        model: 'm',
        dio: _dioCapturing(cap),
      );
      await adapter.chat(ChatRequest(
        messages: [_msg('u1', attachments: [_image(pngPath)])],
      ));

      final blocks = _contentOf(cap.captured);
      expect((blocks[1] as Map)['image_url']['url'] as String,
          startsWith('data:image/png;base64,'));
    });

    test('扩展名也不认识时退回 jpeg', () async {
      final odd = '${sandbox.path}/shot.xyz';
      File(odd).writeAsBytesSync(base64Decode(_pngBase64));
      final cap = _CaptureAdapter(_openAiChatBody);
      final adapter = OpenAIAdapter(
        id: 'o',
        name: 'o',
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'placeholder-not-a-real-key',
        model: 'm',
        dio: _dioCapturing(cap),
      );
      await adapter.chat(ChatRequest(
        messages: [_msg('u1', attachments: [_image(odd)])],
      ));

      final blocks = _contentOf(cap.captured);
      expect((blocks[1] as Map)['image_url']['url'] as String,
          startsWith('data:image/jpeg;base64,'));
    });
  });

  group('消息行：用户消息的图片缩略', () {
    Widget host(List<Widget> children) => MaterialApp(
          theme: AppTheme.dark(),
          home: Scaffold(body: Column(children: children)),
        );

    testWidgets('带图用户消息渲染缩略，assistant 消息不渲染', (tester) async {
      await tester.pumpWidget(host([
        ChatBubbleRow(
          message: _msg('u', attachments: [_image(pngPath)]),
          busy: false,
          action: '',
        ),
        ChatBubbleRow(
          message: _msg('a',
              role: MessageRole.assistant,
              content: '答复',
              attachments: [_image(pngPath)]),
          busy: false,
          action: '',
        ),
      ]));

      // 附件只可能是用户发过来的，缩略行也只在用户消息上找。
      expect(find.byType(Image), findsOneWidget);
      final image = tester.widget<Image>(find.byType(Image));
      expect((image.image as FileImage).file.path, pngPath);
    });

    testWidgets('增删附件：缩略数随附件走', (tester) async {
      final second = '${sandbox.path}/shot2.png';
      File(second).writeAsBytesSync(base64Decode(_pngBase64));

      Widget row(ChatMessage m) => ChatBubbleRow(
            message: m,
            busy: false,
            action: '',
          );

      await tester.pumpWidget(host([
        row(_msg('u', attachments: [_image(pngPath), _image(second)])),
      ]));
      expect(find.byType(Image), findsNWidgets(2));

      // 删到只剩一张
      await tester.pumpWidget(host([
        row(_msg('u', attachments: [_image(pngPath)])),
      ]));
      expect(find.byType(Image), findsOneWidget);

      // 全删掉：缩略行整体退场，气泡回到没有这个功能之前的布局
      await tester.pumpWidget(host([row(_msg('u'))]));
      expect(find.byType(Image), findsNothing);
      expect(find.text('这张图里有什么？'), findsOneWidget);
    });

    testWidgets('文件不在时画占位框，不为一张图毁掉整行', (tester) async {
      await tester.pumpWidget(host([
        ChatBubbleRow(
          message: _msg('u', attachments: [_image('${sandbox.path}/没了.png')]),
          busy: false,
          action: '',
        ),
      ]));

      expect(find.byType(Image), findsNothing);
      expect(find.byIcon(Icons.image_not_supported_outlined), findsOneWidget);
      // 正文照常在
      expect(find.text('这张图里有什么？'), findsOneWidget);
    });
  });
}
