# [DESIGN-DEP-001] 依赖管理规范

<!-- RULES-REGISTRY: PROCESS-013 -->

> 本文档定义 khy-os 项目的依赖管理标准，包括依赖选择、更新、安全审计等。

---

## 1. 依赖管理概述

### 1.1 管理原则

1. **最小化**：只添加必需的依赖
2. **安全性**：定期审计依赖安全
3. **稳定性**：优先选择稳定的版本
4. **可维护性**：避免过度依赖

### 1.2 依赖分类

| 分类 | 说明 | 位置 |
|------|------|------|
| dependencies | 运行时依赖 | package.json |
| devDependencies | 开发依赖 | package.json |
| peerDependencies | 对等依赖 | package.json |
| optionalDependencies | 可选依赖 | package.json |

---

## 2. 依赖选择标准

### 2.1 选择原则

| 标准 | 说明 |
|------|------|
| 活跃度 | 近期有更新，社区活跃 |
| 文档完善 | 有完整的文档和示例 |
| 许可证 | 使用兼容的开源许可证 |
| 体积 | 体积适中，无过度依赖 |
| 安全性 | 无已知安全漏洞 |

### 2.2 推荐依赖

| 类别 | 推荐依赖 |
|------|---------|
| 框架 | Vue 3, Express |
| 状态管理 | Pinia |
| UI 组件库 | Element Plus |
| HTTP 客户端 | Axios |
| 测试框架 | Jest, Vitest |
| 构建工具 | Vite, esbuild |

### 2.3 避免的依赖

- 已停止维护的依赖
- 体积过大的依赖
- 功能重复的依赖
- 安全记录差的依赖

---

## 3. 版本管理

### 3.1 版本锁定

**package-lock.json / pnpm-lock.yaml**：
- 提交到版本控制
- 确保团队成员使用相同版本
- CI/CD 使用锁定文件安装依赖

### 3.2 版本范围

| 范围 | 说明 | 示例 |
|------|------|------|
| 精确版本 | 锁定到特定版本 | `1.2.3` |
| 补丁范围 | 允许补丁更新 | `~1.2.3` |
| 次版本范围 | 允许次版本更新 | `^1.2.3` |

### 3.3 版本选择规则

| 依赖类型 | 版本范围 |
|---------|---------|
| 核心框架 | 精确版本或补丁范围 |
| UI 库 | 次版本范围 |
| 工具库 | 次版本范围 |
| 开发工具 | 次版本范围 |

---

## 4. 依赖更新

### 4.1 更新策略

| 类型 | 频率 | 说明 |
|------|------|------|
| 安全更新 | 立即 | 发现安全漏洞立即更新 |
| 补丁更新 | 每周 | bug 修复更新 |
| 次版本更新 | 每月 | 向后兼容的功能更新 |
| 主版本更新 | 按需 | 需要评估兼容性 |

### 4.2 Dependabot 配置

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 10
    labels:
      - "dependencies"
    reviewers:
      - "kodehu03"
```

### 4.3 更新流程

1. Dependabot 自动创建 PR
2. 审查变更内容
3. 运行测试验证
4. 合并更新
5. 监控部署状态

---

## 5. 安全审计

### 5.1 审计频率

| 类型 | 频率 |
|------|------|
| 自动扫描 | 每次 CI 运行 |
| 手动审计 | 每月 |
| 全面审计 | 每季度 |

### 5.2 审计命令

```bash
# 基本审计
npm audit

# 高级别漏洞
npm audit --audit-level=high

# 修复可自动修复的漏洞
npm audit fix

# 强制修复（可能包含破坏性变更）
npm audit fix --force
```

### 5.3 漏洞处理

| 严重级别 | 处理方式 |
|---------|---------|
| Critical | 立即修复 |
| High | 24 小时内修复 |
| Medium | 1 周内修复 |
| Low | 1 个月内修复 |

---

## 6. 体积控制

### 6.1 体积预算

| 项目 | 预算 |
|------|------|
| 前端主包 | < 200KB（gzip） |
| 前端总资源 | < 500KB（gzip） |
| 后端依赖 | < 100MB |

### 6.2 体积检查

```bash
# 检查依赖体积
npx cost-of-modules

# 分析 bundle 体积
npx vite-bundle-analyzer
```

### 6.3 体积优化

- 使用 tree-shaking
- 按需导入
- 移除未使用的依赖
- 使用更小的替代库

---

## 7. 许可证合规

### 7.1 允许的许可证

| 许可证 | 说明 |
|--------|------|
| MIT | ✅ 允许 |
| Apache-2.0 | ✅ 允许 |
| BSD-2/3-Clause | ✅ 允许 |
| ISC | ✅ 允许 |

### 7.2 禁止的许可证

| 许可证 | 说明 |
|--------|------|
| GPL-2.0/3.0 | ❌ 禁止（传染性） |
| AGPL-3.0 | ❌ 禁止（传染性） |
| 商业许可证 | ❌ 禁止（需购买） |

### 7.3 许可证检查

```bash
# 检查依赖许可证
npx license-checker --summary

# 生成许可证报告
npx license-checker --csv > licenses.csv
```

---

## 8. 工作区管理

### 8.1 pnpm workspace

```yaml
# pnpm-workspace.yaml
packages:
  - 'platform/packages/shared'
  - 'platform/packages/ui-shared'
  - 'services/backend'
  - 'services/ai-backend'
  - 'apps/ai-frontend'
  - 'software/khyquant/frontend'
```

### 8.2 共享依赖

| 依赖 | 版本 | 说明 |
|------|------|------|
| vue | ^3.4.0 | 所有前端项目共享 |
| pinia | ^2.1.0 | 所有前端项目共享 |
| axios | ^1.6.0 | 所有前端项目共享 |

### 8.3 依赖提升

```json
// .npmrc
hoist-pattern[]=*eslint*
hoist-pattern[]=*prettier*
hoist-pattern[]=typescript
```

---

## 9. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义依赖管理规范 |
| 1.1.0 | 2026-09-23 | 新增 §10 依赖来源：构建/交付只允许官方源，运行时镜像须显式 opt-in（`PROCESS-013`） |

## 10. 依赖来源（原生官方源）

> 规则 `PROCESS-013`；守卫 `scripts/ci/check-native-registry.js`
> （`npm run check:native-registry`）。

### 10.1 唯一允许的源

本仓库的**构建与交付**路径只允许从官方源获取依赖：

| 生态 | 唯一允许的源 | 禁止的写法 |
|------|-------------|-----------|
| Python | `pypi.org` | `pip install -i <镜像>` / `--index-url` / `--trusted-host` |
| Node | `registry.npmjs.org` | `.npmrc` 里的 `registry=<镜像>`、`npm config set registry <镜像>` |
| Debian / Ubuntu | `deb.debian.org` | 构建参数 `APT_MIRROR` 之类的注入开关 |
| Node 发行包 | `nodejs.org` | 镜像发行根（除非用户显式 opt-in，见 §10.3） |

### 10.2 四条机械判据

| 判据 | 管辖 | 强度 |
|------|------|------|
| C1 `non-native-registry` | Dockerfile / compose / `.npmrc` / CI workflow / 构建脚本 / **`package.json`** 里出现公共镜像主机 | 零容忍 |
| C2 `mirror-injection-knob` | 上述文件里出现 `*_MIRROR` 形态的注入开关 | 零容忍 |
| C3 `non-official-lockfile-resolution` | 锁文件的 `resolved` 解析到非官方 host | 零容忍 |
| C4 `ungated-runtime-mirror` | 运行时源码出现镜像主机，但同文件没有显式开关名 | 须补开关 |

C1/C2 是**零容忍**：开关本身就是「把镜像塞进构建」的口子，与是否设值无关。

**为什么 `package.json` 也在 C1 的判定面里**：它的 `scripts.*` 是构建入口，而
`build.electronDownload.mirror` 这类字段会把镜像钉进**构建期下载**。2026-09-23 独立审计实测：
`apps/khyos-desktop/package.json` 的 `build.electronDownload.mirror` 指向 `npmmirror.com`
且无任何开关门控 —— 守卫最初因 basename 集合不含 `package.json` 而**静默漏检**。
需要国内加速请在构建机设 `ELECTRON_MIRROR` 环境变量，而不是写进仓库。
C4 不是零容忍 —— 见 §10.3。

注释行一律不参与判定：注释不执行，且「解释为何删除镜像开关」的注释必然要提到
开关名，不排除注释会让守卫去报自己的说明文字。

### 10.3 为什么（不是洁癖）

构建期一旦走公共镜像，同一份 Dockerfile / 锁文件在**不同网络下会拉到不同 tarball**
（镜像同步延迟时甚至是旧版本），而构建照样成功。后果是：

1. **产物不可复现** —— 镜像内容取决于构建机所在网络，而没有任何既有守卫会报出来；
2. **不可审计** —— 出问题时无从判断某个包到底来自官方源还是镜像。

实测起点（2026-09-23）：`services/backend/Dockerfile` 有 3 处 `-i mirrors.aliyun.com`，
6 个 `package-lock.json` 共 3005 条 `resolved` 指向 `registry.npmmirror.com`，
另有两处运行时代码 **fail-open 到镜像**（`except` 分支默认 `china = True`）。

### 10.4 运行时：镜像须显式 opt-in

运行时的「国内加速」是**刻意保留**的能力（按需自愈装 `node-llama-cpp` 时国内直连
极易失败）。规范对它的要求不是删除，而是**不得默认生效**：

- 开关名：`KHY_USE_CN_MIRROR=1`（唯一真源 `platform/khy_platform/cn_mirror.py` 与
  `services/backend/src/constants/cnMirror.js`，两侧取值表须逐字对齐）；
- 禁止按 `LANG` / `LC_ALL` / `TZ` 猜测 —— 那会让「默认路径」取决于机器时区；
- 异常分支必须 **fail-closed 到官方源**，不得 `except: 用镜像`；
- 运行时要用镜像的文件里**必须出现开关名**（C4 的机械表达）。

### 10.5 边界（不属本规范管辖）

- **用户本机** `~/.npmrc` 指向镜像做网络加速 —— 那是用户环境，不是交付物；
- 构建机上的 `HTTP_PROXY` / Docker daemon 的 `registry-mirrors` / `ELECTRON_MIRROR`
  （electron-builder 的原生环境变量）—— 同上；
- GitHub 制品的 ghproxy 兜底（`KHY_KHYOS_PREFER_CN`）—— 那不是包 registry，
  且已是显式门控；
- 非配置语境里出现的镜像地址（如离线知识库正文）—— 按守卫的 `EXEMPT` 登记豁免，
  每条须带理由与复核到期日，可用 `npm run check:native-registry:list` 查看。

### 10.6 怎么改

```bash
npm run check:native-registry          # 全量读数
npm run check:native-registry:changed  # commit 快档（只看暂存集）
npm run check:native-registry:list     # 豁免清单
npm run test:native-registry           # 反例矩阵（含「关掉守卫会变红」断言）
```

需要加速时：在本机 `~/.npmrc` 配镜像，或给 `docker build` 传代理，
而不是把镜像地址写进仓库文件。

---

*本规范由 khy-os 平台团队维护*