// public/js/main.js
import { Boot } from "./modules/boot.js?v=19";
import { Solo } from "./modules/solo.js?v=19";
import { Game } from "./modules/game.js?v=19";
import { Settings } from "./modules/settings.js?v=19";
import { Editor } from "./modules/editor.js?v=19";
import { Leaderboard } from "./modules/leaderboard.js?v=19";

function q(id) { return document.getElementById(id); }

window.addEventListener("DOMContentLoaded", () => {
  console.log("[PF] main.js build v19");

  const screens = {
    main: q("screen-main"),
    settings: q("screen-settings"),
    solo: q("screen-solo"),
    leaderboard: q("screen-leaderboard"),
    results: q("screen-results"),
    editor: q("screen-editor"),
  };

  const canvas = q("game-canvas");
  const hud = q("hud");

  function hideAllScreens() {
    for (const el of Object.values(screens)) if (el) el.classList.remove("active");
  }
  function show(id) {
    hideAllScreens();
    if (id && screens[id]) screens[id].classList.add("active");
    if (canvas) canvas.style.display = "none";
    if (hud) hud.classList.add("hidden");
  }

  // ---------------- Settings ----------------
  const settings = new Settings();
  settings.load?.();

  q("btn-settings")?.addEventListener("click", () => { show("settings"); settings.mount?.(); });
  q("btn-back-main")?.addEventListener("click", () => show("main"));
  q("btn-save-settings")?.addEventListener("click", () => settings.save?.());

  // ---------------- Solo ----------------
  // Replace your existing SOLO button handler in main.js with this:
  q("btn-solo")?.addEventListener("click", async () => {
    const name = (settings.name || "").trim();
    if (!name) {
      alert("Please set your Player Name in Settings before you start.");
      show("settings");
      setTimeout(() => q("set-name")?.focus(), 0);
      return;
    }

    show("solo");
    const solo = new Solo(settings);
    await solo.mount();
  });
  q("btn-back-from-solo")?.addEventListener("click", () => show("main"));

  // ---------------- Leaderboards ----------------
  let lbInstance = null;

  async function openLeaderboard() {
    show("leaderboard");
    if (!lbInstance) {
      // Mount once; module should populate songs and hook clicks
      lbInstance = new Leaderboard(settings);
      await lbInstance.mount?.();
    }
  }

  // Menu button -> Leaderboards
  q("btn-view-leaderboard")?.addEventListener("click", openLeaderboard);

  // Optional: a Play button inside the leaderboard screen.
  // We let the Leaderboard module prepare a runtime manifest and call PF_startGame itself,
  // but if it prefers delegating to us, expose a global starter below.
  q("lb-play")?.addEventListener("click", async () => {
    // Try to ask the module for a ready-to-play runtime if it exposes one.
    if (lbInstance?.getPlayableRuntime) {
      const runtime = await lbInstance.getPlayableRuntime();
      if (runtime) window.PF_startGame(runtime);
    } else {
      // Fallback: if Leaderboard set window.PF_lb_getSelected, use it.
      const sel = await window.PF_lb_getSelected?.(); // { track, diff, chartUrl }
      if (!sel) return;
      try {
        const chart = await fetch(sel.chartUrl).then(r => r.json());
        chart.audioUrl = sel.track.audio?.wav || sel.track.audio?.mp3;
        chart.title = sel.track.title;
        chart.bpm = sel.track.bpm;
        chart.difficulty = sel.diff;
        chart.trackId = sel.track.trackId; // critical for submissions
        window.PF_startGame({ mode: "solo", manifest: chart });
      } catch (e) {
        console.error(e);
        alert("Could not load chart for this song.");
      }
    }
  });
  q("btn-back-leaderboard")?.addEventListener("click", () => show("main"));

  // ---------------- Results ----------------
  q("btn-replay")?.addEventListener("click", () => location.reload());

  // ---------------- Editor ----------------
  let editorInstance = null;
  async function openEditor() {
    show("editor");
    if (!editorInstance && typeof Editor !== "undefined") {
      editorInstance = new Editor({
        canvasId: "editor-canvas",
        scrubId: "ed-scrub",
        bpmInputId: "ed-bpm",
        subdivInputId: "ed-subdiv",
        lanesInputId: "ed-lanes",
        zoomInputId: "ed-zoom",
        timeLabelId: "ed-time",
        helpLabelId: "ed-help",
        onExport: (json) => console.log("Exported chart JSON:", json),
      });
      editorInstance.newChart({ bpm: 120, lanes: 4, notes: [], durationMs: 180000 });
      editorInstance.mountToolbar();
    }
  }
  q("btn-editor")?.addEventListener("click", openEditor);
  q("btn-back-editor")?.addEventListener("click", () => show("main"));

  // ---------------- Game launcher + auto-submit ----------------

  // small helpers to parse the results array the Game returns
  const num = (s) => Number(String(s || "0").replace(/[^\d.-]/g, "")) || 0;
  const parseAccPct = (s) => (Number(String(s || "0").replace(/[^\d.]/g, "")) || 0) / 100;

  // Used by Leaderboard module (and Solo) to start a run.
  // Expects runtime.manifest.trackId to be set (Solo & LB should attach it).
  window.PF_startGame = function(runtime) {
    const nm = (settings.name || "").trim();
    if (!nm) {
      alert("Please set your Player Name in Settings before you start.");
      show("settings");
      setTimeout(() => q("set-name")?.focus(), 0);
      return;
    }
    hideAllScreens();
    if (canvas) canvas.style.display = "block";
    hud?.classList.remove("hidden");

    const game = new Game(runtime, settings);
    console.log("[PF] Game ctor done, starting run…");

    game.run().then(async (results) => {
      // Hide canvas + HUD
      if (canvas) canvas.style.display = "none";
      hud?.classList.add("hidden");

      // Render results
      const cont = q("results-container");
      if (cont) {
        cont.innerHTML = results.map(r => `<div class="results-row"><div>${r.label}</div><div>${r.value}</div></div>`).join("");
      }
      show("results");

      // ---------- Auto-submit to leaderboard ----------
      try {
        // Pull runtime metadata
        const m = runtime?.manifest || {};
        const trackId =
          m.trackId ||
          runtime?.track?.trackId ||
          (m.title ? m.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "unknown");

        // Extract numeric values from Game's result list
        // results: [{label:"Score", value:"12345"}, {label:"Accuracy", value:"97%"}, {label:"Max Combo", value:"123"}]
        const score = num(results.find(r => r.label === "Score")?.value);
        const acc = parseAccPct(results.find(r => r.label === "Accuracy")?.value);
        const combo = num(results.find(r => r.label === "Max Combo")?.value);

        const playerName =
          settings?.getName?.() ||
          settings?.name ||
          localStorage.getItem("pf_name") ||
          "Player";

        // Submit
        const res = await fetch("/api/leaderboard/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trackId, name: playerName, score, acc, combo })
        });
        const j = await res.json().catch(() => ({}));
        console.log("[PF] LB submit:", j);

        // If the leaderboard screen is open for this song, refresh table
        if (lbInstance?.refreshForTrackId && trackId) {
          lbInstance.refreshForTrackId(trackId);
        } else if (typeof window.PF_lb_refreshIfVisible === "function") {
          window.PF_lb_refreshIfVisible(trackId);
        }
      } catch (e) {
        console.warn("[PF] leaderboard submit failed:", e);
      }
    });
  };

  // Ensure we start on main menu
  show("main");
});
