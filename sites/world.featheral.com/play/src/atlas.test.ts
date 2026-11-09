import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { atlasSize, federationArt, foundedFederationName, generatedAvatar, nearbyDistance, rankEntries, rankingMetrics, settlementDistance, startingFederations, territoryAt } from './atlas.ts';
import type { AtlasEntry } from './atlas.ts';
import { atlasMap } from './atlas-view.ts';
import { translate } from './i18n.ts';
import { diplomacy, newGame } from './engine.ts';
import { parseCommand } from '../server/economy.ts';

const entry = (id: string, population: number, netWorth: number, federation: string | null = null): AtlasEntry => ({
  id, player: id, settlement: id, yours: false, location: { x: population, y: 0 }, distance: null,
  federation, population, netWorth, dollars: netWorth, stage: 3, explored: population, contribution: population,
});
test('rankings cover every metric, sort descending and break ties deterministically without mutating input', () => {
  const entries = [entry('z', 10, 50), entry('a', 10, 100), entry('b', 20, 75)];
  const before = structuredClone(entries);
  assert.deepEqual(rankEntries(entries, 'population').map(row => row.id), ['b', 'a', 'z']);
  assert.deepEqual(rankEntries(entries, 'netWorth').map(row => row.id), ['a', 'b', 'z']);
  for (const metric of rankingMetrics) assert.equal(rankEntries(entries, metric).length, 3);
  assert.deepEqual(entries, before);
});
test('distances and informational territories include neutral independent neighbors and deterministic ties', () => {
  assert.equal(settlementDistance({ x: 0, y: 0 }, { x: 60, y: 80 }), nearbyDistance);
  assert.ok(settlementDistance({ x: 0, y: 0 }, { x: 61, y: 80 }) > nearbyDistance);
  const entries = [entry('a', 0, 0, 'Evergreen Union'), entry('b', 100, 0, 'Aurora Concord'), entry('c', 200, 0)];
  assert.equal(territoryAt({ x: 20, y: 0 }, entries), 'Evergreen Union');
  assert.equal(territoryAt({ x: 50, y: 0 }, [...entries].reverse()), 'Evergreen Union');
  assert.equal(territoryAt({ x: 110, y: 0 }, entries), 'Aurora Concord');
  assert.equal(territoryAt({ x: 210, y: 0 }, entries), null);
  assert.equal(territoryAt({ x: 0, y: 0 }, []), null);
  assert.equal(atlasSize, 1000);
});
test('generated heraldry and avatars are stable, distinct, escaped and usable for existing federations', () => {
  for (const kind of ['flag', 'shield'] as const) {
    assert.equal(new Set(startingFederations.map(identity => federationArt(identity.name, kind))).size, 5);
    assert.equal(federationArt('Custom Alliance', kind), federationArt('Custom Alliance', kind));
    assert.doesNotMatch(federationArt('"><script>alert(1)</script>', kind), /<script>/);
  }
  assert.equal(generatedAvatar('player'), generatedAvatar('player'));
  assert.notEqual(generatedAvatar('player'), generatedAvatar('other'));
  assert.notEqual(foundedFederationName(100), foundedFederationName(101));
  const html = atlasMap({ entries: [entry('<img onerror=alert(1)>', 5, 0)], federations: [], updatedAt: 0 }, 'ko');
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /정착지 지도와 연방 영역/);
  for (const text of ['Hall of Fame', 'Settlement atlas', 'Net worth', 'Nearby (100 km)', 'Starting federations'])
    assert.notEqual(translate(text, 'ko'), text);
});
test('every starter can be joined with unchanged gates and strict command validation', () => {
  for (const identity of startingFederations) {
    const game = newGame(123);
    game.stage = 3; game.relationship = 50;
    const command = { type: 'diplomacy', action: 'join', federation: identity.name } as const;
    assert.deepEqual(parseCommand(command), command);
    diplomacy(game, 'join', identity.name);
    assert.equal(game.federation, identity.name);
    assert.throws(() => diplomacy(game, 'join', identity.name), /already/);
  }
  assert.deepEqual(parseCommand({ type: 'diplomacy', action: 'join' }), { type: 'diplomacy', action: 'join' });
  for (const command of [
    { type: 'diplomacy', action: 'join', federation: 'fake' },
    { type: 'diplomacy', action: 'join', federation: 42 },
    { type: 'diplomacy', action: 'form', federation: 'Evergreen Union' },
  ]) assert.throws(() => parseCommand(command), /Invalid command/);
});
