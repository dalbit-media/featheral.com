import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { environmentAt, worldEpoch } from './environment.ts';
import { drawEnvironment } from './map-art.ts';

test('weather restores the cached scene, animates at 30 fps and respects reduced motion', () => {
  const source = stripTypeScriptTypes(readFileSync(new URL('./environment-layer.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const motion = { matches: false };
  let captures = 0, restores = 0;
  const frames: { time: number; reduced: boolean }[] = [];
  const Layer = runInNewContext(`${source}; EnvironmentLayer;`, {
    matchMedia: () => motion,
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ clearRect() {}, drawImage() { captures++; } }) }) },
    drawEnvironment: (_context: object, _environment: object, _width: number, _height: number, time: number, reduced: boolean) => frames.push({ time, reduced }),
  });
  const layer = new Layer();
  const context = { clearRect() {}, drawImage() { restores++; } };
  const environment = { ...environmentAt(worldEpoch), weather: 'Rain' };
  layer.capture({ width: 800, height: 600 });
  for (let time = 0; time < 1000; time += 10) layer.draw(context, environment, 800, 600, time);
  assert.equal(captures, 1, 'terrain is captured only when the renderer changes');
  assert.equal(frames.length, 25, '40ms ticks cannot exceed the 30fps ceiling');
  assert.equal(restores, frames.length, 'old precipitation is erased before the next frame');
  assert.ok(frames.every(frame => !frame.reduced));
  motion.matches = true;
  layer.draw(context, environment, 800, 600, 1000);
  const stillCount = frames.length;
  layer.draw(context, environment, 800, 600, 2000);
  assert.equal(frames.length, stillCount);
  assert.equal(frames.at(-1)?.reduced, true);
  motion.matches = false;
  layer.draw(context, environment, 800, 600, 2100);
  assert.equal(frames.length, stillCount + 1);
  environment.weather = 'Clear skies';
  layer.capture({ width: 400, height: 300 });
  layer.draw(context, environment, 400, 300, 2200);
  layer.draw(context, environment, 400, 300, 2300);
  assert.equal(frames.length, stillCount + 2, 'clear scenes need only one lighting pass');
});

test('rain, snow and storm positions move, while reduced-motion precipitation remains fixed', () => {
  for (const weather of ['Rain', 'Snow', 'Storm'] as const) {
    const environment = { ...environmentAt(worldEpoch), weather };
    function particles(time: number, reduced: boolean) {
      const positions: number[][] = [];
      const context = { fillRect() {}, beginPath() {}, stroke() {}, fill() {},
        moveTo: (...point: number[]) => positions.push(point), lineTo() {},
        arc: (...point: number[]) => positions.push(point) };
      drawEnvironment(context as unknown as CanvasRenderingContext2D, environment, 800, 600, time, reduced);
      return positions;
    }
    assert.notDeepEqual(particles(0, false), particles(1000, false));
    assert.deepEqual(particles(0, true), particles(1000, true));
  }
});
