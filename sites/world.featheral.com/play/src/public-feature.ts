import { localize, wireLanguageControls } from './i18n-dom.ts';
import { localizePublicCopy } from './public-feature-i18n.ts';
import { drawPublicPreview } from './public-feature-preview.ts';

localize(document);
localizePublicCopy(document);
wireLanguageControls();
document.querySelectorAll<HTMLCanvasElement>('[data-public-map]').forEach(canvas => {
  const context = canvas.getContext('2d');
  if (context) drawPublicPreview(context, canvas.dataset.publicMap!);
});
