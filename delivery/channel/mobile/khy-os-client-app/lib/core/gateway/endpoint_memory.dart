/// 端点记忆：记住**多个**连通过的地址，而不是一个。
///
/// 为什么不是一个：这台开发机上 PC 的局域网 IP 会在 192.168.1.x ↔ 192.168.2.x
/// 之间来回跳（DHCP 租约换网段就变），只记一个地址意味着 IP 一变，自动连接
/// 就必然失败，用户只好重新查 IP 手输——那正是「装好即连」要消灭的动作。
/// 记住一小串、启动时依次快探，IP 换回去不用人管。
///
/// 纯函数（零 IO）：能离线断言，App 侧只负责读写与探测。
library;

class EndpointMemory {
  /// 记多少个地址。5 个够覆盖「网段来回跳 + 偶尔换端口」，再多只是让启动
  /// 时的探测变慢。
  static const int maxEntries = 5;

  /// 把一次成功的地址并进记忆：新的排最前，重复的只保留位置最靠前的那份，
  /// 超过上限丢最旧的。
  static List<String> merge(List<String> remembered, String address) {
    final trimmed = address.trim();
    if (trimmed.isEmpty) {
      return _dedupe(remembered);
    }
    final rest = remembered.where((a) => a.trim() != trimmed).toList();
    return _dedupe([trimmed, ...rest]).take(maxEntries).toList();
  }

  /// 记忆的取值顺序：最近用过的在前，去重、丢掉空串。
  static List<String> ordered(List<String> remembered) => _dedupe(remembered);

  /// 从一段原始存储（可能是 JSON 数组，也可能是逗号分隔的老格式）里读出地址列表。
  /// 读不出来就当空——宁可从零开始，也不要拿一个半截地址去连。
  static List<String> parse(String? raw) {
    if (raw == null || raw.trim().isEmpty) {
      return const [];
    }
    final text = raw.trim();
    if (text.startsWith('[')) {
      try {
        final decoded = _decodeJsonList(text);
        return _dedupe(decoded);
      } catch (_) {
        return const [];
      }
    }
    return _dedupe(text.split(','));
  }

  /// 存回去的样子：JSON 数组（老格式读时也认）。
  static String serialize(List<String> remembered) =>
      '[${ordered(remembered).map(_quote).join(',')}]';

  static List<String> _decodeJsonList(String text) {
    // 不引 dart:convert 的完整 JSON 解析器：这里只需要一个字符串数组，
    // 自己解比拉依赖更省，也免得解析器对异常输入抛栈。
    final out = <String>[];
    final re = RegExp(r'"((?:[^"\\]|\\.)*)"');
    for (final m in re.allMatches(text)) {
      final raw = m.group(1) ?? '';
      out.add(raw.replaceAll(r'\"', '"').replaceAll(r'\\', r'\').trim());
    }
    return out;
  }

  static String _quote(String value) =>
      '"${value.replaceAll(r'\', r'\\').replaceAll('"', r'\"')}"';

  static List<String> _dedupe(List<String> input) {
    final seen = <String>{};
    final out = <String>[];
    for (final item in input) {
      final v = item.trim();
      if (v.isEmpty || !seen.add(v)) continue;
      out.add(v);
    }
    return out;
  }
}
