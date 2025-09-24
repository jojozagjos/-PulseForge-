/* global PIXI */ 
import { AudioPlayer } from "./audio.js";

/** Timing windows (ms) */
const PERFECT_MS = 30;
const GREAT_MS   = 65;
const GOOD_MS    = 100;

/** Visual tuning */
const WHITE_FLASH_MS = 140;      // taps only
const HIT_FADE_RATE  = 0.05;
const MISS_FADE_RATE = 0.08;
const HOLD_BODY_FADE = 0.06;

/** Visual options */
const VIS = {
  laneColors: [0x19cdd0, 0x8A5CFF, 0xC8FF4D, 0xFFA94D], // teal, purple, lime, orange
  showHitWindows: true,
  receptorGlow: true,
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

    // For restoring global key handlers
    this._prevOnKeyDown = undefined;
    this._prevOnKeyUp = undefined;
  }

  async run() {
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

    const clampRes = Math.max(1, Math.min(this.settings.renderScale || 1, (window?.devicePixelRatio || 1)));

    // New PIXI app each run
    this.app = new PIXI.Application();
    await this.app.init({
      canvas: this.canvas,
      width: this.width,
      height: this.height,
      antialias: false,
      background: 0x0a0c10,
      resolution: clampRes,
      powerPreference: "high-performance"
    });
    this.app.ticker.maxFPS = this.settings.maxFps || 120;
    this.app.ticker.minFPS = this.settings.minFps || 50;

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

    try { this.activeHoldsByLane?.clear?.(); } catch {}
  }

  _applyVolume(player) {
    const v = Math.max(0, Math.min(1, Number(this.settings?.volume ?? 1)));
    if (typeof player.setMasterVolume === "function") player.setMasterVolume(v);
  }

  _buildScene() {
    this.app.stage.sortableChildren = true;
    // Subtle grid (behind everything)
    const grid = new PIXI.Graphics();
    grid.alpha = 0.22;
    for (let i = 0; i < 44; i++) { grid.moveTo(0, i * 18); grid.lineTo(this.width, i * 18); }
    this.app.stage.addChild(grid);
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
    this.app.stage.addChild(this.laneBackboardLayer);

    for (let i = 0; i < this.laneCount; i++) {
      const g = new PIXI.Graphics();
      g.roundRect(this._laneX(i), this._laneTop, this.laneWidth, this._laneHeight, 18);
      g.fill({ color: 0x0f1420 });
      g.stroke({ width: 2, color: 0x2a3142 });
      g.alpha = 0.95;
      this.laneBackboardLayer.addChild(g);
      if ("cacheAsBitmap" in g) g.cacheAsBitmap = true;
    }

    // Judge line + halo
    this.judgeStatic = new PIXI.Container();
    this.judgeStatic.zIndex = 3;
    this.app.stage.addChild(this.judgeStatic);
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

    // Note containers with per-lane masks
    this.noteLayer = new PIXI.Container();
    this.noteLayer.zIndex = 4;
    this.app.stage.addChild(this.noteLayer);

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
      this.app.stage.addChild(mask);

      this.laneNoteLayers[i] = laneCont;
      this.laneMasks[i] = mask;
    }

    // Receptors
    this.receptorLayer = new PIXI.Container();
    this.receptorLayer.zIndex = 6;
    this.app.stage.addChild(this.receptorLayer);

    this.receptors = [];
    for (let i = 0; i < this.laneCount; i++) {
      const laneCenterX = this._laneX(i) + this.laneWidth / 2;
      const rec = new PIXI.Container();
      rec.x = laneCenterX;
      rec.y = this.judgeY;
      rec.alpha = 0.95;

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

      rec.__glow = glow;
      rec.__pulse = 0;
      this.receptorLayer.addChild(rec);
      this.receptors.push(rec);
    }

    // FX
    this.fxRingLayer = this._makeFxRingLayer();
    this.fxRingLayer.zIndex = 7;
    this.app.stage.addChild(this.fxRingLayer);

    this.fxTextLayer = new PIXI.Container();
    this.fxTextLayer.zIndex = 7;
    this.app.stage.addChild(this.fxTextLayer);

    // HUD (external counters if present)
    this.$combo = document.getElementById("hud-combo");
    this.$acc = document.getElementById("hud-acc");
    this.$score = document.getElementById("hud-score");

    // Progress bar
    this._buildProgressBar(totalW);

    // Text styles
    this._fxStyles = {
      Perfect: new PIXI.TextStyle({
        fill: 0x25F4EE, fontSize: 36, fontFamily: "Arial", fontWeight: "bold",
        dropShadow: true, dropShadowColor: "#000000", dropShadowBlur: 3, dropShadowDistance: 2
      }),
      Great: new PIXI.TextStyle({
        fill: 0xC8FF4D, fontSize: 36, fontFamily: "Arial", fontWeight: "bold",
        dropShadow: true, dropShadowColor: "#000000", dropShadowBlur: 3, dropShadowDistance: 2
      }),
      Good: new PIXI.TextStyle({
        fill: 0x8A5CFF, fontSize: 36, fontFamily: "Arial", fontWeight: "bold",
        dropShadow: true, dropShadowColor: "#000000", dropShadowBlur: 3, dropShadowDistance: 2
      }),
      Miss: new PIXI.TextStyle({
        fill: 0xaa4b5b, fontSize: 36, fontFamily: "Arial", fontWeight: "bold",
        dropShadow: true, dropShadowColor: "#000000", dropShadowBlur: 3, dropShadowDistance: 2
      }),
      Countdown: new PIXI.TextStyle({
        fill: 0x25F4EE, fontSize: 48, fontFamily: "Arial", fontWeight: "bold",
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

    // Ensure all layers sort their children predictably by zIndex
    ;[this.laneBackboardLayer, this.judgeStatic, this.noteLayer, this.receptorLayer, this.fxRingLayer, this.fxTextLayer, this.hudLayer]
      .forEach(c => { try { if (c) c.sortableChildren = true; } catch {} });
  }

  _buildProgressBar(totalW) {
    const barW = totalW + 80;
    const barH = 6;
    const x = this.startX - 40;
    const y = this.height - 32;

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
    this._applyVolume(player);
    await player.load(manifest.audioUrl);

    // Clone so we never mutate the editor’s objects
    this.chart = {
      ...manifest,
      notes: Array.isArray(manifest.notes) ? manifest.notes.map(n => ({ ...n })) : []
    };

    // honor editor playhead offset (runtime.startAtMs) by trimming notes/time
    const offsetMs = Math.max(0, Number(this.runtime?.startAtMs) || 0);
    if (offsetMs > 0) this._applyStartOffset(offsetMs);

    // build & inputs
    this._resetNoteRuntimeFlags();
    this._prepareNotes();
    this._prepareInputs();
    await this._snapshotLeaderboardBefore();

    // Visual & audio start
    const visualStartPerfMs = performance.now() + this.leadInMs;
    const audioStartAtSec = player.ctx.currentTime + (this.leadInMs / 1000);

    // NOTE: if your AudioPlayer.playAt doesn't support offset, update it accordingly.
    const source = player.playAt(audioStartAtSec, { offsetSec: offsetMs / 1000 });

    // loop
    await this._gameLoop(visualStartPerfMs, () => {});
    await this._reportScoreAndNotify();

    // wait for user to close the results before returning control
    await this._waitForResultsClose();

    source.stop();
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
      if (vis.body) {
        vis.body.texture = this._getBodyTexture(vis.body.__pfLen, true);
        vis.body.tint = 0xFFFFFF;
        vis.body.alpha = 0.95;
      }

      vis.head.__pfHoldActive = true;
      if (vis.body) vis.body.__pfHoldActive = true;

      const endMs = (note.tMs || 0) + (note.dMs || 0);
      this.activeHoldsByLane.set(lane, {
        endMs,
        broken: false,
        headRef: vis.head,
        bodyRef: vis.body
      });

      // Head flash then fade
      const until = (this.state.timeMs || 0) + WHITE_FLASH_MS;
      vis.head.__pfFlashUntil = until;
      vis.head.__pfFadeRate   = HIT_FADE_RATE;

    } else {
      // Tap: brief head white flash
      this._paintHeadWhite(vis.head);
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
      try { this.app?.stage?.addChild?.(this.fxRingLayer); } catch {}
    } else {
      try { this.fxRingLayer.removeChildren(); } catch {}
    }

    // fx text layer
    if (!this.fxTextLayer) {
      this.fxTextLayer = new PIXI.Container();
      this.fxTextLayer.zIndex = 7;
      try { this.app?.stage?.addChild?.(this.fxTextLayer); } catch {}
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
      head.tint = this.vis.laneColors[n.lane % this.vis.laneColors.length];

      // optional gloss
      let gloss = null;
      if (this._texCache.headGloss) {
        gloss = new PIXI.Sprite(this._texCache.headGloss);
        gloss.alpha = 0.45;
      }

      // place in lane container
      cont.x = this._laneX(n.lane) + (this.laneWidth - headW) / 2;
      cont.y = -60;

      let body = null;
      if (isHold) {
        const lengthPx = Math.max(10, n.dMs * this.pixelsPerMs);
        body = new PIXI.Sprite(this._getBodyTexture(lengthPx, false));
        const stemX = (headW - 12) / 2;
        body.x = stemX;
        body.y = -(lengthPx - 2);
        body.tint = this.vis.laneColors[n.lane % this.vis.laneColors.length];
        body.alpha = 1.0;
        body.__pfLen = lengthPx;
        body.__pfHoldActive = false;

        if (this.holdTailClipsAtJudge) {
          const bm = new PIXI.Graphics();
          bm.isMask = true;
          body.mask = bm;
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

      this.laneNoteLayers[n.lane].addChild(cont);
      const rec = { cont, head, body, n, gloss };
      this.spriteByNote.set(n, rec);
      return rec;
    });

    // Canvas countdown helpers
    const showCountdown = (msLeft) => {
      const sLeft = Math.ceil(msLeft / 1000);
      this.countdownText.text = sLeft > 0 ? String(sLeft) : "Go!";
      this.countdownText.alpha = 1;
    };
    const hideCountdown = () => { if (this.countdownText) this.countdownText.alpha = 0; };

    return await new Promise(resolve => {
      this.app.ticker.add(() => {
        const nowPerf = performance.now();
        const tMs = nowPerf - startPerfMs;
        this.state.timeMs = tMs;

        if (tMs < 0) {
          showCountdown(-tMs);
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

        // Receptor glow decay
        for (let i = 0; i < this.receptors.length; i++) {
          const rec = this.receptors[i];
          if (!rec) continue;
          if (rec.__pulse > 0) {
            const t = rec.__pulse;
            const scale = 1.0 + 0.12 * Math.sin((Math.PI * t) / 10);
            rec.scale.set(scale, scale);
            rec.__glow.alpha = Math.max(0, rec.__glow.alpha - 0.06);
            rec.__pulse--;
          } else {
            rec.scale.set(1, 1);
            rec.__glow.alpha = Math.max(0, rec.__glow.alpha - 0.06);
          }
        }

        // ===== Notes =====
        for (let i = 0; i < this.noteSprites.length; i++) {
          const obj = this.noteSprites[i];
          const { n, cont, body, head, gloss } = obj;
          if (!cont.parent && (!body || !body.parent)) continue;

          // Position so head center hits judge line at n.tMs
          const yAtCenter = this.judgeY - (n.tMs - tMs) * this.pixelsPerMs;
          const y = yAtCenter - (head.height / 2);
          if (cont.parent) cont.y = y;

          // Tap miss: after window passes, mark miss and fade head
          if (tMs >= 0 && !n.hit && (!body)) {
            if (tMs - n.tMs > 120) {
              n.hit = true;
              this.state.combo = 0;
              this._recordJudge("Miss");
              this._judgment("Miss", true);
              head && this._beginFadeOut(head, MISS_FADE_RATE, false);
            }
          }

          // Update per-note hold mask (only in judge-clip mode)
          if (body && this.holdTailClipsAtJudge && body.__pfMask) {
            const localJudge = cont.toLocal(new PIXI.Point(0, this.judgeY));
            const cutY = localJudge.y;

            body.__pfMask.clear();
            const stemX = body.x - 4;
            body.__pfMask.rect(stemX, -50000, 24, cutY + 50000);
            body.__pfMask.fill(0xffffff);
            body.__pfMask.isMask = true;
          }

          // compute full visual bounds (head + tail)
          const headTop = cont.y;
          const headBottom = cont.y + head.height;
          let topY = headTop;
          let bottomY = headBottom;

          if (body) {
            const bodyTop = cont.y - (body.__pfLen - 2);
            let bodyBottom = cont.y; // where tail meets head
            if (this.holdTailClipsAtJudge) {
              bodyBottom = Math.min(bodyBottom, this.judgeY);
            }
            topY = Math.min(topY, bodyTop);
            bottomY = Math.max(bottomY, bodyBottom);
          }

          // lane's visual bottom
          const laneBottom = this._laneTop + this._laneHeight;

          // Only cull once the entire note is past the bottom
          const fullyBelowLane = topY > (laneBottom + 80);
          if (fullyBelowLane) {
            if (body?.__pfMask) { body.mask = null; body.__pfMask.removeFromParent(); }
            cont.parent?.removeChild(cont);
            continue;
          }

          // End of head flash -> begin head fade
          const now = tMs;
          if (head.__pfFlashUntil && now >= head.__pfFlashUntil) {
            head.__pfFlashUntil = null;
            if (!head.__pfFade) this._beginFadeOut(head, head.__pfFadeRate, false);
          }

          // Per-frame fading
          if (head.parent && head.__pfFade) {
            head.alpha = Math.max(0, head.alpha - head.__pfFade.rate);
          }
          if (body && body.__pfFade) {
            body.alpha = Math.max(0, body.alpha - body.__pfFade.rate);
            if (body.alpha <= 0.01 && body.__pfFade.remove) {
              if (body.__pfMask) { body.mask = null; body.__pfMask.removeFromParent(); }
              body.removeFromParent();
              obj.body = null;
            }
          }

          // Optional gloss near judge line
          if (gloss) {
            const dy = Math.abs(this.judgeY - (y + head.height / 2));
            gloss.alpha = Math.min(gloss.alpha, head.alpha);
            gloss.visible = dy < 420 && head.alpha > 0.05;
          }

          // Hold miss at head
          if (body && !n.hit && (tMs - n.tMs > 120)) {
            n.hit = true;
            this.state.combo = 0;
            this._recordJudge("Miss");
            this._judgment("Miss", true);
            this._beginFadeOut(head, MISS_FADE_RATE, false);
            body.__pfHoldActive = false;
            this._beginFadeOut(body, MISS_FADE_RATE, true);
          }
        }

        // Maintain active holds (success/early release)
        if (tMs >= 0) {
          for (const [lane, hold] of this.activeHoldsByLane) {
            if (hold.broken) continue;
            if (tMs < hold.endMs) {
              if (!this.held[lane]) {
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
            } else {
              if (hold.bodyRef) {
                hold.bodyRef.__pfHoldActive = false;
                this._beginFadeOut(hold.bodyRef, HOLD_BODY_FADE, true);
              }
              if (hold.headRef) {
                hold.headRef.__pfHoldActive = false;
                this._beginFadeOut(hold.headRef, HIT_FADE_RATE, false);
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
    console.warn("[PulseForge] ParticleContainer not available; using PIXI.Container for FX.");
    return new PIXI.Container();
  }

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
    if (this.vis.receptorGlow) rec.__glow.alpha = 0.22 * strength;
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
    Object.assign(el.style, {
      position: "absolute",
      inset: "0",
      background: "linear-gradient(0deg, rgba(10,12,16,.86), rgba(10,12,16,.86))",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "2000",
      color: "#e8eefc",
      fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto"
    });

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:220px 1fr;gap:20px;max-width:860px;width:92%;border:1px solid #2a3142;border-radius:14px;padding:20px;background:#111827cc;backdrop-filter:blur(4px);">
        <div style="display:flex;align-items:center;justify-content:center;">
          <div style="width:180px;height:180px;border-radius:999px;background:${pie};box-shadow:inset 0 0 0 8px rgba(255,255,255,0.06);"></div>
        </div>
        <div>
          <div style="font-size:22px;font-weight:700;margin-bottom:8px;">Results</div>
          <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px;">
            <div><span style="opacity:.9;">Score:</span> <b>${this.state.score.toLocaleString()}</b></div>
            <div><span style="opacity:.9;">Accuracy:</span> <b>${accPct}%</b></div>
            <div><span style="opacity:.9;">Max Combo:</span> <b>${this.maxCombo}x</b></div>
          </div>

          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px;">
            ${this._resultChip("#25F4EE","Perfect",counts.Perfect)}
            ${this._resultChip("#C8FF4D","Great",counts.Great)}
            ${this._resultChip("#8A5CFF","Good",counts.Good)}
            ${this._resultChip("#aa4b5b","Miss",counts.Miss)}
          </div>

          <div id="pf-lb-block" style="border:1px solid #233046;border-radius:10px;padding:10px 12px;background:#0f1420;margin-bottom:16px;">
            <div style="font-weight:700;margin-bottom:6px;">Leaderboard</div>
            <div id="pf-lb-projected" class="muted" style="margin-bottom:4px;">Projected rank: <b>…</b></div>
            <div id="pf-lb-official" class="muted">Official rank: <b>…</b></div>
          </div>

          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button id="pf-results-close" class="primary" style="padding:8px 14px;background:#25f4ee;border:none;border-radius:10px;color:#00222a;font-weight:700;cursor:pointer;">Close</button>
          </div>
        </div>
      </div>
    `;

    el.querySelector("#pf-results-close")?.addEventListener("click", () => {
      el.remove();
      // tell the loop/caller we’re done
      try { this._resultsCloseResolver?.(); } catch {}
      this._resultsCloseResolver = null;
    });

    document.body.appendChild(el);
    this._resultsOverlay = el;
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
    return `<div style="border:1px solid ${'#2a3142'};border-radius:10px;padding:10px;background:#0f1420;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};"></span>
        <span style="opacity:.9">${label}</span>
      </div>
      <div style="font-size:18px;font-weight:700;">${value}</div>
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
