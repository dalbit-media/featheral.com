"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { paymentRequest, requestParams } = require("../request");
const { createPayApi } = require("../server");
const { walletUi } = require("../../wallet/ui");
const QRCode = require("qrcode");
const address = "0x" + "12".repeat(20);
const account = "0x" + "00".repeat(12) + "12".repeat(20);

test("FTH$ requests normalize public wallet IDs and preserve exact 18-decimal amounts", () => {
  const result = paymentRequest({ to: address, amount: "12.500000000000000001", name: "  Shop  ", currency: "FTH$" });
  assert.equal(result.to, account);
  assert.equal(result.baseUnits, "12500000000000000001");
  assert.equal(result.name, "Shop");
  assert.equal(paymentRequest({ to: account, amount: "1.2300" }).amount, "1.23");
  assert.equal(paymentRequest({ to: address, amount: "0.000000000000000001" }).baseUnits, "1");
  assert.equal(paymentRequest({ to: address }).baseUnits, null);
});

test("requests reject invalid recipients, currencies, fields, duplicates and out-of-range amounts", () => {
  for (const to of ["secret", "0x" + "0".repeat(40), "0x" + "0".repeat(64), null, 123])
    assert.throws(() => paymentRequest({ to }), { status: 400 });
  for (const amount of [0, null, "-1", "0", "0.00", "1e2", ".1", "01", " 1", "1.0000000000000000001", "9".repeat(61)])
    assert.throws(() => paymentRequest({ to: address, amount }), { status: 400 });
  for (const input of [{ to: address, currency: "USD" }, { to: address, name: "x\nx" },
    { to: address, name: "x".repeat(61) }, { to: address, privateKey: "no" }, null, []])
    assert.throws(() => paymentRequest(input), { status: 400 });
  assert.throws(() => requestParams(new URLSearchParams(`to=${address}&to=${address}`)), /Duplicate/);
  assert.throws(() => requestParams(new URLSearchParams(`to=${address}&__proto__=x`)), /Unsupported/);
});

test("Wallet configuration prefills only validated FTH$ requests and keeps approval required", () => {
  const config = walletUi(new URLSearchParams({ to: address, amount: "0.000000000000000001", name: "Shop", view: "assets" }));
  assert.equal(config.view, "send"); assert.equal(config.primary, "FTH$");
  assert.equal(config.payment.to, account);
  assert.equal(config.payment.baseUnits, "1");
  assert.equal(config.signing, "wallet-provider");
  assert.throws(() => walletUi(new URLSearchParams({ to: address, primary: "FTHG" })), /FTH/);
  assert.throws(() => walletUi(new URLSearchParams(`to=${address}&amount=1&amount=2`)), /Duplicate/);
  assert.throws(() => walletUi(new URLSearchParams({ to: "invalid" })), /Recipient/);
});

test("HTTP API returns portable links and real QR SVG without creating payments", async t => {
  const siteUrl = (_, site, pathname) => `https://${site}.featheral.com${pathname}`;
  const api = createPayApi({ siteUrl });
  const server = http.createServer(async (req, res) => {
    if (!await api.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const body = { to: address, amount: "12.50", name: 'Shop <&"雪>' };
  const response = await fetch(origin + "/api/v1/pay/requests", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.equal(result.schema, "featheral.pay"); assert.equal(result.currency, "FTH$");
  assert.equal(result.amount, "12.5"); assert.equal(result.verifiedRecipient, false);
  assert.equal(result.baseUnits, "12500000000000000000");
  assert.equal(result.nfc.data, result.paymentUrl); assert.equal(result.nfc.recordType, "url");
  for (const url of [result.paymentUrl, result.payers.wallet, result.payers.dollar]) {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("to"), account);
    assert.equal(parsed.searchParams.get("amount"), "12.5");
    assert.equal(parsed.searchParams.get("name"), body.name);
  }
  assert.equal(walletUi(new URL(result.payers.wallet).searchParams).payment.to, account);
  const qr = await fetch(origin + new URL(result.qrUrl).pathname + new URL(result.qrUrl).search);
  assert.equal(qr.headers.get("content-type"), "image/svg+xml");
  assert.equal(await qr.text(), await QRCode.toString(result.paymentUrl, { type: "svg", errorCorrectionLevel: "M", margin: 4, width: 320 }));
  const reusable = await (await fetch(origin + `/api/v1/pay/requests?to=${address}`)).json();
  assert.equal(reusable.amount, ""); assert.equal(reusable.baseUnits, null);
  assert.equal(new URL(reusable.paymentUrl).searchParams.has("amount"), false);
  for (const [path, options, status] of [
    ["/api/v1/pay/requests?to=bad", {}, 400],
    ["/api/v1/pay/requests", { method: "DELETE" }, 405],
    ["/api/v1/pay/qr", { method: "POST" }, 405],
    ["/api/v1/pay/unknown", {}, 404],
    ["/api/v1/pay/requests", { method: "POST", body: "{}" }, 415],
    ["/api/v1/pay/requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }, 400],
    ["/api/v1/pay/requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: address, name: "x".repeat(2100) }) }, 413],
    [`/api/v1/pay/requests?to=${address}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, 400],
  ]) {
    const invalid = await fetch(origin + path, options);
    assert.equal(invalid.status, status);
    assert.equal(typeof (await invalid.json()).error, "string");
  }
});
