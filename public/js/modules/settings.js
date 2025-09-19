export class Settings {
  constructor() {
    this.name = "";                 // start blank
    this.latencyMs = 0;
    this.keys = ["D","F","J","K"];
  }

  load() {
    try {
      const raw = localStorage.getItem("pf-settings") || "{}";
      const s = JSON.parse(raw);

      // Normalize legacy defaults
      let name = typeof s.name === "string" ? s.name.trim() : "";
      if (name === "Player") name = "";   // <-- treat old default as blank

      this.name = name;
      this.latencyMs = Number.isFinite(s.latencyMs) ? s.latencyMs : this.latencyMs;
      this.keys = Array.isArray(s.keys) && s.keys.length ? s.keys : this.keys;
    } catch {}

    // Reflect in UI (leave blank if empty)
    const $n = document.getElementById("set-name");
    const $l = document.getElementById("set-latency");
    const $k = document.getElementById("set-keys");
    if ($n) $n.value = this.name || "";
    if ($l) $l.value = this.latencyMs;
    if ($k) $k.value = (this.keys || []).join(",");
  }

  save() {
    const $n = document.getElementById("set-name");
    const $l = document.getElementById("set-latency");
    const $k = document.getElementById("set-keys");

    this.name = ($n?.value || "").trim();        // allow blank; guards elsewhere prevent playing
    this.latencyMs = parseInt($l?.value || "0", 10);
    this.keys = ($k?.value || "D,F,J,K")
      .split(",").map(s => s.trim().toUpperCase()).slice(0, 4);

    localStorage.setItem("pf-settings", JSON.stringify({
      name: this.name,
      latencyMs: this.latencyMs,
      keys: this.keys
    }));
    alert("Saved.");
  }
}
