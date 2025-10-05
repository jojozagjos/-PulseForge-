import { Boot } from "./modules/boot.js?v=19"; // optional eager
import { Settings } from "./modules/settings.js?v=19"; // keep eager (small, used often)
// Solo, Game, Editor, Leaderboard are now lazy-loaded via dynamic import()

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
  console.log("[PF] main.js build v19+quit-audio+editor-startAt+prevActive");

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

  // ---- Module loader: cache + retry + tiny UX overlay ----
  const __pfModCache = new Map();
  let __pfLoaderEl = null;
  function __pfShowLoader(msg = "Loading…") {
    if (__pfLoaderEl) { try { __pfLoaderEl.querySelector('.msg').textContent = msg; } catch {} return; }
    const el = document.createElement('div');
    el.id = 'pf-loader';
    el.innerHTML = `<div class="card"><div class="spinner"></div><div class="msg">${msg}</div></div>`;
    Object.assign(el.style, { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display:'grid', placeItems:'center', zIndex: 3000 });
    const card = el.querySelector('.card');
    Object.assign(card.style, { background:'#0e1624', color:'#d9e7ff', border:'1px solid #2a3142', borderRadius:'10px', padding:'14px 18px', font:'600 14px system-ui' });
    const sp = el.querySelector('.spinner');
    Object.assign(sp.style, { width:'16px', height:'16px', border:'2px solid #2a3142', borderTopColor:'#6ab3ff', borderRadius:'50%', margin:'0 auto 10px', animation:'pfspin 1s linear infinite' });
    const style = document.createElement('style'); style.textContent = `@keyframes pfspin{to{transform:rotate(360deg)}}`;
    el.appendChild(style);
    document.body.appendChild(el);
    __pfLoaderEl = el;
  }
  function __pfHideLoader(){ if (__pfLoaderEl) { try { __pfLoaderEl.remove(); } catch {} __pfLoaderEl = null; } }
  async function loadModule(path, tries = 2) {
    if (__pfModCache.has(path)) return __pfModCache.get(path);
    const p = (async () => {
      let lastErr;
      for (let i = 0; i < tries; i++) {
        try { return await import(path); }
        catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 400 * (i + 1))); }
      }
      throw lastErr;
    })();
    __pfModCache.set(path, p);
    return p;
  }

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
      __pfShowLoader("Loading Solo…");
      try {
        const { Solo } = await loadModule("./modules/solo.js?v=19", 2);
        soloInstance = new Solo(settings);
        await soloInstance.mount();
      } catch (e) {
        console.error(e); alert("Could not load Solo. Please try again.");
      } finally { __pfHideLoader(); }
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
      __pfShowLoader("Loading Leaderboard…");
      try {
        const { Leaderboard } = await loadModule("./modules/leaderboard.js?v=19", 2);
        lbInstance = new Leaderboard(settings);
        await lbInstance.mount?.();
      } catch (e) {
        console.error(e); alert("Could not load Leaderboard. Please try again.");
      } finally { __pfHideLoader(); }
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
  function __wireEditorTabs() {
  if (window.__pf_editor_tabs_wired) return;
  window.__pf_editor_tabs_wired = true;
  try {
    const nav = document.querySelector('#screen-editor .ed-nav');
    const panels = document.querySelectorAll('#screen-editor .ed-panel');
    nav?.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      const tab = btn.getAttribute('data-tab');
      nav.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
      panels.forEach(p => p.classList.toggle('active', p.getAttribute('data-panel') === tab));
      // Notify listeners which tab is active (for VFX canvas sizing, etc.)
      try { window.dispatchEvent(new CustomEvent('pf-editor-tab-activated', { detail: { tab } })); } catch {}
    });
  } catch {}
}

async function openEditor() {
    show("editor");
    __wireEditorTabs();
    if (!editorInstance) {
      __pfShowLoader("Loading Editor…");
      try {
        const { Editor } = await loadModule("./modules/editor.js?v=19", 2);
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
      } catch (e) {
        console.error(e); alert("Could not load Editor. Please try again.");
      } finally { __pfHideLoader(); }
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
    try { g?.destroy?.(); } catch {}   // <— ensure PIXI + handlers are torn down

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
  window.PF_startGame = async function(runtime) {
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

    // Figure out which screen is active RIGHT NOW, before we hide everything.
    const prevActive =
      Object.entries(screens).find(([_, el]) => el && el.classList.contains("active"))?.[0] || "main";

    // Decide where Quit should take us for this run
    const returnTo = runtime?.returnTo || (prevActive === "editor" ? "editor" : "main");

    hideAllScreens();
    if (canvas) canvas.style.display = "block";
    hud?.classList.remove("hidden");

    // Defensive: enforce HUD layering above canvas at runtime
    try {
      if (canvas && hud) {
        const cZ = window.getComputedStyle(canvas).zIndex || '0';
        const hZ = window.getComputedStyle(hud).zIndex || '0';
        if ((+hZ||0) <= (+cZ||0)) {
          hud.style.zIndex = (+cZ||0) + 1;
          console.warn('[PF] Adjusted HUD z-index dynamically (was', hZ, 'canvas', cZ, ')');
        }
        // Also ensure positioning context
        if (getComputedStyle(hud).position === 'static') hud.style.position = 'absolute';
        if (getComputedStyle(canvas).position === 'static') canvas.style.position = 'absolute';
      }
    } catch {}

    // Ensure HUD is reset and visible each run (fixes missing combo/acc after quitting via Editor)
    try {
      const comboEl = document.getElementById("hud-combo");
      const accEl = document.getElementById("hud-acc");
      const scoreEl = document.getElementById("hud-score");
      const judgeEl = document.getElementById("judgment");
      if (comboEl) { comboEl.textContent = "0x"; comboEl.style.display = ""; comboEl.classList.remove("hidden"); }
      if (accEl)   { accEl.textContent = "100%"; accEl.style.display = ""; accEl.classList.remove("hidden"); }
      if (scoreEl) { scoreEl.textContent = "0"; scoreEl.style.display = ""; scoreEl.classList.remove("hidden"); }
      if (judgeEl) { judgeEl.innerHTML = ""; judgeEl.style.display = ""; judgeEl.classList.remove("hidden"); }
    } catch {}
    // Remove any stale results overlay that may linger after a prior run
    try { document.getElementById("pf-results-overlay")?.remove(); } catch {}


    __pfShowLoader("Loading Game…");
    let game;
    try {
      const { Game } = await loadModule("./modules/game.js?v=19", 2);
      game = new Game(runtime, settings);
      // Dev console game reference exposure (safe)
      try { window.__pfGame = game; } catch {}
      try { window.__pfLastRuntime = runtime; } catch {}
      if (window.PF_initDevConsole) {
        // Refresh binding if already loaded
        window.PF_initDevConsole({
          getGame: () => window.__pfGame,
          getLastRuntime: () => window.__pfLastRuntime
        });
      }
    } catch (e) {
      console.error(e); __pfHideLoader();
      alert("Could not load Game. Please try again.");
      show(returnTo);
      return;
    } finally { __pfHideLoader(); }
    PF_activeGame = game;

    // If the Game exposes a seek method and a startAtMs was provided, use it
    if (typeof runtime?.startAtMs === "number" && typeof game.seek === "function") {
      try { game.seek(runtime.startAtMs); } catch {}
    }

    // Quit handler
    makeQuitOverlay(() => {
      destroyActiveGame();
      show(returnTo);
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
        const totalScore = results.find(r => r.key === 'score')?.value || '0';
        const accLine = results.find(r => r.key === 'accuracy')?.value || '0%';
        const comboLine = results.find(r => r.key === 'combo')?.value || '0x';
        const score = num(totalScore);
        const accPct = parseAccPct(accLine);
        const maxCombo = num(comboLine);
        if (runtime?.manifest?.trackId && runtime?.difficulty) {
          fetch('/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: nm,
              trackId: runtime.manifest.trackId,
              difficulty: runtime.difficulty,
              score,
              accuracy: accPct,
              maxCombo,
            })
          }).catch(()=>{});
        }
      } catch (e) { console.warn('[PF] submit failed', e); }
    });
  };

  // Ensure we start on main menu
  show("main");

  // -------- Dev Console Dynamic Loader (F10) --------
  function ensureDevConsole(cb){
    if (window.PF_initDevConsole) { cb?.(); return; }
    import('./modules/devconsole.js').then(()=>cb?.()).catch(e=>console.warn('[PF] Dev console load failed', e));
  }
  function toggleDevConsole(){
    if (!window.PF_initDevConsole) { ensureDevConsole(()=>toggleDevConsole()); return; }
    const el = document.getElementById('pf-devconsole');
    if (el) { el.remove(); return; }
    window.PF_initDevConsole({
      getGame: () => window.__pfGame,
      getLastRuntime: () => window.__pfLastRuntime
    });
  }
  window.addEventListener('keydown', (e)=>{
    // if (e.key === 'F10') { e.preventDefault(); toggleDevConsole(); }
  });
  if (window.PF_DEV) {
    ensureDevConsole(()=>{
      window.PF_initDevConsole?.({ getGame:()=>window.__pfGame, getLastRuntime:()=>window.__pfLastRuntime });
    });
  }

  // Preload heavy modules after idle on capable devices; backup on first interaction
  try {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
    const canWarm = !settings.disableWarmPreload && !(navigator.connection && navigator.connection.saveData) && ((navigator.deviceMemory || 4) >= 4);
    let warmed = false;
    const doWarm = () => { if (warmed) return; warmed = true;
      loadModule("./modules/game.js?v=19").catch(()=>{});
      loadModule("./modules/solo.js?v=19").catch(()=>{});
      loadModule("./modules/editor.js?v=19").catch(()=>{});
      loadModule("./modules/leaderboard.js?v=19").catch(()=>{});
    };
    if (canWarm) idle(doWarm);
    if (!settings.disableWarmPreload) window.addEventListener('pointerdown', doWarm, { once: true });
  } catch {}

  // ---------------- Dev: Debug overlay + Safe Mode + error hooks ----------------
  (function PF_debugTools(){
    let dbg = null;
    let rafId = 0;
    let last = performance.now();
    let frames = 0, lastFps = 0;
    const times = [];
    const maxSamples = 60;
    let longTasks = 0; let lastLong = 0;

    function ensureDbg() {
      if (dbg) return dbg;
      dbg = document.createElement('div');
      dbg.id = 'pf-debug-overlay';
      Object.assign(dbg.style, {
        position: 'fixed', left: '8px', top: '8px', zIndex: 4000,
        background: 'rgba(14, 22, 36, 0.85)', color: '#d9e7ff',
        border: '1px solid #2a3142', borderRadius: '8px',
        padding: '8px 10px', font: '12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        boxShadow: '0 8px 24px rgba(0,0,0,.35)', display: 'none'
      });
      dbg.innerHTML = '<div><b>PF Debug</b></div>\n<div id="pfdbg-fps">FPS: —</div>\n<div id="pfdbg-ft">Frame: — ms</div>\n<div id="pfdbg-lt">Long tasks: 0 (last 0ms)</div>\n<div id="pfdbg-err" style="max-width:380px; white-space:pre-wrap;"></div>';
      document.body.appendChild(dbg);
      return dbg;
    }

    function loop(){
      const now = performance.now();
      frames++;
      const dt = now - last;
      times.push(dt);
      if (times.length > maxSamples) times.shift();
      if (now - last >= 1000) {
        last = now;
        lastFps = frames; frames = 0;
      }
      const avg = times.reduce((a,b)=>a+b,0) / (times.length||1);
      const el = ensureDbg();
      if (el && el.style.display !== 'none') {
        el.querySelector('#pfdbg-fps').textContent = `FPS: ${lastFps}`;
        el.querySelector('#pfdbg-ft').textContent  = `Frame: ${avg.toFixed(2)} ms`;
        el.querySelector('#pfdbg-lt').textContent  = `Long tasks: ${longTasks} (last ${Math.round(lastLong)}ms)`;
      }
      rafId = requestAnimationFrame(loop);
    }

    function toggleDbg(){
      const el = ensureDbg();
      const on = el.style.display === 'none';
      el.style.display = on ? 'block' : 'none';
      if (on && !rafId) rafId = requestAnimationFrame(loop);
      if (!on && rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    }

    // Perf long task observer (Chromium)
    try {
      if ('PerformanceObserver' in window) {
        const po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (e.entryType === 'longtask') { longTasks++; lastLong = e.duration || 0; }
          }
        });
        po.observe({ entryTypes: ['longtask'] });
      }
    } catch {}

    // Global error hooks
    function pushErr(msg){
      const el = ensureDbg();
      el.style.display = 'block';
      const err = el.querySelector('#pfdbg-err');
      err.textContent = String(msg).slice(0, 500);
    }
    window.addEventListener('error', (e)=>{ try { pushErr(e.message || e.error || 'Unknown error'); } catch {} });
    window.addEventListener('unhandledrejection', (e)=>{ try { pushErr(e.reason?.message || e.reason || 'Unhandled rejection'); } catch {} });

    // Hotkey: F8 = toggle debug overlay
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F8') { e.preventDefault(); toggleDbg(); }
    });
  })();
});
