const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../../db-api/sqlite');
const { SyncRunner } = require('./sync');
const CmsStore = require('./cms');
const Templates = require('./templates');
const { DATA_DIR } = require('./store');

const error = (status, message) => Object.assign(new Error(message), { status });

function hostname(value) {
  if (typeof value !== 'string') throw error(400, 'A site hostname is required');
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (host.length > 253 || !host.includes('.') ||
      !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw error(400, 'Enter a hostname such as news.featheral.com, without a URL or path');
  }
  return host;
}

class SiteManager {
  constructor({ dataDir = DATA_DIR, registryFile, cmsHost, defaultHost, defaultKey } = {}) {
    this.dataDir = dataDir;
    this.cmsHost = cmsHost;
    this.file = registryFile || path.join(dataDir, 'sites.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.records = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : [];
    if (!Array.isArray(this.records)) throw new Error('Invalid site registry: expected an array');
    if (defaultHost && defaultKey && fs.existsSync(path.join(dataDir, defaultKey, 'manifest.json')) &&
        !this.records.some((record) => record.hostname === defaultHost)) {
      if (this.records.some((record) => record.key === defaultKey)) {
        throw new Error('The default data folder is already registered to another site');
      }
      this.records.push({ key: defaultKey, hostname: hostname(defaultHost), name: defaultHost });
      this.persist();
    }
  }

  persist() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list() {
    return this.records.map((record) => {
      const dir = path.join(this.dataDir, record.key);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      return {
        ...manifest, ...record, site: record.name, siteUrl: `https://${record.hostname}${record.path || ''}/`,
        localDir: dir, managed: true,
      };
    });
  }

  create(input) {
    if (input?.template && !Templates.TEMPLATES[input.template]) throw error(400, 'Unknown sample template');
    const host = hostname(input?.hostname);
    const slug = input?.slug;
    if (slug !== undefined && (host !== 'sites.featheral.com' || typeof slug !== 'string'
      || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)
      || ['api', 'site', 'shared', 'media', 'admin', 'operations', 'healthz'].includes(slug)))
      throw error(400, 'Free website names must be lowercase letters, numbers or hyphens, at most 63 characters, and cannot use reserved routes');
    const sitePath = slug === undefined ? '' : `/${slug}`;
    if (['featheral.com', 'gold.featheral.com', 'dollar.featheral.com', 'world.featheral.com'].includes(host))
      throw error(409, 'This is an integrated application site. Edit its CMS content and theme from Sites instead.');
    if (host === this.cmsHost || host === 'cms.featheral.com') throw error(409, 'The admin hostname and retired CMS alias cannot be used for a public site');
    if (this.records.some((record) => record.hostname === host && (record.path || '') === sitePath)) throw error(409, 'That site already exists');
    const key = host.replace(/\./g, '-') + (slug === undefined ? '' : `--${slug}`);
    const dir = path.join(this.dataDir, key);
    if (fs.existsSync(dir)) throw error(409, 'A data folder already exists for that hostname');
    const name = String(input.name || host).trim().slice(0, 200) || host;
    const record = { key, hostname: host, name, ...(sitePath ? { path: sitePath } : {}) };
    const manifest = {
      key, site: name, siteUrl: `https://${host}${sitePath}/`, hostname: host, managed: true,
      status: 'ready', date: new Date().toISOString(), mediaMode: 'none',
      stats: { counts: {}, uploads: { files: 0, images: 0, originals: 0, size: 0 } },
    };
    fs.mkdirSync(dir);
    try {
      fs.mkdirSync(path.join(dir, 'uploads'));
      manifest.db = new SyncRunner().writeDb(path.join(dir, 'db.sqlite'), key, {
        posts: new Map(), postmeta: [], terms: new Map(), rels: [], comments: [],
        users: new Map(), usermeta: [], raw: [],
        options: { blogname: name, home: manifest.siteUrl, siteurl: manifest.siteUrl },
      }, { contentFormat: 'rendered', api: { siteUrl: manifest.siteUrl, requests: 0 }, manifest });
      const cms = new CmsStore(path.join(dir, 'cms.sqlite'));
      try {
        const template = input.template !== undefined ? input.template : sitePath ? 'website' : null;
        if (template) Templates.install(cms, template);
        if (sitePath) cms.setSiteSettings({ ...cms.siteSettings(), displayName: name });
      } finally { cms.close(); }
      open(path.join(dir, 'public.sqlite')).close();
      fs.writeFileSync(path.join(dir, 'uploads-index.json'), '[]');
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
      this.records.push(record);
      try { this.persist(); } catch (e) { this.records.pop(); throw e; }
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    return this.list().find((site) => site.key === key);
  }
}

module.exports = { SiteManager, hostname };
