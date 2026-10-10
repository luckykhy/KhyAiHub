# syntax=docker/dockerfile:1
#
# delivery/web/ai-frontend/Dockerfile — AI 前端静态站（`docker compose --profile web`）
#
# ⚠⚠ **构建上下文必须是仓库根，不是 delivery/web/ai-frontend。**
#
# 原版把上下文当成本目录（`COPY package*.json ./` + `npm install`），在独立上下文里
# 必然 404 —— 因为 delivery/web/ai-frontend 依赖 workspace 本地包 `@khy/ui-shared`（版本
# `0.1.0`），而它**从未发布到 npm**（根 .npmrc 有这条记载：pnpm 迁移时发现
# `link-workspace-packages` 默认关闭会让它去 registry 查，直接 404）。
# 所以这里改为从仓库根用 pnpm workspace 安装，与根 Dockerfile 同一纪律。
#
# 用法：
#   docker build -f delivery/web/ai-frontend/Dockerfile -t khy-ai-frontend .
#   docker compose --profile web up -d --build
#
# ── 依赖来源（PROCESS-013）────────────────────────────────────────────────────
# 只走官方源（registry.npmjs.org）。不提供镜像注入开关。
# 守卫：npm run check:native-registry

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-slim AS builder

ARG PNPM_VERSION=10.18.0
# 留空 = 同源部署（推荐）。前端所有调用路径本身就以 /api 开头，而 nginx.conf 已把
# /api 与 /ws 反代到 ai-backend:9090，所以产物里不该烘任何主机名。
# 只有前后端分离部署时才需要传绝对地址（且必须带 /api 前缀）。
ARG VITE_AI_API_BASE_URL=""

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate \
    && pnpm --version

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
# ⚠ 这里**故意不** COPY runtime/node/backend/vendor/shared —— 别「顺手补齐」，它不是本镜像的输入。
# 根 Dockerfile 需要它，是因为那边装的是 khy-os-backend（`link:vendor/shared` 的消费者）；
# 本镜像的 install 带 `--filter khy-ai-frontend...`，实测（pnpm 10.18.0）
# `Scope: 2 of 4 workspace projects` —— khy-os-backend 不在范围内，那条 link: 根本不会被解析，
# 也就不会留下悬空软链。多 COPY 一份只会平白把后端 vendor 代码塞进前端构建层。
# 下面的 COPY 覆盖 pnpm-workspace.yaml 的**全部 9 个成员**（缺一个成员的 manifest
# 同样触发 ERR_PNPM_OUTDATED_LOCKFILE），路径与成员清单同源：
COPY runtime/substrate/platform/packages/shared/package.json runtime/substrate/platform/packages/shared/
COPY runtime/substrate/platform/packages/ui-shared/package.json runtime/substrate/platform/packages/ui-shared/
COPY runtime/substrate/platform/packages/plugin-sdk/package.json runtime/substrate/platform/packages/plugin-sdk/
COPY runtime/node/backend/package.json runtime/node/backend/
COPY runtime/node/ai-backend/package.json runtime/node/ai-backend/
COPY delivery/web/ai-frontend/package.json delivery/web/ai-frontend/
COPY delivery/web/provider-hub/package.json delivery/web/provider-hub/
COPY delivery/channel/khyquant/frontend/package.json delivery/channel/khyquant/frontend/
COPY delivery/extension/tools/khy-markdown/package.json delivery/extension/tools/khy-markdown/

# 前端构建要 devDependencies（vite），故**不加** --prod。
# `...` 含其依赖闭包（@khy/ui-shared、@khy/shared）。
RUN pnpm install --frozen-lockfile --filter khy-ai-frontend...

# 源码放在依赖之后：改前端代码不必重装依赖（利用 layer cache）。
COPY delivery/web/ai-frontend/ delivery/web/ai-frontend/
COPY runtime/substrate/platform/packages/ui-shared/ runtime/substrate/platform/packages/ui-shared/
COPY runtime/substrate/platform/packages/shared/ runtime/substrate/platform/packages/shared/

ENV VITE_AI_API_BASE_URL=${VITE_AI_API_BASE_URL}
RUN pnpm --filter khy-ai-frontend run build

# ── Stage 2: serve ───────────────────────────────────────────────────────────
FROM nginx:alpine

# nginx.conf 的 upstream 是 `ai-backend:9090` —— 这是 compose 网络里的服务契约，
# 改 compose 的服务名必须同步改它。
COPY delivery/web/ai-frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/delivery/web/ai-frontend/dist /usr/share/nginx/html

EXPOSE 80

# nginx:alpine 自带 wget（busybox），不必为此装 curl。
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
