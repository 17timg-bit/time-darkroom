"use strict";

const $ = id => document.getElementById(id);
const {clamp, clock, wrapDay, timeAt} = Optics;
const modeButtons = [...document.querySelectorAll("[data-mode]")];
const ticks = [...$("time-scale").children];
const knots = [...document.querySelectorAll(".knot")];
const storageKey = "time-darkroom.plates.v1";
const limit = 12;
const motion = matchMedia("(prefers-reduced-motion: reduce)");
const library = [
  {id: "first", title: "一天穿过海岬", state: Optics.initial()},
  {id: "last", title: "最后一束日光", state: {mode: "still", minute: 1103, span: 1200, curve: [...Optics.MODES.still]}},
  {id: "return", title: "晨昏回环", state: {mode: "fold", minute: 725, span: 1200, curve: [...Optics.MODES.fold]}}
];
const note = {
  still: "整张照片取自同一分钟。选一颗亮点也能重新展开时间。",
  scan: "拖动亮点，让光线在不同位置先后抵达。",
  fold: "中间与两侧交替经过白昼和黑夜。"
};
const thumbnails = new WeakMap();
let plates = readPlates();
let state = Optics.initial();
let scene, printer, printSurface;
let frame = 0;
let lastFrame = 0;
let updateTime = 0;
let playing = false;
let probePosition = null;
let toastTimer = 0;
let rolling = false;

function readPlates() {
  try {
    const rows = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (!Array.isArray(rows)) return [];
    return rows.flatMap(row => {
      const data = Optics.cleanState(row?.state);
      if (!data || !/^[a-z0-9-]{4,64}$/.test(row?.id ?? "") ||
          typeof row.title !== "string" || row.title.length > 40) return [];
      return [{id: row.id, title: row.title, state: data}];
    }).slice(0, limit);
  } catch {
    return [];
  }
}

function savePlates() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(plates));
    return true;
  } catch {
    return false;
  }
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("visible"), 2500);
}

function setRange(input, value) {
  input.value = Math.round(value);
  const p = (value - Number(input.min)) / (Number(input.max) - Number(input.min));
  input.style.setProperty("--pct", `${clamp(p, 0, 1) * 100}%`);
}

function graphBounds() {
  const rect = $("graph").getBoundingClientRect();
  return {width: rect.width - 2, height: rect.height - 2, left: 13, top: 10};
}

function drawGraph() {
  const {width, height, left, top} = graphBounds();
  const w = width - left * 2, h = height - top * 2;
  if (w <= 0 || h <= 0) return;
  const canvas = $("graph-ink");
  const density = Math.min(devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(width * density), pixelHeight = Math.round(height * density);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const g = canvas.getContext("2d");
  g.setTransform(density, 0, 0, density, 0, 0);
  g.clearRect(0, 0, width, height);
  g.strokeStyle = "#35322b";
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 0; i < 5; i++) {
    const x = Math.round(left + i * w / 4) + .5;
    g.moveTo(x, top - 4);
    g.lineTo(x, top + h + 4);
  }
  for (let i = 0; i < 3; i++) {
    const y = Math.round(top + h * i / 2) + .5;
    g.moveTo(left, y);
    g.lineTo(width - left, y);
  }
  g.stroke();
  const points = state.curve.map((value, i) => [left + i * w / 4, top + (.5 - value) * h]);
  const area = g.createLinearGradient(0, top, 0, top + h);
  area.addColorStop(0, "#dc9f6561");
  area.addColorStop(1, "#dc9f6500");
  g.beginPath();
  for (const [x, y] of points) g.lineTo(x, y);
  g.lineTo(width - left, top + h);
  g.lineTo(left, top + h);
  g.closePath();
  g.fillStyle = area;
  g.fill();
  g.beginPath();
  for (const [x, y] of points) g.lineTo(x, y);
  g.strokeStyle = "#dfa670";
  g.lineWidth = 1.3;
  g.stroke();
  points.forEach(([x, y], i) => {
    const knot = knots[i];
    knot.style.left = `${x}px`;
    knot.style.top = `${y}px`;
    knot.setAttribute("aria-valuemin", "-50");
    knot.setAttribute("aria-valuemax", "50");
    knot.setAttribute("aria-valuenow", Math.round(state.curve[i] * 100));
    knot.setAttribute("aria-valuetext", clock(timeAt(state, i / 4)));
  });
}

function updateProbe() {
  const position = probePosition;
  $("probe").hidden = position === null || !$("show-probe").checked;
  if ($("probe").hidden) return;
  $("probe").style.setProperty("--x", `${100 * position}%`);
  const width = $("finder").clientWidth;
  $("probe").style.setProperty("--label-shift", `${clamp(-25, -width * position + 3, width * (1 - position) - 54)}px`);
  $("probe-time").textContent = clock(timeAt(state, position));
}

function updateControls() {
  const minute = wrapDay(Math.round(state.minute));
  setRange($("hour"), minute);
  setRange($("span"), state.span);
  $("hour-value").textContent = clock(state.minute);
  $("hour").setAttribute("aria-valuetext", clock(state.minute));
  const hours = +(state.span / 60).toFixed(2);
  $("span-value").textContent = `${hours} h`;
  $("span").setAttribute("aria-valuetext", `${hours} 小时`);
  for (const button of modeButtons) button.setAttribute("aria-pressed", button.dataset.mode === state.mode);
  $("span").disabled = state.mode === "still";
  $("mode-note").textContent = note[state.mode] ?? "已重新分配照片各处的时间。";
  ticks.forEach((tick, i) => { tick.textContent = clock(timeAt(state, i / 4)); });
  updateProbe();
  drawGraph();
}

function requestDraw() {
  if (!frame) frame = requestAnimationFrame(drawFrame);
}

function drawFrame(now) {
  frame = 0;
  if (playing && lastFrame && !document.hidden) state.minute = wrapDay(state.minute + Math.min(100, now - lastFrame) * .033);
  lastFrame = now;
  if (scene) {
    const density = Math.min(devicePixelRatio || 1, 1.6);
    const targetWidth = Math.min(1536, Math.max(16, Math.round($("finder").clientWidth * density)));
    scene.draw(state, targetWidth, Math.round(targetWidth * 9 / 16));
  }
  if (now - updateTime > 90) {
    updateControls();
    updateTime = now;
  }
  if (playing) requestDraw();
}

function interruptPlay() {
  if (playing) togglePlay();
}

function togglePlay() {
  if (!scene) return;
  playing = !playing;
  lastFrame = 0;
  $("view-status").textContent = playing ? "时间流动中" : "静止曝光";
  $("play-label").textContent = playing ? "暂停流动" : "让时间流动";
  $("play").setAttribute("aria-pressed", playing);
  requestDraw();
}

function setKnot(i, next) {
  const value = Math.round(clamp(next, -.5, .5) * 100) / 100;
  if (value === state.curve[i]) return;
  interruptPlay();
  state.mode = "custom";
  state.curve[i] = value;
  updateControls();
  requestDraw();
}

knots.forEach((node, i) => {
  let startY, startValue;
  node.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    startY = event.clientY;
    startValue = state.curve[i];
    node.setPointerCapture(event.pointerId);
  });
  node.addEventListener("pointermove", event => {
    if (!node.hasPointerCapture(event.pointerId)) return;
    const {height, top} = graphBounds();
    setKnot(i, startValue - (event.clientY - startY) / (height - 2 * top));
  });
  node.addEventListener("keydown", event => {
    const steps = {ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1};
    if (Object.hasOwn(steps, event.key)) {
      event.preventDefault();
      setKnot(i, state.curve[i] + steps[event.key] * (event.shiftKey ? .1 : .025));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setKnot(i, event.key === "Home" ? -.5 : .5);
    }
  });
});

function applyState(next) {
  interruptPlay();
  state = Optics.copy(next);
  updateControls();
  requestDraw();
}

for (const button of modeButtons) button.addEventListener("click", () => {
  const mode = button.dataset.mode;
  applyState({...state, mode, curve: [...Optics.MODES[mode]]});
});
for (const [id, property] of [["hour", "minute"], ["span", "span"]]) {
  $(id).addEventListener("input", event => {
    interruptPlay();
    state[property] = Number(event.target.value);
    updateControls();
    requestDraw();
  });
}
$("finder").addEventListener("pointermove", event => {
  const rect = $("finder").getBoundingClientRect();
  probePosition = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  updateProbe();
});
$("finder").addEventListener("pointerleave", () => {
  probePosition = null;
  updateProbe();
});
$("show-probe").addEventListener("change", updateProbe);
$("reset").addEventListener("click", () => applyState(Optics.initial()));
$("play").addEventListener("click", togglePlay);
$("help").addEventListener("click", () => $("manual").showModal());
$("print").addEventListener("click", makePlate);

const navLinks = [...document.querySelectorAll("nav a")];
function updateNav() {
  const target = location.hash === "#shelf" ? "#shelf" : "#darkroom";
  for (const link of navLinks) {
    if (link.hash === target) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}
addEventListener("hashchange", updateNav);
document.addEventListener("keydown", event => {
  if (event.defaultPrevented || event.repeat || event.ctrlKey || event.altKey || event.metaKey ||
      $("manual").open || event.target.closest("button, input, a")) return;
  if (event.code === "Space") {
    event.preventDefault();
    togglePlay();
  } else if (event.code === "KeyP") makePlate();
});

function makePlate() {
  if (!printer) return;
  if (plates.length >= limit) {
    toast("底片夹已满。移除一张底片后可继续冲印。");
    return;
  }
  const next = Number.parseInt(plates[0]?.title?.match(/\d+$/)?.[0] ?? "0", 10) + 1;
  const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  plates.unshift({id, title: `我的底片 ${String(next).padStart(2, "0")}`, state: Optics.copy(state)});
  const saved = savePlates();
  renderShelf();
  if (!motion.matches) {
    const flash = $("flash");
    flash.hidden = false;
    flash.classList.remove("fire");
    void flash.offsetWidth;
    flash.classList.add("fire");
  }
  toast(saved ? "已冲印。在底片夹中查看或导出。" : "已冲印。当前浏览器无法持久保存，请导出 PNG。");
}

$("flash").addEventListener("animationend", event => { event.currentTarget.hidden = true; });

function renderShelf() {
  const all = [...plates, ...library];
  $("shelf-count").textContent = String(all.length).padStart(2, "0");
  $("shelf-tally").textContent = `${plates.length} / ${limit} 自制底片`;
  const active = document.activeElement;
  const previousCard = active?.closest(".plate");
  const previousAction = active?.dataset.action;
  const cards = all.map(plate => {
    const card = document.createElement("article");
    card.className = "plate";
    card.dataset.plate = plate.id;
    const cover = document.createElement("button");
    cover.type = "button";
    cover.className = "plate-cover";
    cover.setAttribute("aria-label", `打开${plate.title}`);
    cover.dataset.action = "open";
    cover.disabled = !printer;
    cover.addEventListener("click", () => {
      applyState(plate.state);
      if (location.hash !== "#darkroom") location.hash = "darkroom";
      else $("darkroom").scrollIntoView();
      toast(`已取回「${plate.title}」`);
    });
    if (printer) {
      if (!thumbnails.has(plate)) {
        printer.draw(plate.state, 384, 216);
        thumbnails.set(plate, printSurface.toDataURL("image/jpeg", .84));
      }
      const image = new Image(384, 216);
      image.src = thumbnails.get(plate);
      image.alt = "";
      cover.append(image);
    }
    const meta = document.createElement("div");
    meta.className = "plate-meta";
    const title = document.createElement("h3");
    title.textContent = plate.title;
    const time = document.createElement("time");
    time.textContent = time.dateTime = clock(plate.state.minute);
    meta.append(title, time);
    const actions = document.createElement("div");
    actions.className = "plate-actions";
    const download = document.createElement("button");
    download.type = "button";
    download.className = "quiet";
    download.dataset.action = "export";
    download.textContent = "导出 PNG ↗";
    download.setAttribute("aria-label", `导出${plate.title}为 PNG`);
    download.disabled = !printer;
    download.addEventListener("click", () => exportPlate(plate));
    actions.append(download);
    if (plate.id.startsWith("p-")) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "quiet";
      remove.dataset.action = "remove";
      remove.textContent = "移除";
      remove.setAttribute("aria-label", `移除${plate.title}`);
      remove.addEventListener("click", () => {
        if (!confirm(`从底片夹移除「${plate.title}」？`)) return;
        plates = plates.filter(item => item !== plate);
        toast(savePlates() ? "已移除底片。" : "已从当前会话移除。");
        renderShelf();
      });
      actions.append(remove);
    }
    card.append(cover, meta, actions);
    return card;
  });
  $("plates").replaceChildren(...cards);
  if (previousCard) {
    const card = cards.find(element => element.dataset.plate === previousCard.dataset.plate);
    const sameControl = card?.querySelector(`[data-action="${previousAction}"]`);
    (sameControl || cards[0].querySelector(".plate-cover")).focus({preventScroll: true});
  }
}

async function exportPlate(plate) {
  if (!printer || rolling) return;
  rolling = true;
  try {
    const paper = document.createElement("canvas");
    paper.width = 2000;
    paper.height = 1350;
    const g = paper.getContext("2d");
    const x = 80, y = 118, width = 1840, height = 1035;
    printer.draw(plate.state, width, height);
    g.fillStyle = "#eae3d4";
    g.fillRect(0, 0, paper.width, paper.height);
    g.fillStyle = "#383129";
    g.font = "600 21px 'Consolas', monospace";
    g.fillText("TIME DARKROOM   /   THE CAPE LIGHT", x, 77);
    g.textAlign = "right";
    g.fillText("24-HOUR EXPOSURE STUDIES", paper.width - x, 77);
    g.textAlign = "left";
    g.drawImage(printSurface, x, y, width, height);
    g.strokeStyle = "#39332a";
    g.lineWidth = 2;
    g.strokeRect(x - 1, y - 1, width + 2, height + 2);
    g.font = "500 44px 'STSong', 'Songti SC', 'SimSun', serif";
    g.fillText(plate.title, x, 1231);
    g.font = "19px 'Consolas', monospace";
    g.fillStyle = "#615546";
    g.fillText("TIME DARKROOM  /  01", x, 1297);
    g.strokeStyle = "#8f8070";
    g.beginPath();
    g.moveTo(1432, 1244);
    g.lineTo(1920, 1244);
    g.stroke();
    g.font = "20px 'Consolas', monospace";
    for (let i = 0; i < 5; i++) {
      const spot = 1432 + i * 122;
      g.textAlign = i === 0 ? "left" : i === 4 ? "right" : "center";
      g.fillText(clock(timeAt(plate.state, i / 4)), spot, 1285);
      g.fillRect(spot - 1, 1238, 2, 13);
    }
    const blob = await new Promise(resolve => paper.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("PNG could not be encoded");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `时间暗房 - ${plate.title}.png`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast("已发起 PNG 下载。");
  } catch (error) {
    console.error(error);
    toast("冲印失败，请稍后重试。");
  } finally {
    rolling = false;
  }
}

function oceanSound() {
  const audio = new AudioContext();
  const samples = audio.createBuffer(2, audio.sampleRate * 11, audio.sampleRate);
  for (let channel = 0; channel < samples.numberOfChannels; channel++) {
    const data = samples.getChannelData(channel);
    let low = 0, mid = 0;
    for (let i = 0; i < data.length; i++) {
      const noise = Math.random() * 2 - 1;
      low += (noise - low) * .012;
      mid += (noise - mid) * .112;
      const position = i / data.length;
      const swell = .59 + .28 * Math.cos(position * Math.PI * 4 + .5) + .13 * Math.sin(position * Math.PI * 6);
      const seam = Math.min(1, i / 300, (data.length - 1 - i) / 300);
      data[i] = (low * .68 + mid * .27) * swell * seam;
    }
  }
  const waves = audio.createBufferSource();
  const gain = audio.createGain();
  gain.gain.value = 0;
  waves.buffer = samples;
  waves.loop = true;
  waves.connect(gain).connect(audio.destination);
  waves.start();
  return {audio, gain};
}

let audioBed;
$("sound").addEventListener("change", async event => {
  const input = event.currentTarget;
  try {
    if (!audioBed && input.checked) audioBed = oceanSound();
    if (!audioBed) return;
    const {audio, gain} = audioBed;
    if (input.checked) await audio.resume();
    gain.gain.setTargetAtTime(input.checked ? .58 : 0, audio.currentTime, .16);
  } catch (error) {
    console.error(error);
    input.checked = false;
    toast("当前浏览器无法开启海声。");
  }
});

new ResizeObserver(() => { drawGraph(); requestDraw(); }).observe($("finder"));
new ResizeObserver(drawGraph).observe($("graph"));
document.addEventListener("visibilitychange", () => { lastFrame = 0; });

function unavailable(message) {
  scene = printer = null;
  playing = false;
  $("loading").hidden = false;
  $("loading").textContent = message;
  $("print").disabled = $("play").disabled = true;
  renderShelf();
}

async function start() {
  updateControls();
  updateNav();
  renderShelf();
  try {
    const [photo, mask] = await Promise.all([Optics.loadImage(CAPE.photo), Optics.loadImage(CAPE.mask)]);
    const canvas = $("scene");
    printSurface = document.createElement("canvas");
    scene = Optics.createRenderer(canvas, photo, mask);
    printer = Optics.createRenderer(printSurface, photo, mask);
    for (const surface of [canvas, printSurface]) surface.addEventListener("webglcontextlost", () => {
      unavailable("图形上下文已中断，请重新载入暗房。");
    });
    requestDraw();
    renderShelf();
    $("loading").hidden = true;
    $("print").disabled = false;
  } catch (error) {
    console.error(error);
    unavailable("暗房需要启用 WebGL。请在支持 WebGL 的浏览器中打开。");
  }
}
start();
