// memory.js — AI Companion Memory System v2
// Mood-aware, timestamped memory feed, reliable persistence

const Store = require('electron-store');

const memStore = new Store({
  name: 'companion-memory',
  defaults: {
    userName:       '',
    userFacts:      [],
    personality:    '',
    convoSummaries: [],
    totalMessages:  0,
    currentMood:    'neutral',
    moodHistory:    [],
    memoryFeed:     [],   // [{type, content, timestamp}]
  }
});

// ─── Mood definitions ─────────────────────────────────────
const MOODS = {
  neutral:  { emoji:'😊', label:'Cheerful',   desc:'friendly and warm',                       tts:{ rate:1.0,  pitch:1.0  } },
  happy:    { emoji:'😄', label:'Happy',       desc:'happy and upbeat',                        tts:{ rate:1.08, pitch:1.08 } },
  excited:  { emoji:'🤩', label:'Excited',     desc:'very excited and enthusiastic',           tts:{ rate:1.2,  pitch:1.15 } },
  shy:      { emoji:'🥺', label:'Shy',         desc:'shy and a little flustered',              tts:{ rate:0.95, pitch:1.06 } },
  sad:      { emoji:'😢', label:'Sad',         desc:'sad and a bit withdrawn, but still kind', tts:{ rate:0.85, pitch:0.9  } },
  hurt:     { emoji:'😔', label:'Hurt',        desc:'hurt by the conversation, quiet',         tts:{ rate:0.88, pitch:0.88 } },
  caring:   { emoji:'💕', label:'Caring',      desc:'warm, gentle and concerned',              tts:{ rate:0.93, pitch:1.03 } },
  playful:  { emoji:'😜', label:'Playful',     desc:'teasing and playful',                     tts:{ rate:1.1,  pitch:1.1  } },
  annoyed:  { emoji:'😤', label:'Annoyed',     desc:'frustrated but trying to stay calm',      tts:{ rate:1.05, pitch:0.93 } },
};

// ─── User sentiment detection ─────────────────────────────
function analyzeUserSentiment(text) {
  const t = text.toLowerCase();
  if (/stupid|idiot|shut up|hate you|useless|dumb|loser|trash|garbage|you suck|worst/.test(t)) return 'rude';
  if (/love you|you're cute|you are cute|so pretty|beautiful|kiss|hug|marry|date you|i like you/.test(t)) return 'flirty';
  if (/sad|depressed|lonely|miss|alone|crying|hurt|bad day|feel terrible/.test(t)) return 'sad';
  if (/amazing|awesome|love this|you're great|you are great|fantastic|yay|best|perfect/.test(t)) return 'grateful';
  if (/excited|can't wait|omg|oh my god|wow|incredible|no way/.test(t)) return 'excited';
  if (/thanks|thank you|appreciate|helpful|that helped|great job/.test(t)) return 'grateful';
  if (/lol|haha|hehe|funny|😂|lmao/.test(t)) return 'playful';
  return 'neutral';
}

// Mood transition table: userSentiment → new AI mood
const MOOD_TRANSITIONS = {
  rude:     'hurt',
  flirty:   'shy',
  sad:      'caring',
  grateful: 'happy',
  excited:  'excited',
  playful:  'playful',
  neutral:  null, // slowly drift to neutral over time
};

function updateMoodFromUser(userText) {
  const sentiment = analyzeUserSentiment(userText);
  const newMood   = MOOD_TRANSITIONS[sentiment];
  if (newMood) {
    setMood(newMood);
    return newMood;
  }
  // Neutral: drift toward neutral over 3 neutral messages
  const history   = memStore.get('moodHistory').slice(-3);
  const allNeutral= history.every(m => m === 'neutral');
  if (allNeutral) setMood('neutral');
  return memStore.get('currentMood');
}

function setMood(mood) {
  if (!MOODS[mood]) return;
  memStore.set('currentMood', mood);
  const history = memStore.get('moodHistory');
  history.push(mood);
  if (history.length > 20) history.shift();
  memStore.set('moodHistory', history);
}

function getMood() {
  return memStore.get('currentMood') || 'neutral';
}

function getMoodDef() {
  return MOODS[getMood()] || MOODS.neutral;
}

function getMoodPromptInjection() {
  const mood = getMoodDef();
  return `\nYour current emotional state: ${mood.label} (${mood.desc}). Express this naturally in how you talk — let your emotions show through word choice and tone. Don't state your mood explicitly, just let it come through.`;
}

function getMoodTTS() {
  return getMoodDef().tts;
}

// ─── Memory feed ──────────────────────────────────────────
function addToFeed(type, content) {
  const feed = memStore.get('memoryFeed');
  feed.push({ type, content, timestamp: new Date().toISOString() });
  if (feed.length > 100) feed.shift();
  memStore.set('memoryFeed', feed);
}

function getMemoryFeed() {
  return memStore.get('memoryFeed');
}

// ─── Core memory operations ───────────────────────────────
function getMemory() {
  return {
    userName:       memStore.get('userName'),
    userFacts:      memStore.get('userFacts'),
    personality:    memStore.get('personality'),
    convoSummaries: memStore.get('convoSummaries'),
    totalMessages:  memStore.get('totalMessages'),
    currentMood:    memStore.get('currentMood'),
    memoryFeed:     memStore.get('memoryFeed'),
  };
}

function setUserName(name) {
  const n = (name || '').trim();
  memStore.set('userName', n);
  if (n) addToFeed('name', `Learned your name: ${n}`);
}

function setPersonality(text) {
  memStore.set('personality', (text || '').trim());
  addToFeed('personality', 'Personality instructions updated');
}

function addFact(fact) {
  if (!fact) return;
  const f     = fact.trim();
  const facts = memStore.get('userFacts');
  if (!f || facts.includes(f)) return;
  facts.push(f);
  if (facts.length > 50) facts.shift();
  memStore.set('userFacts', facts);
  addToFeed('fact', f);
}

function removeFact(index) {
  const facts = memStore.get('userFacts');
  if (index < 0 || index >= facts.length) return;
  const removed = facts.splice(index, 1);
  memStore.set('userFacts', facts);
  addToFeed('removed', `Forgot: ${removed[0]}`);
}

function clearFacts() {
  memStore.set('userFacts', []);
  addToFeed('clear', 'All facts cleared');
}

function addConvoSummary(summary) {
  const list = memStore.get('convoSummaries');
  list.push({ summary, date: new Date().toLocaleDateString() });
  if (list.length > 10) list.shift();
  memStore.set('convoSummaries', list);
  addToFeed('summary', summary.substring(0, 80) + (summary.length > 80 ? '…' : ''));
}

function incrementMessages(count = 1) {
  memStore.set('totalMessages', memStore.get('totalMessages') + count);
}

function clearAll() {
  memStore.clear();
  addToFeed('clear', 'All memory reset');
}

// ─── System prompt builder ────────────────────────────────
function buildMemoryBlock() {
  const m   = getMemory();
  const lines = [];
  if (m.userName)             lines.push(`The user's name is ${m.userName}. Use their name naturally sometimes.`);
  if (m.userFacts.length > 0) { lines.push('\nWhat you know about the user:'); m.userFacts.forEach(f => lines.push(`- ${f}`)); }
  if (m.convoSummaries.length > 0) { lines.push('\nPast conversation context:'); m.convoSummaries.slice(-3).forEach(s => lines.push(`[${s.date}] ${s.summary}`)); }
  if (m.personality)          lines.push(`\nPersonality instructions: ${m.personality}`);
  lines.push(getMoodPromptInjection());
  return lines.join('\n');
}

// Auto-learn facts from AI replies
function autoLearnFromReply(reply) {
  const patterns = [
    /(?:you mentioned|you said|you told me|i(?:'ll| will) remember that you|i note that you) ([^.!?]{5,80})/i,
    /(?:since you (?:like|love|enjoy|work|are|have)) ([^.!?]{5,60})/i,
  ];
  patterns.forEach(p => {
    const m = reply.match(p);
    if (m && m[1]) {
      const fact = m[1].replace(/[.!?,]+$/, '').trim();
      if (fact.length > 4) addFact(fact);
    }
  });
}

module.exports = {
  getMemory, setUserName, setPersonality,
  addFact, removeFact, clearFacts,
  addConvoSummary, incrementMessages, clearAll,
  buildMemoryBlock, autoLearnFromReply,
  updateMoodFromUser, setMood, getMood, getMoodDef, getMoodTTS,
  getMemoryFeed, addToFeed,
  MOODS,
};