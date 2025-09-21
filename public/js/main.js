// public/js/main.js
import { Boot } from "./modules/boot.js?v=19";
import { Solo } from "./modules/solo.js?v=19";
import { Game } from "./modules/game.js?v=19";
import { Settings } from "./modules/settings.js?v=19";
import { Editor } from "./modules/editor.js?v=19";
import { Leaderboard } from "./modules/leaderboard.js?v=19";

function q(id) { return document.getElementById(id); }

/* ---------------- Global audio guard (force-silence) ----------------
   We patch AudioContext constructors to keep a registry of every context
   created while the app is running. On Quit we can close/suspend them so
   music *actually* stops even if the Game doesn't expose a stop() API.
------------------------------------------------------------------------ */
(function PF_patchAudioRegistry() {
  if (window.__PF_ac_patched) return;
  window.__PF_audioCtxs = window.__PF_audioCtxs || new Set();

  function patch(name) {
    const Orig = window[name];
    if (!Orig) return;
    const Patched = function(...args) {
      const ctx = new Orig(...args);
      try { window.__PF_audioCtxs.add(ctx); } catch {}
      return ctx;
    };
    try {
      Patched.prototype = Orig.prototype;
      Object.setPrototypeOf(Patched, Orig);
    } catch {}
    window[`__PF_Orig_${name}`] = Orig;
    try { window[name] = Patched; } catch {}
  }

  patch("AudioContext");
  patch("webkitAudioContext");
  window.__PF_ac_patched = true;
})();

window.PF_forceSilenceAll = function PF_forceSilenceAll() {
  // Close/suspend any WebAudio contexts we know about
  if (window.__PF_audioCtxs) {
    for (const ctx of Array.from(window.__PF_audioCtxs)) {
      if (!ctx) continue;
      try {
        if (typeof ctx.close === "function" && ctx.state !== "closed") {
          ctx.close().catch(()=>{});
        } else if (typeof ctx.suspend === "function" && ctx.state !== "closed") {
          ctx.suspend().catch(()=>{});
        }
      } catch {}
    }
  }
  // Also pause any <audio> tags if present
  try {
    document.querySelectorAll("audio").forEach(a => { try { a.pause(); a.currentTime = 0; } catch {} });
  } catch {}
};

window.addEventListener("DOMContentLoaded", () => {
  console.log("[PF] main.js build v19+quit-audio+editor-startAt");

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

  let soloInstance = null;
  let lbInstance = null;
  let editorInstance = null;

  // Active game guard so we can force-stop on quit or new launches
  let PF_activeGame = null;
  let PF_quitOverlay = null;
  let PF_quitKeyHandler = null;

  function hideAllScreens() {
    for (const el of Object.values(screens)) if (el) el.classList.remove("active");
  }

  function show(id) {
    // Teardowns for the screen we're leaving
    const leavingSettings = screens.settings?.classList.contains("active");
    const leavingSolo = screens.solo?.classList.contains("active");

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
        window.PF_startGame({ mode: "solo", manifest: chart, allowExit: false });
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

  // ---------------- Game teardown helpers ----------------

  function destroyActiveGame() {
    // Mark inactive first so late resolves don't render results
    const g = PF_activeGame;
    PF_activeGame = null;

    // Tell the game (if it listens) we are quitting now
    try { window.dispatchEvent(new CustomEvent("pf-quit-game")); } catch {}

    // Best-effort: stop/shutdown any game exposed hooks
    try { g?.quit?.(); } catch {}
    try { g?.stop?.(); } catch {}
    try { g?.end?.(); } catch {}

    // Hard stop: silence *all* audio contexts and <audio> tags
    window.PF_forceSilenceAll?.();

    // Remove quit UI + key handler
    if (PF_quitOverlay) {
      try { PF_quitOverlay.remove(); } catch {}
      PF_quitOverlay = null;
    }
    if (PF_quitKeyHandler) {
      try { window.removeEventListener("keydown", PF_quitKeyHandler); } catch {}
      PF_quitKeyHandler = null;
    }

    // Hide canvas/HUD
    if (canvas) canvas.style.display = "none";
    hud?.classList.add("hidden");
  }

  function makeQuitOverlay(onQuit) {
    // Remove any prior overlay
    if (PF_quitOverlay) { try { PF_quitOverlay.remove(); } catch {} PF_quitOverlay = null; }
    if (PF_quitKeyHandler) { try { window.removeEventListener("keydown", PF_quitKeyHandler); } catch {} PF_quitKeyHandler = null; }

    const btn = document.createElement("button");
    btn.textContent = "Quit";
    btn.style.position = "fixed";
    btn.style.left = "12px";
    btn.style.bottom = "12px";
    btn.style.zIndex = "2000";
    btn.style.padding = "8px 12px";
    btn.style.borderRadius = "10px";
    btn.style.background = "rgba(0,0,0,0.55)";
    btn.style.border = "1px solid rgba(255,255,255,0.25)";
    btn.style.color = "#fff";
    btn.style.font = "600 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    btn.style.cursor = "pointer";
    btn.addEventListener("click", () => { onQuit(); });

    PF_quitOverlay = btn;
    document.body.appendChild(btn);

    // ESC also quits
    PF_quitKeyHandler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onQuit();
      }
    };
    window.addEventListener("keydown", PF_quitKeyHandler);
  }

  // ---------------- Game launcher + auto-submit ----------------

  const num = (s) => Number(String(s || "0").replace(/[^\d.-]/g, "")) || 0;
  const parseAccPct = (s) => (Number(String(s || "0").replace(/[^\d.]/g, "")) || 0) / 100;

  // Used by Leaderboard + Solo + Editor to start a run.
  window.PF_startGame = function(runtime) {
    const nm = (settings.name || "").trim();
    if (!nm) {
      alert("Please set your Player Name in Settings before you start.");
      show("settings");
      setTimeout(() => q("set-name")?.focus(), 0);
      return;
    }

    // Tear down any previous game + silence prior audio to avoid stacking
    destroyActiveGame();
    window.PF_forceSilenceAll?.();

    // Leave Solo screen cleanly before game start
    try { soloInstance?.destroy?.(); } catch {}
    soloInstance = null;

    hideAllScreens();
    if (canvas) canvas.style.display = "block";
    hud?.classList.remove("hidden");

    const game = new Game(runtime, settings);
    PF_activeGame = game;

    // If the Game exposes a seek method and a startAtMs was provided, use it
    if (typeof runtime?.startAtMs === "number" && typeof game.seek === "function") {
      try { game.seek(runtime.startAtMs); } catch {}
    }

    // Quit handler
    makeQuitOverlay(() => {
      destroyActiveGame();
      // If editor exists/was open, go back there; otherwise main menu
      if (screens.editor?.classList.contains("active")) {
        show("editor");
      } else {
        show("main");
      }
    });

    // Start the run
    game.run().then(async (results) => {
      // If user quit early, ignore late resolves
      if (PF_activeGame !== game) return;

      destroyActiveGame();

      // Render results
      const cont = q("results-container");
      if (cont) {
        cont.innerHTML = results.map(r => `<div class="results-row"><div>${r.label}</div><div>${r.value}</div></div>`).join("");
      }
      show("results");

      // ---------- Auto-submit to leaderboard ----------
      try {
        if (runtime && runtime.autoSubmit === false) {
          return; // editor playtests won't post
        }

        const m = runtime?.manifest || {};
        const trackId =
          m.trackId ||
          runtime?.track?.trackId ||
          (m.title ? m.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "unknown");

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

        if (typeof window.PF_lb_refreshIfVisible === "function") {
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
