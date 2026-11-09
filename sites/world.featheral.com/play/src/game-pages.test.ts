import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { accountPageKeys, gamePage, gamePageKeys, gamePages, primaryGamePageKeys } from './game-pages.ts';
import { guideContent, guideTopics } from './guide.ts';

test('all eleven game routes resolve directory and built entry URLs', () => {
  assert.equal(gamePageKeys.length, 11);
  assert.equal(new Set(Object.values(gamePages).map(page => page.path)).size, 11);
  for (const key of gamePageKeys) {
    assert.equal(gamePage(gamePages[key].path), key);
    assert.equal(gamePage(`${gamePages[key].path}index.html`), key);
  }
  for (const path of ['/', '/constructor/', '/unknown/']) assert.equal(gamePage(path), 'world');
});
test('crafting shares the chat bottom anchor and can cover the mobile header without blocking uncovered controls', () => {
  const css = readFileSync(new URL('./world-chat.css', import.meta.url), 'utf8');
  assert.match(css, /#app\.has-world-chat \.settlement-task-panel:has\(\[data-task="crafting"\]\)\{top:auto;bottom:calc\(var\(--canvas-footer\) \+ var\(--layout-gap\)\);height:auto;max-height:calc\(100dvh - var\(--scene-top\) - var\(--canvas-footer\) - var\(--layout-gap\)\)/);
  assert.match(css, /@media\(max-width:900px\)\{\s*#app\.has-world-chat \.settlement-view:has\(\[data-task="crafting"\]\)\{z-index:7;pointer-events:none\}/);
  assert.match(css, /\.settlement-task-panel:has\(\[data-task="crafting"\]\)\{max-height:calc\(100dvh - var\(--canvas-footer\) - var\(--layout-gap\)\*2\);pointer-events:auto\}/);
  assert.match(css, /\.settlement-view:has\(\[data-task="crafting"\]\) \.settlement-dock\{pointer-events:auto\}/);
});
test('community and guide routes have Korean-first refreshable production entries', () => {
  const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  for (const key of ['communicate', 'federation', 'journal', 'help', 'bank', 'contacts', 'hall-of-fame', 'atlas']) {
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
  assert.deepEqual(primaryGamePageKeys, ['world', 'home', 'market', 'communicate', 'federation', 'hall', 'atlas']);
  assert.deepEqual(accountPageKeys, ['journal', 'help']);
  assert.equal(gamePage('/journal/'), 'journal');
  assert.equal(gamePage('/help/'), 'help');
  assert.equal(gamePage('/contacts/'), 'contacts');
  assert.equal(primaryGamePageKeys.includes('contacts'), false);
  assert.equal(gamePages.communicate.label, 'Inbox');
});
test('game routes preload a boot shell, cross-document transitions and likely next pages', () => {
  const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const transitions = readFileSync(new URL('../public/page-transition.css', import.meta.url), 'utf8');
  assert.match(vite, /page-transition\.css/);
  assert.match(vite, /page-transition-loader/);
  assert.match(main, /document\.addEventListener\('pointerover', prefetchGamePage/);
  assert.match(main, /document\.addEventListener\('focusin', prefetchGamePage/);
  assert.match(main, /prefetch\.rel = 'prefetch'/);
  assert.match(main, /prefetchedGamePages\.has\(url\.href\)/);
  assert.match(transitions, /@view-transition\{navigation:auto\}/);
  assert.match(transitions, /prefers-reduced-motion:reduce/);
  assert.match(transitions, /\.page-transition-loader\{position:fixed;inset:0;[^}]*display:flex;align-items:center;justify-content:center/);
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
