"use strict";

(() => {
  const form = document.getElementById("notesFilterForm");
  const currencySelect = document.getElementById("notesCurrency");
  const addressInput = document.getElementById("notesAddress");
  const status = document.getElementById("notesStatus");
  const entriesRoot = document.getElementById("notesEntries");
  const pager = document.getElementById("notesPager");
  const params = new URLSearchParams(location.search);
  let currencies = [];
  let cursor = null;
  let requestId = 0;

  const el = (tag, properties = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), properties);
    node.append(...children.filter(child => child !== null && child !== undefined));
    return node;
  };
  async function api(url) {
    const response = await fetch(url, { cache: "no-store", headers: { accept: "application/json" } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }
  function selectedCurrency() {
    return currencySelect.value;
  }
  function updateUrl() {
    const query = new URLSearchParams({ currency: selectedCurrency() });
    if (addressInput.value) query.set("address", addressInput.value.trim());
    history.replaceState(null, "", `${location.pathname}?${query}`);
  }
  function short(value) {
    return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
  }
  function amount(value) {
    const text = String(value);
    return Number(value) > 0 ? `+${text}` : text;
  }
  function timestamp(value) {
    const date = new Date(Number(value));
    return Number.isNaN(date.valueOf()) ? "Unknown" : date.toLocaleString();
  }
  function renderEntries(data) {
    const rows = data.entries.map(entry => el("tr", {},
      el("td", { textContent: String(entry.id) }),
      el("td", { className: "num", textContent: amount(entry.amount) }),
      el("td", { textContent: entry.kind }),
      el("td", {}, el("code", { textContent: short(entry.address), title: entry.address })),
      el("td", {}, entry.other ? el("code", { textContent: short(entry.other), title: entry.other }) : el("span", { className: "muted", textContent: "—" })),
      el("td", { textContent: entry.site }),
      el("td", { textContent: timestamp(entry.at) }),
    ));
    const table = el("div", { className: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {},
        ...["Entry", "Signed amount", "Type", "Account", "Counterparty", "Source", "Time"].map(label => el("th", { textContent: label })),
      )),
      el("tbody", {}, ...(rows.length ? rows : [el("tr", {}, el("td", {
        colSpan: 7, className: "muted", textContent: "No activity records found for this currency and filter.",
      }))])),
    ));
    entriesRoot.replaceChildren(table);
    pager.replaceChildren();
    if (cursor) pager.append(el("button", {
      type: "button", className: "btn small", textContent: "Newest entries",
      onclick: () => { cursor = null; loadEntries(); },
    }));
    pager.append(el("span", { className: "muted", textContent: `${rows.length} records shown${data.hasMore ? " · more available" : ""}` }));
    if (data.hasMore) pager.append(el("button", {
      type: "button", className: "btn small", textContent: "Older entries",
      onclick: () => { cursor = data.nextBefore; loadEntries(); },
    }));
    status.textContent = `${data.currency.name} (${data.currency.symbol}) · ${data.currency.kind}`;
  }
  async function loadEntries() {
    const currentRequest = ++requestId;
    const symbol = selectedCurrency();
    if (symbol === "FTH$") {
      location.assign("/explorer/");
      return;
    }
    updateUrl();
    const query = new URLSearchParams({ limit: "50" });
    if (cursor) query.set("before", String(cursor));
    const address = addressInput.value.trim();
    if (address) query.set("address", address);
    status.textContent = "Loading activity…";
    entriesRoot.replaceChildren();
    pager.replaceChildren();
    try {
      const data = await api(`/api/notes/ledger/${encodeURIComponent(symbol)}/entries?${query}`);
      if (currentRequest === requestId) renderEntries(data);
    } catch (error) {
      if (currentRequest !== requestId) return;
      status.textContent = `Unable to load activity: ${error.message}`;
    }
  }
  form.addEventListener("submit", event => {
    event.preventDefault();
    cursor = null;
    loadEntries();
  });
  api("/api/notes/ledger/currencies").then(data => {
    currencies = data.currencies;
    currencySelect.replaceChildren(el("option", {
      value: "FTH$",
      textContent: "FTH$ · Featheral Dollar block ledger",
    }), ...currencies.map(currency => el("option", {
      value: currency.symbol,
      textContent: `${currency.symbol} · ${currency.name}`,
    })));
    if (!currencies.length) {
      status.textContent = "No Notes currencies are available.";
      return;
    }
    const requested = params.get("currency");
    if (requested === "FTH$") {
      location.assign("/explorer/");
      return;
    }
    currencySelect.value = currencies.some(currency => currency.symbol === requested)
      ? requested
      : currencies.some(currency => currency.symbol === "FTHX") ? "FTHX" : currencies[0].symbol;
    addressInput.value = params.get("address") || "";
    if (addressInput.value && !/^0x[0-9a-fA-F]{40}$/.test(addressInput.value)) {
      status.textContent = "Invalid wallet address in URL. Enter a valid Ethereum wallet address.";
      return;
    }
    loadEntries();
  }).catch(error => {
    status.textContent = `Unable to load Notes currencies: ${error.message}`;
  });
})();
