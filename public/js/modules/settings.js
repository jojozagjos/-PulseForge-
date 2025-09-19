
export class Settings{
  constructor(){ this.name="Player"; this.latencyMs=0; this.keys=["D","F","J","K"]; }
  load(){ try{ const s=JSON.parse(localStorage.getItem("pf-settings")||"{}"); Object.assign(this,s);}catch{};
    document.getElementById("set-name").value=this.name;
    document.getElementById("set-latency").value=this.latencyMs;
    document.getElementById("set-keys").value=this.keys.join(","); }
  save(){ this.name=document.getElementById("set-name").value||"Player";
    this.latencyMs=parseInt(document.getElementById("set-latency").value||"0",10);
    this.keys=(document.getElementById("set-keys").value||"D,F,J,K").split(",").map(s=>s.trim().toUpperCase()).slice(0,4);
    localStorage.setItem("pf-settings", JSON.stringify({name:this.name, latencyMs:this.latencyMs, keys:this.keys}));
    alert("Saved."); }
}
