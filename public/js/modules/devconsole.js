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

    // Section: Game
    const gameSec = section('Game');
    gameSec.body.append(
      button('Start (Last Runtime)', () => {
        const rt = getLastRuntime();
        if (!rt) return alert('No last runtime available. Start a song normally first.');
        window.PF_startGame?.(rt);
      }),
      button('Force Silence', () => window.PF_forceSilenceAll?.()),
      button('Export State', () => {
        const g = getGame(); if (!g) return alert('No active game');
        const out = { timeMs:g.state?.timeMs, score:g.state?.score, combo:g.state?.combo, acc:g.state?.acc, judges:g.state?.judges };
        log('Game State', out); console.table(out.judges);
      }),
      button('Log Perf Stats', () => { const g=getGame(); if(!g) return alert('No game'); log('Gradient Stats', g._gradThrottleStats); log('GradQuality', g._gradQuality); }),
      button('Log Note Window', () => { const g=getGame(); if(!g) return alert('No game'); log('laneHeadIndex', g._laneHeadIndex); })
    );

    // Section: VFX
    const vfxSec = section('VFX');
    vfxSec.body.append(
      button('Keyframe Verify Once', () => { window.PF_KEYFRAME_VERIFY = true; alert('Will log on next start'); }),
      button('Log Lane Colors Now', () => { const g=getGame(); if(!g) return alert('No game'); const arr=[0,1,2,3].map(i=>g._vfxColorForLaneAt?.(g.state.timeMs,i)); log('Lane Colors', arr); }),
      button('Log Gradient Quality', () => { const g=getGame(); if(!g) return alert('No game'); log('GradQuality', g._gradQuality); })
    );

    // Section: Audio
    const audSec = section('Audio');
    audSec.body.append(
      button('Resume All Ctx', () => { try { [...(window.__PF_audioCtxs||[])].forEach(c=>c.resume?.()); } catch {} }),
      button('List Ctx States', () => { try { [...(window.__PF_audioCtxs||[])].forEach(c=>log('Ctx', c.state)); } catch {} })
    );

    // Section: Start Options
    const startSec = section('Start Options');
    const startAtInp = smallInput('number', state.startAtMs || '', (v)=>{ state.startAtMs = Number(v)||0; saveState(state); });
    startSec.body.append(h('div',{}, 'Mid Song Start (ms): ', startAtInp));
    startSec.body.append(
      checkbox('Auto Keyframe Verify', 'autoKF', false, (v)=>{}),
      checkbox('Auto Diagnostics (flag)', 'autoDiag', false, (v)=>{}),
      button('Start With Options', () => {
        const rt = getLastRuntime(); if(!rt) return alert('No last runtime');
        const clone = JSON.parse(JSON.stringify(rt));
        if (state.startAtMs) clone.startAtMs = state.startAtMs;
        if (state.autoKF) window.PF_KEYFRAME_VERIFY = true;
        if (state.autoDiag) window.PF_DIAG = true;
        window.PF_startGame?.(clone);
      })
    );

    root.append(gameSec.wrap, vfxSec.wrap, audSec.wrap, startSec.wrap);

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
