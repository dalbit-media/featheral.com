export const gamePages = {
  world: { label: 'Explore', path: '/explore/' },
  home: { label: 'Settlement', path: '/settlement/' },
  inventory: { label: 'Inventory', path: '/inventory/' },
  market: { label: 'Market', path: '/market/' },
  bank: { label: 'Wallet and staking', path: '/bank/' },
  communicate: { label: 'Inbox', path: '/communicate/' },
  contacts: { label: 'Contacts', path: '/contacts/' },
  federation: { label: 'Federation', path: '/federation/' },
  hall: { label: 'Hall of Fame', path: '/hall-of-fame/' },
  atlas: { label: 'Settlement atlas', path: '/atlas/' },
  journal: { label: 'Journal', path: '/journal/' },
  help: { label: 'Field guide', path: '/help/' },
} as const;
export type GamePage = keyof typeof gamePages;
export const gamePageKeys = Object.keys(gamePages) as GamePage[];
export const accountPageKeys = ['journal', 'help'] as const;
export const primaryGamePageKeys = gamePageKeys.filter(key => key !== 'bank' && key !== 'contacts' && !accountPageKeys.some(accountKey => accountKey === key));
export function gamePage(path: string): GamePage {
  return gamePageKeys.find(key => path === gamePages[key].path || path === `${gamePages[key].path}index.html`) ?? 'world';
}
