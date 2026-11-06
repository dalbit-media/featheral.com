"use strict";
const QRCode = require("qrcode");
const { paymentRequest, requestParams, paymentParams } = require("./request");

function describe(request, siteUrl, req) {
  const params = paymentParams(request);
  const paymentUrl = siteUrl(req, "pay", "/?" + params);
  const payerParams = new URLSearchParams({ primary: "FTH$", view: "send", ...Object.fromEntries(params) });
  return { schema: "featheral.pay", version: 1, ...request, paymentUrl,
    qrUrl: siteUrl(req, "pay", "/api/v1/pay/qr?" + params),
    payers: { wallet: siteUrl(req, "wallet", "/?" + payerParams),
      dollar: siteUrl(req, "dollar", "/wallet/?" + params) },
    nfc: { recordType: "url", data: paymentUrl }, settlement: "online-wallet-authorization",
    verifiedRecipient: false, card: { status: "coming-soon", printable: true } };
}

function createPayApi({ siteUrl }) {
  return { async handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/v1/pay/")) return false;
    const json = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff" });
      res.end(JSON.stringify(body));
    };
    try {
      if (!["/api/v1/pay/requests", "/api/v1/pay/qr"].includes(url.pathname)) {
        json(404, { error: "Unknown payment service endpoint." }); return true;
      }
      const methods = url.pathname.endsWith("/qr") ? ["GET"] : ["GET", "POST"];
      if (!methods.includes(req.method)) {
        res.setHeader("Allow", methods.join(", ")); json(405, { error: "Unsupported payment service method." }); return true;
      }
      let request;
      if (req.method === "POST") {
        if (url.search) throw Object.assign(new Error("Send request fields in the JSON body only."), { status: 400 });
        if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
          json(415, { error: "Use application/json." }); return true;
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 2048) { json(413, { error: "Payment request exceeds 2048 bytes." }); return true; }
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw Object.assign(new Error("Invalid JSON payment request."), { status: 400 }); }
        request = paymentRequest(body);
      } else {
        if (url.search.length > 2048) throw Object.assign(new Error("Payment URL is too long."), { status: 400 });
        request = requestParams(url.searchParams);
      }
      const result = describe(request, siteUrl, req);
      if (url.pathname.endsWith("/qr")) {
        const svg = await QRCode.toString(result.paymentUrl, { type: "svg", errorCorrectionLevel: "M", margin: 4, width: 320 });
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
        res.end(svg);
      } else json(200, result);
    } catch (error) {
      if (error.status === 400) json(400, { error: error.message });
      else { console.error("Payment request failed:", error); json(500, { error: "Payment service unavailable." }); }
    }
    return true;
  } };
}
module.exports = { createPayApi };
