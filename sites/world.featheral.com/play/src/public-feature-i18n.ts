import { language } from './i18n-dom.ts';

export function localizePublicCopy(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-public-en][data-public-ko]').forEach(element => {
    const value = language === 'ko' ? element.dataset.publicKo! : element.dataset.publicEn!;
    if (element instanceof HTMLMetaElement) element.content = value;
    else element.textContent = value;
  });
  root.querySelectorAll<HTMLElement>('[data-public-aria-en][data-public-aria-ko]').forEach(element => {
    element.setAttribute('aria-label', language === 'ko' ? element.dataset.publicAriaKo! : element.dataset.publicAriaEn!);
  });
  root.querySelectorAll<HTMLAnchorElement>('a[href^="/"]').forEach(link => {
    const url = new URL(link.href);
    if (url.origin !== location.origin) return;
    url.searchParams.set('lang', language);
    link.href = url.href;
  });
}
