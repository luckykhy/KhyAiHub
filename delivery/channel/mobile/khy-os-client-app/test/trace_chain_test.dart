import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/agent/execution_log.dart';
import 'package:khy_os_client/core/services/trajectory_store.dart';
import 'package:khy_os_client/core/trajectory/trace_chain.dart';
import 'package:khy_os_client/core/trajectory/trace_envelope.dart';
import 'package:khy_os_client/ui/screens/trajectory_screen.dart';
import 'package:path/path.dart' as p;

/// w8 轨迹确定性回放与溯源防投毒（一期）的单测。
///
/// 一个文件覆盖三层，因为本批只分配了一个测试文件：
///   - 边车哈希链（append / verify / verifyAgainstEntries / 字节契约）；
///   - 溯源信封（坍缩、fail-safe-to-ours、traceOf 兜底）；
///   - 轨迹库与轨迹屏（JSONL + 边车链落盘、quarantined 只显标签）。
///
/// 哈希常量由 Node crypto 计算后硬编码在此，**不是**被测 Dart 代码自算——
/// 链的哈希基是与 traceChain.js 的跨进程字节契约，用同一份代码验证自己没有意义。
/// 计算命令：
///   node -e "const c=require('crypto');const H=s=>c.createHash('sha256').update(s).digest('hex');
///     const basis=JSON.stringify({seq:0,uuid:'u0',prevHash:'0'.repeat(64),producer:'codex',
///     trust:'claimed',contentHash:H('hello'),at:123});console.log(H(basis))"

const String kNodeSha256Empty =
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const String kNodeSha256Hello =
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const String kNodeBasisHash =
    '9db20e2d80b33fb4657d6dfc031abfe4927e14a983b8bf87d4f5fee51d86a2be';
const String kNodeBasisNullHash =
    'fcb4685226dd620fc5e4734ded13b9864202c350ae6f48ef93042936514afc6d';

void main() {
  group('contentHash 与 chainPathFor', () {
    test('contentHash：null 坍缩到 sha256("")，字符串走原文', () {
      expect(contentHash(null), kNodeSha256Empty);
      expect(contentHash(''), contentHash(null));
      expect(contentHash('hello'), kNodeSha256Hello);
      // 与 crypto 包的独立复算一致（双保险，真源仍是上面的 Node 常量）
      expect(
        contentHash('hello'),
        sha256.convert(utf8.encode('hello')).toString(),
      );
    });

    test('chainPathFor：.jsonl 换扩展名、同目录，大小写后缀同样剥掉', () {
      expect(p.basename(chainPathFor(p.join('root', 's.jsonl'))), 's$chainExt');
      expect(
        p.basename(chainPathFor(p.join('root', 'A.JSONL'))),
        'A$chainExt',
      );
      expect(
        p.dirname(chainPathFor(p.join('root', 'sub', 's.jsonl'))),
        p.join('root', 'sub'),
      );
    });
  });

  group('边车哈希链', () {
    late Directory tempDir;
    var counter = 0;

    setUp(() {
      tempDir = Directory.systemTemp.createTempSync('khy-trace-chain');
      counter = 0;
    });

    tearDown(() {
      if (tempDir.existsSync()) tempDir.deleteSync(recursive: true);
    });

    String tmpChain(String tag) {
      counter += 1;
      return p.join(tempDir.path, '$tag-$counter$chainExt');
    }

    /// 建一条 N 链；每个 append 都必须落绿，否则先红在这里。
    Future<String> buildChain(String file, {int n = 3}) async {
      for (var i = 0; i < n; i++) {
        final r = await append(
          file,
          uuid: 'u$i',
          producer: 'codex',
          trust: 'claimed',
          content: 'body-$i',
          at: 1000 + i,
        );
        expect(r.ok, isTrue, reason: 'append #$i 应成功：${r.error}');
        expect(r.seq, i);
      }
      return file;
    }

    Future<List<Map<String, dynamic>>> readRawChain(String file) async {
      final decoded = jsonDecode(await File(file).readAsString());
      return (decoded as List)
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList();
    }

    Future<void> writeRawChain(
      String file,
      List<Map<String, dynamic>> chain,
    ) =>
        File(file).writeAsString(jsonEncode(chain));

    test('append 三条后 verify intact，prevHash 逐条相链、首条 genesis', () async {
      final f = await buildChain(tmpChain('link'));
      final v = await verify(f);
      expect(v.available, isTrue);
      expect(v.intact, isTrue);
      expect(v.length, 3);
      expect(v.brokenAt, isNull);
      expect(v.reason, isNull);

      final chain = await read(f);
      expect(chain.map((e) => e.seq).toList(), [0, 1, 2]);
      expect(chain[0].prevHash, genesisPrev);
      expect(chain[1].prevHash, chain[0].hash);
      expect(chain[2].prevHash, chain[1].hash);
    });

    test('链记录形状九键；seal 未移植（跨进程不可验，平台侧 verify 也忽略它）',
        () async {
      final f = tmpChain('shape');
      await append(
        f,
        uuid: 'a',
        producer: 'codex',
        trust: 'claimed',
        content: 'x',
      );
      final rec = (await read(f)).single;
      expect(rec.toJson().keys.toSet(), <String>{
        'version',
        'seq',
        'uuid',
        'prevHash',
        'producer',
        'trust',
        'contentHash',
        'at',
        'hash',
      });
    });

    test('哈希基与 Node 逐字节一致（跨进程契约，含 null 序列化）', () async {
      final f = tmpChain('basis');
      await append(
        f,
        uuid: 'u0',
        producer: 'codex',
        trust: 'claimed',
        content: 'hello',
        at: 123,
      );
      final rec = (await read(f)).single;
      expect(rec.hash, kNodeBasisHash);
      expect(rec.contentHash, kNodeSha256Hello);

      // 全空记录：null 序列化成 "uuid":null 而不是省略键——正是 JS
      // JSON.stringify 的行为，改这里整链与平台侧失联。
      final f2 = tmpChain('basis-null');
      await append(f2, at: 0);
      final bare = (await read(f2)).single;
      expect(bare.hash, kNodeBasisNullHash);
      expect(bare.contentHash, kNodeSha256Empty);
    });

    test('篡改 #1 的 contentHash → broken @ #1（疑似篡改）', () async {
      final f = await buildChain(tmpChain('tamper'));
      final chain = await readRawChain(f);
      chain[1]['contentHash'] = 'f' * 64;
      await writeRawChain(f, chain);

      final v = await verify(f);
      expect(v.intact, isFalse);
      expect(v.available, isTrue);
      expect(v.brokenAt, 1);
      expect(v.length, 3);
      expect(v.reason, '内容哈希不匹配于 #1（疑似篡改）');
    });

    test('篡改定位首坏块：#0 与 #2 同时坏只报 #0', () async {
      final f = await buildChain(tmpChain('firstbad'));
      final chain = await readRawChain(f);
      chain[0]['producer'] = 'khy-local';
      chain[2]['contentHash'] = 'b' * 64;
      await writeRawChain(f, chain);

      final v = await verify(f);
      expect(v.brokenAt, 0);
      expect(v.reason, '内容哈希不匹配于 #0（疑似篡改）');
    });

    test('prevHash 断链与 seq 跳号各自报出，判据顺序 seq 先于 prevHash', () async {
      final f = await buildChain(tmpChain('prevbreak'));
      final chain = await readRawChain(f);
      chain[1]['prevHash'] = 'e' * 64;
      await writeRawChain(f, chain);
      final v = await verify(f);
      expect(v.brokenAt, 1);
      expect(v.reason, 'prevHash 断链于 #1');

      final g = await buildChain(tmpChain('seqgap'));
      final gchain = await readRawChain(g);
      gchain[1]['seq'] = 5;
      await writeRawChain(g, gchain);
      final gv = await verify(g);
      expect(gv.brokenAt, 1);
      expect(gv.reason, 'seq 不连续：期望 1 实为 5');
    });

    test('verify 入口：缺文件 available=false；空链文件 intact 但 length 0', () async {
      final missing = p.join(tempDir.path, 'never$chainExt');
      final v = await verify(missing);
      expect(v.available, isFalse);
      expect(v.intact, isFalse);
      expect(v.reason, '链文件不存在');

      final empty = tmpChain('empty');
      await File(empty).writeAsString('[]');
      final ev = await verify(empty);
      expect(ev.available, isTrue);
      expect(ev.intact, isTrue);
      expect(ev.length, 0);
      // 真空绿钉死在此：调用方要报「已验证」必须先证明 length > 0。
    });

    test('边车损坏：报无法解析且拒绝续写（有意偏离 JS 的静默 []）', () async {
      final f = tmpChain('corrupt');
      await File(f).writeAsString('{{{ 不是 JSON');
      final v = await verify(f);
      expect(v.available, isTrue);
      expect(v.intact, isFalse);
      expect(v.reason, '链文件无法读取或解析');

      final r = await append(f, content: 'x');
      expect(r.ok, isFalse);
      expect(r.error, isNotNull);
    });

    test('append / verify 全函数性：打到目录路径只返错误不抛', () async {
      final dir = Directory(p.join(tempDir.path, 'iam-a-dir'));
      dir.createSync(recursive: true);
      final r = await append(dir.path, content: 'x');
      expect(r.ok, isFalse);
      expect(r.error, isNotNull);

      // File.exists() 对目录返回 false（Win/Linux 两平台一致，评审以 SDK 真源
      // 坐实），所以「路径是目录」必须与「没有链」分开报：把边车换成目录若读成
      // 「链文件不存在」，篡改就被洗成从无此链。
      final v = await verify(dir.path);
      expect(v.available, isTrue);
      expect(v.intact, isFalse);
      expect(v.reason, '链路径不是文件');
    });

    test('verifyAgainstEntries：行链一致 → intact', () async {
      final f = await buildChain(tmpChain('xae-ok'));
      final v = await verifyAgainstEntries(f, ['body-0', 'body-1', 'body-2']);
      expect(v.intact, isTrue);
      expect(v.length, 3);
      expect(v.brokenAt, isNull);
    });

    test('verifyAgainstEntries：改正文 → broken @ #1（疑似改正文）', () async {
      final f = await buildChain(tmpChain('xae-body'));
      final v = await verifyAgainstEntries(f, ['body-0', 'HACKED', 'body-2']);
      expect(v.intact, isFalse);
      expect(v.brokenAt, 1);
      expect(v.reason, 'transcript 正文哈希不匹配于 #1（疑似改正文）');
    });

    test('verifyAgainstEntries：删行 → 条数不符（位置对齐比 uuid 匹配多抓一种）',
        () async {
      final f = await buildChain(tmpChain('xae-del'));
      final v = await verifyAgainstEntries(f, ['body-0', 'body-1']);
      expect(v.intact, isFalse);
      expect(v.brokenAt, 2);
      expect(v.reason, contains('条数不符'));
    });

    test('verifyAgainstEntries：底层链已坏时透传链自身的判决', () async {
      final f = await buildChain(tmpChain('xae-base'));
      final chain = await readRawChain(f);
      chain[0]['producer'] = 'hacked';
      await writeRawChain(f, chain);
      final v = await verifyAgainstEntries(f, ['body-0', 'body-1', 'body-2']);
      expect(v.brokenAt, 0);
      expect(v.reason, '内容哈希不匹配于 #0（疑似篡改）');
    });
  });

  group('溯源信封', () {
    test('normalizeProducer：已知原样、空值归我方、未知坍缩 relay', () {
      expect(normalizeProducer('codex').producer, TraceProducer.codex);
      expect(normalizeProducer('codex', 's-42').producerId, 's-42');
      expect(normalizeProducer('relay', 42).producerId, '42');
      expect(normalizeProducer(null).producer, TraceProducer.khyLocal);
      expect(normalizeProducer('').producer, TraceProducer.khyLocal);
      // fail-safe 分支先返回，连传入的 producerId 一起丢
      expect(normalizeProducer('', 'x').producerId, isNull);
      final mystery = normalizeProducer('mystery-agent');
      expect(mystery.producer, TraceProducer.relay);
      expect(mystery.producerId, 'mystery-agent');
      expect(
        normalizeProducer('mystery-agent', 'real-id').producerId,
        'real-id',
      );
      expect(normalizeProducer(123).producerId, '123');
    });

    test('trust / kind 归一：我方缺 verified、外部缺 claimed、合法值原样', () {
      expect(
        TraceEnvelope.make(producer: TraceProducer.khyLocal).trust,
        TraceTrust.verified,
      );
      expect(
        TraceEnvelope.make(producer: TraceProducer.codex).trust,
        TraceTrust.claimed,
      );
      // 合法 trust 原样透传——外部标 verified 由调用方负责，归一律不拦
      expect(
        TraceEnvelope.make(
          producer: TraceProducer.codex,
          trust: TraceTrust.verified,
        ).trust,
        TraceTrust.verified,
      );
      expect(
        TraceEnvelope.make(producer: TraceProducer.khyLocal, trust: 'garbage')
            .trust,
        TraceTrust.verified,
      );
      expect(
        TraceEnvelope.make(producer: TraceProducer.relay, trust: '???').trust,
        TraceTrust.claimed,
      );
      expect(TraceEnvelope.make(kind: 'nonsense').kind, TraceKind.text);
      expect(
        TraceEnvelope.make(kind: TraceKind.toolResult).kind,
        TraceKind.toolResult,
      );
    });

    test('traceOf 永不返回 null：缺失/畸形信封走 fail-safe-to-ours', () {
      expect(traceOf(null).producer, TraceProducer.khyLocal);
      expect(traceOf(null).trust, TraceTrust.verified);
      expect(traceOf(const <String, dynamic>{}).producer,
          TraceProducer.khyLocal);
      // 信封里带未知 producer → 结构不合法 → 兜底归我方，而不是坍缩成 relay
      final bad = traceOf(<String, dynamic>{
        kTraceKey: <String, dynamic>{'producer': 'evil', 'trust': 'verified'}
      });
      expect(bad.producer, TraceProducer.khyLocal);
      expect(bad.trust, TraceTrust.verified);

      final stamped = stamp(
        <String, dynamic>{'role': 'assistant'},
        producer: TraceProducer.codex,
        trust: TraceTrust.claimed,
      );
      expect(entryHasTrace(stamped), isTrue);
      final got = traceOf(stamped);
      expect(got.producer, TraceProducer.codex);
      expect(got.trust, TraceTrust.claimed);

      expect(entryHasTrace(<String, dynamic>{'role': 'user'}), isFalse);
      expect(
        entryHasTrace(<String, dynamic>{kTraceKey: 'not-a-map'}),
        isFalse,
      );
      // stamp 不改写输入
      final entry = <String, dynamic>{'role': 'user'};
      stamp(entry, producer: TraceProducer.codex);
      expect(entry.containsKey(kTraceKey), isFalse);
    });

    test('isRelayed：已知外部 true，我方与未知串 false', () {
      expect(isRelayed(TraceProducer.codex), isTrue);
      expect(isRelayed('claude-code'), isTrue);
      expect(isRelayed(TraceProducer.khyLocal), isFalse);
      expect(isRelayed('mystery-agent'), isFalse);
    });

    test('信封 JSON 往返保留全部字段', () {
      final env = TraceEnvelope.make(
        producer: TraceProducer.codex,
        producerId: 's1',
        trust: TraceTrust.claimed,
        kind: TraceKind.toolCall,
        at: 5,
      );
      final decoded = TraceEnvelope.fromJson(
        jsonDecode(jsonEncode(env.toJson())) as Map<String, dynamic>,
      );
      expect(decoded, isNotNull);
      expect(decoded!.producer, TraceProducer.codex);
      expect(decoded.producerId, 's1');
      expect(decoded.trust, TraceTrust.claimed);
      expect(decoded.kind, TraceKind.toolCall);
      expect(decoded.at, 5);
      expect(decoded.toJson()['v'], traceVersion);
    });
  });

  group('ExecutionStep 附加式扩展', () {
    test('不设新字段时 toJson 与扩展前逐键一致', () {
      final step = ExecutionStep(index: 1, toolName: 'shell', args: {'a': 1});
      expect(step.toJson().keys.toSet(), <String>{
        'index',
        'tool',
        'args',
        'state',
        'start',
        'duration_ms',
      });
    });

    test('新字段落进 toJson，并随 ExecutionLog 的 steps 一起上报', () {
      final step = ExecutionStep(
        index: 1,
        toolName: 'apply_patch',
        args: const {},
        seq: 3,
        paramsHash: 'deadbeef',
        artifacts: const [
          TraceArtifact(path: '/a.txt', sha256: 'cafe', op: 'create'),
        ],
        tier: ReplayTier.file,
      );
      final json = step.toJson();
      expect(json['seq'], 3);
      expect(json['params_hash'], 'deadbeef');
      expect(json['tier'], 'FILE');
      expect(json['artifacts'], [
        {'path': '/a.txt', 'sha256': 'cafe', 'op': 'create'},
      ]);

      final log = ExecutionLog(
        conversationId: 'c1',
        userMessage: 'u',
        steps: [step],
      );
      final logJson = log.toJson();
      expect((logJson['steps'] as List).single['tier'], 'FILE');
    });
  });

  group('TrajectoryStore', () {
    late Directory tempDir;
    late TrajectoryStore store;

    setUp(() {
      tempDir = Directory.systemTemp.createTempSync('khy-traj-store');
      store = TrajectoryStore(directoryPath: tempDir.path);
    });

    tearDown(() {
      if (tempDir.existsSync()) tempDir.deleteSync(recursive: true);
    });

    ExecutionLog logWith({
      required String conversationId,
      String tool = 'shell',
      Map<String, dynamic> args = const {'cmd': 'ls'},
      String outcome = 'ok',
    }) {
      final log = ExecutionLog(
        conversationId: conversationId,
        userMessage: 'u',
      );
      final i = log.addStep(tool, args);
      log.steps[i].complete(outcome);
      return log;
    }

    test('追加后：JSONL + 边车链落盘，记录带信封与 paramsHash', () async {
      await store.appendExecutionLog(logWith(conversationId: 'conv_w8'));

      final jsonl = File(p.join(tempDir.path, 'trajectories', 'conv_w8.jsonl'));
      expect(await jsonl.exists(), isTrue);
      expect(await File(chainPathFor(jsonl.path)).exists(), isTrue);

      final records = await store.readSession('conv_w8');
      expect(records, hasLength(1));
      final rec = records.single;
      expect(rec.seq, 0);
      expect(rec.tool, 'shell');
      expect(rec.envelope.producer, TraceProducer.khyLocal);
      expect(rec.envelope.trust, TraceTrust.verified);
      expect(rec.envelope.kind, TraceKind.toolResult);
      expect(rec.paramsHash, contentHash(jsonEncode({'cmd': 'ls'})));

      final v = await store.verifySession('conv_w8');
      expect(v.available, isTrue);
      expect(v.intact, isTrue);
      expect(v.length, 1);
    });

    test('两次追加 seq 接续，链仍完好', () async {
      await store.appendExecutionLog(logWith(conversationId: 'conv_w8'));
      final second = ExecutionLog(conversationId: 'conv_w8', userMessage: 'u');
      second.addStep('read', const {});
      second.addStep('write', const {});
      await store.appendExecutionLog(second);

      final records = await store.readSession('conv_w8');
      expect(records.map((r) => r.seq).toList(), [0, 1, 2]);
      final v = await store.verifySession('conv_w8');
      expect(v.intact, isTrue);
      expect(v.length, 3);
    });

    test('调用方给的 seq/paramsHash/artifacts/tier 原样入记录', () async {
      final step = ExecutionStep(
        index: 1,
        toolName: 'apply_patch',
        args: const {},
        paramsHash: 'deadbeef',
        artifacts: const [
          TraceArtifact(path: '/a.txt', sha256: 'cafe', op: 'create'),
        ],
        tier: ReplayTier.file,
      );
      await store.appendExecutionLog(
        ExecutionLog(conversationId: 'conv_t', userMessage: 'u', steps: [step]),
      );
      final rec = (await store.readSession('conv_t')).single;
      expect(rec.paramsHash, 'deadbeef');
      expect(rec.tier, ReplayTier.file);
      expect(rec.artifacts.single.path, '/a.txt');
    });

    test('quarantined 信任级随整轮落入信封', () async {
      await store.appendExecutionLog(
        logWith(conversationId: 'conv_q'),
        trust: TraceTrust.quarantined,
      );
      final rec = (await store.readSession('conv_q')).single;
      expect(rec.envelope.trust, TraceTrust.quarantined);
    });

    test('改 JSONL 正文而链未重算 → verifySession 报 broken', () async {
      await store.appendExecutionLog(logWith(conversationId: 'conv_w8'));
      final jsonl = File(p.join(tempDir.path, 'trajectories', 'conv_w8.jsonl'));
      final lines = await jsonl.readAsLines();
      lines[0] = lines[0].replaceAll('shell', 'hacked');
      await jsonl.writeAsString('${lines.join('\n')}\n');

      final v = await store.verifySession('conv_w8');
      expect(v.intact, isFalse);
      expect(v.brokenAt, 0);
      expect(v.reason, contains('疑似改正文'));
    });

    test('listSessions：newest first，带链状态', () async {
      await store.appendExecutionLog(logWith(conversationId: 'conv_a'));
      await store.appendExecutionLog(logWith(conversationId: 'conv_b'));
      final sessions = await store.listSessions();
      expect(sessions, hasLength(2));
      expect(sessions.first.recordCount, 1);
      expect(sessions.first.chain.intact, isTrue);
      expect(sessions.first.chain.length, 1);
    });
  });

  group('轨迹屏', () {
    late Directory tempDir;
    late TrajectoryStore store;

    setUp(() {
      tempDir = Directory.systemTemp.createTempSync('khy-traj-screen');
      store = TrajectoryStore(directoryPath: tempDir.path);
    });

    tearDown(() {
      if (tempDir.existsSync()) tempDir.deleteSync(recursive: true);
    });

    /// 规则 2：四态里任何一态都不许出现含糊措辞。
    void expectNoVagueTokens(WidgetTester tester) {
      final texts = find
          .byType(Text)
          .evaluate()
          .map((e) => (e.widget as Text).data ?? '')
          .where((s) => s.isNotEmpty);
      for (final token in const <String>[
        '处理中',
        '正在工作',
        '尝试连接',
        '请稍候',
        'Loading',
        'loading',
        'Connecting',
        'connecting',
        'Processing',
        'processing',
      ]) {
        expect(texts.any((t) => t.contains(token)), isFalse,
            reason: '状态文本命中含糊措辞「$token」');
      }
    }

    testWidgets('空态：暂无轨迹记录，不白屏', (tester) async {
      await tester.pumpWidget(
        MaterialApp(home: TrajectoryScreen(store: store)),
      );
      await tester.pumpAndSettle();
      expect(find.text('暂无轨迹记录'), findsOneWidget);
      expectNoVagueTokens(tester);
      expect(tester.takeException(), isNull);
    });

    testWidgets('有数据：链完好标签 + 明细信任标签', (tester) async {
      final log = ExecutionLog(conversationId: 'conv_w8', userMessage: 'u');
      final i = log.addStep('shell', const {'cmd': 'ls'});
      log.steps[i].complete('done');
      await store.appendExecutionLog(log);

      await tester.pumpWidget(
        MaterialApp(home: TrajectoryScreen(store: store)),
      );
      await tester.pumpAndSettle();
      expect(find.text('conv_w8'), findsOneWidget);
      expect(find.text('链完好 · 1 条'), findsOneWidget);

      await tester.tap(find.text('conv_w8'));
      await tester.pumpAndSettle();
      expect(find.text('shell'), findsOneWidget);
      expect(find.text('已验真'), findsOneWidget);
      // 状态行是中文（ExecState.name 不许直达中文 UI），摘要单独一行
      expect(find.textContaining('· 成功 ·'), findsOneWidget);
      expect(find.textContaining('成功 ('), findsOneWidget);
      expectNoVagueTokens(tester);
      expect(tester.takeException(), isNull);
    });

    testWidgets('quarantined 只显标签不回显原文', (tester) async {
      const payload = '隔离载荷-7f3a9d';
      final log = ExecutionLog(conversationId: 'conv_q', userMessage: 'u');
      final i = log.addStep('shell', const {'cmd': 'rm -rf /'});
      log.steps[i].fail(payload);
      await store.appendExecutionLog(log, trust: TraceTrust.quarantined);

      await tester.pumpWidget(
        MaterialApp(home: TrajectoryScreen(store: store)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('conv_q'));
      await tester.pumpAndSettle();

      expect(find.text('已隔离'), findsOneWidget);
      expect(find.text('内容已隔离，不回显'), findsOneWidget);
      expect(find.textContaining(payload), findsNothing,
          reason: 'quarantined 记录只显标签，正文不许上屏');
      expectNoVagueTokens(tester);
    });

    testWidgets('未终态步：不渲染无进度的「执行中...」，改给「第 N 条」', (tester) async {
      // 审批闸扣住一步、其余步还在跑时也会追加轨迹——那时的 summary 是
      // 「执行中...」，没有进度信号，不许上屏。
      final log = ExecutionLog(conversationId: 'conv_run', userMessage: 'u');
      final i = log.addStep('shell', const {'cmd': 'sleep 30'});
      log.steps[i].start();
      await store.appendExecutionLog(log);

      await tester.pumpWidget(
        MaterialApp(home: TrajectoryScreen(store: store)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('conv_run'));
      await tester.pumpAndSettle();

      expect(find.text('执行中...'), findsNothing);
      expect(find.textContaining('执行中 · 第 1 条'), findsOneWidget);
      expectNoVagueTokens(tester);
    });
  });
}
