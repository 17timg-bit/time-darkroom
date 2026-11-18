const Optics = (() => {
  const MODES = {
    still: [0, 0, 0, 0, 0],
    scan: [-.5, -.25, 0, .25, .5],
    fold: [-.5, -.12, .5, .12, -.5]
  };
  const DAY = 1440;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const wrapDay = value => ((value % DAY) + DAY) % DAY;
  const clock = minutes => {
    const rounded = wrapDay(Math.round(minutes));
    return [Math.floor(rounded / 60), rounded % 60].map(digit => String(digit).padStart(2, "0")).join(":");
  };
  const initial = () => ({mode: "scan", minute: 995, span: 1200, curve: [...MODES.scan]});
  const copy = state => ({...state, curve: [...state.curve]});
  const offsetAt = (curve, x) => {
    const section = clamp(x, 0, 1) * 4;
    const i = Math.min(Math.floor(section), 3);
    const f = section - i;
    return curve[i] * (1 - f) + curve[i + 1] * f;
  };
  const timeAt = (state, x) => state.minute + state.span * offsetAt(state.curve, x);
  const cleanState = state => {
    if (!state || (state.mode !== "custom" && !Object.hasOwn(MODES, state.mode)) ||
        !Number.isFinite(state.minute) || !Number.isFinite(state.span) ||
        !Array.isArray(state.curve) || state.curve.length !== 5 ||
        !state.curve.every(Number.isFinite)) return null;
    return {mode: state.mode, minute: wrapDay(state.minute), span: clamp(state.span, 30, DAY),
      curve: state.curve.map(value => clamp(value, -.5, .5))};
  };

  const vertex = `attribute vec2 aPosition;
varying vec2 uv;
void main() {
  uv = vec2(aPosition.x * .5 + .5, .5 - aPosition.y * .5);
  gl_Position = vec4(aPosition, 0., 1.);
}`;

  const fragment = `precision highp float;
varying vec2 uv;
uniform sampler2D uPhoto, uMask;
uniform float uCenter, uSpan, uCurve[5];
const float TAU = 6.283185307;
const float HORIZON = .519;
const vec2 LANTERN = vec2(.7345, .373);

float localTime(float x) {
  float i = clamp(x, 0., 1.) * 4.;
  float offset;
  if (i < 1.) offset = mix(uCurve[0], uCurve[1], i);
  else if (i < 2.) offset = mix(uCurve[1], uCurve[2], i - 1.);
  else if (i < 3.) offset = mix(uCurve[2], uCurve[3], i - 2.);
  else offset = mix(uCurve[3], uCurve[4], i - 3.);
  return mod(uCenter + uSpan * offset, 24.);
}
float bell(float a, float center, float width) {
  float q = (a - center) / width;
  return exp(-q * q);
}
float light(float hour) {
  return smoothstep(5.0, 8.4, hour) * (1. - smoothstep(16.9, 20.5, hour));
}
float hash(vec2 p) {
  vec3 a = fract(vec3(p.xyx) * .1031);
  a += dot(a, a.yzx + 33.33);
  return fract((a.x + a.y) * a.z);
}
vec2 space(vec2 p) { return p * vec2(1.7777778, 1.); }
float stars(vec2 xy, float t, float cells) {
  vec2 coord = space(xy) * cells;
  vec2 grid = floor(coord);
  float star = hash(grid);
  vec2 spot = .18 + vec2(hash(grid + 7.3), hash(grid - 3.9)) * .64;
  float dist = length(fract(coord) - spot);
  float core = 1. - smoothstep(.018, .063, dist);
  float blink = .8 + .2 * cos(star * 140. + t * TAU * 5. / 24.);
  return core * smoothstep(.84, .997, star) * blink;
}
void main() {
  float t = localTime(uv.x);
  float day = light(t);
  float night = 1. - smoothstep(.015, .34, day);
  float dawn = bell(t, 6.4, 1.18);
  float dusk = bell(t, 18.45, 1.17);
  float warm = dawn + dusk;
  float skyGlow = bell(uv.y, HORIZON - .04, .34);
  vec2 mask = texture2D(uMask, uv).rg;
  float seaDepth = clamp((uv.y - HORIZON) * 2.08, 0., 1.);
  float tide = t * TAU / 24.;
  vec2 ripple = vec2(
    sin(uv.y * 169. + seaDepth * seaDepth * 95. - tide * 19. + sin(uv.x * 49.)) * .0016,
    sin(uv.y * 117. - tide * 24. + uv.x * 31.) * .0010
  ) * mask.g * smoothstep(.004, .09, seaDepth) * (.36 + seaDepth);
  vec3 raw = texture2D(uPhoto, uv + ripple).rgb;
  float value = dot(raw, vec3(.2126, .7152, .0722));
  vec3 silver = mix(vec3(value), raw, .71);
  vec3 dayTone = silver * vec3(1.02, 1.04, 1.04);
  dayTone += vec3(-.039, .026, .039) * mask.r * (1. - uv.y);
  vec3 nightTone = silver * vec3(.15, .208, .319) + vec3(.007, .011, .022);
  nightTone += mask.r * vec3(.016, .013, .032) * skyGlow;
  vec3 color = mix(nightTone, dayTone, day);
  color += warm * (mask.r * mix(vec3(.39, .169, .063), vec3(.385, .135, .036), dusk) *
                  (.29 + .71 * skyGlow) + vec3(.21, .073, .01) * silver);
  color += dusk * vec3(.11, -.012, .034) * mask.r * (1. - skyGlow);
  color += night * mask.r * vec3(.65, .75, 1.) * (stars(uv, t, 31.) * .54 + stars(uv + .013, t, 55.) * .37);

  float transit = (t - 6.) / 13.05;
  vec2 sun = vec2(-.064 + .967 * transit, HORIZON - .438 * sin(transit * 3.14159265));
  float sunActive = smoothstep(0., .019, transit) * (1. - smoothstep(.98, 1., transit));
  float dist = length(space(uv - sun));
  float sunDisc = 1. - smoothstep(.013, .0155, dist);
  float sunHalo = exp(-dist * 22.) * .72 + exp(-dist * 7.5) * .20;
  vec3 sunColor = mix(vec3(1., .88, .66), vec3(1., .54, .22), warm * .68);
  color += sunColor * (sunDisc * .85 + sunHalo * (.40 + .25 * warm)) * mask.r * sunActive;
  float column = (uv.x - sun.x) / (.012 + seaDepth * .115);
  float glitter = max(0., sin(uv.y * 260. + seaDepth * seaDepth * 390. - tide * 25. + sin(uv.x * 149.)));
  color += sunColor * exp(-column * column) * (.02 + .18 * pow(glitter, 4.)) *
           (.24 + warm * .76) * mask.g * sunActive * (1. - seaDepth * .68);

  float lunarTime = mod(t + 5., 24.) / 10.;
  vec2 moon = vec2(.99 - .19 * lunarTime, .335 - .13 * sin(lunarTime * 2.5));
  float moonDist = length(space(uv - moon));
  float moonDisc = 1. - smoothstep(.017, .0185, moonDist);
  float occlusion = 1. - smoothstep(.0158, .0181, length(space(uv - moon) - vec2(-.008, -.005)));
  color += night * mask.r * vec3(.74, .83, .97) *
           (moonDisc * (1. - occlusion) * .77 + exp(-moonDist * 24.) * .13);

  float lampTime = localTime(LANTERN.x);
  float lamp = 1. - smoothstep(.03, .48, light(lampTime));
  vec2 delta = space(uv - LANTERN);
  float distanceToLamp = length(delta);
  float beamAngle = .030 + .056 * sin(lampTime * TAU * 6. / 24.);
  float beamWidth = .004 + abs(delta.x) * .033;
  float beamShape = bell(delta.y, beamAngle * delta.x, beamWidth);
  float beam = beamShape * exp(delta.x * 2.1) * (1. - smoothstep(-.002, .004, delta.x));
  float lampGlow = .77 * exp(-distanceToLamp * 210.) + .24 * exp(-distanceToLamp * 49.);
  float lampCore = (1. - smoothstep(.0025, .005, distanceToLamp)) * 1.4;
  color += vec3(1., .659, .352) * lamp *
           (lampCore + lampGlow + .263 * beam * mask.r * (.24 + night * .76));
  float edge = length((uv - .5) * vec2(1., .84));
  color *= 1. - .27 * smoothstep(.19, .67, edge);
  float grain = hash(floor(uv * vec2(1680., 944.))) - .5;
  color += grain * (.007 + .013 * day);
  gl_FragColor = vec4(clamp(color, 0., 1.), 1.);
}`;

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    });
  }

  function createRenderer(canvas, photo, mask) {
    const gl = canvas.getContext("webgl", {
      alpha: false, antialias: false, depth: false, premultipliedAlpha: false,
      preserveDrawingBuffer: true, powerPreference: "low-power"
    });
    if (!gl) throw new Error("WebGL is unavailable");
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
      const shader = compile(type, source);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const attribute = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(attribute);
    gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
    [photo, mask].forEach((image, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.uniform1i(gl.getUniformLocation(program, i === 0 ? "uPhoto" : "uMask"), i);
    });
    const center = gl.getUniformLocation(program, "uCenter");
    const span = gl.getUniformLocation(program, "uSpan");
    const curve = gl.getUniformLocation(program, "uCurve[0]");
    return {
      draw(state, width, height) {
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        gl.viewport(0, 0, width, height);
        gl.uniform1f(center, state.minute / 60);
        gl.uniform1f(span, state.span / 60);
        gl.uniform1fv(curve, state.curve);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    };
  }
  return {MODES, DAY, clamp, wrapDay, clock, initial, copy, offsetAt, timeAt, cleanState, loadImage, createRenderer};
})();
