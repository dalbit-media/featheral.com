"use strict";
(() => {
  const count = value => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid ledger count.");
    return value.toLocaleString("en-US");
  };
  const units = value => {
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Invalid supply.");
    const raw = BigInt(value), whole = raw / 10n ** 18n;
    return `${whole.toLocaleString("en-US")}${raw % 10n ** 18n ? "+" : ""}`;
  };
  async function snapshot(id, url, render) {
    const node = document.getElementById(id);
    if (!node) return;
    try {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      node.textContent = render(await response.json());
      node.title = `Checked ${new Date().toLocaleString()}. Whole-token display; + indicates a fractional remainder.`;
    } catch (error) {
      console.error(`Foundation ${id} unavailable:`, error);
      node.textContent = id === "goldStat" ? "Ethereum data unavailable" : "Native ledger data unavailable";
      node.title = error.message;
    }
  }
  snapshot("goldStat", "/api/v1/gold/stats", data => {
    if (data.chain?.id !== 1) throw new Error("FTHG requires Ethereum Mainnet.");
    return `${units(data.chain.totalSupply)} FTHG total supply`;
  });
  snapshot("dollarStat", "/api/v1/notes/fth/stats?blocks=1&transactions=1&holders=1", data =>
    `${units(data.ledger.supply)} FTH$ supply · ${count(data.ledger.holders)} holders · block #${count(data.ledger.height)}`);
})();
