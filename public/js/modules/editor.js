// public/js/modules/editor.js
// PulseForge Chart Editor – precise hit testing, no-snap selection, overlap guards, keyboard transport, box-select
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
    this.chart = null; // { bpm, durationMs, lanes, notes:[{tMs,lane,dMs?}] }
    this.chartUrl = null;
    this.difficulty = "normal";

    // View/scroll
    this.zoomY = 1.0;
    this.scrollY = 0; // px from 0ms
    this.pxPerMs = 0.35;

    // Optional tiny visual nudge if you perceive flash vs audio offset (ms)
    this.editorLatencyMs = 0; // try +10 / -10 if you notice a tiny drift

    // Tools & selection
    this.tool = "create"; // create | select | stretch | delete | copy | paste
    this.subdiv = 4;
    this.snap = true;
    this.selection = new Set();
    this.clipboard = [];
    this.drag = null; // {type, ...}
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
      playhead: "#25f4ee",
      boxSelect: "rgba(255, 209, 102, 0.16)",
      boxSelectBorder: "#ffd166"
    };

    // Guards to wire only once
    this._wiredAudio = false;
    this._wiredFile = false;

    // Placement helpers
    this.minGapMs = 60;           // minimal lane spacing for heads/tails
    this.headH = 28;              // draw height of a tap/hold head
    this.headPad = 10;            // corner radius for head
    this.tailHandlePadMs = 90;    // click tolerance around tail time to stretch

    // Bind
    this._tick = this._tick.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._resize = this._resize.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);

    // Size & listeners
    this._resize();
    window.addEventListener("resize", this._resize);

    // Block page scrolling when using the editor canvas
    this.canvas.addEventListener("wheel", this._onWheel, { passive: false });
    this.canvas.addEventListener("mousedown", e => {
      if (e.button === 1) e.preventDefault(); // middle-drag pan without autoscroll
    });

    window.addEventListener("keydown", this._onKeyDown);

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

    // Ensure pickers wired
    this._wireAudioPicker();
    this._wireFileToolbar();
  }

  /** Wire all UI pieces; safe to call even on blank start. */
  mountToolbar() {
    // Tool button baseline styling (if no classes provided)
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

    this._wireAudioPicker();
    this._wireFileToolbar();
  }

  // ---------- File toolbar ----------
  _wireFileToolbar() {
    if (this._wiredFile) return;
    this._wiredFile = true;

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

  // ---------- Placement helpers ----------
  _rangesOverlap(start, end, s, e) {
    const A0 = Math.min(start, end);
    const A1 = Math.max(start, end);
    const B0 = Math.min(s, e);
    const B1 = Math.max(s, e);
    return !(A1 + this.minGapMs <= B0 || B1 + this.minGapMs <= A0);
  }

  /** Check if a note can be placed in a lane (no overlaps). */
  _canPlaceNote(lane, tMs, dMs = 0, ignoreIdxSet = new Set()) {
    if (!this.chart || !Array.isArray(this.chart.notes)) return { ok: true, conflictIdx: -1 };
    const start = tMs;
    const end = tMs + Math.max(0, dMs);

    let next = null;
    for (let i = 0; i < this.chart.notes.length; i++) {
      if (ignoreIdxSet.has(i)) continue;
      const n = this.chart.notes[i];
      if (n.lane !== lane) continue;

      if (Math.abs(n.tMs - tMs) < this.minGapMs) return { ok: false, conflictIdx: i };

      const ns = n.tMs, ne = n.tMs + Math.max(0, n.dMs || 0);
      if ((n.dMs || 0) > 0 || dMs > 0) {
        if (this._rangesOverlap(start, end, ns, ne)) return { ok: false, conflictIdx: i };
      }

      if (n.tMs > tMs && (!next || n.tMs < next.tMs)) next = { ...n, idx: i };
    }

    if (dMs > 0 && next) {
      const maxEnd = next.tMs - this.minGapMs;
      if (end > maxEnd) return { ok: true, conflictIdx: -1, cappedEndMs: Math.max(start, maxEnd) };
    }

    return { ok: true, conflictIdx: -1 };
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

  /** Raw (no-snap) ms from a screen y. */
  _screenToMsRaw(y) {
    return (y + this.scrollY) / (this.pxPerMs * this.zoomY) * 1.0;
  }

  _screenToMs(y) {
    return this._snapMs(this._screenToMsRaw(y));
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
      const curMs = this._screenToMs(this.mouse.y);
      let dMs = Math.max(0, curMs - this.drag.baseMs);
      const ignore = new Set([this.chart.notes.length - 1]); // temp note
      const chkTail = this._canPlaceNote(this.drag.lane, this.drag.baseMs, dMs, ignore);
      if (chkTail.cappedEndMs !== undefined) dMs = Math.max(0, chkTail.cappedEndMs - this.drag.baseMs);
      this.drag.tempNote.dMs = dMs;

    } else if (this.drag.type === "move") {
      const dMs = this._screenToMs(this.mouse.y) - this.drag.startMs;
      const dLane = this.mouse.lane - this.drag.startLane;
      const ignore = new Set(this.selection);
      let ok = true;
      const proposals = [];

      for (const idx of this.selection) {
        const orig = this.drag.orig[idx];
        const newLane = Math.max(0, Math.min(this.chart.lanes - 1, orig.lane + dLane));
        const newStart = this._clampMs(orig.tMs + dMs);
        const n = this.chart.notes[idx];
        const newDur = Math.max(0, n.dMs || 0);
        const chk = this._canPlaceNote(newLane, newStart, newDur, ignore);
        if (!chk.ok) { ok = false; break; }
        proposals.push({ idx, lane: newLane, tMs: newStart });
      }
      if (!ok) { this._help("Move blocked by overlap on same lane."); return; }
      for (const p of proposals) {
        const nn = this.chart.notes[p.idx];
        nn.lane = p.lane; nn.tMs = p.tMs;
      }

    } else if (this.drag.type === "stretch") {
      const idx = this.drag.stretchIdx;
      const n = this.chart.notes[idx];
      const curMs = this._screenToMs(this.mouse.y);
      let proposed = Math.max(0, curMs - n.tMs);
      const chk = this._canPlaceNote(n.lane, n.tMs, proposed, new Set([idx]));
      if (chk.cappedEndMs !== undefined) proposed = Math.max(0, chk.cappedEndMs - n.tMs);
      n.dMs = Math.max(0, Math.min(proposed, this.chart.durationMs - n.tMs));

    } else if (this.drag.type === "boxSelect") {
      // Update marquee end
      this.drag.endX = this.mouse.x;
      this.drag.endY = this.mouse.y;

      // Recompute hovered set (no snap; pure geometry)
      const box = this._normalizedBox(this.drag.startX, this.drag.startY, this.drag.endX, this.drag.endY);
      const hitSet = this._notesInBox(box);

      // Live preview (don’t commit yet)
      if (this.drag.additive) {
        // additive preview = union of current selection and hits
        this._previewSelection = new Set([...this.selection, ...hitSet]);
      } else {
        this._previewSelection = hitSet;
      }
    }
  }

  _pointerDown(e) {
    e.preventDefault(); // avoid text selection / page drag
    this.canvas.setPointerCapture(e.pointerId);
    const lane = this.mouse.lane;
    const tMsSnap = this._screenToMs(this.mouse.y);   // snapped for placement

    // Middle or Ctrl -> pan
    if (e.button === 1 || e.ctrlKey) {
      this.drag = { type: "pan", startY: this.mouse.y, startScrollY: this.scrollY };
      return;
    }

    if (this.tool === "create") {
      const chk = this._canPlaceNote(lane, tMsSnap, 0, new Set());
      if (!chk.ok) { this._help("Cannot place note here (overlap on same lane)."); return; }
      const note = { tMs: tMsSnap, lane };
      this.chart.notes.push(note);
      this.selection.clear();
      const idx = this.chart.notes.length - 1;
      this.selection.add(idx);
      this.drag = { type: "createHold", baseMs: tMsSnap, tempNote: note, lane };

    } else if (this.tool === "select" || this.tool === "stretch" || this.tool === "delete") {
      const hit = this._hitTestRect(this.mouse.x, this.mouse.y);
      if (hit.idx >= 0) {
        if (this.tool === "delete") {
          this.chart.notes.splice(hit.idx, 1);
          this.selection = new Set([...this.selection].filter(i => i !== hit.idx).map(i => i > hit.idx ? i - 1 : i));
          return;
        }
        // select (click)
        if (!this.selection.has(hit.idx)) {
          if (!e.shiftKey) this.selection.clear();
          this.selection.add(hit.idx);
        }

        if (this.tool === "stretch" || hit.onTail) {
          const n = this.chart.notes[hit.idx];
          if (!n.dMs) n.dMs = 0;
          this.selection.clear(); this.selection.add(hit.idx);
          this.drag = { type: "stretch", stretchIdx: hit.idx };
        } else {
          // move
          const orig = {};
          for (const i of this.selection) orig[i] = { tMs: this.chart.notes[i].tMs, lane: this.chart.notes[i].lane };
          this.drag = { type: "move", startMs: tMsSnap, startLane: lane, orig };
        }
      } else {
        // Empty space:
        if (this.tool === "select") {
          // Begin marquee selection (Shift => additive)
          this._previewSelection = null;
          this.drag = {
            type: "boxSelect",
            startX: this.mouse.x,
            startY: this.mouse.y,
            endX: this.mouse.x,
            endY: this.mouse.y,
            additive: !!e.shiftKey
          };
        } else {
          // Other tools: pan on empty space
          this.drag = { type: "pan", startY: this.mouse.y, startScrollY: this.scrollY };
        }
      }

    } else if (this.tool === "copy") {
      this._copySelection(); this._help("Copied.");

    } else if (this.tool === "paste") {
      this._pasteAt(tMsSnap, lane);
    }
  }

  _pointerUp(e) {
    if (this.drag?.type === "createHold") {
      const n = this.drag.tempNote;
      if (n.dMs && n.dMs < 10) delete n.dMs; // tiny drag becomes tap
    } else if (this.drag?.type === "boxSelect") {
      // Commit the marquee selection
      const box = this._normalizedBox(this.drag.startX, this.drag.startY, this.drag.endX, this.drag.endY);
      const hitSet = this._notesInBox(box);
      if (this.drag.additive) {
        for (const i of hitSet) this.selection.add(i);
      } else {
        this.selection = hitSet;
      }
      this._previewSelection = null;
    }
    this.drag = null;
  }

  /**
   * Rectangle hit test for the note head and hold body/tail.
   * Returns { idx, onTail } or { idx:-1, onTail:false }
   */
  _hitTestRect(mouseX, mouseY) {
    if (!this.chart) return { idx: -1, onTail: false };

    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const laneW = this._laneW(), gap = this._laneGap();
    const totalW = this.chart.lanes * laneW + (this.chart.lanes - 1) * gap;
    const startX = (w - totalW) / 2;
    const pxPerMs = this.pxPerMs * this.zoomY;

    const headW = Math.max(26, laneW - 18);
    const tMsAtPointer = this._screenToMsRaw(mouseY);

    let best = { idx: -1, onTail: false, score: 1e9 };

    for (let i = 0; i < this.chart.notes.length; i++) {
      const n = this.chart.notes[i];
      const laneX = startX + n.lane * (laneW + gap);
      const x = laneX + (laneW - headW) / 2;
      const y = n.tMs * pxPerMs - this.scrollY;

      // head rect
      const hx0 = x, hx1 = x + headW;
      const hy0 = y, hy1 = y + this.headH;

      const inHead = (mouseX >= hx0 && mouseX <= hx1 && mouseY >= hy0 && mouseY <= hy1);

      // body rect (AFTER the head)
      let inBody = false, onTail = false;
      if (n.dMs && n.dMs > 0) {
        const len = Math.max(6, n.dMs * pxPerMs);
        const bx0 = x + (headW - 12) / 2, bx1 = bx0 + 12;
        const by0 = y + this.headH - 2, by1 = by0 + len; // after the head (downward)
        inBody = (mouseX >= bx0 && mouseX <= bx1 && mouseY >= by0 && mouseY <= by1);

        // tail handle near the AFTER time
        const tailMs = n.tMs + n.dMs;
        if (Math.abs(tMsAtPointer - tailMs) <= this.tailHandlePadMs) {
          onTail = true;
        }
      }

      if (inHead || inBody || onTail) {
        const score = Math.abs(n.tMs - tMsAtPointer);
        if (score < best.score) best = { idx: i, onTail };
      }
    }

    return { idx: best.idx, onTail: best.onTail || false };
  }

  _copySelection() {
    const arr = [...this.selection].sort((a, b) => a - b).map(i => ({ ...this.chart.notes[i] }));
    this.clipboard = arr;
  }

  _pasteAt(tMs, lane) {
    if (!this.clipboard.length) { this._help("Clipboard empty."); return; }

    const minT = Math.min(...this.clipboard.map(n => n.tMs));
    const laneOffset = lane - this.clipboard[0].lane;

    const startIdx = this.chart.notes.length;
    let added = 0;

    for (const src of this.clipboard) {
      const newStart = this._clampMs(tMs + (src.tMs - minT));
      const newLane  = Math.max(0, Math.min(this.chart.lanes - 1, src.lane + laneOffset));
      const newDur   = Math.max(0, src.dMs || 0);

      const chk = this._canPlaceNote(newLane, newStart, newDur, new Set());
      if (!chk.ok) continue;

      const note = { tMs: newStart, lane: newLane };
      if (newDur > 0) note.dMs = newDur;
      this.chart.notes.push(note);
      added++;
    }

    if (added === 0) { this._help("Nothing pasted due to overlaps."); return; }

    this.selection.clear();
    for (let i = startIdx; i < this.chart.notes.length; i++) this.selection.add(i);
    this._help(`Pasted ${added} note(s).`);
  }

  _clampMs(ms) { return Math.max(0, Math.min(ms, this.chart.durationMs)); }

  // ---------- Box select helpers ----------
  _normalizedBox(x0, y0, x1, y1) {
    const left = Math.min(x0, x1), right = Math.max(x0, x1);
    const top = Math.min(y0, y1), bottom = Math.max(y0, y1);
    return { left, right, top, bottom };
  }

  _rectsOverlap(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1) {
    return ax0 <= bx1 && ax1 >= bx0 && ay0 <= by1 && ay1 >= by0;
  }

  /** Return a Set of note indices intersecting the marquee box */
  _notesInBox(box) {
    const result = new Set();
    if (!this.chart) return result;

    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const laneW = this._laneW(), gap = this._laneGap();
    const totalW = this.chart.lanes * laneW + (this.chart.lanes - 1) * gap;
    const startX = (w - totalW) / 2;
    const pxPerMs = this.pxPerMs * this.zoomY;
    const headW = Math.max(26, laneW - 18);

    for (let i = 0; i < this.chart.notes.length; i++) {
      const n = this.chart.notes[i];
      const laneX = startX + n.lane * (laneW + gap);
      const x = laneX + (laneW - headW) / 2;
      const y = n.tMs * pxPerMs - this.scrollY;

      // head rect
      const hx0 = x, hx1 = x + headW;
      const hy0 = y, hy1 = y + this.headH;
      let hit = this._rectsOverlap(hx0, hy0, hx1, hy1, box.left, box.top, box.right, box.bottom);

      // body (after the head)
      if (!hit && n.dMs && n.dMs > 0) {
        const len = Math.max(6, n.dMs * pxPerMs);
        const bx0 = x + (headW - 12) / 2, bx1 = bx0 + 12;
        const by0 = y + this.headH - 2, by1 = by0 + len;
        hit = this._rectsOverlap(bx0, by0, bx1, by1, box.left, box.top, box.right, box.bottom);
      }

      if (hit) result.add(i);
    }
    return result;
  }

  // ---------- Drawing ----------
  _tick() { this._draw(); requestAnimationFrame(this._tick); }

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
    const headH = this.headH;
    const headW = Math.max(26, laneW - 18);

    const now = this.currentTimeMs() + this.editorLatencyMs;
    const flashWindow = 40; // ms

    for (let i = 0; i < this.chart.notes.length; i++) {
      const n = this.chart.notes[i];
      const x = startX + n.lane * (laneW + gap) + (laneW - headW) / 2;
      const y = Math.floor(n.tMs * pxPerMs - this.scrollY);

      // Hold body AFTER the head (downward)
      if (n.dMs && n.dMs > 0) {
        const len = Math.max(6, n.dMs * pxPerMs);
        ctx.fillStyle = this.colors.holdBody;
        this._roundRect(ctx, x + (headW - 12) / 2, y + headH - 2, 12, len, 6, true);
      }

      // flash head near playhead
      const flash = Math.abs(n.tMs - now) <= flashWindow;
      ctx.fillStyle = flash ? "#ffffff" : this.colors.noteHead;
      ctx.strokeStyle = flash ? "#ffffff" : this.colors.noteHeadStroke;
      ctx.lineWidth = 2;
      this._roundRect(ctx, x, y, headW, headH, this.headPad, true);

      const selected = this._previewSelection ? this._previewSelection.has(i) : this.selection.has(i);
      if (selected) {
        ctx.strokeStyle = this.colors.selection;
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 2, y - 2, headW + 4, headH + 4);
      }
    }

    // playhead
    const phY = Math.floor(now * pxPerMs - this.scrollY);
    ctx.strokeStyle = this.colors.playhead;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(startX - 16, phY);
    ctx.lineTo(startX + totalW + 16, phY);
    ctx.stroke();

    // marquee rectangle preview
    if (this.drag?.type === "boxSelect") {
      const box = this._normalizedBox(this.drag.startX, this.drag.startY, this.drag.endX, this.drag.endY);
      ctx.fillStyle = this.colors.boxSelect;
      ctx.strokeStyle = this.colors.boxSelectBorder;
      ctx.lineWidth = 1.5;
      ctx.fillRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
      ctx.strokeRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
    }

    // footer info
    const t = document.getElementById(this.ids.time);
    if (t) t.textContent = `${Math.floor((this.currentTimeMs()) / 1000)}s / ${Math.floor((this.chart.durationMs || 0) / 1000)}s`;

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
    // Keep the page still while interacting with canvas
    e.preventDefault();
    e.stopPropagation();

    if (e.shiftKey) {
      const factor = e.deltaY < 0 ? 1.08 : 0.92;
      this.zoomY = Math.max(0.25, Math.min(3, this.zoomY * factor));
    } else {
      this.scrollY = Math.max(0, this.scrollY + e.deltaY);
    }
  }

  async _onKeyDown(e) {
    // Only act when the editor screen is visible
    const scr = document.getElementById("screen-editor");
    const active = scr && scr.classList.contains("active");
    if (!active) return;

    // Ignore if typing
    const tag = (e.target?.tagName || "").toUpperCase();
    if (e.target?.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    // Space: toggle
    if (e.code === "Space" || e.key === " ") {
      e.preventDefault();
      await this._ensureAudioCtx();
      if (this.audioCtx?.state === "suspended") { try { await this.audioCtx.resume(); } catch {} }
      if (!this.audioBuffer) return;
      if (this.playing) this.pause(); else this.play();
      return;
    }

    // Left / Right: nudge by 50 ms (hold Shift for 10x)
    const step = (e.shiftKey ? 500 : 50);
    if (e.code === "ArrowRight") {
      e.preventDefault();
      this.seek(Math.min((this.chart?.durationMs || 0), this.currentTimeMs() + step));
    } else if (e.code === "ArrowLeft") {
      e.preventDefault();
      this.seek(Math.max(0, this.currentTimeMs() - step));
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
