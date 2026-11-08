import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { resolvePublicSite } from './src/site.ts';
import { renderWhitepaper } from './src/whitepaper-render.ts';
import { publicFeatureAt, publicFeaturePages, worldPublicOrigin } from './src/public-feature-content.ts';
import { renderPublicFeatureHead, renderPublicFeatureBody, renderPublicWorldNav } from './src/public-feature-render.ts';

const proxy = { '/api': 'http://127.0.0.1:8080', '/wallet': 'http://127.0.0.1:8080', '/fth.js': 'http://127.0.0.1:8080', '/shared': 'http://127.0.0.1:8080', '^/account/account\\.(?:js|css)$': 'http://127.0.0.1:8080' };
export function publicFeaturePagesPlugin(): Plugin {
  return {
    name: 'featheral-public-feature-pages',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        if (html.includes('<!-- WORLD_PUBLIC_NAV -->'))
          html = html.replace('</head>', '<link rel="stylesheet" href="/shared/world-navigation.css" vite-ignore></head>')
            .replace('<nav aria-label="World site"', '<nav class="world-navigation" aria-label="World site"')
            .replace(/<\/nav>(\s*<\/div><\/header>)/, '</nav><div class="world-wallet-controls" data-wallet-controls></div>$1');
        const page = publicFeatureAt(context.path);
        if (!page) return html.includes('<!-- WORLD_PUBLIC_NAV -->') ? html.replace('<!-- WORLD_PUBLIC_NAV -->', renderPublicWorldNav(context.path)) : undefined;
        return html
          .replace('<!-- WORLD_FEATURE_HEAD -->', renderPublicFeatureHead(page))
          .replace('<!-- WORLD_PUBLIC_NAV -->', renderPublicWorldNav(page.path))
          .replace('<!-- WORLD_FEATURE_BODY -->', renderPublicFeatureBody(page));
      },
    },
  };
}
export function worldAccountPage(): Plugin {
  return {
    name: 'featheral-world-account',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        if (!html.includes('<!-- WORLD_ACCOUNT -->')) return;
        let form = readFileSync(resolve('..', 'account', 'form.html'), 'utf8');
        const login = context.path.includes('login');
        const profile = context.path.includes('account');
        form = form.replace('Join World', login ? 'Sign in to World' : profile ? 'Your World profile' : 'Register for World');
        if (login || profile) form = form.replace('Register with a username and password, or use your own wallet. Your username, avatar and profile description are required and public.',
          login ? 'Sign in to your shared World account to continue to Community or gameplay.' : 'Manage your shared World profile, avatar and encrypted wallet backup.');
        if (login) form = form.replace('data-mode="register" aria-pressed="true"', 'data-mode="register" aria-pressed="false"')
          .replace('data-mode="login" aria-pressed="false"', 'data-mode="login" aria-pressed="true"')
          .replace('id="confirmation"', 'id="confirmation" hidden')
          .replace('name="confirmation" type="password" required', 'name="confirmation" type="password"')
          .replace('Create built-in wallet</button>', 'Sign in</button>')
          .replace(/(<p class="fine" id="password-note">)[^<]+/, '$1Use your existing World password to unlock your encrypted wallet. No new wallet is created. There is no password reset.');
        return html.replace('<!-- WORLD_ACCOUNT -->', form);
      },
    },
  };
}
export function worldProfileAssets(): Plugin {
  return {
    name: 'featheral-world-profile',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!html.includes('src="/src/main.ts"')) return;
        return [
          { tag: 'link', attrs: { rel: 'stylesheet', href: '/shared/wallet-profile.css', 'vite-ignore': true }, injectTo: 'head' },
          { tag: 'script', attrs: { src: '/shared/wallet-profile.js', 'vite-ignore': true }, injectTo: 'head' },
          { tag: 'script', attrs: { src: '/shared/wallet/ethers.js', 'vite-ignore': true }, injectTo: 'head' },
          { tag: 'script', attrs: { src: '/shared/world-account.js', 'vite-ignore': true }, injectTo: 'head' },
          { tag: 'link', attrs: { rel: 'stylesheet', href: '/shared/world-account.css', 'vite-ignore': true }, injectTo: 'head' },
          { tag: 'link', attrs: { rel: 'stylesheet', href: '/shared/featheral.css', 'vite-ignore': true }, injectTo: 'head' },
          { tag: 'script', attrs: { src: '/shared/site-links.js', defer: true, 'vite-ignore': true }, injectTo: 'head' },
        ];
      },
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const file = request.url?.split('?')[0];
        if (file !== '/shared/wallet-profile.js' && file !== '/shared/wallet-profile.css') { next(); return; }
        response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css');
        response.end(readFileSync(resolve('..', '..', '..', 'shared', file.slice('/shared/'.length))));
      });
    },
  };
}
export function whitepaperPage(): Plugin {
  return {
    name: 'featheral-whitepaper-page',
    transformIndexHtml(html, context) {
      if (!['/whitepaper/', '/whitepaper/index.html'].includes(context.path)) return;
      return html
        .replace('<!-- WHITEPAPER_KO -->', renderWhitepaper(readFileSync(resolve('public', 'WHITEPAPER.ko.md'), 'utf8'), 'ko'))
        .replace('<!-- WHITEPAPER_EN -->', renderWhitepaper(readFileSync(resolve('public', 'WHITEPAPER.md'), 'utf8'), 'en'));
    },
  };
}
export function landingSeo(site = resolvePublicSite({ url: worldPublicOrigin, channels: resolvePublicSite().channels })): Plugin {
  const robots = `User-agent: *\nAllow: /\nDisallow: /api/\n${site.url ? `Sitemap: ${site.url}/sitemap.xml\n` : ''}`;
  const landingUrl = `${site.url}/`;
  const location = landingUrl.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sitemap = site.url ? `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${location}</loc></url>${[...publicFeaturePages.map(page => page.path), '/community/', '/whitepaper/'].map(path => `<url><loc>${site.url}${path}</loc></url>`).join('')}</urlset>\n` : null;
  const channels = Object.values(site.channels).filter(Boolean);
  const schema = {
    '@context': 'https://schema.org', '@type': 'WebApplication', name: 'Featheral',
    applicationCategory: 'GameApplication', operatingSystem: 'Web browser', inLanguage: ['ko', 'en'],
    isAccessibleForFree: true, genre: ['Simulation', 'Strategy', 'Educational'],
    description: 'Explore 21 terrain types, build settlements and join federations in Featheral World. One account connects your profile, community posts and settlement. No payment is required to register.',
    ...(site.url ? { url: landingUrl, image: `${site.url}/images/social-preview-ko.png` } : {}),
    ...(channels.length ? { sameAs: channels } : {}),
  };
  return {
    name: 'featheral-public-site',
    transformIndexHtml(_html, context) {
      if (['/whitepaper/', '/whitepaper/index.html'].includes(context.path)) {
        return site.url ? [{ tag: 'link', attrs: { rel: 'canonical', href: `${site.url}/whitepaper/` }, injectTo: 'head' }] : [];
      }
      if (!['/', '/index.html'].includes(context.path)) return;
      return [
        { tag: 'script', attrs: { type: 'application/ld+json' }, children: JSON.stringify(schema).replace(/</g, '\\u003c'), injectTo: 'head' },
        ...(site.url ? [
          { tag: 'link', attrs: { rel: 'canonical', href: landingUrl }, injectTo: 'head' as const },
          ...[
            ['og:url', landingUrl], ['og:image', `${site.url}/images/social-preview-ko.png`],
            ['og:image:width', '1200'], ['og:image:height', '630'],
            ['og:image:alt', 'Featheral: 작은 세계, 더 큰 목소리. 나무로 둘러싸인 정착지의 일러스트.'],
          ].map(([property, content]) => ({ tag: 'meta', attrs: { property, content }, injectTo: 'head' as const })),
          { tag: 'meta', attrs: { name: 'twitter:image', content: `${site.url}/images/social-preview-ko.png` }, injectTo: 'head' as const },
        ] : []),
      ];
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0];
        if (!['/robots.txt', '/sitemap.xml'].includes(path ?? '')) { next(); return; }
        const body = path === '/robots.txt' ? robots : sitemap;
        response.statusCode = body === null ? 404 : 200;
        response.setHeader('Content-Type', path?.endsWith('/sitemap.xml') && body ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8');
        response.end(body ?? 'Sitemap is unavailable until the public site URL is configured.');
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robots });
      if (sitemap) this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemap });
    },
  };
}
export default defineConfig({
  base: '/',
  appType: 'mpa',
  plugins: [landingSeo(), publicFeaturePagesPlugin(), whitepaperPage(), worldProfileAssets(), worldAccountPage()],
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy },
  build: {
    rollupOptions: {
      input: {
        index: resolve('index.html'),
        'account/index': resolve('account', 'index.html'),
        'login/index': resolve('login', 'index.html'),
        'register/index': resolve('register', 'index.html'),
        'explore/index': resolve('explore', 'index.html'),
        'settlement/index': resolve('settlement', 'index.html'),
        'market/index': resolve('market', 'index.html'),
        'communicate/index': resolve('communicate', 'index.html'),
        'federation/index': resolve('federation', 'index.html'),
        'contacts/index': resolve('contacts', 'index.html'),
        'journal/index': resolve('journal', 'index.html'),
        'help/index': resolve('help', 'index.html'),
        'bank/index': resolve('bank', 'index.html'),
        'whitepaper/index': resolve('whitepaper', 'index.html'),
        ...Object.fromEntries(publicFeaturePages.map(page => [page.path.slice(1) + 'index', resolve(page.path.slice(1), 'index.html')])),
      },
    },
  },
});
