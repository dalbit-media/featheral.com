import { icon } from './icons.ts';

export function buildingArt(symbol: string, stage = 0): string {
  const water = ['water', 'well', 'rainCollector', 'pumpingStation'].includes(symbol);
  const accent = water ? '#8fc3cc' : symbol === 'bank' ? '#e3c187' : symbol === 'people' || symbol === 'home' ? '#b5c892' : '#c7ae93';
  const glyph = icon(symbol).replace(/^<svg[^>]*>/, '').replace('</svg>', '');
  const floors = stage >= 9 ? stage - 5 : stage >= 6 ? 3 : stage >= 3 ? 2 : 1;
  const top = 45 - floors * 2;
  const windows = Array.from({ length: floors }, (_, row) => `<path d="m17 ${top + row * 2 + 5} 4 2m5 1 4 2m9 -2 4-2m4-2 4-2" fill="none" stroke="${water ? '#9bd9df' : '#f2dfac'}" stroke-width="1"/>`).join('');
  const roof = water ? `<ellipse cx="32" cy="${top}" rx="19" ry="8" fill="#80b8bf"/><ellipse cx="32" cy="${top - 2}" rx="14" ry="5" fill="#345d68"/>`
    : symbol === 'tool' || symbol === 'warehouse' || symbol === 'market' ? `<path d="m11 ${top} 10-12 10 6 10-12 12 13-21 12Z" fill="${accent}"/><path d="M20 ${top - 6}v-10h5v13" fill="#536c65"/>`
      : symbol === 'hall' || symbol === 'flag' || symbol === 'bank' ? `<path d="m9 ${top} 23-16 23 16-23 12Z" fill="${accent}"/><path d="M32 ${top - 15}v-10m0 0 13 4-13 4" fill="#c6e8a4" stroke="#ded5ac"/>`
        : stage >= 6 ? `<path d="m13 ${top} 19-10 19 10-19 11Z" fill="#78a493"/><path d="m24 ${top - 5} 9-4 9 5-9 4Z" fill="#385e68"/>`
          : `<path d="m8 ${top} 24-20 24 20-24 13Z" fill="${accent}"/><path d="m32 ${top - 20} 24 20-24 13Z" fill="#24473d" opacity=".3"/>`;
  return `<span class="building-art" data-building-tier="${stage}" aria-hidden="true"><svg viewBox="0 0 64 64"><ellipse cx="32" cy="56" rx="28" ry="6" fill="#0b211b" opacity=".6"/>
    <path d="m7 52 25-12 25 12-25 11Z" fill="#567967"/>    <path d="M13 ${top} 32 ${top + 10}v${48 - top}L13 48Z" fill="${stage >= 6 ? '#4b707a' : '#a48668'}"/>
    <path d="m32 ${top + 10} 19-10V48L32 58Z" fill="${stage >= 6 ? '#8bb4ba' : '#dfc8a0'}"/>${windows}${roof}
    <path d="m18 36 7 4v12l-7-4Z" fill="#36544b"/><path d="m39 41 7-4v7l-7 4Z" fill="${water ? '#88d5dd' : '#edda9f'}"/>
    <g transform="translate(26 ${Math.max(8, top - 6)}) scale(.5)" color="#25493d">${glyph}</g></svg></span>`;
}
