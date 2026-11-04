#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, setDir } = require('../lib/store');
const { tagCelebrities } = require('../lib/autotag');

const args = process.argv.slice(2);
if (args.some(arg => arg.startsWith('--') && arg !== '--apply' && !arg.startsWith('--backup-file='))
    || args.filter(arg => !arg.startsWith('--')).length > 1)
  throw new Error('Use [siteKey] [--apply --backup-file=<new absolute SQLite path>]');
let key = args.find(arg => !arg.startsWith('--'));
if (!key) {
  const records = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sites.json'), 'utf8'));
  key = records.find(site => site.hostname === 'x.featheral.com' && !site.path)?.key;
}
if (!key) throw new Error('Featheral X is not registered; supply a site key');
console.log(JSON.stringify(tagCelebrities(path.join(setDir(key), 'db.sqlite'), {
  apply: args.includes('--apply'),
  backupFile: args.find(arg => arg.startsWith('--backup-file='))?.slice('--backup-file='.length),
}), null, 2));
