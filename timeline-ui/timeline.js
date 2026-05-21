/**
 * htmlMC Timeline UI
 *
 * Vanilla JS — no framework. Wires to the export pipeline via a fetch call
 * to the Node orchestrator server (export-server.js on port 8793).
 *
 * Core coordinate system (from Motion Canvas UI survey):
 *   framesToPixels(f) = f * pixelsPerFrame
 *   pixelsToFrames(p) = p / pixelsPerFrame
 *   pixelsPerFrame    = zoom (pixels per frame, min 0.5)
 */

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  // Config
  width:        800,
  height:       450,
  fps:          30,
  durationS:    5,
  animationSrc: '/pipeline/animation.html',

  // Derived
  get totalFrames() { return Math.round(this.fps * this.durationS); },

  // Playback
  currentFrame: 0,
  playing:      false,
  playTimer:    null,

  // Timeline view
  zoom:         2,       // pixels per frame
  scrollLeft:   0,

  // In/out range (frames). -1 means "follow totalFrames"
  rangeIn:  0,
  rangeOut: -1,

  // Export
  exporting:    false,
  abortExport:  null,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const el = {
  stageFrame:    $('stage-frame'),
  stageContainer:$('stage-container'),
  timecode:      $('timecode'),
  frameCounter:  $('frame-counter'),
  btnPlay:       $('btn-play'),
  btnPrev:       $('btn-prev'),
  btnNext:       $('btn-next'),
  btnReset:      $('btn-reset'),
  btnEnd:        $('btn-end'),
  timelineScroll:$('timeline-scroll'),
  timelineInner: $('timeline-inner'),
  tickLayer:     $('tick-layer'),
  playhead:      $('playhead'),
  rangeFill:     $('range-fill'),
  handleIn:      $('handle-in'),
  handleOut:     $('handle-out'),
  zoomSlider:    $('zoom-slider'),
  btnZoomIn:     $('btn-zoom-in'),
  btnZoomOut:    $('btn-zoom-out'),
  cfgWidth:      $('cfg-width'),
  cfgHeight:     $('cfg-height'),
  cfgFps:        $('cfg-fps'),
  cfgDuration:   $('cfg-duration'),
  btnUndo:       $('btn-undo'),
  btnRedo:       $('btn-redo'),
  expFormat:     $('exp-format'),
  expRange:      $('exp-range'),
  btnExport:      $('btn-export'),
  btnAbort:       $('btn-abort'),
  progressBar:    $('progress-bar'),
  progressLabel:  $('progress-label'),
  exportOverlay:  $('export-overlay'),
  exportLog:      $('export-log'),
};

// ─── Coordinate helpers ───────────────────────────────────────────────────────

const framesToPixels = f => f * state.zoom;
const pixelsToFrames = p => p / state.zoom;
const getRangeOut    = () => state.rangeOut === -1 ? state.totalFrames : state.rangeOut;

function timelineWidth() {
  return framesToPixels(state.totalFrames) + el.timelineScroll.clientWidth;
}

// ─── Stage ────────────────────────────────────────────────────────────────────

function initStage() {
  el.stageFrame.width  = state.width;
  el.stageFrame.height = state.height;
  el.stageFrame.src    = state.animationSrc;

  el.stageFrame.addEventListener('load', () => {
    seekStage(state.currentFrame);
  });

  // Scale stage to fit available space
  const resizeObserver = new ResizeObserver(fitStage);
  resizeObserver.observe($('stage-wrap'));
}

function fitStage() {
  const wrap = $('stage-wrap');
  const scaleX = (wrap.clientWidth  - 32) / state.width;
  const scaleY = (wrap.clientHeight - 32) / state.height;
  const scale  = Math.min(scaleX, scaleY, 1);
  el.stageContainer.style.transform = `scale(${scale})`;
  el.stageContainer.style.transformOrigin = 'center center';
}

function seekStage(frame) {
  const win = el.stageFrame.contentWindow;
  if (!win) return;
  const t = (frame / state.fps) * 1000;
  try {
    // Drive animations via highly secure and reliable cross-frame postMessage
    win.postMessage({ type: 'seek', timeMs: t }, '*');
  } catch {
    // ignore
  }
}

// ─── Timeline rendering ───────────────────────────────────────────────────────

function renderTimeline() {
  const w = timelineWidth();
  el.timelineInner.style.width = `${w}px`;

  // Ticks
  el.tickLayer.innerHTML = '';
  const framesPerTick = Math.max(1, Math.ceil(30 / state.zoom));
  const step = nearestNice(framesPerTick);

  for (let f = 0; f <= state.totalFrames; f += step) {
    const x = framesToPixels(f);
    const isMajor = f % (step * 5) === 0;

    const tick = document.createElement('div');
    tick.className = `tick ${isMajor ? 'major' : ''}`;
    tick.style.left   = `${x}px`;
    tick.style.height = isMajor ? '100%' : '40%';
    tick.style.bottom = '0';
    tick.style.top    = 'auto';
    el.tickLayer.appendChild(tick);

    if (isMajor) {
      const label = document.createElement('div');
      label.className = 'tick-label';
      label.style.left = `${x}px`;
      label.textContent = formatTime(f);
      el.tickLayer.appendChild(label);
    }
  }

  renderPlayhead();
  renderRange();
}

function renderPlayhead() {
  el.playhead.style.left = `${framesToPixels(state.currentFrame)}px`;
}

function renderRange() {
  const inPx  = framesToPixels(state.rangeIn);
  const outPx = framesToPixels(getRangeOut());

  el.rangeFill.style.left  = `${inPx}px`;
  el.rangeFill.style.width = `${outPx - inPx}px`;

  el.handleIn.style.left  = `${inPx}px`;
  el.handleOut.style.left = `${outPx}px`;
}

// ─── Playback ─────────────────────────────────────────────────────────────────

function play() {
  if (state.playing) return;
  state.playing = true;
  el.btnPlay.querySelector('use').setAttribute('href', '#ico-pause');

  const interval = 1000 / state.fps;
  state.playTimer = setInterval(() => {
    if (state.currentFrame >= state.totalFrames - 1) {
      pause();
      return;
    }
    setFrame(state.currentFrame + 1);
  }, interval);
}

function pause() {
  state.playing = false;
  el.btnPlay.querySelector('use').setAttribute('href', '#ico-play');
  clearInterval(state.playTimer);
}

function togglePlay() {
  state.playing ? pause() : play();
}

function setFrame(f) {
  state.currentFrame = Math.max(0, Math.min(f, state.totalFrames - 1));
  seekStage(state.currentFrame);
  updateHUD();
  renderPlayhead();
  scrollPlayheadIntoView();
}

function scrollPlayheadIntoView() {
  const x    = framesToPixels(state.currentFrame);
  const wrap = el.timelineScroll;
  const pad  = wrap.clientWidth * 0.15;

  if (x < wrap.scrollLeft + pad) {
    wrap.scrollLeft = Math.max(0, x - pad);
  } else if (x > wrap.scrollLeft + wrap.clientWidth - pad) {
    wrap.scrollLeft = x - wrap.clientWidth + pad;
  }
}

// ─── HUD ──────────────────────────────────────────────────────────────────────

function updateHUD() {
  el.timecode.textContent    = formatTimecode(state.currentFrame);
  el.frameCounter.textContent = `${state.currentFrame} / ${state.totalFrames - 1}`;
}

function formatTimecode(frame) {
  const totalS = frame / state.fps;
  const m  = Math.floor(totalS / 60);
  const s  = Math.floor(totalS % 60);
  const f  = frame % state.fps;
  return `${pad(m)}:${pad(s)}:${pad(f)}`;
}

function formatTime(frame) {
  const s = (frame / state.fps).toFixed(1);
  return `${s}s`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function nearestNice(n) {
  const nice = [1,2,3,5,10,15,30,60,90,150,300];
  return nice.find(v => v >= n) ?? nice[nice.length - 1];
}

// ─── Timeline interaction ─────────────────────────────────────────────────────

function pointerToFrame(e) {
  const rect = el.timelineScroll.getBoundingClientRect();
  const x    = e.clientX - rect.left + el.timelineScroll.scrollLeft;
  return Math.round(Math.max(0, Math.min(pixelsToFrames(x), state.totalFrames - 1)));
}

el.timelineScroll.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  pause();

  const frame = pointerToFrame(e);
  setFrame(frame);

  const onMove = e => setFrame(pointerToFrame(e));
  const onUp   = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup',   onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup',   onUp);
});

// Range handles
let draggingHandle = null;

document.querySelectorAll('.range-handle').forEach(h => {
  h.addEventListener('pointerdown', e => {
    e.stopPropagation();
    draggingHandle = h.dataset.handle;
    h.setPointerCapture(e.pointerId);
  });

  h.addEventListener('pointermove', e => {
    if (draggingHandle !== h.dataset.handle) return;
    const frame = pointerToFrame(e);
    if (draggingHandle === 'in') {
      state.rangeIn = Math.min(frame, getRangeOut() - 1);
    } else {
      state.rangeOut = Math.max(frame, state.rangeIn + 1);
    }
    renderRange();
  });

  h.addEventListener('pointerup', () => { draggingHandle = null; });
});

// Zoom
el.zoomSlider.addEventListener('input', () => {
  state.zoom = parseFloat(el.zoomSlider.value);
  renderTimeline();
});

el.btnZoomIn.addEventListener('click', () => {
  state.zoom = Math.min(state.zoom * 1.5, 20);
  el.zoomSlider.value = state.zoom;
  renderTimeline();
});

el.btnZoomOut.addEventListener('click', () => {
  state.zoom = Math.max(state.zoom / 1.5, 0.5);
  el.zoomSlider.value = state.zoom;
  renderTimeline();
});

// Wheel zoom on timeline (preserve pointer position)
el.timelineScroll.addEventListener('wheel', e => {
  if (!e.shiftKey) {
    e.preventDefault();
    const rect   = el.timelineScroll.getBoundingClientRect();
    const mouseX = e.clientX - rect.left + el.timelineScroll.scrollLeft;
    const frameAtMouse = pixelsToFrames(mouseX);
    const factor = e.deltaY < 0 ? 1.15 : 0.87;
    state.zoom   = Math.max(0.5, Math.min(state.zoom * factor, 20));
    el.zoomSlider.value = state.zoom;
    renderTimeline();
    // Re-anchor mouse position
    el.timelineScroll.scrollLeft = framesToPixels(frameAtMouse) - (e.clientX - rect.left);
  }
}, { passive: false });

// ─── Playback controls ────────────────────────────────────────────────────────

el.btnPlay.addEventListener('click',  togglePlay);
el.btnPrev.addEventListener('click',  () => { pause(); setFrame(state.currentFrame - 1); });
el.btnNext.addEventListener('click',  () => { pause(); setFrame(state.currentFrame + 1); });
el.btnReset.addEventListener('click', () => { pause(); setFrame(0); });
el.btnEnd.addEventListener('click',   () => { pause(); setFrame(state.totalFrames - 1); });

// ─── Config inputs ────────────────────────────────────────────────────────────

function applyConfig() {
  state.width     = parseInt(el.cfgWidth.value)    || 800;
  state.height    = parseInt(el.cfgHeight.value)   || 450;
  state.fps       = parseInt(el.cfgFps.value)      || 30;
  state.durationS = parseFloat(el.cfgDuration.value) || 5;
  state.rangeIn  = 0;
  state.rangeOut = -1; // -1 = follow totalFrames
  el.stageFrame.width  = state.width;
  el.stageFrame.height = state.height;
  fitStage();
  setFrame(0);
  renderTimeline();
  updateHUD();
}

[el.cfgWidth, el.cfgHeight, el.cfgFps, el.cfgDuration].forEach(inp => {
  inp.addEventListener('change', applyConfig);
});

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

  // Ctrl+Z (Undo) and Ctrl+Shift+Z (Redo)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) {
      if (typeof redoAction === 'function') redoAction();
    } else {
      if (typeof undoAction === 'function') undoAction();
    }
    return;
  }

  switch (e.key) {
    case ' ':       e.preventDefault(); togglePlay();                          break;
    case 'ArrowLeft':  e.preventDefault(); pause(); setFrame(state.currentFrame - (e.shiftKey ? state.fps : 1)); break;
    case 'ArrowRight': e.preventDefault(); pause(); setFrame(state.currentFrame + (e.shiftKey ? state.fps : 1)); break;
    case 'Home':    e.preventDefault(); pause(); setFrame(0);                  break;
    case 'End':     e.preventDefault(); pause(); setFrame(state.totalFrames - 1); break;
  }
});

if (el.btnUndo) el.btnUndo.addEventListener('click', () => { if (typeof undoAction === 'function') undoAction(); });
if (el.btnRedo) el.btnRedo.addEventListener('click', () => { if (typeof redoAction === 'function') redoAction(); });

// ─── Export ───────────────────────────────────────────────────────────────────

function setLog(msg) { if (el.exportLog) el.exportLog.textContent = msg; }
function setProgress(pct, label) {
  if (el.progressBar)   el.progressBar.style.setProperty('--pct', `${pct}%`);
  if (el.progressLabel) el.progressLabel.textContent = label;
}

el.btnExport.addEventListener('click', startExport);
el.btnAbort.addEventListener('click', () => {
  if (state.abortExport) state.abortExport();
});

async function startExport() {
  if (state.exporting) return;
  state.exporting = true;

  const format   = el.expFormat.value;
  const useRange = el.expRange.value === 'inout';
  const startF   = useRange ? state.rangeIn   : 0;
  const endF     = useRange ? getRangeOut()  : state.totalFrames;
  const total    = endF - startF;

  let aborted = false;
  state.abortExport = () => { aborted = true; };

  el.btnExport.disabled = true;
  el.btnAbort.disabled  = false;
  if (el.exportOverlay) el.exportOverlay.classList.remove('hidden');
  setProgress(0, `0 / ${total}`);
  setLog('Starting export...');

  try {
    const res = await fetch('http://127.0.0.1:8793/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        animationSrc: state.animationSrc,
        width:        state.width,
        height:       state.height,
        fps:          state.fps,
        format,
        startFrame:   startF,
        endFrame:     endF,
        autoInstallFfmpeg: state.autoInstallFfmpeg || false,
      }),
    });

    if (!res.ok) throw new Error(`Export server error: ${res.status}`);
    if (!res.body) throw new Error('No response body — is export-server.js running?');

    const reader = res.body.getReader();
    const dec    = new TextDecoder();
    let   buf    = '';

    while (true) {
      if (aborted) {
        await fetch('http://127.0.0.1:8793/abort', { method: 'POST' });
        setLog('Export aborted.');
        break;
      }

      const { value, done } = await reader.read();
      if (done) break;

      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'progress') {
            const pct = Math.round((msg.frame / total) * 100);
            setProgress(pct, `${msg.frame} / ${total}`);
            // Update stage preview to current export frame
            setFrame(startF + msg.frame);
          } else if (msg.type === 'log') {
            setLog(msg.text);
          } else if (msg.type === 'ffmpeg_missing') {
            if (!document.getElementById('ffmpeg-prompt-box')) {
              const box = document.createElement('div');
              box.id = 'ffmpeg-prompt-box';
              box.style.cssText = 'margin-top: 15px; padding: 12px; background: var(--surface); border: 1px solid var(--accent); border-radius: 4px; text-align: center;';
              box.innerHTML = `
                <div style="font-size:12px; margin-bottom:10px; color:var(--text);">FFmpeg is missing. Would you like to automatically download it now?</div>
                <button id="btn-ffmpeg-yes" class="primary" style="font-size:11px; padding:4px 10px; margin-right:8px; cursor:pointer;">Yes, Download</button>
                <button id="btn-ffmpeg-no" style="font-size:11px; padding:4px 10px; cursor:pointer;">No, Cancel</button>
              `;
              if (el.exportOverlay) el.exportOverlay.appendChild(box);
              
              document.getElementById('btn-ffmpeg-yes').addEventListener('click', () => {
                box.remove();
                state.autoInstallFfmpeg = true;
                state.exporting = false;
                startExport();
              });
              
              document.getElementById('btn-ffmpeg-no').addEventListener('click', () => {
                box.remove();
                setLog('Export cancelled: FFmpeg required.');
              });
            }
          } else if (msg.type === 'done') {
            setProgress(100, `${total} / ${total}`);
            setLog(`Done — ${msg.output}`);
          } else if (msg.type === 'error') {
            setLog(`Error: ${msg.text}`);
          }
        } catch { /* partial line */ }
      }
    }
  } catch (e) {
    setLog(`Export failed: ${e.message}`);
  } finally {
    state.exporting   = false;
    state.abortExport = null;
    el.btnExport.disabled = false;
    el.btnAbort.disabled  = true;
    setTimeout(() => {
      if (el.exportOverlay && !document.getElementById('ffmpeg-prompt-box')) {
        el.exportOverlay.classList.add('hidden');
        setProgress(0, '');
      }
    }, 3000); // keep status visible for 3s then hide
  }
}

// ─── AI Settings Panel ────────────────────────────────────────────────────────

const aiSettings = {
  provider: 'gemini',
  key: '',
  endpoint: '',
  model: 'gemini-2.5-pro',
  customModel: ''
};

// Load persistent settings
function loadSettings() {
  const saved = localStorage.getItem('htmlmc_ai_settings');
  if (saved) {
    try {
      Object.assign(aiSettings, JSON.parse(saved));
    } catch (e) { /* ignore */ }
  }
  populateSettingsForm();
  
  // Push keys to backend session server
  pushConfigToBackend();
}

function saveSettings() {
  aiSettings.provider = $('ai-provider').value;
  aiSettings.key = $('ai-key').value;
  aiSettings.endpoint = $('ai-endpoint').value;
  aiSettings.model = $('ai-model').value;
  aiSettings.customModel = $('ai-model-custom').value;

  localStorage.setItem('htmlmc_ai_settings', JSON.stringify(aiSettings));
  
  pushConfigToBackend();
  closeSettings();
}

function pushConfigToBackend() {
  fetch('http://127.0.0.1:8793/ai/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(aiSettings)
  }).catch(() => {});
}

function populateSettingsForm() {
  $('ai-provider').value = aiSettings.provider;
  $('ai-key').value = aiSettings.key;
  $('ai-endpoint').value = aiSettings.endpoint;
  
  updateModelOptions();
  $('ai-model').value = aiSettings.model;
  $('ai-model-custom').value = aiSettings.customModel;
  
  if (aiSettings.model === 'custom') {
    $('ai-model-custom').style.display = 'block';
  } else {
    $('ai-model-custom').style.display = 'none';
  }
}

function updateModelOptions() {
  const provider = $('ai-provider').value;
  const select = $('ai-model');
  select.innerHTML = '';
  
  const options = {
    anthropic: [
      { v: 'claude-opus-4-7',          t: 'Claude Opus 4.7 (Most capable)' },
      { v: 'claude-sonnet-4-6',        t: 'Claude Sonnet 4.6 (Recommended)' },
      { v: 'claude-haiku-4-5-20251001',t: 'Claude Haiku 4.5 (Fast)' },
      { v: 'custom',                   t: 'Custom model...' }
    ],
    gemini: [
      { v: 'gemini-2.5-pro',   t: 'Gemini 2.5 Pro (Recommended)' },
      { v: 'gemini-2.5-flash', t: 'Gemini 2.5 Flash (Fast)' },
      { v: 'custom',           t: 'Custom model...' }
    ],
    openai: [
      { v: 'gpt-4o',        t: 'GPT-4o (Recommended)' },
      { v: 'gpt-4o-mini',   t: 'GPT-4o Mini (Fast)' },
      { v: 'o3',            t: 'o3 (Strong reasoning)' },
      { v: 'o4-mini',       t: 'o4-mini (Fast reasoning)' },
      { v: 'custom',        t: 'Custom model...' }
    ],
    deepseek: [
      { v: 'deepseek-reasoner', t: 'DeepSeek R2 / Reasoner (Recommended)' },
      { v: 'deepseek-chat',     t: 'DeepSeek Chat (Fast)' },
      { v: 'custom',            t: 'Custom model...' }
    ],
    grok: [
      { v: 'grok-2-1212', t: 'Grok 2 (Recommended)' },
      { v: 'grok-beta',   t: 'Grok Beta (Fast)' },
      { v: 'custom',      t: 'Custom model...' }
    ],
    lm_studio: [
      { v: 'local-model', t: 'LM Studio Default' },
      { v: 'custom',      t: 'Custom model...' }
    ]
  };
  
  const providerOptions = options[provider] || [];
  providerOptions.forEach(opt => {
    const elOpt = document.createElement('option');
    elOpt.value = opt.v;
    elOpt.textContent = opt.t;
    select.appendChild(elOpt);
  });
  
  // Set default endpoint if empty
  const epInput = $('ai-endpoint');
  const localDefault = 'http://127.0.0.1:1234/v1';
  const placeholders = {
    anthropic: 'Default: https://api.anthropic.com/v1',
    gemini:    'Default: Google Generative Language API',
    openai:    'Default: https://api.openai.com/v1',
    deepseek:  'Default: https://api.deepseek.com/v1',
    grok:      'Default: https://api.x.ai/v1',
    lm_studio: 'e.g. http://127.0.0.1:1234/v1',
  };
  epInput.placeholder = placeholders[provider] ?? 'API endpoint URL';
  if (provider === 'lm_studio') {
    if (!epInput.value) epInput.value = localDefault;
  } else if (epInput.value === localDefault) {
    epInput.value = '';
  }
}

function openSettings() {
  $('ai-settings-modal').classList.add('active');
}

function closeSettings() {
  $('ai-settings-modal').classList.remove('active');
}

// Event Listeners
$('btn-settings').addEventListener('click', openSettings);
$('btn-close-settings').addEventListener('click', closeSettings);
$('btn-save-settings').addEventListener('click', saveSettings);

$('ai-provider').addEventListener('change', () => {
  updateModelOptions();
  const provider = $('ai-provider').value;
  if (provider === 'lm_studio') {
    $('group-api-key').style.opacity = '0.5';
    $('ai-key').placeholder = 'Not required for local models';
  } else {
    $('group-api-key').style.opacity = '1';
    $('ai-key').placeholder = 'Enter API key...';
  }
});

$('ai-model').addEventListener('change', () => {
  if ($('ai-model').value === 'custom') {
    $('ai-model-custom').style.display = 'block';
  } else {
    $('ai-model-custom').style.display = 'none';
  }
});

// ─── Assets Drawer Controller ──────────────────────────────────────────────────
const assetsController = {
  drawer: $('assets-drawer'),
  uploadZone: $('assets-upload-zone'),
  fileInput: $('assets-file-input'),
  listContainer: $('assets-list'),
  pooled: false,

  init() {
    if (!this.drawer || !this.uploadZone || !this.listContainer) return;

    // Pool toggle button
    const btnPool = $('btn-pool-toggle');
    if (btnPool) {
      btnPool.addEventListener('click', () => {
        this.pooled = !this.pooled;
        const icon = btnPool.querySelector('use');
        if (this.pooled) {
          icon.setAttribute('href', '#ico-link');
          btnPool.title = 'Pooled — showing all canvases\' assets. Click to isolate.';
          btnPool.classList.add('active');
        } else {
          icon.setAttribute('href', '#ico-link-off');
          btnPool.title = 'Isolated — click to pool all canvases\' assets';
          btnPool.classList.remove('active');
        }
        this.refresh();
      });
    }

    // Toggles
    $('btn-assets').addEventListener('click', () => this.open());
    $('btn-close-assets').addEventListener('click', () => this.close());
    this.drawer.addEventListener('click', (e) => {
      if (e.target === this.drawer) this.close();
    });

    // Upload Click
    this.uploadZone.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

    // Drag & Drop
    this.uploadZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.uploadZone.classList.add('dragover');
    });
    this.uploadZone.addEventListener('dragleave', () => {
      this.uploadZone.classList.remove('dragover');
    });
    this.uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      this.uploadZone.classList.remove('dragover');
      const files = e.dataTransfer.files;
      if (files.length > 0) this.uploadFiles(files);
    });
  },

  open() {
    this.drawer.classList.add('active');
    this.refresh();
  },

  close() {
    this.drawer.classList.remove('active');
  },

  async refresh() {
    try {
      const params = new URLSearchParams({ canvasId: activeCanvasId || '', pooled: this.pooled });
      const res = await fetch(`http://127.0.0.1:8793/assets?${params}`);
      if (!res.ok) throw new Error('Failed to load assets');
      const data = await res.json();
      this.render(data.assets);
    } catch (e) {
      console.error('[assets] Error loading assets:', e);
      this.listContainer.innerHTML = `<div class="empty-state" style="color:var(--danger)">Failed to load assets: ${e.message}</div>`;
    }
  },

  render(assets) {
    if (!assets || assets.length === 0) {
      this.listContainer.innerHTML = `<div class="empty-state">No assets loaded. Upload SVGs, PNGs, JPEGs, or videos to use them.</div>`;
      return;
    }

    this.listContainer.innerHTML = '';
    assets.forEach(asset => {
      const item = document.createElement('div');
      item.className = 'asset-item';
      const previewSrc = `/pipeline/${asset.path}`;

      let previewHTML = '';
      if (asset.type === 'image' || asset.type === 'vector') {
        previewHTML = `<img src="${previewSrc}" alt="${asset.name}">`;
      } else if (asset.type === 'video') {
        previewHTML = `<video src="${previewSrc}" muted playsinline loop autoplay style="pointer-events:none;"></video>`;
      } else if (asset.type === 'audio') {
        previewHTML = `<span class="asset-preview-icon"><svg width="24" height="24"><use href="#ico-audio"/></svg></span>`;
      } else {
        previewHTML = `<span class="asset-preview-icon"><svg width="24" height="24"><use href="#ico-file"/></svg></span>`;
      }

      // Show canvas badge when pooled
      const canvasBadge = (this.pooled && asset.canvasId)
        ? `<span class="asset-badge canvas-badge" title="From canvas ${asset.canvasId}">${asset.canvasId.slice(0, 6)}</span>`
        : '';

      item.innerHTML = `
        <div class="asset-preview">${previewHTML}</div>
        <div class="asset-info">
          <div class="asset-name" title="${asset.name}">${asset.name}</div>
          <div class="asset-meta">
            <span class="asset-badge">${asset.type}</span>${canvasBadge}
          </div>
        </div>
        <div class="asset-actions">
          <button class="btn-asset-action copy" title="Copy relative path">
            <svg width="12" height="12"><use href="#ico-copy"/></svg>
          </button>
          <button class="btn-asset-action delete" title="Delete asset">
            <svg width="12" height="12"><use href="#ico-trash"/></svg>
          </button>
        </div>
      `;

      item.querySelector('.copy').addEventListener('click', (e) => {
        e.stopPropagation();
        this.copyPath(asset.path, item.querySelector('.copy'));
      });

      const deleteBtn = item.querySelector('.delete');
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (deleteBtn.dataset.armed === 'true') {
          this.deleteAsset(asset.name, asset.canvasId || '');
        } else {
          deleteBtn.dataset.armed = 'true';
          deleteBtn.title = 'Click again to confirm delete';
          deleteBtn.style.color = 'var(--danger)';
          setTimeout(() => {
            deleteBtn.dataset.armed = 'false';
            deleteBtn.title = 'Delete asset';
            deleteBtn.style.color = '';
          }, 2500);
        }
      });

      this.listContainer.appendChild(item);
    });
  },

  async handleFileSelect(e) {
    const files = e.target.files;
    if (files.length > 0) {
      await this.uploadFiles(files);
      this.fileInput.value = ''; // Reset file input
    }
  },

  async uploadFiles(files) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const res = await fetch('http://127.0.0.1:8793/upload', {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'x-filename':   file.name,
            'x-canvas-id':  activeCanvasId || ''
          },
          body: file
        });
        if (!res.ok) throw new Error(`Upload returned status ${res.status}`);
      } catch (e) {
        alert(`Failed to upload ${file.name}: ${e.message}`);
      }
    }
    this.refresh();
  },

  async deleteAsset(filename, canvasId = '') {
    try {
      const res = await fetch('http://127.0.0.1:8793/delete-asset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, canvasId })
      });
      if (!res.ok) throw new Error(`Delete failed with status ${res.status}`);
      this.refresh();
    } catch (e) {
      alert(`Failed to delete asset: ${e.message}`);
    }
  },

  copyPath(path, btn) {
    navigator.clipboard.writeText(path).then(() => {
      const origHTML = btn.innerHTML;
      btn.innerHTML = `<span style="font-size:9px;color:var(--accent);font-weight:bold;">✓</span>`;
      setTimeout(() => btn.innerHTML = origHTML, 1500);
    }).catch(err => {
      console.error('Failed to copy path:', err);
    });
  }
};

// ─── AI Prompt & Diff Review (Dockable Sidebar Chat Log) ──────────────────────

const aiState = {
  generating: false,
};

const aiEl = {
  prompt:      $('ai-prompt'),
  btnGenerate: $('btn-ai-generate'),
  chatHistory: $('ai-chat-history'),
  status:      $('ai-status'),
  sidebar:     $('ai-sidebar'),
  btnToggle:   $('btn-ai-sidebar'),
  btnDock:     $('btn-ai-dock'),
  btnClose:    $('btn-ai-close'),
};

const pendingAiResults = new Map();
let aiMessageCounter = 0;

function aiSetStatus(msg) { 
  if (aiEl.status) {
    aiEl.status.textContent = msg;
    aiEl.status.title = msg;
  }
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function appendChatMessage(sender, content, extraHtml = '') {
  if (!aiEl.chatHistory) return null;
  const msgId = 'msg-' + (++aiMessageCounter);
  const div = document.createElement('div');
  div.className = `chat-message ${sender}`;
  div.dataset.id = msgId;
  
  if (sender === 'user') {
    div.title = "Click to reload this prompt into the input box to modify it";
    div.style.cursor = "pointer";
    div.dataset.rawPrompt = encodeURIComponent(content);
  }
  
  // Custom bubble wrapping
  div.innerHTML = `
    <div class="chat-bubble">
      ${sender === 'system' ? content : escHtml(content).replace(/\n/g, '<br>')}
      ${extraHtml}
    </div>
  `;
  
  aiEl.chatHistory.appendChild(div);
  aiEl.chatHistory.scrollTop = aiEl.chatHistory.scrollHeight;
  return div;
}

async function applyAiResultInline(result, reviewContainer) {
  if (!result?.full_code) return false;
  const { html, css, js } = result.full_code;
  const doc = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<style>${css ?? ''}</style></head>
<body>${html ?? ''}
<script>${js ?? ''}
window.addEventListener('message',(e)=>{
  if(e.data?.type==='seek'){const t=e.data.timeMs;document.getAnimations().forEach(a=>{a.currentTime=t;a.pause();});}
  if(e.data?.type==='error_report'){window.parent.postMessage({type:'error',message:e.data.message},'*');}
});<\/script></body></html>`;

  aiSetStatus('Writing preview...');
  try {
    const res = await fetch('http://127.0.0.1:8793/update-stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: doc }),
    });
    if (!res.ok) throw new Error(`update-stage ${res.status}`);
    const data = await res.json();
    state.animationSrc = data.url + '?t=' + Date.now();
    el.stageFrame.src  = state.animationSrc;
    setFrame(0);
    
    // Also save the code directly inside our active canvas record so state persists
    const activeRecord = canvasList.find(c => c.id === activeCanvasId);
    if (activeRecord) {
      if (!activeRecord.undoStack) activeRecord.undoStack = [];
      activeRecord.undoStack.push(activeRecord.code);
      activeRecord.redoStack = []; // Clear redo stack on new action
      
      activeRecord.code = doc;
      saveCanvasList();
    }
    
    return true;
  } catch (e) {
    aiSetStatus(`Apply failed: ${e.message}`);
    const errEl = document.createElement('div');
    errEl.id = 'ai-error-message';
    errEl.textContent = `Apply failed: ${e.message}`;
    reviewContainer.appendChild(errEl);
    return false;
  }
}

// Surface iframe runtime errors in the active chat log
window.addEventListener('message', e => {
  if (e.data?.type === 'error') {
    aiSetStatus('Stage compile error.');
    appendChatMessage('system', `⚠️ <strong>Stage Compilation Error:</strong> <span style="color:var(--danger);">${escHtml(e.data.message)}</span>`);
  }
});

// Dynamic event delegation for interactive bubble actions inside chat history
if (aiEl.chatHistory) {
  aiEl.chatHistory.addEventListener('click', async e => {
    const target = e.target;
    
    // 0. Modify / Re-run User Prompt
    const userMsg = target.closest('.chat-message.user');
    if (userMsg && aiEl.prompt) {
      e.stopPropagation();
      try {
        const raw = decodeURIComponent(userMsg.dataset.rawPrompt);
        aiEl.prompt.value = raw;
        aiEl.prompt.focus();
        aiSetStatus('Prompt loaded for modification.');
      } catch (err) {}
      return;
    }

    // 1. Toggle Code Diff Block
    if (target.classList.contains('btn-diff-toggle')) {
      e.stopPropagation();
      const reviewContainer = target.closest('.ai-inline-review');
      if (reviewContainer) {
        const diffBlock = reviewContainer.querySelector('.ai-inline-diff');
        if (diffBlock) {
          const isHidden = diffBlock.classList.toggle('hidden');
          target.textContent = isHidden ? 'View Proposed Code Diffs' : 'Hide Code Diffs';
        }
      }
      return;
    }

    // 2. Reject proposed changes
    if (target.classList.contains('btn-ai-inline-reject')) {
      e.stopPropagation();
      const reviewContainer = target.closest('.ai-inline-review');
      if (reviewContainer) {
        const actions = reviewContainer.querySelector('.ai-inline-actions');
        const status = reviewContainer.querySelector('.ai-inline-status');
        if (actions) actions.style.display = 'none';
        if (status) {
          status.textContent = 'Changes rejected.';
          status.className = 'ai-inline-status rejected';
          status.classList.remove('hidden');
        }
      }
      return;
    }

    // 3. Apply proposed changes
    if (target.classList.contains('btn-ai-inline-apply')) {
      e.stopPropagation();
      const reviewContainer = target.closest('.ai-inline-review');
      if (reviewContainer) {
        const resId = reviewContainer.dataset.resultId;
        const result = pendingAiResults.get(resId);
        if (!result) return;
        
        target.disabled = true;
        const rejectBtn = reviewContainer.querySelector('.btn-ai-inline-reject');
        if (rejectBtn) rejectBtn.disabled = true;

        const success = await applyAiResultInline(result, reviewContainer);
        
        if (success) {
          const actions = reviewContainer.querySelector('.ai-inline-actions');
          const status = reviewContainer.querySelector('.ai-inline-status');
          if (actions) actions.style.display = 'none';
          if (status) {
            status.textContent = 'Changes applied successfully!';
            status.className = 'ai-inline-status';
            status.classList.remove('hidden');
          }
          aiSetStatus('Applied.');
        } else {
          target.disabled = false;
          if (rejectBtn) rejectBtn.disabled = false;
        }
      }
      return;
    }
  });
}

// Generate trigger
if (aiEl.btnGenerate) {
  aiEl.btnGenerate.addEventListener('click', async () => {
    const prompt = aiEl.prompt?.value.trim();
    if (!prompt || aiState.generating) return;

    aiState.generating = true;
    aiEl.btnGenerate.disabled = true;
    aiSetStatus('Generating...');

    // Append user message bubble instantly
    appendChatMessage('user', prompt);
    
    // Clear prompt area
    aiEl.prompt.value = '';

    try {
      const res = await fetch('http://127.0.0.1:8793/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          currentCode: getCurrentCode(),
          canvasId: activeCanvasId || '',
          pooled:   assetsController.pooled,
        }),
      });
      if (!res.ok) throw new Error(await res.text() || `Server error ${res.status}`);
      const result = await res.json();
      
      // Build inline review elements for AI bubble
      let extraHtml = '';
      const resultId = 'res-' + Date.now();
      pendingAiResults.set(resultId, result);

      if (result.type !== 'suggestion' && result.full_code) {
        let diffLines = '';
        const changes = result.suggested_changes ?? [];
        if (changes.length === 0) {
          const lines = [result.full_code.html, result.full_code.css, result.full_code.js]
            .filter(Boolean).map(s => s.split('\n').length + ' lines').join(', ');
          diffLines = `[Full Generation Replacement]\n— HTML, CSS, JS (${lines})`;
        } else {
          changes.forEach((c, idx) => {
            diffLines += `[${c.file} — Change ${idx + 1}]\n`;
            diffLines += `- TARGET:\n${truncate(c.target, 120)}\n`;
            diffLines += `+ REPLACEMENT:\n${truncate(c.replacement, 120)}\n\n`;
          });
        }

        extraHtml = `
          <div class="ai-inline-review" data-result-id="${resultId}">
            <button class="btn-diff-toggle">View Proposed Code Diffs</button>
            <pre class="ai-inline-diff hidden"><code>${escHtml(diffLines)}</code></pre>
            <div class="ai-inline-actions">
              <button class="btn-ai-inline-reject">Reject</button>
              <button class="btn-ai-inline-apply primary">Apply Changes</button>
            </div>
            <div class="ai-inline-status hidden"></div>
          </div>
        `;
        
        // Auto refresh workspace assets
        if (Array.isArray(result.generated_assets) && result.generated_assets.length > 0) {
          setTimeout(() => {
            if (typeof assetsController !== 'undefined' && assetsController.refresh) {
              assetsController.refresh();
            }
          }, 100);
        }
      }

      // Append AI bubble with content
      appendChatMessage('ai', result.explanation || 'Done.', extraHtml);
      aiSetStatus('Review suggestion above.');
    } catch (e) {
      aiSetStatus(`Error: ${e.message}`);
      appendChatMessage('system', `⚠️ <strong>Error:</strong> <span style="color:var(--danger);">${escHtml(e.message)}</span>`);
    } finally {
      aiState.generating = false;
      aiEl.btnGenerate.disabled = false;
    }
  });
}

// --- History State Manager (Undo / Redo) ---
async function applyHistoryState(newCode) {
  aiSetStatus('Restoring state...');
  try {
    const res = await fetch('http://127.0.0.1:8793/update-stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: newCode }),
    });
    if (!res.ok) throw new Error(`update-stage ${res.status}`);
    const data = await res.json();
    state.animationSrc = data.url + '?t=' + Date.now();
    el.stageFrame.src  = state.animationSrc;
    setFrame(0);
    return true;
  } catch (e) {
    aiSetStatus(`Restore failed: ${e.message}`);
    return false;
  }
}

async function undoAction() {
  const activeRecord = canvasList.find(c => c.id === activeCanvasId);
  if (!activeRecord || !activeRecord.undoStack || activeRecord.undoStack.length === 0) return;
  
  if (!activeRecord.redoStack) activeRecord.redoStack = [];
  activeRecord.redoStack.push(activeRecord.code); // Save current to redo
  
  const oldCode = activeRecord.undoStack.pop();
  activeRecord.code = oldCode;
  saveCanvasList();
  
  if (await applyHistoryState(oldCode)) {
    aiSetStatus('Undid last modification');
  }
}

async function redoAction() {
  const activeRecord = canvasList.find(c => c.id === activeCanvasId);
  if (!activeRecord || !activeRecord.redoStack || activeRecord.redoStack.length === 0) return;
  
  if (!activeRecord.undoStack) activeRecord.undoStack = [];
  activeRecord.undoStack.push(activeRecord.code); // Save current to undo
  
  const newCode = activeRecord.redoStack.pop();
  activeRecord.code = newCode;
  saveCanvasList();
  
  if (await applyHistoryState(newCode)) {
    aiSetStatus('Redid last modification');
  }
}


// Ctrl/Cmd+Enter submits prompt
if (aiEl.prompt) {
  aiEl.prompt.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      aiEl.btnGenerate?.click();
    }
  });
}

// Wire AI Sidebar visibility toggling
if (aiEl.btnToggle && aiEl.sidebar) {
  aiEl.btnToggle.addEventListener('click', () => {
    const isActive = aiEl.btnToggle.classList.toggle('active');
    aiEl.sidebar.classList.toggle('collapsed', !isActive);
    if (isActive) {
      setTimeout(() => {
        if (aiEl.prompt) {
          aiEl.prompt.focus();
          aiEl.prompt.select();
        }
      }, 100);
    }
  });
}

// Header Close button
if (aiEl.btnClose && aiEl.sidebar) {
  aiEl.btnClose.addEventListener('click', () => {
    if (aiEl.btnToggle) aiEl.btnToggle.classList.remove('active');
    aiEl.sidebar.classList.add('collapsed');
  });
}

// Docking side switcher (Left / Right) with LocalStorage persistence
if (aiEl.btnDock && aiEl.sidebar) {
  aiEl.btnDock.addEventListener('click', () => {
    const isLeft = aiEl.sidebar.classList.contains('dock-left');
    if (isLeft) {
      aiEl.sidebar.classList.remove('dock-left');
      aiEl.sidebar.classList.add('dock-right');
      localStorage.setItem('htmlmc_ai_dock_side', 'right');
    } else {
      aiEl.sidebar.classList.remove('dock-right');
      aiEl.sidebar.classList.add('dock-left');
      localStorage.setItem('htmlmc_ai_dock_side', 'left');
    }
  });

  // Restore preferred dock side on launch!
  const preferredSide = localStorage.getItem('htmlmc_ai_dock_side') || 'right';
  aiEl.sidebar.classList.remove('dock-left', 'dock-right');
  aiEl.sidebar.classList.add(preferredSide === 'left' ? 'dock-left' : 'dock-right');
}

// ─── Canvas Manager ───────────────────────────────────────────────────────────
//
// Each canvas stores: { id, name, src, code, thumbnail, width, height, fps, durationS }
// Persisted in localStorage under key 'htmlmc_canvases'.
// Active canvas id under 'htmlmc_active_canvas'.

const CANVAS_STORE_KEY  = 'htmlmc_canvases';
const CANVAS_ACTIVE_KEY = 'htmlmc_active_canvas';
const AUTO_SAVE_DELAY   = 1500; // ms debounce

let canvasList     = [];
let activeCanvasId = null;
let autoSaveTimer  = null;

function genId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function getCurrentCode() {
  if (typeof activeCanvasId !== 'undefined' && activeCanvasId) {
    const record = canvasList.find(c => c.id === activeCanvasId);
    if (record) return record.code || '';
  }
  return '';
}

// Send active canvas code to backend to sync the iframe physical page
async function saveCodeToServer(code) {
  try {
    const res = await fetch('http://127.0.0.1:8793/update-stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error('Failed to sync canvas stage to server:', e);
    return { error: e.message };
  }
}

function loadCanvases() {
  try {
    canvasList     = JSON.parse(localStorage.getItem(CANVAS_STORE_KEY) ?? '[]');
    activeCanvasId = localStorage.getItem(CANVAS_ACTIVE_KEY);
  } catch {
    canvasList = [];
  }

  // Sanitize loaded records to ensure perfect structure and compatibility
  if (Array.isArray(canvasList)) {
    canvasList = canvasList.map(record => {
      if (!record || typeof record !== 'object') return null;
      return {
        id:        record.id || 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name:      record.name || 'Canvas 1',
        src:       record.src || '/pipeline/animation_preview.html',
        code:      record.code || '',
        undoStack: record.undoStack || [],
        redoStack: record.redoStack || [],
        thumbnail: record.thumbnail || null,
        width:     record.width || state.width,
        height:    record.height || state.height,
        fps:       record.fps || state.fps,
        durationS: record.durationS || state.durationS,
      };
    }).filter(Boolean);
  } else {
    canvasList = [];
  }

  // Bootstrap: create first canvas if none exist
  if (canvasList.length === 0) {
    const first = makeCanvasRecord('Canvas 1');
    canvasList.push(first);
    activeCanvasId = first.id;
    saveCanvasList();
  }
  // Ensure active id is valid
  if (!canvasList.find(c => c.id === activeCanvasId)) {
    activeCanvasId = canvasList[0].id;
  }
  localStorage.setItem(CANVAS_ACTIVE_KEY, activeCanvasId);
}

function makeCanvasRecord(name, code = null) {
  return {
    id:        genId(),
    name,
    src:       '/pipeline/animation_preview.html',
    code:      code || getCurrentCode(),
    undoStack: [],
    redoStack: [],
    thumbnail: null,
    width:     state.width,
    height:    state.height,
    fps:       state.fps,
    durationS: state.durationS,
  };
}

function saveCanvasList() {
  localStorage.setItem(CANVAS_STORE_KEY, JSON.stringify(canvasList));
}

function captureThumb() {
  return new Promise(resolve => {
    try {
      const iframe = el.stageFrame;
      const iframeDoc = iframe.contentWindow?.document;
      if (!iframeDoc || !iframeDoc.body) { resolve(null); return; }

      const THUMB_W = 160;
      const THUMB_H = 90;
      const canvas  = document.createElement('canvas');
      canvas.width  = THUMB_W;
      canvas.height = THUMB_H;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(iframe, 0, 0, THUMB_W, THUMB_H);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    } catch (e) {
      // Cross-origin or blank frame — just skip the thumbnail
      resolve(null);
    }
  });
}

// Save current state back into the active canvas record
async function saveActiveCanvas() {
  const record = canvasList.find(c => c.id === activeCanvasId);
  if (!record) return;
  record.src       = state.animationSrc;
  record.width     = state.width;
  record.height    = state.height;
  record.fps       = state.fps;
  record.durationS = state.durationS;
  record.code      = getCurrentCode();
  record.thumbnail = await captureThumb();
  saveCanvasList();
  renderCanvasStrip();
}

// Schedule an auto-save (debounced)
function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(saveActiveCanvas, AUTO_SAVE_DELAY);
}

// Switch to a canvas by id — saves current first
async function switchCanvas(id) {
  if (id === activeCanvasId) return;
  await saveActiveCanvas();
  activeCanvasId = id;
  localStorage.setItem(CANVAS_ACTIVE_KEY, id);
  const record = canvasList.find(c => c.id === id);
  if (!record) return;

  // Restore config
  state.width     = record.width;
  state.height    = record.height;
  state.fps       = record.fps;
  state.durationS = record.durationS;
  el.cfgWidth.value    = state.width;
  el.cfgHeight.value   = state.height;
  el.cfgFps.value      = state.fps;
  el.cfgDuration.value = state.durationS;

  // Load animation
  state.animationSrc   = record.src;
  if (record.code) {
    await saveCodeToServer(record.code);
  }
  el.stageFrame.width  = state.width;
  el.stageFrame.height = state.height;
  el.stageFrame.src    = record.src + '?t=' + Date.now();

  setFrame(0);
  fitStage();
  renderTimeline();
  updateHUD();
  renderCanvasStrip();
}

// Create a new canvas loaded with the default template
async function newCanvas() {
  await saveActiveCanvas();
  const name   = `Canvas ${canvasList.length + 1}`;
  
  let defaultCode = '';
  try {
    const resp = await fetch('/pipeline/animation.html');
    if (resp.ok) {
      defaultCode = await resp.text();
    }
  } catch (err) {
    console.warn('Failed to fetch default template:', err);
  }

  const record = makeCanvasRecord(name, defaultCode);
  record.src = '/pipeline/animation_preview.html';
  canvasList.push(record);
  saveCanvasList();
  await switchCanvas(record.id);
  
  const thumbs = $('canvas-thumbs');
  if (thumbs) thumbs.scrollLeft = thumbs.scrollWidth;
}

// Reset any armed delete buttons
function resetDeleteConfirmations(exceptId = null) {
  document.querySelectorAll('.canvas-thumb-btn.danger.armed').forEach(btn => {
    const thumb = btn.closest('.canvas-thumb');
    if (thumb && exceptId && thumb.dataset.id === exceptId) return;
    
    btn.classList.remove('armed');
    const ico = btn.querySelector('.ico-del');
    const lbl = btn.querySelector('.lbl-confirm');
    if (ico) ico.classList.remove('hidden');
    if (lbl) lbl.classList.add('hidden');
  });
}

// Global click listener to clear armed delete buttons
document.addEventListener('click', e => {
  if (!e.target.closest('[data-action="delete"]')) {
    resetDeleteConfirmations();
  }
});

// Inline custom rename trigger
function startInlineRename(id, nameSpan) {
  if (!nameSpan || nameSpan.tagName === 'INPUT') return;
  const record = canvasList.find(c => c.id === id);
  if (!record) return;

  const originalName = nameSpan.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'canvas-thumb-rename-input';
  input.value = originalName;
  
  // Custom styles matching the label area
  input.style.width = '100%';
  input.style.background = 'var(--surface)';
  input.style.border = '1px solid var(--accent)';
  input.style.borderRadius = '3px';
  input.style.color = 'var(--text)';
  input.style.fontSize = '11px';
  input.style.outline = 'none';
  input.style.padding = '1px 3px';
  input.style.fontFamily = 'inherit';

  // Prevent selection or click events from bubbling to parent card
  const stopEvents = e => e.stopPropagation();
  input.addEventListener('click', stopEvents);
  input.addEventListener('dblclick', stopEvents);
  input.addEventListener('mousedown', stopEvents);

  const saveRename = () => {
    const newName = input.value.trim();
    if (newName && newName !== originalName) {
      record.name = newName;
      saveCanvasList();
      renderCanvasStrip();
    } else {
      // Revert back
      nameSpan.innerHTML = '';
      nameSpan.textContent = originalName;
    }
  };

  input.addEventListener('blur', saveRename);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Revert without saving
      nameSpan.innerHTML = '';
      nameSpan.textContent = originalName;
    }
  });

  // Perform the replacement
  nameSpan.innerHTML = '';
  nameSpan.appendChild(input);
  input.focus();
  input.select();
}

// Rename helper (delegates to inline renaming)
function renameCanvas(id) {
  const thumb = document.querySelector(`.canvas-thumb[data-id="${id}"]`);
  if (thumb) {
    const span = thumb.querySelector('.canvas-thumb-name');
    if (span) startInlineRename(id, span);
  }
}

// Delete a canvas (must have at least one)
async function deleteCanvas(id) {
  if (canvasList.length <= 1) return;
  const idx = canvasList.findIndex(c => c.id === id);
  if (idx === -1) return;
  
  canvasList.splice(idx, 1);
  saveCanvasList(); // Ensure state is saved immediately!

  if (activeCanvasId === id) {
    const nextActiveId = canvasList[Math.max(0, idx - 1)].id;
    activeCanvasId = nextActiveId;
    localStorage.setItem(CANVAS_ACTIVE_KEY, nextActiveId);

    const record = canvasList.find(c => c.id === nextActiveId);
    if (record) {
      state.width     = record.width;
      state.height    = record.height;
      state.fps       = record.fps;
      state.durationS = record.durationS;
      el.cfgWidth.value    = state.width;
      el.cfgHeight.value   = state.height;
      el.cfgFps.value      = state.fps;
      el.cfgDuration.value = state.durationS;

      state.animationSrc = record.src;
      if (record.code) {
        await saveCodeToServer(record.code);
      }
      el.stageFrame.width  = state.width;
      el.stageFrame.height = state.height;
      el.stageFrame.src    = record.src + '?t=' + Date.now();
    }

    setFrame(0);
    fitStage();
    renderTimeline();
    updateHUD();
  }

  renderCanvasStrip();
}

// Render the thumbnail strip
function renderCanvasStrip() {
  const container = $('canvas-thumbs');
  if (!container) return;
  container.innerHTML = '';

  canvasList.forEach(record => {
    const div = document.createElement('div');
    div.className = 'canvas-thumb' + (record.id === activeCanvasId ? ' active' : '');
    div.title = record.name;
    div.dataset.id = record.id;

    div.innerHTML = `
      <div class="canvas-thumb-img-wrap">
        ${record.thumbnail
          ? `<img src="${record.thumbnail}" alt="${record.name}">`
          : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--border)"><svg width="20" height="20"><use href="#ico-file"/></svg></div>`}
      </div>
      <div class="canvas-thumb-label">
        <span class="canvas-thumb-name">${record.name}</span>
        <div class="canvas-thumb-actions">
          <button class="canvas-thumb-btn" data-action="rename" title="Rename">
            <svg width="10" height="10"><use href="#ico-pencil"/></svg>
          </button>
          <button class="canvas-thumb-btn danger" data-action="delete" title="Delete">
            <svg class="ico-del" width="10" height="10"><use href="#ico-close"/></svg>
            <span class="lbl-confirm hidden" style="font-size: 8px; font-weight: bold; margin-left: 2px;">Sure?</span>
          </button>
        </div>
      </div>`;

    // Click to select canvas
    div.addEventListener('click', e => {
      // If we are currently confirming a delete elsewhere and they click this card, reset it
      if (!e.target.closest('[data-action="delete"]')) {
        resetDeleteConfirmations();
      }
      if (e.target.closest('[data-action]') || e.target.tagName === 'INPUT') return;
      switchCanvas(record.id);
    });

    // Double-click to rename canvas directly!
    div.addEventListener('dblclick', e => {
      e.stopPropagation();
      startInlineRename(record.id, div.querySelector('.canvas-thumb-name'));
    });

    div.querySelector('[data-action="rename"]')
       .addEventListener('click', e => {
         e.stopPropagation();
         resetDeleteConfirmations();
         startInlineRename(record.id, div.querySelector('.canvas-thumb-name'));
       });

    const delBtn = div.querySelector('[data-action="delete"]');
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      const isArmed = delBtn.classList.contains('armed');
      resetDeleteConfirmations(record.id); // clear any other cards
      
      if (!isArmed) {
        delBtn.classList.add('armed');
        const ico = delBtn.querySelector('.ico-del');
        const lbl = delBtn.querySelector('.lbl-confirm');
        if (ico) ico.classList.add('hidden');
        if (lbl) lbl.classList.remove('hidden');
      } else {
        deleteCanvas(record.id);
      }
    });

    container.appendChild(div);
  });
}

// Wire new canvas button
const btnNew = $('btn-new-canvas');
if (btnNew) btnNew.addEventListener('click', newCanvas);

// Wire canvas drawer toggle button
const btnCanvases = $('btn-canvases');
const canvasStrip = $('canvas-strip');
if (btnCanvases && canvasStrip) {
  btnCanvases.addEventListener('click', () => {
    const isActive = btnCanvases.classList.toggle('active');
    canvasStrip.classList.toggle('active');
    
    // Auto-scroll active card into view when opening
    if (isActive) {
      setTimeout(() => {
        const activeCard = canvasStrip.querySelector('.canvas-thumb.active');
        if (activeCard) activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }, 250);
    }
  });
}

// Auto-save on config change, animation apply, and before unload
window.addEventListener('beforeunload', () => saveActiveCanvas());

// Hook into existing applyConfig to trigger auto-save
const _origApplyConfig = typeof applyConfig === 'function' ? applyConfig : null;

// Patch: after any stage src change, schedule auto-save
const _origStageLoad = el.stageFrame.onload;
el.stageFrame.addEventListener('load', scheduleAutoSave);

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  loadCanvases();
  renderCanvasStrip();
  // Restore active canvas settings
  const active = canvasList.find(c => c.id === activeCanvasId);
  if (active) {
    state.width     = active.width;
    state.height    = active.height;
    state.fps       = active.fps;
    state.durationS = active.durationS;
    state.animationSrc = active.src;
    el.cfgWidth.value    = state.width;
    el.cfgHeight.value   = state.height;
    el.cfgFps.value      = state.fps;
    el.cfgDuration.value = state.durationS;
    el.stageFrame.width  = state.width;
    el.stageFrame.height = state.height;
    
    // Sync loaded code with backend server on startup
    if (active.code) {
      await saveCodeToServer(active.code);
    }
    el.stageFrame.src    = active.src + '?t=' + Date.now();
  }
  initStage();
  renderTimeline();
  updateHUD();
  loadSettings();
  assetsController.init();
}

init();

