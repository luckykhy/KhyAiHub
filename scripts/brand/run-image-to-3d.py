#!/usr/bin/env python
"""Local image-to-3D (StableFast3D) runner for the Khy OS realistic pet form.

STATUS: **NOT RUNNABLE AS IS** (verified 2026-11-04).  Kept because the
model weights and the venv are already on disk, and the official `sf3d`
package becomes usable the moment a machine with a working Python (not
3.13-only) shows up.  Read the notes below before trusting any of it.

WHY LOCAL
---------
Every external 3D service this machine can reach is missing exactly one thing:
an API token.  replicate / siliconflow / dashscope answer HTTP 401; tripo, meshy,
huggingface.co and openai are unreachable from this network; the only reachable
image service (agnes) has no 3D model at all.  But hf-mirror.com IS reachable and
mirrors the StableFast3D weights, so the model can run here instead.

WHY THE OFFICIAL `sf3d` PACKAGE (not diffusers)
------------------------------------------------
`diffusers 0.42.1` has **no** `StableFast3DPipeline` (verified: no
`pipelines/stable_fast_3d`, no `pipelines/triposr`, not even in
`pipelines/deprecated/`; `grep StableFast3D` over the package is empty).
The official implementation lives in the separate `sf3d` package, which is
**not on PyPI** (`https://pypi.org/pypi/sf3d/json` -> 404) and must be built
from the GitHub source.  Its native dependencies are the blocker here:

  * `texture_baker`  -- a Rust crate (wgpu based)
  * `uv_unwrapper`   -- a C++ extension

Neither ships Windows wheels, and the official `install.sh` is a Linux/macOS
script.  Alternatives were checked and ruled out:

  * TRELLIS / Hunyuan3D -- CUDA-only extensions (kaolin / nvdiffrast /
    diff_gaussian_rasterization); cannot be built here.
  * TripoSR -- pure PyTorch and CPU-friendly, but `diffusers 0.42.1` removed
    `TripoSRPipeline`, it depends on `torchmcubes` (not on PyPI), and the
    underlying `PyMCubes` wheels stop at cp312 while the only Python on this
    box is 3.13 (Blender's).

Model weights come from the hf-mirror.com mirror (HF_ENDPOINT), because
huggingface.co itself times out here.  They are already downloaded and
sha256-verified at:
    D:\\Portable\\2-tools\\models\\stable-fast-3d\\model.safetensors
    sha256 a3416e1cf654e7d4f5e75f116cec2c3f0a14501a77d30c2f6068bbda178de388

Until the pipeline is swapped to the official `sf3d` implementation, the
third pet form is filled by `build-pet-realistic-relief.py` (a 2.5D relief
baked from the realistic source art) instead.

Usage:
    python scripts/brand/run-image-to-3d.py --input <png> --output <glb>
    python scripts/brand/run-image-to-3d.py --input <png> --output <glb> --steps 3
"""

from __future__ import annotations

import argparse
import os
import sys
import time


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Run StableFast3D locally on CPU")
    p.add_argument("--input", required=True, help="input image (PNG)")
    p.add_argument("--output", required=True, help="output GLB path")
    p.add_argument(
        "--model",
        default="stabilityai/stable-fast-3d",
        help="HF repo id (pulled through HF_ENDPOINT mirror)",
    )
    p.add_argument("--steps", type=int, default=4, help="inference steps (fewer = faster on CPU)")
    p.add_argument("--size", type=int, default=512, help="input resolution")
    p.add_argument(
        "--foreground-ratio",
        type=float,
        default=0.85,
        help="foreground ratio used when the input has no alpha channel",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()

    endpoint = os.environ.get("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ.setdefault("HF_ENDPOINT", endpoint)
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    print(f"[image-to-3d] HF_ENDPOINT={endpoint}")

    import numpy as np
    import torch
    from diffusers import StableFast3DPipeline
    from PIL import Image

    # CPU only, and keep the thread count sane so the box stays responsive.
    device = "cuda" if torch.cuda.is_available() else "cpu"
    torch.set_grad_enabled(False)
    print(f"[image-to-3d] device={device} threads={torch.get_num_threads()}")

    pipeline = StableFast3DPipeline.from_pretrained(
        args.model,
        torch_dtype=torch.float32,
        trust_remote_code=True,
    )
    pipeline = pipeline.to(device)
    try:
        pipeline.enable_attention_slicing()
    except Exception:
        pass

    image = Image.open(args.input).convert("RGB")
    print(f"[image-to-3d] input={args.input} size={image.size}")

    t0 = time.time()
    result = pipeline(
        image,
        num_inference_steps=args.steps,
        foreground_ratio=args.foreground_ratio,
        size=args.size,
        output_type="glb",
    )
    elapsed = time.time() - t0
    print(f"[image-to-3d] inference {elapsed:.1f}s")

    outputs = result.outputs if hasattr(result, "outputs") else result
    glb = None
    for candidate in (outputs, result):
        if isinstance(candidate, (list, tuple)):
            for item in candidate:
                if hasattr(item, "export"):
                    glb = item
                    break
        elif hasattr(candidate, "export"):
            glb = candidate
        if glb is not None:
            break
    if glb is None:
        print("[image-to-3d] no mesh in pipeline output:", type(result), file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    glb.export(args.output)
    size_bytes = os.path.getsize(args.output)
    print(f"[image-to-3d] wrote {args.output} ({size_bytes} bytes)")

    # Report the mesh bounds so the normalization step can be sanity-checked.
    try:
        import trimesh

        mesh = trimesh.load(args.output, force="mesh")
        print(
            "[image-to-3d] bounds(min,max)=%s .. %s  faces=%d"
            % (
                np.round(mesh.bounds[0].tolist(), 4).tolist(),
                np.round(mesh.bounds[1].tolist(), 4).tolist(),
                len(mesh.faces),
            )
        )
    except Exception as exc:  # pragma: no cover - diagnostics only
        print(f"[image-to-3d] mesh stats unavailable: {exc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
