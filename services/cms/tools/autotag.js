#!/usr/bin/env node
// Adds keyword tags (post_tag) to every published post from its title [labels], JAV code series
// and TF-IDF keywords of the title and text (no subreddit tags). Keywords must be proper nouns or
// topical words; generic words are dropped. Longer posts get more tags (up to
// 30); tags on fewer than 10 posts are dropped. Rerunning replaces earlier auto tags; hand-made tags are kept.
//
//   node tools/autotag.js [set-key] [--dry-run] [--sample=10]
//
// Stop the server first; it caches the data set in memory.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../lib/store');
const { autotag } = require('../lib/autotag');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sample = Number((args.find((a) => a.startsWith('--sample=')) || '--sample=0').split('=')[1]);
const key = args.find((a) => !a.startsWith('--')) || JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'admin.config.json'), 'utf8')).siteKey;

const t0 = Date.now();
const r = autotag(path.join(DATA_DIR, key, 'db.sqlite'), { dryRun });
if (sample) {
  const posts = r.sample;
  for (let i = 0; i < sample; i++) {
    const p = posts[Math.floor(Math.random() * posts.length)];
    console.log(`#${p.id} (${p.content.length} chars) ${p.title.slice(0, 90)}\n   ${r.byPost.get(p.id).join(', ')}`);
  }
}
const counts = [...r.byPost.values()].map((t) => t.length).sort((a, b) => a - b);
console.log(`${dryRun ? '(dry run) ' : ''}${r.posts} posts, ${r.tags} tags, ${r.links} post-tag links${r.removed ? `, replaced ${r.removed} old auto tags` : ''}`);
console.log(`tags per post: min ${counts[0]}, median ${counts[counts.length >> 1]}, max ${counts[counts.length - 1]} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
