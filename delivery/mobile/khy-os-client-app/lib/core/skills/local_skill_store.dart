import '../services/file_service.dart';
import '../tools/skills.dart';
import '../workspace/workspace_paths.dart';
import '../workspace/workspace_store.dart';

/// Local skill discovery: scan `<workspace root>/skills/<name>/SKILL.md`.
///
/// WHY THIS DIRECTORY NAME: the backend skillLoader uses the same `skills/`
/// folder in its discovery chain, so a SKILL.md a user drops here is the same
/// artifact the CLI, desktop and web surfaces see. The phone only reads it —
/// writing skills stays a desktop/terminal job (no second writer).
///
/// WHY REGISTER INTO builtinSkills: SkillMatcher and the execute_skill enum
/// read that one table. A local skill that lives in its own list is invisible
/// to the model no matter how well it is displayed.
///
/// WHY FRONTMATTER-ONLY: a SKILL.md body is instructions for the AI, not data
/// the phone interprets. name/version/description is the whole subset needed
/// to make a skill addressable and describable.
library;

/// The fixed directory/file names. Mirrors the backend loader's convention.
abstract final class LocalSkillLayout {
  /// Directory under the workspace root.
  static const String skillsDir = 'skills';

  /// Fixed filename inside each skill directory.
  static const String skillFile = 'SKILL.md';
}

/// The frontmatter subset a local skill is loaded from.
class SkillFrontmatter {
  const SkillFrontmatter({
    required this.name,
    this.version = '',
    this.description = '',
  });

  final String name;
  final String version;
  final String description;
}

/// One SKILL.md read off the device.
class LocalSkillFileRead {
  const LocalSkillFileRead({required this.content, this.truncated = false});

  final String content;

  /// The native side cut the file at its 256KB read cap.
  final bool truncated;
}

/// Result of one scan.
///
/// [skipped] carries the reason per directory and [warnings] the scan-level
/// notices, both on purpose: a silently dropped skill looks exactly like
/// "my skill never showed up", with no clue where to look.
class LocalSkillScan {
  const LocalSkillScan({
    this.skills = const <Skill>[],
    this.skipped = const <String>[],
    this.warnings = const <String>[],
    this.root = '',
  });

  final List<Skill> skills;
  final List<String> skipped;
  final List<String> warnings;
  final String root;

  bool get isEmpty => skills.isEmpty && skipped.isEmpty && warnings.isEmpty;
}

/// Frontmatter block of a SKILL.md. A file without one is not a skill.
final RegExp _frontmatterBlock = RegExp(r'^---\r?\n([\s\S]*?)\r?\n---');

/// Drop a UTF-8 BOM before matching.
///
/// Windows editors write one, and it makes the leading `---` unmatched — the
/// parse then reports "no frontmatter" and sends the user to fix the wrong
/// thing (their file is fine, the reader was not).
String normalizeSkillMarkdown(String raw) =>
    raw.startsWith('\uFEFF') ? raw.substring(1) : raw;

/// Whether the file carries a frontmatter block at all.
///
/// Split from [parseSkillFrontmatter] because "no frontmatter block" and
/// "frontmatter without name" are different user mistakes and the skip reason
/// must not send them down the same path.
bool hasFrontmatterBlock(String raw) =>
    _frontmatterBlock.hasMatch(normalizeSkillMarkdown(raw));

/// Parse the minimal frontmatter subset; null when there is no `name`.
///
/// Only scalars are read — `tags:` / `platforms:` block lists and nested maps
/// are skipped line by line, which is enough for name/version/description and
/// cannot throw on a file the backend loader accepts.
SkillFrontmatter? parseSkillFrontmatter(String raw) {
  final block = _frontmatterBlock.firstMatch(normalizeSkillMarkdown(raw));
  if (block == null) return null;
  final fields = <String, String>{};
  for (final line in block.group(1)!.split(RegExp(r'\r?\n'))) {
    final trimmed = line.trim();
    if (trimmed.isEmpty || trimmed.startsWith('#')) continue;
    final colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    final key = trimmed.substring(0, colon).trim();
    var value = trimmed.substring(colon + 1).trim();
    if (value.length >= 2) {
      final first = value[0];
      final last = value[value.length - 1];
      if ((first == '"' && last == '"') || (first == "'" && last == "'")) {
        value = value.substring(1, value.length - 1);
      }
    }
    if (value.isNotEmpty) fields[key] = value;
  }
  final name = fields['name'] ?? '';
  if (name.isEmpty) return null;
  return SkillFrontmatter(
    name: name,
    version: fields['version'] ?? '',
    description: fields['description'] ?? '',
  );
}

/// Escape check for a skill directory name before it becomes a path segment.
///
/// Same order as WorkspaceSlug.validate: the dangerous rejection is reported
/// first, so a `../escape` name is told it escapes the skills directory
/// instead of being lectured about the character set.
///
/// Deliberately laxer than WorkspaceSlug about the character set: the backend
/// loader accepts upper-case and non-ASCII directory names, and refusing them
/// here would hide skills the user placed on purpose. Separators and `..` are
/// the actual escape vector and are still refused.
String? validateSkillDirName(String raw) {
  if (raw.isEmpty) return '技能目录名不能为空';
  if (raw.length > WorkspaceLayout.maxSlugLength) {
    return '技能目录名过长（上限 ${WorkspaceLayout.maxSlugLength} 字符）';
  }
  if (raw.contains('/') || raw.contains('\\')) {
    return '技能目录名不能包含路径分隔符（会跳出技能目录）';
  }
  if (raw == '..' || raw.contains('..')) {
    return '技能目录名不能包含 ..（会跳出技能目录）';
  }
  if (raw == '.') return '技能目录名不能是 .';
  if (raw.startsWith('.')) return '技能目录名不能以 . 开头';
  if (raw.startsWith('-')) return '技能目录名不能以 - 开头';
  return null;
}

/// Keywords derived from a skill name so SkillMatcher can hit partial input.
List<String> localSkillKeywords(String name) {
  final words = name
      .split(RegExp(r'[^A-Za-z0-9]+'))
      .where((word) => word.length >= 2)
      .toList(growable: false);
  return <String>{name, ...words}.toList(growable: false);
}

/// Turn one directory listing into skills plus per-directory skip reasons.
///
/// Separated from [LocalSkillStore.load] so the interesting inputs — empty
/// listing, missing SKILL.md, broken frontmatter, escaping directory name,
/// duplicate name, truncated file — are testable on the host without the
/// native MethodChannel. [readSkillFile] returns the SKILL.md of a directory,
/// or null when it is absent or unreadable.
Future<LocalSkillScan> parseLocalSkills(
  List<String> dirNames,
  Future<LocalSkillFileRead?> Function(String dirName) readSkillFile, {
  String root = '',
  List<String> warnings = const <String>[],
  void Function(int done, int total)? onProgress,
}) async {
  final skills = <Skill>[];
  final skipped = <String>[];
  final seenNames = <String>{};
  var truncatedFiles = 0;
  for (var i = 0; i < dirNames.length; i++) {
    final dir = dirNames[i];
    onProgress?.call(i, dirNames.length);
    final why = validateSkillDirName(dir);
    if (why != null) {
      skipped.add('$dir：$why');
      continue;
    }
    final read = await readSkillFile(dir);
    if (read == null) {
      skipped.add('$dir：没有可读的 ${LocalSkillLayout.skillFile}');
      continue;
    }
    if (read.truncated) truncatedFiles += 1;
    final content = read.content;
    final frontmatter = parseSkillFrontmatter(content);
    if (frontmatter == null) {
      skipped.add('$dir：${hasFrontmatterBlock(content)
          ? 'frontmatter 里没有 name（模型无法寻址该技能）'
          : '文件开头没有 --- frontmatter 块（这不是一份技能定义）'}');
      continue;
    }
    // Two directories claiming one name would put a duplicate value in the
    // execute_skill enum, and execute takes the first match silently.
    if (!seenNames.add(frontmatter.name)) {
      skipped.add('$dir：与另一个目录的 name「${frontmatter.name}」重复，'
          '同名技能对模型不可区分，已跳过');
      continue;
    }
    skills.add(Skill(
      name: frontmatter.name,
      label: frontmatter.name,
      description: frontmatter.description.isEmpty
          ? '本地技能：${LocalSkillLayout.skillFile} 未写 description'
          : frontmatter.description,
      keywords: localSkillKeywords(frontmatter.name),
      type: SkillType.prompt,
      version: frontmatter.version,
    ));
  }
  onProgress?.call(dirNames.length, dirNames.length);
  return LocalSkillScan(
    skills: skills,
    skipped: skipped,
    warnings: <String>[
      ...warnings,
      if (truncatedFiles > 0)
        '$truncatedFiles 个 ${LocalSkillLayout.skillFile} 超过单次读取上限被截断：'
            '正文读不全，frontmatter 在开头不受影响。',
    ],
    root: root,
  );
}

/// Reads and registers local skills.
class LocalSkillStore {
  LocalSkillStore._();

  static final LocalSkillStore instance = LocalSkillStore._();

  Future<LocalSkillScan>? _pending;

  /// Absolute skills directory for a workspace root.
  static String skillsDirFor(String root) => '$root/${LocalSkillLayout.skillsDir}';

  /// Scan the local skills directory and merge the result into the skill table.
  ///
  /// [onProgress] reports directories read so the UI can show "3/7" instead of
  /// an unquantified spinner. The scan never throws: every failure comes back
  /// as a [LocalSkillScan.skipped]/[LocalSkillScan.warnings] line the screen
  /// can render.
  ///
  /// Concurrent calls share one run: the scan rewrites a device-level work
  /// root for the duration of the read, so two overlapping scans would fight
  /// over it (and the second one's restore would land on the first one's
  /// root).
  Future<LocalSkillScan> load({
    String? root,
    void Function(int done, int total)? onProgress,
  }) {
    final running = _pending;
    if (running != null) return running;
    final run = _scan(root: root, onProgress: onProgress).whenComplete(() {
      _pending = null;
    });
    _pending = run;
    return run;
  }

  Future<LocalSkillScan> _scan({
    String? root,
    void Function(int done, int total)? onProgress,
  }) async {
    // The user can move the workspace root in settings; scanning the compiled-in
    // default instead would hide every skill they placed under their own root
    // while the page claims to show "the local skills directory".
    final base = root ?? WorkspaceStore.instance.effectiveRoot;
    // FileService resolves relative paths against the native work root, which
    // is a device-level state owned by the chat screen (it points at the
    // current conversation's workspace). The skills directory lives under the
    // workspace root, so the base has to point there for the duration of the
    // read and is restored right after — read-then-restore, never a permanent
    // switch of the chat's root. A process kill inside that window leaves the
    // skills root in SharedPreferences; the window is one listFiles plus one
    // readFile per directory, which is why the scan is not run in a loop.
    final previous = await FileService.getWorkDir();
    final previousPath = previous['path'] is String ? previous['path'] as String : '';
    // Restore "never picked a root" as null, not as the app-private directory's
    // absolute path: the latter flips the native isAppPrivate to false and the
    // conversation-locations sheet then drops its "文件管理器看不到" hint.
    final restoreTo = previousPath.isEmpty || previous['isAppPrivate'] == true
        ? null
        : previousPath;
    await FileService.setWorkRoot(base);
    try {
      final listed = await FileService.listFiles(LocalSkillLayout.skillsDir);
      if (listed['success'] != true) {
        final why = listed['error'] is String ? listed['error'] as String : '未知原因';
        return LocalSkillScan(
          skipped: <String>[
            '读取 ${skillsDirFor(base)} 失败：$why。'
                '修复：确认该目录存在、并已授予 App 存储权限，然后重新扫描。',
          ],
          root: base,
        );
      }
      // The native listFiles caps at 200 entries and says so; ignoring the flag
      // would render a partial listing as a complete one, which is exactly the
      // failure its own comment warns about.
      final cap = listed['cap'] is int ? listed['cap'] as int : 200;
      final listingWarnings = listed['truncated'] == true
          ? <String>[
              '技能目录超过单次列举上限 $cap 项（共 '
                  '${listed['total'] is int ? listed['total'] : '多于'} 项）：只读了前 $cap 个，'
                  '未列出的技能本次不出现。修复：把不常用的技能移出该目录，或分子目录存放。',
            ]
          : const <String>[];
      final raw = listed['files'];
      final dirs = <String>[];
      if (raw is List) {
        for (final item in raw) {
          if (item is Map && item['isDir'] == true) {
            final name = item['name'];
            if (name is String && name.isNotEmpty) dirs.add(name);
          }
        }
      }
      final scan = await parseLocalSkills(
        dirs,
        (dir) async {
          final read = await FileService.readFile(
              '${LocalSkillLayout.skillsDir}/$dir/${LocalSkillLayout.skillFile}');
          if (read['success'] != true) return null;
          return LocalSkillFileRead(
            content: read['content'] is String ? read['content'] as String : '',
            truncated: read['truncated'] == true,
          );
        },
        root: base,
        warnings: listingWarnings,
        onProgress: onProgress,
      );
      registerLocalSkills(scan.skills);
      return scan;
    } finally {
      await FileService.setWorkRoot(restoreTo);
    }
  }
}
