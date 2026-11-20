// khy-canary: Khy-20261101-069-BTPTFW0P
import 'package:dio/dio.dart';
import '../config/built_in_keys.dart';
import '../gateway/zen_gate.dart';
import '../gateway/zen_models.dart';

/// 模型信息
class ModelInfo {
  final String id;
  final String name;
  final String provider;

  const ModelInfo({
    required this.id,
    required this.name,
    required this.provider,
  });

  factory ModelInfo.fromJson(Map<String, dynamic> json, String provider) {
    final id = json['id']?.toString() ?? '';
    final name = json['name']?.toString() ?? id;
    return ModelInfo(id: id, name: name, provider: provider);
  }
}

/// 模型注册表：从各 provider 获取可用模型列表
class ModelRegistry {
  static final Dio _dio = Dio(BaseOptions(
    connectTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 15),
  ));

  /// 从指定 provider 获取模型列表
  static Future<List<ModelInfo>> fetchModels(String baseUrl, String apiKey) async {
    try {
      final resp = await _dio.get(
        '$baseUrl/models',
        options: Options(
          // Zen 免费档连 /models 都按客户端指纹判；只发 Authorization
          // 在手机上会得到 403，看起来像 key 无效。
          headers: await ZenGate.requestHeaders(
            baseUrl: baseUrl,
            apiKey: apiKey,
          ),
        ),
      );
      final data = resp.data as Map<String, dynamic>;
      final models = data['data'] as List?;
      if (models == null) return [];
      
      final parsed = models
          .map((m) => ModelInfo.fromJson(m as Map<String, dynamic>, baseUrl))
          .toList();
      // Zen 端点只该露出免费档：付费 id 选中就 401，已下线的选中就 410，
      // 而用户看不出区别。远端目录与随包清单走同一条过滤规则。
      if (!ZenGate.isZenEndpoint(baseUrl)) return parsed;
      final kept = (await ZenModelCatalog.filterFree(
              parsed.map((m) => m.id).toList()))
          .map((id) => id.toLowerCase())
          .toSet();
      return parsed.where((m) => kept.contains(m.id.toLowerCase())).toList();
    } catch (e) {
      return [];
    }
  }

  /// 从所有内置 provider 获取模型列表
  static Future<Map<String, List<ModelInfo>>> fetchAllModels() async {
    final result = <String, List<ModelInfo>>{};
    
    for (final entry in BuiltInKeys.providers.entries) {
      final provider = entry.key;
      final p = entry.value;
      // canSend 而不是 hasKey：免费档（bearer=public）没有账号密钥，但发得出去。
      // 用 hasKey 过滤会让这类通道永远拿不到远端目录，只能等发版。
      if (!p.canSend) continue;
      
      final models = await fetchModels(p.baseUrl, p.apiKey);
      if (models.isNotEmpty) {
        result[provider] = models;
      }
    }
    
    return result;
  }

  /// 获取 provider 的默认模型列表（离线）
  static List<ModelInfo> getDefaultModels(String providerName) {
    final p = BuiltInKeys.get(providerName);
    if (p == null) return [];
    final ids = ZenGate.isZenEndpoint(p.baseUrl)
        ? ZenModelCatalog.filterFreeStatic(p.models)
        : p.models;
    return ids.map((id) => ModelInfo(
      id: id,
      name: id,
      provider: providerName,
    )).toList();
  }

  /// 获取所有 provider 及其默认模型
  static Map<String, List<ModelInfo>> getAllDefaultModels() {
    final result = <String, List<ModelInfo>>{};
    for (final entry in BuiltInKeys.providers.entries) {
      result[entry.key] = getDefaultModels(entry.key);
    }
    return result;
  }

  /// 验证模型是否存在于 provider 中
  static bool isModelValidForProvider(String baseUrl, String modelId) {
    if (baseUrl.isEmpty) return false;
    for (final p in BuiltInKeys.providers.values) {
      // 跳过端点未配置的项：它们的 baseUrl 是空串，而调用方也可能传来空串
      // （新对话还没挑目录、配置还没保存），那一匹配就会对着一个并不存在的
      // 端点返回「模型有效」。
      if (!p.endpointConfigured) continue;
      if (p.baseUrl == baseUrl) {
        return p.models.contains(modelId);
      }
    }
    return false;
  }

  /// 获取模型的显示名称
  static String getModelDisplayName(String provider, String modelId) {
    // 清理模型名：去掉前缀，保留最后部分
    final parts = modelId.split('/');
    final shortName = parts.last;
    return shortName;
  }
}
