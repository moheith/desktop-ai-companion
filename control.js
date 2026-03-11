const { ipcRenderer } = require('electron');
const fs        = require('fs');
const path      = require('path');
const { exec, spawn } = require('child_process');
const os        = require('os');

// ─── Load Live2D immediately ──────────────────────────────
let chatModel = null, chatPixiApp = null;
(async function loadLive2D() {
  try {
    new Function(fs.readFileSync(path.join(__dirname, 'live2dcubismcore.min.js'), 'utf8'))();
    const PIXI = require('pixi.js');
    window.PIXI = PIXI;
    const { Live2DModel } = require('pixi-live2d-display/cubism4');
    const W = 70, H = 80, canvas = document.getElementById('char-canvas');
    canvas.width = W; canvas.height = H;
    chatPixiApp = new PIXI.Application({ view:canvas, width:W, height:H, backgroundAlpha:0, antialias:true });
    chatModel = await Live2DModel.from('./model/ai_assistant_model.model3.json');
    chatPixiApp.stage.addChild(chatModel);
    chatModel.anchor.set(0.5, 1.0);
    chatModel.scale.set(0.052);
    chatModel.x = W / 2; chatModel.y = H;
    console.log('[chat] Live2D ✓');
  } catch(e) { console.error('[chat] Live2D fail:', e); }
})();

// ─── State ────────────────────────────────────────────────
let cfg = {
  x:1261,y:264,width:200,height:220,scale:0.25,
  mascotVisible:true,clickThrough:true,borderVisible:false,
  alwaysOnTop:true,behindTaskbar:false,ollamaModel:'llama3',
  piperPath:'',piperVoice:'',ttsEnabled:false,sttEnabled:false,
  ttsEngine:'edge', edgeVoice:'en-US-AriaNeural',
};
let mem         = { userName:'',userFacts:[],personality:'',convoSummaries:[],totalMessages:0 };
let chatHistory = [], isThinking=false, isListening=false;
let recognition = null;
// TTS queue — array of sentence strings waiting to speak
let ttsQueue = [], ttsBusy = false;

// ─── Init ─────────────────────────────────────────────────
ipcRenderer.on('init-config', (_, s) => {
  Object.assign(cfg, s);
  if (s.memory) Object.assign(mem, s.memory);

  document.getElementById('pos-x').value           = cfg.x;
  document.getElementById('pos-y').value           = cfg.y;
  document.getElementById('win-w').value           = cfg.width;
  document.getElementById('win-h').value           = cfg.height;
  document.getElementById('scale-slider').value    = cfg.scale;
  document.getElementById('scale-val').textContent = Number(cfg.scale).toFixed(2);
  document.getElementById('tog-mascot').checked    = cfg.mascotVisible;
  document.getElementById('tog-click').checked     = cfg.clickThrough;
  document.getElementById('tog-border').checked    = cfg.borderVisible;
  document.getElementById('tog-ontop').checked     = cfg.alwaysOnTop;
  document.getElementById('tog-taskbar').checked   = cfg.behindTaskbar;
  document.getElementById('ollama-model').value    = cfg.ollamaModel||'llama3';
  document.getElementById('piper-path').value      = cfg.piperPath||'';
  document.getElementById('piper-voice').value     = cfg.piperVoice||'';
  document.getElementById('tog-tts').checked       = cfg.ttsEnabled;
  document.getElementById('tog-stt').checked       = cfg.sttEnabled;
  document.getElementById('tts-engine').value      = cfg.ttsEngine||'edge';
  document.getElementById('edge-voice').value      = cfg.edgeVoice||'en-US-AriaNeural';
  document.getElementById('mbadge').textContent    = cfg.ollamaModel||'llama3';
  document.getElementById('mem-name').value        = mem.userName||'';
  document.getElementById('mem-personality').value = mem.personality||'';
  updatePiperFieldsVisibility();
  renderFacts();
  if (s.chatHistory?.length>0) {
    chatHistory = s.chatHistory;
    chatHistory.forEach(m => renderMsg(m.role==='user'?'user':'ai', m.content, false));
    scrollChat();
  }
  checkOllama();
  setupMic();
});

document.getElementById('tts-engine').onchange = updatePiperFieldsVisibility;
function updatePiperFieldsVisibility() {
  const engine = document.getElementById('tts-engine').value;
  document.getElementById('piper-fields').style.display = engine==='piper' ? 'flex' : 'none';
  document.getElementById('piper-fields').style.flexDirection = 'column';
  document.getElementById('piper-fields').style.gap = '8px';
}

ipcRenderer.on('state-update', (_, u) => {
  if (u.alwaysOnTop   != null) { cfg.alwaysOnTop  =u.alwaysOnTop;  document.getElementById('tog-ontop').checked  =cfg.alwaysOnTop; }
  if (u.behindTaskbar != null) { cfg.behindTaskbar=u.behindTaskbar;document.getElementById('tog-taskbar').checked=cfg.behindTaskbar; }
});
ipcRenderer.on('save-confirmed', () => flash('save-ok'));
ipcRenderer.on('chat-history-cleared', () => { chatHistory=[]; clearChatUI(); });

// ─── Tabs ─────────────────────────────────────────────────
let curPage='settings';
document.querySelectorAll('.tab').forEach(t => {
  t.onclick=()=>{
    const pg=t.dataset.page; if(pg===curPage)return; curPage=pg;
    document.querySelectorAll('.tab').forEach(x  => x.classList.toggle('active',x.dataset.page===pg));
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active',p.id===`page-${pg}`));
    document.getElementById('settings-footer').style.display=pg==='settings'?'flex':'none';
    if(pg==='chat')  { checkOllama(); setTimeout(scrollChat,100); }
    if(pg==='memory') renderFacts();
  };
});

// ─── Window buttons ───────────────────────────────────────
document.getElementById('btn-close').onclick = () => ipcRenderer.send('close-panel');
document.getElementById('btn-min').onclick   = () => ipcRenderer.send('minimize-panel');
document.getElementById('btn-max').onclick   = () => ipcRenderer.send('maximize-panel');

// ─── Toggles ─────────────────────────────────────────────
document.getElementById('tog-mascot').onchange  = e => { cfg.mascotVisible=e.target.checked; ipcRenderer.send('toggle-mascot',cfg.mascotVisible); };
document.getElementById('tog-click').onchange   = e => { cfg.clickThrough =e.target.checked; ipcRenderer.send('toggle-click-through',cfg.clickThrough); };
document.getElementById('tog-border').onchange  = e => { cfg.borderVisible=e.target.checked; ipcRenderer.send('toggle-border',cfg.borderVisible); };
document.getElementById('tog-ontop').onchange   = e => {
  cfg.alwaysOnTop=e.target.checked;
  if(cfg.alwaysOnTop){cfg.behindTaskbar=false;document.getElementById('tog-taskbar').checked=false;}
  ipcRenderer.send('toggle-always-on-top',cfg.alwaysOnTop);
};
document.getElementById('tog-taskbar').onchange = e => {
  cfg.behindTaskbar=e.target.checked;
  if(cfg.behindTaskbar){cfg.alwaysOnTop=false;document.getElementById('tog-ontop').checked=false;}
  ipcRenderer.send('toggle-behind-taskbar',cfg.behindTaskbar);
};
document.getElementById('tog-stt').onchange = e => { cfg.sttEnabled=e.target.checked; setupMic(); };

// ─── Position / Size / Scale ──────────────────────────────
const sendPos  = () => ipcRenderer.send('preview-position',{x:cfg.x,y:cfg.y});
const sendSize = () => ipcRenderer.send('preview-size',{width:cfg.width,height:cfg.height});
document.getElementById('x-m').onclick   = () => {cfg.x-=5;  document.getElementById('pos-x').value=cfg.x; sendPos();};
document.getElementById('x-p').onclick   = () => {cfg.x+=5;  document.getElementById('pos-x').value=cfg.x; sendPos();};
document.getElementById('y-m').onclick   = () => {cfg.y-=5;  document.getElementById('pos-y').value=cfg.y; sendPos();};
document.getElementById('y-p').onclick   = () => {cfg.y+=5;  document.getElementById('pos-y').value=cfg.y; sendPos();};
document.getElementById('pos-x').oninput = e => {cfg.x=parseInt(e.target.value)||0; sendPos();};
document.getElementById('pos-y').oninput = e => {cfg.y=parseInt(e.target.value)||0; sendPos();};
document.getElementById('w-m').onclick   = () => {cfg.width =Math.max(50,cfg.width-10);  document.getElementById('win-w').value=cfg.width;  sendSize();};
document.getElementById('w-p').onclick   = () => {cfg.width+=10;                          document.getElementById('win-w').value=cfg.width;  sendSize();};
document.getElementById('h-m').onclick   = () => {cfg.height=Math.max(50,cfg.height-10); document.getElementById('win-h').value=cfg.height; sendSize();};
document.getElementById('h-p').onclick   = () => {cfg.height+=10;                         document.getElementById('win-h').value=cfg.height; sendSize();};
document.getElementById('win-w').oninput = e => {cfg.width =Math.max(50,parseInt(e.target.value)||50); sendSize();};
document.getElementById('win-h').oninput = e => {cfg.height=Math.max(50,parseInt(e.target.value)||50); sendSize();};
document.getElementById('scale-slider').oninput = e => {
  cfg.scale=parseFloat(e.target.value);
  document.getElementById('scale-val').textContent=cfg.scale.toFixed(2);
  ipcRenderer.send('preview-scale',{scale:cfg.scale});
};

// ─── Save ─────────────────────────────────────────────────
document.getElementById('btn-save').onclick = () => {
  cfg.x=parseInt(document.getElementById('pos-x').value)||cfg.x;
  cfg.y=parseInt(document.getElementById('pos-y').value)||cfg.y;
  cfg.width=parseInt(document.getElementById('win-w').value)||cfg.width;
  cfg.height=parseInt(document.getElementById('win-h').value)||cfg.height;
  cfg.scale=parseFloat(document.getElementById('scale-slider').value);
  cfg.ollamaModel=document.getElementById('ollama-model').value.trim()||'llama3';
  cfg.piperPath  =document.getElementById('piper-path').value.trim();
  cfg.piperVoice =document.getElementById('piper-voice').value.trim();
  cfg.ttsEnabled =document.getElementById('tog-tts').checked;
  cfg.sttEnabled =document.getElementById('tog-stt').checked;
  cfg.ttsEngine  =document.getElementById('tts-engine').value;
  cfg.edgeVoice  =document.getElementById('edge-voice').value;
  document.getElementById('mbadge').textContent=cfg.ollamaModel;
  ipcRenderer.send('save-config',{...cfg});
  setupMic();
};

// ─── Ollama ───────────────────────────────────────────────
async function checkOllama() {
  if(isThinking)return;
  try { const r=await fetch('http://localhost:11434/api/tags',{signal:AbortSignal.timeout(2000)}); setStatus(r.ok?'ready':'offline'); }
  catch { setStatus('offline'); }
}
function setStatus(s) {
  const dot=document.getElementById('sdot'), txt=document.getElementById('stext');
  if(s==='ready')  {dot.className='dot';         txt.textContent='ollama ready';}
  if(s==='offline'){dot.className='dot off';     txt.textContent='ollama offline';}
  if(s==='think')  {dot.className='dot thinking';txt.textContent='thinking...';}
}

// ─── MEMORY ───────────────────────────────────────────────
function renderFacts() {
  const list=document.getElementById('facts-list'); if(!list)return;
  const count=document.getElementById('facts-count');
  if(count) count.textContent=`${mem.userFacts.length} facts`;
  list.innerHTML='';
  if(!mem.userFacts.length){list.innerHTML='<div class="no-facts">No facts yet — I\'ll learn as we chat!</div>';return;}
  mem.userFacts.forEach((fact,i)=>{
    const row=document.createElement('div'); row.className='fact-row';
    row.innerHTML=`<span class="fact-text">${esc(fact)}</span><button class="fact-del" data-i="${i}">✕</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll('.fact-del').forEach(btn=>{
    btn.onclick=()=>{ const idx=parseInt(btn.dataset.i); mem.userFacts.splice(idx,1); ipcRenderer.send('memory-remove-fact',idx); renderFacts(); };
  });
}
document.getElementById('mem-save-name').onclick=()=>{ const n=document.getElementById('mem-name').value.trim(); mem.userName=n; ipcRenderer.send('memory-set-name',n); flash('mem-name-ok'); };
document.getElementById('mem-save-personality').onclick=()=>{ const t=document.getElementById('mem-personality').value.trim(); mem.personality=t; ipcRenderer.send('memory-set-personality',t); flash('mem-pers-ok'); };
document.getElementById('mem-add-fact-btn').onclick=()=>{ const inp=document.getElementById('mem-add-fact'),f=inp.value.trim(); if(!f)return; mem.userFacts.push(f); ipcRenderer.send('memory-add-fact',f); inp.value=''; renderFacts(); };
document.getElementById('mem-add-fact').addEventListener('keydown',e=>{ if(e.key==='Enter')document.getElementById('mem-add-fact-btn').click(); });
document.getElementById('mem-clear-facts').onclick=()=>{ if(!confirm('Clear all facts?'))return; mem.userFacts=[]; ipcRenderer.send('memory-clear-facts'); renderFacts(); };
document.getElementById('mem-clear-all').onclick=()=>{
  if(!confirm('Reset ALL memory? Cannot be undone.'))return;
  mem={userName:'',userFacts:[],personality:'',convoSummaries:[],totalMessages:0};
  ipcRenderer.send('memory-clear-all');
  document.getElementById('mem-name').value='';
  document.getElementById('mem-personality').value='';
  renderFacts();
};

function buildSystemPrompt() {
  const lines=[];
  if(mem.userName) lines.push(`The user's name is ${mem.userName}. Use their name naturally sometimes.`);
  if(mem.userFacts.length>0){lines.push('What you know about the user:');mem.userFacts.forEach(f=>lines.push(`- ${f}`));}
  if(mem.convoSummaries?.length>0){lines.push('Past conversations:');mem.convoSummaries.slice(-3).forEach(s=>lines.push(`[${s.date}] ${s.summary}`));}
  const memBlock=lines.length>0?`\n\nMemory:\n${lines.join('\n')}`:'';
  const persNote=mem.personality?`\n\nPersonality instructions: ${mem.personality}`:'';
  return `You are a friendly, cute AI companion living on the user's desktop as a Live2D anime character. Be warm, helpful, slightly playful, and conversational. Keep replies reasonably concise.${persNote}${memBlock}`;
}

function autoLearn(reply) {
  const pats=[/(?:you mentioned|you said|you told me|i'll remember that you|i note that you) (.{5,60})/i];
  pats.forEach(p=>{ const m=reply.match(p); if(m&&m[1]){const f=m[1].replace(/[.!?].*/,'').trim();if(f.length>4&&!mem.userFacts.includes(f)){mem.userFacts.push(f);ipcRenderer.send('memory-add-fact',f);}} });
}

// ─── TTS — Sentence queue ─────────────────────────────────
// Splits text into sentences and speaks them one by one
function splitSentences(text) {
  // Split on . ! ? followed by space or end, but not on abbreviations like "e.g."
  return text.match(/[^.!?]*[.!?]+["']?(?:\s|$)|[^.!?]+$/g)?.map(s=>s.trim()).filter(s=>s.length>2) || [text];
}

function enqueueSentence(sentence) {
  if(!cfg.ttsEnabled) return;
  const clean = sentence.replace(/\*+/g,'').replace(/[^\x00-\x7F]/g,' ').replace(/\s+/g,' ').trim();
  if(!clean||clean.length<3) return;
  ttsQueue.push(clean);
  if(!ttsBusy) processQueue();
}

async function processQueue() {
  if(!ttsQueue.length){ ttsBusy=false; setBadge(''); return; }
  ttsBusy=true;
  const sentence=ttsQueue.shift();
  setBadge('speaking');

  const engine=cfg.ttsEngine||'edge';
  if(engine==='edge') {
    await speakEdge(sentence);
  } else {
    await speakPiper(sentence);
  }
  processQueue();
}

function setBadge(state) {
  const b=document.getElementById('tts-badge');
  if(!b)return;
  b.className = state==='speaking'?'tts-badge speaking':state==='queued'?'tts-badge queued':'tts-badge';
  b.textContent = state==='speaking'?'🔊 speaking...':state==='queued'?'⏳ queued':'';
}

// Edge TTS — uses edge-tts npm package (install: npm i edge-tts)
// Falls back to PowerShell if edge-tts not available
function speakEdge(text) {
  return new Promise(resolve => {
    const voice   = cfg.edgeVoice || 'en-US-AriaNeural';
    const tmpFile = path.join(os.tmpdir(), `companion_edge_${Date.now()}.mp3`);

    // Detect emotion from text and add SSML prosody hints
    let rate='0%', pitch='0Hz', volume='0%';
    if(/[!]{1,}/.test(text))     { rate='+10%'; pitch='+5Hz'; }  // excited
    if(/\?/.test(text))          { pitch='+3Hz'; }               // questioning
    if(/\.\.\.|hmm|oh\b/i.test(text)) { rate='-5%'; }           // thinking/slow

    // Try edge-tts CLI (npm install -g edge-tts)
    const cmd = `edge-tts --voice "${voice}" --rate "${rate}" --pitch "${pitch}" --text "${text.replace(/"/g,"'")}" --write-media "${tmpFile}"`;

    exec(cmd, err => {
      if(err) {
        // Fallback: PowerShell SpeechSynthesizer (SAPI, built-in Windows, no install)
        const ps = `
Add-Type -AssemblyName System.Speech;
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
$s.Rate = ${/[!]/.test(text)?2:0};
$s.SpeakAsync('${text.replace(/'/g,' ')}') | Out-Null;
Start-Sleep -Milliseconds (($s.State -eq 0) ? 100 : 500);
$s.Speak('');
`.trim().replace(/\n/g,' ');
        exec(`powershell -c "${ps}"`, () => resolve());
        return;
      }
      // Play the mp3
      const play = `powershell -c "$p=New-Object Media.SoundPlayer; Add-Type -AssemblyName presentationCore; $m=[System.Windows.Media.MediaPlayer]::new(); $m.Open([uri]'${tmpFile.replace(/\\/g,'/')}'); $m.Play(); Start-Sleep 3; $m.Close()"`;
      // Simpler: use Windows Media Player via PowerShell
      const playCmd = `powershell -c "Add-Type -AssemblyName presentationCore; $mp = New-Object System.Windows.Media.MediaPlayer; $mp.Open([System.Uri]'${tmpFile.replace(/\\/g,'/')}'); $mp.Play(); Start-Sleep -s 5; $mp.Close()"`;
      exec(playCmd, () => {
        try{fs.unlinkSync(tmpFile);}catch(e){}
        resolve();
      });
    });
  });
}

function speakPiper(text) {
  return new Promise(resolve => {
    if(!cfg.piperPath||!cfg.piperVoice){resolve();return;}
    const tmpWav=path.join(os.tmpdir(),`companion_piper_${Date.now()}.wav`);
    const safe=text.replace(/"/g,"'").replace(/\n/g,' ').substring(0,400);
    exec(`echo "${safe}" | "${cfg.piperPath}" --model "${cfg.piperVoice}" --output_file "${tmpWav}"`,
      err=>{
        if(err){console.error('[Piper]',err.message);resolve();return;}
        exec(`powershell -c "(New-Object Media.SoundPlayer '${tmpWav.replace(/\\/g,'\\\\')}').PlaySync()"`,
          ()=>{ try{fs.unlinkSync(tmpWav);}catch(e){} resolve(); });
      }
    );
  });
}

// ─── MIC / STT ────────────────────────────────────────────
function setupMic() {
  const btn=document.getElementById('mic-btn');
  if(!cfg.sttEnabled) { btn.classList.remove('active-display'); return; }
  btn.classList.add('active-display');

  // Stop old instance
  if(recognition){ try{recognition.stop();}catch(e){} recognition=null; }

  // Ask for mic permission via getUserMedia first (required in Electron)
  navigator.mediaDevices.getUserMedia({audio:true})
    .then(stream => {
      // Got permission — stop the stream, we just needed the permission grant
      stream.getTracks().forEach(t=>t.stop());

      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if(!SR){ btn.title='Speech recognition not available'; return; }

      recognition = new SR();
      recognition.continuous     = false;
      recognition.interimResults = false;
      recognition.lang           = 'en-US';
      recognition.maxAlternatives = 1;

      recognition.onstart  = () => { isListening=true;  btn.classList.add('listening'); btn.title='Listening... click to cancel'; };
      recognition.onend    = () => { isListening=false; btn.classList.remove('listening'); btn.title='Click to speak'; };
      recognition.onerror  = (e) => { console.warn('[STT]',e.error); isListening=false; btn.classList.remove('listening'); };
      recognition.onresult = (e) => {
        const text=e.results[0][0].transcript.trim();
        if(text){ document.getElementById('chat-input').value=text; send(); }
      };
      btn.title='Click to speak';
    })
    .catch(err => {
      console.error('[Mic] Permission denied:', err);
      btn.title='Microphone permission denied';
    });
}

document.getElementById('mic-btn').onclick = () => {
  if(!recognition){ setupMic(); return; }
  if(isListening) { try{recognition.stop();}catch(e){} }
  else            { try{recognition.start();}catch(e){ console.error('[STT start]',e); } }
};

// ─── CHAT ─────────────────────────────────────────────────
function renderMsg(role,content,animate=true) {
  document.getElementById('chat-empty').style.display='none';
  const wrap=document.getElementById('chat-messages');
  const div=document.createElement('div'); div.className=`msg ${role}`;
  if(!animate)div.style.animation='none';
  const now=new Date(),time=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  div.innerHTML=`<div class="msg-sender">${role==='user'?(mem.userName||'You'):'Companion'}</div>
    <div class="msg-bubble">${esc(content)}</div><div class="msg-time">${time}</div>`;
  wrap.appendChild(div); scrollChat();
  return div.querySelector('.msg-bubble');
}
function scrollChat() { const w=document.getElementById('chat-messages'); if(w)w.scrollTop=w.scrollHeight; }
function clearChatUI(){ document.getElementById('chat-messages').innerHTML=`<div id="chat-empty"><div class="ei">✨</div><div class="et">Say something!<br/>She's listening...</div></div>`; }
function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br/>'); }
function flash(id){ const e=document.getElementById(id); if(!e)return; e.classList.add('show'); setTimeout(()=>e.classList.remove('show'),2200); }

// ─── STREAMING SEND ───────────────────────────────────────
async function send() {
  const inp=document.getElementById('chat-input'),text=inp.value.trim();
  if(!text||isThinking)return;
  const model=document.getElementById('ollama-model')?.value.trim()||cfg.ollamaModel||'llama3';
  inp.value=''; inp.style.height='auto';
  renderMsg('user',text);
  chatHistory.push({role:'user',content:text});
  isThinking=true;
  document.getElementById('send-btn').disabled=true;
  setStatus('think');

  // Create streaming AI bubble
  document.getElementById('chat-empty').style.display='none';
  const wrap=document.getElementById('chat-messages');
  const msgDiv=document.createElement('div'); msgDiv.className='msg ai';
  const senderDiv=document.createElement('div'); senderDiv.className='msg-sender'; senderDiv.textContent='Companion';
  const bubble=document.createElement('div'); bubble.className='msg-bubble streaming';
  const timeDiv=document.createElement('div'); timeDiv.className='msg-time';
  const now=new Date(); timeDiv.textContent=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  msgDiv.appendChild(senderDiv); msgDiv.appendChild(bubble); msgDiv.appendChild(timeDiv);
  wrap.appendChild(msgDiv); scrollChat();

  let fullReply='';
  let sentenceBuffer='';

  try {
    const res=await fetch('http://localhost:11434/api/chat',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        model,
        stream:true,                   // ← streaming enabled
        messages:[
          {role:'system',content:buildSystemPrompt()},
          ...chatHistory.slice(-20),
        ],
      }),
    });

    if(!res.ok) throw new Error(`Ollama ${res.status}`);

    const reader=res.body.getReader();
    const decoder=new TextDecoder();

    while(true) {
      const {done,value}=await reader.read();
      if(done) break;

      const lines=decoder.decode(value).split('\n').filter(l=>l.trim());
      for(const line of lines) {
        try {
          const json=JSON.parse(line);
          const token=json.message?.content||'';
          if(!token) continue;
          fullReply+=token;
          sentenceBuffer+=token;
          // Update bubble live
          bubble.innerHTML=esc(fullReply);
          scrollChat();

          // Check if we have a complete sentence to speak
          if(cfg.ttsEnabled && /[.!?]\s*$/.test(sentenceBuffer.trimEnd())) {
            const sentences=splitSentences(sentenceBuffer);
            sentences.forEach(s=>enqueueSentence(s));
            sentenceBuffer='';
          }
        } catch(e){}
      }
    }

    // Speak any remaining text that didn't end with punctuation
    if(cfg.ttsEnabled && sentenceBuffer.trim()) {
      splitSentences(sentenceBuffer).forEach(s=>enqueueSentence(s));
    }

    // Finalize
    bubble.classList.remove('streaming');
    chatHistory.push({role:'assistant',content:fullReply});
    ipcRenderer.send('save-chat-history',chatHistory);
    autoLearn(fullReply);
    setStatus('ready');

  } catch(err) {
    bubble.classList.remove('streaming');
    bubble.innerHTML=err.message.includes('fetch')||err.message.includes('Failed')
      ? esc('⚠️ Ollama not running.\n\nRun:  ollama serve')
      : esc(`⚠️ ${err.message}`);
    setStatus('offline');
  } finally {
    isThinking=false;
    document.getElementById('send-btn').disabled=false;
  }
}

document.getElementById('send-btn').onclick=send;
document.getElementById('chat-input').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();} });
document.getElementById('chat-input').addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px';});
document.getElementById('clear-chat-btn').onclick=()=>{ if(confirm('Clear chat history?'))ipcRenderer.send('clear-chat-history'); };