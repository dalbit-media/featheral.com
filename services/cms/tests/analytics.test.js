const assert = require('node:assert/strict');
const { test } = require('node:test');
const { open } = require('../../db-api/sqlite');
const { Analytics, classifyReferrer, parseAgent, routeOf } = require('../lib/analytics');

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

test('referrers are sorted into search, social, referral, campaign and direct with search terms', () => {
  assert.deepEqual(classifyReferrer('https://www.bing.com/search?q=Margot++Robbie&form=QBLH', 'qp.test'),
    { refHost: 'bing.com', referrer: 'https://www.bing.com/search', engine: 'Bing', term: 'margot robbie', channel: 'search' });
  const g = classifyReferrer('https://www.google.com/', 'qp.test');
  assert.equal(g.engine, 'Google'); assert.equal(g.term, ''); assert.equal(g.channel, 'search');
  assert.equal(classifyReferrer('https://search.yahoo.com/search?p=korean+model', 'x').term, 'korean model');
  assert.equal(classifyReferrer('https://yandex.ru/search/?text=cosplay', 'x').term, 'cosplay');
  assert.equal(classifyReferrer('https://old.reddit.com/r/pics/comments/1', 'x').channel, 'social');
  assert.equal(classifyReferrer('https://t.co/abc', 'x').channel, 'social');
  assert.deepEqual(classifyReferrer('https://blog.example.org/post?id=1#x', 'x'), { refHost: 'blog.example.org', referrer: 'https://blog.example.org/post', engine: '', term: '', channel: 'referral' });
  assert.equal(classifyReferrer('https://qp.test/#/thumbs', 'qp.test:443').channel, 'direct', 'own site is not a referrer');
  assert.equal(classifyReferrer('', 'x').channel, 'direct');
  assert.equal(classifyReferrer('not a url', 'x').channel, 'direct');
  const c = classifyReferrer('', 'x', { source: 'Newsletter', medium: 'email', campaign: 'oct' });
  assert.deepEqual([c.channel, c.refHost], ['email', 'newsletter']);
  assert.equal(classifyReferrer('', 'x', { source: 'reddit', campaign: 'launch' }).channel, 'campaign');
  assert.equal(classifyReferrer('https://reddit.com/', 'x', { source: 'reddit', medium: 'cpc' }).channel, 'paid');
});

test('user agents and routes', () => {
  assert.deepEqual(parseAgent(CHROME), { bot: false, device: 'desktop', browser: 'Chrome', os: 'Windows' });
  assert.deepEqual(parseAgent(IPHONE), { bot: false, device: 'mobile', browser: 'Safari', os: 'iOS' });
  assert.equal(parseAgent('Mozilla/5.0 (compatible; Googlebot/2.1)').bot, true);
  assert.equal(parseAgent('').bot, true);
  assert.deepEqual(routeOf('#/read/123?from=/read'), { path: '/read/123', page: 'read-post' });
  assert.deepEqual(routeOf('#/'), { path: '/', page: 'swipe' });
  assert.deepEqual(routeOf('#/trending?tag=5'), { path: '/trending', page: 'trending' });
  assert.equal(routeOf('#/wp-admin/x').page, 'other');
});

test('hits make visitors and sessions; the report counts traffic, sources and searches', () => {
  const a = new Analytics(open(':memory:'));
  const t0 = Date.UTC(2026, 9, 1, 12);
  const min = 60 * 1000;
  const env = (now, ua = CHROME) => ({ userAgent: ua, host: 'qp.test', now });

  assert.equal(a.hit({ visitor: 'bad id!', path: '#/' }, env(t0)).ok, false);
  // Visitor A: lands from Bing, browses 3 pages, comes back 2 hours later directly.
  const s1 = a.hit({ visitor: 'visitorA', path: '#/', referrer: 'https://www.bing.com/search?q=margot+robbie' }, env(t0));
  assert.equal(s1.landing, true);
  assert.equal(a.hit({ visitor: 'visitorA', path: '#/', referrer: 'https://www.bing.com/' }, env(t0 + 1000)).repeat, true, 'same page re-rendered is one view');
  assert.equal(a.hit({ visitor: 'visitorA', path: '#/trending' }, env(t0 + min)).session, s1.session);
  a.hit({ visitor: 'visitorA', path: '#/read/7' }, env(t0 + 2 * min));
  const s2 = a.hit({ visitor: 'visitorA', path: '#/thumbs' }, env(t0 + 120 * min));
  assert.notEqual(s2.session, s1.session, 'a 30-minute gap starts a new visit');
  // Visitor B: one page from reddit with a campaign tag, on a phone.
  a.hit({ visitor: 'visitorB', path: '#/trending', referrer: 'https://www.reddit.com/r/x', utm: { source: 'reddit', campaign: 'launch' } }, env(t0 + 3 * min, IPHONE));
  // A crawler.
  a.hit({ visitor: 'crawler1', path: '#/' }, env(t0 + 4 * min, 'Googlebot/2.1'));

  // Typing in the search box: prefixes of one search collapse into the final query.
  a.search('visitorA', 'trending', 'mar', 50, t0 + min);
  a.search('visitorA', 'trending', 'margot', 20, t0 + min + 900);
  a.search('visitorA', 'trending', 'Margot  Robbie', 19, t0 + min + 1800);
  a.search('visitorB', 'trending', 'margot robbie', 19, t0 + 3 * min);
  a.search('visitorB', 'read', 'xyzzy', 0, t0 + 4 * min);
  a.postView(7, t0 + 2 * min); a.postView(7, t0 + 3 * min); a.postView(9, t0 + 3 * min);

  const r = a.report({ days: 0, now: t0 + 125 * min });
  assert.deepEqual(
    [r.totals.allTimeVisitors, r.totals.visitors, r.totals.newVisitors, r.totals.returningVisitors, r.totals.sessions, r.totals.pageviews, r.totals.bots],
    [2, 2, 2, 0, 3, 5, 1],
  );
  assert.equal(r.totals.bounceRate, 67, 'two of three visits saw one page');
  assert.equal(r.totals.pagesPerSession, 1.67);
  assert.equal(r.totals.liveVisitors, 1);
  assert.equal(r.totals.postViews, 3);
  assert.deepEqual(r.topPosts.map((x) => ({ ...x })), [{ id: 7, views: 2 }, { id: 9, views: 1 }]);
  assert.deepEqual(Object.fromEntries(r.channels.map((c) => [c.channel, c.sessions])), { search: 1, social: 1, direct: 1 });
  assert.deepEqual(r.searchTerms.map((x) => [x.term, x.engines, x.sessions]), [['margot robbie', 'Bing', 1]]);
  assert.deepEqual(r.referrers.map((x) => x.host).sort(), ['bing.com', 'reddit.com']);
  assert.deepEqual(r.campaigns.map((c) => [c.source, c.campaign, c.sessions]), [['reddit', 'launch', 1]]);
  assert.deepEqual(r.siteSearches.map((x) => [x.q, x.searches, x.visitors]), [['margot robbie', 2, 2], ['xyzzy', 1, 1]]);
  assert.deepEqual(r.zeroResults.map((x) => x.q), ['xyzzy']);
  assert.equal(r.pages.find((p) => p.page === 'trending').views, 2);
  assert.deepEqual(r.devices.map((d) => d.name).sort(), ['desktop', 'mobile']);
  assert.equal(r.recent.length, 3);
  assert.equal(r.recent.find((x) => x.term === 'margot robbie').pages, 3);
  assert.ok(r.timeline.length >= 1 && r.timeline.reduce((s, x) => s + x.pageviews, 0) === 5);

  const withBots = a.report({ days: 0, now: t0 + 125 * min, bots: true });
  assert.equal(withBots.totals.visitors, 3);
  const day = a.report({ days: 1, now: t0 + 125 * min });
  assert.equal(day.hourly, true);
  assert.equal(day.timeline.length, 25);
  assert.equal(a.report({ days: 1, now: t0 + 3 * 24 * 60 * min }).totals.pageviews, 0, 'old traffic falls out of the window');
});
