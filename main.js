const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const Store  = require('electron-store');
const memory = require('./memory');

const store = new Store({
  defaults: {
    mascotX:       1261,
    mascotY:       264,
    mascotWidth:   200,
    mascotHeight:  220,
    scale:         0.25,
    mascotVisible: true,
    clickThrough:  true,
    borderVisible: false,
    alwaysOnTop:   true,
    behindTaskbar: false,
    ollamaModel:   'llama3',
    chatHistory:   [],
    piperPath:     '',       // path to piper.exe e.g. C:\piper\piper.exe
    piperVoice:    '',       // path to .onnx voice model
    ttsEnabled:    false,
    sttEnabled:    false,
  }
});

let mascot       = null;
let controlPanel = null;
let tray         = null;

// ── helpers ───────────────────────────────────────────────
function applyWindowLevel() {
  if (!mascot || mascot.isDestroyed()) return;
  if (store.get('behindTaskbar')) {
    mascot.setAlwaysOnTop(false);
  } else if (store.get('alwaysOnTop')) {
    mascot.setAlwaysOnTop(true, 'screen-saver');
  } else {
    mascot.setAlwaysOnTop(false);
  }
}

// ── mascot window ─────────────────────────────────────────
function createMascot() {
  mascot = new BrowserWindow({
    width:       store.get('mascotWidth'),
    height:      store.get('mascotHeight'),
    x:           store.get('mascotX'),
    y:           store.get('mascotY'),
    transparent: true,
    frame:       false,
    skipTaskbar: true,
    resizable:   false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  mascot.loadFile('index.html');
  applyWindowLevel();
  mascot.setIgnoreMouseEvents(store.get('clickThrough'), { forward: true });
  if (!store.get('mascotVisible')) mascot.hide();

  // BUG FIX: check isVisible() before moveTop() to prevent flicker on hide
  setInterval(() => {
    if (
      mascot && !mascot.isDestroyed() &&
      mascot.isVisible() &&                     // ← key fix
      store.get('alwaysOnTop') &&
      !store.get('behindTaskbar')
    ) {
      mascot.moveTop();
    }
  }, 1000);

  mascot.on('closed', () => { mascot = null; });
}

// ── control panel ─────────────────────────────────────────
function createControlPanel() {
  if (controlPanel && !controlPanel.isDestroyed()) {
    if (controlPanel.isMinimized()) controlPanel.restore();
    controlPanel.show();
    controlPanel.focus();
    controlPanel.moveTop();
    return;
  }

  controlPanel = new BrowserWindow({
    width:       480,
    height:      760,
    minWidth:    420,
    minHeight:   520,
    frame:       false,
    alwaysOnTop: false,
    resizable:   true,
    skipTaskbar: false,
    center:      true,
    webPreferences: {
      nodeIntegration:            true,
      contextIsolation:           false,
      nodeIntegrationInSubFrames: true,
    },
  });

  controlPanel.loadFile('control.html');

  controlPanel.webContents.on('did-finish-load', () => {
    controlPanel.webContents.send('init-config', {
      x:             store.get('mascotX'),
      y:             store.get('mascotY'),
      width:         store.get('mascotWidth'),
      height:        store.get('mascotHeight'),
      scale:         store.get('scale'),
      mascotVisible: store.get('mascotVisible'),
      clickThrough:  store.get('clickThrough'),
      borderVisible: store.get('borderVisible'),
      alwaysOnTop:   store.get('alwaysOnTop'),
      behindTaskbar: store.get('behindTaskbar'),
      ollamaModel:   store.get('ollamaModel'),
      piperPath:     store.get('piperPath'),
      piperVoice:    store.get('piperVoice'),
      ttsEnabled:    store.get('ttsEnabled'),
      sttEnabled:    store.get('sttEnabled'),
      chatHistory:   store.get('chatHistory'),
      memory:        memory.getMemory(),
    });
  });

  controlPanel.on('minimize', () => { /* OS handles */ });
  controlPanel.on('restore',  () => { controlPanel.focus(); });
  controlPanel.on('closed',   () => { controlPanel = null; });
}

// ── tray ──────────────────────────────────────────────────
function createTray() {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVQ4T2NkIAIwEqmHgWoGmP7//8+AzQCKDfj/HyqIYQCxBqBrxmYIIYOwBpBiCFEGkGIIKQaQaggpBpBqCCkGkGoIKQaQaghdG0DVBqhqgKoNIG8DVRsAAMqaIRGfLiVnAAAAAElFTkSuQmCC'
  );
  tray = new Tray(icon);
  tray.setToolTip('Desktop Mascot');
  const menu = Menu.buildFromTemplate([
    { label: 'Open Control Panel', click: createControlPanel },
    { label: 'Show/Hide Mascot', click: () => {
      const v = !store.get('mascotVisible');
      store.set('mascotVisible', v);
      if (mascot && !mascot.isDestroyed()) { v ? mascot.show() : mascot.hide(); }
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', createControlPanel);
}

// ── app ready ─────────────────────────────────────────────
app.whenReady().then(() => {
  createMascot();
  createTray();
  createControlPanel();
  app.on('window-all-closed', e => e.preventDefault());
});

// ── IPC: panel controls ───────────────────────────────────
ipcMain.on('close-panel',    () => { if (controlPanel && !controlPanel.isDestroyed()) controlPanel.close(); });
ipcMain.on('minimize-panel', () => { if (controlPanel && !controlPanel.isDestroyed()) controlPanel.minimize(); });
ipcMain.on('maximize-panel', () => {
  if (!controlPanel || controlPanel.isDestroyed()) return;
  controlPanel.isMaximized() ? controlPanel.unmaximize() : controlPanel.maximize();
});

// ── IPC: mascot toggles ───────────────────────────────────
ipcMain.on('toggle-mascot', (_, val) => {
  store.set('mascotVisible', val);
  if (!mascot || mascot.isDestroyed()) return;
  if (val) {
    mascot.show();
    applyWindowLevel();     // re-apply level after showing
  } else {
    mascot.hide();
  }
});
ipcMain.on('toggle-click-through', (_, val) => {
  store.set('clickThrough', val);
  if (mascot && !mascot.isDestroyed()) mascot.setIgnoreMouseEvents(val, { forward: true });
});
ipcMain.on('toggle-border', (_, val) => {
  store.set('borderVisible', val);
  if (mascot && !mascot.isDestroyed()) mascot.webContents.send('set-border', val);
});
ipcMain.on('toggle-always-on-top', (_, val) => {
  store.set('alwaysOnTop', val);
  if (val) store.set('behindTaskbar', false);
  applyWindowLevel();
  if (controlPanel && !controlPanel.isDestroyed())
    controlPanel.webContents.send('state-update', { behindTaskbar: store.get('behindTaskbar') });
});
ipcMain.on('toggle-behind-taskbar', (_, val) => {
  store.set('behindTaskbar', val);
  if (val) store.set('alwaysOnTop', false);
  applyWindowLevel();
  if (controlPanel && !controlPanel.isDestroyed())
    controlPanel.webContents.send('state-update', { alwaysOnTop: store.get('alwaysOnTop') });
});

// ── IPC: live preview ─────────────────────────────────────
ipcMain.on('preview-position', (_, { x, y }) => {
  if (mascot && !mascot.isDestroyed()) mascot.setPosition(x, y);
});
ipcMain.on('preview-size', (_, { width, height }) => {
  if (mascot && !mascot.isDestroyed()) {
    mascot.setSize(width, height);
    mascot.webContents.send('set-size', { width, height });
  }
});
ipcMain.on('preview-scale', (_, { scale }) => {
  if (mascot && !mascot.isDestroyed()) mascot.webContents.send('set-scale', { scale });
});

// ── IPC: save settings ────────────────────────────────────
ipcMain.on('save-config', (_, cfg) => {
  store.set('mascotX',       cfg.x);
  store.set('mascotY',       cfg.y);
  store.set('mascotWidth',   cfg.width);
  store.set('mascotHeight',  cfg.height);
  store.set('scale',         cfg.scale);
  store.set('mascotVisible', cfg.mascotVisible);
  store.set('clickThrough',  cfg.clickThrough);
  store.set('borderVisible', cfg.borderVisible);
  store.set('alwaysOnTop',   cfg.alwaysOnTop);
  store.set('behindTaskbar', cfg.behindTaskbar);
  store.set('ollamaModel',   cfg.ollamaModel || 'llama3');
  store.set('piperPath',     cfg.piperPath   || '');
  store.set('piperVoice',    cfg.piperVoice  || '');
  store.set('ttsEnabled',    cfg.ttsEnabled  || false);
  store.set('sttEnabled',    cfg.sttEnabled  || false);
  if (controlPanel && !controlPanel.isDestroyed())
    controlPanel.webContents.send('save-confirmed');
});

// ── IPC: chat history ─────────────────────────────────────
ipcMain.on('save-chat-history', (_, history) => {
  store.set('chatHistory', history.slice(-50));
});
ipcMain.on('clear-chat-history', () => {
  store.set('chatHistory', []);
  if (controlPanel && !controlPanel.isDestroyed())
    controlPanel.webContents.send('chat-history-cleared');
});

// ── IPC: memory ───────────────────────────────────────────
ipcMain.on('memory-set-name',        (_, name)    => memory.setUserName(name));
ipcMain.on('memory-set-personality', (_, text)    => memory.setPersonality(text));
ipcMain.on('memory-add-fact',        (_, fact)    => memory.addFact(fact));
ipcMain.on('memory-remove-fact',     (_, index)   => memory.removeFact(index));
ipcMain.on('memory-clear-facts',     ()           => memory.clearFacts());
ipcMain.on('memory-add-summary',     (_, summary) => memory.addConvoSummary(summary));
ipcMain.on('memory-clear-all',       ()           => memory.clearAll());
ipcMain.on('memory-increment',       (_, count)   => memory.incrementMessages(count));

ipcMain.handle('memory-get', () => memory.getMemory());
ipcMain.handle('memory-get-block', () => memory.buildMemoryBlock());