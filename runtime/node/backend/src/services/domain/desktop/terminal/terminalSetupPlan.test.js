'use strict';

// Colocated tests for terminalSetupPlan.js (pure leaf: zero IO, never throws).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const svc = require('./terminalSetupPlan');

// KNOWN-DEFECT: 注释契约「纯函数，绝不抛」，但 planTerminalSetup(null) 于
// terminalSetupPlan.js:149 读 input.name 抛 TypeError——默认参数不挡 null
// （低危：调用方传对象字面量，未见实际崩溃路径）。
test('KNOWN-DEFECT: planTerminalSetup(null) 抛 TypeError 而非 unknown 方案', () => {
  assert.throws(() => svc.planTerminalSetup(null), TypeError);
});

test('planTerminalSetup 垃圾入参 → unknown 终端，绝不抛', () => {
  for (const input of [undefined, {}, { name: null }, { name: 0 }, { name: NaN }, { name: {} }, { name: [] }]) {
    const p = svc.planTerminalSetup(input);
    assert.equal(p.category, 'unknown');
    assert.equal(p.needsSetup, false);
    assert.equal(typeof p.reason, 'string');
    assert.ok(p.reason.length > 0);
    assert.equal(p.remoteSSH, false);
  }
});

test('原生 CSI u 终端：归一小写命中表，无需配置但说明 khy 未申请协议', () => {
  for (const [name, display] of Object.entries(svc.NATIVE_CSIU_TERMINALS)) {
    const p = svc.planTerminalSetup({ name: name.toUpperCase(), platform: 'darwin', homedir: '/h' });
    assert.equal(p.category, 'native', name);
    assert.equal(p.displayName, display);
    assert.equal(p.needsSetup, false);
    assert.equal(p.method, null);
    assert.ok(p.reason.includes('khy'));
  }
});

test('VSCode/Cursor：keybindings.json 路径按平台推导 + 片段含 ESC+CR', () => {
  const esc = '\\u001b\\r';
  const win = svc.planTerminalSetup({ name: 'vscode', platform: 'win32', homedir: 'C:\\u' });
  assert.equal(win.category, 'needs-setup');
  assert.equal(win.method, 'vscode-keybindings');
  assert.equal(
    win.configPath,
    path.join('C:\\u', 'AppData', 'Roaming', 'Code', 'User', 'keybindings.json')
  );
  assert.ok(win.snippet.includes(esc));

  const mac = svc.planTerminalSetup({ name: 'vscode', platform: 'darwin', homedir: '/u' });
  assert.equal(
    mac.configPath,
    path.join('/u', 'Library', 'Application Support', 'Code', 'User', 'keybindings.json')
  );

  const lin = svc.planTerminalSetup({ name: 'cursor', platform: 'linux', homedir: '/u' });
  assert.equal(
    lin.configPath,
    path.join('/u', '.config', 'Cursor', 'User', 'keybindings.json')
  );

  // homedir 缺 → 只给片段不给路径
  const noHome = svc.planTerminalSetup({ name: 'vscode', platform: 'linux' });
  assert.equal(noHome.configPath, null);
  assert.ok(noHome.snippet.includes('sendSequence'));
});

test('VSCode Remote SSH：PATH/ASKPASS 命中 → 步骤改为本地装机指引', () => {
  const p = svc.planTerminalSetup({
    name: 'vscode',
    platform: 'linux',
    homedir: '/u',
    env: { PATH: '/home/u/.vscode-server/bin:/usr/bin' },
  });
  assert.equal(p.remoteSSH, true);
  assert.ok(p.steps[0].includes('Remote SSH'));
  assert.ok(p.steps[0].includes('本地'));
  // 判定函数独立可用
  assert.equal(svc.isVSCodeRemoteSSH({ VSCODE_GIT_ASKPASS_MAIN: '/x/.cursor-server/y' }), true);
  assert.equal(svc.isVSCodeRemoteSSH({}), false);
  assert.equal(svc.isVSCodeRemoteSSH(null), false);
});

test('Apple Terminal：偏好设置路径，configPath/snippet 为 null', () => {
  const p = svc.planTerminalSetup({ name: 'apple_terminal', platform: 'darwin', homedir: '/u' });
  assert.equal(p.displayName, 'Apple Terminal');
  assert.equal(p.method, 'apple-terminal');
  assert.equal(p.configPath, null);
  assert.equal(p.snippet, null);
  assert.ok(p.steps.join('\n').includes('Use Option as Meta key'));
});

test('Alacritty：XDG_CONFIG_HOME 优先，win32 回退 APPDATA，最后 ~/.config', () => {
  const xdg = svc.planTerminalSetup({
    name: 'alacritty',
    platform: 'linux',
    homedir: '/u',
    env: { XDG_CONFIG_HOME: ' /custom/xdg ' },
  });
  assert.equal(xdg.configPath, path.join('/custom/xdg', 'alacritty', 'alacritty.toml'));

  const appdata = svc.planTerminalSetup({
    name: 'alacritty',
    platform: 'win32',
    homedir: 'C:\\u',
    env: { APPDATA: 'C:\\u\\AppData\\Roaming' },
  });
  assert.equal(
    appdata.configPath,
    path.join('C:\\u\\AppData\\Roaming', 'alacritty', 'alacritty.toml')
  );

  const fallback = svc.planTerminalSetup({ name: 'alacritty', platform: 'linux', homedir: '/u', env: {} });
  assert.equal(fallback.configPath, path.join('/u', '.config', 'alacritty', 'alacritty.toml'));

  // 纯空白 env 值视为缺失
  const blank = svc.planTerminalSetup({
    name: 'alacritty',
    platform: 'win32',
    homedir: 'C:\\u',
    env: { XDG_CONFIG_HOME: '   ', APPDATA: ' ' },
  });
  assert.equal(blank.configPath, path.join('C:\\u', '.config', 'alacritty', 'alacritty.toml'));
});

test('Zed：keymap.json 路径 + SendText 片段', () => {
  const p = svc.planTerminalSetup({ name: 'zed', platform: 'linux', homedir: '/u' });
  assert.equal(p.configPath, path.join('/u', '.config', 'zed', 'keymap.json'));
  assert.ok(p.snippet.includes('terminal::SendText'));
});

test('Windows Terminal：两种名字命中，LOCALAPPDATA 缺失 → configPath null', () => {
  for (const name of ['windows-terminal', 'windows terminal', 'WINDOWS-TERMINAL']) {
    const p = svc.planTerminalSetup({ name, platform: 'win32', homedir: 'C:\\u' });
    assert.equal(p.category, 'needs-setup', name);
    assert.equal(p.method, 'windows-terminal-keybindings');
  }
  const withPath = svc.planTerminalSetup({
    name: 'windows-terminal',
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\u\\AppData\\Local' },
  });
  assert.equal(
    withPath.configPath,
    path.join('C:\\u\\AppData\\Local', 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json')
  );
  assert.ok(withPath.snippet.includes('sendInput'));
  const noPath = svc.planTerminalSetup({ name: 'windows-terminal', platform: 'win32', env: {} });
  assert.equal(noPath.configPath, null);
  assert.equal(svc.planTerminalSetup({ name: 'windows-terminal', env: { LOCALAPPDATA: '  ' } }).configPath, null);
});

test('未知终端给通用引导（Ctrl+J 兜底），needsSetup=false', () => {
  const p = svc.planTerminalSetup({ name: 'hyper', platform: 'linux', homedir: '/u' });
  assert.equal(p.category, 'unknown');
  assert.equal(p.needsSetup, false);
  assert.ok(p.reason.includes('Ctrl + J'));
  // displayName 保留原名；完全无名 → 未知终端
  assert.equal(p.displayName, 'hyper');
  assert.equal(svc.planTerminalSetup({}).displayName, '未知终端');
  assert.equal(svc.planTerminalSetup({}).terminal, 'unknown');
});

test('isEnabled：KHY_TERMINAL_SETUP 默认开，仅 0/false/off/no/空 关', () => {
  assert.equal(svc.isEnabled(), true);
  assert.equal(svc.isEnabled({}), true);
  for (const v of ['0', 'false', 'off', 'no', '']) {
    assert.equal(svc.isEnabled({ KHY_TERMINAL_SETUP: v }), false, v);
  }
  assert.equal(svc.isEnabled({ KHY_TERMINAL_SETUP: '1' }), true);
  assert.equal(svc.isEnabled({ KHY_TERMINAL_SETUP: ' FALSE ' }), false);
  // 垃圾值：null env 走 isOffValue(undefined) → off；数字 0 → '0' → off
  assert.equal(svc.isEnabled(null), false);
  assert.equal(svc.isEnabled({ KHY_TERMINAL_SETUP: 0 }), false);
  assert.equal(svc.isEnabled({ KHY_TERMINAL_SETUP: NaN }), true); // 'nan' 不在 off 集
});
