import { localize, wireLanguageControls } from './i18n-dom.ts';

localize(document);
wireLanguageControls();
const observer = new MutationObserver(() => {
  observer.disconnect();
  localize(document);
  observe();
});
function observe(): void {
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
}
observe();
window.addEventListener('pagehide', () => observer.disconnect());
window.addEventListener('pageshow', observe);
