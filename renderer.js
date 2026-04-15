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
const savedScale = store.get('scale', 0.25);
const defaultModelPath = store.get('mascotModelPath', 'model/model 1/ai_assistant_model.model3.json');
const scaleFactor = Math.max(savedScale / 0.25, 0.2);

let W = window.innerWidth;
let H = window.innerHeight;

const app = new PIXI.Application({
  view: document.getElementById('canvas'),
  width: W,
  height: H,
  backgroundAlpha: 0,
  antialias: true,
});

let model = null;
let baseModelScale = 1;

function fitModelToWindow(target){
  const width = Math.max(
    target.internalModel?.width || target.internalModel?.originalWidth || target.width || 0,
    1
  );
  const height = Math.max(
    target.internalModel?.height || target.internalModel?.originalHeight || target.height || 0,
    1
  );
  baseModelScale = Math.min((W * 0.78) / width, (H * 0.92) / height);
  target.scale.set(baseModelScale * scaleFactor);
  target.anchor.set(0.5, 1.0);
  target.x = W / 2;
  target.y = H;
}

async function loadMascotModel(modelPath = defaultModelPath) {
  try {
    const resolved = String(modelPath || defaultModelPath).replace(/\\/g, '/');
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

loadMascotModel();

ipcRenderer.on('set-border', (_, visible) => {
  document.body.style.border = visible ? '2px dashed red' : 'none';
});

ipcRenderer.on('set-size', (_, { width, height }) => {
  W = width;
  H = height;
  app.renderer.resize(W, H);
  if (model) fitModelToWindow(model);
});

ipcRenderer.on('set-scale', (_, { scale }) => {
  if (!model) return;
  const factor = Math.max((scale || 0.25) / 0.25, 0.2);
  model.scale.set(baseModelScale * factor);
});

ipcRenderer.on('set-model', (_, { modelPath }) => {
  loadMascotModel(modelPath);
});
