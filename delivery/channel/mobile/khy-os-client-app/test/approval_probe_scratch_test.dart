import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/floating/floating_status_controller.dart';
import 'package:khy_os_client/core/floating/overlay_task_sink.dart';
import 'package:khy_os_client/core/floating/task_state.dart';
import 'package:khy_os_client/core/wechat/wechat_approval_bridge.dart';

import 'floating_status_controller_test.dart' show TickingClock;

void main() {
  late Directory tmp;
  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('approval-probe');
  });
  tearDown(() {
    if (tmp.existsSync()) tmp.deleteSync(recursive: true);
  });

  test('probe: request 同步段之后控制器状态', () async {
    final c = FloatingStatusController(
      store: TaskStateStore(
          File('${tmp.path}/floating/${TaskStateStore.fileName}')),
      now: TickingClock().call,
    );
    final ch = OverlayApprovalChannel(
        controller: c, timeout: const Duration(milliseconds: 40));
    final f = ch.request(
        toolName: 'vision_tap', params: {'target': '没人回答'});
    // ignore: avoid_print
    print('SYNC: pendingId=${ch.pendingId} phase=${c.current.phase} '
        'pa=${c.current.pendingApproval}');
    await Future<void>.delayed(Duration.zero);
    // ignore: avoid_print
    print('ZERO: pendingId=${ch.pendingId} phase=${c.current.phase} '
        'pa=${c.current.pendingApproval} '
        'storePa=${TaskStateStore(File('${tmp.path}/floating/${TaskStateStore.fileName}')).read()?.pendingApproval}');
    final decision = await f;
    // ignore: avoid_print
    print('AFTER: decision=$decision pa=${c.current.pendingApproval}');
  });
}
