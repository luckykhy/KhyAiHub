'use strict';

// thinkingBlockState.test.cjs — 思维链折叠块（ThinkingBlock.tsx）交互契约的钉住用例。
//
// 覆盖用户本次诉求的核心交互：
//   (a) 默认收起           —— useState(false) + 内容区由 expanded 门控
//   (b) 点一下展开         —— 头部 button 的 onClick 是 setExpanded 取反
//   (c) 再点收起           —— 同一个 button 是唯一切换入口（全文仅一处 setExpanded 调用点）
//   (d) 整条头部是 button  —— 带 type="button" / aria-expanded / data-testid
//   (e) text 为空早退      —— return null，不渲染空壳
//   (f) enabled 为 false 早退 —— return null，不是渲染成空壳
//   (g) 视觉契约           —— bg-reasoning-surface 底色 + border-l-trajectory-reasoning 左侧强调边
//   (h) 四个 i18n 键各消费一次 —— chat.reasoning.thinking / .thought / chat.message.expand / .collapse
//   集成 —— MessageBubble 的渲染门控（role=assistant 且 reasoning 非空）与位置（先于 TrajectoryTimeline）
//
// 风格说明（照 sessionLoadState.test.cjs 的成例）：本仓库是 Electron 应用，
// 没有 jsdom / testing-library，也不允许为此新增依赖，因此交互契约用**源码级断言**
// 钉住。没测的：React 在真实 DOM 里的重渲染时序、真实鼠标点击的视觉反馈。
//
// runner 纪律：本文件用 node:test 写、放在 tests/ 下安全。绝不用裸
// describe/test/expect —— 那是 jest 风格，会被 node --test 扫走并炸在
// 「describe is not defined」。

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const projectRoot = join(__dirname, '..');
const blockPath = join(projectRoot, 'src', 'renderer', 'components', 'message', 'ThinkingBlock.tsx');
const listPath = join(projectRoot, 'src', 'renderer', 'components', 'message', 'MessageBubble.tsx');
const i18nPath = join(projectRoot, 'src', 'renderer', 'i18n', 'zh-CN.json');

function read(p) {
  // 去掉 BOM：部分源文件带 UTF-8 BOM，转译后会成为正文字符
  return readFileSync(p, 'utf-8').replace(/^﻿/, '');
}

// 只留代码、去掉注释：本文件的断言是「实现里确实存在某个形态」，而实现里的
// **说明文字**（设计沿革）也可能命中关键词，对注释做断言会误报。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const blockSrc = stripComments(read(blockPath));
const listSrc = stripComments(read(listPath));
const i18n = JSON.parse(read(i18nPath));

function count(hay, needle) {
  return hay.split(needle).length - 1;
}

// 取出 {expanded && ( ... )} 这段内容区（懒匹配到第一个右括号右花括号；内容区内没有更早的 )} ）
function contentRegion() {
  const open = blockSrc.indexOf('{expanded && (');
  assert.ok(open > -1, '必须存在 {expanded && ( 门控');
  const m = blockSrc.slice(open).match(/\{expanded && \(([\s\S]*?)\)\}/);
  assert.ok(m, '应能定位 expanded && 包裹的内容区');
  return m[1];
}

function headerButton() {
  const m = blockSrc.match(/<button\b[\s\S]*?<\/button>/);
  assert.ok(m, '必须存在头部 button');
  return m[0];
}

// ── (a) 默认收起 ────────────────────────────────────────────────────────────

test('(a) 默认收起：expanded 初值为 false', () => {
  assert.match(blockSrc, /const \[expanded, setExpanded\] = useState\(false\)/,
    '默认必须是收起态 —— useState(false)，不是 true');
});

test('(a) 默认收起：内容区由 expanded 门控，而不是恒渲染', () => {
  const content = contentRegion();
  assert.match(content, /\{text\}/, '内容区必须渲染思维链全文 {text}');
  // 收起态下内容区不可见：内容区自身不得再挂二次开关
  assert.doesNotMatch(content, /onClick/, '内容区不应再挂 onClick（切换入口只在头部）');
  assert.doesNotMatch(content, /setExpanded/, '内容区不应自己改 expanded（切换入口只在头部）');
});

// ── (b) 点一下展开 ──────────────────────────────────────────────────────────

test('(b) 点一下展开：头部 button 的 onClick 是 setExpanded 取反', () => {
  assert.match(headerButton(), /onClick=\{\(\) => setExpanded\(v => !v\)\}/,
    '点击必须走 setExpanded 取反（点一下 → true → 展开）');
});

// ── (c) 再点收起 ────────────────────────────────────────────────────────────

test('(c) 再点收起：全文只有一处 setExpanded 调用点（去掉 useState 解构后）', () => {
  const withoutDecl = blockSrc.replace(/const \[expanded, setExpanded\] = useState\([a-z]+\)/, '');
  assert.equal(count(withoutDecl, 'setExpanded'), 1,
    '除 useState 解构外只允许一处 setExpanded —— 否则会出现第二个切换入口，破坏「同一个 button 唯一切换」');
});

test('(c) 再点收起：唯一的调用点就在头部 button 内部', () => {
  const button = headerButton();
  const callAt = blockSrc.indexOf('setExpanded(v => !v)');
  const buttonAt = blockSrc.indexOf('<button');
  assert.ok(callAt > -1, '必须存在 setExpanded 调用点');
  assert.ok(callAt > buttonAt && callAt < buttonAt + button.length,
    'setExpanded 调用点必须落在头部 button 元素内部（整条头部是切换入口）');
});

test('(c) 再点收起：取反语义对再次点击同样成立（无分支逃逸）', () => {
  // 同一个 () => setExpanded(v => !v) 表达式天然对称：true→false 即再点收起。
  // 这里钉住它没被写成只置 true / 只置 false / 直读外部值的形式。
  assert.doesNotMatch(blockSrc, /setExpanded\(true\)/, '不得写成只展开的调用（再点就收不回去了）');
  assert.doesNotMatch(blockSrc, /setExpanded\(false\)/, '不得写成只收起的调用（点一下展不开了）');
  assert.doesNotMatch(blockSrc, /setExpanded\(!expanded\)/, '应统一用 setExpanded(v => !v) 的函数式取反');
});

// ── (d) 整条头部是 button ───────────────────────────────────────────────────

test('(d) 整条头部是 button：type="button" + aria-expanded + data-testid', () => {
  const button = headerButton();
  assert.match(button, /type="button"/, '必须是 type="button"（不应在表单里默认 submit）');
  assert.match(button, /aria-expanded=\{expanded\}/, '必须带 aria-expanded={expanded}（无障碍状态可读）');
  assert.match(button, /data-testid="chat-reasoning-trigger"/, '必须带稳定 data-testid 供端到端定位');
  assert.match(button, /w-full/, '按钮必须铺满整条头部（整条可点，不是只有文字可点）');
});

test('(d) 头部 button 承载标题与展开/收起文案（不是裸容器）', () => {
  const button = headerButton();
  assert.match(button, /\{title\}/, '头部必须渲染标题 {title}');
  assert.match(button, /chat\.message\.expand/, '头部必须显示「展开」文案');
  assert.match(button, /chat\.message\.collapse/, '头部必须显示「收起」文案');
});

// ── (e) text 为空早退 ───────────────────────────────────────────────────────

test('(e) text 为空早退：return null，不渲染空壳', () => {
  assert.match(blockSrc, /if \(!text \|\| enabled === false\) return null/,
    '空思维链必须整体 return null');
  const guard = blockSrc.match(/if \(!text \|\| enabled === false\) return null/);
  assert.ok(guard, '早退必须出现在组件体最前面');
  // 早退必须先于 useState( 调用（import 行也含 useState 字样，故匹配到左括号）
  assert.ok(blockSrc.indexOf(guard[0]) < blockSrc.indexOf('useState('),
    '早退必须先于 useState( —— 否则空文本也会白占一个 state');
});

// ── (f) enabled 为 false 早退 ───────────────────────────────────────────────

test('(f) enabled 为 false 早退：与空文本同一条 return null', () => {
  assert.match(blockSrc, /enabled === false/, '关闭设置必须整体不渲染（不是渲染成空壳）');
  assert.equal(count(blockSrc, 'return null'), 1, '只允许一条 return null 收口两条早退');
});

test('(f) enabled 缺省为 true（不传 = 显示），签名带 enabled?: boolean', () => {
  assert.match(blockSrc, /enabled = true/, '缺省值必须是 true —— 读不到设置时一律显示');
  assert.match(blockSrc, /enabled\?: boolean/, '类型必须显式声明 enabled?: boolean');
});

// ── (g) 视觉契约 ────────────────────────────────────────────────────────────

test('(g) 根节点同时带 bg-reasoning-surface 底色与 border-l-trajectory-reasoning 左侧强调边', () => {
  assert.match(blockSrc,
    /<div className="[^"]*border-l-trajectory-reasoning[^"]*bg-reasoning-surface[^"]*"/,
    '根 div 的 className 必须同时含左侧强调边与思考底色');
  assert.match(blockSrc, /border-l-2/, '左侧强调边必须是 2px 档（border-l-2）');
});

// ── (h) i18n 键 ─────────────────────────────────────────────────────────────

test('(h) 四个 i18n 键各消费一次', () => {
  assert.equal(count(blockSrc, "t('chat.reasoning.thinking')"), 1, 'chat.reasoning.thinking 必须恰好消费一次');
  assert.equal(count(blockSrc, "t('chat.reasoning.thought')"), 1, 'chat.reasoning.thought 必须恰好消费一次');
  assert.equal(count(blockSrc, "t('chat.message.expand')"), 1, 'chat.message.expand 必须恰好消费一次');
  assert.equal(count(blockSrc, "t('chat.message.collapse')"), 1, 'chat.message.collapse 必须恰好消费一次');
});

test('(h) 四个 i18n 键在 zh-CN.json 里存在且非空（不得出现 missing key）', () => {
  for (const key of ['chat.reasoning.thinking', 'chat.reasoning.thought', 'chat.message.expand', 'chat.message.collapse']) {
    assert.equal(typeof i18n[key], 'string', `${key} 必须是字符串`);
    assert.ok(i18n[key].length > 0, `${key} 不得为空串`);
  }
});

test('(h) 流式/非流态标题分流：isStreaming → thinking，否则 → thought', () => {
  assert.match(blockSrc,
    /isStreaming \? t\('chat\.reasoning\.thinking'\) : t\('chat\.reasoning\.thought'\)/,
    '标题必须按 isStreaming 分流到两个不同的 i18n 键');
});

// ── 集成：MessageBubble 的渲染门控与位置 ────────────────────────────────────

test('集成：MessageBubble 的渲染门控是 role=assistant 且 reasoning 非空', () => {
  assert.match(listSrc, /message\.role === 'assistant' && message\.reasoning/, '门控必须是 assistant 且 reasoning 非空');
  assert.match(listSrc, /<ThinkingBlock\b/, '必须真的渲染 ThinkingBlock');
  assert.equal(count(listSrc, '<ThinkingBlock'), 1, 'ThinkingBlock 只允许有一个渲染入口');
});

test('集成：ThinkingBlock 的渲染位置在 TrajectoryTimeline 之前（思考 → 动作 → 答复）', () => {
  const blockAt = listSrc.indexOf('<ThinkingBlock');
  const trajAt = listSrc.indexOf('<TrajectoryTimeline');
  assert.ok(blockAt > -1, '必须渲染 ThinkingBlock');
  assert.ok(trajAt > -1, '必须渲染 TrajectoryTimeline');
  assert.ok(blockAt < trajAt, '思维链必须先于轨迹时间线渲染');
});

test('集成：showReasoning 经 MessageList → MessageBubble 下传到 enabled', () => {
  assert.match(listSrc, /enabled=\{message\.showReasoning !== false\}/,
    'MessageBubble 必须把 message.showReasoning !== false 传给 enabled');
  assert.match(listSrc, /MessageList\(\{[^}]*showReasoning = true/, 'MessageList 的 showReasoning 缺省必须是 true');
  assert.match(listSrc, /showReasoning,/, 'messageRows 必须显式把 showReasoning 塞进 message 对象（as Message 强转不会报错）');
});
