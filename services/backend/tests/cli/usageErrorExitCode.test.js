'use strict';

// Regression: a usage error must fail for the shell, not only for the eye.
//
// `khy repo nosuchverb` printed a red 「✗ 未知子命令」 while exiting 0, so
// `khy backup clean && <next>` kept running after the step that never happened —
// even though an unknown *top-level* command (bin/khy.js:471-491) exits 1 for the
// visually identical complaint. The four handlers now call the repo's single-source
// helper utils/markProcessFailure.js, same as handlers/verify.js and manage.js do.
//
// The success controls matter as much as the failures: this asserts the guards do
// not mark the bare/help forms, which are legitimate exits.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test } = require('node:test');
const assert = require('node:assert');

const BIN = path.resolve(__dirname, '../../bin/khy.js');
const PASS_THROUGH = /^(PATH|PATHEXT|COMSPEC|SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|TMPDIR|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|LANG|LC_ALL|TERM|NODE_ENV|CI)$/i;

function run(args, tmpHome) {
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (PASS_THROUGH.test(key)) env[key] = process.env[key];
  }
  env.HOME = tmpHome;
  if (process.platform === 'win32') env.USERPROFILE = tmpHome;
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, timeout: 60000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function withHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-usage-rc-'));
  try {
    return fn(tmpHome);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

const FAILING_FORMS = [
  { args: ['repo', 'nosuchverb'], mark: '未知子命令: repo nosuchverb' },
  { args: ['receipts', 'bogus'], mark: '未知子命令: receipts bogus' },
  { args: ['backup', 'bogusverb'], mark: '未知子命令:backup bogusverb' },
  { args: ['docs', 'nosuchtopic'], mark: '未知文档主题: nosuchtopic' },
  // r193 (#166/#168 family): router.js 内联分支的 ✗ 用法。刻意只钉
  // 「缺参即 ✗」形态——它们先于 isOllamaRunning 探测返回,与本机是否运行
  // Ollama 无关,不会 flaky;「Ollama 未运行」分支的 rc=1 由真跑双面复现验证。
  { args: ['db'], mark: '用法: db init' },
  { args: ['models', 'pull'], mark: '用法: models pull <model-id>' },
  { args: ['models', 'set'], mark: '用法: models set <model-id>' },
  { args: ['models', 'delete'], mark: '用法: models delete <model-id>' },
  { args: ['models', 'import'], mark: '用法: models import <path>' },
  // r194 (#211): routerDispatchSlash.js tasks 簇。刻意只钉「缺参/不存在即 ✗」
  // 形态;`tasks cancel <bogus>` 的消息文本随 store 方言而异,由活屏 rc=1 验证,
  // 不进断言防 flaky。
  { args: ['tasks', 'logs'], mark: '请提供任务 ID' },
  { args: ['tasks', 'nosuchtask-xyz-r194'], mark: '未找到任务' },
  // r195 (#82 族): handlers/cron.js 的 ✗ 分支此前全部 rc=0。未知动词形态同时
  // 钉住「复述被拒词」——parseInput 兜底把 subCommand 置 null,动词只留在
  // args 里,不回捞就会打成「cron null」(repro-after 实测过这个坑)。
  { args: ['cron', 'remove', 'nosuchid-r195'], mark: '未找到任务 nosuchid-r195' },
  { args: ['cron', 'disable', 'nosuchid-r195'], mark: '未找到任务 nosuchid-r195' },
  { args: ['cron', 'add'], mark: '缺少参数' },
  { args: ['cron', 'remove'], mark: '缺少任务 ID' },
  { args: ['cron', 'bogus'], mark: '未知子命令: cron bogus' },
  // r196 (#213): routerDispatchOps.js history 簇 + router.js resume 空参/未找到。
  // history 的 ✗ 先于任何 store 访问返回,文本可直接钉;`resume <生 ID>` 落进
  // INVALID_ID 还是「未找到会话」取决于运行 cwd 映射的工程对话账本是否已有
  // 记录(两分支都打 ✗),只钉 ✗ 字形防 flaky。
  { args: ['history', 'bogus-r196'], mark: '未知子命令: history bogus-r196' },
  { args: ['resume', ''], mark: '会话参数为空串' },
  { args: ['resume', 'no-such-ref-r196'], mark: '✗' },
  // r197 (#210): 未知动词此前被 list 分支的 `!subCommand` 吞掉——Ollama 在线时
  // 静默打模型表,离线时误报「Ollama 未运行」钉错病因。回捞门先于任何探测返回,
  // 与本机是否运行 Ollama 无关,不 flaky(同 r193 的「缺参即 ✗」判据)。
  { args: ['models', 'bogusverb-r197'], mark: '未知子命令: models bogusverb-r197' },
  // r198: 'khymodel' 不在 SUB_COMMANDS,动词位永远为空——import|export|scan 分支
  // 整体不可达、任何动词都被 list 吞(rc=0)。本地回捞门复活后,两条 ✗ 都先于
  // 任何网络/导出动作返回(export 缺名即用法错),不 flaky。
  { args: ['khymodel', 'bogusverb-r198'], mark: '未知子命令: khymodel bogusverb-r198' },
  { args: ['khymodel', 'export'], mark: '用法: khymodel export' },
  // r199 (khymodel 病根普查):router.js 四簇。gateway 的 vertex/reset-failures
  // 不在注册表(默认吞进 22s 探测屏)、profile/cloud 整条不在注册表(默认屏
  // printInfo 亲口宣传这些动词=幻影屏自证说谎)、plugin 拼错动词被 !subCommand
  // 兜底吞进帮助墙。全部只钉「被拒即 ✗」形态,门先于探测/网络/inquirer 返回。
  // `cloud login` 钉的是复活守卫:spawnSync 子进程 stdin 恒为管道(非 TTY),
  // 不钉会在本地/CI 差异下 flaky——管道恰恰是两处的共同形态。
  { args: ['gateway', 'bogusverb-r199'], mark: '未知子命令: gateway bogusverb-r199' },
  { args: ['profile', 'bogusverb-r199'], mark: '未知子命令: profile bogusverb-r199' },
  { args: ['profile', 'import'], mark: '用法: profile import <file.json>' },
  { args: ['cloud', 'bogusverb-r199'], mark: '未知子命令: cloud bogusverb-r199' },
  { args: ['cloud', 'login'], mark: '需要交互式终端' },
  { args: ['plugin', 'bogusverb-r199'], mark: '未知子命令: plugin bogusverb-r199' },
  // r209: `gateway manage <拼错动词>` 的 ✗ 在 CLEAN 的 gatewayManageDaemon.js
  // (gateway.js 只透传再导出)，此前无 mark → ✗/rc=0。同形 3 处(鉴权拒绝/未知
  // 操作/守护启动失败)一并补 mark，此处钉活复现的代表形态。
  { args: ['gateway', 'manage', 'zzr209'], mark: '未知 manage 操作: zzr209' },
  // r200: train 未注册的 export-data 已回捞(真写盘,不落用例断言);钉的是未知动词门。
  // admin 是隐藏命令:args[0] 兼作密码位,只修 ✗/rc 契约与非 TTY 假成功,不建未知词门。
  { args: ['train', 'bogusverb-r200'], mark: '未知子命令: train bogusverb-r200' },
  { args: ['admin', 'wrongpass-r200'], mark: '密码错误' },
  { args: ['admin'], mark: '需要管理密码' },
  // r201: train 四个本地可复现的 ✗ 分支(用法门/教师门/JSON 解析门)补 mark。
  // 全部在触网/触盘之前就 return,可安全钉死。
  { args: ['train', 'export'], mark: '用法: train export' },
  { args: ['train', 'upload'], mark: '用法: train upload' },
  { args: ['train', 'distill'], mark: '请指定教师模型' },
  { args: ['train', 'distill', '--prompts-json', '{bad'], mark: '--prompts-json 解析失败' },
  // r202: log 未知动词曾静默落默认错误日志屏(注册表只有 error|tail|clear)。
  { args: ['log', 'bogusverb-r202'], mark: '未知子命令: log bogusverb-r202' },
  // r203: router.js 内联簇剩余 9 处 printError-return-true 无 mark(#82 族本体,
  // 早于 r193 只修的两处)。全部在触网/触盘之前 return:用法门只看 args 是否为
  // 空,`search <无匹配词>` 落本地品种表检索(searchInstruments,无网络)。
  // strategy 是回捞门:注册表只有 list,拼错动词曾被 `!subCommand` 吞进表屏。
  { args: ['quote'], mark: '用法: quote <代码|名称>' },
  { args: ['data', 'fetch'], mark: '用法: data fetch <代码|名称>' },
  { args: ['data', 'bogusverb-r203'], mark: '未知 data 子命令 "bogusverb-r203"' },
  { args: ['cache', 'bogusverb-r203'], mark: '未知 cache 子命令 "bogusverb-r203"' },
  { args: ['backtest'], mark: '用法: backtest <代码|名称>' },
  { args: ['search', 'web'], mark: '用法: search web <关键词>' },
  { args: ['search', ''], mark: '用法: search <关键词>' },
  { args: ['search', 'xyzzy-none-r203'], mark: '未找到匹配 "xyzzy-none-r203" 的品种' },
  { args: ['web_search'], mark: '用法: web_search <关键词>' },
  { args: ['analyze'], mark: '用法: analyze <代码|名称>' },
  { args: ['strategy', 'bogusverb-r203'], mark: '未知子命令: strategy bogusverb-r203' },
  // r204 (#82 族,#143 portable 同病根):crossPlatform.js 旧兜底把 parseInput
  // 置 null 的未知动词默认成 status——switch 的 default「未知子命令」✗ 整体
  // 不可达,且全族 11 处 ✗(用法门/未连接门/未知平台)此前都 rc=0。刻意不钉
  // `cross connect` 与裸 `cross`(状态屏):两处 ✗ 取决于本机同步服务器是否在听,
  // 同 r193 Ollama 的 flaky 判据,只由活屏验证 rc=1(见 ledger my-r204)。
  { args: ['cross', 'zzbogus-r204'], mark: '未知子命令: cross zzbogus-r204' },
  { args: ['cross', 'devices'], mark: '未连接。请先运行: khy cross connect' },
  { args: ['cross', 'join'], mark: '用法: khy cross join <sessionId>' },
  { args: ['cross', 'leave'], mark: '用法: khy cross leave <sessionId>' },
  { args: ['cross', 'send'], mark: '用法: khy cross send <deviceId> <message>' },
  { args: ['cross', 'notify'], mark: '用法: khy cross notify <userId> <title> [body]' },
  { args: ['cross', 'route'], mark: '用法: khy cross route <platform> <command>' },
  { args: ['cross', 'start'], mark: '用法: khy cross start <platform|all>' },
  { args: ['cross', 'stop'], mark: '用法: khy cross stop <platform>' },
  { args: ['cross', 'stop', 'zz-r204'], mark: '未知平台: zz-r204' },
  // r205 (本人脏 extension.js,r184 已确指):未知动词 ✗ 早已存在(#27 族修时
  // 只加文案未加 mark),9 处 catch ✗ 同漏。install/update/new 的 catch 也打了
  // mark 但不钉——前者触网、后者真建目录,复现噪音不可接受(同 r204 判据);
  // 下方 5 形态全本地 no-op(对不存在对象操作)先落 ✗ 再 return。
  { args: ['ext', 'bogusr205'], mark: '未知 ext 子命令 "bogusr205"' },
  { args: ['ext', 'enable', 'nosuch-r205'], mark: '启用「nosuch-r205」失败' },
  { args: ['ext', 'disable', 'nosuch-r205'], mark: '禁用「nosuch-r205」失败' },
  { args: ['ext', 'uninstall', 'nosuch-r205'], mark: '卸载「nosuch-r205」失败' },
  { args: ['ext', 'link', '/nonexistent-dir-r205'], mark: '链接 /nonexistent-dir-r205 失败' },
  // r206 (本人脏 learn.js,ledger 1480 确指):26 处 printError 从无 mark(#82 族
  // 最大单文件)。动态覆盖层刷新(含模型调用)只在「找到课程」路径触发(234/268
  // 行),以下 5 形态全在 ✗ 分支先 return,恒不过网关——钉这些,不钉 learn bug
  // <案例>(命中时落 aiForward 外呼)。
  { args: ['learn', 'zznever-r206'], mark: '未找到与 "zznever-r206"' },
  { args: ['learn', '100'], mark: '没有第 100 层课程' },
  { args: ['learn', 'done'], mark: '用法: learn done' },
  { args: ['learn', 'import'], mark: '用法: learn import' },
  { args: ['learn', 'edit', 'zzact-r206'], mark: '未知编辑操作: zzact-r206' },
  // r207 (本人脏 mcp.js + routerDispatchSlash.js):handler 的 return 1 被派发面
  // 吞掉(rc=0,同 #82  Morph-2 亚型),且未注册动词被 parseInput 置 null 后静默
  // 落进只读治理视图(尾墙不可达,#210 同病根)→ 回捞门 + 25 处 ✗ 补 mark。
  // 不钉 serve(起 stdio 服务读 stdin)、eco/doctor(读别家 agent 配置/慢扫描)、
  // add/export/remove <真名>(写盘或触网)——同 r193 flaky 判据。
  { args: ['mcp', 'zzr207x'], mark: '未知子命令: mcp zzr207x' },
  { args: ['mcp', 'remove'], mark: '用法:khy mcp remove' },
  { args: ['mcp', 'show'], mark: '用法:khy mcp show' },
  { args: ['mcp', 'test'], mark: '用法:khy mcp test' },
  { args: ['mcp', 'test', 'nosuch-r207'], mark: '配置里没有名为「nosuch-r207」' },
  { args: ['mcp', 'enable'], mark: '用法:khy mcp enable' },
  { args: ['mcp', 'disable'], mark: '用法:khy mcp disable' },
];

for (const form of FAILING_FORMS) {
  test(`khy ${form.args.join(' ')} says it failed AND exits 1`, () => withHome((home) => {
    const r = run(form.args, home);
    // Both halves are required: rc=1 with no message is a silent failure, and a
    // message with rc=0 is the bug this file exists for.
    assert.ok(r.out.includes(form.mark),
      `error text lost (output was:\n${r.out.slice(0, 400)})`);
    assert.equal(r.code, 1, `usage error still exits ${r.code} — shell cannot see it`);
  }));
}

// The bare forms print help/usage and must still exit 0.
// r194: `tasks` 裸与 `tasks list`(新增 filter 别名,渲染任务表)都是合法退出。
// r195: `cron` 裸与 `cron help` 落帮助墙——unknown-verb 复述分支必须放过它们
// (parseInput 对两者同样置 subCommand=null,靠 args 回捞区分)。
// r196: `history` 裸/list 同上;刻意不放裸 `resume`——它命中 resumeAdvisor 时
// 会经 aiForward 外呼模型(计费路径),不适合作子进程断言。
// r198: 裸 `khymodel` 走本地目录扫描(只读、无网络),恒 rc=0,可作控制。
// r199: 裸 profile/cloud/plugin 与 `plugin help` 分别落画像摘要/状态墙/帮助墙,
// 均本地只读恒 rc=0;刻意不放裸 `gateway`——它落 22s 通道探测,慢且 flaky。
// r200: 裸 train 与 `train data` 是本地只读统计屏恒 rc=0;`train export-data`
// 真写盘(落项目 .khy/training,HOME 沙箱不隔离)故不入控制;裸 admin 现为 ✗ 门非控制。
// r202: `log error` 只读日志尾恒 rc=0——同时负向钉住门不得误伤合法动词。
// r203: 裸 strategy 与 `strategy list` 落表屏、裸 cache 落 printInfo 提示屏,
// r204: `cross help` 落动词清单(回捞门的 help 豁免,同 portable 先例)、
// `cross sessions` 只读本地会话计数恒 rc=0。两者负向钉住门不误伤合法动词。
// r206: 裸 `learn` 落层级总览、`learn edit` 落编辑动词清单,均本地只读恒 rc=0。
// r207: 裸 `mcp`/`mcp list`/`mcp governance` 落只读治理视图、`mcp help` 落动词
// 清单(回捞门 help 豁免),恒 rc=0;负向钉住门不误伤注册动词与 list 别名。
// 均本地只读恒 rc=0;后者负向钉住 cache 门只拦未知词、不拦裸形态。
for (const args of [['repo'], ['docs'], ['receipts'], ['tasks'], ['tasks', 'list'], ['cron'], ['cron', 'help'], ['history'], ['history', 'list'], ['khymodel'], ['profile'], ['cloud'], ['plugin'], ['plugin', 'help'], ['train'], ['train', 'data'], ['log', 'error'], ['strategy'], ['strategy', 'list'], ['cache'], ['cross', 'help'], ['cross', 'sessions'], ['ext'], ['ext', 'list'], ['ext', 'help'], ['learn'], ['learn', 'edit'], ['mcp'], ['mcp', 'list'], ['mcp', 'governance'], ['mcp', 'help']]) {
  test(`khy ${args.join(' ')} (bare) stays exit 0`, () => withHome((home) => {
    const r = run(args, home);
    assert.equal(r.code, 0, `bare form now marked as failure:\n${r.out.slice(0, 400)}`);
  }));
}

// Wiring guard: each handler must reach the marker through the shared helper.
// (Deliberately NOT "no file may ever set process.exitCode directly" — three of
// these handlers already did so in pre-existing branches that this fix does not
// own; an over-strict rule here would only teach the test to be reverted.)
test('the five handlers mark failure through utils/markProcessFailure', () => {
  for (const name of ['repo', 'receipts', 'backup', 'docs', 'cron']) {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/cli/handlers', `${name}.js`), 'utf8');
    assert.match(src, /require\(['"][^'"]*utils\/markProcessFailure['"]\)/,
      `${name}.js no longer uses the single-source failure marker`);
    assert.ok(/_markFailure\(\)/.test(src),
      `${name}.js imports the marker but never calls it`);
  }
});
