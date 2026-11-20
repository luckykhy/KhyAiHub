// khy-canary: Khy-20261101-077-P9ERGSGT
import 'package:dio/dio.dart';

/// DNS-over-HTTPS 解析器
/// 绕过运营商 DNS，使用 DoH 解析域名
class DnsOverHttps {
  final Dio _dio;
  
  // 多个 DoH 服务器，按优先级排列
  static const List<String> _dohServers = [
    'https://cloudflare-dns.com/dns-query',      // Cloudflare
    'https://dns.google/resolve',                 // Google
    'https://dns.alidns.com/dns-query',           // 阿里
    'https://doh.pub/dns-query',                  // 腾讯
  ];

  DnsOverHttps({Dio? dio}) : _dio = dio ?? Dio(BaseOptions(
    connectTimeout: const Duration(seconds: 5),
    receiveTimeout: const Duration(seconds: 5),
    headers: {'Accept': 'application/dns-json'},
  ));

  /// 解析域名获取 IP 地址
  Future<List<String>> resolve(String hostname) async {
    final errors = <String>[];
    
    for (final server in _dohServers) {
      try {
        final response = await _dio.get(
          server,
          queryParameters: {
            'name': hostname,
            'type': 'A',
          },
        );
        
        if (response.statusCode == 200 && response.data is Map) {
          final data = response.data as Map<String, dynamic>;
          final answers = data['Answer'] as List?;
          
          if (answers != null && answers.isNotEmpty) {
            final ips = answers
                .map((a) => a['data'] as String?)
                .where((ip) => ip != null)
                .cast<String>()
                .toList();
            if (ips.isNotEmpty) return ips;
          }
        }
      } catch (e) {
        errors.add('$server: $e');
      }
    }
    
    throw Exception('DoH 解析失败: ${errors.join('; ')}');
  }

  /// 解析并返回第一个可用 IP
  Future<String> resolveFirst(String hostname) async {
    final ips = await resolve(hostname);
    return ips.first;
  }
}

/// 从 URL 中提取主机名。**总是返回小写形式**（DNS 对大小写不敏感，两条路径
/// 给出同一种形式才不会让调用方拿到两种答案）。
///
/// **`uri.host` 为空时也要走一遍手工提取**，不是只有 parse 抛异常才走：
/// `Uri.parse` 极其宽容，对 `api.example.com` 这种**没带 scheme** 的输入
/// 也不抛——它把它当成只有 path 的 URI，于是 `uri.host` 是空串。原先手工
/// 提取只挂在 `catch` 里，那个分支基本不可达，结果是：用户把 baseUrl 填成
/// `api.example.com` 时这里返回 `''`，下游 `resolveBest('')` 失败，界面提示
/// 「无法获取服务器 IP，请检查网络」——**指错了方向**，真正的原因是地址
/// 没带协议。
String extractHostname(String url) {
  final parsed = Uri.tryParse(url)?.host ?? '';
  if (parsed.isNotEmpty) return parsed.toLowerCase();
  var host = url.replaceAll(RegExp(r'^https?://'), '');
  host = host.split('/').first;
  host = host.split(':').first;
  return host.toLowerCase();
}
