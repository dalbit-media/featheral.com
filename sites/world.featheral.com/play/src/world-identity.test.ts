import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { watchWorldIdentity } from './world-identity.ts';

test('World account switches reload the entire game once, even when the new settlement has a lower revision', () => {
  const target = new EventTarget();
  let reloads = 0, setups = 0;
  const close = watchWorldIdentity(target, '0xAbC', () => reloads++, () => setups++);
  const emit = (detail: object) => target.dispatchEvent(new CustomEvent('featheral:world-session', { detail }));
  emit({ account: '0xabc', complete: true, revision: 100 });
  assert.equal(reloads, 0);
  emit({ account: '0xdef', complete: true, revision: 0 });
  emit({ account: '0xdef', complete: true });
  assert.equal(reloads, 1); assert.equal(setups, 0);
  close();
});

test('signed-out or incomplete identities leave the old settlement and open World setup', () => {
  for (const detail of [{ account: null, complete: false }, { account: '0xdef', complete: false }, { account: '0xabc', complete: false }]) {
    const target = new EventTarget();
    let reloads = 0, setups = 0;
    const close = watchWorldIdentity(target, '0xabc', () => reloads++, () => setups++);
    target.dispatchEvent(new CustomEvent('featheral:world-session', { detail }));
    assert.equal(reloads, 0); assert.equal(setups, 1);
    close();
    target.dispatchEvent(new CustomEvent('featheral:world-session', { detail }));
    assert.equal(setups, 1);
  }
});
