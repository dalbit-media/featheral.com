const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const CmsStore = require('../lib/cms');
const { PublicSite } = require('../lib/public');
const FthxPages = require('../lib/fthx');

test('untouched FTHX pages explain native notes without overwriting edited content', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-note-docs-'));
  const cms = new CmsStore(path.join(dir, 'cms.sqlite'));
  t.after(() => { cms.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  FthxPages.installNotes(cms);
  const home = cms.list().find(page => page.slug === 'fthx');
  assert.match(home.body, /Neither can be earned through regular likes/);
  assert.doesNotMatch(home.body, /default 10%, 1 FTHX/);
  FthxPages.installNotes(cms);
  assert.equal(cms.get(home.id).revision, home.revision);
  cms.save({ ...home, body: 'My custom note page' }, home.id);
  FthxPages.installNotes(cms);
  assert.equal(cms.get(home.id).body, 'My custom note page');
});

test('CMS content saves drafts, publishes into the public Read list, and supports themes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'featheral-cms-'));
  const site = {
    dir, manifest: { site: 'CMS test' }, memo: {},
    options: () => ({}), has: () => false, defaultTypes: () => [],
    postMetrics: () => new Map(), trashed: new Set(),
  };
  const pub = new PublicSite(site, { brand: 'CMS test' });
  t.after(() => { pub.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const draft = pub.cms.save({ title: 'Private draft', type: 'page', body: 'Do not publish yet' });
  assert.equal(draft.status, 'draft');
  assert.equal(pub.textList({}).total, 0);

  const published = pub.cms.save({
    title: 'A CMS story', slug: 'cms-story', type: 'post', status: 'publish',
    excerpt: 'A short excerpt', body: 'First paragraph.\n\nSecond paragraph.',
  });
  assert.equal(pub.info().theme, 'featheral');
  assert.deepEqual(pub.cms.setTheme('ocean'), { theme: 'ocean' });
  assert.equal(pub.info().theme, 'ocean');

  const list = pub.textList({ sort: 'newest' });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].id, -published.id);
  assert.equal(list.items[0].title, 'A CMS story');
  assert.equal(list.items[0].snippet, 'A short excerpt');
  assert.deepEqual(pub.text(-published.id).paragraphs, ['First paragraph.', 'Second paragraph.']);
  assert.equal(pub.view(-published.id, 'visitor-1').counted, true);

  assert.throws(() => pub.cms.setTheme('unknown'), { status: 400 });
  assert.throws(() => pub.cms.save({ title: 'Duplicate slug', slug: 'cms-story' }), { status: 409 });
  assert.equal(pub.cms.save({ ...published, status: 'draft' }, published.id).status, 'draft');
  assert.equal(pub.text(-published.id), null);
  assert.throws(() => pub.cms.delete(999), { status: 404 });
});

test('FTHX pages publish through CMS and retain edits, drafts, and deletions across restarts', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fthx-cms-'));
  const file = path.join(dir, 'cms.sqlite');
  let cms = new CmsStore(file);
  t.after(() => { cms.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  FthxPages.install(cms);
  assert.deepEqual(cms.publicPages().map((p) => p.slug), ['fthx', 'fthx-whitepaper']);
  const landing = cms.publishedPage('fthx');
  const paper = cms.publishedPage('fthx-whitepaper');
  assert.match(landing.body, /Featheral X Media Archiving and Streaming Platform/);
  assert.match(paper.body, /Featheral governance/);
  assert.match(paper.body, /threshold.*must be approved/);
  assert.match(paper.body, /not an on-chain asset/);
  assert.doesNotMatch(landing.body + paper.body, /QPRN/);
  cms.save({ ...landing, title: 'Updated by the editor', status: 'draft' }, landing.id);
  cms.delete(paper.id);
  cms.close();
  cms = new CmsStore(file);
  FthxPages.install(cms);
  assert.equal(cms.list().length, 1);
  assert.equal(cms.get(landing.id).title, 'Updated by the editor');
  assert.equal(cms.get(landing.id).status, 'draft');
  assert.deepEqual(cms.publicPages(), []);
});

test('FTHX installation preserves existing slugs and does not seed other CMS databases', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fthx-existing-'));
  const cms = new CmsStore(path.join(dir, 'cms.sqlite'));
  const other = new CmsStore(path.join(dir, 'other.sqlite'));
  t.after(() => { cms.close(); other.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const existing = cms.save({ title: 'My landing', slug: 'fthx', body: 'Keep this draft', type: 'page' });
  FthxPages.install(cms);
  assert.deepEqual(cms.get(existing.id), existing);
  assert.deepEqual(cms.publicPages().map((p) => p.slug), ['fthx-whitepaper']);
  assert.deepEqual(other.list(), []);
});

test('FTHX page installation rolls back partial content and can be retried', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fthx-rollback-'));
  const cms = new CmsStore(path.join(dir, 'cms.sqlite'));
  t.after(() => { cms.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const save = cms.save;
  let calls = 0;
  cms.save = function (...args) {
    if (++calls === 2) throw new Error('Write failed');
    return save.apply(this, args);
  };
  assert.throws(() => FthxPages.install(cms), /Write failed/);
  assert.deepEqual(cms.list(), []);
  assert.equal(cms.store.get('settings', 'fthx-pages-v1'), undefined);
  cms.save = save;
  FthxPages.install(cms);
  assert.equal(cms.publicPages().length, 2);
});

test('CMS revisions prevent stale saves, restore versions and isolate history by content', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-revisions-'));
  const file = path.join(dir, 'cms.sqlite');
  let cms = new CmsStore(file);
  t.after(() => { cms.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const original = cms.save({ title: 'Original', body: 'Original body', status: 'publish' });
  const updated = cms.save({ ...original, title: 'Updated', revision: original.revision }, original.id);
  assert.equal(updated.revision, 2);
  assert.throws(() => cms.save({ ...original, title: 'Stale edit' }, original.id), { status: 409 });
  assert.equal(cms.get(original.id).title, 'Updated');
  const other = cms.save({ title: 'Other' });
  const history = cms.revisions(original.id);
  assert.equal(history[0].snapshot.body, 'Original body');
  assert.throws(() => cms.restore(other.id, history[0].id, other.revision), { status: 404 });
  const restored = cms.restore(original.id, history[0].id, updated.revision);
  assert.equal(restored.title, 'Original');
  assert.equal(restored.revision, 3);
  assert.throws(() => cms.restore(original.id, history[0].id, updated.revision), { status: 409 });
  for (let i = 0; i < 25; i++) cms.save({ ...cms.get(original.id), title: `Version ${i}` }, original.id);
  assert.equal(cms.revisions(original.id).length, 20);
  const copy = cms.duplicate(original.id);
  assert.equal(copy.status, 'draft');
  assert.notEqual(copy.slug, restored.slug);
  assert.notEqual(cms.duplicate(original.id).slug, copy.slug);
  cms.close(); cms = new CmsStore(file);
  assert.equal(cms.revisions(original.id).length, 20);
});

test('CMS landing homepages stay valid and branding settings preserve omitted metadata', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-home-'));
  const cms = new CmsStore(path.join(dir, 'cms.sqlite'));
  t.after(() => { cms.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const page = cms.save({ title: 'Home', type: 'page', status: 'publish', body: 'Welcome' });
  const settings = { ...cms.siteSettings(), homepage: 'content', homeSlug: page.slug, displayName: 'My publication', description: 'A short description', footer: 'Independent ideas' };
  cms.setSiteSettings(settings);
  for (const patch of [{ status: 'draft' }, { slug: 'changed' }, { type: 'post' }]) {
    assert.throws(() => cms.save({ ...page, ...patch }, page.id), { status: 409 });
  }
  assert.throws(() => cms.delete(page.id), { status: 409 });
  assert.throws(() => cms.setSiteSettings({ ...settings, homeSlug: 'missing' }), { status: 400 });
  assert.throws(() => cms.setSiteSettings({ ...settings, displayName: 'a'.repeat(201) }), { status: 400 });
  const { displayName, description, footer, ...legacy } = settings;
  assert.equal(cms.setSiteSettings(legacy).displayName, 'My publication');
  cms.setSiteSettings({ ...settings, homepage: 'media' });
  assert.equal(cms.delete(page.id).ok, true);
});
