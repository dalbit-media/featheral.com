"use strict";

(() => {
  const F = window.FTH;
  const { el, api, fth, usd, count, short, timeAgo, stat, emptyRow, kindBadge, txLink, blockLink, accountLink, ethTxLink } = F;
  const $ = (id) => document.getElementById(id);
  const view = $("view");
  const PAGE = 25;
  let renderId = 0;

  FeatheralProfile.mount($("walletButton"), { primaryCurrency: "fthDollar", walletUrl: "/wallet/" });

  const go = (route) => { window.location.hash = `#/${route}`; };
  const table = (headers, rows, empty) => el("div", { className: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, ...headers.map(([label, cls]) => el("th", { className: cls || "", textContent: label })))),
    el("tbody", {}, ...(rows.length ? rows : [emptyRow(headers.length, empty)])),
  ));
  const kv = (pairs) => el("dl", { className: "kv" }, ...pairs.filter(Boolean).flatMap(([key, value]) => [el("dt", { textContent: key }), el("dd", {}, value)]));
  const code = (text) => el("code", { textContent: text });
  const copyable = (text) => el("span", { className: "row" }, code(text), el("button", { type: "button", className: "btn small", textContent: "Copy", onclick: (event) => F.copy(text, event.currentTarget) }));
  const timeCell = (iso, pending) => el("td", { className: "muted", textContent: pending ? "pending" : timeAgo(iso), title: iso || "" });

  function txRow(tx, perspective) {
    const signed = perspective ? F.signedAmount(tx, perspective) : null;
    return el("tr", {},
      el("td", {}, txLink(tx.hash)),
      el("td", {}, kindBadge(tx.kind)),
      el("td", {}, blockLink(tx.height)),
      el("td", {}, tx.from ? accountLink(tx.from, tx.fromWallet) : el("span", { className: "muted", textContent: tx.kind === "CREDIT" ? "Bridge" : "—" })),
      el("td", {}, tx.to ? accountLink(tx.to, tx.toWallet) : el("span", { className: "muted", textContent: tx.kind === "SETTLE" ? "FTHG on Ethereum" : "—" })),
      el("td", { className: `num ${signed?.className || ""}`, textContent: signed ? signed.text : tx.kind === "PROFILE" || tx.kind === "GENESIS" ? "—" : fth(tx.amount) }),
      timeCell(tx.time, tx.status === "pending"),
    );
  }
  const TX_HEADERS = [["Hash"], ["Type"], ["Block"], ["From"], ["To"], ["Amount", "num"], ["Age"]];

  function selectTab(name) {
    document.querySelectorAll(".tabs button").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.route === name)));
  }

  async function loadSummary() {
    try {
      const { ledger: s } = await api("/fth/stats?blocks=1&transactions=1&holders=1");
      $("summaryStats").replaceChildren(
        stat("Block height", `#${count(s.height)}`, s.tipTime ? `Last block ${timeAgo(s.tipTime)}` : "No blocks yet"),
        stat("Supply", fth(s.supply, 0), `${usd(s.supply)} est.`),
        stat("Holders", count(s.holders), `${count(s.accounts)} accounts`),
        stat("Transactions", count(s.transactions), `${count(s.transfers)} transfers · ${count(s.pendingTransactions)} pending`),
      );
    } catch (error) {
      $("summaryStats").replaceChildren(stat("Ledger", "Unavailable", error.message));
    }
  }

  async function showBlocks(before) {
    selectTab("blocks");
    const data = await api(`/fth/blocks?limit=${PAGE}${before ? `&before=${before}` : ""}`);
    const rows = data.blocks.map((block) => el("tr", {},
      el("td", {}, blockLink(block.height)),
      el("td", { className: "hash", textContent: short(block.hash, 12, 8), title: block.hash }),
      el("td", { className: "num", textContent: count(block.transactions) }),
      el("td", { className: "muted", textContent: block.file }),
      el("td", { textContent: block.signed ? "✓" : "—", title: block.signed ? "Writer-signed" : "Unsigned" }),
      timeCell(block.time),
    ));
    const last = data.blocks[data.blocks.length - 1];
    const first = data.blocks[0];
    const pager = el("div", { className: "pager", style: "margin-top:0" },
      el("button", { type: "button", className: "btn small", textContent: "← Newer", disabled: !before || first?.height >= data.height, onclick: () => go(first && first.height + PAGE < data.height ? `blocks/before/${first.height + PAGE + 1}` : "blocks") }),
      el("span", { className: "muted", textContent: data.blocks.length ? `Blocks #${count(last.height)} – #${count(first.height)} of #${count(data.height)}` : "" }),
      el("button", { type: "button", className: "btn small", textContent: "Older →", disabled: !last || last.height === 0, onclick: () => go(`blocks/before/${last.height}`) }),
    );
    return [table([["Block"], ["Hash"], ["Txs", "num"], ["File"], ["Signed"], ["Age"]], rows, "No blocks yet."), pager];
  }

  async function showTransactions() {
    selectTab("transactions");
    const data = await api("/fth/transactions?limit=100");
    return [table(TX_HEADERS, data.transactions.map((tx) => txRow(tx)), "No transactions yet."), el("p", { className: "muted fine", textContent: "Showing the latest 100 transactions, newest first. Pending transactions are applied to balances immediately and sealed in the next block." })];
  }

  async function showRichList() {
    selectTab("rich-list");
    const data = await api("/fth/rich-list?limit=200");
    const rows = data.holders.map((holder) => el("tr", {},
      el("td", { textContent: String(holder.rank) }),
      el("td", {}, accountLink(holder.accountId, holder.wallet, holder.wallet || short(holder.accountId, 12, 8))),
      el("td", { className: "num", textContent: fth(holder.balance) }),
      el("td", { className: "num muted", textContent: holder.reserved !== "0" ? fth(holder.reserved) : "—" }),
      el("td", { className: "num", textContent: usd(holder.balance) }),
      el("td", { className: "num", textContent: `${(holder.shareBps / 100).toFixed(2)}%` }),
    ));
    return [el("p", { className: "muted", textContent: `Total supply ${fth(data.supply)} · top ${count(data.holders.length)} holders` }), table([["#"], ["Account"], ["Balance", "num"], ["Reserved", "num"], ["USD est.", "num"], ["Share", "num"]], rows, "No holders yet.")];
  }

  async function showFiles() {
    selectTab("files");
    const data = await api("/fth/files");
    const rows = [...data.files].reverse().map((file) => el("tr", {},
      el("td", {}, el("a", { href: `/api/v1/fth/files/${file.file}`, target: "_blank", rel: "noopener", textContent: file.file })),
      el("td", { className: "num", textContent: file.firstHeight === null ? "—" : `#${count(file.firstHeight)} – #${count(file.lastHeight)}` }),
      el("td", { className: "num", textContent: count(file.blocks) }),
      el("td", { className: "num", textContent: count(file.transactions) }),
      el("td", { className: "num", textContent: file.bytes < 1048576 ? `${(file.bytes / 1024).toFixed(1)} KB` : `${(file.bytes / 1048576).toFixed(2)} MB` }),
      el("td", { className: "hash", textContent: short(file.sha256, 10, 6), title: `sha256 ${file.sha256}` }),
    ));
    return [
      el("div", { className: "panel" }, el("h3", { textContent: "Distribution" }), kv([
        ["Layout", code(data.layout || "YYYY/YYYY-MM-DD.jsonl")],
        ["Tip", el("span", {}, `#${count(data.height)} · `, code(data.tipHash))],
        ["Sync API", code("GET /api/v1/fth/sync?from=<height>&limit=<n>")],
        ["Writer key", data.writerPublicKey ? el("pre", { className: "hash", style: "margin:0;white-space:pre-wrap", textContent: data.writerPublicKey }) : el("span", { className: "muted", textContent: "Block signing is not configured on this node." })],
      ])),
      table([["File"], ["Blocks", "num"], ["Count", "num"], ["Txs", "num"], ["Size", "num"], ["SHA-256"]], rows, "No ledger files yet."),
    ];
  }

  async function showBlock(height) {
    selectTab("");
    const block = await api(`/fth/blocks/${height}`);
    const nav = el("div", { className: "row" },
      el("button", { type: "button", className: "btn small", textContent: "← Previous", disabled: block.height === 0, onclick: () => go(`block/${block.height - 1}`) }),
      el("button", { type: "button", className: "btn small", textContent: "Next →", onclick: () => go(`block/${block.height + 1}`) }),
    );
    return [
      el("div", { className: "panel" }, el("div", { className: "section-head" }, el("h3", { textContent: `Block #${count(block.height)}` }), nav), kv([
        ["Hash", copyable(block.hash)],
        ["Previous hash", block.height > 0 ? el("a", { className: "hash", href: F.explorerUrl(`block/${block.height - 1}`), textContent: block.previousHash }) : code(block.previousHash)],
        ["Time", `${new Date(block.time).toLocaleString()} (${timeAgo(block.time)})`],
        ["Transactions", count(block.transactions.length)],
        ["Writer signature", block.signed ? "Signed (Ed25519)" : "Unsigned"],
        ["Stored in", el("a", { href: `/api/v1/fth/files/${block.file}`, target: "_blank", rel: "noopener", textContent: block.file })],
      ])),
      table(TX_HEADERS, block.transactions.map((tx) => txRow(tx)), "Empty block."),
    ];
  }

  async function showTx(hash) {
    selectTab("");
    const tx = await api(`/fth/tx/${hash}`);
    return [el("div", { className: "panel" }, el("div", { className: "section-head" }, el("h3", { textContent: F.KIND_LABELS[tx.kind] || tx.kind }), kindBadge(tx.kind)), kv([
      ["Transaction hash", copyable(tx.hash)],
      ["Status", tx.status === "pending" ? el("span", { className: "kind RESERVE", textContent: "Pending — sealed in the next block" }) : el("span", { className: "pos", textContent: "Sealed" })],
      ["Block", el("span", {}, blockLink(tx.height), tx.index !== null ? ` · position ${tx.index}` : "")],
      tx.blockHash && ["Block hash", code(tx.blockHash)],
      ["Time", `${new Date(tx.time).toLocaleString()} (${timeAgo(tx.time)})`],
      tx.from && ["From", accountLink(tx.from, tx.fromWallet, tx.fromWallet || tx.from)],
      tx.to && ["To", accountLink(tx.to, tx.toWallet, tx.toWallet || tx.to)],
      tx.kind !== "PROFILE" && tx.kind !== "GENESIS" && ["Amount", `${fth(tx.amount, 18)} (${usd(tx.amount)} est.)`],
      tx.nonce && ["Nonce", String(tx.nonce)],
      tx.memo && ["Memo", tx.memo],
      tx.source && ["Bridge event", tx.source],
      tx.ethTx && ["Ethereum transaction", ethTxLink(tx.ethTx)],
      tx.redemptionId && ["Redemption id", code(tx.redemptionId)],
      tx.recipient && ["FTHG recipient", el("a", { href: `https://etherscan.io/address/${tx.recipient}`, target: "_blank", rel: "noopener noreferrer", textContent: `${tx.recipient} ↗` })],
      tx.username && ["Username", `@${tx.username}`],
      tx.data && ["Genesis data", el("pre", { className: "hash", style: "margin:0;white-space:pre-wrap", textContent: JSON.stringify(tx.data, null, 2) })],
      ["Ledger id", code(tx.id)],
    ]))];
  }

  async function showAccount(input) {
    selectTab("");
    const data = await api(`/fth/accounts/${input}?limit=200`);
    const balance = data.fthDollar;
    const title = data.profile?.username ? `@${data.profile.username}` : data.wallet ? short(data.wallet) : "Game account";
    return [
      el("div", { className: "panel" },
        el("div", { className: "balance-hero" },
          el("div", {}, el("span", { className: "muted", textContent: title }), el("div", { className: "big", textContent: fth(balance.balance) }), el("div", { className: "muted", textContent: `${usd(balance.balance)} est.` })),
          data.profile?.avatar ? el("img", { src: data.profile.avatar, alt: "", width: 64, height: 64, style: "border-radius:50%" }) : null,
        ),
        el("div", { style: "margin-top:16px" }, kv([
          data.wallet && ["Wallet", el("span", { className: "row" }, code(data.wallet), el("a", { href: `https://etherscan.io/address/${data.wallet}`, target: "_blank", rel: "noopener noreferrer", textContent: "Etherscan ↗" }))],
          ["FTH$ account id", copyable(data.accountId)],
          ["Available", fth(balance.available)],
          ["Reserved", fth(balance.reserved)],
          ["Transfers sent (nonce)", count(data.nonce)],
        ])),
      ),
      el("h3", { textContent: "History" }),
      table(TX_HEADERS, data.history.map((tx) => txRow(tx, data.accountId)), "No FTH$ activity for this account yet."),
    ];
  }

  async function showSearch(query) {
    selectTab("");
    $("searchInput").value = query;
    try {
      const result = await api(`/fth/search?q=${encodeURIComponent(query)}`);
      if (result.type === "block") go(`block/${result.height}`);
      else if (result.type === "tx") go(`tx/${result.hash}`);
      else go(`account/${result.accountId.startsWith("0x000000000000000000000000") ? `0x${result.accountId.slice(26)}` : result.accountId}`);
      return null;
    } catch (error) {
      return [el("div", { className: "notice", textContent: `No match for “${query}”. ${error.status === 404 ? "Try a block height, a 0x… transaction hash, a wallet address, a 32-byte account id, or a registered @username." : error.message}` })];
    }
  }

  const SQL_EXAMPLES = [
    { title: "Latest transactions", sql: "SELECT height, kind, wallet, counterparty_wallet, amount_fth, time\nFROM transactions\nWHERE kind <> 'GENESIS'\nORDER BY time_ms DESC\nLIMIT 25" },
    { title: "Top holders", sql: "SELECT wallet, balance_fth, reserved_fth, nonce\nFROM accounts\nWHERE balance_fth > 0\nORDER BY balance_fth DESC\nLIMIT 25" },
    { title: "Volume by day", sql: "SELECT substr(time, 1, 10) AS day, count(*) AS transfers, round(sum(amount_fth), 2) AS fth\nFROM transactions\nWHERE kind = 'TRANSFER'\nGROUP BY day\nORDER BY day DESC\nLIMIT 30" },
    { title: "Kinds", sql: "SELECT kind, count(*) AS count, round(sum(amount_fth), 2) AS fth\nFROM transactions\nGROUP BY kind\nORDER BY count DESC" },
    { title: "Usernames", sql: "SELECT username, address, issued_at FROM profiles ORDER BY issued_at DESC LIMIT 50" },
    { title: "Withdrawals", sql: "SELECT redemption_id, status, amount_fth, recipient, eth_tx FROM redemptions ORDER BY expires_at DESC LIMIT 50" },
  ];

  function showSql() {
    selectTab("sql");
    const host = el("div");
    window.LedgerSql.mount(host, { base: "/api/v1/fth", title: "Query the FTH$ ledger database", examples: SQL_EXAMPLES });
    return [host];
  }

  async function route() {
    const id = ++renderId;
    const parts = window.location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
    const [name, arg, extra] = parts;
    let content;
    try {
      if (name === "block" && /^\d+$/.test(arg)) content = await showBlock(arg);
      else if (name === "tx" && /^0x[0-9a-fA-F]{64}$/.test(arg)) content = await showTx(arg);
      else if (name === "account" && (F.isAddress(arg) || F.isAccountId(arg))) content = await showAccount(arg);
      else if (name === "search" && arg) content = await showSearch(arg);
      else if (name === "transactions") content = await showTransactions();
      else if (name === "rich-list") content = await showRichList();
      else if (name === "files") content = await showFiles();
      else if (name === "sql") content = showSql();
      else content = await showBlocks(name === "blocks" && arg === "before" && /^\d+$/.test(extra) ? extra : null);
    } catch (error) {
      content = [el("div", { className: "notice", textContent: error.status === 404 ? `Not found: ${error.message}` : `Could not load from the FTH$ ledger: ${error.message}` })];
    }
    if (id !== renderId || content === null) return;
    view.replaceChildren(...content);
  }

  document.querySelectorAll(".tabs button").forEach((button) => button.addEventListener("click", () => go(button.dataset.route)));
  $("searchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const q = $("searchInput").value.trim();
    if (q) go(`search/${encodeURIComponent(q)}`);
  });
  window.addEventListener("hashchange", () => { route(); window.scrollTo({ top: 0 }); });
  loadSummary();
  route();
  F.loadRate().then(() => { loadSummary(); route(); });
})();
