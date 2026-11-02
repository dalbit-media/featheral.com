const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseFragment, serialize } = require('parse5');

const documentHosts = ['featheral.com', 'gold.featheral.com', 'dollar.featheral.com'];
const tags = new Set(['section', 'article', 'aside', 'div', 'header', 'h1', 'h2', 'h3', 'h4', 'p', 'span',
  'a', 'b', 'strong', 'em', 'i', 'small', 'br', 'hr', 'code', 'pre', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'details', 'summary', 'cms-widget']);
const attr = (node, name) => node.attrs?.find(item => item.name === name)?.value;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const error = message => Object.assign(new Error(message), { status: 400 });
function validateBody(body, widgets, layout = '') {
  if (typeof body !== 'string' || !body.trim() || body.length > 250000) throw error('Document HTML must contain 1 to 250,000 characters');
  const fragment = parseFragment(body);
  const used = new Set();
  const ids = new Set();
  const visit = node => {
    if (node.nodeName === '#comment') throw error('HTML comments are not supported');
    if (node.tagName) {
      if (!tags.has(node.tagName)) throw error(`Unsupported document element: ${node.tagName}`);
      if (node.tagName === 'cms-widget') {
        const name = attr(node, 'name');
        if (!Object.hasOwn(widgets, name) || used.has(name) || node.childNodes.length || node.attrs.length !== 1)
          throw error('Each protected live widget must appear exactly once and cannot contain custom HTML');
        used.add(name);
      } else {
        for (const item of node.attrs || []) {
          if (!['class', 'id', 'href', 'src', 'alt', 'width', 'height', 'title', 'target', 'rel', 'colspan', 'rowspan', 'scope',
            'aria-label', 'aria-hidden', 'aria-live', 'role', 'data-site', 'data-path', 'data-cms-copy'].includes(item.name)) throw error(`Unsupported document attribute: ${item.name}`);
          if (['href', 'src', 'data-path'].includes(item.name)) {
            if (!/^(?:\/(?!\/)|#|https:\/\/|mailto:)/i.test(item.value) || /[\u0000-\u0020\\]/.test(item.value))
              throw error('Links/images must use a safe local path, HTTPS URL, anchor or email URL');
            if (item.name === 'src' && !/^(?:\/(?!\/)|https:\/\/)/i.test(item.value)) throw error('Invalid image URL');
          }
          if (item.name === 'data-site' && !['foundation', 'gold', 'silver', 'app', 'dollar', 'world', 'media', 'ledger', 'admin', 'cms', 'x', 'ex', 'notes', 'sites', 'stats', 'wallet'].includes(item.value)) throw error('Unknown site link');
          if (item.name === 'target' && item.value !== '_blank') throw error('Only new-window link targets are supported');
          if (item.name === 'id') {
            if (!/^[a-zA-Z][\w-]*$/.test(item.value) || ids.has(item.value) || layout.includes(`id="${item.value}"`)
              || Object.values(widgets).some(widget => widget.includes(`id="${item.value}"`)))
              throw error('Document IDs must be unique and must not shadow live widget IDs');
            ids.add(item.value);
          }
        }
        if (node.tagName === 'a' && attr(node, 'target') === '_blank') {
          const rel = node.attrs.find(item => item.name === 'rel');
          if (rel) rel.value = 'noopener noreferrer'; else node.attrs.push({ name: 'rel', value: 'noopener noreferrer' });
        }
      }
    }
    for (const child of node.childNodes || []) visit(child);
  };
  visit(fragment);
  if (used.size !== Object.keys(widgets).length) throw error('Do not remove protected live widgets; every widget must appear exactly once');
  return serialize(fragment);
}
class Documents {
  constructor(root) { this.directory = path.join(root, 'sites', 'admin.featheral.com', 'documents'); }
  files(hostname) {
    if (!documentHosts.includes(hostname)) return [];
    const directory = path.join(this.directory, hostname);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(file => file.endsWith('.json')).map(file => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')));
  }
  template(hostname, file) { return this.files(hostname).find(document => document.file === file); }
  pages(hostname, store) {
    return this.files(hostname).map(document => {
      let page = store.list().find(page => page.slug === document.slug);
      if (page && page.status === 'publish' && document.replaces?.includes(crypto.createHash('sha256')
        .update(JSON.stringify({ title: page.title, excerpt: page.excerpt, body: page.body })).digest('hex'))) {
        const fragment = parseFragment(document.body);
        const clean = node => {
          if (node.attrs) node.attrs = node.attrs.filter(item => item.name !== 'data-cms-copy');
          for (const child of node.childNodes || []) clean(child);
        };
        clean(fragment);
        page = store.save({ ...page, title: document.title, excerpt: document.description || '',
          body: validateBody(serialize(fragment), document.widgets, document.layout), revision: page.revision }, page.id);
      }
      if (!page) {
        const legacy = new Map(store.list().map(page => [page.slug, page.body]));
        const fragment = parseFragment(document.body);
        const migrate = node => {
          const key = attr(node, 'data-cms-copy');
          if (key) {
            if (legacy.has(key)) {
              const text = value => value.nodeName === '#text' ? value.value : (value.childNodes || []).map(text).join('');
              if (text(node).trim() !== legacy.get(key)) {
                const escaped = escape(legacy.get(key));
                node.childNodes = parseFragment(escaped.replace(/\n/g, '<br>')).childNodes;
              }
            }
            node.attrs = node.attrs.filter(item => item.name !== 'data-cms-copy');
          }
          for (const child of node.childNodes || []) migrate(child);
        };
        migrate(fragment);
        page = store.save({ type: 'page', status: 'publish', title: document.title, slug: document.slug,
          excerpt: document.description || '', body: validateBody(serialize(fragment), document.widgets, document.layout) });
      }
      return { ...page, template: document.file, format: 'document', widgets: Object.keys(document.widgets) };
    });
  }
  save(hostname, id, input, store) {
    const existing = store.get(id);
    const document = this.files(hostname).find(document => document.slug === existing?.slug);
    if (!document) throw Object.assign(new Error('Document page not found'), { status: 404 });
    if (!Number.isSafeInteger(input?.revision)) throw error('The current revision is required');
    if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 300)) throw error('Page title must contain 1 to 300 characters');
    if (input.excerpt !== undefined && (typeof input.excerpt !== 'string' || input.excerpt.length > 5000)) throw error('Page description must be at most 5,000 characters');
    return store.save({ ...existing, title: input.title ?? existing.title, excerpt: input.excerpt ?? existing.excerpt,
      body: validateBody(input.body, document.widgets, document.layout), revision: input.revision }, id);
  }
  render(hostname, file, store) {
    const template = this.template(hostname, file);
    if (!template) throw Object.assign(new Error('CMS document not found'), { status: 404 });
    const page = this.pages(hostname, store).find(page => page.slug === template.slug);
    let html = validateBody(page.body, template.widgets, template.layout);
    if (hostname === 'gold.featheral.com') html = html.replace(/src="\/shared\/logo\.svg"/g, 'src="/shared/logo-gold.svg"');
    html = html.replace(/<cms-widget name="([^"]+)"><\/cms-widget>/g, (_, name) => template.widgets[name]);
    return template.layout.replace('{{CMS_DOCUMENT}}', () => html)
      .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${escape(page.title)}</title>`)
      .replace(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${escape(page.excerpt)}">`)
      .replace(/<body class="([^"]*)">/, (_, classes) => `<body class="${classes} cms-layout">`);
  }
}
module.exports = { Documents, documentHosts, validateBody };
