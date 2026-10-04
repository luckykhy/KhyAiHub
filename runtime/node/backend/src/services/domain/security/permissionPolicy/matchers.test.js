'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const m = require('./matchers');

describe('matchers — detectCategory', () => {
  test('静态表命中，规范化大小写/分隔符', () => {
    assert.equal(m.detectCategory('Read'), 'fileRead');
    assert.equal(m.detectCategory('read_file'), 'fileRead');
    assert.equal(m.detectCategory('WRITE'), 'fileWrite');
    assert.equal(m.detectCategory('MultiEdit'), 'fileWrite');
    assert.equal(m.detectCategory('rm'), 'fileDelete');
    assert.equal(m.detectCategory('WebFetch'), 'network');
    assert.equal(m.detectCategory('Bash'), 'shell');
    assert.equal(m.detectCategory('gitPush'), 'git');
    assert.equal(m.detectCategory('executeCode'), 'codeExec');
  });
  test('RED-LINE GUARD：constructor/__proto__/toString 作为工具名安全回落 other（Map 查找，原型链不泄漏）', () => {
    // CATEGORY_BY_TOOL is a Map, so a toolName of 'constructor' does NOT hit
    // Object.prototype; it falls through to hints/params → 'other'. This is the
    // safe outcome; asserted so a future refactor to a plain object is caught.
    assert.equal(m.detectCategory('constructor'), 'other');
    assert.equal(m.detectCategory('__proto__'), 'other');
    assert.equal(m.detectCategory('toString'), 'other');
    assert.equal(m.detectCategory('*'), 'other');
    assert.equal(m.detectCategory(''), 'other');
    assert.equal(m.detectCategory(null), 'other');
    assert.equal(m.detectCategory(undefined), 'other');
  });
  test('hint.category 兜底：execution 依 command 分 shell/codeExec', () => {
    assert.equal(m.detectCategory('custom', { command: 'x' }, { category: 'Execution' }), 'shell');
    assert.equal(m.detectCategory('custom', { code: '1', language: 'js' }, { category: 'execution' }), 'codeExec');
    assert.equal(m.detectCategory('custom', {}, { category: 'data' }), 'network');
    assert.equal(m.detectCategory('custom', {}, { category: 'git' }), 'git');
  });
  test('filesystem hint 依只读/破坏性位分读/删/写', () => {
    assert.equal(m.detectCategory('x', {}, { category: 'filesystem', isReadOnly: true }), 'fileRead');
    assert.equal(m.detectCategory('x', {}, { category: 'filesystem', isDestructive: true }), 'fileDelete');
    assert.equal(m.detectCategory('x', {}, { category: 'filesystem' }), 'fileWrite');
  });
  test('参数形态启发式兜底', () => {
    assert.equal(m.detectCategory('x', { url: 'http://a' }), 'network');
    assert.equal(m.detectCategory('x', { cmd: 'ls' }), 'shell');
    assert.equal(m.detectCategory('x', { code: '1', language: 'py' }), 'codeExec');
    assert.equal(m.detectCategory('x', { file_path: '/a' }), 'fileWrite');
    assert.equal(m.detectCategory('x', { path: '/a' }, { isReadOnly: true }), 'fileRead');
  });
});

describe('matchers — extract helpers', () => {
  test('extractPath 键优先级与 null 回落', () => {
    assert.equal(m.extractPath({ file_path: '/a' }), '/a');
    assert.equal(m.extractPath({ filePath: '/b' }), '/b');
    assert.equal(m.extractPath({ path: '/c' }), '/c');
    assert.equal(m.extractPath({ target: '/d' }), '/d');
    assert.equal(m.extractPath({}), null);
    assert.equal(m.extractPath(), null);
  });
  test('extractUrl 支持 urls 数组首元素与 endpoint', () => {
    assert.equal(m.extractUrl({ url: 'http://a' }), 'http://a');
    assert.equal(m.extractUrl({ urls: ['http://x', 'http://y'] }), 'http://x');
    assert.equal(m.extractUrl({ endpoint: 'http://z' }), 'http://z');
    assert.equal(m.extractUrl({ urls: 'notarray' }), null);
    assert.equal(m.extractUrl({}), null);
  });
  test('extractLanguage 归一小写，假值 → null', () => {
    assert.equal(m.extractLanguage({ language: 'Python' }), 'python');
    assert.equal(m.extractLanguage({ lang: ' JS ' }), 'js');
    assert.equal(m.extractLanguage({}), null);
    assert.equal(m.extractLanguage({ language: '' }), null);
    assert.equal(m.extractLanguage({ language: 0 }), null);
  });
  test('extractCommand 三键回落 null', () => {
    assert.equal(m.extractCommand({ command: 'ls' }), 'ls');
    assert.equal(m.extractCommand({ cmd: 'pwd' }), 'pwd');
    assert.equal(m.extractCommand({ script: 'echo' }), 'echo');
    assert.equal(m.extractCommand({}), null);
  });
});

describe('matchers — globToRegExp', () => {
  test('单 * 不跨分隔符，** 跨分隔符', () => {
    assert.equal(m.globToRegExp('/a/*').test('/a/b'), true);
    assert.equal(m.globToRegExp('/a/*').test('/a/b/c'), false);
    assert.equal(m.globToRegExp('/a/**').test('/a/b/c'), true);
  });
  test('锚定全串匹配（首尾 ^$）', () => {
    assert.equal(m.globToRegExp('abc').test('xabc'), false);
    assert.equal(m.globToRegExp('abc').test('abcx'), false);
    assert.equal(m.globToRegExp('abc').test('abc'), true);
  });
  test('正则特殊字符被转义为字面量', () => {
    assert.equal(m.globToRegExp('a.b').test('aXb'), false);
    assert.equal(m.globToRegExp('a.b').test('a.b'), true);
    assert.equal(m.globToRegExp('a+b').test('aab'), false);
    assert.equal(m.globToRegExp('(x)').test('(x)'), true);
    assert.equal(m.globToRegExp('[a]').test('[a]'), true);
    assert.equal(m.globToRegExp('[a]').test('a'), false);
  });
  test('路径含空格/反斜杠按字面匹配，不误切', () => {
    assert.equal(m.globToRegExp('/a b/*').test('/a b/c'), true);
    assert.equal(m.globToRegExp('/a b/*').test('/aXb/c'), false);
    // glob 分隔符 [/\\] 同时吃正/反斜杠
    assert.equal(m.globToRegExp('/a/*').test('\\a\\c'), true);
  });
  test('转义字符 * 与通配 * 区分：字面星需转义无法表达，作为通配', () => {
    assert.equal(m.globToRegExp('*').test('anything'), true);
    assert.equal(m.globToRegExp('*.js').test('index.js'), true);
  });
  test('垃圾入参不抛，空 pattern 只匹配空串', () => {
    assert.equal(m.globToRegExp(null).test(''), true);
    assert.equal(m.globToRegExp('').test('x'), false);
    assert.equal(m.globToRegExp(undefined).test(''), true);
  });
});

describe('matchers — matchPath', () => {
  test('空目标 / 非数组 / 空列表 → false（无白名单即不放行）', () => {
    assert.equal(m.matchPath('', ['/a']), false);
    assert.equal(m.matchPath(null, ['/a']), false);
    assert.equal(m.matchPath('/a', 'nope'), false);
    assert.equal(m.matchPath('/a', []), false);
    assert.equal(m.matchPath('/a', null), false);
  });
  test('绝对/相对与反斜杠候选都参与匹配', () => {
    assert.equal(m.matchPath('/etc/passwd', ['/etc/*']), true);
    assert.equal(m.matchPath('C:\\a\\b', ['C:/a/*']), true);
  });
  test('~ 前缀展开到 home', () => {
    const os = require('os');
    assert.equal(m.matchPath(`${os.homedir()}/secret`, ['~/secret']), true);
  });
  test('prototype key 作为 pattern 不影响（pattern 是 glob 串，非查表）', () => {
    assert.equal(m.matchPath('/constructor', ['/*']), true);
    assert.equal(m.matchPath('__proto__x', ['__proto__*']), true);
  });
  test('不跨锚定误命中：/a/b 不匹配 /a', () => {
    assert.equal(m.matchPath('/a/b', ['/a']), false);
  });
});

describe('matchers — matchUrl', () => {
  test('空 url / 非数组 / 空列表 → false', () => {
    assert.equal(m.matchUrl('', ['*']), false);
    assert.equal(m.matchUrl('http://a', 'nope'), false);
    assert.equal(m.matchUrl('http://a', []), false);
  });
  test('裸域名 pattern 匹配 host；*.x.com 覆盖 x.com 与子域', () => {
    assert.equal(m.matchUrl('https://github.com/x', ['github.com']), true);
    assert.equal(m.matchUrl('https://api.github.com/x', ['*.github.com']), true);
    assert.equal(m.matchUrl('https://github.com/x', ['*.github.com']), true);
  });
  test('RED-LINE GUARD：后缀伪装域名不得放行（钉住当前正确行为）', () => {
    // Anchored host match means evil.github.com.attacker.com must NOT satisfy
    // *.github.com. Asserted so a loosening of the anchor is caught.
    assert.equal(m.matchUrl('https://evil.github.com.attacker.com/', ['*.github.com']), false);
    assert.equal(m.matchUrl('https://agithub.com/', ['github.com']), false);
  });
  test('URL glob（含 ://）按整串匹配；单 * 不跨额外路径段（与分隔符语义一致）', () => {
    assert.equal(m.matchUrl('https://api.x.com/asset', ['https://api.x.com/*']), true);
    assert.equal(m.matchUrl('https://api.x.com/v1/a', ['https://api.x.com/*']), false);
    assert.equal(m.matchUrl('https://api.x.com/v1/a', ['https://api.x.com/**']), true);
    assert.equal(m.matchUrl('https://api.x.com/v1/a', ['https://other.com/*']), false);
  });
  test('无协议 url 补 https 再取 host', () => {
    assert.equal(m.matchUrl('github.com', ['github.com']), true);
  });
  test('非法 url 不抛，host 空时裸域名 pattern 不命中', () => {
    assert.equal(m.matchUrl('::::', ['github.com']), false);
  });
  test('空 pattern 串被跳过', () => {
    assert.equal(m.matchUrl('http://a.com', ['', '   ']), false);
  });
});

describe('matchers — isSensitiveOperation', () => {
  test('命中命令子串（大小写无关）', () => {
    assert.equal(m.isSensitiveOperation('Bash', { command: 'git push origin' }, ['git push']), true);
    assert.equal(m.isSensitiveOperation('Bash', { command: 'GIT PUSH' }, ['git push']), true);
    assert.equal(m.isSensitiveOperation('Bash', { command: 'ls' }, ['rm -rf']), false);
  });
  test('无 command 时回落 "<tool> <json params>" 子串匹配', () => {
    assert.equal(m.isSensitiveOperation('deploy', { env: 'prod' }, ['deploy']), true);
  });
  test('空 patterns / 非数组 / 空 pattern 项 → false', () => {
    assert.equal(m.isSensitiveOperation('x', {}, []), false);
    assert.equal(m.isSensitiveOperation('x', {}, null), false);
    assert.equal(m.isSensitiveOperation('x', { command: 'abc' }, ['']), false);
  });
  test('循环引用 params 不抛（catch 回落 toolName）', () => {
    const p = {};
    p.self = p;
    assert.equal(m.isSensitiveOperation('drop table', p, ['drop table']), true);
  });
});
