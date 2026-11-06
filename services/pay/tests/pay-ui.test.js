"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { requestParams, paymentParams } = require("../request");
const directory = path.resolve(__dirname, "../../../sites/pay.featheral.com");
const source = fs.readFileSync(path.join(directory, "pay.js"), "utf8");
const html = fs.readFileSync(path.join(directory, "index.html"), "utf8");
const address = "0x" + "22".repeat(20);

function fixture({ qrFailure = false, apiFailure = false, nfc = false, search = "" } = {}) {
  const nodes = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) =>
    [id, { value: "", hidden: false, disabled: false, dataset: {}, listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
      removeAttribute(name) { delete this[name]; }, scrollIntoView() {},
      fire(name) { return this.listeners[name]?.({ preventDefault() {} }); } }]));
  const requests = [], writes = [], errors = [], clipboard = [], history = [];
  let prints = 0;
  const context = {
    URL, URLSearchParams, AbortSignal, location: { search },
    document: { getElementById: id => nodes[id] },
    navigator: { clipboard: { writeText: async value => clipboard.push(value) } },
    console: { error: (...args) => errors.push(args) },
    history: { replaceState: (_, __, value) => history.push(value) },
    window: { isSecureContext: true, print: () => { prints++; } },
    Image: class { set src(value) { queueMicrotask(() => qrFailure ? this.onerror() : this.onload()); } },
    fetch: async url => {
      requests.push(url);
      if (apiFailure) return { ok: false, json: async () => ({ error: "Payment API unavailable." }) };
      try {
        const request = requestParams(new URL(url, "https://pay.featheral.com").searchParams);
        const query = paymentParams(request).toString();
        const paymentUrl = "https://pay.featheral.com/?" + query;
        return { ok: true, json: async () => ({ ...request, paymentUrl,
          qrUrl: "https://pay.featheral.com/api/v1/pay/qr?" + query,
          payers: { wallet: "https://wallet.featheral.com/?" + query, dollar: "https://dollar.featheral.com/wallet/?" + query },
          nfc: { recordType: "url", data: paymentUrl } }) };
      } catch (error) { return { ok: false, json: async () => ({ error: error.message }) }; }
    },
  };
  if (nfc) context.window.NDEFWriter = class { async write(value) { writes.push(value); } };
  vm.runInNewContext(source, context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { nodes, requests, writes, clipboard, history, errors, prints: () => prints, settle,
    async generate(amount = "12.5", name = "Shop <test>") {
      nodes.to.value = address; nodes.name.value = name; nodes.amount.value = amount;
      nodes["request-form"].fire("submit"); await settle();
    } };
}

test("Pay UI separates fixed payment QR from amount-free printable card and writes the URL record", async () => {
  const ui = fixture({ nfc: true });
  await ui.generate("12.500000000000000001");
  assert.equal(ui.nodes["request-result"].hidden, false);
  assert.equal(ui.nodes["request-amount"].textContent, "12.500000000000000001 FTH$");
  assert.equal(ui.nodes["card-name"].textContent, "Shop <test>");
  assert.equal(new URL(ui.nodes["payment-qr"].src).searchParams.get("amount"), "12.500000000000000001");
  assert.equal(new URL(ui.nodes["card-qr"].src).searchParams.has("amount"), false);
  assert.equal(ui.nodes["print-card"].disabled, false);
  ui.nodes["print-card"].fire("click"); assert.equal(ui.prints(), 1);
  await ui.generate("1", "W".repeat(60));
  assert.equal(ui.nodes["card-name"].dataset.long, "true");
  await ui.nodes["copy-link"].fire("click");
  assert.equal(ui.clipboard[0], ui.nodes["payment-link"].value);
  await ui.nodes["write-nfc"].fire("click");
  assert.equal(ui.writes[0].records[0].recordType, "url");
  assert.equal(ui.writes[0].records[0].data, ui.nodes["payment-link"].value);
  ui.nodes["request-form"].fire("input");
  assert.equal(ui.nodes["request-result"].hidden, true);
  assert.equal(ui.nodes["card-qr"].hidden, true);
  assert.equal(ui.nodes["print-card"].disabled, true);
  ui.nodes["print-card"].fire("click"); assert.equal(ui.prints(), 1);
});

test("Pay UI surfaces unsupported NFC, API failures and missing QR rather than enabling a broken card", async () => {
  const supported = fixture();
  await supported.generate("");
  await supported.nodes["write-nfc"].fire("click");
  assert.match(supported.nodes.status.textContent, /unavailable.*NFC writer app/);
  assert.equal(supported.nodes.status.dataset.error, "true");
  for (const options of [{ qrFailure: true }, { apiFailure: true }]) {
    const ui = fixture(options);
    await ui.generate();
    assert.equal(ui.nodes["request-result"].hidden, true);
    assert.equal(ui.nodes["print-card"].disabled, true);
    assert.equal(ui.nodes.status.dataset.error, "true");
    assert.equal(ui.errors.length, 1);
  }
});

test("Pay UI loads incoming requests without authorizing payments and rejects malformed links", async () => {
  const ui = fixture({ search: `?to=${address}&amount=1.000000000000000001` });
  await ui.settle();
  assert.equal(ui.nodes["request-result"].hidden, false);
  assert.equal(ui.nodes.to.value, address);
  assert.equal(ui.nodes["request-amount"].textContent, "1.000000000000000001 FTH$");
  assert.match(ui.nodes.status.textContent, /Verify the recipient/);
  assert.equal(ui.requests.every(url => url.startsWith("/api/v1/pay/requests?")), true);
  const invalid = fixture({ search: `?to=${address}&amount=1&amount=2` });
  await invalid.settle();
  assert.equal(invalid.nodes["request-result"].hidden, true);
  assert.match(invalid.nodes.status.textContent, /Duplicate/);
});
