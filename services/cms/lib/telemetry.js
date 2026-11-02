const { open } = require('../../db-api/sqlite');
const HOUR = 3600000;
const MINUTE = 60000;
const colors = require('../../../shared/site-colors.json');
class Telemetry {
  constructor(file) {
    this.db = open(file);
    this.db.exec('CREATE TABLE IF NOT EXISTS traffic_hourly(host TEXT NOT NULL, hour INTEGER NOT NULL, views INTEGER NOT NULL, PRIMARY KEY(host,hour))');
    this.db.exec('CREATE TABLE IF NOT EXISTS traffic_minutely(host TEXT NOT NULL, minute INTEGER NOT NULL, views INTEGER NOT NULL, PRIMARY KEY(host,minute))');
  }
  hit(host, now = Date.now()) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO traffic_hourly VALUES (?,?,1) ON CONFLICT(host,hour) DO UPDATE SET views=views+1')
        .run(host, Math.floor(now / HOUR) * HOUR);
      this.db.prepare('INSERT INTO traffic_minutely VALUES (?,?,1) ON CONFLICT(host,minute) DO UPDATE SET views=views+1')
        .run(host, Math.floor(now / MINUTE) * MINUTE);
      this.db.prepare('DELETE FROM traffic_minutely WHERE minute<?').run(Math.floor(now / MINUTE) * MINUTE - 59 * MINUTE);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  report(hosts, now = Date.now()) {
    const end = Math.floor(now / HOUR) * HOUR;
    const day = Math.floor(now / (24 * HOUR)) * 24 * HOUR;
    const minute = Math.floor(now / MINUTE) * MINUTE;
    return { now, timezone: 'UTC', sites: hosts.map(host => {
      const rows = this.db.prepare('SELECT hour,views FROM traffic_hourly WHERE host=? AND hour>=? AND hour<=?').all(host, day - 29 * 24 * HOUR, end);
      const minutes = this.db.prepare('SELECT minute,views FROM traffic_minutely WHERE host=? AND minute>=? AND minute<=?').all(host, minute - 59 * MINUTE, minute);
      const minutely = Array.from({ length: 60 }, (_, i) => {
        const at = minute - (59 - i) * MINUTE;
        return { at, views: minutes.find(row => row.minute === at)?.views || 0 };
      });
      const hourly = Array.from({ length: 24 }, (_, i) => {
        const at = end - (23 - i) * HOUR;
        return { at, views: rows.find(row => row.hour === at)?.views || 0 };
      });
      const daily = Array.from({ length: 30 }, (_, i) => {
        const at = day - (29 - i) * 24 * HOUR;
        return { at, views: rows.filter(row => row.hour >= at && row.hour < at + 24 * HOUR).reduce((sum, row) => sum + row.views, 0) };
      });
      const hostname = host.split('/')[0];
      const palette = colors[hostname];
      const name = hostname.split('.')[0];
      return { hostname: host, minutely, hourly, daily,
        color: palette?.color || '#64748b',
        favicon: palette ? hostname === 'featheral.com' ? '/shared/logo.svg' : `/shared/logo-${name}.svg` : '/shared/logo.svg' };
    }) };
  }
  close() { this.db.close(); }
}
function injectTelemetry(res) {
  if (res.featheralTelemetry) return;
  res.featheralTelemetry = true;
  const write = res.write.bind(res), end = res.end.bind(res);
  let chunks = [];
  const html = () => String(res.getHeader('Content-Type') || '').includes('text/html') && res.statusCode === 200;
  const writeHead = res.writeHead?.bind(res);
  if (writeHead) res.writeHead = (status, message, headers) => {
    const values = typeof message === 'string' ? headers : message;
    if (Array.isArray(values)) {
      for (let i = 0; i < values.length; i += 2) res.setHeader(values[i], values[i + 1]);
    } else {
      for (const [name, value] of Object.entries(values || {})) res.setHeader(name, value);
    }
    res.statusCode = status;
    if (typeof message === 'string') res.statusMessage = message;
    return html() ? res : writeHead(status);
  };
  res.write = (chunk, encoding, callback) => {
    if (!html()) return write(chunk, encoding, callback);
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined));
    if (typeof encoding === 'function') encoding(); else if (callback) callback();
    return true;
  };
  res.end = (chunk, encoding, callback) => {
    if (!html()) return end(chunk, encoding, callback);
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined));
    const content = Buffer.concat(chunks).toString('utf8');
    chunks = [];
    const scripts = ['telemetry', 'scroll-top', 'site-links'].filter(name => !content.includes(`src="/shared/${name}.js"`))
      .map(name => `<script src="/shared/${name}.js" defer></script>`).join('');
    const styled = content.includes('href="/shared/site-links.css"') ? content
      : content.replace(/<\/head>/i, '<link rel="stylesheet" href="/shared/site-links.css"></head>');
    const body = /<\/body>/i.test(styled) ? styled.replace(/<\/body>/i, scripts + '</body>') : styled + scripts;
    res.removeHeader('Content-Length');
    res.removeHeader('ETag');
    if (writeHead) res.writeHead = writeHead;
    return end(body, typeof encoding === 'function' ? encoding : callback);
  };
}
module.exports = { Telemetry, injectTelemetry };
