"""国内镜像开关（`PROCESS-013`）—— 默认关闭，必须用户**显式 opt-in**。

## 为什么需要这个模块

khy-os 有若干「国内网络加速」点（Node 发行包、npm registry、Android SDK 等）。
它们的原实现是**按 locale / TZ 自动判断**（`lang.startswith("zh")` 或
`TZ` 含 `Shanghai`/`Chongqing`）—— 即「你在中国 ⇒ 自动改用公共镜像」。

这条启发式有两个问题：

1. **不可复现**：同一份代码在两地跑会从不同源拉包，镜像同步延迟时甚至拉到旧版本，
   而流程照样成功。构建/安装产物的内容因此取决于机器的时区设置。
2. **不可审计**：用户没有做任何选择，却已经在用第三方镜像；出问题时也不知道
   到底是官方源还是镜像给的包。

改为**显式开关**后：默认一律官方源（`registry.npmjs.org` / `nodejs.org` /
`pypi.org`），只有用户明确设置 ``KHY_USE_CN_MIRROR=1`` 才启用镜像。
需要加速的用户仍然一键可用，而默认路径完全可复现。

## 判据归属

`PROCESS-013`「构建与交付依赖须原生官方源」。守卫
`scripts/ci/check-native-registry.js` 对运行时源码的要求是：**镜像主机与本模块的
开关名必须出现在同一个文件里** —— 想用镜像就必须写出显式开关，不允许隐式默认。
"""

from __future__ import annotations

import os

#: 唯一的开关名。运行时要用镜像，必须让这个名字出现在使用处所在的文件里。
ENV_FLAG = "KHY_USE_CN_MIRROR"

#: 视为「开」的取值（大小写不敏感）。
_TRUTHY = frozenset({"1", "true", "yes", "on", "enable", "enabled"})

#: 官方源（默认路径）。
NPM_REGISTRY_OFFICIAL = "https://registry.npmjs.org"
NODE_DIST_OFFICIAL = "https://nodejs.org/dist/v{v}/"

#: 国内镜像（仅在显式 opt-in 后使用）。
NPM_REGISTRY_CN = "https://registry.npmmirror.com"
NODE_DIST_CN = "https://npmmirror.com/mirrors/node/v{v}/"


def cn_mirror_enabled(env: "os._Environ[str] | dict[str, str] | None" = None) -> bool:
    """是否启用国内镜像。**默认 False**（官方源）。

    只看显式开关，不做任何 locale / TZ 猜测。
    """
    source = os.environ if env is None else env
    try:
        raw = source.get(ENV_FLAG, "")
    except Exception:
        return False
    return str(raw).strip().lower() in _TRUTHY


def npm_registry(env: "os._Environ[str] | dict[str, str] | None" = None) -> str:
    """npm registry 地址：默认官方，显式 opt-in 后为国内镜像。"""
    return NPM_REGISTRY_CN if cn_mirror_enabled(env) else NPM_REGISTRY_OFFICIAL


def node_dist_root(env: "os._Environ[str] | dict[str, str] | None" = None) -> str:
    """Node 发行包根地址（含 ``{v}`` 占位符）。"""
    return NODE_DIST_CN if cn_mirror_enabled(env) else NODE_DIST_OFFICIAL


__all__ = [
    "ENV_FLAG",
    "NPM_REGISTRY_OFFICIAL",
    "NPM_REGISTRY_CN",
    "NODE_DIST_OFFICIAL",
    "NODE_DIST_CN",
    "cn_mirror_enabled",
    "npm_registry",
    "node_dist_root",
]
