function sanitizeMessageContent(content) {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }

  return '';
}

function sanitizeChatHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .map(entry => {
      const role = entry?.role === 'assistant' ? 'assistant' : 'user';
      const content = sanitizeMessageContent(entry?.content);
      if (!content) return null;
      return { role, content };
    })
    .filter(Boolean)
    .slice(-100);
}

module.exports = {
  sanitizeMessageContent,
  sanitizeChatHistory,
};
