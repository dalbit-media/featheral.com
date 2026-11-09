import { hash } from './engine.ts';
import type { Terrain } from './engine.ts';
import type { Environment, Season } from './environment.ts';
import type { WaterFacility } from './water-facilities.ts';

export const tileWidth = 78, tileHeight = 40;
export const project = (x: number, y: number): { x: number; y: number } => ({ x: (x - y) * tileWidth / 2, y: (x + y) * tileHeight / 2 });
export const unproject = (x: number, y: number): { x: number; y: number } => ({ x: x / tileWidth + y / tileHeight, y: y / tileHeight - x / tileWidth });
export function explorationFringe(known: ReadonlySet<string>): Map<string, number> {
  const fringe = new Map<string, number>();
  for (const key of known) {
    const [x, y] = key.split(',').map(Number);
    if ([`${x - 1},${y}`, `${x + 1},${y}`, `${x},${y - 1}`, `${x},${y + 1}`].every(cell => known.has(cell))) continue;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const distance = Math.hypot(dx, dy), cell = `${x + dx},${y + dy}`;
      if (distance >= 4 || known.has(cell)) continue;
      const t = distance / 4, clarity = .7 * (1 - t * t * (3 - 2 * t));
      fringe.set(cell, Math.max(fringe.get(cell) ?? 0, clarity));
    }
  }
  return fringe;
}
export const terrainColors: Record<Terrain, string[]> = {
  forest: ['#466d4a', '#507951', '#3e6747'], meadow: ['#7f9560', '#8c9f69', '#738d58'],
  water: ['#355f65', '#3b686d', '#406e72'], mountain: ['#7b8276', '#858c7e', '#717a6b'],
  oil: ['#626f54', '#56654a', '#6e7958'], lithium: ['#77918a', '#81988d', '#6e887e'],
  rainforest: ['#295d45', '#326f4e', '#3c7955'], pineforest: ['#345953', '#426b61', '#50786b'],
  mangrove: ['#436f67', '#547e70', '#627f65'], grassland: ['#9ca965', '#adb873', '#8e9e58'],
  savanna: ['#b2a25f', '#c4ae6a', '#a39351'], desert: ['#bd885b', '#d2a170', '#c49363'],
  dunes: ['#d3b27a', '#e3c18c', '#c5a06a'], wetland: ['#567f70', '#648e7b', '#487565'],
  river: ['#427e91', '#4b8c9c', '#3b7186'], coast: ['#559c9d', '#6eacaa', '#468e95'],
  hills: ['#94916a', '#a39e74', '#85855c'], canyon: ['#ad654c', '#c37b55', '#985740'],
  volcano: ['#4c4547', '#605052', '#3c393e'], tundra: ['#9aada9', '#adbbb5', '#899e9a'],
  glacier: ['#a7d4dc', '#c4e6e9', '#8fbeca'],
};
const seasonalColors: Record<Season, Partial<Record<Terrain, string[]>>> = {
  Spring: { meadow: ['#91a66c', '#9bad78', '#829d63'] }, Summer: {},
  Autumn: { meadow: ['#a49460', '#b09e6a', '#978858'], forest: ['#726c43', '#83784b', '#66653f'] },
  Winter: { meadow: ['#b2bfb5', '#c4cec4', '#a6b6ad'], forest: ['#7e978c', '#91a59a', '#728d82'],
    water: ['#65858e', '#76969e', '#60828b'], mountain: ['#b6c1bc', '#c9d1c9', '#a6b5b0'] },
};
export function tileColor(terrain: Terrain, variant: number, season: Season): string {
  return (seasonalColors[season][terrain] ?? terrainColors[terrain])[variant];
}
export function drawDiamond(c: CanvasRenderingContext2D, x: number, y: number, fill: string): void {
  c.beginPath(); c.moveTo(x, y - tileHeight / 2); c.lineTo(x + tileWidth / 2, y); c.lineTo(x, y + tileHeight / 2); c.lineTo(x - tileWidth / 2, y); c.closePath();
  c.fillStyle = fill; c.fill();
  c.strokeStyle = '#172d2020'; c.lineWidth = .65; c.stroke();
}
export function drawTree(c: CanvasRenderingContext2D, x: number, y: number, h: number, variant: number, season: Season): void {
  c.fillStyle = '#152c2845'; c.beginPath(); c.ellipse(x + 6, y + 3, h * .42, 5, -.2, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#7b7050'; c.fillRect(x - 1.5, y - 12, 3, 14);
  const shades = season === 'Autumn' ? ['#725b35', '#93753d', '#b39350']
    : season === 'Winter' ? ['#486556', '#74907b', '#b5c8b7']
    : variant > .45 ? ['#31583d', '#456e49', '#5b8052'] : ['#2b5141', '#3b6550', '#50795a'];
  for (let i = 0; i < 3; i++) {
    const top = y - h + i * h * .19, w = h * (.25 + i * .055);
    c.fillStyle = shades[i];
    c.beginPath(); c.moveTo(x, top); c.lineTo(x + w, top + h * .55); c.quadraticCurveTo(x, top + h * .68, x - w, top + h * .55); c.closePath(); c.fill();
    c.fillStyle = '#b7c88b18'; c.beginPath(); c.moveTo(x, top); c.lineTo(x - w, top + h * .55); c.lineTo(x - 2, top + h * .45); c.fill();
  }
}
export interface HouseAppearance { kind: 'home' | 'centre' | 'workshop' | 'supplies' | 'bank' | 'townhall'; urban: boolean; night: boolean }
export function drawHouse(c: CanvasRenderingContext2D, x: number, y: number, size = 1, appearance?: HouseAppearance): void {
  c.save(); c.translate(x, y); c.scale(size, size);
  if (appearance) {
    c.fillStyle = '#142e2840'; c.beginPath(); c.ellipse(2, 13, 26, 10, 0, 0, Math.PI * 2); c.fill();
  }
  const lift = appearance?.urban ? 16 : 0;
  c.fillStyle = '#c1ad79'; c.beginPath(); c.moveTo(-14, -5 - lift); c.lineTo(0, 3 - lift); c.lineTo(0, 20); c.lineTo(-14, 12); c.fill();
  c.fillStyle = '#e0cf97'; c.beginPath(); c.moveTo(0, 3 - lift); c.lineTo(19, -7 - lift); c.lineTo(19, 10); c.lineTo(0, 20); c.fill();
  c.save(); c.translate(0, -lift);
  c.fillStyle = appearance?.kind === 'centre' ? '#9e6648' : appearance?.kind === 'bank' ? '#526c75' : '#655747';
  c.beginPath(); c.moveTo(-18, -6); c.lineTo(-1, -24); c.lineTo(23, -10); c.lineTo(0, 5); c.fill();
  c.fillStyle = appearance?.kind === 'centre' ? '#bb895b' : '#87765a'; c.beginPath(); c.moveTo(-1, -24); c.lineTo(23, -10); c.lineTo(7, -27); c.fill();
  c.strokeStyle = '#eed1a344'; c.lineWidth = .8;
  c.beginPath();
  for (const offset of [0, 5, 10]) { c.moveTo(-14 + offset, -8 - offset); c.lineTo(3 + offset, 2 - offset); }
  c.stroke();
  if (appearance?.night) {
    const glow = c.createRadialGradient(10, 4, 0, 10, 4, 17);
    glow.addColorStop(0, '#f3cf7a70'); glow.addColorStop(1, '#f3cf7a00');
    c.fillStyle = glow; c.fillRect(-7, -13, 34, 34);
  }
  c.fillStyle = !appearance || appearance.night ? '#f2cf7d' : '#789b9a'; c.fillRect(8, 1, 5, 6);
  c.strokeStyle = '#f2d9ab'; c.lineWidth = .7; c.strokeRect(8, 1, 5, 6);
  c.beginPath(); c.moveTo(10.5, 1); c.lineTo(10.5, 7); c.stroke();
  if (appearance?.kind === 'workshop') { c.fillStyle = '#8a8067'; c.fillRect(-9, -35, 5, 17); c.fillStyle = '#b4ad91'; c.fillRect(-10, -36, 7, 3); }
  if (appearance?.kind === 'centre' || appearance?.kind === 'townhall') {
    c.strokeStyle = '#d9cfa4'; c.lineWidth = 1.3; c.beginPath(); c.moveTo(0, -24); c.lineTo(0, -46); c.stroke();
    c.fillStyle = '#c6e8a4'; c.beginPath(); c.moveTo(1, -46); c.lineTo(17, -40); c.lineTo(1, -35); c.fill();
  }
  c.restore();
  c.fillStyle = '#5c5845'; c.beginPath(); c.moveTo(-10, 4); c.lineTo(-5, 7); c.lineTo(-5, 16); c.lineTo(-10, 13); c.fill();
  c.fillStyle = '#ad9674'; c.beginPath(); c.moveTo(-12, 13); c.lineTo(-5, 17); c.lineTo(-8, 19); c.lineTo(-15, 15); c.closePath(); c.fill();
  c.strokeStyle = '#897d60'; c.lineWidth = .7; c.beginPath(); c.moveTo(-14, 0); c.lineTo(0, 8); c.moveTo(0, 13); c.lineTo(19, 3); c.stroke();
  if (appearance?.urban) { c.fillStyle = appearance.night ? '#f2cf7d' : '#789b9a'; c.fillRect(8, 4, 5, 6); }
  if (appearance?.kind === 'bank') { c.fillStyle = '#d5b869'; c.beginPath(); c.arc(9, -2 - lift, 4, 0, Math.PI * 2); c.fill(); }
  if (appearance?.kind === 'supplies') {
    c.fillStyle = '#ab865b'; c.fillRect(17, 7, 11, 12); c.strokeStyle = '#e0c58d'; c.lineWidth = 1; c.strokeRect(17, 7, 11, 12); c.beginPath(); c.moveTo(17, 7); c.lineTo(28, 19); c.stroke();
  }
  c.restore();
}
export function drawWaterFacility(c: CanvasRenderingContext2D, x: number, y: number, kind: WaterFacility, night: boolean): void {
  if (kind === 'pumpingStation') drawHouse(c, x - 10, y - 8, 1.1, { kind: 'workshop', urban: false, night });
  c.save(); c.translate(x, y); c.scale(1.35, 1.35);
  c.fillStyle = '#142e2840'; c.beginPath(); c.ellipse(2, 12, 25, 9, 0, 0, Math.PI * 2); c.fill();
  if (kind === 'well') {
    c.fillStyle = '#9b9f8b'; c.fillRect(-14, -3, 28, 16);
    c.beginPath(); c.ellipse(0, 13, 14, 6, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#d0ccad'; c.beginPath(); c.ellipse(0, -3, 14, 6, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#4b8c9c'; c.beginPath(); c.ellipse(0, -3, 10, 4, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#826549'; c.lineWidth = 3; c.beginPath(); c.moveTo(-12, 1); c.lineTo(-12, -24); c.lineTo(12, -24); c.lineTo(12, 1); c.stroke();
    c.strokeStyle = '#d1b877'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(0, -24); c.lineTo(0, -3); c.stroke();
    c.fillStyle = '#79634c'; c.beginPath(); c.moveTo(-18, -23); c.lineTo(0, -34); c.lineTo(18, -23); c.closePath(); c.fill();
  } else {
    const offset = kind === 'pumpingStation' ? 16 : 0;
    c.translate(offset, 0);
    c.fillStyle = '#527d82'; c.fillRect(-12, -20, 24, 30);
    c.beginPath(); c.ellipse(0, 10, 12, 6, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#8bc5c8'; c.beginPath(); c.ellipse(0, -20, 12, 6, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#b7c8ad'; c.lineWidth = 2; c.beginPath(); c.ellipse(0, -10, 12, 6, 0, 0, Math.PI); c.stroke();
    if (kind === 'rainCollector') {
      c.fillStyle = '#91b5a4'; c.beginPath(); c.moveTo(-22, -35); c.lineTo(22, -35); c.lineTo(6, -23); c.lineTo(-6, -23); c.closePath(); c.fill();
      c.strokeStyle = '#648e85'; c.lineWidth = 2; c.beginPath(); c.moveTo(0, -32); c.lineTo(0, -20); c.stroke();
    } else {
      c.strokeStyle = '#b1b5a2'; c.lineWidth = 4; c.beginPath(); c.moveTo(-12, -5); c.lineTo(-23, -5); c.lineTo(-23, 8); c.stroke();
      c.strokeStyle = '#d5b869'; c.lineWidth = 2; c.beginPath(); c.arc(-23, -5, 5, 0, Math.PI * 2); c.stroke();
    }
  }
  c.restore();
}
export function drawEnvironment(c: CanvasRenderingContext2D, environment: Environment, width: number, height: number, time: number, reducedMotion: boolean): void {
  c.fillStyle = `rgba(9,17,43,${(1 - environment.daylight) * .42})`; c.fillRect(0, 0, width, height);
  if (environment.phase === 'Dawn' || environment.phase === 'Dusk') { c.fillStyle = 'rgba(207,133,67,0.08)'; c.fillRect(0, 0, width, height); }
  if (environment.weather === 'Clear skies') return;
  c.fillStyle = environment.weather === 'Storm' ? '#263c4b26' : '#82949812'; c.fillRect(0, 0, width, height);
  if (environment.weather === 'Overcast') return;
  const snow = environment.weather === 'Snow', motion = reducedMotion ? 0 : time, count = environment.weather === 'Storm' ? 85 : 45;
  c.strokeStyle = '#b6d2e366'; c.fillStyle = '#e6f0df99'; c.lineWidth = 1;
  for (let i = 0; i < count; i++) {
    const x = (hash(i, 3, 812) * width + motion * (snow ? .008 : .025)) % Math.max(1, width);
    const y = (hash(i, 7, 812) * height + motion * (snow ? .018 : .24)) % Math.max(1, height);
    c.beginPath();
    if (snow) { c.arc(x, y, 1.5, 0, Math.PI * 2); c.fill(); }
    else { c.moveTo(x, y); c.lineTo(x - 3, y + 10); c.stroke(); }
  }
}
