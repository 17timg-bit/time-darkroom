"use strict";

const Film = (() => {
  const {ASPECT, DAY, clamp, clock, copy, wrapDay} = Optics;
  const fps = 24;
  const encoding = {width: 1280, height: 720, frameRate: fps, bitrate: 3_800_000, latencyMode: "quality"};
  const specifications = "720p · 24 帧/秒 · 无声";
  const version = document.querySelector('meta[name="application-version"]').content;
  let encoder;

  function loadEncoder() {
    encoder ??= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `vendor/mediabunny.min.js?v=${version}`;
      script.onload = () => resolve(globalThis.Mediabunny);
      script.onerror = () => { script.remove(); reject(new Error("编码组件加载失败")); };
      document.head.append(script);
    }).catch(error => {
      encoder = null;
      throw error;
    });
    return encoder;
  }

  async function availableFormats() {
    if (!globalThis.VideoEncoder || !globalThis.VideoFrame) return [];
    const media = await loadEncoder();
    const options = [
      {codec: "avc", label: "MP4", format: () => new media.Mp4OutputFormat({fastStart: "in-memory"})},
      {codec: "vp9", label: "WebM", format: () => new media.WebMOutputFormat()},
      {codec: "vp8", label: "WebM", format: () => new media.WebMOutputFormat()}
    ];
    const supported = await Promise.all(options.map(async option => {
      const capable = await media.canEncodeVideo(option.codec, encoding).catch(() => false);
      return capable ? option : null;
    }));
    return supported.filter(Boolean);
  }

  function shiftedTime(base, delta) {
    const minute = base.minute + delta;
    return {
      minute: wrapDay(minute),
      date: base.field ? base.date : Sky.advanceDate(base.date, Math.floor(minute / DAY))
    };
  }

  function shiftBounds(base) {
    return [
      base.date === Sky.firstDate && !base.field ? Math.max(-720, Math.ceil(-base.minute)) : -720,
      base.date === Sky.lastDate && !base.field ? Math.min(720, Math.max(0, Math.floor(DAY - 1 - base.minute))) : 720
    ];
  }

  function initialShift(base) {
    if (base.field?.times.length >= 2) {
      const times = base.field.times;
      const distance = time => wrapDay(time - base.minute + DAY / 2) - DAY / 2;
      const next = distance(times.at(-1));
      return Math.round(Math.abs(next) < 1 ? distance(times[0]) : next);
    }
    return base.date === Sky.lastDate && base.minute > 1200 ? -480 : 480;
  }

  function frameAt(clip, phase) {
    const mix = (1 - Math.cos(2 * Math.PI * phase)) / 2;
    const shot = copy(clip.base);
    if (clip.mode === "time") return Object.assign(shot, shiftedTime(shot, clip.shift * mix));
    const spot = shot.spots[clip.spot];
    spot.x += (clip.end.x - spot.x) * mix;
    spot.y += (clip.end.y - spot.y) * mix;
    return shot;
  }

  function creditPainter(ctx, credit) {
    const {width, height} = ctx.canvas;
    const fontSize = width / 64;
    const padding = width / 80;
    const maxWidth = width - padding * 4;
    const font = `${fontSize}px 'Segoe UI', sans-serif`;
    ctx.font = font;
    const chars = Array.from(credit);
    while (chars.length && ctx.measureText(chars.join("") + "…").width > maxWidth) chars.pop();
    const shortened = chars.join("");
    const text = shortened === credit ? credit : shortened.trimEnd() + "…";
    const top = height - fontSize * 1.9;
    return () => {
      ctx.fillStyle = "#17130fd9";
      ctx.fillRect(0, top, width, height - top);
      ctx.fillStyle = "#ede2d5";
      ctx.font = font;
      ctx.textBaseline = "middle";
      ctx.fillText(text, padding, (height + top) / 2);
    };
  }

  function mount({draw, example}) {
    const dialog = document.getElementById("film-dialog");
    const ui = Object.fromEntries([...dialog.querySelectorAll('[id^="film-"]')].map(node => [node.id.slice(5), node]));
    const view = ui.preview.parentElement;
    const preview = ui.preview.getContext("2d", {alpha: false});
    let active, animation, job, downloadUrl, formatCheck;

    function paint(clip, ctx, phase) {
      draw(frameAt(clip, phase), ctx, clip.sheet);
      if (clip.creditLine) {
        if (!clip.captions.has(ctx)) clip.captions.set(ctx, creditPainter(ctx, clip.creditLine));
        clip.captions.get(ctx)();
      }
    }

    function setPlaying(playing) {
      cancelAnimationFrame(animation);
      animation = 0;
      ui.play.setAttribute("aria-pressed", playing);
      ui["play-label"].textContent = playing ? "暂停" : "播放";
      view.classList.toggle("is-playing", playing);
    }

    function clearDownload() {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = null;
      ui.download.removeAttribute("href");
      ui.download.hidden = true;
    }

    function setControls() {
      const blocked = !active?.ready || Boolean(job);
      const movingSpot = active?.mode === "spot";
      for (const control of [ui.play, ui.seek, ui.shift, ui.length, ui.spot, ui["time-mode"]]) control.disabled = blocked;
      ui["spot-mode"].disabled = blocked || !active.base.spots.length;
      ui.demo.disabled = Boolean(job);
      ui.export.disabled = blocked || !active.formats.length;
      ui.cancel.hidden = !job;
      ui.cancel.disabled = !job || job.signal.aborted;
      view.classList.toggle("is-editable", Boolean(movingSpot && !blocked));
      ui.preview.tabIndex = movingSpot && !blocked ? 0 : -1;
      if (movingSpot) ui.preview.setAttribute("aria-describedby", "film-route-hint");
      else ui.preview.removeAttribute("aria-describedby");
    }

    function setPosition(phase) {
      active.phase = phase;
      const elapsed = (phase * active.seconds).toFixed(2);
      ui.seek.value = Math.round(phase * active.seconds * fps);
      ui.seek.style.setProperty("--film-pct", `${phase * 100}%`);
      ui.seek.setAttribute("aria-valuetext", `${elapsed} 秒`);
      ui.position.textContent = `${elapsed} / ${active.seconds} 秒`;
    }

    function showFrame(phase) {
      if (!active?.ready) return;
      try {
        paint(active, preview, phase);
        setPosition(phase);
      } catch (error) {
        console.error(error);
        active.ready = false;
        setPlaying(false);
        setControls();
        ui.status.textContent = "短片画面绘制失败。请重新打开时间短片。";
      }
    }

    function togglePlay() {
      if (animation) {
        setPlaying(false);
        return;
      }
      const clip = active;
      const start = performance.now() - clip.phase * clip.seconds * 1000;
      const frames = fps * clip.seconds;
      let lastFrame = -1;
      setPlaying(true);
      const tick = now => {
        if (active !== clip || !dialog.open || !clip.ready) return;
        const index = Math.floor(Math.max(0, now - start) * fps / 1000) % frames;
        if (index !== lastFrame) {
          showFrame(index / frames);
          lastFrame = index;
        }
        if (clip.ready) animation = requestAnimationFrame(tick);
      };
      animation = requestAnimationFrame(tick);
    }

    function updateTime() {
      const other = shiftedTime(active.base, active.shift);
      const next = clock(Math.floor(other.minute));
      const min = Number(ui.shift.min), max = Number(ui.shift.max);
      ui.hours.textContent = `${clock(Math.floor(active.base.minute))} → ${next}`;
      if (active.base.field) ui.date.textContent = Field.caption(active.base.field.times);
      else ui.date.textContent = other.date === active.base.date ? other.date : `${active.base.date} → ${other.date}`;
      ui.shift.style.setProperty("--film-pct", `${100 * (active.shift - min) / (max - min)}%`);
      ui.shift.setAttribute("aria-valuetext", active.base.field ? next : `${other.date} ${next}`);
    }

    function showFormat(label) {
      ui.format.textContent = label ? `${label} · ${specifications}` : specifications;
    }

    function updateRoute() {
      const {x, y} = active.base.spots[active.spot];
      const dx = active.end.x - x, dy = active.end.y - y;
      const route = ui["route-line"];
      for (const [node, point] of [[route, {x, y}], [ui["route-origin"], {x, y}], [ui["route-end"], active.end]]) {
        node.style.left = `${point.x * 100}%`;
        node.style.top = `${point.y * 100}%`;
      }
      route.style.width = `${Math.hypot(dx, dy / ASPECT) * 100}%`;
      route.style.transform = `rotate(${Math.atan2(dy / ASPECT, dx)}rad)`;
    }

    function defaultEnd(spot) {
      return {x: spot.x + (spot.x > .5 ? -.29 : .29), y: spot.y};
    }

    function setMode(mode) {
      active.mode = mode;
      const spots = mode === "spot";
      setPlaying(false);
      ui["time-mode"].setAttribute("aria-pressed", !spots);
      ui["spot-mode"].setAttribute("aria-pressed", spots);
      ui["time-options"].hidden = spots;
      ui["spot-options"].hidden = !spots;
      if (spots) updateRoute();
      setControls();
      showFrame(0);
    }

    function moveEnd(x, y) {
      active.end = {x: clamp(x, 0, 1), y: clamp(y, 0, 1)};
      setPlaying(false);
      updateRoute();
      showFrame(.5);
    }

    async function open(base, name, end) {
      if (job) return;
      setPlaying(false);
      clearDownload();
      const credits = base.field?.credits ?? [];
      const clip = active = {
        base: copy(base), name, spot: 0, mode: end ? "spot" : "time",
        end: end ?? (base.spots.length ? defaultEnd(base.spots[0]) : null),
        phase: 0, seconds: 8, formats: [], captions: new WeakMap(),
        creditLine: credits.length ? `Wikimedia Commons · ${credits.map(item => `${item.by || item.title} (${item.license})`).join(" · ")}` : ""
      };
      const [min, max] = shiftBounds(base);
      clip.shift = clamp(initialShift(base), min, max);
      ui.shift.min = min;
      ui.shift.max = max;
      ui.shift.value = clip.shift;
      ui["shift-start"].textContent = min === -720 ? "−12 小时" : min ? `−${-min} 分钟` : "0 分钟";
      ui["shift-end"].textContent = max === 720 ? "＋12 小时" : max ? `＋${max} 分钟` : "0 分钟";
      ui["shift-origin"].hidden = min !== -720 || max !== 720;
      ui.length.value = clip.seconds;
      ui.seek.max = clip.seconds * fps;
      ui.name.textContent = name;
      ui.spot.replaceChildren(...base.spots.map((spot, index) => new Option(`曝光圈 ${index + 1} · ${clock(spot.minute)}`, index)));
      ui.demo.hidden = Boolean(end);
      showFormat();
      ui.status.textContent = "正在准备短片…";
      ui.progress.hidden = true;
      preview.fillStyle = "#12110f";
      preview.fillRect(0, 0, ui.preview.width, ui.preview.height);
      updateTime();
      setPosition(0);
      setMode(clip.mode);
      if (!dialog.open) dialog.showModal();
      try {
        clip.sheet = base.field ? await Field.open(base.field) : undefined;
      } catch (error) {
        if (active === clip && dialog.open) ui.status.textContent = error.message;
        return;
      }
      if (active !== clip || !dialog.open) return;
      clip.ready = true;
      showFrame(0);
      setControls();
      try {
        formatCheck ??= availableFormats().catch(error => { formatCheck = null; throw error; });
        clip.formats = await formatCheck;
      } catch (error) {
        if (active === clip && dialog.open && clip.ready) ui.status.textContent = `${error.message}。可继续预览。`;
        return;
      }
      if (active !== clip || !dialog.open || !clip.ready) return;
      const available = clip.formats[0];
      showFormat(available?.label);
      ui.status.textContent = available ? "" : "可继续预览。当前浏览器无法编码 MP4 或 WebM。";
      setControls();
    }

    async function encode(clip, option, ctx, signal) {
      const media = await loadEncoder();
      signal.throwIfAborted();
      const format = option.format();
      const target = new media.BufferTarget();
      const output = new media.Output({format, target});
      try {
        const source = new media.CanvasSource(ctx.canvas, {
          codec: option.codec, bitrate: encoding.bitrate, latencyMode: encoding.latencyMode
        });
        output.addVideoTrack(source, {frameRate: fps});
        const description = Field.attribution(clip.base.field?.credits ?? [], "film");
        output.setMetadataTags({title: clip.name, ...(description && {description, comment: description})});
        await output.start();
        const frames = clip.seconds * fps;
        for (let i = 0; i < frames; i++) {
          signal.throwIfAborted();
          paint(clip, ctx, i / frames);
          await source.add(i / fps, 1 / fps);
          ui.progress.value = (i + 1) / frames;
          if (i % 4 === 3) await new Promise(resolve => setTimeout(resolve, 0));
        }
        signal.throwIfAborted();
        ui.status.textContent = "正在封装短片…";
        await output.finalize();
        signal.throwIfAborted();
        return {blob: new Blob([target.buffer], {type: format.mimeType}), extension: format.fileExtension};
      } finally {
        if (output.state === "started" || output.state === "pending") await output.cancel().catch(() => {});
      }
    }

    async function exportClip() {
      const clip = active;
      if (job || !clip?.ready || !clip.formats.length) return;
      job = new AbortController();
      const {signal} = job;
      setPlaying(false);
      clearDownload();
      setControls();
      ui.cancel.focus();
      ui.progress.hidden = false;
      const canvas = document.createElement("canvas");
      canvas.width = encoding.width;
      canvas.height = encoding.height;
      const ctx = canvas.getContext("2d", {alpha: false});
      try {
        for (const option of clip.formats) {
          signal.throwIfAborted();
          showFormat(option.label);
          ui.progress.value = 0;
          ui.status.textContent = `正在逐帧冲印 ${option.label}…`;
          let result;
          try {
            result = await encode(clip, option, ctx, signal);
          } catch (error) {
            if (signal.aborted) throw error;
            console.warn(`${option.codec} 编码失败`, error);
            continue;
          }
          signal.throwIfAborted();
          if (!dialog.open) return;
          downloadUrl = URL.createObjectURL(result.blob);
          const name = clip.name.replace(/[<>:"/\\|?*]/g, " ").trim();
          ui.download.href = downloadUrl;
          ui.download.download = `时间短片 - ${name}${result.extension}`;
          ui.download.hidden = false;
          ui.download.click();
          ui.status.textContent = `${option.label} 已生成 · ${clip.seconds} 秒 · 已发起下载`;
          return;
        }
        ui.status.textContent = "浏览器的编码器无法完成导出。可重试，或换一个支持视频编码的浏览器。";
      } catch (error) {
        if (dialog.open) ui.status.textContent = signal.aborted ? "已取消导出。可重新冲印。" : "短片导出失败，请重试。";
      } finally {
        job = null;
        ui.progress.hidden = true;
        if (dialog.open) {
          setControls();
          (ui.download.hidden ? ui.export : ui.download).focus();
        }
      }
    }

    function cancelExport() {
      if (!job || job.signal.aborted) return;
      job.abort();
      ui.cancel.disabled = true;
      ui.status.textContent = "正在取消导出…";
    }

    function demo() {
      open(example.base, example.name, example.end);
    }

    ui.play.addEventListener("click", togglePlay);
    ui.seek.addEventListener("input", () => {
      setPlaying(false);
      showFrame(ui.seek.valueAsNumber / Number(ui.seek.max));
    });
    ui.shift.addEventListener("input", () => {
      setPlaying(false);
      active.shift = Number(ui.shift.value);
      updateTime();
      showFrame(.5);
    });
    ui.length.addEventListener("change", () => {
      setPlaying(false);
      active.seconds = Number(ui.length.value);
      const frames = active.seconds * fps;
      ui.seek.max = frames;
      showFrame(Math.round(active.phase * frames) / frames);
    });
    ui["time-mode"].addEventListener("click", () => setMode("time"));
    ui["spot-mode"].addEventListener("click", () => setMode("spot"));
    ui.spot.addEventListener("change", () => {
      active.spot = Number(ui.spot.value);
      active.end = defaultEnd(active.base.spots[active.spot]);
      setMode("spot");
    });
    ui.preview.addEventListener("click", event => {
      if (!view.classList.contains("is-editable")) return;
      const rect = ui.preview.getBoundingClientRect();
      moveEnd((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
    });
    ui.preview.addEventListener("keydown", event => {
      const step = event.shiftKey ? .05 : .01;
      const delta = {ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step]}[event.key];
      if (!delta || !view.classList.contains("is-editable")) return;
      event.preventDefault();
      moveEnd(active.end.x + delta[0], active.end.y + delta[1]);
    });
    ui.demo.addEventListener("click", () => {
      demo();
      ui["spot-mode"].focus();
      if (document.activeElement !== ui["spot-mode"]) dialog.querySelector(".close").focus();
    });
    ui.export.addEventListener("click", exportClip);
    ui.cancel.addEventListener("click", cancelExport);
    dialog.addEventListener("close", () => {
      if (dialog.open) return;
      cancelExport();
      setPlaying(false);
      clearDownload();
      active = null;
    });
    return {open, demo};
  }

  return {mount};
})();
