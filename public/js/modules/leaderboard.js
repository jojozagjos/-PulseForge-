// public/js/modules/leaderboard.js
export class Leaderboard {
  constructor(settings = {}) {
    this.settings = settings;
    this.$list = document.getElementById("lb-track-list");
    this.$table = document.getElementById("lb-table-body");
    this.$title = document.getElementById("lb-title");
    this.$playBtn = document.getElementById("lb-play");
    this.tracks = [];
    this.selected = null;

    // start disabled until a track is chosen
    if (this.$playBtn) this._setPlayEnabled(false);
    this.$playBtn?.addEventListener("click", () => this._playSelected());
  }

  async mount() {
    await this._loadTracks();
    this._renderList();
    // DO NOT auto-select; keep “Pick a song”
    if (this.$title) this.$title.textContent = "Pick a song";
    if (this.$table) {
      this.$table.innerHTML = `<tr><td class="muted" colspan="4">Pick a song</td></tr>`;
    }
  }

  async _loadTracks() {
    try {
      const res = await fetch("/api/tracks").then(r => r.json());
      this.tracks = Array.isArray(res) ? res : [];
    } catch (e) {
      console.error(e);
      this.tracks = [];
    }
  }

  _renderList() {
    if (!this.$list) return;
    this.$list.innerHTML = "";
    for (const t of this.tracks) {
      const item = document.createElement("div");
      item.className = "track";
      item.innerHTML = `
        <div class="cover" style="background-image:url('${t.cover || ""}')"></div>
        <div class="meta">
          <div><b>${t.title || "Untitled"}</b></div>
          <div class="muted">${t.artist || ""}</div>
          <div class="muted">${t.bpm ? `${t.bpm} BPM` : ""}</div>
        </div>`;
      item.addEventListener("click", () => {
        this.$list.querySelectorAll(".track").forEach(el => el.classList.remove("sel"));
        item.classList.add("sel");
        this._select(t);
      });
      this.$list.appendChild(item);
    }
  }

  async _select(track) {
    this.selected = track;
    if (this.$title) this.$title.textContent = `${track.title} • Leaderboard`;
    this._setPlayEnabled(true);
    await this._loadBoard(track.trackId);
  }

  async _loadBoard(trackId) {
    if (!this.$table) return;
    this.$table.innerHTML = `<tr><td class="muted" colspan="4">Loading…</td></tr>`;
    try {
      const rows = await fetch(`/api/leaderboard/${encodeURIComponent(trackId)}?limit=100`).then(r => r.json());
      if (!Array.isArray(rows) || rows.length === 0) {
        this.$table.innerHTML = `<tr><td class="muted" colspan="4">No scores yet. Be the first!</td></tr>`;
        return;
      }
      this.$table.innerHTML = rows.map((r, i) => `
        <tr>
          <td>#${i + 1}</td>
          <td>${escapeHtml(r.name)}</td>
          <td>${Number(r.score || 0).toLocaleString()}</td>
          <td>${Math.round((r.acc || 0) * 100)}% • ${r.combo || 0}x</td>
        </tr>
      `).join("");
    } catch (e) {
      console.error(e);
      this.$table.innerHTML = `<tr><td class="muted" colspan="4">Failed to load leaderboard.</td></tr>`;
    }
  }

  async _playSelected() {
    if (!this.selected) return;

    // Require name before starting from Leaderboard
    const playerName = (this.settings?.name || "").trim();
    if (!playerName) {
      alert("Please set your Player Name in Settings before you start.");
      // Jump to Settings if the main menu button exists
      document.getElementById("btn-settings")?.click();
      // Focus the name input if present
      setTimeout(() => document.getElementById("set-name")?.focus(), 0);
      return;
    }

    // Pick first available chart diff
    const diffs = Object.keys(this.selected.charts || {});
    if (!diffs.length) return;
    const diff = diffs[0];
    const chartUrl = this.selected.charts[diff];
    try {
      const chart = await fetch(chartUrl).then(r => r.json());
      chart.audioUrl = this.selected.audio?.wav || this.selected.audio?.mp3;
      chart.title = this.selected.title;
      chart.trackId = this.selected.trackId;
      chart.difficulty = diff;

      const runtime = { mode: "solo", manifest: chart };
      if (typeof window.PF_startGame === "function") {
        const results = await window.PF_startGame(runtime);
        // Auto-submit already handled in PF_startGame if you added that hook.
        // If you prefer submitting here instead, you can call submitScore(...) too.
      }
    } catch (e) {
      console.error(e);
      alert("Failed to start: check chart path in console.");
    }
  }

  _setPlayEnabled(on) {
    if (!this.$playBtn) return;
    this.$playBtn.disabled = !on;
    this.$playBtn.style.opacity = on ? "1" : "0.6";
    this.$playBtn.style.cursor = on ? "pointer" : "not-allowed";
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
