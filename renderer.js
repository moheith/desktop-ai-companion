const fs   = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');

// Load Cubism Core before anything else
const cubismCode = fs.readFileSync(path.join(__dirname, 'live2dcubismcore.min.js'), 'utf8');
eval(cubismCode);

const PIXI = require('pixi.js');
const { Live2DModel } = require('pixi-live2d-display/cubism4');
window.PIXI = PIXI;

// Read saved scale directly from store so it's correct on every launch
const Store      = require('electron-store');
const store      = new Store();
const savedScale = store.get('scale', 0.25);

let W = window.innerWidth;
let H = window.innerHeight;

const app = new PIXI.Application({
  view:            document.getElementById('canvas'),
  width:           W,
  height:          H,
  backgroundAlpha: 0,
  antialias:       true,
});

let model = null;

(async () => {
  try {
    model = await Live2DModel.from('./model/ai_assistant_model.model3.json');
    app.stage.addChild(model);
    model.anchor.set(0.5, 1.0);
    model.scale.set(savedScale);  // ← correct scale from store, not hardcoded
    model.x = W / 2;
    model.y = H;
  } catch (err) {
    console.error('Model load error:', err);
  }
})();

// ── IPC listeners ─────────────────────────────────────────
ipcRenderer.on('set-border', (_, visible) => {
  document.body.style.border = visible ? '2px dashed red' : 'none';
});

ipcRenderer.on('set-size', (_, { width, height }) => {
  W = width; H = height;
  app.renderer.resize(W, H);
  if (model) { model.x = W / 2; model.y = H; }
});

ipcRenderer.on('set-scale', (_, { scale }) => {
  if (model) model.scale.set(scale);
});