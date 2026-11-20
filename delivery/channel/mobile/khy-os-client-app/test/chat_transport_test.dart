import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/ui/screens/chat_screen_new.dart';

/// 发送路径的选择：远程模式下的 Zen 免费模型必须由手机直连。
///
/// 为什么守这一条而不是"手机 baseUrl 是不是 Zen"：远程分支的模型由电脑挑
/// （khyos_api 只发 question/history/sessionId），手机看不到电脑会用哪个模型。
/// 能承诺的只有"我自己选中的 Zen 免费模型不发给电脑"——那台设备用那台设备的
/// 指纹和 IP。
void main() {
  group('resolveSendMode', () {
    test('远程 + Zen 免费模型 → 手机直连', () {
      expect(resolveSendMode(remote: true, model: 'mimo-v2.6-flash-free'),
          ZenSendMode.standalone);
      // 例外集里的 id 也算免费档（无 -free 后缀但上游实测开放）。
      expect(resolveSendMode(remote: true, model: 'big-pickle'),
          ZenSendMode.standalone);
    });

    test('远程 + 非 Zen 模型 → 仍走电脑', () {
      expect(resolveSendMode(remote: true, model: 'claude-sonnet-4-5'),
          ZenSendMode.remote);
      expect(resolveSendMode(remote: true, model: ''),
          ZenSendMode.remote);
    });

    test('独立模式 → 恒直连', () {
      expect(resolveSendMode(remote: false, model: 'claude-sonnet-4-5'),
          ZenSendMode.standalone);
      expect(resolveSendMode(remote: false, model: 'mimo-v2.6-flash-free'),
          ZenSendMode.standalone);
      expect(resolveSendMode(remote: false, model: null),
          ZenSendMode.standalone);
    });

    test('配置还没读回（model=null）→ 远程不触发守卫', () {
      // 此时 _cfg 是 null，任何 `_cfg!` 都会崩；守卫必须让路。
      expect(resolveSendMode(remote: true, model: null), ZenSendMode.remote);
    });
  });
}
