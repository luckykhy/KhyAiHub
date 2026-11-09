#!/usr/bin/env node
'use strict';

/**
 * generate-appfunctions-metadata.js — emit the AppFunctions metadata XML from
 * the single source of truth.
 *
 * WHY A GENERATOR INSTEAD OF HAND-WRITTEN XML. The description field of an
 * AppFunction is the routing instruction the assistant's model reads when
 * deciding which function to call, and it already lives in
 * `Tools.ROUTING` (written in exactly the format StepOS's own first-party
 * functions ship — read off `dumpsys app_function` on a PZ261A). Hand-copying
 * that text into two XML files guarantees drift, and the failure mode is silent:
 * the system reads the XML, so a stale copy keeps routing on old instructions
 * while the Java table says something else.
 *
 * Two files, because this ROM's own apps declare both the legacy and the v2
 * property (verified: `com.stepos.appstore`, `com.stepos.media.camera`,
 * `com.stepos.weather` all do). Which one the framework actually reads is not
 * something this project can determine from outside, so both are emitted and a
 * test pins that they declare the same function set.
 *
 * Usage: node generate-appfunctions-metadata.js [--check]
 *   --check  do not write; exit 1 if the files on disk differ from what would
 *            be emitted. This is the form CI should call.
 *
 * Paths are resolved from this file's location, never from cwd.
 */

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ANDROID_APP = path.join(HERE, '..', 'android', 'app');
const TOOLS_JAVA = path.join(
  ANDROID_APP, 'src', 'main', 'java', 'com', 'khyos', 'khy_os_client', 'bridge', 'Tools.java'
);
const KHYUI_JAVA = path.join(
  ANDROID_APP, 'src', 'main', 'java', 'com', 'khyos', 'khy_os_client', 'bridge', 'KhyUi.java'
);
const ASSETS = path.join(ANDROID_APP, 'src', 'main', 'assets');

const PREFIX = 'com.khyos.khy_os_client.bridge.KhyAppFunctions#';

/**
 * AppSearch type codes. Only `string` is exercised on this device — every
 * first-party parameter in `dumpsys app_function` is type 8, including
 * semantically numeric ones (weather's startHour). The map exists so adding a
 * numeric type later is a one-line, visible decision rather than a magic number
 * buried in the emitter.
 */
const TYPE_CODE = { string: 8 };

/**
 * Pull {tool, description} out of Tools.ROUTING, applying javac's text-block
 * rules exactly.
 *
 * THE SUBTLETY THAT MATTERS. javac computes the incidental indentation over
 * EVERY non-blank line of the text block **including the two delimiter lines**,
 * not just the content lines. Here the opening delimiter sits on a line indented
 * 8 (`        {"ui_dump", """`) while every content line is indented 16, so
 * javac strips 8 and the value keeps 8 leading spaces per line. A generator that
 * only looks at content lines strips 16 and emits different text — which is
 * exactly the drift this file exists to prevent, and it is invisible until
 * something compares the two at runtime.
 *
 * The source deliberately contains no `\` line continuations either: a
 * continuation carries the next line's indentation into the value on top of all
 * this, which used to produce runs of literal spaces mid-sentence in text a
 * model reads.
 */
function readRouting() {
  const src = fs.readFileSync(TOOLS_JAVA, 'utf8');
  const start = src.indexOf('static final String[][] ROUTING = {');
  if (start < 0) throw new Error('ROUTING table not found in Tools.java');
  const open = src.indexOf('{', start);
  // Walk to the matching close brace of the initialiser.
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = src.slice(open + 1, i);

  const rows = [];
  // Row shape (the delimiter placement is deliberate — see applyTextBlockRules):
  //     {
  //         "tool",
  //         """
  //         <content>
  //         last content line"""},
  const re = /([ \t]*)\{\s*\n\s*"([a-z0-9_]+)",\s*\n\s*"""([\s\S]*?)"""\s*\}/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    rows.push({ tool: m[2], description: applyTextBlockRules(m[3]) });
  }
  if (rows.length === 0) throw new Error('parsed zero ROUTING rows — regex and source drifted');
  return rows;
}

/**
 * Pull {tool, params:[{name, type, required, description}]} out of KhyUi.PARAMS.
 *
 * WHY A SECOND SOURCE. Tools.ROUTING says what a tool does; it says nothing the
 * platform can validate about what a tool takes, and until this was added the
 * metadata declared no parameters at all — so the assistant could see the
 * description and still have no idea ui_swipe wants x1/y1/x2/y2. The values are
 * read by KhyUi's private methods, so the table lives beside them; this function
 * only transcribes it.
 *
 * Returns a Map keyed by tool. A tool with no params is absent, not empty —
 * absent is what makes "no <parameters> element" the right output for it.
 */
function readParams() {
  const src = fs.readFileSync(KHYUI_JAVA, 'utf8');
  const start = src.indexOf('static final String[][] PARAMS = {');
  if (start < 0) throw new Error('PARAMS table not found in KhyUi.java');
  const open = src.indexOf('{', start);
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = src.slice(open + 1, i);

  const byTool = new Map();
  // Row shape: {"tool", "param", "type", "required", "description"} on one line.
  // Comments and blank lines inside the initialiser simply do not match.
  const re = /\{\s*"([a-z0-9_]+)",\s*"([a-z0-9_]+)",\s*"([a-z]+)",\s*"(true|false)",\s*"([^"]*)"\s*\}/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const [, tool, name, type, required, description] = m;
    if (!byTool.has(tool)) byTool.set(tool, []);
    byTool.get(tool).push({ name, type, required, description });
  }
  return byTool;
}

/**
 * javac's text-block normalisation, as MEASURED rather than remembered.
 *
 * Two rules, both established by compiling a throwaway file with javac 17:
 *   1. the common indentation of the content lines is removed;
 *   2. **trailing white space is stripped from every line** — this one is easy
 *      to miss and it is exactly what a generator gets wrong: the source wraps
 *      a long sentence with ` / ` at a line break, the wrap leaves a space at
 *      end of line, and the emitted description then differs from javac's value
 *      by one invisible character per wrap. Nothing errors; a comparison just
 *      never matches.
 *
 * The source deliberately contains no `\` line continuations either: a
 * continuation carries the next line's indentation into the value on top of all
 * this, which used to produce runs of literal spaces mid-sentence in text a
 * model reads.
 */
function applyTextBlockRules(content) {
  const lines = content.split('\n');
  const indents = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => l.match(/^[ \t]*/)[0].length);
  const common = indents.length ? Math.min(...indents) : 0;
  return lines
    .map((l) => l.slice(common).replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n/, '')
    .replace(/\n$/, '');
}

function xmlEscape(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function legacyXml(rows) {
  const items = rows
    .map(
      (r) =>
        '  <appfunction>\n' +
        `    <function_id>${PREFIX}${r.tool}</function_id>\n` +
        '    <enabled_by_default>true</enabled_by_default>\n' +
        `    <description>${xmlEscape(r.description)}</description>\n` +
        '  </appfunction>'
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<appfunctions>\n${items}\n</appfunctions>\n`;
}

/**
 * The <parameters> elements for one tool, or '' when it takes none.
 *
 * Element order and the `<id>unused</id>` placeholders are copied verbatim from
 * com.stepos.appstore's own app_functions_v2.xml — that file is the only shape
 * proven to survive this ROM's indexer (its params come out of
 * `dumpsys app_function` as description/isRequired/name/dataTypeMetadata).
 * Reordering them is not a style choice.
 *
 * `type` is the AppSearch type code; 8 is String. See the comment on KhyUi.PARAMS
 * for why every row is a string and why that is safe for our readers.
 */
function parametersXml(params) {
  if (!params || params.length === 0) return '';
  return (
    params
      .map(
        (p) =>
          '    <parameters>\n' +
          '      <dataTypeMetadata>\n' +
          '        <id>unused</id>\n' +
          '        <isNullable>false</isNullable>\n' +
          `        <type>${TYPE_CODE[p.type] || TYPE_CODE.string}</type>\n` +
          '      </dataTypeMetadata>\n' +
          '      <id>unused</id>\n' +
          `      <isRequired>${p.required}</isRequired>\n` +
          `      <name>${xmlEscape(p.name)}</name>\n` +
          `      <description>${xmlEscape(p.description)}</description>\n` +
          '    </parameters>'
      )
      .join('\n') + '\n'
  );
}

function v2Xml(rows, paramsByTool) {
  const items = rows
    .map(
      (r) =>
        '  <appfunction>\n' +
        `    <id>${PREFIX}${r.tool}</id>\n` +
        '    <enabledByDefault>true</enabledByDefault>\n' +
        `    <description>${xmlEscape(r.description)}</description>\n` +
        parametersXml(paramsByTool.get(r.tool)) +
        '    <response>\n' +
        '      <id>unused</id>\n' +
        '      <valueType>\n' +
        '        <id>unused</id>\n' +
        '        <isNullable>false</isNullable>\n' +
        '        <type>8</type>\n' +
        '      </valueType>\n' +
        '    </response>\n' +
        `    <functionId>${PREFIX}${r.tool}</functionId>\n` +
        '  </appfunction>'
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<appfunctions>\n${items}\n</appfunctions>\n`;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const rows = readRouting();

  // Only tools the service actually exposes get metadata. A function declared
  // but not dispatched is worse than one not declared: the assistant would
  // route to it and get a not-found.
  const KhyAppFunctions = fs.readFileSync(
    path.join(ANDROID_APP, 'src', 'main', 'java', 'com', 'khyos', 'khy_os_client', 'bridge', 'KhyAppFunctions.java'),
    'utf8'
  );
  const exposedBlock = KhyAppFunctions.match(/static final String\[\] EXPOSED = \{([\s\S]*?)\};/);
  if (!exposedBlock) throw new Error('EXPOSED not found in KhyAppFunctions.java');
  const exposed = exposedBlock[1].match(/"([a-z0-9_]+)"/g).map((s) => s.slice(1, -1));

  const missing = exposed.filter((t) => !rows.some((r) => r.tool === t));
  if (missing.length > 0) {
    throw new Error(
      `这些暴露出去的 AppFunction 在 Tools.ROUTING 里没有描述: ${missing.join(', ')}。` +
        '没有描述的函数会把空路由指令发给模型。'
    );
  }
  const rowsToEmit = rows.filter((r) => exposed.includes(r.tool));

  const paramsByTool = readParams();

  // A declared param the description never names is worse than no param: the
  // model reads the description to decide what to send, so it would route
  // correctly and then omit the argument — a failure that looks like the tool is
  // broken rather than the metadata. This is the check that would have caught
  // ui_swipe's description saying `durationMs` while the code read `ms`.
  const unnamed = [];
  for (const [tool, params] of paramsByTool) {
    if (!exposed.includes(tool)) continue;
    const row = rowsToEmit.find((r) => r.tool === tool);
    if (!row) continue;
    for (const p of params) {
      if (!row.description.includes(p.name)) unnamed.push(`${tool}.${p.name}`);
    }
  }
  if (unnamed.length > 0) {
    throw new Error(
      `这些参数在 Tools.ROUTING 的描述里没有被提到: ${unnamed.join(', ')}。` +
        '模型只读描述来决定填什么，描述里没有的参数名它不会填。'
    );
  }

  // A tool in EXPOSED that reads params but has none declared would silently
  // ship an empty <parameters> — the exact gap this table was added to close.
  // The set is DERIVED from KhyUi, not listed: walk dispatch's if-chain to learn
  // which private method each tool routes to, then check whether that method
  // body reads `a.opt…`. A hand-written list here would be a second source of
  // truth for the same fact, which is the failure mode this whole file exists
  // to prevent.
  const khyUiSrc = fs.readFileSync(KHYUI_JAVA, 'utf8');
  const toolToMethod = new Map();
  const routeRe = /tool\.equals\("([a-z0-9_]+)"\)\)\s*return\s+([a-zA-Z0-9_]+)\(/g;
  let rm;
  while ((rm = routeRe.exec(khyUiSrc)) !== null) toolToMethod.set(rm[1], rm[2]);

  const methodReadsParams = new Map();
  const methodRe = /private static JSONObject ([a-zA-Z0-9_]+)\(JSONObject a\)[\s\S]*?\n    \}/g;
  let mm;
  while ((mm = methodRe.exec(khyUiSrc)) !== null) {
    methodReadsParams.set(mm[1], /a\.opt[A-Za-z]*\(/.test(mm[2]));
  }

  const undeclared = [];
  for (const [tool, method] of toolToMethod) {
    if (!exposed.includes(tool)) continue;
    if (!methodReadsParams.get(method)) continue; // takes nothing
    if (!paramsByTool.has(tool)) undeclared.push(tool);
  }
  if (undeclared.length > 0) {
    throw new Error(`这些工具在读参数但 KhyUi.PARAMS 里没有声明: ${undeclared.join(', ')}`);
  }

  const targets = [
    ['app_functions.xml', legacyXml(rowsToEmit)],
    ['app_functions_v2.xml', v2Xml(rowsToEmit, paramsByTool)],
  ];

  let drift = 0;
  for (const [name, content] of targets) {
    const p = path.join(ASSETS, name);
    const current = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    if (current === content) continue;
    drift++;
    if (checkOnly) {
      console.error(`DRIFT: ${name} 与 Tools.ROUTING / EXPOSED 不一致`);
    } else {
      fs.mkdirSync(ASSETS, { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
      console.log(`wrote ${name} (${rowsToEmit.length} functions)`);
    }
  }
  if (checkOnly && drift > 0) process.exit(1);
  if (drift === 0) console.log(`up to date (${rowsToEmit.length} functions, 2 files)`);
}

main();
