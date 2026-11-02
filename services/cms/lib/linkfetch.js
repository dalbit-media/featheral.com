// Fetches an image for a new post from a link: either a direct image/GIF URL or a page whose preview
// image (og:image, twitter:image, Reddit post media…) is used. Only public internet addresses are
// fetched; every redirect is checked again, and downloads are capped in size and time.
const dns = require('dns').promises;
const net = require('net');
const T = require('./text');

const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_PAGE = 3 * 1024 * 1024;
const TIMEOUT = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const httpError = (status, message) => Object.assign(new Error(message), { status });

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  const x = ip.toLowerCase();
  if (x === '::' || x === '::1') return true;
  const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateIp(mapped[1]);
  return /^(fc|fd|fe[89ab]|ff)/.test(x);
}

async function checkUrl(input) {
  let url;
  try { url = new URL(String(input || '').trim()); } catch { throw httpError(400, 'Enter a valid http(s) link'); }
  if (!/^https?:$/.test(url.protocol)) throw httpError(400, 'Only http and https links can be fetched');
  if (url.username || url.password) throw httpError(400, 'Links with a user name or password are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host }];
  else {
    try { addrs = await dns.lookup(host, { all: true }); } catch { throw httpError(400, `Can't find ${host}`); }
  }
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw httpError(400, 'Links to local or private network addresses are not allowed');
  return url;
}

async function request(input, accept) {
  let url = await checkUrl(input);
  for (let hop = 0; hop < 6; hop++) {
    let res;
    try {
      res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(TIMEOUT) });
    } catch (e) { throw httpError(502, e.name === 'TimeoutError' ? 'The site took too long to answer' : `Couldn't reach ${url.hostname}`); }
    const loc = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (loc) { res.body?.cancel().catch(() => {}); url = await checkUrl(new URL(loc, url).href); continue; }
    if (!res.ok) { res.body?.cancel().catch(() => {}); throw httpError(502, `${url.hostname} answered ${res.status}`); }
    return { url: url.href, res };
  }
  throw httpError(502, 'Too many redirects');
}

async function readBody(res, max, what) {
  if (+res.headers.get('content-length') > max) { res.body?.cancel().catch(() => {}); throw httpError(413, `That ${what} is larger than ${max / 1048576} MB`); }
  const parts = []; let n = 0;
  if (res.body) {
    for await (const c of res.body) {
      n += c.length;
      if (n > max) throw httpError(413, `That ${what} is larger than ${max / 1048576} MB`);
      parts.push(Buffer.from(c));
    }
  }
  return Buffer.concat(parts);
}

// Image formats a browser can decode; the browser re-encodes them (except animated GIFs) before upload.
function sniff(b) {
  if (b.length < 12) return null;
  if (b.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('ascii', 4, 8) === 'ftyp' && /^(avif|avis)/.test(b.toString('ascii', 8, 12))) return 'image/avif';
  if (b.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  return null;
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1].toLowerCase()] = T.decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  return out;
}

// Preview image and title named by a page's meta tags, falling back to its first sizeable <img>.
function pageInfo(html, base) {
  const meta = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const k = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (k && a.content && !(k in meta)) meta[k] = a.content;
  }
  let image = meta['og:image:secure_url'] || meta['og:image:url'] || meta['og:image'] || meta['twitter:image'] || meta['twitter:image:src'] || meta.image || meta.thumbnailurl;
  if (!image) for (const m of html.matchAll(/<link\b[^>]*>/gi)) { const a = attrs(m[0]); if (/\bimage_src\b/i.test(a.rel || '') && a.href) { image = a.href; break; } }
  if (!image) {
    for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
      const a = attrs(m[0]);
      const src = a.src || a['data-src'];
      if (!src || /^data:|\.svg(\?|$)/i.test(src)) continue;
      if ((+a.width && +a.width < 200) || (+a.height && +a.height < 200)) continue;
      image = src; break;
    }
  }
  const title = meta['og:title'] || meta['twitter:title'] || T.decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  let abs = null;
  try { abs = image ? new URL(image, base).href : null; } catch { /* malformed */ }
  return { image: abs, title: (title || '').replace(/\s+/g, ' ').trim().slice(0, 200) };
}

// Reddit post pages hide their media behind scripts; the post's JSON names it directly.
async function redditInfo(url) {
  const u = new URL(url);
  if (!/(^|\.)reddit\.com$/i.test(u.hostname) || !/\/comments\//.test(u.pathname)) return null;
  try {
    const { res } = await request(`https://www.reddit.com${u.pathname.replace(/\/$/, '')}.json?raw_json=1`, 'application/json');
    const post = JSON.parse((await readBody(res, MAX_PAGE, 'page')).toString('utf8'))?.[0]?.data?.children?.[0]?.data;
    if (!post) return null;
    const gallery = post.gallery_data?.items?.[0] && post.media_metadata?.[post.gallery_data.items[0].media_id]?.s;
    const image = gallery?.gif || gallery?.u || (/\.(gif|jpe?g|png|webp)(\?|$)/i.test(post.url_overridden_by_dest || '') ? post.url_overridden_by_dest : null)
      || post.preview?.images?.[0]?.variants?.gif?.source?.url || post.preview?.images?.[0]?.source?.url;
    return image ? { image, title: String(post.title || '').slice(0, 200) } : null;
  } catch { return null; }
}

const tidy = (url) => url.replace(/^(https?:\/\/i\.imgur\.com\/\w+)\.gifv(\?.*)?$/i, '$1.gif');

// The 11-character video id of a YouTube watch, short, Shorts, live or embed link; null otherwise.
function youtubeId(link) {
  let u;
  try { u = new URL(String(link || '').trim()); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.pathname === '/watch' ? u.searchParams.get('v') : (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/) || [])[1];
  }
  return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
}

// A YouTube link becomes the video's largest thumbnail plus its title; the post plays the video.
async function youtubeImage(id) {
  const page = `https://www.youtube.com/watch?v=${id}`;
  let title = '';
  try {
    const { res } = await request(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(page)}`, 'application/json');
    title = String(JSON.parse((await readBody(res, MAX_PAGE, 'page')).toString('utf8')).title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch { /* private, age-restricted or unlisted videos may have no oEmbed; the thumbnail still works */ }
  for (const size of ['maxresdefault', 'sddefault', 'hqdefault']) {
    try {
      const { url, res } = await request(`https://i.ytimg.com/vi/${id}/${size}.jpg`, 'image/jpeg,image/*');
      const data = await readBody(res, MAX_IMAGE, 'image');
      if (sniff(data)) return { data, mime: sniff(data), imageUrl: url, pageUrl: page, title, video: id };
    } catch { /* try the next size */ }
  }
  throw httpError(404, "Couldn't find that YouTube video");
}

async function fetchImage(link) {
  const yt = youtubeId(link);
  if (yt) return youtubeImage(yt);
  let { url, res } = await request(tidy(String(link || '').trim()), 'image/avif,image/webp,image/gif,image/*,text/html;q=0.9,*/*;q=0.5');
  const type = (res.headers.get('content-type') || '').toLowerCase();
  let title = '';
  const page = url;
  if (!type.startsWith('image/')) {
    if (!/html|xml/.test(type)) { res.body?.cancel().catch(() => {}); throw httpError(415, 'That link is not an image or a web page'); }
    const html = (await readBody(res, MAX_PAGE, 'page')).toString('utf8');
    const found = (await redditInfo(url)) || pageInfo(html, url);
    if (!found.image) throw httpError(404, 'No preview image found on that page');
    title = found.title;
    ({ url, res } = await request(tidy(found.image), 'image/avif,image/webp,image/gif,image/*;q=0.8'));
  }
  const data = await readBody(res, MAX_IMAGE, 'image');
  const mime = sniff(data);
  if (!mime) throw httpError(415, 'The link did not return a supported image');
  return { data, mime, imageUrl: url, pageUrl: page, title };
}

module.exports = { fetchImage, checkUrl, pageInfo, privateIp, sniff, youtubeId };
