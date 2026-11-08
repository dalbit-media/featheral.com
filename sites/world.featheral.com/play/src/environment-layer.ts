import type { Environment } from './environment.ts';
import { drawEnvironment } from './map-art.ts';

// Keep terrain cached while weather moves independently over the saved scene.
export class EnvironmentLayer {
  private scene = document.createElement('canvas');
  private context: CanvasRenderingContext2D;
  private motion = matchMedia('(prefers-reduced-motion: reduce)');
  private dirty = true;
  private lastFrame = -Infinity;
  private reducedMotion: boolean | undefined;

  constructor() {
    const context = this.scene.getContext('2d');
    if (!context) throw new Error('Your browser does not support the canvas renderer.');
    this.context = context;
  }

  capture(canvas: HTMLCanvasElement): void {
    if (this.scene.width !== canvas.width || this.scene.height !== canvas.height) {
      this.scene.width = canvas.width;
      this.scene.height = canvas.height;
    }
    this.context.clearRect(0, 0, this.scene.width, this.scene.height);
    this.context.drawImage(canvas, 0, 0);
    this.dirty = true;
  }

  draw(context: CanvasRenderingContext2D, environment: Environment, width: number, height: number, time: number): void {
    const reduced = this.motion.matches;
    const animated = !reduced && ['Rain', 'Snow', 'Storm'].includes(environment.weather);
    if (!this.dirty && reduced === this.reducedMotion && (!animated || time - this.lastFrame < 1000 / 30)) return;
    context.clearRect(0, 0, width, height);
    context.drawImage(this.scene, 0, 0, width, height);
    drawEnvironment(context, environment, width, height, time, reduced);
    this.dirty = false;
    this.reducedMotion = reduced;
    this.lastFrame = time;
  }
}
