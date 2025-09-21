// public/js/modules/audio.js
export class AudioPlayer {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: "interactive",
    });
    this.buffer = null;
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);
    this._unlocked = false;

    const unlock = async () => {
      try {
        if (this.ctx.state === "suspended") await this.ctx.resume();
        this._unlocked = (this.ctx.state === "running");
      } catch {}
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    window.addEventListener("touchstart", unlock, { once: true });
  }

  async ensureReady() {
    if (this.ctx.state === "suspended") {
      try { await this.ctx.resume(); } catch {}
    }
    return this.ctx.state === "running";
  }

  async load(url) {
    await this.ensureReady();
    let arrayBuffer;
    if ((url || "").startsWith("blob:")) {
      arrayBuffer = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url);
        xhr.responseType = "arraybuffer";
        xhr.onload = () => resolve(xhr.response);
        xhr.onerror = () => reject(new Error("Blob fetch failed"));
        xhr.send();
      });
    } else {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      arrayBuffer = await res.arrayBuffer();
    }
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    return this.buffer.duration;
  }

  async loadFromArrayBuffer(arrayBuffer) {
    await this.ensureReady();
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    return this.buffer.duration;
  }

  playAt(whenSec, opts = {}) {
    if (!this.buffer) throw new Error("No buffer loaded.");
    const {
      gain = 1,
      fadeInMs = 0,
      offsetSec = 0, // NEW: start inside the buffer at this offset (seconds)
    } = opts;

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;

    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g);
    g.connect(this.master);

    const now = this.ctx.currentTime;
    const startTime = Math.max(now, whenSec);

    // start at buffer offset
    const off = Math.max(0, Number(offsetSec) || 0);
    try { src.start(startTime, off); } catch { src.start(startTime); }

    if (fadeInMs > 0) {
      const t0 = startTime;
      const t1 = t0 + fadeInMs / 1000;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain, t1);
    } else {
      g.gain.setValueAtTime(gain, startTime);
    }

    const handle = {
      source: src,
      stop: (when = 0) => {
        try { src.stop(when); } catch {}
        try { src.disconnect(); } catch {}
        try { g.disconnect(); } catch {}
      }
    };
    return handle;
  }

  perfTimeForAudioTime(audioTimeSec) {
    const perfAtAudioZero = performance.now() - this.ctx.currentTime * 1000;
    return perfAtAudioZero + audioTimeSec * 1000;
  }

  setMasterVolume(v) {
    this.master.gain.value = Math.max(0, Math.min(1, Number(v) || 0));
  }
}
