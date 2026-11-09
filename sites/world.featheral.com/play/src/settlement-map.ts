import { hash } from './engine.ts';
import type { ApiState } from './api-types.ts';
import type { Environment } from './environment.ts';
import { decorationDrawing } from './item-art.ts';
import { decorationItems, isDecorationItem } from './items.ts';
import type { DecorationItem } from './items.ts';
import { drawDiamond, drawHouse, drawTree, drawWaterFacility, houseHeight, project, tileColor, unproject } from './map-art.ts';
import { EnvironmentLayer } from './environment-layer.ts';
import { isWaterFacility } from './water-facilities.ts';
import { arrangementError, cellKey, positionEntries, settlementEntityName, settlementPositions, settlementRadius, settlementTerrain } from './settlement-layout.ts';
import type { GridPosition, SettlementEntity } from './settlement-layout.ts';
import { translate } from './i18n.ts';
import type { Language } from './i18n.ts';

interface MapState { state: ApiState; environment: Environment; editing: boolean; selected: SettlementEntity; pending: SettlementEntity | null }
interface Drag { id: number; x: number; y: number; camera: GridPosition; moved: boolean; entity: SettlementEntity | null }
export class SettlementMap {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private camera = { x: 0, y: 0 };
  private zoom = 2.4;
  private weatherLayer = new EnvironmentLayer();
  private drag: Drag | null = null;
  private hover: GridPosition | null = null;
  private hovered: SettlementEntity | null = null;
  private lastFrame = 0;
  private images = new Map<DecorationItem, HTMLImageElement>();
  private renderKey = '';
  private artworkRevision = 0;
  private canvas: HTMLCanvasElement;
  private getState: () => MapState;
  private select: (entity: SettlementEntity | null, position: GridPosition) => void;
  private move: (entity: SettlementEntity, position: GridPosition) => void;
  private language: Language;
  constructor(canvas: HTMLCanvasElement, getState: () => MapState, select: SettlementMap['select'], move: SettlementMap['move'], language: Language, reportError: (message: string) => void) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser does not support the canvas renderer.');
    this.ctx = ctx; this.canvas = canvas; this.getState = getState; this.select = select; this.move = move; this.language = language;
    this.zoom = getState().state.game.stage >= 9 ? 1.4 : 2.4;
    for (const id of Object.keys(decorationItems) as DecorationItem[]) {
      const image = new Image();
      image.onload = () => { this.artworkRevision++; };
      image.onerror = () => reportError('Could not load settlement decoration artwork.');
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${decorationDrawing(id)}</svg>`)}`;
      this.images.set(id, image);
    }
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', event => {
      if (this.drag || event.button !== 0) return;
      const view = this.getState();
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, camera: { ...this.camera }, moved: false,
        entity: view.editing && !view.pending ? this.hit(event.clientX, event.clientY) : null };
      this.hover = this.cell(event.clientX, event.clientY);
      canvas.setPointerCapture(event.pointerId);
      canvas.focus({ preventScroll: true });
    });
    canvas.addEventListener('pointermove', event => {
      this.hover = this.cell(event.clientX, event.clientY);
      this.hovered = this.drag ? null : this.hit(event.clientX, event.clientY);
      if (!this.drag || this.drag.id !== event.pointerId) return;
      const dx = (event.clientX - this.drag.x) / this.zoom, dy = (event.clientY - this.drag.y) / this.zoom;
      if (Math.hypot(event.clientX - this.drag.x, event.clientY - this.drag.y) > 5) this.drag.moved = true;
      if (!this.drag.entity) {
        const delta = unproject(dx, dy);
        this.camera = { x: this.clamp(this.drag.camera.x - delta.x), y: this.clamp(this.drag.camera.y - delta.y) };
      }
    });
    canvas.addEventListener('pointerup', event => {
      const drag = this.drag;
      if (!drag || drag.id !== event.pointerId) return;
      this.drag = null;
      if (drag.moved && drag.entity) this.move(drag.entity, this.cell(event.clientX, event.clientY));
      else if (!drag.moved) this.select(this.getState().pending ? null : this.hit(event.clientX, event.clientY), this.cell(event.clientX, event.clientY));
    });
    canvas.addEventListener('pointercancel', () => { this.drag = null; });
    canvas.addEventListener('pointerleave', () => { if (!this.drag) { this.hover = null; this.hovered = null; } });
    canvas.addEventListener('wheel', event => { event.preventDefault(); this.scale(event.deltaY > 0 ? -.08 : .08); }, { passive: false });
    canvas.addEventListener('keydown', event => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const delta: Record<string, GridPosition> = { ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 } };
      if (delta[event.key]) {
        event.preventDefault();
        const start = this.hover ?? { x: Math.round(this.camera.x), y: Math.round(this.camera.y) }, step = delta[event.key];
        this.hover = { x: Math.round(this.clamp(start.x + step.x)), y: Math.round(this.clamp(start.y + step.y)) };
        if (!this.getState().pending) this.center(this.hover);
        canvas.setAttribute('aria-description', translate(`Selected cell: ${this.hover.x}, ${this.hover.y}.`, language));
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const cell = this.hover ?? { x: Math.round(this.camera.x), y: Math.round(this.camera.y) };
        const entity = positionEntries(settlementPositions(this.getState().state.game, this.getState().state.inventory)).find(([, p]) => cellKey(p) === cellKey(cell))?.[0];
        this.select(entity ?? null, cell);
      }
    });
    requestAnimationFrame(this.frame);
  }
  center(position: GridPosition = { x: 0, y: 0 }): void { this.camera = { ...position }; }
  scale(amount: number): void { this.zoom = Math.max(.65, Math.min(3, this.zoom + amount)); }
  private clamp(value: number): number { return Math.max(-settlementRadius - 2, Math.min(settlementRadius + 2, value)); }
  private cell(x: number, y: number): GridPosition {
    const bounds = this.canvas.getBoundingClientRect(), delta = unproject((x - bounds.left - this.width / 2) / this.zoom, (y - bounds.top - this.height / 2) / this.zoom);
    return { x: Math.round(this.camera.x + delta.x), y: Math.round(this.camera.y + delta.y) };
  }
  private hit(x: number, y: number): SettlementEntity | null {
    const { state } = this.getState(), bounds = this.canvas.getBoundingClientRect();
    const point = { x: (x - bounds.left - this.width / 2) / this.zoom, y: (y - bounds.top - this.height / 2) / this.zoom };
    const entries = positionEntries(settlementPositions(state.game, state.inventory)).sort(([, a], [, b]) => b.x + b.y - a.x - a.y);
    for (const [id, position] of entries) {
      const screen = project(position.x - this.camera.x, position.y - this.camera.y);
      const height = isDecorationItem(id) ? 48 : state.game.stage >= 6 ? (houseHeight(state.game.stage) + 22) * (id === 'centre' ? 1.6 : 1.35) + 8 : id === 'centre' ? 85 : 55;
      if (Math.abs(point.x - screen.x) < 30 && point.y >= screen.y - height && point.y <= screen.y + 22) return id;
    }
    return null;
  }
  private resize(): void {
    const bounds = this.canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio, 2);
    this.width = bounds.width; this.height = bounds.height;
    this.canvas.width = Math.round(bounds.width * dpr); this.canvas.height = Math.round(bounds.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.renderKey = '';
  }
  private entity(id: SettlementEntity, x: number, y: number): void {
    const { state, environment } = this.getState(), c = this.ctx;
    if (isDecorationItem(id)) {
      const image = this.images.get(id)!;
      if (image.complete && image.naturalWidth) c.drawImage(image, x - 27, y - 45, 54, 54);
    } else if (isWaterFacility(id)) {
      drawWaterFacility(c, x, y - 8, id, environment.daylight < .5, state.game.stage);
    } else {
      const kind = id.startsWith('home-') || id === 'housing' ? 'home' : id === 'cistern' ? 'supplies' : id;
      drawHouse(c, x, y - 8, kind === 'centre' ? 1.6 : kind === 'home' ? 1.15 : 1.35,
        { kind: kind as 'home' | 'centre' | 'workshop' | 'supplies' | 'bank' | 'townhall' | 'market-stall' | 'trade-hub', urban: state.game.stage >= 6 || (kind === 'centre' && state.game.stage >= 4), stage: state.game.stage, night: environment.daylight < .5 });
    }
  }
  private frame = (time: number): void => {
    requestAnimationFrame(this.frame);
    if (document.hidden || !this.canvas.isConnected || !this.width || !this.height
      || time - this.lastFrame < 16) return;
    this.lastFrame = time;
    const c = this.ctx, view = this.getState(), { game, inventory } = view.state;
    const hover = view.editing || view.pending || this.drag?.entity ? this.hover : null;
    const renderKey = `${this.width}:${this.height}:${this.camera.x}:${this.camera.y}:${this.zoom}:${view.state.revision}:${this.artworkRevision}:${view.editing}:${view.selected}:${view.pending}:${hover?.x}:${hover?.y}:${this.hovered}:${this.drag?.entity}:${this.drag?.moved}:${view.environment.season}:${view.environment.phase}:${view.environment.weather}:${view.environment.daylight}`;
    if (renderKey === this.renderKey) {
      this.weatherLayer.draw(c, view.environment, this.width, this.height, time);
      return;
    }
    this.renderKey = renderKey;
    const positions = settlementPositions(game, inventory);
    const occupants = new Map(positionEntries(positions).map(([id, position]) => [cellKey(position), id]));
    c.clearRect(0, 0, this.width, this.height); c.fillStyle = '#111d18'; c.fillRect(0, 0, this.width, this.height);
    c.save(); c.translate(this.width / 2, this.height / 2); c.scale(this.zoom, this.zoom);
    const tiles = [];
    for (let y = -settlementRadius; y <= settlementRadius; y++) for (let x = -settlementRadius; x <= settlementRadius; x++) {
      const screen = project(x - this.camera.x, y - this.camera.y), terrain = settlementTerrain(x, y, game.seed);
      if (Math.abs(screen.x) > this.width / this.zoom / 2 + 90 || Math.abs(screen.y) > this.height / this.zoom / 2 + Math.max(110, (houseHeight(game.stage) + 22) * 1.6 + 8)) continue;
      const road = (x === 0 || y === 0) && terrain !== 'river';
      drawDiamond(c, screen.x, screen.y, road ? game.stage >= 4 ? '#9a9f89' : '#aa9e77' : tileColor(terrain, Math.floor(hash(x, y, game.seed + 7) * 3), view.environment.season));
      if (view.editing) { c.strokeStyle = '#d5ebad50'; c.lineWidth = .8; c.stroke(); }
      tiles.push({ sx: screen.x, sy: screen.y, terrain, road, cellX: x, cellY: y });
    }
    tiles.sort((a, b) => a.cellX + a.cellY - b.cellX - b.cellY);
    for (const tile of tiles) {
      const { cellX: x, cellY: y, sx, sy, terrain, road } = tile, n = hash(x, y, game.seed), entity = occupants.get(cellKey({ x, y }));
      if (terrain === 'river') {
        const drift = 0;
        c.strokeStyle = '#a0d4c04a'; c.lineWidth = 1; c.beginPath(); c.moveTo(sx - 14 + drift, sy - 3); c.lineTo(sx + drift, sy - 3); c.moveTo(sx + 3 - drift, sy + 6); c.lineTo(sx + 15 - drift, sy + 6); c.stroke();
      } else if (game.stage < 0 && x === 0 && y === 0) {
        c.fillStyle = '#183a2938'; c.beginPath(); c.ellipse(sx, sy + 8, 29, 13, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#c9ba86'; c.beginPath(); c.moveTo(sx - 26, sy + 8); c.lineTo(sx, sy - 31); c.lineTo(sx + 25, sy + 8); c.closePath(); c.fill();
        c.fillStyle = '#8b9868'; c.beginPath(); c.moveTo(sx, sy - 31); c.lineTo(sx + 15, sy - 24); c.lineTo(sx + 36, sy + 4); c.lineTo(sx + 25, sy + 8); c.closePath(); c.fill();
        c.fillStyle = '#314536'; c.beginPath(); c.moveTo(sx - 8, sy + 8); c.lineTo(sx, sy - 13); c.lineTo(sx + 9, sy + 8); c.closePath(); c.fill();
      } else if (entity) {
        if (entity === view.selected && view.editing) { drawDiamond(c, sx, sy, '#e3cd8866'); c.strokeStyle = '#efd58e'; c.lineWidth = 1.5; c.stroke(); }
        if (!(this.drag?.entity === entity && this.drag.moved)) this.entity(entity, sx, sy);
      } else if (terrain === 'forest' && !road) {
        drawTree(c, sx - 12, sy, 35 + n * 20, n, view.environment.season);
        if (n > .5) drawTree(c, sx + 13, sy + 5, 28 + n * 12, 1 - n, view.environment.season);
      } else if (road && x === 0 && y > -5 && y < 5 && (y + 5) % 2 === 0 && game.stage >= 0) {
        const walk = 0;
        c.fillStyle = '#183a2938'; c.beginPath(); c.ellipse(sx + walk, sy + 2, 4, 2, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#749da0'; c.fillRect(sx - 2 + walk, sy - 7, 4, 8);
        c.fillStyle = '#dbc298'; c.beginPath(); c.arc(sx + walk, sy - 10, 2.5, 0, Math.PI * 2); c.fill();
      } else if (n > .87 && !road) {
        drawTree(c, sx, sy, 29 + n * 8, n, view.environment.season);
      } else if (n > .65) {
        c.fillStyle = view.environment.season === 'Winter' ? '#d9e3d3' : '#c9cb8b'; c.fillRect(sx - 10, sy - 4, 2, 2); c.fillRect(sx + 8, sy + 2, 2, 2);
      }
    }
    const moving = this.drag?.moved ? this.drag.entity : view.pending;
    const cursor = moving || view.editing ? this.hover : this.hovered ? positions[this.hovered] : null;
    if (cursor) {
      const screen = project(cursor.x - this.camera.x, cursor.y - this.camera.y);
      const error = moving ? arrangementError(game, inventory, moving, cursor) : null;
      drawDiamond(c, screen.x, screen.y, error ? '#c5756777' : '#c6e8a455'); c.strokeStyle = error ? '#f2a08a' : '#e3f2bd'; c.lineWidth = 1.6; c.stroke();
      if (moving) { c.globalAlpha = .7; this.entity(moving, screen.x, screen.y); c.globalAlpha = 1; }
      const id = moving ?? this.hovered ?? occupants.get(cellKey(cursor));
      const label = error ? translate(error, this.language) : id ? translate(settlementEntityName(id), this.language) : `${cursor.x}, ${cursor.y}`;
      c.font = '11px sans-serif'; const width = Math.min(300, c.measureText(label).width + 20);
      c.fillStyle = '#142c24ed'; c.fillRect(screen.x - width / 2, screen.y - 100, width, 24); c.fillStyle = '#e5ecd6'; c.textAlign = 'center'; c.fillText(label, screen.x, screen.y - 84, width - 12);
    }
    c.restore();
    this.weatherLayer.capture(this.canvas);
    this.weatherLayer.draw(c, view.environment, this.width, this.height, time);
  };
}
