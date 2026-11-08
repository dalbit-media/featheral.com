import './confirmation.css';
import type { ConsumptionAmount, ConsumptionQuote } from './consumption.ts';
import { formatDollars } from './dollars.ts';
import { formatFthg } from './fthg.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { icon } from './icons.ts';
import { isMarketResource, marketAssetName } from './market.ts';
import { formatResourceAmount } from './resource-units.ts';
import type { CraftBatchOption } from './bulk-crafting.ts';
import { itemName } from './items.ts';

let activeDialog: HTMLDialogElement | null = null;
export const confirmationOpen = (): boolean => activeDialog !== null;

export function chooseCraftBatch(subject: string, options: CraftBatchOption[], language: Language): Promise<number | null> {
  if (activeDialog) throw new Error('Please wait for the current server request.');
  const trigger = document.activeElement, dialog = document.createElement('dialog');
  activeDialog = dialog;
  dialog.className = 'consumption-dialog craft-batch-dialog';
  dialog.setAttribute('aria-labelledby', 'craft-batch-title');
  const t = (text: string) => translate(text, language);
  const heading = document.createElement('h2');
  heading.id = 'craft-batch-title';
  heading.textContent = t('Choose crafting batch');
  const description = document.createElement('p');
  description.className = 'consumption-subject';
  description.textContent = t(subject);
  const note = document.createElement('p');
  note.className = 'consumption-note';
  note.textContent = t('Bulk crafting consumes one matching permit plus all batch ingredients. Only exact batches are allowed. Nothing is spent until you confirm.');
  const choices = document.createElement('div');
  choices.className = 'craft-batch-choices';
  const maximum = Math.max(1, ...options.filter(option => !option.reason).map(option => option.quantity));
  for (const option of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button';
    button.dataset.craftBatch = String(option.quantity);
    button.disabled = option.reason !== null;
    const label = document.createElement('strong'), detail = document.createElement('small');
    label.textContent = option.quantity === 1 ? t('Craft one') : t(`Craft ${option.quantity} copies`);
    detail.textContent = option.reason ? t(option.reason) : option.permit
      ? `${t(itemName(option.permit))} · ${t('Owned')}: ${option.owned} · ${t('Consumes one permit')}${option.quantity === maximum ? ` · ${t('Maximum available batch')}` : ''}`
      : t('No permit required');
    button.append(label, detail);
    button.addEventListener('click', () => dialog.close(String(option.quantity)));
    choices.append(button);
  }
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button';
  cancel.textContent = t('Cancel');
  cancel.autofocus = true;
  dialog.append(heading, description, note, choices, cancel);
  return new Promise((resolve, reject) => {
    const cancelDialog = () => dialog.close('cancel');
    const cleanup = () => {
      window.removeEventListener('pagehide', cancelDialog);
      activeDialog = null;
      dialog.remove();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
    dialog.addEventListener('close', () => {
      const choice = options.find(option => !option.reason && String(option.quantity) === dialog.returnValue);
      cleanup();
      resolve(choice?.quantity ?? null);
    }, { once: true });
    dialog.addEventListener('cancel', event => { event.preventDefault(); cancelDialog(); });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelDialog(); }
    });
    cancel.addEventListener('click', cancelDialog);
    dialog.addEventListener('click', event => {
      const bounds = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) cancelDialog();
    });
    window.addEventListener('pagehide', cancelDialog, { once: true });
    document.body.append(dialog);
    try { dialog.showModal(); }
    catch (error) { cleanup(); reject(error); }
  });
}

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
      row.append(dt, element('dd', `${spending ? '-' : '+'}${value.asset === 'fthg' || (value.asset === 'dollars' && quote.preciseDollars) ? formatFthg(value.amount, locale(language)) : value.asset === 'dollars' ? formatDollars(value.amount, locale(language)) : formatResourceAmount(value.asset, value.amount, locale(language))}`));
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
  detail('Duration', quote.days !== undefined ? t(`${quote.days} game day${quote.days === 1 ? '' : 's'}`)
    : quote.weeks === null ? t('Until filled or cancelled') : quote.weeks ? t(`${quote.weeks} game week${quote.weeks === 1 ? '' : 's'}`) : t('Immediate'));
  dialog.append(details);
  for (const note of quote.notes) dialog.append(element('p', t(note), 'consumption-note'));
  if (quote.warning) {
    const warning = element('p', t(quote.warning), 'consumption-warning');
    warning.setAttribute('role', 'alert');
    dialog.append(warning);
  }
  if (quote.recommendations?.length) {
    const links = element('nav', undefined, 'transport-recommendations');
    links.setAttribute('aria-label', t('Reduce transport costs'));
    for (const recommendation of quote.recommendations) {
      const link = element('a', t(recommendation.label), 'button');
      link.href = recommendation.href;
      links.append(link);
    }
    dialog.append(links);
  }
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
