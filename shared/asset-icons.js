"use strict";
(() => {
  const colors = {
    A: "#f59e0b", B: "#2563eb", C: "#06b6d4", D: "#385e9d", E: "#10b981", F: "#d946ef",
    G: "#d4a017", H: "#d99a26", I: "#6366f1", J: "#00a86b", K: "#aaa06a", L: "#84cc16",
    M: "#db2777", N: "#243b75", O: "#f97316", P: "#9333ea", Q: "#b89ac9", R: "#ef4444",
    S: "#94a3b8", T: "#14b8a6", U: "#4166f5", V: "#8b5cf6", W: "#94a3b8", X: "#59616c",
    Y: "#eab308", Z: "#71717a",
  };
  const ns = "http://www.w3.org/2000/svg";
  function create(asset) {
    const symbol = asset.symbol || "", world = asset.inventoryOnly || symbol.startsWith("WORLD:");
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "asset-icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    if (world) {
      const id = (asset.asset || symbol.slice(6)).replace(/^enhanced-(.+)-level-\d+$/, "$1");
      if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw Error("Invalid World asset icon.");
      svg.setAttribute("viewBox", "0 0 64 64");
      const use = document.createElementNS(ns, "use");
      use.setAttribute("href", `/shared/market-icons.svg#${id}`); svg.append(use);
    } else {
      const native = { "FTH$": "dollar", FTHG: "gold", FTHS: "silver" }[symbol];
      svg.setAttribute("viewBox", "0 0 64 64");
      if (native) {
        const image = document.createElementNS(ns, "image");
        image.setAttribute("href", `/shared/logo-${native}.svg`);
        image.setAttribute("width", "64"); image.setAttribute("height", "64"); svg.append(image);
      } else {
        const color = colors[symbol.replace(/^FTH/, "").slice(0, 1)] || "#a855d7";
        for (const [tag, attrs] of [
          ["circle", { cx: 32, cy: 32, r: 29, fill: "#172033", stroke: color, "stroke-width": 2 }],
          ["path", { d: "M48 12C30 12 18 24 16 44l-4 8 8-4c20-2 32-14 28-36z", fill: color }],
          ["path", { d: "M16 44L40 20", stroke: "#172033", "stroke-width": 2, fill: "none" }],
        ]) {
          const node = document.createElementNS(ns, tag);
          for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
          svg.append(node);
        }
      }
    }
    return svg;
  }
  window.FeatheralAssetIcons = { create };
})();
