"use strict";
const periods = { "1h": [3600000, 300000], "24h": [86400000, 3600000],
  "7d": [604800000, 21600000], "30d": [2592000000, 86400000] };
function period(interval) {
  if (!Object.hasOwn(periods, interval)) throw Object.assign(new Error("Choose a supported chart interval."), { status: 400 });
  return periods[interval];
}
function candles(trades, bucket) {
  const result = new Map();
  const compare = (a, b) => BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator);
  for (const trade of trades) {
    const base = BigInt(trade.base), quote = BigInt(trade.quote);
    if (base <= 0n || quote <= 0n) throw new Error("Executed trade contains an invalid candle amount.");
    const price = { numerator: quote.toString(), denominator: base.toString() }, at = Math.floor(trade.at / bucket) * bucket;
    let candle = result.get(at);
    if (!candle) {
      candle = { at, open: price, high: price, low: price, close: price, baseVolume: "0", quoteVolume: "0", trades: 0 };
      result.set(at, candle);
    }
    if (compare(price, candle.high) > 0n) candle.high = price;
    if (compare(price, candle.low) < 0n) candle.low = price;
    candle.close = price;
    candle.baseVolume = (BigInt(candle.baseVolume) + base).toString();
    candle.quoteVolume = (BigInt(candle.quoteVolume) + quote).toString();
    candle.trades++;
  }
  return [...result.values()];
}
module.exports = { period, candles };
