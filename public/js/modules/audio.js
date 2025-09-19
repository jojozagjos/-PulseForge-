
export class AudioPlayer{
  constructor(){ this.ctx=new (window.AudioContext||window.webkitAudioContext)(); this.buffer=null; }
  async load(url){ const arr=await fetch(url).then(r=>r.arrayBuffer()); this.buffer=await this.ctx.decodeAudioData(arr); }
  playAt(when){ const src=this.ctx.createBufferSource(); src.buffer=this.buffer; src.connect(this.ctx.destination); src.start(when); return src; }
}
