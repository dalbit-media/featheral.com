"use strict";
const { ethers } = window;
const $ = (id) => document.getElementById(id);

const NETWORKS = {
  1: { name: "Ethereum Mainnet", scan: "https://etherscan.io", router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
       tokens: { WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7" } },
};
const CONTRACT_ADDRESS = "0xBa658127d93B17E577E1B8e8995cAB3aE7d7C665";
const CONTRACT_CHAIN_ID = 1;
const TREASURY_SOURCE_ADDRESS = "0xD2f1Be8414472E9f436B65e91A2B8dFDa418287c";
const FTH_DOLLAR_RESERVE_ADDRESS = "0x706CCb6109046a6a4A08dbAD4444A46408703ccb";
const READ_RPC_URL = "https://ethereum-rpc.publicnode.com";
const FTHG_ESTIMATED_USD = 0.01;

const PROJECT = {
  site: "https://featheral.com",
  logo: "https://gold.featheral.com/shared/logo.svg",
  desc: "Featheral Gold (FTHG) is the utility and economy-stabilizing token of Featheral World, an unlimited virtual federation economy simulation at featheral.com. 1 FTHG represents 1 kg of the world's above-ground gold; the total supply is fixed at 216,265,000 FTHG. FTHG can be exchanged for the in-game currency Featheral Dollar (FTH$).",
};
const ROUTER_ABI = [
  "function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)",
  "function removeLiquidity(address,address,uint256,uint256,uint256,address,uint256) returns (uint256,uint256)",
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])",
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
];
const FACTORY_ABI = ["function getPair(address,address) view returns (address)", "function createPair(address,address) returns (address)"];
const PAIR_ABI = [
  "function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)",
  "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];
const ERC20_MIN = ["function decimals() view returns (uint8)", "function symbol() view returns (string)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"];

const TOKEN_URL = `https://etherscan.io/token/${CONTRACT_ADDRESS}`;
const BLOCKSCOUT_API = "https://eth.blockscout.com/api/v2";
const BLOCKSCOUT_URL = "https://eth.blockscout.com";
const METADATA_PLATFORM_LINKS = [
  ["Etherscan token info", `https://etherscan.io/tokenupdate?a=${CONTRACT_ADDRESS}`, "Explorer icon, description, and project links"],
  ["Blockscout token page", `${BLOCKSCOUT_URL}/token/${CONTRACT_ADDRESS}`, "Explorer token profile"],
  ["CoinGecko request", "https://www.coingecko.com/en/coins/new", "Tracker listing and project profile"],
  ["CoinMarketCap request", "https://coinmarketcap.com/request/", "Tracker listing and metadata update"],
  ["Trust Wallet assets", "https://github.com/trustwallet/assets", "Wallet icon asset repository"],
  ["MetaMask token metadata", "https://github.com/MetaMask/contract-metadata", "Wallet token metadata repository"],
  ["Uniswap token list repository", "https://github.com/Uniswap/token-lists", "Token-list metadata contribution"],
];
const DEX_LINKS = [
  ["Uniswap token page", "DEX", `https://app.uniswap.org/explore/tokens/ethereum/${CONTRACT_ADDRESS}`],
  ["DEX Screener token page", "DEX analytics", `https://dexscreener.com/ethereum/${CONTRACT_ADDRESS}`],
  ["GeckoTerminal token page", "DEX analytics", `https://www.geckoterminal.com/eth/tokens/${CONTRACT_ADDRESS}`],
  ["DEXTools", "DEX analytics", "https://www.dextools.io/app/en/ether"],
  ["1inch token search", "DEX aggregator", `https://app.1inch.io/#/1/simple/swap/${CONTRACT_ADDRESS}`],
  ["Etherscan contract", "Explorer", TOKEN_URL],
  ["Etherscan verify source", "Explorer management", `https://etherscan.io/verifyContract?a=${CONTRACT_ADDRESS}`],
  ["Etherscan update token info", "Explorer management", `https://etherscan.io/tokenupdate?a=${CONTRACT_ADDRESS}`],
  ["Sourcify verification record", "Source verification", `https://sourcify.dev/#/lookup/${CONTRACT_ADDRESS}`],
  ["Blockscout token page", "Explorer", `https://eth.blockscout.com/token/${CONTRACT_ADDRESS}`],
];
const DATA_LINKS = [
  ["CoinGecko listing request", "Tracker submission", "https://www.coingecko.com/en/coins/new"],
  ["CoinMarketCap listing request", "Tracker submission", "https://coinmarketcap.com/request/"],
  ["CryptoCompare", "Market data", "https://www.cryptocompare.com/coins/list/"],
  ["Coinpaprika", "Market data", "https://coinpaprika.com/"],
  ["Live Coin Watch", "Market data", "https://www.livecoinwatch.com/"],
  ["Messari", "Research", "https://messari.io/"],
  ["Trust Wallet assets", "Wallet directory", "https://github.com/trustwallet/assets"],
  ["MetaMask token metadata", "Wallet directory", "https://github.com/MetaMask/contract-metadata"],
  ["Uniswap token list registry", "Token list", "https://tokenlists.org/"],
  ["Uniswap token list repository", "Token list management", "https://github.com/Uniswap/token-lists"],
  ["DefiLlama", "Analytics", "https://defillama.com/"],
];
const CEX_PORTALS = [
  ["Coinbase", "https://assets.coinbase.com/review", "Official asset listing request; prepare project and market evidence."],
  ["Binance", "https://www.binance.com/en/support/faq/how-to-get-your-coin-listed-on-binance-com-115000422152", "Official listing guidance; follow only the current Binance instructions."],
  ["Binance.US", "https://www.binance.us/listing", "US listing request, subject to jurisdiction and eligibility."],
  ["Kraken", "https://www.kraken.com/get-listed", "Official asset listing portal."],
  ["OKX", "https://www.okx.com/en-us/token-listing-apply", "Official token listing application."],
  ["KuCoin", "https://www.kucoin.com/listing", "Official project listing portal."],
  ["Gate.io", "https://www.gate.com/listing", "Official Gate listing application."],
  ["Crypto.com", "https://crypto.com/asset-listing", "Official asset listing request."],
  ["Bybit", "https://www.bybit.com/en/trade/spot/listing-apply", "Official spot listing application."],
  ["Bitget", "https://www.bitget.com/en/apply-listing/", "Official project listing application."],
];
const PLATFORM_LINKS = [...DEX_LINKS, ...DATA_LINKS, ...CEX_PORTALS.map(([name, url]) => [`${name} CEX application`, "CEX application", url])];
const PLATFORM_WORK_ESTIMATES = {
  "Uniswap token page": { hours: [0.1, 0.25], fee: "No fee for public lookup" },
  "DEX Screener token page": { hours: [0.1, 0.25], fee: "No fee for public lookup; pool and liquidity costs excluded" },
  "GeckoTerminal token page": { hours: [0.1, 0.25], fee: "No fee for public lookup; pool and liquidity costs excluded" },
  DEXTools: { hours: [0.1, 0.5], fee: "No fee for public lookup; pool and liquidity costs excluded" },
  "1inch token search": { hours: [0.1, 0.25], fee: "No fee for public lookup; swap gas excluded" },
  "Etherscan contract": { hours: [0.1, 0.25], fee: "No fee for public lookup" },
  "Etherscan verify source": { hours: [2, 6], fee: "Any paid service costs not verified; confirm with Etherscan" },
  "Etherscan update token info": { hours: [1, 3], fee: "Submission costs not verified; confirm with Etherscan" },
  "Sourcify verification record": { hours: [0.1, 0.25], fee: "No fee for public lookup" },
  "Blockscout token page": { hours: [0.1, 0.25], fee: "No fee for public lookup" },
  "CoinGecko listing request": { hours: [2, 4], fee: "Any optional review/expedited charges not included; verify current form" },
  "CoinMarketCap listing request": { hours: [2, 4], fee: "Application charges not verified; confirm current form" },
  CryptoCompare: { hours: [1, 3], fee: "Listing charges not verified" },
  Coinpaprika: { hours: [1, 3], fee: "Listing charges not verified" },
  "Live Coin Watch": { hours: [1, 2], fee: "Listing charges not verified" },
  Messari: { hours: [2, 4], fee: "Listing or data-service charges not verified" },
  "Trust Wallet assets": { hours: [2, 5], fee: "No fee for repository PR; review time excluded" },
  "MetaMask token metadata": { hours: [1, 3], fee: "No fee for repository PR; review time excluded" },
  "Uniswap token list registry": { hours: [1, 2], fee: "No fee for public lookup" },
  "Uniswap token list repository": { hours: [3, 8], fee: "No fee for repository PR; review time excluded" },
  DefiLlama: { hours: [2, 5], fee: "Listing charges not verified" },
  Coinbase: { hours: [8, 20], fee: "No listing fee per Coinbase published policy; internal readiness work excluded" },
  Binance: { hours: [8, 24], fee: "Not publicly verified; confirm directly with Binance" },
  "Binance.US": { hours: [6, 16], fee: "Not publicly verified; confirm directly with Binance.US" },
  Kraken: { hours: [8, 20], fee: "Not publicly confirmed; confirm directly with Kraken" },
  OKX: { hours: [6, 16], fee: "Not publicly verified; confirm directly with OKX" },
  KuCoin: { hours: [6, 16], fee: "Not publicly verified; confirm directly with KuCoin" },
  "Gate.io": { hours: [6, 16], fee: "Not publicly verified; confirm directly with Gate" },
  "Crypto.com": { hours: [6, 16], fee: "Not publicly verified; confirm directly with Crypto.com" },
  Bybit: { hours: [6, 16], fee: "Not publicly verified; confirm directly with Bybit" },
  Bitget: { hours: [6, 16], fee: "Not publicly verified; confirm directly with Bitget" },
};
const LISTING_TASKS = [
  { id: "profile", group: "dex", title: "Complete and publish project profile", details: "Add working docs/whitepaper, verified contact email, and official Telegram, X, and Discord URLs in Settings. Publish the same token name, ticker, contract, supply, logo, and utility across the website and social profiles.", links: [["Open Settings", "#settings"]] },
  { id: "metadata", group: "dex", title: "Publish permanent token metadata", details: "Host a stable JSON metadata document and logo on a durable HTTPS or IPFS URL. Verify its public retrieval and consistency, then set the on-chain metadata URI from Token using an authorized DEFAULT_ADMIN_ROLE wallet.", links: [["Open Token management", "#token"], ["Etherscan token info", `https://etherscan.io/tokenupdate?a=${CONTRACT_ADDRESS}`]] },
  { id: "source", group: "dex", title: "Verify source on Etherscan", details: "Reproduce the exact compiler, optimizer, EVM, constructor arguments, and deployed bytecode. Submit verification from the deployer or an authorized Etherscan account; confirm the public Code tab after processing.", links: [["Etherscan verify", `https://etherscan.io/verifyContract?a=${CONTRACT_ADDRESS}`], ["Contract page", TOKEN_URL]] },
  { id: "market", group: "dex", title: "Create a real Uniswap market and seed deliberate liquidity", details: "Select a quote asset and price based on a defensible public market process. Verify the pair address, quote-token decimals, treasury/holder balances, approvals, price impact, and liquidity depth before wallet confirmation. No pool or token transfer is performed by this task.", links: [["Uniswap token page", `https://app.uniswap.org/explore/tokens/ethereum/${CONTRACT_ADDRESS}`], ["Open DEX & Liquidity", "#dex"]] },
  { id: "trackers", group: "dex", title: "Request tracker and market-data coverage", details: "Only after a genuine market and reliable data exist, apply to CoinGecko and CoinMarketCap using the dossier. Supply pair URLs, current liquidity/volume, circulating-supply method, official project links, and proof the contract and website are controlled by the project.", links: [["CoinGecko request", "https://www.coingecko.com/en/coins/new"], ["CoinMarketCap request", "https://coinmarketcap.com/request/"]] },
  { id: "dex-profile", group: "dex", title: "Review DEX analytics profiles after the pool is indexed", details: "Confirm the correct Ethereum pair appears on DEX Screener and GeckoTerminal. Then use only the platform's official profile, token-info, or support process to request logo/social updates; public discovery does not mean an application was accepted.", links: [["DEX Screener", `https://dexscreener.com/ethereum/${CONTRACT_ADDRESS}`], ["GeckoTerminal", `https://www.geckoterminal.com/eth/tokens/${CONTRACT_ADDRESS}`]] },
  { id: "legal", group: "cex", title: "Obtain jurisdiction-specific legal and compliance review", details: "Document issuer/project entity, token rights and utility, distribution jurisdictions, sanctions/AML exposure, consumer disclosures, and any legal opinions requested. Get qualified counsel; this checklist is not legal advice.", links: [["Coinbase process", "https://www.coinbase.com/exchange/asset-listings"], ["Kraken requirements", "https://www.kraken.com/get-listed"]] },
  { id: "security", group: "cex", title: "Assemble security and operations evidence", details: "Prepare verified source, independent audit/review reports (or clearly disclose none), deployment and admin-role model, pause/blacklist controls, incident contacts, custody and key-management policy, and a vulnerability-response process.", links: [["Etherscan contract", TOKEN_URL]] },
  { id: "tokenomics", group: "cex", title: "Reconcile supply, distribution, treasury, and market data", details: "The contract supply is fixed at 216,265,000 FTHG. Publish a reproducible holder/distribution and circulating-supply methodology, treasury addresses and control, unlock policy (if any), live pool addresses, liquidity/volume history, and market-maker arrangements without implying that the $0.01 admin estimate is a market price.", links: [["Copy-ready dossier", "#listingDossier"], ["Etherscan holders", `${TOKEN_URL}#balances`]] },
  { id: "ops", group: "cex", title: "Prepare exchange integration and ongoing support", details: "Document Ethereum ERC-20 deposit/withdrawal support, decimals (18), confirmations/finality assumptions, monitoring/incident escalation, support staffing, listing communications, and any chain-maintenance risks. Do not send funds or grant wallet access in response to unsolicited listing offers.", links: [["Coinbase process", "https://www.coinbase.com/exchange/asset-listings"], ["Binance official guidance", "https://www.binance.com/en/support/faq/how-to-get-your-coin-listed-on-binance-com-115000422152"]] },
  ...CEX_PORTALS.map(([name, url, details], index) => ({
    id: `cex-${index}`, group: "cex", title: `Prepare ${name} application`, details: `${details} Review the live official form, jurisdiction coverage, current requested fields, and evidence. Submit through the platform directly; record any reference or status inside the platform rather than treating this local checklist as confirmation.`,
    links: [[`Open ${name} official portal`, url]],
  })),
];
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem("fthg." + k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem("fthg." + k, JSON.stringify(v)),
};
let provider, signer, account, chainId, token;
const readProvider = new ethers.JsonRpcProvider(READ_RPC_URL, CONTRACT_CHAIN_ID);
let balanceRequestId = 0;
let walletIsAdmin = false;
let walletHasAdminRole = false;
// The fixed source and FTH$ reserve wallets always unlock the admin view; other wallets need DEFAULT_ADMIN_ROLE.
const FIXED_ADMIN_WALLETS = new Set([TREASURY_SOURCE_ADDRESS, FTH_DOLLAR_RESERVE_ADDRESS].map((a) => a.toLowerCase()));
const isFixedAdminWallet = (address) => Boolean(address) && FIXED_ADMIN_WALLETS.has(address.toLowerCase());

function log(msg) { $("log").textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n` + $("log").textContent; }
function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  kids.forEach((k) => e.append(k));
  return e;
}
function net() { return NETWORKS[chainId]; }
function needWallet() { if (!signer) throw new Error("Connect wallet first"); }
function needToken() {
  needWallet();
  if (chainId !== CONTRACT_CHAIN_ID) throw new Error("Switch to Ethereum Mainnet to manage the FTHG contract");
  if (!token) throw new Error("The FTHG management ABI is not loaded");
}
const units = (v) => ethers.parseUnits(String(v).trim(), 18);
const fmt = (v) => ethers.formatUnits(v, 18);
const usd = (amount) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(fmt(amount)) * FTHG_ESTIMATED_USD);
const OPENING_FTH_DOLLAR_PER_FTHG = 1000;
const RATE_SCALE = 10n ** 18n;
// FTH$ per FTHG (18-decimal fixed point): live bridge spot when the pool is funded, else the 1:1000 opening rate.
function liveFthDollarRateRaw() {
  const bridge = tokenApiStats?.bridge;
  const live = bridge?.deployed && bridge?.initialized && bridge.reserveFthg !== "0" && bridge.reserveFthDollar !== "0" && bridge.spotRateFthDollarPerFthg;
  try { if (live && BigInt(live) > 0n) return BigInt(live); } catch { /* fall back to opening rate */ }
  return null;
}
const fthDollarRateRaw = () => liveFthDollarRateRaw() ?? BigInt(OPENING_FTH_DOLLAR_PER_FTHG) * RATE_SCALE;
const fthDollarRateIsLive = () => liveFthDollarRateRaw() !== null;
const fthgToFthDollar = (fthg) => (BigInt(fthg) * fthDollarRateRaw()) / RATE_SCALE;
const compact = (raw, digits = 2) => new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(Number(fmt(raw)));
const fthDollarText = (raw) => `${compact(raw)} FTH$`;
const fthDollarUsd = (raw) => {
  const value = Number(fmt(raw)) * FTHG_ESTIMATED_USD / Number(fmt(fthDollarRateRaw()));
  const precision = value > 0 && value < 0.01 ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: 2 };
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", ...precision }).format(value);
};
function renderLiquidityPlaceholder(message) {
  const summary = $("liquiditySummary");
  summary.replaceChildren(el("p", { className: "muted", textContent: message }));
  $("liquidityFlow").textContent = message;
}
async function refreshLiquidityBalances() {
  const requestId = ++balanceRequestId;
  if (!build) {
    renderLiquidityPlaceholder("FTHG ABI is loading; balances will appear shortly.");
    return;
  }
  renderLiquidityPlaceholder("Reading on-chain FTHG balances…");
  try {
    const blockTag = await readProvider.getBlockNumber();
    const readToken = new ethers.Contract(CONTRACT_ADDRESS, build.abi, readProvider);
    const [symbol, supply, sourceBalance, reserveBalance] = await Promise.all([
      readToken.symbol({ blockTag }),
      readToken.totalSupply({ blockTag }),
      readToken.balanceOf(TREASURY_SOURCE_ADDRESS, { blockTag }),
      readToken.balanceOf(FTH_DOLLAR_RESERVE_ADDRESS, { blockTag }),
    ]);
    if (requestId !== balanceRequestId) return;
    if (symbol !== "FTHG" || supply.toString() !== build.totalSupply) throw new Error("The fixed Mainnet address did not pass FTHG verification.");
    const total = sourceBalance + reserveBalance;
    const values = [
      ["Fixed source wallet", sourceBalance],
      ["FTH$ reserve wallet", reserveBalance],
      ["Combined wallet holdings", total],
    ];
    $("liquiditySummary").replaceChildren(...values.map(([label, amount]) => el("div", { className: "liquidity-stat" },
      el("span", { textContent: label }),
      el("b", { textContent: fthDollarText(fthgToFthDollar(amount)) }),
      el("small", { textContent: `${fmt(amount)} FTHG · ${usd(amount)} est.` }))));
    const rateText = `${compact(fthDollarRateRaw(), 4)} FTH$ / FTHG (${fthDollarRateIsLive() ? "live bridge spot" : "opening rate"})`;
    $("liquidityFlow").textContent = `Source ${TREASURY_SOURCE_ADDRESS}: ${fthDollarText(fthgToFthDollar(sourceBalance))} (${fmt(sourceBalance)} FTHG) → FTH$ reserve ${FTH_DOLLAR_RESERVE_ADDRESS}: ${fthDollarText(fthgToFthDollar(reserveBalance))} (${fmt(reserveBalance)} FTHG) · Combined ${fthDollarText(fthgToFthDollar(total))} ≈ ${usd(total)} · Rate ${rateText} · $${FTHG_ESTIMATED_USD.toFixed(2)}/FTHG estimate · Ethereum block ${blockTag}`;
  } catch (e) {
    if (requestId !== balanceRequestId) return;
    renderLiquidityPlaceholder("Unable to read on-chain FTHG balances: " + errText(e));
  }
}
const deadline = () => Math.floor(Date.now() / 1000) + 1200;
const slip = (v, pct) => (v * BigInt(Math.round((100 - Number(pct)) * 100))) / 10000n;
const addr = (v) => { const a = String(v).trim(); if (!ethers.isAddress(a)) throw new Error("Invalid address: " + (a || "(empty)")); return a; };
const roleId = (n) => (n === "DEFAULT_ADMIN_ROLE" ? ethers.ZeroHash : ethers.id(n));

// Custom errors the token can bubble up from OpenZeppelin (not always present in the contract ABI).
const EXTRA_ERRORS = [
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InvalidSender(address sender)",
  "error ERC20InvalidReceiver(address receiver)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InvalidApprover(address approver)",
  "error ERC20InvalidSpender(address spender)",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error AccessControlBadConfirmation()",
  "error EnforcedPause()",
  "error ExpectedPause()",
  "error ERC2612ExpiredSignature(uint256 deadline)",
  "error ERC2612InvalidSigner(address signer, address owner)",
  "error InvalidAccountNonce(address account, uint256 currentNonce)",
];
let errIface = new ethers.Interface(EXTRA_ERRORS);
function buildErrIface() {
  const seen = new Set(EXTRA_ERRORS.map((x) => x.replace(/^error /, "").replace(/ \w+(?=[,)])/g, "")));
  const frags = (build?.abi || []).filter((f) => f.type === "error");
  errIface = new ethers.Interface([...EXTRA_ERRORS, ...frags.filter((f) => !seen.has(`${f.name}(${(f.inputs || []).map((i) => i.type).join(",")})`))]);
}
const ROLE_NAMES = () => Object.fromEntries(["DEFAULT_ADMIN_ROLE", "PAUSER_ROLE", "COMPLIANCE_ROLE", "TREASURY_ROLE"].map((n) => [roleId(n), n]));
const short = (a) => (typeof a === "string" && a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : a);
const HEX_DATA = /^0x[0-9a-f]{8,}$/i;

function revertData(e) {
  const c = [e?.data, e?.error?.data, e?.error?.data?.data, e?.info?.error?.data, e?.info?.error?.data?.data, e?.info?.error?.data?.originalError?.data, e?.revert?.data, e?.info?.payload?.data];
  const hit = c.find((x) => typeof x === "string" && HEX_DATA.test(x) && x !== e?.transaction?.data && x.length < 2000);
  if (hit) return hit;
  return null;
}
function decodeRevert(data) {
  if (!data) return null;
  if (data === "0x") return "Transaction reverted without a reason (check amounts, balances and that the contract is the right one).";
  let p;
  try { p = errIface.parseError(data); } catch { return `Reverted with unknown error ${data.slice(0, 10)} (data ${data.slice(0, 74)}).`; }
  if (!p) return `Reverted with unknown error ${data.slice(0, 10)}.`;
  const a = p.args;
  switch (p.name) {
    case "Error": return "Reverted: " + a[0];
    case "Panic": return "Contract panic code 0x" + a[0].toString(16);
    case "EnforcedPause": return "Token transfers are paused.";
    case "ExpectedPause": return "Token is not paused.";
    case "Blacklisted": return `Address ${a[0]} is blacklisted.`;
    case "ExchangeDisabled": return "Game exchange is disabled.";
    case "InvalidRate": return "Invalid rate (must be greater than 0; set a rate before enabling the exchange).";
    case "ZeroAddress": return "Zero address is not allowed.";
    case "ZeroAmount": return "Amount must be greater than 0.";
    case "ERC20InsufficientBalance": return `Insufficient FTHG balance: has ${fmt(a[1])}, needs ${fmt(a[2])}.`;
    case "ERC20InsufficientAllowance": return `Insufficient allowance: ${fmt(a[1])} approved, ${fmt(a[2])} needed.`;
    case "ERC20InvalidReceiver": return `Invalid receiver ${a[0]}.`;
    case "ERC20InvalidSender": return `Invalid sender ${a[0]}.`;
    case "AccessControlUnauthorizedAccount": return `${short(a[0])} lacks the ${ROLE_NAMES()[a[1]] || a[1]} role. Connect an account that has it.`;
    default: return `${p.name}(${[...a].map(String).join(", ")})`;
  }
}

function errText(e) {
  const code = e?.code, ic = e?.info?.error?.code ?? e?.error?.code;
  if (code === "ACTION_REJECTED" || code === 4001 || ic === 4001) return "Transaction rejected in wallet.";
  const decoded = decodeRevert(revertData(e));
  if (decoded) return decoded;
  if (code === 4100 || ic === 4100) return "Wallet has not authorized this account. Reconnect the wallet.";
  if (code === 4900 || code === 4901 || ic === 4900 || ic === 4901) return "Wallet is disconnected from the network. Reconnect and try again.";
  if (ic === -32002 || code === -32002) return "A wallet request is already pending. Open the wallet popup and resolve it.";
  if (code === "INSUFFICIENT_FUNDS" || /insufficient funds|enough funds|exceeds the balance|gas required exceeds allowance/i.test(String(e?.message || "") + String(e?.info?.error?.message || ""))) return "Insufficient ETH to pay for gas. Add more ETH to the connected wallet on this network, or wait for lower gas prices.";
  if (code === "NONCE_EXPIRED" || code === "REPLACEMENT_UNDERPRICED") return "Nonce conflict: a pending transaction exists in the wallet. Speed up/cancel it, then retry.";
  if (code === "NETWORK_ERROR" || code === "SERVER_ERROR") return "Network/RPC error. Check the connection and selected network.";
  const nested = [e?.info?.error?.data?.message, e?.error?.data?.message, e?.data?.message, e?.info?.error?.data?.originalError?.message, e?.info?.error?.message, e?.error?.message];
  const generic = /^internal json-rpc error\.?$/i;
  const m = nested.find((x) => typeof x === "string" && x && !generic.test(x)) || e?.reason || e?.shortMessage || e?.message || String(e);
  if (/could not coalesce/i.test(m)) {
    const all = [...m.matchAll(/"message":\s*"([^"]+)"/g)].map((x) => x[1]).filter((x) => !generic.test(x));
    return all.length ? all[0] : "Wallet returned an unreadable error. Check the wallet popup, selected network and ETH balance. Raw: " + m.slice(0, 200);
  }
  if (generic.test(m) || /missing revert data|CALL_EXCEPTION/i.test(m)) return "Wallet/RPC reported 'Internal JSON-RPC error' with no reason. Likely causes: wrong network, wrong contract address, insufficient ETH for gas, or the call would revert. Details are in the log.";
  return m;
}
function rawErr(e) {
  const seen = new WeakSet();
  const s = JSON.stringify(e, (k, v) => { if (typeof v === "bigint") return v.toString(); if (v && typeof v === "object") { if (seen.has(v)) return undefined; seen.add(v); } if (typeof v === "string" && v.length > 120) return v.slice(0, 120) + "..."; return v; }) || "";
  return ((e?.message ? e.message.slice(0, 200) + " | " : "") + s).slice(0, 900);
}
// Technical details for the log so every failure can be traced.
function errTrace(e) {
  const parts = [];
  if (e?.code !== undefined) parts.push("code=" + e.code);
  const ic = e?.info?.error?.code ?? e?.error?.code; if (ic !== undefined) parts.push("rpcCode=" + ic);
  if (e?.action) parts.push("action=" + e.action);
  if (e?.transaction?.to) parts.push("to=" + e.transaction.to);
  if (e?.receipt?.hash) parts.push("tx=" + e.receipt.hash);
  const d = revertData(e); if (d) parts.push("data=" + d.slice(0, 74));
  if (chainId) parts.push("chain=" + chainId);
  return parts.join(" ");
}
async function run(label, fn) {
  try { const r = await fn(); if (r?.wait) { log(`${label}: sent ${r.hash}`); await r.wait(); log(`${label}: confirmed`); } return r; }
  catch (e) { console.error(e); log(`${label} FAILED: ${errText(e)}${errTrace(e) ? "\n    trace: " + errTrace(e) : ""}\n    raw: ${rawErr(e)}`); alert(errText(e)); }
}
// Simulate first so reverts surface as decoded reasons instead of a generic wallet error.
async function send(c, name, ...args) {
  await assertChain();
  try { await c[name].staticCall(...args); }
  catch (e) { if (revertData(e) || e?.code === "CALL_EXCEPTION" || /revert/i.test(e?.message || "")) throw e; log(`Simulation of ${name} skipped: ${errText(e)}`); }
  return c[name](...args);
}
async function assertChain() {
  const cur = Number((await provider.getNetwork()).chainId);
  if (cur !== chainId) throw new Error("Wallet network changed. Reload the page.");
}
window.addEventListener("unhandledrejection", (ev) => { console.error(ev.reason); log("Unhandled error: " + errText(ev.reason)); });
const act = (id, label, fn) => $(id).addEventListener("click", () => run(label, async () => { const r = await fn(); refresh(); return r; }));

function settings() { return store.get("settings", {}); }
function addressFor(cid) { return Number(cid) === CONTRACT_CHAIN_ID ? CONTRACT_ADDRESS : ""; }

const MAINNET_HEX = "0x1";
async function ensureMainnet() {
  const current = await window.FeatheralProfile.getProvider().request({ method: "eth_chainId" });
  if (Number(current) === CONTRACT_CHAIN_ID) return;
  await window.FeatheralProfile.getProvider().request({ method: "wallet_switchEthereumChain", params: [{ chainId: MAINNET_HEX }] });
}
function renderWalletButton() {
  const button = $("connect");
  const onMainnet = chainId === CONTRACT_CHAIN_ID;
  button.classList.toggle("connected", Boolean(account) && onMainnet);
  button.classList.toggle("wrong-network", Boolean(account) && !onMainnet);
  const label = !account
    ? "Connect wallet to see your FTH$ balance (admin tools unlock for admin wallets)"
    : onMainnet
      ? `${walletIsAdmin ? "Admin wallet" : "Wallet"} ${account} on Ethereum Mainnet`
      : `Wallet ${account} is not on Ethereum Mainnet. Click to switch back.`;
  button.title = label;
  button.setAttribute("aria-label", label);
}
async function connect() {
  await buildReady;
  await ensureMainnet();
  provider = new ethers.BrowserProvider(window.FeatheralProfile.getProvider());
  signer = await provider.getSigner(window.FeatheralProfile.snapshot().account);
  account = await signer.getAddress();
  chainId = Number((await provider.getNetwork()).chainId);
  renderWalletButton();
  window.FeatheralProfile.setAccount(account);
  bindToken();
  refresh();
}

function bindToken() {
  const a = chainId === CONTRACT_CHAIN_ID ? addressFor(chainId) : "";
  token = build && signer && a && ethers.isAddress(a) ? new ethers.Contract(a, build.abi, signer) : null;
  $("sAddr").value = CONTRACT_ADDRESS;
}

let refreshGeneration = 0;
async function refresh() {
  refreshTokenApiStats();
  const generation = ++refreshGeneration;
  const checkedAccount = account;
  const stats = $("stats");
  stats.replaceChildren();
  // Overlapping refreshes (init + connect) must not append duplicate cards after their awaits resolve.
  const add = (k, v) => generation === refreshGeneration && stats.append(el("div", { className: "stat" }, el("span", { textContent: k }), el("b", { textContent: String(v) })));
  add("Wallet", account || "Not connected");
  add("Network", "Ethereum Mainnet (public read-only)");
  if (!build) {
    add("Contract", "Management ABI missing");
    renderBridgeUnavailable("Management ABI is loading.");
    renderTreasury(null);
    walletHasAdminRole = false;
    walletIsAdmin = isFixedAdminWallet(account);
    updateAdminAccess();
    refreshLiquidityBalances();
    return;
  }
  const readToken = new ethers.Contract(CONTRACT_ADDRESS, build.abi, readProvider);
  try {
    const [sym, sup, paused, rate, ex, uri, tre, sourceAdmin, reserveAdmin, latestBlock, currentAdmin] = await Promise.all([
      readToken.symbol(), readToken.totalSupply(), readToken.paused(), readToken.fthDollarPerFthg(),
      readToken.gameExchangeEnabled(), readToken.metadataURI(), readToken.treasury(),
      readToken.hasRole(ethers.ZeroHash, TREASURY_SOURCE_ADDRESS),
      readToken.hasRole(ethers.ZeroHash, FTH_DOLLAR_RESERVE_ADDRESS),
      readProvider.getBlockNumber(),
      checkedAccount ? readToken.hasRole(ethers.ZeroHash, checkedAccount) : false,
    ]);
    if (generation !== refreshGeneration || checkedAccount !== account) return;
    if (sym !== "FTHG" || sup.toString() !== build.totalSupply) throw new Error("The fixed Mainnet address did not pass FTHG verification.");
    renderTreasury(tre);
    add("Token", sym);
    add("Contract", short(CONTRACT_ADDRESS));
    add("Total supply", fmt(sup) + " FTHG");
    add("Transfers", paused ? "PAUSED" : "Active");
    add("FTH$ rate", `${compact(fthDollarRateRaw(), 4)} FTH$ / FTHG${fthDollarRateIsLive() ? "" : " (opening)"}`);
    add("Estimated price", `${fthDollarUsd(10n ** 18n)} / FTH$ · ${usd(10n ** 18n)} / FTHG`);
    add("Supply in FTH$", fthDollarText(fthgToFthDollar(sup)));
    add("Price basis", "Estimate, not market quote");
    $("bridgeEnabled").textContent = ex ? "Enabled" : "Disabled";
    $("bridgeEnabled").className = ex ? "status-enabled" : "status-disabled";
    $("bridgeRate").textContent = fmt(rate) + " FTH$ / FTHG";
    $("bridgeTreasury").textContent = tre;
    $("adminSourceStatus").textContent = `Source wallet ${short(TREASURY_SOURCE_ADDRESS)}: ${sourceAdmin ? "DEFAULT_ADMIN_ROLE" : "not an admin"}`;
    $("adminReserveStatus").textContent = `Reserve wallet ${short(FTH_DOLLAR_RESERVE_ADDRESS)}: ${reserveAdmin ? "DEFAULT_ADMIN_ROLE" : "not an admin"}`;
    if (document.activeElement !== $("rate")) $("rate").value = fmt(rate);
    walletHasAdminRole = currentAdmin;
    walletIsAdmin = walletHasAdminRole || isFixedAdminWallet(account);
    updateAdminAccess();
    $("liquidityFlow").dataset.block = String(latestBlock);
  } catch (e) {
    if (generation !== refreshGeneration || checkedAccount !== account) return;
    renderBridgeUnavailable("Unable to read contract stats: " + errText(e));
    renderTreasury(null);
    $("adminSourceStatus").textContent = "Could not check source wallet admin role.";
    $("adminReserveStatus").textContent = "Could not check reserve wallet admin role.";
    walletHasAdminRole = false;
    walletIsAdmin = isFixedAdminWallet(account);
    updateAdminAccess();
    add("Contract error", errText(e));
  }
  if (!token && account && chainId !== CONTRACT_CHAIN_ID) {
    $("walletAccessStatus").textContent = "Connected wallet is not on Ethereum Mainnet. Click the wallet icon to switch back.";
  }
  refreshLiquidityBalances();
}

function renderBridgeUnavailable(message) {
  $("bridgeEnabled").textContent = message;
  $("bridgeEnabled").className = "status-disabled";
  $("bridgeRate").textContent = "—";
  $("bridgeTreasury").textContent = "—";
}

let tokenApiStatsRequestId = 0;
let tokenApiStats = null;
function formatApiUnits(raw, decimals = 18) {
  if (raw === undefined || raw === null) return "Not reported";
  try { return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(Number(ethers.formatUnits(BigInt(raw), decimals))); }
  catch { return "Not reported"; }
}
function ledgerMetric(label, value, note = "") {
  return el("div", { className: "stat" },
    el("span", { textContent: label }),
    el("b", { textContent: String(value) }),
    el("small", { className: "muted", textContent: note }),
  );
}
function readinessCard(item) {
  const state = item.ready ? "listing-good" : "listing-warning";
  return el("article", { className: `listing-check ${state}` },
    el("div", { className: "listing-check-title" },
      el("b", { textContent: item.key.replaceAll("-", " ") }),
      el("span", { textContent: item.ready ? "READY" : "NOT READY" }),
    ),
    el("p", { textContent: item.detail }),
  );
}
function renderTokenApiStats(data) {
  tokenApiStats = data;
  const chain = data.chain || {};
  const bridge = data.bridge || {};
  const ledger = data.fthDollar || {};
  const poolReady = bridge.deployed && bridge.initialized && bridge.reserveFthg !== "0" && bridge.reserveFthDollar !== "0";
  const rate = poolReady ? `${formatApiUnits(bridge.spotRateFthDollarPerFthg)} FTH$ / FTHG` : "Unavailable";
  const aprPercent = Number(bridge.baseAprBps ?? 600) / 100;
  const metrics = [
    ledgerMetric("Node mode", `${data.node?.mode || "unknown"} · ${data.node?.id || "?"}`, "Only an explicitly configured writer accepts service writes"),
    ledgerMetric("FTH$ L3 block height", `#${Number(ledger.height ?? -1).toLocaleString("en-US")}`, `${Number(ledger.transactions || 0).toLocaleString("en-US")} sealed transactions · tip ${String(ledger.tipHash || "").slice(0, 12) || "—"}${ledger.signedBlocks ? " · writer-signed" : " · unsigned blocks"}`),
    ledgerMetric("FTHG total supply", `${formatApiUnits(chain.totalSupply)} FTHG`, "Fixed on-chain supply; not a liquidity reserve"),
    ledgerMetric("Actual source wallet", `${formatApiUnits(chain.sourceBalance)} FTHG`, chain.sourceWallet || "Fixed source wallet"),
    ledgerMetric("FTHG held by dynamic bridge", `${formatApiUnits(bridge.actualFthgBalance)} FTHG`, "On-chain custody balance; includes any locked staking principal"),
    ledgerMetric("Funded dynamic FTHG pool", `${formatApiUnits(bridge.reserveFthg)} FTHG`, poolReady ? `Actual deposited FTHG${bridge.paused ? " · bridge paused" : ""}` : "Zero until dynamic bridge pool is initialized"),
    ledgerMetric("Available curve FTH$ budget", formatApiUnits(bridge.reserveFthDollar), "Off-chain game ledger budget; not an on-chain token"),
    ledgerMetric("Current curve spot quote", rate, poolReady ? "Indicative spot price; trade output includes price impact" : "Starts at 1:1000 after explicit pool initialization"),
    ledgerMetric("Staked FTHG (on-chain)", `${formatApiUnits(bridge.totalStakedFthg)} FTHG`, "Read from the bridge contract on Ethereum; FTHG is not mirrored on the L3 ledger"),
    ledgerMetric("Game year / FTH$ supply", `${bridge.currentGameYear ?? "—"} / ${formatApiUnits(ledger.supply)} FTH$`, `${Number(ledger.holders || 0).toLocaleString("en-US")} holders · ${ledger.pendingRedemptions || 0} redemption reservations pending`),
    ledgerMetric("Base staking APR", `${aprPercent.toFixed(2)}%`, "Simple interest; locked market quote at stake time"),
  ];
  $("ledgerMetrics").replaceChildren(...metrics);
  $("ledgerReadiness").replaceChildren(...(data.ready || []).map(readinessCard));
  const summaryItems = [
    ["FTH$ L3 ledger node", `${data.node?.mode || "unknown"} · block #${Number(ledger.height ?? -1).toLocaleString("en-US")}`, data.node?.storage || "Daily minified JSON block files"],
    ["Dynamic bridge", poolReady ? `Live at ${short(bridge.address)}` : "Not deployed / pool disabled", poolReady ? rate : "FTHG total supply is not counted as funded liquidity."],
    ["Game clock & staking", bridge.gameClockInitialized ? `Game year ${bridge.currentGameYear}` : "Not initialized", `${aprPercent.toFixed(2)}% base APR · simple interest · quote locked at stake`],
  ];
  $("dashboardLedgerSummary").replaceChildren(...summaryItems.map(([title, detail, note]) =>
    el("article", { className: `listing-check${detail.includes("disabled") || detail.includes("Not") ? " listing-warning" : " listing-good"}` },
      el("div", { className: "listing-check-title" }, el("b", { textContent: title })),
      el("p", { textContent: detail }),
      el("small", { className: "muted", textContent: note }),
    ),
  ));
  const status = `API reachable · ${data.node?.mode || "unknown"} node · checked ${new Date(data.checkedAt || Date.now()).toLocaleString()}.`;
  $("ledgerCheckedAt").textContent = status;
  $("dashboardLedgerStatus").textContent = status;
  window.FeatheralProfile.setRate(Number(fmt(fthDollarRateRaw())));
}
async function refreshTokenApiStats() {
  const requestId = ++tokenApiStatsRequestId;
  $("ledgerCheckedAt").textContent = "Loading token API and ledger stats…";
  $("dashboardLedgerStatus").textContent = "Loading token API and ledger stats…";
  try {
    const response = await fetch("/api/v1/stats", { cache: "no-store", signal: AbortSignal.timeout(12_000) });
    const data = await response.json();
    if (requestId !== tokenApiStatsRequestId) return;
    if (!response.ok) throw new Error(data.error || `API returned HTTP ${response.status}.`);
    renderTokenApiStats(data);
  } catch (error) {
    if (requestId !== tokenApiStatsRequestId) return;
    tokenApiStats = null;
    const message = `Token API unavailable: ${error.message}. Run the service or configure its read-only RPC.`;
    $("ledgerCheckedAt").textContent = message;
    $("dashboardLedgerStatus").textContent = message;
    $("ledgerMetrics").replaceChildren(ledgerMetric("API status", "Unavailable", error.message));
    $("dashboardLedgerSummary").replaceChildren(readinessCard({ key: "token-api", ready: false, detail: error.message }));
    console.error(error);
  }
}

function updateAdminAccess() {
  const canAdmin = walletHasAdminRole && chainId === CONTRACT_CHAIN_ID && !!token;
  document.body.classList.toggle("is-admin", walletIsAdmin);
  $("adminBadge").hidden = !walletIsAdmin;
  $("adminBadge").title = walletHasAdminRole ? "This wallet holds DEFAULT_ADMIN_ROLE on the FTHG contract." : "Fixed project wallet: admin view unlocked; contract actions still require their on-chain roles.";
  renderWalletButton();
  const active = document.querySelector("#tabs button.active");
  if (!walletIsAdmin && active?.classList.contains("admin-only")) showTab("dashboard");
  $("walletAccessStatus").textContent = account
    ? `${short(account)} ${walletHasAdminRole ? "has" : "does not have"} DEFAULT_ADMIN_ROLE${!walletHasAdminRole && isFixedAdminWallet(account) ? " on-chain. As a fixed project wallet it unlocks the admin view; role transactions need a current DEFAULT_ADMIN_ROLE holder to grant it first." : walletHasAdminRole && chainId !== CONTRACT_CHAIN_ID ? "; switch to Ethereum Mainnet to manage roles." : "."}`
    : "Connect an authorized wallet to manage roles.";
  $("grant").disabled = !canAdmin;
  $("revoke").disabled = !canAdmin;
  $("grant").title = canAdmin ? "" : "Requires a connected Ethereum Mainnet wallet with DEFAULT_ADMIN_ROLE.";
  $("revoke").title = canAdmin ? "" : "Requires a connected Ethereum Mainnet wallet with DEFAULT_ADMIN_ROLE.";
}

/* Existing token management */
act("setUri", "Set URI", async () => { needToken(); return send(token, "setMetadataURI", $("uriNew").value.trim()); });
act("pause", "Pause", async () => { needToken(); if (confirm("Pause ALL FTHG transfers?")) return send(token, "pause"); });
act("unpause", "Unpause", async () => { needToken(); return send(token, "unpause"); });
act("transfer", "Transfer", async () => {
  needToken();
  const to = $("tTo").value.trim();
  if (!ethers.isAddress(to)) throw new Error("Invalid recipient address");
  return send(token, "transfer", to, units($("tAmt").value));
});
function renderTreasury(address) {
  $("treasurySource").textContent = TREASURY_SOURCE_ADDRESS;
  $("treasuryTarget").textContent = FTH_DOLLAR_RESERVE_ADDRESS;
  if (!address) {
    $("treasuryCurrent").textContent = "Current contract treasury is unavailable from the public Mainnet RPC.";
    $("setTreasury").hidden = true;
    return;
  }
  const isFixedReserve = ethers.getAddress(address) === FTH_DOLLAR_RESERVE_ADDRESS;
  $("treasuryCurrent").textContent = "Contract treasury: " + address;
  $("setTreasury").hidden = isFixedReserve;
}
$("setTreasury").addEventListener("click", () => run("Set treasury", async () => {
  needToken();
  await assertChain();
  const current = await token.treasury();
  if (ethers.getAddress(current) === FTH_DOLLAR_RESERVE_ADDRESS) {
    renderTreasury(current);
    throw new Error("The fixed FTH$ reserve is already configured.");
  }
  if (!confirm(`Set the FTHG contract treasury from ${current} to the fixed FTH$ reserve ${FTH_DOLLAR_RESERVE_ADDRESS}?\nThis changes the destination for future exchanges only. It does not transfer existing balances from the source wallet.`)) return;
  const tx = await send(token, "setTreasury", FTH_DOLLAR_RESERVE_ADDRESS);
  log("Set treasury: sent " + tx.hash);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error("Treasury configuration transaction reverted.");
  log("Set treasury: confirmed");
  const configured = await token.treasury();
  renderTreasury(configured);
  if (ethers.getAddress(configured) !== FTH_DOLLAR_RESERVE_ADDRESS) throw new Error("Transaction confirmed, but the on-chain treasury does not match the fixed FTH$ reserve.");
  await refresh();
}));

/* Roles */
act("grant", "Grant role", async () => { needToken(); return send(token, "grantRole", roleId($("rRole").value), addr($("rAcct").value)); });
act("revoke", "Revoke role", async () => { needToken(); if (confirm("Revoke role?")) return send(token, "revokeRole", roleId($("rRole").value), addr($("rAcct").value)); });
$("hasRole").onclick = () => run("Check role", async () => {
  if (!build) throw new Error("Management ABI is not loaded");
  const readToken = new ethers.Contract(CONTRACT_ADDRESS, build.abi, readProvider);
  const result = await readToken.hasRole(roleId($("rRole").value), addr($("rAcct").value));
  alert(String(result));
  return result;
});
act("blAdd", "Blacklist", async () => { needToken(); return send(token, "setBlacklisted", addr($("bl").value), true); });
act("blDel", "Unblacklist", async () => { needToken(); return send(token, "setBlacklisted", addr($("bl").value), false); });
$("blChk").onclick = () => run("Check blacklist", async () => { needToken(); alert(String(await token.blacklisted(addr($("bl").value)))); });

/* FTH$ bridge */
act("setRate", "Set rate", async () => { needToken(); return send(token, "setRate", units($("rate").value)); });
act("exOn", "Enable legacy exchange", async () => {
  needToken();
  if (!confirm("Enable the legacy fixed-rate exchange? The current FTH$ ledger does not settle its events. Only proceed if you have separately arranged legacy settlement; use Dollar admin for the current funded bridge.")) return;
  return send(token, "setGameExchangeEnabled", true);
});
act("exOff", "Disable exchange", async () => { needToken(); return send(token, "setGameExchangeEnabled", false); });
$("refreshLiquidity").onclick = () => refreshLiquidityBalances();
let exRows = [];
$("loadEx").onclick = () => run("Load exchanges", async () => {
  if (!build) throw new Error("Management ABI is not loaded");
  $("exStatus").textContent = "Loading events from the latest 5,000 blocks…";
  try {
    const latest = await readProvider.getBlockNumber();
    const start = Math.max(0, latest - 5000);
    const readToken = new ethers.Contract(CONTRACT_ADDRESS, build.abi, readProvider);
    const evs = await readToken.queryFilter(readToken.filters.ExchangedForFthDollar(), start, latest);
    exRows = evs.map((event) => ({
      block: event.blockNumber,
      hash: event.transactionHash,
      account: event.args.account,
      gameAccountId: event.args.gameAccountId,
      fthgAmount: event.args.fthgAmount,
      fthDollars: event.args.fthDollars,
    }));
    const totalFthg = exRows.reduce((sum, event) => sum + event.fthgAmount, 0n);
    const totalDollars = exRows.reduce((sum, event) => sum + event.fthDollars, 0n);
    $("exCount").textContent = String(exRows.length);
    $("exTotalFthg").textContent = fmt(totalFthg) + " FTHG";
    $("exTotalDollar").textContent = fmt(totalDollars) + " FTH$";
    $("exStatus").textContent = exRows.length
      ? `Showing latest ${Math.min(exRows.length, 100)} of ${exRows.length} events · blocks ${start.toLocaleString()}–${latest.toLocaleString()}`
      : `No exchange events found in blocks ${start.toLocaleString()}–${latest.toLocaleString()}.`;
    const scan = NETWORKS[CONTRACT_CHAIN_ID].scan;
    const rows = exRows.slice(-100).reverse().map((event) => {
      const tx = el("a", { className: "tx-link", href: `${scan}/tx/${event.hash}`, target: "_blank", rel: "noopener noreferrer", textContent: short(event.hash) });
      const holder = el("a", { href: `${scan}/address/${event.account}`, target: "_blank", rel: "noopener noreferrer", textContent: short(event.account) });
      const gameId = el("code", { title: event.gameAccountId, textContent: short(event.gameAccountId) });
      return el("tr", {},
        el("td", { textContent: event.block.toLocaleString() }),
        el("td", {}, tx),
        el("td", {}, holder),
        el("td", {}, gameId),
        el("td", { textContent: fmt(event.fthgAmount) + " FTHG" }),
        el("td", { textContent: fmt(event.fthDollars) + " FTH$ requested" }));
    });
    $("exTable").tBodies[0].replaceChildren(...rows);
  } catch (e) {
    $("exStatus").textContent = "Could not load exchange events: " + errText(e);
    throw e;
  }
});
$("csvEx").onclick = () => {
  const csv = "block,transactionHash,account,gameAccountId,fthg,fthDollars\n" + exRows.map((event) => [event.block, event.hash, event.account, event.gameAccountId, fmt(event.fthgAmount), fmt(event.fthDollars)].join(",")).join("\n");
  download("fthg-exchanges.csv", csv, "text/csv");
};

/* Uniswap V2 */
function dexCtx() {
  needToken();
  const n = net();
  if (!n) throw new Error("Unsupported network");
  const q = n.tokens[$("quote").value];
  if (!q) throw new Error("Quote token unavailable on this network");
  return { n, q, router: new ethers.Contract(n.router, ROUTER_ABI, signer), factory: new ethers.Contract(n.factory, FACTORY_ABI, signer) };
}
async function pairOf(c) {
  const a = await c.factory.getPair(await token.getAddress(), c.q);
  return a === ethers.ZeroAddress ? null : new ethers.Contract(a, PAIR_ABI, signer);
}
async function ensureAllowance(addr, spender, amt) {
  const t = new ethers.Contract(addr, ERC20_MIN, signer);
  if ((await t.allowance(account, spender)) < amt) { const tx = await t.approve(spender, amt); log("Approve " + tx.hash); await tx.wait(); }
}
$("pairInfo").onclick = () => run("Pair info", async () => {
  const c = dexCtx(); const p = await pairOf(c);
  if (!p) { $("pairOut").textContent = "No pair yet. Create it, then add liquidity."; return; }
  const [r0, r1] = await p.getReserves();
  const fthgIs0 = (await p.token0()).toLowerCase() === (await token.getAddress()).toLowerCase();
  const qd = await new ethers.Contract(c.q, ERC20_MIN, signer).decimals();
  const rf = fthgIs0 ? r0 : r1, rq = fthgIs0 ? r1 : r0;
  const price = rf > 0n ? Number(ethers.formatUnits(rq, qd)) / Number(fmt(rf)) : 0;
  $("pairOut").textContent = `Pair ${await p.getAddress()}\nFTHG reserve: ${fmt(rf)}\nQuote reserve: ${ethers.formatUnits(rq, qd)}\nPrice: ${price} ${$("quote").value} per FTHG\nYour LP: ${fmt(await p.balanceOf(account))} / ${fmt(await p.totalSupply())}`;
});
act("createPair", "Create pair", async () => { const c = dexCtx(); return c.factory.createPair(await token.getAddress(), c.q); });
act("addLiq", "Add liquidity", async () => {
  const c = dexCtx(); const ta = await token.getAddress();
  const qd = await new ethers.Contract(c.q, ERC20_MIN, signer).decimals();
  const a = units($("lFthg").value), b = ethers.parseUnits($("lQuote").value.trim(), qd), s = $("lSlip").value;
  await ensureAllowance(ta, c.n.router, a); await ensureAllowance(c.q, c.n.router, b);
  return c.router.addLiquidity(ta, c.q, a, b, slip(a, s), slip(b, s), account, deadline());
});
act("remLiq", "Remove liquidity", async () => {
  const c = dexCtx(); const p = await pairOf(c); if (!p) throw new Error("No pair");
  const pct = BigInt(Math.round(Number($("rPct").value) * 100));
  const amt = ((await p.balanceOf(account)) * pct) / 10000n;
  if (amt === 0n) throw new Error("No LP balance");
  await ensureAllowance(await p.getAddress(), c.n.router, amt);
  return c.router.removeLiquidity(await token.getAddress(), c.q, amt, 0n, 0n, account, deadline());
});
async function swapSetup() {
  const c = dexCtx(); const ta = await token.getAddress();
  const qd = await new ethers.Contract(c.q, ERC20_MIN, signer).decimals();
  const buy = $("side").value === "buy";
  const path = buy ? [c.q, ta] : [ta, c.q];
  const amtIn = ethers.parseUnits($("sAmt").value.trim(), buy ? qd : 18);
  const out = (await c.router.getAmountsOut(amtIn, path))[1];
  return { c, path, amtIn, out, outDec: buy ? 18 : qd };
}
$("quoteBtn").onclick = () => run("Quote", async () => {
  const s = await swapSetup();
  $("swapOut").textContent = `Expected out: ${ethers.formatUnits(s.out, s.outDec)}\nMin after slippage: ${ethers.formatUnits(slip(s.out, $("sSlip").value), s.outDec)}`;
});
act("swap", "Swap", async () => {
  const s = await swapSetup();
  await ensureAllowance(s.path[0], s.c.n.router, s.amtIn);
  return s.c.router.swapExactTokensForTokens(s.amtIn, slip(s.out, $("sSlip").value), s.path, account, deadline());
});

/* Listing readiness */
let listingStatusRequestId = 0;
let listingStatusSnapshot = {};
async function listingResponse(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    return await fetch(url, { cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
async function checkCoinGeckoListing() {
  const url = `https://api.coingecko.com/api/v3/coins/ethereum/contract/${CONTRACT_ADDRESS}`;
  const response = await listingResponse(url);
  if (response.status === 404) return { state: "missing", detail: "No CoinGecko coin record returned for this Ethereum contract (HTTP 404)." };
  if (!response.ok) throw new Error(`CoinGecko returned HTTP ${response.status}.`);
  const data = await response.json();
  return {
    state: "good",
    detail: `CoinGecko record found: ${data.name} (${data.symbol?.toUpperCase() || "symbol unavailable"}).`,
    url: data.id ? `https://www.coingecko.com/en/coins/${encodeURIComponent(data.id)}` : "https://www.coingecko.com/",
  };
}
async function checkDexScreenerListing() {
  const response = await listingResponse(`https://api.dexscreener.com/token-pairs/v1/ethereum/${CONTRACT_ADDRESS}`);
  if (!response.ok) throw new Error(`DEX Screener returned HTTP ${response.status}.`);
  const pairs = await response.json();
  if (!Array.isArray(pairs)) throw new Error("DEX Screener returned an unexpected response.");
  if (!pairs.length) return { state: "missing", detail: "No Ethereum trading pairs are currently indexed for this contract." };
  const pair = pairs.slice().sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))[0];
  const liquidity = Number(pair.liquidity?.usd);
  const volume = Number(pair.volume?.h24);
  return {
    state: "good",
    detail: `${pairs.length} pair${pairs.length === 1 ? "" : "s"} indexed. Top pair: ${pair.baseToken?.symbol || "?"}/${pair.quoteToken?.symbol || "?"}; liquidity $${Number.isFinite(liquidity) ? liquidity.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "not reported"}; 24h volume $${Number.isFinite(volume) ? volume.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "not reported"}.`,
    url: pair.url,
  };
}
async function checkGeckoTerminalListing() {
  const url = `https://api.geckoterminal.com/api/v2/networks/eth/tokens/${CONTRACT_ADDRESS}/pools?page=1`;
  const response = await listingResponse(url);
  if (response.status === 404) return { state: "missing", detail: "No GeckoTerminal pool records were returned for this Ethereum token." };
  if (!response.ok) throw new Error(`GeckoTerminal returned HTTP ${response.status}.`);
  const data = await response.json();
  const pools = Array.isArray(data.data) ? data.data : [];
  if (!pools.length) return { state: "missing", detail: "No GeckoTerminal pools are currently indexed for this Ethereum token." };
  const top = pools[0].attributes || {};
  return {
    state: "good",
    detail: `${pools.length} pool${pools.length === 1 ? "" : "s"} returned on page 1. Top pool ${top.name || top.address || "found"}; liquidity $${Number(top.reserve_in_usd || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}.`,
    url: `https://www.geckoterminal.com/eth/tokens/${CONTRACT_ADDRESS}`,
  };
}
async function checkBlockscoutListing() {
  const response = await listingResponse(`${BLOCKSCOUT_API}/tokens/${CONTRACT_ADDRESS}`);
  if (response.status === 404) return { state: "missing", detail: "Blockscout has no indexed token record for the contract." };
  if (!response.ok) throw new Error(`Blockscout returned HTTP ${response.status}.`);
  const data = await response.json();
  if (data.address_hash?.toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) {
    throw new Error("Blockscout returned a different contract address.");
  }
  const decimals = Number(data.decimals);
  const supply = data.total_supply && Number.isInteger(decimals)
    ? ethers.formatUnits(BigInt(data.total_supply), decimals)
    : "not reported";
  const holders = data.holders_count === undefined ? "not reported" : Number(data.holders_count).toLocaleString("en-US");
  return {
    state: data.name === "Featheral Gold" && data.symbol === "FTHG" ? "good" : "warning",
    detail: `${data.type || "Token"} indexed as ${data.name || "unnamed"} (${data.symbol || "no symbol"}), ${data.decimals ?? "?"} decimals; supply ${supply}; ${holders} indexed holder${holders === "1" ? "" : "s"}; ${data.icon_url ? "icon present" : "no explorer icon"}; ${data.exchange_rate ? "market rate present" : "no market rate indexed"}.`,
    holders: Number(data.holders_count),
    circulatingSupply: data.circulating_supply,
    exchangeRate: data.exchange_rate,
    icon: data.icon_url,
    url: `https://eth.blockscout.com/token/${CONTRACT_ADDRESS}`,
  };
}
const analyticsState = {
  holders: { items: [], next: null, loaded: false, loading: false },
  transfers: { items: [], next: null, loaded: false, loading: false },
  supply: null,
  decimals: 18,
  indexedHolderCount: null,
  explorerTransferCount: null,
  transferCounterNote: "Not loaded.",
  lastUpdated: null,
};
let analyticsInitialized = false;
function blockscoutAddress(value) {
  if (typeof value === "string") return value;
  return value?.hash || value?.address_hash || value?.ens_domain_name || "";
}
function formatTokenAmount(rawValue) {
  try {
    const formatted = ethers.formatUnits(BigInt(rawValue), analyticsState.decimals);
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(Number(formatted));
  } catch {
    return "Unavailable";
  }
}
function formatSupplyShare(rawValue) {
  if (!analyticsState.supply || analyticsState.supply === 0n) return "—";
  try {
    const basisPoints = BigInt(rawValue) * 10000n / analyticsState.supply;
    return `${(Number(basisPoints) / 100).toFixed(2)}%`;
  } catch {
    return "—";
  }
}
function analyticsMetric(label, value, note = "") {
  return el("div", { className: "stat" },
    el("span", { textContent: label }),
    el("b", { textContent: value }),
    el("small", { className: "muted", textContent: note }),
  );
}
function renderAnalyticsMetrics() {
  const holders = analyticsState.holders.items;
  const transfers = analyticsState.transfers.items;
  const loadedTop10 = holders.slice(0, 10).reduce((sum, item) => sum + BigInt(item.value || 0), 0n);
  const coverage = analyticsState.supply ? formatSupplyShare(loadedTop10.toString()) : "—";
  const topHolder = holders[0];
  $("tokenMetrics").replaceChildren(
    analyticsMetric("On-chain total supply", analyticsState.supply === null ? "Loading…" : `${formatTokenAmount(analyticsState.supply)} FTHG`, "Read from the fixed Ethereum contract"),
    analyticsMetric("Explorer-indexed holders", analyticsState.indexedHolderCount === null ? "Loading…" : analyticsState.indexedHolderCount.toLocaleString("en-US"), "Blockscout figure; indexing may lag"),
    analyticsMetric("Largest indexed holder", topHolder ? `${formatTokenAmount(topHolder.value)} FTHG · ${formatSupplyShare(topHolder.value)}` : "—", topHolder ? blockscoutAddress(topHolder.address) : "Load holder ranking"),
    analyticsMetric(`Top ${Math.min(10, holders.length)} loaded concentration`, holders.length ? coverage : "—", "Calculated from the first 10 loaded ranked holders"),
    analyticsMetric("Transfer records loaded", transfers.length.toLocaleString("en-US"), "Explorer rows loaded here, not a completeness claim"),
    analyticsMetric("Blockscout transfer counter", analyticsState.explorerTransferCount === null ? "Unavailable" : analyticsState.explorerTransferCount.toLocaleString("en-US"), analyticsState.transferCounterNote),
    analyticsMetric("Last checked", analyticsState.lastUpdated ? analyticsState.lastUpdated.toLocaleTimeString() : "—", "Read-only; refresh on demand"),
  );
}
function renderHolderRows() {
  const filter = $("holderFilter").value.trim().toLowerCase();
  const items = analyticsState.holders.items.filter((item) => {
    const address = blockscoutAddress(item.address).toLowerCase();
    const name = String(item.address?.name || item.address?.ens_domain_name || "").toLowerCase();
    return !filter || address.includes(filter) || name.includes(filter);
  });
  const body = $("holdersTable").tBodies[0];
  if (!items.length) {
    body.replaceChildren(el("tr", {}, el("td", { colSpan: 5, className: "muted", textContent: analyticsState.holders.items.length ? "No loaded holders match this filter." : "No holder records loaded." })));
    return;
  }
  body.replaceChildren(...items.map((item) => {
    const address = blockscoutAddress(item.address);
    const addressCell = address
      ? el("a", { href: `${BLOCKSCOUT_URL}/address/${encodeURIComponent(address)}`, target: "_blank", rel: "noopener noreferrer", textContent: item.address?.name || item.address?.ens_domain_name || short(address) })
      : el("span", { textContent: "Unknown address" });
    const tags = Array.isArray(item.address?.public_tags)
      ? item.address.public_tags.map((tag) => tag.label || tag.name || "").filter(Boolean).join(", ")
      : "";
    return el("tr", {},
      el("td", { textContent: String(analyticsState.holders.items.indexOf(item) + 1) }),
      el("td", {}, addressCell),
      el("td", { className: "numeric-cell", textContent: `${formatTokenAmount(item.value)} FTHG` }),
      el("td", { textContent: formatSupplyShare(item.value) }),
      el("td", { textContent: [tags, item.address?.is_contract ? "Contract" : ""].filter(Boolean).join(" · ") || "—" }),
    );
  }));
}
function transferFields(item) {
  const raw = item.total?.value ?? item.total ?? item.value ?? "0";
  const hash = item.transaction_hash || item.tx_hash || item.transaction?.hash || "";
  const from = blockscoutAddress(item.from);
  const to = blockscoutAddress(item.to);
  return {
    timestamp: item.timestamp || "",
    block: item.block_number ?? "",
    type: item.type || item.method || "Transfer",
    from,
    to,
    value: String(raw),
    hash,
  };
}
function renderTransferRows() {
  const filter = $("transferFilter").value.trim().toLowerCase();
  const items = analyticsState.transfers.items.map(transferFields).filter((item) =>
    !filter || [item.from, item.to, item.hash, item.type, item.block].some((value) => String(value).toLowerCase().includes(filter)),
  );
  const body = $("transfersTable").tBodies[0];
  if (!items.length) {
    body.replaceChildren(el("tr", {}, el("td", { colSpan: 7, className: "muted", textContent: analyticsState.transfers.items.length ? "No loaded transfer records match this filter." : "No transfer records loaded." })));
    return;
  }
  const addressLink = (address) => address
    ? el("a", { href: `${BLOCKSCOUT_URL}/address/${encodeURIComponent(address)}`, target: "_blank", rel: "noopener noreferrer", textContent: short(address) })
    : el("span", { textContent: "—" });
  body.replaceChildren(...items.map((item) => {
    const timestamp = item.timestamp && Number.isFinite(Date.parse(item.timestamp)) ? new Date(item.timestamp).toLocaleString() : "—";
    const transaction = item.hash
      ? el("a", { href: `https://etherscan.io/tx/${encodeURIComponent(item.hash)}`, target: "_blank", rel: "noopener noreferrer", textContent: short(item.hash) })
      : el("span", { textContent: "Unavailable" });
    return el("tr", {},
      el("td", { textContent: timestamp }),
      el("td", { textContent: String(item.block || "—") }),
      el("td", { textContent: String(item.type) }),
      el("td", {}, addressLink(item.from)),
      el("td", {}, addressLink(item.to)),
      el("td", { className: "numeric-cell", textContent: `${formatTokenAmount(item.value)} FTHG` }),
      el("td", {}, transaction),
    );
  }));
}
function pageUrl(kind, cursor) {
  const params = new URLSearchParams();
  if (cursor && typeof cursor === "object") {
    for (const [key, value] of Object.entries(cursor)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
  }
  const endpoint = kind === "holders" ? "holders" : "transfers";
  const query = params.toString();
  return `${BLOCKSCOUT_API}/tokens/${CONTRACT_ADDRESS}/${endpoint}${query ? `?${query}` : ""}`;
}
async function loadAnalyticsPage(kind, reset = false) {
  const state = analyticsState[kind];
  const status = $(kind === "holders" ? "holderListStatus" : "transferListStatus");
  const button = $(kind === "holders" ? "loadMoreHolders" : "loadMoreTransfers");
  if (state.loading || (!reset && state.loaded && !state.next)) return;
  if (reset) {
    state.items = [];
    state.next = null;
    state.loaded = false;
  }
  state.loading = true;
  button.disabled = true;
  status.textContent = `Loading ${kind === "holders" ? "holder balances" : "transfer records"} from Blockscout…`;
  try {
    const response = await listingResponse(pageUrl(kind, reset ? null : state.next));
    if (response.status === 404) throw new Error("Blockscout has no indexed records for this endpoint.");
    if (!response.ok) throw new Error(`Blockscout returned HTTP ${response.status}.`);
    const data = await response.json();
    if (!Array.isArray(data.items)) throw new Error("Blockscout returned an unexpected page shape.");
    state.items.push(...data.items);
    state.next = data.next_page_params && typeof data.next_page_params === "object" ? data.next_page_params : null;
    state.loaded = true;
    const loadedLabel = `${state.items.length.toLocaleString("en-US")} indexed ${kind === "holders" ? "holder balances" : "transfer records"} loaded`;
    const counterMismatch = kind === "transfers" && analyticsState.explorerTransferCount !== null
      && !state.next && analyticsState.explorerTransferCount !== state.items.length;
    analyticsState.transferCounterNote = counterMismatch
      ? `Returned ${state.items.length} rows, but explorer counter reports ${analyticsState.explorerTransferCount}; index fields disagree.`
      : "Explorer counters and pages are separate index fields, not completeness guarantees.";
    status.textContent = `${loadedLabel}${state.next ? ". More results are available." : ". No further page reported by the explorer."} Index coverage is not independently verified.${counterMismatch ? ` Counter/history mismatch: Blockscout reports ${analyticsState.explorerTransferCount} transfers.` : ""}`;
    analyticsState.lastUpdated = new Date();
  } catch (error) {
    status.textContent = `Could not load ${kind} from Blockscout: ${error.message}`;
    console.error(error);
  } finally {
    state.loading = false;
    button.disabled = state.loaded ? !state.next : false;
    if (kind === "holders") renderHolderRows();
    else renderTransferRows();
    renderAnalyticsMetrics();
  }
}
async function refreshAnalytics() {
  $("analyticsCheckedAt").textContent = "Reading contract supply and explorer index…";
  try {
    await buildReady;
    if (!build) throw new Error("The contract ABI is not available.");
    const readToken = new ethers.Contract(CONTRACT_ADDRESS, build.abi, readProvider);
    const counterPromise = listingResponse(`${BLOCKSCOUT_API}/tokens/${CONTRACT_ADDRESS}/counters`)
      .then(async (response) => response.ok ? response.json() : { error: `HTTP ${response.status}` })
      .catch((error) => ({ error: error.message }));
    const [supply, decimals, blockNumber, tokenResponse, counterData] = await Promise.all([
      readToken.totalSupply(),
      readToken.decimals(),
      readProvider.getBlockNumber(),
      listingResponse(`${BLOCKSCOUT_API}/tokens/${CONTRACT_ADDRESS}`),
      counterPromise,
    ]);
    if (!tokenResponse.ok) throw new Error(`Blockscout token endpoint returned HTTP ${tokenResponse.status}.`);
    const indexedToken = await tokenResponse.json();
    if (indexedToken.address_hash?.toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) throw new Error("Blockscout returned a different contract.");
    analyticsState.supply = BigInt(supply);
    analyticsState.decimals = Number(decimals);
    analyticsState.indexedHolderCount = Number.isFinite(Number(indexedToken.holders_count)) ? Number(indexedToken.holders_count) : null;
    const transferCount = Number(counterData?.transfers_count);
    analyticsState.explorerTransferCount = Number.isSafeInteger(transferCount) && transferCount >= 0 ? transferCount : null;
    analyticsState.transferCounterNote = analyticsState.explorerTransferCount === null
      ? `Counter not available (${counterData?.error || "field not reported"}).`
      : "Blockscout index counter; not guaranteed to match transfer pages.";
    analyticsState.lastUpdated = new Date();
    $("analyticsCheckedAt").textContent = `Checked at Ethereum block ${blockNumber.toLocaleString("en-US")} · ${analyticsState.lastUpdated.toLocaleString()}. Blockscout index completeness is not guaranteed.`;
    renderAnalyticsMetrics();
    await Promise.all([loadAnalyticsPage("holders", true), loadAnalyticsPage("transfers", true)]);
    analyticsInitialized = true;
  } catch (error) {
    $("analyticsCheckedAt").textContent = `Analytics refresh failed: ${error.message}`;
    console.error(error);
  }
}
function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}
function exportAnalyticsCsv(kind) {
  const rows = kind === "holders"
    ? [["rank", "address", "balance_fthg", "share_of_total_supply_percent", "explorer_name"],
      ...analyticsState.holders.items.map((item, index) => [
        index + 1, blockscoutAddress(item.address), formatTokenAmount(item.value),
        formatSupplyShare(item.value).replace("%", ""), item.address?.name || item.address?.ens_domain_name || "",
      ])]
    : [["timestamp", "block", "type", "from", "to", "amount_fthg", "transaction_hash"],
      ...analyticsState.transfers.items.map((item) => {
        const row = transferFields(item);
        return [row.timestamp, row.block, row.type, row.from, row.to, formatTokenAmount(row.value), row.hash];
      })];
  if (rows.length === 1) {
    alert(`No ${kind} have been loaded to export.`);
    return;
  }
  download(`fthg-${kind}-explorer-index-${new Date().toISOString().slice(0, 10)}.csv`, rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), "text/csv;charset=utf-8");
}
async function checkSourcifyVerification() {
  const response = await listingResponse(`https://sourcify.dev/server/v2/contract/${CONTRACT_CHAIN_ID}/${CONTRACT_ADDRESS}`);
  if (response.status === 404) return { state: "missing", detail: "No Sourcify verification record found for this Ethereum contract." };
  if (!response.ok) throw new Error(`Sourcify returned HTTP ${response.status}.`);
  const data = await response.json();
  const match = data.match || data.runtimeMatch || "verified";
  return {
    state: "good",
    detail: `Sourcify verification record found (${match} match). Verify the published source and compiler settings before relying on it.`,
    url: `https://sourcify.dev/#/lookup/${CONTRACT_ADDRESS}`,
  };
}
async function checkUniswapPools() {
  const factory = new ethers.Contract(NETWORKS[CONTRACT_CHAIN_ID].factory, FACTORY_ABI, readProvider);
  const checks = await Promise.all(Object.entries(NETWORKS[CONTRACT_CHAIN_ID].tokens).map(async ([symbol, address]) => {
    const pairAddress = await factory.getPair(CONTRACT_ADDRESS, address);
    if (pairAddress === ethers.ZeroAddress) return { symbol, pairAddress, liquidity: false };
    const pair = new ethers.Contract(pairAddress, PAIR_ABI, readProvider);
    const [reserves, token0, tokenDecimals] = await Promise.all([
      pair.getReserves(),
      pair.token0(),
      new ethers.Contract(address, ERC20_MIN, readProvider).decimals(),
    ]);
    const fthgIs0 = token0.toLowerCase() === CONTRACT_ADDRESS.toLowerCase();
    const fthgReserve = fthgIs0 ? reserves[0] : reserves[1];
    const quoteReserve = fthgIs0 ? reserves[1] : reserves[0];
    return { symbol, pairAddress, liquidity: fthgReserve > 0n && quoteReserve > 0n, fthgReserve, quoteReserve, tokenDecimals };
  }));
  const active = checks.filter((check) => check.liquidity);
  return {
    state: active.length ? "good" : "missing",
    detail: active.length
      ? active.map((check) => `${check.symbol} pair ${check.pairAddress} (${fmt(check.fthgReserve)} FTHG / ${ethers.formatUnits(check.quoteReserve, check.tokenDecimals)} ${check.symbol})`).join("; ")
      : "No funded Uniswap V2 FTHG/WETH, FTHG/USDC, or FTHG/USDT pool found. An empty pair is not treated as a live market.",
    url: `https://app.uniswap.org/explore/tokens/ethereum/${CONTRACT_ADDRESS}`,
  };
}
async function checkContractListingMetadata() {
  await buildReady;
  if (!build) throw new Error("The contract ABI is not available.");
  const readToken = new ethers.Contract(CONTRACT_ADDRESS, build.abi, readProvider);
  const [code, name, symbol, decimals, supply, metadataURI] = await Promise.all([
    readProvider.getCode(CONTRACT_ADDRESS),
    readToken.name(), readToken.symbol(), readToken.decimals(), readToken.totalSupply(), readToken.metadataURI(),
  ]);
  const valid = code !== "0x" && name === "Featheral Gold" && symbol === "FTHG" && Number(decimals) === 18
    && supply.toString() === build.totalSupply;
  return {
    state: valid ? (metadataURI ? "good" : "warning") : "warning",
    detail: `${code === "0x" ? "No runtime bytecode found. " : "Deployed code found. "}${name} (${symbol}), ${decimals} decimals; total supply ${fmt(supply)} FTHG. ${metadataURI ? `On-chain metadata URI: ${metadataURI}` : "No on-chain metadata URI is set."}`,
    metadataURI,
  };
}
function listingCheckCard(title, result) {
  const badge = result.state === "good" ? "Available" :
    result.state === "missing" ? "No record found" :
      result.state === "warning" ? "Needs attention" :
        result.state === "unknown" ? "Not publicly checkable" : "Check failed";
  const card = el("article", { className: `listing-check listing-${result.state}` },
    el("div", { className: "listing-check-title" }, el("b", { textContent: title }), el("span", { textContent: badge })),
    el("p", { textContent: result.detail }));
  if (result.url) card.append(el("a", { href: result.url, target: "_blank", rel: "noopener noreferrer", textContent: "Open result" }));
  return card;
}
function renderListingStatus() {
  const checks = [
    ["CoinGecko", listingStatusSnapshot.coingecko],
    ["DEX Screener", listingStatusSnapshot.dexscreener],
    ["GeckoTerminal", listingStatusSnapshot.geckoterminal],
    ["Uniswap V2 pools", listingStatusSnapshot.uniswap],
    ["Blockscout token index", listingStatusSnapshot.blockscout],
    ["Sourcify source verification", listingStatusSnapshot.sourcify],
    ["Contract metadata", listingStatusSnapshot.contract],
    ["CoinMarketCap", { state: "unknown", detail: "CoinMarketCap does not provide a public contract-address endpoint for checking listing or application status." }],
    ["Etherscan source verification", { state: "unknown", detail: "Verification status is not exposed by the public Ethereum RPC used here. Open the contract page to inspect its Code tab." }],
  ].filter(([, result]) => result);
  for (const id of ["dashboardListingStatus", "listingChecks"]) {
    $(id).replaceChildren(...checks.map(([title, result]) => listingCheckCard(title, result)));
  }
  const checkedAt = listingStatusSnapshot.checkedAt
    ? `Last checked ${listingStatusSnapshot.checkedAt.toLocaleString()}. Checks can fail temporarily due to API rate limits or network restrictions.`
    : "Checking public listing sources…";
  $("listingCheckedAt").textContent = checkedAt;
  $("listingCheckedAtFull").textContent = checkedAt;
  const poolChecks = checks.filter(([title]) => ["DEX Screener", "GeckoTerminal", "Uniswap V2 pools"].includes(title));
  $("dexPoolStatus").replaceChildren(...poolChecks.map(([title, result]) => listingCheckCard(title, result)));
  renderListingDossier();
  renderListingRecommendations();
}
function renderListingRecommendations() {
  const recs = [];
  const status = listingStatusSnapshot;
  if (status.dexscreener?.state === "missing") recs.push(["High priority", "Create a real FTHG trading pool against a widely used quote asset and seed meaningful, sustainable liquidity. Then confirm swaps and pool visibility; the current DEX Screener lookup has no indexed pair."]);
  if (status.dexscreener?.state === "good") recs.push(["Review liquidity", "A pair is indexed. Review its liquidity and recent volume; listing teams commonly expect reliable market data and sustained trading, not just a newly created pool."]);
  if (status.uniswap?.state === "missing") recs.push(["DEX prerequisite", "No funded Uniswap V2 pool was found for WETH, USDC, or USDT. Review the DEX preparation checklist before creating any pair; token approvals and liquidity transactions spend on-chain assets and require deliberate wallet confirmation."]);
  if (status.coingecko?.state === "missing") recs.push(["High priority", "CoinGecko has no contract record. After a public market is live and supporting exchange/pool requirements are met, prepare a request with contract, markets, tokenomics, project description, logo, website, and official community links."]);
  if (status.contract?.metadataURI === "") recs.push(["High priority", "Publish a persistent token metadata JSON (name, symbol, description, logo, website, and social links) and set the contract metadata URI."]);
  if (status.blockscout?.state === "good" && !status.blockscout.icon) recs.push(["Visibility quality", "Blockscout currently has no token icon. Publish a logo through the official explorer token-info process and durable metadata so wallets and indexers can display consistent branding."]);
  if (status.blockscout?.holders === 1) recs.push(["Distribution disclosure", "Blockscout currently indexes one holder for the full token supply. Before any tracker/CEX application, publish transparent holder, treasury, ownership, and circulating-supply disclosures; explain the distribution plan accurately."]);
  if (status.sourcify?.state === "missing") recs.push(["Source transparency", "Sourcify has no verification record for this contract. Verify the exact deployed source and compiler configuration with Sourcify and the explorer; do not describe the contract as audited unless a real independent audit exists."]);
  const s = settings();
  const missingLinks = [["docs", "project documentation / whitepaper"], ["tg", "Telegram"], ["x", "X"], ["dc", "Discord"], ["mail", "contact email"]]
    .filter(([key]) => !String(s[key] || "").trim()).map(([, label]) => label);
  if (missingLinks.length) recs.push(["Complete project profile", `Add public ${missingLinks.join(", ")} in Settings. Listing reviewers need consistent, verifiable project information and working contact links.`]);
  recs.push(["Verify before applying", "Check the Etherscan Code tab for verified source and publish clear circulating-supply, treasury, ownership, and liquidity disclosures. This page cannot verify explorer source status through public RPC."]);
  recs.push(["CoinMarketCap status", "No public lookup is available to determine whether an application is pending or approved. Use its official request link; this dashboard will not invent or store a manual submission status."]);
  $("listingRecommendations").replaceChildren(...recs.map(([priority, text]) =>
    el("div", { className: "listing-recommendation" }, el("b", { textContent: priority }), el("p", { textContent: text }))));
}
async function refreshListingStatus() {
  const requestId = ++listingStatusRequestId;
  listingStatusSnapshot = {};
  renderListingStatus();
  const results = await Promise.allSettled([
    checkCoinGeckoListing(), checkDexScreenerListing(), checkGeckoTerminalListing(),
    checkUniswapPools(), checkBlockscoutListing(), checkSourcifyVerification(), checkContractListingMetadata(),
  ]);
  if (requestId !== listingStatusRequestId) return;
  const keys = ["coingecko", "dexscreener", "geckoterminal", "uniswap", "blockscout", "sourcify", "contract"];
  results.forEach((result, index) => {
    listingStatusSnapshot[keys[index]] = result.status === "fulfilled"
      ? result.value
      : { state: "error", detail: result.reason?.name === "AbortError" ? "Request timed out after 12 seconds." : errText(result.reason) };
  });
  listingStatusSnapshot.checkedAt = new Date();
  $("dexCheckedAt").textContent = `Last checked ${listingStatusSnapshot.checkedAt.toLocaleString()}. Public data may be delayed or rate-limited.`;
  renderListingStatus();
}
function renderDashboardListingLinks() {
  const sortBy = $("platformSort").value;
  const rate = Number($("platformLaborRate").value);
  const entries = PLATFORM_LINKS.slice().sort((a, b) => {
    const ea = platformEstimate(a[0]), eb = platformEstimate(b[0]);
    if (sortBy === "name") return a[0].localeCompare(b[0]);
    const laborA = ea.hours[0] * rate, laborB = eb.hours[0] * rate;
    if (sortBy === "cheapest" && laborA !== laborB) return laborA - laborB;
    if (sortBy === "cheapest" && ea.hours[1] !== eb.hours[1]) return ea.hours[1] - eb.hours[1];
    if (sortBy !== "cheapest" && ea.hours[0] !== eb.hours[0]) return ea.hours[0] - eb.hours[0];
    if (sortBy !== "cheapest" && ea.hours[1] !== eb.hours[1]) return ea.hours[1] - eb.hours[1];
    if (laborA !== laborB) return laborA - laborB;
    return a[0].localeCompare(b[0]);
  });
  const cards = entries.map(([name, type, url]) => platformLinkCard(name, type, url, rate));
  $("dashboardListingLinks").replaceChildren(el("div", { className: "listing-link-grid platform-estimate-grid" }, ...cards));
  $("listingPlatformLinks").replaceChildren(...entries.map(([name, type, url]) => platformLinkCard(name, type, url, rate)));
  $("dexServiceLinks").replaceChildren(...DEX_LINKS.slice(0, 5).map(([name, type, url]) =>
    platformLinkCard(name, type, url, rate)));
}
function platformEstimate(name) {
  const canonical = name.replace(/ CEX application$/, "");
  return PLATFORM_WORK_ESTIMATES[canonical] || { hours: [1, 4], fee: "Costs not verified; confirm with the service" };
}
function platformLinkCard(name, type, url, laborRate) {
  const estimate = platformEstimate(name);
  const laborMin = estimate.hours[0] * laborRate;
  const laborMax = estimate.hours[1] * laborRate;
  const formatHours = (hours) => hours < 1 ? `${Math.round(hours * 60)} min` : `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
  const labor = laborRate === 0
    ? "Set hourly rate to calculate labor cost"
    : `$${laborMin.toLocaleString("en-US", { maximumFractionDigits: 0 })}–$${laborMax.toLocaleString("en-US", { maximumFractionDigits: 0 })} labor`;
  return el("a", {
    className: "listing-link platform-estimate-card",
    href: url,
    target: "_blank",
    rel: "noopener noreferrer",
  },
  el("b", { textContent: name }),
  el("small", { textContent: type }),
  el("span", { className: "platform-estimate-value", textContent: `Prep: ${formatHours(estimate.hours[0])}–${formatHours(estimate.hours[1])} · ${labor}` }),
  el("small", { textContent: `Direct cost: ${estimate.fee}` }));
}
function loadPlatformEstimateSettings() {
  const saved = store.get("platformEstimateSettings", {});
  $("platformLaborRate").value = String(Number.isFinite(Number(saved.laborRate)) ? Number(saved.laborRate) : 50);
  $("platformSort").value = ["fastest", "cheapest", "name"].includes(saved.sortBy) ? saved.sortBy : "fastest";
}
function savePlatformEstimateSettings() {
  const laborRate = Number($("platformLaborRate").value);
  if (!Number.isFinite(laborRate) || laborRate < 0 || laborRate > 10000) {
    alert("Enter an hourly labor rate between $0 and $10,000.");
    return;
  }
  store.set("platformEstimateSettings", { laborRate, sortBy: $("platformSort").value });
  renderDashboardListingLinks();
  log(`Applied platform estimates at $${laborRate.toFixed(2)}/hour; sorted by ${$("platformSort").selectedOptions[0].textContent}.`);
}
const PROFILE_SETTING_KEYS = {
  docs: "docs",
  contact: "mail",
  telegram: "tg",
  x: "x",
  discord: "dc",
};
function tokenProfile() {
  const saved = store.get("tokenProfile", {});
  const s = settings();
  return {
    logo: saved.logo || PROJECT.logo,
    description: saved.description || PROJECT.desc,
    docs: saved.docs ?? s.docs ?? "",
    contact: saved.contact ?? s.mail ?? "",
    telegram: saved.telegram ?? s.tg ?? "",
    x: saved.x ?? s.x ?? "",
    discord: saved.discord ?? s.dc ?? "",
  };
}
function metadataDocument(profile = tokenProfile()) {
  return {
    name: "Featheral Gold",
    symbol: "FTHG",
    description: profile.description,
    image: profile.logo,
    external_url: PROJECT.site,
    links: {
      website: PROJECT.site,
      docs: profile.docs || undefined,
      contact: profile.contact || undefined,
      telegram: profile.telegram || undefined,
      x: profile.x || undefined,
      discord: profile.discord || undefined,
    },
  };
}
function tokenListEntry(profile = tokenProfile()) {
  return {
    chainId: CONTRACT_CHAIN_ID,
    address: CONTRACT_ADDRESS,
    name: "Featheral Gold",
    symbol: "FTHG",
    decimals: 18,
    logoURI: profile.logo,
    extensions: {
      description: profile.description,
      website: PROJECT.site,
      docs: profile.docs || undefined,
      contact: profile.contact || undefined,
      telegram: profile.telegram || undefined,
      x: profile.x || undefined,
      discord: profile.discord || undefined,
    },
  };
}
function metadataBundle(profile = tokenProfile()) {
  return {
    notice: "Prepared locally only. Hosting, on-chain publication, and third-party profile updates are separate actions.",
    generatedAt: new Date().toISOString(),
    tokenMetadata: metadataDocument(profile),
    uniswapTokenListEntry: tokenListEntry(profile),
  };
}
function renderMetadataPlatformLinks() {
  $("metadataPlatformLinks").replaceChildren(...METADATA_PLATFORM_LINKS.map(([name, url, detail]) =>
    el("a", { className: "listing-link", href: url, target: "_blank", rel: "noopener noreferrer" },
      el("b", { textContent: name }), el("small", { textContent: detail }),
    ),
  ));
}
function profileFromForm() {
  return {
    logo: $("profileLogo").value.trim(),
    description: $("profileDescription").value.trim(),
    docs: $("profileDocs").value.trim(),
    contact: $("profileContact").value.trim(),
    telegram: $("profileTelegram").value.trim(),
    x: $("profileX").value.trim(),
    discord: $("profileDiscord").value.trim(),
  };
}
function validateProfile(profile) {
  const urls = [["Logo URL", profile.logo], ["Documentation URL", profile.docs], ["Telegram URL", profile.telegram], ["X URL", profile.x], ["Discord URL", profile.discord]];
  for (const [label, value] of urls) {
    if (!value) continue;
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error(`${label} must be a valid HTTPS or IPFS URL.`); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "ipfs:") throw new Error(`${label} must use HTTPS or IPFS.`);
  }
  if (!profile.logo) throw new Error("Provide a public HTTPS or IPFS logo URL before saving the profile.");
  if (!profile.description) throw new Error("Provide a public description before saving the profile.");
  if (profile.contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.contact)) throw new Error("Enter a valid contact email address.");
}
function renderMetadataPreview(profile = profileFromForm()) {
  $("metadataJsonPreview").value = JSON.stringify(metadataDocument(profile), null, 2);
}
function renderProfileLogo(url = $("profileLogo").value.trim()) {
  const image = $("profileLogoPreview");
  if (!url) {
    image.hidden = true;
    $("profileLogoStatus").textContent = "For public listings, use a durable HTTPS or IPFS URL.";
    return;
  }
  let previewUrl = url;
  if (url.startsWith("ipfs://")) previewUrl = `https://ipfs.io/ipfs/${url.slice("ipfs://".length).replace(/^ipfs\//, "")}`;
  if (!/^https:\/\//i.test(previewUrl)) {
    image.hidden = true;
    $("profileLogoStatus").textContent = "The IPFS image preview may depend on gateway availability.";
    return;
  }
  image.onload = () => {
    image.hidden = false;
    $("profileLogoStatus").textContent = "Logo preview loaded. Confirm the URL is publicly accessible and stable.";
  };
  image.onerror = () => {
    image.hidden = true;
    $("profileLogoStatus").textContent = "Could not load preview. Verify the public image URL.";
  };
  image.src = previewUrl;
}
function loadTokenProfile() {
  const profile = tokenProfile();
  $("profileWebsite").value = PROJECT.site;
  $("profileLogo").value = profile.logo;
  $("profileDescription").value = profile.description;
  $("profileDocs").value = profile.docs;
  $("profileContact").value = profile.contact;
  $("profileTelegram").value = profile.telegram;
  $("profileX").value = profile.x;
  $("profileDiscord").value = profile.discord;
  renderMetadataPreview(profile);
  renderProfileLogo(profile.logo);
}
function saveTokenProfile() {
  try {
    const profile = profileFromForm();
    validateProfile(profile);
    store.set("tokenProfile", profile);
    const s = settings();
    for (const [field, key] of Object.entries(PROFILE_SETTING_KEYS)) s[key] = profile[field];
    store.set("settings", s);
    for (const [id, key] of Object.entries(SFIELDS)) $(id).value = s[key];
    $("metadataProfileStatus").textContent = "Profile saved in this browser. Download the bundle and publish the logo/JSON at a durable public URL before submitting external updates.";
    renderMetadataPreview(profile);
    renderListingDossier();
    renderListingRecommendations();
    log("Saved canonical token profile locally.");
  } catch (error) {
    $("metadataProfileStatus").textContent = error.message;
    alert(error.message);
  }
}
function listingDossier() {
  const profile = tokenProfile();
  return {
    project: {
      name: "Featheral Gold",
      symbol: "FTHG",
      network: "Ethereum Mainnet",
      chainId: CONTRACT_CHAIN_ID,
      contractAddress: CONTRACT_ADDRESS,
      decimals: 18,
      totalSupply: "216265000",
      supplyModel: "Fixed supply; verify circulating supply independently from holders and treasury.",
      website: PROJECT.site,
      description: profile.description || PROJECT.desc,
      logo: profile.logo || PROJECT.logo,
      docs: profile.docs || "NOT PROVIDED — add a public docs/whitepaper URL in Token profile or Settings.",
      telegram: profile.telegram || "NOT PROVIDED — add official URL in Token profile or Settings.",
      x: profile.x || "NOT PROVIDED — add official URL in Token profile or Settings.",
      discord: profile.discord || "NOT PROVIDED — add official URL in Token profile or Settings.",
      contactEmail: profile.contact || "NOT PROVIDED — add a monitored project contact in Token profile or Settings.",
      legalEntity: "NOT PROVIDED — supply legal issuer/entity and jurisdiction details after counsel review.",
      publicTeamProfiles: "NOT PROVIDED — add verifiable team/organization information if appropriate.",
      independentSecurityAudit: "NOT PROVIDED — provide the audit report or explicitly state no independent audit is available.",
      tokenMetadataURI: listingStatusSnapshot.contract?.metadataURI || "NOT SET — publish durable token metadata and set it on-chain.",
      circulatingSupply: "NOT CALCULATED — provide a documented methodology; total supply is not the same as circulating supply.",
      indexedHolders: listingStatusSnapshot.blockscout?.holders ?? "NOT REPORTED by Blockscout.",
      indexedMarketRate: listingStatusSnapshot.blockscout?.exchangeRate ?? "NOT REPORTED by Blockscout.",
      exchangeUtility: "The separate funded bridge exchanges FTHG to off-chain FTH$ after confirmed event indexing. Legacy token exchange events are not settled by the current ledger.",
      markets: listingStatusSnapshot.dexscreener?.state === "good" ? listingStatusSnapshot.dexscreener.detail : "No DEX Screener pair currently confirmed by the live check.",
      officialSources: {
        explorer: TOKEN_URL,
        blockscout: `https://eth.blockscout.com/token/${CONTRACT_ADDRESS}`,
        sourcify: `https://sourcify.dev/#/lookup/${CONTRACT_ADDRESS}`,
        uniswap: `https://app.uniswap.org/explore/tokens/ethereum/${CONTRACT_ADDRESS}`,
        dexScreener: `https://dexscreener.com/ethereum/${CONTRACT_ADDRESS}`,
        geckoTerminal: `https://www.geckoterminal.com/eth/tokens/${CONTRACT_ADDRESS}`,
      },
      notes: "Review and substantiate all facts before submission. The admin's $0.01/FTHG reference estimate is not a market price and is intentionally excluded. Clarify whether the project/token has any legal claim or redemption for physical gold; do not imply gold backing without evidence.",
    },
  };
}
function renderListingDossier() {
  if ($("listingDossier")) $("listingDossier").value = JSON.stringify(listingDossier(), null, 2);
}
function listingTaskState() {
  return store.get("listingTaskState", {});
}
function renderListingTasks() {
  const saved = listingTaskState();
  const renderTask = (task) => {
    const check = el("input", { type: "checkbox", checked: saved[task.id] === true });
    check.onchange = () => {
      const current = listingTaskState();
      current[task.id] = check.checked;
      store.set("listingTaskState", current);
      check.closest(".listing-task").classList.toggle("task-done", check.checked);
    };
    const links = task.links.map(([label, url]) => {
      if (url.startsWith("#")) {
        const targetId = url.slice(1);
        return el("button", { textContent: label, onclick: () => {
          const tab = document.querySelector(`#tabs [data-tab="${targetId}"]`);
          if (tab) tab.click();
          else {
            const target = $(targetId);
            target?.scrollIntoView({ behavior: "smooth", block: "center" });
            target?.focus({ preventScroll: true });
          }
        } });
      }
      return el("a", { href: url, target: "_blank", rel: "noopener noreferrer", textContent: label });
    });
    const copy = el("button", { textContent: "Copy task brief", onclick: () => copyText(`${task.title}\n\n${task.details}\n\nProject dossier:\n${$("listingDossier").value}`) });
    return el("article", { className: `listing-task${saved[task.id] ? " task-done" : ""}` },
      el("label", { className: "listing-task-check" }, check, el("b", { textContent: task.title })),
      el("p", { textContent: task.details }),
      el("div", { className: "row listing-task-actions" }, ...links, copy));
  };
  $("dexListingTasks").replaceChildren(...LISTING_TASKS.filter((task) => task.group === "dex").map(renderTask));
  $("cexListingTasks").replaceChildren(...LISTING_TASKS.filter((task) => task.group === "cex").map(renderTask));
}
function exportListingPreparation() {
  const saved = listingTaskState();
  const data = {
    contractAddress: CONTRACT_ADDRESS,
    network: NETWORKS[CONTRACT_CHAIN_ID].name,
    exportedAt: new Date().toISOString(),
    notice: "Local preparation checklist only; completion does not indicate an external application or listing status.",
    tasks: LISTING_TASKS.map((task) => ({
      id: task.id,
      group: task.group,
      title: task.title,
      completedLocally: saved[task.id] === true,
      links: task.links.filter(([, url]) => !url.startsWith("#")),
    })),
  };
  download("fthg-listing-preparation.json", JSON.stringify(data, null, 2), "application/json");
  log("Exported local listing preparation checklist.");
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    log("Copied text to clipboard.");
  } catch (error) {
    log("Clipboard copy failed: " + errText(error));
    alert("Could not copy to clipboard. Check browser clipboard permissions and try again.");
  }
}
/* Settings */
const SFIELDS = { sDocs: "docs", sTg: "tg", sX: "x", sDc: "dc", sMail: "mail" };
let build = null;
async function loadBuild() {
  try {
    const r = await fetch("/shared/abi/FeatheralGold.json", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    build = await r.json();
    buildErrIface();
    $("sBuild").value = `${build.contractName} management ABI\nsolc ${build.compiler.version}, optimizer ${build.compiler.optimizer.runs} runs, evm ${build.compiler.evmVersion}, OpenZeppelin ${build.openzeppelin}\n${build.abi.length} ABI entries\nsource sha256 ${build.sourceSha256}`;
  } catch (e) {
    $("sBuild").value = "Management ABI not found. Run `npm start` to generate it. " + e.message;
  }
}
const buildReady = loadBuild().then(() => {
  bindToken();
  refresh();
});
function loadSettings() {
  const s = settings();
  for (const [id, k] of Object.entries(SFIELDS)) if (s[k] !== undefined) $(id).value = s[k];
  $("sSite").value = PROJECT.site; $("sLogo").value = PROJECT.logo; $("sDesc").value = PROJECT.desc;
}
$("saveS").onclick = () => {
  const s = settings();
  for (const [id, k] of Object.entries(SFIELDS)) s[k] = $(id).value.trim();
  store.set("settings", s);
  const profile = tokenProfile();
  for (const [field, key] of Object.entries(PROFILE_SETTING_KEYS)) profile[field] = s[key];
  store.set("tokenProfile", profile);
  bindToken(); refresh(); loadTokenProfile(); renderListingDossier(); renderListingRecommendations(); log("Settings saved");
};

function download(name, text, type) {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name }); a.click(); URL.revokeObjectURL(a.href);
}

/* Init */
const adminTabs = window.AdminKit.tabs((id) => {
  if (id === "analytics" && !analyticsInitialized) refreshAnalytics();
  if (id === "ledger") refreshTokenApiStats();
}, (id) => walletIsAdmin || !document.querySelector(`#tabs button[data-tab="${id}"]`)?.classList.contains("admin-only"));
function showTab(id) { adminTabs.select(id); }
window.FeatheralProfile.mount($("connect"), {
  walletUrl: window.FeatheralSites.url("dollar", "/wallet/"),
  onConnect: () => connect(),
  onDisconnect: () => {
    signer = null;
    account = null;
    walletIsAdmin = false;
    walletHasAdminRole = false;
    ++refreshGeneration;
    updateAdminAccess();
    renderWalletButton();
    bindToken();
    log("Wallet disconnected from this admin session.");
    refresh();
  },
});
document.querySelectorAll("[data-tab]:not(#tabs button)").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
{
  let walletGeneration = 0;
  const syncWalletState = async () => {
    const generation = ++walletGeneration;
    try {
      await buildReady;
      const walletProvider = window.FeatheralProfile.getProvider();
      if (!walletProvider) return;
      const nextProvider = new ethers.BrowserProvider(walletProvider);
      const nextChainId = Number((await nextProvider.getNetwork()).chainId);
      const currentAccount = window.FeatheralProfile.snapshot().account;
      const nextSigner = currentAccount && !window.FeatheralProfile.isDisconnected() ? await nextProvider.getSigner(currentAccount) : null;
      const nextAccount = nextSigner ? await nextSigner.getAddress() : null;
      if (generation !== walletGeneration || walletProvider !== window.FeatheralProfile.getProvider() || currentAccount !== window.FeatheralProfile.snapshot().account) return;
      provider = nextProvider;
      chainId = nextChainId;
      signer = nextSigner;
      account = nextAccount;
      renderWalletButton();
      if (account && chainId !== CONTRACT_CHAIN_ID) log("Wallet left Ethereum Mainnet; admin actions are disabled until you switch back (click the wallet icon).");
      bindToken();
      await refresh();
    } catch (error) {
      log("Wallet state update failed: " + errText(error));
    }
  };
  window.addEventListener("featheral:wallet", () => {
    const currentAccount = window.FeatheralProfile.snapshot().account;
    if (!currentAccount || currentAccount.toLowerCase() !== account?.toLowerCase()) {
      ++refreshGeneration;
      walletHasAdminRole = false;
      walletIsAdmin = isFixedAdminWallet(currentAccount);
      updateAdminAccess();
    }
    syncWalletState();
  });
}
loadSettings();
loadTokenProfile();
bindToken();
loadPlatformEstimateSettings();
renderDashboardListingLinks();
renderListingStatus();
renderListingTasks();
renderListingDossier();
refresh();
refreshListingStatus();
document.querySelectorAll("[data-refresh-listings]").forEach((button) => {
  button.onclick = () => refreshListingStatus();
});
if ($("refreshListingStatus")) $("refreshListingStatus").onclick = () => refreshListingStatus();
if ($("refreshDexStatus")) $("refreshDexStatus").onclick = () => refreshListingStatus();
if ($("copyDossier")) $("copyDossier").onclick = () => copyText($("listingDossier").value);
if ($("downloadDossier")) $("downloadDossier").onclick = () =>
  download("fthg-listing-dossier.json", JSON.stringify(listingDossier(), null, 2), "application/json");
if ($("exportListingPrep")) $("exportListingPrep").onclick = exportListingPreparation;
if ($("savePlatformEstimateSettings")) $("savePlatformEstimateSettings").onclick = savePlatformEstimateSettings;
if ($("refreshPublicStats")) $("refreshPublicStats").onclick = () => refresh();
if ($("refreshLedgerDashboard")) $("refreshLedgerDashboard").onclick = refreshTokenApiStats;
if ($("refreshLedger")) $("refreshLedger").onclick = refreshTokenApiStats;
renderMetadataPlatformLinks();
const profileInputs = ["profileLogo", "profileDescription", "profileDocs", "profileContact", "profileTelegram", "profileX", "profileDiscord"];
for (const id of profileInputs) {
  $(id).addEventListener("input", () => {
    renderMetadataPreview();
    $("metadataProfileStatus").textContent = "Unsaved profile edits.";
    if (id === "profileLogo") renderProfileLogo();
  });
}
$("profileLogoFile").addEventListener("change", () => {
  const file = $("profileLogoFile").files?.[0];
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp", "image/svg+xml"].includes(file.type) || file.size > 5 * 1024 * 1024) {
    $("profileLogoStatus").textContent = "Choose a PNG, JPEG, WebP, or SVG image smaller than 5 MB.";
    $("profileLogoFile").value = "";
    return;
  }
  const localPreview = URL.createObjectURL(file);
  $("profileLogoPreview").onload = () => {
    $("profileLogoPreview").hidden = false;
    $("profileLogoStatus").textContent = `${file.name} is previewed locally only. Host it at a durable public HTTPS/IPFS URL before listing updates.`;
    URL.revokeObjectURL(localPreview);
  };
  $("profileLogoPreview").onerror = () => {
    $("profileLogoPreview").hidden = true;
    $("profileLogoStatus").textContent = "Could not preview this local image file.";
    URL.revokeObjectURL(localPreview);
  };
  $("profileLogoPreview").src = localPreview;
});
$("saveTokenProfile").onclick = saveTokenProfile;
$("copyTokenDescription").onclick = () => copyText($("profileDescription").value.trim());
$("copyMetadataJson").onclick = () => {
  try {
    const profile = profileFromForm();
    validateProfile(profile);
    copyText(JSON.stringify(metadataDocument(profile), null, 2));
  } catch (error) {
    alert(error.message);
  }
};
$("downloadMetadataJson").onclick = () => {
  try {
    const profile = profileFromForm();
    validateProfile(profile);
    download("fthg-token-metadata.json", JSON.stringify(metadataDocument(profile), null, 2), "application/json");
    $("metadataProfileStatus").textContent = "Downloaded token metadata JSON. Host this document at a durable public URL before setting its URI on-chain.";
  } catch (error) {
    alert(error.message);
  }
};
$("downloadMetadataBundle").onclick = () => {
  try {
    const profile = profileFromForm();
    validateProfile(profile);
    download("fthg-metadata-and-token-list.json", JSON.stringify(metadataBundle(profile), null, 2), "application/json");
    $("metadataProfileStatus").textContent = "Downloaded metadata bundle. Publish the metadata document and logo at a durable public URL before using it on-chain or with third parties.";
  } catch (error) {
    alert(error.message);
  }
};
$("refreshAnalytics").onclick = refreshAnalytics;
$("loadMoreHolders").onclick = () => loadAnalyticsPage("holders");
$("loadMoreTransfers").onclick = () => loadAnalyticsPage("transfers");
$("holderFilter").addEventListener("input", renderHolderRows);
$("transferFilter").addEventListener("input", renderTransferRows);
$("exportHolders").onclick = () => exportAnalyticsCsv("holders");
$("exportTransfers").onclick = () => exportAnalyticsCsv("transfers");
$("loadMoreHolders").disabled = true;
$("loadMoreTransfers").disabled = true;
const analyticsLinks = [
  ["Etherscan token overview", TOKEN_URL],
  ["Etherscan holder list", `${TOKEN_URL}#balances`],
  ["Etherscan transfer history", `${TOKEN_URL}#tokenTrade`],
  ["Blockscout token overview", `${BLOCKSCOUT_URL}/token/${CONTRACT_ADDRESS}`],
  ["Blockscout holder index", `${BLOCKSCOUT_URL}/token/${CONTRACT_ADDRESS}/holders`],
  ["Blockscout transfer index", `${BLOCKSCOUT_URL}/token/${CONTRACT_ADDRESS}/transfers`],
];
$("analyticsExplorerLinks").replaceChildren(...analyticsLinks.map(([label, url]) =>
  el("a", { className: "listing-link", href: url, target: "_blank", rel: "noopener noreferrer", textContent: label }),
));
