// 存储分析页：空间被什么占了。
//
// 四个维度：按类型（哪类文件最多）、按目录（哪个文件夹最大）、按时间（哪个月涨得多）、
// 以及最大的若干个文件。只给总数没有用——用户要的是「下一步该清什么」。
//
// 扫描有上限，被截断时页面顶部会明说「只统计到前 N 项」——
// 一个看起来完整其实漏了一半的统计比不给更误导。

import 'package:flutter/material.dart';

import '../../core/vfs/vfs_analysis.dart';
import '../theme/design_tokens.dart';

/// 存储分析页。
class StorageAnalysisScreen extends StatefulWidget {
  /// 要分析的目录。
  final String path;

  const StorageAnalysisScreen({super.key, required this.path});

  @override
  State<StorageAnalysisScreen> createState() => _StorageAnalysisScreenState();
}

class _StorageAnalysisScreenState extends State<StorageAnalysisScreen> {
  StorageAnalysis? _analysis;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final analysis = await VfsAnalysis.analyze(widget.path);
    if (!mounted) return;
    setState(() {
      _analysis = analysis;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);
    final analysis = _analysis;

    return Scaffold(
      appBar: AppBar(
        title: const Text('存储分析'),
        actions: <Widget>[
          IconButton(
            onPressed: _load,
            icon: const Icon(Icons.refresh),
            tooltip: '重新扫描',
          ),
        ],
      ),
      body: _loading
          ? Center(
              child: SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: palette.primary,
                ),
              ),
            )
          : analysis == null || analysis.totalBytes == 0
              ? Center(
                  child: Text(
                    '没有可统计的内容',
                    style: AppText.body.copyWith(color: palette.textFaint),
                  ),
                )
              : ListView(
                  padding: const EdgeInsets.all(AppSpacing.page),
                  children: <Widget>[
                    _summary(context, analysis),
                    if (analysis.notice.isNotEmpty) ...<Widget>[
                      const SizedBox(height: AppSpacing.cardGap),
                      Text(
                        analysis.notice,
                        style: AppText.micro.copyWith(color: palette.warning),
                      ),
                    ],
                    if (analysis.byType.isNotEmpty) ...<Widget>[
                      const SizedBox(height: AppSpacing.section),
                      _sectionTitle(context, '按类型'),
                      _card(
                        context,
                        children: <Widget>[
                          for (final stat in analysis.byType)
                            _typeRow(context, analysis, stat),
                        ],
                      ),
                    ],
                    if (analysis.byFolder.isNotEmpty) ...<Widget>[
                      const SizedBox(height: AppSpacing.section),
                      _sectionTitle(context, '按目录'),
                      _card(
                        context,
                        children: <Widget>[
                          for (final stat in analysis.byFolder)
                            _plainRow(context, stat.path, stat.bytes),
                        ],
                      ),
                    ],
                    if (analysis.largest.isNotEmpty) ...<Widget>[
                      const SizedBox(height: AppSpacing.section),
                      _sectionTitle(context, '最大的文件'),
                      _card(
                        context,
                        children: <Widget>[
                          for (final stat in analysis.largest)
                            _plainRow(context, stat.path, stat.bytes),
                        ],
                      ),
                    ],
                    if (analysis.byMonth.isNotEmpty) ...<Widget>[
                      const SizedBox(height: AppSpacing.section),
                      _sectionTitle(context, '按时间'),
                      _card(
                        context,
                        children: <Widget>[
                          for (final stat in analysis.byMonth)
                            _plainRow(context, stat.month, stat.bytes),
                        ],
                      ),
                    ],
                    const SizedBox(height: AppSpacing.section),
                  ],
                ),
    );
  }

  Widget _summary(BuildContext context, StorageAnalysis analysis) {
    final palette = AppPalette.of(context);
    return _card(
      context,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.all(AppSpacing.cardPad),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      analysis.readableTotal,
                      style: AppText.display.copyWith(color: palette.textPrimary),
                    ),
                    const SizedBox(height: AppSpacing.dense),
                    Text(
                      '${analysis.fileCount} 个文件 · ${analysis.dirCount} 个目录',
                      style:
                          AppText.micro.copyWith(color: palette.textFaint),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _typeRow(
    BuildContext context,
    StorageAnalysis analysis,
    StorageTypeStat stat,
  ) {
    final palette = AppPalette.of(context);
    final ratio = analysis.ratioOf(stat.bytes);
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.cardPadNarrow),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  '${stat.type}（${stat.count}）',
                  style: AppText.body.copyWith(color: palette.textPrimary),
                ),
              ),
              Text(
                _readable(stat.bytes),
                style: AppText.micro.copyWith(color: palette.textFaint),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.dense),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: ratio.clamp(0.0, 1.0),
              minHeight: 6,
              backgroundColor: palette.surfaceHigh,
              valueColor: AlwaysStoppedAnimation<Color>(palette.primary),
            ),
          ),
        ],
      ),
    );
  }

  Widget _plainRow(BuildContext context, String label, int bytes) {
    final palette = AppPalette.of(context);
    return ListTile(
      dense: true,
      title: Text(
        label,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: AppText.body.copyWith(color: palette.textPrimary),
      ),
      trailing: Text(
        _readable(bytes),
        style: AppText.micro.copyWith(color: palette.textFaint),
      ),
    );
  }

  Widget _sectionTitle(BuildContext context, String text) {
    final palette = AppPalette.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.cardGap),
      child: Text(
        text,
        style: AppText.label.copyWith(color: palette.textSecondary),
      ),
    );
  }

  Widget _card(BuildContext context, {required List<Widget> children}) {
    final palette = AppPalette.of(context);
    return Container(
      decoration: BoxDecoration(
        color: palette.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: palette.stroke),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(children: children),
    );
  }

  static String _readable(int bytes) {
    if (bytes < 1024) return '$bytes B';
    const units = <String>['KB', 'MB', 'GB', 'TB'];
    var value = bytes / 1024;
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return '${value.toStringAsFixed(value >= 100 ? 0 : 1)} ${units[unit]}';
  }
}
