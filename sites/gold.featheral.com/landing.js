"use strict";

const TOKEN = "0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665";
const SOURCE_WALLET = "0xD2f1Be8414472E9f436B65e91A2B8dFDa418287c";
const RESERVE_WALLET = "0x706CCb6109046a6a4A08dbAD4444A46408703ccb";
const POOL_ID = "0x3f1f8a9867d8f4a59f206b9644fafe05e9546323c0219dd1352187bbb5738fdd";
const POOL_URL = `https://app.uniswap.org/explore/pools/ethereum/${POOL_ID}`;
const POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const RPC_URL = `${location.origin}/api/v1/gold/rpc`;
const BLOCKSCOUT_API = "https://eth.blockscout.com/api/v2";
const BLOCKSCOUT_URL = "https://eth.blockscout.com";
const ONE = 10n ** 18n;
let usdMarket = null;
const KNOWN = {
  [SOURCE_WALLET.toLowerCase()]: "Source wallet",
  [RESERVE_WALLET.toLowerCase()]: "FTH$ reserve",
  [POOL_MANAGER.toLowerCase()]: "Uniswap pool",
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
  const value = BigInt(raw), fraction = (value % ONE).toString().padStart(18, "0").replace(/0+$/, "");
  return (value / ONE).toLocaleString("en-US") + (fraction ? "." + fraction : "");
}
function usd(raw) {
  const updated = Date.parse(usdMarket?.updatedAt);
  if (!/^[1-9]\d*$/.test(usdMarket?.usdPerFthg) || !Number.isFinite(updated)
    || updated < Date.now() - 300000 || updated > Date.now() + 30000) return "USD unavailable";
  const value = BigInt(raw) * BigInt(usdMarket.usdPerFthg) / ONE;
  const cents = (value + 5n * 10n ** 15n) / 10n ** 16n;
  if (value > 0n && cents === 0n) return "<$0.01";
  return `$${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
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
function stat(label, value, note = "", className = "") {
  return el("div", { className: `stat ${className}`.trim() }, el("span", { textContent: label }), el("b", { textContent: value }), el("small", { textContent: note }));
}
const fromWei = (raw) => Number(BigInt(raw || "0")) / 1e18;
function dollars(value) {
  if (!Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.01) return `$${value.toPrecision(3)}`;
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
const pooled = () => usdMarket && !usdMarket.fallback && /^\d+$/.test(usdMarket.usdPerFthg || "") && /^\d+$/.test(usdMarket.fthgPerEth || "");
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
  const [supply, source, reserve, poolManager] = await Promise.all([
    call("0x18160ddd", block),
    call(`0x70a08231${padAddress(SOURCE_WALLET)}`, block),
    call(`0x70a08231${padAddress(RESERVE_WALLET)}`, block),
    call(`0x70a08231${padAddress(POOL_MANAGER)}`, block),
  ]);
  return { block: Number(BigInt(block)), supply, source, reserve, poolManager };
}
async function loadExplorerStats() {
  const [info, counters] = await Promise.all([
    getJson(`${BLOCKSCOUT_API}/tokens/${TOKEN}`),
    getJson(`${BLOCKSCOUT_API}/tokens/${TOKEN}/counters`).catch(() => ({})),
  ]);
  return { holders: Number(info.holders_count), transfers: Number(counters.transfers_count) };
}
async function loadApiStats() {
  const [gold, dollar] = await Promise.all(["/api/v1/gold/stats", "/api/v1/notes/stats"].map(async (url) => {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    return response.json();
  }));
  return { ...gold, fthDollar: dollar.fthDollar };
}

function renderPrimary(chain, explorer) {
  const outside = chain ? chain.supply - chain.source - chain.reserve : null;
  const count = (value) => Number.isFinite(value) ? value.toLocaleString("en-US") : "—";
  const live = pooled();
  const reserves = live && usdMarket.reserves?.tvlUsd ? usdMarket.reserves : null;
  const compactNumber = (value) => value.toLocaleString("en-US", { maximumFractionDigits: 3 });
  $("primaryStats").replaceChildren(
    stat("FTHG price", /^\d+$/.test(usdMarket?.usdPerFthg || "") ? dollars(fromWei(usdMarket.usdPerFthg)) : "—", live
      ? `Uniswap spot · ${compactNumber(fromWei(usdMarket.fthgPerEth))} per ETH` : "Reference price until the pool has data", "feature"),
    stat("Fully diluted value", chain ? usd(chain.supply) : "—", "Total supply × pool price"),
    stat("Pool liquidity", reserves ? dollars(fromWei(reserves.tvlUsd)) : "—", reserves
      ? `${reserves.positions} position${reserves.positions === 1 ? "" : "s"} · 0.25% fee tier` : "Uniswap v4 ETH/FTHG"),
    stat("Pool reserves", reserves ? `${compactNumber(fromWei(reserves.fthg))} FTHG` : "—", reserves
      ? `+ ${fromWei(reserves.eth).toLocaleString("en-US", { maximumFractionDigits: 4 })} ETH (${dollars(fromWei(reserves.eth) * fromWei(usdMarket.usdPerEth))})` : "Reading pool…"),
    stat("Total supply", chain ? `${compact(chain.supply)} FTHG` : "—", chain ? `${tokens(chain.supply, 0)} · fixed, no minting` : "Unavailable"),
    stat("Circulating", outside === null ? "—" : `${compact(outside)} FTHG`, outside === null ? "" : `${share(outside, chain.supply)} outside the fixed wallets`),
    stat("Holders", explorer ? count(explorer.holders) : "—", "Blockscout-indexed addresses"),
    stat("Transfers", explorer ? count(explorer.transfers) : "—", "Blockscout index counter"),
  );
}
function renderSupply(chain) {
  if (!chain) {
    $("supplyLegend").replaceChildren(el("li", { className: "muted", textContent: "Supply distribution is unavailable right now." }));
    return;
  }
  const rest = chain.supply - chain.source - chain.reserve;
  // v4 pools hold no balance of their own; prefer this pool's reconstructed reserves over the shared PoolManager balance.
  const reported = /^\d+$/.test(usdMarket?.reserves?.fthg || "") ? BigInt(usdMarket.reserves.fthg) : chain.poolManager;
  const pool = reported > rest ? rest : reported < 0n ? 0n : reported;
  const parts = [
    ["Source wallet", chain.source, "#e2b13c", SOURCE_WALLET],
    ["FTH$ reserve wallet", chain.reserve, "#7fa8e0", RESERVE_WALLET],
    ["Uniswap ETH/FTHG pool", pool, "#d97ad6", POOL_ID, POOL_URL],
    ["All other holders & contracts", rest - pool, "#5fbf6a", ""],
  ];
  const total = Number(chain.supply / ONE) || 1;
  $("supplyBar").replaceChildren(...parts.map(([label, value, color]) =>
    el("i", { title: `${label}: ${share(value, chain.supply)}`, style: `width:${(Number(value / ONE) / total) * 100}%;background:${color}` })));
  $("supplyLegend").replaceChildren(...parts.map(([label, value, color, address, link]) =>
    el("li", {},
      el("span", { className: "swatch", style: `background:${color}` }),
      el("div", {},
        el("b", { textContent: `${label} · ${share(value, chain.supply)}` }),
        el("small", { textContent: `${tokens(value, 0)} FTHG · ${usd(value)}` }),
        address ? el("small", {}, el("a", { href: link || `${BLOCKSCOUT_URL}/address/${address}`, title: address, target: "_blank", rel: "noopener noreferrer", textContent: short(address) })) : null))));
}
function renderEconomy(api) {
  if (api?.goldReserve?.enabled) {
    const reserve = api.goldReserve;
    const dynamic = reserve.pricingPolicy === "origin-linear-v1";
    const rate = dynamic ? tokens(reserve.spotRateFthDollarPerFthg) : Number(reserve.rate).toLocaleString("en-US", { maximumFractionDigits: 2 });
    $("rateValue").textContent = `1 FTHG ${dynamic ? "≈" : "="} ${rate} FTH$`;
    $("rateNote").textContent = dynamic
      ? "Current spot price on a demand-based curve, not a fixed rate. It starts at 10,000 FTH$, rises as Gold is allocated and falls as it is returned; larger trades move the price. No Mainnet transfers are submitted."
      : `Legacy fixed-rate ${reserve.mode === "live" ? "live off-chain reserve" : "isolated reserve test"}. No Mainnet transfers are submitted.`;
    $("economyStats").replaceChildren(
      stat("Reserve mode", reserve.initialized ? "Initialized" : "Not initialized", reserve.mode === "live" ? "Live off-chain allocation" : "Separate test journal"),
      stat("Remaining initial allocation", `${compact(reserve.remaining || "0")} FTHG`, "Immutable verified origin cap; no automatic increases"),
      stat("Redeemable backing", `${compact(reserve.redeemableBacking || "0")} FTHG`, "Confirmed Ethereum backing only"),
      stat("Pending settlement", `${compact(reserve.pendingIn || "0")} FTHG`, "Manual sync preview on Conversion & sync"),
    );
    return;
  }
  const ledger = api?.fthDollar;
  $("rateValue").textContent = "FTHG / FTH$ rate unavailable";
  $("rateNote").textContent = api ? "Finite reserve engine is not enabled. Existing FTH$ circulates; no automatic issuance." : "Reserve service unavailable. Conversion eligibility cannot be verified.";
  $("economyStats").replaceChildren(
    stat("Reserve engine", api ? "Not enabled" : "Unavailable", "Check reserve admin before any conversion or transfer"),
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
  skeleton($("primaryStats"), 8);
  skeleton($("economyStats"), 4);
  const walletHost = location.hostname.endsWith(".localhost") ? "wallet.localhost" : "wallet.featheral.com";
  const referenceUrl = `${location.protocol}//${walletHost}${location.port ? ":" + location.port : ""}/api/creation/economy/reference`;
  const [chain, explorer, api, transfers, holders, reference] = await Promise.allSettled([
    loadChainStats(),
    loadExplorerStats(),
    loadApiStats(),
    getJson(`${BLOCKSCOUT_API}/tokens/${TOKEN}/transfers`).then((data) => data.items || []),
    getJson(`${BLOCKSCOUT_API}/tokens/${TOKEN}/holders`).then((data) => data.items || []),
    fetch("/api/v1/gold/valuation", { cache: "no-store" }).then((response) => {
      if (!response.ok) throw new Error(`Gold valuation HTTP ${response.status}`);
      return response.json();
    }).then((body) => ({ usdMarket: body.market })).catch(() => fetch(referenceUrl, { credentials: "omit", cache: "no-store" }).then(response => {
      if (!response.ok) throw new Error(`Gold valuation HTTP ${response.status}`);
      return response.json();
    })),
  ]);
  if (reference.status === "rejected") console.error("Gold USD valuation unavailable:", reference.reason);
  usdMarket = reference.status === "fulfilled" ? reference.value.usdMarket : null;
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
