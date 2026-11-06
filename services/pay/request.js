"use strict";
const { normalizeAccount } = require("../fth-ledger/transfer");
const fail = message => Object.assign(new Error(message), { status: 400 });

function paymentRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("A payment request object is required.");
  if (Object.keys(input).some(key => !["to", "amount", "name", "currency"].includes(key))) throw fail("Unsupported payment request field.");
  if (input.currency !== undefined && input.currency !== "FTH$") throw fail("Payments use FTH$ only.");
  const to = normalizeAccount(input.to, "Recipient");
  if (/^0x0{64}$/.test(to)) throw fail("The recipient cannot be the zero account.");
  const name = input.name === undefined ? "" : input.name;
  if (typeof name !== "string" || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) throw fail("Display name must be at most 60 printable characters.");
  let amount = input.amount === undefined ? "" : input.amount;
  if (typeof amount !== "string" || amount.length > 79 || amount && !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(amount))
    throw fail("Amount must be a positive FTH$ decimal string with at most 18 decimal places.");
  let baseUnits = null;
  if (amount) {
    const [whole, fraction = ""] = amount.split(".");
    baseUnits = (BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"))).toString();
    if (baseUnits === "0" || baseUnits.length > 78) throw fail("Amount is outside the supported FTH$ transfer range.");
    amount = `${BigInt(whole)}${fraction.replace(/0+$/, "") ? "." + fraction.replace(/0+$/, "") : ""}`;
  }
  return { to, name: name.trim(), amount, baseUnits, currency: "FTH$" };
}

function requestParams(params) {
  const input = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(input, key)) throw fail("Duplicate payment request fields are not supported.");
    Object.defineProperty(input, key, { value, enumerable: true });
  }
  return paymentRequest(input);
}

function paymentParams(request) {
  const params = new URLSearchParams({ to: request.to, currency: "FTH$" });
  if (request.amount) params.set("amount", request.amount);
  if (request.name) params.set("name", request.name);
  return params;
}

module.exports = { paymentRequest, requestParams, paymentParams };
