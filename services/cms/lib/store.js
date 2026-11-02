const fs = require('fs');
const path = require('path');
const { imageSize } = require('./imagesize');

const storage = path.join(__dirname, '..', 'data');
fs.mkdirSync(storage, { recursive: true });
const DATA_DIR = fs.realpathSync(storage);

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|svg|avif|ico|tiff?|heic)$/i;
const SIZE_VARIANT = /-(\d+)x(\d+)(@2x)?\.[a-z0-9]+$/i;
const SCALED_VARIANT = /-(scaled|rotated)(?=\.[a-z0-9]+$)/i;

function setDir(key) {
  if (!/^[\w-]+$/.test(key)) throw new Error('Invalid site key');
  return path.join(DATA_DIR, key);
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data));
}

function listLibrary() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .map((k) => readJson(path.join(DATA_DIR, k, 'manifest.json')))
    .filter(Boolean)
    .sort((a, b) => String(b.syncedAt || b.date || '').localeCompare(String(a.syncedAt || a.date || '')));
}

function walkDir(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let items;
    try { items = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const r = rel ? rel + '/' + it.name : it.name;
      if (it.isDirectory()) stack.push(r);
      else if (it.isFile() && !it.name.endsWith('.part')) out.push(r);
    }
  }
  return out.sort();
}

function buildUploadsIndex(uploadsDir) {
  const files = walkDir(uploadsDir);
  const set = new Set(files);
  return files.map((rel) => {
    const st = fs.statSync(path.join(uploadsDir, rel));
    const ext = (path.extname(rel).slice(1) || '').toLowerCase();
    const isImage = IMAGE_EXT.test(rel);
    const item = { path: rel, size: st.size, mtime: st.mtime.toISOString(), ext, image: isImage };
    const dm = /^(\d{4})\/(\d{2})\//.exec(rel);
    if (dm) { item.year = dm[1]; item.month = dm[2]; }
    else item.folder = rel.includes('/') ? rel.split('/')[0] : '(root)';
    if (isImage) {
      const v = SIZE_VARIANT.exec(rel);
      if (v) {
        const orig = rel.replace(SIZE_VARIANT, path.extname(rel));
        const scaled = orig.replace(/(\.[a-z0-9]+)$/i, '-scaled$1');
        if (set.has(orig) || set.has(scaled)) item.variantOf = set.has(orig) ? orig : scaled;
      } else if (SCALED_VARIANT.test(rel)) {
        const orig = rel.replace(SCALED_VARIANT, '');
        if (set.has(orig)) item.variantOf = orig;
      }
      if (!/svg$/i.test(ext)) {
        const dim = imageSize(path.join(uploadsDir, rel));
        if (dim) { item.width = dim.width; item.height = dim.height; }
      }
    }
    return item;
  });
}

module.exports = { DATA_DIR, setDir, readJson, writeJson, listLibrary, buildUploadsIndex };
