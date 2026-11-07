import type { Resource } from './engine.ts';
import { dollarsScale } from './dollars.ts';

export const physicalResourceVersion = 1;
export const resourceUnits = {
  wood: { unit: 'kg', lotsPerUnit: 1 / 50, kilogramsPerLot: 50 },
  water: { unit: 'L', lotsPerUnit: 1 / 10, litresPerLot: 10 },
  metal: { unit: 't', lotsPerUnit: 100, kilogramsPerLot: 10 },
  oil: { unit: 'bbl', lotsPerUnit: 1, litresPerLot: 158.987294928 },
} as const;
// Rounded low-end bulk references, not live quotes or reserve genesis prices.
export const resourceEconomy = {
  wood: { pricePerUnit: .05, weeklyProduction: 100, dailyConsumption: .04 },
  water: { pricePerUnit: .001, weeklyProduction: 600, dailyConsumption: 5 },
  metal: { pricePerUnit: 100, weeklyProduction: 100, dailyConsumption: .02 },
  oil: { pricePerUnit: 30, weeklyProduction: 14, dailyConsumption: 0 },
} as const;
export function resourceBasePrice(resource: Resource): number {
  return accountingPrice(resource, resourceEconomy[resource].pricePerUnit);
}

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
  return pricePerLot / displayQuantity(asset, 1);
}
export function formatResourcePrice(asset: string, pricePerLot: number, locale: string): string {
  const precision = Math.max(2, 4 + Math.ceil(Math.log10(displayQuantity(asset, 1))));
  return displayPrice(asset, pricePerLot).toLocaleString(locale, { maximumFractionDigits: precision });
}
export function accountingPrice(asset: string, pricePerUnit: number): number {
  const value = pricePerUnit * displayQuantity(asset, 1);
  const scaled = value * dollarsScale;
  const rounded = Math.round(scaled);
  return Math.abs(scaled - rounded) < 1e-8 ? rounded / dollarsScale : value;
}
export function formatResourceAmount(asset: string, lots: number, locale: string, compact = false): string {
  if (asset === 'metal' && lots > 0 && lots < 1)
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(lots * resourceUnits.metal.kilogramsPerLot)} kg`;
  const value = displayQuantity(asset, lots);
  return `${new Intl.NumberFormat(locale, compact && value >= 10000
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : { maximumFractionDigits: 2 }).format(value)} ${tradingUnit(asset, locale)}`;
}
