const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');

const cubismCode = fs.readFileSync(path.join(__dirname, 'live2dcubismcore.min.js'), 'utf8');
eval(cubismCode);

const PIXI = require('pixi.js');
const { Live2DModel } = require('pixi-live2d-display/cubism4');
window.PIXI = PIXI;

const Store = require('electron-store');
const store = new Store();

const DEFAULT_MODEL_PATH = store.get('mascotModelPath', 'model/model 1/ai_assistant_model.model3.json');
const DRAG_HOLD_MS = 3000;
const HOVER_ALPHA = 0.48;
const CURSOR_SYNC_MS = 40;
const HOLD_TICK_MS = 33;

let W = window.innerWidth;
let H = window.innerHeight;
let currentScaleFactor = Math.max((store.get('scale', 0.25) || 0.25) / 0.25, 0.2);
let dragShortcutEnabled = store.get('mascotDragShortcutEnabled', true);
let baseModelScale = 1;
let model = null;
let hoverActive = false;
let dragActive = false;
let interactionArmed = false;
let altPressed = false;
let pointerDown = false;
let dragHoldTimer = null;
let dragHoldProgressTimer = null;
let cursorLocal = { x: W / 2, y: H / 2 };
let syncInFlight = false;

const app = new PIXI.Application({
  view: document.getElementById('canvas'),
  width: W,
  height: H,
  backgroundAlpha: 0,
  antialias: true,
});
const canvas = app.view;

app.stage.sortableChildren = true;
document.body.style.cursor = 'default';

const holdIndicator = document.createElement('div');
holdIndicator.style.cssText = [
  'position:fixed',
  'width:42px',
  'height:42px',
  'border-radius:999px',
  'pointer-events:none',
  'display:none',
  'z-index:9999',
  'background:conic-gradient(rgba(255,255,255,0.9) 0deg, rgba(255,255,255,0.15) 0deg)',
  'box-shadow:0 0 18px rgba(255,255,255,0.18)',
  'border:1px solid rgba(255,255,255,0.35)',
  'backdrop-filter:blur(6px)',
].join(';');
holdIndicator.innerHTML = '<div style="position:absolute;inset:8px;border-radius:999px;background:rgba(14,18,27,0.72);"></div>';
document.body.appendChild(holdIndicator);

function clearDragHoldTimer() {
  if (!dragHoldTimer) return;
  clearTimeout(dragHoldTimer);
  dragHoldTimer = null;
}

function clearDragHoldProgressTimer() {
  if (!dragHoldProgressTimer) return;
  clearInterval(dragHoldProgressTimer);
  dragHoldProgressTimer = null;
}

function updateHoldIndicatorPosition(clientX, clientY) {
  holdIndicator.style.left = `${Math.round(clientX - 21)}px`;
  holdIndicator.style.top = `${Math.round(clientY - 52)}px`;
}

function showHoldIndicator(clientX, clientY) {
  updateHoldIndicatorPosition(clientX, clientY);
  holdIndicator.style.display = 'block';
  holdIndicator.style.background = 'conic-gradient(rgba(255,255,255,0.9) 0deg, rgba(255,255,255,0.15) 0deg)';
}

function hideHoldIndicator() {
  clearDragHoldProgressTimer();
  holdIndicator.style.display = 'none';
}

function updateCursorStyle() {
  document.body.style.cursor = dragActive ? 'grabbing' : (interactionArmed ? 'grab' : 'default');
}

function setInteractionArmed(nextArmed) {
  const armed = !!nextArmed && dragShortcutEnabled && hoverActive;
  if (interactionArmed === armed) return;
  interactionArmed = armed;
  ipcRenderer.send('mascot-interaction-arm', { armed });
  updateCursorStyle();
}

function setHoverState(nextHover) {
  hoverActive = !!nextHover;
  canvas.style.opacity = hoverActive ? String(HOVER_ALPHA) : '1';
  if (!hoverActive) {
    setInteractionArmed(false);
  }
}

function fitModelToWindow(target) {
  const width = Math.max(
    target.internalModel?.width || target.internalModel?.originalWidth || target.width || 0,
    1
  );
  const height = Math.max(
    target.internalModel?.height || target.internalModel?.originalHeight || target.height || 0,
    1
  );

  baseModelScale = Math.min((W * 0.78) / width, (H * 0.92) / height);
  target.anchor.set(0.5, 1.0);
  target.scale.set(baseModelScale * currentScaleFactor);
  target.x = W / 2;
  target.y = H;
}

function pointWithinModel(localX, localY) {
  if (!model) return false;
  if (localX < 0 || localY < 0 || localX > W || localY > H) return false;

  try {
    const bounds = model.getBounds();
    return bounds.contains(localX, localY);
  } catch {
    return false;
  }
}

function endDrag() {
  clearDragHoldTimer();
  hideHoldIndicator();
  pointerDown = false;
  if (dragActive) {
    dragActive = false;
    ipcRenderer.send('mascot-drag-end');
  }
  if (!altPressed) {
    setInteractionArmed(false);
  }
  updateCursorStyle();
}

function beginDragIfStillHeld() {
  if (!pointerDown || !hoverActive || dragActive || !interactionArmed) return;
  dragActive = true;
  hideHoldIndicator();
  ipcRenderer.send('mascot-drag-start');
  updateCursorStyle();
}

async function loadMascotModel(modelPath = DEFAULT_MODEL_PATH) {
  try {
    const resolved = String(modelPath || DEFAULT_MODEL_PATH).replace(/\\/g, '/');
    const nextModel = await Live2DModel.from(`./${resolved}`);

    if (model) {
      app.stage.removeChild(model);
      model.destroy();
    }

    model = nextModel;
    app.stage.addChild(model);
    fitModelToWindow(model);
  } catch (err) {
    console.error('Model load error:', err);
  }
}

async function syncCursorContext() {
  if (syncInFlight) return;
  syncInFlight = true;

  try {
    const ctx = await ipcRenderer.invoke('get-mascot-context');
    if (!ctx?.visible || !model || !ctx.bounds || !ctx.cursor) {
      setHoverState(false);
      return;
    }

    if (typeof ctx.dragShortcutEnabled === 'boolean') {
      dragShortcutEnabled = ctx.dragShortcutEnabled;
    }

    cursorLocal = {
      x: ctx.cursor.x - ctx.bounds.x,
      y: ctx.cursor.y - ctx.bounds.y,
    };

    try {
      model.focus(cursorLocal.x, cursorLocal.y, false);
    } catch {}

    setHoverState(pointWithinModel(cursorLocal.x, cursorLocal.y) || dragActive);
    if (!dragActive) {
      setInteractionArmed(altPressed);
    }
  } catch (err) {
    console.error('Mascot cursor sync error:', err);
  } finally {
    syncInFlight = false;
  }
}

document.addEventListener('pointerdown', (event) => {
  if (!hoverActive || !model || !interactionArmed || event.button !== 0 || !event.altKey) return;
  event.preventDefault();
  pointerDown = true;
  clearDragHoldTimer();
  showHoldIndicator(event.clientX, event.clientY);
  const startedAt = Date.now();
  clearDragHoldProgressTimer();
  dragHoldProgressTimer = setInterval(() => {
    const progress = Math.min((Date.now() - startedAt) / DRAG_HOLD_MS, 1);
    const degrees = Math.round(progress * 360);
    holdIndicator.style.background = `conic-gradient(rgba(255,255,255,0.92) ${degrees}deg, rgba(255,255,255,0.15) ${degrees}deg)`;
  }, HOLD_TICK_MS);
  dragHoldTimer = setTimeout(beginDragIfStillHeld, DRAG_HOLD_MS);
});

document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);
document.addEventListener('pointermove', (event) => {
  altPressed = !!event.altKey;
  if (holdIndicator.style.display === 'block') {
    updateHoldIndicatorPosition(event.clientX, event.clientY);
  }
  if (!dragActive) {
    setInteractionArmed(altPressed);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Alt') {
    altPressed = true;
    if (!dragActive) setInteractionArmed(true);
  }
});
document.addEventListener('keyup', (event) => {
  if (event.key === 'Alt') {
    altPressed = false;
    if (!dragActive) setInteractionArmed(false);
    if (pointerDown) endDrag();
  }
});
window.addEventListener('blur', endDrag);

window.addEventListener('resize', () => {
  W = window.innerWidth;
  H = window.innerHeight;
  app.renderer.resize(W, H);
  if (model) fitModelToWindow(model);
});

ipcRenderer.on('set-border', () => {
  document.body.style.border = 'none';
});

ipcRenderer.on('set-scale', (_, { scale }) => {
  currentScaleFactor = Math.max((scale || 0.25) / 0.25, 0.2);
  if (model) {
    model.scale.set(baseModelScale * currentScaleFactor);
  }
});

ipcRenderer.on('set-model', (_, { modelPath }) => {
  loadMascotModel(modelPath);
});

ipcRenderer.on('set-drag-shortcut', (_, { enabled }) => {
  dragShortcutEnabled = !!enabled;
  if (!dragShortcutEnabled) {
    endDrag();
    setInteractionArmed(false);
  }
});

loadMascotModel();
setInterval(syncCursorContext, CURSOR_SYNC_MS);
