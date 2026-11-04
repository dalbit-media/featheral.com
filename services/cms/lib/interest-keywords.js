const { decodeEntities } = require('./text');
const catalogue = require('./interest-keywords.json');

const MIN_INTEREST_POSTS = 3;
const normalize = text => decodeEntities(String(text || '')).normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const aliases = new Map();
for (const [name, variants] of Object.entries(catalogue)) {
  for (const variant of [name, ...variants]) {
    const key = normalize(variant);
    if (aliases.has(key) && aliases.get(key) !== name) throw new Error(`Conflicting reviewed keyword: ${variant}`);
    aliases.set(key, name);
  }
}
const canonicalInterestName = name => aliases.get(normalize(name));
const patterns = [...aliases].map(([alias, name]) => ({ name,
  pattern: new RegExp(`(?:^|[^\\p{L}\\p{N}])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[\\p{Zs}\\p{Pd}\\t_:]+')}(?=$|[^\\p{L}\\p{N}])`, 'u'),
}));

function interestKeywords(text) {
  const clean = decodeEntities(String(text || '')).normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/['’]/g, '').toLowerCase();
  const names = new Set();
  for (const { name, pattern } of patterns) {
    if (!pattern.test(clean)) continue;
    if (name === 'One Piece' && !/\b(?:cosplay|anime|manga|nami|robin|luffy|pirate|boa hancock)\b/.test(clean)) continue;
    names.add(name);
  }
  return [...names];
}

function buildInterestTags(posts, cleanBody, minPosts = MIN_INTEREST_POSTS) {
  const matches = new Map(), counts = new Map();
  for (const post of posts) {
    const names = new Set([...interestKeywords(post.title), ...interestKeywords(cleanBody(post.excerpt || '')),
      ...interestKeywords(cleanBody(post.content || ''))]);
    matches.set(post.id, [...names]);
    for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return new Map([...matches].map(([id, names]) => [id, names.filter(name => counts.get(name) >= minPosts)])
    .filter(([, names]) => names.length));
}

module.exports = { MIN_INTEREST_POSTS, canonicalInterestName, interestKeywords, buildInterestTags };
