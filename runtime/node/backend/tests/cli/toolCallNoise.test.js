'use strict';

// Unit tests for the inline tool-call NOISE stripper pure leaf.
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const tcn = require('../../src/cli/toolCallNoise');

const ON = { KHY_TOOLCALL_NOISE_STRIP: '1' };
const OFF = { KHY_TOOLCALL_NOISE_STRIP: 'off' };

// ---------------------------------------------------------------------------
// isEnabled — gate ladder (default ON).
// ---------------------------------------------------------------------------

test('isEnabled: unset → on', () => {
  assert.strictEqual(tcn.isEnabled({}), true);
  assert.strictEqual(tcn.isEnabled(undefined), true);
});

test('isEnabled: explicit off tokens → off', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(tcn.isEnabled({ KHY_TOOLCALL_NOISE_STRIP: v }), false, `value ${v}`);
  }
});

// ---------------------------------------------------------------------------
// The exact leaked forms from the user's screenshot.
// ---------------------------------------------------------------------------

test('strips bare {"name":...,"params":...} JSON line (open_app / 夸克)', () => {
  const input = [
    '让我换个方式,直接用 open_app 工具来启动夸克。',
    '',
    '{"name": "open_app", "params": {"name": "夸克"}}',
    '',
    '现在启动它。',
  ].join('\n');
  const out = tcn.stripInlineToolCallNoise(input, ON);
  assert.doesNotMatch(out, /\{"name"/);
  assert.match(out, /让我换个方式/);
  assert.match(out, /现在启动它/);
});

test('strips bare JSON with "command" params (Bash / reg query)', () => {
  const input = '{"name": "Bash", "params": {"command": "reg query \\"HKEY_CURRENT_USER\\\\...\\" /s"}}';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), '');
});

test('strips arguments/input key variants too', () => {
  assert.strictEqual(tcn.stripInlineToolCallNoise('{"name": "Read", "arguments": {"path": "/x"}}', ON), '');
  assert.strictEqual(tcn.stripInlineToolCallNoise('{"name": "Read", "input": {"path": "/x"}}', ON), '');
});

test('strips bare JSON with trailing tag fragment after closing brace (stream truncation)', () => {
  assert.strictEqual(
    tcn.stripInlineToolCallNoise('{"name": "Read", "params": {"path": "x"}} =Read>', ON),
    ''
  );
  assert.strictEqual(
    tcn.stripInlineToolCallNoise('"name": "Read", "params": {"path": "x"}} =Read>', ON),
    ''
  );
  assert.strictEqual(
    tcn.stripInlineToolCallNoise('{"name": "Read", "params": {"path": "C:/Users/25789/README.md"}} =Read>', ON),
    ''
  );
});

test('strips paired <function=NAME> … </function> block incl. inner lines', () => {
  const input = [
    '前言。',
    '<function=shell_command>',
    'whatever inner garbage',
    '</function>',
    '后语。',
  ].join('\n');
  const out = tcn.stripInlineToolCallNoise(input, ON);
  assert.doesNotMatch(out, /<function/);
  assert.doesNotMatch(out, /<\/function>/);
  assert.doesNotMatch(out, /inner garbage/);
  assert.match(out, /前言/);
  assert.match(out, /后语/);
});

test('strips standalone empty <function=open_app></function> pair (separate lines)', () => {
  const input = [
    '{"name": "open_app", "params": {"name": "夸克"}}',
    '<function=open_app>',
    '</function>',
  ].join('\n');
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON).trim(), '');
});

test('strips a stray closing </function> with no opener', () => {
  const input = 'hello\n</function>\nworld';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), 'hello\nworld');
});

test('strips a single-line <function=x>…</function> pair, keeps surrounding text', () => {
  const input = 'before <function=x>{"a":1}</function> after';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), 'before  after');
});

test('strips KHY image bridge Read payload JSON but preserves ordinary file_path JSON', () => {
  const win = '{"file_path":"C:\\\\Users\\\\mfplg075\\\\AppData\\\\Local\\\\Temp\\\\khy-cli-img-ab12cd34\\\\image-1-deadbeef.png"}';
  const posix = '{"file_path":"/tmp/khy-cli-img-ab12cd34/image-2-cafebabe.jpg"}';
  assert.strictEqual(tcn.stripInlineToolCallNoise(win, ON), '');
  assert.strictEqual(tcn.stripInlineToolCallNoise(posix, ON), '');
  assert.strictEqual(
    tcn.stripInlineToolCallNoise('{"file_path":"C:\\\\project\\\\config.json"}', ON),
    '{"file_path":"C:\\\\project\\\\config.json"}'
  );
  assert.strictEqual(
    tcn.stripInlineToolCallNoise('{"file_path":"/tmp/khy-cli-img-ab12cd34/image.png","purpose":"example"}', ON),
    '{"file_path":"/tmp/khy-cli-img-ab12cd34/image.png","purpose":"example"}'
  );
});

test('preserves KHY image bridge JSON inside a fenced code block', () => {
  const input = ['```json', '{"file_path":"/tmp/khy-cli-img-ab12cd34/image-1-deadbeef.png"}', '```'].join('\\n');
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});


test('preserves identical JSON INSIDE a ``` fenced code block', () => {
  const input = [
    '示例配置:',
    '```json',
    '{"name": "open_app", "params": {"name": "夸克"}}',
    '```',
  ].join('\n');
  const out = tcn.stripInlineToolCallNoise(input, ON);
  assert.match(out, /\{"name": "open_app"/);
  assert.match(out, /```json/);
});

test('preserves a <function=…> example inside a fenced block', () => {
  const input = '```\n<function=demo>\nx\n</function>\n```';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});

// ---------------------------------------------------------------------------
// Precision: prose / normal markdown untouched.
// ---------------------------------------------------------------------------

test('does NOT strip prose that merely contains braces / the word name', () => {
  const input = 'The config has a name field and params like {"x": 1} embedded mid-sentence.';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});

test('does NOT strip a JSON object missing the params/arguments/input key', () => {
  const input = '{"name": "foo", "value": 42}';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});

test('normal markdown (headings/list/bold) passes through byte-identical', () => {
  const input = '# Title\n\n- item one\n- **bold** item\n\nA paragraph.';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});

// ---------------------------------------------------------------------------
// Streaming-partial safety: a half-arrived object is left alone.
// ---------------------------------------------------------------------------

test('partial (unclosed) bare JSON is NOT stripped (waits for completion)', () => {
  const input = '{"name": "open_a';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});

// ---------------------------------------------------------------------------
// Truncated / malformed tag fragments (real leak from stepfun step-3.5-flash
// screenshot: '<' swallowed at a chunk boundary + non-standard `}}` ending).
// ---------------------------------------------------------------------------

test('strips real leak sample: prefix-less function line + malformed <arguments={…}} line', () => {
  const input = [
    'function=webSearch>',
    '<arguments={"query":"GitHub Vue.js repository languages .vue files JavaScript TypeScript statistics","freshness":"year"}}',
    '正常文本',
  ].join('\n');
  const out = tcn.stripInlineToolCallNoise(input, ON);
  assert.strictEqual(out.trim(), '正常文本');
});

test('strips function fragment line variants (missing < / missing > / both)', () => {
  for (const frag of ['function=webSearch>', '<function=webSearch', 'function=webSearch', '</function=web.Search>']) {
    const out = tcn.stripInlineToolCallNoise(`前文\n${frag}\n后文`, ON);
    assert.strictEqual(out, '前文\n后文', `fragment: ${frag}`);
  }
});

test('strips <arguments={…} single-line variants regardless of ending', () => {
  for (const line of [
    '<arguments={"q":"x"}>',
    '<arguments={"q":"x"}}',
    '<arguments={"q":"x"}',
    'arguments={"q":"x"}}',
  ]) {
    const out = tcn.stripInlineToolCallNoise(`a\n${line}\nb`, ON);
    assert.strictEqual(out, 'a\nb', `line: ${line}`);
  }
});

test('swallows a multi-line <arguments={ JSON body until its closing brace', () => {
  const input = [
    '前文',
    '<arguments={',
    '"query": "x",',
    '"freshness": "year"',
    '}}',
    '后文',
  ].join('\n');
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), '前文\n后文');
});

test('multi-line arguments swallow stops at an obvious prose line (guard)', () => {
  const input = '<arguments={"q": "x",\n这是普通正文行';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), '这是普通正文行');
});

test('strips orphan </arguments> / <parameter=…> / </parameter> fragment lines', () => {
  const input = 'a\n</arguments>\n<parameter=path>\n</parameter>\nb';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), 'a\nb');
});

test('does NOT strip prose merely containing function= mid-sentence', () => {
  const input = '这是一个 function=add 的示例';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});

// ---------------------------------------------------------------------------
// Bracketed wire-marker leaks: `[Tool Call: name(args)]` / `[Tool Result: …]`
// (the gateway's strip-tools text fallback, _toolSchemaConverter hasTools=false,
// echoes these into the transcript; text-protocol models repeat them verbatim —
// the "工具裸露且无法复制" symptom).
// ---------------------------------------------------------------------------

test('strips a whole-line [Tool Call: name({})] marker (screenshot shape)', () => {
  const input = [
    '我先查一下 C 盘空间。',
    '[Tool Call: shell_command({})]',
    'C 盘 111.8GB 已用。',
  ].join('\n');
  const out = tcn.stripInlineToolCallNoise(input, ON);
  assert.doesNotMatch(out, /\[Tool\s+Call/);
  assert.match(out, /我先查一下/);
  assert.match(out, /111\.8GB/);
});

test('strips a whole-line marker with JSON args', () => {
  const input = '[Tool Call: shellCommand({"command":"dir /b","timeoutMs":15000})]';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), '');
});

// 2026-10-12: this test was RED before the change and its fixture, not the
// implementation, was wrong. The input ended `}])` — the marker's `]` arrived
// BEFORE its `)`, so it was not the marker's deterministic close at all, and the
// implementation correctly refused to treat it as a whole-line marker. Fixing
// the fixture to the real shape (`})]`) makes both sides agree. The
// settle-path counterpart (a truncated head must reach the screen) is asserted
// under settlePendingToolTag below.
test('a marker whose ] and ) are out of order is NOT a whole-line marker', () => {
  const malformed = '[Tool Call: shellCommand({"command":"dir /b","timeoutMs":15000}])';
  assert.strictEqual(tcn.stripInlineToolCallNoise(malformed, ON), malformed);
});

test('strips a marker glued to narration, keeps the prose', () => {
  const input = '继续执行 [Tool Call: shellCommand({"command":"ls"})] 然后看结果';
  const out = tcn.stripInlineToolCallNoise(input, ON);
  assert.doesNotMatch(out, /\[Tool\s+Call/);
  assert.match(out, /继续执行/);
  assert.match(out, /然后看结果/);
});

test('preserves a [Tool Call …] marker INSIDE a fenced block', () => {
  const input = '```\n[Tool Call: shell_command({})]\n```';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});

test('splitPendingToolTag holds a partial [Tool Call: … head, releases on complete', () => {
  const r1 = tcn.splitPendingToolTag('前文\n[Tool Call: shell_command({');
  assert.strictEqual(r1.emit, '前文\n');
  assert.strictEqual(r1.pending, '[Tool Call: shell_command({');
  // full marker on the next chunk → joined, complete → released for the settle
  // pass (which strips the whole-line marker).
  const full = r1.pending + 'command":"dir"})]';
  const r2 = tcn.splitPendingToolTag(full);
  assert.strictEqual(r2.pending, '');
  assert.match(r2.emit, /\[Tool Call: shell_command/);
});

test('fragment forms inside a fenced block are preserved', () => {
  const input = '```\nfunction=webSearch>\n<arguments={"q":1}}\n```';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});

// ---------------------------------------------------------------------------
// splitPendingToolTag — streaming cross-chunk suspension pure helper.
// ---------------------------------------------------------------------------

test('splitPendingToolTag: holds a chunk cut at <fun', () => {
  const r = tcn.splitPendingToolTag('答案前文 <fun');
  assert.strictEqual(r.emit, '答案前文 ');
  assert.strictEqual(r.pending, '<fun');
});

test('splitPendingToolTag: holds a chunk cut inside <arguments={"q', () => {
  const r = tcn.splitPendingToolTag('正文<arguments={"q');
  assert.strictEqual(r.emit, '正文');
  assert.strictEqual(r.pending, '<arguments={"q');
});

test('splitPendingToolTag: closing-tag and tool_call prefixes are held too', () => {
  assert.strictEqual(tcn.splitPendingToolTag('x</functi').pending, '</functi');
  assert.strictEqual(tcn.splitPendingToolTag('x<tool_ca').pending, '<tool_ca');
  assert.strictEqual(tcn.splitPendingToolTag('x<').pending, '<');
});

test('splitPendingToolTag: plain prose with < is NOT held (a < b)', () => {
  const r = tcn.splitPendingToolTag('a < b');
  assert.strictEqual(r.emit, 'a < b');
  assert.strictEqual(r.pending, '');
});

test('splitPendingToolTag: completed tag (has >) is NOT held', () => {
  const r = tcn.splitPendingToolTag('x<function=web>');
  assert.strictEqual(r.emit, 'x<function=web>');
  assert.strictEqual(r.pending, '');
});

test('splitPendingToolTag: over-long suspect tail is released (release valve)', () => {
  const long = '<arguments={"q":"' + 'y'.repeat(3000);
  const r = tcn.splitPendingToolTag('前文' + long);
  assert.strictEqual(r.emit, '前文' + long);
  assert.strictEqual(r.pending, '');
});

test('splitPendingToolTag: empty / non-string → emit-all no pending', () => {
  assert.deepStrictEqual(tcn.splitPendingToolTag(''), { emit: '', pending: '' });
  assert.deepStrictEqual(tcn.splitPendingToolTag(null), { emit: '', pending: '' });
});

// ---------------------------------------------------------------------------
// Gate OFF — byte-identical passthrough.
// ---------------------------------------------------------------------------

test('gate off: passthrough byte-identical for leaked forms', () => {
  const leak = '{"name": "open_app", "params": {"name": "夸克"}}\n<function=x>\n</function>\nfunction=webSearch>\n<arguments={"q":1}}';
  assert.strictEqual(tcn.stripInlineToolCallNoise(leak, OFF), leak);
});

test('non-string / empty → returned unchanged', () => {
  assert.strictEqual(tcn.stripInlineToolCallNoise('', ON), '');
  assert.strictEqual(tcn.stripInlineToolCallNoise(null, ON), null);
  assert.strictEqual(tcn.stripInlineToolCallNoise(undefined, ON), undefined);
  assert.strictEqual(tcn.stripInlineToolCallNoise(42, ON), 42);
});

// ---------------------------------------------------------------------------
// Blank-run handling: the leaf does NOT collapse (fence-unaware collapse would
// eat code-block blanks); it leaves blank runs for the fence-aware caller.
// ---------------------------------------------------------------------------

test('removes the noise line, keeps neighbours; leaves blank run for caller to collapse', () => {
  const input = 'a\n\n{"name": "Bash", "params": {"x":1}}\n\nb';
  // line removed → 'a','','','b' — leaf does NOT collapse the resulting \n\n\n.
  const out = tcn.stripInlineToolCallNoise(input, ON);
  assert.doesNotMatch(out, /\{"name"/);
  assert.strictEqual(out, 'a\n\n\nb');
});

test('does NOT collapse blank runs inside a fenced code block (fence-safe)', () => {
  const input = '```\nline1\n\n\nline2\n```';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});

// ---------------------------------------------------------------------------
// C-2 (2026-10-12, 丢字): mid-prose bare tool-call JSON is no longer erased.
// `{"name":…,"params":{…}}` is indistinguishable between a leaked tool call and
// an answer that SHOWS that JSON. Measured loss: `配置片段：{"name":"web_search",
// "params":{"q":"khy"}}` kept only `配置片段：` while the control line
// `{"q":"khy","n":1}` was untouched — the key shape was the only difference.
// ---------------------------------------------------------------------------

test('mid-prose tool-call JSON shown as an answer is KEPT (no longer eaten)', () => {
  const input = '配置片段：{"name":"web_search","params":{"q":"khy"}}';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});

test('mid-prose tool-call JSON is kept regardless of key style / spacing', () => {
  for (const input of [
    '前文 {"name":"open_app","params":{"name":"夸克"}} 后文',
    'here: {"name": "Read", "arguments": {"path": "/x"}}',
    '见 <tool_call>{"name":"Read","params":{"p":"x"}}</tool_call> 一行',
  ]) {
    assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input, `input: ${input}`);
  }
});

test('line-start tool-call JSON is still stripped, and trailing prose survives', () => {
  assert.strictEqual(
    tcn.stripInlineToolCallNoise('{"name":"open_app","params":{"name":"夸克"}}', ON),
    ''
  );
  assert.strictEqual(
    tcn.stripInlineToolCallNoise('{"name":"open_app","params":{"name":"夸克"}} 已启动。', ON),
    '已启动。'
  );
});

// ---------------------------------------------------------------------------
// C-1 (2026-10-12, 丢字): settlePendingToolTag is the stream-boundary settle
// path. The full stripper used to run on the held tail and return '' for
// truncated heads, losing the line for good.
// ---------------------------------------------------------------------------

test('settlePendingToolTag: truncated tails are returned byte-identical (no char loss)', () => {
  for (const tail of [
    '[Tool Call: read(fi',
    '{"name":"open_app","params":{"path":"C:/a.txt"}',
    '{"name":"open_app","params":{"path":"C:/a.txt"',
    '<function',
    '<function=shell_command',
    '{"name"',
    '<',
    '</functi',
    '[Tool Call: shell_command({})',
  ]) {
    assert.strictEqual(tcn.settlePendingToolTag(tail, ON), tail, `tail: ${tail}`);
  }
});

test('settlePendingToolTag: provably complete one-line markers ARE dropped', () => {
  for (const tail of [
    '[Tool Call: shellCommand({"command":"ls"})]',
    '{"name": "open_app", "params": {"name": "夸克"}}',
    'function=webSearch>',
    '</arguments>',
    '<arguments={"q":"x"}>',
    '<tool_call>{"name":"Read","params":{"p":"x"}}</tool_call>',
  ]) {
    assert.strictEqual(tcn.settlePendingToolTag(tail, ON), '', `tail: ${tail}`);
  }
});

test('settlePendingToolTag: 归属确定的协议开标签整行丢弃(不留进流式正文)', () => {
  // flushPendingTag 的返回值会经 setStreamingBoth 进入 live.text,而 finalize 采信
  // live.text(useQueryBridge.js:3265「what streamed is what is stored」)—— 上屏即持久化。
  // 整行开标签是同一次调用在正文里的回声,权威记录是那条 tool_use,留着会在历史里
  // 长期占位、每轮再被当正文读回去。归属判得了,就不该拿「丢字优先」当理由留下。
  for (const tail of ['<tool_call>', '<function=shell_command>', '<arguments={']) {
    assert.strictEqual(tcn.stripInlineToolCallNoise(tail, ON), '', `control: 改前的漏斗也是丢: ${tail}`);
    assert.strictEqual(tcn.settlePendingToolTag(tail, ON), '', `tail: ${tail}`);
  }
  // 同一行带着散文 ⇒ 不是协议行,一个字都不许动。
  const prose = '调用格式是 `<function=read>` 这样。';
  assert.strictEqual(tcn.settlePendingToolTag(prose, ON), prose);
});

test('settlePendingToolTag: a complete inline <function=…>…</function> pair is dropped', () => {
  // 成对且都在这一行 ⇒ 可证完成,屏幕漏斗早就整行吃掉(stripInlineToolCallNoise 的
  // FUNC_INLINE_PAIR_RE 兜底分支)。开标签那条「不丢」的早退分支不认「同行成对」这一形,
  // 结果一个完整标记反而漏上屏 —— 与本函数「只丢可证完整」的口径正好相反。
  for (const tail of [
    '<function=shell_command>{"command":"ls"}</function>',
    '  <function=web_search>{"q":"khy"}</function>  ',
  ]) {
    assert.strictEqual(tcn.stripInlineToolCallNoise(tail, ON), '', `control: funnel drops it: ${tail}`);
    assert.strictEqual(tcn.settlePendingToolTag(tail, ON), '', `tail: ${tail}`);
  }
  // 同一行还带着散文 ⇒ 只该剥掉这一对,剩下的必须留着(与漏斗同口径)。
  const mixed = '<function=Read>{"path":"a.js"}</function> 这条路径已读。';
  assert.strictEqual(tcn.stripInlineToolCallNoise(mixed, ON), '这条路径已读。');
  assert.strictEqual(tcn.settlePendingToolTag(mixed, ON), mixed);
});

test('settlePendingToolTag: 只能整行删除或逐字节保留,永不重写', () => {
  // flushPendingTag 之后直接把返回值 setStreamingBoth 进 live.text(useQueryBridge.js:1911),
  // 所以这一步的**唯一**安全性质是「要么整行归零、要么原样进正文」——它一旦能改写内容,
  // 协议残片就会以被加工过的形态进历史。逐条锁这个二分。
  // 注意:这条**不**约束「该丢还是该留」(那是归属判定,见上面两条),只约束「绝不加工」。
  const tails = [
    '[Tool Call: read(fi',
    '<fun',
    '<tool_call>',
    '<function=shell_command>',
    '<arguments={"q":"x',
    '{"name":"open_app","params":{',
    '这是模型真正的散文结论。',
    '```js\nconst a = 1;\n```',
    '<function=shell_command>{"command":"ls"}</function>',
    '[Tool Call: read(file.js)]',
    '{"name":"Read","params":{"path":"a.js"}}',
    '</function>',
    'function=webSearch>',
  ];
  for (const tail of tails) {
    const got = tcn.settlePendingToolTag(tail, ON);
    assert.ok(got === '' || got === tail, `settle 必须整删或原样,得到 ${JSON.stringify(got)} ← ${JSON.stringify(tail)}`);
  }
});

test('settlePendingToolTag: multi-line / empty / non-string → unchanged', () => {
  assert.strictEqual(tcn.settlePendingToolTag('a\n[Tool Call: x({})]', ON), 'a\n[Tool Call: x({})]');
  assert.strictEqual(tcn.settlePendingToolTag('', ON), '');
  assert.strictEqual(tcn.settlePendingToolTag(null, ON), null);
});

test('settlePendingToolTag: gate off → byte-identical passthrough', () => {
  const marker = '[Tool Call: shellCommand({"command":"ls"})]';
  assert.strictEqual(tcn.settlePendingToolTag(marker, OFF), marker);
  assert.strictEqual(tcn.settlePendingToolTag('a <', OFF), 'a <');
});

// ---------------------------------------------------------------------------
// B (2026-10-12): the whole-line holds get their own tighter budget. A line is
// re-held from its start on every chunk, so waiting for a 2KB line to close cost
// the user up to 800 ms of frozen screen; PENDING_TAG_MAX (2048) still caps the
// `<…` tail hold.
// ---------------------------------------------------------------------------

test('splitPendingToolTag: a long whole-line JSON head is released past the settle budget', () => {
  // Stays held while short enough that it still plausibly completes soon.
  const short = 'a\n{"name":"Read","params":{"path":"/' + 'x'.repeat(200);
  assert.notStrictEqual(tcn.splitPendingToolTag(short).pending, '');
  // Released verbatim once it outgrows the budget — never dropped.
  const long = 'a\n{"name":"Read","params":{"path":"/' + 'x'.repeat(600);
  const r = tcn.splitPendingToolTag(long);
  assert.strictEqual(r.pending, '');
  assert.strictEqual(r.emit, long);
});

test('splitPendingToolTag: a long [Tool Call: head is released past the settle budget', () => {
  const long = 'a\n[Tool Call: shell_command({"command":"' + 'x'.repeat(600);
  const r = tcn.splitPendingToolTag(long);
  assert.strictEqual(r.pending, '');
  assert.strictEqual(r.emit, long);
});

test('the <… tail hold keeps the 2048 release valve', () => {
  // Well past PENDING_TAG_SETTLE_MAX, still held: a tag's own argument body is
  // what sets this length, and PENDING_TAG_MAX is the only cap on it.
  const tail = '<arguments={"q":"' + 'y'.repeat(1000);
  assert.strictEqual(tcn.splitPendingToolTag(tail).pending, tail);
  // Past PENDING_TAG_MAX → released.
  const over = '<arguments={"q":"' + 'y'.repeat(3000);
  const r = tcn.splitPendingToolTag(over);
  assert.strictEqual(r.pending, '');
  assert.strictEqual(r.emit, over);
});
