const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»',
  bull: '•', middot: '·', deg: '°', euro: '€', pound: '£', yen: '¥', times: '×', divide: '÷',
};

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function stripShortcodes(s) {
  return s.replace(/\[\/?[a-z][\w-]*(?:\s[^\]]*)?\]/gi, ' ');
}

function htmlToText(html) {
  if (!html) return '';
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|section|article|figure|figcaption|pre|ul|ol|table)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(stripShortcodes(s));
  return s.replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function wordCount(text) {
  const m = String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}

// Simplified port of WordPress wpautop for classic-editor content.
function autop(content) {
  if (!content || /<!--\s*wp:/.test(content)) return content || '';
  let s = content.replace(/\r\n?/g, '\n');
  if (!s.includes('\n')) return /<(p|div|h\d|ul|ol|table|blockquote|figure)\b/i.test(s) ? s : `<p>${s}</p>`;
  const block = '(?:table|thead|tfoot|caption|col|colgroup|tbody|tr|td|th|div|dl|dd|dt|ul|ol|li|pre|form|map|area|blockquote|address|math|style|p|h[1-6]|hr|fieldset|legend|section|article|aside|hgroup|header|footer|nav|figure|figcaption|details|menu|summary)';
  s = s.replace(new RegExp(`(<${block}[\\s/>])`, 'gi'), '\n\n$1').replace(new RegExp(`(</${block}>)`, 'gi'), '$1\n\n');
  return s.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => {
    if (new RegExp(`^</?${block}[\\s/>]`, 'i').test(p)) return p;
    return `<p>${p.replace(/\n/g, '<br />\n')}</p>`;
  }).join('\n');
}

const UPLOAD_URL_RE = /(?:https?:)?\/\/[^\s"'()<>]+?\/wp-content\/uploads\//gi;

function rewriteUploadUrls(html, mediaBase) {
  return String(html || '').replace(UPLOAD_URL_RE, mediaBase + '/');
}

function extractUploadRefs(html) {
  const out = new Set();
  const re = /(?:https?:)?\/\/[^\s"'()<>]+?\/wp-content\/uploads\/([^\s"'()<>?#]+)/gi;
  let m;
  while ((m = re.exec(String(html || '')))) out.add(decodeURIComponent(m[1]));
  return [...out];
}

function htmlToMarkdown(html) {
  if (!html) return '';
  let s = String(html).replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<pre[^>]*>(?:\s*<code[^>]*>)?([\s\S]*?)(?:<\/code>\s*)?<\/pre>/gi, (_, c) => `\n\n\`\`\`\n${decodeEntities(c.replace(/<[^>]+>/g, ''))}\n\`\`\`\n\n`);
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => `\n\n${'#'.repeat(+l)} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`);
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = (/\ssrc=["']([^"']+)["']/i.exec(tag) || [])[1] || '';
    const alt = (/\salt=["']([^"']*)["']/i.exec(tag) || [])[1] || '';
    return src ? `![${alt}](${src})` : '';
  });
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => `[${t.trim()}](${href})`);
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**').replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) => '\n\n' + htmlToText(t).split('\n').map((l) => '> ' + l).join('\n') + '\n\n');
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, t) => { let n = 0; return '\n\n' + t.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (__, x) => `${++n}. ${x.trim()}\n`) + '\n'; });
  s = s.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, t) => '\n\n' + t.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (__, x) => `- ${x.trim()}\n`) + '\n');
  s = s.replace(/<hr[^>]*>/gi, '\n\n---\n\n').replace(/<br\s*\/?>/gi, '  \n');
  s = s.replace(/<\/(p|div|figure|figcaption|section|table|tr)>/gi, '\n\n').replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.replace(/[ \t]+\n/g, (m) => (m.startsWith('  ') ? '  \n' : '\n')).replace(/\n{3,}/g, '\n\n').trim();
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows, columns) {
  const cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return '\ufeff' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(','))].join('\r\n');
}

module.exports = { decodeEntities, htmlToText, wordCount, autop, rewriteUploadUrls, extractUploadRefs, htmlToMarkdown, toCsv };
