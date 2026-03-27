const { ipcRenderer, shell: electronShell } = require('electron');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { exec, execFile } = require('child_process');

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
}
document.querySelectorAll('.nav-item').forEach(n=>n.onclick=()=>switchPage(n.dataset.page));

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

// Voice save
document.getElementById('voice-save-btn').onclick=()=>{
  cfg.voiceEngine=currentVoiceEngine;
  cfg.ttsEnabled=document.getElementById('tog-tts').checked;
  cfg.sttEnabled=document.getElementById('tog-stt').checked;
  cfg.sttEngine=val('stt-engine')||'openai';
  cfg.sttLanguage=val('stt-language')||'auto';
  cfg.autoMicStop=document.getElementById('tog-stt-auto-stop')?.checked!==false;
  cfg.autoMicSend=document.getElementById('tog-stt-auto-send')?.checked!==false;
  cfg.elevenKey=val('eleven-key');cfg.elevenModel=val('eleven-model');
  cfg.elevenVoiceId=selectedElevenVoiceId||cfg.elevenVoiceId;
  cfg.piperPath=val('piper-path');cfg.piperVoice=val('piper-voice');
  cfg.whisperCppPath=val('whispercpp-path');
  cfg.whisperCppModel=val('whispercpp-model');
  cfg.openaiTTSKey=val('openai-tts-key');
  cfg.openaiTTSModel=val('openai-tts-model');
  cfg.openaiTTSVoice=openAITTSVoice;
  ipcRenderer.send('save-config',{...cfg});
  flash('voice-save-ok');setupMic();updateHomeCards();
  updateSTTUI();
};

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
  if(!ttsQueue.length){ttsBusy=false;setBadge('');return;}
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
}
function setBadge(state){
  const b=document.getElementById('tts-badge');if(!b)return;
  b.className=state==='speaking'?'tts-badge speaking':'tts-badge';
  b.textContent=state==='speaking'?'🔊 speaking…':'';
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

function getWhisperKey(){
  return cfg.openaiTTSKey || cfg.openaiKey || '';
}

function getSTTEngine(){
  return cfg.sttEngine || 'openai';
}

function getSTTLanguage(){
  return cfg.sttLanguage || 'auto';
}

function showInterim(text){
  const el=document.getElementById('mic-interim');
  if(!el)return;
  el.textContent=text;
  el.classList.toggle('active',!!text);
}

function updateWhisperKeyStatus(){
  const dot=document.getElementById('whisper-key-dot');
  const txt=document.getElementById('whisper-key-status');
  if(!dot||!txt)return;
  const key=getWhisperKey();
  if(key){
    dot.className='status-dot green';
    txt.textContent='✓ OpenAI key found — Whisper STT is ready';
    txt.style.color='var(--green)';
  }else{
    dot.className='status-dot grey';
    txt.textContent='No OpenAI key — add one in AI Model → OpenAI tab';
    txt.style.color='var(--muted)';
  }
}

function updateMicTimer(){
  recordingSeconds++;
  const m=Math.floor(recordingSeconds/60).toString().padStart(2,'0');
  const s=(recordingSeconds%60).toString().padStart(2,'0');
  showInterim(`🔴 Recording ${m}:${s} — click mic again to transcribe`);
}

function setupMic(){
  const btn=document.getElementById('mic-btn');
  if(!cfg.sttEnabled){
    btn.classList.remove('active-display');
    if(isListening) stopListening(false);
    return;
  }
  btn.classList.add('active-display');
  btn.title='Click to start recording • click again to send';
}

async function startListening(){
  if(isListening)return;

  const key=getWhisperKey();
  if(!key){
    showInterim('⚠️ No OpenAI key — add one in AI Model → OpenAI tab');
    setTimeout(()=>showInterim(''),3500);
    return;
  }

  try{
    micStream=await navigator.mediaDevices.getUserMedia({
      audio:{channelCount:1,sampleRate:16000,echoCancellation:true,noiseSuppression:true}
    });
  }catch(err){
    console.error('[Whisper STT] Mic access denied:',err);
    showInterim('⚠️ Mic access denied — check Windows Settings › Privacy › Microphone');
    setTimeout(()=>showInterim(''),4000);
    return;
  }

  // Pick the best supported audio format Whisper accepts
  const mimeType=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg']
    .find(t=>MediaRecorder.isTypeSupported(t))||'';

  audioChunks     = [];
  recordingSeconds = 0;
  mediaRecorder   = new MediaRecorder(micStream, mimeType?{mimeType}:{});
  isListening     = true;

  mediaRecorder.ondataavailable=e=>{
    if(e.data&&e.data.size>0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop=async()=>{
    clearInterval(recordingTimer);
    showInterim('⏳ Transcribing…');
    const blob=new Blob(audioChunks,{type:mimeType||'audio/webm'});
    await transcribeWithWhisper(blob);
    micStream?.getTracks().forEach(t=>t.stop());
    micStream=null;
  };

  mediaRecorder.start(250); // collect in 250 ms chunks

  const btn=document.getElementById('mic-btn');
  btn.classList.add('listening');
  recordingTimer=setInterval(updateMicTimer,1000);
  showInterim('🔴 Recording 00:00 — click mic again to transcribe');
}

function stopListening(sendAudio=true){
  clearInterval(recordingTimer);
  isListening=false;
  document.getElementById('mic-btn')?.classList.remove('listening');

  if(!sendAudio){
    showInterim('');
    micStream?.getTracks().forEach(t=>t.stop());
    micStream=null;audioChunks=[];mediaRecorder=null;
    return;
  }

  if(mediaRecorder&&mediaRecorder.state!=='inactive'){
    mediaRecorder.stop(); // triggers onstop → transcribeWithWhisper
  }else{
    showInterim('');
  }
}

async function transcribeWithWhisper(audioBlob){
  const key=getWhisperKey();
  if(!key){showInterim('');return;}

  const ext=audioBlob.type.includes('ogg')?'ogg':audioBlob.type.includes('mp4')?'mp4':'webm';
  const form=new FormData();
  form.append('file',audioBlob,`recording.${ext}`);
  form.append('model','whisper-1');
  form.append('response_format','json');
  // Remove the next line to enable auto-detect for any language:
  form.append('language','en');

  try{
    const res=await fetch('https://api.openai.com/v1/audio/transcriptions',{
      method:'POST',
      headers:{Authorization:`Bearer ${key}`},
      body:form,
    });

    if(!res.ok){
      const errText=await res.text();
      throw new Error(`Whisper ${res.status}: ${errText}`);
    }

    const data=await res.json();
    const text=(data.text||'').trim();

    if(text){
      const inp=document.getElementById('chat-input');
      inp.value=(inp.value?inp.value+' ':'')+text;
      inp.style.height='auto';
      inp.style.height=Math.min(inp.scrollHeight,100)+'px';
      const preview=text.length>60?text.slice(0,60)+'…':text;
      showInterim(`✅ "${preview}"`);
      setTimeout(()=>showInterim(''),2500);
    }else{
      showInterim('🔇 Nothing detected — try again');
      setTimeout(()=>showInterim(''),2500);
    }
  }catch(err){
    console.error('[Whisper STT]',err);
    const msg=err.message.includes('401')?'⚠️ Invalid API key — check AI Model settings'
             :err.message.includes('429')?'⚠️ Rate limit hit — try again in a moment'
             :err.message.includes('fetch')||err.message.includes('network')?'⚠️ No internet connection'
             :`⚠️ ${err.message.slice(0,70)}`;
    showInterim(msg);
    setTimeout(()=>showInterim(''),4000);
  }
}

function updateSTTUI(){
  const dot=document.getElementById('whisper-key-dot');
  const txt=document.getElementById('whisper-key-status');
  const openaiBox=document.getElementById('stt-openai-box');
  const localBox=document.getElementById('stt-local-box');
  const engine=getSTTEngine();
  if(openaiBox) openaiBox.style.display=engine==='openai'?'block':'none';
  if(localBox) localBox.style.display=engine==='local'?'block':'none';
  if(!dot||!txt)return;
  if(engine==='local'){
    const ready=!!(cfg.whisperCppPath&&cfg.whisperCppModel);
    dot.className=`status-dot ${ready?'green':'yellow'}`;
    txt.textContent=ready?'Local whisper.cpp is configured':'Add whisper.cpp executable and model path below';
    txt.style.color=ready?'var(--green)':'var(--yellow)';
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
    if(cfg.whisperCppPath&&cfg.whisperCppModel) return true;
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
  document.getElementById('mic-btn')?.classList.remove('listening');
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

function applyTranscribedText(text){
  const clean=(text||'').trim();
  if(!clean){
    showInterim('Nothing detected - try again');
    setTimeout(()=>showInterim(''),2500);
    return;
  }
  const inp=document.getElementById('chat-input');
  inp.value=(inp.value?inp.value+' ':'')+clean;
  inp.style.height='auto';
  inp.style.height=Math.min(inp.scrollHeight,100)+'px';
  const preview=clean.length>60?clean.slice(0,60)+'...':clean;
  showInterim(`OK: "${preview}"`);
  if(cfg.autoMicSend!==false && !isThinking){
    setTimeout(()=>send(),120);
    return;
  }
  setTimeout(()=>showInterim(''),2500);
}

async function transcribeAudio(audioBlob){
  if(getSTTEngine()==='local') return transcribeWithWhisperCpp(audioBlob);
  return transcribeWithOpenAI(audioBlob);
}

async function transcribeWithOpenAI(audioBlob){
  const key=getWhisperKey();
  if(!key){showInterim('');return;}
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
    });
    if(!res.ok){
      const errText=await res.text();
      throw new Error(`Whisper ${res.status}: ${errText}`);
    }
    const data=await res.json();
    applyTranscribedText(data.text||'');
  }catch(err){
    console.error('[OpenAI STT]',err);
    const msg=err.message.includes('401')?'Invalid API key - check AI Model settings'
             :err.message.includes('429')?'Rate limit hit - try again in a moment'
             :err.message.includes('fetch')||err.message.includes('network')?'No internet connection'
             :String(err.message||err).slice(0,70);
    showInterim(msg);
    setTimeout(()=>showInterim(''),4000);
  }
}

async function transcribeWithWhisperCpp(audioBlob){
  const exe=(cfg.whisperCppPath||'').trim();
  const model=(cfg.whisperCppModel||'').trim();
  if(!exe||!model){
    showInterim('Add whisper.cpp executable and model path first');
    setTimeout(()=>showInterim(''),4000);
    return;
  }
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
    if(getSTTLanguage()!=='auto') args.push('-l',getSTTLanguage());
    await new Promise((resolve,reject)=>{
      execFile(exe,args,{windowsHide:true},(err,stdout,stderr)=>{
        if(err) reject(new Error(stderr?.trim()||stdout?.trim()||err.message));
        else resolve();
      });
    });
    const text=fs.existsSync(outputPath)?fs.readFileSync(outputPath,'utf8'):'';
    applyTranscribedText(text);
  }catch(err){
    console.error('[whisper.cpp STT]',err);
    showInterim(`Local STT failed: ${String(err.message||err).slice(0,80)}`);
    setTimeout(()=>showInterim(''),4500);
  }finally{
    [audioPath,outputPath].forEach(f=>{try{fs.existsSync(f)&&fs.unlinkSync(f);}catch{}});
    try{
      fs.readdirSync(tempDir)
        .filter(name=>name.startsWith(`transcript-${stamp}`))
        .forEach(name=>{try{fs.unlinkSync(path.join(tempDir,name));}catch{}});
    }catch{}
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
  btn.title=`Click to start recording - click again to transcribe with ${getSTTEngine()==='local'?'local whisper.cpp':'OpenAI Whisper'}`;
}

async function startListening(){
  if(isListening||!ensureSTTConfigured()) return;
  try{
    micStream=await navigator.mediaDevices.getUserMedia({
      audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}
    });
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
    isListening=true;
    audioProcessor.onaudioprocess=e=>{
      if(!isListening) return;
      const input=e.inputBuffer.getChannelData(0);
      pcmChunks.push(new Float32Array(input));
      let sum=0;
      for(let i=0;i<input.length;i++) sum+=input[i]*input[i];
      const rms=Math.sqrt(sum/input.length);
      const chunkMs=(input.length/(audioContext?.sampleRate||16000))*1000;
      if(rms>0.014){
        heardSpeech=true;
        silenceMs=0;
      }else if(heardSpeech){
        silenceMs+=chunkMs;
        if(cfg.autoMicStop!==false && silenceMs>=1600){
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
  document.getElementById('mic-btn')?.classList.add('listening');
  recordingTimer=setInterval(updateMicTimer,1000);
  showInterim('Recording 00:00 - click mic again to transcribe');
}

function stopListening(sendAudio=true){
  if(!isListening&&!sendAudio){
    cleanupRecording();
    showInterim('');
    pcmChunks=[];
    return;
  }
  isListening=false;
  if(!sendAudio){
    cleanupRecording();
    showInterim('');
    pcmChunks=[];
    return;
  }
  const recordedChunks=pcmChunks;
  pcmChunks=[];
  cleanupRecording();
  if(!recordedChunks.length){
    showInterim('Nothing recorded - try again');
    setTimeout(()=>showInterim(''),2500);
    return;
  }
  showInterim('Transcribing...');
  const audioBlob=makeWavBlob(recordedChunks,16000);
  transcribeAudio(audioBlob).catch(err=>{
    console.error('[STT]',err);
    showInterim(String(err.message||err).slice(0,80));
    setTimeout(()=>showInterim(''),4000);
  });
}

document.getElementById('mic-btn').onclick=()=>{
  if(isListening) stopListening(true);
  else            startListening();
};

document.getElementById('tog-stt').onchange=e=>{
  cfg.sttEnabled=e.target.checked;
  if(!e.target.checked) stopListening(false);
  setupMic();
  updateSTTUI();
};
document.getElementById('stt-engine')?.addEventListener('change',e=>{
  cfg.sttEngine=e.target.value||'openai';
  setupMic();
  updateSTTUI();
});
document.getElementById('stt-language')?.addEventListener('change',e=>{
  cfg.sttLanguage=e.target.value||'auto';
});

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
  if(s==='ready'){dot.className='status-dot green';txt.textContent='ready';}
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
  inp.value='';inp.style.height='auto';
  resetIdleTimer();
  document.getElementById('quick-prompts-bar')?.remove();
  ipcRenderer.send('memory-update-mood',text);
  renderMsg('user',text);
  chatHistory.push({role:'user',content:text});
  isThinking=true;document.getElementById('send-btn').disabled=true;setStatus('think');

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
    let stream;
    switch(cfg.aiProvider){
      case 'openai':    stream=streamOpenAI(chatHistory);    break;
      case 'anthropic': stream=streamAnthropic(chatHistory); break;
      case 'gemini':    stream=streamGemini(chatHistory);    break;
      case 'nvidia':    stream=streamNVIDIA(chatHistory);    break;
      case 'custom':    stream=streamCustom(chatHistory);    break;
      default:          stream=streamOllama(chatHistory);
    }
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
  }catch(err){
    bubble.classList.remove('streaming');
    bubble.innerHTML=esc(friendlyError(cfg.aiProvider,err.message));
    setStatus('offline');
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
