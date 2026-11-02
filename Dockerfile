# Dockerfile — khy-os service container image
#
# Builds on python:3.12-slim and installs Node.js 22.
#
# ⚠️ 重要：为什么这里必须 COPY 源码（2026-09-18 实测确认）
#
# `pip install khy-os` 装出来的 wheel **只有** khy_platform（Python 启动器）
# 与一个预打包的 `bundled/runtime/khy/bundle.mjs`，**不包含 runtime/node/backend
# 源码树**。证据三处：
#   - pyproject.toml: packages = ["khy_platform"]（wheel 只收该包）
#   - platform/khy_platform/cli.py:2070 注释原文：
#       "A standalone-bundle install (the pip wheel) genuinely has no backend
#        directory: the runtime is one bundle.mjs with its dependencies already
#        linked in."
#   - MANIFEST.in 里的 recursive-include runtime/node/backend 只作用于 sdist，不作用于 wheel
#
# 因此若 CMD 指向 `node runtime/node/backend/...` 而不先 COPY 源码，容器启动即
# MODULE_NOT_FOUND。本镜像现在**源码模式**运行：COPY 仓库树 + 装后端依赖。
#
# Usage:
#   docker build -t khy-os:latest .
#   docker run --rm -p 3000:3000 khy-os:latest            # HTTP 服务（默认）
#   docker run --rm -it khy-os:latest khy --version       # TUI/CLI（覆盖 CMD）

# ── 为什么这份 Dockerfile 在 2026-11-02 被改写 ────────────────────────────────
#
# 三个改动，都不是为了「看起来更干净」：
#
# 1) **删掉 `COPY delivery/desktop/khyos-desktop/package.json`。**
#    该目录已迁到 `apps/khyos-desktop`（`delivery/desktop/` 现在是空目录），
#    这条 COPY 让 `docker build` **当场失败**（file not found）。
#    pnpm-workspace.yaml 现在只有 9 个成员，那一行是 10 成员时代的残留。
#
# 2) **把 pnpm store 与各类缓存挡在层外。**
#    pnpm 的 store 是 content-addressable 的全局包缓存，默认落在
#    `~/.local/share/pnpm/store/v3`；install 以 root 跑（`USER khy` 之前），
#    于是它落在 `/root/.local/share/pnpm/store` 并**随镜像一起发布**。
#    node_modules 里的包是 store 的硬链，进层时会被复制成第二份 ——
#    这一项常常是单项体积最大的一条。
#
#    ⚠ 这里**刻意不做真正的多阶段**（`COPY --from=builder`）：
#    nodesource 的 `nodejs` deb 按 Debian 政策装到 `/usr/bin` 与
#    `/usr/lib/node_modules`，**不在 `/usr/local`**。要跨阶段搬就得逐文件
#    `COPY --from`（node / nodejs / npm / npx / corepack / /usr/lib/node_modules
#    / /usr/local/bin / /usr/local/lib），任何一项在下次升 Node 版本时改名或
#    消失，构建就静默断裂 —— 而这种断裂的报错完全不指向这里。
#    单阶段 + 显式 `rm -rf` store 拿到的是同一份收益（层快照 = rm 之后的状态），
#    风险却低一个量级。
#
# 3) **加一条符号链接完整性断言。**
#    旧 .dockerignore 的 `node_modules` 只匹配上下文根（Docker 的 `*` 不跨 `/`），
#    于是 `COPY runtime/node/backend/` 会把宿主机那份 pnpm 符号链接农场搬进镜像，
#    **覆盖**下面刚 `--prod` 装好的依赖。CI 用干净 checkout、没有这个目录所以全绿；
#    本机构建则镜像内容取决于开发机装了什么。.dockerignore 已改成 `**/node_modules`，
#    这条断言是第二道闸。

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
#
# ⚠ 不要为了省 17.9 MB 去删 `bundled/runtime/khy/bundle.mjs`（2026-11-02 复核）：
#   容器里 `khy_platform` 装在 site-packages，`_source_checkout_backend()` 的
#   `project_root` 向上三层不含 `.git` ⇒ 恒返回 None ⇒
#   `_is_standalone_bundle_install()` 恒为 True ⇒ `khy` 命令**永远**执行 bundle.mjs
#   （cli.py:2648-2655）。删了它，`docker run khy-os khy ...` 这条既有用法直接报废，
#   而 HTTP 服务本来也不用它 —— 省 2% 体积换一条契约，不划算。
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
COPY works/patches/ works/patches/
# 根 preinstall 钩子（scripts/install/link-shared-dev.js）：pnpm 会在 install 时执行它，
# 容器里缺这个文件就是 MODULE_NOT_FOUND（脚本自己「永不抛」，但**找不到文件**是 node 层面的
# 硬失败，它没机会兜底）。带上是纯保险：该脚本在非 dev checkout 下是 no-op。
COPY scripts/install/link-shared-dev.js scripts/install/link-shared-dev.js
# 3) runtime/node/backend/vendor/shared —— 它是 `pnpm-workspace.yaml` 里
#    `overrides: khy-os-backend>@khy/shared: link:runtime/node/backend/vendor/shared`
#    的 **link: 目标**，同理属于「锁文件口径的输入」。
#
# ⚠ 缺它**不会**让构建失败 —— 这是最坏的一类失败。2026-09-23 用 pnpm 10.18.0 实测：
#    link: 目标不存在时 `pnpm install --prod --frozen-lockfile` **仍然 exit 0**，
#    只是把 node_modules/@khy/shared 建成一条**指向空路径的绝对软链**
#    （→ /app/runtime/node/backend/vendor/shared）。构建全绿，容器起来后
#    require('@khy/shared/...') 才 MODULE_NOT_FOUND。
#    而且随后 `COPY runtime/node/backend/` 的落点会变成一条软链，行为随 Docker 版本而异。
# 先把真目录放进去：install 期目标就存在，落点也退化成普通的目录合并，确定性。
# 该目录被 git 跟踪（89 个文件），preinstall 钩子见到真目录会主动跳过、不覆盖。
COPY runtime/node/backend/vendor/shared runtime/node/backend/vendor/shared
# 必须把 **全部** workspace 成员的 package.json 都放进来：pnpm 的
# --frozen-lockfile 会校验锁文件与整个 workspace 的一致性，缺一个成员就会
# 报 ERR_PNPM_OUTDATED_LOCKFILE。
#
# ⚠ 2026-11-02 修正：这里原本还有一条 `COPY delivery/desktop/khyos-desktop/package.json`。
#   该目录已迁到 `apps/khyos-desktop`（`delivery/desktop/` 现为空目录），
#   那条 COPY 让 docker build 当场失败；且 pnpm-workspace.yaml 现在只有 **9** 个成员
#   （不是当年注释里写的 10 个），那一行是 10 成员时代的残留，已删。
# 新增/删除 workspace 成员时，这里的条数必须与 pnpm-workspace.yaml 逐条对齐。
COPY runtime/node/backend/package.json runtime/node/backend/
COPY runtime/node/ai-backend/package.json runtime/node/ai-backend/
COPY runtime/substrate/platform/packages/shared/package.json runtime/substrate/platform/packages/shared/
COPY runtime/substrate/platform/packages/ui-shared/package.json runtime/substrate/platform/packages/ui-shared/
COPY runtime/substrate/platform/packages/plugin-sdk/package.json runtime/substrate/platform/packages/plugin-sdk/
COPY delivery/extension/tools/khy-markdown/package.json delivery/extension/tools/khy-markdown/
COPY delivery/web/ai-frontend/package.json delivery/web/ai-frontend/
COPY delivery/web/provider-hub/package.json delivery/web/provider-hub/
COPY delivery/channel/khyquant/frontend/package.json delivery/channel/khyquant/frontend/

# --frozen-lockfile：锁文件与 package.json 不同步时**构建即失败**，
# 而不是悄悄改锁文件。与 CI 的 install:core 保持同一纪律。
# filter 语法与根 package.json 的 install:prod 一致（khy-os-backend... 含其依赖闭包）。
#
# ── 为什么 `--store-dir /tmp/pnpm-store` + 同一个 RUN 里 rm -rf ───────────────
# pnpm 的 store 是 content-addressable 的全局包缓存，默认 `~/.local/share/pnpm/store/v3`。
# install 以 root 跑（USER khy 之前），store 落在 /root 下并随层提交 —— node_modules
# 里的包本是 store 的硬链，进层时被复制成第二份。把 store 指到 /tmp 并在**同一个 RUN**
# 里删掉：层快照拍的是 rm 之后的状态，镜像里只剩 node_modules，而硬链已经落定、
# 删 store 不影响它（只是把链接数降回 1）。
# 用 CLI 显式传参而不是改 .npmrc：store-dir 是构建期策略，不该污染仓库配置
# （.npmrc 会同时影响开发机与 CI）。
#
# ⚠ 不要顺手删 /usr/lib/node_modules/npm：容器内 `khy` 的按需自愈路径
#    （runtime/substrate/platform/khy_platform/node_provisioner.py 装 node-llama-cpp）
#    会 shell 出去调 npm。corepack/pnpm 同理保留。
RUN pnpm install --prod --frozen-lockfile \
      --store-dir /tmp/pnpm-store \
      --filter khy-os-backend... \
      --filter @khy/shared... \
    && rm -rf /tmp/pnpm-store /tmp/* /root/.npm \
    && echo '[build] pnpm store 与构建缓存已清出层外'

# ⚠ 刻意**不**删 /root/.cache/node/corepack（pnpm 的 corepack 缓存，约 5 MB）：
#   /usr/local/bin/pnpm 是 corepack shim，容器内一旦有人 exec `pnpm`，
#   缓存不在就要重新联网下载 pnpm@10.18.0。省 5 MB 换这个风险不划算 ——
#   真正的大头是上面那个 store（常常与 node_modules 同量级）。
#   同理不要删 /usr/lib/node_modules/npm：khy 的按需自愈路径
#   （khy_platform/node_provisioner.py 装 node-llama-cpp）会 shell 出去调 npm。

# 源码放在依赖之后：改业务代码不必重装依赖（利用 layer cache）。
COPY runtime/node/backend/ runtime/node/backend/
COPY runtime/substrate/platform/packages/shared/ runtime/substrate/platform/packages/shared/

# ── 符号链接完整性断言 ────────────────────────────────────────────────────────
# 防的是 ④ 号缺陷：`COPY runtime/node/backend/` 把宿主机那份 pnpm 符号链接农场
# 搬进镜像，覆盖上面刚 `--prod` 装好的依赖。CI 用干净 checkout、没有这个目录，
# 所以永远绿；本机一旦漏了 .dockerignore 的 `**/node_modules` 就会在这里现形。
#
# 判据为什么是「解析结果必须落在 /app 内」，而不是另外两个更常见的写法：
#   · `find -xtype l`（找断链）—— 除断链外还会命中「软链指向软链」，而 pnpm 的
#     .pnpm 虚拟 store 里合法存在这种链形，会在正确镜像上偶发误红。误红一次的
#     代价就是有人把这条守卫删掉。
#   · 「镜像里不允许有绝对路径软链」—— 曾按这个写，实测推翻：**Windows 上 pnpm
#     建的就是绝对软链**（`/d/Portable/khy-os/node_modules/.pnpm/...`，2026-11-02
#     在本机 find -lname '/*' 抓到一片）。所以「绝对」不是泄漏的可靠签名。
#   「解析到 /app 之外」才是：它与平台无关（不假定 pnpm 用相对还是绝对链），
#   也不受链形影响，且同时覆盖「目标缺失」与「指向宿主」两种坏情况。
#   顺带查一个普通依赖 express：只查 @khy/shared 的话，宿主机农场里普通包的
#   泄漏（`runtime/node/backend/node_modules/express`）会漏网。
RUN set -e; \
    check() { \
      link="$1"; \
      [ -e "$link" ] || { echo "[build] 断链：$link（link: 目标缺失？）"; exit 1; }; \
      t=$(readlink -f "$link"); \
      case "$t" in \
        /app/*) : ;; \
        *) echo "[build] $link 解析到 /app 之外：$t"; \
           echo '[build] —— 宿主机 node_modules 泄漏进镜像，检查 .dockerignore 的 **/node_modules'; \
           exit 1 ;; \
      esac; \
    }; \
    check /app/node_modules/@khy/shared; \
    check /app/runtime/node/backend/node_modules/@khy/shared; \
    check /app/runtime/node/backend/node_modules/express; \
    echo '[build] 符号链接完整性 OK（全部解析在 /app 内）'

# 运行期目录需对 khy 用户可写（sqlite / logs / cache）。
# ⚠ data/ 刻意**不**在这里清空：runtime/node/backend/data/.admin_initial_password
#   被 git 跟踪，是初始管理员口令的真源，删了会改掉首次启动行为。
RUN mkdir -p /home/khy/.khy /app/runtime/node/backend/logs /app/runtime/node/backend/data \
    && chown -R khy:khy /app /home/khy/.khy
USER khy
WORKDIR /app/runtime/node/backend

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
