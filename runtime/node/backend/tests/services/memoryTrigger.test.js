'use strict';

/**
 * Unit tests for memoryTrigger.js — the capture-side classifier (when to
 * remember, at which tier) for the layered-memory goal:
 *   (a) proactive remember trigger (conservative, zero-false-positive),
 *   (b) tier inference incl. stable topic key for proactive update,
 *   (c) reliable explicit「请记住」capture.
 *
 * Pure functions, no IO; we only toggle the env gates.
 */

const MT = require('../../src/services/memoryTrigger');
const TIERS = require('../../src/services/memoryTier').TIERS;
const contentDedup = require('../../src/services/memoryContentDedup');

const SAVED = {};
beforeEach(() => {
  SAVED.trigger = process.env.KHY_MEMORY_TRIGGER;
  SAVED.proactive = process.env.KHY_PROACTIVE_CAPTURE;
  SAVED.reflection = process.env.KHY_MEMORY_REFLECTION;
  SAVED.reflectionMinScore = process.env.KHY_MEMORY_REFLECTION_MIN_SCORE;
  delete process.env.KHY_MEMORY_TRIGGER;
  delete process.env.KHY_PROACTIVE_CAPTURE;
  delete process.env.KHY_MEMORY_REFLECTION;
  delete process.env.KHY_MEMORY_REFLECTION_MIN_SCORE;
});
afterEach(() => {
  if (SAVED.trigger === undefined) delete process.env.KHY_MEMORY_TRIGGER; else process.env.KHY_MEMORY_TRIGGER = SAVED.trigger;
  if (SAVED.proactive === undefined) delete process.env.KHY_PROACTIVE_CAPTURE; else process.env.KHY_PROACTIVE_CAPTURE = SAVED.proactive;
  if (SAVED.reflection === undefined) delete process.env.KHY_MEMORY_REFLECTION; else process.env.KHY_MEMORY_REFLECTION = SAVED.reflection;
  if (SAVED.reflectionMinScore === undefined) delete process.env.KHY_MEMORY_REFLECTION_MIN_SCORE; else process.env.KHY_MEMORY_REFLECTION_MIN_SCORE = SAVED.reflectionMinScore;
});

describe('memoryTrigger.classify — explicit「请记住」(must capture)', () => {
  test('plain remember ⇒ explicit, body stripped of trigger prefix', () => {
    const d = MT.classify('记住：部署用 docker compose');
    expect(d.kind).toBe('explicit');
    expect(d.note).toBe('部署用 docker compose');
    expect(d.tier).toBe(TIERS.CROSS_SESSION);
  });

  test('remember this (English) ⇒ explicit', () => {
    const d = MT.classify('remember this: the api base is api.example.com');
    expect(d.kind).toBe('explicit');
    expect(d.note).toContain('api.example.com');
  });

  test('identity inside an explicit remember ⇒ permanent + user + stable topic key', () => {
    const d = MT.classify('记住我叫张三');
    expect(d.kind).toBe('explicit');
    expect(d.tier).toBe(TIERS.PERMANENT);
    expect(d.type).toBe('user');
    expect(d.name).toBe('user-name'); // stable ⇒ re-declaration supersedes
  });

  test('「永久记住」⇒ permanent tier', () => {
    const d = MT.classify('永久记住这个密钥前缀是 sk-proj');
    expect(d.kind).toBe('explicit');
    expect(d.tier).toBe(TIERS.PERMANENT);
  });

  test('「这次临时记一下」⇒ short_term tier', () => {
    const d = MT.classify('这次临时记一下端口是 8080');
    expect(d.kind).toBe('explicit');
    expect(d.tier).toBe(TIERS.SHORT_TERM);
  });

  test('feedback-flavored explicit ⇒ feedback type', () => {
    const d = MT.classify('记住以后回复都用中文');
    expect(d.kind).toBe('explicit');
    expect(d.type).toBe('feedback');
  });
});

describe('memoryTrigger.classify — proactive (conservative, zero false positive)', () => {
  test('「我叫X」(no explicit ask) ⇒ proactive permanent identity with stable key', () => {
    const d = MT.classify('对了，我叫李四');
    expect(d.kind).toBe('proactive');
    expect(d.tier).toBe(TIERS.PERMANENT);
    expect(d.type).toBe('user');
    expect(d.name).toBe('user-name');
  });

  test('stable preference declaration ⇒ proactive cross_session feedback', () => {
    const d = MT.classify('我习惯用 tab 缩进');
    expect(d.kind).toBe('proactive');
    expect(d.tier).toBe(TIERS.CROSS_SESSION);
    expect(d.type).toBe('feedback');
    expect(d.name).toBeNull(); // distinct preferences coexist
  });

  test('ordinary task statements do NOT trigger (no false positive)', () => {
    for (const msg of [
      '帮我把这个函数重构一下',
      '现在用的是 8080 端口',
      '这个 bug 怎么修',
      '运行一下测试',
      'what files handle routing?',
    ]) {
      expect(MT.classify(msg).kind).toBe('none');
    }
  });
});

describe('memoryTrigger gates', () => {
  test('KHY_MEMORY_TRIGGER=off ⇒ everything is none', () => {
    process.env.KHY_MEMORY_TRIGGER = 'off';
    expect(MT.classify('记住我叫张三').kind).toBe('none');
    expect(MT.classify('我习惯用 tab').kind).toBe('none');
  });

  test('KHY_PROACTIVE_CAPTURE=off ⇒ explicit still works, proactive suppressed', () => {
    process.env.KHY_PROACTIVE_CAPTURE = 'off';
    expect(MT.classify('记住：用 docker').kind).toBe('explicit');
    expect(MT.classify('我叫王五').kind).toBe('none'); // proactive off
  });

  test('empty / oversized input ⇒ none', () => {
    expect(MT.classify('').kind).toBe('none');
    expect(MT.classify('记住 ' + 'x'.repeat(2100)).kind).toBe('none');
  });
});

// P1-2: 复盘/教训记忆化(M-1 + M-9 合并)。复盘是 harness 的结构化产出,不是用户消息,
// 故走 classify 的平行入口 classifyReflection;分类决策仍收在 memoryTrigger 单一真源。
const REVIEW = {
  task: '修复 parser 的金额解析 bug',
  verdict: 'issues',
  reviewModel: 'deepseek-chat',
  issues: [
    '金额解析未处理千分位逗号,1,234.56 被截断为 1',
    '缺少对负值的校验,退款场景会算出正数',
  ],
  suggestedFixes: [
    '解析前统一 strip 千分位再 parseFloat',
    '对 amount < 0 的输入直接拒绝并报错',
  ],
};

describe('memoryTrigger.classifyReflection — 复盘落 cross_session(P1-2)', () => {
  test('一条完整复盘 ⇒ reflection / cross_session / feedback,note 含问题与修复方向', () => {
    process.env.KHY_MEMORY_REFLECTION = '1';
    const d = MT.classifyReflection(REVIEW);
    expect(d.kind).toBe('reflection');
    expect(d.tier).toBe(TIERS.CROSS_SESSION);
    expect(d.type).toBe('feedback');
    expect(d.score).toBeGreaterThanOrEqual(0.9);
    expect(d.name).toBe('跨模型复盘: 修复 parser 的金额解析 bug');
    expect(d.note).toContain('适用情境: 修复 parser 的金额解析 bug');
    expect(d.note).toContain('金额解析未处理千分位逗号');
    expect(d.note).toContain('建议修复方向:');
    expect(d.note).toContain('教训: 解析前统一 strip 千分位再 parseFloat');
  });

  test('同一复盘两次分类 ⇒ note 逐字节确定(内容查重据此生效)', () => {
    process.env.KHY_MEMORY_REFLECTION = '1';
    const a = MT.classifyReflection(REVIEW);
    const b = MT.classifyReflection(REVIEW);
    expect(a.note).toBe(b.note);
    expect(contentDedup.bodiesEquivalent(a.note, b.note)).toBe(true);
    // 异名同内容:既有一条同名既有记忆时,memoryContentDedup 判重复(不二次注入)
    const dup = contentDedup.findContentDuplicate(
      { name: '别的标题', body: b.note, filename: 'candidate.md' },
      [{ filename: 'feedback_existing.md', name: 'x', body: a.note }]
    );
    expect(dup).toEqual({ filename: 'feedback_existing.md', name: 'x' });
  });

  test('不同任务的同类问题各自成条(name 取情境,不按问题合并)', () => {
    process.env.KHY_MEMORY_REFLECTION = '1';
    const other = MT.classifyReflection({ ...REVIEW, task: '重构导入导出的 CSV 读取' });
    const base = MT.classifyReflection(REVIEW);
    expect(other.name).not.toBe(base.name);
    expect(contentDedup.bodiesEquivalent(other.note, base.note)).toBe(false);
  });

  test('低质复盘被门槛拦在库外', () => {
    process.env.KHY_MEMORY_REFLECTION = '1';
    // verdict=pass:没发现问题,无可学
    expect(MT.classifyReflection({ ...REVIEW, verdict: 'pass' }).kind).toBe('none');
    // 无修复方向:光有问题没有下一步,教训不可执行
    expect(MT.classifyReflection({ ...REVIEW, suggestedFixes: [] }).kind).toBe('none');
    // 空泛:issue 三字符,具体度折分后不过线
    expect(MT.classifyReflection({
      task: 't', verdict: 'issues', issues: ['bug'], suggestedFixes: ['fix'],
    }).kind).toBe('none');
    // 空 issues / 非数组入参 fail-soft
    expect(MT.classifyReflection({ verdict: 'issues', issues: [] }).kind).toBe('none');
    expect(MT.classifyReflection(null).kind).toBe('none');
  });

  test('KHY_MEMORY_REFLECTION 默认关;显式开才捕获', () => {
    expect(MT.isReflectionEnabled()).toBe(false);
    expect(MT.classifyReflection(REVIEW).kind).toBe('none');
    process.env.KHY_MEMORY_REFLECTION = 'on';
    expect(MT.classifyReflection(REVIEW).kind).toBe('reflection');
  });

  test('KHY_MEMORY_REFLECTION_MIN_SCORE 可调门槛(默认 0.9)', () => {
    expect(MT.reflectionMinScore({})).toBe(0.9);
    expect(MT.reflectionMinScore({ KHY_MEMORY_REFLECTION_MIN_SCORE: '0.5' })).toBe(0.5);
    expect(MT.reflectionMinScore({ KHY_MEMORY_REFLECTION_MIN_SCORE: 'not-a-number' })).toBe(0.9);
    process.env.KHY_MEMORY_REFLECTION = '1';
    process.env.KHY_MEMORY_REFLECTION_MIN_SCORE = '0.5';
    // 无修复方向的复盘完整度只有 0.5,降到 0.5 即可过线——门槛是显式旋钮
    expect(MT.classifyReflection({ ...REVIEW, suggestedFixes: [] }).kind).toBe('reflection');
  });

  test('用户消息路径不受影响:提及复盘 Findings 的普通消息仍不捕获', () => {
    process.env.KHY_MEMORY_REFLECTION = '1';
    expect(MT.classify('跨模型审查刚才发现了两个问题').kind).toBe('none');
  });
});
