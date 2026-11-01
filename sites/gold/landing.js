"use strict";

const TOKEN = "0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665";
const SOURCE_WALLET = "0xD2f1Be8414472E9f436B65e91A2B8dFDa418287c";
const RESERVE_WALLET = "0x706CCb6109046a6a4A08dbAD4444A46408703ccb";
const RPC_URL = "https://ethereum-rpc.publicnode.com";
const BLOCKSCOUT_API = "https://eth.blockscout.com/api/v2";
const BLOCKSCOUT_URL = "https://eth.blockscout.com";
const USD_PER_FTHG_ESTIMATE = 0.01;
const ONE = 10n ** 18n;
const KNOWN = {
  [SOURCE_WALLET.toLowerCase()]: "Source wallet",
  [RESERVE_WALLET.toLowerCase()]: "FTH$ reserve",
  "0x0000000000000000000000000000000000000000": "Mint",
};

const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

let rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || "RPC error");
  return body.result;
}
const padAddress = (address) => address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const call = (data, block) => rpc("eth_call", [{ to: TOKEN, data }, block]).then((hex) => BigInt(hex));

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function tokens(raw, maxFractionDigits = 2) {
  const value = BigInt(raw);
  const whole = value / ONE;
  const fraction = Number(value % ONE) / 1e18;
  return (Number(whole) + fraction).toLocaleString("en-US", { maximumFractionDigits: maxFractionDigits });
}
function compact(raw) {
  const value = Number(BigInt(raw) / ONE);
  return value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}
function usd(raw) {
  const value = Number(BigInt(raw) / ONE) * USD_PER_FTHG_ESTIMATE;
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function share(part, total) {
  if (!total) return "—";
  return `${(Number(BigInt(part) * 10000n / BigInt(total)) / 100).toFixed(2)}%`;
}
const short = (address) => address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—";
function addressCell(address) {
  if (!address) return el("span", { className: "muted", textContent: "—" });
  const label = KNOWN[address.toLowerCase()];
  return el("span", {},
    el("a", { href: `${BLOCKSCOUT_URL}/address/${address}`, target: "_blank", rel: "noopener noreferrer", textContent: short(address) }),
    label ? el("span", { className: "tag", textContent: label }) : null);
}
function stat(label, value, note = "") {
  return el("div", { className: "stat" }, el("span", { textContent: label }), el("b", { textContent: value }), el("small", { textContent: note }));
}
function skeleton(container, count) {
  container.replaceChildren(...Array.from({ length: count }, () =>
    el("div", { className: "stat skeleton" }, el("span", { textContent: "Loading" }), el("b", { textContent: "000,000" }), el("small", { textContent: " " }))));
}
function relativeTime(iso) {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "—";
  const units = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-Math.round(seconds / size), unit);
  return "just now";
}

async function loadChainStats() {
  const block = await rpc("eth_blockNumber", []);
  const [supply, source, reserve] = await Promise.all([
    call("0x18160ddd", block),
    call(`0x70a08231${padAddress(SOURCE_WALLET)}`, block),
    call(`0x70a08231${padAddress(RESERVE_WALLET)}`, block),
  ]);
  return { block: Number(BigInt(block)), supply, source, reserve };
}
async function loadExplorerStats() {
  const [info, counters] = await Promise.all([
    getJson(`${BLOCKSCOUT_API}/tokens/${TOKEN}`),
    getJson(`${BLOCKSCOUT_API}/tokens/${TOKEN}/counters`).catch(() => ({})),
  ]);
  return { holders: Number(info.holders_count), transfers: Number(counters.transfers_count) };
}
async function loadApiStats() {
  const response = await fetch("/api/v1/stats", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function renderPrimary(chain, explorer) {
  const outside = chain ? chain.supply - chain.source - chain.reserve : null;
  const count = (value) => Number.isFinite(value) ? value.toLocaleString("en-US") : "—";
  $("primaryStats").replaceChildren(
    stat("Total supply", chain ? `${compact(chain.supply)} FTHG` : "—", chain ? `${tokens(chain.supply, 0)} · fixed, no minting` : "Unavailable"),
    stat("Reference value", chain ? usd(chain.supply) : "—", `Fully diluted at $${USD_PER_FTHG_ESTIMATE} per FTHG estimate`),
    stat("Holders", explorer ? count(explorer.holders) : "—", "Blockscout-indexed addresses"),
    stat("Transfers", explorer ? count(explorer.transfers) : "—", "Blockscout index counter"),
    stat("Held outside fixed wallets", outside === null ? "—" : `${compact(outside)} FTHG`, outside === null ? "" : `${share(outside, chain.supply)} of supply`),
    stat("Latest block", chain ? `#${chain.block.toLocaleString("en-US")}` : "—", "Ethereum Mainnet"),
  );
}
function renderSupply(chain) {
  if (!chain) {
    $("supplyLegend").replaceChildren(el("li", { className: "muted", textContent: "Supply distribution is unavailable right now." }));
    return;
  }
  const outside = chain.supply - chain.source - chain.reserve;
  const parts = [
    ["Source wallet", chain.source, "#e2b13c", SOURCE_WALLET],
    ["FTH$ reserve wallet", chain.reserve, "#7fa8e0", RESERVE_WALLET],
    ["All other holders & contracts", outside, "#5fbf6a", ""],
  ];
  const total = Number(chain.supply / ONE) || 1;
  $("supplyBar").replaceChildren(...parts.map(([label, value, color]) =>
    el("i", { title: `${label}: ${share(value, chain.supply)}`, style: `width:${(Number(value / ONE) / total) * 100}%;background:${color}` })));
  $("supplyLegend").replaceChildren(...parts.map(([label, value, color, address]) =>
    el("li", {},
      el("span", { className: "swatch", style: `background:${color}` }),
      el("div", {},
        el("b", { textContent: `${label} · ${share(value, chain.supply)}` }),
        el("small", { textContent: `${tokens(value, 0)} FTHG · ≈ ${usd(value)}` }),
        address ? el("small", {}, el("a", { href: `${BLOCKSCOUT_URL}/address/${address}`, target: "_blank", rel: "noopener noreferrer", textContent: short(address) })) : null))));
}
function renderEconomy(api) {
  const bridge = api?.bridge;
  const ledger = api?.fthDollar;
  const live = Boolean(bridge?.initialized && bridge.spotRateFthDollarPerFthg && bridge.spotRateFthDollarPerFthg !== "0");
  if (live) {
    $("rateValue").textContent = `1 FTHG = ${tokens(bridge.spotRateFthDollarPerFthg, 2)} FTH$`;
    $("rateNote").textContent = `Live spot rate from the funded bridge pool${bridge.paused ? " (paused)" : ""}. Larger trades move the price.`;
  }
  const apr = bridge?.baseAprBps ?? api?.staking?.baseAprBps ?? 600;
  $("economyStats").replaceChildren(
    stat("Bridge status", live ? (bridge.paused ? "Paused" : "Live") : bridge?.deployed ? "Awaiting funding" : "Coming soon", live ? "Dynamic constant-product pool" : "Opening rate 1 : 1,000"),
    stat("Pool reserves", live ? `${compact(bridge.reserveFthg)} FTHG` : "—", live ? `${compact(bridge.reserveFthDollar)} FTH$ game budget` : "Only actual deposits count as liquidity"),
    stat("Staking APR", `${(apr / 100).toFixed(2)}%`, "Simple interest in FTH$ · 1–30 game-years"),
    stat("FTH$ supply (L3)", ledger ? `${compact(ledger.supply || "0")} FTH$` : "—", ledger ? `${Number(ledger.holders).toLocaleString("en-US")} holders · block #${Number(ledger.height).toLocaleString("en-US")}` : "Featheral Dollar ledger"),
  );
}
function renderTransfers(items) {
  const body = $("transferRows");
  if (!items?.length) {
    body.replaceChildren(el("tr", {}, el("td", { colSpan: 5, className: "muted", textContent: items ? "No transfers indexed yet." : "Transfers are unavailable right now." })));
    return;
  }
  body.replaceChildren(...items.slice(0, 8).map((item) => {
    const hash = item.transaction_hash || item.tx_hash || "";
    return el("tr", {},
      el("td", { textContent: item.timestamp ? relativeTime(item.timestamp) : "—", title: item.timestamp || "" }),
      el("td", {}, addressCell(item.from?.hash)),
      el("td", {}, addressCell(item.to?.hash)),
      el("td", { className: "num", textContent: `${tokens(item.total?.value ?? "0")} FTHG` }),
      el("td", {}, hash ? el("a", { href: `https://etherscan.io/tx/${hash}`, target: "_blank", rel: "noopener noreferrer", textContent: short(hash) }) : "—"));
  }));
}
function renderHolders(items, supply) {
  const body = $("holderRows");
  if (!items?.length) {
    body.replaceChildren(el("tr", {}, el("td", { colSpan: 4, className: "muted", textContent: items ? "No holders indexed yet." : "Holders are unavailable right now." })));
    return;
  }
  body.replaceChildren(...items.slice(0, 10).map((item, index) => el("tr", {},
    el("td", { textContent: String(index + 1) }),
    el("td", {}, addressCell(item.address?.hash)),
    el("td", { className: "num", textContent: `${tokens(item.value ?? "0", 0)} FTHG` }),
    el("td", { className: "num", textContent: supply ? share(item.value ?? "0", supply) : "—" }))));
}

async function load() {
  skeleton($("primaryStats"), 6);
  skeleton($("economyStats"), 4);
  const [chain, explorer, api, transfers, holders] = await Promise.allSettled([
    loadChainStats(),
    loadExplorerStats(),
    loadApiStats(),
    getJson(`${BLOCKSCOUT_API}/tokens/${TOKEN}/transfers`).then((data) => data.items || []),
    getJson(`${BLOCKSCOUT_API}/tokens/${TOKEN}/holders`).then((data) => data.items || []),
  ]);
  const chainData = chain.status === "fulfilled" ? chain.value : null;
  renderPrimary(chainData, explorer.status === "fulfilled" ? explorer.value : null);
  renderSupply(chainData);
  renderEconomy(api.status === "fulfilled" ? api.value : null);
  renderTransfers(transfers.status === "fulfilled" ? transfers.value : null);
  renderHolders(holders.status === "fulfilled" ? holders.value : null, chainData?.supply);
  $("statsUpdated").textContent = chainData
    ? `Updated ${new Date().toLocaleTimeString()} · block #${chainData.block.toLocaleString("en-US")}`
    : "Ethereum Mainnet is temporarily unreachable. Explorer data shown where available.";
}

$("copyAddress").onclick = async () => {
  try {
    await navigator.clipboard.writeText(TOKEN);
    $("copyAddress").textContent = "Copied";
    setTimeout(() => { $("copyAddress").textContent = "Copy"; }, 1500);
  } catch {
    window.prompt("Copy the token address:", TOKEN);
  }
};
load();
