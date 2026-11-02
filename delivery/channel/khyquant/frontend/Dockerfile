# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

# ── 依赖来源纪律（PROCESS-013）────────────────────────────────────────────────
# 只走 registry.npmjs.org。这里**刻意不提供** NPM_REGISTRY 注入开关 ——
# 2026-11-02 删掉了原来的 `ARG NPM_REGISTRY=...` + `npm config set registry`，
# 与根 Dockerfile、runtime/node/ai-backend/Dockerfile 同一判据：
#   默认值虽然是官方源，但开关本身就是口子。构建期一旦走公共镜像，同一份
#   Dockerfile 在不同网络下会拉到不同 tarball（镜像同步延迟时甚至是旧版本），
#   而构建照样成功 ⇒ 产物不可复现，且没有任何既有守卫会报出来。
#   需要加速请在**构建机**上配 Docker daemon 的 registry-mirrors。
# 守卫：`npm run check:native-registry`。

COPY package*.json ./
# ⚠ `--package-lock=false` 是**刻意保留**的，不要"修"成 npm ci。
#   实测（2026-11-02）：package.json 声明 30 个依赖，package-lock.json 的
#   packages[""] 根条目只有 15 个 —— 缺的 15 个里 14 个是 devDependencies
#   （vite / vitest / eslint / typescript / @capacitor/cli / sass …），
#   而 `npm run build` 恰恰需要 vite。package.json 最后修改于 10-07，
#   package-lock.json 停留在 09-25，锁文件已漂移 12 天。
#   改成 npm ci 会让构建当场失败（"package.json and package-lock.json
#   are not in sync"）。要改用锁文件，先单独重新生成 package-lock.json
#   并单独提交验证，那是独立的一次变更，不要混进体积优化。
RUN npm install --no-audit --no-fund --package-lock=false
COPY . .

ARG VITE_API_BASE_URL=http://localhost:3000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN npm run build

# Stage 2: Serve
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
