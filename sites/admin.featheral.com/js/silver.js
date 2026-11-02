"use strict";
VIEWS.silver = async (_q, token) => {
  renderSidebar("silver"); setCrumbs("<b>Silver / digital marketplace</b>");
  const endpoint = "/api/silver/admin", data = await api(endpoint), settings = data.settings;
  const refresh = () => VIEWS.silver(_q, token);
  setView(`<div class="card"><h2>FTHS digital storefront</h2><p>No physical shipping. Sell issuer-backed gift cards and redemption codes for silver or Featheral collectibles. Only publish products you can lawfully source and fulfill; Japan/Korea availability and redemption regions must be verified per listing. Nothing is universally redeemable by default.</p>
    <p>Code encryption: <b>${settings.codeStorageReady ? "configured" : "not configured"}</b>. Set <code>SILVER_CODE_KEY</code> to a persistent, securely stored 32-byte hex key and restart the gateway before importing codes. Back up this key separately: changing or losing it makes existing inventory unreadable. Codes are never included in catalog, Admin listings or order lists.</p>
    <form id="silver-settings"><label>FTHS receiving wallet<input name="treasury" value="${esc(settings.treasury)}" placeholder="0x…" maxlength="42"></label><label>Store terms<textarea name="terms" maxlength="4000" required>${esc(settings.terms)}</textarea></label><label><input name="enabled" type="checkbox" ${settings.enabled ? "checked" : ""}> Enable checkout (receiving wallet and encryption key required)</label><button class="btn">Save settings</button><p role="status"></p></form></div>
    <div class="card"><div class="row"><h2>Products &amp; digital stock</h2><button class="btn sm" id="silver-new">New product</button></div><div class="table-wrap"><table><thead><tr><th>Product / issuer</th><th>Region / face value</th><th>FTHS</th><th>Available codes</th><th>Published</th><th></th></tr></thead><tbody>${data.products.map(product => `<tr><td>${esc(product.title)}<br><small>${esc(product.brand)}</small></td><td>${esc(product.region)}<br>${esc(product.denomination)}</td><td>${fmtNum(product.price)}</td><td>${product.stock}</td><td>${product.published ? "Yes" : "Draft"}</td><td><button class="btn sm" data-product="${product.id}">Edit</button> <button class="btn sm" data-stock="${product.id}">Import codes</button></td></tr>`).join("")}</tbody></table></div>${data.products.length ? "" : "<p>No products. Create drafts, verify supplier/issuer terms, import valid codes, then publish. No sample stock is sellable.</p>"}</div>
    <div class="card"><h2>Orders &amp; fulfillment</h2><p>Payment reserves one code. Deliver only after reviewing the order. Refunds debit the original receiving wallet and return the exact FTHS amount; refunded codes are quarantined, never automatically resold. Delivered codes cannot be automatically refunded because issuer redemption is external.</p><div class="table-wrap"><table><thead><tr><th>Order</th><th>Buyer / product</th><th>FTHS</th><th>Status</th><th>Action</th></tr></thead><tbody>${data.orders.filter(order => order.status !== "prepared").map(order => `<tr><td><code>${esc(order.id)}</code><br>${fmtDate(new Date(order.at).toISOString())}</td><td><code>${esc(order.owner)}</code><br>${esc(order.snapshot.product.title)}<br><small>${esc(order.snapshot.product.region)}</small></td><td>${fmtNum(order.snapshot.total)}</td><td>${esc(order.status)}</td><td>${order.status === "paid" ? `<button class="btn sm" data-deliver="${order.id}">Deliver code</button> <button class="btn sm" data-refund="${order.id}">Refund FTHS</button>` : ""}</td></tr>`).join("")}</tbody></table></div><p id="silver-order-status" role="status"></p></div>
    <div class="card"><h2>Audit</h2><div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>${data.audit.map(row => `<tr><td>${fmtDate(new Date(row.at).toISOString())}</td><td>${esc(row.actor)}</td><td>${esc(row.action)}</td><td>${esc(row.target)}</td></tr>`).join("")}</tbody></table></div></div>`, token);
  $("#silver-settings").addEventListener("submit", async event => {
    event.preventDefault(); const form = event.target, button = $("button", form); button.disabled = true;
    try {
      await api(`${endpoint}/settings`, { method: "PUT", json: { treasury: form.elements.treasury.value.trim(), terms: form.elements.terms.value, enabled: form.elements.enabled.checked, revision: settings.revision } });
      toast("Silver settings saved"); await refresh();
    } catch (error) { console.error(error); $('[role="status"]', form).textContent = error.message; }
    finally { button.disabled = false; }
  });
  function edit(product) {
    const current = product || { category: "giftcard", published: false }, fields = [
      ["title", "Product name", 120], ["brand", "Issuer / brand", 100], ["description", "Description", 2000],
      ["region", "Redeemable country / account region (be explicit)", 160], ["denomination", "Issuer face value / physical redemption entitlement", 120],
      ["sourcing", "Verified sourcing (Japan, Korea, supplier availability)", 500], ["terms", "Issuer restrictions, fees, validity, fulfillment timing & redemption instructions", 4000],
    ];
    const dialog = modal(product ? "Edit Silver product" : "New digital product", `<form id="silver-product"><label>Category<select name="category">${options([["giftcard","Gift card"],["silver","Silver redemption code"],["collectible","Featheral collectible code"]],current.category)}</select></label>${fields.map(([name,label,max]) => `<label>${label}${max > 160 ? `<textarea name="${name}" maxlength="${max}" required>${esc(current[name] || "")}</textarea>` : `<input name="${name}" value="${esc(current[name] || "")}" maxlength="${max}" required>`}</label>`).join("")}<label>Official issuer redemption URL<input name="redeemUrl" type="url" value="${esc(current.redeemUrl || "")}" placeholder="https://" required></label><label>Price (whole FTHS)<input name="price" type="number" min="1" max="1000000000" step="1" value="${current.price || ""}" required></label><label><input name="published" type="checkbox" ${current.published ? "checked" : ""}> Publish verified listing</label><button class="btn">Save product</button><p role="status"></p></form>`);
    const form = $("#silver-product", dialog);
    form.addEventListener("submit", async event => {
      event.preventDefault(); const button = $("button", form); button.disabled = true;
      try {
        const input = Object.fromEntries(new FormData(form)); input.price = Number(input.price); input.published = form.elements.published.checked; input.revision = current.revision;
        await api(endpoint + "/products" + (product ? `/${product.id}` : ""), { method: product ? "PUT" : "POST", json: input });
        closeModal(); toast("Product saved"); await refresh();
      } catch (error) { console.error(error); $('[role="status"]', form).textContent = error.message; }
      finally { button.disabled = false; }
    });
  }
  $("#silver-new").addEventListener("click", () => edit());
  for (const button of $$("[data-product]")) button.addEventListener("click", () => edit(data.products.find(product => product.id === button.dataset.product)));
  for (const button of $$("[data-stock]")) button.addEventListener("click", async () => {
    const dialog = modal("Import private digital stock", `<form id="silver-stock"><p>One unique redeemable code per line. Codes are encrypted at rest; do not paste them into product descriptions or logs. Duplicate imports fail as a whole.</p><label>Codes<textarea name="codes" required autocomplete="off" spellcheck="false"></textarea></label><label>Issuer expiry (optional; local time)<input name="expiresAt" type="datetime-local"></label><button class="btn" ${settings.codeStorageReady ? "" : "disabled"}>Encrypt &amp; import</button><p role="status"></p></form>`);
    const form = $("#silver-stock", dialog);
    try {
      const { inventory } = await api(`${endpoint}/products/${button.dataset.stock}/stock`);
      const rows = document.createElement("div");
      rows.innerHTML = `<h3>Inventory (no plaintext codes)</h3><div class="table-wrap"><table><thead><tr><th>ID</th><th>State</th><th>Expiry</th><th></th></tr></thead><tbody>${inventory.map(row => `<tr><td><code>${esc(row.id)}</code></td><td>${esc(row.state)}</td><td>${row.expires ? fmtDate(new Date(row.expires).toISOString()) : "No expiry entered"}</td><td>${row.state === "available" ? `<button type="button" class="btn sm" data-retire="${row.id}">Retire</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
      form.append(rows);
      for (const retire of $$("[data-retire]", rows)) retire.addEventListener("click", async () => {
        if (!confirm("Quarantine this code so it cannot be sold?")) return;
        retire.disabled = true;
        try { await api(`${endpoint}/products/${button.dataset.stock}/stock/${retire.dataset.retire}/retire`, { json: {} }); closeModal(); await refresh(); }
        catch (error) { console.error(error); $('[role="status"]', form).textContent = error.message; retire.disabled = false; }
      });
    } catch (error) { console.error(error); $('[role="status"]', form).textContent = error.message; }
    form.addEventListener("submit", async event => {
      event.preventDefault(); const submit = $("button", form); submit.disabled = true;
      try {
        const codes = form.elements.codes.value.split(/\r?\n/).map(code => code.trim()).filter(Boolean), expiresAt = form.elements.expiresAt.value ? new Date(form.elements.expiresAt.value).toISOString() : "";
        await api(`${endpoint}/products/${button.dataset.stock}/stock`, { json: { codes, expiresAt } });
        form.reset(); closeModal(); toast("Encrypted stock imported"); await refresh();
      } catch (error) { console.error(error); $('[role="status"]', form).textContent = error.message; }
      finally { submit.disabled = false; }
    });
  });
  for (const button of $$("[data-deliver],[data-refund]")) button.addEventListener("click", async () => {
    const action = button.dataset.deliver ? "deliver" : "refund", id = button.dataset.deliver || button.dataset.refund;
    if (!confirm(action === "deliver" ? "Release this order's reserved code to its buyer?" : "Refund the exact FTHS payment from the original receiving wallet? The reserved code will be quarantined.")) return;
    button.disabled = true;
    try { await api(`${endpoint}/orders/${id}/${action}`, { json: {} }); toast(action === "deliver" ? "Code delivered" : "FTHS refunded"); await refresh(); }
    catch (error) { console.error(error); $("#silver-order-status").textContent = error.message; button.disabled = false; }
  });
};
