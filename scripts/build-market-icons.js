"use strict";
const fs = require("node:fs"), path = require("node:path");

async function build() {
  const { marketAssets, isMarketResource } = await import("../sites/world.featheral.com/play/src/market.ts");
  const { itemArt } = await import("../sites/world.featheral.com/play/src/item-art.ts");
  const { icon } = await import("../sites/world.featheral.com/play/src/icons.ts");
  const symbols = marketAssets.map(asset => {
    const source = isMarketResource(asset) ? icon(asset) : itemArt(asset);
    const svg = source.match(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/);
    if (!svg) throw Error(`Missing World artwork for ${asset}.`);
    const attributes = svg[1].replace(/\s(?:class|aria-hidden)="[^"]*"/g, "");
    return `<symbol id="${asset}"${attributes}>${svg[2]}</symbol>`;
  });
  fs.writeFileSync(path.resolve(__dirname, "..", "shared", "market-icons.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg">\n${symbols.join("\n")}\n</svg>\n`);
}

build().catch(error => { console.error(error); process.exitCode = 1; });
