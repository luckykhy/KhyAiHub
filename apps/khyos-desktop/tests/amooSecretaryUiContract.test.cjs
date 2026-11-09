// 桌面端「amoo 秘书」标签的源码契约：提问 → 等回答 → 看结果这条链是「字符串 +
// 状态机」写成的，类型检查抓不到「磁贴没接上 switch」「回复被渲染成已核实」
// 「budget_exhausted 被塞进成功或普通失败」这类漂移。这里直接读源文件断言。
// 与 amooUiContract.test.cjs 同型：一个管投递，一个管秘书，互不替代。
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// 秘书面板拆成主件 + 共享记忆区 + 手机循环状态区 + 面板共用小件四份源文件
// （metrics 闸门 B1），契约断言对拼接文本跑，不变量一条不减。
const pane = [
  'src/renderer/components/amoon/AmooSecretaryPane.tsx',
  'src/renderer/components/amoon/AmooSecretaryMemory.tsx',
  'src/renderer/components/amoon/AmooSecretaryLoopStatus.tsx',
  'src/renderer/components/amoon/amoonShared.tsx',
]
  .map(read)
  .join('\n')
// 循环状态区的专属断言跑在单文件上：拼接文本里有主面板 result 轮询的
// setInterval，「桌面不轮询循环状态」的不变量只能在它自己的文件上钉。
const loopPane = read('src/renderer/components/amoon/AmooSecretaryLoopStatus.tsx')
const sidePane = read('src/renderer/components/layout/SidePane.tsx')
const appLayout = read('src/renderer/components/layout/AppLayout.tsx')
const commandCenter = read('src/renderer/components/message/CommandCenter.tsx')

test('接线：SidePane 三处 + AppLayout 标题表都接上 amooSecretary', () => {
  assert.match(sidePane, /PaneTabKind\s*=[^;]*'amooSecretary'/, 'PaneTabKind 必须包含 amooSecretary')
  assert.match(sidePane, /kind:\s*'amooSecretary'/, 'TAB_TILES 必须有 amoo 秘书磁贴')
  assert.match(sidePane, /case\s+'amooSecretary'\s*:\s*\n\s*return\s+<AmooSecretaryPane/, 'TabBody 必须渲染 AmooSecretaryPane')
  assert.match(
    sidePane,
    /lazy\(\s*\(\)\s*=>\s*import\([^)]*amoon\/AmooSecretaryPane[^)]*\)/,
    '必须懒加载 AmooSecretaryPane（与其它面板同一加载方式）'
  )
  assert.match(sidePane, /label:\s*'amoo 秘书'/, '磁贴标签必须是「amoo 秘书」，与「amoo 投递」分开')
  assert.match(
    sidePane,
    /description:\s*'提问 · 等回答 · 可中止（回复未验证）'/,
    '磁贴描述照方案原文：提问 · 等回答 · 可中止（回复未验证）'
  )
  assert.match(appLayout, /amooSecretary:\s*'amoo 秘书'/, 'TAB_TITLES（Record<PaneTabKind,string>）必须补 amooSecretary')
})

test('既有 amoo 标签改名三处，一处都不能漏', () => {
  assert.match(sidePane, /kind:\s*'amoon',\s*label:\s*'amoo 投递'/, 'SidePane TAB_TILES 的 amoon label 必须改成「amoo 投递」')
  assert.match(appLayout, /amoon:\s*'amoo 投递'/, 'AppLayout TAB_TITLES 的 amoon 必须改成「amoo 投递」')
  assert.match(commandCenter, /label:\s*'打开 amoo 投递'/, 'CommandCenter 命令 label 必须改成「打开 amoo 投递」')
  assert.doesNotMatch(commandCenter, /打开 amoo 桥接/, '旧名「打开 amoo 桥接」不许残留')
})

test('秘书面板只走 preload 通道：不 fetch、不读文件、不接触 token', () => {
  assert.doesNotMatch(pane, /\bfetch\s*\(/, '渲染层不得直接 fetch（bridge 会 403 Origin）')
  assert.doesNotMatch(pane, /\bfs\.|readFileSync|node:fs|require\(/, '渲染层不得自己读磁盘/token')
  assert.match(pane, /__KHYOS__/, '只走 preload 注入的 API')
  assert.doesNotMatch(pane, /amoonSend|amoonInbox/, '不得把投递/回执通道当问答用（同一原子能力只允许一个持有者）')
  assert.doesNotMatch(pane, /已发送/, '投递通道的「已发送」字样不许带进秘书标签')
})

test('回复恒带「未验证」徽标与口径原文，类型层不存在 verified:true', () => {
  assert.match(pane, /unverified\s*:\s*true/, 'reply 的 unverified 必须钉成字面量 true')
  assert.doesNotMatch(pane, /(?<!un)verified\s*:\s*true/, '不许出现任何 verified:true 形状')
  assert.match(pane, /未验证/, '回复渲染块必须带「未验证」徽标')
  // 整句文案保持不变：前半句（至「未校验」）才是 catalog amoo_result note 的
  // 原文，后半句（「其它活动时…」）是本面板增设，全仓检索仅面板一处——
  // 注释不得自称整句 verbatim（底稿 A5）。
  assert.match(
    pane,
    /Amoo 聊天气泡原文，未解析、未摘要、未校验；Amoo 聊天有其它活动时，最新气泡不保证就是这条提问的回答/,
    '未验证口径整句保持不变：前半句照 catalog 原文，后半句是本面板增设'
  )
  assert.doesNotMatch(pane, /Verbatim from the phone bridge catalog/, '注释不许把后半句也说成 catalog 原文')
})

test('状态串不含含糊词（RUNTIME-002）', () => {
  const banned = ['正在工作', '处理中', '尝试连接', '请稍候', '正在加载', '加载中', 'loading', 'processing', 'connecting']
  for (const token of banned) {
    assert.ok(!pane.toLowerCase().includes(token.toLowerCase()), `面向用户的状态串不许出现含糊词：${token}`)
  }
})

test('失败四码各有独立分支文案', () => {
  const copy = {
    failed: '桥报了失败',
    stopped: '已通知手机端停止本轮提问',
    budget_exhausted: '在桥的等待上限内没有拿到回复',
    no_ask_running: '桥明确报告没有进行中的提问',
  }
  for (const [code, line] of Object.entries(copy)) {
    assert.match(pane, new RegExp(`state === '${code}'[\\s\\S]{0,400}?${line}`), `${code} 分支必须有自己的文案：${line}`)
  }
})

test('state="" 有独立分支，文案是「手机上没有进行中的提问」', () => {
  assert.match(pane, /state === ''/, '空状态串必须有独立分支，不能和 no_ask_running 混为一谈')
  assert.match(pane, /state === ''[\s\S]{0,200}?NO_ASK_TITLE/, '空状态分支必须用「手机上没有进行中的提问」标题')
  assert.match(pane, /const NO_ASK_TITLE = '手机上没有进行中的提问'/, '标题常量必须是方案指定的文案')
  assert.match(pane, /state === ''[\s\S]{0,200}?桥返回了空状态/, '空状态分支要有自己的说明')
})

test('single_flight 既不当成功也不当普通失败', () => {
  assert.match(pane, /single_flight/, '必须识别桥的单飞锁')
  assert.match(pane, /手机端已有进行中的提问/, 'single_flight 必须有独立文案')
  assert.match(pane, /同一时间只能有一个/, 'single_flight 文案要说清单飞锁语义')
})

test('能力三态各有独立文案，缺一项就禁用提问', () => {
  assert.match(pane, /桥上未报到助手协同能力/, 'assistantAvailable===false 的第一段文案')
  assert.match(pane, /这一组能力整组随 Amoo 安装态关闭/, 'assistantAvailable===false 的第二段文案')
  assert.match(pane, /桥未报到，能力未知/, 'assistantAvailable===null 的文案')
  assert.match(pane, /手机桥不在线/, '探测失败的文案')
  assert.match(pane, /khy phone tools/, '修复建议要给出可执行命令')
})

test('卸载/切标签必须停轮询并退订事件，不许给已销毁窗口推事件', () => {
  assert.match(pane, /onAmooSecretaryEvent\(/, '必须订阅车道事件')
  assert.match(pane, /amooSecretaryStopPolling\(\)/, '卸载必须通知车道停轮询')
  assert.match(pane, /clearInterval/, '必须清掉本面板的轮询定时器')
  assert.match(pane, /alive\.current/, '异步回调必须防已销毁窗口')
})

test('运行中「中止」常在，进度带轮次与已等时间', () => {
  assert.match(pane, /showStop/, 'asking/polling 期间必须渲染中止按钮')
  assert.match(pane, /第 \$\{lane\.round\} 轮/, 'polling 必须显示第 n 轮')
  assert.match(pane, /已等 \{seconds\(lane\.waitedMs\)\}/, 'polling 必须显示已等时间')
  assert.match(pane, /上限 \$\{seconds\(lane\.budgetMs\)\}/, 'polling 必须显示等待上限')
})

// ── 问答历史（本地台账，只读）────────────────────────────────────────────
// 台账唯一持有者在 host 进程；面板只经 probe/result 回包拿只读切片。

function sectionBetween(startMarker, endMarker) {
  const at = pane.indexOf(startMarker)
  assert.ok(at > 0, `源码里必须能定位 ${startMarker}`)
  const end = pane.indexOf(endMarker, at)
  return end > at ? pane.slice(at, end) : pane.slice(at)
}

test('历史区存在、渲染只依赖 history，不受 assistantAvailable 门控（Amoo 缺席也要能回看）', () => {
  const body = sectionBetween('function HistorySection', 'export function AmooSecretaryPane')
  assert.ok(body.length > 0, 'HistorySection 必须存在')
  assert.ok(!body.includes('capability'), '历史区不得按能力态禁用：本地数据与 Amoo 在不在无关')
  assert.match(pane, /<HistorySection history=\{history\} \/>/, '主件必须渲染历史区')
  assert.match(body, /问答历史/, '区块标题必须是「问答历史」')
  assert.match(body, /共 \{history\.total\} 条/, '必须显示台账总条数')
  assert.match(body, /新→旧/, '历史必须标注新→旧顺序')
})

test('历史数据只来自 probe / result 回包，渲染层不写台账、不另开存储', () => {
  assert.match(pane, /if \(r && r\.history\) setHistory\(r\.history\)/, '探测回包必须喂历史（探测失败也要带回）')
  assert.match(pane, /if \(r\.history\) setHistory\(r\.history\)/, '结果轮询回包必须喂历史（终态后跟上新条目）')
  assert.doesNotMatch(pane, /localStorage|sessionStorage|indexedDB/, '历史区不得在渲染层开第二份存储')
})

test('历史结局徽标复用 laneFailureView 文案口径，非 done 一律不得画成成功', () => {
  assert.match(pane, /laneFailureView\(entry\.outcome\)/, '非 done 结局的徽标必须取 laneFailureView 的标题')
  assert.match(
    pane,
    /if \(entry\.outcome === 'done'\) return \{ label: '已回复', ok: true \}/,
    '只有 done 才允许「已回复」徽标'
  )
})

test('历史回复恒带「未验证」徽标，摘录与截断各有诚实提示', () => {
  const body = sectionBetween('function HistoryEntryRow', 'function HistorySection')
  assert.match(body, /未验证/, '历史回复必须带未验证徽标')
  assert.match(body, /历史切片只保留前 600 字，不是完整回复。/, '切片摘录必须说明不是全文')
  assert.match(body, /回复可能被截断：完整文本只在手机上。/, '手机侧截断提示照「等回答」区同款口径')
  assert.match(body, /（记录里没有回复文本）/, 'done 而无回复文本要如实说明，不许留空白假装有答复')
})

test('落盘停用必须如实标注，不许谎称重启后仍在', () => {
  const body = sectionBetween('function HistorySection', 'export function AmooSecretaryPane')
  assert.match(body, /落盘不可用：仅本次运行/, 'persisted=false 必须显式说出口')
})

// ── stop 回包透传（底稿 A3 / §H4 第 4 项）────────────────────────────────
// 车道 stop 的两档都是 ok:true、差别只在 message 文案（amoo_stop 同时回
// running 与 ask_running，车道不向面板回传该字段，面板只能按文案分档）。
// 这里跨文件核对：车道原文、面板识别词、渲染通道三者逐字对得上。

test('stop 回包两档文案互异、照车道原文渲染、无「处理中」类含糊词', () => {
  const lane = read('src/host/amooSecretary.ts')
  const wrapping = '中止已送达，但手机侧自报提问仍在收尾：可再点一次中止'
  const normal = '已中止：手机侧这一问已停止（未产生的回复不会补送）'
  assert.ok(lane.includes(`'${wrapping}'`), '车道必须有收尾档原文（ask_running=true 档）')
  assert.ok(lane.includes(`'${normal}'`), '车道必须有正常档原文')
  assert.notEqual(wrapping, normal, '两档文案必须互异')
  // 面板用「仍在收尾」识别收尾档：判别词必须在收尾档原文里、且不在正常档里，
  // 否则分档会把两档混在一起。
  assert.ok(wrapping.includes('仍在收尾'), '收尾档原文必须含判别词「仍在收尾」')
  assert.ok(!normal.includes('仍在收尾'), '正常档原文不得含判别词，否则收尾档误判')
  assert.match(pane, /const r = await a\.amooSecretaryStop\(\)/, '面板必须绑定 stop 回包（await 不接返回值就是丢弃）')
  assert.match(pane, /<StopNoticeBlock notice=\{stopNotice\} \/>/, 'stop 回包必须喂进渲染块')
  assert.match(pane, /\{notice\.message\}/, '两档的 message 都必须原样渲染到面板')
  assert.match(pane, /stopNotice\?\.wrappingUp === true/, '收尾档中止按钮必须保持可点（可再点一次正是这句的意义）')
  assert.match(
    pane,
    /lane\.state === 'stopped' && stopNotice \?[\s\S]{0,120}?<StopNoticeBlock/,
    '收尾档渲染 stop 回包原文，不得画成「已中止」的完成块'
  )
  const banned = ['正在工作', '处理中', '尝试连接', '请稍候', '正在加载', '加载中', 'loading', 'processing', 'connecting']
  for (const msg of [wrapping, normal]) {
    for (const token of banned) {
      assert.ok(!msg.toLowerCase().includes(token.toLowerCase()), `stop 文案不许出现含糊词「${token}」`)
    }
  }
})

// ── 手机循环状态区（§H2 第 2 项：只读呈现 running / mode / 进展）──────────
// 循环状态是手机自报的只读快照：走秘书车道 loop_status（桥本地能力，
// ACCESS_READ，不带 confirm）。桌面不实现 loop_start/loop_stop（手机端行为，
// [DESIGN-ARCH-193] Q5），不做桌面轮询，进展文本不当提问回复、不进台账。

test('循环状态区：只读镜像，措辞标明手机侧自报，不代管启停、不轮询', () => {
  assert.match(pane, /amooSecretaryLoopStatus/, '循环状态必须走 preload 的 amooSecretaryLoopStatus 通道')
  assert.match(pane, /手机侧自报/, '呈现措辞必须标明手机侧自报')
  assert.match(pane, /最近一条进展/, '进展文本必须有标题区块')
  assert.match(pane, /不进问答台账/, '必须说明进展不进台账（台账只记问答轮）')
  assert.doesNotMatch(pane, /loop_start|loop_stop/, '桌面不得代管循环启停（那是手机端行为）')
  assert.doesNotMatch(loopPane, /setInterval|setTimeout/, '循环状态不做桌面轮询：快照随 capability 就绪拉一次，之后只靠「刷新」')
  assert.doesNotMatch(loopPane, /\bfetch\s*\(|localStorage|sessionStorage|indexedDB/, '循环状态区不 fetch、不落第二份存储')
})

test('循环状态区沿用 assistantAvailable 三态门控：off/null/missing 禁用并复用既有文案', () => {
  assert.match(loopPane, /LoopDisabledNotice/, '循环状态区必须有独立的禁用提示组件')
  assert.match(loopPane, /capability !== 'on' \? <LoopDisabledNotice capability=\{capability\} \/>/, '禁用提示必须按 capability 三态挂载')
  assert.match(loopPane, /手机桥不在线/, 'offline/missing 档沿用「手机桥不在线」标题')
  assert.match(loopPane, /桥上未报到助手协同能力/, 'off 档沿用「桥上未报到助手协同能力」标题')
  assert.match(loopPane, /这一组能力整组随 Amoo 安装态关闭/, 'off 档沿用整组随安装态关闭的口径')
  assert.match(loopPane, /桥未报到，能力未知/, 'null 档沿用「桥未报到，能力未知」标题')
})

test('循环状态区失败降级：原因照车道原文、点刷新重试，绝不伪造 running', () => {
  assert.match(loopPane, /读取循环状态失败/, 'call 失败/超时必须如实标出「读取循环状态失败」')
  assert.match(loopPane, /errText\(r, '读取循环状态失败'\)/, '车道 ok:false 的原因必须经 errText 原样给出')
  assert.match(loopPane, /桥未报告运行与否/, '桥没报 running 字段必须如实说未报告，不许画成未运行')
  const badge = loopPane.indexOf('loopRunningBadge')
  assert.ok(badge > 0, 'running 的三态必须收敛在一个徽标函数里，渲染处不得各自猜测')
})

test('循环状态区三态徽标互不相等：运行中 / 未在运行 / 桥未报告', () => {
  assert.match(loopPane, /手机侧自报 · 运行中/, 'running===true 的徽标')
  assert.match(loopPane, /手机侧自报 · 未在运行/, 'running===false 的徽标')
  assert.match(loopPane, /桥未报告运行与否/, 'running===null 的徽标（未知 ≠ 未运行）')
  assert.match(loopPane, /r\.running === true \? true : r\.running === false \? false : null/, 'running 归一必须是显式三值，缺字段落 null')
})

// ── 失败标题按因分档（read_failed ≠ failed）────────────────────────────────
// 同因不同命是这一组最重的谎：手机离线时，面板顶上是「手机桥不在线」，下面却
// 写着「提问失败 · 桥报了失败」。分档后两档的标题、正文与建议动作互不共用。

test('read_failed 有独立分支：标题、说明与建议动作都不与「桥报了失败」共用', () => {
  assert.match(pane, /state === 'read_failed'/, '读取失败必须有独立分支，不许并进 failed')
  assert.match(pane, /state === 'read_failed'[\s\S]{0,400}?读取状态失败/, '读取失败档标题必须是「读取状态失败」')
  assert.match(pane, /state === 'read_failed'[\s\S]{0,400}?这不是「桥报了失败」/, '读取失败档必须明说它不是桥报的失败')
  assert.match(pane, /state === 'read_failed'[\s\S]{0,400}?检查手机与桌面端的连接/, '读取失败档必须给连接修复建议')
})

test('failed 档标题点明「桥报了失败」，RUNNING_STATES 不收 read_failed', () => {
  assert.match(pane, /title: '提问失败 · 桥报了失败'/, 'failed 档标题必须点明失败来自桥的报告，不是桌面读不到')
  assert.match(pane, /title: '读取状态失败'/, 'read_failed 档标题必须与 failed 档分开')
  // read_failed 是终态展示，不是进行中：进了 RUNNING_STATES 会让面板对一次
  // 读不到的状态保持轮询，永远等不到恢复。
  assert.match(pane, /const RUNNING_STATES: LaneState\[\] = \['asking', 'polling'\]/, 'RUNNING_STATES 不许收 read_failed')
})

test('失败块渲染分档建议动作；错误行把嵌套 error 包成回包再交给 errText', () => {
  assert.match(pane, /建议：\{view\.action\}/, 'FailureBlock 必须渲染两档各自的建议动作')
  // errText 读的是回包的 error 字段；lane.error 本身就是那个嵌套 error，直接
  // 传进去读不到 message、渲染成空串——那行红字曾经一行字都没显示过。
  assert.match(pane, /errText\(\{ error: lane\.error \}, ''\)/, '错误行必须包一层再交给 errText')
})

// ── 记忆上限单一真源（底稿 A4 / §H7 第 7 项）────────────────────────────────
// 上限只允许住在后端 catalog 一处（phoneBridgeCatalog.js amoo_memory args 的
// maxLength）：车道从 catalog 派生并随 probe 回包下发，面板从回包读值。
// 三处字面量副本曾互不引用，改 catalog 另两处静默漂移——这里钉「没有第二份」。

const laneSrc = read('src/host/amooSecretary.ts')
const memoryPaneSrc = read('src/renderer/components/amoon/AmooSecretaryMemory.tsx')
const secretaryMainSrc = read('src/renderer/components/amoon/AmooSecretaryPane.tsx')

test('记忆上限单一真源：车道没有字面量副本，从 catalog 派生并随 probe 回包携带', () => {
  assert.doesNotMatch(laneSrc, /const MEMORY_(ID|TEXT|PROVENANCE)_MAX\s*=\s*\d/, '车道不得保留 128/4000/64 的字面量副本')
  assert.match(laneSrc, /findPhoneBridgeTool\('amoo_memory'\)/, '车道必须从 catalog 规格派生上限')
  assert.match(laneSrc, /memoryLimits\?: AmooMemoryLimits/, 'probe 回包类型必须携带 memoryLimits')
})

test('记忆区上限来自探测回包：面板没有字面量副本，主件把 status.memoryLimits 传下去', () => {
  assert.doesNotMatch(memoryPaneSrc, /const MEMORY_(ID|TEXT)_MAX\s*=\s*\d/, '面板不得保留 128/4000 的字面量副本')
  assert.match(memoryPaneSrc, /\{memText\.length\}\/\{memoryLimits\.text\}/, '字数计数器读回包值')
  assert.match(memoryPaneSrc, /!memoryLimits \|\|/, '回包未带上限时写入表单禁用')
  assert.match(memoryPaneSrc, /未取得共享记忆的规格上限/, 'catalog 缺席要有如实的说明文案')
  assert.match(secretaryMainSrc, /memoryLimits=\{status\?\.memoryLimits\}/, '主件必须把 status.memoryLimits 传给记忆区')
})

// ── 记忆区 DOM 行为（esbuild + jsdom，先例 amooPanel.test.cjs）──────────────
// 「展示来自回包」「catalog 缺席禁用写入」是运行时行为，源码契约只钉接线；
// 这里用刻意的非常规上限（id=11 / text=22）证明：值若是抄来的常量，
// 计数器会显示 4000 而不是 22，行为用例当场现形。

const esbuild = require('esbuild')
const { JSDOM } = require('jsdom')
const os = require('node:os')

const harnessBundle = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khyamoo-memory-')), 'harness.cjs')
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'tests', 'amooSecretaryMemory.harness.tsx')],
  outfile: harnessBundle,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  absWorkingDir: ROOT,
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'silent',
})

const memDom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
global.window = memDom.window
global.document = memDom.window.document
Object.defineProperty(global, 'navigator', { value: memDom.window.navigator, configurable: true })
for (const key of ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event']) {
  global[key] = memDom.window[key]
}

const { mount, unmount } = require(harnessBundle)

const flush = async (times = 5) => {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0))
}
const memRootText = () => document.getElementById('root').textContent || ''
const memButtons = () => [...document.querySelectorAll('#root button')]
const memButtonByLabel = (label) => memButtons().find((b) => (b.textContent || '').includes(label))
const idInput = () => document.querySelector('#root input:not([type="checkbox"])')
const contentBox = () => document.querySelector('#root textarea')

async function typeInto(el, value) {
  assert.ok(el, '找不到要输入的控件')
  const proto = el.tagName === 'TEXTAREA' ? memDom.window.HTMLTextAreaElement : memDom.window.HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new memDom.window.Event('input', { bubbles: true }))
  await flush()
}

test.after(() => {
  unmount()
  memDom.window.close()
})

test('记忆区 DOM：计数器与写入禁用读的是回包值（刻意的 id=11 / text=22）', async () => {
  unmount()
  mount({ capability: 'on', memoryLimits: { id: 11, text: 22, provenance: 5 } })
  await flush()
  assert.ok(memRootText().includes('0/22'), `计数器应显示回包上限 22（若显示 4000 就是抄来的常量）：${memRootText().slice(0, 200)}`)

  const write = memButtonByLabel('写入共享记忆')
  assert.ok(write, '写入按钮必须存在')
  await typeInto(idInput(), 'k')
  await typeInto(contentBox(), 'x'.repeat(22))
  assert.equal(write.disabled, false, '未超回包上限时写入可用')

  await typeInto(contentBox(), 'x'.repeat(23))
  assert.equal(write.disabled, true, '内容超过回包上限 22 后写入禁用')

  await typeInto(contentBox(), 'x'.repeat(10))
  await typeInto(idInput(), 'x'.repeat(12))
  assert.equal(write.disabled, true, 'id 超过回包上限 11 后写入禁用')
})

test('记忆区 DOM：回包未带上限时写入整组禁用、有如实说明，读取不受影响', async () => {
  unmount()
  mount({ capability: 'on' })
  await flush()
  assert.ok(memRootText().includes('未取得共享记忆的规格上限'), 'catalog 缺席必须如实说明')
  const write = memButtonByLabel('写入共享记忆')
  assert.ok(write, '写入按钮必须存在')
  assert.equal(write.disabled, true, '上限未取得时写入禁用')
  assert.equal(idInput().disabled, true, '上限未取得时输入框也禁用')
  const read = memButtonByLabel('读取')
  assert.ok(read, '读取按钮必须存在')
  assert.equal(read.disabled, false, '读取不需要上限，保持可用')
  assert.ok(!memRootText().includes('/4000'), '不得回退到硬编码 4000 展示')
})

// ── 回执抬头：契约 displayName + 轮次 + 未验证 + 结局分档（报告 §四 P2-6）────
// 这一组钉的是「不许合成一个笼统徽标」：未验证说的是内容可信度，结局分档说的是
// 这一轮怎么收的场，两件事各占一个徽标；能力名与轮次各占一行，不与结论混写。

test('回执抬头：能力名与轮次各自成行，「未验证」与结局分档是两个独立徽标', () => {
  assert.match(pane, /function ReceiptHeader\(/, '必须有共享的回执抬头组件')
  assert.match(pane, /<ReceiptHeader[\s\S]{0,240}?title="手机那端的回复"/, '回复块必须走共享抬头')
  assert.match(pane, /displayName=\{lane\.displayName\}/, '抬头必须带契约 displayName')
  assert.match(pane, /round=\{lane\.round\}/, '抬头必须带轮次')
  const header = sectionBetween('function ReceiptHeader', 'function askErrorText')
  assert.match(header, /未验证/, '抬头必须有未验证徽标')
  assert.match(header, /tier\.label/, '结局分档必须单独一个徽标，不与未验证共用')
  assert.match(header, /第 \$\{round\} 轮/, '抬头要显示轮次')
})

test('失败分档：被拒绝与失败各有独立标签，拒绝码取自车道的分档', () => {
  assert.match(pane, /const REJECTION_CODES = new Set\(\[/, '拒绝码清单必须显式列出')
  for (const code of ['requires_confirm', 'amoo_not_foreground', 'orphaned_ask', 'single_flight', 'refused']) {
    assert.ok(pane.includes(`'${code}'`), `拒绝码清单必须含 ${code}`)
  }
  assert.match(pane, /\{ label: '被拒绝', tone: 'warn' \}/, '被拒绝档标签')
  assert.match(pane, /\{ label: '失败', tone: 'bad' \}/, '失败档标签')
  assert.match(pane, /receiptTier\(lane\.state, lane\.error\?\.code\)/, '分档必须看车道给的错误码')
})

test('失败块：未验证徽标与结局分档徽标同时在场，不再只有一个笼统徽章', () => {
  const body = sectionBetween('function FailureBlock', 'function StopNoticeBlock')
  assert.match(body, /<ReceiptHeader/, '失败块必须走共享抬头（带头上的未验证徽标）')
  assert.match(body, /tier=\{tier\}/, '失败块必须带结局分档徽标')
  assert.match(body, /这一问是被手机侧当场拒绝的/, '被拒绝档要说清「没问成」与「问完才失败」的区别')
})

test('历史行：能力名、轮次、未验证与结局分档徽标齐备', () => {
  const body = sectionBetween('function HistoryEntryRow', 'function HistorySection')
  assert.match(body, /entry\.displayName/, '历史行必须显示契约 displayName')
  assert.match(body, /未验证/, '历史行必须带未验证徽标')
  assert.match(body, /tier\.label !== badge\.label/, '分档徽标只在补充分档时出现，不与结局徽标重复')
  assert.match(body, /第 \{entry\.rounds\} 轮/, '历史行必须带轮次')
})

test('能力名只有一个真源：车道读契约，面板只收回包，渲染层不碰磁盘', () => {
  const laneSrc = read('src/host/amooSecretary.ts')
  assert.match(laneSrc, /amooToolContract\.json/, '车道必须从工具契约取 displayName')
  assert.match(laneSrc, /loadToolDisplayNames/, '车道必须有契约读取器')
  assert.match(laneSrc, /roundDisplayName/, '车道必须有取名出口')
  assert.doesNotMatch(pane, /amooToolContract/, '渲染层不许自己读契约文件')
  assert.match(pane, /displayName\?: string/, '面板只声明回包里的 displayName 字段')
})

test('本车道不引用 amoo 车道的状态源：桌面只画自己车道的事', () => {
  for (const rel of [
    'src/host/amooSecretary.ts',
    'src/host/amooSecretaryLedger.ts',
    'src/renderer/components/amoon/AmooSecretaryPane.tsx',
  ]) {
    const src = read(rel)
    assert.ok(!src.includes('AmooStatusProvider'), `${rel} 不得引用 AmooStatusProvider`)
    assert.ok(!src.includes('amooPanelViewModel'), `${rel} 不得引用 amooPanelViewModel`)
    assert.ok(!src.includes('buildAmooPanelModel'), `${rel} 不得引用 amoo 车道的面板视图模型`)
  }
})
