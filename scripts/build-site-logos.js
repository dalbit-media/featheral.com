"use strict";
const fs = require("node:fs");
const path = require("node:path");
const colors = require("../shared/site-colors.json");

const badges = {
  gold: '<path d="M44 55l3-7h9l3 7zM47 51h9"/>',
  silver: '<path d="M44 55l3-7h9l3 7zM47 51h9"/><path d="M44 59h16"/>',
  app: '<rect x="46" y="43" width="12" height="18" rx="3"/><path d="M50 46h4m-3 12h2"/>',
  db: '<ellipse cx="52" cy="46" rx="7" ry="3"/><path d="M45 46v11c0 4 14 4 14 0V46m-14 5c0 4 14 4 14 0"/>',
  dollar: '<path d="M55 47h-5a3 3 0 000 6h3a3 3 0 010 6h-5m4-15v18"/>',
  ledger: '<rect x="45" y="44" width="14" height="17" rx="2"/><path d="M49 44v17m3-12h4m-4 4h4m-4 4h4"/>',
  world: '<circle cx="52" cy="52" r="7"/><ellipse cx="52" cy="52" rx="3" ry="7"/><path d="M45 52h14"/>',
  media: '<path d="M44 45h16v11H51l-5 4v-4h-2z"/><path d="M48 49h8m-8 3h5"/>',
  admin: '<path d="M49 44h6l1 4 4 1v6l-4 1-1 4h-6l-1-4-4-1v-6l4-1z"/><circle cx="52" cy="52" r="3"/>',
  x: '<path d="M46 46l12 12m0-12L46 58"/>',
  ex: '<path d="M44 48h15l-4-4m-11 12h15m-15 0l4 4"/>',
  stats: '<path d="M45 58V52m7 6V48m7 10V44" stroke-width="3"/>',
  sites: '<rect x="44" y="46" width="16" height="12" rx="2"/><path d="M44 50h16m-12-2h1m3 0h1"/>',
  notes: '<rect x="46" y="44" width="12" height="16" rx="2"/><path d="M44 48h4m-4 4h4m-4 4h4m3-8h4m-4 4h4m-4 4h4"/>',
};

function logo(base, name) {
  const palette = colors[`${name}.featheral.com`];
  return base.trim().replace(/#ffe27a/g, palette.light).replace(/#c8891a/g, palette.color).replace(/#1b1608/g, palette.dark)
    .replace("</svg>", `<g aria-label="${name} badge"><circle cx="52" cy="52" r="11" fill="${palette.dark}" stroke="${palette.light}" stroke-width="2"/><g fill="none" stroke="${palette.light}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${badges[name]}</g></g></svg>\n`);
}

if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  const base = fs.readFileSync(path.join(root, "shared", "logo.svg"), "utf8");
  for (const name of Object.keys(badges)) {
    fs.writeFileSync(path.join(root, "shared", `logo-${name}.svg`), logo(base, name));
  }
  fs.writeFileSync(path.join(root, "shared", "site-colors.css"), Object.entries(colors).map(([host, palette]) =>
    `${host === "sites.featheral.com" ? ':root:has(meta[name="site-directory"][content="true"]) ' : ''}body[data-site-brand="${host}"]{--brand:${palette.color}}\n`).join(""));
  fs.writeFileSync(path.join(root, "sites", "x.featheral.com", "logo.svg"), logo(base, "x"));
  fs.writeFileSync(path.join(root, "sites", "world.featheral.com", "play", "public", "favicon.svg"), logo(base, "world"));
}

module.exports = { badges, logo };
