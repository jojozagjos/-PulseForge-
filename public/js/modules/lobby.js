// public/js/modules/lobby.js
export class Lobby {
  constructor(settings) {
    this.settings = settings;

    // UI refs
    this.$info = document.getElementById("lobby-info");
    this.$hostTools = document.getElementById("lobby-host-tools") || document.getElementById("screen-lobby"); // safe fallback
    this.$list = document.getElementById("lobby-track-list");   // grid of ".track" cards
    this.$diff = document.getElementById("lobby-diff");         // difficulty <select>
    this.$players = document.getElementById("lobby-players");

    // state
    this.tracks = [];
    this.selected = null;
    this.isHost = false;
    this.roomCode = null;

    // buttons
    document.getElementById("lobby-refresh")?.addEventListener("click", () => this.loadTracks());
    document.getElementById("btn-ready")?.addEventListener("click", () => this._toggleReady());
    document.getElementById("btn-start")?.addEventListener("click", () => this._startIfHost());
    document.getElementById("btn-leave")?.addEventListener("click", () => this._leave());
  }

  // ---------- lifecycle entry points from main.js ----------
  async quickMatch() {
    // Treat Quick Match as self-hosted for now.
    this.isHost = true;
    this.roomCode = "QM-" + Math.random().toString(36).slice(2, 6).toUpperCase();
    this._info(`Quick Match • Room ${this.roomCode} • You are Host`);
    if (this.$hostTools) this.$hostTools.style.display = "block";
    this._renderPlayers();
    await this.loadTracks();
  }

  async hostParty() {
    this.isHost = true;
    this.roomCode = "PR-" + Math.random().toString(36).slice(2, 6).toUpperCase();
    this._info(`Party Room • Code ${this.roomCode} • You are Host. Share this code with friends.`);
    if (this.$hostTools) this.$hostTools.style.display = "block";
    this._renderPlayers();
    await this.loadTracks();
  }

  mount(onExit) {
    this.onExit = onExit;
  }

  // ---------- data ----------
  async loadTracks() {
    try {
      // Match Solo’s API and field names
      const res = await fetch("/api/tracks").then(r => r.json());
      this.tracks = Array.isArray(res) ? res : [];
      this._renderList();

      // Auto-select first if present (and apply .sel visually)
      if (this.tracks[0]) {
        this._select(this.tracks[0]);
        const firstCard = this.$list?.querySelector(".track");
        firstCard?.classList.add("sel");
      }
    } catch (e) {
      console.error(e);
      this._info("Could not load /api/tracks.");
      if (this.$list) this.$list.innerHTML = `<div class="muted">No tracks found.</div>`;
    }
  }

  // ---------- rendering ----------
  _renderList() {
    if (!this.$list) return;
    this.$list.innerHTML = "";

    for (const t of this.tracks) {
      const div = document.createElement("div");
      div.className = "track";
      // Note: background-image handles relative paths like /tracks/xxx/cover.jpg
      div.innerHTML = `
        <div class="cover" style="background-image:url('${t.cover || ""}')"></div>
        <div class="meta">
          <div><b>${t.title || t.id || "Untitled"}</b></div>
          <div>${t.artist || ""}</div>
          <div>${t.bpm ? `${t.bpm} BPM` : ""}</div>
        </div>
      `;

      // Use this.$list, not this.$cards
      div.addEventListener("click", () => {
        this.$list.querySelectorAll(".track").forEach(el => el.classList.remove("sel"));
        div.classList.add("sel");
        this._select(t);
      });

      this.$list.appendChild(div);
    }
  }

  _select(track) {
    this.selected = track || null;

    // Sync difficulties to only those present on the selected track
    const charts = this.selected?.charts || {};
    const diffs = Object.keys(charts);
    if (this.$diff) {
      this.$diff.innerHTML = "";
      for (const d of diffs) {
        const opt = document.createElement("option");
        opt.value = d;
        opt.textContent = d[0].toUpperCase() + d.slice(1);
        this.$diff.appendChild(opt);
      }
      // Hide dropdown row if there are no charts
      const row = this.$diff.closest(".row");
      if (row) row.style.display = diffs.length ? "flex" : "none";
    }
  }

  _renderPlayers(list = []) {
    if (!this.$players) return;
    const safe = s => (s || "").replace(/[<>]/g, "");
    const me = this.settings?.name || "Player";
    const players = list.length ? list : [me];
    this.$players.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:8px;">
        ${players.map(p => `<div class="pill">${safe(p)}</div>`).join("")}
      </div>
    `;
  }

  _info(msg) {
    if (this.$info) this.$info.textContent = msg;
  }

  // ---------- actions ----------
  _toggleReady() {
    const btn = document.getElementById("btn-ready");
    if (!btn) return;
    const on = btn.getAttribute("data-ready") === "1";
    btn.setAttribute("data-ready", on ? "0" : "1");
    btn.textContent = on ? "Ready" : "Ready ✓";
  }

  async _startIfHost() {
    if (!this.isHost) {
      this._info("Only the host can start the match.");
      return;
    }
    if (!this.selected) {
      this._info("Pick a track first.");
      return;
    }

    try {
      const diff = this.$diff?.value || Object.keys(this.selected.charts || {})[0];
      if (!diff) {
        this._info("This track has no charts to start.");
        return;
      }

      const chartUrl = this.selected.charts[diff];
      const chart = await fetch(chartUrl).then(r => r.json());
      // Attach audio and metadata like Solo does
      chart.audioUrl = this.selected.audio?.wav || this.selected.audio?.mp3;
      chart.title = this.selected.title;
      chart.bpm = this.selected.bpm;
      chart.difficulty = diff;

      const runtime = { mode: "solo", manifest: chart };
      window.PF_startGame?.(runtime);
    } catch (e) {
      console.error(e);
      this._info("Failed to start. Check chart path and network console.");
    }
  }

  _leave() {
    this._info("You left the lobby.");
    if (typeof this.onExit === "function") this.onExit();
  }
}
