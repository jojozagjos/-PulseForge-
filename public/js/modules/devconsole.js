/* Dev Console Overlay
 * Provides clickable buttons for common debug commands.
 * Toggle with F10 or by setting window.PF_DEV = true before load.
 */

(function(){
  if (window.__PF_devconsole_loaded) return; window.__PF_devconsole_loaded = true;

  const LS_KEY = 'pf.devconsole';
  function loadState(){ try { return JSON.parse(localStorage.getItem(LS_KEY)||'{}')||{}; } catch { return {}; } }
  function saveState(s){ try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch {}
  }
  const state = loadState();

  let gameResolver = ()=>null;
  function getGame(){ try { return gameResolver(); } catch { return null; } }

  let lastRuntimeResolver = ()=>null;
  function getLastRuntime(){ try { return lastRuntimeResolver(); } catch { return null; } }

  function h(tag, attrs={}, ...children){
    const el = document.createElement(tag);
    for (const [k,v] of Object.entries(attrs||{})) {
      if (k === 'style' && typeof v === 'object') Object.assign(el.style, v); else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.substring(2), v); else if (v != null) el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null) continue; if (typeof c === 'string') el.appendChild(document.createTextNode(c)); else el.appendChild(c);
    }
    return el;
  }

  function section(title){
    const body = h('div', { class:'pf-sec-body' });
    const head = h('div', { class:'pf-sec-head' }, title);
    head.addEventListener('click', () => { body.classList.toggle('collapsed'); });
    return { wrap: h('div', { class:'pf-sec' }, head, body), body };
  }

  function button(label, fn){
    return h('button', { class:'pf-btn', onclick: fn, title: label }, label);
  }

  function smallInput(type, value, onChange){
    const inp = h('input', { class:'pf-inp', type, value: value ?? '' });
    inp.addEventListener('change', () => onChange(inp.value));
    return inp;
  }

  function checkbox(label, key, defaultVal, onChange){
    const id = 'pfchk_'+key;
    const wrap = h('label', { class:'pf-chk', for:id });
    const cb = h('input', { type:'checkbox', id });
    cb.checked = (key in state) ? !!state[key] : !!defaultVal;
    cb.addEventListener('change', () => { state[key] = cb.checked; saveState(state); onChange?.(cb.checked); });
    wrap.appendChild(cb); wrap.appendChild(document.createTextNode(' '+label));
    return wrap;
  }

  function log(msg, obj){ try { console.log('[DEV]', msg, obj||''); } catch {}
  }

  function createOverlay(){
    if (document.getElementById('pf-devconsole')) return;
    const root = h('div', { id:'pf-devconsole' });
    Object.assign(root.style, {
      position:'fixed', top:'12px', right:'12px', width:'320px', maxHeight:'80vh', overflow:'auto', background:'#0f1724cc', backdropFilter:'blur(4px)', border:'1px solid #2a3142', borderRadius:'10px', padding:'10px 10px 14px', font:'12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif', color:'#d9e7ff', zIndex:5000, boxShadow:'0 4px 18px -4px rgba(0,0,0,0.6)'
    });

    const closeBtn = h('button', { style:{ position:'absolute', top:'4px', right:'4px', background:'none', color:'#8ea2c5', border:'none', cursor:'pointer', fontSize:'14px' } }, '✕');
    closeBtn.addEventListener('click', () => root.remove());
    root.appendChild(closeBtn);
    root.appendChild(h('div', { style:{ fontWeight:600, marginBottom:'8px', fontSize:'13px' } }, 'PulseForge Dev Console'));

    // Section: Live Metrics (read-only)
    const liveSec = section('Live Metrics');
    const metricsBox = h('pre', { style:{ width:'100%', background:'#141f30', padding:'6px', borderRadius:'6px', lineHeight:'1.25em', fontSize:'11px', overflow:'auto' } }, 'No game');
    liveSec.body.append(metricsBox,
      button('Log Snapshot', () => { const snap = collectSnapshot(); log('Snapshot', snap); })
    );

    function collectSnapshot(){
      const g = getGame();
      if (!g || !g.state) return { noGame:true };
      const stats = g._gradThrottleStats || {};
      const lanes = (g._laneHeadIndex||[]).length;
      let activeNotes = 0;
      try {
        for (let i=0;i<lanes;i++) {
          const arr = g._noteSpritesByLane?.[i];
          if (arr && g._laneHeadIndex) activeNotes += Math.max(0, arr.length - g._laneHeadIndex[i]);
        }
      } catch {}
      return {
        timeMs: Math.round(g.state.timeMs||0),
        score: g.state.score,
        combo: g.state.combo,
        acc: +(g.state.acc||0).toFixed(4),
        gradQuality: +(g._gradQuality||0).toFixed?.(3),
        gradAvgGenMs: +(stats.avgGenMs||0).toFixed?.(3),
        gradLastMs: +(stats.lastGenMs||0).toFixed?.(3),
        activeNotes
      };
    }

    function updateLive(){
      const snap = collectSnapshot();
      if (snap.noGame) { metricsBox.textContent = 'No active game'; return; }
      metricsBox.textContent = 'timeMs      '+snap.timeMs+"\n"+
        'score       '+snap.score+"\n"+
        'combo       '+snap.combo+"\n"+
        'acc         '+snap.acc+"\n"+
        'gradQuality '+snap.gradQuality+"\n"+
        'gradAvgGenMs '+snap.gradAvgGenMs+"\n"+
        'gradLastMs  '+snap.gradLastMs+"\n"+
        'activeNotes '+snap.activeNotes;
    }

    if (window.__pfDevLiveInt) clearInterval(window.__pfDevLiveInt);
    window.__pfDevLiveInt = setInterval(updateLive, 500);
    setTimeout(updateLive, 50);

    // Section: Diagnostics Toggle
    const diagSec = section('Diagnostics');
    const diagBtn = button('Toggle PF_DIAG', () => {
      window.PF_DIAG = !window.PF_DIAG;
      updateDiagOverlay();
      diagBtn.textContent = window.PF_DIAG ? 'Disable PF_DIAG' : 'Enable PF_DIAG';
    });
    diagBtn.textContent = window.PF_DIAG ? 'Disable PF_DIAG' : 'Enable PF_DIAG';
    const diagInfo = h('div', { style:{ fontSize:'10px', opacity:0.8, width:'100%' } }, 'Shows small HUD: fps, frame ms, logic ms, grad gen ms.');
    diagSec.body.append(diagBtn, diagInfo);

    // Section: Logging Utilities
    const logSec = section('Logging');
    logSec.body.append(
      button('Export State', () => { const g=getGame(); if(!g) return alert('No active game'); const out=collectSnapshot(); log('Game State', out); }),
      button('Log Perf Stats', () => { const g=getGame(); if(!g) return alert('No game'); log('Gradient Stats', g._gradThrottleStats); }),
      button('Log Note Window', () => { const g=getGame(); if(!g) return alert('No game'); log('laneHeadIndex', g._laneHeadIndex); }),
      button('Log Lane Colors Now', () => { const g=getGame(); if(!g) return alert('No game'); const arr=[0,1,2,3].map(i=>g._vfxColorForLaneAt?.(g.state.timeMs,i)); log('Lane Colors', arr); }),
      button('Log Gradient Quality', () => { const g=getGame(); if(!g) return alert('No game'); log('GradQuality', g._gradQuality); }),
      button('List AudioCtx States', () => { try { [...(window.__PF_audioCtxs||[])].forEach(c=>log('Ctx', c.state)); } catch {} })
    );

  root.append(liveSec.wrap, diagSec.wrap, logSec.wrap);

    // Basic styles via injected <style>
    const style = h('style', {}, `#pf-devconsole button.pf-btn{margin:2px 4px 4px 0;padding:4px 8px;background:#1e2b40;border:1px solid #334761;color:#d9e7ff;border-radius:6px;font:600 11px system-ui;cursor:pointer;}
#pf-devconsole button.pf-btn:hover{background:#28415e;}
#pf-devconsole .pf-sec{margin-bottom:10px;border:1px solid #223248;border-radius:8px;overflow:hidden;}
#pf-devconsole .pf-sec-head{padding:4px 8px;font-weight:600;background:#162235;cursor:pointer;font-size:11px;letter-spacing:.5px;}
#pf-devconsole .pf-sec-body{padding:6px 8px;display:flex;flex-wrap:wrap;align-items:flex-start;}
#pf-devconsole .pf-sec-body.collapsed{display:none;}
#pf-devconsole label.pf-chk{display:block;font-size:11px;margin:4px 8px 4px 0;cursor:pointer;}
#pf-devconsole input.pf-inp{width:90px;padding:2px 4px;margin:2px 6px 6px 0;background:#132035;border:1px solid #2d425c;border-radius:4px;color:#c7daff;font:600 11px system-ui;}
`);
    root.appendChild(style);
    document.body.appendChild(root);
  }

  // Lightweight diagnostics overlay (no side-effects).
  function ensureDiagEl(){
    let el = document.getElementById('pf-diagnostics');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pf-diagnostics';
      Object.assign(el.style, {
        position:'fixed', left:'8px', top:'8px', background:'#0d1624cc', color:'#cfe3ff', font:'11px monospace', padding:'6px 8px', border:'1px solid #223248', borderRadius:'6px', zIndex:4999, whiteSpace:'pre', pointerEvents:'none'
      });
      document.body.appendChild(el);
    }
    return el;
  }

  let __pfDiagInt;
  function updateDiagOverlay(){
    if (!window.PF_DIAG){
      const el = document.getElementById('pf-diagnostics');
      if (el) el.remove();
      if (__pfDiagInt) { cancelAnimationFrame(__pfDiagInt); __pfDiagInt = 0; }
      return;
    }
    const el = ensureDiagEl();
    let lastT = performance.now();
    let frames = 0; let accMs = 0; let fps = 0; let lastFpsT = lastT;
    function tick(){
      const now = performance.now();
      const dt = now - lastT; lastT = now; frames++; accMs += dt;
      if (now - lastFpsT >= 1000){ fps = frames; frames = 0; lastFpsT = now; }
      const g = gameResolver?.();
      let gradMs = g? (g._gradThrottleStats?.lastGenMs||0).toFixed(2):'-';
      let logicMs = g? (g._lastLogicStepMs||0).toFixed?.(2):'-';
      // Rough memory (Chrome only)
      let mem = '-';
      try { if (performance.memory) mem = (performance.memory.usedJSHeapSize/1048576).toFixed(1)+'MB'; } catch {}
      el.textContent = `fps ${fps}\nframe ${dt.toFixed(2)} ms\nlogic ${logicMs} ms\ngradGen ${gradMs} ms\nmem ${mem}`;
      __pfDiagInt = requestAnimationFrame(tick);
    }
    if (!__pfDiagInt) __pfDiagInt = requestAnimationFrame(tick);
  }

  if (window.PF_DIAG) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', updateDiagOverlay); else updateDiagOverlay();
  }

  // Public init API
  window.PF_initDevConsole = function(opts){
    if (opts?.getGame) gameResolver = opts.getGame;
    if (opts?.getLastRuntime) lastRuntimeResolver = opts.getLastRuntime;
    createOverlay();
  };

  // Auto create if PF_DEV is set before load
  if (window.PF_DEV) {
    // Delay until DOM ready
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', createOverlay); else createOverlay();
  }

  // F10 toggle
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F10') {
      const open = document.getElementById('pf-devconsole');
      if (open) open.remove(); else createOverlay();
    }
  });
})();
