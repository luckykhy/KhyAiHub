// khy-canary: Khy-1.1.28+13-202611142308-0F62DE87
import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'package:khy_os_client/core/gateway/amoo_bridge_adapter.dart';
import 'package:khy_os_client/core/services/app_logger.dart';
import 'package:khy_os_client/core/services/bridge_link_tls.dart';
import 'package:khy_os_client/core/services/console_service.dart';

/// 出向链路：设备主动连服务端的一条长连接。
///
/// WHY 出向而不是监听：断点一的现状是「二进制里 ws/wss 计数为 0，桥只监听
/// 127.0.0.1:8896」——那意味着设备永远只能等 PC 通过 adb 转发来敲门。PC 侧
/// 一断隧道，设备就既不知道对方在不在、也收不到任何指令，`pc_reachable` 只能
/// 恒 false。出向连接把「谁先说话」这件事反过来：设备连出去，pong 就是
/// 「服务端此刻可达」的证据，而且**不需要任何端口监听**（T2 判据）。
///
/// WHY 状态交给原生侧存（`BridgeLinkState`）：`status.json` 与 `pc_reachable`
/// 都是原生侧写的，Dart 再存一份就是第二个真源。这里只负责「连、ping、报」。
///
/// WHY 与心跳分开统计：`heartbeat_seq` 证明的是本机自愈循环还活着，它不需要
/// 任何人参与。把两者合成一个数，就会出现「心跳在涨，所以链路活着」这种误判
/// ——那正是本轮要修的形态。
class BridgeLink {
  BridgeLink._();

  static final BridgeLink instance = BridgeLink._();

  static const MethodChannel _channel =
      MethodChannel('com.khyos.khy_os_client/device');

  /// 连接状态的一次快照。给设置页/诊断页读，不再让 UI 自己拼。
  static final ValueNotifierLike status = ValueNotifierLike();

  bool _running = false;
  bool _connected = false;
  int _reconnectCount = 0;
  int _lastPongMs = 0;

  /// 服务端是否已接受这条身份（收到 `auth:ok`）。
  ///
  /// WHY 必须显式：断点二之前「连上 == 能用」是成立的（唯一凭据就是那条 TCP）。
  /// 换成设备签名之后不成立了——服务端可以先接受连接、再回 `auth:error`。
  /// 2026-11-15 实测就踩到：harness 因为帧里没有 `token` 回了 `auth:error`，
  /// 但它既不关连接也照常回 pong，于是 `link=wss` 一路报健康，而实际上
  /// 服务端一条指令都不会下发。
  bool _authed = false;
  String _authState = 'none';
  String _authCode = '';

  /// 当前这条连接的收尾把手。鉴权被拒 / 超时时由 [_onFrame] 与超时定时器触发，
  /// 让重连循环不必等 pong 窗口到点才发现「这条路其实不能用」。
  Completer<void>? _sessionDone;

  /// 本次连接建立时刻。看门狗在没有 pong 时的基准，避免"连上就不说话"永远不判死。
  int _connectedAtMs = 0;
  String _endpoint = '';

  /// 未完成会话：重连后按它续接（T3 的「会话续接，无重复执行」）。
  String _sessionId = '';

  /// 本会话的 msg_id 账本（T15）。复用 K-20 的既有实现，只在本进程内有效——
  /// 进程重启后服务端的重投本来就该重新执行一次（那是新的会话）。
  final AmooMsgLog _msgLog = AmooMsgLog();

  /// 指数退避的当前档位（秒）。连上即归零。
  int _backoffSec = 1;

  static const int _backoffMaxSec = 60;

  bool get connected => _connected;
  int get reconnectCount => _reconnectCount;
  int get lastPongMs => _lastPongMs;
  String get endpoint => _endpoint;

  /// 幂等启动。App 启动时调一次；原生侧被回收后由 ReviveReceiver 拉起进程时
  /// 会再走一次 main()，所以这里必须能被重复调用而不产生第二条链路。
  Future<void> ensureStarted() async {
    if (_running) return;
    _running = true;
    unawaited(_loop());
  }

  Future<void> _loop() async {
    while (_running) {
      final cfg = await _config();
      if (cfg == null) {
        // 没有配置 = 只有文件通道。这不是错误，是「PC 没告诉我它在哪」。
        _endpoint = '';
        await _report(connected: false);
        await Future<void>.delayed(const Duration(seconds: 20));
        continue;
      }
      _endpoint = cfg.endpoint;
      if (!cfg.hasIdentity) {
        // 身份材料不齐（密钥没生成出来 / 原生侧还没就绪）：不连。
        //
        // WHY 不连：旧实现用共享 token 连，token 空串也能连上——服务端只校验
        // 形状，于是"连上了但随时会被拒"和"根本没连"在日志里长得一样。
        // 断点二要求身份单轨，所以这里选择显式不连 + 留原因，让 status.json 的
        // link 字段如实报 file，而不是报一个假的 alive。
        AppLogger().w(LogCategory.network, '设备身份材料不齐，链路暂不建立',
            details: <String, dynamic>{
              'device_id': cfg.deviceId,
              'has_public_key': cfg.publicKey.isNotEmpty,
              'has_sig': cfg.sig.isNotEmpty,
            });
        await _report(connected: false);
        await Future<void>.delayed(const Duration(seconds: 10));
        continue;
      }
      WebSocketChannel? ch;
      Timer? ping;
      Timer? authTimer;
      final done = Completer<void>();
      _sessionDone = done;
      try {
        // wss 走内置指纹 pin（bridge_link_tls.dart）；ws 明文按旧路径直连。
        ch = connectLink(Uri.parse(cfg.endpoint));
        await ch.ready.timeout(const Duration(seconds: 10));
        _connected = true;
        _connectedAtMs = DateTime.now().millisecondsSinceEpoch;
        // 每次新连接都把 pong 时间清零。不清的后果是实测过的：断链 5 分钟后重连，
        // 看门狗拿的还是断链前那个 pong，于是"刚连上就判死"，连接被反复拆掉
        // （2026-11-14 23:07 实测：70 秒内 10 次 connect/auth，一次 pong 都没有）。
        _lastPongMs = 0;
        // 退避**不**在这里归零。
        //
        // WHY：TCP 连上不等于恢复。服务端可以先接受连接再拒身份（实测形态：
        // 8788 那个只会回 auth:error 的对端），此时把退避清零就是 1 秒一次热循环。
        // 退避只该在「身份被接受」之后重置——那才叫真的连上了。
        // 每条新连接都要重新鉴权：签名里带 ts，上一条连接上的 auth:ok 不能顺延。
        _authed = false;
        // 上一次被判 rejected 就保持 rejected，别用 pending 把它盖掉：
        // 运维读 status.json 时看到的必须是「连上了但被拒」，而不是一闪而过的
        // 「正在连」。等到真的 auth:ok 才清。
        if (_authState != 'rejected') _authState = 'pending';
        // 鉴权先于一切：服务端 syncServer 的协议是 auth → auth:ok → ping/pong。
        //
        // 断点二（身份单轨）：帧里不再有共享 token。设备用自己私钥签
        // `deviceId|ts`，服务端拿 publicKey 验签 + 用 ts 判重放。
        // 共享秘密一旦下线就不该留"过渡期字段"——留了，下一个人就会继续用它。
        ch.sink.add(jsonEncode({
          'type': 'auth',
          'deviceId': cfg.deviceId,
          'publicKey': cfg.publicKey,
          'ts': cfg.ts,
          'sig': cfg.sig,
          'platform': cfg.platform,
          'deviceName': cfg.deviceName,
        }));
        // 连上立刻要一次 pong：否则「已连接但还没有往返证据」这段空窗里，
        // status.json 只能报 link=file（这是对的，但会让恢复看起来慢半拍）。
        ch.sink.add(jsonEncode({'type': 'ping', 'ts': DateTime.now().millisecondsSinceEpoch}));
        if (_sessionId.isNotEmpty) {
          ch.sink.add(jsonEncode({'type': 'session:join', 'sessionId': _sessionId}));
        }
        // 这里只报「还没鉴权」，不报 connected=true。
        //
        // WHY：TCP 连上不代表身份被接受。先报 true 再等 auth:ok，等于把
        // 「握手失败」的那几秒也算成在线；而服务端如果根本不回 auth:ok（协议不认、
        // 或对端是只回 pong 的假对端），就会一直停在假健康上。宁可先报 file。
        await _report(connected: false);

        ping = Timer.periodic(Duration(milliseconds: cfg.heartbeatMs), (_) {
          try {
            ch?.sink.add(jsonEncode({
              'type': 'ping',
              'ts': DateTime.now().millisecondsSinceEpoch,
            }));
          } catch (_) {}
        });

        // 鉴权超时：10s 内既没有 auth:ok 也没有 auth:error，就按「这条链路不能用」
        // 收掉。判据必须有时限——否则「连上了、心跳也在、但身份没被接受」这种
        // 形态会一直挂着，且看起来完全健康。
        authTimer = Timer(const Duration(seconds: 10), () {
          if (_authed) return;
          if (_authState == 'pending') {
            _authState = 'rejected';
            _authCode = 'auth_timeout';
            AppLogger().w(LogCategory.network, '链路鉴权超时：10s 内未收到 auth:ok');
            unawaited(_report(connected: false));
          }
          if (!done.isCompleted) done.complete();
        });

        // 收帧改成 listen + Completer，而不是 await for。
        //
        // WHY：对端被 kill、或链路半开（NAT/Doze 把 socket 留下但没人应答）时，
        // `await for` 会永远等下去——实测 2026-11-14 22:02 的 5 分钟断链里，
        // reconnect_count 停在 3 不再增长，因为循环卡在流上，连"该重连了"都没机会说。
        // 这里给流一个确定的收尾路径：onDone / onError / 看门狗，三选一必到。
        // done 在外层声明（鉴权超时与 auth:error 也要能触发收尾）。
        final sub = ch.stream.listen(
          _onFrame,
          onDone: () {
            if (!done.isCompleted) done.complete();
          },
          onError: (Object e) {
            AppLogger().w(LogCategory.network, 'BridgeLink 流错误: $e');
            if (!done.isCompleted) done.complete();
          },
          cancelOnError: true,
        );

        // 看门狗：pong 超过窗口没来就主动拆链路。
        //
        // WHY 必须靠 pong 而不是"连接是否还在"：TCP 半开时连接看起来还在，
        // 只有往返证据能证明对面还活着。窗口取 pongWindowMs（3 拍），Doze 下
        // 一次延迟就够判死，所以它只用于断链检测，不用于判定"服务端忙"。
        final watchdog = Timer.periodic(const Duration(seconds: 5), (_) {
          final now = DateTime.now().millisecondsSinceEpoch;
          // 还没有过任何 pong 时以「连上那一刻」为基准：否则一台连上就不说话的
          // 服务端会让看门狗永远不响（_lastPongMs 一直是 0）。
          final ref = _lastPongMs > 0 ? _lastPongMs : _connectedAtMs;
          if (ref > 0 && now - ref > cfg.pongWindowMs) {
            try {
              ch?.sink.close();
            } catch (_) {}
            if (!done.isCompleted) done.complete();
          }
        });

        // 三个 await 全部有界：这条链上任何一处无界等待，都会让整个重连循环停摆
        // ——2026-11-14 22:21 实测就是这么停的：对端死后 reconnect_count 卡在 2，
        // 而 Java 侧 status.json 还在每 2s 刷新，说明卡的是 Dart 这一侧。
        //
        // 但"有界"不等于"到点就拆"。原来这里写死 pongWindowMs + 10s（55s），
        // 健康链路也被每 55s 拆一次：2026-11-15 09:26 的 harness 计数是
        // connections=120 / auths=120 / pings=460，平均每条连接只活 3.8 拍。
        // 那不是断链检测，那是个连接寿命上限——而长连接的寿命不该由 pong 窗口决定。
        // 代价是实打实的：每次重连都有一个几秒的空窗，空窗里下发的 command 直接丢。
        //
        // 现在：按窗口切片等待，到点先复查 pong 是否真的过期，过期才拆，没过期
        // 就再等一个窗口。半开链路照样会被拆（看门狗也在独立盯着），健康链路
        // 却能一直留着。
        while (!done.isCompleted) {
          await done.future.timeout(
            Duration(milliseconds: cfg.pongWindowMs),
            onTimeout: () {},
          );
          if (done.isCompleted) break;
          final nowMs = DateTime.now().millisecondsSinceEpoch;
          final refMs = _lastPongMs > 0 ? _lastPongMs : _connectedAtMs;
          if (refMs <= 0 || nowMs - refMs > cfg.pongWindowMs) {
            try {
              ch.sink.close();
            } catch (_) {}
            if (!done.isCompleted) done.complete();
            break;
          }
        }
        watchdog.cancel();
        try {
          await sub.cancel().timeout(const Duration(seconds: 2));
        } catch (_) {}
      } catch (e) {
        AppLogger().w(LogCategory.network, 'BridgeLink 断开: $e');
      } finally {
        ping?.cancel();
        authTimer?.cancel();
        _sessionDone = null;
        _connected = false;
        // 连接没了，鉴权结论也就不成立了：留着 ok 会让下一次「刚连上还没验」
        // 的一瞬间被当成已鉴权。
        _authed = false;
        // 但 rejected 要留着。它描述的是「上一次尝试被谁拒、为什么」——这正是
        // 运维在 status.json 里最需要的那条信息。清掉就只剩 none，与「没配 endpoint」
        // 无从区分（实测过：清掉之后 link_auth 一路是 none，看着像根本没连）。
        if (_authState == 'ok' || _authState == 'pending') _authState = 'none';
        // 计数在「报告断开」之前自增：报告是异步的，而断链期间外部读
        // status.json 看到的必须是「已经断了几次」，不是「上一次连上时的旧值」。
        // 顺序反了就会在整段断网期间显示 0——那正好把最该看见的数字藏起来。
        _reconnectCount++;
        await _report(connected: false);
        // sink.close() 也必须有时限：对端已死时它返回的 Future 可能永远不完成，
        // 而它在 finally 里——一处无界等待就等于整个重连循环停摆。2026-11-14 22:48
        // 的实测形态正是这个：status.json 每 2s 还在刷新（Java 活着），
        // 而 reconnect_count 从 2 起再也不动（Dart 卡在 finally）。
        try {
          await ch?.sink.close().timeout(const Duration(seconds: 2));
        } catch (_) {}
      }
      if (!_running) break;
      // 指数退避：1,2,4,8,16,32,60,60…（不抖动是有意的——设备只有一条链路，
      // 抖动在这里只会让「多久恢复」变得不可预测）。
      await Future<void>.delayed(Duration(seconds: _backoffSec));
      _backoffSec = _backoffSec * 2 > _backoffMaxSec ? _backoffMaxSec : _backoffSec * 2;
    }
  }

  void _onFrame(dynamic frame) {
    if (frame is! String) return;
    Map<String, dynamic> msg;
    try {
      final decoded = jsonDecode(frame);
      if (decoded is! Map) return;
      msg = Map<String, dynamic>.from(decoded);
    } catch (_) {
      return;
    }
    final type = msg['type']?.toString() ?? '';
    if (type == 'auth:ok') {
      // 只有这一帧能证明「服务端接受了我的身份」。之前这条被静默忽略，
      // 于是「连上」被当成了「可用」。
      _authed = true;
      _authState = 'ok';
      _authCode = '';
      // 只有这里才把退避打回最小档：身份被接受 = 这条链路真的能用了。
      _backoffSec = 1;
      unawaited(_report(connected: true));
      return;
    }
    if (type == 'auth:error') {
      // 身份被拒：服务端给码（signature_invalid / device_not_enrolled / …）。
      // 这里必须主动收尾——不能等 pong 窗口，因为假对端（只回 pong 不认身份）
      // 会让看门狗永远不响，链路就一直挂在那儿装健康。
      final code = msg['code']?.toString().isNotEmpty == true
          ? msg['code'].toString()
          : (msg['error']?.toString() ?? 'auth_rejected');
      _authed = false;
      _authState = 'rejected';
      _authCode = code;
      AppLogger().w(LogCategory.network, '链路身份被服务端拒绝: $code', details: <String, dynamic>{
        'device_id': msg['deviceId']?.toString() ?? '',
        'code': code,
      });
      unawaited(_report(connected: false));
      final d = _sessionDone;
      if (d != null && !d.isCompleted) d.complete();
      return;
    }
    if (type == 'pong') {
      _lastPongMs = DateTime.now().millisecondsSinceEpoch;
      // pong 只证明「对面会说话」，不证明「对面认我」。未鉴权时只记时间，
      // 不报 connected=true——否则假对端回个 pong 就能把状态刷成在线。
      if (_authed) unawaited(_report(connected: true));
      return;
    }
    if (type == 'command') {
      unawaited(_runCommand(msg));
      return;
    }
    if (type == 'session:joined') {
      final id = msg['sessionId']?.toString() ?? '';
      if (id.isNotEmpty) _sessionId = id;
    }
  }

  /// 服务端下发的一条指令 → 走**已有的**控制台执行面。
  ///
  /// WHY 不另写一条执行路径：`KhyConsole.exec` 已经承担了解析、校验、执行、
  /// 落盘（console_history.jsonl）。在这里重写一遍，就会出现「链路收到的指令
  /// 与手动输入的命令走两套规则」——那是平行实现，也是安全面上最容易漏的一处。
  ///
  /// WHY 用 origin=link：回执里必须能看出这条不是人手敲的。origin 是自由串，
  /// PC 侧不校验取值（phoneBridgePolicy 无 origin 分支），所以加一个值不破坏读取方。
  Future<void> _runCommand(Map<String, dynamic> msg) async {
    final payload = msg['payload'] ?? msg['command'];
    final raw = payload is String ? payload : jsonEncode(payload);
    if (raw.trim().isEmpty) return;
    final sid = msg['sessionId']?.toString() ?? '';
    if (sid.isNotEmpty) _sessionId = sid;

    // 同一 msg_id 只执行一次（T15）。
    //
    // WHY 必须有：这条链路的投递语义是至少一次——服务端没等到回执就会重投，
    // 而"回执"要等命令真跑完才写进 console_history.jsonl。一条慢命令跑 8 秒，
    // 服务端 5 秒就重投，同一段命令就会被执行两遍、落两条历史。用户看到的是
    // 两个气泡，系统侧是两次真实副作用。
    //
    // WHY 先认领再执行：后认领的话，重投的第二帧在第一帧跑完之前进来，
    // 两个 check 都是 null，去重等于没做。
    //
    // WHY 复用 AmooMsgLog 而不是在这里再开一个 Set：K-20 的会话内 msg_id
    // 账本已经存在（amoo_bridge_adapter.dart:634），语义一字不差；另开一个
    // 就是同一件事的第二个真源。
    final mid = (msg['msg_id'] ?? msg['msgId'])?.toString() ?? '';
    if (mid.isNotEmpty) {
      final dup = _msgLog.check(mid);
      if (dup != null) {
        AppLogger().w(LogCategory.network, '链路指令重复投递，已丢弃',
            details: <String, dynamic>{
              'msg_id': mid,
              'code': dup.code,
            });
        return;
      }
      _msgLog.record(mid);
    }

    try {
      // 回执由原生侧写进 console_history.jsonl；这里不再重复写一份。
      await ConsoleService.exec(raw, origin: kConsoleOriginLink);
    } catch (e) {
      // 执行真的抛了：把 id 放回去，服务端重投才有救。吞掉的话这条指令
      // 既没执行、也不会再被执行——比重复执行更糟。
      if (mid.isNotEmpty) _msgLog.forget(mid);
      rethrow;
    }
  }

  Future<_LinkConfig?> _config() async {
    try {
      final r = await _channel.invokeMethod('bridgeLinkConfig')
          .timeout(const Duration(seconds: 5));
      if (r is! Map) return null;
      final ep = r['endpoint']?.toString() ?? '';
      if (ep.isEmpty) return null;
      return _LinkConfig(
        endpoint: ep,
        deviceId: r['deviceId']?.toString() ?? '',
        publicKey: r['publicKey']?.toString() ?? '',
        ts: (r['ts'] is int) ? r['ts'] as int : 0,
        sig: r['sig']?.toString() ?? '',
        deviceName: r['deviceName']?.toString() ?? '',
        platform: r['platform']?.toString() ?? 'android',
        heartbeatMs: (r['heartbeatMs'] is int) ? r['heartbeatMs'] as int : 15000,
        pongWindowMs: (r['pongWindowMs'] is int) ? r['pongWindowMs'] as int : 45000,
      );
    } catch (_) {
      return null;
    }
  }

  Future<void> _report({required bool connected}) async {
    status.set(
      connected: connected,
      reconnectCount: _reconnectCount,
      lastPongMs: _lastPongMs,
      authState: _authState,
      authCode: _authCode,
    );
    try {
      await _channel.invokeMethod('bridgeLinkState', {
        'connected': connected,
        'lastPongMs': _lastPongMs,
        'reconnectCount': _reconnectCount,
        'endpoint': _endpoint,
        // 鉴权结论必须跟着一起上报：status.json 的 link 只回答「走哪条路」，
        // 回答不了「服务端认不认我」。少了这两个字段，auth:error 会被显示成健康。
        'authState': _authState,
        'authCode': _authCode,
      }).timeout(const Duration(seconds: 3));
    } catch (_) {
      // 原生侧不在（例如单元测试里）：链路本身仍按自己的状态跑，不上抛。
    }
  }
}

class _LinkConfig {
  const _LinkConfig({
    required this.endpoint,
    required this.deviceId,
    required this.publicKey,
    required this.ts,
    required this.sig,
    required this.deviceName,
    required this.platform,
    required this.heartbeatMs,
    required this.pongWindowMs,
  });

  final String endpoint;

  /// 设备身份：公钥指纹（不是 ANDROID_ID——那是一个别人也读得到的系统字段）。
  final String deviceId;

  /// SPKI base64。服务端拿它验签，不需要任何共享秘密。
  final String publicKey;

  /// 签名时刻与签名本身。服务端据此判重放（ts 偏差窗口）。
  final int ts;
  final String sig;

  final String deviceName;
  final String platform;
  final int heartbeatMs;

  /// pong 多久没来算链路死（原生侧给 3 拍，Doze 下 pong 会迟到）。
  final int pongWindowMs;

  /// 身份材料是否齐全。不齐时链路仍可连，但服务端会拒——那是正确的失败，
  /// 比静默用空串连上去然后谁都说不清要好。
  bool get hasIdentity => deviceId.isNotEmpty && publicKey.isNotEmpty && sig.isNotEmpty;
}

/// 极小的状态容器：只给 UI 读，不引入 riverpod 依赖（这个类要能在纯 Dart
/// 测试里构造）。
class ValueNotifierLike {
  bool connected = false;
  int reconnectCount = 0;
  int lastPongMs = 0;

  /// none / pending / ok / rejected。UI 想区分「没配」「在连」「被拒」时读它。
  String authState = 'none';
  String authCode = '';

  void set({
    required bool connected,
    required int reconnectCount,
    required int lastPongMs,
    String authState = 'none',
    String authCode = '',
  }) {
    this.connected = connected;
    this.reconnectCount = reconnectCount;
    this.lastPongMs = lastPongMs;
    this.authState = authState;
    this.authCode = authCode;
  }
}
