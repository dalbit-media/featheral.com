"use strict";
const { goldEntries, reserveActivity } = require("../gold/reserve");

function activityRow(ledger, tx, hash) {
  if (!["CREDIT", "RESERVE", "SETTLE", "RELEASE", "TRANSFER", "GAME", "GOLD"].includes(tx.k)) return null;
  const entries = tx.k === "GAME" ? tx.d.entries : tx.k === "GOLD" ? goldEntries(ledger, tx.d) : [];
  if (tx.k === "GOLD" && !entries.length) return null;
  let credits = 0n, debits = 0n;
  for (const entry of entries) {
    const delta = BigInt(entry.delta);
    if (delta > 0n) credits += delta; else debits -= delta;
  }
  if (tx.k === "CREDIT" || tx.k === "TRANSFER") credits = BigInt(tx.v);
  if (tx.k === "SETTLE" || tx.k === "TRANSFER") debits = BigInt(tx.v);
  const source = tx.k === "GOLD" ? "gold" : tx.k === "GAME" ? tx.i.startsWith("exchange:") ? "exchange" : "world"
    : tx.k === "CREDIT" || ["RESERVE", "SETTLE", "RELEASE"].includes(tx.k) ? "gold"
    : tx.d.m?.startsWith("exchange:") ? "exchange" : tx.d.m?.startsWith("world:") ? "world" : "wallet";
  return { id: `d:${hash}`, at: tx.t, symbol: "FTH$", source, kind: tx.k === "GOLD" ? tx.d.op : tx.k === "CREDIT" ? tx.d.src : tx.k,
    amount: (entries.length ? credits > debits ? credits : debits : BigInt(tx.v)).toString(),
    credits: credits.toString(), debits: debits.toString(), recordType: "transaction" };
}
function activityRows(ledger, tx, hash) {
  const dollar = activityRow(ledger, tx, hash), rows = dollar ? [dollar] : [];
  const gold = tx.k === "GOLD" ? reserveActivity(tx.d) : null;
  if (gold && BigInt(gold.fthg) > 0n) rows.push({ id: `d:${hash}:FTHG`, at: tx.t, symbol: "FTHG", source: "gold",
    kind: tx.d.op, amount: gold.fthg, credits: gold.incoming ? gold.fthg : "0",
    debits: gold.incoming ? "0" : gold.fthg, recordType: gold.recordType });
  return rows;
}
module.exports = { activityRows };
