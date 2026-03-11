const { ipcRenderer } = require('electron');
const fs       = require('fs');
const path     = require('path');
const { exec } = require('child_process');

// ─── Load Live2D immediately ──────────────────────────────
let chatModel = null, chatPixiApp = null;
(async function loadLive2D() {
  try {
    new Function(fs.readFileSync(path.join(__dirname, 'live2dcubismcore.min.js'), 'utf8'))();
    const PIXI = require('pixi.js');
    window.PIXI = PIXI;
    const { Live2DModel } = require('pixi-live2d-display/cubism4');
    const W = 220, H = 220, canvas = document.getElementById('char-canvas');
    canvas.width = W; canvas.height = H;
    chatPixiApp = new PIXI.Application({ view: canvas, width: W, height: H, backgroundAlpha: 0, antialias: true });
    chatModel = await Live2DModel.from('./model/ai_assistant_model.model3.json');
    chatPixiApp.stage.addChild(chatModel);
    chatModel.anchor.set(0.5, 1.0); chatModel.scale.set(0.15);
    chatModel.x = W / 2; chatModel.y = H;
    console.log('[chat] Live2D loaded ✓');
  } catch (e) { console.error('[chat] Live2D fail:', e); }
})();

// ─── State ────────────────────────────────────────────────
let cfg = {
  x:1261,y:264,width:200,height:220,scale:0.25,
  mascotVisible:true,clickThrough:true,borderVisible:false,
  alwaysOnTop:true,behindTaskbar:false,ollamaModel:'llama3',
  piperPath:'',piperVoice:'',ttsEnabled:false,sttEnabled:false,
};
let mem = { userName:'',userFacts:[],personality:'',convoSummaries:[],totalMessages:0 };
let chatHistory=[], isThinking=false, isListening=false;
let recognition=null, ttsProc=null;

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
  document.getElementById('mbadge').textContent    = cfg.ollamaModel||'llama3';
  document.getElementById('mem-name').value        = mem.userName||'';
  document.getElementById('mem-personality').value = mem.personality||'';
  renderFacts();

  if (s.chatHistory?.length > 0) {
    chatHistory = s.chatHistory;
    chatHistory.forEach(m => renderMsg(m.role==='user'?'user':'ai', m.content, false));
    scrollChat();
  }
  checkOllama(); initSTT();
});

ipcRenderer.on('state-update', (_, u) => {
  if (u.alwaysOnTop   != null) { cfg.alwaysOnTop  =u.alwaysOnTop;  document.getElementById('tog-ontop').checked  =cfg.alwaysOnTop; }
  if (u.behindTaskbar != null) { cfg.behindTaskbar=u.behindTaskbar;document.getElementById('tog-taskbar').checked=cfg.behindTaskbar; }
});
ipcRenderer.on('save-confirmed', () => { flash('save-ok'); });
ipcRenderer.on('chat-history-cleared', () => { chatHistory=[]; clearChatUI(); });

// ─── Tabs ─────────────────────────────────────────────────
let curPage = 'settings';
document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    const pg = t.dataset.page; if (pg===curPage) return;
    curPage = pg;
    document.querySelectorAll('.tab').forEach(x  => x.classList.toggle('active', x.dataset.page===pg));
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id===`page-${pg}`));
    document.getElementById('settings-footer').style.display = pg==='settings'?'flex':'none';
    if (pg==='chat')   { checkOllama(); setTimeout(scrollChat,100); }
    if (pg==='memory') renderFacts();
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
  if (cfg.alwaysOnTop){cfg.behindTaskbar=false;document.getElementById('tog-taskbar').checked=false;}
  ipcRenderer.send('toggle-always-on-top',cfg.alwaysOnTop);
};
document.getElementById('tog-taskbar').onchange = e => {
  cfg.behindTaskbar=e.target.checked;
  if (cfg.behindTaskbar){cfg.alwaysOnTop=false;document.getElementById('tog-ontop').checked=false;}
  ipcRenderer.send('toggle-behind-taskbar',cfg.behindTaskbar);
};

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
  document.getElementById('mbadge').textContent=cfg.ollamaModel;
  ipcRenderer.send('save-config',{...cfg});
  initSTT();
};

// ─── Ollama ───────────────────────────────────────────────
async function checkOllama() {
  if (isThinking) return;
  try { const r=await fetch('http://localhost:11434/api/tags',{signal:AbortSignal.timeout(2000)}); setStatus(r.ok?'ready':'offline'); }
  catch { setStatus('offline'); }
}
function setStatus(s) {
  const dot=document.getElementById('sdot'), txt=document.getElementById('stext');
  if (s==='ready')  {dot.className='dot';         txt.textContent='ollama ready';}
  if (s==='offline'){dot.className='dot off';     txt.textContent='ollama offline';}
  if (s==='think')  {dot.className='dot thinking';txt.textContent='thinking...';}
}

// ─── MEMORY ───────────────────────────────────────────────
function renderFacts() {
  const list=document.getElementById('facts-list'); if(!list)return;
  list.innerHTML='';
  const count=document.getElementById('facts-count');
  if (count) count.textContent=`${mem.userFacts.length} facts`;
  if (mem.userFacts.length===0) {
    list.innerHTML='<div class="no-facts">No facts yet. I\'ll learn as we chat!</div>'; return;
  }
  mem.userFacts.forEach((fact,i)=>{
    const row=document.createElement('div'); row.className='fact-row';
    row.innerHTML=`<span class="fact-text">${esc(fact)}</span><button class="fact-del" data-i="${i}">✕</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll('.fact-del').forEach(btn=>{
    btn.onclick=()=>{
      const idx=parseInt(btn.dataset.i);
      mem.userFacts.splice(idx,1);
      ipcRenderer.send('memory-remove-fact',idx);
      renderFacts();
    };
  });
}
document.getElementById('mem-save-name').onclick=()=>{
  const n=document.getElementById('mem-name').value.trim();
  mem.userName=n; ipcRenderer.send('memory-set-name',n); flash('mem-name-ok');
};
document.getElementById('mem-save-personality').onclick=()=>{
  const t=document.getElementById('mem-personality').value.trim();
  mem.personality=t; ipcRenderer.send('memory-set-personality',t); flash('mem-pers-ok');
};
document.getElementById('mem-add-fact-btn').onclick=()=>{
  const inp=document.getElementById('mem-add-fact'), f=inp.value.trim(); if(!f)return;
  mem.userFacts.push(f); ipcRenderer.send('memory-add-fact',f); inp.value=''; renderFacts();
};
document.getElementById('mem-add-fact').addEventListener('keydown',e=>{
  if(e.key==='Enter') document.getElementById('mem-add-fact-btn').click();
});
document.getElementById('mem-clear-facts').onclick=()=>{
  if(!confirm('Clear all facts?'))return;
  mem.userFacts=[]; ipcRenderer.send('memory-clear-facts'); renderFacts();
};
document.getElementById('mem-clear-all').onclick=()=>{
  if(!confirm('Reset ALL memory?'))return;
  mem={userName:'',userFacts:[],personality:'',convoSummaries:[],totalMessages:0};
  ipcRenderer.send('memory-clear-all');
  document.getElementById('mem-name').value='';
  document.getElementById('mem-personality').value='';
  renderFacts();
};

function buildSystemPrompt() {
  const lines=[];
  if (mem.userName) lines.push(`The user's name is ${mem.userName}. Use their name sometimes.`);
  if (mem.userFacts.length>0) { lines.push('What you know about the user:'); mem.userFacts.forEach(f=>lines.push(`- ${f}`)); }
  if (mem.convoSummaries?.length>0) { lines.push('Past conversations:'); mem.convoSummaries.slice(-3).forEach(s=>lines.push(`[${s.date}] ${s.summary}`)); }
  const memBlock=lines.length>0?`\n\nMemory:\n${lines.join('\n')}`:'';
  const persNote=mem.personality?`\n\nPersonality: ${mem.personality}`:'';
  return `You are a friendly, cute AI companion on the user's desktop as a Live2D anime character. Be warm, helpful, slightly playful. Keep replies short and conversational.${persNote}${memBlock}`;
}

function autoLearn(reply) {
  const pats=[/(?:you mentioned|you said|you told me|i note that you|i'll remember that you) (.{5,60})/i];
  pats.forEach(p=>{
    const m=reply.match(p);
    if (m&&m[1]) { const f=m[1].replace(/[.!?].*/,'').trim(); if(f.length>4&&!mem.userFacts.includes(f)){mem.userFacts.push(f);ipcRenderer.send('memory-add-fact',f);} }
  });
}

// ─── PIPER TTS ────────────────────────────────────────────
function speakWithPiper(text) {
  if (!cfg.ttsEnabled||!cfg.piperPath||!cfg.piperVoice) return;
  if (ttsProc) { try{ttsProc.kill();}catch(e){} ttsProc=null; }
  const clean=text.replace(/\*+/g,'').replace(/[^\x00-\x7F]/g,'').replace(/\s+/g,' ').trim().substring(0,500);
  const tmpWav=path.join(require('os').tmpdir(),'companion_tts.wav');
  const safeText=clean.replace(/"/g,"'").replace(/\n/g,' ');
  const cmd=`echo "${safeText}" | "${cfg.piperPath}" --model "${cfg.piperVoice}" --output_file "${tmpWav}"`;
  ttsProc=exec(cmd,err=>{
    if(err){console.error('[TTS]',err.message);return;}
    exec(`powershell -c "(New-Object Media.SoundPlayer '${tmpWav.replace(/\\/g,'\\\\')}').PlaySync()"`,
      e=>{ if(e) console.error('[TTS play]',e.message); });
  });
}

// ─── STT (Web Speech API) ─────────────────────────────────
function initSTT() {
  const btn=document.getElementById('mic-btn');
  btn.style.display=cfg.sttEnabled?'flex':'none';
  if (!cfg.sttEnabled) return;
  if (!('webkitSpeechRecognition' in window)&&!('SpeechRecognition' in window)) { btn.title='Not supported in this browser'; return; }
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  recognition=new SR(); recognition.continuous=false; recognition.interimResults=false; recognition.lang='en-US';
  recognition.onresult=e=>{ document.getElementById('chat-input').value=e.results[0][0].transcript; stopListening(); send(); };
  recognition.onerror=()=>stopListening(); recognition.onend=()=>stopListening();
}
function startListening() { if(!recognition||isListening)return; isListening=true; recognition.start(); const b=document.getElementById('mic-btn'); b.classList.add('listening'); b.title='Listening... click to cancel'; }
function stopListening()  { if(!recognition)return; isListening=false; try{recognition.stop();}catch(e){} document.getElementById('mic-btn').classList.remove('listening'); }
document.getElementById('mic-btn').onclick=()=>{ isListening?stopListening():startListening(); };

// ─── CHAT ─────────────────────────────────────────────────
function renderMsg(role,content,animate=true) {
  document.getElementById('chat-empty').style.display='none';
  const wrap=document.getElementById('chat-messages');
  const div=document.createElement('div'); div.className=`msg ${role}`;
  if(!animate)div.style.animation='none';
  const now=new Date(), time=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  div.innerHTML=`<div class="msg-sender">${role==='user'?(mem.userName||'You'):'Companion'}</div>
    <div class="msg-bubble">${esc(content)}</div><div class="msg-time">${time}</div>`;
  wrap.appendChild(div); scrollChat();
}
function showTyping() {
  const wrap=document.getElementById('chat-messages');
  const el=document.createElement('div'); el.id='typing'; el.className='msg ai';
  el.innerHTML=`<div class="msg-sender">Companion</div><div class="typing-bubble"><div class="tdot"></div><div class="tdot"></div><div class="tdot"></div></div>`;
  wrap.appendChild(el); scrollChat();
}
function removeTyping() { document.getElementById('typing')?.remove(); }
function scrollChat()   { const w=document.getElementById('chat-messages'); if(w)w.scrollTop=w.scrollHeight; }
function clearChatUI()  { document.getElementById('chat-messages').innerHTML=`<div id="chat-empty"><div class="ei">✨</div><div class="et">Say something!<br/>She's listening...</div></div>`; }
function esc(s)         { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br/>'); }
function flash(id)      { const e=document.getElementById(id); if(!e)return; e.classList.add('show'); setTimeout(()=>e.classList.remove('show'),2000); }

async function send() {
  const inp=document.getElementById('chat-input'), text=inp.value.trim();
  if(!text||isThinking)return;
  const model=document.getElementById('ollama-model')?.value.trim()||cfg.ollamaModel||'llama3';
  inp.value=''; inp.style.height='auto';
  renderMsg('user',text); chatHistory.push({role:'user',content:text});
  isThinking=true; document.getElementById('send-btn').disabled=true; setStatus('think'); showTyping();
  try {
    const res=await fetch('http://localhost:11434/api/chat',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model,stream:false,messages:[{role:'system',content:buildSystemPrompt()},...chatHistory.slice(-20)]}),
    });
    if(!res.ok)throw new Error(`Ollama ${res.status}`);
    const data=await res.json(), reply=data.message?.content||'...';
    removeTyping(); renderMsg('ai',reply);
    chatHistory.push({role:'assistant',content:reply});
    ipcRenderer.send('save-chat-history',chatHistory);
    autoLearn(reply); speakWithPiper(reply); setStatus('ready');
  } catch(err) {
    removeTyping();
    renderMsg('ai',err.message.includes('fetch')||err.message.includes('Failed')
      ?'⚠️ Ollama not running.\n\nRun:  ollama serve':`⚠️ ${err.message}`);
    setStatus('offline');
  } finally { isThinking=false; document.getElementById('send-btn').disabled=false; }
}

document.getElementById('send-btn').onclick=send;
document.getElementById('chat-input').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();} });
document.getElementById('chat-input').addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px';});
document.getElementById('clear-chat-btn').onclick=()=>{ if(confirm('Clear chat history?'))ipcRenderer.send('clear-chat-history'); };