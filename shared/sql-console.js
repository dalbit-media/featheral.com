"use strict";

// Read-only SQL console shared by the FTH$ explorer, the World ledger explorer and the admin consoles.
// Each ledger keeps a derived SQLite index; the server accepts a single SELECT and runs it query-only.
(() => {
  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
    return node;
  }

  async function getJson(url, init) {
    const response = await fetch(url, { cache: "no-store", ...init });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }

  const cell = (value) => (value === null || value === undefined ? el("td", { className: "muted", textContent: "NULL" }) : el("td", { textContent: String(value), title: String(value) }));

  function toCsv(result) {
    const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    return [result.columns.map(quote).join(","), ...result.rows.map((row) => row.map(quote).join(","))].join("\n");
  }

  // base: "/api/v1/fth" or "/api/v1/world". examples: [{ title, sql }].
  function mount(container, { base, examples = [], title = "SQL console" }) {
    const textarea = el("textarea", { className: "sql-input", rows: 5, spellcheck: false, "aria-label": "SQL query" });
    const status = el("p", { className: "muted fine", textContent: "Read-only. One SELECT statement; results are capped at 500 rows." });
    const output = el("div", { className: "sql-output" });
    const schemaBox = el("div", { className: "sql-schema" });
    let lastResult = null;

    async function run() {
      const query = textarea.value.trim();
      if (!query) return;
      status.textContent = "Running…";
      status.className = "muted fine";
      try {
        const result = await getJson(`${base}/sql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
        lastResult = result;
        const head = el("tr", {}, ...result.columns.map((name) => el("th", { textContent: name })));
        const rows = result.rows.map((row) => el("tr", {}, ...row.map(cell)));
        output.replaceChildren(el("div", { className: "table-wrap" }, el("table", {}, el("thead", {}, head), el("tbody", {}, ...rows))));
        status.textContent = `${result.rowCount.toLocaleString("en-US")} row${result.rowCount === 1 ? "" : "s"}${result.truncated ? " (truncated)" : ""} in ${result.elapsedMs.toFixed(1)} ms`;
        csv.disabled = false;
      } catch (error) {
        output.replaceChildren();
        status.textContent = error.message;
        status.className = "sql-error fine";
      }
    }

    const runButton = el("button", { type: "button", className: "btn primary", textContent: "Run query", onclick: run });
    const csv = el("button", {
      type: "button", className: "btn", textContent: "Download CSV", disabled: true,
      onclick: () => {
        if (!lastResult) return;
        const url = URL.createObjectURL(new Blob([toCsv(lastResult)], { type: "text/csv" }));
        const link = el("a", { href: url, download: "ledger-query.csv" });
        link.click();
        URL.revokeObjectURL(url);
      },
    });
    textarea.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") run();
    });

    const exampleRow = el("div", { className: "sql-examples" }, ...examples.map((example) => el("button", {
      type: "button", className: "btn small", textContent: example.title,
      onclick: () => { textarea.value = example.sql; run(); },
    })));
    if (examples[0]) textarea.value = examples[0].sql;

    container.replaceChildren(
      el("div", { className: "section-head" }, el("h2", { textContent: title }), el("p", { className: "muted fine", textContent: "Ctrl+Enter runs the query" })),
      exampleRow, textarea, el("div", { className: "row sql-actions" }, runButton, csv), status, output,
      el("h3", { textContent: "Schema" }), schemaBox,
    );

    getJson(`${base}/sql/schema`).then(({ tables }) => {
      schemaBox.replaceChildren(...tables.map((table) => el("details", { className: "sql-table" },
        el("summary", {}, el("b", { textContent: table.name }), el("span", { className: "muted", textContent: ` · ${table.rows.toLocaleString("en-US")} rows` })),
        table.comment ? el("p", { className: "muted fine", textContent: table.comment }) : null,
        el("p", {}, ...table.columns.flatMap((column) => [el("code", { textContent: `${column.name}${column.primaryKey ? " 🔑" : ""} ${column.type}` }), " · "])),
        el("button", { type: "button", className: "btn small", textContent: "SELECT *", onclick: () => { textarea.value = `SELECT * FROM ${table.name} ORDER BY 1 DESC LIMIT 25`; run(); } }),
      )));
    }).catch((error) => { schemaBox.textContent = error.message; });
    if (examples[0]) run();
  }

  window.LedgerSql = { mount };
})();
