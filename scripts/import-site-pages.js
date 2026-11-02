const fs = require('node:fs');
const path = require('node:path');
const { SitePages } = require('../services/cms/lib/site-pages');
const CmsStore = require('../services/cms/lib/cms');
const file = path.join(__dirname, '..', '.cms-published.json');
if (fs.existsSync(file)) {
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pages = new SitePages({ root: path.join(__dirname, '..'), dataDir: path.join(__dirname, '..', 'services', 'cms', 'data') });
  try {
    for (const site of snapshot.integrated) {
      const existing = new Map(pages.pages(site.hostname).map(page => [page.slug, page]));
      for (const page of site.pages) {
        const current = existing.get(page.slug);
        if (!current) throw new Error(`Content template changed: ${site.hostname}/${page.slug}`);
        if (current.body !== page.body || page.title !== undefined && current.title !== page.title || page.excerpt !== undefined && current.excerpt !== page.excerpt)
          pages.save(site.hostname, current.id, { body: page.body, title: page.title, excerpt: page.excerpt, revision: current.revision });
      }
      pages.theme(site.hostname, site.theme);
    }
    const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'services', 'cms', 'data', 'sites.json'), 'utf8'));
    for (const site of snapshot.managed) {
      if (!registry.some(record => record.key === site.key && record.hostname === site.hostname && (record.path || '') === (site.path || '')))
        throw new Error(`Restore the matching managed-site registry before deploying ${site.hostname}`);
      const store = new CmsStore(path.join(__dirname, '..', 'services', 'cms', 'data', site.key, 'cms.sqlite'));
      try {
        const existing = new Map(store.list().map(page => [page.slug, page]));
        for (const page of site.pages) {
          const current = existing.get(page.slug);
          store.save({ ...page, revision: current?.revision }, current?.id);
        }
        store.setTheme(site.theme);
        store.setSiteSettings(site.settings);
        if (site.rewards) {
          const { Notes } = require('../services/notes/ledger');
          const notes = new Notes(path.join(__dirname, '..', 'services', 'cms', 'data', 'notes.sqlite'));
          try { notes.setProgram(site.key, site.rewards); } finally { notes.close(); }
        }
      } finally { store.close(); }
    }
  } finally { pages.close(); }
}
