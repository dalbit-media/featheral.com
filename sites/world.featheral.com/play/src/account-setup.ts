import { localize, wireLanguageControls } from './i18n-dom.ts';
import { localizePublicCopy } from './public-feature-i18n.ts';

localize(document);
localizePublicCopy(document);
wireLanguageControls();
const observer = new MutationObserver(() => {
  observer.disconnect();
  localize(document);
  localizePublicCopy(document);
  observe();
});
function observe(): void {
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
}
observe();
window.addEventListener('pagehide', () => observer.disconnect());
window.addEventListener('pageshow', observe);
