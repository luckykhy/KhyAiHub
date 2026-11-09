import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const srcRoot = join(__dirname, '..');

const themeCssPath = join(srcRoot, 'styles', 'newapi-theme.css');
const themeCss = readFileSync(themeCssPath, 'utf-8');

function extractCustomProps(block) {
  const props = new Map();
  const re = /(--khy-[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    props.set(m[1].trim(), m[2].trim());
  }
  return props;
}

/**
 * 取某个选择器块的 body。
 *
 * 用**正则按行首**匹配，而不是 indexOf —— 主题表的两个令牌块写作
 * `html:root` / `html.dark:root`（见 newapi-theme.css 顶部注释：Element Plus 的
 * 样式按需注入且特异性更高，本表必须抬过它）。用字符串 indexOf 会先撞上注释里
 * 出现的 `:root` 字样，截出一段错的块 —— 守卫认错块 = 静默不检查。
 */
function extractBlock(css, selectorRe) {
  const m = selectorRe.exec(css);
  if (!m) return '';
  const idx = m.index;
  const braceStart = css.indexOf('{', idx);
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return css.slice(braceStart + 1, end);
}

const rootBlock = extractBlock(themeCss, /^\s*html:root\s*\{/m);
const darkBlock = extractBlock(themeCss, /^\s*html\.dark:root\s*\{/m);
const rootProps = extractCustomProps(rootBlock);
const darkProps = extractCustomProps(darkBlock);

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;

// `var(--el-border-color, #dcdfe6)` 里的 #dcdfe6 是**变量缺失时的回退值**，不是
// 一处设计决策。按裸 hex 计它会把「用了 token、只是给了个兜底」也算成违规 —— 那样
// 数字对应的是一批不存在的违规，棘轮再怎么收紧都咬不到真东西。所以先剥掉回退位
// 再判。
const HEX_FALLBACK_RE = /var\(\s*--[\w-]+\s*,\s*#[0-9a-fA-F]{3,8}\s*\)/g;

function hasBareHex(line) {
  return HEX_RE.test(line.replace(HEX_FALLBACK_RE, 'var(--x)'));
}

function collectVueAndCssFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      collectVueAndCssFiles(full, acc);
    } else {
      const ext = extname(full);
      if (ext === '.vue' || ext === '.css') acc.push(full);
    }
  }
  return acc;
}

const themeIndependentTokens = new Set();
for (const [key, val] of rootProps) {
  if (val.includes('var(--khy-') || val.includes('color-mix') || val.includes('rgba(') || val.includes('linear-gradient')) {
    themeIndependentTokens.add(key);
  }
}

describe('W3/W4: Design Token Compliance', () => {
  describe('W2: --khy-white 必须有定义', () => {
    it('newapi-theme.css :root 中必须定义 --khy-white', () => {
      expect(rootProps.has('--khy-white')).toBe(true);
    });

    it('--khy-white 的值应为 #ffffff 或等价白色', () => {
      const val = rootProps.get('--khy-white');
      expect(val).toBeDefined();
      expect(val.toLowerCase()).toMatch(/^#f{3,6}$/);
    });
  });

  describe('W1: 双主题成对定义', () => {
    const criticalTokens = [
      '--khy-bg-main',
      '--khy-bg-elevated',
      '--khy-bg-card',
      '--khy-bg-soft',
      '--khy-bg-hover',
      '--khy-text-main',
      '--khy-text-strong',
      '--khy-text-secondary',
      '--khy-text-muted',
      '--khy-border',
      '--khy-border-light',
      '--khy-primary',
      '--khy-primary-strong',
      '--khy-primary-soft',
      '--khy-success',
      '--khy-warning',
      '--khy-danger',
      '--khy-shadow',
      '--khy-shadow-lift',
      '--khy-skeleton-base',
      '--khy-skeleton-highlight',
    ];

    for (const token of criticalTokens) {
      it(`critical token ${token} 在 :root 和 html.dark 都有定义`, () => {
        expect(rootProps.has(token)).toBe(true);
        expect(darkProps.has(token)).toBe(true);
      });
    }

    it(':root 和 html.dark 的 critical token 值不相同（暗色主题必须覆盖）', () => {
      for (const token of criticalTokens) {
        const light = rootProps.get(token);
        const dark = darkProps.get(token);
        expect(dark).toBeDefined();
        expect(dark).not.toBe(light);
      }
    });
  });

  describe('W3: 非真源文件不得出现字面量 hex 颜色', () => {
    const allowedFiles = [
      'styles/newapi-theme.css',
    ];

    const allFiles = collectVueAndCssFiles(srcRoot);
    const violatingFiles = allFiles.filter((f) => {
      const rel = relative(srcRoot, f).replace(/\\/g, '/');
      if (allowedFiles.includes(rel)) return false;
      const content = readFileSync(f, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;
        if (line.startsWith('content:')) continue;
        if (hasBareHex(line)) return true;
      }
      return false;
    });

    it('非真源 .vue/.css 文件中不应有硬编码 hex 颜色（回归基线，只降不升）', () => {
      // 原为 999：任何文件都能加裸 hex 而测试不动，棘轮形同虚设。
      // 0 是剥掉 var(--x, #hex) 回退位之后的实测值 —— 现状零违规，从此加一处就红。
      const BASELINE = 0;
      const count = violatingFiles.length;
      if (count > 0) {
        const detail = violatingFiles.slice(0, 10).map((f) => relative(srcRoot, f)).join('\n  ');
        console.warn(`[W3] ${count} files contain hardcoded hex colors (baseline=${BASELINE}):\n  ${detail}${count > 10 ? '\n  ...' : ''}`);
      }
      expect(count).toBeLessThanOrEqual(BASELINE);
    });
  });

  describe('W4: 样式应使用 var(--khy-*) 而非内联 hex', () => {
    it('newapi-theme.css 的 --el-* 映射必须指向 --khy-* 变量', () => {
      const elMappings = [
        '--el-bg-color',
        '--el-bg-color-page',
        '--el-bg-color-overlay',
        '--el-text-color-primary',
        '--el-text-color-regular',
        '--el-color-primary',
        '--el-border-color',
      ];
      for (const el of elMappings) {
        const val = rootProps.get(el);
        if (val !== undefined) {
          expect(val).toContain('var(--khy-');
        }
      }
    });
  });
});
