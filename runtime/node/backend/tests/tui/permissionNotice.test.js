'use strict';

/**
 * permissionNotice — 授权请求「卡里说什么 / 输出区说什么」的叶子契约(纯函数,不需 ink)。
 *
 * 三块表面分工是这次重排的核心,所以要逐条钉住:
 *   1. **卡**(`cardRows`)只放决定所需的最小充分集,且**列对齐**(标签列定宽),行数只与
 *      字段个数有关 —— 与资源长短无关(上一版把长证据塞进卡里,卡就跟着证据一起长);
 *   2. **输出区**(`buildRecord`)是无损的:资源全文、为什么、后果、撤销、工作区都在;
 *      与卡重复的那几句**不写两遍**(记录是卡的补集,不是复写);
 *   3. **判词**(`decisionVerdict`)两处渲染共用一份,不会各说各话。
 */

const pn = require('../../src/cli/tui/permissionNotice');
const { visWidth } = require('../../src/cli/tui/wrapCell');
const { buildTranscriptLines } = require('../../src/cli/tui/transcriptLines');

const LONG_RES =
  'del /F /Q C:\\Users\\25789\\Desktop\\khy_image.png && dir /b C:\\Users\\25789\\Desktop\\khy_image.png 2>NUL & echo done';
const UNDO = '删除通常不可逆；若文件曾被 git 跟踪，可尝试 `git restore <文件>`';

const L2_INPUT = {
  level: 'L2',
  action: 'delete',
  scope: 'project',
  resource: LONG_RES,
  requireTyped: 'YES',
  explanation: {
    whatHappens: '删除或覆盖数据',
    headline: '⚠ 高风险操作：删除或覆盖数据',
    risks: ['被删除或覆盖的数据可能无法找回'],
    howToUndo: UNDO,
    text: [
      '⚠ 高风险操作：删除或覆盖数据',
      '',
      '为什么需要你确认：',
      '  · 动作 delete 属毁灭性/系统级，红灯',
      '',
      '可能的后果：',
      '  · 被删除或覆盖的数据可能无法找回',
      '',
      `撤销方式：${UNDO}`,
      '',
      '当前工作区：',
      '工作区：D:/Portable',
      '分支：master',
    ].join('\n'),
  },
};

describe('permissionNotice 门控', () => {
  test("默认开;仅 0/false/off/no 关(空值 = 未设置 = 开)", () => {
    expect(pn.noticeEnabled({})).toBe(true);
    expect(pn.noticeEnabled({ KHY_PERMISSION_NOTICE: '' })).toBe(true);
    expect(pn.noticeEnabled({ KHY_PERMISSION_NOTICE: 'on' })).toBe(true);
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' False ']) {
      expect(pn.noticeEnabled({ KHY_PERMISSION_NOTICE: v })).toBe(false);
    }
  });
});

describe('等级文案:短徽标给卡、长标签留给旧形态', () => {
  test('levelBadge 只给「灯 + 级别」;危险语义留在记录里', () => {
    expect(pn.levelBadge('L2')).toBe('红灯 L2');
    expect(pn.levelBadge('L1')).toBe('黄灯 L1');
    expect(pn.levelBadge('')).toBe('');
  });

  test('riskTag 仍是旧形态的长文案(门控关时逐字节回退)', () => {
    expect(pn.riskTag('L2')).toBe('红灯 L2 · 毁灭性/系统级');
    expect(pn.riskTag('L1')).toBe('黄灯 L1 · 有限写入/网络');
  });

  test('标题与尾注:等级徽标 + 工具名,缺一不编', () => {
    expect(pn.cardTitle(L2_INPUT)).toBe('⛔ 高危操作需要授权');
    expect(pn.cardTitle({ level: 'L1' })).toBe('⚠ 需要授权');
    expect(pn.cardTitleTail(L2_INPUT, 'shellCommand')).toBe('红灯 L2 · shellCommand');
    expect(pn.cardTitleTail({}, 'Write')).toBe('Write');
  });
});

describe('riskText — 从结构化字段取,不解析文本', () => {
  test('L2:发生了什么 + 第一条后果', () => {
    expect(pn.riskText(L2_INPUT)).toBe('⚠ 删除或覆盖数据 · 被删除或覆盖的数据可能无法找回');
  });

  test('L1:退回 headline 并剥掉层级前缀(不重复「即将:」这种话)', () => {
    const t = pn.riskText({ level: 'L1', explanation: { headline: '即将：写入一个文件（影响有限，确认一次即可）' } });
    expect(t).toBe('⚠ 写入一个文件（影响有限，确认一次即可）');
  });

  test('没有 explanation → 空串(少一行,不编话)', () => {
    expect(pn.riskText({ level: 'L2' })).toBe('');
  });
});

describe('cardRows — 决定所需的最小充分集,列对齐', () => {
  test('L2:动作 / 资源 / 撤销 / 记住 / 风险,顺序稳定,标签列一致', () => {
    const rows = pn.cardRows(L2_INPUT, 'shellCommand');
    expect(rows.map((r) => r.key)).toEqual(['as', 'res', 'undo', 'remember', 'risk']);
    expect(rows.every((r) => r.label === '' || visWidth(r.label) === 4)).toBe(true);
    expect(rows[0].value).toBe('delete · 范围 project');
    expect(rows[1].label).toBe('资源');
    expect(rows[1].value).toBe(LONG_RES);
    expect(rows[1].pointer).toBe(true);
    expect(rows[2].value).toBe(UNDO);
    expect(rows[4].kind).toBe('risk');
  });

  // 「记住」行 = 用户点「总是允许」到底记住了什么（上游两家的 always/scope 行同款结构）。
  // 措辞刻意短：它若长过页脚，卡就从 77 列被撑到满宽。
  test('「记住」行如实说明记住范围(按工具名,不区分参数),且不超过页脚宽', () => {
    const row = pn.cardRows(L2_INPUT, 'shellCommand').find((r) => r.key === 'remember');
    expect(row.label).toBe('记住');
    expect(row.value).toBe('只按工具名 shellCommand，不区分本次参数');
    expect(visWidth(`${row.label}${pn.LABEL_PAD}${row.value}`)).toBeLessThan(62);
  });

  test('「总是允许」被门控关掉时不写这一行(不许描述一个不存在的按钮)', () => {
    expect(pn.rememberText(L2_INPUT, 'shellCommand')).not.toBe('');
    expect(pn.rememberText(L2_INPUT, 'shellCommand', { sessionAllow: false })).toBe('');
    const rows = pn.cardRows(L2_INPUT, 'shellCommand', { sessionAllow: false });
    expect(rows.some((r) => r.key === 'remember')).toBe(false);
    // classic(无等级)没有「记住」语义
    expect(pn.rememberText({ command: 'ls' }, 'Read')).toBe('');
  });

  test('L1:没有 howToUndo 就没有撤销行(不编造可撤销性)', () => {
    const rows = pn.cardRows(
      { level: 'L1', action: 'write', scope: 'project', resource: 'note.md' },
      'Write'
    );
    expect(rows.map((r) => r.key)).toEqual(['as', 'res', 'remember']);
  });

  test('无资源时退到命令,标签仍是「命令」', () => {
    const rows = pn.cardRows({ level: 'L1', action: 'write', scope: 'project', command: 'echo hi' }, 'Write');
    expect(rows.find((r) => r.key === 'res').label).toBe('命令');
    expect(rows.find((r) => r.key === 'res').value).toBe('echo hi');
  });

  test('占位动作/范围 → 明确说「未声明」,不把 unknown 甩给用户', () => {
    const rows = pn.cardRows({ level: 'L2', action: 'unknown', scope: 'n/a' }, 'Bash');
    expect(rows[0].value).toContain('未声明');
    expect(rows[0].value).not.toContain('unknown');
  });

  test('classic(无等级):只剩描述与命令,不伪造分级', () => {
    const rows = pn.cardRows({ description: '写一个文件', command: 'cat > a.txt' }, 'Write');
    expect(rows.map((r) => r.key)).toEqual(['desc', 'cmd']);
    expect(rows.map((r) => r.label)).toEqual(['说明', '命令']);
  });

  test('行数只与字段个数有关:资源再长也不多一行', () => {
    const short = pn.cardRows({ ...L2_INPUT, resource: 'rm a' }, 'shellCommand');
    const long = pn.cardRows({ ...L2_INPUT, resource: LONG_RES.repeat(4) }, 'shellCommand');
    expect(long.length).toBe(short.length);
  });
});

describe('buildRecord — 输出区记录是无损的,且不重抄卡', () => {
  test('资源全文照登(不裁、带省略号反而算错)', () => {
    const rec = pn.buildRecord(L2_INPUT, 'shellCommand', 80);
    expect(rec.replace(/\s+/g, '')).toContain(LONG_RES.replace(/\s+/g, ''));
    expect(rec).not.toContain('…');
  });

  test('首行 = 需要授权 + 工具 + 等级徽标', () => {
    expect(pn.buildRecord(L2_INPUT, 'shellCommand', 80).split('\n')[0]).toBe(
      '⛔ 需要授权 · shellCommand · 红灯 L2'
    );
  });

  test('为什么 / 后果 / 撤销 / 工作区都在正文里', () => {
    const rec = pn.buildRecord(L2_INPUT, 'shellCommand', 80);
    for (const want of ['为什么需要你确认', '动作 delete 属毁灭性/系统级', '可能的后果', '撤销方式', '当前工作区']) {
      expect(rec).toContain(want);
    }
  });

  test('与卡重复的句子不写两遍:风险句与撤销各只出现一次', () => {
    const rec = pn.buildRecord(L2_INPUT, 'shellCommand', 80);
    const lines = rec.split('\n');
    // 卡里那句 `⚠ 删除或覆盖数据 · …` 与正文的 `⚠ 高风险操作：删除或覆盖数据` 是同一件事
    expect(lines.filter((l) => l.includes('删除或覆盖数据')).length).toBe(1);
    // 撤销的正文只来自 `撤销方式：…`,不额外多一行卡的 `撤销` 字段
    expect(lines.filter((l) => l.includes(UNDO.slice(0, 12))).length).toBe(1);
  });

  test('长资源续行悬挂在「资源」之下,不是回到左边界', () => {
    const lines = pn.buildRecord(L2_INPUT, 'shellCommand', 80).split('\n');
    const i = lines.findIndex((l) => l.includes('资源'));
    expect(i).toBeGreaterThan(-1);
    const indent = ' '.repeat(pn.RECORD_INDENT.length + visWidth('资源') + pn.LABEL_PAD.length);
    expect(lines[i + 1].startsWith(indent)).toBe(true);
  });

  test('空 input 不抛,至少给出一行标题', () => {
    expect(pn.buildRecord({}, '', 80)).toBe('⚠ 需要授权 · 工具');
    expect(pn.buildRecord(null, null, 0)).toContain('需要授权');
  });

  // 卡内 diff 预览是**封顶预览**，全文由记录承载（同 openCode 的 maxHeight + 展开思路）：
  // 批准的就是这一版改动，记录里必须看得全。
  test('写入前 diff 的全文进记录(卡内只放封顶预览)', () => {
    const req = {
      level: 'L1',
      action: 'write',
      scope: 'project',
      resource: 'a.md',
      diffPreview: {
        filePath: 'a.md',
        beforeContent: 'a\nb\nc\n',
        afterContent: 'a\nB\nc\n',
      },
    };
    const rec = pn.buildRecord(req, 'Write', 100);
    expect(rec).toContain('± a.md');
    expect(rec).toContain('- b');
    expect(rec).toContain('+ B');
    expect(pn.diffRecordLines(req.diffPreview).length).toBeGreaterThan(3);
    // 没有预览 → 不多一行
    expect(pn.diffRecordLines(undefined)).toEqual([]);
    expect(pn.buildRecord({ level: 'L1' }, 'Write', 80)).not.toContain('±');
  });
});

describe('输出区:记录推得进去、决定画得出来(应用内 Viewport 投影)', () => {
  test('notice 记录的多行内容会全部落到转录行里,不折损', () => {
    const rec = pn.buildRecord(L2_INPUT, 'shellCommand', 80);
    const lines = buildTranscriptLines([{ role: 'notice', content: rec }], { cols: 80 });
    const flat = lines.join('\n').replace(/\s+/g, '');
    expect(flat).toContain(LONG_RES.replace(/\s+/g, ''));
    expect(lines.some((l) => l.includes('需要授权 · shellCommand'))).toBe(true);
    for (const l of lines) {
      expect(visWidth(l)).toBeLessThanOrEqual(80);
    }
  });

  test('decision 记录在 Viewport 里可见,且与 committed 侧同一判词', () => {
    const lines = buildTranscriptLines(
      [{ role: 'decision', decision: 'deny', tool: 'shellCommand', argSummary: LONG_RES }],
      { cols: 80 }
    );
    const flat = lines.join('\n');
    expect(flat).toContain('✗ 已拒绝');
    expect(flat).toContain('shellCommand');
    expect(flat).toContain('del /F /Q');
  });
});

describe('decisionVerdict — 判词两处渲染共用一份', () => {
  test('四种决定各有判词,与 committed 侧既有文案一致', () => {
    expect(pn.decisionVerdict('allow').label).toBe('已批准');
    expect(pn.decisionVerdict('deny').label).toBe('已拒绝');
    expect(pn.decisionVerdict('always').label).toBe('已批准（始终允许）');
    expect(pn.decisionVerdict('discuss').label).toBe('先一起讨论');
    // 未知/缺失值如实回显,绝不假装「已批准」(规则 2.2:不许含糊也不许粉饰)
    expect(pn.decisionVerdict(undefined).label).not.toBe('已批准');
    expect(pn.decisionVerdict('weird').label).toContain('weird');
  });
});
