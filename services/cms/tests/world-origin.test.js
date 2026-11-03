const { test } = require('node:test');
const assert = require('node:assert/strict');
const { worldOrigin } = require('../../operations/origin');

test('deployed servers serve the game API at the assigned public World origin', () => {
  const manifest = { hosts: ['featheral.com', 'world.featheral.com', 'admin.featheral.com'], primary: true };
  assert.equal(worldOrigin({}, manifest, 8080), 'https://world.featheral.com', 'missing setting');
  for (const local of ['http://world.localhost:8080', 'http://127.0.0.1:8080', 'http://localhost:5173'])
    assert.equal(worldOrigin({ APP_ORIGIN: local }, manifest, 8080), 'https://world.featheral.com', 'dev settings copied by site sync');
  assert.equal(worldOrigin({ APP_ORIGIN: 'https://play.example.org' }, manifest, 8080), 'https://play.example.org', 'explicit public origin wins');
  assert.equal(worldOrigin({}, { hosts: ['db.featheral.com'], primary: false }, 8080), 'http://world.localhost:8080');
  assert.equal(worldOrigin({}, null, 9000), 'http://world.localhost:9000', 'local development default');
  assert.equal(worldOrigin({ APP_ORIGIN: 'http://127.0.0.1:4173' }, null, 8080), 'http://127.0.0.1:4173');
});
