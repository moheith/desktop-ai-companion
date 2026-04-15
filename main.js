const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require('electron');
const Store  = require('electron-store');
const memory = require('./memory');

const store = new Store({
  defaults: {
    mascotX:1261,mascotY:264,mascotWidth:200,mascotHeight:220,
    scale:0.25,mascotVisible:true,clickThrough:true,borderVisible:false,
    alwaysOnTop:true,behindTaskbar:false,
    aiProvider:'ollama',
    ollamaModel:'llama3',ollamaUrl:'http://localhost:11434',
    openaiKey:'',openaiModel:'gpt-4o-mini',
    anthropicKey:'',anthropicModel:'claude-3-5-haiku-20241022',
    geminiKey:'',geminiModel:'gemini-2.0-flash',
    nvidiaKey:'',nvidiaModel:'nvidia/llama-3.1-nemotron-70b-instruct',
    customUrl:'',customKey:'',customModel:'',
    voiceEngine:'system',ttsEnabled:false,sttEnabled:false,
    sttEngine:'openai',sttLanguage:'auto',autoMicStop:true,autoMicSend:true,
    micDeviceId:'',sttSilenceTimeoutMs:1600,sttSensitivity:0.014,
    sttHoldToTalk:false,wakeWordEnabled:false,wakeWordPhrase:'hey mascot',
    sttBilingualBias:'off',sttNoisePreset:'medium',sttMode:'chat',
    wakeEngine:'browser',
    porcupineAccessKey:'',porcupineKeywordPath:'',porcupineSensitivity:0.55,
    wakeWordAliases:'hi mascot, hey buddy',
    wakeFollowupEnabled:true,wakeFollowupMs:12000,wakeListenAfterReply:true,
    wakeRearmAfterSend:false,
    wakeSensitivity:0.008,wakeSpeechWindowMs:1400,wakeSilenceMs:260,
    voiceHudEnabled:true,voiceInterruptEnabled:true,
    voiceIntentRouting:'hybrid',voiceConfirmActions:true,
    voiceCommandTraining:'',ambientNoiseFloor:0,
    micProfiles:{},
    systemVoice:'',
    elevenKey:'',elevenVoiceId:'EXAVITQu4vr4xnSDxMaL',elevenModel:'eleven_turbo_v2_5',
    piperPath:'',piperVoice:'',
    whisperCppPath:'',whisperCppModel:'',
    openaiTTSKey:'',openaiTTSModel:'tts-1',openaiTTSVoice:'nova',
    savedProviders:[],
    chatFontSize:14,theme:'dark',
    mascotModelPath:'model/model 1/ai_assistant_model.model3.json',
    chatHistory:[],
  }
});

let mascot=null, controlPanel=null, tray=null;
let mascotHovering=false;
let mascotDragging=false;
let mascotDragOffset={ x: 0, y: 0 };
let mascotDragTick=null;

function applyWindowLevel() {
  if (!mascot||mascot.isDestroyed()) return;
  if (store.get('behindTaskbar'))    mascot.setAlwaysOnTop(false);
  else if (store.get('alwaysOnTop')) mascot.setAlwaysOnTop(true,'screen-saver');
  else                               mascot.setAlwaysOnTop(false);
}

function syncMascotMouseMode() {
  if (!mascot || mascot.isDestroyed()) return;
  const shouldIgnore = store.get('clickThrough') && !mascotHovering && !mascotDragging;
  mascot.setIgnoreMouseEvents(shouldIgnore, { forward: true });
}

function syncMascotStateToPanel() {
  if (!mascot || mascot.isDestroyed()) return;
  const [x, y] = mascot.getPosition();
  const [width, height] = mascot.getSize();
  controlPanel?.webContents.send('state-update', {
    mascotX: x,
    mascotY: y,
    mascotWidth: width,
    mascotHeight: height,
  });
}

function startMascotDragLoop() {
  if (mascotDragTick) return;
  mascotDragTick = setInterval(() => {
    if (!mascotDragging || !mascot || mascot.isDestroyed()) return;
    const point = screen.getCursorScreenPoint();
    const nextX = Math.round(point.x - mascotDragOffset.x);
    const nextY = Math.round(point.y - mascotDragOffset.y);
    mascot.setPosition(nextX, nextY);
    store.set('mascotX', nextX);
    store.set('mascotY', nextY);
    syncMascotStateToPanel();
  }, 16);
}

function stopMascotDragLoop() {
  if (!mascotDragTick) return;
  clearInterval(mascotDragTick);
  mascotDragTick = null;
}

function createMascot() {
  mascot=new BrowserWindow({
    width:store.get('mascotWidth'),height:store.get('mascotHeight'),
    x:store.get('mascotX'),y:store.get('mascotY'),
    transparent:true,frame:false,skipTaskbar:true,resizable:false,
    webPreferences:{nodeIntegration:true,contextIsolation:false},
  });
  mascot.loadFile('index.html');
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
  controlPanel.loadFile('control.html');
  controlPanel.webContents.on('did-finish-load',()=>{
    controlPanel.webContents.send('init-config',{...store.store,memory:memory.getMemory()});
  });
  controlPanel.on('closed',()=>{controlPanel=null;});
}

function createTray() {
  const icon=nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVQ4T2NkIAIwEqmHgWoGmP7//8+AzQCKDfj/HyqIYQCxBqBrxmYIIYOwBpBiCFEGkGIIKQaQaggpBpBqCCkGkGoIKQaQaghdG0DVBqhqgKoNIG8DVRsAAMqaIRGfLiVnAAAAAElFTkSuQmCC');
  tray=new Tray(icon);tray.setToolTip('Desktop Mascot');
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'Open Control Panel',click:createControlPanel},
    {label:'Show/Hide Mascot',click:()=>{const v=!store.get('mascotVisible');store.set('mascotVisible',v);if(mascot&&!mascot.isDestroyed()){v?mascot.show():mascot.hide();}}},
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
ipcMain.on('toggle-border',(_, val)=>{store.set('borderVisible',val);mascot?.webContents.send('set-border',val);});
ipcMain.on('toggle-always-on-top',(_, val)=>{store.set('alwaysOnTop',val);if(val)store.set('behindTaskbar',false);applyWindowLevel();controlPanel?.webContents.send('state-update',{behindTaskbar:store.get('behindTaskbar')});});
ipcMain.on('toggle-behind-taskbar',(_, val)=>{store.set('behindTaskbar',val);if(val)store.set('alwaysOnTop',false);applyWindowLevel();controlPanel?.webContents.send('state-update',{alwaysOnTop:store.get('alwaysOnTop')});});
ipcMain.on('preview-position',(_, {x,y})=>{
  mascot?.setPosition(x,y);
  syncMascotStateToPanel();
});
ipcMain.on('preview-size',(_, {width,height})=>{
  if(!mascot)return;
  mascot.setSize(width,height);
  mascot.webContents.send('set-size',{width,height});
  syncMascotStateToPanel();
});
ipcMain.on('preview-scale',(_, {scale})=>mascot?.webContents.send('set-scale',{scale}));
ipcMain.on('preview-mascot-model',(_, {modelPath})=>{mascot?.webContents.send('set-model',{modelPath});});
ipcMain.on('mascot-hover-state',(_, { hovered })=>{
  mascotHovering = !!hovered;
  syncMascotMouseMode();
});
ipcMain.on('mascot-drag-start',(_, payload={})=>{
  mascotDragging = true;
  mascotHovering = true;
  mascotDragOffset = {
    x: Number(payload.offsetX) || 0,
    y: Number(payload.offsetY) || 0,
  };
  syncMascotMouseMode();
  startMascotDragLoop();
});
ipcMain.on('mascot-drag-end',()=>{
  mascotDragging = false;
  syncMascotMouseMode();
  stopMascotDragLoop();
  syncMascotStateToPanel();
});
ipcMain.on('save-config',(_, cfg)=>{
  Object.entries(cfg).forEach(([k,v])=>{if(k!=='memory')store.set(k,v);});
  if(cfg.mascotModelPath) mascot?.webContents.send('set-model',{modelPath:cfg.mascotModelPath});
  syncMascotMouseMode();
  controlPanel?.webContents.send('save-confirmed');
});
ipcMain.on('save-chat-history',(_, h)=>store.set('chatHistory',h.slice(-100)));
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
    dragging: mascotDragging,
  };
});
