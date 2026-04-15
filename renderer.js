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

let W = window.innerWidth;
let H = window.innerHeight;
let currentScaleFactor = Math.max((store.get('scale', 0.25) || 0.25) / 0.25, 0.2);
let baseModelScale = 1;
let model = null;
let hoverActive = false;
let dragActive = false;
let pointerDown = false;
let dragHoldTimer = null;
let pointerOffset = { x: 0, y: 0 };
let cursorLocal = { x: W / 2, y: H / 2 };
let syncInFlight = false;

const app = new PIXI.Application({
  view: document.getElementById('canvas'),
  width: W,
  height: H,
  backgroundAlpha: 0,
  antialias: true,
});

app.stage.sortableChildren = true;

function clearDragHoldTimer() {
  if (!dragHoldTimer) return;
  clearTimeout(dragHoldTimer);
  dragHoldTimer = null;
}

function updateCursorStyle() {
  document.body.style.cursor = dragActive ? 'grabbing' : (hoverActive ? 'grab' : 'default');
}

function setHoverState(nextHover) {
  const changed = hoverActive !== nextHover;
  hoverActive = nextHover;
  if (model) {
    model.alpha = hoverActive ? HOVER_ALPHA : 1;
  }
  if (changed) {
    ipcRenderer.send('mascot-hover-state', { hovered: hoverActive });
    updateCursorStyle();
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
  target.alpha = hoverActive ? HOVER_ALPHA : 1;
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
  pointerDown = false;
  if (dragActive) {
    dragActive = false;
    ipcRenderer.send('mascot-drag-end');
  }
  updateCursorStyle();
}

function beginDragIfStillHeld() {
  if (!pointerDown || !hoverActive || dragActive) return;
  dragActive = true;
  ipcRenderer.send('mascot-drag-start', {
    offsetX: pointerOffset.x,
    offsetY: pointerOffset.y,
  });
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

    cursorLocal = {
      x: ctx.cursor.x - ctx.bounds.x,
      y: ctx.cursor.y - ctx.bounds.y,
    };

    try {
      model.focus(cursorLocal.x, cursorLocal.y, false);
    } catch {}

    setHoverState(pointWithinModel(cursorLocal.x, cursorLocal.y) || dragActive);
  } catch (err) {
    console.error('Mascot cursor sync error:', err);
  } finally {
    syncInFlight = false;
  }
}

document.addEventListener('pointerdown', (event) => {
  if (!hoverActive || !model) return;
  pointerDown = true;
  pointerOffset = { x: event.clientX, y: event.clientY };
  clearDragHoldTimer();
  dragHoldTimer = setTimeout(beginDragIfStillHeld, DRAG_HOLD_MS);
});

document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);
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

ipcRenderer.on('set-size', (_, { width, height }) => {
  W = width;
  H = height;
  app.renderer.resize(W, H);
  if (model) fitModelToWindow(model);
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

loadMascotModel();
setInterval(syncCursorContext, CURSOR_SYNC_MS);
