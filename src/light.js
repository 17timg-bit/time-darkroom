/* A lightweight, locally evaluated sky probability map for a single photograph. */
const Light = (() => {
  const masks = new WeakMap();
  const width = 192, height = 108;

  function photoMask(image) {
    if (masks.has(image)) return masks.get(image);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", {alpha: false, willReadFrequently: true});
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    const {data} = pixels;
    const total = width * height;
    const luma = new Float32Array(total);
    const score = new Float32Array(total);
    const detail = new Float32Array(total);
    const [bias, vertical, value, hue, edges, warmth] = FIELD_LIGHT.sky;
    for (let i = 0; i < total; i++) {
      const p = i * 4;
      luma[i] = (.2126 * data[p] + .7152 * data[p + 1] + .0722 * data[p + 2]) / 255;
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const p = i * 4, v = luma[i];
        const r = data[p] / 255, g = data[p + 1] / 255, b = data[p + 2] / 255;
        const texture = Math.abs(v - luma[x > 0 ? i - 1 : i])
          + Math.abs(v - luma[x < width - 1 ? i + 1 : i])
          + Math.abs(v - luma[y > 0 ? i - width : i])
          + Math.abs(v - luma[y < height - 1 ? i + width : i]);
        const logit = bias + vertical * (1 - 2 * y / height) + value * (2 * v - 1)
          + hue * (b - r) + edges * Math.min(1, texture * 3) + warmth * Math.abs(r - g);
        score[i] = 1 / (1 + Math.exp(-logit));
        detail[i] = Math.min(1, texture * 2.6);
      }
    }
    // A blue lake or a bright facade should not become sky simply because its colors match.
    const connected = new Uint8Array(total);
    const queue = new Uint32Array(total);
    let tail = 0;
    const visit = (i, cutoff) => {
      if (connected[i] || score[i] < cutoff) return;
      connected[i] = 1;
      queue[tail++] = i;
    };
    for (let x = 0; x < width; x++) visit(x, .80);
    for (let head = 0; head < tail; head++) {
      const i = queue[head], x = i % width;
      if (x > 0) visit(i - 1, .58);
      if (x < width - 1) visit(i + 1, .58);
      if (i >= width) visit(i - width, .58);
      if (i < total - width) visit(i + width, .58);
    }
    const confidence = tail > total * .86 || tail < total * .02 ? 0 : 1;
    for (let i = 0; i < total; i++) {
      const p = i * 4;
      const sky = Math.min(1, Math.max(0, (score[i] - .56) / .37)) * connected[i] * confidence;
      data[p] = Math.round(sky * 255);
      data[p + 1] = Math.round(detail[i] * 255);
      data[p + 2] = 0;
    }
    context.putImageData(pixels, 0, 0);
    masks.set(image, canvas);
    return canvas;
  }

  return {photoMask};
})();
