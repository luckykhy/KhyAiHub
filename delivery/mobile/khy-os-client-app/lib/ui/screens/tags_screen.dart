// 标签页：跨路径的归类。
//
// 书签是「一个路径」，标签是「一类东西」——散在 Download 与 Documents 里的
// 同一个项目的文件，都可以打上「项目A」。这一页把标签摊开，让人一眼看到
// 「我给什么打过标」，并从标签直接跳到某个文件。
//
// 打标签的入口在文件管理器的长按菜单里（对某个文件打标），这里是看和去。

import 'package:flutter/material.dart';

import '../../core/vfs/vfs_organization.dart';
import '../theme/design_tokens.dart';

/// 标签页。
class TagsScreen extends StatefulWidget {
  /// 跳到某个路径（由文件管理器接管）。
  final ValueChanged<String> onOpenPath;

  const TagsScreen({super.key, required this.onOpenPath});

  @override
  State<TagsScreen> createState() => _TagsScreenState();
}

class _TagsScreenState extends State<TagsScreen> {
  List<VfsTag> _tags = const <VfsTag>[];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final tags = await VfsOrganizationStore.loadTags();
    if (!mounted) return;
    setState(() {
      _tags = tags;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final palette = AppPalette.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('标签'),
        actions: <Widget>[
          IconButton(
            onPressed: _load,
            icon: const Icon(Icons.refresh),
            tooltip: '刷新',
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
          : _tags.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(AppSpacing.page),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Icon(Icons.label_outline,
                            size: 32, color: palette.textFaint),
                        const SizedBox(height: AppSpacing.cardGap),
                        Text(
                          '还没有标签',
                          style:
                              AppText.body.copyWith(color: palette.textSecondary),
                        ),
                        const SizedBox(height: AppSpacing.dense),
                        Text(
                          '在文件管理器里长按一个文件，选「加标签」，'
                          '就能把散在不同目录的文件归到一起。',
                          textAlign: TextAlign.center,
                          style:
                              AppText.micro.copyWith(color: palette.textFaint),
                        ),
                      ],
                    ),
                  ),
                )
              : ListView.builder(
                  itemCount: _tags.length,
                  itemBuilder: (BuildContext context, int index) {
                    final tag = _tags[index];
                    return ExpansionTile(
                      leading: Icon(Icons.label_outline,
                          size: 20, color: palette.primary),
                      title: Text(
                        tag.name,
                        style:
                            AppText.body.copyWith(color: palette.textPrimary),
                      ),
                      subtitle: Text(
                        '${tag.paths.length} 个文件',
                        style:
                            AppText.micro.copyWith(color: palette.textFaint),
                      ),
                      children: <Widget>[
                        for (final path in tag.paths)
                          ListTile(
                            dense: true,
                            title: Text(
                              path,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: AppText.secondary
                                  .copyWith(color: palette.textSecondary),
                            ),
                            onTap: () {
                              Navigator.of(context).maybePop();
                              widget.onOpenPath(path);
                            },
                          ),
                      ],
                    );
                  },
                ),
    );
  }
}
