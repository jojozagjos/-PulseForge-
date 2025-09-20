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
      settings.stopLatencyTest?.();
      settings.teardown?.();
      settings._stopLatencyTest?.();
    }
    if (leavingSolo) {
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

    if (!soloInstance) {
      soloInstance = new Solo(settings);
      await soloInstance.mount();
    }
  });

  // Back button from the Solo screen
  q("btn-back-from-solo")?.addEventListener("click", () => {
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

  // Lightweight overlay for quitting playtest
  function makeQuitOverlay(onQuit) {
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      position: "fixed", inset: "0", pointerEvents: "none"
    });
    const btn = document.createElement("button");
    btn.textContent = "Quit";
    Object.assign(btn.style, {
      position: "absolute", right: "16px", top: "16px",
      padding: "6px 10px", borderRadius: "8px",
      background: "rgba(0,0,0,0.55)", color: "#fff",
      border: "1px solid rgba(255,255,255,0.2)",
      cursor: "pointer", pointerEvents: "auto", zIndex: 9999
    });
    btn.addEventListener("click", () => onQuit());
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
    return () => wrap.remove();
  }

  // Used by Leaderboard/Editor/Solo to start a run.
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

    // Ensure flags are present
    runtime = runtime || {};
    // Prevent any internal self-submit in Game
    runtime.autoSubmit = false;

    // Create & run the Game
    const game = new Game(runtime, settings);

    // If the Game exposes a 'seek' method, honor runtime.startAtMs
    const startOffset = Math.max(0, Number(runtime.startAtMs || 0) || 0);
    try { if (startOffset && typeof game.seek === "function") game.seek(startOffset); } catch {}

    // Optional quit overlay (playtests etc.)
    let removeQuit = null;
    const allowExit = runtime.allowExit !== false; // default true
    if (allowExit) {
      removeQuit = makeQuitOverlay(forceQuit);
      window.addEventListener("keydown", onEsc);
    }

    function cleanupOverlay() {
      try { window.removeEventListener("keydown", onEsc); } catch {}
      try { removeQuit?.(); } catch {}
    }
    function onEsc(e) {
      if (e.key === "Escape") forceQuit();
    }
    async function forceQuit() {
      cleanupOverlay();
      // Try to abort/destroy if Game supports it
      try { game.abort?.(); } catch {}
      try { game.destroy?.(); } catch {}
      // Hide canvas/HUD and go back where we came from (editor if visible before)
      if (canvas) canvas.style.display = "none";
      hud?.classList.add("hidden");
      // Return to editor if it exists; else main
      if (screens.editor) show("editor"); else show("main");
    }

    game.run().then(async (results) => {
      cleanupOverlay();

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
        // Skip auto-submit if caller asked us to (Leaderboard may do it itself)
        if (runtime && runtime.autoSubmit === false) {
          // We handle submission here (main.js), Game itself shouldn't submit.
          // Continue.
        }

        // Pull runtime metadata
        const m = runtime?.manifest || {};
        const trackId =
          m.trackId ||
          runtime?.track?.trackId ||
          (m.title ? m.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "unknown");

        // Extract difficulty safely from several places
        const difficulty =
          m.difficulty ||
          runtime?.difficulty ||
          (typeof runtime?.diff === "string" ? runtime.diff : null) ||
          "normal";

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
          body: JSON.stringify({ trackId, difficulty, name: playerName, score, acc, combo })
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
