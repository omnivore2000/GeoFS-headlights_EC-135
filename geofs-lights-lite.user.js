// ==UserScript==
// @name         GeoFS Lights Lite (beacon / strobe / nav glow + headlights)
// @namespace    geofs-lights-lite
// @version      2.5.0
// @description  Realistic aircraft lighting for GeoFS 4.0: solid beacon / strobe / nav lights and per-aircraft taxi, landing and runway-turnoff headlights that light up the ground. In-game settings panel (Alt+H), key / joystick binds for every light group. Inspired by Ariakim-Taiyo's lightsShader.js.
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @match        https://beta.geo-fs.com/*
// @grant        none
// @noframes
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '2.5.0';
  const LOG = '[LightsLite]';
  const MAX_LIGHTS = 16;
  const MAX_SPOTS = 12;          // hard cap (arrays are allocated for this many)
  const spotLimit = () => Math.max(1, Math.min(MAX_SPOTS, Math.round(Number(settings.maxSpots) || 10)));
  const SETTINGS_KEY = 'geofsLightsLite.settings.v2';
  const AIRCRAFT_KEY = 'geofsLightsLite.aircraft.v2';

  // ------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------
  const DEFAULTS = {
    enabled: true,
    intensity: 2.5,          // everything
    dayFactor: 0.3,          // how much remains in daylight

    // Aircraft lights (nav / beacon / strobe)
    pointIntensity: 0.75,
    range: 10,               // metres they light surfaces
    falloff: 0.05,
    halo: 0.75,              // soft bloom around a lamp
    core: 2.9,               // brightness of the solid lamp core
    lampSize: 0.1,           // physical lamp radius in metres
    strobeBoost: 0.1,
    beaconBoost: 0.9,
    navBoost: 0.2,
    nearFade: 15,            // no light on surfaces this close to the camera (cockpit interior)
    maxDistance: 8000.0,

    // Headlights
    headlightMode: 'auto',   // 'auto' (night) / 'on' / 'off'
    headlights: true,        // use real taxi/landing lights of addon aircraft when present
    headlightIntensity: 1.0, // multiplier on top of each aircraft's own value
    headlightGlare: 0.5,
    maxSpots: 10,            // max. headlight beams drawn at once (more = a bit slower)
    types: {
      taxi:    { color: '#fff1d6', intensity: 1.0, coneInner: 10, coneOuter: 24, range: 250, falloff: 0.0004, tilt: -6 },
      landing: { color: '#f4f7ff', intensity: 1.0, coneInner: 4,  coneOuter: 11, range: 700, falloff: 0.0001, tilt: -1.5 },
      turnoff: { color: '#fff4e2', intensity: 0.8, coneInner: 12, coneOuter: 28, range: 160, falloff: 0.0008, tilt: -3 },
    },

    // Light switches (Alt+H panel or your own key / joystick binds)
    switches: { taxi: true, landing: true, turnoff: true, nav: true, beacon: true, strobe: true },
    binds: {},               // { landing: { kind: 'key', code: 'KeyJ', alt, ctrl, shift } | { kind: 'pad', id, button } }
    toasts: true,            // short on-screen message when a light is switched

    pitchSign: -1,           // htr fallback (GeoFS 4.0: negative htr[1] = nose up)
    rollSign: -1,            // htr fallback (measured: negative htr[2] = right wing down)
    headingOffset: 0,        // fallback only
    perAircraft: {},         // live per-aircraft edits; saved with saveAircraft()
    toggleKey: 'KeyL',       // Alt+L: effect on/off
    uiKey: 'KeyH',           // Alt+H: settings panel
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  function deepMerge(target, src) {
    if (!src || typeof src !== 'object') return target;
    for (const k of Object.keys(src)) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && target[k] && typeof target[k] === 'object') deepMerge(target[k], src[k]);
      else target[k] = src[k];
    }
    return target;
  }
  function loadJSON(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function saveJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }

  const INTERNAL_KEYS = ['pitchSign', 'rollSign', 'headingOffset', 'perAircraft', 'enabled'];
  const stored = loadJSON(SETTINGS_KEY) || {};
  for (const k of INTERNAL_KEYS) delete stored[k];
  const settings = deepMerge(clone(DEFAULTS), stored);
  settings.perAircraft = {};
  settings.enabled = true;

  let saveTimer = null;
  function persistSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const s = clone(settings);
      for (const k of INTERNAL_KEYS) delete s[k];
      saveJSON(SETTINGS_KEY, s);
    }, 300);
  }

  if (window.geofsLightsLite && typeof window.geofsLightsLite.destroy === 'function') {
    try { window.geofsLightsLite.destroy(); } catch (e) {}
  }

  // ------------------------------------------------------------------
  // Keys: Alt+L / Alt+H, swallowed so GeoFS never sees them (capture phase on window)
  // ------------------------------------------------------------------
  const swallowed = new Set();
  function isOurCombo(e) {
    return e.altKey && !e.ctrlKey && !e.metaKey && (e.code === settings.toggleKey || e.code === settings.uiKey);
  }
  function isTyping(t) {
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }
  function stopKey(e) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); swallowed.add(e.code); }
  function onKeyDown(e) {
    // Waiting for a key to bind?
    if (listening) {
      if (['ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight'].includes(e.code)) return;
      stopKey(e);
      if (e.code !== 'Escape') {
        settings.binds[listening] = { kind: 'key', code: e.code, alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey };
        persistSettings();
      }
      listening = null;
      renderBinds();
      return;
    }
    if (!isOurCombo(e)) {
      if (isTyping(e.target)) return;
      for (const name of Object.keys(settings.binds || {})) {
        const b = settings.binds[name];
        if (b && b.kind === 'key' && b.code === e.code && !!b.alt === e.altKey && !!b.ctrl === e.ctrlKey && !!b.shift === e.shiftKey) {
          stopKey(e);
          if (!e.repeat) toggleSwitch(name);
          return;
        }
      }
      return;
    }
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    swallowed.add(e.code);
    if (e.repeat) return;
    if (e.code === settings.uiKey) api.toggleUI();
    else api.toggle();
  }
  function onKeyUpOrPress(e) {
    if (swallowed.has(e.code) || isOurCombo(e)) {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (e.type === 'keyup') swallowed.delete(e.code);
    }
  }
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUpOrPress, true);
  window.addEventListener('keypress', onKeyUpOrPress, true);

  // ------------------------------------------------------------------
  // Light switches, binds, on-screen messages, joystick buttons
  // ------------------------------------------------------------------
  const ACTIONS = {
    landing: 'Landing lights', taxi: 'Taxi lights', turnoff: 'Turnoff lights',
    nav: 'Nav lights', beacon: 'Beacon', strobe: 'Strobes', headlights: 'All headlights',
  };
  let listening = null;          // action name waiting for a key / button
  let toastTimer = null;

  function toast(msg) {
    if (!settings.toasts || !document.body) return;
    let t = document.getElementById('lls-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'lls-toast';
      t.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:100001;pointer-events:none;' +
        'background:rgba(16,18,24,.88);color:#eef1f6;font:600 14px system-ui,-apple-system,Segoe UI,sans-serif;' +
        'padding:8px 16px;border-radius:8px;border:1px solid #2c313c;box-shadow:0 6px 20px rgba(0,0,0,.4);' +
        'transition:opacity .6s ease;opacity:0';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.transition = 'none';
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.transition = 'opacity .6s ease'; t.style.opacity = '0'; }, 2000);
  }

  function toggleSwitch(name) {
    const sw = settings.switches;
    let on;
    if (name === 'headlights') {
      on = !(sw.taxi || sw.landing || sw.turnoff);
      sw.taxi = sw.landing = sw.turnoff = on;
    } else {
      on = sw[name] = !(sw[name] !== false);
    }
    toast((ACTIONS[name] || name) + (on ? ' on' : ' off'));
    persistSettings();
    refreshers.forEach((f) => f());
  }

  function bindLabel(b) {
    if (!b) return '—';
    if (b.kind === 'key') {
      return (b.ctrl ? 'Ctrl+' : '') + (b.alt ? 'Alt+' : '') + (b.shift ? 'Shift+' : '') +
        String(b.code).replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ');
    }
    const short = String(b.id || 'joystick').replace(/\s*\(.*$/, '').slice(0, 18);
    return short + ' · button ' + (b.button + 1);
  }

  const padPrev = {};
  let padTimer = null;
  function pollPads() {
    let pads = [];
    try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) { return; }
    for (const gp of pads) {
      if (!gp) continue;
      const prev = padPrev[gp.index] || (padPrev[gp.index] = []);
      gp.buttons.forEach((b, i) => {
        const pressed = !!(b && (b.pressed || b.value > 0.5));
        if (pressed && !prev[i]) onPadButton(gp, i);
        prev[i] = pressed;
      });
    }
  }
  function onPadButton(gp, i) {
    if (listening) {
      settings.binds[listening] = { kind: 'pad', id: gp.id, button: i };
      listening = null;
      persistSettings();
      renderBinds();
      return;
    }
    for (const name of Object.keys(settings.binds || {})) {
      const b = settings.binds[name];
      if (b && b.kind === 'pad' && b.button === i && (!b.id || b.id === gp.id)) toggleSwitch(name);
    }
  }
  padTimer = setInterval(pollPads, 40);

  let renderBinds = () => {};

  // ------------------------------------------------------------------
  // Shader
  // ------------------------------------------------------------------
  const SHADER_MODERN = `
    uniform sampler2D colorTexture;
    uniform sampler2D depthTexture;
    in vec2 v_textureCoordinates;

    #define MAX_LIGHTS ${MAX_LIGHTS}
    #define MAX_SPOTS __MAX_SPOTS__
    uniform vec4 u_lightPosEC[MAX_LIGHTS];   // xyz eye position, w strength
    uniform vec3 u_lightColor[MAX_LIGHTS];
    uniform int u_count;
    uniform vec4 u_spotPosEC[MAX_SPOTS];     // xyz eye position, w strength
    uniform vec3 u_spotDirEC[MAX_SPOTS];
    uniform vec4 u_spotCone[MAX_SPOTS];      // x cos(inner), y cos(outer), z range, w falloff
    uniform vec3 u_spotColor[MAX_SPOTS];
    uniform int u_spotCount;
    uniform float u_logDepth;
    uniform float u_intensity;
    uniform float u_range;
    uniform float u_falloff;
    uniform float u_halo;
    uniform float u_core;
    uniform float u_lampSize;
    uniform float u_pixelAngle;
    uniform float u_spotGlare;
    uniform float u_dayFactor;
    uniform float u_nearFade;

    vec3 rayAt(vec2 uv) {
      vec4 n = czm_inverseProjection * vec4(uv * 2.0 - 1.0, -1.0, 1.0);
      return normalize(n.xyz / n.w);
    }

    // Eye-space surface position at uv; w = 0 for sky
    vec4 surfaceAt(vec2 uv) {
      float raw = czm_unpackDepth(texture(depthTexture, uv));
      if (raw >= 0.9999999) return vec4(0.0);
      vec3 p;
      if (u_logDepth > 0.5) {
        float zLin = pow(2.0, raw * czm_log2FarDepthFromNearPlusOne) - 1.0 + czm_currentFrustum.x;
        vec3 r = rayAt(uv);
        p = r * (zLin / max(-r.z, 1e-4));
      } else {
        float d = czm_readDepth(depthTexture, uv);
        vec4 e = czm_windowToEyeCoordinates(uv * czm_viewport.zw + czm_viewport.xy, d);
        p = e.xyz / e.w;
      }
      if (length(p) > 500000.0) return vec4(0.0);
      return vec4(p, 1.0);
    }

    // Normal from the depth buffer using the smaller of the left/right and up/down differences, so pixels
    // at an edge (e.g. the windscreen frame against the outside) don't get a garbage normal.
    vec3 normalAt(vec2 uv, vec3 p) {
      vec2 px = 1.0 / czm_viewport.zw;
      vec4 r = surfaceAt(uv + vec2(px.x, 0.0));
      vec4 l = surfaceAt(uv - vec2(px.x, 0.0));
      vec4 t = surfaceAt(uv + vec2(0.0, px.y));
      vec4 b = surfaceAt(uv - vec2(0.0, px.y));
      vec3 dx1 = r.xyz - p;
      vec3 dx2 = p - l.xyz;
      vec3 dy1 = t.xyz - p;
      vec3 dy2 = p - b.xyz;
      vec3 dx = (r.w < 0.5) ? dx2 : (l.w < 0.5) ? dx1 : (dot(dx1, dx1) < dot(dx2, dx2) ? dx1 : dx2);
      vec3 dy = (t.w < 0.5) ? dy2 : (b.w < 0.5) ? dy1 : (dot(dy1, dy1) < dot(dy2, dy2) ? dy1 : dy2);
      vec3 n = cross(dx, dy);
      float len = length(n);
      if (len < 1e-8) return -normalize(p);
      n /= len;
      if (dot(n, -p) < 0.0) n = -n;
      return n;
    }

    // Is the lamp itself hidden behind geometry (fuselage, wing)? Tested at the lamp's own pixel.
    float lampVisibility(vec3 L) {
      vec4 clip = czm_projection * vec4(L, 1.0);
      if (clip.w <= 0.0) return 0.0;
      vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
      float dl = length(L);
      float bias = 0.35 + dl * 0.002;
      vec2 px = 1.5 / czm_viewport.zw;
      float v = 0.0;
      vec4 s;
      s = surfaceAt(uv);                     v += (s.w < 0.5 || length(s.xyz) > dl - bias) ? 1.0 : 0.0;
      s = surfaceAt(uv + vec2(px.x, 0.0));   v += (s.w < 0.5 || length(s.xyz) > dl - bias) ? 1.0 : 0.0;
      s = surfaceAt(uv - vec2(px.x, 0.0));   v += (s.w < 0.5 || length(s.xyz) > dl - bias) ? 1.0 : 0.0;
      s = surfaceAt(uv + vec2(0.0, px.y));   v += (s.w < 0.5 || length(s.xyz) > dl - bias) ? 1.0 : 0.0;
      s = surfaceAt(uv - vec2(0.0, px.y));   v += (s.w < 0.5 || length(s.xyz) > dl - bias) ? 1.0 : 0.0;
      return v / 5.0;
    }

    // Solid lamp core + bloom. Size is physical up close and ~1 pixel far away, so distant
    // aircraft show crisp points instead of big lanterns.
    vec3 lampGlow(vec3 L, vec3 c, float sizeM, float bloomK, vec3 rayDir) {
      float t = dot(L, rayDir);
      if (t <= 0.3) return vec3(0.0);
      float ang = length(L - rayDir * t) / t;
      if (ang > 0.25) return vec3(0.0);
      float r = max(sizeM / t, u_pixelAngle * 1.2);
      float x = ang / r;
      float maxX = mix(14.0, 5.0, clamp(t / 800.0, 0.0, 1.0));
      if (x > maxX) return vec3(0.0);
      float vis = lampVisibility(L);
      if (vis <= 0.0) return vec3(0.0);
      float farK = 1.0 / (1.0 + t / 350.0);
      float core = 1.0 - smoothstep(0.65, 1.0, x);
      float bloom = (exp(-x * x * 0.3) * 0.6 + 0.35 / (1.0 + x * x * 0.2)) * (1.0 - smoothstep(maxX * 0.65, maxX, x));
      float peak = max(c.r, max(c.g, c.b));
      vec3 coreCol = mix(c, vec3(peak), 0.55);
      return vis * (coreCol * core * u_core + c * bloom * bloomK * farK);
    }

    void main() {
      vec4 color = texture(colorTexture, v_textureCoordinates);
      if (u_count <= 0 && u_spotCount <= 0) { out_FragColor = color; return; }

      vec3 rayDir = rayAt(v_textureCoordinates);
      vec4 surf = surfaceAt(v_textureCoordinates);
      bool sky = surf.w < 0.5;
      vec3 posEC = surf.xyz;

      vec3 n = sky ? -rayDir : normalAt(v_textureCoordinates, posEC);

      vec3 upEC = normalize(czm_viewRotation * normalize(czm_viewerPositionWC));
      float sunElev = dot(normalize(czm_sunDirectionEC), upEC);
      float night = mix(u_dayFactor, 1.0, 1.0 - smoothstep(-0.08, 0.12, sunElev));

      float range2 = u_range * u_range;
      float nearK = sky ? 0.0 : smoothstep(u_nearFade * 0.5, u_nearFade, length(posEC));
      vec3 add = vec3(0.0);

      // --- Aircraft lights: beacon / strobe / nav ---
      for (int i = 0; i < MAX_LIGHTS; i++) {
        if (i >= u_count) break;
        vec4 L = u_lightPosEC[i];
        if (L.w <= 0.0) continue;
        vec3 c = u_lightColor[i] * L.w;
        if (!sky) {
          vec3 d = L.xyz - posEC;
          float dist2 = dot(d, d);
          if (dist2 < range2) {
            float att = 1.0 / (1.0 + dist2 * u_falloff);
            float edge = 1.0 - smoothstep(0.4 * range2, range2, dist2);
            // only surfaces that face the lamp (no light through wings / fuselage)
            float ndl = clamp(dot(n, d * inversesqrt(dist2 + 0.0001)) * 0.9 + 0.1, 0.0, 1.0);
            add += c * att * edge * ndl * nearK;
          }
        }
        add += lampGlow(L.xyz, c, u_lampSize, u_halo, rayDir);
      }

      // --- Headlights: taxi / landing / turnoff ---
      for (int j = 0; j < MAX_SPOTS; j++) {
        if (j >= u_spotCount) break;
        vec4 S = u_spotPosEC[j];
        if (S.w <= 0.0) continue;
        vec3 D = u_spotDirEC[j];
        vec4 K = u_spotCone[j];
        vec3 c = u_spotColor[j] * S.w;
        if (!sky) {
          vec3 d = posEC - S.xyz;
          float dist = length(d);
          if (dist > 0.5 && dist < K.z) {
            vec3 dn = d / dist;
            float cone = smoothstep(K.y, K.x, dot(dn, D));
            if (cone > 0.0) {
              float att = 1.0 / (1.0 + dist * dist * K.w);
              float edge = 1.0 - smoothstep(0.6 * K.z, K.z, dist);
              float ndl = max(dot(n, -dn), 0.0);
              add += c * cone * att * edge * ndl * nearK;
            }
          }
        }
        float tl = max(length(S.xyz), 0.001);
        float facing = max(smoothstep(K.y, 1.0, dot(-S.xyz / tl, D)), 0.06);
        add += lampGlow(S.xyz, c * facing, u_lampSize * 1.3, u_spotGlare, rayDir);
      }

      add *= u_intensity * night;
    #ifdef HAS_ISNAN
      if (any(isnan(add)) || any(isinf(add))) add = vec3(0.0);
    #else
      if (!(add.x == add.x && add.y == add.y && add.z == add.z)) add = vec3(0.0);
    #endif
      add = max(add, vec3(0.0));
      add = add / (1.0 + 0.2 * add);
      out_FragColor = vec4(color.rgb + add, color.a);
    }
  `;

  function buildShader(modern) {
    const src = SHADER_MODERN.replace('__MAX_SPOTS__', String(spotLimit()));
    if (modern) return '#define HAS_ISNAN\n' + src;
    return src
      .replace(/\bin vec2 v_textureCoordinates/, 'varying vec2 v_textureCoordinates')
      .replace(/\btexture\(/g, 'texture2D(')
      .replace(/\bout_FragColor\b/g, 'gl_FragColor');
  }

  function cesiumIsModern() {
    const v = String((window.Cesium && Cesium.VERSION) || '0');
    const m = v.match(/^(\d+)\.(\d+)/);
    if (!m) return true;
    return Number(m[1]) > 1 || Number(m[2]) >= 102;
  }

  // ------------------------------------------------------------------
  // Aircraft lights discovery
  // ------------------------------------------------------------------
  const COLORS = {
    red:    [1.0, 0.12, 0.08],
    green:  [0.15, 1.0, 0.3],
    white:  [1.0, 0.95, 0.88],
    yellow: [1.0, 0.72, 0.25],
    amber:  [1.0, 0.65, 0.2],
    orange: [1.0, 0.55, 0.15],
    blue:   [0.3, 0.5, 1.0],
  };
  const HEADLIGHT_RE = /landing|taxi|ldg|turnoff|runway.?turn|headlight|spot/;

  function isWorldVec(p) {
    return p && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number' &&
      Math.abs(p.x) + Math.abs(p.y) + Math.abs(p.z) > 1e5;
  }

  function findPrimitive(obj, depth, seen) {
    if (!obj || typeof obj !== 'object' || depth > 4 || seen.has(obj)) return null;
    seen.add(obj);
    try {
      if ('show' in obj && (isWorldVec(obj._actualPosition) || isWorldVec(obj.position))) return obj;
    } catch (e) {}
    for (const k of ['lightBillboard', '_billboard', 'billboard', 'primitive', '_primitive', 'point', '_point', 'glow']) {
      let child;
      try { child = obj[k]; } catch (e) { continue; }
      const r = findPrimitive(child, depth + 1, seen);
      if (r) return r;
    }
    return null;
  }

  function describe(light, prim) {
    const parts = [];
    for (const k of ['color', 'light', 'name', 'type', 'id']) if (typeof light[k] === 'string') parts.push(light[k]);
    try { if (prim && typeof prim._imageId === 'string') parts.push(prim._imageId); } catch (e) {}
    try { if (light.animations) parts.push(JSON.stringify(light.animations).slice(0, 400)); } catch (e) {}
    return parts.join(' ').toLowerCase();
  }

  function classify(light, prim) {
    const s = describe(light, prim);
    if (HEADLIGHT_RE.test(s)) {
      return { kind: 'spot', type: /turnoff|runway.?turn/.test(s) ? 'turnoff' : /taxi/.test(s) ? 'taxi' : 'landing' };
    }
    let color = COLORS.white;
    for (const name of Object.keys(COLORS)) if (s.includes(name)) { color = COLORS[name]; break; }
    // GeoFS uses "strobered" for the red anti-collision beacons (top / belly) and "strobewhite" for real strobes
    let group = 'nav';
    if (s.includes('beacon') || (s.includes('strobe') && color === COLORS.red)) group = 'beacon';
    else if (s.includes('strobe')) group = 'strobe';
    return { kind: 'point', color, group };
  }

  let lightList = [];   // [{ prim, color, pointKind }]
  let spotList = [];    // [{ prim, type }]
  let lastLightsRef = null, lastScan = 0, warnedNoLights = false;

  function rescanLights(now) {
    const inst = window.geofs && geofs.aircraft && geofs.aircraft.instance;
    const lights = inst && inst.lights;
    if (lights === lastLightsRef && now - lastScan < 2000) return;
    lastLightsRef = lights;
    lastScan = now;
    const points = [], spots = [];
    if (lights) {
      const arr = Array.isArray(lights) ? lights : Object.values(lights);
      for (const l of arr) {
        if (!l || typeof l !== 'object') continue;
        const prim = findPrimitive(l, 0, new Set());
        if (!prim) continue;
        const c = classify(l, prim);
        if (c.kind === 'spot') { if (spots.length < spotLimit()) spots.push({ prim, type: c.type }); }
        else if (points.length < MAX_LIGHTS) points.push({ light: l, prim, color: c.color, group: c.group, animOn: false, hiddenByUs: false });
      }
    }
    restoreHidden(lightList.filter((L) => !points.some((P) => P.prim === L.prim)));
    lightList = points;
    spotList = spots;
    if (!points.length && !spots.length && lights && Object.keys(lights).length && !warnedNoLights) {
      warnedNoLights = true;
      console.warn(LOG, 'aircraft has lights, but no positions found (GeoFS internals may have changed).');
    }
  }

  function boostFor(group) {
    return group === 'strobe' ? settings.strobeBoost : group === 'beacon' ? settings.beaconBoost : settings.navBoost;
  }

  // GeoFS' own on/off state of a light (its "show" animation: night / strobe / strobe2)
  function animStateOf(L) {
    try {
      const anims = L.light && L.light.animations;
      if (Array.isArray(anims)) {
        for (const a of anims) if (a && a.type === 'show' && typeof a.currentValue === 'number') return a.currentValue > 0;
      }
    } catch (e) {}
    return null;
  }

  // Runs every frame before drawing: remember what GeoFS wants, then hide GeoFS' own billboards
  // for groups the user switched off (nav / beacon / strobe).
  function enforceSwitches() {
    try { rescanLights(performance.now()); } catch (e) { return; }
    for (const L of lightList) {
      const p = L.prim;
      let st = animStateOf(L);
      if (st === null) {
        if (!L.hiddenByUs) { try { st = !!p.show; } catch (e) { st = false; } }
        else st = L.animOn;
      }
      L.animOn = st;
      const want = settings.switches[L.group] !== false;
      try {
        if (!want) { if (p.show) p.show = false; L.hiddenByUs = true; }
        else if (L.hiddenByUs) { p.show = st; L.hiddenByUs = false; }
      } catch (e) {}
    }
  }

  function restoreHidden(list) {
    for (const L of list || lightList) {
      if (!L.hiddenByUs) continue;
      try { L.prim.show = L.animOn; } catch (e) {}
      L.hiddenByUs = false;
    }
  }

  // ------------------------------------------------------------------
  // Aircraft frame (GeoFS 4.0: model +Y forward, +Z up, +X right — measured)
  // ------------------------------------------------------------------
  function getModelMatrix(inst) {
    try {
      const m = inst.object3d && inst.object3d.model && (inst.object3d.model._model || inst.object3d.model);
      return m && m.modelMatrix ? m.modelMatrix : null;
    } catch (e) { return null; }
  }

  function getAircraftFrame() {
    const inst = geofs.aircraft.instance;
    const R = Number(inst.boundingSphereRadius) || 20;
    let mm = getModelMatrix(inst);
    // In cockpit and some other views GeoFS stops updating the exterior model's matrix while the aircraft
    // keeps moving. Detect that (aircraft moves, matrix doesn't) and use llaLocation + htr instead.
    const lla = inst.llaLocation;
    if (mm && lla) {
      Cesium.Matrix4.getTranslation(mm, scratchT);
      Cesium.Cartesian3.fromDegrees(Number(lla[1]), Number(lla[0]), Number(lla[2]), undefined, scratchLLA);
      if (stale.has) {
        const mmMoved = Cesium.Cartesian3.distance(scratchT, stale.mm) > 0.001;
        const llaMoved = Cesium.Cartesian3.distance(scratchLLA, stale.lla) > 0.05;
        if (mmMoved) stale.on = false;
        else if (llaMoved) stale.on = true;
      }
      Cesium.Cartesian3.clone(scratchT, stale.mm);
      Cesium.Cartesian3.clone(scratchLLA, stale.lla);
      stale.has = true;
      if (stale.on) mm = null;
    }
    if (mm) {
      Cesium.Matrix4.getTranslation(mm, frame.pos);
      colToVec(mm, 0, frame.right);
      colToVec(mm, 1, frame.fwd);
      colToVec(mm, 2, frame.up);
      alignForwardWithHeading(inst, frame);
      frame.hasMatrix = true;
      frame.radius = R;
      return frame;
    }
    const htr = inst.htr;
    if (!lla || !htr) return null;
    const h = Cesium.Math.toRadians(Number(htr[0]) + settings.headingOffset);
    const p = Cesium.Math.toRadians(Number(htr[1]) * settings.pitchSign);
    const rl = Cesium.Math.toRadians((Number(htr[2]) || 0) * settings.rollSign);
    if (!isFinite(h) || !isFinite(p)) return null;
    Cesium.Cartesian3.fromDegrees(Number(lla[1]), Number(lla[0]), Number(lla[2]), undefined, frame.pos);
    Cesium.Transforms.eastNorthUpToFixedFrame(frame.pos, undefined, scratchMat);
    setENU(scratchMat, Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p), frame.fwd);
    setENU(scratchMat, Math.cos(h), -Math.sin(h), 0, frame.right);
    Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(frame.right, frame.fwd, frame.up), frame.up);
    if (rl) {   // roll: rotate right/up around forward (positive = right wing down)
      const c = Math.cos(rl), sn = Math.sin(rl);
      const r0 = Cesium.Cartesian3.clone(frame.right, scratchR0), u0 = Cesium.Cartesian3.clone(frame.up, scratchU0);
      frame.right.x = r0.x * c - u0.x * sn; frame.right.y = r0.y * c - u0.y * sn; frame.right.z = r0.z * c - u0.z * sn;
      frame.up.x = u0.x * c + r0.x * sn; frame.up.y = u0.y * c + r0.y * sn; frame.up.z = u0.z * c + r0.z * sn;
    }
    frame.hasMatrix = false;
    frame.radius = R;
    return frame;
  }

  // Some models (e.g. the DC-10) are rotated inside their model matrix; GeoFS' heading is reliable,
  // so use the horizontal model axis that best matches it as "forward".
  const axisCand = [];
  function alignForwardWithHeading(inst, f) {
    const htr = inst.htr;
    if (!htr || !isFinite(Number(htr[0]))) return;
    Cesium.Transforms.eastNorthUpToFixedFrame(f.pos, undefined, scratchMat);
    const h = Cesium.Math.toRadians(Number(htr[0]));
    setENU(scratchMat, Math.sin(h), Math.cos(h), 0, scratchHdg);
    if (!axisCand.length) for (let i = 0; i < 4; i++) axisCand.push(new Cesium.Cartesian3());
    Cesium.Cartesian3.clone(f.fwd, axisCand[0]);
    Cesium.Cartesian3.negate(f.fwd, axisCand[1]);
    Cesium.Cartesian3.clone(f.right, axisCand[2]);
    Cesium.Cartesian3.negate(f.right, axisCand[3]);
    let best = 0, bestDot = -2;
    for (let i = 0; i < 4; i++) {
      const d = Cesium.Cartesian3.dot(axisCand[i], scratchHdg);
      if (d > bestDot) { bestDot = d; best = i; }
    }
    f.axisFix = best;
    if (best === 0) return;
    Cesium.Cartesian3.clone(axisCand[best], f.fwd);
    Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(f.fwd, f.up, f.right), f.right);
  }

  function colToVec(m, idx, out) {
    Cesium.Matrix4.getColumn(m, idx, scratchC4);
    out.x = scratchC4.x; out.y = scratchC4.y; out.z = scratchC4.z;
    return Cesium.Cartesian3.normalize(out, out);
  }

  function setENU(enuMat, e, n, u, out) {
    scratchENU.x = e; scratchENU.y = n; scratchENU.z = u;
    Cesium.Matrix4.multiplyByPointAsVector(enuMat, scratchENU, out);
    return Cesium.Cartesian3.normalize(out, out);
  }

  function localToWorld(f, x, y, z, out) {
    out.x = f.pos.x + f.right.x * x + f.fwd.x * y + f.up.x * z;
    out.y = f.pos.y + f.right.y * x + f.fwd.y * y + f.up.y * z;
    out.z = f.pos.z + f.right.z * x + f.fwd.z * y + f.up.z * z;
    return out;
  }

  function beamDir(f, tiltDeg, yawDeg, out) {
    const t = Cesium.Math.toRadians(tiltDeg), y = Cesium.Math.toRadians(yawDeg || 0);
    const cf = Math.cos(t) * Math.cos(y), cr = Math.cos(t) * Math.sin(y), cu = Math.sin(t);
    out.x = f.fwd.x * cf + f.right.x * cr + f.up.x * cu;
    out.y = f.fwd.y * cf + f.right.y * cr + f.up.y * cu;
    out.z = f.fwd.z * cf + f.right.z * cr + f.up.z * cu;
    return Cesium.Cartesian3.normalize(out, out);
  }

  function lightsShouldBeOn() {
    try {
      const night = geofs.animation.values.night;
      if (night !== undefined) return !!night;
    } catch (e) {}
    return performance.now() - lastLightsOnAt < 2000;
  }

  // ------------------------------------------------------------------
  // Per-aircraft lamp layouts
  // Each aircraft has its own list of lamps. A lamp: { type: 'taxi'|'landing'|'turnoff', x, y, z,
  //   tilt?, yaw?, strength?, mirror?, coneInner?, coneOuter?, range?, falloff? }
  // x right, y forward, z up, metres from the model origin. mirror: true = a left/right pair (±x, ±yaw).
  // Positions and lamp counts tuned by hand in GeoFS 4.0 for every built-in aircraft below.
  // Priority: settings.perAircraft > saved (localStorage) > built-in > automatic.
  // ------------------------------------------------------------------
  const lamp = (type, x, y, z, o) => Object.assign({ type, x, y, z }, o || {});
  const AIRCRAFT_LAYOUTS = {
    '2': { name: 'Cessna 172', headlightIntensity: 2, lamps: [
      lamp('landing', 0, 2.1, -0.8, { tilt: -9, range: 200, coneOuter: 15, coneInner: 4 }),
      lamp('taxi', 0, 2.1, -0.8, { tilt: -9, coneOuter: 30, coneInner: 4, strength: 0.7 }),
    ] },
    '4': { name: 'Boeing 737-700', headlightIntensity: 2, lamps: [
      lamp('taxi', 0, 13.4, -1.85, { tilt: -5, strength: 0.6 }),
      lamp('landing', 2.2, 5, -0.5, { tilt: -1, yaw: 2, mirror: true }),
      lamp('turnoff', 2.5, 4.8, -0.4, { yaw: 20, mirror: true, strength: 0.7 }),
    ] },
    '5': { name: 'Embraer Phenom 100', headlightIntensity: 1.6, lamps: [
      lamp('landing', 0.77, 1.5, -0.35, { tilt: -1, yaw: 4, mirror: true, strength: 1.5 }),
      lamp('taxi', 0.77, 1.5, -0.35, { mirror: true, tilt: -1, yaw: 3, coneOuter: 19, coneInner: 10, strength: 0.7 }),
    ] },
    '6': { name: 'DHC-6 Twin Otter', headlightIntensity: 1.6, lamps: [
      lamp('taxi', -0.3, 3.4, -1.05, { tilt: -5, strength: 0.9 }),
      lamp('landing', 3.6, -0.1, 1.27, { tilt: -11, yaw: 2, mirror: true, strength: 0.8, coneOuter: 15, coneInner: 4 }),
    ] },
    '7': { headlightIntensity: 2, lamps: [
      lamp('taxi', 0.28, 3.5, -1.03, { strength: 0.8, coneOuter: 30, coneInner: 10 }),
      lamp('landing', 0.28, 3.5, -1.2, { coneOuter: 15, coneInner: 4, strength: 1.3 }),
    ] },
    '9': { headlightIntensity: 2, lamps: [] },   // no headlights
    '10': { name: 'Airbus A380', headlightIntensity: 2, lamps: [
      lamp('taxi', 0, 29.1, -2.9, { tilt: -6, strength: 0.8 }),
      lamp('landing', 5.06, 13.2, 0.2, { tilt: -1.5, yaw: 2, mirror: true, strength: 0.8 }),
      lamp('turnoff', 0.2, 28.8, -2.43, { yaw: 22, mirror: true, strength: 0.7 }),
    ] },
    '12': { name: 'Pilatus PC-7 Mk-I', headlightIntensity: 1.8, lamps: [
      lamp('landing', 1.2, -0.12, -0.3, { tilt: -1, yaw: 4, mirror: true, strength: 1.2 }),
    ] },
    '16': { headlightIntensity: 2, lamps: [
      lamp('landing', 5.55, 0.5, -0.58, { yaw: 2, mirror: true, tilt: -20, coneOuter: 20, coneInner: 4, strength: 0.8, range: 800 }),
    ] },
    '17': { name: 'McDonnell Douglas DC-10-40', headlightIntensity: 2, lamps: [
      lamp('taxi', 0.18, 22.7, -1.5, { tilt: -6, strength: 0.7, mirror: true, coneOuter: 35, coneInner: 10 }),
      lamp('landing', 2.48, 25, 0.4, { tilt: -1.5, yaw: 8, mirror: true, range: 300, strength: 0.8 }),
      lamp('turnoff', 3.6, 9, 0.5, { mirror: true, yaw: 30, strength: 1.5, range: 250 }),
      lamp('landing', 0.18, 22.7, -1.5, { mirror: true, strength: 1 }),
    ] },
    '18': { headlightIntensity: 2, lamps: [
      lamp('landing', 0.13, 5, -0.25, { yaw: 5, mirror: true, strength: 0.9, tilt: -4, coneOuter: 15, coneInner: 4 }),
      lamp('taxi', 0, 5.1, -0.82, { coneOuter: 35, coneInner: 10, tilt: -4, strength: 0.8, range: 400 }),
    ] },
    '20': { headlightIntensity: 2, lamps: [
      lamp('taxi', 0.3, 16.3, -0.6, { strength: 0.7, mirror: true }),
      lamp('landing', 1.2, 13.9, -0.25, { yaw: 2, mirror: true, strength: 1.4 }),
      lamp('turnoff', 0.85, 26.85, -0.1, { mirror: true, strength: 1, coneOuter: 30, coneInner: 12, yaw: 35 }),
    ] },
    '22': { headlightIntensity: 2, lamps: [
      lamp('landing', 0, 1.5, -0.1, { range: 250, coneOuter: 15, coneInner: 4, strength: 0.8, tilt: -4 }),
      lamp('taxi', 0, 1.5, -0.1, { mirror: true, coneOuter: 30, coneInner: 10, strength: 0.3 }),
    ] },
    '24': { name: 'Airbus A350', headlightIntensity: 2, lamps: [
      lamp('taxi', 0, 27.6, -2.6, { tilt: -6, strength: 0.9 }),
      lamp('landing', 4.2, 9, -0.2, { tilt: -1.5, yaw: 6, mirror: true, coneOuter: 13, coneInner: 4, range: 700, strength: 1.3 }),
      lamp('turnoff', 0.14, 27.5, -2.77, { yaw: 30, mirror: true, strength: 1.4, coneOuter: 30, coneInner: 1, range: 200 }),
      lamp('landing', 0.28, 27.3, -1.84, { mirror: true, strength: 0.8 }),
    ] },
    '25': { name: 'Boeing 777-300ER', headlightIntensity: 2, lamps: [
      lamp('landing', 3.8, 7.3, 0.3, { tilt: -1.5, yaw: 2, mirror: true }),
      lamp('turnoff', 3.9, 7.3, 0.3, { yaw: 20, mirror: true, strength: 0.8, range: 200 }),
      lamp('taxi', 0.26, 28.8, -2.2, { mirror: true, strength: 0.5 }),
      lamp('landing', 0.232, 28.8, -1.9, { mirror: true, strength: 1 }),
    ] },
    '27': { headlightIntensity: 2, lamps: [
      lamp('taxi', 0, 5.3, -1, { strength: 0.8, coneOuter: 35, coneInner: 10 }),
      lamp('landing', 0, 5.3, -1, { coneOuter: 15, coneInner: 4 }),
    ] },
    '28': { name: 'Beechcraft Baron B55', headlightIntensity: 1.8, lamps: [
      lamp('taxi', 0, 2, -0.63, { tilt: -4, strength: 1, coneOuter: 35, coneInner: 10 }),
      lamp('landing', 4.9, 0.5, 0.08, { tilt: -5, yaw: 1, mirror: true, range: 250, strength: 0.9 }),
    ] },
    '29': { headlightIntensity: 2, lamps: [
      lamp('landing', 0.14, 3.9, -0.98, { yaw: 3, mirror: true, strength: 1, coneOuter: 15, coneInner: 4 }),
      lamp('taxi', 0.14, 3.9, -0.98, { mirror: true, yaw: 10, strength: 0.7, coneOuter: 30, coneInner: 10 }),
    ] },
    '6012': { headlightIntensity: 2, lamps: [
      lamp('taxi', 0.25, 22.7, -1.6, { strength: 0.5, mirror: true }),
      lamp('landing', 3.3, 5.9, 0.2, { yaw: 4, mirror: true, coneOuter: 9, coneInner: 4 }),
      lamp('landing', 0.25, 22.7, -1.6, { mirror: true, strength: 0.6, coneOuter: 8, coneInner: 4, tilt: -1.5 }),
      lamp('turnoff', 0.2, 22.7, -2.35, { mirror: true, strength: 1, yaw: 25 }),
    ] },
      '9': { name: 'Eurocopter EC135', headlightIntensity: 1.6, lamps: [
      lamp('landing', 0.77, 1.5, -0.35, { tilt: -15, yaw: 4, mirror: true, strength: 1.5 }),
      lamp('taxi', 0.77, 1.5, -0.35, { mirror: true, tilt: -1, yaw: 3, coneOuter: 19, coneInner: 10, strength: 0.7 }),
    ] },
  };

  let savedLayouts = loadJSON(AIRCRAFT_KEY) || {};

  // Old format { taxiLight, landingLight } -> lamps
  function normalizeLayout(l) {
    if (!l) return null;
    if (Array.isArray(l.lamps)) return l;
    const lamps = [];
    if (l.taxiLight) lamps.push(Object.assign({ type: 'taxi' }, l.taxiLight));
    if (l.landingLight) lamps.push(Object.assign({ type: 'landing', mirror: l.landingLight.mirror !== false }, l.landingLight));
    return { lamps, headlightIntensity: l.headlightIntensity };
  }

  function readCollisionPoints(inst) {
    const out = [];
    try {
      for (const p of inst.collisionPoints || []) {
        const v = Array.isArray(p) ? p : (p && (p.position || p.value));
        if (Array.isArray(v) && v.length >= 3 && v.every((n) => typeof n === 'number' && isFinite(n))) out.push(v);
      }
    } catch (e) {}
    return out;
  }

  let autoCache = { key: null, layout: null };
  function autoLayout(inst, R) {
    const key = String(inst.id) + '|' + R;
    if (autoCache.key === key && autoCache.inst === inst) return autoCache.layout;
    const pts = readCollisionPoints(inst);
    let nose = null, minZ = 0;
    for (const p of pts) {
      if (Math.abs(p[0]) < 1.0 && p[2] < -0.5 && (!nose || p[1] > nose[1])) nose = p;
      if (Math.abs(p[0]) < 8 && p[2] < minZ) minZ = p[2];
    }
    if (nose && nose[1] < R * 0.2) nose = null;
    const ty = nose ? nose[1] + 0.4 : Math.min(40, Math.max(1.5, R * 0.47));
    const tz = nose ? nose[2] - 0.6 : (minZ < 0 ? Math.max(minZ * 0.9, -3) : -Math.min(3, Math.max(0.4, R * 0.05)));
    const layout = {
      headlightIntensity: 2,
      lamps: [
        lamp('taxi', 0, ty, tz, { strength: 0.6 }),
        lamp('landing', Math.min(6, Math.max(0.8, R * 0.085)), ty * 0.22, tz + 0.6, { yaw: 2, mirror: true }),
      ],
      source: nose ? 'auto (collision points)' : 'auto (size)',
    };
    autoCache = { key, inst, layout };
    return layout;
  }

  function layoutFor(inst, R) {
    const id = String(inst.id);
    const live = normalizeLayout(settings.perAircraft[id]);
    const saved = normalizeLayout(savedLayouts[id]);
    const builtIn = AIRCRAFT_LAYOUTS[id];
    const pick = live || saved || builtIn || autoLayout(inst, R);
    return {
      lamps: pick.lamps || [],
      headlightIntensity: typeof pick.headlightIntensity === 'number' ? pick.headlightIntensity : 2,
      name: (builtIn && builtIn.name) || null,
      source: live ? 'live edit' : saved ? 'saved' : builtIn ? 'built-in' : pick.source || 'auto',
    };
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return [1, 1, 1];
    const n = parseInt(m[1], 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }

  // ------------------------------------------------------------------
  // Uniform data (preallocated, filled in place — never resized)
  // ------------------------------------------------------------------
  const posArr = [], colArr = [], spotPosArr = [], spotDirArr = [], spotConeArr = [], spotColArr = [];
  let scratchWC, scratchEC, scratchENU, scratchDirWC, scratchMat, scratchC4, scratchNose, scratchHdg;
  let frame = null;
  let scratchT, scratchLLA, scratchR0, scratchU0;
  const stale = { has: false, on: false, mm: null, lla: null };
  let count = 0, spotCount = 0;
  let lastLightsOnAt = -1e9;
  let lastFrame = -1;
  let consecutiveErrors = 0;

  function initArrays() {
    if (posArr.length) return;
    for (let i = 0; i < MAX_LIGHTS; i++) {
      posArr.push(new Cesium.Cartesian4(0, 0, 0, 0));
      colArr.push(new Cesium.Cartesian3(0, 0, 0));
    }
    for (let i = 0; i < MAX_SPOTS; i++) {
      spotPosArr.push(new Cesium.Cartesian4(0, 0, 0, 0));
      spotDirArr.push(new Cesium.Cartesian3(0, 0, 1));
      spotConeArr.push(new Cesium.Cartesian4(1, 0.9, 600, 0.0001));
      spotColArr.push(new Cesium.Cartesian3(0, 0, 0));
    }
    scratchWC = new Cesium.Cartesian3();
    scratchEC = new Cesium.Cartesian3();
    scratchENU = new Cesium.Cartesian3();
    scratchDirWC = new Cesium.Cartesian3();
    scratchNose = new Cesium.Cartesian3();
    scratchHdg = new Cesium.Cartesian3();
    scratchMat = new Cesium.Matrix4();
    scratchC4 = new Cesium.Cartesian4();
    scratchT = new Cesium.Cartesian3(); scratchLLA = new Cesium.Cartesian3();
    scratchR0 = new Cesium.Cartesian3(); scratchU0 = new Cesium.Cartesian3();
    stale.mm = new Cesium.Cartesian3(); stale.lla = new Cesium.Cartesian3();
    frame = { pos: new Cesium.Cartesian3(), fwd: new Cesium.Cartesian3(), up: new Cesium.Cartesian3(),
              right: new Cesium.Cartesian3(), hasMatrix: false, radius: 20 };
  }

  function primWorldPos(p) {
    let visible = false;
    try { visible = !!p.show; } catch (e) {}
    if (!visible) return null;
    try { if (p.color && typeof p.color.alpha === 'number' && p.color.alpha <= 0.01) return null; } catch (e) {}
    const wc = isWorldVec(p._actualPosition) ? p._actualPosition : p.position;
    return isWorldVec(wc) ? wc : null;
  }

  let markers = null;
  function pushSpot(view, wc, dirWC, lampDef, typeName, scale) {
    if (spotCount >= spotLimit()) return;
    const T = settings.types[typeName] || settings.types.landing;
    if (markers) {
      try {
        const a = markers.get(spotCount * 2), b = markers.get(spotCount * 2 + 1);
        a.position = wc; a.show = true;
        b.position = Cesium.Cartesian3.add(wc, Cesium.Cartesian3.multiplyByScalar(dirWC, 40, new Cesium.Cartesian3()), new Cesium.Cartesian3());
        b.show = true;
      } catch (e) {}
    }
    Cesium.Matrix4.multiplyByPoint(view, wc, scratchEC);
    const sp = spotPosArr[spotCount];
    sp.x = scratchEC.x; sp.y = scratchEC.y; sp.z = scratchEC.z;
    sp.w = (lampDef.strength != null ? lampDef.strength : 1) * T.intensity * scale;
    Cesium.Matrix4.multiplyByPointAsVector(view, dirWC, scratchEC);
    Cesium.Cartesian3.normalize(scratchEC, spotDirArr[spotCount]);
    const ci = lampDef.coneInner != null ? lampDef.coneInner : T.coneInner;
    const co = lampDef.coneOuter != null ? lampDef.coneOuter : T.coneOuter;
    const k = spotConeArr[spotCount];
    k.x = Math.cos(Cesium.Math.toRadians(Math.min(ci, co - 0.5)));
    k.y = Math.cos(Cesium.Math.toRadians(co));
    k.z = lampDef.range != null ? lampDef.range : T.range;
    k.w = lampDef.falloff != null ? lampDef.falloff : T.falloff;
    const rgb = hexToRgb(lampDef.color || T.color);
    const c = spotColArr[spotCount];
    c.x = rgb[0]; c.y = rgb[1]; c.z = rgb[2];
    spotCount++;
  }

  function refresh() {
    const scene = getScene();
    if (!scene || !posArr.length) return;
    const fn = scene.frameState ? scene.frameState.frameNumber : performance.now();
    if (fn === lastFrame) return;
    lastFrame = fn;

    try {
      rescanLights(performance.now());
      const view = scene.camera.viewMatrix;
      const maxD2 = settings.maxDistance * settings.maxDistance;

      let n = 0;
      for (const L of lightList) {
        if (!L.animOn || settings.switches[L.group] === false) continue;
        const wc = isWorldVec(L.prim._actualPosition) ? L.prim._actualPosition : L.prim.position;
        if (!isWorldVec(wc)) continue;
        Cesium.Cartesian3.clone(wc, scratchWC);
        Cesium.Matrix4.multiplyByPoint(view, scratchWC, scratchEC);
        const d2 = scratchEC.x * scratchEC.x + scratchEC.y * scratchEC.y + scratchEC.z * scratchEC.z;
        if (d2 > maxD2) continue;
        const pa = posArr[n];
        pa.x = scratchEC.x; pa.y = scratchEC.y; pa.z = scratchEC.z;
        pa.w = boostFor(L.group) * settings.pointIntensity;
        const ca = colArr[n];
        ca.x = L.color[0]; ca.y = L.color[1]; ca.z = L.color[2];
        if (++n >= MAX_LIGHTS) break;
      }
      for (let i = n; i < MAX_LIGHTS; i++) posArr[i].w = 0;
      count = n;

      spotCount = 0;
      const mode = settings.headlightMode;
      if (count > 0) lastLightsOnAt = performance.now();
      const wantReal = settings.headlights && spotList.length > 0;
      const wantVirtual = !wantReal && (mode === 'on' || (mode === 'auto' && lightsShouldBeOn()));
      if (wantReal || wantVirtual) {
        const f = getAircraftFrame();
        if (f) {
          if (wantReal) {
            for (const S of spotList) {
              if (settings.switches[S.type] === false) continue;
              const wc = primWorldPos(S.prim);
              if (!wc) continue;
              const T = settings.types[S.type];
              pushSpot(view, wc, beamDir(f, T.tilt, 0, scratchDirWC), {}, S.type, settings.headlightIntensity * 2);
            }
          }
          if (wantVirtual) {
            const lay = layoutFor(geofs.aircraft.instance, f.radius);
            const scale = lay.headlightIntensity * settings.headlightIntensity;
            for (const lp of lay.lamps) {
              if (!lp || (lp.strength != null && lp.strength <= 0)) continue;
              if (settings.switches[lp.type || 'landing'] === false) continue;
              const T = settings.types[lp.type] || settings.types.landing;
              const tilt = lp.tilt != null ? lp.tilt : T.tilt;
              const yaw = lp.yaw || 0;
              const x = Number(lp.x) || 0, y = Number(lp.y) || 0, z = Number(lp.z) || 0;
              if (lp.mirror) {
                pushSpot(view, localToWorld(f, -Math.abs(x), y, z, scratchNose), beamDir(f, tilt, -yaw, scratchDirWC), lp, lp.type, scale);
                pushSpot(view, localToWorld(f, Math.abs(x), y, z, scratchNose), beamDir(f, tilt, yaw, scratchDirWC), lp, lp.type, scale);
              } else {
                pushSpot(view, localToWorld(f, x, y, z, scratchNose), beamDir(f, tilt, yaw, scratchDirWC), lp, lp.type, scale);
              }
            }
          }
        }
      }
      for (let i = spotCount; i < MAX_SPOTS; i++) {
        spotPosArr[i].w = 0;
        if (markers) { try { markers.get(i * 2).show = false; markers.get(i * 2 + 1).show = false; } catch (e) {} }
      }
      consecutiveErrors = 0;
    } catch (e) {
      count = 0; spotCount = 0;
      if (++consecutiveErrors === 30) {
        console.error(LOG, 'too many errors, disabling effect.', e);
        api.disable();
      }
    }
  }

  // ------------------------------------------------------------------
  // Stage management (+ watchdog against the black-scene-on-load problem)
  // ------------------------------------------------------------------
  let stage = null;
  let addedAt = 0;
  let renderErrorRemover = null;
  let watchdog = null;
  let preRenderRemover = null;
  let readds = 0;

  function getScene() {
    try { return geofs.api.viewer.scene; } catch (e) { return null; }
  }

  function u(fn) { return function () { refresh(); return fn(); }; }

  function addStage() {
    const scene = getScene();
    if (!scene || stage) return;
    stage = new Cesium.PostProcessStage({
      name: 'geofsLightsLite',
      fragmentShader: buildShader(cesiumIsModern()),
      uniforms: {
        u_lightPosEC: u(() => posArr),
        u_lightColor: u(() => colArr),
        u_count: u(() => (settings.enabled ? count : 0)),
        u_spotPosEC: u(() => spotPosArr),
        u_spotDirEC: u(() => spotDirArr),
        u_spotCone: u(() => spotConeArr),
        u_spotColor: u(() => spotColArr),
        u_spotCount: u(() => (settings.enabled ? spotCount : 0)),
        u_logDepth: () => {
          const sc = getScene();
          const fs = sc && sc.frameState;
          return (fs && typeof fs.useLogDepth === 'boolean' ? fs.useLogDepth : !!(sc && sc.logarithmicDepthBuffer)) ? 1 : 0;
        },
        u_intensity: () => settings.intensity,
        u_range: () => settings.range,
        u_falloff: () => settings.falloff,
        u_halo: () => settings.halo,
        u_core: () => settings.core,
        u_lampSize: () => Math.max(0.05, settings.lampSize),
        u_pixelAngle: () => {
          const sc = getScene();
          const fr = sc && sc.camera && sc.camera.frustum;
          const fovy = (fr && (fr.fovy || fr._fovy)) || 0.8;
          const h = (sc && (sc.drawingBufferHeight || (sc.canvas && sc.canvas.height))) || 1000;
          return fovy / h;
        },
        u_spotGlare: () => settings.headlightGlare,
        u_nearFade: () => settings.nearFade,
        u_dayFactor: () => settings.dayFactor,
      },
    });
    scene.postProcessStages.add(stage);
    addedAt = performance.now();
  }

  function removeStage() {
    const scene = getScene();
    if (stage && scene) {
      try { scene.postProcessStages.remove(stage); } catch (e) {}
    }
    stage = null;
  }

  function readdStage(reason) {
    if (!settings.enabled || readds >= 6) return;
    readds++;
    removeStage();
    addStage();
    console.log(LOG, 're-attached effect (' + reason + ')');
  }

  // GeoFS adds its own post-process stages while loading. If ours ends up before them the scene can go
  // black (the same thing Alt+L off/on fixed). Keep ours last, and re-attach once after loading settles.
  function startWatchdog() {
    clearInterval(watchdog);
    let ticks = 0;
    watchdog = setInterval(() => {
      ticks++;
      const sc = getScene();
      if (!sc || !stage || !settings.enabled) return;
      try {
        const pps = sc.postProcessStages;
        if (pps.length && pps.get(pps.length - 1) !== stage) readdStage('not last in chain');
        else if (ticks === 3) readdStage('after load');
      } catch (e) {}
    }, 2000);
  }

  function onRenderError(scene, err) {
    const msg = String((err && (err.message || err)) || '');
    const ours = /u_lightPosEC|u_spot|geofsLightsLite|shader/i.test(msg) || performance.now() - addedAt < 8000;
    if (!stage || !ours) return;
    console.error(LOG, 'render error, removing effect:', msg.slice(0, 300));
    removeStage();
    settings.enabled = false;
    try {
      const viewer = geofs.api.viewer;
      if (viewer && viewer.useDefaultRenderLoop === false) viewer.useDefaultRenderLoop = true;
      document.querySelectorAll('.cesium-widget-errorPanel').forEach((el) => el.remove());
    } catch (e) {}
  }

  // ------------------------------------------------------------------
  // Settings panel (Alt+H)
  // ------------------------------------------------------------------
  let panel = null, panelTimer = null, lastPanelAircraft = null, rebuildTimer = null;
  const refreshers = [];

  const CSS = `
    #lls-panel{position:fixed;top:70px;right:16px;width:330px;max-height:calc(100vh - 100px);overflow:auto;z-index:100000;
      background:rgba(16,18,24,.95);color:#e6e8ee;font:12px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;border:1px solid #2c313c;
      border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.5);user-select:none}
    #lls-panel .lls-head{position:sticky;top:0;display:flex;align-items:center;gap:8px;padding:9px 12px;background:#1b1f28;cursor:move;
      border-bottom:1px solid #2c313c;border-radius:10px 10px 0 0}
    #lls-panel .lls-head b{flex:1;font-size:13px}
    #lls-panel .lls-x{cursor:pointer;opacity:.7;font-size:16px;padding:0 4px}
    #lls-panel .lls-x:hover{opacity:1}
    #lls-panel details{border-bottom:1px solid #252a34}
    #lls-panel summary{padding:8px 12px;cursor:pointer;font-weight:600;color:#cfd5e2}
    #lls-panel .lls-body{padding:2px 12px 10px}
    #lls-panel .lls-row{display:flex;align-items:center;gap:8px;margin:5px 0}
    #lls-panel .lls-row label{flex:0 0 112px;color:#aeb5c4}
    #lls-panel .lls-row input[type=range]{flex:1;accent-color:#7aa2ff}
    #lls-panel .lls-row .lls-val{flex:0 0 42px;text-align:right;font-variant-numeric:tabular-nums;color:#e6e8ee}
    #lls-panel input[type=color]{width:42px;height:22px;border:0;background:none;padding:0}
    #lls-panel select,#lls-panel input[type=number]{background:#11141b;color:#e6e8ee;border:1px solid #333a47;border-radius:5px;padding:2px 4px}
    #lls-panel input[type=number]{width:50px}
    #lls-panel button{background:#2a3242;color:#e6e8ee;border:1px solid #3a4459;border-radius:6px;padding:4px 9px;cursor:pointer;font-size:12px}
    #lls-panel button:hover{background:#34405a}
    #lls-panel .lls-lamp{background:#151922;border:1px solid #262c38;border-radius:7px;padding:6px 8px;margin:6px 0}
    #lls-panel .lls-lamp .lls-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:4px 6px;margin-top:5px}
    #lls-panel .lls-lamp .lls-grid span{display:block;color:#8d95a6;font-size:10px}
    #lls-panel .lls-note{color:#8d95a6;font-size:11px;margin:4px 0}
    #lls-panel .lls-btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  `;

  function el(tag, attrs, parent) {
    const e = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(e);
    return e;
  }

  // Generic slider bound to get/set
  function slider(parent, label, get, set, min, max, step, fmt) {
    const row = el('div', { class: 'lls-row' }, parent);
    el('label', { text: label }, row);
    const input = el('input', { type: 'range', min, max, step }, row);
    const val = el('span', { class: 'lls-val' }, row);
    const show = () => { const v = get(); input.value = v; val.textContent = fmt ? fmt(v) : (+v).toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0); };
    input.addEventListener('input', () => { set(parseFloat(input.value)); show(); persistSettings(); });
    refreshers.push(show); show();
  }
  function colorPick(parent, label, get, set) {
    const row = el('div', { class: 'lls-row' }, parent);
    el('label', { text: label }, row);
    const input = el('input', { type: 'color' }, row);
    const show = () => { input.value = get(); };
    input.addEventListener('input', () => { set(input.value); persistSettings(); });
    refreshers.push(show); show();
  }
  function choose(parent, label, get, set, options) {
    const row = el('div', { class: 'lls-row' }, parent);
    el('label', { text: label }, row);
    const s = el('select', null, row);
    for (const [v, t] of options) el('option', { value: v, text: t }, s);
    const show = () => { s.value = get(); };
    s.addEventListener('change', () => { set(s.value); persistSettings(); });
    refreshers.push(show); show();
  }
  function check(parent, label, get, set) {
    const row = el('div', { class: 'lls-row' }, parent);
    el('label', { text: label }, row);
    const c = el('input', { type: 'checkbox' }, row);
    const show = () => { c.checked = !!get(); };
    c.addEventListener('change', () => { set(c.checked); persistSettings(); });
    refreshers.push(show); show();
  }
  function section(title, open) {
    const d = el('details', null, panel);
    if (open) d.open = true;
    el('summary', { text: title }, d);
    return el('div', { class: 'lls-body' }, d);
  }

  const TYPE_NAMES = { taxi: 'Taxi', landing: 'Landing', turnoff: 'Turnoff' };

  // Live per-aircraft edit: copy the current layout once, then edit the copy
  function editableLayout() {
    const inst = geofs.aircraft.instance;
    const id = String(inst.id);
    if (!settings.perAircraft[id]) {
      const cur = layoutFor(inst, Number(inst.boundingSphereRadius) || 20);
      settings.perAircraft[id] = { lamps: clone(cur.lamps), headlightIntensity: cur.headlightIntensity };
    } else {
      settings.perAircraft[id] = normalizeLayout(settings.perAircraft[id]);
    }
    return settings.perAircraft[id];
  }

  let aircraftBox = null;
  function renderAircraftSection() {
    if (!aircraftBox) return;
    aircraftBox.innerHTML = '';
    let inst;
    try { inst = geofs.aircraft.instance; } catch (e) { return; }
    if (!inst) return;
    const id = String(inst.id);
    const lay = layoutFor(inst, Number(inst.boundingSphereRadius) || 20);
    let name = lay.name;
    try { if (!name && geofs.aircraftList && geofs.aircraftList[id]) name = geofs.aircraftList[id].name; } catch (e) {}
    el('div', { class: 'lls-note', text: `Aircraft ${id}${name ? ' · ' + name : ''} · source: ${lay.source}` }, aircraftBox);

    const hiRow = el('div', { class: 'lls-row' }, aircraftBox);
    el('label', { text: 'Aircraft brightness' }, hiRow);
    const hi = el('input', { type: 'number', step: '0.1', min: '0', value: lay.headlightIntensity }, hiRow);
    hi.addEventListener('change', () => { editableLayout().headlightIntensity = parseFloat(hi.value) || 0; renderAircraftSection(); });

    lay.lamps.forEach((lp, idx) => {
      const box = el('div', { class: 'lls-lamp' }, aircraftBox);
      const top = el('div', { class: 'lls-row' }, box);
      const typeSel = el('select', null, top);
      for (const t of Object.keys(TYPE_NAMES)) el('option', { value: t, text: TYPE_NAMES[t] }, typeSel);
      typeSel.value = lp.type || 'landing';
      typeSel.addEventListener('change', () => { editableLayout().lamps[idx].type = typeSel.value; renderAircraftSection(); });
      const mirLab = el('label', { text: 'left + right' }, top);
      mirLab.style.flex = '1';
      const mir = el('input', { type: 'checkbox' }, top);
      mir.checked = !!lp.mirror;
      mir.addEventListener('change', () => { editableLayout().lamps[idx].mirror = mir.checked; renderAircraftSection(); });
      const del = el('button', { text: '✕' }, top);
      del.title = 'Remove lamp';
      del.addEventListener('click', () => { editableLayout().lamps.splice(idx, 1); renderAircraftSection(); });

      const grid = el('div', { class: 'lls-grid' }, box);
      const T = settings.types[lp.type] || settings.types.landing;
      const fields = [['x', 'x (right)', 0.1], ['y', 'y (fwd)', 0.1], ['z', 'z (up)', 0.1], ['strength', 'strength', 0.1],
        ['tilt', 'tilt ↓↑', 0.5], ['yaw', 'yaw ←→', 1], ['coneOuter', 'cone °', 1], ['range', 'range m', 10]];
      for (const [key, label, step] of fields) {
        const cell = el('div', null, grid);
        el('span', { text: label }, cell);
        const fallback = key === 'tilt' ? T.tilt : key === 'coneOuter' ? T.coneOuter : key === 'range' ? T.range : key === 'strength' ? 1 : 0;
        const inp = el('input', { type: 'number', step, value: lp[key] != null ? lp[key] : fallback }, cell);
        inp.addEventListener('change', () => {
          const L = editableLayout().lamps[idx];
          L[key] = parseFloat(inp.value);
          if (key === 'coneOuter') L.coneInner = Math.max(1, Math.min(L.coneInner != null ? L.coneInner : T.coneInner, L.coneOuter - 1));
          renderAircraftSection();
        });
      }
    });

    const btns = el('div', { class: 'lls-btns' }, aircraftBox);
    const add = el('button', { text: '+ Lamp' }, btns);
    add.addEventListener('click', () => {
      const L = editableLayout();
      const R = Number(inst.boundingSphereRadius) || 20;
      L.lamps.push(lamp('landing', Math.max(0.8, R * 0.085), R * 0.1, -1, { mirror: true }));
      renderAircraftSection();
    });
    const save = el('button', { text: 'Save' }, btns);
    save.addEventListener('click', () => { api.saveAircraft(); renderAircraftSection(); });
    const reset = el('button', { text: 'Default' }, btns);
    reset.title = 'Discard your own changes for this aircraft';
    reset.addEventListener('click', () => { api.clearAircraft(); renderAircraftSection(); });
    const mk = el('button', { text: markers ? 'Hide markers' : 'Show markers' }, btns);
    mk.title = 'Magenta = lamp, cyan = 40 m along the beam';
    mk.addEventListener('click', () => { api.showMarkers(!markers); renderAircraftSection(); });
    if (lay.lamps.length) {
      let total = 0;
      for (const lp of lay.lamps) total += lp.mirror ? 2 : 1;
      if (total > spotLimit()) el('div', { class: 'lls-note', text: `Note: ${total} lamps, only ${spotLimit()} are drawn (see Headlights → Max. headlights).` }, aircraftBox);
    }
    if (settings.perAircraft[id]) el('div', { class: 'lls-note', text: 'Changed, not saved yet.' }, aircraftBox);
  }

  function buildPanel() {
    if (!document.getElementById('lls-style')) {
      const st = el('style', { id: 'lls-style' }, document.head);
      st.textContent = CSS;
    }
    panel = el('div', { id: 'lls-panel' }, document.body);
    // Keep keys / wheel / mouse inside the panel away from GeoFS
    for (const ev of ['keydown', 'keyup', 'keypress', 'wheel', 'mousedown', 'pointerdown', 'dblclick']) {
      panel.addEventListener(ev, (e) => { if (!(ev.startsWith('key') && isOurCombo(e))) e.stopPropagation(); });
    }
    const head = el('div', { class: 'lls-head' }, panel);
    el('b', { text: 'Lights Lite ' + VERSION }, head);
    const x = el('span', { class: 'lls-x', text: '×' }, head);
    x.addEventListener('click', () => api.toggleUI(false));
    let drag = null;
    head.addEventListener('mousedown', (e) => {
      if (e.target === x) return;
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag || !panel) return;
      panel.style.left = Math.max(0, e.clientX - drag.dx) + 'px';
      panel.style.top = Math.max(0, e.clientY - drag.dy) + 'px';
      panel.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => { drag = null; });

    const sw = section('Switches & binds', true);
    const bindBox = el('div', null, sw);
    renderBinds = () => {
      if (!panel) return;
      bindBox.innerHTML = '';
      for (const name of Object.keys(ACTIONS)) {
        const row = el('div', { class: 'lls-row' }, bindBox);
        const lab = el('label', { text: ACTIONS[name] }, row);
        lab.style.flex = '0 0 104px';
        if (name !== 'headlights') {
          const c = el('input', { type: 'checkbox' }, row);
          c.checked = settings.switches[name] !== false;
          c.title = 'On / off';
          c.addEventListener('change', () => { settings.switches[name] = c.checked; toast(ACTIONS[name] + (c.checked ? ' on' : ' off')); persistSettings(); });
        } else {
          el('span', { text: '' }, row).style.width = '13px';
        }
        const b = el('button', { text: listening === name ? 'Press a key or button…' : bindLabel(settings.binds[name]) }, row);
        b.style.flex = '1';
        b.title = 'Click, then press a key or joystick button (Esc = cancel)';
        b.addEventListener('click', () => { listening = listening === name ? null : name; renderBinds(); });
        if (settings.binds[name]) {
          const x = el('button', { text: '✕' }, row);
          x.title = 'Remove bind';
          x.addEventListener('click', () => { delete settings.binds[name]; persistSettings(); renderBinds(); });
        }
      }
      el('div', { class: 'lls-note', text: 'Turning nav / beacon / strobe off also hides GeoFS\' own light sprites. Joystick buttons work once you have pressed any button in GeoFS.' }, bindBox);
    };
    refreshers.push(renderBinds);
    renderBinds();
    check(sw, 'On-screen messages', () => settings.toasts, (v) => (settings.toasts = v));

    const g = section('General', false);
    check(g, 'Effect on (Alt+L)', () => settings.enabled && !!stage, (v) => (v ? api.enable() : api.disable()));
    slider(g, 'Overall brightness', () => settings.intensity, (v) => (settings.intensity = v), 0, 3, 0.05);
    slider(g, 'Visible in daylight', () => settings.dayFactor, (v) => (settings.dayFactor = v), 0, 1, 0.05);

    const h = section('Headlights', true);
    choose(h, 'Headlights', () => settings.headlightMode, (v) => (settings.headlightMode = v),
      [['auto', 'Night only'], ['on', 'Day and night'], ['off', 'Off']]);
    slider(h, 'Brightness', () => settings.headlightIntensity, (v) => (settings.headlightIntensity = v), 0, 4, 0.05);
    slider(h, 'Glare', () => settings.headlightGlare, (v) => (settings.headlightGlare = v), 0, 2, 0.05);
    slider(h, 'Max. headlights', () => spotLimit(), (v) => {
      if (spotLimit() === Math.round(v)) return;
      settings.maxSpots = Math.round(v);
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => { if (stage) { removeStage(); addStage(); } renderAircraftSection(); }, 400);
    }, 1, MAX_SPOTS, 1);
    for (const t of Object.keys(TYPE_NAMES)) {
      const T = settings.types[t];
      el('div', { class: 'lls-note', text: TYPE_NAMES[t] + ' lights' }, h).style.marginTop = '10px';
      colorPick(h, 'Colour', () => T.color, (v) => (T.color = v));
      slider(h, 'Strength', () => T.intensity, (v) => (T.intensity = v), 0, 3, 0.05);
      slider(h, 'Cone (degrees)', () => T.coneOuter, (v) => { T.coneOuter = v; T.coneInner = Math.min(T.coneInner, v - 1); }, 4, 60, 1);
      slider(h, 'Edge sharpness', () => T.coneInner / T.coneOuter, (v) => (T.coneInner = Math.max(1, T.coneOuter * v)), 0.1, 0.95, 0.05);
      slider(h, 'Range (m)', () => T.range, (v) => (T.range = v), 50, 1500, 10);
      slider(h, 'Default tilt', () => T.tilt, (v) => (T.tilt = v), -20, 5, 0.5);
    }

    const a = section('Lamps of this aircraft', false);
    aircraftBox = el('div', null, a);
    renderAircraftSection();

    const p = section('Aircraft lights (nav / beacon / strobe)', false);
    slider(p, 'Brightness', () => settings.pointIntensity, (v) => (settings.pointIntensity = v), 0, 3, 0.05);
    slider(p, 'Lamp core', () => settings.core, (v) => (settings.core = v), 0, 6, 0.1);
    slider(p, 'Bloom', () => settings.halo, (v) => (settings.halo = v), 0, 2, 0.05);
    slider(p, 'Lamp size (m)', () => settings.lampSize, (v) => (settings.lampSize = v), 0.1, 1.5, 0.05);
    slider(p, 'Light on airframe (m)', () => settings.range, (v) => (settings.range = v), 0, 60, 1);
    slider(p, 'Strobes', () => settings.strobeBoost, (v) => (settings.strobeBoost = v), 0, 5, 0.1);
    slider(p, 'Beacon', () => settings.beaconBoost, (v) => (settings.beaconBoost = v), 0, 5, 0.1);
    slider(p, 'Nav lights', () => settings.navBoost, (v) => (settings.navBoost = v), 0, 3, 0.05);
    slider(p, 'Cockpit shielding (m)', () => settings.nearFade, (v) => (settings.nearFade = v), 0, 15, 0.5);

    const r = el('div', { class: 'lls-body' }, panel);
    const btns = el('div', { class: 'lls-btns' }, r);
    const rs = el('button', { text: 'Reset all settings' }, btns);
    rs.addEventListener('click', () => {
      const keepPer = settings.perAircraft;
      const fresh = clone(DEFAULTS);
      for (const k of Object.keys(fresh)) settings[k] = fresh[k];
      settings.perAircraft = keepPer;
      try { localStorage.removeItem(SETTINGS_KEY); } catch (e) {}
      if (!stage) addStage();
      refreshers.forEach((f) => f());
    });
    el('div', { class: 'lls-note', text: 'Alt+H opens/closes this panel · Alt+L turns the effect on/off. Settings are saved automatically; lamp positions per aircraft with "Save".' }, r);

    panelTimer = setInterval(() => {
      let id = null;
      try { id = String(geofs.aircraft.instance.id); } catch (e) {}
      if (id !== lastPanelAircraft) { lastPanelAircraft = id; renderAircraftSection(); }
    }, 1000);
  }

  // ------------------------------------------------------------------
  // API
  // ------------------------------------------------------------------
  const api = {
    settings,
    version: VERSION,
    enable() { settings.enabled = true; readds = 0; if (!stage) addStage(); console.log(LOG, 'on'); refreshers.forEach((f) => f()); },
    disable() { settings.enabled = false; removeStage(); console.log(LOG, 'off'); refreshers.forEach((f) => f()); },
    toggle() { (settings.enabled && stage) ? api.disable() : api.enable(); },
    toggleUI(force) {
      const open = force != null ? force : !panel;
      if (open && !panel) { if (document.body) buildPanel(); }
      else if (!open && panel) {
        panel.remove(); panel = null; aircraftBox = null; refreshers.length = 0; listening = null; renderBinds = () => {};
        clearInterval(panelTimer);
      }
    },
    showMarkers(on = true) {
      const scene = getScene();
      if (!scene) return;
      if (on && !markers) {
        markers = scene.primitives.add(new Cesium.PointPrimitiveCollection());
        for (let i = 0; i < MAX_SPOTS; i++) {
          markers.add({ pixelSize: 9, color: Cesium.Color.MAGENTA, show: false, disableDepthTestDistance: Number.POSITIVE_INFINITY });
          markers.add({ pixelSize: 7, color: Cesium.Color.CYAN, show: false, disableDepthTestDistance: Number.POSITIVE_INFINITY });
        }
      } else if (!on && markers) {
        try { scene.primitives.remove(markers); } catch (e) {}
        markers = null;
      }
    },
    currentLayout() {
      const inst = geofs.aircraft.instance;
      return Object.assign({ id: String(inst.id) }, layoutFor(inst, Number(inst.boundingSphereRadius) || 20));
    },
    saveAircraft(layout) {
      const id = String(geofs.aircraft.instance.id);
      const l = normalizeLayout(layout || settings.perAircraft[id]);
      if (!l) { console.warn(LOG, 'nothing to save for aircraft', id); return; }
      savedLayouts[id] = clone({ lamps: l.lamps, headlightIntensity: l.headlightIntensity });
      saveJSON(AIRCRAFT_KEY, savedLayouts);
      delete settings.perAircraft[id];
      console.log(LOG, 'saved headlight layout for aircraft', id);
      return savedLayouts[id];
    },
    clearAircraft(id) {
      id = String(id != null ? id : geofs.aircraft.instance.id);
      delete savedLayouts[id]; delete settings.perAircraft[id];
      saveJSON(AIRCRAFT_KEY, savedLayouts);
    },
    exportAircraft() {
      const out = {};
      for (const id of Object.keys(AIRCRAFT_LAYOUTS)) out[id] = { lamps: AIRCRAFT_LAYOUTS[id].lamps, headlightIntensity: AIRCRAFT_LAYOUTS[id].headlightIntensity };
      return JSON.stringify(Object.assign(out, savedLayouts), null, 2);
    },
    rescan() { lastLightsRef = null; lastScan = 0; warnedNoLights = false; },
    debug() {
      let lay = null;
      try { lay = api.currentLayout(); } catch (e) {}
      let last = null;
      try { const pps = getScene().postProcessStages; last = pps.get(pps.length - 1) === stage; } catch (e) {}
      return {
        version: VERSION, enabled: settings.enabled, stageAttached: !!stage, stageIsLast: last, reattached: readds,
        pointLights: lightList.length, activePoints: count, realHeadlights: spotList.length,
        headlightMode: settings.headlightMode, activeSpots: spotCount, switches: Object.assign({}, settings.switches),
        frameSource: stale.on ? 'llaLocation+htr (model matrix stale)' : 'model matrix',
        aircraftId: lay && lay.id, layoutSource: lay && lay.source, lamps: lay && lay.lamps.length,
        frame: (() => { try { const f = getAircraftFrame(); return f && { fromModelMatrix: f.hasMatrix, radius: f.radius, axisFix: f.axisFix }; } catch (e) { return String(e); } })(),
        lightsOn: (() => { try { return lightsShouldBeOn(); } catch (e) { return String(e); } })(),
        cesium: window.Cesium && Cesium.VERSION, modernGLSL: cesiumIsModern(),
      };
    },
    toggleSwitch,
    destroy() {
      removeStage();
      clearInterval(watchdog);
      clearInterval(padTimer);
      restoreHidden();
      try { if (preRenderRemover) preRenderRemover(); } catch (e) {}
      api.toggleUI(false);
      try { api.showMarkers(false); } catch (e) {}
      if (renderErrorRemover) { try { renderErrorRemover(); } catch (e) {} }
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUpOrPress, true);
      window.removeEventListener('keypress', onKeyUpOrPress, true);
    },
  };
  window.geofsLightsLite = api;

  // ------------------------------------------------------------------
  // Boot: wait for GeoFS, then give it time to finish setting up its own rendering
  // ------------------------------------------------------------------
  function ready() {
    return window.Cesium && Cesium.PostProcessStage && window.geofs && geofs.api &&
      geofs.api.viewer && geofs.api.viewer.scene && geofs.aircraft && geofs.aircraft.instance;
  }

  let tries = 0;
  const boot = setInterval(() => {
    if (!ready()) {
      if (++tries > 480) { clearInterval(boot); console.warn(LOG, 'GeoFS not found, giving up.'); }
      return;
    }
    clearInterval(boot);
    try {
      initArrays();
      const scene = getScene();
      renderErrorRemover = scene.renderError.addEventListener(onRenderError);
      preRenderRemover = scene.preRender.addEventListener(enforceSwitches);
      // Wait ~90 rendered frames so GeoFS has added its own post-processing first
      let frames = 0, started = false;
      const remove = scene.postRender.addEventListener(() => {
        if (started || ++frames < 90) return;
        started = true;
        try { remove(); } catch (e) {}
        if (settings.enabled) addStage();
        startWatchdog();
        console.log(LOG, VERSION, 'loaded. Alt+H settings panel, Alt+L on/off. Cesium', Cesium.VERSION);
      });
    } catch (e) {
      console.error(LOG, 'failed to start:', e);
    }
  }, 500);
})();
