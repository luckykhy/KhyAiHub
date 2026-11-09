import 'package:flutter_test/flutter_test.dart';
import 'package:khy_os_client/core/tools/tool_engine.dart';

/// The tool-not-found message, which is how a hallucinated tool name surfaces.
///
/// Before, it was a bare "Tool not found: X". The model reads that, cannot tell
/// whether it mistyped or invented the name, and retries the same string — or
/// concludes the capability is missing and tells the user it cannot be done.
///
/// The fix names what DOES exist. This is also why the planner sub-agent was
/// left unwired: the user-visible defect was closable in one line, and wiring a
/// pre-flight across three screens would have changed turn outcomes to fix
/// something this already fixes.
void main() {
  Future<ToolResult> run(String name) async {
    final e = ToolEngine();
    e.registerAll(<ToolDef>[
      ToolDef(
        name: 'open_app',
        description: '打开应用',
        inputSchema: const {
          'type': 'object',
          'properties': {'query': {'type': 'string'}},
        },
        execute: (a) async => ToolResult.ok('ok'),
      ),
      ToolDef(
        name: 'read_file',
        description: '读文件',
        inputSchema: const {'type': 'object', 'properties': {}},
        execute: (a) async => ToolResult.ok('ok'),
      ),
    ]);
    return e.execute(name, const <String, dynamic>{});
  }

  test('a hallucinated tool name gets the list of real ones', () async {
    // The exact shape a model produces when it invents a plausible name.
    final r = await run('read_all_files_everywhere');
    expect(r.success, isFalse);
    expect(r.output, contains('read_all_files_everywhere'));
    expect(r.output, contains('open_app'));
    expect(r.output, contains('read_file'));
  });

  test('the message says how many tools exist, so a truncated list is legible',
      () async {
    final r = await run('nope');
    expect(r.output, contains('2'));
  });

  test('the message tells the model not to rename', () async {
    // Without this the model's next move is often a synonym — "file_read",
    // "readfile" — which fails the same way and burns another round trip.
    final r = await run('readfile');
    expect(r.output, contains('不要改用别的叫法'));
  });

  test('an empty registry still answers, and does not claim zero tools exist',
      () async {
    final e = ToolEngine();
    final r = await e.execute('anything', const <String, dynamic>{});
    expect(r.success, isFalse);
    expect(r.output, contains('anything'));
  });

  test('a real tool still works — the guard did not become a blanket refusal',
      () async {
    final r = await run('open_app');
    expect(r.success, isTrue);
  });

  test('the list is sorted, so the message is stable across runs', () async {
    // An unstable order changes the prompt bytes every call and defeats caching.
    final a = await run('x');
    final b = await run('x');
    expect(a.output, b.output);
  });
}
