# @pattern Template Method
"""Support for python -m khy_platform."""
import sys

try:
    from khy_platform.cli import main
except ImportError as e:
    print(f"\nError: {e}", file=sys.stderr)
    print("\nThe khy OS package appears to be installed incorrectly.", file=sys.stderr)
    print("This usually happens when pip cannot download build dependencies.", file=sys.stderr)
    print("\nFix: Run these two commands first, then reinstall:", file=sys.stderr)
    # 默认给**官方源**（PROCESS-013）：仓库不引导用户使用第三方镜像。
    # 网络受限时用户可自行配置代理，或设 KHY_USE_CN_MIRROR=1 让 khy 在运行时
    # 选用国内镜像（该开关只影响 khy 自身的下载，不改这里的 pip 建议）。
    print("  pip config set global.index-url https://pypi.org/simple/", file=sys.stderr)
    print("\nThen reinstall:", file=sys.stderr)
    print("  pip install --force-reinstall khy-os", file=sys.stderr)
    print("  Fallback: pip install --force-reinstall khy-quant", file=sys.stderr)
    sys.exit(1)

main()
