
export class Solo{
  constructor(settings){ this.settings=settings; this.tracks=[]; }
  async mount(){
    const res = await fetch("/api/tracks").then(r=>r.json());
    this.tracks = res;
    const list = document.getElementById("track-list");
    list.innerHTML = "";
    for (const t of this.tracks){
      const div = document.createElement("div");
      div.className = "track";
      div.innerHTML = `<div class="cover" style="background-image:url('${t.cover}')"></div>
        <div class="meta"><div><b>${t.title}</b></div><div>${t.artist}</div><div>${t.bpm} BPM</div></div>`;
      div.onclick = ()=> this.selected = t;
      list.appendChild(div);
    }
    this.selected = this.tracks[0];
    document.getElementById("btn-play-solo").addEventListener("click", async  ()=>{
      if (!this.selected) return alert("Pick a track");
      const diff = document.getElementById("solo-diff").value;
      const chartUrl = this.selected.charts[diff];
      const chart = await fetch(chartUrl).then(r=>r.json());
      chart.audioUrl = this.selected.audio.wav;
      chart.title = this.selected.title;
      chart.bpm = this.selected.bpm;
      chart.difficulty = diff;
      window.PF_startGame({ mode:"solo", manifest: chart });
    });
  }
}
