/**
 * EcoMarkets 视图 ↔ 数据契约 wiring 断言（源级，vitest）。
 *
 *   npx vitest run src/views/EcoMarkets.wiring.test.js
 *
 * 视图 import Vue 与 @ 别名，前端测试基建又没有 @vue/test-utils / jsdom，
 * 挂载不了组件 —— 沿用 useProxies.egress.wiring.test.js 与 nav.wiring.test.js
 * 的 readFileSync + 正则源级断言法，把「一个页面多个 tab、每 tab 一个独立市场」
 * 的契约钉在源码上。这些断言守的是那种改坏了不报错、只是页面悄悄少一块的回归。
 *
 * 契约（四条，缺一条页面就退化）：
 *   1. tab 列表由 GET /api/eco-markets 驱动（v-for="m in markets"），不硬编码
 *      市场名 —— 加一个 catalog 文件就多一个 tab，无需改前端。
 *   2. 视图源码不含六个生态 id 字面量、不含 'catalogs/' —— 生态清单是数据不是
 *      代码；出现字面量就说明某个 tab 被写死，新生态上不了页面。
 *   3. 每个 tab 的每一栏都取自 v-for 变量 m.*，没有跨 tab 共享的计算属性 ——
 *      共享一处就等于六个市场数据互串。
 *   4. vite.config.js 的 DAEMON_ONLY_NAMESPACES 含 '/api/eco-markets' ——
 *      不在名单里就被 '/api' 兜底转给 web 后端，dev 下得 404「接口不存在」，
 *      而页面会把这个代理配置 bug 显示成「后端没有这个接口（版本不匹配）」。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const VIEW = readFileSync(join(here, 'EcoMarkets.vue'), 'utf8');
const COMPOSABLE = readFileSync(join(here, '../composables/useEcoMarkets.js'), 'utf8');
const VITE_CONFIG = readFileSync(join(here, '../../vite.config.js'), 'utf8');

// index.json 的六个生态（delivery/market/catalogs/*.json）。逐个在视图里找。
const ECO_IDS = ['zcode', 'claude-code', 'opencode', 'mcode', 'deepseek-harness', 'aggregators'];

// 视图里由 v-for="m in markets" 直接取用的栏位。任何一处改成跨 tab 的
// computed / 模块级变量，这里就必须跟着改 —— 那正是要拦住的事。
const PER_TAB_FIELDS = ['entries', 'blocked', 'marketplaces', 'uncertainties'];

test('tab 列表由 v-for="m in markets" 驱动，不硬编码市场名', () => {
  assert.match(VIEW, /<el-tabs v-if="markets\.length" v-model="activeTab">/);
  assert.match(VIEW, /<el-tab-pane v-for="m in markets" :key="m\.eco"/);
  assert.match(VIEW, /:label="m\.title \|\| m\.eco"/);
  assert.match(VIEW, /:name="m\.eco"/);

  // tab 数据只能来自 composable 的 markets ref，且由一次 GET 拉全量清单。
  // 显式刷新会带 { params: { refresh: 1 } }，所以这里只钉端点，不钉调用括号。
  assert.match(COMPOSABLE, /request\.get\('\/api\/eco-markets'(?:\s*,|\))/);
  assert.match(VIEW, /onMounted\(loadMarkets\)/);
  // 不该有第二个请求端点：单市场是纯客户端按 eco 查找的。
  assert.doesNotMatch(COMPOSABLE, /request\.get\('\/api\/eco-markets\//);
  // 任何 el-tab-pane 都不许手写（少了 v-for 就是写死的 tab）。
  const handWritten = VIEW.match(/<el-tab-pane(?![^>]*v-for)/g) || [];
  assert.deepEqual(handWritten, [], 'el-tab-pane 必须全部由 v-for 生成');
});

test('视图不含六个生态 id 字面量，也不含 catalogs/ 路径', () => {
  for (const eco of ECO_IDS) {
    assert.ok(
      !VIEW.includes(eco),
      `视图里出现了生态 id 字面量「${eco}」：生态清单是数据不是代码，` +
        '这个 tab 会被写死，新增 catalog 文件也上不了页面'
    );
  }
  assert.ok(!VIEW.includes('catalogs/'), '视图不该知道编目文件路径');
  // composable 同样只认接口，不认编目目录结构。
  assert.ok(!COMPOSABLE.includes('catalogs/'));
  for (const eco of ECO_IDS) {
    assert.ok(!COMPOSABLE.includes(eco), `composable 里出现了生态 id 字面量「${eco}」`);
  }
});

test('每栏数据取自 v-for 变量 m.*，没有跨 tab 共享的计算属性', () => {
  for (const field of PER_TAB_FIELDS) {
    assert.ok(
      VIEW.includes(`m.${field}`),
      `栏位 ${field} 未从 v-for 变量 m 取值 —— 共享一处即六个市场数据互串`
    );
  }
  // 共享的计算属性会把 A 生态的条目渲染到 B 生态的 tab 里。
  assert.doesNotMatch(VIEW, /const\s+\w+\s*=\s*computed\(/, '视图不得引入跨 tab 的 computed');
  // keep-alive 页需要 onActivated/onDeactivated 管轮询生命周期，只钉必需项。
  assert.match(VIEW, /import \{[^}]*\bonMounted\b[^}]*\bref\b[^}]*\bwatch\b[^}]*\} from 'vue';/);

  // 列表绑定与展开行都走 row（tab 内的行变量），不跨 tab 取数。
  assert.match(VIEW, /:data="m\.entries"/);
  assert.match(VIEW, /:data="m\.blocked"/);
  assert.match(VIEW, /v-for="s in m\.marketplaces"/);
  assert.match(VIEW, /v-for="\(u, i\) in m\.uncertainties"/);

  // 计数一律由该 tab 自己的数组长度现算。
  assert.match(VIEW, /条目 \{\{ m\.entries\.length \}\}/);
  assert.match(VIEW, /阻塞 \{\{ m\.blocked\.length \}\}/);
  assert.match(VIEW, /市场源\s*\{\{ m\.marketplaces\.length \}\}/);

  // 四个列表槽位在 composable 侧逐个兜底成数组，视图才敢直接 .length。
  for (const field of PER_TAB_FIELDS) {
    assert.match(COMPOSABLE, new RegExp(`${field}: asArray\\(market\\.${field}\\)`));
  }
});

test('残留风险块按字符串渲染：uncertainties 是字符串数组', () => {
  // 后端把 uncertainties 归一化成字符串（真实编目 36 条全是 string），视图按
  // `{{ u }}` 插值。写成对象会让这里渲染出 [object Object]，写成 v-if 恒假则
  // 整块消失 —— 两种都靠这两行 + 服务层测试共同守住。
  assert.match(VIEW, /v-if="m\.uncertainties\.length"/);
  assert.match(VIEW, /<li v-for="\(u, i\) in m\.uncertainties" :key="i">\{\{ u \}\}<\/li>/);
  assert.match(VIEW, /<h4 class="eco-block__title">残留风险<\/h4>/);
});

test('实时同步契约：快照新鲜度、来源状态与自动轮询三环齐全', () => {
  // 后端 /api/eco-markets 是非阻塞 SWR：响应带 refreshing，实时数据在下一次
  // 轮询换入。视图必须消费这些字段，否则「实时」只是文案——用户看到的可能
  // 是几分钟前的静态编目，与桌面端/终端读数不一致且无从察觉。
  for (const field of ['fetchedAt', 'refreshing', 'refreshStartedAt', 'refreshError', 'sources', 'totals']) {
    assert.match(COMPOSABLE, new RegExp(`\\b${field}\\b`), `composable 未消费 ${field}`);
  }
  assert.match(
    COMPOSABLE,
    /request\.get\('\/api\/eco-markets', refresh \? \{ params: \{ refresh: 1 \} \} : undefined\)/
  );
  // 页面隐藏时暂停轮询：后台 tab 不该持续打守护进程。
  assert.match(COMPOSABLE, /visibilityState === 'hidden'/);

  // 来源状态标签必须是显式映射：未知状态原样显示，不许静默当作成功。
  assert.match(VIEW, /const SOURCE_TAGS = \{/);
  for (const status of ['ok', 'stale', 'error', 'pending']) {
    assert.match(VIEW, new RegExp(`${status}: \\{ text:`));
  }
  assert.match(VIEW, /:type="sourceTag\(s\)\.type"/);
  assert.match(VIEW, /更新于 \$\{fmtTime\(fetchedAt\)\}/);
  assert.match(VIEW, /onMounted\(startAutoRefresh\)/);
  assert.match(VIEW, /onBeforeUnmount\(stopAutoRefresh\)/);
  // 刷新按钮要报进度（动作+目标+进度），不能只转圈；后台刷新期间服务端返回的
  // 仍是旧来源状态，所以没有 pending 时必须说明「保持当前快照」而不是假装 0/N。
  assert.match(VIEW, /\{\{ refreshing \? refreshLabel\(\) : '刷新实时数据' \}\}/);
  assert.match(VIEW, /return `拉取中 \$\{pending\} \/ \$\{sources\.value\.length\}`/);
  assert.match(VIEW, /保持当前快照/);
});

test('vite.config.js 的 DAEMON_ONLY_NAMESPACES 含 /api/eco-markets', () => {
  const start = VITE_CONFIG.indexOf('const DAEMON_ONLY_NAMESPACES = [');
  assert.ok(start !== -1, 'DAEMON_ONLY_NAMESPACES 数组不存在');
  const body = VITE_CONFIG.slice(start, VITE_CONFIG.indexOf(']', start));
  assert.ok(
    body.includes(`'/api/eco-markets'`),
    "'/api/eco-markets' 不在 DAEMON_ONLY_NAMESPACES 里：dev 下请求会落进 '/api' " +
      '兜底被转给 web 后端得 404，页面把代理配置 bug 误报成「版本不匹配」'
  );
  // 兜底规则必须在名单之后注册（Vite 按注册顺序匹配代理）。
  const catchAll = VITE_CONFIG.indexOf("'/api': {", start);
  assert.ok(catchAll > start, "'/api' 兜底必须注册在 DAEMON_ONLY_NAMESPACES 之后");
});

test('侧栏入口与插件市场不共用图标', () => {
  // 生态市场用 ShoppingBag；「提示词库」是 Collection、「插件市场」是 Shop。
  const NAV = readFileSync(join(here, '../nav/index.js'), 'utf8');
  const at = NAV.indexOf("path: '/eco-markets'");
  assert.ok(at !== -1, 'NAV 里没有 /eco-markets 条目');
  const item = NAV.slice(at, NAV.indexOf('},', at));
  assert.match(item, /icon: ShoppingBag,/, '生态市场必须用 ShoppingBag');
  assert.doesNotMatch(item, /icon: Collection,/, '不得复用「提示词库」的 Collection');
  assert.doesNotMatch(item, /icon: Shop,/, '不得复用「插件市场」的 Shop');
  const promptsAt = NAV.indexOf("path: '/prompts'");
  assert.match(NAV.slice(promptsAt, NAV.indexOf('},', promptsAt)), /icon: Collection,/);
});
