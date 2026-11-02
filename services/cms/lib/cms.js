const { DomainStore } = require('./domain-store');
const T = require('./text');

const THEMES = ['featheral', 'editorial', 'ocean', 'journal', 'studio', 'launch', 'boutique', 'terminal'];
const httpError = (status, message) => Object.assign(new Error(message), { status });
const slugify = (value) => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 180);

class CmsStore {
  constructor(file) {
    this.store = new DomainStore(file);
  }

  list({ q = '', status = '', summary = false } = {}) {
    const search = String(q).toLowerCase();
    return this.store.list('content')
      .filter(row => (!status || row.status === status) && (!search || [row.title, row.excerpt, row.body].some(value => value.toLowerCase().includes(search))))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id)
      .map(row => { if (summary) delete row.body; return row; });
  }

  get(id) {
    return Number.isSafeInteger(+id) && +id > 0 ? this.store.get('content', +id) || null : null;
  }

  published() {
    return this.list({ status: 'publish' }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  }

  publishedPage(slug) {
    return this.published().find(row => row.slug === slug && row.type === 'page') || null;
  }

  publicPages() {
    return this.published().filter(row => row.type === 'page').sort((a, b) => a.id - b.id).map(({ slug, title }) => ({ slug, title }));
  }

  save(input, id) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'Content fields are required');
    const title = String(input.title || '').trim().slice(0, 300);
    const type = String(input.type || 'post');
    const status = String(input.status || 'draft');
    const excerpt = String(input.excerpt || '').trim().slice(0, 5000);
    const body = String(input.body || '').slice(0, 1_000_000);
    const slug = slugify(input.slug || title);
    if (!title) throw httpError(400, 'A title is required');
    if (!slug) throw httpError(400, 'A title or slug must contain letters or numbers');
    if (!['post', 'page'].includes(type)) throw httpError(400, 'Content type must be post or page');
    if (!['draft', 'publish'].includes(status)) throw httpError(400, 'Status must be draft or publish');
    if (status === 'publish' && !T.wordCount(body)) throw httpError(400, 'Published content needs at least one word');
    const now = new Date().toISOString();
    return this.store.transaction(() => {
      const owner = this.store.get('slugs', slug);
      if (owner && owner.id !== +id) throw httpError(409, 'That slug is already in use');
      if (id === undefined) {
        const newId = this.store.next('content');
        this.store.put('content', newId, { id: newId, type, status, title, slug, excerpt, body, revision: 1, createdAt: now, updatedAt: now });
        this.store.put('slugs', slug, { id: newId });
        return this.get(newId);
      }
      const existing = this.get(id);
      if (!existing) throw httpError(404, 'CMS content not found');
      if (input.revision !== undefined && Number(input.revision) !== existing.revision) throw httpError(409, 'This content changed in another editor. Reload before saving; your text has not been overwritten.');
      const settings = this.siteSettings();
      if (settings.homepage === 'content' && existing.slug === settings.homeSlug &&
          (slug !== existing.slug || type !== 'page' || status !== 'publish')) {
        throw httpError(409, 'This is the active homepage. Choose another homepage in Site features before unpublishing or changing its slug/type.');
      }
      const historyId = this.store.next('history');
      this.store.put('history', historyId, { id: historyId, content_id: +id, snapshot: existing, at: now });
      this.store.put('content', +id, { ...existing, type, status, title, slug, excerpt, body, updatedAt: now, revision: existing.revision + 1 });
      if (existing.slug !== slug) this.store.delete('slugs', existing.slug);
      this.store.put('slugs', slug, { id: +id });
      for (const row of this.revisions(id).slice(20)) this.store.delete('history', row.id);
      return this.get(id);
    });
  }

  delete(id) {
    const existing = this.get(id);
    const settings = this.siteSettings();
    if (existing && settings.homepage === 'content' && settings.homeSlug === existing.slug) throw httpError(409, 'Choose another homepage in Site features before deleting this page.');
    if (!existing) throw httpError(404, 'CMS content not found');
    this.store.transaction(() => {
      for (const row of this.revisions(id)) this.store.delete('history', row.id);
      this.store.delete('content', +id);
      this.store.delete('slugs', existing.slug);
    });
    return { ok: true };
  }

  revisions(id) {
    if (!this.get(id)) throw httpError(404, 'CMS content not found');
    return this.store.list('history').filter(row => row.content_id === +id).sort((a, b) => b.id - a.id);
  }

  restore(id, revisionId, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision)) throw httpError(400, 'Current content revision is required');
    const row = this.store.get('history', +revisionId);
    if (!row || row.content_id !== +id) throw httpError(404, 'Revision not found');
    return this.save({ ...row.snapshot, revision: expectedRevision }, id);
  }

  duplicate(id) {
    const post = this.get(id);
    if (!post) throw httpError(404, 'CMS content not found');
    let slug; let suffix = 1;
    do { slug = `${post.slug.slice(0, 160)}-copy-${suffix++}`; }
    while (this.store.get('slugs', slug));
    return this.save({ ...post, title: `${post.title} (copy)`, slug, status: 'draft' });
  }

  theme() {
    return this.store.get('settings', 'theme')?.value || 'featheral';
  }

  setTheme(theme) {
    if (!THEMES.includes(theme)) throw httpError(400, `Theme must be one of: ${THEMES.join(', ')}`);
    this.store.put('settings', 'theme', { value: theme });
    return { theme };
  }

  siteSettings() {
    const stored = this.store.get('settings', 'site');
    return {
      homepage: 'media', homeSlug: 'home', commerce: false, exchange: false, stats: false, ageGate: null, nativeCurrency: 'FTHX',
      displayName: '', description: '', footer: '',
      ...(stored?.value || {}),
    };
  }

  setSiteSettings(input) {
    if (!input || !['media', 'content', 'shop', 'exchange'].includes(input.homepage)) throw httpError(400, 'Select a valid homepage');
    if (typeof input.commerce !== 'boolean' || typeof input.exchange !== 'boolean' ||
        ![null, true, false].includes(input.ageGate)) throw httpError(400, 'Feature and age gate settings are invalid');
    if (!['FTHX', 'FTH$'].includes(input.nativeCurrency)) throw httpError(400, 'Native currency must be FTHX or FTH$');
    if (input.homepage === 'shop' && !input.commerce || input.homepage === 'exchange' && !input.exchange) {
      throw httpError(400, 'Enable the feature used by the homepage');
    }
    const homeSlug = slugify(input.homeSlug);
    if (!homeSlug) throw httpError(400, 'A homepage slug is required');
    if (input.homepage === 'content' && !this.publishedPage(homeSlug)) throw httpError(400, 'A CMS landing homepage must use an existing published page.');
    const previous = this.siteSettings();
    if (input.stats !== undefined && typeof input.stats !== 'boolean') throw httpError(400, 'Stats feature must be a boolean');
    const text = (key, max) => {
      const value = input[key] === undefined ? previous[key] : input[key];
      if (typeof value !== 'string' || value.length > max) throw httpError(400, `${key} must be text up to ${max} characters`);
      return value.trim();
    };
    const settings = {
      homepage: input.homepage, homeSlug, commerce: input.commerce, exchange: input.exchange, stats: input.stats ?? previous.stats,
      ageGate: input.ageGate, nativeCurrency: input.nativeCurrency,
      displayName: text('displayName', 200), description: text('description', 500), footer: text('footer', 500),
    };
    this.store.put('settings', 'site', { value: settings });
    return settings;
  }

  close() { this.store.close(); }
}

CmsStore.THEMES = THEMES;
module.exports = CmsStore;
