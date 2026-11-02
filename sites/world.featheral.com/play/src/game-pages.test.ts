import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { accountPageKeys, gamePage, gamePageKeys, gamePages, primaryGamePageKeys } from './game-pages.ts';
import { guideContent, guideTopics } from './guide.ts';

test('all nine game routes resolve directory and built entry URLs', () => {
  assert.equal(gamePageKeys.length, 9);
  assert.equal(new Set(Object.values(gamePages).map(page => page.path)).size, 9);
  for (const key of gamePageKeys) {
    assert.equal(gamePage(gamePages[key].path), key);
    assert.equal(gamePage(`${gamePages[key].path}index.html`), key);
  }
  for (const path of ['/', '/constructor/', '/unknown/']) assert.equal(gamePage(path), 'world');
});
test('community and guide routes have Korean-first refreshable production entries', () => {
  const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  for (const key of ['communicate', 'federation', 'journal', 'help', 'bank', 'contacts']) {
    const html = readFileSync(new URL(`../${key}/index.html`, import.meta.url), 'utf8');
    assert.match(html, /<html lang="ko">/);
    assert.match(html, /noindex,follow/);
    assert.match(html, /src="\/src\/main.ts"/);
    const entry = `'${key}/index': resolve('${key}', 'index.html')`;
    assert.ok(vite.includes(entry));
  }
  assert.ok(vite.includes("index: resolve('index.html')"));
  assert.ok(vite.includes("'settlement/index': resolve('settlement', 'index.html')"));
  const localization = readFileSync(new URL('./i18n-dom.ts', import.meta.url), 'utf8');
  assert.match(localization, /Object\.values\(gamePages\)\.map\(page => page\.path\)/);
});
test('Journal and Help move into Account without losing their direct routes', () => {
  assert.deepEqual(primaryGamePageKeys, ['world', 'home', 'market', 'communicate', 'federation']);
  assert.deepEqual(accountPageKeys, ['journal', 'help']);
  assert.equal(gamePage('/journal/'), 'journal');
  assert.equal(gamePage('/help/'), 'help');
  assert.equal(gamePage('/contacts/'), 'contacts');
  assert.equal(primaryGamePageKeys.includes('contacts'), false);
  assert.equal(gamePages.communicate.label, 'Inbox');
});
test('the continuous encyclopedia has unique chapters, real bilingual screenshots and accessible search/progress', () => {
  assert.equal(guideTopics.length, 8);
  assert.equal(new Set(guideTopics.map(topic => topic.id)).size, guideTopics.length);
  for (const language of ['ko', 'en'] as const) {
    const html = guideContent(language);
    assert.equal((html.match(/<article /g) ?? []).length, 8);
    assert.equal((html.match(/<figure>/g) ?? []).length, 4);
    assert.match(html, /type="search"/);
    assert.match(html, /<progress id="guide-progress"/);
    assert.match(html, /data-guide-empty hidden/);
    assert.doesNotMatch(html, /role="dialog"|<details/);
    for (const topic of guideTopics) {
      assert.ok(html.includes(`href="#guide-${topic.id}"`));
      assert.ok(html.includes(`id="guide-${topic.id}"`));
      if ('image' in topic) {
        const screenshot = readFileSync(new URL(`../public/images/guide/${language}/${topic.image}.jpg`, import.meta.url));
        assert.ok(screenshot.length > 2000, topic.image);
        assert.equal(screenshot.readUInt16BE(0), 0xffd8);
        assert.ok(html.includes(`/images/guide/${language}/${topic.image}.jpg`));
      }
    }
  }
});
