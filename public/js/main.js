// public/js/main.js
import { Boot } from "./modules/boot.js?v=17";
import { Solo } from "./modules/solo.js?v=17";
import { Lobby } from "./modules/lobby.js?v=17";
import { Game } from "./modules/game.js?v=17";
import { Settings } from "./modules/settings.js?v=17";
import { Editor } from "./modules/editor.js?v=17";

function q(id) { return document.getElementById(id); }

window.addEventListener("DOMContentLoaded", () => {
  console.log("[PF] main.js build v17");

  const screens = {
    main: q("screen-main"),
    settings: q("screen-settings"),
    solo: q("screen-solo"),
    lobby: q("screen-lobby"),
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

  const settings = new Settings();
  settings.load?.();

  // SETTINGS
  q("btn-settings")?.addEventListener("click", () => { show("settings"); settings.mount?.(); });
  q("btn-back-main")?.addEventListener("click", () => show("main"));
  q("btn-save-settings")?.addEventListener("click", () => settings.save?.());

  // SOLO
  q("btn-solo")?.addEventListener("click", async () => {
    show("solo");
    const solo = new Solo(settings);
    await solo.mount();
  });
  q("btn-back-from-solo")?.addEventListener("click", () => show("main"));

  // MULTI
  q("btn-quick")?.addEventListener("click", async () => {
    const lobby = new Lobby(settings);
    await lobby.quickMatch();
    show("lobby");
    lobby.mount?.(() => show("main"));
  });
  q("btn-party")?.addEventListener("click", async () => {
    const lobby = new Lobby(settings);
    await lobby.hostParty();
    show("lobby");
    lobby.mount?.(() => show("main"));
  });

  // RESULTS
  q("btn-replay")?.addEventListener("click", () => location.reload());

  // EDITOR (blank start)
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

      // Start BLANK instead of auto-loading a manifest
      editorInstance.newChart({
        bpm: 120,
        lanes: 4,
        notes: [],
        durationMs: 180000
      });

      editorInstance.mountToolbar();
    }
  }
  q("btn-editor")?.addEventListener("click", openEditor);
  q("btn-back-editor")?.addEventListener("click", () => show("main"));

  // GAME START
  window.PF_startGame = function(runtime) {
    hideAllScreens();
    if (canvas) canvas.style.display = "block";
    hud?.classList.remove("hidden");

    const game = new Game(runtime, settings);
    console.log("[PF] Game ctor done, starting run…");
    game.run().then(results => {
      if (canvas) canvas.style.display = "none";
      hud?.classList.add("hidden");
      const cont = q("results-container");
      if (cont) {
        cont.innerHTML = results.map(r => `<div class="results-row"><div>${r.label}</div><div>${r.value}</div></div>`).join("");
      }
      show("results");
    });
  };
});
