"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; return el; };
  let catalog, me, checkout, pending = false;
  const status = error => { console.error("Silver storefront:", error); $("status").textContent = error.message; };
  async function api(path, body) {
    const response = await fetch("/api/silver" + path, { cache: "no-store", ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || `Silver API HTTP ${response.status}`), { status: response.status });
    return data;
  }
  function tab(name) {
    for (const button of document.querySelectorAll("[data-tab]")) {
      const active = name === button.dataset.tab; button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1;
      $(button.dataset.tab).hidden = !active;
    }
    if (name === "orders") loadMe().catch(status);
  }
  const tabs = [...document.querySelectorAll("[data-tab]")];
  for (const [index, button] of tabs.entries()) {
    button.addEventListener("click", () => tab(button.dataset.tab));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus(); tab(tabs[next].dataset.tab);
    });
  }
  async function connect() {
    if (!window.FeatheralWallet?.authenticate) throw new Error("Wallet is still loading. Retry shortly.");
    const signed = await window.FeatheralWallet.authenticate(address => api("/challenge", { address }));
    await api("/login", signed); document.getElementById("featheral-central-wallet")?.close();
    await loadMe(); return me;
  }
  async function loadMe() {
    try { me = await api("/me"); }
    catch (error) { if (error.status !== 401) throw error; me = null; }
    $("connect").textContent = me ? "Change wallet" : "Connect wallet"; $("logout").hidden = !me;
    $("buyer").textContent = me ? `..${me.address.slice(-5)} · ${me.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} FTHS available` : "";
    $("order-list").replaceChildren();
    if (!me) { $("order-list").append(node("p", "Connect your wallet to view private orders and delivered codes.")); return; }
    if (!me.orders.length) $("order-list").append(node("p", "No orders yet."));
    for (const order of me.orders) {
      const card = node("article", null, "order-card"), detail = order.snapshot;
      card.append(node("h3", detail.product.title), node("p", `${detail.total.toLocaleString(undefined, { maximumFractionDigits: 4 })} FTHS · ${order.status}`),
        node("small", `${new Date(order.at).toLocaleString()} · ${order.id}`));
      if (order.status === "paid") card.append(node("p", "Payment received. Your code is reserved, awaiting administrator delivery."));
      if (order.status === "prepared" && order.expires > Date.now()) {
        const resume = node("button", "Resume checkout"); resume.addEventListener("click", () => showCheckout(order)); card.append(resume);
      } else if (order.status === "prepared") card.append(node("p", "Checkout expired. No payment taken."));
      if (order.status === "delivered") {
        const reveal = node("button", "Reveal code"), delivery = node("div");
        let visible = false;
        reveal.addEventListener("click", async () => {
          if (visible) { delivery.replaceChildren(); reveal.textContent = "Reveal code"; visible = false; return; }
          reveal.disabled = true;
          try {
            const result = await api(`/orders/${order.id}/code`);
            const code = node("textarea"); code.readOnly = true; code.value = result.code; code.setAttribute("aria-label", "Private redemption code");
            const copy = node("button", "Copy code"); copy.addEventListener("click", async () => {
              try { await navigator.clipboard.writeText(code.value); copy.textContent = "Copied"; } catch (error) { status(error); }
            });
            const link = node("a", "Redeem with issuer"); link.href = detail.product.redeemUrl; link.target = "_blank"; link.rel = "noopener noreferrer";
            delivery.replaceChildren(code, copy, link, node("p", detail.product.terms));
            if (result.expires) delivery.append(node("small", `Code expires: ${new Date(result.expires).toLocaleString()}`));
            reveal.textContent = "Hide code"; visible = true;
          } catch (error) { status(error); } finally { reveal.disabled = false; }
        });
        card.append(reveal, delivery);
      }
      $("order-list").append(card);
    }
  }
  function renderCatalog() {
    $("products").replaceChildren();
    const products = catalog.products.filter(product => !$("category").value || product.category === $("category").value);
    if (!products.length) $("products").append(node("p", "No products available in this category yet. Admin publishes verified stock and regional terms before sales open."));
    for (const product of products) {
      const card = node("article", null, "product-card"), logo = node("img"); logo.src = "/shared/logo-silver.svg"; logo.alt = ""; logo.width = logo.height = 48;
      card.append(logo, node("small", product.brand), node("h3", product.title), node("p", product.description),
        node("p", `${product.denomination} · ${product.region}`, "product-region"), node("strong", `${product.price.toLocaleString(undefined, { maximumFractionDigits: 4 })} FTHS`),
        node("small", product.stock ? `${product.stock} available` : "Out of stock"));
      const terms = node("details"); terms.append(node("summary", "Issuer terms"), node("p", product.terms),
        node("small", product.codeExpiresAt ? `Next code expiry: ${new Date(product.codeExpiresAt).toLocaleString()}` : "Expiry not recorded; check issuer terms."));
      card.append(terms);
      const buy = node("button", "View & redeem"); buy.disabled = !product.stock || !catalog.settings.enabled || !catalog.settings.codeStorageReady;
      buy.addEventListener("click", async () => {
        buy.disabled = true;
        try {
          if (!me) await connect();
          const order = await api("/orders", { product: product.id, request: crypto.randomUUID() }); showCheckout(order);
        } catch (error) { status(error); } finally { buy.disabled = !product.stock || !catalog.settings.enabled || !catalog.settings.codeStorageReady; }
      });
      card.append(buy); $("products").append(card);
    }
    $("store-terms").textContent = catalog.settings.terms;
    if (!catalog.settings.enabled) $("status").textContent = "Checkout is not open yet. Products and redemption availability are managed by Admin.";
  }
  function showCheckout(order) {
    checkout = order; const { product, total, treasury, storeTerms } = order.snapshot;
    $("checkout-detail").replaceChildren(node("h3", product.title), node("strong", `${total.toLocaleString(undefined, { maximumFractionDigits: 4 })} FTHS`),
      node("p", `${product.denomination} · ${product.region}`), node("p", product.description),
      node("h4", "Redemption terms"), node("p", product.terms), node("p", `Sourcing: ${product.sourcing}`),
      node("p", product.codeExpiresAt ? `Code expiry: ${new Date(product.codeExpiresAt).toLocaleString()}` : "Code expiry not recorded. Check issuer terms before paying."),
      node("p", storeTerms), node("small", `Receiving wallet: ${treasury}`), node("p", "Approval spends FTHS. Delivery is manual; check My codes after payment."));
    $("accept-terms").checked = false; $("checkout-status").textContent = ""; $("pay").disabled = false;
    if (!$("checkout").open) $("checkout").showModal();
  }
  $("checkout-form").addEventListener("submit", async event => {
    event.preventDefault(); if (pending || !checkout) return;
    pending = true; $("pay").disabled = true;
    const order = checkout;
    try {
      $("checkout-status").textContent = "Approve this FTHS payment in your wallet.";
      const signed = await window.FeatheralWallet.authenticate(address => {
        if (address.toLowerCase() !== order.owner) throw new Error("Selected wallet does not own this order. Change your Silver account before purchasing.");
        return { message: order.message };
      });
      await api(`/orders/${order.id}/pay`, { signature: signed.signature });
      document.getElementById("featheral-central-wallet")?.close(); $("checkout").close(); checkout = null;
      await loadMe(); catalog = await api("/catalog"); renderCatalog(); tab("orders");
      $("status").textContent = "Payment received. Your code is reserved for administrator delivery.";
    } catch (error) { console.error("Silver checkout:", error); $("checkout-status").textContent = `${error.message} Check My codes before starting another checkout.`; }
    finally { pending = false; $("pay").disabled = false; }
  });
  $("close-checkout").addEventListener("click", () => { if (!pending) $("checkout").close(); });
  $("checkout").addEventListener("cancel", event => { if (pending) event.preventDefault(); });
  $("category").addEventListener("change", renderCatalog);
  $("connect").addEventListener("click", () => connect().catch(status));
  $("refresh").addEventListener("click", () => loadMe().catch(status));
  $("logout").addEventListener("click", () => api("/logout", {}).then(loadMe).catch(status));
  $("convert").addEventListener("click", () => {
    if (!window.FeatheralWallet?.open) { status(new Error("Wallet is still loading. Retry shortly.")); return; }
    window.FeatheralWallet.open({ primary: "FTHS", view: "swap", compact: true });
  });
  (async () => {
    try { catalog = await api("/catalog"); renderCatalog(); await loadMe(); } catch (error) { status(error); $("products").textContent = "Products could not be loaded. Reload to retry."; }
    try {
      const response = await fetch("/api/intranet/silver", { cache: "no-store" }), data = await response.json();
      if (!response.ok) throw new Error(data.error || "Exchange status unavailable.");
      if (!data.market?.funded) { $("convert").disabled = true; $("conversion-status").textContent = "FTHS Exchange liquidity is not funded yet. Conversion is unavailable; no fixed-rate conversion is promised."; }
    } catch (error) { status(error); $("convert").disabled = true; $("conversion-status").textContent = "Conversion status unavailable. Retry later."; }
  })();
})();
