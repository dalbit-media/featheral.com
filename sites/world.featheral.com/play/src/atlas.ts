export interface Location { x: number; y: number }
export interface FederationIdentity {
  name: string; motto: string; color: string; accent: string; symbol: number;
}
export const startingFederations: readonly FederationIdentity[] = [
  { name: 'Evergreen Union', motto: 'Rooted together, rising forever', color: '#24634b', accent: '#efd48a', symbol: 0 },
  { name: 'Aurora Concord', motto: 'Light beyond the horizon', color: '#643c85', accent: '#f4cbea', symbol: 1 },
  { name: 'Azure Maritime League', motto: 'Many shores, one tide', color: '#235b91', accent: '#bdebea', symbol: 2 },
  { name: 'Solaris Commonwealth', motto: 'By courage, a brighter dawn', color: '#9a422a', accent: '#ffdd7b', symbol: 3 },
  { name: 'Silverpeak Assembly', motto: 'Steadfast above the clouds', color: '#465473', accent: '#dde5f3', symbol: 4 },
];
export const federationStories: Readonly<Record<string, string>> = {
  'Evergreen Union': 'When the Long Frost silenced the forest roads, five villages kept a single greenhouse alive by sharing their last firewood. Its first spring sapling became the Union’s emblem. Their oldest promise is simple: no settlement faces winter alone.',
  'Aurora Concord': 'A storm scattered the northern observatories until a young keeper answered a distant light with a polished mirror. That chain of signals reunited the valleys. The Concord still keeps a lantern burning for discoveries that have not yet found their way home.',
  'Azure Maritime League': 'Three rival harbors once argued over a vanished lighthouse. When their ships returned together through the same fog, the captains built a new beacon on neutral ground. The League was born around its flame: many shores, but safe passage for all.',
  'Solaris Commonwealth': 'The first solar tower rose from a broken quarry, assembled by workers who were told the basin could never support a town. At dawn its mirrors lit every unfinished roof. The Commonwealth remembers that morning whenever a new settlement raises its first home.',
  'Silverpeak Assembly': 'After an avalanche buried the mountain pass, miners, shepherds and mapmakers cut a new route from opposite sides. They met beneath the summit and carved their agreement into the stone. The Assembly’s shield honors the road no single village could have built.',
};
export function identityHash(seed: string): number {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}
export function generatedFederation(seed: string): FederationIdentity {
  const existing = startingFederations.find(federation => federation.name === seed);
  if (existing) return existing;
  const hash = identityHash(seed);
  return { name: seed, motto: 'Many settlements, a shared future',
    color: `hsl(${hash % 360} 45% 32%)`, accent: `hsl(${(hash + 45) % 360} 75% 80%)`, symbol: hash % 5 };
}
export function foundedFederationName(seed: number): string {
  const hash = identityHash(String(seed));
  return `${['Verdant', 'Celestial', 'Amber', 'Moonstone', 'Sapphire'][hash % 5]} ${['Concord', 'Alliance', 'Federation', 'Assembly'][Math.floor(hash / 5) % 4]} ${seed.toString(36).toUpperCase()}`;
}
export const atlasSize = 1000;
export const nearbyDistance = 100;
export function settlementDistance(a: Location, b: Location): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
export interface AtlasEntry {
  id: string; player: string; settlement: string | null; yours: boolean;
  location: Location | null; distance: number | null; federation: string | null;
  population: number; netWorth: number; dollars: number; stage: number; explored: number; contribution: number;
}
export interface AtlasFederation extends FederationIdentity { members: number; population: number }
export interface AtlasSnapshot { entries: AtlasEntry[]; federations: AtlasFederation[]; updatedAt: number }
export const rankingMetrics = ['population', 'netWorth', 'dollars', 'stage', 'explored', 'contribution'] as const;
export type RankingMetric = typeof rankingMetrics[number];
export function isRankingMetric(value: string): value is RankingMetric {
  return rankingMetrics.some(metric => metric === value);
}
export function rankEntries(entries: readonly AtlasEntry[], metric: RankingMetric): AtlasEntry[] {
  return [...entries].sort((a, b) => b[metric] - a[metric] || a.id.localeCompare(b.id));
}
export function escapeAtlas(text: string): string {
  return text.replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
const symbols = [
  '<path d="m50 20-18 27h10L27 65h18v16h10V65h18L58 47h10Z"/>',
  '<path d="m50 18 8 22 24 2-19 15 6 24-19-14-19 14 6-24-19-15 24-2Z"/>',
  '<path d="M25 55q12-18 25 0t25 0v12q-12 18-25 0t-25 0ZM45 20h10v30H45Z"/>',
  '<circle cx="50" cy="50" r="17"/><path d="M46 14h8v12h-8ZM46 74h8v12h-8ZM14 46h12v8H14ZM74 46h12v8H74Z"/>',
  '<path d="m17 72 25-45 12 21 9-15 21 39Zm25-31-9 16h18Z"/>',
];
export function federationArt(name: string, kind: 'flag' | 'shield'): string {
  const identity = generatedFederation(name), shield = kind === 'shield';
  return `<svg class="heraldry ${kind}" viewBox="0 0 100 100" role="img" aria-label="${escapeAtlas(name)} ${kind}">
    <path fill="${identity.color}" stroke="${identity.accent}" stroke-width="3" d="${shield ? 'M12 9h76v43c0 25-38 42-38 42S12 77 12 52Z' : 'M4 18h92v64H4Z'}"/>
    <path fill="${identity.accent}" opacity=".2" d="M14 20h22v60H14ZM64 20h22v60H64Z"/>
    <g fill="${identity.accent}">${symbols[identity.symbol]}</g>
    <path fill="none" stroke="${identity.accent}" stroke-width="1" d="${shield ? 'M20 17h60v35c0 20-30 33-30 33S20 72 20 52Z' : 'M9 23h82v54H9Z'}"/>
  </svg>`;
}
export function generatedAvatar(seed: string): string {
  const hash = identityHash(seed), color = `hsl(${hash % 360} 55% 65%)`;
  const cells = Array.from({ length: 15 }, (_, index) => {
    if (!(hash & (1 << index))) return '';
    const x = index % 3, y = Math.floor(index / 3);
    return `<rect x="${6 + x * 8}" y="${6 + y * 8}" width="8" height="8"/>${x < 2 ? `<rect x="${6 + (4 - x) * 8}" y="${6 + y * 8}" width="8" height="8"/>` : ''}`;
  }).join('');
  return `<svg class="generated-avatar" viewBox="0 0 52 52" role="img" aria-label="Generated player avatar"><rect width="52" height="52" rx="12" fill="#17251f"/><g fill="${color}">${cells}</g></svg>`;
}
export function territoryAt(point: Location, settlements: readonly AtlasEntry[]): string | null {
  let nearest: AtlasEntry | undefined, distance = Infinity;
  for (const settlement of settlements) {
    if (!settlement.location) continue;
    const next = settlementDistance(point, settlement.location);
    if (next < distance || next === distance && settlement.id < (nearest?.id ?? '')) {
      nearest = settlement; distance = next;
    }
  }
  return nearest?.federation ?? null;
}
