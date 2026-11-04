const fs = require('node:fs/promises');
const sharp = require('sharp');

const cache = new Map(), pending = new Map(), queue = [];
let bytes = 0, active = 0;
const MAX_BYTES = 16 * 1024 * 1024;
sharp.cache({ memory: 16, files: 0, items: 32 });

function drain() {
  while (active < 2 && queue.length) {
    const task = queue.shift();
    active++;
    task.run().then(task.resolve, task.reject).finally(() => { active--; drain(); });
  }
}

async function mediaPreview(file) {
  const stat = await fs.stat(file);
  const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (cache.has(key)) {
    const value = cache.get(key);
    cache.delete(key); cache.set(key, value);
    return value;
  }
  if (pending.has(key)) return pending.get(key);
  if (queue.length >= 32) throw Object.assign(new Error('Preview service is busy. Retry shortly.'), { status: 503 });
  const result = new Promise((resolve, reject) => {
    queue.push({ resolve, reject, run: async () => {
      const buffer = await sharp(file, { animated: false, limitInputPixels: 128 * 1024 * 1024 })
        .timeout({ seconds: 15 }).rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 72, effort: 2 }).toBuffer();
      while (cache.size && (bytes + buffer.length > MAX_BYTES || cache.size >= 256)) {
        const oldest = cache.keys().next().value;
        bytes -= cache.get(oldest).length; cache.delete(oldest);
      }
      if (buffer.length <= MAX_BYTES) { cache.set(key, buffer); bytes += buffer.length; }
      return buffer;
    } });
  });
  pending.set(key, result);
  drain();
  try { return await result; } finally { pending.delete(key); }
}

module.exports = { mediaPreview };
