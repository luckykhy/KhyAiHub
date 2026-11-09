/// Trajectory provenance screen: session list + chain status + per-step trust
/// labels + a verify action.
///
/// Entry (wired at the integration stage): settings → diagnostics → 轨迹校验,
/// same section as the log viewer. Phase 1 is read-only on purpose — replay
/// must run on the backend host that owns the workspace files and tools; the
/// phone's job is only "recorded trustworthily, chain visible, verifiable".

import 'package:flutter/material.dart';

import '../../core/services/trajectory_store.dart';
import '../../core/trajectory/trace_chain.dart';
import '../../core/trajectory/trace_envelope.dart';
import '../theme/app_colors.dart';

String trustLabel(TraceTrust trust) => switch (trust) {
      TraceTrust.verified => '已验真',
      TraceTrust.claimed => '外部声称',
      TraceTrust.quarantined => '已隔离',
    };

Color trustColor(TraceTrust trust) => switch (trust) {
      TraceTrust.verified => AppColors.success,
      TraceTrust.claimed => AppColors.warning,
      TraceTrust.quarantined => AppColors.error,
    };

String chainStatusLabel(ChainVerification chain) {
  if (!chain.available) return '无链文件';
  if (!chain.intact) {
    // 边车不可读时没有首坏块可指，别渲染出「#null」
    return chain.brokenAt == null ? '链不可读' : '链断裂于 #${chain.brokenAt}';
  }
  if (chain.length == 0) return '空链';
  return '链完好 · ${chain.length} 条';
}

Color chainColor(ChainVerification chain, ColorScheme cs) {
  if (!chain.available) return cs.onSurfaceVariant;
  if (!chain.intact) return AppColors.error;
  if (chain.length == 0) return AppColors.warning;
  return AppColors.success;
}

class TrajectoryScreen extends StatefulWidget {
  const TrajectoryScreen({super.key, this.store});

  /// Injected store; tests hand in one rooted at a temp directory so no
  /// path_provider channel is needed.
  final TrajectoryStore? store;

  @override
  State<TrajectoryScreen> createState() => _TrajectoryScreenState();
}

class _TrajectoryScreenState extends State<TrajectoryScreen> {
  late final TrajectoryStore _store = widget.store ?? TrajectoryStore();
  List<TrajectorySession> _sessions = const [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final sessions = await _store.listSessions();
    if (!mounted) return;
    setState(() {
      _sessions = sessions;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text('轨迹溯源'),
        centerTitle: true,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _load,
            tooltip: '刷新',
          ),
        ],
      ),
      body: _loading
          ? const Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  CircularProgressIndicator(),
                  SizedBox(height: 12),
                  Text('正在读取轨迹目录与边车链'),
                ],
              ),
            )
          : _sessions.isEmpty
              ? _emptyState(cs)
              : ListView(
                  padding: const EdgeInsets.fromLTRB(12, 12, 12, 24),
                  children: [
                    for (final session in _sessions)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: _sessionTile(cs, session),
                      ),
                  ],
                ),
    );
  }

  Widget _emptyState(ColorScheme cs) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.timeline_outlined, size: 40, color: cs.onSurfaceVariant),
            const SizedBox(height: 12),
            Text(
              '暂无轨迹记录',
              style: TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w600,
                color: cs.onSurface,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              '轨迹库按会话记录每一轮工具执行，每条记录都盖进边车哈希链；'
              '这里只读，回放在后端宿主机执行。',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }

  Widget _sessionTile(ColorScheme cs, TrajectorySession session) {
    final chain = session.chain;
    final color = chainColor(chain, cs);
    return Material(
      color: cs.surface,
      borderRadius: BorderRadius.circular(AppRadius.medium),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.medium),
        onTap: () async {
          await Navigator.push(
            context,
            MaterialPageRoute(
              builder: (_) => TrajectorySessionScreen(
                session: session,
                store: _store,
              ),
            ),
          );
          _load();
        },
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppRadius.medium),
            border: Border.all(color: color.withValues(alpha: 0.35)),
          ),
          child: Row(
            children: [
              Icon(Icons.account_tree_outlined,
                  size: 20, color: cs.onSurfaceVariant),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      session.conversationId,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: cs.onSurface,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${session.recordCount} 条记录 · '
                      '${_clock(session.updatedAt)}',
                      style: TextStyle(
                        fontSize: 12,
                        color: cs.onSurface.withValues(alpha: 0.6),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              _chip(chainStatusLabel(chain), color),
            ],
          ),
        ),
      ),
    );
  }

  Widget _chip(String label, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.18),
        borderRadius: BorderRadius.circular(AppRadius.small),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w700,
          color: color,
        ),
      ),
    );
  }
}

class TrajectorySessionScreen extends StatefulWidget {
  const TrajectorySessionScreen({
    super.key,
    required this.session,
    required this.store,
  });

  final TrajectorySession session;
  final TrajectoryStore store;

  @override
  State<TrajectorySessionScreen> createState() =>
      _TrajectorySessionScreenState();
}

class _TrajectorySessionScreenState extends State<TrajectorySessionScreen> {
  List<TrajectoryRecord> _records = const [];
  bool _loading = true;
  bool _verifying = false;
  ChainVerification? _verdict;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final records =
        await widget.store.readSession(widget.session.conversationId);
    if (!mounted) return;
    setState(() {
      _records = records;
      _loading = false;
    });
  }

  Future<void> _verify() async {
    setState(() => _verifying = true);
    final verdict =
        await widget.store.verifySession(widget.session.conversationId);
    if (!mounted) return;
    setState(() {
      _verdict = verdict;
      _verifying = false;
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(_verdictText(verdict))),
    );
  }

  String _verdictText(ChainVerification v) {
    if (!v.available) return '校验完成：${v.reason ?? '没有链文件'}，无法验真';
    if (v.intact && v.length == 0) return '校验完成：链为空，没有可验的记录';
    if (v.intact) return '校验完成：链完好，${v.length} 条记录与边车链逐条相符';
    if (v.brokenAt == null) return '校验完成：${v.reason ?? '链不可读'}，无法验真';
    return '校验完成：链断裂于 #${v.brokenAt}——${v.reason ?? '原因未标注'}';
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.session.conversationId),
        centerTitle: true,
        actions: [
          IconButton(
            icon: _verifying
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.fact_check_outlined),
            onPressed: _verifying ? null : _verify,
            tooltip: '校验',
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : Column(
              children: [
                _chainBanner(cs),
                if (_verdict != null) _verdictBanner(cs, _verdict!),
                Expanded(
                  child: _records.isEmpty
                      ? Center(
                          child: Text(
                            '该会话没有轨迹记录',
                            style: TextStyle(color: cs.onSurfaceVariant),
                          ),
                        )
                      : ListView.builder(
                          padding:
                              const EdgeInsets.fromLTRB(12, 12, 12, 24),
                          itemCount: _records.length,
                          itemBuilder: (_, i) => _recordRow(cs, _records[i]),
                        ),
                ),
              ],
            ),
    );
  }

  Widget _chainBanner(ColorScheme cs) {
    final chain = widget.session.chain;
    final color = chainColor(chain, cs);
    final healthy = chain.available && chain.intact && chain.length > 0;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 12, 12, 0),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Row(
        children: [
          Icon(
            healthy ? Icons.verified_outlined : Icons.gpp_maybe_outlined,
            size: 18,
            color: color,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  chainStatusLabel(chain),
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: color,
                  ),
                ),
                if (!chain.intact && chain.reason != null)
                  Text(
                    chain.reason!,
                    style: TextStyle(
                      fontSize: 11,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _verdictBanner(ColorScheme cs, ChainVerification verdict) {
    final healthy = verdict.available && verdict.intact && verdict.length > 0;
    final color = healthy
        ? AppColors.success
        : verdict.available && verdict.intact
            ? AppColors.warning
            : AppColors.error;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppRadius.medium),
      ),
      child: Row(
        children: [
          Icon(
            healthy ? Icons.check_circle_outline : Icons.priority_high,
            size: 18,
            color: color,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              _verdictText(verdict),
              style: TextStyle(fontSize: 12, color: cs.onSurface),
            ),
          ),
        ],
      ),
    );
  }

  Widget _recordRow(ColorScheme cs, TrajectoryRecord record) {
    final trust = record.envelope.trust;
    final color = trustColor(trust);
    final quarantined = trust == TraceTrust.quarantined;
    final terminal = record.state == 'success' ||
        record.state == 'failed' ||
        record.state == 'timeout';
    // A step still in flight has no duration to report; its position in the
    // session is the only honest progress signal available.
    final statusTail = terminal
        ? ' · ${record.durationMs}ms'
        : ' · 第 ${record.seq + 1} 条';
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: cs.surface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(
          color: color.withValues(alpha: quarantined ? 0.5 : 0.2),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                '#${record.seq}',
                style: TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  color: cs.onSurfaceVariant,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  record.tool,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              _chip(trustLabel(trust), color),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            '${_clock(DateTime.fromMillisecondsSinceEpoch(record.at))} · '
            '${_stateLabel(record.state)}$statusTail',
            style: TextStyle(
              fontSize: 11,
              color: cs.onSurface.withValues(alpha: 0.55),
            ),
          ),
          // Quarantined records show the label only. The record's own text
          // stays evidence on disk and never reaches the display.
          if (quarantined) ...[
            const SizedBox(height: 6),
            Text(
              '内容已隔离，不回显',
              style: TextStyle(fontSize: 11, color: AppColors.error),
            ),
          ],
          // The summary is ExecutionStep's own status line, and for a step that
          // has not finished that string carries no progress ("执行中...").
          // Terminal records only.
          if (!quarantined && terminal && record.summary != null) ...[
            const SizedBox(height: 6),
            Text(
              record.summary!,
              style: TextStyle(fontSize: 12, color: cs.onSurface, height: 1.4),
            ),
          ],
          if (record.paramsHash != null) ...[
            const SizedBox(height: 6),
            Text(
              'params ${_shortHash(record.paramsHash!)}',
              style: TextStyle(
                fontFamily: 'monospace',
                fontSize: 10,
                color: cs.onSurface.withValues(alpha: 0.45),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _chip(String label, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.18),
        borderRadius: BorderRadius.circular(AppRadius.small),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w700,
          color: color,
        ),
      ),
    );
  }
}

String _clock(DateTime dt) {
  String p2(int n) => n.toString().padLeft(2, '0');
  return '${dt.month}-${p2(dt.day)} ${p2(dt.hour)}:${p2(dt.minute)}';
}

/// ExecState name → 中文，与 tool_card.dart 的 statusText 同一套措辞。
String _stateLabel(String state) => switch (state) {
      'success' => '成功',
      'failed' => '失败',
      'timeout' => '超时',
      'running' => '执行中',
      'queued' => '排队中',
      _ => '未知状态',
    };

String _shortHash(String hash) =>
    hash.length <= 12 ? hash : hash.substring(0, 12);
