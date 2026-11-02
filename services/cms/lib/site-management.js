"use strict";
const operations = {
  "featheral.com": ["foundation", "Foundation governance & status"],
  "gold.featheral.com": ["gold", "Gold reserve & token safety"],
  "dollar.featheral.com": ["dollar", "Dollar ledger & bridge"],
  "world.featheral.com": ["world", "World moderation"],
};
function managementFor(site) {
  const hostname = site.hostname, encoded = encodeURIComponent(hostname);
  const links = [];
  if (site.builtin && operations[hostname]) {
    const [key, label] = operations[hostname]; links.push({ label, href: `#/operations/${key}` });
  }
  if (site.builtin && hostname === "app.featheral.com") links.push({ label: "Insiders, missions & grants", href: "#/intranet" });
  if (site.builtin && hostname === "silver.featheral.com") links.push({ label: "Products, stock & orders", href: "#/silver" });
  if (!site.path && ["notes.featheral.com", "ex.featheral.com"].includes(hostname))
    links.push({ label: "Native Notes & markets", href: "#/notes" });
  if (!site.path && hostname === "stats.featheral.com") links.push({ label: "Network & site traffic", href: "#/overview" });
  if (site.builtin && hostname === "admin.featheral.com") links.push({ label: "All sites & deployment", href: "#/" });
  if (site.builtin && hostname === "db.featheral.com") links.push({ label: "Database journals", href: "#/database" });
  if (site.builtin && hostname === "admin.featheral.com") links.push({ label: "Server & service settings", href: "#/settings" });
  if (site.builtin && hostname === "wallet.featheral.com") links.push({ label: "Service operations", href: "#/operations" });
  if (site.contentEditable !== false) links.push({ label: "Content & appearance",
    href: site.builtin ? `#/site-pages/${encoded}` : `#/set/${encodeURIComponent(site.key)}/cms-content` });
  if (!site.builtin) links.push({ label: "Site settings", href: `#/set/${encodeURIComponent(site.key)}/site-settings` });
  links.push({ label: "Deployment", href: "#/deployment" });
  return links;
}
module.exports = { managementFor };
