import type { ApiState } from './api-types.ts';
import { locale, translate } from './i18n.ts';
import type { Language } from './i18n.ts';
import { icon } from './icons.ts';

export function journalEntries(log: readonly string[], query: string, language: Language): string[] {
  const search = query.trim().toLocaleLowerCase(locale(language));
  return log.filter(entry => translate(entry, language).toLocaleLowerCase(locale(language)).includes(search));
}
export function renderJournalEntries(root: HTMLElement, count: Element, log: readonly string[], query: string, language: Language): void {
  const entries = journalEntries(log, query, language);
  const list = document.createElement('div');
  list.className = 'journal-list';
  for (const [index, entry] of entries.entries()) {
    const row = document.createElement('div');
    row.className = 'journal-entry';
    const glyph = document.createElement('span');
    glyph.innerHTML = icon('journal');
    const detail = document.createElement('div');
    if (!index && !query.trim()) {
      const latest = document.createElement('small');
      latest.textContent = translate('LATEST', language);
      detail.append(latest);
    }
    const paragraph = document.createElement('p');
    paragraph.textContent = translate(entry, language);
    detail.append(paragraph);
    row.append(glyph, detail);
    list.append(row);
  }
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'page-empty';
    empty.textContent = translate('No matching events. Try another word.', language);
    list.append(empty);
  }
  root.replaceChildren(list);
  count.textContent = `${entries.length} / ${log.length}`;
}
export function downloadSnapshot(state: ApiState, legacy: boolean): void {
  const content = legacy ? localStorage.getItem('terra-world-v1')
    : JSON.stringify(state, (key, value: unknown) => key === 'csrf' ? undefined : value, 2);
  if (!content) throw new Error('No recovery data is available on this device.');
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = legacy ? 'featheral-recovery.json' : 'featheral-world.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
