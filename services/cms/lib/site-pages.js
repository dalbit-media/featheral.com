const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('parse5');
const CmsStore = require('./cms');
const { Documents } = require('./documents');

const hosts = ['featheral.com', 'gold.featheral.com', 'silver.featheral.com', 'app.featheral.com', 'dollar.featheral.com', 'world.featheral.com', 'media.featheral.com', 'admin.featheral.com', 'x.featheral.com', 'ex.featheral.com',
  'notes.featheral.com', 'sites.featheral.com', 'stats.featheral.com', 'wallet.featheral.com', 'db.featheral.com'];
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fail = (status, message) => Object.assign(new Error(message), { status });
const themes = {
  native: '',
  ocean: '--bg:#edf7fc;--txt:#153447;--mut:#486779;--line:#c5dbe8;--btn:#dceef7;--panel:#fff;--glow:#dceef7;--gold:#17617f;--gold-2:#28728f;--on-accent:#fff',
  journal: '--bg:#faf6eb;--txt:#302920;--mut:#746854;--line:#ddd4c0;--btn:#eee6d4;--panel:#fffdf8;--glow:#eee6d4;--gold:#79522d;--gold-2:#94663c;--on-accent:#fff',
  forest: '--bg:#eff7ef;--txt:#203c2d;--mut:#526e5b;--line:#cbdccc;--btn:#dfece0;--panel:#fff;--glow:#dfece0;--gold:#24603b;--gold-2:#34734b;--on-accent:#fff',
};
const attr = (node, name) => node.attrs?.find((entry) => entry.name === name)?.value;
const text = (node) => node.nodeName === '#text' ? node.value : (node.childNodes || []).map(text).join('');
const unsafe = (node) => node.tagName && (
  !['b', 'strong', 'em', 'i', 'span', 'br', 'code'].includes(node.tagName)
  || node.attrs?.some((entry) => entry.name.startsWith('data-') || entry.name === 'id')
) || (node.childNodes || []).some(unsafe);

class SitePages {
  constructor({ root, dataDir }) {
    this.root = root;
    this.directory = path.join(dataDir, 'site-pages');
    this.cache = new Map();
    this.documents = new Documents(root);
    this.hosts = [...new Set([...hosts, ...fs.readdirSync(path.join(root, 'sites'), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[a-z0-9-]+\.featheral\.com$/.test(entry.name)).map(entry => entry.name)])];
  }
  catalog() {
    return this.hosts.map((hostname) => ({
      key: hostname, hostname, name: hostname, status: 'ready', builtin: true,
      cmsCompatible: this.documents.files(hostname).length > 0,
      contentEditable: this.documents.files(hostname).length > 0
        || this.templates(hostname).some(file => this.blocks(hostname, file).blocks.length > 0),
      management: this.documents.files(hostname).length > 0 ? 'cms' : 'classic',
      siteUrl: `https://${hostname}`, localDir: path.join(this.root, 'sites', hostname),
    }));
  }
  presentation(hostname) {
    const document = this.documents.template(hostname, 'index.html');
    const file = path.join(this.root, 'sites', hostname, hostname === 'wallet.featheral.com' ? 'wallet-app.html'
      : hostname === 'world.featheral.com' ? path.join('play', 'index.html') : 'index.html');
    const html = document ? document.layout : fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    let tagline = '', favicon = '/shared/logo.svg';
    const walk = node => {
      if (node.tagName === 'meta' && attr(node, 'name') === 'description') tagline = attr(node, 'content') || '';
      if (node.tagName === 'link' && attr(node, 'rel')?.split(/\s+/).includes('icon')) favicon = attr(node, 'href') || favicon;
      for (const child of node.childNodes || []) walk(child);
    };
    walk(parse(html));
    if (document) tagline = this.documents.pages(hostname, this.store(hostname)).find(page => page.template === 'index.html').excerpt;
    return { tagline, favicon };
  }
  store(hostname) {
    if (!this.hosts.includes(hostname)) throw fail(404, 'Unknown built-in site');
    if (!this.cache.has(hostname)) {
      fs.mkdirSync(this.directory, { recursive: true });
      const legacy = path.join(this.directory, 'cms.featheral.com.sqlite');
      const socialLegacy = path.join(this.directory, 'world.featheral.com.sqlite');
      const file = hostname === 'admin.featheral.com' && fs.existsSync(legacy) ? legacy
        : hostname === 'media.featheral.com' && fs.existsSync(socialLegacy) ? socialLegacy : path.join(this.directory, `${hostname}.sqlite`);
      this.cache.set(hostname, new CmsStore(file));
    }
    return this.cache.get(hostname);
  }
  templates(hostname) {
    if (!this.hosts.includes(hostname)) throw fail(404, 'Unknown built-in site');
    const directory = path.join(this.root, 'sites', hostname);
    if (this.documents.files(hostname).length) return this.documents.files(hostname).map(document => document.file);
    const files = [];
    if (!fs.existsSync(directory)) return files;
    const walk = (dir, prefix = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        if (entry.isDirectory() && ['docs', 'governance'].includes(entry.name)) walk(path.join(dir, entry.name), relative + '/');
        if (entry.isFile() && entry.name === 'index.html') files.push(relative);
      }
    };
    walk(directory);
    return files;
  }
  blocks(hostname, file) {
    if (!this.templates(hostname).includes(file)) throw fail(404, 'Unknown content template');
    const html = fs.readFileSync(path.join(this.root, 'sites', hostname, ...file.split('/')), 'utf8');
    const tree = parse(html, { sourceCodeLocationInfo: true });
    const blocks = [];
    const walk = (node, blocked = false) => {
      const excluded = blocked || ['script', 'style', 'nav', 'button', 'form', 'footer', 'template'].includes(node.tagName)
        || (node.attrs || []).some((entry) => (entry.name.startsWith('data-') && entry.name !== 'data-cms-copy')
          || (entry.name === 'hidden' && attr(node, 'id') !== 'gettingGuide'))
        || ['profileEditor', 'worldStatus', 'ledgerCard', 'followCard', 'feed', 'colHead'].includes(attr(node, 'id'));
      if (!excluded && ['h1', 'h2', 'h3', 'p', 'small'].includes(node.tagName)
        && !['statsUpdated', 'rateNote', 'heroTip'].includes(attr(node, 'id'))
        && node.childNodes?.length && !node.childNodes.some(unsafe) && text(node).trim()) {
        const location = node.sourceCodeLocation;
        if (location?.startTag && location?.endTag) {
          blocks.push({ slug: attr(node, 'data-cms-copy') || `${file.replace(/[^a-z0-9]/gi, '-')}-${location.startOffset}`, text: text(node).trim(),
            tagEnd: location.startTag.endOffset, start: location.startTag.endOffset, end: location.endTag.startOffset });
          return;
        }
      }
      for (const child of node.childNodes || []) walk(child, excluded);
    };
    walk(tree);
    return { html, blocks };
  }
  pages(hostname) {
    const store = this.store(hostname);
    if (this.documents.files(hostname).length) return this.documents.pages(hostname, store);
    const existing = new Map(store.list().map((page) => [page.slug, page]));
    const result = [];
    for (const file of this.templates(hostname)) {
      for (const block of this.blocks(hostname, file).blocks) {
        let page = existing.get(block.slug);
        if (!page) page = store.save({ type: 'page', status: 'publish', slug: block.slug,
          title: block.text.slice(0, 100), body: block.text });
        result.push({ ...page, template: file });
      }
    }
    return result;
  }
  save(hostname, id, input) {
    if (this.documents.files(hostname).length) return this.documents.save(hostname, id, input, this.store(hostname));
    if (!this.pages(hostname).some((page) => page.id === Number(id))) throw fail(404, 'Content block not found');
    if (typeof input?.body !== 'string' || !input.body.trim() || input.body.length > 10000) throw fail(400, 'Content must contain 1 to 10,000 characters');
    const existing = this.store(hostname).get(id);
    if (!Number.isSafeInteger(input.revision)) throw fail(400, 'The current revision is required');
    return this.store(hostname).save({ ...existing, body: input.body, revision: input.revision }, id);
  }
  theme(hostname, value) {
    const store = this.store(hostname);
    if (value !== undefined) {
      if (!Object.hasOwn(themes, value)) throw fail(400, 'Unknown site theme');
      store.store.put('settings', 'site_theme', { value });
    }
    return { theme: store.store.get('settings', 'site_theme')?.value || 'native', themes: Object.keys(themes) };
  }
  render(hostname, file) {
    if (this.documents.template(hostname, file)) {
      const theme = this.theme(hostname).theme;
      return this.documents.render(hostname, file, this.store(hostname)).replace('</head>',
        `<link rel="stylesheet" href="/shared/cms-document.css"><style data-cms-theme="${theme}">body.cms-layout{${themes[theme]}}</style></head>`);
    }
    const { html, blocks } = this.blocks(hostname, file);
    const pages = new Map(this.pages(hostname).map((page) => [page.slug, page]));
    let rendered = html;
    for (const block of [...blocks].reverse()) {
      const page = pages.get(block.slug);
      if (page.body !== block.text) rendered = rendered.slice(0, block.start) + escape(page.body).replace(/\n/g, '<br>') + rendered.slice(block.end);
    }
    const theme = this.theme(hostname).theme;
    return rendered.replace('</head>', `<style data-cms-theme="${theme}">:root{${themes[theme]}}</style></head>`);
  }
  close() {
    for (const store of this.cache.values()) store.close();
    this.cache.clear();
  }
  snapshot() {
    return this.catalog().filter(site => this.templates(site.hostname).length).map(site => ({
      hostname: site.hostname, theme: this.theme(site.hostname).theme,
      pages: this.pages(site.hostname).map(page => ({ slug: page.slug, body: page.body,
        ...(page.format === 'document' ? { title: page.title, excerpt: page.excerpt } : {}) })),
    }));
  }
}
module.exports = { SitePages, hosts };
