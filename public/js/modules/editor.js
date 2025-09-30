// public/js/modules/editor.js
// PulseForge Chart Editor — metronome, playtest, center-follow, true zoom scaling, Undo/Redo, QoL tools
export class Editor {
  constructor(opts) {
    this.canvas = document.getElementById(opts.canvasId);
    this.ctx = this.canvas.getContext("2d");

    // UI ids (match your HTML)
    this.ids = {
      // Core controls
      scrub: opts.scrubId,
      bpm: opts.bpmInputId,
      subdiv: opts.subdivInputId,
      lanes: opts.lanesInputId,
      zoom: opts.zoomInputId,
      time: opts.timeLabelId,
      help: opts.helpLabelId,

      // Extra UI
      followToggle: "ed-follow",
      zoomIndicator: "ed-zoom-indicator",
      metroToggle: "ed-metro",
      testBtn: "ed-test",
      undoBtn: "ed-undo",
      redoBtn: "ed-redo",

      // Audio picker
      audioUrl: "ed-audio-url",
      audioLoadUrl: "ed-audio-load-url",
      audioFileInput: "ed-audio-file",
      audioUseFileBtn: "ed-audio-use-file",
      audioApplyManifest: "ed-audio-apply-manifest",
      audioHint: "ed-audio-hint",

      // File toolbar
      fileOpenUrl: "ed-open-url",
      fileOpenFileInput: "ed-open-file",
      fileOpenUseBtn: "ed-open-use-file",
      fileSaveAs: "ed-save-as",
      fileLoadManifestUrl: "ed-manifest-url",
      fileDifficulty: "ed-diff",
      fileClearNotes: "ed-clear-notes",

      // Transport buttons in the HTML
      playBtn: "ed-play",
      pauseBtn: "ed-pause",
      stopBtn: "ed-stop"
    };

    // Audio state
    this.audioCtx = null;
    this.audioBuffer = null;
    this.audioSource = null;
    this.masterGain = null;
    this.metroGain = null;
    this.audioUrl = null;

    // Keep last decoded bytes so we can re-decode after context recreation (if URL not available)
    this._lastAudioArrayBuffer = null;

    // Load saved volume now; apply to masterGain once AudioContext exists
    this._volume = this._getSavedVolume();

    // Transport
    this.playing = false;
    this.playStartCtxTime = 0; // AudioContext time when current run started
    this.playStartMs = 0;      // Musical offset for the current run (ms)

    // Metronome
    this.metronome = { enabled: false, lookaheadMs: 120, nextBeatMs: 0, timer: null };

    // Data
    this.manifest = null;
    this.manifestUrl = null;
    this.chart = null; // { bpm, lanes, durationMs, notes:[{tMs,lane,dMs?}] }
    this.chartUrl = null;
    this.difficulty = "normal";

    // View/scroll
    this.zoomY = 1.0;     // vertical zoom (affects note size, lane stems, etc.)
    this.scrollY = 0;     // pixels from time 0 (CSS px)
    this.pxPerMs = 0.35;  // base scale — actual is pxPerMs * zoomY

    // Perception tuning (ms) — added to playhead for drawing flashes
    this.editorLatencyMs = 0;

    // Tools & selection
    this.tool = "create"; // create | select | stretch | delete | copy | paste
    this.subdiv = 4;
    this.snap = true;
    this.selection = new Set();
    this.clipboard = [];
    this.drag = null;
    this.mouse = { x: 0, y: 0, lane: 0 };

    // Follow playhead
    this.follow = false;

    // Style palette
    this.colors = {
      bg: "#0a0c10",
      gridMinor: "#223048",
      gridMajor: "#2e405c",
      gridDecade: "#c93f3fff", //3fc1c9
      laneFill: "#111725",
      laneStroke: "#2a3142",
      noteHead: "#19cdd0",
      noteHeadStroke: "#0ea7a9",
      holdBody: "rgba(15,163,160,0.55)",
      selection: "#ffd166",
      playhead: "#25f4ee",
      boxSelect: "rgba(255, 209, 102, 0.16)",
      boxSelectBorder: "#ffd166",
      toolActiveBg: "#2a3142",
      toolActiveOutline: "1px solid #3fc1c9"
    };

    // Guards to wire only once
    this._wiredAudio = false;
    this._wiredFile = false;
    this._wiredFollow = false;
    this._wiredMetro = false;
    this._wiredTest = false;
    this._wiredZoomIndicator = false;
    this._wiredHistoryButtons = false;

    // Placement helpers (note visuals scale with zoom)
    this.minGapMs = 60;
    this.baseHeadH = 28;           // tap/hold head height (px @ zoom 1)
    this.headPad = 10;             // head corner radius
    this.tailHandlePadMs = 90;     // tail stretch tolerance (ms)

    // History (Undo/Redo)
    this._undo = [];
    this._redo = [];
    this._historyLimit = 100;

    // Bind methods
    this._tick = this._tick.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._resize = this._resize.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._metroSchedulerTick = this._metroSchedulerTick.bind(this);

    // Live volume sync (from Settings screen)
    window.addEventListener("pf-volume-changed", (e) => {
      const v = Number(e?.detail?.volume);
      if (Number.isFinite(v)) this.setVolume(v);
    });
    window.addEventListener("pf-volume", (e) => {
      const v = Number(e?.detail?.volume);
      if (Number.isFinite(v)) this.setVolume(v);
    });

    // Size & listeners
    this._resize();
    window.addEventListener("resize", this._resize);

    // Block page scrolling when using the editor canvas
    this.canvas.addEventListener("wheel", this._onWheel, { passive: false });
    this.canvas.addEventListener("mousedown", e => {
      if (e.button === 1) e.preventDefault(); // middle-drag pan without autoscroll
    });

    window.addEventListener("keydown", this._onKeyDown);

    // Pointer
    this.canvas.addEventListener("pointermove", e => this._pointerMove(e));
    this.canvas.addEventListener("pointerdown", e => this._pointerDown(e));
    window.addEventListener("pointerup", e => this._pointerUp(e));

    requestAnimationFrame(this._tick);

    // External hooks
    this.onExport = opts.onExport || (() => {});

    // ===== VFX Editor System =====
    this.vfx = this._initVFXSystem();
  }

  // ===== VFX Editor System =====
  _initVFXSystem() {
    const vfx = {
      // Current VFX data structure
      data: {
        background: {
          color1: "#0d111a",
          color2: "#1a1f2e", 
          gradient: false,
          angle: 0,
          flashEnable: false,
          flashColor: "#ffffff",
          flashIntensity: 30,
          flashDuration: 200
        },
        camera: {
          x: 0,
          y: 0,
          z: 0,
          zoom: 1.0,
          angle: 0,
          perspective: 50
        },
        view: {
          mode: "2D"
        },
        notes: {
          colors: ["#19cdd0", "#8A5CFF", "#C8FF4D", "#FFA94D"],
          glow: 20,
          size: 1.0,
          trails: false
        },
        lanes: {
          opacity: 100,
          pulsing: false,
          glow: 0
        }
      },

      // Keyframes for each property
      keyframes: {
        // Example structure:
        // "background.color1": [
        //   { time: 0, value: "#0d111a", easing: "instant" },
        //   { time: 30000, value: "#ff0000", easing: "linear" }
        // ]
      },

      // Current timeline state
      timeline: {
        currentProperty: "background.color1",
        currentEasing: "linear",
        zoom: 1.0,
        selectedKeyframe: null,
        playheadTime: 0,
        currentCategory: "background",
        offsetMs: 0,           // left edge time of the visible window
        hoverKeyframe: null    // { property, index } when hovering
      },

      // VFX timeline canvas
      timelineCanvas: null,
      timelineCtx: null,

      // Wiring flags
      _wiredVFX: false,
      _wiredVFXTimeline: false
    };

    // Initialize VFX canvas
    this._initVFXCanvas(vfx);
    
    // Wire VFX controls
    this._wireVFXControls(vfx);

    // Listen for tab activation to resize and refresh VFX UI
    window.addEventListener("pf-editor-tab-activated", (e) => {
      if (e?.detail?.tab === "vfx") {
        this._resizeVFXCanvas(vfx);
        this._rebuildVFXPropertySelect(vfx.timeline.currentCategory, vfx);
        this._updateVFXTimeline(vfx);
      }
    });

    return vfx;
  }

  _initVFXCanvas(vfx) {
    vfx.timelineCanvas = document.getElementById("vfx-timeline-canvas");
    if (vfx.timelineCanvas) {
      vfx.timelineCtx = vfx.timelineCanvas.getContext("2d");
      this._resizeVFXCanvas(vfx);
      
      // Add event listeners for VFX timeline
      vfx.timelineCanvas.addEventListener("click", (e) => this._vfxTimelineClick(e, vfx));
      vfx.timelineCanvas.addEventListener("mousemove", (e) => this._vfxTimelineMouseMove(e, vfx));
      
      window.addEventListener("resize", () => this._resizeVFXCanvas(vfx));
    }
  }

  _resizeVFXCanvas(vfx) {
    if (!vfx.timelineCanvas) return;
    
    const rect = vfx.timelineCanvas.getBoundingClientRect();
    // If hidden, rect can be 0; skip until visible
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;

    vfx.timelineCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
    vfx.timelineCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
    vfx.timelineCanvas.style.width = rect.width + "px";
    vfx.timelineCanvas.style.height = rect.height + "px";
    // Draw using CSS pixel coordinates
    vfx.timelineCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _wireVFXControls(vfx) {
    if (vfx._wiredVFX) return;
    vfx._wiredVFX = true;

    // Wire category tabs
    const categoryTabs = document.querySelectorAll(".vfx-category-tab");
    categoryTabs.forEach(tab => {
      tab.addEventListener("click", () => {
        // Remove active class from all tabs and categories
        document.querySelectorAll(".vfx-category-tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".vfx-category").forEach(c => c.classList.remove("active"));
        
        // Add active class to clicked tab and corresponding category
        tab.classList.add("active");
        const panelSel = `.vfx-category[data-vfx-category="${tab.dataset.vfxCategory}"]`;
        const categoryPanel = document.querySelector(panelSel);
        if (categoryPanel) categoryPanel.classList.add("active");

        // Track current category
        vfx.timeline.currentCategory = tab.dataset.vfxCategory || "background";
        // Rebuild property dropdown for this category
        this._rebuildVFXPropertySelect(vfx.timeline.currentCategory, vfx);
        // Ensure canvas sized and redraw
        this._resizeVFXCanvas(vfx);
        this._updateVFXTimeline(vfx);
      });
    });

    // Initial property list for default category
    this._rebuildVFXPropertySelect(vfx.timeline.currentCategory, vfx);

    // Ensure a VFX category panel is active on first mount
    const anyActive = document.querySelector('.vfx-category.active');
    if (!anyActive) {
      const defaultTab = document.querySelector('.vfx-category-tab[data-vfx-category="background"]');
      const defaultPanel = document.querySelector('.vfx-category[data-vfx-category="background"]');
      defaultTab?.classList.add('active');
      defaultPanel?.classList.add('active');
    }

    // Wire property controls with live updates
    this._wireVFXProperty("vfx-bg-color1", "background.color1", vfx);
    this._wireVFXProperty("vfx-bg-color2", "background.color2", vfx);
    this._wireVFXProperty("vfx-bg-gradient", "background.gradient", vfx);
    this._wireVFXProperty("vfx-bg-angle", "background.angle", vfx, "vfx-bg-angle-value", "°");
    
    this._wireVFXProperty("vfx-bg-flash-enable", "background.flashEnable", vfx);
    this._wireVFXProperty("vfx-bg-flash-color", "background.flashColor", vfx);
    this._wireVFXProperty("vfx-bg-flash-intensity", "background.flashIntensity", vfx, "vfx-bg-flash-intensity-value", "%");
    this._wireVFXProperty("vfx-bg-flash-duration", "background.flashDuration", vfx, "vfx-bg-flash-duration-value", "ms");

    this._wireVFXProperty("vfx-camera-x", "camera.x", vfx);
    this._wireVFXProperty("vfx-camera-y", "camera.y", vfx);
    this._wireVFXProperty("vfx-camera-z", "camera.z", vfx);
    this._wireVFXProperty("vfx-camera-zoom", "camera.zoom", vfx, "vfx-camera-zoom-value", "x");
    this._wireVFXProperty("vfx-camera-angle", "camera.angle", vfx, "vfx-camera-angle-value", "°");
    this._wireVFXProperty("vfx-camera-perspective", "camera.perspective", vfx, "vfx-camera-perspective-value", "%");
    
    this._wireVFXProperty("vfx-view-mode", "view.mode", vfx);

    // Wire individual note colors
    for (let i = 1; i <= 4; i++) {
      this._wireVFXNoteColor(`vfx-note-color-${i}`, i - 1, vfx);
    }

    this._wireVFXProperty("vfx-note-glow", "notes.glow", vfx, "vfx-note-glow-value", "%");
    this._wireVFXProperty("vfx-note-size", "notes.size", vfx, "vfx-note-size-value", "x");
    this._wireVFXProperty("vfx-note-trails", "notes.trails", vfx);

    this._wireVFXProperty("vfx-lane-opacity", "lanes.opacity", vfx, "vfx-lane-opacity-value", "%");
    this._wireVFXProperty("vfx-lane-pulsing", "lanes.pulsing", vfx);
    this._wireVFXProperty("vfx-lane-glow", "lanes.glow", vfx, "vfx-lane-glow-value", "%");

    // Wire timeline controls
    this._wireVFXTimelineControls(vfx);

    // Wire file management
    this._wireVFXFileControls(vfx);
  }

  _wireVFXProperty(elementId, propertyPath, vfx, valueDisplayId = null, unit = "") {
    const element = document.getElementById(elementId);
    if (!element) return;

    const updateValue = () => {
      const keys = propertyPath.split(".");
      let value = element.type === "checkbox" ? element.checked : element.value;
      
      // Convert to appropriate type
      if (element.type === "number" || element.type === "range") {
        value = parseFloat(value);
      }

      // Set the value in vfx data
      let target = vfx.data;
      for (let i = 0; i < keys.length - 1; i++) {
        target = target[keys[i]];
      }
      target[keys[keys.length - 1]] = value;

      // Update value display if provided
      if (valueDisplayId) {
        const display = document.getElementById(valueDisplayId);
        if (display) {
          display.textContent = value + unit;
        }
      }
    };

    element.addEventListener("input", updateValue);
    element.addEventListener("change", updateValue);
    
    // Initialize value display
    if (valueDisplayId) {
      const display = document.getElementById(valueDisplayId);
      if (display) {
        const keys = propertyPath.split(".");
        let value = vfx.data;
        for (const key of keys) {
          value = value[key];
        }
        display.textContent = value + unit;
      }
    }
  }

  _wireVFXNoteColor(elementId, laneIndex, vfx) {
    const element = document.getElementById(elementId);
    if (!element) return;

    element.addEventListener("input", () => {
      vfx.data.notes.colors[laneIndex] = element.value;
    });

    element.addEventListener("change", () => {
      vfx.data.notes.colors[laneIndex] = element.value;
    });
  }

  _wireVFXTimelineControls(vfx) {
    const currentPropertySelect = document.getElementById("vfx-current-property");
    const easingTypeSelect = document.getElementById("vfx-easing-type");
    const timelineZoomRange = document.getElementById("vfx-timeline-zoom");
    const timelineZoomValue = document.getElementById("vfx-timeline-zoom-value");

    if (currentPropertySelect) {
      currentPropertySelect.addEventListener("change", () => {
        vfx.timeline.currentProperty = currentPropertySelect.value;
        this._updateVFXTimeline(vfx);
      });
    }

    if (easingTypeSelect) {
      easingTypeSelect.addEventListener("change", () => {
        vfx.timeline.currentEasing = easingTypeSelect.value;
        this._updateVFXTimeline(vfx);
      });
    }

    if (timelineZoomRange) {
      timelineZoomRange.addEventListener("input", () => {
        vfx.timeline.zoom = parseFloat(timelineZoomRange.value);
        if (timelineZoomValue) {
          timelineZoomValue.textContent = vfx.timeline.zoom.toFixed(1) + "x";
        }
        // Keep the playhead centered when zooming
        this._centerVFXTimelineOnPlayhead(vfx);
        this._updateVFXTimeline(vfx);
      });
      // initialize label
      if (timelineZoomValue) {
        timelineZoomValue.textContent = parseFloat(timelineZoomRange.value).toFixed(1) + "x";
      }
    }

    // Keyframe action buttons
    const addKeyframeBtn = document.getElementById("vfx-add-keyframe");
    const deleteKeyframeBtn = document.getElementById("vfx-delete-keyframe");
    const duplicateKeyframeBtn = document.getElementById("vfx-duplicate-keyframe");
    const clearKeyframesBtn = document.getElementById("vfx-clear-keyframes");

    if (addKeyframeBtn) {
      addKeyframeBtn.addEventListener("click", () => this._addVFXKeyframe(vfx));
    }

    if (deleteKeyframeBtn) {
      deleteKeyframeBtn.addEventListener("click", () => this._deleteVFXKeyframe(vfx));
    }

    if (duplicateKeyframeBtn) {
      duplicateKeyframeBtn.addEventListener("click", () => this._duplicateVFXKeyframe(vfx));
    }

    if (clearKeyframesBtn) {
      clearKeyframesBtn.addEventListener("click", () => this._clearVFXKeyframes(vfx));
    }

    // Preview buttons
    const previewBtn = document.getElementById("vfx-play-preview");
    const testInGameBtn = document.getElementById("vfx-test-in-game");

    if (previewBtn) {
      previewBtn.addEventListener("click", () => this._previewVFX(vfx));
    }

    if (testInGameBtn) {
      testInGameBtn.addEventListener("click", () => this._testVFXInGame(vfx));
    }
  }

  _wireVFXFileControls(vfx) {
    const exportBtn = document.getElementById("vfx-export");
    const importBtn = document.getElementById("vfx-import");
    const resetBtn = document.getElementById("vfx-reset");
    const importFile = document.getElementById("vfx-import-file");

    if (exportBtn) {
      exportBtn.addEventListener("click", () => this._exportVFX(vfx));
    }

    if (importBtn) {
      importBtn.addEventListener("click", () => {
        if (importFile) importFile.click();
      });
    }

    if (importFile) {
      importFile.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file) this._importVFX(file, vfx);
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener("click", () => this._resetVFX(vfx));
    }
  }

  // VFX Keyframe Management
  _addVFXKeyframe(vfx) {
    const property = vfx.timeline.currentProperty;
    // Prefer scrubber position for explicit timeline control
    let time = this.playStartMs;
    const scrub = document.getElementById(this.ids.scrub);
    if (scrub) {
      const v = Number(scrub.value);
      if (Number.isFinite(v)) time = v;
    }
    const easing = vfx.timeline.currentEasing;
    
    // Get current value from the UI
    const value = this._getCurrentVFXPropertyValue(property, vfx);
    
    if (!vfx.keyframes[property]) {
      vfx.keyframes[property] = [];
    }

    // Check if keyframe already exists at this time
    const existingIndex = vfx.keyframes[property].findIndex(kf => Math.abs(kf.time - time) < 10);
    
    if (existingIndex >= 0) {
      // Update existing keyframe
      vfx.keyframes[property][existingIndex] = { time, value, easing };
    } else {
      // Add new keyframe and sort by time
      vfx.keyframes[property].push({ time, value, easing });
      vfx.keyframes[property].sort((a, b) => a.time - b.time);
    }

    // Select the just-added/updated keyframe and ensure timeline shows this property
    const currentSelect = document.getElementById("vfx-current-property");
    if (currentSelect && currentSelect.value !== property) {
      currentSelect.value = property;
    }
    vfx.timeline.currentProperty = property;
    // Select the nearest keyframe at that time
    const idx = vfx.keyframes[property].findIndex(kf => Math.abs(kf.time - time) < 10);
    if (idx >= 0) vfx.timeline.selectedKeyframe = { property, index: idx };
    // Keep playhead view centered where we added
    this._centerVFXTimelineOnPlayhead(vfx);
    this._updateVFXTimeline(vfx);
  }

  _deleteVFXKeyframe(vfx) {
    if (!vfx.timeline.selectedKeyframe) return;
    
    const { property, index } = vfx.timeline.selectedKeyframe;
    if (vfx.keyframes[property] && vfx.keyframes[property][index]) {
      vfx.keyframes[property].splice(index, 1);
      vfx.timeline.selectedKeyframe = null;
      this._updateVFXTimeline(vfx);
    }
  }

  _duplicateVFXKeyframe(vfx) {
    if (!vfx.timeline.selectedKeyframe) return;
    
    const { property, index } = vfx.timeline.selectedKeyframe;
    const keyframe = vfx.keyframes[property]?.[index];
    if (!keyframe) return;

    const newKeyframe = { ...keyframe, time: keyframe.time + 1000 }; // Add 1 second offset
    vfx.keyframes[property].push(newKeyframe);
    vfx.keyframes[property].sort((a, b) => a.time - b.time);
    
    this._updateVFXTimeline(vfx);
  }

  _clearVFXKeyframes(vfx) {
    const property = vfx.timeline.currentProperty;
    if (vfx.keyframes[property]) {
      vfx.keyframes[property] = [];
      vfx.timeline.selectedKeyframe = null;
      this._updateVFXTimeline(vfx);
    }
  }

  _getCurrentVFXPropertyValue(property, vfx) {
    const keys = property.split(".");
    let value = vfx.data;
    
    for (const key of keys) {
      if (key.match(/^\d+$/)) {
        // Handle array indices like "notes.colors.0"
        value = value[parseInt(key)];
      } else {
        value = value[key];
      }
    }
    
    return value;
  }

  // VFX Timeline Drawing
  _updateVFXTimeline(vfx) {
    if (!vfx.timelineCtx) return;

    const canvas = vfx.timelineCanvas;
    const ctx = vfx.timelineCtx;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return; // hidden
    
    // Clear canvas
    ctx.fillStyle = "#111725";
    ctx.fillRect(0, 0, rect.width, rect.height);

  // Draw timeline background (only visible window)
  this._drawVFXTimelineBackground(ctx, rect, vfx);
    
  // Draw keyframes for current property
  this._drawVFXKeyframes(ctx, rect, vfx);
    
    // Draw playhead and current value at playhead
    this._drawVFXPlayhead(ctx, rect, vfx);
  }

  // Build property select options per category
  _rebuildVFXPropertySelect(category, vfx) {
    const select = document.getElementById("vfx-current-property");
    if (!select) return;
    const opts = this._getVFXPropertiesByCategory(category);
    // Rebuild options
    select.innerHTML = "";
    for (const { value, label } of opts) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    }
    // Keep current if it exists in this category; otherwise pick first
    const hasCurrent = opts.some(o => o.value === vfx.timeline.currentProperty);
    if (!hasCurrent) {
      vfx.timeline.currentProperty = opts[0]?.value || "";
    }
    select.value = vfx.timeline.currentProperty;
  }

  _getVFXPropertiesByCategory(category) {
    switch (category) {
      case "background":
        return [
          { value: "background.color1", label: "Background Color 1" },
          { value: "background.color2", label: "Background Color 2" },
          { value: "background.gradient", label: "Background Gradient" },
          { value: "background.angle", label: "Background Angle" },
          { value: "background.flashEnable", label: "Beat Flash Enable" },
          { value: "background.flashColor", label: "Beat Flash Color" },
          { value: "background.flashIntensity", label: "Beat Flash Intensity" },
          { value: "background.flashDuration", label: "Beat Flash Duration" },
        ];
      case "camera":
        return [
          { value: "camera.x", label: "Camera X" },
          { value: "camera.y", label: "Camera Y" },
          { value: "camera.z", label: "Camera Z" },
          { value: "camera.zoom", label: "Camera Zoom" },
          { value: "camera.angle", label: "Camera Angle" },
          { value: "camera.perspective", label: "Camera Perspective" },
          { value: "view.mode", label: "View Mode (2D/3D)" },
        ];
      case "notes":
        return [
          { value: "notes.color.1", label: "Note Color Lane 1" },
          { value: "notes.color.2", label: "Note Color Lane 2" },
          { value: "notes.color.3", label: "Note Color Lane 3" },
          { value: "notes.color.4", label: "Note Color Lane 4" },
          { value: "notes.glow", label: "Note Glow" },
          { value: "notes.size", label: "Note Size" },
          { value: "notes.trails", label: "Note Trails" },
        ];
      case "lanes":
        return [
          { value: "lanes.opacity", label: "Lane Opacity" },
          { value: "lanes.pulsing", label: "Lane Pulsing" },
          { value: "lanes.glow", label: "Lane Glow" },
        ];
      default:
        return [];
    }
  }

  _drawVFXTimelineBackground(ctx, rect, vfx) {
    const duration = this.chart?.durationMs || 180000; // 3 minutes default
    const timelineWidth = rect.width - 40; // Leave margin for labels
    const pixelsPerMs = (timelineWidth / duration) * vfx.timeline.zoom;
    const viewportMs = duration / Math.max(0.0001, vfx.timeline.zoom);
    // Clamp offset to valid range
    const maxOffset = Math.max(0, duration - viewportMs);
    if (!Number.isFinite(vfx.timeline.offsetMs)) vfx.timeline.offsetMs = 0;
    vfx.timeline.offsetMs = Math.max(0, Math.min(maxOffset, vfx.timeline.offsetMs));

    const leftTime = vfx.timeline.offsetMs;
    const rightTime = Math.min(duration, leftTime + viewportMs);

    // Draw time grid
    ctx.strokeStyle = "#2a3142";
    ctx.lineWidth = 1;

    // Draw vertical grid lines every 10 seconds in visible window
    const step = 10000; // 10s
    const startGrid = Math.floor(leftTime / step) * step;
    for (let time = startGrid; time <= rightTime + step; time += step) {
      const x = 20 + ((time - leftTime) * pixelsPerMs);
      if (x < 20) continue;
      if (x > rect.width - 20) break;

      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, rect.height);
      ctx.stroke();

      // Draw time labels
      ctx.fillStyle = "#9bb0c9";
      ctx.font = "11px Inter";
      ctx.textAlign = "center";
      ctx.fillText(this._fmtTimeMsShort(time), x, rect.height - 5);
    }

    // Draw horizontal center line
    ctx.strokeStyle = "#2a3142";
    ctx.beginPath();
    ctx.moveTo(20, rect.height / 2);
    ctx.lineTo(rect.width - 20, rect.height / 2);
    ctx.stroke();
  }

  _drawVFXKeyframes(ctx, rect, vfx) {
    const property = vfx.timeline.currentProperty;
    const keyframes = vfx.keyframes[property] || [];
    const duration = this.chart?.durationMs || 180000;
    const timelineWidth = rect.width - 40;
    const pixelsPerMs = (timelineWidth / duration) * vfx.timeline.zoom;
    const leftTime = vfx.timeline.offsetMs || 0;

    keyframes.forEach((keyframe, index) => {
      const x = 20 + ((keyframe.time - leftTime) * pixelsPerMs);
      const y = rect.height / 2;

      // Skip if outside visible area
      if (x < 20 || x > rect.width - 20) return;

      // Draw keyframe dot
      const isSelected = vfx.timeline.selectedKeyframe?.property === property && 
                        vfx.timeline.selectedKeyframe?.index === index;
      const isHover = vfx.timeline.hoverKeyframe?.property === property &&
                      vfx.timeline.hoverKeyframe?.index === index;
      
      ctx.fillStyle = isSelected ? "#C8FF4D" : (isHover ? "#FF2E88" : "#25F4EE");
      ctx.strokeStyle = isSelected ? "#8A5CFF" : "#0d111a";
      ctx.lineWidth = 2;

      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Draw easing indicator
      if (index < keyframes.length - 1) {
        const nextKeyframe = keyframes[index + 1];
        const nextX = 20 + ((nextKeyframe.time - leftTime) * pixelsPerMs);
        
        this._drawEasingCurve(ctx, x, y, nextX, y, keyframe.easing);
      }

      // Tooltip for value/time when hovered or selected
      if (isHover || isSelected) {
        const valStr = this._formatVFXValue(property, keyframe.value);
        const timeStr = this._fmtTimeMsShort(keyframe.time);
        const label = `${timeStr} • ${valStr}`;
        this._drawTooltip(ctx, x, y - 12, label);
      }
    });
  }

  _drawEasingCurve(ctx, x1, y1, x2, y2, easing) {
    ctx.strokeStyle = "rgba(37,244,238,0.5)";
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(x1, y1);

    switch (easing) {
      case "instant":
        ctx.lineTo(x1, y2);
        ctx.lineTo(x2, y2);
        break;
      case "linear":
        ctx.lineTo(x2, y2);
        break;
      case "easeIn":
        ctx.bezierCurveTo(x1 + (x2 - x1) * 0.42, y1, x1 + (x2 - x1) * 1, y2, x2, y2);
        break;
      case "easeOut":
        ctx.bezierCurveTo(x1, y1, x1 + (x2 - x1) * 0.58, y2, x2, y2);
        break;
      case "easeInOut":
        ctx.bezierCurveTo(x1 + (x2 - x1) * 0.42, y1, x1 + (x2 - x1) * 0.58, y2, x2, y2);
        break;
      default:
        ctx.lineTo(x2, y2);
        break;
    }

    ctx.stroke();
  }

  _drawVFXPlayhead(ctx, rect, vfx) {
    const duration = this.chart?.durationMs || 180000;
    const timelineWidth = rect.width - 40;
    const pixelsPerMs = (timelineWidth / duration) * vfx.timeline.zoom;
    const leftTime = vfx.timeline.offsetMs || 0;
    const x = 20 + ((this.playStartMs - leftTime) * pixelsPerMs);

    if (x >= 20 && x <= rect.width - 20) {
      ctx.strokeStyle = "#FF2E88";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, rect.height);
      ctx.stroke();
    }
      // Show current value at playhead for the selected property
      const prop = vfx.timeline.currentProperty;
      const val = this._getVFXPropertyAtTime(prop, this.playStartMs, vfx);
      const label = `${this._fmtTimeMsShort(this.playStartMs)} • ${this._formatVFXValue(prop, val)}`;
      this._drawTooltip(ctx, Math.min(rect.width - 20, x + 8), 16, label, true);
  }

  // VFX Timeline Interaction
  _vfxTimelineClick(e, vfx) {
    const rect = vfx.timelineCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Check if clicking on a keyframe
    const property = vfx.timeline.currentProperty;
    const keyframes = vfx.keyframes[property] || [];
  const duration = this.chart?.durationMs || 180000;
  const timelineWidth = rect.width - 40;
  const pixelsPerMs = (timelineWidth / duration) * vfx.timeline.zoom;
  const leftTime = vfx.timeline.offsetMs || 0;

    let clickedKeyframe = null;
    
    keyframes.forEach((keyframe, index) => {
  const kfX = 20 + ((keyframe.time - leftTime) * pixelsPerMs);
      const kfY = rect.height / 2;
      
      if (Math.abs(x - kfX) < 8 && Math.abs(y - kfY) < 8) {
        clickedKeyframe = { property, index };
      }
    });

    if (clickedKeyframe) {
      vfx.timeline.selectedKeyframe = clickedKeyframe;
    } else {
      // Click on timeline to set playhead
      const timeMs = Math.max(0, Math.min(duration, leftTime + (x - 20) / pixelsPerMs));
      this.playStartMs = timeMs;
      this._syncInputs();
      vfx.timeline.selectedKeyframe = null;
      // Center the view on the new playhead
      this._centerVFXTimelineOnPlayhead(vfx);
    }

    this._updateVFXTimeline(vfx);
  }

  _vfxTimelineMouseMove(e, vfx) {
    const rect = vfx.timelineCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const property = vfx.timeline.currentProperty;
    const keyframes = vfx.keyframes[property] || [];
    const duration = this.chart?.durationMs || 180000;
    const timelineWidth = rect.width - 40;
    const pixelsPerMs = (timelineWidth / duration) * vfx.timeline.zoom;
    const leftTime = vfx.timeline.offsetMs || 0;

    let hover = null;
    keyframes.forEach((kf, index) => {
      const kx = 20 + ((kf.time - leftTime) * pixelsPerMs);
      const ky = rect.height / 2;
      if (Math.abs(x - kx) < 8 && Math.abs(y - ky) < 8) hover = { property, index };
    });

    const changed = JSON.stringify(hover) !== JSON.stringify(vfx.timeline.hoverKeyframe);
    vfx.timeline.hoverKeyframe = hover;
    if (changed) this._updateVFXTimeline(vfx);
  }

  // Center the visible window on the playhead time
  _centerVFXTimelineOnPlayhead(vfx) {
    const duration = this.chart?.durationMs || 180000;
    const canvas = vfx.timelineCanvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const timelineWidth = rect.width - 40;
    const pixelsPerMs = (timelineWidth / duration) * Math.max(0.0001, vfx.timeline.zoom);
    const viewportMs = duration / Math.max(0.0001, vfx.timeline.zoom);
    let offset = this.playStartMs - viewportMs / 2;
    const maxOffset = Math.max(0, duration - viewportMs);
    vfx.timeline.offsetMs = Math.max(0, Math.min(maxOffset, offset));
  }

  _drawTooltip(ctx, x, y, text, alignLeft = false) {
    ctx.save();
    ctx.font = "11px Inter, system-ui";
    const pad = 6;
    const metrics = ctx.measureText(text);
    const w = Math.ceil(metrics.width) + pad * 2;
    const h = 18;
    const bx = alignLeft ? x : (x - w / 2);
    const by = Math.max(4, y - h - 4);
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(bx, by, w, h, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#e7f0ff";
    ctx.textAlign = alignLeft ? "left" : "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, alignLeft ? bx + pad : (bx + w / 2), by + h / 2);
    ctx.restore();
  }

  _fmtTimeMsShort(ms) {
    ms = Math.max(0, Math.floor(ms));
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${String(rem).padStart(2, '0')}`;
  }

  _formatVFXValue(property, value) {
    if (value == null) return "—";
    // Colors
    if (typeof value === "string" && value.startsWith("#")) return value.toUpperCase();
    // Booleans
    if (typeof value === "boolean") return value ? "On" : "Off";
    // Strings
    if (typeof value === "string") return value;

    // Numbers with units based on property
    const unit = (() => {
      if (property.endsWith("angle")) return "°";
      if (property.endsWith("zoom") || property.endsWith("size")) return "x";
      if (property.endsWith("perspective") || property.endsWith("glow") || property.endsWith("opacity") || property.endsWith("Intensity")) return "%";
      return "";
    })();
    const num = Number(value);
    const nstr = Number.isInteger(num) ? String(num) : num.toFixed(2);
    return nstr + unit;
  }

    // VFX Easing Functions
    _easingFunctions = {
      instant: (t) => t >= 1 ? 1 : 0,
      linear: (t) => t,
      easeIn: (t) => t * t * t,
      easeOut: (t) => 1 - Math.pow(1 - t, 3),
      easeInOut: (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
      bezier: (t, p1x = 0.25, p1y = 0.1, p2x = 0.25, p2y = 1.0) => {
        // Simplified cubic bezier implementation for demo
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      }
    };

    _interpolateVFXValue(keyframes, time, easing = "linear") {
      if (!keyframes || keyframes.length === 0) return null;
    
      // Sort keyframes by time
      const sorted = [...keyframes].sort((a, b) => a.time - b.time);
    
      // If before first keyframe, return first value
      if (time <= sorted[0].time) return sorted[0].value;
    
      // If after last keyframe, return last value
      if (time >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1].value;
    
      // Find the two keyframes to interpolate between
      let startKf = sorted[0];
      let endKf = sorted[1];
    
      for (let i = 0; i < sorted.length - 1; i++) {
        if (time >= sorted[i].time && time <= sorted[i + 1].time) {
          startKf = sorted[i];
          endKf = sorted[i + 1];
          break;
        }
      }
    
      // Calculate interpolation factor
      const duration = endKf.time - startKf.time;
      if (duration === 0) return startKf.value;
    
      const t = Math.max(0, Math.min(1, (time - startKf.time) / duration));
    
      // Apply easing function
      const easedT = this._easingFunctions[startKf.easing || easing] || this._easingFunctions.linear;
      const factor = easedT(t);
    
      // Interpolate based on value type
      if (typeof startKf.value === "number") {
        return startKf.value + (endKf.value - startKf.value) * factor;
      } else if (typeof startKf.value === "string" && startKf.value.startsWith("#")) {
        // Color interpolation
        return this._interpolateColor(startKf.value, endKf.value, factor);
      } else if (typeof startKf.value === "boolean") {
        return factor < 0.5 ? startKf.value : endKf.value;
      } else {
        // For other types (like strings), use instant transition at midpoint
        return factor < 0.5 ? startKf.value : endKf.value;
      }
    }

    _interpolateColor(color1, color2, factor) {
      // Convert hex colors to RGB
      const rgb1 = this._hexToRgb(color1);
      const rgb2 = this._hexToRgb(color2);
    
      if (!rgb1 || !rgb2) return color1;
    
      // Interpolate RGB components
      const r = Math.round(rgb1.r + (rgb2.r - rgb1.r) * factor);
      const g = Math.round(rgb1.g + (rgb2.g - rgb1.g) * factor);
      const b = Math.round(rgb1.b + (rgb2.b - rgb1.b) * factor);
    
      // Convert back to hex
      return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    }

    _hexToRgb(hex) {
      const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
      return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
      } : null;
    }

    // Get current VFX property value at specified time
    _getVFXPropertyAtTime(property, time, vfx) {
      const keyframes = vfx.keyframes[property];
      if (!keyframes || keyframes.length === 0) {
        // Return default value from vfx.data
        return this._getCurrentVFXPropertyValue(property, vfx);
      }
    
      return this._interpolateVFXValue(keyframes, time);
    }

  // VFX Actions
  _previewVFX(vfx) {
    // Start timeline playback with VFX effects applied
    this.play();
  }

  _testVFXInGame(vfx) {
    // Export VFX and test in game runtime
    const vfxData = this._generateVFXExport(vfx);
    
    // Trigger test in game - this would integrate with your game system
    if (this.onExport) {
      this.onExport({
        type: "vfx-test",
        data: vfxData,
        chart: this.chart
      });
    }
  }

  _exportVFX(vfx) {
    const vfxData = this._generateVFXExport(vfx);
    
    // Create download
    const blob = new Blob([JSON.stringify(vfxData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement("a");
    a.href = url;
    a.download = `${this.manifest?.title || "chart"}-vfx.json`;
    a.click();
    
    URL.revokeObjectURL(url);
  }

  _importVFX(file, vfx) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const vfxData = JSON.parse(e.target.result);
        this._loadVFXData(vfxData, vfx);
      } catch (error) {
        console.error("Failed to import VFX:", error);
        alert("Failed to import VFX file. Please check the file format.");
      }
    };
    reader.readAsText(file);
  }

  _resetVFX(vfx) {
    if (!confirm("Reset all VFX settings to default? This cannot be undone.")) return;
    
    // Reset to default values
    vfx.data = {
      background: {
        color1: "#0d111a",
        color2: "#1a1f2e", 
        gradient: false,
        angle: 0,
        flashEnable: false,
        flashColor: "#ffffff",
        flashIntensity: 30,
        flashDuration: 200
      },
      camera: {
        x: 0,
        y: 0,
        z: 0,
        zoom: 1.0,
        angle: 0,
        perspective: 50
      },
      view: {
        mode: "2D"
      },
      notes: {
        colors: ["#19cdd0", "#8A5CFF", "#C8FF4D", "#FFA94D"],
        glow: 20,
        size: 1.0,
        trails: false
      },
      lanes: {
        opacity: 100,
        pulsing: false,
        glow: 0
      }
    };
    
    vfx.keyframes = {};
    vfx.timeline.selectedKeyframe = null;
    
    this._syncVFXToUI(vfx);
    this._updateVFXTimeline(vfx);
  }

  _generateVFXExport(vfx) {
    return {
      version: "1.0",
      metadata: {
        title: this.manifest?.title || "Untitled",
        artist: this.manifest?.artist || "Unknown",
        difficulty: this.difficulty,
        duration: this.chart?.durationMs || 0,
        exportedAt: new Date().toISOString()
      },
      vfx: {
        properties: vfx.data,
        keyframes: vfx.keyframes
      }
    };
  }

  _loadVFXData(vfxData, vfx) {
    if (vfxData.vfx) {
      if (vfxData.vfx.properties) {
        Object.assign(vfx.data, vfxData.vfx.properties);
      }
      if (vfxData.vfx.keyframes) {
        vfx.keyframes = vfxData.vfx.keyframes;
      }
    }
    
    this._syncVFXToUI(vfx);
    this._updateVFXTimeline(vfx);
  }

  _syncVFXToUI(vfx) {
    // Update all UI elements to match current VFX data
    
    // Background properties
    const bgColor1 = document.getElementById("vfx-bg-color1");
    const bgColor2 = document.getElementById("vfx-bg-color2");
    const bgGradient = document.getElementById("vfx-bg-gradient");
    const bgAngle = document.getElementById("vfx-bg-angle");
    const bgAngleValue = document.getElementById("vfx-bg-angle-value");
    
    if (bgColor1) bgColor1.value = vfx.data.background.color1;
    if (bgColor2) bgColor2.value = vfx.data.background.color2;
    if (bgGradient) bgGradient.checked = vfx.data.background.gradient;
    if (bgAngle) bgAngle.value = vfx.data.background.angle;
    if (bgAngleValue) bgAngleValue.textContent = vfx.data.background.angle + "°";

    // Background flash properties
    const flashEnable = document.getElementById("vfx-bg-flash-enable");
    const flashColor = document.getElementById("vfx-bg-flash-color");
    const flashIntensity = document.getElementById("vfx-bg-flash-intensity");
    const flashIntensityValue = document.getElementById("vfx-bg-flash-intensity-value");
    const flashDuration = document.getElementById("vfx-bg-flash-duration");
    const flashDurationValue = document.getElementById("vfx-bg-flash-duration-value");
    
    if (flashEnable) flashEnable.checked = vfx.data.background.flashEnable;
    if (flashColor) flashColor.value = vfx.data.background.flashColor;
    if (flashIntensity) flashIntensity.value = vfx.data.background.flashIntensity;
    if (flashIntensityValue) flashIntensityValue.textContent = vfx.data.background.flashIntensity + "%";
    if (flashDuration) flashDuration.value = vfx.data.background.flashDuration;
    if (flashDurationValue) flashDurationValue.textContent = vfx.data.background.flashDuration + "ms";

    // Camera properties
    const cameraX = document.getElementById("vfx-camera-x");
    const cameraY = document.getElementById("vfx-camera-y");
    const cameraZ = document.getElementById("vfx-camera-z");
    const cameraZoom = document.getElementById("vfx-camera-zoom");
    const cameraZoomValue = document.getElementById("vfx-camera-zoom-value");
    const cameraAngle = document.getElementById("vfx-camera-angle");
    const cameraAngleValue = document.getElementById("vfx-camera-angle-value");
    const cameraPerspective = document.getElementById("vfx-camera-perspective");
    const cameraPerspectiveValue = document.getElementById("vfx-camera-perspective-value");
    
    if (cameraX) cameraX.value = vfx.data.camera.x;
    if (cameraY) cameraY.value = vfx.data.camera.y;
    if (cameraZ) cameraZ.value = vfx.data.camera.z;
    if (cameraZoom) cameraZoom.value = vfx.data.camera.zoom;
    if (cameraZoomValue) cameraZoomValue.textContent = vfx.data.camera.zoom.toFixed(1) + "x";
    if (cameraAngle) cameraAngle.value = vfx.data.camera.angle;
    if (cameraAngleValue) cameraAngleValue.textContent = vfx.data.camera.angle + "°";
    if (cameraPerspective) cameraPerspective.value = vfx.data.camera.perspective;
    if (cameraPerspectiveValue) cameraPerspectiveValue.textContent = vfx.data.camera.perspective + "%";

    // View mode
    const viewMode = document.getElementById("vfx-view-mode");
    if (viewMode) viewMode.value = vfx.data.view.mode;

    // Note colors
    for (let i = 0; i < 4; i++) {
      const noteColor = document.getElementById(`vfx-note-color-${i + 1}`);
      if (noteColor && vfx.data.notes.colors[i]) {
        noteColor.value = vfx.data.notes.colors[i];
      }
    }

    // Note effects
    const noteGlow = document.getElementById("vfx-note-glow");
    const noteGlowValue = document.getElementById("vfx-note-glow-value");
    const noteSize = document.getElementById("vfx-note-size");
    const noteSizeValue = document.getElementById("vfx-note-size-value");
    const noteTrails = document.getElementById("vfx-note-trails");
    
    if (noteGlow) noteGlow.value = vfx.data.notes.glow;
    if (noteGlowValue) noteGlowValue.textContent = vfx.data.notes.glow + "%";
    if (noteSize) noteSize.value = vfx.data.notes.size;
    if (noteSizeValue) noteSizeValue.textContent = vfx.data.notes.size.toFixed(1) + "x";
    if (noteTrails) noteTrails.checked = vfx.data.notes.trails;

    // Lane effects
    const laneOpacity = document.getElementById("vfx-lane-opacity");
    const laneOpacityValue = document.getElementById("vfx-lane-opacity-value");
    const lanePulsing = document.getElementById("vfx-lane-pulsing");
    const laneGlow = document.getElementById("vfx-lane-glow");
    const laneGlowValue = document.getElementById("vfx-lane-glow-value");
    
    if (laneOpacity) laneOpacity.value = vfx.data.lanes.opacity;
    if (laneOpacityValue) laneOpacityValue.textContent = vfx.data.lanes.opacity + "%";
    if (lanePulsing) lanePulsing.checked = vfx.data.lanes.pulsing;
    if (laneGlow) laneGlow.value = vfx.data.lanes.glow;
    if (laneGlowValue) laneGlowValue.textContent = vfx.data.lanes.glow + "%";
  }

  // ===== History (Undo/Redo) =====
  _snapshot() {
    return {
      chart: JSON.parse(JSON.stringify(this.chart)),
      playStartMs: this.playStartMs,
      zoomY: this.zoomY,
      scrollY: this.scrollY,
      selection: [...this.selection]
    };
  }
  _restore(s) {
    if (!s) return;
    this.chart = JSON.parse(JSON.stringify(s.chart));
    this.playStartMs = s.playStartMs || 0;
    if (typeof s.zoomY === "number") this.zoomY = s.zoomY;
    if (typeof s.scrollY === "number") this.scrollY = s.scrollY;
    this.selection = new Set(s.selection || []);
    this._syncInputs();
    this._updateScrubMax();
  }
  _pushUndo(label) {
    if (!this.chart) return;
    this._undo.push(this._snapshot());
    if (this._undo.length > this._historyLimit) this._undo.shift();
    this._redo = [];
    if (label) this._help(`${label} (undo available)`);
  }
  undo() {
    if (!this._undo.length) return;
    const cur = this._snapshot();
    const prev = this._undo.pop();
    this._redo.push(cur);
    this._restore(prev);
    this._help("Undid");
  }
  redo() {
    if (!this._redo.length) return;
    const cur = this._snapshot();
    const next = this._redo.pop();
    this._undo.push(cur);
    this._restore(next);
    this._help("Redid");
  }

  // ===== Small helpers =====
  _pxPerMsNow() { return this.pxPerMs * this.zoomY; } // CSS px per ms
  _headHNow() { return Math.max(14, Math.min(120, this.baseHeadH * this.zoomY)); }
  _stemWNow() { return Math.max(6, Math.min(24, 12 * this.zoomY)); }
  _timeToY(ms) { return ms * this._pxPerMsNow() - this.scrollY; }
  _yToTime(y) { return (y + this.scrollY) / this._pxPerMsNow(); }
  // Time under the vertical center of the viewport (in ms)
  _updateZoomIndicator() {
    const label = document.getElementById(this.ids.zoomIndicator);
    if (label) label.textContent = `${Math.round(this.zoomY * 100)}%`;
  }
  _edgeAutoScroll(mouseY) {
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    const pxPerMs = this._pxPerMsNow();
    const maxScroll = Math.max(0, (this.chart?.durationMs || 0) * pxPerMs - h);
    const margin = 32;
    const maxSpeed = 14;
    let dy = 0;
    if (mouseY < margin) dy = -((margin - mouseY) / margin) * maxSpeed;
    else if (mouseY > h - margin) dy = ((mouseY - (h - margin)) / margin) * maxSpeed;
    if (dy !== 0) this.scrollY = Math.max(0, Math.min(maxScroll, this.scrollY + dy));
  }

  // ===== Wire HTML controls =====
  _wireFollowToggle() {
    if (this._wiredFollow) return;
    const el = document.getElementById(this.ids.followToggle);
    if (!el) return;
    el.addEventListener("change", () => {
      this.follow = !!el.checked;
      this._help(`Follow Playhead: ${this.follow ? "On" : "Off"}`);
    });
    this._wiredFollow = true;
  }
  _wireMetronomeControl() {
    if (this._wiredMetro) return;
    const el = document.getElementById(this.ids.metroToggle);
    if (!el) return;
    el.addEventListener("change", () => {
      this.metronome.enabled = !!el.checked;
      if (this.metronome.enabled && this.playing) this._metroStart();
      else this._metroStop();
      this._help(`Metronome: ${this.metronome.enabled ? "On" : "Off"}`);
    });
    this._wiredMetro = true;
  }
  _wireTestButton() {
    if (this._wiredTest) return;
    const btn = document.getElementById(this.ids.testBtn);
    if (!btn) return;
    btn.addEventListener("click", () => this.playtest());
    this._wiredTest = true;
  }
  _wireZoomIndicator() {
    if (this._wiredZoomIndicator) return;
    const zoomEl = document.getElementById(this.ids.zoom);
    if (!zoomEl) return;
    this._updateZoomIndicator();
    this._wiredZoomIndicator = true;
  }
  _wireHistoryButtons() {
    if (this._wiredHistoryButtons) return;
    document.getElementById(this.ids.undoBtn)?.addEventListener("click", () => this.undo());
    document.getElementById(this.ids.redoBtn)?.addEventListener("click", () => this.redo());
    this._wiredHistoryButtons = true;
  }

  // ===== Lifecycle =====
  /** Start a blank chart without loading a manifest. */
  newChart(init = {}) {
    this.manifest = null;
    this.manifestUrl = null;
    this.chartUrl = null;
    this.difficulty = "normal";
    this.chart = {
      bpm: init.bpm ?? 120,
      lanes: init.lanes ?? 4,
      durationMs: init.durationMs ?? 180000,
      notes: Array.isArray(init.notes) ? init.notes.slice() : []
    };
    this.subdiv = 4;
    this.selection.clear();
    this.scrollY = 0;
    this.zoomY = 1.0;
    this.playStartMs = 0;
    this._syncInputs();
    this._updateScrubMax();
    this._wireFollowToggle();
    this._wireMetronomeControl();
    this._wireZoomIndicator();
    this._wireTestButton();
    this._wireHistoryButtons();
    this._help("Blank chart ready. Use Audio or File to load assets.");
    // Reset history
    this._undo = [];
    this._redo = [];
    this._pushUndo(); // baseline
  }

  /** Load a manifest + chart (optional) and wire toolbars. */
  async loadManifest(manifestUrl, difficulty = "normal") {
    if (this.chart) this._pushUndo("Load manifest");
    this.manifestUrl = manifestUrl;
    this.difficulty = difficulty;
    const m = await fetch(manifestUrl).then(r => r.json());
    this.manifest = m;

    const chartUrl = m.charts?.[difficulty];
    if (!chartUrl) {
      this.chartUrl = null;
      this.chart = { bpm: m.bpm || 120, durationMs: m.durationMs || 180000, lanes: 4, notes: [] };
    } else {
      this.chartUrl = chartUrl;
      const loaded = await fetch(chartUrl).then(r => r.json());
      this.chart = {
        bpm: loaded.bpm || m.bpm || 120,
        lanes: loaded.lanes || 4,
        durationMs: loaded.durationMs || m.durationMs || 180000,
        notes: Array.isArray(loaded.notes) ? loaded.notes : []
      };
    }

    this.subdiv = 4;
    this.playStartMs = 0;
    this._syncInputs();

    await this._ensureAudioCtx();
    const audioUrl = this.manifest?.audio?.wav || this.manifest?.audio?.mp3;
    if (audioUrl) {
      await this._loadAudio(audioUrl);
      this.audioUrl = audioUrl;
      const urlBox = document.getElementById(this.ids.audioUrl);
      if (urlBox) urlBox.value = audioUrl;
    }
    this._updateScrubMax();

    // Wire side toolbars (once)
    this._wireAudioPicker();
    this._wireFileToolbar();
    this._wireFollowToggle();
    this._wireMetronomeControl();
    this._wireZoomIndicator();
    this._wireTestButton();
    this._wireHistoryButtons();
  }

  /** Wire toolbar & controls already in HTML. */
  mountToolbar() {
    // Tool baseline styling (if no classes provided)
    document.querySelectorAll('[data-tool]').forEach(btn => {
      if (!btn.classList.contains("primary") && !btn.classList.contains("secondary") && !btn.classList.contains("ghost")) {
        btn.style.background = "#1e2433";
        btn.style.border = "1px solid #2a3142";
        btn.style.color = "#eee";
        btn.style.padding = "4px 10px";
        btn.style.borderRadius = "6px";
        btn.style.fontSize = "0.85em";
        btn.addEventListener("mouseenter", () => btn.style.background = "#2a3142");
        btn.addEventListener("mouseleave", () => {
          btn.style.background = (btn === this._activeToolBtn) ? this.colors.toolActiveBg : "#1e2433";
        });
      }
    });

    // Tool selection + copy immediate action
    const allToolBtns = Array.from(document.querySelectorAll("[data-tool]"));
    const setActiveBtn = (btn) => {
      this._activeToolBtn = btn;
      allToolBtns.forEach(b => {
        const isActive = (b === btn);
        b.style.background = isActive ? this.colors.toolActiveBg : "#1e2433";
        b.style.outline = isActive ? this.colors.toolActiveOutline : "none";
      });
    };

    allToolBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        const t = btn.getAttribute("data-tool");

        if (t === "copy") {
          this._copySelection();
          const n = this.selection.size;
          this._help(n ? `Copied ${n} note(s).` : "Nothing selected to copy.");
          try { navigator.clipboard?.writeText(JSON.stringify([...this.clipboard])); } catch {}
          // Do not switch tool for copy
          return;
        }

        // Normal tool (select/create/stretch/paste/delete)
        this.tool = t;
        setActiveBtn(btn);
        const label = (t === "delete") ? "Delete (click or drag to remove)" : `Tool: ${this.tool}`;
        this._help(label);
      });
    });

    // Default highlight on initial tool
    const defaultBtn = allToolBtns.find(b => b.getAttribute("data-tool") === this.tool);
    if (defaultBtn) setActiveBtn(defaultBtn);

    const bpmEl = document.getElementById(this.ids.bpm);
    const subEl = document.getElementById(this.ids.subdiv);
    const lanesEl = document.getElementById(this.ids.lanes);
    const zoomEl = document.getElementById(this.ids.zoom);
    const scrubEl = document.getElementById(this.ids.scrub);

    bpmEl?.addEventListener("change", () => { this._pushUndo("BPM change"); this.chart.bpm = Number(bpmEl.value) || 120; });
    subEl?.addEventListener("change", () => { this.subdiv = Math.max(1, Number(subEl.value) || 4); });
    lanesEl?.addEventListener("change", () => { this._pushUndo("Lanes change"); this.chart.lanes = Math.max(1, Number(lanesEl.value) || 4); });
    zoomEl?.addEventListener("input", () => {
      this.zoomY = Math.max(0.25, Math.min(3, Number(zoomEl.value)));
      this._updateZoomIndicator();
    });

    // Transport (note: Stop ends the song)
    document.getElementById(this.ids.playBtn)?.addEventListener("click", () => this.play());
    document.getElementById(this.ids.pauseBtn)?.addEventListener("click", () => this.pause());
    document.getElementById(this.ids.stopBtn)?.addEventListener("click", () => this.end()); // reset to zero

    // Undo/Redo buttons
    this._wireHistoryButtons();

    // Import / Export (chart JSON only)
    document.getElementById("ed-import")?.addEventListener("click", async () => {
      const txt = prompt("Paste chart JSON here:");
      if (!txt) return;
      try {
        const obj = JSON.parse(txt);
        if (Array.isArray(obj.notes)) {
          this._pushUndo("Import chart");
          this.chart = { ...this.chart, ...obj };
          this._syncInputs();
          this._updateScrubMax();
          this._help("Imported chart.");
        } else {
          alert("Invalid chart JSON.");
        }
      } catch (e) {
        alert("Parse error: " + e.message);
      }
    });
    document.getElementById("ed-export")?.addEventListener("click", () => this._downloadChart(this._suggestChartFilename()));

    // Scrubber
    scrubEl?.addEventListener("input", () => {
      const ms = Number(scrubEl.value);
      this.seek(ms); // seek updates playStartMs; if playing, it will restart from here
    });

    // Wire the rest
    this._wireAudioPicker();
    this._wireFileToolbar();
    this._wireFollowToggle();
    this._wireMetronomeControl();
    this._wireZoomIndicator();
    this._wireTestButton();

    // (helper text omitted)
  }

  // ===== File toolbar =====
  _wireFileToolbar() {
    if (this._wiredFile) return;
    this._wiredFile = true;

    document.getElementById(this.ids.fileClearNotes)?.addEventListener("click", () => {
      if (!this.chart) this.newChart();
      this._pushUndo("Clear notes");
      this.chart.notes = [];
      this.selection.clear();
      this._help("Cleared all notes.");
    });

    // Open manifest
    const manifestUrlInput = document.getElementById(this.ids.fileLoadManifestUrl);
    const diffSelect = document.getElementById(this.ids.fileDifficulty);
    document.getElementById(this.ids.fileOpenUrl)?.addEventListener("click", async () => {
      const url = (manifestUrlInput?.value || "").trim();
      const diff = diffSelect?.value || "normal";
      if (!url) { alert("Enter a manifest URL first."); return; }
      try {
        await this.loadManifest(url, diff);
        this._help(`Loaded manifest: ${url} [${diff}]`);
      } catch (e) {
        console.error(e);
        alert("Failed to load manifest. Check the path and CORS.");
      }
    });

    // Open chart file directly
    const fileInput = document.getElementById(this.ids.fileOpenFileInput);
    document.getElementById(this.ids.fileOpenUseBtn)?.addEventListener("click", async () => {
      const f = fileInput?.files?.[0];
      if (!f) { alert("Choose a chart JSON file first."); return; }
      try {
        const text = await f.text();
        const obj = JSON.parse(text);
        if (!Array.isArray(obj.notes)) throw new Error("Invalid chart JSON (missing notes array).");
        this._pushUndo("Open chart file");
        this.chart = {
          bpm: obj.bpm || this.chart?.bpm || 120,
          lanes: obj.lanes || this.chart?.lanes || 4,
          durationMs: obj.durationMs || this.chart?.durationMs || 180000,
          notes: obj.notes
        };
        this.selection.clear();
        this.playStartMs = 0;
        this._syncInputs();
        this._updateScrubMax();
        this._help(`Opened local chart file: ${f.name}`);
      } catch (e) {
        console.error(e);
        alert("Failed to open chart file: " + e.message);
      }
    });

    document.getElementById(this.ids.fileSaveAs)?.addEventListener("click", () => {
      this._downloadChart(this._suggestChartFilename());
    });
  }

  _suggestChartFilename() {
    const title = (this.manifest?.title || "chart").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const diff = this.difficulty || "normal";
    return `${title || "chart"}-${diff}.json`;
  }

  _downloadChart(filename = "chart.json") {
    const json = JSON.stringify(this.chart ?? { bpm: 120, lanes: 4, durationMs: 180000, notes: [] }, null, 2);
    this.onExport(json);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  // ===== Audio picker =====
  _wireAudioPicker() {
    if (this._wiredAudio) return;
    this._wiredAudio = true;

    const urlInput = document.getElementById(this.ids.audioUrl);
    const loadUrlBtn = document.getElementById(this.ids.audioLoadUrl);
    const fileInput = document.getElementById(this.ids.audioFileInput);
    const useFileBtn = document.getElementById(this.ids.audioUseFileBtn);
    const applyManifest = document.getElementById(this.ids.audioApplyManifest);

    loadUrlBtn?.addEventListener("click", async () => {
      const url = (urlInput?.value || "").trim();
      if (!url) { alert("Enter an audio URL first."); return; }
      try {
        await this._ensureAudioCtx();
        await this._loadAudio(url);
        this.audioUrl = url;
        this._updateScrubMax();
        this._help("Loaded audio from URL.");
        if (applyManifest?.checked) {
          if (!this.manifest) this.manifest = { charts: {} };
          if (!this.manifest.audio) this.manifest.audio = {};
          if (url.toLowerCase().endsWith(".wav")) this.manifest.audio.wav = url;
          else this.manifest.audio.mp3 = url;
        }
      } catch (e) {
        console.error(e);
        alert("Failed to load audio from URL. Check the path and CORS.");
      }
    });

    useFileBtn?.addEventListener("click", async () => {
      const f = fileInput?.files?.[0];
      if (!f) { alert("Choose a file first."); return; }
      try {
        await this._ensureAudioCtx();
        const blobUrl = URL.createObjectURL(f); // preview
        // Also stash raw bytes for context recreation
        const arrBuf = await f.arrayBuffer();
        this._lastAudioArrayBuffer = arrBuf;

        await this._loadAudio(blobUrl, arrBuf);
        this.audioUrl = blobUrl;
        this._updateScrubMax();
        this._help("Loaded audio from file (preview via blob URL).");
        if (applyManifest?.checked) {
          if (!this.manifest) this.manifest = { charts: {} };
          if (!this.manifest.audio) this.manifest.audio = {};
          this.manifest.audio.mp3 = blobUrl; // preview only
          const hint = document.getElementById(this.ids.audioHint);
          if (hint) {
            hint.textContent = "Using a temporary blob URL for preview. Copy your file into /public/assets/music and update the manifest before publishing.";
          }
        }
      } catch (e) {
        console.error(e);
        alert("Failed to decode audio file.");
      }
    });
  }

  // ===== Playback & Metronome =====
  async _ensureAudioCtx() {
    // Recreate if missing or closed
    if (!this.audioCtx || this.audioCtx.state === "closed") {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

      try { window.__PF_audioCtxs?.add(this.audioCtx); } catch {}

      // (Re)build gain graph
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.value = this._volume;
      this.masterGain.connect(this.audioCtx.destination);

      this.metroGain = this.audioCtx.createGain();
      this.metroGain.gain.value = 0.5;
      this.metroGain.connect(this.masterGain);
    }
  }

  async _fetchArrayBuffer(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
  }

  /**
   * Load audio from URL. If arrayBuffer is provided, reuse it (useful after picking a local file).
   */
  async _loadAudio(url, arrayBuffer = null) {
    if (!this.audioCtx) await this._ensureAudioCtx();

    let arr = arrayBuffer;
    if (!arr) {
      if (url.startsWith("blob:")) {
        arr = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", url);
          xhr.responseType = "arraybuffer";
          xhr.onload = () => resolve(xhr.response);
          xhr.onerror = () => reject(new Error("Blob fetch failed"));
          xhr.send();
        });
      } else {
        arr = await this._fetchArrayBuffer(url);
      }
    }

    this._lastAudioArrayBuffer = arr;

    this.audioBuffer = await this.audioCtx.decodeAudioData(arr.slice(0)); // slice to detach
    const audioMs = Math.floor(this.audioBuffer.duration * 1000);
    if (!this.chart) this.newChart({ durationMs: audioMs });
    if (!this.chart.durationMs || audioMs > this.chart.durationMs) {
      this.chart.durationMs = audioMs;
    }
  }

  _updateScrubMax() {
    const s = document.getElementById(this.ids.scrub);
    const ms = this.chart?.durationMs || Math.floor(this.audioBuffer?.duration * 1000) || 180000;
    if (s) { s.max = String(ms); }
  }

  currentTimeMs() {
    if (!this.playing) return this.playStartMs;
    if (!this.audioCtx || this.audioCtx.state === "closed") return this.playStartMs;
    const delta = (this.audioCtx.currentTime - this.playStartCtxTime) * 1000;
    return Math.max(0, this.playStartMs + delta);
  }

  play() {
    if (!this.audioBuffer) return;

    // If there's a scrubber, treat its current value as "the playhead".
    const s = document.getElementById(this.ids.scrub);
    if (s) {
      const v = Number(s.value);
      if (Number.isFinite(v)) this.playStartMs = Math.max(0, Math.min(v, this.chart.durationMs));
    }

    // If we were already playing, stop the old source first so we don't stack nodes.
    if (this.playing) this._stopSourceOnly();

    const startMs = Math.max(0, Math.min(this.playStartMs, this.chart.durationMs));
    const offset = startMs / 1000;

    this.audioSource = this.audioCtx.createBufferSource();
    this.audioSource.buffer = this.audioBuffer;
    this.audioSource.connect(this.masterGain);
    this.audioSource.start(0, offset);

    this.playStartCtxTime = this.audioCtx.currentTime;
    this.playStartMs = startMs;
    this.playing = true;

    if (this.metronome.enabled) this._metroStart();

    // When it naturally ends, snap to END (scrubber too) and stop.
    try {
      this.audioSource.onended = () => {
        this.playing = false;
        this._metroStop();
        const endMs = this.chart?.durationMs || Math.floor(this.audioBuffer.duration * 1000) || 0;
        this.playStartMs = endMs;
        const sEl = document.getElementById(this.ids.scrub);
        if (sEl) sEl.value = String(endMs);
      };
    } catch {}
  }

  pause() {
    if (!this.playing) return;
    this.playStartMs = this.currentTimeMs();
    this._stopSourceOnly();
    this.playing = false;
    this._metroStop();
  }

  /** End the song: stop and jump playhead to the START (reset to 0). */
  end() {
    this._stopSourceOnly();
    this.playing = false;
    this.playStartMs = 0;       // reset playback position to start
    this._metroStop();

    const s = document.getElementById(this.ids.scrub);
    if (s) s.value = "0";       // reset scrubber UI to 0
  }

  /** Internal: stop only the current buffer source (no resets). */
  _stopSourceOnly() {
    if (this.audioSource) {
      try { this.audioSource.onended = null; } catch {}
      try { this.audioSource.stop(); } catch {}
      try { this.audioSource.disconnect?.(); } catch {}
    }
    this.audioSource = null;
  }

  /** Legacy stop(): keep as "reset to zero" if needed elsewhere. */
  stop() {
    this._stopSourceOnly();
    this.playing = false;
    this.playStartMs = 0;
    this._metroStop();
  }

  seek(ms) {
    this.playStartMs = Math.max(0, Math.min(ms, this.chart.durationMs));
    if (this.playing) { this._stopSourceOnly(); this.play(); } // restart from new offset
  }

  _metroStart() {
    if (!this.audioCtx || this.audioCtx.state === "closed") return;
    const beatMs = 60000 / (this.chart?.bpm || 120);
    const nowMs = this.currentTimeMs();
    this.metronome.nextBeatMs = Math.ceil(nowMs / beatMs) * beatMs;
    if (this.metronome.timer) clearInterval(this.metronome.timer);
    this.metronome.timer = setInterval(this._metroSchedulerTick, 25);
  }
  _metroStop() {
    if (this.metronome.timer) clearInterval(this.metronome.timer);
    this.metronome.timer = null;
  }
  _metroSchedulerTick() {
    if (!this.playing || !this.metronome.enabled || !this.audioCtx || this.audioCtx.state === "closed") return;
    const bpm = this.chart?.bpm || 120;
    const beatMs = 60000 / bpm;
    const lookahead = this.metronome.lookaheadMs;
    const nowMs = this.currentTimeMs();
    const ctxNow = this.audioCtx.currentTime;

    while (this.metronome.nextBeatMs <= nowMs + lookahead) {
      const beatIdx = Math.round(this.metronome.nextBeatMs / beatMs);
      const isBar = (beatIdx % 4) === 0;
      const when = ctxNow + Math.max(0, (this.metronome.nextBeatMs - nowMs) / 1000);
      this._scheduleClick(when, isBar);
      this.metronome.nextBeatMs += beatMs;
    }
  }
  _scheduleClick(when, strong = false) {
    try {
      const osc = this.audioCtx.createOscillator();
      const eg = this.audioCtx.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(strong ? 1100 : 800, when);
      eg.gain.setValueAtTime(0.0001, when);
      eg.gain.exponentialRampToValueAtTime(strong ? 0.5 : 0.35, when + 0.004);
      eg.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
      osc.connect(eg);
      eg.connect(this.metroGain || this.masterGain);
      osc.start(when);
      osc.stop(when + 0.08);
    } catch {}
  }

  // ===== Input / Tools =====
  _screenToLane(x) {
    const totalW = this.chart.lanes * this._laneW() + (this.chart.lanes - 1) * this._laneGap();
    const startX = (this.canvas.width / (window.devicePixelRatio || 1) - totalW) / 2;
    const w = this._laneW(), g = this._laneGap();
    const rel = x - startX;
    if (rel < 0) return 0;
    const lane = Math.floor(rel / (w + g));
    return Math.max(0, Math.min(this.chart.lanes - 1, lane));
  }
  _screenToMsRaw(y) { return this._yToTime(y); }
  _screenToMs(y) { return this._snapMs(this._screenToMsRaw(y)); }
  _snapMs(ms) {
    if (!this.snap) return ms;
    const beatMs = 60000 / (this.chart.bpm || 120);
    const step = beatMs / Math.max(1, this.subdiv);
    return Math.round(ms / step) * step;
  }

  _pointerMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = e.clientX - rect.left;
    this.mouse.y = e.clientY - rect.top;
    this.mouse.lane = this._screenToLane(this.mouse.x);

    if (!this.drag) return;

    if (this.drag.type === "pan") {
      this.scrollY = Math.max(0, this.drag.startScrollY + (this.drag.startY - this.mouse.y));

    } else if (this.drag.type === "createHold") {
      const curMs = this._screenToMs(this.mouse.y);
      let dMs = Math.max(0, curMs - this.drag.baseMs);
      const ignore = new Set([this.chart.notes.length - 1]); // temp note
      const chkTail = this._canPlaceNote(this.drag.lane, this.drag.baseMs, dMs, ignore);
      if (chkTail.cappedEndMs !== undefined) dMs = Math.max(0, chkTail.cappedEndMs - this.drag.baseMs);
      this.drag.tempNote.dMs = dMs;

    } else if (this.drag.type === "move") {
      const dMs = this._screenToMs(this.mouse.y) - this.drag.startMs;
      const dLane = this.mouse.lane - this.drag.startLane;
      const ignore = new Set(this.selection);
      let ok = true;
      const proposals = [];

      for (const idx of this.selection) {
        const orig = this.drag.orig[idx];
        const newLane = Math.max(0, Math.min(this.chart.lanes - 1, orig.lane + dLane));
        const newStart = this._clampMs(orig.tMs + dMs);
        const n = this.chart.notes[idx];
        const newDur = Math.max(0, n.dMs || 0);
        const chk = this._canPlaceNote(newLane, newStart, newDur, ignore);
        if (!chk.ok) { ok = false; break; }
        proposals.push({ idx, lane: newLane, tMs: newStart });
      }
      if (!ok) { this._help("Move blocked by overlap on same lane."); return; }
      for (const p of proposals) {
        const nn = this.chart.notes[p.idx];
        nn.lane = p.lane; nn.tMs = p.tMs;
      }

    } else if (this.drag.type === "stretch") {
      const idx = this.drag.stretchIdx;
      const n = this.chart.notes[idx];
      const curMs = this._screenToMs(this.mouse.y);
      let proposed = Math.max(0, curMs - n.tMs);
      const chk = this._canPlaceNote(n.lane, n.tMs, proposed, new Set([idx]));
      if (chk.cappedEndMs !== undefined) proposed = Math.max(0, chk.cappedEndMs - n.tMs);
      n.dMs = Math.max(0, Math.min(proposed, this.chart.durationMs - n.tMs));

    } else if (this.drag.type === "boxSelect" || this.drag.type === "boxDelete") {
      // Update marquee end
      this.drag.endX = this.mouse.x;
      this.drag.endY = this.mouse.y;

      // Recompute hovered set (no snap; pure geometry)
      const box = this._normalizedBox(this.drag.startX, this.drag.startY, this.drag.endX, this.drag.endY);
      const hitSet = this._notesInBox(box);

      if (this.drag.type === "boxSelect") {
        this._previewSelection = this.drag.additive ? new Set([...this.selection, ...hitSet]) : hitSet;
      } else {
        this._previewSelection = hitSet;
      }
    }

    // Edge auto-scroll when dragging across long ranges
    if (this.drag && ["boxSelect", "boxDelete", "move", "createHold", "stretch"].includes(this.drag.type)) {
      this._edgeAutoScroll(this.mouse.y);
    }
  }

  _pointerDown(e) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const lane = this.mouse.lane;
    const tMsSnap = this._screenToMs(this.mouse.y);   // snapped for placement

    // Alt+Click anywhere in the lanes: set playhead (scrubber + internal) to that time
    if (e.altKey) {
      const tMs = this._screenToMs(this.mouse.y);
      this.seek(tMs); // this updates playStartMs and restarts if playing
      const sEl = document.getElementById(this.ids.scrub);
      if (sEl) sEl.value = String(Math.floor(this.playStartMs));
      return; // don't create/move notes when Alt is held
    }

    // Middle or Ctrl -> pan
    if (e.button === 1 || e.ctrlKey) {
      this.drag = { type: "pan", startY: this.mouse.y, startScrollY: this.scrollY };
      return;
    }

    if (this.tool === "create") {
      this._pushUndo("Create note");
      const chk = this._canPlaceNote(lane, tMsSnap, 0, new Set());
      if (!chk.ok) { this._help("Cannot place note here (overlap on same lane)."); return; }
      const note = { tMs: tMsSnap, lane };
      this.chart.notes.push(note);
      this.selection.clear();
      const idx = this.chart.notes.length - 1;
      this.selection.add(idx);
      this.drag = { type: "createHold", baseMs: tMsSnap, tempNote: note, lane };

    } else if (this.tool === "select" || this.tool === "stretch" || this.tool === "delete") {
      const hit = this._hitTestRect(this.mouse.x, this.mouse.y);
      if (hit.idx >= 0) {
        if (this.tool === "delete") {
          this._pushUndo("Delete note");
          this.chart.notes.splice(hit.idx, 1);
          // Fix selection indices and remove deleted from selection
          this.selection = new Set([...this.selection].filter(i => i !== hit.idx).map(i => i > hit.idx ? i - 1 : i));
          this._help("Deleted 1 note.");
          return;
        }
        // select (click)
        if (!this.selection.has(hit.idx)) {
          if (!e.shiftKey) this.selection.clear();
          this.selection.add(hit.idx);
        }

        if (this.tool === "stretch" || hit.onTail) {
          this._pushUndo("Stretch note");
          const n = this.chart.notes[hit.idx];
          if (!n.dMs) n.dMs = 0;
          this.selection.clear(); this.selection.add(hit.idx);
          this.drag = { type: "stretch", stretchIdx: hit.idx };
        } else if (this.tool === "select") {
          this._pushUndo("Move notes");
          const orig = {};
          for (const i of this.selection) orig[i] = { tMs: this.chart.notes[i].tMs, lane: this.chart.notes[i].lane };
          this.drag = { type: "move", startMs: tMsSnap, startLane: lane, orig };
        } else {
          this.drag = { type: "pan", startY: this.mouse.y, startScrollY: this.scrollY };
        }
      } else {
        // Empty space:
        if (this.tool === "select") {
          this._previewSelection = null;
          this.drag = {
            type: "boxSelect",
            startX: this.mouse.x,
            startY: this.mouse.y,
            endX: this.mouse.x,
            endY: this.mouse.y,
            additive: !!e.shiftKey
          };
        } else if (this.tool === "delete") {
          this._pushUndo("Delete (marquee)");
          this._previewSelection = null;
          this.drag = {
            type: "boxDelete",
            startX: this.mouse.x,
            startY: this.mouse.y,
            endX: this.mouse.x,
            endY: this.mouse.y
          };
        } else {
          this.drag = { type: "pan", startY: this.mouse.y, startScrollY: this.scrollY };
        }
      }

    } else if (this.tool === "copy") {
      // toolbar handles this immediately; do nothing here
      this._help("Copy tool: use the toolbar button to copy selection.");

    } else if (this.tool === "paste") {
      this._pasteAt(tMsSnap, lane);
    }
  }

  _pointerUp() {
    if (this.drag?.type === "createHold") {
      const n = this.drag.tempNote;
      if (n.dMs && n.dMs < 10) delete n.dMs; // tiny drag becomes tap
    } else if (this.drag?.type === "boxSelect") {
      // Commit the marquee selection
      const box = this._normalizedBox(this.drag.startX, this.drag.startY, this.drag.endX, this.drag.endY);
      const hitSet = this._notesInBox(box);
      this.selection = this.drag.additive ? new Set([...this.selection, ...hitSet]) : hitSet;
      this._previewSelection = null;
    } else if (this.drag?.type === "boxDelete") {
      // Delete everything inside the marquee
      const box = this._normalizedBox(this.drag.startX, this.drag.startY, this.drag.endX, this.drag.endY);
      const hitSet = this._notesInBox(box);
      const idxs = [...hitSet].sort((a, b) => b - a);
      for (const i of idxs) this.chart.notes.splice(i, 1);
      this.selection.clear();
      this._previewSelection = null;
      this._help(`Deleted ${idxs.length} note(s).`);
    }
    this.drag = null;
  }

  /**
   * Rectangle hit test for the note head and hold body/tail.
   * Returns { idx, onTail } or { idx:-1, onTail:false }
   */
  _hitTestRect(mouseX, mouseY) {
    if (!this.chart) return { idx: -1, onTail: false };

    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const laneW = this._laneW(), gap = this._laneGap();
    const totalW = this.chart.lanes * laneW + (this.chart.lanes - 1) * gap;
    const startX = (w - totalW) / 2;

    const headH = this._headHNow();
    const headW = Math.max(26, laneW - 18);
    const stemW = this._stemWNow();

    const tMsAtPointer = this._screenToMsRaw(mouseY);
    const lane = this._screenToLane(mouseX);

    const headCandidates = [];
    const tailCandidates = [];

    for (let i = 0; i < (this.chart.notes?.length || 0); i++) {
      const n = this.chart.notes[i];
      if (!n || n.lane !== lane) continue;

      const x0 = startX + lane * (laneW + gap);
      const cx = x0 + laneW / 2;

      // Head rect
      const hy0 = this._timeToY(n.tMs) - headH / 2;
      const hy1 = hy0 + headH;
      const hx0 = cx - headW / 2;
      const hx1 = cx + headW / 2;

      const inHead = (mouseX >= hx0 && mouseX <= hx1 && mouseY >= hy0 && mouseY <= hy1);
      if (inHead) {
        headCandidates.push({ idx: i, score: Math.abs(n.tMs - tMsAtPointer) });
        continue;
      }

      // Tail handle: only if near the end in time AND horizontally near the stem
      if (n.dMs && n.dMs > 0) {
        const tailMs = n.tMs + n.dMs;
        const timeNear = Math.abs(tMsAtPointer - tailMs) <= Math.max(36, Math.min(72, this.tailHandlePadMs)); // slightly tighter
        const xNear = Math.abs(mouseX - cx) <= Math.max(stemW * 1.2, 18);
        if (timeNear && xNear) {
          tailCandidates.push({ idx: i, score: Math.abs(tMsAtPointer - tailMs) });
        }
      }
    }

    if (headCandidates.length) {
      headCandidates.sort((a, b) => a.score - b.score);
      return { idx: headCandidates[0].idx, onTail: false };
    }
    if (tailCandidates.length) {
      tailCandidates.sort((a, b) => a.score - b.score);
      return { idx: tailCandidates[0].idx, onTail: true };
    }

    return { idx: -1, onTail: false };
  }

  _copySelection() {
    const arr = [...this.selection].sort((a, b) => a - b).map(i => ({ ...this.chart.notes[i] }));
    this.clipboard = arr;
  }

  _deleteSelection() {
    if (!this.selection.size) return;
    this._pushUndo("Delete selection");
    const idxs = [...this.selection].sort((a, b) => b - a); // delete high→low
    for (const i of idxs) {
      this.chart.notes.splice(i, 1);
    }
    this.selection.clear();
  }

  _pasteAt(tMs, lane) {
    if (!this.clipboard.length) { this._help("Clipboard empty."); return; }
    this._pushUndo("Paste");
    const minT = Math.min(...this.clipboard.map(n => n.tMs));
    const laneOffset = lane - this.clipboard[0].lane;

    let added = 0;
    for (const src of this.clipboard) {
      const newStart = this._clampMs(tMs + (src.tMs - minT));
      const newLane  = Math.max(0, Math.min(this.chart.lanes - 1, src.lane + laneOffset));
      const newDur   = Math.max(0, src.dMs || 0);

      const chk = this._canPlaceNote(newLane, newStart, newDur, new Set());
      if (!chk.ok) continue;

      const n = { tMs: newStart, lane: newLane };
      if (newDur > 0) n.dMs = newDur;
      this.chart.notes.push(n);
      added++;
    }
    this._help(added ? `Pasted ${added} note(s).` : "Paste blocked by overlaps.");
  }

  _clampMs(ms) { return Math.max(0, Math.min(ms, this.chart.durationMs)); }

  // ===== Box select helpers =====
  _normalizedBox(x0, y0, x1, y1) {
    const left = Math.min(x0, x1), right = Math.max(x0, x1);
    const top = Math.min(y0, y1), bottom = Math.max(y0, y1);
    return { left, right, top, bottom };
  }
  _rectsOverlap(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1) {
    return ax0 <= bx1 && ax1 >= bx0 && ay0 <= by1 && ay1 >= by0;
  }
  /** Return a Set of note indices intersecting the marquee box */
  _notesInBox(box) {
    const result = new Set();
    if (!this.chart) return result;

    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const laneW = this._laneW(), gap = this._laneGap();
    const totalW = this.chart.lanes * laneW + (this.chart.lanes - 1) * gap;
    const startX = (w - totalW) / 2;
    const headH = this._headHNow();
    const headW = Math.max(26, laneW - 18);
    const stemW = this._stemWNow();

    for (let i = 0; i < this.chart.notes.length; i++) {
      const n = this.chart.notes[i];
      const laneX = startX + n.lane * (laneW + gap);
      const x = laneX + (laneW - headW) / 2;
      const yCenter = n.tMs * this._pxPerMsNow() - this.scrollY;
      const yHead   = Math.floor(yCenter - headH / 2);

      // head rect
      const hx0 = x, hx1 = x + headW;
      const hy0 = yHead, hy1 = yHead + headH;
      let hit = this._rectsOverlap(hx0, hy0, hx1, hy1, box.left, box.top, box.right, box.bottom);

      // body (after the head)
      if (!hit && n.dMs && n.dMs > 0) {
        const len = Math.max(6, n.dMs * this._pxPerMsNow());
        const bx0 = x + (headW - stemW) / 2, bx1 = bx0 + stemW;
        const by0 = yHead + headH - 2, by1 = by0 + len;
        hit = this._rectsOverlap(bx0, by0, bx1, by1, box.left, box.top, box.right, box.bottom);
      }

      if (hit) result.add(i);
    }
    return result;
  }

  // ===== Equal-spacing helpers =====
  _strideFromSelection() {
    if (this.selection.size < 2) return null;
    const times = [...this.selection].map(i => this.chart.notes[i]?.tMs).filter(v => typeof v === "number").sort((a,b)=>a-b);
    if (times.length < 2) return null;
    const s = Math.abs(times[1] - times[0]);
    return s > 0 ? s : null;
  }

  _neighborsInLane(lane, tMs, ignoreIdx = -1) {
    let prev = null, next = null;
    for (let i = 0; i < this.chart.notes.length; i++) {
      if (i === ignoreIdx) continue;
      const n = this.chart.notes[i];
      if (n.lane !== lane) continue;
      if (n.tMs < tMs && (!prev || n.tMs > prev.tMs)) prev = n;
      if (n.tMs > tMs && (!next || n.tMs < next.tMs)) next = n;
    }
    return { prev, next };
  }

  // ===== Draw loop =====
  _tick() {
    // Update seconds readout in the editor previewer
    try {
      const label = document.getElementById(this.ids.time);
      if (label) {
        const cur = Math.floor(this.currentTimeMs() / 1000);
        const durTotalMs = this.chart?.durationMs || Math.floor(this.audioBuffer?.duration * 1000) || 0;
        const dur = Math.floor(durTotalMs / 1000);
        label.textContent = `${cur}s / ${dur}s`;
      }
    } catch {}
    
    // Update VFX timeline if visible
    if (this.vfx && this.vfx.timelineCanvas) {
      const vfxTab = document.querySelector('[data-panel="vfx"]');
      if (vfxTab && vfxTab.classList.contains('active')) {
        this._updateVFXTimeline(this.vfx);
      }
    }
    
    this._draw();
    requestAnimationFrame(this._tick);
  }

  _resize() {
    const ratio = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 1200;
    const h = this.canvas.clientHeight || 700;
    this.canvas.width = Math.floor(w * ratio);
    this.canvas.height = Math.floor(h * ratio);
    // Draw using CSS pixel coordinates
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  _laneW() { return Math.max(110, Math.min(160, Math.floor((this.canvas.width / (window.devicePixelRatio || 1)) / 10))); }
  _laneGap() { return Math.max(18, Math.min(28, Math.floor((this.canvas.width / (window.devicePixelRatio || 1)) / 80))); }

  _draw() {
    const ctx = this.ctx;
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);

    // bg
    ctx.fillStyle = this.colors.bg;
    ctx.fillRect(0, 0, w, h);

    if (!this.chart) return;

    // lanes
    const L = this.chart.lanes;
    const laneW = this._laneW(), gap = this._laneGap();
    const totalW = L * laneW + (L - 1) * gap;
    const startX = (w - totalW) / 2;

    for (let i = 0; i < L; i++) {
      const x = startX + i * (laneW + gap);
      ctx.fillStyle = this.colors.laneFill;
      ctx.strokeStyle = this.colors.laneStroke;
      ctx.lineWidth = 2;
      this._roundRect(ctx, x, 16, laneW, h - 32, 16, true);
    }

    // timing/grid
    const bpm = this.chart.bpm || 120;
    const beatMs = 60000 / bpm;
    const stepMs = beatMs / Math.max(1, this.subdiv);
    const pxPerMs = this._pxPerMsNow();

    const startMs = this.scrollY / pxPerMs;
    const endMs   = startMs + h / pxPerMs;
    const firstBeat = Math.floor(startMs / beatMs);
    const lastBeat  = Math.ceil(endMs / beatMs);

    for (let b = firstBeat; b <= lastBeat; b++) {
      const y = Math.floor(b * beatMs * pxPerMs - this.scrollY);
      ctx.strokeStyle = (b % 10 === 0) ? this.colors.gridDecade : this.colors.gridMajor;
      ctx.lineWidth = (b % 10 === 0) ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(startX - 12, y);
      ctx.lineTo(startX + totalW + 12, y);
      ctx.stroke();

      if (b < lastBeat) {
        for (let s = 1; s < this.subdiv; s++) {
          const yy = Math.floor((b * beatMs + s * stepMs) * pxPerMs - this.scrollY);
          ctx.strokeStyle = this.colors.gridMinor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(startX, yy);
          ctx.lineTo(startX + totalW, yy);
          ctx.stroke();
        }
      }
    }

    // --- Stride guides (equal spacing helper) ---
    const strideMs = this._strideFromSelection();
    if (strideMs) {
      const first = Math.floor(startMs / strideMs) * strideMs;
      ctx.save();
      ctx.setLineDash([4,4]);
      ctx.strokeStyle = "rgba(255,209,102,0.25)";
      ctx.lineWidth = 1;

      for (let t = first; t < endMs; t += strideMs) {
        const y = Math.floor(t * pxPerMs - this.scrollY);
        ctx.beginPath();
        ctx.moveTo(startX - 8, y);
        ctx.lineTo(startX + totalW + 8, y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // notes (CENTER-ALIGNED to beat/playhead); scale with zoom
    const headH = this._headHNow();
    const headW = Math.max(26, laneW - 18);
    const stemW = this._stemWNow();

    const now = this.currentTimeMs() + this.editorLatencyMs;

    // Follow: keep playhead centered when playing
    if (this.follow && this.playing) {
      const targetScroll = Math.max(0, now * pxPerMs - h / 2);
      const maxScroll = Math.max(0, this.chart.durationMs * pxPerMs - h);
      this.scrollY = Math.max(0, Math.min(maxScroll, targetScroll));
    }

    const flashWindow = 40; // ms around the center time

    for (let i = 0; i < this.chart.notes.length; i++) {
      const n = this.chart.notes[i];
      const x = startX + n.lane * (laneW + gap) + (laneW - headW) / 2;

      // center of the note = exact musical time
      const yCenter = n.tMs * pxPerMs - this.scrollY;
      const yHead   = Math.floor(yCenter - headH / 2);  // top of head from center

      // Hold body extends *after* the head (downwards)
      if (n.dMs && n.dMs > 0) {
        const len = Math.max(6, n.dMs * pxPerMs);
        ctx.fillStyle = this.colors.holdBody;
        this._roundRect(ctx, x + (headW - stemW) / 2, yHead + headH - 2, stemW, len, Math.min(6 * this.zoomY, stemW/2), true);
      }

      // flash head when its *center* is near playhead
      const flash = Math.abs(n.tMs - now) <= flashWindow;
      ctx.fillStyle   = flash ? "#ffffff" : this.colors.noteHead;
      ctx.strokeStyle = flash ? "#ffffff" : this.colors.noteHeadStroke;
      ctx.lineWidth = 2;
      this._roundRect(ctx, x, yHead, headW, headH, this.headPad, true);

      const selected = this._previewSelection ? this._previewSelection.has(i) : this.selection.has(i);
      if (selected) {
        ctx.strokeStyle = this.colors.selection;
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 2, yHead - 2, headW + 4, headH + 4);
      }
    }

    // playhead (also lines up with note centers)
    const phY = Math.floor(now * pxPerMs - this.scrollY);
    ctx.strokeStyle = this.colors.playhead;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(startX - 16, phY);
    ctx.lineTo(startX + totalW + 16, phY);
    ctx.stroke();

    // --- Gap badges for selected notes (same-lane Δprev/Δnext) ---
    ctx.font = "11px ui-sans-serif, system-ui";
    for (const idx of (this._previewSelection ?? this.selection)) {
      const n = this.chart.notes[idx];
      if (!n) continue;

      const x = startX + n.lane * (laneW + gap) + (laneW - headW) / 2;
      const yCenter = n.tMs * pxPerMs - this.scrollY;
      const yHead   = Math.floor(yCenter - headH / 2);

      const { prev, next } = this._neighborsInLane(n.lane, n.tMs, idx);
      const dPrev = prev ? (n.tMs - prev.tMs) : null;
      const dNext = next ? (next.tMs - n.tMs) : null;

      const tol = 2; // ms tolerance to consider "equal"
      const equal = (dPrev != null && dNext != null && Math.abs(dPrev - dNext) <= tol);

      // labels to the left of the head
      const labelX = x - 54;
      if (dPrev != null) {
        ctx.fillStyle = equal ? "#9AE6B4" : "#ffd166";
        ctx.fillText(`${Math.round(dPrev)}ms`, labelX, yHead - 4);
      }
      if (dNext != null) {
        ctx.fillStyle = equal ? "#9AE6B4" : "#ffd166";
        ctx.fillText(`${Math.round(dNext)}ms`, labelX, yHead + headH + 12);
      }

      // tiny brace if equal
      if (equal) {
        ctx.strokeStyle = "#9AE6B4";
        ctx.lineWidth = 1;
        const braceX = labelX + 40;
        ctx.beginPath();
        ctx.moveTo(braceX, yHead - 8);
        ctx.lineTo(braceX, yHead + headH + 16);
        ctx.stroke();
      }
    }

    // marquee rectangle preview (select or delete)
    if (this.drag && (this.drag.type === "boxSelect" || this.drag.type === "boxDelete")) {
      const box = this._normalizedBox(this.drag.startX, this.drag.startY, this.drag.endX, this.drag.endY);
      ctx.fillStyle = this.colors.boxSelect;
      ctx.strokeStyle = this.colors.boxSelectBorder;
      ctx.lineWidth = 1.5;
      ctx.fillRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
      ctx.strokeRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
    }

    // footer info
    const t = document.getElementById(this.ids.time);
    if (t) t.textContent = `${Math.floor((this.currentTimeMs()) / 1000)}s / ${Math.floor((this.chart.durationMs || 0) / 1000)}s`;

    const s = document.getElementById(this.ids.scrub);
    if (s && !s.matches(":active")) s.value = String(Math.floor(this.currentTimeMs()));
  }

  _roundRect(ctx, x, y, w, h, r, fill = true) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    if (fill) ctx.fill(); else ctx.stroke();
  }

  _onWheel(e) {
    // Keep the page still while interacting with canvas
    e.preventDefault();
    e.stopPropagation();

    // Current mouse Y relative to canvas (fallback to last pointer move)
    const mouseY = (typeof e.offsetY === "number") ? e.offsetY : this.mouse.y;

    if (e.shiftKey) {
      // Zoom anchored at mouse: keep the time under cursor fixed
      const oldZoom = this.zoomY;
      const factor = e.deltaY < 0 ? 1.08 : 0.92;
      const newZoom = Math.max(0.25, Math.min(3, oldZoom * factor));

      const msAtMouse = this._yToTime(mouseY);         // before zoom
      this.zoomY = newZoom;
      this._updateZoomIndicator();
      const newPxPerMs = this._pxPerMsNow();
      this.scrollY = Math.max(0, msAtMouse * newPxPerMs - mouseY);
    } else {
      // Vertical scroll (pixels)
      this.scrollY = Math.max(0, this.scrollY + e.deltaY);
    }
  }

  async _onKeyDown(e) {
    // Only act when the editor screen is visible
    const scr = document.getElementById("screen-editor");
    const active = scr && scr.classList.contains("active");
    if (!active) return;

    // Ignore if typing
    const tag = (e.target?.tagName || "").toUpperCase();
    if (e.target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;

    // Undo/Redo
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      this.undo();
      return;
    }
    if ((mod && e.shiftKey && (e.key === "z" || e.key === "Z")) || (mod && (e.key === "y" || e.key === "Y"))) {
      e.preventDefault();
      this.redo();
      return;
    }

    // Delete keys: delete ALL selected notes
    if (e.key === "Delete" || e.key === "Backspace") {
      if (this.selection.size) {
        this._deleteSelection();
      }
      e.preventDefault();
      return;
    }

    // Space: toggle
    if (e.code === "Space" || e.key === " ") {
      e.preventDefault();
      await this._ensureAudioCtx();
      if (this.audioCtx?.state === "suspended") { try { await this.audioCtx.resume(); } catch {} }
      if (!this.audioBuffer && (this.audioUrl || this._lastAudioArrayBuffer)) {
        try { await this._loadAudio(this.audioUrl || "blob://in-memory", this._lastAudioArrayBuffer); } catch {}
      }
      if (!this.audioBuffer) return;
      if (this.playing) this.pause(); else this.play();
      return;
    }

    // Follow toggle (F)
    if (e.key.toLowerCase() === "f") {
      e.preventDefault();
      const pxPerMs = this._pxPerMsNow();
      const h = this.canvas.height / (window.devicePixelRatio || 1);
      const now = this.currentTimeMs();
      // Center scroll so playhead is in the middle of the screen
      const targetScroll = Math.max(0, now * pxPerMs - h / 2);
      const maxScroll = Math.max(0, (this.chart?.durationMs || 0) * pxPerMs - h);
      this.scrollY = Math.max(0, Math.min(maxScroll, targetScroll));
      this._help("Jumped to playhead");
      return;
    }

    // Home/End: jump to start/end
    if (e.key === "Home") {
      e.preventDefault();
      this.seek(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      this.end();
      return;
    }

    // M: toggle metronome
    if (e.key.toLowerCase() === "m") {
      const box = document.getElementById(this.ids.metroToggle);
      if (box) { box.checked = !box.checked; box.dispatchEvent(new Event("change")); }
      return;
    }

    // Left / Right: nudge by 50 ms (hold Shift for 10x)
    const step = (e.shiftKey ? 500 : 50);
    if (e.code === "ArrowRight") {
      e.preventDefault();
      this.seek(Math.min((this.chart?.durationMs || 0), this.currentTimeMs() + step));
    } else if (e.code === "ArrowLeft") {
      e.preventDefault();
      this.seek(Math.max(0, this.currentTimeMs() - step));
    }
  }

  // ===== Playtest =====
  playtest() {
    if (typeof window.PF_startGame !== "function") {
      alert("Playtest is unavailable (PF_startGame not found).");
      return;
    }
    // Stop editor audio immediately so it doesn't stack with the game
    this._stopSourceOnly();
    this.playing = false;
    this._metroStop();

    const offset = Math.max(0, Math.min(this.currentTimeMs()|0,
      (this.chart?.durationMs || (this.audioBuffer ? Math.floor(this.audioBuffer.duration*1000) : 0))));

    const notes = Array.isArray(this.chart?.notes) ? [...this.chart.notes].sort((a,b)=>a.tMs-b.tMs) : [];
    const out = {
      bpm: this.chart?.bpm || 120,
      lanes: this.chart?.lanes || 4,
      durationMs: this.chart?.durationMs || (this.audioBuffer ? Math.floor(this.audioBuffer.duration * 1000) : 180000),
      notes,
      title: this.manifest?.title || "Editor Preview",
      difficulty: this.difficulty || "normal",
      trackId: (this.manifest?.title ? this.manifest.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "editor-preview"),
      audioUrl: this.audioUrl || this.manifest?.audio?.wav || this.manifest?.audio?.mp3
    };
    if (!out.audioUrl) {
      alert("Load an audio file/URL or a manifest with audio before playtesting.");
      return;
    }
    // Pass startAtMs and allowExit so you can quit the playtest; prevent leaderboard post
    window.PF_startGame({ mode: "solo", manifest: out, startAtMs: offset, allowExit: true, autoSubmit: false, isEditorPreview: true });
  }

  _syncInputs() {
    const bpmEl = document.getElementById(this.ids.bpm);
    const subEl = document.getElementById(this.ids.subdiv);
    const lanesEl = document.getElementById(this.ids.lanes);
    if (bpmEl) bpmEl.value = String(this.chart?.bpm ?? 120);
    if (subEl) subEl.value = String(this.subdiv);
    if (lanesEl) lanesEl.value = String(this.chart?.lanes ?? 4);
  }

  _help(msg) {
    const el = document.getElementById(this.ids.help);
    if (el) el.textContent = msg || "";
  }

  // ===== Overlap / lane helpers =====
  _rangesOverlap(start, end, s, e) {
    const A0 = Math.min(start, end);
    const A1 = Math.max(start, end);
    const B0 = Math.min(s, e);
    const B1 = Math.max(s, e);
    return !(A1 + this.minGapMs <= B0 || B1 + this.minGapMs <= A0);
  }
  /** Check if a note can be placed in a lane (no overlaps). */
  _canPlaceNote(lane, tMs, dMs = 0, ignoreIdxSet = new Set()) {
    if (!this.chart || !Array.isArray(this.chart.notes)) return { ok: true, conflictIdx: -1 };
    const start = tMs;
    const end = tMs + Math.max(0, dMs);

    let next = null;
    for (let i = 0; i < this.chart.notes.length; i++) {
      if (ignoreIdxSet.has(i)) continue;
      const n = this.chart.notes[i];
      if (n.lane !== lane) continue;

      // keep minimal gap between heads
      if (Math.abs(n.tMs - tMs) < this.minGapMs) return { ok: false, conflictIdx: i };

      const ns = n.tMs, ne = n.tMs + Math.max(0, n.dMs || 0);
      if ((n.dMs || 0) > 0 || dMs > 0) {
        if (this._rangesOverlap(start, end, ns, ne)) return { ok: false, conflictIdx: i };
      }

      if (n.tMs > tMs && (!next || n.tMs < next.tMs)) next = { ...n, idx: i };
    }

    // Hard cap tail to not cross into next note's time
    if (dMs > 0 && next) {
      const maxEnd = next.tMs - this.minGapMs;
      if (end > maxEnd) {
        return { ok: true, conflictIdx: -1, cappedEndMs: Math.max(start, maxEnd) };
      }
    }

    return { ok: true, conflictIdx: -1 };
  }

  // ===== Volume helpers =====
  _getSavedVolume() {
    try {
      const s = JSON.parse(localStorage.getItem("pf-settings") || "{}");
      const v = Number(s?.volume);
      if (Number.isFinite(v)) return Math.max(0, Math.min(1, v));
    } catch {}
    return 1; // default 100%
  }
  setVolume(v) {
    const vol = Math.max(0, Math.min(1, Number(v) || 0));
    this._volume = vol;
    if (this.masterGain) this.masterGain.gain.value = vol;
  }
} 