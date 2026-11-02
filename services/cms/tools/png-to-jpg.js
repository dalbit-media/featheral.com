#!/usr/bin/env node
// Converts every PNG still in a data set's uploads folder to JPG and rewrites all local references:
// attachment file/metadata/mime/guid, post bodies, uploads-index.json and the public site's votes.
// PNGs that belong to trashed posts (in <set>/trash) are left alone so Restore keeps working.
//
//   node tools/png-to-jpg.js [set-key] [--dry-run] [--quality=90]
//
// Stop the server first; it caches the data set in memory. Needs Python with Pillow.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { open } = require('../../db-api/sqlite');
const { DATA_DIR } = require('../lib/store');
const { unserialize, serialize } = require('../lib/phpser');

const ENCODER = String.raw`
import sys, json
from PIL import Image
out = []
for src, dst, quality in json.load(sys.stdin):
    try:
        im = Image.open(src)
        im.load()
        if im.mode in ('RGBA', 'LA', 'PA') or (im.mode == 'P' and 'transparency' in im.info):
            rgba = im.convert('RGBA')
            flat = Image.new('RGB', rgba.size, (255, 255, 255))
            flat.paste(rgba, mask=rgba.getchannel('A'))
            im = flat
        else:
            im = im.convert('RGB')
        im.save(dst, 'JPEG', quality=quality, optimize=True)
        out.append({'src': src, 'ok': True})
    except Exception as e:
        out.append({'src': src, 'ok': False, 'error': str(e)})
json.dump(out, sys.stdout)
`;

const toJpg = (rel) => rel.replace(/\.png$/i, '.jpg');

function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const quality = Number((args.find((a) => a.startsWith('--quality=')) || '--quality=90').split('=')[1]);
  const key = args.find((a) => !a.startsWith('--')) || JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'admin.config.json'), 'utf8')).siteKey;
  const dir = path.join(DATA_DIR, key);
  const uploads = path.join(dir, 'uploads');
  const db = open(path.join(dir, 'db.sqlite'));
  const P = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%posts'").all().map((r) => r.name).find((n) => !/meta$/.test(n));
  const M = P.replace(/posts$/, 'postmeta');

  // Every PNG file still in uploads, and the attachments pointing at it.
  const indexPath = path.join(dir, 'uploads-index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const jobs = new Map();
  for (const x of index) {
    if (!/\.png$/i.test(x.path) || !fs.existsSync(path.join(uploads, x.path))) continue;
    let rel = toJpg(x.path);
    for (let n = 1; fs.existsSync(path.join(uploads, rel)); n++) rel = x.path.replace(/\.png$/i, `-${n}.jpg`);
    jobs.set(x.path, rel);
  }
  const atts = db.prepare(`SELECT p.ID, p.guid, (SELECT meta_value FROM ${M} WHERE post_id = p.ID AND meta_key = '_wp_attached_file') AS file,
      (SELECT meta_value FROM ${M} WHERE post_id = p.ID AND meta_key = '_wp_attachment_metadata') AS meta
    FROM ${P} p WHERE p.post_type = 'attachment'`).all().filter((a) => jobs.has(a.file));
  console.log(`${jobs.size} PNG files in uploads, used by ${atts.length} attachments${dry ? ' (dry run)' : ''}`);
  if (dry || !jobs.size) return;

  const list = [...jobs].map(([src, dst]) => [path.join(uploads, src), path.join(uploads, dst), quality]);
  const run = spawnSync('python', ['-c', ENCODER], { input: JSON.stringify(list), maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`Encoder failed: ${run.stderr}`);
  const failed = JSON.parse(run.stdout).filter((r) => !r.ok);
  for (const f of failed) {
    console.warn(`skipped ${f.src}: ${f.error}`);
    const rel = path.relative(uploads, f.src).split(path.sep).join('/');
    fs.rmSync(path.join(uploads, jobs.get(rel)), { force: true });
    jobs.delete(rel);
  }
  const sizes = new Map([...jobs].map(([src, dst]) => [src, { before: fs.statSync(path.join(uploads, src)).size, after: fs.statSync(path.join(uploads, dst)).size }]));

  const variantRenames = new Map();
  try {
    db.exec('BEGIN');
    const setMeta = db.prepare(`UPDATE ${M} SET meta_value = ? WHERE post_id = ? AND meta_key = ?`);
    const setPost = db.prepare(`UPDATE ${P} SET post_mime_type = 'image/jpeg', guid = ? WHERE ID = ?`);
    for (const a of atts) {
      const rel = jobs.get(a.file);
      if (!rel) continue;
      const folder = a.file.includes('/') ? a.file.slice(0, a.file.lastIndexOf('/') + 1) : '';
      setMeta.run(rel, a.ID, '_wp_attached_file');
      setPost.run(String(a.guid || '').replace(a.file, rel).replace(/\.png$/i, '.jpg'), a.ID);
      let md = null;
      try { md = a.meta ? unserialize(a.meta) : null; } catch {}
      if (md && typeof md === 'object') {
        md.file = rel;
        md.filesize = sizes.get(a.file).after;
        for (const s of Object.values(md.sizes || {})) {
          if (!s || !/\.png$/i.test(s.file || '')) continue;
          const renamed = s.file === path.posix.basename(a.file) ? path.posix.basename(rel) : toJpg(s.file);
          variantRenames.set(folder + s.file, folder + renamed);
          s.file = renamed;
          s['mime-type'] = 'image/jpeg';
          if (renamed === path.posix.basename(rel)) s.filesize = sizes.get(a.file).after;
        }
        if (/\.png$/i.test(md.original_image || '')) md.original_image = toJpg(md.original_image);
        setMeta.run(serialize(md), a.ID, '_wp_attachment_metadata');
      }
    }
    // Local references in post bodies (WordPress-hosted URLs end in /uploads/<rel>).
    const renames = new Map([...variantRenames, ...jobs]);
    let bodies = 0;
    for (const [from, to] of renames) {
      for (const col of ['post_content', 'post_excerpt']) {
        bodies += Number(db.prepare(`UPDATE ${P} SET ${col} = REPLACE(${col}, ?, ?) WHERE ${col} LIKE ?`).run(`uploads/${from}`, `uploads/${to}`, `%uploads/${from}%`).changes);
      }
    }
    db.exec('COMMIT');
    console.log(`updated ${atts.length} attachments and ${bodies} post bodies`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    for (const dst of jobs.values()) fs.rmSync(path.join(uploads, dst), { force: true });
    throw e;
  } finally { db.close(); }

  const now = new Date().toISOString();
  for (const x of index) {
    const rel = jobs.get(x.path);
    if (!rel) continue;
    Object.assign(x, { path: rel, ext: 'jpg', size: sizes.get(x.path).after, mtime: now });
  }
  fs.writeFileSync(indexPath, JSON.stringify(index));
  for (const src of jobs.keys()) fs.rmSync(path.join(uploads, src), { force: true });

  // Reviews of the converted posts carry over to the JPG deck; trashed PNG posts keep theirs.
  const pubPath = path.join(dir, 'public.sqlite');
  if (fs.existsSync(pubPath)) {
    const pub = open(pubPath);
    try {
      const live = pub.prepare("SELECT 1 FROM sqlite_master WHERE name = 'trash'").get() ? 'post_id NOT IN (SELECT post_id FROM trash)' : '1';
      const moved = pub.prepare(`UPDATE OR IGNORE votes SET type = 'jpeg' WHERE type = 'png' AND ${live}`).run().changes;
      pub.prepare(`DELETE FROM votes WHERE type = 'png' AND ${live}`).run();
      console.log(`moved ${moved} PNG votes to the JPG deck`);
    } finally { pub.close(); }
  }
  const before = [...sizes.values()].reduce((s, x) => s + x.before, 0);
  const after = [...sizes.values()].reduce((s, x) => s + x.after, 0);
  console.log(`converted ${jobs.size} files: ${(before / 1048576).toFixed(1)} MB PNG -> ${(after / 1048576).toFixed(1)} MB JPG${failed.length ? `, ${failed.length} failed` : ''}`);
}

main();
