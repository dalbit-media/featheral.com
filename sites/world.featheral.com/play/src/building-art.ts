import { icon } from './icons.ts';

export function buildingArt(symbol: string): string {
  const water = ['water', 'well', 'rainCollector', 'pumpingStation'].includes(symbol);
  const accent = water ? '#8fc3cc' : symbol === 'bank' ? '#e3c187' : symbol === 'people' || symbol === 'home' ? '#b5c892' : '#c7ae93';
  const glyph = icon(symbol).replace(/^<svg[^>]*>/, '').replace('</svg>', '');
  return `<span class="building-art" aria-hidden="true"><svg viewBox="0 0 64 64"><ellipse cx="32" cy="56" rx="28" ry="6" fill="#0b211b" opacity=".6"/>
    <path d="m7 52 25-12 25 12-25 11Z" fill="#567967"/><path d="M13 26 32 36v22L13 48Z" fill="#a48668"/>
    <path d="m32 36 19-10v22L32 58Z" fill="#dfc8a0"/><path d="m8 27 24-22 24 22-24 13Z" fill="${accent}"/>
    <path d="m32 5 24 22-24 13Z" fill="#24473d" opacity=".3"/><path d="m13 25 19 11 19-11" fill="none" stroke="#f1dcaf" stroke-width="2"/>
    <path d="m18 36 7 4v12l-7-4Z" fill="#36544b"/><path d="m39 41 7-4v7l-7 4Z" fill="${water ? '#88d5dd' : '#edda9f'}"/>
    <g transform="translate(22 11) scale(.8)" color="#25493d">${glyph}</g></svg></span>`;
}
