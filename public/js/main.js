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

  // Register the service worker once (prevents repeated 404s if /sw.js is missing)
  // if ("serviceWorker" in navigator) {
  //   // Optional: only try if it actually exists to avoid console noise
  //   fetch("/sw.js", { method: "HEAD" })
  //     .then((r) => { if (r.ok) navigator.serviceWorker.register("/sw.js").catch(()=>{}); })
  //     .catch(()=>{ /* ignore */ });
  // }

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

  // Keep module instances here so we can mount/destroy cleanly.
  let soloInstance = null;
  let lbInstance = null;
  let editorInstance = null;

  function hideAllScreens() {
    for (const el of Object.values(screens)) if (el) el.classList.remove("active");
  }

  // Centralized show() that also performs per-screen teardown of the one we're leaving.
  function show(id) {
    // Which screen are we leaving?
    const leavingSettings = screens.settings?.classList.contains("active");
    const leavingSolo = screens.solo?.classList.contains("active");

    // Teardowns for the screen we're leaving
    if (leavingSettings) {
      // stop latency tester if running (public or private API)
      // (Safe even if method doesn't exist)
      settings.stopLatencyTest?.();
      settings.teardown?.();
      settings._stopLatencyTest?.();
    }
    if (leavingSolo) {
      // destroy Solo so re-entering is clean
      try { soloInstance?.destroy?.(); } catch {}
      soloInstance = null;
    }

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
  q("btn-solo")?.addEventListener("click", async () => {
    const name = (settings.name || "").trim();
    if (!name) {
      alert("Please set your Player Name in Settings before you start.");
      show("settings");
      setTimeout(() => q("set-name")?.focus(), 0);
      return;
    }

    show("solo");

    // Create once per entry; if you navigate away, show() above destroys it.
    if (!soloInstance) {
      soloInstance = new Solo(settings);
      await soloInstance.mount();
    }
  });

  // Back button from the Solo screen
  q("btn-back-from-solo")?.addEventListener("click", () => {
    // Important: tear down Solo so preview/context/listeners are cleaned up
    try { soloInstance?.destroy?.(); } catch {}
    soloInstance = null;
    show("main");
  });

  // ---------------- Leaderboards ----------------
  async function openLeaderboard() {
    show("leaderboard");
    if (!lbInstance) {
      lbInstance = new Leaderboard(settings);
      await lbInstance.mount?.();
    }
  }
  q("btn-view-leaderboard")?.addEventListener("click", openLeaderboard);
  q("btn-back-leaderboard")?.addEventListener("click", () => show("main"));

  // Optional: a Play button inside the leaderboard screen.
  q("lb-play")?.addEventListener("click", async () => {
    if (lbInstance?.getPlayableRuntime) {
      const runtime = await lbInstance.getPlayableRuntime();
      if (runtime) window.PF_startGame(runtime);
    } else {
      const sel = await window.PF_lb_getSelected?.(); // { track, diff, chartUrl }
      if (!sel) return;
      try {
        const chart = await fetch(sel.chartUrl).then(r => r.json());
        chart.audioUrl = sel.track.audio?.wav || sel.track.audio?.mp3;
        chart.title = sel.track.title;
        chart.bpm = sel.track.bpm;
        chart.difficulty = sel.diff;
        chart.trackId = sel.track.trackId;
        window.PF_startGame({ mode: "solo", manifest: chart });
      } catch (e) {
        console.error(e);
        alert("Could not load chart for this song.");
      }
    }
  });

  // ---------------- Results ----------------
  q("btn-replay")?.addEventListener("click", () => location.reload());

  // ---------------- Editor ----------------
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

    // If we launch from Solo, make sure we tear it down before the game
    try { soloInstance?.destroy?.(); } catch {}
    soloInstance = null;

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
        const m = runtime?.manifest || {};
        const trackId =
          m.trackId ||
          runtime?.track?.trackId ||
          (m.title ? m.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "unknown");

        const score = num(results.find(r => r.label === "Score")?.value);
        const acc = parseAccPct(results.find(r => r.label === "Accuracy")?.value);
        const combo = num(results.find(r => r.label === "Max Combo")?.value);

        const playerName =
          settings?.getName?.() ||
          settings?.name ||
          localStorage.getItem("pf_name") ||
          "Player";

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
