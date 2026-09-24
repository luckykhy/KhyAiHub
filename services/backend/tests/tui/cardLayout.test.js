'use strict';

/**
 * cardLayout — 浮层卡片排版语法的叶子契约(纯函数,不需 ink)。
 *
 * 这套语法是「两张卡片为什么长得像一家人」的原因,而它的每条规则都对应一个曾经
 * **真的坏过**的地方,所以逐条钉住:
 *   1. 卡宽贴合内容 —— 撑满终端时内容只占左边几十列,框又重又空;
 *   2. 一行一格 —— 每行裁成一行,卡高才只与字段个数有关(权限浮层的 chrome 账本据此扣行);
 *   3. 右对齐尾注 —— 快捷号 / 指路文案贴右边界,且**留得下间隔**,不与被裁文本粘住;
 *   4. 页脚折行 —— 窄屏不许用 `…` 吃掉 `Esc 取消`(用户看不见退出键是已登记缺陷);
 *   5. 续行悬挂 —— 说明折行后落在值列之下,不回左边界。
 */

const cl = require('../../src/cli/tui/cardLayout');
const { visWidth } = require('../../src/cli/tui/wrapCell');

const FOOTER = '↑/↓ 导航 · Enter 选择 · 数字键直选 · 默认「确认执行」· Esc 取消';

describe('layoutCard — 卡宽贴合内容 + 一行一格', () => {
  test('内容短 → 卡窄(不撑满可用宽),但不低于最小可读宽', () => {
    const { width, lines } = cl.layoutCard([{ head: '短' }, { head: '也短' }], 96);
    expect(width).toBe(cl.MIN_CONTENT_COLS);
    expect(lines).toEqual(['短', '也短']);
  });

  test('内容长 → 卡宽被可用宽(减去边框/padding)封顶,且每行都不超宽', () => {
    const long = 'x'.repeat(300);
    const { width, lines } = cl.layoutCard([{ head: long }], 40);
    expect(width).toBe(40 - cl.BOX_CHROME_COLS);
    for (const l of lines) expect(visWidth(l)).toBeLessThanOrEqual(width);
    expect(lines[0].endsWith('…')).toBe(true);
  });

  test('尾注右对齐:卡宽 = 头行 + 间隔 + 尾注,尾注贴右边界', () => {
    const { width, lines } = cl.layoutCard([{ head: '❯ 确认执行', tail: '1' }], 40);
    expect(width).toBe(13); // 10 + TAIL_GAP(2) + 1
    expect(lines[0].startsWith('❯ 确认执行')).toBe(true);
    expect(lines[0].endsWith('1')).toBe(true);
    expect(lines[0]).toMatch(/ {2,}1$/);
    expect(visWidth(lines[0])).toBe(width);
  });

  test('多种行混合:卡宽 = 最宽行,尾注按该宽对齐', () => {
    const rows = [{ head: '❯ 允许本次', tail: '1' }, { head: '⚠ 删除或覆盖数据 · 无法找回' }];
    const { width, lines } = cl.layoutCard(rows, 96);
    expect(width).toBe(visWidth('⚠ 删除或覆盖数据 · 无法找回'));
    expect(visWidth(lines[0])).toBe(width);
    expect(lines[0].endsWith('1')).toBe(true);
  });

  test('指针标记只在真的裁了时才出现,且「…」与指路都在', () => {
    const short = cl.layoutCard([{ head: '资源  a.txt', pointer: true }], 96).lines[0];
    expect(short).not.toContain(cl.POINTER);
    const long = cl.layoutCard([{ head: '资源  ' + 'y'.repeat(200), pointer: true }], 40).lines[0];
    expect(long).toContain('…' + cl.POINTER_MARK);
    expect(visWidth(long)).toBeLessThanOrEqual(40 - cl.BOX_CHROME_COLS);
  });

  test('空行要真的占一行(head 为空格;空串在 ink 里不画行)', () => {
    const { lines } = cl.layoutCard([{ head: 'a' }, { head: ' ' }, { head: 'b' }], 20);
    expect(lines).toEqual(['a', ' ', 'b']);
  });
});

describe('splitFooter — 窄屏折行,绝不裁掉退出键', () => {
  test('放得下 → 原样一行', () => {
    expect(cl.splitFooter('↑/↓ · Esc 取消', 40)).toEqual(['↑/↓ · Esc 取消']);
  });

  test('放不下 → 折成两行,每行不超宽,且一段不丢', () => {
    const lines = cl.splitFooter(FOOTER, 56);
    expect(lines.length).toBe(2);
    for (const l of lines) expect(visWidth(l)).toBeLessThanOrEqual(56);
    const joined = lines.join(' · ');
    for (const seg of FOOTER.split(' · ')) expect(joined).toContain(seg);
    expect(joined).toContain('Esc 取消');
  });

  test('折点取「两行宽度差最小」,不把尾巴单独甩到第二行', () => {
    const lines = cl.splitFooter(FOOTER, 56);
    const spread = Math.abs(visWidth(lines[0]) - visWidth(lines[1]));
    // 贪心折法会得到 [..4 段][Esc 取消] 这种 45 列落差;这里必须明显更均衡
    expect(spread).toBeLessThan(20);
  });

  test('单段就超宽(无法折)→ 退化为裁剪,不返回空', () => {
    const lines = cl.splitFooter('x'.repeat(100), 20);
    expect(lines.length).toBe(1);
    expect(visWidth(lines[0])).toBeLessThanOrEqual(20);
  });
});

describe('hangingRows — 续行悬挂在值列之下', () => {
  test('长说明折行后,续行缩进 = 标签列宽', () => {
    const rows = cl.hangingRows('   ❯ 1. ', '统一到 entries/  — ' + '所有可再生构建产物落 entries/'.repeat(3), 60);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0].startsWith('   ❯ 1. ')).toBe(true);
    for (const r of rows.slice(1)) {
      expect(r.startsWith(' '.repeat(visWidth('   ❯ 1. ')))).toBe(true);
      expect(r.trim().length).toBeGreaterThan(0);
    }
    for (const r of rows) expect(visWidth(r)).toBeLessThanOrEqual(60);
  });

  test('放得下 → 单行,内容不变', () => {
    expect(cl.hangingRows('x  ', '短说明', 60)).toEqual(['x  短说明']);
  });

  test('宽度不足(叶子拒绝)→ 退回单行,不抛', () => {
    const rows = cl.hangingRows('标签', 'x'.repeat(50), 4);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(1);
  });
});
