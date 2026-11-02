const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite = require('../../db-api/sqlite');
const { Telemetry } = require('../lib/telemetry');
const { Notes } = require('../../notes-api/ledger');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('standalone CMS and Notes connections share the db-api SQLite manager', () => {
  const baseline = sqlite.activeConnections;
  const telemetry = new Telemetry(':memory:');
  let notes;
  try {
    assert.equal(sqlite.activeConnections, baseline + 1);
    notes = new Notes(':memory:');
    assert.equal(sqlite.activeConnections, baseline + 2);
    assert.equal(telemetry.db.prepare('SELECT 1 AS value').get().value, 1);
    assert.equal(notes.db.prepare('SELECT 1 AS value').get().value, 1);
    notes.close();
    assert.equal(sqlite.activeConnections, baseline + 1);
    telemetry.close();
    assert.equal(sqlite.activeConnections, baseline);
  } finally {
    if (notes) notes.close();
    telemetry.close();
  }
});

test('CMS shutdown closes remaining managed connections after service cleanup', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const shutdown = source.match(/app\.close = \(\) => \{[\s\S]*?\n\};/)[0];
  const order = [];
  const app = {};
  const remaining = sqlite.open(':memory:');
  const context = {
    app,
    telemetry: { close: () => order.push('telemetry') },
    sitePages: { close: () => order.push('pages') },
    publicCache: new Map([['site', { close: () => order.push('public') }]]),
    notes: { close: () => order.push('notes') },
    listLibrary: () => [{ key: 'library' }],
    dropSite: key => order.push(key),
    database: { sqlite },
  };
  try {
    vm.runInNewContext(shutdown, context);
    app.close();
    assert.deepEqual(order, ['telemetry', 'pages', 'public', 'notes', 'library']);
    assert.equal(context.publicCache.size, 0);
    assert.equal(sqlite.activeConnections, 0);
    assert.throws(() => remaining.prepare('SELECT 1'));
    sqlite.closeAll();
    assert.equal(sqlite.activeConnections, 0);
  } finally { remaining.close(); }
});
