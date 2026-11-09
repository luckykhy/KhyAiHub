/**
 * Router 懒加载契约（khyquant 前端）。
 *
 * 这个前端**已经剥好了**（与 ai-frontend 同型，见
 * docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-197] §6.7 的 visual.peeledSurfaces）：
 * 路由全部 `component: () => import(...)`，首屏冷闭包只有 1 文件 / 211 行。
 *
 * 但「剥好了」若无契约保护，下一次有人图省事把某个 `import()` 改回静态 import，
 * 首屏就会静默变重 —— **没有任何报错**。这正是 ai-frontend 早就补上的
 * `src/router/nav.wiring.test.js` 在防的那类静默失效。
 *
 * 本测试断言三件事（源码级 —— Vue 与 `@/` 别名在纯 Node 环境下不能直接 import，
 * 这与 ai-frontend 的做法一致）：
 *   1. router/index.js 里**每个** route 的 component 都是动态 import（没有静态 import 逃逸）；
 *   2. 每个动态 import 指向的 view 文件**真实存在**（路径没写错导致运行时空 chunk）；
 *   3. 动态 import 的目标都落在 `src/views/` 下（不把组件随手放进 views 造成约定漂移）。
 *
 * 零依赖 —— 跑法：npx vitest run src/__tests__/routerLazyLoad.contract.test.js
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..'); // delivery/channel/khyquant/frontend/src

function read(rel) {
  return readFileSync(join(appRoot, rel), 'utf8');
}

const routerSrc = read('router/index.js');

// 路由里所有 component: () => import('...') 的目标
const dynamicImports = [...routerSrc.matchAll(/component:\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
  (m) => m[1]
);

// 路由里所有**静态** component 引用（component: SomeImportedComponent）
const staticComponents = [...routerSrc.matchAll(/component:\s*([A-Za-z_$][\w$]*)\s*[,}]/g)].map((m) => m[1]);

// 顶层静态 import 的目标（这些会被首屏 bundle 收进去）
const topLevelImports = [...routerSrc.matchAll(/^import\s+[^'";]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

test('每个路由的 component 都是动态 import（无静态 component 逃逸）', () => {
  assert.ok(dynamicImports.length >= 10, `router 应有多条懒加载路由，实测 ${dynamicImports.length} 条`);
  assert.deepEqual(
    staticComponents,
    [],
    `这些路由用了静态 component（会进首屏 bundle），应改为 () => import(...): ${staticComponents.join(', ')}`
  );
});

test('每个动态 import 的 view 文件真实存在', () => {
  const missing = [];
  for (const spec of dynamicImports) {
    // '@/' 是 src/ 别名
    const rel = spec.startsWith('@/') ? spec.slice(2) : spec.replace(/^\.\.\//, '');
    const candidates = [join(appRoot, rel), join(appRoot, rel + '.vue'), join(appRoot, rel + '.js')];
    if (!candidates.some((c) => existsSync(c))) missing.push(spec);
  }
  assert.deepEqual(missing, [], `这些动态 import 指向不存在的文件（运行时会空 chunk）: ${missing.join(', ')}`);
});

test('动态 import 的目标都落在 src/views/ 下', () => {
  const offConvention = dynamicImports.filter((s) => !s.startsWith('@/views/'));
  assert.deepEqual(
    offConvention,
    [],
    `懒加载目标应统一放在 @/views/ 下（路由视图目录约定）: ${offConvention.join(', ')}`
  );
});

test('router/index.js 顶层没有把 view 静态 import 进来', () => {
  // 顶层 import 若指向 views/，说明某个页面被静态拉进首屏 bundle
  const staticViewImports = topLevelImports.filter((s) => s.startsWith('@/views/'));
  assert.deepEqual(
    staticViewImports,
    [],
    `这些 view 被顶层静态 import（会进首屏 bundle），应只在路由里用 () => import(...): ${staticViewImports.join(', ')}`
  );
});
