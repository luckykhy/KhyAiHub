import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/app_config.dart';
import 'package:khy_os_client/core/config/endpoint_defaults.dart';
import 'package:khy_os_client/core/gateway/provider_adapter.dart';

/// 第三方默认端点的单一真源。
///
/// 守的是「两处消费方用同一个值」。适配器的默认 baseUrl 和「独立模式」页那个
/// Ollama 快捷 chip 曾经各写一份字面量——改一处另一处不跟着变，而用户的请求
/// 会静默发去一个他没选的地方，没有任何报错。编译器保证不了这件事：两边都写
/// `'http://localhost:11434'` 是完全合法的代码。
void main() {
  group('endpoint_defaults', () {
    test('Ollama 默认端点是 Ollama 文档写明的 11434', () {
      // 端口来源：Ollama 未设 OLLAMA_HOST 时的默认值。写在这里是为了下一个
      // 读代码的人不必去猜这个数字是哪来的。
      expect(kDefaultOllamaBaseUrl, 'http://localhost:11434');
      expect(kDefaultOllamaModel, 'llama3.2');
    });
  });

  group('consumers agree', () {
    test('OllamaAdapter 的默认 baseUrl 就是真源常量', () {
      // 不传 baseUrl 构造，拿到的必须是 kDefaultOllamaBaseUrl 本身。
      final a = OllamaAdapter(id: 'x', name: 'X');
      expect(a.baseUrl, kDefaultOllamaBaseUrl);
      expect(a.model, kDefaultOllamaModel);
    });

    test('显式传入时不被默认值覆盖', () {
      // 默认值只是默认：用户自建实例改了端口必须能盖过去。
      final a = OllamaAdapter(
        id: 'x',
        name: 'X',
        baseUrl: 'http://localhost:9999',
        model: 'qwen3',
      );
      expect(a.baseUrl, 'http://localhost:9999');
      expect(a.model, 'qwen3');
    });
  });

  // ── 视觉端点的默认值 ──
  //
  // 这一组守的是「组合而不是抄」。视觉端点是从裸 Ollama 端口拼出来的，
  // 拼错一次的症状是用户的截图静默发去了别处——没有报错，因为请求本身
  // 是合法的，只是去错了地方。

  group('vision endpoint defaults', () {
    test('视觉默认端点是裸 Ollama 端口加上 OpenAI 兼容后缀', () {
      // 两个常量都必须来自同一个源。写成两个字面量时，改端口的人不会知道
      // 还有第二处要改，而两边不一致没有任何症状。
      expect(kDefaultOllamaVisionBaseUrl, '$kDefaultOllamaBaseUrl/v1');
      expect(kDefaultOllamaVisionBaseUrl, kDefaultOllamaBaseUrl + kOpenAiCompatSuffix);
      expect(kOpenAiCompatSuffix, '/v1');
    });

    test('默认视觉模型名是本地能跑的那个量级', () {
      // 4B 是这台设备（15.6GB / 8 核 / arm64）上实测可行的档位，Q4 约 2.6GB。
      // 写死一个 70B 的名字会让默认配置在真机上必然失败，而失败信息是
      // 「连不上」而不是「模型太大」——诊断方向整个错掉。
      expect(kDefaultVisionModel, 'gelab-zero-4b');
      expect(kDefaultVisionModel, isNotEmpty);
    });

    test('默认视觉端点确实是回环地址', () {
      // 视觉模型读的是屏幕，屏幕上可能是验证码、聊天、账号页。默认值落在
      // 回环是这里唯一负隐私责任的判断，所以它自己也要被测。
      //
      // 用 AppConfigData.visionIsLocal 来判而不是在这里重写一遍前缀规则：
      // 同一个判断写两处，两处迟早说成两种话，而这个判断错了的方向正是
      // 「用户的截屏被发去外部主机而 App 以为没有」。
      final cfg = AppConfigData(
        baseUrl: '',
        apiKey: '',
        model: 'm',
        visionBaseUrl: kDefaultOllamaVisionBaseUrl,
      );
      expect(cfg.visionIsLocal, true,
          reason: '默认视觉端点不是回环：$kDefaultOllamaVisionBaseUrl');
    });

    test('默认视觉端点不发 key', () {
      // 同一件事的另一半：默认配置下有效 vision key 必须是空。配了主 key 的
      // 用户一旦填上这个默认端点，不应该顺带把主 key 也发到回环去。
      final cfg = AppConfigData(
        baseUrl: 'https://x.com',
        apiKey: 'main-key',
        model: 'm',
        visionBaseUrl: kDefaultOllamaVisionBaseUrl,
        visionModel: kDefaultVisionModel,
      );
      expect(cfg.effectiveVisionKey, '');
    });

    test('默认视觉端点配默认模型就构成完整视觉配置', () {
      // 这是「开箱能跑」的断言：用户只填这两个默认值，hasVisionConfig 就为真。
      // 少这一条的话，任何一端拼错都表现为 analyze_screen 报「未配置」，
      // 而用户明明照默认值填了。
      final cfg = AppConfigData(
        baseUrl: 'https://x.com',
        apiKey: 'k',
        model: 'm',
        visionBaseUrl: kDefaultOllamaVisionBaseUrl,
        visionModel: kDefaultVisionModel,
      );
      expect(cfg.hasVisionConfig, true);
    });
  });

  // ── Rule 1 的 Dart 侧哨兵 ──
  //
  // scripts/ci/check-agent-rules.js 的 HARD_ENDPOINT_PATTERNS 会抓
  // localhost / 127.0.0.1 字面量，但那个守卫整行豁免注释，而且只在 CI 跑。
  // 这里在同一个仓里用测试再钉一次，改代码的人当场就能看见，不必等 CI。

  group('lib/ 下没有别处钉住回环端点', () {
    test('http://localhost 只出现在 endpoint_defaults.dart', () {
      final libDir = Directory('lib');
      expect(libDir.existsSync(), true,
          reason: '这条测试必须从 App 目录跑；cwd 不对时它会静默通过');

      final offenders = <String>[];
      for (final entity in libDir.listSync(recursive: true)) {
        if (entity is! File) continue;
        if (!entity.path.endsWith('.dart')) continue;
        // 真源文件自己是既定的豁免对象（check-agent-rules.js 同样豁免它）。
        if (entity.path.replaceAll('\\', '/').endsWith('lib/core/config/endpoint_defaults.dart')) {
          continue;
        }
        final lines = entity.readAsLinesSync();
        for (var i = 0; i < lines.length; i++) {
          final line = lines[i];
          // 与 check-agent-rules.js 的整行豁免保持一致：注释行不算。
          if (RegExp(r'^\s*(//|/\*|\*|#)').hasMatch(line.trim())) continue;
          if (line.contains('http://localhost') || line.contains('http://127.0.0.1')) {
            offenders.add('${entity.path}:${i + 1}: $line');
          }
        }
      }
      expect(offenders, isEmpty,
          reason: '回环端点只允许出现在 endpoint_defaults.dart；'
              '别处要引用常量，不要写字面量。违规：\n${offenders.join('\n')}');
    });
  });
}
