// public/js/modules/editor.js
// PulseForge Chart Editor with audio picker + New/Open/Save As toolbar
export class Editor {
  constructor(opts) {
    this.canvas = document.getElementById(opts.canvasId);
    this.ctx = this.canvas.getContext("2d");

    // UI ids
    this.ids = {
      // Core controls
      scrub: opts.scrubId,
      bpm: opts.bpmInputId,
      subdiv: opts.subdivInputId,
      lanes: opts.lanesInputId,
      zoom: opts.zoomInputId,
      time: opts.timeLabelId,
      help: opts.helpLabelId,

      // Audio picker
      audioUrl: "ed-audio-url",
      audioLoadUrl: "ed-audio-load-url",
      audioFileInput: "ed-audio-file",
      audioUseFileBtn: "ed-audio-use-file",
      audioApplyManifest: "ed-audio-apply-manifest",
      audioHint: "ed-audio-hint",

      // File toolbar
      fileNew: "ed-new",
      fileOpenUrl: "ed-open-url",
      fileOpenFileInput: "ed-open-file",
      fileOpenUseBtn: "ed-open-use-file",
      fileSaveAs: "ed-save-as",
      fileLoadManifestUrl: "ed-manifest-url",
      fileDifficulty: "ed-diff",
      fileClearNotes: "ed-clear-notes"
    };

    // Model
    this.audioCtx = null;
    this.audioBuffer = null;
    this.audioSource = null;
    this.playing = false;
    this.playStartCtxTime = 0;
    this.playStartMs = 0;

    this.manifest = null;
    this.manifestUrl = null;
    this.chart = null; // { bpm, durationMs, lanes, notes: [...] }
    this.chartUrl = null;
    this.difficulty = "normal";
    this.zoomY = 1.0;
    this.scrollY = 0; // px offset from 0ms
    this.pxPerMs = 0.35;

    this.tool = "create"; // create | select | stretch | delete | copy | paste
    this.subdiv = 4; // grid per beat
    this.snap = true;

    this.selection = new Set(); // indices into chart.notes
    this.clipboard = [];

    this.drag = null; // dragging, stretching, panning
    this.mouse = { x: 0, y: 0, lane: 0 };

    // Style palette
    this.colors = {
      bg: "#0a0c10",
      gridMinor: "#223048",
      gridMajor: "#2e405c",
      gridDecade: "#3fc1c9",
      laneFill: "#111725",
      laneStroke: "#2a3142",
      noteHead: "#19cdd0",
      noteHeadStroke: "#0ea7a9",
      holdBody: "rgba(15,163,160,0.55)",
      selection: "#ffd166",
      playhead: "#25f4ee"
    };

    // wiring guards so we can call mountToolbar() safely multiple times
    this._wiredAudio = false;
    this._wiredFile = false;

    // Bind
    this._tick = this._tick.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._resize = this._resize.bind(this);

    // Size & listeners
    this._resize();
    window.addEventListener("resize", this._resize);
    this.canvas.addEventListener("wheel", this._onWheel, { passive: false });

    // Pointer
    this.canvas.addEventListener("pointermove", e => this._pointerMove(e));
    this.canvas.addEventListener("pointerdown", e => this._pointerDown(e));
    window.addEventListener("pointerup", e => this._pointerUp(e));

    requestAnimationFrame(this._tick);

    // External hooks
    this.onExport = opts.onExport || (() => {});
  }

  /** Start a blank chart without loading a manifest. */
  newChart(init = {}) {
    this.manifest = null;
    this.manifestUrl = null;
    this.chartUrl = null;
    this.difficulty = "normal";
    this.chart = {
      bpm: init.bpm ?? 120,
      lanes: init.lanes ?? 4,
      durationMs: init.durationMs ?? 180000,
      notes: Array.isArray(init.notes) ? init.notes.slice() : []
    };
    this.subdiv = 4;
    this.selection.clear();
    this.scrollY = 0;
    this.zoomY = 1.0;
    this._syncInputs();
    this._updateScrubMax();
    this._help("Blank chart ready. Use Audio or File to load assets.");
  }

  /** Load a manifest + chart (optional) and wire toolbars. */
  async loadManifest(manifestUrl, difficulty = "normal") {
    this.manifestUrl = manifestUrl;
    this.difficulty = difficulty;
    const m = await fetch(manifestUrl).then(r => r.json());
    this.manifest = m;

    const chartUrl = m.charts?.[difficulty];
    if (!chartUrl) {
      this.chartUrl = null;
      this.chart = { bpm: m.bpm || 120, durationMs: m.durationMs || 180000, lanes: 4, notes: [] };
    } else {
      this.chartUrl = chartUrl;
      this.chart = await fetch(chartUrl).then(r => r.json());
      this.chart.bpm = this.chart.bpm || this.manifest.bpm || 120;
      this.chart.lanes = this.chart.lanes || 4;
      this.chart.durationMs = this.chart.durationMs || this.manifest.durationMs || 180000;
      if (!Array.isArray(this.chart.notes)) this.chart.notes = [];
    }

    this.subdiv = 4;
    this._syncInputs();

    await this._ensureAudioCtx();
    const audioUrl = this.manifest?.audio?.wav || this.manifest?.audio?.mp3;
    if (audioUrl) {
      await this._loadAudio(audioUrl);
      const urlBox = document.getElementById(this.ids.audioUrl);
      if (urlBox) urlBox.value = audioUrl;
    }
    this._updateScrubMax();

    // make sure toolbars are wired when coming via manifest path too
    this._wireAudioPicker();
    this._wireFileToolbar();
  }

  /** Wire all UI pieces; safe to call even on blank start. */
  mountToolbar() {
    // Tools: style safeguard if you didn't add classes in HTML
    document.querySelectorAll('[data-tool]').forEach(btn => {
      if (!btn.classList.contains("primary") && !btn.classList.contains("secondary") && !btn.classList.contains("ghost")) {
        btn.style.background = "#1e2433";
        btn.style.border = "1px solid #2a3142";
        btn.style.color = "#eee";
        btn.style.padding = "4px 10px";
        btn.style.borderRadius = "6px";
        btn.style.fontSize = "0.85em";
        btn.addEventListener("mouseenter", () => btn.style.background = "#2a3142");
        btn.addEventListener("mouseleave", () => btn.style.background = "#1e2433");
      }
    });

    // Tool selection
    document.querySelectorAll("[data-tool]").forEach(btn => {
      btn.addEventListener("click", () => {
        this.tool = btn.getAttribute("data-tool");
        this._help(`Tool: ${this.tool}`);
      });
    });

    const bpmEl = document.getElementById(this.ids.bpm);
    const subEl = document.getElementById(this.ids.subdiv);
    const lanesEl = document.getElementById(this.ids.lanes);
    const zoomEl = document.getElementById(this.ids.zoom);
    const scrubEl = document.getElementById(this.ids.scrub);

    bpmEl?.addEventListener("change", () => { this.chart.bpm = Number(bpmEl.value) || 120; });
    subEl?.addEventListener("change", () => { this.subdiv = Math.max(1, Number(subEl.value) || 4); });
    lanesEl?.addEventListener("change", () => { this.chart.lanes = Math.max(1, Number(lanesEl.value) || 4); });
    zoomEl?.addEventListener("input", () => { this.zoomY = Math.max(0.25, Math.min(3, Number(zoomEl.value))); });

    // Transport
    document.getElementById("ed-play")?.addEventListener("click", () => this.play());
    document.getElementById("ed-pause")?.addEventListener("click", () => this.pause());
    document.getElementById("ed-stop")?.addEventListener("click", () => this.stop());

    // Import / Export (chart JSON only)
    document.getElementById("ed-import")?.addEventListener("click", async () => {
      const txt = prompt("Paste chart JSON here:");
      if (!txt) return;
      try {
        const obj = JSON.parse(txt);
        if (Array.isArray(obj.notes)) {
          this.chart = { ...this.chart, ...obj };
          this._syncInputs();
          this._updateScrubMax();
          this._help("Imported chart.");
        } else {
          alert("Invalid chart JSON.");
        }
      } catch (e) {
        alert("Parse error: " + e.message);
      }
    });
    document.getElementById("ed-export")?.addEventListener("click", () => this._downloadChart(this._suggestChartFilename()));

    // Scrubber
    scrubEl?.addEventListener("input", () => {
      const ms = Number(scrubEl.value);
      this.seek(ms);
    });

    // >>> These were missing when you started blank <<<
    this._wireAudioPicker();
    this._wireFileToolbar();
  }

  // ---------- File toolbar ----------
  _wireFileToolbar() {
    if (this._wiredFile) return;
    this._wiredFile = true;
    console.log("[Editor] wiring File toolbar");

    // New chart (clears notes only)
    document.getElementById(this.ids.fileNew)?.addEventListener("click", () => {
      if (!this.chart) this.newChart();
      this.chart.notes = [];
      this.selection.clear();
      this._help("New chart: notes cleared.");
    });

    document.getElementById(this.ids.fileClearNotes)?.addEventListener("click", () => {
      if (!this.chart) this.newChart();
      this.chart.notes = [];
      this.selection.clear();
      this._help("Cleared all notes.");
    });

    // Open manifest
    const manifestUrlInput = document.getElementById(this.ids.fileLoadManifestUrl);
    const diffSelect = document.getElementById(this.ids.fileDifficulty);
    document.getElementById(this.ids.fileOpenUrl)?.addEventListener("click", async () => {
      const url = (manifestUrlInput?.value || "").trim();
      const diff = diffSelect?.value || "normal";
      if (!url) { alert("Enter a manifest URL first."); return; }
      try {
        await this.loadManifest(url, diff);
        this._help(`Loaded manifest: ${url} [${diff}]`);
      } catch (e) {
        console.error(e);
        alert("Failed to load manifest. Check the path and CORS.");
      }
    });

    // Open chart file directly
    const fileInput = document.getElementById(this.ids.fileOpenFileInput);
    document.getElementById(this.ids.fileOpenUseBtn)?.addEventListener("click", async () => {
      const f = fileInput?.files?.[0];
      if (!f) { alert("Choose a chart JSON file first."); return; }
      try {
        const text = await f.text();
        const obj = JSON.parse(text);
        if (!Array.isArray(obj.notes)) throw new Error("Invalid chart JSON (missing notes array).");
        this.chart = {
          bpm: obj.bpm || this.chart?.bpm || 120,
          lanes: obj.lanes || this.chart?.lanes || 4,
          durationMs: obj.durationMs || this.chart?.durationMs || 180000,
          notes: obj.notes
        };
        this.selection.clear();
        this._syncInputs();
        this._updateScrubMax();
        this._help(`Opened local chart file: ${f.name}`);
      } catch (e) {
        console.error(e);
        alert("Failed to open chart file: " + e.message);
      }
    });

    // Save As
    document.getElementById(this.ids.fileSaveAs)?.addEventListener("click", () => {
      this._downloadChart(this._suggestChartFilename());
    });
  }

  _suggestChartFilename() {
    const title = (this.manifest?.title || "chart").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const diff = this.difficulty || "normal";
    return `${title || "chart"}-${diff}.json`;
  }

  _downloadChart(filename = "chart.json") {
    const json = JSON.stringify(this.chart ?? { bpm: 120, lanes: 4, durationMs: 180000, notes: [] }, null, 2);
    this.onExport(json);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- Audio picker ----------
  _wireAudioPicker() {
    if (this._wiredAudio) return;
    this._wiredAudio = true;
    console.log("[Editor] wiring Audio picker");

    const urlInput = document.getElementById(this.ids.audioUrl);
    const loadUrlBtn = document.getElementById(this.ids.audioLoadUrl);
    const fileInput = document.getElementById(this.ids.audioFileInput);
    const useFileBtn = document.getElementById(this.ids.audioUseFileBtn);
    const applyManifest = document.getElementById(this.ids.audioApplyManifest);

    loadUrlBtn?.addEventListener("click", async () => {
      const url = (urlInput?.value || "").trim();
      if (!url) { alert("Enter an audio URL first."); return; }
      try {
        await this._ensureAudioCtx();
        await this._loadAudio(url);
        this._updateScrubMax();
        this._help("Loaded audio from URL.");
        if (applyManifest?.checked) {
          if (!this.manifest) this.manifest = { charts: {} };
          if (!this.manifest.audio) this.manifest.audio = {};
          if (url.toLowerCase().endsWith(".wav")) this.manifest.audio.wav = url;
          else this.manifest.audio.mp3 = url;
        }
      } catch (e) {
        console.error(e);
        alert("Failed to load audio from URL. Check the path and CORS.");
      }
    });

    useFileBtn?.addEventListener("click", async () => {
      const f = fileInput?.files?.[0];
      if (!f) { alert("Choose a file first."); return; }
      try {
        await this._ensureAudioCtx();
        const blobUrl = URL.createObjectURL(f); // preview
        await this._loadAudio(blobUrl);
        this._updateScrubMax();
        this._help("Loaded audio from file (preview via blob URL).");

        if (applyManifest?.checked) {
          if (!this.manifest) this.manifest = { charts: {} };
          if (!this.manifest.audio) this.manifest.audio = {};
          this.manifest.audio.mp3 = blobUrl; // preview only
          const hint = document.getElementById(this.ids.audioHint);
          if (hint) {
            hint.textContent = "Using a temporary blob URL for preview. Copy your file into /public/assets/music and update the manifest before publishing.";
          }
        }
      } catch (e) {
        console.error(e);
        alert("Failed to decode audio file.");
      }
    });
  }

  // ---------- Playback ----------
  async _ensureAudioCtx() {
    if (this.audioCtx) return;
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  async _fetchArrayBuffer(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
  }

  async _loadAudio(url) {
    if (!this.audioCtx) await this._ensureAudioCtx();

    let arrayBuffer;
    if (url.startsWith("blob:")) {
      // Some servers block fetch() on blob: URLs. Use XHR for reliability.
      arrayBuffer = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url);
        xhr.responseType = "arraybuffer";
        xhr.onload = () => resolve(xhr.response);
        xhr.onerror = () => reject(new Error("Blob fetch failed"));
        xhr.send();
      });
    } else {
      arrayBuffer = await this._fetchArrayBuffer(url);
    }

    this.audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);
    const audioMs = Math.floor(this.audioBuffer.duration * 1000);
    if (!this.chart) this.newChart({ durationMs: audioMs });
    if (!this.chart.durationMs || audioMs > this.chart.durationMs) {
      this.chart.durationMs = audioMs;
    }
  }

  _updateScrubMax() {
    const s = document.getElementById(this.ids.scrub);
    const ms = this.chart?.durationMs || Math.floor(this.audioBuffer?.duration * 1000) || 180000;
    if (s) { s.max = String(ms); }
  }

  currentTimeMs() {
    if (!this.playing) return this.playStartMs;
    const delta = (this.audioCtx.currentTime - this.playStartCtxTime) * 1000;
    return Math.max(0, this.playStartMs + delta);
  }

  play() {
    if (!this.audioBuffer) return;
    if (this.playing) this.stop();
    const startMs = Math.max(0, Math.min(this.playStartMs, this.chart.durationMs));
    const offset = startMs / 1000;
    this.audioSource = this.audioCtx.createBufferSource();
    this.audioSource.buffer = this.audioBuffer;
    this.audioSource.connect(this.audioCtx.destination);
    this.audioSource.start(0, offset);
    this.playStartCtxTime = this.audioCtx.currentTime;
    this.playStartMs = startMs;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.playStartMs = this.currentTimeMs();
    try { this.audioSource.stop(); } catch {}
    this.playing = false;
  }

  stop() {
    if (this.audioSource) { try { this.audioSource.stop(); } catch {} }
    this.audioSource = null;
    this.playing = false;
    this.playStartMs = 0;
  }

  seek(ms) {
    this.playStartMs = Math.max(0, Math.min(ms, this.chart.durationMs));
    if (this.playing) {
      this.pause(); this.play();
    }
  }

  // ---------- Input / Tools ----------
  _screenToLane(x) {
    const totalW = this.chart.lanes * this._laneW() + (this.chart.lanes - 1) * this._laneGap();
    const startX = (this.canvas.width / (window.devicePixelRatio || 1) - totalW) / 2;
    const w = this._laneW(), g = this._laneGap();
    const rel = x - startX;
    if (rel < 0) return 0;
    const lane = Math.floor(rel / (w + g));
    return Math.max(0, Math.min(this.chart.lanes - 1, lane));
  }

  _screenToMs(y) {
    const ms = (y + this.scrollY) / (this.pxPerMs * this.zoomY) * 1.0;
    return this._snapMs(ms);
  }

  _snapMs(ms) {
    if (!this.snap) return ms;
    const beatMs = 60000 / (this.chart.bpm || 120);
    const step = beatMs / Math.max(1, this.subdiv);
    return Math.round(ms / step) * step;
  }

  _pointerMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = e.clientX - rect.left;
    this.mouse.y = e.clientY - rect.top;
    this.mouse.lane = this._screenToLane(this.mouse.x);

    if (!this.drag) return;

    if (this.drag.type === "pan") {
      this.scrollY = Math.max(0, this.drag.startScrollY + (this.drag.startY - this.mouse.y) * 1.0);
    } else if (this.drag.type === "createHold") {
      const dMs = Math.max(0, this._screenToMs(this.mouse.y) - this.drag.baseMs);
      this.drag.tempNote.dMs = dMs;
    } else if (this.drag.type === "move") {
      const dMs = this._screenToMs(this.mouse.y) - this.drag.startMs;
      for (const idx of this.selection) {
        this.chart.notes[idx].tMs = this._clampMs(this.drag.orig[idx].tMs + dMs);
        this.chart.notes[idx].lane = Math.max(0, Math.min(this.chart.lanes - 1, this.drag.orig[idx].lane + (this.mouse.lane - this.drag.startLane)));
      }
    } else if (this.drag.type === "stretch") {
      const curMs = this._screenToMs(this.mouse.y);
      const idx = this.drag.stretchIdx;
      const n = this.chart.notes[idx];
      n.dMs = Math.max(0, curMs - n.tMs);
    }
  }

  _pointerDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    const lane = this.mouse.lane;
    const tMs = this._screenToMs(this.mouse.y);

    if (e.button === 1 || e.ctrlKey) {
      this.drag = { type: "pan", startY: this.mouse.y, startScrollY: this.scrollY };
      return;
    }

    if (this.tool === "create") {
      const note = { tMs, lane };
      this.chart.notes.push(note);
      this.selection.clear();
      const idx = this.chart.notes.length - 1;
      this.selection.add(idx);
      this.drag = { type: "createHold", baseMs: tMs, tempNote: note };
    } else if (this.tool === "select") {
      const hitIdx = this._hitTest(tMs, lane);
      if (hitIdx >= 0) {
        if (!this.selection.has(hitIdx)) {
          if (!e.shiftKey) this.selection.clear();
          this.selection.add(hitIdx);
        }
        const orig = {};
        for (const i of this.selection) orig[i] = { tMs: this.chart.notes[i].tMs, lane: this.chart.notes[i].lane };
        this.drag = { type: "move", startMs: tMs, startLane: lane, orig };
      } else {
        this.drag = { type: "pan", startY: this.mouse.y, startScrollY: this.scrollY };
        if (!e.shiftKey) this.selection.clear();
      }
    } else if (this.tool === "stretch") {
      const hitIdx = this._hitTest(tMs, lane);
      if (hitIdx >= 0) {
        const n = this.chart.notes[hitIdx];
        if (!n.dMs) n.dMs = 0;
        this.selection.clear(); this.selection.add(hitIdx);
        this.drag = { type: "stretch", stretchIdx: hitIdx };
      }
    } else if (this.tool === "delete") {
      const hitIdx = this._hitTest(tMs, lane);
      if (hitIdx >= 0) {
        this.chart.notes.splice(hitIdx, 1);
        this.selection = new Set([...this.selection].filter(i => i !== hitIdx).map(i => i > hitIdx ? i - 1 : i));
      }
    } else if (this.tool === "copy") {
      this._copySelection();
      this._help("Copied.");
    } else if (this.tool === "paste") {
      this._pasteAt(tMs, lane);
    }
  }

  _pointerUp(e) {
    if (this.drag?.type === "createHold") {
      const n = this.drag.tempNote;
      if (n.dMs && n.dMs < 10) delete n.dMs;
    }
    this.drag = null;
  }

  _hitTest(tMs, lane) {
    let best = -1, bestDt = 9999;
    for (let i = 0; i < this.chart.notes.length; i++) {
      const n = this.chart.notes[i];
      if (n.lane !== lane) continue;
      const dt = Math.abs(n.tMs - tMs);
      if (dt < 80 && dt < bestDt) { best = i; bestDt = dt; }
      if (n.dMs && Math.abs(n.tMs + n.dMs - tMs) < 80 && 60 < bestDt) { best = i; bestDt = 60; }
    }
    return best;
  }

  _copySelection() {
    const arr = [...this.selection].sort((a, b) => a - b).map(i => ({ ...this.chart.notes[i] }));
    this.clipboard = arr;
  }

  _pasteAt(tMs, lane) {
    if (!this.clipboard.length) { this._help("Clipboard empty."); return; }
    const minT = Math.min(...this.clipboard.map(n => n.tMs));
    const laneOffset = lane - this.clipboard[0].lane;
    const pasted = this.clipboard.map(n => ({
      tMs: this._clampMs(tMs + (n.tMs - minT)),
      lane: Math.max(0, Math.min(this.chart.lanes - 1, n.lane + laneOffset)),
      dMs: n.dMs
    }));
    const startIdx = this.chart.notes.length;
    this.chart.notes.push(...pasted);
    this.selection = new Set(pasted.map((_, i) => startIdx + i));
  }

  _clampMs(ms) {
    return Math.max(0, Math.min(ms, this.chart.durationMs));
  }

  // ---------- Drawing ----------
  _tick() {
    this._draw();
    requestAnimationFrame(this._tick);
  }

  _resize() {
    const ratio = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 1200;
    const h = this.canvas.clientHeight || 700;
    this.canvas.width = Math.floor(w * ratio);
    this.canvas.height = Math.floor(h * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  _laneW() { return Math.max(110, Math.min(160, Math.floor((this.canvas.width / (window.devicePixelRatio || 1)) / 10))); }
  _laneGap() { return Math.max(18, Math.min(28, Math.floor((this.canvas.width / (window.devicePixelRatio || 1)) / 80))); }

  _draw() {
    const ctx = this.ctx;
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);

    // bg
    ctx.fillStyle = this.colors.bg;
    ctx.fillRect(0, 0, w, h);

    if (!this.chart) return;

    // lanes
    const L = this.chart.lanes;
    const laneW = this._laneW(), gap = this._laneGap();
    const totalW = L * laneW + (L - 1) * gap;
    const startX = (w - totalW) / 2;

    for (let i = 0; i < L; i++) {
      const x = startX + i * (laneW + gap);
      ctx.fillStyle = this.colors.laneFill;
      ctx.strokeStyle = this.colors.laneStroke;
      ctx.lineWidth = 2;
      this._roundRect(ctx, x, 16, laneW, h - 32, 16, true);
    }

    // grid
    const bpm = this.chart.bpm || 120;
    const beatMs = 60000 / bpm;
    const stepMs = beatMs / Math.max(1, this.subdiv);
    const pxPerMs = this.pxPerMs * this.zoomY;

    const startMs = this.scrollY / pxPerMs * 1.0;
    const endMs = startMs + h / pxPerMs;
    const firstBeat = Math.floor(startMs / beatMs);
    const lastBeat = Math.ceil(endMs / beatMs);

    for (let b = firstBeat; b <= lastBeat; b++) {
      const y = Math.floor(b * beatMs * pxPerMs - this.scrollY);
      ctx.strokeStyle = (b % 10 === 0) ? this.colors.gridDecade : this.colors.gridMajor;
      ctx.lineWidth = (b % 10 === 0) ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(startX - 12, y);
      ctx.lineTo(startX + totalW + 12, y);
      ctx.stroke();

      if (b < lastBeat) {
        for (let s = 1; s < this.subdiv; s++) {
          const yy = Math.floor((b * beatMs + s * stepMs) * pxPerMs - this.scrollY);
          ctx.strokeStyle = this.colors.gridMinor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(startX, yy);
          ctx.lineTo(startX + totalW, yy);
          ctx.stroke();
        }
      }
    }

    // notes
    const headH = 28;
    const headW = Math.max(26, laneW - 18);

    for (let i = 0; i < this.chart.notes.length; i++) {
      const n = this.chart.notes[i];
      const x = startX + n.lane * (laneW + gap) + (laneW - headW) / 2;
      const y = Math.floor(n.tMs * pxPerMs - this.scrollY);

      if (n.dMs && n.dMs > 0) {
        const len = Math.max(6, n.dMs * pxPerMs);
        ctx.fillStyle = this.colors.holdBody;
        this._roundRect(ctx, x + (headW - 12) / 2, y + headH - 2, 12, len, 6, true);
      }

      ctx.fillStyle = this.colors.noteHead;
      ctx.strokeStyle = this.colors.noteHeadStroke;
      ctx.lineWidth = 2;
      this._roundRect(ctx, x, y, headW, headH, 10, true);

      if (this.selection.has(i)) {
        ctx.strokeStyle = this.colors.selection;
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 2, y - 2, headW + 4, headH + 4);
      }
    }

    // playhead
    const phY = Math.floor(this.currentTimeMs() * pxPerMs - this.scrollY);
    ctx.strokeStyle = this.colors.playhead;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(startX - 16, phY);
    ctx.lineTo(startX + totalW + 16, phY);
    ctx.stroke();

    // footer info
    const t = document.getElementById(this.ids.time);
    if (t) t.textContent = `${Math.floor(this.currentTimeMs() / 1000)}s / ${Math.floor((this.chart.durationMs || 0) / 1000)}s`;

    const s = document.getElementById(this.ids.scrub);
    if (s && !s.matches(":active")) s.value = String(Math.floor(this.currentTimeMs()));
  }

  _roundRect(ctx, x, y, w, h, r, fill = true) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    if (fill) ctx.fill(); else ctx.stroke();
  }

  _onWheel(e) {
    if (e.shiftKey) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.08 : 0.92;
      this.zoomY = Math.max(0.25, Math.min(3, this.zoomY * factor));
    } else {
      this.scrollY = Math.max(0, this.scrollY + e.deltaY);
    }
  }

  _syncInputs() {
    const bpmEl = document.getElementById(this.ids.bpm);
    const subEl = document.getElementById(this.ids.subdiv);
    const lanesEl = document.getElementById(this.ids.lanes);
    if (bpmEl) bpmEl.value = String(this.chart?.bpm ?? 120);
    if (subEl) subEl.value = String(this.subdiv);
    if (lanesEl) lanesEl.value = String(this.chart?.lanes ?? 4);
  }

  _help(msg) {
    const el = document.getElementById(this.ids.help);
    if (el) el.textContent = msg;
  }
}
