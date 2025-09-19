// public/js/main.js
import { Boot } from "./modules/boot.js?v=9";
import { Solo } from "./modules/solo.js?v=9";
import { Lobby } from "./modules/lobby.js?v=9";
import { Game } from "./modules/game.js?v=9";
import { Settings } from "./modules/settings.js?v=9";

function q(id) {
  const el = document.getElementById(id);
  if (!el) console.warn("Missing DOM element:", id);
  return el;
}

window.addEventListener("DOMContentLoaded", () => {
  const boot = new Boot();

  const screens = {
    main: q("screen-main"),
    settings: q("screen-settings"),
    solo: q("screen-solo"),
    lobby: q("screen-lobby"),
    results: q("screen-results")
  };

  const canvas = q("game-canvas");
  const hud = q("hud");

  function show(id) {
    for (const el of Object.values(screens)) if (el) el.classList.remove("active");
    if (id && screens[id]) screens[id].classList.add("active");
    if (canvas) canvas.style.display = "none";
    if (hud) hud.classList.add("hidden");
  }

  const settings = new Settings();
  settings.load?.();

  q("btn-settings")?.addEventListener("click", () => { show("settings"); settings.mount?.(); });
  q("btn-back-main")?.addEventListener("click", () => show("main"));

  q("btn-solo")?.addEventListener("click", async () => {
    show("solo");
    const solo = new Solo(settings);
    await solo.mount();
  });

  q("btn-back-from-solo")?.addEventListener("click", () => show("main"));

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

  window.PF_startGame = function(runtime) {
    screens.main?.classList.remove("active");
    screens.settings?.classList.remove("active");
    screens.solo?.classList.remove("active");
    screens.lobby?.classList.remove("active");

    if (canvas) canvas.style.display = "block";   // show before constructing Game
    hud?.classList.remove("hidden");

    const game = new Game(runtime, settings);
    game.run().then(results => {
      if (canvas) canvas.style.display = "none";
      hud?.classList.add("hidden");
      const cont = q("results-container");
      if (cont) {
        cont.innerHTML = results
          .map(r => `<div class="results-row"><div>${r.label}</div><div>${r.value}</div></div>`)
          .join("");
      }
      show("results");
    });
  };

  q("btn-menu")?.addEventListener("click", () => show("main"));
  q("btn-replay")?.addEventListener("click", () => location.reload());
  q("btn-save-settings")?.addEventListener("click", () => settings.save?.());
});
