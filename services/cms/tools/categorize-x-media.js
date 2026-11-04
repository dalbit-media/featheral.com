#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('../lib/store');
const { getSite, dropSite } = require('../lib/wp');
const { categorizeUncategorized } = require('../lib/reading-categories');

const args = process.argv.slice(2);
const backup = args.find(arg => arg.startsWith('--backup-file='));
if (args.some(arg => arg !== '--apply' && !arg.startsWith('--backup-file='))) throw new Error('Use [--apply --backup-file=<new absolute path>]');
const records = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sites.json'), 'utf8'));
const record = records.find(site => site.hostname === 'x.featheral.com' && !site.path);
if (!record) throw new Error('Featheral X is not registered');
const site = getSite(record.key);
try {
  console.log(JSON.stringify(categorizeUncategorized(site, { apply: args.includes('--apply'), backupFile: backup?.slice('--backup-file='.length) })));
} finally { dropSite(record.key); }
