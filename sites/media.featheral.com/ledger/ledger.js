"use strict";

(() => {
  const API = "/api/v1/media";
  const $ = (id) => document.getElementById(id);
  const view = $("view");
  const SQL_EXAMPLES = [
    { title: "Latest posts", sql: "SELECT substr(id,1,12) AS id, author, text, datetime(time_ms/1000,'unixepoch') AS time FROM posts WHERE deleted=0 ORDER BY time_ms DESC LIMIT 25" },
    { title: "Most liked", sql: "SELECT p.id, p.author, p.text, count(l.post_id) AS likes FROM posts p JOIN likes l ON l.post_id=p.id GROUP BY p.id ORDER BY likes DESC LIMIT 25" },
    { title: "Top authors", sql: "SELECT author, count(*) AS posts FROM posts GROUP BY author ORDER BY posts DESC LIMIT 25" },
    { title: "Followers", sql: "SELECT followee, count(*) AS followers FROM follows GROUP BY followee ORDER BY followers DESC LIMIT 25" },
    { title: "Actions by kind", sql: "SELECT kind, count(*) AS n FROM actions GROUP BY kind ORDER BY n DESC" },
    { title: "Latest writes", sql: "SELECT id, kind, author, time FROM actions ORDER BY time_ms DESC LIMIT 25" },
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

  async function summary() {
    const { database } = await api("/stats");
    $("summaryStats").replaceChildren(...[["Database", database.status], ["Storage", database.storage], ["Actions", database.actions], ["Posts", database.posts], ["Authors", database.authors]].map(([k, v]) => el("div", { className: "stat" }, el("small", { textContent: k }), el("b", { textContent: String(v) }))));
    return database;
  }

  async function status() {
    const data = await summary();
    view.replaceChildren(
      el("h2", { textContent: "Database status" }),
      el("p", { textContent: `Last committed write: ${data.lastWriteAt ? new Date(data.lastWriteAt).toLocaleString() : "No writes yet"}` }),
      table(["Action", "Committed writes"], Object.entries(data.kinds).map(([kind, count]) => el("tr", {}, el("td", {}, mono(kind)), el("td", { textContent: String(count) })))),
      el("p", { className: "muted", textContent: "Signed actions are offchain database writes. The SQL explorer is read-only." }),
    );
  }
  function sql() {
    view.replaceChildren();
    window.LedgerSql.mount(view, { base: API, examples: SQL_EXAMPLES, title: "Media Feed Database SQL" });
  }

  async function route() {
    const [name] = location.hash.replace(/^#\/?/, "").split("/");
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.route === (name === "sql" ? "sql" : "status"))));
    try {
      if (name === "sql") { await summary(); sql(); }
      else await status();
    } catch (error) {
      view.replaceChildren(el("p", { className: "muted", textContent: error.message }));
    }
  }

  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { location.hash = `#/${b.dataset.route}`; }));
  $("searchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const q = $("searchInput").value.trim();
    if (/^0x[0-9a-f]{64}$/.test(q)) location.assign(`/#/post/${q}`);
  });
  window.addEventListener("hashchange", route);
  FeatheralProfile.mount($("walletButton"), { primaryCurrency: "fthDollar", walletUrl: FeatheralSites.url("dollar", "/wallet/") });
  route();
})();
