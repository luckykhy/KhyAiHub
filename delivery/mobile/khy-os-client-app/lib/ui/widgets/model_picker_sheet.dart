// khy-canary: Khy-20261101-130-P1C5QM8P
import 'package:flutter/material.dart';

import '../../core/config/model_registry.dart';
import '../theme/design_tokens.dart';

/// 模型选择面板（底部弹层）。
///
/// 为什么单独一个文件：聊天页、设置页都要选模型，而两边要的东西不一样——
/// 设置页选完还要填 Key、有保存按钮；聊天页选完就该立刻能用。共用一份
/// 「选中即返回」的面板，各自决定选中之后做什么。
///
/// 用 ConstrainedBox 限高是必须的：mainAxisSize.min + Flexible(ListView) 在
/// bottom sheet 里会溢出（实测 99564 像素），这个坑在两个 workspace 面板上
/// 已经踩过一次。
class ModelPickerSheet extends StatelessWidget {
  final List<ModelInfo> models;
  final String currentId;

  const ModelPickerSheet({
    super.key,
    required this.models,
    required this.currentId,
    required AppPalette palette,
  }) : _palette = palette;

  final AppPalette _palette;

  @override
  Widget build(BuildContext context) {
    final maxHeight = MediaQuery.of(context).size.height * 0.8;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('选择模型',
                  style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      color: _palette.textPrimary)),
              const SizedBox(height: 4),
              Text(
                models.isEmpty ? '没拿到模型列表' : '共 ${models.length} 个',
                style: TextStyle(fontSize: 11, color: _palette.textSecondary),
              ),
              const SizedBox(height: 12),
              Flexible(
                child: models.isEmpty
                    ? Center(
                        child: Text('换一个提供商，或去设置页手填模型名',
                            style: TextStyle(
                                fontSize: 12, color: _palette.textFaint)),
                      )
                    : ListView.builder(
                        shrinkWrap: true,
                        itemCount: models.length,
                        itemBuilder: (ctx, i) {
                          final m = models[i];
                          final isSelected = m.id == currentId;
                          return ListTile(
                            dense: true,
                            contentPadding: EdgeInsets.zero,
                            title: Text(m.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                    fontSize: 13,
                                    fontWeight: isSelected
                                        ? FontWeight.w600
                                        : FontWeight.normal,
                                    color: _palette.textPrimary)),
                            subtitle: m.name != m.id
                                ? Text(m.id,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(fontSize: 11))
                                : null,
                            trailing: isSelected
                                ? Icon(Icons.check,
                                    size: 18, color: _palette.primary)
                                : null,
                            onTap: () => Navigator.pop(ctx, m),
                          );
                        },
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
