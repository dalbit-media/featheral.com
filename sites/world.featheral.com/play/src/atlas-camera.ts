import { atlasSize } from './atlas.ts';
import type { Location } from './atlas.ts';

export interface AtlasCameraState { x: number; y: number; scale: number }
export function zoomAtlas(camera: AtlasCameraState, factor: number, anchor: Location, minimum: number): AtlasCameraState {
  const scale = Math.max(minimum, Math.min(minimum * 16, camera.scale * factor));
  const ratio = scale / camera.scale;
  return { x: anchor.x - (anchor.x - camera.x) * ratio, y: anchor.y - (anchor.y - camera.y) * ratio, scale };
}
export class AtlasCamera {
  private camera: AtlasCameraState = { x: 0, y: 0, scale: 1 };
  private minimum = 1;
  private width = 0;
  private height = 0;
  private centerPoint: Location = { x: 0, y: 0 };
  private frame = 0;
  private readonly pointers = new Map<number, Location>();
  private readonly observer: ResizeObserver;
  private readonly events = new AbortController();
  private readonly scene: HTMLElement;
  private readonly status: HTMLElement;
  constructor(viewport: HTMLElement, scene: HTMLElement, status: HTMLElement) {
    this.scene = scene; this.status = status;
    const options = { signal: this.events.signal };
    const point = (event: PointerEvent): Location => {
      const bounds = viewport.getBoundingClientRect();
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };
    viewport.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      viewport.focus({ preventScroll: true });
      viewport.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, point(event));
      viewport.classList.add('is-panning');
    }, options);
    viewport.addEventListener('pointermove', event => {
      const previous = this.pointers.get(event.pointerId);
      if (!previous) return;
      const next = point(event);
      const other = [...this.pointers].find(([id]) => id !== event.pointerId)?.[1];
      if (other) {
        const before = Math.hypot(previous.x - other.x, previous.y - other.y);
        const after = Math.hypot(next.x - other.x, next.y - other.y);
        const anchor = { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 };
        if (before > 0) this.camera = zoomAtlas(this.camera, after / before, anchor, this.minimum);
        this.camera.x += (next.x - previous.x) / 2;
        this.camera.y += (next.y - previous.y) / 2;
      } else {
        this.camera.x += next.x - previous.x;
        this.camera.y += next.y - previous.y;
      }
      this.pointers.set(event.pointerId, next); this.schedule();
    }, options);
    const release = (event: PointerEvent): void => {
      this.pointers.delete(event.pointerId);
      if (!this.pointers.size) viewport.classList.remove('is-panning');
    };
    viewport.addEventListener('pointerup', release, options);
    viewport.addEventListener('pointercancel', release, options);
    viewport.addEventListener('lostpointercapture', release, options);
    viewport.addEventListener('wheel', event => {
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1);
      this.camera = zoomAtlas(this.camera, Math.exp(-Math.max(-300, Math.min(300, delta)) * .002),
        { x: event.clientX - bounds.left, y: event.clientY - bounds.top }, this.minimum);
      this.schedule();
    }, { ...options, passive: false });
    viewport.addEventListener('keydown', event => {
      const direction = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }[event.key];
      if (direction) { this.camera.x += direction[0]; this.camera.y += direction[1]; this.schedule(); }
      else if (event.key === '+' || event.key === '=') this.zoom(1.25);
      else if (event.key === '-') this.zoom(.8);
      else if (event.key === 'Home') this.fit();
      else return;
      event.preventDefault();
    }, options);
    this.observer = new ResizeObserver(() => {
      const width = viewport.clientWidth, height = viewport.clientHeight;
      if (!width || !height) return;
      const first = !this.width;
      const style = getComputedStyle(viewport);
      const left = parseFloat(style.paddingLeft), top = parseFloat(style.paddingTop);
      const availableWidth = width - left - parseFloat(style.paddingRight);
      const availableHeight = height - top - parseFloat(style.paddingBottom);
      const center = { x: left + availableWidth / 2, y: top + availableHeight / 2 };
      this.camera.x += center.x - this.centerPoint.x;
      this.camera.y += center.y - this.centerPoint.y;
      this.centerPoint = center;
      const ratio = this.camera.scale / this.minimum;
      this.width = width; this.height = height;
      this.minimum = Math.max(1, Math.min(availableWidth, availableHeight)) / (atlasSize + 80);
      if (first) this.fit();
      else {
        this.camera = zoomAtlas(this.camera, this.minimum * ratio / this.camera.scale,
          center, this.minimum);
        this.schedule();
      }
    });
    this.observer.observe(viewport);
  }
  fit(): void {
    this.camera = { x: this.centerPoint.x - atlasSize * this.minimum / 2,
      y: this.centerPoint.y - atlasSize * this.minimum / 2, scale: this.minimum };
    this.schedule();
  }
  center(location: Location): void {
    this.camera.x = this.centerPoint.x - location.x * this.camera.scale;
    this.camera.y = this.centerPoint.y - location.y * this.camera.scale;
    this.schedule();
  }
  zoom(factor: number): void {
    this.camera = zoomAtlas(this.camera, factor, this.centerPoint, this.minimum);
    this.schedule();
  }
  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const { scale } = this.camera;
      this.camera.x = Math.max(-atlasSize * scale + 40, Math.min(this.width - 40, this.camera.x));
      this.camera.y = Math.max(-atlasSize * scale + 40, Math.min(this.height - 40, this.camera.y));
      this.scene.style.transform = `translate3d(${this.camera.x}px,${this.camera.y}px,0) scale(${scale})`;
      this.status.textContent = `${Math.round(scale / this.minimum * 100)}%`;
    });
  }
  close(): void {
    this.events.abort(); this.observer.disconnect();
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.pointers.clear();
  }
}
