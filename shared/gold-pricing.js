"use strict";

((root) => {
  const POLICY = "origin-linear-v1", UNIT = 10n ** 18n, BASE = 10000n;
  const fail = message => Object.assign(new Error(message), { status: 409 });
  function position(state) {
    const cap = BigInt(state.cap);
    const net = BigInt(state.allocated) + BigInt(state.recycledIn) - BigInt(state.released);
    if (cap <= 0n || net < 0n || net > cap) throw fail("Gold pricing requires a positive origin cap and valid net allocation.");
    return { cap, net };
  }
  function spot(state) {
    const { cap, net } = position(state);
    return BASE * UNIT * (cap + net) / cap;
  }
  function quote(state, direction, rawAmount) {
    const amount = BigInt(rawAmount);
    if (amount <= 0n) throw fail("Gold quote amount must be positive.");
    if (state.pricingPolicy !== POLICY) {
      if (direction === "fthg-to-fthdollar") return amount * BigInt(state.rate);
      if (direction !== "fthdollar-to-fthg") throw fail("Unknown Gold quote direction.");
      if (amount % BigInt(state.rate)) throw fail("FTH$ conversion must map to whole FTHG base units.");
      return amount / BigInt(state.rate);
    }
    const { cap, net } = position(state);
    if (direction === "fthg-to-fthdollar") {
      if (amount > cap - net) throw fail("Conversion exceeds the remaining origin allocation.");
      return BASE * amount * (2n * (cap + net) + amount) / (2n * cap);
    }
    if (direction !== "fthdollar-to-fthg") throw fail("Unknown Gold quote direction.");
    const cost = gold => {
      const numerator = BASE * gold * (2n * (cap + net) - gold);
      return (numerator + 2n * cap - 1n) / (2n * cap);
    };
    if (amount > cost(net)) throw fail("Redemption exceeds the net allocated Gold.");
    let low = 0n, high = net;
    while (low < high) {
      const middle = (low + high + 1n) / 2n;
      if (cost(middle) <= amount) low = middle;
      else high = middle - 1n;
    }
    if (low === 0n) throw fail("Redemption amount is too small to return FTHG.");
    return low;
  }
  function commitment(genesis, state, direction, amount, output) {
    return [POLICY, genesis, state.cap, position(state).net.toString(), direction, String(amount), String(output)].join("|");
  }
  const api = { POLICY, position, spot, quote, commitment };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FeatheralGoldPricing = api;
})(typeof globalThis === "object" ? globalThis : this);
