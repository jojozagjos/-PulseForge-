// public/js/modules/game.js
import { AudioPlayer } from "./audio.js";

/** Timing windows (ms) */
const PERFECT_MS = 30;
const GREAT_MS   = 65;
const GOOD_MS    = 100;

/** Visual tuning */
const WHITE_FLASH_MS = 140;      // taps only
const HIT_FADE_RATE  = 0.05;
const MISS_FADE_RATE = 0.10;
const HOLD_BODY_FADE = 0.06;

/** Visual options */
const VIS = {
  laneColors: [0x19cdd0, 0x8A5CFF, 0xC8FF4D, 0xFFA94D], // teal, purple, lime, orange
  showHitWindows: true,   // translucent guides around the judge line
  receptorGlow: true,     // glow pulse on key press and on hit
  ringOnHit: true         // expanding ring on Great/Perfect
};

export class Game {
  constructor(runtime, settings) {
    this.runtime = runtime;
    this.settings = settings || {};

    // Find or create canvas safely
    this.canvas = document.getElementById("game-canvas");
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.canvas.id = "game-canvas";
      Object.assign(this.canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%" });
      document.body.appendChild(this.canvas);
    }

    // Window-based size; never read clientWidth here
    const w = typeof window !== "undefined" ? (window.innerWidth || 1280) : 1280;
    const h = typeof window !== "undefined" ? (window.innerHeight || 720) : 720;
    this.width  = Math.max(960, Math.min(Math.floor(w), 1920));
    this.height = Math.max(540, Math.min(Math.floor(h), 1080));

    // Core state
    this.app = null;
    this.state = {
      score: 0, combo: 0, total: 0, hits: 0, acc: 1, nextIdx: 0, timeMs: 0,
      judges: { Perfect: 0, Great: 0, Good: 0, Miss: 0 }  // NEW: judgment counters
    };
    this.maxCombo = 0;

    // Tuning
    this.leadInMs = 3000;
    this.pixelsPerMs = 0.35;

    // Inputs / holds
    this.keyDown = new Set();
    this.held = []; // lane-held booleans set in _buildScene/_prepareInputs
    // lane -> { endMs, broken, headRef, bodyRef }
    this.activeHoldsByLane = new Map();

    // Layers / HUD refs
    this.noteLayer = null;
    this.$combo = null;
    this.$acc = null;
    this.$score = null;
    this.$judge = null;

    // NEW: split FX into ring (ParticleContainer) + text (Container)
    this.fxRingLayer = null;
    this.fxTextLayer = null;

    // NEW: progress bar pieces
    this.progressBg = null;
    this.progressFill = null;
    this._progressGeom = null; // cache dims

    this.spriteByNote = new Map();

    // Caches, pools, and visual elements
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
    this.receptors = [];   // per-lane receptors at the judge line
    this.judgeStatic = null;
    this.receptorLayer = null;
    this._ringTex = null;  // cached ring texture for hit FX

    // Per-lane note indices for hit scanning
    this.notesByLane = [];
    this.nextIdxByLane = [];

    // NEW: ensure we only show results overlay once
    this._resultsShown = false;
  }

  async run() {
    this.canvas.style.display = "block";
    // Clamp resolution to reduce fill-rate on high-DPI screens
    const clampRes = Math.max(
      1,
      Math.min(
        this.settings.renderScale || 1,
        (window?.devicePixelRatio || 1)
      )
    );

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
    this.app.ticker.minFPS = this.settings.minFps || 50; // NEW: clamp to avoid giant delta spikes

    this._buildScene();

    if (this.runtime.mode === "solo") await this._playSolo(this.runtime.manifest);
    else await this._playMp(this.runtime);

    // Return classic summary for outside UI
    return [
      { label: "Score", value: this.state.score.toString() },
      { label: "Accuracy", value: Math.round(this.state.acc * 100) + "%" },
      { label: "Max Combo", value: this.maxCombo || this.state.combo }
    ];
  }

  _applyVolume(player) {
    const v = Math.max(0, Math.min(1, Number(this.settings?.volume ?? 1)));
    if (typeof player.setMasterVolume === "function") player.setMasterVolume(v);
  }

  _ensureJudgmentElement() {
    let el = document.getElementById("judgment");
    if (!el) {
      el = document.createElement("div");
      el.id = "judgment";
      Object.assign(el.style, {
        position: "absolute",
        left: "50%",
        top: "18%",
        transform: "translate(-50%, -50%)",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto",
        fontSize: "48px",
        letterSpacing: "1px",
        color: "#25F4EE",
        textShadow: "0 2px 12px rgba(0,0,0,0.5)",
        opacity: "0",
        transition: "opacity 120ms ease-out, transform 120ms ease-out",
        pointerEvents: "none",
        zIndex: "1000"
      });
      document.body.appendChild(el);
    }
    this.$judge = el;
  }

  _buildScene() {
    // Subtle grid (static)
    const grid = new PIXI.Graphics();
    grid.alpha = 0.22;
    for (let i = 0; i < 44; i++) { grid.moveTo(0, i * 18); grid.lineTo(this.width, i * 18); }
    this.app.stage.addChild(grid);
    if ("cacheAsBitmap" in grid) grid.cacheAsBitmap = true;

    // Lanes
    this.laneCount = 4;
    this.held = new Array(this.laneCount).fill(false);
    this.laneWidth = Math.max(120, Math.min(180, Math.floor(this.width / 10)));
    this.laneGap = Math.max(18, Math.min(32, Math.floor(this.width / 70)));
    const totalW = this.laneCount * this.laneWidth + (this.laneCount - 1) * this.laneGap;
    this.startX = (this.width - totalW) / 2;

    // Higher judge line
    this.judgeY = this.height - 240;

    for (let i = 0; i < this.laneCount; i++) {
      const g = new PIXI.Graphics();
      g.roundRect(this.startX + i * (this.laneWidth + this.laneGap), 70, this.laneWidth, this.height - 260, 18);
      g.fill({ color: 0x0f1420 });
      g.stroke({ width: 2, color: 0x2a3142 });
      g.alpha = 0.95;
      this.app.stage.addChild(g);
      if ("cacheAsBitmap" in g) g.cacheAsBitmap = true;
    }

    // ===== Judge line (static) + receptors (dynamic) =====
    this.judgeStatic = new PIXI.Container();
    this.app.stage.addChild(this.judgeStatic);

    // Bright core line + faint halo
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

    // Per-lane receptors (tri-chevrons pointing to the line)
    this.receptorLayer = new PIXI.Container();
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

    // Notes and FX layers
    this.noteLayer = new PIXI.Container();
    this.app.stage.addChild(this.noteLayer);

    // NEW: tolerant to Pixi versions / missing plugin
    this.fxRingLayer = this._makeFxRingLayer();
    this.app.stage.addChild(this.fxRingLayer);

    // NEW: floating text FX in a separate container
    this.fxTextLayer = new PIXI.Container();
    this.app.stage.addChild(this.fxTextLayer);

    // HUD refs
    this.$combo = document.getElementById("hud-combo");
    this.$acc = document.getElementById("hud-acc");
    this.$score = document.getElementById("hud-score");

    this._ensureJudgmentElement();

    // NEW: progress bar (static bg + dynamic fill)
    this._buildProgressBar(totalW);

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
      })
    };
  }

  _buildProgressBar(totalW) {
    const barW = totalW + 80;
    const barH = 6;
    const x = this.startX - 40;
    const y = this.height - 32;

    this.progressBg = new PIXI.Graphics();
    this.progressBg.roundRect(x, y, barW, barH, 3);
    this.progressBg.fill({ color: 0xffffff, alpha: 0.08 });
    this.app.stage.addChild(this.progressBg);
    if ("cacheAsBitmap" in this.progressBg) this.progressBg.cacheAsBitmap = true;

    this.progressFill = new PIXI.Graphics();
    this.app.stage.addChild(this.progressFill);

    this._progressGeom = { x, y, barW, barH };
  }

  async _playSolo(manifest) {
    const player = new AudioPlayer();
    this._applyVolume(player);
    await player.load(manifest.audioUrl);
    this.chart = manifest;
    this._prepareNotes();
    this._prepareInputs();

    const audioStartAtSec = player.ctx.currentTime + this.leadInMs / 1000;
    const source = player.playAt(audioStartAtSec);

    const perfAtAudioZero = performance.now() - player.ctx.currentTime * 1000;
    const startPerfMs = perfAtAudioZero + audioStartAtSec * 1000;

    await this._gameLoop(startPerfMs, () => {});
    source.stop();
  }

  async _playMp(rt) {
    const track = rt.track;
    const diff = rt.difficulty || "normal";
    const chart = await fetch(track.charts[diff]).then(r => r.json());
    chart.audioUrl = track.audio?.wav || track.audio?.mp3;

    const player = new AudioPlayer();
    this._applyVolume(player);
    await player.load(chart.audioUrl);
    this.chart = chart;
    this._prepareNotes();
    this._prepareInputs();

    const delaySec = Math.max(0, rt.startAt ? (rt.startAt - Date.now()) / 1000 : 0);
    const audioStartAtSec = player.ctx.currentTime + delaySec;
    const source = player.playAt(audioStartAtSec);
    const startPerfMs = performance.now() + delaySec * 1000;

    await this._gameLoop(startPerfMs, null);
    source.stop();
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
      this._recordJudge("Miss"); // NEW: count miss
      this._judgment("Miss", true);
      if (hold.bodyRef) {
        hold.bodyRef.__pfHoldActive = false;
        this._beginFadeOut(hold.bodyRef, HOLD_BODY_FADE);
      }
      if (hold.headRef) {
        hold.headRef.__pfHoldActive = false;
        this._beginFadeOut(hold.headRef, MISS_FADE_RATE);
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
      else if (dt < -120) { break; } // too early for this lane
      else { idx = i + 1; continue; } // late, skip
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
    if (label === "Perfect" || label === "Great") {
      const cx = this._laneX(lane) + this.laneWidth / 2;
      this._spawnRing(cx, this.judgeY, lc);
    }

    // visuals for the actual note
    const vis = this.spriteByNote?.get(note);
    if (!vis) return;

    if (isHold) {
      // Start a hold: make white and keep it visible until end or early release
      this._paintHeadWhite(vis.head);
      if (vis.body) this._paintBodyWhite(vis, note);

      vis.head.__pfHoldActive = true;
      if (vis.body) vis.body.__pfHoldActive = true;

      // Do NOT set a timed flash/fade for holds; we keep them until endMs
      const endMs = (note.tMs || 0) + (note.dMs || 0);
      this.activeHoldsByLane.set(lane, {
        endMs,
        broken: false,
        headRef: vis.head,
        bodyRef: vis.body
      });
    } else {
      // Tap: brief white flash, then fade away
      this._paintHeadWhite(vis.head);
      const until = (this.state.timeMs || 0) + WHITE_FLASH_MS; // taps only
      vis.head.__pfFlashUntil = until;
      vis.head.__pfFadeRate = HIT_FADE_RATE;
      // taps don't have a body; nothing else to do
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

  _paintBodyWhite(vis, note) {
    const lengthPx = Math.max(10, (note.dMs || 0) * this.pixelsPerMs);
    vis.body.texture = this._getBodyTexture(lengthPx, true);
    vis.body.tint = 0xFFFFFF;
    vis.body.alpha = 1;
  }

  _beginFadeOut(displayObj, fadeRatePerFrame = HIT_FADE_RATE, removeWhenDone = true) {
    displayObj.__pfFade = { rate: fadeRatePerFrame, remove: removeWhenDone };
  }

  _judgment(label, miss = false) {
    this._ensureJudgmentElement();
    const el = this.$judge;
    if (el) {
      el.textContent = label;
      el.style.color = miss ? "#aa4b5b" : (label === "Perfect" ? "#25F4EE" : (label === "Great" ? "#C8FF4D" : "#8A5CFF"));
      el.style.opacity = "1";
      el.style.transform = "translate(-50%, 50%) scale(1.0)";
      requestAnimationFrame(() => {
        el.style.transform = "translate(-50%, 50%) scale(1.08)";
        el.style.opacity = "1";
        setTimeout(() => {
          el.style.opacity = "0";
          el.style.transform = "translate(-50%, 50%) scale(1.0)";
        }, 260);
      });
    }

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
    this.fxTextLayer.addChild(t); // NEW: goes to text layer
    t.__pfFade = { rate: 0.03, remove: true, pooled: true };
  }

  async _gameLoop(startPerfMs, tickHook) {
    this.noteLayer.removeChildren();
    this.fxRingLayer.removeChildren();
    this.fxTextLayer.removeChildren();
    this.spriteByNote.clear();

    // reset results flag/counters
    this._resultsShown = false;
    this.state.judges = { Perfect: 0, Great: 0, Good: 0, Miss: 0 };

    const headH = 32;
    const headW = Math.max(28, this.laneWidth - 16);
    this._ensureHeadTextures(headW, headH);

    this.noteSprites = this.chart.notes.map(n => {
      const cont = new PIXI.Container();
      const isHold = (n.dMs && n.dMs > 0);

      const head = new PIXI.Sprite(this._getHeadTexture(false));
      head.width = headW;
      head.height = headH;
      head.tint = this.vis.laneColors[n.lane % this.vis.laneColors.length];

      let gloss = null;
      if (this._texCache.headGloss) {
        gloss = new PIXI.Sprite(this._texCache.headGloss);
        gloss.alpha = 0.45;
      }

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
        body.alpha = 0.55;

        body.__pfLen = lengthPx;

        cont.addChild(body);
      }

      cont.addChild(head);
      if (gloss) cont.addChild(gloss);

      head.__pfFlashUntil = null;
      head.__pfFadeRate   = HIT_FADE_RATE;
      head.__pfHoldActive = false;

      if (body) {
        body.__pfFlashUntil = null;
        body.__pfFadeRate   = HOLD_BODY_FADE;
        body.__pfHoldActive = false;
      }

      this.noteLayer.addChild(cont);
      const rec = { cont, head, body, n, gloss };
      this.spriteByNote.set(n, rec);
      return rec;
    });

    const showCountdown = (msLeft) => {
      this._ensureJudgmentElement();
      const sLeft = Math.ceil(msLeft / 1000);
      this.$judge.style.color = "#25F4EE";
      this.$judge.textContent = sLeft > 0 ? String(sLeft) : "Go!";
      this.$judge.style.opacity = "1";
    };
    const hideCountdown = () => {
      if (this.$judge) this.$judge.style.opacity = "0";
    };

    const offscreenBottom = this.height + 120;
    const offscreenTop = -180;

    return await new Promise(resolve => {
      this.app.ticker.add(() => {
        const nowPerf = performance.now();
        const tMs = nowPerf - startPerfMs;
        this.state.timeMs = tMs;

        if (tMs < 0) showCountdown(-tMs); else hideCountdown();

        // ===== FX: text layer (float/fade) =====
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
        // ===== FX: ring layer (scale/fade) =====
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

        // Animate receptor glow pulses
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

          // Position so head CENTER crosses judge line exactly at n.tMs
          const yAtCenter = this.judgeY - (n.tMs - tMs) * this.pixelsPerMs;
          const y = yAtCenter - (head.height / 2);
          if (cont.parent) cont.y = y;

          // Time-based Miss for unhit taps (holds are judged on key press)
          if (tMs >= 0 && !n.hit) {
            if (tMs - n.tMs > 120) {
              n.hit = true;
              this.state.combo = 0;
              this._recordJudge("Miss"); // NEW: count miss
              this._judgment("Miss", true);
              cont.parent?.removeChild(cont);
              while (this.state.nextIdx < this.chart.notes.length && this.chart.notes[this.state.nextIdx].hit) this.state.nextIdx++;
              continue;
            }
          }
          
          // --- Compute full vertical bounds of this note first ---
          const bottomCullY = this.height + 80;

          let topY = cont.y;            // head top
          let bottomY = cont.y + headH; // head bottom

          if (body) {
            const len = body.__pfLen ?? Math.max(10, (n.dMs || 0) * this.pixelsPerMs);
            const bodyTop = cont.y - (len - 2);   // because body.y = -(len - 2)
            const bodyBottom = bodyTop + len;
            topY    = Math.min(topY, bodyTop);
            bottomY = Math.max(bottomY, bodyBottom);
          }

          // Cull only when the ENTIRE note (head + tail) is past the bottom edge
          if (cont.parent && topY > bottomCullY) {
            cont.parent.removeChild(cont);
            continue;
          }

          // Decide if we should skip heavy visuals this frame
          const farOff = (y < offscreenTop || y > offscreenBottom);

          // --- Heavy per-frame visuals only if near-ish screen ---
          if (!farOff) {
            // Timed flash -> fade
            const now = tMs;
            if (head.__pfFlashUntil && now >= head.__pfFlashUntil) {
              head.__pfFlashUntil = null;
              this._beginFadeOut(head, head.__pfFadeRate, true);
            }
            if (body && body.__pfFlashUntil && now >= body.__pfFlashUntil) {
              body.__pfFlashUntil = null;
              this._beginFadeOut(body, body.__pfFadeRate, true);
            }

            // Per-frame fade progression
            if (head.parent && head.__pfFade) {
              head.alpha = Math.max(0, head.alpha - head.__pfFade.rate);
              if (head.alpha <= 0.01) {
                if (head.__pfFade.remove) cont.parent?.removeChild(cont);
                head.__pfFade = null;
              }
            }
            if (body && body.parent && body.__pfFade) {
              body.alpha = Math.max(0, body.alpha - body.__pfFade.rate);
              if (body.alpha <= 0.01) {
                if (body.__pfFade.remove !== false) cont.removeChild(body);
                body.__pfFade = null;
              }
            }

            // Shimmer the gloss near the judge line
            if (gloss) {
              const dy = Math.abs(this.judgeY - (y + head.height / 2));
              gloss.alpha = 0.25 + Math.max(0, 0.35 - Math.min(0.35, dy / 400));
            }
          }
        }

        // Maintain active holds
        if (tMs >= 0) {
          for (const [lane, hold] of this.activeHoldsByLane) {
            if (hold.broken) continue;
            if (tMs < hold.endMs) {
              if (!this.held[lane]) {
                hold.broken = true;
                this.state.combo = 0;
                this._recordJudge("Miss"); // NEW: count miss
                this._judgment("Miss", true);
                if (hold.bodyRef) {
                  hold.bodyRef.__pfHoldActive = false;
                  this._beginFadeOut(hold.bodyRef, HOLD_BODY_FADE);
                }
                if (hold.headRef) {
                  hold.headRef.__pfHoldActive = false;
                  this._beginFadeOut(hold.headRef, MISS_FADE_RATE);
                }
                this.activeHoldsByLane.delete(lane);
              }
            } else {
              if (hold.bodyRef) {
                hold.bodyRef.__pfHoldActive = false;
                this._beginFadeOut(hold.bodyRef, HOLD_BODY_FADE);
              }
              if (hold.headRef) {
                hold.headRef.__pfHoldActive = false;
                this._beginFadeOut(hold.headRef, HIT_FADE_RATE);
              }
              this.activeHoldsByLane.delete(lane);
            }
          }
        }

        // HUD (only when changed)
        this.state.total = this.chart.notes.length;

        // Simple acc: hits/total (unchanged style)
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
          this.progressFill.fill({ color: 0xFFFFFF, alpha: 0.9 * p + 0.05 }); // was 0x25f4ee
        }

        if (tickHook) tickHook();

        const endMs = (this.chart.durationMs || 20000) + 1500;
        if (tMs > endMs) {
          if (!this._resultsShown) {
            this._resultsShown = true;
            this._showResultsOverlay(); // NEW: show in-game results
          }
          resolve();
        }
      });
    });
  }

  _laneX(idx) { return this.startX + idx * (this.laneWidth + this.laneGap); }

  // ======== Texture and pool helpers ========

  // Try to create a ParticleContainer (v4/v5/v6/v7 signatures). Fallback to Container.
  _makeFxRingLayer() {
    // Possible homes for ParticleContainer across Pixi versions/plugins
    const PC =
      PIXI.ParticleContainer ||
      (PIXI.particles && PIXI.particles.ParticleContainer) ||
      null;

    if (PC) {
      // v4–v6 style: new PC(maxSize, properties)
      try {
        return new PC(400, { scale: true, alpha: true, position: true, rotation: true, uvs: false });
      } catch (_) {
        // v7+ style: new PC({ maxSize, properties })
        try {
          return new PC({
            maxSize: 400,
            properties: { scale: true, alpha: true, position: true, rotation: true, uvs: false },
            roundPixels: true
          });
        } catch (_) {
          // fall through to Container
        }
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

    // Head gloss texture (cached)
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

  _getHeadTexture(white = false) {
    return white ? this._texCache.headWhite : this._texCache.headNormal;
  }

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
    rec.__pulse = Math.max(rec.__pulse, Math.floor(10 * strength)); // frames
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
    s.__pfScaleVel = 0.06;     // expand each frame
    s.__pfFade = { rate: 0.04, remove: true };
    this.fxRingLayer.addChild(s); // NEW: particle container
  }

  // ======== Results Overlay (HUD & results) ========
  _showResultsOverlay() {
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

    // Build a conic-gradient pie
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
      <div style="display:grid;grid-template-columns:220px 1fr;gap:20px;max-width:820px;width:90%;border:1px solid #2a3142;border-radius:14px;padding:20px;background:#111827cc;backdrop-filter:blur(4px);">
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
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button id="pf-results-close" class="primary" style="padding:8px 14px;background:#25f4ee;border:none;border-radius:10px;color:#00222a;font-weight:700;cursor:pointer;">Close</button>
          </div>
        </div>
      </div>
    `;

    el.querySelector("#pf-results-close")?.addEventListener("click", () => el.remove());
    document.body.appendChild(el);
  }

  _resultChip(color, label, value) {
    return `<div style="border:1px solid #2a3142;border-radius:10px;padding:10px;background:#0f1420;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};"></span>
        <span style="opacity:.9">${label}</span>
      </div>
      <div style="font-size:18px;font-weight:700;">${value}</div>
    </div>`;
  }
}

function pseudoHmac(message, secret) {
  const data = message + "|" + secret;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < data.length; i++) { h ^= data.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ("0000000" + (h >>> 0).toString(16)).slice(-8);
}
