import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/app_config.dart';
import 'package:khy_os_client/core/drivers/driver.dart';
import 'package:khy_os_client/core/drivers/driver_event.dart';
import 'package:khy_os_client/core/drivers/script_driver.dart';

void main() {
  // script driver 是 T2 的验收对象：证明「新增一个 driver 不改渲染层」。
  // 它的形态是声明式脚本（JSON 定义：固定回复或回显输入）——真正的脚本
  // 执行沙箱是 DESIGN-ARCH-195 T3 的议题，本设计不另起炉灶。
  group('ScriptDriver 会话', () {
    test('脚本定义 → 完整一轮会话事件', () async {
      final d = ScriptDriver(source: () async => [
            const ScriptDefinition(id: 'greet', name: '问候脚本', mode: 'reply', reply: '你好，来自脚本'),
          ]);
      final events = await d
          .send(const UserTurn(sessionId: 's', turnId: 't', text: '在吗'))
          .toList();
      expect(events.first, isA<DriverStarted>());
      final content = events.whereType<DriverDelta>().where((e) => e.kind == 'content').single;
      expect(content.text, '你好，来自脚本');
      expect(events.last, isA<DriverFinished>());
    });

    test('echo 模式回显用户输入', () async {
      final d = ScriptDriver(source: () async => [
            const ScriptDefinition(id: 'echo', name: '回显脚本', mode: 'echo'),
          ]);
      final events = await d
          .send(const UserTurn(sessionId: 's', turnId: 't', text: '原样返回我'))
          .toList();
      final content = events.whereType<DriverDelta>().where((e) => e.kind == 'content').single;
      expect(content.text, contains('原样返回我'));
    });

    test('没有脚本定义：明确失败，不静默空流', () async {
      final d = ScriptDriver(source: () async => const []);
      final events = await d
          .send(const UserTurn(sessionId: 's', turnId: 't', text: 'q'))
          .toList();
      expect(events.whereType<DriverFailed>().length, 1,
          reason: '空目录要说清楚，不能让用户对着一个空屏等');
      expect(events.whereType<DriverFinished>().length, 0);
    });

    test('读取脚本定义抛错：转 DriverFailed，不冒泡', () async {
      final d = ScriptDriver(source: () async => throw StateError('目录读不了'));
      final events = await d
          .send(const UserTurn(sessionId: 's', turnId: 't', text: 'q'))
          .toList();
      expect(events.whereType<DriverFailed>().single.retryable, true);
    });

    test('禁用后 enabled=false', () {
      final d = ScriptDriver(
        source: () async => const [],
        config: const AppConfigData(baseUrl: '', apiKey: '', model: 'm')
            .copyWith(disabledDrivers: const ['script']),
      );
      expect(d.enabled, false);
    });
  });

  group('T2 双向解耦契约（源码级）', () {
    test('script driver 不 import 渲染层', () {
      // T2 判据的机读形式（之一）：driver 实现文件里出现 lib/ui import，
      // 说明 driver 在直接画 UI——渲染层与 driver 的解耦当场破裂。
      final src = File('lib/core/drivers/script_driver.dart').readAsStringSync();
      expect(src.contains("ui/"), isFalse, reason: 'driver 不许碰渲染层');
      expect(src.contains('package:flutter/material.dart'), isFalse,
          reason: 'driver 是纯逻辑，不依赖 Flutter widget 库');
    });

    test('渲染层不 import 任何 driver 实现', () {
      for (final path in const [
        'lib/ui/render/content_tier.dart',
        'lib/ui/widgets/chat_message_row.dart',
        'lib/ui/widgets/amoo_task_card.dart',
      ]) {
        final src = File(path).readAsStringSync();
        expect(src.contains('core/drivers/amoo_driver.dart'), isFalse, reason: '$path');
        expect(src.contains('core/drivers/script_driver.dart'), isFalse, reason: '$path');
        expect(src.contains('core/drivers/pc_bridge_driver.dart'), isFalse, reason: '$path');
        expect(src.contains('core/drivers/local_driver.dart'), isFalse, reason: '$path');
      }
    });
  });
}
