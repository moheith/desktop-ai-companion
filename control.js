const { ipcRenderer, shell: electronShell } = require('electron');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { exec } = require('child_process');

// ─── Splash ───────────────────────────────────────────────
const splashBar = document.getElementById('splash-bar');
let splashPct   = 0;
const splashInt = setInterval(() => {
  splashPct = Math.min(splashPct + (splashPct < 70 ? 2.5 : 0.8), 98);
  splashBar.style.width = splashPct + '%';
}, 40);

function finishSplash() {
  clearInterval(splashInt);
  splashBar.style.width = '100%';
  setTimeout(() => {
    document.getElementById('splash').classList.add('fade-out');
    document.getElementById('app').classList.add('visible');
  }, 300);
}

// ─── Live2D ───────────────────────────────────────────────
let chatModel=null, chatPixiApp=null;
(async function loadLive2D() {
  try {
    new Function(fs.readFileSync(path.join(__dirname,'live2dcubismcore.min.js'),'utf8'))();
    const PIXI=require('pixi.js'); window.PIXI=PIXI;
    const {Live2DModel}=require('pixi-live2d-display/cubism4');
    const W=54,H=62,canvas=document.getElementById('char-canvas');
    canvas.width=W;canvas.height=H;
    chatPixiApp=new PIXI.Application({view:canvas,width:W,height:H,backgroundAlpha:0,antialias:true});
    chatModel=await Live2DModel.from('./model/ai_assistant_model.model3.json');
    chatPixiApp.stage.addChild(chatModel);
    chatModel.anchor.set(0.5,1.0);chatModel.scale.set(0.042);
    chatModel.x=W/2;chatModel.y=H;
  } catch(e){console.error('[Live2D]',e);}
})();

// ─── State ────────────────────────────────────────────────
let cfg={
  aiProvider:'ollama',ollamaModel:'llama3',ollamaUrl:'http://localhost:11434',
  openaiKey:'',openaiModel:'gpt-4o-mini',
  anthropicKey:'',anthropicModel:'claude-3-5-haiku-20241022',
  geminiKey:'',geminiModel:'gemini-2.0-flash',
  nvidiaKey:'',nvidiaModel:'nvidia/llama-3.1-nemotron-70b-instruct',
  customUrl:'',customKey:'',customModel:'',
  voiceEngine:'system',ttsEnabled:false,sttEnabled:false,systemVoice:'',
  elevenKey:'',elevenVoiceId:'EXAVITQu4vr4xnSDxMaL',elevenModel:'eleven_turbo_v2_5',
  piperPath:'',piperVoice:'',
  chatFontSize:14,theme:'dark',
  mascotVisible:true,clickThrough:true,borderVisible:false,alwaysOnTop:true,behindTaskbar:false,
  mascotX:1261,mascotY:264,mascotWidth:200,mascotHeight:220,scale:0.25,
};
let mem={userName:'',userFacts:[],personality:'',convoSummaries:[],totalMessages:0,currentMood:'neutral',memoryFeed:[]};
let chatHistory=[],isThinking=false,isListening=false,recognition=null;
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
  // AI
  setProviderTab(cfg.aiProvider||'ollama');
  setEl('ollama-url',cfg.ollamaUrl);
  setEl('openai-key',cfg.openaiKey);setEl('openai-model',cfg.openaiModel);
  setEl('anthropic-key',cfg.anthropicKey);setEl('anthropic-model',cfg.anthropicModel);
  setEl('gemini-key',cfg.geminiKey);setEl('gemini-model',cfg.geminiModel);
  setEl('nvidia-key',cfg.nvidiaKey);setEl('nvidia-model',cfg.nvidiaModel);
  setEl('custom-url',cfg.customUrl);setEl('custom-key',cfg.customKey);setEl('custom-model',cfg.customModel);
  // Voice
  setVoiceEngine(cfg.voiceEngine||'system');
  ck('tog-tts',cfg.ttsEnabled);ck('tog-stt',cfg.sttEnabled);
  setEl('eleven-key',cfg.elevenKey);setEl('eleven-model',cfg.elevenModel);
  setEl('piper-path',cfg.piperPath);setEl('piper-voice',cfg.piperVoice);
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
  cfg.elevenKey=val('eleven-key');
  cfg.elevenModel=val('eleven-model');
  cfg.elevenVoiceId=selectedElevenVoiceId||cfg.elevenVoiceId;
  cfg.piperPath=val('piper-path');
  cfg.piperVoice=val('piper-voice');
  ipcRenderer.send('save-config',{...cfg});
  flash('voice-save-ok');
  setupMic();
  updateHomeCards();
};

// ─── TTS ──────────────────────────────────────────────────
const MOOD_TTS={
  neutral: {rate:1.0, pitch:1.0},  happy:   {rate:1.08,pitch:1.08},
  excited: {rate:1.2, pitch:1.15}, shy:     {rate:0.95,pitch:1.06},
  sad:     {rate:0.85,pitch:0.9},  hurt:    {rate:0.88,pitch:0.88},
  caring:  {rate:0.93,pitch:1.03}, playful: {rate:1.1, pitch:1.1 },
  annoyed: {rate:1.05,pitch:0.93},
};

function getMoodTTS(){return MOOD_TTS[mem.currentMood||'neutral']||MOOD_TTS.neutral;}

function splitSentences(text){
  return text.match(/[^.!?]*[.!?]+["']?(?:\s|$)|[^.!?]+$/g)?.map(s=>s.trim()).filter(s=>s.length>2)||[text];
}
function cleanForTTS(text){
  return text.replace(/\*+/g,'').replace(/#+\s*/g,'').replace(/`+/g,'').replace(/\[.*?\]/g,'').replace(/https?:\/\/\S+/g,'link').replace(/\s+/g,' ').trim().substring(0,400);
}

function enqueueTTS(sentence){
  if(!cfg.ttsEnabled)return;
  const clean=cleanForTTS(sentence);
  if(!clean||clean.length<3)return;
  ttsQueue.push(clean);
  if(!ttsBusy)processTTSQueue();
}
function processTTSQueue(){
  if(!ttsQueue.length){ttsBusy=false;setBadge('');return;}
  ttsBusy=true;
  const s=ttsQueue.shift();setBadge('speaking');
  const speak=cfg.voiceEngine==='elevenlabs'?speakElevenLabs:cfg.voiceEngine==='piper'?speakPiper:speakSystem;
  speak(s).then(()=>processTTSQueue());
}
function stopTTS(){ttsQueue=[];ttsBusy=false;setBadge('');window.speechSynthesis.cancel();}
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
    const wd=setTimeout(()=>{window.speechSynthesis.cancel();resolve();},text.length*120+3000);
    utt.onend=utt.onerror=()=>{clearTimeout(wd);resolve();};
    window.speechSynthesis.speak(utt);
  });
}

async function speakElevenLabs(text){
  const key=cfg.elevenKey,vid=cfg.elevenVoiceId||'EXAVITQu4vr4xnSDxMaL',model=cfg.elevenModel||'eleven_turbo_v2_5';
  if(!key){return speakSystem(text);}
  const moodSettings={
    excited:  {stability:0.3,similarity_boost:0.7,style:0.8},
    happy:    {stability:0.4,similarity_boost:0.75,style:0.6},
    sad:      {stability:0.75,similarity_boost:0.6,style:0.15},
    hurt:     {stability:0.8,similarity_boost:0.6,style:0.1},
    shy:      {stability:0.65,similarity_boost:0.7,style:0.25},
    caring:   {stability:0.55,similarity_boost:0.75,style:0.4},
    annoyed:  {stability:0.5,similarity_boost:0.65,style:0.6},
    playful:  {stability:0.35,similarity_boost:0.7,style:0.7},
    neutral:  {stability:0.5,similarity_boost:0.75,style:0.4},
  };
  const vs=moodSettings[mem.currentMood||'neutral']||moodSettings.neutral;
  try{
    const res=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream`,{
      method:'POST',
      headers:{'xi-api-key':key,'Content-Type':'application/json'},
      body:JSON.stringify({text,model_id:model,voice_settings:{...vs,use_speaker_boost:true}}),
    });
    if(!res.ok)throw new Error('ElevenLabs error');
    const buf=await res.arrayBuffer();
    const ac=new (window.AudioContext||window.webkitAudioContext)();
    const decoded=await ac.decodeAudioData(buf);
    const src=ac.createBufferSource();src.buffer=decoded;src.connect(ac.destination);src.start();
    return new Promise(resolve=>{src.onended=()=>{ac.close();resolve();};});
  }catch(e){console.warn('[ElevenLabs]',e.message);return speakSystem(text);}
}

function speakPiper(text){
  return new Promise(resolve=>{
    if(!cfg.piperPath||!cfg.piperVoice){resolve();return;}
    const tmp=path.join(os.tmpdir(),`companion_piper_${Date.now()}.wav`);
    const safe=cleanForTTS(text).replace(/"/g,"'");
    exec(`echo "${safe}" | "${cfg.piperPath}" --model "${cfg.piperVoice}" --output_file "${tmp}"`,err=>{
      if(err){resolve();return;}
      const audio=new Audio(`file://${tmp}`);
      audio.onended=()=>{try{fs.unlinkSync(tmp);}catch(e){}resolve();};
      audio.onerror=()=>resolve();
      audio.play().catch(()=>resolve());
    });
  });
}

// ─── Mic / STT ────────────────────────────────────────────
function setupMic(){
  const btn=document.getElementById('mic-btn');
  if(!cfg.sttEnabled){btn.classList.remove('active-display');return;}
  btn.classList.add('active-display');
  if(recognition){try{recognition.stop();}catch(e){}recognition=null;}
  navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{
    stream.getTracks().forEach(t=>t.stop());
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR)return;
    recognition=new SR();
    recognition.continuous=true;         // FIX: keep listening
    recognition.interimResults=true;     // FIX: show live transcript
    recognition.lang='en-US';
    recognition.maxAlternatives=1;

    recognition.onstart=()=>{
      isListening=true;
      btn.classList.add('listening');
      btn.title='Listening… click to stop & send';
      showInterim('🎤 Listening…');
    };
    recognition.onend=()=>{
      if(isListening){
        // Auto-restart if still supposed to be listening
        try{recognition.start();}catch(e){stopListening();}
      }
    };
    recognition.onerror=(e)=>{
      console.warn('[STT]',e.error);
      if(e.error!=='no-speech') stopListening();
    };
    recognition.onresult=(e)=>{
      let interim='',final='';
      for(let i=e.resultIndex;i<e.results.length;i++){
        const t=e.results[i][0].transcript;
        if(e.results[i].isFinal) final+=t;
        else interim+=t;
      }
      // Show interim in real-time
      const inp=document.getElementById('chat-input');
      if(interim) showInterim('🎤 '+interim);
      if(final){
        inp.value=(inp.value+' '+final).trim();
        inp.style.height='auto';inp.style.height=Math.min(inp.scrollHeight,100)+'px';
        showInterim('');
      }
    };
    btn.title='Click to speak';
  }).catch(err=>{console.error('[Mic]',err);btn.title='Mic permission denied';});
}

function showInterim(text){
  const el=document.getElementById('mic-interim');
  if(!el)return;
  el.textContent=text;el.classList.toggle('active',!!text);
}

function startListening(){if(!recognition||isListening)return;isListening=true;try{recognition.start();}catch(e){console.error('[STT start]',e);}}
function stopListening(){
  isListening=false;
  try{recognition?.stop();}catch(e){}
  document.getElementById('mic-btn')?.classList.remove('listening');
  document.getElementById('mic-btn') && (document.getElementById('mic-btn').title='Click to speak');
  showInterim('');
  // Auto-send if there's text
  const inp=document.getElementById('chat-input');
  if(inp&&inp.value.trim()) send();
}

document.getElementById('mic-btn').onclick=()=>{
  if(isListening) stopListening();
  else{if(!recognition)setupMic();startListening();}
};
document.getElementById('tog-stt').onchange=e=>{cfg.sttEnabled=e.target.checked;setupMic();};

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
document.querySelectorAll('.theme-swatch').forEach(s=>s.onclick=()=>{
  document.querySelectorAll('.theme-swatch').forEach(x=>x.classList.remove('selected'));
  s.classList.add('selected');cfg.theme=s.dataset.theme;
});
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
  // Mood bar
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
  // Memory feed
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
  // Update mood from user's message
  ipcRenderer.send('memory-update-mood',text);
  renderMsg('user',text);
  chatHistory.push({role:'user',content:text});
  isThinking=true;document.getElementById('send-btn').disabled=true;setStatus('think');

  // Streaming bubble
  document.getElementById('chat-empty').style.display='none';
  const wrap=document.getElementById('chat-messages');
  const msgDiv=document.createElement('div');msgDiv.className='msg ai';
  const sender=document.createElement('div');sender.className='msg-sender';sender.textContent='Companion';
  const bubble=document.createElement('div');bubble.className=`msg-bubble streaming`;bubble.style.fontSize=currentFontSize+'px';
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
      if(cfg.ttsEnabled&&/[.!?]\s*$/.test(sentBuf.trimEnd())){
        splitSentences(sentBuf).forEach(s=>enqueueTTS(s));sentBuf='';
      }
    }
    if(cfg.ttsEnabled&&sentBuf.trim()) splitSentences(sentBuf).forEach(s=>enqueueTTS(s));
    bubble.classList.remove('streaming');
    chatHistory.push({role:'assistant',content:fullReply});
    ipcRenderer.send('save-chat-history',chatHistory);
    autoLearn(fullReply);setStatus('ready');
  }catch(err){
    bubble.classList.remove('streaming');
    bubble.innerHTML=esc(friendlyError(cfg.aiProvider,err.message));
    setStatus('offline');
  }finally{isThinking=false;document.getElementById('send-btn').disabled=false;}
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
    return `⚠️ ${provider} rate limit hit — you've sent too many messages too fast. Free tier has strict limits.${wait}\n\nTip: Switch to Ollama (local, unlimited) or upgrade your API plan.`;
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
  const res=await fetch(cfg.customUrl+'/chat/completions',{
    method:'POST',headers:{'Content-Type':'application/json',...(cfg.customKey?{'Authorization':'Bearer '+cfg.customKey}:{})},
    body:JSON.stringify({model:cfg.customModel,stream:true,
      messages:[{role:'system',content:buildSystemPrompt()},...history.slice(-20)]}),
  });
  if(!res.ok)throw new Error(`Custom API ${res.status}`);
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