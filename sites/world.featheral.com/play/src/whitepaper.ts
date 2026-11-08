import { language, localize, wireLanguageControls } from './i18n-dom.ts';
import { localizePublicCopy } from './public-feature-i18n.ts';

if (language === 'en') {
  const template = document.querySelector<HTMLTemplateElement>('#whitepaper-english')!;
  document.querySelector('[data-whitepaper]')!.replaceChildren(template.content.cloneNode(true));
}
localize(document);
localizePublicCopy(document);
wireLanguageControls();
const contents = document.querySelector<HTMLDetailsElement>('.paper-sidebar details')!;
const compact = matchMedia('(max-width:900px)');
contents.open = !compact.matches;
contents.querySelectorAll<HTMLAnchorElement>('a').forEach(link => {
  link.addEventListener('click', () => {
    if (compact.matches) contents.open = false;
  });
});
if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
