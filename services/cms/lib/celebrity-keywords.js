const names = require('./celebrity-names.json');
const { decodeEntities } = require('./text');

const CELEBRITY_MARK = 'auto-celebrity';
// These stage names are also ordinary words or ambiguous short names.
const CONTEXTUAL = new Set(['pink', 'rose', 'nana', 'mina', 'minnie', 'julie', 'cl', 'bona', 'irene', 'nancy', 'lisa', 'sohee', 'hanni', 'hani', 'yuna',
  'momo', 'sakura', 'kazuha', 'nina', 'magenta', 'tsuki', 'bae']);

function normalizeName(text) {
  return decodeEntities(String(text || '')).normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/['’]s\b/g, '').replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const aliases = new Map();
for (const [name, variants] of Object.entries(names)) {
  for (const variant of [name, ...variants]) {
    const alias = normalizeName(variant);
    if (aliases.has(alias) && aliases.get(alias) !== name) throw new Error(`Conflicting celebrity alias: ${variant}`);
    aliases.set(alias, name);
  }
}
const pattern = new RegExp(`(?<!\\S)(?:${[...aliases.keys()].sort((a, b) => b.length - a.length)
  .map(alias => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?!\\S)`, 'g');

function celebrityKeywords(text, inCelebrityCategory = false) {
  const normalized = normalizeName(text);
  const found = new Set();
  for (const match of normalized.matchAll(pattern)) {
    if (CONTEXTUAL.has(match[0]) && !inCelebrityCategory) continue;
    if (match[0] === 'pink' && normalized !== 'pink') continue;
    if (match[0] === 'rose' && !/(?<!\p{L})(?:Rose|ROSE|Rosé|ROSÉ)(?!\p{L})/u.test(String(text))) continue;
    found.add(aliases.get(match[0]));
  }
  return [...found];
}

const contextualCelebrityName = name => CONTEXTUAL.has(normalizeName(name));

module.exports = { CELEBRITY_MARK, celebrityKeywords, contextualCelebrityName };
