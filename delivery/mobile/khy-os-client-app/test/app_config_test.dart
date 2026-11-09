import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/app_config.dart';
import 'package:khy_os_client/core/config/built_in_keys.dart';

void main() {
  group('AppConfigData', () {
    test('hasUserKey', () {
      final c = AppConfigData(baseUrl: 'https://x.com', apiKey: 'sk-123', model: 'gpt-4');
      expect(c.hasUserKey, true);

      final empty = AppConfigData(baseUrl: 'https://x.com', apiKey: '', model: 'gpt-4');
      expect(empty.hasUserKey, false);
    });

    test('isConfigured requires baseUrl AND effectiveApiKey', () {
      final c = AppConfigData(baseUrl: '', apiKey: '', model: 'gpt-4');
      expect(c.isConfigured, false);

      final ok = AppConfigData(baseUrl: 'https://x.com', apiKey: 'sk-123', model: 'gpt-4');
      expect(ok.isConfigured, true);
    });

    test('effectiveApiKey uses user key when present', () {
      final c = AppConfigData(baseUrl: 'https://unknown.com', apiKey: 'user-key', model: 'm');
      expect(c.effectiveApiKey, 'user-key');
    });

    test('effectiveApiKey falls back to builtin for known baseUrl', () {
      // Use a known builtin provider URL
      final providers = BuiltInKeys.providers;
      expect(providers, isNotEmpty);

      BuiltInProvider? firstWithKey; try { firstWithKey = providers.values.firstWhere((p) => p.hasKey); } catch (_) {}
      if (firstWithKey != null) {
        final c = AppConfigData(baseUrl: firstWithKey.baseUrl, apiKey: '', model: 'm');
        expect(c.hasBuiltInKey, true);
        expect(c.effectiveApiKey, isNotEmpty);
        expect(c.usingBuiltInKey, true);
      }
    });

    test('maskedApiKey shows first8...last4 for long keys', () {
      final c = AppConfigData(baseUrl: 'https://x.com', apiKey: 'sk-examplekey12345', model: 'm');
      final masked = c.maskedApiKey;
      expect(masked, contains('...'));
      expect(masked.length, lessThan('sk-examplekey12345'.length));
    });

    test('maskedApiKey short key unchanged', () {
      final c = AppConfigData(baseUrl: 'https://x.com', apiKey: 'short', model: 'm');
      expect(c.maskedApiKey, 'short');
    });

    test('maskedApiKey empty when no user key', () {
      final c = AppConfigData(baseUrl: 'https://x.com', apiKey: '', model: 'm');
      expect(c.maskedApiKey, '');
    });

    test('hasVisionConfig', () {
      final no = AppConfigData(baseUrl: 'https://x.com', apiKey: 'k', model: 'm');
      expect(no.hasVisionConfig, false);

      final yes = AppConfigData(
        baseUrl: 'https://x.com', apiKey: 'k', model: 'm',
        visionBaseUrl: 'https://vision.com', visionApiKey: 'vk', visionModel: 'gpt-4o',
      );
      expect(yes.hasVisionConfig, true);
    });

    test('effectiveVisionKey falls back to main key', () {
      final c = AppConfigData(
        baseUrl: 'https://x.com', apiKey: 'main-key', model: 'm',
        visionBaseUrl: 'https://vision.com', visionModel: 'gpt-4o',
      );
      expect(c.effectiveVisionKey, 'main-key');

      final withVisionKey = AppConfigData(
        baseUrl: 'https://x.com', apiKey: 'main-key', model: 'm',
        visionBaseUrl: 'https://vision.com', visionApiKey: 'vision-key', visionModel: 'gpt-4o',
      );
      expect(withVisionKey.effectiveVisionKey, 'vision-key');
    });

    // ── visionIsLocal：隐私闸门的分类器 ──
    //
    // 这一组不是"配置解析"，是红线守卫。effectiveVisionKey 上面的回退逻辑
    // 和 P2 后台同步的启动闸门都读这一个 getter，所以它认错一个地址的后果
    // 不是显示错误，是用户的微信截屏被发去一个他们没同意的地方。

    test('visionIsLocal 认本机回环，且只认回环', () {
      for (final url in const [
        'http://localhost:11434/v1',
        'http://localhost',
        'http://127.0.0.1:11434/v1',
        'http://127.0.0.1',
        'http://[::1]:11434/v1',
        'http://user@localhost:11434/v1', // userinfo 不改变连到哪台机器
      ]) {
        expect(AppConfigData(baseUrl: '', apiKey: '', model: 'm', visionBaseUrl: url).visionIsLocal,
            true,
            reason: '$url 是本机回环，必须算本地');
      }

      for (final url in const [
        'https://api.openai.com/v1',
        'http://192.168.2.46:11434/v1',      // 局域网是别处，不是本机
        'http://10.0.0.5:11434/v1',
        'http://localhost.example.com/v1',   // 前缀像回环，主机不是
        'http://localhostx/v1',
        'http://evil.com/?x=localhost',
        'not a url at all',
        '',
      ]) {
        expect(AppConfigData(baseUrl: '', apiKey: '', model: 'm', visionBaseUrl: url).visionIsLocal,
            false,
            reason: '$url 不是本机回环，绝不能算本地');
      }
    });

    test('https 上的 localhost 仍是本机', () {
      // scheme 不改变"连到哪台机器"这个答案。TLS 到回环在实际部署里存在
      // （自签证书的本地代理），把它判成远程会让同步无谓地拒绝启动。
      final c = AppConfigData(
        baseUrl: '', apiKey: '', model: 'm',
        visionBaseUrl: 'https://localhost:11434/v1',
      );
      expect(c.visionIsLocal, true);
    });

    test('前缀匹配会被 localhost.example.com 骗过，所以必须按主机判', () {
      // 这一条单独存在，是因为 startsWith('http://localhost') 是这里最容易
      // 被写出来、也最危险的实现：它把别人的机器算成本机。方向很关键——
      // 误判成本地只是同步不启动（安全），误判成远程会让用户的微信截屏
      // 发去外部主机，而 App 每一处都以为它没出设备。
      const spoofed = 'http://localhost.example.com/v1';
      expect(spoofed.startsWith('http://localhost'), true,
          reason: '前提：朴素前缀实现确实会中招');
      expect(
          AppConfigData(baseUrl: '', apiKey: '', model: 'm', visionBaseUrl: spoofed).visionIsLocal,
          false);
    });

    test('本地视觉端点不发送任何 key，包括回退的主 key', () {
      // 把真凭证发到回环地址是无谓的暴露：能读到它的只有已经拿到这台设备的
      // 人，而 Ollama 根本不看这个头。所以本地不是"用主 key 顶着"，是空。
      final c = AppConfigData(
        baseUrl: 'https://x.com', apiKey: 'main-key', model: 'm',
        visionBaseUrl: 'http://localhost:11434/v1', visionModel: 'gelab-zero-4b',
      );
      expect(c.visionIsLocal, true);
      expect(c.effectiveVisionKey, '');
    });

    test('本地端点配上用户自己填的 visionApiKey 时仍然用那个', () {
      // 上一条只针对"没填 vision key"的情形。用户显式填了就不该被吞掉——
      // 有些代理型端点既要回环又要鉴权，替用户清空会让他连不上且不知道为什么。
      final c = AppConfigData(
        baseUrl: 'https://x.com', apiKey: 'main-key', model: 'm',
        visionBaseUrl: 'http://localhost:11434/v1',
        visionApiKey: 'vision-key',
        visionModel: 'gelab-zero-4b',
      );
      expect(c.effectiveVisionKey, 'vision-key');
    });

    test('空 visionBaseUrl 不算本地', () {
      // 未配置时必须走"未配置"那条路，不能被误判成本地然后放行。
      final c = AppConfigData(baseUrl: 'https://x.com', apiKey: 'k', model: 'm');
      expect(c.visionIsLocal, false);
      expect(c.hasVisionConfig, false);
    });

    test('toJson / fromJson round-trip', () {
      final original = AppConfigData(
        baseUrl: 'https://api.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        systemPrompt: 'be nice',
        visionBaseUrl: 'https://vision.com',
        visionApiKey: 'vk',
        visionModel: 'gpt-4o-vision',
      );
      final restored = AppConfigData.fromJson(original.toJson());
      expect(restored.baseUrl, original.baseUrl);
      expect(restored.apiKey, original.apiKey);
      expect(restored.model, original.model);
      expect(restored.systemPrompt, original.systemPrompt);
      expect(restored.visionBaseUrl, original.visionBaseUrl);
      expect(restored.visionApiKey, original.visionApiKey);
      expect(restored.visionModel, original.visionModel);
    });

    test('copyWith preserves unchanged fields', () {
      final original = AppConfigData(baseUrl: 'https://a.com', apiKey: 'key', model: 'm');
      final updated = original.copyWith(model: 'new-model');
      expect(updated.model, 'new-model');
      expect(updated.baseUrl, 'https://a.com');
      expect(updated.apiKey, 'key');
    });
  });

  group('BuiltInKeys', () {
    test('providers is non-empty', () {
      expect(BuiltInKeys.providers, isNotEmpty);
    });

    test('get returns provider by name or null', () {
      final names = BuiltInKeys.providers.keys.toList();
      final found = BuiltInKeys.get(names.first);
      expect(found, isNotNull);
      expect(found!.baseUrl, isNotEmpty);

      expect(BuiltInKeys.get('nonexistent-provider-xyz'), isNull);
    });

    test('matchBaseUrl exact match', () {
      final providers = BuiltInKeys.providers.values;
      final withKey = providers.where((p) => p.hasKey).firstOrNull;
      if (withKey != null) {
        expect(BuiltInKeys.matchBaseUrl(withKey.baseUrl), isA<String>());
      }
    });

    test('matchBaseUrl unknown URL returns null', () {
      expect(BuiltInKeys.matchBaseUrl('https://unknown-domain-xyz.com/v1'), isNull);
    });

    test('hasBuiltInKey true for known provider with key', () {
      final providers = BuiltInKeys.providers.values;
      final withKey = providers.where((p) => p.hasKey).firstOrNull;
      if (withKey != null) {
        expect(BuiltInKeys.hasBuiltInKey(withKey.baseUrl), true);
      }
    });

    test('hasBuiltInKey false for unknown URL', () {
      expect(BuiltInKeys.hasBuiltInKey('https://not-a-provider.com/v1'), false);
    });

    test('getBuiltInKey returns non-empty for known provider', () {
      final providers = BuiltInKeys.providers.values;
      final withKey = providers.where((p) => p.hasKey).firstOrNull;
      if (withKey != null) {
        final key = BuiltInKeys.getBuiltInKey(withKey.baseUrl);
        expect(key, isNotEmpty);
      }
    });

    test('getBuiltInKey returns empty for unknown URL', () {
      expect(BuiltInKeys.getBuiltInKey('https://unknown.com/v1'), '');
    });

    test('defaultProvider 是 agnes，且永远不返回 null', () async {
      // 用户明确要求"不要默认智谱，默认 agnes"。这里同时守住另一件事：
      // 这个 getter 以前写的是"返回第一个有内置 key 的"，而 R2 禁止明文 key
      // 进 bundle，所以那个循环永远不命中，实际悄悄返回注册表第一项。
      final def = BuiltInKeys.defaultProvider;
      expect(def.baseUrl, 'https://apihub.agnes-ai.com/v1');
      expect(def.defaultModel, isNotEmpty);
    });

    test('没有任何内置供应商携带明文 key（R2 守卫）', () {
      // 这不是"功能测试"，是红线守卫：一旦有人把真 key 硬编码进
      // built_in_keys.dart 并让 hasKey 变 true，这条会亮红。
      for (final entry in BuiltInKeys.providers.entries) {
        expect(entry.value.hasKey, false,
            reason: '${entry.key} 携带了内置 key，违反 R2（禁止明文 key 进 bundle）');
      }
    });

    test('没有用户 key 时 effective 不伪造 key', () {
      // 既然一个内置 key 都没有，effective 必须原样返回而不是编一个出来。
      const cfg = AppConfigData(
        baseUrl: 'https://unknown.example.com/v1',
        apiKey: '',
        model: 'm',
      );
      expect(cfg.effective.apiKey, '');
      expect(cfg.effective.baseUrl, 'https://unknown.example.com/v1');
    });
  });
}
