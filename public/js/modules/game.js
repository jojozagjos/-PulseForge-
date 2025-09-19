// public/js/modules/game.js
import { AudioPlayer } from "./audio.js";

export class Game {
  constructor(runtime, settings) {
    this.runtime = runtime;
    this.settings = settings;

    // Find or create the canvas safely
    this.canvas = document.getElementById("game-canvas");
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.canvas.id = "game-canvas";
      Object.assign(this.canvas.style, {
        position: "absolute",
        inset: "0",
        width: "100%",
        height: "100%"
      });
      document.body.appendChild(this.canvas);
    }

    // NEVER read clientWidth/clientHeight here.
    // Use window size fallbacks so construction cannot throw.
    const w = (typeof window !== "undefined" && window.innerWidth) ? window.innerWidth : 1280;
    const h = (typeof window !== "undefined" && window.innerHeight) ? window.innerHeight : 720;

    // Clamp to sensible bounds
    this.width  = Math.max(960, Math.min(Math.floor(w), 1920));
    this.height = Math.max(540, Math.min(Math.floor(h), 1080));

    this.app = null;
    this.state = { score: 0, combo: 0, total: 0, hits: 0, acc: 1, nextIdx: 0, timeMs: 0 };
    this.maxCombo = 0;

    // Debug stamp to prove the right file is running:
    console.log("[Game ctor] build=NO-CLIENTWIDTH", { width: this.width, height: this.height, canvasFound: !!document.getElementById("game-canvas") });
  }

  async run() {
    // Ensure canvas is visible before init to avoid zero-size layouts
    this.canvas.style.display = "block";

    this.app = new PIXI.Application();
    await this.app.init({
      canvas: this.canvas,
      width: this.width,
      height: this.height,
      antialias: true,
      background: 0x0a0c10
      // Alternative: enable Pixi's responsive mode:
      // resizeTo: window
    });

    this._buildScene();

    if (this.runtime.mode === "solo") {
      await this._playSolo(this.runtime.manifest);
    } else {
      await this._playMp(this.runtime);
    }

    return [
      { label: "Score", value: this.state.score.toString() },
      { label: "Accuracy", value: Math.round(this.state.acc * 100) + "%" },
      { label: "Max Combo", value: this.maxCombo || this.state.combo }
    ];
  }

  _buildScene() {
    const bg = new PIXI.Graphics();
    bg.alpha = 0.25;
    for (let i = 0; i < 40; i++) {
      bg.moveTo(0, i * 18);
      bg.lineTo(this.width, i * 18);
    }
    this.app.stage.addChild(bg);

    this.laneCount = 4;
    this.laneWidth = Math.max(110, Math.min(160, Math.floor(this.width / 12)));
    this.laneGap = Math.max(18, Math.min(28, Math.floor(this.width / 80)));
    const totalW = this.laneCount * this.laneWidth + (this.laneCount - 1) * this.laneGap;
    this.startX = (this.width - totalW) / 2;
    this.judgeY = this.height - 140;

    this.laneSprites = [];
    for (let i = 0; i < this.laneCount; i++) {
      const g = new PIXI.Graphics();
      g.roundRect(this.startX + i * (this.laneWidth + this.laneGap), 80, this.laneWidth, this.height - 220, 16);
      g.fill({ color: 0x111725 });
      g.stroke({ width: 2, color: 0x2a3142 });
      this.app.stage.addChild(g);
      this.laneSprites.push(g);
    }

    const j = new PIXI.Graphics();
    j.moveTo(this.startX - 10, this.judgeY);
    j.lineTo(this.startX + totalW + 10, this.judgeY);
    j.stroke({ width: 4, color: 0x25f4ee });
    this.app.stage.addChild(j);

    this.noteLayer = new PIXI.Container();
    this.app.stage.addChild(this.noteLayer);

    this.$combo = document.getElementById("hud-combo");
    this.$acc = document.getElementById("hud-acc");
    this.$score = document.getElementById("hud-score");
    this.$judge = document.getElementById("judgment");
  }

  async _playSolo(manifest) {
    const player = new AudioPlayer();
    await player.load(manifest.audioUrl);
    this.chart = manifest;
    this._prepareInputs();

    const startAt = player.ctx.currentTime + 1.0;
    const src = player.playAt(startAt);
    const startMs = startAt * 1000;

    await this._gameLoop(player, startMs);
    src.stop();
  }

  async _playMp(rt) {
    const track = rt.track;
    const diff = rt.difficulty || "normal";
    const chartUrl = track.charts[diff];
    const chart = await fetch(chartUrl).then(r => r.json());
    chart.audioUrl = track.audio.wav;
    this.chart = chart;

    const player = new AudioPlayer();
    await player.load(chart.audioUrl);
    this._prepareInputs();

    const startAtSec = rt.startAt / 1000;
    const nowSec = player.ctx.currentTime;
    const delay = Math.max(0.2, startAtSec - nowSec);
    const src = player.playAt(nowSec + delay);
    const startMs = (nowSec + delay) * 1000;

    const secret = rt.secret;
    const socket = rt.socket;
    const roomCode = rt.roomCode;

    let lastSent = 0;
    const sendBundle = () => {
      const t = Date.now();
      if (t - lastSent < 120) return;
      lastSent = t;
      const bundle = { t, acc: this.state.acc, score: this.state.score, combo: this.state.combo };
      bundle.mac = pseudoHmac(JSON.stringify({ t: bundle.t, acc: bundle.acc, score: bundle.score, combo: bundle.combo }), secret);
      socket.emit("playEvent", { code: roomCode, bundle });
    };

    await this._gameLoop(player, startMs, sendBundle);
    src.stop();
    socket.emit("complete", { code: roomCode });
  }

  _prepareInputs() {
    const keys = this.settings.keys || ["D", "F", "J", "K"];
    const map = {};
    for (let i = 0; i < keys.length; i++) map[keys[i].toUpperCase()] = i;
    this.keyMap = map;

    window.onkeydown = e => {
      const k = (e.key || "").toUpperCase();
      if (k in map) this._attemptHit(map[k]);
    };
  }

  _attemptHit(lane) {
    const nowMs = this.state.timeMs + (this.settings.latencyMs || 0);
    for (let i = this.state.nextIdx; i < this.chart.notes.length; i++) {
      const n = this.chart.notes[i];
      if (n.hit) continue;
      if (n.lane !== lane) continue;
      const dt = nowMs - n.tMs;
      const adt = Math.abs(dt);

      let add = 0;
      let label = null;
      if (adt <= 30) { add = 100; label = "Perfect"; }
      else if (adt <= 65) { add = 80; label = "Great"; }
      else if (adt <= 100) { add = 50; label = "Good"; }
      else if (dt < -120) { break; } else { continue; }

      n.hit = true;
      this.state.score += add + Math.floor(this.state.combo * 0.1);
      this.state.combo += 1;
      this.maxCombo = Math.max(this.maxCombo || 0, this.state.combo);
      this.state.hits += 1;
      this._judgment(label);

      while (this.state.nextIdx < this.chart.notes.length && this.chart.notes[this.state.nextIdx].hit) this.state.nextIdx++;
      return;
    }
    this.state.combo = 0;
    this._judgment("Miss", true);
  }

  _judgment(label, miss = false) {
    const el = this.$judge;
    if (!el) return;
    el.textContent = label;
    el.style.color = miss ? "#aa4b5b" : (label === "Perfect" ? "#25F4EE" : (label === "Great" ? "#C8FF4D" : "#8A5CFF"));
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
  }

  async _gameLoop(player, startMs, tickHook) {
    // Build notes
    this.noteLayer.removeChildren();
    const ppm = 0.35; // pixels per ms
    this.noteSprites = this.chart.notes.map(n => {
      const g = new PIXI.Graphics();
      const x = this._laneX(n.lane) + 12;
      g.roundRect(x, -40, this.laneWidth - 24, 22, 8);
      g.fill({ color: 0x1bd6cf });
      g.alpha = 0.9;
      this.noteLayer.addChild(g);
      return { g, n };
    });

    return await new Promise(resolve => {
      this.app.ticker.add(() => {
        this.state.timeMs = performance.now() - startMs;

        for (const obj of this.noteSprites) {
          const y = this.judgeY - (obj.n.tMs - this.state.timeMs) * ppm;
          obj.g.y = y;

          if (obj.n.hit) {
            obj.g.alpha = Math.max(0, obj.g.alpha - 0.08);
          } else if (this.state.timeMs - obj.n.tMs > 120) {
            obj.n.hit = true;
            this.state.combo = 0;
            this._judgment("Miss", true);
          }
        }

        this.state.total = this.chart.notes.length;
        this.state.acc = this.state.total ? this.state.hits / this.state.total : 1;

        const c = document.getElementById("hud-combo"); if (c) c.textContent = this.state.combo + "x";
        const a = document.getElementById("hud-acc"); if (a) a.textContent = Math.round(this.state.acc * 100) + "%";
        const s = document.getElementById("hud-score"); if (s) s.textContent = this.state.score.toString();

        if (tickHook) tickHook();
        if (this.state.timeMs > (this.chart.durationMs || 20000) + 1500) resolve();
      });
    });
  }

  _laneX(idx) {
    return this.startX + idx * (this.laneWidth + this.laneGap);
  }
}

function pseudoHmac(message, secret) {
  const data = message + "|" + secret;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < data.length; i++) {
    h ^= data.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ("0000000" + (h >>> 0).toString(16)).slice(-8);
}
