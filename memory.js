// memory.js — AI Companion Memory System
// Stores user profile, learned facts, and conversation summaries
// Loaded by main.js, read by control.js via IPC

const Store = require('electron-store');

const memStore = new Store({
  name: 'companion-memory',
  defaults: {
    userName:     '',
    userFacts:    [],        // ["User likes anime", "User is a developer", ...]
    personality:  '',        // custom AI personality note
    convoSummaries: [],      // last N conversation summaries
    totalMessages:  0,
  }
});

// ─── Read ─────────────────────────────────────────────────
function getMemory() {
  return {
    userName:       memStore.get('userName'),
    userFacts:      memStore.get('userFacts'),
    personality:    memStore.get('personality'),
    convoSummaries: memStore.get('convoSummaries'),
    totalMessages:  memStore.get('totalMessages'),
  };
}

// ─── Write ────────────────────────────────────────────────
function setUserName(name) {
  memStore.set('userName', name.trim());
}

function setPersonality(text) {
  memStore.set('personality', text.trim());
}

function addFact(fact) {
  const facts = memStore.get('userFacts');
  if (!fact || facts.includes(fact)) return;
  facts.push(fact.trim());
  if (facts.length > 30) facts.shift(); // cap at 30 facts
  memStore.set('userFacts', facts);
}

function removeFact(index) {
  const facts = memStore.get('userFacts');
  facts.splice(index, 1);
  memStore.set('userFacts', facts);
}

function clearFacts() {
  memStore.set('userFacts', []);
}

function addConvoSummary(summary) {
  const list = memStore.get('convoSummaries');
  list.push({ summary, date: new Date().toLocaleDateString() });
  if (list.length > 10) list.shift(); // keep last 10 summaries
  memStore.set('convoSummaries', list);
}

function incrementMessages(count) {
  const cur = memStore.get('totalMessages');
  memStore.set('totalMessages', cur + count);
}

function clearAll() {
  memStore.clear();
}

// ─── Build system prompt injection ────────────────────────
function buildMemoryBlock() {
  const m = getMemory();
  const lines = [];

  if (m.userName) {
    lines.push(`The user's name is ${m.userName}. Address them by name occasionally.`);
  }

  if (m.userFacts.length > 0) {
    lines.push(`\nThings you know about the user:`);
    m.userFacts.forEach(f => lines.push(`- ${f}`));
  }

  if (m.convoSummaries.length > 0) {
    lines.push(`\nPast conversation summaries:`);
    m.convoSummaries.slice(-3).forEach(s => lines.push(`[${s.date}] ${s.summary}`));
  }

  if (m.personality) {
    lines.push(`\nPersonality note: ${m.personality}`);
  }

  return lines.length > 0 ? lines.join('\n') : '';
}

module.exports = {
  getMemory,
  setUserName,
  setPersonality,
  addFact,
  removeFact,
  clearFacts,
  addConvoSummary,
  incrementMessages,
  buildMemoryBlock,
  clearAll,
};