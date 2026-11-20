'use strict';

/**
 * check-aesthetics 覆盖面读数测试（块 B3 / `FE-004` / `[DESIGN-FE-012]`）。
 *
 * 跑法：`npm run test:scripts`
 * 单跑：`node --test scripts/tests/check-aesthetics-coverage.test.js`
 *
 * 覆盖重点：
 * 1. 未度量端必须**点名**（tui / desktop / mobile），不能从通过率里消失。
 * 2. 已度量端不得同时出现在 unmeasured 里。
 * 3. 覆盖面是观察读数：S1 下 exit 恒 0，不把未度量算成失败。
 * 4. 原有 WCAG 对比度判据行为不变（不达标仍报 warning，达标不报）。
 *
 * 夹具经 `KHY_AESTHETICS_ROOT` 指到一个临时仓库，不读写真实主题文件。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-aesthetics.js');

const TOKENS_REL = 'docs/10_规范/registry/AESTHETICS-TOKENS.json';
const WEB_THEME_REL = 'delivery/channel/web/ai-frontend/src/styles/newapi-theme.css';
const KHYQUANT_THEME_REL = 'delivery/channel/khyquant/frontend/src/styles/theme.css';

const CATEGORIES = ['color', 'typography', 'spacing', 'radius', 'shadow', 'motion', 'icon'];

/** 七分类各一个语义令牌；surfaces 全 null（schema 合法，不触发漂移告警）。 */
function tokensFixture() {
  const token = {
    required: true,
    rationale: 'coverage fixture',
    source: 'coverage fixture',
    surfaces: { tui: null, web: null, khyquant: null, desktop: null, mobile: null },
  };
  const data = { $meta: { standard: 'WCAG 2.2', version: '1.0' } };
  for (const category of CATEGORIES) data[category] = { sample: { ...token } };
  return data;
}

const _dirs = [];

function makeRoot(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-aes-'));
  _dirs.push(root);
  fs.mkdirSync(path.join(root, path.dirname(TOKENS_REL)), { recursive: true });
  fs.writeFileSync(path.join(root, TOKENS_REL), JSON.stringify(tokensFixture()), 'utf8');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return root;
}

function run(root, args = []) {
  const r = cp.spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, KHY_AESTHETICS_ROOT: root },
  });
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}` };
}

function runJson(root, args = []) {
  const r = run(root, ['--json', ...args]);
  return { ...r, json: JSON.parse(r.output) };
}

process.on('exit', () => {
  for (const dir of _dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('check-aesthetics — 覆盖面读数', () => {
  test('三端都未度量时，tui / desktop / mobile 必须被点名', () => {
    const root = makeRoot();
    const { json, status } = runJson(root);
    assert.equal(status, 0);
    assert.deepEqual(json.coverage.measured, [], '没有主题文件时不得宣称任何端已度量');
    for (const end of ['tui', 'desktop', 'mobile']) {
      assert.ok(json.coverage.unmeasured.includes(end), `${end} 必须出现在 unmeasured 里`);
    }
    const human = run(root);
    assert.match(human.output, /未度量 [^\n]*tui[^\n]*desktop[^\n]*mobile/, '人读输出必须点名三端');
  });

  test('已度量端的名字不得进入 unmeasured', () => {
    const root = makeRoot({
      // web 主题块在真源里写作 `html:root`（守卫的块定位正则只认这种写法）。
      [WEB_THEME_REL]: 'html:root { --khy-text-main: #111; --khy-bg-main: #fff; }\n',
      [KHYQUANT_THEME_REL]: ':root { --text-primary: #111; --bg-primary: #fff; }\n',
    });
    const { json, output } = runJson(root);
    assert.deepEqual(json.coverage.measured, ['web', 'khyquant'], output);
    assert.deepEqual(json.coverage.unmeasured, ['tui', 'desktop', 'mobile'], output);
    assert.ok(!json.coverage.unmeasured.includes('web'));
    assert.ok(!json.coverage.unmeasured.includes('khyquant'));
    assert.match(output, /已度量 web \(1 个令牌文件\)、khyquant \(1 个令牌文件\)/);
  });

  test('令牌块认不出 ⇒ 该端算未度量，不算通过', () => {
    // 文件在、但选择器换了（不是 :root）⇒ 一次比较都没做，必须诚实报未度量。
    const root = makeRoot({ [WEB_THEME_REL]: '.legacy-theme { --khy-text-main: #111; --khy-bg-main: #fff; }\n' });
    const { json, output } = runJson(root);
    assert.ok(json.coverage.unmeasured.includes('web'), `web 未做比较却报了已度量\n${output}`);
    assert.ok(!json.coverage.measured.includes('web'));
  });

  test('覆盖面 finding 存在且判级 warning（advisory）', () => {
    const root = makeRoot();
    const { json, output } = runJson(root);
    const finding = json.findings.find((f) => f.id === 'aesthetics-coverage-gap');
    assert.ok(finding, `缺少 aesthetics-coverage-gap finding\n${output}`);
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.rule, 'FE-004');
    assert.match(finding.message, /DESIGN-FE-012 已声明缺口/);
  });

  test('exit code 仍为 0（S1 观察者，不把未度量算成失败）', () => {
    const root = makeRoot();
    const human = run(root);
    assert.equal(human.status, 0, human.output);
    assert.match(human.output, /stage=S1 exit=0/);
    const { json, status } = runJson(root);
    assert.equal(status, 0);
    assert.equal(json.summary.exitCode, 0);
  });
});

describe('check-aesthetics — 原有对比度判据行为不变', () => {
  test('WCAG 不达标仍报 warning，且只报实际算过的那一对', () => {
    const root = makeRoot({
      [WEB_THEME_REL]:
        'html:root { --khy-text-main: #999999; --khy-bg-main: #ffffff; --khy-text-strong: #111111; }\n',
    });
    const { json, output } = runJson(root);
    const contrast = json.findings.filter((f) => /对比度不足/.test(f.message));
    assert.equal(contrast.length, 1, `应只有 text-main 一对不达标\n${output}`);
    assert.match(contrast[0].message, /--khy-text-main 对 --khy-bg-main = 2\.85:1 < 4\.5:1/);
    assert.match(contrast[0].message, /Web 亮色 :root，正文/);
    assert.ok(!contrast.some((f) => /--khy-text-strong/.test(f.message)), '达标的一对不得误报');
    assert.equal(json.summary.exitCode, 0, 'warning 不得影响 exit code');
  });

  test('达标配色不产生对比度 finding（判据不是恒真）', () => {
    const root = makeRoot({
      [WEB_THEME_REL]: 'html:root { --khy-text-main: #111111; --khy-bg-main: #ffffff; }\n',
    });
    const { json, output } = runJson(root);
    assert.equal(json.findings.filter((f) => /对比度不足/.test(f.message)).length, 0, output);
    assert.ok(json.findings.some((f) => f.id === 'aesthetics-coverage-gap'), '覆盖面读数本身仍应存在');
  });
});
