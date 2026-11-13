"use strict";
(() => {
  const unit = 10n ** 18n;
  const integer = value => {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw Error("Market data exceeds exact unit limits.");
    if (!/^(0|[1-9]\d*)$/.test(String(value))) throw Error("Market data contains invalid accounting units.");
    return BigInt(value);
  };
  const price = value => {
    if (!value || integer(value.numerator) <= 0n || integer(value.denominator) <= 0n)
      throw Error("Market data contains an invalid executed price.");
    return value;
  };
  const compare = (a, b) => BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator);
  function statistics(history) {
    const candles = history.candles || [];
    if (!candles.length) return null;
    let high = price(candles[0].high), low = price(candles[0].low);
    for (const candle of candles) {
      if (compare(price(candle.high), high) > 0n) high = candle.high;
      if (compare(price(candle.low), low) < 0n) low = candle.low;
    }
    const open = price(candles[0].open), close = price(candles.at(-1).close);
    const difference = compare(close, open), denominator = BigInt(open.numerator) * BigInt(close.denominator);
    const bps = difference * 10000n / denominator, magnitude = bps < 0n ? -bps : bps;
    return { high, low, change: `${difference > 0n ? "+" : difference < 0n ? "-" : ""}${difference && !bps
      ? "<0.01" : `${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`}%`,
      direction: difference > 0n ? "up" : difference < 0n ? "down" : "flat" };
  }
  function depth(market, dollarPool) {
    if (!market.funded || market.pendingSettlement || market.referenceOnly || market.inventoryOnly) return [];
    const dollars = market.symbol === "FTH$", scale = dollars ? unit : 1n;
    if (dollars && (!dollarPool?.settlementEnabled || dollarPool.pendingSettlement)) return [];
    const base = integer(dollars ? dollarPool.fthx : market.baseReserve);
    const quote = integer(dollars ? dollarPool.dollars : market.noteReserve);
    if (!base || !quote) throw Error("Funded market reserves must be positive.");
    const levels = [];
    for (const side of ["buy", "sell"]) {
      const reserveIn = side === "buy" ? base : quote, reserveOut = side === "buy" ? quote : base;
      let previous = 0n;
      for (const bps of [10n, 25n, 50n, 100n, 200n, 500n]) {
        const proportional = reserveIn * bps / 10000n, input = proportional > 0n ? proportional : 1n;
        if (input === previous || (!dollars || side === "buy") && input > 1000000000n) continue;
        previous = input;
        const output = input * 9970n * reserveOut / (reserveIn * 10000n + input * 9970n);
        if (!output) continue;
        const quantity = side === "buy" ? output : input, total = side === "buy" ? input : output;
        levels.push({ side, input: input.toString(), output: output.toString(), quantity: quantity.toString(),
          total: total.toString(), price: { numerator: (total * scale).toString(), denominator: quantity.toString() } });
      }
      const entries = levels.filter(level => level.side === side), maximum = entries.at(-1)?.quantity;
      for (const level of entries) level.width = Number(BigInt(level.quantity) * 10000n / BigInt(maximum)) / 100;
    }
    return levels;
  }
  function executions(rows, symbol) {
    return rows.filter(row => row.symbol === symbol && !row.id.startsWith("world:")
      && (row.from === "FTHX" && row.to === symbol || row.to === "FTHX" && row.from === symbol)).map(row => {
      const side = row.from === "FTHX" ? "buy" : "sell";
      const quantity = integer(side === "buy" ? row.output : row.amount), total = integer(side === "buy" ? row.amount : row.output);
      if (!quantity || !total || !Number.isSafeInteger(row.at) || row.at <= 0) throw Error("Invalid recorded market execution.");
      return { ...row, side, quantity: quantity.toString(), total: total.toString(),
        price: { numerator: (total * (symbol === "FTH$" ? unit : 1n)).toString(), denominator: quantity.toString() } };
    });
  }
  function size(balance, percent, symbol) {
    if (![25, 50, 75, 100].includes(percent)) throw Error("Choose a supported balance percentage.");
    const value = integer(balance) * BigInt(percent) / 100n;
    if (!value) throw Error("This portion of your trading balance is below the minimum unit.");
    if (symbol !== "FTH$") return value.toString();
    const fraction = (value % unit).toString().padStart(18, "0").replace(/0+$/, "");
    return `${value / unit}${fraction ? "." + fraction : ""}`;
  }
  window.FeatheralMarketView = { statistics, depth, executions, size };
})();
