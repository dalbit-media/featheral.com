const { decodeEntities } = require('./text');
const { canonicalInterestName } = require('./interest-keywords');

const AMBIGUOUS = new Set(`
lee kim emma anna mia emily kelly eva lily julia sarah jessica rachel han hye
charlotte scarlett lilly mary luna lola amanda bella jin maria alice eve amber
wendy joo lim armas bin cho kana katie lana melissa sophia taylor alex grace ivy
rae smith diana holly uehara shinoda liz lulu woo yuki anya gyu hana kanna lea
veronica williams aika
`.trim().split(/\s+/));
const NOISE = new Set(['haul transparent', 'tutorial brazilian', 'korean thai', 'transparent sheer', 'perky korean']);
const ALIASES = new Map([
  ['nagi hikaru', 'Hikaru Nagi'], ['star war', 'Star Wars'],
  ['outdoor', 'outdoors'], ['neighbour', 'neighbor'],
]);

function keywordKey(name) {
  return decodeEntities(String(name || '')).normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function meaningfulKeyword(name) {
  const key = keywordKey(name);
  return !!key && !AMBIGUOUS.has(key) && !NOISE.has(key) && !/^r\//i.test(String(name))
    && !/^(?:part|episode|season|final part|upscaled|enhanced|denoised|hd|oc|nsfw|sfw)(?: \d+)?$/.test(key);
}

function canonicalKeyword(name) {
  return ALIASES.get(keywordKey(name)) || canonicalInterestName(name) || name;
}

module.exports = { keywordKey, meaningfulKeyword, canonicalKeyword };
