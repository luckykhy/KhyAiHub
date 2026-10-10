# [DESIGN-NAM-001] 统一命名规范

<!-- RULES-REGISTRY: NAM-001 -->

> **用途**：定义 khy-os 全栈代码的统一命名标准，覆盖 JavaScript、Python、SQL、CSS、配置文件等所有语言。
> AGENTS.md 只给了一句 "camelCase（JS）、snake_case（Python）"，本文档补全全量细节与例外。

---

## 1. 命名原则

1. **可读优先**：名称应自解释，不依赖注释说明意图
2. **一致性**：同一域内必须使用同一种风格
3. **领域词优先**：用业务域术语（`strategy` 而非 `config`，`broker` 而非 `client`）
4. **长度适中**：短命名用于窄域（循环变量），长命名用于宽域（模块/类名）
5. **避免歧义**：不用 `data`、`info`、`handle`、`manager` 等无意义词

---

## 2. JavaScript / Node.js 命名

### 2.1 基础规则

| 类型 | 风格 | 示例 |
|------|------|------|
| 变量 / 函数 / 参数 | `camelCase` | `userProfile`、`getUserById()`、`maxRetries` |
| 常量（模块级） | `SCREAMING_SNAKE_CASE` | `MAX_RETRY_COUNT`、`DEFAULT_TIMEOUT_MS` |
| 对象键 | `camelCase` | `{ userId, createdAt }` |
| 文件路径（目录） | `camelCase` | `gateway/`、`aiChatPort.js` |
| 文件名（JS 模块） | `camelCase` | `aiGateway.js`、`rateLimit.js` |
| 类名 | `PascalCase` | `KhyError`、`TokenUsageService` |
| 私有属性 | `#camelCase`（# 前缀） | `#cachedResult` |
| 枚举值 | `SCREAMING_SNAKE_CASE` | `STATUS_ACTIVE`、`ROLE_ADMIN` |

### 2.2 模块导出命名

**默认导出**：仅限单一实体，名称与文件名 camelCase 对齐：
```javascript
// aiGateway.js — 模块级唯一重要实体
module.exports = { AI_GATEWAY_DEFAULTS, createAIGateway };
```

**具名导出**：优先于默认导出，便于 tree-shaking：
```javascript
export { validateInput, sanitizeOutput };
```

### 2.3 Express 中间件命名

```javascript
// 中间件函数名：动词 + 职责
const requireAuth = (req, res, next) => { ... };
const validateRequestBody = (schema) => (req, res, next) => { ... };
const logApiPerformance = (req, res, next) => { ... };
```

---

## 3. Python 命名

### 3.1 基础规则

| 类型 | 风格 | 示例 |
|------|------|------|
| 模块名 | `snake_case` | `cli_parser.py`、`version_sync.py` |
| 类名 | `PascalCase` | `KhyPlatform`、`TokenUsageTracker` |
| 函数名 | `snake_case` | `get_user_by_id()`、`parse_config()` |
| 变量名 | `snake_case` | `user_profile`、`max_retries` |
| 常量 | `UPPER_SNAKE_CASE` | `MAX_CONNECTIONS`、`DEFAULT_TIMEOUT` |
| 私有属性/方法 | `_camelCase`（_ 前缀） | `_cached_result` |
| 包名 | `snake_case` | `khy_platform`、`ai_backend` |

### 3.2 函数名动词前缀

| 前缀 | 含义 | 示例 |
|------|------|------|
| `get_` | 获取（不改变状态） | `get_user_profile()` |
| `set_` | 设置（改变状态） | `set_log_level()` |
| `is_` / `has_` | 布尔判断 | `is_valid_token()`、`has_permission()` |
| `fetch_` | 异步获取 | `fetch_model_list()` |
| `validate_` | 验证 | `validate_config()` |
| `sanitize_` | 清理/脱敏 | `sanitize_path()` |

---

## 4. SQL / 数据库命名

### 4.1 已有规范（DESIGN-DB-001 §2）

| 对象 | 风格 | 示例 |
|------|------|------|
| 表名 | `snake_case` 复数 | `users`、`trading_strategies`、`api_keys` |
| 列名 | `snake_case` | `user_id`、`created_at`、`is_active` |
| 外键 | `{表名单数}_id` | `user_id`、`strategy_id` |
| 索引名 | `idx_{表名}_{列名}` | `idx_users_email` |
| 唯一约束 | `uq_{表名}_{列名}` | `uq_users_email` |

### 4.2 Sequelize Model 类名映射

**规则**：模型类名用 PascalCase，映射到 snake_case 复数表名（Sequelize 默认即可）：

```javascript
// models/User.js → 自动映射表名 users
class User extends Model { }
User.init({ ... }, { tableName: 'users' }); // 显式指定可读性更好
```

---

## 5. CSS 命名

### 5.1 BEM 规范（khy-os 事实标准）

```
.block__element--modifier
```

| 部分 | 风格 | 示例 |
|------|------|------|
| Block | `kebab-case` | `.khy-card`、`.login-form` |
| Element | 双下划线 + `kebab-case` | `.khy-card__header`、`.login-form__input` |
| Modifier | 双连字符 + `kebab-case` | `.khy-card--elevated`、`.btn--primary` |
| 状态 | `.is-{state}` / `.has-{state}` | `.is-loading`、`.is-error`、`.has-value` |
| 工具类 | 功能描述 + 参数 | `.mt-16`、`.text-center`、`.flex-gap-8` |

### 5.2 khy-os 特定约定

- 组件级样式：`scoped` + BEM，类名以 `c-` 前缀（component）
- 布局级样式：类名以 `l-` 前缀（layout）
- 工具类：`u-` 前缀（utility）
- 主题令牌：全部走 `var(--khy-*)`，不在 CSS 中硬编码值

```css
/* 组件 */
.c-login-form__input { }
.c-login-form__input--error { }

/* 布局 */
.l-page-header { }

/* 工具 */
.u-sr-only { }  /* screen reader only */
```

---

## 6. Vue 组件命名

### 6.1 单文件组件文件名

```text
PascalCase.vue    — 组件文件（自动注册或显式 import）
```

```bash
KhyPageHeader.vue
MobileNav.vue
AgentDashboard.vue
```

### 6.2 组件内命名

```vue
<script setup>
// 组件名：PascalCase
const props = defineProps({
  userName: String,        // camelCase
  isActive: Boolean        // camelCase + is 前缀（布尔）
})
const emit = defineEmits(['update:modelValue', 'close'])  // camelCase
</script>
```

### 6.3 Composables

```text
use{Feature}.js   — camelCase，use 前缀
```

```javascript
// useTheme.js、useProjects.js、useGateway.js
export function useTheme() { }
export function useGateway() { }
```

---

## 7. 环境变量命名

### 7.1 前缀规则

| 范围 | 前缀 | 示例 |
|------|------|------|
| 项目级 | `KHY_` | `KHY_DATA_HOME`、`KHY_CC_TUI` |
| 服务级 | `{SERVICE}_` | `AI_BACKEND_PORT`、`DAEMON_PORT` |
| 功能开关 | `FEATURE_` | `FEATURE_ENABLE_TUI` |
| 前端 Vite | `VITE_` | `VITE_AI_API_BASE_URL` |

### 7.2 风格

```text
SCREAMING_SNAKE_CASE，单词间下划线分隔
```

```bash
KHY_DATA_HOME=~/.khy
VITE_AI_HTTP_TIMEOUT_MS=30000
FEATURE_ENABLE_REPL=true
```

---

## 8. Git 标签命名

### 8.1 格式

```text
v{major}.{minor}.{patch}[-{prerelease}][+{buildmetadata}]
```

| 场景 | 示例 |
|------|------|
| 正式版 | `v1.2.3` |
| 预发布 | `v1.3.0-beta.1`、`v2.0.0-rc.2` |
| 构建元数据 | `v1.2.3+build.20260910` |

### 8.2 约束

- 仅用于发布，禁止用标签标记日常开发
- 标签与 `package.json` / `pyproject.toml` 的 `version` 完全一致
- `scripts/ci/check-version-sync.js` 在 CI 中校验

---

## 9. npm 包命名

| 类型 | 风格 | 示例 |
|------|------|------|
| 公开包 | `@khy-os/{name}` | `@khy-os/khy-os`、`@khy-os/ui-shared` |
| 内部包 | `@khy/{name}` | `@khy/shared`、`@khy/platform` |
| 作用域包 | 全小写 | 避免 `@Khy/` |

### 9.1 远端仓库名（2026-10-10 补，原为规则盲区）

**先说清这一节为什么存在**：本节补立之前，仓名**不在任何规则管辖内**——§9 只管 npm 包名，
仓外 Portable 规约只管本地目录名。2026-10-10 建 KhyAiHub 时没有判据可查，遂在几轮问答里
现编，编出 PascalCase，与账号下 8 个 kebab-case 仓不一致。**规则盲区比规则错误更贵**：
后者会被守卫抓住，前者只能靠人事后发现。

**现状实测（2026-10-10，GitHub `luckykhy` 共 13 仓）**：

| 风格 | 数量 | 仓 |
|---|---|---|
| kebab-case | 8 | my-tools、knowledge-base、portable-workstation、klode-portable、opkode-portable、web-track-guide、khy-os-hq、qoder-creator |
| 单词（无分隔） | 3 | gongkao、tidepool、khyquant |
| snake_case | 1 | khy_os_private |
| PascalCase | 1 | **KhyAiHub** |

**现行约定（以 KhyAiHub 为既定事实，不回溯改名）**：

1. **`KhyAiHub` 保持现名，不改名。已裁定，不再重开。**
   2026-10-10 跨六轮定名：`khyos`（说不清是什么）→ 加「智能体」（中英混排、且产品是平台不是单体智能体）
   → 去中文（编码易乱码）→ 去连字符 → 定驼峰 → **`KhyAiHub`**。
   同轮评估过并被人否掉的候选：`khy-ai-hub`（风格合规但功能指向依旧泛）、
   `KhyAiHost`（产品自用词，但 host 也能指虚拟主机）、`KhyAiGateway`（架构准确但像开发设施）、
   `KhyOneAi`（最直白但丢技术辨识度）。
   **后续 AI 不得在没有人提供新信息的情况下再次提议改名**——这条已裁定，重复提问是把
   软偏好（风格统一）当成硬约束反复重开。
2. 新建仓默认跟随主流 kebab-case（8/13），除非有上条同类理由并被人点头。
3. **「与其它仓不一致」本身不是改名理由。** 一致性是软偏好，功能指向与既定选择是硬约束。
   真要统一，正确做法是问人「是否全部改成某一种」，而不是挑一个仓下手。

> ⚠ 已知未决（记录在案，不阻塞）：产品名 `khy-os` 含「OS」，但 README 明言它**不是**
> 传统发行版意义上的操作系统，软著登记名「基于执行轨迹记录与链路校验技术的AI助手平台」
> 也不含 OS。即仓名继承了一个产品自己都不认的词。改动它涉及 PyPI/npm 包名、README、
> 软著材料，是产品级决定，**须单独立项并获人点头**，不搭车任何一次仓库整理。

> ⚠ 一条被否掉的论证：曾有「连字符不符合类名规范所以不能用」之说。**不适用于仓名**——
> GitHub 仓名不是代码标识符，不出现在任何 `import` / `class` / 变量声明里。
> 该论证对 `sync-dist.js` 里的**常量名**成立，对仓名不成立。本次按人的选择保留
> PascalCase，但把理由钉在「人明确要求」上，不钉在那个不适用的论证上。

---

## 10. 文件名规范

### 10.1 目录名

| 类型 | 风格 | 示例 |
|------|------|------|
| JS/TS 目录 | `camelCase` | `gateway/`、`aiGateway/` |
| Python 目录 | `snake_case` | `cli_parser/`、`model_training/` |
| 测试目录 | `__tests__/` 或 `tests/` | — |

### 10.2 测试文件

```text
{sourceFile}.test.js    — 同目录
tests/{module}/         — 独立测试目录
```

---

## 11. 禁止清单

| 禁止 | 原因 | 正确做法 |
|------|------|---------|
| 中英混写 | `get用户信息` | `getUserInfo()` |
| 缩写无共识 | `usr`、`cfg` | `user`、`config` |
| 用类型前缀 | `strName`、`objData` | `name`、`data`（类型由 IDE 感知） |
| 魔法字符串直接硬编码 | `'user'` 散落各处 | 常量 `ROLE_USER` |
| CSS 类名 PascalCase | `.KhyButton` | `.khy-button`（BEM） |

---

## 12. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义全栈统一命名规范 |

---

*本规范由 khy-os 平台团队维护*
