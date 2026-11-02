# syntax=docker/dockerfile:1
#
# runtime/node/ai-backend/Dockerfile — AI 后端镜像（`docker compose --profile ai`）
#
# ── 为什么这份 Dockerfile 在 2026-11-02 被重写 ────────────────────────────────
#
# 旧版**根本构建不出来**：所有 COPY 路径都是 2026 年 forest layout 迁移前的形状
#   （`platform/packages/shared` / `services/ai-backend/`），实测这四个前缀
#   在仓库里均已不存在。也就是说 `docker compose --profile ai up --build`
#   一向是当场失败，而不是「能构建但体积大」。
#
# 三处修正：
#
# 1) **路径对齐新布局**：`runtime/substrate/platform/packages/shared`、
#    `runtime/node/ai-backend`。同时把安装器从「npm + 手改 package.json + 删锁文件」
#    换成 pnpm workspace + `--frozen-lockfile`，与根 Dockerfile、ai-frontend
#    Dockerfile 同一套纪律。旧版 `rm -f package-lock.json` 后 `npm install`
#    不读任何锁文件，同一份 Dockerfile 在不同日子构建会拿到不同版本 —— 不可复现。
#
# 2) **删掉 build-essential + python3-dev（约 250–350 MB）。**
#    它们只为编译 better-sqlite3 而装，而 better-sqlite3 在整个 ai-backend
#    闭包里**不存在**：package.json 的 dependencies 11 项 + @khy/shared 的 9 项
#    全是纯 JS（pg / redis / sequelize / bcryptjs / winston 均无原生绑定），
#    pnpm-lock.yaml 的 importer 段可逐条核对。grep 全目录，better-sqlite3
#    只出现在旧 Dockerfile 自己的注释里。
#    **但 python3 保留**：src/utils/pythonPath.js 运行时按
#    `/usr/local/bin/python3` → `/usr/bin/python3` 解析，src/scripts/
#    fetch_akshare_news.py 要被 exec。删 python3 会让资讯拉取静默失败。
#
# 3) **基础镜像 node:20-slim → node:22-slim。** Node 20 已 EOL（2026-04），
#    与根 Dockerfile 装的 22、ai-frontend Dockerfile 用的 22 对齐。
#
# ── 依赖来源纪律（PROCESS-013）────────────────────────────────────────────────
# 只走官方源：apt → deb.debian.org、npm → registry.npmjs.org。
# 刻意不提供 APT_MIRROR / NPM_REGISTRY 注入开关（理由见根 Dockerfile 注释）。
# 守卫：`npm run check:native-registry`。

FROM node:22-slim

ARG PNPM_VERSION=10.18.0

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl \
      ca-certificates \
      python3 \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate \
 && pnpm --version \
 && node --version && python3 --version

# ── 锁文件口径的**全部**输入（缺一即构建失败，且报错不会告诉你是哪一个）──────
# 三条来自根 Dockerfile 的实测教训：
#   1) .npmrc 缺 ⇒ ERR_PNPM_LOCKFILE_CONFIG_MISMATCH（锁文件记了 autoInstallPeers=false）
#   2) works/patches/ 缺 ⇒ pnpm 在读锁文件阶段就对 patchedDependencies 求 hash，
#      原生 ENOENT 逃逸到顶层 errorHandler ⇒ Linux errno=-2 ⇒ 退出码 254
#   3) workspace 成员清单真源是 pnpm-workspace.yaml（9 个），少一个即
#      ERR_PNPM_OUTDATED_LOCKFILE
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY .npmrc ./
COPY works/patches/ works/patches/
# 根 preinstall 钩子：pnpm 会在 install 时执行它，缺文件即 MODULE_NOT_FOUND。
# 该脚本自身「永不抛」（失败只降级为警告），所以带上是纯保险、无副作用。
COPY scripts/install/link-shared-dev.js scripts/install/link-shared-dev.js
# 覆盖 pnpm-workspace.yaml 的**全部 9 个成员**，路径与成员清单同源。
# 新增/删除 workspace 成员时，这里的条数必须与 pnpm-workspace.yaml 逐条对齐。
COPY runtime/substrate/platform/packages/shared/package.json runtime/substrate/platform/packages/shared/
COPY runtime/substrate/platform/packages/ui-shared/package.json runtime/substrate/platform/packages/ui-shared/
COPY runtime/substrate/platform/packages/plugin-sdk/package.json runtime/substrate/platform/packages/plugin-sdk/
COPY runtime/node/backend/package.json runtime/node/backend/
COPY runtime/node/ai-backend/package.json runtime/node/ai-backend/
COPY delivery/web/ai-frontend/package.json delivery/web/ai-frontend/
COPY delivery/web/provider-hub/package.json delivery/web/provider-hub/
COPY delivery/channel/khyquant/frontend/package.json delivery/channel/khyquant/frontend/
COPY delivery/extension/tools/khy-markdown/package.json delivery/extension/tools/khy-markdown/

# ⚠ 这里**故意不** COPY runtime/node/backend/vendor/shared。
# 依据 ai-frontend Dockerfile 的同名实测（pnpm 10.18.0）：本镜像的 install 带
# `--filter khy-ai-backend...`，khy-os-backend 不在范围内，pnpm-workspace.yaml 里
# `khy-os-backend>@khy/shared: link:runtime/node/backend/vendor/shared` 那条
# override 根本不会被解析，vendor/shared 也就不是锁文件口径的输入。
# ai-backend 自己的 override 是 `khy-ai-backend>@khy/shared: workspace:*`，
# 指向 workspace 真包，由下面第二条 COPY 提供源码。
# 「不拷」不等于「不校验」—— 见 install 之后的符号链接断言，真缺了会在构建期现形，
# 而不是像 2026-09-23 那样 exit 0 然后容器起来才 MODULE_NOT_FOUND。

# `...` 含其依赖闭包（@khy/shared）。
# --store-dir /tmp + 同一 RUN 内 rm：store 是 content-addressable 全局缓存，
# 默认落 ~/.local/share/pnpm/store 并随层提交，而 node_modules 里的包是它的硬链、
# 进层时会被复制成第二份。删掉后层快照只剩 node_modules。
RUN pnpm install --prod --frozen-lockfile \
      --store-dir /tmp/pnpm-store \
      --filter khy-ai-backend... \
    && rm -rf /tmp/pnpm-store /tmp/* /root/.npm \
    && echo '[build] pnpm store 与构建缓存已清出层外'

# ⚠ 刻意**不**删 /root/.cache/node/corepack 与 /usr/lib/node_modules/npm：
#   pnpm 是 corepack shim，npm 则可能被运行时调用，两者删了都要重新联网。
#   与根 Dockerfile 同一判据：大头是上面那个 store，不是这几个 MB。

# 源码放在依赖之后：改业务代码不必重装依赖（利用 layer cache）。
# @khy/shared 是 link:/workspace 目标，它的源码必须真的在镜像里。
COPY runtime/node/ai-backend/ runtime/node/ai-backend/
COPY runtime/substrate/platform/packages/shared/ runtime/substrate/platform/packages/shared/

# ── 符号链接完整性断言 ────────────────────────────────────────────────────────
# pnpm 的 link:/workspace 目标缺失时**不报错**（exit 0），只留下一条软链，
# 容器起来后才 MODULE_NOT_FOUND。这条断言把那个失败模式提前到构建期。
#
# 判据用「解析结果必须落在 /app 内」而不是 `find -xtype l` 或「不允许绝对链」：
# 前者会误命中 pnpm 合法的「软链指向软链」；后者被实测推翻 —— Windows 上 pnpm
# 建的就是绝对软链。「解析到 /app 之外」与平台无关，同时覆盖目标缺失与宿主泄漏。
# 完整推导见根 Dockerfile 的同名注释。
RUN set -e; \
    check() { \
      link="$1"; \
      [ -e "$link" ] || { echo "[build] 断链：$link（workspace 目标缺失？）"; exit 1; }; \
      t=$(readlink -f "$link"); \
      case "$t" in \
        /app/*) : ;; \
        *) echo "[build] $link 解析到 /app 之外：$t"; \
           echo '[build] —— 宿主机 node_modules 泄漏进镜像，检查 .dockerignore 的 **/node_modules'; \
           exit 1 ;; \
      esac; \
    }; \
    check /app/node_modules/@khy/shared; \
    check /app/runtime/node/ai-backend/node_modules/@khy/shared; \
    check /app/runtime/node/ai-backend/node_modules/express; \
    echo '[build] 符号链接完整性 OK（全部解析在 /app 内）'

# 数据目录。挂在 compose 的命名卷 ai_backend_data 上（/app/data）。
RUN mkdir -p /app/data

EXPOSE 9090

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://127.0.0.1:9090/api/health >/dev/null || exit 1

# ⚠ 仍以 root 运行（与旧版一致，未加 useradd）。这是刻意的保守选择：
#   /app/data 的属主、以及 src/utils/pythonPath.js 对 VIRTUAL_ENV / .venv 的
#   探测都可能依赖当前属主，改用户是独立的一次变更，不混进体积优化。
#   若要收紧，单独一次改动 + 单独验证 /api/health 与资讯拉取。
CMD ["node", "server.js"]
