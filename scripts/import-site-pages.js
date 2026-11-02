const fs = require('node:fs');
const path = require('node:path');
const { SitePages } = require('../services/cms/lib/site-pages');
const CmsStore = require('../services/cms/lib/cms');
function importError(step, message) {
  if (typeof process !== 'undefined' && process.env.FEATHERAL_DEPLOY_DIAGNOSTICS === '1')
    fs.writeSync(3, `FEATHERAL_FAILURE:${step}:1\n`);
  return new Error(message);
}
const file = path.join(__dirname, '..', '.cms-published.json');
if (fs.existsSync(file)) {
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Releases intentionally link CMS data to shared storage; journals require its physical path.
  const dataDir = fs.realpathSync(path.join(__dirname, '..', 'services', 'cms', 'data'));
  const registryFile = path.join(dataDir, 'sites.json');
  let registry = fs.existsSync(registryFile) ? JSON.parse(fs.readFileSync(registryFile, 'utf8')) : [];
  if (!Array.isArray(registry)) throw new Error('Invalid managed-site registry.');
  const fresh = registry.length === 0;
  if (fresh && snapshot.managed.length) {
    const staging = fs.mkdtempSync(path.join(dataDir, 'fresh-sites-'));
    try {
      const { SiteManager } = require('../services/cms/lib/sites');
      const createFresh = directory => {
        const manager = new SiteManager({ dataDir: directory, cmsHost: 'admin.featheral.com' });
        for (const site of snapshot.managed) {
          if (typeof site.key !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(site.key)) throw new Error('Invalid published site key.');
          if (fs.existsSync(path.join(dataDir, site.key))) throw importError('import-fresh-conflict', 'Fresh managed sites cannot replace an existing source data folder.');
          const slug = site.path ? site.path.slice(1) : undefined;
          if (site.path && (!slug || site.path !== `/${slug}`)) throw new Error('Invalid managed-site path.');
          const created = manager.create({ hostname: site.hostname, ...(slug ? { slug } : {}), template: false, name: site.settings.displayName || site.hostname });
          if (directory !== dataDir && fs.existsSync(path.join(dataDir, created.key))) throw importError('import-fresh-conflict', 'Fresh managed sites cannot replace an existing data folder.');
          const store = new CmsStore(path.join(directory, created.key, 'cms.sqlite'));
          try {
            for (const page of site.pages) {
              store.save({ type: page.type, title: page.title, slug: page.slug, excerpt: page.excerpt, body: page.body,
                status: 'publish' });
            }
            store.setTheme(site.theme);
            store.setSiteSettings(site.settings);
          } finally { store.close(); }
          manager.records.find(record => record.key === created.key).publishedSourceKey = site.key;
          manager.persist();
        }
        return manager;
      };
      createFresh(staging);
      // CMS journal namespaces bind to absolute paths; recreate at final paths after validation.
      registry = createFresh(dataDir).records;
      console.log(`Created ${registry.length} managed sites from published content only; no ownership, balances, rewards, uploads or history copied.`);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  } else if (snapshot.managed.length) {
    for (const site of snapshot.managed) {
      if (!registry.some(record => (record.key === site.key || record.publishedSourceKey === site.key) && record.hostname === site.hostname && (record.path || '') === (site.path || '')))
        throw importError('import-registry-mismatch', `Restore the matching managed-site registry before deploying ${site.hostname}`);
    }
  }
  const pages = new SitePages({ root: path.join(__dirname, '..'), dataDir });
  try {
    for (const site of snapshot.integrated) {
      const existing = new Map(pages.pages(site.hostname).map(page => [page.slug, page]));
      for (const page of site.pages) {
        const current = existing.get(page.slug);
        if (!current) throw importError('import-template', `Content template changed: ${site.hostname}/${page.slug}`);
        if (current.body !== page.body || page.title !== undefined && current.title !== page.title || page.excerpt !== undefined && current.excerpt !== page.excerpt)
          pages.save(site.hostname, current.id, { body: page.body, title: page.title, excerpt: page.excerpt, revision: current.revision });
      }
      pages.theme(site.hostname, site.theme);
    }
    for (const site of snapshot.managed) {
      if (fresh) continue;
      const record = registry.find(record => (record.key === site.key || record.publishedSourceKey === site.key) && record.hostname === site.hostname && (record.path || '') === (site.path || ''));
      const store = new CmsStore(path.join(dataDir, record.key, 'cms.sqlite'));
      try {
        const existing = new Map(store.list().map(page => [page.slug, page]));
        for (const page of site.pages) {
          const current = existing.get(page.slug);
          store.save({ ...page, revision: current?.revision }, current?.id);
        }
        store.setTheme(site.theme);
        store.setSiteSettings(site.settings);
        if (site.rewards && !record.publishedSourceKey) {
          const { Notes } = require('../services/notes/ledger');
          const notes = new Notes(path.join(dataDir, 'notes.sqlite'));
          try { notes.setProgram(site.key, site.rewards); } finally { notes.close(); }
        }
      } finally { store.close(); }
    }
  } finally { pages.close(); }
}
