import { korean, koreanPatterns } from './translations.ts';

export type Language = 'ko' | 'en';
export const defaultLanguage: Language = 'en';
export const languageStorageKey = 'featheral-language';
export function resolveLanguage(value: string | null | undefined): Language {
  return value === 'ko' || value === 'en' ? value : defaultLanguage;
}
export function locale(language: Language): string {
  return language === 'ko' ? 'ko-KR' : 'en-US';
}
const normalized = (text: string): string => text.replace(/\s+/g, ' ').trim();
const english = new Map<string, string>();
const translations = new Map(Object.entries(korean).map(([source, target]) => [normalized(source).toLowerCase(), target]));
for (const [source, target] of Object.entries(korean)) {
  if (!english.has(normalized(target))) english.set(normalized(target), source);
}
const captures: Record<string, string> = {
  count: '[\\d,.]+', year: '[\\d,]+', day: '[\\d,]+', workers: '[\\d,]+', level: '\\d+',
  owned: '[\\d,]+', pending: '[\\d,]+', threshold: '[\\d,]+', total: '[\\d,]+',
  yield: '[\\d,.]+', weeks: '\\d+', hours: '\\d+', minutes: '\\d+', seconds: '\\d+',
  x: '-?\\d+', y: '-?\\d+', temperature: '-?\\d+',
  resource: 'wood|water|metal|oil|lithium',
  season: 'Spring|Summer|Autumn|Winter',
  phase: 'Dawn|Day|Dusk|Night',
  north: 'N|S', east: 'E|W',
};
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = koreanPatterns.map(([source, target]) => {
  const keys: string[] = [];
  let pattern = '', offset = 0;
  for (const match of source.matchAll(/\{(\w+)\}/g)) {
    pattern += escapeRegex(source.slice(offset, match.index));
    keys.push(match[1]);
    pattern += `(${captures[match[1]] ?? '.+?'})`;
    offset = match.index + match[0].length;
  }
  pattern += escapeRegex(source.slice(offset));
  return { regex: new RegExp(`^${pattern}$`, 'i'), keys, target };
});

export function translate(text: string, language: Language = defaultLanguage): string {
  text = text.replaceAll('F$', 'FTH$');
  const source = normalized(text);
  if (!source) return text;
  const leading = text.match(/^\s*/)?.[0] ?? '', trailing = text.match(/\s*$/)?.[0] ?? '';
  if (language === 'en') {
    const translated = english.get(source);
    return translated === undefined ? text : `${leading}${translated}${trailing}`;
  }
  const exact = Object.hasOwn(korean, source) ? korean[source] : translations.get(source.toLowerCase());
  if (exact !== undefined) return `${leading}${exact}${trailing}`;
  for (const { regex, keys, target } of patterns) {
    const match = regex.exec(source);
    if (!match) continue;
    const values = new Map(keys.map((key, index) => [key, translate(match[index + 1], language)]));
    const translated = target.replace(/\{(\w+)\}/g, (_match, key: string) => {
      const value = values.get(key);
      if (value === undefined) throw new Error(`Unknown translation placeholder: ${key}`);
      return value;
    });
    return `${leading}${translated}${trailing}`;
  }
  return text;
}
