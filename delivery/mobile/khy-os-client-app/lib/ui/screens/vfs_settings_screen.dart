// 文件管理器设置页。
//
// 这一页是「权限透明可控」的落点。四组设置，每一组都对应一条用户要能自己决定的事：
//   - 安全模式：我要一条确定能走通的路（排查故障 / 只想要文件管理器）；
//   - AI 辅助强度：AI 该多主动（可一路关到完全不出现）；
//   - 高级数据编辑模式：写应用私有目录这件事，我单独授权；
//   - 审计日志：谁动过我的文件，一行行给我看。
//
// 审计日志能直接看到「用户手动 / AI 建议 / 脚本执行」的来源标记——这是
// 「AI 是助手不是主角」这句话的可核查证据，不是宣传语。

import 'package:flutter/material.dart';

import '../../core/vfs/vfs_audit.dart';
import '../../core/vfs/vfs_policy.dart';
import '../../core/vfs/vfs_service.dart';
import '../theme/design_tokens.dart';

/// 文件管理器设置页。
class VfsSettingsScreen extends StatefulWidget {
  const VfsSettingsScreen({super.key});

  @override
  State<VfsSettingsScreen> createState() => _VfsSettingsScreenState();
}

class _VfsSettingsScreenState extends State<VfsSettingsScreen> {
  late VfsPolicy _policy;
  bool _loaded = false;
  List<VfsAuditEntry> _entries = const <VfsAuditEntry>[];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final policy = await VfsService.instance.loadPolicy();
    final entries = await VfsAuditLog.instance.recent(limit: 50);
    if (!mounted) return;
    setState(() {
      _policy = policy;
      _entries = entries;
      _loaded = true;
    });
  }

  Future<void> _update(VfsPolicy next) async {
    setState(() => _policy = next);
    await VfsService.instance.applyPolicy(next);
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);

    if (!_loaded) {
      return Scaffold(
        appBar: AppBar(title: const Text('文件管理器设置')),
        body: Center(
          child: SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              color: palette.primary,
            ),
          ),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(title: const Text('文件管理器设置')),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.page),
        children: <Widget>[
          _sectionTitle(context, '权限与运行模式'),
          _card(
            context,
            children: <Widget>[
              _switchTile(
                context,
                title: '安全模式',
                subtitle: '只保留基础文件管理，禁用私有目录、系统分区与容器',
                value: _policy.safeMode,
                onChanged: (bool value) =>
                    _update(_policy.copyWith(safeMode: value)),
              ),
              const Divider(height: AppSpacing.section),
              _switchTile(
                context,
                title: '高级数据编辑模式',
                subtitle: '允许写入应用私有目录（默认关闭）',
                value: _policy.advancedDataEdit,
                onChanged: _policy.safeMode
                    ? null
                    : (bool value) =>
                        _update(_policy.copyWith(advancedDataEdit: value)),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.section),
          _sectionTitle(context, 'AI 辅助'),
          _card(
            context,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.all(AppSpacing.cardPad),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      'AI 辅助强度',
                      style: AppText.cardTitle
                          .copyWith(color: palette.textPrimary),
                    ),
                    const SizedBox(height: AppSpacing.dense),
                    for (final level in AiAssistLevel.values)
                      ListTile(
                        dense: true,
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(
                          _policy.aiLevel == level
                              ? Icons.radio_button_checked
                              : Icons.radio_button_unchecked,
                          size: 18,
                          color: _policy.aiLevel == level
                              ? palette.primary
                              : palette.textFaint,
                        ),
                        title: Text(
                          level.label,
                          style: AppText.body
                              .copyWith(color: palette.textPrimary),
                        ),
                        subtitle: Text(
                          level.description,
                          style: AppText.micro
                              .copyWith(color: palette.textFaint),
                        ),
                        onTap: () => _update(_policy.copyWith(aiLevel: level)),
                      ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.section),
          _sectionTitle(context, '冲突处理'),
          _card(
            context,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.all(AppSpacing.cardPad),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      '目标已存在时',
                      style: AppText.cardTitle
                          .copyWith(color: palette.textPrimary),
                    ),
                    const SizedBox(height: AppSpacing.dense),
                    Wrap(
                      spacing: AppSpacing.dense,
                      children: <Widget>[
                        for (final conflict in VfsConflict.values)
                          ChoiceChip(
                            label: Text(conflict.label),
                            selected: _policy.defaultConflict == conflict,
                            onSelected: (_) => _update(
                              _policy.copyWith(defaultConflict: conflict),
                            ),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.section),
          _sectionTitle(context, '操作日志'),
          _card(
            context,
            children: <Widget>[
              if (_entries.isEmpty)
                Padding(
                  padding: const EdgeInsets.all(AppSpacing.cardPad),
                  child: Text(
                    '还没有记录到文件操作',
                    style: AppText.body.copyWith(color: palette.textFaint),
                  ),
                )
              else
                for (final entry in _entries)
                  _auditRow(context, entry),
              const Divider(height: AppSpacing.section),
              Padding(
                padding: const EdgeInsets.all(AppSpacing.cardPad),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: OutlinedButton(
                    onPressed: () async {
                      await VfsAuditLog.instance.clear();
                      await _load();
                    },
                    child: const Text('清空日志'),
                  ),
                ),
              ),
            ],
          ),
        ],
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

  Widget _switchTile(
    BuildContext context, {
    required String title,
    required String subtitle,
    required bool value,
    required ValueChanged<bool>? onChanged,
  }) {
    final palette = AppPalette.of(context);
    return SwitchListTile(
      dense: true,
      value: value,
      onChanged: onChanged,
      title: Text(title, style: AppText.body.copyWith(color: palette.textPrimary)),
      subtitle: Text(
        subtitle,
        style: AppText.micro.copyWith(color: palette.textFaint),
      ),
    );
  }

  Widget _auditRow(BuildContext context, VfsAuditEntry entry) {
    final palette = AppPalette.of(context);
    final sourceColor = switch (entry.source) {
      VfsSource.user => palette.textSecondary,
      VfsSource.ai => palette.primary,
      VfsSource.script => palette.cyan,
      VfsSource.system => palette.textFaint,
    };

    return ListTile(
      dense: true,
      leading: Icon(
        entry.ok ? Icons.check_circle_outline : Icons.error_outline,
        size: 16,
        color: entry.ok ? palette.success : palette.error,
      ),
      title: Text(
        '${entry.operation} · ${entry.path}',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: AppText.body.copyWith(color: palette.textPrimary),
      ),
      subtitle: Text(
        '${_formatTime(entry.time)} · ${entry.source.label}',
        style: AppText.micro.copyWith(color: sourceColor),
      ),
    );
  }

  static String _formatTime(DateTime time) {
    String two(int value) => value.toString().padLeft(2, '0');
    return '${two(time.month)}-${two(time.day)} ${two(time.hour)}:${two(time.minute)}';
  }
}
