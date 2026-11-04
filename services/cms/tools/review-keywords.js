#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, setDir } = require('../lib/store');
const { reviewKeywords } = require('../lib/keyword-review');

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply' && !arg.startsWith('--backup-file=')))
  throw new Error('Use [--apply --backup-file=<new absolute SQLite path>]');
const records = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sites.json'), 'utf8'));
const record = records.find(site => site.hostname === 'x.featheral.com' && !site.path);
if (!record) throw new Error('Featheral X is not registered');
console.log(JSON.stringify(reviewKeywords(path.join(setDir(record.key), 'db.sqlite'), {
  apply: args.includes('--apply'),
  backupFile: args.find(arg => arg.startsWith('--backup-file='))?.slice('--backup-file='.length),
}), null, 2));
