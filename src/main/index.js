const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require('electron');
const Store  = require('electron-store');
const memory = require('./memory-store');
const { sanitizeChatHistory } = require('../shared/chat-history');
const {
  APP_ROOT,
  DEFAULT_CONFIG,
  MASCOT_STAGE_HEIGHT,
  MASCOT_STAGE_WIDTH,
  normalizeMascotModelPath,
} = require('../shared/app-defaults');

const store = new Store({ defaults: DEFAULT_CONFIG });

let mascot=null, controlPanel=null, tray=null;
let mascotInteractionArmed=false;
let mascotDragging=false;
let mascotDragStartCursor={ x: 0, y: 0 };
let mascotDragStartWindow={ x: 0, y: 0 };
let mascotDragTick=null;

function normalizeMascotWindowState() {
  if (Number(store.get('mascotWidth')) !== MASCOT_STAGE_WIDTH) store.set('mascotWidth', MASCOT_STAGE_WIDTH);
  if (Number(store.get('mascotHeight')) !== MASCOT_STAGE_HEIGHT) store.set('mascotHeight', MASCOT_STAGE_HEIGHT);
  const nextPath = normalizeMascotModelPath(store.get('mascotModelPath'));
  if (nextPath !== store.get('mascotModelPath')) store.set('mascotModelPath', nextPath);
}

function setMascotPosition(x, y, { persist=false } = {}) {
  if (!mascot || mascot.isDestroyed()) return;
  const nextX = Math.round(x);
  const nextY = Math.round(y);
  mascot.setPosition(nextX, nextY);
  if (persist) {
    store.set('mascotX', nextX);
    store.set('mascotY', nextY);
  }
  syncMascotStateToPanel();
}

function applyWindowLevel() {
  if (!mascot||mascot.isDestroyed()) return;
  if (store.get('behindTaskbar'))    mascot.setAlwaysOnTop(false);
  else if (store.get('alwaysOnTop')) mascot.setAlwaysOnTop(true,'screen-saver');
  else                               mascot.setAlwaysOnTop(false);
}

function syncMascotMouseMode() {
  if (!mascot || mascot.isDestroyed()) return;
  const shouldIgnore = store.get('clickThrough')
    && !(store.get('mascotDragShortcutEnabled') && mascotInteractionArmed)
    && !mascotDragging;
  mascot.setIgnoreMouseEvents(shouldIgnore, { forward: true });
}

function syncMascotStateToPanel() {
  if (!mascot || mascot.isDestroyed()) return;
  const [x, y] = mascot.getPosition();
  controlPanel?.webContents.send('state-update', {
    mascotX: x,
    mascotY: y,
  });
}

function startMascotDragLoop() {
  if (mascotDragTick) return;
  mascotDragTick = setInterval(() => {
    if (!mascotDragging || !mascot || mascot.isDestroyed()) return;
    const point = screen.getCursorScreenPoint();
    const nextX = mascotDragStartWindow.x + (point.x - mascotDragStartCursor.x);
    const nextY = mascotDragStartWindow.y + (point.y - mascotDragStartCursor.y);
    setMascotPosition(nextX, nextY, { persist:true });
  }, 16);
}

function stopMascotDragLoop() {
  if (!mascotDragTick) return;
  clearInterval(mascotDragTick);
  mascotDragTick = null;
}

function getDefaultMascotPosition() {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = MASCOT_STAGE_WIDTH;
  const height = MASCOT_STAGE_HEIGHT;
  return {
    x: Math.round(area.x + area.width - width - 48),
    y: Math.round(area.y + area.height - height - 48),
  };
}

function createMascot() {
  normalizeMascotWindowState();
  const width = MASCOT_STAGE_WIDTH;
  const height = MASCOT_STAGE_HEIGHT;
  mascot=new BrowserWindow({
    width,
    height,
    x:store.get('mascotX'),
    y:store.get('mascotY'),
    transparent:true,frame:false,skipTaskbar:true,resizable:false,
    webPreferences:{nodeIntegration:true,contextIsolation:false},
  });
  mascot.loadFile(require('path').join(APP_ROOT, 'index.html'));
  applyWindowLevel();
  syncMascotMouseMode();
  if (!store.get('mascotVisible')) mascot.hide();
  setInterval(()=>{
    if (mascot&&!mascot.isDestroyed()&&mascot.isVisible()&&store.get('alwaysOnTop')&&!store.get('behindTaskbar'))
      mascot.moveTop();
  },1000);
  mascot.on('closed',()=>{
    stopMascotDragLoop();
    mascot=null;
  });
}

function createControlPanel() {
  if (controlPanel&&!controlPanel.isDestroyed()) {
    if (controlPanel.isMinimized()) controlPanel.restore();
    controlPanel.show();controlPanel.focus();controlPanel.moveTop();return;
  }
  controlPanel=new BrowserWindow({
    width:900,height:680,minWidth:780,minHeight:520,
    frame:false,alwaysOnTop:false,resizable:true,skipTaskbar:false,center:true,
    webPreferences:{nodeIntegration:true,contextIsolation:false,nodeIntegrationInSubFrames:true},
  });
  controlPanel.loadFile(require('path').join(APP_ROOT, 'control.html'));
  controlPanel.webContents.on('did-finish-load',()=>{
    const chatHistory=sanitizeChatHistory(store.get('chatHistory',[]));
    if(JSON.stringify(chatHistory)!==JSON.stringify(store.get('chatHistory',[]))){
      store.set('chatHistory',chatHistory);
    }
    controlPanel.webContents.send('init-config',{...store.store,chatHistory,memory:memory.getMemory()});
  });
  controlPanel.on('closed',()=>{controlPanel=null;});
}

function createTray() {
  const icon=nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVQ4T2NkIAIwEqmHgWoGmP7//8+AzQCKDfj/HyqIYQCxBqBrxmYIIYOwBpBiCFEGkGIIKQaQaggpBpBqCCkGkGoIKQaQaghdG0DVBqhqgKoNIG8DVRsAAMqaIRGfLiVnAAAAAElFTkSuQmCC');
  tray=new Tray(icon);tray.setToolTip('Desktop Mascot');
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'Open Control Panel',click:createControlPanel},
    {label:'Show/Hide Mascot',click:()=>{const v=!store.get('mascotVisible');store.set('mascotVisible',v);if(mascot&&!mascot.isDestroyed()){v?mascot.show():mascot.hide();}}},
    {label:'Mascot DevTools',click:()=>mascot?.webContents.openDevTools({mode:'detach'})},
    {type:'separator'},{label:'Quit',click:()=>app.quit()},
  ]));
  tray.on('double-click',createControlPanel);
}

app.whenReady().then(()=>{
  createMascot();createTray();createControlPanel();
  app.on('window-all-closed',e=>e.preventDefault());
});

ipcMain.on('close-panel',   ()=>controlPanel?.close());
ipcMain.on('minimize-panel',()=>controlPanel?.minimize());
ipcMain.on('maximize-panel',()=>{if(!controlPanel)return;controlPanel.isMaximized()?controlPanel.unmaximize():controlPanel.maximize();});
ipcMain.on('toggle-mascot',(_, val)=>{store.set('mascotVisible',val);if(!mascot||mascot.isDestroyed())return;if(val){mascot.show();applyWindowLevel();}else mascot.hide();});
ipcMain.on('toggle-click-through',(_, val)=>{store.set('clickThrough',val);syncMascotMouseMode();});
ipcMain.on('toggle-mascot-drag-shortcut',(_, val)=>{
  store.set('mascotDragShortcutEnabled',val);
  if(!val) mascotInteractionArmed=false;
  mascot?.webContents.send('set-drag-shortcut',{enabled:!!val});
  syncMascotMouseMode();
});
ipcMain.on('toggle-border',(_, val)=>{store.set('borderVisible',val);mascot?.webContents.send('set-border',val);});
ipcMain.on('toggle-always-on-top',(_, val)=>{store.set('alwaysOnTop',val);if(val)store.set('behindTaskbar',false);applyWindowLevel();controlPanel?.webContents.send('state-update',{behindTaskbar:store.get('behindTaskbar')});});
ipcMain.on('toggle-behind-taskbar',(_, val)=>{store.set('behindTaskbar',val);if(val)store.set('alwaysOnTop',false);applyWindowLevel();controlPanel?.webContents.send('state-update',{alwaysOnTop:store.get('alwaysOnTop')});});
ipcMain.on('preview-position',(_, {x,y})=>{
  setMascotPosition(x,y);
});
ipcMain.on('preview-mascot-reset',()=>{
  const pos = getDefaultMascotPosition();
  setMascotPosition(pos.x, pos.y);
  normalizeMascotWindowState();
  mascot?.setSize(MASCOT_STAGE_WIDTH, MASCOT_STAGE_HEIGHT);
  mascot?.webContents.send('set-scale',{scale:0.25});
  controlPanel?.webContents.send('state-update',{mascotScale:0.25});
});
ipcMain.on('preview-scale',(_, {scale})=>mascot?.webContents.send('set-scale',{scale}));
ipcMain.on('preview-mascot-model',(_, {modelPath})=>{mascot?.webContents.send('set-model',{modelPath});});
ipcMain.on('mascot-interaction-arm',(_, { armed })=>{
  mascotInteractionArmed = !!armed;
  syncMascotMouseMode();
});
ipcMain.on('mascot-drag-start',(_, payload={})=>{
  mascotDragging = true;
  mascotInteractionArmed = true;
  const point = screen.getCursorScreenPoint();
  const [x, y] = mascot.getPosition();
  mascotDragStartCursor = { x: point.x, y: point.y };
  mascotDragStartWindow = { x, y };
  syncMascotMouseMode();
  startMascotDragLoop();
});
ipcMain.on('mascot-drag-end',()=>{
  mascotDragging = false;
  mascotInteractionArmed = false;
  syncMascotMouseMode();
  stopMascotDragLoop();
  syncMascotStateToPanel();
});
ipcMain.on('save-config',(_, cfg)=>{
  Object.entries(cfg).forEach(([k,v])=>{
    if(k==='memory' || k==='mascotWidth' || k==='mascotHeight' || k==='width' || k==='height') return;
    if(k==='mascotModelPath'){
      store.set(k,normalizeMascotModelPath(v));
      return;
    }
    store.set(k,v);
  });
  normalizeMascotWindowState();
  mascot?.setSize(MASCOT_STAGE_WIDTH, MASCOT_STAGE_HEIGHT);
  if(cfg.mascotModelPath) mascot?.webContents.send('set-model',{modelPath:normalizeMascotModelPath(cfg.mascotModelPath)});
  if(cfg.mascotDragShortcutEnabled!=null) mascot?.webContents.send('set-drag-shortcut',{enabled:!!cfg.mascotDragShortcutEnabled});
  syncMascotMouseMode();
  controlPanel?.webContents.send('save-confirmed');
});
ipcMain.on('save-chat-history',(_, h)=>store.set('chatHistory',sanitizeChatHistory(h)));
ipcMain.on('clear-chat-history',()=>{store.set('chatHistory',[]);controlPanel?.webContents.send('chat-history-cleared');});
ipcMain.on('memory-set-name',       (_, n)=>memory.setUserName(n));
ipcMain.on('memory-set-personality',(_, t)=>memory.setPersonality(t));
ipcMain.on('memory-add-fact',       (_, f)=>memory.addFact(f));
ipcMain.on('memory-remove-fact',    (_, i)=>memory.removeFact(i));
ipcMain.on('memory-clear-facts',    ()    =>memory.clearFacts());
ipcMain.on('memory-add-summary',    (_, s)=>memory.addConvoSummary(s));
ipcMain.on('memory-clear-all',      ()    =>memory.clearAll());
ipcMain.on('memory-increment',      (_, c)=>memory.incrementMessages(c));
ipcMain.on('memory-update-mood',    (_, t)=>{const m=memory.updateMoodFromUser(t);controlPanel?.webContents.send('mood-changed',m);});
ipcMain.handle('memory-get',      ()=>memory.getMemory());
ipcMain.handle('memory-get-block',()=>memory.buildMemoryBlock());
ipcMain.handle('memory-get-feed', ()=>memory.getMemoryFeed());
ipcMain.handle('memory-get-mood', ()=>({mood:memory.getMood(),def:memory.getMoodDef()}));
ipcMain.handle('get-mascot-context',()=>{
  if(!mascot || mascot.isDestroyed()){
    return { visible:false };
  }
  return {
    visible: mascot.isVisible(),
    bounds: mascot.getBounds(),
    cursor: screen.getCursorScreenPoint(),
    clickThrough: store.get('clickThrough'),
    dragShortcutEnabled: store.get('mascotDragShortcutEnabled'),
    dragging: mascotDragging,
  };
});
