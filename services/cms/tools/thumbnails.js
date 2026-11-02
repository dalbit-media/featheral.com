#!/usr/bin/env node
// Moves every published post whose image is small (longest side under --max-side pixels, GIFs
// excluded) into the "Thumbnails" category. Those posts leave the swipe deck and appear in the
// public thumbnail gallery. Safe to run again; already moved posts are skipped.
//
//   node tools/thumbnails.js [set-key] [--dry-run] [--max-side=640]
//
// Stop the server first; it caches the data set in memory.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../lib/store');
const { getSite, dropSite } = require('../lib/wp');
const { PublicSite, THUMB_MAX_SIDE } = require('../lib/public');
const { moveToThumbnails } = require('../lib/thumbnails');

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const maxSide = Number((args.find((a) => a.startsWith('--max-side=')) || `--max-side=${THUMB_MAX_SIDE}`).split('=')[1]);
const key = args.find((a) => !a.startsWith('--')) || JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'admin.config.json'), 'utf8')).siteKey;

const pub = new PublicSite(getSite(key));
const ids = pub.smallImagePosts(maxSide);
pub.close();
dropSite(key);
console.log(`${ids.length} posts have an image under ${maxSide}px${dry ? ' (dry run)' : ''}`);
if (!dry && ids.length) {
  const r = moveToThumbnails(path.join(DATA_DIR, key, 'db.sqlite'), ids);
  console.log(`moved ${r.moved} posts; the Thumbnails category now has ${r.total} posts`);
}
