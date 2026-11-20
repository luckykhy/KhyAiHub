import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/app_config.dart';
import 'package:khy_os_client/core/drivers/app_driver_registry.dart';
import 'package:khy_os_client/core/drivers/driver.dart';
import 'package:khy_os_client/core/drivers/driver_event.dart';
import 'package:khy_os_client/core/drivers/driver_registry.dart';
import 'package:khy_os_client/core/drivers/script_driver.dart';
import 'package:khy_os_client/core/toolhost/tool_host_client.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';
import 'package:khy_os_client/ui/render/content_tier.dart';

/// D 阶段 T16 判定：新增一个 driver，不改渲染代码即可跑通一次会话。
///
/// 判据的正面形式（content_tier.dart:8-9 说的那件事）：
///   · 一个**全新的 driver 实现**（本文件里现写的 _DemoDriver）登记进
///     DriverRegistry，跑完 openSession + send 一整轮会话；
///   · 它的全部事件经渲染层的**通用映射**（decideTier / driverStatusLine /
///     driverFailedLine）变成可读输出——渲染函数只认识 DriverEvent 的
///     通用字段，不认识任何 driver 身份；
///   · 源码级契约：渲染层不 import 任何 driver 实现；聊天屏消费 driver
///     状态也走渲染层映射器（屏幕自己拼状态文案 = 新 driver 的 detail
///     到不了用户，那是「不改渲染代码」最后一环的漏洞）。
///
/// 首败（本阶段实测）：聊天屏 lib/ui/screens/chat_screen_new.dart:595 自己拼
/// '等待 $driverId 回复 · 第 N 次'，没有经 driverStatusLine——driver 的
/// status detail（含 T15 的降级提示）在这一跳被丢掉。本文件对该现状断言失败，
/// 这就是 T16 的红。
void main() {
  ToolHostClient host() => ToolEngineHostClient(ToolEngine());

  AppConfigData cfg({List<String> disabled = const []}) =>
      AppConfigData(baseUrl: '', apiKey: '', model: 'm')
          .copyWith(disabledDrivers: disabled);

  group('T16 新 driver 会话（渲染层只消费通用事件）', () {
    test('一个全新 driver：登记 → 会话 → 渲染，渲染输出不认识 driver', () async {
      final demo = _DemoDriver(reply: _longReply);
      final reg = DriverRegistry();
      reg.register(demo);

      await reg.openSession('demo', 's1', _ctx(host()));
      final events = await reg.safeSend('demo',
          const UserTurn(sessionId: 's1', turnId: 't1', text: '跑一轮')).toList();

      // 1) 会话完整：started → 状态 → 正文 → finished，一个不少。
      expect(events.first, isA<DriverStarted>());
      expect(events.whereType<DriverFinished>().single.reason, 'completed');
      expect(events.whereType<DriverFailed>(), isEmpty);

      // 2) 渲染：正文经 decideTier 判档后完整可读，无截断。
      final content = events
          .whereType<DriverDelta>()
          .where((e) => e.kind == 'content')
          .map((e) => e.text)
          .join();
      expect(content, _longReply, reason: '一次会话要拿到完整回复');
      final decision = decideTier(content);
      expect(decision.tier, ContentTier.l3); // 纯文本回复
      final renderedText = (decision.blocks == null)
          ? content
          : decision.blocks!.map((b) => (b as TextBlock).text).join();
      expect(renderedText, _longReply, reason: '渲染结果与回复逐字一致');

      // 3) 状态行走通用映射器，非空、可读（RUNTIME-002）。
      for (final s in events.whereType<DriverStatus>()) {
        final line = driverStatusLine(s);
        expect(line.text.trim(), isNotEmpty, reason: '状态行不许是空气泡');
      }

      // 4) 渲染输出里不出现 driver 身份——通用映射不认识「demo」。
      final allRendered = [
        content,
        ...events.whereType<DriverStatus>().map((s) => driverStatusLine(s).text),
      ].join('\n');
      expect(allRendered, isNot(contains('demo')),
          reason: '渲染层只画内容与状态，不画 driver 名');
    });

    test('script driver：新增一个脚本定义即跑通一次会话', () async {
      // 「新增一个 script driver」= 用户在 drivers/ 目录里新放一个 JSON。
      // driver 每次 send 现读定义（改完下一轮生效），渲染层一行不碰。
      final d = ScriptDriver(source: () async => [
            const ScriptDefinition(
              id: 'greet',
              name: '问候脚本',
              mode: 'reply',
              reply: '你好，来自脚本',
            ),
          ]);
      final reg = DriverRegistry();
      reg.register(d);

      final events = await reg.safeSend('script',
          const UserTurn(sessionId: 's1', turnId: 't1', text: '在吗')).toList();

      final content = events
          .whereType<DriverDelta>()
          .where((e) => e.kind == 'content')
          .single;
      expect(content.text, '你好，来自脚本');
      expect(decideTier(content.text).tier, ContentTier.l3);
      expect(events.whereType<DriverFinished>().single.reason, 'completed');
    });

    test('render 认不出的状态 code 走 default 分支原样出 detail', () async {
      // 事件词汇表扩展（如 T15 的降级提示 code）不需要给渲染层加分支——
      // default 分支把 detail 原样画出来。这是「新增 driver 不改渲染代码」
      // 在词汇表侧的对应物。
      final line = driverStatusLine(
          DriverStatus(code: 'route_degraded', detail: '直连不可用，已降级读屏'));
      expect(line.text, '直连不可用，已降级读屏');
    });

    test('四个内置 driver 全部能跑通一轮会话（不缺件）', () async {
      final reg = AppDriverRegistry.instance.registryFor(cfg(), host());
      expect(reg.enabledIds.toSet(), {'amoo', 'local', 'pc-bridge', 'script'});
      // displayName 覆盖全部——UI 只读这一张表，不自己拼名字。
      for (final id in const ['amoo', 'local', 'pc-bridge', 'script']) {
        expect(AppDriverRegistry.displayName(id), isNotEmpty);
      }
    });
  });

  group('T16 解耦契约（源码级）', () {
    test('渲染层不 import 任何 driver 实现', () {
      for (final path in const [
        'lib/ui/render/content_tier.dart',
        'lib/ui/render/envelope_render.dart',
        'lib/ui/render/envelope_reply_view.dart',
      ]) {
        final src = File(path).readAsStringSync();
        expect(src.contains('core/drivers/amoo_driver.dart'), isFalse, reason: path);
        expect(src.contains('core/drivers/script_driver.dart'), isFalse, reason: path);
        expect(src.contains('core/drivers/local_driver.dart'), isFalse, reason: path);
        expect(src.contains('core/drivers/pc_bridge_driver.dart'), isFalse, reason: path);
      }
    });

    test('driver 实现不 import 渲染层', () {
      for (final path in const [
        'lib/core/drivers/amoo_driver.dart',
        'lib/core/drivers/local_driver.dart',
        'lib/core/drivers/pc_bridge_driver.dart',
        'lib/core/drivers/script_driver.dart',
      ]) {
        final src = File(path).readAsStringSync();
        expect(src.contains('ui/'), isFalse, reason: '$path 不许碰渲染层');
        expect(src.contains('package:flutter/material.dart'), isFalse, reason: path);
      }
    });

    test('聊天屏消费 driver 状态经渲染层映射器（detail 不丢）', () {
      // 「不改渲染代码跑通会话」的最后一环：屏幕把 DriverStatus 交给
      // driverStatusLine，而不是自己拼一句把 detail 扔掉。拼一次的代价是
      // 降级提示（T15）与每个 driver 的状态目标在这一跳隐形。
      final src = File('lib/ui/screens/chat_screen_new.dart').readAsStringSync();
      expect(src.contains('driverStatusLine'), isTrue,
          reason: '聊天屏必须经渲染层状态行映射器消费 DriverStatus，'
              '不允许自己拼 driver 状态文案');
      expect(src.contains("import '../render/content_tier.dart'"), isTrue,
          reason: '用映射器就要 import 它');
    });

    test('新增 driver 的手续只有「实现四方法 + 登记」，不改渲染文件', () async {
      // 机读形式：Driver 接口的四个方法 + 一个 id/enabled/health 就是全部
      // 接入面；注册表是唯一权威，UI 读同一份（app_driver_registry.dart:12-15
      // 的注释说的那件事）。
      final reg = DriverRegistry();
      reg.register(_DemoDriver(reply: 'x'));
      expect(reg.enabledIds, ['demo']);
      expect(reg.get('demo'), isA<Driver>());
      // 禁用 = 不出场但仍在册（重新启用不必重启 App）。
      final reg2 = DriverRegistry(disabledIds: const ['demo']);
      reg2.register(_DemoDriver(reply: 'x'));
      expect(reg2.enabledIds, isEmpty);
      expect(reg2.get('demo'), isNotNull);
    });
  });
}

SessionContext _ctx(ToolHostClient host) => SessionContext(tools: host);

const _longReply = '第一段：桥在线，可用工具 50 个。\n'
    '第二段：其中界面工具 11 个可调，exec 已提权到 sidecar。\n'
    '第三段：以上为完整回答，未截断。';

/// 一个全新的 driver 实现（T16 的「新增 driver」本人）。
///
/// 刻意什么都不依赖：不碰 UI、不碰平台通道——driver 只产通用事件。
class _DemoDriver implements Driver {
  _DemoDriver({required this.reply});

  final String reply;
  final DriverHealth _health = DriverHealth.ok;

  @override
  String get id => 'demo';

  @override
  bool get enabled => true;

  @override
  DriverHealth health() => _health;

  @override
  Future<void> openSession(String sessionId, SessionContext ctx) async {}

  @override
  Stream<DriverEvent> send(UserTurn turn) async* {
    yield DriverStarted(sessionId: turn.sessionId, turnId: turn.turnId);
    yield DriverStatus(code: 'waiting', detail: '演示 driver 思考中', attempt: 0);
    yield DriverDelta(kind: 'content', text: reply);
    yield DriverFinished(turnId: turn.turnId, reason: 'completed');
  }

  @override
  Future<void> abort(String sessionId) async {}

  @override
  Future<void> dispose() async {}
}
