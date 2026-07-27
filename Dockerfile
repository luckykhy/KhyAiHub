# Dockerfile — khy-os service container image
#
# Builds on python:3.12-slim and installs Node.js 22.
#
# ⚠️ 重要：为什么这里必须 COPY 源码（2026-09-18 实测确认）
#
# `pip install khy-os` 装出来的 wheel **只有** khy_platform（Python 启动器）
# 与一个预打包的 `bundled/runtime/khy/bundle.mjs`，**不包含 services/backend
# 源码树**。证据三处：
#   - pyproject.toml: packages = ["khy_platform"]（wheel 只收该包）
#   - platform/khy_platform/cli.py:2070 注释原文：
#       "A standalone-bundle install (the pip wheel) genuinely has no backend
#        directory: the runtime is one bundle.mjs with its dependencies already
#        linked in."
#   - MANIFEST.in 里的 recursive-include services/backend 只作用于 sdist，不作用于 wheel
#
# 因此若 CMD 指向 `node services/backend/...` 而不先 COPY 源码，容器启动即
# MODULE_NOT_FOUND。本镜像现在**源码模式**运行：COPY 仓库树 + 装后端依赖。
#
# Usage:
#   docker build -t khy-os:latest .
#   docker run --rm -p 3000:3000 khy-os:latest            # HTTP 服务（默认）
#   docker run --rm -it khy-os:latest khy --version       # TUI/CLI（覆盖 CMD）

FROM python:3.12-slim AS base

# ── Labels ────────────────────────────────────────────────────────────────────
LABEL org.opencontainers.image.title="khy-os"
LABEL org.opencontainers.image.description="Khy OS AI platform operating system"
LABEL org.opencontainers.image.source="https://github.com/khy-os/khy-os"
LABEL org.opencontainers.image.licenses="Source-available"

# ── Build-time args ───────────────────────────────────────────────────────────
ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_MAJOR=22
# 与根 package.json 的 packageManager 及 workflow 里 pin 的版本保持一致。
ARG PNPM_VERSION=10.18.0
#
# ⚠ 这里**刻意不提供** PIP_INDEX_URL / NPM_REGISTRY / APT_MIRROR 之类的镜像注入开关。
# 判据（`PROCESS-013`）：构建期一旦走公共镜像，同一份 Dockerfile 在不同网络下会拉到
# 不同 tarball（镜像同步延迟时甚至是旧版本），而构建照样成功 ⇒ 产物不可复现，
# 且没有任何既有守卫会报出来。需要加速请在**构建机**上配代理（HTTP_PROXY /
# Docker daemon 的 registry-mirrors），而不是把镜像地址写进仓库。
# 守卫：`npm run check:native-registry`。

# ── Install system deps + Node.js 22 ─────────────────────────────────────────
# curl + ca-certificates are needed to fetch Node's install script.
# dumb-init is a minimal init for PID 1 signal reaping.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         curl \
         ca-certificates \
         dumb-init \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && npm --version \
    && corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate \
    && pnpm --version

# ── Install khy-os from PyPI ──────────────────────────────────────────────────
# 保留 pip 安装：它提供 `khy` 命令与 Python 启动器（其中 bundle.mjs 作为
# 独立运行时的兜底）。HTTP 服务本身走下面的源码树。
ARG KHY_OS_VERSION=""
RUN if [ -z "$KHY_OS_VERSION" ]; then \
      pip install --no-cache-dir khy-os; \
    else \
      pip install --no-cache-dir "khy-os==${KHY_OS_VERSION}"; \
    fi \
    && khy --version

# ── Non-root user (security best practice) ────────────────────────────────────
# The khy-os data directory must be writable (logs, cache, sqlite DBs).
RUN useradd -m -u 1000 -s /bin/bash khy \
    && mkdir -p /home/khy/.khy \
    && chown -R khy:khy /home/khy/.khy

# ── 源码树 + 后端依赖 ────────────────────────────────────────────────────────
# 放在 pip 安装之后、USER 切换之前：npm/pnpm 安装需要写权限。
# 只 COPY 运行 HTTP 服务真正需要的部分，避免把整仓（含 docs/apps/kernel）塞进镜像。
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# ⚠️ 以下三件必须与上面三个清单文件一起进镜像，否则 --frozen-lockfile 必然失败：
#
#   1) .npmrc —— 锁文件把 settings.autoInstallPeers 记成了 false（源自 .npmrc 的
#      auto-install-peers=false）。容器里没有 .npmrc 时 pnpm 退回默认 true，
#      --frozen-lockfile 会直接报 ERR_PNPM_LOCKFILE_CONFIG_MISMATCH 并退出。
#   2) patches/ —— pnpm 在**读锁文件**阶段就会对 patchedDependencies 里的补丁文件
#      求 hash（createHexHashFromFile），与该包最终装不装无关。缺文件时原生 ENOENT
#      会逃逸到 pnpm 顶层 errorHandler，那里 process.exit(err.errno)；Linux 上
#      errno = -2 ⇒ 构建报 "exit code: 254"（2026-09-23 实测复现）。
COPY .npmrc ./
COPY patches/ patches/
# 根 preinstall 钩子（scripts/install/link-shared-dev.js）：pnpm 会在 install 时执行它，
# 容器里缺这个文件就是 MODULE_NOT_FOUND（脚本自己「永不抛」，但**找不到文件**是 node 层面的
# 硬失败，它没机会兜底）。带上是纯保险：该脚本在非 dev checkout 下是 no-op。
COPY scripts/install/link-shared-dev.js scripts/install/link-shared-dev.js
# 3) services/backend/vendor/shared —— 它是 `pnpm-workspace.yaml` 里
#    `overrides: khy-os-backend>@khy/shared: link:services/backend/vendor/shared`
#    的 **link: 目标**，同理属于「锁文件口径的输入」。
#
# ⚠ 缺它**不会**让构建失败 —— 这是最坏的一类失败。2026-09-23 用 pnpm 10.18.0 实测：
#    link: 目标不存在时 `pnpm install --prod --frozen-lockfile` **仍然 exit 0**，
#    只是把 node_modules/@khy/shared 建成一条**指向空路径的绝对软链**
#    （→ /app/services/backend/vendor/shared）。构建全绿，容器起来后
#    require('@khy/shared/...') 才 MODULE_NOT_FOUND。
#    而且随后 `COPY services/backend/` 的落点会变成一条软链，行为随 Docker 版本而异。
# 先把真目录放进去：install 期目标就存在，落点也退化成普通的目录合并，确定性。
# 该目录被 git 跟踪（89 个文件），preinstall 钩子见到真目录会主动跳过、不覆盖。
COPY services/backend/vendor/shared services/backend/vendor/shared
# 必须把 **全部** workspace 成员的 package.json 都放进来：pnpm 的
# --frozen-lockfile 会校验锁文件与整个 workspace 的一致性，缺一个成员就会
# 报 ERR_PNPM_OUTDATED_LOCKFILE。
COPY services/backend/package.json services/backend/
COPY services/ai-backend/package.json services/ai-backend/
COPY platform/packages/shared/package.json platform/packages/shared/
COPY platform/packages/ui-shared/package.json platform/packages/ui-shared/
# ⚠ 下面两个成员此前漏了：pnpm 的成员清单真源是 pnpm-workspace.yaml（10 个），
# 不是根 package.json 的 workspaces（8 个）。少一个成员就可能触发
# ERR_PNPM_OUTDATED_LOCKFILE —— 而报错信息不会告诉你是哪一个缺了。
COPY platform/packages/plugin-sdk/package.json platform/packages/plugin-sdk/
COPY extensions/tools/khy-markdown/package.json extensions/tools/khy-markdown/
COPY apps/ai-frontend/package.json apps/ai-frontend/
COPY apps/khyos-desktop/package.json apps/khyos-desktop/
COPY apps/provider-hub/package.json apps/provider-hub/
COPY software/khyquant/frontend/package.json software/khyquant/frontend/

# --frozen-lockfile：锁文件与 package.json 不同步时**构建即失败**，
# 而不是悄悄改锁文件。与 CI 的 install:core 保持同一纪律。
# filter 语法与根 package.json 的 install:prod 一致（khy-os-backend... 含其依赖闭包）。
RUN pnpm install --prod --frozen-lockfile \
    --filter khy-os-backend... \
    --filter @khy/shared...

# 源码放在依赖之后：改业务代码不必重装依赖（利用 layer cache）。
COPY services/backend/ services/backend/
COPY platform/packages/shared/ platform/packages/shared/

# 运行期目录需对 khy 用户可写（sqlite / logs / cache）。
RUN mkdir -p /home/khy/.khy /app/services/backend/logs /app/services/backend/data \
    && chown -R khy:khy /app /home/khy/.khy
USER khy
WORKDIR /app/services/backend

# ── Runtime defaults ──────────────────────────────────────────────────────────
ENV KHY_HOME=/home/khy/.khy
ENV PATH="/usr/local/bin:${PATH}"
# 端口钉死为 3000，与 fly.staging.toml 的 http_service.internal_port 对齐。
# docker-entrypoint.js 也会再设一次（双保险），此处显式声明便于阅读。
ENV PORT=3000
# 容器内不要写 .env（只读风险），用注入的环境变量。
ENV KHY_CONTAINER=1

# Fly / 编排层通过此端口访问 HTTP 服务。
EXPOSE 3000

# 健康检查：/healthz 是存活探针、/health 是就绪探针（见 docker-entrypoint.js）。
# 用 /health 而非 /healthz —— compose 的 `depends_on: condition: service_healthy`
# 要的是「真的能服务请求」，不是「进程还在」。
HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/health >/dev/null || exit 1

# dumb-init reaps zombies and forwards signals properly.
# 默认以 HTTP 服务启动（供 Fly 的 http_service.checks 探活）；
# 需要 TUI/CLI 时用 `docker run ... khy` 覆盖 CMD 即可，不影响既有用法。
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "docker-entrypoint.js"]

