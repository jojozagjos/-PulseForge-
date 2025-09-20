// public/js/modules/solo.js
export class Solo {
  constructor(settings) {
    this.settings = settings || {};
    this.tracks = [];
    this.filtered = [];
    this.selected = null;
    this.selectedDiff = null;

    // caches & refs
    this._els = {};
    this._chartCache = new Map(); // key: `${trackId}::${diff}` -> chart json
    this._pbCache = new Map();    // key: `${trackId}::${diff}` -> pb row or null
    this._observer = null;        // IntersectionObserver for lazy covers

    // Preview audio graph (ctx + master gain + current src)
    this._previewAudio = {
      ctx: null,
      master: null,  // GainNode
      src: null,     // current BufferSource
      playing: false,
      volHandler: null
    };

    // guard cleanup when leaving Solo
    this._guards = [];

    // restore last pick (if any)
    try {
      const saved = JSON.parse(localStorage.getItem("pf:lastPick") || "null");
      this._lastPick = saved && typeof saved === "object" ? saved : null;
    } catch { this._lastPick = null; }

    // Service worker is optional. If /sw.js 404s you'll still be fine.
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }

  async mount() {
    const list = document.getElementById("track-list");
    const playBtn = document.getElementById("btn-play-solo");
    const backBtn = document.getElementById("btn-back-from-solo");
    if (!list || !playBtn) return;

    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Song list");

    // Hide Play until a track is chosen (Play enables once a diff is selected/auto-selected)
    playBtn.style.display = "none";
    playBtn.disabled = true;

    this._ensureToolbar(list);
    this._ensurePreview(list);
    this._setupCoverObserver();
    this._setupAutoStopGuards();   // <-- important

    // Load tracks
    const res = await fetch("/api/tracks").then(r => r.json()).catch(() => []);
    this.tracks = Array.isArray(res) ? res : [];
    this._applyFilterAndRender(); // populates list

    // Restore last pick if possible
    if (this._lastPick) {
      const i = this.tracks.findIndex(t => t.trackId === this._lastPick.trackId);
      if (i >= 0) this._selectTrack(this.tracks[i], { auto: true, preferDiff: this._lastPick.diff });
    }

    playBtn.addEventListener("click", () => this._startSelected());

    // Also stop preview when user leaves Solo via back
    backBtn?.addEventListener("click", () => {
      this._stopPreview("back-btn");
      this._clearSelection();
    });

    this._wireKeyboard();
    this._wireGamepad();
  }

  // ---------- UI skeletons ----------
  _ensureToolbar(listEl) {
    if (document.getElementById("solo-toolbar")) return;

    const row = document.createElement("div");
    row.id = "solo-toolbar";
    Object.assign(row.style, {
      display: "flex", gap: "8px", alignItems: "center",
      margin: "8px 0 12px 0", flexWrap: "wrap"
    });

    // Search (title/artist only)
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Search by title or artist…";
    Object.assign(search.style, {
      flex: "1 1 280px", padding: "8px 10px", borderRadius: "8px",
      border: "1px solid #2a3142", background: "#111725", color: "#e8eefc"
    });
    search.addEventListener("input", () => {
      this._els.error.textContent = "";
      this._applyFilterAndRender(search.value, this._els.sort.value);
    });

    // Sort (title / artist only — no BPM)
    const sort = document.createElement("select");
    Object.assign(sort.style, {
      padding: "8px 10px", borderRadius: "8px", border: "1px solid #2a3142",
      background: "#111725", color: "#e8eefc"
    });
    sort.innerHTML = `
      <option value="title">Sort: Title</option>
      <option value="artist">Sort: Artist</option>
    `;
    sort.addEventListener("change", () => {
      this._els.error.textContent = "";
      this._applyFilterAndRender(this._els.search.value, sort.value);
    });

    const err = document.createElement("div");
    Object.assign(err.style, { color: "#e86d7b", fontSize: "12px" });

    row.appendChild(search);
    row.appendChild(sort);
    row.appendChild(err);
    listEl.insertAdjacentElement("beforebegin", row);

    this._els.toolbar = row;
    this._els.search = search;
    this._els.sort = sort;
    this._els.error = err;
  }

  _ensurePreview(listEl) {
    let preview = document.getElementById("track-preview");
    if (preview) {
      this._cachePreviewRefs(preview);
      return;
    }

    preview = document.createElement("div");
    preview.id = "track-preview";
    Object.assign(preview.style, {
      marginTop: "16px",
      display: "grid",
      gridTemplateColumns: "minmax(240px, 420px) 1fr",
      gap: "16px",
      alignItems: "start"
    });

    // ART
    const artWrap = document.createElement("div");
    Object.assign(artWrap.style, {
      width: "100%",
      maxWidth: "420px",
      aspectRatio: "1 / 1",
      background: "#0a0c10",
      border: "1px solid #2a3142",
      borderRadius: "12px",
      overflow: "hidden",
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    });

    const img = document.createElement("img");
    img.id = "tp-cover";
    img.alt = "Cover art";
    Object.assign(img.style, {
      width: "100%", height: "100%", objectFit: "contain", display: "block", visibility: "hidden"
    });
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.style.visibility = "hidden";
      artWrap.style.background = "linear-gradient(135deg,#1b2335,#0f1420)";
    });
    artWrap.appendChild(img);

    // META
    const meta = document.createElement("div");
    meta.innerHTML = `
      <div id="tp-title" style="font-weight:600;font-size:20px;line-height:24px;margin:2px 0 4px 0;"></div>
      <div id="tp-artist" class="muted" style="opacity:.9;margin-bottom:6px;"></div>
      <div id="tp-extra" class="muted" style="opacity:.8;margin-bottom:10px;"></div>

      <div id="solo-diff-wrap" role="listbox" aria-label="Difficulties"
           style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;min-height:36px;margin:6px 0 4px 0;"></div>

      <div id="tp-stats" class="muted" style="opacity:.9;margin-top:6px;min-height:18px;"></div>

      <div id="tp-actions" style="display:flex;gap:8px;margin-top:10px;">
        <button id="tp-preview" class="ghost" type="button">Preview 10s</button>
      </div>
    `;

    preview.appendChild(artWrap);
    preview.appendChild(meta);
    listEl.insertAdjacentElement("afterend", preview);

    this._cachePreviewRefs(preview);
    this._els.previewBtn.addEventListener("click", () => this._togglePreviewAudio());
  }

  _cachePreviewRefs(preview) {
    this._els.preview = preview;
    this._els.cover = preview.querySelector("#tp-cover");
    this._els.title = preview.querySelector("#tp-title");
    this._els.artist = preview.querySelector("#tp-artist");
    this._els.extra = preview.querySelector("#tp-extra");
    this._els.diffWrap = preview.querySelector("#solo-diff-wrap");
    this._els.pb = preview.querySelector("#tp-stats");
    this._els.previewBtn = preview.querySelector("#tp-preview");
    this._els.playBtn = document.getElementById("btn-play-solo");
  }

  // ---------- Render list ----------
  _applyFilterAndRender(q = "", sortKey = "title") {
    const needle = (q || "").trim().toLowerCase();

    // Search only title/artist
    const rows = needle
      ? this.tracks.filter(t =>
          (t.title || "").toLowerCase().includes(needle) ||
          (t.artist || "").toLowerCase().includes(needle))
      : this.tracks.slice();

    // Sort by title/artist only
    rows.sort((a, b) => {
      const ak = (a[sortKey] || "").toLowerCase();
      const bk = (b[sortKey] || "").toLowerCase();
      return ak.localeCompare(bk);
    });

    this.filtered = rows;
    this._renderList();
  }

  _renderList() {
    const list = document.getElementById("track-list");
    if (!list) return;

    list.innerHTML = "";
    for (const t of this.filtered) {
      const div = document.createElement("div");
      div.className = "track";
      div.setAttribute("role", "option");
      div.setAttribute("aria-label", `${t.title || "Untitled"} by ${t.artist || "Unknown"}`);

      // cover image (lazy)
      const cover = document.createElement("div");
      cover.className = "cover";
      const img = document.createElement("img");
      img.alt = `${t.title || "Cover"}`;
      img.loading = "lazy";
      img.dataset.src = t.cover || "";
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = "cover";
      img.addEventListener("error", () => { img.removeAttribute("src"); cover.style.background = "#182134"; });
      cover.appendChild(img);

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.innerHTML = `
        <div><b>${escapeHtml(t.title || "Untitled")}</b></div>
        <div class="muted">${escapeHtml(t.artist || "")}</div>
        <div class="muted">${t.bpm ? `${Number(t.bpm)} BPM` : ""}</div>
      `;

      div.appendChild(cover);
      div.appendChild(meta);

      div.addEventListener("click", () => {
        // stop any ongoing preview before switching track
        this._stopPreview("switch-track");
        this._selectTrack(t, { auto: true });
      });

      list.appendChild(div);
      if (this._observer) this._observer.observe(img);
    }
  }

  _setupCoverObserver() {
    if (!("IntersectionObserver" in window)) return;
    this._observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const img = e.target;
          const src = img.dataset.src;
          if (src && !img.src) img.src = src;
          this._observer.unobserve(img);
        }
      }
    }, { rootMargin: "150px" });
  }

  // ---------- Track & preview ----------
  async _selectTrack(track, { auto = false, preferDiff = null } = {}) {
    // visuals
    document.querySelectorAll("#track-list .track").forEach(el => {
      el.classList.remove("sel");
      el.setAttribute("aria-selected", "false");
    });
    const idx = this.filtered.indexOf(track);
    const el = document.querySelectorAll("#track-list .track")[idx];
    if (el) {
      el.classList.add("sel");
      el.setAttribute("aria-selected", "true");
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    // state
    this.selected = track;

    // preview cover
    this._els.cover.style.visibility = "hidden";
    this._els.cover.src = track.cover || "";
    if (track.cover) {
      this._els.cover.onload = () => { this._els.cover.style.visibility = "visible"; };
    }

    // meta
    const dur = typeof track.durationMs === "number" ? formatDuration(track.durationMs) : "";
    const pack = track.pack ? ` • ${escapeHtml(track.pack)}` : "";
    const mapper = track.mapper ? ` • Chart by ${escapeHtml(track.mapper)}` : "";
    this._els.title.textContent = track.title || "Untitled";
    this._els.artist.textContent = track.artist || "";
    this._els.extra.textContent = [
      track.bpm ? `${Number(track.bpm)} BPM` : "",
      dur
    ].filter(Boolean).join(" • ") + pack + mapper;

    // show Play button (enabled once a diff is selected/auto-selected)
    this._els.playBtn.style.display = "inline-block";

    // default difficulty choice
    const diffs = Object.keys(track?.charts || {});
    const def = preferDiff && diffs.includes(preferDiff)
      ? preferDiff
      : pickDefaultDiff(diffs);

    // render pills (and optionally activate default)
    this._renderDiffPills(track, diffs, { activate: auto, defaultKey: def });

    // PB teaser if we have an active diff
    if (auto && def) this._updatePersonalBest(track, def);

    // Save last pick
    try {
      localStorage.setItem("pf:lastPick", JSON.stringify({ trackId: track.trackId, diff: def || null }));
    } catch {}
  }

  _renderDiffPills(track, diffs, { activate = false, defaultKey = null } = {}) {
    const wrap = this._els.diffWrap;
    wrap.innerHTML = "";

    if (!diffs.length) {
      const msg = document.createElement("div");
      msg.textContent = "No charts";
      msg.style.color = "#9aa7c2";
      msg.style.fontSize = "12px";
      wrap.appendChild(msg);
      this.selectedDiff = null;
      this._els.playBtn.disabled = true;
      this._els.pb.textContent = "";
      return;
    }

    const pills = [];
    for (const d of diffs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-label", `${d} difficulty`);
      btn.textContent = cap(d);

      Object.assign(btn.style, pillStyle());
      btn.addEventListener("mouseenter", () => this._ensureDiffHint(track, d, btn));
      btn.addEventListener("focus", () => this._ensureDiffHint(track, d, btn));
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this._setDiff(track, d, btn);
      });

      pills.push(btn);
      wrap.appendChild(btn);
    }

    if (activate && defaultKey && diffs.includes(defaultKey)) {
      const btn = pills[diffs.indexOf(defaultKey)];
      this._setDiff(track, defaultKey, btn, { silent: true });
    } else {
      this.selectedDiff = null;
      this._els.playBtn.disabled = true;
      this._els.pb.textContent = "";
    }
  }

  async _setDiff(track, diff, btn, { silent = false } = {}) {
    // restyle
    [...this._els.diffWrap.children].forEach(ch => {
      if (ch.tagName === "BUTTON") Object.assign(ch.style, pillStyle());
    });
    Object.assign(btn.style, pillActiveStyle());

    this.selectedDiff = diff;
    this._els.playBtn.disabled = false;

    // preload chart + hint
    this._ensureDiffHint(track, diff, btn);

    // PB teaser
    this._updatePersonalBest(track, diff);

    // remember last pick
    try {
      localStorage.setItem("pf:lastPick", JSON.stringify({ trackId: track.trackId, diff }));
    } catch {}

    if (!silent) this._els.playBtn.focus({ preventScroll: true });
  }

  async _ensureDiffHint(track, diff, btn) {
    const key = `${track.trackId || track.title}::${diff}`;
    if (!this._chartCache.has(key)) {
      const url = track?.charts?.[diff];
      if (!url) return;
      try {
        const chart = await fetch(url).then(r => r.json());
        this._chartCache.set(key, chart);
      } catch { /* ignore */ }
    }

    const chart = this._chartCache.get(key);
    if (chart && !btn.title) {
      const n = Array.isArray(chart.notes) ? chart.notes.length : 0;
      const durMs = chart.durationMs || track.durationMs || 0;
      const nps = durMs ? (n / (durMs / 1000)) : 0;
      const stars = starText(nps);
      btn.title = `${cap(diff)} • ~${n} notes • ~${nps.toFixed(2)} NPS ${stars ? "• " + stars : ""}`;
    }
  }

  async _updatePersonalBest(track, diff) {
    const key = `${track.trackId || track.title}::${diff}`;
    if (!this._pbCache.has(key)) {
      try {
        const url = `/api/leaderboard/${encodeURIComponent(track.trackId || track.title)}?limit=1&diff=${encodeURIComponent(diff)}`;
        const rows = await fetch(url).then(r => r.json());
        this._pbCache.set(key, Array.isArray(rows) && rows.length ? rows[0] : null);
      } catch {
        this._pbCache.set(key, null);
      }
    }
    const row = this._pbCache.get(key);
    if (!row) {
      this._els.pb.textContent = "PB: —";
    } else {
      const combo = row.combo ? ` • ${row.combo}x` : "";
      this._els.pb.textContent = `PB: ${Number(row.score || 0).toLocaleString()} • ${Math.round((row.acc || 0) * 100)}%${combo}`;
    }
  }

  // ---------- Actions ----------
  async _startSelected() {
    if (!this.selected) { this._inlineError("Pick a track first."); return; }
    if (!this.selectedDiff) { this._inlineError("Choose a difficulty."); return; }

    const play = this._els.playBtn;
    play.disabled = true;
    play.textContent = "Loading…";

    try {
      const diff = this.selectedDiff;
      const chartUrl = this.selected.charts[diff];
      const chart = await fetch(chartUrl).then(r => r.json());

      chart.audioUrl = this.selected.audio?.wav || this.selected.audio?.mp3;
      chart.title = this.selected.title;
      chart.bpm = this.selected.bpm;
      chart.difficulty = diff;
      chart.trackId = this.selected.trackId;

      window.PF_startGame?.({ mode: "solo", manifest: chart });
    } catch (e) {
      console.error(e);
      this._inlineError("Failed to load chart JSON or audio.");
      return;
    } finally {
      play.disabled = false;
      play.textContent = "Play";
    }
  }

  async _togglePreviewAudio() {
    if (!this.selected) return;
    const btn = this._els.previewBtn;

    // init ctx + master gain and make sure it's active
    await this._ensurePreviewCtx();
    await this._resumePreviewCtx();

    if (this._previewAudio.playing) {
      this._stopPreview("user-toggle");
      return;
    }

    const url = this.selected.audio?.mp3 || this.selected.audio?.wav;
    if (!url) return;

    try {
      btn.textContent = "Loading…";
      const buf = await fetch(url).then(r => r.arrayBuffer());
      const audio = await this._previewAudio.ctx.decodeAudioData(buf);

      // Still on Solo and same track?
      if (!this._isSoloActive()) { btn.textContent = "Preview 10s"; return; }

      // pick a start point that leaves room for 10s
      const start = Math.min(Math.max(0, audio.duration * 0.25), Math.max(0, audio.duration - 10));
      const src = this._previewAudio.ctx.createBufferSource();
      src.buffer = audio;
      src.connect(this._previewAudio.master);
      src.start(0, start, 10.0);

      // track src + flags
      this._previewAudio.src = src;
      this._previewAudio.playing = true;
      btn.textContent = "Stop Preview";

      src.onended = () => {
        // Cleanly reset so another preview works immediately
        if (this._previewAudio.src === src) {
          try { src.disconnect(); } catch {}
          this._previewAudio.src = null;
        }
        this._previewAudio.playing = false;
        if (this._els.previewBtn) this._els.previewBtn.textContent = "Preview 10s";
      };
    } catch (e) {
      console.error(e);
      btn.textContent = "Preview 10s";
      this._previewAudio.playing = false;
    }
  }

  _stopPreview(reason = "") {
    const a = this._previewAudio;
    if (a.src) {
      try { a.src.onended = null; } catch {}
      try { a.src.stop(); } catch {}
      try { a.src.disconnect(); } catch {}
      a.src = null;
    }
    a.playing = false;
    if (this._els.previewBtn) this._els.previewBtn.textContent = "Preview 10s";
  }

  _inlineError(msg) {
    if (this._els.error) this._els.error.textContent = msg || "";
  }

  _clearSelection() {
    this.selected = null;
    this.selectedDiff = null;
    this._els.cover.src = "";
    this._els.cover.style.visibility = "hidden";
    this._els.title.textContent = "";
    this._els.artist.textContent = "";
    this._els.extra.textContent = "";
    this._els.diffWrap.innerHTML = "";
    this._els.pb.textContent = "";
    this._els.playBtn.style.display = "none";
    document.querySelectorAll("#track-list .track").forEach(el => {
      el.classList.remove("sel");
      el.setAttribute("aria-selected", "false");
    });
  }

  // ---------- Input (keyboard + gamepad) ----------
  _wireKeyboard() {
    window.addEventListener("keydown", (e) => {
      const tag = (e.target?.tagName || "").toUpperCase();
      if (e.target?.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const scr = document.getElementById("screen-solo");
      if (!scr || !scr.classList.contains("active")) return;

      if (e.code === "ArrowUp" || e.code === "KeyK") {
        e.preventDefault();
        this._cycleDiff(-1);
      } else if (e.code === "ArrowDown" || e.code === "KeyJ") {
        e.preventDefault();
        this._cycleDiff(1);
      } else if (e.code === "ArrowLeft" || e.code === "KeyH") {
        e.preventDefault();
        this._cycleTrack(-1);
      } else if (e.code === "ArrowRight" || e.code === "KeyL") {
        e.preventDefault();
        this._cycleTrack(1);
      } else if (e.code === "Enter") {
        e.preventDefault();
        if (!this._els.playBtn.disabled) this._startSelected();
      }
    });
  }
  _cycleTrack(dir) {
    if (!this.filtered.length) return;
    let i = this.selected ? this.filtered.indexOf(this.selected) : -1;
    i = (i + dir + this.filtered.length) % this.filtered.length;
    // stop preview between track changes
    this._stopPreview("cycle-track");
    this._selectTrack(this.filtered[i], { auto: true });
  }
  _cycleDiff(dir) {
    if (!this.selected) return;
    const diffs = Object.keys(this.selected?.charts || {});
    if (!diffs.length) return;
    let i = this.selectedDiff ? diffs.indexOf(this.selectedDiff) : 0;
    i = (i + dir + diffs.length) % diffs.length;
    const btn = [...this._els.diffWrap.children][i];
    if (btn?.tagName === "BUTTON") this._setDiff(this.selected, diffs[i], btn);
  }

  _wireGamepad() {
    const tick = () => {
      const pads = navigator.getGamepads?.() || [];
      const p = pads.find(Boolean);
      if (!p) return requestAnimationFrame(tick);

      const lh = (p.axes?.[0] || 0);
      const lv = (p.axes?.[1] || 0);
      const A = p.buttons?.[0]?.pressed; // A / Cross -> Play
      const Up = lv < -0.5, Down = lv > 0.5, Left = lh < -0.5, Right = lh > 0.5;

      const now = performance.now();
      this._gpNext ||= 0;
      if (now >= this._gpNext) {
        if (Left)  { this._cycleTrack(-1); this._gpNext = now + 200; }
        if (Right) { this._cycleTrack(1);  this._gpNext = now + 200; }
        if (Up)    { this._cycleDiff(-1);  this._gpNext = now + 200; }
        if (Down)  { this._cycleDiff(1);   this._gpNext = now + 200; }
        if (A && !this._els.playBtn.disabled) { this._startSelected(); this._gpNext = now + 400; }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---------- Preview audio helpers ----------
  async _ensurePreviewCtx() {
    if (this._previewAudio.ctx) return;

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const master = ctx.createGain();

    // pick up saved volume (0..1) or fall back to settings or 1
    const vol = _getSavedVolume();
    master.gain.value = isFiniteNumber(vol) ? vol : 1;

    master.connect(ctx.destination);
    this._previewAudio.ctx = ctx;
    this._previewAudio.master = master;

    // react to live volume changes from Settings
    if (!this._previewAudio.volHandler) {
      const handler = (e) => {
        const v = Number(e?.detail?.volume);
        if (!Number.isFinite(v) || !this._previewAudio.master) return;
        try {
          const now = this._previewAudio.ctx.currentTime;
          this._previewAudio.master.gain.cancelScheduledValues(now);
          this._previewAudio.master.gain.setValueAtTime(this._previewAudio.master.gain.value, now);
          this._previewAudio.master.gain.linearRampToValueAtTime(Math.max(0, Math.min(1, v)), now + 0.05);
        } catch {}
      };
      window.addEventListener("pf-volume-changed", handler);
      this._previewAudio.volHandler = handler;
    }
  }

  async _resumePreviewCtx() {
    try {
      if (this._previewAudio.ctx?.state === "suspended") {
        await this._previewAudio.ctx.resume();
      }
    } catch {}
  }

  _isSoloActive() {
    const scr = document.getElementById("screen-solo");
    return !!(scr && scr.classList.contains("active"));
  }

  // ---------- Auto-stop guards ----------
  _setupAutoStopGuards() {
    // clear previous guards if mount() called twice
    this._guards.forEach(fn => { try { fn(); } catch {} });
    this._guards = [];

    // 1) Stop when #screen-solo loses .active or is removed
    const screen = document.getElementById("screen-solo");
    if (screen) {
      const attrObs = new MutationObserver((mutList) => {
        for (const m of mutList) {
          if (m.type === "attributes" && m.attributeName === "class") {
            if (!screen.classList.contains("active")) this._stopPreview("solo-hidden");
          }
        }
      });
      attrObs.observe(screen, { attributes: true, attributeFilter: ["class"] });
      this._guards.push(() => attrObs.disconnect());

      const domObs = new MutationObserver(() => {
        if (!document.body.contains(screen)) this._stopPreview("solo-removed");
      });
      domObs.observe(document.body, { childList: true, subtree: true });
      this._guards.push(() => domObs.disconnect());
    }

    // 2) Stop if tab is hidden or page is being unloaded
    const onVis = () => { if (document.hidden) this._stopPreview("visibility"); };
    const onHide = () => this._stopPreview("pagehide");
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onHide);
    this._guards.push(() => document.removeEventListener("visibilitychange", onVis));
    this._guards.push(() => window.removeEventListener("pagehide", onHide));
  }
}

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function cap(s) { s = String(s || ""); return s ? s[0].toUpperCase() + s.slice(1) : s; }
function pickDefaultDiff(diffs) {
  if (!diffs || !diffs.length) return null;
  const prefs = ["normal", "easy"];
  for (const p of prefs) if (diffs.includes(p)) return p;
  return diffs[0];
}
function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}
function starText(nps) {
  if (!nps) return "";
  const stars =
    nps < 1.5 ? 1 :
    nps < 3.0 ? 2 :
    nps < 4.5 ? 3 :
    nps < 6.0 ? 4 :
    nps < 8.0 ? 5 : 6;
  return "★".repeat(stars);
}
function pillStyle() {
  return {
    padding: "8px 12px",
    minHeight: "36px",
    borderRadius: "999px",
    border: "1px solid #3b4760",
    background: "#1c2333",
    color: "#e8eefc",
    fontSize: "13px",
    lineHeight: "18px",
    cursor: "pointer",
    userSelect: "none",
    outline: "2px solid transparent",
    outlineOffset: "2px"
  };
}
function pillActiveStyle() {
  return {
    border: "1px solid #25f4ee",
    boxShadow: "0 0 0 2px rgba(37,244,238,0.15) inset",
    background: "#0e1824"
  };
}
function isFiniteNumber(x) { return typeof x === "number" && Number.isFinite(x); }
function _getSavedVolume() {
  try {
    const s = JSON.parse(localStorage.getItem("pf-settings") || "{}");
    const v = Number(s?.volume);
    if (Number.isFinite(v)) return Math.max(0, Math.min(1, v));
  } catch {}
  return 1;
}
