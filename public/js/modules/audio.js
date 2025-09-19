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

    // Try to unlock on common user gestures
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

  /** Ensure the context is running (iOS/Chrome may start suspended). */
  async ensureReady() {
    if (this.ctx.state === "suspended") {
      try { await this.ctx.resume(); } catch {}
    }
    return this.ctx.state === "running";
  }

  /** Load audio from URL or blob URL. Keeps AudioBuffer in memory. */
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

  /** Optional: load from already-fetched ArrayBuffer. */
  async loadFromArrayBuffer(arrayBuffer) {
    await this.ensureReady();
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    return this.buffer.duration;
  }

  /**
   * Schedule playback at absolute AudioContext time (seconds).
   * opts: { gain=1, fadeInMs=0 }
   *
   * Returns { source, stop() }.
   */
  playAt(whenSec, opts = {}) {
    if (!this.buffer) throw new Error("No buffer loaded.");
    const { gain = 1, fadeInMs = 0 } = opts;

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;

    // Per-track gain (goes into master)
    const g = this.ctx.createGain();
    g.gain.value = 0; // start at 0 if we fade in, we’ll ramp
    src.connect(g);
    g.connect(this.master);

    // Align to context timeline
    const now = this.ctx.currentTime;
    const startTime = Math.max(now, whenSec);
    src.start(startTime);

    // Simple fade-in to avoid click at start
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

  /**
   * Helper: map a *future* AudioContext time (seconds) to performance.now() (ms).
   * Use this to perfectly align your game’s timeline with audio:
   *
   * const startAtSec = player.ctx.currentTime + 3; // 3s lead-in
   * const perfStartMs = player.perfTimeForAudioTime(startAtSec);
   */
  perfTimeForAudioTime(audioTimeSec) {
    // performance.now() that corresponds to ctx.currentTime === now
    const perfAtAudioZero = performance.now() - this.ctx.currentTime * 1000;
    return perfAtAudioZero + audioTimeSec * 1000;
  }

  setMasterVolume(v) {
    this.master.gain.value = Math.max(0, Math.min(1, Number(v) || 0));
  }
}
