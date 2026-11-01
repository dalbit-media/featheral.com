"use strict";

(() => {
  const API = "/api/v1/world";
  const $ = (id) => document.getElementById(id);
  const view = $("view");
  const SQL_EXAMPLES = [
    { title: "Latest posts", sql: "SELECT substr(id,1,12) AS id, author, text, datetime(time_ms/1000,'unixepoch') AS time FROM posts WHERE deleted=0 ORDER BY time_ms DESC LIMIT 25" },
    { title: "Most liked", sql: "SELECT p.id, p.author, p.text, count(l.post_id) AS likes FROM posts p JOIN likes l ON l.post_id=p.id GROUP BY p.id ORDER BY likes DESC LIMIT 25" },
    { title: "Top authors", sql: "SELECT author, count(*) AS posts FROM posts GROUP BY author ORDER BY posts DESC LIMIT 25" },
    { title: "Followers", sql: "SELECT followee, count(*) AS followers FROM follows GROUP BY followee ORDER BY followers DESC LIMIT 25" },
    { title: "Actions by kind", sql: "SELECT kind, count(*) AS n FROM transactions GROUP BY kind ORDER BY n DESC" },
    { title: "Blocks", sql: "SELECT height, hash, tx_count, time FROM blocks ORDER BY height DESC LIMIT 25" },
  ];

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
    return node;
  }
  async function api(path) {
    const response = await fetch(`${API}${path}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }
  const mono = (text) => el("code", { textContent: text, style: "word-break:break-all" });
  const table = (headers, rows) => el("div", { className: "table-wrap", style: "overflow:auto" }, el("table", {}, el("thead", {}, el("tr", {}, ...headers.map((h) => el("th", { textContent: h })))), el("tbody", {}, ...rows)));
  const when = (iso) => new Date(iso).toLocaleString();

  function txRows(list) {
    return list.map((tx) => el("tr", {},
      el("td", {}, el("a", { href: `#/tx/${tx.hash}`, textContent: `${tx.hash.slice(0, 14)}…` })),
      el("td", { textContent: tx.kind }),
      el("td", { textContent: tx.height === null ? "pending" : `#${tx.height}` }),
      el("td", {}, mono(String(tx.from || "").slice(0, 18))),
      el("td", { textContent: when(tx.time) })));
  }
  const txHeaders = ["Hash", "Action", "Block", "Account", "Time"];

  async function summary() {
    const { ledger, node } = await api("/stats");
    $("summaryStats").replaceChildren(...[["Height", `#${ledger.height}`], ["Actions", ledger.transactions], ["Posts", ledger.posts], ["Authors", ledger.authors], ["Node", node?.mode || "writer"]].map(([k, v]) => el("div", { className: "stat" }, el("small", { textContent: k }), el("b", { textContent: String(v) }))));
  }

  async function blocks() {
    const { blocks: list } = await api("/blocks?limit=30");
    view.replaceChildren(table(["Height", "Hash", "Actions", "Time", "File"], list.map((b) => el("tr", {},
      el("td", {}, el("a", { href: `#/block/${b.height}`, textContent: `#${b.height}` })), el("td", {}, mono(`${b.hash.slice(0, 18)}…`)), el("td", { textContent: String(b.transactions) }), el("td", { textContent: when(b.time) }), el("td", { textContent: b.file || "" })))));
  }
  async function transactions() {
    const { transactions: list } = await api("/transactions?limit=50");
    view.replaceChildren(list.length ? table(txHeaders, txRows(list)) : el("p", { className: "muted", textContent: "No actions yet." }));
  }
  async function block(height) {
    const data = await api(`/blocks/${height}`);
    view.replaceChildren(el("h2", { textContent: `Block #${height}` }), el("pre", { className: "sql-out", textContent: JSON.stringify(data, null, 2), style: "overflow:auto;max-height:70vh" }));
  }
  async function tx(hash) {
    const data = await api(`/tx/${hash}`);
    view.replaceChildren(el("h2", { textContent: "Action" }), el("p", {}, el("a", { href: `/#/post/${hash}`, textContent: "Open as post in the feed" })), el("pre", { className: "sql-out", textContent: JSON.stringify(data, null, 2), style: "overflow:auto;max-height:70vh" }));
  }
  async function files() {
    const data = await api("/files");
    view.replaceChildren(
      el("p", { className: "muted", textContent: `Layout ${data.layout}. Tip ${data.tipHash}` }),
      table(["File", "Blocks", "Bytes", "Download"], data.files.map((f) => el("tr", {}, el("td", { textContent: f.path || f.file || "" }), el("td", { textContent: f.blocks === undefined ? "" : String(f.blocks) }), el("td", { textContent: f.bytes === undefined ? "" : String(f.bytes) }), el("td", {}, el("a", { href: `${API}/files/${f.path || f.file}`, textContent: "jsonl" }))))),
    );
  }
  function sql() {
    view.replaceChildren();
    window.LedgerSql.mount(view, { base: API, examples: SQL_EXAMPLES, title: "World ledger SQL" });
  }

  async function route() {
    const [name, arg] = location.hash.replace(/^#\/?/, "").split("/");
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.route === (name || "blocks"))));
    try {
      if (name === "block") await block(Number(arg));
      else if (name === "tx") await tx(arg);
      else if (name === "transactions") await transactions();
      else if (name === "files") await files();
      else if (name === "sql") sql();
      else await blocks();
    } catch (error) {
      view.replaceChildren(el("p", { className: "muted", textContent: error.message }));
    }
  }

  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { location.hash = `#/${b.dataset.route}`; }));
  $("searchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const q = $("searchInput").value.trim();
    if (/^\d+$/.test(q)) location.hash = `#/block/${q}`;
    else if (/^0x[0-9a-fA-F]{64}$/.test(q)) location.hash = `#/tx/${q}`;
  });
  window.addEventListener("hashchange", route);
  FeatheralProfile.mount($("walletButton"), { primaryCurrency: "fthDollar", walletUrl: FeatheralSites.url("dollar", "/wallet/") });
  summary().catch(() => {});
  route();
})();
