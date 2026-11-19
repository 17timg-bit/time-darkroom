const LocalExposure = (() => {
  const $ = id => document.getElementById(id);
  const finder = $("finder");
  const layer = $("spot-layer");
  const editor = $("spot-editor");
  const {ASPECT, SPOT_LIMIT, clamp, clock, wrapDay} = Optics;
  const arrowStep = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};
  const history = [];
  let read, write, refreshProbe;
  let selected = 0;
  let drag = null;
  let rangeEdit = null;
  const editing = () => !editor.hidden;
  const point = value => Math.round(clamp(value, 0, 1) * 1000) / 1000;
  const label = index => String(index + 1).padStart(2, "0");
  const announce = message => { $("spot-status").textContent = message; };

  function makeMarker(index) {
    const number = label(index);
    const ring = document.createElement("span");
    ring.className = "spot-ring";
    ring.setAttribute("aria-hidden", "true");
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "spot-pin";
    pin.textContent = number;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "spot-chip";
    layer.append(ring, pin);
    $("spot-choices").append(chip);

    const select = () => {
      selected = index;
      render();
    };
    chip.addEventListener("click", select);
    pin.addEventListener("click", select);
    pin.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !event.isPrimary) return;
      const spot = read().spots[index];
      if (!spot) return;
      const rect = finder.getBoundingClientRect();
      drag = {id: event.pointerId, index, width: rect.width, height: rect.height,
        x: spot.x, y: spot.y, startX: event.clientX, startY: event.clientY, recorded: false};
      pin.setPointerCapture(event.pointerId);
      select();
    });
    pin.addEventListener("pointermove", event => {
      if (drag?.id !== event.pointerId || drag.index !== index) return;
      const x = point(drag.x + (event.clientX - drag.startX) / drag.width);
      const y = point(drag.y + (event.clientY - drag.startY) / drag.height);
      if (patch(index, {x, y}, !drag.recorded)) drag.recorded = true;
    });
    pin.addEventListener("lostpointercapture", event => {
      if (drag?.id === event.pointerId) drag = null;
    });
    pin.addEventListener("keydown", event => {
      const step = arrowStep[event.key];
      if (!step) return;
      event.preventDefault();
      const spot = read().spots[index];
      const amount = event.shiftKey ? .035 : .008;
      select();
      patch(index, {x: point(spot.x + step[0] * amount), y: point(spot.y + step[1] * amount)});
    });
    return {ring, pin, chip};
  }
  const markers = Array.from({length: SPOT_LIMIT}, (_, index) => makeMarker(index));

  function render() {
    const spots = read().spots;
    selected = clamp(selected, 0, Math.max(0, spots.length - 1));
    const active = spots[selected];
    $("spot-toggle").setAttribute("aria-expanded", editing());
    $("probe-hint").hidden = editing();
    $("spot-count").hidden = !spots.length;
    $("spot-count").textContent = spots.length;
    $("spot-add").disabled = spots.length >= SPOT_LIMIT;
    $("spot-add").title = spots.length === SPOT_LIMIT ? "一张底片最多三处局部曝光" : "在画面中加入一个曝光圈";
    $("spot-undo").disabled = !history.length;
    $("spot-parameters").hidden = !active;
    layer.hidden = !editing() || !active;
    const reel = read().field;
    const available = active && reel ? clock(Field.sampledMinute(reel, active.minute)) : "";
    $("spot-guidance").textContent = active
      ? (available && available !== clock(active.minute) ? `该时刻超出照片范围，取最近的 ${available}。` : "拖动圈心移动，羽化决定边缘过渡。")
      : "点画面放一个曝光圈，再为它选时刻。";
    markers.forEach(({ring, pin, chip}, index) => {
      const spot = spots[index];
      ring.hidden = pin.hidden = chip.hidden = !spot;
      if (!spot) return;
      const chosen = index === selected;
      ring.classList.toggle("is-active", chosen);
      pin.classList.toggle("is-active", chosen);
      for (const node of [ring, pin]) {
        node.style.setProperty("--spot-x", `${spot.x * 100}%`);
        node.style.setProperty("--spot-y", `${spot.y * 100}%`);
      }
      ring.style.setProperty("--spot-width", `${spot.radius * 200 / ASPECT}%`);
      ring.style.setProperty("--spot-height", `${spot.radius * 200}%`);
      ring.style.setProperty("--spot-inset", `${spot.feather * 50}%`);
      const time = clock(spot.minute);
      chip.textContent = `${label(index)}  ${time}`;
      chip.setAttribute("aria-label", `选择第 ${index + 1} 处曝光，时刻 ${time}`);
      chip.setAttribute("aria-pressed", chosen);
      pin.setAttribute("aria-label", `移动第 ${index + 1} 处曝光，时刻 ${time}。方向键移动。`);
      pin.title = `${label(index)} · ${time}`;
    });
    if (active) {
      $("spot-time").value = clock(active.minute);
      for (const name of ["radius", "feather"]) {
        const slider = $("spot-" + name);
        slider.value = Math.round(active[name] * 100);
        const fill = (Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min));
        slider.style.setProperty("--fill", `${100 * fill}%`);
        const percent = `${slider.value}%`;
        $("spot-" + name + "-value").textContent = percent;
        slider.setAttribute("aria-valuetext", name === "radius" ? `取景框高度的 ${percent}` : percent);
      }
    }
  }

  function undoPoint() {
    history.push({spots: read().spots, selected});
    if (history.length > 16) history.shift();
  }

  function commit(spots) {
    write(spots);
    render();
  }

  function patch(index, change, record = true) {
    const spots = read().spots;
    const prior = spots[index];
    if (!prior || Object.keys(change).every(key => change[key] === prior[key])) return false;
    if (record) undoPoint();
    commit(spots.map((spot, i) => i === index ? {...spot, ...change} : spot));
    return true;
  }

  function addSpot(x, y) {
    const state = read();
    if (state.spots.length >= SPOT_LIMIT) {
      announce("一张底片最多三处局部曝光。");
      return;
    }
    const base = Optics.sampleTime(state, x, y);
    const hour = wrapDay(base);
    let minute = hour >= 420 && hour < 1080 ? 1200 : 630;
    const reel = state.field;
    if (reel?.times.length > 1) {
      const first = reel.times[0], last = reel.times.at(-1);
      const sampled = Field.sampledMinute(reel, base);
      minute = wrapDay(sampled - first < last - sampled ? last : first);
    }
    const first = !state.spots.length;
    undoPoint();
    selected = state.spots.length;
    commit([...state.spots, {x, y, radius: .25, feather: .62, minute}]);
    if (first) editor.scrollIntoView({block: "nearest", behavior: "instant"});
    announce(`已添加第 ${selected + 1} 处局部曝光。`);
  }

  function setEditing(open) {
    editor.hidden = !open;
    rangeEdit = null;
    render();
    refreshProbe();
    if (open) editor.scrollIntoView({block: "nearest", behavior: "instant"});
  }

  function sync(reset = false) {
    if (reset) {
      history.length = 0;
      selected = 0;
      rangeEdit = null;
      drag = null;
    }
    render();
  }

  function mount(readState, updateSpots, updateProbe) {
    read = readState;
    write = updateSpots;
    refreshProbe = updateProbe;
    $("spot-toggle").addEventListener("click", () => setEditing(!editing()));
    finder.addEventListener("click", event => {
      if (!editing() || event.target.closest(".spot-pin")) return;
      const bounds = finder.getBoundingClientRect();
      addSpot(point((event.clientX - bounds.left) / bounds.width), point((event.clientY - bounds.top) / bounds.height));
    });
    $("spot-add").addEventListener("click", () => {
      const [x, y] = [[.50, .50], [.70, .40], [.29, .65]][read().spots.length] ?? [.50, .50];
      addSpot(x, y);
      if ($("spot-add").disabled) markers[selected].chip.focus({preventScroll: true});
    });
    $("spot-remove").addEventListener("click", () => {
      const previous = selected;
      undoPoint();
      commit(read().spots.filter((_, index) => index !== previous));
      (read().spots.length ? markers[selected].chip : $("spot-add")).focus({preventScroll: true});
      announce("已移除此处曝光。");
    });
    $("spot-undo").addEventListener("click", () => {
      const previous = history.pop();
      if (!previous) return;
      selected = previous.selected;
      commit(previous.spots);
      if (!$("spot-undo").disabled) $("spot-undo").focus({preventScroll: true});
      else (read().spots.length ? markers[selected].chip : $("spot-add")).focus({preventScroll: true});
      announce("已撤销上一次局部调整。");
    });
    $("spot-time").addEventListener("change", event => {
      const minute = Field.parseTime(event.target.value);
      if (minute === null) render();
      else patch(selected, {minute});
    });
    for (const name of ["radius", "feather"]) {
      const slider = $("spot-" + name);
      slider.addEventListener("input", () => {
        const changed = patch(selected, {[name]: Number(slider.value) / 100}, rangeEdit !== slider);
        if (changed) rangeEdit = slider;
      });
      for (const event of ["change", "blur", "pointercancel"]) {
        slider.addEventListener(event, () => { rangeEdit = null; });
      }
    }
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || !editing() || document.querySelector("dialog[open]")) return;
      setEditing(false);
      $("spot-toggle").focus({preventScroll: true});
    });
    render();
  }
  return {mount, sync, editing};
})();
