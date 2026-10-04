---
name: 构建与交付依赖须原生官方源
id: PROCESS-013
domain: PROCESS
nature: 约束为主，兼福利
scope: "本仓库一切**构建与交付**路径上的依赖获取点：① 构建/交付配置 —— Dockerfile、docker-compose、.npmrc、package-lock.json、CI workflow、构建脚本（.sh/.ps1/.nsi）、requirements 与 pip 配置、**package.json**（其 `scripts.*` 是构建入口，`build.electronDownload.mirror` 等是构建期下载镜像）；② 运行时源码里**默认生效**的镜像选择 —— platform/**、services/**、software/**。不含两类：用户本机 ~/.npmrc 的网络加速（那是用户环境而非交付物）、GitHub 制品的 ghproxy 兜底（那不是包 registry，且已由 KHY_KHYOS_PREFER_CN 显式门控）。"
priority: P1
trigger: "新增或修改任何 Dockerfile / compose / 锁文件 / CI workflow / 构建脚本时；新增会拉取依赖的运行时代码时；`docker compose up` 构建失败、构建缓慢、或怀疑产物不可复现时。"
constraint: "四条判据，由 scripts/ci/check-native-registry.js 机械执行：C1 构建/交付配置里不得出现公共镜像主机（阿里云/淘宝 npmmirror/腾讯云/清华 tuna/中科大/华为云/网易/豆瓣等，含裸主机名形态）—— 零容忍，不设例外；判定面含 **package.json**（2026-09-23 实测漏检过 apps/khyos-desktop 的 `build.electronDownload.mirror`）；C2 构建/交付配置里不得出现 `*_MIRROR` 形态的镜像注入开关（APT_MIRROR / KHY_APT_MIRROR / ALPINE_MIRROR 等）—— 开关本身就是「把镜像塞进构建」的口子，与是否设值无关；C3 锁文件的 `resolved` 只允许解析到官方 host（registry.npmjs.org），按文件聚合并给出 host 直方图；C4 运行时源码里出现镜像主机时，**同一文件必须出现显式开关名**（KHY_USE_CN_MIRROR 或 KHY_KHYOS_PREFER_CN），即镜像不得默认生效、不得由 locale/TZ 猜测触发。注释行一律不参与判定（注释不执行，且解释「为何删除镜像」的注释必然要提到开关名）。"
grants: "见约束边界：授权维护者在默认路径（官方源）上不做任何额外声明即视为合规，无须逐条登记「本文件未使用镜像」；授权用一条命令取得全量读数（npm run check:native-registry）与豁免清单（--list）；授权国内用户通过显式设置 KHY_USE_CN_MIRROR=1 换取镜像加速 —— 这是本规则对被授权方的核心让渡，代价是该选择可被审计（开关名必须出现在使用处的文件里）。判据不满足时不再持有「静默使用镜像」的余地，但持有「声明豁免并写复核到期日」的权力。"
benefit: "把「构建可复现」从一句期望变成机械可查的结论。实测起点（2026-09-23）：runtime/node/backend/Dockerfile 有 3 处 `-i mirrors.aliyun.com`，6 个 package-lock.json 共 3005 条 resolved 指向 registry.npmmirror.com，另有两处运行时 fail-open 到镜像（except 分支默认 china=True）。这些都不会让任何既有守卫变红 —— 构建照样成功、测试照样全绿，只是「同一份 Dockerfile 在不同网络下产出的镜像内容不同」这件事无人知晓。本规则同时给出默认与 opt-in 的边界，使国内用户的加速需求不必以「默认不可复现」为代价。"
exception: "三类：① 运行时**显式** opt-in 的国内加速（KHY_USE_CN_MIRROR=1）不算违规 —— 判据是「默认是否原生」而非「是否允许存在」；② 非配置语境里出现的镜像地址（如离线知识库正文、给用户看的说明文案）按 EXEMPT 登记豁免，每条须带理由与复核到期日；③ 构建机上的代理 / `registry-mirrors` / `ELECTRON_MIRROR` 等**环境变量**属用户环境，不在管辖内 —— 需要加速请在构建机上设它们，而不是把镜像地址写进仓库文件。豁免登记在 scripts/ci/check-native-registry.js 的 EXEMPT 常量，可用 --list 查看。"
version: "1.1.0 (2026-09-23)"
status: active
ssot: "docs/10_规范/其它规范/[DESIGN-DEP-001] 依赖管理规范.md §10 依赖来源 / docs/10_规范/其它规范/[DESIGN-DEPLOY-001] 部署规范.md §3.3"
formerly: 无
owner: governance-team
---

# [PROCESS-013] 构建与交付依赖须原生官方源

<!-- RULES-REGISTRY: PROCESS-013 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/其它规范/[DESIGN-DEP-001] 依赖管理规范.md §10 依赖来源 / docs/10_规范/其它规范/[DESIGN-DEPLOY-001] 部署规范.md §3.3。

## 约束

四条判据，由 scripts/ci/check-native-registry.js 机械执行：C1 构建/交付配置里不得出现公共镜像主机（阿里云/淘宝 npmmirror/腾讯云/清华 tuna/中科大/华为云/网易/豆瓣等，含裸主机名形态）—— 零容忍，不设例外；判定面含 **package.json**（2026-09-23 实测漏检过 apps/khyos-desktop 的 `build.electronDownload.mirror`）；C2 构建/交付配置里不得出现 `*_MIRROR` 形态的镜像注入开关（APT_MIRROR / KHY_APT_MIRROR / ALPINE_MIRROR 等）—— 开关本身就是「把镜像塞进构建」的口子，与是否设值无关；C3 锁文件的 `resolved` 只允许解析到官方 host（registry.npmjs.org），按文件聚合并给出 host 直方图；C4 运行时源码里出现镜像主机时，**同一文件必须出现显式开关名**（KHY_USE_CN_MIRROR 或 KHY_KHYOS_PREFER_CN），即镜像不得默认生效、不得由 locale/TZ 猜测触发。注释行一律不参与判定（注释不执行，且解释「为何删除镜像」的注释必然要提到开关名）。

## 授予权力

见约束边界：授权维护者在默认路径（官方源）上不做任何额外声明即视为合规，无须逐条登记「本文件未使用镜像」；授权用一条命令取得全量读数（npm run check:native-registry）与豁免清单（--list）；授权国内用户通过显式设置 KHY_USE_CN_MIRROR=1 换取镜像加速 —— 这是本规则对被授权方的核心让渡，代价是该选择可被审计（开关名必须出现在使用处的文件里）。判据不满足时不再持有「静默使用镜像」的余地，但持有「声明豁免并写复核到期日」的权力。

## 提供福利

把「构建可复现」从一句期望变成机械可查的结论。实测起点（2026-09-23）：runtime/node/backend/Dockerfile 有 3 处 `-i mirrors.aliyun.com`，6 个 package-lock.json 共 3005 条 resolved 指向 registry.npmmirror.com，另有两处运行时 fail-open 到镜像（except 分支默认 china=True）。这些都不会让任何既有守卫变红 —— 构建照样成功、测试照样全绿，只是「同一份 Dockerfile 在不同网络下产出的镜像内容不同」这件事无人知晓。本规则同时给出默认与 opt-in 的边界，使国内用户的加速需求不必以「默认不可复现」为代价。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

三类：① 运行时**显式** opt-in 的国内加速（KHY_USE_CN_MIRROR=1）不算违规 —— 判据是「默认是否原生」而非「是否允许存在」；② 非配置语境里出现的镜像地址（如离线知识库正文、给用户看的说明文案）按 EXEMPT 登记豁免，每条须带理由与复核到期日；③ 构建机上的代理 / `registry-mirrors` / `ELECTRON_MIRROR` 等**环境变量**属用户环境，不在管辖内 —— 需要加速请在构建机上设它们，而不是把镜像地址写进仓库文件。豁免登记在 scripts/ci/check-native-registry.js 的 EXEMPT 常量，可用 --list 查看。

## 版本记录

- 1.1.0 (2026-09-23) 初版 / 迁移自 无
