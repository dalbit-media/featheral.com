"use strict";

// Shared helpers for the Featheral Dollar (FTH$) landing page, wallet and explorer.
(() => {
  const ONE = 10n ** 18n;
  const USD_PER_FTHG_ESTIMATE = 0.01;
  const OPENING_FTH_DOLLAR_PER_FTHG = 1000;
  const state = { rate: OPENING_FTH_DOLLAR_PER_FTHG, rateLive: false, bridge: null };

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
    return node;
  }

  async function api(path, init) {
    const response = await fetch(`/api/v1${path}`, { cache: "no-store", headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) }, ...init });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status });
    return body;
  }

  const toNumber = (raw) => Number(BigInt(raw || 0) / 10n ** 12n) / 1e6;
  function amount(raw, digits = 2) {
    const value = BigInt(raw || 0);
    const negative = value < 0n;
    const abs = negative ? -value : value;
    const whole = abs / ONE;
    const text = (Number(whole) + Number(abs % ONE) / 1e18).toLocaleString("en-US", { maximumFractionDigits: digits });
    return negative ? `−${text}` : text;
  }
  const fth = (raw, digits = 2) => `${amount(raw, digits)} FTH$`;
  const money = (value) => value.toLocaleString("en-US", { style: "currency", currency: "USD", ...(value > 0 && value < 0.01 ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: 2 }) });
  const usd = (raw) => money((toNumber(raw) * USD_PER_FTHG_ESTIMATE) / state.rate);
  const count = (value) => Number(value || 0).toLocaleString("en-US");

  // Parses a decimal FTH$ string into 18-decimal base units; returns null when invalid.
  function parseAmount(text) {
    const value = String(text || "").trim().replace(/,/g, "");
    if (!/^\d+(\.\d{0,18})?$/.test(value)) return null;
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole) * ONE + BigInt(fraction.padEnd(18, "0") || "0");
  }

  const ADDRESS_ACCOUNT_PREFIX = "0x000000000000000000000000";
  const accountIdFor = (address) => `${ADDRESS_ACCOUNT_PREFIX}${address.toLowerCase().replace(/^0x/, "")}`;
  const short = (value, head = 6, tail = 4) => (value && value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value || "");
  const isAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(String(value || "").trim());
  const isAccountId = (value) => /^0x[0-9a-fA-F]{64}$/.test(String(value || "").trim());

  function timeAgo(iso) {
    if (!iso) return "—";
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  const explorerUrl = (route) => `/explorer/#/${route}`;
  const KIND_LABELS = { TRANSFER: "Transfer", CREDIT: "Bridge credit", RESERVE: "Withdrawal reserved", SETTLE: "Withdrawn to FTHG", RELEASE: "Withdrawal released", PROFILE: "Profile", GENESIS: "Genesis" };
  const kindBadge = (kind) => el("span", { className: `kind ${kind}`, textContent: KIND_LABELS[kind] || kind, title: kind });
  function accountLink(accountId, wallet, label) {
    if (!accountId) return el("span", { className: "muted", textContent: "—" });
    const target = wallet || accountId;
    return el("a", { className: "hash", href: explorerUrl(`account/${target}`), textContent: label || short(target), title: target });
  }
  const txLink = (hash) => el("a", { className: "hash", href: explorerUrl(`tx/${hash}`), textContent: short(hash, 10, 6), title: hash });
  const blockLink = (height) => (height === null || height === undefined
    ? el("span", { className: "kind RESERVE", textContent: "pending" })
    : el("a", { href: explorerUrl(`block/${height}`), textContent: `#${count(height)}` }));
  const ethTxLink = (hash) => el("a", { className: "hash", href: `https://etherscan.io/tx/${hash}`, target: "_blank", rel: "noopener noreferrer", textContent: `${short(hash, 10, 6)} ↗`, title: "Ethereum Mainnet transaction" });

  function stat(label, value, note) {
    return el("div", { className: "stat" }, el("span", { textContent: label }), el("b", { textContent: value }), note ? el("small", { textContent: note }) : null);
  }
  const emptyRow = (columns, text) => el("tr", {}, el("td", { colSpan: columns, className: "muted empty", textContent: text }));

  // Signed amount from an account's point of view (+ received, − sent).
  function signedAmount(tx, accountId) {
    const id = String(accountId || "").toLowerCase();
    if (tx.kind === "PROFILE" || tx.kind === "GENESIS") return null;
    if (tx.kind === "RESERVE") return { text: `${fth(tx.amount)} held`, className: "muted" };
    if (id && tx.from === id && tx.kind !== "RELEASE") return { text: `−${fth(tx.amount)}`, className: "neg" };
    if (id && tx.to === id) return { text: `+${fth(tx.amount)}`, className: "pos" };
    return { text: fth(tx.amount), className: "" };
  }

  // Live bridge spot rate (18-decimal FTH$ per FTHG) once the pool is funded; opening rate otherwise.
  async function loadRate() {
    try {
      const stats = await api("/stats");
      const bridge = stats.bridge || {};
      state.bridge = bridge;
      const live = bridge.deployed && bridge.initialized && bridge.reserveFthg !== "0" && bridge.reserveFthDollar !== "0" && bridge.spotRateFthDollarPerFthg;
      if (live) {
        state.rate = toNumber(bridge.spotRateFthDollarPerFthg);
        state.rateLive = true;
      }
      window.FeatheralProfile?.setRate(state.rate);
      return stats;
    } catch {
      return null;
    }
  }

  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      if (button) {
        const previous = button.textContent;
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = previous; }, 1200);
      }
    } catch { /* clipboard unavailable */ }
  }

  window.FTH = {
    ONE, USD_PER_FTHG_ESTIMATE, OPENING_FTH_DOLLAR_PER_FTHG, state,
    el, api, amount, fth, usd, money, count, toNumber,     parseAmount, accountIdFor, short, isAddress, isAccountId, timeAgo, explorerUrl,
    KIND_LABELS, kindBadge, accountLink, txLink, blockLink, ethTxLink, stat, emptyRow, signedAmount, loadRate, copy,
  };
})();
