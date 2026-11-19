const Optics = (() => {
  const MODES = {
    still: [0, 0, 0, 0, 0],
    scan: [-.5, -.25, 0, .25, .5],
    fold: [-.5, -.12, .5, .12, -.5]
  };
  const PLACES = {
    cape: {
      title: "岬角灯塔", english: "THE CAPE LIGHT", number: "01", sound: "海声",
      water: [.519, 0], lantern: [.7345, .373, 1], textures: CAPE
    },
    lake: {
      title: "镜湖", english: "MIRROR LAKE", number: "02", sound: "湖风",
      water: [531 / 941, 1], lantern: [0, 0, 0], textures: LAKE
    }
  };
  const DAY = 1440;
  const ASPECT = 16 / 9;
  const SPOT_LIMIT = 3;
  const SPOT_RADIUS = [.08, .68];
  const SPOT_FEATHER = [.10, .90];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const wrapDay = value => {
    const remainder = value % DAY;
    return remainder < 0 ? remainder + DAY : remainder;
  };
  const clock = minutes => {
    const rounded = wrapDay(Math.round(minutes));
    return [Math.floor(rounded / 60), rounded % 60].map(digit => String(digit).padStart(2, "0")).join(":");
  };
  const initial = () => ({
    mode: "scan", minute: 995, span: 1200, curve: [...MODES.scan], angle: 0, place: "cape",
    date: Sky.defaultDate, spots: []
  });
  const copy = state => ({...state, curve: [...state.curve], spots: (state.spots ?? []).map(spot => ({...spot}))});
  const offsetAt = (curve, x) => {
    const section = clamp(x, 0, 1) * 4;
    const i = Math.min(Math.floor(section), 3);
    const f = section - i;
    return curve[i] * (1 - f) + curve[i + 1] * f;
  };
  const timeAt = (state, x) => state.minute + state.span * offsetAt(state.curve, x);
  function direction(angle) {
    const radians = angle * Math.PI / 180;
    const x = Math.cos(radians) * ASPECT;
    const y = Math.sin(radians);
    const width = Math.abs(x) + Math.abs(y);
    return [x / width, y / width];
  }
  function positionAt(angle, x, y) {
    const [dx, dy] = direction(angle);
    return .5 + (x - .5) * dx + (y - .5) * dy;
  }
  function spotWeight(spot, x, y) {
    const distance = Math.hypot((x - spot.x) * ASPECT, y - spot.y);
    const progress = clamp((1 - distance / spot.radius) / spot.feather, 0, 1);
    return progress * progress * (3 - 2 * progress);
  }
  function sampleTime(state, x, y, [dx, dy] = direction(state.angle)) {
    let minute = timeAt(state, .5 + (x - .5) * dx + (y - .5) * dy);
    const spots = state.spots ?? [];
    if (state.field && spots.length) minute = Field.sampledMinute(state.field, minute);
    for (const spot of spots) {
      const target = state.field ? Field.sampledMinute(state.field, spot.minute) : spot.minute;
      minute += (target - minute) * spotWeight(spot, x, y);
    }
    return minute;
  }
  function cleanSpots(spots) {
    if (!Array.isArray(spots) || spots.length > SPOT_LIMIT) return null;
    const within = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
    const result = [];
    for (const spot of spots) {
      if (!spot || !within(spot.x, 0, 1) || !within(spot.y, 0, 1) ||
          !within(spot.radius, ...SPOT_RADIUS) || !within(spot.feather, ...SPOT_FEATHER) ||
          !within(spot.minute, 0, DAY - 1) || !Number.isInteger(spot.minute)) return null;
      const {x, y, radius, feather, minute} = spot;
      result.push({x, y, radius, feather, minute});
    }
    return result;
  }
  const cleanState = state => {
    const place = state?.place ?? "cape";
    const field = place === "field" ? Field.validate(state?.field) : null;
    const spots = cleanSpots(state?.spots ?? []);
    if (!state || (state.mode !== "custom" && !Object.hasOwn(MODES, state.mode)) ||
        !Number.isFinite(state.minute) || !Number.isFinite(state.span) ||
        !Array.isArray(state.curve) || state.curve.length !== 5 ||
        !state.curve.every(Number.isFinite) ||
        !Number.isFinite(state.angle ?? 0) || typeof place !== "string" || (!field && !Object.hasOwn(PLACES, place)) ||
        !Sky.validDate(state.date ?? Sky.defaultDate) || !spots) return null;
    return {mode: state.mode, minute: wrapDay(state.minute), span: clamp(state.span, 30, DAY),
      curve: state.curve.map(value => clamp(value, -.5, .5)),
      angle: clamp(Math.round(state.angle ?? 0), 0, 359), place, date: state.date ?? Sky.defaultDate, spots,
      ...(field ? {field} : {})};
  };

  const vertex = `attribute vec2 aPosition;
varying vec2 uv;
void main() {
  uv = vec2(aPosition.x * .5 + .5, .5 - aPosition.y * .5);
  gl_Position = vec4(aPosition, 0., 1.);
}`;

  const fragment = `precision highp float;
varying vec2 uv;
uniform sampler2D uPhoto, uMask, uAtlas;
uniform float uCenter, uSpan, uCurve[5];
uniform vec2 uDirection;
uniform int uSpotCount;
uniform vec4 uSpots[${SPOT_LIMIT}];
uniform float uSpotHours[${SPOT_LIMIT}];
uniform vec2 uWater;
uniform vec3 uLantern;
uniform vec3 uCamera;
uniform vec2 uLatitude;
uniform float uSidereal;
uniform mat3 uPrecession;
uniform vec3 uSolarStart, uSolarEnd;
uniform vec4 uSun, uMoon, uReflection;
uniform vec3 uMoonLight, uReflectionLight;
uniform sampler2D uReel;
uniform int uFrameCount, uCut;
uniform vec2 uGrid, uTileInset;
uniform float uFrameTimes[6], uLastFrameTime;
const float TAU = 6.283185307;
const float DEG = .01745329251994;

float reelTime(float minute) {
  float start = uFrameTimes[0];
  float current = mod(minute - start, 1440.) + start;
  if (current <= uLastFrameTime) return current;
  return current - uLastFrameTime > start + 1440. - current ? start : uLastFrameTime;
}
float localTime(vec2 point) {
  float i = clamp(.5 + dot(point - .5, uDirection), 0., 1.) * 4.;
  float offset;
  if (i < 1.) offset = mix(uCurve[0], uCurve[1], i);
  else if (i < 2.) offset = mix(uCurve[1], uCurve[2], i - 1.);
  else if (i < 3.) offset = mix(uCurve[2], uCurve[3], i - 2.);
  else offset = mix(uCurve[3], uCurve[4], i - 3.);
  float hour = uCenter + uSpan * offset;
  if (uSpotCount > 0 && uFrameCount > 1) hour = reelTime(hour * 60.) / 60.;
  for (int n = 0; n < ${SPOT_LIMIT}; n++) {
    if (n >= uSpotCount) break;
    vec4 spot = uSpots[n];
    float distance = length((point - spot.xy) * vec2(${ASPECT.toFixed(9)}, 1.));
    float progress = clamp((1. - distance / spot.z) / spot.w, 0., 1.);
    hour = mix(hour, uSpotHours[n], progress * progress * (3. - 2. * progress));
  }
  return hour;
}
float bell(float a, float center, float width) {
  float q = (a - center) / width;
  return exp(-q * q);
}
float spin(float hour) {
  return uSidereal + hour * TAU * 1.00273790935 / 24.;
}
vec3 solarDirection(float hour) {
  vec3 sun = normalize(mix(uSolarStart, uSolarEnd, clamp((hour+12.)/48.,0.,1.)));
  float s = spin(hour);
  float meridian = sun.x * cos(s) + sun.y * sin(s);
  return vec3(sun.y * cos(s) - sun.x * sin(s),
    sun.z * uLatitude.y - meridian * uLatitude.x,
    sun.z * uLatitude.x + meridian * uLatitude.y);
}
float daylight(float solarAlt) {
  return smoothstep(sin(-9.*DEG), sin(14.*DEG), solarAlt);
}
float hash(vec2 p) {
  vec3 a = fract(vec3(p.xyx) * .1031);
  a += dot(a, a.yzx + 33.33);
  return fract((a.x + a.y) * a.z);
}
vec2 space(vec2 p) { return p * vec2(1.7777778, 1.); }
vec3 cameraRay(vec2 point, float horizon) {
  vec2 right = vec2(uCamera.y, -uCamera.x);
  return normalize(vec3(uCamera.xy + (2.*point.x - 1.) * uCamera.z * right,
    (horizon - point.y) * 1.125 * uCamera.z));
}
vec3 starscape(vec3 ray, float hour) {
  float s = spin(hour);
  float meridian = uLatitude.y * ray.z - uLatitude.x * ray.y;
  vec3 eq = uPrecession * vec3(meridian * cos(s) - ray.x * sin(s),
    meridian * sin(s) + ray.x * cos(s), uLatitude.x * ray.z + uLatitude.y * ray.y);
  vec2 uvStar = vec2(fract(atan(eq.y, eq.x)/TAU + 1.), .5 - asin(clamp(eq.z,-1.,1.))/(.5*TAU));
  return texture2D(uAtlas, uvStar).rgb * smoothstep(-.006,.18,ray.z);
}
float moondisc(vec3 ray, vec4 body, vec3 light) {
  if (body.w <= 0.) return 0.;
  float aligned = dot(ray, body.xyz);
  if (aligned < .9995) return 0.;
  vec3 tangent = (ray - aligned * body.xyz) / body.w;
  float r = length(tangent);
  vec3 surface = tangent - body.xyz * sqrt(max(0., 1. - r*r));
  float phase = pow(max(0.,dot(surface, light)), .45);
  return (1. - smoothstep(.77, 1.19, r)) * (.013 + .84*phase);
}
vec3 reelTile(vec2 point, float number) {
  vec2 tile = vec2(mod(number,uGrid.x),floor(number/uGrid.x));
  vec2 centreSafe = mix(uTileInset,1.-uTileInset,point);
  return texture2D(uReel,(tile + centreSafe)/uGrid).rgb;
}
vec3 singleLight(float minute) {
  float hour=mod(minute/60.,24.);
  float sun=smoothstep(5.,8.6,hour)*(1.-smoothstep(17.1,20.3,hour));
  float amber=bell(hour,6.55,1.24)+bell(hour,18.2,1.32);
  return mix(vec3(.25,.32,.47),vec3(1.),sun)+amber*vec3(.39,.13,-.035);
}
vec3 reelExposure(vec2 point,float minute) {
  vec3 first=reelTile(point,0.);
  if(uFrameCount==1) {
    vec3 ratio=clamp(singleLight(minute)/singleLight(uFrameTimes[0]),.40,1.72);
    return clamp(first*ratio,0.,1.);
  }
  float current = reelTime(minute);
  for(int i=1;i<6;i++) {
    if(i>=uFrameCount) break;
    if(current<=uFrameTimes[i]) {
      float amount=(current-uFrameTimes[i-1])/(uFrameTimes[i]-uFrameTimes[i-1]);
      if(uCut==1) return reelTile(point,amount<.5 ? float(i-1) : float(i));
      vec3 a=reelTile(point,float(i-1)), b=reelTile(point,float(i));
      return sqrt(mix(a*a,b*b,amount));
    }
  }
  return first;
}
void main() {
  float t = localTime(uv);
  if (uFrameCount>0) {
    gl_FragColor=vec4(reelExposure(uv,t*60.),1.);
    return;
  }
  vec3 solar = solarDirection(t);
  float solarAlt = solar.z;
  float day = daylight(solarAlt);
  float night = 1. - smoothstep(sin(-18.*DEG), sin(-6.*DEG), solarAlt);
  float warm = bell(solarAlt, sin(-2.*DEG), .098);
  float horizon = uWater.x;
  float mirror = uWater.y;
  float skyGlow = bell(uv.y, horizon - .04, .34);
  vec3 ray = cameraRay(uv, horizon);
  vec2 mask = texture2D(uMask, uv).rg;
  float seaDepth = clamp((uv.y - horizon) * 2.08, 0., 1.);
  float tide = t * TAU / 24.;
  vec2 ripple = vec2(
    sin(uv.y * 169. + seaDepth * seaDepth * 95. - tide * 19. + sin(uv.x * 49.)) * .0016,
    sin(uv.y * 117. - tide * 24. + uv.x * 31.) * .0010
  ) * mask.g * smoothstep(.004, .09, seaDepth) * (.36 + seaDepth) * mix(1., .55, mirror);
  vec3 raw = texture2D(uPhoto, uv + ripple).rgb;
  float value = dot(raw, vec3(.2126, .7152, .0722));
  vec3 silver = mix(vec3(value), raw, .71);
  vec3 dayTone = silver * vec3(1.02, 1.04, 1.04);
  dayTone += vec3(-.039, .026, .039) * mask.r * (1. - uv.y);
  vec3 nightTone = silver * vec3(.15, .208, .319) + vec3(.007, .011, .022);
  nightTone += mask.r * vec3(.016, .013, .032) * skyGlow;
  vec3 color = mix(nightTone, dayTone, day);
  float solarSide = .36 + .64 * pow(max(0.,dot(normalize(ray.xy),normalize(solar.xy))),2.);
  color += warm * solarSide * (mask.r * vec3(.38, .186, .103) * (.24 + .76 * skyGlow)
                         + vec3(.17, .084, .022) * silver);
  if (night > .001 && mask.r > .001) color += night * mask.r * starscape(ray, t);

  float sunHeight = uSun.z;
  vec3 sunColor = mix(vec3(1.,.96,.86), vec3(1.,.48,.20), 1. - smoothstep(0.,.19,sunHeight));
  if (uSun.w > 0. && mask.r > .001) {
    float distanceToSun = length(ray - uSun.xyz);
    float disc = 1. - smoothstep(uSun.w * .70, uSun.w * 1.21, distanceToSun);
    float halo = exp(-distanceToSun * 86.) * .19 + exp(-distanceToSun * 26.) * .05;
    color += mask.r * sunColor * (disc*.91 + halo);
  }
  if (mask.g > .001 && solarAlt > -.008) {
    float towardSun = length(normalize(ray.xy) - normalize(solar.xy));
    float glitter = max(0., sin(uv.y * 260. + seaDepth * seaDepth * 390. - tide * 25. + sin(uv.x * 149.)));
    color += (vec3(.62,.56,.49) + vec3(.28,-.12,-.28)*warm) *
      bell(towardSun,0.,.024+seaDepth*.09) * glitter*glitter * mask.g *
      bell(solarAlt,.02,.16) * .062 * (1.-mirror*.45);
  }
  color += mask.r * mix(vec3(.89,.92,.99), vec3(.50,.57,.65),day) *
           moondisc(ray, uMoon, uMoonLight) * (1.-day*.55);
  if (mirror > 0. && mask.g > .01) {
    // Water reflects the sky from the time assigned to this point on the lake.
    vec2 reflected = vec2(uv.x, 2. * horizon - uv.y);
    reflected.x += sin(uv.y * 145. + uv.x * 27. - tide * 17.) * (.0011 + seaDepth * .0025);
    reflected.y += sin(uv.y * 310. - tide * 23.) * seaDepth * .0018;
    float reflectedSky = texture2D(uMask, reflected).r;
    float gloss = .78 + .22 * sin(uv.y * 180. - tide * 23. + uv.x * 12.);
    vec3 silverLight = vec3(.54, .73, .95);
    vec3 reflectedRay = cameraRay(reflected, horizon);
    float moonImage = moondisc(reflectedRay,uReflection,uReflectionLight);
    vec3 starsOnWater = starscape(reflectedRay,t) * night * .47;
    color += mask.g * reflectedSky * gloss * (silverLight * moonImage * (1.-day*.79) + starsOnWater);
    color += mask.g * reflectedSky *
             (night * vec3(.005, .023, .044) + warm * vec3(.084, .040, .018)) * (.82 - seaDepth * .38);
  }

  if (uLantern.z > 0.) {
    float lampTime = localTime(uLantern.xy);
    float lamp = 1. - smoothstep(-.11, .02, solarDirection(lampTime).z);
    vec2 delta = space(uv - uLantern.xy);
    float distanceToLamp = length(delta);
    float beamAngle = .030 + .056 * sin(lampTime * TAU * 6. / 24.);
    float beamWidth = .004 + abs(delta.x) * .033;
    float beamShape = bell(delta.y, beamAngle * delta.x, beamWidth);
    float beam = beamShape * exp(delta.x * 2.1) * (1. - smoothstep(-.002, .004, delta.x));
    float lampGlow = .77 * exp(-distanceToLamp * 210.) + .24 * exp(-distanceToLamp * 49.);
    float lampCore = (1. - smoothstep(.0025, .005, distanceToLamp)) * 1.4;
    color += vec3(1., .659, .352) * lamp *
             (lampCore + lampGlow + .263 * beam * mask.r * (.24 + night * .76));
  }
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

  function createRenderer(canvas, imagesByPlace, starAtlas) {
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
    function createTexture(image, i) {
      gl.activeTexture(gl.TEXTURE0 + i);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      return texture;
    }
    const textures = Object.fromEntries(Object.entries(imagesByPlace)
      .map(([key, images]) => [key, images.map(createTexture)]));
    createTexture(starAtlas, 2);
    gl.uniform1i(gl.getUniformLocation(program, "uPhoto"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "uMask"), 1);
    gl.uniform1i(gl.getUniformLocation(program, "uAtlas"), 2);
    gl.uniform1i(gl.getUniformLocation(program, "uReel"), 3);
    const center = gl.getUniformLocation(program, "uCenter");
    const span = gl.getUniformLocation(program, "uSpan");
    const curve = gl.getUniformLocation(program, "uCurve[0]");
    const axis = gl.getUniformLocation(program, "uDirection");
    const spotCount = gl.getUniformLocation(program, "uSpotCount");
    const spotGeometry = gl.getUniformLocation(program, "uSpots[0]");
    const spotHours = gl.getUniformLocation(program, "uSpotHours[0]");
    const geometry = new Float32Array(4 * SPOT_LIMIT);
    const hours = new Float32Array(SPOT_LIMIT);
    const water = gl.getUniformLocation(program, "uWater");
    const lantern = gl.getUniformLocation(program, "uLantern");
    const solarDisc = gl.getUniformLocation(program, "uSun");
    const lunarDisc = gl.getUniformLocation(program, "uMoon");
    const reflection = gl.getUniformLocation(program, "uReflection");
    const moonLight = gl.getUniformLocation(program, "uMoonLight");
    const reflectionLight = gl.getUniformLocation(program, "uReflectionLight");
    const camera = gl.getUniformLocation(program, "uCamera");
    const latitude = gl.getUniformLocation(program, "uLatitude");
    const sidereal = gl.getUniformLocation(program, "uSidereal");
    const precession = gl.getUniformLocation(program, "uPrecession");
    const solarStart = gl.getUniformLocation(program, "uSolarStart");
    const solarEnd = gl.getUniformLocation(program, "uSolarEnd");
    const fieldCount=gl.getUniformLocation(program,"uFrameCount");
    const fieldCut=gl.getUniformLocation(program,"uCut");
    const fieldGrid=gl.getUniformLocation(program,"uGrid");
    const fieldTimes=gl.getUniformLocation(program,"uFrameTimes[0]");
    const fieldLast=gl.getUniformLocation(program,"uLastFrameTime");
    gl.uniform2f(gl.getUniformLocation(program,"uTileInset"),.5/Field.tileWidth,.5/Field.tileHeight);
    const reelTexture=gl.createTexture();
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D,reelTexture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,255]));
    let activePlace;
    let activeSky;
    let activeReel;
    return {
      draw(state, width, height, sheet) {
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        const place = state.place ?? "cape";
        gl.viewport(0, 0, width, height);
        gl.uniform1f(center, state.minute / 60);
        gl.uniform1f(span, state.span / 60);
        gl.uniform1fv(curve, state.curve);
        gl.uniform2fv(axis, direction(state.angle));
        const spots = state.spots ?? [];
        gl.uniform1i(spotCount, spots.length);
        if (spots.length) {
          spots.forEach(({x, y, radius, feather, minute}, index) => {
            const start = index * 4;
            geometry[start] = x;
            geometry[start + 1] = y;
            geometry[start + 2] = radius;
            geometry[start + 3] = feather;
            hours[index] = (state.field ? Field.sampledMinute(state.field, minute) : minute) / 60;
          });
          gl.uniform4fv(spotGeometry, geometry);
          gl.uniform1fv(spotHours, hours);
        }
        if(place==="field"){
          const {id,times,mix}=state.field;
          if(activeReel!==id){
            const image=sheet||Field.get(id);
            if(!image)return;
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D,reelTexture);
            gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
            const cols=Math.min(3,times.length), values=new Float32Array(Field.maxFrames);
            values.set(times);
            gl.uniform2f(fieldGrid,cols,Math.ceil(times.length/cols));
            gl.uniform1fv(fieldTimes,values);
            gl.uniform1f(fieldLast,times.at(-1));
            gl.uniform1i(fieldCut,Number(mix==="cut"));
            activeReel=id;
          }
          gl.uniform1i(fieldCount,times.length);
          gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
          return;
        }
        gl.uniform1i(fieldCount,0);
        if (activePlace !== place) {
          textures[place].forEach((texture, i) => {
            gl.activeTexture(gl.TEXTURE0 + i);
            gl.bindTexture(gl.TEXTURE_2D, texture);
          });
          gl.uniform2fv(water, PLACES[place].water);
          gl.uniform3fv(lantern, PLACES[place].lantern);
          activePlace = place;
        }
        const sky = Sky.observe(place, state.date ?? Sky.defaultDate);
        if (sky !== activeSky) {
          gl.uniform3fv(camera, [...sky.forward.slice(0,2), sky.tangent]);
          gl.uniform2fv(latitude, sky.latitude);
          gl.uniform1f(sidereal, sky.sidereal);
          gl.uniformMatrix3fv(precession, false, sky.precession);
          gl.uniform3fv(solarStart, sky.sunStart);
          gl.uniform3fv(solarEnd, sky.sunEnd);
          activeSky = sky;
        }
        const bodies = Sky.frame(sky, state, PLACES[place].water);
        gl.uniform4fv(solarDisc, bodies.sun.disc);
        gl.uniform4fv(lunarDisc, bodies.moon.disc);
        gl.uniform3fv(moonLight, bodies.moon.light);
        if (bodies.reflection) {
          gl.uniform4fv(reflection, bodies.reflection.disc);
          gl.uniform3fv(reflectionLight, bodies.reflection.light);
        }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    };
  }
  return {
    MODES, PLACES, DAY, ASPECT, SPOT_LIMIT, SPOT_RADIUS, SPOT_FEATHER, clamp, wrapDay, clock,
    initial, copy, offsetAt, timeAt, positionAt, direction, spotWeight, sampleTime, cleanState, loadImage, createRenderer
  };
})();
