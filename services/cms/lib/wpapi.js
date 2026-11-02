const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const UA = 'Mozilla/5.0 (compatible; WP-Content-Explorer/2.0; +https://wordpress.org)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter a site URL');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  u.hash = '';
  u.search = '';
  return u.toString().replace(/\/+$/, '');
}

class WpApi {
  constructor({ url, username, appPassword, timeout = 60000 } = {}) {
    this.siteUrl = normalizeUrl(url);
    this.username = (username || '').trim();
    this.auth = this.username && appPassword ? 'Basic ' + Buffer.from(`${this.username}:${String(appPassword).trim()}`).toString('base64') : null;
    this.timeout = timeout;
    this.root = null;
    this.pretty = true;
    this.requests = 0;
  }

  get authenticated() { return !!this.auth; }

  headers(target) {
    const h = { 'User-Agent': UA, Accept: 'application/json, */*;q=0.5' };
    if (this.auth && target && this.root && new URL(target).origin === new URL(this.root).origin) h.Authorization = this.auth;
    return h;
  }

  async fetchRaw(url, { retries = 3, method = 'GET', auth = true, accept } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeout);
      try {
        this.requests++;
        const headers = auth ? this.headers(url) : { 'User-Agent': UA };
        if (accept) headers.Accept = accept;
        const res = await fetch(url, { method, headers, signal: ctrl.signal, redirect: 'follow' });
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          const ra = +res.headers.get('retry-after');
          await res.body?.cancel().catch(() => {});
          await sleep(ra ? Math.min(ra, 30) * 1000 : 1000 * 2 ** attempt);
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e.name === 'AbortError' ? new Error(`Timed out after ${this.timeout / 1000}s: ${url}`) : e;
        if (attempt < retries) await sleep(1000 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  buildUrl(route, params = {}) {
    const r = '/' + String(route).replace(/^\/+/, '');
    let url;
    if (this.pretty) url = new URL(this.root.replace(/\/+$/, '') + r);
    else { url = new URL(this.root); url.searchParams.set('rest_route', r); }
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    return url.toString();
  }

  async discover() {
    if (this.root) return this.root;
    const candidates = [];
    try {
      const res = await this.fetchRaw(this.siteUrl + '/', { retries: 1, method: 'HEAD', auth: false });
      const link = res.headers.get('link') || '';
      const m = /<([^>]+)>\s*;\s*rel="https:\/\/api\.w\.org\/"/.exec(link);
      if (m) candidates.push(m[1]);
    } catch {}
    candidates.push(this.siteUrl + '/wp-json/', this.siteUrl + '/?rest_route=/');
    const errors = [];
    for (const c of [...new Set(candidates)]) {
      const pretty = !/[?&]rest_route=/.test(c);
      const root = pretty ? c.replace(/\/?$/, '/') : c.replace(/([?&])rest_route=[^&]*/, '$1').replace(/[?&]$/, '');
      try {
        const testUrl = pretty ? root : root + (root.includes('?') ? '&' : '?') + 'rest_route=/';
        const res = await this.fetchRaw(testUrl, { retries: 1, auth: false });
        const type = res.headers.get('content-type') || '';
        if (!res.ok || !type.includes('json')) { errors.push(`${testUrl} → HTTP ${res.status}`); await res.body?.cancel().catch(() => {}); continue; }
        const body = await res.json();
        if (!body || !Array.isArray(body.namespaces)) { errors.push(`${testUrl} → not a WordPress REST index`); continue; }
        this.root = pretty ? root : root.replace(/[?&]$/, '');
        this.pretty = pretty;
        this.index = body;
        return this.root;
      } catch (e) { errors.push(`${c} → ${e.message}`); }
    }
    throw new Error('Could not find the WordPress REST API.\n' + errors.join('\n'));
  }

  async request(route, params = {}) {
    await this.discover();
    const url = this.buildUrl(route, params);
    const res = await this.fetchRaw(url);
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const msg = data && data.message ? data.message.replace(/<[^>]+>/g, '') : `HTTP ${res.status}`;
      throw new ApiError(`${route}: ${msg}`, res.status, data && data.code);
    }
    if (data === null && text) throw new ApiError(`${route}: response is not JSON (security plugin or firewall?)`, res.status, 'not_json');
    return { data, total: +res.headers.get('x-wp-total') || null, pages: +res.headers.get('x-wp-totalpages') || null };
  }

  async get(route, params) { return (await this.request(route, params)).data; }

  async count(route, params = {}) {
    const r = await this.request(route, { ...params, per_page: 1, _fields: 'id' });
    return r.total ?? (Array.isArray(r.data) ? r.data.length : 0);
  }

  async getAll(route, params = {}, onPage, max = 0) {
    const out = [];
    let page = 1;
    let pages = 1;
    let total = null;
    const perPage = max && max < 100 ? max : 100;
    do {
      let r;
      try {
        r = await this.request(route, { per_page: perPage, ...params, page });
      } catch (e) {
        if (page > 1 && e.code === 'rest_post_invalid_page_number') break;
        throw e;
      }
      if (!Array.isArray(r.data)) {
        // Some endpoints (e.g. /types, /taxonomies) return keyed objects
        if (r.data && typeof r.data === 'object') return Object.values(r.data);
        break;
      }
      out.push(...r.data);
      pages = r.pages || (r.data.length >= perPage ? page + 1 : page);
      total = r.total ?? total;
      if (max && out.length >= max) { out.length = max; pages = page; }
      if (onPage) onPage({ page, pages, count: out.length, total: max && total ? Math.min(total, max) : total });
      if (!r.data.length) break;
      page++;
    } while (page <= pages);
    return out;
  }

  // Streams a file to disk; skips existing files whose size matches (or is non-empty when size is unknown).
  async download(url, dest, { expectedSize } = {}) {
    try {
      const st = fs.statSync(dest);
      if (st.size > 0 && (!expectedSize || st.size === expectedSize)) return { skipped: true, size: st.size };
    } catch {}
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const res = await this.fetchRaw(url, { accept: '*/*' });
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new ApiError(`HTTP ${res.status}`, res.status); }
    const tmp = dest + '.part';
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
    return { skipped: false, size: fs.statSync(dest).size };
  }
}

module.exports = { WpApi, ApiError, normalizeUrl };
