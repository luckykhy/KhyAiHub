/// Security guard — the phone-side half of the three-layer content defense.
///
/// Ported from the desktop `securityGuardService.js`
/// (runtime/node/backend/src/services/securityGuardService.js, 1,231 lines):
///   L1  input injection / extraction detection  → [SecurityGuard.analyzeInput]
///   L2  output sanitization                    → [SecurityGuard.sanitizeOutput]
///   L3  suspicious-rate cooldown               → 60s window, 3 hits, 5min lock
///
/// Deliberately plain Dart — no Flutter import — so the guard runs (and is
/// testable) anywhere the client runs, same as core/config.
///
/// What is NOT ported, and why:
///   · env gates (KHY_AI_UNRESTRICTED / KHY_AI_TECH_DETAILS /
///     GATEWAY_PREFERRED_ADAPTER): a phone app has no process env to read. The
///     desktop *defaults* are the behavior here. KHY_SECURITY_COOLDOWN_SANE is
///     default-on on desktop, so it is unconditional here — that gate is the
///     fix for "我说继续，还被冷却中断了".
///   · the security.log JSONL file: events live in memory (capped buffer +
///     cumulative counter) and feed [SecurityGuard.getSecurityStats]. A file
///     in app-private storage would be a second truth with no reader.
///   · scanForThreats / checkProcessIntegrity / analyzeCommand / the process
///     monitor: those guard the Node server and the shell, neither of which
///     lives on the phone.
library;

import 'dart:math' as math;

/// Severity ladder. Ordinal via [rank] — same ascending order as the desktop
/// SEVERITY_ORDER, so a severity means the same thing on both surfaces.
enum ThreatSeverity {
  low(0),
  medium(1),
  high(2),
  critical(3);

  const ThreatSeverity(this.rank);

  final int rank;
}

/// Verdict of one input analysis. Mirrors the desktop analyzeInput() shape.
class InputVerdict {
  final bool safe;

  /// Threat id from the desktop vocabulary (e.g. 'ignore_instructions').
  /// Non-null iff [safe] is false.
  final String? threat;
  final ThreatSeverity? severity;

  /// 0..0.95 — multi-signal boost, more matches = higher.
  final double confidence;

  /// User-facing refusal, non-null iff [safe] is false.
  final String? refusal;

  /// Every threat id that matched, not just the primary one.
  final List<String> allMatches;

  const InputVerdict({
    required this.safe,
    this.threat,
    this.severity,
    this.confidence = 0,
    this.refusal,
    this.allMatches = const <String>[],
  });

  static const InputVerdict allow = InputVerdict(safe: true);
}

/// One recorded security event. Same fields the desktop writes to
/// security.log, minus the file.
class SecurityEvent {
  final DateTime timestamp;
  final String type;
  final String threat;
  final ThreatSeverity severity;
  final List<String> allMatches;

  /// Input truncated to 200 chars, like the desktop log line.
  final String input;
  final bool blocked;

  const SecurityEvent({
    required this.timestamp,
    required this.type,
    required this.threat,
    required this.severity,
    required this.allMatches,
    required this.input,
    required this.blocked,
  });
}

/// Cumulative + last-24h counters for the settings readout.
class SecurityStats {
  /// Cumulative since process start — survives event eviction from the
  /// retained buffer.
  final int totalEvents;
  final int last24h;

  /// threat id → count, over retained events (not the full cumulative set).
  final Map<String, int> byType;

  /// Last 10 retained events of the last 24h.
  final List<SecurityEvent> recentEvents;

  const SecurityStats({
    required this.totalEvents,
    required this.last24h,
    required this.byType,
    required this.recentEvents,
  });
}

class SecurityGuard {
  SecurityGuard._();

  static final SecurityGuard instance = SecurityGuard._();

  /// Clock seam. Tests swap it to walk the 60s window and the 5min cooldown
  /// without sleeping; production code must not touch it.
  DateTime Function() clock = DateTime.now;

  late DateTime _windowStart = clock();
  int _suspiciousCount = 0;
  DateTime? _cooldownUntil;

  /// Cumulative event count since process start. Deliberately separate from
  /// [_events]: the retained buffer is capped, and the stats readout must
  /// still be able to say how many events happened in total.
  int _totalEventCount = 0;
  final List<SecurityEvent> _events = <SecurityEvent>[];

  /// Drops rate-limit state and the in-memory event log. Test seam — a running
  /// app keeps its counters for the process lifetime, and there is no
  /// security.log on the phone to reload them from.
  void reset() {
    _suspiciousCount = 0;
    _windowStart = clock();
    _cooldownUntil = null;
    _totalEventCount = 0;
    _events.clear();
  }

  // ─── Layer 1: input injection detection ───────────────────────────────────

  /// Analyze user input for injection / extraction attempts.
  ///
  /// Order matters: a pure continuation is allowed before the cooldown check
  /// (a bare "继续" must never be swallowed by an active lockout), and the
  /// cooldown is checked before the patterns (a locked user is refused without
  /// re-scanning).
  InputVerdict analyzeInput(String userMessage) {
    if (userMessage.isEmpty) return InputVerdict.allow;

    if (_isBenignContinuation(userMessage)) return InputVerdict.allow;

    final now = clock();
    final cooldownUntil = _cooldownUntil;
    if (cooldownUntil != null && now.isBefore(cooldownUntil)) {
      final remaining =
          (cooldownUntil.difference(now).inMilliseconds / 1000).ceil();
      return InputVerdict(
        safe: false,
        threat: 'rate_limited',
        severity: ThreatSeverity.critical,
        confidence: 1,
        refusal: '操作过于频繁，请稍后再试。冷却时间剩余: $remaining 秒',
      );
    }

    final matches = <String>[];
    for (final entry in _injectionPatterns) {
      if (entry.pattern.hasMatch(userMessage)) matches.add(entry.threat);
    }
    if (matches.isEmpty) return InputVerdict.allow;

    // First threat whose severity strictly exceeds every earlier one wins —
    // same tie-break as the desktop loop.
    var highest = ThreatSeverity.low;
    var primary = matches.first;
    for (final threat in matches) {
      final sev = _threatSeverity[threat] ?? ThreatSeverity.medium;
      if (sev.rank > highest.rank) {
        highest = sev;
        primary = threat;
      }
    }

    final confidence = math.min(0.95, 0.7 + matches.length * 0.08);

    _recordSuspicious(primary, userMessage, highest, matches);

    return InputVerdict(
      safe: false,
      threat: primary,
      severity: highest,
      confidence: confidence,
      refusal: _refusal,
      allMatches: matches,
    );
  }

  // ─── Layer 2: output sanitization ─────────────────────────────────────────

  /// Sanitize an AI reply before it reaches the screen or the conversation
  /// store.
  String sanitizeOutput(String aiResponse) {
    if (aiResponse.isEmpty) return aiResponse;
    var out = aiResponse;
    for (final entry in _leakPatterns) {
      out = out.replaceAll(entry.pattern, entry.replacement);
    }
    return out;
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  SecurityStats getSecurityStats() {
    final dayAgo = clock().subtract(const Duration(hours: 24));
    final byType = <String, int>{};
    var last24h = 0;
    for (final event in _events) {
      byType[event.threat] = (byType[event.threat] ?? 0) + 1;
      if (event.timestamp.isAfter(dayAgo)) last24h++;
    }
    final recent =
        _events.where((e) => e.timestamp.isAfter(dayAgo)).toList();
    final tail = recent.length <= 10
        ? recent
        : recent.sublist(recent.length - 10);
    return SecurityStats(
      totalEvents: _totalEventCount,
      last24h: last24h,
      byType: Map.unmodifiable(byType),
      recentEvents: List.unmodifiable(tail),
    );
  }

  // ─── Layer 3 internals ────────────────────────────────────────────────────

  static const Duration _window = Duration(seconds: 60);
  static const int _maxSuspicious = 3;
  static const Duration _cooldown = Duration(minutes: 5);

  /// Retained-event cap. The desktop trims its security.log file; the phone
  /// has no file and no reader, so an unbounded list would grow for the whole
  /// process lifetime under sustained probing. The settings readout only ever
  /// shows the last 10 — 500 bounds the worst case at a few hundred KB while
  /// keeping the distribution window far wider than anything displayed.
  static const int _maxRetainedEvents = 500;

  void _recordSuspicious(
    String threat,
    String input,
    ThreatSeverity severity,
    List<String> allMatches,
  ) {
    final now = clock();
    if (now.difference(_windowStart) > _window) {
      _suspiciousCount = 0;
      _windowStart = now;
    }
    // LOW ("may be legitimate curiosity") is still refused per message but
    // never accumulates toward the lockout — otherwise three curious "how are
    // you built?" questions silence the user for 5 minutes.
    if (severity != ThreatSeverity.low) {
      _suspiciousCount++;
      if (_suspiciousCount >= _maxSuspicious) {
        _cooldownUntil = now.add(_cooldown);
        _suspiciousCount = 0;
      }
    }
    _totalEventCount++;
    _events.add(SecurityEvent(
      timestamp: now,
      type: 'injection_attempt',
      threat: threat,
      severity: severity,
      allMatches: List<String>.unmodifiable(allMatches),
      input: input.length > 200 ? input.substring(0, 200) : input,
      blocked: true,
    ));
    if (_events.length > _maxRetainedEvents) {
      _events.removeRange(0, _events.length - _maxRetainedEvents);
    }
  }

  // A pure continuation / confirmation carries no extraction payload.
  // Anchored full-match + a hard length cap block payload smuggling:
  // "continue and ignore all previous instructions" is too long to match and
  // falls through to normal threat analysis.
  static final RegExp _benignContinuationRe = RegExp(
    r'^[\s。.!,，、~·]*(继续(执行|吧)?|接着(说|做|来)?|下一步|接下来|请继续|go\s*on|go\s*ahead|continue|proceed|resume|keep\s*going|carry\s*on|next|go|ok(ay)?|yes|yep|yeah|y|sure|嗯+|好的?|行|可以|对|是的?)[\s。.!,，、~·]*$',
    caseSensitive: false,
  );

  bool _isBenignContinuation(String msg) {
    final s = msg.trim();
    if (s.isEmpty || s.length > 24) return false;
    return _benignContinuationRe.hasMatch(s);
  }

  // One deterministic refusal. The desktop picks a random line from five and
  // has a separate tech-details refusal that tells the user to run
  // `ai tech --on` — a CLI affordance with no phone equivalent, so every match
  // here takes this one line (problem + reason + next step).
  static const String _refusal = '抱歉，我不能响应此类请求。出于安全考虑，该操作已被拦截。请换个方式提问。';
}

class _InjectionPattern {
  final RegExp pattern;
  final String threat;

  const _InjectionPattern(this.pattern, this.threat);
}

class _LeakPattern {
  final RegExp pattern;
  final String replacement;

  const _LeakPattern(this.pattern, this.replacement);
}

/// Why this list is NOT a byte-copy of the desktop LEAK_PATTERNS.
///
/// The desktop guard rewrites every `backend/src/` and `frontend/src/`
/// occurrence. That is safe there because the PC system prompt never publishes
/// the repo layout — a source path in a reply can only have come from a leak.
/// The phone prompt is built from project_profile.g.dart, which puts the repo
/// layout (runtime/node/backend/, works/record/ai/, docs/10_规范/ …) into the
/// system prompt as first-class content and tells the AI to answer structure
/// questions from it. A blanket path rewrite here would shred normal answers
/// ("路由在 runtime/node/backend/src/cli/router.js 下") — pinned by
/// test/security_guard_test.dart. So the two repo-path rewrites are dropped,
/// and the module-name category is re-aimed at internals the phone prompt does
/// NOT publish: the client's own Dart services and the amoo bridge protocol.
/// The desktop backend-service names stay, because the phone AI reaches the
/// same backend through the same gateway.
///
/// `final` not `const`: Dart's RegExp constructor is not const-constructible,
/// so the table cannot live in the const pool. It is still built once, on
/// first use.
final List<_LeakPattern> _leakPatterns = <_LeakPattern>[
  _LeakPattern(RegExp(r'process\.env\.[A-Z_]+', caseSensitive: false), '[环境变量]'),
  _LeakPattern(RegExp(r'SYSTEM_PROMPT', caseSensitive: false), '[系统配置]'),
  _LeakPattern(
      RegExp(r"""require\(\s*['"][^'"]*[Ss]ervice[^'"]*['"]\s*\)""",
          caseSensitive: false),
      '[内部引用]'),
  _LeakPattern(
      RegExp(r"""require\(\s*['"][^'"]*[Aa]dapter[^'"]*['"]\s*\)""",
          caseSensitive: false),
      '[内部引用]'),
  _LeakPattern(RegExp(r'node_modules/', caseSensitive: false), '[依赖]'),
  _LeakPattern(RegExp(r'const\s+\w+\s*=\s*require\(', caseSensitive: false),
      '[代码片段]'),
  _LeakPattern(RegExp(r'\.khyquant/(config|security|token_usage)', caseSensitive: false),
      '[用户数据]'),
  _LeakPattern(
      RegExp(
          r'tradingAgentsService|aiGateway|multiFreeService|securityGuard|modelTrainingService|tokenUsageService|growthService|knowledgeTeachingService|agentCommunication',
          caseSensitive: false),
      '[内部模块]'),
  _LeakPattern(
      RegExp(
          r'amooAsk|lastChatBlock|amooChatService|agentLoop|conversationDb|shellExecutor|deviceControl|localModelStore|khyOsApi|logStore|appLogger',
          caseSensitive: false),
      '[内部模块]'),
];

/// L1 patterns. Ported 1:1 from the desktop INJECTION_PATTERNS (31 entries —
/// the desktop table, not an invented superset). Threat ids are the shared
/// vocabulary of the security stack, so they stay byte-identical.
///
/// `final` for the same reason as the leak table above: RegExp has no const
/// constructor.
final List<_InjectionPattern> _injectionPatterns = <_InjectionPattern>[
  // Direct prompt extraction (English)
  _InjectionPattern(
      RegExp(
          r'ignore\s*(all\s*)?(previous|prior|above|earlier)\s*(instruction|prompt|context|rule)',
          caseSensitive: false),
      'ignore_instructions'),
  _InjectionPattern(
      RegExp(
          r'show\s*(me\s*)?(the\s*)?(your\s*)?(system|hidden|internal|original)\s*(prompt|instruction|message)',
          caseSensitive: false),
      'show_prompt'),
  _InjectionPattern(
      RegExp(
          r'repeat\s*(everything|all|the\s*text|content|word)\s*(above|before|prior|previous)',
          caseSensitive: false),
      'repeat_above'),
  _InjectionPattern(
      RegExp(
          r'what\s*(are|is|were)\s*(your|the)\s*(system\s*)?(instruction|prompt|rule|directive)',
          caseSensitive: false),
      'ask_instructions'),
  _InjectionPattern(
      RegExp(
          r'print\s*(your|the|all)\s*(system\s*)?(prompt|instruction|rule|config)',
          caseSensitive: false),
      'print_prompt'),
  _InjectionPattern(
      RegExp(
          r'output\s*(your|the)\s*(initial|first|system)\s*(prompt|message|instruction)',
          caseSensitive: false),
      'output_prompt'),
  _InjectionPattern(
      RegExp(
          r'tell\s*me\s*(your|the)\s*(system|hidden)\s*(prompt|instruction)',
          caseSensitive: false),
      'tell_prompt'),
  _InjectionPattern(
      RegExp(r'reveal\s*(your|the|hidden)\s*(prompt|instruction|system)',
          caseSensitive: false),
      'reveal_prompt'),
  _InjectionPattern(
      RegExp(r'dump\s*(your|the|all)\s*(prompt|instruction|config|context)',
          caseSensitive: false),
      'dump_prompt'),
  _InjectionPattern(
      RegExp(
          r'act\s*as\s*(if|though)\s*you\s*(have\s*)?no\s*(restriction|rule|limit)',
          caseSensitive: false),
      'remove_restrictions'),
  _InjectionPattern(
      RegExp(
          r'pretend\s*(you\s*)?(are|have)\s*no\s*(rule|restriction|limit|constraint)',
          caseSensitive: false),
      'pretend_no_rules'),
  _InjectionPattern(
      RegExp(r'you\s*are\s*now\s*(free|unrestricted|unfiltered|DAN)',
          caseSensitive: false),
      'jailbreak_dan'),
  _InjectionPattern(
      RegExp(
          r'disregard\s*(all|any|previous)\s*(safety|instruction|rule|guideline)',
          caseSensitive: false),
      'disregard_safety'),

  // Source code / architecture probing
  _InjectionPattern(
      RegExp(
          r'show\s*(me\s*)?(your|the)\s*(source|code|implementation|backend|codebase)',
          caseSensitive: false),
      'code_extraction'),
  _InjectionPattern(RegExp(r'(source|code)\s*(structure|architecture|layout|tree)',
      caseSensitive: false), 'code_structure'),
  _InjectionPattern(
      RegExp(r'what\s*(files|modules|services|classes|functions)\s*(do\s*you|are\s*there)',
          caseSensitive: false),
      'enumerate_files'),
  _InjectionPattern(
      RegExp(r'list\s*(your|all|the)\s*(internal|backend|service|module|file)',
          caseSensitive: false),
      'list_internals'),
  _InjectionPattern(
      RegExp(
          r'how\s*(are|is)\s*(you|your\s*system|the\s*backend)\s*(built|implemented|coded)',
          caseSensitive: false),
      'implementation_details'),

  // Training data extraction
  _InjectionPattern(
      RegExp(
          r'show\s*(me\s*)?(your|the|all)\s*(training|fine-?tun|dataset)\s*(data|set|example)',
          caseSensitive: false),
      'training_data'),
  _InjectionPattern(
      RegExp(r'export\s*(all|your|the)\s*(data|knowledge|training|model\s*weights)',
          caseSensitive: false),
      'export_data'),
  _InjectionPattern(
      RegExp(r'what\s*(data|examples?)\s*(were|was)\s*you\s*trained\s*on',
          caseSensitive: false),
      'training_source'),

  // Chinese variants
  _InjectionPattern(RegExp(r'忽略.{0,10}(指令|规则|限制|提示)', caseSensitive: false),
      'cn_ignore_rules'),
  _InjectionPattern(
      RegExp(r'(显示|展示|输出|打印|告诉).{0,10}(系统|内部|隐藏).{0,10}(提示|指令|prompt)',
          caseSensitive: false),
      'cn_show_prompt'),
  _InjectionPattern(
      RegExp(r'重复.{0,10}(上面|之前|以上|前面).{0,10}(内容|文字|所有)',
          caseSensitive: false),
      'cn_repeat_above'),
  _InjectionPattern(
      RegExp(r'(你的|系统的).{0,10}(源代码|源码|代码|实现)', caseSensitive: false),
      'cn_source_code'),
  _InjectionPattern(
      RegExp(r'(查看|获取|提取).{0,10}(训练|模型).{0,10}(数据|样本)',
          caseSensitive: false),
      'cn_training_data'),
  _InjectionPattern(
      RegExp(r'(假装|扮演).{0,10}(没有|无).{0,10}(限制|规则|约束)',
          caseSensitive: false),
      'cn_no_restrictions'),
  _InjectionPattern(RegExp(r'角色扮演.{0,20}(无限制|DAN|越狱)', caseSensitive: false),
      'cn_jailbreak'),
  _InjectionPattern(
      RegExp(r'(你|系统).{0,10}(由什么|用什么).{0,10}(编写|开发|构建)',
          caseSensitive: false),
      'cn_how_built'),
  _InjectionPattern(
      RegExp(r'(列出|列举).{0,10}(所有|全部).{0,10}(文件|模块|服务|接口)',
          caseSensitive: false),
      'cn_list_files'),
  _InjectionPattern(RegExp(r'(泄露|暴露|透露).{0,10}(内部|系统|隐藏)', caseSensitive: false),
      'cn_leak'),
];

/// Threat id → severity. Same mapping as the desktop THREAT_SEVERITY_MAP.
const Map<String, ThreatSeverity> _threatSeverity = <String, ThreatSeverity>{
  // Low: may be legitimate curiosity
  'code_extraction': ThreatSeverity.low,
  'code_structure': ThreatSeverity.low,
  'enumerate_files': ThreatSeverity.low,
  'list_internals': ThreatSeverity.low,
  'implementation_details': ThreatSeverity.low,
  'cn_source_code': ThreatSeverity.low,
  'cn_how_built': ThreatSeverity.low,
  'cn_list_files': ThreatSeverity.low,
  // Medium: probing or extraction
  'show_prompt': ThreatSeverity.medium,
  'ask_instructions': ThreatSeverity.medium,
  'print_prompt': ThreatSeverity.medium,
  'output_prompt': ThreatSeverity.medium,
  'tell_prompt': ThreatSeverity.medium,
  'reveal_prompt': ThreatSeverity.medium,
  'dump_prompt': ThreatSeverity.medium,
  'repeat_above': ThreatSeverity.medium,
  'cn_show_prompt': ThreatSeverity.medium,
  'cn_repeat_above': ThreatSeverity.medium,
  'cn_leak': ThreatSeverity.medium,
  'training_data': ThreatSeverity.medium,
  'export_data': ThreatSeverity.medium,
  'training_source': ThreatSeverity.medium,
  'cn_training_data': ThreatSeverity.medium,
  // High: active attack
  'ignore_instructions': ThreatSeverity.high,
  'disregard_safety': ThreatSeverity.high,
  'remove_restrictions': ThreatSeverity.high,
  'pretend_no_rules': ThreatSeverity.high,
  'cn_ignore_rules': ThreatSeverity.high,
  'cn_no_restrictions': ThreatSeverity.high,
  // Critical: jailbreak attempts
  'jailbreak_dan': ThreatSeverity.critical,
  'cn_jailbreak': ThreatSeverity.critical,
  'rate_limited': ThreatSeverity.critical,
};
