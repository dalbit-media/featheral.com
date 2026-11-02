// Visitor and traffic analytics for the public site, kept in public.sqlite next to votes and comments.
// The browser sends one hit per page (route) it shows, with a random visitor id kept in localStorage,
// and the referrer and UTM tags on the first page of a visit. No IPs or cookies are stored.
const SESSION_GAP_MS = 30 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const PAGES = ['swipe', 'trending', 'thumbs', 'read', 'read-post', 'liked', 'post'];

// Search engines: host pattern → query parameters that hold the search terms.
const ENGINES = [
  ['Google', /(^|\.)google\.[a-z.]+$/, ['q']],
  ['Bing', /(^|\.)bing\.com$/, ['q']],
  ['DuckDuckGo', /(^|\.)duckduckgo\.com$/, ['q']],
  ['Yahoo', /(^|\.)search\.yahoo\.[a-z.]+$|(^|\.)yahoo\.[a-z.]+$/, ['p', 'q']],
  ['Yandex', /(^|\.)yandex\.[a-z.]+$|(^|\.)ya\.ru$/, ['text']],
  ['Baidu', /(^|\.)baidu\.com$/, ['wd', 'word']],
  ['Ecosia', /(^|\.)ecosia\.org$/, ['q']],
  ['Brave', /(^|\.)search\.brave\.com$/, ['q']],
  ['Startpage', /(^|\.)startpage\.com$/, ['query', 'q']],
  ['Naver', /(^|\.)naver\.com$/, ['query']],
];
const SOCIAL = /(^|\.)(reddit\.com|redd\.it|t\.co|x\.com|twitter\.com|facebook\.com|fb\.com|instagram\.com|tiktok\.com|t\.me|telegram\.org|discord\.com|discord\.gg|pinterest\.[a-z.]+|tumblr\.com|youtube\.com|youtu\.be|linkedin\.com|vk\.com|bsky\.app|threads\.net|lemmy\.[a-z.]+|weibo\.com)$/;
const BOT = /bot|crawl|spider|slurp|headless|preview|scan|monitor|curl|wget|python|axios|node-fetch|go-http|java\//i;

const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

// Where a visit came from: channel, referring host, search engine and its search terms.
function classifyReferrer(referrer, ownHost, utm = {}) {
  let url = null;
  try { url = referrer ? new URL(referrer) : null; } catch { url = null; }
  const host = url && /^https?:$/.test(url.protocol) ? url.hostname.toLowerCase().replace(/^www\./, '') : '';
  const own = String(ownHost || '').toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  const out = { refHost: host && host !== own ? host : '', referrer: '', engine: '', term: '', channel: 'direct' };
  if (out.refHost) out.referrer = str(`${url.origin}${url.pathname}`, 300);
  const engine = out.refHost && ENGINES.find(([, re]) => re.test(out.refHost));
  if (engine) {
    out.engine = engine[0];
    for (const p of engine[2]) { const v = url.searchParams.get(p); if (v && v.trim()) { out.term = str(v.toLowerCase().replace(/\s+/g, ' '), 200); break; } }
    out.channel = 'search';
  } else if (out.refHost) out.channel = SOCIAL.test(out.refHost) ? 'social' : 'referral';
  if (utm.source || utm.medium || utm.campaign) {
    if (!out.refHost && utm.source) out.refHost = str(utm.source, 120).toLowerCase();
    if (/cpc|ppc|paid|ads?$/i.test(utm.medium || '')) out.channel = 'paid';
    else if (/e-?mail|newsletter/i.test(utm.medium || '')) out.channel = 'email';
    else if (out.channel === 'direct') out.channel = 'campaign';
  }
  return out;
}

function parseAgent(ua) {
  ua = String(ua || '');
  const bot = !ua || BOT.test(ua);
  const device = bot ? 'bot' : /iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua) ? 'tablet' : /Mobi|iPhone|iPod|Android|Windows Phone/i.test(ua) ? 'mobile' : 'desktop';
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Chrome|CriOS|Chromium/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Other';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
  return { bot, device, browser, os };
}

// "#/read/123?from=…" → { path: '/read/123', page: 'read-post' }
function routeOf(raw) {
  const p = str(raw, 300).replace(/^#/, '').split('?')[0];
  const parts = p.split('/').filter(Boolean).slice(0, 2).map((x) => x.slice(0, 60));
  const page = !parts.length ? 'swipe' : parts[0] === 'read' && parts[1] ? 'read-post' : PAGES.includes(parts[0]) ? parts[0] : 'other';
  return { path: '/' + parts.join('/'), page };
}

class Analytics {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS an_visitors (visitor TEXT PRIMARY KEY, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, session TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0, sessions INTEGER NOT NULL DEFAULT 0, bot INTEGER NOT NULL DEFAULT 0, first_channel TEXT, first_ref_host TEXT);
      CREATE TABLE IF NOT EXISTS an_hits (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, visitor TEXT NOT NULL, session TEXT NOT NULL,
        landing INTEGER NOT NULL, new_visitor INTEGER NOT NULL, path TEXT NOT NULL, page TEXT NOT NULL, channel TEXT, ref_host TEXT, referrer TEXT,
        engine TEXT, term TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, device TEXT, browser TEXT, os TEXT, lang TEXT, bot INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS an_hits_at ON an_hits (at);
      CREATE INDEX IF NOT EXISTS an_hits_session ON an_hits (session);
      CREATE TABLE IF NOT EXISTS an_searches (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, visitor TEXT NOT NULL, place TEXT NOT NULL,
        q TEXT NOT NULL, results INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS an_searches_at ON an_searches (at);
      CREATE TABLE IF NOT EXISTS an_post_views (at INTEGER NOT NULL, post_id INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS an_post_views_at ON an_post_views (at);
    `);
  }

  // One page shown to a visitor. A gap of 30 minutes starts a new session; the first hit of a session
  // keeps its referrer, search terms and UTM tags. Repeats of the same page within 3 s are ignored.
  hit(input = {}, { userAgent = '', host = '', now = Date.now() } = {}) {
    const visitor = str(input.visitor, 64);
    if (!/^[\w-]{6,64}$/.test(visitor)) return { ok: false };
    const { path, page } = routeOf(input.path);
    const agent = parseAgent(userAgent);
    const v = this.db.prepare('SELECT * FROM an_visitors WHERE visitor = ?').get(visitor);
    const landing = !v || now - v.last_at > SESSION_GAP_MS;
    if (v && !landing) {
      const last = this.db.prepare('SELECT path, at FROM an_hits WHERE session = ? ORDER BY id DESC LIMIT 1').get(v.session);
      if (last && last.path === path && now - last.at < 3000) return { ok: true, session: v.session, repeat: true };
    }
    const session = landing ? `${visitor}.${now.toString(36)}` : v.session;
    const utm = { source: str(input.utm?.source, 120), medium: str(input.utm?.medium, 60), campaign: str(input.utm?.campaign, 120) };
    const src = landing ? classifyReferrer(str(input.referrer, 1000), host, utm) : {};
    this.db.prepare(`INSERT INTO an_hits (at, visitor, session, landing, new_visitor, path, page, channel, ref_host, referrer, engine, term, utm_source, utm_medium, utm_campaign,
        device, browser, os, lang, bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(now, visitor, session, landing ? 1 : 0, v ? 0 : 1, path, page, src.channel || null, src.refHost || null, src.referrer || null, src.engine || null, src.term || null,
        landing ? utm.source || null : null, landing ? utm.medium || null : null, landing ? utm.campaign || null : null,
        agent.device, agent.browser, agent.os, str(input.lang, 16).toLowerCase() || null, agent.bot ? 1 : 0);
    if (!v) {
      this.db.prepare('INSERT INTO an_visitors (visitor, first_at, last_at, session, hits, sessions, bot, first_channel, first_ref_host) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)')
        .run(visitor, now, now, session, agent.bot ? 1 : 0, src.channel, src.refHost || null);
    } else {
      this.db.prepare('UPDATE an_visitors SET last_at = ?, session = ?, hits = hits + 1, sessions = sessions + ? WHERE visitor = ?').run(now, session, landing ? 1 : 0, visitor);
    }
    return { ok: true, session, landing };
  }

  // A search on the site. Typing "mar", "marg", "margot" in a row is one search: a refinement of the
  // visitor's previous search in the same place within 2 minutes replaces it.
  search(visitor, place, q, results, now = Date.now()) {
    visitor = str(visitor, 64) || 'anonymous';
    q = str(String(q || '').toLowerCase().replace(/\s+/g, ' '), 200);
    if (!q) return;
    const prev = this.db.prepare('SELECT id, q, at FROM an_searches WHERE visitor = ? AND place = ? ORDER BY id DESC LIMIT 1').get(visitor, place);
    if (prev && now - prev.at < 2 * 60 * 1000 && (q.startsWith(prev.q) || prev.q.startsWith(q))) {
      this.db.prepare('UPDATE an_searches SET q = ?, results = ?, at = ? WHERE id = ?').run(q, results, now, prev.id);
    } else {
      this.db.prepare('INSERT INTO an_searches (at, visitor, place, q, results) VALUES (?, ?, ?, ?, ?)').run(now, visitor, place, q, results);
    }
  }

  postView(postId, now = Date.now()) { this.db.prepare('INSERT INTO an_post_views (at, post_id) VALUES (?, ?)').run(now, postId); }

  // Everything the admin Analytics page shows, for the last `days` days (0 = all time).
  report({ days = 7, now = Date.now(), bots = false } = {}) {
    days = Math.max(0, Math.min(3650, Math.trunc(+days || 0)));
    const since = days ? now - days * DAY : 0;
    const B = bots ? '' : ' AND bot = 0';
    const all = (sql, ...args) => this.db.prepare(sql).all(...args);
    const one = (sql, ...args) => this.db.prepare(sql).get(...args);
    const W = `at >= ?${B}`;

    const t = one(`SELECT COUNT(*) AS pageviews, COUNT(DISTINCT visitor) AS visitors, COUNT(DISTINCT session) AS sessions, SUM(new_visitor) AS newVisitors FROM an_hits WHERE ${W}`, since);
    const perSession = all(`SELECT session, COUNT(*) AS n, MAX(at) - MIN(at) AS len FROM an_hits WHERE ${W} GROUP BY session`, since);
    const bounces = perSession.filter((s) => s.n === 1).length;
    const totals = {
      allTimeVisitors: one(`SELECT COUNT(*) AS n FROM an_visitors WHERE 1 = 1${B}`).n,
      allTimePageviews: one(`SELECT COUNT(*) AS n FROM an_hits WHERE 1 = 1${B}`).n,
      visitors: t.visitors, newVisitors: t.newVisitors || 0, returningVisitors: Math.max(0, t.visitors - (t.newVisitors || 0)),
      sessions: t.sessions, pageviews: t.pageviews,
      pagesPerSession: t.sessions ? +(t.pageviews / t.sessions).toFixed(2) : 0,
      bounceRate: perSession.length ? Math.round((bounces / perSession.length) * 100) : 0,
      avgSessionSec: perSession.length ? Math.round(perSession.reduce((a, s) => a + s.len, 0) / perSession.length / 1000) : 0,
      postViews: one('SELECT COUNT(*) AS n FROM an_post_views WHERE at >= ?', since).n,
      searches: one('SELECT COUNT(*) AS n FROM an_searches WHERE at >= ?', since).n,
      liveVisitors: one(`SELECT COUNT(DISTINCT visitor) AS n FROM an_hits WHERE at >= ?${B}`, now - 5 * 60 * 1000).n,
      bots: one('SELECT COUNT(*) AS n FROM an_hits WHERE at >= ? AND bot = 1', since).n,
    };

    // Hourly buckets for one day, daily otherwise (server local time).
    const hourly = days === 1;
    const bucket = hourly ? "strftime('%Y-%m-%d %H:00', at / 1000, 'unixepoch', 'localtime')" : "date(at / 1000, 'unixepoch', 'localtime')";
    const series = all(`SELECT ${bucket} AS k, COUNT(*) AS pageviews, COUNT(DISTINCT visitor) AS visitors, COUNT(DISTINCT session) AS sessions FROM an_hits WHERE ${W} GROUP BY k ORDER BY k`, since);
    const timeline = fillBuckets(series, hourly, since || (series[0] ? Date.parse(series[0].k) : now), now);

    const landing = `landing = 1 AND ${W}`;
    return {
      days, since, now, hourly, totals, timeline,
      pages: all(`SELECT page, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM an_hits WHERE ${W} GROUP BY page ORDER BY views DESC`, since),
      paths: all(`SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM an_hits WHERE ${W} GROUP BY path ORDER BY views DESC LIMIT 25`, since),
      landingPages: all(`SELECT path, COUNT(*) AS sessions FROM an_hits WHERE ${landing} GROUP BY path ORDER BY sessions DESC LIMIT 15`, since),
      channels: all(`SELECT COALESCE(channel, 'direct') AS channel, COUNT(*) AS sessions, COUNT(DISTINCT visitor) AS visitors FROM an_hits WHERE ${landing} GROUP BY 1 ORDER BY sessions DESC`, since),
      referrers: all(`SELECT ref_host AS host, COALESCE(channel, 'referral') AS channel, COUNT(*) AS sessions, COUNT(DISTINCT visitor) AS visitors, MAX(at) AS last
        FROM an_hits WHERE ${landing} AND ref_host IS NOT NULL GROUP BY ref_host ORDER BY sessions DESC LIMIT 50`, since),
      referrerUrls: all(`SELECT referrer AS url, COUNT(*) AS sessions FROM an_hits WHERE ${landing} AND referrer IS NOT NULL GROUP BY referrer ORDER BY sessions DESC LIMIT 30`, since),
      engines: all(`SELECT engine, COUNT(*) AS sessions, SUM(term IS NOT NULL) AS withTerms FROM an_hits WHERE ${landing} AND engine IS NOT NULL GROUP BY engine ORDER BY sessions DESC`, since),
      searchTerms: all(`SELECT term, GROUP_CONCAT(DISTINCT engine) AS engines, COUNT(*) AS sessions, MAX(at) AS last FROM an_hits WHERE ${landing} AND term IS NOT NULL
        GROUP BY term ORDER BY sessions DESC, last DESC LIMIT 50`, since),
      campaigns: all(`SELECT COALESCE(utm_source, '') AS source, COALESCE(utm_medium, '') AS medium, COALESCE(utm_campaign, '') AS campaign, COUNT(*) AS sessions
        FROM an_hits WHERE ${landing} AND (utm_source IS NOT NULL OR utm_medium IS NOT NULL OR utm_campaign IS NOT NULL) GROUP BY 1, 2, 3 ORDER BY sessions DESC LIMIT 30`, since),
      siteSearches: all(`SELECT q, GROUP_CONCAT(DISTINCT place) AS places, COUNT(*) AS searches, COUNT(DISTINCT visitor) AS visitors, ROUND(AVG(results)) AS results, MAX(at) AS last
        FROM an_searches WHERE at >= ? GROUP BY q ORDER BY searches DESC, last DESC LIMIT 50`, since),
      zeroResults: all(`SELECT q, GROUP_CONCAT(DISTINCT place) AS places, COUNT(*) AS searches, MAX(at) AS last FROM an_searches WHERE at >= ? AND results = 0
        GROUP BY q ORDER BY searches DESC, last DESC LIMIT 30`, since),
      devices: all(`SELECT device AS name, COUNT(DISTINCT visitor) AS visitors FROM an_hits WHERE ${W} GROUP BY device ORDER BY visitors DESC`, since),
      browsers: all(`SELECT browser AS name, COUNT(DISTINCT visitor) AS visitors FROM an_hits WHERE ${W} GROUP BY browser ORDER BY visitors DESC`, since),
      os: all(`SELECT os AS name, COUNT(DISTINCT visitor) AS visitors FROM an_hits WHERE ${W} GROUP BY os ORDER BY visitors DESC`, since),
      languages: all(`SELECT COALESCE(lang, '?') AS name, COUNT(DISTINCT visitor) AS visitors FROM an_hits WHERE ${W} GROUP BY 1 ORDER BY visitors DESC LIMIT 15`, since),
      topPosts: all('SELECT post_id AS id, COUNT(*) AS views FROM an_post_views WHERE at >= ? GROUP BY post_id ORDER BY views DESC LIMIT 25', since),
      recent: all(`SELECT at, visitor, path, COALESCE(channel, 'direct') AS channel, ref_host AS host, engine, term, device, browser, os, new_visitor AS isNew,
        (SELECT COUNT(*) FROM an_hits h2 WHERE h2.session = an_hits.session) AS pages FROM an_hits WHERE ${landing} ORDER BY at DESC LIMIT 40`, since),
    };
  }
}

function fillBuckets(rows, hourly, from, to) {
  const by = new Map(rows.map((r) => [r.k, r]));
  const out = [];
  const pad = (n) => String(n).padStart(2, '0');
  const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}${hourly ? ` ${pad(d.getHours())}:00` : ''}`;
  const d = new Date(from);
  if (hourly) d.setMinutes(0, 0, 0); else d.setHours(0, 0, 0, 0);
  for (let i = 0; d.getTime() <= to && i < 4000; i++) {
    const k = key(d);
    out.push(by.get(k) || { k, pageviews: 0, visitors: 0, sessions: 0 });
    if (hourly) d.setHours(d.getHours() + 1); else d.setDate(d.getDate() + 1);
  }
  return out;
}

module.exports = { Analytics, classifyReferrer, parseAgent, routeOf, SESSION_GAP_MS };
