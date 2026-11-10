import { publicFeaturePages, publicWorldLinks, worldPublicOrigin } from './public-feature-content.ts';
import type { PublicCopy, PublicFeature } from './public-feature-content.ts';
import { readFileSync } from 'node:fs';

const escape = (value: string): string => value.replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const copy = (value: PublicCopy): string => `data-public-en="${escape(value[0])}" data-public-ko="${escape(value[1])}"`;
const text = (tag: string, value: PublicCopy, attributes = ''): string => `<${tag} ${copy(value)} ${attributes}>${escape(value[0])}</${tag}>`;

export function renderPublicWorldNav(current = ''): string {
  const page = publicFeaturePages.find(page => page.path === current);
  if (page) current = ['guide', 'roadmap'].includes(page.visual) ? `/#${page.visual}` : '/';
  if (['/login/', '/register/'].includes(current)) current = '/account/';
  return readFileSync(new URL('../../../../shared/world-navigation.html', import.meta.url), 'utf8')
    .replace(`href="${current}"`, `href="${current}" aria-current="page"`);
}

export function renderPublicFeatureHead(page: PublicFeature): string {
  const canonical = `${worldPublicOrigin}${page.path}`;
  const schema = {
    '@context': 'https://schema.org', '@type': 'WebPage', name: page.title[0],
    description: page.description[0], url: canonical, inLanguage: ['en', 'ko'],
    isPartOf: { '@type': 'WebSite', name: 'Featheral World', url: `${worldPublicOrigin}/` },
  };
  return `${text('title', page.title)}
    <meta name="description" content="${escape(page.description[0])}" ${copy(page.description)}>
    <link rel="canonical" href="${canonical}">
    <link rel="alternate" hreflang="en" href="${canonical}?lang=en">
    <link rel="alternate" hreflang="ko" href="${canonical}?lang=ko">
    <link rel="alternate" hreflang="x-default" href="${canonical}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Featheral World">
    <meta property="og:title" content="${escape(page.title[0])}" ${copy(page.title)}>
    <meta property="og:description" content="${escape(page.description[0])}" ${copy(page.description)}>
    <meta property="og:url" content="${canonical}">
    <meta property="og:locale" content="en_US">
    <meta property="og:locale:alternate" content="ko_KR">
    <meta name="twitter:card" content="summary">
    <script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>`;
}

export function renderPublicFeatureBody(page: PublicFeature): string {
  const isMap = page.visual === 'exploration' || page.visual === 'settlements';
  const visual = `<div class="public-visual-header">${text('span', page.label)}${text('span', ['World preview', '월드 미리보기'])}</div>
    <canvas data-public-map="${isMap ? page.visual : 'settlements'}" width="720" height="420" role="img" aria-label="Sample isometric terrain rendered with World game artwork" data-public-aria-en="Sample isometric terrain rendered with World game artwork" data-public-aria-ko="World 게임 그림 코드로 렌더링한 등각 지형 예시">Sample terrain preview. The feature descriptions below are available without JavaScript.</canvas>
    <ol class="public-flow">${page.steps.map((step, index) => `<li><span class="flow-number" aria-hidden="true">0${index + 1}</span>${text('strong', step)}</li>`).join('')}</ol>`;
  return `<div class="public-breadcrumb"><a href="/" data-public-en="Home" data-public-ko="홈">Home</a><span aria-hidden="true">/</span>${text('span', page.label)}</div>
    <section class="public-hero" aria-labelledby="feature-title">
      <div><p class="public-eyebrow">FEATHERAL WORLD · ${escape(page.label[0].toUpperCase())}</p>
        ${text('h1', page.headline, 'id="feature-title"')}
        ${text('p', page.lead, 'class="public-lead"')}
        <div class="public-actions">${text('a', page.action, `href="${page.gamePath}" class="public-button"`)}
          ${text('a', ['Read the whitepaper', '백서 읽기'], 'href="/whitepaper/" class="public-secondary"')}</div>
        ${text('p', ['Browser simulation · early prototype · English / 한국어', '브라우저 시뮬레이션 · 초기 프로토타입 · English / 한국어'], 'class="public-caption"')}
      </div>
      <figure class="public-visual" data-visual="${page.visual}">${visual}
        ${text('figcaption', ['Sample scene · actual game drawing code · not live player data', '예시 장면 · 실제 게임 그림 코드 · 실시간 플레이어 데이터 아님'])}
      </figure>
    </section>
    <section class="public-details" aria-labelledby="details-title">
      ${text('h2', ['What to expect', '알아둘 내용'], 'id="details-title"')}
      <div class="public-cards">${page.cards.map(card => `<article>${text('h3', card.title)}${text('p', card.body)}</article>`).join('')}</div>
    </section>
    <aside class="public-note" aria-labelledby="note-title">${text('h2', ['Current scope', '현재 범위'], 'id="note-title"')}${text('p', page.note)}</aside>
    <section class="public-next" aria-labelledby="next-title">${text('h2', ['Keep exploring', '계속 살펴보기'], 'id="next-title"')}
      <nav aria-label="Related World pages">${publicWorldLinks.filter(link => !['/', page.path, '/account/', '/login/', '/register/', '/explore/', '/community/'].includes(link.path)).map(link => text('a', link.label, `href="${link.path}"`)).join('')}</nav>
    </section>`;
}
