/* Traffic analytics for the public site: visitors, sources, search terms and referrals */
VIEWS.analytics = async (arg, q, token) => {
  const days = ['1', '7', '30', '90', '365', '0'].includes(q.days) ? q.days : '7';
  const bots = q.bots === '1';
  setCrumbs(siteCrumb('Analytics'), `<select id="an-days" title="Period">${options([['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last 12 months'], ['0', 'All time']], days)}</select>
    <label class="small muted" title="Count visits from crawlers and automated browsers"><input type="checkbox" id="an-bots" ${bots ? 'checked' : ''}> bots</label>
    <button class="btn sm" id="an-refresh" title="Refresh">↻</button>`);
  const r = await api(`/api/sets/${state.key}/analytics?${new URLSearchParams({ days, bots: bots ? '1' : '' })}`);
  const t = r.totals;
  const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : '0%');
  const ago = (ms) => {
    const s = Math.max(0, Math.round((r.now - ms) / 1000));
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
  };
  const dur = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);
  const bars = (entries) => {
    const max = Math.max(1, ...entries.map((e) => e[1]));
    return entries.map(([k, n, extra]) => `<div class="hbar"><span class="ellipsis" title="${esc(k)}">${esc(k)}</span><div class="track"><i style="width:${(n / max) * 100}%"></i></div><span class="num small">${fmtNum(n)}${extra ? ` <span class="muted">${extra}</span>` : ''}</span></div>`).join('');
  };
  const table = (head, rows, empty) => (rows.length
    ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>${head.map((h) => `<th${/^#|Sessions|Visitors|Views|Searches|Results|Pages|Total/.test(h) ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : `<div class="muted small" style="padding:10px 0">${empty}</div>`);
  const CH = { direct: '⌨ Direct', search: '🔎 Search', social: '💬 Social', referral: '🔗 Referral', campaign: '📣 Campaign', paid: '💰 Paid', email: '✉ Email' };
  const PAGE = { swipe: '🔥 Swipe', trending: '📈 Trending', thumbs: '▦ Thumbs', read: '📖 Read list', 'read-post': '📖 Reading a text', liked: '♥ Liked', post: '➕ Post', other: 'Other' };
  const site = (path) => `/#${path}`;
  const tl = r.timeline;
  const max = Math.max(1, ...tl.map((x) => x.pageviews));
  const label = (k) => (r.hourly ? k.slice(11) : k.slice(5));
  const sessions = Math.max(1, t.sessions);

  setView(`
    <div class="stats">
      <div class="stat"><div class="l">Total visitors</div><div class="v">${fmtNum(t.allTimeVisitors)}</div><div class="s">all time · ${fmtNum(t.allTimePageviews)} page views</div></div>
      <div class="stat"><div class="l">Visitors</div><div class="v">${fmtNum(t.visitors)}</div><div class="s">${fmtNum(t.newVisitors)} new · ${fmtNum(t.returningVisitors)} returning</div></div>
      <div class="stat"><div class="l">Live now</div><div class="v">${fmtNum(t.liveVisitors)}</div><div class="s">active in the last 5 min</div></div>
      <div class="stat"><div class="l">Visits (sessions)</div><div class="v">${fmtNum(t.sessions)}</div><div class="s">${t.pagesPerSession} pages / visit</div></div>
      <div class="stat"><div class="l">Page views</div><div class="v">${fmtNum(t.pageviews)}</div><div class="s">${fmtNum(t.postViews)} post views</div></div>
      <div class="stat"><div class="l">Bounce rate</div><div class="v">${t.bounceRate}%</div><div class="s">avg visit ${dur(t.avgSessionSec)}</div></div>
      <div class="stat"><div class="l">Site searches</div><div class="v">${fmtNum(t.searches)}</div><div class="s">${fmtNum(r.zeroResults.reduce((a, x) => a + x.searches, 0))} with no results</div></div>
    </div>
    <div class="spacer"></div>
    <div class="card"><div class="card-head"><h3>📈 Traffic</h3><span class="muted small">${bots ? 'including' : 'excluding'} bots${t.bots && !bots ? ` (${fmtNum(t.bots)} bot hits hidden)` : ''}</span></div>
      ${t.pageviews ? `<div class="chart an-chart">${tl.map((x) => `<div class="col" title="${esc(x.k)}: ${fmtNum(x.visitors)} visitors · ${fmtNum(x.sessions)} visits · ${fmtNum(x.pageviews)} page views">
          <i class="pv" style="height:${(x.pageviews / max) * 170}px"></i><i class="vi" style="height:${(x.visitors / max) * 170}px"></i></div>`).join('')}</div>
        <div class="chart-labels"><span>${esc(label(tl[0].k))}</span><span>${esc(label(tl[tl.length >> 1].k))}</span><span>${esc(label(tl[tl.length - 1].k))}</span></div>
        <div class="legend"><span style="--c:var(--brand)">Visitors</span><span style="--c:#c7cbe8">Page views</span></div>`
        : emptyBox('📈', 'No visits recorded in this period yet. Visits are counted as people open the <a href="/">public site</a>.')}
    </div>
    <div class="spacer"></div>
    <div class="grid g2">
      <div class="card"><h3>🚦 Traffic sources</h3>${r.channels.length ? bars(r.channels.map((c) => [CH[c.channel] || c.channel, c.sessions, pct(c.sessions, sessions)])) : '<div class="muted small">No visits yet.</div>'}
        <div class="muted small" style="margin-top:8px">Visits by how they started: typed or bookmarked (direct), a search engine, a social site, another site linking here, or a link tagged with <code>utm_source</code>.</div></div>
      <div class="card"><h3>🔗 Top referrers</h3>${table(['Site', 'Type', 'Visits', 'Visitors', 'Last'], r.referrers.map((x) => `<tr><td><a href="https://${esc(x.host)}" target="_blank" rel="noreferrer noopener">${esc(x.host)}</a></td>
        <td class="nowrap small">${esc(CH[x.channel] || x.channel)}</td><td class="num">${fmtNum(x.sessions)}</td><td class="num">${fmtNum(x.visitors)}</td><td class="nowrap small muted">${ago(x.last)}</td></tr>`), 'No referrals yet — every visit so far was direct.')}</div>
      <div class="card"><h3>🔎 Search engine keywords</h3>
        ${r.engines.length ? `<div style="margin-bottom:10px">${r.engines.map((e) => `<span class="chip brand">${esc(e.engine)} <span class="n">${fmtNum(e.sessions)}</span></span>`).join(' ')}</div>` : ''}
        ${table(['Search terms', 'Engine', 'Visits', 'Last'], r.searchTerms.map((x) => `<tr><td><b>${esc(x.term)}</b></td><td class="small">${esc(x.engines)}</td><td class="num">${fmtNum(x.sessions)}</td><td class="nowrap small muted">${ago(x.last)}</td></tr>`),
          r.engines.length ? 'Visitors came from search engines, but the engines did not pass on their search terms (Google hides them; see Google Search Console).' : 'No visits from search engines yet.')}
        ${r.engines.some((e) => e.sessions > e.withTerms) ? `<div class="muted small" style="margin-top:6px">${fmtNum(r.engines.reduce((a, e) => a + e.sessions - e.withTerms, 0))} search visits had their terms hidden by the engine ("not provided").</div>` : ''}</div>
      <div class="card"><h3>🔍 Site searches</h3>${table(['Searched for', 'Where', 'Searches', 'Visitors', 'Results', 'Last'], r.siteSearches.map((x) => `<tr><td><a href="${site(`/trending?q=${encodeURIComponent(x.q)}`)}" target="_blank"><b>${esc(x.q)}</b></a></td>
        <td class="small">${esc(x.places)}</td><td class="num">${fmtNum(x.searches)}</td><td class="num">${fmtNum(x.visitors)}</td><td class="num ${x.results ? '' : 'bad'}">${fmtNum(x.results)}</td><td class="nowrap small muted">${ago(x.last)}</td></tr>`), 'Nobody has used the search boxes on Trending or Read yet.')}
        ${r.zeroResults.length ? `<div class="spacer"></div><h4 class="small">No results for</h4><div>${r.zeroResults.map((x) => `<span class="chip bad" title="${fmtNum(x.searches)} searches · ${esc(x.places)}">${esc(x.q)}${x.searches > 1 ? ` <span class="n">${fmtNum(x.searches)}</span>` : ''}</span>`).join(' ')}</div>` : ''}</div>
      <div class="card"><h3>📄 Pages</h3>${bars(r.pages.map((p) => [PAGE[p.page] || p.page, p.views, `${fmtNum(p.visitors)} visitors`]))}
        <div class="spacer"></div><h4 class="small">Landing pages</h4>${bars(r.landingPages.map((p) => [p.path, p.sessions]))}</div>
      <div class="card"><h3>🔥 Most viewed posts</h3>${table(['Post', 'Views', 'Total'], r.topPosts.map((p) => `<tr><td><a href="${setHref('content', p.id)}">${esc(p.title)}</a></td><td class="num">${fmtNum(p.views)}</td><td class="num muted">${fmtNum(p.total)}</td></tr>`), 'No posts viewed in this period.')}</div>
      <div class="card"><h3>📣 Campaigns (UTM)</h3>${table(['Source', 'Medium', 'Campaign', 'Visits'], r.campaigns.map((c) => `<tr><td>${esc(c.source || '–')}</td><td>${esc(c.medium || '–')}</td><td>${esc(c.campaign || '–')}</td><td class="num">${fmtNum(c.sessions)}</td></tr>`),
        'No tagged links yet. Share links like <code>/?utm_source=reddit&amp;utm_campaign=launch</code> to see them here.')}
        <div class="spacer"></div><h4 class="small">Referring pages</h4>${table(['URL', 'Visits'], r.referrerUrls.map((u) => `<tr><td class="ellipsis" style="max-width:360px"><a href="${esc(u.url)}" target="_blank" rel="noreferrer noopener">${esc(u.url)}</a></td><td class="num">${fmtNum(u.sessions)}</td></tr>`), 'None yet.')}</div>
      <div class="card"><h3>💻 Visitors' devices</h3>
        <div class="grid g2"><div><h4 class="small">Device</h4>${bars(r.devices.map((x) => [x.name, x.visitors]))}<div class="spacer"></div><h4 class="small">Language</h4>${bars(r.languages.map((x) => [x.name, x.visitors]))}</div>
        <div><h4 class="small">Browser</h4>${bars(r.browsers.map((x) => [x.name, x.visitors]))}<div class="spacer"></div><h4 class="small">System</h4>${bars(r.os.map((x) => [x.name, x.visitors]))}</div></div></div>
    </div>
    <div class="spacer"></div>
    <div class="card"><h3>🕘 Recent visits</h3>${table(['When', 'Visitor', 'Landed on', 'Source', 'Pages', 'Device'], r.recent.map((x) => `<tr><td class="nowrap small">${ago(x.at)}</td>
      <td class="mono small">${esc(x.visitor.slice(0, 8))}${x.isNew ? ' <span class="chip ok">new</span>' : ''}</td><td><a href="${site(x.path)}" target="_blank">${esc(x.path)}</a></td>
      <td class="small">${esc(CH[x.channel] || x.channel)}${x.host ? ` · ${esc(x.host)}` : ''}${x.term ? ` · “${esc(x.term)}”` : ''}</td><td class="num">${fmtNum(x.pages)}</td>
      <td class="small nowrap">${esc(x.device)} · ${esc(x.browser)} · ${esc(x.os)}</td></tr>`), 'No visits yet.')}
      <div class="muted small" style="margin-top:8px">Visitors are counted with a random id kept in each browser (no cookies, IP addresses or personal data are stored). A visit ends after 30 minutes without activity.</div></div>
  `, token);
  $('#an-days').addEventListener('change', (e) => patchQuery({ days: e.target.value }));
  $('#an-bots').addEventListener('change', (e) => patchQuery({ bots: e.target.checked ? '1' : '' }));
  $('#an-refresh').addEventListener('click', () => render());
};
