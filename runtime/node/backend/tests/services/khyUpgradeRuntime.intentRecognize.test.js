'use strict';

/**
 * khyUpgradeRuntime.intentRecognize.test.js — 「用户意图难以准确识别」根因回归。
 *
 * 病灶（2026-10-31 定位）：`## INTENT ASSURANCE` 读题框被注入**系统提示词**的高优先级位，
 * 而它的两个输入都来自脆弱的裸正则：
 *   1. `detectIntent` —— `图.*识别` 把「意图识别」判成 OCR；裸「查」「文件」把工程任务
 *      判成「信息搜索」「读取文件」；词表缺「修复/排查/重命名/实现」；且宽词排在
 *      「代码修改」之前，顺序上就抢走工程任务。
 *   2. `_extractConstraintIntentClauses` —— 裸 `别` / `需要` / `只` / `仅` / `不要` 会命中
 *      **别的词内部**，产出与用户原意**相反**的约束（「帮我识别这个错误」→「别一下这个错误
 *      的原因」）。模型被告知「别…」自然不会干活，用户看到的就是「它听不懂我」。
 *
 * 守护判据：
 *  - 词内字绝不产出约束（识别/特别/类别/不需要/不只/要不要）；
 *  - 真约束一条不许丢（不要修改测试文件 / 只改 src / 别动配置文件 / 务必先跑测试 / 保留接口）；
 *  - 工程动词必须落到「代码修改」，OCR 必须带图片语境才成立。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../../src/services/khyUpgradeRuntime');

const constraintsOf = (text) => runtime.buildIntentAssuranceDirective(text, {}).constraints;
const classOf = (text) => runtime.buildIntentAssuranceDirective(text, {}).requestClass;

describe('_extractConstraintIntentClauses — 词内字不产出约束', () => {
  test('「识别」的「别」不是约束（旧行为产出「别一下这个错误的原因」）', () => {
    const cons = constraintsOf('帮我识别一下这个错误的原因');
    assert.deepEqual(cons, [], `识别 的 别 被误当成约束：${JSON.stringify(cons)}`);
  });

  test('「意图识别模块」不再产出「别模块」「别不出来就报错」', () => {
    const cons = constraintsOf('我要实现意图识别模块，识别不出来就报错');
    for (const c of cons) {
      assert.ok(!c.startsWith('别'), `词内「别」仍产出约束：${c}`);
    }
  });

  test('「不需要」不得反转成「需要」', () => {
    const cons = constraintsOf('不需要改测试，只补文档');
    assert.ok(
      !cons.some((c) => c.startsWith('需要')),
      `「不需要」被反转成肯定约束：${JSON.stringify(cons)}`
    );
    assert.ok(cons.includes('只补文档'), '真约束「只补文档」不该丢');
  });

  test('疑问句「要不要」不是约束', () => {
    assert.deepEqual(constraintsOf('要不要我帮你改一下'), []);
  });

  test('「不只 / 不仅 / 不记得」不得被当成肯定约束', () => {
    for (const text of ['不只改这一个文件', '不仅跑测试还要看日志', '不记得有没有留接口']) {
      const cons = constraintsOf(text);
      assert.ok(
        !cons.some((c) => /^(只|仅|记得|需要)/.test(c)),
        `${text} → 反转约束 ${JSON.stringify(cons)}`
      );
    }
  });
});

describe('_extractConstraintIntentClauses — 真约束一条不丢', () => {
  test('句首「别动配置文件」保留', () => {
    assert.ok(constraintsOf('别动配置文件').includes('别动配置文件'));
  });

  test('「不要修改测试文件 / 只改 src 下的实现」双约束都保留', () => {
    const cons = constraintsOf('不要修改测试文件，只改 src 下的实现');
    assert.ok(cons.includes('不要修改测试文件'), JSON.stringify(cons));
    assert.ok(cons.includes('只改 src 下的实现'), JSON.stringify(cons));
  });

  test('「务必先跑测试 / 保留现有接口」都保留', () => {
    const cons = constraintsOf('务必先跑测试，保留现有接口');
    assert.ok(cons.includes('务必先跑测试'), JSON.stringify(cons));
    assert.ok(cons.includes('保留现有接口'), JSON.stringify(cons));
  });

  test('「必须先」长词优先，捕获文本与原行为一致', () => {
    assert.ok(constraintsOf('必须先跑测试').includes('必须先跑测试'));
  });
});

describe('detectIntent — 工程动词不再被判成闲聊 / OCR / 搜索 / 只读', () => {
  const ENGINEERING = [
    '修复一下登录 bug',
    '排查一下这个报错',
    '帮我把这个文件重命名',
    '实现一个意图识别模块',
    '重构一下这个模块',
    '把这个函数改一下',
  ];
  for (const text of ENGINEERING) {
    test(`「${text}」→ 代码修改`, () => {
      assert.equal(classOf(text), '代码修改');
    });
  }

  test('「意图识别」不是 OCR —— 无图片语境不判图片识别', () => {
    assert.notEqual(classOf('实现一个意图识别模块'), '图片识别');
    assert.notEqual(classOf('帮我识别一下这个错误的原因'), '图片识别');
  });

  test('真 OCR 仍判图片识别', () => {
    assert.equal(classOf('把这个截图里的文字识别出来'), '图片识别');
    assert.equal(classOf('对这张图片做 OCR'), '图片识别');
  });

  test('「排查 / 检查」不再被判成信息搜索', () => {
    assert.notEqual(classOf('排查一下这个报错'), '信息搜索');
  });

  test('显式检索仍判信息搜索', () => {
    assert.equal(classOf('搜一下最新的 khy-os 发布'), '信息搜索');
  });

  test('「把这个文件重命名」不再被判成只读', () => {
    assert.notEqual(classOf('帮我把这个文件重命名'), '读取文件');
  });

  test('问候 / 概念解释 / 命令执行 保持不变', () => {
    assert.equal(classOf('你好'), '问候');
    assert.equal(classOf('解释一下什么是闭包'), '概念解释');
    assert.equal(classOf('运行一下测试'), '命令执行');
  });
});

describe('端到端：长工程请求的读题框必须说对话', () => {
  const long =
    '我想让你帮我把这个模块里的意图识别逻辑改一下，现在它老是把工程任务判成闲聊，' +
    '而且第二轮对话就报错了，麻烦你排查一下根本原因然后修复它，改完给我看下 diff 和测试结果';

  test('Request class 不再是「信息搜索」', () => {
    assert.equal(classOf(long), '代码修改');
  });

  test('不注入任何以「别」开头的伪约束', () => {
    const cons = constraintsOf(long);
    assert.ok(
      !cons.some((c) => c.startsWith('别')),
      `长请求注入伪约束：${JSON.stringify(cons)}`
    );
  });

  test('注入的 directive 里不含「别逻辑改一下」这类反转约束', () => {
    const { directive } = runtime.buildIntentAssuranceDirective(long, {});
    assert.ok(directive.includes('Request class: 代码修改.'), directive.split('\n')[1]);
    // Primary objective 会逐字回显用户原话（「意图识别逻辑改一下」里天然含「别逻辑改一下」），
    // 所以只能断言约束段——约束段才是模型被要求「照做」的部分。
    const constraintSection = directive.split('Explicit constraints to obey:')[1] || '';
    assert.ok(
      !constraintSection.includes('别逻辑改一下'),
      `约束段仍注入了反转指令：${constraintSection.split('Must-keep')[0]}`
    );
  });
});
