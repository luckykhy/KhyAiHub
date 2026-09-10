FROM node:20-slim

WORKDIR /app

# ── 依赖来源纪律（PROCESS-013）─────────────────────────────────────────────
# 只走官方源：apt → deb.debian.org、npm → registry.npmjs.org。
# 刻意不提供 APT_MIRROR / NPM_REGISTRY 注入开关（理由见根 Dockerfile 注释）。
# 守卫：`npm run check:native-registry`。

# System dependencies (curl for healthcheck, build tools for better-sqlite3)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl build-essential ca-certificates python3 python3-dev && \
    rm -rf /var/lib/apt/lists/*

ENV PYTHON=/usr/bin/python3
ENV npm_config_python=/usr/bin/python3

# Copy shared package
COPY platform/packages/shared /app/packages/shared

# Copy ai-backend package files
COPY services/ai-backend/package*.json ./

# ai-backend/package.json uses "@khy/shared": "^1.6.5" for monorepo local dev.
# In Docker single-package build, rewrite it to a local file dependency.
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));if(p.dependencies&&p.dependencies['@khy/shared'])p.dependencies['@khy/shared']='file:packages/shared';fs.writeFileSync('package.json',JSON.stringify(p,null,2));"
RUN rm -f package-lock.json
# npm registry 钉死官方源（无覆盖开关）
RUN npm config set registry https://registry.npmjs.org/
RUN npm install --no-audit --no-fund

# Copy ai-backend source
COPY services/ai-backend/ ./

# Symlink shared node_modules
RUN ln -sf /app/node_modules /app/packages/shared/node_modules

# Data directory
RUN mkdir -p /app/data

EXPOSE 9090

HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD curl -f http://localhost:9090/api/health || exit 1

CMD ["node", "server.js"]
