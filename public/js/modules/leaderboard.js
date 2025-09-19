export class Leaderboard {
  constructor(settings = {}) {
    this.settings = settings;
    this.$list = document.getElementById("lb-track-list");
    this.$table = document.getElementById("lb-table-body");
    this.$title = document.getElementById("lb-title");
    this.$playBtn = document.getElementById("lb-play");

    // new: difficulty select (create if missing)
    this.$diff = document.getElementById("lb-diff") || this._ensureDiffSelect();

    this.tracks = [];
    this.selected = null;

    if (this.$playBtn) this._setPlayEnabled(false);
    this.$playBtn?.addEventListener("click", () => this._playSelected());
    this.$diff?.addEventListener("change", () => {
      if (this.selected) this._loadBoard(this.selected.trackId, this.$diff.value);
    });
  }

  _ensureDiffSelect() {
    const header = this.$title?.parentElement || document.getElementById("lb-header") || document.body;
    const sel = document.createElement("select");
    sel.id = "lb-diff";
    Object.assign(sel.style, { marginLeft: "8px" });
    header.appendChild(sel);
    return sel;
  }

  async mount() {
    await this._loadTracks();
    this._renderList();
    if (this.$title) this.$title.textContent = "Pick a song";
    if (this.$table) this.$table.innerHTML = `<tr><td class="muted" colspan="4">Pick a song</td></tr>`;
    if (this.$diff) this.$diff.innerHTML = ""; // no diffs until a track is picked
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
    this._populateDiffs(track);
    await this._loadBoard(track.trackId, this.$diff?.value);
  }

  _populateDiffs(track) {
    const diffs = Object.keys(track?.charts || {});
    if (!this.$diff) return;
    this.$diff.innerHTML = "";
    if (!diffs.length) {
      const opt = document.createElement("option");
      opt.value = ""; opt.textContent = "—";
      this.$diff.appendChild(opt);
      this.$diff.disabled = true;
      return;
    }
    this.$diff.disabled = false;
    for (const d of diffs) {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d[0].toUpperCase() + d.slice(1);
      this.$diff.appendChild(opt);
    }
    // default to first diff
    this.$diff.value = diffs[0];
  }

  async _loadBoard(trackId, diff) {
    if (!this.$table) return;
    this.$table.innerHTML = `<tr><td class="muted" colspan="4">Loading…</td></tr>`;
    try {
      // ask the server for scores filtered by difficulty
      const url = `/api/leaderboard/${encodeURIComponent(trackId)}?limit=100${diff ? `&diff=${encodeURIComponent(diff)}` : ""}`;
      let rows = await fetch(url).then(r => r.json());

      // fallback: if server returns mixed difficulties but includes a difficulty field, filter client-side
      if (Array.isArray(rows) && rows.length && rows[0] && rows[0].difficulty != null && diff) {
        rows = rows.filter(r => (r.difficulty || "normal") === diff);
      }

      if (!Array.isArray(rows) || rows.length === 0) {
        this.$table.innerHTML = `<tr><td class="muted" colspan="4">No scores yet for ${diff || "default"}.</td></tr>`;
        return;
      }

      this.$table.innerHTML = rows.map((r, i) => `
        <tr>
          <td>#${i + 1}</td>
          <td>${escapeHtml(r.name)}</td>
          <td class="num">${Number(r.score || 0).toLocaleString()}</td>
          <td class="num">${Math.round((r.acc || 0) * 100)}% • ${r.combo || 0}x</td>
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
      document.getElementById("btn-settings")?.click();
      setTimeout(() => document.getElementById("set-name")?.focus(), 0);
      return;
    }

    // Use selected difficulty
    const diffs = Object.keys(this.selected.charts || {});
    if (!diffs.length) return;
    const diff = this.$diff?.value || diffs[0];

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
        // If you submit here, include difficulty:
        // await submitScore({ trackId: chart.trackId, difficulty: diff, ...results, name: playerName });
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
