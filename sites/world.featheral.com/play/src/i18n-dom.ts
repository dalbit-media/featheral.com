import { languageStorageKey, locale, resolveLanguage, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { gamePages } from './game-pages.ts';

function storedLanguage(): string | null {
  try { return localStorage.getItem(languageStorageKey); }
  catch (error) {
    console.warn('Language preference could not be read; using the English default.', error);
    return null;
  }
}
export const language: Language = resolveLanguage(new URL(location.href).searchParams.get('lang') ?? storedLanguage());
export const languageLocale = locale(language);
document.documentElement.lang = language;

export function wireLanguageControls(root: ParentNode = document): void {
  root.querySelectorAll<HTMLSelectElement>('[data-language]').forEach(select => {
    select.value = language;
    select.addEventListener('change', () => {
      const selected = resolveLanguage(select.value);
      try { localStorage.setItem(languageStorageKey, selected); }
      catch (error) { console.warn('Language preference could not be saved; the URL retains this choice.', error); }
      const url = new URL(location.href);
      url.searchParams.set('lang', selected);
      location.assign(url.href);
    });
  });
}
const attributes = ['aria-label', 'aria-description', 'aria-valuetext', 'title', 'alt', 'placeholder'];
export function localize(root: ParentNode): void {
  const elements = [...root.querySelectorAll('*')];
  if (root instanceof Element) elements.unshift(root);
  for (const element of elements) {
    if (element.closest('script, style, noscript, code, [data-no-localize]')) continue;
    for (const attribute of attributes) {
      const value = element.getAttribute(attribute);
      if (value) {
        const translated = translate(value, language);
        if (translated !== value) element.setAttribute(attribute, translated);
      }
    }
    if (element instanceof HTMLMetaElement && element.hasAttribute('content')
      && ['description', 'og:title', 'og:description', 'og:image:alt', 'twitter:title', 'twitter:description'].includes(element.name || element.getAttribute('property') || '')) {
      const translated = translate(element.content, language);
      if (translated !== element.content) element.content = translated;
    }
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
        const translated = translate(node.textContent, language);
        if (translated !== node.textContent) node.textContent = translated;
      }
    }
    if (element instanceof HTMLAnchorElement && ['/WHITEPAPER.md', '/WHITEPAPER.ko.md'].includes(element.getAttribute('href') ?? '')) {
      element.href = '/play/whitepaper/';
    }
    if (element instanceof HTMLAnchorElement && element.getAttribute('href')?.startsWith('/')) {
      const url = new URL(element.href);
      if (url.origin === location.origin && ['/play/about/', '/play/whitepaper/', ...Object.values(gamePages).map(page => page.path)].includes(url.pathname)) {
        url.searchParams.set('lang', language);
        if (url.href !== element.href) element.href = url.href;
      }
    }
  }
  const ogLocale = document.querySelector<HTMLMetaElement>('meta[property="og:locale"]');
  const selectedLocale = language === 'ko' ? 'ko_KR' : 'en_US';
  if (ogLocale && ogLocale.content !== selectedLocale) ogLocale.content = selectedLocale;
  document.querySelectorAll<HTMLMetaElement>('meta[property="og:image"], meta[name="twitter:image"]').forEach(meta => {
    const url = new URL(meta.content);
    if (['/play/images/social-preview.png', '/play/images/social-preview-ko.png'].includes(url.pathname)) {
      url.pathname = language === 'ko' ? '/play/images/social-preview-ko.png' : '/play/images/social-preview.png';
      if (meta.content !== url.href) meta.content = url.href;
    }
  });
}
