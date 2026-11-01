import type { Resource } from './engine.ts';

export const physicalResourceVersion = 1;
export const resourceUnits = {
  wood: { unit: 'm\u00b3', lotsPerUnit: 10, litresPerLot: 100 },
  water: { unit: 'm\u00b3', lotsPerUnit: 100, litresPerLot: 10 },
  metal: { unit: 't', lotsPerUnit: 100, kilogramsPerLot: 10 },
  oil: { unit: 'bbl', lotsPerUnit: 1, litresPerLot: 158.987294928 },
} as const;

export function isResource(asset: string): asset is Resource {
  return Object.hasOwn(resourceUnits, asset);
}
export function tradingUnit(asset: string, locale = 'en'): string {
  return isResource(asset) ? resourceUnits[asset].unit : locale.startsWith('ko') ? '\uac1c' : 'ea';
}
export function displayQuantity(asset: string, lots: number): number {
  return isResource(asset) ? lots / resourceUnits[asset].lotsPerUnit : lots;
}
export function accountingQuantity(asset: string, amount: number): number {
  const value = isResource(asset) ? amount * resourceUnits[asset].lotsPerUnit : amount;
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 1e-8 ? rounded : value;
}
export function displayPrice(asset: string, pricePerLot: number): number {
  return isResource(asset) ? pricePerLot * resourceUnits[asset].lotsPerUnit : pricePerLot;
}
export function accountingPrice(asset: string, pricePerUnit: number): number {
  return isResource(asset) ? pricePerUnit / resourceUnits[asset].lotsPerUnit : pricePerUnit;
}
export function formatResourceAmount(asset: string, lots: number, locale: string, compact = false): string {
  const value = displayQuantity(asset, lots);
  return `${new Intl.NumberFormat(locale, compact && value >= 10000
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : { maximumFractionDigits: 2 }).format(value)} ${tradingUnit(asset, locale)}`;
}
