// public/js/modules/solo.js
export class Solo {
  constructor(settings) { this.settings = settings; this.tracks = []; this.selected = null; }

  async mount() {
    const res = await fetch("/api/tracks").then(r => r.json()).catch(() => []);
    this.tracks = Array.isArray(res) ? res : [];
    const list = document.getElementById("track-list");
    if (list) list.innerHTML = "";

    for (const t of this.tracks) {
      const div = document.createElement("div");
      div.className = "track";

      div.addEventListener("click", () => {
        // remove previous selection visual
        document.querySelectorAll("#track-list .track").forEach(el => el.classList.remove("sel"));
        // add visual to this one
        div.classList.add("sel");

        this.selected = t;
        this._refreshDifficultyUI();
      });
      div.innerHTML = `
        <div class="cover" style="background-image:url('${t.cover || ""}')"></div>
        <div class="meta">
          <div><b>${t.title}</b></div>
          <div>${t.artist || ""}</div>
          <div>${t.bpm ? `${t.bpm} BPM` : ""}</div>
        </div>`;
      div.addEventListener("click", () => {
        this.selected = t;
        this._refreshDifficultyUI();
      });
      list?.appendChild(div);
    }

   // After you’ve appended all cards, auto-select first if present:
    this.selected = this.tracks[0] || null;
    if (this.selected) {
      // find its element and add .sel
      const firstEl = document.querySelector('#track-list .track');
      firstEl?.classList.add('sel');
    }
    this._refreshDifficultyUI();

    document.getElementById("btn-play-solo")?.addEventListener("click", async () => {
      if (!this.selected) { alert("Pick a track"); return; }
      const diffSel = document.getElementById("solo-diff");
      const diff = diffSel?.value || Object.keys(this.selected.charts || {})[0];
      if (!diff) { alert("This track has no charts."); return; }

      const chartUrl = this.selected.charts[diff];
      const chart = await fetch(chartUrl).then(r => r.json());
      chart.audioUrl = this.selected.audio.wav;
      chart.title = this.selected.title;
      chart.bpm = this.selected.bpm;
      chart.difficulty = diff;
      window.PF_startGame({ mode: "solo", manifest: chart });
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
      opt.value = d; opt.textContent = d[0].toUpperCase() + d.slice(1);
      diffSel.appendChild(opt);
    }
    const row = diffSel.closest(".row");
    if (row) row.style.display = diffs.length ? "flex" : "none";
  }
}
