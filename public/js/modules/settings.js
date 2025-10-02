// public/js/modules/settings.js
import { AudioPlayer } from "./audio.js";

export class Settings {
  constructor() {
    this.name = "";
    this.latencyMs = 0;
    this.keys = ["D","F","J","K"];
  this.volume = 1; // 0..1 master

  // Performance
  this.maxFps = 120;      // 0 = unlimited
  this.renderScale = 1.0; // 0.5 .. 2

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

    // Performance test state
    this._perfTesting = false;
    this._perfSuggestion = null;
    this._perfApp = null; // temporary PIXI app for stress testing

    // Persisted snapshot for unsaved-changes detection
    this._persisted = {
      name: this.name,
      latencyMs: this.latencyMs,
      keys: [...this.keys],
      volume: this.volume,
      maxFps: this.maxFps,
      renderScale: this.renderScale
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
      this.maxFps = isFiniteNumber(s.maxFps) ? Math.max(0, Math.floor(s.maxFps)) : this.maxFps;
      this.renderScale = isFiniteNumber(s.renderScale) ? Math.max(0.5, Math.min(2, s.renderScale)) : this.renderScale;

      // Update persisted snapshot baseline
      this._persisted = {
        name: this.name,
        latencyMs: this.latencyMs,
        keys: [...this.keys],
        volume: this.volume,
        maxFps: this.maxFps,
        renderScale: this.renderScale
      };
    } catch {}

    // Reflect → UI
    const $name = qs("#set-name");
    const $lat  = qs("#set-latency");
    const $keys = qs("#set-keys");
  const $vol  = qs("#set-volume");
  const $volLabel = qs("#set-volume-label");
  const $maxfps = qs("#set-maxfps");
  const $renderScale = qs("#set-render-scale");
  const $renderScaleLabel = qs("#set-render-scale-label");

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


    // Performance UI
    if ($maxfps) {
      $maxfps.value = String(this.maxFps);
      $maxfps.addEventListener("change", () => {
        const v = Math.max(0, Math.floor(Number($maxfps.value) || 0));
        this.maxFps = v;
        window.dispatchEvent(new CustomEvent("pf-maxfps-changed", { detail: { maxFps: v } }));
      });
    }
    if ($renderScale) {
      $renderScale.value = String(this.renderScale);
      if ($renderScaleLabel) $renderScaleLabel.textContent = `${Number(this.renderScale).toFixed(1)}x`;
      $renderScale.addEventListener("input", () => {
        const v = Math.max(0.5, Math.min(2, Number($renderScale.value) || 1));
        this.renderScale = v;
        if ($renderScaleLabel) $renderScaleLabel.textContent = `${v.toFixed(1)}x`;
        window.dispatchEvent(new CustomEvent("pf-render-scale-changed", { detail: { renderScale: v } }));
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

  // Performance helpers
    qs("#set-perf-reset")?.addEventListener("click", () => {
      this.maxFps = 120;
      this.renderScale = 1.0;
      const $maxfps = qs("#set-maxfps");
      const $renderScale = qs("#set-render-scale");
      const $renderScaleLabel = qs("#set-render-scale-label");
      if ($maxfps) $maxfps.value = String(this.maxFps);
      if ($renderScale) $renderScale.value = String(this.renderScale);
      if ($renderScaleLabel) $renderScaleLabel.textContent = `${this.renderScale.toFixed(1)}x`;
      window.dispatchEvent(new CustomEvent("pf-maxfps-changed", { detail: { maxFps: this.maxFps } }));
      window.dispatchEvent(new CustomEvent("pf-render-scale-changed", { detail: { renderScale: this.renderScale } }));
      this._setPerfStatus("Reset to defaults (Max FPS 120, Render Scale 1.0x)");
    });
  qs("#set-perf-test")?.addEventListener("click", () => this._runPerfTest());
  qs("#set-perf-apply")?.addEventListener("click", () => this._applySuggestedPerf());
    // Guard Back/Save while testing
    const backBtn = qs('#btn-back-main');
    backBtn?.addEventListener('click', (e) => {
      // During perf test, block nav
      if (this._perfTesting) {
        e?.preventDefault?.();
        e?.stopImmediatePropagation?.();
        this._setPerfStatus('Performance test running — please wait…');
        return;
      }
      // Warn on unsaved changes if leaving Settings
      try {
        const screen = document.getElementById('screen-settings');
        const isActive = screen?.classList?.contains('active');
        if (!isActive) return; // ignore if not on settings
        if (this._hasUnsavedChanges()) {
          const ok = window.confirm('You have unsaved changes. Leave without saving?');
          if (!ok) {
            e?.preventDefault?.();
            e?.stopImmediatePropagation?.();
          }
        }
      } catch {}
    }, true);
    const saveBtn = qs('#btn-save-settings');
    saveBtn?.addEventListener('click', (e) => {
      if (this._perfTesting) {
        e?.preventDefault?.();
        e?.stopImmediatePropagation?.();
        this._setPerfStatus('Performance test running — please wait…');
      }
    }, true);

    // Latency tester controls (no manual BPM UI — beat comes from current song)
    qs("#latency-start")?.addEventListener("click", () => this._startLatencyTest());
    qs("#latency-stop")?.addEventListener("click", () => this._stopLatencyTest());
    qs("#latency-tap")?.addEventListener("click", () => this._onLatencyTap());
    qs("#latency-apply")?.addEventListener("click", () => this._applySuggestedLatency());

    this._updateLatencyStatus("Press Start, then tap Space/Enter (or Tap) on each click.");

    // Auto-stop when leaving settings / page hidden
    this._setupAutoStopGuards();
  }

  _setPerfStatus(text){ const el = qs('#set-perf-status'); if (el) el.textContent = text || ''; }

  async _runPerfTest() {
    if (this._perfTesting) return;
    this._perfTesting = true;
    this._perfSuggestion = null;
    this._lockPerfUI(true);
    this._setPerfStatus('Preparing performance test…');
    try { await this._ap.ensureReady(); } catch {}

    // Try combos of Max FPS caps and Render Scales; score them and suggest best.
    const orig = { maxFps: this.maxFps, renderScale: this.renderScale };
    const results = [];
    const caps = [60, 120, 0]; // 0 = uncapped
    const scales = [1.0, 0.8, 0.6]; // keep total time ~9–10s

    const setCap = (cap) => {
      this.maxFps = cap;
      const sel = qs('#set-maxfps'); if (sel) sel.value = String(cap);
      window.dispatchEvent(new CustomEvent('pf-maxfps-changed', { detail: { maxFps: cap } }));
    };
    const setScale = (rs) => {
      this.renderScale = rs;
      const slider = qs('#set-render-scale'); if (slider) slider.value = String(rs);
      const labelEl = qs('#set-render-scale-label'); if (labelEl) labelEl.textContent = `${rs.toFixed(1)}x`;
      window.dispatchEvent(new CustomEvent('pf-render-scale-changed', { detail: { renderScale: rs } }));
    };

    // Ensure stress scene is running during measurement
    this._ensurePerfApp();
    const measureFps = (durationMs = 1000) => new Promise(resolve => {
      let frames = 0;
      const start = performance.now();
      const endAt = start + durationMs;
      const onFrame = () => {
        frames++;
        if (performance.now() < endAt) requestAnimationFrame(onFrame);
        else resolve(Math.round((frames * 1000) / durationMs));
      };
      requestAnimationFrame(onFrame);
    });

    try {
      for (const cap of caps) {
        for (const rs of scales) {
          this._setPerfStatus(`Testing Max FPS ${cap === 0 ? 'Unlimited' : cap}, Render ${rs.toFixed(1)}x…`);
          setCap(cap);
          setScale(rs);
          // Apply to stress app as well
          try {
            if (this._perfApp?.ticker) this._perfApp.ticker.maxFPS = cap > 0 ? cap : Infinity;
            if (this._perfApp?.renderer) {
              const newRes = Math.max(0.5, Math.min(2, rs));
              this._perfApp.renderer.resolution = newRes;
              this._perfApp.renderer.resize(window.innerWidth||1280, window.innerHeight||720);
            }
          } catch {}
          const fps = await measureFps();
          // Score: prioritize hitting >= 60 FPS, then higher render scale, then higher FPS
          const meets60 = fps >= 60 ? 1 : 0;
          const score = (meets60 * 1000) + (rs * 100) + (fps / 100);
          results.push({ cap, rs, fps, score });
        }
      }
    } finally {
      // Restore original
      setCap(orig.maxFps);
      setScale(orig.renderScale);
      this._destroyPerfApp();
      this._perfTesting = false;
      this._lockPerfUI(false);
    }

    // Suggest best combo
    const best = results.slice().sort((a,b)=> b.score - a.score)[0] || { cap: orig.maxFps, rs: orig.renderScale, fps: 60 };
    const humanCap = best.cap === 0 ? 'Unlimited' : String(best.cap);
    const summary = results
      .slice(0, 8)
      .map(r=>`(${r.cap===0?'∞':r.cap}, ${r.rs.toFixed(1)}x → ${r.fps} FPS)`).join(' • ');
    this._perfSuggestion = { maxFps: best.cap, renderScale: best.rs };
    const applyBtn = qs('#set-perf-apply'); if (applyBtn) applyBtn.disabled = false;
    this._setPerfStatus(`${summary}${results.length>8?' …':''} Suggested → Max FPS ${humanCap}, Render ${best.rs.toFixed(1)}x (${best.fps} FPS).`);
  }

  _applySuggestedPerf() {
    const sug = this._perfSuggestion;
    if (!sug) return;
    this.maxFps = sug.maxFps;
    this.renderScale = sug.renderScale;
    const sel = qs('#set-maxfps'); if (sel) sel.value = String(this.maxFps);
    const slider = qs('#set-render-scale'); if (slider) slider.value = String(this.renderScale);
    const labelEl = qs('#set-render-scale-label'); if (labelEl) labelEl.textContent = `${this.renderScale.toFixed(1)}x`;
    window.dispatchEvent(new CustomEvent('pf-maxfps-changed', { detail: { maxFps: this.maxFps } }));
    window.dispatchEvent(new CustomEvent('pf-render-scale-changed', { detail: { renderScale: this.renderScale } }));
    this._setPerfStatus(`Applied suggested: Max FPS ${this.maxFps===0?'Unlimited':this.maxFps}, Render ${this.renderScale.toFixed(1)}x.`);
  }

  _lockPerfUI(locked) {
    const ids = ['#set-perf-test', '#set-perf-apply', '#set-perf-reset', '#btn-save-settings', '#btn-back-main'];
    ids.forEach(sel => { const el = qs(sel); if (el) el.disabled = !!locked; });
    // Visual overlay on the Settings screen
    const screen = qs('#screen-settings');
    if (screen) {
      if (locked) {
        screen.classList.add('perf-locked');
        let overlay = screen.querySelector('.pf-perf-lock-overlay');
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.className = 'pf-perf-lock-overlay';
          overlay.setAttribute('aria-live', 'polite');
          overlay.innerHTML = `
            <div class="pf-perf-lock-card">
              <div class="pf-spinner" aria-hidden="true"></div>
              <div class="pf-perf-lock-text">Performance test running…</div>
              <div class="pf-perf-lock-sub muted">Saving and leaving are disabled until it finishes.</div>
            </div>
          `;
          screen.appendChild(overlay);
        }
      } else {
        screen.classList.remove('perf-locked');
        const overlay = screen.querySelector('.pf-perf-lock-overlay');
        if (overlay) overlay.remove();
      }
    }
  }

  _ensurePerfApp() {
    if (this._perfApp) return this._perfApp;
    try {
      const w = window.innerWidth || 1280; const h = window.innerHeight || 720;
      const canvas = document.createElement('canvas');
      canvas.id = 'pf-perf-canvas';
      Object.assign(canvas.style, { position:'fixed', left:'-9999px', top:'-9999px', width: w+'px', height: h+'px' });
      document.body.appendChild(canvas);
      // PIXI global
      // eslint-disable-next-line no-undef
      const app = new PIXI.Application();
      app.init({ canvas, width: w, height: h, background: 0x000000, antialias:false, resolution: Math.max(0.5, Math.min(2, this.renderScale||1)) });
      app.ticker.maxFPS = this.maxFps > 0 ? this.maxFps : Infinity;
      this._setupPerfScene(app);
      this._perfApp = app;
    } catch {}
    return this._perfApp;
  }

  _setupPerfScene(app) {
    try {
      const count = 400; // moving sprites
      const g = new (PIXI.Graphics)();
      g.circle(8, 8, 8); g.fill({ color: 0xffffff });
      const tex = app.renderer.generateTexture(g);
      const cont = new (PIXI.Container)();
      app.stage.addChild(cont);
      const rnd = (a,b)=> a + Math.random()*(b-a);
      for (let i=0;i<count;i++) {
        const s = new (PIXI.Sprite)(tex);
        s.x = rnd(0, app.renderer.width);
        s.y = rnd(0, app.renderer.height);
        s.tint = Math.random()*0xffffff;
        s.__vx = rnd(-3, 3);
        s.__vy = rnd(-3, 3);
        cont.addChild(s);
      }
        app.ticker.add(() => {
          for (const s of cont.children) {
            s.x += s.__vx; s.y += s.__vy;
            if (s.x < -16) s.x = app.renderer.width + 16;
            if (s.x > app.renderer.width + 16) s.x = -16;
            if (s.y < -16) s.y = app.renderer.height + 16;
            if (s.y > app.renderer.height + 16) s.y = -16;
            s.rotation += 0.02;
          }
        });
    } catch {}
  }

  _destroyPerfApp() {
    try {
      const c = document.getElementById('pf-perf-canvas');
      if (this._perfApp?.ticker) this._perfApp.ticker.stop();
      if (this._perfApp) this._perfApp.destroy(true, { children:true, texture:true, baseTexture:true });
      this._perfApp = null;
      if (c) c.remove();
    } catch {}
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
  this.maxFps = Math.max(0, Math.floor(Number(qs("#set-maxfps")?.value || this.maxFps)));
  this.renderScale = Math.max(0.5, Math.min(2, Number(qs("#set-render-scale")?.value || this.renderScale)));

    const payload = {
      name: this.name,
      latencyMs: this.latencyMs,
      keys: this.keys,
      volume: this.volume,
      maxFps: this.maxFps,
      renderScale: this.renderScale
    };
    localStorage.setItem("pf-settings", JSON.stringify(payload));

    // Update persisted baseline
    this._persisted = { ...payload, keys: [...payload.keys] };

    // Keep AudioPlayer aligned with saved volume
    this._ap.setMasterVolume(this.volume);
    window.dispatchEvent(new CustomEvent("pf-volume-changed", { detail: { volume: this.volume } }));

    if (alertUser) alert("Saved.");
  }

  // ----------------- Unsaved changes helpers -----------------
  _readUiSnapshot() {
    const $name = qs('#set-name');
    const $lat  = qs('#set-latency');
    const $keys = qs('#set-keys');
    const $vol  = qs('#set-volume');
    const $max  = qs('#set-maxfps');
    const $rs   = qs('#set-render-scale');
    const name = ($name?.value || '').trim();
    const latencyMs = parseInt($lat?.value || '0', 10) || 0;
    const keys = (($keys?.value || '').trim() || 'D,F,J,K')
      .split(',').map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,4);
    const volume = clamp01(((Number($vol?.value) || Math.round(this.volume*100)) / 100));
    const maxFps = Math.max(0, Math.floor(Number($max?.value || this.maxFps)));
    const renderScale = Math.max(0.5, Math.min(2, Number($rs?.value || this.renderScale)));
    return { name, latencyMs, keys, volume, maxFps, renderScale };
  }

  _hasUnsavedChanges() {
    // Compare current UI snapshot to persisted baseline
    try {
      const cur = this._readUiSnapshot();
      const p = this._persisted || {};
      if ((cur.name || '') !== (p.name || '')) return true;
      if ((cur.latencyMs|0) !== (p.latencyMs|0)) return true;
      const pk = Array.isArray(p.keys) ? p.keys.map(s=>String(s).toUpperCase()) : [];
      const ck = Array.isArray(cur.keys) ? cur.keys.map(s=>String(s).toUpperCase()) : [];
      if (pk.length !== ck.length) return true;
      for (let i=0;i<ck.length;i++){ if (ck[i] !== pk[i]) return true; }
      // compare volume with small tolerance
      if (Math.abs(Number(cur.volume||0) - Number(p.volume||0)) > 0.005) return true;
      if ((cur.maxFps|0) !== (p.maxFps|0)) return true;
      if (Math.abs(Number(cur.renderScale||0) - Number(p.renderScale||0)) > 0.0001) return true;
      return false;
    } catch {
      return false;
    }
  }

  // Simple getters for other modules
  getName(){ return this.name; }
  getVolumes(){ return { master: this.volume }; }
  getPerformance(){ return { maxFps: this.maxFps, renderScale: this.renderScale }; }

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

    // Drift-corrected scheduling: use performance.now() for cadence and align audio on the WebAudio clock
    const schedule = () => {
      if (!this._lt.running) return;
      const targetPerf = this._lt.nextBeatPerfMs;
      const dueIn = Math.max(0, targetPerf - performance.now());
      this._lt.scheduler = setTimeout(() => {
        if (!this._lt.running) return;
        // Convert the performance.now()-based target to AudioContext time with a tiny lookahead
        const nowPerf = performance.now();
        const ctx = this._ap.ctx;
        const nowAudio = ctx.currentTime;
        // Estimate conversion: assume constant offset between perf and audio clocks during the test
        const offsetSec = (targetPerf - nowPerf) / 1000;
        const when = Math.max(nowAudio + 0.01, nowAudio + offsetSec);
        this._emitLatencyBeat(targetPerf, when);
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

  _emitLatencyBeat(scheduledPerfMs, whenAudio = null) {
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

    // Audible click (short blip; routes through master) aligned to 'whenAudio' if provided
    this._click(1000, 60, whenAudio);

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

  _click(freq = 1000, durMs = 60, when = null) {
    const ctx = this._ap.ctx;
    const now = ctx.currentTime;
    const startAt = (Number.isFinite(when) ? when : now);

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, startAt);

    // Short envelope
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, startAt);
    g.gain.linearRampToValueAtTime(0.6, startAt + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + durMs / 1000);

    osc.connect(g);
    g.connect(this._ap.master); // goes through master -> volume applies

  try { osc.start(startAt); } catch {}
  try { osc.stop(startAt + durMs / 1000 + 0.01); } catch {}
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
