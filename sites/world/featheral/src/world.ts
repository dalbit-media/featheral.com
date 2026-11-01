import { hash, radius, terrainAt } from './engine.ts';
import type { Game, Terrain } from './engine.ts';
import type { Environment } from './environment.ts';
import { drawDiamond, drawEnvironment, drawHouse, drawTree, explorationFringe, project, terrainColors as colors, tileColor, tileHeight, tileWidth, unproject } from './map-art.ts';

interface WorldTile { sx: number; sy: number; visible: boolean; clarity: number }

export class World {
  private ctx: CanvasRenderingContext2D;
  private mini: CanvasRenderingContext2D;
  private fogCanvas = document.createElement('canvas');
  private fog: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private camera = { x: 0, y: 0 };
  private zoom = 1.15;
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private known = new Set<string>();
  private fringe = new Map<string, number>();
  private exploredRef: string[] | null = null;
  private lastFrame = 0;
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private canvas: HTMLCanvasElement;
  private minimap: HTMLCanvasElement;
  private game: () => Game;
  private select: (x: number, y: number) => void;
  private environment: () => Environment;
  constructor(
    canvas: HTMLCanvasElement,
    minimap: HTMLCanvasElement,
    game: () => Game,
    select: (x: number, y: number) => void,
    environment: () => Environment,
  ) {
    this.canvas = canvas; this.minimap = minimap; this.game = game; this.select = select;
    this.environment = environment;
    const ctx = canvas.getContext('2d'), mini = minimap.getContext('2d'), fog = this.fogCanvas.getContext('2d');
    if (!ctx || !mini || !fog) throw new Error('Your browser does not support the canvas renderer.');
    this.ctx = ctx; this.mini = mini; this.fog = fog;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.center();
    canvas.addEventListener('pointerdown', e => {
      this.drag = { x: e.clientX, y: e.clientY, cx: this.camera.x, cy: this.camera.y, moved: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      if (!this.drag) return;
      const dx = (e.clientX - this.drag.x) / this.zoom, dy = (e.clientY - this.drag.y) / this.zoom;
      if (Math.hypot(dx, dy) > 5) this.drag.moved = true;
      const delta = unproject(dx, dy);
      this.camera.x = this.drag.cx - delta.x;
      this.camera.y = this.drag.cy - delta.y;
    });
    canvas.addEventListener('pointerup', e => {
      if (!this.drag) return;
      if (!this.drag.moved) {
        const bounds = canvas.getBoundingClientRect();
        const px = (e.clientX - bounds.left - this.width / 2) / this.zoom;
        const py = (e.clientY - bounds.top - this.height / 2) / this.zoom;
        const delta = unproject(px, py);
        this.select(Math.round(this.camera.x + delta.x), Math.round(this.camera.y + delta.y));
      }
      this.drag = null;
    });
    canvas.addEventListener('pointercancel', () => { this.drag = null; });
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.scale(e.deltaY > 0 ? -0.08 : 0.08); }, { passive: false });
    requestAnimationFrame(this.frame);
  }
  center(): void { this.camera = { ...this.game().position }; }
  scale(amount: number): void { this.zoom = Math.max(0.65, Math.min(1.8, this.zoom + amount)); }
  private tileColor(terrain: Terrain, variant: number): string {
    return tileColor(terrain, variant, this.environment().season);
  }
  private resize(): void {
    const rect = this.canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio, 2);
    this.width = rect.width; this.height = rect.height;
    this.canvas.width = Math.round(rect.width * dpr); this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.minimap.width = 300; this.minimap.height = 190;
    this.fogCanvas.width = Math.ceil(rect.width) + 64; this.fogCanvas.height = Math.ceil(rect.height) + 64;
  }
  private diamond(x: number, y: number, fill: string): void {
    drawDiamond(this.ctx, x, y, fill);
  }
  private tree(x: number, y: number, h: number, variant: number): void {
    drawTree(this.ctx, x, y, h, variant, this.environment().season);
  }
  private house(x: number, y: number, size = 1): void {
    drawHouse(this.ctx, x, y, size);
  }
  private frame = (time: number): void => {
    requestAnimationFrame(this.frame);
    if (time - this.lastFrame < (this.reducedMotion ? 200 : 33)) return;
    this.lastFrame = time;
    const c = this.ctx, g = this.game();
    if (g.explored !== this.exploredRef) {
      const known = new Set(g.explored);
      if (known.size !== this.known.size || [...known].some(key => !this.known.has(key))) {
        this.known = known; this.fringe = explorationFringe(known);
      }
      this.exploredRef = g.explored;
    }
    c.clearRect(0, 0, this.width, this.height);
    c.fillStyle = '#111d18'; c.fillRect(0, 0, this.width, this.height);
    c.save(); c.translate(this.width / 2, this.height / 2); c.scale(this.zoom, this.zoom);
    const reach = Math.ceil(this.width / (78 * this.zoom) + this.height / (40 * this.zoom)) / 2 + 3;
    const tiles: (WorldTile & { x: number; y: number; terrain: Terrain })[] = [];
    for (let y = Math.floor(this.camera.y - reach); y <= this.camera.y + reach; y++) {
      for (let x = Math.floor(this.camera.x - reach); x <= this.camera.x + reach; x++) {
        const { x: sx, y: sy } = project(x - this.camera.x, y - this.camera.y);
        if (Math.abs(sx) > this.width / this.zoom / 2 + 90 || Math.abs(sy) > this.height / this.zoom / 2 + 110) continue;
        const terrain = terrainAt(x, y, g.seed), visible = this.known.has(`${x},${y}`);
        const clarity = visible ? 1 : this.fringe.get(`${x},${y}`) ?? 0;
        const distance = Math.hypot(x - g.position.x, y - g.position.y);
        c.globalAlpha = visible ? (distance <= radius(g) ? 1 : 0.46) : clarity > 0 ? 0.65 : 0.15;
        this.diamond(sx, sy, clarity > 0 ? this.tileColor(terrain, Math.floor(hash(x, y, g.seed + 7) * 3)) : '#53615b');
        tiles.push({ x, y, sx, sy, terrain, visible, clarity });
      }
    }
    tiles.sort((a, b) => a.sy - b.sy);
    for (const t of tiles) {
      const { x, y, sx, sy, terrain, visible, clarity } = t;
      if (!clarity) continue;
      const distance = Math.hypot(x - g.position.x, y - g.position.y);
      c.globalAlpha = visible ? (distance <= radius(g) ? 1 : 0.46) : 0.65;
      const n = hash(x, y, g.seed);
      const isHome = visible && g.home?.x === x && g.home?.y === y;
      if (isHome) {
        this.house(sx - 5, sy - 12, 1.2);
        if (g.stage > 0) this.house(sx + 20, sy + 3, 0.7);
        if (g.stage > 2) this.house(sx - 23, sy + 3, 0.75);
      } else if (terrain === 'forest' || terrain === 'rainforest' || terrain === 'pineforest' || terrain === 'mangrove') {
        this.tree(sx - 15, sy - 4, 33 + n * 18, n);
        this.tree(sx + 12, sy, 30 + n * 22, 1 - n);
        if (n > 0.3) this.tree(sx - 2, sy + 11, 34 + n * 15, n);
        if (terrain === 'rainforest') this.tree(sx + 2, sy - 9, 62, n);
        if (terrain === 'mangrove') {
          c.strokeStyle = '#b2c5a0'; c.beginPath(); c.moveTo(sx, sy - 6); c.lineTo(sx - 11, sy + 9); c.moveTo(sx, sy - 6); c.lineTo(sx + 13, sy + 7); c.stroke();
        }
      } else if (terrain === 'water' || terrain === 'river' || terrain === 'coast' || terrain === 'wetland') {
        c.strokeStyle = '#a0d4c04a'; c.lineWidth = 1;
        const drift = this.reducedMotion ? 0 : Math.sin(time / 1800 + n * 10) * 5;
        c.beginPath(); c.moveTo(sx - 14 + drift, sy - 3); c.lineTo(sx + drift, sy - 3); c.moveTo(sx + 3 - drift, sy + 6); c.lineTo(sx + 15 - drift, sy + 6); c.stroke();
        if (terrain === 'coast') {
          c.strokeStyle = '#dfd4a0'; c.lineWidth = 3; c.beginPath(); c.moveTo(sx - 28, sy + 1); c.quadraticCurveTo(sx, sy + 18, sx + 27, sy + 2); c.stroke();
        }
        if (terrain === 'wetland') {
          c.strokeStyle = '#b5b775'; c.lineWidth = 2;
          for (let i = 0; i < 5; i++) { c.beginPath(); c.moveTo(sx - 20 + i * 9, sy + 4); c.lineTo(sx - 22 + i * 9, sy - 12 - i % 2 * 6); c.stroke(); }
        }
      } else if (terrain === 'mountain' || terrain === 'volcano' || terrain === 'canyon' || terrain === 'hills' || terrain === 'glacier') {
        const h = 36 + n * 38;
        c.fillStyle = colors[terrain][1]; c.beginPath(); c.moveTo(sx - 34, sy + 7); c.lineTo(sx - 3, sy - h); c.lineTo(sx + 32, sy + 6); c.lineTo(sx, sy + 19); c.fill();
        c.fillStyle = colors[terrain][2]; c.beginPath(); c.moveTo(sx - 3, sy - h); c.lineTo(sx + 32, sy + 6); c.lineTo(sx, sy + 19); c.fill();
        c.fillStyle = terrain === 'volcano' ? '#ef8852' : terrain === 'canyon' ? '#e5aa76' : '#c9dfd9';
        c.beginPath(); c.moveTo(sx - 3, sy - h); c.lineTo(sx - 13, sy - h + 23); c.lineTo(sx - 3, sy - h + 18); c.lineTo(sx + 9, sy - h + 28); c.fill();
        c.fillStyle = '#e4bf70'; c.fillRect(sx - 18, sy, 5, 3);
      } else if (terrain === 'desert' || terrain === 'dunes') {
        c.strokeStyle = '#f2d5a0'; c.lineWidth = 2;
        for (let i = 0; i < 3; i++) { c.beginPath(); c.moveTo(sx - 25 + i * 3, sy - 5 + i * 7); c.quadraticCurveTo(sx, sy - 17 + i * 7, sx + 24 - i * 3, sy - 5 + i * 7); c.stroke(); }
      } else if (terrain === 'tundra') {
        c.fillStyle = '#c8e1de';
        for (let i = 0; i < 4; i++) c.fillRect(sx - 19 + i * 11, sy - 4 + i % 2 * 6, 6, 3);
      } else if (terrain === 'lithium') {
        for (let i = 0; i < 3; i++) {
          const dx = sx - 12 + i * 10;
          c.fillStyle = i % 2 ? '#a4cac2' : '#c6e1d3';
          c.beginPath(); c.moveTo(dx, sy - 21 - i * 3); c.lineTo(dx + 6, sy - 12); c.lineTo(dx + 4, sy + 3); c.lineTo(dx - 5, sy); c.lineTo(dx - 6, sy - 12); c.fill();
        }
      } else if (terrain === 'oil') {
        c.fillStyle = '#273d36'; c.beginPath(); c.ellipse(sx, sy, 20, 10, 0, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#a1ac7355'; c.beginPath(); c.ellipse(sx, sy, 14, 6, 0, 0, Math.PI); c.stroke();
      } else if (terrain === 'savanna') {
        c.fillStyle = '#72623d'; c.fillRect(sx - 2, sy - 23, 4, 27);
        c.fillStyle = '#85834b'; c.beginPath(); c.ellipse(sx, sy - 25, 26, 9, 0, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#d6be7e'; c.beginPath(); c.moveTo(sx - 19, sy + 8); c.lineTo(sx - 21, sy + 1); c.stroke();
      } else {
        if (n > 0.8) this.tree(sx, sy + 1, 29, n);
        else {
          c.fillStyle = '#c9cb8b'; for (let i = 0; i < 4; i++) c.fillRect(sx - 16 + hash(i, x, y + g.seed) * 32, sy - 5 + hash(x, i, y) * 12, 2, 2);
          c.strokeStyle = '#526f4666'; c.beginPath(); c.moveTo(sx + 5, sy + 7); c.lineTo(sx + 4, sy + 2); c.moveTo(sx + 5, sy + 7); c.lineTo(sx + 9, sy + 4); c.stroke();
        }
      }
    }
    c.globalAlpha = 1;
    c.restore();
    this.drawFog(tiles);
    c.save(); c.translate(this.width / 2, this.height / 2); c.scale(this.zoom, this.zoom);
    const { x: px, y: py } = project(g.position.x - this.camera.x, g.position.y - this.camera.y);
    c.strokeStyle = '#d7eab4'; c.lineWidth = 1.5;
    c.beginPath(); c.ellipse(px, py, 26, 13, 0, 0, Math.PI * 2); c.stroke();
    c.fillStyle = '#cdebab33'; c.fill();
    c.strokeStyle = '#d7eab488'; c.beginPath(); c.moveTo(px, py - 4); c.lineTo(px, py - 63); c.stroke();
    const bob = this.reducedMotion ? 0 : Math.sin(time / 700) * 2;
    c.fillStyle = '#d7eab4'; c.beginPath(); c.arc(px, py - 65 + bob, 10, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#243a2c'; c.beginPath(); c.arc(px, py - 65 + bob, 3, 0, Math.PI * 2); c.fill();
    c.restore();
    const fog = c.createRadialGradient(this.width / 2, this.height / 2, this.width * 0.12, this.width / 2, this.height / 2, Math.max(this.width, this.height) * 0.64);
    fog.addColorStop(0, '#0b151000'); fog.addColorStop(0.65, '#0b151045'); fog.addColorStop(1, '#0a100eed');
    c.fillStyle = fog; c.fillRect(0, 0, this.width, this.height);
    this.drawEnvironment(time);
    this.drawMinimap(g);
  };
  private drawFog(tiles: WorldTile[]): void {
    const fog = this.fog;
    fog.clearRect(0, 0, this.fogCanvas.width, this.fogCanvas.height);
    fog.fillStyle = '#111d18'; fog.fillRect(0, 0, this.fogCanvas.width, this.fogCanvas.height);
    fog.save(); fog.translate(this.width / 2 + 32, this.height / 2 + 32); fog.scale(this.zoom, this.zoom);
    fog.globalCompositeOperation = 'destination-out';
    for (const { sx, sy, clarity } of tiles) {
      if (!clarity) continue;
      fog.globalAlpha = clarity;
      fog.beginPath(); fog.moveTo(sx, sy - tileHeight / 2); fog.lineTo(sx + tileWidth / 2, sy);
      fog.lineTo(sx, sy + tileHeight / 2); fog.lineTo(sx - tileWidth / 2, sy); fog.closePath(); fog.fill();
    }
    fog.restore();
    this.ctx.save(); this.ctx.filter = `blur(${12 * this.zoom}px)`;
    this.ctx.drawImage(this.fogCanvas, -32, -32); this.ctx.restore();
  }
  private drawEnvironment(time: number): void {
    drawEnvironment(this.ctx, this.environment(), this.width, this.height, time, this.reducedMotion);
  }
  private drawMinimap(g: Game): void {
    const c = this.mini;
    c.fillStyle = '#111b17'; c.fillRect(0, 0, 300, 190);
    const span = 36;
    for (let y = -span; y <= span; y++) for (let x = -span; x <= span; x++) {
      const wx = g.position.x + x, wy = g.position.y + y;
      const clarity = this.known.has(`${wx},${wy}`) ? 1 : (this.fringe.get(`${wx},${wy}`) ?? 0) * .65;
      if (!clarity) continue;
      c.globalAlpha = clarity;
      c.fillStyle = this.tileColor(terrainAt(wx, wy, g.seed), 0);
      c.fillRect(150 + (x - y) * 3, 95 + (x + y) * 1.5, 5, 3);
    }
    c.globalAlpha = 1;
    c.strokeStyle = '#b6d59c66'; c.strokeRect(113, 73, 74, 44);
    c.fillStyle = '#e0f6c0'; c.beginPath(); c.arc(150, 95, 4, 0, Math.PI * 2); c.fill();
    if (g.home) {
      c.fillStyle = '#e4bf70';
      c.fillRect(148 + (g.home.x - g.position.x - g.home.y + g.position.y) * 3, 93 + (g.home.x - g.position.x + g.home.y - g.position.y) * 1.5, 5, 5);
    }
  }
}
