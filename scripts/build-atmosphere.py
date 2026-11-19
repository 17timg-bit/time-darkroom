"""Pack the 57 ground-level Prague Sky Model slices for WebGL."""
import argparse
import base64
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("radiance", type=Path)
    parser.add_argument("--output", type=Path, default=Path("assets/atmosphere.js"))
    args = parser.parse_args()

    radiance = np.fromfile(args.radiance, dtype="<f4").reshape(57, 20, 48, 3)
    assert np.isfinite(radiance).all() and radiance.min() >= 0
    luminance = radiance @ np.array([0.2126, 0.7152, 0.0722])
    reference = np.median(luminance[24, 4:12, 2:35])
    # Per-channel log encoding retains both horizon highlights and dim twilight.
    encoded = np.clip((np.log2(np.maximum(radiance / reference, 2**-13)) + 13) / 17, 0, 1)
    pixels = np.rint(encoded.reshape(1140, 48, 3) * 255).astype(np.uint8)
    data = BytesIO()
    Image.fromarray(pixels, "RGB").save(data, format="PNG", optimize=True)
    payload = base64.b64encode(data.getvalue()).decode("ascii")
    args.output.write_text(
        "// Derived from the Prague Sky Model Ground dataset, Apache-2.0. See docs/暮光模型.md.\n"
        f'const ATMOSPHERE = "data:image/png;base64,{payload}";\n',
        encoding="utf-8", newline="\n",
    )
    print(f"48 × 1140, 57 solar elevations, {len(data.getvalue())} bytes as PNG")


if __name__ == "__main__":
    main()
