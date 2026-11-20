import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/config/permission_mode.dart';
import 'package:khy_os_client/core/services/amoo_approval.dart';
import 'package:khy_os_client/core/services/audit_log.dart';

import 'kotlin_source_support.dart';

/// B7 远端审批的单元级完成判定（任务书 §4 B7、contract §9 K-80–K-84）。
///
/// 判据（任务书 §4 B7 原文三条，缺一即红）：
///   1. 远端有副作用动作在本机弹确认；
///   2. 超时后 `pm list` / `ls` 核验确实未执行；
///   3. 确认后执行且审计留痕。
///
/// 为什么这三条的大半能钉在 Dart 侧：第 2 条的「确实未执行」在设备上是一次观测，
/// 在 Dart 侧是「过期状态 → 拒绝码 → 三幂等字段恒 false」这条确定性链路——设备侧只
/// 负责证明执行层真的按这条链路办事（device/B7.md）。第 3 条的审计留痕同理：
/// `AuditLog` 有测试用落盘口子，能断言「真的写进去了」，不必只断言内存列表。
///
/// 本文件对当前代码是红的（红在两类，都预期）：
///   · `lib/core/services/amoo_approval.dart` 尚不存在（import 即编译失败）；
///   · `PermissionMode` 只有三档，没有 `remoteApproval`（K-80 要求增第四档）。
/// 首败原始输出按 EVID 约定落 `checks/b7_red.txt`。
///
/// 2026-11-13 回炉复核（判定回炉·B7）：两门对当前代码仍为红——本文件 `flutter test
/// --reporter compact` exit=1（编译失败，全在 `remoteApproval`/`ApprovalGate`/
/// `ApprovalRecord` 等待落地符号上），`b7_approval_contract.cmd` exit=1
/// （3 passed / 25 failed / 4 skipped）。红相即「缺模块」，不是空转，故不改写；
/// 把它改成退出 0 只会得到恒真判定。证据与锚点抽查见 device/B7.md §1.1。
///
/// 实现方必须一起改的两处（不补就是留一张已知红的旧测试）：
///   · `test/permission_mode_test.dart:34` 的 wire 名单与 `:176` 的 `findsNWidgets(3)`
///     是「正好三档」的断言，加第四档后必须跟着改成四档（bypass 从下标 2 变 3）；
///   · `lib/ui/screens/settings_screen_new.dart:1027` 的 `activeColor` 是穷尽 switch，
///     不加 `remoteApproval` 分支编译不过。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory tmp;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('khy_b7_test');
    AuditLog.useDirectoryForTest(tmp);
  });

  tearDown(() {
    AuditLog.useDirectoryForTest(null);
    try {
      tmp.deleteSync(recursive: true);
    } catch (_) {}
  });

  group('K-80 第四档 remote_approval', () {
    test('wire 名单是四档，前三档逐字不变', () {
      expect(PermissionMode.values.map((m) => m.wire).toList(), <String>[
        'default',
        'auto',
        'bypass',
        'remote_approval',
      ]);
    });

    test('fromWire 认得新档，未知值仍然落 prompt 而不是 bypass', () {
      expect(PermissionMode.fromWire('remote_approval'), PermissionMode.remoteApproval);
      // 存储里写错一个字母不许变成「一律不问」——这条对第四档同样成立。
      expect(PermissionMode.fromWire('remote_approvall'), PermissionMode.prompt);
      expect(PermissionMode.fromWire(null), PermissionMode.prompt);
      expect(PermissionMode.fromWire(''), PermissionMode.prompt);
    });

    test('新档仍然要问，且不继承「本次会话记住」', () {
      // remote_approval 问的对象换成了设备旁的人，但「问」这个性质不变：
      // 一次远端动作一张审批单，没有「这个工具本轮不用再批」这回事。
      expect(PermissionMode.remoteApproval.asks, isTrue);
      expect(PermissionMode.remoteApproval.remembersWithinSession, isFalse);
    });

    test('新档的 label/detail 说它到底改变什么，不是把名字念一遍', () {
      expect(PermissionMode.remoteApproval.label, isNotEmpty);
      expect(PermissionMode.remoteApproval.detail, isNotEmpty);
      expect(PermissionMode.remoteApproval.detail,
          isNot(PermissionMode.remoteApproval.label));
      // 「生成审批、等人确认」是 K-80 的原文语义，说明里要有，否则用户无从判断
      // 这一档和另外三档的差别。
      expect(PermissionMode.remoteApproval.detail, contains('审批'));
      for (final m in PermissionMode.values) {
        expect(m.detail, isNot(m.label), reason: '$m 的说明只是复述名字');
      }
    });

    test('permission_mode.dart 仍然不引 Flutter', () {
      final f = File('lib/core/config/permission_mode.dart');
      expect(f.existsSync(), isTrue, reason: '测试必须从 App 目录跑');
      expect(f.readAsStringSync(), isNot(contains("import 'package:flutter")));
    });
  });

  group('K-81 审批状态文件形状（十个字段闭集）', () {
    test('往返一致，字段正好是契约表的十个', () {
      final json = requestOne().toJson();
      expect(json.keys.toSet(), <String>{
        'approval_id',
        'state',
        'msg_id',
        'trace_id',
        'tool',
        'args_digest',
        'created_at',
        'expires_at',
        'decided_at',
        'decided_by',
      });
      final back = ApprovalRecord.parse(json);
      expect(back, isNotNull);
      expect(back!.toJson(), json);
    });

    test('八个必填逐个缺席即拒（不是默认值糊过去）', () {
      for (final key in const <String>[
        'approval_id',
        'state',
        'msg_id',
        'trace_id',
        'tool',
        'args_digest',
        'created_at',
        'expires_at',
      ]) {
        final json = requestOne().toJson()..remove(key);
        expect(ApprovalRecord.parse(json), isNull, reason: 'missing $key');
      }
    });

    test('decided_at / decided_by 可缺席；多一个字段即拒', () {
      expect(ApprovalRecord.parse(requestOne().toJson()..remove('decided_at')), isNotNull);
      expect(ApprovalRecord.parse(requestOne().toJson()..remove('decided_by')), isNotNull);
      final extra = requestOne().toJson()..['note'] = 'x';
      expect(ApprovalRecord.parse(extra), isNull);
    });

    test('state 四选一，越界拒', () {
      for (final s in ApprovalState.values) {
        final json = requestOne().toJson()..['state'] = s.wire;
        expect(ApprovalRecord.parse(json)!.state, s);
      }
      expect(ApprovalRecord.parse(requestOne().toJson()..['state'] = 'cancelled'), isNull);
      expect(ApprovalRecord.parse(requestOne().toJson()..['state'] = 'PENDING'), isNull);
    });

    test('approval_id 就是信封 idempotency_key，形状同信箱 id（它是状态文件名）', () {
      // 状态文件叫 approval_<id>.json，落在 /sdcard 共享目录里：id 里带 `/` 或 `..`
      // 就能写出目录之外，所以形状必须钉死，与信箱 id 同一条规则。
      String? idOf(String id) {
        final json = requestOne().toJson()..['approval_id'] = id;
        return ApprovalRecord.parse(json)?.approvalId;
      }

      expect(idOf('b7-rm-1'), 'b7-rm-1');
      expect(idOf('A_b-C9'), 'A_b-C9');
      expect(idOf('x' * 128), 'x' * 128);
      expect(idOf('x' * 129), isNull);
      expect(idOf('../escape'), isNull);
      expect(idOf('a b'), isNull);
      expect(idOf(''), isNull);
      expect(idOf('中文'), isNull);
    });

    test('expires_at 必须晚于 created_at（出生即过期的单没有意义）', () {
      final json = requestOne().toJson()..['expires_at'] = 1;
      expect(ApprovalRecord.parse(json), isNull);
      final equal = requestOne().toJson()..['expires_at'] = kBaseMs;
      expect(ApprovalRecord.parse(equal), isNull);
    });
  });

  group('K-82 超时默认拒绝（判据 2）', () {
    test('超时时长 120000ms，与 exec 的 timeout 上限同一个量级', () {
      // Tools.java:1638 `Math.min(a.optInt("timeout", 20), 120)`：exec 单次上限 120s。
      // 审批要比 B1 的 30s 结果文件判据长——锁屏上看到通知、解锁、读摘要、做决定，
      // 30 秒不够；但也不该超过一次 exec，否则云端那侧早就判它挂了。
      expect(kApprovalTimeoutMs, 120000);
    });

    test('到期前一刻仍 pending；到期那一刻设备侧改写成 expired', () async {
      final gate = ApprovalGate();
      final r = ask(gate, 'b7-to-1', 'rm');
      expect(r.state, ApprovalState.pending);
      expect(r.createdAt, kBaseMs);
      expect(r.expiresAt, kBaseMs + kApprovalTimeoutMs);

      final before =
          await gate.decide(tool: 'rm', approvalId: 'b7-to-1', nowMs: kBaseMs + 119999);
      expect(before.execute, isFalse);
      expect(before.state, ApprovalState.pending);
      expect(before.code, AmooApprovalCodes.approvalRequired);

      final flipped = await gate.expireDue(nowMs: kBaseMs + 120000);
      expect(flipped.map((e) => e.approvalId).toList(), <String>['b7-to-1']);
      expect(gate.find('b7-to-1')!.state, ApprovalState.expired);
    });

    test('超时后拒绝码是 approval_timeout，三幂等字段恒 false（未执行）', () async {
      final gate = ApprovalGate();
      ask(gate, 'b7-to-2', 'rm');
      final v =
          await gate.decide(tool: 'rm', approvalId: 'b7-to-2', nowMs: kBaseMs + 120001);
      expect(v.execute, isFalse);
      expect(v.code, AmooApprovalCodes.approvalTimeout);
      expect(v.state, ApprovalState.expired);
      final receipt = v.receipt();
      expect(receipt['ok'], false);
      expect(receipt['action_dispatched'], false);
      expect(receipt['replay_safe'], false);
      expect(receipt['retry_safe'], false);
      expect(receipt['error'], isNotEmpty);
      expect(receipt['fix'], isNotEmpty);
      expect(receipt['guide_topic'], isNotEmpty);
      expect(v.label, contains('未执行'));
    });

    test('decide 自己就会判超时，不靠外部定时器先跑', () async {
      // 云端轮询读状态文件的间隙里，超时必须已经被判掉：等人来调 expireDue 才拒，
      // 等于把「默认拒绝」的执行权交给一个没人保证会跑的定时器。
      final gate = ApprovalGate();
      ask(gate, 'b7-to-3', 'exec', args: const <String, dynamic>{'cmd': 'ls /sdcard'});
      final v =
          await gate.decide(tool: 'exec', approvalId: 'b7-to-3', nowMs: kBaseMs + 999999);
      expect(v.code, AmooApprovalCodes.approvalTimeout);
      expect(gate.find('b7-to-3')!.state, ApprovalState.expired);
    });

    test('过期之后人再点批准也不算数（云端那侧已经读到 expired 了）', () async {
      final gate = ApprovalGate();
      ask(gate, 'b7-to-4', 'rm');
      await gate.expireDue(nowMs: kBaseMs + 120000);
      final late =
          await gate.approve('b7-to-4', decidedBy: '孔浩原', atMs: kBaseMs + 130000);
      expect(late!.state, ApprovalState.expired);
      final v =
          await gate.decide(tool: 'rm', approvalId: 'b7-to-4', nowMs: kBaseMs + 130001);
      expect(v.execute, isFalse);
      expect(v.code, AmooApprovalCodes.approvalTimeout);
    });

    test('超时本身进审计（ok=false），可按时间查到', () async {
      final gate = ApprovalGate();
      ask(gate, 'b7-to-5', 'rm');
      await gate.expireDue(nowMs: kBaseMs + 120000);
      final entries = await AuditLog.instance.recent();
      expect(entries, isNotEmpty, reason: '超时也必须留下痕迹，不然「谁没批」查不到');
      final e = entries.firstWhere((entry) => entry.detail.contains('b7-to-5'));
      expect(e.ok, false);
      expect(e.operation, contains('approval'));
    });
  });

  group('K-83/K-84 未确认无副作用（判据 1）', () {
    test('有副作用动作才要批：名单来自桥侧安全底，不新造第二份', () {
      // 判据是工具名，不是「所有工具都问」——把只读的 ls/ping 也拉进来审批，
      // 这个模式会因为天天弹框而被用户关掉，那是更坏的结果。
      expect(needsHumanApproval('rm'), isTrue);
      expect(needsHumanApproval('exec'), isTrue);
      expect(needsHumanApproval('secret_put'), isTrue);
      expect(needsHumanApproval('amoo_ask'), isTrue);
      expect(needsHumanApproval('ls'), isFalse);
      expect(needsHumanApproval('ping'), isFalse);
      expect(needsHumanApproval('read'), isFalse);
      expect(needsHumanApproval('info'), isFalse);
      expect(needsHumanApproval('shot'), isFalse);
    });

    test('四种模式下同一个结论：远端的授权不继承本机的 bypass', () {
      // 模式层管的是「用手机的人要不要被 khy-os 自己的确认框打扰」；远端的发起者
      // 不是那个人——他看不见屏幕，也不知道自己那次 rm 落在哪。把 bypass 的授权
      // 跨端继承，等于让一个人替另一个人关掉一道安全提示。
      for (final m in PermissionMode.values) {
        expect(needsHumanApproval('rm'), isTrue, reason: '$m 下 rm 仍须人批');
        expect(needsHumanApproval('ls'), isFalse, reason: '$m 下 ls 仍不该问');
      }
    });

    test('还没有审批单就要求执行：approval_required，什么都没到工具层', () async {
      final v = await ApprovalGate().decide(tool: 'rm');
      expect(v.execute, isFalse);
      expect(v.code, AmooApprovalCodes.approvalRequired);
      expect(v.approvalId, isNull);
      expect(v.receipt()['action_dispatched'], false);
      expect(v.label, contains('未确认'));
      expect(v.label, isNot(contains('已执行')));
    });

    test('审批单在飞（pending）时：已下发未确认，不许说成已执行', () async {
      final gate = ApprovalGate();
      ask(gate, 'b7-p-1', 'rm');
      final v = await gate.decide(tool: 'rm', approvalId: 'b7-p-1', nowMs: kBaseMs + 5000);
      expect(v.execute, isFalse);
      expect(v.code, AmooApprovalCodes.approvalRequired);
      expect(v.state, ApprovalState.pending);
      expect(v.label, contains('未确认'));
      expect(v.label, isNot(contains('已执行')));
      // 进度要可读：还剩多少秒是「等」这个状态唯一有信息的数字。
      expect(v.label, contains('115'));
      expect(v.receipt()['approval_state'], 'pending');
    });

    test('同一 key 重放不生成第二张单（云端重发不弹第二次框）', () async {
      final gate = ApprovalGate();
      final a = ask(gate, 'b7-p-2', 'rm');
      final b = ask(gate, 'b7-p-2', 'rm', args: const <String, dynamic>{'path': '/sdcard/b'});
      expect(b.approvalId, a.approvalId);
      expect(b.createdAt, a.createdAt);
      expect(b.argsDigest, a.argsDigest);
      expect(gate.pending().length, 1);
    });
  });

  group('K-83 确认后执行且审计留痕（判据 3）', () {
    test('批准 → 放行；回执三字段说清「放行过且不重放」', () async {
      final gate = ApprovalGate();
      ask(gate, 'b7-ok-1', 'rm');
      final approved =
          await gate.approve('b7-ok-1', decidedBy: '孔浩原', atMs: kBaseMs + 3000);
      expect(approved!.state, ApprovalState.approved);
      expect(approved.decidedBy, '孔浩原');
      expect(approved.decidedAt, kBaseMs + 3000);

      final v =
          await gate.decide(tool: 'rm', approvalId: 'b7-ok-1', nowMs: kBaseMs + 3100);
      expect(v.execute, isTrue);
      expect(v.code, isNull);
      expect(v.state, ApprovalState.approved);
      final receipt = v.receipt();
      expect(receipt['ok'], true);
      expect(receipt['action_dispatched'], true);
      // 批准过一次 ≠ 可以再放行一次：副作用已经发生，重放会二次执行。
      expect(receipt['replay_safe'], false);
      expect(receipt['retry_safe'], false);
    });

    test('放行过的 key 再放行第二次：duplicate_id，不二次执行', () async {
      final gate = ApprovalGate();
      ask(gate, 'b7-ok-2', 'rm');
      await gate.approve('b7-ok-2', decidedBy: '孔浩原');
      expect((await gate.decide(tool: 'rm', approvalId: 'b7-ok-2')).execute, isTrue);

      final again = await gate.decide(tool: 'rm', approvalId: 'b7-ok-2');
      expect(again.execute, isFalse);
      expect(again.code, AmooApprovalCodes.duplicateId);
      expect(again.receipt()['action_dispatched'], false);
      expect(gate.consumedIds(), <String>{'b7-ok-2'});
    });

    test('批准这一下进审计：来源、工具、批准人、结果都在', () async {
      final gate = ApprovalGate();
      ask(gate, 'b7-ok-3', 'rm');
      await gate.approve('b7-ok-3', decidedBy: '孔浩原');

      final entries = await AuditLog.instance.recent();
      expect(entries, isNotEmpty, reason: '审计必须真的写进去，不能只在内存里');
      final e = entries.firstWhere((entry) => entry.detail.contains('b7-ok-3'));
      expect(e.source, AuditSource.ai);
      expect(e.operation, contains('approval'));
      expect(e.detail, contains('rm'));
      expect(e.detail, contains('孔浩原'));
      expect(e.ok, true);
    });

    test('拒绝也进审计（ok=false），且结论以第一次为准', () async {
      final gate = ApprovalGate();
      ask(gate, 'b7-no-1', 'rm');
      final denied = await gate.deny('b7-no-1', decidedBy: '孔浩原');
      expect(denied!.state, ApprovalState.denied);

      final v = await gate.decide(tool: 'rm', approvalId: 'b7-no-1');
      expect(v.execute, isFalse);
      // 拒绝复用 approval_required，不新造第四个码：K-23 是闭集，而「人批过但拒了」
      // 与「还没问过」靠 approval_state 与 label 区分——回执里两个字段都在。
      expect(v.code, AmooApprovalCodes.approvalRequired);
      expect(v.state, ApprovalState.denied);
      expect(v.receipt()['approval_state'], 'denied');
      expect(v.label, contains('拒绝'));
      expect(v.label, contains('未执行'));

      // 拒了之后又点批准：第一次结论站着，不翻案。
      final flipped = await gate.approve('b7-no-1', decidedBy: '孔浩原');
      expect(flipped!.state, ApprovalState.denied);
      expect((await gate.decide(tool: 'rm', approvalId: 'b7-no-1')).execute, isFalse);

      final entries = await AuditLog.instance.recent();
      final e = entries.firstWhere((entry) => entry.detail.contains('b7-no-1'));
      expect(e.ok, false);
      expect(e.detail, contains('孔浩原'));
    });

    test('decidedBy 不许空：审计要能回答「谁批的」', () async {
      final gate = ApprovalGate();
      ask(gate, 'b7-no-2', 'rm');
      expect(await gate.deny('b7-no-2', decidedBy: ''), isNull);
      expect(await gate.approve('b7-no-2', decidedBy: '   '), isNull);
      expect(gate.find('b7-no-2')!.state, ApprovalState.pending);
    });

    test('未知 id 的批准/拒绝返回 null，不凭空造一张单', () async {
      final gate = ApprovalGate();
      expect(await gate.approve('nope', decidedBy: '孔浩原'), isNull);
      expect(await gate.deny('nope', decidedBy: '孔浩原'), isNull);
    });
  });

  group('K-81 args_digest：敏感参数只进摘要，不进原文', () {
    test('摘要稳定、与键序无关、随取值变化', () {
      const args = <String, dynamic>{'path': '/sdcard/x', 'recursive': true};
      expect(approvalArgsDigest(args), approvalArgsDigest(args));
      expect(
        approvalArgsDigest(const <String, dynamic>{'recursive': true, 'path': '/sdcard/x'}),
        approvalArgsDigest(args),
      );
      expect(
        approvalArgsDigest(const <String, dynamic>{'path': '/sdcard/y', 'recursive': true}),
        isNot(approvalArgsDigest(args)),
      );
    });

    test('人能认得出自己在批什么：非敏感值在摘要里可读', () {
      final d = approvalArgsDigest(const <String, dynamic>{
        'tool': 'rm',
        'path': '/sdcard/DCIM/photo.jpg',
      });
      expect(d, contains('/sdcard/DCIM/photo.jpg'));
      expect(d, contains('path'));
    });

    test('凭据类键的值整条替换，嵌套也一样', () {
      final d = approvalArgsDigest(const <String, dynamic>{
        'cmd': 'curl -H "Authorization: Bearer sk-live-9f8e7d" https://x.invalid/y',
        'token': 'sk-live-9f8e7d',
        'nested': <String, dynamic>{'password': 'p@ss', 'keep': 'visible'},
      });
      expect(d, isNot(contains('sk-live-9f8e7d')));
      expect(d, isNot(contains('p@ss')));
      expect(d, contains('token'));
      expect(d, contains('password'));
      expect(d, contains('visible'));
    });

    test('摘要有长度上限：状态文件要小，弹框要一眼读完', () {
      final d = approvalArgsDigest(<String, dynamic>{
        'blob': 'x' * 100000,
      });
      expect(d.length, lessThanOrEqualTo(kArgsDigestMaxChars));
    });

    test('空参数也给出确定摘要（不是空串，也不是异常）', () {
      expect(approvalArgsDigest(const <String, dynamic>{}), isNotEmpty);
    });
  });

  group('确认面与桥侧安全底是同一份名单（禁平行实现，K-43/K-84）', () {
    test('Dart 两个名单逐字等于 LoopModes 的两个声明', () {
      final src = readNativeSource(kLoopModesPath);
      expect(src, isNotNull,
          reason: '读不到 LoopModes.java（cwd=${Directory.current.path}）——\n'
              '镜像判定读不到原生真源就只能判不通过，跳过它会让下面的比对假绿。');
      final source = src!;

      final highRisk = javaStringEntries(source, 'List<String> HIGH_RISK_TOOLS =');
      final irreversible = javaStringEntries(source, 'List<String> IRREVERSIBLE_TOOLS =');
      expect(highRisk, isNotEmpty, reason: 'HIGH_RISK_TOOLS 解析不到，空集合会让相等判定假绿');
      expect(irreversible, isNotEmpty, reason: 'IRREVERSIBLE_TOOLS 解析不到');

      expect(kHighRiskTools, highRisk);
      expect(kIrreversibleTools, irreversible);
      // 并集就是确认面：不允许出现第三份「也要确认」的名单。
      expect(kConfirmTools, <String>{...highRisk, ...irreversible});
      expect(kConfirmTools.length, highRisk.length + irreversible.length,
          reason: '两个名单有交集——合并去重后数量必须等于两者之和');
    });

    test('名单里每个名字都是桥真的有的工具（不是 Dart 侧臆造的）', () {
      final src = readNativeSource(kToolsNamesPath);
      expect(src, isNotNull, reason: '读不到 Tools.java');
      final names = javaStringEntries(src!, 'String[] NAMES =');
      expect(names.length, 50, reason: 'Tools.NAMES 实读 50 个，数量变了先核对再改判据');
      expect(names.containsAll(kConfirmTools), isTrue,
          reason: '确认面里出现了 Tools.NAMES 没有的工具：${kConfirmTools.difference(names)}');
    });
  });

  group('错误码闭集（K-23，不新造码）', () {
    test('本门只发 K-23 表里已有的码', () {
      expect(AmooApprovalCodes.approvalRequired, 'approval_required');
      expect(AmooApprovalCodes.approvalTimeout, 'approval_timeout');
      expect(AmooApprovalCodes.duplicateId, 'duplicate_id');
      // 这三个码都在契约 K-23 的 15 个里。B1 的 AmooErrors.codes 钉那份闭集；两边
      // 字面量的一致性由 checks/b7_approval_contract.cmd 静态对齐——B7 不 import
      // B1 的模块，免得 B7 的门被 B1 尚未落地的代码拖着一起红。
    });
  });
}

/// 时间基准：所有 nowMs / atMs 都相对它，不让真实时钟进判定。
const int kBaseMs = 1700000000000;

/// 造一张待审的单。工具面只有 rm/exec 两类会走到审批，参数用最常见的删除形状。
ApprovalRecord ask(
  ApprovalGate gate,
  String approvalId,
  String tool, {
  Map<String, dynamic> args = const <String, dynamic>{'path': '/sdcard/b7-probe'},
}) =>
    gate.request(
      approvalId: approvalId,
      msgId: 'm1',
      traceId: 'T-b7',
      tool: tool,
      args: args,
      nowMs: kBaseMs,
    );

/// 形状测试用的那一张（时间基准同 kBaseMs）。
ApprovalRecord requestOne() => ApprovalRecord(
      approvalId: 'b7-shape-1',
      state: ApprovalState.pending,
      msgId: 'm1',
      traceId: 'T-b7',
      tool: 'rm',
      argsDigest: approvalArgsDigest(const <String, dynamic>{'path': '/sdcard/x'}),
      createdAt: kBaseMs,
      expiresAt: kBaseMs + kApprovalTimeoutMs,
    );

/// 桥侧 `LoopModes.java`：确认面两个名单的原生真源。
const String kLoopModesPath =
    'android/app/src/main/java/com/khyos/khy_os_client/bridge/LoopModes.java';

/// 桥侧 `Tools.java`：`NAMES` 是「这个名字是不是真工具」的原生真源。
const String kToolsNamesPath =
    'android/app/src/main/java/com/khyos/khy_os_client/bridge/Tools.java';

/// 从 Java 源里取一个字符串名单声明的全部条目。
///
/// 两个形状都吃：`Arrays.asList(...)` 与 `String[] X = { ... }`。按字符扫而不是一条
/// 正则抓完：名单跨行、里面可能有行注释，而注释里同样会出现引号——只有声明本身与
/// 配对的收尾括号算锚点（与 `kotlin_source_support.dart` 同一套理由，那边是 Kotlin
/// 的 `listOf` 形状）。若日后再有测试要读 Java 名单，把这个函数提到共享helper里，
/// 不要在两个文件里各抄一份。
Set<String> javaStringEntries(String source, String decl) {
  final at = source.indexOf(decl);
  if (at < 0) return const <String>{};
  var i = at + decl.length;
  while (i < source.length && source[i] != '(' && source[i] != '{') {
    i++;
  }
  if (i >= source.length) return const <String>{};
  var depth = 0;
  final out = <String>{};
  while (i < source.length) {
    final ch = source[i];
    if (ch == '"') {
      i++;
      final b = StringBuffer();
      while (i < source.length) {
        final c = source[i];
        if (c == '\\' && i + 1 < source.length) {
          b.write(source[i + 1]);
          i += 2;
          continue;
        }
        if (c == '"') {
          i++;
          break;
        }
        b.write(c);
        i++;
      }
      out.add(b.toString());
      continue;
    }
    if (ch == '/' && i + 1 < source.length && source[i + 1] == '/') {
      while (i < source.length && source[i] != '\n') {
        i++;
      }
      continue;
    }
    if (ch == '(' || ch == '{') depth++;
    if (ch == ')' || ch == '}') {
      depth--;
      if (depth == 0) break;
    }
    i++;
  }
  return out;
}
