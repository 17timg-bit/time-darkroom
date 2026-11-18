"""Build offline sky textures from the HYG v4.1 CSV and NASA SVS Moon Kit JPEG."""
import argparse
import base64
import csv
import io
import math
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent


def emit(name, constant, image, image_format, credit, **options):
    buffer = io.BytesIO()
    image.save(buffer, format=image_format, **options)
    url = f"data:image/{image_format.lower()};base64," + base64.b64encode(buffer.getvalue()).decode()
    path = ROOT / "assets" / name
    path.write_text(f'/* {credit} */\nconst {constant} = "{url}";\n', encoding="utf-8", newline="\n")
    print(f"{name}: {image.size}, {path.stat().st_size} bytes")


def star_color(index):
    # Approximate broad-band tint. Keep stars close to neutral in the exposure.
    warmth = max(0, min(1, (index + .35) / 2.0))
    return (.76 + .24 * warmth, .87 + .13 * (1 - abs(2 * warmth - 1)), 1 - .29 * warmth)


def make_atlas(path):
    w, h = 4096, 2048
    image = Image.new("RGB", (w, h))
    pixel = image.load()
    total = 0
    with path.open(encoding="utf-8", newline="") as file:
        for star in csv.DictReader(file):
            magnitude = float(star["mag"] or 100)
            if star["id"] == "0" or not star["hip"] or magnitude > 6.15:
                continue
            ra, dec = float(star["ra"]), float(star["dec"])
            x = ra * w / 24 - .5
            y = (.5 - dec / 180) * h - .5
            strength = min(1, .76 * 10 ** (-.23 * (magnitude - 1)))
            tint = star_color(float(star["ci"] or .55))
            stretch = max(.14, math.cos(math.radians(dec)))
            sigma = .58 + .36 * strength
            for j in range(max(0, int(y - 3)), min(h, int(y + 4))):
                for i in range(int(x - 3 / stretch), int(x + 4 / stretch)):
                    r2 = ((i - x) * stretch) ** 2 + (j - y) ** 2
                    light = 255 * strength * math.exp(-r2 / (2 * sigma * sigma))
                    rgb = pixel[i % w, j]
                    pixel[i % w, j] = tuple(min(255, old + round(light * color)) for old, color in zip(rgb, tint))
            total += 1
    print(f"{total} Hipparcos-linked stars (HYG v4.1, V <= 6.15)")
    return image


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("hyg", type=Path)
    parser.add_argument("lroc", type=Path)
    args = parser.parse_args()
    emit("stars.js", "SKY_STARS", make_atlas(args.hyg), "PNG",
         "Derived from HYG v4.1 by David Nash / Astronomy Nexus; CC BY-SA 4.0. See docs/天象模型.md.",
         optimize=True)
    with Image.open(args.lroc) as original:
        moon = original.convert("RGB")
    emit("moon.js", "MOON_MAP", moon, "WEBP",
         "Moon albedo: NASA SVS CGI Moon Kit, Ernie Wright, NASA/LRO/GSFC/ASU. See docs/天象模型.md.",
         quality=88, method=6)
