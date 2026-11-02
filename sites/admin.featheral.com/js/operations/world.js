"use strict";

window.FeatheralAdminControllers.world = (root, kit) => {
  const { el, json, stat, gate } = kit;
  const API = "/api/v1/world";
  const $ = (id) => root.querySelector("#" + id);
  let admin = false;
  let account = "";
  let busy = false;

  // Must stay identical to socialMessage() in services/social-ledger/social.js (MOD branch).
  const message = (d) => ["Featheral World social action", "", "Action: MOD", `Author: ${d.w}`, `Moderation: ${d.act}`, `Target: ${d.tg}`, `Nonce: ${d.n}`, `Issued at: ${d.ts}`, "Ledger: Featheral World communication ledger", "", "Signing is free and only authorizes this action on the World ledger."].join("\n");

  async function moderate(act, tg) {
    kit.assertActive();
    if (!admin) throw new Error("Connect a moderator wallet first.");
    if (!confirm(`${act} ${tg}? This signed moderation action will be recorded permanently on the World ledger.`)) return false;
    const w = ethers.getAddress(account);
    const data = { w, by: w, n: Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join(""), ts: new Date().toISOString(), act, tg };
    kit.assertActive();
    data.sig = await FeatheralProfile.getProvider().request({ method: "personal_sign", params: [ethers.hexlify(ethers.toUtf8Bytes(message(data))), w] });
    kit.assertActive();
    await json(`${API}/actions`, { method: "POST", body: JSON.stringify({ kind: "MOD", data }) });
    return true;
  }

  async function run(work) {
    if (busy) return;
    busy = true;
    updateButtons();
    $("moderationStatus").textContent = "Review the action and sign in your wallet...";
    try {
      if (await work()) {
        await load();
        $("moderationStatus").textContent = "Moderation action recorded; state refreshed.";
      } else {
        $("moderationStatus").textContent = "Moderation cancelled; no action submitted.";
      }
    } catch (error) {
      $("moderationStatus").textContent = `Moderation failed: ${error.message || String(error)}`;
    } finally {
      busy = false;
      updateButtons();
    }
  }
  function updateButtons() {
    root.querySelectorAll("#suspended .btn, #posts .btn, #walletForm .btn").forEach((button) => { button.disabled = !admin || busy; });
  }

  const button = (label, handler) => el("button", { type: "button", className: "btn", textContent: label, disabled: !admin || busy, onclick: handler });

  async function load() {
    const [{ ledger }, moderation] = await Promise.all([json(`${API}/stats`), json(`${API}/moderation?limit=25`)]);
    $("stats").replaceChildren(stat("Height", `#${ledger.height}`), stat("Posts", ledger.posts), stat("Authors", ledger.authors), stat("Actions", ledger.transactions), stat("Suspended", moderation.suspended.length), stat("Moderators", moderation.moderators.length));
    $("moderators").replaceChildren(...(moderation.moderators.length ? moderation.moderators.map((wallet) => el("p", {}, el("code", { textContent: wallet }))) : [el("p", { textContent: "No moderator wallets configured. Set WORLD_MODERATORS or FEATHERAL_ADMIN_WALLETS on the service." })]));
    $("suspended").replaceChildren(...(moderation.suspended.length ? moderation.suspended.map((wallet) => el("div", { className: "row" }, el("code", { textContent: wallet }), button("Restore", () => run(() => moderate("RESTORE", wallet))))) : [el("p", { textContent: "No suspended wallets." })]));
    $("posts").replaceChildren(...moderation.posts.map((post) => el("div", { className: "moderation-row" },
      el("div", {}, el("div", { className: "muted fine" }, el("a", { href: window.FeatheralSites.url("world", `/#/user/${post.author}`) }, el("code", { textContent: post.author })), ` · ${new Date(post.timeMs).toLocaleString()}${post.deleted ? " · deleted" : ""}${post.hidden ? " · hidden" : ""}`), el("div", { textContent: post.text, className: "moderation-text" })),
      post.deleted ? null : post.hidden ? button("Unhide", () => run(() => moderate("UNHIDE", post.id))) : button("Hide", () => run(() => moderate("HIDE", post.id))),
      button("Suspend author", () => run(() => moderate("SUSPEND", post.author))))));
    if (!moderation.posts.length) $("posts").textContent = "No posts yet.";
  }

  $("walletForm").addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      const changed = await moderate("SUSPEND", ethers.getAddress($("walletInput").value.trim()));
      if (changed) $("walletInput").value = "";
      return changed;
    });
  });
  gate($("gate"), "world", (ok, acct) => { admin = ok; account = acct; updateButtons(); });
  load().catch((error) => { $("moderationStatus").textContent = `World admin unavailable: ${error.message}`; });
  window.LedgerSql.mount($("sqlHost"), {
    base: API,
    title: "World ledger SQL",
    examples: [
      { title: "Moderation log", sql: "SELECT * FROM moderation ORDER BY time_ms DESC LIMIT 50" },
      { title: "Hidden posts", sql: "SELECT id, author, text FROM posts WHERE hidden=1 LIMIT 50" },
      { title: "Active authors", sql: "SELECT author, count(*) AS posts FROM posts GROUP BY author ORDER BY posts DESC LIMIT 25" },
    ],
  });
};
