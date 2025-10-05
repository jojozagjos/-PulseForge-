/* global PIXI */ 
import { AudioPlayer } from "./audio.js";

/** Timing windows (ms) */
const PERFECT_MS = 30;
const GREAT_MS   = 65;
const GOOD_MS    = 100;

/** Visual tuning */
const WHITE_FLASH_MS = 140;      // taps only
// Fade rates (alpha reduction per frame). Lower = slower fade.
const HIT_FADE_RATE  = 0.025; // was 0.05 - slows tap head fade ~2x
const HOLD_FADE_RATE = 0.018; // dedicated slower fade for hold body/head after completion
const MISS_FADE_RATE = 0.08;
const HOLD_BODY_FADE = 0.06;

/** Visual options */
const VIS = {
  laneColors: [0x19cdd0, 0x19cdd0, 0x19cdd0, 0x19cdd0], // teal, purple, lime, orange
  showHitWindows: false,
  ringOnHit: true
};

export class Game {
  constructor(runtime, settings) {
    this.runtime = runtime;
    this.settings = settings || {};

    // tail behavior
    this.holdTailClipsAtJudge = true;

    // Canvas
    this.canvas = document.getElementById("game-canvas");
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.canvas.id = "game-canvas";
      Object.assign(this.canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%" });
      document.body.appendChild(this.canvas);
    }

    // Size
    const w = typeof window !== "undefined" ? (window.innerWidth || 1280) : 1280;
    const h = typeof window !== "undefined" ? (window.innerHeight || 720) : 720;
    this.width  = Math.max(960, Math.min(Math.floor(w), 1920));
    this.height = Math.max(540, Math.min(Math.floor(h), 1080));

    // State
    this.app = null;
    this.state = {
      score: 0, combo: 0, total: 0, hits: 0, acc: 1, nextIdx: 0, timeMs: 0,
      judges: { Perfect: 0, Great: 0, Good: 0, Miss: 0 }
    };
    this.maxCombo = 0;

    // Tuning
    this.leadInMs = 3000;
    this.pixelsPerMs = 0.35;

    // Inputs / holds
    this.keyDown = new Set();
    this.held = [];
    this.activeHoldsByLane = new Map();

    // Quit state
    this._quitting = false;
    this._showResultsTimeout = null;

    // Layers / HUD refs
    this.laneBackboardLayer = null;
    this.noteLayer = null;
    this.laneNoteLayers = [];
    this.laneMasks = [];

    this.receptorLayer = null;
    this.judgeStatic = null;

    this.fxRingLayer = null;
    this.fxTextLayer = null;
    this._ringTex = null;

  // HUD (external counters if present)
    this.$combo = null;
    this.$acc = null;
    this.$score = null;

    // Canvas HUD
    this.hudLayer = null;
    this.countdownText = null;

    // Progress bar
    this.progressBg = null;
    this.progressFill = null;
    this._progressGeom = null;

    this.spriteByNote = new Map();

    // Caches
    this._texCache = {
      headNormal: null,
      headWhite: null,
      headGloss: null,
      bodyNormalByLen: new Map(),
      bodyWhiteByLen: new Map(),
      _headW: null,
      _headH: null
    };
    this._fxStyles = null;
    this._fxPool = [];
    this._lastHud = { combo: null, acc: null, score: null };

    this.vis = VIS;
    this.receptors = [];

    this.notesByLane = [];
    this.nextIdxByLane = [];

    this._resultsShown = false;
    this._resultsOverlay = null;
    this._resultsCloseResolver = null;

    // Leaderboard snapshots
    this._lbBefore = { pbScore: null, rank: null };
    this._lbAfter  = { pbScore: null, rank: null, total: null };
    this._lbProjected = { rank: null };

    this._ensureToastHolder();

    // VFX runtime (optional)
  this.vfx = this._initVfxRuntime(runtime);

    // Camera and flash overlay
    this.cameraLayer = null;     // container that holds gameplay and gets camera transforms
    this._flashOverlay = null;   // full-screen overlay for beat flash
    this._flashUntilMs = 0;
    this._flashMaxAlpha = 0;
    this._flashColor = 0xffffff;
    this._lastBeatIndex = -1;

    // For restoring global key handlers
    this._prevOnKeyDown = undefined;
    this._prevOnKeyUp = undefined;

    // Live settings listeners (attached in run, removed in quit/destroy)
    this._onMaxFpsChange = null;
    this._onRenderScaleChange = null;
    // Debug: keyframe verification (one-shot logging) toggled via global flag
    this._enableKeyframeVerify = !!(typeof window !== 'undefined' && window.PF_KEYFRAME_VERIFY);
    this._keyframeVerifyRan = false;

    // Audio clock stall mitigation (if AudioContext stops advancing, keep game time flowing)
    this._lastAudioCtxTimeSec = 0;
    this._audioStallFrames = 0;
    this._audioStallFallbackActive = false;
    this._audioStallFallbackBasePerfMs = 0;
    this._audioStallFallbackBaseAudioSec = 0;
    // Secondary stall watchdog + debug overlay placeholders
    this._stallWatch = { lastPerfMs: (typeof performance!=='undefined'?performance.now():0), lastGameMs: 0, frames: 0 };
    this._debugOverlay = null;
  }

  // ===== VFX Runtime support (subset for background/lanes/notes) =====
  _initVfxRuntime(runtime) {
    if (!runtime) return null;
    const diff = runtime.difficulty || this.settings?.difficulty || "normal";
    let set = null;
    if (runtime.byDifficulty && typeof runtime.byDifficulty === 'object') {
      set = runtime.byDifficulty[diff] || runtime.byDifficulty.normal || runtime.byDifficulty.easy || runtime.byDifficulty.hard;
    } else if (runtime.vfx && typeof runtime.vfx === 'object') {
      set = runtime.vfx; // legacy single set
    }
    if (!set) return null;
    const props = set.properties || {};
    const keyframes = set.keyframes || {};
    return { props, keyframes };
  }

  _vfxUnpack(easing) {
    if (!easing) return { curve: "linear", style: "inOut" };
    if (easing.includes(":")) { const [curve, style] = easing.split(":"); return { curve, style: style || "inOut" }; }
    const map = { easeIn: {curve:"cubic",style:"in"}, easeOut: {curve:"cubic",style:"out"}, easeInOut: {curve:"cubic",style:"inOut"} };
    return map[easing] || { curve: easing, style: "inOut" };
  }
  _vfxEaseFn(curve, style) {
    const E = {
      linear: () => (t)=>t,
      quad: { in:(t)=>t*t, out:(t)=>1-(1-t)*(1-t), inOut:(t)=>t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2 },
      cubic:{ in:(t)=>t*t*t, out:(t)=>1-Math.pow(1-t,3), inOut:(t)=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2 },
      quart:{ in:(t)=>t*t*t*t, out:(t)=>1-Math.pow(1-t,4), inOut:(t)=>t<.5?8*Math.pow(t,4):1-Math.pow(-2*t+2,4)/2 },
      quint:{ in:(t)=>Math.pow(t,5), out:(t)=>1-Math.pow(1-t,5), inOut:(t)=>t<.5?16*Math.pow(t,5):1-Math.pow(-2*t+2,5)/2 },
      sine: { in:(t)=>1-Math.cos((t*Math.PI)/2), out:(t)=>Math.sin((t*Math.PI)/2), inOut:(t)=>-(Math.cos(Math.PI*t)-1)/2 },
      expo: { in:(t)=>t===0?0:Math.pow(2,10*t-10), out:(t)=>t===1?1:1-Math.pow(2,-10*t), inOut:(t)=>t===0?0:t===1?1:t<.5?Math.pow(2,20*t-10)/2:(2-Math.pow(2,-20*t+10))/2 },
      circ: { in:(t)=>1-Math.sqrt(1-t*t), out:(t)=>Math.sqrt(1-Math.pow(t-1,2)), inOut:(t)=>t<.5?(1-Math.sqrt(1-Math.pow(2*t,2)))/2:(Math.sqrt(1-Math.pow(-2*t+2,2))+1)/2 },
      back: { in:(t)=>{const c1=1.70158,c3=c1+1;return c3*t*t*t-c1*t*t;}, out:(t)=>{const c1=1.70158,c3=c1+1;return 1+c3*Math.pow(t-1,3)+c1*Math.pow(t-1,2);}, inOut:(t)=>{const c1=1.70158,c2=c1*1.525;return t<.5?(Math.pow(2*t,2)*((c2+1)*2*t-c2))/2:(Math.pow(2*t-2,2)*((c2+1)*(2*t-2)+c2)+2)/2;} },
      elastic:{ in:(t)=>{const c4=(2*Math.PI)/3;return t===0?0:t===1?1:-Math.pow(2,10*t-10)*Math.sin((t*10-10.75)*c4);}, out:(t)=>{const c4=(2*Math.PI)/3;return t===0?0:t===1?1:Math.pow(2,-10*t)*Math.sin((t*10-0.75)*c4)+1;}, inOut:(t)=>{const c5=(2*Math.PI)/4.5;return t===0?0:t===1?1:t<.5?-(Math.pow(2,20*t-10)*Math.sin((20*t-11.125)*c5))/2:(Math.pow(2,-20*t+10)*Math.sin((20*t-11.125)*c5))/2+1;} },
      bounce:{ out:(t)=>{const n1=7.5625,d1=2.75; if(t<1/d1)return n1*t*t; else if(t<2/d1)return n1*(t-=1.5/d1)*t+.75; else if(t<2.5/d1)return n1*(t-=2.25/d1)*t+.9375; else return n1*(t-=2.625/d1)*t+.984375;}, in:(t)=>1-(E.bounce.out(1-t)), inOut:(t)=>t<.5?(1-E.bounce.out(1-2*t))/2:(1+E.bounce.out(2*t-1))/2 },
      bezier: ()=> (t)=>t
    };
    if (curve === "linear") return E.linear();
    if (curve === "instant") return ()=>0;
    if (curve === "bezier") return E.bezier();
    return (E[curve]?.[style || "inOut"]) || E.cubic.inOut;
  }
  _vfxInterpolateColor(a, b, t) {
    const hx = (s)=>{const m=/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(s)||""); if(!m) return [0,0,0]; return [parseInt(m[1],16),parseInt(m[2],16),parseInt(m[3],16)];};
    const [r1,g1,b1] = hx(a), [r2,g2,b2] = hx(b);
    const r = Math.round(r1 + (r2-r1)*t), g = Math.round(g1 + (g2-g1)*t), b3 = Math.round(b1 + (b2-b1)*t);
    const toHex = (n)=>n.toString(16).padStart(2,'0');
    return `#${toHex(r)}${toHex(g)}${toHex(b3)}`;
  }
  _vfxIsGradient(v) { return v && typeof v === 'object' && (v.type === 'linear' || v.type === 'radial') && Array.isArray(v.stops); }
  _vfxInterpolateGradient(a, b, t) {
    // Coerce any legacy unknown types to linear
    const at = (a.type === 'radial') ? 'radial' : 'linear';
    const bt = (b.type === 'radial') ? 'radial' : 'linear';
    const type = (at === bt) ? at : 'linear';
    const A = (a.stops||[]).slice().sort((x,y)=>x.pos-y.pos);
    const B = (b.stops||[]).slice().sort((x,y)=>x.pos-y.pos);
    const n = Math.max(A.length, B.length);
    if (n === 0) return { type, stops: [] };
    const get = (arr, i) => arr[Math.min(i, arr.length - 1)] || { pos: i/(Math.max(1, n-1)), color: '#000000' };
    const out = [];
    for (let i=0;i<n;i++) {
      const sa = get(A, i), sb = get(B, i);
      const pos = (typeof sa.pos === 'number' && typeof sb.pos === 'number') ? (sa.pos + (sb.pos - sa.pos) * t) : (i/(Math.max(1,n-1)));
      const col = this._vfxInterpolateColor(sa.color || '#000000', sb.color || '#000000', t);
      out.push({ pos: Math.max(0, Math.min(1, pos)), color: col });
    }
    const seen = new Set();
    const stops = out.sort((x,y)=>x.pos-y.pos).filter(s=>{ const k = `${s.pos.toFixed(3)}_${s.color}`; if (seen.has(k)) return false; seen.add(k); return true; });
    return { type, stops };
  }
  _vfxValueAt(property, timeMs) {
    if (!this.vfx) return null;
    // Per-frame memoization
    const cache = this._vfxFrameCache;
    const cacheKey = property + '|' + (timeMs|0);
    if (cache && cache.has(cacheKey)) return cache.get(cacheKey);
    const kfs = this.vfx.keyframes?.[property];
    if (!Array.isArray(kfs) || !kfs.length) {
      const parts = property.split('.');
      let v = this.vfx.props; for (const p of parts) { if (v==null) { v = null; break; } v = v[p]; }
      if (cache) cache.set(cacheKey, v);
      return v;
    }
    const arr = kfs.slice().sort((a,b)=>a.time-b.time);
    if (timeMs <= arr[0].time) {
      const first = arr[0];
      let startVal;
      if (first && Math.abs(first.time) < 1) startVal = first.value; else {
        const parts = property.split('.');
        let v = this.vfx.props; for (const p of parts) { if (v==null) { v = null; break; } v = v[p]; }
        startVal = v;
      }
      if (timeMs <= 0) { if (cache) cache.set(cacheKey, startVal); return startVal; }
      if (first.time <= 0) { if (cache) cache.set(cacheKey, first.value); return first.value; }
      const dur = Math.max(1, first.time);
      const t = Math.max(0, Math.min(1, timeMs / dur));
      const ez = this._vfxUnpack(first.easing || 'linear');
      const gradPair = this._vfxIsGradient(startVal) && this._vfxIsGradient(first.value);
      const fn = (gradPair && ez.curve === 'instant') ? this._vfxEaseFn('linear') : this._vfxEaseFn(ez.curve, ez.style);
      const f = fn(t);
      let out;
      if (typeof startVal === 'number' && typeof first.value === 'number') out = startVal + (first.value - startVal) * f;
      else if (typeof startVal === 'string' && /^#/.test(startVal) && typeof first.value === 'string') out = this._vfxInterpolateColor(startVal, first.value, f);
      else if (this._vfxIsGradient(startVal) && this._vfxIsGradient(first.value)) out = this._vfxInterpolateGradient(startVal, first.value, f);
      else if (typeof startVal === 'boolean') out = f < 0.5 ? startVal : first.value;
      else out = f < 0.5 ? startVal : first.value;
      if (cache) cache.set(cacheKey, out);
      return out;
    }
    if (timeMs >= arr[arr.length-1].time) { const v = arr[arr.length-1].value; if (cache) cache.set(cacheKey, v); return v; }
    let a = arr[0], b = arr[1];
    for (let i=0;i<arr.length-1;i++){ if (timeMs >= arr[i].time && timeMs <= arr[i+1].time) { a = arr[i]; b = arr[i+1]; break; } }
    const dur = Math.max(1, b.time - a.time);
    const t = Math.max(0, Math.min(1, (timeMs - a.time)/dur));
    const ez = this._vfxUnpack(a.easing || 'linear');
    const gradPair = this._vfxIsGradient(a.value) && this._vfxIsGradient(b.value);
    const fn = (gradPair && ez.curve === 'instant') ? this._vfxEaseFn('linear') : this._vfxEaseFn(ez.curve, ez.style);
    const f = fn(t);
    let out;
    if (typeof a.value === 'number' && typeof b.value === 'number') out = a.value + (b.value - a.value)*f;
    else if (typeof a.value === 'string' && /^#/.test(a.value) && typeof b.value === 'string') out = this._vfxInterpolateColor(a.value, b.value, f);
    else if (this._vfxIsGradient(a.value) && this._vfxIsGradient(b.value)) out = this._vfxInterpolateGradient(a.value, b.value, f);
    else if (typeof a.value === 'boolean') out = f < 0.5 ? a.value : b.value;
    else out = f < 0.5 ? a.value : b.value;
    if (cache) cache.set(cacheKey, out);
    return out;
  }

  async run() {
    try { document.body.style.background = '#0a0c10'; } catch {}
    // fresh canvas + state each run
    this.canvas.style.display = "block";

    // nuke stale overlay if any
    try { document.getElementById("pf-results-overlay")?.remove(); } catch {}
    this._resultsCloseResolver = null;

    const __pfQuitHandler = () => {
      this._quitting = true;
      try { if (this._showResultsTimeout) { clearTimeout(this._showResultsTimeout); this._showResultsTimeout = null; } } catch {}
      try { document.getElementById("pf-results-overlay")?.remove(); } catch {}
    };

    try { window.addEventListener("pf-quit-game", __pfQuitHandler, { once: true }); } catch {}

    // Reset transient state
    this._resetNoteRuntimeFlags();
    this.keyDown = new Set();
    this.held = new Array(4).fill(false);
    this.activeHoldsByLane?.clear?.();
    this.spriteByNote?.clear?.();
    this.notesByLane = [];
    this.nextIdxByLane = [];
    this.maxCombo = 0;
    this._resultsShown = false;

    // New PIXI app each run
    this.app = new PIXI.Application();
  const perf = (typeof this.settings.getPerformance === "function") ? this.settings.getPerformance() : { maxFps: this.settings.maxFps, renderScale: this.settings.renderScale };
  // Honor renderScale directly (0.5..2). Using values <1 reduces internal resolution for performance.
  const clampRes = Math.max(0.5, Math.min(2, perf?.renderScale || 1));
    await this.app.init({
      canvas: this.canvas,
      width: this.width,
      height: this.height,
      antialias: false,
      background: 0x0a0c10,
      resolution: clampRes,
      powerPreference: "high-performance"
    });
    // Max FPS: 0 = unlimited (let PIXI run uncapped)
    const maxFps = (perf?.maxFps ?? 120);
    this.app.ticker.maxFPS = maxFps > 0 ? maxFps : Infinity;
    this.app.ticker.minFPS = this.settings.minFps || 50;

    // React live to Settings events (editor UI)
    this._onMaxFpsChange = (e) => {
      try {
        const v = Math.max(0, Math.floor(Number(e?.detail?.maxFps) || 0));
        this.app.ticker.maxFPS = v > 0 ? v : Infinity;
      } catch {}
    };
    this._onRenderScaleChange = (e) => {
      try {
        const newRes = Math.max(0.5, Math.min(2, Number(e?.detail?.renderScale) || 1));
        if (this.app?.renderer) {
          // PIXI v8: updating resolution then resizing reapplies buffers
          this.app.renderer.resolution = newRes;
          this.app.renderer.resize(this.width, this.height);
        }
      } catch {}
    };
    try {
      window.addEventListener("pf-maxfps-changed", this._onMaxFpsChange);
      window.addEventListener("pf-render-scale-changed", this._onRenderScaleChange);
    } catch {}

  this._buildScene();

    await this._playSolo(this.runtime.manifest);

    return [
      { label: "Score", value: this.state.score.toString() },
      { label: "Accuracy", value: Math.round(this.state.acc * 100) + "%" },
      { label: "Max Combo", value: this.maxCombo || this.state.combo }
    ];
  }

  quit() {
    // Mark quitting and cancel any pending results timers/overlays
    this._quitting = true;
    try { if (this._showResultsTimeout) { clearTimeout(this._showResultsTimeout); this._showResultsTimeout = null; } } catch {}
    try { document.getElementById("pf-results-overlay")?.remove(); } catch {}
    try { this.app?.ticker?.stop(); } catch {}
    try { this.app?.destroy(true, { children: true, texture: true, baseTexture: true }); } catch {}
    this.app = null;

    // Clear note maps and holds
    try { this.spriteByNote?.clear?.(); } catch {}
    try { this.activeHoldsByLane?.clear?.(); } catch {}

    // Restore global input handlers
    if (this._prevOnKeyDown !== undefined) window.onkeydown = this._prevOnKeyDown;
    if (this._prevOnKeyUp   !== undefined) window.onkeyup   = this._prevOnKeyUp;
    this._prevOnKeyDown = undefined;
    this._prevOnKeyUp   = undefined;

    // Remove live settings listeners
    try {
      if (this._onMaxFpsChange) window.removeEventListener("pf-maxfps-changed", this._onMaxFpsChange);
      if (this._onRenderScaleChange) window.removeEventListener("pf-render-scale-changed", this._onRenderScaleChange);
    } catch {}

    // Do not remove the results overlay here; user closes it.
  }

  destroy() {
    try { this.app?.ticker?.stop(); } catch {}
    try { this.app?.destroy(true, { children: true, texture: true, baseTexture: true }); } catch {}
    this.app = null;

    this.noteLayer = null;
    this.fxRingLayer = null;
    this.fxTextLayer = null;
    try { this.spriteByNote?.clear?.(); } catch {}

    if (this._prevOnKeyDown !== undefined) window.onkeydown = this._prevOnKeyDown;
    if (this._prevOnKeyUp   !== undefined) window.onkeyup   = this._prevOnKeyUp;
    this._prevOnKeyDown = undefined;
    this._prevOnKeyUp   = undefined;

    // Remove live settings listeners
    try {
      if (this._onMaxFpsChange) window.removeEventListener("pf-maxfps-changed", this._onMaxFpsChange);
      if (this._onRenderScaleChange) window.removeEventListener("pf-render-scale-changed", this._onRenderScaleChange);
    } catch {}

    try { this.activeHoldsByLane?.clear?.(); } catch {}
  }

  _applyVolume(player) {
    const v = Math.max(0, Math.min(1, Number(this.settings?.volume ?? 1)));
    if (typeof player.setMasterVolume === "function") player.setMasterVolume(v);
  }

  _buildScene() {
    this.app.stage.sortableChildren = true;
  // Camera container that we can move/rotate/scale as a unit
  this.cameraLayer = new PIXI.Container();
    this.cameraLayer.sortableChildren = true;
    this.cameraLayer.zIndex = 1;
    this.app.stage.addChild(this.cameraLayer);
    // Subtle grid (behind everything)
    const grid = new PIXI.Graphics();
    grid.alpha = 0.22;
    for (let i = 0; i < 44; i++) { grid.moveTo(0, i * 18); grid.lineTo(this.width, i * 18); }
  this.cameraLayer.addChild(grid);
    if ("cacheAsBitmap" in grid) grid.cacheAsBitmap = true;
    grid.zIndex = 0;

    // Layout
    this.laneCount = 4;
    this.held = new Array(this.laneCount).fill(false);

    // Lane sizing
    this.laneWidth = Math.max(120, Math.min(180, Math.floor(this.width / 10)));
    this.laneGap = Math.max(18, Math.min(32, Math.floor(this.width / 70)));
    const totalW = this.laneCount * this.laneWidth + (this.laneCount - 1) * this.laneGap;
    this.startX = (this.width - totalW) / 2;

    // Column rect
    this._laneTop = 40;
    this._laneBottomMargin = 56;
    this._laneHeight = this.height - this._laneTop - this._laneBottomMargin;

    // Judge line position
    this.judgeY = this.height - 180;

    // Lane backboards
    this.laneBackboardLayer = new PIXI.Container();
    this.laneBackboardLayer.zIndex = 1;
  this.cameraLayer.addChild(this.laneBackboardLayer);
  // Keep refs for dynamic redraw
  this.laneBackboards = [];

    for (let i = 0; i < this.laneCount; i++) {
      const g = new PIXI.Graphics();
      g.roundRect(this._laneX(i), this._laneTop, this.laneWidth, this._laneHeight, 18);
      g.fill({ color: 0x0f1420 });
      g.stroke({ width: 2, color: 0x2a3142 });
      g.alpha = 0.95;
      this.laneBackboardLayer.addChild(g);
      this.laneBackboards.push(g);
      if ("cacheAsBitmap" in g) g.cacheAsBitmap = true;
    }

    // Ensure background gradient layer exists under everything
    this._ensureGradientLayer();
    // Judge line + halo (treat as hit window visual; hide when showHitWindows is false)
    if (VIS.showHitWindows) {
      this.judgeStatic = new PIXI.Container();
      this.judgeStatic.zIndex = 3;
      this.cameraLayer.addChild(this.judgeStatic);
      {
        const core = new PIXI.Graphics();
        core.moveTo(this.startX - 12, this.judgeY);
        core.lineTo(this.startX + totalW + 12, this.judgeY);
        core.stroke({ width: 3, color: 0xffffff, alpha: 0.9 });
        this.judgeStatic.addChild(core);

        const halo = new PIXI.Graphics();
        halo.moveTo(this.startX - 14, this.judgeY);
        halo.lineTo(this.startX + totalW + 14, this.judgeY);
        halo.stroke({ width: 10, color: 0x25f4ee, alpha: 0.15 });
        this.judgeStatic.addChild(halo);
      }
      if ("cacheAsBitmap" in this.judgeStatic) this.judgeStatic.cacheAsBitmap = true;
    }

    // Optional hit window guides (Perfect/Great/Good), follows camera
    if (VIS.showHitWindows) {
      const hw = new PIXI.Container();
      hw.zIndex = 3;
      const drawGuide = (ms, color, alpha) => {
        const g = new PIXI.Graphics();
        const dy = ms * this.pixelsPerMs;
        g.moveTo(this.startX - 10, this.judgeY - dy);
        g.lineTo(this.startX + totalW + 10, this.judgeY - dy);
        g.stroke({ width: 2, color, alpha });
        g.moveTo(this.startX - 10, this.judgeY + dy);
        g.lineTo(this.startX + totalW + 10, this.judgeY + dy);
        g.stroke({ width: 2, color, alpha });
        hw.addChild(g);
      };
      drawGuide(PERFECT_MS, 0x25f4ee, 0.35);
      drawGuide(GREAT_MS,   0xC8FF4D, 0.28);
      drawGuide(GOOD_MS,    0x8A5CFF, 0.22);
      this.cameraLayer.addChild(hw);
      this.hitWindowsLayer = hw;
    }

    // Note containers with per-lane masks
    this.noteLayer = new PIXI.Container();
    this.noteLayer.zIndex = 4;
  this.cameraLayer.addChild(this.noteLayer);

    this.laneNoteLayers = [];
    this.laneMasks = [];
    for (let i = 0; i < this.laneCount; i++) {
      const laneCont = new PIXI.Container();
      laneCont.zIndex = 4;

      const mx = this._laneX(i);
      const my = this._laneTop;
      const mw = this.laneWidth;
      const mh = this._laneHeight;

      const mask = new PIXI.Graphics();
      mask.rect(mx, my, mw, mh);
      mask.fill(0xffffff);
      mask.isMask = true;
      mask.zIndex = this.noteLayer?.zIndex ?? 4;

      laneCont.mask = mask;

      this.noteLayer.addChild(laneCont);
  this.cameraLayer.addChild(mask);

      this.laneNoteLayers[i] = laneCont;
      this.laneMasks[i] = mask;
    }

    // Receptors
    this.receptorLayer = new PIXI.Container();
    this.receptorLayer.zIndex = 6;
  this.cameraLayer.addChild(this.receptorLayer);

    this.receptors = [];
    for (let i = 0; i < this.laneCount; i++) {
      const laneCenterX = this._laneX(i) + this.laneWidth / 2;
      const rec = new PIXI.Container();
      rec.x = laneCenterX;
      rec.y = this.judgeY;
      rec.alpha = 0.95;
      rec.__lane = i;

      const chev = new PIXI.Graphics();
      const c = this.vis.laneColors[i % this.vis.laneColors.length];
      chev.moveTo(-14, -16); chev.lineTo(0, -4); chev.lineTo(14, -16);
      chev.stroke({ width: 3, color: c, alpha: 0.95 });
      rec.addChild(chev);

      const bar = new PIXI.Graphics();
      bar.roundRect(-this.laneWidth * 0.35, -2, this.laneWidth * 0.7, 4, 2);
      bar.fill({ color: c, alpha: 0.25 });
      rec.addChild(bar);

      const glow = new PIXI.Graphics();
      glow.roundRect(-this.laneWidth * 0.38, -6, this.laneWidth * 0.76, 12, 4);
      glow.fill({ color: c, alpha: 0.0 });
      rec.addChild(glow);

      rec.__chev = chev;
      rec.__bar = bar;
      rec.__glow = glow;
      rec.__pulse = 0;
      rec.__color = c;
      this.receptorLayer.addChild(rec);
      this.receptors.push(rec);
    }

    // FX
  this.fxRingLayer = this._makeFxRingLayer();
  this.fxRingLayer.zIndex = 7;
  this.cameraLayer.addChild(this.fxRingLayer);

  this.fxTextLayer = new PIXI.Container();
  this.fxTextLayer.zIndex = 7;
  this.cameraLayer.addChild(this.fxTextLayer);

    // HUD (external counters if present)
    this.$combo = document.getElementById("hud-combo");
    this.$acc = document.getElementById("hud-acc");
    this.$score = document.getElementById("hud-score");

  // Progress bar
  this._buildProgressBar(totalW);

  // Full-screen flash overlay (UI space; not affected by camera)
  this._flashOverlay = new PIXI.Graphics();
  this._flashOverlay.rect(0, 0, this.width, this.height);
  this._flashOverlay.fill({ color: 0xffffff, alpha: 0 });
  this._flashOverlay.zIndex = 20; // above gameplay, below HUD
  this.app.stage.addChild(this._flashOverlay);

    // Text styles
    this._fxStyles = {
      Perfect: new PIXI.TextStyle({
        fill: 0x25F4EE, fontSize: 36, fontFamily: "Arial", fontWeight: "bold",
        stroke: { color: 0x000000, width: 4, join: 'round' },
        dropShadow: true, dropShadowColor: "#000000", dropShadowBlur: 3, dropShadowDistance: 2
      }),
      Great: new PIXI.TextStyle({
        fill: 0xC8FF4D, fontSize: 36, fontFamily: "Arial", fontWeight: "bold",
        stroke: { color: 0x000000, width: 4, join: 'round' },
        dropShadow: true, dropShadowColor: "#000000", dropShadowBlur: 3, dropShadowDistance: 2
      }),
      Good: new PIXI.TextStyle({
        fill: 0x8A5CFF, fontSize: 36, fontFamily: "Arial", fontWeight: "bold",
        stroke: { color: 0x000000, width: 4, join: 'round' },
        dropShadow: true, dropShadowColor: "#000000", dropShadowBlur: 3, dropShadowDistance: 2
      }),
      Miss: new PIXI.TextStyle({
        fill: 0xaa4b5b, fontSize: 36, fontFamily: "Arial", fontWeight: "bold",
        stroke: { color: 0x000000, width: 4, join: 'round' },
        dropShadow: true, dropShadowColor: "#000000", dropShadowBlur: 3, dropShadowDistance: 2
      }),
      Countdown: new PIXI.TextStyle({
        fill: 0x25F4EE, fontSize: 48, fontFamily: "Arial", fontWeight: "bold",
        stroke: { color: 0x000000, width: 5, join: 'round' },
        dropShadow: true, dropShadowColor: "#000000", dropShadowBlur: 3, dropShadowDistance: 2
      })
    };

    // Canvas HUD (countdown)
    this.hudLayer = new PIXI.Container();
    this.hudLayer.zIndex = 8;
    this.app.stage.addChild(this.hudLayer);

    this.countdownText = new PIXI.Text({ text: "", style: this._fxStyles.Countdown });
    this.countdownText.anchor.set(0.5, 0.5);
    this.countdownText.position.set(this.width / 2, Math.floor(this.height * 0.18));
    this.countdownText.alpha = 0;
    this.hudLayer.addChild(this.countdownText);

  // Debug overlay (opt-in) shows timing/stall info if window.PF_DEBUG
  if (typeof window !== 'undefined' && window.PF_DEBUG && !this._debugOverlay) {
    const dbg = new PIXI.Text({ text: 'debug', style: new PIXI.TextStyle({ fill: 0x25F4EE, fontSize: 14, fontFamily: 'Arial' }) });
    dbg.x = 8; dbg.y = 6; dbg.alpha = 0.85; dbg.zIndex = 99;
    this.hudLayer.addChild(dbg);
    this._debugOverlay = dbg;
  }

  // Loading text (centered)
  this.loadingText = new PIXI.Text({ text: "", style: this._fxStyles.Countdown });
  this.loadingText.anchor.set(0.5, 0.5);
  this.loadingText.position.set(this.width / 2, Math.floor(this.height * 0.5));
  this.loadingText.alpha = 0;
  this.hudLayer.addChild(this.loadingText);

    // Ensure all layers sort their children predictably by zIndex
    ;[this.laneBackboardLayer, this.judgeStatic, this.noteLayer, this.receptorLayer, this.fxRingLayer, this.fxTextLayer, this.hudLayer]
      .forEach(c => { try { if (c) c.sortableChildren = true; } catch {} });
  }

  _ensureGradientLayer() {
    if (this._bgSprite && this._bgSprite.parent) return;
    const tex = PIXI.Texture.WHITE;
    this._bgSprite = new PIXI.Sprite(tex);
    this._bgSprite.zIndex = -10;
    this._bgSprite.width = this.width;
    this._bgSprite.height = this.height;
    this._bgSprite.anchor.set(0,0);
    this.app.stage.addChildAt(this._bgSprite, 0);
    // Lazy secondary sprite created only for cross-fade when needed
  }

  _serializeGradient(g, angle) {
    if (!g) return null;
  let typeCode;
  if (g.type === 'radial') typeCode = 'r'; else typeCode = 'l';
    const ang = Math.round(Number(angle)||0);
    const arr = Array.isArray(g.stops) ? g.stops : [];
    // If not already marked sorted, make a sorted shallow copy once, then tag
    let stops;
    if (g.__pfSorted) {
      stops = arr; // already sorted
    } else {
      stops = arr.slice().sort((a,b)=>a.pos-b.pos);
      Object.defineProperty(g, '__pfSorted', { value: true, enumerable: false, configurable: true });
      g.stops = stops; // normalized order
    }
    // Build compact key manually (avoid JSON stringify overhead)
  let key = typeCode + ':' + ang;
    for (let i=0;i<stops.length;i++) {
      const s = stops[i];
      const p = Math.max(0, Math.min(1, Number(s.pos)||0));
      let c = String(s.color||'#ffffff');
      if (c.length === 4 && c.startsWith('#')) { // expand short #abc
        c = '#' + c[1]+c[1]+c[2]+c[2]+c[3]+c[3];
      }
      key += '|' + p.toFixed(3) + ',' + c.toLowerCase();
    }
    return key;
  }

  _makeGradientTexture(key, g, angle) {
    // Dynamic internal resolution scaling for performance.
    if (!this._gradQuality) {
      // 1 = full res, 0.5 = half, etc. Exposed knob via settings?.gradientQuality or adaptive throttle hints.
      const userQ = Number(this.settings?.gradientQuality);
      this._gradQuality = (Number.isFinite(userQ) && userQ > 0.1 && userQ <= 1) ? userQ : 1;
      this._gradAdaptiveEnabled = true; // allow automatic downscale
      this._gradAdaptiveCooldownMs = 0;
    }
    // If adaptive says to reduce temporarily (based on throttle stats) do so.
    if (this._gradAdaptiveEnabled) {
      const stats = this._gradThrottleStats;
      const now = performance.now?.() || Date.now();
      if (!this._gradAdaptiveCooldownMs) this._gradAdaptiveCooldownMs = now + 3000;
      if (stats && stats.avgGenMs > 1.2 && now > this._gradAdaptiveCooldownMs) {
        // Downscale one step (min 0.25) and set cooldown
        this._gradQuality = Math.max(0.25, this._gradQuality * 0.75);
        this._gradAdaptiveCooldownMs = now + 4000; // wait before next adjustment
      } else if (stats && stats.avgGenMs < 0.4 && this._gradQuality < 1 && now > this._gradAdaptiveCooldownMs) {
        // Upscale gradually (avoid oscillation)
        this._gradQuality = Math.min(1, this._gradQuality * 1.12);
        this._gradAdaptiveCooldownMs = now + 5000;
      }
    }
    const scale = this._gradQuality;
    const w = Math.max(2, Math.round(this.width * scale));
    const h = Math.max(2, Math.round(this.height * scale));
    const cvs = document.createElement('canvas');
    cvs.width = w; cvs.height = h;
    const ctx = cvs.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0,0,w,h);
  // Coerce legacy/unsupported types to linear or radial
  if (g && g.type !== 'linear' && g.type !== 'radial') g.type = 'linear';
  if (g?.type === 'radial') {
      const r = Math.hypot(w,h) * 0.6;
      const grd = ctx.createRadialGradient(w/2,h/2,0,w/2,h/2,r);
      const stops = g.__pfSorted ? (g.stops||[]) : (g.stops||[]).slice().sort((a,b)=>a.pos-b.pos);
      for (const s of stops) grd.addColorStop(Math.max(0,Math.min(1,Number(s.pos)||0)), s.color||'#ffffff');
      ctx.fillStyle = grd;
    } else {
      const rad = ((Number(angle)||0) - 90) * Math.PI / 180;
      const cx = w/2, cy = h/2;
      const len = Math.max(w,h);
      const x = Math.cos(rad)*len, y = Math.sin(rad)*len;
      const grd = ctx.createLinearGradient(cx-x, cy-y, cx+x, cy+y);
      const stops = g.__pfSorted ? (g.stops||[]) : (g.stops||[]).slice().sort((a,b)=>a.pos-b.pos);
      for (const s of stops) grd.addColorStop(Math.max(0,Math.min(1,Number(s.pos)||0)), s.color||'#ffffff');
      ctx.fillStyle = grd;
    }
    ctx.fillRect(0,0,w,h);
    const tex = PIXI.Texture.from(cvs);
    // When applying to sprite, we will stretch to full game canvas; minor blur acceptable.
    tex.__pfKey = key;
    return tex;
  }

  _getGradientTextureCached(key, g, angle) {
    if (!this._gradTexCache) {
      this._gradTexCache = new Map(); // key -> { tex, at }
      this._gradTexMax = 12; // small LRU cap
    }
    const cache = this._gradTexCache;
    const now = performance.now?.() || Date.now();
    if (cache.has(key)) {
      const entry = cache.get(key); entry.at = now; return entry.tex;
    }
    const tex = this._makeGradientTexture(key, g, angle);
    cache.set(key, { tex, at: now });
    // LRU eviction
    if (cache.size > this._gradTexMax) {
      let oldestK = null, oldestT = Infinity;
      for (const [k,v] of cache.entries()) { if (v.at < oldestT) { oldestT = v.at; oldestK = k; } }
      if (oldestK && oldestK !== key) {
        try { cache.get(oldestK).tex.destroy(true); } catch {}
        cache.delete(oldestK);
      }
    }
    return tex;
  }

  _updateGradientSprite(timeMs) {
    // Adaptive throttle inserted: dynamically skip gradient regeneration if too soon since last run.
    if (!this._gradThrottle) {
      this._gradThrottle = { lastUpdateMs: -Infinity, minIntervalMs: 16, avgGenMs: 0, samples: 0 };
    }
    const __gt = this._gradThrottle;
    const __now = performance.now?.() || Date.now();
    if (__now - __gt.lastUpdateMs < __gt.minIntervalMs && this._bgGradKey) {
      return; // reuse existing gradient sprites / blend state
    }
    const __genStart = __now;
    // Hybrid gradient interpolation: build/cached procedural gradient snapshots quantized by eased factor.
    // 1. Resolve keyframes
    const kfs = this.vfx?.keyframes?.['background.gradient'];
    const baseGrad = this.vfx?.props?.background?.gradient;
    let renderGrad = null; // a fully interpolated gradient object
    let angle = Number(this._vfxValueAt('background.angle', timeMs) ?? this.vfx?.props?.background?.angle ?? 0);
    if (Array.isArray(kfs) && kfs.length > 0) {
      const arr = kfs.slice().sort((a,b)=>a.time-b.time);
      if (timeMs <= arr[0].time) {
        renderGrad = arr[0].value || baseGrad;
      } else if (timeMs >= arr[arr.length-1].time) {
        renderGrad = arr[arr.length-1].value || baseGrad;
      } else {
        // find segment
        let a = arr[0], b = arr[1];
        for (let i=0;i<arr.length-1;i++) {
          if (timeMs >= arr[i].time && timeMs <= arr[i+1].time) { a = arr[i]; b = arr[i+1]; break; }
        }
        if (a && b) {
          const span = Math.max(1, b.time - a.time);
          const localT = (timeMs - a.time) / span;
            const ez = this._vfxUnpack(a.easing || 'linear');
            let fn;
            if (ez.curve === 'instant') {
              // Step-like: show a until boundary, then b.
              renderGrad = localT < 1 ? a.value : b.value;
            } else {
              if (ez.curve === 'linear') fn = (x)=>x; else fn = this._vfxEaseFn(ez.curve, ez.style);
              const eased = Math.max(0, Math.min(1, fn(localT)));
              // Dynamic quantization: base steps plus refinement when motion is slow.
              // If last factor exists, measure delta to adapt resolution.
              if (!this._gradLastFactor) this._gradLastFactor = 0;
              const diff = Math.abs(eased - this._gradLastFactor);
              // Segment-adaptive base steps: longer spans deserve higher resolution.
              const segMs = span;
              let baseSteps = 60;
              if (segMs > 8000) baseSteps = 180; else if (segMs > 4000) baseSteps = 140; else if (segMs > 2000) baseSteps = 100;
              // Motion-adaptive refinement
              if (diff < 0.01) baseSteps *= 2; else if (diff > 0.08) baseSteps = Math.max(40, Math.round(baseSteps * 0.66));
              const steps = Math.min(300, baseSteps|0);
              const q = Math.round(eased * steps) / steps;
              this._gradLastFactor = eased;
              // Build/cache interpolated gradient for (segment,q,angle)
              const segKey = `gradseg:${a.time}-${b.time}:${ez.curve}:${ez.style||''}:${q.toFixed(3)}:${angle}`;
              if (!this._gradInterpCache) { this._gradInterpCache = new Map(); this._gradInterpLRU = []; this._gradInterpMax = 48; }
              if (this._gradInterpCache.has(segKey)) {
                renderGrad = this._gradInterpCache.get(segKey).grad;
              } else {
                // Interpolate value types; if either missing fallback to b
                const A = a.value || baseGrad; const B = b.value || baseGrad || A;
                if (this._vfxIsGradient(A) && this._vfxIsGradient(B)) {
                  renderGrad = this._vfxInterpolateGradient(A, B, q);
                } else {
                  // Color or other simple types: synthesize 2-stop gradient if colors
                  if (typeof A === 'string' && /^#/.test(A) && typeof B === 'string') {
                    const col = this._vfxInterpolateColor(A, B, q);
                    renderGrad = { type:'linear', stops:[{pos:0,color:col},{pos:1,color:col}] };
                  } else {
                    renderGrad = B; // fallback
                  }
                }
                // Insert into cache with LRU management
                this._gradInterpCache.set(segKey, { grad: renderGrad, at: performance.now?.()||Date.now() });
                this._gradInterpLRU.push(segKey);
                if (this._gradInterpLRU.length > this._gradInterpMax) {
                  const old = this._gradInterpLRU.shift();
                  if (old) this._gradInterpCache.delete(old);
                }
              }
            }
        }
      }
    } else {
      renderGrad = baseGrad;
    }
    // Legacy color1/color2 fallback only if still nothing
    if (!renderGrad) {
      const c1 = this.vfx?.props?.background?.color1;
      const c2 = this.vfx?.props?.background?.color2 || c1;
      if (typeof c1 === 'string' && c1.startsWith('#')) {
        renderGrad = { type:'linear', stops:[{pos:0,color:c1},{pos:1,color:c2||c1}] };
      }
    }
    if (!renderGrad) {
      if (this._bgSprite) this._bgSprite.visible = false;
      return;
    }
    if (!this._bgSprite) this._ensureGradientLayer();
    // Serialize & cache as texture
    const key = this._serializeGradient(renderGrad, angle);
  if (key) {
      // Ensure secondary sprite exists for interpolation
      if (!this._bgSpriteB) {
        this._bgSpriteB = new PIXI.Sprite(PIXI.Texture.WHITE);
        this._bgSpriteB.width = this.width; this._bgSpriteB.height = this.height;
        this._bgSpriteB.visible = false; this._bgSpriteB.alpha = 0; this._bgSpriteB.zIndex = -9;
        this.app.stage.addChildAt(this._bgSpriteB, 1);
      }
  if (this._bgGradKey !== key) {
        // Move current texture to B (previous) for cross-fade, unless first assignment
        if (this._bgSprite.texture && this._bgGradKey) {
          this._bgSpriteB.texture = this._bgSprite.texture;
          this._bgSpriteB.visible = true;
          this._bgSpriteB.alpha = 1; // previous fully visible start of blend
          this._gradBlendT = 0;      // reset blending progress
        }
        const tex = this._getGradientTextureCached(key, renderGrad, angle);
        this._bgGradKey = key;
        this._bgSprite.texture = tex;
        this._bgSprite.width = this.width; this._bgSprite.height = this.height;
        this._bgSprite.visible = true;
        this._bgSprite.alpha = 0; // fade in new
      }
      // Advance blend (time-based using audio clock so speed is stable across FPS)
      if (typeof this._gradBlendT !== 'number') this._gradBlendT = 1;
      if (this._bgSprite.alpha < 1) {
        const nowAudioMs = (this.state?.timeMs ?? 0);
        if (!this._gradBlendStartMs) this._gradBlendStartMs = nowAudioMs;
        const blendDurMs = 300; // total cross-fade duration
        const prog = Math.max(0, Math.min(1, (nowAudioMs - this._gradBlendStartMs) / blendDurMs));
        this._gradBlendT = prog;
        this._bgSprite.alpha = prog;
        if (this._bgSpriteB) this._bgSpriteB.alpha = 1 - prog;
        if (prog >= 1 && this._bgSpriteB) {
          this._bgSpriteB.visible = false;
          this._gradBlendStartMs = null;
        }
      }
    }
    // Secondary sprite no longer needed for cross-fade; hide if exists
    if (this._bgSpriteB) { try { this._bgSpriteB.visible = false; } catch {} }
    this._bgSprite.alpha = 1;
  }

  async _prewarmVFX() {
    try {
      // Collect unique gradient snapshots we may need soon (props + first few keyframes)
      const grads = new Map();
      const base = this.vfx?.props?.background?.gradient;
      if (this._vfxIsGradient(base)) grads.set(JSON.stringify(base), base);
      const kfs = this.vfx?.keyframes?.['background.gradient'] || [];
      for (let i=0;i<Math.min(6,kfs.length);i++) {
        const v = kfs[i]?.value; if (this._vfxIsGradient(v)) grads.set(JSON.stringify(v), v);
      }
      const angleBase = Number(this.vfx?.props?.background?.angle||0);
      const angles = new Set([angleBase]);
      const akfs = this.vfx?.keyframes?.['background.angle'] || [];
      for (let i=0;i<Math.min(4, akfs.length);i++) angles.add(Number(akfs[i].value||0));
      // Build textures (touch the cache) so first frame has them
      for (const g of grads.values()) {
        for (const ang of angles) {
          const key = this._serializeGradient(g, ang);
          if (!key) continue;
          this._getGradientTextureCached(key, g, ang);
        }
      }
      // Hybrid interpolation prewarm: generate a few quantized intermediate blends for first 2 segments
      const segs = kfs.slice().sort((a,b)=>a.time-b.time);
      for (let si=0; si<Math.min(2, segs.length-1); si++) {
        const A = segs[si], B = segs[si+1];
        if (!A || !B) continue;
        if (!this._vfxIsGradient(A.value) || !this._vfxIsGradient(B.value)) continue;
        const ez = this._vfxUnpack(A.easing || 'linear');
        const fn = (ez.curve === 'linear' || ez.curve === 'instant') ? (x)=>x : this._vfxEaseFn(ez.curve, ez.style);
        const samples = [0, 0.25, 0.5, 0.75, 1];
        for (const s of samples) {
          const eased = fn(s);
          const gInterp = this._vfxInterpolateGradient(A.value, B.value, eased);
          for (const ang of angles) {
            const key = this._serializeGradient(gInterp, ang);
            if (!key) continue;
            this._getGradientTextureCached(key, gInterp, ang);
          } // end holdTailClipsAtJudge block
        }
      }
      // Small delay to allow GPU upload
      await new Promise(r=>setTimeout(r, 16));

      // ===== Note / receptor pre-allocation & texture warmup =====
      if (this.chart && Array.isArray(this.chart.notes)) {
        // Determine a rough peak simultaneous visible notes window (e.g., notes within next 2 seconds)
        const lookAheadMs = 2000;
        const now0 = 0;
        let visibleEstimate = 0;
        const notesSorted = this.chart.notes.slice().sort((a,b)=>a.tMs-b.tMs);
        let window = [];
        for (const n of notesSorted) {
          if (n.tMs < now0 - 200) continue; // ignore negative start after offset
          if (n.tMs > now0 + lookAheadMs) break;
          window.push(n);
        }
        visibleEstimate = window.length;
        // Cap + buffer
        const poolTarget = Math.min(512, Math.max(64, visibleEstimate * 2));
        this._notePool = this._notePool || [];
        // Build head/tail textures for common sizes once (assuming lane width base)
        try { this._ensureHeadTextures(this.laneWidth, this.noteHeight); } catch {}
        while (this._notePool.length < poolTarget) {
          const cont = new PIXI.Container();
          cont.visible = false;
          cont.__pfPooled = true;
          // Minimal head sprite
          const head = new PIXI.Sprite(this._texCache.headNormal || PIXI.Texture.WHITE);
          head.__pfBaseW = this.laneWidth;
          head.__pfBaseH = this.noteHeight;
          cont.addChild(head);
          // Optional body (tail) placeholder (not textured until claimed) for holds
          const body = new PIXI.Graphics();
          body.__pfBaseW = 12; // reference width
          body.visible = false;
          cont.addChild(body);
          this._notePool.push({ cont, head, body, inUse:false });
          this.app.stage.addChild(cont); // attach so textures upload to GPU
        }
      }

      // Pre-evaluate receptor lane colors at t=0 to populate caches and avoid first-frame cost spikes
      if (Array.isArray(this.receptors) && this.receptors.length) {
        const tSample = 0;
        for (let i=0;i<this.receptors.length;i++) {
          try { this._vfxColorForLaneAt(tSample, i); } catch {}
        }
      }

      // Brief yield for GPU processing of pooled sprites
      await new Promise(r=>setTimeout(r, 8));
    } catch {}
  }

  _buildProgressBar(totalW) {
    // Build a simple UI-space progress bar (does not follow camera)
    const barW = totalW + 80;
    const barH = 6;
    const x = this.startX - 40;
    const y = this.height - 32;

    // Clean up existing
    try {
      if (this.progressBg) { this.app.stage.removeChild(this.progressBg); this.progressBg.destroy({ children:true }); }
      if (this.progressFill) { this.app.stage.removeChild(this.progressFill); this.progressFill.destroy({ children:true }); }
    } catch {}
    this.progressBg = null;
    this.progressFill = null;

    this.progressBg = new PIXI.Graphics();
    this.progressBg.roundRect(x, y, barW, barH, 3);
    this.progressBg.fill({ color: 0xffffff, alpha: 0.08 });
    this.progressBg.zIndex = 8;
    this.app.stage.addChild(this.progressBg);
    if ("cacheAsBitmap" in this.progressBg) this.progressBg.cacheAsBitmap = true;

    this.progressFill = new PIXI.Graphics();
    this.progressFill.zIndex = 8;
    this.app.stage.addChild(this.progressFill);

    this._progressGeom = { x, y, barW, barH };
  }

  async _playSolo(manifest) {
    const player = new AudioPlayer();
    // Master volume only
    this._applyVolume(player);
    // Phase 1: audio
    this._setLoading(true, "Loading audio…");
    try { await player.load(manifest.audioUrl); }
    catch (e) { this._setLoading(true, "Failed to load audio"); throw e; }

    // Phase 2: cloning / chart build
    this._setLoading(true, "Building chart data…");

    // Clone so we never mutate the editor’s objects
    this.chart = {
      ...manifest,
      notes: Array.isArray(manifest.notes) ? manifest.notes.map(n => ({ ...n })) : []
    };

    // honor editor playhead offset (runtime.startAtMs) by trimming notes/time
    const offsetMs = Math.max(0, Number(this.runtime?.startAtMs) || 0);
    if (offsetMs > 0) this._applyStartOffset(offsetMs);

  // Phase 3: prepare notes/inputs
  this._setLoading(true, "Preparing notes & inputs…");
  this._resetNoteRuntimeFlags();
  this._prepareNotes();
  this._prepareInputs();
  await this._snapshotLeaderboardBefore();

  // Phase 4: prewarm VFX (gradient textures etc.)
  this._setLoading(true, "Preparing visual effects…");
  try { await this._prewarmVFX(); }
  catch(e){ this._setLoading(true, "VFX prewarm failed – continuing…"); }

    // Audio-clock authoritative timing setup
    // Schedule audio to start after lead-in unless we started mid-song (offsetMs > 0 => no full countdown)
    const useLeadIn = offsetMs === 0;
    const leadInMs = useLeadIn ? this.leadInMs : 0;
    const audioCtx = player.ctx;
    const audioStartAtSec = audioCtx.currentTime + (leadInMs / 1000);
    // Start the buffer at offset (if playtesting mid-song) exactly at the scheduled time
    const source = player.playAt(audioStartAtSec, { offsetSec: offsetMs / 1000 });

    // Store timing anchors
    this._audio = { player, source, startAtSec: audioStartAtSec, offsetMs };
    // Negative time phase (countdown) ends when audio actually starts
    // We'll compute game time each frame from audioCtx.currentTime; before start, we show -(remaining lead-in)

  // Hide overlay shortly before gameplay (after a rAF so first frame can upload textures)
  requestAnimationFrame(()=>{ requestAnimationFrame(()=> this._setLoading(false)); });

    // loop (pass audio clock metadata instead of perf start)
    await this._gameLoop(null, () => {});
    await this._reportScoreAndNotify();

    // wait for user to close the results before returning control
    await this._waitForResultsClose();

    source.stop();
  }

  _setLoading(isVisible, message = "Loading…") {
    try {
      // Create overlay lazily once
      if (!this._loadingOverlayEl) {
        const el = document.createElement('div');
        el.id = 'pf-loading-overlay';
        el.style.position = 'fixed';
        el.style.left = '0';
        el.style.top = '0';
        el.style.width = '100vw';
        el.style.height = '100vh';
        el.style.background = '#05070b';
        el.style.display = 'flex';
        el.style.flexDirection = 'column';
        el.style.alignItems = 'center';
        el.style.justifyContent = 'center';
        el.style.gap = '28px';
        el.style.zIndex = '9999';
        el.style.font = '600 16px system-ui, sans-serif';
        el.style.color = '#e7f0ff';
        el.style.letterSpacing = '0.5px';
        el.style.transition = 'opacity 320ms ease';
        // Spinner
        const spinner = document.createElement('div');
        spinner.className = 'pf-spinner';
        spinner.style.width = '72px';
        spinner.style.height = '72px';
        spinner.style.border = '8px solid rgba(255,255,255,0.12)';
        spinner.style.borderTop = '8px solid #4da3ff';
        spinner.style.borderRadius = '50%';
        spinner.style.animation = 'pf-spin 0.9s linear infinite';
        // Label
        const label = document.createElement('div');
        label.className = 'pf-loading-label';
        label.style.textAlign = 'center';
        label.style.fontSize = '15px';
        label.style.maxWidth = '320px';
        label.style.opacity = '0.9';
        el.appendChild(spinner);
        el.appendChild(label);
        document.body.appendChild(el);

        // Inject keyframes once
        if (!document.getElementById('pf-loading-style')) {
          const st = document.createElement('style');
            st.id = 'pf-loading-style';
            st.textContent = `@keyframes pf-spin { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }`;
            document.head.appendChild(st);
        }
        this._loadingOverlayEl = el;
        this._loadingOverlayLabel = label;
      }
      const el = this._loadingOverlayEl;
      const label = this._loadingOverlayLabel;
      if (label) label.textContent = message || 'Loading…';
      if (isVisible) {
        el.style.pointerEvents = 'auto';
        el.style.opacity = '1';
        el.style.display = 'flex';
        this._loadingVisibleAt = performance.now();
      } else {
        // Ensure it stayed visible at least a short minimum to avoid flash
        const minMs = 400;
        const elapsed = (performance.now() - (this._loadingVisibleAt||0));
        const hide = () => {
          el.style.opacity = '0';
          el.style.pointerEvents = 'none';
          // Remove after transition
          clearTimeout(this._loadingRemoveTO);
          this._loadingRemoveTO = setTimeout(()=>{ try { el.style.display='none'; } catch {} }, 500);
        };
        if (elapsed < minMs) {
          clearTimeout(this._loadingDelayTO);
          this._loadingDelayTO = setTimeout(hide, minMs - elapsed);
        } else hide();
      }
    } catch {}
  }

  _resetNoteRuntimeFlags() {
    if (!this.chart || !Array.isArray(this.chart.notes)) return;
    for (const n of this.chart.notes) {
      if ("hit" in n) delete n.hit;
      if ("_pf" in n) delete n._pf;
    }
  }

  _applyStartOffset(offsetMs) {
    offsetMs = Math.max(0, Number(offsetMs) || 0);
    if (!offsetMs || !this.chart) return;

    const inNotes = Array.isArray(this.chart.notes) ? this.chart.notes : [];
    const out = [];
    for (const n of inNotes) {
      const start = n.tMs | 0;
      const dur   = Math.max(0, n.dMs | 0);
      const end   = start + dur;

      if (end <= offsetMs) continue;

      const nn = { ...n };
      nn.tMs = Math.max(0, start - offsetMs);

      if (dur > 0) {
        const newEnd = end - offsetMs;
        nn.dMs = Math.max(0, newEnd - nn.tMs);
      } else {
        delete nn.dMs;
      }

      out.push(nn);
    }

    const oldDuration = Number(this.chart.durationMs) || 0;
    const newDuration = Math.max(0, oldDuration - offsetMs);

    this.chart = { ...this.chart, notes: out, durationMs: newDuration };
  }

  _prepareNotes() {
    this.chart.notes.sort((a, b) => a.tMs - b.tMs);
    this.notesByLane = Array.from({ length: this.laneCount }, () => []);
    for (const n of this.chart.notes) {
      if (typeof n.lane === "number" && n.lane >= 0 && n.lane < this.laneCount) {
        this.notesByLane[n.lane].push(n);
      }
    }
    this.nextIdxByLane = Array.from({ length: this.laneCount }, () => 0);
  }

  _prepareInputs() {
    const keys = this.settings.keys || ["D", "F", "J", "K"];
    const map = {}; for (let i = 0; i < keys.length; i++) map[keys[i].toUpperCase()] = i;
    this.keyMap = map;

    // Save previous handlers so we can restore them on destroy()
    this._prevOnKeyDown = window.onkeydown;
    this._prevOnKeyUp   = window.onkeyup;

    window.onkeydown = e => {
      const k = (e.key || "").toUpperCase(); if (!(k in map)) return;
      if (this.keyDown.has(k)) return;
      this.keyDown.add(k);
      const lane = map[k];
      this.held[lane] = true;
      this._flashReceptor(lane, 0.8);
      this._attemptHit(lane, true);
    };
    window.onkeyup = e => {
      const k = (e.key || "").toUpperCase(); if (!(k in map)) return;
      const lane = map[k];
      this.keyDown.delete(k);
      this.held[lane] = false;
      this._attemptHoldRelease(lane);
    };
  }

  _attemptHoldRelease(lane) {
    if (this.state.timeMs < 0) return;
    const nowMs = this.state.timeMs + (this.settings.latencyMs || 0);
    const hold = this.activeHoldsByLane.get(lane);
    if (!hold || hold.broken) return;

    if (nowMs < hold.endMs - 80) {
      hold.broken = true;
      this.state.combo = 0;
      this._recordJudge("Miss");
      this._judgment("Miss", true);
      if (hold.bodyRef) {
        hold.bodyRef.__pfHoldActive = false;
        this._beginFadeOut(hold.bodyRef, HOLD_BODY_FADE, true);
      }
      if (hold.headRef) {
        hold.headRef.__pfHoldActive = false;
        this._beginFadeOut(hold.headRef, MISS_FADE_RATE, false);
      }
      this.activeHoldsByLane.delete(lane);
    }
  }

  _attemptHit(lane, isDown) {
    if (!isDown) return;
    if (this.state.timeMs < 0) return;
    const nowMs = this.state.timeMs + (this.settings.latencyMs || 0);

    const arr = this.notesByLane[lane] || [];
    let idx = this.nextIdxByLane[lane] || 0;

    for (let i = idx; i < arr.length; i++) {
      const n = arr[i]; if (n.hit) { idx = i + 1; continue; }
      const dt = nowMs - n.tMs, adt = Math.abs(dt);
      const isHold = (n.dMs && n.dMs > 0);

      if (adt <= PERFECT_MS) { this._registerHit(n, lane, "Perfect", isHold); idx = i + 1; break; }
      else if (adt <= GREAT_MS) { this._registerHit(n, lane, "Great", isHold); idx = i + 1; break; }
      else if (adt <= GOOD_MS) { this._registerHit(n, lane, "Good", isHold); idx = i + 1; break; }
      else if (dt < -120) { break; }
      else { idx = i + 1; continue; }
    }

    this.nextIdxByLane[lane] = idx;
  }

  _registerHit(note, lane, label, isHold) {
    note.hit = true;
    // Capture actual hit time (game time) for later drain timing logic (especially for early/late offsets)
    if (note.__pfHitTimeMs == null) note.__pfHitTimeMs = this.state.timeMs;
    // Reset simplified hold drain markers (new logic does direct time math each frame)
    if (isHold) {
      note.__pfCenterLocked = false; // will lock when head center reaches judge line the first time
    }

    // scoring + counters
    const base = label === "Perfect" ? 100 : label === "Great" ? 80 : 50;
    this.state.score += base + Math.floor(this.state.combo * 0.1);
    this.state.combo += 1;
    this.maxCombo = Math.max(this.maxCombo || 0, this.state.combo);
    this.state.hits += 1;
    this._recordJudge(label);
    this._judgment(label);

    // receptor pulse + ring
    const lc = this.vis.laneColors[lane % this.vis.laneColors.length];
    this._flashReceptor(lane, label === "Perfect" ? 1.0 : 0.7);
    if (label === "Perfect") {
      const cx = this._laneX(lane) + this.laneWidth / 2;
      this._spawnRing(cx, this.judgeY, lc);
    }

    // visuals
    const vis = this.spriteByNote?.get(note);
    if (!vis) return;

    if (isHold) {
      // Head flashes white; tail turns white, remains full-length.
      this._paintHeadWhite(vis.head);
      vis.head.__pfWhiteSticky = true; // keep head white after hit
      if (vis.body) {
        vis.body.texture = this._getBodyTexture(vis.body.__pfLen, true);
        vis.body.tint = 0xFFFFFF;
        vis.body.alpha = 0.95;
      }

      vis.head.__pfHoldActive = true;
      if (vis.body) vis.body.__pfHoldActive = true;
      // Enable tail mask when actively holding (if judge-clip mode is on)
      if (this.holdTailClipsAtJudge && vis.body?.__pfMask) {
        vis.body.__pfMaskPersist = false;
        vis.body.mask = vis.body.__pfMask;
      }

      const endMs = (note.tMs || 0) + (note.dMs || 0);
      this.activeHoldsByLane.set(lane, {
        endMs,
        broken: false,
        headRef: vis.head,
        bodyRef: vis.body,
        lastHeldMs: this.state.timeMs || 0 // track last frame we saw the key down for grace handling
      });

      // Head flash then fade
      const until = (this.state.timeMs || 0) + WHITE_FLASH_MS;
      vis.head.__pfFlashUntil = until;
  vis.head.__pfFadeRate   = HIT_FADE_RATE;

    } else {
      // Tap: brief head white flash
      this._paintHeadWhite(vis.head);
      vis.head.__pfWhiteSticky = true; // keep head white after hit
      const until = (this.state.timeMs || 0) + WHITE_FLASH_MS;
      vis.head.__pfFlashUntil = until;
  vis.head.__pfFadeRate   = HIT_FADE_RATE;
    }
  }

  _recordJudge(label) {
    if (!this.state.judges) this.state.judges = { Perfect: 0, Great: 0, Good: 0, Miss: 0 };
    if (label in this.state.judges) this.state.judges[label] += 1;
  }

  _paintHeadWhite(head) {
    head.texture = this._getHeadTexture(true);
    head.tint = 0xFFFFFF;
    head.alpha = 1;
  }

  _beginFadeOut(displayObj, fadeRatePerFrame = HIT_FADE_RATE, removeWhenDone = true) {
    displayObj.__pfFade = { rate: fadeRatePerFrame, remove: removeWhenDone };
  }

  // Canvas-only judgment text (fade while rising)
  _judgment(label, miss = false) {
    const style = miss ? this._fxStyles.Miss
      : label === "Perfect" ? this._fxStyles.Perfect
      : label === "Great" ? this._fxStyles.Great
      : this._fxStyles.Good;

    const t = this._acquireFxText();
    t.style = style;
    t.text = label;
    t.anchor.set(0.5, 0.5);
    t.x = this.width / 2;
    t.y = this.judgeY - 42;
    t.alpha = 1;
    t.__pfVelY = -0.7;
    this.fxTextLayer.addChild(t);
    t.__pfFade = { rate: 0.03, remove: true, pooled: true };
  }

  async _gameLoop(startPerfMs, tickHook) {
    // ===== defensive clear/ensure layers =====
    // lane note layers
    if (!Array.isArray(this.laneNoteLayers)) this.laneNoteLayers = [];
    for (const lc of this.laneNoteLayers) {
      try { lc?.removeChildren?.(); } catch {}
    }

    // fx ring layer
    if (!this.fxRingLayer) {
      this.fxRingLayer = this._makeFxRingLayer();
      this.fxRingLayer.zIndex = 7;
      try { this.cameraLayer?.addChild?.(this.fxRingLayer); } catch {}
    } else {
      try { this.fxRingLayer.removeChildren(); } catch {}
    }

    // fx text layer
    if (!this.fxTextLayer) {
      this.fxTextLayer = new PIXI.Container();
      this.fxTextLayer.zIndex = 7;
      try { this.cameraLayer?.addChild?.(this.fxTextLayer); } catch {}
    } else {
      try { this.fxTextLayer.removeChildren(); } catch {}
    }

    // sprite map
    if (!this.spriteByNote) this.spriteByNote = new Map();
    else try { this.spriteByNote.clear(); } catch {}

    this._resultsShown = false;
    this.state.judges = { Perfect: 0, Great: 0, Good: 0, Miss: 0 };

    const headH = 32;
    const headW = Math.max(28, this.laneWidth - 16);
    this._ensureHeadTextures(headW, headH);

    // Build sprites
    this.noteSprites = this.chart.notes.map(n => {
      const cont = new PIXI.Container();
      const isHold = (n.dMs && n.dMs > 0);

  const head = new PIXI.Sprite(this._getHeadTexture(false));
  head.width = headW;
  head.height = headH;
  head.__pfBaseW = headW;
  // Apply VFX per-lane color override if available at t=0 (will update per-frame below)
  const laneColorHex = this._vfxColorForLaneAt(0, n.lane) || this.vis.laneColors[n.lane % this.vis.laneColors.length];
  head.tint = laneColorHex;

      // optional gloss
      let gloss = null;
      if (this._texCache.headGloss) {
        gloss = new PIXI.Sprite(this._texCache.headGloss);
        gloss.alpha = 0.45;
        gloss.__pfBaseW = headW;
      }

      // place in lane container
      cont.x = this._laneX(n.lane) + (this.laneWidth - headW) / 2;
      cont.y = -60;

      let body = null;
      if (isHold) {
        const lengthPx = Math.max(10, n.dMs * this.pixelsPerMs);
        body = new PIXI.Sprite(this._getBodyTexture(lengthPx, false));
  const stemX = (headW - 12) / 2;
  body.__pfBaseW = 12;
  body.__pfStemX = stemX;
        body.x = stemX;
        body.y = -(lengthPx - 2);
        body.tint = this.vis.laneColors[n.lane % this.vis.laneColors.length];
        body.alpha = 1.0;
        body.__pfLen = lengthPx;
        body.__pfHoldActive = false;

        if (this.holdTailClipsAtJudge) {
          const bm = new PIXI.Graphics();
          bm.isMask = true;
          bm.visible = false; // never render as a visible beam unless actively used as a mask
          // Do not activate the mask yet; only enable once the hold is actually hit/active
          cont.addChild(bm);
          body.__pfMask = bm;
        }
        cont.addChild(body);
      }

      cont.addChild(head);
      if (gloss) cont.addChild(gloss);

      head.__pfFlashUntil = null;
  head.__pfFadeRate   = HIT_FADE_RATE;
      head.__pfHoldActive = false;
  head.__pfWhiteSticky = false;

      this.laneNoteLayers[n.lane].addChild(cont);
      const rec = { cont, head, body, n, gloss };
      this.spriteByNote.set(n, rec);
      return rec;
  });
  // Reset active window iteration structures
  this._laneSpriteListsBuilt = false;
  this._noteSpritesByLane = null;
  this._laneHeadIndex = null;

    // Canvas countdown helpers
    const showCountdown = (msLeft) => {
      const sLeft = Math.ceil(msLeft / 1000);
      this.countdownText.text = sLeft > 0 ? String(sLeft) : "Go!";
      this.countdownText.alpha = 1;
    };
    const hideCountdown = () => { if (this.countdownText) this.countdownText.alpha = 0; };

    // Audio-clock based frame loop
    const leadInMs = (this._audio?.offsetMs || 0) === 0 ? this.leadInMs : 0;
    return await new Promise(resolve => {
      // Fixed-step logic parameters
      this._logicStepMs = this._logicStepMs || 8.333; // 120 Hz logic
      this._logicAccumMs = this._logicAccumMs || 0;
      this._logicLastGameMs = this._logicLastGameMs || null;
      this._logicStateTimeMs = this._logicStateTimeMs || 0; // last committed logic time
      this._logicPrevStateTimeMs = this._logicPrevStateTimeMs || 0; // previous logic state time for interpolation
      this._visualTimeMs = this._visualTimeMs || 0; // interpolated render time
      this.app.ticker.add(() => {
        let audioTimeSec = 0;
        try { audioTimeSec = this._audio?.player?.ctx?.currentTime ?? 0; } catch {}

        // --- Audio stall detection ---------------------------------------------------------
        // Some browsers (or background tab throttling) can temporarily freeze AudioContext
        // currentTime. When that happens our notes appear to "freeze" mid-lane. We detect
        // a run of frames where currentTime does not advance and fall back to perf time.
        if (audioTimeSec <= this._lastAudioCtxTimeSec + 1e-5) {
          this._audioStallFrames++;
          // After ~30 consecutive frames (~0.5s at 60fps) treat as stall.
          if (!this._audioStallFallbackActive && this._audioStallFrames > 30) {
            this._audioStallFallbackActive = true;
            this._audioStallFallbackBasePerfMs = performance.now();
            this._audioStallFallbackBaseAudioSec = this._lastAudioCtxTimeSec;
            try { console.warn('[PulseForge] Audio clock stalled – falling back to performance timer for smooth note motion.'); } catch {}
          }
        } else {
          // Audio advanced normally; clear stall state
          this._audioStallFrames = 0;
          this._audioStallFallbackActive = false;
        }
        this._lastAudioCtxTimeSec = Math.max(this._lastAudioCtxTimeSec, audioTimeSec);

        if (this._audioStallFallbackActive) {
          const perfDeltaSec = (performance.now() - this._audioStallFallbackBasePerfMs) / 1000;
            audioTimeSec = this._audioStallFallbackBaseAudioSec + perfDeltaSec;
        }
        const _perfNow = performance.now();
        // -----------------------------------------------------------------------------------
        const startAtSec = this._audio?.startAtSec || 0;
        // If audio not started yet, audioTimeSec < startAtSec
        const untilStartSec = startAtSec - audioTimeSec;
        let gameTimeMs;
        if (untilStartSec > 0) {
          // still in countdown phase
            gameTimeMs = -Math.max(0, Math.round(untilStartSec * 1000));
        } else {
          const elapsedAudioMs = (audioTimeSec - startAtSec) * 1000;
          gameTimeMs = elapsedAudioMs + (this._audio?.offsetMs || 0);
        }
  this.state.timeMs = gameTimeMs; // authoritative audio time
  // Reset per-frame VFX memo cache
  this._vfxFrameCache = this._vfxFrameCache || new Map();
  if (this._vfxFrameCache.size > 0) this._vfxFrameCache.clear();
  // Legacy alias: many runtime sections (notes, VFX, judgments) still reference local tMs.
  // After refactor to audio-clock timing we assign it explicitly here for backwards compatibility.
  // Fixed-step logic update: advance logic state in uniform steps up to current audio time.
  if (this._logicLastGameMs == null) {
    this._logicLastGameMs = gameTimeMs;
    this._logicStateTimeMs = gameTimeMs;
    this._logicPrevStateTimeMs = gameTimeMs;
  }
  let dtReal = gameTimeMs - this._logicLastGameMs;
  this._logicLastGameMs = gameTimeMs;
  // During negative countdown, keep logic time locked to gameTimeMs (no interpolation needed)
  if (gameTimeMs < 0) {
    this._logicPrevStateTimeMs = this._logicStateTimeMs = gameTimeMs;
    this._visualTimeMs = gameTimeMs;
  } else {
    // Accumulate and step
    this._logicAccumMs += dtReal;
    const step = this._logicStepMs;
    // Prevent spiral of death: cap catch-up (e.g., if tab was inactive) to 8 steps per frame
    let steps = 0;
    while (this._logicAccumMs >= step && steps < 8) {
      this._logicAccumMs -= step;
      this._logicPrevStateTimeMs = this._logicStateTimeMs;
      this._logicStateTimeMs += step;
      steps++;
    }
    // If we hit cap (lag spike), snap logic to audio time to avoid widening gap
    if (steps === 8 && this._logicStateTimeMs < gameTimeMs - 50) {
      this._logicPrevStateTimeMs = this._logicStateTimeMs = gameTimeMs;
      this._logicAccumMs = 0;
    }
  const alpha = Math.max(0, Math.min(1, this._logicAccumMs / step));
  // Interpolate strictly between previous and current committed logic states for temporal stability
  this._visualTimeMs = this._logicPrevStateTimeMs * (1 - alpha) + this._logicStateTimeMs * alpha;
    if (this._visualTimeMs > gameTimeMs + 10) this._visualTimeMs = gameTimeMs; // clamp runaway
  }
  const tMs = (gameTimeMs < 0) ? gameTimeMs : this._visualTimeMs;

        // Secondary stall watchdog: if gameTimeMs not advancing for >500ms wall time, force advance.
        try {
          const w = this._stallWatch;
          if (w) {
            if (gameTimeMs === w.lastGameMs) {
              w.frames++;
              if ((_perfNow - w.lastPerfMs) > 500 && w.frames > 30) {
                const forced = _perfNow - w.lastPerfMs;
                this._logicLastGameMs += forced;
                this._logicStateTimeMs += forced;
                this._visualTimeMs += forced;
                this.state.timeMs += forced;
                gameTimeMs = this.state.timeMs;
                try { console.warn('[PulseForge] Watchdog forced +'+forced.toFixed(1)+'ms advance'); } catch {}
                w.frames = 0;
                w.lastPerfMs = _perfNow;
                w.lastGameMs = gameTimeMs;
              }
            } else {
              w.frames = 0;
              w.lastGameMs = gameTimeMs;
              w.lastPerfMs = _perfNow;
            }
          }
        } catch {}

        if (this._debugOverlay) {
          try {
            this._debugOverlay.text = `a:${(audioTimeSec*1000).toFixed(0)} g:${gameTimeMs.toFixed(0)} vis:${this._visualTimeMs.toFixed(0)} stall:${this._audioStallFallbackActive?'Y':'N'}`;
          } catch {}
        }

        if (gameTimeMs < 0) {
          showCountdown(-gameTimeMs);
        } else {
          hideCountdown();
        }

        // FX: text decay
        for (let i = this.fxTextLayer.children.length - 1; i >= 0; i--) {
          const child = this.fxTextLayer.children[i];
          if (child.__pfVelY) child.y += child.__pfVelY;
          if (child.__pfFade) {
            child.alpha = Math.max(0, child.alpha - child.__pfFade.rate);
            if (child.alpha <= 0.01) {
              if (child.__pfFade.remove) {
                if (child.__pfFade.pooled) this._releaseFxText(child);
                this.fxTextLayer.removeChild(child);
              }
              child.__pfFade = null;
            }
          }
  }
        // FX: rings
        for (let i = this.fxRingLayer.children.length - 1; i >= 0; i--) {
          const child = this.fxRingLayer.children[i];
          if (child.__pfScaleVel) {
            const nx = child.scale.x + child.__pfScaleVel;
            child.scale.set(nx, nx);
          }
          if (child.__pfFade) {
            child.alpha = Math.max(0, child.alpha - child.__pfFade.rate);
            if (child.alpha <= 0.01) {
              if (child.__pfFade.remove) this.fxRingLayer.removeChild(child);
              child.__pfFade = null;
            }
          }
        }

        // Receptor glow decay + conditional redraw (gated)
        for (let i = 0; i < this.receptors.length; i++) {
          const rec = this.receptors[i];
          if (!rec) continue;
          // Compute desired color once; only redraw geometry if color changed or lane width changed since last build
          try {
            const tNow = this.state.timeMs;
            const lane = rec.__lane | 0;
            const vfxColor = this._vfxColorForLaneAt(tNow, lane);
            const fallback = this.vis.laneColors[lane % this.vis.laneColors.length];
            const want = vfxColor ?? fallback;
            // Track lane width snapshot to catch resolution/scale changes
            const lastLaneW = rec.__laneW;
            if (want != null && (want !== rec.__color || lastLaneW !== this.laneWidth)) {
              rec.__color = want;
              rec.__laneW = this.laneWidth;
              // Redraw receptor pieces with new color only when needed
              if (rec.__chev) {
                rec.__chev.clear();
                rec.__chev.moveTo(-14, -16); rec.__chev.lineTo(0, -4); rec.__chev.lineTo(14, -16);
                rec.__chev.stroke({ width: 3, color: want, alpha: 0.95 });
              }
              if (rec.__bar) {
                rec.__bar.clear();
                rec.__bar.roundRect(-this.laneWidth * 0.35, -2, this.laneWidth * 0.7, 4, 2);
                rec.__bar.fill({ color: want, alpha: 0.25 });
              }
              if (rec.__glow) {
                const prevAlpha = rec.__glow.alpha ?? 0.0;
                rec.__glow.clear();
                rec.__glow.roundRect(-this.laneWidth * 0.38, -6, this.laneWidth * 0.76, 12, 4);
                rec.__glow.fill({ color: want, alpha: prevAlpha });
              }
            }
          } catch {}
          // Pulse/decay unchanged
          if (rec.__pulse > 0) {
            const tPulse = rec.__pulse;
            const scale = 1.0 + 0.12 * Math.sin((Math.PI * tPulse) / 10);
            rec.scale.set(scale, scale);
            if (rec.__glow) rec.__glow.alpha = Math.max(0, rec.__glow.alpha - 0.06);
            rec.__pulse--;
          } else {
            rec.scale.set(1, 1);
            if (rec.__glow) rec.__glow.alpha = Math.max(0, rec.__glow.alpha - 0.06);
          }
        }

        // ===== VFX background & lane effects =====
        try {
          if (this.vfx) {
            const t = this.state.timeMs;

            // Background gradient rendering via cached sprite
            this._ensureGradientLayer();
            this._updateGradientSprite(t);

            // Lane opacity
            const laneOpacityPct = Number(this._vfxValueAt('lanes.opacity', t));
            const laneAlpha = Number.isFinite(laneOpacityPct) ? Math.max(0, Math.min(1, laneOpacityPct/100)) : 0.95;
            if (this.laneBackboardLayer) this.laneBackboardLayer.alpha = laneAlpha;

            // Camera transforms (position x/y, zoom, rotation) + shake
            if (this.cameraLayer) {
              const cx = Number(this._vfxValueAt('camera.x', t) ?? this.vfx.props?.camera?.x ?? 0);
              const cy = Number(this._vfxValueAt('camera.y', t) ?? this.vfx.props?.camera?.y ?? 0);
              // Zoom is controlled solely by camera.z; camera.zoom property is ignored
              const zVal = Number(this._vfxValueAt('camera.z', t) ?? this.vfx.props?.camera?.z ?? 0);
              const rotZDeg = Number(this._vfxValueAt('camera.rotateZ', t) ?? this.vfx.props?.camera?.rotateZ ?? 0);
              const rotXDeg = Number(this._vfxValueAt('camera.rotateX', t) ?? this.vfx.props?.camera?.rotateX ?? 0);
              const rotYDeg = Number(this._vfxValueAt('camera.rotateY', t) ?? this.vfx.props?.camera?.rotateY ?? 0);
              // Shake
              const shakeAmp = Number(this._vfxValueAt('camera.shakeAmp', t) ?? this.vfx.props?.camera?.shakeAmp ?? 0);
              const shakeFreq = Number(this._vfxValueAt('camera.shakeFreq', t) ?? this.vfx.props?.camera?.shakeFreq ?? 5);
              let sx = 0, sy = 0;
              if (shakeAmp > 0 && shakeFreq > 0) {
                const tt = t / 1000; // seconds
                sx = Math.sin(tt * Math.PI * 2 * shakeFreq) * shakeAmp;
                sy = Math.cos(tt * Math.PI * 2 * shakeFreq * 0.8) * (shakeAmp * 0.6);
              }
              // Map Z to extra zoom factor
              const zoomMul = Math.max(0.05, Math.min(5, 1 * (1 + (zVal/100))));
              // Treat canvas as a 2D plane: apply rotateZ as rotation, X/Y as skew (2.5D look)
              const rz = this._pfDegToRad(rotZDeg);
              this.cameraLayer.pivot.set(this.width/2, this.height/2);
              this.cameraLayer.position.set(this.width/2 + cx + sx, this.height/2 + cy + sy);
              this.cameraLayer.scale.set(zoomMul, zoomMul);
              this.cameraLayer.rotation = rz;
              // Skew for faux 3D: clamp small range for stability
              const skewX = Math.max(-0.6, Math.min(0.6, this._pfDegToRad(rotYDeg)));
              const skewY = Math.max(-0.6, Math.min(0.6, this._pfDegToRad(rotXDeg)));
              // PIXI v8: container.skew is available via transform.skew or skew property
              try {
                if (this.cameraLayer.skew) {
                  this.cameraLayer.skew.set(skewX, skewY);
                } else if (this.cameraLayer.transform?.skew) {
                  this.cameraLayer.transform.skew.set(skewX, skewY);
                }
              } catch {}
            }

            // Lanes: draw as simple rects (no perspective); tint/alpha still applied above
            try {
              if (Array.isArray(this.laneBackboards) && this.laneBackboards.length === this.laneCount) {
                for (let i = 0; i < this.laneCount; i++) {
                  const g = this.laneBackboards[i];
                  if (!g) continue;
                  g.clear();
                  g.roundRect(this._laneX(i), this._laneTop, this.laneWidth, this._laneHeight, 18);
                  g.fill({ color: 0x0f1420 });
                  g.stroke({ width: 2, color: 0x2a3142 });
                }
              }
            } catch {}

            // Beat flash overlay
            const flashOn = !!this._vfxValueAt('background.flashEnable', t);
            if (flashOn && this._flashOverlay) {
              const flashColor = this._vfxValueAt('background.flashColor', t) || this.vfx.props?.background?.flashColor || '#ffffff';
              const flashIntensity = Number(this._vfxValueAt('background.flashIntensity', t) ?? this.vfx.props?.background?.flashIntensity ?? 30);
              const flashDuration = Math.max(20, Number(this._vfxValueAt('background.flashDuration', t) ?? this.vfx.props?.background?.flashDuration ?? 200));
              const bpm = Number(this.chart?.bpm || this.runtime?.manifest?.bpm || 120);
              const beatLenMs = Math.max(1, 60000 / Math.max(1, bpm));
              const beatIndex = Math.floor(t / beatLenMs);
              if (beatIndex !== this._lastBeatIndex) {
                this._lastBeatIndex = beatIndex;
                this._flashUntilMs = t + flashDuration;
                this._flashMaxAlpha = Math.max(0, Math.min(1, flashIntensity / 100));
                // update color if changed
                const col = parseInt(String(flashColor || '#ffffff').replace('#','0x'), 16);
                if (col !== this._flashColor) {
                  this._flashColor = col;
                  this._flashOverlay.clear();
                  this._flashOverlay.rect(0, 0, this.width, this.height);
                  this._flashOverlay.fill({ color: this._flashColor, alpha: 0 });
                }
              }
              const rem = Math.max(0, this._flashUntilMs - t);
              const a = (rem <= 0) ? 0 : this._flashMaxAlpha * (rem / flashDuration);
              this._flashOverlay.alpha = a;
            } else if (this._flashOverlay) {
              this._flashOverlay.alpha = 0;
            }
          }
        } catch {}

        // ===== Notes (Simplified Legacy Iteration) =====
        for (let i = 0; i < this.noteSprites.length; i++) {
          const obj = this.noteSprites[i];
            if (!obj) continue;
            const { n, cont, body, head, gloss } = obj;
            if (!head || !cont) continue;
            // Position: head center hits judge at n.tMs
            const yCenter = this.judgeY - ((n.tMs || 0) - tMs) * this.pixelsPerMs;
            cont.y = yCenter - head.height / 2;

            // Basic scaling (retain existing VFX size logic if any later needed)
            if (body) body.scale.x = 1;

            // Lane / note color baseline (matches head & tail). Prefer VFX override unless white override active.
            let laneColor = null;
            try { laneColor = this._vfxColorForLaneAt(tMs, n.lane); } catch {}
            if (laneColor == null && this.vis && Array.isArray(this.vis.laneColors)) {
              laneColor = this.vis.laneColors[n.lane % this.vis.laneColors.length];
            }
            // Determine white override: a note that has been hit (tap) OR an active hold segment should remain white.
            // White override logic:
            //  - Tap note: becomes white after successful hit (n.hit && n.result !== 'Miss').
            //  - Hold note: head becomes white once hit; stays white while actively held; on early release (broken) revert to lane tint.
            //  - Miss: never white.
            let whiteOverride = false;
            if (n.hit && n.result !== 'Miss') {
              // Determine if this is a hold (has body).
              if (body) {
                const stillHeld = !!(head.__pfHoldActive || body.__pfHoldActive);
                // If hold was hit successfully and is still being held OR it already finished successfully (maskPersist), keep white.
                if (stillHeld || body.__pfMaskPersist) whiteOverride = true;
              } else {
                whiteOverride = true; // tap
              }
            }
            if (whiteOverride) {
              if (head.tint !== 0xFFFFFF) head.tint = 0xFFFFFF;
              if (body && body.tint !== 0xFFFFFF) body.tint = 0xFFFFFF;
            } else if (laneColor != null) {
              if (head.tint !== laneColor) head.tint = laneColor;
              if (body && body.tint !== laneColor) body.tint = laneColor;
            }

            // Ensure tail texture matches length & style (normal, not white override)
            if (body && body.__pfLen) {
              if (!body.__pfLastLen || body.__pfLastLen !== body.__pfLen || !body.texture) {
                try { body.texture = this._getBodyTexture(body.__pfLen, false); body.__pfLastLen = body.__pfLen; } catch {}
              }
            }

            // Legacy hold mask: only clip while actively held (or persist flag) at judge line
            if (body && this.holdTailClipsAtJudge) {
              const totalLen = body.__pfLen || 0;
              if (body.height !== totalLen) body.height = totalLen;
              const desiredY = -(totalLen - 2);
              if (body.y !== desiredY) body.y = desiredY;
              if (!body.__pfMask) {
                const g = new PIXI.Graphics();
                g.isMask = true; g.visible = false; cont.addChild(g); body.__pfMask = g;
              }
              const active = !!(head.__pfHoldActive || body.__pfHoldActive || body.__pfMaskPersist);
              const g = body.__pfMask;
              if (active) {
                if (body.mask !== g) body.mask = g;
                g.visible = true; g.clear();
                // judge line local Y
                const cutLocalY = cont.toLocal(new PIXI.Point(0, this.judgeY)).y;
                const margin = 8; const stemX = body.x - margin/2;
                const maskW = (body.__pfBaseW || 12) * (body.scale?.x || 1) + margin;
                g.rect(stemX, -50000, maskW, cutLocalY + 50000); g.fill(0xffffff); g.isMask = true;
              } else {
                if (body.mask) body.mask = null; g.visible = false; g.clear();
              }
            }

            // Fade-out:
            //  - Tap: fade immediately after successful hit.
            //  - Hold: fade only after successful completion (no longer active, not broken) and not a miss.
            const holdActive = !!(head.__pfHoldActive || body?.__pfHoldActive);
            const shouldFade = n.hit && n.result !== 'Miss' && (!body ? true : (!holdActive && body.__pfMaskPersist));
            if (shouldFade) {
              // Head fade
              if (head && !head.__pfFade) {
                const rate = head.__pfFadeRate || HIT_FADE_RATE;
                this._beginFadeOut(head, rate, true);
              }
              // Tail fade (if exists and not already fading)
              if (body && !body.__pfFade) {
                this._beginFadeOut(body, HOLD_FADE_RATE, true);
              }
            }

            // Apply fade alpha updates (notes previously lacked per-frame alpha decay)
            if (head && head.__pfFade) {
              if (head.alpha == null) head.alpha = 1;
              head.alpha = Math.max(0, head.alpha - head.__pfFade.rate);
              if (head.alpha <= 0.01) {
                if (head.__pfFade.remove) {
                  // For tap notes (no body) we can remove whole container when head done
                  if (!body && cont.parent) cont.parent.removeChild(cont);
                }
                head.__pfFade = null;
              }
            }
            if (body && body.__pfFade) {
              if (body.alpha == null) body.alpha = 1;
              body.alpha = Math.max(0, body.alpha - body.__pfFade.rate);
              if (body.alpha <= 0.01) {
                if (body.__pfFade.remove) {
                  // Remove container if head also faded or doesn't exist
                  const headGone = (!head || !head.__pfFade) && (head ? head.alpha <= 0.01 : true);
                  if (headGone && cont.parent) cont.parent.removeChild(cont);
                }
                body.__pfFade = null;
              }
            }

            // Simple miss handling for taps (do not classify hold bodies here)
            if (!body && !n.hit && n.result !== 'Miss' && (tMs - (n.tMs || 0) > 120)) {
              n.result = 'Miss';
              n.hit = true; // legacy compatibility: other systems treat hit=true as judged; keep but mark result
              this.state.combo = 0;
              this._recordJudge('Miss');
              this._judgment('Miss', true);
            }

            // Miss handling for HOLD head never pressed: if it has a body (hold), was not hit, and we are beyond a late window.
            // Use a slightly larger window than taps to allow human reaction; e.g., 150ms.
            if (body && !n.hit && n.result !== 'Miss') {
              const lateMs = tMs - (n.tMs || 0);
              if (lateMs > 150) {
                // Mark as miss, break combo, no white/fade success.
                n.result = 'Miss';
                n.hit = true;
                this.state.combo = 0;
                this._recordJudge('Miss');
                this._judgment('Miss', true);
                // Ensure active hold tracking does not treat it as started.
                if (head.__pfHoldActive) head.__pfHoldActive = false;
                if (body.__pfHoldActive) body.__pfHoldActive = false;
              }
            }

            // Cull when well below lane
            const laneBottom = this._laneTop + this._laneHeight + 80;
            if (cont.y - (body?.__pfLen || 0) > laneBottom) {
              if (body?.__pfMask && !body.__pfTunnelActive) { body.mask = null; body.__pfMask.removeFromParent(); }
              cont.parent?.removeChild(cont);
              continue;
            }
        }

        // Maintain active holds (success/early release)
        if (tMs >= 0) {
          const RELEASE_GRACE_MS = 50; // short grace so tiny key wobble doesn't break hold
          for (const [lane, hold] of this.activeHoldsByLane) {
            if (hold.broken) continue;
            if (tMs < hold.endMs) {
              // update lastHeldMs if still held
              if (this.held[lane]) {
                hold.lastHeldMs = tMs;
              }
              const idleFor = tMs - (hold.lastHeldMs || 0);
              if (!this.held[lane] && idleFor > RELEASE_GRACE_MS) {
                hold.broken = true;
                this.state.combo = 0;
                this._recordJudge("Miss");
                this._judgment("Miss", true);
                if (hold.bodyRef) {
                  hold.bodyRef.__pfHoldActive = false;
                  hold.bodyRef.__pfMaskPersist = false;
                  // Unmask so tail scrolls off-screen; do not fade
                  if (hold.bodyRef.__pfMask && !hold.bodyRef.__pfTunnelActive) { hold.bodyRef.mask = null; hold.bodyRef.__pfMask.removeFromParent(); hold.bodyRef.__pfMask = null; }
                }
                if (hold.headRef) {
                  hold.headRef.__pfHoldActive = false;
                  // Do not fade; it will scroll and be culled
                }
                this.activeHoldsByLane.delete(lane);
              }
            } else {
              if (hold.bodyRef) {
                hold.bodyRef.__pfHoldActive = false;
                // Keep masking after successful end so the remaining tail stays clipped at judge line
                if (hold.bodyRef.__pfMask) {
                  hold.bodyRef.__pfMaskPersist = true;
                  hold.bodyRef.mask = hold.bodyRef.__pfMask;
                }
                // Optional: small fade; remove if you want no fade on success
                this._beginFadeOut(hold.bodyRef, HOLD_FADE_RATE, true);
              }
              if (hold.headRef) {
                hold.headRef.__pfHoldActive = false;
                this._beginFadeOut(hold.headRef, HOLD_FADE_RATE, false);
              }
              this.activeHoldsByLane.delete(lane);
            }
          }
        }

        // HUD
        this.state.total = this.chart.notes.length;
        const acc = this.state.total ? this.state.hits / this.state.total : 1;
        this.state.acc = acc;

        if (this.$combo && this._lastHud.combo !== this.state.combo) {
          this.$combo.textContent = this.state.combo + "x";
          this._lastHud.combo = this.state.combo;
        }
        const accPct = Math.round(acc * 100) + "%";
        if (this.$acc && this._lastHud.acc !== accPct) {
          this.$acc.textContent = accPct;
          this._lastHud.acc = accPct;
        }
        if (this.$score && this._lastHud.score !== this.state.score) {
          this.$score.textContent = this.state.score.toString();
          this._lastHud.score = this.state.score;
        }

        // Progress bar
        if (this._progressGeom) {
          const { x, y, barW, barH } = this._progressGeom;
          const p = Math.max(0, Math.min(1, tMs / (this.chart.durationMs || 1)));
          this.progressFill.clear();
          this.progressFill.roundRect(x, y, Math.max(0.0001, barW * p), barH, 3);
          this.progressFill.fill({ color: 0xFFFFFF, alpha: 0.9 * p + 0.05 });
        }

        // One-shot keyframe verification (debug use only)
        if (this._enableKeyframeVerify && !this._keyframeVerifyRan && this.vfx) {
          this._keyframeVerifyRan = true;
          try {
            const sampleTimes = [0, 250, 500, 750, 1000, 1500, 2000, 4000, 8000];
            const props = [
              'background.gradient.angle',
              'background.gradient.stops[0].color',
              'background.gradient.stops[1].color',
              'camera.x','camera.y','camera.z','camera.rotateZ'
            ];
            const rows = [];
            for (const ms of sampleTimes) {
              const row = { t: ms };
              for (const pName of props) {
                row[pName] = this._vfxValueAt(pName, ms);
              }
              rows.push(row);
            }
            // eslint-disable-next-line no-console
            console.table(rows);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[PF] keyframe verify error', e);
          }
        }

        if (tickHook) tickHook();

        const endMs = (this.chart.durationMs || 20000) + 1500;
        if (tMs > endMs && !this._quitting) {
          if (!this._resultsShown) {
            this._resultsShown = true;
            this._showResultsOverlay();
          }
          // Do NOT resolve here. We’ll resolve after user closes the overlay.
        }
      });

      // if something goes wrong and results never show, soft timeout fallback (very generous)
      this._showResultsTimeout = setTimeout(() => {
        if (!this._resultsShown && !this._quitting) {
          this._resultsShown = true;
          this._showResultsOverlay();
        }
      }, (this.chart?.durationMs || 20000) + 10000);

      // allow external resolver to end the loop
      this._setResultsCloseResolver(() => resolve());
    });
  }

  _vfxColorForLaneAt(tMs, lane) {
    // notes.colors are 1-based in editor key path: notes.colors.1..4
    const prop = `notes.colors.${(lane|0)+1}`;
    const val = this._vfxValueAt(prop, tMs);
    if (typeof val === 'string' && /^#/.test(val)) {
      return parseInt(val.replace('#','0x'), 16);
    }
    return null;
  }

  _laneX(idx) { return this.startX + idx * (this.laneWidth + this.laneGap); }

  // ===== Textures / FX =====
  _makeFxRingLayer() {
    const PC =
      PIXI.ParticleContainer ||
      (PIXI.particles && PIXI.particles.ParticleContainer) ||
      null;

    if (PC) {
      try {
        return new PC(400, { scale: true, alpha: true, position: true, rotation: true, uvs: false });
      } catch (_) {
        try {
          return new PC({
            maxSize: 400,
            properties: { scale: true, alpha: true, position: true, rotation: true, uvs: false },
            roundPixels: true
          });
        } catch (_) {}
      }
    }
    if (!this._warnedNoParticleContainer) {
      this._warnedNoParticleContainer = true;
      try { console.warn("[PulseForge] ParticleContainer not available; using PIXI.Container for FX."); } catch {}
    }
    return new PIXI.Container();
  }

  // ===== Simple helpers =====
  _pfDegToRad(d) { return (d || 0) * Math.PI / 180; }

  _ensureHeadTextures(headW, headH) {
    if (this._texCache.headNormal && this._texCache._headW === headW && this._texCache._headH === headH) return;

    const makeHead = (fillColor, strokeColor) => {
      const g = new PIXI.Graphics();
      g.roundRect(0, 0, headW, headH, 10);
      g.fill({ color: fillColor });
      g.stroke({ width: 2, color: strokeColor });
      return this.app.renderer.generateTexture(g);
    };
    const makeGloss = () => {
      const g = new PIXI.Graphics();
      g.roundRect(4, 4, headW - 8, Math.max(1, Math.floor(headH * 0.42)), 8);
      g.fill({ color: 0xffffff, alpha: 0.20 });
      return this.app.renderer.generateTexture(g);
    };

    this._texCache.headNormal = makeHead(0xffffff, 0xffffff);
    this._texCache.headWhite  = makeHead(0xffffff, 0xffffff);
    this._texCache.headGloss  = makeGloss();
    this._texCache._headW = headW;
    this._texCache._headH = headH;
  }

  _getHeadTexture(white = false) { return white ? this._texCache.headWhite : this._texCache.headNormal; }

  _getBodyTexture(lengthPx, white = false) {
    const key = Math.max(10, Math.floor(lengthPx));
    const map = white ? this._texCache.bodyWhiteByLen : this._texCache.bodyNormalByLen;
    const cached = map.get(key);
    if (cached) return cached;

    const g = new PIXI.Graphics();
    g.roundRect(0, 0, 12, key, 6);
    g.fill({ color: 0xffffff, alpha: 1 });
    const tex = this.app.renderer.generateTexture(g);
    map.set(key, tex);
    return tex;
  }

  _acquireFxText() {
    if (this._fxPool.length) return this._fxPool.pop();
    const t = new PIXI.Text({ text: "", style: this._fxStyles.Good });
    t.__pfVelY = 0;
    t.__pfFade = null;
    return t;
  }
  _releaseFxText(t) {
    t.text = "";
    t.__pfVelY = 0;
    t.__pfFade = null;
    this._fxPool.push(t);
  }

  _flashReceptor(lane, strength = 1.0) {
    const rec = this.receptors[lane]; if (!rec) return;
    rec.__pulse = Math.max(rec.__pulse, Math.floor(10 * strength));
  }

  _spawnRing(x, y, color = 0x25f4ee) {
    if (!this.vis.ringOnHit) return;
    if (!this._ringTex) {
      const g = new PIXI.Graphics();
      g.circle(24, 24, 22);
      g.stroke({ width: 4, color: 0xffffff, alpha: 1 });
      this._ringTex = this.app.renderer.generateTexture(g);
    }
    const s = new PIXI.Sprite(this._ringTex);
    s.anchor.set(0.5, 0.5);
    s.x = x; s.y = y;
    s.tint = color;
    s.alpha = 0.9;
    s.scale.set(0.55, 0.55);
    s.__pfScaleVel = 0.06;
    s.__pfFade = { rate: 0.04, remove: true };
    this.fxRingLayer.addChild(s);
  }

  // ===== Results Overlay =====
  _showResultsOverlay() {
    if (this._quitting) return;
    const overlayId = "pf-results-overlay";
    let el = document.getElementById(overlayId);
    if (el) el.remove();

    const accPct = Math.round(this.state.acc * 100);
    const counts = this.state.judges || { Perfect:0, Great:0, Good:0, Miss:0 };
    const totalJudged = counts.Perfect + counts.Great + counts.Good + counts.Miss || 1;
    const segP = (counts.Perfect / totalJudged) * 360;
    const segG = (counts.Great   / totalJudged) * 360;
    const segO = (counts.Good    / totalJudged) * 360;
    const segM = (counts.Miss    / totalJudged) * 360;

    const pie = `conic-gradient(
      #25F4EE 0deg ${segP}deg,
      #C8FF4D ${segP}deg ${segP + segG}deg,
      #8A5CFF ${segP + segG}deg ${segP + segG + segO}deg,
      #aa4b5b ${segP + segG + segO}deg ${segP + segG + segO + segM}deg
    )`;

    el = document.createElement("div");
    el.id = overlayId;
    el.className = "pf-results-overlay";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Results");

    el.innerHTML = `
      <div class="pf-results-card">
        <div class="pf-results-left">
          <div class="pf-results-pie"></div>
        </div>
        <div class="pf-results-right">
          <div class="pf-results-title">Results</div>
          <div class="pf-results-metrics">
            <div class="pf-metric"><span class="muted">Score:</span> <b>${this.state.score.toLocaleString()}</b></div>
            <div class="pf-metric"><span class="muted">Accuracy:</span> <b>${accPct}%</b></div>
            <div class="pf-metric"><span class="muted">Max Combo:</span> <b>${this.maxCombo}x</b></div>
          </div>

          <div class="pf-results-chips">
            ${this._resultChip("#25F4EE","Perfect",counts.Perfect)}
            ${this._resultChip("#C8FF4D","Great",counts.Great)}
            ${this._resultChip("#8A5CFF","Good",counts.Good)}
            ${this._resultChip("#aa4b5b","Miss",counts.Miss)}
          </div>

          <div id="pf-lb-block" class="pf-lb-block">
            <div class="pf-lb-title">Leaderboard</div>
            <div id="pf-lb-projected" class="muted pf-lb-line">Projected rank: <b>…</b></div>
            <div id="pf-lb-official" class="muted pf-lb-line">Official rank: <b>…</b></div>
          </div>

          <div class="pf-actions">
            <button id="pf-results-close" class="primary">Close</button>
          </div>
        </div>
      </div>
    `;

    // Apply dynamic styles via CSS variables
    try {
      const pieEl = el.querySelector('.pf-results-pie');
      if (pieEl) pieEl.style.setProperty('--pf-pie', pie);
    } catch {}

    const closeOverlay = () => {
      try { document.removeEventListener('keydown', onKeyDown, true); } catch {}
      el.remove();
      try { this._resultsCloseResolver?.(); } catch {}
      this._resultsCloseResolver = null;
    };

    const onKeyDown = (e) => {
      if ((e.key || e.code) === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        closeOverlay();
      }
    };

    el.addEventListener('click', (e) => {
      if (e.target === el) closeOverlay();
    });
    try { document.addEventListener('keydown', onKeyDown, true); } catch {}

    el.querySelector("#pf-results-close")?.addEventListener("click", () => closeOverlay());

    document.body.appendChild(el);
    this._resultsOverlay = el;
    // Focus the close button for accessibility
    try { el.querySelector('#pf-results-close')?.focus?.(); } catch {}
  }

  _setProjectedRankText(text) {
    const el = this._resultsOverlay?.querySelector("#pf-lb-projected");
    if (el) el.innerHTML = `Projected rank: <b>${text}</b>`;
  }
  _setOfficialRankText(text) {
    const el = this._resultsOverlay?.querySelector("#pf-lb-official");
    if (el) el.innerHTML = `Official rank: <b>${text}</b>`;
  }

  _resultChip(color, label, value) {
    const safeColor = String(color || '#25F4EE');
    return `<div class="pf-chip" style="--pf-chip-dot:${safeColor};">
      <div class="pf-chip-head">
        <span class="pf-chip-dot"></span>
        <span class="pf-chip-label">${label}</span>
      </div>
      <div class="pf-chip-value">${value}</div>
    </div>`;
  }

  // ===== Leaderboard helpers =====
  async _snapshotLeaderboardBefore() {
    try {
      const rows = await this._fetchLeaderboard(200);
      const me = this._findMe(rows);
      this._lbBefore = {
        pbScore: me?.score ?? null,
        rank: me ? (rows.indexOf(me) + 1) : null
      };
    } catch {
      this._lbBefore = { pbScore: null, rank: null };
    }
  }

  _compareRows(a, b) {
    if (a.score !== b.score) return b.score - a.score;
    if (a.acc !== b.acc) return b.acc - a.acc;
    if (a.combo !== b.combo) return b.combo - a.combo;
    return 0;
  }

  _projectRank(rows, myRow) {
    let rank = 1;
    for (const r of rows) {
      if (this._compareRows(r, myRow) < 0) break;
      if (this._compareRows(r, myRow) > 0) rank++;
      else rank++;
    }
    return Math.max(1, rank);
  }

  async _reportScoreAndNotify() {
    const isEditorPreview =
      this.runtime?.isEditorPreview === true ||
      (this.chart?.title === "Editor Preview") ||
      (this.chart?.trackId === "editor-preview");

    if (this.runtime?.autoSubmit === false || isEditorPreview) {
      try {
        this._setProjectedRankText("—");
        this._setOfficialRankText("—");
      } catch {}
      return;
    }

    const name = this._getUserName();
    const trackId =
      this.chart?.trackId ||
      this.runtime?.track?.trackId ||
      (this.chart?.title || "unknown")
        .toString()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-");
    const difficulty = this.chart?.difficulty || this.runtime?.difficulty || "normal";

    const payload = {
      trackId,
      difficulty,
      name,
      score: this.state.score,
      acc: Number(this.state.acc || 0),
      combo: this.maxCombo || this.state.combo || 0
    };

    try {
      const rows = await this._fetchLeaderboard(200);
      const myRow = { name, score: payload.score, acc: payload.acc, combo: payload.combo };
      const sorted = rows.slice().sort((a, b) => this._compareRows(a, b));
      const projected = this._projectRank(sorted, myRow);
      this._lbProjected = { rank: projected };
      this._setProjectedRankText(`#${projected} (estimated)`);
    } catch {
      this._setProjectedRankText(`—`);
    }

    let serverNewRank = null, serverTotal = null;
    try {
      const res = await fetch("/api/leaderboard/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (Number.isFinite(data?.rank)) serverNewRank = Number(data.rank);
        if (Number.isFinite(data?.total)) serverTotal = Number(data.total);
      }
    } catch {}

    try {
      const rows = await this._fetchLeaderboard(200);
      const me = this._findMe(rows);
      this._lbAfter = {
        pbScore: me?.score ?? null,
        rank: serverNewRank ?? (me ? (rows.indexOf(me) + 1) : null),
        total: serverTotal ?? rows.length
      };
    } catch {}

    if (Number.isFinite(this._lbAfter.rank)) {
      const t = Number.isFinite(this._lbAfter.total)
        ? `#${this._lbAfter.rank} of ${this._lbAfter.total}`
        : `#${this._lbAfter.rank}`;
      this._setOfficialRankText(t);
    } else {
      this._setOfficialRankText("—");
    }

    const rankBefore = this._lbBefore.rank;
    const rankAfter  = this._lbAfter.rank;
    if (Number.isFinite(rankBefore) && Number.isFinite(rankAfter)) {
      const moved = rankBefore - rankAfter;
      if (moved > 0) {
        this._toast(`⬆ Up ${moved} place${moved === 1 ? "" : "s"} (now #${rankAfter})`, "info");
      }
    }
  }

  async _fetchLeaderboard(limit = 50) {
    const trackId = this.chart?.trackId || this.runtime?.track?.trackId || (this.chart?.title || "unknown").toString().toLowerCase().replace(/[^a-z0-9]+/g,"-");
    const diff = this.chart?.difficulty || this.runtime?.difficulty || "normal";
    const url = `/api/leaderboard/${encodeURIComponent(trackId)}?diff=${encodeURIComponent(diff)}&limit=${encodeURIComponent(limit)}`;
    const rows = await fetch(url).then(r => r.json());
    return Array.isArray(rows) ? rows : [];
  }

  _findMe(rows) {
    const my = (this._getUserName() || "").trim().toLowerCase();
    if (!my) return null;
    return rows.find(r => (String(r?.name || "").trim().toLowerCase() === my)) || null;
  }

  _getUserName() {
    const n1 = (this.settings?.name || "").trim();
    if (n1) return n1;
    try {
      const s = JSON.parse(localStorage.getItem("pf-settings") || "{}");
      if (s?.name && String(s.name).trim()) return String(s.name).trim();
    } catch {}
    return "Player";
  }

  _ensureToastHolder() {
    if (document.getElementById("pf-toast-holder")) return;
    const wrap = document.createElement("div");
    wrap.id = "pf-toast-holder";
    Object.assign(wrap.style, {
      position: "fixed",
      left: "50%",
      bottom: "24px",
      transform: "translateX(-50%)",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      zIndex: "3000",
      pointerEvents: "none"
    });
    document.body.appendChild(wrap);
  }

  _toast(text, type = "info") {
    const holder = document.getElementById("pf-toast-holder");
    if (!holder) return;

    const el = document.createElement("div");
    const bg = type === "success" ? "#0f2c2c" : "#0e1a2a";
    const border = type === "success" ? "#23d3cf" : "#25f4ee";
    Object.assign(el.style, {
      background: bg,
      border: `1px solid ${border}`,
      color: "#e8eefc",
      padding: "10px 14px",
      borderRadius: "10px",
      boxShadow: "0 6px 20px rgba(0,0,0,.28)",
      fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto",
      fontSize: "14px",
      letterSpacing: ".2px",
      opacity: "0",
      transform: "translateY(6px)",
      transition: "opacity 140ms ease-out, transform 140ms ease-out",
      pointerEvents: "none"
    });
    el.textContent = text;
    holder.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = "1";
      el.style.transform = "translateY(0)";
    });
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateY(6px)";
      setTimeout(() => el.remove(), 260);
    }, 2600);
  }

  // Helpers for results-close synchronization
  _setResultsCloseResolver(fn) {
    this._resultsCloseResolver = fn;
  }
  async _waitForResultsClose() {
    // If overlay already closed (or never created), resolve immediately
    if (!document.getElementById("pf-results-overlay")) return;
    await new Promise(res => {
      this._resultsCloseResolver = () => { try { res(); } catch {} };
    });
  }

  _laneX(idx) { return this.startX + idx * (this.laneWidth + this.laneGap); }

  // Helper: find active-hold record for a body sprite (if any)
  _holdInfoForSprite(bodySprite) {
    if (!bodySprite) return null;
    for (const [, rec] of this.activeHoldsByLane) {
      if (rec && rec.bodyRef === bodySprite) return rec;
    }
    return null;
  }
}
