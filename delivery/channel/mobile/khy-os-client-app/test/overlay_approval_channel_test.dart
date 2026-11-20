// OverlayApprovalChannel 的契约测试：挂起→答案落对号、错号忽略、120s 超时
// 自动拒、并发请求拒绝。全 fake：注入毫秒级 timeout 与临时目录。
import 'dart:async';
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
    tmp = await Directory.systemTemp.createTemp('overlay-approval-test');
  });
  tearDown(() {
    if (tmp.existsSync()) tmp.deleteSync(recursive: true);
  });

  FloatingStatusController newController() => FloatingStatusController(
        store: TaskStateStore(
            File('${tmp.path}/floating/${TaskStateStore.fileName}')),
        now: TickingClock().call,
      );

  test('请求写进 pendingApproval，答案对上 id 才生效', () async {
    final c = newController();
    final ch = OverlayApprovalChannel(controller: c);
    final f = ch.request(
        toolName: 'vision_tap', params: {'target': '搜索按钮'});

    // request 同步注册（async 函数体在首个 await 前跑完），无需等一拍。
    expect(c.current.phase, TaskPhase.awaitingApproval);
    expect(c.current.pendingApproval?.tool, 'vision_tap');
    expect(c.current.pendingApproval?.target, '搜索按钮');
    expect(c.current.lastAction, contains('等待批准'));
    final id = ch.pendingId;
    expect(id, isNotNull);

    // 错号回信被忽略（悬浮窗上的旧回信不能落到新问题上）。
    var answered = false;
    unawaited(f.then((_) => answered = true));
    ch.resolve('ov-wrong', true);
    expect(answered, isFalse, reason: '错号不落答案');
    expect(c.current.pendingApproval, isNotNull);

    ch.resolve(id!, false);
    expect(await f, WechatApprovalDecision.deny);
    expect(c.current.pendingApproval, isNull);
    expect(c.current.phase, TaskPhase.acting,
        reason: '审批清掉后回到执行态，等下一个真实状态覆盖');
    await c.dispose();
  });

  test('挂起期间的第二个请求直接拒绝（单槽）', () async {
    final c = newController();
    final ch = OverlayApprovalChannel(controller: c);
    final first = ch.request(toolName: 'vision_tap', params: const {});
    final second = await ch.request(
        toolName: 'vision_tap', params: const {'target': '另一个'});
    expect(second, WechatApprovalDecision.deny,
        reason: '不能覆盖一个还没被回答的问题');
    ch.resolve(ch.pendingId!, true);
    expect(await first, WechatApprovalDecision.allow);
    await c.dispose();
  });

  test('超时自动拒——沉默不能变成同意，也不能变成「用户拒绝」', () async {
    final c = newController();
    final ch = OverlayApprovalChannel(
        controller: c, timeout: const Duration(milliseconds: 40));
    final decision = await ch.request(
        toolName: 'vision_tap', params: {'target': '没人回答'});
    expect(decision, WechatApprovalDecision.timeout,
        reason: '超时要回 timeout：引擎对它说「等待授权超时已自动拒」，'
            '而 deny 会被说成「用户拒绝了该操作」——没人回答时那是替用户签名');
    expect(c.current.pendingApproval, isNull);
    expect(ch.pendingId, isNull);
    await c.dispose();
  });

  test('超时后迟到的 resolve 不复活旧问题', () async {
    final c = newController();
    final ch = OverlayApprovalChannel(
        controller: c, timeout: const Duration(milliseconds: 30));
    final f = ch.request(toolName: 'vision_tap', params: const {});
    final id = ch.pendingId!;
    expect(await f, WechatApprovalDecision.timeout,
        reason: '30ms 后先超时，回信才到');
    ch.resolve(id, true);
    expect(ch.pendingId, isNull,
        reason: '迟到的回信没有落点——旧问题不能复活');
    expect(c.current.pendingApproval, isNull);
    await c.dispose();
  });
}
