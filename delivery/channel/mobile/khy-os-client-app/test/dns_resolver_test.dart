// `extractHostname` 的判据测试。
//
// 背景：这个函数活在 `longcat_chat_screen._sendWithIpDirect` 里——
// 从用户配的 baseUrl 取主机名，再拿它做 DNS 解析走 IP 直连。
// 取错的结果不是崩，是下游解析失败后提示「无法获取服务器 IP，请检查网络」：
// **指错了方向**，真正的原因是地址没带协议。
//
// 而它此前零覆盖，且原实现有个基本不可达的分支（见下）。
//
// 钉四件事：
//   1. 带 scheme 的正常 URL 取出主机名；
//   2. **不带 scheme 的输入也要能取出主机名**（原实现在这条上返回空串）；
//   3. 带端口、带路径、带查询串都只取主机名；
//   4. 空串与纯路径不崩。

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/network/dns_resolver.dart';

void main() {
  group('带 scheme 的正常 URL', () {
    test('https + 路径', () {
      expect(extractHostname('https://api.example.com/v1/chat'), 'api.example.com');
    });

    test('http', () {
      expect(extractHostname('http://api.example.com'), 'api.example.com');
    });

    test('带端口', () {
      expect(extractHostname('https://api.example.com:8443/v1'), 'api.example.com');
    });

    test('带查询串', () {
      expect(extractHostname('https://api.example.com/v1?key=abc'), 'api.example.com');
    });

    test('带用户信息', () {
      expect(extractHostname('https://user:pw@api.example.com/v1'), 'api.example.com');
    });
  });

  group('不带 scheme 的输入（原实现在这里返回空串）', () {
    test('裸域名', () {
      // 用户在设置里把 baseUrl 填成 api.example.com 是常见事。
      // Uri.parse 不抛（它把输入当成只有 path 的 URI），uri.host 是 ''——
      // 原实现只在这种情况下才走 catch 里的手工提取，而 catch 进不去。
      expect(extractHostname('api.example.com'), 'api.example.com');
    });

    test('裸域名 + 路径', () {
      expect(extractHostname('api.example.com/v1/chat'), 'api.example.com');
    });

    test('裸域名 + 端口', () {
      expect(extractHostname('api.example.com:8080'), 'api.example.com');
    });

    test('协议相对 URL', () {
      expect(extractHostname('//api.example.com/v1'), 'api.example.com');
    });
  });

  group('边界', () {
    test('空串不崩', () {
      expect(extractHostname(''), '');
    });

    test('只有路径时不返回路径本身', () {
      // '/v1/chat' 没有主机名，取出来不该是 '/v1/chat'。
      final host = extractHostname('/v1/chat');
      expect(host, isNot(contains('/')));
    });

    test('总是返回小写形式（两条路径同一种答案）', () {
      // Dart 的 Uri 会把 host 小写化；手工提取那条路原来不化。
      // 统一小写，调用方才不会因为「带不带 scheme」拿到两种形式。
      // DNS 对大小写不敏感，所以小写化不丢信息。
      expect(extractHostname('https://API.Example.COM/v1'), 'api.example.com');
      expect(extractHostname('API.Example.COM'), 'api.example.com');
      expect(extractHostname('API.Example.COM:8080/x'), 'api.example.com');
    });
  });
}
