export const gamePages = {
  world: { label: 'Explore', path: '/play/' },
  home: { label: 'Settlement', path: '/play/settlement/' },
  market: { label: 'Market', path: '/play/market/' },
  bank: { label: 'Featheral Bank', path: '/play/bank/' },
  communicate: { label: 'Inbox', path: '/play/communicate/' },
  contacts: { label: 'Contacts', path: '/play/contacts/' },
  federation: { label: 'Federation', path: '/play/federation/' },
  journal: { label: 'Journal', path: '/play/journal/' },
  help: { label: 'Field guide', path: '/play/help/' },
} as const;
export type GamePage = keyof typeof gamePages;
export const gamePageKeys = Object.keys(gamePages) as GamePage[];
export const accountPageKeys = ['journal', 'help'] as const;
export const primaryGamePageKeys = gamePageKeys.filter(key => key !== 'bank' && key !== 'contacts' && !accountPageKeys.some(accountKey => accountKey === key));
export function gamePage(path: string): GamePage {
  return gamePageKeys.find(key => path === gamePages[key].path || path === `${gamePages[key].path}index.html`) ?? 'world';
}
