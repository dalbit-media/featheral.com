import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createCountUp } from './count-up.ts';

function animationClock(t: TestContext) {
  let time = 0, id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const request = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  globalThis.cancelAnimationFrame = frame => { frames.delete(frame); };
  t.mock.method(performance, 'now', () => time);
  t.after(() => {
    if (request) globalThis.requestAnimationFrame = request;
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    if (cancel) globalThis.cancelAnimationFrame = cancel;
    else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  });
  return {
    get pending() { return frames.size; },
    advance(ms: number) {
      time += ms;
      const batch = [...frames.values()];
      frames.clear();
      batch.forEach(callback => callback(time));
    },
  };
}

test('arrival counts from zero to the exact real total in 2.2 seconds, then stops', t => {
  const clock = animationClock(t), values: number[] = [];
  const counter = createCountUp(value => values.push(value));
  counter.set(1000, true);
  assert.deepEqual(values, [0]);
  clock.advance(1100);
  assert.equal(values.at(-1), 875);
  clock.advance(1100);
  assert.equal(values.at(-1), 1000);
  assert.equal(clock.pending, 0);
  clock.advance(30000);
  assert.deepEqual(values, [0, 875, 1000]);
});

test('later updates animate actual decreases as well as increases in 1.4 seconds', t => {
  const clock = animationClock(t), values: number[] = [];
  const counter = createCountUp(value => values.push(value));
  counter.set(1000, false);
  counter.set(800, true);
  clock.advance(700);
  assert.equal(values.at(-1), 825);
  clock.advance(700);
  assert.equal(values.at(-1), 800);
  counter.set(1200, true);
  clock.advance(1400);
  assert.equal(values.at(-1), 1200);
  assert.equal(clock.pending, 0);
});

test('retargeting starts from the displayed value and identical totals do not replay', t => {
  const clock = animationClock(t), values: number[] = [];
  const counter = createCountUp(value => values.push(value));
  counter.set(1000, true);
  clock.advance(1100);
  counter.set(2000, true);
  assert.equal(values.at(-1), 875);
  assert.equal(clock.pending, 1);
  clock.advance(700);
  assert.ok(values.at(-1)! > 875 && values.at(-1)! < 2000);
  counter.set(2000, true);
  clock.advance(700);
  assert.equal(values.at(-1), 2000);
  assert.equal(clock.pending, 0);
  const length = values.length;
  counter.set(2000, true);
  assert.equal(values.length, length);
});

test('finishing cancels frames, shows the known target and never invents initial zeros', t => {
  const clock = animationClock(t), values: number[] = [];
  const counter = createCountUp(value => values.push(value));
  counter.finish();
  assert.deepEqual(values, []);
  counter.set(100, true);
  clock.advance(100);
  counter.finish();
  assert.equal(values.at(-1), 100);
  assert.equal(clock.pending, 0);
  counter.set(200, true);
  counter.set(200, false);
  assert.equal(values.at(-1), 200);
  assert.equal(clock.pending, 0);
  counter.set(0, false);
  assert.equal(values.at(-1), 0);
});

test('intermediate values stay integer, bounded and monotonic through the safe range', t => {
  const clock = animationClock(t), values: number[] = [];
  const counter = createCountUp(value => values.push(value));
  counter.set(Number.MAX_SAFE_INTEGER, true);
  for (let i = 0; i < 44; i++) clock.advance(50);
  assert.equal(values.at(-1), Number.MAX_SAFE_INTEGER);
  assert.ok(values.every((value, i) => Number.isSafeInteger(value) && value >= 0
    && value <= Number.MAX_SAFE_INTEGER && (i === 0 || value >= values[i - 1])));
  assert.equal(clock.pending, 0);
});
