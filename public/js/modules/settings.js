// public/js/modules/settings.js
import { AudioPlayer } from "./audio.js";

export class Settings {
  constructor() {
    this.name = "";
    this.latencyMs = 0;
    this.keys = ["D","F","J","K"];
    this.volume = 1; // 0..1

    // Small, shared audio helper (routes through a master Gain)
    this._ap = new AudioPlayer();
    this._ap.setMasterVolume(this.volume);

    // Latency test state
    this._lt = {
      running: false,
      beatMs: 60000 / 120,        // default to 120 BPM until a song sets it
      leadInMs: 1500,
      startPerfMs: 0,
      nextBeatPerfMs: 0,
      scheduler: null,
      tapOffsets: [],
      keyHandler: null,
      // auto-stop resources
      cleanups: [],
      _screenObserver: null,
      _domObserver: null,
      _visHandler: null,
      _pageHideHandler: null
    };

    // Persist button may be on the page chrome
    // qs("#btn-save-settings")?.addEventListener("click", () => this.save(true));

    // Let other parts of the app provide the current song tempo.
    // Accept either {bpm} or {beatMs}.
    window.addEventListener("pf-song-bpm", (e) => {
      const bpm = Number(e?.detail?.bpm);
      const beatMs = Number(e?.detail?.beatMs);
      if (Number.isFinite(beatMs) && beatMs > 0) this._lt.beatMs = beatMs;
      else if (Number.isFinite(bpm) && bpm > 0) this._lt.beatMs = 60000 / bpm;
    });
  }

  // ----------------- Public API -----------------
  load() {
    // Load persisted values (if any)
    try {
      const raw = localStorage.getItem("pf-settings") || "{}";
      const s = JSON.parse(raw);

      let name = typeof s.name === "string" ? s.name.trim() : "";
      if (name === "Player") name = ""; // treat legacy default as blank

      this.name = name || "";
      this.latencyMs = isFiniteNumber(s.latencyMs) ? s.latencyMs : this.latencyMs;
      this.keys = Array.isArray(s.keys) && s.keys.length ? s.keys : this.keys;
      this.volume = isFiniteNumber(s.volume) ? clamp01(s.volume) : this.volume;
    } catch {}

    // Reflect → UI
    const $name = qs("#set-name");
    const $lat  = qs("#set-latency");
    const $keys = qs("#set-keys");
    const $vol  = qs("#set-volume");
    const $volLabel = qs("#set-volume-label");

    if ($name) $name.value = this.name || "";
    if ($lat)  $lat.value = this.latencyMs;
    if ($keys) $keys.value = (this.keys || []).join(",");

    // Volume range is 0..100 in HTML → map to 0..1 internally
    if ($vol) {
      $vol.value = String(Math.round(this.volume * 100));
      if ($volLabel) $volLabel.textContent = `${Math.round(this.volume * 100)}%`;
      this._ap.setMasterVolume(this.volume);

      // live updates
      $vol.addEventListener("input", () => {
        const v = clamp01((Number($vol.value) || 0) / 100);
        this.volume = v;
        this._ap.setMasterVolume(v);
        if ($volLabel) $volLabel.textContent = `${Math.round(v * 100)}%`;
        // broadcast so editor/solo preview can react immediately
        window.dispatchEvent(new CustomEvent("pf-volume-changed", { detail: { volume: v } }));
      });
    }

    // Simple test sounds
    qs("#set-test-beep")?.addEventListener("click", async () => {
      await this._ap.ensureReady();
      this._playTestBeep();
    });
    qs("#set-test-pattern")?.addEventListener("click", async () => {
      await this._ap.ensureReady();
      this._playTestPattern();
    });

    // Latency tester controls (no manual BPM UI — beat comes from current song)
    qs("#latency-start")?.addEventListener("click", () => this._startLatencyTest());
    qs("#latency-stop")?.addEventListener("click", () => this._stopLatencyTest());
    qs("#latency-tap")?.addEventListener("click", () => this._onLatencyTap());
    qs("#latency-apply")?.addEventListener("click", () => this._applySuggestedLatency());

    this._updateLatencyStatus("Press Start, then tap Space/Enter (or Tap) on each click.");

    // Auto-stop when leaving settings / page hidden
    this._setupAutoStopGuards();
  }

  save(alertUser = true) {
    const $name = qs("#set-name");
    const $lat  = qs("#set-latency");
    const $keys = qs("#set-keys");
    const $vol  = qs("#set-volume");

    this.name = ($name?.value || "").trim();
    this.latencyMs = parseInt($lat?.value || "0", 10);
    this.keys = ($keys?.value || "D,F,J,K")
      .split(",")
      .map(s => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 4);
    this.volume = clamp01(((Number($vol?.value) || 100) / 100));

    localStorage.setItem("pf-settings", JSON.stringify({
      name: this.name,
      latencyMs: this.latencyMs,
      keys: this.keys,
      volume: this.volume
    }));

    // Keep AudioPlayer aligned with saved volume
    this._ap.setMasterVolume(this.volume);
    window.dispatchEvent(new CustomEvent("pf-volume-changed", { detail: { volume: this.volume } }));

    if (alertUser) alert("Saved.");
  }

  // ----------------- Latency Test -----------------
  async _startLatencyTest() {
    if (this._lt.running) return;
    await this._ap.ensureReady();
    this._ap.setMasterVolume(this.volume);

    this._lt.running = true;
    this._lt.tapOffsets = [];

    const now = performance.now();
    this._lt.startPerfMs = now + this._lt.leadInMs;
    this._lt.nextBeatPerfMs = this._lt.startPerfMs;

    // Keyboard taps
    this._lt.keyHandler = (e) => {
      if (e.repeat) return;
      if (e.code === "Space" || e.code === "Enter") {
        e.preventDefault();
        this._onLatencyTap();
      }
    };
    window.addEventListener("keydown", this._lt.keyHandler);

    // Drift-corrected scheduling to absolute performance.now() targets
    const schedule = () => {
      if (!this._lt.running) return;
      const dueIn = Math.max(0, this._lt.nextBeatPerfMs - performance.now());
      this._lt.scheduler = setTimeout(() => {
        // Emit *only* if still running (leaving screen cancels)
        if (this._lt.running) this._emitLatencyBeat(this._lt.nextBeatPerfMs);
        this._lt.nextBeatPerfMs += this._lt.beatMs;
        schedule();
      }, dueIn);
    };
    schedule();

    this._updateLatencyStatus("Starting… get ready to tap on each click.");
  }

  _stopLatencyTest() {
    if (!this._lt.running) return;
    this._lt.running = false;

    if (this._lt.scheduler) {
      clearTimeout(this._lt.scheduler);
      this._lt.scheduler = null;
    }
    if (this._lt.keyHandler) {
      window.removeEventListener("keydown", this._lt.keyHandler);
      this._lt.keyHandler = null;
    }

    const med = median(this._lt.tapOffsets);
    if (Number.isFinite(med)) {
      const suggested = -Math.round(med);
      this._updateLatencyStatus(
        `Median offset ${fmtMs(med)} → suggested Input Latency ${fmtMs(suggested)}. Click “Apply” to save.`
      );
    } else {
      this._updateLatencyStatus("Stopped. No taps recorded.");
    }

    const flash = qs("#latency-flash");
    if (flash) flash.style.opacity = "0";
  }

  _emitLatencyBeat(scheduledPerfMs) {
    // Visual flash bar (blue)
    const flash = qs("#latency-flash");
    if (flash) {
      flash.style.transition = "none";
      flash.style.opacity = "1";
      requestAnimationFrame(() => {
        flash.style.transition = "opacity 120ms ease-out";
        flash.style.opacity = "0";
      });
    }

    // Audible click (short blip; routes through master)
    this._click(1000, 60);

    // Show instruction when the first beat hits
    if (Math.abs(scheduledPerfMs - this._lt.startPerfMs) < 4) {
      this._updateLatencyStatus("Tap Space/Enter (or Tap) on each click…");
    }
  }

  _onLatencyTap() {
    if (!this._lt.running) return;
    const now = performance.now();

    // Nearest beat since lead-in
    const rel = now - this._lt.startPerfMs;
    const k = Math.round(rel / this._lt.beatMs);
    const nearestBeatPerf = this._lt.startPerfMs + k * this._lt.beatMs;
    const offset = now - nearestBeatPerf; // + = late

    // Discard wildly-off taps (e.g., wrong key)
    const half = this._lt.beatMs / 2;
    if (offset < -half || offset > half) return;

    this._lt.tapOffsets.push(offset);

    // Live feedback
    const med = median(this._lt.tapOffsets);
    const count = this._lt.tapOffsets.length;
    if (Number.isFinite(med)) {
      const suggested = -Math.round(med);
      this._updateLatencyStatus(`Taps: ${count} • median ${fmtMs(med)} → suggested ${fmtMs(suggested)}.`);
    } else {
      this._updateLatencyStatus(`Taps: ${count}`);
    }

    // Feedback tick
    this._click(600, 30);
  }

  _applySuggestedLatency() {
    const med = median(this._lt.tapOffsets);
    if (!Number.isFinite(med)) return;
    const suggested = -Math.round(med);
    this.latencyMs = suggested;

    const $lat = qs("#set-latency");
    if ($lat) $lat.value = String(this.latencyMs);

    this._updateLatencyStatus(`Applied ${fmtMs(this.latencyMs)} to “Latency Offset (ms)”.`);
    this.save(false); // persist silently
  }

  _updateLatencyStatus(text) {
    const el = qs("#latency-status");
    if (el) el.textContent = text;
  }

  // ----------------- Test Sounds -----------------
  _playTestBeep() {
    // Two short beeps A5 → C6
    this._click(880, 80);
    setTimeout(() => this._click(1046.5, 80), 140);
  }

  _playTestPattern() {
    // Simple 1–2–3–4 metronome at ~120 BPM
    const step = 500; // ms
    const base = performance.now() + 60; // tiny delay to line up
    [0, 1, 2, 3, 4, 5, 6, 7].forEach(i => {
      const t = base + i * step;
      setTimeout(() => this._click(i % 4 === 0 ? 1200 : 1000, 50), Math.max(0, t - performance.now()));
    });
  }

  _click(freq = 1000, durMs = 60) {
    const ctx = this._ap.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now);

    // Short envelope
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.6, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + durMs / 1000);

    osc.connect(g);
    g.connect(this._ap.master); // goes through master -> volume applies

    try { osc.start(now); } catch {}
    try { osc.stop(now + durMs / 1000 + 0.01); } catch {}
  }

  // ----------------- Auto-stop guards -----------------
  _setupAutoStopGuards() {
    // Clear old guards if load() called more than once
    for (const fn of this._lt.cleanups) { try { fn(); } catch {} }
    this._lt.cleanups = [];

    // 1) Back button in the Settings panel (if present)
    const backBtn = qs("#btn-back-main");
    if (backBtn) {
      const onBack = () => this._stopLatencyTest();
      backBtn.addEventListener("click", onBack);
      this._lt.cleanups.push(() => backBtn.removeEventListener("click", onBack));
    }

    // 2) Stop when #screen-settings loses .active or is removed from DOM
    const screen = qs("#screen-settings");
    if (screen) {
      const onAttrs = (mutList) => {
        for (const m of mutList) {
          if (m.type === "attributes" && m.attributeName === "class") {
            if (!screen.classList.contains("active")) this._stopLatencyTest();
          }
        }
      };
      const scrObs = new MutationObserver(onAttrs);
      scrObs.observe(screen, { attributes: true, attributeFilter: ["class"] });
      this._lt._screenObserver = scrObs;
      this._lt.cleanups.push(() => scrObs.disconnect());

      const domObs = new MutationObserver(() => {
        if (!document.body.contains(screen)) this._stopLatencyTest();
      });
      domObs.observe(document.body, { childList: true, subtree: true });
      this._lt._domObserver = domObs;
      this._lt.cleanups.push(() => domObs.disconnect());
    }

    // 3) Stop if tab is hidden or page is being unloaded
    const onVis = () => { if (document.hidden) this._stopLatencyTest(); };
    const onHide = () => this._stopLatencyTest();

    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onHide);

    this._lt._visHandler = onVis;
    this._lt._pageHideHandler = onHide;

    this._lt.cleanups.push(() => document.removeEventListener("visibilitychange", onVis));
    this._lt.cleanups.push(() => window.removeEventListener("pagehide", onHide));
  }
}

// ----------------- tiny utils -----------------
function qs(sel) { return document.querySelector(sel); }
function isFiniteNumber(x) { return typeof x === "number" && Number.isFinite(x); }
function clamp01(x){ return Math.max(0, Math.min(1, Number(x) || 0)); }
function median(arr){
  if (!arr || !arr.length) return NaN;
  const a = [...arr].sort((x,y)=>x-y);
  const m = Math.floor(a.length/2);
  return a.length % 2 ? a[m] : (a[m-1] + a[m]) / 2;
}
function fmtMs(v){ const s = Math.round(v); return (s >= 0 ? "+" : "") + s + "ms"; }
