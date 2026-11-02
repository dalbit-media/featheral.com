"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const crypto = require("node:crypto");
const express = require("express");
const { Wallet } = require("ethers");
const { Notes } = require("../../notes/ledger");
const { Creation } = require("../../notes/creation");
const { silverApi } = require("../lib/silver-api");
async function fixture(t) {
  const notes = new Notes(":memory:"), creation = new Creation(notes, {}), buyer = Wallet.createRandom(), treasury = Wallet.createRandom();
  const { router, store } = silverApi({ notes, markets: creation.markets, env: { SILVER_CODE_KEY: crypto.randomBytes(32).toString("hex") },
    cmsAuth: (req, res, next) => req.get("authorization") === "Basic fixture" ? next() : res.status(401).json({ error: "Admin authorization required" }) });
  const app = express(); app.use(express.json({ limit: "1mb" })); app.use("/api/silver", router);
  const server = http.createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); notes.close(); });
  async function call(path, body, options = {}) {
    const host = options.host || "silver.localhost", method = options.method || (body === undefined ? "GET" : "POST");
    return new Promise((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port: server.address().port, path: "/api/silver" + path, method,
        headers: { Host: host, Origin: options.origin || `http://${host}`, "Content-Type": "application/json",
          ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.admin ? { Authorization: "Basic fixture" } : {}) } }, response => {
        const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => resolve({
          status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      request.on("error", reject); request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function login(wallet = buyer) {
    const challenge = await call("/challenge", { address: wallet.address });
    const result = await call("/login", { address: wallet.address, signature: await wallet.signMessage(challenge.body.message) });
    assert.equal(result.status, 200);
    return { cookie: result.headers["set-cookie"][0].split(";")[0], wallet, result };
  }
  const admin = { host: "admin.localhost", admin: true };
  const product = (await call("/admin/products", { title: "Test Korea digital card", brand: "Fixture issuer", description: "Test inventory only",
    category: "giftcard", region: "South Korea issuer accounts only", denomination: "KRW 1,000 fixture",
    sourcing: "Test Korean supplier", terms: "Issuer test conditions. Manual code delivery.", redeemUrl: "https://example.com/redeem", price: 37, published: true }, admin)).body;
  assert.equal((await call("/admin/settings", { treasury: treasury.address, enabled: true, terms: "Digital only", revision: 0 }, { ...admin, method: "PUT" })).status, 200);
  assert.equal((await call(`/admin/products/${product.id}/stock`, { codes: ["HTTP-PRIVATE-GIFT-CODE"] }, admin)).status, 200);
  notes.db.prepare("INSERT INTO notes_entries(address,amount,kind,at,site,symbol) VALUES(?,200,'fixture',?,'test','FTHS')").run(buyer.address.toLowerCase(), Date.now());
  return { notes, creation, store, call, login, admin, product, buyer, treasury };
}
test("Silver HTTP catalog is public; Admin management is host/auth protected and mutations enforce same origin", async t => {
  const f = await fixture(t);
  const catalog = await f.call("/catalog");
  assert.equal(catalog.status, 200); assert.equal(catalog.body.products[0].stock, 1);
  assert.equal(JSON.stringify(catalog.body).includes("HTTP-PRIVATE-GIFT-CODE"), false);
  assert.equal(catalog.headers["cache-control"], "no-store");
  assert.equal((await f.call("/catalog", undefined, { host: "app.localhost" })).status, 404);
  assert.equal((await f.call("/admin", undefined, { admin: true })).status, 404);
  assert.equal((await f.call("/admin", undefined, { host: "admin.localhost" })).status, 401);
  assert.equal((await f.call("/admin")).status, 404);
  assert.equal((await f.call("/admin/products", {}, { ...f.admin, origin: "https://evil.example" })).status, 403);
  assert.equal((await f.call("/me")).status, 401);
  assert.equal((await f.call("/orders", { product: f.product.id, request: crypto.randomUUID() })).status, 401);
  assert.equal((await f.call("/catalog", undefined, f.admin)).status, 404);
});
test("Signed FTHS checkout and Admin delivery expose a code only to its authenticated buyer", async t => {
  const f = await fixture(t), buyer = await f.login(), other = await f.login(Wallet.createRandom());
  assert.match(buyer.result.headers["set-cookie"][0], /HttpOnly/); assert.match(buyer.result.headers["set-cookie"][0], /SameSite=Strict/);
  assert.match(buyer.result.headers["set-cookie"][0], /Path=\/api\/silver/);
  assert.equal(buyer.result.body.token, undefined);
  const prepared = await f.call("/orders", { product: f.product.id, request: crypto.randomUUID(), price: 1, treasury: other.wallet.address }, buyer);
  assert.equal(prepared.status, 200); assert.equal(prepared.body.snapshot.total, 37); assert.equal(prepared.body.snapshot.treasury, f.treasury.address.toLowerCase());
  const path = `/orders/${prepared.body.id}`;
  assert.equal((await f.call(path + "/pay", { signature: await other.wallet.signMessage(prepared.body.message) }, buyer)).status, 401);
  assert.equal((await f.call(path + "/pay", { signature: await f.buyer.signMessage(prepared.body.message) }, other)).status, 404);
  const signature = await f.buyer.signMessage(prepared.body.message);
  const paid = await f.call(path + "/pay", { signature }, buyer);
  assert.equal(paid.status, 200); assert.equal(paid.body.status, "paid");
  assert.equal((await f.call(path + "/pay", { signature }, buyer)).body.status, "paid");
  assert.equal((await f.call(path + "/code", undefined, buyer)).status, 409);
  assert.equal((await f.call("/admin" + path + "/deliver", {}, buyer)).status, 404);
  assert.equal((await f.call("/admin" + path + "/deliver", {}, f.admin)).body.status, "delivered");
  assert.equal((await f.call(path + "/code", undefined, other)).status, 404);
  const code = await f.call(path + "/code", undefined, buyer);
  assert.equal(code.body.code, "HTTP-PRIVATE-GIFT-CODE"); assert.equal(code.headers["cache-control"], "no-store");
  assert.equal((await f.call("/me", undefined, buyer)).body.balance, 163);
  assert.equal(JSON.stringify((await f.call("/me", undefined, other)).body).includes(prepared.body.id), false);
  assert.equal(JSON.stringify((await f.call("/admin", undefined, f.admin)).body).includes(code.body.code), false);
  await f.call("/logout", {}, buyer); assert.equal((await f.call(path + "/code", undefined, buyer)).status, 401);
});
