// khy-canary: Khy-20261101-114-JDGQ3WZC
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/services/app_logger.dart';
import '../theme/app_colors.dart';

/// 日志按天查看。
///
/// 入口：设置 → 诊断工具 → 日志。
/// 列表页给「哪天出过错」，详情页给「错在哪」——错误排在最前。
class LogViewerScreen extends StatefulWidget {
  const LogViewerScreen({super.key});

  @override
  State<LogViewerScreen> createState() => _LogViewerScreenState();
}

class _LogViewerScreenState extends State<LogViewerScreen> {
  final AppLogger _logger = AppLogger();
  List<LogDay> _days = const [];
  Map<String, int> _codeStats = const {};
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final days = await _logger.listDays();
    final stats = await _logger.errorCodeStats();
    if (!mounted) return;
    setState(() {
      _days = days;
      _codeStats = stats;
      _loading = false;
    });
  }

  Future<void> _copyBundle() async {
    final bundle = await _logger.exportLogs(days: 3);
    await Clipboard.setData(ClipboardData(text: bundle));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('分析包已复制到剪贴板，可直接粘给研发智能体')),
    );
  }

  Future<void> _clearAll() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('清空全部日志'),
        content: const Text('将删除保留期内的所有日志文件，删除后无法找回。确定吗？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(c, true),
            child: const Text('确定', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await _logger.clearLogs();
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final totalErrors =
        _days.fold<int>(0, (sum, d) => sum + d.errorCount);

    return Scaffold(
      appBar: AppBar(
        title: const Text('日志'),
        centerTitle: true,
        actions: [
          IconButton(
            icon: const Icon(Icons.content_copy_outlined),
            onPressed: _copyBundle,
            tooltip: '导出分析包',
          ),
          IconButton(
            icon: const Icon(Icons.delete_outline),
            onPressed: _clearAll,
            tooltip: '清空全部',
          ),
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _load,
            tooltip: '刷新',
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _days.isEmpty
              ? Center(
                  child: Text('暂无日志',
                      style: TextStyle(color: cs.onSurfaceVariant)),
                )
              : ListView(
                  padding: const EdgeInsets.fromLTRB(12, 12, 12, 24),
                  children: [
                    _summaryCard(cs, totalErrors),
                    if (_codeStats.isNotEmpty) ...[
                      const SizedBox(height: 12),
                      _codeStatsCard(cs),
                    ],
                    const SizedBox(height: 12),
                    for (final day in _days)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: _dayTile(cs, day),
                      ),
                  ],
                ),
    );
  }

  Widget _summaryCard(ColorScheme cs, int totalErrors) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest.withValues(alpha: 0.4),
        borderRadius: BorderRadius.circular(AppRadius.medium),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.event_note_outlined, size: 18, color: cs.primary),
              const SizedBox(width: 8),
              Text(
                '按天查看 · 保留 ${LogStore.retentionDays} 天',
                style: TextStyle(
                    fontSize: 13, fontWeight: FontWeight.w600, color: cs.primary),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            '共 ${_days.length} 天有记录 · 错误 $totalErrors 条',
            style: TextStyle(fontSize: 13, color: cs.onSurface),
          ),
          const SizedBox(height: 4),
          Text(
            '点某一天进入详情，错误排在最前',
            style: TextStyle(
                fontSize: 11, color: cs.onSurface.withValues(alpha: 0.55)),
          ),
        ],
      ),
    );
  }

  Widget _codeStatsCard(ColorScheme cs) {
    final entries = _codeStats.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: cs.surface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(
            color: cs.outlineVariant.withValues(alpha: 0.5)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('错误码分布',
              style: TextStyle(
                  fontSize: 13, fontWeight: FontWeight.w600, color: cs.onSurface)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final e in entries)
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: cs.errorContainer.withValues(alpha: 0.6),
                    borderRadius: BorderRadius.circular(AppRadius.small),
                  ),
                  child: Text(
                    '${e.key} × ${e.value}',
                    style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: cs.onErrorContainer),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _dayTile(ColorScheme cs, LogDay day) {
    final hasError = day.errorCount > 0;
    final title = day.legacy ? '旧版日志（迁移前）' : _dayLabel(day.date);
    final subtitle = day.legacy
        ? '文本格式 · ${_formatBytes(day.bytes)}'
        : '${day.errorCount} 个错误 · ${_formatBytes(day.bytes)}';

    return Material(
      color: cs.surface,
      borderRadius: BorderRadius.circular(AppRadius.medium),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.medium),
        onTap: () async {
          await Navigator.push(
            context,
            MaterialPageRoute(builder: (_) => LogDayScreen(day: day)),
          );
          _load();
        },
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppRadius.medium),
            border: Border.all(
              color: hasError
                  ? cs.error.withValues(alpha: 0.35)
                  : cs.outlineVariant.withValues(alpha: 0.5),
            ),
          ),
          child: Row(
            children: [
              Icon(
                hasError ? Icons.error_outline : Icons.today_outlined,
                size: 20,
                color: hasError ? cs.error : cs.onSurfaceVariant,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          color: cs.onSurface),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: TextStyle(
                          fontSize: 12,
                          color: hasError
                              ? cs.error
                              : cs.onSurface.withValues(alpha: 0.6)),
                    ),
                  ],
                ),
              ),
              if (hasError)
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    color: cs.error,
                    borderRadius: BorderRadius.circular(AppRadius.small),
                  ),
                  child: Text(
                    '${day.errorCount}',
                    style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        color: cs.onError),
                  ),
                ),
              const SizedBox(width: 4),
              Icon(Icons.chevron_right, size: 18, color: cs.onSurfaceVariant),
            ],
          ),
        ),
      ),
    );
  }
}

/// 某一天的日志详情
class LogDayScreen extends StatefulWidget {
  const LogDayScreen({super.key, required this.day});

  final LogDay day;

  @override
  State<LogDayScreen> createState() => _LogDayScreenState();
}

class _LogDayScreenState extends State<LogDayScreen> {
  final AppLogger _logger = AppLogger();
  List<LogEntry> _entries = const [];
  List<LogEntry> _errors = const [];
  String _legacyText = '';
  bool _loading = true;
  bool _errorsOnly = true;
  String _keyword = '';
  // 「全部」页签默认放开所有级别，由用户自己收窄
  final Set<LogLevel> _levels = LogLevel.values.toSet();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final day = widget.day;
    if (day.legacy) {
      final text = await _logger.readLegacyText() ?? '';
      if (!mounted) return;
      setState(() {
        _legacyText = text;
        _entries = const [];
        _errors = const [];
        _loading = false;
      });
      return;
    }
    final entries = await _logger.readDay(day.date);
    final errors = await _logger.readDayErrors(day.date);
    if (!mounted) return;
    setState(() {
      _entries = entries;
      _errors = errors;
      _loading = false;
    });
  }

  Future<void> _copyDay() async {
    // 旧版日志是文本，没有分析包结构，直接复制原文
    final text = widget.day.legacy
        ? _legacyText
        : await _logger.exportDay(widget.day.date);
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('当日分析包已复制到剪贴板')),
    );
  }

  Future<void> _clearDay() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('清空当日日志'),
        content: const Text('将删除这一天的日志文件，删除后无法找回。确定吗？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(c, true),
            child: const Text('确定', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await _logger.clearDay(widget.day.date);
    await _load();
  }

  List<LogEntry> get _visible {
    final source = _errorsOnly ? _errors : _entries;
    final keyword = _keyword.trim();
    return source.where((e) {
      if (!_errorsOnly && !_levels.contains(e.level)) return false;
      if (keyword.isEmpty) return true;
      final haystack = '${e.code ?? ''} ${e.message} ${e.context}';
      return haystack.toLowerCase().contains(keyword.toLowerCase());
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final title = widget.day.legacy ? '旧版日志' : _dayLabel(widget.day.date);

    return Scaffold(
      appBar: AppBar(
        title: Text(title),
        centerTitle: true,
        actions: [
          IconButton(
            icon: const Icon(Icons.content_copy_outlined),
            onPressed: _copyDay,
            tooltip: '复制分析包',
          ),
          if (!widget.day.legacy)
            IconButton(
              icon: const Icon(Icons.delete_outline),
              onPressed: _clearDay,
              tooltip: '清空当日',
            ),
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _load,
            tooltip: '刷新',
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : widget.day.legacy
              ? _legacyView(cs)
              : _dayView(cs),
    );
  }

  Widget _legacyView(ColorScheme cs) {
    if (_legacyText.isEmpty) {
      return Center(
        child: Text('旧版日志已不存在',
            style: TextStyle(color: cs.onSurfaceVariant)),
      );
    }
    return SingleChildScrollView(
      padding: const EdgeInsets.all(12),
      child: SelectableText(
        _legacyText,
        style: const TextStyle(
            fontFamily: 'monospace', fontSize: 10, height: 1.5),
      ),
    );
  }

  Widget _dayView(ColorScheme cs) {
    final visible = _visible;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
          child: SegmentedButton<bool>(
            segments: [
              ButtonSegment<bool>(
                value: true,
                icon: const Icon(Icons.error_outline, size: 16),
                label: Text('错误 ${_errors.length}'),
              ),
              ButtonSegment<bool>(
                value: false,
                icon: const Icon(Icons.list_alt_outlined, size: 16),
                label: Text('全部 ${_entries.length}'),
              ),
            ],
            selected: {_errorsOnly},
            onSelectionChanged: (s) => setState(() => _errorsOnly = s.first),
          ),
        ),
        if (!_errorsOnly) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
            child: TextField(
              onChanged: (v) => setState(() => _keyword = v),
              decoration: InputDecoration(
                isDense: true,
                hintText: '搜索消息 / 错误码 / 上下文',
                prefixIcon: const Icon(Icons.search, size: 18),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(AppRadius.small),
                ),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
            child: Wrap(
              spacing: 8,
              children: [
                for (final level in LogLevel.values)
                  FilterChip(
                    label: Text(logLevelLabel(level)),
                    selected: _levels.contains(level),
                    onSelected: (on) => setState(() {
                      if (on) {
                        _levels.add(level);
                      } else {
                        _levels.remove(level);
                      }
                    }),
                  ),
              ],
            ),
          ),
        ],
        const SizedBox(height: 8),
        Expanded(
          child: visible.isEmpty
              ? Center(
                  child: Text(
                    _errorsOnly ? '当日没有错误' : '没有匹配的条目',
                    style: TextStyle(color: cs.onSurfaceVariant),
                  ),
                )
              : ListView.builder(
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 24),
                  itemCount: visible.length,
                  itemBuilder: (_, i) => _errorsOnly
                      ? _errorCard(cs, visible[i])
                      : _entryRow(cs, visible[i]),
                ),
        ),
      ],
    );
  }

  Widget _errorCard(ColorScheme cs, LogEntry entry) {
    final fatal = entry.level == LogLevel.fatal;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: cs.surface,
        borderRadius: BorderRadius.circular(AppRadius.medium),
        border: Border.all(
          color: cs.error.withValues(alpha: fatal ? 0.6 : 0.3),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: fatal ? cs.error : cs.errorContainer,
                  borderRadius: BorderRadius.circular(AppRadius.small),
                ),
                child: Text(
                  entry.code ?? '无码',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    color: fatal ? cs.onError : cs.onErrorContainer,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  entry.message,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: cs.onSurface,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            '${formatLogTime(entry.ts)} · ${logCategoryLabel(entry.category)}'
            '${entry.screen != null ? ' · ${entry.screen}' : ''}',
            style: TextStyle(
                fontSize: 11, color: cs.onSurface.withValues(alpha: 0.55)),
          ),
          if (entry.context.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              entry.context.entries
                  .map((c) => '${c.key}=${c.value}')
                  .join(' · '),
              style: TextStyle(
                  fontSize: 11, color: cs.onSurface.withValues(alpha: 0.7)),
            ),
          ],
          if (entry.error != null) ...[
            const SizedBox(height: 6),
            Text(
              entry.error!,
              style: TextStyle(fontSize: 11, color: cs.error),
            ),
          ],
          if (entry.stack != null) ...[
            const SizedBox(height: 6),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: cs.surfaceContainerHighest.withValues(alpha: 0.5),
                borderRadius: BorderRadius.circular(AppRadius.small),
              ),
              child: Text(
                entry.stack!,
                style: const TextStyle(
                    fontFamily: 'monospace', fontSize: 9, height: 1.4),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _entryRow(ColorScheme cs, LogEntry entry) {
    final color = switch (entry.level) {
      LogLevel.debug => cs.onSurfaceVariant,
      LogLevel.info => cs.onSurface,
      LogLevel.warn => AppColors.warning,
      LogLevel.error => cs.error,
      LogLevel.fatal => cs.error,
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 34,
            margin: const EdgeInsets.only(top: 2),
            child: Text(
              logLevelLabel(entry.level),
              style: TextStyle(
                fontFamily: 'monospace',
                fontSize: 10,
                fontWeight: FontWeight.w700,
                color: color,
              ),
            ),
          ),
          Expanded(
            child: GestureDetector(
              onTap: () => _showDetail(entry),
              child: Text(
                entry.message,
                style: TextStyle(fontSize: 12, color: color, height: 1.4),
              ),
            ),
          ),
          Text(
            _clockTime(entry.ts),
            style: TextStyle(
                fontFamily: 'monospace',
                fontSize: 10,
                color: cs.onSurface.withValues(alpha: 0.45)),
          ),
        ],
      ),
    );
  }

  void _showDetail(LogEntry entry) {
    showDialog(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(entry.code ?? logLevelLabel(entry.level)),
        content: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(entry.message),
              const SizedBox(height: 8),
              Text('时间: ${formatLogTime(entry.ts)}'),
              Text('分类: ${logCategoryLabel(entry.category)}'),
              if (entry.screen != null) Text('界面: ${entry.screen}'),
              if (entry.context.isNotEmpty)
                Text('上下文: ${entry.context}'),
              if (entry.error != null) Text('错误: ${entry.error}'),
              if (entry.stack != null) Text('堆栈:\n${entry.stack}'),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  }

  String _clockTime(DateTime dt) {
    String p2(int n) => n.toString().padLeft(2, '0');
    return '${p2(dt.hour)}:${p2(dt.minute)}:${p2(dt.second)}';
  }
}

/// 「今天 / 昨天 / 10-22 周四」
String _dayLabel(DateTime date) {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final target = DateTime(date.year, date.month, date.day);
  final diff = today.difference(target).inDays;
  if (diff == 0) return '今天 · ${_shortDate(date)}';
  if (diff == 1) return '昨天 · ${_shortDate(date)}';
  return _shortDate(date);
}

String _shortDate(DateTime date) {
  final weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  String p2(int n) => n.toString().padLeft(2, '0');
  return '${date.month}-${p2(date.day)} ${weekdays[date.weekday - 1]}';
}

String _formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}
