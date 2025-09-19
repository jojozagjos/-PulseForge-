// public/js/modules/game.js
import { AudioPlayer } from "./audio.js";

/** Visual tuning */
const WHITE_FLASH_MS = 140;      // used for taps (not holds now)
const HIT_FADE_RATE  = 0.05;
const MISS_FADE_RATE = 0.10;
const HOLD_BODY_FADE = 0.06;

export class Game {
  constructor(runtime, settings) {
    this.runtime = runtime;
    this.settings = settings;

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
    this.state = { score: 0, combo: 0, total: 0, hits: 0, acc: 1, nextIdx: 0, timeMs: 0 };
    this.maxCombo = 0;

    // Tuning
    this.leadInMs = 3000;
    this.pixelsPerMs = 0.35;

    // Inputs / holds
    this.keyDown = new Set();
    // lane -> { endMs, broken, headRef, bodyRef }
    this.activeHoldsByLane = new Map();

    // Layers / HUD refs
    this.noteLayer = null;
    this.$combo = null;
    this.$acc = null;
    this.$score = null;
    this.$judge = null;
    this.fxLayer = null;
    this.spriteByNote = new Map();
  }

  async run() {
    this.canvas.style.display = "block";
    this.app = new PIXI.Application();
    await this.app.init({ canvas: this.canvas, width: this.width, height: this.height, antialias: true, background: 0x0a0c10 });
    this._buildScene();

    if (this.runtime.mode === "solo") await this._playSolo(this.runtime.manifest);
    else await this._playMp(this.runtime);

    return [
      { label: "Score", value: this.state.score.toString() },
      { label: "Accuracy", value: Math.round(this.state.acc * 100) + "%" },
      { label: "Max Combo", value: this.maxCombo || this.state.combo }
    ];
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
    // Subtle grid
    const grid = new PIXI.Graphics();
    grid.alpha = 0.22;
    for (let i = 0; i < 44; i++) { grid.moveTo(0, i * 18); grid.lineTo(this.width, i * 18); }
    this.app.stage.addChild(grid);

    // Lanes
    this.laneCount = 4;
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
    }

    const j = new PIXI.Graphics();
    j.moveTo(this.startX - 12, this.judgeY);
    j.lineTo(this.startX + totalW + 12, this.judgeY);
    j.stroke({ width: 4, color: 0x25f4ee });
    this.app.stage.addChild(j);

    // Notes layer
    this.noteLayer = new PIXI.Container();
    this.app.stage.addChild(this.noteLayer);

    // Floating FX layer (for animated judgments)
    this.fxLayer = new PIXI.Container();
    this.app.stage.addChild(this.fxLayer);

    // HUD refs
    this.$combo = document.getElementById("hud-combo");
    this.$acc = document.getElementById("hud-acc");
    this.$score = document.getElementById("hud-score");

    // Ensure DOM judgment element exists and is visible
    this._ensureJudgmentElement();
  }

  async _playSolo(manifest) {
    const player = new AudioPlayer();
    await player.load(manifest.audioUrl);
    this.chart = manifest;
    this._prepareInputs();

    const audioStartAtSec = player.ctx.currentTime + this.leadInMs / 1000;
    const source = player.playAt(audioStartAtSec);

    // Map WebAudio time to performance.now()
    const perfAtAudioZero = performance.now() - player.ctx.currentTime * 1000;
    const startPerfMs = perfAtAudioZero + audioStartAtSec * 1000;

    await this._gameLoop(startPerfMs, () => {});
    source.stop();
  }

  async _playMp(rt) {
    const track = rt.track;
    const diff = rt.difficulty || "normal";
    const chart = await fetch(track.charts[diff]).then(r => r.json());
    chart.audioUrl = track.audio.wav || track.audio.mp3;
    this.chart = chart;

    const player = new AudioPlayer();
    await player.load(chart.audioUrl);
    this._prepareInputs();

    const nowEpoch = Date.now();
    const delaySec = Math.max(0.05, (rt.startAt - nowEpoch) / 1000);
    const audioStartAtSec = player.ctx.currentTime + delaySec;
    const source = player.playAt(audioStartAtSec);
    const startPerfMs = performance.now() + delaySec * 1000;

    const secret = rt.secret, socket = rt.socket, roomCode = rt.roomCode;
    let lastSent = 0;
    const sendBundle = () => {
      const t = Date.now(); if (t - lastSent < 120) return; lastSent = t;
      const bundle = { t, acc: this.state.acc, score: this.state.score, combo: this.state.combo };
      bundle.mac = pseudoHmac(JSON.stringify({ t: bundle.t, acc: bundle.acc, score: bundle.score, combo: bundle.combo }), secret);
      socket.emit("playEvent", { code: roomCode, bundle });
    };

    await this._gameLoop(startPerfMs, sendBundle);
    source.stop(); socket.emit("complete", { code: roomCode });
  }

  _prepareInputs() {
    const keys = this.settings.keys || ["D", "F", "J", "K"];
    const map = {}; for (let i = 0; i < keys.length; i++) map[keys[i].toUpperCase()] = i;
    this.keyMap = map;

    window.onkeydown = e => {
      const k = (e.key || "").toUpperCase(); if (!(k in map)) return;
      if (this.keyDown.has(k)) return;
      this.keyDown.add(k);
      this._attemptHit(map[k], true);
    };
    window.onkeyup = e => {
      const k = (e.key || "").toUpperCase(); if (!(k in map)) return;
      this.keyDown.delete(k);
      this._attemptHoldRelease(map[k]);
    };
  }

  _attemptHoldRelease(lane) {
    if (this.state.timeMs < 0) return;
    const nowMs = this.state.timeMs + (this.settings.latencyMs || 0);
    const hold = this.activeHoldsByLane.get(lane);
    if (!hold || hold.broken) return;

    // Early release -> break hold and fade both parts
    if (nowMs < hold.endMs - 80) {
      hold.broken = true;
      this.state.combo = 0;
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
    // Releasing after tail is okay; completion handled in loop.
  }

  _attemptHit(lane, isDown) {
    if (!isDown) return;
    if (this.state.timeMs < 0) return;
    const nowMs = this.state.timeMs + (this.settings.latencyMs || 0);

    for (let i = this.state.nextIdx; i < this.chart.notes.length; i++) {
      const n = this.chart.notes[i]; if (n.hit) continue; if (n.lane !== lane) continue;
      const dt = nowMs - n.tMs, adt = Math.abs(dt);
      const isHold = (n.dMs && n.dMs > 0);

      if (adt <= 30) this._registerHit(n, lane, "Perfect", isHold);
      else if (adt <= 65) this._registerHit(n, lane, "Great", isHold);
      else if (adt <= 100) this._registerHit(n, lane, "Good", isHold);
      else if (dt < -120) { break; }
      else { continue; }
      return;
    }

    this.state.combo = 0;
    this._judgment("Miss", true);
  }

  _registerHit(note, lane, label, isHold) {
    note.hit = true;
    const base = label === "Perfect" ? 100 : label === "Great" ? 80 : 50;
    this.state.score += base + Math.floor(this.state.combo * 0.1);
    this.state.combo += 1;
    this.maxCombo = Math.max(this.maxCombo || 0, this.state.combo);
    this.state.hits += 1;
    this._judgment(label);

    const vis = this.spriteByNote?.get(note);
    if (vis) {
      if (isHold) {
        // Paint head/body white and keep them solid during the hold
        this._paintHeadWhite(vis.head);
        if (vis.body) {
          this._paintBodyWhite(vis, note);     // upward geometry
          vis.body.__pfHoldActive = true;
        }
        vis.head.__pfHoldActive = true;

        const endMs = note.tMs + (note.dMs || 0);
        this.activeHoldsByLane.set(lane, {
          endMs, broken: false,
          headRef: vis.head,
          bodyRef: vis.body || null
        });
        // DO NOT start fading yet; wait until tail completion.
      } else {
        // Tap: flash then fade
        this._paintHeadWhite(vis.head);
        vis.head.__pfFlashUntil = (this.state.timeMs >= 0 ? this.state.timeMs : 0) + WHITE_FLASH_MS;
        vis.head.__pfFadeRate = HIT_FADE_RATE;
      }
    }

    // Advance next index
    while (this.state.nextIdx < this.chart.notes.length && this.chart.notes[this.state.nextIdx].hit) this.state.nextIdx++;
  }

  _paintHeadWhite(head) {
    const w = Math.max(1, head.width), h = Math.max(1, head.height);
    head.clear();
    head.roundRect(0, 0, w, h, 10);
    head.fill({ color: 0xffffff });
    head.alpha = 1;
  }

  // Draw white hold body UPWARD, matching runtime geometry
  _paintBodyWhite(vis, note) {
    const lengthPx = Math.max(10, (note.dMs || 0) * this.pixelsPerMs);
    const stemX = (vis.head.width - 12) / 2;
    vis.body.clear();
    vis.body.roundRect(stemX, -(lengthPx - 2), 12, lengthPx, 6);
    vis.body.fill({ color: 0xffffff, alpha: 0.95 });
    vis.body.alpha = 1;
  }

  _beginFadeOut(displayObj, fadeRatePerFrame = HIT_FADE_RATE, removeWhenDone = true) {
    displayObj.__pfFade = { rate: fadeRatePerFrame, remove: removeWhenDone };
  }

  _judgment(label, miss = false) {
    // DOM overlay text
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

    // In-canvas floating text
    const style = new PIXI.TextStyle({
      fill: miss ? 0xaa4b5b : (label === "Perfect" ? 0x25F4EE : (label === "Great" ? 0xC8FF4D : 0x8A5CFF)),
      fontSize: 36,
      fontFamily: "Arial",
      fontWeight: "bold",
      dropShadow: true,
      dropShadowColor: "#000000",
      dropShadowBlur: 3,
      dropShadowDistance: 2,
    });
    const t = new PIXI.Text({ text: label, style });
    t.anchor.set(0.5, 0.5);
    t.x = this.width / 2;
    t.y = this.judgeY - 42;
    t.alpha = 1;
    t.__pfVelY = -0.7;
    this.fxLayer.addChild(t);
    t.__pfFade = { rate: 0.03, remove: true };
  }

  async _gameLoop(startPerfMs, tickHook) {
    // Build sprites once
    this.noteLayer.removeChildren();
    this.fxLayer.removeChildren();
    this.spriteByNote.clear();

    const headH = 32;
    const headW = Math.max(28, this.laneWidth - 16);

    this.noteSprites = this.chart.notes.map(n => {
      const cont = new PIXI.Container();
      const body = (n.dMs && n.dMs > 0) ? new PIXI.Graphics() : null;
      if (body) cont.addChild(body);

      const head = new PIXI.Graphics();
      head.roundRect(0, 0, headW, headH, 10);
      head.fill({ color: 0x19cdd0 });
      head.stroke({ width: 2, color: 0x0ea7a9 });
      cont.addChild(head);

      cont.x = this._laneX(n.lane) + (this.laneWidth - headW) / 2;
      cont.y = -60;
      this.noteLayer.addChild(cont);

      head.__pfFlashUntil = null;
      head.__pfFadeRate   = HIT_FADE_RATE;
      head.__pfHoldActive = false;
      if (body) {
        body.__pfFlashUntil = null;
        body.__pfFadeRate   = HOLD_BODY_FADE;
        body.__pfHoldActive = false;
      }

      this.spriteByNote.set(n, { cont, head, body, n });
      return { cont, head, body, n };
    });

    // Countdown
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

    return await new Promise(resolve => {
      this.app.ticker.add(() => {
        const nowPerf = performance.now();
        const tMs = nowPerf - startPerfMs; // negative during countdown
        this.state.timeMs = tMs;

        if (tMs < 0) showCountdown(-tMs); else hideCountdown();

        // Update FX texts
        for (const child of [...this.fxLayer.children]) {
          if (child.__pfVelY) child.y += child.__pfVelY;
          if (child.__pfFade) {
            child.alpha = Math.max(0, child.alpha - child.__pfFade.rate);
            if (child.alpha <= 0.01) {
              if (child.__pfFade.remove) this.fxLayer.removeChild(child);
            }
          }
        }

        // Notes
        for (const obj of this.noteSprites) {
          const { n, cont, body, head } = obj;
          const removed = !cont.parent && (!body || !body.parent);
          if (removed) continue;

          // Position so head crosses judge line at n.tMs
          const y = this.judgeY - (n.tMs - tMs) * this.pixelsPerMs;
          if (cont.parent) cont.y = y;

          // Hold body geometry:
          // Draw upward so the trail is before the head as it falls.
          // If the hold is ACTIVE (player hit it), we keep its white body and skip redraw.
          if (body && body.parent && n.dMs > 0) {
            if (!body.__pfHoldActive) {
              const lengthPx = Math.max(10, n.dMs * this.pixelsPerMs);
              body.clear();
              const stemX = (cont.width - 12) / 2;
              body.roundRect(stemX, -(lengthPx - 2), 12, lengthPx, 6);
              body.fill({ color: 0x0fa3a0, alpha: 0.55 });
            }
          }

          // Miss window for unhit taps (holds get marked hit on press)
          if (tMs >= 0 && !n.hit) {
            if (tMs - n.tMs > 120) {
              n.hit = true;
              this.state.combo = 0;
              this._judgment("Miss", true);
              cont.parent?.removeChild(cont);
              if (body) body.parent?.removeChild(body);
              while (this.state.nextIdx < this.chart.notes.length && this.chart.notes[this.state.nextIdx].hit) this.state.nextIdx++;
              continue;
            }
          }

          // Timed flash -> fade (for taps only now)
          const now = tMs;
          if (head.__pfFlashUntil) {
            if (now >= head.__pfFlashUntil) {
              head.__pfFlashUntil = null;
              this._beginFadeOut(head, head.__pfFadeRate, true);
            }
          }
          if (body && body.__pfFlashUntil) {
            if (now >= body.__pfFlashUntil) {
              body.__pfFlashUntil = null;
              this._beginFadeOut(body, body.__pfFadeRate, true);
            }
          }

          // Per-frame fade progression
          if (head.parent && head.__pfFade) {
            head.alpha = Math.max(0, head.alpha - head.__pfFade.rate);
            if (head.alpha <= 0.01) {
              if (head.__pfFade.remove) cont.parent?.removeChild(cont);
              delete head.__pfFade;
            }
          }
          if (body && body.parent && body.__pfFade) {
            body.alpha = Math.max(0, body.alpha - body.__pfFade.rate);
            if (body.alpha <= 0.01) {
              if (body.__pfFade.remove !== false) body.parent.removeChild(body);
              delete body.__pfFade;
            }
          }

          // Cull when below screen
          const offscreenY = this.height + 80;
          if (cont.parent && cont.y > offscreenY) cont.parent.removeChild(cont);
          if (body && body.parent && cont.y > offscreenY) body.parent.removeChild(body);
        }

        // Maintain active holds
        if (tMs >= 0) {
          for (const [lane, hold] of [...this.activeHoldsByLane.entries()]) {
            if (hold.broken) continue;
            if (tMs < hold.endMs) {
              // Must keep key held; if not, early break is handled in keyup.
              const held = [...this.keyDown].some(k => this.keyMap[k] === lane);
              if (!held) {
                // If key is not physically down, treat like a quick release miss
                hold.broken = true;
                this.state.combo = 0;
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
              // Tail reached successfully: begin fade OUT now
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

        // HUD
        this.state.total = this.chart.notes.length;
        this.state.acc = this.state.total ? this.state.hits / this.state.total : 1;
        if (this.$combo) this.$combo.textContent = this.state.combo + "x";
        if (this.$acc) this.$acc.textContent = Math.round(this.state.acc * 100) + "%";
        if (this.$score) this.$score.textContent = this.state.score.toString();

        if (tickHook) tickHook();

        const endMs = (this.chart.durationMs || 20000) + 1500;
        if (tMs > endMs) resolve();
      });
    });
  }

  _laneX(idx) { return this.startX + idx * (this.laneWidth + this.laneGap); }
}

function pseudoHmac(message, secret) {
  const data = message + "|" + secret;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < data.length; i++) { h ^= data.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ("0000000" + (h >>> 0).toString(16)).slice(-8);
}
