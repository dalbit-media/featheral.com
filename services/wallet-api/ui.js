"use strict";
const assets = ["FTHG", "FTH$", "FTHX", "FTHS"];
const views = ["assets", "send", "receive", "swap", "activity", "account"];
const siteColors = require("../../shared/site-colors.json");
function allowedOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password
      && (url.protocol === "https:" && (url.hostname === "featheral.com" || /^[a-z0-9-]+\.featheral\.com$/.test(url.hostname))
        || url.protocol === "http:" && (url.hostname === "localhost" || /^[a-z0-9-]+\.localhost$/.test(url.hostname)));
  } catch { return false; }
}
function primaryFor(hostname) {
  const site = hostname.split(".")[0];
  return ["gold", "foundation", "featheral", "localhost"].includes(site) ? "FTHG" : site === "silver" ? "FTHS" : ["world", "dollar"].includes(site) ? "FTH$" : "FTHX";
}
function walletUi(params) {
  const origin = params.get("parentOrigin"), primary = params.get("primary") || (origin && allowedOrigin(origin) ? primaryFor(new URL(origin).hostname) : "FTHX");
  const requestedView = params.get("view") || "assets", view = requestedView === "tip" ? "swap" : requestedView, embedded = params.get("embedded") === "1";
  const defaultSite = primary === "FTHG" ? "gold" : primary === "FTH$" ? "dollar" : primary === "FTHS" ? "silver" : "notes";
  const theme = params.get("theme") || (origin && allowedOrigin(origin) ? new URL(origin).hostname.split(".")[0] : defaultSite);
  const themeHost = theme === "foundation" || theme === "localhost" || theme === "featheral" ? "featheral.com" : `${theme}.featheral.com`;
  const palette = siteColors[themeHost];
  if (!assets.includes(primary) || !views.includes(view) || origin && !allowedOrigin(origin)
    || embedded && !origin || params.has("compact") && !["0", "1"].includes(params.get("compact"))
    || params.has("embedded") && !["0", "1"].includes(params.get("embedded"))
    || params.has("followActive") && !["0", "1"].includes(params.get("followActive"))
    || params.has("version") && params.get("version") !== "1"
    || params.has("selectionNonce") && (embedded || !origin || !/^[0-9a-f]{32}$/.test(params.get("selectionNonce")))
    || params.has("theme") && !palette
    || params.has("address") && !/^0x[0-9a-fA-F]{40}$/.test(params.get("address")))
    throw Object.assign(new Error("Unsupported wallet configuration or embedding origin."), { status: 400 });
  const interactive = !params.has("address") || params.get("followActive") === "1";
  return { schema: "featheral.wallet", version: 1, primary, view, embedded, interactive, theme: { site: palette ? theme : defaultSite,
    accent: (palette || siteColors[`${defaultSite}.featheral.com`]).color }, compact: params.get("compact") === "1", address: params.get("address") || null,
    followActive: params.get("followActive") === "1", parentOrigin: origin || null,
    selectionNonce: params.get("selectionNonce") || null, signing: interactive ? "wallet-provider" : "read-only",
    localWallet: interactive, portfolio: { ethereumFthg: true, nativeEthChains: [1, 8453, 42161, 10, 324, 59144],
      internalNotes: true, worldFunds: true, estimates: ["FTHG", "FTH$", "FTHX", "USD"] },
    actions: views, assets };
}
module.exports = { walletUi, allowedOrigin, primaryFor };
