// public/js/modules/solo.js
export class Solo {
  constructor(settings) {
    this.settings = settings;
    this.tracks = [];
    this.selected = null;
  }

  async mount() {
    // Load tracks
    const res = await fetch("/api/tracks").then(r => r.json()).catch(() => []);
    this.tracks = Array.isArray(res) ? res : [];

    // Build list
    const list = document.getElementById("track-list");
    if (list) list.innerHTML = "";

    for (const t of this.tracks) {
      const div = document.createElement("div");
      div.className = "track";
      div.innerHTML = `
        <div class="cover" style="background-image:url('${t.cover || ""}')"></div>
        <div class="meta">
          <div><b>${t.title || "Untitled"}</b></div>
          <div class="muted">${t.artist || ""}</div>
          <div class="muted">${t.bpm ? `${t.bpm} BPM` : ""}</div>
        </div>`;

      div.addEventListener("click", () => {
        // update selection visuals
        document.querySelectorAll("#track-list .track").forEach(el => el.classList.remove("sel"));
        div.classList.add("sel");
        // set selection & refresh UI
        this.selected = t;
        this._refreshDifficultyUI();
      });

      list?.appendChild(div);
    }

    // Auto-select first track (visually and logically)
    if (this.tracks.length) {
      const firstEl = document.querySelector("#track-list .track");
      firstEl?.classList.add("sel");
      this.selected = this.tracks[0];
      this._refreshDifficultyUI();
    }

    document.getElementById("btn-play-solo")?.addEventListener("click", async () => {
      if (!this.selected) { alert("Pick a track"); return; }
      const diffSel = document.getElementById("solo-diff");
      const diff = diffSel?.value || Object.keys(this.selected.charts || {})[0];
      if (!diff) { alert("This track has no charts."); return; }

      try {
        const chartUrl = this.selected.charts[diff];
        const chart = await fetch(chartUrl).then(r => r.json());
        chart.audioUrl = this.selected.audio?.wav || this.selected.audio?.mp3;
        chart.title = this.selected.title;
        chart.bpm = this.selected.bpm;
        chart.difficulty = diff;
        chart.trackId = this.selected.trackId;
        window.PF_startGame({ mode: "solo", manifest: chart });
      } catch (e) {
        console.error(e);
        alert("Failed to load chart JSON or audio.");
      }
    });
  }

  _refreshDifficultyUI() {
    const diffSel = document.getElementById("solo-diff");
    if (!diffSel) return;

    const charts = this.selected?.charts || {};
    const diffs = Object.keys(charts);
    diffSel.innerHTML = "";

    for (const d of diffs) {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d[0].toUpperCase() + d.slice(1);
      diffSel.appendChild(opt);
    }

    const row = diffSel.closest(".row");
    if (row) row.style.display = diffs.length ? "flex" : "none";
  }
}
