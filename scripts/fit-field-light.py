"""Fit a small sky classifier and a terrain exposure response from public timelapses."""
import argparse
import json
from pathlib import Path
import subprocess

import imageio_ffmpeg
import numpy as np


WIDTH, HEIGHT = 192, 108
LUMA = np.array([0.2126, 0.7152, 0.0722])
# Seconds in the published clips, then rectangular sky and terrain samples in normalized coordinates.
SCENES = {
    "belfort.webm": (0.25, 9.8, [(0.05, .06, .36, .49), (.67, .06, .94, .56)], [(.06, .82, .95, .96)]),
    "dawncoast.webm": (0.6, 17.7, [(.04, .06, .34, .48), (.63, .05, .94, .51)], [(.09, .78, .95, .96)]),
    "funchal.webm": (8.4, 43, [(.34, .08, .62, .39)], [(.13, .62, .55, .79), (.84, .08, .94, .70)]),
    "grandcanyon.webm": (17, 39.4, [(.04, .025, .95, .24)], [(.08, .51, .95, .93)]),
    "libreville.webm": (.35, 14.6, [(.05, .06, .94, .47)], [(.07, .64, .96, .95)]),
    "newyork.ogv": (3.5, 54, [(.35, .06, .72, .50)], [(.03, .29, .16, .91), (.88, .37, .96, .91)]),
    "smalltown.webm": (.30, 10.46, [(.09, .06, .92, .50)], [(.07, .77, .94, .96)]),
    "tokyo.webm": (.70, 29.4, [(.05, .06, .96, .54)], [(.04, .92, .36, .98), (.53, .94, .95, .99)]),
    "yokote.webm": (.7, 29.5, [(.06, .06, .94, .54)], [(.08, .69, .96, .94)]),
}


def read_clip(path, start, end):
    duration = end - start
    command = [imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-ss", str(start), "-t", str(duration),
               "-i", str(path), "-an", "-vf", f"fps={40 / duration},scale={WIDTH}:{HEIGHT}:flags=area",
               "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]
    frames = subprocess.run(command, capture_output=True, check=True).stdout
    return np.frombuffer(frames, np.uint8).reshape(-1, HEIGHT, WIDTH, 3) / 255.0


def features(image):
    """Same features as Light.photoMask in the browser."""
    luma = image @ LUMA
    padded = np.pad(luma, 1, mode="edge")
    texture = sum(np.abs(luma - n) for n in (padded[:-2, 1:-1], padded[2:, 1:-1],
                                             padded[1:-1, :-2], padded[1:-1, 2:]))
    r, g, b = np.moveaxis(image, -1, 0)
    row = np.broadcast_to(np.arange(HEIGHT)[:, None] / HEIGHT, luma.shape)
    return np.stack((np.ones_like(luma), 1 - 2 * row, 2 * luma - 1, b - r,
                     np.clip(texture * 3, 0, 1), np.maximum(r, g) - np.minimum(r, g)), axis=-1)


def region_patches(array, rects, step=1):
    return np.concatenate([
        array[int(top * HEIGHT):int(bottom * HEIGHT):step, int(left * WIDTH):int(right * WIDTH):step]
        .reshape((-1,) + array.shape[2:])
        for left, top, right, bottom in rects
    ])


def read_examples(path, spec):
    start, end, sky, terrain = spec
    training = []
    measurements = []
    frames = read_clip(path, start, end)
    assert 30 <= len(frames) <= 42, (path, len(frames))
    for image in frames:
        table = features(image)
        for label, rects in enumerate((terrain, sky)):
            x = region_patches(table, rects, step=5)
            training.append(np.column_stack((x, np.full(len(x), label))))
        linear = np.where(image <= .04045, image / 12.92, ((image + .055) / 1.055) ** 2.4) @ LUMA
        measurements.append([np.median(region_patches(linear, rects)) for rects in (sky, terrain)])
    return np.concatenate(training), np.array(measurements), len(frames)


def train_classifier(examples):
    x, y = examples[:, :-1], examples[:, -1]
    weights = np.where(y == 1, .5 / np.sum(y == 1), .5 / np.sum(y == 0))
    ridge = np.eye(x.shape[1]) * .0015
    ridge[0, 0] = 0
    coefficients = np.zeros(x.shape[1])
    for _ in range(14):
        p = 1 / (1 + np.exp(-np.clip(x @ coefficients, -35, 35)))
        gradient = x.T @ (weights * (p - y)) + ridge @ coefficients
        hessian = x.T @ (weights[:, None] * (p * (1 - p))[:, None] * x) + ridge
        coefficients -= np.linalg.solve(hessian, gradient)
    return coefficients


def terrain_slopes(measurements):
    slopes = {}
    for name, values in measurements.items():
        daylight = values[np.argsort(values[:, 0])[-8:]]
        delta = np.log2((values + .003) / (np.median(daylight, axis=0) + .003))
        x, y = delta.T
        selected = (x < -.32) & (values[:, 1] > .0014) & (y < .15)
        if selected.sum() >= 6:
            slope = float(np.sum(x[selected] * y[selected]) / np.sum(x[selected] ** 2))
            if slope > .2:
                slopes[name] = slope
    return slopes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("clips", type=Path)
    parser.add_argument("--output", type=Path, default=Path("assets/field-light.js"))
    args = parser.parse_args()
    examples, measurements, frames = {}, {}, 0
    for name, spec in SCENES.items():
        examples[name], measurements[name], count = read_examples(args.clips / name, spec)
        frames += count
    for name, held_out in examples.items():
        fit = train_classifier(np.concatenate([data for key, data in examples.items() if key != name]))
        correct = (held_out[:, :-1] @ fit > 0) == held_out[:, -1]
        balanced = sum(correct[held_out[:, -1] == y].mean() for y in (0, 1)) / 2
        print(f"{name:18s} held-out region accuracy {balanced:.1%}")
    fit = train_classifier(np.concatenate(list(examples.values())))
    slopes = terrain_slopes(measurements)
    assert len(slopes) >= 3, slopes
    terrain = float(np.clip(np.median(list(slopes.values())), .65, 1.35))
    model = {"sky": fit.round(7).tolist(), "terrainStops": round(terrain, 6)}
    args.output.write_text(
        "// Fitted by scripts/fit-field-light.py. Source credits are in docs/暮光模型.md.\n"
        f"const FIELD_LIGHT = {json.dumps(model, ensure_ascii=False)};\n",
        encoding="utf-8", newline="\n",
    )
    print(f"{frames} frames in {len(examples)} real scenes and {sum(map(len, examples.values()))} labeled pixels")
    print("Per-scene terrain slopes:", slopes)
    print(model)


if __name__ == "__main__":
    main()
