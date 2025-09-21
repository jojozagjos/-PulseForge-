// audio.js
// A small, persistent audio utility that never closes its AudioContext.
// Use AudioPlayer.resume() before playing and AudioPlayer.suspend() when pausing.

export class AudioPlayer {
  static _ctx = null;
  static _master = null;

  static get context() {
    if (!AudioPlayer._ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      AudioPlayer._ctx = new Ctx({ latencyHint: "interactive" });
      AudioPlayer._master = AudioPlayer._ctx.createGain();
      AudioPlayer._master.gain.value = 1.0;
      AudioPlayer._master.connect(AudioPlayer._ctx.destination);
    }
    return AudioPlayer._ctx;
  }

  static isRunning() {
    return AudioPlayer.context.state === "running";
  }

  static async resume() {
    const ctx = AudioPlayer.context;
    if (ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch (e) {
        console.warn("[Audio] resume failed:", e);
      }
    }
  }

  static async suspend() {
    const ctx = AudioPlayer.context;
    if (ctx.state === "running") {
      try {
        await ctx.suspend();
      } catch (e) {
        console.warn("[Audio] suspend failed:", e);
      }
    }
  }

  static master() {
    // Ensure the master node exists and is connected
    AudioPlayer.context;
    return AudioPlayer._master;
  }

  // Decode once and cache externally in your loader if needed.
  static async decode(arrayBuffer) {
    return await AudioPlayer.context.decodeAudioData(arrayBuffer.slice(0));
  }

  // Play a buffer at a given absolute AudioContext time offset
  // Returns { source, gain }
  static async playAt(audioBuffer, when = 0, { volume = 1.0 } = {}) {
    const ctx = AudioPlayer.context;
    await AudioPlayer.resume();

    const gain = ctx.createGain();
    gain.gain.value = volume;
    gain.connect(AudioPlayer.master());

    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(gain);
    const startAt = Math.max(ctx.currentTime, when);
    src.start(startAt);

    return { source: src, gain };
  }

  static stopNode(node) {
    try { node.stop(0); } catch {}
    try { node.disconnect(); } catch {}
  }
}
