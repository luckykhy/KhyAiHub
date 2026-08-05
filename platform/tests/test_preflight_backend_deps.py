#!/usr/bin/env python3
"""``khy_platform.cli`` preflight 依赖检查（BUG-017 方向 c）的单元测试。

覆盖三个判据：
1. ``node_modules`` 存在且非空 → ``ok``（不受模拟开关影响）；
2. ``node_modules`` 缺失 → ``warn``（不再 ``fail``——首跑 ``ensure_bootstrapped``
   会自动补装，preflight 不该把用户拦在 install 与 chat 之间）；
3. ``KHY_FIRST_RUN=1`` 模拟：即使磁盘上依赖已装，也强制按「全新安装视角」
   评估为 ``warn``，且 detail 带 ``[KHY_FIRST_RUN sim]`` 标记；只读零副作用。

跑法（零依赖，不需要 pytest）::

    python -m unittest discover -s platform/tests -t platform/tests
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

# 让测试能脱离安装状态直接跑：把 platform/ 加进导入路径。
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from khy_platform.cli import _pf_check_backend_deps  # noqa: E402


class TestPfCheckBackendDeps(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.backend = Path(self._tmp.name) / "backend"
        self.backend.mkdir()

    def _install_deps(self):
        (self.backend / "node_modules" / "express").mkdir(parents=True)

    def test_installed_deps_read_ok(self):
        self._install_deps()
        r = _pf_check_backend_deps(self.backend)
        self.assertEqual(r["status"], "ok")
        self.assertEqual(r["fixes"], [])

    def test_missing_deps_warn_not_fail(self):
        r = _pf_check_backend_deps(self.backend)
        self.assertEqual(r["status"], "warn")
        # 规则 2.2：detail 说明「首跑会自动补装」，fixes 保留一行修复命令。
        self.assertIn("auto-installs", r["detail"])
        self.assertTrue(any("npm install" in f for f in r["fixes"]))

    def test_empty_node_modules_dir_counts_as_missing(self):
        (self.backend / "node_modules").mkdir()  # 存在但空 ⇒ 视为未装
        r = _pf_check_backend_deps(self.backend)
        self.assertEqual(r["status"], "warn")

    def test_first_run_simulation_forces_missing_view(self):
        self._install_deps()
        r = _pf_check_backend_deps(self.backend, simulate_missing=True)
        self.assertEqual(r["status"], "warn")
        self.assertIn("[KHY_FIRST_RUN sim]", r["detail"])

    def test_first_run_simulation_is_read_only(self):
        self._install_deps()
        before = sorted(p.name for p in (self.backend / "node_modules").iterdir())
        _pf_check_backend_deps(self.backend, simulate_missing=True)
        after = sorted(p.name for p in (self.backend / "node_modules").iterdir())
        self.assertEqual(before, after)

    def test_simulation_env_documented_value_only(self):
        """KHY_FIRST_RUN 只认字面 '1'（与实现处 strip 后比较一致）。"""
        with mock_env(KHY_FIRST_RUN="true"):
            # 该环境变量的消费点在 _run_preflight_cli（CLI 层）；
            # 此处只锁「simulate_missing 参数」是唯一判定入口，env 不进本函数。
            self._install_deps()
            r = _pf_check_backend_deps(self.backend)
            self.assertEqual(r["status"], "ok")


class mock_env:
    """临时设置/还原环境变量的上下文管理器（零第三方依赖）。"""

    def __init__(self, **kwargs):
        self._kwargs = kwargs
        self._old = {}

    def __enter__(self):
        for k, v in self._kwargs.items():
            self._old[k] = os.environ.get(k)
            os.environ[k] = v
        return self

    def __exit__(self, *exc):
        for k, v in self._old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return False


if __name__ == "__main__":
    unittest.main()
