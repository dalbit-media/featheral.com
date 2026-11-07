import './confirmation.css';
import type { ConsumptionAmount, ConsumptionQuote } from './consumption.ts';
import { formatDollars } from './dollars.ts';
import { formatFthg } from './fthg.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { icon } from './icons.ts';
import { isMarketResource, marketAssetName } from './market.ts';
import { formatResourceAmount } from './resource-units.ts';

let activeDialog: HTMLDialogElement | null = null;
export const confirmationOpen = (): boolean => activeDialog !== null;

export function confirmConsumption(quote: ConsumptionQuote, language: Language): Promise<boolean> {
  if (activeDialog) throw new Error('Please wait for the current server request.');
  const trigger = document.activeElement;
  const dialog = document.createElement('dialog');
  activeDialog = dialog;
  dialog.className = 'consumption-dialog';
  dialog.setAttribute('aria-labelledby', 'consumption-title');
  dialog.setAttribute('aria-describedby', 'consumption-description');
  const t = (text: string) => translate(text, language);
  const number = (value: number) => value.toLocaleString(locale(language));
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const heading = element('h2', t(quote.title));
  heading.id = 'consumption-title';
  const description = element('p', quote.literalSubject ? quote.subject : t(quote.subject), 'consumption-subject');
  if (quote.literalSubject) description.setAttribute('data-no-localize', '');
  description.id = 'consumption-description';
  dialog.append(element('small', t('Confirm action'), 'consumption-eyebrow'), heading, description);
  const list = (title: string, values: ConsumptionAmount[], spending: boolean) => {
    const section = element('section', undefined, 'consumption-section');
    section.append(element('h3', t(title)));
    const dl = element('dl');
    for (const value of values) {
      const row = element('div', undefined, spending ? 'consumption-cost' : 'consumption-receive');
      const dt = element('dt');
      const glyph = element('span', undefined, 'consumption-icon');
      glyph.innerHTML = icon(value.asset === 'dollars' ? 'dollars' : value.asset === 'fthg' || isMarketResource(value.asset) ? value.asset : 'layers');
      glyph.setAttribute('aria-hidden', 'true');
      dt.append(glyph, element('span', value.asset === 'dollars' ? 'FTH$' : value.asset === 'fthg' ? 'FTHG' : t(marketAssetName(value.asset))));
      row.append(dt, element('dd', `${spending ? '-' : '+'}${value.asset === 'fthg' ? formatFthg(value.amount, locale(language)) : value.asset === 'dollars' ? formatDollars(value.amount, locale(language)) : formatResourceAmount(value.asset, value.amount, locale(language))}`));
      dl.append(row);
    }
    section.append(dl);
    dialog.append(section);
  };
  list(quote.costLabel ?? 'You spend', quote.costs, true);
  if (quote.receives?.length) list(quote.receiveLabel ?? 'You receive', quote.receives, false);
  const details = element('dl', undefined, 'consumption-details');
  const detail = (label: string, value: string) => {
    const row = element('div');
    row.append(element('dt', t(label)), element('dd', value));
    details.append(row);
  };
  if (quote.residents !== undefined) detail('Assigned residents', number(quote.residents));
  if (quote.arrivals !== undefined) detail('Arriving residents', number(quote.arrivals));
  detail('Duration', quote.weeks === null ? t('Until filled or cancelled') : quote.weeks ? t(`${quote.weeks} game week${quote.weeks === 1 ? '' : 's'}`) : t('Immediate'));
  dialog.append(details);
  for (const note of quote.notes) dialog.append(element('p', t(note), 'consumption-note'));
  dialog.append(element('p', t('Nothing is spent until you confirm.'), 'consumption-note'));
  const actions = element('div', undefined, 'consumption-actions');
  const cancel = element('button', t('Cancel'), 'button');
  const confirm = element('button', t('Confirm'), 'button primary');
  cancel.type = confirm.type = 'button';
  cancel.dataset.consumptionCancel = '';
  confirm.dataset.consumptionConfirm = '';
  cancel.autofocus = true;
  actions.append(cancel, confirm);
  dialog.append(actions);
  return new Promise<boolean>((resolve, reject) => {
    const cancelDialog = () => dialog.close('cancel');
    const finish = () => {
      const accepted = dialog.returnValue === 'confirm';
      window.removeEventListener('pagehide', cancelDialog);
      activeDialog = null;
      dialog.remove();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
      resolve(accepted);
    };
    dialog.addEventListener('close', finish, { once: true });
    dialog.addEventListener('cancel', event => { event.preventDefault(); cancelDialog(); });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelDialog(); }
    });
    cancel.addEventListener('click', cancelDialog);
    confirm.addEventListener('click', () => { confirm.disabled = true; dialog.close('confirm'); });
    dialog.addEventListener('click', event => {
      const bounds = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) cancelDialog();
    });
    window.addEventListener('pagehide', cancelDialog, { once: true });
    document.body.append(dialog);
    try { dialog.showModal(); }
    catch (error) {
      window.removeEventListener('pagehide', cancelDialog);
      activeDialog = null; dialog.remove(); reject(error);
    }
  });
}
