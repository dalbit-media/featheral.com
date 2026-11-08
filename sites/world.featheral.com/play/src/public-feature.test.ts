import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { publicFeatureAt, publicFeaturePages, publicWorldLinks, worldPublicOrigin } from './public-feature-content.ts';
import { renderPublicFeatureHead, renderPublicFeatureBody, renderPublicWorldNav } from './public-feature-render.ts';
import { drawPublicPreview } from './public-feature-preview.ts';
import { landingSeo, publicFeaturePagesPlugin, worldAccountPage } from '../vite.config.ts';

test('all six public routes have unique, bilingual content and do not replace game entries', async () => {
  assert.deepEqual(publicFeaturePages.map(page => page.path), [
    '/features/exploration/', '/features/settlements/', '/features/marketplace/', '/features/federations/', '/guide/', '/roadmap/',
  ]);
  assert.equal(new Set(publicFeaturePages.map(page => page.title[0])).size, 6);
  const plugin = publicFeaturePagesPlugin();
  const transform = typeof plugin.transformIndexHtml === 'object' ? plugin.transformIndexHtml.handler : plugin.transformIndexHtml;
  if (typeof transform !== 'function') throw new Error('Missing public feature transform');
  for (const page of publicFeaturePages) {
    assert.equal(publicFeatureAt(`${page.path}index.html`), page);
    assert.equal(publicFeatureAt(`${page.path}?lang=ko`), page);
    for (const pair of [page.title, page.description, page.headline, page.lead, page.action, page.note,
      ...page.steps, ...page.cards.flatMap(card => [card.title, card.body])]) {
      assert.ok(pair[0].trim());
      assert.match(pair[1], /[가-힣]/);
    }
    const template = readFileSync(new URL(`..${page.path}index.html`, import.meta.url), 'utf8');
    const html = await transform(template, { path: page.path, filename: `${page.path}index.html` });
    assert.equal(typeof html, 'string');
    if (typeof html !== 'string') throw new Error('Missing rendered public HTML');
    assert.doesNotMatch(html, /<!-- WORLD_(FEATURE|PUBLIC)/);
    assert.equal((html.match(/<h1 /g) ?? []).length, 1);
    assert.equal((html.match(/<article>/g) ?? []).length, 3);
    assert.match(html, /<main id="main"/);
    assert.match(html, /<title data-public-en=/);
    assert.ok(html.includes(page.headline[0]));
    assert.ok(html.includes(`href="${page.gamePath}"`));
    assert.match(html, /aria-current="page"/);
    assert.doesNotMatch(html, /src="\/src\/main.ts"|WORLD_ACCOUNT|id="walletButton"/);
  }
  for (const path of ['/explore/', '/settlement/', '/market/', '/federation/', '/help/', '/', '/account/']) {
    assert.equal(publicFeatureAt(path), undefined);
    assert.equal(await transform('<main>Game / account content</main>', { path, filename: path }), undefined);
  }
});

test('shared public navigation and homepage use public destinations and same-tab Play', () => {
  const homepage = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const header = homepage.match(/<header class="top world-header"[\s\S]*?<\/header>/)![0];
  const nav = renderPublicWorldNav('/features/exploration/');
  for (const link of publicWorldLinks) {
    assert.match(header, /<!-- WORLD_PUBLIC_NAV -->/);
    assert.ok(nav.includes(`href="${link.path}"`), `Public nav ${link.path}`);
  }
  assert.equal((nav.match(/aria-current="page"/g) ?? []).length, 1);
  assert.doesNotMatch(nav + header, /target="_blank"|data-game-window/);
  assert.doesNotMatch(header, /href="\/(settlement|market|federation|help)\/"/);
  assert.doesNotMatch(homepage, /<!-- WORLD_ACCOUNT -->|src="\/src\/account-setup.ts"/);
  assert.equal((nav.match(/class="world-submenu"/g) ?? []).length, 3);
  assert.match(nav, /<summary data-public-en="Game"/);
  assert.match(nav, /<summary data-public-en="About"/);
  assert.match(readFileSync(new URL('./landing.ts', import.meta.url), 'utf8'), /localizePublicCopy\(document\)/);
});

test('feature metadata is crawlable, escaped and canonical on the production origin', () => {
  for (const page of publicFeaturePages) {
    const head = renderPublicFeatureHead(page);
    assert.ok(head.includes(`rel="canonical" href="${worldPublicOrigin}${page.path}"`));
    assert.ok(head.includes(`hreflang="ko" href="${worldPublicOrigin}${page.path}?lang=ko"`));
    assert.match(head, /name="description" content="[^"]+"/);
    assert.match(head, /property="og:url"/);
    const schema = JSON.parse(head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]);
    assert.equal(schema['@type'], 'WebPage');
    assert.equal(schema.url, `${worldPublicOrigin}${page.path}`);
    const body = renderPublicFeatureBody(page);
    assert.match(body, /<h2 /);
    assert.match(body, /<aside /);
    assert.ok(body.includes('data-public-ko='));
  }
  const page = { ...publicFeaturePages[0], headline: ['A <script> & "title"', '제목'] as const };
  const escaped = renderPublicFeatureBody(page);
  assert.match(escaped, /A &lt;script&gt; &amp; &quot;title&quot;/);
  assert.doesNotMatch(escaped, /<script>/);
});

test('default production SEO emits sitemap entries for public pages, not game routes', () => {
  const plugin = landingSeo();
  const assets: { fileName: string; source: string }[] = [];
  if (typeof plugin.generateBundle !== 'function') throw new Error('Missing sitemap generator');
  Reflect.apply(plugin.generateBundle, { emitFile: (asset: typeof assets[number]) => assets.push(asset) }, []);
  const sitemap = assets.find(asset => asset.fileName === 'sitemap.xml')!.source;
  for (const path of ['/', ...publicFeaturePages.map(page => page.path), '/community/', '/whitepaper/']) {
    assert.equal(sitemap.split(`<loc>${worldPublicOrigin}${path}</loc>`).length - 1, 1, path);
  }
  assert.doesNotMatch(sitemap, /<loc>[^<]+\/(explore|settlement|market|federation|help|account)\//);
  assert.ok(assets.find(asset => asset.fileName === 'robots.txt')!.source.includes(`Sitemap: ${worldPublicOrigin}/sitemap.xml`));
});

test('roadmap names World building and distinguishes business/governance direction from available features', () => {
  const roadmap = publicFeatureAt('/roadmap/')!;
  assert.match(roadmap.lead[0], /Current phase · World building/);
  assert.match(roadmap.lead[1], /현재 단계 · 월드 구축/);
  assert.match(roadmap.note[0], /standalone revenue-generating business/);
  assert.match(roadmap.note[0], /proposed direction, not a deployed governance right/);
  assert.match(roadmap.cards[1].body[0], /payouts remain pending/);
});

test('dedicated registration transform inserts the shared form exactly once and leaves the homepage unchanged', async () => {
  const plugin = worldAccountPage();
  const transform = typeof plugin.transformIndexHtml === 'object' ? plugin.transformIndexHtml.handler : plugin.transformIndexHtml;
  if (typeof transform !== 'function') throw new Error('Missing account transform');
  const result = await transform(readFileSync(new URL('../register/index.html', import.meta.url), 'utf8'), { path: '/register/', filename: 'register/index.html' });
  if (typeof result !== 'string') throw new Error('Missing transformed registration page');
  assert.equal((result.match(/id="credentials"/g) ?? []).length, 1);
  assert.equal((result.match(/id="profile-editor"/g) ?? []).length, 1);
  assert.doesNotMatch(result, /<!-- WORLD_ACCOUNT -->/);
  assert.equal(await transform(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), { path: '/', filename: 'index.html' }), undefined);
});

test('public copy reuses the selected language and preserves account hashes on navigation', () => {
  const source = readFileSync(new URL('./public-feature-i18n.ts', import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source.replace(/^import .*;\r?\n/, '').replace('export function', 'function'));
  class Meta {
    content = '';
    dataset = { publicEn: 'English metadata', publicKo: '한국어 메타데이터' };
  }
  const meta = new Meta();
  const heading = { textContent: '', dataset: { publicEn: 'English heading', publicKo: '한국어 제목' } };
  const canvas = { dataset: { publicAriaEn: 'Terrain sample', publicAriaKo: '지형 예시' }, label: '',
    setAttribute(_name: string, value: string) { this.label = value; } };
  const account = { href: `${worldPublicOrigin}/#account` };
  const feature = { href: `${worldPublicOrigin}/features/settlements/` };
  const external = { href: 'https://example.test/' };
  const root = { querySelectorAll(selector: string) {
    if (selector.startsWith('[data-public-en]')) return [meta, heading];
    if (selector.startsWith('[data-public-aria-en]')) return [canvas];
    return [account, feature, external];
  } };
  for (const language of ['en', 'ko']) {
    const localize = runInNewContext(`${code}; localizePublicCopy;`, { language, HTMLMetaElement: Meta, location: { origin: worldPublicOrigin }, URL });
    localize(root);
    assert.equal(meta.content, language === 'ko' ? '한국어 메타데이터' : 'English metadata');
    assert.equal(heading.textContent, language === 'ko' ? '한국어 제목' : 'English heading');
    assert.equal(canvas.label, language === 'ko' ? '지형 예시' : 'Terrain sample');
    assert.equal(account.href, `${worldPublicOrigin}/?lang=${language}#account`);
    assert.equal(feature.href, `${worldPublicOrigin}/features/settlements/?lang=${language}`);
    assert.equal(external.href, 'https://example.test/');
  }
});

test('actual game drawing primitives produce deterministic, non-animated public scenes without account APIs', () => {
  for (const kind of ['exploration', 'settlements']) {
    const commands: string[] = [];
    const context = new Proxy({}, { get(_target, key) { return (...args: unknown[]) => { commands.push(`${String(key)}:${JSON.stringify(args)}`); }; },
      set(_target, key, value) { commands.push(`${String(key)}=${value}`); return true; } }) as CanvasRenderingContext2D;
    drawPublicPreview(context, kind);
    assert.equal(commands.filter(command => command === 'closePath:[]').length >= 64, true);
    const first = commands.join('\n');
    commands.length = 0;
    drawPublicPreview(context, kind);
    assert.equal(commands.join('\n'), first);
  }
  const source = readFileSync(new URL('./public-feature-preview.ts', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/map-art.ts'/);
  assert.match(source, /terrainAt\(/);
  assert.doesNotMatch(source, /fetch\(|localStorage|requestAnimationFrame|setInterval|new Image/);
  const notes = publicFeaturePages.map(page => page.note[0]).join(' ');
  assert.match(notes, /not your saved world/);
  assert.match(notes, /withdrawals and payouts are not available|Tax collection, payout rates and eligibility are pending/);
  assert.match(publicFeaturePages.find(page => page.visual === 'roadmap')!.lead[0], /not a delivery schedule/);
});
