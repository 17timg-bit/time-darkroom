/* The imaginary scenes use level, fixed rectilinear cameras at these reference sites. */
const Sky = (() => {
  const A = Astronomy;
  const SITES = {
    cape: {lat: 48.45, lon: -5.10, utc: 0, bearing: 207, fov: 96},
    lake: {lat: 46.60, lon: 8.10, utc: 1, bearing: 120, fov: 94}
  };
  const firstDate = "1900-01-01", lastDate = "2099-12-31";
  const defaultDate = "2026-11-18";
  const rad = Math.PI / 180, dayMinutes = 1440, dayMs = 86400000, auKm = 149597870.7;
  const aspect = 16 / 9, firstMinute = -720, lastMinute = 2160, step = 8;
  const cache = new Map();

  function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < firstDate || value > lastDate) return false;
    const date = new Date(value + "T00:00:00Z");
    return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
  }

  const advanceDate = (date, days) => new Date(Date.parse(date + "T00:00:00Z") + days * dayMs).toISOString().slice(0, 10);
  const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const normalize = v => {
    const length = Math.hypot(...v);
    return v.map(x => x / length);
  };
  const lerp = (a, b, f) => a.map((v, i) => v + (b[i] - v) * f);
  const vector = (azimuth, altitude) => {
    const a = azimuth * rad, h = altitude * rad, flat = Math.cos(h);
    return [Math.sin(a)*flat, Math.cos(a)*flat, Math.sin(h)];
  };
  const equatorial = (ra, dec) => [Math.cos(ra*15*rad)*Math.cos(dec*rad), Math.sin(ra*15*rad)*Math.cos(dec*rad), Math.sin(dec*rad)];

  function makeObservation(place, date) {
    const site = SITES[place];
    const midnight = Date.parse(date + "T00:00:00Z") - site.utc * 3600000;
    const at = minute => new Date(midnight + minute * 60000);
    const observer = new A.Observer(site.lat, site.lon, 0);
    const forward = vector(site.bearing, 0);
    const right = vector(site.bearing + 90, 0);
    const tangent = Math.tan(site.fov * rad / 2);
    const sidereal = (A.SiderealTime(at(0)) * 15 + site.lon) * rad;
    const precession = A.Rotation_EQD_EQJ(at(720)).rot.flat();
    const startSun = A.Equator(A.Body.Sun, at(firstMinute), observer, true, true);
    const endSun = A.Equator(A.Body.Sun, at(lastMinute), observer, true, true);
    return {
      place, date, site, at, observer, forward, right, tangent, sidereal, precession,
      latitude: [Math.sin(site.lat * rad), Math.cos(site.lat * rad)],
      sunStart: equatorial(startSun.ra, startSun.dec), sunEnd: equatorial(endSun.ra, endSun.dec),
      samples: new Map()
    };
  }

  function observe(place, date) {
    const key = place + "/" + date;
    const entry = cache.get(key) || makeObservation(place, date);
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size > 8) cache.delete(cache.keys().next().value);
    return entry;
  }

  function position(observation, body, minute) {
    const time = observation.at(minute);
    const eq = A.Equator(body, time, observation.observer, true, true);
    const horizon = A.Horizon(time, observation.observer, eq.ra, eq.dec, "normal");
    const radius = Math.asin((body === A.Body.Moon ? 1737.4 : 695700) / (eq.dist * auKm));
    return {dir: vector(horizon.azimuth, horizon.altitude), radius, azimuth: horizon.azimuth, altitude: horizon.altitude};
  }

  function interpolated(observation, body, minute) {
    const index = Math.floor(minute / step);
    const record = i => {
      const key = body + i;
      if (!observation.samples.has(key)) observation.samples.set(key, position(observation, body, i * step));
      return observation.samples.get(key);
    };
    const a = record(index), b = record(index + 1), f = minute / step - index;
    return {dir: normalize(lerp(a.dir, b.dir, f)), radius: a.radius + (b.radius - a.radius)*f};
  }

  function project(observation, dir, waterLine, reflected = false) {
    const depth = dot(dir, observation.forward);
    if (depth < .12) return null;
    return [
      .5 + dot(dir, observation.right) / (2 * observation.tangent * depth),
      waterLine - dir[2] * (reflected ? -1 : 1) * aspect / (2 * observation.tangent * depth)
    ];
  }

  function selectBody(observation, state, body, waterLine, reflected) {
    // Freeze each disc at the time assigned to its own centre. Render the rest of
    // the sky normally per pixel, without stretching a disc across time slices.
    const range = state.curve.map(offset => state.minute + state.span * offset);
    const spots = state.spots ?? [];
    const axis = Optics.direction(state.angle);
    for (const spot of spots) range.push(spot.minute);
    const start = Math.min(...range), end = Math.max(...range);
    function evaluate(minute) {
      const source = interpolated(observation, body, minute);
      const pixel = project(observation, source.dir, waterLine, reflected);
      if (!pixel) return null;
      const target = Optics.sampleTime(state, pixel[0], pixel[1], axis);
      return {minute, source, pixel, error: minute - target};
    }
    let best = null;
    let bestPriority = 0;
    function candidate(point) {
      if (!point || Math.abs(point.error) > .2 || point.source.dir[2] < -Math.sin(point.source.radius)) return;
      const [x, y] = point.pixel;
      if (x < -.04 || x > 1.04 || y < -.04 || y > 1.04) return;
      // A deliberately placed disc in a spot's core takes priority over roots in the feather.
      let priority = 0;
      for (let i = spots.length - 1; i >= 0; i--) {
        const weight = Optics.spotWeight(spots[i], x, y);
        if (weight === 0) continue;
        if (weight === 1 && point.minute === spots[i].minute) priority = i + 1;
        break;
      }
      if (!best || priority > bestPriority ||
          (priority === bestPriority && Math.abs(point.minute - state.minute) < Math.abs(best.minute - state.minute))) {
        best = point;
        bestPriority = priority;
      }
    }
    let left = evaluate(start);
    candidate(left);
    for (const spot of spots) candidate(evaluate(spot.minute));
    const count = Math.ceil((end - start) / (spots.length ? step / 2 : step));
    for (let i = 1; i <= count; i++) {
      const right = evaluate(start + (end - start) * i / count);
      candidate(right);
      if (left && right && left.error * right.error < 0) {
        let low = left, high = right;
        for (let j = 0; j < 10; j++) {
          const mid = evaluate((low.minute + high.minute) / 2);
          if (!mid) break;
          candidate(mid);
          if (low.error * mid.error > 0) low = mid;
          else high = mid;
        }
      }
      left = right;
    }
    return best ? {
      disc: [...best.source.dir, best.source.radius], minute: best.minute, pixel: best.pixel,
      light: interpolated(observation, A.Body.Sun, best.minute).dir
    } : {disc:[0,0,-1,0], minute:null, pixel:null, light:[0,0,1]};
  }

  function frame(observation, state, water) {
    return {
      sun: selectBody(observation, state, A.Body.Sun, water[0], false),
      moon: selectBody(observation, state, A.Body.Moon, water[0], false),
      reflection: water[1] > 0 ? selectBody(observation, state, A.Body.Moon, water[0], true) : null
    };
  }

  function snapshot(observation, minute) {
    const sun = position(observation, A.Body.Sun, minute);
    const moon = position(observation, A.Body.Moon, minute);
    const time = observation.at(minute);
    const cycle = A.MoonPhase(time);
    const phases = [[3, "新月"], [87, "娥眉月"], [93, "上弦月"], [177, "盈凸月"],
      [183, "满月"], [267, "亏凸月"], [273, "下弦月"], [357, "残月"], [360, "新月"]];
    return {sun, moon, cycle, fraction: A.Illumination(A.Body.Moon, time).phase_fraction,
      phase: phases.find(([limit]) => cycle <= limit)[1]};
  }

  function events(observation) {
    if (!observation.events) {
      const events = {};
      for (const [name, body] of [["sun", A.Body.Sun], ["moon", A.Body.Moon]]) {
        for (const [direction, label] of [[1, "rise"], [-1, "set"]]) {
          const event = A.SearchRiseSet(body, observation.observer, direction, observation.at(0), 1);
          events[name + label] = event ? {
            minute: (event.date - observation.at(0)) / 60000,
            azimuth: position(observation, body, (event.date - observation.at(0)) / 60000).azimuth
          } : null;
        }
      }
      observation.events = events;
    }
    return observation.events;
  }

  let lunarMap = null;
  async function loadMoonMap() {
    const image = await Optics.loadImage(MOON_MAP);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    lunarMap = context.getImageData(0, 0, canvas.width, canvas.height);
  }

  function drawPhase(canvas, observation, minute, now) {
    if (!lunarMap) return;
    const time = observation.at(minute);
    const rotation = A.Rotation_EQJ_HOR(time, observation.observer);
    const lunarAxis = A.RotateVector(rotation, A.RotationAxis(A.Body.Moon, time).north);
    const pole = [ -lunarAxis.y, lunarAxis.x, lunarAxis.z ];
    const right = normalize(cross(now.moon.dir, pole));
    const up = normalize(cross(right, now.moon.dir));
    const toward = now.moon.dir.map(value => -value);
    const sun = [dot(now.sun.dir,right), dot(now.sun.dir,up), dot(now.sun.dir,toward)];
    const lib = A.Libration(time);
    const centreLon = lib.elon * rad, centreLat = lib.elat * rad;
    const normal = [Math.cos(centreLat),0,Math.sin(centreLat)];
    const north = [-Math.sin(centreLat),0,Math.cos(centreLat)];
    const context = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    const result = context.createImageData(w,h);
    const d = result.data, texture = lunarMap.data, mw = lunarMap.width, mh = lunarMap.height;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (2*x+1-w)/(w-8), dy = (h-2*y-1)/(h-8);
        const r2 = dx*dx+dy*dy;
        if (r2 >= 1) continue;
        const z = Math.sqrt(1-r2);
        const longitude = Math.atan2(dx, normal[0]*z+north[0]*dy)+centreLon;
        const latitude = Math.asin(normal[2]*z+north[2]*dy);
        const mx = (Math.floor((.5+longitude/(2*Math.PI))*mw)+mw) % mw;
        const my = Math.min(mh-1,Math.floor((.5-latitude/Math.PI)*mh));
        const j = 4*(my*mw+mx), i = 4*(y*w+x);
        const diffuse = Math.max(0, sun[0]*dx+sun[1]*dy+sun[2]*z);
        const brightness = .045 + .99*Math.pow(diffuse,.41);
        for (let channel = 0; channel < 3; channel++) d[i+channel] = texture[j+channel]*brightness;
        d[i+3] = 255*Math.min(1,(1-Math.sqrt(r2))*(w-8)/2);
      }
    }
    context.putImageData(result,0,0);
  }

  return {SITES, firstDate, lastDate, defaultDate, validDate, advanceDate, observe, frame, snapshot, events, loadMoonMap, drawPhase};
})();
