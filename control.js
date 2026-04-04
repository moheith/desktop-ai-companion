const { ipcRenderer, shell: electronShell } = require('electron');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { exec, execFile } = require('child_process');
let Porcupine=null, PvRecorder=null;
try{
  ({ Porcupine } = require('@picovoice/porcupine-node'));
  ({ PvRecorder } = require('@picovoice/pvrecorder-node'));
}catch{}

// ─── Splash ───────────────────────────────────────────────
const splashBar = document.getElementById('splash-bar');
let splashPct   = 0;
let splashDone  = false;
const splashInt = setInterval(() => {
  splashPct = Math.min(splashPct + (splashPct < 70 ? 2.5 : 0.8), 98);
  splashBar.style.width = splashPct + '%';
}, 40);

function finishSplash() {
  if(splashDone) return;
  splashDone = true;
  clearInterval(splashInt);
  splashBar.style.width = '100%';
  setTimeout(() => {
    document.getElementById('splash').classList.add('fade-out');
    document.getElementById('app').classList.add('visible');
  }, 300);
}

// Safety fallback — if init-config never fires, show the app anyway after 4s
setTimeout(finishSplash, 4000);

// ─── Live2D (non-blocking background load) ───────────────
let chatModel=null, chatPixiApp=null;
setTimeout(async function loadLive2D() {
  try {
    new Function(fs.readFileSync(path.join(__dirname,'live2dcubismcore.min.js'),'utf8'))();
    const PIXI=require('pixi.js'); window.PIXI=PIXI;
    const {Live2DModel}=require('pixi-live2d-display/cubism4');
    const W=54,H=62,canvas=document.getElementById('char-canvas');
    if(!canvas) return;
    canvas.width=W;canvas.height=H;
    chatPixiApp=new PIXI.Application({view:canvas,width:W,height:H,backgroundAlpha:0,antialias:true});
    chatModel=await Live2DModel.from('./model/ai_assistant_model.model3.json');
    chatPixiApp.stage.addChild(chatModel);
    chatModel.anchor.set(0.5,1.0);chatModel.scale.set(0.042);
    chatModel.x=W/2;chatModel.y=H;
  } catch(e){console.error('[Live2D]',e);}
}, 100);

// ─── State ────────────────────────────────────────────────
let cfg={
  aiProvider:'ollama',ollamaModel:'llama3',ollamaUrl:'http://localhost:11434',
  openaiKey:'',openaiModel:'gpt-4o-mini',
  anthropicKey:'',anthropicModel:'claude-3-5-haiku-20241022',
  geminiKey:'',geminiModel:'gemini-2.0-flash',
  nvidiaKey:'',nvidiaModel:'nvidia/llama-3.1-nemotron-70b-instruct',
  customUrl:'',customKey:'',customModel:'',
  voiceEngine:'system',ttsEnabled:false,sttEnabled:false,systemVoice:'',
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
  elevenKey:'',elevenVoiceId:'EXAVITQu4vr4xnSDxMaL',elevenModel:'eleven_turbo_v2_5',
  piperPath:'',piperVoice:'',
  whisperCppPath:'',whisperCppModel:'',
  chatFontSize:14,theme:'dark',
  mascotVisible:true,clickThrough:true,borderVisible:false,alwaysOnTop:true,behindTaskbar:false,
  mascotX:1261,mascotY:264,mascotWidth:200,mascotHeight:220,scale:0.25,
};
let mem={userName:'',userFacts:[],personality:'',convoSummaries:[],totalMessages:0,currentMood:'neutral',memoryFeed:[]};
let chatHistory=[],isThinking=false,isListening=false;
let ttsQueue=[],ttsBusy=false,synthVoices=[],preferredVoice=null;
let selectedElevenVoiceId='',currentFontSize=14;
let currentPage='home',currentProviderTab='ollama',currentVoiceEngine='system';
let availableMics=[],pendingTranscript='';
let lastVoiceCommand='';
let wakeMonitorStream=null,wakeMonitorContext=null,wakeMonitorSource=null,wakeMonitorProcessor=null,wakeMonitorSilencer=null;
let wakeMonitorChunks=[],wakeMonitorSpeechMs=0,wakeMonitorSilenceMs=0,wakeMonitorHeardSpeech=false,wakeMonitorTranscribing=false;
let porcupineHandle=null, porcupineRecorder=null, porcupineLoopActive=false, porcupineRestartTimer=null;
let micInputSnapshot='';
let lastVoiceIntent=null,voiceSessionUntil=0,voiceSessionPrimed=false,voiceListeningMode='manual',wakeResumeTimer=null;
let pendingFollowupAfterSpeech=false,awaitingFollowup=false,followupArmUntil=0,followupTimeoutTimer=null;
let lastWakeTriggerAt=0;
const WAKE_TRIGGER_COOLDOWN_MS=2500;
const WAKE_MIN_SPEECH_MS=320;
const WAKE_HISTORY_LIMIT=8;
let listeningStartedAt=0;
let wakeListeningStartedAt=0;
let wakeMonitorPreview='Listening for wake phrase...';
let wakeHistory=[];
const MIC_RESET_DEFAULTS={
  sttEnabled:false,
  sttEngine:'openai',
  sttLanguage:'auto',
  autoMicStop:true,
  autoMicSend:true,
  micDeviceId:'',
  sttSilenceTimeoutMs:1600,
  sttSensitivity:0.014,
  sttHoldToTalk:false,
  wakeWordEnabled:false,
  wakeWordPhrase:'hey mascot',
  wakeEngine:'browser',
  sttBilingualBias:'off',
  sttNoisePreset:'medium',
  sttMode:'chat',
  wakeWordAliases:'hi mascot, hey buddy',
  wakeFollowupEnabled:true,
  wakeFollowupMs:12000,
  wakeListenAfterReply:true,
  wakeSensitivity:0.008,
  wakeSpeechWindowMs:1400,
  wakeSilenceMs:260,
  voiceHudEnabled:true,
  voiceInterruptEnabled:true,
  voiceIntentRouting:'hybrid',
  voiceConfirmActions:true,
  voiceCommandTraining:'',
  ambientNoiseFloor:0,
};

// ─── Init ─────────────────────────────────────────────────
ipcRenderer.on('init-config',(_, s)=>{
  Object.assign(cfg,s);
  if(s.memory) Object.assign(mem,s.memory);
  applyConfig();
  finishSplash();
  checkOllamaStatus();
  loadSystemVoices();
  updateHomeCards();
  renderMemoryPage();
  updateMoodUI(mem.currentMood||'neutral');
});

ipcRenderer.on('state-update',(_,u)=>{
  if(u.alwaysOnTop!=null){cfg.alwaysOnTop=u.alwaysOnTop;document.getElementById('tog-ontop').checked=cfg.alwaysOnTop;}
  if(u.behindTaskbar!=null){cfg.behindTaskbar=u.behindTaskbar;document.getElementById('tog-taskbar').checked=cfg.behindTaskbar;}
});
ipcRenderer.on('save-confirmed',()=>flash('mascot-save-ok'));
ipcRenderer.on('chat-history-cleared',()=>{chatHistory=[];clearChatUI();});
ipcRenderer.on('mood-changed',(_,mood)=>updateMoodUI(mood));

function applyConfig(){
  // Load saved providers
  savedProviders=cfg.savedProviders||[];
  renderSavedProviders();
  // AI
  setProviderTab(cfg.aiProvider||'ollama');
  setEl('ollama-url',cfg.ollamaUrl);
  setEl('openai-key',cfg.openaiKey);setEl('openai-model',cfg.openaiModel);
  setEl('anthropic-key',cfg.anthropicKey);setEl('anthropic-model',cfg.anthropicModel);
  setEl('gemini-key',cfg.geminiKey);setEl('gemini-model',cfg.geminiModel);
  setEl('nvidia-key',cfg.nvidiaKey);setEl('nvidia-model',cfg.nvidiaModel);
  // Voice
  setVoiceEngine(cfg.voiceEngine||'system');
  ck('tog-tts',cfg.ttsEnabled);ck('tog-stt',cfg.sttEnabled);
  setEl('stt-engine',cfg.sttEngine||'openai');
  setEl('stt-language',cfg.sttLanguage||'auto');
  ck('tog-stt-auto-stop',cfg.autoMicStop!==false);
  ck('tog-stt-auto-send',cfg.autoMicSend!==false);
  ck('tog-stt-hold',!!cfg.sttHoldToTalk);
  ck('tog-stt-wake',!!cfg.wakeWordEnabled);
  setEl('stt-wake-word',cfg.wakeWordPhrase||'hey mascot');
  setEl('wake-engine',cfg.wakeEngine||'browser');
  setEl('stt-wake-aliases',cfg.wakeWordAliases||'');
  setEl('porcupine-access-key',cfg.porcupineAccessKey||'');
  setEl('porcupine-keyword-path',cfg.porcupineKeywordPath||'');
  setEl('porcupine-sensitivity',cfg.porcupineSensitivity||0.55);
  tv('porcupine-sensitivity-val',Number(cfg.porcupineSensitivity||0.55).toFixed(2));
  setEl('stt-bilingual-bias',cfg.sttBilingualBias||'off');
  setEl('stt-noise-preset',cfg.sttNoisePreset||'medium');
  setEl('stt-mode',cfg.sttMode||'chat');
  setEl('stt-silence-timeout',cfg.sttSilenceTimeoutMs||1600);
  tv('stt-silence-timeout-val',`${Math.round((cfg.sttSilenceTimeoutMs||1600)/100)/10}s`);
  setEl('stt-sensitivity',cfg.sttSensitivity||0.014);
  tv('stt-sensitivity-val',Number(cfg.sttSensitivity||0.014).toFixed(3));
  setEl('wake-sensitivity',cfg.wakeSensitivity||0.010);
  tv('wake-sensitivity-val',Number(cfg.wakeSensitivity||0.010).toFixed(3));
  setEl('wake-window-ms',cfg.wakeSpeechWindowMs||2200);
  tv('wake-window-ms-val',`${Math.round((cfg.wakeSpeechWindowMs||2200)/100)/10}s`);
  setEl('wake-followup-ms',cfg.wakeFollowupMs||12000);
  tv('wake-followup-ms-val',`${Math.round((cfg.wakeFollowupMs||12000)/1000)}s`);
  ck('tog-wake-followup',cfg.wakeFollowupEnabled!==false);
  ck('tog-wake-listen-reply',cfg.wakeListenAfterReply!==false);
  ck('tog-wake-rearm-send',cfg.wakeRearmAfterSend===true);
  ck('tog-voice-hud',cfg.voiceHudEnabled!==false);
  ck('tog-voice-interrupt',cfg.voiceInterruptEnabled!==false);
  ck('tog-voice-confirm',cfg.voiceConfirmActions!==false);
  setEl('voice-intent-routing',cfg.voiceIntentRouting||'hybrid');
  setEl('voice-command-training',cfg.voiceCommandTraining||'');
  applyDeviceProfile(cfg.micDeviceId||'',false);
  setEl('eleven-key',cfg.elevenKey);setEl('eleven-model',cfg.elevenModel);
  setEl('piper-path',cfg.piperPath);setEl('piper-voice',cfg.piperVoice);
  setEl('whispercpp-path',cfg.whisperCppPath||'');
  setEl('whispercpp-model',cfg.whisperCppModel||'');
  setEl('openai-tts-key',cfg.openaiTTSKey||cfg.openaiKey||'');
  setEl('openai-tts-model',cfg.openaiTTSModel||'tts-1');
  openAITTSVoice=cfg.openaiTTSVoice||'nova';
  document.querySelectorAll('[data-oai-voice]').forEach(el=>{
    el.classList.toggle('selected',el.dataset.oaiVoice===openAITTSVoice);
  });
  selectedElevenVoiceId=cfg.elevenVoiceId||'';
  // Mascot
  setEl('pos-x',cfg.mascotX);setEl('pos-y',cfg.mascotY);
  setEl('win-w',cfg.mascotWidth);setEl('win-h',cfg.mascotHeight);
  setEl('scale-slider',cfg.scale);tv('scale-val',cfg.scale?.toFixed(2)||'0.25');
  ck('tog-mascot',cfg.mascotVisible);ck('tog-click',cfg.clickThrough);
  ck('tog-border',cfg.borderVisible);ck('tog-ontop',cfg.alwaysOnTop);ck('tog-taskbar',cfg.behindTaskbar);
  // Chat font
  renderWakeHistory();
  currentFontSize=cfg.chatFontSize||14;
  tv('font-size-display',currentFontSize);tv('font-size-val',currentFontSize+'px');
  setEl('font-size-slider',currentFontSize);
  applyChatFont();
  // Theme
  if(cfg.theme) applyTheme(cfg.theme);
  // Badge
  tv('mbadge',getModelLabel());
  // Chat history
  if(cfg.chatHistory?.length>0){
    chatHistory=cfg.chatHistory;
    chatHistory.forEach(m=>renderMsg(m.role==='user'?'user':'ai',m.content,false));
    scrollChat();
  }
  // STT
  setupMic();
  updateSTTUI();
  updateVoiceDashboard();
  loadMicDevices();
  setupWakeWordListener();
}

function getModelLabel(){
  switch(cfg.aiProvider){
    case 'ollama':    return cfg.ollamaModel||'llama3';
    case 'openai':    return cfg.openaiModel||'gpt-4o-mini';
    case 'anthropic': return cfg.anthropicModel||'claude';
    case 'gemini':    return cfg.geminiModel||'gemini';
    case 'nvidia':    return (cfg.nvidiaModel||'').split('/').pop()||'nvidia';
    case 'custom':    return cfg.customModel||'custom';
    default: return '—';
  }
}

// ─── Navigation ───────────────────────────────────────────
function switchPage(pg){
  currentPage=pg;
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.page===pg));
  document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id===`page-${pg}`));
  if(pg==='chat'){checkOllamaStatus();setTimeout(scrollChat,100);}
  if(pg==='home')updateHomeCards();
  if(pg==='memory')renderMemoryPage();
  if(pg==='mic'){updateSTTUI();ensureWakeListenerArmed();}
}
document.querySelectorAll('.nav-item').forEach(n=>n.onclick=()=>switchPage(n.dataset.page));

function setupSplitSettingsPages(){
  const micSlot=document.getElementById('mic-page-slot');
  const micCard=document.getElementById('mic-settings-card');
  const micSaveRow=document.getElementById('mic-save-row');
  if(micCard){
    const micBody=micCard.querySelector('.card-body');
    const micHeader=micCard.querySelector('.card-header');
    if(micHeader){
      micHeader.innerHTML=`Microphone - Powered by Whisper
        <span class="tag tag-green" style="font-size:9px;text-transform:none;letter-spacing:0;">Push-to-Talk</span>`;
    }
    if(micBody && !micBody.dataset.simplified){
      micBody.dataset.simplified='true';
      micBody.innerHTML=`
        <div class="trow" style="margin-bottom:14px;">
          <div class="tl">
            <span class="tl-n">Enable Microphone</span>
            <span class="tl-d">Manual mic, wake word, and local transcription all start from here.</span>
          </div>
          <label class="toggle"><input type="checkbox" id="tog-stt"/><div class="track"><div class="thumb"></div></div></label>
        </div>

        <div class="hint" style="margin-bottom:12px;">
          Use <b>Basic</b> for normal setup, <b>Advanced</b> for wake tuning, and <b>Diagnostics</b> when you need to debug what the wake listener heard.
        </div>

        <div class="card-header" style="margin:-2px 0 10px;">Basic</div>
        <div class="card-grid cols2" style="margin-bottom:12px;">
          <div class="field">
            <label>Speech Engine</label>
            <select class="inp" id="stt-engine">
              <option value="local">Local whisper.cpp</option>
              <option value="openai">OpenAI Whisper</option>
            </select>
          </div>
          <div class="field">
            <label>Language</label>
            <select class="inp" id="stt-language">
              <option value="auto">Auto detect</option>
              <option value="en">English</option>
              <option value="hi">Hindi</option>
            </select>
          </div>
        </div>

        <div class="card-grid cols2" style="margin-bottom:12px;">
          <div class="field">
            <label>Microphone Device</label>
            <select class="inp" id="stt-device">
              <option value="">System default microphone</option>
            </select>
          </div>
          <div class="field">
            <label>Language Bias</label>
            <select class="inp" id="stt-bilingual-bias">
              <option value="off">No bias</option>
              <option value="hi-en">Hindi + English</option>
              <option value="en-first">Mostly English</option>
              <option value="hi-first">Mostly Hindi</option>
            </select>
          </div>
        </div>

        <div class="card-grid cols2" style="margin-bottom:12px;">
          <div class="field">
            <label>Silence Timeout</label>
            <div class="slider-row" style="gap:4px;">
              <div class="slider-top"><span class="slider-label">Auto-stop delay</span><span class="slider-val" id="stt-silence-timeout-val">1.6s</span></div>
              <input type="range" id="stt-silence-timeout" min="800" max="3500" step="100" value="1600"/>
            </div>
          </div>
          <div class="field">
            <label>Mic Sensitivity</label>
            <div class="slider-row" style="gap:4px;">
              <div class="slider-top"><span class="slider-label">Speech threshold</span><span class="slider-val" id="stt-sensitivity-val">0.014</span></div>
              <input type="range" id="stt-sensitivity" min="0.006" max="0.040" step="0.001" value="0.014"/>
            </div>
          </div>
        </div>

        <div class="card-grid cols2" style="margin-bottom:12px;">
          <div class="card" style="margin-bottom:0;">
            <div class="card-body">
              <div class="trow">
                <div class="tl">
                  <span class="tl-n">Press and hold to talk</span>
                  <span class="tl-d">Use hold-to-talk instead of click-to-toggle.</span>
                </div>
                <label class="toggle"><input type="checkbox" id="tog-stt-hold"/><div class="track"><div class="thumb"></div></div></label>
              </div>
            </div>
          </div>
          <div class="card" style="margin-bottom:0;">
            <div class="card-body">
              <div class="trow">
                <div class="tl">
                  <span class="tl-n">Enable wake word</span>
                  <span class="tl-d">Hands-free trigger that beeps, then starts the normal recording flow.</span>
                </div>
                <label class="toggle"><input type="checkbox" id="tog-stt-wake"/><div class="track"><div class="thumb"></div></div></label>
              </div>
            </div>
          </div>
        </div>

        <div class="card-grid cols2" style="margin-bottom:12px;">
          <div class="card" style="margin-bottom:0;">
            <div class="card-body">
              <div class="trow">
                <div class="tl">
                  <span class="tl-n">Auto-stop on silence</span>
                  <span class="tl-d">Stop recording after you finish speaking.</span>
                </div>
                <label class="toggle"><input type="checkbox" id="tog-stt-auto-stop" checked/><div class="track"><div class="thumb"></div></div></label>
              </div>
            </div>
          </div>
          <div class="card" style="margin-bottom:0;">
            <div class="card-body">
              <div class="trow">
                <div class="tl">
                  <span class="tl-n">Auto-send transcript</span>
                  <span class="tl-d">Send the transcribed text immediately after capture.</span>
                </div>
                <label class="toggle"><input type="checkbox" id="tog-stt-auto-send" checked/><div class="track"><div class="thumb"></div></div></label>
              </div>
            </div>
          </div>
        </div>

        <div class="card-header" style="margin:8px 0 10px;">Advanced</div>
        <div class="card-grid cols2" style="margin-bottom:12px;">
          <div class="field">
            <label>Wake Phrase</label>
            <input class="inp" id="stt-wake-word" placeholder="hey mascot"/>
          </div>
          <div class="field">
            <label>Wake Engine</label>
            <select class="inp" id="wake-engine">
              <option value="browser">Built-in local wake</option>
              <option value="porcupine">Porcupine (advanced)</option>
            </select>
          </div>
        </div>

        <div class="card-grid cols2" style="margin-bottom:12px;">
          <div class="field">
            <label>Mode</label>
            <select class="inp" id="stt-mode">
              <option value="chat">Chat mode</option>
              <option value="command">Command mode</option>
            </select>
          </div>
          <div class="field">
            <label>Noise Suppression</label>
            <select class="inp" id="stt-noise-preset">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
        </div>

        <div class="card-grid cols2" style="margin-bottom:12px;">
          <div class="field">
            <label>Wake Aliases</label>
            <input class="inp" id="stt-wake-aliases" placeholder="hi mascot, hey buddy"/>
          </div>
          <div class="field">
            <label>Intent Routing</label>
            <select class="inp" id="voice-intent-routing">
              <option value="hybrid">Hybrid</option>
              <option value="rules">Rules only</option>
              <option value="off">Off</option>
            </select>
          </div>
        </div>

        <div class="card-grid cols2" style="margin-bottom:12px;">
          <div class="field">
            <label>Wake Speech Threshold</label>
            <div class="slider-row" style="gap:4px;">
              <div class="slider-top"><span class="slider-label">Trigger threshold</span><span class="slider-val" id="wake-sensitivity-val">0.008</span></div>
              <input type="range" id="wake-sensitivity" min="0.005" max="0.030" step="0.001" value="0.008"/>
            </div>
          </div>
          <div class="field">
            <label>Wake Speech Window</label>
            <div class="slider-row" style="gap:4px;">
              <div class="slider-top"><span class="slider-label">Max phrase length</span><span class="slider-val" id="wake-window-ms-val">1.4s</span></div>
              <input type="range" id="wake-window-ms" min="800" max="2600" step="100" value="1400"/>
            </div>
          </div>
        </div>

        <div class="card-grid cols2" style="margin-bottom:12px;">
          <div class="field">
            <label>Wake Follow-up Window</label>
            <div class="slider-row" style="gap:4px;">
              <div class="slider-top"><span class="slider-label">Session timeout</span><span class="slider-val" id="wake-followup-ms-val">12s</span></div>
              <input type="range" id="wake-followup-ms" min="2000" max="20000" step="500" value="12000"/>
            </div>
          </div>
          <div class="field">
            <label>Custom Voice Commands</label>
            <textarea class="inp" id="voice-command-training" placeholder="study mode => open memory"></textarea>
          </div>
        </div>

        <div id="wake-browser-box" class="hint" style="margin-bottom:12px;">
          Built-in local wake uses your current microphone plus local whisper transcription. No AccessKey or extra files are required.
        </div>

        <div class="card-grid cols2" id="wake-porcupine-box" style="display:none;margin-bottom:12px;">
          <div class="field">
            <label>Porcupine Access Key</label>
            <input class="inp" id="porcupine-access-key" placeholder="Paste your Picovoice access key"/>
          </div>
          <div class="field">
            <label>Wake Keyword File (.ppn)</label>
            <input class="inp" id="porcupine-keyword-path" placeholder="C:\\desktop-mascot\\mic\\porcupine\\hey-mascot_windows.ppn"/>
          </div>
        </div>

        <div class="card-grid cols2" id="wake-porcupine-tuning" style="display:none;margin-bottom:12px;">
          <div class="field">
            <label>Porcupine Sensitivity</label>
            <div class="slider-row" style="gap:4px;">
              <div class="slider-top"><span class="slider-label">Wake trigger strength</span><span class="slider-val" id="porcupine-sensitivity-val">0.55</span></div>
              <input type="range" id="porcupine-sensitivity" min="0.20" max="0.95" step="0.01" value="0.55"/>
            </div>
          </div>
          <div class="field">
            <label>Porcupine Runtime</label>
            <div class="hint" style="padding-top:6px;">Porcupine needs an AccessKey and a custom .ppn keyword file for your wake phrase.</div>
          </div>
        </div>

        <div class="card-grid cols2" style="margin-bottom:12px;">
          <div class="card" style="margin-bottom:0;">
            <div class="card-body">
              <div class="trow">
                <div class="tl">
                  <span class="tl-n">Enable follow-up window</span>
                  <span class="tl-d">Keep a short voice session after a voice-driven turn.</span>
                </div>
                <label class="toggle"><input type="checkbox" id="tog-wake-followup"/><div class="track"><div class="thumb"></div></div></label>
              </div>
            </div>
          </div>
          <div class="card" style="margin-bottom:0;">
            <div class="card-body">
              <div class="trow">
                <div class="tl">
                  <span class="tl-n">Rearm after reply</span>
                  <span class="tl-d">Start wake listening again after a completed response.</span>
                </div>
                <label class="toggle"><input type="checkbox" id="tog-wake-listen-reply"/><div class="track"><div class="thumb"></div></div></label>
              </div>
            </div>
          </div>
        </div>

        <div class="card-grid cols2" style="margin-bottom:12px;">
          <div class="card" style="margin-bottom:0;">
            <div class="card-body">
              <div class="trow">
                <div class="tl">
                  <span class="tl-n">Rearm right after send</span>
                  <span class="tl-d">Restart wake listening as soon as your message is placed in chat.</span>
                </div>
                <label class="toggle"><input type="checkbox" id="tog-wake-rearm-send"/><div class="track"><div class="thumb"></div></div></label>
              </div>
            </div>
          </div>
          <div class="card" style="margin-bottom:0;">
            <div class="card-body">
              <div class="trow">
                <div class="tl">
                  <span class="tl-n">Voice HUD</span>
                  <span class="tl-d">Show the floating listening and transcribing status pill.</span>
                </div>
                <label class="toggle"><input type="checkbox" id="tog-voice-hud"/><div class="track"><div class="thumb"></div></div></label>
              </div>
            </div>
          </div>
        </div>

        <div class="card-grid cols2" style="margin-bottom:12px;">
          <div class="card" style="margin-bottom:0;">
            <div class="card-body">
              <div class="trow">
                <div class="tl">
                  <span class="tl-n">Voice interruption</span>
                  <span class="tl-d">Allow commands like stop talking.</span>
                </div>
                <label class="toggle"><input type="checkbox" id="tog-voice-interrupt"/><div class="track"><div class="thumb"></div></div></label>
              </div>
            </div>
          </div>
          <div class="card" style="margin-bottom:0;">
            <div class="card-body">
              <div class="trow">
                <div class="tl">
                  <span class="tl-n">Command confirmation</span>
                  <span class="tl-d">Ask before risky actions like clearing memory or chat.</span>
                </div>
                <label class="toggle"><input type="checkbox" id="tog-voice-confirm"/><div class="track"><div class="thumb"></div></div></label>
              </div>
            </div>
          </div>
        </div>

        <div class="card-grid cols2" style="margin-bottom:12px;">
          <div class="card" style="margin-bottom:0;">
            <div class="card-body" style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
              <div class="tl">
                <span class="tl-n">Mic calibration</span>
                <span class="tl-d">Auto-tune the mic threshold from your room noise.</span>
              </div>
              <button class="btn btn-secondary btn-sm" id="voice-calibrate-btn">Calibrate</button>
            </div>
          </div>
          <div class="field" style="margin:0;">
            <label>whisper.cpp Runtime</label>
            <div id="stt-openai-box">
              <div class="hint" style="margin-bottom:10px;">
                Uses <b>OpenAI Whisper</b> for cloud transcription. This needs internet and an API key.
              </div>
            </div>
            <div id="stt-local-box" style="display:none;">
              <div class="hint" style="margin-bottom:10px;">
                Uses the bundled <b>whisper.cpp</b> runtime when available. You can still override it below.
              </div>
              <div class="card-grid cols2" style="margin-bottom:10px;">
                <div class="field">
                  <label>whisper.cpp Executable</label>
                  <input class="inp" id="whispercpp-path" placeholder="C:\\whisper.cpp\\build\\bin\\Release\\whisper-cli.exe"/>
                </div>
                <div class="field">
                  <label>Model File</label>
                  <input class="inp" id="whispercpp-model" placeholder="C:\\whisper.cpp\\models\\ggml-base.bin"/>
                </div>
              </div>
              <div class="hint">
                Local mode is free after setup and runs offline.
              </div>
            </div>
          </div>
        </div>

        <div class="card-header" style="margin:8px 0 10px;">Diagnostics</div>
        <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius2);margin-bottom:10px;">
          <span id="whisper-key-dot" class="status-dot grey"></span>
          <span id="whisper-key-status" style="font-size:11px;color:var(--muted);">
            Add your OpenAI key in AI Model -> OpenAI tab to enable
          </span>
        </div>

        <div class="subtle-box" style="margin-bottom:10px;">
          <div style="font-size:10px;color:var(--muted);font-family:Space Mono,monospace;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Wake Monitor</div>
          <div id="wake-monitor-text" style="font-size:13px;color:var(--text2);line-height:1.6;min-height:22px;">Listening for wake phrase...</div>
        </div>

        <div class="subtle-box" style="margin-bottom:10px;">
          <div style="font-size:10px;color:var(--muted);font-family:Space Mono,monospace;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Wake History</div>
          <div id="wake-history-list" style="display:grid;gap:6px;">
            <div style="font-size:12px;color:var(--muted);">No wake activity yet.</div>
          </div>
        </div>

        <div class="mini-grid" style="margin-bottom:8px;">
          <div class="metric"><div class="k">Speech Engine</div><div class="v" id="voice-metric-engine">Local whisper.cpp</div><div class="s">Current STT backend</div></div>
          <div class="metric"><div class="k">Wake Word</div><div class="v" id="voice-metric-wake">Off</div><div class="s">Current wake status</div></div>
          <div class="metric"><div class="k">Intent Routing</div><div class="v" id="voice-metric-routing">Hybrid</div><div class="s">Voice command interpretation mode</div></div>
          <div class="metric"><div class="k">Runtime</div><div class="v" id="voice-metric-runtime">Idle</div><div class="s">Live mic state</div></div>
        </div>`;
    }
  }
  if(micSlot&&micCard&&micCard.parentElement!==micSlot) micSlot.appendChild(micCard);
  if(micSlot&&micSaveRow&&micSaveRow.parentElement!==micSlot) micSlot.appendChild(micSaveRow);
}
setupSplitSettingsPages();
setInterval(()=>ensureWakeListenerArmed(),2000);

// ─── Window buttons ───────────────────────────────────────
document.getElementById('btn-close').onclick=()=>ipcRenderer.send('close-panel');
document.getElementById('btn-min').onclick=()=>ipcRenderer.send('minimize-panel');
document.getElementById('btn-max').onclick=()=>ipcRenderer.send('maximize-panel');

// ─── Helpers ──────────────────────────────────────────────
function setEl(id,val){const e=document.getElementById(id);if(e&&val!=null)e.value=val;}
function tv(id,val){const e=document.getElementById(id);if(e)e.textContent=val;}
function ck(id,v){const e=document.getElementById(id);if(e)e.checked=!!v;}
function flash(id,dur=2000){const e=document.getElementById(id);if(!e)return;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),dur);}
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br/>');}
function togglePass(id){const e=document.getElementById(id);if(e)e.type=e.type==='password'?'text':'password';}
function shell(url){electronShell?.openExternal(url);}

// ─── Home cards ───────────────────────────────────────────
function updateHomeCards(){
  const pNames={ollama:'Ollama (Local)',openai:'OpenAI',anthropic:'Anthropic',gemini:'Google Gemini',nvidia:'NVIDIA NIM',custom:'Custom'};
  tv('home-ai-name',pNames[cfg.aiProvider]||'—');
  tv('home-ai-model',getModelLabel());
  const dot=document.getElementById('home-ai-dot');
  if(dot) dot.className='status-dot '+(cfg.aiProvider==='ollama'?'yellow':'green');
  const vNames={system:'System Voices',elevenlabs:'ElevenLabs',piper:'Piper'};
  tv('home-voice-name',vNames[cfg.voiceEngine]||'System');
  tv('home-voice-sub',cfg.ttsEnabled?'TTS Enabled':'TTS Disabled');
  const vDot=document.getElementById('home-voice-dot');
  if(vDot)vDot.className='status-dot '+(cfg.ttsEnabled?'green':'grey');
  tv('home-facts-count',`${mem.userFacts?.length||0} facts`);
  tv('home-mem-sub',mem.userName?`Hi ${mem.userName}!`:'Name not set');
  tv('home-mascot-status',cfg.mascotVisible?'Visible':'Hidden');
  const mDot=document.getElementById('home-mascot-dot');
  if(mDot)mDot.className='status-dot '+(cfg.mascotVisible?'green':'grey');
}

// ─── Provider tabs ────────────────────────────────────────
function setProviderTab(prov){
  currentProviderTab=prov;
  document.querySelectorAll('.ptab').forEach(t=>t.classList.toggle('active',t.dataset.prov===prov));
  document.querySelectorAll('.provider-panel').forEach(p=>p.classList.toggle('active',p.id===`prov-${prov}`));
  cfg.aiProvider=prov;
}
document.querySelectorAll('.ptab').forEach(t=>t.onclick=()=>setProviderTab(t.dataset.prov));

// Ollama check + model list
document.getElementById('ollama-check-btn').onclick=checkOllamaStatus;
document.getElementById('ollama-refresh-btn').onclick=fetchOllamaModels;

const POPULAR_MODELS=[
  {id:'llama3.2',name:'Llama 3.2',desc:'Meta – latest small model',size:'2-3GB',new:true},
  {id:'llama3.1',name:'Llama 3.1 8B',desc:'Meta – great all-rounder',size:'4.7GB'},
  {id:'llama3',name:'Llama 3 8B',desc:'Meta – stable, popular',size:'4.7GB'},
  {id:'mistral',name:'Mistral 7B',desc:'Fast, good reasoning',size:'4.1GB'},
  {id:'gemma2',name:'Gemma 2 9B',desc:'Google – very capable',size:'5.5GB'},
  {id:'phi3',name:'Phi-3 Mini',desc:'Microsoft – tiny but smart',size:'2.3GB'},
  {id:'qwen2.5',name:'Qwen 2.5 7B',desc:'Alibaba – multilingual',size:'4.4GB'},
  {id:'deepseek-r1',name:'DeepSeek R1',desc:'Reasoning model',size:'4.7GB',new:true},
  {id:'codellama',name:'Code Llama',desc:'Meta – code focused',size:'3.8GB'},
];

async function checkOllamaStatus(){
  const dot=document.getElementById('ollama-status-dot');
  const txt=document.getElementById('ollama-status-text');
  const sdot=document.getElementById('sdot');
  const stxt=document.getElementById('stext');
  try{
    const r=await fetch((cfg.ollamaUrl||'http://localhost:11434')+'/api/tags',{signal:AbortSignal.timeout(2500)});
    if(r.ok){
      if(dot){dot.className='status-dot green';}
      if(txt)txt.textContent='Connected ✓';
      if(sdot)sdot.className='status-dot green';
      if(stxt)stxt.textContent='ollama ready';
      fetchOllamaModels();
    }else throw new Error('not ok');
  }catch{
    if(dot)dot.className='status-dot red';
    if(txt)txt.textContent='Not running — start with: ollama serve';
    if(sdot)sdot.className='status-dot grey';
    if(stxt)stxt.textContent='ollama offline';
    renderOllamaModels([]);
  }
}

async function fetchOllamaModels(){
  try{
    const r=await fetch((cfg.ollamaUrl||'http://localhost:11434')+'/api/tags',{signal:AbortSignal.timeout(3000)});
    if(!r.ok)throw new Error();
    const data=await r.json();
    const installed=(data.models||[]).map(m=>m.name.split(':')[0]);
    renderOllamaModels(installed);
  }catch{renderOllamaModels([]);}
}

function renderOllamaModels(installedArr){
  const list=document.getElementById('ollama-model-list');
  const count=document.getElementById('ollama-model-count');
  if(!list)return;
  const installed=new Set(installedArr);
  const allModels=[...installedArr.map(n=>({id:n,name:n,desc:'Installed',installed:true})),
    ...POPULAR_MODELS.filter(m=>!installed.has(m.id)).map(m=>({...m,installed:false}))];
  if(count)count.textContent=`${installedArr.length} installed`;
  list.innerHTML='';
  allModels.forEach(m=>{
    const div=document.createElement('div');
    div.className='model-item '+(m.installed?'installed':'not-installed')+(cfg.ollamaModel===m.id?' selected':'');
    div.innerHTML=`
      <div class="mi-status"></div>
      <div class="mi-info">
        <div class="mi-name">${m.name}${m.new?'  <span class="tag tag-green" style="font-size:8px;">NEW</span>':''}</div>
        <div class="mi-desc">${m.desc||''} ${m.installed?'<span class="tag tag-green" style="font-size:8px;">✓ Installed</span>':''}</div>
      </div>
      ${m.size?`<div class="mi-size">${m.size}</div>`:''}
    `;
    div.onclick=()=>{
      cfg.ollamaModel=m.id;
      list.querySelectorAll('.model-item').forEach(i=>i.classList.remove('selected'));
      div.classList.add('selected');
      tv('mbadge',m.id);
      const cmd=document.getElementById('ollama-install-cmd');
      if(!m.installed&&cmd){cmd.textContent=`ollama pull ${m.id}`;cmd.classList.add('show');}
      else if(cmd)cmd.classList.remove('show');
    };
    list.appendChild(div);
  });
}

// AI Save
document.getElementById('ai-save-btn').onclick=()=>{
  cfg.aiProvider    =currentProviderTab;
  cfg.ollamaUrl     =val('ollama-url');
  cfg.openaiKey     =val('openai-key');cfg.openaiModel=val('openai-model');
  cfg.anthropicKey  =val('anthropic-key');cfg.anthropicModel=val('anthropic-model');
  cfg.geminiKey     =val('gemini-key');cfg.geminiModel=val('gemini-model');
  cfg.nvidiaKey     =val('nvidia-key');cfg.nvidiaModel=val('nvidia-model');
  cfg.customUrl     =val('custom-url');cfg.customKey=val('custom-key');cfg.customModel=val('custom-model');
  tv('mbadge',getModelLabel());
  ipcRenderer.send('save-config',{...cfg});
  flash('ai-save-ok');updateHomeCards();
  updateSTTUI();
};
function val(id){const e=document.getElementById(id);return e?e.value:'';}

async function loadMicDevices(){
  const select=document.getElementById('stt-device');
  if(!select) return;
  try{
    const devices=await navigator.mediaDevices.enumerateDevices();
    availableMics=devices.filter(d=>d.kind==='audioinput');
  }catch{
    availableMics=[];
  }
  select.innerHTML='<option value="">System default microphone</option>';
  availableMics.forEach((mic,idx)=>{
    const opt=document.createElement('option');
    opt.value=mic.deviceId;
    opt.textContent=mic.label||`Microphone ${idx+1}`;
    select.appendChild(opt);
  });
  select.value=(cfg.micDeviceId&&availableMics.some(m=>m.deviceId===cfg.micDeviceId))?cfg.micDeviceId:'';
}

function applyDeviceProfile(deviceId,updateInputs=true){
  const profiles=cfg.micProfiles||{};
  const profile=deviceId?profiles[deviceId]:null;
  if(!profile) return;
  if(profile.sttSilenceTimeoutMs!=null) cfg.sttSilenceTimeoutMs=profile.sttSilenceTimeoutMs;
  if(profile.sttSensitivity!=null) cfg.sttSensitivity=profile.sttSensitivity;
  if(profile.sttNoisePreset) cfg.sttNoisePreset=profile.sttNoisePreset;
  if(updateInputs){
    setEl('stt-silence-timeout',cfg.sttSilenceTimeoutMs||1600);
    tv('stt-silence-timeout-val',`${Math.round((cfg.sttSilenceTimeoutMs||1600)/100)/10}s`);
    setEl('stt-sensitivity',cfg.sttSensitivity||0.014);
    tv('stt-sensitivity-val',Number(cfg.sttSensitivity||0.014).toFixed(3));
    setEl('stt-noise-preset',cfg.sttNoisePreset||'medium');
  }
}

function saveCurrentMicProfile(){
  if(!cfg.micDeviceId) return;
  cfg.micProfiles=cfg.micProfiles||{};
  cfg.micProfiles[cfg.micDeviceId]={
    sttSilenceTimeoutMs:cfg.sttSilenceTimeoutMs,
    sttSensitivity:cfg.sttSensitivity,
    sttNoisePreset:cfg.sttNoisePreset,
  };
}

function getNoisePresetConstraints(){
  switch(cfg.sttNoisePreset){
    case 'low': return { echoCancellation:false, noiseSuppression:false, autoGainControl:false };
    case 'high': return { echoCancellation:true, noiseSuppression:true, autoGainControl:true };
    default: return { echoCancellation:true, noiseSuppression:true, autoGainControl:false };
  }
}

function getWhisperCommandLang(){
  if(cfg.sttBilingualBias==='hi-en') return 'auto';
  if(cfg.sttBilingualBias==='en-first') return 'en';
  if(cfg.sttBilingualBias==='hi-first') return 'hi';
  if(cfg.sttLanguage==='hi') return 'hi';
  if(cfg.sttLanguage==='en') return 'en';
  return 'auto';
}

function normalizeVoiceText(text){
  return (text||'').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
}

function escapeRegex(value){
  return String(value||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}

function formatWakeTimestamp(ts){
  try{
    return new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  }catch{
    return '';
  }
}

function renderWakeHistory(){
  const host=document.getElementById('wake-history-list');
  if(!host) return;
  if(!wakeHistory.length){
    host.innerHTML='<div style="font-size:12px;color:var(--muted);">No wake activity yet.</div>';
    return;
  }
  host.innerHTML=wakeHistory.map(item=>{
    const tone=item.matched ? 'var(--green)' : 'var(--yellow)';
    const state=item.matched ? 'matched' : 'not matched';
    const text=(item.text||'').replace(/[<>&]/g,ch=>({ '<':'&lt;','>':'&gt;','&':'&amp;' }[ch]));
    return `<div style="display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:start;padding:8px 10px;background:var(--s2);border:1px solid var(--border);border-radius:var(--radius2);">
      <div style="font:11px 'Space Mono',monospace;color:var(--muted);white-space:nowrap;">${formatWakeTimestamp(item.ts)}</div>
      <div style="font-size:12px;color:var(--text2);line-height:1.4;">${text||'<span style="color:var(--muted);">No transcript</span>'}</div>
      <div style="font:11px 'Space Mono',monospace;color:${tone};text-transform:uppercase;letter-spacing:0.08em;white-space:nowrap;">${state}</div>
    </div>`;
  }).join('');
}

function pushWakeHistory(text, matched){
  wakeHistory.unshift({ ts:Date.now(), text:(text||'').trim(), matched:!!matched });
  wakeHistory=wakeHistory.slice(0,WAKE_HISTORY_LIMIT);
  renderWakeHistory();
}

function getWakePhrases(){
  const primary=(cfg.wakeWordPhrase||'hey mascot').trim();
  const aliases=String(cfg.wakeWordAliases||'')
    .split(/[\n,]+/)
    .map(s=>s.trim())
    .filter(Boolean);
  return [...new Set([primary,...aliases].filter(Boolean))];
}

function isFollowupWindowActive(){
  return cfg.wakeFollowupEnabled!==false && awaitingFollowup;
}

function startVoiceSession(){
  voiceSessionUntil=Date.now()+(cfg.wakeFollowupMs||12000);
  voiceSessionPrimed=true;
}

function armFollowupWindow(){
  if(cfg.wakeFollowupEnabled===false) return;
  clearTimeout(followupTimeoutTimer);
  awaitingFollowup=true;
  followupArmUntil=Date.now()+2000;
  setVoiceHud('followup','Reply done. Speak within 2 seconds...');
  playCue('followup');
  showToast('Follow-up ready');
  queueWakeResume(0);
  followupTimeoutTimer=setTimeout(()=>{
    awaitingFollowup=false;
    followupArmUntil=0;
    clearVoiceSession();
    clearVoiceHud(400);
  },2100);
}

function clearVoiceSession(){
  voiceSessionUntil=0;
  voiceSessionPrimed=false;
  awaitingFollowup=false;
  followupArmUntil=0;
  pendingFollowupAfterSpeech=false;
  voiceListeningMode='manual';
  clearTimeout(followupTimeoutTimer);
}

function playCue(kind='wake'){
  try{
    const AC=window.AudioContext||window.webkitAudioContext;
    const ac=new AC();
    const schedule=(freq,start,duration,gainLevel)=>{
      const osc=ac.createOscillator();
      const gain=ac.createGain();
      osc.type='sine';
      osc.frequency.value=freq;
      gain.gain.setValueAtTime(0.001,ac.currentTime+start);
      gain.gain.exponentialRampToValueAtTime(gainLevel,ac.currentTime+start+0.02);
      gain.gain.exponentialRampToValueAtTime(0.001,ac.currentTime+start+duration);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(ac.currentTime+start);
      osc.stop(ac.currentTime+start+duration+0.02);
    };
    if(kind==='followup'){
      schedule(740,0,0.12,0.08);
      schedule(988,0.14,0.16,0.08);
    }else{
      schedule(880,0,0.12,0.09);
      schedule(1175,0.13,0.15,0.09);
    }
    setTimeout(()=>ac.close().catch(()=>{}),500);
  }catch{}
}

function setVoiceHud(state,text=''){
  const hud=document.getElementById('voice-hud');
  const label=document.getElementById('voice-hud-text');
  const title=document.getElementById('voice-hud-title');
  const icon=document.getElementById('voice-hud-icon');
  if(!hud) return;
  tv('voice-metric-runtime',text||'Idle');
  if(cfg.voiceHudEnabled===false){
    hud.classList.remove('active');
    hud.dataset.state='idle';
    return;
  }
  hud.dataset.state=state||'idle';
  hud.classList.toggle('active',!!text);
  if(title) title.textContent=({
    idle:'Voice',
    wake:'Wake',
    listening:'Listening',
    followup:'Follow-up',
    transcribing:'Transcribing',
    thinking:'Thinking',
    speaking:'Speaking',
    calibrating:'Calibrating',
    ready:'Ready'
  })[state||'idle']||'Voice';
  if(icon) icon.textContent=({
    wake:'✨',
    listening:'🎙',
    followup:'↩',
    transcribing:'📝',
    thinking:'🤔',
    speaking:'🔊',
    calibrating:'🎚',
    ready:'✅',
    idle:'🎙'
  })[state||'idle']||'🎙';
  if(label) label.textContent=text;
}

function clearVoiceHud(delay=0){
  const run=()=>setVoiceHud('idle','');
  if(delay>0) setTimeout(run,delay);
  else run();
}

function queueWakeResume(delay=0){
  clearTimeout(wakeResumeTimer);
  wakeResumeTimer=setTimeout(()=>{
    if(cfg.wakeWordEnabled && !isListening && !isThinking && !ttsBusy && !pendingFollowupAfterSpeech) setupWakeWordListener();
  },delay);
}

function queueWakeResumeFlexible(delay=0,{allowThinking=false}={}){
  clearTimeout(wakeResumeTimer);
  wakeResumeTimer=setTimeout(()=>{
    if(!cfg.wakeWordEnabled || isListening || ttsBusy || pendingFollowupAfterSpeech) return;
    if(isThinking && !allowThinking) return;
    setupWakeWordListener();
  },delay);
}

function isWakeListenerActive(){
  if(getWakeEngine()==='porcupine'){
    return !!(porcupineLoopActive && porcupineRecorder?.isRecording);
  }
  return !!(wakeMonitorStream && wakeMonitorProcessor && wakeMonitorContext);
}

function ensureWakeListenerArmed(){
  if(!cfg.sttEnabled || !cfg.wakeWordEnabled) return;
  if(isListening || isThinking || ttsBusy || pendingFollowupAfterSpeech) return;
  if(isWakeListenerActive()) return;
  setupWakeWordListener();
}

function setWakeMonitorPreview(text){
  wakeMonitorPreview=text||'';
  const el=document.getElementById('wake-monitor-text');
  if(el) el.textContent=wakeMonitorPreview||'Idle';
}

function applyMicConfigToInputs(){
  ck('tog-stt',cfg.sttEnabled);
  setEl('stt-engine',cfg.sttEngine||'openai');
  setEl('stt-language',cfg.sttLanguage||'auto');
  ck('tog-stt-auto-stop',cfg.autoMicStop!==false);
  ck('tog-stt-auto-send',cfg.autoMicSend!==false);
  ck('tog-stt-hold',!!cfg.sttHoldToTalk);
  ck('tog-stt-wake',!!cfg.wakeWordEnabled);
  setEl('stt-wake-word',cfg.wakeWordPhrase||'hey mascot');
  setEl('wake-engine',cfg.wakeEngine||'browser');
  setEl('stt-wake-aliases',cfg.wakeWordAliases||'');
  setEl('porcupine-access-key',cfg.porcupineAccessKey||'');
  setEl('porcupine-keyword-path',cfg.porcupineKeywordPath||'');
  setEl('porcupine-sensitivity',cfg.porcupineSensitivity||0.55);
  tv('porcupine-sensitivity-val',Number(cfg.porcupineSensitivity||0.55).toFixed(2));
  setEl('stt-bilingual-bias',cfg.sttBilingualBias||'off');
  setEl('stt-noise-preset',cfg.sttNoisePreset||'medium');
  setEl('stt-mode',cfg.sttMode||'chat');
  setEl('stt-device',cfg.micDeviceId||'');
  setEl('stt-silence-timeout',cfg.sttSilenceTimeoutMs||1600);
  tv('stt-silence-timeout-val',`${Math.round((cfg.sttSilenceTimeoutMs||1600)/100)/10}s`);
  setEl('stt-sensitivity',cfg.sttSensitivity||0.014);
  tv('stt-sensitivity-val',Number(cfg.sttSensitivity||0.014).toFixed(3));
  setEl('wake-sensitivity',cfg.wakeSensitivity||0.008);
  tv('wake-sensitivity-val',Number(cfg.wakeSensitivity||0.008).toFixed(3));
  setEl('wake-window-ms',cfg.wakeSpeechWindowMs||1400);
  tv('wake-window-ms-val',`${Math.round((cfg.wakeSpeechWindowMs||1400)/100)/10}s`);
  setEl('wake-followup-ms',cfg.wakeFollowupMs||12000);
  tv('wake-followup-ms-val',`${Math.round((cfg.wakeFollowupMs||12000)/1000)}s`);
  ck('tog-wake-followup',cfg.wakeFollowupEnabled!==false);
  ck('tog-wake-listen-reply',cfg.wakeListenAfterReply!==false);
  ck('tog-wake-rearm-send',cfg.wakeRearmAfterSend===true);
  ck('tog-voice-hud',cfg.voiceHudEnabled!==false);
  ck('tog-voice-interrupt',cfg.voiceInterruptEnabled!==false);
  ck('tog-voice-confirm',cfg.voiceConfirmActions!==false);
  setEl('voice-intent-routing',cfg.voiceIntentRouting||'hybrid');
  setEl('voice-command-training',cfg.voiceCommandTraining||'');
  setEl('whispercpp-path',cfg.whisperCppPath||'');
  setEl('whispercpp-model',cfg.whisperCppModel||'');
  setWakeMonitorPreview(wakeMonitorPreview||'Listening for wake phrase...');
  renderWakeHistory();
}

function resetMicSettings(){
  const preserved={
    whisperCppPath:cfg.whisperCppPath||'',
    whisperCppModel:cfg.whisperCppModel||'',
    porcupineAccessKey:cfg.porcupineAccessKey||'',
    porcupineKeywordPath:cfg.porcupineKeywordPath||'',
    porcupineSensitivity:cfg.porcupineSensitivity||0.55,
    micProfiles:cfg.micProfiles||{},
  };
  stopListening(false);
  cancelTranscription();
  stopWakeWordListener();
  Object.assign(cfg,MIC_RESET_DEFAULTS,preserved);
  wakeHistory=[];
  wakeMonitorPreview='Listening for wake phrase...';
  applyMicConfigToInputs();
  updateSTTUI();
  setupMic();
  ipcRenderer.send('save-config',{...cfg});
  flash('mic-save-ok');
  showToast('Mic settings reset');
}

function getPorcupineKeywordPath(){
  const raw=(cfg.porcupineKeywordPath||'').trim();
  if(!raw) return '';
  return path.isAbsolute(raw)?raw:path.join(__dirname,raw);
}

function getPorcupineReadiness(){
  const keywordPath=getPorcupineKeywordPath();
  return {
    sdkReady:!!(Porcupine&&PvRecorder),
    accessKey:!!String(cfg.porcupineAccessKey||'').trim(),
    keywordPath,
    keywordReady:!!(keywordPath&&fs.existsSync(keywordPath))
  };
}

function getPorcupineDeviceIndex(){
  if(!PvRecorder) return -1;
  if(!cfg.micDeviceId) return -1;
  const browserDevice=availableMics.find(m=>m.deviceId===cfg.micDeviceId);
  const label=(browserDevice?.label||'').trim().toLowerCase();
  if(!label) return -1;
  try{
    const devices=PvRecorder.getAvailableDevices();
    const exact=devices.findIndex(name=>String(name||'').trim().toLowerCase()===label);
    if(exact!==-1) return exact;
    return devices.findIndex(name=>{
      const candidate=String(name||'').trim().toLowerCase();
      return candidate && (candidate.includes(label) || label.includes(candidate));
    });
  }catch{
    return -1;
  }
}

function getWakeEngine(){
  return cfg.wakeEngine==='porcupine' ? 'porcupine' : 'browser';
}

function extractWakePayload(text){
  const raw=(text||'').trim();
  if(!raw) return '';
  for(const phrase of getWakePhrases()){
    const wake=String(phrase||'').trim();
    if(!wake) continue;
    const match=raw.match(new RegExp(`^\\s*${escapeRegex(wake)}(?:[\\s,.:;!?-]+(.*))?$`,'i'));
    if(!match) continue;
    const after=(match[1]||'').trim();
    return after || '__wake__';
  }
  return isWakeMatch(raw) ? '__wake__' : '';
}

function stripWakePhrase(text){
  const raw=(text||'').trim();
  if(!cfg.wakeWordEnabled) return raw;
  let cleaned=raw;
  getWakePhrases().forEach(phrase=>{
    const escaped=escapeRegex(phrase);
    cleaned=cleaned.replace(new RegExp(`^\\s*${escaped}[\\s,.:;-]*`,'i'),'').trim();
  });
  return cleaned;
}

function cleanTranscriptText(text,{stripWake=false}={}){
  let cleaned=(text||'').replace(/\s+/g,' ').trim();
  if(stripWake) cleaned=stripWakePhrase(cleaned);
  cleaned=cleaned.replace(/^(?:hey|hi)\s+(?:mascot|maskot|mascut)[\s,.:;-]*/i,'').trim();
  cleaned=cleaned.replace(/\b(blank audio|no speech detected)\b/ig,'').replace(/\s+/g,' ').trim();
  if(cleaned && /^[a-z]/.test(cleaned) && cleaned.split(/\s+/).length > 3){
    cleaned=cleaned.charAt(0).toUpperCase()+cleaned.slice(1);
  }
  return cleaned;
}

function voiceHasAny(text,phrases){
  return phrases.some(phrase=>text.includes(phrase));
}

function setMascotVisibility(visible){
  cfg.mascotVisible=visible;
  ck('tog-mascot',visible);
  ipcRenderer.send('toggle-mascot',visible);
  showToast(visible?'Mascot shown':'Mascot hidden',1800);
  updateHomeCards();
}

function setClickThroughState(enabled){
  cfg.clickThrough=enabled;
  ck('tog-click',enabled);
  ipcRenderer.send('toggle-click-through',enabled);
}

function setBorderState(enabled){
  cfg.borderVisible=enabled;
  ck('tog-border',enabled);
  ipcRenderer.send('toggle-border',enabled);
}

function openVoiceRoute(target){
  switch(target){
    case 'home':
    case 'chat':
    case 'mic':
    case 'voice':
    case 'memory':
    case 'looks':
    case 'mascot':
      switchPage(target);
      return true;
    case 'ai':
      switchPage('ai');
      return true;
    case 'openai':
    case 'anthropic':
    case 'gemini':
    case 'ollama':
    case 'nvidia':
    case 'custom':
      switchPage('ai');
      setProviderTab(target);
      return true;
    default:
      return false;
  }
}

function inferVoiceRoute(text){
  const routes=[
    { target:'mic', keys:['mic','microphone','wake word','speech to text','stt','listening settings','mic settings'] },
    { target:'voice', keys:['voice setting','voice settings','speech output','tts settings','voice tab'] },
    { target:'memory', keys:['memory','remember','memories','notes'] },
    { target:'chat', keys:['chat','conversation','messages','talk page'] },
    { target:'home', keys:['home','dashboard','main page'] },
    { target:'looks', keys:['appearance','theme','look','looks','style'] },
    { target:'mascot', keys:['mascot setting','mascot settings','character settings','mascot page','character page'] },
    { target:'openai', keys:['openai','gpt'] },
    { target:'anthropic', keys:['anthropic','claude'] },
    { target:'gemini', keys:['gemini','google ai'] },
    { target:'ollama', keys:['ollama','local model','local ai'] },
    { target:'nvidia', keys:['nvidia','nim'] },
    { target:'custom', keys:['custom api','custom model','openai compatible'] },
    { target:'ai', keys:['ai model','model settings','provider settings','ai settings','model page'] },
  ];
  const match=routes.find(route=>voiceHasAny(text,route.keys));
  return match?match.target:'';
}

function getTrainedVoiceCommands(){
  return String(cfg.voiceCommandTraining||'')
    .split('\n')
    .map(line=>line.trim())
    .filter(Boolean)
    .map(line=>{
      const [phrase,target='']=line.split('=>').map(s=>s.trim());
      return phrase&&target?{phrase:normalizeVoiceText(phrase),target:normalizeVoiceText(target)}:null;
    })
    .filter(Boolean);
}

function trainedCommandIntent(text){
  for(const item of getTrainedVoiceCommands()){
    if(text.includes(item.phrase)) return { action:'trained', target:item.target };
  }
  return null;
}

function buildHeuristicIntent(rawText){
  const text=normalizeVoiceText(rawText);
  if(!text) return null;
  lastVoiceCommand=text;
  const hideAction=voiceHasAny(text,['hide','close','turn off','disable','remove']);
  const showAction=voiceHasAny(text,['show','open','turn on','enable','bring back']);
  const openAction=voiceHasAny(text,['open','show','go to','take me to','switch to','navigate to']);
  const stopAction=voiceHasAny(text,['stop listening','cancel listening','stop recording','cancel recording','stop voice']);

  if(stopAction) return { action:'stop_listening' };

  if(cfg.voiceInterruptEnabled!==false && (voiceHasAny(text,['stop talking','stop speaking','be quiet','quiet']) || text==='stop')){
    return { action:'stop_tts' };
  }

  if(voiceHasAny(text,['mascot chupa do','character chupa do','hide yourself']) || (hideAction && voiceHasAny(text,['mascot','character','avatar','girl','yourself']))){
    return { action:'set_mascot_visibility', value:false };
  }
  if(voiceHasAny(text,['mascot dikhao','character dikhao','show yourself','come back']) || (showAction && voiceHasAny(text,['mascot','character','avatar','girl','yourself']))){
    return { action:'set_mascot_visibility', value:true };
  }

  if((showAction && voiceHasAny(text,['click through','clickthrough','mouse pass through'])) || /let clicks pass/i.test(rawText)){
    return { action:'set_click_through', value:true };
  }
  if((hideAction && voiceHasAny(text,['click through','clickthrough','mouse pass through'])) || /stop clicks passing/i.test(rawText)){
    return { action:'set_click_through', value:false };
  }

  if((showAction && voiceHasAny(text,['border','outline','frame']))){
    return { action:'set_border', value:true };
  }
  if((hideAction && voiceHasAny(text,['border','outline','frame']))){
    return { action:'set_border', value:false };
  }

  if(voiceHasAny(text,['always on top','stay on top','pin yourself'])){
    return { action:'set_always_on_top', value:!hideAction };
  }

  if(voiceHasAny(text,['behind taskbar','go behind windows','stay in background'])){
    return { action:'set_behind_taskbar', value:!hideAction };
  }

  if(voiceHasAny(text,['be smaller','get smaller','shrink'])) return { action:'scale_mascot', delta:-0.03 };
  if(voiceHasAny(text,['be bigger','get bigger','grow'])) return { action:'scale_mascot', delta:0.03 };
  if(voiceHasAny(text,['move left'])) return { action:'move_mascot', dx:-25, dy:0 };
  if(voiceHasAny(text,['move right'])) return { action:'move_mascot', dx:25, dy:0 };
  if(voiceHasAny(text,['move up'])) return { action:'move_mascot', dx:0, dy:-25 };
  if(voiceHasAny(text,['move down'])) return { action:'move_mascot', dx:0, dy:25 };

  if(voiceHasAny(text,['clear memory','reset memory','erase memory'])) return { action:'clear_memory', confirm:true };
  if(voiceHasAny(text,['clear chat','erase chat','reset chat'])) return { action:'clear_chat', confirm:true };
  if(voiceHasAny(text,['calibrate microphone','calibrate mic','calibrate noise'])) return { action:'calibrate_noise' };

  const trained=trainedCommandIntent(text);
  if(trained) return trained;

  if(openAction || /kholo|dikhao|jao/.test(text)){
    const route=inferVoiceRoute(text);
    if(route) return { action:'open_route', target:route };
    if(voiceHasAny(text,['settings','control panel'])) return { action:'open_route', target:'voice' };
  }

  if(voiceHasAny(text,['go home','switch home','back home','home page'])) return { action:'open_route', target:'home' };
  return null;
}

async function inferVoiceIntent(rawText){
  const heuristic=buildHeuristicIntent(rawText);
  if(heuristic || cfg.voiceIntentRouting==='off') return heuristic;
  if(cfg.voiceIntentRouting==='rules') return null;
  try{
    const prompt=`Return strict JSON only. Interpret this voice command for a desktop mascot app.
Allowed actions: open_route, set_mascot_visibility, set_click_through, set_border, set_always_on_top, set_behind_taskbar, move_mascot, scale_mascot, stop_tts, stop_listening, clear_memory, clear_chat, none.
For open_route target can be: home, chat, ai, openai, anthropic, gemini, ollama, nvidia, custom, voice, mic, memory, looks, mascot.
For booleans use value true/false. For move use dx and dy integers. For scale use delta number.
If the command is conversational and not a device command, return {"action":"none"}.
Command: ${rawText}`;
    let out='';
    for await (const token of streamForProvider([{role:'user',content:prompt}], true)) out+=token;
    const match=out.match(/\{[\s\S]*\}/);
    if(!match) return null;
    const parsed=JSON.parse(match[0]);
    return parsed?.action && parsed.action!=='none' ? parsed : null;
  }catch{
    return null;
  }
}

function describeIntent(intent){
  switch(intent?.action){
    case 'open_route': return `Open ${intent.target}`;
    case 'set_mascot_visibility': return intent.value?'Show mascot':'Hide mascot';
    case 'set_click_through': return intent.value?'Enable click through':'Disable click through';
    case 'set_border': return intent.value?'Show border':'Hide border';
    case 'set_always_on_top': return intent.value?'Keep mascot on top':'Stop keeping mascot on top';
    case 'set_behind_taskbar': return intent.value?'Send mascot behind taskbar':'Bring mascot out of background';
    case 'clear_memory': return 'Clear all memory';
    case 'clear_chat': return 'Clear chat history';
    case 'calibrate_noise': return 'Calibrate microphone';
    default: return 'Run voice action';
  }
}

function intentNeedsConfirmation(intent){
  return cfg.voiceConfirmActions!==false && !!intent?.confirm;
}

function executeResolvedIntent(intent){
  if(!intent?.action) return false;
  switch(intent.action){
    case 'open_route': return openVoiceRoute(intent.target);
    case 'set_mascot_visibility': setMascotVisibility(!!intent.value); return true;
    case 'set_click_through': setClickThroughState(!!intent.value); return true;
    case 'set_border': setBorderState(!!intent.value); return true;
    case 'set_always_on_top':
      cfg.alwaysOnTop=!!intent.value;
      if(intent.value){ cfg.behindTaskbar=false; ck('tog-taskbar',false); }
      ck('tog-ontop',cfg.alwaysOnTop);
      ipcRenderer.send('toggle-always-on-top',cfg.alwaysOnTop);
      return true;
    case 'set_behind_taskbar':
      cfg.behindTaskbar=!!intent.value;
      if(intent.value){ cfg.alwaysOnTop=false; ck('tog-ontop',false); }
      ck('tog-taskbar',cfg.behindTaskbar);
      ipcRenderer.send('toggle-behind-taskbar',cfg.behindTaskbar);
      return true;
    case 'move_mascot':
      cfg.mascotX=(cfg.mascotX||0)+(intent.dx||0);
      cfg.mascotY=(cfg.mascotY||0)+(intent.dy||0);
      ipcRenderer.send('preview-position',{x:cfg.mascotX,y:cfg.mascotY});
      return true;
    case 'scale_mascot':
      cfg.scale=Math.max(0.08,Math.min(1.2,(cfg.scale||0.25)+(intent.delta||0)));
      ipcRenderer.send('preview-scale',{scale:cfg.scale});
      setEl('scale-slider',cfg.scale);
      tv('scale-val',cfg.scale.toFixed(2));
      return true;
    case 'stop_tts': stopTTS(); showToast('Voice stopped'); return true;
    case 'stop_listening': stopListening(false); return true;
    case 'clear_memory':
      mem={userName:'',userFacts:[],personality:'',convoSummaries:[],totalMessages:0,currentMood:'neutral',memoryFeed:[]};
      ipcRenderer.send('memory-clear-all');setEl('mem-name','');setEl('mem-personality','');renderMemoryPage(); return true;
    case 'clear_chat':
      ipcRenderer.send('clear-chat-history'); return true;
    case 'calibrate_noise':
      calibrateAmbientNoise(); return true;
    case 'trained':
      return executeResolvedIntent(buildHeuristicIntent(intent.target) || { action:'open_route', target:intent.target });
    default:
      return false;
  }
}

async function executeVoiceCommand(rawText){
  const intent=await inferVoiceIntent(rawText);
  if(!intent) return false;
  if(intentNeedsConfirmation(intent)){
    lastVoiceIntent=intent;
    const desc=describeIntent(intent);
    showTranscriptPreview(`Confirm: ${desc}`);
    showInterim(`Say "confirm" to ${desc.toLowerCase()}`);
    return true;
  }
  return executeResolvedIntent(intent);
}

async function handleVoiceTranscript(text,meta={}){
  const trimmed=cleanTranscriptText(text,{stripWake:!meta.skipWake});
  if(!trimmed) return true;
  const normalized=normalizeVoiceText(trimmed);
  if(lastVoiceIntent && /^(confirm|yes|do it|go ahead|haan|han)$/.test(normalized)){
    const intent=lastVoiceIntent;
    lastVoiceIntent=null;
    hideTranscriptPreview(true);
    showInterim(`Confirmed: ${describeIntent(intent)}`);
    executeResolvedIntent(intent);
    return true;
  }
  if(lastVoiceIntent && /^(cancel|no|stop|leave it|rehne do)$/.test(normalized)){
    lastVoiceIntent=null;
    hideTranscriptPreview(true);
    showInterim('Canceled command');
    return true;
  }
  let payload=trimmed;
  if(!meta.skipWake && !isFollowupWindowActive() && cfg.wakeWordEnabled){
    payload=extractWakePayload(trimmed);
    if(!payload) return true;
    if(payload==='__wake__'){
      showInterim('Wake word heard. Listening for command...');
      setTimeout(()=>showInterim(''),1500);
      return true;
    }
    payload=cleanTranscriptText(payload);
  }
  const commandHandled=await executeVoiceCommand(payload);
  if(commandHandled){
    showInterim(`Command: ${payload}`);
    setTimeout(()=>showInterim(''),1800);
    hideTranscriptPreview(true);
    if(meta.applyToInput){
      const inp=document.getElementById('chat-input');
      if(inp) inp.value='';
    }
    return true;
  }
  if(cfg.sttMode==='command'){
    showInterim('No matching voice command');
    setTimeout(()=>showInterim(''),1800);
    if(meta.applyToInput){
      const inp=document.getElementById('chat-input');
      if(inp) inp.value='';
    }
    return true;
  }
  return false;
}

function stopWakeWordListener(){
  if(wakeMonitorProcessor) wakeMonitorProcessor.onaudioprocess=null;
  wakeMonitorSource?.disconnect?.();
  wakeMonitorProcessor?.disconnect?.();
  wakeMonitorSilencer?.disconnect?.();
  wakeMonitorStream?.getTracks?.().forEach(t=>t.stop());
  wakeMonitorContext?.close?.().catch?.(()=>{});
  wakeMonitorStream=null;
  wakeMonitorContext=null;
  wakeMonitorSource=null;
  wakeMonitorProcessor=null;
  wakeMonitorSilencer=null;
  wakeMonitorChunks=[];
  wakeMonitorSpeechMs=0;
  wakeMonitorSilenceMs=0;
  wakeMonitorHeardSpeech=false;
  wakeMonitorTranscribing=false;
  clearTimeout(porcupineRestartTimer);
  porcupineRestartTimer=null;
  porcupineLoopActive=false;
  try{ porcupineRecorder?.stop?.(); }catch{}
  try{ porcupineRecorder?.release?.(); }catch{}
  try{ porcupineHandle?.release?.(); }catch{}
  porcupineRecorder=null;
  porcupineHandle=null;
}

function wakeDebug(){}

function triggerWakeCue(){
  const now=Date.now();
  if(now-lastWakeTriggerAt<WAKE_TRIGGER_COOLDOWN_MS) return;
  lastWakeTriggerAt=now;
  playCue('wake');
  showInterim('Wake word detected');
  setVoiceHud('wake',`Detected "${cfg.wakeWordPhrase||'hey mascot'}"`);
  showToast('Wake word detected');
  setWakeMonitorPreview(`Matched wake phrase: ${cfg.wakeWordPhrase||'hey mascot'}`);
  setTimeout(()=>showInterim(''),1500);
  clearVoiceHud(1600);
}

function isWakeMatch(text){
  const normalized=normalizeVoiceText(text);
  if(!normalized) return false;
  const compact=normalized.replace(/\s+/g,'');
  for(const phrase of getWakePhrases()){
    const wake=normalizeVoiceText(phrase);
    if(!wake) continue;
    if(normalized.includes(wake)) return true;
    if(compact.includes(wake.replace(/\s+/g,''))) return true;
  }
  if(/(?:hey|hi|hay)\s+(?:mascot|maskot|mascut|mascott)/i.test(normalized)) return true;
  return false;
}

function triggerWakeListening(){
  wakeDebug('triggered');
  const now=Date.now();
  if(now-lastWakeTriggerAt<WAKE_TRIGGER_COOLDOWN_MS) return;
  lastWakeTriggerAt=now;
  voiceListeningMode='wake';
  if(cfg.voiceInterruptEnabled!==false && ttsBusy) stopTTS();
  playCue('wake');
  showInterim('Wake word detected. Listening...');
  setVoiceHud('listening','Listening after wake word...');
  showToast('Wake word detected');
  stopWakeWordListener();
  setTimeout(()=>startListening(),80);
}

function trimWakeChunks(maxSamples=16000*5){
  let total=wakeMonitorChunks.reduce((sum,chunk)=>sum+chunk.length,0);
  while(total>maxSamples && wakeMonitorChunks.length>1){
    total-=wakeMonitorChunks[0].length;
    wakeMonitorChunks.shift();
  }
}

async function processWakeTranscript(text){
  const heard=cleanTranscriptText(text);
  wakeDebug('wake-transcript', heard);
  if(!heard) return;
  setWakeMonitorPreview(`Heard: ${heard}`);
  const matched=isWakeMatch(heard);
  pushWakeHistory(heard,matched);
  if(!matched) return;
  triggerWakeListening();
}

async function flushWakeMonitor(){
  if(wakeMonitorTranscribing || !wakeMonitorChunks.length || isListening) return;
  if(wakeMonitorSpeechMs<WAKE_MIN_SPEECH_MS){
    wakeMonitorChunks=[];
    wakeMonitorSpeechMs=0;
    wakeMonitorSilenceMs=0;
    wakeMonitorHeardSpeech=false;
    return;
  }
  const clip=makeWavBlob(wakeMonitorChunks,16000);
  wakeMonitorChunks=[];
  wakeMonitorSpeechMs=0;
  wakeMonitorSilenceMs=0;
  wakeMonitorHeardSpeech=false;
  wakeMonitorTranscribing=true;
  try{
    const heard=await transcribeWhisperCppText(clip,getWhisperCommandLang());
    await processWakeTranscript(heard);
  }catch(err){
    wakeDebug('wake-transcribe-error', String(err?.message||err));
  }finally{
    wakeMonitorTranscribing=false;
  }
}

async function setupWakeWordListener(){
  stopWakeWordListener();
  if(!cfg.sttEnabled || !cfg.wakeWordEnabled || isListening) return;
  if(getSTTEngine()!=='local') return;
  const resolved=getEffectiveWhisperPaths();
  if(!resolved.exe || !resolved.model || !fs.existsSync(resolved.exe) || !fs.existsSync(resolved.model)) return;
  if(getWakeEngine()!=='porcupine'){
    try{
      wakeMonitorStream=await navigator.mediaDevices.getUserMedia({
        audio:{
          deviceId:cfg.micDeviceId?{exact:cfg.micDeviceId}:undefined,
          channelCount:1,
          ...getNoisePresetConstraints()
        }
      });
      const AC=window.AudioContext||window.webkitAudioContext;
      wakeMonitorContext=new AC({sampleRate:16000});
      wakeMonitorSource=wakeMonitorContext.createMediaStreamSource(wakeMonitorStream);
      wakeMonitorProcessor=wakeMonitorContext.createScriptProcessor(4096,1,1);
      wakeMonitorSilencer=wakeMonitorContext.createGain();
      wakeMonitorSilencer.gain.value=0;
      wakeMonitorProcessor.onaudioprocess=e=>{
        if(!cfg.wakeWordEnabled || isListening || wakeMonitorTranscribing || isThinking || ttsBusy) return;
        const input=e.inputBuffer.getChannelData(0);
        wakeMonitorChunks.push(new Float32Array(input));
        trimWakeChunks();
        let sum=0;
        for(let i=0;i<input.length;i++) sum+=input[i]*input[i];
        const rms=Math.sqrt(sum/input.length);
        const chunkMs=(input.length/(wakeMonitorContext?.sampleRate||16000))*1000;
        const threshold=Math.max(0.005,Math.min(cfg.wakeSensitivity||((cfg.sttSensitivity||0.014)*0.6),0.025));
        if(rms>threshold){
          wakeMonitorHeardSpeech=true;
          wakeMonitorSpeechMs+=chunkMs;
          wakeMonitorSilenceMs=0;
          if(wakeMonitorSpeechMs>=WAKE_MIN_SPEECH_MS*0.5) setWakeMonitorPreview('Speech detected...');
        }else if(wakeMonitorHeardSpeech){
          wakeMonitorSilenceMs+=chunkMs;
          if(wakeMonitorSilenceMs>=(cfg.wakeSilenceMs||260)) flushWakeMonitor();
        }
        if(wakeMonitorHeardSpeech && wakeMonitorSpeechMs>=(cfg.wakeSpeechWindowMs||1400)) flushWakeMonitor();
      };
      wakeMonitorSource.connect(wakeMonitorProcessor);
      wakeMonitorProcessor.connect(wakeMonitorSilencer);
      wakeMonitorSilencer.connect(wakeMonitorContext.destination);
      setWakeMonitorPreview(`Armed for "${cfg.wakeWordPhrase||'hey mascot'}"`);
      setVoiceHud('wake',`Wake armed for "${cfg.wakeWordPhrase||'hey mascot'}"`);
      updateSTTUI();
      return;
    }catch(err){
      console.error('[Wake browser init]',err);
      showInterim(`Wake setup failed: ${String(err.message||err).slice(0,80)}`);
      setTimeout(()=>showInterim(''),3500);
      stopWakeWordListener();
      return;
    }
  }
  const ready=getPorcupineReadiness();
  if(!ready.sdkReady || !ready.accessKey || !ready.keywordReady) return;
  try{
    const sensitivity=Math.max(0.2,Math.min(Number(cfg.porcupineSensitivity||0.55),0.95));
    porcupineHandle=new Porcupine(String(cfg.porcupineAccessKey||'').trim(), [ready.keywordPath], [sensitivity]);
    const frameLength=porcupineHandle.frameLength || 512;
    const deviceIndex=getPorcupineDeviceIndex();
    porcupineRecorder=deviceIndex>=0 ? new PvRecorder(frameLength, deviceIndex) : new PvRecorder(frameLength);
    porcupineRecorder.start();
    porcupineLoopActive=true;
    setWakeMonitorPreview(`Porcupine armed for "${cfg.wakeWordPhrase||'hey mascot'}"`);
    setVoiceHud('wake',`Wake armed for "${cfg.wakeWordPhrase||'hey mascot'}"`);
    updateSTTUI();
    (async ()=>{
      while(porcupineLoopActive && porcupineRecorder?.isRecording){
        const frame=await porcupineRecorder.read();
        if(!porcupineLoopActive || !cfg.wakeWordEnabled || isListening || isThinking || ttsBusy) continue;
        const keywordIndex=porcupineHandle.process(frame);
        if(keywordIndex>=0){
          pushWakeHistory(cfg.wakeWordPhrase||'hey mascot',true);
          setWakeMonitorPreview(`Heard: ${cfg.wakeWordPhrase||'hey mascot'}`);
          triggerWakeListening();
        }
      }
    })().catch(err=>{
      console.error('[Porcupine wake]',err);
      showInterim(`Wake listener failed: ${String(err.message||err).slice(0,80)}`);
      setTimeout(()=>showInterim(''),3500);
      stopWakeWordListener();
      updateSTTUI();
    });
  }catch(err){
    console.error('[Porcupine init]',err);
    showInterim(`Wake setup failed: ${String(err.message||err).slice(0,80)}`);
    setTimeout(()=>showInterim(''),3500);
    stopWakeWordListener();
  }
}

// ─── Voice engine tabs ────────────────────────────────────
function setVoiceEngine(ve){
  currentVoiceEngine=ve;
  document.querySelectorAll('.vetab').forEach(t=>t.classList.toggle('active',t.dataset.ve===ve));
  document.querySelectorAll('.voice-panel').forEach(p=>p.classList.toggle('active',p.id===`ve-${ve}`));
  cfg.voiceEngine=ve;
}
document.querySelectorAll('.vetab').forEach(t=>t.onclick=()=>setVoiceEngine(t.dataset.ve));

// System voices
function loadSystemVoices(){
  const load=()=>{
    synthVoices=window.speechSynthesis.getVoices();
    renderSystemVoiceGrid();
    pickPreferredVoice();
  };
  if(window.speechSynthesis.onvoiceschanged!==undefined) window.speechSynthesis.onvoiceschanged=load;
  setTimeout(load,600);
}

function renderSystemVoiceGrid(){
  const grid=document.getElementById('system-voice-grid');
  if(!grid||!synthVoices.length)return;
  grid.innerHTML='';
  synthVoices.forEach(v=>{
    const div=document.createElement('div');
    div.className='voice-item'+(cfg.systemVoice===v.name?' selected':'');
    div.innerHTML=`<div class="vi-name">${v.name}</div><div class="vi-lang">${v.lang}</div>`;
    div.onclick=()=>{
      cfg.systemVoice=v.name;
      grid.querySelectorAll('.voice-item').forEach(i=>i.classList.remove('selected'));
      div.classList.add('selected');
      pickPreferredVoice();
    };
    grid.appendChild(div);
  });
}

function pickPreferredVoice(){
  const target=cfg.systemVoice||'';
  if(target) preferredVoice=synthVoices.find(v=>v.name===target)||null;
  if(!preferredVoice){
    const prio=['Microsoft Aria','Microsoft Jenny','Microsoft Zira','Microsoft Hazel'];
    for(const p of prio){preferredVoice=synthVoices.find(v=>v.name.startsWith(p));if(preferredVoice)break;}
  }
  if(!preferredVoice) preferredVoice=synthVoices.find(v=>v.lang.startsWith('en'))||synthVoices[0]||null;
}

// ElevenLabs load voices
document.getElementById('eleven-load-voices').onclick=async()=>{
  const key=val('eleven-key');if(!key)return alert('Enter your ElevenLabs API key first.');
  cfg.elevenKey=key;
  try{
    const r=await fetch('https://api.elevenlabs.io/v1/voices',{headers:{'xi-api-key':key}});
    const data=await r.json();
    const grid=document.getElementById('eleven-voice-grid');
    grid.innerHTML='';
    (data.voices||[]).forEach(v=>{
      const div=document.createElement('div');
      div.className='voice-item'+(selectedElevenVoiceId===v.voice_id?' selected':'');
      div.innerHTML=`<div class="vi-name">${v.name}</div><div class="vi-lang">${v.labels?.accent||v.category||''}</div>`;
      div.onclick=()=>{
        selectedElevenVoiceId=v.voice_id;cfg.elevenVoiceId=v.voice_id;
        grid.querySelectorAll('.voice-item').forEach(i=>i.classList.remove('selected'));
        div.classList.add('selected');
      };
      grid.appendChild(div);
    });
  }catch(e){alert('Failed to load voices: '+e.message);}
};

// Voice preview
document.getElementById('voice-preview-btn').onclick=()=>enqueueTTS('Hello! I am your AI companion. How are you today?');
document.getElementById('eleven-preview-btn').onclick=()=>enqueueTTS('Hello! I am your AI companion. How are you today?');

function saveVoiceSettings(){
  cfg.voiceEngine=currentVoiceEngine;
  cfg.ttsEnabled=document.getElementById('tog-tts').checked;
  cfg.elevenKey=val('eleven-key');cfg.elevenModel=val('eleven-model');
  cfg.elevenVoiceId=selectedElevenVoiceId||cfg.elevenVoiceId;
  cfg.piperPath=val('piper-path');cfg.piperVoice=val('piper-voice');
  cfg.openaiTTSKey=val('openai-tts-key');
  cfg.openaiTTSModel=val('openai-tts-model');
  cfg.openaiTTSVoice=openAITTSVoice;
  ipcRenderer.send('save-config',{...cfg});
  flash('voice-save-ok');
  updateHomeCards();
}

function saveMicSettings(){
  cfg.sttEnabled=document.getElementById('tog-stt').checked;
  cfg.sttEngine=val('stt-engine')||'openai';
  cfg.sttLanguage=val('stt-language')||'auto';
  cfg.autoMicStop=document.getElementById('tog-stt-auto-stop')?.checked!==false;
  cfg.autoMicSend=document.getElementById('tog-stt-auto-send')?.checked!==false;
  cfg.sttHoldToTalk=document.getElementById('tog-stt-hold')?.checked===true;
  cfg.wakeWordEnabled=document.getElementById('tog-stt-wake')?.checked===true;
  cfg.wakeWordPhrase=(val('stt-wake-word')||'hey mascot').trim();
  cfg.wakeEngine=val('wake-engine')||'browser';
  cfg.wakeWordAliases=val('stt-wake-aliases');
  cfg.porcupineAccessKey=val('porcupine-access-key');
  cfg.porcupineKeywordPath=val('porcupine-keyword-path');
  cfg.porcupineSensitivity=parseFloat(val('porcupine-sensitivity')||'0.55');
  cfg.sttBilingualBias=val('stt-bilingual-bias')||'off';
  cfg.sttNoisePreset=val('stt-noise-preset')||'medium';
  cfg.sttMode=val('stt-mode')||'chat';
  cfg.micDeviceId=val('stt-device');
  cfg.sttSilenceTimeoutMs=parseInt(val('stt-silence-timeout')||'1600',10);
  cfg.sttSensitivity=parseFloat(val('stt-sensitivity')||'0.014');
  cfg.wakeSensitivity=parseFloat(val('wake-sensitivity')||'0.010');
  cfg.wakeSpeechWindowMs=parseInt(val('wake-window-ms')||'2200',10);
  cfg.wakeFollowupEnabled=document.getElementById('tog-wake-followup')?.checked!==false;
  cfg.wakeFollowupMs=parseInt(val('wake-followup-ms')||'12000',10);
  cfg.wakeListenAfterReply=document.getElementById('tog-wake-listen-reply')?.checked!==false;
  cfg.wakeRearmAfterSend=document.getElementById('tog-wake-rearm-send')?.checked===true;
  cfg.voiceHudEnabled=document.getElementById('tog-voice-hud')?.checked!==false;
  cfg.voiceInterruptEnabled=document.getElementById('tog-voice-interrupt')?.checked!==false;
  cfg.voiceConfirmActions=document.getElementById('tog-voice-confirm')?.checked!==false;
  cfg.voiceIntentRouting=val('voice-intent-routing')||'hybrid';
  cfg.voiceCommandTraining=val('voice-command-training');
  cfg.whisperCppPath=val('whispercpp-path');
  cfg.whisperCppModel=val('whispercpp-model');
  saveCurrentMicProfile();
  ipcRenderer.send('save-config',{...cfg});
  flash('mic-save-ok');setupMic();updateHomeCards();
  updateSTTUI();
  setupWakeWordListener();
}

document.getElementById('voice-save-btn').onclick=saveVoiceSettings;
document.getElementById('mic-save-btn').onclick=saveMicSettings;
document.getElementById('mic-reset-btn').onclick=resetMicSettings;

// ─── TTS ──────────────────────────────────────────────────
const MOOD_TTS={
  neutral:{rate:1.0,pitch:1.0},  happy:  {rate:1.08,pitch:1.08},
  excited:{rate:1.2,pitch:1.15}, shy:    {rate:0.95,pitch:1.06},
  sad:    {rate:0.85,pitch:0.9}, hurt:   {rate:0.88,pitch:0.88},
  caring: {rate:0.93,pitch:1.03},playful:{rate:1.1,pitch:1.1},
  annoyed:{rate:1.05,pitch:0.93},
};
function getMoodTTS(){return MOOD_TTS[mem.currentMood||'neutral']||MOOD_TTS.neutral;}

function splitSentences(text){
  return text.match(/[^.!?。！？]*[.!?。！？]+["']?(?:\s|$)|[^.!?。！？]+$/g)
    ?.map(s=>s.trim()).filter(s=>s.length>2)||[text];
}
function cleanForTTS(text){
  return text.replace(/\*+/g,'').replace(/#+\s*/g,'').replace(/`+/g,'')
    .replace(/\[.*?\]/g,'').replace(/https?:\/\/\S+/g,'link')
    .replace(/\s+/g,' ').trim().substring(0,500);
}

function enqueueTTS(text){
  if(!cfg.ttsEnabled)return;
  const clean=cleanForTTS(text);if(!clean||clean.length<2)return;
  ttsQueue.push(clean);
  if(!ttsBusy)processTTSQueue();
}

function processTTSQueue(){
  if(!ttsQueue.length){
    ttsBusy=false;setBadge('');
    if(pendingFollowupAfterSpeech){
      pendingFollowupAfterSpeech=false;
      armFollowupWindow();
    } else if(isFollowupWindowActive()) setVoiceHud('followup','Ask a follow-up now...');
    else {
      clearVoiceHud(600);
      if(cfg.wakeWordEnabled && !isListening && !isThinking) queueWakeResume(120);
    }
    return;
  }
  ttsBusy=true;setBadge('speaking');
  const text=ttsQueue.shift();
  let speak;
  switch(cfg.voiceEngine){
    case 'elevenlabs':speak=speakElevenLabs;break;
    case 'openaitts': speak=speakOpenAITTS;break;
    case 'piper':     speak=speakPiper;break;
    default:          speak=speakSystem;
  }
  speak(text).then(()=>processTTSQueue()).catch(()=>processTTSQueue());
}

let piperCurrentAudio=null;
function stopTTS(){
  ttsQueue=[];ttsBusy=false;setBadge('');
  window.speechSynthesis.cancel();
  if(piperCurrentAudio){try{piperCurrentAudio.pause();}catch(e){}piperCurrentAudio=null;}
  if(pendingFollowupAfterSpeech) {
    pendingFollowupAfterSpeech=false;
    armFollowupWindow();
  } else if(isFollowupWindowActive()) queueWakeResume(150);
  else if(cfg.wakeWordEnabled && !isListening && !isThinking) queueWakeResume(120);
}
function setBadge(state){
  const b=document.getElementById('tts-badge');if(!b)return;
  b.className=state==='speaking'?'tts-badge speaking':'tts-badge';
  b.textContent=state==='speaking'?'🔊 speaking…':'';
  if(state==='speaking') setVoiceHud('speaking','Speaking...');
}

function speakSystem(text){
  return new Promise(resolve=>{
    window.speechSynthesis.cancel();
    const utt=new SpeechSynthesisUtterance(text);
    const p=getMoodTTS();utt.rate=p.rate;utt.pitch=p.pitch;utt.volume=1;
    if(preferredVoice)utt.voice=preferredVoice;
    const wd=setTimeout(()=>{window.speechSynthesis.cancel();resolve();},text.length*100+4000);
    utt.onend=utt.onerror=()=>{clearTimeout(wd);resolve();};
    window.speechSynthesis.speak(utt);
  });
}

async function speakElevenLabs(text){
  const key=cfg.elevenKey,vid=cfg.elevenVoiceId||'EXAVITQu4vr4xnSDxMaL',model=cfg.elevenModel||'eleven_turbo_v2_5';
  if(!key)return speakSystem(text);
  const moodMap={
    excited:{stability:0.3,similarity_boost:0.7,style:0.8},
    happy:  {stability:0.4,similarity_boost:0.75,style:0.6},
    sad:    {stability:0.75,similarity_boost:0.6,style:0.15},
    hurt:   {stability:0.8,similarity_boost:0.6,style:0.1},
    shy:    {stability:0.65,similarity_boost:0.7,style:0.25},
    caring: {stability:0.55,similarity_boost:0.75,style:0.4},
    annoyed:{stability:0.5,similarity_boost:0.65,style:0.6},
    playful:{stability:0.35,similarity_boost:0.7,style:0.7},
    neutral:{stability:0.5,similarity_boost:0.75,style:0.4},
  };
  const vs=moodMap[mem.currentMood||'neutral']||moodMap.neutral;
  try{
    const res=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream`,{
      method:'POST',headers:{'xi-api-key':key,'Content-Type':'application/json'},
      body:JSON.stringify({text,model_id:model,voice_settings:{...vs,use_speaker_boost:true}}),
    });
    if(!res.ok)throw new Error('ElevenLabs '+res.status);
    const buf=await res.arrayBuffer();
    const ac=new(window.AudioContext||window.webkitAudioContext)();
    const decoded=await ac.decodeAudioData(buf);
    const src=ac.createBufferSource();src.buffer=decoded;src.connect(ac.destination);src.start();
    return new Promise(resolve=>{src.onended=()=>{ac.close();resolve();};});
  }catch(e){console.warn('[ElevenLabs]',e.message);return speakSystem(text);}
}

async function speakOpenAITTS(text){
  const key=cfg.openaiTTSKey||cfg.openaiKey;
  if(!key)return speakSystem(text);
  try{
    const res=await fetch('https://api.openai.com/v1/audio/speech',{
      method:'POST',headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},
      body:JSON.stringify({model:cfg.openaiTTSModel||'tts-1',voice:cfg.openaiTTSVoice||'nova',
        input:text,speed:getMoodTTS().rate}),
    });
    if(!res.ok)throw new Error('OpenAI TTS '+res.status);
    const buf=await res.arrayBuffer();
    const ac=new(window.AudioContext||window.webkitAudioContext)();
    const decoded=await ac.decodeAudioData(buf);
    const src=ac.createBufferSource();src.buffer=decoded;src.connect(ac.destination);src.start();
    return new Promise(resolve=>{src.onended=()=>{ac.close();resolve();};});
  }catch(e){console.warn('[OpenAI TTS]',e.message);return speakSystem(text);}
}

function piperGenerate(text){
  return new Promise((resolve,reject)=>{
    if(!cfg.piperPath||!cfg.piperVoice){reject(new Error('not configured'));return;}
    const tmp=path.join(os.tmpdir(),`piper_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
    const safe=cleanForTTS(text).replace(/"/g,"'").replace(/\n/g,' ');
    exec(`echo "${safe}" | "${cfg.piperPath}" --model "${cfg.piperVoice}" --output_file "${tmp}"`,
      err=>err?reject(err):resolve(tmp));
  });
}
function piperPlayFile(f){
  return new Promise(resolve=>{
    const audio=new Audio(`file://${f}`);
    piperCurrentAudio=audio;
    audio.onended=()=>{piperCurrentAudio=null;try{fs.unlinkSync(f);}catch(e){}resolve();};
    audio.onerror=()=>{piperCurrentAudio=null;try{fs.unlinkSync(f);}catch(e){}resolve();};
    audio.play().catch(()=>resolve());
  });
}
async function speakPiper(fullText){
  const sentences=splitSentences(cleanForTTS(fullText));
  if(!sentences.length)return;
  const gens=sentences.map(s=>piperGenerate(s).catch(()=>null));
  for(const gen of gens){const f=await gen;if(f)await piperPlayFile(f);}
}

document.getElementById('openai-tts-preview')?.addEventListener('click',()=>enqueueTTS('Hello! I\'m your AI companion. How are you today?'));

// ─── Whisper STT ──────────────────────────────────────────
// Uses MediaRecorder (push-to-talk) + OpenAI Whisper API.
// This works reliably in all Electron versions unlike webkitSpeechRecognition.

let micStream       = null;
let recordingTimer  = null;
let recordingSeconds = 0;
let audioContext    = null;
let audioSource     = null;
let audioProcessor  = null;
let audioSilencer   = null;
let pcmChunks       = [];
let silenceMs       = 0;
let heardSpeech     = false;
let transcribeAbortController=null;
let transcribeChildProcess=null;
let transcriptionCanceled=false;

function getWhisperKey(){
  return cfg.openaiTTSKey || cfg.openaiKey || '';
}

function getSTTEngine(){
  return cfg.sttEngine || 'openai';
}

function getSTTLanguage(){
  return cfg.sttLanguage || 'auto';
}

function resolveConfiguredPath(rawPath){
  const value=(rawPath||'').trim();
  if(!value) return '';
  return path.isAbsolute(value)?value:path.resolve(value);
}

function getBundledWhisperPaths(){
  const roots=[];
  if(typeof process!=='undefined'){
    if(process.resourcesPath) roots.push(path.join(process.resourcesPath,'mic','whisper-bin-x64','Release'));
    roots.push(path.join(process.cwd(),'mic','whisper-bin-x64','Release'));
    roots.push(path.join(__dirname,'mic','whisper-bin-x64','Release'));
  }
  for(const root of roots){
    const exe=path.join(root,'whisper-cli.exe');
    const model=path.join(root,'models','ggml-base.bin');
    if(fs.existsSync(exe) && fs.existsSync(model)) return { exe, model };
  }
  return { exe:'', model:'' };
}

function getEffectiveWhisperPaths(){
  const configuredExe=resolveConfiguredPath(cfg.whisperCppPath);
  const configuredModel=resolveConfiguredPath(cfg.whisperCppModel);
  if(configuredExe && configuredModel && fs.existsSync(configuredExe) && fs.existsSync(configuredModel)){
    return { exe:configuredExe, model:configuredModel, source:'configured' };
  }
  const bundled=getBundledWhisperPaths();
  if(bundled.exe && bundled.model) return { ...bundled, source:'bundled' };
  return { exe:configuredExe, model:configuredModel, source:'missing' };
}

function showInterim(text){
  const el=document.getElementById('mic-interim');
  if(!el)return;
  el.textContent=text;
  el.classList.toggle('active',!!text);
  tv('voice-metric-runtime',text?text.replace(/[".]+$/,''):'Idle');
}

function setListeningVisuals(active){
  document.getElementById('mic-btn')?.classList.toggle('listening',!!active);
  document.getElementById('chat-canvas-wrap')?.classList.toggle('listening',!!active);
}

function updateVoiceDashboard(){
  tv('voice-metric-engine',getSTTEngine()==='local'?'Local whisper.cpp':'OpenAI Whisper');
  tv('voice-metric-wake',cfg.wakeWordEnabled?`On · ${cfg.wakeWordPhrase||'hey mascot'}`:'Off');
  tv('voice-metric-routing',(cfg.voiceIntentRouting||'hybrid').replace(/^./,c=>c.toUpperCase()));
  if(cfg.voiceHudEnabled===false) document.getElementById('voice-hud')?.classList.remove('active');
}

function playWakeCue(){
  try{
    const AC=window.AudioContext||window.webkitAudioContext;
    const ac=new AC();
    const osc=ac.createOscillator();
    const gain=ac.createGain();
    osc.type='sine';
    osc.frequency.value=880;
    gain.gain.setValueAtTime(0.001,ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08,ac.currentTime+0.02);
    gain.gain.exponentialRampToValueAtTime(0.001,ac.currentTime+0.18);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime+0.2);
    osc.onended=()=>ac.close();
  }catch{}
}

function setTranscribingUI(active,text='Transcribing...'){
  const bar=document.getElementById('stt-transcribing-bar');
  const label=document.getElementById('stt-transcribing-text');
  if(label) label.textContent=text;
  bar?.classList.toggle('active',!!active);
}

function showTranscriptPreview(text){
  pendingTranscript=text||'';
  const bar=document.getElementById('stt-preview-bar');
  const label=document.getElementById('stt-preview-text');
  if(label) label.textContent=pendingTranscript;
  bar?.classList.add('active');
}

function hideTranscriptPreview(clear=false){
  document.getElementById('stt-preview-bar')?.classList.remove('active');
  if(clear) pendingTranscript='';
}

function discardPendingTranscript(){
  const inp=document.getElementById('chat-input');
  if(inp && pendingTranscript){
    const suffix=` ${pendingTranscript}`;
    if(inp.value===pendingTranscript) inp.value='';
    else if(inp.value.endsWith(suffix)) inp.value=inp.value.slice(0,-suffix.length);
  }
  pendingTranscript='';
  hideTranscriptPreview(true);
}

function cancelTranscription(){
  transcriptionCanceled=true;
  transcribeAbortController?.abort?.();
  transcribeAbortController=null;
  if(transcribeChildProcess && !transcribeChildProcess.killed){
    try{transcribeChildProcess.kill();}catch{}
  }
  transcribeChildProcess=null;
  setTranscribingUI(false);
  showInterim('Transcription canceled');
  setTimeout(()=>showInterim(''),2000);
}

function updateSTTUI(){
  const dot=document.getElementById('whisper-key-dot');
  const txt=document.getElementById('whisper-key-status');
  const openaiBox=document.getElementById('stt-openai-box');
  const localBox=document.getElementById('stt-local-box');
  const wakeBrowserBox=document.getElementById('wake-browser-box');
  const wakePorcupineBox=document.getElementById('wake-porcupine-box');
  const wakePorcupineTuning=document.getElementById('wake-porcupine-tuning');
  const modeChip=document.getElementById('stt-mode-chip');
  const wakeChip=document.getElementById('stt-wake-chip');
  const engine=getSTTEngine();
  const wakeEngine=getWakeEngine();
  if(openaiBox) openaiBox.style.display=engine==='openai'?'block':'none';
  if(localBox) localBox.style.display=engine==='local'?'block':'none';
  if(wakeBrowserBox) wakeBrowserBox.style.display=wakeEngine==='browser'?'block':'none';
  if(wakePorcupineBox) wakePorcupineBox.style.display=wakeEngine==='porcupine'?'grid':'none';
  if(wakePorcupineTuning) wakePorcupineTuning.style.display=wakeEngine==='porcupine'?'grid':'none';
  if(modeChip) modeChip.textContent=`mode: ${cfg.sttMode||'chat'}`;
  if(wakeChip) wakeChip.textContent=`wake word: ${cfg.wakeWordEnabled?(cfg.wakeWordPhrase||'on'):'off'}`;
  updateVoiceDashboard();
  if(!dot||!txt)return;
  if(engine==='local'){
    const resolved=getEffectiveWhisperPaths();
    const porcupine=getPorcupineReadiness();
    const ready=!!(resolved.exe&&resolved.model&&fs.existsSync(resolved.exe)&&fs.existsSync(resolved.model));
    dot.className=`status-dot ${ready?'green':'yellow'}`;
    txt.textContent=ready
      ? (resolved.source==='bundled'?'Bundled whisper.cpp is ready for this app build':'Custom local whisper.cpp path is configured')
      : 'Add whisper.cpp executable and model path below';
    txt.style.color=ready?'var(--green)':'var(--yellow)';
    if(ready && cfg.wakeWordEnabled && !isListening){
      if(getWakeEngine()==='porcupine'){
        if(!porcupine.sdkReady) txt.textContent='Install Porcupine packages to enable wake word runtime';
        else if(!porcupine.accessKey) txt.textContent='Add your Porcupine AccessKey to enable wake word';
        else if(!porcupine.keywordReady) txt.textContent='Add your Porcupine .ppn keyword file to enable wake word';
        else txt.textContent=`Porcupine wake listener armed for "${cfg.wakeWordPhrase||'hey mascot'}"`;
      }else{
        txt.textContent=`Built-in local wake listener armed for "${cfg.wakeWordPhrase||'hey mascot'}"`;
      }
    }
    return;
  }
  if(getWhisperKey()){
    dot.className='status-dot green';
    txt.textContent='OpenAI Whisper is configured';
    txt.style.color='var(--green)';
  }else{
    dot.className='status-dot grey';
    txt.textContent='No OpenAI key - add one in AI Model -> OpenAI tab';
    txt.style.color='var(--muted)';
  }
}

function ensureSTTConfigured(){
  if(getSTTEngine()==='local'){
    const resolved=getEffectiveWhisperPaths();
    if(resolved.exe&&resolved.model&&fs.existsSync(resolved.exe)&&fs.existsSync(resolved.model)) return true;
    showInterim('Add whisper.cpp executable and model path in Voice Settings');
    setTimeout(()=>showInterim(''),4000);
    return false;
  }
  if(getWhisperKey()) return true;
  showInterim('No OpenAI key - add one in AI Model -> OpenAI tab');
  setTimeout(()=>showInterim(''),3500);
  return false;
}

function cleanupRecording(){
  clearInterval(recordingTimer);
  recordingTimer=null;
  setListeningVisuals(false);
  if(audioProcessor) audioProcessor.onaudioprocess=null;
  audioSource?.disconnect();
  audioProcessor?.disconnect();
  audioSilencer?.disconnect();
  micStream?.getTracks().forEach(t=>t.stop());
  audioContext?.close?.().catch?.(()=>{});
  micStream=null;
  audioContext=null;
  audioSource=null;
  audioProcessor=null;
  audioSilencer=null;
  silenceMs=0;
  heardSpeech=false;
}

function mergeFloat32Chunks(chunks){
  const length=chunks.reduce((sum,chunk)=>sum+chunk.length,0);
  const merged=new Float32Array(length);
  let offset=0;
  chunks.forEach(chunk=>{merged.set(chunk,offset);offset+=chunk.length;});
  return merged;
}

function makeWavBlob(chunks,sampleRate){
  const samples=mergeFloat32Chunks(chunks);
  const buffer=new ArrayBuffer(44+samples.length*2);
  const view=new DataView(buffer);
  const writeString=(offset,str)=>{for(let i=0;i<str.length;i++)view.setUint8(offset+i,str.charCodeAt(i));};
  writeString(0,'RIFF');
  view.setUint32(4,36+samples.length*2,true);
  writeString(8,'WAVE');
  writeString(12,'fmt ');
  view.setUint32(16,16,true);
  view.setUint16(20,1,true);
  view.setUint16(22,1,true);
  view.setUint32(24,sampleRate,true);
  view.setUint32(28,sampleRate*2,true);
  view.setUint16(32,2,true);
  view.setUint16(34,16,true);
  writeString(36,'data');
  view.setUint32(40,samples.length*2,true);
  let offset=44;
  for(const sample of samples){
    const s=Math.max(-1,Math.min(1,sample));
    view.setInt16(offset,s<0?s*0x8000:s*0x7fff,true);
    offset+=2;
  }
  return new Blob([buffer],{type:'audio/wav'});
}

async function calibrateAmbientNoise(){
  if(isListening) return;
  setVoiceHud('calibrating','Calibrating microphone...');
  showInterim('Stay quiet for 3 seconds to calibrate');
  try{
    const stream=await navigator.mediaDevices.getUserMedia({
      audio:{
        deviceId:cfg.micDeviceId?{exact:cfg.micDeviceId}:undefined,
        channelCount:1,
        ...getNoisePresetConstraints()
      }
    });
    const AC=window.AudioContext||window.webkitAudioContext;
    const context=new AC({sampleRate:16000});
    const source=context.createMediaStreamSource(stream);
    const processor=context.createScriptProcessor(4096,1,1);
    let total=0, count=0;
    processor.onaudioprocess=e=>{
      const input=e.inputBuffer.getChannelData(0);
      let sum=0;
      for(let i=0;i<input.length;i++) sum+=input[i]*input[i];
      total+=Math.sqrt(sum/input.length);
      count++;
    };
    source.connect(processor);
    processor.connect(context.destination);
    await new Promise(resolve=>setTimeout(resolve,3000));
    processor.disconnect(); source.disconnect();
    stream.getTracks().forEach(t=>t.stop());
    context.close().catch(()=>{});
    const floor=count?total/count:0.006;
    cfg.ambientNoiseFloor=floor;
    cfg.sttSensitivity=Math.max(0.006,Math.min(0.04,Number((floor*2.4).toFixed(3))));
    cfg.wakeSensitivity=Math.max(0.006,Math.min(0.03,Number((floor*1.8).toFixed(3))));
    setEl('stt-sensitivity',cfg.sttSensitivity);
    tv('stt-sensitivity-val',cfg.sttSensitivity.toFixed(3));
    setEl('wake-sensitivity',cfg.wakeSensitivity);
    tv('wake-sensitivity-val',cfg.wakeSensitivity.toFixed(3));
    showToast(`Mic calibrated at ${floor.toFixed(3)}`);
    showInterim('Calibration complete');
    clearVoiceHud(1800);
  }catch(err){
    console.error('[Mic calibration]',err);
    showInterim('Calibration failed');
    clearVoiceHud(1800);
  }
}

async function applyTranscribedText(text){
  const clean=cleanTranscriptText(text,{stripWake:voiceListeningMode==='wake'});
  if(!clean){
    setTranscribingUI(false);
    showInterim('Nothing detected - try again');
    micInputSnapshot='';
    clearVoiceHud(1200);
    queueWakeResume(250);
    setTimeout(()=>showInterim(''),2500);
    return;
  }
  setTranscribingUI(false);
  const consumed=await handleVoiceTranscript(clean,{applyToInput:true,skipWake:true});
  if(consumed){
    clearVoiceHud(1200);
    queueWakeResume(350);
    voiceListeningMode='manual';
    return;
  }
  const inp=document.getElementById('chat-input');
  inp.value=(micInputSnapshot?`${micInputSnapshot} `:'')+clean;
  inp.style.height='auto';
  inp.style.height=Math.min(inp.scrollHeight,100)+'px';
  const preview=clean.length>60?clean.slice(0,60)+'...':clean;
  showInterim(`OK: "${preview}"`);
  if(cfg.autoMicSend!==false && !isThinking){
    hideTranscriptPreview(true);
    setTimeout(()=>send(),120);
    return;
  }
  showTranscriptPreview(clean);
  setVoiceHud('ready','Transcript ready');
  inp.focus();
  micInputSnapshot='';
  setTimeout(()=>showInterim(''),2500);
}

async function transcribeAudio(audioBlob){
  if(getSTTEngine()==='local') return transcribeWithWhisperCpp(audioBlob);
  return transcribeWithOpenAI(audioBlob);
}

async function transcribeWhisperCppText(audioBlob,language='auto'){
  const { exe, model }=getEffectiveWhisperPaths();
  if(!exe||!model) throw new Error('Add whisper.cpp executable and model path first');
  if(!fs.existsSync(exe)) throw new Error('whisper.cpp executable not found');
  if(!fs.existsSync(model)) throw new Error('whisper.cpp model file not found');
  const tempDir=path.join(os.tmpdir(),'desktop-mascot-stt');
  fs.mkdirSync(tempDir,{recursive:true});
  const stamp=`${Date.now()}-${Math.random().toString(16).slice(2,8)}`;
  const audioPath=path.join(tempDir,`recording-${stamp}.wav`);
  const outputBase=path.join(tempDir,`transcript-${stamp}`);
  const outputPath=`${outputBase}.txt`;
  try{
    fs.writeFileSync(audioPath,Buffer.from(await audioBlob.arrayBuffer()));
    const args=['-m',model,'-f',audioPath,'-otxt','-of',outputBase];
    if(language && language!=='auto') args.push('-l',language);
    await new Promise((resolve,reject)=>{
      const child=execFile(exe,args,{windowsHide:true},(err,stdout,stderr)=>{
        if(err) reject(new Error(stderr?.trim()||stdout?.trim()||err.message));
        else resolve();
      });
      transcribeChildProcess=child;
    });
    return fs.existsSync(outputPath)?fs.readFileSync(outputPath,'utf8').trim():'';
  }finally{
    transcribeChildProcess=null;
    [audioPath,outputPath].forEach(f=>{try{fs.existsSync(f)&&fs.unlinkSync(f);}catch{}});
    try{
      fs.readdirSync(tempDir)
        .filter(name=>name.startsWith(`transcript-${stamp}`))
        .forEach(name=>{try{fs.unlinkSync(path.join(tempDir,name));}catch{}});
    }catch{}
  }
}

async function transcribeWithOpenAI(audioBlob){
  const key=getWhisperKey();
  if(!key){showInterim('');return;}
  transcriptionCanceled=false;
  transcribeAbortController=new AbortController();
  const form=new FormData();
  form.append('file',audioBlob,'recording.wav');
  form.append('model','whisper-1');
  form.append('response_format','json');
  if(getSTTLanguage()!=='auto') form.append('language',getSTTLanguage());
  try{
    const res=await fetch('https://api.openai.com/v1/audio/transcriptions',{
      method:'POST',
      headers:{Authorization:`Bearer ${key}`},
      body:form,
      signal:transcribeAbortController.signal,
    });
    if(!res.ok){
      const errText=await res.text();
      throw new Error(`Whisper ${res.status}: ${errText}`);
    }
    const data=await res.json();
    await applyTranscribedText(data.text||'');
  }catch(err){
    if(err.name==='AbortError' || transcriptionCanceled) return;
    console.error('[OpenAI STT]',err);
    const msg=err.message.includes('401')?'Invalid API key - check AI Model settings'
             :err.message.includes('429')?'Rate limit hit - try again in a moment'
             :err.message.includes('fetch')||err.message.includes('network')?'No internet connection'
             :String(err.message||err).slice(0,70);
    showInterim(msg);
    setTimeout(()=>showInterim(''),4000);
  }finally{
    transcribeAbortController=null;
    if(!isListening) queueWakeResume(250);
  }
}

async function transcribeWithWhisperCpp(audioBlob){
  transcriptionCanceled=false;
  try{
    const text=await transcribeWhisperCppText(audioBlob,getSTTLanguage());
    await applyTranscribedText(text);
  }catch(err){
    if(transcriptionCanceled) return;
    console.error('[whisper.cpp STT]',err);
    showInterim(`Local STT failed: ${String(err.message||err).slice(0,80)}`);
    setTimeout(()=>showInterim(''),4500);
  }finally{
    transcribeChildProcess=null;
    if(!isListening) queueWakeResume(250);
  }
}

function updateMicTimer(){
  recordingSeconds++;
  const m=Math.floor(recordingSeconds/60).toString().padStart(2,'0');
  const s=(recordingSeconds%60).toString().padStart(2,'0');
  const engine=getSTTEngine()==='local'?'local':'cloud';
  showInterim(`Recording ${m}:${s} - click mic again to transcribe (${engine})`);
}

function setupMic(){
  const btn=document.getElementById('mic-btn');
  if(!btn)return;
  if(!cfg.sttEnabled){
    btn.classList.remove('active-display');
    if(isListening) stopListening(false);
    return;
  }
  btn.classList.add('active-display');
  btn.title=`${cfg.sttHoldToTalk?'Hold to talk':'Click to start recording'} - ${getSTTEngine()==='local'?'local whisper.cpp':'OpenAI Whisper'}`;
}

async function startListening(){
  if(isListening||!ensureSTTConfigured()) return;
  if(!voiceListeningMode) voiceListeningMode='manual';
  stopWakeWordListener();
  hideTranscriptPreview(true);
  setTranscribingUI(false);
  micInputSnapshot=document.getElementById('chat-input')?.value.trim()||'';
  try{
    micStream=await navigator.mediaDevices.getUserMedia({
      audio:{
        deviceId:cfg.micDeviceId?{exact:cfg.micDeviceId}:undefined,
        channelCount:1,
        ...getNoisePresetConstraints()
      }
    });
    loadMicDevices();
    const AC=window.AudioContext||window.webkitAudioContext;
    audioContext=new AC({sampleRate:16000});
    audioSource=audioContext.createMediaStreamSource(micStream);
    audioProcessor=audioContext.createScriptProcessor(4096,1,1);
    audioSilencer=audioContext.createGain();
    audioSilencer.gain.value=0;
    pcmChunks=[];
    recordingSeconds=0;
    silenceMs=0;
    heardSpeech=false;
    listeningStartedAt=Date.now();
    wakeListeningStartedAt=voiceListeningMode==='wake' ? listeningStartedAt : 0;
    isListening=true;
    audioProcessor.onaudioprocess=e=>{
      if(!isListening) return;
      const input=e.inputBuffer.getChannelData(0);
      pcmChunks.push(new Float32Array(input));
      let sum=0;
      for(let i=0;i<input.length;i++) sum+=input[i]*input[i];
      const rms=Math.sqrt(sum/input.length);
      const chunkMs=(input.length/(audioContext?.sampleRate||16000))*1000;
      const speechThreshold=Math.max(0.006,Number(cfg.sttSensitivity||0.014));
      const silenceThreshold=Math.max(0.0045, speechThreshold*0.72);
      if(rms>speechThreshold){
        heardSpeech=true;
        silenceMs=0;
      }else if(heardSpeech && rms<silenceThreshold){
        silenceMs+=chunkMs;
        if(cfg.autoMicStop!==false && silenceMs>=(cfg.sttSilenceTimeoutMs||1600)){
          stopListening(true);
        }
      }else if(heardSpeech){
        silenceMs=0;
      }else if(voiceListeningMode==='wake' && cfg.autoMicStop!==false){
        const activeFor=Date.now()-wakeListeningStartedAt;
        if(wakeListeningStartedAt && activeFor>=(cfg.sttSilenceTimeoutMs||1600)+2200){
          stopListening(true);
        }
      }
    };
    audioSource.connect(audioProcessor);
    audioProcessor.connect(audioSilencer);
    audioSilencer.connect(audioContext.destination);
  }catch(err){
    console.error('[STT] Start failed:',err);
    cleanupRecording();
    showInterim('Mic access denied or audio pipeline failed');
    setTimeout(()=>showInterim(''),4000);
    return;
  }
  setListeningVisuals(true);
  recordingTimer=setInterval(updateMicTimer,1000);
  setVoiceHud('listening',voiceListeningMode==='wake'?'Listening after wake word...':'Listening...');
  showInterim('Recording 00:00 - click mic again to transcribe');
}

function stopListening(sendAudio=true){
  if(!isListening&&!sendAudio){
    cleanupRecording();
    showInterim('');
  pcmChunks=[];
  clearVoiceHud();
  queueWakeResume(120);
  voiceListeningMode='manual';
  listeningStartedAt=0;
  wakeListeningStartedAt=0;
  return;
}
  isListening=false;
  if(!sendAudio){
    cleanupRecording();
    showInterim('');
  pcmChunks=[];
  clearVoiceHud();
  queueWakeResume(120);
  voiceListeningMode='manual';
  listeningStartedAt=0;
  wakeListeningStartedAt=0;
  return;
}
  const recordedChunks=pcmChunks;
  pcmChunks=[];
  cleanupRecording();
  listeningStartedAt=0;
  wakeListeningStartedAt=0;
  if(!recordedChunks.length){
    showInterim('Nothing recorded - try again');
    queueWakeResume(250);
    setTimeout(()=>showInterim(''),2500);
    return;
  }
  showInterim('Transcribing...');
  setVoiceHud('transcribing','Transcribing speech...');
  setTranscribingUI(true,'Transcribing speech...');
  const audioBlob=makeWavBlob(recordedChunks,16000);
  transcribeAudio(audioBlob).catch(err=>{
    console.error('[STT]',err);
    setTranscribingUI(false);
    showInterim(String(err.message||err).slice(0,80));
    setTimeout(()=>showInterim(''),4000);
  });
}

const micBtn=document.getElementById('mic-btn');
micBtn.onclick=()=>{
  if(cfg.sttHoldToTalk) return;
  if(isListening) stopListening(true);
  else            startListening();
};
micBtn.addEventListener('mousedown',e=>{
  if(!cfg.sttHoldToTalk || e.button!==0) return;
  e.preventDefault();
  startListening();
});
['mouseup','mouseleave'].forEach(evt=>micBtn.addEventListener(evt,()=>{
  if(cfg.sttHoldToTalk && isListening) stopListening(true);
}));
document.addEventListener('mouseup',()=>{
  if(cfg.sttHoldToTalk && isListening) stopListening(true);
});

document.getElementById('tog-stt').onchange=e=>{
  cfg.sttEnabled=e.target.checked;
  if(!e.target.checked){stopListening(false);cancelTranscription();hideTranscriptPreview(true);stopWakeWordListener();}
  setupMic();
  updateSTTUI();
  if(e.target.checked) setupWakeWordListener();
};
document.getElementById('stt-engine')?.addEventListener('change',e=>{
  cfg.sttEngine=e.target.value||'openai';
  setupMic();
  updateSTTUI();
});
document.getElementById('stt-language')?.addEventListener('change',e=>{
  cfg.sttLanguage=e.target.value||'auto';
});
document.getElementById('stt-device')?.addEventListener('change',e=>{
  saveCurrentMicProfile();
  cfg.micDeviceId=e.target.value||'';
  applyDeviceProfile(cfg.micDeviceId,true);
});
document.getElementById('stt-silence-timeout')?.addEventListener('input',e=>{
  const value=parseInt(e.target.value,10)||1600;
  cfg.sttSilenceTimeoutMs=value;
  tv('stt-silence-timeout-val',`${Math.round(value/100)/10}s`);
});
document.getElementById('stt-sensitivity')?.addEventListener('input',e=>{
  const value=parseFloat(e.target.value)||0.014;
  cfg.sttSensitivity=value;
  tv('stt-sensitivity-val',value.toFixed(3));
});
document.getElementById('wake-sensitivity')?.addEventListener('input',e=>{
  const value=parseFloat(e.target.value)||0.010;
  cfg.wakeSensitivity=value;
  tv('wake-sensitivity-val',value.toFixed(3));
});
document.getElementById('porcupine-sensitivity')?.addEventListener('input',e=>{
  const value=parseFloat(e.target.value)||0.55;
  cfg.porcupineSensitivity=value;
  tv('porcupine-sensitivity-val',value.toFixed(2));
});
document.getElementById('wake-window-ms')?.addEventListener('input',e=>{
  const value=parseInt(e.target.value,10)||2200;
  cfg.wakeSpeechWindowMs=value;
  tv('wake-window-ms-val',`${Math.round(value/100)/10}s`);
});
document.getElementById('wake-followup-ms')?.addEventListener('input',e=>{
  const value=parseInt(e.target.value,10)||12000;
  cfg.wakeFollowupMs=value;
  tv('wake-followup-ms-val',`${Math.round(value/1000)}s`);
});
document.getElementById('tog-stt-hold')?.addEventListener('change',e=>{
  cfg.sttHoldToTalk=e.target.checked;
  setupMic();
});
document.getElementById('tog-stt-wake')?.addEventListener('change',e=>{
  cfg.wakeWordEnabled=e.target.checked;
  updateSTTUI();
  setupWakeWordListener();
});
document.getElementById('stt-wake-word')?.addEventListener('input',e=>{
  cfg.wakeWordPhrase=e.target.value||'hey mascot';
  updateSTTUI();
  if(cfg.wakeWordEnabled) setupWakeWordListener();
});
document.getElementById('stt-wake-aliases')?.addEventListener('input',e=>{
  cfg.wakeWordAliases=e.target.value||'';
});
document.getElementById('stt-bilingual-bias')?.addEventListener('change',e=>{
  cfg.sttBilingualBias=e.target.value||'off';
});
document.getElementById('stt-noise-preset')?.addEventListener('change',e=>{
  cfg.sttNoisePreset=e.target.value||'medium';
});
document.getElementById('stt-mode')?.addEventListener('change',e=>{
  cfg.sttMode=e.target.value||'chat';
  updateSTTUI();
});
document.getElementById('tog-wake-rearm-send')?.addEventListener('change',e=>{
  cfg.wakeRearmAfterSend=e.target.checked;
});
document.getElementById('wake-engine')?.addEventListener('change',e=>{
  cfg.wakeEngine=e.target.value||'browser';
  updateSTTUI();
  if(cfg.wakeWordEnabled) setupWakeWordListener();
});
document.getElementById('voice-intent-routing')?.addEventListener('change',e=>{
  cfg.voiceIntentRouting=e.target.value||'hybrid';
});
document.getElementById('voice-command-training')?.addEventListener('input',e=>{
  cfg.voiceCommandTraining=e.target.value||'';
});
document.getElementById('voice-calibrate-btn')?.addEventListener('click',calibrateAmbientNoise);
document.getElementById('stt-cancel-btn')?.addEventListener('click',cancelTranscription);
document.getElementById('stt-edit-btn')?.addEventListener('click',()=>{
  hideTranscriptPreview(false);
  document.getElementById('chat-input')?.focus();
});
document.getElementById('stt-send-btn')?.addEventListener('click',()=>{
  hideTranscriptPreview(true);
  send();
});
document.getElementById('stt-discard-btn')?.addEventListener('click',()=>{
  discardPendingTranscript();
});
navigator.mediaDevices?.addEventListener?.('devicechange',()=>loadMicDevices());

// ─── Chat font size ───────────────────────────────────────
function applyChatFont(){
  document.querySelectorAll('.msg-bubble').forEach(b=>b.style.fontSize=currentFontSize+'px');
  document.getElementById('chat-input') && (document.getElementById('chat-input').style.fontSize=currentFontSize+'px');
  tv('font-size-display',currentFontSize);tv('font-size-val',currentFontSize+'px');
  setEl('font-size-slider',currentFontSize);
}
document.getElementById('font-dec').onclick=()=>{if(currentFontSize>11){currentFontSize--;applyChatFont();}};
document.getElementById('font-inc').onclick=()=>{if(currentFontSize<20){currentFontSize++;applyChatFont();}};
document.getElementById('font-size-slider').oninput=e=>{currentFontSize=parseInt(e.target.value);applyChatFont();};

// ─── Looks ────────────────────────────────────────────────
const THEMES={
  dark:{
    '--bg':'#07070f','--s1':'#0e0e1c','--s2':'#14142a','--s3':'#1a1a35','--s4':'#202040',
    '--border':'#252545','--border2':'#1e1e3a',
    '--pink':'#f472b6','--pink2':'#ec4899','--pink-dim':'#9d174d',
    '--text':'#f0f0ff','--text2':'#c8c8e8','--muted':'#7878a0','--muted2':'#3a3a60',
  },
  midnight:{
    '--bg':'#00000f','--s1':'#00061e','--s2':'#000d2e','--s3':'#001040','--s4':'#001850',
    '--border':'#0a1a4a','--border2':'#061230',
    '--pink':'#60a5fa','--pink2':'#3b82f6','--pink-dim':'#1d4ed8',
    '--text':'#e8f0ff','--text2':'#b0c8f0','--muted':'#5878a0','--muted2':'#1a2a50',
  },
  sakura:{
    '--bg':'#0f0508','--s1':'#1a080f','--s2':'#220d16','--s3':'#2e1220','--s4':'#3a162a',
    '--border':'#4a1a32','--border2':'#3a1228',
    '--pink':'#fb7185','--pink2':'#f43f5e','--pink-dim':'#9f1239',
    '--text':'#fff0f3','--text2':'#f0c0cc','--muted':'#a06070','--muted2':'#4a2030',
  },
  forest:{
    '--bg':'#020a04','--s1':'#051208','--s2':'#081a0c','--s3':'#0c2410','--s4':'#102e14',
    '--border':'#143c18','--border2':'#0a2a0e',
    '--pink':'#4ade80','--pink2':'#22c55e','--pink-dim':'#15803d',
    '--text':'#f0fff4','--text2':'#c0f0cc','--muted':'#6a9a70','--muted2':'#1a3a20',
  },
  sunset:{
    '--bg':'#0f0503','--s1':'#1a0a05','--s2':'#220f08','--s3':'#2e150c','--s4':'#3a1a10',
    '--border':'#4a2014','--border2':'#381808',
    '--pink':'#fb923c','--pink2':'#f97316','--pink-dim':'#c2410c',
    '--text':'#fff8f0','--text2':'#f0d0b0','--muted':'#a07060','--muted2':'#4a2818',
  },
  neon:{
    '--bg':'#000000','--s1':'#030310','--s2':'#050520','--s3':'#070730','--s4':'#090940',
    '--border':'#0a0a50','--border2':'#060635',
    '--pink':'#00ffcc','--pink2':'#00e0b0','--pink-dim':'#007755',
    '--text':'#f0fffc','--text2':'#a0fff0','--muted':'#508878','--muted2':'#0a2a25',
  },
};
const THEME_NAMES={dark:'🌙 Dark',midnight:'🌊 Midnight Blue',sakura:'🌸 Sakura',forest:'🌿 Forest',sunset:'🌅 Sunset',neon:'⚡ Neon'};

function applyTheme(name){
  const t=THEMES[name]||THEMES.dark;
  const root=document.documentElement;
  Object.entries(t).forEach(([k,v])=>root.style.setProperty(k,v));
  cfg.theme=name;
  tv('current-theme-name',THEME_NAMES[name]||name);
  document.querySelectorAll('.theme-swatch').forEach(s=>s.classList.toggle('selected',s.dataset.theme===name));
}

document.querySelectorAll('.theme-swatch').forEach(s=>s.onclick=()=>applyTheme(s.dataset.theme));
document.getElementById('looks-save-btn').onclick=()=>{
  cfg.chatFontSize=currentFontSize;
  ipcRenderer.send('save-config',{...cfg});flash('looks-save-ok');
};

// ─── Mascot toggles ───────────────────────────────────────
document.getElementById('tog-mascot').onchange=e=>{cfg.mascotVisible=e.target.checked;ipcRenderer.send('toggle-mascot',cfg.mascotVisible);};
document.getElementById('tog-click').onchange=e=>{cfg.clickThrough=e.target.checked;ipcRenderer.send('toggle-click-through',cfg.clickThrough);};
document.getElementById('tog-border').onchange=e=>{cfg.borderVisible=e.target.checked;ipcRenderer.send('toggle-border',cfg.borderVisible);};
document.getElementById('tog-ontop').onchange=e=>{cfg.alwaysOnTop=e.target.checked;if(cfg.alwaysOnTop){cfg.behindTaskbar=false;ck('tog-taskbar',false);}ipcRenderer.send('toggle-always-on-top',cfg.alwaysOnTop);};
document.getElementById('tog-taskbar').onchange=e=>{cfg.behindTaskbar=e.target.checked;if(cfg.behindTaskbar){cfg.alwaysOnTop=false;ck('tog-ontop',false);}ipcRenderer.send('toggle-behind-taskbar',cfg.behindTaskbar);};

const sendPos=()=>ipcRenderer.send('preview-position',{x:cfg.mascotX,y:cfg.mascotY});
const sendSize=()=>ipcRenderer.send('preview-size',{width:cfg.mascotWidth,height:cfg.mascotHeight});
document.getElementById('x-m').onclick=()=>{cfg.mascotX-=5;setEl('pos-x',cfg.mascotX);sendPos();};
document.getElementById('x-p').onclick=()=>{cfg.mascotX+=5;setEl('pos-x',cfg.mascotX);sendPos();};
document.getElementById('y-m').onclick=()=>{cfg.mascotY-=5;setEl('pos-y',cfg.mascotY);sendPos();};
document.getElementById('y-p').onclick=()=>{cfg.mascotY+=5;setEl('pos-y',cfg.mascotY);sendPos();};
document.getElementById('pos-x').oninput=e=>{cfg.mascotX=parseInt(e.target.value)||0;sendPos();};
document.getElementById('pos-y').oninput=e=>{cfg.mascotY=parseInt(e.target.value)||0;sendPos();};
document.getElementById('w-m').onclick=()=>{cfg.mascotWidth=Math.max(50,cfg.mascotWidth-10);setEl('win-w',cfg.mascotWidth);sendSize();};
document.getElementById('w-p').onclick=()=>{cfg.mascotWidth+=10;setEl('win-w',cfg.mascotWidth);sendSize();};
document.getElementById('h-m').onclick=()=>{cfg.mascotHeight=Math.max(50,cfg.mascotHeight-10);setEl('win-h',cfg.mascotHeight);sendSize();};
document.getElementById('h-p').onclick=()=>{cfg.mascotHeight+=10;setEl('win-h',cfg.mascotHeight);sendSize();};
document.getElementById('win-w').oninput=e=>{cfg.mascotWidth=Math.max(50,parseInt(e.target.value)||50);sendSize();};
document.getElementById('win-h').oninput=e=>{cfg.mascotHeight=Math.max(50,parseInt(e.target.value)||50);sendSize();};
document.getElementById('scale-slider').oninput=e=>{cfg.scale=parseFloat(e.target.value);tv('scale-val',cfg.scale.toFixed(2));ipcRenderer.send('preview-scale',{scale:cfg.scale});};
document.getElementById('mascot-save-btn').onclick=()=>{
  cfg.mascotX=parseInt(val('pos-x'))||cfg.mascotX;cfg.mascotY=parseInt(val('pos-y'))||cfg.mascotY;
  cfg.mascotWidth=parseInt(val('win-w'))||cfg.mascotWidth;cfg.mascotHeight=parseInt(val('win-h'))||cfg.mascotHeight;
  cfg.scale=parseFloat(val('scale-slider'));
  ipcRenderer.send('save-config',{...cfg});flash('mascot-save-ok');
};

// ─── Memory page ──────────────────────────────────────────
const MOOD_DEFS={
  neutral:{emoji:'😊',label:'Cheerful',desc:'friendly and warm'},
  happy:  {emoji:'😄',label:'Happy',  desc:'happy and upbeat'},
  excited:{emoji:'🤩',label:'Excited',desc:'very excited and enthusiastic'},
  shy:    {emoji:'🥺',label:'Shy',    desc:'shy and a little flustered'},
  sad:    {emoji:'😢',label:'Sad',    desc:'sad and a bit withdrawn'},
  hurt:   {emoji:'😔',label:'Hurt',   desc:'hurt by the conversation'},
  caring: {emoji:'💕',label:'Caring', desc:'warm, gentle and concerned'},
  playful:{emoji:'😜',label:'Playful',desc:'teasing and playful'},
  annoyed:{emoji:'😤',label:'Annoyed',desc:'frustrated but staying calm'},
};

function updateMoodUI(mood){
  mem.currentMood=mood;
  const def=MOOD_DEFS[mood]||MOOD_DEFS.neutral;
  tv('sidebar-mood-emoji',def.emoji);tv('sidebar-mood-label',def.label);
  tv('mood-big-emoji',def.emoji);tv('mood-name',def.label);tv('mood-desc',def.desc);
  const bar=document.getElementById('mood-bar');
  if(bar){bar.innerHTML='';
    Object.entries(MOOD_DEFS).forEach(([k,d])=>{
      const el=document.createElement('div');el.className='mood-dot-item'+(k===mood?' current':'');
      el.innerHTML=`<span class="mdi-emoji">${d.emoji}</span><span class="mdi-label">${d.label}</span>`;
      el.onclick=()=>{ipcRenderer.send('memory-update-mood','');mem.currentMood=k;updateMoodUI(k);};
      bar.appendChild(el);
    });
  }
}

function renderMemoryPage(){
  const facts=mem.userFacts||[];
  const fc=document.getElementById('facts-count');if(fc)fc.textContent=`${facts.length} facts`;
  const list=document.getElementById('facts-list');
  if(list){list.innerHTML='';
    if(!facts.length){list.innerHTML='<div class="no-facts">No facts yet — I\'ll learn as we chat!</div>';}
    else facts.forEach((f,i)=>{
      const row=document.createElement('div');row.className='fact-row';
      row.innerHTML=`<span class="fact-text">${esc(f)}</span><button class="fact-del" data-i="${i}">✕</button>`;
      list.appendChild(row);
    });
    list.querySelectorAll('.fact-del').forEach(b=>b.onclick=()=>{
      const i=parseInt(b.dataset.i);mem.userFacts.splice(i,1);
      ipcRenderer.send('memory-remove-fact',i);renderMemoryPage();
    });
  }
  const feed=document.getElementById('memory-feed');
  if(feed){
    const items=mem.memoryFeed||[];
    if(!items.length){feed.innerHTML='<div class="feed-empty">No memory activity yet.</div>';}
    else{
      feed.innerHTML='';
      [...items].reverse().slice(0,30).forEach(item=>{
        const icons={fact:'🧠',name:'👤',personality:'✨',removed:'🗑',summary:'📝',clear:'🔄',default:'💭'};
        const icon=icons[item.type]||icons.default;
        const div=document.createElement('div');div.className='feed-item';
        const t=new Date(item.timestamp);
        const timeStr=`${t.toLocaleDateString()} ${t.getHours().toString().padStart(2,'0')}:${t.getMinutes().toString().padStart(2,'0')}`;
        div.innerHTML=`<div class="fi-icon">${icon}</div><div class="fi-content"><div class="fi-text">${esc(item.content)}</div><div class="fi-time">${timeStr}</div></div>`;
        feed.appendChild(div);
      });
    }
  }
  updateMoodUI(mem.currentMood||'neutral');
}

document.getElementById('mem-name').value=mem.userName||'';
document.getElementById('mem-personality').value=mem.personality||'';
document.getElementById('mem-save-name').onclick=()=>{const n=val('mem-name');mem.userName=n;ipcRenderer.send('memory-set-name',n);flash('mem-name-ok');};
document.getElementById('mem-save-personality').onclick=()=>{const t=val('mem-personality');mem.personality=t;ipcRenderer.send('memory-set-personality',t);flash('mem-pers-ok');};
document.getElementById('mem-add-fact-btn').onclick=()=>{const f=val('mem-add-fact').trim();if(!f)return;mem.userFacts.push(f);ipcRenderer.send('memory-add-fact',f);setEl('mem-add-fact','');renderMemoryPage();};
document.getElementById('mem-add-fact').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('mem-add-fact-btn').click();});
document.getElementById('mem-clear-facts').onclick=()=>{if(!confirm('Clear all facts?'))return;mem.userFacts=[];ipcRenderer.send('memory-clear-facts');renderMemoryPage();};
document.getElementById('mem-clear-all').onclick=()=>{
  if(!confirm('Reset ALL memory? Cannot be undone.'))return;
  mem={userName:'',userFacts:[],personality:'',convoSummaries:[],totalMessages:0,currentMood:'neutral',memoryFeed:[]};
  ipcRenderer.send('memory-clear-all');setEl('mem-name','');setEl('mem-personality','');renderMemoryPage();
};

// ─── System prompt ────────────────────────────────────────
function buildSystemPrompt(){
  const lines=[`You are a friendly, cute AI companion living on the user's desktop as a Live2D anime character. Be warm, helpful, slightly playful, and conversational. Keep replies concise.`];
  if(mem.personality) lines.push(`\nPersonality: ${mem.personality}`);
  const moodDef=MOOD_DEFS[mem.currentMood||'neutral']||MOOD_DEFS.neutral;
  lines.push(`\nYour current emotional state: ${moodDef.label} — ${moodDef.desc}. Express this naturally through your word choice and tone. Never state your mood explicitly.`);
  if(mem.userName) lines.push(`\nThe user's name is ${mem.userName}. Use it naturally sometimes.`);
  if(mem.userFacts?.length>0){lines.push('\nWhat you know about the user:');mem.userFacts.forEach(f=>lines.push(`- ${f}`));}
  if(mem.convoSummaries?.length>0){lines.push('\nPast context:');mem.convoSummaries.slice(-2).forEach(s=>lines.push(`[${s.date}] ${s.summary}`));}
  return lines.join('\n');
}

function autoLearn(reply){
  const pats=[/(?:you mentioned|you said|you told me|i(?:'ll| will) remember that you) ([^.!?]{5,80})/i];
  pats.forEach(p=>{const m=reply.match(p);if(m&&m[1]){const f=m[1].replace(/[.!?,]+$/,'').trim();if(f.length>4&&!mem.userFacts.includes(f)){mem.userFacts.push(f);mem.memoryFeed?.push({type:'fact',content:f,timestamp:new Date().toISOString()});ipcRenderer.send('memory-add-fact',f);}}});
}

// ─── Chat status ──────────────────────────────────────────
function setStatus(s){
  const dot=document.getElementById('sdot'),txt=document.getElementById('stext');
  if(!dot||!txt)return;
  if(s==='ready'){dot.className='status-dot green';txt.textContent='ready';if(!isListening&&!ttsBusy&&!isFollowupWindowActive()) clearVoiceHud(600);}
  if(s==='offline'){dot.className='status-dot grey';txt.textContent='offline';}
  if(s==='think'){dot.className='status-dot yellow';txt.textContent='thinking…';}
}

// ─── Chat rendering ───────────────────────────────────────
function renderMsg(role,content,animate=true){
  document.getElementById('chat-empty').style.display='none';
  const wrap=document.getElementById('chat-messages');
  const div=document.createElement('div');div.className=`msg ${role}`;
  if(!animate)div.style.animation='none';
  const now=new Date(),time=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const sender=role==='user'?(mem.userName||'You'):'Companion';
  div.innerHTML=`<div class="msg-sender">${sender}</div><div class="msg-bubble" style="font-size:${currentFontSize}px">${esc(content)}</div><div class="msg-time">${time}</div>`;
  wrap.appendChild(div);scrollChat();
  return div.querySelector('.msg-bubble');
}
function scrollChat(){const w=document.getElementById('chat-messages');if(w)w.scrollTop=w.scrollHeight;}
function clearChatUI(){document.getElementById('chat-messages').innerHTML=`<div id="chat-empty"><div class="ei">✨</div><div class="et">Say hello to your companion!<br/>She's listening and remembers you.</div></div>`;}

// ─── Streaming chat ───────────────────────────────────────
async function send(){
  const inp=document.getElementById('chat-input');
  const text=inp.value.trim();
  if(!text||isThinking)return;
  const wasVoiceDriven=isFollowupWindowActive() || voiceListeningMode==='wake' || voiceListeningMode==='followup';
  hideTranscriptPreview(true);
  inp.value='';inp.style.height='auto';
  resetIdleTimer();
  document.getElementById('quick-prompts-bar')?.remove();
  ipcRenderer.send('memory-update-mood',text);
  renderMsg('user',text);
  chatHistory.push({role:'user',content:text});
  isThinking=true;document.getElementById('send-btn').disabled=true;setStatus('think');
  setVoiceHud('thinking','Thinking...');
  if(wasVoiceDriven && cfg.wakeRearmAfterSend===true) queueWakeResumeFlexible(120,{allowThinking:true});

  document.getElementById('chat-empty').style.display='none';
  const wrap=document.getElementById('chat-messages');
  const msgDiv=document.createElement('div');msgDiv.className='msg ai';
  const sender=document.createElement('div');sender.className='msg-sender';sender.textContent='Companion';
  const bubble=document.createElement('div');bubble.className='msg-bubble streaming';bubble.style.fontSize=currentFontSize+'px';
  const timeEl=document.createElement('div');timeEl.className='msg-time';
  const now=new Date();timeEl.textContent=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  msgDiv.appendChild(sender);msgDiv.appendChild(bubble);msgDiv.appendChild(timeEl);
  wrap.appendChild(msgDiv);scrollChat();

  let fullReply='',sentBuf='';

  try{
    const stream=streamForProvider(chatHistory);
    for await(const token of stream){
      fullReply+=token;sentBuf+=token;
      bubble.innerHTML=esc(fullReply);scrollChat();
      if(cfg.ttsEnabled&&cfg.voiceEngine==='piper'){
        if(/[.!?。！？]\s*$/.test(sentBuf.trimEnd())){
          const c=sentBuf.trim();if(c.length>2)enqueueTTS(c);sentBuf='';
        }
      }
    }
    if(cfg.ttsEnabled){
      if(cfg.voiceEngine==='piper'){if(sentBuf.trim())enqueueTTS(sentBuf.trim());}
      else enqueueTTS(fullReply);
    }
    bubble.classList.remove('streaming');
    addReactions(msgDiv);
    chatHistory.push({role:'assistant',content:fullReply});
    ipcRenderer.send('save-chat-history',chatHistory);
    autoLearn(fullReply);setStatus('ready');
    maybeAutoSummarize();
    clearVoiceSession();
    clearVoiceHud(1400);
    if(wasVoiceDriven || cfg.wakeWordEnabled) queueWakeResume(250);
  }catch(err){
    bubble.classList.remove('streaming');
    bubble.innerHTML=esc(friendlyError(cfg.aiProvider,err.message));
    setStatus('offline');
    clearVoiceSession();
    if(wasVoiceDriven || cfg.wakeWordEnabled) queueWakeResume(300);
    clearVoiceHud(1600);
  }finally{isThinking=false;document.getElementById('send-btn').disabled=false;}
}

// ─── Saved Custom Providers ───────────────────────────────
let savedProviders=[];
let editingProviderId=null;

const PROVIDER_DETECT=[
  {match:'groq.com',      name:'Groq',        icon:'⚡',tag:'tag-green'},
  {match:'together.xyz',  name:'Together AI',  icon:'🤝',tag:'tag-blue'},
  {match:'mistral.ai',    name:'Mistral',      icon:'🌬',tag:'tag-purple'},
  {match:'openrouter.ai', name:'OpenRouter',   icon:'🔀',tag:'tag-yellow'},
  {match:'cohere.com',    name:'Cohere',       icon:'🌐',tag:'tag-pink'},
  {match:'fireworks.ai',  name:'Fireworks',    icon:'🎆',tag:'tag-green'},
  {match:'perplexity.ai', name:'Perplexity',   icon:'🔮',tag:'tag-blue'},
  {match:'deepinfra.com', name:'DeepInfra',    icon:'🔱',tag:'tag-purple'},
  {match:'anyscale.com',  name:'Anyscale',     icon:'🌀',tag:'tag-green'},
];

function detectProviderFromUrl(url){
  for(const p of PROVIDER_DETECT){if(url.includes(p.match))return p;}
  return {name:'Custom API',icon:'⚙️',tag:'tag-blue'};
}

async function fetchModelsFromUrl(url,key){
  const modelsUrl=url.replace(/\/+$/,'')+'/models';
  const headers={'Content-Type':'application/json'};
  if(key)headers['Authorization']='Bearer '+key;
  const r=await fetch(modelsUrl,{headers,signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw new Error(`${r.status}`);
  const data=await r.json();
  const list=data.data||data.models||data||[];
  return list.map(m=>typeof m==='string'?m:(m.id||m.name||'')).filter(Boolean).sort();
}

function renderSavedProviders(){
  const list=document.getElementById('saved-providers-list');if(!list)return;
  if(!savedProviders.length){
    list.innerHTML='<div style="padding:16px;text-align:center;color:var(--muted);font-size:12px;">No saved providers yet. Click Add New to get started.</div>';return;
  }
  list.innerHTML='';
  savedProviders.forEach(p=>{
    const isActive=cfg.aiProvider==='custom'&&cfg.customUrl===p.url&&cfg.customModel===p.model;
    const div=document.createElement('div');
    div.style.cssText='display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.15s;';
    div.onmouseenter=()=>div.style.background='var(--s3)';
    div.onmouseleave=()=>div.style.background='';
    div.innerHTML=`
      <span style="font-size:20px;">${p.icon||'⚙️'}</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;color:var(--text);">${p.name} ${isActive?'<span class="tag tag-green" style="font-size:9px;">● ACTIVE</span>':''}</div>
        <div style="font-size:10px;color:var(--muted);">${p.model||'No model'} · ${(p.url||'').replace('https://','')}</div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="activateProvider('${p.id}')">Use</button>
      <button class="btn btn-secondary btn-sm" onclick="editProvider('${p.id}')">Edit</button>
    `;
    list.appendChild(div);
  });
}

function activateProvider(id){
  const p=savedProviders.find(x=>x.id===id);if(!p)return;
  cfg.aiProvider='custom';cfg.customUrl=p.url;cfg.customKey=p.key;cfg.customModel=p.model;
  setProviderTab('custom');
  tv('mbadge',p.model||'custom');
  ipcRenderer.send('save-config',{...cfg});
  renderSavedProviders();flash('ai-save-ok');updateHomeCards();
}

function editProvider(id){
  const p=savedProviders.find(x=>x.id===id);if(!p)return;
  editingProviderId=id;
  setEl('pf-name',p.name);setEl('pf-url',p.url);setEl('pf-key',p.key||'');
  setEl('pf-model-manual',p.model||'');
  document.getElementById('add-provider-form').style.display='block';
  document.getElementById('pf-delete-btn').style.display='flex';
  tv('pf-title','Edit Provider');
}

function showAddForm(){
  editingProviderId=null;
  setEl('pf-name','');setEl('pf-url','');setEl('pf-key','');
  setEl('pf-model-manual','');
  const sel=document.getElementById('pf-model-select');
  if(sel){sel.innerHTML='<option value="">— Fetch models or type below —</option>';}
  document.getElementById('pf-detected').style.display='none';
  document.getElementById('pf-delete-btn').style.display='none';
  tv('pf-title','Add New Provider');
  document.getElementById('add-provider-form').style.display='block';
}

document.getElementById('add-provider-btn').onclick=showAddForm;
document.getElementById('cancel-provider-btn').onclick=()=>{document.getElementById('add-provider-form').style.display='none';};

document.getElementById('pf-detect-btn').onclick=()=>{
  const url=val('pf-url').trim();if(!url)return;
  const det=detectProviderFromUrl(url);
  const info=document.getElementById('pf-detected');
  info.innerHTML=`✓ Detected: <b>${det.icon} ${det.name}</b>`;
  info.style.display='block';
  if(!val('pf-name')) setEl('pf-name',det.name);
};

document.getElementById('pf-fetch-btn').onclick=async()=>{
  const url=val('pf-url').trim(),key=val('pf-key').trim();
  const status=document.getElementById('pf-fetch-status');
  const sel=document.getElementById('pf-model-select');
  if(!url){status.textContent='Enter URL first';return;}
  status.textContent='Fetching…';status.style.color='var(--muted)';
  try{
    const models=await fetchModelsFromUrl(url,key);
    sel.innerHTML='<option value="">— Select a model —</option>';
    models.forEach(m=>{const o=document.createElement('option');o.value=m;o.textContent=m;sel.appendChild(o);});
    status.textContent=`✓ ${models.length} models found`;status.style.color='var(--green)';
  }catch(e){
    status.textContent=`✗ ${e.message} — type model name manually below`;status.style.color='var(--red)';
  }
};

document.getElementById('pf-model-select').onchange=function(){
  if(this.value) setEl('pf-model-manual',this.value);
};

document.getElementById('pf-save-btn').onclick=()=>{
  const name=val('pf-name').trim()||'Custom';
  const url=val('pf-url').trim();
  const key=val('pf-key').trim();
  const model=val('pf-model-manual').trim()||val('pf-model-select');
  if(!url){alert('Enter a URL first');return;}
  const det=detectProviderFromUrl(url);
  if(editingProviderId){
    const p=savedProviders.find(x=>x.id===editingProviderId);
    if(p)Object.assign(p,{name,url,key,model,icon:det.icon});
  }else{
    savedProviders.push({id:Date.now().toString(),name,url,key,model,icon:det.icon});
  }
  cfg.savedProviders=savedProviders;
  ipcRenderer.send('save-config',{...cfg});
  document.getElementById('add-provider-form').style.display='none';
  renderSavedProviders();flash('ai-save-ok');
};

document.getElementById('pf-delete-btn').onclick=()=>{
  if(!editingProviderId||!confirm('Delete this provider?'))return;
  savedProviders=savedProviders.filter(p=>p.id!==editingProviderId);
  cfg.savedProviders=savedProviders;
  ipcRenderer.send('save-config',{...cfg});
  document.getElementById('add-provider-form').style.display='none';
  renderSavedProviders();
};

// ─── OpenAI TTS voice selector ────────────────────────────
let openAITTSVoice='nova';
function selectOpenAIVoice(el){
  document.querySelectorAll('[data-oai-voice]').forEach(x=>x.classList.remove('selected'));
  el.classList.add('selected');
  openAITTSVoice=el.dataset.oaiVoice||'nova';cfg.openaiTTSVoice=openAITTSVoice;
}

// ─── Friendly error messages ──────────────────────────────
function friendlyError(provider, raw){
  if(/failed to fetch|networkerror|failed to connect/i.test(raw))
    return `⚠️ Can't reach ${provider}. Check your internet connection or that the service is running.`;
  if(/401|unauthorized|invalid.*key|api key/i.test(raw))
    return `⚠️ Invalid API key for ${provider}. Go to AI settings and check your key.`;
  if(/403|forbidden/i.test(raw))
    return `⚠️ Access denied. Your API key may not have permission for this model.`;
  if(/429|quota|rate.?limit|resource_exhausted/i.test(raw)){
    const retry=raw.match(/retry.*?(\d+)/i);
    const wait=retry?` Please wait ${retry[1]} seconds and try again.`:'';
    return `⚠️ ${provider} rate limit hit — you've sent too many messages too fast.${wait}\n\nTip: Switch to Ollama (local, unlimited) or upgrade your API plan.`;
  }
  if(/404|not.?found/i.test(raw))
    return `⚠️ Model not found. Go to AI settings and select a different model.`;
  if(/500|internal.?server/i.test(raw))
    return `⚠️ ${provider} server error. Try again in a moment.`;
  if(/503|unavailable|overloaded/i.test(raw))
    return `⚠️ ${provider} is overloaded right now. Try again in a moment.`;
  return `⚠️ Error: ${raw.substring(0,120)}${raw.length>120?'…':''}`;
}

// ─── Streaming providers ──────────────────────────────────
async function* streamOllama(history){
  const res=await fetch((cfg.ollamaUrl||'http://localhost:11434')+'/api/chat',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:cfg.ollamaModel||'llama3',stream:true,
      messages:[{role:'system',content:buildSystemPrompt()},...history.slice(-20)]}),
  });
  if(!res.ok)throw new Error(`Ollama ${res.status}`);
  const reader=res.body.getReader();const dec=new TextDecoder();
  while(true){const{done,value}=await reader.read();if(done)break;
    for(const line of dec.decode(value).split('\n').filter(l=>l.trim())){
      try{const j=JSON.parse(line);const t=j.message?.content||'';if(t)yield t;}catch(e){}
    }
  }
}

async function* streamOpenAI(history){
  const res=await fetch('https://api.openai.com/v1/chat/completions',{
    method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+cfg.openaiKey},
    body:JSON.stringify({model:cfg.openaiModel||'gpt-4o-mini',stream:true,
      messages:[{role:'system',content:buildSystemPrompt()},...history.slice(-20)]}),
  });
  if(!res.ok)throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const reader=res.body.getReader();const dec=new TextDecoder();
  while(true){const{done,value}=await reader.read();if(done)break;
    for(const line of dec.decode(value).split('\n')){
      if(!line.startsWith('data:'))continue;
      const d=line.slice(5).trim();if(d==='[DONE]')return;
      try{const j=JSON.parse(d);const t=j.choices?.[0]?.delta?.content||'';if(t)yield t;}catch(e){}
    }
  }
}

async function* streamAnthropic(history){
  const res=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':cfg.anthropicKey,'anthropic-version':'2023-06-01','anthropic-beta':'messages-2023-06-01'},
    body:JSON.stringify({model:cfg.anthropicModel||'claude-3-5-haiku-20241022',max_tokens:1024,stream:true,
      system:buildSystemPrompt(),messages:history.slice(-20)}),
  });
  if(!res.ok)throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const reader=res.body.getReader();const dec=new TextDecoder();
  while(true){const{done,value}=await reader.read();if(done)break;
    for(const line of dec.decode(value).split('\n')){
      if(!line.startsWith('data:'))continue;
      try{const j=JSON.parse(line.slice(5));const t=j.delta?.text||'';if(t)yield t;}catch(e){}
    }
  }
}

async function* streamGemini(history){
  const model=cfg.geminiModel||'gemini-2.0-flash';
  const url=`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${cfg.geminiKey}&alt=sse`;
  const contents=history.slice(-20).map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]}));
  const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({systemInstruction:{parts:[{text:buildSystemPrompt()}]},contents})});
  if(!res.ok)throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const reader=res.body.getReader();const dec=new TextDecoder();
  while(true){const{done,value}=await reader.read();if(done)break;
    for(const line of dec.decode(value).split('\n')){
      if(!line.startsWith('data:'))continue;
      try{const j=JSON.parse(line.slice(5));const t=j.candidates?.[0]?.content?.parts?.[0]?.text||'';if(t)yield t;}catch(e){}
    }
  }
}

async function* streamNVIDIA(history){
  const res=await fetch('https://integrate.api.nvidia.com/v1/chat/completions',{
    method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+cfg.nvidiaKey},
    body:JSON.stringify({model:cfg.nvidiaModel||'nvidia/llama-3.1-nemotron-70b-instruct',stream:true,max_tokens:1024,
      messages:[{role:'system',content:buildSystemPrompt()},...history.slice(-20)]}),
  });
  if(!res.ok)throw new Error(`NVIDIA ${res.status}: ${await res.text()}`);
  yield* streamOpenAIFormat(res);
}

async function* streamCustom(history){
  const url=(cfg.customUrl||'').replace(/\/+$/,'');
  if(!url)throw new Error('No custom provider URL set. Go to AI → Custom and add a provider.');
  const res=await fetch(url+'/chat/completions',{
    method:'POST',
    headers:{'Content-Type':'application/json',...(cfg.customKey?{'Authorization':'Bearer '+cfg.customKey}:{})},
    body:JSON.stringify({model:cfg.customModel||'',stream:true,
      messages:[{role:'system',content:buildSystemPrompt()},...history.slice(-20)]}),
  });
  if(!res.ok)throw new Error(`Custom API ${res.status}: ${await res.text()}`);
  yield* streamOpenAIFormat(res);
}

function streamForProvider(history, useCurrentProvider=true){
  const provider=useCurrentProvider?(cfg.aiProvider||'ollama'):'ollama';
  switch(provider){
    case 'openai': return streamOpenAI(history);
    case 'anthropic': return streamAnthropic(history);
    case 'gemini': return streamGemini(history);
    case 'nvidia': return streamNVIDIA(history);
    case 'custom': return streamCustom(history);
    default: return streamOllama(history);
  }
}

async function* streamOpenAIFormat(res){
  const reader=res.body.getReader();const dec=new TextDecoder();
  while(true){const{done,value}=await reader.read();if(done)break;
    for(const line of dec.decode(value).split('\n')){
      if(!line.startsWith('data:'))continue;
      const d=line.slice(5).trim();if(d==='[DONE]')return;
      try{const j=JSON.parse(d);const t=j.choices?.[0]?.delta?.content||'';if(t)yield t;}catch(e){}
    }
  }
}

// ─── Send & input ─────────────────────────────────────────
document.getElementById('send-btn').onclick=send;
document.getElementById('chat-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
document.getElementById('chat-input').addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px';});
document.getElementById('clear-chat-btn').onclick=()=>{if(confirm('Clear chat history?'))ipcRenderer.send('clear-chat-history');};
document.getElementById('tog-tts').onchange=e=>{cfg.ttsEnabled=e.target.checked;};

// ─── Auto-summarize after 25 messages ────────────────────
async function maybeAutoSummarize(){
  if(chatHistory.length>0&&chatHistory.length%25===0){
    const last=chatHistory.slice(-25);
    const summaryPrompt=`Summarize this conversation in 1-2 sentences, focusing on key facts learned about the user and important topics discussed. Be brief and factual.\n\n${last.map(m=>`${m.role}: ${m.content.substring(0,200)}`).join('\n')}`;
    try{
      let summary='';
      const fakeHistory=[{role:'user',content:summaryPrompt}];
      let stream;
      switch(cfg.aiProvider){
        case 'openai':    stream=streamOpenAI(fakeHistory);break;
        case 'anthropic': stream=streamAnthropic(fakeHistory);break;
        case 'gemini':    stream=streamGemini(fakeHistory);break;
        default:          stream=streamOllama(fakeHistory);
      }
      for await(const t of stream) summary+=t;
      if(summary.length>10){
        mem.convoSummaries=mem.convoSummaries||[];
        mem.convoSummaries.push({summary:summary.trim(),date:new Date().toLocaleDateString()});
        if(mem.convoSummaries.length>10)mem.convoSummaries.shift();
        ipcRenderer.send('memory-add-summary',summary.trim());
        showToast('📝 Conversation summarized into memory');
      }
    }catch(e){console.warn('[Auto-summarize]',e);}
  }
}

// ─── Idle messages ────────────────────────────────────────
const IDLE_MESSAGES=[
  "Hey, you've been quiet... everything okay? 🥺",
  "I'm still here if you want to chat! ✨",
  "Hmm, it's been a while... I've been thinking about you (=^･ω･^=)",
  "Psst... I'm bored. Talk to me! 😄",
  "Still here~ just waiting patiently 💕",
  "You know you can always talk to me, right? 🌸",
];
let idleTimer=null;
function resetIdleTimer(){
  clearTimeout(idleTimer);
  idleTimer=setTimeout(()=>{
    if(!isThinking&&currentPage==='chat'){
      const msg=IDLE_MESSAGES[Math.floor(Math.random()*IDLE_MESSAGES.length)];
      renderAIMessage(msg);
      if(cfg.ttsEnabled)enqueueTTS(msg);
    }
  },5*60*1000);
}

function renderAIMessage(text){
  const wrap=document.getElementById('chat-messages');
  document.getElementById('chat-empty').style.display='none';
  const div=document.createElement('div');div.className='msg ai';
  const now=new Date();
  const time=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  div.innerHTML=`<div class="msg-sender">Companion</div>
    <div class="msg-bubble" style="font-size:${currentFontSize}px">${esc(text)}</div>
    <div class="msg-time">${time}</div>`;
  addReactions(div);
  wrap.appendChild(div);scrollChat();
}

// ─── Quick prompts ────────────────────────────────────────
const QUICK_PROMPTS=[
  {label:'😊 How are you?',  text:'How are you feeling today?'},
  {label:'🎮 Game rec',      text:'Can you recommend a fun game for me?'},
  {label:'💡 Fun fact',      text:'Tell me a fun and interesting fact!'},
  {label:'😂 Tell a joke',   text:'Tell me a funny joke!'},
  {label:'🌸 Compliment me', text:'Say something sweet to cheer me up!'},
  {label:'🤔 What to do',    text:'I\'m bored. What should I do right now?'},
];

function renderQuickPrompts(){
  const existing=document.getElementById('quick-prompts-bar');
  if(existing)existing.remove();
  if(chatHistory.length>0)return;
  const bar=document.createElement('div');
  bar.id='quick-prompts-bar';
  bar.style.cssText='display:flex;gap:6px;flex-wrap:wrap;padding:8px 14px;border-top:1px solid var(--border2);background:var(--s1);';
  QUICK_PROMPTS.forEach(p=>{
    const btn=document.createElement('button');
    btn.textContent=p.label;
    btn.style.cssText='padding:5px 10px;background:var(--s2);border:1px solid var(--border);border-radius:20px;color:var(--text2);font-size:11px;cursor:pointer;transition:all 0.15s;white-space:nowrap;';
    btn.onmouseenter=()=>{btn.style.borderColor='var(--pink)';btn.style.color='var(--pink)';};
    btn.onmouseleave=()=>{btn.style.borderColor='var(--border)';btn.style.color='var(--text2)';};
    btn.onclick=()=>{
      document.getElementById('chat-input').value=p.text;
      bar.remove();send();
    };
    bar.appendChild(btn);
  });
  const inputBar=document.getElementById('chat-input-bar');
  inputBar.parentNode.insertBefore(bar,inputBar);
}

// ─── Toast notifications ──────────────────────────────────
function showToast(message,duration=3000){
  const existing=document.getElementById('toast-notif');if(existing)existing.remove();
  const toast=document.createElement('div');toast.id='toast-notif';
  toast.style.cssText=`position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(10px);
    background:var(--s3);border:1px solid var(--border);border-radius:20px;
    padding:8px 16px;font-size:12px;color:var(--text2);z-index:9999;
    opacity:0;transition:all 0.3s;pointer-events:none;white-space:nowrap;`;
  toast.textContent=message;
  document.body.appendChild(toast);
  setTimeout(()=>{toast.style.opacity='1';toast.style.transform='translateX(-50%) translateY(0)';},50);
  setTimeout(()=>{toast.style.opacity='0';setTimeout(()=>toast.remove(),300);},duration);
}

// ─── Chat export ──────────────────────────────────────────
function exportChat(){
  if(!chatHistory.length){showToast('No messages to export');return;}
  const lines=chatHistory.map(m=>{
    const role=m.role==='user'?(mem.userName||'You'):'Companion';
    return `[${role}]\n${m.content}\n`;
  });
  const text=`Desktop Mascot Chat Export\n${new Date().toLocaleString()}\n${'─'.repeat(40)}\n\n${lines.join('\n')}`;
  const blob=new Blob([text],{type:'text/plain'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;
  a.download=`chat_export_${new Date().toISOString().slice(0,10)}.txt`;
  a.click();URL.revokeObjectURL(url);
  showToast('💾 Chat exported!');
}

const exportBtn=document.createElement('button');
exportBtn.className='chat-act-btn';exportBtn.title='Export chat';exportBtn.textContent='💾';
exportBtn.onclick=exportChat;
document.querySelector('.chat-actions')?.insertBefore(exportBtn,document.getElementById('clear-chat-btn'));

// ─── Keyboard shortcuts ───────────────────────────────────
document.addEventListener('keydown',e=>{
  if(e.ctrlKey&&e.key==='1'){e.preventDefault();switchPage('chat');}
  if(e.ctrlKey&&e.key==='2'){e.preventDefault();switchPage('ai');}
  if(e.ctrlKey&&e.key==='3'){e.preventDefault();switchPage('voice');}
  if(e.ctrlKey&&e.key==='4'){e.preventDefault();switchPage('memory');}
  if(e.ctrlKey&&e.shiftKey&&e.key==='S'){e.preventDefault();stopTTS();showToast('🔇 Voice stopped');}
});

// ─── Daily greeting ───────────────────────────────────────
function checkDailyGreeting(){
  const today=new Date().toDateString();
  const last=localStorage.getItem('lastGreeting');
  if(last===today||chatHistory.length>0)return;
  localStorage.setItem('lastGreeting',today);
  const hour=new Date().getHours();
  const greet=hour<12?'Good morning':(hour<17?'Good afternoon':'Good evening');
  const name=mem.userName?`, ${mem.userName}`:'';
  setTimeout(()=>{
    const msg=`${greet}${name}! 🌟 I'm so happy to see you today. How are you doing?`;
    renderMsg('ai',msg);
    chatHistory.push({role:'assistant',content:msg});
    ipcRenderer.send('save-chat-history',chatHistory);
    if(cfg.ttsEnabled)enqueueTTS(msg);
    document.getElementById('chat-empty').style.display='none';
  },1500);
}

// ─── Reaction helper ──────────────────────────────────────
function addReactions(msgDiv){
  const reactions=document.createElement('div');
  reactions.style.cssText='display:flex;gap:4px;padding:2px 4px;';
  ['❤️','😂','😮','😢','👏'].forEach(emoji=>{
    const btn=document.createElement('button');btn.textContent=emoji;
    btn.style.cssText='background:transparent;border:1px solid var(--border);border-radius:20px;padding:2px 6px;cursor:pointer;font-size:12px;transition:all 0.15s;';
    btn.onmouseenter=()=>btn.style.background='var(--s3)';
    btn.onmouseleave=()=>btn.style.background='transparent';
    btn.onclick=()=>{btn.style.background='var(--pink-dim)';btn.style.borderColor='var(--pink)';btn.style.transform='scale(1.3)';setTimeout(()=>btn.style.transform='scale(1)',200);};
    reactions.appendChild(btn);
  });
  msgDiv.appendChild(reactions);
}

// ─── Init extras ──────────────────────────────────────────
setTimeout(()=>{
  renderQuickPrompts();
  checkDailyGreeting();
  resetIdleTimer();
},800);
