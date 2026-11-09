// khy-canary: Khy-20261101-098-SDMVDFS3
import 'package:dio/dio.dart';

import '../config/app_config.dart';
import '../config/endpoint_defaults.dart';
import '../services/device_control.dart';
import '../services/screen_metrics.dart';
import '../vision/locate_response.dart';
import 'tool_engine.dart';

/// Outcome of one vision request.
///
/// WHY NOT JUST RETURN A NULLABLE. The two failure kinds need different
/// follow-ups: a transport failure (Ollama not running, wrong URL, bad key) is
/// worth retrying and usually means the user has setup to do, while a parse
/// failure means the model answered but not in the expected shape. Collapsing
/// them into `null` would make every failure look like a parse failure, and the
/// user would be told the model misbehaved when in fact nothing was listening
/// on port 11434.
///
/// Sealed rather than a record with two nullable fields, because a record
/// allows the impossible `{left: null, right: null}` state and every call site
/// then has to handle it.
sealed class VisionCall {
  const VisionCall();
}

/// The request never produced an answer.
final class VisionCallFailed extends VisionCall {
  final String message;
  const VisionCallFailed(this.message);
}

/// The model answered; [response] says whether the answer was usable.
final class VisionCallParsed extends VisionCall {
  final LocateResponse response;
  const VisionCallParsed(this.response);
}

/// The vision tools: `vision_locate` and `vision_tap`.
///
/// WHY THESE ARE NOT IN `builtin_tools.dart`. That file is the registry for
/// every tool the assistant can call and it is already over a thousand lines.
/// These two are separated out for a second reason though: they are the only
/// tools whose correctness depends on a *coordinate conversion*, and that
/// conversion is the part most likely to be got wrong quietly. Keeping them in
/// one file keeps the prompt, the parser and the conversion next to each other,
/// where a change to one forces a look at the others.
///
/// WHY A VISION MODEL AT ALL. A text-only reasoning model cannot operate a GUI:
/// it can reason about what a screen probably contains, but it cannot read the
/// screen, and it certainly cannot tell which pixel a button occupies. Without
/// these tools such a model answers "I cannot interact with the interface" —
/// which is false, and is the exact failure the bridge exists to prevent.
///
/// THE CONTRACT WITH THE MODEL. The prompt asks for one JSON object with
/// coordinates normalised to 0-1000. Models do not reliably comply, so
/// [LocateResponseParser] handles the shapes they actually produce and records
/// which heuristic it used. A guessed coordinate space that is *recorded* can
/// be corrected; a hidden one cannot, and its symptom — a tap slightly off —
/// is indistinguishable from the model being wrong.
List<ToolDef> createVisionTools() => [
      ToolDef(
        name: 'vision_locate',
        description: '截图并让视觉模型找出某个元素的位置。'
            '返回归一化到 0-1000 的坐标（x、y 各 0-1000）以及换算后的屏幕像素坐标。'
            '适用于文字推理模型读不了屏幕、或无障碍树里看不到目标（如微信等第三方 App）的情况。'
            '找不到时会如实说明，不会编造坐标。',
        inputSchema: {
          'type': 'object',
          'properties': {
            'target': {
              'type': 'string',
              'description': '要找的元素，用自然语言描述，如"搜索框"、"右下角的发送按钮"',
            },
          },
          'required': ['target'],
        },
        execute: (args) => _locate(args['target'] ?? ''),
      ),
      ToolDef(
        name: 'vision_tap',
        description: '截图 → 视觉模型定位 → 直接点击。一步完成"找到并点掉"。'
            '等价于先 vision_locate 再 a11y_tap，但省掉一次往返，且坐标不会因为两次截图之间屏幕变化而错位。',
        inputSchema: {
          'type': 'object',
          'properties': {
            'target': {
              'type': 'string',
              'description': '要找并点击的元素，如"搜索框"、"发送按钮"',
            },
          },
          'required': ['target'],
        },
        permission: PermissionLevel.ask,
        execute: (args) => _locateAndTap(args['target'] ?? ''),
      ),
    ];

/// Screenshot plus the geometry needed to interpret it.
///
/// THE TWO MUST COME FROM THE SAME MOMENT. Asking for the metrics separately
/// from the frame would let the screen rotate in between, and the resulting
/// coordinates would be wrong in a way no error message could explain.
///
/// WHY THE ACCESSIBILITY ROUTE IS TRIED FIRST. MediaProjection pops a system
/// consent dialog every session; the accessibility screenshot needs nothing
/// beyond the service the vision tools already depend on for the tap. So the
/// common case costs the user one consent instead of two, and the dialog that
/// blocked this feature every single time never appears.
///
/// This is not a consent bypass — it is removing the need for a second consent
/// by reusing one the user already gave. Using the accessibility service to
/// click the system's own consent dialogs would be a bypass, and is not done.
///
/// Returns null with a message when neither route works, and the message
/// distinguishes them: "accessibility off" and "capture failed" have different
/// fixes, and collapsing them into one sends the user down the wrong path.
Future<({String base64, ScreenMetrics metrics, String? problem})> _shoot() async {
  final a11y = await DeviceControl.a11yScreenshot();
  if (a11y != null && (a11y['b64'] as String).isNotEmpty) {
    // The accessibility screenshot reports its own geometry in exactly the
    // vocabulary ScreenMetrics already reads, so no special case is needed:
    // orig_w/orig_h is the display, w/h is the JPEG in hand.
    return (
      base64: a11y['b64'] as String,
      metrics: ScreenMetrics.fromMap(a11y),
      problem: null,
    );
  }

  var ready = await DeviceControl.isScreenCaptureReady();
  if (!ready) {
    final started = await DeviceControl.startScreenCapture();
    if (!started) {
      return (
        base64: '',
        metrics: ScreenMetrics.none(),
        problem: '无法启动屏幕捕获',
      );
    }
    await Future.delayed(const Duration(seconds: 1));
    ready = await DeviceControl.isScreenCaptureReady();
    if (!ready) {
      return (
        base64: '',
        metrics: ScreenMetrics.none(),
        problem: '屏幕捕获未就绪',
      );
    }
  }

  final dataUrl = await DeviceControl.captureFrame();
  if (dataUrl == null || dataUrl.isEmpty) {
    return (
      base64: '',
      metrics: ScreenMetrics.none(),
      problem: '截屏失败',
    );
  }

  final metrics = await DeviceControl.getScreenMetrics();
  return (
    base64: dataUrl.contains(',') ? dataUrl.split(',').last : dataUrl,
    metrics: metrics,
    problem: null,
  );
}

/// Ask the vision model where [target] is.
Future<ToolResult> _locate(String target) async {
  if (target.trim().isEmpty) {
    return ToolResult.fail('请说清楚要找什么，例如"搜索框"');
  }

  final cfg = await AppConfig.loadEffective();
  if (!cfg.hasVisionConfig) {
    return ToolResult.fail(_notConfiguredMessage());
  }

  final shot = await _shoot();
  if (shot.problem != null) return ToolResult.fail(shot.problem!);

  final m = shot.metrics;
  if (!m.usable) {
    return ToolResult.fail(m.whyUnusable ?? '屏幕几何不可用');
  }

  final call = await _askVision(cfg, shot.base64, m.imgW, m.imgH, target);
  final LocateResponse r;
  switch (call) {
    case VisionCallFailed(:final message):
      return ToolResult.fail(message);
    case VisionCallParsed(:final response):
      r = response;
  }

  if (r.unparsable) {
    // The contract was broken. This is NOT "not found" — reporting it as such
    // would tell the user an element is missing when in fact the model never
    // answered the question.
    return ToolResult.fail(
        '视觉模型没有按约定返回坐标。它说：${r.reason ?? "（无内容）"}');
  }
  if (!r.found) {
    return ToolResult.ok('没找到「$target」。模型说：${r.reason ?? "（未说明）"}',
        metadata: {'found': false});
  }
  if (!r.hasCoordinates) {
    return ToolResult.fail('视觉模型没给出坐标：${r.reason ?? "（未说明）"}');
  }

  final px = m.normToPixelsX(r.normX!);
  final py = m.normToPixelsY(r.normY!);
  final clamped = m.clampPixels(px, py);
  final meta = r.toJson()
    ..addAll({
      'px': clamped.x,
      'py': clamped.y,
      'img_w': m.imgW,
      'img_h': m.imgH,
      'screen_w': m.gestureW,
      'screen_h': m.gestureH,
    });

  final what = r.what == null ? '' : '模型描述：${r.what}。';
  final over = r.clamped ? '注意：模型给的坐标越界，已钳到屏幕边缘。' : '';
  return ToolResult.ok(
    '「$target」在归一化坐标 (${r.normX!.round()}, ${r.normY!.round()})，'
    '对应屏幕像素 (${clamped.x}, ${clamped.y})。$what$over',
    metadata: meta,
  );
}

/// Locate and tap in one step.
///
/// ONE STEP RATHER THAN TWO TOOL CALLS, and the reason is not round trips. Two
/// calls mean two screenshots, and between them the screen can move — a
/// keyboard sliding up, an animation finishing. The second screenshot's
/// coordinates describe a screen that no longer exists by the time the tap
/// lands. Doing it in one call means the coordinate and the tap refer to the
/// same image.
Future<ToolResult> _locateAndTap(String target) async {
  if (target.trim().isEmpty) {
    return ToolResult.fail('请说清楚要点什么，例如"搜索框"');
  }

  final cfg = await AppConfig.loadEffective();
  if (!cfg.hasVisionConfig) {
    return ToolResult.fail(_notConfiguredMessage());
  }

  final shot = await _shoot();
  if (shot.problem != null) return ToolResult.fail(shot.problem!);

  final m = shot.metrics;
  if (!m.usable) {
    return ToolResult.fail(m.whyUnusable ?? '屏幕几何不可用');
  }

  final call = await _askVision(cfg, shot.base64, m.imgW, m.imgH, target);
  final LocateResponse r;
  switch (call) {
    case VisionCallFailed(:final message):
      return ToolResult.fail(message);
    case VisionCallParsed(:final response):
      r = response;
  }

  if (r.unparsable) {
    return ToolResult.fail(
        '视觉模型没有按约定返回坐标，没有点击。它说：${r.reason ?? "（无内容）"}');
  }
  if (!r.found || !r.hasCoordinates) {
    // Refusing to tap is the whole point of these branches. A fallback tap at
    // the centre of the screen would be an action taken on a guess, and the
    // user would have no way to know it was a guess.
    final why = r.reason == null ? '' : '模型说：${r.reason}';
    return ToolResult.fail('没找到「$target」，没有点击。$why');
  }

  final px = m.normToPixelsX(r.normX!);
  final py = m.normToPixelsY(r.normY!);
  final clamped = m.clampPixels(px, py);

  final ok = await DeviceControl.a11yTap(clamped.x, clamped.y);
  if (!ok) {
    return ToolResult.fail(
        '已定位到 (${clamped.x}, ${clamped.y}) 但点击失败。可能是无障碍服务被系统冻结了');
  }

  return ToolResult.ok('已点击「$target」(${clamped.x}, ${clamped.y})',
      metadata: r.toJson()
        ..addAll({
          'px': clamped.x,
          'py': clamped.y,
          'img_w': m.imgW,
          'img_h': m.imgH,
        }));
}

/// The prompt sent with the screenshot.
///
/// WHY THE IMAGE SIZE IS IN THE PROMPT. A model shown an image and asked for
/// 0-1000 will sometimes answer in the image's own pixels instead — it can see
/// the resolution, and "where is the button" has an obvious pixel answer. So
/// the prompt names the size and states the space explicitly, which does not
/// eliminate the confusion but makes the parser's [CoordSpace] bookkeeping
/// load-bearing rather than decorative.
String _prompt(String target, int imgW, int imgH) => '''
在这张手机截图上找到「$target」。

图片尺寸是 $imgW x $imgH 像素，但**不要**用图片像素回答。

只回复一个 JSON 对象，不要有任何其他文字、不要用代码块围栏：
{"x":0-1000,"y":0-1000,"found":true,"what":"你看到的东西"}

规则：
- x 是水平位置，从左到右 0 到 1000；y 是垂直位置，从上到下 0 到 1000。两者都必须是整数。
- found 为 false 时不要给 x/y，改用 reason 字段说明为什么找不到。
- 找不到就明说。猜一个位置比说找不到糟糕得多。
- what 用你实际看到的内容描述，不要复述我的问题。
''';

/// Send one vision request.
Future<VisionCall> _askVision(
  AppConfigData cfg,
  String base64Image,
  int imgW,
  int imgH,
  String target,
) async {
  final dio = Dio(BaseOptions(
    connectTimeout: const Duration(seconds: 15),
    receiveTimeout: const Duration(minutes: 2),
  ));

  try {
    final resp = await dio.post(
      '${cfg.visionBaseUrl}/chat/completions',
      data: {
        'model': cfg.visionModel,
        'messages': [
          {
            'role': 'user',
            'content': [
              {'type': 'text', 'text': _prompt(target, imgW, imgH)},
              {
                'type': 'image_url',
                'image_url': {'url': 'data:image/jpeg;base64,$base64Image'},
              },
            ],
          },
        ],
        // Enough for one JSON object plus a sentence of reasoning. Capped
        // because a local 4B model with no cap will happily ramble for
        // minutes, and the caller is waiting on a coordinate.
        'max_tokens': 512,
        'temperature': 0,
      },
      options: Options(
        headers: {
          'Authorization': 'Bearer ${cfg.effectiveVisionKey}',
          'Content-Type': 'application/json',
        },
      ),
    );

    final content = resp.data is Map
        ? (resp.data['choices']?[0]?['message']?['content'] ?? '')
        : '';
    if (content is! String || content.trim().isEmpty) {
      return VisionCallFailed('视觉模型返回了空内容（模型：${cfg.visionModel}）');
    }
    return VisionCallParsed(
        LocateResponseParser.parse(content, imgW: imgW, imgH: imgH));
  } on DioException catch (e) {
    final status = e.response?.statusCode;
    final hint = switch (status) {
      404 => '（404：地址不对。Ollama 的 OpenAI 兼容端点是 /v1/chat/completions，'
          '确认填的是 http://<主机>:11434/v1 这种带 /v1 的形式）',
      401 || 403 => '（$status：密钥不对或被拒）',
      _ => e.type == DioExceptionType.connectionError ||
              e.type == DioExceptionType.connectionTimeout
          ? '（连不上：确认 Ollama 真的在跑，且端口对。'
              '本机默认是 $kDefaultOllamaVisionBaseUrl）'
          : '',
    };
    return VisionCallFailed(
        '视觉模型请求失败${status == null ? "" : " (HTTP $status)"}：${e.message}$hint');
  } catch (e) {
    return VisionCallFailed('视觉模型调用出错：$e');
  }
}

/// What to say when no vision model is configured.
///
/// Deliberately not "请在设置中填写". The user who hits this has no idea what
/// a vision base URL is, and the fix involves a model server — so the message
/// says what is missing, why it is needed, and the shortest path to it.
/// `analyze_screen` has said "请在设置中填写" for a while, which is why it has
/// never once worked on this device.
///
/// The PC route comes first for the same reason the settings page leads with
/// it: measured 2026-10-27, `adb reverse` puts the PC's Ollama on the phone's
/// own loopback, so it costs a Windows install and a USB cable instead of a
/// proot distro and a model pull on the phone.
///
/// The URL is interpolated from [kDefaultOllamaVisionBaseUrl] rather than
/// written out, because a guidance string that pins its own copy of the
/// default is the same drift the constant exists to prevent — and this one
/// would be shown to the user, so it would be believed.
String _notConfiguredMessage() =>
    '没有配置视觉模型。这一步需要一个能看图的模型，两条路：\n'
    'A. 模型跑在 PC 上、手机蹭用（手机上零安装）——PC 装好 Ollama 后跑一次 '
    'setup-phone-vision.ps1，它会把 PC 的端口映到手机回环上；\n'
    'B. 模型跑在手机本地——Termux 里装 Ollama。\n'
    '两条路的 Base URL 都是 $kDefaultOllamaVisionBaseUrl、模型名 '
    '$kDefaultVisionModel、API Key 留空。\n'
    '也可以填任何一个你已有密钥的云端多模态端点（那样截图会发去对方服务器）。';
