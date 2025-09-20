export class Leaderboard {
  constructor(settings = {}) {
    this.settings = settings;
    this.$list = document.getElementById("lb-track-list");
    this.$table = document.getElementById("lb-table-body");
    this.$title = document.getElementById("lb-title");
    this.$playBtn = document.getElementById("lb-play");

    // difficulty select (create if missing)
    this.$diff = document.getElementById("lb-diff") || this._ensureDiffSelect();

    // header (cover + meta) will be created on mount if missing
    this.$header = document.getElementById("lb-header") || null;

    this.tracks = [];
    this.selected = null;

    // QoL: remember last diff across tracks
    this._lastDiff = "normal";

    // Pagination
    this._limit = 50;
    this._moreBtn = null;

    if (this.$playBtn) this._setPlayEnabled(false);
    this.$playBtn?.addEventListener("click", () => this._playSelected());

    this.$diff?.addEventListener("change", () => {
      if (this.selected) {
        this._loadBoard(this.selected.trackId, this.$diff.value);
      }
      this._lastDiff = this.$diff?.value || this._lastDiff;
    });
  }

  _ensureDiffSelect() {
    const header = this.$title?.parentElement || document.body;
    const sel = document.createElement("select");
    sel.id = "lb-diff";
    Object.assign(sel.style, { marginLeft: "8px" });
    header.appendChild(sel);
    return sel;
  }

  async mount() {
    await this._loadTracks();
    this._renderList();

    // ensure a header row (cover + meta) above table/title
    if (!this.$header) {
      this.$header = document.createElement("div");
      this.$header.id = "lb-header";
      Object.assign(this.$header.style, {
        display: "flex",
        gap: "12px",
        alignItems: "center",
        margin: "8px 0 8px"
      });
      // try to place above the title if available
      if (this.$title?.parentElement) {
        this.$title.parentElement.insertBefore(this.$header, this.$title);
      } else {
        document.body.appendChild(this.$header);
      }
    }

    if (this.$title) this.$title.textContent = "Pick a song";
    if (this.$table) this.$table.innerHTML = `<tr><td class="muted" colspan="4">Pick a song</td></tr>`;
    if (this.$diff) this.$diff.innerHTML = ""; // no diffs until a track is picked
    this._removeMoreBtn();
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
          <div><b>${escapeHtml(t.title || "Untitled")}</b></div>
          <div class="muted">${escapeHtml(t.artist || "")}</div>
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
    this.$diff.value = diffs.includes(this._lastDiff) ? this._lastDiff : diffs[0];
  }

  async _loadBoard(trackId, diff) {
    if (!this.$table) return;
    this.$table.innerHTML = `<tr><td class="muted" colspan="4">Loading…</td></tr>`;
    try {
      const url = `/api/leaderboard/${encodeURIComponent(trackId)}?limit=${this._limit}${diff ? `&diff=${encodeURIComponent(diff)}` : ""}`;
      let rows = await fetch(url).then(r => r.json());

      // if server mixes difficulties, filter client-side
      if (Array.isArray(rows) && rows.length && rows[0] && rows[0].difficulty != null && diff) {
        rows = rows.filter(r => (r.difficulty || "normal") === diff);
      }

      if (!Array.isArray(rows) || rows.length === 0) {
        this.$table.innerHTML = `<tr><td class="muted" colspan="4">No scores yet for ${diff || "default"}.</td></tr>`;
        this._removeMoreBtn();
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

      // optimistic "Load more" if we likely have more
      if (rows.length >= this._limit) this._ensureMoreBtn(trackId, diff);
      else this._removeMoreBtn();

    } catch (e) {
      console.error(e);
      this.$table.innerHTML = `<tr><td class="muted" colspan="4">Failed to load leaderboard.</td></tr>`;
      this._removeMoreBtn();
    }
  }

  _ensureMoreBtn(trackId, diff) {
    if (this._moreBtn) return;
    const btn = document.createElement("button");
    btn.textContent = "Load more";
    btn.className = "ghost";
    btn.style.marginTop = "8px";
    btn.addEventListener("click", async () => {
      this._limit += 50;
      await this._loadBoard(trackId, diff);
    });

    // place button after the TABLE element
    const tableEl = this.$table?.parentElement; // TBODY
    const container = tableEl?.nodeName === "TBODY" ? tableEl.parentElement : this.$table;
    container?.insertAdjacentElement("afterend", btn);
    this._moreBtn = btn;
  }

  _removeMoreBtn() {
    if (this._moreBtn) {
      this._moreBtn.remove();
      this._moreBtn = null;
    }
  }

  async _playSelected() {
    if (!this.selected) return;

    const playerName = (this.settings?.name || "").trim();
    if (!playerName) {
      alert("Please set your Player Name in Settings before you start.");
      document.getElementById("btn-settings")?.click();
      setTimeout(() => document.getElementById("set-name")?.focus(), 0);
      return;
    }

    const diffs = Object.keys(this.selected.charts || {});
    if (!diffs.length) return;
    const diff = this.$diff?.value || diffs[0];

    try {
      const chartUrl = this.selected.charts[diff];
      const chart = await fetch(chartUrl).then(r => r.json());
      chart.audioUrl = this.selected.audio?.wav || this.selected.audio?.mp3;
      chart.title = this.selected.title;
      chart.trackId = this.selected.trackId;
      chart.difficulty = diff;

      // Let PF_startGame handle running AND submitting.
      if (typeof window.PF_startGame === "function") {
        await window.PF_startGame({ mode: "solo", manifest: chart });
        // Optional: once submission finishes (handled by PF_startGame), refresh the table:
        await this._loadBoard(chart.trackId, diff);
        this._highlightSelf(playerName);
      }
    } catch (e) {
      console.error(e);
      alert("Failed to start: check chart path in console.");
    }
  }

  _highlightSelf(playerName) {
    if (!this.$table) return;
    const rows = Array.from(this.$table.querySelectorAll("tr"));
    for (const tr of rows) {
      const nameCell = tr.children?.[1];
      if (nameCell && nameCell.textContent?.trim() === playerName) {
        tr.style.background = "rgba(37,244,238,0.07)";
        tr.style.outline = "1px solid rgba(37,244,238,0.25)";
        break;
      }
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
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
