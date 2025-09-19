
export class Lobby{
  constructor(settings){ this.settings=settings; this.socket=io(); this.state=null; }
  async quickMatch(){ this.socket.emit("createRoom", { name:this.settings.name }); this._wire(); }
  async hostParty(){ this.socket.emit("createRoom", { name:this.settings.name }); this._wire(); }
  mount(){}

  _wire(){
    const info = document.getElementById("lobby-info");
    const players = document.getElementById("lobby-players");
    const btnReady = document.getElementById("btn-ready");
    const btnStart = document.getElementById("btn-start");
    const btnLeave = document.getElementById("btn-leave");

    this.socket.on("roomState", (st)=>{
      this.state = st;
      info.innerHTML = `<div class="row"><div>Room: <b>${st.code||"----"}</b></div><div>Phase: ${st.phase}</div></div>
      <div class="row"><div>Track: ${st.track?.title||"None"}</div><div>Diff: ${st.difficulty||"normal"}</div></div>`;
      players.innerHTML = (st.players||[]).map(p=>`<div class="results-row"><div>${p.name}</div><div>${p.ready?"✅ Ready":"⏳"}</div></div>`).join("");
    });

    this.socket.on("errorMsg", msg=> alert(msg));

    btnReady.onclick = ()=>{ const code=this.state?.code; this.socket.emit("ready", { code, ready:true }); };
    btnStart.onclick = ()=>{
      const code=this.state?.code;
      const track={ trackId:"training-beat", title:"Training Beat", bpm:120,
        charts:{ easy:"/charts/training-beat.easy.json", normal:"/charts/training-beat.normal.json", hard:"/charts/training-beat.hard.json" },
        audio:{ wav:"/assets/music/training-beat.wav"} };
      this.socket.emit("selectTrack", { code, track, difficulty:"normal" });
      this.socket.emit("start", { code });
    };
    btnLeave.onclick = ()=>{ const code=this.state?.code; this.socket.emit("leaveRoom",{code}); location.reload(); };

    this.socket.on("countdown", ({ startAt, track, difficulty, secret })=>{
      window.PF_startGame({ mode:"mp", socket:this.socket, roomCode:this.state.code, startAt, track, difficulty, secret });
    });
  }
}
