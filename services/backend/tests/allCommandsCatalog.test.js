'use strict';

/**
 * #58 全量命令枚举入口回归：`khy commands --all` → renderAllCommands，
 * 其余形态逐字节委托旧的精选速查框；门控 KHY_COMMANDS_ALL 关 → --all 回退历史
 * （被静默忽略，输出与裸 `khy commands` 完全一致）。
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ui = require('../src/cli/commandCatalogUi');
const { handleCommands, allCommandsEnabled } = require('../src/cli/handlers/commands');

function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

describe('buildAllCommands', () => {
  const data = ui.buildAllCommands();

  it('非空且成规模（防空表假绿）', () => {
    assert.ok(data.total >= 200, `total=${data.total}`);
    assert.ok(data.groups.length >= 5);
  });

  it('每个动词恰好出现一次，组非空', () => {
    const seen = new Set();
    let sum = 0;
    for (const g of data.groups) {
      assert.ok(g.items.length > 0, `空组 ${g.key}`);
      for (const it of g.items) {
        assert.ok(!seen.has(it.command), `重复 ${it.command}`);
        seen.add(it.command);
        sum += 1;
      }
    }
    assert.equal(sum, data.total);
  });

  it('高频动词必须在列（正对照）', () => {
    const flat = new Set(data.groups.flatMap((g) => g.items.map((i) => i.command)));
    for (const v of ['quote', 'gateway', 'doctor', 'help', 'version', 'backup']) {
      assert.ok(flat.has(v), `缺失 ${v}`);
    }
  });

  it('说明覆盖率过半（防空描述墙）', () => {
    const items = data.groups.flatMap((g) => g.items);
    const withDesc = items.filter((i) => i.description).length;
    assert.ok(withDesc / items.length > 0.5, `${withDesc}/${items.length}`);
  });

  it('丢弃与命令同名的回显标签（如 usage→Usage）', () => {
    const items = data.groups.flatMap((g) => g.items);
    for (const it of items) {
      if (it.description) {
        assert.notEqual(it.description.toLowerCase(), it.command);
      }
    }
  });
});

describe('handleCommands 派发', () => {
  // handleCommands 是 async 但函数体内无 await：同步执行完渲染后返回 Promise，
  // 故 capture() 包裹调用即可收集全部输出行。
  it('options.all → 渲染全部命令标题', async () => {
    const lines = capture(() => handleCommands({ options: { all: true } }));
    assert.ok(lines.some((l) => l.includes('全部命令')));
    assert.ok(lines.some((l) => /\d+ 个动词 · \d+ 类/.test(l)));
  });

  it('裸 commands → 与旧精选框标题一致', async () => {
    const lines = capture(() => handleCommands({}));
    assert.ok(lines.some((l) => l.includes('命令菜单')));
    assert.ok(!lines.some((l) => l.includes('全部命令')));
  });

  it('args 含 --all 亦生效（parseInput 变体兜底）', () => {
    const lines = capture(() => handleCommands({ args: ['--all'] }));
    assert.ok(lines.some((l) => l.includes('全部命令')));
  });

  it('门控 KHY_COMMANDS_ALL=0 → --all 回退精选框（逐字节=裸形态）', async () => {
    const prev = process.env.KHY_COMMANDS_ALL;
    process.env.KHY_COMMANDS_ALL = '0';
    try {
      const all = capture(() => handleCommands({ options: { all: true } }));
      const bare = capture(() => handleCommands({}));
      assert.deepEqual(all, bare);
      assert.ok(bare.some((l) => l.includes('命令菜单')));
    } finally {
      if (prev === undefined) delete process.env.KHY_COMMANDS_ALL;
      else process.env.KHY_COMMANDS_ALL = prev;
    }
  });

  it('allCommandsEnabled 仅 {0,false,off,no} 关', () => {
    assert.equal(allCommandsEnabled({}), true);
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      assert.equal(allCommandsEnabled({ KHY_COMMANDS_ALL: v }), false, v);
    }
    assert.equal(allCommandsEnabled({ KHY_COMMANDS_ALL: '1' }), true);
  });
});

describe('renderCommandCatalog 框体完整性', () => {
  // 回归：曾有一行提示文案 73 列 > innerW 68，pad() 只补不截 → 右边界凸出 5 列。
  it('所有非空行显示宽度一致（右边界不错位）', () => {
    const { displayWidth } = require('../src/cli/formatters');
    const lines = capture(() => ui.renderCommandCatalog())
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
      .filter((l) => l.trim() !== '');
    assert.ok(lines.length > 20, `行数 ${lines.length}（防空渲染假绿）`);
    const widths = new Set(lines.map(displayWidth));
    assert.equal(widths.size, 1, `行宽不齐: ${[...widths].join('/')}`);
    // 底部横杠行必须是 ╰…╯ 收尾，确认测的是整框
    assert.ok(lines[lines.length - 1].includes('╯'));
  });
});
